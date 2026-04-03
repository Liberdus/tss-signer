#!/usr/bin/env node
import 'dotenv/config'
import * as bnbTss from './lib/bnbTss'
import {loadKeygenCeremonyConfig} from './lib/keygenCeremony'

function usage(): never {
  console.error(
    'Usage: node tss-tools/describe.js [--chain-id <id>] [--party <idx>=1..N] [--password <value>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--use-default-slot-path]',
  );
  console.error('If --chain-id is omitted, the describer uses chainId from keygen-config.json.');
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.BasePartyOptions & {chainId: number} {
  const options: Partial<bnbTss.BasePartyOptions> = {};
  let partyExplicit = false;
  let chainIdExplicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--party':
        options.partyIdx = Number.parseInt(value, 10);
        partyExplicit = true;
        i += 1;
        break;
      case '--chain-id':
        options.chainId = Number.parseInt(value, 10);
        chainIdExplicit = true;
        i += 1;
        break;
      case '--password':
        options.password = value;
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

  if (chainIdExplicit) {
    if (!Number.isInteger(options.chainId)) usage();
  } else {
    try {
      options.chainId = loadKeygenCeremonyConfig().chainId;
    } catch (error) {
      throw new Error(
        `Missing chain id. Pass --chain-id <id> or provide a valid keygen-config.json (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (!partyExplicit) {
    options.useDefaultSlotPath = true;
  }
  if (partyExplicit && (!Number.isInteger(options.partyIdx) || options.partyIdx < 1)) usage();
  return options as bnbTss.BasePartyOptions & {chainId: number};
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(bnbTss.describeVault(options));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
