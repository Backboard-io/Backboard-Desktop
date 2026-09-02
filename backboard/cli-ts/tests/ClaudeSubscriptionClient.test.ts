import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	Options as ClaudeAgentOptions,
	ModelInfo as ClaudeModelInfo,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import { qSessionDir } from "../src/config/paths.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { ClaudeSubscriptionClient } from "../src/providers/subscription/ClaudeSubscriptionClient.ts";
import { ClaudeSubscriptionConversationStore } from "../src/providers/subscription/ClaudeSubscriptionConversationStore.ts";

type ClaudeSdkModule = Pick<
	typeof import("@anthropic-ai/claude-agent-sdk"),
	"query" | "tool" | "createSdkMcpServer"
>;

interface CapturedTool {
	name: string;
	description: string;
	inputSchema: Record<string, ZodTypeAny>;
	handler: (
		args: Record<string, unknown>,
		extra: unknown,
	) => Promise<CallToolResult>;
}

interface SdkCapture {
	tools: CapturedTool[];
	queryOptions?: ClaudeAgentOptions;
	toolResult?: CallToolResult;
	supportedModels?: ClaudeModelInfo[];
	closed: boolean;
}

describe("ClaudeSubscriptionClient", () => {
	it("parks Claude's SDK tool loop in Backboard and completes with Backboard's result", async () => {
		const capture: SdkCapture = { tools: [], closed: false };
		const client = new ClaudeSubscriptionClient({
			cwd: "/workspace",
			claudeExecutable: "/opt/claude",
			authCheck: async () => ({ executable: "/opt/claude" }),
			sdk: fakeClaudeSdk(capture),
		});
		const agentWait: OpenAITool = {
			type: "function",
			function: {
				name: "agent_wait",
				description: "Wait for an agent",
				parameters: {
					type: "object",
					properties: {
						yield_time_ms: {
							type: "integer",
							exclusiveMinimum: 0,
							maximum: 60_000,
						},
					},
					required: ["yield_time_ms"],
				},
			},
		};

		const firstEvents = await collect(
			client.runMessage({
				content: "Wait for the worker",
				model_name: "sonnet",
				tools: [agentWait],
			}),
		);
		const threadEvent = firstEvents.find((event) => event.kind === "thread");
		if (threadEvent?.kind !== "thread") {
			throw new Error("Claude subscription did not create a thread");
		}

		expect({
			eventKinds: firstEvents.map((event) => event.kind),
			threadPrefix: threadEvent.threadId.startsWith("claude_sub_"),
			builtInTools: capture.queryOptions?.tools,
			mcpServers: Object.keys(capture.queryOptions?.mcpServers ?? {}),
			allowedTools: capture.queryOptions?.allowedTools,
			permissionMode: capture.queryOptions?.permissionMode,
			strictMcpConfig: capture.queryOptions?.strictMcpConfig,
			settingSources: capture.queryOptions?.settingSources,
			skills: capture.queryOptions?.skills,
			model: capture.queryOptions?.model,
			registeredTools: capture.tools.map((tool) => tool.name),
		}).toEqual({
			eventKinds: ["thread", "tool_started", "tool_ready", "requires_action"],
			threadPrefix: true,
			builtInTools: [],
			mcpServers: ["backboard"],
			allowedTools: ["mcp__backboard__agent_wait"],
			permissionMode: "dontAsk",
			strictMcpConfig: true,
			settingSources: [],
			skills: [],
			model: "sonnet",
			registeredTools: ["agent_wait"],
		});

		const secondEvents = await collect(
			client.runToolOutputs({
				thread_id: threadEvent.threadId,
				tool_outputs: [
					{ tool_call_id: "call-agent-wait", output: "worker complete" },
				],
				tools: [agentWait],
			}),
		);

		expect({
			eventKinds: secondEvents.map((event) => event.kind),
			finalEvent: secondEvents.at(-1),
			toolResult: capture.toolResult,
			closed: capture.closed,
		}).toEqual({
			eventKinds: ["assistant_delta", "usage", "completed"],
			finalEvent: {
				kind: "completed",
				finalText: "The worker finished.",
				usage: {
					inputTokens: 12,
					outputTokens: 4,
					totalTokens: 16,
					cachedTokens: 3,
					cacheWriteTokens: 2,
					costUsd: 0,
					contextTokens: 12,
					contextLimit: 200_000,
					provider: "anthropic-subscription",
					model: "sonnet",
				},
			},
			toolResult: {
				content: [{ type: "text", text: "worker complete" }],
				isError: false,
			},
			closed: true,
		});
	});

	it("publishes only the Claude subscription model catalog and provider", async () => {
		const capture: SdkCapture = {
			tools: [],
			closed: false,
			supportedModels: [
				{
					value: "default",
					resolvedModel: "claude-opus-5[1m]",
					displayName: "Default (recommended)",
					description: "Opus 5 with 1M context",
					supportsEffort: true,
					supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
					supportsAdaptiveThinking: true,
				},
				{
					value: "claude-fable-5-1[1m]",
					resolvedModel: "claude-fable-5-1",
					displayName: "Fable",
					description: "Fable 5.1 with 1M context",
					supportsEffort: true,
					supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
					supportsAdaptiveThinking: true,
				},
				{
					value: "haiku",
					resolvedModel: "claude-haiku-4-5-20251001",
					displayName: "Haiku",
					description: "Haiku 4.5",
				},
			],
		};
		const client = new ClaudeSubscriptionClient({
			cwd: "/workspace",
			authCheck: async () => ({ executable: "/opt/claude" }),
			sdk: fakeClaudeSdk(capture),
		});

		const result = await client.listModels();

		expect({
			total: result.total,
			names: result.models.map((model) => model.name),
			displayNames: result.models.map((model) => model.display_name),
			providers: [...new Set(result.models.map((model) => model.provider))],
			effortLevels: result.models.map((model) => model.supported_effort_levels),
			contexts: result.models.map((model) => model.context_limit),
		}).toEqual({
			total: 3,
			names: ["default", "claude-fable-5-1[1m]", "haiku"],
			displayNames: [
				"Claude Default (Opus 5)",
				"Claude Fable 5.1",
				"Claude Haiku 4.5",
			],
			providers: ["anthropic-subscription"],
			effortLevels: [
				["low", "medium", "high", "xhigh", "max"],
				["low", "medium", "high", "xhigh", "max"],
				[],
			],
			contexts: [1_000_000, 1_000_000, 200_000],
		});
	});

	it("retries a first-turn auth failure as a fresh session without duplicating the user message", async () => {
		let authChecks = 0;
		const capture: SdkCapture = { tools: [], closed: false };
		const client = new ClaudeSubscriptionClient({
			cwd: "/workspace",
			claudeExecutable: "/opt/claude",
			authCheck: async () => {
				authChecks++;
				if (authChecks === 1) throw new Error("Claude login expired");
				return { executable: "/opt/claude" };
			},
			sdk: completingClaudeSdk(capture),
		});
		let threadId = "";

		try {
			for await (const event of client.runMessage({
				content: "Retry this once",
				model_name: "haiku",
				tools: [],
			})) {
				if (event.kind === "thread") threadId = event.threadId;
			}
			throw new Error("Expected the first auth check to fail");
		} catch (error) {
			expect(String(error)).toContain("Claude login expired");
		}

		const events = await collect(
			client.runMessage({
				thread_id: threadId,
				content: "Retry this once",
				model_name: "haiku",
				tools: [],
			}),
		);
		const thread = await client.getThread(threadId);

		expect({
			eventKinds: events.map((event) => event.kind),
			sessionId: capture.queryOptions?.sessionId,
			resume: capture.queryOptions?.resume,
			roles: thread.messages?.map((message) => message.role),
			contents: thread.messages?.map((message) => message.content),
		}).toEqual({
			eventKinds: ["assistant_delta", "usage", "completed"],
			sessionId: expect.any(String),
			resume: undefined,
			roles: ["user", "assistant"],
			contents: ["Retry this once", "Recovered."],
		});
	});

	it("resets persistence revision when a resumed Claude thread is rebound to a new Backboard session", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "claude-rebind-"));
		try {
			const store = new ClaudeSubscriptionConversationStore(cwd);
			const oldSessionId = "sess_old";
			const newSessionId = "sess_new";
			const oldSessionRoot = qSessionDir(cwd, oldSessionId);
			const newSessionRoot = qSessionDir(cwd, newSessionId);
			const threadId = "claude_sub_saved";
			const claudeSessionId = "aa38ee62-b632-4aa3-bc9b-c66eae9f7083";
			const now = new Date().toISOString();
			await store.save(
				{
					version: 1,
					revision: 0,
					threadId,
					claudeSessionId,
					sessionId: oldSessionId,
					sessionRoot: oldSessionRoot,
					model: "haiku",
					systemPrompt: "You are a coding assistant.",
					createdAt: now,
					updatedAt: now,
					messages: [
						{ role: "user", content: "Remember this.", createdAt: now },
						{ role: "assistant", content: "Remembered.", createdAt: now },
					],
				},
				0,
			);
			const capture: SdkCapture = { tools: [], closed: false };
			const client = new ClaudeSubscriptionClient({
				cwd,
				conversationStore: store,
				authCheck: async () => ({ executable: "/opt/claude" }),
				sdk: completingClaudeSdk(capture),
			});

			const events = await collect(
				client.runMessage(
					{
						thread_id: threadId,
						content: "Continue in the new session.",
						model_name: "haiku",
						tools: [],
					},
					{
						durableSession: {
							sessionId: newSessionId,
							sessionRoot: newSessionRoot,
						},
					},
				),
			);
			const rebound = await store.getAtSessionRoot(newSessionRoot, threadId);
			const original = await store.getAtSessionRoot(oldSessionRoot, threadId);

			expect({
				warnings: events.filter((event) => event.kind === "warning"),
				sessionId: capture.queryOptions?.sessionId,
				resume: capture.queryOptions?.resume,
				reboundRevision: rebound?.revision,
				reboundSessionId: rebound?.sessionId,
				reboundMessages: rebound?.messages.map((message) => message.content),
				originalRevision: original?.revision,
			}).toEqual({
				warnings: [],
				sessionId: undefined,
				resume: claudeSessionId,
				reboundRevision: 1,
				reboundSessionId: newSessionId,
				reboundMessages: [
					"Remember this.",
					"Remembered.",
					"Continue in the new session.",
					"Recovered.",
				],
				originalRevision: 1,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function fakeClaudeSdk(capture: SdkCapture): ClaudeSdkModule {
	const tool = ((
		name: string,
		description: string,
		inputSchema: Record<string, ZodTypeAny>,
		handler: CapturedTool["handler"],
	) => {
		const definition = { name, description, inputSchema, handler };
		capture.tools.push(definition);
		return definition;
	}) as unknown as ClaudeSdkModule["tool"];
	const createSdkMcpServer = ((options: {
		name: string;
		version?: string;
		tools?: CapturedTool[];
		alwaysLoad?: boolean;
	}) => ({
		type: "sdk",
		name: options.name,
	})) as unknown as ClaudeSdkModule["createSdkMcpServer"];
	const query = ((params: { options?: ClaudeAgentOptions }) => {
		capture.queryOptions = params.options;
		return scriptedQuery(capture);
	}) as unknown as ClaudeSdkModule["query"];
	return { tool, createSdkMcpServer, query };
}

function scriptedQuery(capture: SdkCapture) {
	const generator = (async function* (): AsyncGenerator<SDKMessage, void> {
		const agentWait = capture.tools.find((tool) => tool.name === "agent_wait");
		if (!agentWait) throw new Error("agent_wait was not registered");
		const result = agentWait.handler(
			{ yield_time_ms: 1_000 },
			{ _meta: { "claudecode/toolUseId": "call-agent-wait" } },
		);

		yield asSdkMessage({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "call-agent-wait",
						name: "mcp__backboard__agent_wait",
						input: { yield_time_ms: 1_000 },
					},
				],
			},
		});

		capture.toolResult = await result;
		yield asSdkMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "The worker finished." }],
			},
		});
		yield asSdkMessage({
			type: "result",
			subtype: "success",
			result: "The worker finished.",
			total_cost_usd: 0,
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 2,
			},
			modelUsage: {
				sonnet: { inputTokens: 12, contextWindow: 200_000 },
			},
		});
	})();
	return Object.assign(generator, {
		supportedModels: async () => capture.supportedModels ?? [],
		close: () => {
			capture.closed = true;
		},
	});
}

function completingClaudeSdk(capture: SdkCapture): ClaudeSdkModule {
	const base = fakeClaudeSdk(capture);
	const query = ((params: { options?: ClaudeAgentOptions }) => {
		capture.queryOptions = params.options;
		const generator = (async function* (): AsyncGenerator<SDKMessage, void> {
			yield asSdkMessage({
				type: "assistant",
				message: { content: [{ type: "text", text: "Recovered." }] },
			});
			yield asSdkMessage({
				type: "result",
				subtype: "success",
				result: "Recovered.",
				total_cost_usd: 0,
				usage: {
					input_tokens: 2,
					output_tokens: 1,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {
					haiku: { inputTokens: 2, contextWindow: 200_000 },
				},
			});
		})();
		return Object.assign(generator, {
			close: () => {
				capture.closed = true;
			},
		});
	}) as unknown as ClaudeSdkModule["query"];
	return { ...base, query };
}

function asSdkMessage(value: Record<string, unknown>): SDKMessage {
	return value as unknown as SDKMessage;
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
