import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteDurable } from "../../utils/atomicWriteDurable.ts";
import { ensureDir } from "../../utils/fs.ts";
import {
	WORKER_WORKSPACE_STORE_VERSION,
	type WorkerWorkspaceRecord,
	type WorkerWorkspaceStoreData,
	type WorkerIntegrationChange,
	type WorkerIntegrationChangeBytes,
} from "./WorkerWorkspaceTypes.ts";

export interface WorkerWorkspaceStoreWriteOptions {
	/** Flushes this state to disk before returning. Defaults to true. */
	durable?: boolean;
}

export interface WorkerWorkspaceStoreOptions {
	/** Coalescing window for intermediate lifecycle states. */
	debounceMs?: number;
}

/** Durable worker metadata with in-memory mutation and coalesced atomic writes. */
export class WorkerWorkspaceStore {
	private readonly debounceMs: number;
	private readonly records = new Map<string, WorkerWorkspaceRecord>();
	private loadPromise?: Promise<void>;
	private flushPromise?: Promise<void>;
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private changeVersion = 0;
	private persistedVersion = 0;
	private readonly blobWrites = new Map<string, Promise<void>>();

	constructor(
		readonly filePath: string,
		options: WorkerWorkspaceStoreOptions = {},
	) {
		this.debounceMs = Math.max(0, options.debounceMs ?? 75);
	}

	async load(): Promise<WorkerWorkspaceRecord[]> {
		await this.ensureLoaded();
		return this.snapshot();
	}

	async upsert(
		record: WorkerWorkspaceRecord,
		options: WorkerWorkspaceStoreWriteOptions = {},
	): Promise<void> {
		await this.ensureLoaded();
		this.assignRevision(record);
		this.records.set(record.workerId, cloneWorkerRecord(record));
		this.markChanged();
		await this.finishMutation(options);
	}

	/** Persists one lifecycle boundary for several workers with one store write. */
	async upsertMany(
		records: readonly WorkerWorkspaceRecord[],
		options: WorkerWorkspaceStoreWriteOptions = {},
	): Promise<void> {
		if (records.length === 0) return;
		await this.ensureLoaded();
		for (const record of records) this.assertCurrentRevision(record);
		for (const record of records) {
			this.assignRevision(record);
			this.records.set(record.workerId, cloneWorkerRecord(record));
		}
		this.markChanged();
		await this.finishMutation(options);
	}

	async replace(
		records: readonly WorkerWorkspaceRecord[],
		options: WorkerWorkspaceStoreWriteOptions = {},
	): Promise<void> {
		await this.ensureLoaded();
		for (const record of records) this.assignRevision(record);
		this.records.clear();
		for (const record of records) {
			this.records.set(record.workerId, cloneWorkerRecord(record));
		}
		this.markChanged();
		await this.finishMutation(options);
	}

	async remove(
		workerId: string,
		options: WorkerWorkspaceStoreWriteOptions = {},
	): Promise<void> {
		await this.ensureLoaded();
		if (!this.records.delete(workerId)) return;
		this.markChanged();
		await this.finishMutation(options);
	}

	async flush(): Promise<void> {
		await this.ensureLoaded();
		this.clearDebounceTimer();
		while (this.persistedVersion < this.changeVersion) {
			this.flushPromise ??= this.drainWrites().finally(() => {
				this.flushPromise = undefined;
			});
			await this.flushPromise;
		}
	}

	/** Persist immutable, exact bytes before a coordinator mutation can commit. */
	async captureIntegrationChanges(
		changes: readonly WorkerIntegrationChangeBytes[],
		signal?: AbortSignal,
	): Promise<WorkerIntegrationChange[]> {
		const result: WorkerIntegrationChange[] = [];
		for (const change of changes) {
			signal?.throwIfAborted();
			if (
				change.before?.mode === change.after?.mode &&
				((change.before === undefined && change.after === undefined) ||
					change.before?.content.equals(
						change.after?.content ?? Buffer.alloc(0),
					))
			)
				continue;
			const entry: WorkerIntegrationChange = { filePath: change.filePath };
			for (const side of ["before", "after"] as const) {
				signal?.throwIfAborted();
				const value = change[side];
				if (!value) continue;
				const sha256 = createHash("sha256").update(value.content).digest("hex");
				const contentPath = join(
					dirname(this.filePath),
					"worker-integrations",
					"blobs",
					sha256,
				);
				let writing = this.blobWrites.get(contentPath);
				if (!writing) {
					writing = this.writeBlob(contentPath, value.content).finally(() =>
						this.blobWrites.delete(contentPath),
					);
					this.blobWrites.set(contentPath, writing);
				}
				await writing;
				entry[side] = {
					contentPath,
					sha256,
					byteLength: value.content.length,
					mode: value.mode,
				};
			}
			result.push(entry);
		}
		return result;
	}

