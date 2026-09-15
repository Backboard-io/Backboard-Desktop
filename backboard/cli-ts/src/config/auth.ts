import {
	enabledProviderKeys,
	readProviderKeys,
} from "../core/keys/ProviderKeyStore.ts";
import type {
	ByokProviderId,
	ResolvedProviderKey,
} from "../core/keys/ProviderKeyTypes.ts";
import { readBackboardConfig } from "./backboardConfig.ts";
import { type BackboardEnv, resolveApiUrl } from "./env.ts";
import { supportsSubscriptions } from "./releaseFeatures.ts";

const PLACEHOLDER_API_KEYS = new Set([
	"your_key_here",
	"<your-api-key>",
	"replace_me",
]);

export const NO_CREDENTIALS_MESSAGE =
	supportsSubscriptions()
		? "No credentials found. Sign in with Backboard, connect a ChatGPT or Claude subscription, or add a provider API key."
		: "No credentials found. Sign in with Backboard or add a provider API key.";

export const CHATGPT_SUBSCRIPTION_AUTH_FILE_ENV =
	"BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE";

export const CLAUDE_SUBSCRIPTION_ENV = "BACKBOARD_CLAUDE_SUBSCRIPTION";

export interface ChatGptSubscriptionAuth {
	authFile: string;
}

/** Claude Code owns and refreshes its subscription credentials. */
export interface ClaudeSubscriptionAuth {
	enabled: true;
}

/**
 * Everything the CLI can authenticate with, in one place.
 *
 * Any credential source is enough to run: a Backboard sign-in unlocks the
 * routed catalog, a ChatGPT subscription unlocks the explicit subscription
 * provider, and a saved provider key unlocks that vendor's models directly.
 * Only having none is fatal, which is what the startup auth screen catches.
 */
export interface AuthState {
	/** Present when a Backboard key is set in the env or saved config. */
	backboard: BackboardEnv | null;
	/** Explicit opt-in to a ChatGPT subscription credential file. */
	chatgptSubscription: ChatGptSubscriptionAuth | null;
	/** Explicit opt-in to the locally authenticated Claude Code subscription. */
	claudeSubscription: ClaudeSubscriptionAuth | null;
	/** Saved provider keys that are currently toggled on. */
	providerKeys: ResolvedProviderKey[];
}

export interface ResolveAuthOptions {
	homeDir?: string;
	platform?: NodeJS.Platform;
}

export function resolveAuth(options: ResolveAuthOptions = {}): AuthState {
	const fileConfig = readBackboardConfig(options.homeDir);
	const envApiKey = process.env.BACKBOARD_API_KEY;
	const apiKey = isUsableApiKey(envApiKey) ? envApiKey : fileConfig.apiKey;
	const apiUrl = resolveApiUrl(fileConfig.apiUrl);
	const subscriptionAuthFile =
		process.env[CHATGPT_SUBSCRIPTION_AUTH_FILE_ENV]?.trim() ??
		fileConfig.chatgptSubscriptionAuthFile;
	const claudeSubscriptionEnabled =
		fileConfig.claudeSubscriptionEnabled === true ||
		isEnabledFlag(process.env[CLAUDE_SUBSCRIPTION_ENV]);

	return {
		backboard: apiKey ? { apiKey, apiUrl } : null,
		chatgptSubscription: supportsSubscriptions(options.platform) && subscriptionAuthFile
			? { authFile: subscriptionAuthFile }
			: null,
		claudeSubscription: supportsSubscriptions(options.platform) && claudeSubscriptionEnabled ? { enabled: true } : null,
		// Env vars are deliberately not consulted: a provider key becomes usable
		// only by being added through the BYOK flow or `/keys`, so what the CLI
		// bills to is always something the user chose explicitly.
		providerKeys: enabledProviderKeys(readProviderKeys(options.homeDir)),
	};
}

export function hasAnyCredentials(auth: AuthState): boolean {
	return (
		auth.backboard !== null ||
		(supportsSubscriptions() && (auth.chatgptSubscription !== null || auth.claudeSubscription !== null)) ||
		auth.providerKeys.length > 0
	);
}

/** Builds the provider -> key lookup `ByokClient` and `ClientRouter` use. */
export function providerKeyResolver(
	auth: AuthState,
): (provider: ByokProviderId) => string | null {
	const byProvider = new Map(
		auth.providerKeys.map((entry) => [entry.provider, entry.key]),
	);
	return (provider) => byProvider.get(provider) ?? null;
}

function isUsableApiKey(value: string | undefined): value is string {
	const trimmed = value?.trim();
	return Boolean(trimmed && !PLACEHOLDER_API_KEYS.has(trimmed));
}

function isEnabledFlag(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
