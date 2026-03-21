# BNB TSS integration tryout from tss-signer

# Repo
cd /Users/user/Documents/MyProject/Shardus/Liberdus/tss-research/tss-signer

# Current code path
# scripts/tss-party.ts currently uses:
#   const useBnbTss = true
#
# User-facing party indices start at 1.


# 1) Install Node dependencies
npm install


# 2) Build the TypeScript party script
npm run compile-tss


# 3) Ensure the upstream tss submodule is present
git submodule update --init --recursive

# 4) Bootstrap the vendored Go toolchain if build says Go is missing
./tss-tools/setup-mise-go.sh

# 5) Build the patched native tss binary
./tss-tools/build-tss.sh

# Expected output:
# Built /.../tss-signer/tss/.tooling/bin/tss


# 6) Create a channel id for a shared signing/keygen session
./tss/.tooling/bin/tss channel --channel_expire 30

# Example output:
# channel id: 82469B4FB12


# 7) Export shared environment for all participating parties
export BNB_TSS_PASSWORD=1234567890
export BNB_TSS_CHANNEL_ID=<replace_with_channel_id>
export BNB_TSS_CHANNEL_PASSWORD=1234567890

# The long-lived tss-party signer derives a deterministic signing channel id from
# each txId + txTimestamp. Keep BNB_TSS_CHANNEL_ID for manual native
# keygen/regroup flows and ad-hoc direct tss signing.
# The long-lived tss-party signer also derives a deterministic signing channel
# password from channelId + SHARDUS_CRYPTO_HASH_KEY.


# 8) Key storage layout used by tss-signer native mode
# keystores/bnbtss/party-<idx>/chain-<chainId>/default/
#
# Example:
# keystores/bnbtss/party-1/chain-97/default/

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


# 9) Init all parties first in separate terminals
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
# each command writes vault files under keystores/bnbtss/party-<idx>/chain-<chainId>/default/
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
# that is the upstream debug profile port warning from tss/main.go.
# It is noisy, but the real bootstrap listener can still continue on the p2p.listen port.


# 11) Verify / derive the public key and address from a party vault
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890
npm run tss-verify -- --party 2 --chain-id 97 --password 1234567890
npm run tss-verify -- --party 3 --chain-id 97 --password 1234567890

# All parties in the same committee should show the same:
#   ethereum_address
#   public_key_ethereum
#   public_key_compressed

# Output formats:
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890 --format all
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890 --format ethereum-address
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890 --format ethereum-pubkey
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890 --format compressed


# 12) Prepare an unsigned Ethereum transaction JSON
# You can use tx.json.example or a custom file.
cat > ./keystores/unsigned-tx.json <<'EOF'
{
  "to": "0x1111111111111111111111111111111111111111",
  "value": "0x1",
  "nonce": 0,
  "gasLimit": 21000,
  "gasPrice": "0x3b9aca00",
  "data": "0x",
  "chainId": 97
}
EOF


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

npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ./keystores/unsigned-tx.json
npm run tss-sign-ethereum-tx -- --party 2 --chain-id 97 --tx-file ./keystores/unsigned-tx.json
npm run tss-sign-ethereum-tx -- --party 3 --chain-id 97 --tx-file ./keystores/unsigned-tx.json
npm run tss-sign-ethereum-tx -- --party 4 --chain-id 97 --tx-file ./keystores/unsigned-tx.json

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


# 14) Regroup flow
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
npm run tss-regroup -- --party 1 --chain-id 31338 --is-old --threshold 1 --parties 3 --new-threshold 1 --new-parties 3
npm run tss-regroup -- --party 2 --chain-id 31338 --is-old --threshold 1 --parties 3 --new-threshold 1 --new-parties 3
npm run tss-regroup -- --party 3 --chain-id 31338 --is-new-member --threshold 1 --parties 3 --new-threshold 1 --new-parties 3

# 3-party / threshold-1 -> 5-party / threshold-3 local example:
# - parties 1 and 2 are the participating old committee members
# - new committee is parties 1,2,3,4,5
npm run tss-init -- --party 4 --chain-id 31338
npm run tss-init -- --party 5 --chain-id 31338
npm run tss-regroup -- --party 1 --chain-id 31338 --is-old --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 2 --chain-id 31338 --is-old --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 3 --chain-id 31338 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 4 --chain-id 31338 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 5 --chain-id 31338 --is-new-member --threshold 1 --parties 3 --new-threshold 3 --new-parties 5


# 15) Run the long-lived tss-party process in native mode
# tss-party.ts currently has useBnbTss = true, so normal startup uses native tss signing.
# It expects existing BNB TSS vaults and validates them on startup.

node dist/tss-party.js 1

# Or from source tooling:
npm run tss-party -- 1


# 16) Important runtime requirements for native mode
# - The patched binary must exist:
#     tss/.tooling/bin/tss
# - Shared env vars must be set for all participating parties:
#     BNB_TSS_PASSWORD
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
#     keystores/bnbtss/party-<idx>/chain-<chainId>/default/
# - Derived ethereum_address from the vault must match chain-config.json -> tssSenderAddress
# - For local multi-party keygen/sign testing, run init for all parties before keygen/sign
# - Normal committee size comes from params.json unless you explicitly override it


# 17) NPM wrappers
npm run tss-build
npm run tss-init -- --party 1 --chain-id 97
npm run tss-keygen -- --party 1 --chain-id 97
npm run tss-verify -- --party 1 --chain-id 97 --password 1234567890
npm run tss-regroup -- --party 1 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 4 --chain-id 97 --is-old --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-regroup -- --party 5 --chain-id 97 --is-new-member --threshold 3 --parties 5 --new-threshold 3 --new-parties 5
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 97 --tx-file ./keystores/unsigned-tx.json


# 18) Sign bootstrap — flexible k-of-n signing and discovery timeout
#
# The patched tss binary supports flexible k-of-n signing. Once the first peer
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
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 31338 --tx-file ./keystores/unsigned-tx.json --sign_discovery_timeout 10s
#
# To disable the window and require all n parties (strict mode):
npm run tss-sign-ethereum-tx -- --party 1 --chain-id 31338 --tx-file ./keystores/unsigned-tx.json --sign_discovery_timeout 0


# 19) Test harness — verify sign bootstrap across delay scenarios
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


# 20) If verify/sign fails, check these first
# - Did ./tss-tools/build-tss.sh succeed?
# - Did you set the three env vars?
# - Are all parties using the same channel id and channel password?
# - Did you run npm run tss-init -- ... for every participating party first?
# - Did keygen complete for this party and chain?
# - Does the vault exist under keystores/bnbtss/.../default/?
# - Does chainId match the tx JSON chainId?
