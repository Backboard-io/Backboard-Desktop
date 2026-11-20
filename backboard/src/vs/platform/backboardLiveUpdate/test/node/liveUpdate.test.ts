/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILiveAgentComponent, ILiveAppComponent, ILiveUpdateBuildInfo, ILiveUpdateEnvelope, ILiveUpdateManifest, liveUpdateBuildId } from '../../common/liveUpdate.js';
import { resolveLiveAgent } from '../../node/liveAgent.js';
import { selectLiveAppRoot } from '../../node/liveUpdateBoot.js';
import { liveUpdateKeyId, verifyLiveUpdateEnvelope } from '../../node/liveUpdateSignature.js';

interface ITestKey {
	readonly privateKey: KeyObject;
	readonly publicKey: string;
}

function createKey(): ITestKey {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

function signManifest(manifest: ILiveUpdateManifest, key: ITestKey): ILiveUpdateEnvelope {
	const payload = Buffer.from(JSON.stringify(manifest));
	return { payload: payload.toString('base64'), signatures: [{ keyId: liveUpdateKeyId(key.publicKey), signature: sign(null, payload, key.privateKey).toString('base64') }] };
}

const files = { url: 'files/x.json.gz', sha256: '0'.repeat(64), count: 1, bytes: 1 };
const commit = 'af5489c6cb81d23ed6675756a9dadbe370434678';
const cleanTree = createHash('sha256').digest('hex');
const buildInfo: ILiveUpdateBuildInfo = { sourceCommit: commit, sourceDirtySha256: cleanTree };

function manifestWith(components: ILiveUpdateManifest['components']): ILiveUpdateManifest {
	return { schema: 1, channel: 'stable', platform: process.platform, arch: process.arch, sequence: 1, createdAt: '', components };
}

suite('Backboard live updates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let liveUpdatesDir: string;
	let key: ITestKey;

	setup(() => {
		liveUpdatesDir = fs.mkdtempSync(join(os.tmpdir(), 'live-updates-'));
		key = createKey();
	});

	teardown(() => {
		fs.rmSync(liveUpdatesDir, { recursive: true, force: true });
	});

	function stageApp(app: ILiveAppComponent, signer = key): void {
		const root = join(liveUpdatesDir, 'app', app.id);
		fs.mkdirSync(join(root, 'out'), { recursive: true });
		fs.writeFileSync(join(root, 'out', 'main.js'), '');
		fs.writeFileSync(join(root, '.complete'), '');
		fs.writeFileSync(join(liveUpdatesDir, 'app', 'current.json'), JSON.stringify({ schema: 1, id: app.id, manifest: signManifest(manifestWith({ app }), signer), stagedAt: '' }));
	}

	function select(overrides: { keys?: string[]; version?: string; build?: ILiveUpdateBuildInfo; electron?: string; isDev?: boolean } = {}) {
		return selectLiveAppRoot({
			liveUpdatesDir,
			product: { backboardVersion: overrides.version ?? '3.1.27', backboardBuildInfo: overrides.build ?? buildInfo, backboardLiveUpdate: { publicKeys: overrides.keys ?? [key.publicKey] } },
			electronVersion: overrides.electron ?? '42.2.0',
			isDev: overrides.isDev ?? false,
		});
	}

	const app: ILiveAppComponent = { id: 'app-3.1.27-abc', bases: ['3.1.27'], builds: [commit], electron: '42.2.0', files };

	test('identifies a build by its commit and any uncommitted changes', () => {
		const dirty = 'b'.repeat(64);
		assert.deepStrictEqual([
			liveUpdateBuildId(buildInfo),
			liveUpdateBuildId({ sourceCommit: commit.toUpperCase() }),
			liveUpdateBuildId({ sourceCommit: commit, sourceDirtySha256: dirty }),
			liveUpdateBuildId({ sourceCommit: 'unknown', sourceDirtySha256: cleanTree }),
			liveUpdateBuildId({ sourceDirtySha256: dirty }),
			liveUpdateBuildId(undefined),
		], [commit, commit, `${commit}+${dirty}`, undefined, undefined, undefined]);
	});

	test('verifies envelopes only against trusted keys', () => {
		const envelope = signManifest(manifestWith({ app }), key);
		const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(manifestWith({ app: { ...app, id: 'app-evil' } }))).toString('base64') };
		assert.deepStrictEqual([
			verifyLiveUpdateEnvelope(envelope, [key.publicKey])?.components.app?.id,
			verifyLiveUpdateEnvelope(envelope, [createKey().publicKey]),
			verifyLiveUpdateEnvelope(tampered, [key.publicKey]),
			verifyLiveUpdateEnvelope(envelope, []),
		], ['app-3.1.27-abc', undefined, undefined, undefined]);
	});

	test('starts a staged overlay and stops trying after repeated failed starts', () => {
		stageApp(app);
		const root = join(liveUpdatesDir, 'app', app.id);
		const selections = [select(), select(), select(), select(), select()].map(selection => selection.root ?? selection.reason);
		assert.deepStrictEqual(selections, [
			root,
			root,
			root,
			`overlay ${app.id} did not finish starting 3 times`,
			`overlay ${app.id} failed to start before`,
		]);
	});

	test('a second launch runs what the running instance runs and counts no attempt', () => {
		stageApp(app);
		const bootPath = join(liveUpdatesDir, 'app', 'boot.json');
		// The test runner's parent process stands in for a running app instance.
		const running = { id: app.id, attempts: 2, pid: process.ppid, healthy: true };
		fs.writeFileSync(bootPath, JSON.stringify(running));
		const selection = select();
		assert.deepStrictEqual([selection.root, JSON.parse(fs.readFileSync(bootPath, 'utf8'))], [join(liveUpdatesDir, 'app', app.id), running]);
	});

	test('runs the installed app when the overlay is untrusted or does not fit', () => {
		stageApp(app);
		const reasons = [
			select({ isDev: true }),
			select({ keys: [] }),
			select({ keys: [createKey().publicKey] }),
			select({ version: '3.1.26' }),
			select({ electron: '43.0.0' }),
		].map(selection => selection.root ?? selection.reason);
		fs.rmSync(join(liveUpdatesDir, 'app', app.id, '.complete'));
		const incomplete = select();
		reasons.push(incomplete.root ?? incomplete.reason);
		assert.deepStrictEqual(reasons, [
			'development build',
			'live updates are not configured',
			`overlay ${app.id} is not in a manifest signed by a trusted key`,
			`overlay ${app.id} targets 3.1.27, installed app is 3.1.26`,
			`overlay ${app.id} needs Electron 42.2.0, installed app has 43.0.0`,
			`overlay ${app.id} is incomplete`,
		]);
	});

	test('runs the installed app instead of an overlay made from another build of its version', () => {
		const otherCommit = '0123456789abcdef0123456789abcdef01234567';
		const dirty = 'c'.repeat(64);
		stageApp(app);
		const reasons = [
			select({ build: { sourceCommit: otherCommit, sourceDirtySha256: cleanTree } }),
			select({ build: { sourceCommit: commit, sourceDirtySha256: dirty } }),
			select({ build: { sourceCommit: 'unknown' } }),
		].map(selection => selection.root ?? selection.reason);
		// Published before builds were recorded: nothing shows it is not older code.
		stageApp({ ...app, id: 'app-3.1.27-legacy', builds: undefined });
		const legacy = select();
		reasons.push(legacy.root ?? legacy.reason);
		// Several builds may be listed; any one of them fits.
		stageApp({ ...app, id: 'app-3.1.27-both', builds: [otherCommit, commit] });
		const listed = select({ build: { sourceCommit: otherCommit } });
		reasons.push(listed.root ?? listed.reason);
		assert.deepStrictEqual(reasons, [
			`overlay ${app.id} was made from build ${commit}, installed app is build ${otherCommit}`,
			`overlay ${app.id} was made from build ${commit}, installed app is build ${commit}+${dirty}`,
			`overlay ${app.id} needs a known build, installed app records none`,
			'overlay app-3.1.27-legacy records no base build',
			join(liveUpdatesDir, 'app', 'app-3.1.27-both'),
		]);
	});

	test('picks a staged agent bundle only when it is made from this build, intact and speaks the host protocol', () => {
		const bundle = 'console.log("live");\n';
		const stageAgent = (agent: ILiveAgentComponent) => {
			const entry = join(liveUpdatesDir, 'agent', agent.id, agent.entry);
			fs.mkdirSync(dirname(entry), { recursive: true });
			fs.writeFileSync(entry, bundle);
			fs.writeFileSync(join(liveUpdatesDir, 'agent', 'current.json'), JSON.stringify({ schema: 1, id: agent.id, entry, manifest: signManifest(manifestWith({ agent }), key), stagedAt: '' }));
			return entry;
		};
		const product = { backboardVersion: '3.1.27', backboardBuildInfo: buildInfo, backboardLiveUpdate: { publicKeys: [key.publicKey] } };
		const agent: ILiveAgentComponent = { id: 'agent-abc', bases: ['3.1.27'], builds: [commit], protocolVersion: 1, bunVersion: '1.3.14', entry: 'cli.js', entrySha256: createHash('sha256').update(bundle).digest('hex'), files };
		const entry = stageAgent(agent);
		const valid = resolveLiveAgent(product, liveUpdatesDir)?.entry;
		const otherBase = resolveLiveAgent({ ...product, backboardVersion: '3.1.26' }, liveUpdatesDir);
		const otherBuild = resolveLiveAgent({ ...product, backboardBuildInfo: { sourceCommit: '0123456789abcdef0123456789abcdef01234567' } }, liveUpdatesDir);
		stageAgent({ ...agent, builds: undefined });
		const unrecordedBuild = resolveLiveAgent(product, liveUpdatesDir);
		stageAgent(agent);
		fs.writeFileSync(entry, 'console.log("tampered with");\n');
		const tampered = resolveLiveAgent(product, liveUpdatesDir);
		stageAgent({ ...agent, id: 'agent-def', protocolVersion: 2 });
		const newerProtocol = resolveLiveAgent(product, liveUpdatesDir);
		assert.deepStrictEqual([valid, otherBase, otherBuild, unrecordedBuild, tampered, newerProtocol], [entry, undefined, undefined, undefined, undefined, undefined]);
	});
});
