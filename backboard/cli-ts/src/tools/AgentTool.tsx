import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import type { JSONValue } from "../core/agent/rlm/RLMTypes.ts";
import type { SubAgentResult } from "../core/agent/SubAgentRunner.ts";
import { measurePerformance } from "../core/performance/PerformanceTiming.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import { Tool } from "../core/tools/Tool.ts";
import { throwIfAborted } from "../core/tools/ToolAbort.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { WorkerWorkspaceUnavailableError } from "../core/workspaces/WorkerWorkspaceManager.ts";
import {
	type WorkerWorkspaceRecord,
	workerProgress,
} from "../core/workspaces/WorkerWorkspaceTypes.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { pluralize } from "../utils/string.ts";
import type {
	AgentToolDeps,
	AgentToolInput,
	AgentToolOutput,
} from "./AgentToolTypes.ts";
import { agentDisplayNameSchema } from "./AgentToolTypes.ts";

const jsonValueSchema = z.custom<JSONValue>((value) => {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key: string, nested: unknown): unknown => {
				if (
					nested === undefined ||
					typeof nested === "function" ||
					typeof nested === "symbol" ||
					typeof nested === "bigint"
				) {
					throw new TypeError("not json");
				}
				if (typeof nested === "number" && !Number.isFinite(nested)) {
					throw new TypeError("not json");
				}
				if (nested !== null && typeof nested === "object") {
					if (seen.has(nested)) throw new TypeError("cyclic json");
					seen.add(nested);
				}
				return nested;
			}) !== undefined
		);
	} catch {
		return false;
	}
}, "variables must contain only JSON-serializable values");

const schema = z.object({
	name: agentDisplayNameSchema,
	subagent_type: z
		.enum(["worker", "rlm"])
		.optional()
		.describe(
			'"worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL.',
		),
	prompt: z
		.string()
		.min(1)
		.describe(
			"The full delegated prompt, including all task detail, context, and report requirements.",
		),
	read_only: z
		.boolean()
		.optional()
		.describe(
			"Restrict a worker to non-mutating workspace tools. Use for independent research so it can start while the parent response is still streaming.",
		),
	variables: z
		.record(jsonValueSchema)
		.optional()
		.describe(
			"Optional JSON object for rlm sub-agents. Values are available as inputs; valid non-reserved keys are also direct variables.",
		),
	timeout_ms: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional wall-clock budget for rlm sub-agents. When the budget expires, the RLM returns a partial-progress report instead of continuing normal code execution.",
		),
});

export type {
	AgentToolDeps,
	AgentToolInput,
	AgentToolOutput,
} from "./AgentToolTypes.ts";

/**
 * Spawns an isolated sub-agent (a recursive worker). The parent receives only
 * the sub-agent's distilled report, never its intermediate tool churn, which
 * keeps long sessions free of context rot.
 */
export class AgentTool extends Tool<AgentToolInput, AgentToolOutput> {
	readonly name = "Agent";
	readonly reportsWorkerStart = true;
	readonly inputSchema = schema;
	private readonly tasks: AgentTaskManager;

	override get displayName(): string {
		return "Subagent";
	}

