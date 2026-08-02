#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_ROOT="${REPO_ROOT}/vscode"
VERSION="${VERSION:-${1:-}}"
ARCH="${ARCH:-aarch64}"
CHANNEL="${CHANNEL:-stable}"

if [[ -z "${VERSION}" ]]; then
  echo "Missing VERSION. Example: VERSION=2.0.9 $0" >&2
  exit 1
fi

case "${ARCH}" in
  aarch64)
    GULP_TARGET="vscode-darwin-arm64"
    VSAPP_DIR="${REPO_ROOT}/VSCode-darwin-arm64"
    ;;
  x86_64)
    GULP_TARGET="vscode-darwin-x64"
    VSAPP_DIR="${REPO_ROOT}/VSCode-darwin-x64"
    ;;
  *)
    echo "Unsupported ARCH=${ARCH}; expected aarch64 or x86_64" >&2
    exit 1
    ;;
esac

case "${CHANNEL}" in
  stable|sandbox) ;;
  *) echo "Unsupported CHANNEL=${CHANNEL}; expected stable or sandbox" >&2; exit 1 ;;
esac

cd "${VSCODE_ROOT}"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  set +u
  # shellcheck source=/dev/null
  source "${HOME}/.nvm/nvm.sh"
  nvm use
  set -u
fi

echo "Using node $(node -v)"
echo "Preparing the same dev shell used by scripts/code.sh"
node build/lib/preLaunch.ts

echo "Compiling VS Code client"
npm run compile-client

echo "Compiling Backboard extension"
npm --prefix extensions/backboard run compile

echo "Compiling Backboard CLI runtime"
npm --prefix extensions/backboard run package-cli-ts

echo "Building standalone ${GULP_TARGET} app"
BACKBOARD_KEEP_COPILOT_SHIM_MARKER=1 npm run gulp -- "${GULP_TARGET}"

if [[ -d "${VSAPP_DIR}/Backboard IDE.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard IDE.app"
elif [[ -d "${VSAPP_DIR}/Backboard Studio.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard Studio.app"
elif [[ -d "${VSAPP_DIR}/Backboard Studio Dev.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard Studio Dev.app"
else
  echo "Missing packaged app in ${VSAPP_DIR}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if [[ "${SKIP_SIGNING:-0}" == "1" ]]; then
  echo "Packaging Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL}) without signing or notarization"
elif [[ "${SKIP_NOTARIZATION:-0}" == "1" ]]; then
  echo "Packaging Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL}) without notarization"
else
  echo "Packaging and notarizing Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL})"
fi
SKIP_BACKBOARD_REBUILD=1 \
VERSION="${VERSION}" \
ARCH="${ARCH}" \
CHANNEL="${CHANNEL}" \
SKIP_NOTARIZATION="${SKIP_NOTARIZATION:-0}" \
SKIP_SIGNING="${SKIP_SIGNING:-0}" \
VSAPP="${VSAPP}" \
"${REPO_ROOT}/scripts/package_vscode_update_macos.sh"

echo "Built DMG: ${REPO_ROOT}/vscode-release/${VERSION}/${ARCH}/Backboard-Studio-${ARCH}.dmg"
echo
echo "Release size report:"
du -sh "${VSAPP}" "${REPO_ROOT}/vscode-release/${VERSION}/${ARCH}/dmg" "${REPO_ROOT}/vscode-release/${VERSION}/${ARCH}/Backboard-Studio-${ARCH}.dmg"
echo "DMG bytes: $(stat -f%z "${REPO_ROOT}/vscode-release/${VERSION}/${ARCH}/Backboard-Studio-${ARCH}.dmg")"
