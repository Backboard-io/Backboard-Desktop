import { describe, expect, it } from "bun:test";
import { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { ProviderStreamConsumer } from "../src/core/agent/ProviderStreamConsumer.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";

async function* providerStream(
	events: readonly ProviderEvent[],
): AsyncIterable<ProviderEvent> {
	for (const event of events) yield event;
}

describe("ProviderStreamConsumer early tool calls", () => {
	it("announces Write while its input is being generated", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const session = new Session("session_1");
		const consumer = new ProviderStreamConsumer(bus, session);
		const assistant = new AssistantAccumulator("turn_1", bus, session);
		const call = {
			id: "call_1",
			name: "Write",
			input: { file_path: "index.html", content: "hello" },
		};

		const pending = await consumer.consumeWithRetry(
			() =>
				providerStream([
					{ kind: "tool_call_start", toolCallId: call.id, name: call.name },
					{ kind: "tool_call_ready", call },
					{ kind: "requires_action", runId: "run_1", calls: [call] },
				]),
			assistant,
			new AbortController().signal,
		);

		expect(pending).toEqual({ runId: "run_1", calls: [call] });
		expect(events.filter((event) => event.type === "tool:pending")).toEqual([
			{
				type: "tool:pending",
				toolCallId: "call_1",
				name: "Write",
				inputSummary: "Generating input…",
			},
			{
				type: "tool:pending",
				toolCallId: "call_1",
				name: "Write",
				inputSummary: "index.html",
			},
		]);
		expect(events.some((event) => event.type === "tool:discarded")).toBeFalse();
	});

	it("discards an advisory call omitted from the final request", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const session = new Session("session_1");
		const consumer = new ProviderStreamConsumer(bus, session);
		const assistant = new AssistantAccumulator("turn_1", bus, session);

		await consumer.consumeWithRetry(
			() =>
				providerStream([
					{
						kind: "tool_call_start",
						toolCallId: "call_speculative",
						name: "Write",
					},
					{ kind: "completed", finalText: "No edit needed." },
				]),
			assistant,
			new AbortController().signal,
		);

		expect(events.find((event) => event.type === "tool:discarded")).toEqual({
			type: "tool:discarded",
			toolCallId: "call_speculative",
			name: "Write",
		});
	});
});
