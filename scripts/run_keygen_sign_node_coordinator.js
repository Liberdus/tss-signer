const gg18 = require("../pkg");
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require('@shardus/crypto-utils')
const {stringify, parse} = require('../external/stringify-shardus');

// configuration
const useExistingKeystore = true;
let params = loadParams();
let t = params.threshold;
let n = params.parties;
const coordinatorUrl = "http://127.0.0.1:8000";
const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
const collectorHost = "http://dev.liberdus.com:6001";
const proxyServerHost = "https://dev.liberdus.com:3030";
const parties = Array.from({length: n}, (_, i) => ({idx: i}));

const tssSenderAddress = "0x343AB7d3EEF70f7299781a5Fc007935A2CA663d9"
const bridgeAddressInLiberdus = "eacb10fb8e61b0f382c0b3f25b6ffcdb985ea5af000000000000000000000000"; // 0xeacb10fb8e61b0f382c0b3f25b6ffcdb985ea5af
const liberdusContractAddress = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";

let lastCheckedTimestamp = 1
let lastCheckedBlockNumber = 0

const cryptoInitKey = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
crypto.init(cryptoInitKey)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

const enableShardusCryptoAuth = process.env.ENABLE_SHARDUS_CRYPTO_AUTH === 'true'
const signerKeyStoreDir = path.join(__dirname, '../keystores')
const signerKeyPairFilePathFromEnv = (process.env.TSS_SIGNER_KEYPAIR_FILE || '').trim()
const signerPartyIdx = parseInt((process.env.TSS_PARTY_IDX || process.argv[2] || '1').toString(), 10)

function isHexWithLength(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-fA-F]+$/.test(value)
}

function loadSignerKeyPairFromFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const publicKey = typeof parsed.publicKey === 'string' ? parsed.publicKey.trim() : ''
    const secretKey = typeof parsed.secretKey === 'string' ? parsed.secretKey.trim() : ''
    if (
      isHexWithLength(publicKey, 64) &&
      isHexWithLength(secretKey, 128)
    ) {
      return {
        publicKey,
        secretKey,
      }
    }
    console.error(
      `[auth] Invalid signer keyPair format in ${filePath}: expected publicKey=64 hex and secretKey=128 hex`
    )
  } catch (error) {
    console.error(`[auth] Failed to read signer keyPair file ${filePath}:`, error)
  }
  return null
}

function resolveSignerKeyPairFilePath(partyIdx) {
  if (signerKeyPairFilePathFromEnv) return signerKeyPairFilePathFromEnv
  return path.join(signerKeyStoreDir, `tss-signer-keypair_party_${partyIdx}.json`)
}

function ensureSignerKeyPairTemplate(filePath) {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        publicKey: '',
        secretKey: '',
      },
      null,
      2
    ) + '\n'
  )
  console.warn(`[auth] Created missing signer keyPair template at ${filePath}`)
}

if (enableShardusCryptoAuth) {
  if (typeof gg18.gg18_shardus_crypto_init !== 'function' || typeof gg18.gg18_shardus_crypto_keys !== 'function') {
    throw new Error(
      '[auth] ENABLE_SHARDUS_CRYPTO_AUTH is true but gg18 Shardus Crypto exports are unavailable'
    )
  }

  const shardusCryptoHashKey = (process.env.SHARDUS_CRYPTO_HASH_KEY || '').trim()
  if (!shardusCryptoHashKey) {
    throw new Error('[auth] SHARDUS_CRYPTO_HASH_KEY is required when ENABLE_SHARDUS_CRYPTO_AUTH=true')
  }

  const signerKeyPairFilePath = resolveSignerKeyPairFilePath(signerPartyIdx)
  const fileKeyPair = loadSignerKeyPairFromFile(signerKeyPairFilePath)
  const signerPublicKey =
    (process.env.TSS_SIGNER_PUB_KEY || '').trim() || (fileKeyPair && fileKeyPair.publicKey) || ''
  const signerSecretKey =
    (process.env.TSS_SIGNER_SEC_KEY || '').trim() || (fileKeyPair && fileKeyPair.secretKey) || ''

  if (!signerPublicKey || !signerSecretKey) {
    if (!signerKeyPairFilePathFromEnv) {
      ensureSignerKeyPairTemplate(signerKeyPairFilePath)
    }
    throw new Error(
      `[auth] TSS signer keyPair is required when ENABLE_SHARDUS_CRYPTO_AUTH=true (set TSS_SIGNER_PUB_KEY/TSS_SIGNER_SEC_KEY or fill ${signerKeyPairFilePath})`
    )
  }
  if (!isHexWithLength(signerPublicKey, 64) || !isHexWithLength(signerSecretKey, 128)) {
    throw new Error(
      '[auth] Invalid TSS signer keyPair format: expected TSS_SIGNER_PUB_KEY=64 hex and TSS_SIGNER_SEC_KEY=128 hex'
    )
  }

  gg18.gg18_shardus_crypto_init(shardusCryptoHashKey)
  gg18.gg18_shardus_crypto_keys(signerPublicKey, signerSecretKey)
  console.log('[auth] gg18 Shardus Crypto request signing enabled for coordinator calls')
} else {
  console.log('[auth] gg18 Shardus Crypto request signing disabled (local development mode)')
}

