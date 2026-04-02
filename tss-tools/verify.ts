#!/usr/bin/env node
import 'dotenv/config'
import * as bnbTss from './lib/bnbTss'
import {parseVerifyArgs} from './lib/verifyArgs'

function usage(): never {
  console.error(
    'Usage: node tss-tools/verify.js [--chain-id <id>] [--party <idx>=1..N] [--password <value>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--use-default-slot-path] [--format compressed|ethereum-pubkey|ethereum-address|all]',
  );
  console.error('If --chain-id is omitted, the verifier uses chainId from keygen-config.json.');
  process.exit(1);
}

if (require.main === module) {
  try {
    const options = parseVerifyArgs(process.argv.slice(2), usage) as bnbTss.VerifyOptions & {
      chainId: number
      format: bnbTss.DerivePubkeyFormat
    };
    const result = bnbTss.derivePubkey(options);
    process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
