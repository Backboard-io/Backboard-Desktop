/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { byokProviderDefinition, ByokProviderId, isByokProviderId, isKeyBilledProvider, vendorOfProvider } from '../../../../../../platform/agentHost/common/byokProviders.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { BackboardConnectTarget, defaultBackboardConnectTargets, IBackboardConnectState, IBackboardConnectView, renderBackboardConnect } from '../../backboardConnect.js';
import { BackboardAuthContextKeys, SHOW_SIGN_IN_PROMPT_COMMAND_ID } from '../../../common/backboardAuth.js';
import { ISessionTypePickerDelegate } from '../../chat.js';
import { ILanguageModelChatMetadataAndIdentifier, LanguageModelBillingSource, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { resolveConfigProperty } from './chatModelPicker.js';
import { IModelConfigurationAccess, IModelPickerDelegate } from './modelPickerActionItem.js';
import { filterAndRankModels } from './modelSearch.js';
import './media/combinedModelProviderPicker.css';

/**
 * One recommendation rule: within a provider, the models whose id (after the
 * provider prefix) matches, grouped by the `family` capture and reduced to the
 * highest `version` capture. Nothing names a specific release, so a newer
 * model in the catalog replaces the older one without a code change.
 */
interface IRecommendedModelRule {
	readonly provider: string;
	/** Omitted: every model of the provider (subscriptions publish a curated list already). */
	readonly pattern?: RegExp;
	/** Keep only families on the provider's newest major version (GPT-6 Sol, not GPT-5.6 Terra). */
	readonly newestGenerationOnly?: boolean;
}

/** Ordered by who pays: connected subscriptions first, then Backboard-billed frontier models, then fast open models. */
const RECOMMENDED_MODEL_RULES: readonly IRecommendedModelRule[] = [
	{ provider: 'openai-subscription', pattern: /^gpt-(?<version>\d+(?:\.\d+)*)-(?<family>sol|astra|terra|luna)$/, newestGenerationOnly: true },
	{ provider: 'anthropic-subscription' },
	{ provider: 'anthropic', pattern: /^claude-(?<family>fable|opus|sonnet|haiku)-(?<version>\d+(?:-\d{1,2})?)(?:-\d{8})?$/ },
	{ provider: 'openai', pattern: /^gpt-(?<version>\d+(?:\.\d+)*)-(?<family>sol|astra|terra|luna)$/, newestGenerationOnly: true },
	{ provider: 'google', pattern: /^gemini-(?<version>\d+(?:\.\d+)*)-(?<family>pro|flash)(?:-preview)?$/ },
	{ provider: 'xai', pattern: /^grok-(?<version>\d+(?:\.\d+)*)$/ },
	{ provider: 'openrouter', pattern: /^deepseek\/deepseek-v(?<version>\d+(?:\.\d+)*)-(?<family>pro|flash)$/ },
	{ provider: 'openrouter', pattern: /^moonshotai\/kimi-k(?<version>\d+(?:\.\d+)*)$/ },
	{ provider: 'openrouter', pattern: /^qwen\/qwen(?<version>\d+(?:\.\d+)*)-max(?:-prime)?$/ },
	{ provider: 'openrouter', pattern: /^z-ai\/glm-(?<version>\d+(?:\.\d+)*)$/ },
	{ provider: 'cerebras', pattern: /^openai\/gpt-oss-120b$/ },
];

function compareModelVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) {
			return delta;
		}
	}
	return 0;
}

export const COMBINED_MODEL_SECTION_RECOMMENDED = 'recommended';
export const COMBINED_MODEL_SECTION_ALL = 'all';
/** Backboard models that run with no credit or plan. */
export const COMBINED_MODEL_SECTION_FREE = 'free';
export const COMBINED_MODEL_SECTION_CHATGPT = 'provider:openai-subscription';
export const COMBINED_MODEL_SECTION_CLAUDE = 'provider:anthropic-subscription';
/** Section id prefix for a provider's key-billed (BYOK) models; `provider:` covers its Backboard-billed ones. */
const BYOK_SECTION_PREFIX = 'byok:';

