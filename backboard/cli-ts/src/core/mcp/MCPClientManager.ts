import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { errorMessage } from "../../utils/errors.ts";
import {
	type McpConfig,
	type McpConfigSource,
	type McpServerConfig,
	type McpServerFileEntry,
	mcpProjectConfigPath,
	normalizeMcpServer,
} from "./config.ts";
import { MCP_CLOSE_TIMEOUT_MS } from "./constants.ts";
import { McpPrimitiveManager } from "./MCPPrimitiveManager.ts";
import type { McpPromptResult } from "./MCPPromptDefinitions.ts";
import type { McpReadResourceResult } from "./MCPResourceDefinitions.ts";
import {
	type McpConnectResult,
	McpServerConnector,
} from "./MCPServerConnector.ts";
import type { McpCachedTool, McpToolCache } from "./MCPToolCache.ts";
import {
	listMcpServerToolDefinitions,
	mcpToolDefinitionChanged,
	uniqueMcpRegisteredName,
} from "./MCPToolDefinitions.ts";
import type {
	McpClientTransport,
	McpConnection,
	McpInitializeResult,
	McpListedToolDefinition,
	McpPromptDefinition,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpServerMutationResult,
	McpServerOrigin,
	McpServerRuntimeStatus,
	McpToolDefinition,
	McpToolRefreshResult,
} from "./MCPTypes.ts";

/** Provenance for one server in a `setServers` push. */
export interface McpServerProvenance {
	origin: McpServerOrigin;
	/**
	 * Files the server is persisted in; terminal-UI disable/remove write
	 * these. Empty for servers owned by the IDE.
	 */
	configSources: McpConfigSource[];
}

export interface McpSetServersOptions {
	/** Default config source for entries without `sources[name]`. */
	configSource?: McpConfigSource;
	/** Per-server origin and config files. */
	sources?: Record<string, McpServerProvenance>;
	/** Reconnect these servers even when their config is unchanged. */
	forceNames?: readonly string[];
	/**
	 * Receives tool changes as they happen: first the tools of closed
	 * servers, then each server's tools as soon as it connects, so fast
	 * servers are usable while slow ones are still connecting. The returned
	 * aggregate repeats the same changes; apply one or the other.
	 */
	onUpdate?: (update: McpToolRefreshResult) => void;
	/** See {@link McpInitializeOptions.onToolsAdvertised}. */
	onToolsAdvertised?: () => void;
}

export interface McpInitializeOptions {
	/**
	 * Receives each server's tools as they become usable. With a tool cache a
	 * server reports twice: its remembered tools at once, then its live list
	 * (`removedToolNames` names the remembered ones that list replaces).
	 */
	onUpdate?: (
		update: McpInitializeResult & { removedToolNames?: string[] },
	) => void;
	/**
	 * Fired once every server has either advertised remembered tools or
	 * finished connecting: from then on a turn's tool list is complete, even
	 * while remembered servers are still connecting.
	 */
	onToolsAdvertised?: () => void;
}

export interface McpClientManagerOptions {
	/** Lets a new process advertise each server's last known tools at once. */
	toolCache?: McpToolCache;
}

export class McpClientManager {
	private readonly connections = new Map<string, McpConnection>();
	private readonly registeredToolNames = new Set<string>();
	private readonly serverConfigs = new Map<string, McpServerConfig>();
	private readonly serverStatuses = new Map<string, McpServerRuntimeStatus>();
	private readonly serverOrigins = new Map<string, McpServerOrigin>();
	private readonly dirtyToolServers = new Set<string>();
	private readonly primitives: McpPrimitiveManager;
	private readonly connector: McpServerConnector;
	private readonly statusListeners = new Set<() => void>();
	private readonly lostToolListeners = new Set<(toolNames: string[]) => void>();
	/** Registered names of remembered tools whose server is still connecting. */
	private readonly provisionalToolNames = new Map<string, string[]>();
	/** Settles when a server's in-flight connect has been applied or dropped. */
	private readonly connectWaits = new Map<string, Promise<void>>();
	private readonly toolCache?: McpToolCache;
	private closed = false;

