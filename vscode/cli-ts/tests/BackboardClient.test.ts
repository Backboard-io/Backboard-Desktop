import { afterEach, describe, expect, it } from "bun:test";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import { BackboardTransportError } from "../src/providers/backboard/errors.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("BackboardClient streaming transport", () => {
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
