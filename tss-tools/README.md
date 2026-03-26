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
  - Standalone Go utility that patches the `peer_addrs` and `peers` fields inside each party's encrypted `config.json` vault file. Needed when keystores were generated locally (all peers on `127.0.0.1`) and must be deployed to separate machines with real public IPs. Has its own `go.mod`; run it with the mise Go toolchain. See [Patching peer addresses](#patching-peer-addresses) below.
- `guide.md`
  - Step-by-step operator guide for local native TSS workflows: build, init, keygen, verify, sign, regroup, runtime requirements.
- `patches/README.md`
  - Describes every change in `tss-source.patch`, the reason for each, and how to regenerate the patch.

## How it fits together

The upstream `tss` source is fetched via Git submodule and patched locally before build/use. The patch is applied automatically by `build-tss.sh`. Native vaults are stored under:

```
keystores/bnbtss/party-<idx>/chain-<chainId>/default/
```

User-facing party indices start at 1. The binary resolves to `tss/.tooling/bin/tss`.

For the step-by-step operator workflow, see `guide.md`. For production multi-operator setup, see `../PARTY_SETUP.md`.

---

## Patching peer addresses

When keystores are generated on a local machine (all parties on `127.0.0.1`) and then distributed to remote machines, the `tss sign` command will fail because it dials the stored `127.0.0.1` addresses instead of the real machine IPs.

`patch-peer-addrs/` is a Go utility that fixes this without re-running keygen or regroup. It decrypts the `config` blob inside each party's `config.json` (Argon2id + AES-256-CTR), replaces `p2p.peer_addrs` and `p2p.peers` with the real machine multiaddrs, and re-encrypts in place. The cryptographic key shares (`pk.json`, `sk.json`, `node_key`) are never touched.

### When to use

- Keystores were generated locally and deployed to remote machines
- `tss sign` logs show peers dialling `127.0.0.1` and failing with `connection refused`
- You want to fix peer addresses **without** a new keygen (which would change the TSS Ethereum address) or a regroup

### Prerequisites

- The mise Go toolchain bundled with the repo (`tss/.tooling/mise/...`)
- The vault password (`BNB_TSS_PASSWORD`)

For full step-by-step instructions — collecting peer IDs with `tss describe`, running the utility, deploying the patched files, validating with a native sign test, and restarting processes — see **section 20** of [`guide.md`](guide.md).
