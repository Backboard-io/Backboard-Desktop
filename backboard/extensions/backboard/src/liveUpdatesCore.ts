/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Live updates: download, verify and stage signed JavaScript components into
// `<userData>/LiveUpdates`. No `vscode` import, so tests drive it directly.
// The folder layout and pointer files are shared with the boot loader and the
// agent host (src/vs/platform/backboardLiveUpdate), and the manifest and file
// list formats with scripts/live-updates/publish.mjs. Change them together.

import * as crypto from 'crypto';
import * as nodeFs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as zlib from 'zlib';

export interface LiveUpdateEnvelope {
	readonly payload: string;
	readonly signatures: readonly { readonly keyId: string; readonly signature: string }[];
}

export interface LiveUpdateFileSet {
	readonly url: string;
	readonly sha256: string;
	readonly count: number;
	readonly bytes: number;
}

export interface LiveUpdateRollout {
	readonly percent: number;
	readonly salt?: string;
}

export interface LiveAppComponent {
	readonly id: string;
	readonly bases: readonly string[];
	/** `liveUpdateBuildId` of each installed app it was made from. Missing: refused. */
	readonly builds?: readonly string[];
	readonly electron: string;
	readonly files: LiveUpdateFileSet;
	readonly rollout?: LiveUpdateRollout;
	readonly urgent?: boolean;
	readonly notes?: string;
}

export interface LiveAgentComponent {
	readonly id: string;
	readonly bases: readonly string[];
	readonly builds?: readonly string[];
	readonly protocolVersion: number;
	readonly bunVersion: string;
	readonly entry: string;
	readonly entrySha256: string;
	readonly files: LiveUpdateFileSet;
	readonly rollout?: LiveUpdateRollout;
	readonly notes?: string;
}

export interface LiveUpdateAnnouncement {
	readonly id: string;
	readonly message: string;
	readonly severity?: 'info' | 'warning';
	readonly url?: string;
}

export interface LiveUpdateConfig {
	readonly flags?: Readonly<Record<string, string | number | boolean>>;
	readonly announcement?: LiveUpdateAnnouncement;
	readonly pollIntervalSeconds?: number;
}

export interface LiveUpdateManifest {
	readonly schema: 1;
	readonly channel: string;
	readonly platform: string;
	readonly arch: string;
	readonly sequence: number;
	readonly createdAt: string;
	readonly components: {
		readonly app?: LiveAppComponent;
		readonly agent?: LiveAgentComponent;
	};
	readonly config?: LiveUpdateConfig;
	readonly revoked?: readonly string[];
}

/** One file of a component. Short keys keep lists of ~10k files small. */
export interface LiveFileEntry {
	/** Path relative to the component root, `/`-separated. */
	readonly p: string;
	/** sha256 of the file bytes. */
	readonly h: string;
	/** Size in bytes. */
	readonly s: number;
	/** Executable. */
	readonly x?: 1;
	/**
	 * Comes only from the installed app, never from the network: native code
	 * (it must keep the app's signature) and the app's own product.json, which
	 * holds the keys that verify live updates.
	 */
	readonly b?: 1;
}

/** A folder of the overlay that is the installed app's folder (node_modules). */
export interface LiveLinkEntry {
	readonly p: string;
	/** Path in the installed app root. */
	readonly t: string;
}

export interface LiveFileList {
	readonly schema: 1;
	readonly files: readonly LiveFileEntry[];
	readonly links?: readonly LiveLinkEntry[];
}

export interface LiveComponentPointer {
	readonly schema: 1;
	readonly id: string;
	readonly manifest: LiveUpdateEnvelope;
	readonly stagedAt: string;
	/** Agent pointers only: absolute path of the entry file. */
	readonly entry?: string;
}

export interface LiveUpdatesState {
	readonly highestSequence: number;
	readonly appliedAt?: string;
}

export interface LiveConfigRecord {
	readonly sequence: number;
	readonly config: LiveUpdateConfig;
}

/**
 * Electron's fs reads `*.asar` files as folders, and the installed app has one
 * (node_modules.asar). Staging compares and copies files byte for byte, so it
 * uses Electron's plain file system when there is one.
 */
