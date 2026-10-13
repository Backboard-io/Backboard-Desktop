/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { BYOK_KEY_STORE_CHANNEL, IByokKeyStatus, IByokKeyStore } from '../../../../../platform/agentHost/common/byokKeyStore.js';
import { BYOK_PROVIDERS, ByokProviderId } from '../../../../../platform/agentHost/common/byokProviders.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ByokKeyValidationError, IByokKeysService } from '../../browser/agentSessions/agentHost/byokKeysService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { BackboardAuthContextKeys } from '../../common/backboardAuth.js';

/**
 * Desktop {@link IByokKeysService}: a client of the main-process key store.
 * Statuses arrive from the owner and are cached so the page can read them
 * synchronously; every mutation is forwarded and its outcome turned back
 * into a typed error.
 */
export class ByokKeysService extends Disposable implements IByokKeysService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _owner: IByokKeyStore;
	/** The latest statuses from the owner; rows exist before the first answer so the page never renders empty. */
	private _statuses: readonly IByokKeyStatus[] = BYOK_PROVIDERS.map(definition => ({
		provider: definition.id,
		label: definition.label,
		keyHint: definition.keyHint,
		consoleUrl: definition.consoleUrl,
		configured: false,
		connected: false,
		persistence: 'unknown',
	}));

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService logService: ILogService,
	) {
		super();
		this._owner = this._createStore(mainProcessService);
		this._register(this._owner.onDidChange(statuses => this._accept(statuses)));
		this._owner.list().then(
			statuses => this._accept(statuses),
			error => logService.warn(`[byok] could not read key statuses: ${error instanceof Error ? error.message : String(error)}`),
		);
	}

	/** The owner in the main process; tests substitute an in-process store. */
	protected _createStore(mainProcessService: IMainProcessService): IByokKeyStore {
		return ProxyChannel.toService<IByokKeyStore>(mainProcessService.getChannel(BYOK_KEY_STORE_CHANNEL));
	}

	list(): readonly IByokKeyStatus[] {
		return this._statuses;
	}

	async add(provider: ByokProviderId, key: string): Promise<void> {
		const outcome = await this._owner.add(provider, key);
		if (!outcome.ok) {
			throw new ByokKeyValidationError(outcome.message, outcome.category);
		}
	}

	async remove(provider: ByokProviderId): Promise<void> {
		const outcome = await this._owner.remove(provider);
		if (!outcome.ok) {
			throw new Error(outcome.message);
		}
	}

	async test(provider: ByokProviderId): Promise<void> {
		const outcome = await this._owner.test(provider);
		if (!outcome.ok) {
			throw new ByokKeyValidationError(outcome.message, outcome.category);
		}
	}

	private _accept(statuses: readonly IByokKeyStatus[]): void {
		this._statuses = statuses;
		this._onDidChange.fire();
	}
}

registerSingleton(IByokKeysService, ByokKeysService, InstantiationType.Delayed);

/**
 * Publishes whether the key store holds any provider key, so the Backboard
 * sign-in gates let a key-only user through just like a signed-in one.
 */
class ByokProviderKeyContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.byokProviderKeyContext';

	constructor(
		@IByokKeysService keys: IByokKeysService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const configured = BackboardAuthContextKeys.providerKeyConfigured.bindTo(contextKeyService);
		const update = () => configured.set(keys.list().some(status => status.configured));
		update();
		this._register(keys.onDidChange(update));
	}
}

registerWorkbenchContribution2(ByokProviderKeyContextContribution.ID, ByokProviderKeyContextContribution, WorkbenchPhase.BlockRestore);
