/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';

export const IAgentHostRememberedSessionConfigService = createDecorator<IAgentHostRememberedSessionConfigService>('agentHostRememberedSessionConfigService');

/**
 * Profile-scoped memory of the user's last session-config picks
 * (`SessionConfigKey` string values such as `autoApprove`, `isolation`,
 * `billing`). New agent-host sessions are seeded from this map so the last
 * choice becomes the default for the next session, across windows and
 * restarts.
 *
 * Single owner of the underlying storage key — consumers (the sessions
 * provider, the untitled provisional session service, composer widgets)
 * go through this service instead of poking the raw storage key.
 */
export interface IAgentHostRememberedSessionConfigService {
	readonly _serviceBrand: undefined;

	/** The remembered value for `property`, or `undefined` when the user never picked one. */
	get(property: string): string | undefined;

	/** Snapshot of all remembered values (safe keys only). */
	getAll(): Record<string, string>;

	/** Remember `value` as the user's pick for `property`. Non-string / unsafe keys are ignored. */
	set(property: string, value: unknown): void;
}

const STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES = 'sessions.agentHost.sessionConfigPicker.selectedValues';
const UNSAFE_SESSION_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeSessionConfigKey(property: string): boolean {
	return !UNSAFE_SESSION_CONFIG_KEYS.has(property);
}

export class AgentHostRememberedSessionConfigService implements IAgentHostRememberedSessionConfigService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) { }

	get(property: string): string | undefined {
		return this.getAll()[property];
	}

	getAll(): Record<string, string> {
		const raw = this._storageService.getObject<Record<string, unknown>>(STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES, StorageScope.PROFILE, {});
		const values = Object.create(null) as Record<string, string>;
		for (const [property, value] of Object.entries(raw)) {
			if (typeof value === 'string' && isSafeSessionConfigKey(property)) {
				values[property] = value;
			}
		}
		return values;
	}

	set(property: string, value: unknown): void {
		if (typeof value !== 'string' || !isSafeSessionConfigKey(property)) {
			return;
		}
		const next = this.getAll();
		next[property] = value;
		this._storageService.store(STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

registerSingleton(IAgentHostRememberedSessionConfigService, AgentHostRememberedSessionConfigService, InstantiationType.Delayed);
