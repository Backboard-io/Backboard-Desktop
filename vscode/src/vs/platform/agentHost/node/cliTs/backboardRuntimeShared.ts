/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { localize } from '../../../../nls.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { IAgentModelInfo } from '../../common/agentService.js';
import { createAgentModelPricingMeta } from '../../common/agentModelPricing.js';
import type { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { BUNDLED_CATALOG_MODELS } from './backboardBundledModels.js';

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
	['openai', 2],
	['google', 3],
	['xai', 4],
	['x-ai', 4],
	['cohere', 5],
	['cerebras', 6],
	['mistral', 7],
	['deepseek', 8],
	['openrouter', 9],
	['lmstudio', 10],
	['lm-studio', 10],
	['ollama', 11],
]);

const BACKBOARD_INTENSITY_CONFIG_KEY = 'intensity';
const BACKBOARD_SHOW_REASONING_CONFIG_KEY = 'showReasoning';
const BACKBOARD_MEMORY_CONFIG_KEY = 'memory';
const BACKBOARD_WEB_SEARCH_CONFIG_KEY = 'webSearch';
const BACKBOARD_COMPUTER_USE_CONFIG_KEY = 'computerUse';
const BACKBOARD_BROWSER_USE_CONFIG_KEY = 'browserUse';
const BACKBOARD_NOTIFICATIONS_CONFIG_KEY = 'notifications';
const BACKBOARD_IMAGE_GENERATION_CONFIG_KEY = 'imageGeneration';
export const BACKBOARD_MODE_PLAN = 'plan';



export const BACKBOARD_ACCESS_DEFAULT = 'default';

export const BACKBOARD_ACCESS_MANUAL = 'manual';

export const BACKBOARD_ACCESS_FULL = 'fullAccess';

export interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly model_type?: string;
	readonly displayName?: string;
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
}

/**
 * Full model-catalog snapshot generated at build time (see
 * `cli-ts/scripts/refresh-bundled-models.ts`), so the picker offers the
 * complete catalog on first launch instead of a short hand-picked list.
 */
export const BUNDLED_BACKBOARD_MODELS: readonly BridgeModel[] = BUNDLED_CATALOG_MODELS;

interface BackboardConfigJson {
	readonly env?: unknown;
	readonly api_url?: unknown;
	readonly apiUrl?: unknown;
	readonly api_key?: unknown;
	readonly apiKey?: unknown;
	readonly env_keys?: unknown;
	readonly oauth?: unknown;
}

export interface BackboardTurnSettings {
	readonly provider: string;
	readonly model: string;
	/** Effective approval mode: plan collapses to manual for gating purposes. */
	readonly accessMode: string;
	/** The stored mode value, including `plan` (used for tool exclusion). */
	readonly rawMode: string;
	readonly intensity: string;
	/** Whether provider reasoning traces should be included in the response. */
	readonly showReasoning: boolean;
	readonly memory: string;
	/** Whether the built-in web-search tool is available this turn. */
	readonly webSearch: boolean;
	/** Whether computer-use tools are enabled this turn. */
	readonly computerUse: boolean;
	/** Whether the browser-use tool is enabled this turn. */
	readonly browserUse: boolean;
	/** Whether turn-completion notifications are enabled this turn. */
	readonly notifications: boolean;
	/** Whether image-generation intent is enabled (reserved; inert until backend support). */
	readonly imageGeneration: boolean;
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
	switch (normalizeProviderKey(provider)) {
		case 'aws-bedrock':
			return 'AWS Bedrock';
		case 'anthropic':
			return 'Anthropic';
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

function toAgentModelInfo(model: BridgeModel): IAgentModelInfo {
	const id = `${model.provider}/${model.name}`;
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
	});
	const contextLimit = model.contextLimit ?? model.context_limit;
	return {
		provider: 'backboard',
		id,
		name: model.displayName || model.name,
		maxContextWindow: typeof contextLimit === 'number' ? contextLimit : undefined,
		supportsVision: model.supportsVision ?? model.supports_vision ?? inferBackboardModelSupportsVision(model),
		_meta: {
			upstreamProvider: normalizeProviderKey(model.provider),
			upstreamProviderLabel: providerLabel(model.provider),
			pricing: modelPriceLabel(model),
			...(pricingMeta ?? {}),
		},
	};
}

