import { resolve } from "node:path";
import { z } from "zod";
import { resolveRipgrep } from "../core/search/ripgrep.ts";
import {
	displaySearchPath,
	inspectSearchPath,
	runSearch,
	type SearchMetadata,
	type SearchRecord,
	searchLimitNote,
} from "../core/search/searchRunner.ts";
import {
	asString,
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

const schema = z.object({
	pattern: z
		.string()
		.describe(
			"A search pattern to match in file contents. Can be a literal string or a regular expression. Supports ripgrep regex syntax.",
		),
	path: z
		.string()
		.optional()
		.describe(
			"Path to a file or directory to search in. If not specified, searches in the current working directory.",
		),
	glob: z
		.string()
		.optional()
		.describe(
			'Glob pattern to filter files. Example: "*.js" for JavaScript files.',
		),
	fixed_string: z
		.boolean()
		.optional()
		.describe(
			"Treat the pattern as a literal string instead of a regex (ripgrep -F). Use for special characters like ?, *, (, [.",
		),
	ignore_case: z
		.boolean()
		.optional()
		.describe("Perform case-insensitive matching."),
	type: z
		.string()
		.optional()
		.describe("Ripgrep file type filter. Examples: js, py, rust, cpp."),
	hidden: z
		.boolean()
		.optional()
		.describe(
			"Include hidden files/directories. Defaults to false; an explicit glob or file path can still include hidden files under ripgrep rules.",
		),
	no_ignore: z
		.boolean()
		.optional()
		.describe(
			"Disable ignore-file rules for this scoped search. Defaults to false. Does not enable hidden files by itself.",
		),
	context_before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show before each match. Only works with output_mode="content".',
		),
	context_after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show after each match. Only works with output_mode="content".',
		),
	context: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show before and after each match. Only works with output_mode="content".',
		),
	line_numbers: z
		.boolean()
		.optional()
		.describe(
			'Show line numbers in output. Only works with output_mode="content".',
		),
	multiline: z
		.boolean()
		.optional()
		.describe(
			"Enable multiline mode where . matches newlines and patterns can span lines.",
		),
	output_mode: z
		.enum(["content", "file_paths"])
		.optional()
		.describe(
			'"file_paths" returns only matching file paths, "content" returns matching lines with optional context and line numbers.',
		),
	head_limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Stop at N returned lines (including context) or file paths. A reached limit produces a partial result with unknown total. Output also has a 40,000-byte bound.",
		),
});

type Input = z.infer<typeof schema>;

interface Output extends SearchMetadata {
	matches: string;
	/** Returned matching lines, excluding context; file_paths mode counts returned files. */
	matchCount: number;
	matchCountUnit: "matching_lines" | "files";
	countUnit: "lines" | "files";
}

const MAX_OUTPUT = 40_000;

