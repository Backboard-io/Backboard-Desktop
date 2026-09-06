import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ThinkingIntent } from "../src/config/thinking.types.ts";
import { createRuntimeThinkingResolver } from "../src/config/thinkingRuntime.ts";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { summarizeToolRound } from "../src/core/agent/ToolRoundEvidence.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import {
	argumentErrorSummary,
	executionFailed,
	isValidationCommand,
} from "../src/core/tools/ToolFailure.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { reasoningConfig } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { makeContext } from "./helpers.ts";

class FixtureTool extends Tool<{ command?: string }> {
	readonly inputSchema = z.object({ command: z.string().optional() });
	constructor(
		readonly name: string,
		private readonly result: ToolResult | Error,
		private readonly readOnly = true,
	) {
		super();
	}
	override isReadOnly() {
		return this.readOnly;
	}
	async execute() {
		if (this.result instanceof Error) throw this.result;
		return this.result;
	}
}

async function runFixture(
	tool: FixtureTool,
	intent: ThinkingIntent | null | undefined = { kind: "dynamic" },
	input = {},
	supported = true,
	options: { verify?: boolean; conflictingFinal?: boolean } = {},
) {
	const bus = new EventBus();
	const events: AgentEvent[] = [];
	bus.onAny((event) => events.push(event));
	const initial: SendMessageRequest[] = [];
	const continuations: SubmitToolOutputsRequest[] = [];
	const fake = {
		async getModelThinkingMetadata() {
			return {
				provider: "openai",
				model: "fixture",
				supports_thinking: supported,
				thinking_controls: {
					supported,
					allowed_fields: supported ? ["effort"] : [],
					defaults_only: false,
				},
			};
		},
		async *runMessage(request: SendMessageRequest) {
			initial.push(request);
			if (initial.length > 1) {
				yield { kind: "completed", finalText: "Verified" };
				return;
			}
			yield {
				kind: "requires_action",
				runId: "run",
				calls: [{ id: "call", name: tool.name, input }],
			};
		},
		async *runToolOutputs(request: SubmitToolOutputsRequest) {
			continuations.push(request);
			if (options.conflictingFinal) {
				yield {
					kind: "requires_action",
					runId: "run",
					calls: [
						{ id: "call", name: tool.name, input: { command: "different" } },
					],
				};
				return;
			}
			yield { kind: "completed", finalText: "Complete" };
		},
	} as unknown as AgentClient;
	const registry = new ToolRegistry([tool]);
	const session = new Session("fixture");
	const resolver = await createRuntimeThinkingResolver(
		{ model: { provider: "openai", model: "fixture" }, thinkingIntent: intent },
		fake,
	);
	const loop = new AgentLoop({
		client: fake,
		scheduler: new ToolScheduler(registry, bus),
		session,
		bus,
		tools: [tool.toJSONSchema()],
		systemPrompt: "Fixture",
		model: { provider: "openai", model: "fixture" },
		memory: "off",
		memoryProfile: "code",
		thinking: undefined,
		thinkingResolver: resolver,
		finalVerificationNudge: options.verify,
	});
	const status = await loop.run(
		"Read the known file",
		makeContext(new AbortController().signal, bus),
	);
	return { initial, continuations, events, session, status };
}

