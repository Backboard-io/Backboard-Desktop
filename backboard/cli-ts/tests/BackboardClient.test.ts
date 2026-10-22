import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import {
	BackboardError,
	BackboardTransportError,
} from "../src/providers/backboard/errors.ts";
import workerIdentityMismatch from "./fixtures/backboard-worker-identity-mismatch.json";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("BackboardClient streaming transport", () => {
	it("stops a corrupted continuation without resubmitting previously consumed outputs", async () => {
		let posts = 0;
		globalThis.fetch = (async () => {
			posts++;
			return new Response(
				workerIdentityMismatch
					.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
					.join(""),
			);
		}) as unknown as typeof fetch;
		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});
		const events = [];
		for await (const event of client.runToolOutputs({
			thread_id: "synthetic_thread",
			run_id: "synthetic_run",
			tool_outputs: [
				{ tool_call_id: "previous_successful_call", output: "ok" },
			],
			tools: [],
		}))
			events.push(event);
		expect(posts).toBe(1);
		expect(
			events.filter(
				(event) =>
					event.kind === "requires_action" || event.kind === "completed",
			),
		).toEqual([]);
		expect(events.at(-1)).toEqual({
			kind: "failed",
			error: expect.stringContaining(
				"changed tool name from agent_spawn to glob",
			),
			retryable: false,
		});
	});

	it("names the calling product only when BACKBOARD_CLIENT is set", async () => {
		const sent: (string | null)[] = [];
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			sent.push(new Headers(init?.headers).get("X-Backboard-Client"));
			return Response.json([]);
		}) as unknown as typeof fetch;
		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});
		const previous = process.env.BACKBOARD_CLIENT;
		try {
			process.env.BACKBOARD_CLIENT = "studio/3.1.26";
			await client.listThreads();
			delete process.env.BACKBOARD_CLIENT;
			await client.listThreads();
		} finally {
			if (previous === undefined) delete process.env.BACKBOARD_CLIENT;
			else process.env.BACKBOARD_CLIENT = previous;
		}
		expect(sent).toEqual(["studio/3.1.26", null]);
	});

	it("lists and fetches threads", async () => {
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/threads?limit=200&include_messages=false")) {
				return Response.json([{ thread_id: "thread_1", messages: [] }]);
			}
			return Response.json({ thread_id: "thread_1", messages: [] });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(client.listThreads()).resolves.toEqual([
			{ thread_id: "thread_1", messages: [] },
		]);
		await expect(client.getThread("thread/1")).resolves.toEqual({
			thread_id: "thread_1",
			messages: [],
		});
		expect(requestedUrls).toEqual([
			"https://api.example.test/threads?limit=200&include_messages=false",
			"https://api.example.test/threads/thread%2F1",
		]);
	});

	it("submits run-scoped tool outputs with continuation tools", async () => {
		let requestedUrl = "";
		let requestedBody: unknown;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedUrl = String(input);
			requestedBody = JSON.parse(String(init?.body));
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		for await (const _event of client.runToolOutputs({
			thread_id: "thread 1",
			run_id: "run/1",
			tool_outputs: [{ tool_call_id: "call_1", output: "ok" }],
			tools: [],
		})) {
			// no-op
		}

		expect(requestedUrl).toBe(
			"https://api.example.test/threads/thread%201/runs/run%2F1/submit-tool-outputs?stream=true",
		);
		expect(requestedBody).toEqual({
			tool_outputs: [{ tool_call_id: "call_1", output: "ok" }],
			tools: [],
			stream: true,
		});
	});

	it("never puts the billing route on the wire", async () => {
		const bodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(
				JSON.stringify({ thread_id: "t", content: "", status: "COMPLETED" }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await client.sendMessage({ content: "hi", source: "byok" });
		for await (const _event of client.runMessage({
			content: "hi",
			source: "byok",
		})) {
			// drain
		}
		for await (const _event of client.runToolOutputs({
			thread_id: "t",
			run_id: "r",
			tool_outputs: [],
			source: "byok",
		})) {
			// drain
		}
		for await (const _event of client.runToolOutputs({
			thread_id: "t",
			tool_outputs: [],
			source: "byok",
		})) {
			// drain
		}

		expect(bodies).toHaveLength(4);
		expect(bodies.filter((body) => "source" in body)).toEqual([]);
		expect(bodies[0]).toEqual({ content: "hi" });
	});

	it("announces a streamed Write before its arguments finish", async () => {
		globalThis.fetch = (async () =>
			new Response(
				[
					{
						type: "provider_chunk",
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { name: "Wr", arguments: '{"file_path":' },
										},
									],
								},
							},
						],
					},
					{
						type: "provider_chunk",
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { name: "ite", arguments: '"large.ts"' },
										},
									],
								},
							},
						],
					},
				]
					.map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
					.join(""),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});
		const events = [];
		for await (const event of client.runMessage({
			content: "write a large file",
			tools: [
				{
					type: "function",
					function: {
						name: "Write",
						description: "Write a file",
						parameters: {},
					},
				},
			],
		})) {
			events.push(event);
		}

		expect(events.filter((event) => event.kind === "tool_started")).toEqual([
			expect.objectContaining({ kind: "tool_started", name: "Write" }),
		]);
	});

	it("wraps stream read failures with endpoint context", async () => {
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						throw new Error("The operation timed out.");
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		let thrown: unknown;
		try {
			for await (const _event of client.runToolOutputs({
				thread_id: "thread",
				tool_outputs: [],
			})) {
				// no-op
			}
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(BackboardTransportError);
		expect((thrown as Error).message).toContain(
			"Backboard stream failed for /threads/tool-outputs",
		);
		expect((thrown as Error).message).toContain("The operation timed out.");
	});
});

