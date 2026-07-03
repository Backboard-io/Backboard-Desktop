import type { AgentChildToolCall, AgentEvent } from "../core/bus/events.ts";
import { areTodosComplete } from "../core/todos/TodoList.ts";
import type { AgentToolOutput } from "../core/tools/AgentToolOutput.ts";
import { shortId } from "../utils/id.ts";
import { clampFlushLengthForOpenTable } from "../utils/markdownTable.ts";
import type {
	AppState,
	AssistantRenderStream,
	RenderTranscriptItem,
	TranscriptItem,
} from "./AppState.ts";
import { groupConsecutiveToolItems } from "./toolGrouping.ts";

const MAX_LIVE_ASSISTANT_CHARS = 800;
const TARGET_LIVE_ASSISTANT_CHARS = 400;

/**
 * Pure reducer mapping a bus event onto the next UI state. Keeping this pure
 * and separate from components means the entire UI projection is testable
 * without rendering anything.
 */
export function reduce(state: AppState, event: AgentEvent): AppState {
	switch (event.type) {
		case "user:message": {
			const item: TranscriptItem = {
				kind: "user",
				id: shortId("u"),
				text: event.text,
			};
			return pushCommitted(state, item);
		}

		case "turn:start":
			return {
				...state,
				status: "running",
				todos: areTodosComplete(state.todos) ? [] : state.todos,
			};

		case "assistant:delta":
			return appendAssistantDelta(
				upsertAssistant(
					state,
					event.turnId,
					event.messageId,
					event.text,
					"append",
				),
				event.turnId,
				event.messageId,
				event.text,
			);

		case "assistant:message":
			return finalizeAssistantMessage(
				upsertAssistant(
					state,
					event.turnId,
					event.messageId,
					event.text,
					"replace",
				),
				event.turnId,
				event.messageId,
				event.text,
			);

		// A buffered final answer that the verification nudge is about to
		// supersede. It never streamed (no assistant:delta was emitted for it),
		// so this just clears any stray live/stream bookkeeping for its id -
		// nothing was ever committed to staticItems, so there is nothing to
		// unprint.
		case "assistant:message:discard":
			return {
				...state,
				render: {
					...state.render,
					liveItems: state.render.liveItems.filter(
						(item) => item.id !== assistantLiveId(event.messageId),
					),
					assistantStreams: state.render.assistantStreams.filter(
						(stream) => stream.messageId !== event.messageId,
					),
				},
			};

		// The scheduler announces a whole round the moment its plan is built,
		// before any call executes. Rows render immediately (with the working
		// animation) and are upserted in place by the later tool:start.
		case "tool:pending": {
			if (event.name === "TodoWrite") return state;
			const item: TranscriptItem = {
				kind: "tool",
				id: event.toolCallId,
				name: event.name,
				inputSummary: event.inputSummary,
				status: "pending",
			};
			return pushLive(push(state, item), item);
		}

		case "tool:start": {
			if (event.name === "TodoWrite") return state;
			const item: TranscriptItem = {
				kind: "tool",
				id: event.toolCallId,
				name: event.name,
				inputSummary: event.inputSummary,
				status: "running",
				...(event.agentMode ? { agentMode: event.agentMode } : {}),
			};
			const exists = state.transcript.some(
				(candidate) => candidate.kind === "tool" && candidate.id === item.id,
			);
			const next = exists
				? updateTool(state, item.id, () => item)
				: push(state, item);
			return pushLive(next, item);
		}

		case "agent:child_tool_start": {
			const next = updateTool(state, event.agentToolCallId, (t) => ({
				...t,
				childToolCalls: upsertChildToolCall(t.childToolCalls ?? [], event.call),
			}));
			const tool = next.transcript.find(
				(item) => item.kind === "tool" && item.id === event.agentToolCallId,
			);
			return tool?.kind === "tool" ? pushLive(next, tool) : next;
		}

		case "agent:child_tool_result": {
			const next = updateTool(state, event.agentToolCallId, (t) => ({
				...t,
				childToolCalls: updateChildToolCall(
					t.childToolCalls ?? [],
					event.childToolCallId,
					event.status,
				),
			}));
			const tool = next.transcript.find(
				(item) => item.kind === "tool" && item.id === event.agentToolCallId,
			);
			return tool?.kind === "tool" ? pushLive(next, tool) : next;
		}

		case "tool:result": {
			const next = updateTool(state, event.toolCallId, (t) => ({
				...t,
				status: "done",
				title: event.title,
				agentMode: event.agentOutput?.mode ?? t.agentMode,
				detail: event.agentOutput
					? agentToolResultDetail(event.agentOutput)
					: event.detail,
				detailLines: event.detailLines,
			}));
			const tool = next.transcript.find(
				(item) => item.kind === "tool" && item.id === event.toolCallId,
			);
			return tool?.kind === "tool" ? completeLiveTool(next, tool) : next;
		}

		case "tool:error": {
			const next = updateTool(state, event.toolCallId, (t) => ({
				...t,
				status: "error",
				error: event.error,
			}));
			const tool = next.transcript.find(
				(item) => item.kind === "tool" && item.id === event.toolCallId,
			);
			if (tool?.kind === "tool") return completeLiveTool(next, tool);
			if (event.name === "TodoWrite") {
				return pushCommitted(next, {
					kind: "notice",
					id: shortId("n"),
					level: "error",
					text: `TodoWrite failed: ${event.error}`,
				});
			}
			return next;
		}

		case "todos:updated":
			return { ...state, todos: event.todos };

		case "usage":
			return { ...state, usage: { ...state.usage, ...event.usage } };

		case "system:warning": {
			const item: TranscriptItem = {
				kind: "notice",
				id: shortId("n"),
				level: "info",
				text: event.message,
			};
			return pushCommitted(state, item);
		}

		case "input:request":
			return { ...state, pendingAsk: event.request };

		case "input:response":
			return { ...state, pendingAsk: null };

		case "turn:cancelled":
			return drainCompletedLiveTools(
				{
					...state,
					status: "cancelled",
					pendingAsk: null,
					render: clearLiveAssistants(state.render),
				},
				{ force: true },
			);

		case "turn:end": {
			return appendAssistantFooter(
				updateAssistantTurnDuration(
					// Flush any tools still held live for grouping - nothing else
					// will complete this turn, so waiting further would strand them.
					drainCompletedLiveTools(
						{ ...state, status: "idle" },
						{
							force: true,
						},
					),
					event.turnId,
					event.durationMs,
				),
				event.turnId,
				event.durationMs,
			);
		}

		case "run:error": {
			const item: TranscriptItem = {
				kind: "notice",
				id: shortId("n"),
				level: "error",
				text: event.error,
			};
			return pushCommitted({ ...state, status: "idle" }, item);
		}

		default:
			return state;
	}
}

