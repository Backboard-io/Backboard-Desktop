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
		assert.match(script, /pgrep -f "\$target_app\/Contents\/MacOS\/\$executable"/);
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
		const launchIndex = script.indexOf('if ! launch_app "$APP_PATH"');
		const stabilityIndex = script.indexOf('! confirm_app_stable "$APP_PATH" 30');
		const removeBackupIndex = script.lastIndexOf('remove_backup_app "$BACKUP_APP"');

		assert.ok(swapIndex >= 0);
		assert.ok(launchIndex > swapIndex);
		assert.ok(stabilityIndex > launchIndex);
		assert.ok(removeBackupIndex > stabilityIndex);
		assert.match(script, /rollback_app "\$APP_PATH"/);
		assert.match(script, /Confirmed running and activated/);
		assert.match(script, /Updated app exited during post-launch stability check/);
		assert.match(script, /Confirmed stable after launch/);
		assert.match(script, /Installed and launched Backboard Studio/);
		assert.match(script, /xattr -cr "\$app_path"/);
		assert.doesNotMatch(script, /local status=/);
	});

	test('rejects an updated app that exits during the stability window', { skip: process.platform !== 'darwin' }, () => {
		const script = macUpdateInstallerScript();
		const functionStart = script.indexOf('confirm_app_stable() {');
		const functionEnd = script.indexOf('\n}\n\nrun_elevated() {', functionStart);
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);
		const shellFunction = script.slice(functionStart, functionEnd + 2);

		const stable = spawnSync('/bin/zsh', ['-c', `${shellFunction}\napp_running() { return 0; }\nconfirm_app_stable "/Applications/Backboard Studio.app" 1`], { encoding: 'utf8' });
		assert.equal(stable.status, 0, stable.stderr);
		assert.match(stable.stdout, /Confirmed stable after launch/);

		const exited = spawnSync('/bin/zsh', ['-c', `${shellFunction}\napp_running() { return 1; }\nconfirm_app_stable "/Applications/Backboard Studio.app" 1`], { encoding: 'utf8' });
		assert.equal(exited.status, 1, exited.stderr);
		assert.match(exited.stdout, /Updated app exited during post-launch stability check/);
	});
});
