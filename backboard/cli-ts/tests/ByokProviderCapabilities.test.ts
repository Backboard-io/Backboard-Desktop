import { afterEach, describe, expect, it } from "bun:test";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import {
	anthropicAdapter,
	supportsAnthropicThinking,
	toAnthropicMessages,
} from "../src/providers/byok/adapters/AnthropicAdapter.ts";
import { openaiAdapter } from "../src/providers/byok/adapters/OpenAIAdapter.ts";
import {
	isSupportedOpenAiModel,
	openAiReasoningControls,
} from "../src/providers/byok/adapters/OpenAIModelRegistry.ts";
import { ByokError } from "../src/providers/byok/ByokError.ts";
import type { ByokMessage } from "../src/providers/byok/ByokTypes.ts";
import { getJson } from "../src/providers/byok/httpStream.ts";

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
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	},
];

interface CapturedRequest {
	body: Record<string, unknown>;
}

function stubStream(frames: string[]): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		captured.push({
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
		});
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const frame of frames) {
						controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return captured;
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** A tool turn that thinks first: a signed thinking block, a redacted one, text, then a call. */
function anthropicThinkingToolTurn(): string[] {
	return [
		JSON.stringify({
			type: "message_start",
			message: { usage: { input_tokens: 100 } },
		}),
		JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "Look at " },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "the file." },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "sig-abc" },
		}),
		JSON.stringify({ type: "content_block_stop", index: 0 }),
		JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: { type: "redacted_thinking", data: "opaque-bytes" },
		}),
		JSON.stringify({ type: "content_block_stop", index: 1 }),
		JSON.stringify({
			type: "content_block_start",
			index: 2,
			content_block: { type: "text", text: "" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 2,
			delta: { type: "text_delta", text: "Reading it." },
		}),
		JSON.stringify({ type: "content_block_stop", index: 2 }),
		JSON.stringify({
			type: "content_block_start",
			index: 3,
			content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 3,
			delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
		}),
		JSON.stringify({ type: "content_block_stop", index: 3 }),
		JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 20 },
		}),
		JSON.stringify({ type: "message_stop" }),
	];
}

