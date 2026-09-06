import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskManager } from "../src/core/agent/AgentTaskManager.ts";
import { AgentTaskStore } from "../src/core/agent/AgentTaskStore.ts";
import type { AgentTaskRecord } from "../src/core/agent/AgentTaskTypes.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ALLOW_ONCE } from "../src/core/permissions/PermissionPrompter.ts";
import { parseRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { WorkerWorkspaceUnavailableError } from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";
import {
	type AgentExecutionTool,
	AgentSpawnTool,
} from "../src/tools/AgentSpawnTool.tsx";
import { AgentTool } from "../src/tools/AgentTool.tsx";
import type { AgentToolOutput } from "../src/tools/AgentToolTypes.ts";
import { AgentWaitTool } from "../src/tools/AgentWaitTool.tsx";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: "sess_test",
		turnId: "turn_test",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		agentDepth: 0,
		...overrides,
	};
}

interface PendingWorker {
	resolve: (result: ToolResult<AgentToolOutput>) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

function controlledAgent(): {
	agent: AgentExecutionTool;
	starts: string[];
	waitStarted: (handle: string) => Promise<void>;
	complete: (handle: string, report?: string, status?: string) => void;
} {
	const starts: string[] = [];
	const waiters = new Map<string, () => void>();
	const pending = new Map<string, PendingWorker>();
	return {
		agent: {
			execute: async (_input, ctx) => {
				const handle = ctx.toolCallId;
				if (!handle) throw new Error("missing handle");
				starts.push(handle);
				waiters.get(handle)?.();
				return await new Promise<ToolResult<AgentToolOutput>>(
					(resolve, reject) => {
						const onAbort = () => {
							pending.delete(handle);
							reject(new Error("worker aborted"));
						};
						ctx.signal.addEventListener("abort", onAbort, { once: true });
						pending.set(handle, {
							resolve,
							reject,
							cleanup: () => ctx.signal.removeEventListener("abort", onAbort),
						});
					},
				);
			},
		},
		starts,
		waitStarted: (handle) => starts.includes(handle) ? Promise.resolve() : new Promise<void>(resolve => { waiters.set(handle, resolve); }),
		complete: (handle, report = `report:${handle}`, status = "completed") => {
			const worker = pending.get(handle);
			if (!worker) throw new Error(`worker is not running: ${handle}`);
			pending.delete(handle);
			worker.cleanup();
			worker.resolve(
				ok(
					{
						mode: "worker",
						report,
						status,
						rounds: 1,
					},
					report,
					"Worker completed",
				),
			);
		},
	};
}

describe("AgentSpawnTool and AgentWaitTool", () => {
	it("accepts and forwards the same bounded display-name contract as Agent", async () => {
		const manager = new AgentTaskManager();
		let receivedName: string | undefined;
		const spawn = new AgentSpawnTool(
			{
				execute: async (input) => {
					receivedName = input.name;
					return ok(
						{ mode: "worker", report: "done", status: "completed", rounds: 1 },
						"done",
						"done",
					);
				},
			},
			manager,
		);
		for (const name of ["", "x".repeat(81), "two\nlines"])
			expect(() =>
				spawn.parseInput({ name, prompt: "Inspect source" }),
			).toThrow();
		const input = spawn.parseInput({
			name: " Search ",
			prompt: "Inspect source",
		});
		await spawn.execute(input, context({ toolCallId: "named-worker" }));
		await manager.waitForIdle();
		expect(receivedName).toBe("Search");
		expect(manager.list()[0]?.name).toBe("Search");
	});

	it("keeps preparation failures queued instead of claiming a worker started", async () => {
		const manager = new AgentTaskManager();
		let modelStarts = 0;
		const agent = new AgentTool({
			maxDepth: 1,
			runner: {
				run: async () => {
					modelStarts++;
					throw new Error("model must not start");
				},
			},
			createRLMLoop: () => {
				throw new Error("not RLM");
			},
			workspaceManager: {
				list: () => [],
				runWorker: async () => {
					throw new WorkerWorkspaceUnavailableError(
						"Synthetic private snapshot capability is unavailable.",
					);
				},
			},
		});
		const spawn = new AgentSpawnTool(agent, manager);
		const input = { prompt: "Implement an independently owned file" };
		const ctx = context({ toolCallId: "worker_preparation" });
		const result = await spawn.execute(input, ctx);
		expect(result.data.status).toBe("queued");
		expect(result.title).toBe("Worker queued");
		expect(result.forLLM).toContain("model execution has not started");
		const joined = await new AgentWaitTool(manager).execute(
			{ handles: ["worker_preparation"] },
			ctx,
		);
		expect(joined.data.tasks[0]?.startedAt).toBeUndefined();
		expect(joined.execution?.failureCategory).toBe("unavailable");
		expect(joined.forLLM).toContain("same workspace backend");
		const replay = await spawn.execute(input, ctx);
		expect(replay.data.status).toBe("failed");
		expect(replay.execution).toMatchObject({
			outcome: "failure",
			failureCategory: "unavailable",
			mutated: false,
		});
		expect(modelStarts).toBe(0);
		await manager.waitForIdle();
	});

	it("emits JSON Schema numeric exclusive bounds for Codex", () => {
		const parameters = new AgentWaitTool(new AgentTaskManager()).toJSONSchema()
			.function.parameters;
		const properties = parameters.properties as Record<string, unknown>;
		const timeout = properties.timeout_ms as Record<string, unknown>;

		expect(timeout).toMatchObject({
			type: "integer",
			exclusiveMinimum: 0,
		});
		expect(typeof timeout.exclusiveMinimum).toBe("number");
		expect(timeout).not.toHaveProperty("minimum");
	});

	it("returns a durable handle immediately while the worker keeps running", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);

		const result = await spawn.execute(
			{ prompt: "inspect independently" },
			context({ toolCallId: "worker_immediate" }),
		);

		expect(result.data).toEqual({
			handle: "worker_immediate",
			status: "queued",
		});
		await worker.waitStarted("worker_immediate");
		expect(worker.starts).toEqual(["worker_immediate"]);
		expect(manager.list()[0]?.status).toBe("running");

		await worker.waitStarted("worker_immediate");
		worker.complete("worker_immediate");
		await manager.waitForIdle();
	});

