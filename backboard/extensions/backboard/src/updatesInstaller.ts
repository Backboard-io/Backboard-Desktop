/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Options for generating the macOS updater installer script.
 */
export interface MacUpdateInstallerOptions {
	/**
	 * Skip the Gatekeeper (`spctl --assess`) check while keeping `codesign`
	 * verification. Production callers must not set this; it exists so test
	 * harnesses can run the full installer locally with ad-hoc signed stub
	 * bundles, which Gatekeeper always rejects because they are not notarized.
	 * Defaults to false (full validation) when omitted.
	 */
	skipGatekeeperAssessment?: boolean;
	/**
	 * Skip the best-effort post-launch foreground activation check. Test
	 * harnesses set this so `osascript` cannot stall on TCC automation
	 * consent dialogs for bundles that have no real windows. Defaults to
	 * false (full activation behavior) when omitted.
	 */
	skipForegroundActivation?: boolean;
}

export function macUpdateInstallerScript(options: MacUpdateInstallerOptions = {}): string {
	const gatekeeperAssess = options.skipGatekeeperAssessment
		? '# Gatekeeper assessment skipped (test harness): bundle is ad-hoc signed, not notarized'
		: '/usr/sbin/spctl --assess --type execute "$target_app"';
	const foregroundActivationGuard = options.skipForegroundActivation
		? '  echo "Skipping foreground activation check (test harness)"\n  return 0\n'
		: '';
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
  ${gatekeeperAssess}
}

signing_team() {
  { /usr/bin/codesign -dv "$1" 2>&1 || true; } | /usr/bin/awk -F= '/^TeamIdentifier=/ { print $2; exit }'
}

# macOS keys users' privacy grants (folder access, Accessibility, Screen
# Recording, Automation) on bundle id + signing team. An update signed by any
# other team would silently re-raise every permission prompt, so refuse it.
require_same_signing_team() {
  local staged_app="$1"
  local current_app="$2"
  local current_team
  local staged_team

  current_team="$(signing_team "$current_app")"
  if [[ -z "$current_team" || "$current_team" == "not set" ]]; then
    return 0
  fi
  staged_team="$(signing_team "$staged_app")"
  if [[ "$staged_team" != "$current_team" ]]; then
    echo "Refusing update signed by team \${staged_team:-none}; the installed app is signed by $current_team"
    return 1
  fi
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
  local backup_owner_id="\${6:-}"
  local backup_group_id="\${7:-}"

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

  # The backup lives in the caller-owned update directory so it can remain
  # available through the post-launch stability check without requiring a
  # second administrator prompt to remove it. If ownership cannot be fixed,
  # restore the previous app immediately while this operation is privileged.
  if [[ -n "$backup_owner_id" && -n "$backup_group_id" ]]; then
    if ! /usr/sbin/chown -R "$backup_owner_id:$backup_group_id" "$backup_app"; then
      /bin/mv "$app_path" "$staged_app" || true
      /bin/mv "$backup_app" "$app_path" || true
      return 1
    fi
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

  # Browser-installed apps can carry Finder/quarantine metadata on nested
  # signed files. The metadata is not part of the code signature, but codesign
  # rejects the restored bundle until it is removed.
  /usr/bin/xattr -cr "$app_path" >/dev/null 2>&1 || true
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
ISOLATED_TEST_USER_DATA_DIR="\${9:-}"
UPDATE_LOCK_DIR="\${10:-}"
INSTALLER_PATH="$0"
APP_PARENT="$(/usr/bin/dirname "$APP_PATH")"
UPDATE_WORK_DIR="$(/usr/bin/dirname "$INSTALLER_PATH")"
SAFE_VERSION="\${VERSION//[^a-zA-Z0-9._-]/_}"
INSTALL_TOKEN="$SAFE_VERSION.$$.\${RANDOM}"
STAGED_APP="$UPDATE_WORK_DIR/.$APP_NAME.update-$INSTALL_TOKEN"
BACKUP_APP="$UPDATE_WORK_DIR/.$APP_NAME.backup-$INSTALL_TOKEN"
FAILED_APP="$UPDATE_WORK_DIR/.$APP_NAME.failed-$INSTALL_TOKEN"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/backboard-studio-update-mount.XXXXXX)"
STATUS_STATE="starting"

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Preparing Backboard Studio $VERSION"

