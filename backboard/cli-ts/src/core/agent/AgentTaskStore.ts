import { readFile } from "node:fs/promises";
import { atomicWriteDurable } from "../../utils/atomicWriteDurable.ts";
import { dirname } from "node:path";
import { ensureDir } from "../../utils/fs.ts";
import {
	type ToolExecutionMetadata,
	toolFailureMetadata,
} from "../tools/ToolFailure.ts";
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
				!parsed ||
				parsed.version !== AGENT_TASK_STORE_VERSION ||
				!Array.isArray(parsed.tasks)
			) {
				throw new Error(
					"Unsupported or malformed Agent task store; existing records were preserved.",
				);
			}
			if (!parsed.tasks.every(isAgentTaskRecord)) {
				throw new Error(
					"Invalid Agent task record; existing records were preserved.",
				);
			}
			if (
				new Set(parsed.tasks.map((record) => record.handle)).size !==
				parsed.tasks.length
			) {
				throw new Error(
					"Duplicate Agent task handles in store; existing records were preserved.",
				);
			}
			tasks = parsed.tasks.map(cloneRecord);
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
		await atomicWriteDurable(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
	}
}

const taskStatuses = new Set([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);

function isAgentTaskRecord(value: unknown): value is AgentTaskRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AgentTaskRecord>;
	return (
		typeof record.handle === "string" &&
		record.handle.length > 0 &&
		typeof record.sessionId === "string" &&
		typeof record.prompt === "string" &&
		typeof record.readOnly === "boolean" &&
		typeof record.status === "string" &&
		taskStatuses.has(record.status) &&
		typeof record.createdAt === "string" &&
		(record.revision === undefined || (Number.isSafeInteger(record.revision) && record.revision >= 0)) &&
		(record.executionStatus === undefined || ["queued", "preparing", "running", "completed", "failed", "cancelled", "interrupted"].includes(record.executionStatus)) &&
		(record.integrationStatus === undefined || ["not_required", "pending", "integrating", "integrated", "conflict", "skipped"].includes(record.integrationStatus)) &&
		(record.name === undefined || (typeof record.name === "string" && record.name.length > 0 && record.name.length <= 80 && !/[\r\n]/.test(record.name))) &&
		(record.capabilities === undefined || (!!record.capabilities && typeof record.capabilities === "object" && typeof record.capabilities.readOnly === "boolean" && (record.capabilities.permissionMode === undefined || typeof record.capabilities.permissionMode === "string"))) &&
		(record.workspace === undefined || (!!record.workspace && typeof record.workspace === "object" && typeof record.workspace.workerId === "string" && typeof record.workspace.status === "string" && Number.isSafeInteger(record.workspace.changedFileCount) && record.workspace.changedFileCount >= 0)) &&
		[
			record.turnId,
			record.parentBatchToolCallId,
			record.startedAt,
			record.finishedAt,
			record.error,
			record.inputFingerprint,
			record.persistenceError,
		].every((value) => value === undefined || typeof value === "string") &&
		(record.result === undefined || isResultBundle(record.result)) &&
		(record.execution === undefined || isExecutionMetadata(record.execution))
	);
}

function isResultBundle(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const bundle = value as Partial<NonNullable<AgentTaskRecord["result"]>>;
	const data = bundle.data;
	if (!data || typeof data !== "object") return false;
	return (
		typeof bundle.forLLM === "string" &&
		typeof bundle.title === "string" &&
		typeof bundle.completedAt === "string" &&
		(bundle.detail === undefined || typeof bundle.detail === "string") &&
		(data.mode === "worker" || data.mode === "rlm") &&
		typeof data.report === "string" &&
		typeof data.status === "string" &&
		Number.isInteger(data.rounds) &&
		data.rounds >= 0 &&
		(data.tracePath === undefined || typeof data.tracePath === "string") &&
		(data.worker === undefined ||
			(data.worker !== null &&
				typeof data.worker === "object" &&
				typeof data.worker.workerId === "string" &&
				typeof data.worker.status === "string" &&
				Number.isInteger(data.worker.changedFileCount) &&
				data.worker.changedFileCount >= 0 &&
				typeof data.worker.startedAt === "string" &&
				(data.worker.conflictingFiles === undefined ||
					(Array.isArray(data.worker.conflictingFiles) &&
						data.worker.conflictingFiles.every(
							(path) => typeof path === "string",
						)))))
	);
}

function isExecutionMetadata(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const execution = value as ToolExecutionMetadata;
	return (
		(execution.failureCategory === undefined ||
			toolFailureMetadata({ category: execution.failureCategory })
				.failureCategory === execution.failureCategory) &&
		(execution.exitCode === undefined ||
			Number.isInteger(execution.exitCode)) &&
		[
			execution.cancelled,
			execution.timedOut,
			execution.retryable,
			execution.mutated,
		].every((value) => value === undefined || typeof value === "boolean") &&
		(execution.validation === undefined ||
			["passed", "failed"].includes(execution.validation)) &&
		(execution.outcome === undefined ||
			["success", "no_match", "partial", "failure"].includes(execution.outcome))
	);
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
	return structuredClone(record);
}
