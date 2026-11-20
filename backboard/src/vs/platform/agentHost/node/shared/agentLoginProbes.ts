/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, type ExecFileOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { delimiter, join } from '../../../../base/common/path.js';

/**
 * Presence-only login probes for the subscription-native agents. Providers
 * whose probe fails are not registered at all — the picker then offers the
 * agent as a one-click setup row (install + vendor sign-in) instead of
 * surfacing raw "not logged in" errors on the first message.
 *
 * These check login *state* without reading any secret material. Claude uses
 * the CLI's own status command, which reports account metadata but never the
 * credentials themselves.
 */

/**
 * `execFile` that always answers through the callback. Node throws some spawn
 * failures (ENOEXEC, EINVAL) synchronously instead, which rejected the whole
 * Connect flow with a bare "spawn ENOEXEC".
 */
function execFileSafely(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: (error: Error | null, stdout: string, stderr: string) => void): void {
	try {
		execFile(file, args, options, callback);
	} catch (err) {
		callback(err instanceof Error ? err : new Error(String(err)), '', '');
	}
}

/**
 * Whether the OS can start a file directly: a native binary (Mach-O, ELF, PE)
 * or a script with a `#!` line. npm's Claude Code links `claude` to
 * `bin/claude.exe`, a shell stub without `#!` that its postinstall replaces
 * with the native binary. When the postinstall did not run (`--ignore-scripts`,
 * pnpm, Bun, a missing optional dependency) a terminal still runs the stub,
 * which prints "claude native binary not installed", but spawning it fails
 * with ENOEXEC. An unreadable file is left for spawn to judge.
 */
export function isSpawnableExecutable(file: string): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(file, 'r');
		const header = Buffer.alloc(4);
		const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
		const prefix = header.toString('latin1', 0, Math.min(bytesRead, 2));
		if (prefix === '#!' || prefix === 'MZ') {
			return true;
		}
		if (bytesRead < 4) {
			return false;
		}
		switch (header.readUInt32BE(0)) {
			case 0x7f454c46: // ELF
			case 0xcffaedfe: case 0xcefaedfe: case 0xfeedfacf: case 0xfeedface: // Mach-O
			case 0xcafebabe: case 0xcafebabf: // universal Mach-O
				return true;
			default:
				return false;
		}
	} catch {
		return true;
	} finally {
		if (descriptor !== undefined) {
			fs.closeSync(descriptor);
		}
	}
}

/** Every distinct, startable Claude Code binary in PATH and the vendor's install dirs, PATH order first. */
function claudeBinaryCandidates(): string[] {
	const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
	const dirs = [
		...(process.env.PATH?.split(delimiter) ?? []),
		join(homedir(), '.local', 'bin'),
		join(homedir(), 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
	];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		const full = join(dir, name);
		try {
			fs.accessSync(full, fs.constants.X_OK);
			const real = fs.realpathSync(full);
			if (!seen.has(real) && isSpawnableExecutable(real)) {
				seen.add(real);
				candidates.push(full);
			}
		} catch {
			// keep scanning
		}
	}
	return candidates;
}

const claudeVersionCache = new Map<string, { readonly mtimeMs: number; readonly version: Promise<string | undefined> }>();

/** `claude --version` of one binary, cached until the binary changes on disk. */
function readClaudeCodeVersion(binary: string): Promise<string | undefined> {
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(fs.realpathSync(binary)).mtimeMs;
	} catch {
		return Promise.resolve(undefined);
	}
	const cached = claudeVersionCache.get(binary);
	if (cached && cached.mtimeMs === mtimeMs) {
		return cached.version;
	}
	const version = new Promise<string | undefined>(resolve => {
		execFileSafely(binary, ['--version'], { timeout: 10_000, env: claudeSubscriptionProbeEnv() }, (err, stdout) => {
			resolve(err ? undefined : parseClaudeCodeVersion(stdout)?.join('.'));
		});
	});
	claudeVersionCache.set(binary, { mtimeMs, version });
	return version;
}

/** A path the user pinned before Backboard started; never overridden. */
const USER_PINNED_CLAUDE_PATH = process.env.BACKBOARD_CLAUDE_CODE_PATH?.trim() || undefined;

/**
 * The Claude Code binary Backboard uses. A machine can carry several (an old
 * npm global ahead of a newer native install in PATH); the newest wins, and
 * the cli-ts runtime is pointed at the same one through
 * `BACKBOARD_CLAUDE_CODE_PATH` so login, status and turns never disagree.
 */
export async function resolveClaudeBinary(): Promise<string | undefined> {
	if (USER_PINNED_CLAUDE_PATH) {
		return USER_PINNED_CLAUDE_PATH;
	}
	const candidates = claudeBinaryCandidates();
	let best = candidates[0];
	if (candidates.length > 1) {
		const versions = await Promise.all(candidates.map(readClaudeCodeVersion));
		let bestVersion = versions[0];
		for (let index = 1; index < candidates.length; index++) {
			const version = versions[index];
			if (version && (!bestVersion || isClaudeCodeOutdated(bestVersion, version))) {
				best = candidates[index];
				bestVersion = version;
			}
		}
	}
	if (best) {
		process.env.BACKBOARD_CLAUDE_CODE_PATH = best;
	} else {
		delete process.env.BACKBOARD_CLAUDE_CODE_PATH;
	}
	return best;
}

