import {ethers} from "ethers";
import * as fs from "fs";
import * as path from "path";
import axios, {AxiosResponse} from "axios";
import * as crypto from '@shardus/crypto-utils';
import * as readline from "readline-sync";

const {BigNumber, utils: ethersUtils, providers} = ethers;

const gg18 = require("../pkg");
const {stringify, parse} = require('../external/stringify-shardus');

interface Params {
    threshold: number;
    parties: number;
}

interface TransactionQueueItem {
    receipt: any;
    from: string;
    value: ethers.BigNumber | bigint;
    txId: string;
    type: "tokenToCoin" | "coinToToken";
}

interface TxQueueMapValue {
    status: "pending" | "processing" | "completed" | "failed";
    from: string;
    value: ethers.BigNumber | bigint;
    txId: string;

    [key: string]: any;
}

interface KeyShare {
    idx: number;
    res: string;
}

interface BridgeOutEvent {
    from: string;
    amount: ethers.BigNumber;
    targetAddress: string;
    chainId: number;
    txId: string;
}

interface LiberdusTx {
    from: string;
    to: string;
    amount: bigint;
    type: string;
    memo: string;
    chatId?: string;
    timestamp?: number;
    sign?: {
        owner: string;
        sig: string;
    };
}

interface SignedTx {
    [key: string]: any;

    sign: {
        owner: string;
        sig: string;
    };
}

// Transaction interface to send to the coordinator
export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: TransactionType;
  txTimestamp: number;
  status: TransactionStatus;
  receipt: string;
  createdAt?: string;
  updatedAt?: string;
}

export enum TransactionStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
}

export enum TransactionType {
  BRIDGE_IN = 0, // COIN to TOKEN
  BRIDGE_OUT = 1, // TOKEN to COIN
}

const parsedIdx = process.argv[2];
const keygenFlag = process.argv[3];

const generateKeystore = keygenFlag === '--keygen';
const loadExistingQueue = true;
const verboseLogs = true
const addOldTxToQueue = false;

const serverStartTime = Date.now();
let startingBlock = 0;

let params: Params = loadParams();
let t = params.threshold;
let n = params.parties;

const infuraKeys = JSON.parse(fs.readFileSync(path.join(__dirname, '../', 'infura_keys.json'), 'utf8'));

const chainId = 80002;
const coordinatorUrl = "http://dev.liberdus.com:8000";
const collectorHost = "http://dev.liberdus.com:6001";
const proxyServerHost = "https://dev.liberdus.com:3030";


const tssPartyIdx = parsedIdx == null ? readline.question("Enter the party index (1 to 5): ") : parsedIdx;
const ourParty: KeyShare = {idx: parseInt(tssPartyIdx), res: ''};

const ourInfurKey = infuraKeys[parseInt(tssPartyIdx) - 1];
const wsProvider = new ethers.providers.WebSocketProvider(`wss://polygon-amoy.infura.io/ws/v3/${ourInfurKey}`);
const provider: ethers.providers.JsonRpcProvider = new providers.JsonRpcProvider(`https://polygon-amoy.infura.io/v3/${ourInfurKey}`);

const tssSenderAddress = "0x22443e34ed93D88cAA380f76d8e072998990D221"; // "343AB7d3EEF70f7299781a5Fc007935A2CA663d9000000000000000000000000";
const bridgeAddressInLiberdus = "eacb10fb8e61b0f382c0b3f25b6ffcdb985ea5af000000000000000000000000";
const liberdusContractAddress = "0x4EA46e5dD276eeB5D423465b4aFf646AC3f7bd74";

let lastCheckedTimestamp = serverStartTime
let lastCheckedBlockNumber = 0;

const cryptoInitKey = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc';
crypto.init(cryptoInitKey);
crypto.setCustomStringifier(stringify, 'shardus_safeStringify');

const KEYSTORE_DIR = path.join(__dirname, "../keystores");

// enough party subscribed error
const enoughPartyError = "Enough party already registerd to sign this transaction";

if (!fs.existsSync(KEYSTORE_DIR)) {
    fs.mkdirSync(KEYSTORE_DIR, {recursive: true});
}

const txQueue: TransactionQueueItem[] = [];
const txQueueMap: Map<string, TxQueueMapValue> = new Map();
const txQueueSize = 10;
const txQueueInterval = 3000;
let processing = false;

