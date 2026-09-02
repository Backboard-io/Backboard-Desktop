import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../../utils/fs.ts";
import {
	AGENT_TASK_STORE_VERSION,
	type AgentTaskRecord,
	type AgentTaskStoreData,
} from "./AgentTaskTypes.ts";

/** Atomic session-local persistence for detached Agent task handles. */
export class AgentTaskStore {
	private readonly records = new Map<string, AgentTaskRecord>();
	private loadPromise?: Promise<void>;
	private flushPromise?: Promise<void>;
	private changeVersion = 0;
	private persistedVersion = 0;
	private nextTemporaryId = 0;

	constructor(readonly filePath: string) {}

	async load(): Promise<AgentTaskRecord[]> {
		await this.ensureLoaded();
		return this.snapshot();
	}

	async upsert(record: AgentTaskRecord): Promise<void> {
		await this.ensureLoaded();
		this.records.set(record.handle, cloneRecord(record));
		this.changeVersion++;
		await this.flush();
	}

	async replace(records: readonly AgentTaskRecord[]): Promise<void> {
		await this.ensureLoaded();
		this.records.clear();
		for (const record of records) {
			this.records.set(record.handle, cloneRecord(record));
		}
		this.changeVersion++;
		await this.flush();
	}

	async flush(): Promise<void> {
		await this.ensureLoaded();
		while (this.persistedVersion < this.changeVersion) {
			this.flushPromise ??= this.drainWrites().finally(() => {
				this.flushPromise = undefined;
			});
			await this.flushPromise;
		}
	}

	private async ensureLoaded(): Promise<void> {
		this.loadPromise ??= this.loadNow();
		await this.loadPromise;
	}

	private async loadNow(): Promise<void> {
		let tasks: AgentTaskRecord[] = [];
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
				version?: unknown;
				tasks?: unknown;
			};
			if (
				parsed.version === AGENT_TASK_STORE_VERSION &&
				Array.isArray(parsed.tasks)
			) {
				tasks = parsed.tasks.filter(isAgentTaskRecord).map(cloneRecord);
			}
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
		for (const task of tasks) this.records.set(task.handle, task);
	}

	private async drainWrites(): Promise<void> {
		// Concurrent AgentSpawn calls from one provider response all enqueue their
		// durable handles in adjacent microtasks. Yield once before snapshotting so
		// they share one atomic write and begin model execution together, instead of
		// starting behind a convoy of full-file rewrites.
		await Promise.resolve();
		while (this.persistedVersion < this.changeVersion) {
			const targetVersion = this.changeVersion;
			await this.writeNow(this.snapshot());
			this.persistedVersion = targetVersion;
		}
	}

	private snapshot(): AgentTaskRecord[] {
		return [...this.records.values()]
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map(cloneRecord);
	}

	private async writeNow(tasks: AgentTaskRecord[]): Promise<void> {
		await ensureDir(dirname(this.filePath));
		const data: AgentTaskStoreData = {
			version: AGENT_TASK_STORE_VERSION,
			tasks,
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

function isAgentTaskRecord(value: unknown): value is AgentTaskRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AgentTaskRecord>;
	return (
		typeof record.handle === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.prompt === "string" &&
		typeof record.readOnly === "boolean" &&
		typeof record.status === "string" &&
		typeof record.createdAt === "string"
	);
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
	return {
		...record,
		result: record.result
			? { ...record.result, data: { ...record.result.data } }
			: undefined,
	};
}
