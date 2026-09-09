import { describe, expect, it } from "bun:test";
import {
	BackboardStreamEventMapper,
	mapStreamPayloadToEvents,
	type ToolMappingTrace,
} from "../src/providers/backboard/mappers.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import workerIdentityMismatch from "./fixtures/backboard-worker-identity-mismatch.json";

function kinds(events: ProviderEvent[]): string[] {
	return events.map((e) => e.kind);
}

describe("mapStreamPayloadToEvents", () => {
	it("preserves the latest API context snapshot, including zero and compaction decreases", () => {
		const mapper = new BackboardStreamEventMapper();
		const values = [64227, 4000, 0].map((used) =>
			mapper
				.map({
					type: "run_ended",
					input_tokens: 999,
					output_tokens: 300,
					context_usage: {
						used_tokens: used,
						context_limit: 1050000,
						percent: 2.5,
						summary_tokens: 100,
						model: "actual-model",
					},
				})
				.find((event) => event.kind === "usage"),
		);
		expect(
			values.map((event) =>
				event?.kind === "usage" ? event.usage.backboardContextUsage : undefined,
			),
		).toEqual(
			[64227, 4000, 0].map((used) => ({
				source: "backboard-api",
				usedTokens: used,
				contextLimit: 1050000,
				percent: 2.5,
				summaryTokens: 100,
				model: "actual-model",
			})),
		);
	});

	it("preserves the service's mismatched worker names in diagnostics and rejects its final batch", () => {
		const traces: ToolMappingTrace[] = [];
		const mapper = new BackboardStreamEventMapper(
			["agent_spawn", "glob"],
			(trace) => traces.push(trace),
		);
		const events = workerIdentityMismatch
			.slice(0, 3)
			.flatMap((frame) => mapper.map(frame));
		const ready = traces.find((trace) => trace.event === "tool_ready");
		const final = traces.find((trace) => trace.event === "requires_action");
		expect({
			ready: ready?.name,
			final: final?.name,
			sameInput: ready?.inputFingerprint === final?.inputFingerprint,
		}).toEqual({ ready: "agent_spawn", final: "glob", sameInput: true });
		expect(events.some((event) => event.kind === "requires_action")).toBe(
			false,
		);
		expect(events.at(-1)?.kind).toBe("failed");
		expect(JSON.stringify(traces)).not.toContain("src/**/*.ts");
	});

	it("maps a completed stream response", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			thread_id: "thr_1",
			final_content: "hello world",
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			model_name: "gpt-5.5",
			context_usage: {
				used_tokens: 100,
				context_limit: 1000,
				percent: 10,
				summary_tokens: 0,
				model: "gpt-5.5",
			},
		});
		expect(kinds(events)).toEqual(["thread", "usage", "completed"]);
		expect(events.at(-1)).toEqual({
			kind: "completed",
			finalText: "hello world",
			usage: {
				backboardContextUsage: {
					source: "backboard-api",
					usedTokens: 100,
					contextLimit: 1000,
					percent: 10,
					summaryTokens: 0,
					model: "gpt-5.5",
				},
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				contextTokens: 100,
				contextLimit: 1000,
				model: "gpt-5.5",
				provider: undefined,
			},
			contextUsage: {
				used_tokens: 100,
				context_limit: 1000,
				percent: 10,
				summary_tokens: 0,
				model: "gpt-5.5",
			},
		});
	});

	it("maps content deltas", () => {
		const events = mapStreamPayloadToEvents({
			type: "content_streaming",
			content: "hello",
		});
		expect(events).toEqual([{ kind: "assistant_delta", text: "hello" }]);
	});

	it("maps generated media to a media event carrying the raw payload", () => {
		const events = mapStreamPayloadToEvents({
			type: "media_generated",
			url: "https://cdn.example.com/img.png",
			prompt: "a red fox",
		});
		expect(events).toEqual([
			{
				kind: "media",
				payload: {
					type: "media_generated",
					url: "https://cdn.example.com/img.png",
					prompt: "a red fox",
				},
			},
		]);
	});

	it("maps reasoning deltas on both reasoning event names", () => {
		expect(
			mapStreamPayloadToEvents({
				type: "reasoning_streaming",
				content: "let me think",
			}),
		).toEqual([{ kind: "reasoning_delta", text: "let me think" }]);
		expect(
			mapStreamPayloadToEvents({
				type: "reasoning_delta",
				content: "let me think",
			}),
		).toEqual([{ kind: "reasoning_delta", text: "let me think" }]);
	});

	it("keeps reasoning and content accumulators independent", () => {
		const mapper = new BackboardStreamEventMapper();

		const reasoningFirst = mapper.map({
			type: "reasoning_streaming",
			content: "Step one",
			accumulated_reasoning: "Step one",
		});
		const contentFirst = mapper.map({
			type: "content_streaming",
			content: "Answer",
			accumulated_content: "Answer",
		});
		// A cumulative reasoning retry only emits the unseen tail, and the
		// interleaved content chunk does not disturb the reasoning channel.
		const reasoningRetry = mapper.map({
			type: "reasoning_delta",
			content: "Step one and step two",
			accumulated_reasoning: "Step one and step two",
		});

		expect(reasoningFirst).toEqual([
			{ kind: "reasoning_delta", text: "Step one" },
		]);
		expect(contentFirst).toEqual([{ kind: "assistant_delta", text: "Answer" }]);
		expect(reasoningRetry).toEqual([
			{ kind: "reasoning_delta", text: " and step two" },
		]);
	});

	it("announces a known tool from raw provider deltas before its arguments finish", () => {
		const mapper = new BackboardStreamEventMapper(["write", "read"]);

		expect(
			mapper.map({
				type: "provider_chunk",
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { name: "wr", arguments: '{"path":' } },
							],
						},
					},
				],
			}),
		).toEqual([]);

		const announced = mapper.map({
			type: "provider_chunk",
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, function: { name: "ite", arguments: '"a.ts"' } },
						],
					},
				},
			],
		});

		expect(announced).toHaveLength(1);
		expect(announced[0]).toMatchObject({ kind: "tool_started", name: "write" });
		if (announced[0]?.kind === "tool_started") {
			expect(announced[0].id.startsWith("backboard_stream_")).toBe(true);
		}
		expect(
			mapper.map({
				type: "provider_chunk",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: ',"content":"large body"}' },
								},
							],
						},
					},
				],
			}),
		).toEqual([]);
	});

	it("uses the provider call id when raw tool deltas expose it early", () => {
		const mapper = new BackboardStreamEventMapper(["Write"]);

		expect(
			mapper.map({
				type: "provider_chunk",
				data: {
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_real", function: { name: "Write" } },
								],
							},
						},
					],
				},
			}),
		).toEqual([{ kind: "tool_started", id: "call_real", name: "Write" }]);
	});

	it("normalizes accumulated content streaming into deltas", () => {
		const mapper = new BackboardStreamEventMapper();

		const first = mapper.map({
			type: "content_streaming",
			content: "She climbed the stairs",
			accumulated_content: "She climbed the stairs",
		});
		const second = mapper.map({
			type: "content_streaming",
			content: ", which spiraled up higher",
			accumulated_content: "She climbed the stairs, which spiraled up higher",
		});
		const cumulativeRetry = mapper.map({
			type: "content_streaming",
			content: "She climbed the stairs, which spiraled up higher than her shop",
			accumulated_content:
				"She climbed the stairs, which spiraled up higher than her shop",
		});

		expect(first).toEqual([
			{ kind: "assistant_delta", text: "She climbed the stairs" },
		]);
		expect(second).toEqual([
			{ kind: "assistant_delta", text: ", which spiraled up higher" },
		]);
		expect(cumulativeRetry).toEqual([
			{ kind: "assistant_delta", text: " than her shop" },
		]);
	});

	it("deduplicates content field when server sends full text without accumulated_content", () => {
		const mapper = new BackboardStreamEventMapper();

		const first = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern",
		});
		const second = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern glowing in the snow",
		});
		const third = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern glowing in the snow. Who left you here?",
		});

		expect(first).toEqual([
			{ kind: "assistant_delta", text: "A fox found a lantern" },
		]);
		expect(second).toEqual([
			{ kind: "assistant_delta", text: " glowing in the snow" },
		]);
		expect(third).toEqual([
			{ kind: "assistant_delta", text: ". Who left you here?" },
		]);
	});

	it("maps a tool request and parses tool arguments", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			thread_id: "thr_2",
			run_id: "run_1",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
				},
			],
		});
		const action = events.find((e) => e.kind === "requires_action");
		expect(action).toBeDefined();
		if (action && action.kind === "requires_action") {
			expect(action.runId).toBe("run_1");
			expect(action.calls[0]?.name).toBe("Read");
			expect(action.calls[0]?.input).toEqual({ file_path: "a.ts" });
		}
	});

	it("emits usage for tool-call legs that carry provider usage", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			run_id: "run_1",
			input_tokens: 1200,
			output_tokens: 40,
			total_tokens: 1240,
			cached_input_tokens: 900,
			cache_write_input_tokens: 100,
			cost_usd: 0.0123,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
				},
			],
		});
		expect(kinds(events)).toEqual(["usage", "requires_action"]);
		const usage = events.find((e) => e.kind === "usage");
		if (usage && usage.kind === "usage") {
			expect(usage.usage).toMatchObject({
				inputTokens: 1200,
				outputTokens: 40,
				cachedTokens: 900,
				cacheWriteTokens: 100,
				costUsd: 0.0123,
			});
		}
	});

	it("omits usage for tool-call legs without usage fields (older servers)", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: "{}" },
				},
			],
		});
		expect(kinds(events)).toEqual(["requires_action"]);
	});

	it("carries cache and cost fields on run_ended usage", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			final_content: "done",
			input_tokens: 50,
			output_tokens: 10,
			total_tokens: 60,
			cached_input_tokens: 30,
			cache_write_input_tokens: 5,
			cost_usd: 0.002,
			model_name: "claude-opus-4-8",
		});
		const usage = events.find((e) => e.kind === "usage");
		expect(usage).toBeDefined();
		if (usage && usage.kind === "usage") {
			expect(usage.usage).toMatchObject({
				cachedTokens: 30,
				cacheWriteTokens: 5,
				costUsd: 0.002,
			});
		}
	});

	it("rejects malformed final tool arguments before execution", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [
				{
					id: "c",
					type: "function",
					function: { name: "X", arguments: "not-json" },
				},
			],
		});
		expect(events).toEqual([
			expect.objectContaining({ kind: "failed", retryable: false }),
		]);
	});

	it("maps run_failed events", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_failed",
			error: "boom",
		});
		expect(events).toEqual([{ kind: "failed", error: "boom" }]);
	});

	it("does not complete run_ended events with failed statuses", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			status: "failed",
			error: "model failed",
		});

		expect(events).toEqual([{ kind: "failed", error: "model failed" }]);
	});

	it("marks retryable stream server errors", () => {
		const events = mapStreamPayloadToEvents({
			type: "error",
			error: "Upstream idle timeout exceeded",
		});

		expect(events).toEqual([
			{
				kind: "failed",
				error: "Upstream idle timeout exceeded",
				retryable: true,
			},
		]);
	});

	it("keeps semantic stream failures non-retryable", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [],
		});

		expect(events).toEqual([
			{
				kind: "failed",
				error: "Backboard requested tool outputs without tool calls",
			},
		]);
	});

	it("maps cancelled events as failures", () => {
		const events = mapStreamPayloadToEvents({ type: "run_cancelled" });
		expect(kinds(events)).toEqual(["failed"]);
	});

	it("ignores malformed thread ids", () => {
		const events = mapStreamPayloadToEvents({
			type: "content_streaming",
			thread_id: 123,
			content: "hello",
		});

		expect(events).toEqual([{ kind: "assistant_delta", text: "hello" }]);
	});
});
