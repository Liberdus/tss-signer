# TSS Party Setup Guide

This guide walks all 5 party operators through the one-time setup required before the TSS bridge can operate. Each step must be completed in coordination across the team.

---

## Roles

- **Party operators (×5)** — each runs one TSS party node (party 1 through 5). Each operator is assigned a unique party index.

---

## Prerequisites

> **Role: All party operators**

All 5 party operators must have a working environment before starting. If not already set up, run the environment setup script as root — it installs all dependencies and builds the repo automatically.

**On a fresh machine (run as root):**

```bash
curl -fsSL https://raw.githubusercontent.com/Liberdus/tss-signer/main/scripts/setup-env.sh -o setup-env.sh
bash setup-env.sh
```

**If you already have the repo cloned locally:**

```bash
bash scripts/setup-env.sh
```

The script creates a `customer` user, installs NVM, Node.js v20, PM2, clones the repo, compiles TypeScript, and builds the native BNB TSS binary.

To allow SSH login directly as `customer`, pass your local machine's public key when running the script:

```bash
CUSTOMER_SSH_AUTHORIZED_KEY='<your-public-key>' bash setup-env.sh
```

Your public key can be found with `cat ~/.ssh/<your-key>.pub` on your local machine.

Then switch to the `customer` user and navigate to the repo:

```bash
su - customer
cd ~/tss-signer
```

### Environment Variables

**Optional but recommended for production:**

```bash
export SHARDUS_CRYPTO_HASH_KEY=<shared-random-hex>
```

Signing channel passwords are derived from this value, so every party must use the same key. Generate a strong random value and share it with all operators:

```bash
openssl rand -hex 32
```

If not set, a default fallback is used — do not rely on the default in production.

---

## Step 1 — Create the Keygen Config

> **Role: One designated operator (shared with all)**

One operator prepares a shared `keygen-config.json` containing the chain ID and the ordered public IP list for all 5 parties. The order determines each party's index.

Example one-liner for chain-97:

```bash
cat > ~/tss-signer/keygen-config.json <<'EOF'
{"chainId":97,"partyIps":["10.0.1.1","10.0.1.2","10.0.1.3","10.0.1.4","10.0.1.5"]}
EOF
```

Share this exact one-liner with all operators so every machine has the same file contents. Each operator runs it on their own machine.

Rules:
- `partyIps` must be in the agreed committee order (position = party index)
- every machine must use the same file contents
- the local machine's public IP must appear exactly once in `partyIps`

---

## Step 2 — Run Connectivity Check

> **Role: All party operators (simultaneously)**

Before running keygen, confirm that every party can reach every other party on the derived TSS listen port.

Each operator runs on their own machine:

```bash
npm run tss-connectivity-check
```

The check:
- Resolves the machine's committee position from `partyIps`
- Derives the expected listen port from the chain ID
- Opens a listener on that port and keeps it running until you exit
- Runs one outbound connectivity pass against every other party on that port
- Prints one clear line for each successful connection in both directions
- Prints a compact status table with inbound, outbound, and ready columns
- Prompts whether to exit or run another round while leaving the listener open

If one operator starts early and another starts later, the early operator can leave the script running, then choose to run the check again after the later operator connects.

Wait for every operator to see:

```text
Overall: ✓ <N>/<N> peers ready
```

If any operator still sees `X` values in the status table, stop and fix the reported connectivity issue before attempting keygen. Common causes are:
- the wrong IP address in `keygen-config.json`
- the required port is not open in `ufw`
- the required port is blocked by a cloud firewall

If needed, you can override the derived port:

```bash
npm run tss-connectivity-check -- --port <PORT>
```

---

## Step 3 — Run Keygen Ceremony

> **Role: All party operators (simultaneously)**

Coordinate a start time with all 5 operators. Once everyone is ready, each operator runs on their own machine:

```bash
npm run tss-keygen-ceremony -- --nonce 1
```

