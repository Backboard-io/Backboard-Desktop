import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentTaskManager,
	type SpawnAgentTask,
} from "../src/core/agent/AgentTaskManager.ts";
import { AgentTaskStore } from "../src/core/agent/AgentTaskStore.ts";
import type { AgentTaskRecord } from "../src/core/agent/AgentTaskTypes.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { AgentSpawnTool } from "../src/tools/AgentSpawnTool.tsx";
import type { AgentToolOutput } from "../src/tools/AgentToolTypes.ts";
import { AgentWaitTool } from "../src/tools/AgentWaitTool.tsx";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: "session",
		turnId: "turn",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		...overrides,
	};
}

function completed(
	report = "Completed and validated owned changes",
): ToolResult<AgentToolOutput> {
	return ok(
		{ mode: "worker", report, status: "completed", rounds: 1 },
		report,
		"Worker completed",
	);
}

function task(overrides: Partial<SpawnAgentTask> = {}): SpawnAgentTask {
	return {
		handle: "worker",
		input: { prompt: "Implement the owned file" },
		ctx: context(),
		run: async () => completed(),
		...overrides,
	};
}

/** Simulates disk barriers/faults without a provider or real model. */
class ControlledStore extends AgentTaskStore {
	readonly values = new Map<string, AgentTaskRecord>();
	readonly queueEntered = deferred();
	queueGate?: Promise<void>;
	loadGate?: Promise<void>;
	failQueued = false;
	failTerminal = false;
	override async load(): Promise<AgentTaskRecord[]> {
		await this.loadGate;
		return structuredClone([...this.values.values()]);
	}
	override async upsert(record: AgentTaskRecord): Promise<void> {
		if (record.status === "queued") {
			this.queueEntered.resolve();
			await this.queueGate;
			if (this.failQueued) throw new Error("simulated queued write failure");
		}
		if (
			this.failTerminal &&
			record.status !== "queued" &&
			record.status !== "running"
		)
			throw new Error("simulated disk write failure");
		this.values.set(record.handle, structuredClone(record));
	}
	override async flush(): Promise<void> {
		if (this.failTerminal) throw new Error("simulated disk write failure");
	}
}

