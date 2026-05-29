#!/usr/bin/env bash
set -euo pipefail

DEFAULT_GO_VERSION="1.23.12"
DEFAULT_MISE_VERSION="v2026.3.8"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TSS_ROOT="${BNB_TSS_ROOT:-${SIGNER_ROOT}/tss}"
MISE_ROOT="${TSS_ROOT}/.tooling/mise"
MISE_BIN="${MISE_ROOT}/bin/mise/bin/mise"
MISE_DATA_DIR="${MISE_ROOT}/data"
MISE_CONFIG_DIR="${MISE_ROOT}/config"
GO_BIN="${MISE_DATA_DIR}/installs/go/${DEFAULT_GO_VERSION}/bin/go"

unsupported_platform_message() {
  local uname_s="$1"
  local uname_m="$2"
  echo "Unsupported platform '${uname_s}/${uname_m}'. Supported mise platforms: macos-arm64, macos-x64, linux-x64, linux-arm64. Windows is not supported by this bootstrap flow." >&2
}

resolve_mise_platform() {
  local uname_s="${1:-$(uname -s)}"
  local uname_m="${2:-$(uname -m)}"
  local os=""
  local arch=""

  case "${uname_s}" in
    Darwin)
      os="macos"
      ;;
    Linux)
      os="linux"
      ;;
    *)
      unsupported_platform_message "${uname_s}" "${uname_m}"
      return 1
      ;;
  esac

  case "${uname_m}" in
    arm64|aarch64)
      arch="arm64"
      ;;
    x86_64|amd64)
      arch="x64"
      ;;
    *)
      unsupported_platform_message "${uname_s}" "${uname_m}"
      return 1
      ;;
  esac

  case "${os}-${arch}" in
    macos-arm64|macos-x64|linux-x64|linux-arm64)
      printf '%s\n' "${os}-${arch}"
      ;;
    *)
      unsupported_platform_message "${uname_s}" "${uname_m}"
      return 1
      ;;
  esac
}

resolve_mise_archive_name() {
  local platform="${1:-$(resolve_mise_platform)}"
  printf 'mise-%s-%s.tar.gz\n' "${DEFAULT_MISE_VERSION}" "${platform}"
}

main() {
  if [[ ! -f "${TSS_ROOT}/go.mod" || ! -d "${TSS_ROOT}/cmd" ]]; then
    echo "Unable to locate tss repo at ${TSS_ROOT}. Run git submodule update --init --recursive first." >&2
    exit 1
  fi

  mkdir -p "${MISE_ROOT}/bin" "${MISE_DATA_DIR}" "${MISE_CONFIG_DIR}"

  if [[ ! -x "${MISE_BIN}" ]]; then
    local mise_platform archive_name archive_path
    mise_platform="$(resolve_mise_platform)"
    archive_name="$(resolve_mise_archive_name "${mise_platform}")"
    archive_path="/tmp/${archive_name}"
    curl -fL \
      --retry 5 \
      --retry-delay 2 \
      --retry-all-errors \
      "https://github.com/jdx/mise/releases/download/${DEFAULT_MISE_VERSION}/${archive_name}" \
      -o "${archive_path}"
    tar -xzf "${archive_path}" -C "${MISE_ROOT}/bin"
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
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
