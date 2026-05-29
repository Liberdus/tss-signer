# BNB TSS Operator Guide

# Repo
cd ~/tss-signer

# Current code path
# scripts/tss-party.ts uses native BNB TSS signing by default.
#
# User-facing party indices start at 1.

# Preferred remote multi-machine flow
#
# For remote multi-IP testing with the ceremony wrappers, see:
#   tss-tools/keygen-regroup-ceremony.md
#
# That doc covers:
# - shared `keygen-config.json` / `regroup-config.json`
# - `npm run tss-connectivity-check`
# - `npm run tss-keygen-ceremony -- --nonce <n>`
# - `npm run tss-regroup-ceremony -- --nonce <n>`
#
# For the broader production/operator procedure, including observer/tss-party
# startup and bridge integration steps, see:
#   PARTY_SETUP.md


# 1) Install Node dependencies
npm install


# 2) Build the TypeScript party script
npm run compile


# 3) Ensure the Liberdus forked bnb-chain/tss submodule is present
git submodule update --init --recursive

# 4) Bootstrap the vendored Go toolchain if build says Go is missing
./tss-tools/setup-mise-go.sh

# Supported bootstrap platforms:
# - macos-arm64
# - macos-x64
# - linux-x64
# - linux-arm64
# Windows is not supported by this bootstrap flow.

# 5) Build the native tss binary
./tss-tools/build-tss.sh

# Expected output:
# Built /.../tss-signer/tss/.tooling/bin/tss


# 6) Create a channel id for a shared signing/keygen session
./tss/.tooling/bin/tss channel --channel_expire 30

# Example output:
# channel id: 82469B4FB12


# 7) Export shared environment for all participating parties
export TSS_PASSWORD_CHAIN_<chainId>=1234567890
export BNB_TSS_CHANNEL_ID=<replace_with_channel_id>
export BNB_TSS_CHANNEL_PASSWORD=1234567890

# Required envs by flow:
# - TSS_PASSWORD_CHAIN_<chainId>:
#   required for init, keygen, verify, and tss-party startup validation.
#   If missing, startup fails with:
#   BNB TSS vault password is required (TSS_PASSWORD_CHAIN_<chainId>)
# - BNB_TSS_CHANNEL_ID:
#   required for manual native keygen/regroup/sign commands unless passed via flags
# - BNB_TSS_CHANNEL_PASSWORD:
#   required for manual native keygen/regroup/sign commands unless passed via flags
# - SHARDUS_CRYPTO_HASH_KEY:
#   optional override for deterministic signing channel passwords used by tss-party.
#   If you set it, all parties must share the same value.
#
# The long-lived tss-party signer derives a deterministic signing channel id from
# each txId + txTimestamp. Keep BNB_TSS_CHANNEL_ID for manual native
# keygen/regroup flows and ad-hoc direct tss signing.
# The long-lived tss-party signer also derives a deterministic signing channel
# password from channelId + SHARDUS_CRYPTO_HASH_KEY.


# 8) Key storage layout used by tss-signer native mode
# Default single-bundle-per-machine flow:
# keystores/bnbtss/chain-<chainId>/default/
#
# Example:
# keystores/bnbtss/chain-97/default/
#
# Default deployment model:
# - one machine runs one signer bundle
# - keygen/regroup ceremony wrappers use the clean chain-scoped path by default
# - `tss-party` also defaults to that path when no CLI party index is passed
# - existing legacy vaults under `party-1/chain-<id>` are still accepted via fallback
# - explicit `--party N` flows remain available for multi-party local testing and legacy indexed setups
# - explicit indexed/manual flows still use:
#   keystores/bnbtss/party-<idx>/chain-<chainId>/default/

# Committee size defaults come from params.json.
# Current file:
#   params.json => {"parties":5,"threshold":3}
#
# That means normal tss-signer runs should use:
# - 5 parties for keygen
# - threshold 3 for signing / regroup expectations
#
# Only override --parties / --threshold for local debugging when you intentionally
# want a smaller temporary committee.


