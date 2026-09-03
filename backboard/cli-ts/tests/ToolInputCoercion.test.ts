import { describe, expect, it } from "bun:test";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { GrepTool } from "../src/tools/GrepTool.tsx";
import { ReadTool } from "../src/tools/ReadTool.tsx";

describe("tool input scalar coercion", () => {
	it("coerces quoted booleans and numbers for grep", () => {
		const input = new GrepTool().parseInput({
			pattern: "hello",
			ignore_case: "true",
			line_numbers: "false",
			head_limit: "20",
			context: "3",
		});

		expect(input.ignore_case).toBe(true);
		expect(input.line_numbers).toBe(false);
		expect(input.head_limit).toBe(20);
		expect(input.context).toBe(3);
	});

	it("coerces quoted numbers for read", () => {
		const input = new ReadTool().parseInput({
			file_path: "src/foo.ts",
			offset: "5",
			limit: "120",
		});

		expect(input.offset).toBe(5);
		expect(input.limit).toBe(120);
	});

	it("coerces quoted scalars for execute", () => {
		const input = new ExecuteTool().parseInput({
			command: "ls",
			timeout: "30",
			fireAndForget: "true",
		});

		expect(input.timeout).toBe(30);
		expect(input.fireAndForget).toBe(true);
	});

	it("keeps properly typed values and genuine strings untouched", () => {
		const input = new GrepTool().parseInput({
			pattern: "123",
			path: "456",
			ignore_case: true,
			head_limit: 10,
		});

		expect(input.pattern).toBe("123");
		expect(input.path).toBe("456");
		expect(input.ignore_case).toBe(true);
		expect(input.head_limit).toBe(10);
	});

	it("still rejects values that do not match the advertised type", () => {
		expect(() =>
			new GrepTool().parseInput({ pattern: "x", head_limit: "lots" }),
		).toThrow();
		expect(() =>
			new GrepTool().parseInput({ pattern: "x", ignore_case: "yes" }),
		).toThrow();
		expect(() =>
			new ReadTool().parseInput({ file_path: "a", offset: "1.5" }),
		).toThrow();
	});
});
