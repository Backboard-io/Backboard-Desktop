import { describe, expect, it } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTraceContext } from "../src/core/agent/AgentTraceStore.ts";
import type { RLMRunParams } from "../src/core/agent/rlm/RLMLoop.ts";
import type {
	SubAgentResult,
	SubAgentRunParams,
} from "../src/core/agent/SubAgentRunner.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { WorkerWorkspaceUnavailableError } from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";
import { AgentTool, type AgentToolDeps } from "../src/tools/AgentTool.tsx";

function ctx(
	agentDepth: number,
	overrides: Partial<ToolContext> = {},
): ToolContext {
	return {
		sessionId: "s",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
		agentDepth,
		...overrides,
	};
}

function makeTool(
	options: {
		workerResult?: Partial<SubAgentResult>;
	} & Partial<AgentToolDeps> = {},
): {
	tool: AgentTool;
	workerCalls: SubAgentRunParams[];
	rlmCalls: RLMRunParams[];
} {
	const { workerResult, ...overrides } = options;
	const workerCalls: SubAgentRunParams[] = [];
	const rlmCalls: RLMRunParams[] = [];
	const runner: AgentToolDeps["runner"] = {
		run: async (params: SubAgentRunParams) => {
			workerCalls.push(params);
			return {
				report: "worker report",
				status: "completed" as const,
				usage: {},
				toolRounds: 3,
				...workerResult,
			};
		},
	};
	const rlmLoop: ReturnType<AgentToolDeps["createRLMLoop"]> = {
		run: async (params: RLMRunParams) => {
			rlmCalls.push(params);
			return {
				report: "rlm report",
				status: "completed" as const,
				usage: {},
				rounds: 4,
				trajectory: [],
			};
		},
	};

	const tool = new AgentTool({
		runner,
		createRLMLoop: () => rlmLoop,
		maxDepth: 2,
		...overrides,
	});
	return { tool, workerCalls, rlmCalls };
}

describe("AgentTool schema and flags", () => {
	it("accepts a bounded cosmetic name and forwards it without changing the delegated prompt", async () => {
		const { tool, workerCalls } = makeTool();
		const input = tool.parseInput({
			name: " Search ",
			prompt: "Inspect source",
		});
		expect(input.name).toBe("Search");
		for (const name of ["", " ", "x".repeat(81), "two\nlines"])
			expect(() =>
				tool.parseInput({ name, prompt: "Inspect source" }),
			).toThrow();
		expect(
			(
				tool.toJSONSchema().function.parameters as {
					properties: Record<string, unknown>;
				}
			).properties.name,
		).toMatchObject({ type: "string", maxLength: 80 });
		await tool.execute(input, ctx(0));
		expect(workerCalls[0]?.name).toBe("Search");
		expect(workerCalls[0]?.prompt).toBe("Inspect source");
	});

	it("requires prompt and defaults subagent_type to worker behavior", () => {
		const { tool } = makeTool();
		expect(() => tool.parseInput({})).toThrow();
		const parsed = tool.parseInput({ prompt: "do it" });
		expect(parsed.prompt).toBe("do it");
		expect(parsed.subagent_type).toBeUndefined();
	});

	it("rejects unsupported subagent types", () => {
		const { tool } = makeTool();
		expect(() =>
			tool.parseInput({ prompt: "do it", subagent_type: "planner" }),
		).toThrow();
	});

	it("emits a Backboard-compatible variables object schema", () => {
		const { tool } = makeTool();
		type AgentParameters = OpenAITool["function"]["parameters"] & {
			properties?: {
				variables?: {
					type?: string;
					description?: string;
					additionalProperties?: {
						$ref?: string;
					};
				};
			};
			$defs?: {
				AgentJsonValue?: {
					anyOf?: Array<{ type?: string }>;
				};
			};
		};
		const parameters: AgentParameters = tool.toJSONSchema().function.parameters;
		expect(parameters.properties?.variables).toMatchObject({
			type: "object",
			description: "Optional JSON input variables for RLM sub-agents.",
			additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
		});
		expect(
			parameters.$defs?.AgentJsonValue?.anyOf?.map((item) => item.type),
		).toEqual(["string", "number", "boolean", "null", "array", "object"]);
	});

	it("exports the variables schema without recursive conversion warnings", () => {
		const { tool } = makeTool();
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			tool.toJSONSchema();
		} finally {
			console.warn = warn;
		}

		expect(warnings).toEqual([]);
	});

	it("rejects non-json variable values", () => {
		const { tool } = makeTool();
		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { value: BigInt(1) },
			}),
		).toThrow("variables must contain only JSON-serializable values");
		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { invalid: () => "no" },
			}),
		).toThrow("variables must contain only JSON-serializable values");
	});

	it("rejects cyclic variable values", () => {
		const { tool } = makeTool();
		type Cyclic = { self?: Cyclic };
		const cyclic: Cyclic = {};
		cyclic.self = cyclic;

		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { cyclic },
			}),
		).toThrow("variables must contain only JSON-serializable values");
	});

	it("marks only explicitly research-only workers as read-only", () => {
		const { tool } = makeTool();
		expect(tool.isReadOnly({ prompt: "t" })).toBe(false);
		expect(tool.isConcurrencySafe({ prompt: "t" })).toBe(true);
		expect(tool.isReadOnly({ prompt: "t", read_only: true })).toBe(true);
		expect(tool.isReadOnly({ prompt: "t", subagent_type: "rlm" })).toBe(false);
		expect(tool.isConcurrencySafe({ prompt: "t", subagent_type: "rlm" })).toBe(
			true,
		);
	});

	it("advertises parallel read-only workers in every model profile", () => {
		const { tool } = makeTool();
		for (const profile of ["default", "openai", "anthropic", "glm"] as const) {
			const prompt = tool.prompt({ profile });
			expect(prompt).toContain("read_only");
			expect(prompt).toMatch(/multiple Agent (tool )?calls/i);
		}
	});
});

