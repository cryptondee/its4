// mint.js
import 'dotenv/config'; // Make sure to install dotenv: npm install dotenv
import ProxyManager from './proxyManager.js';
import { ethers } from 'ethers'; // Used for AbiCoder and Wallet // Only needed here for Wallet address display or utils
const MAX_TRANSACTION_RETRIES = 5;
const RETRY_DELAY_MS = 1000; // 1 second delay for general retries
const NONCE_RETRY_DELAY_MS = 500; // Shorter delay if only re-fetching nonce
const DIRECT_PROVIDER_CALL_INTERVAL_MS = 100; // Min interval between direct provider calls for nonce

// Helper function to generate multicall data for an aggregate(Call[] calls) style multicall
function generateMulticallData(targetAddress, individualMintCalldata, count) {
  const calls = [];
  for (let i = 0; i < count; i++) {
    calls.push({
      target: targetAddress, // The contract to call for each mint
      callData: individualMintCalldata // The calldata for the individual mint function
    });
  }

  // Define the structure of the Call type
  const callStructType = "tuple(address target, bytes callData)[]";
  
  // The ethers.js AbiCoder will correctly encode the array of Call structs
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedCallsArray = abiCoder.encode([callStructType], [calls]);

  const multicallFunctionSelector = '0x252dba42'; // Selector for aggregate(Call[] calldata calls)

  // The final calldata is the selector + encoded arguments
  return multicallFunctionSelector + encodedCallsArray.substring(2); // Remove '0x' from encodedCallsArray
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// --- Configuration ---
// IMPORTANT: Replace with your actual data or load from .env
const RPC_URL = process.env.RPC_URL || 'YOUR_FALLBACK_RPC_URL_HERE';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0xb1f60733c7b76f8f4085af3d9f6e374c43e462f8'; // The multicall contract address
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS || '0xbe43d66327ca5b77e7f14870a94a3058511103d3'; // The actual token contract to call mint on (assumed same as multicall)
console.log(`[DEBUG] Using CONTRACT_ADDRESS: ${CONTRACT_ADDRESS}`);
console.log(`[DEBUG] Using TOKEN_CONTRACT_ADDRESS: ${TOKEN_CONTRACT_ADDRESS}`);
const CONFIRMATIONS_REQUIRED = parseInt(process.env.CONFIRMATIONS_REQUIRED) || 0;

// Contract ABI is not strictly needed for sending raw transaction data directly,
// but ProxyManager constructor expects it (can be an empty array).
const CONTRACT_ABI = []; 

// --- Multicall Configuration ---
// The ABI for TOKEN_CONTRACT_ADDRESS (0xbe43d66327ca5b77e7f14870a94a3058511103d3)
// indicates a parameterless mint function with selector 0x05632f40.
// This function will mint tokens to the msg.sender of the call.
// In the multicall context, msg.sender for the mint() call is the multicall contract (CONTRACT_ADDRESS).
const MINT_FUNCTION_SELECTOR = '0x05632f40'; // Selector for the parameterless mint() function
const SINGLE_MINT_CALLDATA = MINT_FUNCTION_SELECTOR;

// RECIPIENT_ADDRESS is the address expected to receive the tokens.
// With the parameterless mint, this will be the multicall contract itself.
const RECIPIENT_ADDRESS = '0xb1f60733c7b76f8f4085af3d9f6e374c43e462f8';
const MINTS_PER_MULTICALL = 125; // Number of mints to batch in one multicall transaction
const RAW_TRANSACTION_DATA = generateMulticallData(TOKEN_CONTRACT_ADDRESS, SINGLE_MINT_CALLDATA, MINTS_PER_MULTICALL);

// --- Script Execution Configuration ---
const TOTAL_TRANSACTIONS_TO_SEND = 10000; // Number of multicall transactions to send
const MAX_CONCURRENT_TASKS_CONFIG = 150; // Max concurrent tasks for ProxyManager

// --- Oxylabs Proxy Configuration ---
const OXYLABS_CORE_USERNAME = process.env.OXYLABS_CORE_USERNAME;
const OXYLABS_PASSWORD = process.env.OXYLABS_PASSWORD;
const OXYLABS_HOST_PORT = 'pr.oxylabs.io:7777'; // Oxylabs backconnect proxy
const OXYLABS_COUNTRY_CODE = 'US'; // Or make this dynamic if needed

if (!OXYLABS_CORE_USERNAME || !OXYLABS_PASSWORD) {
    console.error('Error: OXYLABS_CORE_USERNAME or OXYLABS_PASSWORD not set in .env file.');
    process.exit(1);
}

const NUM_PROXY_SESSIONS = 150; // The number of concurrent proxy sessions you want
const PROXY_CONFIGS = [];

for (let i = 0; i < NUM_PROXY_SESSIONS; i++) {
    const sessionId = `scriptsess${Date.now()}${i}`; // Unique session ID
    
    // Construct the full username for Oxylabs: customer-CORE_USER-cc-COUNTRY-sessid-SESSIONID
    const proxyUser = `customer-${OXYLABS_CORE_USERNAME}-cc-${OXYLABS_COUNTRY_CODE}-sessid-${sessionId}`;

    PROXY_CONFIGS.push({
        url: `http://${proxyUser}:${OXYLABS_PASSWORD}@${OXYLABS_HOST_PORT}`
    });
}

if (PROXY_CONFIGS.length === 0 && NUM_PROXY_SESSIONS > 0) {
    console.error("No valid Oxylabs proxy configurations were generated. Check .env and script logic.");
    process.exit(1);
}

// Wallets: Load private keys from .env (comma-separated string)
const walletPrivateKeysCsv = process.env.WALLET_PRIVATE_KEYS_CSV;
const walletInfos = []; // Will store { privateKey, walletInstance, currentNonce, address }

if (!walletPrivateKeysCsv || walletPrivateKeysCsv.trim() === '') {
    console.error('Error: WALLET_PRIVATE_KEYS_CSV not set or empty in .env file. Please provide a comma-separated list of private keys.');
    process.exit(1);
}

const directProvider = new ethers.JsonRpcProvider(RPC_URL); // For direct nonce fetching

// --- Direct Provider Call Queue for Nonce Fetching ---
const directProviderNonceQueue = [];
let isProcessingDirectNonceQueue = false;
let lastDirectNonceCallTime = 0;

async function processDirectNonceQueue() {
    if (isProcessingDirectNonceQueue || directProviderNonceQueue.length === 0) {
        return;
    }
    isProcessingDirectNonceQueue = true;

    const { walletAddress, resolve, reject, attemptInfo } = directProviderNonceQueue.shift();

    try {
        const now = Date.now();
        const timeSinceLastCall = now - lastDirectNonceCallTime;
        if (timeSinceLastCall < DIRECT_PROVIDER_CALL_INTERVAL_MS) {
            await delay(DIRECT_PROVIDER_CALL_INTERVAL_MS - timeSinceLastCall);
        }
        
        console.log(`Wallet ${walletAddress.substring(0,10)} (Nonce Fetch via Queue - ${attemptInfo}): Attempting directProvider.getTransactionCount...`);
        const nonce = await directProvider.getTransactionCount(walletAddress, "pending");
        lastDirectNonceCallTime = Date.now();
        console.log(`Wallet ${walletAddress.substring(0,10)} (Nonce Fetch via Queue - ${attemptInfo}): SUCCESS! New nonce from provider: ${nonce}.`);
        resolve(nonce);
    } catch (err) {
        lastDirectNonceCallTime = Date.now(); // Still update time to maintain interval for next attempt
        console.error(`Wallet ${walletAddress.substring(0,10)} (Nonce Fetch via Queue - ${attemptInfo}): FAILED to re-fetch nonce: ${err.message}`);
        if (err.stack) console.error(`Nonce Fetch Stack (Queue): ${err.stack}`);
        reject(err);
    } finally {
        isProcessingDirectNonceQueue = false;
        if (directProviderNonceQueue.length > 0) {
            processDirectNonceQueue(); // Process next item if any
        }
    }
}

function fetchNonceViaQueue(walletAddress, attemptInfo) {
    return new Promise((resolve, reject) => {
        directProviderNonceQueue.push({ walletAddress, resolve, reject, attemptInfo });
        if (!isProcessingDirectNonceQueue) {
            processDirectNonceQueue();
        }
    });
}

// Initialize walletInfos array
const parsedPrivateKeys = walletPrivateKeysCsv.split(',').map(key => key.trim()).filter(key => {
    if (!key.startsWith('0x')) {
        console.warn(`Invalid private key format (must start with 0x): ${key.substring(0,10)}... Skipping.`);
        return false;
    }
    if (key.length !== 66) { // 0x + 64 hex characters
        console.warn(`Invalid private key length for key: ${key.substring(0,10)}... Expected 66 chars, got ${key.length}. Skipping.`);
        return false;
    }
    return true;
});

if (parsedPrivateKeys.length === 0) {
    console.error('Error: No valid private keys found after parsing WALLET_PRIVATE_KEYS_CSV. Ensure keys are comma-separated, start with 0x, and have correct length.');
    process.exit(1);
}

parsedPrivateKeys.forEach(privateKey => {
    try {
        const walletInstance = new ethers.Wallet(privateKey);
        walletInfos.push({ privateKey, walletInstance, currentNonce: null, address: walletInstance.address });
    } catch (e) {
        console.warn(`Failed to create wallet instance for private key ${privateKey.substring(0,10)}...: ${e.message}. Skipping this key.`);
    }
});

if (walletInfos.length === 0) { // This check is after attempting to create instances
    console.error('Error: No wallet instances could be created from the provided private keys. Halting.');
    process.exit(1);
}

console.log(`ProxyManager will be initialized with ${PROXY_CONFIGS.length} Oxylabs proxy session configurations.`);
console.log(`Successfully created ${walletInfos.length} wallet instances from ${parsedPrivateKeys.length} initially valid private key strings found.`);

// --- Sanity Checks for Configuration ---
if (!RPC_URL || RPC_URL === 'YOUR_FALLBACK_RPC_URL_HERE') {
    console.error('Error: RPC_URL is not set. Please set it in .env or directly in the script.');
    process.exit(1);
}
if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === 'YOUR_CONTRACT_ADDRESS_HERE') {
    console.error('Error: CONTRACT_ADDRESS is not set. Please set it in .env or directly in the script.');
    process.exit(1);
}
if (!RAW_TRANSACTION_DATA || !RAW_TRANSACTION_DATA.startsWith('0x')) {
    console.error('Error: RAW_TRANSACTION_DATA is not set correctly. It should be a hex string starting with 0x.');
    process.exit(1);
}
if (PROXY_CONFIGS.length < NUM_PROXY_SESSIONS && NUM_PROXY_SESSIONS > 0) {
    console.warn(`Warning: Fewer proxy configurations (${PROXY_CONFIGS.length}) generated than desired (${NUM_PROXY_SESSIONS}). Check OXYLABS .env variables.`);
}
if (walletInfos.length === 0) {
    console.error('Error: No wallet private keys found. Please set WALLET_PK_ environment variables or define them directly and ensure they are not filtered out.');
    process.exit(1);
}

