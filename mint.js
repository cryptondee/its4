// mint.js

const MAX_TRANSACTION_RETRIES = 5;
const RETRY_DELAY_MS = 1000; // 1 second delay for general retries
const NONCE_RETRY_DELAY_MS = 500; // Shorter delay if only re-fetching nonce
const DIRECT_PROVIDER_CALL_INTERVAL_MS = 100; // Min interval between direct provider calls for nonce

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
import 'dotenv/config'; // Make sure to install dotenv: npm install dotenv
import ProxyManager from './proxyManager.js';
import { ethers } from 'ethers'; // Only needed here for Wallet address display or utils

// --- Configuration ---
// IMPORTANT: Replace with your actual data or load from .env
const RPC_URL = process.env.RPC_URL || 'YOUR_FALLBACK_RPC_URL_HERE';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || 'YOUR_CONTRACT_ADDRESS_HERE';

// Contract ABI is not strictly needed for sending raw transaction data directly,
// but ProxyManager constructor expects it (can be an empty array).
const CONTRACT_ABI = []; 

const RAW_TRANSACTION_DATA = process.env.RAW_TRANSACTION_DATA_OVERRIDE || '0x05632f40'; // User-provided raw transaction data
const TOTAL_TRANSACTIONS_TO_SEND = 100; // <<< SET TOTAL NUMBER OF TRANSACTIONS TO SEND HERE

// --- Oxylabs Proxy Configuration ---
const OXYLABS_CORE_USERNAME = process.env.OXYLABS_CORE_USERNAME;
const OXYLABS_PASSWORD = process.env.OXYLABS_PASSWORD;
const OXYLABS_HOST_PORT = 'pr.oxylabs.io:7777'; // Oxylabs backconnect proxy
const OXYLABS_COUNTRY_CODE = 'US'; // Or make this dynamic if needed

if (!OXYLABS_CORE_USERNAME || !OXYLABS_PASSWORD) {
    console.error('Error: OXYLABS_CORE_USERNAME or OXYLABS_PASSWORD not set in .env file.');
    process.exit(1);
}

const NUM_PROXY_SESSIONS = 80; // The number of concurrent proxy sessions you want
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

async function main() {
    const startTime = Date.now();
    console.log('Starting transaction minting process with explicit nonce management...');

    if (PROXY_CONFIGS.length === 0 && NUM_PROXY_SESSIONS > 0) {
        console.warn("Warning: PROXY_CONFIGS is empty but NUM_PROXY_SESSIONS > 0. No proxies will be used if this was unintended.");
    }

    // Initialize ProxyManager
    const proxyManager = new ProxyManager(PROXY_CONFIGS, RPC_URL, CONTRACT_ADDRESS, CONTRACT_ABI, 1 /* confirmations */);

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

    const transactionPromises = [];
    let successfulTransactions = 0;
    let failedTransactions = 0;

    for (let i = 0; i < TOTAL_TRANSACTIONS_TO_SEND; i++) {
        const walletIndex = i % activeWallets.length;
        const walletInfo = activeWallets[walletIndex];
        const transactionNumber = i + 1; // For logging, 1-based index

        await delay(25); // Add 25ms delay before processing each transaction

        const promise = (async () => {
            for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt++) {
                try {
                    console.log(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}..., Nonce ${walletInfo.currentNonce}, Attempt ${attempt + 1}/${MAX_TRANSACTION_RETRIES}): Preparing...`);
                    
                    const rawData = RAW_TRANSACTION_DATA;
                    const methodArgs = [];
                    const txOptions = {
                        gasLimit: 90000,
                        gasPrice: ethers.parseUnits("0.0012", "gwei"),
                    };

                    const txResult = await proxyManager.submitTransaction(walletInfo.privateKey, walletInfo.currentNonce, rawData, methodArgs, txOptions);
                    
                    console.log(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}..., Nonce ${walletInfo.currentNonce}): Successfully sent. Result: ${txResult ? JSON.stringify(txResult).substring(0,80) : 'No result'}`);
                    walletInfo.currentNonce++; // IMPORTANT: Increment nonce for this wallet
                    successfulTransactions++;
                    return { status: 'fulfilled', value: txResult, walletAddress: walletInfo.address };
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
                                // Use the new queue system for fetching nonces
                                const attemptInfo = `Attempt ${nonceAttempt + 1}/${MAX_TRANSACTION_RETRIES}`;
                                const newNonce = await fetchNonceViaQueue(walletInfo.address, attemptInfo);
                                // Original log for context, newNonce is already logged by queue processor
                                console.log(`Wallet ${walletInfo.address.substring(0,10)} (Nonce Fetch Attempt ${nonceAttempt + 1}): Old nonce ${walletInfo.currentNonce}, New nonce from provider (via queue): ${newNonce}. Adjusting.`);
                                walletInfo.currentNonce = newNonce;
                                nonceRefetched = true;
                                break; // Successfully fetched new nonce
                            } catch (nonceFetchErr) {
                                // Error is already logged by the queue processor
                                // console.error(`Wallet ${walletInfo.address.substring(0,10)} (Nonce Fetch Attempt ${nonceAttempt + 1}): FAILED to re-fetch nonce via queue: ${nonceFetchErr.message}`);
                                if (nonceAttempt >= MAX_TRANSACTION_RETRIES - 1) {
                                    console.error(`Wallet ${walletInfo.address.substring(0,10)}: All ${MAX_TRANSACTION_RETRIES} attempts to re-fetch nonce via queue FAILED.`);
                                }
                            }
                        }
                        if (nonceRefetched && attempt < MAX_TRANSACTION_RETRIES - 1) {
                            console.log(`Wallet ${walletInfo.address.substring(0,10)}: Nonce updated to ${walletInfo.currentNonce}. Retrying transaction submission.`);
                            continue; // Retry transaction submission with the new nonce
                        }
                        // If nonce re-fetch failed or it's the last transaction attempt, fall through to general error handling / failure
                    } else if (errorMessage.includes('txpool is full') || errorMessage.includes('exceeds block gas limit') || errorMessage.includes('insufficient funds')) {
                        // Specific retryable errors
                        console.log(`Retryable error for Wallet ${walletInfo.address.substring(0,10)}: ${err.message}. Waiting ${RETRY_DELAY_MS}ms...`);
                        await delay(RETRY_DELAY_MS);
                        if (attempt < MAX_TRANSACTION_RETRIES - 1) continue;
                    }
                    // For other errors or if it's the last attempt
                    if (attempt >= MAX_TRANSACTION_RETRIES - 1) {
                        console.error(`Tx #${transactionNumber} (Wallet ${walletInfo.address.substring(0,10)}...): All retries failed or non-retryable error. Error: ${err.message}`);
                        failedTransactions++;
                        return { status: 'rejected', reason: err.message, walletAddress: walletInfo.address };
                    }
                    // General delay for other errors before retrying
                    await delay(RETRY_DELAY_MS);
                }
            } // End of retry loop
            // Should not be reached if logic inside loop is correct (either returns or throws)
            return { status: 'rejected', reason: 'Retry loop exited unexpectedly', walletAddress: walletInfo.address }; 
        })();
        transactionPromises.push(promise);

        if ((i + 1) % 100 === 0 && i < TOTAL_TRANSACTIONS_TO_SEND -1) {
            const intermediateTime = Date.now();
            console.log(`--- Submitted ${i + 1} transaction processing flows. Elapsed time: ${((intermediateTime - startTime) / 1000).toFixed(2)}s ---`);
        }
    }

    // Wait for all transaction processing flows (including retries) to settle.
    await Promise.allSettled(transactionPromises);
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