import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import type { FileEditPreview } from "../tools/ToolResult.ts";
import type { ToolResultDetailLine } from "../tools/ToolResultDetail.ts";

export type TurnStatus =
	| "in_progress"
	| "requires_action"
	| "completed"
	| "failed"
	| "cancelled";

export interface ToolCallRef {
	id: string;
	name: string;
	input: unknown;
}

interface ToolPendingEvent {
	type: "tool:pending";
	toolCallId: string;
	name: string;
	inputSummary: string;
}

interface ToolStartEvent {
	type: "tool:start";
	toolCallId: string;
	name: string;
	inputSummary: string;
	agentMode?: "worker" | "rlm";
}

interface ToolResultEvent {
	type: "tool:result";
	toolCallId: string;
	name: string;
	title: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	fileEdits?: FileEditPreview[];
	agentOutput?: AgentToolOutput;
}

export interface AgentChildToolCall {
	id: string;
	name: string;
	inputSummary: string;
	status: "running" | "done" | "error";
}

export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	model?: string;
	provider?: string;
}

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface AskUserRequest {
	id: string;
	question: string;
	options: string[];
}

export interface AskUserResponse {
	id: string;
	answer: string;
}

export interface PermissionRequest {
	id: string;
	toolCallId: string;
	name: string;
	inputSummary: string;
}

export interface PermissionResponse {
	id: string;
	decision: "approve" | "deny";
	reason?: string;
}

/**
 * The single source of truth for everything that happens in a run. The agent
 * loop and scheduler publish these; the UI and the client event log are pure
 * subscribers. Adding a new event means adding a member here and nothing else
 * structurally changes.
 */
export type AgentEvent =
	| { type: "session:created"; sessionId: string; threadId: string | null }
	| { type: "user:message"; text: string }
	| { type: "turn:start"; turnId: string }
	| { type: "turn:status"; phase: "preparing" | "generating" }
	| { type: "assistant:delta"; turnId: string; messageId: string; text: string }
	| { type: "assistant:reasoning"; turnId: string; text: string }
	| {
			type: "assistant:message";
			turnId: string;
			messageId: string;
			text: string;
	  }
	| { type: "assistant:message:discard"; turnId: string; messageId: string }
	| { type: "tool:requested"; turnId: string; calls: ToolCallRef[] }
	| ToolPendingEvent
	| ToolStartEvent
	| { type: "tool:progress"; toolCallId: string; data: unknown }
	| {
			type: "agent:child_tool_start";
			agentToolCallId: string;
			call: AgentChildToolCall;
	  }
	| {
			type: "agent:child_tool_result";
			agentToolCallId: string;
			childToolCallId: string;
			status: "done" | "error";
	  }
	| ToolResultEvent
	| { type: "tool:error"; toolCallId: string; name: string; error: string }
	| {
			type: "turn:end";
			turnId: string;
			status: TurnStatus;
			durationMs: number;
	  }
	| { type: "turn:cancelled"; turnId: string }
	| { type: "input:request"; request: AskUserRequest }
	| { type: "input:response"; response: AskUserResponse }
	| { type: "permission:request"; request: PermissionRequest }
	| { type: "permission:response"; response: PermissionResponse }
	| { type: "todos:updated"; todos: TodoItem[] }
	| { type: "usage"; usage: UsageInfo }
	| { type: "system:warning"; message: string }
	| { type: "run:error"; error: string };

export type AgentEventType = AgentEvent["type"];
