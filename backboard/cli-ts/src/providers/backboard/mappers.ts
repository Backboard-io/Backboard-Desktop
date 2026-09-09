import { toolInputFingerprint } from "../../core/tools/ToolCallIdentity.ts";
import { ToolCallProtocolGuard } from "../ToolCallProtocolGuard.ts";
import { BACKBOARD_STREAM_EVENTS } from "./constants.ts";
import { isRetryableStreamServerErrorMessage } from "./streamRetry.ts";
import type {
	BackboardContextUsage,
	BackboardStreamPayload,
	ContentDeltaResult,
	ProviderEvent,
	ProviderToolCall,
	RawToolCall,
	StreamMappingResult,
} from "./types.ts";

export function parseArguments(raw: string): unknown {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(
			"Tool protocol error: function arguments are not valid JSON",
		);
	}
}

export function mapToolCall(call: RawToolCall): ProviderToolCall {
	return {
		id: call.id,
		name: call.function.name,
		input: parseArguments(call.function.arguments),
	};
}

export interface ToolMappingTrace {
	phase: "mapped" | "raw";
	event: string;
	id?: string;
	index?: number;
	name?: string;
	inputFingerprint?: string;
	argumentBytes?: number;
}

export class BackboardStreamEventMapper {
	private readonly guard = new ToolCallProtocolGuard();
	private accumulatedContent = "";
	private accumulatedReasoning = "";
	private readonly streamedToolCalls = new Map<
		number,
		{ id?: string; name: string; announced: boolean }
	>();
	private readonly knownToolNames: ReadonlyMap<string, string>;
	private readonly provisionalToolCallPrefix =
		`backboard_stream_${nextStreamMapperId++}`;

	constructor(
		knownToolNames: readonly string[] = [],
		private readonly trace?: (event: ToolMappingTrace) => void,
		private readonly traceRaw = false,
	) {
		this.knownToolNames = new Map(
			knownToolNames.map((name) => [name.toLowerCase(), name]),
		);
	}

	map(payload: unknown): ProviderEvent[] {
		const result = mapStreamPayload(
			payload,
			this.accumulatedContent,
			this.accumulatedReasoning,
		);
		this.accumulatedContent = result.accumulatedContent;
		this.accumulatedReasoning = result.accumulatedReasoning;
		result.events.push(...this.mapRawToolCallDeltas(payload));
		return result.events.map((event) => {
			const calls =
				event.kind === "tool_started"
					? [{ id: event.id, name: event.name }]
					: event.kind === "tool_ready"
						? [event.call]
						: event.kind === "requires_action"
							? event.calls
							: [];
			for (const call of calls)
				this.trace?.({
					phase: "mapped",
					event: event.kind,
					id: call.id,
					name: call.name,
					...("input" in call
						? { inputFingerprint: toolInputFingerprint(call.input) }
						: {}),
				});
			return this.guard.accept(event);
		});
	}

