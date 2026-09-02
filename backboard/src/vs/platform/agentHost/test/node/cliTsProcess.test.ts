/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cliTsInvocationFingerprint, detectCliTsExecutableArchitecture } from '../../node/cliTs/cliTsProcess.js';

suite('cli-ts process', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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
