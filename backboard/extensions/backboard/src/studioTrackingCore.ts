/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';

export type StudioSignInSource = 'sign_in' | 'startup';

/** Maps Node's platform and arch to the Backboard release name, e.g. `macos-aarch64`. */
export function studioPlatform(platform: string, arch: string): string | undefined {
	const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
	const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
	return os && cpu ? `${os}-${cpu}` : undefined;
}

/** Mirrors the workbench's `getTelemetryLevel`: only the default "all" level allows usage data. */
export function usageTelemetryAllowed(telemetryLevel: string | undefined, enableTelemetry: boolean | undefined, enableCrashReporter: boolean | undefined): boolean {
	if (enableTelemetry === false || enableCrashReporter === false) {
		return false;
	}
	return (telemetryLevel ?? 'all') === 'all';
}

/**
 * A credential the IDE already held when it started is a session from before tracking
 * (or from an earlier launch), not a new sign-in; any other credential was just signed in.
 */
export function signInSource(fingerprint: string, startupFingerprint: string | undefined): StudioSignInSource {
	return fingerprint === startupFingerprint ? 'startup' : 'sign_in';
}

/** A digest of the backend and credential, so each sign-in is reported once without storing the credential. */
export function credentialFingerprint(baseUrl: string, headers: Readonly<Record<string, string>>): string {
	const hash = crypto.createHash('sha256').update(baseUrl);
	for (const name of Object.keys(headers).sort()) {
		hash.update(`\n${name.toLowerCase()}:${headers[name]}`);
	}
	return hash.digest('hex');
}

/** POSTs `body` as JSON and resolves with the HTTP status code; rejects on network errors and timeouts. */
export function postJson(url: string, headers: Readonly<Record<string, string>>, body: unknown, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const transport = target.protocol === 'http:' ? http : https;
		const payload = JSON.stringify(body);
		const request = transport.request(target, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() },
			timeout: timeoutMs,
		}, response => {
			response.resume();
			response.on('end', () => resolve(response.statusCode ?? 0));
		});
		request.on('timeout', () => request.destroy(new Error(`Request to ${target.origin} timed out after ${timeoutMs} ms.`)));
		request.on('error', reject);
		request.end(payload);
	});
}
