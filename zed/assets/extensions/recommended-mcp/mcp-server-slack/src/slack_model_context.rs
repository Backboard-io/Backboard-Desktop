use schemars::JsonSchema;
use serde::Deserialize;
use std::env;
use zed::settings::ContextServerSettings;
use zed_extension_api::{
    self as zed, serde_json, Command, ContextServerConfiguration, ContextServerId, Project, Result,
};

const PACKAGE_NAME: &str = "@modelcontextprotocol/server-slack";
const MCP_SERVER_PATH: &str = "node_modules/@modelcontextprotocol/server-slack/dist/index.js";

struct SlackModelContextExtension;

#[derive(Debug, Deserialize, JsonSchema)]
struct SlackContextServerSettings {
    slack_bot_token: String,
    slack_team_id: String,
    slack_channel_ids: String,
}

impl zed::Extension for SlackModelContextExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        project: &Project,
    ) -> Result<Command> {
        let latest_version = zed::npm_package_latest_version(PACKAGE_NAME)?;
        let version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if version.as_deref() != Some(latest_version.as_ref()) {
            zed::npm_install_package(PACKAGE_NAME, &latest_version)?;
        }

        let settings = ContextServerSettings::for_project("mcp-server-slack", project)?;
        let Some(settings) = settings.settings else {
            return Err("missing `slack_bot_token` setting".into());
        };
        let settings: SlackContextServerSettings =
            serde_json::from_value(settings).map_err(|e| e.to_string())?;

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![env::current_dir()
                .unwrap()
                .join(MCP_SERVER_PATH)
                .to_string_lossy()
                .to_string()],
            env: vec![
                ("SLACK_BOT_TOKEN".into(), settings.slack_bot_token),
                ("SLACK_TEAM_ID".into(), settings.slack_team_id),
                ("SLACK_CHANNEL_IDS".into(), settings.slack_channel_ids),
            ],
        })
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        let installation_instructions =
            include_str!("../configuration/installation_instructions.md").to_string();
        let default_settings = include_str!("../configuration/default_settings.jsonc").to_string();
        let settings_schema =
            serde_json::to_string(&schemars::schema_for!(SlackContextServerSettings))
                .map_err(|e| e.to_string())?;

        Ok(Some(ContextServerConfiguration {
            installation_instructions,
            default_settings,
            settings_schema,
        }))
    }
}

zed::register_extension!(SlackModelContextExtension);
