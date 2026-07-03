import { APP_DISPLAY_NAME } from "../../config/branding.ts";

export type Command =
	| { type: "message"; text: string }
	| { type: "help" }
	| { type: "new" }
	| { type: "quit" }
	| { type: "login" }
	| { type: "logout" }
	| { type: "model" }
	| { type: "memory" }
	| { type: "cua" }
	| { type: "browser" }
	| { type: "lsp" }
	| { type: "mcp" }
	| { type: "hooks" }
	| { type: "skills" }
	| { type: "notify" }
	| { type: "unknown"; name: string };

export interface SlashCommandDefinition {
	name: string;
	type: Command["type"];
	description: string;
	aliases?: string[];
}

export interface SlashCommandSuggestion {
	command: string;
	type: Command["type"];
	description: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		name: "model",
		type: "model",
		description: "Pick a model and thinking mode from Backboard",
	},
	{
		name: "memory",
		type: "memory",
		description: "Set persistent memory mode",
	},
	{
		name: "cua",
		type: "cua",
		description: "Enable local computer use for this session",
	},
	{
		name: "browser",
		type: "browser",
		description: "Enable the Browser tool for this session",
	},
	{
		name: "lsp",
		type: "lsp",
		description: "Toggle language-server diagnostics for this session",
	},
	{ name: "mcp", type: "mcp", description: "Manage MCP servers" },
	{ name: "hooks", type: "hooks", description: "Manage hooks" },
	{ name: "new", type: "new", description: "Start a new thread" },
	{ name: "login", type: "login", description: "Sign in with Backboard" },
	{
		name: "logout",
		type: "logout",
		description: "Sign out and end this session",
	},
	{ name: "help", type: "help", description: "Show this help" },
	{
		name: "quit",
		type: "quit",
		description: `Quit ${APP_DISPLAY_NAME} (or press Ctrl+C twice)`,
	},
	{ name: "skills", type: "skills", description: "Open the skill picker" },
	{
		name: "notify",
		type: "notify",
		description: "Toggle a ring when a prompt finishes",
	},
];

const SLASH_SUGGESTION_LIMIT = 6;

export const HELP_TEXT = [
	"Commands:",
	...SLASH_COMMANDS.map(
		(command) => `  /${command.name.padEnd(7)} ${command.description}`,
	),
	"  /skill-name Invoke a loaded skill by name",
].join("\n");

/** Parses raw input into a command. Non-slash input becomes a message. */
export function parseCommand(
	input: string,
	skillCommands: ReadonlySet<string> = new Set(),
): Command {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return { type: "message", text: trimmed };
	}

	const withoutSlash = trimmed.slice(1);
	const name = withoutSlash.split(/\s+/)[0]?.toLowerCase() ?? "";
	switch (name) {
		case "help":
			return { type: "help" };
		case "new":
			return { type: "new" };
		case "exit":
		case "quit":
			return { type: "quit" };
		case "login":
			return { type: "login" };
		case "logout":
			return { type: "logout" };
		case "model":
			return { type: "model" };
		case "memory":
			return { type: "memory" };
		case "cua":
			return { type: "cua" };
		case "browser":
			return { type: "browser" };
		case "lsp":
			return { type: "lsp" };
		case "mcp":
			return { type: "mcp" };
		case "hooks":
			return { type: "hooks" };
		case "skills":
			return { type: "skills" };
		case "notify":
			return { type: "notify" };
		default:
			if (skillCommands.has(name)) {
				const rest = withoutSlash.slice(name.length).trim();
				return {
					type: "message",
					text: rest ? `$${name} ${rest}` : `$${name}`,
				};
			}
			// Filepath-like input (e.g. /a/b/c) is not a command; send it as a
			// message instead of failing with "unknown command".
			if (name.includes("/")) {
				return { type: "message", text: trimmed };
			}
			return { type: "unknown", name };
	}
}

