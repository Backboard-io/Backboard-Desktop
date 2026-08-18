/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { macUpdateInstallerScript } from '../updatesInstaller';

const sourceApp = process.env.BACKBOARD_UPDATER_E2E_SOURCE_APP;
const updateDmg = process.env.BACKBOARD_UPDATER_E2E_DMG;
const expectedVersion = process.env.BACKBOARD_UPDATER_E2E_VERSION;
const enabled = process.platform === 'darwin' && Boolean(sourceApp && updateDmg && expectedVersion);

test('updates and relaunches a disposable installed-app clone', {
	skip: enabled ? false : 'Set BACKBOARD_UPDATER_E2E_SOURCE_APP, BACKBOARD_UPDATER_E2E_DMG, and BACKBOARD_UPDATER_E2E_VERSION.',
	timeout: 5 * 60 * 1000
}, () => {
	assert.ok(sourceApp);
	assert.ok(updateDmg);
	assert.ok(expectedVersion);

	const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-updater-e2e.'));
	const appPath = path.join(testRoot, 'Backboard Studio.app');
	const installerPath = path.join(testRoot, 'install-backboard-update.sh');
	const statusPath = path.join(testRoot, 'install-backboard-update.status');
	const logPath = path.join(testRoot, 'install-backboard-update.log');
	const userDataPath = path.join(testRoot, 'user-data');

	try {
		execFileSync('/usr/bin/ditto', [sourceApp, appPath], { stdio: 'inherit' });
		fs.writeFileSync(installerPath, macUpdateInstallerScript(), { mode: 0o700 });

		const result = spawnSync('/bin/zsh', [
			installerPath,
			updateDmg,
			appPath,
			'999999',
			expectedVersion,
			logPath,
			'Backboard Studio.app',
			'io.backboard.studio',
			statusPath,
			userDataPath
		], {
			encoding: 'utf8',
			timeout: 4 * 60 * 1000
		});

		const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		assert.equal(result.status, 0, `${result.stderr}\n${log}`);
		assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'installed', log);
		assert.match(log, /Prepared and verified Backboard Studio/);
		assert.match(log, /Confirmed stable after launch/);
		assert.match(log, /Installed and launched Backboard Studio/);

		const installedVersion = execFileSync('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleShortVersionString',
			path.join(appPath, 'Contents', 'Info.plist')
		], { encoding: 'utf8' }).trim();
		assert.equal(installedVersion, expectedVersion);
		execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
		execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
	} finally {
		spawnSync('/usr/bin/pkill', ['-f', `${appPath}/Contents/`]);
		fs.rmSync(testRoot, { recursive: true, force: true });
	}
});
