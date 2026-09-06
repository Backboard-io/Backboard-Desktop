import { describe, expect, it } from "bun:test";
import { GLOB_EXAMPLES } from "../src/prompts/tools/glob.tsx";
import { GREP_EXAMPLES } from "../src/prompts/tools/grep.tsx";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { GlobTool } from "../src/tools/GlobTool.tsx";
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

	it("repairs refined Glob scalar fields without making false truthy", () => {
		const input = new GlobTool().parseInput({
			patterns: "*.ts",
			hidden: "false",
			no_ignore: "true",
		});
		expect(input).toMatchObject({
			patterns: ["*.ts"],
			hidden: false,
			no_ignore: true,
		});
	});

	it("accepts omitted null options without changing legitimate literal strings", () => {
		expect(
			new GrepTool().parseInput({
				pattern: "false",
				path: null,
				head_limit: null,
			}),
		).toEqual({ pattern: "false" });
		expect(
			new GlobTool().parseInput({
				patterns: ["123"],
				path: null,
				excludePatterns: null,
			}),
		).toEqual({ patterns: ["123"] });
	});

	it("preserves Glob array/string/JSON-array and legacy pattern compatibility", () => {
		const tool = new GlobTool();
		for (const patterns of [["*.ts"], "*.ts", '["*.ts"]']) {
			expect(tool.parseInput({ patterns }).patterns).toEqual(["*.ts"]);
		}
		expect(tool.parseInput({ pattern: "*.ts" }).pattern).toBe("*.ts");
		// A character class is a literal glob, not a malformed serialization to guess at.
		expect(tool.parseInput({ patterns: "[abc].ts" }).patterns).toEqual([
			"[abc].ts",
		]);
	});

	it("rejects missing, ambiguous and unsafe search arguments", () => {
		const tool = new GlobTool();
		for (const input of [
			{},
			{ patterns: [] },
			{ patterns: "" },
			{ patterns: [4] },
			{ patterns: ["!*.ts"] },
			{ patterns: ["*"], excludePatterns: ["!!node_modules/**"] },
			{ patterns: ["*"], hidden: "yes" },
		]) {
			expect(() => tool.parseInput(input)).toThrow();
		}
		for (const value of ["NaN", "Infinity", "0x10", "1; rm", "1.5", "0", -1]) {
			expect(() =>
				new GrepTool().parseInput({ pattern: "needle", head_limit: value }),
			).toThrow();
		}
	});

	it("keeps every shared search prompt example valid against its single schema source", () => {
		for (const input of GREP_EXAMPLES)
			expect(() => new GrepTool().parseInput(input)).not.toThrow();
		for (const input of GLOB_EXAMPLES)
			expect(() => new GlobTool().parseInput(input)).not.toThrow();
	});
});
