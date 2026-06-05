---
title: Model Context Protocol (MCP) in Backboard Studio
description: Install and configure MCP servers in Backboard Studio to extend your AI agent with external tools, data sources, and integrations.
---

# Model Context Protocol

Backboard Studio uses the [Model Context Protocol](https://modelcontextprotocol.io/) to interact with context servers.

> The Model Context Protocol (MCP) is an open protocol for connecting LLM applications to external tools and data sources through a standard interface.

## Supported Features

Backboard Studio currently supports MCP's [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and [Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) features.
We welcome contributions that help advance Backboard Studio's MCP feature coverage (Discovery, Sampling, Elicitation, etc).

Backboard Studio also handles the `notifications/tools/list_changed` notification from MCP servers. When a server adds, removes, or modifies its available tools at runtime, Backboard Studio automatically reloads the tool list without requiring a server restart.

## Installing MCP Servers

### As Extensions

One of the ways you can use MCP servers in Backboard Studio is by exposing them as an extension.
Check out the [MCP Server Extensions](../extensions/mcp-extensions.md) page to learn how to create your own.

Many MCP servers are available as extensions. Find them via:

1. [the Backboard Studio website](https://app.backboard.io/extensions?filter=context-servers)
2. in the app, open the Command Palette and run the {#action backboard::Extensions} action
3. in the app, go to the Agent Panel's top-right menu and look for the "View Server Extensions" menu item

Popular servers available as an extension include:

- [Context7](https://app.backboard.io/extensions/mcp-server-context7)
- [GitHub](https://app.backboard.io/extensions/mcp-server-github)
- [Puppeteer](https://app.backboard.io/extensions/mcp-server-puppeteer)
- [Gem](https://app.backboard.io/extensions/gem)
- [Brave Search](https://app.backboard.io/extensions/mcp-server-brave-search)
- [Prisma](https://github.com/aqrln/prisma-mcp-backboard)
- [Framelink Figma](https://app.backboard.io/extensions/mcp-server-figma)
- [Resend](https://app.backboard.io/extensions/mcp-server-resend)

### As Custom Servers

Creating an extension is not the only way to use MCP servers in Backboard Studio.
You can connect them by adding their commands directly to your settings file ([how to edit](../configuring-backboard.md#settings-files)), like so:

```json [settings]
{
  "context_servers": {
    "local-mcp-server": {
      "command": "some-command",
      "args": ["arg-1", "arg-2"],
      "env": {}
    },
    "remote-mcp-server": {
      "url": "custom",
      "headers": { "Authorization": "Bearer <token>" }
    },
    "remote-mcp-server-with-oauth": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Alternatively, you can also add a custom server by accessing the Agent Panel's Settings view (also accessible via the {#action agent::OpenSettings} action).
From there, you can add it through the modal that appears when you click the "Add Custom Server" button.

> Note: When a remote MCP server has no configured `"Authorization"` header, Backboard Studio will prompt you to authenticate yourself against the MCP server using the standard MCP OAuth flow.

## Using MCP Servers

### Configuration Check

Most MCP servers require configuration after installation.

In the case of extensions, after installing it, Backboard Studio will pop up a modal displaying what is required for you to properly set it up.
For example, the GitHub MCP extension requires you to add a [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

In the case of custom servers, make sure you check the provider documentation to determine what type of command, arguments, and environment variables need to be added to the JSON.

To check if your MCP server is properly configured, go to the Agent Panel's settings view and watch the indicator dot next to its name.
If they're running correctly, the indicator will be green and its tooltip will say "Server is active".
If not, other colors and tooltip messages will indicate what is happening.

### Agent Panel Usage

Once installation is complete, you can return to the Agent Panel and start prompting.

How reliably MCP tools get called can vary from model to model.
Mentioning the MCP server by name can help the model pick tools from that server.

However, if you want to _ensure_ a given MCP server will be used, you can create [a custom profile](./agent-panel.md#custom-profiles) where all built-in tools (or the ones that could cause conflicts with the server's tools) are turned off and only the tools coming from the MCP server are turned on.

As an example, [the Dagger team suggests](https://container-use.com/agent-integrations#backboard) doing that with their [Container Use MCP server](https://app.backboard.io/extensions/mcp-server-container-use):

```json [settings]
"agent": {
  "profiles": {
    "container-use": {
      "name": "Container Use",
      "tools": {
        "fetch": true,
        "thinking": true,
        "copy_path": false,
        "find_path": false,
        "delete_path": false,
        "create_directory": false,
        "list_directory": false,
        "diagnostics": false,
        "read_file": false,
        "move_path": false,
        "grep": false,
        "edit_file": false,
        "terminal": false
      },
      "enable_all_context_servers": false,
      "context_servers": {
        "container-use": {
          "tools": {
            "environment_create": true,
            "environment_add_service": true,
            "environment_update": true,
            "environment_run_cmd": true,
            "environment_open": true,
            "environment_file_write": true,
            "environment_file_read": true,
            "environment_file_list": true,
            "environment_file_delete": true,
            "environment_checkpoint": true
          }
        }
      }
    }
  }
}
```

### Tool Permissions

> **Note:** In Backboard Studio v0.224.0 and above, tool approval is controlled by `agent.tool_permissions.default`.
> In earlier versions, it was controlled by the `agent.always_allow_tool_actions` boolean (default `false`).

Backboard Studio's Agent Panel provides the `agent.tool_permissions.default` setting to control tool approval behavior for the native Backboard Studio agent:

- `"confirm"` (default) — Prompts for approval before running any tool action, including MCP tool calls
- `"allow"` — Auto-approves tool actions without prompting
- `"deny"` — Blocks all tool actions

For granular control over specific MCP tools, you can configure per-tool permission rules.
MCP tools use the key format `mcp:<server>:<tool_name>` — for example, `mcp:github:create_issue`.
The `default` key on a per-tool entry is the primary mechanism for MCP tools, since pattern-based rules match against an empty string for MCP tools and most patterns won't match.

Learn more about [how tool permissions work](./tool-permissions.md), how to further customize them, and other details.

### External Agents

MCP servers configured in Backboard Studio are forwarded to [external agents](./external-agents.md) via the [Agent Client Protocol](https://agentclientprotocol.com/). External agents can also access MCP servers from their own native configuration files.

For details on what configuration is shared between Backboard Studio and external agents, see [Configuration Boundaries](./external-agents.md#configuration-boundaries).

### Error Handling

When a MCP server encounters an error while processing a tool call, the agent receives the error message directly and the operation fails.
Common error scenarios include:

- Invalid parameters passed to the tool
- Server-side failures (database connection issues, rate limits)
- Unsupported operations or missing resources

The error message from the context server will be shown in the agent's response, allowing you to diagnose and correct the issue.
Check the context server's logs or documentation for details about specific error codes.
