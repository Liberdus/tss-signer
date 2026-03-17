#!/usr/bin/env bash
set -euo pipefail

DEFAULT_GO_VERSION="1.20.3"
DEFAULT_MISE_VERSION="v2026.3.8"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TSS_ROOT="${BNB_TSS_ROOT:-${SIGNER_ROOT}/tss}"
MISE_ROOT="${TSS_ROOT}/.tooling/mise"
MISE_BIN="${MISE_ROOT}/bin/mise/bin/mise"
MISE_DATA_DIR="${MISE_ROOT}/data"
MISE_CONFIG_DIR="${MISE_ROOT}/config"
GO_BIN="${MISE_DATA_DIR}/installs/go/${DEFAULT_GO_VERSION}/bin/go"

if [[ ! -f "${TSS_ROOT}/go.mod" || ! -d "${TSS_ROOT}/cmd" ]]; then
  echo "Unable to locate tss repo at ${TSS_ROOT}. Run git submodule update --init --recursive first." >&2
  exit 1
fi

mkdir -p "${MISE_ROOT}/bin" "${MISE_DATA_DIR}" "${MISE_CONFIG_DIR}"

if [[ ! -x "${MISE_BIN}" ]]; then
  ARCHIVE_PATH="/tmp/mise-macos-arm64.tar.gz"
  curl -fL \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    "https://github.com/jdx/mise/releases/download/${DEFAULT_MISE_VERSION}/mise-${DEFAULT_MISE_VERSION}-macos-arm64.tar.gz" \
    -o "${ARCHIVE_PATH}"
  tar -xzf "${ARCHIVE_PATH}" -C "${MISE_ROOT}/bin"
fi

env \
  MISE_DATA_DIR="${MISE_DATA_DIR}" \
  MISE_CONFIG_DIR="${MISE_CONFIG_DIR}" \
  MISE_TRUSTED_CONFIG_PATHS="${TSS_ROOT}" \
  "${MISE_BIN}" install "go@${DEFAULT_GO_VERSION}"

if [[ ! -x "${GO_BIN}" ]]; then
  echo "Failed to install Go ${DEFAULT_GO_VERSION} under ${MISE_DATA_DIR}." >&2
  exit 1
fi

echo "Installed Go ${DEFAULT_GO_VERSION}: ${GO_BIN}"
"${GO_BIN}" version