	private async writeBlob(path: string, content: Buffer): Promise<void> {
		await ensureDir(dirname(path));
		try {
			if (!(await readFile(path)).equals(content))
				throw new Error(
					"Worker integration content failed its immutable hash check.",
				);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await atomicWriteDurable(path, content);
	}

	private assertCurrentRevision(record: WorkerWorkspaceRecord): void {
		if (
			record.revision !== undefined &&
			(!Number.isSafeInteger(record.revision) || record.revision < 0)
		)
			throw new Error("Invalid worker workspace revision.");
		const current = this.records.get(record.workerId)?.revision ?? 0;
		if (record.revision !== undefined && record.revision < current)
			throw new Error(
				`Stale worker workspace revision for ${record.workerId}: ${record.revision} < ${current}.`,
			);
	}

	private assignRevision(record: WorkerWorkspaceRecord): void {
		this.assertCurrentRevision(record);
		record.revision =
			Math.max(
				this.records.get(record.workerId)?.revision ?? 0,
				record.revision ?? 0,
			) + 1;
	}

	private async ensureLoaded(): Promise<void> {
		this.loadPromise ??= this.loadNow();
		await this.loadPromise;
	}

	private async loadNow(): Promise<void> {
		let workers: WorkerWorkspaceRecord[] = [];
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
				version?: unknown;
				workers?: unknown;
			};
			if (
				parsed.version === WORKER_WORKSPACE_STORE_VERSION &&
				Array.isArray(parsed.workers)
			) {
				workers = parsed.workers
					.filter(isWorkerWorkspaceRecord)
					.map(cloneWorkerRecord);
			}
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
		for (const worker of workers) {
			this.records.set(worker.workerId, worker);
		}
	}

	private markChanged(): void {
		this.changeVersion++;
	}

	private async finishMutation(
		options: WorkerWorkspaceStoreWriteOptions,
	): Promise<void> {
		if (options.durable ?? true) {
			await this.flush();
			return;
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.debounceTimer) return;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			void this.flush().catch(() => {
				// A later lifecycle-boundary flush retries and surfaces the failure.
			});
		}, this.debounceMs);
		this.debounceTimer.unref?.();
	}

	private clearDebounceTimer(): void {
		if (!this.debounceTimer) return;
		clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
	}

	private async drainWrites(): Promise<void> {
		while (this.persistedVersion < this.changeVersion) {
			const targetVersion = this.changeVersion;
			await this.writeNow(this.snapshot());
			this.persistedVersion = targetVersion;
		}
	}

	private snapshot(): WorkerWorkspaceRecord[] {
		return [...this.records.values()]
			.sort((a, b) => a.sequence - b.sequence)
			.map(cloneWorkerRecord);
	}

	private async writeNow(records: WorkerWorkspaceRecord[]): Promise<void> {
		await ensureDir(dirname(this.filePath));
		const data: WorkerWorkspaceStoreData = {
			version: WORKER_WORKSPACE_STORE_VERSION,
			workers: records,
		};
		await atomicWriteDurable(
			this.filePath,
			`${JSON.stringify(data, null, 2)}\n`,
		);
	}
}

function isWorkerWorkspaceRecord(
	value: unknown,
): value is WorkerWorkspaceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<WorkerWorkspaceRecord>;
	return (
		typeof record.workerId === "string" &&
		(record.revision === undefined ||
			(Number.isSafeInteger(record.revision) && record.revision >= 0)) &&
		typeof record.sequence === "number" &&
		typeof record.parentSessionId === "string" &&
		typeof record.taskPrompt === "string" &&
		typeof record.readOnly === "boolean" &&
		typeof record.coordinatorCwd === "string" &&
		Array.isArray(record.changedFiles) &&
		record.changedFiles.every((path) => typeof path === "string") &&
		(record.worktreeDisposition === undefined ||
			record.worktreeDisposition === "present" ||
			record.worktreeDisposition === "removed_clean_terminal") &&
		(record.worktreeCleanedAt === undefined ||
			typeof record.worktreeCleanedAt === "string") &&
		typeof record.startedAt === "string" &&
		typeof record.executionStatus === "string" &&
		typeof record.integrationStatus === "string"
	);
}

function cloneWorkerRecord(
	record: WorkerWorkspaceRecord,
): WorkerWorkspaceRecord {
	return structuredClone({ ...record, revision: record.revision ?? 0 });
}
