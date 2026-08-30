import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrepTool } from "../src/tools/GrepTool.tsx";
import { makeContext } from "./helpers.ts";

let testRoot: string | undefined;

afterEach(async () => {
	if (testRoot) await rm(testRoot, { recursive: true, force: true });
	testRoot = undefined;
});

async function context() {
	testRoot = await mkdtemp(join(tmpdir(), "backboard-grep-"));
	return {
		...makeContext(new AbortController().signal),
		cwd: testRoot,
	};
}

describe("GrepTool", () => {
	it("automatically uses PCRE2 for backreferences", async () => {
		const ctx = await context();
		await writeFile(join(ctx.cwd, "words.txt"), "one two\nrepeat repeat\n");

		const result = await new GrepTool().execute(
			{ pattern: String.raw`\b(\w+)\s+\1\b` },
			ctx,
		);

		expect(result.data.matchCount).toBe(1);
		expect(result.forLLM).toContain("repeat repeat");
	});

	it("returns no matches without failing", async () => {
		const ctx = await context();
		await writeFile(join(ctx.cwd, "words.txt"), "one two\n");

		const result = await new GrepTool().execute({ pattern: "missing" }, ctx);

		expect(result.title).toBe("No matches found");
		expect(result.data.matchCount).toBe(0);
	});

	it("includes ripgrep diagnostics for invalid patterns", async () => {
		const ctx = await context();
		await writeFile(join(ctx.cwd, "words.txt"), "one two\n");

		expect(
			new GrepTool().execute({ pattern: "[unterminated" }, ctx),
		).rejects.toThrow(/unclosed character class/);
	});
});
