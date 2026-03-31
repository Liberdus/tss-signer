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

### Firewall / Port Requirements

Each party needs one inbound TCP port open for P2P communication. The signing port formula is:

```
signingPort = 40000 + (chainId % 1000) * 10 + partyIndex
```

Examples:

| Chain | Party 1 | Party 2 | Party 3 | Party 4 | Party 5 |
|---|---|---|---|---|---|
| BSC Testnet (97) | 40971 | 40972 | 40973 | 40974 | 40975 |
| Polygon Amoy (80002) | 40022 | 40023 | 40024 | 40025 | 40026 |

For **regroup** sessions, `--is-old` parties also need their regroup listen port open:

```
regroupPort = signingPort + 1000
```

(e.g. for chain-97, party 1 regroup port = 41971)

> You can calculate your port now using the formula above, or confirm the exact value from the `listen_addr` field after running `tss-init` in Step 1. Once you have the port, open it using the commands below.

**To open a port using `ufw` (Ubuntu):**

```bash
sudo ufw allow <PORT>/tcp
sudo ufw reload
```

For example, party 2 on chain-97:

```bash
sudo ufw allow 40972/tcp
sudo ufw reload
```

If your VPS uses a cloud firewall (AWS Security Groups, GCP Firewall Rules, DigitalOcean Firewall, etc.), add the same inbound TCP rule there as well — `ufw` alone is not sufficient if a cloud-level firewall is in front of the machine.

### Environment Variables

Set the required environment variables before running any party commands.

**Shared team configuration — confirm these values with your team:**

```bash
export COLLECTOR_HOST=http://<collector-ip>:3035
export PROXY_SERVER_HOST=http://<proxy-ip>:3030
```

These can also be set in `chain-config.json` if you prefer not to use environment variables.

**Personal credential — set this yourself, never share it with other operators:**

```bash
export BNB_TSS_PASSWORD=<your-own-vault-password>
```

`BNB_TSS_PASSWORD` encrypts your key share on disk. Choose a strong password, store it securely (e.g. a password manager), and keep it private. If you lose it, your vault cannot be decrypted and keygen must be repeated. All `tss-*` commands read it from this env var automatically — you do not need to pass `--password` on the command line.

Additional env vars:

- `BNB_TSS_CHANNEL_ID` and `BNB_TSS_CHANNEL_PASSWORD` — **shared session credentials** used only during keygen and regroup. Coordinated with the team; can be passed as flags or exported as env vars.
- `SHARDUS_CRYPTO_HASH_KEY` — **recommended for production.** Signing channel passwords are derived from this value, so every party must use the same key. Generate a strong random value for your deployment and share it with all operators:
  ```bash
  openssl rand -hex 32
  ```
  If not set, a default fallback is used — do not rely on the default in production.

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

This creates the vault directory at `keystores/bnbtss/party-<N>/chain-<CHAIN_ID>/default/` and writes the initial `node_key`. On success, it prints a JSON summary including the port the party will listen on:

```json
{"party":2,"chainId":97,"home":"keystores/bnbtss/party-2/chain-97","vault":"default","listen_addr":"/ip4/0.0.0.0/tcp/40972","moniker":"tss_party-2-chain-97_default"}
```

