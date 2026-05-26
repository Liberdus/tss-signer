#!/usr/bin/env bash
set -euo pipefail

DEFAULT_GO_VERSION="1.23.12"
DEFAULT_BINARY_NAME="tss"
DEFAULT_DERIVE_BINARY_NAME="tss-derive-pubkey"
DEFAULT_TBNBCLI_NAME="tbnbcli"
DEFAULT_PATCH_PEER_ADDRS_NAME="patch-peer-addrs"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TSS_ROOT="${BNB_TSS_ROOT:-${SIGNER_ROOT}/tss}"
PATCH_PATH="${SIGNER_ROOT}/tss-tools/patches/tss-source.patch"
BINARY_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_BINARY_NAME}"
DERIVE_BINARY_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_DERIVE_BINARY_NAME}"
TBNBCLI_SOURCE_PATH="${TSS_ROOT}/${DEFAULT_TBNBCLI_NAME}"
TBNBCLI_TARGET_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_TBNBCLI_NAME}"
PATCH_PEER_ADDRS_SOURCE="${SIGNER_ROOT}/tss-tools/patch-peer-addrs"
PATCH_PEER_ADDRS_BINARY_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_PATCH_PEER_ADDRS_NAME}"
HELPER_SOURCE_PATH="${SIGNER_ROOT}/tss-tools/derive-pubkey/main.go"
HELPER_DIR="${TSS_ROOT}/.tooling/derive-pubkey"
HELPER_MAIN_PATH="${HELPER_DIR}/main.go"

if [[ ! -f "${TSS_ROOT}/go.mod" || ! -d "${TSS_ROOT}/cmd" ]]; then
  echo "Unable to locate tss repo at ${TSS_ROOT}. Run git submodule update --init --recursive first." >&2
  exit 1
fi

if [[ ! -f "${PATCH_PATH}" ]]; then
  echo "Missing TSS patch file at ${PATCH_PATH}" >&2
  exit 1
fi

if git -C "${TSS_ROOT}" apply --check "${PATCH_PATH}" >/dev/null 2>&1; then
  git -C "${TSS_ROOT}" apply "${PATCH_PATH}"
elif git -C "${TSS_ROOT}" apply -R --check "${PATCH_PATH}" >/dev/null 2>&1; then
  :
else
  echo "TSS patch could not be applied cleanly." >&2
  git -C "${TSS_ROOT}" apply --check "${PATCH_PATH}" || true
  exit 1
fi

GO_BIN="${GO_BIN:-}"
VENDORED_GO="${TSS_ROOT}/.tooling/mise/data/installs/go/${DEFAULT_GO_VERSION}/bin/go"

ensure_go_bin() {
  if [[ -n "${GO_BIN}" ]]; then
    return
  fi
  if command -v go >/dev/null 2>&1; then
    GO_BIN="go"
    return
  fi
  if [[ -x "${VENDORED_GO}" ]]; then
    GO_BIN="${VENDORED_GO}"
    return
  fi

  SETUP_SCRIPT="${SIGNER_ROOT}/tss-tools/setup-mise-go.sh"
  if [[ ! -x "${SETUP_SCRIPT}" ]]; then
    echo "Go toolchain not found and ${SETUP_SCRIPT} is unavailable." >&2
    exit 1
  fi

  if ! "${SETUP_SCRIPT}"; then
    if [[ ! -x "${VENDORED_GO}" ]]; then
      echo "Failed to bootstrap Go with ${SETUP_SCRIPT}." >&2
      exit 1
    fi
  fi

  GO_BIN="${VENDORED_GO}"
}

if [[ -n "${GO_BIN}" && ! -x "${GO_BIN}" ]]; then
  echo "GO_BIN is set but not executable: ${GO_BIN}" >&2
  exit 1
fi

ensure_go_bin

mkdir -p "${TSS_ROOT}/.tooling/bin"
mkdir -p "${HELPER_DIR}"

DEFAULT_GOCACHE="${TSS_ROOT}/.tooling/go-cache"
DEFAULT_GOMODCACHE="${TSS_ROOT}/.tooling/go-modcache"

GOCACHE="${GOCACHE:-${DEFAULT_GOCACHE}}"
GOMODCACHE="${GOMODCACHE:-${DEFAULT_GOMODCACHE}}"

mkdir -p "${GOCACHE}" "${GOMODCACHE}"

if [[ ! -f "${HELPER_SOURCE_PATH}" ]]; then
  echo "Missing derive-pubkey helper source at ${HELPER_SOURCE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${HELPER_MAIN_PATH}" ]] || ! cmp -s "${HELPER_SOURCE_PATH}" "${HELPER_MAIN_PATH}"; then
  cp "${HELPER_SOURCE_PATH}" "${HELPER_MAIN_PATH}"
fi

(
  cd "${TSS_ROOT}"
  env GOCACHE="${GOCACHE}" GOMODCACHE="${GOMODCACHE}" "${GO_BIN}" build -o "${BINARY_PATH}" ./main.go
  env GOCACHE="${GOCACHE}" GOMODCACHE="${GOMODCACHE}" "${GO_BIN}" build -o "${DERIVE_BINARY_PATH}" ./.tooling/derive-pubkey/main.go
)

# On Linux the repo-bundled tbnbcli is a macOS Mach-O binary and won't run.
# addToBnbcli only registers the key in the BNB Chain keystore, which is not
# used for Ethereum/EVM signing. Replace it with a no-op stub so keygen
# completes cleanly without panicking.
OS="$(uname -s)"
if [[ "${OS}" == "Linux" ]]; then
  if [[ ! -f "${TBNBCLI_SOURCE_PATH}" ]] || ! file "${TBNBCLI_SOURCE_PATH}" 2>/dev/null | grep -q "ELF"; then
    printf '#!/usr/bin/env bash\nexit 0\n' > "${TBNBCLI_SOURCE_PATH}"
    chmod +x "${TBNBCLI_SOURCE_PATH}"
    echo "Created no-op tbnbcli stub at ${TBNBCLI_SOURCE_PATH}"
  fi
fi

if [[ -f "${TBNBCLI_SOURCE_PATH}" ]]; then
  cp "${TBNBCLI_SOURCE_PATH}" "${TBNBCLI_TARGET_PATH}"
  chmod +x "${TBNBCLI_TARGET_PATH}"
fi

(
  cd "${PATCH_PEER_ADDRS_SOURCE}"
  env GOCACHE="${GOCACHE}" GOMODCACHE="${GOMODCACHE}" "${GO_BIN}" build -o "${PATCH_PEER_ADDRS_BINARY_PATH}" .
)

echo "Built ${BINARY_PATH}"
echo "Built ${DERIVE_BINARY_PATH}"
if [[ -f "${TBNBCLI_TARGET_PATH}" ]]; then
  echo "Copied ${TBNBCLI_TARGET_PATH}"
fi
echo "Built ${PATCH_PEER_ADDRS_BINARY_PATH}"
