/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

interface UpdaterHarness {
	install(manifest: { version: string; url: string; sha256?: string }): Promise<void>;
	cancel(): void;
	download(url: string, destination: string, progress: { report(): void }, signal: AbortSignal): Promise<void>;
	checksum(file: string, signal: AbortSignal): Promise<string>;
	check(manual: boolean): Promise<void>;
	testUpdate(): Promise<void>;
}

// Load the actual compiled updater with an isolated VS Code host. All disk/network
// work stays real; only the app-install and quit boundaries are replaced by spies.
function createHarness(directory: string, events: string[], acceptInstall = false, cancelOnProgress = false, versions = { installed: 'test', published: 'test' }, developmentBuild = false): UpdaterHarness {
	const filename = path.resolve(__dirname, '../updates.js');
	const localRequire = createRequire(filename);
	const exports = {};
	const module = { exports };
	let harness: UpdaterHarness;
	const vscode = {
		l10n: { t: (value: string) => value },
		ProgressLocation: { Notification: 1 },
		commands: { executeCommand: async (command: string, key?: string, value?: boolean) => {
			events.push(command === 'setContext' ? `${key}:${value}` : command);
		} },
		window: {
			withProgress: async (_options: object, callback: (progress: { report(): void }, token: object) => Promise<void>) => callback({ report: () => {
				if (cancelOnProgress) { harness.cancel(); }
			} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) }),
			showInformationMessage: async () => { events.push('confirm'); return acceptInstall ? 'Install and Restart' : undefined; },
			setStatusBarMessage: () => ({ dispose() { } }),
			showWarningMessage: async (message: string) => { events.push(`warning:${message}`); }
		}
	};
	runInNewContext(fs.readFileSync(filename, 'utf8') + `
currentMacAppPath = () => '/Applications/Backboard Studio.app';
readCurrentAppVersion = () => versions.installed;
backboardUpdateCacheDirectory = async () => directory;
acquireBackboardUpdateInstallLock = async () => { events.push('lock'); return {}; };
releaseBackboardUpdateInstallLock = async () => { events.push('unlock'); };
stageMacBackboardInstaller = async () => { events.push('stage'); };
getBackboardUpdateManifestUrl = () => 'http://unused.invalid/manifest';
fetchBackboardUpdateManifest = async () => ({ version: versions.published, url: 'http://unused.invalid/update' });
acquireBackboardUpdateCheckLock = async () => ({});
isBackboardDevelopmentBuild = () => developmentBuild;
simulatedUpdateStep = async () => { };
module.exports.harness = {
 check: checkBackboardUpdates,
 testUpdate: testBackboardUpdate,
 install: installBackboardUpdate,
 cancel: () => backboardUpdateCancellation?.abort(),
 download: downloadBackboardUpdate,
 checksum: sha256File
};`, {
		module, exports, require: (name: string) => name === 'vscode' ? vscode : localRequire(name),
		process, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
		directory, events, versions, developmentBuild
	}, { filename });
	harness = (module.exports as { harness: UpdaterHarness }).harness;
	return harness;
}

test('canceling the restart prompt never stages or quits, and permits a retry', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-cancel-test-'));
	try {
		fs.writeFileSync(path.join(directory, 'Backboard-Studio-1.0.0.dmg'), 'cached update');
		const events: string[] = [];
		const updater = createHarness(directory, events);
		const manifest = { version: '1.0.0', url: 'http://unused.invalid/update' };
		await updater.install(manifest);
		await updater.install(manifest);
		assert.deepEqual(events, [
			'backboard.updateCancellable:true', 'lock', 'confirm', 'unlock', 'backboard.updateCancellable:false', 'backboard.updateAvailable:false',
			'backboard.updateCancellable:true', 'lock', 'confirm', 'unlock', 'backboard.updateCancellable:false', 'backboard.updateAvailable:false'
		]);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only explicit restart approval reaches the installer and quit command', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-approve-test-'));
	try {
		fs.writeFileSync(path.join(directory, 'Backboard-Studio-1.0.0.dmg'), 'cached update');
		const events: string[] = [];
		await createHarness(directory, events, true).install({ version: '1.0.0', url: 'http://unused.invalid/update' });
		assert.deepEqual(events, [
			'backboard.updateCancellable:true', 'lock', 'confirm', 'backboard.updateCancellable:false',
			'stage', 'workbench.action.quit', 'backboard.updateCancellable:false', 'backboard.updateAvailable:false'
		]);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('stopping before download cleans partial files and releases the lock without a warning', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-stop-test-'));
	try {
		const events: string[] = [];
		await createHarness(directory, events, false, true).install({ version: '1.0.0', url: 'http://unused.invalid/update' });
		assert.deepEqual({ events, files: fs.readdirSync(directory) }, {
			events: ['backboard.updateCancellable:true', 'lock', 'unlock', 'backboard.updateCancellable:false', 'backboard.updateAvailable:false'], files: []
		});
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Stop aborts a streaming download after a redirect and closes the output file', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-stream-test-'));
	const server = http.createServer((request, response) => {
		if (request.url === '/redirect') {
			response.writeHead(302, { location: '/download' });
			response.end();
		} else {
			response.writeHead(200, { 'content-length': 10000 });
			response.write(Buffer.alloc(1024));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const cancellation = new AbortController();
		const updater = createHarness(directory, []);
		const destination = path.join(directory, 'download.partial');
		await assert.rejects(updater.download(`http://127.0.0.1:${address.port}/redirect`, destination, { report: () => cancellation.abort() }, cancellation.signal), { name: 'AbortError' });
		fs.rmSync(destination, { force: true });
		assert.equal(fs.existsSync(destination), false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('Stop interrupts checksum verification', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-hash-test-'));
	try {
		const file = path.join(directory, 'update.dmg');
		fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
		const cancellation = new AbortController();
		const pending = createHarness(directory, []).checksum(file, cancellation.signal);
		cancellation.abort();
		await assert.rejects(pending, { name: 'AbortError' });
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the update test command offers the installed release and keeps the Update button lit', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-test-mode-'));
	try {
		const events: string[] = [];
		const updater = createHarness(directory, events);
		await updater.check(true);
		const upToDate = events.splice(0);
		await updater.testUpdate();
		const testMode = events.splice(0);
		await updater.check(false);
		assert.deepEqual({ upToDate, testMode, automaticCheck: events }, {
			upToDate: ['unlock', 'backboard.updateAvailable:false'],
			testMode: ['unlock', 'backboard.updateAvailable:true', 'confirm'],
			automaticCheck: ['unlock', 'backboard.updateAvailable:true']
		});
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the update test command never offers a downgrade to an older published release', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-test-downgrade-'));
	try {
		const events: string[] = [];
		await createHarness(directory, events, false, false, { installed: '3.1.26', published: '3.1.25' }).testUpdate();
		assert.deepEqual(events, [
			'unlock', 'backboard.updateAvailable:false',
			'warning:The latest published release (3.1.25) is older than this build (3.1.26). Publish this build to its update channel first; the update test reinstalls the latest published release.'
		]);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a development build walks the whole update flow against a simulated release and never quits', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-update-test-dev-'));
	try {
		const events: string[] = [];
		await createHarness(directory, events, true, false, { installed: '3.1.25', published: 'unused' }, true).testUpdate();
		assert.deepEqual(events, [
			'backboard.updateAvailable:true', 'confirm',
			'backboard.updateCancellable:true', 'lock', 'confirm', 'backboard.updateCancellable:false', 'confirm',
			'unlock', 'backboard.updateCancellable:false', 'backboard.updateAvailable:false'
		]);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
