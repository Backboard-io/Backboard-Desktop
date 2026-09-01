import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import {
	type GitRepositoryInfo,
	type GitResultCommit,
	GitWorktreeManager,
	workerBranchName,
} from "./GitWorktreeManager.ts";
import { WorkerIntegrationManager } from "./WorkerIntegrationManager.ts";
import type { WorkerWorkspaceStore } from "./WorkerWorkspaceStore.ts";
import type {
	PreparedWorkerWorkspace,
	WorkerRunOutcome,
	WorkerWorkspaceRecord,
	WorkerWorkspaceRunParams,
} from "./WorkerWorkspaceTypes.ts";

export interface WorkerWorkspaceManagerOptions {
	parentSessionId: string;
	store: WorkerWorkspaceStore;
	git?: GitWorktreeManager;
	maxWorkers?: number;
	/** Defaults to true so arbitrary folders can use native worktree isolation. */
	autoInitializeGit?: boolean;
	now?: () => Date;
}

export class WorkerWorkspaceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerWorkspaceUnavailableError";
	}
}

/** Owns isolated worker creation, capture, deterministic integration, and cleanup. */
export class WorkerWorkspaceManager {
	private readonly git: GitWorktreeManager;
	private readonly integration: WorkerIntegrationManager;
	private readonly maxWorkers: number;
	private readonly autoInitializeGit: boolean;
	private readonly now: () => Date;
	private readonly records = new Map<string, WorkerWorkspaceRecord>();
	private readonly activeControllers = new Map<string, AbortController>();
	private readonly activeOperations = new Set<Promise<unknown>>();
	private initialization?: Promise<void>;
	private creationTail: Promise<void> = Promise.resolve();
	private integrationTail: Promise<void> = Promise.resolve();
	private nextSequence = 0;
	private integrationBlocked = false;

	constructor(private readonly options: WorkerWorkspaceManagerOptions) {
		this.git = options.git ?? new GitWorktreeManager();
		this.integration = new WorkerIntegrationManager(this.git, options.store);
		this.maxWorkers = clampMaxWorkers(options.maxWorkers ?? 4);
		this.autoInitializeGit = options.autoInitializeGit ?? true;
		this.now = options.now ?? (() => new Date());
	}

	initialize(): Promise<void> {
		this.initialization ??= this.recover();
		return this.initialization;
	}

	async runWorker<T extends { status: string }>(
		params: WorkerWorkspaceRunParams,
		run: (workspace: PreparedWorkerWorkspace) => Promise<T>,
	): Promise<WorkerRunOutcome<T>> {
		await this.initialize();
		if (params.parentSessionId !== this.options.parentSessionId) {
			throw new WorkerWorkspaceUnavailableError(
				`Worker session mismatch: expected ${this.options.parentSessionId}, received ${params.parentSessionId}.`,
			);
		}
		if (this.activeControllers.size >= this.maxWorkers) {
			throw new WorkerWorkspaceUnavailableError(
				`Parallel worker limit reached (${this.maxWorkers}). Wait for an active worker to finish.`,
			);
		}
		if (this.records.has(params.workerId)) {
			throw new WorkerWorkspaceUnavailableError(
				`Worker id is already present in this session: ${params.workerId}`,
			);
		}

		const controller = new AbortController();
		this.activeControllers.set(params.workerId, controller);
		const signal = AbortSignal.any([params.signal, controller.signal]);
		const operation = this.runWorkerOperation(
			{ ...params, signal },
			run,
		).finally(() => {
			this.activeControllers.delete(params.workerId);
			this.activeOperations.delete(operation);
		});
		this.activeOperations.add(operation);
		return operation;
	}

