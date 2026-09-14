/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { CliTsServeProcess, cliTsInvocationFingerprint, detectCliTsExecutableArchitecture } from '../../node/cliTs/cliTsProcess.js';

interface IStubRuntimeOptions {
	/** Capabilities the stub announces in `serve:ready`. */
	readonly capabilities?: readonly string[];
	/** Delay before the stub acknowledges `setCredentials`. */
	readonly credentialAckDelayMs?: number;
	/** Ops the stub records but never answers. */
	readonly hangOps?: readonly string[];
}

const STUB_ENV = ['BACKBOARD_CLI_TS_PATH', 'CLI_TS_STUB_LOG', 'CLI_TS_STUB_CAPABILITIES', 'CLI_TS_STUB_ACK_DELAY_MS', 'CLI_TS_STUB_HANG_OPS'] as const;

/**
 * Runs `fn` against a stand-in runtime: it announces itself, records every op
 * it receives (tagged with whether the credential snapshot was acknowledged
 * by then), acknowledges correlated requests, and exits on dispose.
 */
async function withStubRuntime(options: IStubRuntimeOptions, fn: (ops: () => string[]) => Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ts-stub-'));
	const logPath = path.join(directory, 'ops.log');
	const stubScript = path.join(directory, 'stub.js');
	const stubLauncher = path.join(directory, 'backboard-cli-ts');
	fs.writeFileSync(stubScript, [
		`const fs = require('fs');`,
		`const readline = require('readline');`,
		`const capabilities = JSON.parse(process.env.CLI_TS_STUB_CAPABILITIES);`,
		`const ackDelay = Number(process.env.CLI_TS_STUB_ACK_DELAY_MS);`,
		`const hangOps = JSON.parse(process.env.CLI_TS_STUB_HANG_OPS);`,
		`let credentialsAcked = false;`,
		`const write = record => process.stdout.write(JSON.stringify({ timestamp: '', session_id: 's', source: 'serve', ...record }) + '\\n');`,
		`write({ type: 'serve:ready', payload: { capabilities } });`,
		`readline.createInterface({ input: process.stdin }).on('line', line => {`,
		`	const control = JSON.parse(line);`,
		`	fs.appendFileSync(process.env.CLI_TS_STUB_LOG, control.op + ':' + credentialsAcked + '\\n');`,
		`	if (control.op === 'dispose') { process.exit(0); }`,
		`	if (!control.requestId || hangOps.includes(control.op)) { return; }`,
		`	const ack = () => write({ type: 'serve:ack', requestId: control.requestId, payload: { op: control.op } });`,
		`	if (control.op === 'setCredentials') { setTimeout(() => { credentialsAcked = true; ack(); }, ackDelay); return; }`,
		`	ack();`,
		`});`,
	].join('\n'));
	fs.writeFileSync(stubLauncher, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`, { mode: 0o755 });
	const previous = new Map(STUB_ENV.map(name => [name, process.env[name]] as const));
	process.env['BACKBOARD_CLI_TS_PATH'] = stubLauncher;
	process.env['CLI_TS_STUB_LOG'] = logPath;
	process.env['CLI_TS_STUB_CAPABILITIES'] = JSON.stringify(options.capabilities ?? ['host-managed-byok-v1']);
	process.env['CLI_TS_STUB_ACK_DELAY_MS'] = String(options.credentialAckDelayMs ?? 0);
	process.env['CLI_TS_STUB_HANG_OPS'] = JSON.stringify(options.hangOps ?? []);
	try {
		await fn(() => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : []);
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

suite('cli-ts process', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('hands over the credential snapshot after ready and holds requests until it is acknowledged', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await withStubRuntime({ credentialAckDelayMs: 150 }, async ops => {
			const proc = store.add(new CliTsServeProcess(new NullLogService(), {
				onEvent: () => { },
				credentialSnapshot: () => ({ op: 'setCredentials', revision: 1, providerKeys: [{ provider: 'openai', key: 'sk-test' }] }),
			}));
			const ack = await proc.request({ op: 'listModels', requestId: 'r1' });
			const ready = await proc.whenReady();
			assert.deepStrictEqual({
				ackOp: (ack.payload as { op: string }).op,
				capabilities: ready.capabilities,
				snapshotWritten: proc.credentialSnapshotWritten,
				// The request line reached the runtime only after it acknowledged the snapshot.
				ops: ops(),
			}, {
				ackOp: 'listModels',
				capabilities: ['host-managed-byok-v1'],
				snapshotWritten: true,
				ops: ['setCredentials:false', 'listModels:true'],
			});
		});
	});

	test('sends an empty snapshot too, so a runtime never keeps keys the host no longer holds', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await withStubRuntime({}, async ops => {
			const proc = store.add(new CliTsServeProcess(new NullLogService(), {
				onEvent: () => { },
				credentialSnapshot: () => ({ op: 'setCredentials', revision: 0, providerKeys: [] }),
			}));
			await proc.request({ op: 'listModels', requestId: 'r1' });
			assert.deepStrictEqual(ops(), ['setCredentials:false', 'listModels:true']);
		});
	});

	test('refuses every request to a runtime without the capability and never sends it keys', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await withStubRuntime({ capabilities: [] }, async ops => {
			const proc = store.add(new CliTsServeProcess(new NullLogService(), {
				onEvent: () => { },
				credentialSnapshot: () => ({ op: 'setCredentials', revision: 1, providerKeys: [{ provider: 'openai', key: 'sk-test' }] }),
			}));
			await assert.rejects(proc.request({ op: 'listModels', requestId: 'r1' }), /does not support API keys/);
			await proc.whenExited();
			assert.deepStrictEqual({ running: proc.isRunning, ops: ops() }, { running: false, ops: ['dispose:false'] });
		});
	});

	test('terminate ends the child and fails its pending requests with the given reason', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		await withStubRuntime({ hangOps: ['listModels'] }, async ops => {
			const proc = store.add(new CliTsServeProcess(new NullLogService(), {
				onEvent: () => { },
				credentialSnapshot: () => ({ op: 'setCredentials', revision: 1, providerKeys: [] }),
			}));
			const pending = proc.request({ op: 'listModels', requestId: 'r1' });
			await until(() => ops().includes('listModels:true'));
			proc.terminate('Runtime restarted after a credential change.');
			await assert.rejects(pending, /Runtime restarted after a credential change\./);
			await proc.whenExited();
			assert.strictEqual(proc.isRunning, false);
		});
	});

	test('detects supported macOS executable architectures', () => {
		const x64 = Buffer.alloc(8);
		x64.writeUInt32LE(0xfeedfacf, 0);
		x64.writeUInt32LE(0x01000007, 4);
		const arm64 = Buffer.alloc(8);
		arm64.writeUInt32LE(0xfeedfacf, 0);
		arm64.writeUInt32LE(0x0100000c, 4);

		assert.deepStrictEqual({
			x64: detectCliTsExecutableArchitecture(x64, 'darwin'),
			arm64: detectCliTsExecutableArchitecture(arm64, 'darwin'),
		}, { x64: 'x64', arm64: 'arm64' });
	});

	test('detects supported Linux executable architectures', () => {
		const x64 = Buffer.alloc(20);
		x64.write('\x7fELF', 0, 'binary');
		x64[5] = 1;
		x64.writeUInt16LE(0x3e, 18);
		const arm64 = Buffer.alloc(20);
		arm64.write('\x7fELF', 0, 'binary');
		arm64[5] = 1;
		arm64.writeUInt16LE(0xb7, 18);

		assert.deepStrictEqual({
			x64: detectCliTsExecutableArchitecture(x64, 'linux'),
			arm64: detectCliTsExecutableArchitecture(arm64, 'linux'),
		}, { x64: 'x64', arm64: 'arm64' });
	});

	test('detects supported Windows executable architectures', () => {
		const executable = (machine: number): Buffer => {
			const header = Buffer.alloc(128);
			header.write('MZ');
			header.writeUInt32LE(64, 0x3c);
			header.write('PE\0\0', 64, 'binary');
			header.writeUInt16LE(machine, 68);
			return header;
		};

		assert.deepStrictEqual({
			x64: detectCliTsExecutableArchitecture(executable(0x8664), 'win32'),
			arm64: detectCliTsExecutableArchitecture(executable(0xaa64), 'win32'),
		}, { x64: 'x64', arm64: 'arm64' });
	});

	test('leaves scripts and unknown executable formats to the normal spawn path', () => {
		assert.strictEqual(detectCliTsExecutableArchitecture(Buffer.from('#!/bin/sh\n'), 'darwin'), undefined);
	});

	test('detects a rebuilt cli executable at the same path', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ts-fingerprint-'));
		const executable = path.join(directory, 'backboard-cli-ts');
		try {
			fs.writeFileSync(executable, 'old');
			const before = cliTsInvocationFingerprint({ command: executable, args: [] });
			fs.writeFileSync(executable, 'new-build');
			const after = cliTsInvocationFingerprint({ command: executable, args: [] });
			assert.notStrictEqual(after, before);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