export function providerIconKeyForCombinedModelSection(sectionId: string): string | undefined {
	if (sectionId === COMBINED_MODEL_SECTION_RECOMMENDED) {
		return 'backboard';
	}
	const providerId = sectionId.startsWith('provider:')
		? vendorOfProvider(sectionId.slice('provider:'.length))
		: sectionId.startsWith(BYOK_SECTION_PREFIX)
			? vendorOfProvider(sectionId.slice(BYOK_SECTION_PREFIX.length))
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
	const cleanName = name.replace(/^[\p{L}\p{N}. &()-]{1,48}:\s+/u, '');
	const rawModelName = cleanName.split('/').pop() || cleanName;
	// Release-date stamps (`claude-haiku-4-5-20251001`, Bedrock's `-v1:0`) are not part of the name.
	const modelName = rawModelName.replace(/^(?:[^.]+\.)*anthropic\./i, '').replace(/(?:-v\d+(?::\d+)?)?$/i, '').replace(/[-_ ]20\d{6}$/, '');
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

/** Match the model author, including models routed through aggregators. */
export function modelBrandIconKey(model: ILanguageModelChatMetadataAndIdentifier): string {
	return modelBrandIconKeyForName(`${model.metadata.id} ${model.metadata.name}`)
		?? providerIconKeyForCombinedModelSection(`provider:${upstreamProviderId(model)}`)
		?? providerIconKeyForCombinedModelSection(`provider:${model.metadata.targetChatSessionType ?? ''}`)
		?? 'backboard';
}

/**
 * The brand logo key (`.combined-model-logo.provider-<key>`) for a model's id
 * or display name, including image and video generators; `undefined` when
 * no author is recognised.
 */
export function modelBrandIconKeyForName(name: string): string | undefined {
	const identity = name.toLowerCase();
	// Media generators, named by product rather than author.
	if (/seedance|seedream|bytedance/.test(identity)) { return 'bytedance'; }
	if (/(?:^|[ /])veo[ -]?\d|imagen|nano[ -]?banana/.test(identity)) { return 'google'; }
	if (/kling|kuaishou/.test(identity)) { return 'kwaipilot'; }
	if (/hailuo/.test(identity)) { return 'minimax'; }
	if (/(?:^|[ /])wan[ -]?\d|tongyi|alibaba/.test(identity)) { return 'qwen'; }
	if (/sora|dall-?e|gpt[ -]?image/.test(identity)) { return 'open-ai'; }
	if (/grok[ -]imagine|aurora/.test(identity)) { return 'x-ai'; }
	if (/dotsstudio|dots3/.test(identity)) { return 'dotsstudio'; }
	if (/longcat|meituan/.test(identity)) { return 'longcat'; }
	if (/nex-agi|nex[ -]n2/.test(identity)) { return 'nexagi'; }
	if (/perceptron/.test(identity)) { return 'perceptron'; }
	if (/poolside|laguna/.test(identity)) { return 'poolside'; }
	if (/reka/.test(identity)) { return 'reka'; }
	if (/relace/.test(identity)) { return 'relace'; }
	if (/sakana|fugu/.test(identity)) { return 'sakana'; }
	if (/thinkingmachines|inkling/.test(identity)) { return 'thinkingmachines'; }
	if (/union[ -]?alpha/.test(identity)) { return 'unionalpha'; }
	if (/writer|palmyra/.test(identity)) { return 'writer'; }
	if (/anthracite|magnum/.test(identity)) { return 'anthracite'; }
	if (/thedrummer|cydonia|skyfall|unslopnemo/.test(identity)) { return 'thedrummer'; }
	if (/gryphe|mythomax/.test(identity)) { return 'gryphe'; }
	if (/undi95|remm-slerp/.test(identity)) { return 'undi'; }
	if (/mancer|weaver/.test(identity)) { return 'mancer'; }
	if (/inclusionai|(?:^|[ /])ling[ -]/.test(identity)) { return 'inclusionai'; }
	if (/inference[.-]net|schematron/.test(identity)) { return 'inference'; }
	// Authors precede architecture names: DeepSeek R1 Distill Llama is DeepSeek.
	if (/deepseek/.test(identity)) { return 'deep-seek'; }
	if (/amazon|(?:^|[ /])nova[ -]/.test(identity)) { return 'bedrock'; }
	if (/ibm|granite/.test(identity)) { return 'ibm'; }
	if (/inception|mercury/.test(identity)) { return 'inception'; }
	if (/liquid|(?:^|[ /])lfm/.test(identity)) { return 'liquid'; }
	if (/kwaipilot|kat-coder/.test(identity)) { return 'kwaipilot'; }
	if (/ai21|jamba/.test(identity)) { return 'ai21'; }
	if (/baidu|ernie/.test(identity)) { return 'baidu'; }
	if (/bytedance|seed[ -]/.test(identity)) { return 'bytedance'; }
	if (/tencent|hunyuan/.test(identity)) { return 'tencent'; }
	if (/stepfun|step-/.test(identity)) { return 'stepfun'; }
	if (/xiaomi|mimo/.test(identity)) { return 'xiaomi'; }
	if (/arcee/.test(identity)) { return 'arcee'; }
	if (/essentialai|rnj-/.test(identity)) { return 'essentialai'; }
	if (/nousresearch|hermes/.test(identity)) { return 'nous'; }
	if (/upstage|solar[ -]/.test(identity)) { return 'upstage'; }
	if (/morph/.test(identity)) { return 'morph'; }
	if (/aionlabs|aion-/.test(identity)) { return 'aionlabs'; }
	if (/qwen|qwq/.test(identity)) { return 'qwen'; }
	if (/kimi|moonshot/.test(identity)) { return 'kimi'; }
	if (/glm|z-ai|zhipu/.test(identity)) { return 'zai'; }
	if (/llama|meta-llama|muse[ -]/.test(identity)) { return 'meta'; }
	if (/nvidia|nemotron/.test(identity)) { return 'nvidia'; }
	if (/microsoft|phi-[234]/.test(identity)) { return 'microsoft'; }
	if (/minimax/.test(identity)) { return 'minimax'; }
	if (/perplexity|sonar/.test(identity)) { return 'perplexity'; }
	if (/gemini|gemma/.test(identity)) { return 'google'; }
	if (/claude|anthropic/.test(identity)) { return 'claude'; }
	if (/gpt|openai|(?:^|[ /])o[134](?:[ -]|$)/.test(identity)) { return 'open-ai'; }
	if (/mistral|mixtral|codestral|devstral/.test(identity)) { return 'mistral'; }
	if (/grok|x-ai/.test(identity)) { return 'x-ai'; }
	if (/cohere|command-r|command-a/.test(identity)) { return 'cohere'; }
	return undefined;
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
	if (isKeyBilledProvider(providerId)) {
		const vendor = vendorOfProvider(providerId);
		const vendorLabel = isByokProviderId(vendor) ? byokProviderDefinition(vendor).label : formatModelLabel(vendor);
		return model.metadata.auth?.accountLabel
			? localize('combinedPicker.keyBilledDetail', "Billed to your {0} API key", vendorLabel)
			: model.metadata.auth?.statusLabel ?? localize('combinedPicker.keyRequiredDetail', "API key required");
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
	if (isKeyBilledProvider(upstreamProviderId(model))) {
		return 'byok';
	}
	return isSubscriptionModel(model) ? 'subscription' : 'backboard';
}

function combinedModelSectionId(model: ILanguageModelChatMetadataAndIdentifier): string {
	return `${billingSourceOf(model) === 'byok' ? BYOK_SECTION_PREFIX : 'provider:'}${upstreamProviderId(model)}`;
}

function isSubscriptionModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	const providerId = upstreamProviderId(model);
	return providerId === 'openai-subscription' || providerId === 'anthropic-subscription';
}

/** Models billed to the user's own API key; usable only while that key is connected. */
export function isKeyBilledModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return isKeyBilledProvider(upstreamProviderId(model));
}

/** Subscription and key-billed models are usable only once connected; everything else is always ready. */
function isReadyToUse(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return (!isSubscriptionModel(model) && !isKeyBilledModel(model)) || !!model.metadata.auth?.accountLabel;
}