export class GrepTool extends Tool<Input, Output> {
	readonly name = "Grep";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override summarizeInput(input: Input): string | undefined {
		const pattern = asString(input.pattern);
		if (!pattern) return undefined;
		const filters: string[] = [];
		const glob = asString(input.glob);
		if (glob) filters.push(glob);
		const type = asString(input.type);
		if (type) filters.push(type);
		const path = asString(input.path);
		if (path) filters.push(relativizePath(path));
		return withMeta(
			pattern.replace(/\s+/g, " ").trim(),
			filters.length ? [`in ${filters.join(", ")}`] : [],
		);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const searchPath = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
		await inspectSearchPath(searchPath, ctx.signal);
		const executable = await resolveRipgrep({ signal: ctx.signal });
		const outputMode = input.output_mode ?? "content";
		const args = ["--no-config", "--color=never"];
		// A small limit must receive early matches even when the rest of a large
		// file has none; rg's block buffering otherwise delays the first record.
		if (input.head_limit !== undefined) args.push("--line-buffered");
		if (!input.fixed_string) args.push("--engine=auto");
		if (outputMode === "file_paths")
			args.push("--files-with-matches", "--null");
		else args.push("--json");
		if (input.fixed_string) args.push("--fixed-strings");
		if (input.ignore_case) args.push("--ignore-case");
		if (input.glob) args.push("--glob", input.glob);
		if (input.type) args.push("--type", input.type);
		if (input.hidden) args.push("--hidden");
		if (input.no_ignore) args.push("--no-ignore");
		if (input.multiline) args.push("--multiline", "--multiline-dotall");
		if (input.context !== undefined) {
			args.push("--context", String(input.context));
		} else {
			if (input.context_before !== undefined) {
				args.push("--before-context", String(input.context_before));
			}
			if (input.context_after !== undefined) {
				args.push("--after-context", String(input.context_after));
			}
		}
		args.push("--regexp", input.pattern, "--", searchPath);

		const { records, exitCode, ...metadata } = await runSearch({
			executablePath: executable.path,
			args,
			cwd: ctx.cwd,
			signal: ctx.signal,
			delimiter: outputMode === "file_paths" ? "\0" : "\n",
			maxRecords: input.head_limit ?? Number.MAX_SAFE_INTEGER,
			recordLimitReason: "head_limit",
			maxOutputBytes: MAX_OUTPUT,
			mapRecord: (record) =>
				outputMode === "file_paths"
					? [{ text: displaySearchPath(record), value: true }]
					: contentRecords(record, input.line_numbers !== false),
		});
		const rendered = records.map((record) => record.text).join("\n");
		const matchCount = records.filter((record) => record.value).length;
		const summary = metadata.truncated
			? [rendered, searchLimitNote(metadata)].filter(Boolean).join("\n")
			: rendered || "No matches found";
		const noun = outputMode === "file_paths" ? "files" : "lines";
		const title = metadata.truncated
			? `Returned ${records.length} ${noun} (partial; total unknown)`
			: records.length === 0
				? "No matches found"
				: `Returned ${records.length} ${noun}`;
		const result = ok<Output>(
			{
				matches: summary,
				matchCount,
				matchCountUnit:
					outputMode === "file_paths" ? "files" : "matching_lines",
				countUnit: noun,
				...metadata,
			},
			summary,
			title,
			buildOutputPreview(rendered, { maxLines: BROWSING_PREVIEW_LINES }),
		);
		result.execution = {
			outcome: metadata.truncated
				? "partial"
				: records.length === 0
					? "no_match"
					: "success",
			...(exitCode !== null ? { exitCode } : {}),
			retryable: false,
		};
		return result;
	}
}

interface RipgrepText {
	text?: string;
	bytes?: string;
}

interface RipgrepEvent {
	type: string;
	data: {
		path: RipgrepText;
		lines: RipgrepText;
		line_number: number;
		submatches: { start: number; end: number }[];
	};
}

function decodeText(value: RipgrepText): string {
	if (typeof value.text === "string") return value.text;
	if (typeof value.bytes === "string")
		return Buffer.from(value.bytes, "base64").toString("utf8");
	throw new Error("Missing ripgrep text");
}

/** JSON keeps filenames separate from content and identifies true matching lines. */
function* contentRecords(
	record: string,
	lineNumbers: boolean,
): Iterable<SearchRecord<boolean>> {
	const event = JSON.parse(record) as RipgrepEvent;
	if (event.type !== "match" && event.type !== "context") return;
	const path = displaySearchPath(decodeText(event.data.path));
	const lines = decodeText(event.data.lines).replace(/\n$/, "").split("\n");
	let byteOffset = 0;
	for (const [index, text] of lines.entries()) {
		const byteEnd = byteOffset + Buffer.byteLength(text) + 1;
		const matched =
			event.type === "match" &&
			event.data.submatches.some(
				(match) =>
					match.start < byteEnd &&
					(match.end > byteOffset || match.start === byteOffset),
			);
		const separator = matched ? ":" : "-";
		yield {
			text: `${path}${separator}${lineNumbers ? `${event.data.line_number + index}${separator}` : ""}${text}`,
			value: matched,
		};
		byteOffset = byteEnd;
	}
}
