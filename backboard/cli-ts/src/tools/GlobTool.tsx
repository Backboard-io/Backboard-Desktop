import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { resolveRipgrep } from "../core/search/ripgrep.ts";
import { SearchError } from "../core/search/SearchError.ts";
import {
	displaySearchPath,
	inspectSearchPath,
	runSearch,
	type SearchMetadata,
	searchLimitNote,
} from "../core/search/searchRunner.ts";
import {
	asString,
	asStringArray,
	relativizePath,
	withMeta,
} from "../core/tools/inputSummary.ts";
import {
	BROWSING_PREVIEW_LINES,
	buildOutputPreview,
} from "../core/tools/outputPreview.ts";
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
			.min(1)
			.refine(
				(value) => !value.startsWith("!"),
				"Use excludePatterns for exclusions",
			)
			.optional()
			.describe("Deprecated alias for patterns; prefer patterns."),
		// A bare string is coerced to a one-element array in parseInput; the
		// schema stays a plain array because the Backboard API rejects
		// properties without a top-level "type" (anyOf alone is not accepted).
		patterns: z
			.array(
				z
					.string()
					.min(1)
					.refine(
						(value) => !value.startsWith("!"),
						"Use excludePatterns for exclusions",
					),
			)
			.optional()
			.describe(
				'One or more glob patterns combined with OR logic. Examples: ["*.ts"], ["src/**/*.tsx", "src/**/*.css"]. A bare string is also accepted.',
			),
		path: z
			.string()
			.optional()
			.describe(
				"Base directory or explicit file to search. Defaults to the current working directory. Explicit files are returned directly under ripgrep path rules.",
			),
		excludePatterns: z
			.array(z.string())
			.optional()
			.describe(
				'Unsigned glob patterns to exclude, e.g. ["node_modules/**"]. A single leading ! is also accepted for compatibility.',
			),
		hidden: z
			.boolean()
			.optional()
			.describe(
				"Include hidden files/directories. Defaults to false; explicit positive globs or file paths can include hidden files under ripgrep rules.",
			),
		no_ignore: z
			.boolean()
			.optional()
			.describe(
				"Disable ignore-file rules for this scoped search. Defaults to false. Does not enable hidden files by itself.",
			),
	})
	.refine((input) => input.pattern || (input.patterns?.length ?? 0) > 0, {
		message: "Provide patterns",
	});

type Input = z.infer<typeof schema>;

interface Output extends SearchMetadata {
	files: string[];
	count: number;
	countUnit: "files";
}

const MAX_RESULTS = 1000;

export class GlobTool extends Tool<Input, Output> {
	readonly name = "Glob";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override summarizeInput(input: Input): string | undefined {
		const patterns = [...(asStringArray(input.patterns) ?? [])];
		const legacy = asString(input.pattern);
		if (legacy) patterns.unshift(legacy);
		if (patterns.length === 0) return undefined;
		const meta: string[] = [];
		const path = asString(input.path);
		if (path) meta.push(`in ${relativizePath(path)}`);
		const exclude = asStringArray(input.excludePatterns);
		if (exclude) meta.push(`excl ${exclude.join(", ")}`);
		return withMeta(patterns.join(", "), meta);
	}

	override parseInput(raw: unknown): Input {
		// Tolerate a bare string (or JSON-encoded array) for `patterns`.
		if (typeof raw === "object" && raw !== null && "patterns" in raw) {
			const record = raw as Record<string, unknown>;
			raw = {
				...record,
				patterns: normalizePatterns(record.patterns),
			};
		}
		const input = super.parseInput(raw);
		// Normalize before early-execution identity comparison, not only at spawn.
		return {
			...input,
			...(input.excludePatterns
				? { excludePatterns: input.excludePatterns.map(normalizeExclusion) }
				: {}),
		};
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const searchPath = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
		const pathType = await inspectSearchPath(searchPath, ctx.signal);
		const cwd = pathType === "directory" ? searchPath : dirname(searchPath);
		const executable = await resolveRipgrep({ signal: ctx.signal });
		const patterns = [...(input.patterns ?? [])];
		if (input.pattern) patterns.unshift(input.pattern);
		if (!patterns.length)
			throw new SearchError(
				'Provide at least one glob, e.g. {"patterns":["src/**/*.ts"]}.',
				"invalid_argument",
				"GLOB_PATTERNS_REQUIRED",
			);
		const args = ["--no-config", "--files", "--null", "--color=never"];
		for (const pattern of patterns) args.push("--glob", pattern);
		for (const pattern of input.excludePatterns ?? [])
			args.push("--glob", `!${normalizeExclusion(pattern)}`);
		if (input.hidden) args.push("--hidden");
		if (input.no_ignore) args.push("--no-ignore");
		// Explicit files retain rg's documented file-path precedence over glob/ignore rules.
		if (pathType === "file")
			args.push(
				"--",
				`.${process.platform === "win32" ? "\\" : "/"}${basename(searchPath)}`,
			);
		const { records, exitCode, ...metadata } = await runSearch({
			executablePath: executable.path,
			args,
			cwd,
			signal: ctx.signal,
			delimiter: "\0",
			maxRecords: MAX_RESULTS,
			recordLimitReason: "file_limit",
			maxOutputBytes: 256_000,
			mapRecord: (file) => [{ text: displaySearchPath(file), value: file }],
		});
		const files = records.map((record) => record.value);
		const rendered = records.map((record) => record.text).join("\n");
		const body = metadata.truncated
			? [rendered, searchLimitNote(metadata)].filter(Boolean).join("\n")
			: rendered || "No files matched";
		const result = ok<Output>(
			{ files, count: files.length, countUnit: "files", ...metadata },
			body,
			metadata.truncated
				? `Returned ${files.length} files (partial; total unknown)`
				: files.length === 0
					? "No files matched"
					: `Found ${files.length} ${files.length === 1 ? "file" : "files"}`,
			buildOutputPreview(rendered, {
				maxLines: BROWSING_PREVIEW_LINES,
			}),
		);
		result.execution = {
			outcome: metadata.truncated
				? "partial"
				: files.length === 0
					? "no_match"
					: "success",
			...(exitCode !== null ? { exitCode } : {}),
			retryable: false,
		};
		return result;
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

function normalizeExclusion(pattern: string): string {
	const unsigned = pattern.startsWith("!") ? pattern.slice(1) : pattern;
	if (!unsigned || unsigned.startsWith("!")) {
		throw new SearchError(
			'Use unsigned excludePatterns, e.g. {"patterns":["**/*.ts"],"excludePatterns":["node_modules/**"]}.',
			"invalid_argument",
			"GLOB_EXCLUSION_INVALID",
		);
	}
	return unsigned;
}
