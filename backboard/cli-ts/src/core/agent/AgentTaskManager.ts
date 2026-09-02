import type { AgentToolInput } from "../../tools/AgentToolTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolResult } from "../tools/ToolResult.ts";
import type { WorkerWorkspaceManager } from "../workspaces/WorkerWorkspaceManager.ts";
import {
	type WorkerWorkspaceRecord,
	workerProgress,
} from "../workspaces/WorkerWorkspaceTypes.ts";
import type { AgentTaskStore } from "./AgentTaskStore.ts";
import type {
	AgentTaskRecord,
	AgentTaskResultBundle,
} from "./AgentTaskTypes.ts";

export interface AgentTaskManagerOptions {
	store?: AgentTaskStore;
	/** Reconciled worker metadata, initialized before this manager on restart. */
	workerWorkspaces?: Pick<WorkerWorkspaceManager, "list">;
	now?: () => Date;
}

export interface SpawnAgentTask {
	handle: string;
	input: AgentToolInput;
	ctx: ToolContext;
	run: (
		input: AgentToolInput,
		ctx: ToolContext,
	) => Promise<ToolResult<AgentToolOutput>>;
}

/** Owns non-blocking Agent executions and their durable, joinable outcomes. */
export class AgentTaskManager {
	private readonly now: () => Date;
	private readonly records = new Map<string, AgentTaskRecord>();
	private readonly operations = new Map<string, Promise<void>>();
	private readonly controllers = new Map<string, AbortController>();
	private initialization?: Promise<void>;

