import { z } from "zod";
import { agentTaskFailure } from "../core/agent/AgentTaskFailure.ts";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import type { AgentToolOutput } from "../core/tools/AgentToolOutput.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import {
	agentDisplayNameSchema,
	type AgentToolInput,
} from "./AgentToolTypes.ts";

export const agentSpawnSchema = z.object({
	name: agentDisplayNameSchema,
	prompt: z
		.string()
		.min(1)
		.describe("The complete task for the background worker."),
	read_only: z
		.boolean()
		.optional()
		.describe("Restrict the worker to non-mutating workspace tools."),
});

export type AgentSpawnInput = z.infer<typeof agentSpawnSchema>;

export interface AgentSpawnOutput {
	handle: string;
	status: string;
}

export interface AgentExecutionTool {
	readonly reportsWorkerStart?: boolean;
	execute(
		input: AgentToolInput,
		ctx: ToolContext,
		onStarted?: () => void | Promise<void>,
	): Promise<ToolResult<AgentToolOutput>>;
}

/** Starts a worker and returns its durable handle without joining it. */
export class AgentSpawnTool extends Tool<AgentSpawnInput, AgentSpawnOutput> {
	readonly name = "AgentSpawn";
	readonly inputSchema = agentSpawnSchema;

	override get displayName(): string {
		return "Subagent";
	}

	constructor(
		private readonly agent: AgentExecutionTool,
		private readonly tasks: AgentTaskManager,
	) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	// A Spawn call returns before the child settles. It must never use streamed
	// read-only early execution, whose cleanup signal intentionally aborts work as
	// soon as the tool result is consumed.
	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return true;
	}

	override permissionContent(input: AgentSpawnInput): string {
		return input.read_only === true ? "read-only worker" : "write worker";
	}

	override checkPermissions(
		input: AgentSpawnInput,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		return workerLaunchPermission(input.read_only === true, ctx);
	}

	override summarizeInput(input: AgentSpawnInput): string {
		return input.prompt;
	}

	override async execute(
		input: AgentSpawnInput,
		ctx: ToolContext,
	): Promise<ToolResult<AgentSpawnOutput>> {
		const handle = ctx.toolCallId;
		if (!handle)
			throw new Error("AgentSpawn requires a provider tool-call id.");
		const agentInput: AgentToolInput = {
			prompt: input.prompt,
			...(input.name ? { name: input.name } : {}),
			...(input.read_only === undefined ? {} : { read_only: input.read_only }),
		};
		const task = await this.tasks.spawn({
			handle,
			input: agentInput,
			ctx,
			reportsWorkerStart: this.agent.reportsWorkerStart,
			run: (workerInput, workerContext, onStarted) =>
				this.agent.execute(workerInput, workerContext, onStarted),
		});
		const active = task.status === "queued" || task.status === "running";
		const report = active
			? `Worker ${task.status} with handle ${handle}.${task.status === "queued" ? " Workspace preparation is pending; model execution has not started and preparation may still fail." : ""} Continue safe unrelated work, then call AgentWait with this handle when its result is needed.`
			: `Worker handle ${handle} already exists with status ${task.status}. No new worker was started. Call AgentWait to retrieve its recorded result.`;
		const result = ok(
			{ handle, status: task.status },
			report,
			task.status === "running" ? "Worker started" : `Worker ${task.status}`,
		);
		const failure = agentTaskFailure(task);
		return failure
			? {
					...result,
					execution: {
						...failure,
						outcome: "failure",
						retryable: false,
						...(!task.startedAt ? { mutated: false } : {}),
					},
				}
			: result;
	}
}

export function workerLaunchPermission(readOnly: boolean, ctx: PermissionCheckContext): PermissionDecision | undefined {
		if (readOnly) {
			return { behavior: "allow", reason: "read-only sub-agent" };
		}
		if (ctx.mode === "acceptEdits" || ctx.mode === "auto") {
			return {
				behavior: "allow",
				reason: `worker edits allowed (${ctx.mode})`,
			};
		}
		return undefined;
}
