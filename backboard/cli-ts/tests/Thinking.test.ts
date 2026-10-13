import { describe, expect, it } from "bun:test";
import type { ThinkingModelMetadata } from "../src/config/defaults.ts";
import { parseThinking, resolveThinking } from "../src/config/defaults.ts";
import { createRuntimeThinkingResolver } from "../src/config/thinkingRuntime.ts";

const model = { provider: "test", model: "model" };

function metadata(
	allowedFields: string[],
	extra: Partial<ThinkingModelMetadata> = {},
): ThinkingModelMetadata {
	return {
		provider: "test",
		model: "model",
		supports_thinking: true,
		thinking_controls: {
			supported: allowedFields.length > 0,
			allowed_fields: allowedFields,
			defaults_only: false,
		},
		...extra,
	};
}

describe("thinking config", () => {
	it("parses semantic thinking intent", () => {
		expect(parseThinking("default")).toEqual({ kind: "default" });
		expect(parseThinking("off")).toBeNull();
		expect(parseThinking("low")).toEqual({ kind: "level", level: "low" });
		expect(parseThinking("fast")).toEqual({ kind: "level", level: "low" });
		expect(parseThinking("balanced")).toEqual({
			kind: "level",
			level: "medium",
		});
		expect(parseThinking("deep")).toEqual({ kind: "level", level: "high" });
		expect(parseThinking("maximum")).toEqual({
			kind: "level",
			level: "max",
		});
		expect(parseThinking("dynamic")).toEqual({ kind: "dynamic" });
		expect(parseThinking("adaptive")).toEqual({ kind: "dynamic" });
		expect(parseThinking("4096")).toEqual({ kind: "budget", tokens: 4096 });
		expect(() => parseThinking("on")).toThrow();
	});

	it("resolves level intent using allowed fields", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["effort"]),
			}),
		).toEqual({ effort: "high" });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["budget_tokens"]),
			}),
		).toEqual({ budget_tokens: 8192 });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["max_tokens"]),
			}),
		).toEqual({ max_tokens: 8192 });
	});

	it("always includes reasoning traces when the model exposes the control", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["max_tokens", "exclude_reasoning"]),
			}),
		).toEqual({ max_tokens: 8192, exclude_reasoning: false });
		// Provider-default thinking still requests visible traces.
		expect(
			resolveThinking({
				intent: { kind: "default" },
				model,
				metadata: metadata(["max_tokens", "exclude_reasoning"]),
			}),
		).toEqual({ exclude_reasoning: false });
		// Models without the control drop the flag instead of failing.
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["effort"]),
			}),
		).toEqual({ effort: "high" });
		// The OpenRouter profile carries the control even when the model's
		// metadata only advertises the token field.
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model: { provider: "openrouter", model: "deepseek" },
				metadata: {
					provider: "openrouter",
					model: "deepseek",
					supports_thinking: true,
					thinking_controls: {
						supported: true,
						allowed_fields: ["max_tokens"],
						defaults_only: false,
					},
				},
			}),
		).toEqual({ max_tokens: 8192, exclude_reasoning: false });
	});

	it("uses provider profiles when metadata is missing", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "max" },
				model: { provider: "google", model: "gemini-3-pro" },
			}),
		).toEqual({ effort: "high" });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "max" },
				model: { provider: "anthropic", model: "claude-sonnet-4-5" },
			}),
		).toEqual({ budget_tokens: 16384 });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model: { provider: "openrouter", model: "deepseek" },
			}),
		).toEqual({ max_tokens: 8192, exclude_reasoning: false });
	});

	it("routes numeric budgets only to token fields", () => {
		expect(
			resolveThinking({
				intent: { kind: "budget", tokens: 4096 },
				model,
				metadata: metadata(["max_tokens"]),
			}),
		).toEqual({ max_tokens: 4096 });
		expect(
			resolveThinking({
				intent: { kind: "budget", tokens: 4096 },
				model,
				metadata: metadata(["effort"]),
			}),
		).toBeNull();
	});

	it("resolves dynamic intent deterministically from evidence", () => {
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["budget_tokens"]),
			}),
		).toEqual({ budget_tokens: 4096 });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["max_tokens"]),
				dynamicEvidence: {
					phase: "initial",
					requestKind: "user",
					hasDiagnosticText: true,
				},
			}),
		).toEqual({ max_tokens: 8192 });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["effort"]),
			}),
		).toEqual({ effort: "medium" });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["effort"]),
				dynamicEvidence: {
					phase: "initial",
					requestKind: "subagent",
				},
			}),
		).toEqual({ effort: "low" });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["effort"]),
				dynamicEvidence: {
					phase: "tool_outputs",
					requestKind: "user",
					toolRound: {
						index: 1,
						readOnlyOnly: true,
						hadWriteOrExecute: false,
						hadToolError: false,
						hadNonZeroExit: false,
						hadTimeout: false,
						consecutiveFailureCount: 0,
						maxUsed: false,
					},
				},
			}),
		).toEqual({ effort: "low" });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["effort"]),
				dynamicEvidence: {
					phase: "tool_outputs",
					requestKind: "subagent",
					toolRound: {
						index: 1,
						readOnlyOnly: false,
						hadWriteOrExecute: true,
						hadToolError: false,
						hadNonZeroExit: false,
						hadTimeout: false,
						consecutiveFailureCount: 0,
						maxUsed: false,
					},
				},
			}),
		).toEqual({ effort: "low" });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model,
				metadata: metadata(["effort"]),
				dynamicEvidence: {
					phase: "tool_outputs",
					requestKind: "user",
					toolRound: {
						index: 2,
						readOnlyOnly: false,
						hadWriteOrExecute: true,
						hadToolError: false,
						hadNonZeroExit: true,
						hadTimeout: false,
						consecutiveFailureCount: 2,
						maxUsed: false,
					},
				},
			}),
		).toEqual({ effort: "low" });
		expect(
			resolveThinking({
				intent: { kind: "dynamic" },
				model: { provider: "anthropic", model: "claude-sonnet-5" },
				metadata: metadata(["effort"]),
			}),
		).toEqual({});
	});

	it("honors defaults-only and unsupported metadata", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "low" },
				model,
				metadata: metadata([], {
					thinking_controls: {
						supported: false,
						allowed_fields: [],
						defaults_only: true,
					},
				}),
			}),
		).toEqual({});
		expect(
			resolveThinking({
				intent: { kind: "level", level: "low" },
				model,
				metadata: metadata([], { supports_thinking: false }),
			}),
		).toBeNull();
	});

	it("runtime resolver fetches targeted thinking metadata only", async () => {
		let metadataCalls = 0;
		let listCalls = 0;
		const client = {
			getModelThinkingMetadata: async (provider: string, name: string) => {
				metadataCalls += 1;
				return metadata(["max_tokens"], {
					provider,
					model: name,
					max_output_tokens: 65536,
				});
			},
			listModels: async () => {
				listCalls += 1;
				return { models: [], total: 0 };
			},
		};
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: { kind: "dynamic" },
			},
			client,
		);

		expect(metadataCalls).toBe(1);
		expect(listCalls).toBe(0);
		expect(resolver.resolve({ phase: "initial", requestKind: "user" })).toEqual(
			{ max_tokens: 4096, exclude_reasoning: false },
		);
		expect(
			resolver.resolve({ phase: "tool_outputs", requestKind: "user" }),
		).toEqual({ max_tokens: 1024, exclude_reasoning: false });
	});

	it("runtime resolver skips metadata lookup when thinking is off", async () => {
		let metadataCalls = 0;
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: null,
			},
			{
				getModelThinkingMetadata: async () => {
					metadataCalls += 1;
					return metadata(["max_tokens"]);
				},
			},
		);

		expect(metadataCalls).toBe(0);
		expect(
			resolver.resolve({ phase: "initial", requestKind: "user" }),
		).toBeNull();
	});

	it("runtime resolver falls back when targeted metadata fails", async () => {
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: { kind: "dynamic" },
			},
			{
				getModelThinkingMetadata: async () => {
					throw new Error("metadata unavailable");
				},
			},
		);

		expect(resolver.resolve({ phase: "initial", requestKind: "user" })).toEqual(
			{ max_tokens: 4096, exclude_reasoning: false },
		);
	});

	it("runtime resolver turns thinking off when the model rejects it", async () => {
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "cerebras", model: "z-ai/glm-4.7" },
				thinkingIntent: { kind: "level", level: "high" },
			},
			{
				getModelThinkingMetadata: async () =>
					metadata([], { supports_thinking: false }),
			},
		);

		expect(
			resolver.resolve({ phase: "initial", requestKind: "user" }),
		).toBeNull();
	});
});
