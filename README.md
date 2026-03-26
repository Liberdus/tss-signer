# TSS Signer

A Threshold Signature Scheme (TSS) implementation for the Liberdus cross-chain bridge. Uses the [GG18](https://eprint.iacr.org/2019/114.pdf) multi-party ECDSA protocol to enable distributed, trustless signing with a **3-of-5 threshold** configuration — no single party can sign unilaterally.

Supports bridging between the Liberdus network and EVM chains (Polygon Amoy, BSC Testnet).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Observer Nodes (×5, observer/)         │
│  • Monitor EVM chains for BridgedOut/BridgedIn      │
│  • Poll Liberdus for coin-to-token transfers        │
│  • Persist bridge transactions to local SQLite      │
│  • Serve HTTP on localhost:810N                     │
└──────────────────────▲──────────────────────────────┘
                       │  HTTP (localhost:810N)
┌──────────────────────┴──────────────────────────────┐
│                  TSS Party Nodes (×5)               │
│  scripts/tss-party.ts — compiled to dist/           │
│  • Poll local observer every 10s for pending txs    │
│  • Sign through native BNB TSS flows                │
│  • Submit signed txs to destination chain           │
└─────────────────────────────────────────────────────┘
```

Each party index (1–5) runs a paired **observer** and **TSS party** process. Both must be running for the bridge to operate.

### Language split

| Layer | Language | Purpose |
|---|---|---|
| `tss/` | Go | Native BNB TSS binary (patched upstream `bnb-chain/tss`) |
| `tss-tools/` | TypeScript + Go | Native TSS build/init/keygen/verify/sign/regroup helpers |
| `scripts/tss-party.ts` | TypeScript | Orchestration: transaction queue, signing flow, chain submission |
| `observer/` | TypeScript (Node.js) | On-chain monitoring, SQLite transaction DB, local HTTP API |
| `shared/` | TypeScript | Config, DB types, RPC helpers, utilities shared across layers |

## Prerequisites

- Node.js 18+
- PM2 (`npm install -g pm2`)

## Setup

> For a full walkthrough of the multi-operator setup process (keypair generation, keygen, verify, start), see [PARTY_SETUP.md](PARTY_SETUP.md).

### 1. Install dependencies and compile

```bash
npm install
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

The vendored Go bootstrap supports macOS and Linux on supported CPU architectures (`darwin-arm64`, `linux-x64`, `linux-arm64`). Windows is not supported by this bootstrap flow.

Then build:

```bash
npm run tss-build
```

The native binary is built to `./tss/.tooling/bin/tss`. Native vaults are stored under `keystores/bnbtss/party-<idx>/chain-<chainId>/default/`. User-facing party indices start at `1`.

### 3. Set environment variables

```bash
export BNB_TSS_PASSWORD=<shared-vault-password>
export BNB_TSS_CHANNEL_ID=<shared-channel-id>       # required for keygen/regroup
export BNB_TSS_CHANNEL_PASSWORD=<shared-channel-password>  # required for keygen/regroup
```

Required envs by flow:

- `BNB_TSS_PASSWORD`: required for native vault access. Must be set before `tss-init`, `tss-keygen`, `tss-verify`, and `tss-party` startup. If missing, startup validation fails with `BNB TSS vault password is required (BNB_TSS_PASSWORD)`.
- `BNB_TSS_CHANNEL_ID`: required for manual native keygen/regroup/sign flows unless passed explicitly on the command line.
- `BNB_TSS_CHANNEL_PASSWORD`: required for manual native keygen/regroup/sign flows unless passed explicitly on the command line.
- `SHARDUS_CRYPTO_HASH_KEY`: optional override for the long-lived `tss-party` signer. When unset, the code falls back to a built-in default. If you set it, all parties must use the same value so deterministic signing channel passwords match.

The long-lived `tss-party` signer derives a deterministic signing `channelId` per transaction from each transaction `txId` and `txTimestamp`, and a deterministic signing `channelPassword` from `channelId + SHARDUS_CRYPTO_HASH_KEY`.

Native helper walkthroughs and command examples live in [`tss-tools/guide.md`](tss-tools/guide.md).

### 4. Configure chains and params

- **`params.json`** — TSS parameters. Default: `{"parties": 5, "threshold": 3}`
- **`chain-config.json`** — RPC endpoints, contract addresses, gas config per chain.

### 5. Run keygen (first time only)

All 5 parties must complete keygen before any signing can occur. Keygen produces per-party keystore files in `keystores/`. Refer to [PARTY_SETUP.md](PARTY_SETUP.md) for the full multi-operator keygen process.

### 6. Start all observers and TSS parties

```bash
npm run start-tss   # starts 10 PM2 processes (5 observers + 5 TSS parties)
```

## Build Commands

```bash
# Compile all TypeScript (scripts, observer, tss-tools → dist/)
npm run compile

# Build patched upstream BNB TSS
npm run tss-build

# Compile + run a single party (for testing)
npm run tss-party

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
| `tss-tools/setup-mise-go.sh` | Bootstraps a local Go toolchain under `tss/.tooling/mise` when system `go` is unavailable. Supports `darwin-arm64`, `linux-x64`, and `linux-arm64`; Windows is not supported. |
| `tss-tools/init.ts` | Initializes one native TSS party home and vault for a given party index and chain id. |
| `tss-tools/keygen.ts` | Runs native TSS keygen for one party using the shared channel settings and `params.json` defaults unless overridden. By default it supplies deterministic local `--p2p.peer_addrs` for same-host committees. |
| `tss-tools/verify.ts` | Derives and prints the compressed pubkey, Ethereum pubkey, or Ethereum address from an existing native vault. |
| `tss-tools/sign-ethereum-tx.ts` | Signs an unsigned Ethereum transaction JSON through native TSS and prints the signed tx payload. |
| `tss-tools/regroup.ts` | Runs native TSS regroup for a carry-over old member (`--is-old`) or a fresh new member (`--is-new-member`). In deterministic local mode it auto-generates regroup topology for contiguous new committees (`1..newParties`). |
| `tss-tools/lib/bnbTss.ts` | Shared TypeScript runtime helper used by the tooling scripts for binary resolution, patch prep, vault paths, committee topology, and signing helpers. |
| `tss-tools/lib/committeeTopology.ts` | Committee topology helper for deterministic local peer addresses and parsing `tss describe` topology output. |
| `tss-tools/lib/channelId.ts` | Deterministic signing `channelId` and `channelPassword` derivation helpers. |
| `tss-tools/patches/tss-source.patch` | The local patch applied onto the upstream `tss` source before build/use. See [`tss-tools/patches/README.md`](tss-tools/patches/README.md) for a description of every change. |
| `tss-tools/test-sign-rounds.sh` | Multi-scenario signing test harness. Runs configurable rounds across varying party startup delays and reports PASS/FAIL. Logs to `tss-tools/test-result.log` and `tss-tools/test-party{1..N}.log`. |
| `tss-tools/derive-pubkey/main.go` | Small Go helper source staged into `tss/.tooling` and run inside the upstream `tss` module for `verify.ts` and post-keygen address derivation. |
| `tss-tools/guide.md` | Step-by-step local operator guide for build, init, keygen, verify, sign, and regroup. |

## PM2 Process Management

```bash
npm run start-tss               # start all 10 processes (5 observers + 5 TSS parties)
npm run stop-tss                # stop all
npm run restart-tss             # restart all
npm run restart-tss:observers   # restart only observer-1..5
npm run restart-tss:tss-parties # restart only tss-party-1..5
npm run logs-tss                # stream PM2 logs
npm run status-tss              # show process status
```

Observer processes (`observer-N`) run with a 1 GB memory limit. TSS party processes (`tss-party-N`) run with a 2 GB memory limit. All processes use `--expose-gc`; GC is forced when heap exceeds 256 MB.

Log files are at `logs/{process-name}-combined.log`.

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
| `observer/index.ts` | Observer entry point: HTTP server + monitoring schedulers |
| `observer/monitor/ethereum.ts` | EVM BridgedOut/BridgedIn block scanning |
| `observer/monitor/liberdus.ts` | Liberdus collector API polling |
| `shared/config.ts` | `ChainConfig` / `ParamsConfig` types and loaders |
| `shared/storage/transactiondb.ts` | SQLite transaction DB: types, statuses, queries |
| `tss-tools/lib/bnbTss.ts` | Native BNB TSS runtime helper |
| `chain-config.json` | Multi-chain RPC and contract configuration |
| `params.json` | TSS parameters (parties, threshold) |
| `keystores/` | Native TSS vault files (created during keygen) |
| `ecosystem.config.js` | PM2 process configuration for all 10 processes |

## TSS Protocol Details

**Keygen:** All 5 parties participate simultaneously. Output: shared public key + individual key shares written to `keystores/bnbtss/party-N/chain-CHAINID/default/`.

**Signing:** Any `threshold + 1` (≥ 4 of 5) parties suffice. The patched binary implements a configurable discovery window (`--sign_discovery_timeout`, default 5s) — once the first peer connects, signing proceeds with all parties that arrive within the window (minimum threshold).

**Regroup:** Transfers key shares to a new committee without regenerating the shared key. Requires at least `threshold + 1` old participants.

## Running Tests

```bash
# Compile TypeScript
npm run compile

# Native TSS helper unit tests
npm run test:tss-tools
```

## License

Apache-2.0