	constructor(
		private readonly config: McpConfig,
		private readonly cwd: string,
		private readonly closeTimeoutMs = MCP_CLOSE_TIMEOUT_MS,
		options: McpClientManagerOptions = {},
	) {
		this.toolCache = options.toolCache;
		this.primitives = new McpPrimitiveManager({
			connections: this.connections,
			serverStatuses: this.serverStatuses,
		});
		this.connector = new McpServerConnector({
			cwd,
			onToolListChanged: (serverName) => this.dirtyToolServers.add(serverName),
			onPromptListChanged: (serverName) =>
				this.primitives.markPromptListChanged(serverName),
			onResourceListChanged: (serverName) =>
				this.primitives.markResourceListChanged(serverName),
			onResourceUpdated: (serverName, uri) =>
				this.primitives.markResourceUpdated(serverName, uri),
			onConnectionClosed: (serverName, client) =>
				this.handleConnectionClosed(serverName, client),
			onConnectionError: (serverName, client, error) =>
				this.handleConnectionError(serverName, client, error),
		});
		for (const server of config.servers) {
			this.serverConfigs.set(server.name, server);
			this.serverStatuses.set(
				server.name,
				server.disabled
					? statusOf(server, "disabled", "Server is disabled.")
					: statusOf(server, "error", "Not connected."),
			);
		}
	}

