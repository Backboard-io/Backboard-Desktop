pub use ::backboard::{
    BackboardClient, BackboardConfig, CreateAssistantRequest, DEV_API_URL, LOCAL_API_URL,
    PROD_API_URL, RecentUsageQuery, SendMessageRequest, SubmitToolOutputsRequest,
    UpdateAssistantRequest,
};

use crate::{AgentServer, AgentServerDelegate};
use acp_thread::AgentConnection;
use agent_client_protocol::schema as acp;
use anyhow::Result;
use gpui::{App, Entity, Task};
use project::{AgentId, Project};
use std::{any::Any, rc::Rc};
use ui::IconName;

pub const BACKBOARD_AGENT_ID: &str = "backboard";
pub const BACKBOARD_AGENT_NAME: &str = "Backboard";

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
        _delegate: AgentServerDelegate,
        _project: Entity<Project>,
        cx: &mut App,
    ) -> Task<Result<Rc<dyn AgentConnection>>> {
        let agent_id = self.agent_id();
        let default_mode = self.default_mode(cx);

        log::info!(
            "Backboard IDE runtime: using native Rust AgentConnection, not Python ACP/CLI bridge"
        );
        Task::ready(Ok(Rc::new(
            crate::backboard_native::BackboardNativeConnection::new(agent_id, default_mode),
        )))
    }

    fn into_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }
}
