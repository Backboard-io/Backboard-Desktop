import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

/** Sanitized examples contract-tested against the actual tool parser. */
export const GREP_EXAMPLES = [
	{ pattern: "foo(", path: "src", fixed_string: true, head_limit: 20 },
	{
		pattern: "class|interface",
		path: "src",
		glob: "*.ts",
		output_mode: "content",
		line_numbers: true,
		context: 2,
	},
];

export const grep: PromptModule = definePrompt(
	buildGrepPrompt(),
	buildGrepPrompt,
);

function buildGrepPrompt(context: PromptContext = {}): string {
	return `Search file contents with ripgrep. The schema defines parameters and types.

${hasTool(context, "Read") ? "Read a known path directly when its contents or line range will answer the question. " : ""}${hasTool(context, "Glob") ? "Use Glob for path discovery. " : ""}Start in the narrowest relevant directory with a specific pattern, then widen only when results are insufficient. Stop once you have the evidence needed for the task. Batch independent searches when useful.

Use fixed_string for literal code containing regex metacharacters; regex mode preserves ripgrep semantics. Use output_mode=file_paths for candidate files, or content with line_numbers and limited context for inspection. Do not reinterpret a regex error as no matches.

head_limit stops collection at the requested number of returned records. Output is also bounded by bytes; truncated results are partial and do not establish absence elsewhere. Returned record counts are not total matches, especially with context. Narrow the search before requesting more output.

Default ignore rules remain enabled. hidden includes hidden files; no_ignore includes ignored files. Explicit paths or positive globs can include hidden/ignored files according to ripgrep's rules. Enable these controls only for a scoped search when needed.

Examples:
${GREP_EXAMPLES.map((example) => JSON.stringify(example)).join("\n")}`;
}
