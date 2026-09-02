import type { AgentTraceStore } from "../agent/AgentTraceStore.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { AskUserQuestionSpec, TodoItem } from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import type { LspService } from "../lsp/index.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type {
	MutationCheckpointBatch,
	MutationDiagnosticsBatch,
} from "./MutationBatchCoordinator.ts";

export type AskUserFn = (
	question: string,
	options: string[],
	signal?: AbortSignal,
) => Promise<string>;

/**
 * Ask several related questions in a single interruption. Returns one answer
 * per question, aligned by index with the input.
 */
export type AskQuestionsFn = (
	questions: AskUserQuestionSpec[],
) => Promise<string[]>;

export interface ToolTraceContext {
	forToolCall(toolCallId: string): ToolTraceContext;
	createAgentTrace(input: {
		mode: "worker" | "rlm";
		prompt: string;
	}): Promise<AgentTraceStore | null>;
}

/** Internal scheduler hand-off that preserves provider order at path-lock registration. */
export interface MutationLockTurn {
	wait(): Promise<void>;
	advance(): void;
}

/**
 * Everything a tool needs to do its job, and nothing more. Passed to every
 * `Tool.execute`. The `signal` aborts in-flight work on turn cancellation; the
 * `askUser` bridge round-trips an interactive question through the UI.
 */
export interface ToolContext {
	sessionId: string;
	turnId?: string;
	toolCallId?: string;
	/** Concurrent calls in the scheduler batch; used to coalesce durability I/O. */
	mutationBatchSize?: number;
	mutationLockTurn?: MutationLockTurn;
	/** Explicit disjoint-wave checkpoint barrier owned by the scheduler. */
	mutationCheckpointBatch?: MutationCheckpointBatch;
	/** One post-commit diagnostics barrier shared by the mutation round. */
	mutationDiagnosticsBatch?: MutationDiagnosticsBatch;
	cwd: string;
	/**
	 * Native worktree root for an isolated worker. Write-capable tools must
	 * reject paths outside this boundary even when permission mode is bypass.
	 */
	isolatedWorkspaceRoot?: string;
	/**
	 * Private scratch/cache directory shared by every shell command in one
	 * isolated worker. It is removed when the worker finishes, so parallel
	 * commands can reuse package caches without leaking temp directories.
	 */
	isolatedScratchRoot?: string;
	/** Token inherited by every process in one isolated worker. */
	isolatedProcessToken?: string;
	bus: EventBus;
	signal: AbortSignal;
	askUser: AskUserFn;
	/**
	 * Ask a batch of related questions in one prompt. Optional: contexts that
	 * only implement `askUser` still work — callers fall back to asking each
	 * question sequentially.
	 */
	askQuestions?: AskQuestionsFn;
	getTodos?: () => readonly TodoItem[];
	agentDepth?: number;
	trace?: ToolTraceContext;
	/** Optional language-server service for post-edit diagnostics. */
	lsp?: LspService;
	/** Optional pre-image journal powering /undo, /redo and /rewind. */
	checkpoints?: CheckpointRecorder;
	/** Permission state for this session. Absent = permission gate disabled. */
	permissions?: PermissionContext;
}