describe("AgentTool execution", () => {
	it("preserves a project subfolder and its permission scope in a private snapshot", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-subfolder-"));
		try {
			const source = join(dir, "source");
			const requested = join(source, "apps", "web app");
			const workerRoot = join(dir, "worker");
			await Promise.all([
				mkdir(requested, { recursive: true }),
				mkdir(workerRoot),
			]);
			const record: WorkerWorkspaceRecord = {
				workerId: "worker",
				sequence: 0,
				parentSessionId: "s",
				taskPrompt: "edit",
				readOnly: false,
				coordinatorCwd: source,
				worktreePath: workerRoot,
				backend: "snapshot",
				snapshotNotice:
					"Private snapshot excludes ignored files and Git metadata.",
				changedFiles: [],
				startedAt: "now",
				executionStatus: "completed",
				integrationStatus: "integrated",
			};
			const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
				list: () => [record],
				runWorker: async (params, run) => ({
					result: await run({
						record,
						cwd: workerRoot,
						isolated: true,
						signal: params.signal,
					}),
					workspace: record,
				}),
			};
			const { tool, workerCalls } = makeTool({ workspaceManager });
			await tool.execute(
				{ prompt: `Edit ${requested}/feature.ts` },
				ctx(0, { cwd: requested }),
			);
			const expected = join(await realpath(workerRoot), "apps", "web app");
			expect(workerCalls[0]?.parentCwd).toBe(expected);
			expect(workerCalls[0]?.permissionCwd).toBe(requested);
			expect(workerCalls[0]?.prompt).toContain(`Edit ${expected}/feature.ts`);
			expect(workerCalls[0]?.prompt).toContain(
				record.snapshotNotice ?? "missing notice",
			);
			expect((await lstat(expected)).isDirectory()).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects coordinator escapes and private subfolder symlinks before model start", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-subfolder-rejection-"));
		try {
			const source = join(dir, "source");
			const requested = join(source, "nested");
			const outside = join(dir, "outside");
			const workerRoot = join(dir, "worker");
			await Promise.all([
				mkdir(requested, { recursive: true }),
				mkdir(outside),
				mkdir(workerRoot),
			]);
			await symlink(outside, join(workerRoot, "nested"));
			const record: WorkerWorkspaceRecord = {
				workerId: "worker",
				sequence: 0,
				parentSessionId: "s",
				taskPrompt: "edit",
				readOnly: false,
				coordinatorCwd: source,
				worktreePath: workerRoot,
				changedFiles: [],
				startedAt: "now",
				executionStatus: "completed",
				integrationStatus: "integrated",
			};
			const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
				list: () => [record],
				runWorker: async (params, run) => ({
					result: await run({
						record,
						cwd: workerRoot,
						isolated: true,
						signal: params.signal,
					}),
					workspace: record,
				}),
			};
			const { tool, workerCalls } = makeTool({ workspaceManager });
			for (const cwd of [outside, requested]) {
				const result = await tool.execute({ prompt: "edit" }, ctx(0, { cwd }));
				expect(result.execution).toMatchObject({
					failureCategory: "unavailable",
					mutated: false,
				});
			}
			expect(workerCalls).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("runs the worker by default and passes the full prompt with depth+1", async () => {
		const { tool, workerCalls } = makeTool();
		const result = await tool.execute({ prompt: "investigate" }, ctx(0));
		expect(result.forLLM).toBe("worker report");
		expect(result.data.mode).toBe("worker");
		expect(workerCalls).toHaveLength(1);
		expect(workerCalls[0]?.prompt).toBe("investigate");
		expect(workerCalls[0]?.depth).toBe(1);
		expect(workerCalls[0]?.readOnly).toBe(false);
	});

	it("passes the enforced read-only mode to workers", async () => {
		const { tool, workerCalls } = makeTool();
		await tool.execute({ prompt: "research", read_only: true }, ctx(0));
		expect(workerCalls[0]?.readOnly).toBe(true);
	});

	it("starts a read-only worker before the streamed tool round finalizes", async () => {
		const { tool, workerCalls } = makeTool();
		const bus = new EventBus();
		const scheduler = new ToolScheduler(new ToolRegistry([tool]), bus);
		const round = scheduler.createRound(ctx(0, { bus }));
		const call = {
			id: "agent_research",
			name: "Agent",
			input: { prompt: "research", read_only: true },
		};

		round.announce(call.id, call.name);
		round.offer(call);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(workerCalls).toHaveLength(1);

		const outputs = await round.finalize([call]);
		expect(outputs[0]?.tool_call_id).toBe(call.id);
	});

	it("runs multiple write-capable workers concurrently after finalization", async () => {
		let active = 0;
		let maxActive = 0;
		const { tool } = makeTool({
			runner: {
				run: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 20));
					active--;
					return {
						report: "done",
						status: "completed",
						usage: {},
						toolRounds: 1,
					};
				},
			},
		});
		const bus = new EventBus();
		const scheduler = new ToolScheduler(new ToolRegistry([tool]), bus);

		const outputs = await scheduler.run(
			[
				{ id: "agent_a", name: "Agent", input: { prompt: "edit A" } },
				{ id: "agent_b", name: "Agent", input: { prompt: "edit B" } },
			],
			ctx(0, { bus }),
		);

		expect(maxActive).toBe(2);
		expect(outputs).toHaveLength(2);
	});

	it("runs write workers from the cwd and branch assigned by the workspace manager", async () => {
		const records: WorkerWorkspaceRecord[] = [];
		const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
			list: () => records,
			runWorker: async (params, run) => {
				const record: WorkerWorkspaceRecord = {
					workerId: params.workerId,
					sequence: records.length,
					parentSessionId: params.parentSessionId,
					parentToolCallId: params.parentToolCallId,
					taskPrompt: params.taskPrompt,
					readOnly: params.readOnly,
					coordinatorCwd: params.coordinatorCwd,
					repositoryRoot: "/repo",
					branch: `agent/s/worker/${params.workerId}`,
					worktreePath: `/workers/$&/${params.workerId}`,
					startingCommit: "start",
					resultCommit: "result",
					changedFiles: ["src/result.ts"],
					startedAt: new Date(0).toISOString(),
					finishedAt: new Date(1).toISOString(),
					executionStatus: "completed",
					integrationStatus: "integrated",
				};
				records.push(record);
				const result = await run({
					record,
					cwd: record.worktreePath ?? "",
					isolated: true,
					signal: params.signal,
				});
				return { result, workspace: record };
			},
		};
		const { tool, workerCalls } = makeTool({ workspaceManager });
		const result = await tool.execute(
			{
				prompt:
					'Project dir: /coordinator project. Edit `/coordinator project/src/result.ts`; inspect "/coordinator project" and (/coordinator project), but leave /coordinator project-other/reference.ts and /coordinator project.extension/reference.ts unchanged.',
			},
			ctx(0, { toolCallId: "agent_a", cwd: "/coordinator project" }),
		);

		expect(workerCalls[0]?.parentCwd).toBe("/workers/$&/agent_a");
		expect(workerCalls[0]?.prompt).toBe(
			'Project dir: /workers/$&/agent_a. Edit `/workers/$&/agent_a/src/result.ts`; inspect "/workers/$&/agent_a" and (/workers/$&/agent_a), but leave /coordinator project-other/reference.ts and /coordinator project.extension/reference.ts unchanged.',
		);
		expect(workerCalls[0]?.isolatedWorkspace).toBe(true);
		expect(workerCalls[0]?.workspace?.branch).toBe("agent/s/worker/agent_a");
		expect(result.data.worker).toMatchObject({
			branch: "agent/s/worker/agent_a",
			worktreePath: "/workers/$&/agent_a",
			changedFileCount: 1,
			status: "Integrated",
		});
		expect(result.forLLM).toContain(
			"already present in the coordinator workspace at /coordinator project",
		);
		expect(result.forLLM).toContain(
			"Do not copy, merge, cherry-pick, re-apply, or read files from the private worker worktree",
		);
		expect(result.forLLM).not.toContain("Worktree: /workers/$&/agent_a");
		expect(result.data.report).toContain(
			"Integration: completed in coordinator workspace",
		);
		expect(result.data.report).not.toContain("Worktree:");
		expect(result.data.report).not.toContain("Branch:");
	});

	it("treats unfinished write integration as failure without exposing private paths", async () => {
		for (const integrationStatus of ["pending", "skipped"] as const) {
			const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
				list: () => [],
				runWorker: async (params, run) => {
					const record: WorkerWorkspaceRecord = {
						workerId: params.workerId,
						sequence: 0,
						parentSessionId: params.parentSessionId,
						parentToolCallId: params.parentToolCallId,
						taskPrompt: params.taskPrompt,
						readOnly: false,
						coordinatorCwd: "/coordinator",
						repositoryRoot: "/repo",
						branch: "agent/private/result",
						worktreePath: "/private/worktrees/result",
						startingCommit: "start",
						resultCommit: "result",
						changedFiles: ["src/result.ts"],
						startedAt: new Date(0).toISOString(),
						finishedAt: new Date(1).toISOString(),
						executionStatus: "completed",
						integrationStatus,
						error: "Coordinator index is busy; result remains recoverable.",
					};
					return {
						result: await run({
							record,
							cwd: record.worktreePath as string,
							isolated: true,
							signal: params.signal,
						}),
						workspace: record,
					};
				},
			};
			const { tool } = makeTool({ workspaceManager });
			const result = await tool.execute(
				{ prompt: "edit files" },
				ctx(0, {
					toolCallId: `agent_${integrationStatus}`,
					cwd: "/coordinator",
				}),
			);

			expect(result.data.status).toBe("failed");
			expect(result.forLLM).toContain("Error: Agent worker failed");
			expect(result.forLLM).toContain("result remains recoverable");
			expect(result.forLLM).not.toContain("agent/private/result");
			expect(result.forLLM).not.toContain("/private/worktrees/result");
			expect(result.data.report).not.toContain("Branch:");
			expect(result.data.report).not.toContain("Worktree:");
		}
	});

	it("projects terminal integration authority after cancellation", async () => {
		const bus = new EventBus();
		const statuses: string[] = [];
		const ends: string[] = [];
		bus.on("agent:worker_update", (event) => {
			if (event.worker.workspace?.status && statuses.at(-1) !== event.worker.workspace.status) statuses.push(event.worker.workspace.status);
		});
		bus.on("agent:child_end", (event) => ends.push(event.status));
		const controller = new AbortController();
		const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
			list: () => [],
			runWorker: async (params, run) => {
				const record: WorkerWorkspaceRecord = {
					workerId: params.workerId,
					sequence: 0,
					parentSessionId: params.parentSessionId,
					parentToolCallId: params.parentToolCallId,
					taskPrompt: params.taskPrompt,
					readOnly: false,
					coordinatorCwd: "/coordinator",
					repositoryRoot: "/repo",
					startingCommit: "start",
					resultCommit: "result",
					changedFiles: ["src/result.ts"],
					startedAt: new Date(0).toISOString(),
					finishedAt: new Date(1).toISOString(),
					executionStatus: "completed",
					integrationStatus: "integrated",
				};
				const result = await run({
					record,
					cwd: "/private/worker",
					isolated: true,
					signal: params.signal,
				});
				// Cancellation races durable integration after model work. It must
				// not authorize a fresh model start with an already-aborted signal.
				controller.abort();
				params.onProgress?.(record);
				return { result, workspace: record };
			},
		};
		const { tool } = makeTool({ workspaceManager });

		const result = await tool.execute(
			{ prompt: "edit files" },
			ctx(0, {
				bus,
				signal: controller.signal,
				toolCallId: "agent_capture_wins",
				cwd: "/coordinator",
			}),
		);

		expect(result.data.status).toBe("completed");
		expect(statuses).toEqual(["Integrated"]);
		expect(ends).toEqual(["completed"]);
	});

	it("defers WWM-owned read-only completion until its durable outcome", async () => {
		const bus = new EventBus();
		const ends: string[] = [];
		bus.on("agent:child_end", (event) => ends.push(event.status));
		const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
			list: () => [],
			runWorker: async (params, run) => {
				const record: WorkerWorkspaceRecord = {
					workerId: params.workerId,
					sequence: 0,
					parentSessionId: params.parentSessionId,
					parentToolCallId: params.parentToolCallId,
					taskPrompt: params.taskPrompt,
					readOnly: true,
					coordinatorCwd: "/coordinator",
					changedFiles: [],
					startedAt: new Date(0).toISOString(),
					finishedAt: new Date(1).toISOString(),
					executionStatus: "completed",
					integrationStatus: "not_required",
				};
				return {
					result: await run({
						record,
						cwd: record.coordinatorCwd,
						isolated: false,
						signal: params.signal,
					}),
					workspace: record,
				};
			},
		};
		const { tool } = makeTool({ workspaceManager });

		const result = await tool.execute(
			{ prompt: "inspect files", read_only: true },
			ctx(0, { bus, toolCallId: "agent_read_only" }),
		);

		expect(result.data.status).toBe("completed");
		expect(ends).toEqual(["completed"]);
	});

	it("rejects a write worker when Git isolation is unavailable", async () => {
		const bus = new EventBus();
		const ends: string[] = [];
		bus.on("agent:child_end", (event) => ends.push(event.status));
		const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
			list: () => [],
			runWorker: async () => {
				throw new WorkerWorkspaceUnavailableError(
					"Git is required for isolated parallel writes.",
				);
			},
		};
		const { tool, workerCalls } = makeTool({ workspaceManager });
		let starts = 0;
		const result = await tool.execute(
			{ prompt: "edit files" },
			ctx(0, { bus, toolCallId: "agent_non_git" }),
			() => {
				starts++;
			},
		);

		expect(result.data.status).toBe("rejected");
		expect(result.forLLM).toContain("Git is required");
		expect(result.forLLM).toContain("same workspace backend");
		expect(result.execution).toMatchObject({
			outcome: "failure",
			failureCategory: "unavailable",
			retryable: false,
			mutated: false,
		});
		expect(starts).toBe(0);
		expect(workerCalls).toHaveLength(0);
		expect(ends).toEqual(["failed"]);
	});

	it("runs the worker for explicit worker subagent_type", async () => {
		const { tool, workerCalls } = makeTool();
		await tool.execute({ prompt: "inspect", subagent_type: "worker" }, ctx(0));
		expect(workerCalls[0]?.prompt).toBe("inspect");
	});

	it("surfaces worker failures in the LLM-facing output", async () => {
		const { tool } = makeTool({
			workerResult: {
				report: "(the sub-agent produced no output)",
				status: "failed",
				toolRounds: 20,
			},
		});
		const result = await tool.execute({ prompt: "inspect" }, ctx(0));

		expect(result.data.status).toBe("failed");
		expect(result.forLLM).toBe(
			"Error: Agent worker failed after 20 rounds: (the sub-agent produced no output)",
		);
	});

	it("runs the rlm loop with prompt as the full context", async () => {
		const { tool, rlmCalls } = makeTool();
		const result = await tool.execute(
			{
				prompt: "big text",
				subagent_type: "rlm",
				timeout_ms: 300_000,
				variables: { files: [{ path: "a.ts", text: "export {}" }] },
			},
			ctx(0),
		);
		expect(result.forLLM).toBe("rlm report");
		expect(result.data.mode).toBe("rlm");
		expect(rlmCalls[0]?.prompt).toBe("big text");
		expect(rlmCalls[0]?.timeoutMs).toBe(300_000);
		expect(rlmCalls[0]?.variables).toEqual({
			files: [{ path: "a.ts", text: "export {}" }],
		});
	});

	it("writes an RLM trace when a trace context is available", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-agent-trace-"));
		try {
			const sessionRoot = join(dir, ".backboard", "sessions", "sess_trace");
			const { tool } = makeTool();
			const result = await tool.execute(
				{ prompt: "trace me", subagent_type: "rlm" },
				ctx(0, {
					cwd: dir,
					trace: new AgentTraceContext({
						sessionId: "s",
						sessionRoot,
						cwd: dir,
					}).forToolCall("call_trace"),
				}),
			);

			expect(result.data.tracePath).toBe(
				".backboard/sessions/sess_trace/agents/call_trace",
			);
			const trace = JSON.parse(
				await readFile(
					join(sessionRoot, "agents", "call_trace", "trajectory.json"),
					"utf8",
				),
			);
			expect(trace.report).toBe("rlm report");
			expect(trace.status).toBe("completed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("writes an Agent error trace when RLM execution throws", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-agent-error-trace-"));
		try {
			const sessionRoot = join(dir, ".backboard", "sessions", "sess_trace");
			const { tool } = makeTool({
				createRLMLoop: () => ({
					run: async () => {
						throw new Error("rlm exploded");
					},
				}),
			});

			await expect(
				tool.execute(
					{ prompt: "trace me", subagent_type: "rlm" },
					ctx(0, {
						cwd: dir,
						trace: new AgentTraceContext({
							sessionId: "s",
							sessionRoot,
							cwd: dir,
						}).forToolCall("call_trace"),
					}),
				),
			).rejects.toThrow("rlm exploded");

			const error = JSON.parse(
				await readFile(
					join(sessionRoot, "agents", "call_trace", "error.json"),
					"utf8",
				),
			);
			expect(error.message).toBe("rlm exploded");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects recursive Agent calls past the depth cap", async () => {
		const { tool, workerCalls } = makeTool();
		const result = await tool.execute({ prompt: "deep" }, ctx(100));
		expect(result.data.status).toBe("rejected");
		expect(workerCalls).toHaveLength(0);
	});
});
