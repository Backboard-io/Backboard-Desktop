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
import { Event } from '../../../../../../base/common/event.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { AgentSessionProviders, AgentSessionTarget } from '../../agentSessions/agentSessions.js';
import { ISessionTypePickerDelegate } from '../../chat.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { resolveConfigProperty } from './chatModelPicker.js';
import { IModelConfigurationAccess, IModelPickerDelegate } from './modelPickerActionItem.js';
import { filterAndRankModels } from './modelSearch.js';
import './media/combinedModelProviderPicker.css';

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

interface ICombinedModelThinkingOption {
	readonly label: string;
	readonly currentLabel: string;
	readonly currentValue: unknown;
	readonly values: readonly unknown[];
	readonly labels: readonly string[];
	setValue(value: unknown): Promise<void> | void;
}

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
 * Model picker for the Sessions composer. A single inline control shows the
 * active model and thinking level; opening it reveals a searchable model list
 * and a discrete reasoning slider. Subscription/provider switching belongs to
 * session setup rather than this focused model-selection surface.
 */
export class CombinedModelProviderPickerActionItem extends BaseActionViewItem {

	private _triggerElement: HTMLElement | undefined;
	private _triggerLabel: HTMLElement | undefined;
	private _triggerThinking: HTMLElement | undefined;
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
		private readonly _getSessionThinkingOption: () => ICombinedModelThinkingOption | undefined,
		onDidChangeSessionThinkingOption: Event<void>,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super(undefined, action);

		// Keep the trigger label in sync with external model/provider changes.
		this._register(autorun(reader => {
			this._modelDelegate.currentModel.read(reader);
			this._updateTrigger();
		}));
		this._register(this._languageModelsService.onDidChangeLanguageModels(() => this._updateTrigger()));
		if (this._modelDelegate.modelConfiguration?.onDidChange) {
			this._register(this._modelDelegate.modelConfiguration.onDidChange(() => this._updateTrigger()));
		}
		this._register(onDidChangeSessionThinkingOption(() => this._updateTrigger()));
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
		this._triggerLabel = dom.append(trigger, dom.$('span.combined-model-provider-trigger-label'));
		this._triggerThinking = dom.append(trigger, dom.$('span.combined-model-provider-trigger-thinking'));
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

	private _updateTrigger(): void {
		if (!this._triggerLabel || !this._triggerThinking) {
			return;
		}
		const model = this._modelDelegate.currentModel.get();
		const name = model?.metadata.name;
		const modelLabel = name ? formatModelLabel(name) : localize('combinedPicker.auto', "Auto");
		const thinkingLabel = this._thinkingOption(model)?.currentLabel;
		this._triggerLabel.textContent = modelLabel;
		this._triggerThinking.textContent = thinkingLabel ?? '';
		this._triggerElement?.setAttribute('aria-label', thinkingLabel
			? localize('combinedPicker.ariaLabelWithThinking', "Model: {0}, Thinking: {1}", modelLabel, thinkingLabel)
			: localize('combinedPicker.ariaLabel', "Provider and model: {0}", modelLabel));
	}

	private get _modelConfiguration(): IModelConfigurationAccess {
		return this._modelDelegate.modelConfiguration ?? this._languageModelsService;
	}

