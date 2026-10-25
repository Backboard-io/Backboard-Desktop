#!/usr/bin/env node
// Builds, signs and lays out live updates for Backboard Studio.
//
// A live update ships JavaScript to installed apps without a new signed app:
//   app    the application JavaScript (out/ and extensions/) from an unsigned
//          build of the same release, applied with a quick restart
//   agent  the cli-ts runtime as a JavaScript bundle, picked up at the next turn
//   config server flags and announcements, applied immediately
//
// Output (upload with scripts/upload_live_update.sh, objects before manifest):
//   <out>/<channel>/<platform>-<arch>/manifest.json         signed envelope
//   <out>/<channel>/<platform>-<arch>/manifests/<seq>.json  every published manifest
//   <out>/<channel>/<platform>-<arch>/files/<sha>.json.gz   file lists
//   <out>/<channel>/<platform>-<arch>/objects/<aa>/<sha>.gz file contents
//
// The client side lives in backboard/extensions/backboard/src/liveUpdatesCore.ts
// (download and staging) and backboard/src/vs/platform/backboardLiveUpdate
// (boot loader, agent host). The formats here must match those.
//
// Commands:
//   keygen   [--dir DIR]
//   publish  --channel C --base-app APP [--new-app APP] [--agent] [options]
//   rollback --channel C --component app|agent [--platform P --arch A]
//   revoke   --channel C --id ID [--platform P --arch A]
//   verify   --manifest FILE [--public-key B64]
//   notify   --channel C [--platform P --arch A] --url URL   (token: BACKBOARD_LIVE_EVENTS_TOKEN)

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VSCODE_ROOT = path.join(REPO_ROOT, 'backboard');
const CLI_TS_ROOT = path.join(VSCODE_ROOT, 'cli-ts');
const DEFAULT_KEY_DIR = path.join(os.homedir(), '.backboard', 'live-update-signing');
const PRIVATE_KEY_FILE = 'ed25519-private.pem';
const PUBLIC_KEY_FILE = 'public-key.txt';
const DEFAULT_OUT = path.join(REPO_ROOT, 'vscode-live-updates');
/** Must equal LIVE_AGENT_PROTOCOL_VERSION in the host (src/vs/platform/backboardLiveUpdate/common/liveUpdate.ts). */
const HOST_AGENT_PROTOCOL_VERSION = 1;
/** Source paths whose changes alter native code or packaging; they need a full release. */
const FULL_RELEASE_PATHS = ['backboard/cua-driver', 'backboard/.npmrc', 'backboard/package-lock.json', 'backboard/remote/package-lock.json', 'scripts/macos-release'];
const NATIVE_EXTENSIONS = new Set(['.node', '.dylib', '.so', '.dll', '.exe']);

// #region Arguments

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const options = { _: [] };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith('--')) {
			options._.push(arg);
			continue;
		}
		const key = arg.slice(2);
		const next = rest[i + 1];
		if (next === undefined || next.startsWith('--')) {
			options[key] = true;
		} else {
			options[key] = next;
			i++;
		}
	}
	return { command, options };
}

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

function required(options, key) {
	const value = options[key];
	if (typeof value !== 'string' || !value) {
		fail(`--${key} is required`);
	}
	return value;
}

function hostPlatform(options) {
	const platform = typeof options.platform === 'string' ? options.platform : process.platform;
	const arch = typeof options.arch === 'string' ? options.arch : process.arch;
	if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
		fail(`unsupported platform ${platform}-${arch}`);
	}
	return { platform, arch };
}

// #endregion

// #region Keys and signatures

function keyId(publicKeyBase64) {
	return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16);
}

function loadSigningKey(options) {
	const file = typeof options.key === 'string' ? options.key : process.env.BACKBOARD_LIVE_UPDATE_SIGNING_KEY || path.join(DEFAULT_KEY_DIR, PRIVATE_KEY_FILE);
	if (!fs.existsSync(file)) {
		fail(`no signing key at ${file}. Create one with: node scripts/live-updates/publish.mjs keygen`);
	}
	const privateKey = createPrivateKey(fs.readFileSync(file));
	const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
	return { privateKey, publicKey };
}

