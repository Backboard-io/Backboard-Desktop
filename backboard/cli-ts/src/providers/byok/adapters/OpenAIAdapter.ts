import { contextWindowFor } from "../../../core/context/ContextWindow.ts";
import type { ModelCatalogItem, ProviderEvent } from "../../backboard/types.ts";
import { ToolCallDeltaAccumulator } from "../../ToolCallDeltaAccumulator.ts";
import { unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import { thinkingEffort } from "../thinking.ts";
import {
	isSupportedOpenAiModel,
	openAiReasoningControls,
	requiresDisabledToolReasoning,
	unsupportedOpenAiModelMessage,
} from "./OpenAIModelRegistry.ts";

const API_BASE = "https://api.openai.com/v1";

interface OpenAIModelsResponse {
	data?: Array<{ id?: string; created?: number }>;
}

/** A tool call assembled across `delta.tool_calls` chunks, keyed by index. */

export const openaiAdapter: ProviderAdapter = {
	id: "openai",
	label: "OpenAI",
	consoleUrl: "https://platform.openai.com/api-keys",
	keyHint: "sk-...",

	looksLikeKey(key) {
		return /^sk-[\w-]{20,}$/.test(key.trim());
	},

	async validateKey(key, signal) {
		await getJson<OpenAIModelsResponse>(
			`${API_BASE}/models`,
			headers(key),
			"openai",
			signal,
		);
	},

	async listModels(key, signal) {
		const response = await getJson<OpenAIModelsResponse>(
			`${API_BASE}/models`,
			headers(key),
			"openai",
			signal,
		);
		const models: ModelCatalogItem[] = [];
		for (const model of response.data ?? []) {
			if (!model.id || !isSupportedOpenAiModel(model.id)) continue;
			models.push({
				name: model.id,
				provider: "openai",
				model_type: "llm",
				// The models list reports epoch seconds; the catalog sorter wants ms.
				last_updated:
					typeof model.created === "number" ? model.created * 1000 : null,
				...openAiReasoningControls(model.id),
				context_limit: contextWindowFor({
					provider: "openai",
					model: model.id,
				}),
			});
		}
		return models;
	},

	supportsThinking(model) {
		return openAiReasoningControls(model).supports_thinking;
	},

	stream(request, key) {
		return streamOpenAI(request, key);
	},
};

function headers(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key.trim()}` };
}

async function* streamOpenAI(
	request: ByokStreamRequest,
	key: string,
): AsyncIterable<ProviderEvent> {
	// The catalog filter keeps unsupported ids out of the picker, but a stored
	// conversation or a stale selection can still name one. Refuse here so the
	// request never reaches an endpoint that would fail in a less legible way.
	if (!isSupportedOpenAiModel(request.model)) {
		yield {
			kind: "failed",
			error: unsupportedOpenAiModelMessage(request.model),
			retryable: false,
		};
		return;
	}
	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenAIMessages(request),
		stream: true,
		// Without this the final chunk carries no usage at all.
		stream_options: { include_usage: true },
	};
	if (request.tools.length > 0) {
		body.tools = request.tools;
		body.tool_choice = "auto";
	}
	// OpenAI caches automatically on the prompt prefix (>1024 tokens), but only
	// when a request lands on a machine that already holds it. The cache key
	// pins one conversation to one shard, which is what turns an incidental hit
	// rate into a reliable one across a long tool loop.
	if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
	const effort = thinkingEffort(request.thinking);
	// Only sent when thinking was actually requested: non-reasoning models
	// reject the parameter outright. GPT-5.4 through GPT-5.6 also reject enabled
	// reasoning when function tools are present on Chat Completions unless it is
	// explicitly disabled.
	if (
		request.tools.length > 0 &&
		requiresDisabledToolReasoning(request.model)
	) {
		body.reasoning_effort = "none";
	} else if (effort) {
		body.reasoning_effort = effort;
	}

	yield {
		kind: "thinking_resolved",
		requested: request.thinking,
		effective: {
			reasoning_effort: body.reasoning_effort ?? "provider-default",
		},
		provider: "openai",
		model: request.model,
		reason:
			request.tools.length > 0 && requiresDisabledToolReasoning(request.model)
				? "chat-completions-tool-compatibility-requires-none"
				: effort
					? "requested-setting"
					: "provider-default",
	};

	const pending = new ToolCallDeltaAccumulator(
		request.tools.map((tool) => tool.function.name),
	);
	let finishReason: string | null = null;
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
	};

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${API_BASE}/chat/completions`,
		headers: headers(key),
		body,
		provider: "openai",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		let emitted = false;
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? "OpenAI returned an error event",
			};
			return;
		}

		const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
		if (chunkUsage) usage = readUsage(chunkUsage);

		const choice = (chunk.choices as unknown[] | undefined)?.[0] as
			| {
					delta?: {
						content?: string | null;
						reasoning?: string | null;
						reasoning_content?: string | null;
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
			  }
			| undefined;
		if (!choice) {
			yield { kind: "activity" };
			continue;
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (delta?.content) {
			emitted = true;
			yield { kind: "assistant_delta", text: delta.content };
		}
		const reasoningText = delta?.reasoning || delta?.reasoning_content;
		if (reasoningText) {
			emitted = true;
			yield { kind: "reasoning_delta", text: reasoningText };
		}
		for (const event of pending.add(delta?.tool_calls ?? [])) {
			emitted = true;
			yield event;
			if (event.kind === "failed") return;
		}
		if (!emitted) yield { kind: "activity" };
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("openai"),
			retryable: true,
		};
		return;
	}

	// Truncation cuts the arguments mid-JSON, so these calls are not runnable.
	// They must not be offered: `tool_ready` is what starts read-only tools
	// running ahead of the round, and a call built from half-parsed arguments
	// would execute with the wrong input before the turn is discarded.
	const truncated = finishReason === "length";
	if (truncated && pending.size > 0) {
		// Silently completing here would end the turn having done nothing, with
		// no hint why. Retryable: the same request can succeed with more room.
		yield {
			kind: "failed",
			error:
				"The model hit its output limit while writing a tool call, so the call was incomplete.",
			retryable: true,
		};
		return;
	}
	const finalCalls = pending.finish();
	if ("error" in finalCalls) {
		yield { kind: "failed", error: finalCalls.error, retryable: false };
		return;
	}
	const calls = finalCalls.calls;
	for (const call of calls) yield { kind: "tool_ready", call };

	const finalUsage = {
		...usage,
		provider: "openai",
		model: request.model,
	};

	// Some models report finish_reason "stop" alongside emitted tool calls;
	// trust the calls themselves, not the label.
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield { kind: "requires_action", runId: null, calls };
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

