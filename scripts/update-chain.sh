#!/usr/bin/env bash
# update-chain.sh — update a chain entry in chain-config.json by chainId
#
# USAGE:
#   ./update-chain.sh <chain-config.json> <chainId> '<json-object>'
#
# EXAMPLES:
#   ./update-chain.sh chain-config.json 97 '{"tssSenderAddress":"0x7fD5AF01358a7dad582b2476aA821b75CebaF297","bridgeAddress":"7fd5af01358a7dad582b2476aa821b75cebaf297000000000000000000000000"}'
#   ./update-chain.sh chain-config.json 80002 '{"deploymentBlock":99999999}'
#
# BEHAVIOUR:
#   - Deep-merges the supplied object into every location in the config
#     where .chainId == <chainId> (supportedChains entries, vaultChain,
#     secondaryChainConfig).
#   - Existing keys not mentioned in the patch are left untouched.
#   - Writes back to the same file; a .bak copy is saved first.
#   - Requires: jq >= 1.6

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <chain-config.json> <chainId> '<json-object>'" >&2
  exit 1
fi

CONFIG_FILE="$1"
CHAIN_ID="$2"
NEW_DATA="$3"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: file not found: $CONFIG_FILE" >&2
  exit 1
fi

if ! echo "$CHAIN_ID" | grep -qE '^[0-9]+$'; then
  echo "Error: chainId must be a positive integer, got: $CHAIN_ID" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install with: sudo apt install jq  (or brew install jq)" >&2
  exit 1
fi

if ! echo "$NEW_DATA" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "Error: the supplied JSON must be a valid JSON object." >&2
  exit 1
fi

cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"

JQ_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/update-chain-XXXXXX.jq")"
trap 'rm -f "$JQ_SCRIPT"' EXIT

cat > "$JQ_SCRIPT" <<'JQ_EOF'
def deep_merge(a; b):
  if (a | type) == "object" and (b | type) == "object"
  then a * b
  else b
  end;

(if .supportedChains[($chainId | tostring)] != null
 then .supportedChains[($chainId | tostring)] =
        deep_merge(.supportedChains[($chainId | tostring)]; $newData)
 else .
 end)
| (if .vaultChain.chainId == $chainId
   then .vaultChain = deep_merge(.vaultChain; $newData)
   else .
   end)
| (if .secondaryChainConfig.chainId == $chainId
   then .secondaryChainConfig = deep_merge(.secondaryChainConfig; $newData)
   else .
   end)
JQ_EOF

UPDATED="$(jq \
  --argjson chainId "$CHAIN_ID" \
  --argjson newData "$NEW_DATA" \
  --from-file "$JQ_SCRIPT" \
  "$CONFIG_FILE")"

printf '%s\n' "$UPDATED" > "$CONFIG_FILE"
echo "Updated $CONFIG_FILE for chainId $CHAIN_ID (backup: ${CONFIG_FILE}.bak)"