const delay_ms = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loadParams(): Params {
    const data = fs.readFileSync(path.join(__dirname, '../', 'params.json'), 'utf8');
    return JSON.parse(data);
}

const getKeystoreFilePath = (partyIdx: number): string => {
    return path.join(KEYSTORE_DIR, `keystore_party_${partyIdx}.json`);
};

const keystoreExists = (partyIdx: number): boolean => {
    return fs.existsSync(getKeystoreFilePath(partyIdx));
};

const saveKeystore = (partyIdx: number, keystore: string): void => {
    fs.writeFileSync(getKeystoreFilePath(partyIdx), keystore);
    console.log(`Keystore for party ${partyIdx} saved to ${getKeystoreFilePath(partyIdx)}`);
};

const loadKeystore = (partyIdx: number): string => {
    return fs.readFileSync(getKeystoreFilePath(partyIdx), 'utf8');
};

const saveQueueToFile = (partyIdx: number): void => {
    const party = partyIdx === undefined ? "all" : String(partyIdx);
    const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`);
    const data = {
        queue: txQueue,
        map: Array.from(txQueueMap.entries())
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    console.log(`Queue for party ${party} saved to ${filePath}`);
};

const loadQueueFromFile = (partyIdx: number): void => {
    const party = partyIdx === undefined ? "all" : String(partyIdx);
    const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`);
    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        txQueue.push(...data.queue);
        data.map.forEach(([key, value]: [string, TxQueueMapValue]) => {
            txQueueMap.set(key, value);
        });
        console.log(`Queue for party ${party} loaded from ${filePath}`);
    }
};

function verifyEthereumTx(obj: SignedTx): boolean {
    if (typeof obj !== 'object') throw new TypeError('Input must be an object.');
    if (!obj.sign || !obj.sign.owner || !obj.sign.sig) throw new Error('Object must contain a sign field with the following data: { owner, sig }');
    if (typeof obj.sign.owner !== 'string') throw new TypeError('Owner must be a public key represented as a hex string.');
    if (typeof obj.sign.sig !== 'string') throw new TypeError('Signature must be a valid signature represented as a hex string.');
    const {owner, sig} = obj.sign;
    const dataWithoutSign = {...obj};
    (dataWithoutSign as any).sign = undefined;
    const message = crypto.hashObj(dataWithoutSign);
    const recoveredAddress = ethersUtils.verifyMessage(message, sig);
    const recoveredShardusAddress = toShardusAddress(recoveredAddress);
    const isValid = recoveredShardusAddress.toLowerCase() === owner.toLowerCase();
    console.log('Signed Obj', obj);
    console.log('Signature verification result:');
    console.log('Is Valid:', isValid);
    console.log('message', message);
    console.log('Owner Address:', obj.sign.owner);
    console.log('Recovered Address:', recoveredAddress);
    console.log('Recovered Shardus Address:', recoveredShardusAddress);
    return isValid;
}

async function validateTokenToCoinTx(tx: ethers.providers.TransactionResponse): Promise<BridgeOutEvent | false> {
    const receipt = await provider.getTransactionReceipt(tx.hash);
    console.log("receipt", receipt);
    console.log(`Starting block: ${startingBlock}`);
    console.log(`Transaction block number: ${receipt.blockNumber}`);
    if (!addOldTxToQueue) {
        if (receipt.blockNumber < startingBlock) {
            console.log("Transaction is older than the server start block");
            return false;
        }
    }
    if (receipt.status !== 1) {
        console.log("Transaction is not successful");
        return false;
    }
    if (receipt.to?.toLowerCase() !== liberdusContractAddress.toLowerCase()) {
        console.log("Transaction is not for the Liberdus contract address");
        return false;
    }
    const bridgeInterface = new ethersUtils.Interface([
        "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)"
    ]);
    const bridgeOutLog = receipt.logs.find((log: any) => {
        try {
            if (log.address.toLowerCase() !== liberdusContractAddress.toLowerCase()) return false;
            const parsedLog = bridgeInterface.parseLog(log);
            return parsedLog.name === 'BridgedOut';
        } catch (e) {
            return false;
        }
    });
    if (!bridgeOutLog) {
        console.log("No BridgedOut event found in transaction logs");
        return false;
    }
    const parsedLog = bridgeInterface.parseLog(bridgeOutLog);
    const from = parsedLog.args.from;
    const amount = parsedLog.args.amount;
    const targetAddress = parsedLog.args.targetAddress;
    const parsedChainId = parsedLog.args.chainId.toNumber();
    console.log("BridgedOut event data:", {from, amount: amount.toString(), targetAddress, chainId: parsedChainId});
    if (parsedChainId !== chainId) {
        console.log("Transaction is for a different chain ID");
        return false;
    }
    return {
        from: from,
        targetAddress: targetAddress,
        amount: amount,
        chainId: parsedChainId,
        txId: receipt.transactionHash
    };
}