function signEnvelope(manifest, key) {
	const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
	return {
		payload: payload.toString('base64'),
		signatures: [{ keyId: keyId(key.publicKey), signature: sign(null, payload, key.privateKey).toString('base64') }],
	};
}

function openEnvelope(envelope, publicKeys) {
	const payload = Buffer.from(envelope.payload, 'base64');
	const trusted = new Map(publicKeys.map(key => [keyId(key), key]));
	const ok = envelope.signatures?.some(entry => {
		const key = trusted.get(entry.keyId);
		return key && verify(null, payload, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(entry.signature, 'base64'));
	});
	return ok ? JSON.parse(payload.toString('utf8')) : undefined;
}

function keygen(options) {
	const dir = typeof options.dir === 'string' ? options.dir : DEFAULT_KEY_DIR;
	const privatePath = path.join(dir, PRIVATE_KEY_FILE);
	if (fs.existsSync(privatePath)) {
		fail(`${privatePath} already exists. Rotating keys means shipping the new public key in a full release first.`);
	}
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
	const publicBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
	fs.writeFileSync(path.join(dir, PUBLIC_KEY_FILE), `${publicBase64}\n`);
	console.log(`Private key: ${privatePath} (keep it offline and out of the repo)`);
	console.log(`Public key:  ${publicBase64}`);
	console.log(`Key id:      ${keyId(publicBase64)}`);
	console.log('Release builds stamp this public key into product.json, so only builds made after this can take live updates.');
}

// #endregion

// #region Files

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/** The folder that holds product.json and out/: an .app, an install folder, or that folder itself. */
function resolveAppRoot(input) {
	const candidates = [
		input,
		path.join(input, 'Contents', 'Resources', 'app'),
		path.join(input, 'resources', 'app'),
	];
	const root = candidates.find(candidate => fs.existsSync(path.join(candidate, 'product.json')) && fs.existsSync(path.join(candidate, 'out')));
	if (!root) {
		fail(`${input} is not a Backboard Studio app (no product.json and out/ under it)`);
	}
	return root;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function electronVersion(appRoot) {
	const plist = path.resolve(appRoot, '..', '..', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist');
	if (fs.existsSync(plist)) {
		const match = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(plist, 'utf8'));
		if (match) {
			return match[1];
		}
	}
	const version = readJson(path.join(appRoot, 'package.json')).devDependencies?.electron;
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
		fail(`cannot tell the Electron version of ${appRoot}`);
	}
	return version;
}

function isNative(file, bytes) {
	const normalized = file.split(path.sep).join('/');
	if (NATIVE_EXTENSIONS.has(path.extname(file).toLowerCase()) || /(^|\/)_CodeSignature\/|\.app\/|\.framework\//.test(normalized)) {
		return true;
	}
	if (bytes.length < 4) {
		return false;
	}
	const magic = bytes.readUInt32BE(0);
	return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0x7f454c46].includes(magic) || (bytes[0] === 0x4d && bytes[1] === 0x5a);
}

function walkFiles(root, relative = '') {
	const result = [];
	const dir = path.join(root, relative);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === '.DS_Store') {
			continue;
		}
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) {
			fail(`${path.join(root, rel)} is a symlink; live updates only carry regular files`);
		}
		if (entry.isDirectory()) {
			result.push(...walkFiles(root, rel));
		} else if (entry.isFile()) {
			result.push(rel);
		}
	}
	return result;
}

/** `name@version` for every package in a node_modules tree, to prove two apps share it. */
function nodeModulesInventory(appRoot) {
	const inventory = new Map();
	const visit = dir => {
		if (!fs.existsSync(dir)) {
			return;
		}
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.name.startsWith('@')) {
				visit(full);
				continue;
			}
			const pkg = path.join(full, 'package.json');
			if (fs.existsSync(pkg)) {
				inventory.set(path.relative(appRoot, full).split(path.sep).join('/'), readJson(pkg).version ?? '?');
			}
			visit(path.join(full, 'node_modules'));
		}
	};
	visit(path.join(appRoot, 'node_modules'));
	return inventory;
}

class ObjectStore {
	constructor(channelDir) {
		this.channelDir = channelDir;
		this.added = 0;
		this.addedBytes = 0;
	}

