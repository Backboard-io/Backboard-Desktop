import { createHash } from "node:crypto";
import type { ThinkingConfig } from "../../../config/defaults.ts";
import type { ModelCatalogItem, ProviderEvent } from "../../backboard/types.ts";
import { ToolCallDeltaAccumulator } from "../../ToolCallDeltaAccumulator.ts";
import { unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	assertCredentialCurrent,
	credentialKey,
	type ProviderCredential,
	type ProviderTransport,
} from "../ProviderCredential.ts";
import {
	decodeProviderMetadata,
	encodeProviderMetadata,
} from "../ProviderMetadata.ts";
import {
	OPENROUTER_API_BASE,
	OPENROUTER_APP_TITLE,
	OPENROUTER_APP_URL,
	OPENROUTER_CATALOG_TTL_MS,
	OPENROUTER_REASONING_PARAMETERS,
	OPENROUTER_REQUIRED_MODEL_PARAMETERS,
} from "./OpenRouterAdapter.constants.ts";

interface OpenRouterModelsResponse {
	data?: OpenRouterModel[];
}

interface OpenRouterModel {
	id?: string;
	created?: number;
	context_length?: number;
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
}

interface OpenRouterCatalog {
	models: ModelCatalogItem[];
}

interface CachedOpenRouterCatalog {
	credentialId: string;
	expiresAt: number;
	value?: OpenRouterCatalog;
	pending?: Promise<OpenRouterCatalog>;
}

let cachedCatalog: CachedOpenRouterCatalog | null = null;

export const openRouterAdapter: ProviderAdapter = {
	id: "openrouter",
	label: "OpenRouter",
	consoleUrl: "https://openrouter.ai/settings/keys",
	keyHint: "sk-or-v1-...",

	looksLikeKey(key) {
		return /^sk-or-v1-[\w-]{20,}$/.test(credentialKey(key).trim());
	},

	async validateKey(key, signal, transport) {
		await getJson<unknown>(
			`${OPENROUTER_API_BASE}/key`,
			headers(key),
			"openrouter",
			signal,
			key,
			transport,
		);
	},

	async listModels(key, signal, transport) {
		const catalog = await waitForSignal(loadCatalog(key, transport), signal);
		assertCredentialCurrent(key);
		return catalog.models;
	},

	async supportsThinking(model, key, transport) {
		const catalog = await loadCatalog(key, transport);
		assertCredentialCurrent(key);
		return (
			catalog.models.find((candidate) => candidate.name === model)
				?.supports_thinking === true
		);
	},

	stream(request, key) {
		return streamOpenRouter(request, key);
	},
};

export function isOpenRouterChatModel(model: OpenRouterModel): boolean {
	if (!model.id) return false;
	const parameters = new Set(model.supported_parameters ?? []);
	if (
		!OPENROUTER_REQUIRED_MODEL_PARAMETERS.every((parameter) =>
			parameters.has(parameter),
		)
	) {
		return false;
	}
	const input = model.architecture?.input_modalities;
	const output = model.architecture?.output_modalities;
	return (
		(input?.includes("text") ?? false) && (output?.includes("text") ?? false)
	);
}

export function supportsOpenRouterThinking(
	supportedParameters: readonly string[] | undefined,
): boolean {
	return supportsReasoningParameter(supportedParameters);
}