function validateCoinToTokenTx(receipt: any): { from: string, value: ethers.BigNumber, txId: string } | false {
    console.log("receipt", receipt);
    const {success, to, from, additionalInfo, type, txId, timestamp} = receipt.data;

    if (!addOldTxToQueue) {
        if (timestamp < serverStartTime) {
            console.log("Transaction is older than the server start time");
            return false;
        }
    }
    if (!success) {
        console.log("Transaction is not successful");
        return false;
    }
    if (to !== bridgeAddressInLiberdus) {
        console.log("Transaction is not for the bridge address");
        return false;
    }
    if (type !== "transfer") {
        console.log("Transaction type is not transfer");
        return false;
    }
    const transferAmountInBigInt = BigNumber.from("0x" + additionalInfo.amount.value);
    const oneEtherInBigInt = ethersUtils.parseEther("1.0");
    if (transferAmountInBigInt.lt(oneEtherInBigInt)) {
        console.log("Transaction value is less than 1 LIB");
        return false;
    }
    return {from, value: transferAmountInBigInt, txId};
}

async function keygen(m: any, delay: number): Promise<string> {
    const keygenOperationId = cryptoInitKey.slice(2, 8);
    let context = await m.gg18_keygen_client_new_context(coordinatorUrl, t, n, delay, keygenOperationId);
    context = await m.gg18_keygen_client_round1(context, delay);
    context = await m.gg18_keygen_client_round2(context, delay);
    context = await m.gg18_keygen_client_round3(context, delay);
    context = await m.gg18_keygen_client_round4(context, delay);
    const keygen_json = await m.gg18_keygen_client_round5(context, delay);
    return keygen_json;
}

async function sign(m: any, key_store: string, delay: number, digest: string): Promise<string> {
    const operationId = digest.slice(2, 8);
    console.log("Signing digest:", digest);
    console.log("Operation ID:", operationId);
    let context = await m.gg18_sign_client_new_context(
        coordinatorUrl,
        t,
        n,
        key_store,
        digest.slice(2),
        operationId,
    );
    let contextJSON = JSON.parse(context);
    if (contextJSON.party_num_int > t + 1) {
        console.log("Party number is greater than threshold + 1, returning");
        throw new Error(enoughPartyError);
    }
    console.log("our party number", contextJSON.party_num_int);

    console.log("sign round", 0)
    context = await m.gg18_sign_client_round0(context, delay);
    console.log("sign round", 1)
    context = await m.gg18_sign_client_round1(context, delay);
    console.log("sign round", 2)
    context = await m.gg18_sign_client_round2(context, delay);
    console.log("sign round", 3)
    context = await m.gg18_sign_client_round3(context, delay);
    console.log("sign round", 4)
    context = await m.gg18_sign_client_round4(context, delay);
    console.log("sign round", 5)
    context = await m.gg18_sign_client_round5(context, delay);
    console.log("sign round", 6)
    context = await m.gg18_sign_client_round6(context, delay);
    console.log("sign round", 7)
    context = await m.gg18_sign_client_round7(context, delay);
    console.log("sign round", 8)
    context = await m.gg18_sign_client_round8(context, delay);
    const sign_json = await m.gg18_sign_client_round9(context, delay);
    console.log("Signature:", sign_json);
    return sign_json;
}

