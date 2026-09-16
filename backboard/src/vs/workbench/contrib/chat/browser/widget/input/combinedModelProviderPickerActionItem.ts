/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../../../../base/common/platform.js';
import { isBackboardProviderAvailable } from '../../../../../../platform/agentHost/common/backboardSubscriptions.js';
import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { BaseActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { AgentSessionProviders, AgentSessionTarget } from '../../agentSessions/agentSessions.js';
import { CLAUDE_SUBSCRIPTION_SETUP_ID } from '../../agentSessions/agentCliSetup.js';
import { ISessionTypePickerDelegate } from '../../chat.js';
import { ILanguageModelChatMetadataAndIdentifier, LanguageModelBillingSource, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { resolveConfigProperty } from './chatModelPicker.js';
import { IModelConfigurationAccess, IModelPickerDelegate } from './modelPickerActionItem.js';
import { filterAndRankModels } from './modelSearch.js';
import './media/combinedModelProviderPicker.css';

const RECOMMENDED_BACKBOARD_MODEL_IDS = [
	'openai-subscription/gpt-5.6-sol',
	'openai-subscription/gpt-5.6-terra',
	'openai-subscription/gpt-5.6-luna',
	'anthropic-subscription/default',
	'anthropic-subscription/opus[1m]',
	'anthropic-subscription/claude-fable-5-1[1m]',
	'anthropic-subscription/sonnet',
	'anthropic-subscription/haiku',
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

export const COMBINED_MODEL_SECTION_RECOMMENDED = 'recommended';
export const COMBINED_MODEL_SECTION_ALL = 'all';
export const COMBINED_MODEL_SECTION_CHATGPT = 'provider:openai-subscription';
export const COMBINED_MODEL_SECTION_CLAUDE = 'provider:anthropic-subscription';
/** Section id prefix for a provider's key-billed (BYOK) models; `provider:` covers its Backboard-billed ones. */
const BYOK_SECTION_PREFIX = 'byok:';

/**
 * Catalog rows may also mark key billing through a `<vendor>-key` provider
 * prefix, e.g. `openai-key/gpt-5.5`, while `openai/gpt-5.5` bills to Backboard.
 */
const KEY_BILLED_PROVIDER_SUFFIX = '-key';

function isKeyBilledProviderId(providerId: string): boolean {
	return providerId.length > KEY_BILLED_PROVIDER_SUFFIX.length && providerId.endsWith(KEY_BILLED_PROVIDER_SUFFIX);
}

/** `openai-key` → `openai`; other provider ids are returned unchanged. */
function vendorOfProviderId(providerId: string): string {
	return isKeyBilledProviderId(providerId) ? providerId.slice(0, -KEY_BILLED_PROVIDER_SUFFIX.length) : providerId;
}

export function providerIconKeyForCombinedModelSection(sectionId: string): string | undefined {
	if (sectionId === COMBINED_MODEL_SECTION_RECOMMENDED) {
		return 'backboard';
	}
	const providerId = sectionId.startsWith('provider:')
		? vendorOfProviderId(sectionId.slice('provider:'.length))
		: sectionId.startsWith(BYOK_SECTION_PREFIX)
			? vendorOfProviderId(sectionId.slice(BYOK_SECTION_PREFIX.length))
			: undefined;
	switch (providerId) {
		case 'openai-subscription':
		case 'openai': return 'open-ai';
		case 'anthropic-subscription': return 'claude';
		case 'anthropic': return 'anthropic';
		case 'aws-bedrock': return 'bedrock';
		case 'cerebras': return 'cerebras';
		case 'cohere': return 'cohere';
		case 'google':
		case 'google-ai': return 'google';
		case 'openrouter': return 'open-router';
		case 'xai':
		case 'x-ai': return 'x-ai';
		default: return undefined;
	}
}

/**
 * Left-rail headings, ordered by who bills the request: Backboard's own
 * catalog, then connected subscriptions, then bring-your-own-key providers.
 * `models` is the neutral heading used for non-Backboard session types.
 */
export type CombinedModelSectionGroup = 'backboard' | 'subscriptions' | 'byok' | 'models';

export function combinedModelSectionGroupLabel(group: CombinedModelSectionGroup): string {
	switch (group) {
		case 'backboard': return localize('combinedPicker.backboardGroup', "Backboard");
		case 'subscriptions': return localize('combinedPicker.subscriptionsGroup', "Subscriptions");
		case 'byok': return localize('combinedPicker.byokGroup', "BYOK");
		case 'models': return localize('combinedPicker.modelsGroup', "Models");
	}
}

export interface ICombinedModelSection {
	readonly id: string;
	readonly label: string;
	readonly modelCount: number;
	readonly kind: 'library' | 'subscription' | 'provider' | 'byok';
	/** Rail heading the section is listed under. */
	readonly group: CombinedModelSectionGroup;
}

interface ICombinedModelThinkingOption {
	readonly label: string;
	readonly currentLabel: string;
	readonly currentValue: unknown;
	readonly values: readonly unknown[];
	readonly labels: readonly string[];
	readonly needsMigration?: boolean;
	setValue(value: unknown): Promise<void> | void;
}

interface ICombinedModelRoutingOption {
	readonly label: string;
	readonly currentValue: unknown;
	readonly values: readonly unknown[];
	readonly labels: readonly string[];
	readonly descriptions: readonly (string | undefined)[];
	setValue(value: unknown): Promise<void> | void;
}

export interface IExplicitReasoningOptions {
	readonly currentLabel: string;
	readonly currentValue: unknown;
	readonly labels: readonly string[];
	readonly needsMigration: boolean;
	readonly values: readonly unknown[];
}

const RETIRED_REASONING_VALUES = new Set(['adaptive', 'auto', 'default', 'dynamic']);

/** Removes automatic/provider-owned reasoning modes from an explicit effort slider. */
export function resolveExplicitReasoningOptions(
	values: readonly unknown[],
	labels: readonly string[],
	currentValue: unknown,
): IExplicitReasoningOptions | undefined {
	const choices = values
		.map((value, index) => ({ value, label: labels[index] ?? String(value) }))
		.filter(choice => {
			const normalizedValue = String(choice.value).trim().toLowerCase();
			const normalizedLabel = choice.label.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
			return !RETIRED_REASONING_VALUES.has(normalizedValue)
				&& normalizedLabel !== 'adaptive'
				&& normalizedLabel !== 'provider default';
		});
	if (choices.length === 0) {
		return undefined;
	}

	let currentIndex = choices.findIndex(choice => Object.is(choice.value, currentValue));
	const needsMigration = currentIndex < 0;
	if (needsMigration) {
		const mediumIndex = choices.findIndex(choice => String(choice.value).trim().toLowerCase() === 'medium');
		currentIndex = mediumIndex >= 0 ? mediumIndex : 0;
	}

	return {
		currentLabel: choices[currentIndex].label,
		currentValue: choices[currentIndex].value,
		labels: choices.map(choice => choice.label),
		needsMigration,
		values: choices.map(choice => choice.value),
	};
}

function formatModelLabelPart(part: string): string {
	const lower = part.toLowerCase();
	if (lower === 'gpt') {
		return 'GPT';
	}
	if (lower === 'ai') {
		return 'AI';
	}
	if (lower === 'oss') {
		return 'OSS';
	}
	if (lower === 'deepseek') {
		return 'DeepSeek';
	}
	if (/^\d/.test(part)) {
		return part;
	}
	return part.charAt(0).toUpperCase() + part.slice(1);
}

/** Turn provider model ids into compact user-facing labels for the composer. */
export function formatModelLabel(name: string): string {
	const rawModelName = name.split('/').pop() || name;
	const modelName = rawModelName.replace(/^(?:[^.]+\.)*anthropic\./i, '');
	const gptMatch = /^gpt[-_\s]*(\d+(?:\.\d+)*(?:[a-z]+)?)(?:[-_\s]+(.+))?$/i.exec(modelName);
	if (gptMatch) {
		const suffix = gptMatch[2]
			?.split(/[-_\s]+/)
			.filter(Boolean)
			.map(formatModelLabelPart)
			.join(' ');
		return `GPT-${gptMatch[1]}${suffix ? ` ${suffix}` : ''}`;
	}
	const formatted = modelName
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(formatModelLabelPart)
		.join(' ');
	return formatted.replace(/^(Claude(?: [A-Za-z]+)*) (\d+) (\d+)(?= |$)/, '$1 $2.$3');
}

/** Builds the compact source label shown below a model name. */
export function formatModelProviderDetail(model: ILanguageModelChatMetadataAndIdentifier, selectedOpenRouterProvider?: string): string | undefined {
	const providerId = upstreamProviderId(model);
	let detail: string | undefined;
	if (providerId === 'openai-subscription') {
		detail = localize('combinedPicker.chatGptSubscriptionDetail', "ChatGPT subscription");
	} else if (providerId === 'anthropic-subscription') {
		detail = localize('combinedPicker.claudeSubscriptionDetail', "Claude subscription");
	} else if (providerId === 'openrouter' && selectedOpenRouterProvider) {
		detail = localize('combinedPicker.selectedOpenRouterProviderDetail', "OpenRouter · {0}", selectedOpenRouterProvider);
	} else {
		detail = model.metadata.detail?.trim();
	}
	if (billingSourceOf(model) !== 'byok') {
		return detail;
	}
	return detail
		? localize('combinedPicker.yourKeyDetail', "{0} · Your key", detail)
		: localize('combinedPicker.yourKey', "Your key");
}

function upstreamProviderId(model: ILanguageModelChatMetadataAndIdentifier): string {
	const slash = model.metadata.id.indexOf('/');
	return slash > 0 ? model.metadata.id.slice(0, slash).toLowerCase() : model.metadata.vendor.toLowerCase();
}

/** Who bills a request to the model: as reported by the runtime, else inferred from its provider id. */
function billingSourceOf(model: ILanguageModelChatMetadataAndIdentifier): LanguageModelBillingSource {
	if (model.metadata.billingSource) {
		return model.metadata.billingSource;
	}
	if (isKeyBilledProviderId(upstreamProviderId(model))) {
		return 'byok';
	}
	return isSubscriptionModel(model) ? 'subscription' : 'backboard';
}

function isSubscriptionModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	const providerId = upstreamProviderId(model);
	return providerId === 'openai-subscription' || providerId === 'anthropic-subscription';
}

function isAvailableInRecommendedSection(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return !isSubscriptionModel(model) || !!model.metadata.auth?.accountLabel;
}

function recommendedModels(models: readonly ILanguageModelChatMetadataAndIdentifier[]): ILanguageModelChatMetadataAndIdentifier[] {
	const recommended = models
		.filter(model => RECOMMENDED_BACKBOARD_MODEL_PRIORITY.has(model.metadata.id) && isAvailableInRecommendedSection(model))
		.sort((a, b) => (RECOMMENDED_BACKBOARD_MODEL_PRIORITY.get(a.metadata.id) ?? Number.MAX_SAFE_INTEGER) - (RECOMMENDED_BACKBOARD_MODEL_PRIORITY.get(b.metadata.id) ?? Number.MAX_SAFE_INTEGER));
	return recommended.length ? recommended : models.filter(isAvailableInRecommendedSection);
}

/** Rail label for an upstream provider; drops per-model suffixes such as "OpenRouter · Z.ai". */
function providerSectionLabel(providerId: string, detail: string | undefined): string {
	const trimmed = detail?.trim() ?? '';
	const separator = trimmed.indexOf(' · ');
	const label = separator > 0 ? trimmed.slice(0, separator).trim() : trimmed;
	return label || formatModelLabel(vendorOfProviderId(providerId));
}

/** Builds the stable left-rail sections for the Backboard model catalog. */
export function buildCombinedModelSections(models: readonly ILanguageModelChatMetadataAndIdentifier[], windows = isWindows): ICombinedModelSection[] {
	return buildCombinedModelSectionsForCatalog(models.filter(model => isBackboardProviderAvailable(upstreamProviderId(model), windows)));
}

/**
 * Builds rail sections for an already-filtered catalog, grouped by billing
 * source: Backboard (library views plus Backboard-billed upstream providers),
 * then Subscriptions, then BYOK. Prefer {@link buildCombinedModelSections},
 * which applies the platform availability filter first.
 */
export function buildCombinedModelSectionsForCatalog(models: readonly ILanguageModelChatMetadataAndIdentifier[]): ICombinedModelSection[] {
	const recommendedCount = recommendedModels(models).length;
	// A provider is tallied separately for its Backboard-billed and key-billed
	// rows, so a vendor the user holds a key for can appear in both groups.
	const providers = new Map<string, { label: string; count: number; keyBilled: boolean }>();
	for (const model of models) {
		const id = upstreamProviderId(model);
		const keyBilled = billingSourceOf(model) === 'byok';
		const sectionId = `${keyBilled ? BYOK_SECTION_PREFIX : 'provider:'}${id}`;
		const existing = providers.get(sectionId);
		providers.set(sectionId, {
			label: existing?.label ?? providerSectionLabel(id, model.metadata.detail),
			count: (existing?.count ?? 0) + 1,
			keyBilled,
		});
	}

	const backboard: ICombinedModelSection[] = [
		{
			id: COMBINED_MODEL_SECTION_RECOMMENDED,
			label: localize('combinedPicker.recommended', "Recommended"),
			modelCount: recommendedCount,
			kind: 'library',
			group: 'backboard',
		},
		{
			id: COMBINED_MODEL_SECTION_ALL,
			label: localize('combinedPicker.allModels', "All models"),
			modelCount: models.length,
			kind: 'library',
			group: 'backboard',
		},
	];

	const subscriptions: ICombinedModelSection[] = [];
	const chatGpt = providers.get(COMBINED_MODEL_SECTION_CHATGPT);
	if (chatGpt) {
		subscriptions.push({
			id: COMBINED_MODEL_SECTION_CHATGPT,
			label: localize('combinedPicker.chatGpt', "ChatGPT"),
			modelCount: chatGpt.count,
			kind: 'subscription',
			group: 'subscriptions',
		});
		providers.delete(COMBINED_MODEL_SECTION_CHATGPT);
	}

	const claude = providers.get(COMBINED_MODEL_SECTION_CLAUDE);
	if (claude) {
		subscriptions.push({
			id: COMBINED_MODEL_SECTION_CLAUDE,
			label: localize('combinedPicker.claude', "Claude"),
			modelCount: claude.count,
			kind: 'subscription',
			group: 'subscriptions',
		});
		providers.delete(COMBINED_MODEL_SECTION_CLAUDE);
	}

	const byok: ICombinedModelSection[] = [];
	for (const [sectionId, provider] of [...providers].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
		(provider.keyBilled ? byok : backboard).push({
			id: sectionId,
			label: provider.label,
			modelCount: provider.count,
			kind: provider.keyBilled ? 'byok' : 'provider',
			group: provider.keyBilled ? 'byok' : 'backboard',
		});
	}
	return [...backboard, ...subscriptions, ...byok];
}

/** Returns the models represented by one left-rail section, or the full catalog during a search. */
export function modelsForCombinedModelSection(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	sectionId: string,
	includeAllModels = false,
	windows = isWindows,
): ILanguageModelChatMetadataAndIdentifier[] {
	models = models.filter(model => isBackboardProviderAvailable(upstreamProviderId(model), windows));
	if (includeAllModels) {
		return [...models];
	}
	if (sectionId === COMBINED_MODEL_SECTION_ALL) {
		return [...models];
	}
	if (sectionId === COMBINED_MODEL_SECTION_RECOMMENDED) {
		return recommendedModels(models);
	}
	if (sectionId.startsWith(BYOK_SECTION_PREFIX)) {
		const providerId = sectionId.slice(BYOK_SECTION_PREFIX.length);
		return models.filter(model => upstreamProviderId(model) === providerId && billingSourceOf(model) === 'byok');
	}
	if (sectionId.startsWith('provider:')) {
		const providerId = sectionId.slice('provider:'.length);
		return models.filter(model => upstreamProviderId(model) === providerId && billingSourceOf(model) !== 'byok');
	}
	return [...models];
}

/** Subscription state published by the agent host on ChatGPT model metadata. */
export function isChatGptSubscriptionConnected(models: readonly ILanguageModelChatMetadataAndIdentifier[]): boolean {
	return models.some(model => upstreamProviderId(model) === 'openai-subscription' && !!model.metadata.auth?.accountLabel);
}

/** Subscription state published by the agent host on Claude model metadata. */
export function isClaudeSubscriptionConnected(models: readonly ILanguageModelChatMetadataAndIdentifier[]): boolean {
	return models.some(model => upstreamProviderId(model) === 'anthropic-subscription' && !!model.metadata.auth?.accountLabel);
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
	/** The model-catalog section selected in the left rail. */
	private _railSection = COMBINED_MODEL_SECTION_RECOMMENDED;
	private _searchValue = '';
	private _refreshPromise: Promise<void> | undefined;
	private readonly _onDidRefresh = this._register(new Emitter<void>());

	constructor(
		action: IAction,
		private readonly _modelDelegate: IModelPickerDelegate,
		private readonly _sessionTypeDelegate: ISessionTypePickerDelegate,
		private readonly _pickerOptions: IChatInputPickerOptions,
		private readonly _getSessionThinkingOption: () => ICombinedModelThinkingOption | undefined,
		onDidChangeSessionThinkingOption: Event<void>,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IHoverService private readonly _hoverService: IHoverService,
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
		container.classList.add('chat-input-picker-item', 'chat-model-picker-action-item', 'combined-model-provider-picker-item');

		const trigger = this._triggerElement = dom.append(container, dom.$('a.action-label.combined-model-provider-trigger'));
		trigger.tabIndex = 0;
		trigger.setAttribute('role', 'button');
		trigger.setAttribute('aria-haspopup', 'true');
		dom.append(trigger, dom.$('span.combined-model-provider-brain', { 'aria-hidden': 'true' }));
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
			.filter(model => isBackboardProviderAvailable(upstreamProviderId(model)))
			.filter(model => !/(^|[\s/_.:-])latest($|[\s/_.:-])/i.test(`${model.metadata.id} ${model.metadata.name}`))
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
			const explicit = resolveExplicitReasoningOptions(config.schema.enum, labels, config.value);
			if (!explicit) {
				return this._getSessionThinkingOption();
			}
			return {
				label: localize('combinedPicker.reasoning', "Reasoning"),
				currentLabel: explicit.currentLabel,
				currentValue: explicit.currentValue,
				values: explicit.values,
				labels: explicit.labels,
				needsMigration: explicit.needsMigration,
				setValue: value => this._modelConfiguration.setModelConfiguration(model.identifier, { [config.key]: value }),
			};
		}
		// Claude Code publishes effort controls per model. Models such as Haiku
		// intentionally omit them and must not inherit Backboard's generic slider.
		if (model && upstreamProviderId(model) === 'anthropic-subscription') {
			return undefined;
		}
		return this._getSessionThinkingOption();
	}

	private _routingOption(model: ILanguageModelChatMetadataAndIdentifier | undefined): ICombinedModelRoutingOption | undefined {
		const config = model ? resolveConfigProperty(model, 'routing', this._modelConfiguration) : undefined;
		if (!model || !config?.schema.enum?.length) {
			return undefined;
		}
		return {
			label: localize('combinedPicker.openRouterProvider', "OpenRouter provider"),
			currentValue: config.value,
			values: config.schema.enum,
			labels: config.schema.enum.map((value, index) => config.schema.enumItemLabels?.[index] ?? String(value)),
			descriptions: config.schema.enum.map((_value, index) => config.schema.enumDescriptions?.[index]),
			setValue: value => this._modelConfiguration.setModelConfiguration(model.identifier, { [config.key]: value }),
		};
	}

	private _toggle(): void {
		if (this._overlay.value) {
			this._overlay.clear();
			return;
		}
		this.show();
	}

	public show(): void {
		const anchor = this.element ?? this._pickerOptions.getOverflowAnchor?.();
		if (!anchor) {
			return;
		}

		// Keep the session provider scoped to the current chat. Backboard's own
		// upstream model providers are exposed as sections inside the picker.
		const allowedProviders = this._selectableProviders();
		const activeProvider = this._activeProvider();
		this._railProvider = activeProvider && allowedProviders.includes(activeProvider as AgentSessionTarget)
			? activeProvider
			: allowedProviders[0];
		this._searchValue = '';
		this._railSection = COMBINED_MODEL_SECTION_RECOMMENDED;

		const store = new DisposableStore();
		this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				container.classList.add('combined-model-provider-overlay');
				const contentStore = store.add(new DisposableStore());
				const render = () => {
					contentStore.clear();
					this._renderOverlay(container, contentStore);
				};
				store.add(this._onDidRefresh.event(render));
				store.add(this._languageModelsService.onDidChangeLanguageModels(() => {
					if (!this._refreshPromise) { render(); }
				}));
				render();
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
		const allModels = this._modelsForProvider(this._railProvider ?? '');
		const showingBackboard = this._railProvider === AgentSessionProviders.AgentHostBackboard;
		const connectedToChatGpt = isChatGptSubscriptionConnected(allModels);
		const connectedToClaude = isClaudeSubscriptionConnected(allModels);
		const sections = showingBackboard
			? buildCombinedModelSections(allModels)
			: [{ id: COMBINED_MODEL_SECTION_ALL, label: localize('combinedPicker.allModels', "All models"), modelCount: allModels.length, kind: 'library' as const, group: 'models' as const }];
		if (!sections.some(section => section.id === this._railSection)) {
			this._railSection = sections[0]?.id ?? COMBINED_MODEL_SECTION_ALL;
		}

		// --- Catalog navigation rail ---
		const rail = dom.append(root, dom.$('.combined-model-provider-rail'));
		const railList = dom.append(rail, dom.$('.combined-model-provider-rail-list'));
		railList.setAttribute('role', 'listbox');

		// --- Search, model list, and fixed reasoning footer ---
		const pane = dom.append(root, dom.$('.combined-model-provider-pane'));
		const toolbar = dom.append(pane, dom.$('.combined-model-provider-catalog-toolbar'));
		const searchRow = dom.append(toolbar, dom.$('.combined-model-provider-search'));
		searchRow.appendChild(renderIcon(Codicon.search));
		const search = dom.append(searchRow, dom.$('input.combined-model-provider-search-input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('combinedPicker.searchAllModelsPlaceholder', "Search all models…");
		search.value = this._searchValue;
		search.setAttribute('aria-label', localize('combinedPicker.searchAllModelsPlaceholder', "Search all models…"));

		if (showingBackboard) {
			const refresh = dom.append(toolbar, dom.$('button.combined-model-provider-refresh')) as HTMLButtonElement;
			refresh.type = 'button';
			const label = localize('combinedPicker.refreshModelsOnly', "Refresh Models");
			refresh.setAttribute('aria-label', label);
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), refresh, label));
			const icon = refresh.appendChild(renderIcon(Codicon.refresh));
			const updateBusy = () => {
				refresh.disabled = !!this._refreshPromise;
				refresh.setAttribute('aria-busy', String(!!this._refreshPromise));
				icon.classList.toggle('combined-model-provider-refresh-spinning', !!this._refreshPromise);
			};
			updateBusy();
			store.add(dom.addDisposableListener(refresh, dom.EventType.CLICK, event => {
				dom.EventHelper.stop(event, true);
				if (this._refreshPromise) { return; }
				this._refreshPromise = this._agentHostService.executeAgentCommand({ provider: 'backboard', command: 'models.refresh' })
					.then(() => {
						this._notificationService.info(localize('combinedPicker.refreshModelsSuccess', "Models are up to date."));
					}, error => {
						const message = error instanceof Error ? error.message : String(error);
						this._notificationService.error(message.includes('Unsupported Backboard command: models.refresh')
							? localize('combinedPicker.refreshRestartRequired', "Restart Backboard after your running agents finish to enable model refresh.")
							: localize('combinedPicker.refreshFailed', "Could not refresh models: {0}", message));
					})
					.finally(() => {
						this._refreshPromise = undefined;
						this._onDidRefresh.fire();
					});
				updateBusy();
			}));
		}

		const list = dom.append(pane, dom.$('.combined-model-provider-list'));
		const footer = dom.append(pane, dom.$('.combined-model-provider-footer'));
		const thinking = dom.append(pane, dom.$('.combined-model-provider-thinking'));
		const routingModal = dom.append(container, dom.$('.combined-model-provider-routing-modal.hidden'));
		const routingStore = new DisposableStore();
		const thinkingStore = new DisposableStore();
		const listStore = new DisposableStore();
		store.add(routingStore);
		store.add(thinkingStore);
		store.add(listStore);

		let routingModalOpen = false;
		const closeRoutingModal = () => {
			routingModalOpen = false;
			routingStore.clear();
			dom.clearNode(routingModal);
			routingModal.classList.add('hidden');
		};
		const renderRoutingModal = () => {
			routingStore.clear();
			dom.clearNode(routingModal);
			const model = this._modelDelegate.currentModel.get();
			const option = this._routingOption(model);
			if (!routingModalOpen || !model || !option) {
				closeRoutingModal();
				return;
			}

			routingModal.classList.remove('hidden');
			const dialog = dom.append(routingModal, dom.$('.combined-model-provider-routing-dialog'));
			dialog.setAttribute('role', 'dialog');
			dialog.setAttribute('aria-label', localize('combinedPicker.openRouterProviderAriaLabel', "OpenRouter serving provider for {0}", formatModelLabel(model.metadata.name)));

			const header = dom.append(dialog, dom.$('.combined-model-provider-routing-dialog-header'));
			const heading = dom.append(header, dom.$('.combined-model-provider-routing-dialog-heading'));
			dom.append(heading, dom.$('.combined-model-provider-routing-dialog-title')).textContent = localize('combinedPicker.chooseOpenRouterProvider', "Choose provider");
			dom.append(heading, dom.$('.combined-model-provider-routing-dialog-subtitle')).textContent = formatModelLabel(model.metadata.name);
			const close = dom.append(header, dom.$('button.combined-model-provider-routing-dialog-close')) as HTMLButtonElement;
			close.type = 'button';
			close.title = localize('combinedPicker.closeProviderPicker', "Close provider picker");
			close.setAttribute('aria-label', close.title);
			close.appendChild(renderIcon(Codicon.close));

			const choices = dom.append(dialog, dom.$('.combined-model-provider-routing-choices'));
			choices.setAttribute('role', 'listbox');
			choices.setAttribute('aria-label', option.label);
			let selectedChoice: HTMLButtonElement | undefined;
			option.values.forEach((value, index) => {
				const selected = Object.is(value, option.currentValue);
				const item = dom.append(choices, dom.$('button.combined-model-provider-routing-choice')) as HTMLButtonElement;
				item.type = 'button';
				item.setAttribute('role', 'option');
				item.setAttribute('aria-selected', String(selected));
				item.classList.toggle('selected', selected);
				const copy = dom.append(item, dom.$('.combined-model-provider-routing-choice-copy'));
				dom.append(copy, dom.$('.combined-model-provider-routing-choice-label')).textContent = option.labels[index] ?? String(value);
				if (selected) {
					item.appendChild(renderIcon(Codicon.check));
					selectedChoice = item;
				}
				routingStore.add(dom.addDisposableListener(item, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					routingModalOpen = false;
					void Promise.resolve(option.setValue(value)).then(() => {
						closeRoutingModal();
						renderList();
						this._updateTrigger();
					}, () => closeRoutingModal());
				}));
			});

			routingStore.add(dom.addDisposableListener(close, dom.EventType.CLICK, e => {
				dom.EventHelper.stop(e, true);
				closeRoutingModal();
			}));
			routingStore.add(dom.addDisposableListener(dialog, dom.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Escape)) {
					dom.EventHelper.stop(e, true);
					closeRoutingModal();
				}
			}));
			setTimeout(() => (selectedChoice ?? choices.querySelector<HTMLButtonElement>('.combined-model-provider-routing-choice'))?.focus(), 0);
		};
		const openRoutingModal = () => {
			routingModalOpen = true;
			renderRoutingModal();
		};

		const renderThinking = () => {
			thinkingStore.clear();
			dom.clearNode(thinking);
			const model = this._modelDelegate.currentModel.get();
			const option = this._thinkingOption(model);
			thinking.classList.toggle('hidden', !model || !option);
			thinking.dataset.provider = model ? upstreamProviderId(model) : '';
			if (!model || !option) {
				return;
			}
			if (option.needsMigration) {
				void Promise.resolve(option.setValue(option.currentValue)).then(() => this._updateTrigger());
			}

			const heading = dom.append(thinking, dom.$('.combined-model-provider-thinking-heading'));
			const headingText = dom.append(heading, dom.$('.combined-model-provider-thinking-title'));
			headingText.textContent = option.label;
			const currentValue = dom.append(heading, dom.$('.combined-model-provider-thinking-current'));
			currentValue.setAttribute('aria-live', 'polite');

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
			slider.setAttribute('aria-label', localize('combinedPicker.reasoningAriaLabel', "Reasoning level for {0}", formatModelLabel(model.metadata.name)));

			const paint = (index: number) => {
				const safeIndex = Math.max(0, Math.min(option.values.length - 1, Math.round(index)));
				const label = option.labels[safeIndex] ?? String(option.values[safeIndex]);
				currentValue.textContent = label;
				slider.setAttribute('aria-valuetext', label);
				slider.title = localize('combinedPicker.reasoningValue', "Reasoning: {0}", label);
				dotElements.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex <= safeIndex));
				const progress = option.values.length > 1 ? safeIndex / (option.values.length - 1) : 0;
				sliderShell.style.setProperty('--combined-thinking-progress', `${progress}`);
			};
			let appliedIndex = initialIndex;
			let applyQueue: Promise<void> = Promise.resolve();
			const apply = (index: number) => {
				const safeIndex = Math.max(0, Math.min(option.values.length - 1, Math.round(index)));
				paint(safeIndex);
				if (safeIndex === appliedIndex) {
					return;
				}
				appliedIndex = safeIndex;
				this._triggerThinking!.textContent = option.labels[safeIndex] ?? String(option.values[safeIndex]);
				applyQueue = applyQueue
					.then(() => Promise.resolve(option.setValue(option.values[safeIndex])))
					.then(() => this._updateTrigger(), () => undefined);
			};

			paint(initialIndex);
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.INPUT, () => apply(Number(slider.value))));
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.CHANGE, () => apply(Number(slider.value))));
		};

		const currentSection = () => sections.find(section => section.id === this._railSection) ?? sections[0];
		const updateSearchPlaceholder = () => {
			search.placeholder = localize('combinedPicker.searchAllModelsPlaceholder', "Search all models…");
			search.setAttribute('aria-label', search.placeholder);
		};

		const railButtons = new Map<string, HTMLButtonElement>();
		const updateRailSelection = () => {
			for (const [id, button] of railButtons) {
				const selected = id === this._railSection;
				button.classList.toggle('selected', selected);
				button.setAttribute('aria-selected', String(selected));
			}
		};

		const renderList = () => {
			listStore.clear();
			dom.clearNode(list);
			dom.clearNode(footer);
			const renderSetupAction = () => {
				if (this._railSection !== COMBINED_MODEL_SECTION_CHATGPT && this._railSection !== COMBINED_MODEL_SECTION_CLAUDE) {
					return;
				}
				const railProvider = this._railProvider as AgentSessionTarget | undefined;
				const chatGptCandidate = railProvider
					? this._sessionTypeDelegate.getSetupCandidateForProvider?.(railProvider)
					: undefined;
				const setupId = this._railSection === COMBINED_MODEL_SECTION_CLAUDE
					? CLAUDE_SUBSCRIPTION_SETUP_ID
					: chatGptCandidate?.id;
				if (!setupId || !this._sessionTypeDelegate.runSetup) {
					return;
				}
				const claude = this._railSection === COMBINED_MODEL_SECTION_CLAUDE;
				const connected = claude ? connectedToClaude : connectedToChatGpt;
				const setup = dom.append(footer, dom.$('button.combined-model-provider-connect')) as HTMLButtonElement;
				setup.type = 'button';
				if (claude) {
					const icon = dom.append(setup, dom.$('.combined-model-provider-brand-icon.provider-claude'));
					icon.setAttribute('aria-hidden', 'true');
				} else {
					setup.appendChild(renderIcon(Codicon.openai));
				}
				dom.append(setup, dom.$('span')).textContent = claude
					? connected
						? localize('combinedPicker.reconnectClaude', "Reconnect Claude")
						: localize('combinedPicker.connectClaude', "Connect Claude")
					: connected
						? localize('combinedPicker.reconnectChatGpt', "Reconnect ChatGPT")
						: localize('combinedPicker.connectChatGpt', "Connect ChatGPT");
				setup.title = claude
					? localize('combinedPicker.claudeSubscriptionSetupDescription', "Connect Claude Code to use your Claude subscription through the Backboard harness.")
					: chatGptCandidate?.description ?? chatGptCandidate?.label ?? '';
				listStore.add(dom.addDisposableListener(setup, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					this._overlay.clear();
					this._sessionTypeDelegate.runSetup?.(setupId);
				}));
			};
			const section = currentSection();
			const query = this._searchValue.trim().toLowerCase();
			const models = showingBackboard && section
				? modelsForCombinedModelSection(allModels, section.id, !!query)
				: allModels;
			const filtered = filterAndRankModels(models, query);

			// Search results span the full catalog. Only the unfiltered subscription
			// views need supporting copy, so ordinary providers can flow directly
			// into their model list without a duplicate title card.
			if (section?.id === COMBINED_MODEL_SECTION_CHATGPT && !query) {
				const header = dom.append(list, dom.$('.combined-model-provider-section-header'));
				const headerMain = dom.append(header, dom.$('.combined-model-provider-section-header-main'));
				headerMain.appendChild(renderIcon(Codicon.openai));
				dom.append(headerMain, dom.$('.combined-model-provider-section-title')).textContent = localize('combinedPicker.chatGptSubscription', "ChatGPT Subscription");
				const description = dom.append(header, dom.$('.combined-model-provider-section-description'));
				description.textContent = connectedToChatGpt
					? localize('combinedPicker.chatGptConnectedDescription', "Connected. These models use your ChatGPT plan.")
					: localize('combinedPicker.chatGptDisconnectedDescription', "Connect ChatGPT to use models included with your plan.");
			}
			if (section?.id === COMBINED_MODEL_SECTION_CLAUDE && !query) {
				const header = dom.append(list, dom.$('.combined-model-provider-section-header'));
				const headerMain = dom.append(header, dom.$('.combined-model-provider-section-header-main'));
				const icon = dom.append(headerMain, dom.$('.combined-model-provider-brand-icon.provider-claude'));
				icon.setAttribute('aria-hidden', 'true');
				dom.append(headerMain, dom.$('.combined-model-provider-section-title')).textContent = localize('combinedPicker.claudeSubscription', "Claude Subscription");
				const description = dom.append(header, dom.$('.combined-model-provider-section-description'));
				description.textContent = connectedToClaude
					? localize('combinedPicker.claudeConnectedDescription', "Connected. These models use your Claude plan through Claude Code.")
					: localize('combinedPicker.claudeDisconnectedDescription', "Connect Claude Code to use models included with your plan.");
			}

			if (filtered.length === 0) {
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = query
					? localize('combinedPicker.noMatchingModels', "No matching models")
					: localize('combinedPicker.noModels', "No models available");
				renderSetupAction();
				return;
			}

			const currentModelId = this._modelDelegate.currentModel.get()?.identifier;
			filtered.forEach(model => {
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
				const routingOption = upstreamProviderId(model) === 'openrouter' ? this._routingOption(model) : undefined;
				const routingIndex = routingOption?.values.findIndex(value => Object.is(value, routingOption.currentValue)) ?? -1;
				const selectedRoutingLabel = routingIndex >= 0 && String(routingOption?.currentValue).toLowerCase() !== 'auto'
					? routingOption?.labels[routingIndex]
					: undefined;
				const detail = section?.id === COMBINED_MODEL_SECTION_CLAUDE && !query
					? undefined
					: !!query || section?.kind === 'library' || upstreamProviderId(model) === 'openrouter'
						? formatModelProviderDetail(model, selectedRoutingLabel)
						: undefined;
				if (detail) {
					dom.append(main, dom.$('.combined-model-provider-row-sub')).textContent = detail;
				}

				const commit = () => {
					const choosingOpenRouterModel = upstreamProviderId(model) === 'openrouter';
					if (!this._commit(providerId, model, choosingOpenRouterModel)) {
						return;
					}
					if (choosingOpenRouterModel) {
						// OpenRouter selection is a two-step choice: model, then serving
						// upstream. Keep the catalog behind a focused modal instead of
						// squeezing route selection into the picker footer.
						renderList();
						renderThinking();
						openRoutingModal();
					}
				};
				listStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, commit));
				listStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
					const event = new StandardKeyboardEvent(e);
					if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
						dom.EventHelper.stop(e, true);
						commit();
					}
				}));
			});

			renderSetupAction();
		};

		let previousGroup: CombinedModelSectionGroup | undefined;
		let previousKind: ICombinedModelSection['kind'] | undefined;
		let railGroup: HTMLElement | undefined;
		for (const section of sections) {
			if (section.group !== previousGroup) {
				const groupLabel = combinedModelSectionGroupLabel(section.group);
				railGroup = dom.append(railList, dom.$('.combined-model-provider-rail-group'));
				railGroup.setAttribute('role', 'group');
				railGroup.setAttribute('aria-label', groupLabel);
				const heading = dom.append(railGroup, dom.$('.combined-model-provider-rail-heading'));
				heading.textContent = groupLabel;
				heading.setAttribute('aria-hidden', 'true');
			} else if (section.kind !== previousKind) {
				// Library views and per-provider filters share the Backboard
				// heading; a hairline keeps the two lists visually distinct.
				dom.append(railGroup!, dom.$('.combined-model-provider-rail-divider'));
			}
			previousGroup = section.group;
			previousKind = section.kind;
			const button = dom.append(railGroup!, dom.$('button.combined-model-provider-rail-item')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'option');
			const libraryIcon = section.id === COMBINED_MODEL_SECTION_ALL
					? Codicon.listFlat
					: undefined;
			const providerIconKey = providerIconKeyForCombinedModelSection(section.id);
			if (libraryIcon) {
				button.appendChild(renderIcon(libraryIcon));
			} else if (providerIconKey) {
				const providerIcon = dom.append(button, dom.$('.combined-model-provider-rail-provider-icon'));
				providerIcon.classList.add(`provider-${providerIconKey}`);
				providerIcon.setAttribute('aria-hidden', 'true');
			} else {
				button.appendChild(renderIcon(Codicon.server));
			}
			dom.append(button, dom.$('.combined-model-provider-rail-item-label')).textContent = section.label;
			if (section.id === COMBINED_MODEL_SECTION_CHATGPT || section.id === COMBINED_MODEL_SECTION_CLAUDE) {
				const connected = section.id === COMBINED_MODEL_SECTION_CLAUDE ? connectedToClaude : connectedToChatGpt;
				const meta = dom.append(button, dom.$('.combined-model-provider-rail-item-meta'));
				meta.textContent = connected
					? localize('combinedPicker.connected', "Connected")
					: localize('combinedPicker.connect', "Connect");
				meta.classList.toggle('connected', connected);
			}
			railButtons.set(section.id, button);
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, e => {
				dom.EventHelper.stop(e, true);
				closeRoutingModal();
				this._railSection = section.id;
				this._searchValue = '';
				search.value = '';
				updateRailSelection();
				updateSearchPlaceholder();
				renderList();
				search.focus();
			}));
		}

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

		updateRailSelection();
		updateSearchPlaceholder();
		renderList();
		renderThinking();
		setTimeout(() => search.focus(), 0);
	}

	private _commit(providerId: string, model: ILanguageModelChatMetadataAndIdentifier, keepOpen = false): boolean {
		const activeProvider = this._activeProvider();
		const providerLocked = this._sessionTypeDelegate.canChangeSessionProvider?.() === false;
		if (providerLocked && providerId !== activeProvider) {
			return false;
		}
		const providerAllowed = this._selectableProviders().includes(providerId as AgentSessionTarget);
		const modelAllowed = providerAllowed && this._modelsForProvider(providerId).some(candidate => candidate.identifier === model.identifier);
		if (!modelAllowed) {
			return false;
		}
		if (providerId && providerId !== activeProvider && this._sessionTypeDelegate.setActiveSessionProvider) {
			this._sessionTypeDelegate.setActiveSessionProvider(providerId as AgentSessionTarget);
		}
		this._modelDelegate.setModel(model);
		this._updateTrigger();
		if (!keepOpen) {
			this._overlay.clear();
		}
		return true;
	}
}