function recommendedModels(models: readonly ILanguageModelChatMetadataAndIdentifier[]): ILanguageModelChatMetadataAndIdentifier[] {
	const ready = models.filter(isReadyToUse);
	const recommended: ILanguageModelChatMetadataAndIdentifier[] = [];
	for (const rule of RECOMMENDED_MODEL_RULES) {
		const candidates = ready.filter(model => upstreamProviderId(model) === rule.provider && billingSourceOf(model) !== 'byok');
		if (!rule.pattern) {
			// Most capable first; the catalog itself lists them alphabetically.
			const tier = (model: ILanguageModelChatMetadataAndIdentifier) => {
				const index = ['fable', 'opus', 'sonnet', 'haiku'].findIndex(family => model.metadata.name.toLowerCase().includes(family));
				return index < 0 ? Number.MAX_SAFE_INTEGER : index;
			};
			recommended.push(...[...candidates].sort((a, b) => tier(a) - tier(b)));
			continue;
		}
		// Newest version per family, in the order families first appear.
		const newest = new Map<string, { model: ILanguageModelChatMetadataAndIdentifier; version: number[] }>();
		for (const model of candidates) {
			const match = rule.pattern.exec(model.metadata.id.slice(model.metadata.id.indexOf('/') + 1));
			if (!match) {
				continue;
			}
			const family = match.groups?.family ?? '';
			const version = (match.groups?.version ?? '0').split(/[.-]/).map(Number);
			const current = newest.get(family);
			if (!current || compareModelVersions(version, current.version) > 0) {
				newest.set(family, { model, version });
			}
		}
		// Families list in the order the pattern names them (Fable, Opus, Sonnet, Haiku).
		const familyOrder = rule.pattern.source;
		const picks = [...newest.entries()].sort(([a], [b]) => familyOrder.indexOf(a) - familyOrder.indexOf(b)).map(([, pick]) => pick);
		const generation = Math.max(...picks.map(pick => pick.version[0] ?? 0));
		recommended.push(...picks
			.filter(pick => !rule.newestGenerationOnly || (pick.version[0] ?? 0) === generation)
			.map(pick => pick.model));
	}
	return recommended.length ? recommended : ready;
}

/** Rail label for an upstream provider; drops per-model suffixes such as "OpenRouter · Z.ai". */
function providerSectionLabel(providerId: string, detail: string | undefined): string {
	const trimmed = detail?.trim() ?? '';
	const separator = trimmed.indexOf(' · ');
	const label = separator > 0 ? trimmed.slice(0, separator).trim() : trimmed;
	return label || formatModelLabel(vendorOfProvider(providerId));
}

