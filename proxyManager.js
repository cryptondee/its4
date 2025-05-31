// proxyManager.js
import { ethers, Wallet, Contract, FetchRequest, FetchResponse } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch'; // For Node.js environment

const MIN_REQUEST_INTERVAL_MS = 100; // Minimum 34ms between requests per proxy (~29.4 TPS) 
const MAX_PROXY_FAILURES = 3;

class ProxyManager {
    constructor(proxyConfigs, rpcUrl, contractAddress, contractAbi = [], confirmations = 1) {
        this.rpcUrl = rpcUrl;
        this.contractAddress = contractAddress;
        this.contractAbi = contractAbi;
        this.confirmations = confirmations; // Number of confirmations to wait for
        this.proxies = proxyConfigs.map((config, index) => ({
            id: `Proxy${index + 1}`,
            config: config,
            url: config.url, // Ensuring this matches the structure from mint.js
            agent: new HttpsProxyAgent(config.url), // Create and store agent here
            requestQueue: [], // Standardized to requestQueue
            isProcessing: false,
            failureCount: 0,
            isHealthy: true,
            lastRequestTime: 0
        }));
        this.currentProxyIndex = 0;
        this.log(`ProxyManager initialized with ${this.proxies.length} proxies. Confirmations: ${this.confirmations}`);
    }

    log(message) {
        console.log(`[${new Date().toISOString()}] ${message}`); 
    }

    _getProviderForProxy(proxyInstance) {
        const customFetch = async (requestInfo, requestInit) => {
            let url;
            let options = { ...requestInit }; // Clone to avoid modifying original

            if (typeof requestInfo === 'string') {
                url = requestInfo;
            } else if (requestInfo instanceof URL) {
                url = requestInfo.toString();
            } else { // It's a Request object
                url = requestInfo.url;
                options = { ...options, ...requestInfo }; // Merge options from Request object
            }
            
            options.agent = proxyInstance.agent;
            return fetch(url, options);
        };

        return new ethers.JsonRpcProvider(this.rpcUrl, undefined, { fetchFunc: customFetch });
    }

    _selectProxy() {
        for (let i = 0; i < this.proxies.length; i++) {
            const proxy = this.proxies[this.currentProxyIndex];
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
            if (proxy.isHealthy) {
                return proxy;
            }
        }
        return null; // No healthy proxies available
    }

