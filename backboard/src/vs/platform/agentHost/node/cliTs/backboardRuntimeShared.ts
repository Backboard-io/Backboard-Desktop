/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { localize } from '../../../../nls.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { guestApiKey } from './backboardGuest.js';
import { IAgentModelInfo } from '../../common/agentService.js';
import { createAgentModelPricingMeta } from '../../common/agentModelPricing.js';
import { billingRouteForProvider, BYOK_KEY_PROVIDER_SUFFIX, isKeyBilledProvider, type ModelRouteSource, vendorOfProvider } from '../../common/byokProviders.js';
import type { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';

/**
 * Backboard runtime configuration, model-catalog, and session-config helpers
 * shared by the cli-ts agent. Extracted verbatim from the retired Rust-bridge
 * agent (`backboardAgent.ts`) so the cli-ts runtime keeps identical model
 * mapping, session-config schema, and credential resolution
 * (`~/.backboard_ide/config.json` + `BACKBOARD_*` env overrides).
 */


const DEFAULT_PROVIDER = 'openrouter';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export const DEFAULT_MODEL_ID = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

const HIDDEN_MODEL_PROVIDERS = new Set(['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics']);

const SANDBOX_PROVIDER_ORDER = new Map<string, number>([
	['aws-bedrock', 0],
	['anthropic', 1],
	['anthropic-key', 2],
	['anthropic-subscription', 3],
	['openai', 4],
	['openai-key', 5],
	['openai-subscription', 6],
	['google', 7],
	['xai', 8],
	['x-ai', 8],
	['cohere', 9],
	['cerebras', 10],
	['mistral', 11],
	['deepseek', 12],
	['openrouter', 13],
	['lmstudio', 14],
	['lm-studio', 14],
	['ollama', 15],
]);

const BACKBOARD_INTENSITY_CONFIG_KEY = 'intensity';
const BACKBOARD_MEMORY_CONFIG_KEY = 'memory';
const BACKBOARD_WEB_SEARCH_CONFIG_KEY = 'webSearch';
const BACKBOARD_COMPUTER_USE_CONFIG_KEY = 'computerUse';
const BACKBOARD_BROWSER_USE_CONFIG_KEY = 'browserUse';
const BACKBOARD_NOTIFICATIONS_CONFIG_KEY = 'notifications';
const BACKBOARD_IMAGE_GENERATION_CONFIG_KEY = 'imageGeneration';
/** Selected image model as `provider/name`; `off` disables image generation. */
export const BACKBOARD_IMAGE_MODEL_CONFIG_KEY = 'imageModel';
const BACKBOARD_VIDEO_GENERATION_CONFIG_KEY = 'videoGeneration';
/** Selected video model as `provider/name`; `off` disables video generation. */
export const BACKBOARD_VIDEO_MODEL_CONFIG_KEY = 'videoModel';
/**
 * Legacy composer value that used to turn image or video generation off.
 * Media is now always available on Backboard-billed models, so it resolves to
 * the default model instead.
 */
export const BACKBOARD_GENERATIVE_MEDIA_OFF = 'off';
/** Image model used unless the user picks another one: OpenAI's newest image model. */
const DEFAULT_IMAGE_MODEL_SELECTION = 'openrouter/openai/gpt-5.4-image-2';
/** Video model used unless the user picks another one: ByteDance Seedance 2.5. */
const DEFAULT_VIDEO_MODEL_SELECTION = 'openrouter/bytedance/seedance-2.5';
export const BACKBOARD_OPENROUTER_PROVIDER_CONFIG_KEY = 'openRouterProvider';
export const BACKBOARD_MODE_PLAN = 'plan';
export const BACKBOARD_MODE_MULTITASK = 'multitask';

export const BACKBOARD_ACCESS_DEFAULT = 'default';
export const BACKBOARD_ACCESS_MANUAL = 'manual';
export const BACKBOARD_ACCESS_FULL = 'fullAccess';

export interface BackboardRepositoryConfig {
	readonly currentBranch: string;
	readonly defaultBranch: string;
}

const BACKBOARD_MULTITASK_SYSTEM_CONTEXT = `## Multitask coordination

This turn is running in Multitask mode. Use the smallest number of workers that materially shortens the task. Spawn multiple write-capable worker subagents only when the request contains at least two substantial, genuinely independent implementation workstreams; never create several workers for trivial checks, duplicate investigation, cosmetic splitting, or work the main agent can finish directly. For small, coupled, same-file, or single-workstream tasks, work directly. When delegation is justified, use two to four workers, begin every worker prompt with a short action-oriented purpose line that can be shown to the user, and give every worker a complete task with exclusive ownership of an explicitly named, non-overlapping set of files. Emit truly independent Agent tool calls in the same assistant message so the runtime starts them concurrently. Never assign the same file or substantially the same task to multiple workers, and do not parallelize work with ordering dependencies or shared-file edits. After the workers finish, inspect their combined changes, resolve integration issues yourself, and run the relevant verification.`;

export function backboardMultitaskSystemContext(mode: string): string | undefined {
	return mode === BACKBOARD_MODE_MULTITASK ? BACKBOARD_MULTITASK_SYSTEM_CONTEXT : undefined;
}

const BACKBOARD_FULL_ACCESS_SYSTEM_CONTEXT = `## Full Access

The user turned on Full Access for this chat. Every tool call runs without an approval prompt: shell commands (including ones outside the working directory), file reads and edits anywhere on this computer, network requests, browser, computer use, and connector (MCP) tools. Do not ask the user for permission to use a tool, and do not stop to ask whether you may run a command or edit a file — just do the work the request needs. When a tool fails, fix the cause or try another approach instead of handing the step back to the user. Ask the user only when you need information you cannot find yourself, or before an irreversible action the request did not clearly call for (deleting user data, force-pushing, publishing, sending messages, or spending money).`;

/**
 * Tells the model that approvals are off under Full Access. Without it the
 * built-in prompts ("honor permissions", "require explicit authorization")
 * lead models to stop and ask for permission the runtime would grant anyway.
 */
export function backboardAccessSystemContext(accessMode: string): string | undefined {
	return accessMode === BACKBOARD_ACCESS_FULL ? BACKBOARD_FULL_ACCESS_SYSTEM_CONTEXT : undefined;
}

export interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	/** Billing route the runtime resolved for this row: `backboard`, `byok`, or `subscription` (cli-ts `ModelSource`). */
	readonly source?: string;
	readonly modelType?: string;
	readonly model_type?: string;
	readonly displayName?: string;
	readonly display_name?: string;
	readonly description?: string;
	readonly resolved_model?: string;
	readonly supported_effort_levels?: readonly string[];
	readonly supports_adaptive_thinking?: boolean;
	readonly supports_thinking?: boolean | null;
	readonly thinking_controls?: {
		readonly supported?: boolean;
		readonly allowed_fields?: readonly string[];
		readonly defaults_only?: boolean;
	} | null;
	readonly contextLimit?: number;
	readonly context_limit?: number | null;
	readonly supportsVision?: boolean;
	readonly supports_vision?: boolean | null;
	readonly pricing?: string;
	readonly inputPricePerMillion?: number | string;
	readonly outputPricePerMillion?: number | string;
	readonly inputCostPer1mTokens?: number | string;
	readonly outputCostPer1mTokens?: number | string;
	readonly input_cost_per_1m_tokens?: number | string;
	readonly output_cost_per_1m_tokens?: number | string;
	readonly inputPrice?: number | string;
	readonly outputPrice?: number | string;
	readonly input_price?: number | string;
	readonly output_price?: number | string;
	readonly promptPrice?: number | string;
	readonly completionPrice?: number | string;
	readonly promptPricePerMillion?: number | string;
	readonly completionPricePerMillion?: number | string;
	readonly cachePrice?: number | string;
	readonly cache_price?: number | string;
	readonly cacheCost?: number | string;
	readonly cacheCostPer1mTokens?: number | string;
	readonly cachePricePerMillion?: number | string;
	readonly cached_input_cost_per_1m_tokens?: number | string | null;
	readonly cacheWritePrice?: number | string;
	readonly cache_write_price?: number | string;
	readonly cacheWriteCost?: number | string;
	readonly cacheWriteCostPer1mTokens?: number | string;
	readonly cacheWritePricePerMillion?: number | string;
	readonly cache_write_input_cost_per_1m_tokens?: number | string | null;
	readonly openrouter_providers?: readonly BridgeOpenRouterProvider[];
}

