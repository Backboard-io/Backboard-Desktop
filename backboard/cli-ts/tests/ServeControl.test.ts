import { describe, expect, it } from "bun:test";
import { parseControlLine } from "../src/entrypoints/serveControl.ts";

describe("parseControlLine", () => {
	it("ignores blank lines", () => {
		expect(parseControlLine(" ")).toBeNull();
	});

	it("rejects malformed and unknown controls", () => {
		expect(parseControlLine("not json")).toEqual({
			ok: false,
			error: "invalid control line: not JSON",
		});
		expect(parseControlLine('{"op":"reboot","requestId":"r1"}')).toEqual({
			ok: false,
			error: 'invalid control line: unknown op "reboot"',
			requestId: "r1",
		});
	});

	it("parses rewind transactions and rejects invalid buffer encodings", () => {
		for (const control of [
			{ op: "prepareRewind" as const, requestId: "request", transactionId: "tx-1", turnIds: ["turn-1"] },
			{ op: "commitRewind" as const, requestId: "request", transactionId: "tx-1", buffers: [{ path: "/file", content: "", encoding: "utf8" }] },
			{ op: "recoverRewind" as const, requestId: "request", transactionId: "tx-1" },
		]) expect(parseControlLine(JSON.stringify(control))).toEqual({ ok: true, control });
		expect(parseControlLine(JSON.stringify({ op: "commitRewind" as const, requestId: "request", transactionId: "tx-1", buffers: [{ path: "/file", content: "", encoding: 42 }] }))).toMatchObject({ ok: false });
	});

	it("parses the MCP server push and rejects malformed payloads", () => {
		const control = {
			op: "setMcpServers" as const,
			requestId: "mcp-1",
			servers: {
				"backboard": { type: "streamable-http", url: "https://backboard-docs.docsalot.dev/api/mcp" },
				playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
			},
			force: ["playwright"],
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({ ok: true, control });
		expect(parseControlLine(JSON.stringify({ op: "setMcpServers", requestId: "mcp-2", servers: ["nope"] }))).toMatchObject({ ok: false });
		expect(parseControlLine(JSON.stringify({ op: "setMcpServers", requestId: "mcp-3" }))).toMatchObject({ ok: false });
	});

	it("parses the public R-CLI submit settings", () => {
		const control = {
			op: "submit" as const,
			requestId: "r1",
			prompt: "hello",
			model: "openai/gpt-5.5",
			permission: "manual" as const,
			thinking: "dynamic",
			excludedTools: ["write", "execute"],
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({
			ok: true,
			control,
		});
	});

	it("parses the Backboard Studio submit settings", () => {
		// The full per-turn surface the IDE sends: `auto` permission (the
		// Default approvals tier) plus the feature toggles.
		const control = {
			op: "submit" as const,
			requestId: "r2",
			prompt: "hello",
			turnId: "stable-editor-turn",
			forkContext: "Prior conversation",
			systemContext: "Coordinate independent workers in parallel.",
			model: "anthropic/claude-sonnet-4-5",
			permission: "auto" as const,
			thinking: "off",
			excludedTools: [],
			memory: "auto",
			computerUse: true,
			browserUse: true,
			notify: true,
			imageGeneration: true,
			openRouterProvider: "DeepInfra",
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({
			ok: true,
			control,
		});
	});

	it("parses client tool definitions and results", () => {
		const submit = {
			op: "submit" as const,
			requestId: "r3",
			prompt: "play the game",
			clientTools: [
				{
					name: "open_browser_page",
					description: "Open a page",
					inputSchema: { type: "object" },
				},
			],
		};
		expect(parseControlLine(JSON.stringify(submit))).toEqual({
			ok: true,
			control: submit,
		});

		const result = {
			op: "clientToolResult" as const,
			id: "call_1",
			result: {
				success: true,
				content: [{ type: "text" as const, text: "ok" }],
			},
		};
		expect(parseControlLine(JSON.stringify(result))).toEqual({
			ok: true,
			control: result,
		});
		expect(parseControlLine('{"op":"clientToolResult"}')).toMatchObject({
			ok: false,
			error: "invalid clientToolResult op: missing id",
		});
	});

	it("requires submit fields and input answer arrays", () => {
		expect(parseControlLine('{"op":"submit","requestId":"r1"}')).toEqual({
			ok: false,
			error: "invalid submit op: missing prompt",
			requestId: "r1",
		});
		expect(
			parseControlLine('{"op":"respondInput","id":"ask","answer":"x"}'),
		).toEqual({
			ok: false,
			error: "invalid respondInput op: missing answers",
		});
		expect(
			parseControlLine(
				'{"op":"respondInput","id":"ask","answers":["yes","no"]}',
			),
		).toEqual({
			ok: true,
			control: { op: "respondInput", id: "ask", answers: ["yes", "no"] },
		});
		expect(
			parseControlLine(
				'{"op":"submit","requestId":"r1","prompt":"hello","forkContext":42}',
			),
		).toEqual({
			ok: false,
			error: "invalid submit op: missing forkContext",
			requestId: "r1",
		});
		expect(
			parseControlLine(
				'{"op":"submit","requestId":"r1","prompt":"hello","systemContext":42}',
			),
		).toEqual({
			ok: false,
			error: "invalid submit op: missing systemContext",
			requestId: "r1",
		});
	});

	it("validates Multitask guidance on steering turns", () => {
		expect(
			parseControlLine(
				'{"op":"steer","prompt":"change direction","systemContext":"Keep coordinating workers."}',
			),
		).toEqual({
			ok: true,
			control: {
				op: "steer",
				prompt: "change direction",
				systemContext: "Keep coordinating workers.",
			},
		});
		expect(
			parseControlLine(
				'{"op":"steer","prompt":"change direction","systemContext":42}',
			),
		).toEqual({
			ok: false,
			error: "invalid steer op: missing systemContext",
		});
	});

	it("requires request ids for list operations", () => {
		expect(parseControlLine('{"op":"listModels"}')).toEqual({
			ok: false,
			error: "invalid listModels op: missing requestId",
		});
		expect(parseControlLine('{"op":"listTools","requestId":"r2"}')).toEqual({
			ok: true,
			control: { op: "listTools", requestId: "r2" },
		});
	});

	it("accepts the generative-model catalog ops", () => {
		// These back the composer's image/video model pickers; if they are not in
		// the allowlist the catalog request is dropped and the picker times out.
		for (const op of ["listImageModels", "listVideoModels"] as const) {
			expect(parseControlLine(JSON.stringify({ op, requestId: "r1" }))).toEqual({
				ok: true,
				control: { op, requestId: "r1" },
			});
			expect(parseControlLine(JSON.stringify({ op }))).toEqual({
				ok: false,
				error: `invalid ${op} op: missing requestId`,
			});
		}
	});
});
