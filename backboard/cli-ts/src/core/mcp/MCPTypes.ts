import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	Prompt as SdkPrompt,
	Resource as SdkResource,
	ResourceTemplate as SdkResourceTemplate,
	Tool as SdkTool,
	ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { McpConfigSource, McpServerConfig } from "./config.ts";

export type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpToolDefinition {
	registeredName: string;
	serverName: string;
	toolName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: SdkTool["annotations"];
	trustAnnotations: boolean;
	timeoutMs: number;
	call: (
		input: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<McpCallResult>;
}

export type McpListedToolDefinition = Omit<McpToolDefinition, "registeredName">;

export type McpPromptDefinition = SdkPrompt & { serverName: string };

export type McpResourceDefinition = SdkResource & { serverName: string };

export type McpResourceTemplateDefinition = SdkResourceTemplate & {
	serverName: string;
};

export interface McpInitializeResult {
	tools: McpToolDefinition[];
	warnings: string[];
}

export interface McpServerMutationResult {
	toolNames: string[];
	warnings: string[];
}

export interface McpToolRefreshResult {
	tools: McpToolDefinition[];
	removedToolNames: string[];
	warnings: string[];
}

export interface McpPromptRefreshResult {
	prompts: McpPromptDefinition[];
	removedPromptNames: string[];
	warnings: string[];
}

export interface McpResourceRefreshResult {
	resources: McpResourceDefinition[];
	removedResourceUris: string[];
	updatedResourceUris: string[];
	warnings: string[];
}

export type McpServerRuntimeState =
	| "connecting"
	| "connected"
	| "needs_authentication"
	| "error"
	| "disabled";

/**
 * Where a live server's configuration came from: pushed by the IDE, read from
 * the user or project `mcp.json`, or added at runtime (find_mcp) by this
 * process.
 */
export type McpServerOrigin = "ide" | "user" | "project" | "runtime";

export interface McpServerRuntimeStatus {
	name: string;
	type: McpServerConfig["type"];
	configSources: McpConfigSource[];
	status: McpServerRuntimeState;
	message?: string;
	toolNames: string[];
	/** Filled in by `McpClientManager.listServerStatuses`. */
	source?: McpServerOrigin;
	capabilities?: ServerCapabilities;
	promptNames?: string[];
	resourceUris?: string[];
	updatedResourceUris?: string[];
	subscribedResourceUris?: string[];
}

export type McpClientTransport =
	| StdioClientTransport
	| StreamableHTTPClientTransport;

export interface McpConnection {
	server: McpServerConfig;
	client: Client;
	transport: McpClientTransport;
	tools: Map<string, McpToolDefinition>;
	prompts: Map<string, McpPromptDefinition>;
	resources: Map<string, McpResourceDefinition>;
	updatedResourceUris: Set<string>;
	subscribedResourceUris: Set<string>;
	capabilities: ServerCapabilities;
}
