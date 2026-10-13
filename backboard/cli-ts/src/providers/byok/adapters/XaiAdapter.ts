/* Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. */
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../../backboard/types.ts";
import { ByokError, unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	credentialKey,
	type ProviderCredential,
} from "../ProviderCredential.ts";
import {
	decodeProviderMetadata,
	encodeProviderMetadata,
} from "../ProviderMetadata.ts";
import { thinkingEffort } from "../thinking.ts";

const API_BASE = "https://api.x.ai/v1";
interface XaiModel {
	id: string;
	aliases?: string[];
	input_modalities?: string[];
	output_modalities?: string[];
	context_length?: number;
}
interface XaiModels {
	models: XaiModel[];
}

/** Explicit tool-capable families; specialized hosted multi-agent models are excluded. */
export function isXaiToolModel(model: string): boolean {
	return (
		/^grok-(?:3(?:-mini)?|4(?:\.(?:1|20|5|6))?|code-fast-1)(?:$|-)/.test(
			model,
		) && !/multi-agent|image|audio|video/.test(model)
	);
}

function capabilities(model: string): Partial<ModelCatalogItem> {
	const efforts = /^grok-4\.(?:5|6)(?:$|-)/.test(model)
		? ["low", "medium", "high"]
		: /^grok-3-mini(?:$|-)/.test(model)
			? ["low", "high"]
			: [];
	return {
		supports_thinking: efforts.length > 0,
		supported_effort_levels: efforts,
		thinking_controls: {
			supported: efforts.length > 0,
			allowed_fields: efforts.length ? ["effort"] : [],
			defaults_only: efforts.length === 0,
		},
	};
}

export const xaiAdapter: ProviderAdapter = {
	id: "xai",
	label: "xAI",
	consoleUrl: "https://console.x.ai/",
	keyHint: "xai-…",
	looksLikeKey: (key) => /^xai-[\w-]{20,}$/.test(key.trim()),
	async validateKey(key, signal, transport) {
		await getJson<XaiModels>(
			`${API_BASE}/language-models`,
			headers(key),
			"xai",
			signal,
			key,
			transport,
		);
	},
	async listModels(key, signal, transport) {
		const response = await getJson<XaiModels>(
			`${API_BASE}/language-models`,
			headers(key),
			"xai",
			signal,
			key,
			transport,
		);
		const models = new Map<string, ModelCatalogItem>();
		for (const model of response.models ?? []) {
			if (
				!model.input_modalities?.includes("text") ||
				!model.output_modalities?.includes("text")
			)
				continue;
			for (const name of [model.id, ...(model.aliases ?? [])]) {
				if (!isXaiToolModel(name)) continue;
				models.set(name, {
					name,
					provider: "xai",
					model_type: "llm",
					context_limit: model.context_length ?? null,
					supports_vision: model.input_modalities.includes("image"),
					...capabilities(name),
				});
			}
		}
		return [...models.values()];
	},
	supportsThinking: (model) => capabilities(model).supports_thinking === true,
	modelCapabilities: capabilities,
	stream: (request, key) => streamXai(request, key),
};

function headers(key: ProviderCredential): Record<string, string> {
	return { Authorization: `Bearer ${credentialKey(key).trim()}` };
}

type ResponseItem = Record<string, unknown>;

/** Replay local history: no server-side response IDs, storage, or hosted tools. */
export function xaiInput(
	messages: readonly ByokMessage[],
	model: string,
): ResponseItem[] {
	const input: ResponseItem[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const content: ResponseItem[] = [];
			for (const attachment of message.attachments ?? []) {
				if (attachment.base64)
					content.push({
						type: "input_image",
						image_url: `data:${attachment.mediaType};base64,${attachment.base64}`,
					});
				else if (attachment.text)
					content.push({
						type: "input_text",
						text: `Attached file ${attachment.path}:\n${attachment.text}`,
					});
			}
			content.push({
				type: "input_text",
				text: message.content || "(empty message)",
			});
			input.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const original = decodeProviderMetadata(
				message.providerMetadata,
				"xai",
				model,
			);
			if (Array.isArray(original) && original.length) {
				input.push(...original);
				continue;
			}
			if (message.content)
				input.push({
					role: "assistant",
					content: [{ type: "output_text", text: message.content }],
				});
			for (const call of message.toolCalls)
				input.push({
					type: "function_call",
					call_id: call.id,
					name: call.name,
					arguments: JSON.stringify(call.input ?? {}),
				});
		} else {
			for (const result of message.results)
				input.push({
					type: "function_call_output",
					call_id: result.id,
					output: result.output || "(no output)",
				});
		}
	}
	return input;
}

