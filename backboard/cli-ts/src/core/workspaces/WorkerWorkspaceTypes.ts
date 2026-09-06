export type WorkerExecutionStatus =
	| "creating"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type WorkerIntegrationStatus =
	| "not_required"
	| "pending"
	| "integrating"
	| "integrated"
	| "conflict"
	| "skipped";

export type WorkerWorktreeDisposition = "present" | "removed_clean_terminal";

export interface WorkerIntegrationContent {
	contentPath: string;
	sha256: string;
	byteLength: number;
	mode: number;
}

/** Exact coordinator delta; an absent side means the file did not exist. */
export interface WorkerIntegrationChange {
	filePath: string;
	before?: WorkerIntegrationContent;
	after?: WorkerIntegrationContent;
}

/** Private capture boundary shared by native Git and snapshot integration. */
export interface WorkerIntegrationChangeBytes {
	filePath: string;
	before?: { content: Buffer; mode: number };
	after?: { content: Buffer; mode: number };
}

export interface WorkerWorkspaceRecord {
	workerId: string;
	/** Monotonic workspace-store revision. Absent only in legacy records. */
	revision?: number;
	name?: string;
	sequence: number;
	parentSessionId: string;
	parentToolCallId?: string;
	taskPrompt: string;
	readOnly: boolean;
	coordinatorCwd: string;
	/** Private baseline for plain folders or current dirty repository bytes. */
	backend?: "snapshot";
	snapshotNotice?: string;
	/** Backboard created the local repository/baseline needed for isolation. */
	repositoryInitializedByBackboard?: boolean;
	repositoryRoot?: string;
	branch?: string;
	worktreePath?: string;
	/**
	 * A clean terminal worker is removed eagerly and must not be recreated during
	 * recovery or unarchive. This covers failed/cancelled no-op workers and
	 * successfully integrated workers. Undefined is treated as `present` for
	 * version-1 records written before this field existed.
	 */
	worktreeDisposition?: WorkerWorktreeDisposition;
	worktreeCleanedAt?: string;
	startingCommit?: string;
	resultCommit?: string;
	changedFiles: string[];
	conflictingFiles?: string[];
	startedAt: string;
	finishedAt?: string;
	executionStatus: WorkerExecutionStatus;
	integrationStatus: WorkerIntegrationStatus;
	integratedAt?: string;
	integrationCommit?: string;
	/** Durable pre-commit/apply capture; never presented as an applied edit. */
	integrationPlan?: {
		resultCommit: string;
		baseCommit?: string;
		afterTree?: string;
		changes: WorkerIntegrationChange[];
	};
	/** Undefined means no exact capture is available; [] is a verified no-op. */
	integrationChanges?: WorkerIntegrationChange[];
	error?: string;
}

export interface WorkerWorkspaceProgress {
	workerId: string;
	revision?: number;
	executionStatus?: WorkerExecutionStatus;
	integrationStatus?: WorkerIntegrationStatus;
	integrationChanges?: WorkerIntegrationChange[];
	name?: string;
	status:
		| "Running"
		| "Completed"
		| "Failed"
		| "Cancelled"
		| "Integrating"
		| "Integrated"
		| "Conflict";
	branch?: string;
	worktreePath?: string;
	changedFileCount: number;
	startedAt: string;
	finishedAt?: string;
	integrationResult?: string;
	conflictingFiles?: string[];
}

export interface WorkerWorkspaceRunParams {
	workerId: string;
	name?: string;
	parentSessionId: string;
	parentToolCallId?: string;
	taskPrompt: string;
	readOnly: boolean;
	coordinatorCwd: string;
	signal: AbortSignal;
	onProgress?: (record: WorkerWorkspaceRecord) => void;
	onTiming?: (
		phase:
			| "worker_queued"
			| "worktree_ready"
			| "result_capture"
			| "integration",
		durationMs: number,
	) => void;
}

export interface PreparedWorkerWorkspace {
	record: WorkerWorkspaceRecord;
	cwd: string;
	isolated: boolean;
	signal: AbortSignal;
}

export interface WorkerRunOutcome<T> {
	result: T;
	workspace: WorkerWorkspaceRecord;
}

export const WORKER_WORKSPACE_STORE_VERSION = 1;

export interface WorkerWorkspaceStoreData {
	version: typeof WORKER_WORKSPACE_STORE_VERSION;
	workers: WorkerWorkspaceRecord[];
}

export function workerProgress(
	record: WorkerWorkspaceRecord,
): WorkerWorkspaceProgress {
	let status: WorkerWorkspaceProgress["status"];
	if (record.integrationStatus === "integrating") status = "Integrating";
	else if (record.integrationStatus === "integrated") status = "Integrated";
	else if (record.integrationStatus === "conflict") status = "Conflict";
	else if (record.executionStatus === "completed") status = "Completed";
	else if (record.executionStatus === "failed") status = "Failed";
	else if (record.executionStatus === "cancelled") status = "Cancelled";
	else status = "Running";

	return {
		workerId: record.workerId,
		revision: record.revision ?? 0,
		executionStatus: record.executionStatus,
		integrationStatus: record.integrationStatus,
		integrationChanges:
			record.integrationStatus === "integrated"
				? structuredClone(record.integrationChanges)
				: undefined,
		...(record.name ? { name: record.name } : {}),
		status,
		branch: record.branch,
		worktreePath:
			record.worktreeDisposition === "removed_clean_terminal"
				? undefined
				: record.worktreePath,
		changedFileCount: record.changedFiles.length,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		integrationResult: integrationResult(record),
		conflictingFiles: record.conflictingFiles,
	};
}

function integrationResult(record: WorkerWorkspaceRecord): string | undefined {
	switch (record.integrationStatus) {
		case "integrated":
			return record.integrationCommit
				? `Integrated as ${record.integrationCommit}`
				: "Integrated";
		case "conflict":
			return `Conflict${record.conflictingFiles?.length ? ` in ${record.conflictingFiles.join(", ")}` : ""}`;
		case "skipped":
			return "Not integrated";
		case "pending":
			return "Waiting to integrate";
		default:
			return undefined;
	}
}
