/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { innoProgressPercent, windowsSignatureRejection, windowsSilentUpdateArguments, windowsUpdaterEnvironment } from '../updatesWindowsInstaller';

test('the silent installer stages beside the running app and relaunches it', () => {
	assert.deepEqual(windowsSilentUpdateArguments({
		flagPath: 'C:\\Users\\A B\\Temp\\install-backboard-update.flag',
		progressPath: 'C:\\Users\\A B\\Temp\\install-backboard-update.progress',
		logPath: 'C:\\Users\\A B\\Temp\\backboard-studio-update.log'
	}), [
		'/verysilent',
		'/suppressmsgboxes',
		'/norestart',
		'/log="C:\\Users\\A B\\Temp\\backboard-studio-update.log"',
		'/update="C:\\Users\\A B\\Temp\\install-backboard-update.flag"',
		'/progress="C:\\Users\\A B\\Temp\\install-backboard-update.progress"',
		'/nocloseapplications',
		'/mergetasks=runcode,!desktopicon,!quicklaunchicon'
	]);
});

test('extension host state never reaches the relaunched app', () => {
	assert.deepEqual(windowsUpdaterEnvironment({
		Path: 'C:\\Windows',
		USERPROFILE: 'C:\\Users\\a',
		ELECTRON_RUN_AS_NODE: '1',
		VSCODE_IPC_HOOK: '\\\\.\\pipe\\stale',
		vscode_pid: '42'
	}), {
		Path: 'C:\\Windows',
		USERPROFILE: 'C:\\Users\\a',
		__COMPAT_LAYER: 'RunAsInvoker'
	});
});

test('Inno Setup progress becomes a whole percentage', () => {
	assert.deepEqual(['0,0', '512,2048', '2048,2048', ' 3000 , 2048\r\n', 'garbage', ''].map(innoProgressPercent), [undefined, 25, 100, 100, undefined, undefined]);
});

test('a signed install only runs an installer from the same publisher', () => {
	const publisher = 'CN=Espri.ai Inc., O=Espri.ai Inc., L=Ottawa, S=Ontario, C=CA';
	const signed = { installedStatus: 'Valid', installedSigner: publisher };
	assert.deepEqual([
		windowsSignatureRejection({ ...signed, setupStatus: 'Valid', setupSigner: publisher }),
		windowsSignatureRejection({ ...signed, setupStatus: 'NotSigned', setupSigner: '' }),
		windowsSignatureRejection({ ...signed, setupStatus: 'Valid', setupSigner: 'CN=Someone Else' }),
		windowsSignatureRejection({ installedStatus: 'NotSigned', installedSigner: '', setupStatus: 'NotSigned', setupSigner: '' })
	], [
		undefined,
		'The downloaded installer\'s signature is not valid (NotSigned).',
		`Refusing an installer signed by "CN=Someone Else"; the installed app is signed by "${publisher}".`,
		undefined
	]);
});

type Stage = (setupPath: string, installDirectory: string, version: string, lock: { directory: string; ownerPath: string }, progress: { report(value: { message?: string }): void }) => Promise<void>;

// Load the compiled updater with temp files redirected to `directory`; only the
// PowerShell signature check is replaced, since it needs Windows.
function loadStage(directory: string): Stage {
	const filename = path.resolve(__dirname, '../updates.js');
	const localRequire = createRequire(filename);
	const module = { exports: {} as { stage?: Stage } };
	const temporaryOs = { ...os, tmpdir: () => directory };
	runInNewContext(fs.readFileSync(filename, 'utf8') + `
verifyWindowsInstallerSignature = async () => { };
module.exports.stage = stageWindowsBackboardInstaller;`, {
		module, exports: module.exports,
		require: (name: string) => name === 'vscode' ? {} : name === 'os' ? temporaryOs : localRequire(name),
		process, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval
	}, { filename });
	return module.exports.stage!;
}

// Stands in for Inno Setup's /update mode: report progress, write the ready
// marker, then (like waiting on the app mutex) wait to learn whether to relaunch.
function writeFakeSetup(directory: string, installDirectory: string, exitCode: number): string {
	const setupPath = path.join(directory, 'Backboard-Studio-1.0.0-Setup.exe');
	fs.writeFileSync(setupPath, `#!/bin/sh
for argument in "$@"; do
	value="\${argument#*=\\"}"; value="\${value%\\"}"
	case "$argument" in /progress=*) progress="$value" ;; /update=*) flag="$value" ;; /log=*) log="$value" ;; esac
	echo "$argument" >> "${directory}/arguments"
done
if [ ${exitCode} -ne 0 ]; then echo "Setup failed: disk full" > "$log"; exit ${exitCode}; fi
printf '50,100' > "$progress"; sleep 0.3; printf '100,100' > "$progress"; sleep 0.3
printf 'commit' > "${installDirectory}/updating_version"
while [ -e "$flag" ]; do sleep 0.1; done
echo relaunch > "${directory}/relaunched"
`, { mode: 0o700 });
	return setupPath;
}

test('staging reports progress, records the installer, and requests a relaunch only once ready', { skip: process.platform === 'win32' }, async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-windows-stage-test-'));
	try {
		const installDirectory = path.join(directory, 'Backboard Studio');
		fs.mkdirSync(installDirectory);
		fs.writeFileSync(path.join(installDirectory, 'updating_version'), 'stale marker from an interrupted run');
		const lock = { directory, ownerPath: path.join(directory, 'owner.json') };
		const messages: (string | undefined)[] = [];
		await loadStage(directory)(writeFakeSetup(directory, installDirectory, 0), installDirectory, '1.0.0', lock, { report: value => messages.push(value.message) });
		for (let attempt = 0; attempt < 50 && !fs.existsSync(path.join(directory, 'relaunched')); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		const owner = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8'));
		assert.deepEqual({
			messages,
			owner: { phase: owner.phase, version: owner.version, hasPid: owner.pid > 0 },
			arguments: fs.readFileSync(path.join(directory, 'arguments'), 'utf8').trim().split('\n').map(argument => argument.replaceAll(directory, '<tmp>')),
			flagRemoved: !fs.existsSync(path.join(directory, 'install-backboard-update.flag')),
			relaunched: fs.existsSync(path.join(directory, 'relaunched'))
		}, {
			messages: ['50%', '100%'],
			owner: { phase: 'installer', version: '1.0.0', hasPid: true },
			arguments: [
				'/verysilent', '/suppressmsgboxes', '/norestart', '/log="<tmp>/backboard-studio-update.log"',
				'/update="<tmp>/install-backboard-update.flag"', '/progress="<tmp>/install-backboard-update.progress"',
				'/nocloseapplications', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'
			],
			flagRemoved: true,
			relaunched: true
		});
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a setup failure before staging finishes surfaces its log and keeps the app running', { skip: process.platform === 'win32' }, async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-windows-stage-fail-test-'));
	try {
		const installDirectory = path.join(directory, 'Backboard Studio');
		fs.mkdirSync(installDirectory);
		const lock = { directory, ownerPath: path.join(directory, 'owner.json') };
		await assert.rejects(loadStage(directory)(writeFakeSetup(directory, installDirectory, 1), installDirectory, '1.0.0', lock, { report: () => { } }), {
			message: `Update preparation failed: Setup failed: disk full Full log: ${path.join(directory, 'backboard-studio-update.log')}`
		});
		assert.equal(fs.existsSync(path.join(directory, 'install-backboard-update.flag')), true);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
