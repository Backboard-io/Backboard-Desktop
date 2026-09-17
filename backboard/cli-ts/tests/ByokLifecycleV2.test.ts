/* Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. */
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config/Config.ts";
import { qSessionDir } from "../src/config/paths.ts";
import { createRuntimeThinkingResolver } from "../src/config/thinkingRuntime.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import {
	googleAdapter,
	googleThinkingConfig,
	renderGoogleContents,
} from "../src/providers/byok/adapters/GoogleAdapter.ts";
import { openRouterAdapter } from "../src/providers/byok/adapters/OpenRouterAdapter.ts";
import {
	xaiAdapter,
	xaiInput,
} from "../src/providers/byok/adapters/XaiAdapter.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";
import { ByokConversationStore } from "../src/providers/byok/ByokConversationStore.ts";
import type { ByokStreamRequest } from "../src/providers/byok/ByokTypes.ts";
import {
	CredentialChangedError,
	type ProviderTransport,
} from "../src/providers/byok/ProviderCredential.ts";
import { encodeProviderMetadata } from "../src/providers/byok/ProviderMetadata.ts";

function config(): Config {
	return new Config({
		env: { apiKey: "test", apiUrl: "https://example.test" },
		argv: [],
	});
}
async function collect(
	events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of events) result.push(event);
	return result;
}
function sse(events: object[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
	);
}
const tool = {
	type: "function" as const,
	function: {
		name: "read_file",
		description: "Read",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
};
const request: ByokStreamRequest = {
	model: "grok-4.6",
	systemPrompt: "system",
	messages: [{ role: "user", content: "hello" }],
	tools: [tool],
};

describe("BYOK credential leases", () => {
	it("invalidates remove/re-add even with the same key, but not identical snapshots or unrelated providers", () => {
		const cfg = config();
		const openai = { provider: "openai" as const, key: "sk-review" };
		cfg.setHostProviderKeys([openai]);
		const lease = cfg.providerCredential("openai");
		if (!lease || typeof lease === "string") throw new Error("missing lease");
		cfg.setHostProviderKeys([openai, { provider: "xai", key: "xai-review" }]);
		lease.assertCurrent();
		cfg.setHostProviderKeys([openai]);
		lease.assertCurrent();
		cfg.setHostProviderKeys([]);
		cfg.setHostProviderKeys([openai]);
		expect(() => lease.assertCurrent()).toThrow(
			"changed before this request was sent",
		);
	});

	it("blocks a prepared request after removal before its first HTTP dispatch", async () => {
		const cfg = config();
		cfg.setHostProviderKeys([{ provider: "openai", key: "sk-review" }]);
		let dispatched = 0;
		const transport = (async () => {
			dispatched++;
			return sse([]);
		}) as ProviderTransport;
		const client = new ByokClient(
			(provider) => cfg.providerCredential(provider),
			undefined,
			undefined,
			transport,
		);
		const stream = client
			.runMessage({
				llm_provider: "openai",
				model_name: "gpt-4.1",
				content: "hello",
			})
			[Symbol.asyncIterator]();
		expect((await stream.next()).value?.kind).toBe("thread");
		cfg.setHostProviderKeys([]);
		const events: ProviderEvent[] = [];
		for (;;) {
			const next = await stream.next();
			if (next.done) break;
			events.push(next.value);
		}
		expect({
			dispatched,
			failure: events.find((event) => event.kind === "failed"),
		}).toEqual({
			dispatched: 0,
			failure: {
				kind: "failed",
				error:
					"The openai API key changed before this request was sent. Submit the request again.",
				retryable: false,
			},
		});
	});

	it("checks the lease after an adapter yields its thinking event", async () => {
		const cfg = config();
		cfg.setHostProviderKeys([{ provider: "xai", key: "xai-review" }]);
		const key = cfg.providerCredential("xai")!;
		let dispatched = 0;
		const stream = xaiAdapter
			.stream(
				{
					...request,
					transport: (async () => {
						dispatched++;
						return sse([]);
					}) as ProviderTransport,
				},
				key,
			)
			[Symbol.asyncIterator]();
		await stream.next();
		cfg.setHostProviderKeys([{ provider: "xai", key: "xai-replaced" }]);
		await expect(stream.next()).rejects.toThrow(
			"changed before this request was sent",
		);
		expect(dispatched).toBe(0);
	});
});

describe("Google desktop adapter", () => {
	it("paginates the catalog, respects limits, and excludes models without the tool protocol", async () => {
		const urls: string[] = [];
		const transport = (async (url: string | URL | Request) => {
			urls.push(String(url));
			return Response.json(
				urls.length === 1
					? {
							nextPageToken: "next page",
							models: [
								{
									name: "models/gemini-2.5-flash",
									supportedGenerationMethods: ["generateContent"],
									inputTokenLimit: 123,
									outputTokenLimit: 45,
								},
							],
						}
					: {
							models: [
								{
									name: "models/gemma-3",
									supportedGenerationMethods: ["generateContent"],
								},
								{
									name: "models/gemini-2.5-flash-preview-tts",
									supportedGenerationMethods: ["generateContent"],
								},
							],
						},
			);
		}) as ProviderTransport;
		const models = await googleAdapter.listModels(
			"AIza-test",
			undefined,
			transport,
		);
		expect({
			names: models.map((model) => model.name),
			limits: [models[0]?.context_limit, models[0]?.max_output_tokens],
			next: urls[1]?.includes("pageToken=next%20page"),
		}).toEqual({ names: ["gemini-2.5-flash"], limits: [123, 45], next: true });
	});

	it("retains text signatures and ordered tool parts only for the originating model", async () => {
		const parts = [
			{ text: "thinking", thought: true, thoughtSignature: "signed-text" },
			{
				functionCall: { id: "call-1", name: "read_file", args: { path: "a" } },
				thoughtSignature: "signed-call",
			},
		];
		const events = await collect(
			googleAdapter.stream(
				{
					...request,
					model: "gemini-3-flash-preview",
					transport: (async () =>
						sse([
							{ candidates: [{ content: { parts }, finishReason: "STOP" }] },
						])) as ProviderTransport,
				},
				"AIza-test",
			),
		);
		const terminal = events.find((event) => event.kind === "requires_action");
		if (terminal?.kind !== "requires_action")
			throw new Error("missing tool response");
		const message = {
			role: "assistant" as const,
			content: "",
			toolCalls: terminal.calls,
			providerMetadata: terminal.providerMetadata,
		};
		expect(renderGoogleContents([message], "gemini-3-flash-preview")).toEqual([
			{ role: "model", parts },
		]);
		expect(
			JSON.stringify(renderGoogleContents([message], "gemini-2.5-flash")),
		).not.toContain("signed-");
	});
});

describe("xAI Responses adapter", () => {
	it("streams parallel tools, preserves reasoning and replays outputs locally", async () => {
		const output = [
			{ type: "reasoning", id: "r", encrypted_content: "opaque" },
			{
				type: "function_call",
				id: "f1",
				call_id: "c1",
				name: "read_file",
				arguments: '{"path":"a"}',
			},
			{
				type: "function_call",
				id: "f2",
				call_id: "c2",
				name: "read_file",
				arguments: '{"path":"b"}',
			},
		];
		let body: Record<string, unknown> = {};
		const transport = (async (
			_url: string | URL | Request,
			options?: RequestInit,
		) => {
			body = JSON.parse(String(options?.body));
			return sse([
				{
					type: "response.output_item.added",
					output_index: 1,
					item: output[1],
				},
				{
					type: "response.completed",
					response: {
						status: "completed",
						output,
						usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
					},
				},
			]);
		}) as ProviderTransport;
		const events = await collect(
			xaiAdapter.stream({ ...request, transport }, "xai-test"),
		);
		const terminal = events.find((event) => event.kind === "requires_action");
		if (terminal?.kind !== "requires_action")
			throw new Error("missing tool response");
		const input = xaiInput(
			[
				{
					role: "assistant",
					content: "",
					toolCalls: terminal.calls,
					providerMetadata: terminal.providerMetadata,
				},
				{
					role: "tool",
					results: [
						{ id: "c1", name: "read_file", output: "a" },
						{ id: "c2", name: "read_file", output: "b" },
					],
				},
			],
			request.model,
		);
		expect({
			store: body.store,
			previous: body.previous_response_id,
			ids: terminal.calls.map((call) => call.id),
			input,
		}).toEqual({
			store: false,
			previous: undefined,
			ids: ["c1", "c2"],
			input: [
				...output,
				{ type: "function_call_output", call_id: "c1", output: "a" },
				{ type: "function_call_output", call_id: "c2", output: "b" },
			],
		});
	});

	it("does not replay encrypted metadata into another model", () => {
		const metadata = encodeProviderMetadata("xai", request.model, [
			{ type: "reasoning", encrypted_content: "secret-state" },
		]);
		expect(
			xaiInput(
				[
					{
						role: "assistant",
						content: "visible",
						toolCalls: [],
						providerMetadata: metadata,
					},
				],
				"grok-4.5",
			),
		).toEqual([
			{
				role: "assistant",
				content: [{ type: "output_text", text: "visible" }],
			},
		]);
	});

	it("passes attachments and cancellation through the native Responses transport", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | null | undefined;
		let seenBody = "";
		const transport: ProviderTransport = async (_url, init) => {
			seenSignal = init?.signal;
			seenBody = String(init?.body);
			controller.abort();
			throw new DOMException("Cancelled", "AbortError");
		};
		await expect(
			collect(
				xaiAdapter.stream(
					{
						...request,
						signal: controller.signal,
						messages: [
							{
								role: "user",
								content: "describe",
								attachments: [
									{
										path: "image.png",
										mediaType: "image/png",
										base64: "aW1hZ2U=",
									},
									{
										path: "note.txt",
										mediaType: "text/plain",
										text: "attached text",
									},
								],
							},
						],
						transport,
					},
					"test-key",
				),
			),
		).rejects.toThrow("Cancelled");
		expect({
			signal: seenSignal === controller.signal,
			image: seenBody.includes("data:image/png;base64,aW1hZ2U="),
			text: seenBody.includes("attached text"),
		}).toEqual({ signal: true, image: true, text: true });
	});

	for (const status of [401, 429]) {
		it(`preserves HTTP ${status} and redacts the credential`, async () => {
			const key = "xai-test-http-12345678901234567890";
			const transport: ProviderTransport = async () =>
				Response.json({ error: { message: `rejected ${key}` } }, { status });
			await expect(
				collect(xaiAdapter.stream({ ...request, transport }, key)),
			).rejects.toMatchObject({
				status,
				message: `xAI request failed (HTTP ${status}): rejected <redacted>`,
			});
		});
	}

	it("does not expose secrets from malformed JSON or accept an incomplete terminal response", async () => {
		const key = "xai-malformed-12345678901234567890";
		const malformed: ProviderTransport = async () =>
			new Response(`data: {"error":${key}}\n\n`);
		try {
			await collect(
				xaiAdapter.stream({ ...request, transport: malformed }, key),
			);
			throw new Error("expected rejection");
		} catch (error) {
			expect(String(error)).not.toContain(key);
		}
		const events = await collect(
			xaiAdapter.stream(
				{
					...request,
					transport: async () => sse([{ type: "response.completed" }]),
				},
				key,
			),
		);
		expect(events.at(-1)).toMatchObject({ kind: "failed", retryable: false });
	});

	it("fails truncated streams and scrubs streamed vendor errors", async () => {
		const key = "xai-test-only-12345678901234567890";
		const events = await collect(
			xaiAdapter.stream(
				{
					...request,
					transport: (async () =>
						sse([
							{ type: "error", error: { message: `bad ${key}` } },
						])) as ProviderTransport,
				},
				key,
			),
		);
		expect(events.find((event) => event.kind === "failed")).toEqual({
			kind: "failed",
			error: "bad <redacted>",
			retryable: false,
		});
		const truncated = await collect(
			xaiAdapter.stream(
				{ ...request, transport: (async () => sse([])) as ProviderTransport },
				key,
			),
		);
		expect(truncated.at(-1)).toMatchObject({ kind: "failed", retryable: true });
	});
});