	private _thinkingOption(model: ILanguageModelChatMetadataAndIdentifier | undefined): ICombinedModelThinkingOption | undefined {
		const config = model ? resolveConfigProperty(model, 'navigation', this._modelConfiguration) : undefined;
		if (model && config?.schema.enum?.length) {
			const labels = config.schema.enum.map((value, index) => config.schema.enumItemLabels?.[index] ?? String(value));
			const selectedIndex = config.schema.enum.indexOf(config.value);
			return {
				label: localize('combinedPicker.thinking', "Thinking"),
				currentLabel: labels[selectedIndex] ?? String(config.value ?? ''),
				currentValue: config.value,
				values: config.schema.enum,
				labels,
				setValue: value => this._modelConfiguration.setModelConfiguration(model.identifier, { [config.key]: value }),
			};
		}
		return this._getSessionThinkingOption();
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

		// Keep this surface scoped to the session's current provider. Provider and
		// subscription changes happen during session setup, outside this picker.
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

		// --- Search, model list, and fixed reasoning footer ---
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
		const thinking = dom.append(pane, dom.$('.combined-model-provider-thinking'));
		const thinkingStore = new DisposableStore();
		store.add(thinkingStore);

		const renderThinking = () => {
			thinkingStore.clear();
			dom.clearNode(thinking);
			const model = this._modelDelegate.currentModel.get();
			const option = this._thinkingOption(model);
			thinking.classList.toggle('hidden', !model || !option);
			if (!model || !option) {
				return;
			}

			const heading = dom.append(thinking, dom.$('.combined-model-provider-thinking-heading'));
			const headingText = dom.append(heading, dom.$('.combined-model-provider-thinking-title'));
			headingText.textContent = option.label;
			const currentValue = dom.append(heading, dom.$('.combined-model-provider-thinking-current'));

			const sliderShell = dom.append(thinking, dom.$('.combined-model-provider-thinking-slider-shell'));
			const dots = dom.append(sliderShell, dom.$('.combined-model-provider-thinking-dots'));
			const dotElements: HTMLElement[] = [];
			for (let index = 0; index < option.values.length; index++) {
				dotElements.push(dom.append(dots, dom.$('span.combined-model-provider-thinking-dot')));
			}
			const slider = dom.append(sliderShell, dom.$('input.combined-model-provider-thinking-slider')) as HTMLInputElement;
			slider.type = 'range';
			slider.min = '0';
			slider.max = String(option.values.length - 1);
			slider.step = '1';
			const initialIndex = Math.max(0, option.values.indexOf(option.currentValue));
			slider.value = String(initialIndex);
			slider.setAttribute('aria-label', localize('combinedPicker.thinkingAriaLabel', "Thinking level for {0}", model.metadata.name));

			const paint = (index: number) => {
				const label = option.labels[index] ?? String(option.values[index]);
				currentValue.textContent = label;
				slider.setAttribute('aria-valuetext', label);
				dotElements.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex <= index));
				sliderShell.style.setProperty('--combined-thinking-progress', `${option.values.length > 1 ? index / (option.values.length - 1) * 100 : 0}%`);
			};
			const apply = (index: number) => {
				paint(index);
				this._triggerThinking!.textContent = option.labels[index] ?? String(option.values[index]);
				void Promise.resolve(option.setValue(option.values[index])).then(() => this._updateTrigger());
			};

			paint(initialIndex);
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.INPUT, () => paint(Number(slider.value))));
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.CHANGE, () => apply(Number(slider.value))));
		};

		const renderList = () => {
			dom.clearNode(list);
			dom.clearNode(footer);
			const query = this._searchValue.trim().toLowerCase();
			const allModels = this._modelsForProvider(this._railProvider ?? '');
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
			const filtered = filterAndRankModels(models, query);

			if (filtered.length === 0) {
				// Only offer setup when the provider genuinely has nothing
				// registered — not when a search simply matched no model.
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = localize('combinedPicker.noModels', "No models available");
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
				const detail = model.metadata.detail?.trim();
				if (detail) {
					dom.append(main, dom.$('.combined-model-provider-row-sub')).textContent = detail;
				}

				const aside = dom.append(row, dom.$('.combined-model-provider-row-aside'));
				if (index < 9) {
					dom.append(aside, dom.$('.combined-model-provider-row-kbd')).textContent = `⌘${index + 1}`;
				}
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
		renderThinking();
		setTimeout(() => search.focus(), 0);
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
		if (providerId && providerId !== activeProvider && this._sessionTypeDelegate.setActiveSessionProvider) {
			this._sessionTypeDelegate.setActiveSessionProvider(providerId as AgentSessionTarget);
		}
		this._modelDelegate.setModel(model);
		this._updateTrigger();
		this._overlay.clear();
	}
}
