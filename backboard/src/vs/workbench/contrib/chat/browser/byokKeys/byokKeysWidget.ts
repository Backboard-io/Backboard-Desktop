/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { byokProviderDefinition, ByokProviderId } from '../../../../../platform/agentHost/common/byokProviders.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ByokKeyValidationError, IByokKeysService, IByokKeyStatus } from '../agentSessions/agentHost/byokKeysService.js';

const $ = dom.$;

/**
 * The API Keys page body: one row per supported provider with its status and
 * the Add or Replace, Test, and Remove actions. The secret is only ever typed
 * into a password-masked input and handed straight to the key service.
 */
export class ByokKeysWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _rowDisposables = this._register(new DisposableStore());
	private readonly _busy = new Set<ByokProviderId>();
	private _rows: HTMLElement | undefined;
	private _rendered = false;
	/** The first action button, so the page has a sensible initial focus target. */
	private _firstButton: Button | undefined;

	constructor(
		@IByokKeysService private readonly _keys: IByokKeysService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this.element = $('.backboard-api-keys');
		this._register(this._keys.onDidChange(() => this._renderRows()));
	}

	render(): void {
		if (this._rendered) {
			this._renderRows();
			return;
		}
		this._rendered = true;
		const header = dom.append(this.element, $('.backboard-api-keys-header'));
		dom.append(header, $('h2.backboard-api-keys-title')).textContent = localize('byokKeys.title', "API Keys");
		dom.append(header, $('p.backboard-api-keys-description')).textContent = localize(
			'byokKeys.description',
			"Models billed to your own key appear in the model picker as OpenAI API Key or Anthropic API Key. Backboard models are unaffected. Keys are stored in your OS keychain and sent only to the provider that issued them. Validation checks access, not quota.",
		);
		this._rows = dom.append(this.element, $('.backboard-api-keys-rows'));
		this._renderRows();
	}

	layout(height: number): void {
		this.element.style.maxHeight = `${height}px`;
	}

	focus(): void {
		this._firstButton?.focus();
	}

	private _renderRows(): void {
		if (!this._rows) {
			return;
		}
		this._rowDisposables.clear();
		this._firstButton = undefined;
		dom.clearNode(this._rows);
		for (const status of this._keys.list()) {
			this._renderRow(status);
		}
	}

	private _renderRow(status: IByokKeyStatus): void {
		const row = dom.append(this._rows!, $('.backboard-api-keys-row'));
		row.setAttribute('role', 'group');
		row.setAttribute('aria-label', localize('byokKeys.rowLabel', "{0} API key", status.label));
		const icon = dom.append(row, $(`.backboard-api-keys-icon.provider-${status.provider}`));
		icon.setAttribute('aria-hidden', 'true');
		const main = dom.append(row, $('.backboard-api-keys-main'));
		dom.append(main, $('.backboard-api-keys-name')).textContent = status.label;
		const statusLine = dom.append(main, $('.backboard-api-keys-status'));
		statusLine.textContent = describeStatus(status);
		statusLine.classList.toggle('error', !!status.lastError);
		const console = dom.append(main, $<HTMLAnchorElement>('a.backboard-api-keys-console'));
		console.href = status.consoleUrl;
		console.textContent = localize('byokKeys.console', "Get a key from {0}", status.label);
		this._rowDisposables.add(dom.addDisposableListener(console, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			void this._openerService.open(URI.parse(status.consoleUrl));
		}));

		const actions = dom.append(row, $('.backboard-api-keys-actions'));
		const busy = this._busy.has(status.provider);
		const addButton = this._button(actions, status.configured
			? localize('byokKeys.replace', "Replace Key")
			: localize('byokKeys.add', "Add Key"), !busy, false, () => this._addOrReplace(status));
		this._rowDisposables.add(addButton);
		this._firstButton ??= addButton;
		if (status.configured) {
			this._rowDisposables.add(this._button(actions, localize('byokKeys.test', "Test"), !busy, true, () => this._test(status)));
			this._rowDisposables.add(this._button(actions, localize('byokKeys.remove', "Remove"), !busy, true, () => this._remove(status)));
		}
	}

	private _button(container: HTMLElement, label: string, enabled: boolean, secondary: boolean, run: () => Promise<void>): Button {
		const button = new Button(container, { ...defaultButtonStyles, secondary });
		button.label = label;
		button.enabled = enabled;
		this._rowDisposables.add(button.onDidClick(() => { void run(); }));
		return button;
	}

	/** Runs one action per provider at a time; the row re-renders around it. */
	private async _withBusy(provider: ByokProviderId, run: () => Promise<void>): Promise<void> {
		if (this._busy.has(provider)) {
			return;
		}
		this._busy.add(provider);
		this._renderRows();
		try {
			await run();
		} finally {
			this._busy.delete(provider);
			this._renderRows();
		}
	}

	private async _addOrReplace(status: IByokKeyStatus): Promise<void> {
		let initialValue = '';
		while (true) {
			const key = await this._promptForKey(status, initialValue);
			if (key === undefined) {
				return;
			}
			let failure: unknown;
			await this._withBusy(status.provider, async () => {
				try {
					await this._progressService.withProgress(
						{ location: ProgressLocation.Notification, title: localize('byokKeys.validating', "Validating {0} key…", status.label) },
						() => this._keys.add(status.provider, key),
					);
				} catch (error) {
					failure = error;
				}
			});
			if (failure === undefined) {
				this._notificationService.info(localize('byokKeys.connected', "{0} key connected. Models billed to it appear in the model picker under {0} API Key.", status.label));
				return;
			}
			this._notificationService.error(guidanceFor(status.label, failure));
			// Keep the entry so a typo costs one correction, not a fresh paste.
			initialValue = key;
		}
	}

	private async _test(status: IByokKeyStatus): Promise<void> {
		await this._withBusy(status.provider, async () => {
			try {
				await this._progressService.withProgress(
					{ location: ProgressLocation.Notification, title: localize('byokKeys.testing', "Testing {0} key…", status.label) },
					() => this._keys.test(status.provider),
				);
				this._notificationService.info(localize('byokKeys.testPassed', "{0} accepted the stored key.", status.label));
			} catch (error) {
				this._notificationService.error(guidanceFor(status.label, error));
			}
		});
	}

	private async _remove(status: IByokKeyStatus): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('byokKeys.removeTitle', "Remove the {0} API key?", status.label),
			detail: localize('byokKeys.removeDetail', "The key is deleted from your keychain. Sessions using {0} API Key models will need another key or a different model.", status.label),
			primaryButton: localize({ key: 'byokKeys.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
		});
		if (!confirmed) {
			return;
		}
		await this._withBusy(status.provider, async () => {
			try {
				await this._keys.remove(status.provider);
				this._notificationService.info(localize('byokKeys.removed', "{0} key removed.", status.label));
			} catch (error) {
				this._notificationService.error(error instanceof Error ? error.message : String(error));
			}
		});
	}

	private _promptForKey(status: IByokKeyStatus, initialValue: string): Promise<string | undefined> {
		const definition = byokProviderDefinition(status.provider);
		return new Promise<string | undefined>(resolve => {
			const store = new DisposableStore();
			const input = store.add(this._quickInputService.createInputBox());
			input.title = localize('byokKeys.inputTitle', "{0} API Key", status.label);
			input.placeholder = status.keyHint;
			input.password = true;
			input.ignoreFocusOut = true;
			input.value = initialValue;
			input.prompt = localize('byokKeys.inputPrompt', "Paste a key from {0}. It is stored in your OS keychain and sent only to {1}.", status.consoleUrl, status.label);
			const validate = (): boolean => {
				const value = input.value.trim();
				const acceptable = !value || definition.looksLikeKey(value);
				input.validationMessage = acceptable ? undefined : localize('byokKeys.shape', "That does not look like a {0} key (expected {1}).", status.label, status.keyHint);
				input.severity = acceptable ? Severity.Ignore : Severity.Error;
				return acceptable && !!value;
			};
			validate();
			let accepted: string | undefined;
			store.add(input.onDidChangeValue(() => validate()));
			store.add(input.onDidAccept(() => {
				if (!validate()) {
					return;
				}
				accepted = input.value.trim();
				input.hide();
			}));
			store.add(input.onDidHide(() => {
				store.dispose();
				resolve(accepted);
			}));
			input.show();
		});
	}
}

