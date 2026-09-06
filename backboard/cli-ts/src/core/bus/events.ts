import type { AgentWorkerState } from "../agent/AgentTaskTypes.ts";
import type { PermissionMode } from "../permissions/PermissionMode.ts";
import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import type { ToolExecutionMetadata } from "../tools/ToolFailure.ts";
import type {
	FileEditPreview,
	TerminalToolResult,
} from "../tools/ToolResult.ts";
import type { ToolResultDetailLine } from "../tools/ToolResultDetail.ts";
import type { BackboardToolUiData } from "../tools/ToolUiData.ts";
import type { WorkerWorkspaceProgress } from "../workspaces/WorkerWorkspaceTypes.ts";

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
	toolUi?: BackboardToolUiData;
}

interface ToolStartEvent {
	type: "tool:start";
	toolCallId: string;
	name: string;
	inputSummary: string;
	agentMode?: "worker" | "rlm";
	toolUi?: BackboardToolUiData;
}

interface ToolResultEvent {
	type: "tool:result";
	execution?: ToolExecutionMetadata;
	toolCallId: string;
	name: string;
	title: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	fileEdits?: FileEditPreview[];
	terminalOutput?: TerminalToolResult;
	agentOutput?: AgentToolOutput;
	toolUi?: BackboardToolUiData;
}

/** Incremental terminal bytes emitted while an Execute tool is running. */
export interface TerminalToolProgressData {
	kind: "terminal-output";
	text: string;
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
	cachedTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	contextTokens?: number;
	contextLimit?: number;
	model?: string;
	provider?: string;
}

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface AskUserQuestionSpec {
	/** Short title shown in the breadcrumb at the top of the prompt. */
	header?: string;
	question: string;
	options: string[];
}

export interface AskUserRequest {
	id: string;
	questions: AskUserQuestionSpec[];
}

export interface AskUserResponse {
	id: string;
	/** One answer per question, aligned by index with `request.questions`. */
	answers: string[];
}

export type PerformanceTimingPhase =
	| "provider_first_event"
	| "provider_first_visible"
	| "provider_stream_total"
	| "provider_tool_announcement"
	| "provider_tool_batch_finalize"
	| "permission_wait"
	| "mutation_prepare"
	| "checkpoint_pre_flush"
	| "filesystem_commit"
	| "checkpoint_post_flush"
	| "diagnostics"
	| "worker_queued"
	| "worktree_ready"
	| "worker_model"
	| "result_capture"
	| "integration"
	| "ui_event_projection";

/**
 * The single source of truth for everything that happens in a run. The agent
 * loop and scheduler publish these; the UI and the client event log are pure
 * subscribers. Adding a new event means adding a member here and nothing else
 * structurally changes.
 */
export type AgentEvent =
	| { type: "agent:worker_update"; agentToolCallId: string; parentBatchToolCallId?: string; worker: AgentWorkerState }
	| { type: "session:created"; sessionId: string; threadId: string | null }
	| { type: "user:message"; text: string }
	| { type: "turn:start"; turnId: string }
	| {
			type: "turn:status";
			turnId: string;
			phase: "preparing" | "generating";
	  }
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
	| {
			type: "tool:identity";
			sessionId: string;
			turnId?: string;
			roundId: string;
			attempt: number;
			toolCallId: string;
			phase: "announce" | "ready" | "final" | "reuse" | "mismatch" | "result";
			name: string;
			inputFingerprint?: string;
			previousName?: string;
			previousInputFingerprint?: string;
			reason?: string;
	  }
	| ToolPendingEvent
	// A previously announced (tool:pending) call that will never execute:
	// its stream attempt was retried, or the authoritative call list never
	// confirmed it. Subscribers should drop the row.
	| { type: "tool:retracted"; toolCallId: string }
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
	| {
			type: "agent:child_start";
			agentName?: string;
			agentToolCallId: string;
			childSessionId: string;
			prompt: string;
			workspace?: WorkerWorkspaceProgress;
	  }
	| {
			type: "agent:child_status";
			agentToolCallId: string;
			workspace: WorkerWorkspaceProgress;
	  }
	| { type: "agent:parallel_status"; count: number }
	| {
			type: "agent:child_event";
			agentToolCallId: string;
			event: AgentEvent;
	  }
	| {
			type: "agent:child_end";
			agentToolCallId: string;
			status: TurnStatus;
	  }
	| ToolResultEvent
	| {
			type: "tool:error";
			toolCallId: string;
			name: string;
			error: string;
			execution?: ToolExecutionMetadata;
	  }
	| {
			type: "turn:end";
			turnId: string;
			status: TurnStatus;
			durationMs: number;
	  }
	| { type: "turn:cancelled"; turnId: string }
	| {
			type: "checkpoint:restored";
			checkpointId: string;
			files: number;
			skipped: number;
	  }
	| { type: "input:request"; request: AskUserRequest }
	| { type: "input:response"; response: AskUserResponse }
	// A client-provided tool call awaiting execution by the connected IDE.
	// The IDE runs the tool and answers with a `clientToolResult` control op.
	| {
			type: "client_tool:call";
			toolCallId: string;
			name: string;
			input: unknown;
	  }
	| { type: "permission:mode"; mode: PermissionMode }
	| { type: "todos:updated"; todos: TodoItem[] }
	| { type: "usage"; usage: UsageInfo }
	| {
			type: "performance:timing";
			phase: PerformanceTimingPhase;
			durationMs: number;
			toolCallId?: string;
			workerId?: string;
			fileCount?: number;
	  }
	| {
			type: "notification:run";
			notificationId: string;
			turnId: string;
			stage: "start" | "end";
			durationMs?: number;
			successfulMutations: number;
			unvalidatedMutations: number;
			validationFailed: boolean;
	  }
	| { type: "system:warning"; message: string }
	| {
			type: "provider:diagnostic";
			provider: string;
			phase: string;
			details: Record<string, unknown>;
	  }
	| { type: "runtime:identity"; identity: Record<string, unknown> }
	| {
			type: "thinking:resolved";
			phase: string;
			model: string;
			provider: string;
			intent: unknown;
			resolved: unknown;
			reason: string;
			promptHash?: string;
			schemaHash?: string;
	  }
	| {
			type: "thinking:wire";
			requested: unknown;
			effective: Record<string, unknown>;
			reason: string;
			model: string;
			provider: string;
	  }
	| { type: "run:error"; error: string };

export type AgentEventType = AgentEvent["type"];