async function monitorEthereumTransactions(): Promise<void> {
    try {
        console.log("Monitoring Ethereum transactions for bridgeOut calls...");
        const newestBlockNumber = await provider.getBlockNumber();
        console.log("Newest block number:", newestBlockNumber);
        if (lastCheckedBlockNumber >= newestBlockNumber) {
            console.log("This block has already been checked, skipping...", lastCheckedBlockNumber, newestBlockNumber);
            return;
        }
        for (let i = lastCheckedBlockNumber + 1; i <= newestBlockNumber; i++) {
            const block = await provider.getBlockWithTransactions(i);
            console.log("Processing block", i, block.number);
            console.log("Found block with transactions:", block.transactions.length);
            const transactions = block.transactions.filter((tx: any) =>
                tx.to && tx.to.toLowerCase() === liberdusContractAddress.toLowerCase()
            );
            console.log("Filtered transactions for Liberdus contract:", transactions.length);
            let validTransactions: BridgeOutEvent[] = [];
            if (transactions.length > 0) {
                for (const tx of transactions) {
                    if (!tx.data.startsWith('0xeca34900')) continue;
                    const validateResult = await validateTokenToCoinTx(tx);
                    if (!validateResult) continue;
                    validTransactions.push(validateResult);
                }
            }
            if (txQueue.length + validTransactions.length > txQueueSize) {
                throw new Error("Not enough space in the transaction queue");
            }
            for (const validTx of validTransactions) {
                if (txQueueMap.has(validTx.txId)) continue;
                const txData: TransactionQueueItem = {
                    receipt: validTx,
                    from: validTx.targetAddress,
                    value: validTx.amount,
                    txId: validTx.txId,
                    type: "tokenToCoin"
                }
                txQueue.push(txData);
                txQueueMap.set(validTx.txId, {
                    status: "pending",
                    from: validTx.from,
                    value: validTx.amount,
                    txId: validTx.txId
                });
                saveQueueToFile(ourParty.idx);
                if (verboseLogs) {
                    console.log("Ethereum transaction added to queue:", validTx);
                }
                sendTxDataToCoordinator(txData, block.timestamp * 1000);
            }
            lastCheckedBlockNumber = i;
        }
    } catch (error) {
        console.error("Error monitoring Ethereum transactions:", error);
    }
}

async function monitorLiberdusTransactions(): Promise<void> {
    try {
        const query = `?accountId=${bridgeAddressInLiberdus}&afterTimestamp=${lastCheckedTimestamp}&page=1`;
        const url = collectorHost + "/api/transaction" + query;
        const response = await axios.get(url);
        const {success, totalTransactions, transactions} = response.data;
        if (success && totalTransactions > 0) {
            if (transactions.length > 0) {
                transactions.forEach((receipt: any) => {
                    const validateResult = validateCoinToTokenTx(receipt);
                    console.log("validateResult", validateResult);
                    if (!validateResult) return;
                    if (txQueue.length > txQueueSize) return;
                    if (txQueueMap.has(validateResult.txId)) return;
                    const txData: TransactionQueueItem = {
                        receipt,
                        from: validateResult.from,
                        value: validateResult.value,
                        txId: validateResult.txId,
                        type: "coinToToken"
                    }
                    txQueue.push(txData);
                    txQueueMap.set(validateResult.txId, {status: "pending", ...validateResult});
                    saveQueueToFile(ourParty.idx);
                    if (verboseLogs) {
                        console.log("Liberdus transaction added to queue:", validateResult);
                    }
                    sendTxDataToCoordinator(txData, receipt.timestamp)
                });
            }
            lastCheckedTimestamp = Date.now();

        }
    } catch (e) {
        console.error("Error monitoring Liberdus transactions:", e);
    }
}

async function sendTxDataToCoordinator(txData: TransactionQueueItem, timestamp: number): Promise<void> {
    const tx: Transaction & { party: number } = {
        txId: txData.txId,
        sender: txData.from,
        value: ethersUtils.hexValue(txData.value),
        type: txData.type === "tokenToCoin" ? TransactionType.BRIDGE_OUT : TransactionType.BRIDGE_IN,
        txTimestamp: timestamp,
        status: TransactionStatus.PENDING,
        receipt: txData.receipt,
        party: ourParty.idx,
    }
    try {
        const url = `${coordinatorUrl}/transaction`;
        const response = await axios.post(url, tx);
        console.log("response", response.status)
        if (response.status !== 202 && response.status !== 200) {
            console.error("Failed to send txData to coordinator:", response.data);
            return;
        }
        if (verboseLogs) {
            console.log("Sent txData to coordinator:", response.data);
        }
    } catch (error) {
        console.error("Error sending txData to coordinator:", error);
    }
}

