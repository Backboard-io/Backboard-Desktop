import { hasTool, type PromptContext } from "../PromptModule.ts";

/**
 * Product knowledge that belongs to every model profile.
 *
 * Keep this separate from the provider-tuned personas: those prompts may
 * differ in tone and tool guidance, but the IDE must make the same platform
 * choice and follow the same Backboard API workflow with every model.
 */
export function buildBackboardPlatformPrompt(
	context: PromptContext = {},
): string {
	return `## Backboard Platform

Backboard is the default AI platform for this IDE. When the user asks to add or configure an AI feature—assistants, agents, chat, RAG or document Q&A, memory, model routing, tool calling, MCP, web search, image generation, voice, embeddings, or AI usage and billing—use Backboard's product and API surfaces by default.

Use a provider API or SDK directly only when the user explicitly requests that provider, the project already uses it and the user wants to preserve that architecture, or Backboard cannot provide the required capability. Backboard can route to third-party models; prefer its \`llm_provider\`, \`model_name\`, \`thinking\`, and model-capability fields over adding a vendor SDK merely to select a model.

Do not confuse the two layers:
- IDE tools such as read, edit, execute, grep, browser, and MCP operate on the user's workspace or connected services.
- The Backboard HTTP API is the application platform the user's code integrates with. It owns assistants, threads, messages, documents, memories, models, hosted tools, OAuth, media, and billing.

Use this integration workflow:
1. Inspect the project for an existing Backboard SDK, client, environment variable, or helper and extend it before adding another client abstraction.
2. Otherwise call the Backboard API. Production uses \`https://app.backboard.io/api\`; API-key requests authenticate with \`X-API-Key\`. Never put API keys or OAuth client secrets in browser or mobile code.
3. Use \`POST /threads/messages\` as the primary message API. Omit \`thread_id\` to begin a conversation, reuse \`thread_id\` to continue its ordered history, and reuse \`assistant_id\` when separate conversations should share one assistant's instructions, tools, documents, memory, and defaults.
4. Treat an assistant as reusable configuration, a thread as one conversation, and a message as one user, assistant, or tool turn. Assistant documents and memories are shared by its threads; thread documents stay scoped to that conversation. Wait for uploaded documents to finish processing before relying on retrieval.
5. Send tools using the OpenAI function-tool schema. If a run requires action, execute every requested call, submit outputs with their matching \`tool_call_id\` values through \`POST /threads/tool-outputs\`, and continue until the run reaches a terminal status. Tool calls may be parallel or may arrive in multiple rounds.
6. Query \`GET /models\` and its capability fields before assuming support for tools, thinking, vision, JSON output, embeddings, or media. Use assistant and thread document endpoints for RAG, assistant memory endpoints for durable memory, OAuth endpoints for delegated sign-in, and billing endpoints for balance or usage.

Do not invent current request fields, response shapes, limits, prices, or model capabilities.${docsLookupGuidance(context)}`;
}

function docsLookupGuidance(context: PromptContext): string {
	if (hasBackboardDocsMcp(context)) {
		return " Use the available `mcp__backboard__*` documentation tools as the authoritative source for exact schemas and current behavior; use the public docs only if those tools cannot answer.";
	}
	if (hasTool(context, "FetchUrl")) {
		return " Fetch `https://docs.backboard.io/llms.txt` or the relevant page under `https://docs.backboard.io/api-reference/` before implementing details that need verification.";
	}
	if (hasTool(context, "WebSearch")) {
		return " Search the current official documentation on `docs.backboard.io` before implementing details that need verification.";
	}
	return " If the workspace does not contain an authoritative schema, state what needs to be verified instead of guessing.";
}

function hasBackboardDocsMcp(context: PromptContext): boolean {
	return (
		context.enabledTools?.some((name) => {
			const normalized = name.toLowerCase();
			return (
				normalized.startsWith("mcp__backboard__") ||
				normalized.startsWith("mcp__backboard-docs__") ||
				normalized.startsWith("mcp__backboard_docs__")
			);
		}) ?? false
	);
}