# 9) Manual indexed flow for local testing / debugging
# The helper initializes the party home with a deterministic local listen port:
#   port = 40000 + ((chainId % 1000) * 10) + partyIdx

# Example: BSC Testnet chainId 97
# For the current params.json you should initialize all 5 parties:
npm run tss-init -- --party 1 --chain-id 97
npm run tss-init -- --party 2 --chain-id 97
npm run tss-init -- --party 3 --chain-id 97
npm run tss-init -- --party 4 --chain-id 97
npm run tss-init -- --party 5 --chain-id 97

# Example: Polygon Amoy chainId 80002
npm run tss-init -- --party 1 --chain-id 80002
npm run tss-init -- --party 2 --chain-id 80002
npm run tss-init -- --party 3 --chain-id 80002
npm run tss-init -- --party 4 --chain-id 80002
npm run tss-init -- --party 5 --chain-id 80002


# 10) Run keygen in separate terminals
# Preferred multi-machine flow:
# - use `npm run tss-keygen-ceremony -- --nonce <n>`
# - the wrapper auto-detects committee position from ordered IPs
# - the local vault uses the clean chain-scoped default path
# - all peers use the fixed slot-1 deterministic port for that chain
#
# This matches the known-good root tss flow: init all parties first, then keygen.
# By default, tss-tools/keygen.ts uses params.json for:
# - parties
# - threshold
# For same-host local runs, the wrapper also supplies deterministic local peer addresses
# via --p2p.peer_addrs:
#   /ip4/127.0.0.1/tcp/<derived-port>
#
# This auto-derived topology is only for same-machine local runs.
# If parties run on different machines, pass explicit --peer-addrs for each party
# using the other parties' real reachable IP:port values.
#
# Example for party 1 in a 3-party multi-machine run:
#   --peer-addrs /ip4/10.0.0.22/tcp/43382,/ip4/10.0.0.23/tcp/43383
#
# To override that behavior explicitly:
#   --peer-addrs /ip4/127.0.0.1/tcp/43382,/ip4/127.0.0.1/tcp/43383
#
# To disable auto local peer addresses:
#   --no-local-peer-addrs

# Example: BSC Testnet chainId 97
npm run tss-keygen -- --party 1 --chain-id 97
npm run tss-keygen -- --party 2 --chain-id 97
npm run tss-keygen -- --party 3 --chain-id 97
npm run tss-keygen -- --party 4 --chain-id 97
npm run tss-keygen -- --party 5 --chain-id 97

# Example: Polygon Amoy chainId 80002
npm run tss-keygen -- --party 1 --chain-id 80002
npm run tss-keygen -- --party 2 --chain-id 80002
npm run tss-keygen -- --party 3 --chain-id 80002
npm run tss-keygen -- --party 4 --chain-id 80002
npm run tss-keygen -- --party 5 --chain-id 80002

# Local debugging override example only:
# If you intentionally want a temporary 3-party / threshold-1 committee, pass:
#   --parties 3 --threshold 1
# on every participating keygen command.

# Expected result:
# default-flow commands write vault files under keystores/bnbtss/chain-<chainId>/default/
# explicit indexed/manual commands still use keystores/bnbtss/party-<idx>/chain-<chainId>/default/
# and prints JSON including:
#   party
#   chainId
#   home
#   vault
#   ethereum_address
#   public_key_ethereum
#   public_key_compressed


# If you see:
#   waiting peers startup...
# for all parties and nothing else happens, stop and inspect the local bootstrap state.
#
# If you see:
#   listen tcp 127.0.0.1:6062: bind: address already in use
# that is the BNB TSS debug profile port warning from tss/main.go.
# It is noisy, but the real bootstrap listener can still continue on the p2p.listen port.


# 11) Verify / derive the public key and address from a party vault
# If keygen-config.json is present, you can omit --chain-id and tss-verify will use its chainId.
npm run tss-verify -- --party 1 --password 1234567890
npm run tss-verify -- --party 2 --password 1234567890
npm run tss-verify -- --party 3 --password 1234567890

# All parties in the same committee should show the same:
#   ethereum_address
#   public_key_ethereum
#   public_key_compressed

