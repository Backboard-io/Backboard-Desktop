use schemars::JsonSchema;
use serde::Deserialize;
use std::env;
use zed::settings::ContextServerSettings;
use zed_extension_api::{
    self as zed, serde_json, Command, ContextServerConfiguration, ContextServerId, Project, Result,
};

const PACKAGE_NAME: &str = "@supabase/mcp-server-supabase";
const PACKAGE_PATH: &str = "node_modules/@supabase/mcp-server-supabase";

#[derive(Debug, Deserialize, JsonSchema)]
struct SupabaseContextServerSettings {
    supabase_access_token: String,
    read_only: bool,
    supabase_project_ref: Option<String>,
}

struct SupabaseModelContextExtension;

impl zed::Extension for SupabaseModelContextExtension {
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

        let settings = ContextServerSettings::for_project("mcp-server-supabase", project)?;
        let Some(settings) = settings.settings else {
            return Err("missing `supabase_access_token` setting".into());
        };
        let settings: SupabaseContextServerSettings =
            serde_json::from_value(settings).map_err(|e| e.to_string())?;

        // Find file
        let directories = ["dist", "dist/transports"];
        let filename = "stdio.js";
        let Some(entrypoint) = directories
            .iter()
            .map(|&dir| {
                env::current_dir()
                    .unwrap()
                    .join(PACKAGE_PATH)
                    .join(dir)
                    .join(filename)
            })
            .find(|path| path.exists())
        else {
            return Err("cannot find stdio.js necessary to start the MCP server".into());
        };

        let mut args = vec![entrypoint.to_string_lossy().to_string()];
        if settings.read_only {
            args.push("--read-only".to_string());
        }
        if let Some(project_ref) = settings.supabase_project_ref {
            args.push("--project-ref".to_string());
            args.push(project_ref);
        }

        Ok(Command {
            command: zed::node_binary_path()?,
            args,
            env: vec![(
                "SUPABASE_ACCESS_TOKEN".into(),
                settings.supabase_access_token,
            )],
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
            serde_json::to_string(&schemars::schema_for!(SupabaseContextServerSettings))
                .map_err(|e| e.to_string())?;

        Ok(Some(ContextServerConfiguration {
            installation_instructions,
            default_settings,
            settings_schema,
        }))
    }
}

zed::register_extension!(SupabaseModelContextExtension);