# The extension host injects process-local VS Code IPC state into its children.
# None of it is valid after the current app exits, and carrying a stale main IPC
# socket or parent PID into the replacement can make Electron treat the verified
# app as a secondary invocation and exit during the updater health check.
unset \
  VSCODE_CRASH_REPORTER_PROCESS_TYPE \
  VSCODE_CWD \
  VSCODE_ESM_ENTRYPOINT \
  VSCODE_HANDLES_UNCAUGHT_ERRORS \
  VSCODE_IPC_HOOK \
  VSCODE_NLS_CONFIG \
  VSCODE_PID \
  VSCODE_WILL_SEND_MESSAGE_PORT \
  ELECTRON_RUN_AS_NODE || true

write_status() {
  STATUS_STATE="$1"
  /usr/bin/printf '%s\n' "$STATUS_STATE" > "$STATUS_PATH"
}

app_running_pid() {
  local target_app="$1"
  local executable
  local expected_command
  local real_target_app
  local real_expected_command
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$executable" ]]; then
    return 1
  fi
  expected_command="$target_app/Contents/MacOS/$executable"
  real_target_app="$(cd "$target_app" 2>/dev/null && /bin/pwd -P || true)"
  real_expected_command="$real_target_app/Contents/MacOS/$executable"
  /bin/ps -axo pid=,command= | /usr/bin/awk -v expected="$expected_command" -v real_expected="$real_expected_command" '
    {
      pid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
      if (!found && ($0 == expected || index($0, expected " ") == 1 || $0 == real_expected || index($0, real_expected " ") == 1)) {
        print pid
        found = 1
      }
    }
  '
}

app_running() {
  [[ -n "$(app_running_pid "$1" || true)" ]]
}

pid_is_exact_app_process() {
  local target_app="$1"
  local expected_pid="$2"
  local executable
  local expected_command
  local real_target_app
  local real_expected_command
  local actual_command
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$executable" ]]; then
    return 1
  fi
  expected_command="$target_app/Contents/MacOS/$executable"
  real_target_app="$(cd "$target_app" 2>/dev/null && /bin/pwd -P || true)"
  real_expected_command="$real_target_app/Contents/MacOS/$executable"
  actual_command="$(/bin/ps -p "$expected_pid" -o command= 2>/dev/null || true)"
  [[ "$actual_command" == "$expected_command" || "$actual_command" == "$expected_command "* || "$actual_command" == "$real_expected_command" || "$actual_command" == "$real_expected_command "* ]]
}

app_version_matches() {
  local target_app="$1"
  local expected_version="$2"
  local actual_version
  actual_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$actual_version" == "$expected_version" ]]
}

electron_runtime_ready() {
  local target_app="$1"
  local real_target_app
  real_target_app="$(cd "$target_app" 2>/dev/null && /bin/pwd -P || true)"
  if [[ -z "$real_target_app" ]]; then
    return 1
  fi
  /bin/ps -axo command= | /usr/bin/awk \
    -v framework_prefix="$target_app/Contents/Frameworks/" \
    -v real_framework_prefix="$real_target_app/Contents/Frameworks/" '
    {
      command = $0
      sub(/^[[:space:]]+/, "", command)
    }
    index(command, framework_prefix) == 1 || index(command, real_framework_prefix) == 1 {
      found = 1
    }
    END { exit found ? 0 : 1 }
  '
}

wait_for_electron_runtime() {
  local target_app="$1"
  local expected_pid="$2"
  local checks="\${3:-240}"
  local check

  # Release builds can run a compatibility bootstrap before exec'ing Electron.
  # The bootstrap deliberately preserves the final argv[0] and PID, so process
  # identity alone cannot distinguish it from the real IDE. Bundle-scoped
  # Electron helper processes appear only after that handoff is complete.
  for ((check = 1; check <= checks; check++)); do
    if ! pid_is_exact_app_process "$target_app" "$expected_pid"; then
      echo "Updated app pid $expected_pid exited before the Electron runtime became ready ($check/$checks)."
      return 1
    fi
    if electron_runtime_ready "$target_app"; then
      echo "Confirmed Electron runtime ready: $target_app (pid $expected_pid, check $check/$checks)"
      return 0
    fi
    /bin/sleep 0.25
  done

  echo "Electron runtime did not become ready for $target_app (pid $expected_pid)."
  return 1
}