export interface BridgeOpenRouterProvider {
	readonly upstream_provider: string;
	readonly input_cost_per_1m_tokens?: number | null;
	readonly output_cost_per_1m_tokens?: number | null;
	readonly context_limit?: number | null;
	readonly supports_tools?: boolean | null;
	readonly uptime_30m?: number | null;
}

/** Local ChatGPT subscription routes are not part of Backboard's API catalog. */
export const BUNDLED_CHATGPT_SUBSCRIPTION_MODELS: readonly BridgeModel[] = [
	{ provider: 'openai-subscription', name: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', modelType: 'llm', supportsVision: true },
	{ provider: 'openai-subscription', name: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modelType: 'llm', supportsVision: true },
	{ provider: 'openai-subscription', name: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', modelType: 'llm', supportsVision: true },
	{ provider: 'openai-subscription', name: 'gpt-5.5', displayName: 'GPT-5.5', modelType: 'llm', supportsVision: true },
	{ provider: 'openai-subscription', name: 'gpt-5.4', displayName: 'GPT-5.4', modelType: 'llm', supportsVision: true },
	{ provider: 'openai-subscription', name: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', modelType: 'llm', supportsVision: true },
];

/** Local Claude Code subscription routes are not part of Backboard's API catalog. */
export const BUNDLED_CLAUDE_SUBSCRIPTION_MODELS: readonly BridgeModel[] = [
	{ provider: 'anthropic-subscription', name: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', resolved_model: 'claude-fable-5-1', modelType: 'llm', contextLimit: 200_000, supportsVision: true, supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ provider: 'anthropic-subscription', name: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', resolved_model: 'claude-opus-5-5', modelType: 'llm', contextLimit: 200_000, supportsVision: true, supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ provider: 'anthropic-subscription', name: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', resolved_model: 'claude-sonnet-5-5', modelType: 'llm', contextLimit: 200_000, supportsVision: true, supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ provider: 'anthropic-subscription', name: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', resolved_model: 'claude-haiku-4-5-20251001', modelType: 'llm', contextLimit: 200_000, supportsVision: true, supported_effort_levels: [] },
];

interface BackboardConfigJson {
	readonly env?: unknown;
	/** Signed-out device's guest key (see backboardGuest.ts). */
	readonly guest?: unknown;
	readonly api_url?: unknown;
	readonly apiUrl?: unknown;
	readonly api_key?: unknown;
	readonly apiKey?: unknown;
	readonly env_keys?: unknown;
	readonly oauth?: unknown;
}

export interface BackboardTurnSettings {
	/** The runtime vendor id; a key-billed selection's `-key` suffix is already stripped. */
	readonly provider: string;
	readonly model: string;
	/** Explicit billing route derived from the selected model id. */
	readonly source: ModelRouteSource;
	/** Effective approval mode: plan collapses to manual for gating purposes. */
	readonly accessMode: string;
	/** The stored mode value, including `plan` (used for tool exclusion). */
	readonly rawMode: string;
	readonly intensity: string;
	readonly memory: string;
	/** Whether the built-in web-search tool is available this turn. */
	readonly webSearch: boolean;
	/** Whether computer-use tools are enabled this turn. */
	readonly computerUse: boolean;
	/** Whether the browser-use tool is enabled this turn. */
	readonly browserUse: boolean;
	/** Whether turn-completion notifications are enabled this turn. */
	readonly notifications: boolean;
	/** Whether Backboard's built-in image generation is enabled this turn. */
	readonly imageGeneration: boolean;
	/** Selected image model; undefined uses the harness default. */
	readonly imageModel?: { provider: string; name: string };
	/** Whether Backboard's built-in video generation is enabled this turn. */
	readonly videoGeneration: boolean;
	/** Selected video model; video generation needs an explicit model. */
	readonly videoModel?: { provider: string; name: string };
	/** A user-pinned OpenRouter serving provider; undefined keeps automatic routing. */
	readonly openRouterProvider?: string;
	readonly config: Record<string, unknown>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isFileNotFoundError(error: unknown): boolean {
	return isObjectRecord(error) && error.code === 'ENOENT';
}

function normalizeProviderKey(provider: string | undefined): string {
	const value = provider?.trim().toLowerCase().replace(/[\s_]+/g, '-') ?? '';
	if (isKeyBilledProvider(value)) {
		// Normalize the vendor, keep the billing suffix: `open_ai-key` → `openai-key`.
		return `${normalizeProviderKey(vendorOfProvider(value))}${BYOK_KEY_PROVIDER_SUFFIX}`;
	}
	if (value.includes('openrouter') || value.includes('open-router')) {
		return 'openrouter';
	}
	if (value.includes('bedrock') || value.includes('amazon') || value === 'aws') {
		return 'aws-bedrock';
	}
	if (value === 'google-ai' || value === 'googleai') {
		return 'google-ai';
	}
	if (value === 'open-ai') {
		return 'openai';
	}
	if (value === 'open-ai-compatible' || value === 'openai-compat') {
		return 'openai-compatible';
	}
	if (value === 'xai') {
		return 'xai';
	}
	if (value === 'x-ai' || value === 'x.ai') {
		return 'xai';
	}
	if (value === 'lmstudio') {
		return 'lm-studio';
	}
	return value;
}

function providerLabel(provider: string | undefined): string {
	const normalized = normalizeProviderKey(provider);
	if (isKeyBilledProvider(normalized)) {
		return localize('backboard.provider.keyBilled', "{0} API Key", providerLabel(vendorOfProvider(normalized)));
	}
	switch (normalized) {
		case 'aws-bedrock':
			return 'AWS Bedrock';
		case 'anthropic':
			return 'Anthropic';
		case 'anthropic-subscription':
			return 'Claude Subscription';
		case 'cerebras':
			return 'Cerebras';
		case 'cohere':
			return 'Cohere';
		case 'deepseek':
			return 'DeepSeek';
		case 'google':
		case 'google-ai':
			return 'Google';
		case 'lm-studio':
			return 'LM Studio';
		case 'mistral':
			return 'Mistral';
		case 'ollama':
			return 'Ollama';
		case 'openai':
			return 'OpenAI';
		case 'openai-subscription':
			return 'OpenAI (ChatGPT Subscription)';
		case 'openai-compatible':
			return 'OpenAI Compatible';
		case 'openrouter':
			return 'OpenRouter';
		case 'xai':
			return 'xAI';
		default:
			return provider?.trim() || 'Backboard';
	}
}

function normalizeBackboardEnv(env: unknown): string {
	switch ((typeof env === 'string' ? env : 'prod').trim().toLowerCase()) {
		case '':
			return 'prod';
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (typeof env === 'string' ? env : 'prod').trim().toLowerCase();
	}
}

function parseModelSelection(model: ModelSelection | undefined): { provider: string; model: string } | undefined {
	const id = model?.id;
	if (!id) {
		return undefined;
	}
	const slash = id.indexOf('/');
	if (slash > 0 && slash < id.length - 1) {
		return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
	}
	return { provider: DEFAULT_PROVIDER, model: id };
}

const BRIDGE_MODEL_BILLING_SOURCES = ['backboard', 'byok', 'subscription'] as const;
type BridgeModelBillingSource = typeof BRIDGE_MODEL_BILLING_SOURCES[number];

/** The runtime's per-model billing route, when it reports a known one. */
function bridgeModelBillingSource(source: string | undefined): BridgeModelBillingSource | undefined {
	const normalized = source?.trim().toLowerCase();
	return BRIDGE_MODEL_BILLING_SOURCES.find(candidate => candidate === normalized);
}

/** Providers whose per-request cost is reported upstream, so a $0 catalog row can be trusted. */
const REPORTED_COST_PROVIDERS = new Set(['openrouter', 'cerebras']);
/** Router aliases pick an upstream per request, so no row can promise their price. */
const ROUTER_MODEL_NAMES = new Set(['openrouter/auto', 'openrouter/auto-beta', 'openrouter/free']);

/**
 * True when Backboard runs this model with no credit or plan. Same rule as the
 * server's `is_free_llm_model` and cli-ts `isFreeCatalogModel`: an
 * OpenRouter-family row, not a router alias, whose every price is exactly 0.
 */
export function isFreeBackboardModel(model: BridgeModel): boolean {
	if (!REPORTED_COST_PROVIDERS.has(model.provider.trim().toLowerCase()) || ROUTER_MODEL_NAMES.has(model.name.trim().toLowerCase())) {
		return false;
	}
	if (!isZeroPrice(model.input_cost_per_1m_tokens) || !isZeroPrice(model.output_cost_per_1m_tokens)) {
		return false;
	}
	return Object.entries(model).every(([key, value]) => !/(?:^|_)(?:cost|price)(?:_|$)/.test(key) || value === null || isZeroPrice(value));
}

function isZeroPrice(value: unknown): boolean {
	return value === 0 || (typeof value === 'string' && value.trim() !== '' && Number(value) === 0);
}

function toAgentModelInfo(model: BridgeModel): IAgentModelInfo {
	const id = `${model.provider}/${model.name}`;
	const billingSource = bridgeModelBillingSource(model.source);
	const pricePair = modelPricePair(model);
	const inputCost = pricePair?.[0];
	const outputCost = pricePair?.[1];
	const cacheCost = numericBridgeModelValue(model, ['cachePricePerMillion', 'cacheCostPer1mTokens', 'cachePrice', 'cache_price', 'cacheCost', 'cached_input_cost_per_1m_tokens']);
	const cacheWriteCost = numericBridgeModelValue(model, ['cacheWritePricePerMillion', 'cacheWriteCostPer1mTokens', 'cacheWritePrice', 'cache_write_price', 'cacheWriteCost', 'cache_write_input_cost_per_1m_tokens']);
	const pricingMeta = createAgentModelPricingMeta({
		inputCost,
		cacheCost,
		cacheWriteCost,
		outputCost,
		priceCategory: billingSource !== 'byok' && isFreeBackboardModel(model) ? 'free' : undefined,
	});
	const contextLimit = model.contextLimit ?? model.context_limit;
	const openRouterProviders = normalizeOpenRouterProviders(model.openrouter_providers);
	const configSchema = openRouterProviders.length
		? openRouterProviderConfigSchema(openRouterProviders)
		: effortConfigSchema(model);
	return {
		provider: 'backboard',
		id,
		name: model.display_name || model.displayName || model.name,
		maxContextWindow: typeof contextLimit === 'number' ? contextLimit : undefined,
		supportsVision: model.supportsVision ?? model.supports_vision ?? inferBackboardModelSupportsVision(model),
		...(configSchema ? { configSchema } : {}),
		_meta: {
			upstreamProvider: normalizeProviderKey(model.provider),
			upstreamProviderLabel: providerLabel(model.provider),
			...(billingSource ? { billingSource } : {}),
			pricing: modelPriceLabel(model),
			...(model.description ? { modelDescription: model.description } : {}),
			...(model.resolved_model ? { resolvedModel: model.resolved_model } : {}),
			...(model.supported_effort_levels ? { supportedEffortLevels: [...model.supported_effort_levels] } : {}),
			...(model.supports_adaptive_thinking !== undefined ? { supportsAdaptiveThinking: model.supports_adaptive_thinking } : {}),
			...(openRouterProviders.length ? {
				openRouterProviders: openRouterProviders.map(provider => provider.upstream_provider),
				openRouterProviderCount: openRouterProviders.length,
			} : {}),
			...(pricingMeta ?? {}),
		},
	};
}

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

/**
 * A per-model reasoning schema for providers that publish the levels they
 * honour: the Claude subscription route, and key-billed vendors. A key-billed
 * model that publishes an empty list gets a single "Off" choice, because its
 * adapter forces reasoning off for tool requests and the generic slider would
 * promise a control the request ignores. Models that publish nothing keep the
 * generic session slider.
 */
function effortConfigSchema(model: BridgeModel): IAgentModelInfo['configSchema'] | undefined {
	const provider = normalizeProviderKey(model.provider);
	const keyBilled = isKeyBilledProvider(provider);
	if (provider !== 'anthropic-subscription' && !keyBilled) {
		return undefined;
	}
	if (model.supported_effort_levels === undefined) {
		return undefined;
	}
	let levels = model.supported_effort_levels
		.filter((level): level is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(level));
	if (levels.length === 0) {
		if (!keyBilled) {
			return undefined;
		}
		levels = ['off'];
	}
	const labels: Record<EffortLevel, string> = {
		off: localize('backboard.claude.effort.off', "Off"),
		low: localize('backboard.claude.effort.low', "Low"),
		medium: localize('backboard.claude.effort.medium', "Medium"),
		high: localize('backboard.claude.effort.high', "High"),
		xhigh: localize('backboard.claude.effort.xhigh', "X-High"),
		max: localize('backboard.claude.effort.max', "Max"),
	};
	const descriptions: Record<EffortLevel, string> = {
		off: localize('backboard.claude.effort.off.description', "This model does not support reasoning controls for tool-using requests."),
		low: localize('backboard.claude.effort.low.description', "Fastest response for short, scoped work."),
		medium: localize('backboard.claude.effort.medium.description', "Lower token use for routine work."),
		high: localize('backboard.claude.effort.high.description', "Balanced capability and token use; Claude's default."),
		xhigh: localize('backboard.claude.effort.xhigh.description', "Deeper reasoning for difficult coding and agentic work."),
		max: localize('backboard.claude.effort.max.description', "Maximum reasoning depth for the most demanding tasks."),
	};
	const preferred: EffortLevel = keyBilled ? 'medium' : 'high';
	return {
		type: 'object',
		properties: {
			[BACKBOARD_INTENSITY_CONFIG_KEY]: {
				type: 'string',
				title: localize('backboard.claude.effort.title', "Reasoning effort"),
				description: keyBilled
					? localize('backboard.keyBilled.effort.description', "Reasoning levels this model accepts through your own API key.")
					: localize('backboard.claude.effort.description', "Controls Claude's adaptive reasoning effort for this model."),
				default: levels.includes(preferred) ? preferred : levels[0],
				enum: levels,
				enumLabels: levels.map(level => labels[level]),
				enumDescriptions: levels.map(level => descriptions[level]),
			},
		},
	};
}

function normalizeOpenRouterProviders(providers: readonly BridgeOpenRouterProvider[] | undefined): BridgeOpenRouterProvider[] {
	const byName = new Map<string, BridgeOpenRouterProvider>();
	for (const provider of providers ?? []) {
		const name = provider.upstream_provider?.trim();
		if (name && !byName.has(name.toLowerCase())) {
			byName.set(name.toLowerCase(), { ...provider, upstream_provider: name });
		}
	}
	return [...byName.values()].sort((a, b) => a.upstream_provider.localeCompare(b.upstream_provider));
}

function openRouterProviderConfigSchema(providers: readonly BridgeOpenRouterProvider[]): NonNullable<IAgentModelInfo['configSchema']> {
	const providerDescription = (provider: BridgeOpenRouterProvider): string => {
		const details: string[] = [];
		if (typeof provider.input_cost_per_1m_tokens === 'number' && typeof provider.output_cost_per_1m_tokens === 'number') {
			details.push(`${formatModelPrice(provider.input_cost_per_1m_tokens)} in, ${formatModelPrice(provider.output_cost_per_1m_tokens)} out`);
		}
		if (typeof provider.uptime_30m === 'number') {
			details.push(localize('backboard.openRouterProvider.uptime', "{0}% uptime (30m)", provider.uptime_30m.toFixed(2)));
		}
		return details.join(' · ');
	};
	return {
		type: 'object',
		properties: {
			[BACKBOARD_OPENROUTER_PROVIDER_CONFIG_KEY]: {
				type: 'string',
				title: localize('backboard.openRouterProvider.title', "OpenRouter provider"),
				description: localize('backboard.openRouterProvider.description', "Choose the upstream that serves this model, or let OpenRouter route automatically."),
				default: 'auto',
				enum: ['auto', ...providers.map(provider => provider.upstream_provider)],
				enumLabels: [localize('backboard.openRouterProvider.auto', "Auto"), ...providers.map(provider => provider.upstream_provider)],
				enumDescriptions: [
					localize('backboard.openRouterProvider.auto.description', "Let OpenRouter choose the serving provider."),
					...providers.map(providerDescription),
				],
			},
		},
	};
}

function inferBackboardModelSupportsVision(model: BridgeModel): boolean {
	const provider = normalizeProviderKey(model.provider);
	// Locally-authenticated subscription routes serve Claude/GPT families that
	// accept image input, but their live catalog entries do not always declare
	// the capability (and their names are aliases like `default`/`haiku` that no
	// family pattern matches). Treat the route as vision-capable so pasted
	// images are not flagged as unsupported.
	if (provider === 'anthropic-subscription' || provider === 'openai-subscription') {
		return true;
	}
	const id = [provider, model.name, model.displayName, model.display_name, model.resolved_model]
		.filter((part): part is string => typeof part === 'string' && part.length > 0)
		.join(' ')
		.toLowerCase();
	return id.includes('gpt-4o')
		|| id.includes('gpt-5')
		|| id.includes('claude')
		|| id.includes('gemini')
		|| id.includes('grok-4')
		|| id.includes('mistral-medium-3')
		|| id.includes('pixtral');
}

function numericBridgeModelValue(model: BridgeModel, keys: readonly (keyof BridgeModel)[]): number | undefined {
	for (const key of keys) {
		const value = model[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function formatModelPrice(value: number): string {
	return `$${value.toFixed(2)}/M`;
}

function modelPricePair(model: BridgeModel): readonly [number, number] | undefined {
	const explicitInput = numericBridgeModelValue(model, ['inputPricePerMillion', 'inputCostPer1mTokens', 'input_cost_per_1m_tokens', 'inputPrice', 'input_price', 'promptPrice', 'promptPricePerMillion']);
	const explicitOutput = numericBridgeModelValue(model, ['outputPricePerMillion', 'outputCostPer1mTokens', 'output_cost_per_1m_tokens', 'outputPrice', 'output_price', 'completionPrice', 'completionPricePerMillion']);
	if (explicitInput !== undefined && explicitOutput !== undefined) {
		return [explicitInput, explicitOutput];
	}
	const id = [model.provider, model.name, model.displayName].filter(Boolean).join(' ').toLowerCase().replace(/[._]/g, '-');
	if (id.includes('claude-haiku-4-5') || id.includes('claude-haiku-4.5')) {
		return [1, 5];
	}
	if (id.includes('claude-sonnet-4')) {
		return [3, 15];
	}
	if (id.includes('claude-opus-4-5') || id.includes('claude-opus-4.5') || id.includes('claude-opus-4-6') || id.includes('claude-opus-4-7') || id.includes('claude-opus-4-8')) {
		return [5, 25];
	}
	if (id.includes('claude-opus-4')) {
		return [15, 75];
	}
	return undefined;
}

function modelPriceLabel(model: BridgeModel): string | undefined {
	if (typeof model.pricing === 'string' && model.pricing.trim() !== '') {
		return model.pricing;
	}
	const pair = modelPricePair(model);
	return pair ? `${formatModelPrice(pair[0])} in, ${formatModelPrice(pair[1])} out` : undefined;
}

export function fallbackModel(): IAgentModelInfo {
	return {
		provider: 'backboard',
		id: DEFAULT_MODEL_ID,
		name: 'DeepSeek V4 Flash',
		supportsVision: false,
	};
}

function isVisibleBridgeModel(model: BridgeModel): boolean {
	const provider = normalizeProviderKey(model.provider);
	const modelType = model.modelType ?? model.model_type;
	return !!provider
		&& !!model.name?.trim()
		&& !HIDDEN_MODEL_PROVIDERS.has(provider)
		&& (!modelType || modelType.trim().toLowerCase() === 'llm');
}

export function isBridgeModel(value: unknown): value is BridgeModel {
	return isObjectRecord(value)
		&& typeof value.provider === 'string'
		&& value.provider.trim().length > 0
		&& typeof value.name === 'string'
		&& value.name.trim().length > 0;
}

function mergeBridgeModels(...modelSets: readonly (readonly BridgeModel[])[]): BridgeModel[] {
	const byId = new Map<string, BridgeModel>();
	for (const models of modelSets) {
		const existingSubscriptionProviders = new Set(
			[...byId.values()]
				.map(model => normalizeProviderKey(model.provider))
				.filter(provider => provider.endsWith('-subscription')),
		);
		for (const model of models) {
			const provider = normalizeProviderKey(model.provider);
			const key = `${provider}/${model.name}`;
			// Subscription catalogs are account-specific. Once a live set has
			// supplied a provider, later bundled sets are fallback-only and must not
			// add aliases that the user's plan did not advertise.
			if (existingSubscriptionProviders.has(provider) && !byId.has(key)) {
				continue;
			}
			if (!byId.has(key)) {
				byId.set(key, model);
			}
		}
	}
	return [...byId.values()];
}

export function backboardModelInfos(...modelSets: readonly (readonly BridgeModel[])[]): IAgentModelInfo[] {
	const mergedModels = mergeBridgeModels(...modelSets);
	return mergedModels
		.filter(isVisibleBridgeModel)
		.concat(supplementalBridgeModels(mergedModels))
		.sort(compareBridgeModels)
		.map(toAgentModelInfo);
}

function compareBridgeModels(a: BridgeModel, b: BridgeModel): number {
	const aId = `${normalizeProviderKey(a.provider)}/${a.name}`;
	const bId = `${normalizeProviderKey(b.provider)}/${b.name}`;
	if (aId === DEFAULT_MODEL_ID) {
		return -1;
	}
	if (bId === DEFAULT_MODEL_ID) {
		return 1;
	}
	const providerDelta = (SANDBOX_PROVIDER_ORDER.get(normalizeProviderKey(a.provider)) ?? 99)
		- (SANDBOX_PROVIDER_ORDER.get(normalizeProviderKey(b.provider)) ?? 99);
	if (providerDelta !== 0) {
		return providerDelta;
	}
	return a.name.localeCompare(b.name);
}

function supplementalBridgeModels(models: readonly BridgeModel[]): BridgeModel[] {
	if (models.some(model => normalizeProviderKey(model.provider) === 'openrouter')) {
		return [];
	}
	return [{ provider: 'openrouter', name: 'openai/gpt-5-chat', displayName: 'GPT-5 Chat', modelType: 'llm' }];
}

export function resolveBackboardSessionConfig(rawConfig: Record<string, unknown> | undefined, repository?: BackboardRepositoryConfig): ResolveSessionConfigResult {
	const isolation = repository
		? oneOf(rawConfig?.[SessionConfigKey.Isolation], ['folder', 'worktree'], 'folder')
		: 'folder';
	const branch = repository
		? isolation === 'worktree'
			? stringValueFromRecord(rawConfig?.[SessionConfigKey.Branch]) ?? repository.defaultBranch
			: repository.currentBranch
		: undefined;
	const values = {
		...normalizeBackboardConfig(rawConfig),
		[SessionConfigKey.Isolation]: isolation,
		...(branch ? { [SessionConfigKey.Branch]: branch } : {}),
	};
	return {
			schema: {
				type: 'object',
				properties: {
					[SessionConfigKey.Isolation]: {
						type: 'string',
						title: localize('backboard.config.isolation.title', "Isolation"),
						description: localize('backboard.config.isolation.description', "Where Backboard should make changes."),
						default: 'folder',
						enum: repository ? ['folder', 'worktree'] : ['folder'],
						enumLabels: repository
							? [localize('backboard.config.isolation.folder', "Folder"), localize('backboard.config.isolation.worktree', "Worktree")]
							: [localize('backboard.config.isolation.folder', "Folder")],
						enumDescriptions: repository
							? [
								localize('backboard.config.isolation.folder.description', "Work directly in the selected folder."),
								localize('backboard.config.isolation.worktree.description', "Create an isolated Git worktree so agents can run safely in parallel."),
							]
							: [localize('backboard.config.isolation.folder.description', "Work directly in the selected folder.")],
						readOnly: !repository,
						sessionMutable: false,
					},
					...(repository && branch ? {
						[SessionConfigKey.Branch]: {
							type: 'string',
							title: localize('backboard.config.branch.title', "Base Branch"),
							description: localize('backboard.config.branch.description', "Branch used as the starting point for an isolated worktree."),
							default: branch,
							enum: [branch],
							enumLabels: [branch],
							enumDynamic: isolation === 'worktree',
							readOnly: isolation !== 'worktree',
							sessionMutable: false,
						},
					} : {}),
					[SessionConfigKey.Mode]: {
						type: 'string',
						title: localize('backboard.config.mode.title', "Mode"),
						description: localize('backboard.config.mode.description', "Controls how Backboard plans, delegates work, and approves tool use."),
						default: BACKBOARD_ACCESS_FULL,
						enum: [BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_MULTITASK, BACKBOARD_MODE_PLAN, BACKBOARD_ACCESS_MANUAL, BACKBOARD_ACCESS_FULL],
						enumLabels: [
							localize('backboard.config.mode.default', "Default"),
							localize('backboard.config.mode.multitask', "Multitask"),
							localize('backboard.config.mode.plan', "Plan"),
							localize('backboard.config.mode.manual', "Manual"),
							localize('backboard.config.mode.free', "Full Access"),
						],
						enumDescriptions: [
							localize('backboard.config.mode.default.description', "File edits and safe commands run without asking; risky commands and external capabilities (computer, browser, connector writes) still ask."),
							localize('backboard.config.mode.multitask.description', "Coordinate independent worker agents concurrently with exclusive file ownership, then integrate and verify their changes."),
							localize('backboard.config.mode.plan.description', "Read-only planning: file edits and shell commands are hidden from the agent, and remaining tool calls ask for approval."),
							localize('backboard.config.mode.manual.description', "Ask before each tool call."),
							localize('backboard.config.mode.free.description', "Run everything without asking, including external capabilities."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_INTENSITY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.intensity.title', "Reasoning"),
						description: localize('backboard.config.intensity.description', "Controls Backboard's per-turn thinking configuration."),
						default: 'medium',
						enum: ['off', 'low', 'medium', 'high', 'max'],
						enumLabels: [
							localize('backboard.config.intensity.off', "Off"),
							localize('backboard.config.intensity.low', "Low"),
							localize('backboard.config.intensity.medium', "Medium"),
							localize('backboard.config.intensity.high', "High"),
							localize('backboard.config.intensity.max', "Max"),
						],
						enumDescriptions: [
							localize('backboard.config.intensity.off.description', "Disable Backboard thinking for this turn."),
							localize('backboard.config.intensity.low.description', "Use low reasoning effort or a small reasoning-token budget."),
							localize('backboard.config.intensity.medium.description', "Use medium reasoning effort or a balanced reasoning-token budget."),
							localize('backboard.config.intensity.high.description', "Use high reasoning effort or a large reasoning-token budget."),
							localize('backboard.config.intensity.max.description', "Use the provider's maximum reasoning level. This can add substantial latency, especially while generating large tool inputs."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_MEMORY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.memory.title', "Memory"),
						description: localize('backboard.config.memory.description', "Controls Backboard's semantic memory for this session."),
						default: 'off',
						enum: ['off', 'auto', 'readonly'],
						enumLabels: [
							localize('backboard.config.memory.off', "Off"),
							localize('backboard.config.memory.auto', "Auto"),
							localize('backboard.config.memory.readonly', "Read-only"),
						],
						enumDescriptions: [
							localize('backboard.config.memory.off.description', "Nothing is stored or recalled."),
							localize('backboard.config.memory.auto.description', "Backboard stores and recalls memories as needed."),
							localize('backboard.config.memory.readonly.description', "Recall existing memories without storing new ones."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_COMPUTER_USE_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.computerUse.title', "Computer Use"),
						description: localize('backboard.config.computerUse.description', "Lets Backboard operate desktop apps. A fast vision model watches each app window, acts on it in the background, and shows an on-screen agent cursor; screenshots, mouse, and keyboard are the fallback."),
						// On by default: an "operate my screen" request in a chat that
						// happened to start with it off was simply refused by the model.
						default: true,
						sessionMutable: true,
					},
					[BACKBOARD_BROWSER_USE_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.browserUse.title', "Browser Use"),
						description: localize('backboard.config.browserUse.description', "Lets Backboard drive a web browser to navigate pages and interact with sites."),
						default: false,
						sessionMutable: true,
					},
					[BACKBOARD_NOTIFICATIONS_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.notifications.title', "Notifications"),
						description: localize('backboard.config.notifications.description', "Shows a system notification when Backboard finishes a turn."),
						default: false,
						sessionMutable: true,
					},
					[BACKBOARD_IMAGE_MODEL_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.imageModel.title', "Image"),
						description: localize('backboard.config.imageModel.description', "Generate images with the selected Backboard image model."),
						default: DEFAULT_IMAGE_MODEL_SELECTION,
						enum: [DEFAULT_IMAGE_MODEL_SELECTION],
						enumLabels: ['GPT-5.4 Image 2'],
						enumDescriptions: [localize('backboard.config.imageModel.default.description', "OpenAI's GPT-5.4 Image 2.")],
						// The live catalog is too large to enumerate; the enum above is the seed.
						enumDynamic: true,
						sessionMutable: true,
					},
					[BACKBOARD_VIDEO_MODEL_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.videoModel.title', "Video"),
						description: localize('backboard.config.videoModel.description', "Generate videos with the selected Backboard video model."),
						default: DEFAULT_VIDEO_MODEL_SELECTION,
						// Live completions supply every other selectable model.
						enum: [DEFAULT_VIDEO_MODEL_SELECTION],
						enumLabels: ['Seedance 2.5'],
						enumDescriptions: [localize('backboard.config.videoModel.default.description', "ByteDance's Seedance 2.5.")],
						enumDynamic: true,
						sessionMutable: true,
					},
				},
			},
		values,
	};
}

function normalizeBackboardConfig(rawConfig: Record<string, unknown> | undefined, fallback?: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...(fallback ?? {}), ...(rawConfig ?? {}) };
	return {
		[SessionConfigKey.Mode]: normalizeBackboardMode(merged[SessionConfigKey.Mode]),
		[BACKBOARD_INTENSITY_CONFIG_KEY]: normalizeBackboardIntensity(merged[BACKBOARD_INTENSITY_CONFIG_KEY]),
		// Stored configs may predate the removal of the "on" option; it always
		// behaved as Auto on the wire, so migrate instead of resetting to off.
		[BACKBOARD_MEMORY_CONFIG_KEY]: oneOf(merged[BACKBOARD_MEMORY_CONFIG_KEY] === 'on' ? 'auto' : merged[BACKBOARD_MEMORY_CONFIG_KEY], ['off', 'auto', 'readonly'], 'off'),
		// Web search is an automatic model capability, not a composer setting.
		// Keep it enabled even for sessions that persisted the retired toggle as off.
		[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: true,
		[BACKBOARD_COMPUTER_USE_CONFIG_KEY]: booleanOf(merged[BACKBOARD_COMPUTER_USE_CONFIG_KEY], true),
		[BACKBOARD_BROWSER_USE_CONFIG_KEY]: booleanOf(merged[BACKBOARD_BROWSER_USE_CONFIG_KEY], false),
		[BACKBOARD_NOTIFICATIONS_CONFIG_KEY]: booleanOf(merged[BACKBOARD_NOTIFICATIONS_CONFIG_KEY], false),
		[BACKBOARD_IMAGE_MODEL_CONFIG_KEY]: normalizeImageModelSelection(merged[BACKBOARD_IMAGE_MODEL_CONFIG_KEY], merged[BACKBOARD_IMAGE_GENERATION_CONFIG_KEY]),
		[BACKBOARD_VIDEO_MODEL_CONFIG_KEY]: normalizeVideoModelSelection(merged[BACKBOARD_VIDEO_MODEL_CONFIG_KEY], merged[BACKBOARD_VIDEO_GENERATION_CONFIG_KEY]),
	};
}

export function createBackboardTurnSettings(
	storedConfig: Record<string, unknown> | undefined,
	sessionConfig: Record<string, unknown> | undefined,
	model: ModelSelection | undefined,
): BackboardTurnSettings {
	const values = normalizeBackboardConfig(storedConfig, sessionConfig);
	const selected = parseModelSelection(model) ?? parseModelSelection({ id: DEFAULT_MODEL_ID })!;
	// The runtime never sees the IDE-side `-key` suffix; it gets the vendor plus
	// an explicit billing source instead.
	const parsedModel = billingRouteForProvider(selected.provider, selected.model);
	const rawMode = stringConfigValue(values, SessionConfigKey.Mode, BACKBOARD_ACCESS_FULL);
	// Backboard's hosted media only runs on Backboard-billed turns. The composer
	// hides the pickers for key and subscription models, but a selection made
	// on a Backboard model stays in the session config and must not follow it.
	const backboardMedia = parsedModel.source === 'backboard';
	const imageModel = backboardMedia ? parseGenerativeModelSelection(stringConfigValue(values, BACKBOARD_IMAGE_MODEL_CONFIG_KEY, DEFAULT_IMAGE_MODEL_SELECTION)) : undefined;
	const videoModel = backboardMedia ? parseGenerativeModelSelection(stringConfigValue(values, BACKBOARD_VIDEO_MODEL_CONFIG_KEY, DEFAULT_VIDEO_MODEL_SELECTION)) : undefined;
	const configuredOpenRouterProvider = stringValueFromRecord(model?.config?.[BACKBOARD_OPENROUTER_PROVIDER_CONFIG_KEY]);
	const configuredModelIntensity = stringValueFromRecord(model?.config?.[BACKBOARD_INTENSITY_CONFIG_KEY]);
	const intensity = configuredModelIntensity
		? normalizeBackboardIntensity(configuredModelIntensity)
		: parsedModel.provider === 'anthropic-subscription'
			? /(?:^|[-_/])haiku(?:$|[-_/\[])/i.test(parsedModel.model)
				? 'default'
				: 'high'
			: stringConfigValue(values, BACKBOARD_INTENSITY_CONFIG_KEY, 'medium');
	return {
		provider: parsedModel.provider,
		model: parsedModel.model,
		source: parsedModel.source,
		accessMode: rawMode === BACKBOARD_MODE_PLAN
			? BACKBOARD_ACCESS_MANUAL
			: rawMode === BACKBOARD_MODE_MULTITASK
				? BACKBOARD_ACCESS_DEFAULT
				: rawMode,
		rawMode,
		intensity,
		memory: stringConfigValue(values, BACKBOARD_MEMORY_CONFIG_KEY, 'off'),
		webSearch: true,
		computerUse: booleanConfigValue(values, BACKBOARD_COMPUTER_USE_CONFIG_KEY, true),
		browserUse: booleanConfigValue(values, BACKBOARD_BROWSER_USE_CONFIG_KEY, false),
		notifications: booleanConfigValue(values, BACKBOARD_NOTIFICATIONS_CONFIG_KEY, false),
		// The wire booleans are derived from the selected models so the composer
		// has a single source of truth (the model picker).
		imageGeneration: imageModel !== undefined,
		videoGeneration: videoModel !== undefined,
		...(imageModel ? { imageModel } : {}),
		...(videoModel ? { videoModel } : {}),
		...(parsedModel.provider === 'openrouter' && configuredOpenRouterProvider && configuredOpenRouterProvider !== 'auto'
			? { openRouterProvider: configuredOpenRouterProvider }
			: {}),
		config: bridgeConfig(),
	};
}

// Image and video generation are always available on Backboard-billed models:
// a missing selection, the retired "off" value, or a retired boolean toggle all
// resolve to the default model, so nothing has to be switched on first.
function normalizeImageModelSelection(value: unknown, _legacyEnabled: unknown): string {
	const selected = stringValueFromRecord(value);
	return selected && selected.toLowerCase() !== BACKBOARD_GENERATIVE_MEDIA_OFF ? selected : DEFAULT_IMAGE_MODEL_SELECTION;
}

function normalizeVideoModelSelection(value: unknown, _legacyEnabled: unknown): string {
	const selected = stringValueFromRecord(value);
	return selected && selected.toLowerCase() !== BACKBOARD_GENERATIVE_MEDIA_OFF ? selected : DEFAULT_VIDEO_MODEL_SELECTION;
}

/** Splits a `provider/name` selection; provider names never contain a slash. */
function parseGenerativeModelSelection(value: string | undefined): { provider: string; name: string } | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.toLowerCase() === BACKBOARD_GENERATIVE_MEDIA_OFF) {
		return undefined;
	}
	const separator = trimmed.indexOf('/');
	if (separator <= 0 || separator === trimmed.length - 1) {
		return undefined;
	}
	return { provider: trimmed.slice(0, separator), name: trimmed.slice(separator + 1) };
}

function normalizeBackboardIntensity(value: unknown): string {
	// Adaptive and provider-default were retired from the composer. Migrate
	// persisted sessions to the explicit balanced level instead of leaving an
	// invisible selection behind in the reasoning slider.
	switch (value) {
		case 'auto':
		case 'adaptive':
		case 'dynamic':
		case 'default':
		case 'balanced': return 'medium';
		case 'fast': return 'low';
		case 'deep': return 'high';
		default: return oneOf(value, ['off', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium');
	}
}

function normalizeBackboardMode(value: unknown): string {
	if (value === 'interactive' || value === 'agent') {
		return BACKBOARD_ACCESS_DEFAULT;
	}
	if (value === 'ask') {
		return BACKBOARD_ACCESS_MANUAL;
	}
	if (value === 'free') {
		return BACKBOARD_ACCESS_FULL;
	}
	return oneOf(value, [BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_MULTITASK, BACKBOARD_MODE_PLAN, BACKBOARD_ACCESS_MANUAL, BACKBOARD_ACCESS_FULL], BACKBOARD_ACCESS_FULL);
}


function oneOf(value: unknown, values: readonly string[], fallback: string): string {
	return typeof value === 'string' && values.includes(value) ? value : fallback;
}

/** Coerces a stored config value (boolean or `'true'`/`'false'` string) to a boolean. */
function booleanOf(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	return fallback;
}

function stringConfigValue(config: Record<string, unknown>, key: string, fallback: string): string {
	const value = config[key];
	return typeof value === 'string' && value ? value : fallback;
}

function booleanConfigValue(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
	return booleanOf(config[key], fallback);
}

export function bridgeConfig(): Record<string, unknown> {
	const persisted = readBackboardConfigJsonSync();
	const env = normalizeBackboardEnv(
		process.env.BACKBOARD_ENV
		|| process.env.VSCODE_BACKBOARD_ENV
		|| stringValueFromRecord(persisted.env)
		|| 'prod'
	);
	const apiUrl = process.env.BACKBOARD_API_URL
		|| process.env.VSCODE_BACKBOARD_API_URL
		|| stringValueFromRecord(persisted.api_url)
		|| stringValueFromRecord(persisted.apiUrl);
	const apiKey = process.env.BACKBOARD_API_KEY
		|| process.env.VSCODE_BACKBOARD_API_KEY
		|| backboardConfigApiKey(persisted, env);
	const accessToken = process.env.BACKBOARD_ACCESS_TOKEN
		|| process.env.VSCODE_BACKBOARD_ACCESS_TOKEN
		|| backboardConfigAccessToken(persisted);
	// Signed out: the device's guest key runs Backboard's free models only.
	const guestKey = !apiKey && !accessToken ? guestApiKey(persisted) : undefined;
	return {
		env,
		...(apiUrl ? { apiUrl } : {}),
		...(apiKey || guestKey ? { apiKey: apiKey || guestKey } : {}),
		...(accessToken ? { accessToken } : {}),
		...(guestKey ? { guest: true } : {}),
	};
}

function backboardConfigPath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'config.json');
}

function readBackboardConfigJsonSync(): BackboardConfigJson {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(backboardConfigPath(), 'utf8'));
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isFileNotFoundError(error) || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

function backboardConfigEnvKeys(config: BackboardConfigJson): Record<string, string> {
	const envKeys = config.env_keys;
	if (!isObjectRecord(envKeys)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [env, apiKey] of Object.entries(envKeys)) {
		if (typeof apiKey === 'string') {
			result[normalizeBackboardEnv(env)] = apiKey;
		}
	}
	return result;
}

function backboardConfigApiKey(config: BackboardConfigJson, env = normalizeBackboardEnv(config.env)): string | undefined {
	return stringValueFromRecord(config.api_key)
		|| stringValueFromRecord(config.apiKey)
		|| stringValueFromRecord(backboardConfigEnvKeys(config)[env]);
}

function backboardConfigAccessToken(config: BackboardConfigJson): string | undefined {
	const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
	return stringValueFromRecord(oauth?.access_token);
}
