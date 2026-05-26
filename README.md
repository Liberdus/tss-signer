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
export TSS_PASSWORD_CHAIN_<chainId>=<chain-specific-vault-password>
export BNB_TSS_CHANNEL_ID=<shared-channel-id>       # required for keygen/regroup
export BNB_TSS_CHANNEL_PASSWORD=<shared-channel-password>  # required for keygen/regroup
```

Required envs by flow:

- `TSS_PASSWORD_CHAIN_<chainId>`: required for native vault access on that chain. Must be set before `tss-init`, `tss-keygen`, `tss-verify`, and `tss-party` startup. If missing, startup validation fails with `BNB TSS vault password is required (TSS_PASSWORD_CHAIN_<chainId>)`.
- `BNB_TSS_CHANNEL_ID`: required for manual native keygen/regroup/sign flows unless passed explicitly on the command line.
- `BNB_TSS_CHANNEL_PASSWORD`: required for manual native keygen/regroup/sign flows unless passed explicitly on the command line.
- `SHARDUS_CRYPTO_HASH_KEY`: optional override for the long-lived `tss-party` signer. When unset, the code falls back to a built-in default. If you set it, all parties must use the same value so deterministic signing channel passwords match.

The long-lived `tss-party` signer derives a deterministic signing `channelId` per transaction from each transaction `txId` and `txTimestamp`, and a deterministic signing `channelPassword` from `channelId + SHARDUS_CRYPTO_HASH_KEY`.

Native helper walkthroughs and command examples live in [`tss-tools/guide.md`](tss-tools/guide.md).

### 4. Configure chains and params

- **`params.json`** — TSS keygen/regroup parameters. Default: `{"parties": 5, "threshold": 3}`. Keygen/regroup store these values in the keystore. Signing uses the keystore values, not `params.json`.
- **`chain-config.json`** — RPC endpoints, contract addresses, gas config per chain.
- **`observer-list.json`** — observer peer URLs as a JSON array. When configured, the app uses this list to choose observer peers and determine the observer count. Copy the shape from `observer-list.json.example` and replace the placeholder IPs with real public observer IPs. If you use DNS names, set `TSS_SELF_OBSERVER_URL` on each party so it can identify its own observer.
- **Observer setup flag** (`chain-config.json`):
  - `isRemote: false` (default): if `observer-list.json` is empty, peers default to `http://127.0.0.1:8101..`.
  - `isRemote: true`: `observer-list.json` is required and startup fails when it is missing/empty.