export function canRunCommandAfterSessionEnd(
	command: Command["type"],
): boolean {
	return (
		command === "help" ||
		command === "new" ||
		command === "quit" ||
		command === "login" ||
		command === "logout" ||
		command === "memory" ||
		command === "lsp" ||
		command === "notify"
	);
}

export function slashCommandSuggestions(
	input: string,
	options: {
		skillCommands?: readonly string[];
		allowCommand?: (type: Command["type"]) => boolean;
		limit?: number;
	} = {},
): SlashCommandSuggestion[] {
	const query = slashCommandQuery(input);
	if (query === null) return [];

	const commands = availableSlashCommands(options.skillCommands ?? []).filter(
		(command) => options.allowCommand?.(command.type) ?? true,
	);
	const limit = options.limit ?? SLASH_SUGGESTION_LIMIT;
	return commands
		.map((command, index) => ({
			command,
			index,
			score: slashCommandScore(command, query),
		}))
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.slice(0, limit)
		.map(({ command }) => ({
			command: `/${command.name}`,
			type: command.type,
			description: command.description,
		}));
}

export function completeSlashCommandInput(
	input: string,
	suggestion: SlashCommandSuggestion | undefined,
): string {
	return suggestion && slashCommandQuery(input) !== null
		? `${suggestion.command} `
		: input;
}

function slashCommandQuery(input: string): string | null {
	if (!input.startsWith("/")) return null;
	if (/\s/.test(input.trimStart())) return null;
	const query = input.slice(1);
	// Filepath-like input (e.g. /a/b/c) is not a slash command query.
	if (query.includes("/")) return null;
	return query.toLowerCase();
}

function availableSlashCommands(
	skillCommands: readonly string[],
): SlashCommandDefinition[] {
	const seen = new Set<string>();
	const commands: SlashCommandDefinition[] = [];
	for (const command of SLASH_COMMANDS) {
		seen.add(command.name);
		commands.push(command);
	}
	for (const skill of skillCommands) {
		const name = skill.trim().toLowerCase();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		commands.push({
			name,
			type: "message",
			description: "Invoke loaded skill",
		});
	}
	return commands;
}

function slashCommandScore(
	command: SlashCommandDefinition,
	query: string,
): number {
	if (!query) return 0;

	const name = command.name.toLowerCase();
	const aliases = command.aliases?.map((alias) => alias.toLowerCase()) ?? [];
	const description = command.description.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 10 + name.length;
	if (aliases.some((alias) => alias === query)) return 20;
	if (aliases.some((alias) => alias.startsWith(query))) return 30 + name.length;
	if (name.includes(query)) return 50 + name.indexOf(query);
	if (description.includes(query)) return 100 + description.indexOf(query);

	const nameSubsequence = subsequenceScore(name, query);
	if (nameSubsequence !== null) return 200 + nameSubsequence;
	const textSubsequence = subsequenceScore(`${name} ${description}`, query);
	if (textSubsequence !== null) return 300 + textSubsequence;
	return 1000 + editDistancePrefix(name, query);
}

function subsequenceScore(text: string, query: string): number | null {
	let position = 0;
	let score = 0;
	for (const char of query) {
		const next = text.indexOf(char, position);
		if (next === -1) return null;
		score += next - position;
		position = next + 1;
	}
	return score + text.length;
}

function editDistancePrefix(text: string, query: string): number {
	const target = text.slice(0, Math.max(query.length, 1));
	const previous = Array.from(
		{ length: target.length + 1 },
		(_, index) => index,
	);
	for (let row = 1; row <= query.length; row += 1) {
		let diagonal = previous[0] ?? 0;
		previous[0] = row;
		for (let column = 1; column <= target.length; column += 1) {
			const above = previous[column] ?? 0;
			const cost = query[row - 1] === target[column - 1] ? 0 : 1;
			previous[column] = Math.min(
				(previous[column] ?? 0) + 1,
				(previous[column - 1] ?? 0) + 1,
				diagonal + cost,
			);
			diagonal = above;
		}
	}
	return (previous[target.length] ?? query.length) + text.length;
}
