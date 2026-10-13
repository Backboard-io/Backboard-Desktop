/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type { PermissionCheckContext, PermissionDecision } from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { agentSpawnSchema, type AgentExecutionTool, workerLaunchPermission } from "./AgentSpawnTool.tsx";

const schema = z.object({ workers: z.array(agentSpawnSchema).min(1).max(4).describe("Independent named assignments. Give each writing worker exclusive files.") });
export type AgentSpawnBatchInput = z.infer<typeof schema>;

/** One provider call registers a launch burst; no worker runs before registration succeeds. */
export class AgentSpawnBatchTool extends Tool<AgentSpawnBatchInput> {
	readonly name = "AgentSpawnBatch";
	readonly inputSchema = schema;
	constructor(private readonly agent: AgentExecutionTool, private readonly tasks: AgentTaskManager) { super(); }
	override get displayName(): string { return "Start workers"; }
	override prompt(context: PromptContext = {}): string { return getToolPrompt(this.name, context); }
	override isReadOnly(): boolean { return false; }
	override isConcurrencySafe(): boolean { return true; }
	override permissionContent(input: AgentSpawnBatchInput): string { return `${input.workers.length} ${input.workers.every(worker => worker.read_only === true) ? "read-only" : "write-capable"} workers`; }
	override checkPermissions(input: AgentSpawnBatchInput, ctx: PermissionCheckContext): PermissionDecision | undefined { return workerLaunchPermission(input.workers.every(worker => worker.read_only === true), ctx); }
	override summarizeInput(input: AgentSpawnBatchInput): string { return input.workers.map(worker => worker.name ?? worker.prompt.split("\n")[0]?.slice(0, 80)).join(", "); }
	override async execute(input: AgentSpawnBatchInput, ctx: ToolContext) {
		if (!ctx.toolCallId) throw new Error("AgentSpawnBatch requires a provider tool-call id.");
		const parentBatchToolCallId = ctx.toolCallId;
		const tasks = await this.tasks.spawnBatch(input.workers.map((worker, index) => ({
			handle: `worker-${createHash("sha256").update(JSON.stringify([ctx.sessionId, ctx.turnId ?? null, parentBatchToolCallId, index])).digest("hex")}`,
			parentBatchToolCallId,
			input: worker,
			ctx,
			reportsWorkerStart: this.agent.reportsWorkerStart,
			run: (workerInput, workerContext, started) => this.agent.execute(workerInput, workerContext, started),
		})));
		const summaries = tasks.map(({ handle, name, status, revision, executionStatus, integrationStatus }) => ({ handle, name, status, revision, executionStatus, integrationStatus }));
		return ok({ tasks: summaries, handles: tasks.map(task => task.handle) }, `${summaries.map(task => `${task.name ?? "Worker"}: ${task.handle} (${task.executionStatus ?? task.status}; integration ${task.integrationStatus ?? "pending"})`).join("\n")}\nRegistration is complete; queued/preparing workers have not started model execution. Continue independent work, then use AgentWait for required handles.`, `${tasks.length} workers registered`);
	}
}
