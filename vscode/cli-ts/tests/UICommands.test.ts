import { describe, expect, it } from "bun:test";
import {
	canRunCommandAfterSessionEnd,
	completeSlashCommandInput,
	parseCommand,
	slashCommandSuggestions,
} from "../src/ui/commands/index.ts";
import { canAuthenticateMcpServer } from "../src/ui/components/MCPServerActions.tsx";

describe("parseCommand", () => {
	it("parses the explicit skills load command", () => {
		expect(parseCommand("/skills")).toEqual({ type: "skills" });
	});

	it("parses the MCP manager command", () => {
		expect(parseCommand("/mcp")).toEqual({ type: "mcp" });
	});

	it("parses the hooks manager command", () => {
		expect(parseCommand("/hooks")).toEqual({ type: "hooks" });
	});

	it("parses notify", () => {
		expect(parseCommand("/notify")).toEqual({ type: "notify" });
	});

	it("parses lsp", () => {
		expect(parseCommand("/lsp")).toEqual({ type: "lsp" });
	});

	it("parses memory", () => {
		expect(parseCommand("/memory")).toEqual({ type: "memory" });
	});

	it("parses logout", () => {
		expect(parseCommand("/logout")).toEqual({ type: "logout" });
	});

	it("parses login", () => {
		expect(parseCommand("/login")).toEqual({ type: "login" });
	});

	it("turns loaded skill slash commands into explicit skill messages", () => {
		expect(
			parseCommand("/skill-creator build one", new Set(["skill-creator"])),
		).toEqual({
			type: "message",
			text: "$skill-creator build one",
		});
		expect(parseCommand("/skill-creator", new Set(["skill-creator"]))).toEqual({
			type: "message",
			text: "$skill-creator",
		});
	});

	it("keeps unknown slash command behavior", () => {
		expect(parseCommand("/missing", new Set(["skill-creator"]))).toEqual({
			type: "unknown",
			name: "missing",
		});
	});

	it("treats filepath-like input as a message, not a command", () => {
		expect(parseCommand("/a/b/c")).toEqual({
			type: "message",
			text: "/a/b/c",
		});
		expect(parseCommand("/path/to/file.ts more text")).toEqual({
			type: "message",
			text: "/path/to/file.ts more text",
		});
		expect(slashCommandSuggestions("/a/b/c")).toEqual([]);
	});

	it("parses quit and exit as close-session commands", () => {
		expect(parseCommand("/quit")).toEqual({ type: "quit" });
		expect(parseCommand("/exit")).toEqual({ type: "quit" });
	});

	it("blocks commands that would use an ended authenticated session", () => {
		for (const type of [
			"help",
			"new",
			"quit",
			"login",
			"logout",
			"memory",
			"lsp",
			"notify",
		] as const) {
			expect(canRunCommandAfterSessionEnd(type)).toBe(true);
		}
		for (const type of [
			"message",
			"model",
			"cua",
			"browser",
			"mcp",
			"hooks",
			"skills",
			"unknown",
		] as const) {
			expect(canRunCommandAfterSessionEnd(type)).toBe(false);
		}
	});
});

describe("slashCommandSuggestions", () => {
	it("shows six commands as soon as slash is typed", () => {
		const suggestions = slashCommandSuggestions("/");
		expect(suggestions).toHaveLength(6);
		expect(suggestions.map((suggestion) => suggestion.command)).toEqual([
			"/model",
			"/memory",
			"/cua",
			"/browser",
			"/lsp",
			"/mcp",
		]);
	});

	it("ranks similar commands while keeping a six-row list", () => {
		const suggestions = slashCommandSuggestions("/out");
		expect(suggestions).toHaveLength(6);
		expect(suggestions[0]?.command).toBe("/logout");
	});

	it("includes loaded skill commands", () => {
		const suggestions = slashCommandSuggestions("/btw", {
			skillCommands: ["btw"],
		});
		expect(suggestions).toHaveLength(6);
		expect(suggestions[0]).toEqual({
			command: "/btw",
			type: "message",
			description: "Invoke loaded skill",
		});
	});

	it("filters to commands allowed after a session ends", () => {
		const suggestions = slashCommandSuggestions("/", {
			allowCommand: canRunCommandAfterSessionEnd,
		});
		expect(suggestions.map((suggestion) => suggestion.command)).toEqual([
			"/memory",
			"/lsp",
			"/new",
			"/login",
			"/logout",
			"/help",
		]);
	});

	it("does not show suggestions for normal messages or command arguments", () => {
		expect(slashCommandSuggestions("hello")).toEqual([]);
		expect(slashCommandSuggestions("/model extra")).toEqual([]);
	});

	it("autocompletes slash input from the selected suggestion", () => {
		const suggestions = slashCommandSuggestions("/mod");
		expect(completeSlashCommandInput("/mod", suggestions[0])).toBe("/model ");
		expect(completeSlashCommandInput("hello", suggestions[0])).toBe("hello");
		expect(completeSlashCommandInput("/mod", undefined)).toBe("/mod");
	});
});

describe("MCP server actions", () => {
	it("allows HTTP authentication retries from error and connected states", () => {
		expect(
			canAuthenticateMcpServer({
				name: "figma",
				type: "http",
				configSources: [],
				status: "error",
				message: "HTTP 403: Invalid OAuth error response.",
				toolNames: [],
			}),
		).toBe(true);
		expect(
			canAuthenticateMcpServer({
				name: "local",
				type: "stdio",
				configSources: [],
				status: "error",
				toolNames: [],
			}),
		).toBe(false);
		expect(
			canAuthenticateMcpServer({
				name: "linear",
				type: "http",
				configSources: [],
				status: "connected",
				toolNames: ["mcp__linear__search"],
			}),
		).toBe(true);
	});
});