The `listen_addr` port is derived from the formula `40000 + (chainId % 1000) * 10 + partyIndex`. Confirm this matches the port you opened in the firewall (see [Firewall / Port Requirements](#firewall--port-requirements)).

To display only the listen address from the vault config at any time:

```bash
cat keystores/bnbtss/party-<YOUR_PARTY_INDEX>/chain-<CHAIN_ID>/default/config.json | grep '"listen"'
```

For example, party 2 on chain-97:

```bash
cat keystores/bnbtss/party-2/chain-97/default/config.json | grep '"listen"'
# Output: "listen": "/ip4/0.0.0.0/tcp/40972",
```

---

## Step 2 — Share Peer Addresses

> **Role: All party operators (coordination step)**

Keygen requires each party to know the real public IP of every other party before starting. This coordination must happen before Step 4.

**Each operator shares with the group:**
- Their assigned party index
- Their machine's public IP address
- Their signing port (from the `listen_addr` in the `tss-init` output, or calculated as `40000 + (chainId % 1000) * 10 + partyIndex`)

Once all 5 IPs are collected, one operator should prepare the ordered party IP list (sorted by party index) that will be used for Step 4.

Example ordered list for parties 1-5 on chain-97:

```
["10.0.1.1","10.0.1.2","10.0.1.3","10.0.1.4","10.0.1.5"]
```

Each operator should receive the same one-liner to create `keygen-config.json` locally. The Step 4 wrapper derives the correct `--peer-addrs` automatically and excludes the local party's own address.

---

## Step 3 — Manual Channel ID (Optional)

> **Role: One designated operator (shared with all, only for manual keygen/regroup)**

If you use the assisted Step 4 wrapper (`npm run tss-keygen-ceremony`), skip this step. The wrapper derives deterministic keygen channel credentials from the shared IP list plus `--nonce`.

One operator (any party) generates a shared channel ID with a 30-minute expiry:

```bash
./tss/.tooling/bin/tss channel --channel_expire 30
```

Example output:
```
channel id: 82469B4FB12
```

Share the channel ID with all other operators. Also agree on a shared channel password — this is simply a string you choose together as a team (e.g. `keygen2025`). It is not generated by the binary.

All parties export these before running keygen:

```bash
export BNB_TSS_CHANNEL_ID=<channel-id-from-above>
export BNB_TSS_CHANNEL_PASSWORD=<agreed-channel-password>
```

---

## Step 4 — Run Keygen

> **Role: All party operators (simultaneously)**

Keygen generates the distributed key shares. All 5 parties must run this step **at the same time**.

Before running, make sure `params.json` in the repo root reflects the committee size you are about to use:

```json
{"parties": 5, "threshold": 3}
```

`--parties` and `--threshold` are optional for direct `tss-keygen`, but the long-lived `tss-party` process also reads `params.json` at startup, so the file must match the actual committee. Update it and recompile (`npm run compile`) if the values differ. The assisted wrapper in this step also warns if `params.json` does not match the derived committee.

### Recommended: assisted keygen wrapper

One operator shares a one-liner that writes the same `keygen-config.json` on every machine. The file contains the chain id and the ordered party IP list.

Example one-liner for chain-97:

```bash
cat > ~/tss-signer/keygen-config.json <<'EOF'
{"chainId":97,"partyIps":["10.0.1.1","10.0.1.2","10.0.1.3","10.0.1.4","10.0.1.5"]}
EOF
```

**Coordinate a start time with all 5 operators.** Once all 5 are ready, each operator runs on their own machine:

```bash
npm run tss-keygen-ceremony -- --nonce 1
```

The wrapper:
- Prompts for `BNB_TSS_PASSWORD` and verifies it can unlock the already-initialized local vault before starting keygen.
- Derives `parties` from the number of IPs in `keygen-config.json`.
- Derives `threshold = floor(parties / 2)`.
- Detects the local `partyIndex` by matching the machine's public IPv4 to the ordered IP list.
- Derives the correct `--peer-addrs` list automatically, excluding the local party's own address.
- Derives deterministic keygen `channelId` and `channelPassword` from `chainId + ordered partyIps + nonce`.
- Sets the channel id expiry to the next `00:00:00 UTC`, and prints that expiry before launching keygen.

If local IP detection fails, pass the party index explicitly:

```bash
npm run tss-keygen-ceremony -- --nonce 1 --party <YOUR_PARTY_INDEX>
```

Use a fresh nonce for every retry:

```bash
npm run tss-keygen-ceremony -- --nonce 2
```

> Avoid starting keygen right around `00:00 UTC`. If some servers compute the channel id on one UTC date and others on the next, they will derive different channel ids.

### Fallback: direct manual `tss-keygen`

If you need to run the native keygen command directly, follow Step 2 to build `--peer-addrs` yourself and Step 3 to coordinate `BNB_TSS_CHANNEL_ID` and `BNB_TSS_CHANNEL_PASSWORD`, then run:

```bash
npm run tss-keygen -- \
  --party <YOUR_PARTY_INDEX> \
  --chain-id <CHAIN_ID> \
  --peer-addrs "<OTHER_PARTIES_MULTIADDRS>" \
  --no-local-peer-addrs \
  --channel-id <SHARED_CHANNEL_ID> \
  --channel-password <SHARED_CHANNEL_PASSWORD>
```

> `BNB_TSS_PASSWORD` is still picked up automatically in both flows — no `--password` flag needed.

What to expect:
- The process runs the native TSS keygen ceremony and exits on success.
- Native vault files are written under `keystores/bnbtss/party-<idx>/chain-<chainId>/default/`.
- On success, a JSON object is printed including `ethereum_address`. All parties should see the same address.

> **Note:** Using real public IPs in `--peer-addrs` bakes the correct remote addresses directly into the vault — signing will work across machines without any extra steps. If you ever need to update the addresses after the fact (e.g. a machine's IP changes), use the `patch-peer-addrs` tool described in `tss-tools/guide.md` section 20.

> If any party fails or exits early, all parties must restart keygen together from scratch. Partial keystores are invalid.

---

## Step 5 — Verify Keystores

> **Role: Party operators**

After keygen, each operator independently verifies their native vaults are valid and displays the derived EOA addresses. This is a local operation — no coordination needed.

```bash
npm run tss-verify -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

For example:

```bash
npm run tss-verify -- --party 2 --chain-id 97
```

What to check:
- The command completes without errors.
- The EOA address printed for each chain matches what the other operators see (all parties share the same public key / address).
- Share the reported addresses with your team and verify they all match before proceeding.

> If addresses differ between operators, keygen was corrupted. Delete all keystore files and re-run Step 4.

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

Provide the contract admin with the verified EOA address from Step 5, and confirm it has been set on all supported chains before proceeding.

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
    "http://<party-2-ip>:8102",
    "http://<party-3-ip>:8103",
    "http://<party-4-ip>:8104",
    "http://<party-5-ip>:8105"
]
```

Each observer binds to port `8100 + partyIndex` on its machine. If all parties run on the same machine, `127.0.0.1` works for all entries. For separate machines, use each party's actual public IP.

If the proxy server is on a different machine from the party operators, each observer's HTTP port (8101–8105) must be reachable from the proxy — open those ports in the firewall on each party machine (see [Firewall / Port Requirements](#firewall--port-requirements)).

Restart the Liberdus proxy after updating the config.

---

## Step 6 — Start the Observer and TSS Party

> **Role: Party operators**

Once all operators have verified their keystores and the TSS address has been registered in the contracts, the parties can be started.

Each party index runs **two** paired processes: an **observer** (on-chain monitor) and a **TSS party** (signer). Both must be running for the bridge to operate.

**Option A — all 5 parties on one machine via PM2**

```bash
npm run start-tss
```

This starts all 10 processes under PM2 — `observer-1` through `observer-5` and `tss-party-1` through `tss-party-5` — with auto-restart and log rotation.

**Option B — single party per machine via PM2**

When each operator runs on a separate machine, start only your own observer and TSS party using `ecosystem.config.js` with `--only`. This picks up all memory limits, node args, and env vars from the config automatically.

```bash
pm2 start ecosystem.config.js --only observer-<YOUR_PARTY_INDEX>
pm2 start ecosystem.config.js --only tss-party-<YOUR_PARTY_INDEX>
```

For example, operator 3 runs:

```bash
pm2 start ecosystem.config.js --only observer-3
pm2 start ecosystem.config.js --only tss-party-3
```

Save the PM2 process list so it restarts on reboot:

```bash
pm2 save
pm2 startup
```

**Option C — directly (no PM2, for debugging)**

```bash
# In one terminal: start the observer
PARTY_INDEX=<YOUR_PARTY_INDEX> node dist/observer/index.js

# In another terminal: start the TSS party
node dist/scripts/tss-party.js <YOUR_PARTY_INDEX>
```

**Useful PM2 commands:**

```bash
# Single-party machine — use process names directly
pm2 restart observer-<N> tss-party-<N>
pm2 stop observer-<N> tss-party-<N>
pm2 logs observer-<N>
pm2 logs tss-party-<N>

# All-on-one-machine setup
npm run status-tss              # check all process statuses
npm run logs-tss                # stream combined logs
npm run restart-tss             # restart all 10 processes
npm run restart-tss:observers   # restart observer-1..5
npm run restart-tss:tss-parties # restart tss-party-1..5
npm run stop-tss                # stop all processes
```

Log files are at:
- `logs/observer-N-combined.log`
- `logs/tss-party-N-combined.log`

---

## Regroup (Replacing a Party or Changing the Threshold)

> **Role: Party operators (coordination required)**

Regroup redistributes key shares to a new committee without changing the TSS Ethereum address. Use it when:
- A party operator is leaving and needs to be replaced
- The signing threshold needs to change
- The committee size is expanding or shrinking

Regroup requires at least `oldThreshold + 1` old participants.

### Roles: old vs new

Each participating party is either:
- **`--is-old`** — existing committee member that also remains in the new committee
- **`--is-new-member`** — newly added member that was **not** in the old committee

A party that is leaving simply does not participate — it does not run any regroup command.

### New-only members: init first

Before the regroup session, new-only members must initialize their vault:

```bash
npm run tss-init -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

### Generate a regroup channel ID

One operator generates a new channel ID (same process as Step 3) and shares it with all participants before starting.

### Peer address structure for regroup

Regroup uses `--new-peer-addrs` (not `--peer-addrs`). The number of addresses must be exactly:

```
n = OldThreshold + NewParties
```

For the standard 5-party / threshold-3 production committee (`5p/t3 → 5p/t3`, replacing one party): `n = 3 + 5 = 8` addresses per party.

Each party's address list is built from three groups:

| Group | Port | Who | `--is-old` count | `--is-new-member` count |
|---|---|---|---|---|
| Old committee participants (excl. self if `--is-old`) | Signing port | Parties in the old committee that are participating | `t` | `t+1` |
| Carry-over members (in both old and new, incl. self if `--is-old`) | **Regroup port** (= signing port + 1000) | Parties in both old and new committee | `t+1` | `t+1` |
| New-only members (excl. self if `--is-new-member`) | Signing port | Parties only in the new committee | `NewParties-(t+1)` | `NewParties-(t+1)-1` |

Total for any party = `OldThreshold + NewParties` ✓

> `--is-old` parties listen on their regroup port and must have it open in the firewall. The `regroup.ts` wrapper adds `--p2p.new_listen` automatically for these parties.

> `--is-new-member` parties are contacted on their signing port and do not need a separate regroup listen port.

### Example: 5p/t3 → 5p/t3, replacing party 5

Setup:
- Old committee: parties 1–5 (threshold 3), parties 1–4 are participating, party 5 is leaving
- New committee: parties 1–4 (carry-over) + party 5 (new operator)
- `n = 3 + 5 = 8` per party
- IPs: party1=10.0.1.1, party2=10.0.1.2, party3=10.0.1.3, party4=10.0.1.4, party5(new)=10.0.1.5
- Chain-97 signing ports: 40971–40975, regroup ports: 41971–41975

**Per-party `--new-peer-addrs`:**

| Party | Role | Addresses |
|---|---|---|
| 1 | `--is-old` | `10.0.1.2:40972, 10.0.1.3:40973, 10.0.1.4:40974` (old non-self, signing) + `10.0.1.1:41971, 10.0.1.2:41972, 10.0.1.3:41973, 10.0.1.4:41974` (carry-over incl. self, regroup) + `10.0.1.5:40975` (new-only, signing) |
| 2 | `--is-old` | `10.0.1.1:40971, 10.0.1.3:40973, 10.0.1.4:40974` + `10.0.1.1:41971, 10.0.1.2:41972, 10.0.1.3:41973, 10.0.1.4:41974` + `10.0.1.5:40975` |
| 3 | `--is-old` | `10.0.1.1:40971, 10.0.1.2:40972, 10.0.1.4:40974` + `10.0.1.1:41971, 10.0.1.2:41972, 10.0.1.3:41973, 10.0.1.4:41974` + `10.0.1.5:40975` |
| 4 | `--is-old` | `10.0.1.1:40971, 10.0.1.2:40972, 10.0.1.3:40973` + `10.0.1.1:41971, 10.0.1.2:41972, 10.0.1.3:41973, 10.0.1.4:41974` + `10.0.1.5:40975` |
| 5 | `--is-new-member` | `10.0.1.1:40971, 10.0.1.2:40972, 10.0.1.3:40973, 10.0.1.4:40974` (all old, signing) + `10.0.1.1:41971, 10.0.1.2:41972, 10.0.1.3:41973, 10.0.1.4:41974` (carry-over, regroup) |

**Command for `--is-old` parties (parties 1–4):**

```bash
# Example for party 1
npm run tss-regroup -- \
  --party 1 \
  --chain-id 97 \
  --parties 5 \
  --threshold 3 \
  --new-parties 5 \
  --new-threshold 3 \
  --is-old \
  --new-peer-addrs "/ip4/10.0.1.2/tcp/40972,/ip4/10.0.1.3/tcp/40973,/ip4/10.0.1.4/tcp/40974,/ip4/10.0.1.1/tcp/41971,/ip4/10.0.1.2/tcp/41972,/ip4/10.0.1.3/tcp/41973,/ip4/10.0.1.4/tcp/41974,/ip4/10.0.1.5/tcp/40975" \
  --channel-id <SHARED_CHANNEL_ID> \
  --channel-password <SHARED_CHANNEL_PASSWORD>
```

**Command for the new-only party (party 5):**

```bash
npm run tss-regroup -- \
  --party 5 \
  --chain-id 97 \
  --parties 5 \
  --threshold 3 \
  --new-parties 5 \
  --new-threshold 3 \
  --is-new-member \
  --new-peer-addrs "/ip4/10.0.1.1/tcp/40971,/ip4/10.0.1.2/tcp/40972,/ip4/10.0.1.3/tcp/40973,/ip4/10.0.1.4/tcp/40974,/ip4/10.0.1.1/tcp/41971,/ip4/10.0.1.2/tcp/41972,/ip4/10.0.1.3/tcp/41973,/ip4/10.0.1.4/tcp/41974" \
  --channel-id <SHARED_CHANNEL_ID> \
  --channel-password <SHARED_CHANNEL_PASSWORD>
```

After regroup completes successfully, verify the `ethereum_address` is unchanged across all parties:

```bash
npm run tss-verify -- --party <YOUR_PARTY_INDEX> --chain-id <CHAIN_ID>
```

Then restart your TSS party process:

```bash
pm2 restart tss-party-<YOUR_PARTY_INDEX>
```

---

## Summary

| Step | Who | Coordination needed |
|---|---|---|
| 1. Init (`tss-init`) | Each operator independently | No, but complete for all chains before keygen |
| 2. Share peer addresses | All party operators | Everyone shares their public IP + party index; one operator prepares the ordered IP list |
| 3. Manual channel ID (optional) | One operator, shared with all | Needed only for direct `tss-keygen` / regroup, not for `tss-keygen-ceremony` |
| 4. Keygen (`tss-keygen-ceremony`) | All 5 simultaneously | Agree on start time; all operators use the same `keygen-config.json` and nonce |
| 5. Verify (`tss-verify`) | Each operator independently | Share and cross-check EOA addresses across all parties |
| 6. Register TSS address | Contract admin | Set verified EOA as `bridgeInCaller` on all chains |
| 7. Fund TSS address | Contract admin | Send native gas tokens to TSS address on every supported chain |
| 8. Configure proxy `observer_urls` | Proxy admin | Update `config.json` with each party's real IP + observer port; restart proxy |
| 9. Start observer + party | Each operator independently | TSS address must be registered, funded, and proxy configured; both processes required |
| Regroup (when needed) | Old + new members | Coordinate channel ID and per-party 8-addr lists; `threshold+1` old members required |
