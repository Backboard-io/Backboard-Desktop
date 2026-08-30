import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
					worktreePath: `/workers/${params.workerId}`,
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
					"edit /coordinator/src/result.ts but leave /coordinator-other/reference.ts unchanged",
			},
			ctx(0, { toolCallId: "agent_a", cwd: "/coordinator" }),
		);

		expect(workerCalls[0]?.parentCwd).toBe("/workers/agent_a");
		expect(workerCalls[0]?.prompt).toBe(
			"edit /workers/agent_a/src/result.ts but leave /coordinator-other/reference.ts unchanged",
		);
		expect(workerCalls[0]?.isolatedWorkspace).toBe(true);
		expect(workerCalls[0]?.workspace?.branch).toBe("agent/s/worker/agent_a");
		expect(result.data.worker).toMatchObject({
			branch: "agent/s/worker/agent_a",
			worktreePath: "/workers/agent_a",
			changedFileCount: 1,
			status: "Integrated",
		});
	});

	it("rejects a write worker when Git isolation is unavailable", async () => {
		const workspaceManager: NonNullable<AgentToolDeps["workspaceManager"]> = {
			list: () => [],
			runWorker: async () => {
				throw new WorkerWorkspaceUnavailableError(
					"Git is required for isolated parallel writes.",
				);
			},
		};
		const { tool, workerCalls } = makeTool({ workspaceManager });
		const result = await tool.execute(
			{ prompt: "edit files" },
			ctx(0, { toolCallId: "agent_non_git" }),
		);

		expect(result.data.status).toBe("rejected");
		expect(result.forLLM).toContain("Git is required");
		expect(workerCalls).toHaveLength(0);
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
