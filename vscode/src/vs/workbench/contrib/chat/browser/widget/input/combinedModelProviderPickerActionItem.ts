/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { BaseActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { getAgentSessionProviderIcon, getAgentSessionProviderName } from '../../agentSessions/agentSessions.js';
import { AgentSessionTarget } from '../../agentSessions/agentSessions.js';
import { ISessionTypePickerDelegate } from '../../chat.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { IModelPickerDelegate } from './modelPickerActionItem.js';
import './media/combinedModelProviderPicker.css';

const FAVORITES_STORAGE_KEY = 'chat.combinedModelProviderPicker.favorites';
const FAVORITES_RAIL_ID = '__favorites__';

/**
 * A combined provider + model picker for the Sessions composer. A single chip
 * shows the active provider icon and the current model name; opening it reveals
 * a two-pane dropdown with a provider rail on the left (Backboard / Claude /
 * Codex / OpenCode, plus a Favorites bucket) and a searchable model list on the
 * right. Selecting a provider filters the list to that provider's models;
 * selecting a model commits the provider switch (if needed) and the model.
 *
 * The provider side is driven by an {@link ISessionTypePickerDelegate}; the
 * model side reuses the existing {@link IModelPickerDelegate}. Models for every
 * provider are read from {@link ILanguageModelsService} (filtered by
 * `targetChatSessionType`), so the rail can preview any provider's models
 * without switching the active session.
 */
export class CombinedModelProviderPickerActionItem extends BaseActionViewItem {

	private _triggerElement: HTMLElement | undefined;
	private _triggerIcon: HTMLElement | undefined;
	private _triggerLabel: HTMLElement | undefined;
	private readonly _overlay = this._register(new MutableDisposable());

	/** The provider whose models are currently shown in the list. */
	private _railProvider: string | undefined;
	private _searchValue = '';

	constructor(
		action: IAction,
		private readonly _modelDelegate: IModelPickerDelegate,
		private readonly _sessionTypeDelegate: ISessionTypePickerDelegate,
		private readonly _pickerOptions: IChatInputPickerOptions,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IStorageService private readonly _storageService: IStorageService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super(undefined, action);

		// Keep the trigger label in sync with external model/provider changes.
		this._register(autorun(reader => {
			this._modelDelegate.currentModel.read(reader);
			this._updateTrigger();
		}));
		this._register(this._languageModelsService.onDidChangeLanguageModels(() => this._updateTrigger()));
		if (this._sessionTypeDelegate.onDidChangeActiveSessionProvider) {
			this._register(this._sessionTypeDelegate.onDidChangeActiveSessionProvider(() => this._updateTrigger()));
		}
	}

	override render(container: HTMLElement): void {
		container.classList.add('chat-input-picker-item', 'combined-model-provider-picker-item');

		const trigger = this._triggerElement = dom.append(container, dom.$('a.action-label.combined-model-provider-trigger'));
		trigger.tabIndex = 0;
		trigger.setAttribute('role', 'button');
		trigger.setAttribute('aria-haspopup', 'true');
		this._triggerIcon = dom.append(trigger, dom.$('span.combined-model-provider-trigger-icon'));
		this._triggerLabel = dom.append(trigger, dom.$('span.combined-model-provider-trigger-label'));
		dom.append(trigger, dom.$(`span.combined-model-provider-trigger-chevron${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));

		this.element = trigger;
		this._register(dom.addDisposableListener(trigger, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			this._toggle();
		}));
		this._register(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space) || event.equals(KeyCode.DownArrow)) {
				dom.EventHelper.stop(e, true);
				this._toggle();
			}
		}));

		this._updateTrigger();
	}

	public openModelPicker(): void {
		if (!this._overlay.value) {
			this._toggle();
		}
	}

	private _allowedProviders(): AgentSessionTarget[] {
		return [...(this._sessionTypeDelegate.getAllowedSessionProviders?.() ?? [])];
	}

	private _activeProvider(): string | undefined {
		return this._sessionTypeDelegate.getActiveSessionProvider();
	}

	/** All models registered for the given provider (session type). */
	private _modelsForProvider(provider: string): ILanguageModelChatMetadataAndIdentifier[] {
		return this._languageModelsService.getLanguageModelIds()
			.map(id => {
				const metadata = this._languageModelsService.lookupLanguageModel(id);
				return metadata ? { metadata, identifier: id } : undefined;
			})
			.filter((m): m is ILanguageModelChatMetadataAndIdentifier => !!m && m.metadata.targetChatSessionType === provider)
			.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
	}

	private _resolveModel(identifier: string): ILanguageModelChatMetadataAndIdentifier | undefined {
		const metadata = this._languageModelsService.lookupLanguageModel(identifier);
		return metadata ? { metadata, identifier } : undefined;
	}

	private _favorites(): string[] {
		try {
			const raw = this._storageService.get(FAVORITES_STORAGE_KEY, StorageScope.PROFILE);
			return raw ? JSON.parse(raw) as string[] : [];
		} catch {
			return [];
		}
	}

	private _isFavorite(identifier: string): boolean {
		return this._favorites().includes(identifier);
	}

	private _toggleFavorite(identifier: string): void {
		const favorites = this._favorites();
		const index = favorites.indexOf(identifier);
		if (index === -1) {
			favorites.push(identifier);
		} else {
			favorites.splice(index, 1);
		}
		this._storageService.store(FAVORITES_STORAGE_KEY, JSON.stringify(favorites), StorageScope.PROFILE, StorageTarget.USER);
	}

	private _updateTrigger(): void {
		if (!this._triggerIcon || !this._triggerLabel) {
			return;
		}
		const provider = this._activeProvider();
		dom.clearNode(this._triggerIcon);
		if (provider) {
			this._triggerIcon.appendChild(renderIcon(getAgentSessionProviderIcon(provider as AgentSessionTarget)));
		}
		const model = this._modelDelegate.currentModel.get();
		this._triggerLabel.textContent = model?.metadata.name ?? localize('combinedPicker.auto', "Auto");
		this._triggerElement?.setAttribute('aria-label', localize('combinedPicker.ariaLabel', "Provider and model: {0}", this._triggerLabel.textContent));
	}

	private _toggle(): void {
		if (this._overlay.value) {
			this._overlay.clear();
			return;
		}
		this._show();
	}

	private _show(): void {
		const anchor = this.element ?? this._pickerOptions.getOverflowAnchor?.();
		if (!anchor) {
			return;
		}

		// Default the rail to the active provider each time the picker opens.
		this._railProvider = this._activeProvider() ?? this._allowedProviders()[0];
		this._searchValue = '';

		const store = new DisposableStore();
		this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				container.classList.add('combined-model-provider-overlay');
				this._renderOverlay(container, store);
				return store;
			},
			onHide: () => {
				this._overlay.clear();
			},
			anchorAlignment: AnchorAlignment.LEFT,
			anchorAxisAlignment: AnchorAxisAlignment.VERTICAL,
		});

		// Registered so re-toggling / disposal tears the overlay down.
		this._overlay.value = {
			dispose: () => {
				store.dispose();
				this._contextViewService.hideContextView();
			}
		};
	}

	private _renderOverlay(container: HTMLElement, store: DisposableStore): void {
		dom.clearNode(container);
		const root = dom.append(container, dom.$('.combined-model-provider-root'));

		// --- Left rail: providers + favorites ---
		const rail = dom.append(root, dom.$('.combined-model-provider-rail'));
		const addRailItem = (id: string, icon: ThemeIcon, label: string) => {
			const item = dom.append(rail, dom.$('.combined-model-provider-rail-item'));
			item.title = label;
			item.tabIndex = 0;
			item.setAttribute('role', 'button');
			item.setAttribute('aria-label', label);
			item.classList.toggle('active', this._railProvider === id);
			item.appendChild(renderIcon(icon));
			const select = () => {
				this._railProvider = id;
				this._renderOverlay(container, store);
				const search = container.querySelector<HTMLInputElement>('.combined-model-provider-search-input');
				search?.focus();
			};
			store.add(dom.addDisposableListener(item, dom.EventType.CLICK, select));
			store.add(dom.addDisposableListener(item, dom.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					dom.EventHelper.stop(e, true);
					select();
				}
			}));
		};

		addRailItem(FAVORITES_RAIL_ID, Codicon.star, localize('combinedPicker.favorites', "Favorites"));
		for (const provider of this._allowedProviders()) {
			addRailItem(provider, getAgentSessionProviderIcon(provider), getAgentSessionProviderName(provider));
		}

		// --- Right pane: search + model list ---
		const pane = dom.append(root, dom.$('.combined-model-provider-pane'));
		const searchRow = dom.append(pane, dom.$('.combined-model-provider-search'));
		searchRow.appendChild(renderIcon(Codicon.search));
		const search = dom.append(searchRow, dom.$('input.combined-model-provider-search-input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('combinedPicker.searchPlaceholder', "Search models…");
		search.value = this._searchValue;
		search.setAttribute('aria-label', localize('combinedPicker.searchPlaceholder', "Search models…"));

		const list = dom.append(pane, dom.$('.combined-model-provider-list'));

		const renderList = () => {
			dom.clearNode(list);
			const query = this._searchValue.trim().toLowerCase();
			const showingFavorites = this._railProvider === FAVORITES_RAIL_ID;
			const models = showingFavorites
				? this._favorites().map(id => this._resolveModel(id)).filter((m): m is ILanguageModelChatMetadataAndIdentifier => !!m)
				: this._modelsForProvider(this._railProvider ?? '');
			const filtered = query
				? models.filter(m => m.metadata.name.toLowerCase().includes(query) || (m.metadata.family ?? '').toLowerCase().includes(query))
				: models;

			if (filtered.length === 0) {
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = showingFavorites
					? localize('combinedPicker.noFavorites', "No favorite models yet")
					: localize('combinedPicker.noModels', "No models available");
				return;
			}

			const currentModelId = this._modelDelegate.currentModel.get()?.identifier;
			filtered.forEach((model, index) => {
				const providerId = model.metadata.targetChatSessionType ?? this._railProvider ?? '';
				const row = dom.append(list, dom.$('.combined-model-provider-row'));
				row.tabIndex = 0;
				row.setAttribute('role', 'button');
				if (model.identifier === currentModelId) {
					row.classList.add('selected');
				}

				const main = dom.append(row, dom.$('.combined-model-provider-row-main'));
				const nameRow = dom.append(main, dom.$('.combined-model-provider-row-name'));
				nameRow.textContent = model.metadata.name;
				if (model.identifier === currentModelId) {
					nameRow.appendChild(renderIcon(Codicon.check));
				}
				const sub = dom.append(main, dom.$('.combined-model-provider-row-sub'));
				sub.appendChild(renderIcon(getAgentSessionProviderIcon(providerId as AgentSessionTarget)));
				dom.append(sub, dom.$('span')).textContent = getAgentSessionProviderName(providerId as AgentSessionTarget);

				const aside = dom.append(row, dom.$('.combined-model-provider-row-aside'));
				if (index < 9) {
					dom.append(aside, dom.$('.combined-model-provider-row-kbd')).textContent = `⌘${index + 1}`;
				}
				const star = dom.append(aside, dom.$('.combined-model-provider-row-star'));
				const favorite = this._isFavorite(model.identifier);
				star.classList.toggle('is-favorite', favorite);
				star.appendChild(renderIcon(favorite ? Codicon.starFull : Codicon.star));
				star.title = favorite ? localize('combinedPicker.unfavorite', "Remove from favorites") : localize('combinedPicker.favorite', "Add to favorites");
				store.add(dom.addDisposableListener(star, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					this._toggleFavorite(model.identifier);
					renderList();
				}));

				const commit = () => this._commit(providerId, model);
				store.add(dom.addDisposableListener(row, dom.EventType.CLICK, commit));
				store.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
					const event = new StandardKeyboardEvent(e);
					if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
						dom.EventHelper.stop(e, true);
						commit();
					}
				}));
			});
		};

		store.add(dom.addDisposableListener(search, dom.EventType.INPUT, () => {
			this._searchValue = search.value;
			renderList();
		}));
		store.add(dom.addDisposableListener(search, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				this._overlay.clear();
				return;
			}
			// ⌘1..⌘9 quick-select the nth visible model.
			if (event.metaKey || event.ctrlKey) {
				const digit = event.keyCode >= KeyCode.Digit1 && event.keyCode <= KeyCode.Digit9
					? event.keyCode - KeyCode.Digit0
					: undefined;
				if (digit !== undefined) {
					dom.EventHelper.stop(e, true);
					const rows = list.querySelectorAll<HTMLElement>('.combined-model-provider-row');
					rows[digit - 1]?.click();
				}
			}
		}));

		renderList();
		setTimeout(() => search.focus(), 0);
	}

	private _commit(providerId: string, model: ILanguageModelChatMetadataAndIdentifier): void {
		if (providerId && providerId !== this._activeProvider() && this._sessionTypeDelegate.setActiveSessionProvider) {
			this._sessionTypeDelegate.setActiveSessionProvider(providerId as AgentSessionTarget);
		}
		this._modelDelegate.setModel(model);
		this._updateTrigger();
		this._overlay.clear();
	}
}
