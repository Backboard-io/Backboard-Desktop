#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_ARCH="${1:?Expected x64 or arm64}"
case "${NPM_ARCH}" in
	x64) TARGET=x86_64-apple-darwin; MACHO_ARCH=x86_64 ;;
	arm64) TARGET=aarch64-apple-darwin; MACHO_ARCH=arm64 ;;
	*) echo "Unsupported architecture: ${NPM_ARCH}" >&2; exit 1 ;;
esac
SDK_ROOT="${REPO_ROOT}/backboard/node_modules/@microsoft/mxc-sdk"
BINARY="${SDK_ROOT}/bin/${NPM_ARCH}/mxc-exec-mac"
if [[ -x "${BINARY}" ]] && lipo "${BINARY}" -verify_arch "${MACHO_ARCH}" >/dev/null 2>&1; then
	exit 0
fi

# The 0.6 npm distribution contains the Apple-silicon executable only. Build
# the Intel helper from Microsoft's compatible 0.6.1 source, with its lockfile
# and Rust toolchain. Never silently pair this helper with a newer SDK family.
SDK_VERSION="$(node -p "require('${SDK_ROOT}/package.json').version")"
case "${SDK_VERSION}" in
	0.6.0|0.6.1) ;;
	*) echo "Missing ${NPM_ARCH} helper for SDK ${SDK_VERSION}; update the pinned MXC source first." >&2; exit 1 ;;
esac
MXC_REVISION=161598fd08a4fdd030f461de19af23ce4a310b41
SOURCE="$(mktemp -d /tmp/backboard-mxc-source.XXXXXX)"
trap 'rm -rf "${SOURCE}"' EXIT
git clone --quiet --depth 1 --branch v0.6.1 https://github.com/microsoft/mxc.git "${SOURCE}"
test "$(git -C "${SOURCE}" rev-parse HEAD)" = "${MXC_REVISION}"
echo "Building ${TARGET} sandbox helper from microsoft/mxc ${MXC_REVISION}"
(
	cd "${SOURCE}/src"
	CARGO_BUILD_JOBS=2 cargo build --locked --release --package mxc_darwin --target "${TARGET}"
)
mkdir -p "$(dirname "${BINARY}")"
install -m 0755 "${SOURCE}/src/target/${TARGET}/release/mxc-exec-mac" "${BINARY}"
lipo "${BINARY}" -verify_arch "${MACHO_ARCH}"
node - "${SDK_ROOT}" "${MXC_REVISION}" "${TARGET}" <<'JS'
const fs = require('node:fs');
const [root, revision, target] = process.argv.slice(2);
fs.writeFileSync(`${root}/backboard-native-source.json`, JSON.stringify({
  repository: 'https://github.com/microsoft/mxc', revision, version: '0.6.1', target
}, null, 2) + '\n');
JS
