/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IGalleryMcpServerConfiguration, RegistryType } from '../../../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, IMcpServerVariable, McpServerType, McpServerVariableType } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { GENERATED_CLI_MCP_CATALOG } from './mcpMarketplaceCatalog.generated.js';

export type McpMarketplaceCategory =
	| 'pinned'
	| 'installed'
	| 'development-testing'
	| 'project-management-docs'
	| 'payments-commerce'
	| 'design-media'
	| 'infrastructure-devops'
	| 'stdio-utilities'
	| 'remote-servers'
	| 'all';

export type McpCatalogInstallability = 'installable' | 'missing' | 'unsupportedAuth' | 'brokenRuntime' | 'disabled';

/**
 * The raw cli-ts server config shape written verbatim to .backboard/mcp.json so
 * backboard-cli-ts chat sessions pick up marketplace installs.
 */
export interface IMcpCliServerConfig {
	readonly type?: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
	readonly url?: string;
	readonly headers?: Record<string, string>;
}

export interface IMcpMarketplaceCatalogEntry {
	readonly id: string;
	readonly label: string;
	readonly category: Exclude<McpMarketplaceCategory, 'pinned' | 'installed' | 'all'>;
	readonly expectedNames: readonly string[];
	readonly searchTerms?: readonly string[];
	readonly officialPublisherHints: readonly string[];
	readonly description?: string;
	readonly publisher?: string;
	readonly installConfiguration?: IGalleryMcpServerConfiguration;
	readonly repositoryUrl?: string;
	readonly trustedSource?: 'github.com/mcp';
	readonly logoUrl?: string;
	readonly installability: McpCatalogInstallability;
	readonly disabledReason?: string;
	/**
	 * Ready-to-install workbench server configuration. When present, install
	 * bypasses the MCP registry entirely.
	 */
	readonly installServerConfig?: IMcpServerConfiguration;
	readonly installInputs?: readonly IMcpServerVariable[];
	readonly cliConfig?: IMcpCliServerConfig;
	/**
	 * Overrides the package type picked at registry-based install time. Only
	 * relevant for entries without an installServerConfig.
	 */
	readonly preferredPackageType?: RegistryType;
}

function extraEntry(
	id: string,
	label: string,
	category: Exclude<McpMarketplaceCategory, 'pinned' | 'installed' | 'all'>,
	logoDomain: string,
	description: string,
	installServerConfig: IMcpServerConfiguration,
	cliConfig: IMcpCliServerConfig,
	installInputs?: readonly IMcpServerVariable[],
): IMcpMarketplaceCatalogEntry {
	return {
		id,
		label,
		category,
		expectedNames: [id],
		searchTerms: [label, id],
		officialPublisherHints: [logoDomain],
		description,
		installability: 'installable',
		installServerConfig,
		installInputs,
		cliConfig,
	};
}

function stdioExtra(
	id: string,
	label: string,
	category: Exclude<McpMarketplaceCategory, 'pinned' | 'installed' | 'all'>,
	logoDomain: string,
	description: string,
	npxArgs: readonly string[],
): IMcpMarketplaceCatalogEntry {
	return extraEntry(
		id,
		label,
		category,
		logoDomain,
		description,
		{ type: McpServerType.LOCAL, command: 'npx', args: [...npxArgs] },
		{ type: 'stdio', command: 'npx', args: ['-y', ...npxArgs.filter(arg => arg !== '-y')] },
	);
}

/**
 * Verified-working servers that are not part of the cli-ts curated catalog.
 */
const EXTRA_MCP_CATALOG: readonly IMcpMarketplaceCatalogEntry[] = [
	extraEntry('github', 'GitHub', 'development-testing', 'github.com', 'Manage repositories, issues, pull requests, and code search.',
		{ type: McpServerType.REMOTE, url: 'https://api.githubcopilot.com/mcp/' },
		{ type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' }),
	stdioExtra('chrome-devtools', 'Chrome DevTools', 'development-testing', 'developer.chrome.com', 'Debug and inspect Chrome browser sessions.',
		['-y', 'chrome-devtools-mcp@latest']),
	stdioExtra('desktop-commander', 'Desktop Commander', 'stdio-utilities', 'desktopcommander.app', 'Desktop and terminal automation utilities.',
		['-y', '@wonderwhy-er/desktop-commander@latest']),
	extraEntry('tavily', 'Tavily', 'development-testing', 'tavily.com', 'Search and extract web content.',
		{ type: McpServerType.LOCAL, command: 'npx', args: ['-y', 'tavily-mcp'], env: { TAVILY_API_KEY: '${input:TAVILY_API_KEY}' } },
		{ type: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp'], env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' } },
		[{ id: 'TAVILY_API_KEY', type: McpServerVariableType.PROMPT, description: 'Tavily API key', password: true }]),
	extraEntry('firecrawl', 'Firecrawl', 'development-testing', 'firecrawl.dev', 'Search, scrape, and crawl web pages.',
		{ type: McpServerType.LOCAL, command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: '${input:FIRECRAWL_API_KEY}' } },
		{ type: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' } },
		[{ id: 'FIRECRAWL_API_KEY', type: McpServerVariableType.PROMPT, description: 'Firecrawl API key', password: true }]),
	stdioExtra('azure', 'Azure', 'infrastructure-devops', 'azure.microsoft.com', 'Create a connection between AI agents and Azure services.',
		['-y', '@azure/mcp@latest', 'server', 'start']),
	stdioExtra('microsoft-fabric', 'Fabric', 'infrastructure-devops', 'microsoft.com', 'Interact with Microsoft Fabric resources.',
		['-y', '@microsoft/fabric-mcp@latest', 'server', 'start']),
	stdioExtra('everything', 'Everything', 'stdio-utilities', 'modelcontextprotocol.io', 'Reference server for testing MCP protocol features.',
		['-y', '@modelcontextprotocol/server-everything']),
	stdioExtra('filesystem', 'Filesystem', 'stdio-utilities', 'modelcontextprotocol.io', 'Secure file operations with configurable access controls.',
		['-y', '@modelcontextprotocol/server-filesystem']),
	stdioExtra('memory-reference', 'Memory', 'stdio-utilities', 'modelcontextprotocol.io', 'Knowledge graph based persistent memory.',
		['-y', '@modelcontextprotocol/server-memory']),
	stdioExtra('sequential-thinking', 'Sequential Thinking', 'stdio-utilities', 'modelcontextprotocol.io', 'Structured reflective problem solving.',
		['-y', '@modelcontextprotocol/server-sequential-thinking']),
];

export const MCP_MARKETPLACE_CATALOG: readonly IMcpMarketplaceCatalogEntry[] = [
	...GENERATED_CLI_MCP_CATALOG,
	...EXTRA_MCP_CATALOG,
];