function readUsage(usage: Record<string, unknown>): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
} {
	const details = usage.prompt_tokens_details as
		| Record<string, unknown>
		| undefined;
	return {
		inputTokens: numberOf(usage.prompt_tokens),
		outputTokens: numberOf(usage.completion_tokens),
		totalTokens: numberOf(usage.total_tokens),
		cachedTokens: numberOf(details?.cached_tokens),
	};
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toOpenAIMessages(request: ByokStreamRequest): unknown[] {
	const out: unknown[] = [{ role: "system", content: request.systemPrompt }];
	for (const message of request.messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: userContent(message) });
			continue;
		}
		if (message.role === "assistant") {
			const entry: Record<string, unknown> = {
				role: "assistant",
				content: message.content || null,
			};
			if (message.toolCalls.length > 0) {
				entry.tool_calls = message.toolCalls.map((call) => ({
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: JSON.stringify(call.input ?? {}),
					},
				}));
			}
			out.push(entry);
			continue;
		}
		// Each tool result is its own message, matching one prior tool_call id.
		for (const result of message.results) {
			out.push({
				role: "tool",
				tool_call_id: result.id,
				content: result.output || "(no output)",
			});
		}
	}
	return out;
}

function userContent(
	message: Extract<ByokMessage, { role: "user" }>,
): string | unknown[] {
	const attachments = message.attachments ?? [];
	if (attachments.length === 0) return message.content;

	const parts: unknown[] = [];
	for (const attachment of attachments) {
		if (attachment.base64) {
			parts.push({
				type: "image_url",
				image_url: {
					url: `data:${attachment.mediaType};base64,${attachment.base64}`,
				},
			});
		} else if (attachment.text) {
			parts.push({
				type: "text",
				text: `Attached file ${attachment.path}:\n${attachment.text}`,
			});
		}
	}
	parts.push({ type: "text", text: message.content || "(empty message)" });
	return parts;
}
