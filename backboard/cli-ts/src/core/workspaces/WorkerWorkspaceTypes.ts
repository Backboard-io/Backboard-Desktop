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

export interface WorkerWorkspaceRecord {
	workerId: string;
	sequence: number;
	parentSessionId: string;
	parentToolCallId?: string;
	taskPrompt: string;
	readOnly: boolean;
	coordinatorCwd: string;
	/** Backboard created the local repository/baseline needed for isolation. */
	repositoryInitializedByBackboard?: boolean;
	repositoryRoot?: string;
	branch?: string;
	worktreePath?: string;
	/**
	 * A terminal no-op worker is removed eagerly and must not be recreated during
	 * recovery or unarchive. Undefined is treated as `present` for version-1
	 * records written before this field existed.
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
	error?: string;
}

export interface WorkerWorkspaceProgress {
	workerId: string;
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
	parentSessionId: string;
	parentToolCallId?: string;
	taskPrompt: string;
	readOnly: boolean;
	coordinatorCwd: string;
	signal: AbortSignal;
	onProgress?: (record: WorkerWorkspaceRecord) => void;
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
