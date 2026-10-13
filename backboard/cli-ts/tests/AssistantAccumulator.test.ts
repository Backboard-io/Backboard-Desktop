import { describe, expect, it } from "bun:test";
import { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent, ToolCallRef } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";

const toolCall: ToolCallRef = { id: "call_1", name: "TodoWrite", input: {} };

function makeAccumulator(deps?: {
	suppressFinalMessage?: () => boolean;
	suppressAllMessages?: () => boolean;
	reasoningFlushIntervalMs?: number;
	answerFlushIntervalMs?: number;
}) {
	const bus = new EventBus();
	const session = new Session("sess_test");
	const events: AgentEvent[] = [];
	bus.onAny((event) => events.push(event));
	const accumulator = new AssistantAccumulator("turn_1", bus, session, deps);
	return { accumulator, events, session };
}

function eventTypes(events: AgentEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("AssistantAccumulator", () => {
	it("streams reasoning chunks as display-only events", () => {
		const { accumulator, events, session } = makeAccumulator();
		accumulator.appendReasoning("thinking about it");
		accumulator.finalize();

		expect(events).toEqual([
			{
				type: "assistant:reasoning",
				turnId: "turn_1",
				text: "thinking about it",
			},
		]);
		expect(session.getMessages()).toEqual([]);
	});

	it("coalesces rapid reasoning and flushes it before the next boundary", () => {
		const { accumulator, events } = makeAccumulator({
			reasoningFlushIntervalMs: 1_000,
		});
		accumulator.appendReasoning("first");
		accumulator.appendReasoning(" second");
		accumulator.appendReasoning(" third");

		expect(events).toHaveLength(1);
		accumulator.finalize();
		expect(events).toEqual([
			{
				type: "assistant:reasoning",
				turnId: "turn_1",
				text: "first",
			},
			{
				type: "assistant:reasoning",
				turnId: "turn_1",
				text: " second third",
			},
		]);
	});

	it("streams deltas and finalizes into a shown message by default", () => {
		const { accumulator, events, session } = makeAccumulator();
		accumulator.appendDelta("Hello");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:delta",
			"assistant:message",
		]);
		expect(session.getMessages()).toHaveLength(1);
	});

	it("publishes the first visible text immediately, then coalesces the burst", () => {
		const { accumulator, events } = makeAccumulator({
			answerFlushIntervalMs: 1_000,
		});
		accumulator.appendDelta("Hello");

		// The first chunk is never held back: time to first token must not be
		// padded by the pacing window.
		expect(events).toEqual([
			{
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: "Hello",
			},
		]);

		accumulator.appendDelta(" from");
		accumulator.appendDelta(" the");
		accumulator.appendDelta(" model");

		// The rest of the burst waits for the window or a boundary, so a token
		// flood cannot drive a repaint per token.
		expect(events).toHaveLength(1);

		accumulator.finalize();
		expect(events).toEqual([
			{
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: "Hello",
			},
			{
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: " from the model",
			},
			{
				type: "assistant:message",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: "Hello from the model",
			},
		]);
	});

	it("paces a large backlog out over several windows instead of dumping it", async () => {
		const { accumulator, events } = makeAccumulator({
			answerFlushIntervalMs: 5,
		});
		accumulator.appendDelta("Hi");
		accumulator.appendDelta("x".repeat(300));
		accumulator.appendDelta("x".repeat(300));

		await Bun.sleep(8);

		const revealed = (caught: typeof events) =>
			caught
				.filter((event) => event.type === "assistant:delta")
				.reduce((total, event) => total + event.text.length, 0);
		const revealedEarly = revealed(events);
		// Some of the backlog has been revealed, but nowhere near all of it:
		// the burst is spread across frames rather than dumped in one update.
		expect(revealedEarly).toBeGreaterThan(2);
		expect(revealedEarly).toBeLessThan(602);

		accumulator.finalize();
		expect(revealed(events)).toBe(602);
	});

	it("paces a single oversized chunk into a bite plus a drained remainder", async () => {
		const { accumulator, events } = makeAccumulator({
			answerFlushIntervalMs: 5,
		});
		accumulator.appendDelta("x".repeat(1200));

		// The first frame reveals a bite, not the whole chunk.
		const first = events[0];
		expect(first?.type).toBe("assistant:delta");
		expect(
			first?.type === "assistant:delta" ? first.text.length : 0,
		).toBeLessThan(1200);

		await Bun.sleep(350);

		// The remainder drains within the drain window instead of waiting for
		// finalize, and nothing is lost.
		const total = events.reduce(
			(total, event) =>
				event.type === "assistant:delta" ? total + event.text.length : total,
			0,
		);
		expect(total).toBe(1200);
		expect(events.length).toBeGreaterThan(3);
	});

	it("keeps answer text ahead of reasoning that arrives after it", () => {
		const { accumulator, events } = makeAccumulator({
			answerFlushIntervalMs: 1_000,
		});
		accumulator.appendDelta("the answer");
		accumulator.appendReasoning("still thinking");

		expect(events).toEqual([
			{
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: "the answer",
			},
			{
				type: "assistant:reasoning",
				turnId: "turn_1",
				text: "still thinking",
			},
		]);
	});

	it("drops coalesced answer text when the segment is discarded", () => {
		const { accumulator, events } = makeAccumulator({
			answerFlushIntervalMs: 1_000,
		});
		accumulator.appendDelta("superseded");
		// The first chunk was published immediately; this one is still buffered
		// and must be dropped rather than published when the segment is discarded.
		accumulator.appendDelta(" text");
		accumulator.discardPartial();

		expect(events).toEqual([
			{
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text: "superseded",
			},
			{
				type: "assistant:message:discard",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
			},
		]);
	});

	it("discards a buffered true final answer but shows buffered commentary before tool rounds", () => {
		const buffered = makeAccumulator({ suppressFinalMessage: () => true });
		buffered.accumulator.appendDelta("done");
		buffered.accumulator.finalize();
		expect(eventTypes(buffered.events)).toEqual(["assistant:message:discard"]);
		expect(buffered.session.getMessages()).toHaveLength(1);

		const commentary = makeAccumulator({ suppressFinalMessage: () => true });
		commentary.accumulator.appendDelta("on it");
		commentary.accumulator.finalize([toolCall]);
		expect(eventTypes(commentary.events)).toEqual(["assistant:message"]);
	});

	it("hides a suppressed exchange entirely, even when tool calls follow", () => {
		const { accumulator, events, session } = makeAccumulator({
			suppressAllMessages: () => true,
		});
		accumulator.appendDelta("Updating the plan");
		accumulator.finalize([toolCall]);
		accumulator.appendDelta("Plan is up-to-date.");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:message:discard",
			"assistant:message:discard",
		]);
		// Hidden text still lands in the session so the model keeps its own
		// words in context.
		expect(session.getMessages()).toHaveLength(2);
	});

	it("evaluates suppression per segment, so hiding ends with the exchange", () => {
		let hide = true;
		const { accumulator, events } = makeAccumulator({
			suppressAllMessages: () => hide,
		});
		accumulator.appendDelta("hidden reply");
		accumulator.finalize();
		hide = false;
		accumulator.appendDelta("visible reply");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:message:discard",
			"assistant:delta",
			"assistant:message",
		]);
	});
});