function describeStatus(status: IByokKeyStatus): string {
	if (!status.configured) {
		return localize('byokKeys.notSet', "Not set");
	}
	const parts: string[] = [
		status.connected
			? localize('byokKeys.statusConnected', "Connected")
			: localize('byokKeys.statusPending', "Saved, connection pending"),
	];
	if (status.masked) {
		parts.push(status.masked);
	}
	if (status.addedAt) {
		parts.push(localize('byokKeys.addedOn', "added {0}", new Date(status.addedAt).toLocaleDateString()));
	}
	if (status.lastError) {
		parts.push(localize('byokKeys.rejectedOnTest', "rejected on last test: {0}", status.lastError));
	}
	if (status.persistence === 'in-memory') {
		parts.push(localize('byokKeys.inMemory', "available until Backboard closes"));
	}
	return parts.join(' · ');
}

/** Turns a validation outcome into the one line the user can act on. */
function guidanceFor(label: string, error: unknown): string {
	if (error instanceof ByokKeyValidationError) {
		switch (error.category) {
			case 'invalid-key':
				return localize('byokKeys.guidance.invalid', "{0} rejected this key. Check it was copied in full and is still active.", label);
			case 'insufficient-permissions':
				return localize('byokKeys.guidance.permissions', "This {0} key is not allowed to list models. Check its permissions in the {0} console.", label);
			case 'offline-or-timeout':
				return localize('byokKeys.guidance.offline', "{0} could not be reached. Check your connection and try again.", label);
			case 'rate-limited':
				return localize('byokKeys.guidance.rateLimited', "{0} is rate limiting requests right now. Try again in a moment.", label);
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : String(error);
}