wait_for_current_app_exit() {
  local target_app="$1"
  local current_pid="$2"
  local bundle_identifier="$3"

  # The PID supplied by the extension is its extension host. Wait for it and
  # the main application process to exit. Helper and crash-reporting processes
  # can linger after a clean quit and must never be treated as permission to
  # terminate the entire app bundle.
  for _ in {1..120}; do
    if ! /bin/ps -p "$current_pid" >/dev/null 2>&1 && ! app_running "$target_app"; then
      echo "Confirmed current Backboard Studio processes exited cleanly."
      return 0
    fi
    /bin/sleep 0.5
  done

  echo "Backboard Studio is still running; requesting a graceful quit."
  /usr/bin/osascript -e "tell application id \"$bundle_identifier\" to quit" >/dev/null 2>&1 || true
  for _ in {1..120}; do
    if ! /bin/ps -p "$current_pid" >/dev/null 2>&1 && ! app_running "$target_app"; then
      echo "Confirmed current Backboard Studio processes exited after quit request."
      return 0
    fi
    /bin/sleep 0.5
  done

  echo "Backboard Studio did not quit cleanly; canceling the update and leaving the installed app unchanged."
  return 1
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
  local isolated_user_data_dir="\${3:-}"
  local launch_mode="\${4:-launchservices}"
  local executable
  local attempt
  local launched_pid

  LAUNCHED_PID=""

  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$executable" || ! -x "$target_app/Contents/MacOS/$executable" ]]; then
    return 1
  fi

  for attempt in {1..3}; do
    if [[ "$launch_mode" == "direct" ]]; then
      if [[ -n "$isolated_user_data_dir" ]]; then
        /bin/mkdir -p "$isolated_user_data_dir/extensions"
        /usr/bin/nohup "$target_app/Contents/MacOS/$executable" --user-data-dir "$isolated_user_data_dir" --extensions-dir "$isolated_user_data_dir/extensions" --new-window >>"$LOG_PATH" 2>&1 &
      else
        /usr/bin/nohup "$target_app/Contents/MacOS/$executable" --new-window >>"$LOG_PATH" 2>&1 &
      fi
    elif [[ -n "$isolated_user_data_dir" ]]; then
      /bin/mkdir -p "$isolated_user_data_dir/extensions"
      /usr/bin/open -n "$target_app" --args --user-data-dir "$isolated_user_data_dir" --extensions-dir "$isolated_user_data_dir/extensions" --new-window || true
    else
      # Force LaunchServices to start this exact newly swapped app. Plain open
      # can reuse a stale registration for the previous app when the
      # bundle identifier is unchanged but the Developer ID certificate has
      # changed, causing the replacement process to exit immediately.
      /usr/bin/open -n "$target_app" --args --new-window || true
    fi
    for _ in {1..20}; do
      launched_pid="$(app_running_pid "$target_app" || true)"
      if [[ -n "$launched_pid" ]]; then
        LAUNCHED_PID="$launched_pid"
        echo "Confirmed exact app process running: $target_app (pid $LAUNCHED_PID, mode $launch_mode, attempt $attempt)"
        return 0
      fi
      /bin/sleep 0.25
    done
  done

  return 1
}

confirm_app_stable() {
  local target_app="$1"
  local expected_version="$2"
  local expected_pid="$3"
  local checks="\${4:-30}"
  local check

  # Seeing the process once is not enough to call an update successful. Keep
  # the rollback copy until the new app has survived its initial cold-start
  # window; native-loader and early utility-process failures surface here.
  for ((check = 1; check <= checks; check++)); do
    /bin/sleep 0.5
    if ! app_version_matches "$target_app" "$expected_version"; then
      echo "Installed app version changed during post-launch stability check ($check/$checks)."
      return 1
    fi
    if ! pid_is_exact_app_process "$target_app" "$expected_pid"; then
      echo "Updated app pid $expected_pid exited or no longer belongs to the installed bundle during post-launch stability check ($check/$checks)."
      return 1
    fi
  done

  echo "Confirmed stable after launch: version $expected_version at $target_app (pid $expected_pid)"
  return 0
}

