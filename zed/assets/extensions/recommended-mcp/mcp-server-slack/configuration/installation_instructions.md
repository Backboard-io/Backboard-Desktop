## Slack Server Setup Instructions

To set up the Slack server, please refer to the full setup guide available here:  [Slack Server README](https://github.com/modelcontextprotocol/servers/blob/main/src/slack/README.md)

### Required Slack Credentials

You will need to obtain the following values from your Slack App configuration:

```json
{
  "slack_bot_token": "SLACK_BOT_TOKEN",
  "slack_team_id":  "SLACK_TEAM_ID",
  "slack_channel_ids": "SLACK_CHANNEL_IDS"
}
```
- `SLACK_BOT_TOKEN`: The OAuth token for your Slack bot.
- `SLACK_TEAM_ID`: The ID of your Slack workspace.
- `SLACK_CHANNEL_IDS`: The IDs of the channels where the bot will post messages. This can be a comma-separated list of channel IDs.

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