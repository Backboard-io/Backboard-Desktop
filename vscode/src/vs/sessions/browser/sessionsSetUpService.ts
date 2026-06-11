/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { IChatEntitlementService } from '../../workbench/services/chat/common/chatEntitlementService.js';
import { WELCOME_COMPLETE_KEY } from '../common/welcome.js';

const AIDisabledConfig = 'chat.disableAIFeatures';

export const ISessionsSetUpService = createDecorator<ISessionsSetUpService>('sessionsSetUpService');

export interface ISessionsSetUpService {
	readonly _serviceBrand: undefined;
	/**
	 * Resolves when the welcome/setup flow has completed (or immediately
	 * if it is not currently active). Use this to defer work until after
	 * the user has finished the initial sign-in or setup dialog.
	 */
	whenWelcomeDone(): Promise<void>;
}

function shouldSkipSessionsWelcome(environmentService: IWorkbenchEnvironmentService): boolean {
	if (environmentService.enableSmokeTestDriver) {
		return true;
	}
	const envArgs = (environmentService as IWorkbenchEnvironmentService & { args?: Record<string, unknown> }).args;
	if (envArgs?.['skip-sessions-welcome']) {
		return true;
	}
	return typeof globalThis.location !== 'undefined' && new URLSearchParams(globalThis.location.search).has('skip-sessions-welcome');
}

class SessionsSetUpWidget extends Disposable {

	constructor(
		private readonly onCompleted: () => void,
		private readonly serviceMarkDone: () => void,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._start();
	}

	private _start(): void {
		if (shouldSkipSessionsWelcome(this.environmentService)) {
			this.onCompleted();
			return;
		}

		this._completeBackboardSetup();
	}

	private async _completeBackboardSetup(): Promise<void> {
		this.logService.info('[sessions welcome] Completing setup through Backboard; GitHub and VS Code sign-in prompts are disabled.');

		if (this.configurationService.getValue<boolean>(AIDisabledConfig)) {
			this.logService.info('[sessions welcome] AI features disabled, enabling for Backboard agents');
			await this.configurationService.updateValue(AIDisabledConfig, false);
		}

		if (this._store.isDisposed) {
			return;
		}

		this.storageService.store(WELCOME_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.serviceMarkDone();
		this.onCompleted();
	}
}

export class SessionsSetUpService extends Disposable implements ISessionsSetUpService {

	declare readonly _serviceBrand: undefined;

	private readonly _welcomeDoneDeferred = new DeferredPromise<void>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
		super();

		this._register(this.instantiationService.createInstance(
			SessionsSetUpWidget,
			() => this._welcomeDoneDeferred.complete(),
			() => this.markDone()
		));
	}

	private markDone(): void {
		this.chatEntitlementService.markSetupCompleted();
	}

	whenWelcomeDone(): Promise<void> {
		return this._welcomeDoneDeferred.p;
	}
}