	constructor(private readonly deps: AgentToolDeps) {
		super();
		this.tasks = deps.taskManager ?? new AgentTaskManager();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override toJSONSchema(context: PromptContext = {}): OpenAITool {
		return {
			type: "function",
			function: {
				name: this.agentName,
				description: this.prompt(context),
				parameters: agentToolParameters(),
			},
		};
	}

	override isReadOnly(input: AgentToolInput): boolean {
		return input.read_only === true;
	}

	override isConcurrencySafe(_input: AgentToolInput): boolean {
		return true;
	}

	override permissionContent(input: AgentToolInput): string {
		return input.read_only === true || input.subagent_type === "rlm"
			? "read-only worker"
			: "write worker";
	}

	override checkPermissions(
		input: AgentToolInput,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (input.read_only === true || input.subagent_type === "rlm") {
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

	override async execute(
		input: AgentToolInput,
		ctx: ToolContext,
		onStarted?: () => void | Promise<void>,
	): Promise<ToolResult<AgentToolOutput>> {
		// Agent is the blocking compatibility view over the same durable engine.
		if (!ctx.workerLifecycle) {
			const handle = ctx.toolCallId ?? `worker-${randomUUID()}`;
			await this.tasks.spawn({
				handle,
				input,
				ctx,
				reportsWorkerStart: true,
				run: (workerInput, workerContext, started) =>
					this.execute(workerInput, workerContext, async () => {
						await started();
						await onStarted?.();
					}),
			});
			const [task] = await this.tasks.wait(
				[handle],
				ctx.sessionId,
				new AbortController().signal,
			);
			// The execution retains ctx.signal. Joining drains its cancelled cleanup
			// and any already-durable integration before returning the captured outcome.
			if (!task?.result)
				throw new Error(
					task?.error ?? "Worker finished without a captured result.",
				);
			const { data, forLLM, title, detail } = task.result;
			return {
				...ok(data, forLLM, title, detail),
				...(task.execution ? { execution: task.execution } : {}),
			};
		}
		const subagentType = input.subagent_type ?? "worker";
		const depth = (ctx.agentDepth ?? 0) + 1;
		const traceContext = ctx.trace;
		const trace =
			(await traceContext?.createAgentTrace({
				mode: subagentType,
				prompt: input.prompt,
			})) ?? null;
		const tracePath = trace ? trace.relativePath(trace.paths.root) : undefined;

		if (depth > this.deps.maxDepth) {
			const report =
				"Agent recursion depth limit reached. Complete this work directly instead of spawning another sub-agent.";
			return {
				...ok(
					{
						mode: subagentType,
						report,
						status: "rejected",
						rounds: 0,
						...(tracePath ? { tracePath } : {}),
					},
					report,
					"Rejected · depth limit reached",
				),
				execution: {
					outcome: "failure",
					failureCategory: "unavailable",
					retryable: false,
					mutated: false,
				},
			};
		}

		if (subagentType === "rlm") {
			try {
				throwIfAborted(ctx.signal);
				await onStarted?.();
				const result = await this.deps.createRLMLoop(ctx.modelRoute).run({
					prompt: input.prompt,
					signal: ctx.signal,
					timeoutMs: input.timeout_ms,
					variables: input.variables,
				});
				await trace?.writeRLMResult(result);
				return ok(
					{
						mode: "rlm",
						report: result.report,
						status: result.status,
						rounds: result.rounds,
						...(tracePath ? { tracePath } : {}),
					},
					result.report,
					agentTitle(result.status, result.rounds),
				);
			} catch (err) {
				await trace?.writeError(err).catch(() => undefined);
				throw err;
			}
		}

		let result: SubAgentResult;
		let workspaceRecord: WorkerWorkspaceRecord | undefined;
		// A workspace manager owns the worker lifecycle even when preparation
		// rejects before the runner callback is entered (for example a dirty or
		// non-Git coordinator). Claim the terminal edge up front so detached
		// AgentSpawn tasks cannot remain visually active forever on that path.
		const deferredParentEnd =
			this.deps.workspaceManager !== undefined ||
			ctx.workerLifecycle !== undefined;
		let parentEndEmitted = false;
		const emitParentEnd = (status: string): void => {
			if (
				ctx.workerLifecycle ||
				!deferredParentEnd ||
				parentEndEmitted ||
				!ctx.toolCallId
			)
				return;
			parentEndEmitted = true;
			ctx.bus.emit({
				type: "agent:child_end",
				agentToolCallId: ctx.toolCallId,
				status: terminalTurnStatus(status),
			});
		};
		const workerTrace =
			trace && traceContext
				? {
						sessionId: ctx.sessionId,
						context: traceContext,
						clientLogPath: trace.paths.clientLog,
					}
				: undefined;
		const run = async (options: {
			cwd: string;
			signal: AbortSignal;
			isolated: boolean;
			workspace?: WorkerWorkspaceRecord;
		}): Promise<SubAgentResult> => {
			throwIfAborted(options.signal);
			const workerCwd =
				options.isolated && options.workspace
					? await scopedWorkerCwd(
							ctx.cwd,
							options.workspace.coordinatorCwd,
							options.cwd,
						)
					: options.cwd;
			throwIfAborted(options.signal);
			await onStarted?.();
			const delegatedPrompt = options.isolated
				? rebaseCoordinatorPaths(input.prompt, ctx.cwd, workerCwd)
				: input.prompt;
			return this.deps.runner.run({
				route: ctx.modelRoute,
				...(input.name ? { name: input.name } : {}),
				prompt: options.workspace?.snapshotNotice
					? `${delegatedPrompt}\n\nWorkspace preparation: ${options.workspace.snapshotNotice}`
					: delegatedPrompt,
				depth,
				readOnly: input.read_only === true,
				parentCwd: workerCwd,
				permissionCwd: ctx.cwd,
				parentSignal: options.signal,
				parentBus: ctx.bus,
				parentToolCallId: ctx.toolCallId,
				deferParentEnd: deferredParentEnd,
				parentTurnId: ctx.turnId,
				checkpoints: options.isolated ? undefined : ctx.checkpoints,
				parentPermissions: ctx.permissions,
				trace: workerTrace,
				isolatedWorkspace: options.isolated,
				workspace: options.workspace
					? workerProgress(options.workspace)
					: undefined,
			});
		};
		try {
			if (this.deps.workspaceManager) {
				const workerId = ctx.toolCallId ?? `worker-${Date.now().toString(36)}`;
				const outcome = await this.deps.workspaceManager.runWorker(
					{
						workerId,
						...(input.name ? { name: input.name } : {}),
						parentSessionId: ctx.sessionId,
						parentToolCallId: ctx.toolCallId,
						taskPrompt: input.prompt,
						readOnly: input.read_only === true,
						coordinatorCwd: ctx.cwd,
						signal: ctx.signal,
						onProgress: (record) => {
							if (ctx.workerLifecycle) {
								ctx.workerLifecycle.onWorkspaceProgress(record);
								return;
							}
							if (!ctx.toolCallId) return;
							const terminal = isTerminalWorkerRecord(record);
							// Once cancelled, suppress noisy progress but preserve durable
							// terminal authority. Capture/integration can legitimately win a
							// cancellation race, and the UI must be able to reconcile a row
							// already marked Cancelled with the integrated result.
							if (ctx.signal.aborted && !terminal) return;
							ctx.bus.emit({
								type: "agent:child_status",
								agentToolCallId: ctx.toolCallId,
								workspace: workerProgress(record),
							});
							if (ctx.signal.aborted) return;
							const running =
								this.deps.workspaceManager
									?.list()
									.filter(
										(worker) =>
											worker.executionStatus === "creating" ||
											worker.executionStatus === "running",
									).length ?? 0;
							if (running >= 2) {
								ctx.bus.emit({ type: "agent:parallel_status", count: running });
							}
						},
						onTiming: (phase, durationMs) => {
							ctx.bus.emit({
								type: "performance:timing",
								phase,
								durationMs,
								toolCallId: ctx.toolCallId,
								workerId,
							});
						},
					},
					(workspace) =>
						measurePerformance(
							ctx.bus,
							"worker_model",
							{ toolCallId: ctx.toolCallId, workerId },
							() =>
								run({
									cwd: workspace.cwd,
									signal: workspace.signal,
									isolated: workspace.isolated,
									workspace: workspace.record,
								}),
						),
				);
				result = outcome.result;
				workspaceRecord = outcome.workspace;
			} else {
				result = await run({
					cwd: ctx.cwd,
					signal: ctx.signal,
					isolated: false,
				});
			}
		} catch (err) {
			emitParentEnd(ctx.signal.aborted ? "cancelled" : "failed");
			await trace?.writeError(err).catch(() => undefined);
			if (err instanceof WorkerWorkspaceUnavailableError) {
				const report = `${err.message}\n\nAgent and AgentSpawn use the same workspace backend. Switching between them or retrying unchanged workspace conditions will not fix this failure. Continue permitted work directly, or report the specific prerequisite that must change before another write worker can start.`;
				return {
					...ok(
						{
							mode: "worker",
							report,
							status: "rejected",
							rounds: 0,
							...(tracePath ? { tracePath } : {}),
						},
						report,
						"Rejected · isolated workspace unavailable",
					),
					execution: {
						outcome: "failure",
						failureCategory: "unavailable",
						retryable: false,
						mutated: false,
					},
				};
			}
			throw err;
		}
		const progress = workspaceRecord
			? workerProgress(workspaceRecord)
			: undefined;
		const status = authoritativeWorkerStatus(result, workspaceRecord);
		emitParentEnd(status);
		return ok(
			{
				mode: "worker",
				report: workerReport(result, workspaceRecord),
				status,
				rounds: result.toolRounds,
				...(progress ? { worker: progress } : {}),
				...(tracePath ? { tracePath } : {}),
			},
			workerReportForLLM(result, workspaceRecord, status),
			agentTitle(status, result.toolRounds),
		);
	}
}

/** Preserve the requested project subfolder without widening permission scope. */
async function scopedWorkerCwd(
	requestedCwd: string,
	coordinatorRoot: string,
	workerRoot: string,
): Promise<string> {
	if (resolve(requestedCwd) === resolve(coordinatorRoot)) return workerRoot;
	const [root, requested] = await Promise.all([
		realpath(coordinatorRoot),
		realpath(requestedCwd),
	]);
	const subfolder = relative(root, requested);
	if (
		isAbsolute(subfolder) ||
		subfolder === ".." ||
		subfolder.startsWith(`..${sep}`)
	) {
		throw new WorkerWorkspaceUnavailableError(
			"The requested worker directory is outside its coordinator workspace. Use a directory within the current workspace before starting another worker.",
		);
	}
	let directory = await realpath(workerRoot);
	// Git does not preserve empty directories. Create only the requested path
	// inside this private checkout, refusing symlinks at every component.
	for (const component of subfolder.split(sep).filter(Boolean)) {
		directory = join(directory, component);
		let entry: Stats;
		try {
			entry = await lstat(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await mkdir(directory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			entry = await lstat(directory);
		}
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			throw new WorkerWorkspaceUnavailableError(
				"The worker subfolder contains a symlink or non-directory component. No model was started; the private workspace needs repair.",
			);
		}
	}
	return directory;
}

/**
 * Coordinator models naturally describe files with coordinator-absolute paths.
 * An isolated worker must operate on the equivalent path in its own worktree,
 * so rebase those rooted references before the delegated prompt reaches it.
 */
function rebaseCoordinatorPaths(
	prompt: string,
	coordinatorCwd: string,
	workerCwd: string,
): string {
	const coordinatorRoot = coordinatorCwd.replace(/[\\/]+$/, "");
	if (!coordinatorRoot || /^[A-Za-z]:$/.test(coordinatorRoot)) return prompt;
	const variants = new Set([
		coordinatorRoot,
		coordinatorRoot.replaceAll("\\", "/"),
		coordinatorRoot.replaceAll("/", "\\"),
	]);
	let rebased = prompt;
	for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
		if (!variant) continue;
		// A coordinator root is commonly embedded in prose (`Project dir:
		// /path.`), quoted, or wrapped in Markdown. Treat those textual
		// delimiters as path boundaries while leaving sibling prefixes such as
		// `/path-other` and `/path.extension` untouched.
		const expression = new RegExp(
			`${escapeRegExp(variant)}(?=$|[\\\\/\\s'"\`)>\\]\\}]|[.,;:!?](?=$|\\s|[\\\\/'"\`)>\\]\\}]))`,
			process.platform === "win32" ? "gi" : "g",
		);
		// A path can legally contain `$`; a replacement callback keeps `$&`, `$'`,
		// and friends from being interpreted as String.replace substitutions.
		rebased = rebased.replace(expression, () => workerCwd);
	}
	return rebased;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentTitle(status: string, rounds: number): string {
	if (status === "conflict")
		return `Conflict after ${rounds} ${pluralize(rounds, "round")}`;
	if (status === "cancelled")
		return `Cancelled after ${rounds} ${pluralize(rounds, "round")}`;
	// A worker that could not finish hands its task back to the coordinator.
	return status === "completed"
		? `Completed in ${rounds} ${pluralize(rounds, "round")}`
		: `Handed back after ${rounds} ${pluralize(rounds, "round")}`;
}

function workerReportForLLM(
	result: SubAgentResult,
	workspace?: WorkerWorkspaceRecord,
	authoritativeStatus: string = result.status,
): string {
	if (workspace?.integrationStatus === "integrated") {
		const changed = `${workspace.changedFiles.length} ${pluralize(
			workspace.changedFiles.length,
			"changed file",
		)}`;
		return [
			`Integration completed successfully: ${changed} from this worker ${workspace.changedFiles.length === 1 ? "is" : "are"} already present in the coordinator workspace at ${workspace.coordinatorCwd}.`,
			"Do not copy, merge, cherry-pick, re-apply, or read files from the private worker worktree. Any contrary instruction in the worker's own report is obsolete.",
			`Worker report:\n${result.report}`,
			"Authoritative status: integrated. Continue only from the coordinator workspace.",
		].join("\n\n");
	}
	const report = workerReport(result, workspace);
	if (authoritativeStatus === "completed") return report;
	// The runner's handoff report already tells the coordinator to finish the
	// task itself.
	if (authoritativeStatus === "failed" && result.status === "failed")
		return report;
	return `Error: Agent worker ${authoritativeStatus} after ${result.toolRounds} rounds: ${report}`;
}

function authoritativeWorkerStatus(
	result: SubAgentResult,
	workspace?: WorkerWorkspaceRecord,
): string {
	if (!workspace || workspace.readOnly) return result.status;
	if (workspace.integrationStatus === "integrated") return "completed";
	if (workspace.integrationStatus === "conflict") return "conflict";
	if (
		workspace.integrationStatus === "pending" ||
		workspace.integrationStatus === "integrating" ||
		workspace.integrationStatus === "skipped"
	) {
		return "failed";
	}
	return result.status;
}

function isTerminalWorkerRecord(record: WorkerWorkspaceRecord): boolean {
	return (
		record.executionStatus !== "creating" &&
		record.executionStatus !== "running"
	);
}

function terminalTurnStatus(
	status: string,
): "completed" | "failed" | "cancelled" {
	if (status === "completed" || status === "integrated") return "completed";
	if (status === "cancelled") return "cancelled";
	return "failed";
}

function workerReport(
	result: SubAgentResult,
	workspace?: WorkerWorkspaceRecord,
): string {
	if (!workspace) return result.report;
	const details = [
		workspace.repositoryInitializedByBackboard
			? "Git repository initialized automatically"
			: undefined,
		`Changed files: ${workspace.changedFiles.length}`,
		workspace.integrationStatus === "integrated"
			? "Integration: completed in coordinator workspace"
			: `Integration: ${workspace.integrationStatus}`,
		workspace.conflictingFiles?.length
			? `Conflicts: ${workspace.conflictingFiles.join(", ")}`
			: undefined,
		workspace.error ? `Error: ${workspace.error}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return `${result.report}\n\n${details}`;
}

function agentToolParameters(): Record<string, unknown> {
	const jsonValueParameterSchema = {
		anyOf: [
			{ type: "string" },
			{ type: "number" },
			{ type: "boolean" },
			{ type: "null" },
			{ type: "array", items: { $ref: "#/$defs/AgentJsonValue" } },
			{
				type: "object",
				additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
			},
		],
	};

	return {
		type: "object",
		properties: {
			name: {
				type: "string",
				minLength: 1,
				maxLength: 80,
				pattern: "^[^\\r\\n]+$",
				description:
					"Optional short display label for this worker, such as Search. Does not change task identity.",
			},
			subagent_type: {
				type: "string",
				enum: ["worker", "rlm"],
				description: '"worker" (default) or "rlm".',
			},
			prompt: {
				type: "string",
				minLength: 1,
				description: "The full prompt for the sub-agent.",
			},
			read_only: {
				type: "boolean",
				description:
					"Restrict a worker to non-mutating workspace tools so independent research can start while the parent response streams.",
			},
			variables: {
				type: "object",
				description: "Optional JSON input variables for RLM sub-agents.",
				additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
			},
			timeout_ms: {
				type: "integer",
				minimum: 1,
				description:
					"Optional wall-clock budget in milliseconds for RLM sub-agents.",
			},
		},
		required: ["prompt"],
		additionalProperties: false,
		$defs: {
			AgentJsonValue: jsonValueParameterSchema,
		},
	};
}
