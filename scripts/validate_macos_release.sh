#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-}"
ARCH="${ARCH:-aarch64}"
CHANNEL="${CHANNEL:-stable}"
DMG_PATH="${DMG_PATH:-}"
EXPECTED_TEAM_ID="${EXPECTED_TEAM_ID:-}"

usage() {
  cat <<EOF
Usage:
  $0 --version 2.5.5 --arch aarch64 --channel stable --expected-team-id M4UYB6AG86 --dmg /path/to/Backboard-Studio-aarch64.dmg

Validates a signed and notarized Backboard Studio macOS release before upload.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --arch)
      ARCH="$2"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --dmg)
      DMG_PATH="$2"
      shift 2
      ;;
    --expected-team-id)
      EXPECTED_TEAM_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${VERSION}" || -z "${DMG_PATH}" ]]; then
  echo "Missing --version or --dmg." >&2
  usage >&2
  exit 1
fi

case "${ARCH}" in
  aarch64)
    EXPECTED_MACHINE="arm64"
    ;;
  x86_64)
    EXPECTED_MACHINE="x86_64"
    ;;
  *)
    echo "Unsupported architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

case "${CHANNEL}" in
  stable)
    EXPECTED_APP_NAME="Backboard Studio.app"
    EXPECTED_BUNDLE_IDENTIFIER="io.backboard.studio"
    ;;
  sandbox)
    EXPECTED_APP_NAME="Backboard Studio Sandbox.app"
    EXPECTED_BUNDLE_IDENTIFIER="io.backboard.studio.sandbox"
    ;;
  *)
    echo "Unsupported channel: ${CHANNEL}; expected stable or sandbox." >&2
    exit 1
    ;;
esac

if [[ ! -f "${DMG_PATH}" ]]; then
  echo "Missing DMG: ${DMG_PATH}" >&2
  exit 1
fi

MOUNT_POINT="$(mktemp -d /tmp/backboard-release-validate-mount.XXXXXX)"
STAGING_ROOT="$(mktemp -d /tmp/backboard-release-validate-app.XXXXXX)"
STAGED_APP="${STAGING_ROOT}/${EXPECTED_APP_NAME}"

cleanup() {
  hdiutil detach "${MOUNT_POINT}" -quiet >/dev/null 2>&1 || true
  rmdir "${MOUNT_POINT}" >/dev/null 2>&1 || true
  if [[ -d "${STAGING_ROOT}" && "${STAGING_ROOT}" == /tmp/backboard-release-validate-app.* ]]; then
    find "${STAGING_ROOT}" -depth -delete
  fi
}
trap cleanup EXIT

echo "Validating DMG signature and notarization"
codesign --verify --verbose=2 "${DMG_PATH}"
if [[ -n "${EXPECTED_TEAM_ID}" ]]; then
  DMG_TEAM_ID="$(codesign -dvvv "${DMG_PATH}" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  if [[ "${DMG_TEAM_ID}" != "${EXPECTED_TEAM_ID}" ]]; then
    echo "DMG signer mismatch: expected team ${EXPECTED_TEAM_ID}, got ${DMG_TEAM_ID:-missing}." >&2
    exit 1
  fi
fi
xcrun stapler validate "${DMG_PATH}"
spctl --assess --type open --context context:primary-signature -vv "${DMG_PATH}"

hdiutil attach "${DMG_PATH}" -mountpoint "${MOUNT_POINT}" -nobrowse -readonly -quiet
SOURCE_APP="${MOUNT_POINT}/${EXPECTED_APP_NAME}"
if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "DMG does not contain ${EXPECTED_APP_NAME}." >&2
  exit 1
fi

echo "Copying app for strict validation"
ditto --norsrc --noextattr --noacl --noqtn "${SOURCE_APP}" "${STAGED_APP}"
xattr -cr "${STAGED_APP}" >/dev/null 2>&1 || true

