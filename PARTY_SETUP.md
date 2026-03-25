# TSS Party Setup Guide

This guide walks all 5 party operators through the one-time setup required before the TSS bridge can operate. Each step must be completed in coordination across the team.

---

## Roles

- **Party operators (×5)** — each runs one TSS party node (party 1 through 5). Each operator is assigned a unique party index.

---

## Prerequisites

> **Role: All party operators**

All 5 party operators must have a working environment before starting (Node.js, PM2, Go if needed, and the built repo). If not already set up, run:

```bash
sudo bash scripts/setup-env.sh
```

Then switch to the `customer` user and navigate to the repo:

```bash
su - customer
cd ~/tss-signer
```

Set the required environment variables before running any party commands. Confirm the correct values with your team before proceeding:

```bash
export COLLECTOR_HOST=http://<collector-ip>:3035
export PROXY_SERVER_HOST=http://<proxy-ip>:3030
export BNB_TSS_PASSWORD=<shared-vault-password>
```

These can also be set in `chain-config.json` if you prefer not to use environment variables.

BNB TSS env requirements:

- `BNB_TSS_PASSWORD` is required for native vault access. It must be present for `tss-init`, `tss-keygen`, `tss-verify`, and `tss-party` startup validation.
- `BNB_TSS_CHANNEL_ID` and `BNB_TSS_CHANNEL_PASSWORD` are required for manual native keygen/regroup/sign commands unless passed explicitly as flags.
- `SHARDUS_CRYPTO_HASH_KEY` is optional for `tss-party`. If you override it, every party must use the same value because signing channel passwords are derived from it.

Example shared native TSS variables for keygen/regroup:

```bash
export BNB_TSS_CHANNEL_ID=<shared-channel-id>
export BNB_TSS_CHANNEL_PASSWORD=<shared-channel-password>
```

---

## Step 1 — Run Native TSS Init

> **Role: All party operators**

Each operator initializes their party home for each chain they participate in:

```bash
npm run tss-init -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

For example:

```bash
npm run tss-init -- --party 2 --chain-id 97
```

---

## Step 2 — Run Keygen

> **Role: All party operators (simultaneously)**

Keygen generates the distributed key shares. All 5 parties must run this step **at the same time**.

**Coordinate a start time with all 5 operators.** Once all 5 are ready:

**Each operator runs on their own machine:**

```bash
npm run tss-keygen -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

For example, operator 2 runs:

```bash
npm run tss-keygen -- --party 2 --chain-id 97
```

What to expect:
- The process runs native TSS keygen for the requested chain and exits on success.
- Native vault files are written under `keystores/bnbtss/party-<idx>/chain-<chainId>/default/`.

> If any party fails or exits early, all parties must restart keygen together from scratch. Partial keystores are invalid.

---

## Step 3 — Verify Keystores

> **Role: Party operators**

After keygen, each operator independently verifies their native vaults are valid and displays the derived EOA addresses. This is a local operation — no coordination needed.

```bash
npm run tss-verify -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

For example:

```bash
npm run tss-verify -- --party 1 --chain-id 97
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

Each native vault contains your unique key share. If it is lost, your party can no longer participate in signing and the full keygen process must be repeated with a new TSS address.

---

## Before Starting — Register the TSS Address in the Bridge Contract

> **Role: Contract admin**

Before the parties can submit signed transactions, the shared EOA address derived during keygen must be registered as the authorized `bridgeInCaller` in each bridge contract. This is a contract admin operation — whoever deployed the bridge contracts must perform it.

Provide the contract admin with the verified EOA address from Step 3, and confirm it has been set on all supported chains before proceeding.

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

Individual party logs are at `logs/tss-party-N-combined.log`.

---

## Summary

| Step | Who | Coordination needed |
|---|---|---|
| 1. Init (`tss-init`) | Each party operator independently | No, but all required chains should be initialized before keygen |
| 2. Keygen (`tss-keygen`) | All 5 simultaneously | Agree on start time |
| 3. Verify (`tss-verify`) | Each party operator independently | Share and cross-check EOA addresses across all operators |
| 4. Register TSS address | Contract admin | Set verified EOA as `bridgeInCaller` on all chains |
| 5. Fund TSS address | Contract admin | Send native gas tokens to TSS address on every supported chain |
| 6. Start party | Each party operator independently | TSS address must be registered and funded |
