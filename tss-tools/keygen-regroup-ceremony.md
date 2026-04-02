# Keygen And Regroup Ceremony

## Purpose

Use the ceremony wrappers for the normal ordered-IP multi-machine flow:

- `npm run tss-keygen-ceremony`
- `npm run tss-regroup-ceremony`

These wrappers are the recommended operator path for remote servers. They remove the need to pass `--party`, `--channel-id`, `--channel-password`, manual `--peer-addrs`, or manual `--new-peer-addrs`.

They resolve the local machine's committee position from shared config, derive deterministic channel credentials from the config plus `--nonce`, and launch the low-level commands with the correct arguments.

## Shared Prerequisites

On each participating machine:

```bash
npm install
npm run tss-build
```

Recommended shared environment variable for production:

```bash
export SHARDUS_CRYPTO_HASH_KEY=<shared-random-hex>
```

Every party should use the same value. If this is unset, the wrappers fall back to the default behavior, which should not be relied on for production.

## Keygen Ceremony

### 1. Create `keygen-config.json`

Create the same `keygen-config.json` on every participating machine:

```json
{
  "chainId": 97,
  "partyIps": [
    "10.0.1.1",
    "10.0.1.2",
    "10.0.1.3",
    "10.0.1.4",
    "10.0.1.5"
  ]
}
```

Example:

```bash
cat > keygen-config.json <<'EOF'
{
  "chainId": 97,
  "partyIps": [
    "203.0.113.11",
    "203.0.113.12",
    "198.51.100.21",
    "198.51.100.22",
    "192.0.2.31"
  ]
}
EOF
```

Rules:

- `partyIps` must be in the agreed committee order
- every machine must use the same file contents
- the local machine IP must appear exactly once in `partyIps`

### 2. Run Connectivity Check

Before keygen, have every operator run the connectivity check on their own machine:

```bash
npm run tss-connectivity-check
```

The check:

- resolves the local committee position from `partyIps`
- derives the expected listen port from `chainId`
- opens a listener on that port and keeps it running until you stop it with `Ctrl+C`
- rechecks every other party every few seconds
- prints a compact live status table
- prints a copy/paste cleanup command if the port is already in use

Operators do not need to start it at the same time. Start it once on each machine and leave it running while the rest of the team gets set up.

Wait until every operator sees every peer row show:

```text
In = OK, Out = OK, Ready = OK
```

If not, fix the network issue before attempting keygen. Once every row is `OK`, stop the connectivity check with `Ctrl+C` and move on.

### 3. Run Keygen

Coordinate a start time, then each operator runs:

```bash
npm run tss-keygen-ceremony -- --nonce 1
```

Use a fresh nonce for every retry:

```bash
npm run tss-keygen-ceremony -- --nonce 2
```

The wrapper:

- detects the machine's local IPv4 addresses
- falls back to external IPv4 lookup if local detection is not enough
- resolves the machine's committee position from `partyIps`
- prompts for the vault password
- initializes the default-slot vault automatically if it does not yet exist
- verifies the password against the existing vault if it already exists
- derives `parties` and `threshold = floor(parties / 2)`
- overwrites `params.json` with the derived values
- computes the correct `--peer-addrs` list excluding self
- passes `--no-local-peer-addrs` so only the explicit remote IPs are used
- derives deterministic `BNB_TSS_CHANNEL_ID`
- derives deterministic `BNB_TSS_CHANNEL_PASSWORD`
- prints the resolved configuration and asks for confirmation before launch

Password behavior:

- for a new vault, it prompts twice: enter and confirm
- for an existing vault, it prompts until the password unlocks the vault
- the password must be longer than 8 characters

Important notes:

- avoid starting around `00:00 UTC`, because the deterministic channel ID expires at the next UTC midnight
- if any machine fails or exits early, restart keygen together with a new nonce
- partial keygen output is not valid

### 4. Verify After Keygen

After keygen succeeds, each operator verifies their vault:

```bash
npm run tss-verify
```

`tss-verify` uses `chainId` from `keygen-config.json` if `--chain-id` is not passed.

Check that:

- the command succeeds on every machine
- all machines report the same `ethereum_address`

If the addresses differ, discard the result and rerun the ceremony.

### 5. Optional Sign Test