# Output formats:
npm run tss-verify -- --party 1 --password 1234567890 --format all
npm run tss-verify -- --party 1 --password 1234567890 --format ethereum-address
npm run tss-verify -- --party 1 --password 1234567890 --format ethereum-pubkey
npm run tss-verify -- --party 1 --password 1234567890 --format compressed


# 12) Prepare an unsigned Ethereum transaction JSON
# Use ethereum-tx.json.example (repo root) or a custom file.


# 13) Sign an Ethereum transaction with threshold+1 parties
# Run the same command in separate terminals for participating parties.
# With params.json threshold 3, that means at least 4 participating parties.
#
# If --channel-id is omitted and BNB_TSS_CHANNEL_ID is unset, sign-ethereum-tx.ts
# derives a fallback signing channel id from:
# - the unsigned tx hash
# - the current 30-minute time bucket
#
# If --channel-password is omitted and BNB_TSS_CHANNEL_PASSWORD is unset,
# sign-ethereum-tx.ts derives a fallback signing channel password from:
# - the resolved channel id
# - SHARDUS_CRYPTO_HASH_KEY
#
# So all participating parties should start the command within the same
# 30-minute bucket when using the sign-ethereum-tx.ts fallback.

npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ethereum-tx.json.example
npm run tss-sign-ethereum-tx -- --party 2 --chain-id 97 --tx-file ethereum-tx.json.example
npm run tss-sign-ethereum-tx -- --party 3 --chain-id 97 --tx-file ethereum-tx.json.example
npm run tss-sign-ethereum-tx -- --party 4 --chain-id 97 --tx-file ethereum-tx.json.example

# Expected JSON output:
#   signed_tx
#   tx_hash
#   digest
#   r
#   s
#   v
#   ethereum_address
#   public_key_ethereum
#   public_key_compressed
# During signing, native tss logs are streamed to stderr line by line.
# The final signed transaction payload is still printed as one JSON object on stdout.


# 14) Sign and inject a Liberdus transaction with threshold+1 parties
# Run the same command in separate terminals for participating parties.
# With params.json threshold 3, that means at least 4 participating parties.
#
# Default single-bundle-per-machine flow:
# - omit --party
# - uses keystores/bnbtss/chain-<chainId>/default/
#
# Explicit indexed local testing / legacy flow:
# - pass --party N
# - uses keystores/bnbtss/party-N/chain-<chainId>/default/
#
# The tx file is the unsigned Liberdus tx payload before `sign`.
# The injector fills deterministic fields before signing:
# - missing networkId from chain-config.json
# - missing or zero-placeholder `from` from the selected BNB TSS vault address
# - timestamp from the latest Liberdus cycle end plus the TSS signing buffer
#
# For register tx type, the injector also fills:
# - publicKey from the selected BNB TSS uncompressed public key
# - aliasHash from alias
#
# For transfer txs, write amount as a full decimal token value, not wei/base units.
# By default --bigint-fields amount converts amount to base-unit BigInt before hashing.
# Use --cal-chatid when the tx should include chatId derived from from+to.
#
# Use --dry-run first to verify the signature without posting to /inject.
#
# The injector reads the latest cycle from COLLECTOR_HOST or
# chain-config.json -> collectorHost, then posts to LIBERDUS_PROXY_URL or
# chain-config.json -> proxyServerHost.

npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example --dry-run
npm run inject-liberdus-tx -- --chain-id 97 --party 1 --tx-file ./liberdus-tx.json.example --dry-run

# Example register tx:
# tx file payload:
# {
#   "type": "register",
#   "alias": "alice"
# }
npm run inject-liberdus-tx -- --chain-id 97 --party 1 --tx-file ./liberdus-tx.json.example --sign-discovery-timeout 60s
npm run inject-liberdus-tx -- --chain-id 97 --party 2 --tx-file ./liberdus-tx.json.example --sign-discovery-timeout 60s
npm run inject-liberdus-tx -- --chain-id 97 --party 3 --tx-file ./liberdus-tx.json.example --sign-discovery-timeout 60s
npm run inject-liberdus-tx -- --chain-id 97 --party 4 --tx-file ./liberdus-tx.json.example --sign-discovery-timeout 60s

