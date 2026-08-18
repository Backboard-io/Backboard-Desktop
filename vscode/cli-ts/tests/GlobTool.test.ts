import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
			expect(result.title).toBe("Found 1000 files");
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

			expect(result.data).toEqual({ files: [], count: 0 });
			expect(result.title).toBe("No files matched");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
