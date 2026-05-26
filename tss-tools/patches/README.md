# tss-source.patch

Local patch applied onto the upstream [bnb-chain/tss](https://github.com/bnb-chain/tss) submodule before build and use. Applied automatically by `tss-tools/build-tss.sh`.

## Changes

### `go.mod` and TSS wrapper — upgrade to `tss-lib/v3`

Updates the native TSS module to Go `1.23` / toolchain `1.23.12`, imports `github.com/bnb-chain/tss-lib/v3` at `v3.0.0`, refreshes the dependency graph, uses the v3 pointer result channels for keygen/regroup save-data completion and signing completion, and replaces the old `btcd/btcec` compressed public-key serialization with local SEC 1 compressed public-key encoding.

**Why:** Keeps the native TSS binary compatible with `tss-lib/v3` and Go `1.23.12`, while avoiding `btcd` dependency conflicts by handling compressed public-key serialization locally.

---

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

### `common/messages.go` — add `DiscoveryExpiry` to `PeerParam`

Adds `DiscoveryExpiry int64` (Unix nanoseconds) to `PeerParam`. Zero means the sender's deadline is not yet set.

**Why:** Parties that start late would otherwise open a fresh discovery window when their first peer connected, accumulating a different (larger) set of signers than the early parties and causing committee inconsistency. By piggybacking the session deadline in every bootstrap exchange, a late party can adopt the already-elapsed deadline of the early session and close immediately rather than reopening a new window.

---

### `common/bootstrapper.go` — time-boxed discovery for flexible k-of-n signing

Adds fields to `Bootstrapper`:

- `firstPeerOnce sync.Once` — ensures the local deadline is started exactly once per session
- `deadlineMu sync.RWMutex` — guards concurrent reads/writes of `discoveryDeadline`
- `discoveryDeadline time.Time` — absolute cutoff set when the first peer arrives
- `committed int32` — atomic flag set to 1 after `initBootstrapConnection` exits its polling loop

Adds three new methods:

- `Commit()` — sets `committed = 1` atomically
- `IsCommitted() bool` — reads `committed` atomically
- `GetDiscoveryDeadlineNano() int64` — returns the deadline as Unix nanoseconds (0 if not set), used to populate `DiscoveryExpiry` in outgoing bootstrap messages

Modifies `HandleBootstrapMsg` to:

1. Start the discovery timer (via `firstPeerOnce`) on the first new peer in `SignMode`
2. Adopt a peer's `DiscoveryExpiry` if it is earlier than the local deadline — late-arriving parties inherit the already-elapsed session deadline

Replaces the `SignMode` case in `IsFinished()` with two exit conditions:

- **Fast path:** all `n-1` expected peers connected → close immediately
- **Timeout path:** `SignDiscoveryTimeout` has elapsed since the first peer arrived AND at least `threshold` peers are present → close with the available subset

**Why:** The original code exited discovery as soon as `received >= threshold`, which caused a race: different parties could exit at different moments with different peer counts, forming inconsistent signer sets and deadlocking all signing rounds. The discovery window gives all simultaneously-starting parties time to connect before the session closes, while still allowing partial signing when some parties are genuinely absent.

The `committed` flag and `Commit()`/`IsCommitted()` separation address a secondary race: `IsFinished()` returns true as soon as the deadline elapses and enough peers exist, but the 1-second polling loop in `initBootstrapConnection` hasn't exited yet. During that gap, late-arriving parties could still be accepted by `handleSigner` and form a different committee size. `handleSigner` now guards on `IsCommitted()` instead of `IsFinished()`, so the window only closes after the loop exits and calls `Commit()`.

---

### `p2p/p2p_transporter.go` — p2p reliability fixes

**Fix A — Protocol handler phase separation**

Previously both the bootstrap host and the sign host registered both `bootstrapProtocolId` and `partyProtocolId` handlers. This caused sign streams to sometimes land on the still-running bootstrap host where they were silently consumed and discarded, causing the signing session to stall.

Now each host registers only its own protocol handler: bootstrap hosts register `bootstrapProtocolId`; sign hosts register `partyProtocolId`.

**Fix B — Clear swarm dial backoff before each connect attempt**

libp2p's swarm applies exponential backoff (starting at 5 s) after a failed connection attempt. When a party started late, the first connection attempt hit an unready peer, placed it in backoff, and prevented retries for the entire discovery window.

The fix calls `sw.Backoff().Clear(pid)` before each connect attempt to reset the backoff for that peer.

**Fix C — Retry instead of panic on `NewStream` failure**

When `NewStream` returned "protocol not supported" (sign stream hitting a peer's still-running bootstrap host — a transient startup overlap), the original code called `common.Panic`, crashing the party.

The fix logs the error, calls `ClosePeer` to reset the connection, and `continue`s the retry loop. The inter-retry sleep is also reduced from 1000 ms to 500 ms to avoid narrowly missing the discovery deadline.

**Fix D — `handleSigner` uses `IsCommitted()` instead of `IsFinished()`**

`handleSigner` now rejects incoming bootstrap connections only after `IsCommitted()` is true (i.e. after `initBootstrapConnection` has exited its polling loop and called `Commit()`). Previously it checked `IsFinished()`, which returned true up to 1 second before the loop exited. During that gap, simultaneously arriving late parties could be split — some accepted, some rejected — forming committees of different sizes.

**Fix E — `handleSigner` includes `DiscoveryExpiry` in bootstrap reply**

The bootstrap reply message now includes `DiscoveryExpiry: t.bootstrapper.GetDiscoveryDeadlineNano()`. This lets late-connecting parties adopt the session's already-elapsed deadline (see `common/bootstrapper.go` above).

**Fix F — `Commit()` called after `initBootstrapConnection` polling loop**

After the `for { if IsFinished() break; sleep 1s }` loop exits, `t.bootstrapper.Commit()` is called immediately. This atomically closes the window so that `handleSigner` rejects any subsequent incoming bootstrap connections.

**Fix G — `handleStream` committee membership filter**

`handleStream` (the sign-phase connection handler) now rejects streams from peers not in `t.expectedPeers`. This prevents a late party that bootstrapped with a different committee from injecting TSS messages into an ongoing signing session.

---

### `client/client.go` — nil guard in `handleMessageRoutine`

`handleMessageRoutine` now checks whether the sender ID maps to a known party before calling `UpdateFromBytes`. If the sender is not in `idToPartyIds` (e.g. a late party that formed a different committee and got a message through), the message is logged and skipped instead of causing a nil-pointer panic.

**Why:** Without this guard, a message from an unknown party ID causes `client.idToPartyIds[id]` to return `nil`, and passing `nil` as the `from` argument to `UpdateFromBytes` panics inside tss-lib.

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