describe("Agent task lifecycle", () => {
	it("persists cosmetic names while replaying the same handle without duplicate execution", async () => {
		const store = new ControlledStore("unused");
		const manager = new AgentTaskManager({ store });
		let executions = 0;
		const original = task({
			input: { name: "Search", prompt: "Inspect source" },
			run: async () => {
				executions++;
				return completed();
			},
		});
		await manager.spawn(original);
		await manager.waitForIdle();
		await manager.spawn({
			...original,
			input: { ...original.input, name: "Another label" },
		});
		expect(executions).toBe(1);
		expect(manager.list()[0]?.name).toBe("Search");
		const reopened = new AgentTaskManager({ store });
		await reopened.initialize();
		expect(reopened.list()[0]?.name).toBe("Search");
	});

	it("reports queued until preparation starts model work and ignores late start callbacks", async () => {
		const manager = new AgentTaskManager();
		const finished = deferred<ToolResult<AgentToolOutput>>();
		let start: (() => void | Promise<void>) | undefined;
		const record = await manager.spawn(
			task({
				reportsWorkerStart: true,
				run: (_input, _ctx, onStarted) => {
					start = onStarted;
					return finished.promise;
				},
			}),
		);
		expect(record.status).toBe("queued");
		expect(record.startedAt).toBeUndefined();
		const preparing = await new AgentWaitTool(manager).execute(
			{ handles: ["worker"], timeout_ms: 1 },
			context(),
		);
		expect(preparing.forLLM).toContain("model execution has not started");
		if (!start) throw new Error("missing start callback");
		await start();
		const running = manager.list()[0];
		expect(running?.status).toBe("running");
		expect(running?.startedAt).toBeDefined();
		await start();
		expect(manager.list()[0]?.startedAt).toBe(running?.startedAt);
		finished.resolve(completed());
		await manager.waitForIdle();
		await start();
		expect(manager.list()[0]?.status).toBe("completed");
	});

	it("cancels preparation without ever transitioning to running", async () => {
		const manager = new AgentTaskManager();
		const prepared = deferred();
		let starts = 0;
		await manager.spawn(
			task({
				reportsWorkerStart: true,
				run: async (_input, _ctx, onStarted) => {
					await prepared.promise;
					onStarted();
					starts++;
					return completed();
				},
			}),
		);
		manager.cancelAll();
		prepared.resolve();
		await manager.waitForIdle();
		expect(starts).toBe(0);
		expect(manager.list()[0]).toMatchObject({
			status: "cancelled",
			execution: { failureCategory: "cancelled" },
		});
		expect(manager.list()[0]?.startedAt).toBeUndefined();
	});

	it("does not expose an orphan handle after the initial durable write fails", async () => {
		const store = new ControlledStore("unused");
		store.failQueued = true;
		const manager = new AgentTaskManager({ store });
		let starts = 0;
		const original = task({
			run: async () => {
				starts++;
				return completed();
			},
		});
		await expect(manager.spawn(original)).rejects.toThrow(
			"queued write failure",
		);
		expect(manager.list()).toEqual([]);
		expect(starts).toBe(0);
		store.failQueued = false;
		await manager.spawn(original);
		await manager.waitForIdle();
		expect(starts).toBe(1);
		expect(manager.list()[0]?.status).toBe("completed");
	});

	it("shares a durable reservation for duplicate spawns and executes once", async () => {
		const store = new ControlledStore("unused");
		const gate = deferred();
		store.queueGate = gate.promise;
		const manager = new AgentTaskManager({ store });
		let starts = 0;
		const original = task({
			run: async () => {
				starts++;
				return completed();
			},
		});
		let firstReturned = false;
		let secondReturned = false;
		const first = manager.spawn(original).then((record) => {
			firstReturned = true;
			return record;
		});
		await store.queueEntered.promise;
		const second = manager.spawn(original).then((record) => {
			secondReturned = true;
			return record;
		});
		await Promise.resolve();
		expect(firstReturned).toBe(false);
		expect(secondReturned).toBe(false);
		expect(manager.list()).toEqual([]);
		expect(starts).toBe(0);
		await expect(
			manager.spawn(task({ input: { prompt: "Different task" } })),
		).rejects.toThrow("already in use");
		gate.resolve();
		const records = await Promise.all([first, second]);
		expect(records.map((record) => record.handle)).toEqual([
			"worker",
			"worker",
		]);
		await manager.waitForIdle();
		expect(starts).toBe(1);
		expect(manager.list()[0]?.status).toBe("completed");
	});

	it("cancels registration before any model runs and waits for its durable terminal state", async () => {
		const store = new ControlledStore("unused");
		const gate = deferred();
		store.queueGate = gate.promise;
		const manager = new AgentTaskManager({ store });
		let starts = 0;
		const spawned = manager.spawn(
			task({
				run: async () => {
					starts++;
					return completed();
				},
			}),
		);
		const rejected = spawned.catch((error: unknown) => error);
		await store.queueEntered.promise;
		manager.cancelAll();
		let idle = false;
		const drained = manager.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		gate.resolve();
		expect(await rejected).toMatchObject({
			name: "AbortError",
			message: "aborted",
		});
		await drained;
		expect(starts).toBe(0);
		expect(store.values.get("worker")?.status).toBe("cancelled");
		expect(manager.list()[0]?.status).toBe("cancelled");
	});

	it("does not start a registration cancelled while storage initializes", async () => {
		const store = new ControlledStore("unused");
		const gate = deferred();
		store.loadGate = gate.promise;
		const manager = new AgentTaskManager({ store });
		let starts = 0;
		const spawned = manager.spawn(
			task({
				run: async () => {
					starts++;
					return completed();
				},
			}),
		);
		const rejected = spawned.catch((error: unknown) => error);
		manager.cancelAll();
		gate.resolve();
		expect(await rejected).toMatchObject({
			name: "AbortError",
			message: "aborted",
		});
		await manager.waitForIdle();
		expect(starts).toBe(0);
		expect(manager.list()).toEqual([]);
	});

	it("honors already-aborted spawn and terminal wait calls", async () => {
		const manager = new AgentTaskManager();
		let starts = 0;
		const run = async () => {
			starts++;
			return completed();
		};
		const aborted = AbortSignal.abort();
		await expect(
			manager.spawn(task({ run, ctx: context({ signal: aborted }) })),
		).rejects.toThrow("aborted");
		expect(starts).toBe(0);
		await manager.spawn(task({ run }));
		await manager.waitForIdle();
		await expect(manager.wait(["worker"], "session", aborted)).rejects.toThrow(
			"aborted",
		);
		expect(starts).toBe(1);
	});

	it("fingerprints full arguments, session, turn and cwd while tolerating object key order", async () => {
		const manager = new AgentTaskManager();
		let starts = 0;
		const original = task({
			input: {
				prompt: "analyze",
				subagent_type: "rlm",
				variables: { a: 1, b: { x: true, y: 2 } },
				timeout_ms: 500,
			},
			run: async () => {
				starts++;
				return completed();
			},
		});
		await manager.spawn(original);
		await manager.waitForIdle();
		const retry = await manager.spawn({
			...original,
			input: {
				timeout_ms: 500,
				variables: { b: { y: 2, x: true }, a: 1 },
				subagent_type: "rlm",
				prompt: "analyze",
				read_only: false,
			},
		});
		expect(retry.status).toBe("completed");
		expect(starts).toBe(1);
		const different = [
			{ ...original, input: { ...original.input, timeout_ms: 501 } },
			{ ...original, input: { ...original.input, variables: { a: 2 } } },
			{
				...original,
				input: { ...original.input, subagent_type: "worker" as const },
			},
			{ ...original, ctx: context({ sessionId: "other" }) },
			{ ...original, ctx: context({ turnId: "other" }) },
			{ ...original, ctx: context({ cwd: join(process.cwd(), "other") }) },
		];
		for (const conflicting of different)
			await expect(manager.spawn(conflicting)).rejects.toThrow(
				"already in use",
			);
	});

	it("returns on the first finished worker without waiting for an unrelated straggler", async () => {
		const manager = new AgentTaskManager();
		const fast = deferred<ToolResult<AgentToolOutput>>();
		const slow = deferred<ToolResult<AgentToolOutput>>();
		await Promise.all([
			manager.spawn(task({ handle: "fast", run: () => fast.promise })),
			manager.spawn(task({ handle: "slow", run: () => slow.promise })),
		]);
		const wait = new AgentWaitTool(manager);
		const waiting = wait.execute(
			{ handles: ["fast", "slow"], return_when: "any" },
			context(),
		);
		fast.resolve(completed("first report"));
		const first = await waiting;
		expect(first.data).toMatchObject({
			timedOut: false,
			completedCount: 1,
			pendingHandles: ["slow"],
		});
		expect(first.data.tasks[0]?.result?.forLLM).toBe("first report");
		const deadline = await wait.execute(
			{ handles: ["slow"], timeout_ms: 1 },
			context(),
		);
		expect(deadline.data).toMatchObject({
			timedOut: true,
			completedCount: 0,
			pendingHandles: ["slow"],
		});
		expect(deadline.execution).toBeUndefined();
		expect(deadline.forLLM).toContain("continue running");
		slow.resolve(completed("second report"));
		const joined = await wait.execute({ handles: ["slow"] }, context());
		expect(joined.data).toMatchObject({
			timedOut: false,
			completedCount: 1,
			pendingHandles: [],
		});
		await manager.waitForIdle();
	});

	it("keeps captured results after a terminal persistence failure and never repeats the worker", async () => {
		const store = new ControlledStore("unused");
		store.failTerminal = true;
		const manager = new AgentTaskManager({ store });
		let starts = 0;
		const run = async () => {
			starts++;
			return completed("Files are already integrated.");
		};
		await manager.spawn(task({ run }));
		const result = await new AgentWaitTool(manager).execute(
			{ handles: ["worker"] },
			context(),
		);
		expect(result.data.tasks[0]).toMatchObject({
			status: "completed",
			persistenceError: "simulated disk write failure",
			result: { forLLM: "Files are already integrated." },
		});
		expect(result.execution).toMatchObject({
			outcome: "failure",
			retryable: false,
		});
		expect(result.forLLM).toContain("do not rerun");
		const replay = await new AgentSpawnTool({ execute: run }, manager).execute(
			task().input,
			context({ toolCallId: "worker" }),
		);
		expect(replay.data.status).toBe("completed");
		expect(replay.forLLM).toContain("No new worker");
		expect(starts).toBe(1);
		expect(store.values.get("worker")?.status).toBe("running");
		store.failTerminal = false;
		await manager.waitForIdle();
		expect(manager.list()[0]?.persistenceError).toBeUndefined();
		expect(store.values.get("worker")?.result?.forLLM).toBe(
			"Files are already integrated.",
		);
	});

	it("does not leave a zombie queued task when cancellation persistence fails", async () => {
		const store = new ControlledStore("unused");
		const gate = deferred();
		store.queueGate = gate.promise;
		store.failTerminal = true;
		const manager = new AgentTaskManager({ store });
		const spawned = manager.spawn(task());
		const rejected = spawned.catch((error: unknown) => error);
		await store.queueEntered.promise;
		manager.cancelAll();
		gate.resolve();
		expect(await rejected).toMatchObject({
			name: "AbortError",
			message: "aborted",
		});
		const result = await new AgentWaitTool(manager).execute(
			{ handles: ["worker"] },
			context(),
		);
		expect(result.data.tasks[0]).toMatchObject({
			status: "cancelled",
			persistenceError: "simulated disk write failure",
		});
		expect(result.forLLM).toContain("Persistence error");
		store.failTerminal = false;
		await manager.waitForIdle();
	});

	it("isolates nested result snapshots from callers", async () => {
		const manager = new AgentTaskManager();
		const result = completed();
		result.data.worker = {
			workerId: "worker",
			status: "Conflict",
			changedFileCount: 1,
			startedAt: "now",
			conflictingFiles: ["owned.ts"],
		};
		await manager.spawn(task({ run: async () => result }));
		await manager.waitForIdle();
		const snapshot = manager.list();
		snapshot[0]?.result?.data.worker?.conflictingFiles?.push("unexpected.ts");
		expect(manager.list()[0]?.result?.data.worker?.conflictingFiles).toEqual([
			"owned.ts",
		]);
	});
});

