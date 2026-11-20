// End to end check of live updates across the pieces that must agree on formats:
// publish.mjs (publisher), events-server.mjs (push + static hosting), the
// extension's staging code and the boot loader / agent host selection.
//
// Needs the compiled outputs of the dev build (./scripts/dev.sh watch in backboard/):
//   backboard/extensions/backboard/out/liveUpdatesCore.js
//   backboard/out/vs/platform/backboardLiveUpdate/node/*.js
// Run: node --test scripts/live-updates/test/live-updates.e2e.test.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'live-updates', 'publish.mjs');
const EVENTS_SERVER = path.join(REPO_ROOT, 'scripts', 'live-updates', 'events-server.mjs');
const core = createRequire(import.meta.url)(path.join(REPO_ROOT, 'backboard', 'extensions', 'backboard', 'out', 'liveUpdatesCore.js'));
const boot = await import(pathToFileURL(path.join(REPO_ROOT, 'backboard', 'out', 'vs', 'platform', 'backboardLiveUpdate', 'node', 'liveUpdateBoot.js')).href);
const liveAgent = await import(pathToFileURL(path.join(REPO_ROOT, 'backboard', 'out', 'vs', 'platform', 'backboardLiveUpdate', 'node', 'liveAgent.js')).href);
const hasBun = spawnSync('bun', ['--version']).status === 0;

const ELECTRON = '42.2.0';
const BASE_VERSION = '9.9.9';
const BASE_COMMIT = 'af5489c6cb81d23ed6675756a9dadbe370434678';
const CLEAN_TREE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);

let work;
let keyDir;
let publicKey;
let outDir;
let server;
let port;

