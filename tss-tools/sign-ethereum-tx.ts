#!/usr/bin/env node
import 'dotenv/config'
import * as fs from 'node:fs'
import {ethers} from 'ethers'
import * as bnbTss from './lib/bnbTss'
import {
  DEFAULT_SHARDUS_CRYPTO_HASH_KEY,
  deriveDeterministicChannelId,
  deriveDeterministicChannelPassword,
} from './lib/channelId'
import {normalizeTxId} from '../shared/utils/transformTxId'

const SIGN_CHANNEL_TIME_BUCKET_MS = 30 * 60 * 1000

function usage(): never {
  console.error(
    'Usage: node tss-tools/sign-ethereum-tx.js --chain-id <id> [--party <idx>=1..N] --tx-file <path> [--password <value>] [--log_level <value>] [--channel-id <id>] [--channel-password <value>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--use-default-slot-path] [--sign_discovery_timeout <value>] [-- <extra sign args...>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.SignEthereumTxOptions & {chainId: number; txFile: string; extraArgs: string[]} {
  const options: Partial<bnbTss.SignEthereumTxOptions> & {extraArgs: string[]} = {extraArgs: []};
  let partyExplicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.extraArgs = argv.slice(i + 1);
      break;
    }
    const value = argv[i + 1];
    switch (arg) {
      case '--party':
        options.partyIdx = Number.parseInt(value, 10);
        partyExplicit = true;
        i += 1;
        break;
      case '--chain-id':
        options.chainId = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--tx-file':
        options.txFile = value;
        i += 1;
        break;
      case '--password':
        options.password = value;
        i += 1;
        break;
      case '--log_level':
        options.logLevel = value;
        i += 1;
        break;
      case '--channel-id':
        options.channelId = value;
        i += 1;
        break;
      case '--channel-password':
        options.channelPassword = value;
        i += 1;
        break;
      case '--sign_discovery_timeout':
        options.signDiscoveryTimeout = value;
        i += 1;
        break;
      case '--vault':
        options.vaultName = value;
        i += 1;
        break;
      case '--home-root':
        options.homeRoot = value;
        i += 1;
        break;
      case '--home-path':
        options.homePath = value;
        i += 1;
        break;
      case '--use-default-slot-path':
        options.useDefaultSlotPath = true;
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        usage();
    }
  }
  if (!Number.isInteger(options.chainId) || !options.txFile) usage();
  if (!partyExplicit) {
    options.useDefaultSlotPath = true;
  }
  if (partyExplicit && (!Number.isInteger(options.partyIdx) || options.partyIdx < 1)) usage();
  return options as bnbTss.SignEthereumTxOptions & {chainId: number; txFile: string; extraArgs: string[]};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tx = JSON.parse(fs.readFileSync(options.txFile, 'utf8')) as ethers.TransactionLike;
  const unsignedTx = ethers.Transaction.from(tx).unsignedSerialized;
  const txHash = ethers.keccak256(unsignedTx);
  const txTimestampMs = Math.floor(Date.now() / SIGN_CHANNEL_TIME_BUCKET_MS) * SIGN_CHANNEL_TIME_BUCKET_MS;
  const channelId =
    options.channelId ||
    process.env.BNB_TSS_CHANNEL_ID ||
    deriveDeterministicChannelId(normalizeTxId(txHash), txTimestampMs);
  const channelPassword =
    options.channelPassword ||
    process.env.BNB_TSS_CHANNEL_PASSWORD ||
    deriveDeterministicChannelPassword(
      channelId,
      (process.env.SHARDUS_CRYPTO_HASH_KEY || DEFAULT_SHARDUS_CRYPTO_HASH_KEY).trim(),
    );
  const signed = await bnbTss.signEthereumTransaction({...options, tx, channelId, channelPassword});
  process.stdout.write(
    `${JSON.stringify({
      signed_tx: signed.signedTx,
      tx_hash: signed.txHash,
      digest: signed.digest,
      r: signed.r.slice(2),
      s: signed.s.slice(2),
      v: signed.v,
      ethereum_address: signed.ethereumAddress,
      public_key_ethereum: signed.publicKeyEthereum.slice(2),
      public_key_compressed: signed.publicKeyCompressed.slice(2),
    })}\n`,
  );
}

try {
  Promise.resolve(main()).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
