import { describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTraceContext } from "../src/core/agent/AgentTraceStore.ts";
import {
	SubAgentRunner,
	type SubAgentRunParams,
} from "../src/core/agent/SubAgentRunner.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { emptyRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { Tool } from "../src/core/tools/Tool.ts";
import {
	BackboardClient,
	type RequestOptions,
} from "../src/providers/backboard/BackboardClient.ts";
import type {
	AssistantInfo,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";
import { TEST_BACKBOARD_ENV, TEST_MODEL } from "./helpers/agent.ts";
import { TestTool } from "./helpers.ts";

/** Yields one assistant message then completes. */
class CompletingClient extends BackboardClient {
	messageRequests: SendMessageRequest[] = [];
	listAssistantsSignal: AbortSignal | undefined;
	createAssistantSignal: AbortSignal | undefined;

	constructor() {
		super(TEST_BACKBOARD_ENV);
	}

	override async *runMessage(
		req: SendMessageRequest,
	): AsyncIterable<ProviderEvent> {
		this.messageRequests.push(req);
		yield { kind: "thread", threadId: "thr_sub" };
		yield {
			kind: "usage",
			usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
		};
		yield { kind: "assistant_delta", text: "final report from sub-agent" };
		yield { kind: "completed" };
	}
	override async *runToolOutputs(
		_req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		yield { kind: "completed" };
	}
	override async listAssistants(
		options: RequestOptions = {},
	): Promise<AssistantInfo[]> {
		this.listAssistantsSignal = options.signal;
		return [];
	}
	override async createAssistant(
		_req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options: RequestOptions = {},
	): Promise<AssistantInfo> {
		this.createAssistantSignal = options.signal;
		return { assistant_id: "asst_sub", name: "test assistant" };
	}
}

class RepeatingToolCallClient extends CompletingClient {
	toolOutputRequests: SubmitToolOutputsRequest[] = [];

	override async *runMessage(): AsyncIterable<ProviderEvent> {
		yield { kind: "thread", threadId: "thr_sub" };
		yield {
			kind: "requires_action",
			runId: "run_0",
			calls: [{ id: "call_0", name: "Read", input: {} }],
		};
	}

	override async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputRequests.push(req);
		const round = this.toolOutputRequests.length;
		yield {
			kind: "requires_action",
			runId: `run_${round}`,
			calls: [{ id: `call_${round}`, name: "Read", input: {} }],
		};
	}
}

function runnerWith(client: BackboardClient, tools: Tool[]): SubAgentRunner {
	return new SubAgentRunner({
		client,
		getModel: () => TEST_MODEL,
		memory: "off",
		memoryProfile: "code",
		getThinking: async () => undefined,
		systemPrompt: "you are a sub-agent",
		toolFactory: () => tools,
	});
}