INFO_PLIST="${STAGED_APP}/Contents/Info.plist"
if [[ ! -f "${INFO_PLIST}" ]]; then
  echo "Packaged app is missing Contents/Info.plist." >&2
  exit 1
fi

ACTUAL_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${INFO_PLIST}")"
BUNDLE_IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${INFO_PLIST}")"
APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${INFO_PLIST}")"
APP_BINARY="${STAGED_APP}/Contents/MacOS/${APP_EXECUTABLE}"

if [[ "${ACTUAL_VERSION}" != "${VERSION}" ]]; then
  echo "Version mismatch: expected ${VERSION}, got ${ACTUAL_VERSION}." >&2
  exit 1
fi
if [[ "${BUNDLE_IDENTIFIER}" != "${EXPECTED_BUNDLE_IDENTIFIER}" ]]; then
  echo "Bundle identifier mismatch: expected ${EXPECTED_BUNDLE_IDENTIFIER}, got ${BUNDLE_IDENTIFIER}." >&2
  exit 1
fi
if [[ ! -x "${APP_BINARY}" ]]; then
  echo "Packaged app executable is missing: ${APP_BINARY}." >&2
  exit 1
fi
if ! file "${APP_BINARY}" | grep -Fq "${EXPECTED_MACHINE}"; then
  echo "Packaged app executable does not contain ${EXPECTED_MACHINE}." >&2
  file "${APP_BINARY}" >&2
  exit 1
fi

echo "Validating app signature and Gatekeeper acceptance"
codesign --verify --deep --strict --verbose=4 "${STAGED_APP}"
if [[ -n "${EXPECTED_TEAM_ID}" ]]; then
  APP_TEAM_ID="$(codesign -dvvv "${STAGED_APP}" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  if [[ "${APP_TEAM_ID}" != "${EXPECTED_TEAM_ID}" ]]; then
    echo "App signer mismatch: expected team ${EXPECTED_TEAM_ID}, got ${APP_TEAM_ID:-missing}." >&2
    exit 1
  fi
fi
spctl --assess --type execute -vv "${STAGED_APP}"

UPDATER_JS="${STAGED_APP}/Contents/Resources/app/extensions/backboard/out/updatesInstaller.js"
if [[ ! -f "${UPDATER_JS}" ]]; then
  echo "Packaged app is missing the Backboard updater implementation." >&2
  exit 1
fi
for marker in \
  'Prepared and verified Backboard Studio' \
  'codesign --verify --deep --strict' \
  'spctl --assess --type execute' \
  'rollback_app' \
  'Confirmed running and activated' \
  'confirm_app_stable' \
  'Updated app exited during post-launch stability check' \
  'Installed and launched Backboard Studio'; do
  if ! grep -Fq "${marker}" "${UPDATER_JS}"; then
    echo "Packaged updater is missing readiness marker: ${marker}" >&2
    exit 1
  fi
done

COPILOT_EXTENSION="${STAGED_APP}/Contents/Resources/app/extensions/copilot"
for runtime_file in \
  'node_modules/source-map-support/source-map-support.js' \
  'node_modules/source-map/source-map.js' \
  'node_modules/buffer-from/index.js' \
  'node_modules/dotenv/lib/main.js'; do
  if [[ ! -f "${COPILOT_EXTENSION}/${runtime_file}" ]]; then
    echo "Packaged Copilot extension is missing runtime dependency: ${runtime_file}" >&2
    exit 1
  fi
done

DMG_SHA256="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"
DMG_BYTES="$(stat -f%z "${DMG_PATH}")"
echo "Release validation passed"
echo "  version: ${ACTUAL_VERSION}"
echo "  architecture: ${ARCH} (${EXPECTED_MACHINE})"
echo "  channel: ${CHANNEL}"
echo "  bundle: ${BUNDLE_IDENTIFIER}"
if [[ -n "${EXPECTED_TEAM_ID}" ]]; then
  echo "  signing team: ${EXPECTED_TEAM_ID}"
fi
echo "  sha256: ${DMG_SHA256}"
echo "  bytes: ${DMG_BYTES}"
