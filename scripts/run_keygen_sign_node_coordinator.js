const gg18 = require("../pkg");
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const useExistingKeystore = true;;

var items = [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }];

let t = 3;
let n = 4;
let addr = "http://127.0.0.1:8000";
const operationId = Math.floor(Math.random() * 1000000).toString();;

// Directory to store keystore files
const KEYSTORE_DIR = path.join(__dirname, "../keystores");

// Ensure keystore directory exists
if (!fs.existsSync(KEYSTORE_DIR)) {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
}

const delay_ms = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Hello Eigen"));

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

async function keygen(m, delay) {
  let context = await m.gg18_keygen_client_new_context(addr, t, n, delay, operationId);
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

async function sign(m, key_store, delay) {
  let context = await m.gg18_sign_client_new_context(
    addr,
    t,
    n,
    key_store,
    digest.slice(2),
    operationId
  );
  console.log("sign new context: ", context);
  context = await m.gg18_sign_client_round0(context, delay);
  console.log("sign round0: ");
  context = await m.gg18_sign_client_round1(context, delay);
  console.log("sign round1: ");
  context = await m.gg18_sign_client_round2(context, delay);
  console.log("sign round2: ");
  context = await m.gg18_sign_client_round3(context, delay);
  console.log("sign round3: ");
  context = await m.gg18_sign_client_round4(context, delay);
  console.log("sign round4: ");
  context = await m.gg18_sign_client_round5(context, delay);
  console.log("sign round5: ");
  context = await m.gg18_sign_client_round6(context, delay);
  console.log("sign round6: ");
  context = await m.gg18_sign_client_round7(context, delay);
  console.log("sign round7: ");
  context = await m.gg18_sign_client_round8(context, delay);
  console.log("sign round8: ");
  sign_json = await m.gg18_sign_client_round9(context, delay);
  console.log("keysign json: ", sign_json);
  return sign_json;
}

async function main() {
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
          return { idx: partyIdx, res: null };
        }
      }
      
      return { idx: partyIdx, res: res };
    })
  );

  console.log("sign items: ", results);
  await Promise.all(
    results.map(async (item) => {
      if (item.idx < t + 1) {
        let delay = Math.max(Math.random() % 500, 100);
        //select random signer
        res = JSON.parse(await sign(gg18, item.res, delay));
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
      }
    })
  );
}

main().then(() => {
  console.log("Done");
});
