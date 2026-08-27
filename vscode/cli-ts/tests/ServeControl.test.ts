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
			forkContext: "Prior conversation",
			model: "anthropic/claude-sonnet-4-5",
			permission: "auto" as const,
			thinking: "off",
			excludedTools: [],
			memory: "auto",
			computerUse: true,
			browserUse: true,
			notify: true,
			imageGeneration: true,
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
			result: { success: true, content: [{ type: "text" as const, text: "ok" }] },
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
});
