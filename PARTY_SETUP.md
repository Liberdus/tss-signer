# TSS Party Setup Guide

This guide walks all 5 party operators and the coordinator operator through the one-time setup required before the TSS bridge can operate. Each step must be completed in coordination across the team.

---

## Roles

- **Coordinator operator** — runs the coordinator server. Collects public keys from all party operators and deploys the whitelist. The coordinator must be running before keygen can start.
- **Party operators (×5)** — each runs one TSS party node (party 1 through 5). Each operator is assigned a unique party index.

---

## Prerequisites

> **Role: All operators (coordinator operator and all party operators)**

All 5 party operators and the coordinator operator must have a working environment before starting (Node.js, Rust, wasm-pack, PM2, and the built repo). If not already set up, run:

```bash
sudo bash scripts/setup-env.sh
```

Then switch to the `customer` user and navigate to the repo:

```bash
su - customer
cd ~/tss-signer
```

Set the required environment variables before running any party commands. Confirm the correct values with the coordinator operator or your team before proceeding:

```bash
export COORDINATOR_URL=http://<coordinator-ip>:8000
export COLLECTOR_HOST=http://<collector-ip>:3035
export PROXY_SERVER_HOST=http://<proxy-ip>:3030
```

These can also be set in `chain-config.json` if you prefer not to use environment variables.

---

## Coordinator Setup

> **Role: Coordinator operator (admin)**

The coordinator operator must complete this before any party can run keygen.

### Build

> This is handled automatically by `setup-env.sh`. Run the step below only if you need to rebuild after a code update.

```bash
cd ~/tss-signer/coordinator
npm run build
```

### Configure

The coordinator reads `chain-config.json` and `params.json` from the repo root (one level up). Ensure these are filled in with the correct RPC endpoints, contract addresses, and chain IDs before starting.

### Create the allowed-signers whitelist (after collecting keys from Step 1)

Once all 5 party operators have sent you their public keys (see Step 1), create:

**`coordinator/allowed-tss-signers.json`**
```json
{
  "allowedTSSSigners": [
    "<party-1-public-key>",
    "<party-2-public-key>",
    "<party-3-public-key>",
    "<party-4-public-key>",
    "<party-5-public-key>"
  ]
}
```

### Start the coordinator

```bash
# Production
npm start

# With pm2 (keep it running in the background with auto-restart)
pm2 start npm --name "tss-coordinator" -- run tss-coordinator

# Development (auto-restart on file changes)
npm run dev
```

The coordinator listens on port `8000`. On startup it performs an initial on-chain sync (scanning all chains for existing bridge events) before it begins serving pending transactions to party nodes. Wait for the sync to complete before triggering keygen.

> The coordinator must remain running continuously. Party nodes poll it every 10 seconds for pending transactions and route all signing round data through it.

---

## Step 1 — Generate Your Signer Keypair and Share Your Public Key

> **Role: Party operators**

Each operator generates their own Ed25519 keypair independently. This keypair is used to authenticate HTTP requests from your party node to the coordinator.

**Each operator runs on their own machine:**

```bash
node scripts/generate-keypairs.js --party <YOUR_PARTY_INDEX>
```

Replace `<YOUR_PARTY_INDEX>` with your assigned party number (1 through 5). For example, operator 3 runs:

```bash
node scripts/generate-keypairs.js --party 3
```

This writes `keystores/tss_signer_keypair_party_3.json` and prints your public key:

```
[party 3] Keypair written to keystores/tss_signer_keypair_party_3.json
           publicKey: 48eec466b05aa39f8578e12ca64ebfc0cc80c1173c599aa2a0a4210684494c30
```

**Coordinate with your team:**

1. Each operator shares their `publicKey` with whoever manages the coordinator.
2. Once all 5 public keys are collected, the coordinator operator creates (or updates) `coordinator/allowed-tss-signers.json`:

```json
{
  "allowedTSSSigners": [
    "<party-1-public-key>",
    "<party-2-public-key>",
    "<party-3-public-key>",
    "<party-4-public-key>",
    "<party-5-public-key>"
  ]
}
```

3. The coordinator must be running and reachable at `COORDINATOR_URL` before proceeding to Step 2.

> **Keep your `secretKey` private.** Never share it or commit it to version control.

---

## Step 2 — Run Keygen

> **Role: All party operators (simultaneously)**

Keygen generates the distributed key shares. All 5 parties must run this step **at the same time** — they exchange data through the coordinator across 5 rounds.

**Coordinate a start time with all 5 operators.** Once the coordinator is running and all 5 are ready:

**Each operator runs on their own machine:**

```bash
node dist/tss-party.js <YOUR_PARTY_INDEX> --keygen
```

For example, operator 2 runs:

```bash
node dist/tss-party.js 2 --keygen
```