// Directory to store keystore files
const KEYSTORE_DIR = path.join(__dirname, "../keystores");

// Ensure keystore directory exists
if (!fs.existsSync(KEYSTORE_DIR)) {
  fs.mkdirSync(KEYSTORE_DIR, {recursive: true});
}

// Implement a queue to manage txs to be signed
const txQueue = [];
const txQueueMap = new Map(); // Map to track transaction IDs and their status
const txQueueSize = 10; // Maximum number of transactions to process at once
const txQueueInterval = 10000; // Interval between processing transactions in milliseconds
let processing = false;

const delay_ms = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadParams() {
  const data = fs.readFileSync(path.join(__dirname, '../', 'params.json'), 'utf8');
  return JSON.parse(data)
}

// Get keystore filename for a party
const getKeystoreFilePath = (partyIdx) => {
  return path.join(KEYSTORE_DIR, `keystore_party_${partyIdx}.json`);
};

// Check if keystore file exists for a party
const keystoreExists = (partyIdx) => {
  return fs.existsSync(getKeystoreFilePath(partyIdx));
};

// Save keystore to file
const saveKeystore = (partyIdx, keystore) => {
  fs.writeFileSync(getKeystoreFilePath(partyIdx), keystore);
  console.log(`Keystore for party ${partyIdx} saved to ${getKeystoreFilePath(partyIdx)}`);
};

// Load keystore from file
const loadKeystore = (partyIdx) => {
  return fs.readFileSync(getKeystoreFilePath(partyIdx), 'utf8');
};

// store Queue and Map in JSON file for each party
const saveQueueToFile = (party) => {
  const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`);
  const data = {
    queue: txQueue,
    map: Array.from(txQueueMap.entries())
  };
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`Queue for party ${party} saved to ${filePath}`);
}

// load Queue and Map from JSON file for each party
const loadQueueFromFile = (party) => {
  const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`);
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    txQueue.push(...data.queue);
    data.map.forEach(([key, value]) => {
      txQueueMap.set(key, value);
    });
    console.log(`Queue for party ${party} loaded from ${filePath}`);
  }
}

function verifyEthereumTx(obj) {
  if (typeof obj !== 'object') {
    throw new TypeError('Input must be an object.')
  }
  if (!obj.sign || !obj.sign.owner || !obj.sign.sig) {
    throw new Error('Object must contain a sign field with the following data: { owner, sig }')
  }
  if (typeof obj.sign.owner !== 'string') {
    throw new TypeError('Owner must be a public key represented as a hex string.')
  }
  if (typeof obj.sign.sig !== 'string') {
    throw new TypeError('Signature must be a valid signature represented as a hex string.')
  }
  const {owner, sig} = obj.sign
  const dataWithoutSign = Object.assign({}, obj)
  delete dataWithoutSign.sign
  const message = crypto.hashObj(dataWithoutSign)

  const recoveredAddress = ethers.utils.verifyMessage(message, sig)
  const recoveredShardusAddress = toShardusAddress(recoveredAddress)
  const isValid = recoveredShardusAddress.toLowerCase() === owner.toLowerCase()

  console.log('Signed Obj', obj)
  console.log('Signature verification result:')
  console.log('Is Valid:', isValid)
  console.log('message', message)
  console.log('Owner Address:', obj.sign.owner)
  console.log('Recovered Address:', recoveredAddress)
  console.log('Recovered Shardus Address:', recoveredShardusAddress)
  return isValid
}

