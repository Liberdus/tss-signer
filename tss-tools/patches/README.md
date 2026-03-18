# tss-source.patch

Local patch applied onto the upstream [bnb-chain/tss](https://github.com/bnb-chain/tss) submodule before build and use. Applied automatically by `tss-tools/build-tss.sh`.

## Changes

### `cmd/sign.go` — read `--message` from flag instead of hard-coding `"0"`

The upstream `setMessage()` always set `TssCfg.Message = "0"`. This change reads the `--message` flag value first, falling back to an interactive stdin prompt when the flag is absent.

**Why:** `sign-ethereum-tx.ts` passes the transaction digest as a decimal integer via `--message`. Without this change the binary always signed the constant `0` regardless of the actual transaction.

---

### `cmd/root.go` — register `--sign_discovery_timeout` flag

Adds a `Duration` flag to `signCmd` defaulting to `5s`.

**Why:** Exposes the configurable discovery window (see `bootstrapper.go` below) as a CLI option so callers can extend the window for slower networks without recompiling.

---

### `common/config.go` — add `SignDiscoveryTimeout` field and duration decode hook

Adds `SignDiscoveryTimeout time.Duration` to `TssConfig` with a `mapstructure:"sign_discovery_timeout"` tag, and wraps the existing decode hook with `mapstructure.ComposeDecodeHookFunc(mapstructure.StringToTimeDurationHookFunc(), ...)` so that string values like `"5s"` from Viper/flags are correctly parsed into `time.Duration`.

**Why:** Without the `StringToTimeDurationHookFunc` hook, mapstructure cannot decode a `"5s"` string into `int64` (the underlying type of `time.Duration`) and returns a parse error at startup.

---

### `common/bootstrapper.go` — time-boxed discovery for flexible k-of-n signing

Adds two fields to `Bootstrapper`:

- `firstPeerOnce sync.Once` — ensures the deadline is started exactly once per session
- `discoveryDeadline time.Time` — absolute cutoff set when the first peer arrives

Modifies `HandleBootstrapMsg` to start the discovery timer on the first peer connection in `SignMode`.

Replaces the `SignMode` case in `IsFinished()` with two exit conditions:

- **Fast path:** all `n-1` expected peers connected → close immediately
- **Timeout path:** `SignDiscoveryTimeout` has elapsed since the first peer arrived AND at least `threshold` peers are present → close with the available subset

**Why:** The original code exited discovery as soon as `received == threshold`, which caused a race condition: different parties could exit at different moments with different peer counts, forming inconsistent signer sets. Signing rounds then deadlocked because each party expected messages from a different participant set.

The fix works because the bootstrap communication graph is fully symmetric — every party calls `connectRoutine` for all expected peers and `handleSigner` runs on both sides — so all online parties always observe the same peer set and reach the timeout at the same logical moment, producing a consistent signer subset. `tss-lib` only requires `len(signers) >= threshold+1`; any `k ≥ t+1` is valid via Lagrange interpolation.

---

### `p2p/p2p_transporter.go` — three p2p reliability fixes

**Fix A — Protocol handler phase separation**

Previously both the bootstrap host and the sign host registered both `bootstrapProtocolId` and `partyProtocolId` handlers. This caused sign streams to sometimes land on the still-running bootstrap host where they were silently consumed and discarded, causing the signing session to stall.

Now each host registers only its own protocol handler: bootstrap hosts register `bootstrapProtocolId`; sign hosts register `partyProtocolId`.

**Fix B — Clear swarm dial backoff before each connect attempt**

libp2p's swarm applies exponential backoff (starting at 5 s) after a failed connection attempt. When a party started late, the first connection attempt hit an unready peer, placed it in backoff, and prevented retries for the entire discovery window.

The fix calls `sw.Backoff().Clear(pid)` before each connect attempt to reset the backoff for that peer.

**Fix C — Retry instead of panic on `NewStream` failure**

When `NewStream` returned "protocol not supported" (sign stream hitting a peer's still-running bootstrap host — a transient startup overlap), the original code called `common.Panic`, crashing the party.

The fix logs the error, calls `ClosePeer` to reset the connection, and `continue`s the retry loop. The inter-retry sleep is also reduced from 1000 ms to 500 ms to avoid narrowly missing the discovery deadline.

---

## Regenerating the patch

After modifying Go sources inside the `tss/` submodule:

```bash
cd tss
git diff > ../tss-tools/patches/tss-source.patch
# verify it applies cleanly in reverse:
git apply -R --check ../tss-tools/patches/tss-source.patch
```

The build script (`tss-tools/build-tss.sh`) applies the patch with `git apply` before invoking `go build`. If the patch is stale (e.g. upstream changed line numbers), regenerate as above.
