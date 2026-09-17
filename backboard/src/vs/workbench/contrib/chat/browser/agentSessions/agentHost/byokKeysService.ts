/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../../base/common/event.js';
import { IByokKeyStatus } from '../../../../../../platform/agentHost/common/byokKeyStore.js';
import { ByokProviderId } from '../../../../../../platform/agentHost/common/byokProviders.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';

export type { IByokKeyStatus } from '../../../../../../platform/agentHost/common/byokKeyStore.js';

/** A vendor rejected or could not verify a key. `category` is safe to show. */
export class ByokKeyValidationError extends Error {
	constructor(message: string, readonly category: string) {
		super(message);
		this.name = 'ByokKeyValidationError';
	}
}

export const IByokKeysService = createDecorator<IByokKeysService>('byokKeysService');

/**
 * The window's view of the user's provider API keys. The main process owns
 * the keys: it validates, persists, activates, and hands them to the agent
 * host, and every window sees the same statuses. Nothing in a window ever
 * holds a key beyond passing a freshly typed one through. The desktop
 * implementation lives in `electron-browser`.
 */
export interface IByokKeysService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	list(): readonly IByokKeyStatus[];
	/** Validate in the runtime, persist, then activate. Rejects with {@link ByokKeyValidationError} when the vendor refuses the key. */
	add(provider: ByokProviderId, key: string): Promise<void>;
	/** Delete the key and deactivate it in every running runtime. */
	remove(provider: ByokProviderId): Promise<void>;
	/** Re-validate the stored key without re-activating it. */
	test(provider: ByokProviderId): Promise<void>;
}