    async _processQueue(proxy) { // Expects the full proxy object
        if (!proxy || proxy.isProcessing || !proxy.isHealthy || proxy.requestQueue.length === 0) {
            if (proxy && proxy.requestQueue.length > 0 && !proxy.isProcessing && !proxy.isHealthy) {
                this.log(`Proxy ${proxy.id}: Queue has tasks but proxy is unhealthy. Not processing.`);
            }
            return;
        }

        proxy.isProcessing = true;
        const task = proxy.requestQueue.shift();
        this.log(`Proxy ${proxy.id}: Dequeued task for wallet ${task.privateKey.substring(0,10)}... Queue size now: ${proxy.requestQueue.length}`);

        const timeSinceLastRequest = Date.now() - proxy.lastRequestTime;
        const delayRequired = Math.max(0, MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);

        if (delayRequired > 0) {
            this.log(`Proxy ${proxy.id}: Delaying next request by ${delayRequired}ms to respect rate limit.`);
        }

        const jitter = Math.random() * 10; // Add 0-10ms jitter
        setTimeout(async () => {
            proxy.lastRequestTime = Date.now();
            // _sendTransactionThroughProxy will handle setting isProcessing = false
            // and then call _processQueue again if needed in its finally block.
            await this._sendTransactionThroughProxy(proxy, task);
        }, delayRequired + jitter);
    }

async _sendTransactionThroughProxy(proxy, task) {
    // this.log(`Proxy ${proxy.id}: Processing task for wallet ${task.privateKey.substring(0,10)}... (Method/Data: ${task.methodName ? task.methodName.substring(0,40) : 'N/A'}...)`);
    const agent = proxy.agent; // Use agent from proxy object

    // customFetch for ethers.JsonRpcProvider to use HttpsProxyAgent
    // Assumes FetchRequest and FetchResponse will be imported from 'ethers'
    const customFetch = async (request) => { // request is ethers.FetchRequest
        const options = {
            method: request.method,
            headers: request.headersToObject(), // Converts ethers.Headers to a plain object for node-fetch
            body: request.body, // request.body is Uint8Array | null
            agent: agent // The HttpsProxyAgent instance
        };

        const nodeFetchResponse = await fetch(request.url, options); // node-fetch call

        // Convert node-fetch Headers back to a plain object for ethers.FetchResponse
        const responseHeaders = {};
        nodeFetchResponse.headers.forEach((value, key) => { responseHeaders[key] = value; });
        
        const responseBody = await nodeFetchResponse.arrayBuffer(); // Get body as ArrayBuffer

        return new FetchResponse(
            nodeFetchResponse.status,
            nodeFetchResponse.statusText,
            responseHeaders,
            new Uint8Array(responseBody), // ethers.FetchResponse expects Uint8Array
            request // The original ethers.FetchRequest that initiated this
        );
    };

    const proxiedProvider = new ethers.JsonRpcProvider(this.rpcUrl, undefined, { batchMaxCount: 1, fetchFunc: customFetch });
    const proxiedSigner = new ethers.Wallet(task.privateKey, proxiedProvider);

    let receipt = null;

    try {
        let transactionRequest = {};

        if (task.methodName && typeof task.methodName === 'string' && task.methodName.startsWith('0x') && (!task.methodArgs || task.methodArgs.length === 0)) {
            // this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Preparing raw transaction with data: ${task.methodName}`);

            transactionRequest = {
                to: this.contractAddress,
                data: task.methodName,
                nonce: task.nonce,
                ...(task.txOptions || {})
            };
        } else if (this.contractAbi && this.contractAbi.length > 0 && task.methodName) {
            // this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Populating transaction for method '${task.methodName}'`);
            const contract = new ethers.Contract(this.contractAddress, this.contractAbi, proxiedSigner);
            const rawTxObject = {
                nonce: task.nonce,
                gasLimit: task.txOptions.gasLimit,
                gasPrice: task.txOptions.gasPrice,
                data: task.methodName
            };
            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Raw tx object PRE-POPULATE. Nonce: ${rawTxObject.nonce}, GasLimit: ${rawTxObject.gasLimit}, GasPrice: ${rawTxObject.gasPrice}, Data: ${rawTxObject.data ? rawTxObject.data.substring(0,10) : 'N/A'}...`);
            const populatedTx = await contract[task.methodName].populateTransaction(...(task.methodArgs || []), task.txOptions || {});
            transactionRequest = populatedTx;
            if (transactionRequest.nonce == null) transactionRequest.nonce = task.nonce;
        } else {
            const errorMessage = `Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Failed: Insufficient data for transaction. MethodName: ${task.methodName}`;
            this.log(errorMessage);
            throw new Error(errorMessage);
        }

        if (!transactionRequest.to && this.contractAddress) {
            transactionRequest.to = this.contractAddress;
        }

        // this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Using standard sendTransaction. TxRequest: To: ${transactionRequest.to}, Nonce: ${transactionRequest.nonce}, Data: ${transactionRequest.data ? transactionRequest.data.substring(0,40) : 'N/A'}...`);
        const txResponse = await proxiedSigner.sendTransaction(transactionRequest);
        this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Standard transaction sent, hash: ${txResponse.hash}. Waiting for ${this.confirmations} confirmation(s)...`);

        if (this.confirmations > 0) {
            try {
                receipt = await txResponse.wait(this.confirmations);
                if (receipt) {
                    receipt.proxyId = proxy.id;
                    receipt.method = 'standard_sendTransaction_with_wait';
                    if (typeof receipt.status === 'undefined') {
                        this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() receipt missing status, assuming 1 (success).`);
                        receipt.status = 1;
                    }
                } else {
                    this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() returned null. Considering successful based on hash.`);
                    receipt = { transactionHash: txResponse.hash, status: 1, confirmations: this.confirmations, proxyId: proxy.id, method: 'standard_sendTransaction_wait_returned_null' };
                }
            } catch (waitError) {
                const waitErrorMessage = waitError.message ? waitError.message.toLowerCase() : '';
                if (waitErrorMessage.includes("full block not allowed")) {
                    this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() failed with "full block not allowed". Proceeding with hash only. Error: ${waitError.message}`);
                    receipt = { transactionHash: txResponse.hash, status: 1, confirmations: 0, proxyId: proxy.id, method: 'standard_sendTransaction_full_block_fallback' };
                } else {
                    this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() failed with unexpected error: ${waitError.message}`);
                    throw waitError;
                }
            }
        } else { // No confirmations requested
            receipt = { transactionHash: txResponse.hash, status: 1, confirmations: 0, proxyId: proxy.id, method: 'standard_sendTransaction_no_wait' };
        }
        
        this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Standard transaction processing completed. Hash: ${(receipt ? receipt.transactionHash : txResponse.hash)}, Status: ${(receipt ? receipt.status : 'unknown')}`);
        proxy.failureCount = 0; // Reset failure count on success
        proxy.isHealthy = true;   // Ensure proxy is marked healthy on success
        task.resolve(receipt);

    } catch (error) {
        if (error.code === 'NETWORK_ERROR') {
            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Network error during transaction: ${error.message}`);
        } else if (error.code === 'INSUFFICIENT_FUNDS') {
            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Insufficient funds for transaction: ${error.message}`);
        } else {
            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Overall error in _sendTransactionThroughProxy: ${error.message} (Stack: ${error.stack})`);
        }
        proxy.failureCount++;
        if (proxy.failureCount >= MAX_PROXY_FAILURES) {
            proxy.isHealthy = false;
            this.log(`Proxy ${proxy.id}: Marked as unhealthy due to ${proxy.failureCount} failures.`);
        }
        task.reject(error);
    } finally {
        proxy.isProcessing = false;
        this.log(`Proxy ${proxy.id}: Task finished processing. Healthy: ${proxy.isHealthy}, Queue length: ${proxy.requestQueue.length}`);
        if (proxy.isHealthy && proxy.requestQueue.length > 0) {
            this.log(`Proxy ${proxy.id}: Attempting to process next in its queue.`);
            this._processQueue(proxy);
        } else if (!proxy.isHealthy) {
            this.log(`Proxy ${proxy.id}: Not processing further from its queue (unhealthy).`);
        }
    }
}

    submitTransaction(privateKey, nonce, methodName, methodArgs, txOptions) {
        methodArgs = methodArgs || [];
        txOptions = txOptions || {};
        return new Promise((resolve, reject) => {
            const selectedProxy = this._selectProxy();
            if (!selectedProxy) {
                reject(new Error('No healthy proxies available.'));
                return;
            }

            const taskData = { privateKey, methodName, methodArgs, txOptions, resolve, reject, nonce };
    
            selectedProxy.requestQueue.push(taskData);
            // console.log(`[${selectedProxy.id}] Task queued for wallet ${privateKey.substring(0,10)}... Method: ${methodName}. Queue size: ${selectedProxy.requestQueue.length}`);

            if (!selectedProxy.isProcessing) {
                this._processQueue(selectedProxy);
            }
        });
    }
}

export default ProxyManager;
