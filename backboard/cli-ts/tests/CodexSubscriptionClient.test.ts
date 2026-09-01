import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";

function eventStream(events: unknown[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

describe("CodexSubscriptionClient", () => {
	let testDir: string;
	let authFile: string;

	beforeAll(async () => {
		testDir = await mkdtemp(join(tmpdir(), "codex-subscription-client-"));
		authFile = join(testDir, "auth.json");
		await writeFile(
			authFile,
			JSON.stringify({
				tokens: { access_token: "test-token", account_id: "test-account" },
			}),
		);
	});

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("replays every response item and routes tool outputs into a continuation", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		let responseCount = 0;
		const fetchImpl = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			if (String(input).includes("/models?")) {
				return Response.json({
					models: [{ slug: "gpt-test", priority: 1, visibility: "list" }],
				});
			}
			requestBodies.push(JSON.parse(String(init?.body)));
			responseCount++;
			if (responseCount === 1) {
				return eventStream([
					{
						type: "response.output_item.done",
						item: {
							type: "reasoning",
							id: "reasoning-1",
							encrypted_content: "opaque",
						},
					},
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-1",
							name: "read",
							arguments: '{"file_path":"package.json"}',
						},
					},
					{ type: "response.completed", response: { usage: {} } },
				]);
			}
			return eventStream([
				{ type: "response.output_text.delta", delta: "done" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "done" }],
					},
				},
				{ type: "response.completed", response: { usage: {} } },
			]);
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({ authFile, fetchImpl });
		const tool: OpenAITool = {
			type: "function",
			function: {
				name: "read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		};

		const firstEvents = [];
		for await (const event of client.runMessage({
			content: "read package.json",
			model_name: "gpt-test",
			tools: [tool],
		})) {
			firstEvents.push(event);
		}
		const thread = firstEvents.find((event) => event.kind === "thread");
		const action = firstEvents.find(
			(event) => event.kind === "requires_action",
		);
		expect(thread?.kind).toBe("thread");
		expect(action?.kind).toBe("requires_action");

		const secondEvents = [];
		for await (const event of client.runToolOutputs({
			thread_id: thread?.kind === "thread" ? thread.threadId : "",
			tool_outputs: [{ tool_call_id: "call-1", output: "file contents" }],
			tools: [tool],
		})) {
			secondEvents.push(event);
		}

		expect(secondEvents.at(-1)).toEqual({
			kind: "completed",
			finalText: "done",
		});
		const continuation = requestBodies[1]?.input;
		expect(Array.isArray(continuation) ? continuation : []).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", id: "reasoning-1" }),
				expect.objectContaining({
					type: "function_call",
					call_id: "call-1",
				}),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call-1",
					output: "file contents",
				}),
			]),
		);
	});

	it("routes image tool results as multimodal function output", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		let responseCount = 0;
		const fetchImpl = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestBodies.push(JSON.parse(String(init?.body)));
			responseCount++;
			if (responseCount === 1) {
				return eventStream([
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-image",
							name: "read",
							arguments: '{"file_path":"layout.png"}',
						},
					},
					{ type: "response.completed", response: { usage: {} } },
				]);
			}
			return eventStream([
				{ type: "response.output_text.delta", delta: "seen" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "seen" }],
					},
				},
				{ type: "response.completed", response: { usage: {} } },
			]);
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({ authFile, fetchImpl });
		const firstEvents = [];
		for await (const event of client.runMessage({
			content: "inspect the image",
			model_name: "gpt-test",
		})) {
			firstEvents.push(event);
		}
		const thread = firstEvents.find((event) => event.kind === "thread");
		for await (const _event of client.runToolOutputs({
			thread_id: thread?.kind === "thread" ? thread.threadId : "",
			tool_outputs: [
				{
					tool_call_id: "call-image",
					output: JSON.stringify({
						filePath: "/app/layout.png",
						contentType: "image",
						mimeType: "image/png",
						sizeBytes: 3,
						__image_base64: "YWJj",
						__image_media_type: "image/png",
					}),
				},
			],
		})) {
			// Consume the continuation.
		}

		const input = requestBodies[1]?.input;
		const toolOutput = (Array.isArray(input) ? input : []).find(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				(item as Record<string, unknown>).type === "function_call_output",
		) as Record<string, unknown>;
		expect(toolOutput.output).toEqual([
			expect.objectContaining({
				type: "input_text",
				text: expect.not.stringContaining("YWJj"),
			}),
			{
				type: "input_image",
				image_url: "data:image/png;base64,YWJj",
				detail: "high",
			},
		]);
	});

	it("retries an unstarted overloaded response stream", async () => {
		let responseCount = 0;
		const fetchImpl = (async (
			_input: Parameters<typeof fetch>[0],
			_init?: Parameters<typeof fetch>[1],
		) => {
			responseCount++;
			if (responseCount === 1) {
				return eventStream([
					{
						type: "response.failed",
						response: {
							error: {
								message:
									"Our servers are currently overloaded. Please try again later.",
							},
						},
					},
				]);
			}
			return eventStream([
				{ type: "response.output_text.delta", delta: "recovered" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "recovered" }],
					},
				},
				{ type: "response.completed", response: { usage: {} } },
			]);
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl,
			retryBaseDelayMs: 1,
		});
		const events = [];
		for await (const event of client.runMessage({
			content: "recover from overload",
			model_name: "gpt-test",
		})) {
			events.push(event);
		}

		expect(responseCount).toBe(2);
		expect(events.some((event) => event.kind === "failed")).toBe(false);
		expect(events.at(-1)).toEqual({
			kind: "completed",
			finalText: "recovered",
		});
	});

	it("retries a stream disconnect before response output", async () => {
		let responseCount = 0;
		const fetchImpl = (async (
			_input: Parameters<typeof fetch>[0],
			_init?: Parameters<typeof fetch>[1],
		) => {
			responseCount++;
			if (responseCount === 1) {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.error(
								new Error("The socket connection was closed unexpectedly."),
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return eventStream([
				{ type: "response.output_text.delta", delta: "reconnected" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "reconnected" }],
					},
				},
				{ type: "response.completed", response: { usage: {} } },
			]);
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl,
			retryBaseDelayMs: 1,
		});
		const events = [];
		for await (const event of client.runMessage({
			content: "recover from a disconnect",
			model_name: "gpt-test",
		})) {
			events.push(event);
		}

		expect(responseCount).toBe(2);
		expect(events.some((event) => event.kind === "failed")).toBe(false);
		expect(events.at(-1)).toEqual({
			kind: "completed",
			finalText: "reconnected",
		});
	});
});