activate_app() {
  local target_app="$1"
  local expected_pid="$2"
  local attempt
  local activation_state

  for attempt in {1..12}; do
    if ! pid_is_exact_app_process "$target_app" "$expected_pid"; then
      echo "Updated app pid $expected_pid exited before it could be activated."
      return 1
    fi

    activation_state="$(/usr/bin/osascript -l JavaScript - "$expected_pid" <<'JXA' 2>/dev/null || true
ObjC.import('AppKit');
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (app.isNil()) {
    return 'missing';
  }
  app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps);
  delay(0.25);
  return app.active && !app.hidden ? 'active' : 'inactive';
}
JXA
)"
    if [[ "$activation_state" == "active" ]]; then
      echo "Confirmed active after verified launch: $target_app (pid $expected_pid, attempt $attempt)"
      return 0
    fi
    /bin/sleep 0.25
  done

  echo "Updated app remained healthy but macOS did not bring it to the foreground."
  return 1
}

ensure_app_visible() {
${foregroundActivationGuard}  local target_app="$1"
  local expected_pid="$2"
  local isolated_user_data_dir="\${3:-}"
  local visible_pid
  local attempt

  if activate_app "$target_app" "$expected_pid"; then
    return 0
  fi

  # A running Electron process can still have no visible window after an
  # updater-driven LaunchServices handoff. Ask LaunchServices to reopen the
  # already-running app. Do not use -n here: that would start a competing
  # instance instead of delivering the reopen request to the verified process.
  echo "Requesting a visible IDE window from the verified updated app."
  if [[ -n "$isolated_user_data_dir" ]]; then
    /bin/mkdir -p "$isolated_user_data_dir/extensions"
    /usr/bin/open "$target_app" --args --user-data-dir "$isolated_user_data_dir" --extensions-dir "$isolated_user_data_dir/extensions" --new-window >/dev/null 2>&1 || true
  else
    /usr/bin/open "$target_app" --args --new-window >/dev/null 2>&1 || true
  fi

  for attempt in {1..20}; do
    /bin/sleep 0.5
    visible_pid="$(app_running_pid "$target_app" || true)"
    if [[ -z "$visible_pid" ]] || ! electron_runtime_ready "$target_app"; then
      continue
    fi
    if activate_app "$target_app" "$visible_pid"; then
      LAUNCHED_PID="$visible_pid"
      echo "Confirmed visible IDE window after verified launch: $target_app (pid $visible_pid, attempt $attempt)"
      return 0
    fi
  done

  echo "Updated app could not open a visible IDE window."
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
  do shell script (item 1 of argv) with administrator privileges with prompt "Backboard Studio needs permission to install this verified update."
end run
APPLESCRIPT
}

cleanup() {
  local detach_attempt
  if [[ -z "\${BACKBOARD_UPDATER_TEST_SOURCE_APP:-}" ]]; then
    for detach_attempt in {1..5}; do
      if /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1; then
        break
      fi
      /bin/sleep 0.25
    done
    /bin/rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
  if [[ -e "$STAGED_APP" ]]; then
    /bin/rm -rf "$STAGED_APP" >/dev/null 2>&1 || true
  fi
  if [[ -n "$UPDATE_LOCK_DIR" ]]; then
    local lock_parent
    local log_parent
    local lock_name
    lock_parent="$(/usr/bin/dirname "$UPDATE_LOCK_DIR")"
    log_parent="$(/usr/bin/dirname "$LOG_PATH")"
    lock_name="$(/usr/bin/basename "$UPDATE_LOCK_DIR")"
    if [[ "$lock_parent" == "$log_parent" && "$lock_name" == backboard-studio-*-update.lock ]]; then
      /bin/rm -rf "$UPDATE_LOCK_DIR" >/dev/null 2>&1 || true
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
      /usr/bin/open -n "$APP_PATH" || true
    fi
  fi
  exit "$exit_code"
}
trap handle_exit EXIT

