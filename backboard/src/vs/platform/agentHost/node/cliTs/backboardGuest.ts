/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Guest access: someone who hasn't signed in still gets Backboard's free
 * models. The server mints a guest account per device (`POST /auth/guest`)
 * and returns an API key, stored under `guest` in `~/.backboard_ide/config.json`.
 * Only the agent runtime uses it ({@link guestApiKey} via `bridgeConfig`); the
 * workbench's signed-in check reads `api_key`/`oauth` only, so a guest still
 * counts as signed out everywhere in the UI. The server only lets a guest key
 * run free models.
 */

const REQUEST_TIMEOUT_MS = 15_000;

interface IGuestConfig {
	readonly api_key?: string;
	readonly device_id?: string;
	readonly created_at?: string;
}

function configPath(): string {
	return join(os.homedir(), '.backboard_ide', 'config.json');
}

function readConfig(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function guestOf(config: { readonly guest?: unknown }): IGuestConfig {
	const guest = config.guest;
	return guest && typeof guest === 'object' && !Array.isArray(guest) ? guest as IGuestConfig : {};
}

/** The stored guest key, if this device has one. */
export function guestApiKey(config: { readonly guest?: unknown }): string | undefined {
	const key = guestOf(config).api_key;
	return typeof key === 'string' && key.trim() ? key.trim() : undefined;
}

function hasRealCredentials(config: Record<string, unknown>): boolean {
	const oauth = config.oauth && typeof config.oauth === 'object' ? config.oauth as Record<string, unknown> : undefined;
	const envKeys = config.env_keys && typeof config.env_keys === 'object' ? Object.values(config.env_keys as Record<string, unknown>) : [];
	return [config.api_key, config.apiKey, oauth?.access_token, ...envKeys].some(value => typeof value === 'string' && value.trim() !== '');
}

function defaultApiUrl(config: Record<string, unknown>): string {
	const explicit = [process.env.BACKBOARD_API_URL, process.env.VSCODE_BACKBOARD_API_URL, config.api_url, config.apiUrl]
		.find((value): value is string => typeof value === 'string' && value.trim() !== '');
	if (explicit) {
		return explicit.trim().replace(/\/+$/, '');
	}
	const env = String(process.env.BACKBOARD_ENV || process.env.VSCODE_BACKBOARD_ENV || config.env || 'prod').trim().toLowerCase();
	return env === 'local' ? 'http://localhost:8000' : env === 'prod' || env === 'production' ? 'https://app.backboard.io/api' : 'https://dev.app.backboard.io/api';
}

let inFlight: Promise<void> | undefined;

/**
 * Makes sure a signed-out device has a guest key. Does nothing when the user
 * is signed in or a guest key already exists. Failures (offline, a server
 * without guest access) are logged and retried on the next call.
 */
export function ensureBackboardGuestKey(logService: ILogService): Promise<void> {
	inFlight ??= provision(logService).finally(() => { inFlight = undefined; });
	return inFlight;
}

async function provision(logService: ILogService): Promise<void> {
	const config = readConfig();
	if (hasRealCredentials(config) || guestApiKey(config) || process.env.BACKBOARD_API_KEY || process.env.VSCODE_BACKBOARD_API_KEY) {
		return;
	}
	const deviceId = guestOf(config).device_id || randomUUID();
	let apiKey: string | undefined;
	try {
		const response = await fetch(`${defaultApiUrl(config)}/auth/guest`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_id: deviceId }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			logService.info(`[Backboard] Guest access unavailable (HTTP ${response.status}).`);
			return;
		}
		const body = await response.json() as { api_key?: unknown };
		apiKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : undefined;
	} catch (error) {
		logService.info(`[Backboard] Guest access request failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!apiKey) {
		return;
	}
	// Re-read: a sign-in may have landed while the request was in flight, and
	// other writers own every other field in this file.
	const latest = readConfig();
	if (hasRealCredentials(latest)) {
		return;
	}
	const next = { ...latest, guest: { api_key: apiKey, device_id: deviceId, created_at: new Date().toISOString() } };
	const file = configPath();
	const temp = `${file}.${process.pid}.guest.tmp`;
	fs.mkdirSync(dirname(file), { recursive: true });
	fs.writeFileSync(temp, `${JSON.stringify(next, undefined, '\t')}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
	logService.info('[Backboard] Guest access ready: free models work without signing in.');
}
