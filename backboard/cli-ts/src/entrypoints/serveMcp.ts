import {
	loadMcpConfig,
	type McpConfigPaths,
	type McpConfigSource,
	type McpServerFileEntry,
	type McpServerProvenance,
	type McpServerRuntimeStatus,
	mcpConfigToFileEntry,
} from "../core/mcp/index.ts";

/**
 * MCP plumbing for `serve` mode: how an IDE push is layered over the config
 * files, the queue that keeps MCP reconfiguration from interleaving, the turn
 * wait, and the coalesced `serve:mcp` status stream.
 */

export type ServeMcpEntry = McpServerFileEntry & { disabled?: boolean };

/** Payload of every `serve:mcp` record, solicited (reply) or not. */
export interface ServeMcpPayload {
	/** Every server the runtime knows, in any state. */
	servers: McpServerRuntimeStatus[];
	warnings?: string[];
}

/** A server added by find_mcp in this process (saved to the user file). */
export interface ServeRuntimeMcpServer {
	entry: ServeMcpEntry;
	configSources: McpConfigSource[];
}

export interface ResolveMcpServerSetOptions {
	cwd: string;
	paths: McpConfigPaths;
	/** The IDE's `setMcpServers.servers`. */
	pushed: Record<string, ServeMcpEntry>;
	/**
	 * The IDE imports and owns the user file, so it is not layered: a server
	 * the user disabled or removed in the IDE must not come back from it.
	 */
	authoritative: boolean;
	runtime: ReadonlyMap<string, ServeRuntimeMcpServer>;
	load?: typeof loadMcpConfig;
}

export interface ResolvedMcpServerSet {
	entries: Record<string, ServeMcpEntry>;
	sources: Record<string, McpServerProvenance>;
}

/**
 * Builds the full server set for `McpClientManager.setServers`, lowest
 * precedence first: config files (only the project file when
 * `authoritative`), servers find_mcp added in this process, then the IDE
 * push. Disabled file servers are kept (as disabled) so every server shows
 * up in status.
 */
export async function resolveMcpServerSet(
	options: ResolveMcpServerSetOptions,
): Promise<ResolvedMcpServerSet> {
	const load = options.load ?? loadMcpConfig;
	const configured = await load({
		cwd: options.cwd,
		paths: options.paths,
		...(options.authoritative ? { scopes: ["project"] as const } : {}),
	});
	const entries: Record<string, ServeMcpEntry> = {};
	const sources: Record<string, McpServerProvenance> = {};
	for (const server of configured.servers) {
		entries[server.name] = mcpConfigToFileEntry(server);
		sources[server.name] = {
			origin: server.configSources.at(-1)?.scope ?? "project",
			configSources: server.configSources.map((source) => ({ ...source })),
		};
	}
	for (const [name, server] of options.runtime) {
		entries[name] = server.entry;
		sources[name] = {
			origin: "runtime",
			configSources: server.configSources.map((source) => ({ ...source })),
		};
	}
	for (const [name, entry] of Object.entries(options.pushed)) {
		entries[name] = entry;
		// The IDE persists its own servers; there is no file here to edit.
		sources[name] = { origin: "ide", configSources: [] };
	}
	return { entries, sources };
}

/**
 * Serializes MCP reconfiguration (initial connect, IDE pushes, find_mcp
 * adds, OAuth) so no two operations touch the server set at once. Work
 * queued with `blocksTurns` is what a starting turn waits for.
 */
export class McpWorkQueue {
	private tail: Promise<void> = Promise.resolve();
	private barrier: Promise<void> | undefined;

	/**
	 * `work` may call `releaseTurns` before it finishes, once a starting turn
	 * no longer has anything to gain by waiting for it (every server's tools
	 * are already advertised); the queue itself still waits for the work.
	 */
	run<T>(
		work: (releaseTurns: () => void) => Promise<T>,
		options: { blocksTurns?: boolean } = {},
	): Promise<T> {
		let releaseTurns = () => {};
		const released = new Promise<void>((resolve) => {
			releaseTurns = resolve;
		});
		const result = this.tail.then(() => work(releaseTurns));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.tail = settled;
		if (options.blocksTurns) {
			this.barrier = Promise.race([settled, released]);
		}
		return result;
	}

	/**
	 * Settles once every turn-blocking operation queued so far (and all work
	 * queued before it) has finished.
	 */
	get turnBarrier(): Promise<void> | undefined {
		return this.barrier;
	}
}

export const DEFAULT_MCP_TURN_WAIT_MS = 15_000;

/** `BACKBOARD_MCP_TURN_WAIT_MS` (a non-negative integer) or the default. */
export function mcpTurnWaitMs(
	value: string | undefined = process.env.BACKBOARD_MCP_TURN_WAIT_MS,
): number {
	if (value === undefined || value.trim() === "") {
		return DEFAULT_MCP_TURN_WAIT_MS;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0
		? parsed
		: DEFAULT_MCP_TURN_WAIT_MS;
}

/**
 * Waits for in-flight MCP work before a turn snapshots its tools, but never
 * longer than `timeoutMs`: a slow server must not stall the turn, and its
 * tools join from a later turn once it connects.
 */
export async function waitForMcpWork(
	work: Promise<unknown> | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<"settled" | "timeout" | "aborted"> {
	if (!work) return "settled";
	if (signal?.aborted) return "aborted";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work.then(
				() => "settled" as const,
				() => "settled" as const,
			),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
			new Promise<"aborted">((resolve) => {
				onAbort = () => resolve("aborted");
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Writes unsolicited `serve:mcp` snapshots, coalescing bursts of status
 * changes (a reconnect touches several fields in a row) into one record.
 */
export class McpStatusPublisher {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pendingWarnings: string[] = [];
	private disposed = false;

	constructor(
		private readonly write: (payload: ServeMcpPayload) => void,
		private readonly listStatuses: () => McpServerRuntimeStatus[],
		private readonly delayMs = 50,
	) {}

	schedule(warnings: readonly string[] = []): void {
		if (this.disposed) return;
		this.pendingWarnings.push(...warnings);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), this.delayMs);
	}

	snapshot(warnings: readonly string[] = []): ServeMcpPayload {
		return {
			servers: this.listStatuses(),
			...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
		};
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed) return;
		const warnings = this.pendingWarnings;
		this.pendingWarnings = [];
		this.write(this.snapshot(warnings));
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
