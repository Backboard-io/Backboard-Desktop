import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { GlobTool } from "../src/tools/GlobTool.tsx";

function context(cwd: string): ToolContext {
	return {
		sessionId: "sess_test",
		cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
	};
}

describe("GlobTool", () => {
	it("returns the result cap instead of failing when ripgrep output is large", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli-glob-large-"));
		try {
			await Promise.all(
				Array.from({ length: 1_100 }, (_, index) =>
					writeFile(
						join(
							cwd,
							`${String(index).padStart(4, "0")}-${"x".repeat(90)}.txt`,
						),
						"",
					),
				),
			);

			const result = await new GlobTool().execute(
				{ patterns: ["*"] },
				context(cwd),
			);

			expect(result.data.count).toBe(1_000);
			expect(result.data.files).toHaveLength(1_000);
			expect(result.title).toBe("Returned 1000 files (partial; total unknown)");
			expect(result.data).toMatchObject({
				truncated: true,
				returnedCount: 1_000,
				limit: 1_000,
				totalKnown: false,
				limitReason: "file_limit",
			});
			expect(result.data.totalCount).toBeUndefined();
			expect(result.forLLM).toContain("Total unknown");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("reports an empty result when ripgrep finds no files", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli-glob-empty-"));
		try {
			const result = await new GlobTool().execute(
				{ patterns: ["*.missing"] },
				context(cwd),
			);

			expect(result.data).toMatchObject({
				files: [],
				count: 0,
				truncated: false,
				totalKnown: true,
				totalCount: 0,
			});
			expect(result.title).toBe("No files matched");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("accepts signed and unsigned exclusions with the same canonical input", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli-glob-excludes-"));
		try {
			await mkdir(join(cwd, "node_modules"));
			await writeFile(join(cwd, "node_modules", "dependency.ts"), "");
			await writeFile(join(cwd, "source.ts"), "");
			const tool = new GlobTool();
			const inputs = ["node_modules/**", "!node_modules/**"].map((pattern) =>
				tool.parseInput({ patterns: ["**/*.ts"], excludePatterns: [pattern] }),
			);
			expect(inputs[0]).toEqual(inputs[1]);
			for (const input of inputs) {
				const result = await tool.execute(input, context(cwd));
				expect(result.data.files).toEqual(["source.ts"]);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("combines positive patterns with OR and preserves unusual filename delimiters", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli-glob-names-"));
		try {
			const names = ["-alpha.ts", "snow 雪.css", "colon:tab\tnewline\nfile.ts"];
			await Promise.all(
				[...names, "excluded.txt"].map((name) =>
					writeFile(join(cwd, name), ""),
				),
			);
			const result = await new GlobTool().execute(
				{ patterns: ["*.ts", "*.css"] },
				context(cwd),
			);
			expect(result.data.files.sort()).toEqual(names.sort());
			expect(result.forLLM).toContain(
				JSON.stringify("colon:tab\tnewline\nfile.ts"),
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("supports explicit files and paths with spaces and leading hyphens", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli glob path-"));
		try {
			await writeFile(join(cwd, "-file.ts"), "");
			const result = await new GlobTool().execute(
				{ patterns: ["*.txt"], path: "-file.ts" },
				context(cwd),
			);
			// Explicit file paths override globs, matching ripgrep's documented contract.
			expect(result.data.files).toEqual(["./-file.ts"]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("reports missing paths and invalid globs as failures", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cli-glob-invalid-"));
		try {
			await expect(
				new GlobTool().execute(
					{ patterns: ["*"], path: "missing" },
					context(cwd),
				),
			).rejects.toMatchObject({ category: "missing_path" });
			await expect(
				new GlobTool().execute({ patterns: ["[invalid"] }, context(cwd)),
			).rejects.toMatchObject({ category: "invalid_argument" });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
