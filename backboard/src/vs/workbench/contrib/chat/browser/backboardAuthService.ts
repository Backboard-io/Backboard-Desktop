/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardAuthContextKeys, backboardConfigGuestApiKey, backboardConfigResource, hasBackboardCredentials, IBackboardAuthService, isBackboardProduct, readBackboardConfigJson } from '../common/backboardAuth.js';

const credentialCommands = new Set([
	'backboard.setupSubscription',
	'backboard.signIn', 'backboard.extension.signIn', 'backboard.signOut',
	'backboard.setApiKey', 'backboard.setupProviderKey', 'backboard.configureProviderKey',
]);

/** Owns auth state at window scope, so constructing a view cannot reset a login. */
export class BackboardAuthService extends Disposable implements IBackboardAuthService {
	declare readonly _serviceBrand: undefined;
	private revision = 0;
	private readonly signedInKey;
	private readonly alternativeKey;
	private readonly configResource;
	private readonly enabled = isBackboardProduct();

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IPathService pathService: IPathService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.signedInKey = BackboardAuthContextKeys.signedIn.bindTo(contextKeyService);
		this.alternativeKey = BackboardAuthContextKeys.alternativeConfigured.bindTo(contextKeyService);
		BackboardAuthContextKeys.enabled.bindTo(contextKeyService).set(this.enabled);
		this.configResource = backboardConfigResource(pathService);
		this._register(commandService.onDidExecuteCommand(event => {
			if (credentialCommands.has(event.commandId)) {
				this.refreshInBackground();
			}
		}));
		void this.watchCredentials().catch(error => this.logService.error('[Backboard] Credential watcher failed', error));
	}

	private async watchCredentials(): Promise<void> {
		if (this.enabled) {
			const resource = await this.configResource;
			if (this._store.isDisposed) { return; }
			// Watch the directory: config writes replace the file atomically, and
			// a first-time installation may not have a config file yet.
			const directories = [dirname(resource), joinPath(dirname(dirname(resource)), '.backboard')];
			for (const directory of directories) {
				const watcher = this._register(this.fileService.createWatcher(directory, { recursive: false, excludes: [] }));
				this._register(watcher.onDidChange(() => this.refreshInBackground()));
			}
		}
		await this.refresh();
	}

	private refreshInBackground(): void {
		void this.refresh().catch(error => this.logService.error('[Backboard] Credential refresh failed', error));
	}

	async refresh(): Promise<void> {
		const revision = ++this.revision;
		if (!this.enabled) {
			this.signedInKey.set(true);
			return;
		}
		const resource = await this.configResource;
		const [signedIn, alternative, guest] = await Promise.all([
			hasBackboardCredentials(this.fileService, resource).then(signedIn => {
				// SSO must unblock immediately, even while a subscription probe starts.
				if (revision === this.revision && !this._store.isDisposed) { this.signedInKey.set(signedIn); }
				return signedIn;
			}),
			// A failed/starting extension host is not evidence of a logout.
			this.commandService.executeCommand<boolean>('backboard.hasAlternativeCredentials').catch(() => undefined),
			// A guest key runs the free models, so chat opens without a sign-in.
			readBackboardConfigJson(this.fileService, resource).then(config => !!backboardConfigGuestApiKey(config), () => false),
		]);
		if (revision !== this.revision || this._store.isDisposed) { return; }
		this.contextKeyService.bufferChangeEvents(() => {
			this.signedInKey.set(signedIn);
			if (guest) {
				this.alternativeKey.set(true);
			} else if (typeof alternative === 'boolean') {
				this.alternativeKey.set(alternative);
			}
		});
	}
}

registerSingleton(IBackboardAuthService, BackboardAuthService, InstantiationType.Delayed);
