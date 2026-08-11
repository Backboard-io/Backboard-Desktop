/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
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
		const removeBackupIndex = script.lastIndexOf('remove_backup_app "$BACKUP_APP"');

		assert.ok(swapIndex >= 0);
		assert.ok(launchIndex > swapIndex);
		assert.ok(removeBackupIndex > launchIndex);
		assert.match(script, /rollback_app "\$APP_PATH"/);
		assert.match(script, /Confirmed running and activated/);
		assert.match(script, /Installed and launched Backboard Studio/);
		assert.doesNotMatch(script, /local status=/);
	});
});