	cancelAll(): void {
		for (const controller of this.activeControllers.values())
			controller.abort();
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.activeOperations]);
		await this.integrationTail;
		await this.options.store.flush();
	}

	async archive(): Promise<string[]> {
		await this.initialize();
		await this.waitForIdle();
		return this.cleanupWorktrees();
	}

	async delete(): Promise<string[]> {
		this.cancelAll();
		await this.initialize();
		await this.waitForIdle();
		return this.cleanupWorktrees();
	}

	async unarchive(): Promise<WorkerWorkspaceRecord[]> {
		await this.initialize();
		for (const record of this.sortedRecords()) {
			if (record.worktreeDisposition === "removed_clean_terminal") continue;
			if (
				record.readOnly ||
				!record.repositoryRoot ||
				!record.branch ||
				!record.worktreePath
			) {
				continue;
			}
			if (!this.isOwnedWorktree(record)) {
				record.executionStatus = "failed";
				record.integrationStatus = "skipped";
				record.error =
					"Refusing to restore worker metadata that does not name this session's deterministic branch and worktree path.";
				await this.persist(record);
				continue;
			}
			if (
				!(await this.git.branchExists(record.repositoryRoot, record.branch))
			) {
				record.executionStatus = "failed";
				record.integrationStatus = "skipped";
				record.error = `Cannot restore worker because branch is missing: ${record.branch}`;
				await this.persist(record);
				continue;
			}
			try {
				await this.git.recreateWorktree({
					repositoryRoot: record.repositoryRoot,
					path: record.worktreePath,
					branch: record.branch,
				});
			} catch (error) {
				record.error = `Could not restore worker worktree; preserved path ${record.worktreePath}: ${errorMessage(error)}`;
				await this.persist(record);
			}
		}
		return this.sortedRecords();
	}

	list(): WorkerWorkspaceRecord[] {
		return this.sortedRecords().map(cloneRecord);
	}

	private async runWorkerOperation<T extends { status: string }>(
		params: WorkerWorkspaceRunParams,
		run: (workspace: PreparedWorkerWorkspace) => Promise<T>,
	): Promise<WorkerRunOutcome<T>> {
		const workspace = await this.prepare(params);
		let result: T;
		try {
			result = await run(workspace);
		} catch (error) {
			await this.finishWithoutIntegration(
				workspace.record,
				workspace.signal.aborted ? "cancelled" : "failed",
				errorMessage(error),
				params.onProgress,
			);
			throw error;
		}

		if (result.status !== "completed" || workspace.signal.aborted) {
			const status =
				workspace.signal.aborted || result.status === "cancelled"
					? "cancelled"
					: "failed";
			const record = await this.finishWithoutIntegration(
				workspace.record,
				status,
				result.status === "completed"
					? "Cancelled before result capture."
					: undefined,
				params.onProgress,
			);
			return { result, workspace: record };
		}

		if (workspace.record.readOnly) {
			const record = await this.persist(
				{
					...workspace.record,
					executionStatus: "completed",
					integrationStatus: "not_required",
					finishedAt: this.now().toISOString(),
				},
				params.onProgress,
			);
			return { result, workspace: record };
		}

		const start = workspace.record.startingCommit;
		const worktreePath = workspace.record.worktreePath;
		if (!start || !worktreePath) {
			throw new Error(
				"Isolated worker metadata is incomplete after execution.",
			);
		}
		let captured: GitResultCommit;
		try {
			captured = await this.git.captureResultCommit({
				worktreePath,
				workerId: workspace.record.workerId,
				startingCommit: start,
				signal: workspace.signal,
			});
		} catch (error) {
			await this.finishWithoutIntegration(
				workspace.record,
				workspace.signal.aborted ? "cancelled" : "failed",
				errorMessage(error),
				params.onProgress,
			);
			throw error;
		}
		const completed = await this.persist(
			{
				...workspace.record,
				executionStatus: "completed",
				integrationStatus: "pending",
				resultCommit: captured.resultCommit,
				changedFiles: captured.changedFiles,
				finishedAt: this.now().toISOString(),
			},
			params.onProgress,
		);
		const integrated = await this.enqueueCapturedResult(
			completed,
			params.onProgress,
		);
		return { result, workspace: integrated };
	}

	private async prepare(
		params: WorkerWorkspaceRunParams,
	): Promise<PreparedWorkerWorkspace> {
		const sequence = this.nextSequence++;
		let record: WorkerWorkspaceRecord = {
			workerId: params.workerId,
			sequence,
			parentSessionId: params.parentSessionId,
			parentToolCallId: params.parentToolCallId,
			taskPrompt: params.taskPrompt,
			readOnly: params.readOnly,
			coordinatorCwd: params.coordinatorCwd,
			changedFiles: [],
			startedAt: this.now().toISOString(),
			executionStatus: "creating",
			integrationStatus: params.readOnly ? "not_required" : "pending",
		};
		this.records.set(record.workerId, record);
		await this.persist(record, params.onProgress);

		if (params.readOnly) {
			record = await this.persist(
				{ ...record, executionStatus: "running" },
				params.onProgress,
			);
			return {
				record,
				cwd: params.coordinatorCwd,
				isolated: false,
				signal: params.signal,
			};
		}

		let repository: GitRepositoryInfo | null = null;
		const create = this.creationTail.then(async () => {
			const existing = await this.git.inspect(
				params.coordinatorCwd,
				params.signal,
			);
			if (existing) {
				repository = existing;
			} else if (!this.autoInitializeGit) {
				throw new WorkerWorkspaceUnavailableError(
					"Git is required for isolated parallel writes. Automatic repository initialization is disabled, so this worker was not started.",
				);
			} else {
				try {
					const ensured = await this.git.ensureRepository(
						params.coordinatorCwd,
						params.signal,
					);
					repository = ensured.repository;
					if (ensured.initialized) {
						record = await this.persist(
							{ ...record, repositoryInitializedByBackboard: true },
							params.onProgress,
						);
					}
				} catch (error) {
					throw new WorkerWorkspaceUnavailableError(
						`Backboard could not initialize Git for isolated parallel writes: ${errorMessage(error)}`,
					);
				}
			}
			const branch = workerBranchName(
				this.options.parentSessionId,
				params.workerId,
			);
			const worktreePath = workerWorktreePath(
				repository.repositoryRoot,
				this.options.parentSessionId,
				params.workerId,
			);
			record = await this.persist(
				{
					...record,
					coordinatorCwd: repository.coordinatorRoot,
					repositoryRoot: repository.repositoryRoot,
					branch,
					worktreePath,
					worktreeDisposition: "present",
					startingCommit: repository.head,
				},
				params.onProgress,
			);
			await this.git.createWorktree({
				repositoryRoot: repository.repositoryRoot,
				path: worktreePath,
				branch,
				startCommit: repository.head,
				signal: params.signal,
			});
		});
		this.creationTail = create.then(
			() => undefined,
			() => undefined,
		);
		try {
			await create;
		} catch (error) {
			record = await this.finishWithoutIntegration(
				record,
				params.signal.aborted ? "cancelled" : "failed",
				errorMessage(error),
				params.onProgress,
			);
			throw error;
		}
		record = await this.persist(
			{ ...record, executionStatus: "running" },
			params.onProgress,
		);
		return {
			record,
			cwd: record.worktreePath ?? params.coordinatorCwd,
			isolated: true,
			signal: params.signal,
		};
	}

	/**
	 * Adds a durable result to the shared Git mutation queue only after capture.
	 * This makes integration order match worker completion order: an unfinished
	 * earlier worker cannot reserve the head of the queue and block ready work.
	 *
	 * The execution signal deliberately stops at the capture boundary. Once the
	 * result commit exists and is persisted, a later Stop must not downgrade the
	 * completed worker or make its durable result ineligible for integration.
	 */
	private enqueueCapturedResult(
		record: WorkerWorkspaceRecord,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		const result = this.integrationTail.then(async () => {
			if (this.integrationBlocked) {
				return this.persist(
					{
						...record,
						integrationStatus: "pending",
						error:
							"Integration is waiting for another worker conflict to be resolved.",
					},
					onProgress,
				);
			}
			const integrated = await this.integration.integrate(
				record,
				undefined,
				onProgress,
			);
			this.records.set(integrated.workerId, integrated);
			if (integrated.integrationStatus === "conflict") {
				this.integrationBlocked = true;
			}
			return integrated;
		});
		this.integrationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async finishWithoutIntegration(
		record: WorkerWorkspaceRecord,
		status: "failed" | "cancelled",
		error: string | undefined,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		let changedFiles = record.changedFiles;
		if (!record.readOnly && record.worktreePath) {
			try {
				// Inspect without the cancelled worker signal: execution has settled,
				// and preserving an accurate recovery path must not be skipped merely
				// because Stop initiated this final bookkeeping step.
				changedFiles = await this.git.changedFiles(record.worktreePath);
			} catch {
				// A partially-created or externally removed worktree still retains all
				// previously known metadata and the original execution error.
			}
		}
		const terminal = await this.persist(
			{
				...record,
				changedFiles,
				executionStatus: status,
				integrationStatus: record.readOnly ? "not_required" : "skipped",
				finishedAt: this.now().toISOString(),
				error,
			},
			onProgress,
		);
		return this.cleanupTransientTerminalWorktree(terminal, onProgress);
	}

	private async recover(): Promise<void> {
		const records = await this.options.store.load();
		for (const record of records.sort((a, b) => a.sequence - b.sequence)) {
			this.records.set(record.workerId, record);
			this.nextSequence = Math.max(this.nextSequence, record.sequence + 1);
			if (record.readOnly) continue;
			if (record.worktreeDisposition === "removed_clean_terminal") continue;
			if (!record.repositoryRoot || !record.branch || !record.worktreePath) {
				record.executionStatus = "failed";
				record.integrationStatus = "skipped";
				record.error =
					"Interrupted before the isolated worktree was fully described.";
				await this.persist(record);
				continue;
			}
			if (!this.isOwnedWorktree(record)) {
				record.executionStatus = "failed";
				record.integrationStatus = "skipped";
				record.error =
					"Saved worker metadata does not match this session's deterministic branch and worktree path; it was preserved without touching the filesystem.";
				await this.persist(record);
				continue;
			}
			if (
				!(await this.git.branchExists(record.repositoryRoot, record.branch))
			) {
				record.executionStatus = "failed";
				record.integrationStatus = "skipped";
				record.error = `Saved worker branch is missing: ${record.branch}`;
				await this.persist(record);
				continue;
			}
			try {
				await this.git.recreateWorktree({
					repositoryRoot: record.repositoryRoot,
					path: record.worktreePath,
					branch: record.branch,
				});
			} catch (error) {
				record.error = `Could not recover worker worktree; preserved path ${record.worktreePath}: ${errorMessage(error)}`;
				await this.persist(record);
				if (
					record.executionStatus === "creating" ||
					record.executionStatus === "running"
				) {
					await this.finishWithoutIntegration(record, "failed", record.error);
				}
				continue;
			}
			if (isTransientTerminalWorker(record)) {
				await this.cleanupTransientTerminalWorktree(record);
				continue;
			}
			if (
				record.executionStatus === "creating" ||
				record.executionStatus === "running"
			) {
				await this.finishWithoutIntegration(
					record,
					"failed",
					"Worker execution was interrupted by process shutdown.",
				);
				continue;
			}
			if (
				record.executionStatus === "completed" &&
				(record.integrationStatus === "integrating" ||
					record.integrationStatus === "conflict")
			) {
				const reconciled = await this.integration.reconcile(record);
				this.records.set(record.workerId, reconciled);
				if (reconciled.integrationStatus === "conflict") {
					this.integrationBlocked = true;
				}
			}
		}

		if (!this.integrationBlocked) {
			const pending = this.sortedRecords()
				.filter(
					(record) =>
						record.executionStatus === "completed" &&
						record.integrationStatus === "pending",
				)
				.sort(compareCompletionOrder);
			for (const record of pending) {
				const integrated = await this.integration.integrate(record);
				this.records.set(record.workerId, integrated);
				if (integrated.integrationStatus === "conflict") {
					this.integrationBlocked = true;
					break;
				}
			}
		}
	}

	private async cleanupWorktrees(): Promise<string[]> {
		const preserved: string[] = [];
		for (const savedRecord of this.sortedRecords()) {
			let record = savedRecord;
			if (!record.worktreePath || record.readOnly) continue;
			if (record.worktreeDisposition === "removed_clean_terminal") continue;
			if (!this.isOwnedWorktree(record)) {
				preserved.push(record.worktreePath);
				continue;
			}
			if (isTransientTerminalWorker(record)) {
				record = await this.cleanupTransientTerminalWorktree(record);
				if (record.worktreeDisposition === "removed_clean_terminal") continue;
			}
			const worktreePath = record.worktreePath;
			if (!worktreePath) continue;
			if (
				record.integrationStatus !== "integrated" ||
				record.executionStatus !== "completed" ||
				!record.repositoryRoot
			) {
				preserved.push(worktreePath);
				continue;
			}
			try {
				await this.git.removeCheckpointRefs(
					record.repositoryRoot,
					record.parentSessionId,
					record.workerId,
				);
				const removed = await this.git.removeWorktreeIfClean({
					repositoryRoot: record.repositoryRoot,
					coordinatorCwd: record.coordinatorCwd,
					worktreePath,
				});
				if (!removed) preserved.push(worktreePath);
			} catch (error) {
				record.error = `Cleanup preserved worker worktree ${worktreePath}: ${errorMessage(error)}`;
				await this.persist(record);
				preserved.push(worktreePath);
			}
		}
		return preserved;
	}

	/**
	 * Removes a failed/cancelled worker only when there is provably no result to
	 * recover: no captured result commit, a clean worktree, and HEAD still at the
	 * worker's starting commit. Dirty or manually committed work is preserved.
	 */
	private async cleanupTransientTerminalWorktree(
		record: WorkerWorkspaceRecord,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		if (
			!isTransientTerminalWorker(record) ||
			record.worktreeDisposition === "removed_clean_terminal" ||
			!record.repositoryRoot ||
			!record.worktreePath ||
			!record.startingCommit ||
			!this.isOwnedWorktree(record)
		) {
			return record;
		}

		try {
			const inspected = await this.git.inspect(record.worktreePath);
			if (
				!inspected ||
				resolve(inspected.repositoryRoot) !== resolve(record.repositoryRoot) ||
				inspected.head !== record.startingCommit
			) {
				return record;
			}
			const removed = await this.git.removeWorktreeIfClean({
				repositoryRoot: record.repositoryRoot,
				coordinatorCwd: record.coordinatorCwd,
				worktreePath: record.worktreePath,
				expectedHead: record.startingCommit,
			});
			if (!removed) return record;

			let cleaned = await this.persist(
				{
					...record,
					changedFiles: [],
					worktreeDisposition: "removed_clean_terminal",
					worktreeCleanedAt: this.now().toISOString(),
				},
				onProgress,
			);
			try {
				await this.git.removeCheckpointRefs(
					record.repositoryRoot,
					record.parentSessionId,
					record.workerId,
				);
			} catch (error) {
				cleaned = await this.persist(
					{
						...cleaned,
						error: appendCleanupError(
							cleaned.error,
							`Removed clean terminal worker, but checkpoint cleanup failed: ${errorMessage(error)}`,
						),
					},
					onProgress,
				);
			}
			return cleaned;
		} catch (error) {
			return this.persist(
				{
					...record,
					error: appendCleanupError(
						record.error,
						`Clean terminal worker was preserved because cleanup failed: ${errorMessage(error)}`,
					),
				},
				onProgress,
			);
		}
	}

	private isOwnedWorktree(record: WorkerWorkspaceRecord): boolean {
		if (!record.repositoryRoot || !record.branch || !record.worktreePath) {
			return false;
		}
		return (
			record.parentSessionId === this.options.parentSessionId &&
			record.branch ===
				workerBranchName(this.options.parentSessionId, record.workerId) &&
			record.worktreePath ===
				workerWorktreePath(
					record.repositoryRoot,
					this.options.parentSessionId,
					record.workerId,
				)
		);
	}

	private async persist(
		record: WorkerWorkspaceRecord,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		this.records.set(record.workerId, record);
		await this.options.store.upsert(record);
		onProgress?.(cloneRecord(record));
		return record;
	}

	private sortedRecords(): WorkerWorkspaceRecord[] {
		return [...this.records.values()].sort((a, b) => a.sequence - b.sequence);
	}
}