	it("starts three workers from one provider tool round concurrently", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(new ToolRegistry([spawn]), bus);
		let prompts = 0;
		const manualContext = context({
			bus,
			permissions: {
				mode: "manual",
				rules: parseRuleSet({}),
				interactive: true,
			},
			askUser: async () => {
				prompts++;
				return ALLOW_ONCE;
			},
		});

		const outputs = await scheduler.run(
			["a", "b", "c"].map((suffix) => ({
				id: `worker_${suffix}`,
				name: "AgentSpawn",
				input: { prompt: `task ${suffix}` },
			})),
			manualContext,
		);

		expect(outputs).toHaveLength(3);
		expect(prompts).toBe(1);
		expect(worker.starts.sort()).toEqual(["worker_a", "worker_b", "worker_c"]);
		expect(manager.list().every((task) => task.status === "running")).toBe(
			true,
		);

		for (const handle of worker.starts) worker.complete(handle);
		await manager.waitForIdle();
		const waitOutputs = await new ToolScheduler(
			new ToolRegistry([new AgentWaitTool(manager)]),
			bus,
		).run(
			[
				{
					id: "wait_workers",
					name: "AgentWait",
					input: { handles: worker.starts },
				},
			],
			manualContext,
		);
		expect(waitOutputs).toHaveLength(1);
		expect(prompts).toBe(1);
	});

	it("durably registers one spawn round before starting all three models", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-spawn-batch-"));
		try {
			const filePath = join(dir, "agent-tasks.json");
			const manager = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
			});
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const durableHandleCounts: number[] = [];
			let markAllStarted!: () => void;
			const allStarted = new Promise<void>((resolve) => {
				markAllStarted = resolve;
			});
			const agent: AgentExecutionTool = {
				execute: async () => {
					const data = JSON.parse(await readFile(filePath, "utf8")) as {
						tasks: AgentTaskRecord[];
					};
					durableHandleCounts.push(data.tasks.length);
					if (durableHandleCounts.length === 3) markAllStarted();
					await gate;
					return ok(
						{
							mode: "worker",
							report: "complete",
							status: "completed",
							rounds: 1,
						},
						"complete",
						"Worker completed",
					);
				},
			};
			const bus = new EventBus();
			const scheduler = new ToolScheduler(
				new ToolRegistry([new AgentSpawnTool(agent, manager)]),
				bus,
			);

			const outputs = await scheduler.run(
				["a", "b", "c"].map((suffix) => ({
					id: `durable_worker_${suffix}`,
					name: "AgentSpawn",
					input: { prompt: `task ${suffix}` },
				})),
				context({ bus }),
			);

			await allStarted;
			expect(outputs).toHaveLength(3);
			expect(durableHandleCounts).toEqual([3, 3, 3]);
			release();
			await manager.waitForIdle();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("waits selectively and returns completed results idempotently", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		const wait = new AgentWaitTool(manager);
		await Promise.all([
			spawn.execute({ prompt: "fast" }, context({ toolCallId: "worker_fast" })),
			spawn.execute({ prompt: "slow" }, context({ toolCallId: "worker_slow" })),
		]);
		await worker.waitStarted("worker_fast");
		worker.complete("worker_fast", "fast result");

		const first = await wait.execute({ handles: ["worker_fast"] }, context());
		const second = await wait.execute(
			{ handles: ["worker_fast", "worker_fast"] },
			context(),
		);

		expect(first.data.tasks).toHaveLength(1);
		expect(first.data.tasks[0]?.result?.forLLM).toBe("fast result");
		expect(second.data.tasks).toEqual(first.data.tasks);
		expect(
			manager.list().find((task) => task.handle === "worker_slow")?.status,
		).toBe("running");

		await worker.waitStarted("worker_slow");
		worker.complete("worker_slow");
		await manager.waitForIdle();
	});

	it("cancels detached workers and exposes a terminal join result", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		const wait = new AgentWaitTool(manager);
		await spawn.execute(
			{ prompt: "long task" },
			context({ toolCallId: "worker_cancel" }),
		);

		await worker.waitStarted("worker_cancel");
		manager.cancelAll();
		const result = await wait.execute(
			{ handles: ["worker_cancel"] },
			context(),
		);

		expect(result.data.tasks[0]).toMatchObject({
			handle: "worker_cancel",
			status: "cancelled",
			error: "worker aborted",
		});
	});

	it("keeps an integrated result completed when cancellation races final bookkeeping", async () => {
		const manager = new AgentTaskManager();
		let markStarted!: () => void;
		const started = new Promise<void>(resolve => { markStarted = resolve; });
		const agent: AgentExecutionTool = {
			execute: async (_input, ctx) =>
				await new Promise<ToolResult<AgentToolOutput>>((resolve) => {
					markStarted();
					ctx.signal.addEventListener(
						"abort",
						() =>
							resolve(
								ok(
									{
										mode: "worker",
										report: "files are already integrated",
										status: "integrated",
										rounds: 1,
									},
									"files are already integrated",
									"Worker integrated",
								),
							),
						{ once: true },
					);
				}),
		};
		const spawn = new AgentSpawnTool(agent, manager);
		await spawn.execute(
			{ prompt: "integrate then stop" },
			context({ toolCallId: "worker_capture_race" }),
		);

		await started;
		manager.cancelAll();
		const [record] = await manager.wait(
			["worker_capture_race"],
			"sess_test",
			new AbortController().signal,
		);

		expect(record).toMatchObject({
			handle: "worker_capture_race",
			status: "completed",
			result: { data: { status: "integrated" } },
		});
		expect(record?.error).toBeUndefined();
	});

	it("maps worker result statuses without mislabeling failures complete", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		const cases = [
			["completed", "completed"],
			["integrated", "completed"],
			["cancelled", "cancelled"],
			["timed_out", "failed"],
			["rejected", "failed"],
			["failed", "failed"],
			["conflict", "failed"],
		] as const;

		for (const [workerStatus, expectedTaskStatus] of cases) {
			const handle = `worker_status_${workerStatus}`;
			await spawn.execute(
				{ prompt: `return ${workerStatus}` },
				context({ toolCallId: handle }),
			);
			await worker.waitStarted(handle);
			worker.complete(handle, `${workerStatus} report`, workerStatus);
			const [task] = await manager.wait(
				[handle],
				"sess_test",
				new AbortController().signal,
			);

			expect(task?.status).toBe(expectedTaskStatus);
			expect(task?.result?.data.status).toBe(workerStatus);
			if (expectedTaskStatus === "completed") {
				expect(task?.error).toBeUndefined();
			} else {
				expect(task?.error).toContain(workerStatus);
			}
		}
	});

	it("rejects cross-session joins", async () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		await spawn.execute(
			{ prompt: "session task" },
			context({ toolCallId: "worker_session" }),
		);

		await expect(
			manager.wait(
				["worker_session"],
				"another_session",
				new AbortController().signal,
			),
		).rejects.toThrow("another session");

		await worker.waitStarted("worker_session");
		worker.complete("worker_session");
		await manager.waitForIdle();
	});

	it("advertises spawn and wait semantics in every model profile", () => {
		const manager = new AgentTaskManager();
		const worker = controlledAgent();
		const spawn = new AgentSpawnTool(worker.agent, manager);
		const wait = new AgentWaitTool(manager);
		for (const profile of ["default", "openai", "anthropic", "glm"] as const) {
			expect(spawn.prompt({ profile })).toContain("AgentWait");
			expect(wait.prompt({ profile })).toContain("AgentSpawn");
		}
	});
});

