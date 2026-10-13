import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		expect(result.execution).toMatchObject({
			outcome: "no_match",
			exitCode: 1,
			retryable: false,
		});
	});

	it("includes ripgrep diagnostics for invalid patterns", async () => {
		const ctx = await context();
		await writeFile(join(ctx.cwd, "words.txt"), "one two\n");

		expect(
			new GrepTool().execute({ pattern: "[unterminated" }, ctx),
		).rejects.toThrow(/unclosed character class/);
	});

	it("bounds huge content at complete UTF-8 lines and reports an unknown total", async () => {
		const ctx = await context();
		await writeFile(
			join(ctx.cwd, "snow 雪.txt"),
			"needle 雪🙂 complete-line\n".repeat(20_000),
		);
		const result = await new GrepTool().execute({ pattern: "needle" }, ctx);
		expect(result.data).toMatchObject({
			truncated: true,
			totalKnown: false,
			limitReason: "output_bytes",
			limit: 40_000,
		});
		expect(result.data.totalCount).toBeUndefined();
		expect(result.forLLM).not.toContain("�");
		const lines = result.forLLM.split("\n");
		expect(lines.at(-2)).toEndWith("complete-line");
		expect(lines.at(-1)).toContain("Partial search");
		expect(
			Buffer.byteLength(lines.slice(0, -1).join("\n")),
		).toBeLessThanOrEqual(40_000);
	});

	it("stops at head_limit during search and excludes context from matching line counts", async () => {
		const ctx = await context();
		await writeFile(
			join(ctx.cwd, "context.txt"),
			"before\nneedle\nafter\nanother\n",
		);
		const result = await new GrepTool().execute(
			{ pattern: "needle", context: 1 },
			ctx,
		);
		expect(result.data).toMatchObject({
			matchCount: 1,
			matchCountUnit: "matching_lines",
			returnedCount: 3,
			totalKnown: true,
			totalCount: 3,
		});
		const capped = await new GrepTool().execute(
			{ pattern: "needle", context: 1, head_limit: 2 },
			ctx,
		);
		expect(capped.data).toMatchObject({
			matchCount: 1,
			returnedCount: 2,
			truncated: true,
			limitReason: "head_limit",
			limit: 2,
			totalKnown: false,
		});
	});

	it("never labels an oversized record as no matches", async () => {
		const ctx = await context();
		await writeFile(
			join(ctx.cwd, "large-line.txt"),
			`needle ${"x".repeat(500_000)}\n`,
		);
		const result = await new GrepTool().execute({ pattern: "needle" }, ctx);
		expect(result.data).toMatchObject({
			truncated: true,
			returnedCount: 0,
			limitReason: "record_bytes",
			totalKnown: false,
		});
		expect(result.forLLM).toContain("Partial search");
		expect(result.forLLM).not.toContain("No matches");
	});

	it("treats literal regex metacharacters and leading hyphens as content", async () => {
		const ctx = await context();
		await writeFile(
			join(ctx.cwd, "-snow 雪.txt"),
			"-foo[bar](x)?*\nnot-a-match\n",
		);
		const result = await new GrepTool().execute(
			{ pattern: "-foo[bar](x)?*", fixed_string: true, path: "-snow 雪.txt" },
			ctx,
		);
		expect(result.data).toMatchObject({ matchCount: 1, truncated: false });
		expect(result.forLLM).toContain("-foo[bar](x)?*");
	});

	it("keeps newline-bearing filenames intact in content and file_paths modes", async () => {
		const ctx = await context();
		const name = "colon:tab\tnewline\n雪.txt";
		await writeFile(join(ctx.cwd, name), "needle\n");
		for (const output_mode of ["content", "file_paths"] as const) {
			const result = await new GrepTool().execute(
				{ pattern: "needle", output_mode },
				ctx,
			);
			expect(result.data.returnedCount).toBe(1);
			expect(result.forLLM).toContain(JSON.stringify(join(ctx.cwd, name)));
		}
	});

	it("returns empty-directory/no-match success and missing-path/type failures distinctly", async () => {
		const ctx = await context();
		const empty = await new GrepTool().execute({ pattern: "needle" }, ctx);
		expect(empty.data).toMatchObject({
			returnedCount: 0,
			totalKnown: true,
			truncated: false,
		});
		await expect(
			new GrepTool().execute({ pattern: "needle", path: "missing" }, ctx),
		).rejects.toMatchObject({ category: "missing_path" });
		await expect(
			new GrepTool().execute(
				{ pattern: "needle", type: "no-such-type-xyz" },
				ctx,
			),
		).rejects.toMatchObject({ category: "invalid_argument" });
	});

	it("keeps default ignore rules and exposes explicit hidden/ignored controls", async () => {
		const ctx = await context();
		await mkdir(join(ctx.cwd, ".git"));
		await writeFile(join(ctx.cwd, ".gitignore"), "ignored.txt\n");
		await writeFile(join(ctx.cwd, "visible.txt"), "needle\n");
		await writeFile(join(ctx.cwd, "ignored.txt"), "needle\n");
		await writeFile(join(ctx.cwd, ".secret.txt"), "needle\n");
		const tool = new GrepTool();
		expect(
			(await tool.execute({ pattern: "needle" }, ctx)).data.returnedCount,
		).toBe(1);
		expect(
			(await tool.execute({ pattern: "needle", hidden: true }, ctx)).data
				.returnedCount,
		).toBe(2);
		expect(
			(await tool.execute({ pattern: "needle", no_ignore: true }, ctx)).data
				.returnedCount,
		).toBe(2);
		expect(
			(
				await tool.execute(
					{ pattern: "needle", hidden: true, no_ignore: true },
					ctx,
				)
			).data.returnedCount,
		).toBe(3);
		// Explicit positive globs override hidden/ignore rules for matching files.
		expect(
			(await tool.execute({ pattern: "needle", glob: "*.txt" }, ctx)).data
				.returnedCount,
		).toBe(3);
		expect(
			(await tool.execute({ pattern: "needle", path: ".secret.txt" }, ctx)).data
				.returnedCount,
		).toBe(1);
	});

	it("honors an already-cancelled caller", async () => {
		const ctx = await context();
		const abort = new AbortController();
		abort.abort();
		await expect(
			new GrepTool().execute(
				{ pattern: "needle" },
				{ ...ctx, signal: abort.signal },
			),
		).rejects.toMatchObject({ category: "cancelled" });
	});
});