describe("Agent task failure metadata", () => {
	it("preserves mechanical failures through detached completion and joining", async () => {
		const manager = new AgentTaskManager();
		await Promise.all([
			manager.spawn(
				task({
					handle: "permission",
					run: async () => {
						throw Object.assign(new Error("denied"), { code: "EACCES" });
					},
				}),
			),
			manager.spawn(
				task({
					handle: "unavailable",
					run: async () => ({
						...completed("integration unavailable"),
						data: { ...completed().data, status: "failed" },
						execution: {
							outcome: "failure",
							failureCategory: "unavailable",
							retryable: false,
						},
					}),
				}),
			),
			manager.spawn(
				task({
					handle: "rejected",
					run: async () => ({
						...completed("worker limit reached"),
						data: { ...completed().data, status: "rejected" },
					}),
				}),
			),
		]);
		const wait = new AgentWaitTool(manager);
		expect(
			(await wait.execute({ handles: ["permission"] }, context())).execution
				?.failureCategory,
		).toBe("permission");
		expect(
			(await wait.execute({ handles: ["unavailable"] }, context())).execution
				?.failureCategory,
		).toBe("unavailable");
		expect(
			(await wait.execute({ handles: ["rejected"] }, context())).execution
				?.failureCategory,
		).toBe("unavailable");
		expect(
			(
				await wait.execute(
					{ handles: ["permission", "unavailable"] },
					context(),
				)
			).execution?.failureCategory,
		).toBe("unknown");
		await manager.waitForIdle();
	});
});

