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

function parseArguments(raw: string): unknown {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return { __raw: raw };
	}
}

export function mapToolCall(call: RawToolCall): ProviderToolCall {
	return {
		id: call.id,
		name: call.function.name,
		input: parseArguments(call.function.arguments),
	};
}

export class BackboardStreamEventMapper {
	private accumulatedContent = "";
	private accumulatedReasoning = "";
	private lastContentChunk = "";
	private lastReasoningChunk = "";

	map(payload: unknown): ProviderEvent[] {
		const result = mapStreamPayload(
			payload,
			this.accumulatedContent,
			this.accumulatedReasoning,
			this.lastContentChunk,
			this.lastReasoningChunk,
		);
		this.accumulatedContent = result.accumulatedContent;
		this.accumulatedReasoning = result.accumulatedReasoning;
		this.lastContentChunk = result.lastContentChunk;
		this.lastReasoningChunk = result.lastReasoningChunk;
		return result.events;
	}
}

export function mapStreamPayloadToEvents(payload: unknown): ProviderEvent[] {
	return mapStreamPayload(payload, "", "", "", "").events;
}

function mapStreamPayload(
	payload: unknown,
	previousAccumulatedContent: string,
	previousAccumulatedReasoning: string,
	previousContentChunk: string,
	previousReasoningChunk: string,
): StreamMappingResult {
	if (!isBackboardStreamPayload(payload)) {
		return {
			events: [failedEvent("Backboard stream sent a non-object event")],
			accumulatedContent: previousAccumulatedContent,
			accumulatedReasoning: previousAccumulatedReasoning,
			lastContentChunk: previousContentChunk,
			lastReasoningChunk: previousReasoningChunk,
		};
	}

	const events: ProviderEvent[] = [];
	let accumulatedContent = previousAccumulatedContent;
	let accumulatedReasoning = previousAccumulatedReasoning;
	let lastContentChunk = previousContentChunk;
	let lastReasoningChunk = previousReasoningChunk;
	const done = (): StreamMappingResult => ({
		events,
		accumulatedContent,
		accumulatedReasoning,
		lastContentChunk,
		lastReasoningChunk,
	});
	const threadId = stringField(payload, "thread_id");
	if (threadId) {
		events.push({ kind: "thread", threadId });
	}

	switch (payload.type) {
		case BACKBOARD_STREAM_EVENTS.userMessage:
			return done();
		case BACKBOARD_STREAM_EVENTS.messageReceived:
		case BACKBOARD_STREAM_EVENTS.runStarted:
			// Server acknowledged the request and is assembling the run (thread
			// creation, prompt/tool wiring) — no model output yet.
			events.push({ kind: "status", phase: "preparing" });
			return done();
		case BACKBOARD_STREAM_EVENTS.messageStart:
			// The assistant message container opened: the model is engaged and
			// the first token is imminent.
			events.push({ kind: "status", phase: "generating" });
			return done();
		case BACKBOARD_STREAM_EVENTS.contentStreaming: {
			const content = normalizeStreamText(
				stringField(payload, "content"),
				stringField(payload, "accumulated_content"),
				accumulatedContent,
				lastContentChunk,
			);
			accumulatedContent = content.accumulatedContent;
			lastContentChunk = content.lastChunk;
			const text = suppressDsmlMarkup(content.text, accumulatedContent);
			if (text) events.push({ kind: "assistant_delta", text });
			return done();
		}
		case BACKBOARD_STREAM_EVENTS.reasoningStreaming:
		case BACKBOARD_STREAM_EVENTS.reasoningDelta: {
			const reasoning = normalizeStreamText(
				stringField(payload, "content"),
				stringField(payload, "accumulated_reasoning"),
				accumulatedReasoning,
				lastReasoningChunk,
			);
			accumulatedReasoning = reasoning.accumulatedContent;
			lastReasoningChunk = reasoning.lastChunk;
			const text = reasoning.text;
			if (text) events.push({ kind: "reasoning_delta", text });
			return done();
		}
		case BACKBOARD_STREAM_EVENTS.toolSubmitRequired: {
			const rawCalls: unknown[] = Array.isArray(payload.tool_calls)
				? payload.tool_calls
				: [];
			const calls = rawCalls
				.filter(isRawToolCall)
				.map((call) => mapToolCall(call));
			if (calls.length === 0) {
				events.push(
					failedEvent("Backboard requested tool outputs without tool calls"),
				);
			} else {
				events.push({
					kind: "requires_action",
					runId: stringField(payload, "run_id") ?? null,
					calls,
				});
			}
			return done();
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
				return done();
			}
			addUsageEvent(events, payload);
			const contextUsage = contextUsageField(payload);
			const usage = usageFromPayload(payload);
			const rawFinalText =
				stringField(payload, "final_content") ??
				stringField(payload, "content") ??
				undefined;
			events.push({
				kind: "completed",
				finalText:
					rawFinalText === undefined
						? undefined
						: stripDsmlMarkup(rawFinalText),
				...(usage ? { usage } : {}),
				...(contextUsage ? { contextUsage } : {}),
			});
			return done();
		}
		case BACKBOARD_STREAM_EVENTS.runFailed:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard run failed",
				),
			);
			return done();
		case BACKBOARD_STREAM_EVENTS.runCancelled:
			events.push({ kind: "failed", error: "Backboard run was cancelled" });
			return done();
		case BACKBOARD_STREAM_EVENTS.error:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard stream failed",
				),
			);
			return done();
		default:
			return done();
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
 * Marker DeepSeek-family models use for native tool-call tokens. The backend
 * normally converts these into `tool_submit_required` frames, but its parser
 * can fail on complex arguments and leak the raw tokens into
 * `content_streaming` — which must never render as assistant prose.
 */
