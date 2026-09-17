/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';

/**
 * One entry of a `.backboard/mcp.json` file, as read by the Backboard CLI
 * (`cli-ts/src/core/mcp/config.ts`) and written by the IDE when a server is
 * installed from the MCP marketplace.
 */
export interface IBackboardCliMcpServerConfig {
	readonly type?: string;
	readonly disabled?: boolean;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

/** Parses a `.backboard/mcp.json` document into its server map. */
export function parseBackboardCliMcpConfig(value: unknown): Record<string, IBackboardCliMcpServerConfig> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const servers = (value as { mcpServers?: unknown }).mcpServers;
	if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
		return {};
	}
	const result: Record<string, IBackboardCliMcpServerConfig> = {};
	for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			continue;
		}
		result[name] = entry as IBackboardCliMcpServerConfig;
	}
	return result;
}

/**
 * Maps a `.backboard/mcp.json` server onto the workbench configuration shape
 * so the Backboard CLI's servers show up (and install) like any other server
 * in the IDE's MCP surfaces. Returns `undefined` for entries the workbench
 * cannot represent (neither a command nor a URL).
 */
export function cliMcpServerToWorkbenchConfig(cliConfig: IBackboardCliMcpServerConfig | undefined): IMcpServerConfiguration | undefined {
	if (!cliConfig) {
		return undefined;
	}
	if (cliConfig.url) {
		return {
			type: McpServerType.REMOTE,
			url: cliConfig.url,
			headers: cliConfig.headers ? { ...cliConfig.headers } : undefined,
		};
	}
	if (cliConfig.command) {
		return {
			type: McpServerType.LOCAL,
			command: cliConfig.command,
			args: cliConfig.args ? [...cliConfig.args] : undefined,
			env: cliConfig.env ? { ...cliConfig.env } : undefined,
			...(cliConfig.cwd ? { cwd: cliConfig.cwd } : {}),
		};
	}
	return undefined;
}
