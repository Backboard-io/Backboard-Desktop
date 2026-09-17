/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { ByokProviderId } from './byokProviders.js';

/** IPC channel on which the main process exposes the {@link IByokKeyStore}. */
export const BYOK_KEY_STORE_CHANNEL = 'byokKeyStore';

export interface IByokKeyStatus {
	readonly provider: ByokProviderId;
	readonly label: string;
	readonly keyHint: string;
	readonly consoleUrl: string;
	/** A key is stored for this provider. */
	readonly configured: boolean;
	readonly masked?: string;
	readonly addedAt?: number;
	readonly lastValidatedAt?: number;
	readonly lastError?: string;
	readonly lastErrorCategory?: string;
	/** Stored and confirmed active by the agent host; false means "saved, connection pending". */
	readonly connected: boolean;
	/** Whether secret storage on this machine survives a restart. */
	readonly persistence: 'persisted' | 'in-memory' | 'unknown';
}

/**
 * The outcome of a key operation. Failures travel as data rather than thrown
 * errors so the category survives the IPC boundary; the renderer turns them
 * back into typed errors for the page.
 */
export type ByokKeyOperationOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string; readonly category: string };

/**
 * One owner for the user's provider API keys: persistence, validation, and
 * activation in the agent host, in one process, so no two windows can race
 * a replacement against a removal. Statuses never contain a key.
 */
export interface IByokKeyStore {
	/** Fires with the full status list whenever anything about a key changes. */
	readonly onDidChange: Event<readonly IByokKeyStatus[]>;
	list(): Promise<readonly IByokKeyStatus[]>;
	/** Validate in the runtime, persist, then activate. Nothing is stored for a rejected key. */
	add(provider: ByokProviderId, key: string): Promise<ByokKeyOperationOutcome>;
	/** Delete the key and deactivate it in every running runtime. */
	remove(provider: ByokProviderId): Promise<ByokKeyOperationOutcome>;
	/** Re-validate the stored key without re-activating it. */
	test(provider: ByokProviderId): Promise<ByokKeyOperationOutcome>;
}

/** First seven and last four characters; the same rule the CLI's `/keys` uses. */
export function maskKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length <= 12) {
		return '*'.repeat(Math.max(trimmed.length, 4));
	}
	return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
