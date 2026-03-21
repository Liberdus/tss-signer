# TSS Signer

A Threshold Signature Scheme (TSS) implementation for the Liberdus cross-chain bridge. Uses the [GG18](https://eprint.iacr.org/2019/114.pdf) multi-party ECDSA protocol to enable distributed, trustless signing with a **3-of-5 threshold** configuration — no single party can sign unilaterally.

Supports bridging between the Liberdus network and EVM chains (Polygon Amoy, BSC Testnet).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                Observer Nodes (observer/)           │
│  • Monitor EVM chains for BridgedOut/BridgedIn      │
│  • Poll Liberdus for coin-to-token transfers        │
│  • Persist bridge transactions to local SQLite      │
└──────────────────────▲──────────────────────────────┘
                       │  HTTP (localhost:810x)
┌──────────────────────┴──────────────────────────────┐
│                  TSS Party Nodes (×5)               │
│  scripts/tss-party.ts — compiled to dist/           │
│  • Poll local observer every 10s for pending txs    │
│  • Queue pending txs from the local observer        │
│  • Sign through native BNB TSS flows                │
│  • Submit signed txs to destination chain           │
└─────────────────────────────────────────────────────┘
```

### Language split

| Layer | Language | Purpose |
|---|---|---|
| `tss/` | Go | Native BNB TSS binary |
| `tss-tools/` | TypeScript + Go | Native TSS build/init/keygen/verify/sign/regroup helpers |
| `scripts/tss-party.ts` | TypeScript | Orchestration: event monitoring, queue, signing flow |
| `observer/` | TypeScript (Node.js) | On-chain monitoring, transaction DB, local status API |

## Prerequisites

- Node.js 18+
- PM2 (`npm install -g pm2`)

## Setup

> For a full walkthrough of the multi-operator setup process (keypair generation, keygen, verify, start), see [PARTY_SETUP.md](PARTY_SETUP.md).

### 1. Compile the TSS party script

```bash
npm run compile
```

### 2. Build native BNB TSS

First fetch the submodule:

```bash
git submodule update --init --recursive
```

If `npm run tss-build` says the Go toolchain is missing, bootstrap the local vendored Go first:

```bash
./tss-tools/setup-mise-go.sh
```

```bash
npm run tss-build
```

Native mode expects these environment variables to be shared across participating parties:

```bash
export BNB_TSS_PASSWORD=1234567890
export BNB_TSS_CHANNEL_ID=<shared-channel-id>
export BNB_TSS_CHANNEL_PASSWORD=<shared-channel-password>
```

`BNB_TSS_CHANNEL_ID` and `BNB_TSS_CHANNEL_PASSWORD` are still required for manual native keygen and regroup flows. The long-lived `tss-party` signer derives a deterministic signing `channelId` per transaction from each transaction `txId` and `txTimestamp`, and a deterministic signing `channelPassword` from `channelId + SHARDUS_CRYPTO_HASH_KEY`.
Native vaults are stored under `keystores/bnbtss/party-<idx>/chain-<chainId>/default/`.
User-facing party indices start at `1`.
The native binary is built to `./tss/.tooling/bin/tss`.

Native helper walkthroughs and command examples live in [`tss-tools/guide.md`](tss-tools/guide.md).

### 4. Configure chains and params

- **`params.json`** — TSS parameters. Default: `{"parties": 5, "threshold": 3}`
- **`chain-config.json`** — RPC endpoints, contract addresses, gas config per chain.

### 5. Run keygen (first time only)

All 5 parties must complete keygen before any signing can occur. Keygen produces per-party keystore files in `keystores/`. Refer to the keygen script for details.

### 6. Start all TSS parties

```bash
npm run start-tss   # starts 5 PM2 processes
```

## Build Commands

```bash
# Compile TypeScript party script
npm run compile

# Compile + run a single party (for testing)
npm run tss-party

# Build patched upstream BNB TSS
npm run tss-build

# Native TSS operator helpers
npm run tss-init -- --party 1 --chain-id 97
npm run tss-keygen -- --party 1 --chain-id 97
npm run tss-verify -- --party 1 --chain-id 97
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --new-threshold 3 --new-parties 5
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file tx.json.example
```

## Native TSS Scripts

These scripts live under [`tss-tools/`](tss-tools) and are the operator-facing helpers for the native `tss` flow.

| Path | Purpose |
|---|---|
| `tss-tools/build-tss.sh` | Applies the local patch to the upstream `tss` checkout and builds `./tss/.tooling/bin/tss` plus `./tss/.tooling/bin/tss-derive-pubkey`. |
| `tss-tools/setup-mise-go.sh` | Bootstraps a local Go toolchain under `tss/.tooling/mise` when system `go` is unavailable. |
| `tss-tools/init.ts` | Initializes one native TSS party home and vault for a given party index and chain id. |
| `tss-tools/keygen.ts` | Runs native TSS keygen for one party using the shared channel settings and `params.json` defaults unless overridden. By default it supplies deterministic local `--p2p.peer_addrs` for same-host committees. |
| `tss-tools/verify.ts` | Derives and prints the compressed pubkey, Ethereum pubkey, or Ethereum address from an existing native vault. |
| `tss-tools/sign-ethereum-tx.ts` | Signs an unsigned Ethereum transaction JSON through native TSS and prints the signed tx payload. |
| `tss-tools/regroup.ts` | Runs native TSS regroup for a carry-over old member (`--is-old`) or a fresh new member (`--is-new-member`). In deterministic local mode it auto-generates regroup topology for contiguous new committees (`1..newParties`). |
| `tss-tools/lib/bnbTss.ts` | Shared TypeScript runtime helper used by the tooling scripts for binary resolution, patch prep, vault paths, committee topology, and signing helpers. |
| `tss-tools/lib/committeeTopology.ts` | Committee topology helper for deterministic local peer addresses and parsing `tss describe` topology output. |
| `tss-tools/patches/tss-source.patch` | The local patch applied onto the upstream `tss` source before build/use. See [`tss-tools/patches/README.md`](tss-tools/patches/README.md) for a description of every change. |
| `tss-tools/test-sign-rounds.sh` | Multi-scenario signing test harness. Runs configurable rounds across varying party startup delays and reports PASS/FAIL. Logs to `tss-tools/test-result.log` and `tss-tools/test-party{1,2,3}.log`. |
| `tss-tools/derive-pubkey/main.go` | Small Go helper source staged into `tss/.tooling` and run inside the upstream `tss` module for `verify.ts` and post-keygen address derivation. |
| `tss-tools/guide.md` | Step-by-step local operator guide for build, init, keygen, verify, sign, and regroup. |

## PM2 Process Management

```bash
npm run start-tss    # start all 5 party processes
npm run stop-tss     # stop all
npm run restart-tss  # restart all
npm run logs-tss     # stream PM2 logs
npm run status-tss   # show process status
```

Each party process runs with `--expose-gc` and a 2 GB memory limit. GC is forced when heap exceeds 256 MB.

## Bridge Transaction Flow

**Token-to-Coin (EVM → Liberdus):**
1. Observer detects `BridgedOut` events on the EVM contract and saves them as PENDING in local SQLite
2. TSS parties poll the paired observer every 10s for unprocessed transactions
3. Each party independently queues the pending transaction from its local observer
4. Parties sign through the native BNB TSS flow
5. Winning party broadcasts the signed tx to Liberdus and updates local status

**Coin-to-Token (Liberdus → EVM):**
1. Observer polls the Liberdus collector API for bridge transfers and saves them as PENDING
2. TSS parties pick up the pending transaction, sign, and submit to the target EVM chain

## Key Files

| Path | Description |
|---|---|
| `scripts/tss-party.ts` | Main party orchestration (~3000 lines) |
| `observer/index.ts` | Observer entry point |
| `tss-tools/lib/bnbTss.ts` | Native BNB TSS runtime helper |
| `chain-config.json` | Multi-chain RPC and contract configuration |
| `params.json` | TSS parameters (parties, threshold) |
| `keystores/` | Native TSS party data and generated artifacts |
| `ecosystem.config.js` | PM2 process configuration |

## TSS Protocol Details

**Keygen (5 rounds):** All 5 parties participate. Output: shared public key + individual key shares written to `keystores/`.

**Signing:** Any 3 of 5 parties suffice. Output: ECDSA signature broadcast to the target chain through the native BNB TSS flow.

## Running Tests

```bash
# Compile TypeScript
npm run compile

# Native TSS helper tests
npm run test:tss-tools
```

## License

Apache-2.0