# Test-harness-only seam: instead of mounting a DMG, validate an already staged
# app bundle directory. Production installers never set this variable.
SOURCE_APP="$MOUNT_POINT/$APP_NAME"
if [[ -n "\${BACKBOARD_UPDATER_TEST_SOURCE_APP:-}" ]]; then
  SOURCE_APP="$BACKBOARD_UPDATER_TEST_SOURCE_APP"
else
  /usr/bin/hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet
  SOURCE_APP="$MOUNT_POINT/$APP_NAME"
fi
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Mounted DMG did not contain $APP_NAME"
  exit 1
fi

CALLER_OWNER_ID="$(/usr/bin/id -u)"
CALLER_GROUP_ID="$(/usr/bin/id -g)"
NEEDS_ELEVATION=0
prepare_staged_app "$SOURCE_APP" "$STAGED_APP" "$BUNDLE_IDENTIFIER" "$VERSION"
require_same_signing_team "$STAGED_APP" "$APP_PATH"
if [[ ! -w "$APP_PARENT" ]]; then
  NEEDS_ELEVATION=1
fi

echo "Prepared and verified Backboard Studio $VERSION at $STAGED_APP"
write_status "ready"

if ! wait_for_current_app_exit "$APP_PATH" "$CURRENT_PID" "$BUNDLE_IDENTIFIER"; then
  exit 1
fi

if [[ "$NEEDS_ELEVATION" == "0" ]]; then
  swap_staged_app "$APP_PATH" "$STAGED_APP" "$BACKUP_APP" "$BUNDLE_IDENTIFIER" "$VERSION"
else
  run_elevated swap "$APP_PATH" "$STAGED_APP" "$BACKUP_APP" "$BUNDLE_IDENTIFIER" "$VERSION" "$CALLER_OWNER_ID" "$CALLER_GROUP_ID"
fi

register_app "$APP_PATH"
UPDATE_CONFIRMED=0
if launch_app "$APP_PATH" "$BUNDLE_IDENTIFIER" "$ISOLATED_TEST_USER_DATA_DIR" launchservices; then
  if wait_for_electron_runtime "$APP_PATH" "$LAUNCHED_PID" 240 && confirm_app_stable "$APP_PATH" "$VERSION" "$LAUNCHED_PID" 30; then
    UPDATE_CONFIRMED=1
  fi
fi
if [[ "$UPDATE_CONFIRMED" == "0" ]] && ! app_running "$APP_PATH"; then
  echo "LaunchServices relaunch did not remain healthy; retrying the exact executable directly."
  if launch_app "$APP_PATH" "$BUNDLE_IDENTIFIER" "$ISOLATED_TEST_USER_DATA_DIR" direct; then
    if wait_for_electron_runtime "$APP_PATH" "$LAUNCHED_PID" 240 && confirm_app_stable "$APP_PATH" "$VERSION" "$LAUNCHED_PID" 30; then
      UPDATE_CONFIRMED=1
    fi
  fi
fi
if [[ "$UPDATE_CONFIRMED" == "0" ]]; then
  echo "Updated app did not launch successfully or remain stable; restoring the previous version."
  if [[ "$NEEDS_ELEVATION" == "0" ]]; then
    rollback_app "$APP_PATH" "$BACKUP_APP" "$FAILED_APP" "$BUNDLE_IDENTIFIER"
  else
    run_elevated rollback "$APP_PATH" "$BACKUP_APP" "$FAILED_APP" "$BUNDLE_IDENTIFIER"
  fi
  register_app "$APP_PATH"
  launch_app "$APP_PATH" "$BUNDLE_IDENTIFIER" "$ISOLATED_TEST_USER_DATA_DIR" launchservices || true
  exit 1
fi

# Foreground activation is best-effort after the new app has passed runtime and
# stability verification. macOS can deny or delay activation when the updater
# was launched from a background process; that is not an installation failure
# and must never roll back an otherwise healthy update.
if ! ensure_app_visible "$APP_PATH" "$LAUNCHED_PID" "$ISOLATED_TEST_USER_DATA_DIR"; then
  echo "Updated app is installed and healthy, but macOS did not confirm a foreground window; keeping the verified update installed."
fi

remove_backup_app "$BACKUP_APP"

echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installed and launched Backboard Studio $VERSION"
write_status "installed"
`;
}