const fs: typeof nodeFs = loadPlainFs();

function loadPlainFs(): typeof nodeFs {
	try {
		return require('original-fs') as typeof nodeFs;
	} catch {
		return nodeFs;
	}
}

export const liveAgentProtocolVersion = 1;
export const liveAppCompleteMarker = '.complete';
const idPattern = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const maxFileListBytes = 32 * 1024 * 1024;
const maxObjectBytes = 256 * 1024 * 1024;
const downloadConcurrency = 6;
/** Hashing and cloning local copies is disk bound; a few at a time keeps the disk busy. */
const localConcurrency = 8;
const isWindows = process.platform === 'win32';

// #region Signatures

export function liveUpdateKeyId(publicKey: string): string {
	return crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

/** The manifest when a trusted key signed the envelope's exact bytes, otherwise undefined. */
export function verifyLiveUpdateEnvelope(envelope: LiveUpdateEnvelope | undefined, publicKeys: readonly string[]): LiveUpdateManifest | undefined {
	if (!envelope || typeof envelope.payload !== 'string' || !Array.isArray(envelope.signatures) || !publicKeys.length) {
		return undefined;
	}
	const payload = Buffer.from(envelope.payload, 'base64');
	const trusted = new Map(publicKeys.map(key => [liveUpdateKeyId(key), key]));
	const signed = envelope.signatures.some(entry => {
		const key = typeof entry?.keyId === 'string' ? trusted.get(entry.keyId) : undefined;
		if (!key || typeof entry.signature !== 'string') {
			return false;
		}
		try {
			return crypto.verify(null, payload, crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(entry.signature, 'base64'));
		} catch {
			return false;
		}
	});
	if (!signed) {
		return undefined;
	}
	try {
		const manifest = JSON.parse(payload.toString('utf8')) as LiveUpdateManifest;
		return manifest?.schema === 1 && typeof manifest.sequence === 'number' && typeof manifest.components === 'object' ? manifest : undefined;
	} catch {
		return undefined;
	}
}

// #endregion

// #region Network

export interface LiveFetchResult {
	readonly status: number;
	readonly body: Buffer;
	readonly etag?: string;
}

export interface LiveFetchOptions {
	readonly etag?: string;
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly userAgent: string;
	readonly signal?: AbortSignal;
}

/** Plain HTTP is accepted only from this machine (tests and local servers). */
export function isAllowedLiveUpdateUrl(url: URL): boolean {
	return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

export function fetchLiveUpdateBuffer(rawUrl: string, options: LiveFetchOptions, redirects = 5): Promise<LiveFetchResult> {
	return new Promise((resolve, reject) => {
		const url = new URL(rawUrl);
		if (!isAllowedLiveUpdateUrl(url)) {
			reject(new Error(`Refusing live update URL ${url.origin}: HTTPS is required.`));
			return;
		}
		const headers: Record<string, string> = { 'User-Agent': options.userAgent, 'Accept-Encoding': 'identity' };
		if (options.etag) {
			headers['If-None-Match'] = options.etag;
		}
		const client = url.protocol === 'http:' ? http : https;
		const request = client.get(url, { headers, signal: options.signal }, response => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && status !== 304 && location && redirects > 0) {
				response.resume();
				resolve(fetchLiveUpdateBuffer(new URL(location, url).toString(), options, redirects - 1));
				return;
			}
			if (status === 304) {
				response.resume();
				resolve({ status, body: Buffer.alloc(0), etag: options.etag });
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject(new Error(`GET ${url.pathname} failed with HTTP ${status}.`));
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on('data', (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > options.maxBytes) {
					request.destroy(new Error(`GET ${url.pathname} is larger than ${options.maxBytes} bytes.`));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				const etag = response.headers.etag;
				resolve({ status, body: Buffer.concat(chunks), etag: typeof etag === 'string' ? etag : undefined });
			});
			response.on('error', reject);
		});
		request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`GET ${url.pathname} timed out.`)));
		request.on('error', reject);
	});
}

// #endregion

// #region Files

