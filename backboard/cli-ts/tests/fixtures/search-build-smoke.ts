/**
 * Opt-in packaged-runtime contract smoke, with no provider/network requests.
 * bun build --compile tests/fixtures/search-build-smoke.ts --outfile /tmp/backboard-search-smoke
 * env -i PATH=/usr/bin:/bin BACKBOARD_RIPGREP_PATH=/absolute/path/to/rg /tmp/backboard-search-smoke
 * Only temporary fixture files are created; no application is launched or replaced.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/core/bus/EventBus.ts";
import { resolveRipgrep } from "../../src/core/search/ripgrep.ts";
import type { ToolContext } from "../../src/core/tools/ToolContext.ts";
import { GlobTool } from "../../src/tools/GlobTool.tsx";
import { GrepTool } from "../../src/tools/GrepTool.tsx";

const cwd = await mkdtemp(join(tmpdir(), "harness compiled search-"));
const ctx: ToolContext = {
	cwd,
	sessionId: "offline-compiled-search",
	bus: new EventBus(),
	signal: new AbortController().signal,
	askUser: async () => "",
};

try {
	await mkdir(join(cwd, "node_modules"));
	await writeFile(join(cwd, "node_modules", "exclude.ts"), "needle\n");
	await writeFile(join(cwd, "-snow 雪.ts"), "needle 雪🙂\n".repeat(100));
	const glob = new GlobTool();
	const files = await glob.execute(
		glob.parseInput({
			patterns: "*.ts",
			excludePatterns: ["!node_modules/**"],
			hidden: "false",
		}),
		ctx,
	);
	const grep = new GrepTool();
	const found = await grep.execute(
		grep.parseInput({
			pattern: "needle",
			path: "-snow 雪.ts",
			head_limit: "2",
			line_numbers: "false",
		}),
		ctx,
	);
	const missing = await grep.execute({ pattern: "missing" }, ctx);
	if (
		files.data.count !== 1 ||
		found.data.returnedCount !== 2 ||
		!found.data.truncated ||
		found.data.totalKnown ||
		missing.execution?.outcome !== "no_match" ||
		missing.execution?.exitCode !== 1
	) {
		throw new Error("Compiled search contract failure");
	}
	console.log(
		JSON.stringify(
			{
				executable: process.execPath,
				capability: await resolveRipgrep(),
				globCount: files.data.count,
				grep: {
					returnedCount: found.data.returnedCount,
					truncated: found.data.truncated,
					limitReason: found.data.limitReason,
				},
				noMatch: missing.execution,
			},
			null,
			2,
		),
	);
} finally {
	await rm(cwd, { recursive: true, force: true });
}
