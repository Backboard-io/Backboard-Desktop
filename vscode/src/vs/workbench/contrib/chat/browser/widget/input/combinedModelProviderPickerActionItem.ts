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
import { AgentSessionProviders, AgentSessionTarget, getAgentSessionProviderIcon, getAgentSessionProviderName } from '../../agentSessions/agentSessions.js';
import { ISessionTypePickerDelegate } from '../../chat.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { IModelPickerDelegate, IModelPickerSetupCandidate } from './modelPickerActionItem.js';
import './media/combinedModelProviderPicker.css';

const FAVORITES_STORAGE_KEY = 'chat.combinedModelProviderPicker.favorites';
const FAVORITES_RAIL_ID = '__favorites__';
const RECOMMENDED_BACKBOARD_MODEL_IDS = [
	'anthropic/claude-fable-5',
	'anthropic/claude-opus-5',
	'anthropic/claude-sonnet-5',
	'aws-bedrock/anthropic.claude-fable-5',
	'aws-bedrock/anthropic.claude-opus-5',
	'aws-bedrock/anthropic.claude-sonnet-4-6',
	'cerebras/openai/gpt-oss-120b',
	'cerebras/qwen/qwen3-235b-a22b-2507',
	'cerebras/z-ai/glm-4.7',
	'cohere/command-a-reasoning-08-2025',
	'cohere/command-a-03-2025',
	'cohere/command-r-plus-08-2024',
	'google/gemini-3.6-flash',
	'google/gemini-3.5-flash',
	'google/gemini-3.1-pro-preview',
	'openai/gpt-5.6-sol',
	'openai/gpt-5.6-terra',
	'openai/gpt-5.6-luna',
	'openai/gpt-5.5-pro',
	'openrouter/deepseek/deepseek-v4-pro',
	'openrouter/moonshotai/kimi-k3',
	'openrouter/qwen/qwen3.7-max',
	'xai/grok-4.20-0309-reasoning',
	'xai/grok-4.5',
	'xai/grok-build-0.1',
] as const;
const RECOMMENDED_BACKBOARD_MODEL_PRIORITY = new Map<string, number>(
	RECOMMENDED_BACKBOARD_MODEL_IDS.map((id, index) => [id, index])
);

