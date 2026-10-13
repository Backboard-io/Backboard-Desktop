import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

/** Sanitized examples contract-tested against the actual tool parser. */
export const GLOB_EXAMPLES = [
	{
		patterns: ["src/**/*.ts", "src/**/*.tsx"],
		excludePatterns: ["node_modules/**", "dist/**"],
	},
	{ patterns: ["**/*.json"], path: "config", hidden: true },
];

export const glob: PromptModule = definePrompt(
	buildGlobPrompt(),
	buildGlobPrompt,
);

function buildGlobPrompt(context: PromptContext = {}): string {
	return `Discover file paths with ripgrep glob patterns. The schema defines parameters and types.

${hasTool(context, "Read") ? "Read a known path directly. " : ""}${hasTool(context, "Grep") ? "Use Grep to search contents. " : ""}Choose the narrowest relevant base path, combine positive patterns with OR in one call, and inspect relevant candidates before widening. Stop discovery once the needed files are known.

Provide a nonempty patterns array. The legacy pattern field and a scalar patterns string are accepted for compatibility. Exclusions go in excludePatterns as unsigned globs, for example ["node_modules/**"]. One leading ! is accepted for compatibility; do not negate positive patterns or double-negate exclusions.

Default ignore rules remain enabled. hidden and no_ignore enable scoped hidden/ignored searches. Explicit positive globs can include hidden files according to ripgrep's rules. Results stop at 1,000 files or the output bound; a truncation marker means the list is partial and the total is unknown. Narrow the path or patterns before continuing.

Examples:
${GLOB_EXAMPLES.map((example) => JSON.stringify(example)).join("\n")}`;
}
