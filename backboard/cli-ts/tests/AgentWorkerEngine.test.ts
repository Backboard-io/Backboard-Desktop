/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "bun:test";
import { AgentTaskManager } from "../src/core/agent/AgentTaskManager.ts";
import { AgentTaskStore } from "../src/core/agent/AgentTaskStore.ts";
import type { AgentTaskRecord } from "../src/core/agent/AgentTaskTypes.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ok } from "../src/core/tools/ToolResult.ts";
import { AgentSpawnBatchTool } from "../src/tools/AgentSpawnBatchTool.tsx";
import { AgentCancelTool } from "../src/tools/AgentCancelTool.tsx";
import { AgentTool } from "../src/tools/AgentTool.tsx";
import type { AgentExecutionTool } from "../src/tools/AgentSpawnTool.tsx";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";
import { getToolPrompt } from "../src/prompts/tools/index.tsx";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function context(): ToolContext { return { sessionId: "session", turnId: "turn", toolCallId: "batch", cwd: process.cwd(), bus: new EventBus(), signal: new AbortController().signal, askUser: async () => "" }; }
function result() { return ok({ mode: "worker" as const, report: "done", status: "completed", rounds: 1 }, "done", "Done"); }
class MemoryStore extends AgentTaskStore {
	readonly values = new Map<string, AgentTaskRecord>();
	gate?: Promise<void>;
	failHandle?: string;
	override async load() { return [...this.values.values()].map(record => structuredClone(record)); }
	override async upsert(record: AgentTaskRecord) {
		if (record.status === "queued") await this.gate;
		if (record.handle === this.failHandle) throw new Error("disk failed");
		this.values.set(record.handle, structuredClone(record));
	}
	override async replace(records: readonly AgentTaskRecord[]) { this.values.clear(); for (const record of records) this.values.set(record.handle, structuredClone(record)); }
	override async flush() {}
}

