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
		const swapIndex = script.indexOf('swap_staged_app "$APP_PATH"');

		assert.ok(prepareIndex >= 0);
		assert.ok(readyIndex > prepareIndex);
		assert.ok(swapIndex > readyIndex);
		assert.match(script, /codesign --verify --deep --strict/);
		assert.match(script, /spctl --assess --type execute/);
		assert.doesNotMatch(script, /rm -rf "\$APP_PATH"/);
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