/** Builds the stable left-rail sections grouped by Backboard, subscriptions, then BYOK. */
export function buildCombinedModelSections(models: readonly ILanguageModelChatMetadataAndIdentifier[]): ICombinedModelSection[] {
	const recommendedCount = recommendedModels(models).length;
	const freeCount = models.filter(isFreeModel).length;
	// A provider is tallied separately for its Backboard-billed and key-billed
	// rows, so a vendor the user holds a key for can appear in both groups.
	const providers = new Map<string, { label: string; count: number; keyBilled: boolean }>();
	for (const model of models) {
		const id = upstreamProviderId(model);
		const keyBilled = billingSourceOf(model) === 'byok';
		const sectionId = combinedModelSectionId(model);
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
		...(freeCount ? [{
			id: COMBINED_MODEL_SECTION_FREE,
			label: localize('combinedPicker.free', "Free"),
			modelCount: freeCount,
			kind: 'library' as const,
			group: 'backboard' as const,
		}] : []),
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

/**
 * A Backboard-billed model that runs with no credit or plan; the agent host
 * marks it with `priceCategory: 'free'` from the catalog's exact-$0 prices.
 */
export function isFreeModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	return model.metadata.priceCategory === 'free' && billingSourceOf(model) !== 'byok';
}

/** Returns the models represented by one left-rail section, or the full catalog during a search. */
export function modelsForCombinedModelSection(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	sectionId: string,
	includeAllModels = false,
): ILanguageModelChatMetadataAndIdentifier[] {
	if (includeAllModels) {
		// Search spans the full catalog, but a subscription that is not connected
		// must not outrank the library copy of the same model (e.g. "opus 5"
		// surfacing the Claude Code entry before Anthropic's). Those models stay
		// reachable from their own section, which explains how to connect; keep
		// them only while the user is already browsing that section.
		return models.filter(model => isReadyToUse(model) || combinedModelSectionId(model) === sectionId);
	}
	if (sectionId === COMBINED_MODEL_SECTION_ALL) {
		return [...models];
	}
	if (sectionId === COMBINED_MODEL_SECTION_RECOMMENDED) {
		return recommendedModels(models);
	}
	if (sectionId === COMBINED_MODEL_SECTION_FREE) {
		return models.filter(isFreeModel);
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

/** Rail entry listing every way to connect (sign in, subscriptions, API keys). */
export const COMBINED_MODEL_SECTION_CONNECT = 'connect';

/** "1M context" / "200K context" from a model's input window; undefined when unknown. */
export function formatContextWindow(tokens: number | undefined): string | undefined {
	if (!tokens || tokens <= 0) {
		return undefined;
	}
	if (tokens >= 1_000_000) {
		const millions = Math.round(tokens / 100_000) / 10;
		return localize('combinedPicker.contextMillions', "{0}M context", Number.isInteger(millions) ? millions : millions.toFixed(1));
	}
	return localize('combinedPicker.contextThousands', "{0}K context", Math.round(tokens / 1000));
}

/** A per-million-token price such as "$0.14", "$3.50" or "$15". */
export function formatPrice(dollars: number): string {
	return dollars >= 100 ? `$${Math.round(dollars)}` : `$${dollars.toFixed(2).replace(/\.00$/, '')}`;
}

const COST_SCALE_MIN = 0.05;
const COST_SCALE_MAX = 40;

/**
 * Where a model sits on the cheap-to-expensive scale, 0..1, from a blended
 * per-million price (three input tokens per output token, typical for agent
 * turns) on a log scale. Undefined when the catalog has no price.
 */
export function modelCostScore(model: ILanguageModelChatMetadataAndIdentifier): number | undefined {
	const input = model.metadata.inputCost;
	const output = model.metadata.outputCost;
	if (input === undefined && output === undefined) {
		return undefined;
	}
	const blended = ((input ?? output!) * 3 + (output ?? input!)) / 4;
	if (blended <= 0) {
		return 0;
	}
	const position = Math.log(blended / COST_SCALE_MIN) / Math.log(COST_SCALE_MAX / COST_SCALE_MIN);
	return Math.max(0, Math.min(1, position));
}

function connectHint(target: BackboardConnectTarget): string {
	switch (target) {
		case 'backboard': return localize('combinedPicker.connectBackboardHint', "Sign in to Backboard to use this model");
		case 'chatgpt': return localize('combinedPicker.connectChatGptHint', "Connect ChatGPT to use this model");
		case 'claude': return localize('combinedPicker.connectClaudeHint', "Connect Claude to use this model");
		case 'key': return localize('combinedPicker.connectKeyHint', "Add an API key to use this model");
	}
}

/**
 * Model picker for the Sessions composer. A single inline control shows the
 * active model and thinking level; opening it reveals a searchable model list
 * and a discrete reasoning slider. Subscription/provider switching belongs to
 * session setup rather than this focused model-selection surface.
 */
export class CombinedModelProviderPickerActionItem extends BaseActionViewItem {

	private _triggerElement: HTMLElement | undefined;
	private _triggerBrand: HTMLElement | undefined;
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
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
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
		this._triggerBrand = dom.append(trigger, dom.$('span.combined-model-logo'));
		this._triggerBrand.setAttribute('aria-hidden', 'true');
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
		if (this._triggerBrand) {
			this._triggerBrand.className = `combined-model-logo provider-${model ? modelBrandIconKey(model) : 'backboard'}`;
		}
		this._triggerThinking.textContent = thinkingLabel ?? '';
		// The billing route is always visible from the composer, including an
		// unavailable key-billed selection.
		const billingDetail = model ? formatModelProviderDetail(model) : undefined;
		if (this._triggerElement) {
			this._triggerElement.title = billingDetail ?? '';
		}
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

	/** What is already connected, for the inline Connect rows and unavailable models. */
	private _connectState(models: readonly ILanguageModelChatMetadataAndIdentifier[]): IBackboardConnectState {
		const keys = new Set<ByokProviderId>();
		for (const model of models) {
			const vendor = vendorOfProvider(upstreamProviderId(model));
			if (isKeyBilledModel(model) && model.metadata.auth?.accountLabel && isByokProviderId(vendor)) {
				keys.add(vendor);
			}
		}
		return {
			signedIn: this._contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) === true,
			chatGpt: isChatGptSubscriptionConnected(models),
			claude: isClaudeSubscriptionConnected(models),
			keys,
		};
	}

	/**
	 * Re-reads the catalog after a connection changed. `announce` reports the
	 * outcome; the automatic refresh after connecting stays quiet.
	 */
	private _refreshModels(announce: boolean): Promise<void> {
		this._refreshPromise ??= this._agentHostService.executeAgentCommand({ provider: 'backboard', command: 'models.refresh' })
			.then(() => {
				if (announce) {
					this._notificationService.info(localize('combinedPicker.refreshSuccess', "Models and subscriptions are up to date."));
				}
			}, error => {
				const message = error instanceof Error ? error.message : String(error);
				this._notificationService.error(message.includes('Unsupported Backboard command: models.refresh')
					? localize('combinedPicker.refreshRestartRequired', "Restart Backboard after your running agents finish to enable model and subscription refresh.")
					: localize('combinedPicker.refreshFailed', "Could not refresh models and subscriptions: {0}", message));
			})
			.finally(() => {
				this._refreshPromise = undefined;
				this._onDidRefresh.fire();
			});
		this._onDidRefresh.fire();
		return this._refreshPromise;
	}

	/** The connect target that makes an unavailable model usable. */
	private _connectTargetFor(model: ILanguageModelChatMetadataAndIdentifier): { target: BackboardConnectTarget; provider?: ByokProviderId } {
		const providerId = upstreamProviderId(model);
		if (providerId === 'openai-subscription') {
			return { target: 'chatgpt' };
		}
		if (providerId === 'anthropic-subscription') {
			return { target: 'claude' };
		}
		if (isKeyBilledModel(model)) {
			const vendor = vendorOfProvider(providerId);
			return { target: 'key', provider: isByokProviderId(vendor) ? vendor : undefined };
		}
		return { target: 'backboard' };
	}

	/**
	 * The effort control for one model. Per-model settings apply to any row; the
	 * session-wide fallback only belongs to the model in use.
	 */
	private _thinkingOptionFor(model: ILanguageModelChatMetadataAndIdentifier, isCurrent: boolean): ICombinedModelThinkingOption | undefined {
		if (isCurrent) {
			return this._thinkingOption(model);
		}
		const config = resolveConfigProperty(model, 'navigation', this._modelConfiguration);
		if (!config?.schema.enum?.length) {
			return undefined;
		}
		const labels = config.schema.enum.map((value, index) => config.schema.enumItemLabels?.[index] ?? String(value));
		const explicit = resolveExplicitReasoningOptions(config.schema.enum, labels, config.value);
		return explicit ? {
			label: localize('combinedPicker.reasoning', "Reasoning"),
			currentLabel: explicit.currentLabel,
			currentValue: explicit.currentValue,
			values: explicit.values,
			labels: explicit.labels,
			needsMigration: explicit.needsMigration,
			setValue: value => this._modelConfiguration.setModelConfiguration(model.identifier, { [config.key]: value }),
		} : undefined;
	}

	private _renderOverlay(container: HTMLElement, store: DisposableStore): void {
		dom.clearNode(container);
		const root = dom.append(container, dom.$('.combined-model-provider-root'));
		const allModels = this._modelsForProvider(this._railProvider ?? '');
		const showingBackboard = this._railProvider === AgentSessionProviders.AgentHostBackboard;
		const connectState = this._connectState(allModels);
		const sections: ICombinedModelSection[] = showingBackboard
			? buildCombinedModelSections(allModels)
			: [{ id: COMBINED_MODEL_SECTION_ALL, label: localize('combinedPicker.allModels', "All models"), modelCount: allModels.length, kind: 'library' as const, group: 'models' as const }];
		if (this._railSection !== COMBINED_MODEL_SECTION_CONNECT && !sections.some(section => section.id === this._railSection)) {
			this._railSection = sections[0]?.id ?? COMBINED_MODEL_SECTION_ALL;
		}
		const currentModel = this._modelDelegate.currentModel.get();
		const currentOption = currentModel ? this._thinkingOption(currentModel) : undefined;
		if (currentModel && currentOption?.needsMigration) {
			void Promise.resolve(currentOption.setValue(currentOption.currentValue)).then(() => this._updateTrigger());
		}

		// --- Slim navigation rail ---
		const rail = dom.append(root, dom.$('.combined-model-provider-rail'));
		const railList = dom.append(rail, dom.$('.combined-model-provider-rail-list'));
		railList.setAttribute('role', 'listbox');

		// --- Search and model list ---
		const pane = dom.append(root, dom.$('.combined-model-provider-pane'));
		const searchRow = dom.append(pane, dom.$('.combined-model-provider-search'));
		searchRow.appendChild(renderIcon(Codicon.search));
		const search = dom.append(searchRow, dom.$('input.combined-model-provider-search-input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('combinedPicker.searchAllModelsPlaceholder', "Search all models…");
		search.value = this._searchValue;
		search.setAttribute('aria-label', search.placeholder);
		if (showingBackboard) {
			const refresh = dom.append(searchRow, dom.$('button.combined-model-provider-refresh')) as HTMLButtonElement;
			refresh.type = 'button';
			const label = localize('combinedPicker.refreshModels', "Refresh Models and Subscriptions");
			refresh.setAttribute('aria-label', label);
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), refresh, label));
			const icon = refresh.appendChild(renderIcon(Codicon.refresh));
			refresh.disabled = !!this._refreshPromise;
			refresh.setAttribute('aria-busy', String(!!this._refreshPromise));
			icon.classList.toggle('combined-model-provider-refresh-spinning', !!this._refreshPromise);
			store.add(dom.addDisposableListener(refresh, dom.EventType.CLICK, event => {
				dom.EventHelper.stop(event, true);
				void this._refreshModels(true);
			}));
		}
		const list = dom.append(pane, dom.$('.combined-model-provider-list'));
		list.setAttribute('role', 'listbox');

		// --- Reasoning slider for the model in use, always in the same place ---
		const thinking = dom.append(pane, dom.$('.combined-model-provider-thinking'));
		const thinkingStore = store.add(new DisposableStore());
		const renderThinking = () => {
			thinkingStore.clear();
			dom.clearNode(thinking);
			const model = this._modelDelegate.currentModel.get();
			const option = model ? this._thinkingOption(model) : undefined;
			thinking.classList.toggle('hidden', !model || !option || option.values.length < 2);
			if (!model || !option || option.values.length < 2) {
				return;
			}
			thinking.dataset.provider = upstreamProviderId(model);
			const heading = dom.append(thinking, dom.$('.combined-model-provider-thinking-heading'));
			dom.append(heading, dom.$('.combined-model-provider-thinking-title')).textContent = option.label;
			const value = dom.append(heading, dom.$('.combined-model-provider-thinking-current'));
			value.setAttribute('aria-live', 'polite');
			const shell = dom.append(thinking, dom.$('.combined-model-provider-thinking-slider-shell'));
			const dots = dom.append(shell, dom.$('.combined-model-provider-thinking-dots'));
			const dotElements = option.values.map(() => dom.append(dots, dom.$('span.combined-model-provider-thinking-dot')));
			const slider = dom.append(shell, dom.$('input.combined-model-provider-thinking-slider')) as HTMLInputElement;
			slider.type = 'range';
			slider.min = '0';
			slider.max = String(option.values.length - 1);
			slider.step = '1';
			slider.setAttribute('aria-label', localize('combinedPicker.reasoningAriaLabel', "Reasoning level for {0}", formatModelLabel(model.metadata.name)));
			let applied = Math.max(0, option.values.findIndex(candidate => Object.is(candidate, option.currentValue)));
			const paint = (index: number) => {
				const label = option.labels[index] ?? String(option.values[index]);
				value.textContent = label;
				slider.setAttribute('aria-valuetext', label);
				dotElements.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex <= index));
				shell.style.setProperty('--combined-thinking-progress', String(index / (option.values.length - 1)));
			};
			slider.value = String(applied);
			paint(applied);
			let queue: Promise<void> = Promise.resolve();
			const apply = () => {
				const index = Math.max(0, Math.min(option.values.length - 1, Math.round(Number(slider.value))));
				paint(index);
				if (index === applied) {
					return;
				}
				applied = index;
				if (this._triggerThinking) {
					this._triggerThinking.textContent = option.labels[index] ?? String(option.values[index]);
				}
				queue = queue
					.then(() => Promise.resolve(option.setValue(option.values[index])))
					.then(() => {
						this._updateTrigger();
						const row = list.querySelector<HTMLElement>('.combined-model-provider-row.selected .combined-model-provider-row-effort');
						if (row) {
							row.textContent = option.labels[index] ?? String(option.values[index]);
						}
					}, () => undefined);
			};
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.INPUT, apply));
			thinkingStore.add(dom.addDisposableListener(slider, dom.EventType.CHANGE, apply));
		};

		// --- Detail card beside the list (Devin-style), shown for the hovered or active row ---
		const card = dom.append(container, dom.$('.combined-model-provider-card.hidden'));
		card.setAttribute('role', 'dialog');
		const cardStore = store.add(new DisposableStore());
		const listStore = store.add(new DisposableStore());
		let cardModel: ILanguageModelChatMetadataAndIdentifier | undefined;
		let cardRow: HTMLElement | undefined;
		let showTimer: ReturnType<typeof setTimeout> | undefined;
		let hideTimer: ReturnType<typeof setTimeout> | undefined;
		const clearTimers = () => {
			if (showTimer) { clearTimeout(showTimer); showTimer = undefined; }
			if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
		};
		store.add({ dispose: clearTimers });

		const hideCard = () => {
			clearTimers();
			cardModel = undefined;
			cardRow = undefined;
			cardStore.clear();
			card.classList.add('hidden');
		};
		const scheduleHide = () => {
			if (showTimer) { clearTimeout(showTimer); showTimer = undefined; }
			if (hideTimer) { clearTimeout(hideTimer); }
			hideTimer = setTimeout(() => {
				hideTimer = undefined;
				if (!card.matches(':hover') && !card.contains(dom.getActiveElement())) {
					hideCard();
				}
			}, 160);
		};

		const placeCard = () => {
			if (!cardRow) {
				return;
			}
			const window = dom.getWindow(container);
			const containerRect = container.getBoundingClientRect();
			const rowRect = cardRow.getBoundingClientRect();
			const cardWidth = card.offsetWidth || 300;
			const cardHeight = card.offsetHeight;
			const roomLeft = containerRect.left;
			const roomRight = window.innerWidth - containerRect.right;
			card.classList.toggle('right', roomLeft < cardWidth + 12 && roomRight > roomLeft);
			const minTop = 8 - containerRect.top;
			const maxTop = window.innerHeight - 8 - cardHeight - containerRect.top;
			const top = Math.max(minTop, Math.min(rowRect.top - containerRect.top - 6, maxTop));
			card.style.top = `${Math.round(top)}px`;
		};

		const renderCard = (model: ILanguageModelChatMetadataAndIdentifier, row: HTMLElement) => {
			cardStore.clear();
			dom.clearNode(card);
			cardModel = model;
			cardRow = row;
			const isCurrent = model.identifier === this._modelDelegate.currentModel.get()?.identifier;
			const option = this._thinkingOptionFor(model, isCurrent);
			const name = formatModelLabel(model.metadata.name);
			card.setAttribute('aria-label', name);

			const header = dom.append(card, dom.$('.combined-model-provider-card-header'));
			const title = dom.append(header, dom.$('.combined-model-provider-card-title'));
			dom.append(title, dom.$('span')).textContent = name;
			if (option) {
				dom.append(title, dom.$('span.combined-model-provider-card-effort')).textContent = option.currentLabel;
			}
			const facts = [formatContextWindow(model.metadata.maxInputTokens), formatModelProviderDetail(model)].filter((fact): fact is string => !!fact);
			if (facts.length) {
				dom.append(header, dom.$('.combined-model-provider-card-sub')).textContent = facts.join(' · ');
			}

			const routing = upstreamProviderId(model) === 'openrouter' ? this._routingOption(model) : undefined;
			if (routing) {
				const field = dom.append(card, dom.$('.combined-model-provider-card-field.inline'));
				dom.append(field, dom.$('.combined-model-provider-card-label')).textContent = localize('combinedPicker.servingProvider', "Provider");
				const select = dom.append(field, dom.$('select.combined-model-provider-card-select')) as HTMLSelectElement;
				select.setAttribute('aria-label', routing.label);
				routing.values.forEach((value, index) => {
					const choice = dom.append(select, dom.$('option')) as HTMLOptionElement;
					choice.value = String(index);
					choice.textContent = routing.labels[index] ?? String(value);
					choice.selected = Object.is(value, routing.currentValue);
				});
				cardStore.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => {
					const value = routing.values[Number(select.value)];
					void Promise.resolve(routing.setValue(value)).then(() => {
						this._updateTrigger();
						renderList();
					});
				}));
			}

			const cost = dom.append(card, dom.$('.combined-model-provider-card-cost'));
			const costHeading = dom.append(cost, dom.$('.combined-model-provider-card-cost-heading'));
			dom.append(costHeading, dom.$('span.combined-model-provider-card-label')).textContent = localize('combinedPicker.cost', "Cost");
			const unavailable = !isReadyToUse(model);
			const providerId = upstreamProviderId(model);
			if (unavailable) {
				dom.append(costHeading, dom.$('span.combined-model-provider-card-note')).textContent = connectHint(this._connectTargetFor(model).target);
			} else if (providerId === 'openai-subscription' || providerId === 'anthropic-subscription') {
				dom.append(costHeading, dom.$('span.combined-model-provider-card-note')).textContent = providerId === 'openai-subscription'
					? localize('combinedPicker.includedChatGpt', "Included with your ChatGPT plan")
					: localize('combinedPicker.includedClaude', "Included with your Claude plan");
			} else if (isFreeModel(model)) {
				dom.append(costHeading, dom.$('span.combined-model-provider-card-note')).textContent = localize('combinedPicker.freeNote', "Free, no credits needed");
			} else {
				const score = modelCostScore(model);
				if (score !== undefined) {
					const meter = dom.append(cost, dom.$('.combined-model-provider-card-meter'));
					meter.style.setProperty('--combined-cost', String(score));
					dom.append(meter, dom.$('span.combined-model-provider-card-meter-dot'));
				}
				const prices = dom.append(cost, dom.$('.combined-model-provider-card-prices'));
				for (const [label, value] of [
					[localize('combinedPicker.inputPrice', "Input"), model.metadata.inputCost],
					[localize('combinedPicker.cachedPrice', "Cached input"), model.metadata.cacheCost],
					[localize('combinedPicker.outputPrice', "Output"), model.metadata.outputCost],
				] as const) {
					if (value === undefined) {
						continue;
					}
					const line = dom.append(prices, dom.$('.combined-model-provider-card-price'));
					dom.append(line, dom.$('span.combined-model-provider-card-price-label')).textContent = label;
					dom.append(line, dom.$('span.combined-model-provider-card-price-value')).textContent = localize('combinedPicker.pricePerMillion', "{0} / 1M", formatPrice(value));
				}
			}

			card.classList.remove('hidden');
			placeCard();
		};

		const showCardFor = (model: ILanguageModelChatMetadataAndIdentifier, row: HTMLElement, immediate: boolean) => {
			if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
			if (showTimer) { clearTimeout(showTimer); showTimer = undefined; }
			if (cardModel?.identifier === model.identifier && !card.classList.contains('hidden')) {
				return;
			}
			if (immediate || !card.classList.contains('hidden')) {
				renderCard(model, row);
				return;
			}
			showTimer = setTimeout(() => {
				showTimer = undefined;
				renderCard(model, row);
			}, 260);
		};
		store.add(dom.addDisposableListener(card, dom.EventType.MOUSE_ENTER, () => {
			if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
		}));
		store.add(dom.addDisposableListener(card, dom.EventType.MOUSE_LEAVE, scheduleHide));

		let activeIndex = -1;
		const rows = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.combined-model-provider-row')];
		const setActive = (index: number, reveal: boolean) => {
			const all = rows();
			if (!all.length) {
				activeIndex = -1;
				return;
			}
			activeIndex = Math.max(0, Math.min(all.length - 1, index));
			all.forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === activeIndex));
			const row = all[activeIndex];
			if (reveal) {
				row.scrollIntoView({ block: 'nearest' });
				const model = modelsByRow.get(row);
				if (model) {
					showCardFor(model, row, true);
				}
			}
		};
		const modelsByRow = new WeakMap<HTMLElement, ILanguageModelChatMetadataAndIdentifier>();
		let connectView: IBackboardConnectView | undefined;

		const onDidConnect = async (): Promise<void> => {
			await this._refreshModels(false);
		};
		const renderConnect = (parent: HTMLElement, targets: readonly BackboardConnectTarget[]): void => {
			const view = renderBackboardConnect(parent, this._commandService, connectState, { targets, onDidConnect });
			listStore.add(view.store);
			connectView = view;
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
			connectView = undefined;
			const query = this._searchValue.trim().toLowerCase();
			if (this._railSection === COMBINED_MODEL_SECTION_CONNECT && !query) {
				hideCard();
				renderConnect(list, defaultBackboardConnectTargets());
				return;
			}
			const section = sections.find(candidate => candidate.id === this._railSection);
			const models = showingBackboard && section
				? modelsForCombinedModelSection(allModels, section.id, !!query)
				: allModels;
			const filtered = filterAndRankModels(models, query);

			if (filtered.length === 0) {
				dom.append(list, dom.$('.combined-model-provider-empty')).textContent = query
					? localize('combinedPicker.noMatchingModels', "No matching models")
					: localize('combinedPicker.noModels', "No models available");
			}

			const currentId = this._modelDelegate.currentModel.get()?.identifier;
			// The same model can be listed once per route (Anthropic and Bedrock);
			// name the route whenever a label would otherwise repeat.
			const labelCounts = new Map<string, number>();
			for (const model of filtered) {
				const label = formatModelLabel(model.metadata.name);
				labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
			}
			for (const model of filtered) {
				const providerId = model.metadata.targetChatSessionType ?? this._railProvider ?? '';
				const isCurrent = model.identifier === currentId;
				// Signed out, only Backboard's free models run (on the device's guest
				// key); every other Backboard model stays listed but needs a sign-in.
				const needsSignIn = !connectState.signedIn && !isSubscriptionModel(model) && !isKeyBilledModel(model) && !isFreeModel(model);
				const unavailable = !isReadyToUse(model) || needsSignIn;
				const row = dom.append(list, dom.$('.combined-model-provider-row'));
				modelsByRow.set(row, model);
				row.dataset.model = model.identifier;
				row.tabIndex = -1;
				row.setAttribute('role', 'option');
				row.setAttribute('aria-selected', String(isCurrent));
				row.classList.toggle('selected', isCurrent);
				row.classList.toggle('unavailable', unavailable);

				dom.append(row, dom.$(`.combined-model-logo.provider-${modelBrandIconKey(model)}`)).setAttribute('aria-hidden', 'true');
				const nameCell = dom.append(row, dom.$('.combined-model-provider-row-name'));
				dom.append(nameCell, dom.$('span.combined-model-provider-row-name-text')).textContent = formatModelLabel(model.metadata.name);
				const effort = this._thinkingOptionFor(model, isCurrent)?.currentLabel;
				if (effort) {
					dom.append(nameCell, dom.$('span.combined-model-provider-row-effort')).textContent = effort;
				}
				// Subscription rows already say "Plan"; only other routes need naming.
				const route = !isSubscriptionModel(model) && ((query && billingSourceOf(model) !== 'backboard') || (labelCounts.get(formatModelLabel(model.metadata.name)) ?? 0) > 1)
					? formatModelProviderDetail(model)
					: undefined;
				if (route) {
					dom.append(nameCell, dom.$('span.combined-model-provider-row-route')).textContent = route;
				}

				const meta = dom.append(row, dom.$('.combined-model-provider-row-meta'));
				if (needsSignIn) {
					dom.append(meta, dom.$('span.combined-model-provider-row-connect')).textContent = localize('combinedPicker.signIn', "Sign In");
				} else if (unavailable) {
					dom.append(meta, dom.$('span.combined-model-provider-row-connect')).textContent = localize('combinedPicker.connect', "Connect");
				} else if (isSubscriptionModel(model)) {
					dom.append(meta, dom.$('span.combined-model-provider-row-plan')).textContent = localize('combinedPicker.plan', "Plan");
				} else if (isFreeModel(model)) {
					dom.append(meta, dom.$('span.combined-model-provider-row-plan')).textContent = localize('combinedPicker.freeTag', "Free");
				} else {
					const score = modelCostScore(model);
					if (score !== undefined) {
						const bar = dom.append(meta, dom.$('span.combined-model-provider-row-cost'));
						bar.style.setProperty('--combined-cost', String(score));
						dom.append(bar, dom.$('span.combined-model-provider-row-cost-dot'));
						bar.setAttribute('aria-hidden', 'true');
					}
				}
				if (isCurrent) {
					meta.appendChild(renderIcon(Codicon.check));
				}
				row.setAttribute('aria-label', [formatModelLabel(model.metadata.name), effort, formatModelProviderDetail(model)].filter(Boolean).join(', '));

				const commit = async () => {
					if (needsSignIn) {
						hideCard();
						this._overlay.clear();
						await this._commandService.executeCommand(SHOW_SIGN_IN_PROMPT_COMMAND_ID, formatModelLabel(model.metadata.name));
						return;
					}
					if (unavailable) {
						// Connecting lives in one place: jump there with the right row ready.
						const { target, provider } = this._connectTargetFor(model);
						hideCard();
						this._railSection = COMBINED_MODEL_SECTION_CONNECT;
						this._searchValue = '';
						search.value = '';
						updateRailSelection();
						renderList();
						connectView?.reveal(target, provider);
						return;
					}
					await this._commit(providerId, model);
				};
				listStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => void commit()));
				listStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_ENTER, () => {
					setActive(rows().indexOf(row), false);
					showCardFor(model, row, false);
				}));
				listStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_LEAVE, scheduleHide));
			}

			const all = rows();
			const selectedIndex = all.findIndex(row => row.classList.contains('selected'));
			setActive(query ? 0 : Math.max(0, selectedIndex), false);
			if (!query && selectedIndex >= 0) {
				all[selectedIndex].scrollIntoView({ block: 'nearest' });
			}
			if (cardModel) {
				const row = list.querySelector<HTMLElement>(`[data-model="${CSS.escape(cardModel.identifier)}"]`);
				if (row) {
					cardRow = row;
					placeCard();
				} else {
					hideCard();
				}
			}
		};
		store.add(dom.addDisposableListener(list, 'scroll', () => {
			if (!card.classList.contains('hidden')) {
				placeCard();
			}
		}));

		let previousGroup: CombinedModelSectionGroup | undefined;
		let railGroup: HTMLElement | undefined;
		const addRailButton = (parent: HTMLElement, id: string, label: string, decorate: (button: HTMLButtonElement) => void) => {
			const button = dom.append(parent, dom.$('button.combined-model-provider-rail-item')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'option');
			decorate(button);
			// Icon-only: the name is the accessible label and the hover.
			button.setAttribute('aria-label', label);
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, label));
			railButtons.set(id, button);
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
				dom.EventHelper.stop(event, true);
				hideCard();
				this._railSection = id;
				this._searchValue = '';
				search.value = '';
				updateRailSelection();
				renderList();
				search.focus();
			}));
			return button;
		};
		for (const section of sections) {
			if (section.group !== previousGroup) {
				const groupLabel = combinedModelSectionGroupLabel(section.group);
				railGroup = dom.append(railList, dom.$('.combined-model-provider-rail-group'));
				railGroup.setAttribute('role', 'group');
				railGroup.setAttribute('aria-label', groupLabel);
			}
			previousGroup = section.group;
			const subscription = section.id === COMBINED_MODEL_SECTION_CHATGPT || section.id === COMBINED_MODEL_SECTION_CLAUDE;
			const connected = section.id === COMBINED_MODEL_SECTION_CLAUDE ? connectState.claude : connectState.chatGpt;
			const railLabel = !subscription
				? section.label
				: connected
					? localize('combinedPicker.subscriptionConnected', "{0} (Connected)", section.label)
					: localize('combinedPicker.subscriptionNotConnected', "{0} (Not Connected)", section.label);
			const button = addRailButton(railGroup!, section.id, railLabel, target => {
				const providerIconKey = providerIconKeyForCombinedModelSection(section.id);
				if (section.id === COMBINED_MODEL_SECTION_ALL) {
					target.appendChild(renderIcon(Codicon.listFlat));
				} else if (section.id === COMBINED_MODEL_SECTION_FREE) {
					target.appendChild(renderIcon(Codicon.gift));
				} else if (providerIconKey) {
					dom.append(target, dom.$(`.combined-model-provider-rail-provider-icon.provider-${providerIconKey}`)).setAttribute('aria-hidden', 'true');
				} else {
					target.appendChild(renderIcon(Codicon.server));
				}
			});
			button.classList.toggle('connected', subscription && connected);
		}
		if (showingBackboard) {
			const footer = dom.append(rail, dom.$('.combined-model-provider-rail-footer'));
			addRailButton(footer, COMBINED_MODEL_SECTION_CONNECT, localize('combinedPicker.connectRail', "Connect"), button => {
				button.appendChild(renderIcon(Codicon.plug));
			});
		}

		store.add(dom.addDisposableListener(search, dom.EventType.INPUT, () => {
			this._searchValue = search.value;
			hideCard();
			renderList();
		}));
		store.add(dom.addDisposableListener(search, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				if (!card.classList.contains('hidden')) {
					hideCard();
					return;
				}
				this._overlay.clear();
				return;
			}
			if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
				dom.EventHelper.stop(e, true);
				setActive(activeIndex + (event.equals(KeyCode.DownArrow) ? 1 : -1), true);
				return;
			}
			if (event.equals(KeyCode.Enter)) {
				dom.EventHelper.stop(e, true);
				rows()[Math.max(0, activeIndex)]?.click();
				return;
			}
			// ⌘1..⌘9 quick-select the nth visible model.
			if (event.metaKey || event.ctrlKey) {
				const digit = event.keyCode >= KeyCode.Digit1 && event.keyCode <= KeyCode.Digit9
					? event.keyCode - KeyCode.Digit0
					: undefined;
				if (digit !== undefined) {
					dom.EventHelper.stop(e, true);
					rows()[digit - 1]?.click();
				}
			}
		}));

		updateRailSelection();
		renderList();
		renderThinking();
		setTimeout(() => search.focus(), 0);
	}

	private async _commit(providerId: string, model: ILanguageModelChatMetadataAndIdentifier, keepOpen = false): Promise<boolean> {
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
			try {
				await this._sessionTypeDelegate.setActiveSessionProvider(providerId as AgentSessionTarget);
			} catch {
				return false;
			}
		}
		this._modelDelegate.setModel(model);
		this._updateTrigger();
		if (!keepOpen) {
			this._overlay.clear();
		}
		return true;
	}
}
