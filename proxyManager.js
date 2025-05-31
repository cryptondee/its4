// proxyManager.js
import { ethers, Wallet, Contract } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch'; // For Node.js environment

const MIN_REQUEST_INTERVAL_MS = 34; // Minimum 34ms between requests per proxy (~29.4 TPS)
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
        console.log(message); 
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

        setTimeout(async () => {
            proxy.lastRequestTime = Date.now();
            // _sendTransactionThroughProxy will handle setting isProcessing = false
            // and then call _processQueue again if needed in its finally block.
            await this._sendTransactionThroughProxy(proxy, task);
        }, delayRequired);
    }

    async _sendTransactionThroughProxy(proxy, task) {
        this.log(`Proxy ${proxy.id}: Processing task for wallet ${task.privateKey.substring(0,10)}... (Method/Data: ${task.methodName ? task.methodName.substring(0,40) : 'N/A'}...)`);
        const agent = new HttpsProxyAgent(proxy.url);

        const customFetch = async (request) => {
            const anRequest = new FetchRequest(request.url);
            anRequest.body = request.body;
            anRequest.headers = request.headers;
            anRequest.method = request.method;
            const fetchResponse = await fetch(anRequest, { agent: agent });
            return new FetchResponse(fetchResponse.status, fetchResponse.statusText, Object.fromEntries(fetchResponse.headers.entries()), fetchResponse.body, request);
        };

        const proxiedProvider = new ethers.JsonRpcProvider(this.rpcUrl, undefined, { batchMaxCount: 1, fetchFunc: customFetch });
        const proxiedSigner = new ethers.Wallet(task.privateKey, proxiedProvider);

        try {
            let transactionRequest = {};

            if (task.methodName && typeof task.methodName === 'string' && task.methodName.startsWith('0x') && (!task.methodArgs || task.methodArgs.length === 0)) {
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Preparing raw transaction with data: ${task.methodName}`);
                transactionRequest = {
                    to: this.contractAddress,
                    data: task.methodName,
                    nonce: task.nonce, // Use nonce from task
                    ...(task.txOptions || {}) // Includes value, gasLimit, etc.
                };
            } else if (this.contractAbi && this.contractAbi.length > 0 && task.methodName) {
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Populating transaction for method '${task.methodName}'`);
                const contract = new ethers.Contract(this.contractAddress, this.contractAbi, proxiedSigner);
                const populatedTx = await contract[task.methodName].populateTransaction(...(task.methodArgs || []), task.txOptions || {});
                transactionRequest = populatedTx;
                if (transactionRequest.nonce == null) transactionRequest.nonce = task.nonce; // Ensure nonce from task is used if not populated by ABI method
            } else {
                proxy.failureCount++;
                if (proxy.failureCount >= MAX_PROXY_FAILURES) proxy.isHealthy = false;
                const errorMessage = `Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Failed: Insufficient data. For ABI calls, methodName & ABI required. For raw calls, methodName (as data) required. Proxy healthy: ${proxy.isHealthy}`;
                this.log(errorMessage);
                task.reject(new Error(errorMessage));
                // Ensure finally block runs, but no further processing in try block
                return; 
            }

            // Ensure 'to' is set if not already by ABI population
            if (!transactionRequest.to && this.contractAddress) {
                transactionRequest.to = this.contractAddress;
            }

            let receipt = null;

            try {
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Preparing for realtime_sendRawTransaction.`);
                const txForSigning = { ...transactionRequest }; // Clone to avoid mutating original request used in fallback

                // Nonce is now sourced from task.nonce, set in transactionRequest and cloned to txForSigning
            // if (txForSigning.nonce == null) txForSigning.nonce = await proxiedSigner.getNonce(); // Removed
                if (txForSigning.chainId == null) {
                    const network = await proxiedProvider.getNetwork();
                    txForSigning.chainId = network.chainId;
                }

                if (txForSigning.gasPrice == null && txForSigning.maxFeePerGas == null) {
                    const feeData = await proxiedProvider.getFeeData();
                    if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
                        txForSigning.maxFeePerGas = feeData.maxFeePerGas;
                        txForSigning.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                    } else if (feeData.gasPrice != null) {
                        txForSigning.gasPrice = feeData.gasPrice;
                    } else {
                        this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Fee data unavailable. Will use standard send.`);
                        throw new Error("Fee data unavailable for realtime send attempt."); // Triggers catch for this block, leading to fallback
                    }
                }

                if (txForSigning.gasLimit == null) {
                    // Ensure all fields needed by estimateGas are present (especially 'from' which is implicit in signer)
                    txForSigning.gasLimit = await proxiedSigner.estimateGas(txForSigning);
                }
                
                const signedTxHex = await proxiedSigner.signTransaction(txForSigning);
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Attempting realtime_sendRawTransaction with signed tx: ${signedTxHex.substring(0,60)}...`);
                
                receipt = await proxiedProvider.send('realtime_sendRawTransaction', [signedTxHex]);
                
                if (receipt && receipt.transactionHash) {
                    this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - realtime_sendRawTransaction successful. Hash: ${receipt.transactionHash}`);
                } else {
                    this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - realtime_sendRawTransaction did not return a valid receipt (Receipt: ${JSON.stringify(receipt)}), falling back.`);
                    receipt = null; // Force fallback
                }
            } catch (realtimeError) {
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - realtime_sendRawTransaction attempt failed: ${realtimeError.message}. Falling back to standard send.`);
                receipt = null; // Ensure fallback path is taken
            }

            if (!receipt) { // Fallback to standard sendTransaction
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Using standard sendTransaction. Original txRequest: To: ${transactionRequest.to}, Data: ${transactionRequest.data ? transactionRequest.data.substring(0,40) : 'N/A'}...`);
                // transactionRequest already contains the nonce from task.nonce.
                // ethers.js will use this nonce.
                const txResponse = await proxiedSigner.sendTransaction(transactionRequest);
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Standard transaction sent, hash: ${txResponse.hash}. Waiting for ${this.confirmations} confirmation(s)...`);
                if (this.confirmations > 0) {
                    try {
                        receipt = await txResponse.wait(this.confirmations);
                        if (receipt) {
                           receipt.proxyId = proxy.id;
                           receipt.method = 'standard_sendTransaction_with_wait';
                           // Ensure status is present, ethers.js wait() receipt should have it
                           if (typeof receipt.status === 'undefined') {
                               this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() receipt missing status, assuming 1 (success).`);
                               receipt.status = 1; 
                           }
                        } else { 
                            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - txResponse.wait() returned null. Proceeding with hash only.`);
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
                } else { 
                    receipt = { transactionHash: txResponse.hash, status: 1, confirmations: 0, proxyId: proxy.id, method: 'standard_sendTransaction_no_wait' };
                }
                this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Standard transaction processing completed. Hash: ${(receipt ? receipt.transactionHash : txResponse.hash)}, Status: ${(receipt ? receipt.status : 'unknown')}, Method: ${(receipt ? receipt.method : 'unknown')}`);
            }

            proxy.failureCount = 0; 
            proxy.isHealthy = true; 
            task.resolve(receipt); // Resolve with the final receipt

        } catch (error) {
            this.log(`Proxy ${proxy.id}: Wallet ${proxiedSigner.address} - Overall error in _sendTransactionThroughProxy: ${error.message} (Stack: ${error.stack})`);
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
                this._processQueue(proxy); // Pass the full proxy object
            } else if (!proxy.isHealthy) {
                this.log(`Proxy ${proxy.id}: Not processing further from its queue (unhealthy).`);
            }
        }
    }

    submitTransaction(privateKey, nonce, methodName, methodArgs = [], txOptions = {}) {
        return new Promise((resolve, reject) => {
            const selectedProxy = this._selectProxy();
            if (!selectedProxy) {
                reject(new Error('No healthy proxies available.'));
                return;
            }

            selectedProxy.requestQueue.push({ privateKey, methodName, methodArgs, txOptions, resolve, reject });
            console.log(`[${selectedProxy.id}] Task queued for wallet ${privateKey.substring(0,10)}... Method: ${methodName}. Queue size: ${selectedProxy.requestQueue.length}`);

            if (!selectedProxy.isProcessing) {
                this._processQueue(selectedProxy);
            }
        });
    }
}

export default ProxyManager;
