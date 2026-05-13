pub use ::backboard::{
    BackboardClient, BackboardConfig, CreateAssistantRequest, DEV_API_URL, LOCAL_API_URL,
    PROD_API_URL, RecentUsageQuery, SendMessageRequest, SubmitToolOutputsRequest,
    UpdateAssistantRequest,
};

use crate::{AgentServer, AgentServerDelegate, load_proxy_env};
use acp_thread::AgentConnection;
use agent_client_protocol::schema as acp;
use anyhow::{Result, bail};
use collections::HashMap;
use gpui::{App, Entity, Task};
use project::{AgentId, Project, agent_server_store::AgentServerCommand};
use std::{
    any::Any,
    env,
    path::{Path, PathBuf},
    rc::Rc,
};
use ui::IconName;

pub const BACKBOARD_AGENT_ID: &str = "backboard";
pub const BACKBOARD_AGENT_NAME: &str = "Backboard";

pub const BACKBOARD_IDE_ACP_PATH_ENV_VAR: &str = "BACKBOARD_IDE_ACP_PATH";
pub const BACKBOARD_CLI_PATH_ENV_VAR: &str = "BACKBOARD_CLI_PATH";
pub const BACKBOARD_CLI_ROOT_ENV_VAR: &str = "BACKBOARD_CLI_ROOT";
pub const BACKBOARD_IDE_PYTHON_ENV_VAR: &str = "BACKBOARD_IDE_PYTHON";

pub struct BackboardAgentServer {
    agent_id: AgentId,
    default_mode: acp::SessionModeId,
}

impl BackboardAgentServer {
    pub fn new(agent_id: AgentId) -> Self {
        Self {
            agent_id,
            default_mode: acp::SessionModeId::new("agent"),
        }
    }

    pub fn with_default_mode(agent_id: AgentId, default_mode: acp::SessionModeId) -> Self {
        Self {
            agent_id,
            default_mode,
        }
    }
}

impl AgentServer for BackboardAgentServer {
    fn logo(&self) -> IconName {
        IconName::Sparkle
    }

    fn agent_id(&self) -> AgentId {
        self.agent_id.clone()
    }

    fn default_mode(&self, _cx: &App) -> Option<acp::SessionModeId> {
        Some(self.default_mode.clone())
    }

    fn connect(
        &self,
        delegate: AgentServerDelegate,
        project: Entity<Project>,
        cx: &mut App,
    ) -> Task<Result<Rc<dyn AgentConnection>>> {
        let agent_id = self.agent_id();
        let default_mode = self.default_mode(cx);
        let default_model = None;
        let default_config_options = HashMap::default();

        let mut extra_env = load_proxy_env(cx);
        extra_env.insert("BACKBOARD_IDE".to_owned(), "zed".to_owned());
        if delegate.store.read(cx).no_browser() {
            extra_env.insert("NO_BROWSER".to_owned(), "1".to_owned());
        }

        let store = delegate.store.downgrade();
        cx.spawn(async move |cx| {
            let command = backboard_acp_command(extra_env)?;
            let connection = crate::acp::connect(
                agent_id,
                project,
                command,
                store,
                default_mode,
                default_model,
                default_config_options,
                cx,
            )
            .await?;
            Ok(connection)
        })
    }

    fn into_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }
}

fn backboard_acp_command(mut extra_env: HashMap<String, String>) -> Result<AgentServerCommand> {
    let script = bridge_script_path();
    if !script.exists() {
        bail!(
            "Backboard IDE ACP bridge was not found at {}",
            script.display()
        );
    }

    let cli_root = backboard_cli_root();
    if cli_root.exists() {
        extra_env.insert(
            BACKBOARD_CLI_ROOT_ENV_VAR.to_owned(),
            cli_root.to_string_lossy().to_string(),
        );
    }

    let python = backboard_python();

    Ok(AgentServerCommand {
        path: python,
        args: vec![script.to_string_lossy().to_string()],
        env: Some(extra_env),
    })
}

fn bridge_script_path() -> PathBuf {
    if let Some(path) = env::var_os(BACKBOARD_IDE_ACP_PATH_ENV_VAR) {
        return PathBuf::from(path);
    }

    zed_root().join("script").join("backboard-ide-acp.py")
}

fn backboard_cli_root() -> PathBuf {
    env::var_os(BACKBOARD_CLI_ROOT_ENV_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| zed_root().join("../..").join("cli"))
}

fn backboard_python() -> PathBuf {
    if let Some(path) = env::var_os(BACKBOARD_IDE_PYTHON_ENV_VAR) {
        return PathBuf::from(path);
    }

    if let Some(cli_path) = env::var_os(BACKBOARD_CLI_PATH_ENV_VAR) {
        let cli_path = PathBuf::from(cli_path);
        if let Some(parent) = cli_path.parent() {
            let sibling_python = parent.join("python");
            if sibling_python.exists() {
                return sibling_python;
            }
        }
    }

    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        let venv_python = home
            .join(".backboard")
            .join("venv")
            .join("bin")
            .join("python");
        if venv_python.exists() {
            return venv_python;
        }
        let windows_venv_python = home
            .join(".backboard")
            .join("venv")
            .join("Scripts")
            .join("python.exe");
        if windows_venv_python.exists() {
            return windows_venv_python;
        }
    }

    PathBuf::from("python3")
}

fn zed_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_backboard_paths_from_zed_checkout() {
        assert!(bridge_script_path().ends_with("script/backboard-ide-acp.py"));
        assert!(backboard_cli_root().ends_with("cli"));
    }
}
