/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for permission notice.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { macUpdateInstallerScript } from '../updatesInstaller';

/**
 * End-to-end exercise of the generated macOS updater installer script against
 * ad-hoc signed stub app bundles, entirely inside a temporary directory:
 *
 *   validate source -> stage -> report "ready"
 *   -> (test quits the running old app, like workbench.action.quit does)
 *   -> wait for clean exit -> swap with backup -> register -> launch updated app
 *   -> Electron-runtime check -> post-launch stability window -> "installed".
 *
 * Two variants run:
 *  1. DMG path with a real disk image and Gatekeeper assessment (auto-skips on
 *     hosts where hdiutil is not permitted, e.g. sandboxed CI runners).
 *  2. Source-app path through BACKBOARD_UPDATER_TEST_SOURCE_APP, which skips
 *     only the disk-image mount; everything after it is identical.
 *
 * In both cases Gatekeeper (`spctl`) assessment may be skipped through the
 * installer factory's test-only option because locally built stub bundles can
 * never be notarized; codesign verification still runs in full.
 */

const darwin = process.platform === 'darwin';
const skipAll = !darwin || process.env.BACKBOARD_UPDATER_SKIP_INTEGRATION === '1';

function compileStubBinary(binaryPath: string): void {
	// A real (if minimal) Mach-O main executable so the installer's exact
	// process matching and relaunch behave exactly as they do for Electron.
	const source = `
#include <crt_externs.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
	(void)argc; (void)argv;
	char self[8192];
	uint32_t size = sizeof(self);
	if (_NSGetExecutablePath(self, &size) != 0) {
		return 126;
	}
	char *marker = strstr(self, "/Contents/MacOS/");
	pid_t helper_pid = -1;
	if (marker != NULL) {
		size_t bundle_length = (size_t)(marker - self);
		char helper[9216];
		int written = snprintf(helper, sizeof(helper), "%.*s/Contents/Frameworks/helper",
			(int)bundle_length, self);
		if (written > 0 && written < (int)sizeof(helper) && access(helper, X_OK) == 0) {
			pid_t forked = fork();
			if (forked == 0) {
				char pid_arg[16];
				snprintf(pid_arg, sizeof(pid_arg), "%d", (int)getppid());
				execl(helper, helper, pid_arg, NULL);
				_exit(127);
			}
			if (forked > 0) {
				helper_pid = forked;
			}
		}
	}
	// Stay alive like an IDE session. The helper monitors this process and exits
	// when it disappears, so a hard kill here cannot strand children forever.
	for (;;) {
		if (helper_pid > 0 && waitpid(helper_pid, NULL, WNOHANG) == helper_pid) {
			helper_pid = -1;
		}
		sleep(1);
	}
}
`;
	fs.writeFileSync(`${binaryPath}.c`, source);
	execFileSync('clang', ['-O2', '-o', binaryPath, `${binaryPath}.c`], { stdio: 'pipe' });
	fs.rmSync(`${binaryPath}.c`, { force: true });
}

interface StubAppPaths {
	appPath: string;
	mainExecutable: string;
}