export function sha256(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function sha256OfFile(filePath: string): Promise<string> {
	const hash = crypto.createHash('sha256');
	for await (const chunk of fs.createReadStream(filePath)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest('hex');
}

export function readLiveJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

export async function writeLiveJson(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
	await fs.promises.writeFile(temporary, JSON.stringify(value));
	await fs.promises.rename(temporary, filePath);
}

async function removeLiveFile(filePath: string): Promise<void> {
	await fs.promises.rm(filePath, { force: true });
}

/** A relative, `/`-separated path that cannot leave the folder it is joined to. */
export function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
		return false;
	}
	return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function parseLiveFileList(bytes: Buffer): LiveFileList {
	const list = JSON.parse(zlib.gunzipSync(bytes).toString('utf8')) as LiveFileList;
	if (list?.schema !== 1 || !Array.isArray(list.files)) {
		throw new Error('File list has an unknown format.');
	}
	for (const file of list.files) {
		if (!isSafeRelativePath(file?.p) || typeof file.h !== 'string' || !sha256Pattern.test(file.h) || typeof file.s !== 'number' || file.s < 0) {
			throw new Error(`File list has an invalid entry: ${JSON.stringify(file).slice(0, 200)}`);
		}
	}
	for (const link of list.links ?? []) {
		if (!isSafeRelativePath(link?.p) || !isSafeRelativePath(link.t)) {
			throw new Error(`File list has an invalid link: ${JSON.stringify(link).slice(0, 200)}`);
		}
	}
	return list;
}

export function objectUrl(manifestUrl: string, hash: string): string {
	return new URL(`objects/${hash.slice(0, 2)}/${hash}.gz`, manifestUrl).toString();
}

/** `bucket < percent` decides a staged rollout, stable per machine and salt. */
export function rolloutBucket(machineId: string, salt: string): number {
	return Number.parseInt(sha256(Buffer.from(`${machineId}:${salt}`)).slice(0, 8), 16) % 100;
}

function inRollout(rollout: LiveUpdateRollout | undefined, machineId: string, id: string): boolean {
	if (!rollout) {
		return true;
	}
	return rolloutBucket(machineId, rollout.salt ?? id) < rollout.percent;
}

// #endregion

// #region Staging

export interface LiveStageContext {
	readonly liveUpdatesDir: string;
	/** The installed app root (`Contents/Resources/app`). */
	readonly baseAppRoot: string;
	readonly userAgent: string;
	readonly log: (line: string) => void;
	readonly signal?: AbortSignal;
}

async function findLocalCopy(file: LiveFileEntry, roots: readonly string[]): Promise<string | undefined> {
	for (const root of roots) {
		const candidate = path.join(root, ...file.p.split('/'));
		try {
			const stat = await fs.promises.stat(candidate);
			if (stat.isFile() && stat.size === file.s && await sha256OfFile(candidate) === file.h) {
				return candidate;
			}
		} catch {
			// Not in this root.
		}
	}
	return undefined;
}

async function forEachConcurrently<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await fn(items[next++]);
		}
	}));
}

async function downloadObject(context: LiveStageContext, manifestUrl: string, file: LiveFileEntry, destination: string): Promise<number> {
	const { body } = await fetchLiveUpdateBuffer(objectUrl(manifestUrl, file.h), { maxBytes: maxObjectBytes, timeoutMs: 120_000, userAgent: context.userAgent, signal: context.signal });
	const bytes = zlib.gunzipSync(body);
	if (bytes.length !== file.s || sha256(bytes) !== file.h) {
		throw new Error(`Downloaded ${file.p} does not match its hash.`);
	}
	await fs.promises.writeFile(destination, bytes);
	return body.length;
}

/**
 * Builds a component folder from its file list: each file is cloned from a
 * local copy with the same hash when there is one (the installed app or the
 * previous update), otherwise downloaded. The folder appears under its final
 * name only once complete, so readers never see a partial one.
 */
