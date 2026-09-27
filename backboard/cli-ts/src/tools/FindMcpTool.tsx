import { z } from "zod";
import type {
	McpAddOptions,
	McpAddResult,
	McpRegistryItem,
	McpServerRuntimeStatus,
} from "../core/mcp/index.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { errorMessage } from "../utils/errors.ts";
import { keywordScore, tokenize } from "./discoveryMatch.ts";

/** Narrow view of McpController this tool needs (a getter, since it's built after the registry). */
export interface McpRegistrar {
	listServerStatuses(): McpServerRuntimeStatus[];
	listRegistryServers(signal?: AbortSignal): Promise<McpRegistryItem[]>;
	addRegistryServer(
		item: McpRegistryItem,
		signal?: AbortSignal,
		options?: McpAddOptions,
	): Promise<McpAddResult>;
}

/** Where find_mcp saves servers: shared by every window and worktree. */
const USER_CONFIG_LABEL = "~/.backboard/mcp.json";

/**
 * A turn's tool list is fixed when the turn starts, so tools that connect
 * mid-turn are callable from the next turn on.
 */
const NEXT_TURN_NOTE =
	"They are not callable in this turn; they become available from the next turn (the user's next message).";

const schema = z.object({
	task: z
		.string()
		.min(1)
		.describe("A short description of what you're trying to do"),
	server: z
		.string()
		.optional()
		.describe("Add a specific MCP server by title or id instead of ranking"),
});

type Input = z.infer<typeof schema>;

interface Candidate {
	id: string;
	title: string;
	description: string;
	score: number;
	requiredEnv: string[];
}

interface Output {
	task: string;
	added?: string;
	toolNames?: string[];
	candidates: Candidate[];
}

const MAX_CANDIDATES = 6;

/** Ranks the MCP registry against the task, adds the best match behind a confirm gate. */
export class FindMcpTool extends Tool<Input, Output> {
	readonly name = "FindMcp";
	readonly inputSchema = schema;

	constructor(private readonly getController: () => McpRegistrar | undefined) {
		super();
	}

