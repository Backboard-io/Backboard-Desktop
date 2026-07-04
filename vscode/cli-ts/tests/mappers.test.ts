import { describe, expect, it } from "bun:test";
import {
	BackboardStreamEventMapper,
	mapStreamPayloadToEvents,
} from "../src/providers/backboard/mappers.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";

function kinds(events: ProviderEvent[]): string[] {
	return events.map((e) => e.kind);
}

describe("reasoning streaming", () => {
	it("emits reasoning deltas from accumulated_reasoning", () => {
		const mapper = new BackboardStreamEventMapper();
		const first = mapper.map({
			type: "reasoning_streaming",
			content: "Let me",
			accumulated_reasoning: "Let me",
		});
		const second = mapper.map({
			type: "reasoning_streaming",
			content: " think",
			accumulated_reasoning: "Let me think",
		});
		expect(first).toEqual([{ kind: "reasoning_delta", text: "Let me" }]);
		expect(second).toEqual([{ kind: "reasoning_delta", text: " think" }]);
	});

	it("maps a plain reasoning_delta chunk", () => {
		expect(
			mapStreamPayloadToEvents({ type: "reasoning_delta", content: "hmm" }),
		).toEqual([{ kind: "reasoning_delta", text: "hmm" }]);
	});
});

describe("mapStreamPayloadToEvents", () => {
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
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
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

	it("handles malformed tool arguments gracefully", () => {
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
		const action = events.find((e) => e.kind === "requires_action");
		if (action && action.kind === "requires_action") {
			expect(action.calls[0]?.input).toEqual({ __raw: "not-json" });
		}
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

/**
 * Regression coverage for a live incident: the backend's DSML tool-call
 * parser failed on a complex `edit` call, leaked the raw `<｜DSML｜...>`
 * tokens into `content_streaming`, and re-sent overlapping frames — which
 * the old normalization re-emitted wholesale on every frame, filling the
 * transcript with dozens of copies of raw tool-call markup.
 */
describe("DSML tool-call leak hardening", () => {
	it("suppresses leaked DSML markup from content deltas, keeping prior prose", () => {
		const mapper = new BackboardStreamEventMapper();
		const prose = mapper.map({
			type: "content_streaming",
			content: "I'll remove the duplicate.",
			accumulated_content: "I'll remove the duplicate.",
		});
		const leak = mapper.map({
			type: "content_streaming",
			content: '  <｜DSML｜tool_calls> <｜DSML｜invoke name="edit">',
			accumulated_content:
				'I\'ll remove the duplicate.  <｜DSML｜tool_calls> <｜DSML｜invoke name="edit">',
		});
		const moreLeak = mapper.map({
			type: "content_streaming",
			content: ' <｜DSML｜parameter name="edits" string="false">[...]',
			accumulated_content:
				'I\'ll remove the duplicate.  <｜DSML｜tool_calls> <｜DSML｜invoke name="edit"> <｜DSML｜parameter name="edits" string="false">[...]',
		});

		expect(prose).toEqual([
			{ kind: "assistant_delta", text: "I'll remove the duplicate." },
		]);
		// The gap between prose and the marker is emitted; the markup is not.
		expect(leak).toEqual([{ kind: "assistant_delta", text: "  " }]);
		expect(moreLeak).toEqual([]);
	});

	it("emits only the prose portion when a single frame mixes prose and DSML", () => {
		const events = mapStreamPayloadToEvents({
			type: "content_streaming",
			content: "Done. <｜DSML｜tool_calls>junk",
		});
		expect(events).toEqual([{ kind: "assistant_delta", text: "Done. " }]);
	});

	it("drops re-sent duplicate frames instead of repeating them", () => {
		const mapper = new BackboardStreamEventMapper();
		const chunk = "a long chunk the backend re-sent verbatim";
		const first = mapper.map({ type: "content_streaming", content: chunk });
		const resent = mapper.map({ type: "content_streaming", content: chunk });

		expect(first).toEqual([{ kind: "assistant_delta", text: chunk }]);
		expect(resent).toEqual([]);
	});

	it("still emits legitimately repeated short tokens", () => {
		const mapper = new BackboardStreamEventMapper();
		mapper.map({ type: "content_streaming", content: "Sing: " });
		const first = mapper.map({ type: "content_streaming", content: "la" });
		const second = mapper.map({ type: "content_streaming", content: "la" });

		expect(first).toEqual([{ kind: "assistant_delta", text: "la" }]);
		expect(second).toEqual([{ kind: "assistant_delta", text: "la" }]);
	});

	it("recovers from segment-cumulative frames that extend the previous frame", () => {
		const mapper = new BackboardStreamEventMapper();
		mapper.map({ type: "content_streaming", content: "Hello " });
		mapper.map({ type: "content_streaming", content: "world" });
		const restart = mapper.map({
			type: "content_streaming",
			content: "! And then",
		});
		const grown = mapper.map({
			type: "content_streaming",
			content: "! And then some",
		});

		expect(restart).toEqual([{ kind: "assistant_delta", text: "! And then" }]);
		expect(grown).toEqual([{ kind: "assistant_delta", text: " some" }]);
	});

	it("adopts a diverged backend accumulation without re-emitting the blob", () => {
		const mapper = new BackboardStreamEventMapper();
		const first = mapper.map({
			type: "content_streaming",
			accumulated_content: "Once upon",
		});
		const diverged = mapper.map({
			type: "content_streaming",
			accumulated_content: "Once more",
		});
		const resumed = mapper.map({
			type: "content_streaming",
			accumulated_content: "Once more!",
		});

		expect(first).toEqual([{ kind: "assistant_delta", text: "Once upon" }]);
		expect(diverged).toEqual([{ kind: "assistant_delta", text: "more" }]);
		expect(resumed).toEqual([{ kind: "assistant_delta", text: "!" }]);
	});

	it("strips DSML markup from finalized message text", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			final_content: "Removed the duplicate. <｜DSML｜tool_calls>leftover",
		});
		const completed = events.find((e) => e.kind === "completed");
		expect(completed).toBeDefined();
		if (completed && completed.kind === "completed") {
			expect(completed.finalText).toBe("Removed the duplicate.");
		}
	});
});
