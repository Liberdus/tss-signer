#!/usr/bin/env bash
# Start 5 observer + tss-party pairs for local dev (WSL/Linux).
# Kills any existing instances before starting.
#
# Usage:
#   ./scripts/start-local-dev.sh
#   TSS_PASSWORD_CHAIN_97=... TSS_PASSWORD_CHAIN_80002=... ./scripts/start-local-dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export TSS_PASSWORD_CHAIN_97="${TSS_PASSWORD_CHAIN_97:-1234567890}"
export TSS_PASSWORD_CHAIN_80002="${TSS_PASSWORD_CHAIN_80002:-1234567890}"
export OBSERVER_SKIP_OLD_DATA="${OBSERVER_SKIP_OLD_DATA:-true}"

echo "Stopping existing observer / tss-party processes..."
pkill -f 'dist/observer/index.js' 2>/dev/null || true
pkill -f 'dist/scripts/tss-party.js' 2>/dev/null || true
sleep 1
pkill -9 -f 'dist/observer/index.js' 2>/dev/null || true
pkill -9 -f 'dist/scripts/tss-party.js' 2>/dev/null || true
sleep 1

if pgrep -f 'dist/observer/index.js' >/dev/null || pgrep -f 'dist/scripts/tss-party.js' >/dev/null; then
  echo "Warning: some observer/tss-party processes may still be running." >&2
  pgrep -af 'dist/observer/index.js' || true
  pgrep -af 'dist/scripts/tss-party.js' || true
else
  echo "No observer/tss-party processes running."
fi

mkdir -p logs
npm run compile

echo "Starting observers and tss-parties 1-5..."
for i in 1 2 3 4 5; do
  (PARTY_INDEX=$i node --max-old-space-size=2048 --expose-gc dist/observer/index.js \
    > "logs/observer-$i-out.log" 2> "logs/observer-$i-error.log") &
  (node --max-old-space-size=2048 --expose-gc dist/scripts/tss-party.js "$i" \
    > "logs/tss-party-$i-out.log" 2> "logs/tss-party-$i-error.log") &
done

echo "Started. Tail logs with: tail -f logs/observer-1-out.log logs/tss-party-1-out.log"