The wrapper:
- Detects the machine's local/public IPv4 and resolves its committee position from `partyIps`
- Prompts for your vault password. For a new vault it asks twice (enter + confirm) — keep it safe. On success it prints an `export BNB_TSS_PASSWORD=...` reminder; run that in your terminal so the TSS party process can pick it up
- Initializes the vault automatically if it does not yet exist, or verifies the password if it does
- Derives `parties` and `threshold = floor(parties / 2)` from the config and overwrites `params.json`
- Computes the correct `--peer-addrs` list (excluding self)
- Derives deterministic channel credentials from `chainId + partyIps + nonce` — no manual coordination needed
- Prints the resolved configuration and prompts for confirmation before launching keygen

Use a fresh nonce for every retry:

```bash
npm run tss-keygen-ceremony -- --nonce 2
```

> Avoid starting right around `00:00 UTC` — the deterministic channel ID expires at the next UTC midnight. If some operators cross the boundary before others, they will derive different channel IDs.

> If any party fails or exits early, all parties must restart keygen together with a new nonce. Partial keystores are invalid.

The ceremony prints the resolved `listen addr` before launching keygen. If it did not print or you need to check it later, see [Firewall / Port Requirements](#firewall--port-requirements) for how to read it from the vault.

---

## Step 4 — Verify Keystores

> **Role: Party operators**

After keygen, each operator independently verifies their vault and displays the derived EOA address. No coordination needed for the command itself.

```bash
npm run tss-verify -- --chain-id <CHAIN_ID>
```

`tss-verify` reads `chainId` from the shared `keygen-config.json` if `--chain-id` is omitted.

What to check:
- The command completes without errors.
- The EOA address printed matches what the other operators see — all parties share the same public key / address.
- Share the reported address with your team and verify they all match before proceeding.

> If addresses differ between operators, keygen was corrupted. Delete all keystore files and re-run Step 2.

**Back up your keystores immediately after verification.** Once addresses are confirmed, download the keystore files from the server to your local machine for safekeeping:

```bash
# Run this on your local machine
scp -r customer@<server-ip>:~/tss-signer/keystores/ ~/tss-keystore-backup/
```

Each vault contains your unique key share. If it is lost, your party can no longer participate in signing and the full keygen process must be repeated with a new TSS address.

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

**Recommended starting balance:** enough to cover several hundred transactions. Monitor the balance over time and top it up as needed — if the TSS address runs out of gas funds, bridge transactions will fail.

> The TSS address must have a non-zero balance on each chain before the parties are started. Parties will attempt to submit transactions immediately upon startup if pending work exists.

---

## Before Starting — Configure the Liberdus Proxy

> **Role: Proxy admin**

The Liberdus proxy server must be configured with the observer URL for each party before the bridge can route transactions. Open the proxy's `config.json` and update `observer_urls` with the real IP address (or hostname) of each party machine:

```json
"observer_urls": [
    "http://<party-1-ip>:8101",
    "http://<party-2-ip>:8101",
    "http://<party-3-ip>:8101",
    "http://<party-4-ip>:8101",
    "http://<party-5-ip>:8101"
]
```

Each machine runs one party, so the observer always binds to port `8101`. Each observer's HTTP port must be reachable from the proxy — open port `8101` in the firewall on each party machine.

Restart the Liberdus proxy after updating the config.

---

## Step 5 — Start the Observer and TSS Party

> **Role: Party operators**

Once all operators have verified their keystores and the TSS address has been registered in the contracts, the parties can be started.

Each party index runs **two** paired processes: an **observer** (on-chain monitor) and a **TSS party** (signer). Both must be running for the bridge to operate.

Start both processes using the remote config:

```bash
pm2 start ecosystem.remote.config.js --only observer
pm2 start ecosystem.remote.config.js --only tss-party
```

Save the PM2 process list so it restarts on reboot:

```bash
pm2 save
pm2 startup
```

**For debugging (no PM2):**

```bash
# In one terminal: start the observer
PARTY_INDEX=1 node dist/observer/index.js

# In another terminal: start the TSS party
node dist/scripts/tss-party.js
```

**Useful PM2 commands:**

```bash
pm2 restart observer tss-party
pm2 stop observer tss-party
pm2 logs observer
pm2 logs tss-party
```

Log files are at:
- `logs/observer-combined.log`
- `logs/tss-party-combined.log`

---

## Regroup (Replacing a Party or Changing the Threshold)

> **Role: Party operators (coordination required)**

Regroup redistributes key shares to a new committee without changing the TSS Ethereum address. Use it when:
- A party operator is leaving and needs to be replaced
- The signing threshold needs to change
- The committee size is expanding or shrinking

Regroup requires at least `oldThreshold + 1` old participants.

### New-only members: initialize vault first

If your machine was not part of the previous keygen, you need a vault before participating. Run the keygen ceremony wrapper on your machine with a `keygen-config.json` pointing only to your machine (or use `tss-init` directly) to initialize a local vault, then proceed to the regroup ceremony.

### Create the regroup config

One operator prepares a shared `regroup-config.json` and distributes it to all participants:

```bash
cat > ~/tss-signer/regroup-config.json <<'EOF'
{
  "chainId": 97,
  "oldPartyIps": ["10.0.1.1","10.0.1.2","10.0.1.3"],
  "newPartyIps": ["10.0.1.1","10.0.1.2","10.0.1.3","10.0.1.4","10.0.1.6"],
  "oldThreshold": 2,
  "newThreshold": 3
}
EOF
```

- `oldPartyIps` — IPs of the active old participants for this regroup
- `oldPartyIps.length` must equal `oldThreshold + 1`
- every `oldPartyIp` must also appear in `newPartyIps`
- `newPartyIps` — ordered IPs of the incoming committee
- Every participating machine must use the same file contents

### Run the regroup ceremony

Coordinate a start time, then each participating machine runs:

```bash
npm run tss-regroup-ceremony -- --nonce 1
```

The wrapper:
- Detects the machine's committee position from `newPartyIps`
- Determines automatically whether this machine is `--is-old` or `--is-new-member`
- Verifies the vault password against the local vault
- Derives deterministic channel credentials from the config plus `--nonce`
- Computes `--new-peer-addrs` from the active old participant set plus the ordered new committee automatically
- Prints the resolved configuration and prompts for confirmation before launching regroup

Use a fresh nonce for every retry.

### After regroup

Verify the EOA address is unchanged across all parties:

```bash
npm run tss-verify -- --chain-id <CHAIN_ID>
```

Then restart your TSS party process:

```bash
pm2 restart tss-party
```

---

## Summary

| Step | Who | Coordination needed |
|---|---|---|
| 1. Create `keygen-config.json` | One operator prepares, all operators apply | Share exact one-liner; agree on party IP order |
| 2. Connectivity check (`tss-connectivity-check`) | All 5 simultaneously | Same config on all machines; all parties must pass before keygen |
| 3. Keygen (`tss-keygen-ceremony`) | All 5 simultaneously | Agree on start time and nonce; same config on all machines |
| 4. Verify (`tss-verify`) | Each operator independently | Share and cross-check EOA address across all parties |
| Register TSS address | Contract admin | Set verified EOA as `bridgeInCaller` on all chains |
| Fund TSS address | Contract admin | Send native gas tokens to TSS address on every supported chain |
| Configure proxy `observer_urls` | Proxy admin | Update `config.json` with each party's real IP + observer port; restart proxy |
| 5. Start observer + party | Each operator independently | TSS address must be registered, funded, and proxy configured; both processes required |
| Regroup (when needed) | Old + new members | Share `regroup-config.json`; `threshold+1` old members required |

---

## Firewall / Port Requirements

Each party needs one inbound TCP port open for P2P communication. The keygen ceremony prints the `listen addr` before launching — use that port. If you need to check it after the fact:

```bash
cat keystores/bnbtss/chain-<CHAIN_ID>/default/config.json | grep '"listen"'
# Output: "listen": "/ip4/0.0.0.0/tcp/40971",
```

Open that port:

```bash
sudo ufw allow <PORT>/tcp
sudo ufw reload
```

If your VPS uses a cloud firewall (AWS Security Groups, GCP Firewall Rules, DigitalOcean Firewall, etc.), add the same inbound TCP rule there as well — `ufw` alone is not sufficient if a cloud-level firewall is in front of the machine.

After opening the port, rerun:

```bash
npm run tss-connectivity-check
```

Do not proceed to keygen until every operator sees `Connectivity check passed.`