- Optional local dev shortcut: set `observerSkipOldData: true` in `chain-config.json`, run with
  `OBSERVER_SKIP_OLD_DATA=true`, or pass `--skip-old-data` to the observer to seed both EVM
  and Liberdus monitor cursors instead of scanning historical data;
  use `observerSkipOldLiberdusData: true` or `OBSERVER_SKIP_OLD_LIBERDUS_DATA=true` to apply
  the skip only to Liberdus transactions when a Liberdus monitor cursor has not been initialized yet.

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
npm run tss-keygen-ceremony -- --nonce 1
npm run update-chain -- ./chain-config.json 97 '{"tssSenderAddress":"0x7fD5AF01358a7dad582b2476aA821b75CebaF297"}'
npm run tss-regroup-connectivity-check
npm run tss-verify -- --party 1
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --new-threshold 3 --new-parties 5
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ethereum-tx.json.example
npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example --dry-run
```

For manual Liberdus transaction signing/injection with `npm run inject-liberdus-tx`, see [`tss-tools/guide.md`](tss-tools/guide.md).

`npm run update-chain -- <path-to-chain-config.json> <chainId> '<json-object>'` deep-merges the supplied JSON object into matching entries in `supportedChains`, `vaultChain`, and `secondaryChainConfig`, and writes a `.bak` backup before updating the file. It requires `bash` and `jq`.

### Assisted keygen wrapper

For remote multi-party keygen, `npm run tss-keygen-ceremony -- --nonce <value>` reads a local `keygen-config.json`, derives `parties`, `threshold = floor(n/2)`, the current `partyIndex`, the other parties' `peer-addrs`, and deterministic keygen channel credentials from the shared config plus `--nonce`. It prompts for the chain-specific vault password, verifies the password can unlock the initialized vault, overwrites `params.json` with the derived `{parties, threshold}`, then runs `tss-keygen` with those env vars scoped to that child process only. Keygen stores those parameters in the native keystore. Use a fresh nonce for every retry, for example `--nonce 1`, then `--nonce 2`. The wrapper prints the derived UTC expiry before launching keygen. After the config is in place, `tss-verify` can omit `--chain-id` and will use `chainId` from that same file.

Expected local config file:

```json
{"chainId":97,"partyIps":["198.51.100.11","198.51.100.12","198.51.100.13"]}
```

Channel credential derivation:

- `channelId` is deterministic from `chainId + ordered partyIps + nonce`.
- The first 3 digits come from a SHA-256 digest modulo `1000`.
- The last 8 hex characters are the next `00:00:00 UTC`, which keeps all operators on the same UTC day aligned without another shared argument.
- `channelPassword` is `sha256(channelId + ceremony-material + ':channel-password')`, where `ceremony-material` is the JSON payload containing `chainId`, ordered `partyIps`, and `nonce`.

Party index detection:

- The wrapper first matches the machine's local non-internal IPv4 addresses against `partyIps`.
- If that does not resolve uniquely, it falls back to public IPv4 lookup services and retries the match.
- If the result is still ambiguous or unmatched, the wrapper stops and prints the detection failure.

Avoid starting a ceremony right around `00:00 UTC`; if some servers compute the channel on one UTC date and others on the next, they will derive different channel ids.

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
| `scripts/inject-liberdus-tx.ts` | Signs a Liberdus tx payload through native BNB TSS, verifies the signature, and optionally injects it into the Liberdus network. |
| `tss-tools/patches/tss-source.patch` | The local patch applied onto the upstream `tss` source before build/use. See [`tss-tools/patches/README.md`](tss-tools/patches/README.md) for a description of every change. |
| `tss-tools/tss_workflow_smoke.sh` | Local end-to-end native TSS smoke workflow: init, keygen, sign, regroup to 5, sign, regroup down to 3, and final sign. Run after `npm run tss-build`. |
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

Observer admin endpoints and the `operator-admin` CLI for collecting logs and restarting observer/TSS PM2 processes are documented in [OBSERVER_ADMIN.md](OBSERVER_ADMIN.md).

## Bridge Transaction Flow

Right now there are three TSS execution routes:

1. **BridgeVault:** TSS sends tokens to EVM by calling `bridgeIn` on the destination EVM contract. This is for direct EVM -> EVM bridging.
2. **Coin-to-Token:** TSS sends tokens to EVM by calling `bridgeIn` on the destination EVM contract. This is for Liberdus -> EVM flow.
3. **Token-to-Coin:** TSS sends coins to the corresponding Liberdus account (same address as the sender on EVM) using the Liberdus chain account.

**EVM -> Liberdus BridgeIn (Token-to-Coin / Liberdus Chain Account -> Corresponding Liberdus Account):**
1. Observer detects `BridgedOut` events on the EVM contract and saves them as PENDING in local SQLite
2. TSS parties poll the paired observer every 10s for unprocessed transactions
3. Each party independently queues the pending transaction from its local observer
4. Parties sign through the native BNB TSS flow
5. Winning party broadcasts the signed tx to Liberdus and sets status to SUBMITTED with `receiptTimestamp`
6. Winning party gossips Liberdus submission (`txId`, `receiptId`, `sourceChainId`) to peer observers via `/bridgein/liberdus/submitted` so peers can mark the source tx as SUBMITTED early (`txId` is source `bridgeOut` tx id, `receiptId` is destination `bridgeIn` tx id)
7. Observer detects the delivery receipt from the Liberdus collector API and reconciles the final status (COMPLETED/FAILED/REVERTED); parties do not retry once `receiptTimestamp` is set

**Liberdus -> EVM BridgeIn (Coin-to-Token):**
1. Observer polls the Liberdus collector API for bridge transfers and saves them as PENDING
2. TSS parties pick up the pending transaction, sign, and submit to the target EVM chain
3. Winning party gossips EVMChain submission (`txId`, `destinationChainId`, `receiptId`) to peer observers via `/bridgein/evm/submitted` so peers can mark the tx as SUBMITTED early (`txId` is source `bridgeOut` tx id, `receiptId` is destination `bridgeIn` tx id)

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
| `params.json` | TSS keygen/regroup parameters (parties, threshold) |
| `keystores/` | Native TSS vault files (created during keygen) |
| `ecosystem.config.js` | PM2 process configuration for all 10 processes |

## TSS Protocol Details

**Keygen:** All 5 parties participate simultaneously. Output: shared public key + individual key shares written to `keystores/bnbtss/party-N/chain-CHAINID/default/`.

**Signing:** Any `threshold + 1` (≥ 4 of 5) parties suffice. The TSS binary reads the party/threshold values from the keystore, so signing does not use `params.json`. The patched binary implements a configurable discovery window (`--sign_discovery_timeout`, default 5s) — once the first peer connects, signing proceeds with all parties that arrive within the window (minimum threshold).

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