	put(bytes) {
		const hash = sha256(bytes);
		const file = path.join(this.channelDir, 'objects', hash.slice(0, 2), `${hash}.gz`);
		if (!fs.existsSync(file)) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const gz = gzipSync(bytes, { level: 9 });
			fs.writeFileSync(file, gz);
			this.added++;
			this.addedBytes += gz.length;
		}
		return hash;
	}

	putFileList(list) {
		const gz = gzipSync(Buffer.from(JSON.stringify(list)), { level: 9 });
		const hash = sha256(gz);
		const file = path.join(this.channelDir, 'files', `${hash}.json.gz`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, gz);
		const bytes = list.files.reduce((sum, entry) => sum + entry.s, 0);
		return { url: `files/${hash}.json.gz`, sha256: hash, count: list.files.length, bytes };
	}
}

// #endregion

// #region Components

function checkSourceForFullReleaseChanges(baseRoot, force) {
	const info = fs.existsSync(path.join(baseRoot, 'backboard-build-info.json')) ? readJson(path.join(baseRoot, 'backboard-build-info.json')) : undefined;
	const commit = info?.sourceCommit;
	if (!commit || commit === 'unknown') {
		console.warn('warning: the base app does not record its source commit; skipping the native-change check');
		return;
	}
	const result = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--name-only', commit, 'HEAD', '--', ...FULL_RELEASE_PATHS], { encoding: 'utf8' });
	if (result.status !== 0) {
		console.warn(`warning: cannot diff against the base commit ${commit} (${result.stderr.trim()}); skipping the native-change check`);
		return;
	}
	const changed = result.stdout.split('\n').filter(Boolean);
	if (changed.length) {
		const message = `these changed since the base release (${commit.slice(0, 10)}) and need a full release:\n  ${changed.join('\n  ')}`;
		if (!force) {
			fail(`${message}\nPass --force if they do not affect the shipped native code.`);
		}
		console.warn(`warning: ${message}`);
	}
}

function buildAppComponent(options, store, baseRoot, bases) {
	const newRoot = resolveAppRoot(required(options, 'new-app'));
	const force = !!options.force;
	const electron = electronVersion(baseRoot);
	if (electronVersion(newRoot) !== electron) {
		fail(`Electron differs (base ${electron}, new ${electronVersion(newRoot)}); that needs a full release`);
	}
	const baseModules = nodeModulesInventory(baseRoot);
	const newModules = nodeModulesInventory(newRoot);
	const moduleDiffs = [...new Set([...baseModules.keys(), ...newModules.keys()])]
		.filter(name => baseModules.get(name) !== newModules.get(name))
		.map(name => `${name}: ${baseModules.get(name) ?? '(none)'} -> ${newModules.get(name) ?? '(none)'}`);
	if (moduleDiffs.length) {
		const message = `node_modules differ from the base app, and the overlay shares the installed ones:\n  ${moduleDiffs.slice(0, 30).join('\n  ')}`;
		if (!force) {
			fail(`${message}\nThat needs a full release.`);
		}
		console.warn(`warning: ${message}`);
	}
	checkSourceForFullReleaseChanges(baseRoot, force);

	const files = [];
	const links = [];
	let changedFiles = 0;
	let changedBytes = 0;
	const fromBase = rel => {
		const basePath = path.join(baseRoot, rel);
		if (!fs.existsSync(basePath)) {
			fail(`${rel} must come from the installed app, but the base app has none; that needs a full release`);
		}
		const bytes = fs.readFileSync(basePath);
		return { p: rel, h: sha256(bytes), s: bytes.length, b: 1 };
	};

	for (const entry of fs.readdirSync(newRoot, { withFileTypes: true })) {
		if (entry.name === '.DS_Store' || entry.name === 'out' || entry.name === 'extensions') {
			continue;
		}
		if (entry.isDirectory()) {
			if (!fs.existsSync(path.join(baseRoot, entry.name))) {
				fail(`${entry.name}/ is new in this build; that needs a full release`);
			}
			links.push({ p: entry.name, t: entry.name });
		} else {
			// product.json (the keys that verify updates) and the other root
			// files always stay the installed app's own.
			files.push(fromBase(entry.name));
		}
	}
	for (const top of ['out', 'extensions']) {
		for (const rel of walkFiles(newRoot, top)) {
			const full = path.join(newRoot, rel);
			const bytes = fs.readFileSync(full);
			if (isNative(rel, bytes)) {
				files.push(fromBase(rel));
				continue;
			}
			const hash = store.put(bytes);
			const entry = { p: rel, h: hash, s: bytes.length };
			if (fs.statSync(full).mode & 0o111) {
				entry.x = 1;
			}
			files.push(entry);
			const basePath = path.join(baseRoot, rel);
			if (!fs.existsSync(basePath) || sha256(fs.readFileSync(basePath)) !== hash) {
				changedFiles++;
				changedBytes += bytes.length;
			}
		}
	}
	const list = { schema: 1, files, links };
	const fileSet = store.putFileList(list);
	const id = `app-${bases[0]}-${fileSet.sha256.slice(0, 12)}`.toLowerCase();
	console.log(`app ${id}: ${files.length} files, ${changedFiles} differ from ${bases[0]} (${Math.round(changedBytes / 1024)} KB)`);
	if (changedFiles === 0) {
		console.warn('warning: the new build matches the base app; the overlay changes nothing');
	}
	return {
		id,
		bases,
		electron,
		files: fileSet,
		...rolloutAndNotes(options, id),
		...(options.urgent ? { urgent: true } : {}),
	};
}

