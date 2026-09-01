import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../../utils/fs.ts";
import {
	WORKER_WORKSPACE_STORE_VERSION,
	type WorkerWorkspaceRecord,
	type WorkerWorkspaceStoreData,
} from "./WorkerWorkspaceTypes.ts";

/** Durable, atomically replaced worker metadata with in-process write ordering. */
export class WorkerWorkspaceStore {
	private tail: Promise<void> = Promise.resolve();
	private nextTemporaryId = 0;

	constructor(readonly filePath: string) {}

	async load(): Promise<WorkerWorkspaceRecord[]> {
		await this.tail;
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
				version?: unknown;
				workers?: unknown;
			};
			if (
				parsed.version !== WORKER_WORKSPACE_STORE_VERSION ||
				!Array.isArray(parsed.workers)
			) {
				return [];
			}
			return parsed.workers
				.filter(isWorkerWorkspaceRecord)
				.map(cloneWorkerRecord);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
	}

	async upsert(record: WorkerWorkspaceRecord): Promise<void> {
		return this.mutate((workers) => {
			const index = workers.findIndex(
				(candidate) => candidate.workerId === record.workerId,
			);
			if (index >= 0) workers[index] = cloneWorkerRecord(record);
			else workers.push(cloneWorkerRecord(record));
		});
	}

	async replace(records: readonly WorkerWorkspaceRecord[]): Promise<void> {
		return this.queueWrite(records.map(cloneWorkerRecord));
	}

	async remove(workerId: string): Promise<void> {
		return this.mutate((workers) => {
			const index = workers.findIndex(
				(candidate) => candidate.workerId === workerId,
			);
			if (index >= 0) workers.splice(index, 1);
		});
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	private async mutate(
		change: (workers: WorkerWorkspaceRecord[]) => void,
	): Promise<void> {
		const operation = this.tail.then(async () => {
			const workers = await this.loadWithoutWaiting();
			change(workers);
			await this.writeNow(workers);
		});
		this.tail = operation;
		await operation;
	}

	private async queueWrite(records: WorkerWorkspaceRecord[]): Promise<void> {
		const operation = this.tail.then(() => this.writeNow(records));
		this.tail = operation;
		await operation;
	}

	private async loadWithoutWaiting(): Promise<WorkerWorkspaceRecord[]> {
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
				version?: unknown;
				workers?: unknown;
			};
			return parsed.version === WORKER_WORKSPACE_STORE_VERSION &&
				Array.isArray(parsed.workers)
				? parsed.workers.filter(isWorkerWorkspaceRecord).map(cloneWorkerRecord)
				: [];
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
	}

	private async writeNow(records: WorkerWorkspaceRecord[]): Promise<void> {
		await ensureDir(dirname(this.filePath));
		const data: WorkerWorkspaceStoreData = {
			version: WORKER_WORKSPACE_STORE_VERSION,
			workers: records,
		};
		const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.nextTemporaryId++}`;
		await writeFile(
			temporaryPath,
			`${JSON.stringify(data, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, this.filePath);
	}
}

function isWorkerWorkspaceRecord(
	value: unknown,
): value is WorkerWorkspaceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<WorkerWorkspaceRecord>;
	return (
		typeof record.workerId === "string" &&
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
	return {
		...record,
		changedFiles: [...record.changedFiles],
		conflictingFiles: record.conflictingFiles
			? [...record.conflictingFiles]
			: undefined,
	};
}