Create the same unsigned transaction file on the participating machines, for example:

```bash
cat > tx.json <<'EOF'
{
  "to": "0x1111111111111111111111111111111111111111",
  "value": "0x0",
  "nonce": 0,
  "gasLimit": "0x5208",
  "gasPrice": "0x3b9aca00",
  "chainId": 97
}
EOF
```

Then start signing on the required number of parties at roughly the same time:

```bash
npm run tss-sign-ethereum-tx -- --chain-id 97 --tx-file tx.json
```

Current wrapper behavior:

- `--party` is not required in the default-slot flow
- the command resolves the vault from `keystores/bnbtss/chain-<chainId>/default/`
- deterministic sign channel credentials are derived automatically unless overridden

Verify that the participating machines report the same `ethereum_address`, and that the recovered signer from `signed_tx` matches that address.

## Regroup Ceremony

Regroup redistributes shares to a new committee without changing the TSS Ethereum address.

Use it when:

- a party operator is being replaced
- the threshold changes
- the committee size changes

Regroup requires at least `oldThreshold + 1` old participants.

### 1. Prepare New-only Members

If a machine was not part of the previous keygen, it still needs a local vault before regroup.

Initialize that machine first, either by:

- running `tss-init` directly, or
- running the keygen ceremony wrapper with a single-machine config just to initialize the vault

Old participants must already have their original vault and key share on disk.

### 2. Create `regroup-config.json`

Create the same `regroup-config.json` on every participating machine:

```json
{
  "chainId": 97,
  "oldPartyIps": [
    "10.0.1.1",
    "10.0.1.2",
    "10.0.1.3"
  ],
  "newPartyIps": [
    "10.0.1.1",
    "10.0.1.2",
    "10.0.1.3",
    "10.0.1.4",
    "10.0.1.6"
  ],
  "oldThreshold": 2,
  "newThreshold": 3
}
```

Example:

```bash
cat > regroup-config.json <<'EOF'
{
  "chainId": 97,
  "oldPartyIps": [
    "203.0.113.11",
    "203.0.113.12",
    "198.51.100.21"
  ],
  "newPartyIps": [
    "203.0.113.11",
    "203.0.113.12",
    "198.51.100.21",
    "198.51.100.22",
    "192.0.2.31"
  ],
  "oldThreshold": 2,
  "newThreshold": 3
}
EOF
```

Rules:

- `oldPartyIps` are the active old participants for this regroup
- `oldPartyIps.length` must equal `oldThreshold + 1`
- every `oldPartyIp` must also appear in `newPartyIps`
- `newPartyIps` must be in the agreed new committee order
- every participating machine must use the same file contents
- the local machine must appear in `newPartyIps`
- duplicate IPs are rejected

### 3. Run Regroup

Coordinate a start time, then each participating machine runs:

```bash
npm run tss-regroup-ceremony -- --nonce 1
```

Use a fresh nonce for every regroup retry.

The wrapper:

- detects the machine's committee position from `newPartyIps`
- determines automatically whether the machine is an old member or a new-only member
- verifies the vault password, or initializes a new vault for new-only members if needed
- derives deterministic regroup channel credentials from the config plus `--nonce`
- computes `--new-peer-addrs` automatically from the active old participant set plus the ordered new committee
- uses the regroup `+1000` listen-port family only where required for carry-over regroup identities
- prints the resolved configuration and asks for confirmation before launch

If any machine fails, rerun regroup together with a new nonce.

### 4. Verify After Regroup

After regroup, verify on all participating machines:

```bash
npm run tss-verify
```

The regrouped committee must converge on the same `ethereum_address`, and that address must remain unchanged from the pre-regroup committee.

## Retry Rules

- if any machine fails during keygen, restart the whole keygen ceremony together
- if any machine fails during regroup, restart the whole regroup ceremony together
- do not reuse the same nonce for a retry
- use a new nonce such as `2`, `3`, and so on

## Notes

- the wrappers do not require `--party`
- the wrappers use the default-slot vault layout: `keystores/bnbtss/chain-<chainId>/default/`
- legacy `party-N` layouts may still be supported as fallback in lower-level flows, but the ceremony path is default-slot based
- the ceremony wrappers are the recommended multi-machine operator flow
