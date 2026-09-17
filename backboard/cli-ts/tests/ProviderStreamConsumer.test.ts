import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { ProviderStreamConsumer } from "../src/core/agent/ProviderStreamConsumer.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Session } from "../src/core/session/Session.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import { AbortError } from "../src/core/tools/ToolAbort.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok } from "../src/core/tools/ToolResult.ts";
import {
	type EarlyToolSink,
	ToolScheduler,
} from "../src/core/tools/ToolScheduler.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { RetryableToolProtocolError } from "../src/providers/ToolProtocolError.ts";

function stubAssistant(): AssistantAccumulator {
	return {
		appendDelta: () => {},
		appendReasoning: () => {},
		flushAnswer: () => {},
		flushReasoning: () => {},
		finalize: () => {},
		discardPartial: () => {},
	} as unknown as AssistantAccumulator;
}

class RecordingSink implements EarlyToolSink {
	announced: string[] = [];
	resets = 0;
	announce(id: string): void {
		this.announced.push(id);
	}
	offer(): void {}
	reset(): void {
		this.resets++;
	}
}

async function* streamOf(
	events: ProviderEvent[],
): AsyncIterable<ProviderEvent> {
	for (const event of events) yield event;
}

describe("ProviderStreamConsumer", () => {
	it("logs structural provider diagnostics without treating them as visible or first provider output", async () => {
		const bus = new EventBus();
		const phases: string[] = [];
		const diagnostics: unknown[] = [];
		const warnings: unknown[] = [];
		bus.on("performance:timing", (event) => phases.push(event.phase));
		bus.on("provider:diagnostic", (event) => diagnostics.push(event));
		bus.on("system:warning", (event) => warnings.push(event));
		const consumer = new ProviderStreamConsumer(bus, new Session("fixture"));
		const details = {
			outputShape: "empty",
			itemCount: 0,
			completedToolCount: 1,
		};
		await consumer.consumeWithRetry(
			() =>
				(async function* (): AsyncIterable<ProviderEvent> {
					yield {
						kind: "provider_diagnostic",
						provider: "openai-subscription",
						phase: "completed",
						details,
					};
					expect(phases).toEqual([]);
					yield { kind: "completed", finalText: "" };
				})(),
			stubAssistant(),
			new AbortController().signal,
		);
		expect({ diagnostics, warnings, phases }).toEqual({
			diagnostics: [
				{
					type: "provider:diagnostic",
					provider: "openai-subscription",
					phase: "completed",
					details,
				},
			],
			warnings: [],
			phases: ["provider_first_event", "provider_stream_total"],
		});
	});

	it("retries a safe pre-final protocol failure once after aborting reads and discarding partial text", async () => {
		const bus = new EventBus();
		const session = new Session("fixture");
		const assistant = new AssistantAccumulator("turn", bus, session);
		const warnings: string[] = [];
		const discarded: string[] = [];
		const outputs: string[] = [];
		const retracted: string[] = [];
		bus.on("system:warning", (event) => warnings.push(event.message));
		bus.on("assistant:message:discard", (event) =>
			discarded.push(event.messageId),
		);
		bus.on("tool:result", (event) => outputs.push(event.toolCallId));
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		let markReadStarted!: () => void;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		let readSignal: AbortSignal | undefined;
		class PendingRead extends Tool {
			readonly name = "PendingRead";
			readonly inputSchema = z.object({});
			async execute(_input: unknown, ctx: ToolContext) {
				readSignal = ctx.signal;
				markReadStarted();
				await new Promise<void>((resolve) =>
					ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return ok({}, "stale read must not be submitted", "Stale read");
			}
		}
		const context: ToolContext = {
			sessionId: "fixture",
			turnId: "turn",
			cwd: process.cwd(),
			bus,
			signal: new AbortController().signal,
			askUser: async () => "noop",
		};
		const round = new ToolScheduler(
			new ToolRegistry([new PendingRead()]),
			bus,
		).createRound(context);
		let attempts = 0;
		let retrySetupCalls = 0;
		const consumer = new ProviderStreamConsumer(bus, session, {
			maxRetries: 0,
		});
		const result = await consumer.consumeWithRetry(
			() => {
				attempts++;
				if (attempts > 1) {
					expect(readSignal?.aborted).toBe(true);
					return streamOf([
						{ kind: "completed", finalText: "Recovered answer" },
					]);
				}
				return (async function* (): AsyncIterable<ProviderEvent> {
					yield { kind: "assistant_delta", text: "Discarded partial answer" };
					yield {
						kind: "tool_ready",
						call: { id: "stale", name: "PendingRead", input: {} },
					};
					await readStarted;
					throw new RetryableToolProtocolError("fixture name disagreement");
				})();
			},
			assistant,
			context.signal,
			round,
			undefined,
			() => {
				retrySetupCalls++;
			},
		);
		round.reset();
		expect(result).toBeNull();
		expect(attempts).toBe(2);
		expect(retrySetupCalls).toBe(0);
		expect(discarded).toEqual(["turn:assistant:0"]);
		expect(retracted).toEqual(["stale"]);
		expect(outputs).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Retrying inconsistent tool response once");
		expect(warnings[0]).not.toContain("fixture name disagreement");
		expect(
			session
				.getMessages()
				.map((message) => ("text" in message ? message.text : undefined)),
		).toEqual(["Recovered answer"]);
	});

	it("caps safe protocol recovery at two attempts despite a larger general retry budget", async () => {
		let attempts = 0;
		let discards = 0;
		const sink = new RecordingSink();
		const assistant = stubAssistant();
		assistant.discardPartial = () => {
			discards++;
		};
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("fixture"),
			{ maxRetries: 50 },
		);
		await expect(
			consumer.consumeWithRetry(
				() =>
					(async function* (): AsyncIterable<ProviderEvent> {
						attempts++;
						yield { kind: "assistant_delta", text: "partial" };
						throw new RetryableToolProtocolError(
							"repeated fixture disagreement",
						);
					})(),
				assistant,
				new AbortController().signal,
				sink,
			),
		).rejects.toBeInstanceOf(RetryableToolProtocolError);
		expect({ attempts, discards, resets: sink.resets }).toEqual({
			attempts: 2,
			discards: 2,
			resets: 2,
		});
	});

	it("does not create a replay request when cancellation arrives during protocol recovery", async () => {
		const bus = new EventBus();
		const controller = new AbortController();
		bus.on("system:warning", () => controller.abort());
		let attempts = 0;
		const sink = new RecordingSink();
		const consumer = new ProviderStreamConsumer(bus, new Session("fixture"));
		await expect(
			consumer.consumeWithRetry(
				() =>
					(async function* (): AsyncIterable<ProviderEvent> {
						attempts++;
						yield { kind: "tool_started", id: "stale", name: "Read" };
						throw new RetryableToolProtocolError("fixture disagreement");
					})(),
				stubAssistant(),
				controller.signal,
				sink,
			),
		).rejects.toBeInstanceOf(AbortError);
		expect(attempts).toBe(1);
		expect(sink.resets).toBe(1);
	});

	it("does not retry arbitrary protocol errors or explicit non-retryable failures", async () => {
		for (const error of [
			Object.assign(new Error("remote protocol error"), {
				category: "protocol",
				retryable: true,
				safeToRetryBeforeTools: true,
			}),
			undefined,
		]) {
			let attempts = 0;
			const consumer = new ProviderStreamConsumer(
				new EventBus(),
				new Session("fixture"),
				{ maxRetries: 5 },
			);
			await expect(
				consumer.consumeWithRetry(
					() =>
						(async function* (): AsyncIterable<ProviderEvent> {
							attempts++;
							if (error) throw error;
							yield {
								kind: "failed",
								error: "remote protocol error",
								retryable: false,
							};
						})(),
					stubAssistant(),
					new AbortController().signal,
				),
			).rejects.toThrow("remote protocol error");
			expect(attempts).toBe(1);
		}
	});

	it("replays the subscription adapter with unchanged input after ready/completed disagreement", async () => {
		const dir = await mkdtemp(join(tmpdir(), "consumer-subscription-retry-"));
		try {
			const authFile = join(dir, "auth.json");
			await writeFile(
				authFile,
				JSON.stringify({
					tokens: {
						access_token: "offline-test-token",
						account_id: "offline-test-account",
					},
				}),
			);
			const requests: Record<string, unknown>[] = [];
			const item = {
				type: "function_call",
				call_id: "fixture",
				name: "read",
				arguments: '{"file_path":"fixture.ts"}',
			};
			const client = new CodexSubscriptionClient({
				authFile,
				fetchImpl: (async (_url, init) => {
					requests.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>,
					);
					const events = [
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: {
								output: [
									{
										...item,
										...(requests.length === 1 ? { name: "write" } : {}),
									},
								],
								usage: {},
							},
						},
					];
					return new Response(
						events
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}) as typeof fetch,
			});
			const consumer = new ProviderStreamConsumer(
				new EventBus(),
				new Session("fixture"),
				{ maxRetries: 0 },
			);
			const result = await consumer.consumeWithRetry(
				(signal) =>
					client.runMessage(
						{
							content: "offline replay fixture",
							model_name: "gpt-test",
							thinking: { effort: "medium" },
						},
						{ signal },
					),
				stubAssistant(),
				new AbortController().signal,
				new RecordingSink(),
			);
			expect(requests).toHaveLength(2);
			expect(requests[1]?.input).toEqual(requests[0]?.input);
			expect(requests[1]?.reasoning).toEqual(requests[0]?.reasoning);
			expect(result?.calls).toEqual([
				{ id: "fixture", name: "read", input: { file_path: "fixture.ts" } },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects name disagreement before assistant call persistence and does not retry", async () => {
		const sink = new RecordingSink();
		let attempts = 0;
		let finalized = false;
		const assistant = stubAssistant();
		assistant.finalize = () => {
			finalized = true;
		};
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("fixture"),
		);
		await expect(
			consumer.consumeWithRetry(
				() => {
					attempts++;
					return streamOf([
						{
							kind: "tool_ready",
							call: { id: "same", name: "glob", input: {} },
						},
						{
							kind: "requires_action",
							runId: null,
							calls: [{ id: "same", name: "grep", input: {} }],
						},
					]);
				},
				assistant,
				new AbortController().signal,
				sink,
			),
		).rejects.toThrow("Tool protocol error");
		expect({ attempts, finalized, resets: sink.resets }).toEqual({
			attempts: 1,
			finalized: false,
			resets: 1,
		});
	});

	it("records provider tool-batch finalization timing", async () => {
		const bus = new EventBus();
		const timings = new Map<string, number[]>();
		bus.on("performance:timing", (event) => {
			const recorded = timings.get(event.phase) ?? [];
			recorded.push(event.durationMs);
			timings.set(event.phase, recorded);
		});
		const consumer = new ProviderStreamConsumer(bus, new Session("sess_test"));
		const result = await consumer.consumeWithRetry(
			() =>
				streamOf([
					{ kind: "tool_started", id: "call_1", name: "Read" },
					{
						kind: "requires_action",
						runId: "run_1",
						calls: [{ id: "call_1", name: "Read", input: {} }],
					},
				]),
			stubAssistant(),
			new AbortController().signal,
		);

		expect(result?.calls.map((call) => call.id)).toEqual(["call_1"]);
		expect(timings.get("provider_tool_announcement")).toHaveLength(1);
		expect(timings.get("provider_tool_batch_finalize")).toHaveLength(1);
		expect(
			timings.get("provider_tool_announcement")?.[0],
		).toBeGreaterThanOrEqual(0);
		expect(
			timings.get("provider_tool_batch_finalize")?.[0],
		).toBeGreaterThanOrEqual(0);
	});

	it("measures the whole silent wait when no advisory tool start arrives", async () => {
		const bus = new EventBus();
		const phases: string[] = [];
		bus.on("performance:timing", (event) => phases.push(event.phase));
		const consumer = new ProviderStreamConsumer(bus, new Session("sess_test"));

		await consumer.consumeWithRetry(
			() =>
				streamOf([
					{
						kind: "requires_action",
						runId: "run_1",
						calls: [{ id: "call_1", name: "Write", input: {} }],
					},
				]),
			stubAssistant(),
			new AbortController().signal,
		);

		expect(phases).toEqual([
			"provider_first_event",
			"provider_tool_announcement",
			"provider_tool_batch_finalize",
			"provider_stream_total",
		]);
	});

	it("resets the early round on a terminal (non-retryable) stream failure", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let preserved = 0;
		await expect(
			consumer.consumeWithRetry(
				() =>
					streamOf([
						{ kind: "tool_started", id: "call_1", name: "Read" },
						{ kind: "failed", error: "boom", retryable: false },
					]),
				stubAssistant(),
				new AbortController().signal,
				sink,
				async () => {
					preserved++;
					return null;
				},
			),
		).rejects.toThrow("boom");
		// Without this reset the announced row would strand as pending: the
		// caller never reaches process(), whose finally is the usual cleanup.
		expect(sink.announced).toEqual(["call_1"]);
		expect(sink.resets).toBe(1);
		expect(preserved).toBe(1);
	});

	it("resets the early round when the stream aborts", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		const abort = new AbortController();
		async function* abortingStream(): AsyncIterable<ProviderEvent> {
			yield { kind: "tool_started", id: "call_1", name: "Read" };
			abort.abort();
			throw new AbortError();
		}
		await expect(
			consumer.consumeWithRetry(
				() => abortingStream(),
				stubAssistant(),
				abort.signal,
				sink,
			),
		).rejects.toThrow();
		expect(sink.resets).toBe(1);
	});

	it("resets between retries and not terminally on eventual success", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let attempt = 0;
		const result = await consumer.consumeWithRetry(
			() => {
				attempt++;
				return attempt === 1
					? streamOf([{ kind: "failed", error: "hiccup", retryable: true }])
					: streamOf([{ kind: "completed", finalText: "ok" }]);
			},
			stubAssistant(),
			new AbortController().signal,
			sink,
		);
		expect(result).toBeNull();
		expect(sink.resets).toBe(1);
	});

	it("retries a stream that closes without a terminal event", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let attempt = 0;
		const result = await consumer.consumeWithRetry(
			() => {
				attempt++;
				return attempt === 1
					? streamOf([{ kind: "assistant_delta", text: "partial" }])
					: streamOf([{ kind: "completed", finalText: "complete" }]);
			},
			stubAssistant(),
			new AbortController().signal,
			sink,
		);

		expect(result).toBeNull();
		expect(attempt).toBe(2);
		expect(sink.resets).toBe(1);
	});

	it("aborts and retries a provider attempt that stops emitting events", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ idleTimeoutMs: 5, maxRetries: 1 },
		);
		let attempts = 0;
		let abortedAttempts = 0;
		const result = await consumer.consumeWithRetry(
			(signal) => {
				attempts++;
				if (attempts > 1) {
					return streamOf([{ kind: "completed", finalText: "recovered" }]);
				}
				return (async function* () {
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								abortedAttempts++;
								resolve();
							},
							{ once: true },
						);
					});
				})();
			},
			stubAssistant(),
			new AbortController().signal,
		);

		expect(result).toBeNull();
		expect({ attempts, abortedAttempts }).toEqual({
			attempts: 2,
			abortedAttempts: 1,
		});
	});

	it("treats non-UI transport activity as watchdog progress", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ idleTimeoutMs: 10, maxRetries: 1 },
		);
		let attempts = 0;
		const result = await consumer.consumeWithRetry(
			() =>
				(async function* () {
					attempts++;
					// Total generation time is several watchdog windows, but every
					// silent tool-argument fragment proves the transport is advancing.
					for (let index = 0; index < 10; index++) {
						await new Promise((resolve) => setTimeout(resolve, 2));
						yield { kind: "activity" } as const;
					}
					yield { kind: "completed", finalText: "complete" } as const;
				})(),
			stubAssistant(),
			new AbortController().signal,
		);

		expect(result).toBeNull();
		expect(attempts).toBe(1);
	});

	it("retries when a stalled iterator ignores both abort and return", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ idleTimeoutMs: 5, maxRetries: 1 },
		);
		let attempts = 0;
		let returnCalls = 0;
		const never = new Promise<IteratorResult<ProviderEvent>>(() => {});
		const result = await consumer.consumeWithRetry(
			() => {
				attempts++;
				if (attempts > 1) {
					return streamOf([{ kind: "completed", finalText: "recovered" }]);
				}
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () => never,
							return: () => {
								returnCalls++;
								return never;
							},
						};
					},
				};
			},
			stubAssistant(),
			new AbortController().signal,
		);

		expect(result).toBeNull();
		expect({ attempts, returnCalls }).toEqual({ attempts: 2, returnCalls: 1 });
	});

	it("retries when stalled iterator cleanup throws synchronously", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ idleTimeoutMs: 5, maxRetries: 1 },
		);
		let attempts = 0;
		const result = await consumer.consumeWithRetry(
			() => {
				attempts++;
				if (attempts > 1) {
					return streamOf([{ kind: "completed", finalText: "recovered" }]);
				}
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}),
							return: () => {
								throw new Error("cleanup failed");
							},
						};
					},
				};
			},
			stubAssistant(),
			new AbortController().signal,
		);

		expect(result).toBeNull();
		expect(attempts).toBe(2);
	});

	it("cancels promptly when a stalled iterator ignores abort", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ idleTimeoutMs: 60_000, maxRetries: 1 },
		);
		const controller = new AbortController();
		let returnCalls = 0;
		const never = new Promise<IteratorResult<ProviderEvent>>(() => {});
		const operation = consumer.consumeWithRetry(
			() => ({
				[Symbol.asyncIterator]() {
					return {
						next: () => never,
						return: () => {
							returnCalls++;
							return never;
						},
					};
				},
			}),
			stubAssistant(),
			controller.signal,
		);
		controller.abort();

		await expect(operation).rejects.toBeInstanceOf(AbortError);
		expect(returnCalls).toBe(1);
	});

	it("does not enter retry backoff when retry setup aborts the turn", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
			{ maxRetries: 1 },
		);
		const controller = new AbortController();
		let attempts = 0;

		await expect(
			consumer.consumeWithRetry(
				() => {
					attempts++;
					return streamOf([
						{ kind: "failed", error: "retry later", retryable: true },
					]);
				},
				stubAssistant(),
				controller.signal,
				undefined,
				undefined,
				() => controller.abort(),
			),
		).rejects.toBeInstanceOf(AbortError);

		expect(attempts).toBe(1);
	});

	it("preserves the failed input when cancellation interrupts retry backoff", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const abort = new AbortController();
		let preserved = 0;
		setTimeout(() => abort.abort(), 10);

		await expect(
			consumer.consumeWithRetry(
				() =>
					streamOf([{ kind: "failed", error: "retry later", retryable: true }]),
				stubAssistant(),
				abort.signal,
				undefined,
				async () => {
					preserved++;
					return null;
				},
			),
		).rejects.toThrow();

		expect(preserved).toBe(1);
	});

	it("saves a generated video into the project's video folder and emits a tool call", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "backboard-videos-"));
		const videoDirectory = join(projectRoot, "generated-videos");
		const videoUrl =
			"https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-video/e147512d-f009-458f-9e87-35b144a12a55.mp4";
		const videoBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18]);
		let finalizedText = "";
		const assistant = {
			appendDelta: () => {},
			appendReasoning: () => {},
			flushAnswer: () => {},
			flushReasoning: () => {},
			finalize: (_calls: unknown[], text?: string) => {
				finalizedText = text ?? "";
			},
			discardPartial: () => {},
		} as unknown as AssistantAccumulator;

		const bus = new EventBus();
		const startedTools: string[] = [];
		const resultDetails = new Map<string, string | undefined>();
		bus.on("tool:start", (event) => startedTools.push(event.name));
		bus.on("tool:result", (event) =>
			resultDetails.set(event.name, event.detail),
		);

		try {
			const consumer = new ProviderStreamConsumer(
				bus,
				new Session("sess_test"),
				{
					videoGeneration: true,
					generatedMediaDir: join(projectRoot, "generated-images"),
					generatedVideoDir: videoDirectory,
					fetch: async () =>
						new Response(videoBytes, {
							headers: { "content-type": "video/mp4" },
						}),
				},
			);
			await consumer.consumeWithRetry(
				() =>
					streamOf([
						{ kind: "assistant_delta", text: "Here's your clip." },
						{
							kind: "media",
							payload: { url: videoUrl, prompt: "a rolling ball" },
						},
						{ kind: "completed", finalText: "Here's your clip." },
					]),
				assistant,
				new AbortController().signal,
			);

			expect(finalizedText).toContain("Saved to `generated-videos/");
			expect(finalizedText).toContain(videoUrl);
			const files = await readdir(videoDirectory);
			expect(files).toHaveLength(1);
			const filename = files[0];
			expect(filename).toMatch(/^generated-[a-f0-9]{12}\.mp4$/);
			if (!filename) throw new Error("generated video was not saved");
			expect(
				(await readFile(join(videoDirectory, filename))).byteLength,
			).toBeGreaterThan(0);

			expect(startedTools).toContain("generate_video");
			expect(resultDetails.get("generate_video")).toContain(videoUrl);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("classifies a clip from media_type when the stored URL has no extension", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "backboard-videos-"));
		const videoDirectory = join(projectRoot, "generated-videos");
		const imageDirectory = join(projectRoot, "generated-images");
		// Document-download URLs carry no extension; only the media metadata
		// identifies the clip.
		const videoUrl =
			"https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-video/e147512d";
		let finalizedText = "";
		const assistant = {
			appendDelta: () => {},
			appendReasoning: () => {},
			flushAnswer: () => {},
			flushReasoning: () => {},
			finalize: (_calls: unknown[], text?: string) => {
				finalizedText = text ?? "";
			},
			discardPartial: () => {},
		} as unknown as AssistantAccumulator;

		const bus = new EventBus();
		const startedTools: string[] = [];
		const resultDetails = new Map<string, string | undefined>();
		bus.on("tool:start", (event) => startedTools.push(event.name));
		bus.on("tool:result", (event) =>
			resultDetails.set(event.name, event.detail),
		);

		try {
			const consumer = new ProviderStreamConsumer(
				bus,
				new Session("sess_test"),
				{
					videoGeneration: true,
					generatedMediaDir: imageDirectory,
					generatedVideoDir: videoDirectory,
					fetch: async () =>
						new Response(Uint8Array.from([0x00, 0x00, 0x00, 0x18]), {
							headers: { "content-type": "video/mp4" },
						}),
				},
			);
			await consumer.consumeWithRetry(
				() =>
					streamOf([
						{
							kind: "media",
							payload: {
								media: {
									url: videoUrl,
									media_type: "video",
									mime_type: "video/mp4",
								},
							},
						},
						{ kind: "completed", finalText: "Done." },
					]),
				assistant,
				new AbortController().signal,
			);

			expect(startedTools).toContain("generate_video");
			expect(resultDetails.get("generate_video")).toContain(
				"![Generated video]",
			);
			expect(await readdir(videoDirectory)).toHaveLength(1);
			expect(finalizedText).toContain("Saved to `generated-videos/");
			expect(await readdir(imageDirectory).catch(() => [])).toHaveLength(0);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("normalizes generated image markup and saves the image in the project", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "backboard-images-"));
		const directory = join(projectRoot, "generated-images");
		const imageUrl = "https://example.test/generated-images/dog-one.jpg";
		const duplicateImageUrl =
			"https://example.test/generated-images/dog-two.jpg";
		const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
		let finalizedText = "";
		const deltas: string[] = [];
		const assistant = {
			appendDelta: (text: string) => deltas.push(text),
			appendReasoning: () => {},
			flushAnswer: () => {},
			flushReasoning: () => {},
			finalize: (_calls: unknown[], text?: string) => {
				finalizedText = text ?? "";
			},
			discardPartial: () => {},
		} as unknown as AssistantAccumulator;

		try {
			const consumer = new ProviderStreamConsumer(
				new EventBus(),
				new Session("sess_test"),
				{
					imageGeneration: true,
					generatedMediaDir: directory,
					fetch: async () =>
						new Response(imageBytes, {
							headers: { "content-type": "image/jpeg" },
						}),
				},
			);
			await consumer.consumeWithRetry(
				() =>
					streamOf([
						{ kind: "assistant_delta", text: "Here's your dog." },
						{ kind: "media", payload: { url: imageUrl, prompt: "dog" } },
						{
							kind: "media",
							payload: { url: duplicateImageUrl, prompt: "dog" },
						},
						{
							kind: "completed",
							finalText: `\\<img src="[${imageUrl}](${imageUrl})" alt="dog">\n\nHere's your dog. [dog](${imageUrl})\n\nHere's your dog.`,
						},
					]),
				assistant,
				new AbortController().signal,
			);

			expect(deltas).toEqual([]);
			expect(finalizedText).not.toContain("<img");
			expect(finalizedText).not.toContain("]()");
			expect(finalizedText.match(/Here's your dog\./g)).toHaveLength(1);
			expect(finalizedText.match(/https:\/\/example\.test/g)).toHaveLength(1);
			expect(finalizedText).toContain("Saved to `generated-images/");
			const files = await readdir(directory);
			expect(files).toHaveLength(1);
			const filename = files[0];
			expect(filename).toMatch(/^generated-[a-f0-9]{12}\.(?:png|jpg)$/);
			if (!filename) throw new Error("generated image was not saved");
			expect(
				(await readFile(join(directory, filename))).byteLength,
			).toBeGreaterThan(0);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("saves a generated image returned only in final markdown", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "backboard-images-"));
		const directory = join(projectRoot, "generated-images");
		const imageUrl =
			"https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-images/mario.png";
		const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
		let finalizedText = "";
		const assistant = {
			appendDelta: () => {},
			appendReasoning: () => {},
			flushAnswer: () => {},
			flushReasoning: () => {},
			finalize: (_calls: unknown[], text?: string) => {
				finalizedText = text ?? "";
			},
			discardPartial: () => {},
		} as unknown as AssistantAccumulator;

		try {
			const consumer = new ProviderStreamConsumer(
				new EventBus(),
				new Session("sess_test"),
				{
					imageGeneration: true,
					generatedMediaDir: directory,
					fetch: async () =>
						new Response(imageBytes, {
							headers: { "content-type": "image/png" },
						}),
				},
			);
			await consumer.consumeWithRetry(
				() =>
					streamOf([
						{
							kind: "completed",
							finalText: `Here's Mario.\n\n![mario](${imageUrl})`,
						},
					]),
				assistant,
				new AbortController().signal,
			);

			expect(finalizedText.match(/!\[mario\]/g)).toHaveLength(1);
			expect(finalizedText).toContain("Saved to `generated-images/");
			const files = await readdir(directory);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^generated-[a-f0-9]{12}\.png$/);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});
});
