import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	McpClientManager,
	type McpServerConfig,
	McpToolCache,
	McpToolRegistrar,
} from "../src/core/mcp/index.ts";
import type { McpConnectResult } from "../src/core/mcp/MCPServerConnector.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { McpWorkQueue } from "../src/entrypoints/serveMcp.ts";
import { makeContext } from "./helpers.ts";

function serverConfig(
	overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
	return {
		name: "docs",
		type: "http",
		disabled: false,
		configSources: [],
		args: [],
		env: {},
		url: "https://docs.example.com/mcp",
		headers: {},
		disabledTools: [],
		disabledPrompts: [],
		disabledResources: [],
		trustToolAnnotations: false,
		timeoutMs: 1_000,
		...overrides,
	};
}

function connected(
	server: McpServerConfig,
	toolNames: string[],
	calls: string[],
): McpConnectResult {
	const client = {
		callTool: async (request: { name: string }) => {
			calls.push(`live:${request.name}`);
			return { content: [{ type: "text", text: "live" }] };
		},
	} as unknown as Client;
	return {
		connection: {
			server,
			client,
			transport: { close: async () => undefined } as never,
			tools: new Map(),
			prompts: new Map(),
			resources: new Map(),
			updatedResourceUris: new Set(),
			subscribedResourceUris: new Set(),
			capabilities: { tools: {} },
		},
		tools: toolNames.map((toolName) => ({
			serverName: server.name,
			toolName,
			description: `${toolName} description`,
			inputSchema: { type: "object" },
			trustAnnotations: false,
			timeoutMs: 1_000,
			call: async () => client.callTool({ name: toolName, arguments: {} }),
		})),
		status: {
			name: server.name,
			type: server.type,
			configSources: [],
			status: "connected",
			toolNames: [],
			capabilities: { tools: {} },
			promptNames: [],
			resourceUris: [],
			updatedResourceUris: [],
			subscribedResourceUris: [],
		},
		warnings: [],
	};
}

function failed(server: McpServerConfig): McpConnectResult {
	return {
		tools: [],
		status: {
			name: server.name,
			type: server.type,
			configSources: [],
			status: "error",
			message: "spawn failed",
			toolNames: [],
			capabilities: {},
			promptNames: [],
			resourceUris: [],
			updatedResourceUris: [],
			subscribedResourceUris: [],
		},
		warnings: [`Skipped MCP server '${server.name}': spawn failed.`],
	};
}

async function fixture(
	connect: (server: McpServerConfig) => Promise<McpConnectResult>,
) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-tool-cache-"));
	const server = serverConfig();
	const cache = new McpToolCache(path.join(directory, "cache"));
	const manager = new McpClientManager(
		{ timeoutMs: 1_000, servers: [server], warnings: [] },
		directory,
		undefined,
		{ toolCache: cache },
	);
	Object.assign(manager as unknown as { connector: unknown }, {
		connector: { connect },
	});
	const registry = new ToolRegistry();
	const registrar = new McpToolRegistrar(registry, new EventBus());
	return { server, cache, manager, registry, registrar };
}

describe("McpToolCache", () => {
	it("keys remembered tools by everything that shapes the connection", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-tool-cache-"));
		const cache = new McpToolCache(directory);
		const server = serverConfig({ env: { TOKEN: "one" } });
		await cache.write(server, connected(server, ["search"], []).tools);

		expect({
			same: (await cache.read(server))?.map((tool) => tool.toolName),
			reordered: (
				await cache.read(serverConfig({ env: { TOKEN: "one" } }))
			)?.map((tool) => tool.toolName),
			changedEnv: await cache.read(serverConfig({ env: { TOKEN: "two" } })),
			changedFilter: await cache.read(
				serverConfig({ env: { TOKEN: "one" }, disabledTools: ["search"] }),
			),
		}).toEqual({
			same: ["search"],
			reordered: ["search"],
			changedEnv: undefined,
			changedFilter: undefined,
		});
	});

	it("advertises remembered tools before the server connects and swaps in the live list", async () => {
		const calls: string[] = [];
		let finishConnect = (_result: McpConnectResult) => {};
		const { server, cache, manager, registry, registrar } = await fixture(
			() =>
				new Promise<McpConnectResult>((resolve) => {
					finishConnect = resolve;
				}),
		);
		await cache.write(
			server,
			connected(server, ["search", "retired"], []).tools,
		);

		const queue = new McpWorkQueue();
		const work = queue.run(
			(releaseTurns) =>
				manager.initialize(new AbortController().signal, {
					onUpdate: (update) =>
						registrar.applyRefresh({
							tools: update.tools,
							removedToolNames: update.removedToolNames ?? [],
							warnings: [],
						}),
					onToolsAdvertised: releaseTurns,
				}),
			{ blocksTurns: true },
		);
		// The turn is released while the server is still connecting.
		await queue.turnBarrier;
		const whileConnecting = registry
			.list()
			.map((tool) => tool.agentName)
			.sort();
		const early = registry
			.get("mcp__docs__search")
			?.execute({}, makeContext(new AbortController().signal));
		finishConnect(connected(server, ["search", "added"], calls));
		await work;
		await early;

		expect({
			whileConnecting,
			afterConnect: registry
				.list()
				.map((tool) => tool.agentName)
				.sort(),
			calls,
			remembered: (await cache.read(server))?.map((tool) => tool.toolName),
		}).toEqual({
			whileConnecting: ["mcp__docs__retired", "mcp__docs__search"],
			afterConnect: ["mcp__docs__added", "mcp__docs__search"],
			calls: ["live:search"],
			remembered: ["search", "added"],
		});
	});

	it("withdraws remembered tools and forgets them when the server fails to connect", async () => {
		const { server, cache, manager, registry, registrar } = await fixture(
			async (config) => failed(config),
		);
		await cache.write(server, connected(server, ["search"], []).tools);

		await manager.initialize(new AbortController().signal, {
			onUpdate: (update) =>
				registrar.applyRefresh({
					tools: update.tools,
					removedToolNames: update.removedToolNames ?? [],
					warnings: [],
				}),
		});

		expect({
			tools: registry.list().map((tool) => tool.agentName),
			remembered: await cache.read(server),
		}).toEqual({ tools: [], remembered: undefined });
	});

	it("keeps remembered tools when shutdown cuts the connect short", async () => {
		const { server, cache, manager } = await fixture(async (config) =>
			failed(config),
		);
		await cache.write(server, connected(server, ["search"], []).tools);
		const shutdown = new AbortController();
		shutdown.abort();

		await manager.initialize(shutdown.signal);

		expect((await cache.read(server))?.map((tool) => tool.toolName)).toEqual([
			"search",
		]);
	});

	it("holds the turn for a server with no remembered tools", async () => {
		let finishConnect = (_result: McpConnectResult) => {};
		const { server, manager } = await fixture(
			() =>
				new Promise<McpConnectResult>((resolve) => {
					finishConnect = resolve;
				}),
		);
		let advertised = false;
		const work = manager.initialize(new AbortController().signal, {
			onToolsAdvertised: () => {
				advertised = true;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const beforeConnect = advertised;
		finishConnect(connected(server, ["search"], []));
		await work;

		expect({ beforeConnect, afterConnect: advertised }).toEqual({
			beforeConnect: false,
			afterConnect: true,
		});
	});
});