# Example transfer tx with chatId:
npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example --bigint-fields amount --cal-chatid --dry-run

# Expected output:
#   unsigned tx hash / digest
#   derived signing channel id
#   BNB TSS signing logs
#   recovered owner verification
#   signed tx payload
#   inject response, unless --dry-run is used


# 15) Regroup flow
# For the current params.json:
# - parties = 5
# - threshold = 3
#
# Upstream regroup requires at least old_threshold + 1 old participants.
# That means a 5/3 committee needs at least 4 old participants in the regroup session.
#
# Valid example split for the current config:
# - parties 1, 2, 3, 4 are old committee participants and stay in the new committee
# - party 5 is a newly added committee member
#
# Run these in separate terminals with the same shared channel env vars.
#
# Flag meaning:
# - --is-old: this party is an existing committee member that also remains in the new committee
# - --is-new-member: this party is a newly added committee member and was not part of the old committee
# - Use exactly one of these wrapper flags per party
# - The local deterministic wrapper assumes the participating old parties are
#   `1..threshold+1`, and the new committee is `1..new-parties`
# - For remote or non-deterministic layouts, pass explicit native flags through
#   `-- ...`, especially `--p2p.new_listen` and `--p2p.new_peer_addrs`

# Existing members that also remain in the new committee
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 2 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 3 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 4 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5

# Newly added members
npm run tss-regroup -- --party 5 --chain-id 97 --is-new-member --threshold 3 --parties 5 --new-threshold 3 --new-parties 5

# 3-party / threshold-1 local example:
# - parties 1 and 2 are the participating old committee members
# - parties 1 and 2 remain in the new committee
# - party 3 is a newly added committee member
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --threshold 1 --parties 3 --new-threshold 1 --new-parties 3
npm run tss-regroup -- --party 2 --chain-id 97 --is-old --threshold 1 --parties 3 --new-threshold 1 --new-parties 3
npm run tss-regroup -- --party 3 --chain-id 97 --is-new-member --threshold 1 --parties 3 --new-threshold 1 --new-parties 3

# 3-party / threshold-1 -> 5-party / threshold-3 local example:
# - parties 1 and 2 are the participating old committee members
# - new committee is parties 1,2,3,4,5
npm run tss-init -- --party 4 --chain-id 97
npm run tss-init -- --party 5 --chain-id 97
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 2 --chain-id 97 --is-old --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 3 --chain-id 97 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 4 --chain-id 97 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 5 --chain-id 97 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5


# 16) Run the long-lived tss-party process in native mode
# tss-party.ts uses native BNB TSS signing by default, so normal startup uses native TSS signing.
# It expects existing BNB TSS vaults and validates them on startup.

node dist/tss-party.js 1

# Or from source tooling:
npm run tss-party -- 1

# Default single-bundle-per-machine startup:
# if no party index is passed, tss-party defaults to local slot 1
node dist/tss-party.js
npm run tss-party


# 17) Important runtime requirements for native mode
# - The native binary must exist:
#     tss/.tooling/bin/tss
# - Shared env vars must be set for all participating parties:
#     TSS_PASSWORD_CHAIN_<chainId>
#     BNB_TSS_CHANNEL_PASSWORD
# - BNB_TSS_CHANNEL_ID and BNB_TSS_CHANNEL_PASSWORD are still required for manual
#   native keygen/regroup flows.
# - The long-lived tss-party signer derives a deterministic signing channel id
#   from each txId + txTimestamp, and a deterministic signing channel
#   password from channelId + SHARDUS_CRYPTO_HASH_KEY.
# - sign-ethereum-tx.ts can fall back to a derived channel id from the unsigned
#   tx hash plus the current 30-minute time bucket, and a derived channel
#   password from channelId + SHARDUS_CRYPTO_HASH_KEY.
# - Vaults must exist for each required chain under:
#     keystores/bnbtss/chain-<chainId>/default/
#   or legacy fallback:
#     keystores/bnbtss/party-1/chain-<chainId>/default/
# - Derived ethereum_address from the vault must match chain-config.json -> tssSenderAddress
# - For local multi-party keygen/sign testing, run init for all parties before keygen/sign
# - Normal committee size comes from params.json unless you explicitly override it