/** Turn provider model ids into compact user-facing labels for the composer. */
function formatModelLabel(name: string): string {
	const modelName = name.split('/').pop() || name;
	return modelName
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(part => {
			const lower = part.toLowerCase();
			if (lower === 'gpt') {
				return 'GPT';
			}
			if (lower === 'ai') {
				return 'AI';
			}
			if (/^\d/.test(part)) {
				return part;
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(' ');
}

/**
 * A combined provider + model picker for the Sessions composer. A single chip
 * shows the active provider icon and the current model name; opening it reveals
 * a two-pane dropdown with a provider rail on the left (Backboard / Claude /
 * Codex, plus a Favorites bucket) and a searchable model list on the
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
	private _showAllBackboardModels = false;

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

	/**
	 * Providers the current chat may actually select. Started chats retain the
	 * provider they were created with, even if the host's draft allowlist has
	 * since changed (for example, a historical Claude session in Simple mode).
	 */
	private _selectableProviders(): AgentSessionTarget[] {
		const activeProvider = this._activeProvider();
		if (activeProvider && this._sessionTypeDelegate.canChangeSessionProvider?.() === false) {
			return [activeProvider as AgentSessionTarget];
		}
		return this._allowedProviders();
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
		const setupCandidate = this._setupCandidate(provider);
		if (setupCandidate) {
			this._triggerLabel.textContent = localize('combinedPicker.installProvider', "Install {0}", setupCandidate.label);
			this._triggerElement?.setAttribute('aria-label', this._triggerLabel.textContent);
			return;
		}
		const model = this._modelDelegate.currentModel.get();
		// Keep the composer chip model-only. Provider attribution belongs in the
		// expanded picker, where it has enough room to be useful.
		const name = model?.metadata.name;
		this._triggerLabel.textContent = name ? formatModelLabel(name) : localize('combinedPicker.auto', "Auto");
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

		// Default to the active provider only when this host explicitly allows it.
		// This prevents a stored subscription-backed provider from leaking back
		// into a Backboard-only Simple-mode picker.
		const allowedProviders = this._selectableProviders();
		const activeProvider = this._activeProvider();
		this._railProvider = activeProvider && allowedProviders.includes(activeProvider as AgentSessionTarget)
			? activeProvider
			: allowedProviders[0];
		this._searchValue = '';
		this._showAllBackboardModels = false;

		const store = new DisposableStore();
		this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				container.classList.add('combined-model-provider-overlay');
				this._renderOverlay(container, store);
				// The base ContextView only auto-hides for interactions outside the
				// whole workbench container, so a click elsewhere in the window would
				// leave the overlay open. Dismiss on any pointer-down outside the
				// overlay; the trigger chip is exempt so its own click handler can
				// toggle without immediately reopening.
				store.add(dom.addDisposableListener(dom.getWindow(container), dom.EventType.MOUSE_DOWN, e => {
					const target = e.target;
					if (target instanceof Node && (dom.isAncestor(target, container) || (this._triggerElement && dom.isAncestor(target, this._triggerElement)))) {
						return;
					}
					this._overlay.clear();
				}, true));
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
		for (const provider of this._selectableProviders()) {
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
		const footer = dom.append(pane, dom.$('.combined-model-provider-footer'));

		const renderList = () => {
			dom.clearNode(list);
			dom.clearNode(footer);
			const query = this._searchValue.trim().toLowerCase();
			const showingFavorites = this._railProvider === FAVORITES_RAIL_ID;
			const allowedModelIds = new Set(this._selectableProviders().flatMap(provider => this._modelsForProvider(provider).map(model => model.identifier)));
			const allModels = showingFavorites
				? this._favorites()
					.map(id => this._resolveModel(id))
					.filter((model): model is ILanguageModelChatMetadataAndIdentifier => !!model && allowedModelIds.has(model.identifier))
				: this._modelsForProvider(this._railProvider ?? '');
			// Provider/model registrations can outlive the CLI process that supplied
			// them. Setup state wins over a stale catalog: never let those models be
			// selected and applied to the fallback Backboard session.
			const setupCandidate = !showingFavorites ? this._setupCandidate() : undefined;
			if (setupCandidate) {
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = localize('combinedPicker.notSetUp', "{0} is not set up yet", setupCandidate.label);
				this._renderSetupPrompt(list, store, setupCandidate);
				return;
			}
			const showingBackboard = this._railProvider === AgentSessionProviders.AgentHostBackboard;
			const recommendedModels = showingBackboard
				? allModels
					.filter(model => RECOMMENDED_BACKBOARD_MODEL_PRIORITY.has(model.metadata.id))
					.sort((a, b) => (RECOMMENDED_BACKBOARD_MODEL_PRIORITY.get(a.metadata.id) ?? Number.MAX_SAFE_INTEGER) - (RECOMMENDED_BACKBOARD_MODEL_PRIORITY.get(b.metadata.id) ?? Number.MAX_SAFE_INTEGER))
				: allModels;
			// Model catalogs change independently of the desktop build. If none of
			// the curated ids exist in the live Backboard catalog, show the live
			// catalog instead of rendering an empty picker.
			const hasRecommendedBackboardModels = showingBackboard && recommendedModels.length > 0;
			const showRecommendedBackboardModels = hasRecommendedBackboardModels && !query && !this._showAllBackboardModels;
			const models = showRecommendedBackboardModels ? recommendedModels : allModels;
			const filtered = query
				? models.filter(m => m.metadata.name.toLowerCase().includes(query) || (m.metadata.family ?? '').toLowerCase().includes(query) || (m.metadata.detail ?? '').toLowerCase().includes(query))
				: models;

			if (filtered.length === 0) {
				// Only offer setup when the provider genuinely has nothing
				// registered — not when a search simply matched no model.
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = showingFavorites
					? localize('combinedPicker.noFavorites', "No favorite models yet")
					: localize('combinedPicker.noModels', "No models available");
				return;
			}

			if (showingBackboard && !query) {
				const heading = dom.append(list, dom.$('.combined-model-provider-list-heading'));
				heading.textContent = showRecommendedBackboardModels
					? localize('combinedPicker.recommendedBackboardModels', "Recommended models")
					: localize('combinedPicker.allBackboardModels', "All Backboard models");
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
				nameRow.textContent = formatModelLabel(model.metadata.name);
				if (model.identifier === currentModelId) {
					nameRow.appendChild(renderIcon(Codicon.check));
				}
				const sub = dom.append(main, dom.$('.combined-model-provider-row-sub'));
				sub.appendChild(renderIcon(getAgentSessionProviderIcon(providerId as AgentSessionTarget)));
				// Agent-host models expose their upstream API/vendor in `detail`
				// (for example AWS Bedrock, Anthropic, OpenAI, or xAI). Fall back
				// to the session provider only for models that do not supply it.
				dom.append(sub, dom.$('span')).textContent = model.metadata.detail?.trim() || getAgentSessionProviderName(providerId as AgentSessionTarget);

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

			const hiddenModelCount = hasRecommendedBackboardModels ? Math.max(0, allModels.length - recommendedModels.length) : 0;
			if (showingBackboard && !query && hiddenModelCount > 0) {
				const showMore = dom.append(footer, dom.$('button.combined-model-provider-show-rest')) as HTMLButtonElement;
				showMore.type = 'button';
				showMore.textContent = this._showAllBackboardModels
					? localize('combinedPicker.showRecommendedModels', "Show recommended")
					: localize('combinedPicker.showRestOfModels', "Show {0} more", hiddenModelCount);
				showMore.appendChild(renderIcon(this._showAllBackboardModels ? Codicon.chevronUp : Codicon.chevronDown));
				store.add(dom.addDisposableListener(showMore, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					this._showAllBackboardModels = !this._showAllBackboardModels;
					renderList();
				}));
			}
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

	/**
	 * The installable agent CLI behind the rail's current provider, when that
	 * agent is not set up yet. Undefined for providers that are already
	 * registered or cannot be installed from here.
	 */
	private _setupCandidate(provider = this._railProvider): IModelPickerSetupCandidate | undefined {
		if (!this._sessionTypeDelegate.runSetup || !provider) {
			return undefined;
		}
		return this._sessionTypeDelegate.getSetupCandidateForProvider?.(provider as AgentSessionTarget);
	}

	/**
	 * Empty-state affordance for a provider the user hasn't set up yet: the
	 * agent has no models because its CLI was never installed, so offer an
	 * Install button that hands off to the vendor's install + sign-in flow.
	 */
	private _renderSetupPrompt(list: HTMLElement, store: DisposableStore, candidate: IModelPickerSetupCandidate): void {
		const runSetup = this._sessionTypeDelegate.runSetup;
		if (!runSetup) {
			return;
		}

		const setup = dom.append(list, dom.$('.combined-model-provider-setup'));
		if (candidate.description) {
			dom.append(setup, dom.$('.combined-model-provider-setup-description')).textContent = candidate.description;
		}
		const button = dom.append(setup, dom.$('button.combined-model-provider-setup-button')) as HTMLButtonElement;
		button.textContent = localize('combinedPicker.install', "Install");
		button.title = localize('combinedPicker.installTooltip', "Install {0}", candidate.label);
		const install = () => {
			this._overlay.clear();
			runSetup(candidate.id);
		};
		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			install();
		}));
		store.add(dom.addDisposableListener(button, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				install();
			}
		}));
	}

	private _commit(providerId: string, model: ILanguageModelChatMetadataAndIdentifier): void {
		const activeProvider = this._activeProvider();
		const providerLocked = this._sessionTypeDelegate.canChangeSessionProvider?.() === false;
		if (providerLocked && providerId !== activeProvider) {
			return;
		}
		const providerAllowed = this._selectableProviders().includes(providerId as AgentSessionTarget);
		const modelAllowed = providerAllowed && this._modelsForProvider(providerId).some(candidate => candidate.identifier === model.identifier);
		if (!modelAllowed) {
			return;
		}
		const setupCandidate = this._setupCandidate(providerId);
		if (setupCandidate && this._sessionTypeDelegate.runSetup) {
			this._overlay.clear();
			this._sessionTypeDelegate.runSetup(setupCandidate.id);
			return;
		}
		if (providerId && providerId !== activeProvider && this._sessionTypeDelegate.setActiveSessionProvider) {
			this._sessionTypeDelegate.setActiveSessionProvider(providerId as AgentSessionTarget);
		}
		this._modelDelegate.setModel(model);
		this._updateTrigger();
		this._overlay.clear();
	}
}
