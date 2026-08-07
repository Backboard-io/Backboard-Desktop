/** How long the model picker keeps a fetched catalog in memory. */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Page size used for Backboard provider model catalog requests. */
export const MODEL_PAGE_LIMIT = 500;

/** Providers that are not selectable chat model providers in Backboard Studio. */
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

export const BACKBOARD_STREAM_EVENTS = {
	userMessage: "user_message",
	// Server-side pipeline phase frames emitted before the model produces any
	// content. Surfaced as `status` provider events so the host can show a
	// truthful "Preparing…/Working…" indicator during the otherwise-silent
	// send→first-token gap instead of a static placeholder.
	messageReceived: "message_received",
	runStarted: "run_started",
	messageStart: "message_start",
	contentStreaming: "content_streaming",
	reasoningStreaming: "reasoning_streaming",
	reasoningDelta: "reasoning_delta",
	// Advisory early tool-call lifecycle events. `tool_call_start` arrives as
	// soon as the provider knows the call id/name, while its arguments are
	// still being generated; `tool_call_ready` carries the completed call.
	// `tool_submit_required` remains the authoritative list.
	toolCallStart: "tool_call_start",
	toolCallReady: "tool_call_ready",
	toolSubmitRequired: "tool_submit_required",
	runEnded: "run_ended",
	messageComplete: "message_complete",
	runFailed: "run_failed",
	runCancelled: "run_cancelled",
	error: "error",
} as const;