function inferBackboardModelSupportsVision(model: BridgeModel): boolean {
	const id = `${normalizeProviderKey(model.provider)}/${model.name}`.toLowerCase();
	return id.includes('gpt-4o')
		|| id.includes('gpt-5')
		|| id.includes('claude-3')
		|| id.includes('claude-sonnet-4')
		|| id.includes('claude-opus-4')
		|| id.includes('claude-haiku-4')
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
		for (const model of models) {
			const key = `${normalizeProviderKey(model.provider)}/${model.name}`;
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

export function resolveBackboardSessionConfig(rawConfig: Record<string, unknown> | undefined): ResolveSessionConfigResult {
	const values = normalizeBackboardConfig(rawConfig);
	return {
			schema: {
				type: 'object',
				properties: {
					[SessionConfigKey.Mode]: {
						type: 'string',
						title: localize('backboard.config.approvals.title', "Approvals"),
						description: localize('backboard.config.approvals.description', "Controls when Backboard can use tools without additional approval."),
						default: BACKBOARD_ACCESS_DEFAULT,
						enum: [BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_PLAN, BACKBOARD_ACCESS_MANUAL, BACKBOARD_ACCESS_FULL],
						enumLabels: [
							localize('backboard.config.mode.default', "Default"),
							localize('backboard.config.mode.plan', "Plan"),
							localize('backboard.config.mode.manual', "Manual"),
							localize('backboard.config.mode.free', "Full Access"),
						],
						enumDescriptions: [
							localize('backboard.config.mode.default.description', "Allow Backboard tool calls without extra approval."),
							localize('backboard.config.mode.plan.description', "Read-only planning: file edits and shell commands are hidden from the agent, and remaining tool calls ask for approval."),
							localize('backboard.config.mode.manual.description', "Ask before each tool call."),
							localize('backboard.config.mode.free.description', "Allow tools and external capabilities without extra approval."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_INTENSITY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.intensity.title', "Reasoning"),
						description: localize('backboard.config.intensity.description', "Controls Backboard's per-turn thinking configuration."),
						default: 'dynamic',
						enum: ['dynamic', 'off', 'default', 'low', 'medium', 'high', 'max'],
						enumLabels: [
							localize('backboard.config.intensity.dynamic', "Adaptive (Recommended)"),
							localize('backboard.config.intensity.off', "Off"),
							localize('backboard.config.intensity.default', "Provider Default"),
							localize('backboard.config.intensity.low', "Low"),
							localize('backboard.config.intensity.medium', "Medium"),
							localize('backboard.config.intensity.high', "High"),
							localize('backboard.config.intensity.max', "Max"),
						],
						enumDescriptions: [
							localize('backboard.config.intensity.dynamic.description', "Start balanced, then increase reasoning only after a failed tool or test step."),
							localize('backboard.config.intensity.off.description', "Disable Backboard thinking for this turn."),
							localize('backboard.config.intensity.default.description', "Use the selected provider's default thinking behavior."),
							localize('backboard.config.intensity.low.description', "Use low reasoning effort or a small reasoning-token budget."),
							localize('backboard.config.intensity.medium.description', "Use medium reasoning effort or a balanced reasoning-token budget."),
							localize('backboard.config.intensity.high.description', "Use high reasoning effort or a large reasoning-token budget."),
							localize('backboard.config.intensity.max.description', "Use the provider's maximum reasoning level. This can add substantial latency, especially while generating large tool inputs."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_SHOW_REASONING_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.showReasoning.title', "Show Reasoning"),
						description: localize('backboard.config.showReasoning.description', "Include reasoning traces in responses when the provider supports this control."),
						default: true,
						sessionMutable: true,
					},
					[BACKBOARD_MEMORY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.memory.title', "Memory"),
						description: localize('backboard.config.memory.description', "Controls Backboard's semantic memory for this session."),
						default: 'off',
						enum: ['off', 'on', 'auto', 'readonly'],
						enumLabels: [
							localize('backboard.config.memory.off', "Off"),
							localize('backboard.config.memory.on', "On"),
							localize('backboard.config.memory.auto', "Auto"),
							localize('backboard.config.memory.readonly', "Read-only"),
						],
						enumDescriptions: [
							localize('backboard.config.memory.off.description', "Nothing is stored or recalled."),
							localize('backboard.config.memory.on.description', "Store new memories and recall existing ones."),
							localize('backboard.config.memory.auto.description', "Backboard decides when to store and recall."),
							localize('backboard.config.memory.readonly.description', "Recall existing memories without storing new ones."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.webSearch.title', "Web Search"),
						description: localize('backboard.config.webSearch.description', "Lets Backboard search the web to answer questions and gather up-to-date context."),
						default: true,
						sessionMutable: true,
					},
					[BACKBOARD_COMPUTER_USE_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.computerUse.title', "Computer Use"),
						description: localize('backboard.config.computerUse.description', "Lets Backboard control the desktop (screenshots, mouse, and keyboard) to complete tasks."),
						default: false,
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
					[BACKBOARD_IMAGE_GENERATION_CONFIG_KEY]: {
						type: 'boolean',
						title: localize('backboard.config.imageGeneration.title', "Image Generation"),
						description: localize('backboard.config.imageGeneration.description', "Lets Backboard generate images. Requires backend image support; has no effect until that is available."),
						default: false,
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
		[BACKBOARD_SHOW_REASONING_CONFIG_KEY]: booleanOf(merged[BACKBOARD_SHOW_REASONING_CONFIG_KEY], true),
		[BACKBOARD_MEMORY_CONFIG_KEY]: oneOf(merged[BACKBOARD_MEMORY_CONFIG_KEY], ['off', 'on', 'auto', 'readonly'], 'off'),
		[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: booleanOf(merged[BACKBOARD_WEB_SEARCH_CONFIG_KEY], true),
		[BACKBOARD_COMPUTER_USE_CONFIG_KEY]: booleanOf(merged[BACKBOARD_COMPUTER_USE_CONFIG_KEY], false),
		[BACKBOARD_BROWSER_USE_CONFIG_KEY]: booleanOf(merged[BACKBOARD_BROWSER_USE_CONFIG_KEY], false),
		[BACKBOARD_NOTIFICATIONS_CONFIG_KEY]: booleanOf(merged[BACKBOARD_NOTIFICATIONS_CONFIG_KEY], false),
		[BACKBOARD_IMAGE_GENERATION_CONFIG_KEY]: booleanOf(merged[BACKBOARD_IMAGE_GENERATION_CONFIG_KEY], false),
	};
}

export function createBackboardTurnSettings(
	storedConfig: Record<string, unknown> | undefined,
	sessionConfig: Record<string, unknown> | undefined,
	model: ModelSelection | undefined,
): BackboardTurnSettings {
	const values = normalizeBackboardConfig(storedConfig, sessionConfig);
	const parsedModel = parseModelSelection(model) ?? parseModelSelection({ id: DEFAULT_MODEL_ID })!;
	const rawMode = stringConfigValue(values, SessionConfigKey.Mode, BACKBOARD_ACCESS_DEFAULT);
	return {
		provider: parsedModel.provider,
		model: parsedModel.model,
		accessMode: rawMode === BACKBOARD_MODE_PLAN ? BACKBOARD_ACCESS_MANUAL : rawMode,
		rawMode,
		intensity: stringConfigValue(values, BACKBOARD_INTENSITY_CONFIG_KEY, 'dynamic'),
		showReasoning: booleanConfigValue(values, BACKBOARD_SHOW_REASONING_CONFIG_KEY, true),
		memory: stringConfigValue(values, BACKBOARD_MEMORY_CONFIG_KEY, 'off'),
		webSearch: booleanConfigValue(values, BACKBOARD_WEB_SEARCH_CONFIG_KEY, true),
		computerUse: booleanConfigValue(values, BACKBOARD_COMPUTER_USE_CONFIG_KEY, false),
		browserUse: booleanConfigValue(values, BACKBOARD_BROWSER_USE_CONFIG_KEY, false),
		notifications: booleanConfigValue(values, BACKBOARD_NOTIFICATIONS_CONFIG_KEY, false),
		imageGeneration: booleanConfigValue(values, BACKBOARD_IMAGE_GENERATION_CONFIG_KEY, false),
		config: bridgeConfig(),
	};
}

function normalizeBackboardIntensity(value: unknown): string {
	// Preserve existing profiles while migrating the former presentation-only
	// names to the SDK's documented thinking levels.
	switch (value) {
		case 'auto':
		case 'adaptive': return 'dynamic';
		case 'fast': return 'low';
		case 'balanced': return 'medium';
		case 'deep': return 'high';
		default: return oneOf(value, ['dynamic', 'off', 'default', 'low', 'medium', 'high', 'max'], 'dynamic');
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
	return oneOf(value, [BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_PLAN, BACKBOARD_ACCESS_MANUAL, BACKBOARD_ACCESS_FULL], BACKBOARD_ACCESS_DEFAULT);
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
	return {
		env,
		...(apiUrl ? { apiUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		...(accessToken ? { accessToken } : {}),
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