function write(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function publishCli(...args) {
	const result = spawnSync(process.execPath, [PUBLISH, ...args, '--out', outDir, '--key', path.join(keyDir, 'ed25519-private.pem'), '--platform', process.platform, '--arch', process.arch], { encoding: 'utf8' });
	assert.equal(result.status, 0, `publish.mjs ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

/** A packaged app root, laid out like Contents/Resources/app. */
function makeApp(root, { main, extension, native, commit = BASE_COMMIT }) {
	const backboardBuildInfo = { version: BASE_VERSION, sourceCommit: commit, sourceDirtySha256: CLEAN_TREE };
	write(path.join(root, 'product.json'), JSON.stringify({ nameShort: 'Test', backboardVersion: BASE_VERSION, backboardUpdateChannel: 'stable', backboardBuildInfo, backboardLiveUpdate: { publicKeys: [publicKey] } }));
	write(path.join(root, 'package.json'), JSON.stringify({ name: 'test', devDependencies: { electron: ELECTRON } }));
	write(path.join(root, 'backboard-build-info.json'), JSON.stringify({ version: BASE_VERSION }));
	write(path.join(root, 'out', 'main.js'), main);
	write(path.join(root, 'out', 'vs', 'shared.js'), 'export const shared = 1;\n');
	write(path.join(root, 'extensions', 'tool', 'package.json'), '{"name":"tool"}');
	write(path.join(root, 'extensions', 'tool', 'dist', 'extension.js'), extension);
	write(path.join(root, 'extensions', 'tool', 'bin', 'helper'), native);
	write(path.join(root, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
	write(path.join(root, 'bin', 'code'), '#!/bin/sh\n');
	return root;
}

function context(liveUpdatesDir, baseAppRoot) {
	return {
		liveUpdatesDir,
		baseAppRoot,
		userAgent: 'live-update-e2e',
		log: () => undefined,
		publicKeys: [publicKey],
		channel: 'stable',
		appVersion: BASE_VERSION,
		appBuild: BASE_COMMIT,
		electronVersion: ELECTRON,
		machineId: 'machine',
	};
}

async function fetchEnvelope() {
	const response = await fetch(`http://127.0.0.1:${port}/stable/${process.platform}-${process.arch}/manifest.json`);
	return response.json();
}

before(async () => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'live-update-e2e-'));
	keyDir = path.join(work, 'keys');
	outDir = path.join(work, 'published');
	fs.mkdirSync(outDir);
	const keygen = spawnSync(process.execPath, [PUBLISH, 'keygen', '--dir', keyDir], { encoding: 'utf8' });
	assert.equal(keygen.status, 0, keygen.stderr);
	publicKey = fs.readFileSync(path.join(keyDir, 'public-key.txt'), 'utf8').trim();
	port = 20000 + Math.floor(Math.random() * 20000);
	server = spawn(process.execPath, [EVENTS_SERVER, '--port', String(port), '--static', outDir, '--watch', outDir], { stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise((resolve, reject) => {
		server.stdout.on('data', chunk => String(chunk).includes('live update events on') && resolve());
		server.once('exit', code => reject(new Error(`events server exited with ${code}`)));
	});
});

after(() => {
	server?.kill();
	fs.rmSync(work, { recursive: true, force: true });
});

test('a published overlay stages from the installed app plus changed files, boots, and rolls back', async () => {
	const base = makeApp(path.join(work, 'base'), { main: 'console.log("base");\n', extension: 'base extension\n', native: Buffer.concat([MACHO, Buffer.from('signed')]) });
	// An unsigned rebuild: its native bytes differ, which must not matter.
	const next = makeApp(path.join(work, 'next'), { main: 'console.log("live");\n', extension: 'live extension\n', native: Buffer.concat([MACHO, Buffer.from('unsigned')]) });
	publishCli('publish', '--channel', 'stable', '--base-app', base, '--new-app', next, ...(hasBun ? ['--agent'] : []));

	const liveUpdatesDir = path.join(work, 'LiveUpdates');
	const manifestUrl = `http://127.0.0.1:${port}/stable/${process.platform}-${process.arch}/manifest.json`;
	const result = await core.applyLiveManifest(context(liveUpdatesDir, base), manifestUrl, await fetchEnvelope());
	assert.deepEqual(result.errors, []);

	const overlay = path.join(liveUpdatesDir, 'app', result.desiredAppId);
	const selection = boot.selectLiveAppRoot({ liveUpdatesDir, product: JSON.parse(fs.readFileSync(path.join(base, 'product.json'), 'utf8')), electronVersion: ELECTRON, isDev: false });
	assert.deepEqual({
		bootRoot: selection.root,
		main: fs.readFileSync(path.join(overlay, 'out', 'main.js'), 'utf8'),
		unchanged: fs.readFileSync(path.join(overlay, 'out', 'vs', 'shared.js'), 'utf8'),
		extension: fs.readFileSync(path.join(overlay, 'extensions', 'tool', 'dist', 'extension.js'), 'utf8'),
		native: fs.realpathSync(path.join(overlay, 'extensions', 'tool', 'bin', 'helper')),
		nodeModules: fs.realpathSync(path.join(overlay, 'node_modules')),
		product: fs.readFileSync(path.join(overlay, 'product.json'), 'utf8') === fs.readFileSync(path.join(base, 'product.json'), 'utf8'),
	}, {
		bootRoot: overlay,
		main: 'console.log("live");\n',
		unchanged: 'export const shared = 1;\n',
		extension: 'live extension\n',
		native: fs.realpathSync(path.join(base, 'extensions', 'tool', 'bin', 'helper')),
		nodeModules: fs.realpathSync(path.join(base, 'node_modules')),
		product: true,
	});

	if (hasBun) {
		const agent = liveAgent.resolveLiveAgent({ backboardVersion: BASE_VERSION, backboardBuildInfo: { sourceCommit: BASE_COMMIT }, backboardLiveUpdate: { publicKeys: [publicKey] } }, liveUpdatesDir);
		assert.equal(agent?.id, result.agentId);
		assert.match(fs.readFileSync(agent.entry, 'utf8').slice(0, 200), /delete process\.env\.BUN_BE_BUN/);
	}

	// Replaying an older manifest is refused.
	const older = await fetchEnvelope();
	publishCli('rollback', '--channel', 'stable', '--component', 'app');
	await core.applyLiveManifest(context(liveUpdatesDir, base), manifestUrl, await fetchEnvelope());
	await assert.rejects(core.applyLiveManifest(context(liveUpdatesDir, base), manifestUrl, older), /was already applied/);
	assert.equal(boot.selectLiveAppRoot({ liveUpdatesDir, product: JSON.parse(fs.readFileSync(path.join(base, 'product.json'), 'utf8')), electronVersion: ELECTRON, isDev: false }).reason, 'no overlay staged');
});

test('a corrupted object or a foreign key never reaches the live folder', async () => {
	const base = makeApp(path.join(work, 'base2'), { main: 'base\n', extension: 'base\n', native: MACHO });
	const next = makeApp(path.join(work, 'next2'), { main: 'corrupt me\n', extension: 'base\n', native: MACHO });
	publishCli('publish', '--channel', 'stable', '--base-app', base, '--new-app', next);
	const objects = path.join(outDir, 'stable', `${process.platform}-${process.arch}`, 'objects');
	const { createHash } = await import('node:crypto');
	const changed = createHash('sha256').update('corrupt me\n').digest('hex');
	const { gzipSync } = await import('node:zlib');
	fs.writeFileSync(path.join(objects, changed.slice(0, 2), `${changed}.gz`), gzipSync('something else\n'));

	const liveUpdatesDir = path.join(work, 'LiveUpdates2');
	const manifestUrl = `http://127.0.0.1:${port}/stable/${process.platform}-${process.arch}/manifest.json`;
	const result = await core.applyLiveManifest(context(liveUpdatesDir, base), manifestUrl, await fetchEnvelope());
	assert.match(result.errors.join('\n'), /does not match its hash/);
	assert.equal(fs.existsSync(path.join(liveUpdatesDir, 'app', 'current.json')), false);

	await assert.rejects(core.applyLiveManifest({ ...context(path.join(work, 'LiveUpdates3'), base), publicKeys: [core.liveUpdateKeyId(publicKey)] }, manifestUrl, await fetchEnvelope()), /not signed by a trusted key/);
});

test('a rebuild of the base version from other source never runs an overlay of the old build', async () => {
	const base = makeApp(path.join(work, 'base4'), { main: 'old\n', extension: 'old\n', native: MACHO });
	const next = makeApp(path.join(work, 'next4'), { main: 'overlay\n', extension: 'old\n', native: MACHO });
	assert.match(publishCli('publish', '--channel', 'stable', '--base-app', base, '--new-app', next), new RegExp(`base build ${BASE_COMMIT}`));
	const liveUpdatesDir = path.join(work, 'LiveUpdates4');
	const manifestUrl = `http://127.0.0.1:${port}/stable/${process.platform}-${process.arch}/manifest.json`;
	const staged = await core.applyLiveManifest(context(liveUpdatesDir, base), manifestUrl, await fetchEnvelope());
	assert.deepEqual(staged.errors, []);

	// The same version packaged again from newer source replaces the installed app.
	const newerCommit = '0123456789abcdef0123456789abcdef01234567';
	const rebuild = makeApp(path.join(work, 'rebuild4'), { main: 'newer\n', extension: 'newer\n', native: MACHO, commit: newerCommit });
	const rebuildProduct = JSON.parse(fs.readFileSync(path.join(rebuild, 'product.json'), 'utf8'));
	const selection = boot.selectLiveAppRoot({ liveUpdatesDir, product: rebuildProduct, electronVersion: ELECTRON, isDev: false });
	const reapplied = await core.applyLiveManifest({ ...context(liveUpdatesDir, rebuild), appBuild: core.liveUpdateBuildId(rebuildProduct.backboardBuildInfo) }, manifestUrl, await fetchEnvelope());
	assert.deepEqual({
		boot: selection.reason,
		desired: reapplied.desiredAppId,
		pointer: fs.existsSync(path.join(liveUpdatesDir, 'app', 'current.json')),
	}, {
		boot: `overlay ${staged.desiredAppId} was made from build ${BASE_COMMIT}, installed app is build ${newerCommit}`,
		desired: undefined,
		pointer: false,
	});
});

test('the events server pushes each new manifest to connected apps', async () => {
	const received = [];
	const source = core.connectLiveUpdateEvents(`http://127.0.0.1:${port}/events?channel=stable&platform=${process.platform}-${process.arch}`, 'live-update-e2e', sequence => received.push(sequence), () => undefined);
	try {
		// The server replays the latest sequence on connect.
		await waitFor(() => received.length >= 1);
		const config = path.join(work, 'config.json');
		write(config, JSON.stringify({ flags: { newComposer: true } }));
		publishCli('publish', '--channel', 'stable', '--config', config);
		const sequence = JSON.parse(Buffer.from((await fetchEnvelope()).payload, 'base64').toString('utf8')).sequence;
		await waitFor(() => received.includes(sequence));
	} finally {
		source.dispose();
	}
});

async function waitFor(condition, timeoutMs = 10_000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}