const DSML_MARKER = "<｜DSML｜";

/** Duplicate frames shorter than this may be legitimate token repeats. */
const DUPLICATE_CHUNK_MIN_LENGTH = 8;

function longestCommonPrefixLength(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) {
		i++;
	}
	return i;
}

/**
 * Normalizes one streaming frame into the newly produced text. Handles every
 * shape the backend has been observed to send: plain incremental chunks, a
 * cumulative `accumulated` field, whole-message cumulative `content`,
 * re-sent duplicate frames, and segment-cumulative `content` that restarts
 * mid-message (seen around tool-call parse failures) — without ever
 * re-emitting text that was already emitted.
 */
function normalizeStreamText(
	text: string | null,
	cumulative: string | null,
	previousAccumulated: string,
	previousChunk: string,
): ContentDeltaResult {
	if (cumulative !== null) {
		if (cumulative.startsWith(previousAccumulated)) {
			return {
				text: cumulative.slice(previousAccumulated.length) || null,
				accumulatedContent: cumulative,
				lastChunk: text ?? "",
			};
		}
		// The backend's accumulation diverged from ours (e.g. it rewrote or
		// restarted the message). Adopt it as truth and emit only what lies
		// beyond the longest common prefix — never the whole blob again.
		const lcp = longestCommonPrefixLength(cumulative, previousAccumulated);
		return {
			text: cumulative.slice(lcp) || null,
			accumulatedContent: cumulative,
			lastChunk: text ?? "",
		};
	}
	if (text === null) {
		return {
			text: null,
			accumulatedContent: previousAccumulated,
			lastChunk: previousChunk,
		};
	}
	// A re-sent copy of the previous frame produces nothing new. Short chunks
	// are exempt: a model can legitimately emit the same small token twice.
	if (text.length >= DUPLICATE_CHUNK_MIN_LENGTH && text === previousChunk) {
		return {
			text: null,
			accumulatedContent: previousAccumulated,
			lastChunk: previousChunk,
		};
	}
	// Whole-message cumulative frame: `content` carries everything so far.
	if (previousAccumulated.length > 0 && text.startsWith(previousAccumulated)) {
		return {
			text: text.slice(previousAccumulated.length) || null,
			accumulatedContent: text,
			lastChunk: text,
		};
	}
	// Segment-cumulative frame: `content` strictly extends the previous frame
	// rather than the whole message (the backend restarted its accumulation).
	// An exact repeat of a short chunk is NOT an extension — it falls through
	// to the incremental branch so legitimate token repeats still stream.
	if (
		previousChunk.length > 0 &&
		text.length > previousChunk.length &&
		text.startsWith(previousChunk)
	) {
		const delta = text.slice(previousChunk.length);
		return {
			text: delta || null,
			accumulatedContent: previousAccumulated + delta,
			lastChunk: text,
		};
	}
	// Plain incremental chunk.
	return {
		text,
		accumulatedContent: previousAccumulated + text,
		lastChunk: text,
	};
}

/**
 * Removes leaked DSML tool-call markup from an outgoing content delta. The
 * emitted `text` is always a suffix of `accumulated`, so everything at or
 * after the first marker occurrence in the accumulated message is suppressed
 * for the remainder of the message.
 */
function suppressDsmlMarkup(
	text: string | null,
	accumulated: string,
): string | null {
	if (!text) {
		return text;
	}
	const markerIndex = accumulated.indexOf(DSML_MARKER);
	if (markerIndex === -1) {
		return text;
	}
	const emittedStart = accumulated.length - text.length;
	const visible = text.slice(0, Math.max(0, markerIndex - emittedStart));
	return visible || null;
}

/** Truncates leaked DSML tool-call markup out of a finalized message text. */
export function stripDsmlMarkup(text: string): string {
	const markerIndex = text.indexOf(DSML_MARKER);
	return markerIndex === -1 ? text : text.slice(0, markerIndex).trimEnd();
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
	if (
		payload.input_tokens == null &&
		payload.output_tokens == null &&
		payload.total_tokens == null &&
		payload.model_name == null
	) {
		return null;
	}
	return {
		inputTokens: numberField(payload, "input_tokens"),
		outputTokens: numberField(payload, "output_tokens"),
		totalTokens: numberField(payload, "total_tokens"),
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

function isRawToolCall(value: unknown): value is RawToolCall {
	if (!isRecord(value) || value.type !== "function") return false;
	const fn = value.function;
	return (
		typeof value.id === "string" &&
		isRecord(fn) &&
		typeof fn.name === "string" &&
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