# 18) NPM wrappers
npm run tss-build
npm run tss-init -- --party 1 --chain-id 97
npm run tss-keygen -- --party 1 --chain-id 97
npm run tss-keygen-ceremony -- --nonce 1
npm run tss-verify -- --party 1 --password 1234567890
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup-ceremony -- --nonce 1
npm run tss-regroup -- --party 4 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 5 --chain-id 97 --is-new-member --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ethereum-tx.json.example
npm run inject-liberdus-tx -- --chain-id 97 --party 1 --tx-file ./liberdus-tx.json.example --dry-run


# 19.1) Local native workflow smoke test
#
# After building the native binary, this runs a same-machine end-to-end workflow:
# - init 5 local parties
# - keygen with parties 1,2,3
# - sign with the initial committee
# - regroup from 3 parties to 5 parties
# - sign with the 5-party committee
# - regroup down to a final 3-party committee
# - sign with the final committee
#
# The script runs the native binary from tss/.tooling/bin so native keygen and
# regroup can find the bundled tbnbcli in their working directory. It also checks
# that its fixed localhost ports are free before starting.
./tss-tools/tss_workflow_smoke.sh


# 19.2) Sign bootstrap — flexible k-of-n signing and discovery timeout
#
# The Liberdus forked bnb-chain/tss binary supports flexible k-of-n signing. Once the first peer
# connects during sign bootstrap, a discovery window opens. If all n parties
# connect before the window closes, all sign. If the window expires with at
# least threshold peers present, signing proceeds with that available subset.
#
# Default window: 5 s (--sign_discovery_timeout default)
#
# This means:
#   - Parties starting within 5 s of each other → all participate
#   - A party starting more than 5 s after the first peer → others proceed without it
#     (still valid if ≥ threshold+1 parties are present)
#
# To extend the window (e.g. for high-latency multi-machine setups):
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ethereum-tx.json.example --sign_discovery_timeout 10s
#
# To disable the window and require all n parties (strict mode):
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ethereum-tx.json.example --sign_discovery_timeout 0


# 20) Test harness — verify sign bootstrap across delay scenarios
#
# tss-tools/test-sign-rounds.sh runs configurable rounds across 34 startup-delay
# scenarios for a 7-party (threshold=3, min_sign=4) setup. Results are written to:
#   tss-tools/test-result.log        — overall PASS/FAIL per scenario/round
#   tss-tools/test-party{1..7}.log   — per-party output (all rounds, with separators)
#
# Run with 1 round per scenario (34 total runs):
bash tss-tools/test-sign-rounds.sh 1
#
# Run with a custom number of rounds per scenario:
bash tss-tools/test-sign-rounds.sh 3
#
# Run only the first N scenarios:
bash tss-tools/test-sign-rounds.sh 1 5
#
# Expected: PASS=34 FAIL=0
# Scenarios where a party starts > 5 s late pass with a reduced signer count
# (threshold signing) as long as at least threshold+1 parties are present.


