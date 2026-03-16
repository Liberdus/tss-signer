# TSS Signer

A Threshold Signature Scheme (TSS) implementation for the Liberdus cross-chain bridge. Uses the [GG18](https://eprint.iacr.org/2019/114.pdf) multi-party ECDSA protocol to enable distributed, trustless signing with a **3-of-5 threshold** configuration — no single party can sign unilaterally.

Supports bridging between the Liberdus network and EVM chains (Polygon Amoy, BSC Testnet).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Coordinator  (coordinator/)            │
│  • Monitors EVM chains for BridgedOut/BridgedIn     │
│  • Polls Liberdus for coin-to-token transfers       │
│  • Persists bridge transactions to SQLite           │
│  • Relays keygen/signing round data between parties │
└──────────────────────▲──────────────────────────────┘
                       │  HTTP (localhost:8000)
┌──────────────────────┴──────────────────────────────┐
│                  TSS Party Nodes (×5)               │
│  scripts/tss-party.ts — compiled to dist/           │
│  • Poll coordinator every 10s for pending txs       │
│  • Verify each tx on-chain before queuing           │
│  • Coordinate 10-round GG18 signing                 │
│  • Submit signed txs to destination chain           │
└─────────────────────────────────────────────────────┘
```

### Language split

| Layer | Language | Purpose |
|---|---|---|
| `src/` | Rust → WASM | GG18 crypto: keygen (5 rounds), signing (10 rounds) |
| `scripts/tss-party.ts` | TypeScript | Orchestration: event monitoring, queue, signing flow |
| `coordinator/` | TypeScript (Node.js) | Round relay, transaction DB, on-chain monitoring |
| `pkg/` | Generated WASM | Output of `wasm-pack build` |

## Prerequisites

- Rust + `wasm-pack` ([install](https://rustwasm.github.io/wasm-pack/installer/))
- Node.js 18+
- PM2 (`npm install -g pm2`)

## Setup

> For a full walkthrough of the multi-operator setup process (keypair generation, keygen, verify, start), see [PARTY_SETUP.md](PARTY_SETUP.md).

### 1. Build the WASM module

```bash
npm run build_node
```

### 2. Compile the TSS party script

```bash
npm run compile-tss
```

### 3. Optional: build native BNB TSS overlay

When `scripts/tss-party.ts` runs with `useBnbTss = true`, signing is delegated to the upstream Binance `tss` repo checked out under [`tss/`](tss) and prepared through the local tools in [`tss-tools/`](tss-tools).

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

Native vaults are stored under `keystores/bnbtss/party-<idx>/chain-<chainId>/default/`.
User-facing party indices start at `1`.
The native binary is built to `./tss/.tooling/bin/tss`.

Native helper walkthroughs and command examples live in [`tss-tools/guide.md`](tss-tools/guide.md).

### 4. Configure chains and params

- **`params.json`** — TSS parameters. Default: `{"parties": 5, "threshold": 3}`
- **`chain-config.json`** — RPC endpoints, contract addresses, gas config per chain.

### 5. Run keygen (first time only)

All 5 parties must complete keygen before any signing can occur. Keygen produces per-party keystore files in `keystores/`. Refer to the keygen script for details.

### 6. Start the coordinator

```bash
cd coordinator
npm install
npm run dev        # development (ts-node + nodemon)
# or
npm run build && npm start   # production
```

See [coordinator/README.md](coordinator/README.md) for full coordinator setup.

### 7. Start all TSS parties

```bash
npm run start-tss   # starts 5 PM2 processes
```

## Build Commands

```bash
# Build WASM for Node.js
npm run build_node

# Build WASM for web (webpack)
npm run build

# Compile TypeScript party script
npm run compile-tss

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
| `tss-tools/init.js` | Initializes one native TSS party home and vault for a given party index and chain id. |
| `tss-tools/keygen.js` | Runs native TSS keygen for one party using the shared channel settings and `params.json` defaults unless overridden. |
| `tss-tools/verify.js` | Derives and prints the compressed pubkey, Ethereum pubkey, or Ethereum address from an existing native vault. |
| `tss-tools/sign-ethereum-tx.js` | Signs an unsigned Ethereum transaction JSON through native TSS and prints the signed tx payload. |
| `tss-tools/regroup.js` | Runs native TSS regroup for an existing or new committee member. |
| `tss-tools/lib/bnbTss.js` | Shared runtime helper used by the Node scripts for binary resolution, patch prep, vault paths, and signing helpers. |
| `tss-tools/patches/tss-source.patch` | The local patch applied onto the upstream `tss` source before build/use. |
| `tss-tools/derive-pubkey/main.go` | Small Go helper source staged into `tss/.tooling` and run inside the upstream `tss` module for `verify.js` and post-keygen address derivation. |
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
1. Coordinator detects `BridgedOut` event on EVM contract and saves it as PENDING in SQLite
2. TSS parties poll coordinator every 10s for unprocessed transactions (`GET /transaction?unprocessed=true`)
3. Each party independently verifies the transaction on-chain before queuing it
4. Parties coordinate 10-round GG18 signing through the coordinator's round relay
5. Winning party broadcasts the signed tx to Liberdus and reports COMPLETED to coordinator

**Coin-to-Token (Liberdus → EVM):**
1. Coordinator polls the Liberdus collector API for bridge transfers and saves them as PENDING
2. TSS parties pick up the pending transaction, verify on-chain, sign, and submit to the target EVM chain

## Key Files

| Path | Description |
|---|---|
| `scripts/tss-party.ts` | Main party orchestration (~3000 lines) |
| `src/api.rs` | WASM-exported keygen/signing round functions |
| `coordinator/src/server.ts` | Coordinator entry point |
| `chain-config.json` | Multi-chain RPC and contract configuration |
| `params.json` | TSS parameters (parties, threshold) |
| `keystores/` | Per-party key shares (keygen) + auth keypairs (`tss_signer_keypair_party_N.json`) |
| `scripts/generate-signer-keypairs.js` | Generates auth keypairs for TSS parties |
| `ecosystem.config.js` | PM2 process configuration |

## TSS → Coordinator Authentication

TSS parties sign every HTTP request they send to the coordinator using **Shardus Crypto** (Ed25519 + Blake2b-keyed hash). This prevents unauthorized clients from injecting round data or manipulating party signup.

The auth layer is implemented in [`src/shardus_crypto.rs`](src/shardus_crypto.rs) (compiled into the WASM module) and verified by the coordinator in [`coordinator/src/auth.ts`](coordinator/src/auth.ts).

### Enabling / disabling

Auth is controlled by the `enableShardusCryptoAuth` field in `chain-config.json`:

```json
{ "enableShardusCryptoAuth": true }
```

It can also be forced on/off via environment variable:

```bash
ENABLE_SHARDUS_CRYPTO_AUTH=true   # override chain-config.json
ENABLE_SHARDUS_CRYPTO_AUTH=false  # disable regardless of config
```

**For local development**, leave `enableShardusCryptoAuth` unset or `false` — parties will skip signing and the coordinator will accept all requests without verification.

### Generating signer keypairs

Each TSS party needs its own Ed25519 signer keypair. Use the provided script to generate them:

```bash
# Generate signer keypairs for all 5 parties (skips existing files)
npm run generate-signer-keypairs

# Generate for a specific number of parties
npm run generate-signer-keypairs -- --parties 5

# Regenerate a single party's keypair
npm run generate-signer-keypairs -- --party 3 --force
```

Keypairs are written to `keystores/tss_signer_keypair_party_N.json`:

```json
{
  "publicKey": "<64-char hex>",
  "secretKey": "<128-char hex>"
}
```

The script also prints a ready-to-paste `coordinator/allowed-tss-signers.json` block containing all generated public keys. The coordinator uses this whitelist to accept only requests signed by known party nodes.

Keys can also be supplied via environment variables instead of files:

```bash
TSS_SIGNER_PUB_KEY=<64-char-hex>
TSS_SIGNER_SEC_KEY=<128-char-hex>
TSS_SIGNER_KEYPAIR_FILE=/path/to/custom-keypair.json   # override file path
```

### How signing works

When auth is enabled, the WASM module wraps every coordinator request body as:

```json
{
  "payload": <original body>,
  "ts": <unix ms>,
  "sign": {
    "owner": "<public key hex>",
    "sig":   "<ed25519 signature + digest hex>"
  }
}
```

The coordinator verifies the signature and rejects requests from keys not in the whitelist.

## TSS Protocol Details

**Keygen (5 rounds):** All 5 parties participate. Output: shared public key + individual key shares written to `keystores/`.

**Signing (10 rounds):** Any 3 of 5 parties suffice. Each round posts/fetches data through the coordinator's in-memory relay (`/set`, `/get`). Output: ECDSA signature broadcast to the target chain.

## Running Tests

```bash
# Rust unit tests
cargo test

# WASM tests (requires build_node first)
npm run test
```

## Upstream / Attribution

This project is built on top of [@ieigen/tss-wasm](https://github.com/0xEigenLabs/tss-wasm) by EigenLabs, which provides the GG18 WASM implementation. The original npm packages are:

- `@ieigen/tss-wasm@0.0.8` (web)
- `@ieigen/tss-wasm-node@0.0.7` (Node.js, requires Node 18+)

## License

Apache-2.0
