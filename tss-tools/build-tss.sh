#!/usr/bin/env bash
set -euo pipefail

DEFAULT_GO_VERSION="1.20.3"
DEFAULT_BINARY_NAME="tss"
DEFAULT_DERIVE_BINARY_NAME="tss-derive-pubkey"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLING_ROOT="${SIGNER_ROOT}/.tooling"
TSS_ROOT="${BNB_TSS_ROOT:-${SIGNER_ROOT}/tss}"
PATCH_PATH="${SIGNER_ROOT}/tss-tools/patches/tss-source.patch"
BINARY_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_BINARY_NAME}"
DERIVE_BINARY_PATH="${TSS_ROOT}/.tooling/bin/${DEFAULT_DERIVE_BINARY_NAME}"
HELPER_SOURCE_PATH="${SIGNER_ROOT}/tss-tools/derive-pubkey/main.go"
HELPER_DIR="${TSS_ROOT}/.tooling/derive-pubkey"
HELPER_MAIN_PATH="${HELPER_DIR}/main.go"

dir_has_entries() {
  local dir_path="$1"
  [[ -d "${dir_path}" ]] || return 1
  [[ -n "$(ls -A "${dir_path}" 2>/dev/null)" ]]
}

pick_cache_path() {
  local preferred_path="$1"
  local fallback_path="$2"
  if dir_has_entries "${preferred_path}"; then
    printf '%s\n' "${preferred_path}"
    return
  fi
  if dir_has_entries "${fallback_path}"; then
    printf '%s\n' "${fallback_path}"
    return
  fi
  printf '%s\n' "${preferred_path}"
}

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

DEFAULT_GOCACHE="${TOOLING_ROOT}/go-cache"
DEFAULT_GOMODCACHE="${TOOLING_ROOT}/go-modcache"
FALLBACK_GOCACHE="${TSS_ROOT}/.tooling/go-cache"
FALLBACK_GOMODCACHE="${TSS_ROOT}/.tooling/go-modcache"

GOCACHE="${GOCACHE:-$(pick_cache_path "${DEFAULT_GOCACHE}" "${FALLBACK_GOCACHE}")}"
GOMODCACHE="${GOMODCACHE:-$(pick_cache_path "${DEFAULT_GOMODCACHE}" "${FALLBACK_GOMODCACHE}")}"

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

echo "Built ${BINARY_PATH}"
echo "Built ${DERIVE_BINARY_PATH}"
