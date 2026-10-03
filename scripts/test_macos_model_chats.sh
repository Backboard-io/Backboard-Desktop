#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 SIGNED_DMG REPORT_JSON" >&2
  exit 1
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mount_dir="$(mktemp -d /tmp/backboard-model-chat.XXXXXX)"
test_dir="$(mktemp -d /tmp/backboard-model-chat-app.XXXXXX)"
cleanup() {
  hdiutil detach "${mount_dir}" -quiet 2>/dev/null || hdiutil detach "${mount_dir}" -force -quiet 2>/dev/null || true
  rmdir "${mount_dir}" 2>/dev/null || true
  rm -rf "${test_dir}"
}
trap cleanup EXIT
hdiutil attach "$1" -readonly -nobrowse -mountpoint "${mount_dir}" -quiet
apps=("${mount_dir}"/*.app)
if [[ ${#apps[@]} -ne 1 || ! -d "${apps[0]}" ]]; then
  echo "Expected exactly one app in release DMG" >&2
  exit 1
fi
# Run an installed copy, as the updater does. Running Bun directly from a
# compressed read-only DMG can stall startup and retain the mount on failure.
ditto --norsrc --noextattr --noacl --noqtn "${apps[0]}" "${test_dir}/Release.app"
cmp "${apps[0]}/Contents/Resources/app/extensions/backboard/bin/backboard-cli-ts" \
  "${test_dir}/Release.app/Contents/Resources/app/extensions/backboard/bin/backboard-cli-ts"
hdiutil detach "${mount_dir}" -quiet
python3 "${repo_root}/scripts/test_model_chats.py" --app "${test_dir}/Release.app" --report "$2"
python3 "${repo_root}/scripts/test_model_chats.py" --app "${test_dir}/Release.app" \
  --claude-subscription --report "${2%.json}-claude-subscription.json"
