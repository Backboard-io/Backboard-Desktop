import { describe, expect, it } from "bun:test";
import { parseControlLine } from "../src/entrypoints/serveControl.ts";

describe("parseControlLine", () => {
	it("ignores blank lines", () => {
		expect(parseControlLine("")).toBeNull();
		expect(parseControlLine("   ")).toBeNull();
	});

	it("rejects non-JSON lines", () => {
		expect(parseControlLine("not json")).toEqual({
			ok: false,
			error: "invalid control line: not JSON",
		});
	});

	it("rejects non-object payloads", () => {
		expect(parseControlLine("[1,2]")).toEqual({
			ok: false,
			error: "invalid control line: not an object",
		});
	});

	it("rejects unknown ops and echoes requestId", () => {
		expect(parseControlLine('{"op":"reboot","requestId":"r1"}')).toEqual({
			ok: false,
			error: 'invalid control line: unknown op "reboot"',
			requestId: "r1",
		});
	});

	it("parses a full submit op", () => {
		expect(
			parseControlLine(
				JSON.stringify({
					op: "submit",
					requestId: "r1",
					prompt: "hello",
					model: "openai/gpt-5.5",
					permission: "default",
					excludedTools: ["Browser", "Computer"],
				}),
			),
		).toEqual({
			ok: true,
			control: {
				op: "submit",
				requestId: "r1",
				prompt: "hello",
				model: "openai/gpt-5.5",
				permission: "default",
				excludedTools: ["Browser", "Computer"],
			},
		});
	});

	it("rejects submit without prompt or requestId", () => {
		expect(parseControlLine('{"op":"submit","requestId":"r1"}')).toEqual({
			ok: false,
			error: "invalid submit op: missing prompt",
			requestId: "r1",
		});
		expect(parseControlLine('{"op":"submit","prompt":"x"}')).toEqual({
			ok: false,
			error: "invalid submit op: missing requestId",
		});
	});

	it("validates respondInput and respondPermission fields", () => {
		expect(parseControlLine('{"op":"respondInput","id":"a"}')).toEqual({
			ok: false,
			error: "invalid respondInput op: missing answer",
		});
		expect(
			parseControlLine(
				'{"op":"respondPermission","id":"a","decision":"maybe"}',
			),
		).toEqual({
			ok: false,
			error: "invalid respondPermission op: missing decision",
		});
		expect(
			parseControlLine(
				'{"op":"respondPermission","id":"a","decision":"approve"}',
			),
		).toEqual({
			ok: true,
			control: { op: "respondPermission", id: "a", decision: "approve" },
		});
	});

	it("parses bare cancel and dispose ops", () => {
		expect(parseControlLine('{"op":"cancel"}')).toEqual({
			ok: true,
			control: { op: "cancel" },
		});
		expect(parseControlLine('{"op":"dispose"}')).toEqual({
			ok: true,
			control: { op: "dispose" },
		});
	});

	it("requires requestId for listModels and listTools", () => {
		expect(parseControlLine('{"op":"listModels"}')).toEqual({
			ok: false,
			error: "invalid listModels op: missing requestId",
		});
		expect(parseControlLine('{"op":"listTools","requestId":"r2"}')).toEqual({
			ok: true,
			control: { op: "listTools", requestId: "r2" },
		});
	});

	it("requires requestId for listSkills", () => {
		expect(parseControlLine('{"op":"listSkills"}')).toEqual({
			ok: false,
			error: "invalid listSkills op: missing requestId",
		});
		expect(parseControlLine('{"op":"listSkills","requestId":"r3"}')).toEqual({
			ok: true,
			control: { op: "listSkills", requestId: "r3" },
		});
	});

	it("parses steer and requires its prompt", () => {
		expect(parseControlLine('{"op":"steer"}')).toEqual({
			ok: false,
			error: "invalid steer op: missing prompt",
		});
		expect(
			parseControlLine('{"op":"steer","prompt":"do this instead"}'),
		).toEqual({
			ok: true,
			control: { op: "steer", prompt: "do this instead" },
		});
	});

	it("passes through submit memory, skills, and files", () => {
		const control = {
			op: "submit" as const,
			requestId: "r4",
			prompt: "go",
			memory: "auto",
			skills: ["code-review"],
			files: [{ fileName: "a.png", mimeType: "image/png", dataBase64: "aGk=" }],
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({
			ok: true,
			control,
		});
	});

	it("passes through submit computerUse and browserUse toggles", () => {
		const control = {
			op: "submit" as const,
			requestId: "r5",
			prompt: "go",
			computerUse: true,
			browserUse: false,
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({
			ok: true,
			control,
		});
	});

	it("passes through submit notify and imageGeneration toggles", () => {
		const control = {
			op: "submit" as const,
			requestId: "r6",
			prompt: "go",
			notify: true,
			imageGeneration: false,
		};
		expect(parseControlLine(JSON.stringify(control))).toEqual({
			ok: true,
			control,
		});
	});
});