function upsertChildToolCall(
	calls: readonly AgentChildToolCall[],
	call: AgentChildToolCall,
): AgentChildToolCall[] {
	const index = calls.findIndex((candidate) => candidate.id === call.id);
	if (index === -1) return [...calls, call];
	const updated = [...calls];
	updated[index] = { ...updated[index], ...call };
	return updated;
}

function updateChildToolCall(
	calls: readonly AgentChildToolCall[],
	id: string,
	status: "done" | "error",
): AgentChildToolCall[] {
	return calls.map((call) => (call.id === id ? { ...call, status } : call));
}

function agentToolResultDetail(output: AgentToolOutput): string | undefined {
	if (!output.report.trim()) return undefined;
	const meta = [
		`mode: ${output.mode}`,
		`status: ${output.status}`,
		`rounds: ${output.rounds}`,
		output.tracePath ? `trace: ${output.tracePath}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const detail = `${meta}\n${output.report}`;
	return detail.length > 4_000
		? `${detail.slice(0, 4_000)}\n[truncated]`
		: detail;
}

function push(state: AppState, item: TranscriptItem): AppState {
	return { ...state, transcript: [...state.transcript, item] };
}

function pushCommitted(state: AppState, item: TranscriptItem): AppState {
	return {
		...state,
		transcript: [...state.transcript, item],
		render: {
			...state.render,
			staticItems: [...state.render.staticItems, item],
		},
	};
}

function pushLive(state: AppState, item: RenderTranscriptItem): AppState {
	return {
		...state,
		render: {
			...state.render,
			liveItems: upsertRenderItem(state.render.liveItems, item),
		},
	};
}

function completeLiveTool(
	state: AppState,
	item: Extract<TranscriptItem, { kind: "tool" }>,
): AppState {
	return drainCompletedLiveTools({
		...state,
		render: {
			...state.render,
			liveItems: upsertRenderItem(state.render.liveItems, item),
		},
	});
}

function drainCompletedLiveTools(
	state: AppState,
	options?: { force?: boolean },
): AppState {
	// While a same-name call is still running (parallel Read/Grep/... batch),
	// hold completed siblings live so they drain in one batch and collapse
	// into a single grouped entry. The static transcript is append-only, so
	// grouping is only possible for items committed together.
	const runningToolNames = new Set(
		state.render.liveItems.flatMap((item) =>
			item.kind === "tool" && isUnfinishedTool(item.status) ? [item.name] : [],
		),
	);
	let drainCount = 0;
	while (true) {
		const item = state.render.liveItems[drainCount];
		if (item?.kind !== "tool" || isUnfinishedTool(item.status)) break;
		if (!options?.force && runningToolNames.has(item.name)) break;
		drainCount++;
	}
	if (drainCount === 0) return state;
	return {
		...state,
		render: {
			...state.render,
			// Group within the drained batch only: earlier static entries are
			// already printed by <Static> and must not be rewritten.
			staticItems: [
				...state.render.staticItems,
				...groupConsecutiveToolItems(
					state.render.liveItems.slice(0, drainCount),
				),
			],
			liveItems: state.render.liveItems.slice(drainCount),
		},
	};
}

function isUnfinishedTool(
	status: Extract<TranscriptItem, { kind: "tool" }>["status"],
): boolean {
	return status === "pending" || status === "running";
}

function appendAssistantDelta(
	state: AppState,
	turnId: string,
	messageId: string,
	text: string,
): AppState {
	const stream = findOrCreateStream(
		state.render.assistantStreams,
		turnId,
		messageId,
	);
	const nextStream = {
		...stream,
		pendingText: stream.pendingText + text,
	};
	const { stream: flushedStream, chunks } = flushAssistantStream(nextStream);
	const streams = replaceStream(
		state.render.assistantStreams,
		stream,
		flushedStream,
	);
	return {
		...state,
		render: {
			...state.render,
			staticItems: [...state.render.staticItems, ...chunks],
			liveItems: state.render.liveItems.filter(
				(item) => item.id !== assistantLiveId(flushedStream.messageId),
			),
			assistantStreams: streams,
		},
	};
}

function finalizeAssistantMessage(
	state: AppState,
	turnId: string,
	messageId: string,
	text: string,
): AppState {
	const stream = state.render.assistantStreams.find(
		(candidate) => candidate.messageId === messageId,
	);
	const staticItems = [...state.render.staticItems];

	if (!stream) {
		if (text) {
			staticItems.push(assistantChunk(messageId, turnId, 0, text, true));
		}
		return {
			...state,
			render: {
				...state.render,
				staticItems,
				liveItems: state.render.liveItems.filter(
					(item) => item.id !== assistantLiveId(messageId),
				),
			},
		};
	}

	if (text.startsWith(stream.committedText)) {
		const remainingText = text.slice(stream.committedText.length);
		if (remainingText) {
			staticItems.push(
				assistantChunk(
					messageId,
					turnId,
					stream.chunkCount,
					remainingText,
					stream.showNextHeader,
				),
			);
		}
	} else if (text) {
		staticItems.push({
			kind: "notice",
			id: shortId("n"),
			level: "info",
			text: "Assistant response was corrected by the server; final content follows.",
		});
		staticItems.push(assistantChunk(messageId, turnId, 0, text, true));
	}

	return drainCompletedLiveTools({
		...state,
		render: {
			...state.render,
			staticItems,
			liveItems: state.render.liveItems.filter(
				(item) => item.id !== assistantLiveId(messageId),
			),
			assistantStreams: state.render.assistantStreams.filter(
				(candidate) => candidate.messageId !== messageId,
			),
		},
	});
}

function appendAssistantFooter(
	state: AppState,
	turnId: string,
	durationMs: number,
): AppState {
	const footerId = `${turnId}:assistant:footer`;
	if (state.render.staticItems.some((item) => item.id === footerId)) {
		return state;
	}
	const hasAssistantOutput = state.render.staticItems.some(
		(item) => item.kind === "assistant_chunk" && item.turnId === turnId,
	);
	if (!hasAssistantOutput) return state;
	return {
		...state,
		render: {
			...state.render,
			staticItems: [
				...state.render.staticItems,
				{ kind: "assistant_footer", id: footerId, turnId, durationMs },
			],
		},
	};
}

function clearLiveAssistants(render: AppState["render"]): AppState["render"] {
	return {
		...render,
		liveItems: render.liveItems.filter(
			(item) => item.kind !== "assistant_chunk",
		),
		assistantStreams: [],
	};
}

function flushAssistantStream(stream: AssistantRenderStream): {
	stream: AssistantRenderStream;
	chunks: RenderTranscriptItem[];
} {
	const flushLength = assistantFlushLength(stream.pendingText);
	if (flushLength <= 0) return { stream, chunks: [] };

	const text = stream.pendingText.slice(0, flushLength);
	const nextStream: AssistantRenderStream = {
		...stream,
		pendingText: stream.pendingText.slice(flushLength),
		committedText: stream.committedText + text,
		chunkCount: stream.chunkCount + 1,
		showNextHeader: false,
	};
	return {
		stream: nextStream,
		chunks: [
			assistantChunk(
				stream.messageId,
				stream.turnId,
				stream.chunkCount,
				text,
				stream.showNextHeader,
			),
		],
	};
}

function assistantFlushLength(text: string): number {
	return clampFlushLengthForOpenTable(
		text,
		rawAssistantFlushLength(text),
		MAX_LIVE_ASSISTANT_CHARS,
	);
}

// A markdown table's column widths depend on every row, so committing rows
// as separate static chunks would render it as broken fragments instead of
// one aligned table. `assistantFlushLength` clamps the cut point so an
// open (still-streaming) table is held back in `pendingText` and flushed
// whole once it closes — or once it outgrows MAX_LIVE_ASSISTANT_CHARS, so a
// malformed table that never closes can't buffer forever.
function rawAssistantFlushLength(text: string): number {
	const newlineIndex = text.lastIndexOf("\n");
	if (newlineIndex >= 0) return newlineIndex + 1;
	if (text.length <= MAX_LIVE_ASSISTANT_CHARS) return 0;

	const target = Math.max(0, text.length - TARGET_LIVE_ASSISTANT_CHARS);
	for (let index = target; index > 0; index--) {
		if (/\s/.test(text[index] ?? "")) return index + 1;
	}
	return target;
}

function findOrCreateStream(
	streams: AssistantRenderStream[],
	turnId: string,
	messageId: string,
): AssistantRenderStream {
	return (
		streams.find((candidate) => candidate.messageId === messageId) ?? {
			messageId,
			turnId,
			pendingText: "",
			committedText: "",
			chunkCount: 0,
			showNextHeader: true,
		}
	);
}

function replaceStream(
	streams: AssistantRenderStream[],
	previous: AssistantRenderStream,
	next: AssistantRenderStream,
): AssistantRenderStream[] {
	const index = streams.findIndex(
		(candidate) => candidate.messageId === previous.messageId,
	);
	if (index === -1) return [...streams, next];
	const updated = [...streams];
	updated[index] = next;
	return updated;
}

function upsertRenderItem(
	items: RenderTranscriptItem[],
	item: RenderTranscriptItem,
): RenderTranscriptItem[] {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return [...items, item];
	const updated = [...items];
	updated[index] = item;
	return updated;
}

function assistantChunk(
	messageId: string,
	turnId: string,
	index: number,
	text: string,
	showHeader: boolean,
): RenderTranscriptItem {
	return {
		kind: "assistant_chunk",
		id: `${messageId}:chunk:${index}`,
		turnId,
		text,
		showHeader,
	};
}

function assistantLiveId(messageId: string): string {
	return `${messageId}:live`;
}

function upsertAssistant(
	state: AppState,
	turnId: string,
	messageId: string,
	text: string,
	mode: "append" | "replace",
): AppState {
	const index = state.transcript.findIndex(
		(item) => item.kind === "assistant" && item.id === messageId,
	);
	if (index === -1) {
		return push(state, {
			kind: "assistant",
			id: messageId,
			turnId,
			text,
		});
	}

	const item = state.transcript[index];
	if (item?.kind !== "assistant") return state;
	const nextText = mode === "append" ? item.text + text : text;
	if (nextText === item.text) return state;

	const transcript = [...state.transcript];
	transcript[index] = {
		...item,
		text: nextText,
	};
	return { ...state, transcript };
}

function updateTool(
	state: AppState,
	id: string,
	fn: (t: Extract<TranscriptItem, { kind: "tool" }>) => TranscriptItem,
): AppState {
	return {
		...state,
		transcript: state.transcript.map((item) =>
			item.kind === "tool" && item.id === id ? fn(item) : item,
		),
	};
}

function updateAssistantTurnDuration(
	state: AppState,
	turnId: string,
	durationMs: number,
): AppState {
	return {
		...state,
		transcript: state.transcript.map((item) =>
			item.kind === "assistant" && item.turnId === turnId
				? { ...item, durationMs }
				: item,
		),
	};
}