function makeStubApp(rootDir: string, name: string, version: string): StubAppPaths {
	const contentsPath = path.join(rootDir, name, 'Contents');
	const macOSPath = path.join(contentsPath, 'MacOS');
	const frameworksPath = path.join(contentsPath, 'Frameworks');
	fs.mkdirSync(macOSPath, { recursive: true });
	fs.mkdirSync(frameworksPath, { recursive: true });

	fs.writeFileSync(path.join(contentsPath, 'Info.plist'), [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<plist version="1.0"><dict>',
		'<key>CFBundleIdentifier</key><string>io.backboard.studio</string>',
		'<key>CFBundleName</key><string>Backboard Studio</string>',
		'<key>CFBundleExecutable</key><string>Backboard Studio</string>',
		'<key>CFBundleShortVersionString</key>',
		`<string>${version}</string>`,
		'<key>CFBundleVersion</key>',
		`<string>${version}</string>`,
		'</dict></plist>'
	].join('\n'));

	// The fake "Electron helper" lives under Contents/Frameworks like real
	// framework helpers, which is what electron_runtime_ready() detects. It must
	// be a real Mach-O binary: script "subcomponents" keep their ad-hoc code
	// signature in extended attributes, which the installer's ditto stage strips.
	const helperExecutable = path.join(frameworksPath, 'helper');
	fs.writeFileSync(`${helperExecutable}.c`, [
		'#include <stdio.h>',
		'#include <stdlib.h>',
		'#include <signal.h>',
		'#include <unistd.h>',
		'int main(int argc, char **argv) {',
		'\tpid_t parent = (argc > 1) ? (pid_t)atoi(argv[1]) : getppid();',
		'\twhile (kill(parent, 0) == 0) { sleep(1); }',
		'\treturn 0;',
		'}'
	].join('\n'));
	execFileSync('clang', ['-O2', '-o', helperExecutable, `${helperExecutable}.c`], { stdio: 'pipe' });
	fs.rmSync(`${helperExecutable}.c`, { force: true });

	const mainExecutable = path.join(macOSPath, 'Backboard Studio');
	compileStubBinary(mainExecutable);

	const result = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(rootDir, name)], { encoding: 'utf8' });
	assert.equal(result.status, 0, `codesign failed for ${name}: ${result.stderr}`);
	return { appPath: path.join(rootDir, name), mainExecutable };
}

function findMainPid(appPath: string): number | undefined {
	const executablePaths = [path.join(appPath, 'Contents/MacOS/Backboard Studio')];
	if (fs.existsSync(appPath)) {
		// LaunchServices launches the fully resolved bundle path, which can
		// differ from the symlinked path the test passed in (e.g. /var ->
		// /private/var).
		executablePaths.push(path.join(fs.realpathSync(appPath), 'Contents/MacOS/Backboard Studio'));
	}
	const processList = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
	for (const line of processList.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match && executablePaths.some(executablePath => match[2] === executablePath || match[2].startsWith(`${executablePath} `))) {
			return Number(match[1]);
		}
	}
	return undefined;
}

function findBundleHelperPids(appPath: string): number[] {
	if (!fs.existsSync(path.join(appPath, 'Contents'))) {
		return [];
	}
	const processList = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
	const prefix = `${fs.realpathSync(appPath)}/Contents/Frameworks/`;
	const pids: number[] = [];
	for (const line of processList.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match && match[2].startsWith(prefix)) {
			pids.push(Number(match[1]));
		}
	}
	return pids;
}

async function waitFor<T>(condition: () => T, timeoutMs: number, message: string): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = condition();
		if (result) {
			return result as NonNullable<T>;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(message);
}

function readStatus(statusPath: string): string | undefined {
	try {
		return fs.readFileSync(statusPath, 'utf8').trim();
	} catch {
		return undefined;
	}
}

function readPlistVersion(appPath: string): string {
	return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
}

/** Kill any processes running from inside the given bundle (tests own these bundles). */
function terminateBundleProcesses(installedAppPath: string): void {
	const pid = findMainPid(installedAppPath);
	if (pid !== undefined) {
		try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
	}
	for (const helperPid of findBundleHelperPids(installedAppPath)) {
		try { process.kill(helperPid, 'SIGTERM'); } catch { /* already gone */ }
	}
	spawnSync('/bin/sh', ['-c', `for p in $(ps -axo pid=,command= | grep -F '${installedAppPath}/Contents/' | awk '{print $1}'); do kill "$p" 2>/dev/null; done; true`], { stdio: 'ignore' });
}

function detachLeftoverMounts(workspaceRoot: string): void {
	const mounts = spawnSync('/bin/sh', ['-c', '/usr/bin/hdiutil info | grep backboard-updater-it || true'], { encoding: 'utf8' });
	for (const mountPoint of mounts.stdout.split(/\r?\n/).filter(Boolean)) {
		spawnSync('/usr/bin/hdiutil', ['detach', mountPoint.trim(), '-force'], { stdio: 'ignore' });
	}
	void workspaceRoot;
}

interface RunInstallerOptions {
	sourceAppOverride?: string;
	dmgPath?: string;
	installedAppPath: string;
	initialPid: number;
	newVersion: string;
	workspaceRoot: string;
	appName: string;
}