	/**
	 * Backboard normally emits `tool_call_start`, but some OpenRouter models do
	 * not expose a real call id until their (potentially very large) arguments
	 * are complete. The transport still forwards their raw OpenAI-compatible
	 * `choices[].delta.tool_calls` chunks. Recognize the tool name there and
	 * publish a UI-only provisional start so a large Write shows its loading
	 * shell while the file body is being generated instead of minutes later.
	 *
	 * The authoritative `tool_submit_required` call keeps its real id. The
	 * early-tool round retracts this synthetic row during reconciliation; the
	 * agent-host mutation batch keeps both ids under one visual Write shell.
	 */
	private mapRawToolCallDeltas(payload: unknown): ProviderEvent[] {
		if (!isRecord(payload) || this.knownToolNames.size === 0) return [];
		const events: ProviderEvent[] = [];
		for (const root of nestedStreamRoots(payload)) {
			const choices = Array.isArray(root.choices) ? root.choices : [];
			for (const choice of choices) {
				if (
					!isRecord(choice) ||
					!isRecord(choice.delta) ||
					(typeof choice.index === "number" && choice.index !== 0)
				)
					continue;
				const calls = Array.isArray(choice.delta.tool_calls)
					? choice.delta.tool_calls
					: Array.isArray(choice.delta.toolCalls)
						? choice.delta.toolCalls
						: [];
				for (
					let fallbackIndex = 0;
					fallbackIndex < calls.length;
					fallbackIndex++
				) {
					const call = calls[fallbackIndex];
					if (!isRecord(call)) continue;
					const indexValue = call.index;
					const index =
						typeof indexValue === "number" && Number.isInteger(indexValue)
							? indexValue
							: fallbackIndex;
					const existing = this.streamedToolCalls.get(index) ?? {
						name: "",
						announced: false,
					};
					const id = stringField(call, "id");
					if (id && existing.id && existing.id !== id) {
						events.push({
							kind: "failed",
							error:
								"Tool protocol error: a raw tool-call index changed its real ID",
							retryable: false,
						});
						continue;
					}
					if (id) existing.id = id;
					const fn = isRecord(call.function) ? call.function : call;
					const nameFragment = stringField(fn, "name");
					const argumentsFragment = stringField(fn, "arguments");
					if (this.traceRaw)
						this.trace?.({
							phase: "raw",
							event: "tool_delta",
							index,
							...(id ? { id } : {}),
							...(nameFragment ? { name: nameFragment } : {}),
							...(argumentsFragment
								? {
										inputFingerprint: toolInputFingerprint(argumentsFragment),
										argumentBytes: new TextEncoder().encode(argumentsFragment)
											.byteLength,
									}
								: {}),
						});
					if (nameFragment) {
						existing.name = appendStreamedName(existing.name, nameFragment);
					}
					this.streamedToolCalls.set(index, existing);
					const knownName = this.knownToolNames.get(
						existing.name.toLowerCase(),
					);
					if (!existing.announced && knownName) {
						existing.announced = true;
						events.push({
							kind: "tool_started",
							id: existing.id ?? `${this.provisionalToolCallPrefix}_${index}`,
							name: knownName,
						});
					}
				}
			}
		}
		return events;
	}
}

let nextStreamMapperId = 0;

function nestedStreamRoots(
	payload: Record<string, unknown>,
): Record<string, unknown>[] {
	const roots = [payload];
	for (const key of ["data", "chunk"]) {
		const nested = payload[key];
		if (isRecord(nested)) roots.push(nested);
	}
	return roots;
}

function appendStreamedName(current: string, fragment: string): string {
	if (!current) return fragment;
	if (fragment.startsWith(current)) return fragment;
	if (current.endsWith(fragment)) return current;
	return current + fragment;
}

export function mapStreamPayloadToEvents(payload: unknown): ProviderEvent[] {
	return mapStreamPayload(payload, "", "").events;
}