describe("Agent task store integrity", () => {
	it("rejects malformed or unsupported stores without replacing the existing file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-store-validation-"));
		try {
			const path = join(directory, "tasks.json");
			const record: AgentTaskRecord = {
				handle: "worker",
				sessionId: "session",
				prompt: "inspect",
				readOnly: true,
				status: "completed",
				createdAt: "now",
			};
			for (const data of [
				{ version: 2, tasks: [record] },
				{ version: 1, tasks: [{ ...record, status: "unknown" }] },
				{ version: 1, tasks: [{ ...record, result: { data: {} } }] },
				{
					version: 1,
					tasks: [{ ...record, execution: { cancelled: "false" } }],
				},
				{ version: 1, tasks: [record, record] },
			]) {
				const original = JSON.stringify(data);
				await writeFile(path, original);
				const store = new AgentTaskStore(path);
				await expect(store.load()).rejects.toThrow();
				await expect(store.upsert(record)).rejects.toThrow();
				expect(await readFile(path, "utf8")).toBe(original);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("round-trips completed reports and protects deeply nested stored results", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-store-results-"));
		try {
			const path = join(directory, "tasks.json");
			const store = new AgentTaskStore(path);
			const result = completed();
			result.data.worker = {
				workerId: "worker",
				status: "Integrated",
				changedFileCount: 1,
				startedAt: "now",
				conflictingFiles: [],
			};
			const record: AgentTaskRecord = {
				handle: "worker",
				sessionId: "session",
				prompt: "implement",
				readOnly: false,
				status: "completed",
				createdAt: "now",
				inputFingerprint: "fingerprint",
				result: {
					data: result.data,
					forLLM: result.forLLM,
					title: result.title,
					completedAt: "now",
				},
			};
			await store.upsert(record);
			record.result?.data.worker?.conflictingFiles?.push("unrelated.ts");
			const loaded = await new AgentTaskStore(path).load();
			expect(loaded[0]?.result?.data.worker?.conflictingFiles).toEqual([]);
			expect(loaded[0]?.inputFingerprint).toBe("fingerprint");
			loaded[0]?.result?.data.worker?.conflictingFiles?.push(
				"also-unrelated.ts",
			);
			expect(
				(await store.load())[0]?.result?.data.worker?.conflictingFiles,
			).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
