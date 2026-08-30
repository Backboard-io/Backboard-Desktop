# MCP Marketplace Auth And Runtime Notes

This document explains the current Backboard MCP marketplace policy, how installed MCP servers flow into the existing VS Code MCP runtime, what auth modes are supported today, and which servers were intentionally removed or hidden until follow-up auth work exists.

## Current Principle

Backboard should only advertise MCP servers that can be installed, configured, and started through the runtime that already exists in `src/vs/workbench/contrib/mcp` and `src/vs/workbench/services/mcp`.

The current work does not add a second MCP process manager, event bus, spawn coordinator, or generic OAuth client-registration system. Runtime lifecycle still belongs to the existing MCP service stack:

| Area | Source |
|---|---|
| MCP runtime service and server state | `src/vs/workbench/contrib/mcp/common/mcpService.ts` |
| MCP server lifecycle and output | `src/vs/workbench/contrib/mcp/common/mcpServer.ts` |
| MCP connection resolution and variable replacement | `src/vs/workbench/contrib/mcp/common/mcpRegistry.ts` |
| Installed MCP discovery | `src/vs/workbench/contrib/mcp/common/discovery/installedMcpServersDiscovery.ts` |
| Workbench install/uninstall management | `src/vs/workbench/services/mcp/common/mcpWorkbenchManagementService.ts` |
| Skills/MCP marketplace UI | `src/vs/workbench/contrib/chat/browser/widget/input/skillsLibrary.ts` |

## Catalog Policy

Marketplace MCP entries now carry an installability marker:

| Marker | Meaning | UI behavior |
|---|---|---|
| `installable` | Backboard can install and start the server, or the server can be configured through supported inputs. | Rendered in the marketplace. |
| `missing` | No trusted installable registry/config source is available yet. | Hidden from normal marketplace results. |
| `unsupportedAuth` | The server requires OAuth/client registration Backboard cannot satisfy today. | Hidden from normal marketplace results. |
| `brokenRuntime` | The entry exists but cannot run with Backboard's current runtime support. | Hidden from normal marketplace results. |

Hidden entries are still tracked and logged so developers can audit why an expected server is absent.

## Supported Auth Modes

Backboard currently supports these MCP auth/setup paths:

| Auth mode | Supported today | Notes |
|---|---:|---|
| Anonymous HTTP/SSE | Yes | The runtime starts the remote server directly. |
| Local `stdio` command | Yes | Uses existing command/args/env/envFile launch support. |
| API key, bearer token, or custom header through `${input:...}` | Yes | Prompts through the existing MCP input system and stores secrets through MCP input storage. |
| OAuth requiring a vendor-registered Backboard client | No | Hidden until Backboard has working client metadata or a vendor-supported public-client flow. |
| Generic OAuth dynamic/client registration | No | Intentionally not implemented in this pass. |

When a server references an input variable but the installed config lacks an `inputs` section, `mcpRegistry.ts` now prompts directly for the missing `${input:...}` value instead of surfacing a raw `CodeExpectedError`. Sensitive-looking input ids such as `api_key`, `token`, `secret`, `password`, `auth`, and `credential` are stored as secrets.

## Marketplace UI Behavior

The MCP marketplace lives in `skillsLibrary.ts`.

Visible marketplace entries are built from installable catalog entries only. When no MCP marketplace entries match the current category/filter, the empty state says:

```text
More MCP servers are coming soon
```

Installed MCP cards expose these actions:

| Button | Current behavior |
|---|---|
| `Installed` | Removes the installed MCP package/config. |
| Play icon | Closes the marketplace and opens the existing MCP server options/start flow. |
| Output icon | Opens the runtime MCP output channel when a runtime server exists. If no output exists yet, Backboard tells the user to start the server first and opens setup/start. |
| Gear icon | Opens the MCP configuration location when it can be resolved; otherwise falls back to server options. |

The Output button previously passed the workbench-installed package id to `McpCommandIds.ShowOutput`. That command expects a runtime MCP definition id, so the click could appear to do nothing. It now resolves the runtime id first.

