/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { isAllowedLiveUpdateUrl, isSafeRelativePath, parseLiveFileList, rolloutBucket, tryAcquireLiveUpdateLeadership } from '../liveUpdatesCore';

describe('live update staging', () => {
	test('accepts only relative paths that stay inside the component folder', () => {
		const paths = ['out/main.js', 'a/b/c', '../etc/passwd', '/abs', 'out/../x', 'out//x', 'C:/x', 'out\\x', '', 'out/./x'];
		assert.deepEqual(paths.filter(isSafeRelativePath), ['out/main.js', 'a/b/c']);
	});

	test('rejects file lists with unsafe entries', () => {
		const list = (files: object[], links: object[] = []) => gzipSync(JSON.stringify({ schema: 1, files, links }));
		const hash = 'a'.repeat(64);
		assert.equal(parseLiveFileList(list([{ p: 'out/main.js', h: hash, s: 1 }])).files.length, 1);
		assert.throws(() => parseLiveFileList(list([{ p: '../main.js', h: hash, s: 1 }])), /invalid entry/);
		assert.throws(() => parseLiveFileList(list([{ p: 'out/main.js', h: 'short', s: 1 }])), /invalid entry/);
		assert.throws(() => parseLiveFileList(list([], [{ p: 'node_modules', t: '../../..' }])), /invalid link/);
	});

	test('serves plain HTTP only from this machine', () => {
		const urls = ['https://cdn.example.com/m.json', 'http://127.0.0.1:8787/m.json', 'http://localhost/m.json', 'http://cdn.example.com/m.json', 'file:///etc/passwd'];
		assert.deepEqual(urls.filter(url => isAllowedLiveUpdateUrl(new URL(url))), urls.slice(0, 3));
	});

	test('rollout buckets are stable per machine and spread across machines', () => {
		const buckets = Array.from({ length: 2000 }, (_, i) => rolloutBucket(`machine-${i}`, 'app-1'));
		const tenPercent = buckets.filter(bucket => bucket < 10).length;
		assert.equal(rolloutBucket('machine-7', 'app-1'), rolloutBucket('machine-7', 'app-1'));
		assert.ok(tenPercent > 140 && tenPercent < 260, `10% rollout picked ${tenPercent} of 2000`);
	});

	test('windows racing for a stale lock elect exactly one leader', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-leader-race-'));
		try {
			fs.writeFileSync(path.join(dir, 'leader.json'), JSON.stringify({ pid: 999999, at: new Date(0).toISOString() }));
			const core = path.resolve(__dirname, '../liveUpdatesCore.js');
			const script = `const c = require(${JSON.stringify(core)}); setTimeout(() => { console.log(c.tryAcquireLiveUpdateLeadership(${JSON.stringify(dir)})); setTimeout(() => {}, 1000); }, 300);`;
			const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>(resolve => {
				const child = spawn(process.execPath, ['-e', script]);
				let out = '';
				child.stdout.on('data', chunk => out += chunk);
				child.once('exit', () => resolve(out.trim()));
			})));
			assert.equal(results.filter(result => result === 'true').length, 1, results.join(','));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('only one live process leads, and a dead leader is replaced', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-leader-'));
		try {
			const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
			fs.writeFileSync(path.join(dir, 'leader.json'), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }));
			const whileAlive = tryAcquireLiveUpdateLeadership(dir);
			child.kill();
			await new Promise(resolve => child.once('exit', resolve));
			assert.deepEqual([whileAlive, tryAcquireLiveUpdateLeadership(dir), tryAcquireLiveUpdateLeadership(dir)], [false, true, true]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
