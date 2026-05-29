# Supabase MCP server extension for Zed

This extension enables [Supabase MCP](https://github.com/supabase-community/supabase-mcp)
as a context server for [Zed's](https://zed.dev) [Agent Panel.](https://zed.dev/docs/ai/overview)


To install navigate to: **Zed** > **Extensions**. Or use the command palette
([macOS](https://github.com/zed-industries/zed/blob/main/assets/keymaps/default-macos.json#L581),
[Linux](https://github.com/zed-industries/zed/blob/main/assets/keymaps/default-linux.json#L459))
to search `extensions`.

You'll need to grab a Supabase access token for your account.

```json
"context_servers": {
  "mcp-server-supabase": {
    "settings": {
      "supabase_access_token": "<SUPABASE_ACCESS_TOKEN>",
      "read_only": false
    }
  }
}
```

This extension also supports other options provided by [Supabase MCP](https://github.com/supabase-community/supabase-mcp#project-scoped-mode):

```json
"context_servers": {
  "mcp-server-supabase": {
    "settings": {
      "supabase_access_token": "<SUPABASE_ACCESS_TOKEN>",
      "supabase_project_ref": "<PROJECT_REF>",
      "read_only": true
    }
  }
}
```

`supabase_project_ref` option limits MCP server access only to a specific project,
`read_only` flag prohibits write operations.