async function materializeComponent(context: LiveStageContext, manifestUrl: string, fileSet: LiveUpdateFileSet, targetDir: string, localRoots: readonly string[], allowInstalledAppFiles: boolean): Promise<void> {
	if (fs.existsSync(path.join(targetDir, liveAppCompleteMarker))) {
		return;
	}
	const { body } = await fetchLiveUpdateBuffer(new URL(fileSet.url, manifestUrl).toString(), { maxBytes: maxFileListBytes, timeoutMs: 60_000, userAgent: context.userAgent, signal: context.signal });
	if (sha256(body) !== fileSet.sha256) {
		throw new Error('File list does not match the manifest.');
	}
	const list = parseLiveFileList(body);
	const partial = `${targetDir}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
	await fs.promises.mkdir(partial, { recursive: true });
	const started = Date.now();
	let cloned = 0;
	let downloadedBytes = 0;
	try {
		const madeDirs = new Map<string, Promise<unknown>>();
		const ensureParent = (filePath: string) => {
			const dir = path.dirname(filePath);
			let made = madeDirs.get(dir);
			if (!made) {
				made = fs.promises.mkdir(dir, { recursive: true });
				madeDirs.set(dir, made);
			}
			return made;
		};
		for (const link of list.links ?? []) {
			if (!allowInstalledAppFiles) {
				throw new Error('This component may not link to the installed app.');
			}
			const target = path.join(context.baseAppRoot, ...link.t.split('/'));
			if (!fs.existsSync(target)) {
				throw new Error(`The installed app has no ${link.t}.`);
			}
			const linkPath = path.join(partial, ...link.p.split('/'));
			await ensureParent(linkPath);
			await fs.promises.symlink(target, linkPath, 'junction');
		}
		const downloads: { file: LiveFileEntry; destination: string }[] = [];
		await forEachConcurrently(list.files, localConcurrency, async file => {
			context.signal?.throwIfAborted();
			const destination = path.join(partial, ...file.p.split('/'));
			await ensureParent(destination);
			if (file.b) {
				if (!allowInstalledAppFiles) {
					throw new Error('This component may not use installed app files.');
				}
				const installed = await findLocalCopy(file, [context.baseAppRoot]);
				if (!installed) {
					throw new Error(`${file.p} differs from the installed app this update was built for.`);
				}
				// Native code keeps running from the installed app, exactly as it
				// would without the overlay. Windows needs privileges for file
				// symlinks; there a copy keeps the embedded signature.
				if (isWindows) {
					await fs.promises.copyFile(installed, destination);
				} else {
					await fs.promises.symlink(installed, destination);
				}
				return;
			}
			const local = await findLocalCopy(file, localRoots);
			if (local) {
				await fs.promises.copyFile(local, destination, fs.constants.COPYFILE_FICLONE);
				cloned++;
			} else {
				downloads.push({ file, destination });
			}
		});
		await forEachConcurrently(downloads, downloadConcurrency, async item => {
			downloadedBytes += await downloadObject(context, manifestUrl, item.file, item.destination);
		});
		if (!isWindows) {
			for (const file of list.files) {
				if (file.x && !file.b) {
					await fs.promises.chmod(path.join(partial, ...file.p.split('/')), 0o755);
				}
			}
		}
		await fs.promises.writeFile(path.join(partial, liveAppCompleteMarker), JSON.stringify({ fileList: fileSet.sha256, completedAt: new Date().toISOString() }));
		await fs.promises.rm(targetDir, { recursive: true, force: true });
		await fs.promises.rename(partial, targetDir);
		context.log(`[live] staged ${path.basename(targetDir)}: ${list.files.length} files, ${cloned} reused, ${downloads.length} downloaded (${Math.round(downloadedBytes / 1024)} KB) in ${Date.now() - started} ms`);
	} catch (error) {
		await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

// #endregion

// #region Reconcile

/** What a component must have been made from to run on this install. */
export interface LiveInstalledApp {
	readonly appVersion: string;
	/** `liveUpdateBuildId` of the installed app; undefined when it records none. */
	readonly appBuild: string | undefined;
}

export interface LiveApplyContext extends LiveStageContext, LiveInstalledApp {
	readonly publicKeys: readonly string[];
	readonly channel: string;
	readonly electronVersion: string;
	readonly machineId: string;
	/** Overlay the running app started from, if any. Never deleted. */
	readonly runningAppId?: string;
}

export interface LiveApplyResult {
	readonly sequence: number;
	/** Overlay the next start should use; undefined = the installed app. */
	readonly desiredAppId?: string;
	readonly app?: LiveAppComponent;
	readonly agentId?: string;
	readonly config?: LiveUpdateConfig;
	/** Component ids the manifest withdrew as broken. */
	readonly revoked: readonly string[];
	readonly errors: readonly string[];
}

/** sha256 of no bytes: what the package scripts record for a clean source tree. */
const cleanSourceSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * The source an installed app was built from (product.json `backboardBuildInfo`):
 * its commit, plus the hash of uncommitted changes when there were any. Must
 * equal liveUpdateBuildId in src/vs/platform/backboardLiveUpdate/common/liveUpdate.ts.
 */
export function liveUpdateBuildId(info: { readonly sourceCommit?: unknown; readonly sourceDirtySha256?: unknown } | undefined): string | undefined {
	const commit = info?.sourceCommit;
	if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
		return undefined;
	}
	const dirty = info?.sourceDirtySha256;
	return typeof dirty === 'string' && sha256Pattern.test(dirty.toLowerCase()) && dirty.toLowerCase() !== cleanSourceSha256
		? `${commit}+${dirty}`.toLowerCase()
		: commit.toLowerCase();
}

/**
 * Why a component does not fit the installed app, or undefined when it does.
 * A release rebuilt under the same version is another build, and a component
 * made from the old one would run older code over it. One without builds was
 * published before they were recorded, so it is refused as well.
 */
export function installedAppMismatch(component: { readonly bases: readonly string[]; readonly builds?: readonly string[] }, installed: LiveInstalledApp): string | undefined {
	if (!Array.isArray(component.bases) || !component.bases.includes(installed.appVersion)) {
		return `targets ${Array.isArray(component.bases) ? component.bases.join(', ') : 'no release'}, installed app is ${installed.appVersion}`;
	}
	if (!Array.isArray(component.builds) || !component.builds.length) {
		return 'records no base build';
	}
	if (!installed.appBuild) {
		return 'needs a known build, installed app records none';
	}
	return component.builds.includes(installed.appBuild) ? undefined : `was made from build ${component.builds.join(', ')}, installed app is build ${installed.appBuild}`;
}

export function liveAppDir(liveUpdatesDir: string): string {
	return path.join(liveUpdatesDir, 'app');
}

export function liveAgentDir(liveUpdatesDir: string): string {
	return path.join(liveUpdatesDir, 'agent');
}

export function readBadAppIds(liveUpdatesDir: string): readonly string[] {
	return readLiveJson<{ ids?: string[] }>(path.join(liveAppDir(liveUpdatesDir), 'bad.json'))?.ids ?? [];
}

/**
 * The overlay the next app start will use, or undefined for the installed app.
 * Mirrors the boot loader's checks, so a pointer left from before a full
 * release (built for the old version or build) does not offer a pointless restart.
 */
export function readDesiredApp(liveUpdatesDir: string, publicKeys: readonly string[], installed: LiveInstalledApp, electronVersion: string): LiveAppComponent | undefined {
	const pointer = readLiveJson<LiveComponentPointer>(path.join(liveAppDir(liveUpdatesDir), 'current.json'));
	const app = verifyLiveUpdateEnvelope(pointer?.manifest, publicKeys)?.components.app;
	if (!app || app.id !== pointer?.id || installedAppMismatch(app, installed) || app.electron !== electronVersion || readBadAppIds(liveUpdatesDir).includes(app.id)) {
		return undefined;
	}
	return fs.existsSync(path.join(liveAppDir(liveUpdatesDir), app.id, liveAppCompleteMarker)) ? app : undefined;
}

/**
 * Called by every window once the app is up. Records that the running overlay
 * started (so the boot loader stops counting its attempts) and the real main
 * process id: the boot loader writes its own pid before it knows whether it
 * becomes the running instance, and two processes started together (as a
 * relaunch can do) leave the id of the one that only handed over arguments.
 * Later launches rely on that id to recognise a running instance.
 */
export async function recordLiveAppRunning(liveUpdatesDir: string, runningAppId: string | undefined, mainPid: number): Promise<void> {
	const bootPath = path.join(liveAppDir(liveUpdatesDir), 'boot.json');
	const record = readLiveJson<{ id?: string; attempts?: number; pid?: number; healthy?: boolean }>(bootPath);
	if (runningAppId) {
		if (record?.id !== runningAppId || !record.healthy || record.pid !== mainPid) {
			await writeLiveJson(bootPath, { id: runningAppId, attempts: 0, pid: mainPid, healthy: true });
		}
	} else if (record?.id !== undefined || record?.pid !== mainPid) {
		await writeLiveJson(bootPath, { attempts: 0, pid: mainPid });
	}
}

/**
 * Makes the folder match a verified manifest: stages what it asks for and
 * removes pointers to anything it no longer asks for (a rollback). Components
 * are independent; one failing does not stop the others.
 */
export async function applyLiveManifest(context: LiveApplyContext, manifestUrl: string, envelope: LiveUpdateEnvelope): Promise<LiveApplyResult> {
	const manifest = verifyLiveUpdateEnvelope(envelope, context.publicKeys);
	if (!manifest) {
		throw new Error('The manifest is not signed by a trusted key.');
	}
	if (manifest.channel !== context.channel || manifest.platform !== process.platform || manifest.arch !== process.arch) {
		throw new Error(`The manifest is for ${manifest.channel} ${manifest.platform}-${manifest.arch}, this app is ${context.channel} ${process.platform}-${process.arch}.`);
	}
	const statePath = path.join(context.liveUpdatesDir, 'state.json');
	const state = readLiveJson<LiveUpdatesState>(statePath);
	if (state && manifest.sequence < state.highestSequence) {
		throw new Error(`Ignoring manifest ${manifest.sequence}: ${state.highestSequence} was already applied.`);
	}
	const revoked = new Set(manifest.revoked ?? []);
	const errors: string[] = [];

	// App overlay.
	const appDir = liveAppDir(context.liveUpdatesDir);
	const appPointerPath = path.join(appDir, 'current.json');
	const appPointer = readLiveJson<LiveComponentPointer>(appPointerPath);
	const app = manifest.components.app;
	const appMismatch = app && installedAppMismatch(app, context);
	if (app && appMismatch) {
		context.log(`[live] app overlay ${app.id} ${appMismatch}; not using it`);
	}
	let desiredAppId: string | undefined;
	if (app && idPattern.test(app.id) && !revoked.has(app.id) && !readBadAppIds(context.liveUpdatesDir).includes(app.id)
		&& !appMismatch && app.electron === context.electronVersion && inRollout(app.rollout, context.machineId, app.id)) {
		try {
			const localRoots = [context.baseAppRoot, ...(appPointer?.id && idPattern.test(appPointer.id) ? [path.join(appDir, appPointer.id)] : [])];
			await materializeComponent(context, manifestUrl, app.files, path.join(appDir, app.id), localRoots, true);
			if (appPointer?.id !== app.id || appPointer.manifest.payload !== envelope.payload) {
				await writeLiveJson(appPointerPath, { schema: 1, id: app.id, manifest: envelope, stagedAt: new Date().toISOString() } satisfies LiveComponentPointer);
			}
			desiredAppId = app.id;
		} catch (error) {
			errors.push(`app ${app.id}: ${error instanceof Error ? error.message : String(error)}`);
			desiredAppId = appPointer?.id && !revoked.has(appPointer.id) ? appPointer.id : undefined;
		}
	} else if (appPointer) {
		context.log(`[live] app overlay ${appPointer.id} withdrawn; the next start runs the installed app`);
		await removeLiveFile(appPointerPath);
	}

	// Agent bundle.
	const agentDir = liveAgentDir(context.liveUpdatesDir);
	const agentPointerPath = path.join(agentDir, 'current.json');
	const agentPointer = readLiveJson<LiveComponentPointer>(agentPointerPath);
	const agent = manifest.components.agent;
	const agentMismatch = agent && installedAppMismatch(agent, context);
	if (agent && agentMismatch) {
		context.log(`[live] agent runtime ${agent.id} ${agentMismatch}; not using it`);
	}
	let agentId: string | undefined;
	if (agent && idPattern.test(agent.id) && !revoked.has(agent.id) && isSafeRelativePath(agent.entry)
		&& agent.protocolVersion === liveAgentProtocolVersion && !agentMismatch && inRollout(agent.rollout, context.machineId, agent.id)) {
		try {
			const bundleDir = path.join(agentDir, agent.id);
			const localRoots = agentPointer?.id && idPattern.test(agentPointer.id) ? [path.join(agentDir, agentPointer.id)] : [];
			await materializeComponent(context, manifestUrl, agent.files, bundleDir, localRoots, false);
			const entry = path.join(bundleDir, ...agent.entry.split('/'));
			if (await sha256OfFile(entry) !== agent.entrySha256) {
				throw new Error('The bundle entry does not match the manifest.');
			}
			if (agentPointer?.id !== agent.id || agentPointer.manifest.payload !== envelope.payload) {
				await writeLiveJson(agentPointerPath, { schema: 1, id: agent.id, entry, manifest: envelope, stagedAt: new Date().toISOString() } satisfies LiveComponentPointer);
				if (agentPointer?.id !== agent.id) {
					context.log(`[live] agent runtime ${agent.id} staged; sessions switch to it at their next turn`);
				}
			}
			agentId = agent.id;
		} catch (error) {
			errors.push(`agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
			agentId = agentPointer?.id && !revoked.has(agentPointer.id) ? agentPointer.id : undefined;
		}
	} else if (agentPointer) {
		context.log(`[live] agent runtime ${agentPointer.id} withdrawn; new sessions use the installed runtime`);
		await removeLiveFile(agentPointerPath);
	}

	await writeLiveJson(statePath, { highestSequence: Math.max(manifest.sequence, state?.highestSequence ?? 0), appliedAt: new Date().toISOString() } satisfies LiveUpdatesState);
	await writeLiveJson(path.join(context.liveUpdatesDir, 'config.json'), { sequence: manifest.sequence, config: manifest.config ?? {} } satisfies LiveConfigRecord);
	await pruneLiveUpdates(context.liveUpdatesDir, new Set([desiredAppId, context.runningAppId].filter((id): id is string => !!id)), new Set([agentId, agentPointer?.id].filter((id): id is string => !!id)));
	return { sequence: manifest.sequence, desiredAppId, app: desiredAppId === app?.id ? app : undefined, agentId, config: manifest.config, revoked: [...revoked], errors };
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Deletes folders nothing points at. The running overlay and the previous agent
 * bundle stay: processes started earlier may still read them.
 */
