import { resolve } from "node:path";
import type { AgentToolInput } from "../../tools/AgentToolTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import { AbortError, throwIfAborted } from "../tools/ToolAbort.ts";
import { toolInputFingerprint } from "../tools/ToolCallIdentity.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { toolFailureMetadata } from "../tools/ToolFailure.ts";
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
	parentBatchToolCallId?: string;
	input: AgentToolInput;
	ctx: ToolContext;
	/** The runner reports when preparation has completed and model work begins. */
	reportsWorkerStart?: boolean;
	run: (
		input: AgentToolInput,
		ctx: ToolContext,
		onStarted: () => void | Promise<void>,
	) => Promise<ToolResult<AgentToolOutput>>;
}

/** Owns non-blocking Agent executions and their durable, joinable outcomes. */
export class AgentTaskManager {
	private readonly now: () => Date;
	private readonly records = new Map<string, AgentTaskRecord>();
	private readonly operations = new Map<string, Promise<void>>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly registrations = new Map<
		string,
		{ identity: string; promise: Promise<AgentTaskRecord> }
	>();
	private cancellationGeneration = 0;
	private initialization?: Promise<void>;

	constructor(private readonly options: AgentTaskManagerOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	initialize(): Promise<void> {
		this.initialization ??= this.loadAndRecover();
		return this.initialization;
	}

	async spawn(task: SpawnAgentTask): Promise<AgentTaskRecord> {
		throwIfAborted(task.ctx.signal);
		const identity = taskIdentity(task);
		const pending = this.registrations.get(task.handle);
		if (pending) {
			if (pending.identity !== identity)
				throw new Error(`Agent task handle is already in use: ${task.handle}`);
			const record = await pending.promise;
			throwIfAborted(task.ctx.signal);
			return cloneRecord(record);
		}
		// Reserve before the first asynchronous boundary. Duplicate callers must
		// share registration durability, not observe an unflushed queued record.
		const promise = this.register(task, identity, this.cancellationGeneration);
		this.registrations.set(task.handle, { identity, promise });
		try {
			return cloneRecord(await promise);
		} finally {
			if (this.registrations.get(task.handle)?.promise === promise)
				this.registrations.delete(task.handle);
		}
	}

/** Register the whole batch before releasing any new worker execution. */
	async spawnBatch(tasks: readonly SpawnAgentTask[]): Promise<AgentTaskRecord[]> {
		if (!tasks.length || tasks.length > 4) throw new Error("A worker batch must contain between one and four assignments.");
		if (new Set(tasks.map(task => task.handle)).size !== tasks.length) throw new Error("Duplicate worker handle in batch.");
		await this.initialize();
		for (const task of tasks) {
			throwIfAborted(task.ctx.signal);
			const existing = this.records.get(task.handle);
			if (existing && !matchesTask(existing, task, taskIdentity(task))) throw new Error(`Agent task handle is already in use: ${task.handle}`);
			const pending = this.registrations.get(task.handle);
			if (pending && pending.identity !== taskIdentity(task)) throw new Error(`Agent task handle is already in use: ${task.handle}`);
		}
		const newHandles = tasks.filter(task => !this.records.has(task.handle) && !this.registrations.has(task.handle)).map(task => task.handle);
		let release!: () => void;
		let reject!: (error: Error) => void;
		const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
		void gate.catch(() => undefined);
		const registered = await Promise.allSettled(tasks.map(task => this.spawn({
			...task,
			reportsWorkerStart: true,
			run: async (input, ctx, onStarted) => {
				await gate;
				throwIfAborted(ctx.signal);
				if (!task.reportsWorkerStart) await onStarted();
				return task.run(input, ctx, onStarted);
			},
		})));
		const failure = registered.find(result => result.status === "rejected");
		if (failure || tasks.some(task => task.ctx.signal.aborted)) {
			for (const handle of newHandles) this.controllers.get(handle)?.abort();
			reject(new AbortError());
			if (failure?.status === "rejected") throw failure.reason;
			throw new AbortError();
		}
		release();
		return registered.map(result => (result as PromiseFulfilledResult<AgentTaskRecord>).value);
	}

	async cancel(handles: readonly string[], sessionId: string): Promise<AgentTaskRecord[]> {
		await this.initialize();
		this.validateHandles(handles, sessionId);
		for (const handle of handles) this.controllers.get(handle)?.abort();
		return handles.map(handle => cloneRecord(this.requireRecord(handle)));
	}

	private async register(
		task: SpawnAgentTask,
		identity: string,
		generation: number,
	): Promise<AgentTaskRecord> {
		await this.initialize();
		throwIfAborted(task.ctx.signal);
		if (generation !== this.cancellationGeneration) throw new AbortError();
		const existing = this.records.get(task.handle);
		if (existing) {
			if (!matchesTask(existing, task, identity))
				throw new Error(`Agent task handle is already in use: ${task.handle}`);
			return existing;
		}
		const queued: AgentTaskRecord = {
			handle: task.handle,
			sessionId: task.ctx.sessionId,
			turnId: task.ctx.turnId,
			prompt: task.input.prompt,
			...(task.input.name ? { name: task.input.name } : {}),
			readOnly: task.input.read_only === true,
			inputFingerprint: identity,
			status: "queued",
			executionStatus: "queued",
			integrationStatus: task.input.read_only === true || task.input.subagent_type === "rlm" ? "not_required" : "pending",
			capabilities: { readOnly: task.input.read_only === true || task.input.subagent_type === "rlm", permissionMode: task.ctx.permissions?.mode },
			...(task.parentBatchToolCallId ? { parentBatchToolCallId: task.parentBatchToolCallId } : {}),
			createdAt: this.now().toISOString(),
		};
		const controller = new AbortController();
		this.controllers.set(task.handle, controller);
		const signal = AbortSignal.any([task.ctx.signal, controller.signal]);
		try {
			await this.persist(queued);
			this.publish(task, this.requireRecord(task.handle));
			if (signal.aborted || generation !== this.cancellationGeneration) {
				const cancelled: AgentTaskRecord = {
					...queued,
					status: "cancelled",
					executionStatus: "cancelled",
					integrationStatus: queued.readOnly ? "not_required" : "skipped",
					execution: {
						outcome: "failure",
						failureCategory: "cancelled",
						cancelled: true,
						retryable: false,
					},
					finishedAt: this.now().toISOString(),
					error: "Worker cancelled before execution.",
				};
				try {
					await this.persist(cancelled);
					this.publish(task, this.requireRecord(task.handle));
					task.ctx.bus.emit({ type: "agent:child_end", agentToolCallId: task.handle, status: "cancelled" });
				} catch (error) {
					this.records.set(task.handle, {
						...cancelled,
						persistenceError: errorMessage(error),
					});
				}
				throw new AbortError();
			}
			const operation = this.execute(task, signal).finally(() => {
				this.controllers.delete(task.handle);
				this.operations.delete(task.handle);
			});
			this.operations.set(task.handle, operation);
			void operation.catch(() => undefined);
			return this.records.get(task.handle) ?? queued;
		} catch (error) {
			this.controllers.delete(task.handle);
			if (signal.aborted || generation !== this.cancellationGeneration)
				throw new AbortError();
			throw error;
		}
	}

	async wait(
		handles: readonly string[],
		sessionId: string,
		signal: AbortSignal,
		timeoutMs?: number,
		returnWhen: "all" | "any" = "all",
	): Promise<AgentTaskRecord[]> {
		throwIfAborted(signal);
		await this.initialize();
		throwIfAborted(signal);
		this.validateHandles(handles, sessionId);
		const operations = handles.flatMap((handle) => {
			const operation = this.operations.get(handle);
			return operation ? [operation] : [];
		});
		const hasFinished = handles.some((handle) =>
			isTerminalTask(this.requireRecord(handle)),
		);
		if (operations.length > 0 && !(returnWhen === "any" && hasFinished)) {
			await waitForOperations(operations, signal, timeoutMs, returnWhen);
		}
		throwIfAborted(signal);
		return handles.map((handle) => cloneRecord(this.requireRecord(handle)));
	}

	list(): AgentTaskRecord[] {
		return [...this.records.values()].map(cloneRecord);
	}

	cancelAll(): void {
		this.cancellationGeneration++;
		for (const controller of this.controllers.values()) controller.abort();
	}

	async waitForIdle(): Promise<void> {
		// Registrations can still be waiting for their durable queued write and
		// are not operations yet. Drain both, including operations they create.
		while (this.registrations.size > 0 || this.operations.size > 0) {
			await Promise.allSettled([
				...[...this.registrations.values()].map(
					(registration) => registration.promise,
				),
				...this.operations.values(),
			]);
		}
		for (const [handle, record] of this.records) {
			if (record.persistenceError) {
				const { persistenceError: _error, ...persisted } = record;
				// A failed upsert may fail before it queues the terminal record.
				// Confirm that exact captured result, not merely earlier store work.
				await this.options.store?.upsert(persisted);
				this.records.set(handle, persisted);
			}
		}
		await this.options.store?.flush();
	}

	private async execute(
		task: SpawnAgentTask,
		signal: AbortSignal,
	): Promise<void> {
		let finished = false;
		let progressTail = Promise.resolve();
		let started = false;
		const update = (change: Partial<AgentTaskRecord>): Promise<void> => {
			if (finished) return progressTail;
			progressTail = progressTail.catch(() => undefined).then(async () => {
				const current = this.requireRecord(task.handle);
				if (change.workspace && current.workspace?.revision !== undefined && (change.workspace.revision === undefined || change.workspace.revision <= current.workspace.revision)) return;
				await this.persist({ ...current, ...change });
				this.publish(task, this.requireRecord(task.handle));
			});
			void progressTail.catch(() => undefined);
			return progressTail;
		};
		const onStarted = (): Promise<void> => {
			if (finished || started) return progressTail;
			throwIfAborted(signal);
			started = true;
			return update({ status: "running", executionStatus: "running", startedAt: this.now().toISOString() });
		};
		const onWorkspaceProgress = (worker: WorkerWorkspaceRecord): void => {
			update({
				workspace: structuredClone(workerProgress(worker)),
				executionStatus: worker.executionStatus === "creating" ? "preparing" : worker.executionStatus,
				integrationStatus: worker.integrationStatus,
			});
		};
		let terminal: AgentTaskRecord;
		try {
			throwIfAborted(signal);
			if (!task.reportsWorkerStart) await onStarted();
			throwIfAborted(signal);
			const result = await task.run(
				task.input,
				{
					...task.ctx,
					signal,
					toolCallId: task.handle,
					workerLifecycle: { onWorkspaceProgress },
				},
				onStarted,
			);
			await progressTail.catch(() => undefined);
			const current = this.requireRecord(task.handle);
			const finishedAt = this.now().toISOString();
			const bundle: AgentTaskResultBundle = {
				data: result.data,
				forLLM: result.forLLM,
				title: result.title,
				...(result.detail === undefined ? {} : { detail: result.detail }),
				completedAt: finishedAt,
			};
			const outcome = classifyAgentResult(result, signal);
			terminal = {
				...current,
				status: outcome.status,
				executionStatus: current.workspace ? current.executionStatus : outcome.status,
				integrationStatus: current.workspace ? current.integrationStatus : "not_required",
				finishedAt,
				result: bundle,
				...(result.execution ? { execution: result.execution } : {}),
				...(outcome.error ? { error: outcome.error } : {}),
			};
		} catch (error) {
			await progressTail.catch(() => undefined);
			const current = this.requireRecord(task.handle);
			terminal = {
				...current,
				executionStatus: signal.aborted ? "cancelled" : "failed",
				status: signal.aborted ? "cancelled" : "failed",
				finishedAt: this.now().toISOString(),
				error: errorMessage(error),
				execution: {
					...toolFailureMetadata(error),
					outcome: "failure",
					...(signal.aborted
						? { failureCategory: "cancelled", cancelled: true }
						: {}),
				},
			};
		}
		finished = true;
		await progressTail.catch(() => undefined);
		try {
			await this.persist(terminal);
			this.publish(task, this.requireRecord(task.handle));
			task.ctx.bus.emit({ type: "agent:child_end", agentToolCallId: task.handle, status: terminal.status === "completed" ? "completed" : terminal.status === "cancelled" ? "cancelled" : "failed" });
		} catch (error) {
			// Preserve captured results and integration authority in memory. A
			// persistence fault is reported separately and must never rerun writes.
			this.records.set(task.handle, {
				...terminal,
				revision: (this.records.get(task.handle)?.revision ?? 0) + 1,
				persistenceError: errorMessage(error),
			});
			this.publish(task, this.requireRecord(task.handle));
			task.ctx.bus.emit({ type: "agent:child_end", agentToolCallId: task.handle, status: "failed" });
			throw error;
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
			const workspace = this.findWorker(recovered);
			const needsProjection = recovered.revision === undefined || recovered.executionStatus === undefined || recovered.integrationStatus === undefined || recovered !== record || (workspace && (workspace.revision ?? 0) > (recovered.workspace?.revision ?? 0));
			if (needsProjection) {
				recovered = { ...recovered,
					revision: (record.revision ?? 0) + 1,
					executionStatus: workspace && recovered.status !== "interrupted" ? (workspace.executionStatus === "creating" ? "preparing" : workspace.executionStatus) : recovered.status,
					integrationStatus: workspace?.integrationStatus ?? (recovered.readOnly || recovered.result?.data.mode === "rlm" ? "not_required" : recovered.status === "completed" ? "integrated" : "skipped"),
					...(workspace ? { workspace: workerProgress(workspace) } : {}),
					capabilities: recovered.capabilities ?? { readOnly: recovered.readOnly },
				};
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
		const revised = { ...record, revision: (this.records.get(record.handle)?.revision ?? record.revision ?? 0) + 1 };
		await this.options.store?.upsert(revised);
		this.records.set(record.handle, revised);
	}

	private publish(task: SpawnAgentTask, record: AgentTaskRecord): void {
		const { result: _result, inputFingerprint: _identity, execution: _execution, ...worker } = cloneRecord(record);
		task.ctx.bus.emit({ type: "agent:worker_update", agentToolCallId: record.handle, ...(record.parentBatchToolCallId ? { parentBatchToolCallId: record.parentBatchToolCallId } : {}), worker });
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
	timeoutMs: number | undefined,
	returnWhen: "all" | "any",
): Promise<void> {
	throwIfAborted(signal);
	const settled = operations.map((operation) =>
		operation.then(
			() => undefined,
			() => undefined,
		),
	);
	const ready =
		returnWhen === "any" ? Promise.race(settled) : Promise.all(settled);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const interrupted = new Promise<void>((resolve, reject) => {
		abortListener = () => reject(new AbortError());
		signal.addEventListener("abort", abortListener, { once: true });
		if (timeoutMs !== undefined) {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}
	});
	try {
		await Promise.race([ready, interrupted]);
	} finally {
		if (timer) clearTimeout(timer);
		if (abortListener) signal.removeEventListener("abort", abortListener);
	}
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
	return structuredClone(record);
}

function isTerminalTask(record: AgentTaskRecord): boolean {
	return record.status !== "queued" && record.status !== "running";
}

function taskIdentity(task: SpawnAgentTask): string {
	const input = { ...task.input };
	delete input.name; // A display-label change must not schedule duplicate work.
	return toolInputFingerprint({
		sessionId: task.ctx.sessionId,
		turnId: task.ctx.turnId ?? null,
		cwd: resolve(task.ctx.cwd),
		...(task.parentBatchToolCallId ? { parentBatchToolCallId: task.parentBatchToolCallId } : {}),
		input: {
			...input,
			subagent_type: task.input.subagent_type ?? "worker",
			read_only: task.input.read_only === true,
		},
	});
}

function matchesTask(
	record: AgentTaskRecord,
	task: SpawnAgentTask,
	identity: string,
): boolean {
	if (record.inputFingerprint) return record.inputFingerprint === identity;
	// Version-1 records predate full input fingerprints. Only their supported
	// spawn shape can be replayed; never alias new options to an old task.
	return (
		record.sessionId === task.ctx.sessionId &&
		record.prompt === task.input.prompt &&
		record.readOnly === (task.input.read_only === true) &&
		(record.turnId === undefined ||
			task.ctx.turnId === undefined ||
			record.turnId === task.ctx.turnId) &&
		(task.input.subagent_type === undefined ||
			task.input.subagent_type === "worker") &&
		task.input.variables === undefined &&
		task.input.timeout_ms === undefined
	);
}
