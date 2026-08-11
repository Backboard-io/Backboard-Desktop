/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function macUpdateInstallerScript(): string {
	return `#!/bin/zsh
set -euo pipefail

validate_app() {
  local target_app="$1"
  local expected_bundle_identifier="$2"
  local expected_version="\${3:-}"
  local info_plist="$target_app/Contents/Info.plist"
  local executable
  local actual_bundle_identifier
  local actual_version

  if [[ ! -f "$info_plist" ]]; then
    echo "Invalid app bundle: missing Contents/Info.plist in $target_app"
    return 1
  fi

  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null || true)"
  if [[ -z "$executable" || ! -x "$target_app/Contents/MacOS/$executable" ]]; then
    echo "Invalid app bundle: missing executable in $target_app"
    return 1
  fi

  actual_bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist" 2>/dev/null || true)"
  if [[ "$actual_bundle_identifier" != "$expected_bundle_identifier" ]]; then
    echo "Invalid app bundle identifier: expected $expected_bundle_identifier, got $actual_bundle_identifier"
    return 1
  fi

  if [[ -n "$expected_version" ]]; then
    actual_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist" 2>/dev/null || true)"
    if [[ "$actual_version" != "$expected_version" ]]; then
      echo "Invalid app version: expected $expected_version, got $actual_version"
      return 1
    fi
  fi

  /usr/bin/codesign --verify --deep --strict "$target_app"
  /usr/sbin/spctl --assess --type execute "$target_app"
}

prepare_staged_app() {
  local source_app="$1"
  local staged_app="$2"
  local expected_bundle_identifier="$3"
  local expected_version="$4"
  local owner_id="\${5:-}"
  local group_id="\${6:-}"

  if [[ -e "$staged_app" ]]; then
    echo "Refusing to overwrite existing staging path: $staged_app"
    return 1
  fi

  /usr/bin/ditto --norsrc --noextattr --noacl --noqtn "$source_app" "$staged_app"
  /bin/chmod -R u+rwX,go+rX "$staged_app" >/dev/null 2>&1 || true
  /usr/bin/xattr -cr "$staged_app" >/dev/null 2>&1 || true
  if [[ -n "$owner_id" && -n "$group_id" ]]; then
    /usr/sbin/chown -R "$owner_id:$group_id" "$staged_app"
  fi
  validate_app "$staged_app" "$expected_bundle_identifier" "$expected_version"
}

swap_staged_app() {
  local app_path="$1"
  local staged_app="$2"
  local backup_app="$3"
  local expected_bundle_identifier="$4"
  local expected_version="$5"

  validate_app "$staged_app" "$expected_bundle_identifier" "$expected_version"
  if [[ ! -d "$app_path" ]]; then
    echo "Current app is missing before replacement: $app_path"
    return 1
  fi
  if [[ -e "$backup_app" ]]; then
    echo "Refusing to overwrite existing backup path: $backup_app"
    return 1
  fi

  /bin/mv "$app_path" "$backup_app"
  if ! /bin/mv "$staged_app" "$app_path"; then
    /bin/mv "$backup_app" "$app_path" || true
    return 1
  fi

  if ! validate_app "$app_path" "$expected_bundle_identifier" "$expected_version"; then
    /bin/mv "$app_path" "$staged_app" || true
    /bin/mv "$backup_app" "$app_path" || true
    return 1
  fi
}

rollback_app() {
  local app_path="$1"
  local backup_app="$2"
  local failed_app="$3"
  local expected_bundle_identifier="$4"

  if [[ ! -d "$backup_app" ]]; then
    echo "Rollback copy is missing: $backup_app"
    return 1
  fi
  if [[ -e "$failed_app" ]]; then
    echo "Refusing to overwrite existing failed-update path: $failed_app"
    return 1
  fi

  if [[ -e "$app_path" ]]; then
    /bin/mv "$app_path" "$failed_app"
  fi
  if ! /bin/mv "$backup_app" "$app_path"; then
    if [[ -e "$failed_app" ]]; then
      /bin/mv "$failed_app" "$app_path" || true
    fi
    return 1
  fi

  validate_app "$app_path" "$expected_bundle_identifier" ""
  /bin/rm -rf "$failed_app"
}

remove_backup_app() {
  local backup_app="$1"
  /bin/rm -rf "$backup_app"
}

if [[ "\${1:-}" == "--elevated" ]]; then
  operation="$2"
  shift 2
  case "$operation" in
    prepare)
      prepare_staged_app "$@"
      ;;
    swap)
      swap_staged_app "$@"
      ;;
    rollback)
      rollback_app "$@"
      ;;
    remove-backup)
      remove_backup_app "$@"
      ;;
    *)
      echo "Unknown elevated updater operation: $operation"
      exit 2
      ;;
  esac
  exit 0
fi

DMG_PATH="$1"
APP_PATH="$2"
CURRENT_PID="$3"
VERSION="$4"
LOG_PATH="$5"
APP_NAME="\${6:-Backboard Studio.app}"
BUNDLE_IDENTIFIER="\${7:-io.backboard.studio}"
STATUS_PATH="$8"
INSTALLER_PATH="$0"
APP_PARENT="$(/usr/bin/dirname "$APP_PATH")"
SAFE_VERSION="\${VERSION//[^a-zA-Z0-9._-]/_}"
INSTALL_TOKEN="$SAFE_VERSION.$$.\${RANDOM}"
STAGED_APP="$APP_PARENT/.$APP_NAME.update-$INSTALL_TOKEN"
BACKUP_APP="$APP_PARENT/.$APP_NAME.backup-$INSTALL_TOKEN"
FAILED_APP="$APP_PARENT/.$APP_NAME.failed-$INSTALL_TOKEN"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/backboard-studio-update-mount.XXXXXX)"
STATUS_STATE="starting"

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Preparing Backboard Studio $VERSION"

write_status() {
  STATUS_STATE="$1"
  /usr/bin/printf '%s\n' "$STATUS_STATE" > "$STATUS_PATH"
}

app_running() {
  local target_app="$1"
  local executable
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  [[ -n "$executable" ]] && /usr/bin/pgrep -f "$target_app/Contents/MacOS/$executable" >/dev/null 2>&1
}

register_app() {
  local target_app="$1"
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [[ -x "$lsregister" ]]; then
    "$lsregister" -f "$target_app" >/dev/null 2>&1 || true
  fi
}

launch_app() {
  local target_app="$1"
  local bundle_identifier="$2"
  local executable
  local attempt

  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$executable" || ! -x "$target_app/Contents/MacOS/$executable" ]]; then
    return 1
  fi

  for attempt in {1..10}; do
    /usr/bin/open "$target_app" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if app_running "$target_app"; then
        for _ in {1..20}; do
          if /usr/bin/osascript -e "tell application id \"$bundle_identifier\" to activate" >/dev/null 2>&1; then
            break
          fi
          /bin/sleep 0.25
        done
        echo "Confirmed running and activated: $target_app (attempt $attempt)"
        return 0
      fi
      /bin/sleep 0.25
    done
  done

  /usr/bin/nohup "$target_app/Contents/MacOS/$executable" >/dev/null 2>&1 &
  for _ in {1..40}; do
    if app_running "$target_app"; then
      /usr/bin/osascript -e "tell application id \"$bundle_identifier\" to activate" >/dev/null 2>&1 || true
      echo "Confirmed running after direct launch: $target_app"
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

run_elevated() {
  local operation="$1"
  shift
  local command=""
  local argument
  for argument in /bin/zsh "$INSTALLER_PATH" --elevated "$operation" "$@"; do
    command="$command \${(q)argument}"
  done
  /usr/bin/osascript - "$command" <<'APPLESCRIPT'
on run argv
  do shell script (item 1 of argv) with administrator privileges
end run
APPLESCRIPT
}

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  /bin/rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
  if [[ -e "$STAGED_APP" ]]; then
    if [[ -w "$APP_PARENT" || -w "$STAGED_APP" ]]; then
      /bin/rm -rf "$STAGED_APP" >/dev/null 2>&1 || true
    else
      run_elevated remove-backup "$STAGED_APP" >/dev/null 2>&1 || true
    fi
  fi
}

handle_exit() {
  local exit_code=$?
  trap - EXIT
  cleanup
  if [[ "$exit_code" != "0" ]]; then
    echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Update failed for Backboard Studio $VERSION"
    write_status "failed"
    if [[ -d "$APP_PATH" ]] && ! app_running "$APP_PATH"; then
      register_app "$APP_PATH"
      /usr/bin/open "$APP_PATH" >/dev/null 2>&1 || true
    fi
  fi
  exit "$exit_code"
}
trap handle_exit EXIT

/usr/bin/hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet
SOURCE_APP="$MOUNT_POINT/$APP_NAME"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Mounted DMG did not contain $APP_NAME"
  exit 1
fi

APP_OWNER_ID="$(/usr/bin/stat -f '%u' "$APP_PATH")"
APP_GROUP_ID="$(/usr/bin/stat -f '%g' "$APP_PATH")"
NEEDS_ELEVATION=0
if [[ -w "$APP_PARENT" ]]; then
  prepare_staged_app "$SOURCE_APP" "$STAGED_APP" "$BUNDLE_IDENTIFIER" "$VERSION"
else
  NEEDS_ELEVATION=1
  run_elevated prepare "$SOURCE_APP" "$STAGED_APP" "$BUNDLE_IDENTIFIER" "$VERSION" "$APP_OWNER_ID" "$APP_GROUP_ID"
fi

echo "Prepared and verified Backboard Studio $VERSION at $STAGED_APP"
write_status "ready"

for _ in {1..120}; do
  if ! /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done
if /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
  /usr/bin/pkill -f "$APP_PATH/Contents/" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
      break
    fi
    /bin/sleep 0.5
  done
fi
if /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
  echo "Current Backboard Studio process did not exit; leaving the installed app unchanged."
  exit 1
fi

if [[ "$NEEDS_ELEVATION" == "0" ]]; then
  swap_staged_app "$APP_PATH" "$STAGED_APP" "$BACKUP_APP" "$BUNDLE_IDENTIFIER" "$VERSION"
else
  run_elevated swap "$APP_PATH" "$STAGED_APP" "$BACKUP_APP" "$BUNDLE_IDENTIFIER" "$VERSION"
fi

register_app "$APP_PATH"
if ! launch_app "$APP_PATH" "$BUNDLE_IDENTIFIER"; then
  echo "Updated app did not launch; restoring the previous version."
  if [[ "$NEEDS_ELEVATION" == "0" ]]; then
    rollback_app "$APP_PATH" "$BACKUP_APP" "$FAILED_APP" "$BUNDLE_IDENTIFIER"
  else
    run_elevated rollback "$APP_PATH" "$BACKUP_APP" "$FAILED_APP" "$BUNDLE_IDENTIFIER"
  fi
  register_app "$APP_PATH"
  launch_app "$APP_PATH" "$BUNDLE_IDENTIFIER" || true
  exit 1
fi

if [[ "$NEEDS_ELEVATION" == "0" ]]; then
  remove_backup_app "$BACKUP_APP"
else
  run_elevated remove-backup "$BACKUP_APP"
fi

echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installed and launched Backboard Studio $VERSION"
write_status "installed"
`;
}
