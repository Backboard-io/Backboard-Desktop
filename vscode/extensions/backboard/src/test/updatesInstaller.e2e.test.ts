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
const installerModulePath = process.env.BACKBOARD_UPDATER_E2E_INSTALLER_MODULE;
const appBundleName = process.env.BACKBOARD_UPDATER_E2E_APP_NAME || 'Backboard Studio.app';
const bundleIdentifier = process.env.BACKBOARD_UPDATER_E2E_BUNDLE_ID || 'io.backboard.studio';
const testRootParent = process.env.BACKBOARD_UPDATER_E2E_ROOT || os.tmpdir();
const enabled = process.platform === 'darwin' && Boolean(sourceApp && updateDmg && expectedVersion);

function installerScript(): string {
	if (!installerModulePath) {
		return macUpdateInstallerScript();
	}
	const legacyModule = require(installerModulePath) as { macUpdateInstallerScript?: () => string };
	const factory = legacyModule.macUpdateInstallerScript;
	if (typeof factory !== 'function') {
		throw new Error(`Missing macUpdateInstallerScript export in ${installerModulePath}`);
	}
	return factory();
}

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

function appIsActive(pid: number): boolean {
	const state = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-', String(pid)], {
		encoding: 'utf8',
		input: `ObjC.import('AppKit');
function run(argv) {
	const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
	return !app.isNil() && app.active && !app.hidden ? 'active' : 'inactive';
}
`
	}).trim();
	return state === 'active';
}

function requestAppTerminate(pid: number): void {
	try {
		process.kill(pid, 'SIGTERM');
	} catch (error) {
		throw new Error(`Could not request graceful termination of disposable app pid ${pid}: ${String(error)}`);
	}
}

async function waitForAppActive(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (appIsActive(pid)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Disposable updated app pid ${pid} was not foreground-active within ${timeoutMs}ms.`);
}

async function quitDisposableApp(appPath: string, timeoutMs: number): Promise<void> {
	if (findBundleProcessPids(appPath).length === 0) {
		return;
	}

	const executable = execFileSync('/usr/libexec/PlistBuddy', [
		'-c',
		'Print :CFBundleExecutable',
		path.join(appPath, 'Contents', 'Info.plist')
	], { encoding: 'utf8' }).trim();
	const mainPid = findAppPid(fs.realpathSync(path.join(appPath, 'Contents', 'MacOS', executable)));
	if (mainPid !== undefined) {
		requestAppTerminate(mainPid);
	}

	const deadline = Date.now() + timeoutMs;
	const gracefulDeadline = Math.min(deadline, Date.now() + 5_000);
	while (Date.now() < gracefulDeadline) {
		if (findBundleProcessPids(appPath).length === 0) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}

	// Repeated test bundles share a bundle identifier, so cleanup must never use
	// a bundle-wide quit request. The updater's pre-swap graceful-quit assertion
	// has already completed at this point; signal only this disposable bundle's
	// exact processes to make teardown deterministic.
	for (const pid of findBundleProcessPids(appPath)) {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// The process may have exited between enumeration and signaling.
		}
	}

	while (Date.now() < deadline) {
		if (findBundleProcessPids(appPath).length === 0) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}

	throw new Error(`Disposable app processes did not exit within ${timeoutMs}ms; leaving ${appPath} intact for diagnosis.`);
}

test('gracefully quits, updates, and relaunches a disposable installed-app clone', {
	skip: enabled ? false : 'Set BACKBOARD_UPDATER_E2E_SOURCE_APP, BACKBOARD_UPDATER_E2E_DMG, and BACKBOARD_UPDATER_E2E_VERSION.',
	timeout: 7 * 60 * 1000
}, async () => {
	assert.ok(sourceApp);
	assert.ok(updateDmg);
	assert.ok(expectedVersion);

	const testRoot = fs.mkdtempSync(path.join(testRootParent, 'backboard-updater-e2e.'));
	const appPath = path.join(testRoot, appBundleName);
	const installerPath = path.join(testRoot, 'install-backboard-update.sh');
	const statusPath = path.join(testRoot, 'install-backboard-update.status');
	const logPath = path.join(testRoot, 'install-backboard-update.log');
	const userDataPath = path.join(testRoot, 'user-data');
	const extensionsPath = path.join(userDataPath, 'extensions');
	let initialAppPid: number | undefined;
	let installer: ChildProcess | undefined;
	let installerExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

	try {
		execFileSync('/usr/bin/ditto', [sourceApp, appPath], { stdio: 'inherit' });
		fs.writeFileSync(installerPath, installerScript(), { mode: 0o700 });
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

		installer = spawn('/bin/zsh', [
			installerPath,
			updateDmg,
			appPath,
			String(initialAppPid),
			expectedVersion,
			logPath,
			appBundleName,
			bundleIdentifier,
			statusPath,
			userDataPath
		], { stdio: 'ignore' });
		installerExit = childExit(installer, 6 * 60 * 1000);

		await waitForReadyStatus(statusPath, logPath, 4 * 60 * 1000);
		requestAppTerminate(initialAppPid);
		await waitForPidExit(initialAppPid, 30_000);
		const result = await installerExit;

		const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		assert.equal(result.signal, null, `${result.signal ?? ''}\n${log}`);
		assert.equal(result.code, 0, log);
		assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'installed', log);
		assert.match(log, /Prepared and verified Backboard Studio/);
		assert.match(log, /Confirmed current Backboard Studio processes exited cleanly/);
		assert.doesNotMatch(log, /did not quit cleanly/);
		if (!installerModulePath) {
			assert.match(log, /Confirmed Electron runtime ready/);
		}
		assert.match(log, /Confirmed stable after launch/);
		if (!installerModulePath) {
			assert.match(log, /Confirmed active after verified launch/);
		}
		assert.match(log, /Installed and launched Backboard Studio/);
		const relaunchedAppPid = await waitForAppPid(executablePath, 30_000);
		assert.notEqual(relaunchedAppPid, initialAppPid, 'Updater did not replace the original app process.');
		await waitForAppActive(relaunchedAppPid, 30_000);

		const installedVersion = execFileSync('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleShortVersionString',
			path.join(appPath, 'Contents', 'Info.plist')
		], { encoding: 'utf8' }).trim();
		assert.equal(installedVersion, expectedVersion);
		execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
		execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
	} finally {
		if (installer && installer.exitCode === null && installer.signalCode === null) {
			installer.kill('SIGTERM');
			try {
				await (installerExit ?? childExit(installer, 30_000));
			} catch {
				// Preserve the original test failure; exact disposable processes are
				// handled below and the installer has already received SIGTERM.
			}
		}
		await quitDisposableApp(appPath, 30_000);
		fs.rmSync(testRoot, { recursive: true, force: true });
	}
});
