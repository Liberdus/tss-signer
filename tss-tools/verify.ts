#!/usr/bin/env node
import 'dotenv/config'
import * as bnbTss from './lib/bnbTss'

function usage(): never {
  console.error(
    'Usage: node tss-tools/verify.js --party <idx>=1..N --chain-id <id> [--password <value>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--format compressed|ethereum-pubkey|ethereum-address|all]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.VerifyOptions & {partyIdx: number; chainId: number; format: bnbTss.DerivePubkeyFormat} {
  const options: Partial<bnbTss.VerifyOptions> & {format: bnbTss.DerivePubkeyFormat} = {format: 'all'};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
      case '--format':
        options.format = value as bnbTss.DerivePubkeyFormat;
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
  if (!Number.isInteger(options.partyIdx) || options.partyIdx < 1 || !Number.isInteger(options.chainId)) usage();
  return options as bnbTss.VerifyOptions & {partyIdx: number; chainId: number; format: bnbTss.DerivePubkeyFormat};
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = bnbTss.derivePubkey(options);
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