async function* streamOpenRouter(
	request: ByokStreamRequest,
	key: ProviderCredential,
): AsyncIterable<ProviderEvent> {
	const modelMetadata: { value: ModelCatalogItem | null } = { value: null };
	void loadCatalog(key, request.transport)
		.then((catalog) => {
			modelMetadata.value =
				catalog.models.find((candidate) => candidate.name === request.model) ??
				null;
		})
		.catch(() => {});
	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenRouterMessages(request),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (request.tools.length > 0) {
		body.tools = request.tools;
		body.tool_choice = "auto";
		body.provider = { require_parameters: true };
	}
	const reasoning = openRouterReasoning(request.thinking);
	if (reasoning) body.reasoning = reasoning;
	if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;

	yield {
		kind: "thinking_resolved",
		requested: request.thinking,
		effective: { reasoning: reasoning ?? "provider-default" },
		provider: "openrouter",
		model: request.model,
		reason: "openrouter-model-capability-mapping",
	};

	const pending = new ToolCallDeltaAccumulator(
		request.tools.map((tool) => tool.function.name),
	);
	const reasoningDetails = new Map<string, Record<string, unknown>>();
	let finishReason: string | null = null;
	let usage = emptyUsage();

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${OPENROUTER_API_BASE}/chat/completions`,
		headers: headers(key),
		credential: key,
		transport: request.transport,
		body,
		provider: "openrouter",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		let emitted = false;
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? "OpenRouter returned an error event",
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
						reasoning_details?: unknown[];
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
					error?: { message?: string };
			  }
			| undefined;
		if (!choice) {
			yield { kind: "activity" };
			continue;
		}
		if (choice.error) {
			yield {
				kind: "failed",
				error: choice.error.message ?? "OpenRouter returned an error choice",
			};
			return;
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (delta?.content) {
			emitted = true;
			yield { kind: "assistant_delta", text: delta.content };
		}
		const reasoningText =
			delta?.reasoning ||
			delta?.reasoning_content ||
			reasoningDetailText(delta?.reasoning_details);
		if (reasoningText) {
			emitted = true;
			yield { kind: "reasoning_delta", text: reasoningText };
		}
		if (Array.isArray(delta?.reasoning_details)) {
			mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
		}
		for (const event of pending.add(delta?.tool_calls ?? [])) {
			emitted = true;
			yield event;
			if (event.kind === "failed") return;
		}
		// Tool JSON, opaque reasoning metadata, usage, and finish frames can all
		// arrive without display text. They still prove the transport is healthy.
		if (!emitted) yield { kind: "activity" };
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("openrouter"),
			retryable: true,
		};
		return;
	}

	if (finishReason === "length" && pending.size > 0) {
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
	const collectedReasoning = [...reasoningDetails.values()];
	const providerMetadata =
		collectedReasoning.length > 0
			? encodeProviderMetadata("openrouter", request.model, collectedReasoning)
			: undefined;
	for (const call of calls) yield { kind: "tool_ready", call };

	const contextLimit = modelMetadata.value?.context_limit ?? null;
	const finalUsage = {
		...usage,
		provider: "openrouter",
		model: request.model,
		...(contextLimit ? { contextLimit } : {}),
	};
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield {
			kind: "requires_action",
			runId: null,
			calls,
			...(providerMetadata ? { providerMetadata } : {}),
		};
		return;
	}
	yield { kind: "completed", usage: finalUsage, providerMetadata };
}

function headers(key: ProviderCredential): Record<string, string> {
	return {
		Authorization: `Bearer ${credentialKey(key).trim()}`,
		"HTTP-Referer": OPENROUTER_APP_URL,
		"X-OpenRouter-Title": OPENROUTER_APP_TITLE,
	};
}

function supportsReasoningParameter(
	supportedParameters: readonly string[] | undefined,
): boolean {
	const parameters = new Set(supportedParameters ?? []);
	return OPENROUTER_REASONING_PARAMETERS.some((parameter) =>
		parameters.has(parameter),
	);
}

async function loadCatalog(
	key: ProviderCredential,
	transport?: ProviderTransport,
): Promise<OpenRouterCatalog> {
	assertCredentialCurrent(key);
	const normalizedKey = credentialKey(key).trim();
	const credentialId = createHash("sha256")
		.update(normalizedKey)
		.update(`:${typeof key === "string" ? "raw" : key.generation}`)
		.digest("hex");
	if (cachedCatalog?.credentialId === credentialId) {
		if (cachedCatalog.value && cachedCatalog.expiresAt > Date.now()) {
			return cachedCatalog.value;
		}
		if (cachedCatalog.pending) return cachedCatalog.pending;
	}

	const pending = fetchCatalog(key, undefined, transport);
	cachedCatalog = {
		credentialId,
		expiresAt: 0,
		pending,
	};
	try {
		const value = await pending;
		assertCredentialCurrent(key);
		if (cachedCatalog?.pending === pending) {
			cachedCatalog = {
				credentialId,
				expiresAt: Date.now() + OPENROUTER_CATALOG_TTL_MS,
				value,
			};
		}
		return value;
	} catch (error) {
		if (cachedCatalog?.pending === pending) cachedCatalog = null;
		throw error;
	}
}

async function fetchCatalog(
	key: ProviderCredential,
	signal?: AbortSignal,
	transport?: ProviderTransport,
): Promise<OpenRouterCatalog> {
	const response = await getJson<OpenRouterModelsResponse>(
		`${OPENROUTER_API_BASE}/models/user`,
		headers(key),
		"openrouter",
		signal,
		key,
		transport,
	);
	const models: ModelCatalogItem[] = [];
	for (const model of response.data ?? []) {
		if (!isOpenRouterChatModel(model)) continue;
		const id = model.id as string;
		const supportsThinking = supportsReasoningParameter(
			model.supported_parameters,
		);
		models.push({
			name: id,
			provider: "openrouter",
			model_type: "llm",
			last_updated:
				typeof model.created === "number" ? model.created * 1000 : null,
			context_limit: positiveNumber(model.context_length),
			supports_vision:
				model.architecture?.input_modalities?.includes("image") ?? false,
			max_output_tokens: positiveNumber(
				model.top_provider?.max_completion_tokens,
			),
			supports_thinking: supportsThinking,
		});
	}
	return { models };
}

function positiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

function openRouterReasoning(
	thinking: ThinkingConfig | null | undefined,
): Record<string, unknown> | null {
	if (!thinking) return null;
	if ("max_tokens" in thinking) {
		return { max_tokens: thinking.max_tokens };
	}
	if ("budget_tokens" in thinking) {
		return { max_tokens: thinking.budget_tokens };
	}
	if (!("effort" in thinking)) return null;
	return {
		effort: thinking.effort === "max" ? "high" : thinking.effort,
	};
}

function emptyUsage(): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
	costUsd: number;
} {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		costUsd: 0,
	};
}

function readUsage(
	usage: Record<string, unknown>,
): ReturnType<typeof emptyUsage> {
	const details = usage.prompt_tokens_details as
		| Record<string, unknown>
		| undefined;
	return {
		inputTokens: numberOf(usage.prompt_tokens),
		outputTokens: numberOf(usage.completion_tokens),
		totalTokens: numberOf(usage.total_tokens),
		cachedTokens: numberOf(details?.cached_tokens),
		costUsd: numberOf(usage.cost),
	};
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toOpenRouterMessages(request: ByokStreamRequest): unknown[] {
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
			const reasoningDetails = readReasoningDetails(
				JSON.stringify(
					decodeProviderMetadata(
						message.providerMetadata,
						"openrouter",
						request.model,
					),
				),
			);
			if (reasoningDetails) entry.reasoning_details = reasoningDetails;

			out.push(entry);
			continue;
		}
		for (const result of message.results) {
			out.push({
				role: "tool",
				tool_call_id: result.id,
				name: result.name,
				content: result.output || "(no output)",
			});
		}
	}
	return out;
}

function readReasoningDetails(signature: string | undefined): unknown[] | null {
	if (!signature) return null;
	try {
		const parsed: unknown = JSON.parse(signature);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function mergeReasoningDetails(
	pending: Map<string, Record<string, unknown>>,
	details: readonly unknown[],
): void {
	for (const [position, detail] of details.entries()) {
		if (
			typeof detail !== "object" ||
			detail === null ||
			Array.isArray(detail)
		) {
			continue;
		}
		const incoming = detail as Record<string, unknown>;
		const type = typeof incoming.type === "string" ? incoming.type : "unknown";
		const key =
			typeof incoming.id === "string" && incoming.id
				? `id:${incoming.id}:${type}`
				: typeof incoming.index === "number" && Number.isFinite(incoming.index)
					? `index:${incoming.index}:${type}`
					: `position:${position}:${type}`;
		const existing = pending.get(key) ?? {};
		const merged = { ...existing, ...incoming };
		if (typeof incoming.text === "string") {
			merged.text =
				typeof existing.text === "string"
					? `${existing.text}${incoming.text}`
					: incoming.text;
		}
		pending.set(key, merged);
	}
}

function reasoningDetailText(details: readonly unknown[] | undefined): string {
	if (!details) return "";
	return details
		.flatMap((detail) => {
			if (
				typeof detail !== "object" ||
				detail === null ||
				Array.isArray(detail)
			) {
				return [];
			}
			const text = (detail as Record<string, unknown>).text;
			return typeof text === "string" ? [text] : [];
		})
		.join("");
}

function waitForSignal<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException("The operation was aborted.", "AbortError")
	);
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