	constructor(private readonly options: AgentTaskManagerOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	initialize(): Promise<void> {
		this.initialization ??= this.loadAndRecover();
		return this.initialization;
	}

	async spawn(task: SpawnAgentTask): Promise<AgentTaskRecord> {
		await this.initialize();
		const existing = this.records.get(task.handle);
		if (existing) {
			if (
				existing.sessionId !== task.ctx.sessionId ||
				existing.prompt !== task.input.prompt ||
				existing.readOnly !== (task.input.read_only === true)
			) {
				throw new Error(`Agent task handle is already in use: ${task.handle}`);
			}
			return cloneRecord(existing);
		}

		const queued: AgentTaskRecord = {
			handle: task.handle,
			sessionId: task.ctx.sessionId,
			turnId: task.ctx.turnId,
			prompt: task.input.prompt,
			readOnly: task.input.read_only === true,
			status: "queued",
			createdAt: this.now().toISOString(),
		};
		await this.persist(queued);

		const controller = new AbortController();
		this.controllers.set(task.handle, controller);
		const operation = this.execute(
			task,
			AbortSignal.any([task.ctx.signal, controller.signal]),
		).finally(() => {
			this.controllers.delete(task.handle);
			this.operations.delete(task.handle);
		});
		this.operations.set(task.handle, operation);
		void operation.catch(() => undefined);
		return cloneRecord(this.records.get(task.handle) ?? queued);
	}

	async wait(
		handles: readonly string[],
		sessionId: string,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<AgentTaskRecord[]> {
		await this.initialize();
		this.validateHandles(handles, sessionId);
		const operations = handles.flatMap((handle) => {
			const operation = this.operations.get(handle);
			return operation ? [operation] : [];
		});
		if (operations.length > 0) {
			await waitForOperations(operations, signal, timeoutMs);
		}
		return handles.map((handle) => cloneRecord(this.requireRecord(handle)));
	}

	list(): AgentTaskRecord[] {
		return [...this.records.values()].map(cloneRecord);
	}

	cancelAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.operations.values()]);
		await this.options.store?.flush();
	}

	private async execute(
		task: SpawnAgentTask,
		signal: AbortSignal,
	): Promise<void> {
		const running: AgentTaskRecord = {
			...this.requireRecord(task.handle),
			status: "running",
			startedAt: this.now().toISOString(),
		};
		this.records.set(task.handle, running);
		const runningPersistence = this.options.store?.upsert(running);
		try {
			// Start model execution before waiting on the non-critical running-state
			// flush. The queued handle is already durable at this point.
			const resultPromise = task.run(task.input, {
				...task.ctx,
				signal,
				toolCallId: task.handle,
			});
			const result = await resultPromise;
			await runningPersistence;
			const finishedAt = this.now().toISOString();
			const bundle: AgentTaskResultBundle = {
				data: result.data,
				forLLM: result.forLLM,
				title: result.title,
				...(result.detail === undefined ? {} : { detail: result.detail }),
				completedAt: finishedAt,
			};
			const outcome = classifyAgentResult(result, signal);
			await this.persist({
				...running,
				status: outcome.status,
				finishedAt,
				result: bundle,
				...(outcome.error ? { error: outcome.error } : {}),
			});
		} catch (error) {
			await runningPersistence?.catch(() => undefined);
			await this.persist({
				...running,
				status: signal.aborted ? "cancelled" : "failed",
				finishedAt: this.now().toISOString(),
				error: errorMessage(error),
			});
		}
	}

	private async loadAndRecover(): Promise<void> {
		const loaded = (await this.options.store?.load()) ?? [];
		let changed = false;
		for (const record of loaded) {
			let recovered = record;
			// Workspace integration is the authority for write tasks even when an
			// earlier process already persisted failed/interrupted task metadata. A
			// later restart can prove that the durable result commit was integrated.
			// Completed tasks are never reconsidered or downgraded.
			if (record.status !== "completed" && !record.readOnly) {
				const worker = this.findWorker(record);
				const reconciled = worker
					? reconcileWorkerRecord(record, worker, this.now().toISOString())
					: undefined;
				if (reconciled) recovered = reconciled;
			}
			if (
				recovered === record &&
				(record.status === "queued" || record.status === "running")
			) {
				recovered = this.recoverInterrupted(record);
			}
			if (recovered !== record) changed = true;
			this.records.set(recovered.handle, recovered);
		}
		if (changed) await this.options.store?.replace([...this.records.values()]);
	}

	private recoverInterrupted(record: AgentTaskRecord): AgentTaskRecord {
		const worker = this.findWorker(record);
		if (worker) {
			const reconciled = reconcileWorkerRecord(
				record,
				worker,
				this.now().toISOString(),
			);
			if (reconciled) return reconciled;
		}
		return {
			...record,
			status: "interrupted",
			finishedAt: this.now().toISOString(),
			error:
				"Worker execution was interrupted by process shutdown. No complete Agent result bundle was captured; rerun the worker if its report is still needed.",
		};
	}

	private findWorker(
		record: AgentTaskRecord,
	): WorkerWorkspaceRecord | undefined {
		return this.options.workerWorkspaces
			?.list()
			.find(
				(candidate) =>
					candidate.parentSessionId === record.sessionId &&
					(candidate.workerId === record.handle ||
						candidate.parentToolCallId === record.handle),
			);
	}

	private async persist(record: AgentTaskRecord): Promise<void> {
		this.records.set(record.handle, record);
		await this.options.store?.upsert(record);
	}

	private validateHandles(handles: readonly string[], sessionId: string): void {
		for (const handle of handles) {
			const record = this.requireRecord(handle);
			if (record.sessionId !== sessionId) {
				throw new Error(`Agent task belongs to another session: ${handle}`);
			}
		}
	}

	private requireRecord(handle: string): AgentTaskRecord {
		const record = this.records.get(handle);
		if (!record) throw new Error(`Unknown Agent task handle: ${handle}`);
		return record;
	}
}

function classifyAgentResult(
	result: ToolResult<AgentToolOutput>,
	signal: AbortSignal,
): { status: AgentTaskRecord["status"]; error?: string } {
	const workerStatus = result.data.status;
	// A write worker can cross its durable capture/integration boundary while a
	// Stop signal is racing its final bookkeeping. The authoritative terminal
	// worker result wins; downgrading it would hide files already integrated into
	// the coordinator workspace from AgentWait and restart recovery.
	if (workerStatus === "completed" || workerStatus === "integrated") {
		return { status: "completed" };
	}
	if (signal.aborted || workerStatus === "cancelled") {
		return {
			status: "cancelled",
			error: workerFailureMessage(workerStatus, result.data.report),
		};
	}
	return {
		status: "failed",
		error: workerFailureMessage(workerStatus, result.data.report),
	};
}

