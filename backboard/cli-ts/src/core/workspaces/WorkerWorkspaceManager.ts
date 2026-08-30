import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
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

interface IntegrationSubmission {
	record: WorkerWorkspaceRecord;
	signal: AbortSignal;
	onProgress?: (record: WorkerWorkspaceRecord) => void;
	shouldIntegrate: boolean;
}

interface IntegrationSlot {
	resolve: (submission: IntegrationSubmission) => void;
	result: Promise<WorkerWorkspaceRecord>;
}

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
	private readonly integrationSlots = new Map<string, IntegrationSlot>();
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
		return this.cleanupIntegratedWorktrees();
	}

	async delete(): Promise<string[]> {
		this.cancelAll();
		await this.initialize();
		await this.waitForIdle();
		return this.cleanupIntegratedWorktrees();
	}

	async unarchive(): Promise<WorkerWorkspaceRecord[]> {
		await this.initialize();
		for (const record of this.sortedRecords()) {
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
			const record = await this.finishWithoutIntegration(
				workspace.record,
				workspace.signal.aborted ? "cancelled" : "failed",
				errorMessage(error),
				params.onProgress,
			);
			this.resolveIntegration(
				record,
				workspace.signal,
				params.onProgress,
				false,
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
			this.resolveIntegration(
				record,
				workspace.signal,
				params.onProgress,
				false,
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
			const record = await this.finishWithoutIntegration(
				workspace.record,
				workspace.signal.aborted ? "cancelled" : "failed",
				errorMessage(error),
				params.onProgress,
			);
			this.resolveIntegration(
				record,
				workspace.signal,
				params.onProgress,
				false,
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
		const slot = this.integrationSlots.get(completed.workerId);
		if (!slot)
			throw new Error(`Missing integration slot for ${completed.workerId}`);
		this.resolveIntegration(
			completed,
			workspace.signal,
			params.onProgress,
			true,
		);
		const integrated = await slot.result;
		this.records.set(integrated.workerId, integrated);
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

		this.reserveIntegrationSlot(record.workerId);
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
			this.resolveIntegration(record, params.signal, params.onProgress, false);
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

	private reserveIntegrationSlot(workerId: string): void {
		let resolveSubmission: (submission: IntegrationSubmission) => void =
			() => {};
		const submission = new Promise<IntegrationSubmission>((resolve) => {
			resolveSubmission = resolve;
		});
		const result = this.integrationTail.then(async () => {
			const next = await submission;
			if (!next.shouldIntegrate) return next.record;
			if (this.integrationBlocked) {
				return this.persist(
					{
						...next.record,
						integrationStatus: "pending",
						error:
							"Integration is waiting for an earlier worker conflict to be resolved.",
					},
					next.onProgress,
				);
			}
			const integrated = await this.integration.integrate(
				next.record,
				next.signal,
				next.onProgress,
			);
			if (integrated.integrationStatus === "conflict") {
				this.integrationBlocked = true;
			}
			return integrated;
		});
		this.integrationTail = result.then(
			() => undefined,
			() => undefined,
		);
		this.integrationSlots.set(workerId, {
			resolve: resolveSubmission,
			result,
		});
	}

	private resolveIntegration(
		record: WorkerWorkspaceRecord,
		signal: AbortSignal,
		onProgress: ((record: WorkerWorkspaceRecord) => void) | undefined,
		shouldIntegrate: boolean,
	): void {
		this.integrationSlots.get(record.workerId)?.resolve({
			record,
			signal,
			onProgress,
			shouldIntegrate,
		});
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
		return this.persist(
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
	}

	private async recover(): Promise<void> {
		const records = await this.options.store.load();
		for (const record of records.sort((a, b) => a.sequence - b.sequence)) {
			this.records.set(record.workerId, record);
			this.nextSequence = Math.max(this.nextSequence, record.sequence + 1);
			if (record.readOnly) continue;
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
			for (const record of this.sortedRecords()) {
				if (
					record.executionStatus !== "completed" ||
					record.integrationStatus !== "pending"
				) {
					continue;
				}
				const integrated = await this.integration.integrate(record);
				this.records.set(record.workerId, integrated);
				if (integrated.integrationStatus === "conflict") {
					this.integrationBlocked = true;
					break;
				}
			}
		}
	}

	private async cleanupIntegratedWorktrees(): Promise<string[]> {
		const preserved: string[] = [];
		for (const record of this.sortedRecords()) {
			if (!record.worktreePath || record.readOnly) continue;
			if (!this.isOwnedWorktree(record)) {
				preserved.push(record.worktreePath);
				continue;
			}
			if (
				record.integrationStatus !== "integrated" ||
				record.executionStatus !== "completed" ||
				!record.repositoryRoot
			) {
				preserved.push(record.worktreePath);
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
					worktreePath: record.worktreePath,
				});
				if (!removed) preserved.push(record.worktreePath);
			} catch (error) {
				record.error = `Cleanup preserved worker worktree ${record.worktreePath}: ${errorMessage(error)}`;
				await this.persist(record);
				preserved.push(record.worktreePath);
			}
		}
		return preserved;
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

function cloneRecord(record: WorkerWorkspaceRecord): WorkerWorkspaceRecord {
	return {
		...record,
		changedFiles: [...record.changedFiles],
		conflictingFiles: record.conflictingFiles
			? [...record.conflictingFiles]
			: undefined,
	};
}
