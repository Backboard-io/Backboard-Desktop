/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { applyLiveManifest, isAllowedLiveUpdateUrl, isSafeRelativePath, LiveAgentComponent, LiveAppComponent, LiveApplyContext, liveAgentProtocolVersion, LiveUpdateEnvelope, LiveUpdateManifest, liveUpdateBuildId, liveUpdateKeyId, parseLiveFileList, readDesiredApp, recordLiveAppRunning, rolloutBucket, sha256, tryAcquireLiveUpdateLeadership } from '../liveUpdatesCore';

describe('live update builds', () => {
	const commit = 'af5489c6cb81d23ed6675756a9dadbe370434678';
	const otherCommit = '0123456789abcdef0123456789abcdef01234567';
	const cleanTree = sha256(Buffer.alloc(0));

	test('identifies a build by its commit and any uncommitted changes', () => {
		const dirty = 'b'.repeat(64);
		assert.deepEqual([
			liveUpdateBuildId({ sourceCommit: commit, sourceDirtySha256: cleanTree }),
			liveUpdateBuildId({ sourceCommit: commit.toUpperCase() }),
			liveUpdateBuildId({ sourceCommit: commit, sourceDirtySha256: dirty }),
			liveUpdateBuildId({ sourceCommit: 'unknown', sourceDirtySha256: cleanTree }),
			liveUpdateBuildId({ sourceDirtySha256: dirty }),
			liveUpdateBuildId(undefined),
		], [commit, commit, `${commit}+${dirty}`, undefined, undefined, undefined]);
	});

	test('uses only components made from the installed build and drops pointers to the rest', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-builds-'));
		const keys = crypto.generateKeyPairSync('ed25519');
		const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		let sequence = 0;
		const envelopeFor = (components: LiveUpdateManifest['components']): LiveUpdateEnvelope => {
			const payload = Buffer.from(JSON.stringify({ schema: 1, channel: 'stable', platform: process.platform, arch: process.arch, sequence: ++sequence, createdAt: '', components } satisfies LiveUpdateManifest));
			return { payload: payload.toString('base64'), signatures: [{ keyId: liveUpdateKeyId(publicKey), signature: crypto.sign(null, payload, keys.privateKey).toString('base64') }] };
		};
		const files = { url: 'files/x.json.gz', sha256: '0'.repeat(64), count: 1, bytes: 1 };
		const bundle = 'console.log("live");\n';
		const app: LiveAppComponent = { id: 'app-3.1.27-abc', bases: ['3.1.27'], builds: [commit], electron: '42.2.0', files };
		const agent: LiveAgentComponent = { id: 'agent-abc', bases: ['3.1.27'], builds: [commit], protocolVersion: liveAgentProtocolVersion, bunVersion: '1.3.14', entry: 'cli.js', entrySha256: sha256(Buffer.from(bundle)), files };
		// Folders that are already complete are not downloaded again, so no server is needed.
		const stageFolders = () => {
			fs.mkdirSync(path.join(dir, 'app', app.id, 'out'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'app', app.id, 'out', 'main.js'), '');
			fs.writeFileSync(path.join(dir, 'app', app.id, '.complete'), '');
			fs.mkdirSync(path.join(dir, 'agent', agent.id), { recursive: true });
			fs.writeFileSync(path.join(dir, 'agent', agent.id, 'cli.js'), bundle);
			fs.writeFileSync(path.join(dir, 'agent', agent.id, '.complete'), '');
		};
		const log: string[] = [];
		const context = (appBuild: string | undefined): LiveApplyContext => ({
			liveUpdatesDir: dir, baseAppRoot: dir, userAgent: 'test', log: line => log.push(line),
			publicKeys: [publicKey], channel: 'stable', appVersion: '3.1.27', appBuild, electronVersion: '42.2.0', machineId: 'machine',
		});
		const apply = async (appBuild: string | undefined, components: LiveUpdateManifest['components']) => {
			const result = await applyLiveManifest(context(appBuild), 'http://127.0.0.1/manifest.json', envelopeFor(components));
			return {
				app: result.desiredAppId,
				agent: result.agentId,
				pointers: ['app', 'agent'].filter(component => fs.existsSync(path.join(dir, component, 'current.json'))),
				errors: result.errors,
			};
		};
		try {
			stageFolders();
			const sameBuild = await apply(commit, { app, agent });
			const desired = [commit, otherCommit].map(appBuild => readDesiredApp(dir, [publicKey], { appVersion: '3.1.27', appBuild }, '42.2.0')?.id);
			// The same version rebuilt from other source.
			const rebuilt = await apply(otherCommit, { app, agent });
			stageFolders();
			await apply(commit, { app, agent });
			// Published before builds were recorded.
			const legacy = await apply(commit, { app: { ...app, builds: undefined }, agent: { ...agent, builds: undefined } });
			const unknownBuild = await apply(undefined, { app, agent });
			assert.deepEqual({ sameBuild, desired, rebuilt, legacy, unknownBuild }, {
				sameBuild: { app: app.id, agent: agent.id, pointers: ['app', 'agent'], errors: [] },
				desired: [app.id, undefined],
				rebuilt: { app: undefined, agent: undefined, pointers: [], errors: [] },
				legacy: { app: undefined, agent: undefined, pointers: [], errors: [] },
				unknownBuild: { app: undefined, agent: undefined, pointers: [], errors: [] },
			});
			assert.ok(log.includes(`[live] app overlay ${app.id} was made from build ${commit}, installed app is build ${otherCommit}; not using it`), log.join('\n'));
			assert.ok(log.includes(`[live] agent runtime ${agent.id} records no base build; not using it`), log.join('\n'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

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

	test('the running app corrects the boot record a relaunch left behind', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-boot-'));
		const bootPath = path.join(dir, 'app', 'boot.json');
		const read = () => JSON.parse(fs.readFileSync(bootPath, 'utf8'));
		try {
			fs.mkdirSync(path.dirname(bootPath));
			// The process that wrote this only handed over its arguments and exited.
			fs.writeFileSync(bootPath, JSON.stringify({ id: 'app-1', attempts: 1, pid: 111, healthy: false }));
			await recordLiveAppRunning(dir, 'app-1', 222);
			const overlay = read();
			// A second launch recorded an overlay attempt while the installed app runs.
			fs.writeFileSync(bootPath, JSON.stringify({ id: 'app-2', attempts: 1, pid: 333, healthy: false }));
			await recordLiveAppRunning(dir, undefined, 222);
			assert.deepEqual([overlay, read()], [{ id: 'app-1', attempts: 0, pid: 222, healthy: true }, { attempts: 0, pid: 222 }]);
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