async function sendTxStatusToCoordinator(txId: string, status: TransactionStatus, receipt: string): Promise<void> {
    try {
        const url = `${coordinatorUrl}/transaction/status`;
        const data = { txId, status, receipt };
        const response = await axios.post(url, data);
        if (response.status !== 202 && response.status !== 200) {
            console.error("Failed to update transaction status to coordinator:", response.data);
            return;
        }
        if (verboseLogs) {
            console.log("Updated transaction status to coordinator:", response.data);
        }
    } catch (error) {
        console.error("Error updating transaction status to coordinator:", error);
    }
}


async function DKG(party: KeyShare): Promise<KeyShare> {
    if (party.res) return party;
    const partyIdx = party.idx;
    if (!generateKeystore && keystoreExists(partyIdx)) {
        party.res = loadKeystore(partyIdx);
    } else {
        let delay = Math.max(Math.random() % 500, 100);
        try {
            party.res = await keygen(gg18, delay);
            saveKeystore(partyIdx, party.res);
        } catch (e) {
            return {idx: partyIdx, res: null as any};
        }
    }
    return party;
}

async function signEthereumTransaction(item: KeyShare, tx: any, digest: string): Promise<string | null> {
    let delay = Math.max(Math.random() % 500, 100);
    const res = JSON.parse(await sign(gg18, item.res, delay, digest));
    const signature = {
        r: "0x" + res[0],
        s: "0x" + res[1],
        v: res[2],
    };
    const address = ethersUtils.recoverAddress(digest, signature);
    const publicKey = ethersUtils.recoverPublicKey(digest, signature);
    const computeAddress = ethersUtils.computeAddress(publicKey);
    const signedTx = ethersUtils.serializeTransaction(tx, signature);
    if (verboseLogs) {
        console.log("Ethereum transaction signed successfully!", {
            ...tx,
            sign: {
                owner: computeAddress,
                sig: ethersUtils.joinSignature(signature),
            }
        });
    }
    return signedTx;
}

async function signLiberdusTransaction(item: KeyShare, tx: LiberdusTx, digest: string): Promise<SignedTx | null> {
    let delay = Math.max(Math.random() % 500, 100);
    const res = JSON.parse(await sign(gg18, item.res, delay, digest));
    const signature = {
        r: "0x" + res[0],
        s: "0x" + res[1],
        v: Number(res[2]),
    };
    const serializedSignature = ethersUtils.joinSignature(signature);
    const signedTx: SignedTx = {
        ...tx,
        sign: {
            owner: tx.from,
            sig: serializedSignature,
        }
    };
    const isValid = verifyEthereumTx(signedTx);
    if (!isValid) {
        return null;
    }
    if (verboseLogs) {
        console.log("Liberdus transaction signed successfully!", signedTx);
    }
    return signedTx;
}

async function injectEthereumTx(signedTx: string | null): Promise<boolean> {
    if (!signedTx) return false;
    let txHash: string | null = null;
    try {
        // precompute tx hash from signedTx
        txHash = ethersUtils.keccak256(signedTx);
        const txResponse = await provider.sendTransaction(signedTx);
        const receipt = await txResponse.wait();
        if (receipt.status !== 1) throw new Error("Transaction failed");
        const balance = await provider.getBalance(receipt.to!);
        const senderBalance = await provider.getBalance(receipt.from);
        if (verboseLogs) {
            console.log("BridgeIn transaction sent successfully!", receipt.transactionHash);
        }
    } catch (e: any) {
        console.log("Error sending ethereum transaction:", e.message);
        // check other party injected the transaction
        if (txHash) {
            // check tx receipt from RPC
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt && receipt.status === 1) {
                console.log("Transaction already injected by another party:", txHash);
                return true;
            }
        }
        return false;
    }
    return true
}