What to expect:
- The process connects to the coordinator and completes 5 cryptographic rounds.
- On success it prints something like `Successfully generated keystores for all N chains` and exits.
- Keystore files are written to `keystores/` for each supported chain, e.g. `keystore_party_2_chainId_80002.json`.

> If any party fails or exits early, all parties must restart keygen together from scratch. Partial keystores are invalid.

---

## Step 3 — Verify Keystores

> **Role: Party operators**

After keygen, each operator independently verifies their keystores are valid and displays the derived EOA addresses. This is a local operation — no coordination needed.

```bash
node dist/tss-party.js <YOUR_PARTY_INDEX> --verify
```

For example:

```bash
node dist/tss-party.js 1 --verify
```

What to check:
- The command completes without errors.
- The EOA address printed for each chain matches what the other operators see (all parties share the same public key / address).
- Share the reported addresses with your team and verify they all match before proceeding.

> If addresses differ between operators, keygen was corrupted. Delete all keystore files and re-run Step 2.

**Back up your keystores immediately after verification.** Once you have confirmed your addresses match the rest of the team, download the keystore files from the server to your local machine for safekeeping:

```bash
# Run this on your local machine
scp -r customer@<server-ip>:~/tss-signer/keystores/ ~/tss-keystore-backup/
```

Each keystore file (e.g. `keystore_party_2_chainId_80002.json`) contains your unique key share. If it is lost, your party can no longer participate in signing and the full keygen process must be repeated with a new TSS address.

---

## Before Starting — Register the TSS Address in the Bridge Contract

> **Role: Contract admin**

Before the parties can submit signed transactions, the shared EOA address derived during keygen must be registered as the authorized `bridgeInCaller` in each bridge contract. This is a contract admin operation — whoever deployed the bridge contracts must perform it.

Provide the coordinator operator (or contract admin) with the verified EOA address from Step 3, and confirm it has been set on all supported chains before proceeding.

> Until this is done, signed `bridgeIn` calls from the TSS parties will be rejected by the contract.

---

## Before Starting — Fund the TSS Address

> **Role: Contract admin**

After the TSS address has been registered in the bridge contracts, it must be funded with native gas tokens on each supported chain. The TSS parties submit on-chain transactions on behalf of the bridge, and each submission consumes gas.

The contract admin is responsible for this. Send a sufficient amount of native token to the verified EOA address on every chain the bridge operates on before starting the parties.

**Recommended starting balance:** enough to cover several hundred transactions. Monitor the balance over time and top it up as needed — if the TSS address runs out of gas funds, bridge transactions will fail.

> The TSS address must have a non-zero balance on each chain before the parties are started. Parties will attempt to submit transactions immediately upon startup if pending work exists.

---

## Step 4 — Start the TSS Party

> **Role: Party operators**

Once all operators have verified their keystores and the TSS address has been registered in the contracts, the parties can be started.

**Option A — all 5 parties on one machine via PM2**

```bash
npm run start-tss
```

This starts all 5 party processes under PM2 (`tss-party-1` through `tss-party-5`) with auto-restart and log rotation.

**Option B — single party via PM2 (one party per machine)**

When each operator runs on a separate machine, start only your own party with PM2:

```bash
pm2 start npm --name "tss-party-<YOUR_PARTY_INDEX>" -- run tss-party -- <YOUR_PARTY_INDEX>
```

For example, operator 3 runs:

```bash
pm2 start npm --name "tss-party-3" -- run tss-party -- 3
```

Save the PM2 process list so it restarts on reboot:

```bash
pm2 save
pm2 startup
```

**Option C — single party directly (no PM2)**

```bash
node dist/tss-party.js <YOUR_PARTY_INDEX>
```

**Useful PM2 commands:**

```bash
npm run status-tss    # check all party process statuses
npm run logs-tss      # stream combined logs
npm run restart-tss   # restart all parties
npm run stop-tss      # stop all parties
```

Individual party logs are at `logs/tss-party-N-out.log` and `logs/tss-party-N-error.log`.

---

## Summary

| Step | Who | Coordination needed |
|---|---|---|
| Coordinator setup | Coordinator operator | Must be running before keygen; update `allowed-tss-signers.json` after collecting keys from all 5 parties |
| 1. Generate keypair | Each party operator independently | Share public keys with coordinator operator |
| 2. Keygen (`--keygen`) | All 5 simultaneously | Agree on start time; coordinator must be running |
| 3. Verify (`--verify`) | Each party operator independently | Share and cross-check EOA addresses across all operators |
| 4. Register TSS address | Contract admin | Set verified EOA as `bridgeInCaller` on all chains |
| 5. Fund TSS address | Contract admin / coordinator operator | Send native gas tokens to TSS address on every supported chain |
| 6. Start party | Each party operator independently | Coordinator must be running; TSS address must be registered and funded |