describe("BackboardClient attachment endpoints", () => {
	let testTmpDir: string;

	beforeAll(async () => {
		testTmpDir = await mkdtemp(join(tmpdir(), "backboard-client-test-"));
	});

	afterAll(async () => {
		await rm(testTmpDir, { recursive: true, force: true });
	});

	it("runMessage with attachment file paths posts multipart form data", async () => {
		const filePath = join(
			testTmpDir,
			`backboard-attachment-test-${Date.now()}.txt`,
		);
		await Bun.write(filePath, "hello attachment");

		let requestedUrl = "";
		let requestedMethod = "";
		let requestedHeaders: Headers | undefined;
		let requestedBody: FormData | undefined;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedUrl = String(input);
			requestedMethod = String(init?.method);
			requestedHeaders = new Headers(init?.headers);
			requestedBody = init?.body as FormData;
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		const events = [];
		for await (const event of client.runMessage(
			{
				content: "look at this",
				thread_id: "thr_1",
				tools: [],
				metadata: { backboard_workspace_id: "ws_1" },
			},
			{ attachmentFilePaths: [filePath] },
		)) {
			events.push(event);
		}

		expect(
			events.filter((event) => event.kind !== "thinking_resolved"),
		).toEqual([]);
		expect(requestedUrl).toBe("https://api.example.test/threads/messages");
		expect(requestedMethod).toBe("POST");
		expect(requestedHeaders?.get("X-API-Key")).toBe("test");
		expect(requestedHeaders?.has("Content-Type")).toBe(false);
		expect(requestedBody).toBeInstanceOf(FormData);
		expect(requestedBody?.get("content")).toBe("look at this");
		expect(requestedBody?.get("thread_id")).toBe("thr_1");
		expect(requestedBody?.get("stream")).toBe("true");
		expect(requestedBody?.get("tools")).toBe("[]");
		expect(requestedBody?.get("metadata")).toBe(
			JSON.stringify({ backboard_workspace_id: "ws_1" }),
		);
		const uploadedFile = requestedBody?.get("files") as File;
		expect(await uploadedFile.text()).toBe("hello attachment");
		// Bun.file()-backed FormData entries report the source path via .name
		// instead of the append()-time filename override, so check the filename
		// that is actually serialized onto the wire instead.
		const serializedBody = await new Request("http://localhost", {
			method: "POST",
			body: requestedBody,
		}).text();
		expect(serializedBody).toContain(`filename="${basename(filePath)}"`);
	});

	it("runMessage without attachments keeps the JSON body", async () => {
		let requestedHeaders: Headers | undefined;
		let requestedBody: string | undefined;
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedHeaders = new Headers(init?.headers);
			requestedBody = init?.body as string;
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		for await (const _event of client.runMessage({ content: "hi" })) {
			// drain
		}

		expect(requestedHeaders?.get("Content-Type")).toBe("application/json");
		expect(JSON.parse(requestedBody ?? "")).toEqual({
			content: "hi",
			stream: true,
		});
	});

	it("throws BackboardError on non-2xx", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ detail: "nope" }), {
				status: 400,
			})) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(
			client.createAssistant({ name: "a", system_prompt: "s", tools: [] }),
		).rejects.toBeInstanceOf(BackboardError);
	});

	it("retries a transient gateway failure on non-stream requests", async () => {
		let posts = 0;
		globalThis.fetch = (async () => {
			posts++;
			if (posts < 3) {
				return new Response("<html>502 Bad Gateway</html>", {
					status: 502,
				});
			}
			return Response.json({ thread_id: "thread_1", messages: [] });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(client.getThread("thread_1")).resolves.toEqual({
			thread_id: "thread_1",
			messages: [],
		});
		expect(posts).toBe(3);
	});

	it("does not retry non-retryable statuses on non-stream requests", async () => {
		let posts = 0;
		globalThis.fetch = (async () => {
			posts++;
			return new Response(JSON.stringify({ detail: "nope" }), {
				status: 400,
			});
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(client.listThreads()).rejects.toBeInstanceOf(BackboardError);
		expect(posts).toBe(1);
	});
});
