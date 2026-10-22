/** How long the model picker keeps a fetched catalog in memory. */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Page size used for Backboard provider model catalog requests. */
export const MODEL_PAGE_LIMIT = 500;

/** Providers that are not selectable chat model providers in Backboard R-CLI. */
export const EXCLUDED_MODEL_PROVIDERS = ["elevenlabs", "featherless"] as const;

/** Product order for grouping providers in the model picker. */
export const CHAT_PROVIDER_PRIORITY = [
	"openai",
	"google",
	"anthropic",
	"xai",
	"cohere",
	"cerebras",
	"openrouter",
	"aws-bedrock",
] as const;

/** Backboard provider that serves System One decision models. */
export const SYSTEM_ONE_PROVIDER = "typesafe";

/** TypeSafe's rolling Jev alias; pinned versions are `jev-<semver>`. */
export const SYSTEM_ONE_DEFAULT_MODEL = "jev-latest";

export const BACKBOARD_STREAM_EVENTS = {
	userMessage: "user_message",
	contentStreaming: "content_streaming",
	reasoningStreaming: "reasoning_streaming",
	reasoningDelta: "reasoning_delta",
	mediaGenerated: "media_generated",
	toolCallStart: "tool_call_start",
	toolCallReady: "tool_call_ready",
	toolCalls: "tool_calls",
	toolSubmitRequired: "tool_submit_required",
	runEnded: "run_ended",
	messageComplete: "message_complete",
	runFailed: "run_failed",
	runCancelled: "run_cancelled",
	error: "error",
} as const;

/** Identifies the calling product to the backend, which tracks daily activity per product surface. */
export const CLIENT_HEADER = "X-Backboard-Client";
