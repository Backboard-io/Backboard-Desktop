/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bring-your-own-key (BYOK) vocabulary shared by the agent host and the
 * workbench.
 *
 * A model selection in the IDE carries its billing route in the provider
 * prefix of its id: `openai/gpt-5.5` bills to Backboard, `openai-key/gpt-5.5`
 * bills to the user's own OpenAI key, and `openai-subscription/…` to a ChatGPT
 * plan. The `-key` suffix exists only on the IDE side; the runtime is always
 * handed the bare vendor id plus an explicit `source`.
 */

/** Where a model call is billed. */
export type ModelRouteSource = 'backboard' | 'byok' | 'subscription';

/** A model selection resolved to what the runtime needs: vendor, model, and billing source. */
export interface ModelRoute {
	readonly source: ModelRouteSource;
	/** The vendor id the runtime understands; never carries the `-key` suffix. */
	readonly provider: string;
	readonly model: string;
}

/** Vendors a user can bring a key for in this release. */
export type ByokProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'xai';

export interface IByokProviderDefinition {
	readonly id: ByokProviderId;
	readonly label: string;
	/** Expected key shape, shown as the input placeholder. */
	readonly keyHint: string;
	readonly consoleUrl: string;
	/** Cheap local shape check, mirrored from the cli-ts adapter, run before any network call. */
	looksLikeKey(key: string): boolean;
}

export const BYOK_PROVIDERS: readonly IByokProviderDefinition[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		keyHint: 'sk-…',
		consoleUrl: 'https://platform.openai.com/api-keys',
		looksLikeKey: key => /^sk-[\w-]{20,}$/.test(key.trim()),
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		keyHint: 'sk-ant-…',
		consoleUrl: 'https://console.anthropic.com/settings/keys',
		looksLikeKey: key => /^sk-ant-[\w-]{20,}$/.test(key.trim()),
	},
	{
		id: 'google', label: 'Google Gemini', keyHint: 'AIza…',
		consoleUrl: 'https://aistudio.google.com/app/apikey',
		looksLikeKey: key => /^AIza[\w-]{30,}$/.test(key.trim()),
	},
	{
		id: 'openrouter', label: 'OpenRouter', keyHint: 'sk-or-v1-…',
		consoleUrl: 'https://openrouter.ai/settings/keys',
		looksLikeKey: key => /^sk-or-v1-[\w-]{20,}$/.test(key.trim()),
	},
	{
		id: 'xai', label: 'xAI', keyHint: 'xai-…',
		consoleUrl: 'https://console.x.ai/',
		looksLikeKey: key => /^xai-[\w-]{20,}$/.test(key.trim()),
	},
];

export const BYOK_KEY_PROVIDER_SUFFIX = '-key';
const SUBSCRIPTION_PROVIDER_SUFFIX = '-subscription';

/** Provider-owned commands the workbench sends through `executeAgentCommand`. */
export const BYOK_COMMANDS = {
	validate: 'providerKeys.validate',
	set: 'providerKeys.set',
	remove: 'providerKeys.remove',
	status: 'providerKeys.status',
} as const;

/** Command argument names. The value under {@link BYOK_KEY_ARG} is a secret and is redacted from every log. */
export const BYOK_PROVIDER_ARG = 'provider';
export const BYOK_KEY_ARG = 'key';
/**
 * Monotonic per-provider counter the key store attaches to `set` and `remove`.
 * The agent host applies a change only when its generation is at least as new
 * as the last one it saw, so a slow older change can never undo a newer one.
 */
export const BYOK_GENERATION_ARG = 'generation';

/** Session settings for Backboard's hosted image and video generation. */
const BACKBOARD_MEDIA_SESSION_CONFIG_KEYS: ReadonlySet<string> = new Set(['imageGeneration', 'imageModel', 'videoModel']);

/**
 * Whether a session setting applies to a model selection, given as a model id
 * or a `vendor:provider/model` language-model identifier. Backboard's hosted
 * media only runs on Backboard-billed requests: a key or subscription request
 * never reaches it, and routing media through Backboard anyway would bill a
 * second account. Memory is a Backboard service too, but subscriptions keep
 * their own local memory, so only key-billed selections lose it.
 */
export function isConfigPropertyAvailableForModel(property: string, modelId: string | undefined): boolean {
	const source = parseBillingRoute(modelId?.replace(/^[^/]*:/, ''))?.source;
	if (BACKBOARD_MEDIA_SESSION_CONFIG_KEYS.has(property)) {
		return source !== 'byok' && source !== 'subscription';
	}
	return property !== 'memory' || source !== 'byok';
}

export function isByokProviderId(value: unknown): value is ByokProviderId {
	return typeof value === 'string' && BYOK_PROVIDERS.some(provider => provider.id === value);
}

export function byokProviderDefinition(id: ByokProviderId): IByokProviderDefinition {
	return BYOK_PROVIDERS.find(provider => provider.id === id)!;
}

/** `openai` → `openai-key`. */
export function keyBilledProviderId(vendor: string): string {
	return `${vendor}${BYOK_KEY_PROVIDER_SUFFIX}`;
}

export function isKeyBilledProvider(provider: string | undefined): boolean {
	return !!provider && provider.trim().toLowerCase().endsWith(BYOK_KEY_PROVIDER_SUFFIX);
}

/**
 * Whether a model id, or a language-model identifier of the form
 * `vendor:provider/model`, selects a key-billed route.
 */
export function isKeyBilledModelId(id: string | undefined): boolean {
	if (!id) {
		return false;
	}
	// A language-model identifier prefixes the model id with `<vendor>:`.
	const withoutVendor = id.replace(/^[^/]*:/, '');
	const slash = withoutVendor.indexOf('/');
	return slash > 0 && isKeyBilledProvider(withoutVendor.slice(0, slash));
}

/** `openai-key` → `openai`; other providers are returned trimmed. */
export function vendorOfProvider(provider: string): string {
	const trimmed = provider.trim();
	return isKeyBilledProvider(trimmed) ? trimmed.slice(0, -BYOK_KEY_PROVIDER_SUFFIX.length) : trimmed;
}

/** Resolves an IDE provider prefix to the runtime vendor and billing source. */
export function billingRouteForProvider(provider: string, model: string): ModelRoute {
	const trimmed = provider.trim();
	if (isKeyBilledProvider(trimmed)) {
		return { source: 'byok', provider: vendorOfProvider(trimmed), model };
	}
	if (trimmed.toLowerCase().endsWith(SUBSCRIPTION_PROVIDER_SUFFIX)) {
		return { source: 'subscription', provider: trimmed, model };
	}
	return { source: 'backboard', provider: trimmed, model };
}

/** Parses an IDE model id such as `anthropic-key/claude-opus-5`; undefined when it has no provider prefix. */
export function parseBillingRoute(modelId: string | undefined): ModelRoute | undefined {
	if (!modelId) {
		return undefined;
	}
	const slash = modelId.indexOf('/');
	if (slash <= 0 || slash === modelId.length - 1) {
		return undefined;
	}
	return billingRouteForProvider(modelId.slice(0, slash), modelId.slice(slash + 1));
}

/**
 * The provider family used to decide whether a conversation must be handed
 * off to a fresh backend thread. Every key-billed vendor shares one family
 * because BYOK conversations are provider-neutral and continue across vendors;
 * switching between a key route and any other route always needs a handoff.
 */
export function routeProviderFamily(provider: string): string {
	const trimmed = provider.trim().toLowerCase();
	return isKeyBilledProvider(trimmed) ? 'byok' : trimmed;
}