// validate ethers to coin transaction
async function validateTokenToCoinTx(tx) {
  // Get transaction receipt to access logs
  const receipt = await provider.getTransactionReceipt(tx.hash);
  console.log("receipt", receipt);

  if (receipt.status !== 1) {
    console.log("Transaction is not successful");
    return false;
  }

  if (receipt.to.toLowerCase() !== liberdusContractAddress.toLowerCase()) {
    console.log("Transaction is not for the Liberdus contract address");
    return false;
  }

  // Create interface to parse the BridgedOut event
  const bridgeInterface = new ethers.utils.Interface([
    "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)"
  ]);

  // Find BridgedOut event in the logs
  const bridgeOutLog = receipt.logs.find(log => {
    try {
      // Check if the log is from our contract
      if (log.address.toLowerCase() !== liberdusContractAddress.toLowerCase()) return false;

      // Try to parse the log as a BridgedOut event
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

  // Parse the event data
  const parsedLog = bridgeInterface.parseLog(bridgeOutLog);
  const from = parsedLog.args.from;
  const amount = parsedLog.args.amount;
  const targetAddress = parsedLog.args.targetAddress;
  const chainId = parsedLog.args.chainId.toNumber();

  console.log("BridgedOut event data:", {
    from,
    amount: amount.toString(),
    targetAddress,
    chainId
  });

  // Check if chain ID matches our expected chain ID
  if (chainId !== 31337) {
    console.log("Transaction is for a different chain ID");
    return false;
  }

  return {
    from: from,
    targetAddress: targetAddress,
    value: amount,
    txId: receipt.transactionHash
  };
}

function validateCoinToTokenTx(receipt) {
  const {success, to, from, additionalInfo, type, txId} = receipt.data;
  if (!success) {
    console.log("Transaction is not successful");
    return false;
  }
  if (to !== bridgeAddressInLiberdus) {
    console.log("Transaction is not for the bridge address");
    return false;
  }
  // check receipt type to be "transfer"
  if (type !== "transfer") {
    console.log("Transaction type is not transfer");
    return false;
  }
  // check if value is less than 1 LIB
  // ethers.bigNumber from a hex string
  const transferAmountInBigInt = ethers.BigNumber.from("0x" + additionalInfo.amount.value);
  const oneEtherInBigInt = ethers.utils.parseEther("1.0");
  if (transferAmountInBigInt.lt(oneEtherInBigInt)) {
    console.log("Transaction value is less than 1 LIB");
    return false;
  }
  return {from, value: transferAmountInBigInt, txId};
}

async function keygen(m, delay) {
  // we just need to run this once
  const keygenOperationId = cryptoInitKey.slice(2, 8);
  let context = await m.gg18_keygen_client_new_context(coordinatorUrl, t, n, delay, keygenOperationId);
  console.log("keygen new context: ");
  context = await m.gg18_keygen_client_round1(context, delay);
  console.log("keygen round1:");
  context = await m.gg18_keygen_client_round2(context, delay);
  console.log("keygen round2: ");
  context = await m.gg18_keygen_client_round3(context, delay);
  console.log("keygen round3: ");
  context = await m.gg18_keygen_client_round4(context, delay);
  console.log("keygen round4: ");
  keygen_json = await m.gg18_keygen_client_round5(context, delay);
  // console.log("keygen json: ", keygen_json);
  // console.log("keygen context: ", context);
  return keygen_json;
}

async function sign(m, key_store, delay, digest) {
  let context = await m.gg18_sign_client_new_context(
    coordinatorUrl,
    t,
    n,
    key_store,
    digest.slice(2),
    // first 4 bytes of the digest
    digest.slice(2, 10),
  );
  // console.log("sign new context: ", context);
  context = await m.gg18_sign_client_round0(context, delay);
  // console.log("sign round0: ");
  context = await m.gg18_sign_client_round1(context, delay);
  // console.log("sign round1: ");
  context = await m.gg18_sign_client_round2(context, delay);
  // console.log("sign round2: ");
  context = await m.gg18_sign_client_round3(context, delay);
  // console.log("sign round3: ");
  context = await m.gg18_sign_client_round4(context, delay);
  // console.log("sign round4: ");
  context = await m.gg18_sign_client_round5(context, delay);
  // console.log("sign round5: ");
  context = await m.gg18_sign_client_round6(context, delay);
  // console.log("sign round6: ");
  context = await m.gg18_sign_client_round7(context, delay);
  // console.log("sign round7: ");
  context = await m.gg18_sign_client_round8(context, delay);
  console.log("sign round8: ");
  sign_json = await m.gg18_sign_client_round9(context, delay);
  console.log("keysign json: ", sign_json);
  return sign_json;
}


async function monitorEthereumTransactions() {
  try {
    console.log("Monitoring Ethereum transactions for bridgeOut calls...");
    const newestBlockNumber = await provider.getBlockNumber();
    console.log("Newest block number:", newestBlockNumber);

    if (lastCheckedBlockNumber >= newestBlockNumber) {
      console.log("This block has already been checked, skipping...", lastCheckedBlockNumber, newestBlockNumber);
      return;
    }

    // Iterate through the new blocks and get the transactions
    for (let i = lastCheckedBlockNumber + 1; i <= newestBlockNumber; i++) {
      console.log("Checking txs from block number:", i);
      const block = await provider.getBlockWithTransactions(i);

      // Filter transactions calling the Liberdus contract
      const transactions = block.transactions.filter((tx) =>
        tx.to && tx.to.toLowerCase() === liberdusContractAddress.toLowerCase()
      );

      let validTransactions = [];

      if (transactions.length > 0) {
        for (const tx of transactions) {
          // Check if this is a bridgeOut call by examining the function signature
          // bridgeOut function signature: 0xeca34900
          if (!tx.data.startsWith('0xeca34900')) {
            continue;
          }

          const validateResult = await validateTokenToCoinTx(tx);
          if (!validateResult) {
            console.log("Transaction is not valid, skipping...");
            continue;
          }

          validTransactions.push(validateResult);
        }

        console.log("Valid bridge out transactions:", validTransactions);
      }

      if (txQueue.length + validTransactions.length > txQueueSize) {
        throw new Error("Not enough space in the transaction queue");
      }

      for (const validTx of validTransactions) {
        if (txQueueMap.has(validTx.txId)) {
          console.log("Transaction already in queue, skipping...", validTx.txId);
          continue;
        }

        txQueue.push({
          receipt: validTx,
          from: validTx.targetAddress, // This is the target address for the token on the other chain
          value: validTx.value,
          txId: validTx.txId,
          type: "tokenToCoin"
        });

        txQueueMap.set(validTx.txId, {status: "pending", ...validTx});
        saveQueueToFile("all");
        console.log("Transaction added to queue:", validTx);
      }

      lastCheckedBlockNumber = i;
    }
  } catch (error) {
    console.error("Error monitoring Ethereum transactions:", error);
  }
}

async function monitorLiberdusTransactions() {
  console.log("Monitoring new liberdus transactions...");
  const query = `?accountId=${bridgeAddressInLiberdus}&afterTimestamp=${lastCheckedTimestamp}&page=1`;
  const url = collectorHost + "/api/transaction" + query;

  const response = await axios.get(url)
  const {success, totalTransactions, transactions} = response.data;
  if (success && totalTransactions > 0) {
    console.log("New transactions found:", transactions.length);
    if (transactions.length > 0) {
      transactions.forEach((receipt) => {
        // console.log("Transaction:", receipt);
        const validateResult = validateCoinToTokenTx(receipt);
        if (!validateResult) {
          console.log("Transaction is not valid, skipping...");
          return;
        }

        if (txQueue.length > txQueueSize) {
          console.log("Transaction queue is full, waiting for processing...");
          return;
        }
        if (txQueueMap.has(validateResult.txId)) {
          console.log("Transaction already in queue, skipping...");
          return;
        }
        txQueue.push({
          receipt,
          from: validateResult.from,
          value: validateResult.value,
          txId: validateResult.txId,
          type: "coinToToken"
        });
        txQueueMap.set(validateResult.txId, {status: "pending", ...validateResult});
        saveQueueToFile("all")
        console.log("Transaction added to queue:", receipt);
      });
    }
  }
  lastCheckedTimestamp = Date.now()
  console.log("Last checked timestamp:", lastCheckedTimestamp);
}

// distribute key generation
async function DKG(items) {
  var results = await Promise.all(
    items.map(async (item) => {
      const partyIdx = item.idx;
      let res;

      // Check if keystore already exists for this party
      if (useExistingKeystore && keystoreExists(partyIdx)) {
        console.log(`Using existing keystore for party ${partyIdx}`);
        res = loadKeystore(partyIdx);
      } else {
        // Generate new keystore
        console.log(`Generating new keystore for party ${partyIdx}`);
        let delay = Math.max(Math.random() % 500, 100);
        try {
          res = await keygen(gg18, delay);
          // Save the keystore to file
          saveKeystore(partyIdx, res);
        } catch (e) {
          console.log(`Keygen error for party ${partyIdx}:`, e);
          return {idx: partyIdx, res: null};
        }
      }

      return {idx: partyIdx, res: res};
    })
  );
  return results;
}

async function signEthereumTransaction(item, tx, digest) {
  let signedTx = null
  let delay = Math.max(Math.random() % 500, 100);
  console.log(`Signing transaction with party ${item.idx}`);
  //select random signer
  res = JSON.parse(await sign(gg18, item.res, delay, digest));
  console.log("Sign result: ", res);
  // recover the address
  console.log("digest", digest);
  const signature = {
    r: "0x" + res[0],
    s: "0x" + res[1],
    v: res[2],
  };
  let address = ethers.utils.recoverAddress(digest, signature);
  const publicKey = ethers.utils.recoverPublicKey(digest, signature);
  console.log("Recovered Public Key:", publicKey);
  console.log("recover address by etherjs", address);

  // Compute the Ethereum address
  const computeAddress = ethers.utils.computeAddress(publicKey);

  console.log("computed Ethereum Address:", computeAddress);
  // Serialize and output the signed transaction
  signedTx = ethers.utils.serializeTransaction(tx, signature);
  console.log("Signed transaction:", signedTx);
  // readable signed transaction
  const readableSignedTx = ethers.utils.parseTransaction(signedTx);
  console.log("Readable signed transaction:", readableSignedTx);
  return signedTx;
}


async function signLiberdusTransaction(item, tx, digest) {
  let signedTx = null
  let delay = Math.max(Math.random() % 500, 100);
  console.log(`Signing transaction with party ${item.idx}`);
  //select random signer
  res = JSON.parse(await sign(gg18, item.res, delay, digest));
  console.log("Sign result: ", res);
  // recover the address
  console.log("digest", digest);
  const signature = {
    r: "0x" + res[0],
    s: "0x" + res[1],
    v: Number(res[2]),
  };
  console.log("unjoined signature", signature);
  // serialize signature
  const serializedSignature = ethers.utils.joinSignature(signature);
  let address = ethers.utils.recoverAddress(digest, signature);
  const publicKey = ethers.utils.recoverPublicKey(digest, signature);
  const computeAddress = ethers.utils.computeAddress(publicKey);

  console.log("Signature:", serializedSignature);
  console.log("Recovered Public Key:", publicKey);
  console.log("recover address by etherjs", address);
  console.log("computed Ethereum Address:", computeAddress);
  // Serialize and output the signed transaction
  signedTx = {
    ...tx,
    sign: {
      owner: tx.from,
      sig: serializedSignature,
    }
  }
  console.log("Signed liberdus transaction:", signedTx);
  const isValid = verifyEthereumTx(signedTx)
  if (!isValid) {
    console.log("Signature is not valid");
  }
  return signedTx;
}

async function injectEthereumTx(signedTx) {
  if (!signedTx) {
    return;
  }

  try {
    // inject signed tx to hardhat network
    // send signed raw transaction to eth_sendRawTransaction
    console.log("Injecting signed transaction to hardhat network", signedTx);
    const txResponse = await provider.sendTransaction(signedTx);
    console.log("Transaction hash:", txResponse.hash);
    // Wait for the transaction to be mined
    const receipt = await txResponse.wait();
    console.log("Transaction mined in block:", receipt.blockNumber);
    console.log("Transaction receipt:", receipt);
    // Check the transaction status
    if (receipt.status === 1) {
      console.log("Transaction was successful");
    } else {
      throw new Error("Transaction failed");
    }
    const balance = await provider.getBalance(receipt.to);
    const senderBalance = await provider.getBalance(receipt.from);
    console.log("Recipient address balance:", ethers.utils.formatEther(balance));
    console.log("Sender address balance:", ethers.utils.formatEther(senderBalance));
  } catch (e) {
    console.log("Error sending transaction:", e);
  }
}

async function injectLiberdusTx(signedTx) {
  if (!signedTx) {
    return;
  }
  try {
    console.log("Injecting signed transaction to Liberdus network", signedTx);
    const body = {tx: stringify(signedTx)}
    const injectUrl = proxyServerHost + "/inject";
    console.log("Inject url:", injectUrl, body);

    const waitTime = signedTx.timestamp - Date.now()
    if (waitTime > 0) {
      console.log("Waiting for the transaction to be injected...", waitTime);
      await sleep(waitTime);
    }

    const res = await axios.post(injectUrl, body);
    if (res.status !== 200 || res.data?.result?.success !== true) {
      console.log("Error injecting transaction to Liberdus network:", res.data);
      return;
    }
    console.log("Transaction hash:", res.data.result.txId);
    // Wait for the transaction to be mined
    await sleep(6000);
    const receipt = await getLiberdusReceipt(res.data.result.txId);
    console.log("Transaction receipt:", receipt);
    // Check the transaction status
    if (receipt.success === true) {
      console.log("Transaction was successful");
    } else {
      throw new Error("Transaction failed");
    }
    const balance = await getLiberdusAccountBalance(receipt.to);
    const senderBalance = await getLiberdusAccountBalance(receipt.from);
    console.log("Recipient address balance:", balance);
    console.log("Sender address balance:", senderBalance);
  } catch (e) {
    console.log("Error sending transaction:", e);
  }
}

async function processCoinToToken(to, value, txId) {
  // Generate a random recipient address and construct transaction to call bridgeIn function
  const senderNonce = await provider.getTransactionCount(tssSenderAddress);
  const senderBalance = await provider.getBalance(tssSenderAddress);
  const currentGasPrice = await provider.getGasPrice();
  console.log("Sender address:", tssSenderAddress);
  console.log("Sender balance:", ethers.utils.formatEther(senderBalance));
  console.log("Sender nonce:", senderNonce);
  console.log("recipient address:", to);

  // Create contract interface and encode the function call
  const bridgeInterface = new ethers.utils.Interface([
    "function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public"
  ]);

  // Convert the txId to bytes32 format if it's not already
  // const txIdBytes32 = ethers.utils.hexZeroPad(
  //   txId && txId.startsWith('0x') ? txId : ethers.utils.hexlify(ethers.utils.toUtf8Bytes(txId || ethers.utils.id(Date.now().toString()))),
  //   32
  // );

  const txIdBytes32 = '0x' + txId;

  // Encode the function call with parameters
  const data = bridgeInterface.encodeFunctionData("bridgeIn", [
    "0x" + to.slice(0, 40),  // recipient address
    value,                   // amount
    31337,                   // chain ID (using Hardhat network ID)
    txIdBytes32              // transaction ID as bytes32
  ]);

  const tx = {
    to: liberdusContractAddress,  // Bridge contract address
    value: 0,                   // No ETH being sent
    data,                       // Function call data
    nonce: senderNonce,
    gasLimit: 200000,           // Increased gas limit for contract interaction
    gasPrice: currentGasPrice,
    chainId: 31337,             // Hardhat local network
  };

  console.log("Unsigned transaction:", tx);
  const unsignedTx = ethers.utils.serializeTransaction(tx);
  let digest = ethers.utils.keccak256(unsignedTx);
  console.log("Transaction hash to sign:", digest);

  let keyShares = await DKG(parties);

  // ask each party to sign the transaction and inject it asynchronously
  await Promise.all(
    keyShares.map(async (item) => {
      if (item.idx < t + 1) {
        const signedTx = await signEthereumTransaction(item, tx, digest);
        await injectEthereumTx(signedTx);
      }
    })
  );
}

async function processTokenToCoin(to, value, memo = "") {
  const tx = {
    from: toShardusAddress(tssSenderAddress),
    to: toShardusAddress(to),
    amount: BigInt(value._hex),
    type: "transfer",
    memo,
  };
  tx.chatId = calculateChatId(tx.from, tx.to);
  const currentCycleRecord = await getLatestCycleRecord();
  let futureTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000
  while (futureTimestamp < Date.now()) {
    futureTimestamp += 30 * 1000
  }
  tx.timestamp = futureTimestamp
  // since we have to pick a future timestamp, we need to wait until it is time to submit the tx
  console.log("Unsigned transaction:", tx);
  const hashMessage = crypto.hashObj(tx);
  // convert hash message string to bytes
  const hashMessageBytes = Buffer.from(hashMessage, 'hex');
  // let digest = ethers.utils.keccak256(hashMessageBytes);
  let digest = ethers.utils.hashMessage(hashMessage);
  console.log("Transaction hash to sign:", hashMessage);
  console.log("Transaction digest to sign:", digest);

  let keyShares = await DKG(parties);

  // ask each party to sign the transaction and inject it asynchronously
  await Promise.all(
    keyShares.map(async (item) => {
      if (item.idx < t + 1) {
        const signedTx = await signLiberdusTransaction(item, tx, digest);
        console.log("Waiting for the transaction to be injected...");
        await injectLiberdusTx(signedTx);
      }
    })
  );
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getLiberdusReceipt(txId) {
  const url = proxyServerHost + "/transaction/" + txId;
  let count = 0;
  let response = null;
  while (count < 10) {
    try {
      response = await axios.get(url);
      if (response.status === 200) {
        break;
      }
    } catch (e) {
      console.log("Error getting transaction receipt:", e);
    }
    count++;
    await sleep(1000);
  }
  if (!response) {
    console.log("Failed to get transaction receipt");
    return null;
  }
  return response.data.transaction;
}

async function getLiberdusAccountBalance(address) {
  const url = proxyServerHost + "/account/" + address;
  console.log("url:", url);
  let count = 0;
  let response = null;
  let balance = null;
  while (count < 10) {
    try {
      response = await axios.get(url);
      if (response.status === 200) {
        balance = ethers.utils.formatEther("0x" + response.data.account?.data?.balance?.value);
        break;
      }
    } catch (e) {
      console.log("Error getting transaction receipt:", e);
    }
    count++;
    await sleep(1000);
  }
  if (!response || response.data == null || response.data.account == null) {
    console.log("Failed to get transaction receipt");
    return null;
  }
  return balance
}

async function getLatestCycleRecord() {
  const url = collectorHost + "/api/cycleinfo?count=1";
  const response = await axios.get(url);
  const {success, cycles} = response.data;
  if (success) {
    console.log("Latest cycle record:", cycles[0]);
    return cycles[0].cycleRecord;
  } else {
    console.log("Failed to get latest cycle record");
    return null;
  }
}

function calculateChatId(from, to) {
  return crypto.hash([from, to].sort((a, b) => a.localeCompare(b)).join(''))
}

function toShardusAddress(addressStr) {
  //change this:0x665eab3be2472e83e3100b4233952a16eed20c76
  //    to this:  665eab3be2472e83e3100b4233952a16eed20c76000000000000000000000000
  return addressStr.slice(2).toLowerCase() + '0'.repeat(24)
}


async function main() {
  console.log("Starting TSS party...");
  // Load the keystore and queue from file for each party
  loadQueueFromFile("all")
  setInterval(async () => {
    try {
      await monitorLiberdusTransactions();
    } catch (error) {
      console.error("Error monitoring new transactions:", error);
    }
  }, 10000);

  setInterval(async () => {
    try {
      await monitorEthereumTransactions();
    } catch (error) {
      console.error("Error monitoring new transactions:", error);
    }
  }, 10000);
// Process the transaction queue every 10 seconds
  setInterval(async () => {
    if (txQueue.length > 0 && !processing) {
      const validTx = txQueue.shift(); // Get the first transaction in the queue
      txQueueMap.set(validTx.id, {status: "processing", ...validTx}); // Update the transaction status
      saveQueueToFile("all")
      console.log("Processing transaction:", validTx);
      try {
        // Process the transaction here
        processing = true;
        if (validTx.type === "coinToToken") {
          await processCoinToToken(validTx.from, validTx.value, validTx.txId)
        } else if (validTx.type === "tokenToCoin") {
          await processTokenToCoin(validTx.from, validTx.value, validTx.id)
        }
        // After processing, update the transaction status
        txQueueMap.set(validTx.txId, {status: "completed", ...validTx}); // be careful about memory leak
        saveQueueToFile("all")
        console.log("Successfully processed transaction:", validTx);
      } catch (error) {
        console.error("Error processing transaction:", error);
        // add the transaction back to the queue
        txQueue.push(validTx);
        txQueueMap.set(validTx.txId, {status: "pending"}); // Reset the transaction status
        saveQueueToFile("all")
        console.log("Re-adding transaction to queue:", validTx);
      }
      processing = false;
    }
  }, txQueueInterval);
  // first time to monitor new transactions
  monitorLiberdusTransactions();
  monitorEthereumTransactions();
}

main().then(() => {

}).catch((error) => {
  console.error("Error in main function:", error);
})
