import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";
import type { McpListedToolDefinition } from "./MCPTypes.ts";

/** One tool as its server last listed it; never holds call arguments or results. */
export interface McpCachedTool {
	toolName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: SdkTool["annotations"];
}

interface McpToolCacheFile {
	version: 1;
	server: string;
	savedAt: string;
	tools: McpCachedTool[];
}

/**
 * Remembers each server's last tool list on disk so a new process can
 * advertise those tools at once instead of holding the first turn until every
 * server has connected. Entries are keyed by a hash of everything that shapes
 * the connection, so an edited server never reuses a stale list, and the file
 * holds only what the server itself published - no env values or headers.
 */
export class McpToolCache {
	constructor(private readonly directory: string) {}

	async read(server: McpServerConfig): Promise<McpCachedTool[] | undefined> {
		try {
			const parsed: unknown = JSON.parse(
				await readFile(this.fileFor(server), "utf8"),
			);
			if (!isCacheFile(parsed) || parsed.server !== server.name) {
				return undefined;
			}
			return parsed.tools;
		} catch {
			return undefined;
		}
	}

	async write(
		server: McpServerConfig,
		tools: readonly McpListedToolDefinition[],
	): Promise<void> {
		const file = this.fileFor(server);
		const payload: McpToolCacheFile = {
			version: 1,
			server: server.name,
			savedAt: new Date().toISOString(),
			tools: tools.map((tool) => ({
				toolName: tool.toolName,
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.annotations ? { annotations: tool.annotations } : {}),
			})),
		};
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			// Several runtimes share this directory; a rename keeps a reader from
			// ever seeing a half-written list.
			const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
				await rename(temporary, file);
			} finally {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		} catch {
			// The cache is an optimization; a read-only home must not fail a connect.
		}
	}

	async delete(server: McpServerConfig): Promise<void> {
		await rm(this.fileFor(server), { force: true }).catch(() => undefined);
	}

	private fileFor(server: McpServerConfig): string {
		return path.join(this.directory, `${serverFingerprint(server)}.json`);
	}
}

function serverFingerprint(server: McpServerConfig): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				server.name,
				server.type,
				server.command ?? null,
				server.args,
				server.url ?? null,
				server.cwd ?? null,
				sortedEntries(server.env),
				sortedEntries(server.headers),
				server.enabledTools ?? null,
				server.disabledTools,
			]),
		)
		.digest("hex")
		.slice(0, 32);
}

function sortedEntries(record: Record<string, string>): [string, string][] {
	return Object.entries(record).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

function isCacheFile(value: unknown): value is McpToolCacheFile {
	if (typeof value !== "object" || value === null) return false;
	const file = value as Partial<McpToolCacheFile>;
	return (
		file.version === 1 &&
		typeof file.server === "string" &&
		Array.isArray(file.tools) &&
		file.tools.every(
			(tool) =>
				typeof tool === "object" &&
				tool !== null &&
				typeof tool.toolName === "string" &&
				typeof tool.description === "string" &&
				typeof tool.inputSchema === "object" &&
				tool.inputSchema !== null,
		)
	);
}