describe("Anthropic thinking preservation", () => {
	it("captures signed thinking blocks in order and hands them back on the tool round", async () => {
		stubStream(anthropicThinkingToolTurn());
		const events = await collect(
			anthropicAdapter.stream(
				{
					model: "claude-opus-5",
					systemPrompt: "system",
					tools: TOOLS,
					messages: [{ role: "user", content: "read a.ts" }],
					thinking: { effort: "high" },
				},
				"sk-ant-test",
			),
		);

		const requiresAction = events.find(
			(event) => event.kind === "requires_action",
		);
		const reasoning = events
			.filter((event) => event.kind === "reasoning_delta")
			.map((event) => (event.kind === "reasoning_delta" ? event.text : ""))
			.join("");
		expect(reasoning).toBe("Look at the file.");
		expect(
			requiresAction?.kind === "requires_action"
				? JSON.parse(requiresAction.providerMetadata ?? "null")
				: null,
		).toEqual({
			model: "claude-opus-5",
			thinking: [
				{
					type: "thinking",
					thinking: "Look at the file.",
					signature: "sig-abc",
				},
				{ type: "redacted_thinking", data: "opaque-bytes" },
			],
		});
	});

	it("replays the blocks unchanged ahead of the assistant content for the same model only", () => {
		const providerMetadata = JSON.stringify({
			model: "claude-opus-5",
			thinking: [
				{
					type: "thinking",
					thinking: "Look at the file.",
					signature: "sig-abc",
				},
				{ type: "redacted_thinking", data: "opaque-bytes" },
			],
		});
		const messages: ByokMessage[] = [
			{ role: "user", content: "read a.ts" },
			{
				role: "assistant",
				content: "Reading it.",
				toolCalls: [
					{ id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
				],
				providerMetadata,
			},
			{
				role: "tool",
				results: [{ id: "toolu_1", name: "read_file", output: "contents" }],
			},
		];

		const sameModel = toAnthropicMessages(messages, "claude-opus-5") as Array<{
			content: Array<Record<string, unknown>>;
		}>;
		const otherModel = toAnthropicMessages(
			messages,
			"claude-sonnet-5",
		) as Array<{ content: Array<Record<string, unknown>> }>;

		expect(sameModel[1]?.content.map((block) => block.type)).toEqual([
			"thinking",
			"redacted_thinking",
			"text",
			"tool_use",
		]);
		expect(sameModel[1]?.content[0]).toEqual({
			type: "thinking",
			thinking: "Look at the file.",
			signature: "sig-abc",
		});
		// Signatures are model-bound: a different model gets the visible history only.
		expect(otherModel[1]?.content.map((block) => block.type)).toEqual([
			"text",
			"tool_use",
		]);
	});

	it("drops an unsigned thinking block and ignores metadata it did not write", () => {
		const messages: ByokMessage[] = [
			{
				role: "assistant",
				content: "Hello",
				toolCalls: [],
				providerMetadata: JSON.stringify({
					model: "claude-opus-5",
					thinking: [{ type: "thinking", thinking: "x", signature: "" }],
				}),
			},
			{
				role: "assistant",
				content: "Again",
				toolCalls: [],
				providerMetadata: "not json",
			},
		];
		const rendered = toAnthropicMessages(messages, "claude-opus-5") as Array<{
			content: Array<Record<string, unknown>>;
		}>;
		expect(
			rendered.map((message) => message.content.map((block) => block.type)),
		).toEqual([["text"], ["text"]]);
	});

	it("never sends thinking parameters to families that predate them", () => {
		expect(
			[
				"claude-opus-5",
				"claude-3-7-sonnet-latest",
				"claude-3-5-sonnet-20241022",
				"claude-3-opus-20240229",
			].map(supportsAnthropicThinking),
		).toEqual([true, true, false, false]);
	});
});

describe("OpenAI compatibility registry", () => {
	const supported = [
		"gpt-5",
		"gpt-5-mini",
		"gpt-5-nano",
		"gpt-5.1",
		"gpt-5.2-mini",
		"gpt-5.3-nano",
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-mini",
		"gpt-4.1",
		"gpt-4.1-mini",
		"gpt-4.1-nano",
		"gpt-4o",
		"gpt-4o-mini",
		"o3",
		"o3-mini",
		"o4-mini",
		// Dated snapshots resolve to their base id.
		"gpt-4o-2024-08-06",
		"gpt-5.5-2026-04-23",
		"o3-2025-04-16",
		"GPT-4.1 ",
	];
	const unsupported = [
		"gpt-5-pro",
		"gpt-5.4-pro",
		"gpt-5.5-pro",
		"o3-pro",
		"gpt-5-codex",
		"gpt-5.1-codex",
		"chatgpt-4o-latest",
		"gpt-5-chat-latest",
		"gpt-5.5-chat-latest",
		"o3-deep-research",
		"gpt-4o-realtime-preview",
		"gpt-4o-audio-preview",
		"gpt-4o-search-preview",
		"gpt-4o-transcribe",
		"computer-use-preview",
		"gpt-4o-mini-tts",
		"text-embedding-3-large",
		"davinci-002",
		"gpt-4",
		"gpt-4-turbo",
		"gpt-3.5-turbo",
		"o1",
		"gpt-6",
		"gpt-5.40",
		"",
	];

	it("offers exactly the Chat Completions models this adapter drives with tools", () => {
		expect(supported.filter((id) => !isSupportedOpenAiModel(id))).toEqual([]);
		expect(unsupported.filter(isSupportedOpenAiModel)).toEqual([]);
	});

	it("lists only supported ids from the account catalog", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: [...supported, ...unsupported].map((id, index) => ({
						id,
						created: index,
					})),
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const listed = await openaiAdapter.listModels("sk-test");

		expect(listed.map((model) => model.name)).toEqual(supported);
		expect(listed.every((model) => model.provider === "openai")).toBe(true);
	});

	it("refuses to stream an unsupported id before any request is made", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return new Response("", { status: 500 });
		}) as unknown as typeof fetch;

		const events = await collect(
			openaiAdapter.stream(
				{
					model: "gpt-5.5-pro",
					systemPrompt: "system",
					tools: TOOLS,
					messages: [{ role: "user", content: "hi" }],
					thinking: undefined,
				},
				"sk-test",
			),
		);

		expect(requests).toBe(0);
		expect(events).toEqual([
			{
				kind: "failed",
				error: expect.stringContaining(
					'OpenAI model "gpt-5.5-pro" is not available',
				),
				retryable: false,
			},
		]);
	});

	it("advertises reasoning levels only where the tool request will honour them", () => {
		expect(
			["gpt-5.5", "gpt-5.1", "o3", "gpt-4.1", "gpt-4o", "o3-pro"].map((id) => [
				id,
				openAiReasoningControls(id),
			]),
		).toEqual([
			// Chat Completions forces reasoning off for GPT-5.4+ with tools present.
			["gpt-5.5", { supports_thinking: false, supported_effort_levels: [] }],
			[
				"gpt-5.1",
				{
					supports_thinking: true,
					supported_effort_levels: ["low", "medium", "high"],
				},
			],
			[
				"o3",
				{
					supports_thinking: true,
					supported_effort_levels: ["low", "medium", "high"],
				},
			],
			["gpt-4.1", { supports_thinking: false, supported_effort_levels: [] }],
			["gpt-4o", { supports_thinking: false, supported_effort_levels: [] }],
			// Unsupported ids advertise nothing.
			["o3-pro", { supports_thinking: false, supported_effort_levels: [] }],
		]);
	});
});

describe("vendor error scrubbing", () => {
	it("removes the request credential and key-shaped text from HTTP failures", async () => {
		const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: {
						message: `Incorrect API key provided: ${key}. Also seen: sk-ant-zzzzzzzzzzzzzzzzzzzzzzzz9999`,
					},
				}),
				{ status: 401 },
			)) as unknown as typeof fetch;

		const failure = await getJson(
			"https://example.test/models",
			{ Authorization: `Bearer ${key}` },
			"openai",
		).catch((error) => error);

		expect(failure).toBeInstanceOf(ByokError);
		const serialized = JSON.stringify({
			message: (failure as Error).message,
			body: (failure as ByokError).body,
		});
		expect(serialized).not.toContain(key);
		expect(serialized).not.toContain("sk-ant-zzzz");
		expect((failure as Error).message).toContain("HTTP 401");
	});
});
