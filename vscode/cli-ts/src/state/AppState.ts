import type {
	AgentChildToolCall,
	AskUserRequest,
	TodoItem,
	UsageInfo,
} from "../core/bus/events.ts";
import type { ToolResultDetailLine } from "../core/tools/ToolResultDetail.ts";

export type TranscriptItem =
	| { kind: "user"; id: string; text: string }
	| {
			kind: "assistant";
			id: string;
			turnId: string;
			text: string;
			durationMs?: number;
	  }
	| {
			kind: "tool";
			id: string;
			name: string;
			inputSummary: string;
			status: "pending" | "running" | "done" | "error";
			agentMode?: "worker" | "rlm";
			childToolCalls?: AgentChildToolCall[];
			title?: string;
			detail?: string;
			detailLines?: ToolResultDetailLine[];
			error?: string;
	  }
	| { kind: "notice"; id: string; level: "info" | "error"; text: string };

export type RenderTranscriptItem =
	| TranscriptItem
	| {
			kind: "tool_group";
			id: string;
			name: string;
			items: Extract<TranscriptItem, { kind: "tool" }>[];
	  }
	| {
			kind: "assistant_chunk";
			id: string;
			turnId: string;
			text: string;
			showHeader: boolean;
	  }
	| {
			kind: "assistant_footer";
			id: string;
			turnId: string;
			durationMs: number;
	  };

export interface AssistantRenderStream {
	messageId: string;
	turnId: string;
	pendingText: string;
	committedText: string;
	chunkCount: number;
	showNextHeader: boolean;
}

export interface RenderState {
	staticItems: RenderTranscriptItem[];
	liveItems: RenderTranscriptItem[];
	assistantStreams: AssistantRenderStream[];
	generation: number;
}

export type RunStatus = "idle" | "running" | "cancelled";

export interface AppState {
	status: RunStatus;
	transcript: TranscriptItem[];
	render: RenderState;
	todos: TodoItem[];
	usage: UsageInfo;
	pendingAsk: AskUserRequest | null;
	model: string;
}

export function initialState(model: string): AppState {
	return {
		status: "idle",
		transcript: [],
		render: {
			staticItems: [],
			liveItems: [],
			assistantStreams: [],
			generation: 0,
		},
		todos: [],
		usage: {},
		pendingAsk: null,
		model,
	};
}
