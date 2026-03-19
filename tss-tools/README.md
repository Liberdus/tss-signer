# TSS Overlay

This directory contains the `tss-signer`-owned native TSS tools for the upstream Binance `tss` repository.

Structure:

- `../tss/`
  - Git submodule pointing to `https://github.com/bnb-chain/tss.git`
- `patches/tss-source.patch`
  - source patch applied onto `../tss` before build/use
- `lib/bnbTss.ts`
  - runtime/build helpers for preparing the upstream tree
  - builds the native binaries into `../tss/.tooling/bin/tss` and `../tss/.tooling/bin/tss-derive-pubkey`
- `lib/committeeTopology.ts`
  - committee topology helper for deterministic local peer addresses and parsed `tss describe` output
- `lib/channelId.ts`
  - deterministic signing `channelId` helper derived from `txId` and `txTimestamp`
  - deterministic signing `channelPassword` helper derived from `channelId` and `SHARDUS_CRYPTO_HASH_KEY`
- `init.ts`, `keygen.ts`, `regroup.ts`, `verify.ts`, `sign-ethereum-tx.ts`
  - TypeScript entrypoints for native TSS flows
  - compiled into `dist/tss-tools/*.js` by `npm run compile-tss`
- `derive-pubkey/main.go`
  - Go helper source that is staged into `../tss/.tooling` and run inside the patched `tss` module to derive Ethereum pubkey/address
- `test-sign-rounds.sh`
  - multi-scenario signing test harness for a 7-party (threshold=3) setup; runs configurable rounds across 34 startup-delay scenarios and reports PASS/FAIL per scenario
  - logs per-party output to `test-party{1..7}.log` and overall results to `test-result.log`
- `guide.md`
  - step-by-step operator guide for local native-TSS workflows
- `patches/README.md`
  - describes every change in `tss-source.patch`, the reason for each, and how to regenerate the patch

The upstream `tss` source is fetched via Git submodule and patched locally before build/use.
