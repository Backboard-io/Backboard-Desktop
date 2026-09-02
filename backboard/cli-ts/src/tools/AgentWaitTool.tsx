import { z } from "zod";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type { AgentTaskRecord } from "../core/agent/AgentTaskTypes.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	handles: z
		.array(z.string().min(1))
		.min(1)
		.max(4)
		.describe("The worker handles to join."),
	timeout_ms: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional maximum wait before returning current statuses."),
});

export type AgentWaitInput = z.infer<typeof schema>;

export interface AgentWaitOutput {
	tasks: AgentTaskRecord[];
}

/** Joins only the selected background workers and returns durable outcomes. */
export class AgentWaitTool extends Tool<AgentWaitInput, AgentWaitOutput> {
	readonly name = "AgentWait";
	readonly inputSchema = schema;

	override get displayName(): string {
		return "Wait for workers";
	}

	constructor(private readonly tasks: AgentTaskManager) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isConcurrencySafe(): boolean {
		// A wait in the same provider response as its spawn must run after the
		// scheduler flushes the parallel spawn batch, never race registration.
		return false;
	}

	override checkPermissions(
		_input: AgentWaitInput,
		_ctx: PermissionCheckContext,
	): PermissionDecision {
		return {
			behavior: "allow",
			reason: "joining session-owned workers is read-only",
		};
	}

	override async execute(
		input: AgentWaitInput,
		ctx: ToolContext,
	): Promise<ToolResult<AgentWaitOutput>> {
		const tasks = await this.tasks.wait(
			[...new Set(input.handles)],
			ctx.sessionId,
			ctx.signal,
			input.timeout_ms,
		);
		const forLLM = tasks.map(taskReport).join("\n\n");
		const complete = tasks.filter(isTerminal).length;
		return ok(
			{ tasks },
			forLLM,
			`${complete}/${tasks.length} workers finished`,
		);
	}
}

function taskReport(task: AgentTaskRecord): string {
	const heading = `Worker ${task.handle} (${task.status})`;
	if (task.result) return `${heading}\n${task.result.forLLM}`;
	if (task.error) return `${heading}\nError: ${task.error}`;
	return `${heading}\nThe worker is still running.`;
}

function isTerminal(task: AgentTaskRecord): boolean {
	return task.status !== "queued" && task.status !== "running";
}
