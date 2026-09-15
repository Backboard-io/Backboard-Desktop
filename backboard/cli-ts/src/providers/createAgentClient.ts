import { providerKeyResolver } from "../config/auth.ts";
import { supportsSubscriptions } from "../config/releaseFeatures.ts";
import type { Config } from "../config/Config.ts";
import type { ServerEventLog } from "../core/session/ServerEventLog.ts";
import type { AgentClient } from "./AgentClient.ts";
import { BackboardClient } from "./backboard/BackboardClient.ts";
import { ByokClient } from "./byok/ByokClient.ts";
import { ByokConversationStore } from "./byok/ByokConversationStore.ts";
import {
	CHATGPT_SUBSCRIPTION_PROVIDER,
	CHATGPT_SUBSCRIPTION_THREAD_PREFIX,
	CLAUDE_SUBSCRIPTION_PROVIDER,
	CLAUDE_SUBSCRIPTION_THREAD_PREFIX,
	ClientRouter,
	type SubscriptionClientRoute,
} from "./ClientRouter.ts";
import { ClaudeSubscriptionClient } from "./subscription/ClaudeSubscriptionClient.ts";
import { ClaudeSubscriptionConversationStore } from "./subscription/ClaudeSubscriptionConversationStore.ts";
import { CodexSubscriptionClient } from "./subscription/CodexSubscriptionClient.ts";
import { SubscriptionConversationStore } from "./subscription/SubscriptionConversationStore.ts";
import { SubscriptionMemoryStore } from "./subscription/SubscriptionMemoryStore.ts";

/**
 * Builds the model backend for a run from whatever credentials exist.
 *
 * Key lookups read `config.auth` at call time rather than being captured, so a
 * `/keys` toggle or a mid-session `/login` takes effect on the next request
 * without rebuilding the client or restarting the CLI.
 */
export function createAgentClient(
	config: Config,
	serverLog?: ServerEventLog,
	conversationBaseDir = config.cwd,
): AgentClient {
	// Built unconditionally, even with no sign-in: it reads `config.env`, which
	// `refreshAuth()` mutates in place, so a mid-session `/login` makes it live
	// without rebuilding anything. Gating construction on the credential
	// present at startup would have left Backboard models unreachable until a
	// restart for anyone who started keys-only.
	const backboard = new BackboardClient(config.env, serverLog);
	const byok = new ByokClient(
		(provider) => providerKeyResolver(config.auth)(provider),
		serverLog,
		new ByokConversationStore(conversationBaseDir),
	);
	const chatGptSubscription = supportsSubscriptions() && config.auth.chatgptSubscription
		? new CodexSubscriptionClient({
				authFile: config.auth.chatgptSubscription.authFile,
				conversationStore: new SubscriptionConversationStore(
					conversationBaseDir,
				),
				memoryStore: new SubscriptionMemoryStore(conversationBaseDir),
			})
		: undefined;
	const claudeSubscription = supportsSubscriptions() && config.auth.claudeSubscription
		? new ClaudeSubscriptionClient({
				cwd: config.cwd,
				conversationStore: new ClaudeSubscriptionConversationStore(
					conversationBaseDir,
				),
				memoryStore: new SubscriptionMemoryStore(conversationBaseDir),
			})
		: undefined;
	const subscriptions: Record<string, SubscriptionClientRoute> = {};
	if (chatGptSubscription) {
		subscriptions[CHATGPT_SUBSCRIPTION_PROVIDER] = {
			client: chatGptSubscription,
			threadPrefix: CHATGPT_SUBSCRIPTION_THREAD_PREFIX,
		};
	}
	if (claudeSubscription) {
		subscriptions[CLAUDE_SUBSCRIPTION_PROVIDER] = {
			client: claudeSubscription,
			threadPrefix: CLAUDE_SUBSCRIPTION_THREAD_PREFIX,
		};
	}

	return new ClientRouter({
		backboard,
		byok,
		...(Object.keys(subscriptions).length > 0 ? { subscriptions } : {}),
		getModel: () => config.model,
		hasBackboardAuth: () => config.hasBackboardAuth,
		hasKeyFor: (provider) =>
			config.auth.providerKeys.some((entry) => entry.provider === provider),
	});
}