function isTransientTerminalWorker(record: WorkerWorkspaceRecord): boolean {
	return (
		!record.readOnly &&
		(record.executionStatus === "failed" ||
			record.executionStatus === "cancelled") &&
		record.integrationStatus === "skipped" &&
		record.resultCommit === undefined
	);
}

function appendCleanupError(
	existing: string | undefined,
	cleanupError: string,
): string {
	return existing ? `${existing}\n${cleanupError}` : cleanupError;
}

export function workerWorktreePath(
	repositoryRoot: string,
	parentSessionId: string,
	workerId: string,
): string {
	return join(
		dirname(repositoryRoot),
		`${basename(repositoryRoot)}.backboard-workers`,
		safePathPart(parentSessionId),
		safePathPart(workerId),
	);
}

function safePathPart(value: string): string {
	const safe = value
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "");
	const readable = (safe || "worker").slice(0, 100);
	if (readable === value && value.length <= 100) return readable;
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
	return `${readable.slice(0, 89)}-${hash}`;
}

function clampMaxWorkers(value: number): number {
	if (!Number.isFinite(value)) return 4;
	return Math.max(1, Math.min(4, Math.floor(value)));
}

function compareCompletionOrder(
	a: WorkerWorkspaceRecord,
	b: WorkerWorkspaceRecord,
): number {
	const aFinished = a.finishedAt ? Date.parse(a.finishedAt) : Number.NaN;
	const bFinished = b.finishedAt ? Date.parse(b.finishedAt) : Number.NaN;
	if (Number.isFinite(aFinished) && Number.isFinite(bFinished)) {
		const difference = aFinished - bFinished;
		if (difference !== 0) return difference;
	} else if (Number.isFinite(aFinished)) {
		return -1;
	} else if (Number.isFinite(bFinished)) {
		return 1;
	}
	return a.sequence - b.sequence;
}

function cloneRecord(record: WorkerWorkspaceRecord): WorkerWorkspaceRecord {
	return {
		...record,
		changedFiles: [...record.changedFiles],
		conflictingFiles: record.conflictingFiles
			? [...record.conflictingFiles]
			: undefined,
	};
}
