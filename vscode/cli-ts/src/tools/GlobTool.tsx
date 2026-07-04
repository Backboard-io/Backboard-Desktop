import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z
	.object({
		// Legacy alias kept for older transcripts and profiles; new prompt
		// contracts document only `patterns`.
		pattern: z
			.string()
			.optional()
			.describe("Deprecated alias for patterns; prefer patterns."),
		// A bare string is coerced to a one-element array in parseInput; the
		// schema stays a plain array because the Backboard API rejects
		// properties without a top-level "type" (anyOf alone is not accepted).
		patterns: z
			.array(z.string())
			.optional()
			.describe(
				'One or more glob patterns combined with OR logic. Examples: ["*.ts"], ["src/**/*.tsx", "src/**/*.css"]. A bare string is also accepted.',
			),
		path: z
			.string()
			.optional()
			.describe(
				"Base directory to search in. If not specified, searches in the current working directory.",
			),
		excludePatterns: z
			.array(z.string())
			.optional()
			.describe("Glob patterns to exclude from results."),
	})
	.refine((input) => input.pattern || (input.patterns?.length ?? 0) > 0, {
		message: "Provide patterns",
	});

type Input = z.infer<typeof schema>;

interface Output {
	files: string[];
	count: number;
}

const MAX_RESULTS = 1000;

export class GlobTool extends Tool<Input, Output> {
	readonly name = "Glob";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override parseInput(raw: unknown): Input {
		// Tolerate a bare string (or JSON-encoded array) for `patterns`.
		if (typeof raw === "object" && raw !== null && "patterns" in raw) {
			const record = raw as Record<string, unknown>;
			return super.parseInput({
				...record,
				patterns: normalizePatterns(record.patterns),
			});
		}
		return super.parseInput(raw);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const cwd = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
		const patterns = [...(input.patterns ?? [])];
		if (input.pattern) patterns.unshift(input.pattern);
		const { files, truncated } = await runRipgrepFiles(
			cwd,
			patterns,
			input.excludePatterns ?? [],
			ctx,
		);

		const body = files.length
			? files.join("\n") +
				(truncated
					? "\n[results truncated — narrow the pattern or path to see the rest]"
					: "")
			: "No files matched";
		return ok(
			{ files, count: files.length },
			body,
			files.length === 0
				? "No files matched"
				: `Found ${files.length}${truncated ? "+" : ""} file${files.length === 1 && !truncated ? "" : "s"}`,
		);
	}
}

function normalizePatterns(patterns: unknown): unknown {
	if (typeof patterns !== "string") return patterns;
	if (patterns.trimStart().startsWith("[")) {
		try {
			return JSON.parse(patterns);
		} catch {
			return [patterns];
		}
	}
	return [patterns];
}

const OUTPUT_CAP_BYTES = 80_000;

function runRipgrepFiles(
	cwd: string,
	patterns: string[],
	excludePatterns: string[],
	ctx: ToolContext,
): Promise<{ files: string[]; truncated: boolean }> {
	return new Promise((resolvePromise, reject) => {
		if (ctx.signal.aborted) return reject(new Error("aborted"));
		const args = ["--files", "--color=never"];
		for (const pattern of patterns) args.push("--glob", pattern);
		for (const pattern of excludePatterns) args.push("--glob", `!${pattern}`);
		const child = spawn("rg", args, { cwd, signal: ctx.signal });
		let stdout = "";
		let stderr = "";
		// Stopping rg once we have more output than we can return is a
		// truncated success — it must never surface as a tool error.
		let stoppedForCap = false;
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > OUTPUT_CAP_BYTES && !stoppedForCap) {
				stoppedForCap = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code, signal) => {
			// A cap-stop can cut the final path mid-line; drop the partial line.
			let text = stdout;
			if (stoppedForCap && text.length > 0 && !text.endsWith("\n")) {
				text = text.slice(0, text.lastIndexOf("\n") + 1);
			}
			const allFiles = text.trim() ? text.trimEnd().split("\n") : [];
			const files = allFiles.slice(0, MAX_RESULTS);
			if (stoppedForCap) {
				resolvePromise({ files, truncated: true });
				return;
			}
			// rg exit 0 = matches, 1 = no matches; anything else (or a signal
			// death we didn't cause) is a real failure.
			if (code !== 0 && code !== 1) {
				const reason = signal ? `killed by ${signal}` : `exit ${code}`;
				reject(new Error(stderr.trim() || `ripgrep failed (${reason})`));
				return;
			}
			resolvePromise({ files, truncated: allFiles.length > MAX_RESULTS });
		});
	});
}
