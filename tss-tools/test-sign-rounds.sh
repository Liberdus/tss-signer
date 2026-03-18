#!/usr/bin/env bash
# Runs N rounds of 3-party signing with configurable startup delays.
# Usage: ./tss-tools/test-sign-rounds.sh [rounds]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROUNDS="${1:-5}"
PASS=0
FAIL=0
RESULTS_LOG="${SCRIPT_DIR}/test-result.log"
LOG1="${SCRIPT_DIR}/test-party1.log"
LOG2="${SCRIPT_DIR}/test-party2.log"
LOG3="${SCRIPT_DIR}/test-party3.log"
PARTY_TIMEOUT=30  # seconds before killing a stalled party

# Clear logs from previous run
> "$RESULTS_LOG"
> "$LOG1"
> "$LOG2"
> "$LOG3"

# Delays between party starts (seconds): (p1_delay, p2_delay, p3_delay)
# Each tuple represents one test scenario
SCENARIOS=(
  "0 0 0"      # all simultaneous
  "0 1 2"      # staggered 1s apart
  "0 2 4"      # staggered 2s apart
  "0 0 3"      # p3 starts 3s late
  "0 0 4"      # p3 starts 4s late
  "0 0 5"      # p3 starts exactly at discovery boundary
  "0 0 6"      # p3 starts 6s late — only 2-of-3 expected
  "0 0 8"      # p3 starts 8s late — only 2-of-3 expected
  "0 3 3"      # p2 and p3 both start 3s late
  "0 2 5"      # p2 delayed 2s, p3 delayed 5s
  "0 4 4"      # p2 and p3 both start 4s late
  "2 0 0"      # p1 starts 2s late
  "4 0 0"      # p1 starts 4s late
  "1 3 5"      # all different, spread over 5s
)

log() {
  echo "$@" | tee -a "$RESULTS_LOG"
}

# macOS-compatible timeout: run_timed <seconds> <command...>
run_timed() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  (sleep "$secs" && kill "$pid" 2>/dev/null) &
  local killer=$!
  wait "$pid" 2>/dev/null || true
  kill "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null || true
}

run_round() {
  local d1=$1 d2=$2 d3=$3 round=$4

  # Record current line offsets before this round so we can isolate its output
  local off1 off2 off3
  off1=$(wc -l < "$LOG1")
  off2=$(wc -l < "$LOG2")
  off3=$(wc -l < "$LOG3")

  echo "--- Round ${round} ---" >> "$LOG1"
  echo "--- Round ${round} ---" >> "$LOG2"
  echo "--- Round ${round} ---" >> "$LOG3"

  # Launch parties with delays; kill if stalled after PARTY_TIMEOUT
  (sleep "$d1"; run_timed "$PARTY_TIMEOUT" env BNB_TSS_PASSWORD=1234567890 node dist/tss-tools/sign-ethereum-tx.js \
    --party 1 --chain-id 31338 --tx-file ./keystores/unsigned-tx.json \
    2>&1) >> "$LOG1" &
  local pid1=$!

  (sleep "$d2"; run_timed "$PARTY_TIMEOUT" env BNB_TSS_PASSWORD=1234567890 node dist/tss-tools/sign-ethereum-tx.js \
    --party 2 --chain-id 31338 --tx-file ./keystores/unsigned-tx.json \
    2>&1) >> "$LOG2" &
  local pid2=$!

  (sleep "$d3"; run_timed "$PARTY_TIMEOUT" env BNB_TSS_PASSWORD=1234567890 node dist/tss-tools/sign-ethereum-tx.js \
    --party 3 --chain-id 31338 --tx-file ./keystores/unsigned-tx.json \
    2>&1) >> "$LOG3" &
  local pid3=$!

  wait $pid1 $pid2 $pid3 || true

  # Check each party's output for this round only (from recorded offset)
  local ok=0 failed_parties=""
  local offsets=("$off1" "$off2" "$off3")
  for i in 1 2 3; do
    local plog="${SCRIPT_DIR}/test-party${i}.log"
    local off="${offsets[$((i-1))]}"
    if tail -n +$((off+1)) "$plog" 2>/dev/null | grep -q "signed_tx"; then
      ok=$((ok+1))
    else
      failed_parties="${failed_parties} P${i}"
    fi
  done

  if [ "$ok" -ge 2 ]; then
    log "  PASS ($ok/3 signed)${failed_parties:+ — failed:${failed_parties}}"
    PASS=$((PASS+1))
  else
    log "  FAIL ($ok/3 signed) — failed:${failed_parties}"
    FAIL=$((FAIL+1))
    for i in 1 2 3; do
      local plog="${SCRIPT_DIR}/test-party${i}.log"
      local off="${offsets[$((i-1))]}"
      if ! tail -n +$((off+1)) "$plog" 2>/dev/null | grep -q "signed_tx"; then
        log "    [P${i} last lines]:"
        tail -n +$((off+1)) "$plog" 2>/dev/null | tail -5 | sed 's/^/      /' | tee -a "$RESULTS_LOG"
      fi
    done
  fi
}

cd "$ROOT"

SEPARATOR="================================================================"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

{
  echo "$SEPARATOR"
  echo "  TSS Sign Bootstrap Test — $TIMESTAMP"
  echo "$SEPARATOR"
} | tee -a "$RESULTS_LOG"

log "Rounds per scenario: $ROUNDS"
log "Party timeout: ${PARTY_TIMEOUT}s"
log ""

ROUND_COUNTER=0

for scenario in "${SCENARIOS[@]}"; do
  read -r d1 d2 d3 <<< "$scenario"
  {
    echo ""
    echo "----------------------------------------------------------------"
    echo "  Scenario: P1 delay=${d1}s  P2 delay=${d2}s  P3 delay=${d3}s"
    echo "----------------------------------------------------------------"
  } | tee -a "$RESULTS_LOG"
  for r in $(seq 1 "$ROUNDS"); do
    ROUND_COUNTER=$((ROUND_COUNTER+1))
    printf "  Round %d/%d ... " "$r" "$ROUNDS" | tee -a "$RESULTS_LOG"
    run_round "$d1" "$d2" "$d3" "$ROUND_COUNTER"
  done
  log ""
done

{
  echo ""
  echo "$SEPARATOR"
  echo "  Results: PASS=$PASS  FAIL=$FAIL  total=$((PASS+FAIL))"
  echo "$SEPARATOR"
} | tee -a "$RESULTS_LOG"