	override prompt(): string {
		return [
			"Find and connect an MCP server that gives you tools for the current task.",
			"Searches the curated MCP registry (matched by title and description) and,",
			"after asking the user for confirmation, saves the best match to the user's",
			`MCP config (${USER_CONFIG_LABEL}) and connects it, then reports the tools it exposes.`,
			"New tools become callable from the next turn, not the current one.",
			"Pass `task` describing what you need; optionally pass `server` to add a",
			"specific server by title. Reach for this when the task needs an external",
			"integration (a database, an API, a SaaS product) you have no tool for.",
		].join(" ");
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override summarizeInput(input: Input): string | undefined {
		return input.server ? `add ${input.server}` : input.task;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const controller = this.getController();
		if (!controller) {
			return ok(
				{ task: input.task, candidates: [] },
				"MCP is not available in this session.",
				"MCP unavailable",
			);
		}

		let servers: McpRegistryItem[];
		try {
			servers = await controller.listRegistryServers(ctx.signal);
		} catch (err) {
			return ok(
				{ task: input.task, candidates: [] },
				`Could not load the MCP registry: ${errorMessage(err)}`,
				"Registry unavailable",
			);
		}

		// Every server this session knows, whatever its state. Only
		// `connected` ones actually provide tools; the rest are reported as-is.
		const installed = new Map(
			controller.listServerStatuses().map((s) => [s.name, s] as const),
		);
		const available = servers.filter(
			(s) => !s.disabledReason && !installed.has(s.id),
		);

		if (input.server) {
			return this.addNamed(
				input,
				servers,
				available,
				installed,
				controller,
				ctx,
			);
		}

		if (available.length === 0) {
			return ok(
				{ task: input.task, candidates: [] },
				"No MCP servers are available to add (every known server is already installed in this session or unavailable).",
				"None available",
			);
		}

		const ranked = rankMcpServers(input.task, available);
		const best = ranked[0];
		if (!best || best.score <= 0) {
			return ok(
				{ task: input.task, candidates: ranked.slice(0, MAX_CANDIDATES) },
				`No MCP server clearly matches "${input.task}". Available servers:\n${listing(available)}\n\n` +
					'Add one explicitly with find_mcp({ server: "<title>" }).',
				"No clear match",
			);
		}

		const item = available.find((s) => s.id === best.id);
		if (!item) {
			return ok(
				{ task: input.task, candidates: ranked.slice(0, MAX_CANDIDATES) },
				`Ranked "${best.title}" but could not resolve it.`,
				"Resolution failed",
			);
		}
		return this.confirmAndAdd(input, item, controller, ctx);
	}

	private async addNamed(
		input: Input,
		servers: McpRegistryItem[],
		available: McpRegistryItem[],
		installed: ReadonlyMap<string, McpServerRuntimeStatus>,
		controller: McpRegistrar,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const target = input.server?.trim().toLowerCase();
		const matchesName = (s: McpRegistryItem) =>
			s.id.toLowerCase() === target || s.title.toLowerCase() === target;
		const item = available.find(matchesName);
		if (item) return this.confirmAndAdd(input, item, controller, ctx);

		// `available` excludes installed and registry-disabled servers, so a
		// named server in either state would otherwise report "not found".
		// `installed` is keyed by server name, which is the registry id.
		const known = servers.find((s) => matchesName(s) && installed.has(s.id));
		const knownStatus = known ? installed.get(known.id) : undefined;
		if (known && knownStatus) {
			return describeInstalled(input.task, known.title, knownStatus);
		}

		const disabled = servers.find((s) => matchesName(s) && s.disabledReason);
		if (disabled) {
			return ok(
				{ task: input.task, candidates: [] },
				`"${disabled.title}" is unavailable: ${disabled.disabledReason}`,
				`"${input.server}" unavailable`,
			);
		}

		const names = available.map((s) => s.title).join(", ") || "(none)";
		return ok(
			{ task: input.task, candidates: [] },
			`No available MCP server named "${input.server}". Available: ${names}.`,
			`"${input.server}" not found`,
		);
	}

	private async confirmAndAdd(
		input: Input,
		item: McpRegistryItem,
		controller: McpRegistrar,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		// Full Access (bypass) skips the confirm: that mode already lets the
		// model edit the user MCP config and run any command, so asking here
		// would only stop the turn without protecting anything.
		const fullAccess = ctx.permissions?.mode === "bypass";
		// Otherwise adding a server needs a human confirm; a sub-agent can't
		// prompt, so surface the candidate instead of throwing on askUser.
		if (!fullAccess && (ctx.agentDepth ?? 0) > 0) {
			return ok(
				{ task: input.task, candidates: [] },
				`Found the "${item.title}" MCP server, but adding it must be confirmed by the user and a sub-agent cannot prompt. Ask the main agent to run find_mcp for this task.`,
				"Confirmation needed",
			);
		}

		const envNote =
			item.requiredEnv.length > 0
				? ` Requires env vars: ${item.requiredEnv.join(", ")} (set them in your MCP config for it to connect).`
				: "";
		const answer = fullAccess
			? "Add"
			: await ctx.askUser(
					`Add and connect the "${item.title}" MCP server? It will be saved to ${USER_CONFIG_LABEL}.${envNote}`,
					["Add", "Cancel"],
				);
		if (answer !== "Add") {
			return ok(
				{ task: input.task, candidates: [] },
				`Skipped adding "${item.title}" (user declined). No server was added.`,
				"Add declined",
			);
		}

		let result: McpAddResult;
		try {
			result = await controller.addRegistryServer(item, ctx.signal, {
				target: "user",
			});
		} catch (err) {
			return ok(
				{ task: input.task, candidates: [] },
				`Failed to add "${item.title}": ${errorMessage(err)}`,
				"Add failed",
			);
		}

		const status = controller
			.listServerStatuses()
			.find((entry) => entry.name === result.name);
		if (result.alreadyInstalled) {
			if (status) return describeInstalled(input.task, item.title, status);
			return ok(
				{ task: input.task, candidates: [] },
				`"${item.title}" is already in ${USER_CONFIG_LABEL} but is not loaded in this session, so its tools are unavailable. Nothing was changed.`,
				"Already installed",
			);
		}

		const warnings =
			result.warnings.length > 0
				? `\nWarnings: ${result.warnings.join("; ")}`
				: "";
		const saved = `Saved the "${item.title}" MCP server to ${USER_CONFIG_LABEL}`;
		const tools = result.toolNames ?? [];
		const data: Output = {
			task: input.task,
			added: item.title,
			toolNames: tools,
			candidates: [],
		};
		const state = status?.status ?? (tools.length > 0 ? "connected" : "error");
		switch (state) {
			case "connected":
				return ok(
					data,
					tools.length > 0
						? `${saved} and connected it. New tools: ${tools.join(", ")}. ${NEXT_TURN_NOTE}${warnings}`
						: `${saved} and connected it, but it exposes no tools.${warnings}`,
					`Added ${item.title}`,
				);
			case "needs_authentication":
				return ok(
					{ ...data, toolNames: [] },
					`${saved}, but it needs authentication before its tools can be used. Ask the user to sign in to it (the MCP servers panel in Backboard, or /mcp in the terminal).${warnings}`,
					`Added ${item.title} (needs auth)`,
				);
			case "connecting":
				return ok(
					{ ...data, toolNames: [] },
					`${saved}; it is still connecting. Once connected, its tools become available from a later turn.${warnings}`,
					`Added ${item.title}`,
				);
			default:
				return ok(
					{ ...data, toolNames: [] },
					`${saved}, but it did not connect${status?.message ? `: ${status.message}` : ""}. Its tools are unavailable.${envNote}${warnings}`,
					`Added ${item.title} (not connected)`,
				);
		}
	}
}

/** Reports a server this session already has, by its real live state. */
function describeInstalled(
	task: string,
	title: string,
	status: McpServerRuntimeStatus,
): ToolResult<Output> {
	const data: Output = { task, candidates: [] };
	switch (status.status) {
		case "connected":
			return ok(
				{ ...data, toolNames: [...status.toolNames] },
				status.toolNames.length > 0
					? `"${title}" is already connected (tools: ${status.toolNames.join(", ")}). If they are not in your tool list, they become available from the next turn.`
					: `"${title}" is already connected but exposes no tools.`,
				"Already connected",
			);
		case "needs_authentication":
			return ok(
				data,
				`"${title}" is installed but needs authentication; its tools are unavailable until the user signs in (the MCP servers panel in Backboard, or /mcp in the terminal).`,
				"Needs authentication",
			);
		case "connecting":
			return ok(
				data,
				`"${title}" is installed and still connecting; its tools are not available yet.`,
				"Connecting",
			);
		case "disabled":
			return ok(
				data,
				`"${title}" is installed but disabled; the user can enable it in their MCP settings.`,
				"Disabled",
			);
		default:
			return ok(
				data,
				`"${title}" is installed but failed to connect${status.message ? `: ${status.message}` : ""}. Its tools are unavailable.`,
				"Connection failed",
			);
	}
}

function listing(items: readonly McpRegistryItem[]): string {
	return items.map((s) => `- ${s.title}: ${s.description}`).join("\n");
}

/** Rank curated MCP servers by task overlap with title (weighted) and description. */
export function rankMcpServers(
	task: string,
	items: readonly McpRegistryItem[],
): Candidate[] {
	const taskTokens = tokenize(task);
	return items
		.map((item) => ({
			id: item.id,
			title: item.title,
			description: item.description,
			requiredEnv: [...item.requiredEnv],
			score: keywordScore(taskTokens, item.title, item.description),
		}))
		.sort((a, b) => b.score - a.score);
}
