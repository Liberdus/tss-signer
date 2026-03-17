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
- `init.ts`, `keygen.ts`, `regroup.ts`, `verify.ts`, `sign-ethereum-tx.ts`
  - TypeScript entrypoints for native TSS flows
  - compiled into `dist/tss-tools/*.js` by `npm run compile-tss`
- `derive-pubkey/main.go`
  - Go helper source that is staged into `../tss/.tooling` and run inside the patched `tss` module to derive Ethereum pubkey/address
- `guide.md`
  - step-by-step operator guide for local native-TSS workflows

The upstream `tss` source is fetched via Git submodule and patched locally before build/use.