/** Stage + spawn the installer against a running old app, quit the app at "ready", assert full success. */
async function runInstallerToEnd(options: RunInstallerOptions): Promise<{ log: string }> {
	const logPath = path.join(options.workspaceRoot, 'update.log');
	const statusPath = path.join(options.workspaceRoot, 'update.status');
	const installerScript = macUpdateInstallerScript({ skipGatekeeperAssessment: true, skipForegroundActivation: true });
	const installerPath = path.join(options.workspaceRoot, 'install-update.sh');
	fs.writeFileSync(installerPath, installerScript, { mode: 0o755 });

	const syntax = spawnSync('/bin/zsh', ['-n', installerPath], { encoding: 'utf8' });
	assert.equal(syntax.status, 0, `Generated installer has shell syntax errors: ${syntax.stderr}`);

	const dmgPath = options.dmgPath ?? options.installedAppPath;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (options.sourceAppOverride) {
		env.BACKBOARD_UPDATER_TEST_SOURCE_APP = options.sourceAppOverride;
	} else {
		delete env.BACKBOARD_UPDATER_TEST_SOURCE_APP;
	}

	const installerProcess = spawn('/bin/zsh', [
		installerPath,
		dmgPath,
		options.installedAppPath,
		String(options.initialPid),
		options.newVersion,
		logPath,
		options.appName,
		'io.backboard.studio',
		statusPath,
		'',
		''
	], { stdio: 'ignore', detached: true, env });
	let exited = false;
	const exitCodePromise = new Promise<number | null>(resolve => installerProcess.once('exit', (code: number | null) => { exited = true; resolve(code); }));

	await waitFor(() => readStatus(statusPath) === 'ready' || readStatus(statusPath) === 'failed', 60_000, 'Installer never reported ready.');
	assert.equal(readStatus(statusPath), 'ready', fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');

	// Like workbench.action.quit: the app exits on its own, nothing kills it.
	process.kill(options.initialPid, 'SIGTERM');

	try {
		await waitFor(() => exited, 3 * 60 * 1000, 'Installer did not finish.');
	} catch {
		throw new Error(`Installer did not finish within its window.\n${fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''}\n${fs.existsSync(statusPath) ? `status: ${fs.readFileSync(statusPath, 'utf8')}` : ''}`);
	}
	const processSnapshot = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
		.split(/\r?\n/)
		.filter(line => line.includes(options.workspaceRoot))
		.join('\n');
	const finalLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
	const code = await exitCodePromise;

	assert.equal(code, 0, `${finalLog}\n=== processes ===\n${processSnapshot}`);
	assert.equal(readStatus(statusPath), 'installed', finalLog);
	assert.match(finalLog, /Prepared and verified Backboard Studio/);
	assert.match(finalLog, /Confirmed current Backboard Studio processes exited cleanly/);
	assert.match(finalLog, /Confirmed stable after launch/);
	assert.match(finalLog, /Installed and launched Backboard Studio/);
	assert.doesNotMatch(finalLog, /did not quit cleanly|restoring the previous version/);

	// The next version is now the installed one and it relaunched itself.
	assert.equal(readPlistVersion(options.installedAppPath), options.newVersion, finalLog);
	execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.installedAppPath]);
	return { log: finalLog };
}