## Backboard Default MCP

The default Backboard docs MCP is installed as a regular HTTP MCP:

| Field | Value |
|---|---|
| Internal server name | `backboard` |
| Display name | `Backboard` |
| URL | `https://backboard-docs.docsalot.dev/api/mcp` |
| Auth | Anonymous |

Legacy `backboard-docs` installs are migrated/removed by the Backboard MCP contribution so the installed card reads `Backboard`, not `backboard-docs`.

## Installed Server Runtime Guard

Filtering the marketplace is not enough because users may already have broken MCPs in their installed config. `installedMcpServersDiscovery.ts` now skips known unsupported OAuth-installed MCPs during runtime discovery, so old installs do not keep creating startup/auth loops.

This guard is intentionally narrow. Token/header servers stay registered because they can be fixed through setup prompts.

## Agent Host MCP Bridge

Workbench-installed MCPs have two paths into agent sessions:

1. Runtime tools registered by `ILanguageModelToolsService`.
2. Non-plugin MCP definitions bundled into a synthetic Open Plugin customization.

The first path is the one used by Backboard-hosted providers such as DeepSeek. `AgentHostActiveClientService` exports client tools from the normal allowlist and also exports all tools whose source is `mcp`. `agentHostToolUtils.ts` preserves MCP source metadata on the protocol `ToolDefinition`. `backboardAgent.ts` then lets those MCP client tools through its provider-side filter, sends them to the model as function tools, and routes tool calls back through the active workbench client. That keeps MCP process lifecycle, input prompting, output, and confirmation inside the existing workbench runtime.

Without this bridge, an MCP could be installed and started in Backboard Studio while a Backboard/DeepSeek agent still answered that no Supabase MCP was connected, because the provider never received the MCP tool definitions.

The customization bundle path is still used by providers that consume MCP definitions directly:

| Step | Source |
|---|---|
| Collect enabled non-plugin MCP servers | `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLocalCustomizations.ts` |
| Write them into synthetic `.mcp.json` | `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/syncedCustomizationBundler.ts` |
| Publish the bundle through `activeClientChanged` | agent-session side effects |

Copilot and Claude already consume client-published customizations. Codex previously dropped them because `CodexAgent.setClientCustomizations(...)` was a no-op. That meant a server could appear installed in Backboard Studio, while a Codex-backed agent still reported that no Supabase MCP was configured.

`src/vs/platform/agentHost/node/codex/codexAgent.ts` now syncs the published customization bundle through `IAgentPluginManager`, parses MCP definitions from the synced plugin, writes those definitions into Codex config with `config/batchWrite`, calls `config/mcpServer/reload`, and refreshes the Codex MCP inventory. The Codex-side inventory then flows through the existing `mcp://` side-channel and `McpCustomizationController`.

The Codex bridge intentionally reuses the existing workbench bundle and Codex MCP loader. It does not add another process manager.

Known caveat: if a bundled MCP definition still contains unresolved `${input:...}` placeholders, Codex may not be able to resolve them on its own. Servers should be started/configured through Backboard first so the workbench runtime can prompt for inputs; a follow-up should sync resolved input values or route these servers through the workbench MCP gateway directly.

## Removed From This User's Installed Config

The local Backboard Studio dev profile had older unsupported OAuth MCPs installed. These were removed from:

```text
/Users/seifo/Library/Application Support/code-oss-dev/User/mcp.json
```

A backup was written before editing:

```text
/Users/seifo/Library/Application Support/code-oss-dev/User/mcp.json.backup-2026-06-25T19-03-46-863Z
```

Removed because they need unsupported OAuth/vendor-client work:

