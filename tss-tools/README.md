# TSS Overlay

This directory contains the `tss-signer`-owned native TSS tools for the upstream Binance `tss` repository.

## Structure

- `../tss/`
  - Git submodule pointing to `https://github.com/bnb-chain/tss.git`
- `patches/tss-source.patch`
  - Source patch applied onto `../tss` before build/use. See `patches/README.md` for a description of every change.
- `lib/bnbTss.ts`
  - Runtime and build helpers: binary resolution, patch preparation, vault path layout, committee topology, and signing helpers. Used by all tooling scripts and by `tss-party.ts`.
- `lib/committeeTopology.ts`
  - Committee topology helper for deterministic local peer addresses (same-machine dev/test) and parsed `tss describe` topology output.
- `lib/channelId.ts`
  - Deterministic signing `channelId` derived from `txId` and `txTimestamp`.
  - Deterministic signing `channelPassword` derived from `channelId` and `SHARDUS_CRYPTO_HASH_KEY`.
- `init.ts`, `keygen.ts`, `regroup.ts`, `verify.ts`, `sign-ethereum-tx.ts`
  - TypeScript entrypoints for native TSS flows. Compiled to `dist/tss-tools/*.js` by `npm run compile`.
- `../scripts/tss-keygen-ceremony.ts`, `../scripts/tss-regroup-ceremony.ts`
  - Higher-level ceremony wrappers for the normal multi-machine operator flow. They resolve committee position from shared ordered-IP config, derive deterministic channel credentials, and compute peer address topology automatically.
- `derive-pubkey/main.go`
  - Go helper source staged into `../tss/.tooling` and run inside the patched `tss` module to derive an Ethereum pubkey/address from an existing vault. Used by `verify.ts` and post-keygen address derivation.
- `build-tss.sh`
  - Applies `patches/tss-source.patch` to the upstream `tss` checkout and builds the native binary to `../tss/.tooling/bin/tss` plus the `tss-derive-pubkey` helper.
- `setup-mise-go.sh`
  - Bootstraps a local Go toolchain under `tss/.tooling/mise` when the system `go` binary is absent or the wrong version.
  - Supports `darwin-arm64`, `linux-x64`, and `linux-arm64`.
  - Windows is not supported by this bootstrap flow.
- `test-sign-rounds.sh`
  - Multi-scenario signing test harness. Runs configurable rounds across 34 startup-delay scenarios for a configurable committee size (default 7-party, threshold=3, min_sign=4 for thorough coverage). Reports PASS/FAIL per scenario. Logs to `test-result.log` and `test-party{1..N}.log`.
- `patch-peer-addrs/`
  - Standalone Go utility that patches the `peer_addrs` and `peers` fields inside each party's encrypted `config.json` vault file. Needed when keystores were generated locally (all peers on `127.0.0.1`) and must be deployed to separate machines with real public IPs. Built by `npm run tss-build` to `tss/.tooling/bin/patch-peer-addrs`. See [Patching peer addresses](#patching-peer-addresses) below.
- `guide.md`
  - Operator guide covering both the preferred ceremony-based remote flow and the lower-level manual native workflows.
- `patches/README.md`
  - Describes every change in `tss-source.patch`, the reason for each, and how to regenerate the patch.

## How it fits together

The upstream `tss` source is fetched via Git submodule and patched locally before build/use. The patch is applied automatically by `build-tss.sh`.

Default ceremony-based vault layout:

```
keystores/bnbtss/chain-<chainId>/default/
```

Legacy indexed/manual vault layout:

```
keystores/bnbtss/party-<idx>/chain-<chainId>/default/
```

User-facing party indices start at 1. The binary resolves to `tss/.tooling/bin/tss`.

For the remote multi-IP keygen/regroup test flow, see `keygen-regroup-ceremony.md`.
For the broader production/operator procedure, see `../PARTY_SETUP.md`.
For the lower-level operator workflow, see `guide.md`.

---

## Patching peer addresses

When keystores are generated on a local machine (all parties on `127.0.0.1`) and then distributed to remote machines, the `tss sign` command will fail because it dials the stored `127.0.0.1` addresses instead of the real machine IPs.

`patch-peer-addrs/` is a Go utility that fixes this without re-running keygen or regroup. It decrypts the `config` blob inside each party's `config.json` (Argon2id + AES-256-CTR), replaces `p2p.peer_addrs` and `p2p.peers` with the real machine multiaddrs, and re-encrypts in place. The cryptographic key shares (`pk.json`, `sk.json`, `node_key`) are never touched.

### When to use

- Keystores were generated locally and deployed to remote machines
- `tss sign` logs show peers dialling `127.0.0.1` and failing with `connection refused`
- You want to fix peer addresses **without** a new keygen (which would change the TSS Ethereum address) or a regroup

### Prerequisites

- Run `npm run tss-build` first — this builds the binary to `tss/.tooling/bin/patch-peer-addrs`
- The vault password (`BNB_TSS_PASSWORD`)
- All parties' public IPs and peer IDs (collected via `tss describe` on each machine)

### Two modes

| Mode | Flag | Use case |
|---|---|---|
| Patch all | *(omit `--party`)* | All keystores present locally (dev/staging) |
| Patch one | `--party N` | Production: each operator runs on their own machine against their own vault only |

In production, the workflow is: each operator runs `tss describe` to get their peer ID → share all peer IDs out-of-band → each operator runs `patch-peer-addrs --party N` locally → restart.

> **Custom monikers:** If non-default monikers were used during `tss init`, pass `--monikers m1,m2,...` so remote party entries in `p2p.peers` are written correctly. Without it, the tool synthesizes `party-N-chain-ID` for any vault it cannot read locally and prints a WARNING. `--party` is validated to be in range; an out-of-range value exits with an error.

For full step-by-step instructions for both modes — see **section 20** of [`guide.md`](guide.md).
