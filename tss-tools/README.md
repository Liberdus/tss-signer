# TSS Overlay

This directory contains the `tss-signer`-owned native TSS tools for the upstream Binance `tss` repository.

Structure:

- `../tss/`
  - Git submodule pointing to `https://github.com/bnb-chain/tss.git`
- `patches/tss-source.patch`
  - source patch applied onto `../tss` before build/use
- `lib/bnbTss.js`
  - runtime/build helpers for preparing the upstream tree
  - builds the native binaries into `../tss/.tooling/bin/tss` and `../tss/.tooling/bin/tss-derive-pubkey`
- `keygen.js`, `regroup.js`, `verify.js`, `sign-ethereum-tx.js`
  - direct Node entrypoints for native TSS flows
- `derive-pubkey/main.go`
  - Go helper source that is staged into `../tss/.tooling` and run inside the patched `tss` module to derive Ethereum pubkey/address
- `guide.md`
  - step-by-step operator guide for local native-TSS workflows

The upstream `tss` source is fetched via Git submodule and patched locally before build/use.
