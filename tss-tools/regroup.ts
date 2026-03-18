#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import * as bnbTss from './lib/bnbTss'

function usage(): never {
  console.error(
    'Usage: node tss-tools/regroup.js --party <idx>=1..N --chain-id <id> [--password <value>] [--log_level <value>] [--channel-id <id>] [--channel-password <value>] [--threshold <n>] [--parties <n>] [--new-threshold <n>] [--new-parties <n>] [--is-old] [--is-new-member] [--pubkey <hex>] [--vault <name>] [--home-root <path>] [--binary <path>] [-- <extra regroup args...>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.RegroupOptions & {partyIdx: number; chainId: number; extraArgs: string[]} {
  const options: Partial<bnbTss.RegroupOptions> & {extraArgs: string[]} = {extraArgs: []};
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
      case '--new-threshold':
        options.newThreshold = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--new-parties':
        options.newParties = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--pubkey':
        options.pubkey = value;
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
      case '--binary':
        options.binary = value;
        i += 1;
        break;
      case '--is-old':
        options.isOld = true;
        break;
      case '--is-new-member':
        options.isNewMember = true;
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
  return options as bnbTss.RegroupOptions & {partyIdx: number; chainId: number; extraArgs: string[]};
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const signerRoot = bnbTss.resolveSignerRoot();
  const tssRoot = bnbTss.resolveTssRoot(signerRoot);
  const binary = bnbTss.resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const password = options.password || process.env.BNB_TSS_PASSWORD || process.env.TSS_PASSWORD;
  const channelId = options.channelId || process.env.BNB_TSS_CHANNEL_ID;
  const channelPassword = options.channelPassword || process.env.BNB_TSS_CHANNEL_PASSWORD;
  if (!password || !channelId || !channelPassword) {
    throw new Error('BNB TSS regroup requires password, channel id, and channel password');
  }
  const params = bnbTss.readParams(signerRoot);
  const initialized = bnbTss.requireInitialized({...options, signerRoot, tssRoot, binary});
  const args = [
    'regroup',
    '--home',
    initialized.home,
    '--vault_name',
    initialized.vaultName,
    '--password',
    password,
    '--log_level',
    options.logLevel || 'debug',
    '--channel_id',
    channelId,
    '--channel_password',
    channelPassword,
    '--threshold',
    String(options.threshold ?? params.threshold),
    '--parties',
    String(options.parties ?? params.parties),
  ];
  if (Number.isInteger(options.newThreshold)) {
    args.push('--new_threshold', String(options.newThreshold));
  }
  if (Number.isInteger(options.newParties)) {
    args.push('--new_parties', String(options.newParties));
  }
  if (options.isOld) args.push('--is_old');
  if (options.isNewMember) args.push('--is_new_member');
  if (options.pubkey) args.push('--pubkey', options.pubkey);
  args.push(...options.extraArgs);
  const autoInput = options.isNewMember && !options.isOld ? 'n\n' : undefined;
  const result = spawnSync(binary, args, {
    cwd: tssRoot,
    env: {...process.env, TSS_PASSWORD: password},
    encoding: 'utf8',
    input: autoInput,
    stdio: ['pipe', 'inherit', 'inherit'],
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