function packagedCliPath(appRoot) {
	const name = process.platform === 'win32' ? 'backboard-cli-ts.exe' : 'backboard-cli-ts';
	return path.join(appRoot, 'extensions', 'backboard', 'bin', name);
}

function buildAgentComponent(options, store, baseRoot, bases, platform) {
	const protocolSource = fs.readFileSync(path.join(CLI_TS_ROOT, 'src', 'config', 'runtimeIdentity.ts'), 'utf8');
	const protocolVersion = Number(/PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocolSource)?.[1]);
	if (protocolVersion !== HOST_AGENT_PROTOCOL_VERSION) {
		fail(`cli-ts speaks protocol ${protocolVersion}, installed hosts speak ${HOST_AGENT_PROTOCOL_VERSION}; that needs a full release`);
	}
	const bunVersion = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
	const runtime = packagedCliPath(baseRoot);
	const canRunBase = platform === process.platform && fs.existsSync(runtime);
	if (canRunBase) {
		const baseBun = execFileSync(runtime, ['--version'], { encoding: 'utf8', env: { ...process.env, BUN_BE_BUN: '1' } }).trim();
		if (baseBun !== bunVersion && !options.force) {
			fail(`local Bun is ${bunVersion}, the installed runtime embeds Bun ${baseBun}. Build with Bun ${baseBun} (or pass --force).`);
		}
	} else {
		console.warn(`warning: cannot run the base app's cli-ts here; not checking its Bun version (${bunVersion} locally)`);
	}

	const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-live-agent-'));
	try {
		const build = spawnSync('bun', ['run', 'scripts/build-live.ts'], { cwd: CLI_TS_ROOT, stdio: 'inherit', env: { ...process.env, BACKBOARD_CLI_LIVE_OUTDIR: outdir } });
		if (build.status !== 0) {
			fail('cli-ts bundle build failed');
		}
		const entry = 'cli.js';
		if (!fs.existsSync(path.join(outdir, entry))) {
			fail(`the cli-ts build did not produce ${entry}`);
		}
		if (canRunBase) {
			// Prove the bundle starts on the runtime users actually have.
			const smoke = spawnSync(runtime, ['run', path.join(outdir, entry), '--version'], { encoding: 'utf8', env: { ...process.env, BUN_BE_BUN: '1' }, timeout: 60_000 });
			if (smoke.status !== 0) {
				fail(`the bundle does not start on the installed runtime:\n${smoke.stderr || smoke.stdout}`);
			}
			console.log(`agent smoke test: ${smoke.stdout.trim().split('\n').pop()}`);
		}
		const files = walkFiles(outdir).map(rel => {
			const bytes = fs.readFileSync(path.join(outdir, rel));
			if (isNative(rel, bytes)) {
				fail(`the cli-ts bundle contains native code (${rel}); that needs a full release`);
			}
			return { p: rel, h: store.put(bytes), s: bytes.length };
		});
		const entrySha256 = files.find(file => file.p === entry).h;
		const fileSet = store.putFileList({ schema: 1, files });
		const id = `agent-${fileSet.sha256.slice(0, 12)}`;
		console.log(`agent ${id}: ${files.length} files, ${Math.round(fileSet.bytes / 1024)} KB, Bun ${bunVersion}`);
		return { id, bases, protocolVersion, bunVersion, entry, entrySha256, files: fileSet, ...rolloutAndNotes(options, id) };
	} finally {
		fs.rmSync(outdir, { recursive: true, force: true });
	}
}

