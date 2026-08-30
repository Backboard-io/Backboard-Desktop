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
 * These check login *state* without reading any secret material: file
 * existence, or the CLI's own status command (which reports a boolean,
 * never the credentials themselves).
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

/**
 * Whether the user has logged the Claude CLI into their subscription.
 * Fast path: the plaintext credential file (Linux / opt-out installs).
 * Authoritative path: `claude auth status`, which reports the CLI's own
 * view of its login state as JSON — covering every storage backend
 * (keychain, credential file, enterprise helpers) without guessing names.
 */
export async function isClaudeLoggedIn(): Promise<boolean> {
	const claude = findBinary('claude');
	if (!claude) {
		return false;
	}
	try {
		fs.accessSync(join(homedir(), '.claude', '.credentials.json'), fs.constants.R_OK);
		return true;
	} catch {
		// fall through to the CLI probe
	}
	return new Promise<boolean>(resolve => {
		execFile(claude, ['auth', 'status'], { timeout: 10_000 }, (err, stdout) => {
			if (err) {
				resolve(false);
				return;
			}
			try {
				resolve(JSON.parse(stdout).loggedIn === true);
			} catch {
				resolve(false);
			}
		});
	});
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
