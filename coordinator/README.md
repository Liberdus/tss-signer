# TSS Coordinator

An Express.js server that acts as the coordination hub for the Liberdus TSS bridge signer. It handles two distinct responsibilities:

1. **Round relay** — Relays keygen/signing round data between TSS party nodes via an in-memory key-value store.
2. **Transaction lifecycle** — Monitors EVM chains and Liberdus for bridge events, persists transactions to SQLite, and serves pending transactions to TSS parties for signing.

The coordinator must be running before any TSS party node can perform keygen or signing.

## Prerequisites

- Node.js 18+

## Setup

```bash
npm install
```

### Configuration files

The coordinator reads two config files from the repository root (one level up from `coordinator/`):

- **`../params.json`** — TSS parameters (`parties`, `threshold`). Used by signup endpoints.
- **`../chain-config.json`** — RPC endpoints, contract addresses, deployment blocks, and feature flags. Used for on-chain monitoring.

### Authentication (optional)

The coordinator supports optional request authentication using Shardus Crypto signatures. When enabled, all round-relay endpoints (`/get`, `/set`, `/signupkeygen`, `/signupsign`) require requests to be signed by a whitelisted TSS party key.

**To enable auth:**

Set `"enableShardusCryptoAuth": true` in `chain-config.json` (or set env var `ENABLE_SHARDUS_CRYPTO_AUTH=true`).

**Whitelist file:**

Create `coordinator/allowed-tss-signers.json` listing the 64-char hex public keys of all TSS party nodes:

```json
{
  "allowedTSSSigners": [
    "<64-char-hex-pubkey-party-1>",
    "<64-char-hex-pubkey-party-2>",
    ...
  ]
}
```

The file path can be overridden with the `COORDINATOR_ALLOWED_TSS_SIGNER_FILE` environment variable.

When auth is **disabled** (default for local development), all requests are accepted without verification.

## Running

```bash
# Development — ts-node + nodemon (auto-restart on file changes)
npm run dev

# Production — compile first, then run
npm run build
npm start
```

The server listens on port `8000` by default. Override with the `PORT` environment variable.

## Startup Sequence

On startup the coordinator performs an **ordered initial sync** before accepting pending transaction queries from TSS parties:

1. Scan all chains for `BridgedOut` events (EVM burn events → PENDING BRIDGE_OUT/BRIDGE_VAULT records)
2. Scan Liberdus for coin-to-token transfers (→ PENDING BRIDGE_IN records) *(if `enableLiberdusNetwork` is set)*
3. Scan all chains for `BridgedIn` events (marks matching records COMPLETED)

Once all three scans complete, `GET /transaction?unprocessed=true` begins returning results. This prevents TSS parties from re-processing transactions that are already completed on-chain.

After the initial sync, periodic polling runs on a drift-resistant scheduler:
- EVM BridgedOut + BridgedIn: every **60 seconds**
- Liberdus: every **10 seconds**

## API Endpoints

All responses follow the pattern `{ Ok: <value> }` on success or `{ Err: "<message>" }` on error.

---

### Round relay (in-memory, keygen/signing)

#### `POST /set`
Store a round data entry by key. Used by TSS parties to post commitments, shares, and proofs each round.

**Request:** `{ "key": string, "value": string }`
**Response:** `{ "Ok": null }`

#### `POST /get`
Retrieve a round data entry by key.

**Request:** `{ "key": string }`
**Response:** `{ "Ok": { "key": string, "value": string } }` or `404` if not found.

---

### Party signup (round-robin assignment)

#### `POST /signupkeygen`
Assigns a party number (1–N) for a keygen session. Resets to party 1 with a new UUID after all N parties have signed up.

**Request body:** the signup key string (plain text body)
**Response:** `{ "Ok": { "number": number, "uuid": string } }`

#### `POST /signupsign`
Same as `/signupkeygen` but for signing sessions.

**Request body:** the signup key string (plain text body)
**Response:** `{ "Ok": { "number": number, "uuid": string } }`

---

### Transaction management (SQLite-backed)

