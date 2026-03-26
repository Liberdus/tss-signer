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