describe("BYOK durable provider state", () => {
	for (const provider of ["google", "openrouter", "xai"] as const) {
		it(`preserves ${provider} completion metadata and tool state through two reopens`, async () => {
			const directory = await mkdtemp(
				path.join(os.tmpdir(), "byok-v2-reopen-"),
			);
			try {
				const model =
					provider === "google"
						? "gemini-3-flash-preview"
						: provider === "openrouter"
							? "anthropic/claude-sonnet-4.6"
							: "grok-4.6";
				const bodies: Record<string, unknown>[] = [];
				const transport: ProviderTransport = async (_url, init) => {
					if (init?.method === "GET") return Response.json({ data: [] });
					bodies.push(JSON.parse(String(init?.body)));
					const round = bodies.length;
					const toolRound = round === 2;
					if (provider === "google")
						return sse([
							{
								candidates: [
									{
										content: {
											parts: toolRound
												? [
														{
															functionCall: {
																id: "c1",
																name: "read_file",
																args: { path: "a" },
															},
															thoughtSignature: "tool-signature",
														},
													]
												: [
														{
															text: "answer",
															thoughtSignature: "completion-signature",
														},
													],
										},
										finishReason: "STOP",
									},
								],
							},
						]);
					if (provider === "openrouter")
						return sse([
							{
								choices: [
									{
										delta: {
											content: toolRound ? "" : "answer",
											reasoning_details: [
												{
													type: "reasoning.encrypted",
													data: toolRound
														? "tool-signature"
														: "completion-signature",
												},
											],
											...(toolRound
												? {
														tool_calls: [
															{
																index: 0,
																id: "c1",
																type: "function",
																function: {
																	name: "read_file",
																	arguments: '{"path":"a"}',
																},
															},
														],
													}
												: {}),
										},
										finish_reason: toolRound ? "tool_calls" : "stop",
									},
								],
							},
						]);
					return sse([
						{
							type: "response.completed",
							response: {
								status: "completed",
								output: [
									{
										type: "reasoning",
										encrypted_content: toolRound
											? "tool-signature"
											: "completion-signature",
									},
									toolRound
										? {
												type: "function_call",
												call_id: "c1",
												name: "read_file",
												arguments: '{"path":"a"}',
											}
										: {
												type: "message",
												role: "assistant",
												content: [{ type: "output_text", text: "answer" }],
											},
								],
							},
						},
					]);
				};
				const store = new ByokConversationStore(directory);
				const makeClient = () =>
					new ByokClient(
						() => `test-reopen-${provider}`,
						undefined,
						store,
						transport,
					);
				const initial = await collect(
					makeClient().runMessage(
						{
							llm_provider: provider,
							model_name: model,
							content: "hello",
							tools: [tool],
						},
						{
							durableSession: {
								sessionId: "test",
								sessionRoot: qSessionDir(directory, "test"),
							},
						},
					),
				);
				const thread = initial.find((event) => event.kind === "thread");
				if (thread?.kind !== "thread") throw new Error("missing conversation");
				const second = await collect(
					makeClient().runMessage({
						thread_id: thread.threadId,
						llm_provider: provider,
						model_name: model,
						content: "read",
						tools: [tool],
					}),
				);
				expect(second.some((event) => event.kind === "requires_action")).toBe(
					true,
				);
				const third = await collect(
					makeClient().runToolOutputs({
						thread_id: thread.threadId,
						tool_outputs: [{ tool_call_id: "c1", output: "file contents" }],
						tools: [tool],
					}),
				);
				expect({
					completion: JSON.stringify(bodies[1]).includes(
						"completion-signature",
					),
					tool: JSON.stringify(bodies[2]).includes("tool-signature"),
					result: JSON.stringify(bodies[2]).includes("file contents"),
					completed: third.some((event) => event.kind === "completed"),
				}).toEqual({
					completion: true,
					tool: true,
					result: true,
					completed: true,
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
});

describe("BYOK discovery races and capabilities", () => {
	it("does not reuse an OpenRouter catalog after remove/re-add of the same key", async () => {
		const cfg = config();
		const entry = {
			provider: "openrouter" as const,
			key: "test-catalog-generation",
		};
		cfg.setHostProviderKeys([entry]);
		const lease = cfg.providerCredential("openrouter")!;
		let calls = 0;
		const transport: ProviderTransport = async () => {
			calls++;
			return Response.json({ data: [] });
		};
		await openRouterAdapter.listModels(lease, undefined, transport);
		cfg.setHostProviderKeys([]);
		cfg.setHostProviderKeys([entry]);
		await expect(
			openRouterAdapter.listModels(lease, undefined, transport),
		).rejects.toThrow("changed before");
		await openRouterAdapter.listModels(
			cfg.providerCredential("openrouter")!,
			undefined,
			transport,
		);
		expect(calls).toBe(2);
	});

	it("stops Google pagination if the key is replaced while the first page arrives", async () => {
		const cfg = config();
		cfg.setHostProviderKeys([{ provider: "google", key: "old-key" }]);
		let calls = 0;
		const transport: ProviderTransport = async () => {
			calls++;
			cfg.setHostProviderKeys([{ provider: "google", key: "new-key" }]);
			return Response.json({ nextPageToken: "page2", models: [] });
		};
		await expect(
			googleAdapter.listModels(
				cfg.providerCredential("google")!,
				undefined,
				transport,
			),
		).rejects.toThrow("changed before");
		expect(calls).toBe(1);
	});

	it("does not swallow credential changes in optional thinking discovery", async () => {
		await expect(
			createRuntimeThinkingResolver(
				{
					model: { provider: "openrouter", model: "vendor/model" },
					modelSource: "byok",
					thinkingIntent: { kind: "dynamic" },
				},
				{
					getModelThinkingMetadata: async () => {
						throw new CredentialChangedError("openrouter");
					},
				},
			),
		).rejects.toThrow("changed before");
	});

	it("filters xAI language models and advertises only supported controls", async () => {
		const transport: ProviderTransport = async () =>
			Response.json({
				models: [
					{
						id: "grok-4.6",
						aliases: ["grok-4.6-latest"],
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
						context_length: 12345,
					},
					{
						id: "grok-4.20-multi-agent",
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					{
						id: "unknown",
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
					{
						id: "grok-3",
						input_modalities: ["text"],
						output_modalities: ["image"],
					},
				],
			});
		const models = await xaiAdapter.listModels("test", undefined, transport);
		expect(
			models.map((model) => [
				model.name,
				model.context_limit,
				model.supports_vision,
				model.supported_effort_levels,
			]),
		).toEqual([
			["grok-4.6", 12345, true, ["low", "medium", "high"]],
			["grok-4.6-latest", 12345, true, ["low", "medium", "high"]],
		]);
		expect(
			googleThinkingConfig({
				...request,
				model: "gemini-3-pro-preview",
				thinking: { effort: "medium" },
			}),
		).toEqual({ thinkingLevel: "high" });
		expect(
			googleThinkingConfig({
				...request,
				model: "gemini-2.5-flash",
				thinking: { budget_tokens: 100000 },
			}),
		).toEqual({ thinkingBudget: 24576 });
	});
});