#### `GET /transaction`
Query bridge transactions with optional filters. Returns 10 transactions per page.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `txId` | string | Exact lookup by transaction ID (64-char hex or `0x`-prefixed 66-char) |
| `sender` | string | Filter by Ethereum address |
| `type` | number | `0` = BRIDGE_IN, `1` = BRIDGE_OUT, `2` = BRIDGE_VAULT |
| `status` | number | `0` = PENDING, `1` = PROCESSING, `2` = COMPLETED, `3` = FAILED |
| `unprocessed` | `"true"` | Returns PENDING + PROCESSING ordered by `txTimestamp ASC` |
| `page` | number | Page number (default: 1) |

**Response:**
```json
{
  "Ok": {
    "transactions": [ ... ],
    "totalTranactions": 42,
    "totalPages": 5
  }
}
```

> Returns empty results if the initial sync has not yet completed and `status=0` or `unprocessed=true` is requested.

#### `POST /transaction`
No-op. The coordinator discovers transactions itself via on-chain monitoring; party submissions are ignored. Returns `{ "Ok": null }`.

#### `POST /transaction/status`
Update the status of a transaction. Called by TSS parties after completing or failing a signing attempt.

**Request body:**
```json
{
  "txId": "string",
  "status": 2,
  "receiptId": "string",
  "reason": "string",
  "party": 1
}
```

- For `status = 2` (COMPLETED): the coordinator verifies the `receiptId` on-chain before accepting.
- A COMPLETED transaction cannot be downgraded to FAILED.

---

### Timestamp consensus

#### `POST /future-timestamp`
First-write-wins timestamp agreement. The first party to submit a timestamp for a given key wins; subsequent parties receive the already-set value. Used to coordinate transaction timing across parties.

**Request:** `{ "key": string, "value": string }` (value = timestamp as string)
**Response:** `{ "timestamp": number }`

---

### Notifications

#### `POST /notify-bridgeout`
Triggers an immediate BridgedOut scan for the specified chain, bypassing the 60-second polling interval. Intended to be called by external clients (e.g. a UI or relayer) when they observe a `BridgedOut` event on-chain and want faster pickup without waiting for the next scheduled poll.

Includes per-chain throttling: if called within 5 seconds of a recent poll, the scan is deferred rather than dropped, ensuring no event is silently missed.

**Request:** `{ "chainId": number }`
**Response:** `{ "Ok": "triggered" | "queued" | "cooldown" }`

---

## Data Model

```
Transaction {
  txId:         string   -- normalized 64-char hex
  sender:       string   -- lowercase Ethereum address
  value:        string   -- amount (as string)
  type:         number   -- 0=BRIDGE_IN, 1=BRIDGE_OUT, 2=BRIDGE_VAULT
  txTimestamp:  number   -- Unix ms timestamp of the source event
  chainId:      number   -- source chain ID (0 = Liberdus)
  status:       number   -- 0=PENDING, 1=PROCESSING, 2=COMPLETED, 3=FAILED
  receiptId:    string   -- on-chain receipt/tx hash after completion
  reason:       string?  -- failure reason if FAILED
  createdAt:    string   -- ISO timestamp
  updatedAt:    string   -- ISO timestamp
}
```

Transactions are stored in `transactions.sqlite` in the coordinator working directory. Monitor state (last scanned block per chain, last Liberdus timestamp) is persisted to `block_state.json`.

## Project Structure

```
coordinator/
  src/
    server.ts          -- entry point, startup sequence, schedulers
    routes.ts          -- all Express route handlers
    auth.ts            -- Shardus Crypto request verification middleware
    config.ts          -- chain-config.json loader
    verification.ts    -- on-chain receipt verification for COMPLETED status
    monitor/
      ethereum.ts      -- BridgedOut/BridgedIn queryFilter scanning
      liberdus.ts      -- Liberdus collector API polling
      state.ts         -- monitor state load/save (block_state.json)
    storage/
      transactiondb.ts -- SQLite transaction CRUD
      sqliteManager.ts -- SQLite wrapper
    utils/
      scheduler.ts     -- drift-resistant interval scheduler
      transformAddress.ts
      transformTxId.ts
    lib/
      httpProviderHelper.ts
      rpcUrls.ts
  allowed-tss-signers.json   -- whitelisted party public keys (auth)
  package.json
  tsconfig.json
```