	/**
	 * Registers a listener for any change to the server set or a server's
	 * status (connect, fail, auth, disable, remove, unexpected close). Fires
	 * synchronously and often; callers should coalesce.
	 */
	onDidChangeStatus(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	/**
	 * Registers a listener for tools whose server connection closed on its
	 * own. The caller must unregister them from the tool registry.
	 */
	onDidLoseTools(listener: (toolNames: string[]) => void): () => void {
		this.lostToolListeners.add(listener);
		return () => this.lostToolListeners.delete(listener);
	}

	/**
	 * Connects every enabled configured server in parallel. Servers report
	 * `connecting` synchronously (before the first await), so a caller that
	 * does not await can publish that state right away. `onUpdate` receives
	 * each server's tools as soon as it connects.
	 */
	async initialize(
		signal: AbortSignal,
		options: McpInitializeOptions = {},
	): Promise<McpInitializeResult> {
		this.registeredToolNames.clear();
		this.connections.clear();
		this.dirtyToolServers.clear();
		this.provisionalToolNames.clear();
		this.primitives.clear();
		const activeServers = this.config.servers.filter(
			(server) => !server.disabled,
		);
		for (const server of activeServers) {
			this.setStatus(statusOf(server, "connecting", "Connecting…"));
		}
		const seenToolNames = new Set<string>();
		const advertised = advertiseLatch(
			activeServers.length,
			options.onToolsAdvertised,
		);
		const perServer = await Promise.all(
			activeServers.map((server) =>
				this.connectAndRegister(server, signal, seenToolNames, {
					onUpdate: options.onUpdate,
					onAdvertised: advertised,
				}),
			),
		);

		return {
			tools: perServer.flatMap((result) => result.tools),
			warnings: [
				...this.config.warnings,
				...perServer.flatMap((result) => result.warnings),
			],
		};
	}

	/**
	 * Reconciles the live server set with `entries` (name → config). Servers
	 * missing from `entries` are closed and forgotten; new or changed servers
	 * are (re)connected in parallel. Used by the IDE, which owns MCP
	 * configuration for the session and pushes the full set whenever it
	 * changes.
	 *
	 * Returns the tools to register and the tool names the caller must
	 * unregister; unchanged servers keep their live connections (their
	 * provenance is still updated).
	 */
	async setServers(
		entries: Record<string, McpServerFileEntry & { disabled?: boolean }>,
		signal: AbortSignal,
		options: McpSetServersOptions = {},
	): Promise<McpToolRefreshResult> {
		const warnings: string[] = [];
		const closeNames: string[] = [];
		const dropNames: string[] = [];
		const connectPlans: McpServerConfig[] = [];
		const disabledPlans: McpServerConfig[] = [];

		for (const name of this.serverConfigs.keys()) {
			if (!Object.hasOwn(entries, name)) dropNames.push(name);
		}

		for (const [name, entry] of Object.entries(entries)) {
			const existing = this.serverConfigs.get(name);
			const provenance = options.sources?.[name];
			const normalized = normalizeMcpServer(name, entry, {
				timeoutMs: this.config.timeoutMs,
				warnings,
				configSources: provenance?.configSources ?? [
					options.configSource ?? {
						scope: "project",
						path: mcpProjectConfigPath(this.cwd),
					},
				],
			});
			if (!normalized) {
				// An invalid entry replaces nothing: drop the old server.
				if (existing) dropNames.push(name);
				continue;
			}
			if (provenance) this.serverOrigins.set(name, provenance.origin);
			else this.serverOrigins.delete(name);

			// Unchanged servers keep their live connection. Comparing the
			// normalized shape (not the raw entry) avoids reconnects when the
			// IDE re-sends the same set on every sync. `forceNames` reconnects
			// a single server on demand (the IDE's "connect" action).
			if (
				existing &&
				serverConfigEquals(existing, normalized) &&
				!options.forceNames?.includes(name)
			) {
				existing.configSources = normalized.configSources;
				const status = this.serverStatuses.get(name);
				if (status) status.configSources = [...normalized.configSources];
				continue;
			}
			if (existing) closeNames.push(name);
			if (normalized.disabled) disabledPlans.push(normalized);
			else connectPlans.push(normalized);
		}

		const removedToolNames = (
			await Promise.all(
				[...dropNames, ...closeNames].map((name) =>
					this.closeServerConnection(name),
				),
			)
		).flat();
		for (const name of dropNames) {
			this.serverConfigs.delete(name);
			this.serverOrigins.delete(name);
			this.deleteStatus(name);
		}
		if (removedToolNames.length > 0) {
			options.onUpdate?.({ tools: [], removedToolNames, warnings: [] });
		}

		for (const server of disabledPlans) {
			this.serverConfigs.set(server.name, server);
			this.setStatus(statusOf(server, "disabled", "Server is disabled."));
		}
		for (const server of connectPlans) {
			this.serverConfigs.set(server.name, server);
			this.setStatus(statusOf(server, "connecting", "Connecting…"));
		}

		const advertised = advertiseLatch(
			connectPlans.length,
			options.onToolsAdvertised,
		);
		const perServer = await Promise.all(
			connectPlans.map((server) =>
				this.connectAndRegister(server, signal, this.registeredToolNames, {
					onUpdate: options.onUpdate,
					onAdvertised: advertised,
				}),
			),
		);

		return {
			tools: perServer.flatMap((result) => result.tools),
			removedToolNames,
			warnings: [
				...warnings,
				...perServer.flatMap((result) => result.warnings),
			],
		};
	}

	async addServer(
		name: string,
		entry: McpServerFileEntry,
		signal: AbortSignal,
		options: {
			configSources?: McpConfigSource[];
			origin?: McpServerOrigin;
		} = {},
	): Promise<McpInitializeResult> {
		if (this.connections.has(name)) {
			return {
				tools: [],
				warnings: [`Skipped MCP server '${name}': already connected.`],
			};
		}

		const warnings: string[] = [];
		const server = normalizeMcpServer(name, entry, {
			timeoutMs: this.config.timeoutMs,
			warnings,
			configSources: options.configSources ?? [
				{ scope: "project", path: mcpProjectConfigPath(this.cwd) },
			],
		});
		if (!server) return { tools: [], warnings };
		this.serverConfigs.set(server.name, server);
		if (options.origin) this.serverOrigins.set(server.name, options.origin);
		else this.serverOrigins.delete(server.name);
		if (server.disabled) {
			this.setStatus(statusOf(server, "disabled", "Server is disabled."));
			return {
				tools: [],
				warnings: [`Skipped MCP server '${name}': server is disabled.`],
			};
		}

		this.setStatus(statusOf(server, "connecting", "Connecting…"));
		const result = await this.connector.connect(server, signal, {
			interactiveAuth: false,
		});
		warnings.push(...result.warnings);
		if (!(await this.acceptConnectResult(server, result))) {
			return { tools: [], warnings };
		}
		return {
			tools: this.withRegisteredNames(
				result.tools,
				this.registeredToolNames,
				warnings,
			),
			warnings,
		};
	}

	/**
	 * Reconnects `name` with interactive OAuth: opens the system browser and
	 * waits for the loopback callback. The status reads `connecting` while
	 * the sign-in is pending.
	 */
	async authenticateServer(
		name: string,
		signal: AbortSignal,
	): Promise<McpInitializeResult> {
		const server = this.serverConfigs.get(name);
		if (!server) {
			return {
				tools: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}
		if (this.connections.has(name)) await this.closeServerConnection(name);

		this.setStatus(
			statusOf(server, "connecting", "Waiting for sign-in in the browser…"),
		);
		const result = await this.connector.connect(server, signal, {
			interactiveAuth: true,
		});
		if (!(await this.acceptConnectResult(server, result))) {
			return { tools: [], warnings: result.warnings };
		}
		return {
			tools: this.withRegisteredNames(
				result.tools,
				this.registeredToolNames,
				result.warnings,
			),
			warnings: result.warnings,
		};
	}

	async disableServer(name: string): Promise<McpServerMutationResult> {
		const server = this.serverConfigs.get(name);
		const status = this.serverStatuses.get(name);
		if (!server && !status) {
			return {
				toolNames: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}

		const toolNames = await this.closeServerConnection(name);
		if (server) {
			this.serverConfigs.set(name, { ...server, disabled: true });
		}
		this.setStatus({
			name,
			type: (server ?? status)?.type ?? "stdio",
			configSources: [...((server ?? status)?.configSources ?? [])],
			status: "disabled",
			message: "Server is disabled.",
			toolNames: [],
			capabilities: {},
			promptNames: [],
			resourceUris: [],
			updatedResourceUris: [],
			subscribedResourceUris: [],
		});
		return { toolNames, warnings: [] };
	}

	async removeServer(name: string): Promise<McpServerMutationResult> {
		if (!this.serverConfigs.has(name) && !this.serverStatuses.has(name)) {
			return {
				toolNames: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}

		const toolNames = await this.closeServerConnection(name);
		this.serverConfigs.delete(name);
		this.serverOrigins.delete(name);
		this.deleteStatus(name);
		return { toolNames, warnings: [] };
	}

	async refreshTools(signal: AbortSignal): Promise<McpToolRefreshResult> {
		const tools: McpToolDefinition[] = [];
		const removedToolNames: string[] = [];
		const warnings: string[] = [];
		const dirtyServers = [...this.dirtyToolServers];
		this.dirtyToolServers.clear();

		for (const serverName of dirtyServers) {
			const connection = this.connections.get(serverName);
			if (!connection) continue;
			let latest: McpListedToolDefinition[];
			try {
				latest = await listMcpServerToolDefinitions(
					connection.server,
					connection.client,
					signal,
				);
			} catch (err) {
				warnings.push(
					`Failed to refresh MCP server '${connection.server.name}': ${errorMessage(err)}.`,
				);
				this.dirtyToolServers.add(connection.server.name);
				continue;
			}

			const latestByToolName = new Map(
				latest.map((tool) => [tool.toolName, tool]),
			);
			const changed: McpListedToolDefinition[] = [];
			const changedToolNames = new Set<string>();

			for (const [toolName, existing] of [...connection.tools]) {
				const next = latestByToolName.get(toolName);
				if (!next || mcpToolDefinitionChanged(existing, next)) {
					const removed = this.unregisterConnectionTool(connection, toolName);
					if (removed) removedToolNames.push(removed);
				}
				if (next && mcpToolDefinitionChanged(existing, next)) {
					changed.push(next);
					changedToolNames.add(toolName);
				}
			}

			for (const tool of latest) {
				if (
					!connection.tools.has(tool.toolName) &&
					!changedToolNames.has(tool.toolName)
				) {
					changed.push(tool);
				}
			}

			tools.push(
				...this.withRegisteredNames(
					changed,
					this.registeredToolNames,
					warnings,
				),
			);
		}

		return {
			tools,
			removedToolNames,
			warnings,
		};
	}

	listPrompts(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpPromptDefinition[]> {
		return this.primitives.listPrompts(serverName, signal);
	}

	getPrompt(
		serverName: string,
		name: string,
		args: Record<string, string> | undefined,
		signal: AbortSignal,
	): Promise<McpPromptResult> {
		return this.primitives.getPrompt(serverName, name, args, signal);
	}

	refreshPrompts(signal: AbortSignal) {
		return this.primitives.refreshPrompts(signal);
	}

	listResources(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceDefinition[]> {
		return this.primitives.listResources(serverName, signal);
	}

	listResourceTemplates(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceTemplateDefinition[]> {
		return this.primitives.listResourceTemplates(serverName, signal);
	}

	readResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<McpReadResourceResult> {
		return this.primitives.readResource(serverName, uri, signal);
	}

	subscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		return this.primitives.subscribeResource(serverName, uri, signal);
	}

	unsubscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		return this.primitives.unsubscribeResource(serverName, uri, signal);
	}

	refreshResources(signal: AbortSignal) {
		return this.primitives.refreshResources(signal);
	}

	listServerStatuses(): McpServerRuntimeStatus[] {
		return [...this.serverStatuses.values()].map((status) => ({
			...status,
			source:
				this.serverOrigins.get(status.name) ??
				status.configSources.at(-1)?.scope ??
				"project",
			configSources: status.configSources.map((source) => ({ ...source })),
			toolNames: [...status.toolNames],
			capabilities: { ...(status.capabilities ?? {}) },
			promptNames: [...(status.promptNames ?? [])],
			resourceUris: [...(status.resourceUris ?? [])],
			updatedResourceUris: [...(status.updatedResourceUris ?? [])],
			subscribedResourceUris: [...(status.subscribedResourceUris ?? [])],
		}));
	}

	async close(): Promise<void> {
		this.closed = true;
		const connections = [...this.connections.values()];
		this.connections.clear();
		this.registeredToolNames.clear();
		this.provisionalToolNames.clear();
		this.dirtyToolServers.clear();
		this.primitives.clear();
		await Promise.allSettled(
			connections.map(async ({ transport }) => {
				await closeTransport(transport, this.closeTimeoutMs);
			}),
		);
	}

	private async closeServerConnection(name: string): Promise<string[]> {
		const status = this.serverStatuses.get(name);
		const toolNames = [
			...(status?.toolNames ?? []),
			...this.releaseProvisionalTools(name, this.registeredToolNames),
		];
		for (const toolName of toolNames) {
			this.registeredToolNames.delete(toolName);
		}
		const connection = this.connections.get(name);
		if (connection) {
			this.connections.delete(name);
			this.dirtyToolServers.delete(name);
			this.primitives.clearServer(name);
			await connection.transport.close().catch(() => undefined);
		}
		return toolNames;
	}

	private unregisterConnectionTool(
		connection: McpConnection,
		toolName: string,
	): string {
		const existing = connection.tools.get(toolName);
		if (!existing) return "";
		connection.tools.delete(toolName);
		this.registeredToolNames.delete(existing.registeredName);
		const status = this.serverStatuses.get(connection.server.name);
		if (status) {
			status.toolNames = status.toolNames.filter(
				(name) => name !== existing.registeredName,
			);
		}
		return existing.registeredName;
	}

	/**
	 * Connects one server and reports its tools. With a tool cache, the tools
	 * the server listed last time are reported first, under the names they
	 * will keep, and a call made before the connection is up waits for it.
	 */
	private async connectAndRegister(
		server: McpServerConfig,
		signal: AbortSignal,
		seenToolNames: Set<string>,
		hooks: {
			onUpdate?: (update: McpToolRefreshResult) => void;
			onAdvertised: () => void;
		},
	): Promise<McpToolRefreshResult> {
		let settle = () => {};
		const wait = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.connectWaits.set(server.name, wait);
		let advertised = false;
		const advertise = () => {
			if (advertised) return;
			advertised = true;
			hooks.onAdvertised();
		};
		try {
			const connecting = this.connector.connect(server, signal, {
				interactiveAuth: false,
			});
			const remembered = await this.toolCache?.read(server);
			if (remembered && this.serverConfigs.get(server.name) === server) {
				const provisional = this.withRegisteredNames(
					remembered.map((tool) => this.provisionalTool(server, tool)),
					seenToolNames,
					[],
				);
				this.provisionalToolNames.set(
					server.name,
					provisional.map((tool) => tool.registeredName),
				);
				if (provisional.length > 0) {
					hooks.onUpdate?.({
						tools: provisional,
						removedToolNames: [],
						warnings: [],
					});
				}
				advertise();
			}

			const result = await connecting;
			const warnings = [...result.warnings];
			const current = this.serverConfigs.get(server.name) === server;
			// A replaced or removed server already had its remembered tools
			// released by whoever replaced it.
			const removedToolNames = current
				? this.releaseProvisionalTools(server.name, seenToolNames)
				: [];
			if (!(await this.acceptConnectResult(server, result))) {
				if (removedToolNames.length > 0) {
					hooks.onUpdate?.({ tools: [], removedToolNames, warnings: [] });
				}
				return { tools: [], removedToolNames, warnings };
			}
			const tools = this.withRegisteredNames(
				result.tools,
				seenToolNames,
				warnings,
			);
			if (tools.length > 0 || removedToolNames.length > 0) {
				hooks.onUpdate?.({ tools, removedToolNames, warnings });
			}
			// After the tools are usable, so the disk never delays them. A connect
			// cut short by shutdown says nothing about the server, so its
			// remembered tools stay.
			if (result.connection) {
				await this.toolCache?.write(server, result.tools);
			} else if (!signal.aborted && !this.closed) {
				await this.toolCache?.delete(server);
			}
			return { tools, removedToolNames, warnings };
		} finally {
			if (this.connectWaits.get(server.name) === wait) {
				this.connectWaits.delete(server.name);
			}
			settle();
			advertise();
		}
	}

	private provisionalTool(
		server: McpServerConfig,
		tool: McpCachedTool,
	): McpListedToolDefinition {
		return {
			serverName: server.name,
			toolName: tool.toolName,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			trustAnnotations: server.trustToolAnnotations,
			timeoutMs: server.timeoutMs,
			call: async (input, ctx) => {
				const client = await this.clientWhenConnected(server, ctx.signal);
				return client.callTool(
					{ name: tool.toolName, arguments: input },
					undefined,
					{ signal: ctx.signal, timeout: server.timeoutMs },
				);
			},
		};
	}

	private async clientWhenConnected(
		server: McpServerConfig,
		signal: AbortSignal,
	): Promise<Client> {
		const wait = this.connectWaits.get(server.name);
		if (wait && !this.connections.has(server.name)) {
			await abortable(wait, signal);
		}
		const connection = this.connections.get(server.name);
		if (!connection) {
			const reason = this.serverStatuses.get(server.name)?.message;
			throw new Error(
				`MCP server '${server.name}' is not connected${reason ? `: ${reason}` : "."}`,
			);
		}
		return connection.client;
	}

	private releaseProvisionalTools(
		serverName: string,
		seenToolNames: Set<string>,
	): string[] {
		const names = this.provisionalToolNames.get(serverName) ?? [];
		this.provisionalToolNames.delete(serverName);
		for (const name of names) {
			seenToolNames.delete(name);
			this.registeredToolNames.delete(name);
		}
		return names;
	}

	/**
	 * Installs a connect result unless it went stale while connecting (the
	 * server was replaced or removed, or the manager closed); a stale
	 * connection is closed instead. Returns whether it was installed.
	 */
	private async acceptConnectResult(
		server: McpServerConfig,
		result: McpConnectResult,
	): Promise<boolean> {
		if (this.closed || this.serverConfigs.get(server.name) !== server) {
			await result.connection?.transport.close().catch(() => undefined);
			return false;
		}
		this.applyConnectResult(result);
		return true;
	}

	private applyConnectResult(result: McpConnectResult): void {
		if (result.connection) {
			this.connections.set(result.connection.server.name, result.connection);
		}
		this.setStatus(result.status);
	}

	private setStatus(status: McpServerRuntimeStatus): void {
		this.serverStatuses.set(status.name, status);
		this.notifyStatus();
	}

	private deleteStatus(name: string): void {
		if (this.serverStatuses.delete(name)) this.notifyStatus();
	}

	private notifyStatus(): void {
		for (const listener of this.statusListeners) listener();
	}

	private handleConnectionClosed(name: string, client: Client): void {
		const connection = this.connections.get(name);
		if (!connection || connection.client !== client) return;
		const toolNames = [...(this.serverStatuses.get(name)?.toolNames ?? [])];
		for (const toolName of toolNames) this.registeredToolNames.delete(toolName);
		this.connections.delete(name);
		this.dirtyToolServers.delete(name);
		this.primitives.clearServer(name);
		void connection.transport.close().catch(() => undefined);
		this.setStatus(
			statusOf(
				this.serverConfigs.get(name) ?? connection.server,
				"error",
				"Connection closed.",
			),
		);
		if (toolNames.length === 0) return;
		for (const listener of this.lostToolListeners) listener(toolNames);
	}

	private handleConnectionError(
		name: string,
		client: Client,
		error: Error,
	): void {
		if (this.connections.get(name)?.client !== client) return;
		const status = this.serverStatuses.get(name);
		if (!status) return;
		status.message = errorMessage(error);
		this.notifyStatus();
	}

	private withRegisteredNames(
		tools: readonly McpListedToolDefinition[],
		seenToolNames: Set<string>,
		warnings: string[],
	): McpToolDefinition[] {
		const registered: McpToolDefinition[] = [];
		for (const tool of tools) {
			const registeredName = uniqueMcpRegisteredName(
				tool.serverName,
				tool.toolName,
				seenToolNames,
				warnings,
			);
			if (!registeredName) continue;
			seenToolNames.add(registeredName);
			this.registeredToolNames.add(registeredName);
			const definition = { ...tool, registeredName };
			registered.push(definition);
			this.connections
				.get(tool.serverName)
				?.tools.set(tool.toolName, definition);
			const status = this.serverStatuses.get(tool.serverName);
			if (status?.status === "connected") {
				status.toolNames.push(registeredName);
			}
		}
		if (registered.length > 0) this.notifyStatus();
		return registered;
	}
}

/** Calls `done` once `count` servers have reported; at once when there are none. */
function advertiseLatch(count: number, done?: () => void): () => void {
	let remaining = count;
	if (remaining === 0) done?.();
	return () => {
		remaining--;
		if (remaining === 0) done?.();
	};
}

async function abortable(
	work: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Compares two normalized server configs for everything that affects the live
 * connection. `setServers` uses this to keep unchanged servers connected when
 * the IDE re-sends its full set.
 */
function serverConfigEquals(a: McpServerConfig, b: McpServerConfig): boolean {
	if (a.type !== b.type || a.disabled !== b.disabled) return false;
	if (a.command !== b.command || a.url !== b.url) return false;
	if (a.cwd !== b.cwd) return false;
	if (a.timeoutMs !== b.timeoutMs) return false;
	if (a.trustToolAnnotations !== b.trustToolAnnotations) return false;
	return (
		recordEquals(a.env, b.env) &&
		recordEquals(a.headers, b.headers) &&
		arrayEquals(a.args, b.args) &&
		optionalArrayEquals(a.enabledTools, b.enabledTools) &&
		arrayEquals(a.disabledTools, b.disabledTools) &&
		optionalArrayEquals(a.enabledPrompts, b.enabledPrompts) &&
		arrayEquals(a.disabledPrompts, b.disabledPrompts) &&
		optionalArrayEquals(a.enabledResources, b.enabledResources) &&
		arrayEquals(a.disabledResources, b.disabledResources)
	);
}

function optionalArrayEquals(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return arrayEquals(a, b);
}

function statusOf(
	server: Pick<McpServerConfig, "name" | "type" | "configSources">,
	status: McpServerRuntimeStatus["status"],
	message: string,
): McpServerRuntimeStatus {
	return {
		name: server.name,
		type: server.type,
		configSources: server.configSources.map((source) => ({ ...source })),
		status,
		message,
		toolNames: [],
		capabilities: {},
		promptNames: [],
		resourceUris: [],
		updatedResourceUris: [],
		subscribedResourceUris: [],
	};
}

function recordEquals(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => a[key] === b[key]);
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function closeTransport(
	transport: McpClientTransport,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			transport.close(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
