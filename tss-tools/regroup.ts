#!/usr/bin/env node
import 'dotenv/config'
import {spawnSync} from 'node:child_process'
import * as bnbTss from './lib/bnbTss'
import {resolveProjectRoot} from '../shared/utils/paths'

function usage(): never {
  console.error(
    'Usage: node tss-tools/regroup.js --chain-id <id> [--party <idx>=1..N] [--password <value>] [--log_level <value>] [--channel-id <id>] [--channel-password <value>] [--threshold <n>] [--parties <n>] [--new-threshold <n>] [--new-parties <n>] [--new-peer-addrs <addr1,addr2>] [--new-listen-addr <multiaddr>] (--is-old | --is-new-member) [--pubkey <hex>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--use-default-slot-path] [--binary <path>] [-- <extra regroup args...>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.RegroupOptions & {chainId: number; extraArgs: string[]} {
  const options: Partial<bnbTss.RegroupOptions> & {extraArgs: string[]} = {extraArgs: []};
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
      case '--new-peer-addrs':
        options.newPeerAddrs = value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--new-listen-addr':
        options.newListenAddr = value;
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
      case '--home-path':
        options.homePath = value;
        i += 1;
        break;
      case '--use-default-slot-path':
        options.useDefaultSlotPath = true;
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
  if (!Number.isInteger(options.chainId)) {
    usage();
  }
  if (!partyExplicit) {
    options.useDefaultSlotPath = true;
  }
  if (partyExplicit && (!Number.isInteger(options.partyIdx) || options.partyIdx < 1)) {
    usage();
  }
  return options as bnbTss.RegroupOptions & {chainId: number; extraArgs: string[]};
}

function hasExtraFlag(extraArgs: string[], flag: string): boolean {
  return extraArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.isOld && options.isNewMember) {
    throw new Error('Use either --is-old or --is-new-member, not both. In the wrapper, --is-old means an existing member who stays in the new committee.');
  }
  if (!options.isOld && !options.isNewMember) {
    throw new Error('Regroup requires exactly one wrapper role: use --is-old for a carry-over member or --is-new-member for a fresh new member.');
  }
  const signerRoot = resolveProjectRoot();
  const tssRoot = bnbTss.resolveTssRoot(signerRoot);
  const regroupCwd = `${tssRoot}/.tooling/bin`;
  const binary = bnbTss.resolveBnbTssBinary({...options, signerRoot, tssRoot});
  const password = bnbTss.requireVaultPassword(options.chainId, options.password);
  const channelId = options.channelId || process.env.BNB_TSS_CHANNEL_ID;
  const channelPassword = options.channelPassword || process.env.BNB_TSS_CHANNEL_PASSWORD;
  if (!channelId || !channelPassword) {
    throw new Error('BNB TSS regroup requires password, channel id, and channel password');
  }
  const params = bnbTss.readParams(signerRoot);
  const initialized = bnbTss.requireInitialized({...options, signerRoot, tssRoot, binary});
  const threshold = options.threshold ?? params.threshold;
  const parties = options.parties ?? params.parties;
  const newThreshold = options.newThreshold;
  const newParties = options.newParties;
  const hasExplicitNewPeerAddrs = hasExtraFlag(options.extraArgs, '--p2p.new_peer_addrs');
  const hasExplicitNewListenAddr = hasExtraFlag(options.extraArgs, '--p2p.new_listen');
  const newPeerAddrs =
    options.newPeerAddrs ||
    (!hasExplicitNewPeerAddrs && Number.isInteger(newParties)
      ? bnbTss.deriveLocalRegroupPeerAddrs({
          chainId: options.chainId,
          parties,
          threshold,
          newParties,
          partyIdx: options.partyIdx ?? bnbTss.DEFAULT_SLOT_PARTY_IDX,
          isOld: options.isOld,
          isNewMember: options.isNewMember,
        })
      : []);
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
    String(threshold),
    '--parties',
    String(parties),
  ];
  if (!hasExplicitNewListenAddr && options.isOld) {
    args.push(
      '--p2p.new_listen',
      options.newListenAddr || bnbTss.getLocalRegroupListenAddr(options.chainId, options.partyIdx ?? bnbTss.DEFAULT_SLOT_PARTY_IDX),
    );
  }
  if (Number.isInteger(options.newThreshold)) {
    args.push('--new_threshold', String(options.newThreshold));
  }
  if (Number.isInteger(options.newParties)) {
    args.push('--new_parties', String(options.newParties));
  }
  if (!hasExplicitNewPeerAddrs && newPeerAddrs.length > 0) {
    args.push('--p2p.new_peer_addrs', newPeerAddrs.join(','));
  }
  if (options.isOld) {
    args.push('--is_old', '--is_new_member');
  } else if (options.isNewMember) {
    args.push('--is_new_member');
  }
  if (options.pubkey) args.push('--pubkey', options.pubkey);
  args.push(...options.extraArgs);
  let autoInput: string | undefined;
  if (options.isNewMember) {
    autoInput = 'n\n';
  }
  console.log(`Running ${binary} ${args.join(' ')}`);
  const result = spawnSync(binary, args, {
    cwd: regroupCwd,
    env: {...process.env, TSS_PASSWORD: password},
    encoding: 'utf8',
    input: autoInput,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  bnbTss.normalizeStoredPostRegroupPorts({
    ...options,
    signerRoot,
    tssRoot,
    homePath: initialized.home,
    vaultName: initialized.vaultName,
  });
  const derived = bnbTss.derivePubkey({...options, signerRoot, tssRoot, format: 'all'}) as {
    compressed: string
    ethereum_address: string
    ethereum_pubkey: string
  };
  process.stdout.write(
    `${JSON.stringify({
      ...(options.partyIdx ? {party: options.partyIdx} : {}),
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