describe("typed tool state and full request thinking policy", () => {
	it("preserves fixed thinking for a necessary verification request", async () => {
		const result = await runFixture(
			new FixtureTool("Edit", ok({}, "updated", "edit"), false),
			{ kind: "level", level: "high" },
			{},
			true,
			{ verify: true },
		);
		expect(result.status).toBe("completed");
		expect(result.initial).toHaveLength(2);
		expect(result.initial[1]?.thinking).toEqual({ effort: "high" });
	});
	it("rejects an answered ID whose arguments change in a later round", async () => {
		const result = await runFixture(
			new FixtureTool("Read", ok({}, "read", "read")),
			{ kind: "dynamic" },
			{},
			true,
			{ conflictingFinal: true },
		);
		expect(result.status).toBe("failed");
		expect(result.continuations).toHaveLength(1);
		expect(
			result.events.filter((event) => event.type === "tool:result"),
		).toHaveLength(1);
		expect(
			result.events.find((event) => event.type === "run:error"),
		).toMatchObject({ error: expect.stringContaining("changed identity") });
	});

	it("treats error examples in successful searches as data", async () => {
		const result = await runFixture(
			new FixtureTool(
				"Grep",
				ok({}, "Error: example\nexit code: 9\n[timed out]", "matches"),
			),
		);
		expect(result.status).toBe("completed");
		expect(result.initial[0]?.thinking).toEqual({ effort: "low" });
		expect(result.continuations[0]?.thinking).toEqual({ effort: "low" });
		expect(
			result.session.getMessages().find((m) => m.role === "tool"),
		).toMatchObject({ results: [{ isError: false }] });
	});
	for (const category of [
		"unavailable",
		"missing_path",
		"invalid_argument",
		"permission",
		"timeout",
		"unknown",
	]) {
		it(`does not escalate ${category}`, async () => {
			const error = Object.assign(new Error("fixture"), { category });
			const result = await runFixture(new FixtureTool("Grep", error));
			expect(result.continuations[0]?.thinking).toEqual({ effort: "low" });
			expect(
				result.session.getMessages().find((m) => m.role === "tool"),
			).toMatchObject({
				results: [{ isError: true, execution: { failureCategory: category } }],
			});
		});
	}
	for (const command of [
		"bun test tests/example.test.ts",
		"node --test test/*.test.mjs",
	]) {
		it(`escalates failed validation for ${command}, without parsing output`, async () => {
			const result = await runFixture(
				new FixtureTool(
					"Execute",
					{
						...ok({}, "test failed", "check"),
						terminalOutput: { text: "test failed", exitCode: 1 },
					},
					false,
				),
				{ kind: "dynamic" },
				{ command },
			);
			expect(result.continuations[0]?.thinking).toEqual({ effort: "high" });
		});
	}
	it("uses low after a successful edit or validation", async () => {
		for (const tool of [
			new FixtureTool("Edit", ok({}, "updated", "edit"), false),
			new FixtureTool(
				"Execute",
				{
					...ok({}, "pass", "check"),
					terminalOutput: { text: "pass", exitCode: 0 },
				},
				false,
			),
		]) {
			const result = await runFixture(
				tool,
				{ kind: "dynamic" },
				{ command: "bun test" },
			);
			expect(result.continuations[0]?.thinking).toEqual({ effort: "low" });
		}
	});
	it("honors fixed effort, explicit off, and unsupported capabilities", async () => {
		const tool = new FixtureTool("Grep", new Error("fixture"));
		expect(
			(await runFixture(tool, { kind: "level", level: "high" }))
				.continuations[0]?.thinking,
		).toEqual({ effort: "high" });
		expect(
			(await runFixture(tool, null)).continuations[0]?.thinking,
		).toBeNull();
		expect(
			(await runFixture(tool, { kind: "level", level: "high" }, {}, false))
				.initial[0]?.thinking,
		).toBeNull();
	});
	it("does not infer failure from untyped output", () => {
		expect(
			summarizeToolRound([
				{ tool_call_id: "a", output: "Error: exit code: 1 [timed out]" },
			]),
		).toMatchObject({
			hadToolError: false,
			hadNonZeroExit: false,
			hadTimeout: false,
			hadSemanticFailure: false,
		});
	});
	it("recognizes only direct validation commands and keeps compact argument errors", () => {
		expect(isValidationCommand({ command: "bun run typecheck" })).toBe(true);
		expect(
			isValidationCommand({ command: "node --test test/*.test.mjs" }),
		).toBe(true);
		for (const command of [
			"echo test",
			"node --test test/a.mjs && touch unexpected",
			"node --test-only test/a.mjs",
			"bun test && edit",
			"bun test; false",
			"cat tests/test.ts",
		])
			expect(isValidationCommand({ command })).toBe(false);
		const parsed = z
			.object({ count: z.number() })
			.safeParse({ count: "wrong" });
		if (!parsed.success)
			expect(argumentErrorSummary(parsed.error)).toBe(
				"count: Expected number, received string",
			);
	});
	it("reports cancellation and no-match outcomes independently from exit code", () => {
		expect(executionFailed({ cancelled: true })).toBe(true);
		expect(executionFailed({ exitCode: 1, outcome: "no_match" })).toBe(false);
		expect(executionFailed({ exitCode: 2 })).toBe(true);
	});
	it("removes unavailable search capabilities from continuation requests", async () => {
		const result = await runFixture(
			new FixtureTool(
				"Grep",
				Object.assign(new Error("unavailable"), { category: "unavailable" }),
			),
		);
		expect(result.continuations[0]?.tools).toEqual([]);
	});
	it("does not map maximum intent to low and distinguishes omission", () => {
		expect(reasoningConfig({ effort: "max" })).toEqual({
			effort: "high",
			summary: "auto",
		});
		expect(reasoningConfig(undefined)).toEqual({ summary: "auto" });
	});
});
