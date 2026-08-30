/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { macUpdateInstallerScript } from '../updatesInstaller';

describe('macUpdateInstallerScript', () => {
	test('validates a staged app before moving the current app', () => {
		const script = macUpdateInstallerScript();
		const prepareIndex = script.indexOf('prepare_staged_app "$SOURCE_APP"');
		const readyIndex = script.indexOf('write_status "ready"');
		const shutdownIndex = script.indexOf('wait_for_current_app_exit "$APP_PATH"');
		const swapIndex = script.indexOf('swap_staged_app "$APP_PATH"');

		assert.ok(prepareIndex >= 0);
		assert.ok(readyIndex > prepareIndex);
		assert.ok(shutdownIndex > readyIndex);
		assert.ok(swapIndex > shutdownIndex);
		assert.match(script, /codesign --verify --deep --strict/);
		assert.match(script, /spctl --assess --type execute/);
		assert.doesNotMatch(script, /rm -rf "\$APP_PATH"/);
	});

	test('waits for a clean app exit and never force-terminates the IDE', () => {
		const script = macUpdateInstallerScript();

		assert.match(script, /app_running\(\)/);
		assert.match(script, /ps -axo pid=,command=/);
		assert.match(script, /awk -v expected="\$expected_command" -v real_expected="\$real_expected_command"/);
		assert.match(script, /requesting a graceful quit/);
		assert.match(script, /tell application id/);
		assert.match(script, /did not quit cleanly; canceling the update/);
		assert.doesNotMatch(script, /app_bundle_running/);
		assert.doesNotMatch(script, /\/usr\/bin\/pkill/);
		assert.doesNotMatch(script, /stopping remaining app processes/);
		assert.match(script, /for detach_attempt in \{1\.\.5\}/);
	});

	test('stages outside Applications and uses one administrator prompt on the successful path', () => {
		const script = macUpdateInstallerScript();

		assert.match(script, /UPDATE_WORK_DIR="\$\(\/usr\/bin\/dirname "\$INSTALLER_PATH"\)"/);
		assert.match(script, /STAGED_APP="\$UPDATE_WORK_DIR\//);
		assert.match(script, /prepare_staged_app "\$SOURCE_APP" "\$STAGED_APP"/);
		assert.match(script, /run_elevated swap "\$APP_PATH"/);
		assert.doesNotMatch(script, /run_elevated prepare "\$SOURCE_APP"/);
		assert.doesNotMatch(script, /run_elevated remove-backup "\$BACKUP_APP"/);
		assert.match(script, /with prompt "Backboard Studio needs permission to install this verified update\."/);
	});

	test('keeps a rollback copy until the updated app is confirmed running', () => {
		const script = macUpdateInstallerScript();
		const swapIndex = script.indexOf('swap_staged_app "$APP_PATH"');
		const launchIndex = script.indexOf('if launch_app "$APP_PATH"');
		const runtimeReadyIndex = script.indexOf('if wait_for_electron_runtime "$APP_PATH"');
		const stabilityIndex = script.indexOf('confirm_app_stable "$APP_PATH"');
		const activationIndex = script.indexOf('if ! ensure_app_visible "$APP_PATH" "$LAUNCHED_PID"');
		const removeBackupIndex = script.lastIndexOf('remove_backup_app "$BACKUP_APP"');

		assert.ok(swapIndex >= 0);
		assert.ok(launchIndex > swapIndex);
		assert.ok(runtimeReadyIndex > launchIndex);
		assert.ok(stabilityIndex > launchIndex);
		assert.ok(stabilityIndex > runtimeReadyIndex);
		assert.ok(activationIndex > stabilityIndex);
		assert.ok(removeBackupIndex > stabilityIndex);
		assert.ok(removeBackupIndex > activationIndex);
		assert.match(script, /rollback_app "\$APP_PATH"/);
		assert.match(script, /Confirmed exact app process running/);
		assert.match(script, /Confirmed Electron runtime ready/);
		assert.match(script, /exited or no longer belongs to the installed bundle during post-launch stability check/);
		assert.match(script, /Confirmed stable after launch/);
		assert.match(script, /Confirmed active after verified launch/);
		assert.match(script, /Confirmed visible IDE window after verified launch/);
		assert.match(script, /keeping the verified update installed/);
		assert.doesNotMatch(script, /Updated app did not open visibly; restoring the previous version/);
		assert.match(script, /Installed and launched Backboard Studio/);
		assert.match(script, /xattr -cr "\$app_path"/);
		assert.doesNotMatch(script, /local status=/);
	});

	test('keeps Gatekeeper assessment by default and offers a codesign-only test variant', () => {
		const production = macUpdateInstallerScript();
		assert.match(production, /\/usr\/sbin\/spctl --assess --type execute "\$target_app"/);
		assert.match(production, /codesign --verify --deep --strict/);

		const harness = macUpdateInstallerScript({ skipGatekeeperAssessment: true });
		assert.match(harness, /codesign --verify --deep --strict/);
		assert.doesNotMatch(harness, /spctl --assess/);
	});

	test('waits for the real Electron runtime instead of trusting the bootstrap pid', () => {
		const script = macUpdateInstallerScript();
		const functionStart = script.indexOf('electron_runtime_ready() {');
		const functionEnd = script.indexOf('\n}\n\nwait_for_electron_runtime() {', functionStart);
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);
		const runtimeFunction = script.slice(functionStart, functionEnd + 2);

		assert.match(script, /electron_runtime_ready\(\)/);
		assert.match(script, /framework_prefix="\$real_target_app\/Contents\/Frameworks\/"/);
		assert.match(script, /wait_for_electron_runtime\(\)/);
		assert.match(script, /pid_is_exact_app_process "\$target_app" "\$expected_pid"/);
		assert.match(script, /Electron runtime did not become ready/);
		assert.doesNotMatch(runtimeFunction, /found = 1\n\s+exit/);
	});

	test('activates the exact verified process through AppKit', () => {
		const script = macUpdateInstallerScript();
		const functionStart = script.indexOf('activate_app() {');
		const functionEnd = script.indexOf('\n}\n\nensure_app_visible() {', functionStart);
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);
		const activationFunction = script.slice(functionStart, functionEnd + 2);

		assert.match(activationFunction, /pid_is_exact_app_process "\$target_app" "\$expected_pid"/);
		assert.match(activationFunction, /NSRunningApplication\.runningApplicationWithProcessIdentifier/);
		assert.match(activationFunction, /NSApplicationActivateAllWindows/);
		assert.match(activationFunction, /app\.active && !app\.hidden/);
	});

	test('forces LaunchServices to open the exact swapped app after a certificate change', () => {
		const script = macUpdateInstallerScript();
		const launchFunctionStart = script.indexOf('launch_app() {');
		const launchFunctionEnd = script.indexOf('\n}\n\nconfirm_app_stable() {', launchFunctionStart);
		assert.ok(launchFunctionStart >= 0);
		assert.ok(launchFunctionEnd > launchFunctionStart);
		const launchFunction = script.slice(launchFunctionStart, launchFunctionEnd + 2);

		assert.match(launchFunction, /\/usr\/bin\/open -n "\$target_app" --args --user-data-dir/);
		assert.match(launchFunction, /\/usr\/bin\/open -n "\$target_app" --args --new-window/);
		assert.match(launchFunction, /\/usr\/bin\/nohup "\$target_app\/Contents\/MacOS\/\$executable"/);
		assert.doesNotMatch(launchFunction, /\/usr\/bin\/open "\$target_app"/);
	});

	test('removes stale extension-host IPC state and preserves relaunch diagnostics', () => {
		const script = macUpdateInstallerScript();
		const launchFunctionStart = script.indexOf('launch_app() {');
		const launchFunctionEnd = script.indexOf('\n}\n\nconfirm_app_stable() {', launchFunctionStart);
		assert.ok(launchFunctionStart >= 0);
		assert.ok(launchFunctionEnd > launchFunctionStart);
		const launchFunction = script.slice(launchFunctionStart, launchFunctionEnd + 2);

		assert.match(script, /unset\s+[\s\S]*VSCODE_IPC_HOOK[\s\S]*VSCODE_PID[\s\S]*ELECTRON_RUN_AS_NODE \|\| true/);
		assert.match(script, /ELECTRON_RUN_AS_NODE \|\| true/);
		assert.match(launchFunction, />>"\$LOG_PATH" 2>&1 &/);
		assert.doesNotMatch(launchFunction, />\/dev\/null 2>&1/);
	});

	test('requests a visible IDE window without rolling back a healthy update', () => {
		const script = macUpdateInstallerScript();
		const functionStart = script.indexOf('ensure_app_visible() {');
		const functionEnd = script.indexOf('\n}\n\nrun_elevated() {', functionStart);
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);
		const visibilityFunction = script.slice(functionStart, functionEnd + 2);

		assert.match(visibilityFunction, /--new-window/);
		assert.match(visibilityFunction, /\/usr\/bin\/open "\$target_app" --args --user-data-dir/);
		assert.match(visibilityFunction, /\/usr\/bin\/open "\$target_app" --args --new-window/);
		assert.doesNotMatch(visibilityFunction, /\/usr\/bin\/open -n/);
		assert.match(visibilityFunction, /visible_pid="\$\(app_running_pid/);
		assert.match(visibilityFunction, /activate_app "\$target_app" "\$visible_pid"/);
		assert.match(script, /Updated app is installed and healthy, but macOS did not confirm a foreground window; keeping the verified update installed/);
		assert.doesNotMatch(script, /Updated app did not open visibly; restoring the previous version/);
		assert.match(script, /rollback_app "\$APP_PATH"/);
	});

	test('releases only the channel-scoped update lock next to the updater log', () => {
		const script = macUpdateInstallerScript();

		assert.match(script, /UPDATE_LOCK_DIR="\$\{10:-\}"/);
		assert.match(script, /"\$lock_parent" == "\$log_parent"/);
		assert.match(script, /"\$lock_name" == backboard-studio-\*-update\.lock/);
		assert.match(script, /rm -rf "\$UPDATE_LOCK_DIR"/);
	});

	test('rejects an updated app that exits during the stability window', { skip: process.platform !== 'darwin' }, () => {
		const script = macUpdateInstallerScript();
		const functionStart = script.indexOf('confirm_app_stable() {');
		const functionEnd = script.indexOf('\n}\n\nrun_elevated() {', functionStart);
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);
		const shellFunction = script.slice(functionStart, functionEnd + 2);

		const stable = spawnSync('/bin/zsh', ['-c', `${shellFunction}\napp_version_matches() { return 0; }\npid_is_exact_app_process() { return 0; }\nconfirm_app_stable "/Applications/Backboard Studio.app" "3.0.2" "42" 1`], { encoding: 'utf8' });
		assert.equal(stable.status, 0, stable.stderr);
		assert.match(stable.stdout, /Confirmed stable after launch/);

		const exited = spawnSync('/bin/zsh', ['-c', `${shellFunction}\napp_version_matches() { return 0; }\npid_is_exact_app_process() { return 1; }\nconfirm_app_stable "/Applications/Backboard Studio.app" "3.0.2" "42" 1`], { encoding: 'utf8' });
		assert.equal(exited.status, 1, exited.stderr);
		assert.match(exited.stdout, /exited or no longer belongs to the installed bundle during post-launch stability check/);

		const wrongVersion = spawnSync('/bin/zsh', ['-c', `${shellFunction}\napp_version_matches() { return 1; }\npid_is_exact_app_process() { return 0; }\nconfirm_app_stable "/Applications/Backboard Studio.app" "3.0.2" "42" 1`], { encoding: 'utf8' });
		assert.equal(wrongVersion.status, 1, wrongVersion.stderr);
		assert.match(wrongVersion.stdout, /Installed app version changed during post-launch stability check/);
	});
});
