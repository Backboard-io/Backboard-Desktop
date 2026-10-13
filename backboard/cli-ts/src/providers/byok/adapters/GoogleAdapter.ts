import { randomUUID } from "node:crypto";
import { contextWindowFor } from "../../../core/context/ContextWindow.ts";
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../../backboard/types.ts";
import { unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { toGoogleSchema } from "../googleSchema.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	credentialKey,
	type ProviderCredential,
} from "../ProviderCredential.ts";
import {
	decodeProviderMetadata,
	encodeProviderMetadata,
} from "../ProviderMetadata.ts";
import {
	thinkingBudgetTokens,
	thinkingLevel,
	usesNativeAdaptiveThinking,
} from "../thinking.ts";
import {
	GOOGLE_IMAGE_MODEL_PATTERN,
	GOOGLE_NON_CHAT_MODEL_PREFIXES,
	GOOGLE_THINKING_MODEL_PATTERNS,
} from "./GoogleAdapter.constants.ts";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleModelsResponse {
	nextPageToken?: string;
	models?: Array<{
		name?: string;
		displayName?: string;
		inputTokenLimit?: number;
		outputTokenLimit?: number;
		supportedGenerationMethods?: string[];
	}>;
}

export const googleAdapter: ProviderAdapter = {
	id: "google",
	label: "Google Gemini",
	consoleUrl: "https://aistudio.google.com/app/apikey",
	keyHint: "AIza...",

	looksLikeKey(key) {
		return /^AIza[\w-]{30,}$/.test(credentialKey(key).trim());
	},

	async validateKey(key, signal, transport) {
		await getJson<GoogleModelsResponse>(
			`${API_BASE}/models?pageSize=1`,
			headers(key),
			"google",
			signal,
			key,
			transport,
		);
	},

	async listModels(key, signal, transport) {
		const models: ModelCatalogItem[] = [];
		let pageToken: string | undefined;
		const seen = new Set<string>();
		do {
			const response = await getJson<GoogleModelsResponse>(
				`${API_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
				headers(key),
				"google",
				signal,
				key,
				transport,
			);
			for (const model of response.models ?? []) {
				// Names come back namespaced as "models/gemini-...".
				const name = model.name?.replace(/^models\//, "");
				if (!name) continue;
				if (!model.supportedGenerationMethods?.includes("generateContent")) {
					continue;
				}
				if (!isGoogleChatModel(name)) continue;
				models.push({
					name,
					provider: "google",
					model_type: "llm",
					...googleCapabilities(name),
					context_limit:
						model.inputTokenLimit ??
						contextWindowFor({ provider: "google", model: name }),
					max_output_tokens: model.outputTokenLimit ?? null,
					supports_vision: true,
				});
			}
			pageToken = response.nextPageToken;
			if (pageToken && seen.has(pageToken))
				throw new Error("Google returned a repeated model catalog page");
			if (pageToken) seen.add(pageToken);
		} while (pageToken);
		return models;
	},

	modelCapabilities: googleCapabilities,

	supportsThinking(model) {
		return supportsGoogleThinking(model);
	},

	stream(request, key) {
		return streamGoogle(request, key);
	},
};

function headers(key: ProviderCredential): Record<string, string> {
	return { "x-goog-api-key": credentialKey(key).trim() };
}

export function isGoogleChatModel(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	// Explicit nonstandard families documented to share generateContent and custom tools.
	if (
		/^gemma-4-(?:31b|26b-a4b)-it$/.test(normalized) ||
		/^gemini-robotics-er-(?:1\.[56]|2)-preview$/.test(normalized)
	)
		return true;
	if (
		!normalized.startsWith("gemini-") ||
		/embedding|aqa|tts|audio|live|robotics/.test(normalized)
	)
		return false;
	// generateContent alone does not promise custom function calling (for example,
	// the older thinking experiments used a different tool contract).
	if (
		!/^gemini-(?:1\.5-(?:pro|flash)|2\.0-flash|2\.5-(?:pro|flash)|3(?:\.\d+)?-(?:pro|flash)|(?:pro|flash|flash-lite)-latest)(?:$|-)/.test(
			normalized,
		) ||
		normalized.includes("thinking-exp")
	)
		return false;
	if (GOOGLE_IMAGE_MODEL_PATTERN.test(normalized)) return false;
	return !GOOGLE_NON_CHAT_MODEL_PREFIXES.some((prefix) =>
		normalized.startsWith(prefix),
	);
}

export function supportsGoogleThinking(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	return GOOGLE_THINKING_MODEL_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}

/** Keep picker controls within the native API's model-specific range. */
function googleCapabilities(model: string): Partial<ModelCatalogItem> {
	const supported = supportsGoogleThinking(model);
	const native = usesNativeAdaptiveThinking("google", model);
	const controllable = supported && (native || /^gemini-2\.5-/.test(model));
	return {
		supports_thinking: supported,
		supported_effort_levels: !controllable
			? []
			: /^gemini-3-pro(?:$|-)/.test(model)
				? ["low", "high"]
				: ["low", "medium", "high"],
		thinking_controls: {
			supported: controllable,
			allowed_fields: controllable ? [native ? "effort" : "budget_tokens"] : [],
			defaults_only: !controllable,
		},
	};
}

async function* streamGoogle(
	request: ByokStreamRequest,
	key: ProviderCredential,
): AsyncIterable<ProviderEvent> {
	const generationConfig: Record<string, unknown> = {};
	if (request.maxOutputTokens) {
		generationConfig.maxOutputTokens = request.maxOutputTokens;
	}
	const thinkingConfig = googleThinkingConfig(request);
	if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

	const body: Record<string, unknown> = {
		systemInstruction: { parts: [{ text: request.systemPrompt }] },
		contents: renderGoogleContents(request.messages, request.model),
	};
	if (Object.keys(generationConfig).length > 0) {
		body.generationConfig = generationConfig;
	}
	const declarations = toFunctionDeclarations(request);
	if (declarations.length > 0) {
		body.tools = [{ functionDeclarations: declarations }];
	}

	yield {
		kind: "thinking_resolved",
		requested: request.thinking,
		effective: { thinkingConfig: thinkingConfig ?? "provider-default" },
		provider: "google",
		model: request.model,
		reason: "google-model-capability-mapping",
	};

	const calls: ProviderToolCall[] = [];
	const responseParts: Record<string, unknown>[] = [];
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
	};
	let callIndex = 0;
	const fallbackCallPrefix = `gemini_call_${randomUUID()}_`;
	let finishReason: string | null = null;

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${API_BASE}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
		headers: headers(key),
		credential: key,
		transport: request.transport,
		body,
		provider: "google",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		let emitted = false;
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? "Gemini returned an error event",
			};
			return;
		}

		const metadata = chunk.usageMetadata as Record<string, unknown> | undefined;
		if (metadata) usage = readUsage(metadata);

		// A prompt rejected outright comes back with no candidate at all.
		const blockReason = (
			chunk.promptFeedback as { blockReason?: string } | undefined
		)?.blockReason;
		if (blockReason) {
			yield { kind: "failed", error: blockedPromptMessage(blockReason) };
			return;
		}

		const candidate = (chunk.candidates as unknown[] | undefined)?.[0] as
			| { content?: { parts?: unknown[] }; finishReason?: string }
			| undefined;
		if (candidate?.finishReason) finishReason = candidate.finishReason;
		for (const part of candidate?.content?.parts ?? []) {
			if (typeof part !== "object" || part === null) continue;
			const entry = part as {
				text?: string;
				thought?: boolean;
				thoughtSignature?: string;
				functionCall?: { name?: string; args?: unknown; id?: string };
			};
			// Keep every original part, including signature-only and thought parts, in order.
			responseParts.push(structuredClone(entry));
			if (entry.text) {
				emitted = true;
				yield entry.thought
					? { kind: "reasoning_delta", text: entry.text }
					: { kind: "assistant_delta", text: entry.text };
			}
			if (entry.functionCall?.name) {
				// Gemini 3 ids its calls; older models do not, so mint one when it
				// is missing. Adopting the provider's id rather than always minting
				// keeps the pairing unambiguous when the model fires two calls of
				// the *same* tool in one round, where matching a result back by
				// name alone cannot tell them apart.
				const call: ProviderToolCall = {
					id: entry.functionCall.id ?? `${fallbackCallPrefix}${callIndex++}`,
					name: entry.functionCall.name,
					input: entry.functionCall.args ?? {},
					// Gemini 3 signs the part that holds a function call and rejects
					// the next request if the call comes back unsigned, so the token
					// has to survive the round-trip through the transcript.
					...(entry.thoughtSignature
						? { signature: entry.thoughtSignature }
						: {}),
				};
				calls.push(call);
				emitted = true;
				yield { kind: "tool_started", id: call.id, name: call.name };
				yield { kind: "tool_ready", call };
			}
		}
		if (!emitted) yield { kind: "activity" };
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("google"),
			retryable: true,
		};
		return;
	}

	const finalUsage = { ...usage, provider: "google", model: request.model };
	// Anything but a normal stop ended the turn early. Without this the turn
	// completes empty and the user is left with a blank reply and no reason.
	const abnormal = abnormalFinishMessage(finishReason);
	if (abnormal) {
		yield {
			kind: "failed",
			error: abnormal,
			retryable: finishReason === "MAX_TOKENS",
		};
		return;
	}
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield {
			kind: "requires_action",
			runId: null,
			calls,
			providerMetadata: encodeProviderMetadata(
				"google",
				request.model,
				responseParts,
			),
		};
		return;
	}
	yield {
		kind: "completed",
		usage: finalUsage,
		providerMetadata: encodeProviderMetadata(
			"google",
			request.model,
			responseParts,
		),
	};
}

function blockedPromptMessage(reason: string): string {
	return `Gemini refused the request (${reason.toLowerCase()}).`;
}

/** `null` for a normal finish; a message for anything that cut the turn short. */
function abnormalFinishMessage(reason: string | null): string | null {
	switch (reason) {
		case null:
		case "STOP":
		case "FINISH_REASON_UNSPECIFIED":
			return null;
		case "MAX_TOKENS":
			return "Gemini hit its output limit before finishing its reply.";
		case "SAFETY":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "BLOCKLIST":
			return `Gemini stopped the reply (${reason.toLowerCase().replaceAll("_", " ")}).`;
		case "RECITATION":
			return "Gemini stopped the reply (it was reciting training data).";
		default:
			return `Gemini ended the reply early (${reason.toLowerCase()}).`;
	}
}

function readUsage(metadata: Record<string, unknown>): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
} {
	return {
		inputTokens: numberOf(metadata.promptTokenCount),
		outputTokens: numberOf(metadata.candidatesTokenCount),
		totalTokens: numberOf(metadata.totalTokenCount),
		cachedTokens: numberOf(metadata.cachedContentTokenCount),
	};
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toFunctionDeclarations(request: ByokStreamRequest): unknown[] {
	return request.tools.map((tool) => {
		const parameters = toGoogleSchema(tool.function.parameters);
		return {
			name: tool.function.name,
			description: tool.function.description,
			...(parameters ? { parameters } : {}),
		};
	});
}

/**
 * Gemini has two thinking knobs and they are not interchangeable: Gemini 3 is
 * driven by a named `thinkingLevel`, earlier models by a `thinkingBudget` in
 * tokens. `thinkingLevel` tops out at "high" - the API rejects "max" outright.
 */
export function googleThinkingConfig(
	request: ByokStreamRequest,
): Record<string, unknown> | null {
	if (
		!request.thinking ||
		!googleCapabilities(request.model).thinking_controls?.supported
	)
		return null;

	if (usesNativeAdaptiveThinking("google", request.model)) {
		const level = thinkingLevel(request.thinking);
		if (!level) return null;
		const mapped =
			level === "max" ||
			level === "xhigh" ||
			(level === "medium" && /^gemini-3-pro(?:$|-)/.test(request.model))
				? "high"
				: level;
		return { thinkingLevel: mapped };
	}

	const budget = thinkingBudgetTokens(request.thinking, "google");
	if (budget === null || budget <= 0) return null;
	const pro = /^gemini-2\.5-pro(?:$|-)/.test(request.model);
	const minimum = pro ? 128 : request.model.includes("flash-lite") ? 512 : 1;
	return {
		thinkingBudget: Math.min(pro ? 32768 : 24576, Math.max(minimum, budget)),
	};
}

/**
 * Gemini alternates `user` and `model` turns and has no tool role: results go
 * back as `user` content holding `functionResponse` parts.
 */
export function renderGoogleContents(
	messages: readonly ByokMessage[],
	model?: string,
): unknown[] {
	const out: unknown[] = [];
	// Names, not ids, key a functionResponse - resolve each result's name from
	// the call that produced it.
	const callNames = new Map<string, string>();

	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", parts: userParts(message) });
			continue;
		}
		if (message.role === "assistant") {
			const original = model
				? decodeProviderMetadata(message.providerMetadata, "google", model)
				: undefined;
			if (Array.isArray(original) && original.length > 0) {
				for (const call of message.toolCalls) callNames.set(call.id, call.name);
				out.push({ role: "model", parts: original });
				continue;
			}
			const parts: unknown[] = [];
			if (message.content) parts.push({ text: message.content });
			for (const call of message.toolCalls) {
				callNames.set(call.id, call.name);
				parts.push({
					functionCall: {
						name: call.name,
						args: call.input ?? {},
						...(isProviderCallId(call.id) ? { id: call.id } : {}),
					},
					...(!model && call.signature
						? { thoughtSignature: call.signature }
						: {}),
				});
			}
			if (parts.length > 0) out.push({ role: "model", parts });
			continue;
		}
		out.push({
			role: "user",
			parts: message.results.map((result) => ({
				functionResponse: {
					name: callNames.get(result.id) ?? result.name,
					...(isProviderCallId(result.id) ? { id: result.id } : {}),
					response: { result: result.output || "(no output)" },
				},
			})),
		});
	}
	return out;
}

/** Ids we minted are local bookkeeping; only Gemini's own may go back on the wire. */
function isProviderCallId(id: string): boolean {
	return !id.startsWith("gemini_call_");
}

function userParts(message: Extract<ByokMessage, { role: "user" }>): unknown[] {
	const parts: unknown[] = [];
	for (const attachment of message.attachments ?? []) {
		if (attachment.base64) {
			parts.push({
				inlineData: {
					mimeType: attachment.mediaType,
					data: attachment.base64,
				},
			});
		} else if (attachment.text) {
			parts.push({
				text: `Attached file ${attachment.path}:\n${attachment.text}`,
			});
		}
	}
	parts.push({ text: message.content || "(empty message)" });
	return parts;
}
