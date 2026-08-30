import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { ProviderStreamConsumer } from "../src/core/agent/ProviderStreamConsumer.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Session } from "../src/core/session/Session.ts";
import { AbortError } from "../src/core/tools/ToolAbort.ts";
import type { EarlyToolSink } from "../src/core/tools/ToolScheduler.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";

function stubAssistant(): AssistantAccumulator {
	return {
		appendDelta: () => {},
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
