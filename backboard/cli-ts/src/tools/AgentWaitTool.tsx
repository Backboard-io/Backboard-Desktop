import { z } from "zod";
import { agentTaskFailure } from "../core/agent/AgentTaskFailure.ts";
import type { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type { AgentTaskRecord } from "../core/agent/AgentTaskTypes.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import type { ToolExecutionMetadata } from "../core/tools/ToolFailure.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	return_when: z
		.enum(["all", "any"])
		.optional()
		.describe(
			"Wait for all selected workers (default), or return when any selected worker finishes. Omit finished handles on subsequent waits.",
		),
	handles: z
		.array(z.string().min(1))
		.min(1)
		.max(4)
		.describe("The worker handles to join."),
	timeout_ms: z
		.number()
		.int()
		.positive()
		.max(60000)
		.optional()
		.describe("Optional maximum wait before returning current statuses."),
});

export type AgentWaitInput = z.infer<typeof schema>;

export interface AgentWaitOutput {
	tasks: AgentTaskRecord[];
	timedOut: boolean;
	completedCount: number;
	pendingHandles: string[];
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
			input.timeout_ms ?? 30000,
			input.return_when,
		);
		const forLLM = tasks.map(taskReport).join("\n\n");
		const complete = tasks.filter(isTerminal).length;
		const pendingHandles = tasks
			.filter((task) => !isTerminal(task))
			.map((task) => task.handle);
		const timedOut =
			pendingHandles.length > 0 &&
			(input.return_when !== "any" || complete === 0);
		const result = ok(
			{ tasks, timedOut, completedCount: complete, pendingHandles },
			`${forLLM}${timedOut ? "\n\nWait deadline reached; pending workers continue running." : ""}`,
			`${complete}/${tasks.length} workers finished`,
		);
		const failures = tasks
			.map(agentTaskFailure)
			.filter(
				(failure): failure is ToolExecutionMetadata => failure !== undefined,
			);
		const first = failures[0];
		if (first) {
			const category = failures.every(
				(failure) => failure.failureCategory === first.failureCategory,
			)
				? first.failureCategory
				: "unknown";
			return {
				...result,
				execution: {
					...(failures.length === 1 ? first : {}),
					outcome: "failure",
					failureCategory: category,
					retryable: false,
				},
			};
		}
		return result;
	}
}

function taskReport(task: AgentTaskRecord): string {
	const heading = `Worker ${task.handle} (${task.status})`;
	const persistence = task.persistenceError
		? `\nPersistence error: ${task.persistenceError}. The captured result is available here but not confirmed durable; do not rerun this worker or reapply integrated changes.`
		: "";
	if (task.result)
		return `${heading}\n${task.result.forLLM}${task.error ? `\nError: ${task.error}` : ""}${persistence}`;
	if (task.error) return `${heading}\nError: ${task.error}${persistence}`;
	const pending =
		task.status === "queued"
			? "Workspace preparation is pending; model execution has not started."
			: "The worker is still running.";
	return `${heading}\n${isTerminal(task) ? "No captured report is available." : pending}${persistence}`;
}

function isTerminal(task: AgentTaskRecord): boolean {
	return task.status !== "queued" && task.status !== "running";
}
