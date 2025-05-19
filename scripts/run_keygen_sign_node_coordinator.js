const gg18 = require("../pkg");
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// configuration
const useExistingKeystore = true;
let params = loadParams();
let t = params.threshold;
let n = params.parties;
const coordinatorUrl = "http://127.0.0.1:8000";
const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
const operationId = Math.floor(Math.random() * 1000000).toString();
const parties = Array.from({length: n}, (_, i) => ({idx: i}));
const senderAddress = "0x343AB7d3EEF70f7299781a5Fc007935A2CA663d9"
const bridgeAddress = "eacb10fb8e61b0f382c0b3f25b6ffcdb985ea5af000000000000000000000000";
let lastCheckedTimestamp = 1

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

function validateCoinToTokenTx(receipt) {
  const {success, to, from, additionalInfo, type, txId} = receipt.data;
  if (!success) {
    console.log("Transaction is not successful");
    return false;
  }
  if (to !== bridgeAddress) {
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
  let context = await m.gg18_keygen_client_new_context(coordinatorUrl, t, n, delay, operationId);
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
    operationId
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
  // console.log("sign round8: ");
  sign_json = await m.gg18_sign_client_round9(context, delay);
  // console.log("keysign json: ", sign_json);
  return sign_json;
}

async function monitorNewTransactions() {
  console.log("Monitoring new transactions...");
  // Online flow - existing implementation
  const collectorUrl = "http://dev.liberdus.com:6001/api/transaction";
  const query = `?accountId=${bridgeAddress}&beforeTimestamp=${lastCheckedTimestamp}&page=1`;
  const url = collectorUrl + query;

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
        txQueue.push({receipt, from: validateResult.from, value: validateResult.value, txId: validateResult.txId, type: "coinToToken"});
        txQueueMap.set(validateResult.txId, {status: "pending"});
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

async function signTransaction(item, tx, digest) {
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

async function injectTransaction(signedTx) {
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

async function processCoinToToken(to, value) {
  // Generate a random recipient address and construct transaction
  const senderNonce = await provider.getTransactionCount(senderAddress);
  const senderBalance = await provider.getBalance(senderAddress);
  console.log("Sender address:", senderAddress);
  console.log("Sender balance:", ethers.utils.formatEther(senderBalance));
  console.log("Sender nonce:", senderNonce);
  console.log("recipient address:", to);
  const tx = {
    to: "0x" + to.slice(0, 40),
    value,
    nonce: senderNonce,
    gasLimit: 21000,
    gasPrice: ethers.utils.parseUnits("10", "gwei"),
    chainId: 31337, // Hardhat local network
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
        const signedTx = await signTransaction(item, tx, digest);
        await injectTransaction(signedTx);
      }
    })
  );
}


// run the monitor every 30 seconds
setInterval(async () => {
  try {
    await monitorNewTransactions();
  } catch (error) {
    console.error("Error monitoring new transactions:", error);
  }
}, 10000);

// Process the transaction queue every 10 seconds
setInterval(async () => {
  if (txQueue.length > 0 && !processing) {
    const tx = txQueue.shift(); // Get the first transaction in the queue
    txQueueMap.set(tx.id, {status: "processing"}); // Update the transaction status
    console.log("Processing transaction:", tx);
    try {
      // Process the transaction here
      processing = true;
      if (tx.type === "coinToToken") {
        await processCoinToToken(tx.from, tx.value)
      }
      // After processing, update the transaction status
      txQueueMap.set(tx.id, {status: "completed"}); // be careful about memory leak
    } catch (error) {
      console.error("Error processing transaction:", error);
      // add the transaction back to the queue
      txQueue.push(tx);
      txQueueMap.set(tx.id, {status: "pending"}); // Reset the transaction status
    }
    processing = false;
  }
}, txQueueInterval);

monitorNewTransactions().then(() => {
  console.log("Monitoring started...");
}).catch((error) => {
  console.error("Error starting monitoring:", error);
})
