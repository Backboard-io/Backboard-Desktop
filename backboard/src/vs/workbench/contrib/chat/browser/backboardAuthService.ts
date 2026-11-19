/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
	private readonly byoKey;
	private readonly resolvedKey;
	private readonly configResource;
	private readonly enabled = isBackboardProduct();
	/** Bounded retries while a slow/starting extension host leaves auth unknown. */
	private resolveRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private resolveRetryAttempts = 0;
	private fileRefreshRunning = false;
	private fileRefreshQueued = false;
	/** The latest answer from the CLI probe or a guest key; kept while a probe fails. */
	private probedAlternative = false;
	/** The latest answer from the CLI probe alone; kept while a probe fails. */
	private probedByo = false;

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
		this.byoKey = BackboardAuthContextKeys.byoConfigured.bindTo(contextKeyService);
		this.resolvedKey = BackboardAuthContextKeys.resolved.bindTo(contextKeyService);
		BackboardAuthContextKeys.enabled.bindTo(contextKeyService).set(this.enabled);
		this.configResource = backboardConfigResource(pathService);
		// A provider key in the IDE's own key store is a credential too; the CLI
		// probe only sees keys saved by the standalone CLI.
		const providerKeyKeys = new Set([BackboardAuthContextKeys.providerKeyConfigured.key]);
		this._register(contextKeyService.onDidChangeContext(event => {
			if (this.enabled && event.affectsSome(providerKeyKeys)) {
				this.contextKeyService.bufferChangeEvents(() => this.updateAlternative());
			}
		}));
		this._register(toDisposable(() => {
			if (this.resolveRetryTimer !== undefined) {
				clearTimeout(this.resolveRetryTimer);
				this.resolveRetryTimer = undefined;
			}
		}));
		this._register(commandService.onDidExecuteCommand(event => {
			if (credentialCommands.has(event.commandId)) {
				this.refreshInBackground();
			}
		}));
		void this.watchCredentials().catch(error => this.logService.error('[Backboard] Credential watcher failed', error));
	}

	private async watchCredentials(): Promise<void> {
		// Resolve the credential state before installing watchers. Watcher setup
		// must never be able to strand every auth gate in the signed-out state,
		// which is what happens if it throws before refresh() runs.
		await this.refresh();
		if (!this.enabled || this._store.isDisposed) { return; }
		const resource = await this.configResource;
		if (this._store.isDisposed) { return; }
		// Watch the directory: config writes replace the file atomically, and
		// a first-time installation may not have a config file yet.
		const cliDirectory = joinPath(dirname(dirname(resource)), '.backboard');
		const directories = [dirname(resource), cliDirectory];
		// Only the files the credential check reads. These directories also hold
		// session, model and tool caches the runtime rewrites constantly, and each
		// refresh spawns the CLI: reacting to those writes ran it several times a
		// second for as long as the window stayed open.
		const credentialFiles = [resource, joinPath(cliDirectory, 'config.json'), joinPath(cliDirectory, 'keys.json')];
		for (const directory of directories) {
			try {
				const watcher = this._register(this.fileService.createWatcher(directory, { recursive: false, excludes: [] }));
				this._register(watcher.onDidChange(event => {
					if (credentialFiles.some(file => event.contains(file))) {
						this.refreshForFileChange();
					}
				}));
			} catch (error) {
				this.logService.warn(`[Backboard] Credential watcher unavailable for ${directory.toString()}`, error);
			}
		}
	}

	/** One file-triggered check at a time; changes made while it runs share a single follow-up. */
	private refreshForFileChange(): void {
		if (this.fileRefreshRunning) {
			this.fileRefreshQueued = true;
			return;
		}
		this.fileRefreshRunning = true;
		void this.refresh()
			.catch(error => this.logService.error('[Backboard] Credential refresh failed', error))
			.finally(() => {
				this.fileRefreshRunning = false;
				if (this.fileRefreshQueued && !this._store.isDisposed) {
					this.fileRefreshQueued = false;
					this.refreshForFileChange();
				}
			});
	}

	private refreshInBackground(): void {
		void this.refresh().catch(error => this.logService.error('[Backboard] Credential refresh failed', error));
	}

	async refresh(): Promise<void> {
		const revision = ++this.revision;
		if (!this.enabled) {
			this.signedInKey.set(true);
			this.resolvedKey.set(true);
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
			// Preserve stable's free-model access without treating a guest key as sign-in.
			readBackboardConfigJson(this.fileService, resource).then(config => !!backboardConfigGuestApiKey(config), () => false),
		]);
		if (revision !== this.revision || this._store.isDisposed) { return; }
		this.contextKeyService.bufferChangeEvents(() => {
			this.signedInKey.set(signedIn);
			if (typeof alternative === 'boolean') {
				this.probedByo = alternative;
			}
			if (guest) {
				this.probedAlternative = true;
			} else if (typeof alternative === 'boolean') {
				this.probedAlternative = alternative;
			}
			this.updateAlternative();
			// Reports stay unknown until the probe actually produced an answer, so
			// a read-only gate can never mistake "not determined yet" for a logout.
			this.resolvedKey.set(signedIn || guest || typeof alternative === 'boolean' || this.hasProviderKey());
		});
		this.scheduleResolveRetry(signedIn || guest || typeof alternative === 'boolean');
	}

	private hasProviderKey(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.providerKeyConfigured.key) === true;
	}

	private updateAlternative(): void {
		const providerKey = this.hasProviderKey();
		this.alternativeKey.set(this.probedAlternative || providerKey);
		this.byoKey.set(this.probedByo || providerKey);
		if (providerKey) {
			this.resolvedKey.set(true);
		}
	}

	/** A slow extension host resolves a few seconds later; retry briefly. */
	private scheduleResolveRetry(resolved: boolean): void {
		if (resolved || this._store.isDisposed || this.resolveRetryTimer !== undefined) {
			return;
		}
		if (this.resolveRetryAttempts >= 5) {
			// Give up and fall back to the previous semantics. A probe that never
			// answers must not hide the sign-in entry points indefinitely.
			this.resolvedKey.set(true);
			return;
		}
		this.resolveRetryAttempts++;
		this.resolveRetryTimer = setTimeout(() => {
			this.resolveRetryTimer = undefined;
			this.refreshInBackground();
		}, 1_500);
	}
}

registerSingleton(IBackboardAuthService, BackboardAuthService, InstantiationType.Delayed);
