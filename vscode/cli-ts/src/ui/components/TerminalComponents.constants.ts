export const BACKBOARD_MASCOT_PATTERN = [
	{ id: "Prehead", line: "  #######  ", height: 0.5 },
	{ id: "head", line: " #########  ", height: 1 },
	{ id: "eyes", line: "## ### #### ", height: 1 },
	{ id: "body", line: " #########  ", height: 1 },
	{ id: "feet", line: "  # # # #  ", height: 0.5 },
] as const;

export const DEFAULT_SHELL_SEGMENTS = {
	user: "backboard",
	path: "~",
	version: "v3.0.0",
} as const;

export const SHELL_PROMPT_DEFAULT_COLUMNS = 80;
export const SHELL_PROMPT_OUTER_PADDING = 2;
export const SHELL_PROMPT_MIN_PATH_WIDTH = 5;
export const SHELL_PROMPT_SEGMENT_PADDING_WIDTH = 2;
export const SHELL_PROMPT_DIVIDER_WIDTH = 1;
export const SHELL_PROMPT_CHILD_GAP = 1;

export const DEFAULT_RESPONSE_LINES = [
	"I'll keep the current card layout and replace the comparison claims with the content from your reference:",
	"I'll stop showing those as invented percent chart labels.",
] as const;

export const DEFAULT_RESPONSE_HIGHLIGHT =
	"Standard API baseline, Backboard Studio at 20-30% more output, and Open Source Models at 5-10x more output.";

export const DEFAULT_TOOL_OUTPUT_PREVIEW = [
	'{"id": "LKMdp9t", "name":',
	'  "BoxComparison.tsx", "path":',
	'  "Used_Components/BoxComparison.tsx",',
	'  "content": "// BoxComparison..."',
	"  { ...",
] as const;

export const DEFAULT_SKILL_ITEMS = [
	{
		name: "code-review",
		description: "Review changed code for correctness issues",
	},
	{
		name: "security-review",
		description: "Check auth, injection, and data exposure risks",
	},
	{
		name: "ui-deslop",
		description: "Polish vibe-coded UI into intentional product design",
	},
] as const;

export const DEFAULT_MCP_ITEMS = [
	{
		name: "figma",
		description: "Design context, screenshots, components, and variables",
	},
	{
		name: "github",
		description: "Issues, pull requests, checks, and repository context",
	},
	{
		name: "linear",
		description: "Issues, projects, teams, and workflow status",
	},
] as const;

export const DEFAULT_MODEL_ITEMS = [
	"openai/gpt-5.5",
	"anthropic/claude-sonnet-4.5",
	"google/gemini-2.5-pro",
] as const;