function mapStreamPayload(
	payload: unknown,
	previousAccumulatedContent: string,
	previousAccumulatedReasoning: string,
): StreamMappingResult {
	if (!isBackboardStreamPayload(payload)) {
		return {
			events: [failedEvent("Backboard stream sent a non-object event")],
			accumulatedContent: previousAccumulatedContent,
			accumulatedReasoning: previousAccumulatedReasoning,
		};
	}

	const events: ProviderEvent[] = [];
	let accumulatedContent = previousAccumulatedContent;
	let accumulatedReasoning = previousAccumulatedReasoning;
	const threadId = stringField(payload, "thread_id");
	if (threadId) {
		events.push({ kind: "thread", threadId });
	}

	switch (payload.type) {
		case BACKBOARD_STREAM_EVENTS.userMessage:
			return { events, accumulatedContent, accumulatedReasoning };
		case BACKBOARD_STREAM_EVENTS.contentStreaming: {
			const content = normalizeStreamDelta(
				payload,
				accumulatedContent,
				"content",
				"accumulated_content",
			);
			accumulatedContent = content.accumulatedContent;
			const text = content.text;
			if (text) events.push({ kind: "assistant_delta", text });
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.reasoningStreaming:
		case BACKBOARD_STREAM_EVENTS.reasoningDelta: {
			// Reasoning rides its own accumulator: the backend interleaves
			// reasoning and content chunks, each cumulative within its channel.
			const reasoning = normalizeStreamDelta(
				payload,
				accumulatedReasoning,
				"content",
				"accumulated_reasoning",
			);
			accumulatedReasoning = reasoning.accumulatedContent;
			const text = reasoning.text;
			if (text) events.push({ kind: "reasoning_delta", text });
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.mediaGenerated:
			// Backboard's built-in image generation (image_generation: "auto").
			// The payload shape is provider-defined; the consumer extracts what
			// it can render.
			events.push({ kind: "media", payload });
			return { events, accumulatedContent, accumulatedReasoning };
		case BACKBOARD_STREAM_EVENTS.toolCallStart: {
			// Advisory early-render event; malformed frames are dropped, never fatal.
			const id = stringField(payload, "tool_call_id");
			const name = stringField(payload, "name");
			if (id && name) events.push({ kind: "tool_started", id, name });
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.toolCallReady: {
			// Advisory early-execution event; malformed frames are dropped.
			const rawCall = (payload as Record<string, unknown>).tool_call;
			if (isRawToolCall(rawCall)) {
				try {
					events.push({ kind: "tool_ready", call: mapToolCall(rawCall) });
				} catch {
					events.push({
						kind: "failed",
						error: "Tool protocol error: ready arguments are not valid JSON",
						retryable: false,
					});
				}
			}
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.toolSubmitRequired: {
			const rawCalls: unknown[] = Array.isArray(payload.tool_calls)
				? payload.tool_calls
				: [];
			let calls: ProviderToolCall[];
			try {
				calls = rawCalls.filter(isRawToolCall).map((call) => mapToolCall(call));
			} catch {
				events.push({
					kind: "failed",
					error: "Tool protocol error: final arguments are not valid JSON",
					retryable: false,
				});
				return { events, accumulatedContent, accumulatedReasoning };
			}
			if (rawCalls.length !== calls.length) {
				events.push({
					kind: "failed",
					error:
						"Tool protocol error: malformed final tool call; refusing a partial batch",
					retryable: false,
				});
			} else if (calls.length === 0) {
				events.push(
					failedEvent("Backboard requested tool outputs without tool calls"),
				);
			} else {
				// Tool-call legs carry provider usage too (each leg is a billed
				// LLM inference); emit it so per-call telemetry isn't limited to
				// completed runs.
				addUsageEvent(events, payload);
				events.push({
					kind: "requires_action",
					runId: stringField(payload, "run_id") ?? null,
					calls,
				});
			}
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.runEnded:
		case BACKBOARD_STREAM_EVENTS.messageComplete: {
			if (!isCompletedStatus(stringField(payload, "status"))) {
				events.push(
					failedEvent(
						stringField(payload, "error") ??
							stringField(payload, "message") ??
							"Backboard run did not complete",
					),
				);
				return { events, accumulatedContent, accumulatedReasoning };
			}
			const contextUsage = contextUsageField(payload);
			const usage = usageFromPayload(payload) ?? {
				backboardContextUsage: { source: "backboard-api" as const },
			};
			events.push({ kind: "usage", usage });
			events.push({
				kind: "completed",
				finalText:
					stringField(payload, "final_content") ??
					stringField(payload, "content") ??
					undefined,
				...(usage ? { usage } : {}),
				...(contextUsage ? { contextUsage } : {}),
			});
			return { events, accumulatedContent, accumulatedReasoning };
		}
		case BACKBOARD_STREAM_EVENTS.runFailed:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard run failed",
				),
			);
			return { events, accumulatedContent, accumulatedReasoning };
		case BACKBOARD_STREAM_EVENTS.runCancelled:
			events.push({ kind: "failed", error: "Backboard run was cancelled" });
			return { events, accumulatedContent, accumulatedReasoning };
		case BACKBOARD_STREAM_EVENTS.error:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard stream failed",
				),
			);
			return { events, accumulatedContent, accumulatedReasoning };
		default:
			return { events, accumulatedContent, accumulatedReasoning };
	}
}

function failedEvent(
	error: string,
): Extract<ProviderEvent, { kind: "failed" }> {
	const retryable = isRetryableStreamServerErrorMessage(error);
	return {
		kind: "failed",
		error,
		...(retryable ? { retryable: true } : {}),
	};
}

/**
 * Turns a possibly-cumulative stream chunk into a delta. Shared by the
 * content and reasoning channels, which carry the chunk in `textField` and
 * the channel's running total in `accumulatedField`.
 */
function normalizeStreamDelta(
	payload: BackboardStreamPayload,
	previousAccumulatedContent: string,
	textField: string,
	accumulatedField: string,
): ContentDeltaResult {
	const text = stringField(payload, textField);
	const accumulatedContent = stringField(payload, accumulatedField);
	if (accumulatedContent === null) {
		if (text?.startsWith(previousAccumulatedContent)) {
			const delta = text.slice(previousAccumulatedContent.length);
			return { text: delta || null, accumulatedContent: text };
		}
		return {
			text,
			accumulatedContent: previousAccumulatedContent + (text ?? ""),
		};
	}
	if (accumulatedContent.startsWith(previousAccumulatedContent)) {
		return {
			text: accumulatedContent.slice(previousAccumulatedContent.length),
			accumulatedContent,
		};
	}
	return {
		text: text ?? accumulatedContent,
		accumulatedContent,
	};
}

function addUsageEvent(
	events: ProviderEvent[],
	payload: Record<string, unknown>,
) {
	const usage = usageFromPayload(payload);
	if (!usage) return;
	events.push({ kind: "usage", usage });
}

function usageFromPayload(
	payload: Record<string, unknown>,
): Extract<ProviderEvent, { kind: "usage" }>["usage"] | null {
	const contextUsage = contextUsageField(payload);
	if (
		payload.input_tokens == null &&
		payload.output_tokens == null &&
		payload.total_tokens == null &&
		payload.model_name == null &&
		contextUsage === undefined
	) {
		return null;
	}
	return {
		inputTokens: numberField(payload, "input_tokens"),
		outputTokens: numberField(payload, "output_tokens"),
		totalTokens: numberField(payload, "total_tokens"),
		cachedTokens: numberField(payload, "cached_input_tokens"),
		cacheWriteTokens: numberField(payload, "cache_write_input_tokens"),
		costUsd: numberField(payload, "cost_usd"),
		backboardContextUsage: {
			source: "backboard-api",
			usedTokens: contextUsage?.used_tokens,
			contextLimit: contextUsage?.context_limit,
			percent: contextUsage?.percent,
			summaryTokens: contextUsage?.summary_tokens,
			model: contextUsage?.model,
		},
		contextTokens: contextUsage?.used_tokens,
		contextLimit: contextUsage?.context_limit,
		provider: stringField(payload, "model_provider") ?? undefined,
		model: stringField(payload, "model_name") ?? undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isBackboardStreamPayload(
	value: unknown,
): value is BackboardStreamPayload {
	return isRecord(value) && typeof value.type === "string";
}

export function isRawToolCall(value: unknown): value is RawToolCall {
	if (!isRecord(value) || value.type !== "function") return false;
	const fn = value.function;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		isRecord(fn) &&
		typeof fn.name === "string" &&
		fn.name.length > 0 &&
		typeof fn.arguments === "string"
	);
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function numberField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function contextUsageField(
	record: Record<string, unknown>,
): BackboardContextUsage | undefined {
	const value = record.context_usage;
	if (!isRecord(value)) return undefined;
	return {
		...(typeof value.used_tokens === "number"
			? { used_tokens: value.used_tokens }
			: {}),
		...(typeof value.context_limit === "number"
			? { context_limit: value.context_limit }
			: {}),
		...(typeof value.percent === "number" ? { percent: value.percent } : {}),
		...(typeof value.summary_tokens === "number"
			? { summary_tokens: value.summary_tokens }
			: {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
	};
}

function isCompletedStatus(status: string | null): boolean {
	return status === null || status.toLowerCase() === "completed";
}