describe("AgentTaskStore recovery", () => {
	it("restores completed durable result bundles after restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-tasks-completed-"));
		try {
			const filePath = join(dir, "agent-tasks.json");
			const first = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
			});
			const worker = controlledAgent();
			await new AgentSpawnTool(worker.agent, first).execute(
				{ prompt: "durable task", read_only: true },
				context({ toolCallId: "worker_durable" }),
			);
			await worker.waitStarted("worker_durable");
			worker.complete("worker_durable", "durable result");
			await first.waitForIdle();

			const restarted = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
			});
			await restarted.initialize();
			const result = await new AgentWaitTool(restarted).execute(
				{ handles: ["worker_durable"] },
				context(),
			);

			expect(result.data.tasks[0]).toMatchObject({
				handle: "worker_durable",
				readOnly: true,
				status: "completed",
				result: {
					forLLM: "durable result",
					data: { mode: "worker", status: "completed" },
				},
			});
			expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
				version: 1,
				tasks: [{ handle: "worker_durable", status: "completed" }],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("marks queued and running records interrupted on restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-tasks-interrupted-"));
		try {
			const filePath = join(dir, "agent-tasks.json");
			const store = new AgentTaskStore(filePath);
			const base: Omit<AgentTaskRecord, "handle" | "prompt" | "status"> = {
				sessionId: "sess_test",
				readOnly: false,
				createdAt: new Date(0).toISOString(),
			};
			await store.replace([
				{
					...base,
					handle: "worker_queued",
					prompt: "queued task",
					status: "queued",
				},
				{
					...base,
					handle: "worker_running",
					prompt: "running task",
					status: "running",
					startedAt: new Date(1).toISOString(),
				},
			]);

			const restarted = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
			});
			await restarted.initialize();
			const records = await restarted.wait(
				["worker_queued", "worker_running"],
				"sess_test",
				new AbortController().signal,
			);

			expect(records.map((record) => record.status)).toEqual([
				"interrupted",
				"interrupted",
			]);
			expect(records.every((record) => record.finishedAt !== undefined)).toBe(
				true,
			);
			expect(
				(
					JSON.parse(await readFile(filePath, "utf8")) as {
						tasks: AgentTaskRecord[];
					}
				).tasks.map((record) => record.status),
			).toEqual(["interrupted", "interrupted"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reconciles proven workspace outcomes without recovering lost reports as success", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-tasks-reconciled-"));
		try {
			const filePath = join(dir, "agent-tasks.json");
			const taskStore = new AgentTaskStore(filePath);
			const createdAt = new Date(0).toISOString();
			const handles = [
				"worker_integrated",
				"worker_conflict",
				"worker_cancelled",
				"worker_read_only",
			];
			await taskStore.replace(
				handles.map((handle) => ({
					handle,
					sessionId: "sess_test",
					prompt: handle,
					readOnly: handle === "worker_read_only",
					status: "running" as const,
					createdAt,
				})),
			);
			const baseWorker: Omit<
				WorkerWorkspaceRecord,
				| "workerId"
				| "taskPrompt"
				| "readOnly"
				| "changedFiles"
				| "executionStatus"
				| "integrationStatus"
			> = {
				sequence: 0,
				parentSessionId: "sess_test",
				coordinatorCwd: "/coordinator",
				startedAt: createdAt,
				finishedAt: new Date(1).toISOString(),
			};
			const workers: WorkerWorkspaceRecord[] = [
				{
					...baseWorker,
					workerId: "worker_integrated",
					taskPrompt: "worker_integrated",
					readOnly: false,
					changedFiles: ["src/a.ts"],
					resultCommit: "result-a",
					executionStatus: "completed",
					integrationStatus: "integrated",
				},
				{
					...baseWorker,
					workerId: "worker_conflict",
					taskPrompt: "worker_conflict",
					readOnly: false,
					changedFiles: ["src/shared.ts"],
					conflictingFiles: ["src/shared.ts"],
					resultCommit: "result-conflict",
					executionStatus: "completed",
					integrationStatus: "conflict",
				},
				{
					...baseWorker,
					workerId: "worker_cancelled",
					taskPrompt: "worker_cancelled",
					readOnly: false,
					changedFiles: [],
					executionStatus: "cancelled",
					integrationStatus: "skipped",
					error: "cancelled during model execution",
				},
				{
					...baseWorker,
					workerId: "worker_read_only",
					taskPrompt: "worker_read_only",
					readOnly: true,
					changedFiles: [],
					executionStatus: "completed",
					integrationStatus: "not_required",
				},
			];
			const restarted = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
				workerWorkspaces: { list: () => workers },
			});
			await restarted.initialize();
			const records = new Map(
				restarted.list().map((record) => [record.handle, record]),
			);

			expect(records.get("worker_integrated")).toMatchObject({
				status: "completed",
				result: {
					data: { status: "completed" },
				},
			});
			expect(records.get("worker_conflict")).toMatchObject({
				status: "failed",
				result: {
					data: { status: "conflict" },
				},
			});
			expect(records.get("worker_cancelled")).toMatchObject({
				status: "cancelled",
				error: "cancelled during model execution",
			});
			expect(records.get("worker_read_only")).toMatchObject({
				status: "interrupted",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("upgrades an interrupted write task when a later restart proves integration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-tasks-late-integration-"));
		try {
			const filePath = join(dir, "agent-tasks.json");
			const taskStore = new AgentTaskStore(filePath);
			await taskStore.replace([
				{
					handle: "worker_late",
					sessionId: "sess_test",
					prompt: "late integration",
					readOnly: false,
					status: "running",
					createdAt: new Date(0).toISOString(),
				},
			]);
			const worker: WorkerWorkspaceRecord = {
				workerId: "worker_late",
				sequence: 0,
				parentSessionId: "sess_test",
				taskPrompt: "late integration",
				readOnly: false,
				coordinatorCwd: "/coordinator",
				startingCommit: "base",
				resultCommit: "result",
				changedFiles: ["src/late.ts"],
				startedAt: new Date(0).toISOString(),
				finishedAt: new Date(1).toISOString(),
				executionStatus: "completed",
				integrationStatus: "pending",
			};
			const firstRestart = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
				workerWorkspaces: { list: () => [worker] },
			});
			await firstRestart.initialize();
			expect(firstRestart.list()[0]?.status).toBe("interrupted");

			worker.integrationStatus = "integrated";
			worker.integrationCommit = "merge-result";
			worker.integratedAt = new Date(2).toISOString();
			const secondRestart = new AgentTaskManager({
				store: new AgentTaskStore(filePath),
				workerWorkspaces: { list: () => [worker] },
			});
			await secondRestart.initialize();

			expect(secondRestart.list()[0]).toMatchObject({
				status: "completed",
				result: {
					data: { status: "completed" },
				},
			});
			expect(
				(
					JSON.parse(await readFile(filePath, "utf8")) as {
						tasks: AgentTaskRecord[];
					}
				).tasks[0]?.status,
			).toBe("completed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