async function pruneLiveUpdates(liveUpdatesDir: string, keepApps: ReadonlySet<string>, keepAgents: ReadonlySet<string>): Promise<void> {
	for (const [dir, keep] of [[liveAppDir(liveUpdatesDir), keepApps], [liveAgentDir(liveUpdatesDir), keepAgents]] as const) {
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const partial = /\.partial-(?<pid>\d+)-[0-9a-f]+$/.exec(entry.name);
			const stale = partial ? !processIsAlive(Number(partial.groups!.pid)) : !keep.has(entry.name);
			if (stale) {
				await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}
}

// #endregion

// #region Leader

/** A leader refreshes its lock on every check; one this old belongs to a reused pid. */
const leaderLockMaxAgeMs = 30 * 60_000;

/**
 * Every window runs this extension; only one of them talks to the network and
 * stages files. The others read the result from disk. A leader that quits
 * leaves a lock with a dead pid, which the next window to check takes over.
 */
export function tryAcquireLiveUpdateLeadership(liveUpdatesDir: string): boolean {
	const lockPath = path.join(liveUpdatesDir, 'leader.json');
	fs.mkdirSync(liveUpdatesDir, { recursive: true });
	const owner = readLiveJson<{ pid?: number; at?: string }>(lockPath);
	const fresh = owner?.at !== undefined && Date.now() - Date.parse(owner.at) < leaderLockMaxAgeMs;
	if (owner?.pid === process.pid) {
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
		return true;
	}
	if (owner?.pid && fresh && processIsAlive(owner.pid)) {
		return false;
	}
	if (owner) {
		// Windows starting together all see the same stale lock. Moving it aside
		// is atomic, so only one of them can; the rest stay followers.
		const aside = `${lockPath}.${process.pid}.stale`;
		try {
			fs.renameSync(lockPath, aside);
		} catch {
			return false;
		}
		const moved = readLiveJson<{ pid?: number; at?: string }>(aside);
		fs.rmSync(aside, { force: true });
		if (moved?.pid !== owner.pid || moved?.at !== owner.at) {
			// Another window took over between the read and the move: restore its lock.
			try {
				fs.writeFileSync(lockPath, JSON.stringify(moved), { flag: 'wx' });
			} catch {
				// It wrote a new one meanwhile.
			}
			return false;
		}
	}
	try {
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
		return true;
	} catch {
		return false;
	}
}

export function releaseLiveUpdateLeadership(liveUpdatesDir: string): void {
	const lockPath = path.join(liveUpdatesDir, 'leader.json');
	if (readLiveJson<{ pid?: number }>(lockPath)?.pid === process.pid) {
		fs.rmSync(lockPath, { force: true });
	}
}

// #endregion

// #region Events

export interface LiveEventSource {
	dispose(): void;
}

/**
 * Listens on a server-sent events endpoint and reports each `manifest` event's
 * sequence. Reconnects with jittered backoff, so a server restart does not
 * make every client reconnect in the same second.
 */
export function connectLiveUpdateEvents(rawUrl: string, userAgent: string, onManifest: (sequence: number | undefined) => void, log: (line: string) => void): LiveEventSource {
	let disposed = false;
	let request: http.ClientRequest | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	const connect = () => {
		if (disposed) {
			return;
		}
		const url = new URL(rawUrl);
		if (!isAllowedLiveUpdateUrl(url)) {
			log(`[live] events endpoint ${url.origin} refused: HTTPS is required`);
			return;
		}
		const client = url.protocol === 'http:' ? http : https;
		request = client.get(url, { headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache', 'User-Agent': userAgent } }, response => {
			if ((response.statusCode ?? 0) !== 200) {
				response.resume();
				scheduleRetry(`HTTP ${response.statusCode}`);
				return;
			}
			failures = 0;
			response.setEncoding('utf8');
			let buffer = '';
			let eventName = 'message';
			let data = '';
			response.on('data', (chunk: string) => {
				buffer += chunk;
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, '');
					buffer = buffer.slice(newline + 1);
					if (line === '') {
						if (eventName === 'manifest') {
							let sequence: number | undefined;
							try {
								const parsed = JSON.parse(data) as { sequence?: unknown };
								sequence = typeof parsed.sequence === 'number' ? parsed.sequence : undefined;
							} catch {
								// A manifest event without a body still means "check now".
							}
							onManifest(sequence);
						}
						eventName = 'message';
						data = '';
					} else if (line.startsWith('event:')) {
						eventName = line.slice(6).trim();
					} else if (line.startsWith('data:')) {
						data += line.slice(5).trim();
					}
				}
			});
			response.on('end', () => scheduleRetry('stream ended'));
			response.on('error', error => scheduleRetry(error.message));
		});
		request.on('error', error => scheduleRetry(error.message));
	};
	const scheduleRetry = (reason: string) => {
		request?.destroy();
		request = undefined;
		if (disposed || retryTimer) {
			return;
		}
		failures++;
		const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)) * (0.5 + Math.random() / 2);
		if (failures <= 3 || failures % 10 === 0) {
			log(`[live] events disconnected (${reason}); retrying in ${Math.round(delay / 1000)} s`);
		}
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			connect();
		}, delay);
	};
	connect();
	return {
		dispose: () => {
			disposed = true;
			clearTimeout(retryTimer);
			request?.destroy();
		}
	};
}

// #endregion
