/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
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

/** Locate a binary in PATH plus the well-known user install dirs. */
function findBinary(name: string): string | undefined {
	const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
	const dirs = [
		...(process.env.PATH?.split(delimiter) ?? []),
		join(homedir(), '.local', 'bin'),
		join(homedir(), 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
	];
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		for (const candidate of names) {
			const full = join(dir, candidate);
			try {
				fs.accessSync(full, fs.constants.X_OK);
				return full;
			} catch {
				// keep scanning
			}
		}
	}
	return undefined;
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
	const claude = findBinary('claude');
	if (!claude) {
		return false;
	}
	return new Promise<boolean>(resolve => {
		execFile(claude, ['auth', 'status', '--json'], { timeout: 10_000, env: claudeSubscriptionProbeEnv() }, (err, stdout) => {
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
	const claude = findBinary('claude');
	if (!claude) {
		return undefined;
	}
	const [installedOutput, latest] = await Promise.all([
		new Promise<string | undefined>(resolve => {
			execFile(claude, ['--version'], { timeout: 10_000, env: claudeSubscriptionProbeEnv() }, (err, stdout) => resolve(err ? undefined : stdout));
		}),
		fetch(CLAUDE_CODE_RELEASES_URL, { signal: AbortSignal.timeout(10_000) })
			.then(response => response.ok ? response.json() as Promise<{ stable?: unknown }> : undefined)
			.then(tags => typeof tags?.stable === 'string' ? tags.stable : undefined)
			.catch(() => undefined),
	]);
	const installed = installedOutput && parseClaudeCodeVersion(installedOutput)?.join('.');
	if (!installed || !latest) {
		return undefined;
	}
	return { installed, latest, updateAvailable: isClaudeCodeOutdated(installed, latest) };
}

/** Runs Claude Code's own updater; rejects with its output when it fails. */
export async function updateClaudeCode(): Promise<void> {
	const claude = findBinary('claude');
	if (!claude) {
		throw new Error('Claude Code is not installed or was not found on PATH.');
	}
	await new Promise<void>((resolve, reject) => {
		// An explicit Update click overrides a disabled background updater.
		const env = claudeSubscriptionProbeEnv();
		delete env.DISABLE_AUTOUPDATER;
		execFile(claude, ['update'], { timeout: CLAUDE_CODE_UPDATE_TIMEOUT_MS, env }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || stdout).trim() || err.message));
				return;
			}
			resolve();
		});
	});
}