describe("SubAgentRunner", () => {
	it("returns only the sub-agent's final report and aggregates usage", async () => {
		const client = new CompletingClient();
		const runner = runnerWith(client, [
			new TestTool({ name: "Read", readOnly: true }),
		]);

		const result = await runner.run({
			prompt: "summarize the module\n\nReturn one sentence.",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.report).toBe("final report from sub-agent");
		expect(result.status).toBe("completed");
		expect(result.usage.totalTokens).toBe(5);
		expect(client.messageRequests[0]?.content).toBe(
			"summarize the module\n\nReturn one sentence.",
		);
		expect(client.messageRequests[0]?.system_prompt).toBe(
			"you are a sub-agent",
		);
	});

	it("propagates the depth into the sub-agent tool context", async () => {
		let seenDepth = -1;
		const probe = new TestTool({ name: "Read", readOnly: true });
		const original = probe.execute.bind(probe);
		probe.execute = (input, ctx) => {
			seenDepth = ctx.agentDepth ?? -1;
			return original(input, ctx);
		};

		class OneRoundClient extends CompletingClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const runner = runnerWith(new OneRoundClient(), [probe]);
		await runner.run({
			prompt: "x",
			depth: 2,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});
		expect(seenDepth).toBe(2);
	});

	it("enforces the native worktree boundary in isolated worker context", async () => {
		let isolatedRoot: string | undefined;
		let permissionMode: string | undefined;
		const probe = new TestTool({ name: "Read", readOnly: true });
		const original = probe.execute.bind(probe);
		probe.execute = (input, ctx) => {
			isolatedRoot = ctx.isolatedWorkspaceRoot;
			permissionMode = ctx.permissions?.mode;
			return original(input, ctx);
		};
		class OneRoundClient extends CompletingClient {
			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield { kind: "thread", threadId: "t" };
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}
		const client = new OneRoundClient();
		const runner = runnerWith(client, [probe]);

		await runner.run({
			prompt: "change the worker checkout",
			depth: 1,
			parentCwd: "/repo.backboard-workers/session/worker-a",
			parentSignal: new AbortController().signal,
			isolatedWorkspace: true,
			parentPermissions: {
				mode: "bypass",
				rules: emptyRuleSet(),
				interactive: true,
			},
		});

		expect(isolatedRoot).toBe("/repo.backboard-workers/session/worker-a");
		expect(permissionMode).toBe("auto");
		expect(client.messageRequests[0]?.system_prompt).toContain(
			"isolated native Git worktree at /repo.backboard-workers/session/worker-a",
		);
	});

	it("allows a write worker to use relative Write paths in its assigned checkout", async () => {
		class RelativeWriteClient extends CompletingClient {
			toolOutputRequests: SubmitToolOutputsRequest[] = [];

			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "thr_write" };
				yield {
					kind: "requires_action",
					runId: "run_write",
					calls: [
						{
							id: "call_write",
							name: "Write",
							input: {
								file_path: "js/result.js",
								content: "export const result = true;\n",
							},
						},
					],
				};
			}

			override async *runToolOutputs(
				req: SubmitToolOutputsRequest,
			): AsyncIterable<ProviderEvent> {
				this.toolOutputRequests.push(req);
				yield { kind: "assistant_delta", text: "write complete" };
				yield { kind: "completed" };
			}
		}

		const worker = await mkdtemp(join(tmpdir(), "subagent-relative-write-"));
		try {
			const client = new RelativeWriteClient();
			const result = await runnerWith(client, [new WriteTool()]).run({
				prompt: "write the assigned module",
				depth: 1,
				parentCwd: worker,
				parentSignal: new AbortController().signal,
				isolatedWorkspace: true,
				parentPermissions: {
					mode: "bypass",
					rules: emptyRuleSet(),
					interactive: true,
				},
			});

			expect(result.status).toBe("completed");
			expect(client.toolOutputRequests[0]?.tool_outputs[0]?.output).toContain(
				"Wrote js/result.js",
			);
			expect(await readFile(join(worker, "js/result.js"), "utf8")).toBe(
				"export const result = true;\n",
			);
		} finally {
			await rm(worker, { recursive: true, force: true });
		}
	});

	it("reuses one private scratch directory for the worker and removes it afterward", async () => {
		class TwoRoundClient extends CompletingClient {
			private round = 0;

			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "thr_scratch" };
				yield {
					kind: "requires_action",
					runId: "run_scratch_0",
					calls: [{ id: "call_scratch_0", name: "Read", input: {} }],
				};
			}

			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				this.round++;
				if (this.round === 1) {
					yield {
						kind: "requires_action",
						runId: "run_scratch_1",
						calls: [{ id: "call_scratch_1", name: "Read", input: {} }],
					};
					return;
				}
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const scratchPaths: string[] = [];
		const probe = new TestTool({ name: "Read", readOnly: true });
		const original = probe.execute.bind(probe);
		probe.execute = async (input, ctx) => {
			expect(ctx.isolatedScratchRoot).toBeString();
			await access(ctx.isolatedScratchRoot as string);
			scratchPaths.push(ctx.isolatedScratchRoot as string);
			return original(input, ctx);
		};

		await runnerWith(new TwoRoundClient(), [probe]).run({
			prompt: "inspect twice",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			isolatedWorkspace: true,
			parentPermissions: {
				mode: "bypass",
				rules: emptyRuleSet(),
				interactive: true,
			},
		});

		expect(scratchPaths).toHaveLength(2);
		expect(new Set(scratchPaths).size).toBe(1);
		await expect(access(scratchPaths[0] as string)).rejects.toThrow();
	});

	it("ends the child row and removes scratch when a worker loop fails", async () => {
		class FailingAfterToolClient extends CompletingClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "thr_failure" };
				yield {
					kind: "requires_action",
					runId: "run_failure",
					calls: [{ id: "call_failure", name: "Read", input: {} }],
				};
			}

			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "" };
				throw new Error("provider failed after worker setup");
			}
		}

		let scratchPath: string | undefined;
		const probe = new TestTool({ name: "Read", readOnly: true });
		const original = probe.execute.bind(probe);
		probe.execute = (input, ctx) => {
			scratchPath = ctx.isolatedScratchRoot;
			return original(input, ctx);
		};
		const parentBus = new EventBus();
		const childStatuses: string[] = [];
		parentBus.on("agent:child_end", (event) =>
			childStatuses.push(event.status),
		);

		const result = await runnerWith(new FailingAfterToolClient(), [probe]).run({
			prompt: "fail after setup",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			isolatedWorkspace: true,
			parentBus,
			parentToolCallId: "agent_failure",
			parentPermissions: {
				mode: "bypass",
				rules: emptyRuleSet(),
				interactive: true,
			},
		});

		expect(result.status).toBe("failed");
		expect(childStatuses).toEqual(["failed"]);
		expect(scratchPath).toBeString();
		await expect(access(scratchPath as string)).rejects.toThrow();
	});

	it("runs worker turns without creating a Backboard assistant", async () => {
		const controller = new AbortController();
		const client = new CompletingClient();
		const runner = runnerWith(client, []);

		await runner.run({
			prompt: "x",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: controller.signal,
		});

		expect(client.listAssistantsSignal).toBeUndefined();
		expect(client.createAssistantSignal).toBeUndefined();
		expect(client.messageRequests[0]?.assistant_id).toBeUndefined();
		expect(client.messageRequests[0]?.tools).toEqual([]);
	});

	it("stops worker agents after the tool round cap", async () => {
		const client = new RepeatingToolCallClient();
		const runner = runnerWith(client, [
			new TestTool({ name: "Read", readOnly: true }),
		]);

		const result = await runner.run({
			prompt: "keep using tools",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("failed");
		expect(result.toolRounds).toBe(20);
		expect(client.toolOutputRequests).toHaveLength(20);
	});

	it("records worker child events when trace logging is configured", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-worker-trace-"));
		try {
			const client = new CompletingClient();
			const runner = runnerWith(client, []);
			const clientLogPath = join(dir, "agents", "call_worker", "client.jsonl");

			await runner.run({
				prompt: "summarize",
				depth: 1,
				parentCwd: dir,
				parentSignal: new AbortController().signal,
				trace: {
					sessionId: "sess_parent",
					context: new AgentTraceContext({
						sessionId: "sess_parent",
						sessionRoot: join(dir, ".backboard", "sessions", "sess_parent"),
						cwd: dir,
					}),
					clientLogPath,
				},
			});

			const text = await readFile(clientLogPath, "utf8");
			const records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string });
			expect(records[0]?.type).toBe("session:created");
			expect(records.map((record) => record.type)).toContain(
				"assistant:message",
			);
			expect(records.map((record) => record.type)).toContain("turn:end");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("coalesces rapid child text before relaying it to the parent", async () => {
		class BurstClient extends CompletingClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				for (let index = 0; index < 100; index++) {
					yield { kind: "assistant_delta", text: "x" };
				}
				yield { kind: "completed" };
			}
		}
		const parentBus = new EventBus();
		const relayed: ProviderEvent[] = [];
		parentBus.on("agent:child_event", (event) => {
			if (event.event.type === "assistant:delta") {
				relayed.push({ kind: "assistant_delta", text: event.event.text });
			}
		});

		await runnerWith(new BurstClient(), []).run({
			prompt: "stream a burst",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentBus,
			parentToolCallId: "call_burst",
		});

		expect(relayed).toEqual([
			{ kind: "assistant_delta", text: "x".repeat(100) },
		]);
	});

	it("does not relay child TodoWrite updates to the parent bus", async () => {
		const parentBus = new EventBus();
		const parentTodoUpdates: unknown[] = [];
		const childProgress: unknown[] = [];
		parentBus.on("todos:updated", (event) => parentTodoUpdates.push(event));
		parentBus.on("agent:child_event", (event) => {
			if (event.event.type === "tool:start") childProgress.push(event);
		});

		class TodoClient extends CompletingClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "thr_sub" };
				yield {
					kind: "requires_action",
					runId: "run_todo",
					calls: [
						{
							id: "call_todo",
							name: "TodoWrite",
							input: {
								todos: [{ content: "child task", status: "in_progress" }],
							},
						},
					],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "child done" };
				yield { kind: "completed" };
			}
		}

		const runner = runnerWith(new TodoClient(), [new TodoWriteTool()]);
		const result = await runner.run({
			prompt: "track child work",
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentBus,
			parentToolCallId: "agent_1",
		});

		expect(result.report).toBe("child done");
		expect(parentTodoUpdates).toEqual([]);
		expect(childProgress).toHaveLength(1);
	});

	it("stops relaying child events once the parent signal is aborted", () => {
		const parentBus = new EventBus();
		const relayed: string[] = [];
		parentBus.on("agent:child_event", (event) =>
			relayed.push(event.event.type),
		);

		const childBus = new EventBus();
		const controller = new AbortController();
		const runner = runnerWith(new CompletingClient(), []);
		const detach = (
			runner as unknown as {
				attachParentProgressRelay: (
					params: SubAgentRunParams,
					bus: EventBus,
				) => () => void;
			}
		).attachParentProgressRelay(
			{
				prompt: "x",
				depth: 1,
				parentCwd: process.cwd(),
				parentSignal: controller.signal,
				parentBus,
				parentToolCallId: "agent_1",
			},
			childBus,
		);

		childBus.emit({
			type: "tool:start",
			toolCallId: "c1",
			name: "Read",
			inputSummary: "",
		});
		expect(relayed).toEqual(["tool:start"]);

		// After cancel the winding-down child keeps emitting, but nothing may
		// reach the parent - it would resurrect the committed "Interrupted" row.
		controller.abort();
		childBus.emit({
			type: "tool:result",
			toolCallId: "c1",
			name: "Read",
			title: "ok",
		});
		detach();

		expect(relayed).toEqual(["tool:start"]);
	});
});