/** Whether Claude's public status payload represents a Claude.ai subscription. */
export function isClaudeSubscriptionAuthStatus(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const status = value as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
	return status.loggedIn === true && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty';
}

/** Match the subscription transport's environment when probing the vendor login. */
export function claudeSubscriptionProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const sanitized = { ...env };
	for (const key of [
		'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
		'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
		'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS',
	]) {
		delete sanitized[key];
	}
	return sanitized;
}

/**
 * Whether the user has logged the Claude CLI into a Claude.ai subscription.
 * `claude auth status --json` is authoritative across every credential
 * backend. Requiring the Claude.ai/first-party fields prevents an Anthropic
 * API key or a cloud-provider login from being mislabeled as a subscription.
 */
export async function isClaudeLoggedIn(): Promise<boolean> {
	const claude = await resolveClaudeBinary();
	if (!claude) {
		return false;
	}
	return new Promise<boolean>(resolve => {
		execFileSafely(claude, ['auth', 'status', '--json'], { timeout: 10_000, env: claudeSubscriptionProbeEnv() }, (err, stdout) => {
			if (err) {
				resolve(false);
				return;
			}
			try {
				resolve(isClaudeSubscriptionAuthStatus(JSON.parse(stdout)));
			} catch {
				resolve(false);
			}
		});
	});
}

/**
 * How long a verified Claude login is trusted before the CLI is asked again.
 * The probe spawns a process (about 0.3s) and ran ahead of every message; the
 * cli-ts runtime honors and clears the same record (`claude-login.json`), so a
 * turn that fails to authenticate makes the next send probe again.
 */
const CLAUDE_LOGIN_TRUST_MS = 5 * 60_000;

function claudeLoginRecordPath(homeDir: string): string {
	return join(homeDir, '.backboard', 'claude-login.json');
}

/**
 * {@link isClaudeLoggedIn}, skipping the probe while a verified login is
 * still trusted. Only a timestamp is stored; Claude Code keeps the credentials.
 */
export async function isClaudeLoggedInRecently(
	probe: () => Promise<boolean> = isClaudeLoggedIn,
	homeDir = homedir(),
	now = Date.now(),
): Promise<boolean> {
	const record = claudeLoginRecordPath(homeDir);
	try {
		const { verifiedAt } = JSON.parse(await fs.promises.readFile(record, 'utf8')) as { verifiedAt?: unknown };
		if (typeof verifiedAt === 'number' && verifiedAt <= now && now - verifiedAt < CLAUDE_LOGIN_TRUST_MS) {
			return true;
		}
	} catch {
		// No usable record: ask Claude Code.
	}
	const loggedIn = await probe();
	try {
		if (loggedIn) {
			await fs.promises.mkdir(join(homeDir, '.backboard'), { recursive: true, mode: 0o700 });
			await fs.promises.writeFile(record, JSON.stringify({ verifiedAt: now }), { mode: 0o600 });
		} else {
			await fs.promises.rm(record, { force: true });
		}
	} catch {
		// Without the record every send simply probes again.
	}
	return loggedIn;
}

/** Whether the user has run `codex login` (ChatGPT plan or API key). */
export function isCodexLoggedIn(): boolean {
	const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
	try {
		fs.accessSync(join(codexHome, 'auth.json'), fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** The installed Claude Code next to the release `claude update` installs. */
export interface IClaudeCodeVersionStatus {
	readonly installed: string;
	readonly latest: string;
	readonly updateAvailable: boolean;
}

const CLAUDE_CODE_RELEASES_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const CLAUDE_CODE_UPDATE_TIMEOUT_MS = 5 * 60_000;

/** `2.1.172 (Claude Code)` → `[2, 1, 172]`. */
export function parseClaudeCodeVersion(text: string): number[] | undefined {
	const match = /(?<version>\d+\.\d+\.\d+)/.exec(text);
	return match?.groups?.version.split('.').map(Number);
}

/** Whether `installed` is older than `latest`; unparseable versions never prompt. */
export function isClaudeCodeOutdated(installed: string, latest: string): boolean {
	const a = parseClaudeCodeVersion(installed);
	const b = parseClaudeCodeVersion(latest);
	if (!a || !b) {
		return false;
	}
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) {
			return a[index] < b[index];
		}
	}
	return false;
}

/**
 * Compares the installed Claude Code with the `stable` release. An outdated
 * install reports fewer models, and newer ones (Opus 5.5, Sonnet 5.5) are
 * rejected outright. `stable` is the floor every update channel reaches, so
 * the prompt clears after one `claude update`. Undefined when Claude Code is
 * missing or the release list cannot be read; that never blocks a turn.
 */
export async function claudeCodeVersionStatus(): Promise<IClaudeCodeVersionStatus | undefined> {
	const claude = await resolveClaudeBinary();
	if (!claude) {
		return undefined;
	}
	const [installed, latest] = await Promise.all([
		readClaudeCodeVersion(claude),
		fetchLatestClaudeCodeVersion(),
	]);
	if (!installed || !latest) {
		return undefined;
	}
	return { installed, latest, updateAvailable: isClaudeCodeOutdated(installed, latest) };
}

function fetchLatestClaudeCodeVersion(): Promise<string | undefined> {
	return fetch(CLAUDE_CODE_RELEASES_URL, { signal: AbortSignal.timeout(10_000) })
		.then(response => response.ok ? response.json() as Promise<{ stable?: unknown }> : undefined)
		.then(tags => typeof tags?.stable === 'string' ? tags.stable : undefined)
		.catch(() => undefined);
}

/** Runs Claude Code's own updater; rejects with its output when it fails. */
export async function updateClaudeCode(): Promise<void> {
	const claude = await resolveClaudeBinary();
	if (!claude) {
		throw new Error('Claude Code is not installed or was not found on PATH.');
	}
	await new Promise<void>((resolve, reject) => {
		// An explicit Update click overrides a disabled background updater.
		const env = claudeSubscriptionProbeEnv();
		delete env.DISABLE_AUTOUPDATER;
		execFileSafely(claude, ['update'], { timeout: CLAUDE_CODE_UPDATE_TIMEOUT_MS, env }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || stdout).trim() || err.message));
				return;
			}
			resolve();
		});
	});
}

