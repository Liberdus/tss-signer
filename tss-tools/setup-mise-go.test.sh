#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./setup-mise-go.sh
source "${SCRIPT_DIR}/setup-mise-go.sh"

assert_eq() {
  local actual="$1"
  local expected="$2"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

test_supported_platforms() {
  assert_eq "$(resolve_mise_platform Darwin arm64)" "darwin-arm64"
  assert_eq "$(resolve_mise_platform Linux x86_64)" "linux-x64"
  assert_eq "$(resolve_mise_platform Linux aarch64)" "linux-arm64"
  assert_eq "$(resolve_mise_archive_name linux-x64)" "mise-${DEFAULT_MISE_VERSION}-linux-x64.tar.gz"
}

test_unsupported_platforms() {
  if resolve_mise_platform MINGW64_NT-10.0 x86_64 >/tmp/setup-mise-go-test.out 2>/tmp/setup-mise-go-test.err; then
    echo "expected Windows-like platform to fail" >&2
    exit 1
  fi
  if ! grep -q "Windows is not supported" /tmp/setup-mise-go-test.err; then
    echo "expected unsupported platform error to mention Windows" >&2
    exit 1
  fi
}

main() {
  test_supported_platforms
  test_unsupported_platforms
  echo "setup-mise-go tests passed"
}

main "$@"