describe("unified worker engine", () => {
	it("registers every batch member durably before any model starts, and replays without duplicate work", async () => {
		const store = new MemoryStore("unused");
		const gate = deferred<void>(); store.gate = gate.promise;
		const tasks = new AgentTaskManager({ store });
		const ctx = context();
		let starts = 0;
		const agent: AgentExecutionTool = { execute: async () => { expect(store.values.size).toBe(3); starts++; return result(); } };
		const batch = new AgentSpawnBatchTool(agent, tasks);
		const input = { workers: ["A", "B", "C"].map(name => ({ name, prompt: `Write ${name}` })) };
		const first = batch.execute(input, ctx);
		await Promise.resolve(); expect(starts).toBe(0);
		gate.resolve();
		const response = await first; await tasks.waitForIdle();
		const replay = await batch.execute({ workers: input.workers.map(worker => ({ ...worker, name: "Cosmetic change" })) }, ctx);
		expect(replay.data.handles).toEqual(response.data.handles);
		expect(starts).toBe(3);
		await expect(batch.execute({ workers: [{ prompt: "Different assignment" }, ...input.workers.slice(1)] }, ctx)).rejects.toThrow("already in use");
		expect(starts).toBe(3);
	});

	it("preflights a conflicting batch before scheduling otherwise-new workers", async () => {
		const manager = new AgentTaskManager(); const ctx = context(); let starts = 0;
		const run = async () => { starts++; return result(); };
		await manager.spawn({ handle: "existing", input: { prompt: "original" }, ctx, run }); await manager.waitForIdle();
		await expect(manager.spawnBatch([
			{ handle: "new", input: { prompt: "new" }, ctx, run },
			{ handle: "existing", input: { prompt: "conflict" }, ctx, run },
		])).rejects.toThrow("already in use");
		expect(manager.list().map(task => task.handle)).toEqual(["existing"]); expect(starts).toBe(1);
	});

	it("does not launch any batch member when durable registration fails", async () => {
		const store = new MemoryStore("unused"); store.failHandle = "bad";
		const manager = new AgentTaskManager({ store }); const ctx = context(); let starts = 0;
		const run = async () => { starts++; return result(); };
		await expect(manager.spawnBatch(["good", "bad"].map(handle => ({ handle, input: { prompt: handle }, ctx, run })))).rejects.toThrow("disk failed");
		await manager.waitForIdle(); expect(starts).toBe(0);
		expect(manager.list().find(task => task.handle === "good")?.status).toBe("cancelled");
	});

	it("publishes ordered durable state and a terminal edge only after the report is stored", async () => {
		const store = new MemoryStore("unused"); const manager = new AgentTaskManager({ store }); const ctx = context();
		const revisions: number[] = []; const phases: string[] = [];
		ctx.bus.on("agent:worker_update", event => {
			const durable = store.values.get(event.agentToolCallId)!;
			expect(durable.revision).toBe(event.worker.revision);
			revisions.push(event.worker.revision!); phases.push(event.worker.executionStatus!);
		});
		ctx.bus.on("agent:child_end", event => { expect(store.values.get(event.agentToolCallId)?.result?.forLLM).toBe("done"); });
		await manager.spawn({ handle: "one", input: { prompt: "inspect", read_only: true }, ctx, reportsWorkerStart: true, run: async (_input, _ctx, started) => { await started(); return result(); } });
		await manager.waitForIdle();
		expect(phases).toEqual(["queued", "running", "completed"]);
		expect(revisions).toEqual([1, 2, 3]);
		expect(manager.list()[0]?.integrationStatus).toBe("not_required");
	});

	it("shares blocking Agent execution and results with the background task engine", async () => {
		const manager = new AgentTaskManager(); let starts = 0;
		const agent = new AgentTool({ taskManager: manager, maxDepth: 2, runner: { run: async () => { starts++; return { report: "done", usage: {}, status: "completed", toolRounds: 1 }; } }, createRLMLoop: () => { throw new Error("unused"); } });
		const ctx = context();
		await agent.execute({ prompt: "inspect", read_only: true }, ctx);
		await agent.execute({ prompt: "inspect", read_only: true }, ctx);
		expect(starts).toBe(1); expect(manager.list()[0]?.result?.forLLM).toBe("done");
	});

	it("validates all cancellation ownership before cancelling any selected worker", async () => {
		const manager = new AgentTaskManager(); const ctx = context(); const release = deferred<void>(); let cancelled = false;
		await manager.spawn({ handle: "mine", input: { prompt: "inspect" }, ctx, run: async (_input, worker) => { worker.signal.addEventListener("abort", () => { cancelled = true; }); await release.promise; return result(); } });
		await manager.spawn({ handle: "foreign", input: { prompt: "inspect" }, ctx: { ...ctx, sessionId: "other" }, run: async () => result() });
		await expect(new AgentCancelTool(manager).execute({ handles: ["mine", "foreign"] }, ctx)).rejects.toThrow("another session");
		expect(cancelled).toBe(false);
		await new AgentCancelTool(manager).execute({ handles: ["mine"] }, ctx); expect(cancelled).toBe(true);
		release.resolve(); await manager.waitForIdle();
	});

	it("rejects stale workspace progress before assigning a newer public revision", async () => {
		const manager = new AgentTaskManager(); const ctx = context();
		const seen: number[] = [];
		ctx.bus.on("agent:worker_update", event => { if (event.worker.workspace?.revision !== undefined) seen.push(event.worker.workspace.revision); });
		const workspace: WorkerWorkspaceRecord = { workerId: "revision", parentSessionId: "session", taskPrompt: "inspect", sequence: 1, readOnly: true, coordinatorCwd: ctx.cwd, changedFiles: [], startedAt: "2026-01-01T00:00:00Z", executionStatus: "running", integrationStatus: "not_required", revision: 2 };
		await manager.spawn({ handle: "revision", input: { prompt: "inspect", read_only: true }, ctx, reportsWorkerStart: true, run: async (_input, worker, started) => {
			await started();
			worker.workerLifecycle!.onWorkspaceProgress(workspace);
			worker.workerLifecycle!.onWorkspaceProgress({ ...workspace, revision: 1, executionStatus: "creating" });
			worker.workerLifecycle!.onWorkspaceProgress({ ...workspace, revision: 3, executionStatus: "completed" });
			return result();
		} }); await manager.waitForIdle();
		expect(seen).toEqual([2, 3, 3]);
		expect(manager.list()[0]).toMatchObject({ executionStatus: "completed", workspace: { revision: 3 } });
	});

	it("checks cancellation again after durable start before entering the runner", async () => {
		const controller = new AbortController(); let starts = 0;
		class CancellingStore extends MemoryStore { override async upsert(record: AgentTaskRecord) { await super.upsert(record); if (record.status === "running") controller.abort(); } }
		const manager = new AgentTaskManager({ store: new CancellingStore("unused") });
		await manager.spawn({ handle: "cancel-before-run", input: { prompt: "inspect" }, ctx: { ...context(), signal: controller.signal }, run: async () => { starts++; return result(); } });
		await manager.waitForIdle(); expect(starts).toBe(0); expect(manager.list()[0]?.status).toBe("cancelled");
	});

	it("keeps revisions monotonic through reopening legacy and completed records", async () => {
		const store = new MemoryStore("unused"); const first = new AgentTaskManager({ store }); const ctx = context();
		await first.spawn({ handle: "persisted", input: { prompt: "inspect", read_only: true }, ctx, run: async () => result() }); await first.waitForIdle();
		const original = first.list()[0]!;
		const reopened = new AgentTaskManager({ store }); await reopened.initialize();
		expect(reopened.list()[0]?.revision).toBe(original.revision);
		const { revision: _revision, executionStatus: _execution, integrationStatus: _integration, ...legacy } = original;
		store.values.set(original.handle, legacy);
		const migrated = new AgentTaskManager({ store }); await migrated.initialize();
		expect(migrated.list()[0]).toMatchObject({ revision: 1, executionStatus: "completed", integrationStatus: "not_required" });
	});

	it("enforces mixed batch permission and shared schema/profile contracts", () => {
		const batch = new AgentSpawnBatchTool({ execute: async () => result() }, new AgentTaskManager());
		expect(batch.inputSchema.safeParse({ workers: [] }).success).toBe(false);
		expect(batch.inputSchema.safeParse({ workers: [{ prompt: "test", read_only: "false" }] }).success).toBe(false);
		for (const profile of ["default", "openai", "anthropic"] as const) {
			expect(getToolPrompt("AgentSpawnBatch", { profile })).toContain("single call");
			expect(getToolPrompt("AgentCancel", { profile })).toContain("does not undo");
		}
		expect(batch.isReadOnly()).toBe(false);
		const permissions = { mode: "manual" as const, cwd: process.cwd(), interactive: true };
		expect(batch.checkPermissions({ workers: [{ prompt: "read", read_only: true }] }, permissions)?.behavior).toBe("allow");
		expect(batch.checkPermissions({ workers: [{ prompt: "read", read_only: true }, { prompt: "write" }] }, permissions)).toBeUndefined();
	});
});