/** Anthropic's Node-less native installer; puts `claude` in `~/.local/bin`. */
const CLAUDE_CODE_INSTALL_SCRIPT = 'curl -fsSL https://claude.ai/install.sh | bash';

/** Installs Claude Code with the vendor's native installer; rejects with its output when it fails. */
export async function installClaudeCode(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFileSafely('/bin/bash', ['-c', CLAUDE_CODE_INSTALL_SCRIPT], { timeout: CLAUDE_CODE_UPDATE_TIMEOUT_MS, env: claudeSubscriptionProbeEnv(), cwd: homedir() }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || stdout).trim() || err.message));
				return;
			}
			resolve();
		});
	});
}

/**
 * Whether this Claude Code has the `auth login --claudeai` / `auth status --json`
 * commands Backboard signs in with. Older releases treat `auth` as a prompt
 * and fail with "unknown option '--claudeai'" (exit code 1).
 */
export function claudeSupportsAuthCommands(binary: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		execFileSafely(binary, ['auth', 'login', '--help'], { timeout: 10_000, env: claudeSubscriptionProbeEnv() }, (err, stdout, stderr) => {
			resolve(!err && `${stdout}${stderr}`.includes('--claudeai'));
		});
	});
}

/** What {@link ensureClaudeCodeReady} did on the way to a usable Claude Code. */
export interface IClaudeCodeReady {
	readonly executable: string;
	readonly installed: boolean;
	readonly updated: boolean;
}

/**
 * Makes sure a Claude Code that can sign in to a subscription is present:
 * installs it when missing, updates it when it is older than the stable
 * release or lacks the `auth` commands, and falls back to a fresh native
 * install when the updater cannot touch an old copy (a root-owned npm global).
 * Resolves with the binary to sign in with.
 */
export async function ensureClaudeCodeReady(
	ops: {
		readonly resolve: () => Promise<string | undefined>;
		readonly supportsAuth: (binary: string) => Promise<boolean>;
		readonly versionStatus: () => Promise<IClaudeCodeVersionStatus | undefined>;
		readonly install: () => Promise<void>;
		readonly update: () => Promise<void>;
	} = { resolve: resolveClaudeBinary, supportsAuth: claudeSupportsAuthCommands, versionStatus: claudeCodeVersionStatus, install: installClaudeCode, update: updateClaudeCode },
): Promise<IClaudeCodeReady> {
	let installed = false;
	let updated = false;
	let executable = await ops.resolve();
	if (!executable) {
		await ops.install();
		installed = true;
		executable = await ops.resolve();
		if (!executable) {
			throw new Error('Claude Code was installed but could not be found. Restart Backboard and choose Connect Claude again.');
		}
	}
	const capable = await ops.supportsAuth(executable);
	const outdated = !installed && (await ops.versionStatus())?.updateAvailable === true;
	if (!capable || outdated) {
		let updateError: unknown;
		try {
			await ops.update();
			updated = true;
		} catch (err) {
			updateError = err;
		}
		executable = (await ops.resolve()) ?? executable;
		if (!await ops.supportsAuth(executable)) {
			// The updater could not move this copy forward; a native install
			// lands in ~/.local/bin and wins as the newest binary.
			try {
				await ops.install();
				installed = true;
			} catch (err) {
				throw new Error(`Claude Code is too old to sign in and could not be updated: ${err instanceof Error ? err.message : String(err ?? updateError)}`);
			}
			executable = (await ops.resolve()) ?? executable;
			if (!await ops.supportsAuth(executable)) {
				throw new Error('Claude Code is too old to sign in. Run `claude update` in a terminal, then choose Connect Claude again.');
			}
		}
	}
	return { executable, installed, updated };
}