function rolloutAndNotes(options, id) {
	const percent = options.rollout === undefined ? 100 : Number(options.rollout);
	if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
		fail('--rollout takes a percentage from 0 to 100');
	}
	return {
		...(percent < 100 ? { rollout: { percent, salt: id } } : {}),
		...(typeof options.notes === 'string' ? { notes: options.notes } : {}),
	};
}

// #endregion

// #region Manifest

function channelDirectory(options, platform, arch) {
	const channel = required(options, 'channel');
	if (!['stable', 'sandbox'].includes(channel)) {
		fail(`unsupported channel ${channel}`);
	}
	const out = typeof options.out === 'string' ? path.resolve(options.out) : DEFAULT_OUT;
	return { channel, dir: path.join(out, channel, `${platform}-${arch}`) };
}

function readPreviousManifest(dir, key, options) {
	const file = path.join(dir, 'manifest.json');
	if (!fs.existsSync(file)) {
		return undefined;
	}
	const manifest = openEnvelope(readJson(file), [key.publicKey]);
	if (!manifest && !options.reset) {
		fail(`${file} is not signed by this key. Pass --reset to start the channel over (clients keep refusing lower sequence numbers).`);
	}
	return manifest;
}

function writeManifest(dir, manifest, key) {
	const envelope = signEnvelope(manifest, key);
	fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'manifests', `${manifest.sequence}.json`), `${JSON.stringify(envelope)}\n`);
	fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(envelope)}\n`);
	console.log(`\nmanifest ${manifest.sequence} for ${manifest.channel} ${manifest.platform}-${manifest.arch}:`);
	for (const [name, component] of Object.entries(manifest.components)) {
		console.log(`  ${name.padEnd(6)} ${component.id}${component.rollout ? ` (${component.rollout.percent}%)` : ''}`);
	}
	if (!Object.keys(manifest.components).length) {
		console.log('  (no components: clients run what the installed app ships)');
	}
	console.log(`\nwritten to ${dir}\nupload: ./scripts/upload_live_update.sh --channel ${manifest.channel} --platform ${manifest.platform}-${manifest.arch}`);
}

function nextManifest(previous, channel, platform, arch) {
	// Seconds since the epoch keep sequences increasing even if this folder is
	// lost and the channel is published from another machine.
	const sequence = Math.max((previous?.sequence ?? 0) + 1, Math.floor(Date.now() / 1000));
	return {
		schema: 1,
		channel,
		platform,
		arch,
		sequence,
		createdAt: new Date().toISOString(),
		components: { ...(previous?.components ?? {}) },
		...(previous?.config ? { config: previous.config } : {}),
		...(previous?.revoked?.length ? { revoked: previous.revoked } : {}),
	};
}

function publish(options) {
	const { platform, arch } = hostPlatform(options);
	const { channel, dir } = channelDirectory(options, platform, arch);
	const key = loadSigningKey(options);
	const previous = readPreviousManifest(dir, key, options);
	const manifest = nextManifest(previous, channel, platform, arch);
	const store = new ObjectStore(dir);
	const wantsApp = typeof options['new-app'] === 'string';
	const wantsAgent = !!options.agent;
	const config = typeof options.config === 'string' ? readJson(options.config) : undefined;
	if (!wantsApp && !wantsAgent && !config) {
		fail('nothing to publish: pass --new-app, --agent and/or --config');
	}
	if (wantsApp || wantsAgent) {
		const baseRoot = resolveAppRoot(required(options, 'base-app'));
		const baseProduct = readJson(path.join(baseRoot, 'product.json'));
		if (baseProduct.backboardUpdateChannel && baseProduct.backboardUpdateChannel !== channel) {
			fail(`the base app is a ${baseProduct.backboardUpdateChannel} build, not ${channel}`);
		}
		if (!baseProduct.backboardLiveUpdate?.publicKeys?.includes(key.publicKey)) {
			console.warn('warning: the base app does not trust this signing key; installs of it will ignore this update');
		}
		const bases = typeof options.bases === 'string' ? options.bases.split(',').map(value => value.trim()).filter(Boolean) : [baseProduct.backboardVersion];
		if (!bases.length || bases.some(base => !base)) {
			fail('cannot tell which release this update is for; pass --bases');
		}
		if (wantsApp) {
			manifest.components.app = buildAppComponent(options, store, baseRoot, bases);
		}
		if (wantsAgent) {
			manifest.components.agent = buildAgentComponent(options, store, baseRoot, bases, platform);
		}
	}
	if (config) {
		manifest.config = config;
	}
	console.log(`objects: ${store.added} new (${Math.round(store.addedBytes / 1024)} KB compressed)`);
	writeManifest(dir, manifest, key);
}

function rollback(options) {
	const { platform, arch } = hostPlatform(options);
	const { channel, dir } = channelDirectory(options, platform, arch);
	const component = required(options, 'component');
	if (!['app', 'agent'].includes(component)) {
		fail('--component is app or agent');
	}
	const key = loadSigningKey(options);
	const previous = readPreviousManifest(dir, key, options);
	if (!previous?.components?.[component]) {
		fail(`the current manifest has no ${component} component`);
	}
	const manifest = nextManifest(previous, channel, platform, arch);
	delete manifest.components[component];
	writeManifest(dir, manifest, key);
}

function revoke(options) {
	const { platform, arch } = hostPlatform(options);
	const { channel, dir } = channelDirectory(options, platform, arch);
	const id = required(options, 'id');
	const key = loadSigningKey(options);
	const manifest = nextManifest(readPreviousManifest(dir, key, options), channel, platform, arch);
	manifest.revoked = [...new Set([...(manifest.revoked ?? []), id])];
	for (const [name, component] of Object.entries(manifest.components)) {
		if (component.id === id) {
			delete manifest.components[name];
		}
	}
	writeManifest(dir, manifest, key);
}

function verifyCommand(options) {
	const envelope = readJson(required(options, 'manifest'));
	const publicKey = typeof options['public-key'] === 'string'
		? options['public-key']
		: fs.readFileSync(path.join(DEFAULT_KEY_DIR, PUBLIC_KEY_FILE), 'utf8').trim();
	const manifest = openEnvelope(envelope, [publicKey]);
	if (!manifest) {
		fail('signature does not verify with that key');
	}
	console.log(JSON.stringify(manifest, null, 2));
}

async function notify(options) {
	const { platform, arch } = hostPlatform(options);
	const { channel, dir } = channelDirectory(options, platform, arch);
	const url = required(options, 'url');
	const token = process.env.BACKBOARD_LIVE_EVENTS_TOKEN;
	if (!token) {
		fail('BACKBOARD_LIVE_EVENTS_TOKEN is not set');
	}
	const envelope = readJson(path.join(dir, 'manifest.json'));
	const { sequence } = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ channel, platform: `${platform}-${arch}`, sequence }),
	});
	if (!response.ok) {
		fail(`notify failed: HTTP ${response.status} ${await response.text()}`);
	}
	console.log(`announced manifest ${sequence} to ${(await response.json()).clients ?? '?'} connected clients`);
}

// #endregion

const { command, options } = parseArgs(process.argv.slice(2));
switch (command) {
	case 'keygen': keygen(options); break;
	case 'publish': publish(options); break;
	case 'rollback': rollback(options); break;
	case 'revoke': revoke(options); break;
	case 'verify': verifyCommand(options); break;
	case 'notify': await notify(options); break;
	default:
		console.error('usage: publish.mjs keygen|publish|rollback|revoke|verify|notify [options]\nSee the header of this file and docs/live-updates.md.');
		process.exit(command ? 1 : 0);
}