test('installer swaps a running app after clean quit and relaunches the updated version (DMG mount)', {
	skip: skipAll ? 'Requires darwin (or set BACKBOARD_UPDATER_SKIP_INTEGRATION=1).' : false,
	timeout: 5 * 60 * 1000
}, async () => {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-updater-it.'));
	try {
		const oldApp = makeStubApp(workspaceRoot, 'Old Version.app', '3.0.4');
		assert.equal(readPlistVersion(oldApp.appPath), '3.0.4');

		// Stage the new DMG exactly like upload_s3_ide_release.sh produces it:
		// a DMG whose volume contains "<AppName>.app" at its root.
		const newVersion = '3.0.5';
		const newApp = makeStubApp(workspaceRoot, `${newVersion}.app`, newVersion);
		const dmgSource = fs.mkdtempSync(path.join(workspaceRoot, 'dmg-src.'));
		const mountedAppName = 'Backboard Studio.app';
		fs.renameSync(newApp.appPath, path.join(dmgSource, mountedAppName));
		const dmgPath = path.join(workspaceRoot, 'Backboard-Studio-aarch64.dmg');
		const hdiutil = spawnSync('/usr/bin/hdiutil', ['create', '-volname', 'Backboard Studio', '-srcfolder', dmgSource, '-ov', '-format', 'UDZO', dmgPath], { encoding: 'utf8', timeout: 30_000 });
		if (hdiutil.status !== 0) {
			// Sandboxed hosts deny disk-image access; the source-app variant below
			// covers everything except the mount itself.
			console.warn(`hdiutil create not permitted here (${(hdiutil.stderr ?? '').trim()}), skipping DMG-mount variant.`);
			return;
		}

		// Simulate the installed product location and the running IDE session.
		const installRoot = fs.mkdtempSync(path.join(workspaceRoot, 'install.'));
		const installedAppPath = path.join(installRoot, mountedAppName);
		execFileSync('/usr/bin/ditto', [oldApp.appPath, installedAppPath]);
		assert.equal(readPlistVersion(installedAppPath), '3.0.4');

		const initialExecutable = path.join(installedAppPath, 'Contents/MacOS/Backboard Studio');
		const initialChild = spawn(initialExecutable, [], { detached: true, stdio: 'ignore' });
		initialChild.unref();
		try {
			const initialPid = await waitFor(() => findMainPid(installedAppPath), 15_000, 'Stub old-version app did not start.');
			assert.ok(initialPid);

			const { log } = await runInstallerToEnd({
				dmgPath,
				installedAppPath,
				initialPid,
				newVersion,
				workspaceRoot,
				appName: mountedAppName
			});

			const relaunchedPid = await waitFor(() => findMainPid(installedAppPath), 20_000, 'Updated app did not relaunch.');
			assert.notEqual(relaunchedPid, initialPid, 'Updater did not replace the original app process.');
			try { process.kill(relaunchedPid, 'SIGTERM'); } catch { /* already gone */ }
			void log;
		} finally {
			terminateBundleProcesses(installedAppPath);
			initialChild.kill();
			detachLeftoverMounts(workspaceRoot);
		}
	} finally {
		detachLeftoverMounts(workspaceRoot);
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('installer swaps a running app after clean quit and relaunches the updated version (staged source)', {
	skip: skipAll ? 'Requires darwin (or set BACKBOARD_UPDATER_SKIP_INTEGRATION=1).' : false,
	timeout: 5 * 60 * 1000
}, async () => {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-updater-it.'));
	try {
		const oldApp = makeStubApp(workspaceRoot, 'Old Version.app', '3.0.4');
		const newVersion = '3.0.5';
		const newApp = makeStubApp(workspaceRoot, 'New Version.app', newVersion);
		const mountedAppName = 'Backboard Studio.app';

		const installRoot = fs.mkdtempSync(path.join(workspaceRoot, 'install.'));
		const installedAppPath = path.join(installRoot, mountedAppName);
		execFileSync('/usr/bin/ditto', [oldApp.appPath, installedAppPath]);

		const initialExecutable = path.join(installedAppPath, 'Contents/MacOS/Backboard Studio');
		const initialChild = spawn(initialExecutable, [], { detached: true, stdio: 'ignore' });
		initialChild.unref();
		try {
			const initialPid = await waitFor(() => findMainPid(installedAppPath), 15_000, 'Stub old-version app did not start.');
			assert.ok(initialPid);

			await runInstallerToEnd({
				sourceAppOverride: newApp.appPath,
				installedAppPath,
				initialPid,
				newVersion,
				workspaceRoot,
				appName: mountedAppName
			});

			const relaunchedPid = await waitFor(() => findMainPid(installedAppPath), 20_000, 'Updated app did not relaunch.');
			assert.notEqual(relaunchedPid, initialPid, 'Updater did not replace the original app process.');

			// Confirm_app_stable held for its whole window before installing, so the
			// relaunched process should still be alive right now.
			assert.equal(findMainPid(installedAppPath), relaunchedPid, 'Updated app died during the stability window.');
			try { process.kill(relaunchedPid, 'SIGTERM'); } catch { /* already gone */ }
		} finally {
			terminateBundleProcesses(installedAppPath);
			initialChild.kill();
		}
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});
