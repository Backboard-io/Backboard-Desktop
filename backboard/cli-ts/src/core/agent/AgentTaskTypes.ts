import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import type { ToolExecutionMetadata } from "../tools/ToolFailure.ts";
import type {
	WorkerIntegrationStatus,
	WorkerWorkspaceProgress,
} from "../workspaces/WorkerWorkspaceTypes.ts";

export type AgentTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface AgentTaskResultBundle {
	data: AgentToolOutput;
	forLLM: string;
	title: string;
	detail?: string;
	completedAt: string;
}

export type AgentExecutionStatus =
	| "queued"
	| "preparing"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface AgentTaskRecord {
	/** Monotonic public lifecycle revision; legacy records begin at zero. */
	revision?: number;
	parentBatchToolCallId?: string;
	executionStatus?: AgentExecutionStatus;
	integrationStatus?: WorkerIntegrationStatus;
	workspace?: WorkerWorkspaceProgress;
	/** Effective declaration; actual tools still enforce inherited permissions. */
	capabilities?: { readOnly: boolean; permissionMode?: string };
	handle: string;
	sessionId: string;
	turnId?: string;
	prompt: string;
	/** Cosmetic display label; handles remain authoritative. */
	name?: string;
	/** Canonical full input and workspace identity for idempotent replay. */
	inputFingerprint?: string;
	readOnly: boolean;
	status: AgentTaskStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	result?: AgentTaskResultBundle;
	error?: string;
	/** Typed terminal failure evidence, separate from the worker's report prose. */
	execution?: ToolExecutionMetadata;
	/** Captured result is available, but its durable write failed; never rerun it automatically. */
	persistenceError?: string;
}

export const AGENT_TASK_STORE_VERSION = 1;

export interface AgentTaskStoreData {
	version: typeof AGENT_TASK_STORE_VERSION;
	tasks: AgentTaskRecord[];
}

/** Content-free result projection: reports remain available through AgentWait. */
export type AgentWorkerState = Omit<
	AgentTaskRecord,
	"result" | "inputFingerprint" | "execution"
>;
