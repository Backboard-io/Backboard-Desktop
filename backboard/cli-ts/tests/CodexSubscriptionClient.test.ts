import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { qSessionDir } from "../src/config/paths.ts";
import { SubscriptionConversationStore } from "../src/providers/subscription/SubscriptionConversationStore.ts";
import compactCompletion from "./fixtures/subscription-compact-completion.json";

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

	for (const restart of [false, true]) {
		for (const interruption of ["tools", "continuation", "legacy"] as const) {
			it(`resumes after stopping ${interruption}, restart=${restart}`, async () => {
				const store = new SubscriptionConversationStore(testDir);
				const sessionId = `stop-${interruption}-${restart}`;
				const requests: Array<{ input: Record<string, unknown>[] }> = [];
				const controller = new AbortController();
				const fetchImpl = (async (_url, init) => {
					const body = JSON.parse(String(init?.body));
					requests.push(body);
					if (requests.length === 1) {
						return eventStream([
							...["call-read", "call-write"].map((call_id) => ({
								type: "response.output_item.done",
								item: {
									type: "function_call",
									call_id,
									name: call_id,
									arguments: "{}",
								},
							})),
							{ type: "response.completed", response: {} },
						]);
					}
					if (interruption === "continuation" && requests.length === 2) {
						controller.abort();
						throw controller.signal.reason;
					}
					// Mirror the endpoint's requirement before accepting the resumed turn.
					const pending = new Set<string>();
					for (const item of body.input) {
						if (item.role === "user" && pending.size) {
							return new Response("No tool output found for function call", {
								status: 400,
							});
						}
						if (item.type === "function_call") pending.add(item.call_id);
						if (item.type === "function_call_output")
							pending.delete(item.call_id);
					}
					return eventStream([{ type: "response.completed", response: {} }]);
				}) as typeof fetch;
				let client = new CodexSubscriptionClient({
					authFile,
					fetchImpl,
					conversationStore: store,
				});
				let threadId = "";
				for await (const event of client.runMessage(
					{ content: "do work", model_name: "gpt-test", memory: "off" },
					{
						durableSession: {
							sessionId,
							sessionRoot: qSessionDir(testDir, sessionId),
						},
					},
				)) {
					if (event.kind === "thread") threadId = event.threadId;
				}
				const tool_outputs = [
					{ tool_call_id: "call-read", output: "actual file contents" },
					{
						tool_call_id: "call-write",
						output:
							interruption === "tools"
								? "Error: Tool execution was interrupted."
								: "change saved",
					},
				];
				if (interruption === "continuation") {
					await expect(
						(async () => {
							for await (const _event of client.runToolOutputs(
								{ thread_id: threadId, tool_outputs },
								{ signal: controller.signal },
							)) {
								/* consume */
							}
						})(),
					).rejects.toMatchObject({ name: "AbortError" });
				}
				if (interruption !== "legacy") {
					expect(
						await client.preserveFailedToolOutputs({
							thread_id: threadId,
							tool_outputs,
						}),
					).toBeNull();
					// Recovery callbacks must be safe to repeat without duplicating results.
					await client.preserveFailedToolOutputs({
						thread_id: threadId,
						tool_outputs,
					});
				}
				if (restart)
					client = new CodexSubscriptionClient({
						authFile,
						fetchImpl,
						conversationStore: store,
					});
				const resumed = await client.sendMessage({
					thread_id: threadId,
					content: "resume",
					model_name: "gpt-test",
				});
				expect(resumed.status).toBe("COMPLETED");
				const input = requests.at(-1)!.input;
				const results = input.filter(
					(item) => item.type === "function_call_output",
				);
				expect(results.map((item) => item.call_id)).toEqual([
					"call-read",
					"call-write",
				]);
				if (interruption === "legacy") {
					expect(
						results.every((item) =>
							String(item.output).includes("outcome is unknown"),
						),
					).toBe(true);
				} else {
					expect(results.map((item) => item.output)).toEqual(
						tool_outputs.map((item) => item.output),
					);
				}
				expect((await store.get(threadId))?.input).toEqual(input);
			});
		}
	}

	it("reports measured window occupancy and the cache split in usage events", async () => {
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				eventStream([
					{
						type: "response.completed",
						response: {
							model: "gpt-5.6-sol",
							usage: {
								input_tokens: 100,
								input_tokens_details: { cached_tokens: 80 },
								output_tokens: 20,
								total_tokens: 120,
							},
						},
					},
				])) as unknown as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "hello",
			model_name: "gpt-5.6-sol",
		})) {
			events.push(event);
		}
		const usage = events.find((event) => event.kind === "usage")?.usage;
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cachedTokens: 80,
			// Occupancy matches the level Backboard reports: prompt + output.
			contextTokens: 120,
			provider: "openai-subscription",
			model: "gpt-5.6-sol",
		});
	});

	it("preserves default subscription context windows rather than optional maximums", async () => {
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				Response.json({
					models: [
						{
							slug: "gpt-test",
							context_window: 272000,
							max_context_window: 872000,
						},
						{ slug: "unknown", context_window: -1 },
					],
				})) as unknown as typeof fetch,
		});
		const catalog = await client.listModels();
		expect(
			catalog.models.map((model) => [model.name, model.context_limit]),
		).toEqual([
			["gpt-test", 272000],
			["unknown", undefined],
		]);
	});

	it("preserves oversized instructions without duplicating them on later turns", async () => {
		const limit = 1_048_576;
		for (const prompt of [
			"",
			"x".repeat(limit),
			"x".repeat(limit + 1),
			"x".repeat(2_524_124),
			"x".repeat(2_524_125),
			`${"x".repeat(limit - 1)}😀${"y".repeat(limit)}😀tail`,
		]) {
			const bodies: {
				instructions: string;
				input: { role: string; content: { text: string }[] }[];
			}[] = [];
			const client = new CodexSubscriptionClient({
				authFile,
				fetchImpl: (async (_url, init) => {
					bodies.push(JSON.parse(String(init?.body)));
					return eventStream([
						{ type: "response.completed", response: { usage: {} } },
					]);
				}) as typeof fetch,
			});
			const first = await client.sendMessage({
				content: "first",
				model_name: "gpt-test",
				system_prompt: prompt,
			});
			await client.sendMessage({
				thread_id: first.thread_id,
				content: "second",
				model_name: "gpt-test",
			});
			for (const body of bodies) {
				const parts = [
					body.instructions,
					...body.input
						.filter((item) => item.role === "system")
						.flatMap((item) => item.content.map((part) => part.text)),
				];
				expect(parts.join("")).toBe(prompt);
				expect(
					parts.every((part) => part.length <= limit && part.isWellFormed()),
				).toBe(true);
				expect(body.input.findIndex((item) => item.role === "user")).toBe(
					parts.length - 1,
				);
			}
			await client.sendMessage({
				thread_id: first.thread_id,
				content: "third",
				model_name: "gpt-test",
				system_prompt: "Updated instructions",
			});
			expect(bodies[2]?.instructions).toBe("Updated instructions");
			expect(bodies[2]?.input.map((item) => item.role)).toEqual([
				"user",
				"user",
				"user",
			]);
		}
	});

	it("rejects malformed JSON instead of executing an empty argument object", async () => {
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				eventStream([
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "invalid",
							name: "read",
							arguments: "{",
						},
					},
					{ type: "response.completed", response: { usage: {} } },
				])) as unknown as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		await expect(
			(async () => {
				for await (const event of client.runMessage({
					content: "fixture",
					model_name: "gpt-test",
				}))
					events.push(event);
			})(),
		).rejects.toThrow("not valid JSON");
		expect(events.some((event) => event.kind === "tool_ready")).toBe(false);
	});

	it("deduplicates repeated done items and preserves final authoritative output", async () => {
		const item = {
			type: "function_call",
			call_id: "once",
			name: "read",
			arguments: '{"file_path":"fixture.ts"}',
		};
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				eventStream([
					{ type: "response.output_item.done", item },
					{ type: "response.output_item.done", item },
					{
						type: "response.completed",
						response: { output: [item], usage: {} },
					},
				])) as unknown as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "fixture",
			model_name: "gpt-test",
		}))
			events.push(event);
		expect(events.filter((event) => event.kind === "tool_ready")).toHaveLength(
			1,
		);
		expect(events.at(-1)).toMatchObject({
			kind: "requires_action",
			calls: [{ id: "once", name: "read", input: { file_path: "fixture.ts" } }],
		});
	});

	it("rejects ready/final name or argument disagreement before persistence", async () => {
		for (const changed of [
			{ name: "write" },
			{ arguments: '{"file_path":"changed.ts"}' },
		]) {
			const item = {
				type: "function_call",
				call_id: "same",
				name: "read",
				arguments: '{"file_path":"fixture.ts"}',
			};
			const client = new CodexSubscriptionClient({
				authFile,
				fetchImpl: (async () =>
					eventStream([
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: { output: [{ ...item, ...changed }], usage: {} },
						},
					])) as unknown as typeof fetch,
			});
			await expect(
				(async () => {
					for await (const _event of client.runMessage({
						content: "fixture",
						model_name: "gpt-test",
					})) {
						/* consume */
					}
				})(),
			).rejects.toThrow("disagrees");
		}
	});

	it("retains validated done items in compact terminal summaries and submits each output once", async () => {
		const requests: Record<string, unknown>[] = [];
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return eventStream(
					requests.length === 1
						? compactCompletion
						: [{ type: "response.completed", response: { output: [] } }],
				);
			}) as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "fixture",
			model_name: "gpt-test",
		})) {
			events.push(event);
			if (event.kind === "tool_ready") event.call.name = "consumer-mutation";
		}
		expect(events.filter((event) => event.kind === "tool_ready")).toHaveLength(
			1,
		);
		expect(events.at(-1)).toMatchObject({
			kind: "requires_action",
			calls: [
				{
					id: "execute-fixture",
					name: "execute",
					input: { command: "printf fixture" },
				},
			],
		});
		expect(
			events.find((event) => event.kind === "provider_diagnostic"),
		).toMatchObject({
			details: { outputShape: "empty", itemCount: 0, completedToolCount: 1 },
		});
		const thread = events.find((event) => event.kind === "thread");
		if (!thread) throw new Error("Missing thread");
		for await (const _event of client.runToolOutputs({
			thread_id: thread.threadId,
			tool_outputs: [{ tool_call_id: "execute-fixture", output: "fixture" }],
		})) {
			/* consume */
		}
		const continuation = requests[1]?.input as Record<string, unknown>[];
		expect(continuation.filter((item) => item.type !== "message")).toEqual([
			compactCompletion[0]!.item!,
			compactCompletion[1]!.item!,
			{
				type: "function_call_output",
				call_id: "execute-fixture",
				output: "fixture",
			},
		]);
	});

	it("never promotes unfinished call fragments from an empty terminal summary", async () => {
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				eventStream([
					{
						type: "response.output_item.added",
						item: {
							type: "function_call",
							call_id: "unfinished",
							name: "execute",
							arguments: "",
						},
					},
					{
						type: "response.function_call_arguments.delta",
						call_id: "unfinished",
						delta: "{",
					},
					{ type: "response.completed", response: { output: [] } },
				])) as unknown as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "fixture",
			model_name: "gpt-test",
		}))
			events.push(event);
		expect(
			events.some(
				(event) =>
					event.kind === "tool_ready" || event.kind === "requires_action",
			),
		).toBe(false);
		expect(events.at(-1)).toEqual({ kind: "completed", finalText: "" });
	});

	it("rolls back a cancelled done item before accepting a compact completion", async () => {
		const controller = new AbortController();
		const requests: Record<string, unknown>[] = [];
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return eventStream(
					requests.length === 1
						? compactCompletion
						: [{ type: "response.completed", response: {} }],
				);
			}) as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		await expect(
			(async () => {
				for await (const event of client.runMessage(
					{ content: "fixture", model_name: "gpt-test" },
					{ signal: controller.signal },
				)) {
					events.push(event);
					if (event.kind === "tool_ready") controller.abort();
				}
			})(),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(events.some((event) => event.kind === "requires_action")).toBe(
			false,
		);
		const thread = events.find((event) => event.kind === "thread");
		if (!thread) throw new Error("Missing thread");
		for await (const _event of client.runMessage({
			thread_id: thread.threadId,
			content: "retry",
			model_name: "gpt-test",
		})) {
			/* consume */
		}
		expect(JSON.stringify(requests[1]?.input)).not.toContain("execute-fixture");
	});

	it("records fixed completion shape counts without copying unknown type names or payloads", async () => {
		for (const [response, expected] of [
			[{}, { outputShape: "absent", itemCount: null }],
			[{ output: [] }, { outputShape: "empty", itemCount: 0 }],
			[
				{
					output: [
						{ type: "message", content: "private-text" },
						{ type: "reasoning", encrypted_content: "private-content" },
						{ type: "private-type" },
					],
				},
				{
					outputShape: "nonempty",
					itemCount: 3,
					itemTypes: {
						function_call: 0,
						reasoning: 1,
						message: 1,
						other: 1,
						invalid: 0,
					},
				},
			],
		] as const) {
			const client = new CodexSubscriptionClient({
				authFile,
				fetchImpl: (async () =>
					eventStream([
						{ type: "response.completed", response },
					])) as unknown as typeof fetch,
			});
			const events: ProviderEvent[] = [];
			for await (const event of client.runMessage({
				content: "fixture",
				model_name: "gpt-test",
			}))
				events.push(event);
			const diagnostic = events.find(
				(event) => event.kind === "provider_diagnostic",
			);
			expect(diagnostic).toMatchObject({ details: expected });
			expect(JSON.stringify(diagnostic)).not.toContain("private-");
		}
	});

	it("rejects malformed final output while preserving bounded shape evidence", async () => {
		for (const output of [null, "private-invalid-output", [null]]) {
			const client = new CodexSubscriptionClient({
				authFile,
				fetchImpl: (async () =>
					eventStream([
						{ type: "response.completed", response: { output } },
					])) as unknown as typeof fetch,
			});
			const events: ProviderEvent[] = [];
			await expect(
				(async () => {
					for await (const event of client.runMessage({
						content: "fixture",
						model_name: "gpt-test",
					}))
						events.push(event);
				})(),
			).rejects.toThrow("malformed completed output list");
			expect(
				events.find((event) => event.kind === "provider_diagnostic"),
			).toMatchObject({
				details: {
					outputShape: Array.isArray(output) ? "nonempty" : "invalid",
				},
			});
			expect(JSON.stringify(events)).not.toContain("private-invalid-output");
		}
	});

	it("accepts canonical aliases and reordered arguments without sharing ready inputs", async () => {
		const item = {
			type: "function_call",
			call_id: "stable",
			name: "Glob",
			arguments: JSON.stringify({ patterns: ["**/*.ts"], path: "." }),
		};
		const final = {
			...item,
			name: "glob",
			arguments: JSON.stringify({ path: ".", patterns: ["**/*.ts"] }),
		};
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async () =>
				eventStream([
					{ type: "response.output_item.done", item },
					{ type: "response.completed", response: { output: [final] } },
				])) as unknown as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "fixture",
			model_name: "gpt-test",
		})) {
			if (event.kind === "tool_ready") {
				// Downstream consumers must not mutate the adapter's identity snapshot.
				event.call.name = "consumer-change";
				(event.call.input as { patterns: string[] }).patterns.push(
					"consumer-change",
				);
			}
			events.push(event);
		}
		expect(events.at(-1)).toMatchObject({
			kind: "requires_action",
			calls: [
				{
					id: "stable",
					name: "glob",
					input: { path: ".", patterns: ["**/*.ts"] },
				},
			],
		});
	});

	it("diagnoses missing final calls without recording private arguments and rolls back failed items", async () => {
		const item = {
			type: "function_call",
			call_id: "rejected",
			name: "glob",
			arguments: JSON.stringify({ patterns: ["private-fixture-path/**"] }),
		};
		const requests: Record<string, unknown>[] = [];
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return eventStream(
					requests.length === 1
						? [
								{ type: "response.output_item.done", item },
								{
									type: "response.completed",
									response: {
										output: [
											{
												type: "message",
												id: "unrelated-final-item",
												content: [],
											},
										],
									},
								},
							]
						: [{ type: "response.completed", response: { output: [] } }],
				);
			}) as typeof fetch,
		});
		const events: ProviderEvent[] = [];
		const request = {
			content: "fixture",
			model_name: "gpt-test",
		};
		await expect(
			(async () => {
				for await (const event of client.runMessage(request))
					events.push(event);
			})(),
		).rejects.toMatchObject({
			category: "protocol",
			safeToRetryBeforeTools: true,
		});
		const warning = events.find((event) => event.kind === "warning");
		expect(JSON.stringify(warning)).toContain("missing_call");
		expect(JSON.stringify(warning)).not.toContain("private-fixture-path");
		const thread = events.find((event) => event.kind === "thread");
		if (!thread || thread.kind !== "thread") throw new Error("Missing thread");
		for await (const _event of client.runMessage({
			...request,
			thread_id: thread.threadId,
		})) {
			/* consume retry */
		}
		expect(JSON.stringify(requests[1]?.input)).not.toContain("rejected");
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

	it("generates images with the hosted tool and replays a note instead of the bytes", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const result = Buffer.from("png-bytes").toString("base64");
		const imageCall = {
			type: "image_generation_call",
			id: "ig_1",
			status: "completed",
			output_format: "png",
			revised_prompt: "A yellow star",
			result,
		};
		const fetchImpl = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestBodies.push(JSON.parse(String(init?.body)));
			if (requestBodies.length > 1) {
				return eventStream([{ type: "response.completed", response: {} }]);
			}
			return eventStream([
				{
					type: "response.output_item.added",
					item: {
						type: "image_generation_call",
						id: "ig_1",
						status: "in_progress",
					},
				},
				{ type: "response.output_item.done", item: imageCall },
				{ type: "response.output_text.delta", delta: "Here it is." },
				{
					type: "response.completed",
					response: {
						output: [
							imageCall,
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "Here it is." }],
							},
						],
					},
				},
			]);
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({ authFile, fetchImpl });

		const events: ProviderEvent[] = [];
		for await (const event of client.runMessage({
			content: "draw a star",
			model_name: "gpt-test",
		})) {
			events.push(event);
		}
		const thread = events.find((event) => event.kind === "thread");
		await client.sendMessage({
			thread_id: thread?.kind === "thread" ? thread.threadId : "",
			content: "what colour was it?",
			model_name: "gpt-test",
		});

		expect(
			events.filter(
				(event) => event.kind === "tool_started" || event.kind === "media",
			),
		).toEqual([
			{ kind: "tool_started", id: "ig_1", name: "generate_image" },
			{
				kind: "media",
				payload: {
					url: `data:image/png;base64,${result}`,
					media_type: "image",
					prompt: "A yellow star",
				},
			},
		]);
		expect(requestBodies[0]?.tools).toEqual([
			{ type: "image_generation", output_format: "png" },
		]);
		expect(JSON.stringify(requestBodies[1]?.input)).not.toContain(result);
		expect(requestBodies[1]?.input).toContainEqual({
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "[Generated image: A yellow star. It was shown to the user and saved in the project's generated-images/ folder.]",
				},
			],
		});
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
		const events: ProviderEvent[] = [];
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
		const events: ProviderEvent[] = [];
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