async function injectLiberdusTx(signedTx: SignedTx | null): Promise<boolean> {
    if (!signedTx) return false;
    try {
        const body = {tx: stringify(signedTx)};
        const injectUrl = proxyServerHost + "/inject";
        const waitTime = (signedTx.timestamp ?? 0) - Date.now();
        console.log(`Waiting for ${waitTime} ms before injecting transaction...`);
        if (waitTime > 0) await sleep(waitTime);
        const res = await axios.post(injectUrl, body);
        console.log("Liberdus tx inject response:", res.data);
        // if (res.status !== 200 || res.data?.result?.success !== true) return false;
        await sleep(10000);
        // const receipt = await getLiberdusReceipt(res.data.result.txId);
        // if (!receipt?.success) throw new Error("Transaction failed");
        if (verboseLogs) {
            console.log("Bridge-out transaction sent successfully!", res.data.result.txId);
        }
    } catch (e) {
        console.log("Error sending liberdus transaction:");
        return false;
    }
    return true;
}

async function processCoinToToken(to: string, value: ethers.BigNumber, txId: string): Promise<void> {
    console.log("Processing coin to token transaction", {to, value: value.toString()});
    const senderNonce = await provider.getTransactionCount(tssSenderAddress);
    let currentGasPrice = await provider.getGasPrice();
    // make sure gas price a bit more deterministic
    if (currentGasPrice.lt(ethersUtils.parseUnits("50", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("50", "gwei");
    } else if (currentGasPrice.lt(ethersUtils.parseUnits("100", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("100", "gwei");
    } else if (currentGasPrice.lt(ethersUtils.parseUnits("150", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("150", "gwei");
    } else if (currentGasPrice.lt(ethersUtils.parseUnits("200", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("200", "gwei");
    } else if (currentGasPrice.lt(ethersUtils.parseUnits("250", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("250", "gwei");
    } else if (currentGasPrice.lt(ethersUtils.parseUnits("300", "gwei"))) {
        currentGasPrice = ethersUtils.parseUnits("300", "gwei");
    }
    const fixedGasPrice = ethersUtils.parseUnits("160", "gwei");
    const bridgeInterface = new ethersUtils.Interface([
        "function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public"
    ]);
    const txIdBytes32 = '0x' + txId;
    const data = bridgeInterface.encodeFunctionData("bridgeIn", [
        "0x" + to.slice(0, 40),
        value,
        chainId,
        txIdBytes32
    ]);
    const tx = {
        to: liberdusContractAddress,
        value: 0,
        data,
        nonce: senderNonce,
        gasLimit: 200000,
        gasPrice: currentGasPrice,
        chainId: chainId,
    };
    console.log("eth tx to sign", tx)
    const unsignedTx = ethersUtils.serializeTransaction(tx);
    let digest = ethersUtils.keccak256(unsignedTx);
    let keyShare = await DKG(ourParty);
    const signedTx = await signEthereumTransaction(keyShare, tx, digest);
    await injectEthereumTx(signedTx);
    // [TODO] Move sending tx status to coordinator in the proper place
    // precompute tx hash from signedTx
    const txHash = ethersUtils.keccak256(signedTx as string);
    sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, txHash);
}

async function processTokenToCoin(to: string, value: any, txId: string): Promise<void> {
    console.log("Processing token to coin transaction", {to, value, txId});
    // convert ethers.BigNumber to bigint
    const amountInBigInt = BigInt(value.hex ? value.hex : value._hex);
    console.log("Amount in bigint:", amountInBigInt);
    let signedTx: SignedTx | null = null;
    const tx: LiberdusTx = {
        from: toShardusAddress(tssSenderAddress),
        to: toShardusAddress(to),
        amount: amountInBigInt,
        type: "transfer",
        memo: txId,
    };
    tx.chatId = calculateChatId(tx.from, tx.to);
    const currentCycleRecord = await getLatestCycleRecord();
    let futureTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000;
    while (futureTimestamp < Date.now() + 1000 * 30) {
        futureTimestamp += 10 * 1000;
    }
    tx.timestamp = await confirmFutureTimestamp(txId, futureTimestamp);
    if (verboseLogs) {
        console.log("Current timestamp:", new Date(Date.now()));
        console.log("Future timestamp confirmed:", new Date(tx.timestamp));
        console.log("Wait time:", tx.timestamp - Date.now());
        console.log("Transaction:", tx);
    }
    const hashMessage = crypto.hashObj(tx);
    let digest = ethersUtils.hashMessage(hashMessage);
    let keyShare = await DKG(ourParty);
    signedTx = await signLiberdusTransaction(keyShare, tx, digest);
    const success = await injectLiberdusTx(signedTx);
    if (!success) {
        // throw new Error("Failed to sign and inject transaction");
    } else if (success) {
        // [TODO] Move sending tx status to coordinator in the proper place
        // Compute txId from signedTx
        const signedTxId = crypto.hashObj(signedTx as SignedTx, true);
        sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, signedTxId);
    }
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmFutureTimestamp(operationId: string, timestamp: number): Promise<number> {
    const res = await axios.post(coordinatorUrl + "/future-timestamp", {
        key: operationId,
        value: timestamp
    });
    if (res.status !== 200) {
        throw new Error("Failed to confirm future timestamp");
    }
    return res.data.timestamp
}

async function getLiberdusReceipt(txId: string): Promise<any> {
    const url = proxyServerHost + "/transaction/" + txId;
    let count = 0;
    let response: AxiosResponse | null = null;
    while (count < 10) {
        try {
            response = await axios.get(url);
            if (response && response.status === 200) break;
        } catch (e) {
        }
        count++;
        await sleep(1000);
    }
    if (!response) return null;
    return response.data.transaction;
}

async function getLiberdusAccountBalance(address: string): Promise<string | null> {
    const url = proxyServerHost + "/account/" + address;
    let count = 0;
    let response: AxiosResponse | null = null;
    let balance: string | null = null;
    while (count < 10) {
        try {
            response = await axios.get(url);
            if (response && response.status === 200) {
                balance = ethersUtils.formatEther("0x" + response.data.account?.data?.balance?.value);
                break;
            }
        } catch (e) {
        }
        count++;
        await sleep(1000);
    }
    if (!response || response.data == null || response.data.account == null) return null;
    return balance;
}

async function getLatestCycleRecord(): Promise<any> {
    const url = collectorHost + "/api/cycleinfo?count=1";
    const response = await axios.get(url);
    const {success, cycles} = response.data;
    if (success) return cycles[0].cycleRecord;
    return null;
}

function calculateChatId(from: string, to: string): string {
    return crypto.hash([from, to].sort((a, b) => a.localeCompare(b)).join(''));
}

function toShardusAddress(addressStr: string): string {
    return addressStr.slice(2).toLowerCase() + '0'.repeat(24);
}

function subscribeEthereumTransaction() {
    const bridgeInterface = new ethersUtils.Interface([
        "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)"
    ]);
    const contract = new ethers.Contract(liberdusContractAddress, bridgeInterface, wsProvider);

    contract.on("BridgedOut", async (from: string, amount: ethers.BigNumber, targetAddress: string, parsedChainId: ethers.BigNumber, timestamp: ethers.BigNumber, event: any) => {
        try {
            if (verboseLogs) {
                console.log("BridgedOut event received:", {
                    from,
                    amount: amount.toString(),
                    targetAddress,
                    chainId: parsedChainId.toString(),
                    txHash: event.transactionHash
                });
            }
            // Validate chainId
            if (parsedChainId.toNumber() !== chainId) {
                if (verboseLogs) console.log("Event chainId does not match , skipping");
                return;
            }
            // Validate block number if needed
            if (!addOldTxToQueue && event.blockNumber < startingBlock) {
                if (verboseLogs) console.log("Event is older than the server start block, skipping");
                return;
            }
            // Check if already in queue
            if (txQueueMap.has(event.transactionHash)) return;
            // Add to queue
            const validTx: BridgeOutEvent = {
                from,
                amount,
                targetAddress,
                chainId: parsedChainId.toNumber(),
                txId: event.transactionHash
            };
            const txData: TransactionQueueItem = {
                receipt: validTx,
                from: validTx.targetAddress,
                value: validTx.amount,
                txId: validTx.txId,
                type: "tokenToCoin"
            }
            txQueue.push(txData)
            txQueueMap.set(validTx.txId, {
                status: "pending",
                from: validTx.from,
                value: validTx.amount,
                txId: validTx.txId
            });
            saveQueueToFile(ourParty.idx);
            if (verboseLogs) {
                console.log("BridgedOut event added to queue:", validTx);
            }
            sendTxDataToCoordinator(txData, timestamp.toNumber() * 1000);
        } catch (err) {
            console.error("Error processing BridgedOut event:", err);
        }
    });
    if (verboseLogs) {
        console.log("Subscribed to BridgedOut events via eth_subscribe");
    }
}

async function main(): Promise<void> {
    if (generateKeystore) {
        // generate new key share
        const partyIdx = ourParty.idx;
        const delay = Math.max(Math.random() % 500, 100);
        try {
            ourParty.res = await keygen(gg18, delay);
            saveKeystore(partyIdx, ourParty.res);
            // sign a test message
            const testDigest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test message"));
            let res = JSON.parse(await sign(gg18, ourParty.res, delay, testDigest))
            const signature = {
                r: "0x" + res[0],
                s: "0x" + res[1],
                v: res[2],
            };
            const publicKey = ethersUtils.recoverPublicKey(testDigest, signature);
            const address = ethersUtils.computeAddress(publicKey);
            console.log("Public key and address of TSS account:", publicKey, address);
            // write public key and address to a json file with the party index
            const publicKeyFilePath = path.join(KEYSTORE_DIR, `public_key_party_${partyIdx}.json`);
            const publicKeyData = {
                publicKey: publicKey,
                address: address
            };
            fs.writeFileSync(publicKeyFilePath, JSON.stringify(publicKeyData, null, 2));
            process.exit(0)
        } catch (e) {
            console.error("Error generating key share:", e);
            return;
        }
    }
    // set starting block number
    startingBlock = await provider.getBlockNumber();
    if (loadExistingQueue) loadQueueFromFile(ourParty.idx);
    setInterval(async () => {
        try {
            await monitorLiberdusTransactions();
        } catch (error) {
        }
    }, 10000);

    // setInterval(async () => {
    //     try {
    //         await monitorEthereumTransactions();
    //     } catch (error) {
    //     }
    // }, 10000);

    setInterval(async () => {
        // console.log(`Queue length: ${txQueue.length}`, processing);
        if (txQueue.length > 0 && !processing) {
            const validTx = txQueue.shift()!;
            txQueueMap.set(validTx.txId, {status: "processing", ...validTx});
            saveQueueToFile(ourParty.idx);
            try {
                processing = true;
                let promises = [];
                if (validTx.type === "coinToToken") {
                    promises.push(processCoinToToken(validTx.from, validTx.value as ethers.BigNumber, validTx.txId))
                } else if (validTx.type === "tokenToCoin") {
                    console.log("Processing token to coin transaction", validTx);
                    promises.push(processTokenToCoin(validTx.from, validTx.value as ethers.BigNumber, validTx.txId))
                }
                const threeMinPromise = 1000 * 60 * 1.5;
                const failPromise = new Promise((resolve, reject) => {
                    setTimeout(() => {
                        reject(new Error("Transaction processing timed out"));
                    }, threeMinPromise);
                })
                promises.push(failPromise);
                // wait for either the transaction to be processed or the timeout
                await Promise.race(promises);
                // if the transaction was processed successfully, remove it from the queue
                txQueueMap.set(validTx.txId, {
                    status: "completed",
                    from: validTx.from,
                    value: validTx.value,
                    txId: validTx.txId
                });
                saveQueueToFile(ourParty.idx);
                console.log("Transaction processed successfully:", validTx);
            } catch (error: any) {
                if (error.message === enoughPartyError) {
                    // todo: check if the tx is actually signed by enough parties and injected properly
                    console.log("Transaction already signed by enough parties, skipping:", validTx);
                    txQueueMap.set(validTx.txId, {
                        status: "completed",
                        from: validTx.from,
                        value: validTx.value,
                        txId: validTx.txId
                    });
                    saveQueueToFile(ourParty.idx);
                    processing = false;
                    return;
                }
                // todo: find better way to handle errors
                // txQueue.push(validTx);
                txQueueMap.set(validTx.txId, {
                    status: "failed",
                    from: validTx.from,
                    value: validTx.value,
                    txId: validTx.txId
                });
                saveQueueToFile(ourParty.idx);
                console.error("Error processing transaction:", error);
                // console.log("Transaction re-added to queue:", validTx);
            }
            processing = false;
        }
    }, txQueueInterval);

    subscribeEthereumTransaction();
    monitorLiberdusTransactions();
    // monitorEthereumTransactions();
}

main().then(() => {
}).catch((error) => {
});