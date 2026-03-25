#!/usr/bin/env node
import 'dotenv/config'
import {spawnSync} from 'node:child_process'
import * as bnbTss from './lib/bnbTss'
import {resolveProjectRoot} from '../shared/utils/paths'

function usage(): never {
  console.error(
    'Usage: node tss-tools/keygen.js --party <idx>=1..N --chain-id <id> [--password <value>] [--log_level <value>] [--channel-id <id>] [--channel-password <value>] [--threshold <n>] [--parties <n>] [--peer-addrs <addr1,addr2>] [--no-local-peer-addrs] [--vault <name>] [--home-root <path>] [--home-path <path>] [--binary <path>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.KeygenOptions & {partyIdx: number; chainId: number; extraArgs: string[]; useLocalPeerAddrs: boolean} {
  const options: Partial<bnbTss.KeygenOptions> & {extraArgs: string[]; useLocalPeerAddrs: boolean} = {extraArgs: [], useLocalPeerAddrs: true};
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
        i += 1;
        break;
      case '--chain-id':
        options.chainId = Number.parseInt(value, 10);
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
      case '--threshold':
        options.threshold = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--parties':
        options.parties = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--peer-addrs':
        options.peerAddrs = value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--no-local-peer-addrs':
        options.useLocalPeerAddrs = false;
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
      case '--binary':
        options.binary = value;
        i += 1;
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
  if (!Number.isInteger(options.partyIdx) || options.partyIdx < 1 || !Number.isInteger(options.chainId)) {
    usage();
  }
  return options as bnbTss.KeygenOptions & {partyIdx: number; chainId: number; extraArgs: string[]; useLocalPeerAddrs: boolean};
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const signerRoot = resolveProjectRoot();
  const tssRoot = bnbTss.resolveTssRoot(signerRoot);
  const binary = bnbTss.resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const params = bnbTss.readParams(signerRoot);
  const initialized = bnbTss.requireInitialized({...options, signerRoot, tssRoot, binary});
  const threshold = options.threshold ?? params.threshold;
  const parties = options.parties ?? params.parties;
  const channelId = options.channelId || process.env.BNB_TSS_CHANNEL_ID;
  const channelPassword = options.channelPassword || process.env.BNB_TSS_CHANNEL_PASSWORD;
  const password = options.password || process.env.BNB_TSS_PASSWORD || process.env.TSS_PASSWORD;
  if (!channelId || !channelPassword || !password) {
    throw new Error('BNB TSS keygen requires password, channel id, and channel password');
  }
  const peerAddrs =
    options.peerAddrs ||
    (options.useLocalPeerAddrs
      ? bnbTss.deriveLocalPeerAddrs({
          chainId: options.chainId,
          parties,
          partyIdx: options.partyIdx,
        })
      : []);
  const args = bnbTss.buildKeygenArgs({
    home: initialized.home,
    vaultName: initialized.vaultName,
    password,
    logLevel: options.logLevel,
    channelId,
    channelPassword,
    threshold,
    parties,
    peerAddrs,
    extraArgs: options.extraArgs,
  });
  const result = spawnSync(binary, args, {
    cwd: tssRoot,
    env: {...process.env, TSS_PASSWORD: password},
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  const derived = bnbTss.derivePubkey({...options, signerRoot, tssRoot, format: 'all'}) as {
    compressed: string
    ethereum_address: string
    ethereum_pubkey: string
  };
  process.stdout.write(
    `${JSON.stringify({
      party: options.partyIdx,
      chainId: options.chainId,
      home: initialized.home,
      vault: initialized.vaultName,
      ...derived,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