| MCP | Reason to add later |
|---|---|
| Linear | Needs working OAuth/client metadata for Backboard. |
| Atlassian | Needs working OAuth/client metadata for Backboard. |
| Cloudflare | Needs working OAuth/client metadata for Backboard. |
| Figma | Needs working OAuth/client metadata for Backboard. |
| GitLab | Needs working OAuth/client metadata for Backboard. |
| Railway | Needs working OAuth/client metadata for Backboard. |
| ThousandEyes | Needs working OAuth/client metadata for Backboard. |
| Vercel | Needs working OAuth/client metadata for Backboard. |
| Lovable | Needs working OAuth/client metadata for Backboard. |
| Firebase | Needs working OAuth/client metadata for Backboard or a verified local setup path. |
| Sentry | Needs a verified supported auth path before being treated as generally installable. |

Kept installed because they are anonymous, local-runtime, or input-auth configurable:

```text
backboard
com.microsoft/azure
com.microsoft/microsoft-fabric
com.microsoft/nuget
com.postman/postman-mcp-server
com.sonatype/dependency-management-mcp-server
com.stripe/mcp
com.supabase/mcp
io.github.cloudinary/asset-management-mcp
io.github.containers/kubernetes-mcp-server
io.github.grafana/mcp-grafana
io.github.hashicorp/terraform-mcp-server
io.github.modelcontextprotocol/server-everything
io.github.modelcontextprotocol/server-fetch
io.github.modelcontextprotocol/server-filesystem
io.github.modelcontextprotocol/server-git
io.github.modelcontextprotocol/server-memory
io.github.modelcontextprotocol/server-time
io.github.tavily-ai/tavily-mcp
```

## Branding Notes

Product metadata was adjusted so dev mode renders as `Backboard Studio Dev`, not `Backboard Studio Dev Dev`.

The macOS app icon was regenerated from the Backboard mark and written to:

```text
resources/darwin/code.icns
.build/electron/Backboard Studio Dev.app/Contents/Resources/Backboard Studio Dev.icns
```

This affects the app bundle icon/title chrome. In-workbench MCP cards use the icon data from their installed metadata or catalog entry; the Backboard default MCP uses the Backboard icon configured in its MCP contribution.

## Future Work

Add these only when a full install/start/auth smoke test passes:

1. Vendor OAuth support for Linear, Atlassian, Figma, Cloudflare, Vercel, Railway, GitLab, Lovable, ThousandEyes, and similar remote OAuth MCPs.
2. A clear Backboard OAuth client metadata contract: client id, redirect URI behavior, scopes, PKCE/public-client support, and secret handling.
3. A registry/config schema field that distinguishes supported OAuth from unsupported vendor-client OAuth.
4. Marketplace UI for setup instructions on installable token/header servers before first start.
5. Tests that old installed unsupported OAuth MCPs do not register as runnable servers.
6. An explicit “no output yet” UI affordance for installed MCPs that have not been started, instead of relying only on notifications.
7. Resolved input sync for Codex-hosted MCP config, or a direct Codex-to-workbench MCP gateway transport for `${input:...}` servers.

## Validation Commands

Use these from `ide/vscode`:

```sh
node_modules/.bin/eslint src/vs/workbench/contrib/chat/browser/widget/input/skillsLibrary.ts src/vs/workbench/contrib/mcp/common/discovery/installedMcpServersDiscovery.ts src/vs/workbench/contrib/mcp/common/mcpRegistry.ts src/vs/workbench/contrib/mcp/common/mcpServer.ts src/vs/platform/agentHost/node/codex/codexAgent.ts
git diff --check -- product.json src/vs/workbench/contrib/chat/browser/widget/input/skillsLibrary.ts src/vs/workbench/contrib/mcp/common/discovery/installedMcpServersDiscovery.ts src/vs/workbench/contrib/mcp/common/mcpRegistry.ts src/vs/workbench/contrib/mcp/common/mcpServer.ts src/vs/platform/agentHost/node/codex/codexAgent.ts bb-docs/mcp-tools-customizations/marketplace-auth-runtime.md
npm run transpile-client
```

Known broader typecheck state at the time of this work: `npm run typecheck-client -- --pretty false` still reports unrelated pre-existing diagnostics outside the MCP marketplace/runtime files.
