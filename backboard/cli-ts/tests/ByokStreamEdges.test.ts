import { afterEach, describe, expect, it } from "bun:test";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { requiresDisabledToolReasoning } from "../src/providers/byok/adapters/OpenAIModelRegistry.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const TOOLS: OpenAITool[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: {} },
		},
	},
];

function stubStream(
	frames: string[],
	onRequest?: (body: Record<string, unknown>) => void,
): void {
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		if (onRequest) {
			if (typeof init?.body !== "string") {
				throw new Error("Expected a JSON request body.");
			}
			onRequest(JSON.parse(init.body) as Record<string, unknown>);
		}
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const frame of frames) {
						controller.enqueue(new TextEncoder().encode(`${frame}\n\n`));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function client(): ByokClient {
	return new ByokClient(() => "test-key");
}

function request(provider: string, model: string): SendMessageRequest {
	return {
		content: "explain SSE",
		llm_provider: provider,
		model_name: model,
		system_prompt: "You are a coding agent.",
		tools: TOOLS,
	};
}

function openAiChunk(content: string): string {
	return `data: ${JSON.stringify({
		choices: [{ delta: { content }, finish_reason: null }],
	})}`;
}

describe("SSE sentinel handling", () => {
	// The payload is JSON, so a substring match over the raw frame ends the
	// stream on any message that merely quotes the sentinel.
	it("does not end the stream on assistant text containing the sentinel", async () => {
		stubStream([
			openAiChunk("An SSE stream ends with "),
			openAiChunk("data: [DONE]"),
			openAiChunk(" on its own line."),
			`data: ${JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop" }],
			})}`,
			"data: [DONE]",
		]);

		const events = await collect(
			client().runMessage(request("openai", "gpt-5")),
		);
		const text = events
			.filter((event) => event.kind === "assistant_delta")
			.map((event) => (event.kind === "assistant_delta" ? event.text : ""))
			.join("");

		expect(text).toBe("An SSE stream ends with data: [DONE] on its own line.");
		expect(events.at(-1)).toMatchObject({ kind: "completed" });
	});

	it("still ends the stream on a real sentinel frame", async () => {
		stubStream([openAiChunk("hi"), "data: [DONE]", openAiChunk(" ignored")]);

		const events = await collect(
			client().runMessage(request("openai", "gpt-5")),
		);
		const text = events
			.filter((event) => event.kind === "assistant_delta")
			.map((event) => (event.kind === "assistant_delta" ? event.text : ""))
			.join("");

		expect(text).toBe("hi");
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			retryable: true,
		});
	});

	it("fails when the transport closes before a finish reason", async () => {
		stubStream([openAiChunk("partial")]);

		const events = await collect(
			client().runMessage(request("openai", "gpt-5")),
		);

		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			retryable: true,
		});
	});
});

