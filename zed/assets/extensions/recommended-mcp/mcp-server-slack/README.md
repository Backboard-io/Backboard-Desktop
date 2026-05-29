# zed-slack-mcp

Zed extension for Slack's MCP server.

# In your Zed settings: 

```json
{
  "context_servers": {
    "mcp-server-slack": {
      "settings": {
        "slack_bot_token": "SLACK_BOT_TOKEN",
        "slack_team_id":  "SLACK_TEAM_ID",
        "slack_channel_ids": "SLACK_CHANNEL_IDS"
      }
    }
  }
}