async function* streamXai(
	request: ByokStreamRequest,
	key: ProviderCredential,
): AsyncIterable<ProviderEvent> {
	if (!isXaiToolModel(request.model)) {
		yield {
			kind: "failed",
			error: `The xAI model ${request.model} is not supported for agent tool calls. Select another xAI API Key model.`,
			retryable: false,
		};
		return;
	}
	const levels = capabilities(request.model).supported_effort_levels ?? [];
	const requestedEffort = thinkingEffort(request.thinking);
	const effort =
		requestedEffort && levels.includes(requestedEffort)
			? requestedEffort
			: undefined;
	const body = {
		model: request.model,
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		input: [
			{ role: "system", content: request.systemPrompt },
			...xaiInput(request.messages, request.model),
		],
		tools: request.tools.map((tool) => ({
			type: "function",
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
		})),
		...(effort ? { reasoning: { effort } } : {}),
		...(request.maxOutputTokens
			? { max_output_tokens: request.maxOutputTokens }
			: {}),
	};
	yield {
		kind: "thinking_resolved",
		requested: request.thinking,
		effective: { reasoning: effort ?? "provider-default" },
		provider: "xai",
		model: request.model,
		reason: "xai-model-capability-mapping",
	};
	const items = new Map<number, ResponseItem>();
	let terminal = false;
	for await (const event of postSseJson({
		url: `${API_BASE}/responses`,
		headers: headers(key),
		credential: key,
		transport: request.transport,
		provider: "xai",
		body,
		signal: request.signal,
	})) {
		const type = event.type;
		const index =
			typeof event.output_index === "number" ? event.output_index : 0;
		if (type === "response.output_text.delta") {
			if (typeof event.delta === "string")
				yield { kind: "assistant_delta", text: event.delta };
		} else if (
			type === "response.reasoning_summary_text.delta" ||
			type === "response.reasoning_text.delta"
		) {
			if (typeof event.delta === "string")
				yield { kind: "reasoning_delta", text: event.delta };
		} else if (
			type === "response.output_item.added" ||
			type === "response.output_item.done"
		) {
			const item = asRecord(event.item);
			if (item) {
				items.set(index, item);
				if (
					type === "response.output_item.added" &&
					item.type === "function_call" &&
					typeof item.call_id === "string" &&
					typeof item.name === "string"
				) {
					yield { kind: "tool_started", id: item.call_id, name: item.name };
				}
			}
		} else if (type === "response.function_call_arguments.delta") {
			const item = items.get(index);
			if (item && typeof event.delta === "string")
				item.arguments = `${typeof item.arguments === "string" ? item.arguments : ""}${event.delta}`;
			yield { kind: "activity" };
		} else if (type === "response.function_call_arguments.done") {
			const item = items.get(index);
			if (item && typeof event.arguments === "string")
				item.arguments = event.arguments;
		} else if (type === "response.completed") {
			const response = asRecord(event.response);
			if (!response || response.status !== "completed") {
				yield {
					kind: "failed",
					error: "xAI did not complete the response.",
					retryable: false,
				};
				return;
			}
			const output = Array.isArray(response?.output)
				? response.output
				: [...items.entries()]
						.sort(([a], [b]) => a - b)
						.map(([, item]) => item);
			const calls: ProviderToolCall[] = [];
			for (const value of output) {
				const item = asRecord(value);
				if (item?.type !== "function_call") continue;
				if (
					typeof item.call_id !== "string" ||
					typeof item.name !== "string" ||
					typeof item.arguments !== "string" ||
					!request.tools.some((tool) => tool.function.name === item.name)
				) {
					throw new ByokError(
						"xAI returned an invalid function call.",
						"xai",
						0,
						null,
					);
				}
				let args: unknown;
				try {
					args = JSON.parse(item.arguments);
				} catch {
					throw new ByokError(
						"xAI returned malformed function arguments.",
						"xai",
						0,
						null,
					);
				}
				if (
					!asRecord(args) ||
					!item.call_id ||
					calls.some((call) => call.id === item.call_id)
				)
					throw new ByokError(
						"xAI returned invalid or duplicate function arguments.",
						"xai",
						0,
						null,
					);
				calls.push({ id: item.call_id, name: item.name, input: args });
			}
			const rawUsage = asRecord(response?.usage);
			const details = asRecord(rawUsage?.input_tokens_details);
			const usage = {
				provider: "xai",
				model: request.model,
				inputTokens: number(rawUsage?.input_tokens),
				outputTokens: number(rawUsage?.output_tokens),
				totalTokens: number(rawUsage?.total_tokens),
				cachedTokens: number(details?.cached_tokens),
			};
			const providerMetadata = encodeProviderMetadata(
				"xai",
				request.model,
				output,
			);
			for (const call of calls) yield { kind: "tool_ready", call };
			if (calls.length) {
				yield { kind: "usage", usage };
				yield { kind: "requires_action", runId: null, calls, providerMetadata };
			} else {
				const finalText = output
					.flatMap((value) => {
						const item = asRecord(value);
						return item?.type === "message" && Array.isArray(item.content)
							? item.content.flatMap((part) => {
									const entry = asRecord(part);
									return entry?.type === "output_text" &&
										typeof entry.text === "string"
										? [entry.text]
										: [];
								})
							: [];
					})
					.join("");
				yield {
					kind: "completed",
					usage,
					providerMetadata,
					...(finalText ? { finalText } : {}),
				};
			}
			terminal = true;
			return;
		} else if (
			type === "response.failed" ||
			type === "response.incomplete" ||
			type === "error" ||
			event.error
		) {
			const response = asRecord(event.response);
			const error = asRecord(event.error ?? response?.error);
			yield {
				kind: "failed",
				error:
					typeof error?.message === "string"
						? error.message
						: "xAI could not complete the response.",
				retryable: false,
			};
			return;
		} else {
			yield { kind: "activity" };
		}
	}
	if (!terminal)
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("xai"),
			retryable: true,
		};
}

function asRecord(value: unknown): ResponseItem | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as ResponseItem)
		: undefined;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
