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
}

// Load the actual compiled updater with an isolated VS Code host. All disk/network
// work stays real; only the app-install and quit boundaries are replaced by spies.
function createHarness(directory: string, events: string[], acceptInstall = false, cancelOnProgress = false): UpdaterHarness {
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
			showWarningMessage: async (message: string) => { events.push(`warning:${message}`); }
		}
	};
	runInNewContext(fs.readFileSync(filename, 'utf8') + `
currentMacAppPath = () => '/Applications/Backboard Studio.app';
readCurrentAppVersion = () => 'test';
backboardUpdateCacheDirectory = async () => directory;
acquireBackboardUpdateInstallLock = async () => { events.push('lock'); return {}; };
releaseBackboardUpdateInstallLock = async () => { events.push('unlock'); };
stageMacBackboardInstaller = async () => { events.push('stage'); };
module.exports.harness = {
 install: installBackboardUpdate,
 cancel: () => backboardUpdateCancellation?.abort(),
 download: downloadBackboardUpdate,
 checksum: sha256File
};`, {
		module, exports, require: (name: string) => name === 'vscode' ? vscode : localRequire(name),
		process, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
		directory, events
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