describe("OpenAI truncated tool calls", () => {
	function truncated(): string[] {
		return [
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									function: { name: "read_file", arguments: '{"path": "/re' },
								},
							],
						},
						finish_reason: null,
					},
				],
			})}`,
			`data: ${JSON.stringify({
				choices: [{ delta: {}, finish_reason: "length" }],
			})}`,
			"data: [DONE]",
		];
	}

	// `tool_ready` starts read-only tools running ahead of the round, so a call
	// with half-parsed arguments must never be offered.
	it("never offers a call cut off by the output limit", async () => {
		stubStream(truncated());
		const events = await collect(
			client().runMessage(request("openai", "gpt-5")),
		);

		expect(events.some((event) => event.kind === "tool_ready")).toBe(false);
	});

	it("reports the truncation rather than completing an empty turn", async () => {
		stubStream(truncated());
		const events = await collect(
			client().runMessage(request("openai", "gpt-5")),
		);

		expect(events.at(-1)).toMatchObject({ kind: "failed", retryable: true });
	});
});

describe("OpenAI tool reasoning compatibility", () => {
	it("classifies the affected GPT family boundaries", () => {
		for (const model of [
			"gpt-5.4",
			"gpt-5.4-mini-2026-03-17",
			"gpt-5.5-2026-04-23",
			"gpt-5.6-luna",
		]) {
			expect(requiresDisabledToolReasoning(model)).toBe(true);
		}
		for (const model of ["gpt-5.3", "gpt-5.40", "gpt-6", "o4-mini"]) {
			expect(requiresDisabledToolReasoning(model)).toBe(false);
		}
	});

	it("disables reasoning_effort for affected tool requests", async () => {
		let captured: Record<string, unknown> | undefined;
		stubStream(
			[
				`data: ${JSON.stringify({
					choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
				})}`,
				"data: [DONE]",
			],
			(body) => {
				captured = body;
			},
		);

		await collect(
			client().runMessage({
				...request("openai", "gpt-5.5"),
				thinking: { effort: "high" },
			}),
		);

		expect(captured?.tools).toBeDefined();
		expect(captured?.reasoning_effort).toBe("none");
	});

	it("keeps reasoning_effort for earlier GPT-5 tool requests", async () => {
		let captured: Record<string, unknown> | undefined;
		stubStream(
			[
				`data: ${JSON.stringify({
					choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
				})}`,
				"data: [DONE]",
			],
			(body) => {
				captured = body;
			},
		);

		await collect(
			client().runMessage({
				...request("openai", "gpt-5.2"),
				thinking: { effort: "high" },
			}),
		);

		expect(captured?.tools).toBeDefined();
		expect(captured?.reasoning_effort).toBe("high");
	});

	it("keeps reasoning_effort when an affected model has no tools", async () => {
		let captured: Record<string, unknown> | undefined;
		stubStream(
			[
				`data: ${JSON.stringify({
					choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
				})}`,
				"data: [DONE]",
			],
			(body) => {
				captured = body;
			},
		);

		await collect(
			client().runMessage({
				...request("openai", "gpt-5.6"),
				tools: [],
				thinking: { effort: "high" },
			}),
		);

		expect(captured?.tools).toBeUndefined();
		expect(captured?.reasoning_effort).toBe("high");
	});
});

describe("Gemini abnormal finishes", () => {
	it("keeps id-less calls unique across simultaneous workers and later rounds", async () => {
		stubStream([
			`data: ${JSON.stringify({
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { name: "read_file", args: { path: "a.ts" } } },
								{ functionCall: { name: "read_file", args: { path: "b.ts" } } },
								{
									functionCall: {
										id: "provider-owned-id",
										name: "read_file",
										args: { path: "c.ts" },
									},
								},
							],
						},
						finishReason: "STOP",
					},
				],
			})}`,
		]);
		const run = () =>
			collect(client().runMessage(request("google", "gemini-2.5-flash")));
		const streams = await Promise.all([run(), run()]);
		streams.push(await run());
		const localIds: string[] = [];
		for (const events of streams) {
			const ready = events.flatMap((event) =>
				event.kind === "tool_ready" ? [event.call] : [],
			);
			const final = events.find((event) => event.kind === "requires_action");
			expect(final).toMatchObject({ kind: "requires_action", calls: ready });
			expect(ready[2]?.id).toBe("provider-owned-id");
			for (const call of ready.slice(0, 2)) {
				expect(call.id).toMatch(/^gemini_call_[a-f0-9-]+_\d+$/);
				localIds.push(call.id);
			}
		}
		expect(localIds).toHaveLength(6);
		expect(new Set(localIds).size).toBe(6);
	});

	it("streams thought parts as reasoning instead of answer text", async () => {
		stubStream([
			`data: ${JSON.stringify({
				candidates: [
					{
						content: {
							parts: [
								{ text: "Checking first.", thought: true },
								{ text: "Final answer." },
							],
						},
						finishReason: "STOP",
					},
				],
			})}`,
		]);

		const events = await collect(
			client().runMessage(request("google", "gemini-2.5-flash")),
		);

		expect(events).toContainEqual({
			kind: "reasoning_delta",
			text: "Checking first.",
		});
		expect(events).toContainEqual({
			kind: "assistant_delta",
			text: "Final answer.",
		});
	});

	it("fails when the transport closes before a finish reason", async () => {
		stubStream([
			`data: ${JSON.stringify({
				candidates: [{ content: { parts: [{ text: "partial" }] } }],
			})}`,
		]);

		const events = await collect(
			client().runMessage(request("google", "gemini-2.5-flash")),
		);

		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			retryable: true,
		});
	});

	it("surfaces a safety stop instead of an empty reply", async () => {
		stubStream([
			`data: ${JSON.stringify({
				candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
			})}`,
		]);

		const events = await collect(
			client().runMessage(request("google", "gemini-2.5-flash")),
		);

		expect(events.at(-1)).toMatchObject({ kind: "failed" });
		const failure = events.at(-1);
		expect(failure?.kind === "failed" ? failure.error : "").toContain("safety");
	});

	it("surfaces a blocked prompt", async () => {
		stubStream([
			`data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}`,
		]);

		const events = await collect(
			client().runMessage(request("google", "gemini-2.5-flash")),
		);

		expect(events.at(-1)).toMatchObject({ kind: "failed" });
	});

	it("completes normally on a plain stop", async () => {
		stubStream([
			`data: ${JSON.stringify({
				candidates: [
					{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
				],
			})}`,
		]);

		const events = await collect(
			client().runMessage(request("google", "gemini-2.5-flash")),
		);

		expect(events.at(-1)).toMatchObject({ kind: "completed" });
	});
});
