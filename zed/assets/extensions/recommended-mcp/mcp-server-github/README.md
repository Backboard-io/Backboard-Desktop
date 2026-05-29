# GitHub MCP Server Extension for Backboard Studio

This extension integrates [GitHub MCP Server](https://github.com/github/github-mcp-server) as a context server for
Backboard Studio's Agent Panel.

To install navigate to: **Backboard Studio** > **Extensions**. Or use the command palette to search `extensions`.

You'll need to [create a PAT with `repo` permissions](https://github.com/settings/tokens/new?description=zed-mcp-server-github&scopes=repo).

```json
"context_servers": {
  "mcp-server-github": {
      "settings": {
        "github_personal_access_token": "<GITHUB_PERSONAL_ACCESS_TOKEN>"
    }
  }
},
```
