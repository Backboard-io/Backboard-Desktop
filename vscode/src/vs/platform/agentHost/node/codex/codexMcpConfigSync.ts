/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMcpServerConfiguration, McpServerType } from '../../../mcp/common/mcpPlatformTypes.js';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue.js';
import type { ConfigEdit } from './protocol/generated/v2/ConfigEdit.js';

type CodexMcpServerConfigValue = { [key in string]?: JsonValue };

export function buildCodexMcpServerConfigEdits(mcpServers: ReadonlyMap<string, IMcpServerConfiguration>): { readonly edits: readonly ConfigEdit[]; readonly serverCount: number } {
	const serversValue: CodexMcpServerConfigValue = {};
	for (const [name, configuration] of [...mcpServers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const value = codexMcpServerConfigValue(configuration);
		if (value) {
			serversValue[name] = value;
		}
	}
	const serverCount = Object.keys(serversValue).length;
	if (serverCount === 0) {
		return { edits: [], serverCount: 0 };
	}
	return {
		serverCount,
		edits: [{
			keyPath: 'mcp_servers',
			value: serversValue,
			mergeStrategy: 'upsert',
		}],
	};
}

function codexMcpServerConfigValue(configuration: IMcpServerConfiguration): CodexMcpServerConfigValue | undefined {
	switch (configuration.type) {
		case McpServerType.LOCAL: {
			if (!configuration.command) {
				return undefined;
			}
			const env = normalizeCodexMcpEnv(configuration.env);
			return {
				command: configuration.command,
				...(configuration.args && configuration.args.length > 0 ? { args: [...configuration.args] } : {}),
				...(env ? { env } : {}),
				...(configuration.envFile ? { env_file: configuration.envFile } : {}),
				...(configuration.cwd ? { cwd: configuration.cwd } : {}),
			};
		}
		case McpServerType.REMOTE:
			return {
				url: configuration.url,
				...(configuration.headers ? { headers: { ...configuration.headers } } : {}),
			};
	}
}

function normalizeCodexMcpEnv(env: Record<string, string | number | null> | undefined): CodexMcpServerConfigValue | undefined {
	if (!env) {
		return undefined;
	}
	const result: CodexMcpServerConfigValue = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== null) {
			result[key] = String(value);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
