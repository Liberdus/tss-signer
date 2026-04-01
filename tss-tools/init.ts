#!/usr/bin/env node
import 'dotenv/config'
import * as bnbTss from './lib/bnbTss'

function usage(): never {
  console.error(
    'Usage: node tss-tools/init.js --party <idx>=1..N --chain-id <id> [--password <value>] [--log_level <value>] [--vault <name>] [--home-root <path>] [--home-path <path>] [--binary <path>] [--moniker <value>] [--listen-addr <multiaddr>] [--listen-port <port>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): bnbTss.InitPartyOptions & {partyIdx: number; chainId: number} {
  const options: Partial<bnbTss.InitPartyOptions> = {};
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
      case '--log_level':
        options.logLevel = value;
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
      case '--moniker':
        options.moniker = value;
        i += 1;
        break;
      case '--listen-addr':
        options.listenAddr = value;
        i += 1;
        break;
      case '--listen-port':
        options.listenPort = Number.parseInt(value, 10);
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
  if (options.listenPort !== undefined && !Number.isInteger(options.listenPort)) {
    usage();
  }
  return options as bnbTss.InitPartyOptions & {partyIdx: number; chainId: number};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.listenAddr && Number.isInteger(options.listenPort)) {
    options.listenAddr = `/ip4/0.0.0.0/tcp/${options.listenPort}`;
  }
  const initialized = await bnbTss.initParty(options);
  process.stdout.write(
    `${JSON.stringify({
      party: options.partyIdx,
      chainId: options.chainId,
      home: initialized.home,
      vault: initialized.vaultName,
      listen_addr: options.listenAddr || bnbTss.getLocalListenAddr(options.chainId, options.partyIdx),
      moniker: options.moniker || bnbTss.getMoniker(options.partyIdx, options.chainId),
    })}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