function reconcileWorkerRecord(
	task: AgentTaskRecord,
	worker: WorkerWorkspaceRecord,
	now: string,
): AgentTaskRecord | undefined {
	const finishedAt = worker.finishedAt ?? now;
	if (worker.executionStatus === "cancelled") {
		return {
			...task,
			status: "cancelled",
			finishedAt,
			error: worker.error ?? "Worker was cancelled before completion.",
		};
	}
	if (worker.executionStatus === "failed") {
		return {
			...task,
			status: "failed",
			finishedAt,
			error: worker.error ?? "Worker execution failed before result capture.",
		};
	}
	if (worker.executionStatus !== "completed") return undefined;

	if (worker.integrationStatus === "conflict") {
		const report = worker.conflictingFiles?.length
			? `Recovered worker result has conflicts in ${worker.conflictingFiles.join(", ")}.`
			: "Recovered worker result has an integration conflict.";
		return {
			...task,
			status: "failed",
			finishedAt,
			error: report,
			result: recoveredWorkerBundle(worker, "conflict", report, finishedAt),
		};
	}

	// A captured write commit that the workspace manager proved integrated is
	// authoritative even if the process died before AgentTool returned. A
	// read-only worker (or a no-op worker) has no durable report payload to
	// reconstruct, so claiming completion would silently lose its actual answer.
	if (
		!worker.readOnly &&
		worker.integrationStatus === "integrated" &&
		worker.resultCommit &&
		worker.changedFiles.length > 0
	) {
		const report = `Recovered ${worker.changedFiles.length} integrated changed ${worker.changedFiles.length === 1 ? "file" : "files"}. The original worker narrative was interrupted, but its captured result is already present in the coordinator workspace.`;
		return {
			...task,
			status: "completed",
			finishedAt,
			result: recoveredWorkerBundle(worker, "completed", report, finishedAt),
		};
	}

	if (worker.integrationStatus === "skipped") {
		return {
			...task,
			status: "failed",
			finishedAt,
			error:
				worker.error ??
				"Worker result was captured but integration was skipped.",
		};
	}
	return undefined;
}

function recoveredWorkerBundle(
	worker: WorkerWorkspaceRecord,
	status: string,
	report: string,
	completedAt: string,
): AgentTaskResultBundle {
	return {
		data: {
			mode: "worker",
			report,
			status,
			rounds: 0,
			worker: workerProgress(worker),
		},
		forLLM: report,
		title:
			status === "completed"
				? "Recovered integrated worker"
				: "Recovered worker conflict",
		completedAt,
	};
}

function workerFailureMessage(status: string, report: string): string {
	const detail = report.trim();
	return detail
		? `Worker reported ${status}: ${detail}`
		: `Worker reported terminal status: ${status}.`;
}

async function waitForOperations(
	operations: readonly Promise<void>[],
	signal: AbortSignal,
	timeoutMs?: number,
): Promise<void> {
	if (signal.aborted) throw new Error("Agent wait was cancelled.");
	const all = Promise.allSettled(operations).then(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const interrupted = new Promise<void>((resolve, reject) => {
		abortListener = () => reject(new Error("Agent wait was cancelled."));
		signal.addEventListener("abort", abortListener, { once: true });
		if (timeoutMs !== undefined) {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}
	});
	try {
		await Promise.race([all, interrupted]);
	} finally {
		if (timer) clearTimeout(timer);
		if (abortListener) signal.removeEventListener("abort", abortListener);
	}
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
	return {
		...record,
		result: record.result
			? { ...record.result, data: { ...record.result.data } }
			: undefined,
	};
}