const walletLocks = new Map(); // walletAddress -> Promise (representing the lock)

async function withWalletLock(walletAddress, operation) {
    // Wait for the previous operation on this wallet to complete
    // Check if a lock exists and wait for it
    while (walletLocks.has(walletAddress)) {
        try {
            await walletLocks.get(walletAddress);
        } catch (e) {
            // If the existing lock promise rejects, that's fine, the lock is still 'released'
            // console.warn(`Wallet ${walletAddress.substring(0,10)}: Warning - awaited lock promise rejected. This is usually okay.`);
        }
    }

    // Acquire lock: Create a new promise and store it
    let releaseLock;
    const lockPromise = new Promise(resolve => { releaseLock = resolve; });
    walletLocks.set(walletAddress, lockPromise);

    try {
        return await operation();
    } finally {
        // Release lock: remove the promise from the map and resolve it
        // This allows the next waiter (if any) to proceed past the await walletLocks.get(walletAddress)
        walletLocks.delete(walletAddress);
        releaseLock(); 
    }
}

async function main() {
    const startTime = Date.now();
    console.log('Starting transaction minting process with explicit nonce management...');

    if (PROXY_CONFIGS.length === 0 && NUM_PROXY_SESSIONS > 0) {
        console.warn("Warning: PROXY_CONFIGS is empty but NUM_PROXY_SESSIONS > 0. No proxies will be used if this was unintended.");
    }

    // Initialize ProxyManager
    const proxyManager = new ProxyManager(PROXY_CONFIGS, RPC_URL, CONTRACT_ADDRESS, CONTRACT_ABI, CONFIRMATIONS_REQUIRED, NUM_PROXY_SESSIONS);

    // Step 1: Fetch initial nonces for all wallets
    console.log("Fetching initial nonces for all wallets...");
    for (const walletInfo of walletInfos) {
        try {
            walletInfo.currentNonce = await directProvider.getTransactionCount(walletInfo.address, "pending");
            console.log(`Wallet ${walletInfo.address}: Initial nonce set to ${walletInfo.currentNonce}`);
        } catch (err) {
            console.error(`Failed to fetch initial nonce for wallet ${walletInfo.address}: ${err.message}. This wallet will be skipped if nonce remains null.`);
            // walletInfo.currentNonce will remain null, and it will be skipped later
        }
    }

    const activeWallets = walletInfos.filter(wi => wi.currentNonce !== null);
    if (activeWallets.length === 0) {
        console.error("No wallets could be initialized with a starting nonce. Halting.");
        return;
    }
    console.log(`Successfully fetched initial nonces for ${activeWallets.length} wallets.`);

    console.log(`Starting a total of ${TOTAL_TRANSACTIONS_TO_SEND} transactions using ${activeWallets.length} active wallets. Raw data: ${RAW_TRANSACTION_DATA}`);

    const MAX_CONCURRENT_TASKS = 150; // Max number of concurrent transaction processing flows
    const runningTasks = []; // Stores promises of currently running transaction flows
    let successfulTransactions = 0;
    let failedTransactions = 0;
    let globalTransactionCounter = 0; // To ensure unique transaction numbers even with retries

    console.log(`Starting transaction loop with MAX_CONCURRENT_TASKS: ${MAX_CONCURRENT_TASKS}`);

    const numActiveWallets = activeWallets.length;
    const transactionsPerWalletBase = Math.floor(TOTAL_TRANSACTIONS_TO_SEND / numActiveWallets);
    let remainderTransactions = TOTAL_TRANSACTIONS_TO_SEND % numActiveWallets;
    let overallDispatchedCount = 0;

    for (const walletInfo of activeWallets) {
        let transactionsForThisWallet = transactionsPerWalletBase;
        if (remainderTransactions > 0) {
            transactionsForThisWallet++;
            remainderTransactions--;
        }

        if (transactionsForThisWallet === 0) continue;

        console.log(`Wallet ${walletInfo.address.substring(0,10)}... assigned ${transactionsForThisWallet} transactions.`);

        for (let j = 0; j < transactionsForThisWallet; j++) {
            if (overallDispatchedCount >= TOTAL_TRANSACTIONS_TO_SEND) break; // Safety break

            if (runningTasks.length >= MAX_CONCURRENT_TASKS) {
                // console.log(`Concurrency limit ${MAX_CONCURRENT_TASKS} reached. Waiting for a task to complete... (${runningTasks.length} active)`);
                try {
                    await Promise.race(runningTasks);
                } catch (e) {
                    // A promise in Promise.race might have rejected, this is fine, it means a slot is free.
                    // console.log("A task completed (possibly with error), freeing up concurrency slot.");
                }
            }

            const transactionNumber = ++globalTransactionCounter; // Use a global counter for unique tx logging ID

            const taskPromise = withWalletLock(walletInfo.address, async () => {
                // This async block is serialized per wallet due to withWalletLock
                // It represents the processing for a single transaction for this wallet
                for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt++) {
                    try {
                        console.log(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}..., Nonce ${walletInfo.currentNonce}, Attempt ${attempt + 1}/${MAX_TRANSACTION_RETRIES}): Preparing...`);
                        
                        const rawData = RAW_TRANSACTION_DATA;
                        const methodArgs = [];
                        // console.log(`Tx #${transactionNumber}: Using RAW_TRANSACTION_DATA starting with: ${rawData.substring(0, 70)}`); // Reduced verbosity
                        const txOptions = {
                            gasLimit: 5000000,
                            gasPrice: ethers.parseUnits("0.0019", "gwei"),
                        };

                        const txResult = await proxyManager.submitTransaction(walletInfo.privateKey, walletInfo.currentNonce, rawData, methodArgs, txOptions);
                        
                        console.log(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}..., Nonce ${walletInfo.currentNonce}): Successfully sent. Hash: ${txResult.hash ? txResult.hash.substring(0,10) : 'N/A'}...`);
                        walletInfo.currentNonce++; // IMPORTANT: Increment nonce for this wallet
                        // successfulTransactions++; // Moved to .then() handler below
                        return { success: true, result: txResult, walletAddress: walletInfo.address, transactionNumber };
                    } catch (err) {
                        console.error(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}..., Nonce ${walletInfo.currentNonce}, Attempt ${attempt + 1}): Failed: ${err.message}`);
                        
                        const errorMessage = err.message.toLowerCase();
                        const errorReason = err.reason ? err.reason.toLowerCase() : '';
                        const errorCode = err.code ? err.code.toString().toLowerCase() : '';

                        if (errorMessage.includes('nonce too low') || errorMessage.includes('nonce has already been used') || errorMessage.includes('replacement transaction underpriced') || errorReason.includes('nonce') || errorCode === 'nonce_expired' || errorCode === '-32003' /* Ganache nonce too low */) {
                            console.log(`Nonce error for Wallet ${walletInfo.address.substring(0,10)}. Attempting to fetch new nonce...`);
                            let nonceRefetched = false;
                            for (let nonceAttempt = 0; nonceAttempt < MAX_TRANSACTION_RETRIES; nonceAttempt++) {
                                await delay(NONCE_RETRY_DELAY_MS * (nonceAttempt + 1)); // Increasing delay for nonce re-fetch
                                try {
                                    const attemptInfo = `Attempt ${nonceAttempt + 1}/${MAX_TRANSACTION_RETRIES}`;
                                    const newNonce = await fetchNonceViaQueue(walletInfo.address, attemptInfo);
                                    console.log(`Wallet ${walletInfo.address.substring(0,10)} (Nonce Fetch Attempt ${nonceAttempt + 1}): Old nonce ${walletInfo.currentNonce}, New nonce from provider (via queue): ${newNonce}. Adjusting.`);
                                    walletInfo.currentNonce = newNonce;
                                    nonceRefetched = true;
                                    break; // Successfully fetched new nonce
                                } catch (nonceFetchErr) {
                                    if (nonceAttempt >= MAX_TRANSACTION_RETRIES - 1) {
                                        console.error(`Wallet ${walletInfo.address.substring(0,10)}: All ${MAX_TRANSACTION_RETRIES} attempts to re-fetch nonce via queue FAILED.`);
                                    }
                                }
                            }
                            if (nonceRefetched && attempt < MAX_TRANSACTION_RETRIES - 1) {
                                console.log(`Wallet ${walletInfo.address.substring(0,10)}: Nonce updated to ${walletInfo.currentNonce}. Retrying transaction submission.`);
                                continue; // Retry transaction submission with the new nonce
                            }
                        } else if (errorMessage.includes('txpool is full') || errorMessage.includes('exceeds block gas limit') || errorMessage.includes('insufficient funds') || errorMessage.includes('fee too low') || errorMessage.includes('transaction underpriced')) {
                            console.log(`Retryable error for Wallet ${walletInfo.address.substring(0,10)}: ${err.message}. Waiting ${RETRY_DELAY_MS}ms...`);
                            await delay(RETRY_DELAY_MS);
                            if (attempt < MAX_TRANSACTION_RETRIES - 1) continue;
                        }
                        if (attempt >= MAX_TRANSACTION_RETRIES - 1) {
                            const finalErrorMsg = `Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}...): All retries failed. Last error: ${err.message}`;
                            console.error(finalErrorMsg);
                            throw new Error(finalErrorMsg);
                        }
                        await delay(RETRY_DELAY_MS);
                    }
                } // End of retry loop
                const allRetriesFailedError = `Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}...): Max retries reached, transaction ultimately failed.`;
                console.error(allRetriesFailedError);
                throw new Error(allRetriesFailedError);
            })
            .then(result => {
                if (result && result.success) { // Check if result is defined
                    successfulTransactions++;
                }
                // console.log(`Tx #${result.transactionNumber} completed for wallet ${result.walletAddress.substring(0,10)}`);
            })
            .catch(err => {
                // console.error(`Tx processing for wallet (originally Tx #${transactionNumber}) ultimately failed: ${err.message}`);
                failedTransactions++; 
            })
            .finally(() => {
                const index = runningTasks.indexOf(taskPromise);
                if (index > -1) {
                    runningTasks.splice(index, 1);
                }
            });
            runningTasks.push(taskPromise);
            overallDispatchedCount++;

            // Intermediate progress logging
            if ((overallDispatchedCount % 100 === 0 || overallDispatchedCount === TOTAL_TRANSACTIONS_TO_SEND) && overallDispatchedCount > 0) {
                const intermediateTime = Date.now();
                console.log(`--- Dispatched ${overallDispatchedCount}/${TOTAL_TRANSACTIONS_TO_SEND} transaction flows. Elapsed: ${((intermediateTime - startTime) / 1000).toFixed(2)}s. Success: ${successfulTransactions}, Fail: ${failedTransactions} ---`);
            }
        }
        if (overallDispatchedCount >= TOTAL_TRANSACTIONS_TO_SEND) break; // Break outer loop if all sent
    }

        if ((i + 1) % 100 === 0 && i < TOTAL_TRANSACTIONS_TO_SEND -1) {
            const intermediateTime = Date.now();
            console.log(`--- Submitted ${i + 1} transaction processing flows. Elapsed time: ${((intermediateTime - startTime) / 1000).toFixed(2)}s ---`);
        }
    }

    // Wait for all remaining tasks to complete
    console.log(`All ${TOTAL_TRANSACTIONS_TO_SEND} transaction flows dispatched. Waiting for ${runningTasks.length} active tasks to complete...`);
    await Promise.allSettled(runningTasks);
    const endTime = Date.now();
    const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(2);

    console.log('\n--- Transaction Sending Complete ---');
    console.log(`Total transactions targeted: ${TOTAL_TRANSACTIONS_TO_SEND}`);
    console.log(`Successful transactions recorded by mint.js: ${successfulTransactions}`);
    console.log(`Failed transactions recorded by mint.js (after retries): ${failedTransactions}`);
    console.log(`Using ${activeWallets.length} active wallets.`);
    console.log(`Total time taken: ${totalTimeSeconds}s`);
    const Tps = (successfulTransactions / parseFloat(totalTimeSeconds));
    console.log(`Average TPS for successful transactions: ${isNaN(Tps) ? 'N/A' : Tps.toFixed(2)}`);
    console.log('------------------------------------\n');
}

main().catch(error => {
    console.error("Unhandled error in main execution:", error);
    process.exit(1);
});