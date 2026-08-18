/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { macUpdateInstallerScript } from '../updatesInstaller';

const sourceApp = process.env.BACKBOARD_UPDATER_E2E_SOURCE_APP;
const updateDmg = process.env.BACKBOARD_UPDATER_E2E_DMG;
const expectedVersion = process.env.BACKBOARD_UPDATER_E2E_VERSION;
const enabled = process.platform === 'darwin' && Boolean(sourceApp && updateDmg && expectedVersion);

function childExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Process ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms.`)), timeoutMs);
		child.once('error', error => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal });
		});
	});
}

async function waitForReadyStatus(statusPath: string, logPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(statusPath)) {
			const status = fs.readFileSync(statusPath, 'utf8').trim();
			if (status === 'ready') {
				return;
			}
			if (status === 'failed') {
				const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
				throw new Error(`Installer failed before becoming ready.\n${log}`);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Installer did not become ready within ${timeoutMs}ms.`);
}

function findAppPid(executablePath: string): number | undefined {
	const processList = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
	for (const line of processList.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match && (match[2] === executablePath || match[2].startsWith(`${executablePath} `))) {
			return Number(match[1]);
		}
	}
	return undefined;
}

function findBundleProcessPids(appPath: string): number[] {
	if (!fs.existsSync(appPath)) {
		return [];
	}

	const contentsPath = `${fs.realpathSync(appPath)}${path.sep}Contents${path.sep}`;
	const processList = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
	const pids: number[] = [];
	for (const line of processList.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match?.[2].startsWith(contentsPath)) {
			pids.push(Number(match[1]));
		}
	}
	return pids;
}

async function waitForAppPid(executablePath: string, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pid = findAppPid(executablePath);
		if (pid !== undefined) {
			return pid;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Disposable app did not launch within ${timeoutMs}ms.`);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms.`);
}

async function quitDisposableApp(appPath: string, timeoutMs: number): Promise<void> {
	if (findBundleProcessPids(appPath).length === 0) {
		return;
	}

	const exactAppPath = fs.realpathSync(appPath).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
	execFileSync('/usr/bin/osascript', ['-e', `tell application "${exactAppPath}" to quit`]);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (findBundleProcessPids(appPath).length === 0) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}

	throw new Error(`Disposable app did not quit normally within ${timeoutMs}ms; leaving ${appPath} intact for diagnosis.`);
}

test('gracefully quits, updates, and relaunches a disposable installed-app clone', {
	skip: enabled ? false : 'Set BACKBOARD_UPDATER_E2E_SOURCE_APP, BACKBOARD_UPDATER_E2E_DMG, and BACKBOARD_UPDATER_E2E_VERSION.',
	timeout: 7 * 60 * 1000
}, async () => {
	assert.ok(sourceApp);
	assert.ok(updateDmg);
	assert.ok(expectedVersion);

	const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-updater-e2e.'));
	const appPath = path.join(testRoot, 'Backboard Studio.app');
	const installerPath = path.join(testRoot, 'install-backboard-update.sh');
	const statusPath = path.join(testRoot, 'install-backboard-update.status');
	const logPath = path.join(testRoot, 'install-backboard-update.log');
	const userDataPath = path.join(testRoot, 'user-data');
	const extensionsPath = path.join(userDataPath, 'extensions');
	let initialAppPid: number | undefined;

	try {
		execFileSync('/usr/bin/ditto', [sourceApp, appPath], { stdio: 'inherit' });
		fs.writeFileSync(installerPath, macUpdateInstallerScript(), { mode: 0o700 });
		fs.mkdirSync(extensionsPath, { recursive: true });

		const executablePath = fs.realpathSync(path.join(appPath, 'Contents', 'MacOS', 'Backboard Studio'));
		execFileSync('/usr/bin/open', [
			'-n',
			appPath,
			'--args',
			'--user-data-dir',
			userDataPath,
			'--extensions-dir',
			extensionsPath
		]);
		initialAppPid = await waitForAppPid(executablePath, 30_000);
		await new Promise(resolve => setTimeout(resolve, 5_000));
		assert.equal(findAppPid(executablePath), initialAppPid, 'Disposable old app exited during its startup hold check.');

		const installer = spawn('/bin/zsh', [
			installerPath,
			updateDmg,
			appPath,
			String(initialAppPid),
			expectedVersion,
			logPath,
			'Backboard Studio.app',
			'io.backboard.studio',
			statusPath,
			userDataPath
		], { stdio: 'ignore' });
		const installerExit = childExit(installer, 6 * 60 * 1000);

		await waitForReadyStatus(statusPath, logPath, 4 * 60 * 1000);
		const exactAppPath = fs.realpathSync(appPath).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
		execFileSync('/usr/bin/osascript', ['-e', `tell application "${exactAppPath}" to quit`]);
		await waitForPidExit(initialAppPid, 30_000);
		const result = await installerExit;

		const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		assert.equal(result.signal, null, `${result.signal ?? ''}\n${log}`);
		assert.equal(result.code, 0, log);
		assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'installed', log);
		assert.match(log, /Prepared and verified Backboard Studio/);
		assert.match(log, /Confirmed current Backboard Studio processes exited cleanly/);
		assert.doesNotMatch(log, /did not quit cleanly/);
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
		await quitDisposableApp(appPath, 30_000);
		fs.rmSync(testRoot, { recursive: true, force: true });
	}
});
