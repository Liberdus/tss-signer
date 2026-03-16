#!/usr/bin/env node
const bnbTss = require('./lib/bnbTss');

function usage() {
  console.error(
    'Usage: node tss-tools/keygen.js --party <idx>=1..N --chain-id <id> [--password <value>] [--channel-id <id>] [--channel-password <value>] [--threshold <n>] [--parties <n>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--binary <path>]',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const options = {extraArgs: []};
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
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const signerRoot = bnbTss.resolveSignerRoot();
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
  const args = [
    'keygen',
    '--home',
    initialized.home,
    '--vault_name',
    initialized.vaultName,
    '--password',
    password,
    '--channel_id',
    channelId,
    '--channel_password',
    channelPassword,
    '--threshold',
    String(threshold),
    '--parties',
    String(parties),
    ...options.extraArgs,
  ];
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(binary, args, {
    cwd: tssRoot,
    env: {...process.env, TSS_PASSWORD: password},
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  const derived = bnbTss.derivePubkey({...options, signerRoot, tssRoot, format: 'all'});
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