# 21) Patch peer addresses in existing vaults (multi-machine deployment fix)
#
# If keystores were generated locally (all parties on 127.0.0.1) and then deployed
# to separate machines, the tss sign command will fail — it dials 127.0.0.1 instead
# of the real machine IPs. Use the patch-peer-addrs utility to fix this without
# re-running keygen or regroup (the TSS Ethereum address is preserved).
#
# The utility decrypts each party's config.json, updates peer_addrs and peers with
# real IPs, and re-encrypts. Key share files (pk.json, sk.json, node_key) are untouched.
#
# --party flag:
#   omit      -> patches all party vaults found under --keystore-root
#                use this when all keystores are available locally (dev/staging)
#   --party N -> patches only party N's vault
#                use this in production where each operator only has their own keystore
#
# --- LOCAL / STAGING (all vaults present) ---
#
# Step 1: Collect all peer IDs using tss describe
#   The peer ID is stable — derived from node_key and never changes.
#
#   for i in {1..5}; do
#     echo "=== party-$i ==="
#     ./tss/.tooling/bin/tss describe \
#       --home keystores/bnbtss/party-$i/chain-<CHAIN_ID> \
#       --vault_name default \
#       --password <vault-password> 2>/dev/null | grep -E '"Id"|"Moniker"'
#   done
#
# Step 2: Patch all vaults at once
#
#   ./tss/.tooling/bin/patch-peer-addrs \
#     --keystore-root keystores/<your-keystore-dir>/bnbtss \
#     --chain-id <CHAIN_ID> \
#     --password <vault-password> \
#     --ips "<party1-ip>,<party2-ip>,<party3-ip>,<party4-ip>,<party5-ip>" \
#     --peer-ids "<party1-Id>,<party2-Id>,<party3-Id>,<party4-Id>,<party5-Id>"
#
# Step 3: Deploy only config.json to each machine
#   Key share files are unchanged so only config.json needs to be redeployed:
#
#   IPS=([1]="<party1-ip>" [2]="<party2-ip>" ... [5]="<party5-ip>")
#   for i in 1 2 3 4 5; do
#     scp -i ~/.ssh/tss_deploy \
#       keystores/<your-keystore-dir>/bnbtss/party-$i/chain-<CHAIN_ID>/default/config.json \
#       user@${IPS[$i]}:~/tss-signer/keystores/bnbtss/party-$i/chain-<CHAIN_ID>/default/config.json &
#   done
#   wait
#
# --- PRODUCTION (each operator has only their own keystore) ---
#
# Step 1: Each operator collects their own peer ID and shares it out-of-band
#
#   ./tss/.tooling/bin/tss describe \
#     --home ~/tss-signer/keystores/bnbtss/party-N/chain-<CHAIN_ID> \
#     --vault_name default \
#     --password <vault-password> 2>/dev/null | grep -E '"Id"|"Moniker"'
#
#   Share the "Id" value with all other operators (e.g. secure group chat).
#   Collect all operators' IPs and peer IDs before proceeding.
#
# Step 2: Each operator patches only their own vault using --party N
#
#   ./tss/.tooling/bin/patch-peer-addrs \
#     --keystore-root ~/tss-signer/keystores/bnbtss \
#     --chain-id <CHAIN_ID> \
#     --party N \
#     --password <vault-password> \
#     --ips "<party1-ip>,<party2-ip>,<party3-ip>,<party4-ip>,<party5-ip>" \
#     --peer-ids "<party1-Id>,<party2-Id>,<party3-Id>,<party4-Id>,<party5-Id>"
#
#   If custom monikers were used during tss init (non-default), also pass:
#     --monikers "<party1-moniker>,<party2-moniker>,...,<partyN-moniker>"
#   Without this, the tool falls back to "party-N-chain-ID" for any vault it
#   cannot read locally — which is correct for default setups but wrong for
#   custom monikers. The tool will print a WARNING in that case.
#
# Step 3: Validate with a native sign test (optional but recommended)
#   Run on at least threshold+1 machines simultaneously with the same channel/message:
#
#   ~/tss-signer/tss/.tooling/bin/tss sign \
#     --home ~/tss-signer/keystores/bnbtss/party-N/chain-<CHAIN_ID> \
#     --vault_name default \
#     --password <vault-password> \
#     --channel_id <CHANNEL_ID> \
#     --channel_password <CHANNEL_PASSWORD> \
#     --message 1 \
#     --sign_discovery_timeout 30s \
#     --log_level info
#
#   A successful run prints "signing finished!" and exits 0 on all parties.
#
# Step 4: Each operator restarts their own tss-party process
#
#   pm2 restart tss-party-N


# 22) If verify/sign fails, check these first
# - Did ./tss-tools/build-tss.sh succeed?
# - Did you set the three env vars?
# - Are all parties using the same channel id and channel password?
# - Did you run npm run tss-init -- ... for every participating party first?
# - Did keygen complete for this party and chain?
# - Does the vault exist under keystores/bnbtss/.../default/?
# - Does chainId match the tx JSON chainId?
