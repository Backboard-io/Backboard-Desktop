import { errorMessage } from "../../utils/errors.ts";
import type { GitWorktreeManager } from "./GitWorktreeManager.ts";
import type { WorkerWorkspaceStore } from "./WorkerWorkspaceStore.ts";
import type { WorkerWorkspaceRecord } from "./WorkerWorkspaceTypes.ts";

/** Integrates one captured worker result while preserving conflict state. */
export class WorkerIntegrationManager {
	constructor(
		private readonly git: GitWorktreeManager,
		private readonly store: WorkerWorkspaceStore,
	) {}

	async integrate(
		record: WorkerWorkspaceRecord,
		signal?: AbortSignal,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		if (
			record.executionStatus !== "completed" ||
			!record.startingCommit ||
			!record.resultCommit
		) {
			return this.persist(
				{ ...record, integrationStatus: "skipped" },
				onProgress,
			);
		}
		const startingCommit = record.startingCommit;
		const resultCommit = record.resultCommit;
		if (signal?.aborted) {
			return this.persist(
				{
					...record,
					executionStatus: "cancelled",
					integrationStatus: "skipped",
					error: "Cancelled before integration.",
				},
				onProgress,
			);
		}

		let current = await this.persist(
			{ ...record, integrationStatus: "integrating" },
			onProgress,
		);
		try {
			const result = await this.git.integrate({
				coordinatorCwd: current.coordinatorCwd,
				startingCommit,
				resultCommit,
				signal,
			});
			if (signal?.aborted) {
				throw new Error(
					"Cancelled before worker integration could be finalized.",
				);
			}
			if (result.status === "conflict") {
				return this.persist(
					{
						...current,
						integrationStatus: "conflict",
						conflictingFiles: result.conflictingFiles,
						error:
							result.conflictingFiles.length > 0
								? `Integration conflict in ${result.conflictingFiles.join(", ")}`
								: "Integration stopped with a Git merge in progress.",
					},
					onProgress,
				);
			}
			current = {
				...current,
				integrationStatus: "integrated",
				integrationCommit: result.commit,
				integratedAt: new Date().toISOString(),
				conflictingFiles: undefined,
				error: undefined,
			};
			return this.persist(current, onProgress);
		} catch (error) {
			return this.persist(
				{
					...current,
					...(signal?.aborted ? { executionStatus: "cancelled" as const } : {}),
					integrationStatus: signal?.aborted ? "skipped" : "pending",
					error: errorMessage(error),
				},
				onProgress,
			);
		}
	}

	async reconcile(
		record: WorkerWorkspaceRecord,
	): Promise<WorkerWorkspaceRecord> {
		if (!record.resultCommit) return record;
		if (await this.git.isAncestor(record.coordinatorCwd, record.resultCommit)) {
			const info = await this.git.inspect(record.coordinatorCwd);
			return this.persist({
				...record,
				integrationStatus: "integrated",
				integrationCommit: info?.head,
				integratedAt: record.integratedAt ?? new Date().toISOString(),
				conflictingFiles: undefined,
				error: undefined,
			});
		}
		if (await this.git.mergeInProgress(record.coordinatorCwd)) {
			return this.persist({
				...record,
				integrationStatus: "conflict",
				conflictingFiles: await this.git.conflictingFiles(
					record.coordinatorCwd,
				),
			});
		}
		return this.persist({
			...record,
			integrationStatus: "pending",
			conflictingFiles: undefined,
		});
	}

	private async persist(
		record: WorkerWorkspaceRecord,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		await this.store.upsert(record);
		onProgress?.(record);
		return record;
	}
}
