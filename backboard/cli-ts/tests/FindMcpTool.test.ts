import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type {
	McpAddOptions,
	McpAddResult,
	McpRegistryItem,
	McpServerRuntimeStatus,
} from "../src/core/mcp/index.ts";
import type { PermissionMode } from "../src/core/permissions/index.ts";
import { parseRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import {
	FindMcpTool,
	type McpRegistrar,
	rankMcpServers,
} from "../src/tools/FindMcpTool.tsx";

function server(
	id: string,
	title: string,
	description: string,
	opts: { requiredEnv?: string[]; disabledReason?: string } = {},
): McpRegistryItem {
	return {
		id,
		title,
		category: "Development & Testing",
		description,
		detail: "",
		requiredEnv: opts.requiredEnv ?? [],
		...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
	};
}

type FakeState = McpServerRuntimeStatus["status"];

class FakeMcp implements McpRegistrar {
	added: string[] = [];
	addOptions: (McpAddOptions | undefined)[] = [];
	readonly statuses = new Map<string, McpServerRuntimeStatus>();
	/** State the fake reports for a server right after it is added. */
	stateAfterAdd: FakeState = "connected";
	alreadyInstalled = false;

	constructor(
		public servers: McpRegistryItem[],
		active: string[] | Record<string, FakeState> = [],
	) {
		const entries = Array.isArray(active)
			? active.map((name) => [name, "connected" as FakeState] as const)
			: Object.entries(active);
		for (const [name, state] of entries) this.setStatus(name, state);
	}

	setStatus(name: string, status: FakeState, toolNames: string[] = []): void {
		this.statuses.set(name, {
			name,
			type: "http",
			configSources: [],
			status,
			message: status === "error" ? "connect ECONNREFUSED" : undefined,
			toolNames: status === "connected" ? toolNames : [],
		});
	}

	listServerStatuses(): McpServerRuntimeStatus[] {
		return [...this.statuses.values()];
	}
	async listRegistryServers(): Promise<McpRegistryItem[]> {
		return this.servers;
	}
	async addRegistryServer(
		item: McpRegistryItem,
		_signal?: AbortSignal,
		options?: McpAddOptions,
	): Promise<McpAddResult> {
		this.added.push(item.id);
		this.addOptions.push(options);
		if (this.alreadyInstalled) {
			return {
				name: item.id,
				title: item.title,
				requiredEnv: [],
				toolNames: [],
				warnings: [],
				alreadyInstalled: true,
			};
		}
		const toolNames =
			this.stateAfterAdd === "connected" ? [`${item.id}__query`] : [];
		this.setStatus(item.id, this.stateAfterAdd, toolNames);
		return {
			name: item.id,
			title: item.title,
			requiredEnv: [...item.requiredEnv],
			toolNames,
			warnings: [],
		};
	}
}

function ctx(answer = "Add", depth = 0): ToolContext {
	return {
		sessionId: "t",
		cwd: "/tmp",
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => answer,
		agentDepth: depth,
	};
}

/** A context whose prompt fails the test if it is ever shown. */
function silentCtx(mode: PermissionMode, depth = 0): ToolContext {
	return {
		...ctx("Cancel", depth),
		askUser: async (question) => {
			throw new Error(`unexpected prompt: ${question}`);
		},
		permissions: {
			mode,
			rules: parseRuleSet({}),
			interactive: depth === 0,
		},
	};
}

describe("rankMcpServers", () => {
	it("ranks by title/description overlap", () => {
		const ranked = rankMcpServers("query a postgres database", [
			server("linear", "Linear", "Track issues and projects"),
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		expect(ranked[0]?.id).toBe("postgres");
	});
});

describe("FindMcpTool", () => {
	it("adds the best server after confirmation", async () => {
		const fake = new FakeMcp([
			server("linear", "Linear", "Track issues and projects"),
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "query a postgres database" },
			ctx("Add"),
		);
		expect(fake.added).toEqual(["postgres"]);
		expect(fake.addOptions).toEqual([{ target: "user" }]);
		expect(res.data.added).toBe("Postgres");
		expect(res.forLLM).toContain("postgres__query");
		expect(res.forLLM).toContain("~/.backboard/mcp.json");
		// The turn's tool list is frozen, so the result must not promise the
		// tools right now.
		expect(res.forLLM).toContain("not callable in this turn");
	});

	it("reports an added server that needs authentication instead of claiming tools", async () => {
		const fake = new FakeMcp([
			server("linear", "Linear", "Track issues and projects"),
		]);
		fake.stateAfterAdd = "needs_authentication";
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "track issues", server: "Linear" },
			ctx("Add"),
		);
		expect(res.data.toolNames).toEqual([]);
		expect(res.forLLM).toContain("needs authentication");
		expect(res.forLLM).not.toContain("connected it");
	});

	it("treats a server already in the user file as installed", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		fake.alreadyInstalled = true;
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(res.data.added).toBeUndefined();
		expect(res.forLLM).toContain("already in ~/.backboard/mcp.json");
	});

	it("does not add when declined", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres database" },
			ctx("Cancel"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("declined");
	});

	it("skips already-connected servers", async () => {
		const fake = new FakeMcp(
			[server("postgres", "Postgres", "Query a Postgres database")],
			["postgres"],
		);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute({ task: "postgres database" }, ctx("Add"));
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("No MCP servers are available");
	});

	it("reports a named server that is already connected", async () => {
		const fake = new FakeMcp(
			[
				server("postgres", "Postgres", "Query a Postgres database"),
				server("linear", "Linear", "Track issues and projects"),
			],
			["postgres"],
		);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("already connected");
	});

	it("only counts connected servers as active", async () => {
		const fake = new FakeMcp(
			[
				server("postgres", "Postgres", "Query a Postgres database"),
				server("linear", "Linear", "Track issues and projects"),
				server("github", "GitHub", "Repos and pull requests"),
			],
			{ postgres: "error", linear: "needs_authentication", github: "disabled" },
		);
		const tool = new FindMcpTool(() => fake);
		const failed = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(failed.forLLM).toContain("failed to connect: connect ECONNREFUSED");
		expect(failed.forLLM).not.toContain("already connected");
		const auth = await tool.execute(
			{ task: "issues", server: "Linear" },
			ctx("Add"),
		);
		expect(auth.forLLM).toContain("needs authentication");
		const disabled = await tool.execute(
			{ task: "repos", server: "GitHub" },
			ctx("Add"),
		);
		expect(disabled.forLLM).toContain("disabled");
		expect(fake.added).toEqual([]);
	});

	it("surfaces the disabled reason for a named disabled server", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database", {
				disabledReason: "requires PG_URL",
			}),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "postgres", server: "Postgres" },
			ctx("Add"),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("requires PG_URL");
	});

	it("reports unavailable when no controller is present", async () => {
		const tool = new FindMcpTool(() => undefined);
		const res = await tool.execute({ task: "anything" }, ctx());
		expect(res.forLLM).toContain("MCP is not available");
	});

	it("never adds from a sub-agent (cannot confirm)", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "query a postgres database" },
			ctx("Add", 1),
		);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("sub-agent cannot prompt");
	});

	it("adds without a confirm under Full Access (bypass)", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const res = await tool.execute(
			{ task: "query a postgres database" },
			silentCtx("bypass"),
		);
		expect(fake.added).toEqual(["postgres"]);
		expect(res.data.added).toBe("Postgres");
	});

	it("adds from a sub-agent under Full Access (no prompt is needed)", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		await tool.execute(
			{ task: "query a postgres database" },
			silentCtx("bypass", 1),
		);
		expect(fake.added).toEqual(["postgres"]);
	});

	it("still asks under Approve for me (auto)", async () => {
		const fake = new FakeMcp([
			server("postgres", "Postgres", "Query a Postgres database"),
		]);
		const tool = new FindMcpTool(() => fake);
		const questions: string[] = [];
		const res = await tool.execute(
			{ task: "query a postgres database" },
			{
				...silentCtx("auto"),
				askUser: async (question) => {
					questions.push(question);
					return "Cancel";
				},
			},
		);
		expect(questions).toHaveLength(1);
		expect(fake.added).toEqual([]);
		expect(res.forLLM).toContain("declined");
	});
});
