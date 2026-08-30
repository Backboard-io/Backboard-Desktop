#!/bin/zsh
set -euo pipefail

usage() {
  echo "Usage: $0 <stable|sandbox> <source-app> <update-dmg> <expected-version> [installer-module]"
}

if [[ "$#" -lt "4" || "$#" -gt "5" ]]; then
  usage >&2
  exit 2
fi

CHANNEL="$1"
SOURCE_APP="$2"
UPDATE_DMG="$3"
EXPECTED_VERSION="$4"
INSTALLER_MODULE="${5:-}"
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && /bin/pwd -P)"
VSCODE_ROOT="${VSCODE_ROOT:-${REPO_ROOT}/backboard}"
if [[ ! -f "${VSCODE_ROOT}/package.json" && -f "${REPO_ROOT}/vscode/package.json" ]]; then
  VSCODE_ROOT="${REPO_ROOT}/vscode"
fi
TEST_FILE="$VSCODE_ROOT/extensions/backboard/out/test/updatesInstaller.e2e.test.js"

case "$CHANNEL" in
  stable)
    APP_NAME="Backboard Studio.app"
    BUNDLE_IDENTIFIER="io.backboard.studio"
    ;;
  sandbox)
    APP_NAME="Backboard Studio Sandbox.app"
    BUNDLE_IDENTIFIER="io.backboard.studio.sandbox"
    ;;
  *)
    echo "Unsupported updater test channel: $CHANNEL" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Source app does not exist: $SOURCE_APP" >&2
  exit 1
fi
if [[ ! -f "$UPDATE_DMG" ]]; then
  echo "Update DMG does not exist: $UPDATE_DMG" >&2
  exit 1
fi
if [[ ! -f "$TEST_FILE" ]]; then
  echo "Compiled updater test is missing: $TEST_FILE" >&2
  echo "Run the Backboard extension compile/typecheck workflow first." >&2
  exit 1
fi
if [[ -n "$INSTALLER_MODULE" && ! -f "$INSTALLER_MODULE" ]]; then
  echo "Updater installer module does not exist: $INSTALLER_MODULE" >&2
  exit 1
fi

ACTUAL_SOURCE_BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)"
if [[ "$ACTUAL_SOURCE_BUNDLE" != "$BUNDLE_IDENTIFIER" ]]; then
  echo "Source app bundle mismatch: expected $BUNDLE_IDENTIFIER, got $ACTUAL_SOURCE_BUNDLE" >&2
  exit 1
fi

SOURCE_IDENTITY_BEFORE="$(/usr/bin/stat -f '%d:%i:%m' "$SOURCE_APP")"
TEST_ROOT="$(/usr/bin/mktemp -d "/tmp/backboard-updater-lab.$CHANNEL.XXXXXX")"

cleanup() {
  if [[ "$TEST_ROOT" == /tmp/backboard-updater-lab.* && -d "$TEST_ROOT" ]]; then
    /usr/bin/find "$TEST_ROOT" -depth -delete
  fi
}
trap cleanup EXIT

echo "Updater test lab: $TEST_ROOT"
echo "Channel: $CHANNEL ($BUNDLE_IDENTIFIER)"
echo "Source app is read-only test input: $SOURCE_APP"
echo "All installation and relaunch work occurs in a disposable clone."
if [[ -n "$INSTALLER_MODULE" ]]; then
  echo "Installer compatibility module: $INSTALLER_MODULE"
fi

if [[ -x /usr/bin/caffeinate ]]; then
  TEST_RUNNER=(/usr/bin/caffeinate -dims /usr/bin/env node --test "$TEST_FILE")
else
  TEST_RUNNER=(/usr/bin/env node --test "$TEST_FILE")
fi

BACKBOARD_UPDATER_E2E_SOURCE_APP="$SOURCE_APP" \
BACKBOARD_UPDATER_E2E_DMG="$UPDATE_DMG" \
BACKBOARD_UPDATER_E2E_VERSION="$EXPECTED_VERSION" \
BACKBOARD_UPDATER_E2E_APP_NAME="$APP_NAME" \
BACKBOARD_UPDATER_E2E_BUNDLE_ID="$BUNDLE_IDENTIFIER" \
BACKBOARD_UPDATER_E2E_ROOT="$TEST_ROOT" \
BACKBOARD_UPDATER_E2E_INSTALLER_MODULE="$INSTALLER_MODULE" \
"${TEST_RUNNER[@]}"

SOURCE_IDENTITY_AFTER="$(/usr/bin/stat -f '%d:%i:%m' "$SOURCE_APP")"
if [[ "$SOURCE_IDENTITY_AFTER" != "$SOURCE_IDENTITY_BEFORE" ]]; then
  echo "Source app identity changed during the disposable test." >&2
  exit 1
fi

echo "Updater E2E passed; source app remained unchanged."
