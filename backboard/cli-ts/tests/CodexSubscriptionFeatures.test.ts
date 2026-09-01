import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qSessionDir } from "../src/config/paths.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { SubscriptionConversationStore } from "../src/providers/subscription/SubscriptionConversationStore.ts";
import { SubscriptionMemoryStore } from "../src/providers/subscription/SubscriptionMemoryStore.ts";

function eventStream(text: string): Response {
	return new Response(
		[
			{ type: "response.output_text.delta", delta: text },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text }],
				},
			},
			{ type: "response.completed", response: { usage: {} } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("CodexSubscriptionClient features", () => {
	let root: string;
	let authFile: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "subscription-features-"));
		authFile = join(root, "auth.json");
		await writeFile(
			authFile,
			JSON.stringify({
				tokens: { access_token: "test-token", account_id: "test-account" },
			}),
		);
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("sends images and files as native Responses content parts", async () => {
		const image = join(root, "pixel.png");
		const text = join(root, "notes.txt");
		await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		await writeFile(text, "attachment contents");
		let body: Record<string, unknown> | undefined;
		const fetchImpl = (async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return eventStream("seen");
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({ authFile, fetchImpl });

		await collect(
			client.runMessage(
				{ content: "inspect", model_name: "gpt-test", memory: "off" },
				{ attachmentFilePaths: [image, text] },
			),
		);

		const input = body?.input as Array<Record<string, unknown>>;
		const content = input[0]?.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({ type: "input_text", text: "inspect" });
		expect(content[1]?.type).toBe("input_image");
		expect(String(content[1]?.image_url)).toStartWith("data:image/png;base64,");
		expect(content[2]).toMatchObject({
			type: "input_file",
			filename: "notes.txt",
		});
		expect(String(content[2]?.file_data)).toStartWith(
			"data:text/plain;base64,",
		);
	});

	it("reopens an encrypted durable thread and continues its full input", async () => {
		const cwd = join(root, "durable");
		const store = new SubscriptionConversationStore(cwd);
		const requestBodies: Array<Record<string, unknown>> = [];
		const fetchImpl = (async (_input, init) => {
			requestBodies.push(JSON.parse(String(init?.body)));
			return eventStream(
				requestBodies.length === 1 ? "first answer" : "second answer",
			);
		}) as typeof fetch;
		const first = new CodexSubscriptionClient({
			authFile,
			fetchImpl,
			conversationStore: store,
		});
		const events = await collect(
			first.runMessage(
				{
					content: "durable secret question",
					model_name: "gpt-test",
					memory: "off",
				},
				{
					durableSession: {
						sessionId: "sess_subscription",
						sessionRoot: qSessionDir(cwd, "sess_subscription"),
					},
				},
			),
		);
		const threadId = events.find((event) => event.kind === "thread");
		expect(threadId?.kind).toBe("thread");
		const id = threadId?.kind === "thread" ? threadId.threadId : "";

		const raw = await readFile(
			join(
				qSessionDir(cwd, "sess_subscription"),
				"subscription-conversation.json",
			),
			"utf8",
		);
		expect(raw).not.toContain("durable secret question");
		const reopened = new CodexSubscriptionClient({
			authFile,
			fetchImpl,
			conversationStore: store,
		});
		expect((await reopened.listThreads())[0]?.thread_id).toBe(id);
		expect((await reopened.getThread(id)).first_user_message).toBe(
			"durable secret question",
		);
		await collect(
			reopened.runMessage({
				thread_id: id,
				content: "continue",
				model_name: "gpt-test",
				memory: "off",
			}),
		);
		const resumedInput = requestBodies[1]?.input as Array<
			Record<string, unknown>
		>;
		expect(resumedInput).toHaveLength(3);
		expect(resumedInput[1]).toMatchObject({
			type: "message",
			role: "assistant",
		});
	});

	it("writes encrypted workspace memory and injects it into a new thread", async () => {
		const cwd = join(root, "memory");
		const memoryStore = new SubscriptionMemoryStore(cwd);
		const bodies: Array<Record<string, unknown>> = [];
		const fetchImpl = (async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return eventStream(bodies.length === 1 ? "Use tabs." : "remembered");
		}) as typeof fetch;
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl,
			memoryStore,
		});
		await collect(
			client.runMessage({
				content: "I prefer tabs in TypeScript.",
				model_name: "gpt-test",
				memory: "Auto",
				memory_profile: "code",
			}),
		);
		await collect(
			client.runMessage({
				content: "What style should I use?",
				model_name: "gpt-test",
				memory: "Readonly",
				memory_profile: "code",
			}),
		);

		expect(String(bodies[1]?.instructions)).toContain(
			"I prefer tabs in TypeScript.",
		);
		const raw = await readFile(
			join(cwd, ".backboard", "subscription-memory.json"),
			"utf8",
		);
		expect(raw).not.toContain("I prefer tabs in TypeScript.");
	});
});
