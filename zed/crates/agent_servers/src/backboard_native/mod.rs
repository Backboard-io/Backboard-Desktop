mod index;
mod session_store;
mod stream;
mod tool_schemas;
mod tools;
mod workspace;

use std::{
    any::Any,
    cell::RefCell,
    collections::BTreeSet,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use ::backboard::{BackboardClient, BackboardConfig};
use acp_thread::{
    AcpThread, AgentConnection, AgentModelInfo, AgentModelList, AgentSessionConfigOptions,
    AgentSessionInfo, AgentSessionList, AgentSessionListRequest, AgentSessionListResponse,
    AgentSessionModes, UserMessageId,
};
use action_log::ActionLog;
use agent_client_protocol::schema as acp;
use anyhow::{Context as _, Result, anyhow};
use chrono::Utc;
use collections::{HashMap, IndexMap};
use gpui::{App, AppContext as _, Entity, SharedString, Task, WeakEntity};
use project::{AgentId, Project};
use serde_json::{Map, Value, json};
use ui::IconName;
use util::path_list::PathList;
use uuid::Uuid;

const BACKBOARD_TELEMETRY_ID: &str = "backboard-native";
const DEFAULT_PROVIDER: &str = "openai";
const DEFAULT_MODEL: &str = "gpt-4o";
const DEFAULT_INTENSITY: &str = "fast";
const DEFAULT_CONTEXT_WINDOW: u64 = 258_000;
const HISTORY_REPLAY_MAX_MESSAGES: usize = 80;
pub(crate) const DEFAULT_IMAGE_PROVIDER: &str = "openrouter";
pub(crate) const DEFAULT_IMAGE_MODEL: &str = "google/gemini-3.1-flash-image-preview";
pub(crate) const DEFAULT_TTS_PROVIDER: &str = "openai";
pub(crate) const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub(crate) const DEFAULT_TTS_VOICE: &str = "alloy";
pub(crate) const DEFAULT_TTS_FORMAT: &str = "mp3";
pub(crate) const DEFAULT_STT_PROVIDER: &str = "openai";
pub(crate) const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub(crate) const DEFAULT_STT_LANGUAGE: &str = "en";
pub(crate) const DEFAULT_REALTIME_STT_PROVIDER: &str = "elevenlabs";
pub(crate) const DEFAULT_REALTIME_STT_MODEL: &str = "scribe_v2_realtime";

static EMPTY_AUTH_METHODS: &[acp::AuthMethod] = &[];

pub struct BackboardNativeConnection {
    state: Rc<BackboardNativeState>,
}

pub(crate) struct BackboardNativeState {
    agent_id: AgentId,
    default_mode: acp::SessionModeId,
    sessions: RefCell<HashMap<acp::SessionId, NativeSession>>,
    indexing_workspaces: RefCell<BTreeSet<PathBuf>>,
    model_cache: RefCell<Option<Vec<AgentModelInfo>>>,
    model_context_windows: RefCell<HashMap<String, u64>>,
    prompt_capabilities: acp::PromptCapabilities,
}

pub(crate) struct NativeSession {
    thread: WeakEntity<AcpThread>,
    workspace: std::path::PathBuf,
    assistant_id: Option<String>,
    thread_id: Option<String>,
    current_run_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    mode: acp::SessionModeId,
    intensity: String,
    feature_settings: FeatureSettings,
    cancel_flag: Arc<AtomicBool>,
    metrics: NativeTurnMetrics,
    context_window_tokens: Option<u64>,
    estimated_used_tokens: u64,
}

#[derive(Clone)]
pub(crate) struct SessionRuntime {
    pub session_id: acp::SessionId,
    pub thread: WeakEntity<AcpThread>,
    pub workspace: std::path::PathBuf,
    pub provider: String,
    pub model: String,
    pub mode: acp::SessionModeId,
    pub intensity: String,
    pub feature_settings: FeatureSettings,
    pub cancel_flag: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FeatureSettings {
    pub web_search: String,
    pub image_generation: String,
    pub voice_mode: String,
    pub live_voice: String,
}

impl Default for FeatureSettings {
    fn default() -> Self {
        Self {
            web_search: "off".to_string(),
            image_generation: "off".to_string(),
            voice_mode: "off".to_string(),
            live_voice: "off".to_string(),
        }
    }
}

#[derive(Default)]
pub(crate) struct NativeTurnMetrics {
    turn_started_at: Option<Instant>,
    first_token_seen: bool,
    timings_ms: HashMap<String, f64>,
    totals_ms: HashMap<String, f64>,
    counts: HashMap<String, u64>,
    slowest_tool: Option<String>,
    slowest_tool_ms: f64,
}

impl NativeTurnMetrics {
    fn reset(&mut self) {
        *self = Self {
            turn_started_at: Some(Instant::now()),
            ..Self::default()
        };
    }

    fn record_timing(&mut self, key: &str, started_at: Instant) {
        self.timings_ms
            .insert(key.to_string(), rounded_ms(started_at.elapsed()));
    }

    fn add_duration_ms(&mut self, key: &str, duration_ms: f64) {
        *self.totals_ms.entry(key.to_string()).or_insert(0.0) += duration_ms;
    }

    fn add_timing(&mut self, key: &str, started_at: Instant) {
        self.add_duration_ms(key, rounded_ms(started_at.elapsed()));
    }

    fn mark_first_token(&mut self) -> bool {
        if self.first_token_seen {
            return false;
        }
        self.first_token_seen = true;
        if let Some(started_at) = self.turn_started_at {
            self.timings_ms.insert(
                "first_token_ms".to_string(),
                rounded_ms(started_at.elapsed()),
            );
        }
        true
    }

    fn record_tool_duration(&mut self, tool_name: &str, duration_ms: f64) {
        let (total_key, count_key) = tool_metric_bucket(tool_name);
        self.add_duration_ms(total_key, duration_ms);
        *self.counts.entry(count_key.to_string()).or_insert(0) += 1;
        *self
            .counts
            .entry("tool_calls_count".to_string())
            .or_insert(0) += 1;
        if duration_ms >= self.slowest_tool_ms {
            self.slowest_tool_ms = duration_ms;
            self.slowest_tool = Some(tool_name.to_string());
        }
    }

    fn speed_meta(&self, runtime: &SessionRuntime) -> Value {
        let mut object = Map::new();
        object.insert("model".to_string(), runtime.model.clone().into());
        object.insert("provider".to_string(), runtime.provider.clone().into());
        object.insert("intensity".to_string(), runtime.intensity.clone().into());

        for (key, value) in &self.timings_ms {
            object.insert(key.clone(), json!(*value));
        }
        for (key, value) in &self.totals_ms {
            object.insert(key.clone(), json!(rounded_number(*value)));
        }
        for (key, value) in &self.counts {
            object.insert(key.clone(), json!(*value));
        }
        if let Some(started_at) = self.turn_started_at {
            object.insert(
                "total_turn_ms".to_string(),
                json!(rounded_ms(started_at.elapsed())),
            );
        }
        if let Some(tool_name) = &self.slowest_tool {
            object.insert("slowest_tool".to_string(), tool_name.clone().into());
            object.insert(
                "slowest_tool_ms".to_string(),
                json!(rounded_number(self.slowest_tool_ms)),
            );
        }
        Value::Object(object)
    }
}

fn tool_metric_bucket(tool_name: &str) -> (&'static str, &'static str) {
    match tool_name {
        "bash" | "run_terminal_cmd" | "run_code" | "repl" | "computer" => {
            ("shell_tools_ms", "shell_tools_count")
        }
        "read_file" | "list_dir" | "read_lints" => ("read_tools_ms", "read_tools_count"),
        "glob" | "glob_file_search" | "grep" | "codebase_search" | "web_search" | "web_fetch" => {
            ("search_tools_ms", "search_tools_count")
        }
        "write" | "edit" | "search_replace" | "delete_file" | "create_directory" => {
            ("edit_tools_ms", "edit_tools_count")
        }
        _ => ("other_tools_ms", "other_tools_count"),
    }
}

pub(crate) fn rounded_ms(duration: std::time::Duration) -> f64 {
    rounded_number(duration.as_secs_f64() * 1000.0)
}

fn rounded_number(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn model_context_key(provider: &str, model: &str) -> String {
    format!(
        "{}/{}",
        provider.trim().to_lowercase(),
        model.trim().to_lowercase()
    )
}

fn inferred_context_window(provider: &str, model: &str) -> u64 {
    let provider = provider.to_lowercase();
    let model = model.to_lowercase().replace('_', "-");
    if model.contains("claude") && model.contains("4-6") {
        1_000_000
    } else if provider.contains("google") || model.contains("gemini") {
        1_000_000
    } else if model.contains("gpt-4.1") {
        1_047_576
    } else if model.contains("claude") {
        200_000
    } else if model.contains("o3") || model.contains("o4") {
        200_000
    } else if model.contains("gpt-4o") {
        128_000
    } else {
        DEFAULT_CONTEXT_WINDOW
    }
}

impl BackboardNativeConnection {
    pub fn new(agent_id: AgentId, default_mode: Option<acp::SessionModeId>) -> Self {
        log::info!(
            "Backboard native runtime initialized; Python ACP/CLI bridge is not in the active path"
        );
        Self {
            state: Rc::new(BackboardNativeState {
                agent_id,
                default_mode: default_mode.unwrap_or_else(|| acp::SessionModeId::new("free")),
                sessions: RefCell::default(),
                indexing_workspaces: RefCell::default(),
                model_cache: RefCell::default(),
                model_context_windows: RefCell::default(),
                prompt_capabilities: acp::PromptCapabilities::new()
                    .embedded_context(true)
                    .image(true)
                    .audio(true),
            }),
        }
    }
}

impl BackboardNativeState {
    pub(crate) fn load_config(&self) -> BackboardConfig {
        BackboardConfig::load_or_default()
    }

    pub(crate) fn client(&self) -> Result<(BackboardConfig, BackboardClient)> {
        let config = BackboardConfig::load()?;
        let client = BackboardClient::from_config(config.clone())?;
        Ok((config, client))
    }

    pub(crate) fn fallback_provider_model(config: &BackboardConfig) -> (String, String) {
        (
            config
                .default_provider
                .clone()
                .unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
            config
                .default_model
                .clone()
                .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        )
    }

    pub(crate) fn runtime_for_session(
        &self,
        session_id: &acp::SessionId,
    ) -> Result<SessionRuntime> {
        let config = self.load_config();
        let (default_provider, default_model) = Self::fallback_provider_model(&config);
        let sessions = self.sessions.borrow();
        let session = sessions
            .get(session_id)
            .with_context(|| format!("unknown Backboard session: {session_id}"))?;
        Ok(SessionRuntime {
            session_id: session_id.clone(),
            thread: session.thread.clone(),
            workspace: session.workspace.clone(),
            provider: session.provider.clone().unwrap_or(default_provider),
            model: session.model.clone().unwrap_or(default_model),
            mode: session.mode.clone(),
            intensity: session.intensity.clone(),
            feature_settings: session.feature_settings.clone(),
            cancel_flag: session.cancel_flag.clone(),
        })
    }

    pub(crate) fn session_thread_id(&self, session_id: &acp::SessionId) -> Option<String> {
        self.sessions
            .borrow()
            .get(session_id)
            .and_then(|session| session.thread_id.clone())
    }

    pub(crate) fn set_current_run_id(&self, session_id: &acp::SessionId, run_id: Option<String>) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.current_run_id = run_id;
        }
    }

    pub(crate) fn reset_turn_metrics(&self, session_id: &acp::SessionId) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.metrics.reset();
            session.estimated_used_tokens = 0;
        }
    }

    pub(crate) fn set_estimated_used_tokens(&self, session_id: &acp::SessionId, tokens: u64) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.estimated_used_tokens = tokens;
        }
    }

    pub(crate) fn record_turn_timing(
        &self,
        session_id: &acp::SessionId,
        key: &str,
        started_at: Instant,
    ) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.metrics.record_timing(key, started_at);
        }
    }

    pub(crate) fn add_turn_timing(
        &self,
        session_id: &acp::SessionId,
        key: &str,
        started_at: Instant,
    ) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.metrics.add_timing(key, started_at);
        }
    }

    pub(crate) fn add_turn_duration_ms(
        &self,
        session_id: &acp::SessionId,
        key: &str,
        duration_ms: f64,
    ) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.metrics.add_duration_ms(key, duration_ms);
        }
    }

    pub(crate) fn mark_first_token(&self, session_id: &acp::SessionId) -> bool {
        self.sessions
            .borrow_mut()
            .get_mut(session_id)
            .is_some_and(|session| session.metrics.mark_first_token())
    }

    pub(crate) fn record_tool_duration_ms(
        &self,
        session_id: &acp::SessionId,
        tool_name: &str,
        duration_ms: f64,
    ) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session
                .metrics
                .record_tool_duration(tool_name, rounded_number(duration_ms));
        }
    }

    pub(crate) fn speed_meta(&self, runtime: &SessionRuntime) -> Value {
        self.sessions
            .borrow()
            .get(&runtime.session_id)
            .map(|session| session.metrics.speed_meta(runtime))
            .unwrap_or_else(|| {
                json!({
                    "model": runtime.model.clone(),
                    "provider": runtime.provider.clone(),
                    "intensity": runtime.intensity.clone(),
                })
            })
    }

    pub(crate) fn usage_snapshot(&self, runtime: &SessionRuntime) -> (u64, u64) {
        let sessions = self.sessions.borrow();
        let used = sessions
            .get(&runtime.session_id)
            .map(|session| session.estimated_used_tokens)
            .unwrap_or(0);
        let size = sessions
            .get(&runtime.session_id)
            .and_then(|session| session.context_window_tokens)
            .or_else(|| {
                self.model_context_windows
                    .borrow()
                    .get(&model_context_key(&runtime.provider, &runtime.model))
                    .copied()
            })
            .unwrap_or_else(|| inferred_context_window(&runtime.provider, &runtime.model));
        (used.min(size), size)
    }

    pub(crate) fn context_window_for_runtime(&self, runtime: &SessionRuntime) -> u64 {
        self.usage_snapshot(runtime).1
    }

    fn remember_model_context_window(&self, provider: &str, model: &str, context_window: u64) {
        if context_window == 0 {
            return;
        }
        let key = model_context_key(provider, model);
        self.model_context_windows
            .borrow_mut()
            .insert(key, context_window);
        for session in self.sessions.borrow_mut().values_mut() {
            if session.provider.as_deref() == Some(provider)
                && session.model.as_deref() == Some(model)
            {
                session.context_window_tokens = Some(context_window);
            }
        }
    }

    fn prepare_workspace_and_start_indexing(self: &Rc<Self>, workspace: PathBuf, cx: &mut App) {
        let workspace_key = index::workspace_key(&workspace);
        if !self
            .indexing_workspaces
            .borrow_mut()
            .insert(workspace_key.clone())
        {
            return;
        }

        let state = self.clone();
        cx.spawn(async move |cx| {
            let workspace_for_task = workspace.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    index::prepare_workspace(&workspace_for_task)?;
                    index::build_workspace_index(&workspace_for_task)?;
                    anyhow::Ok(())
                })
                .await;

            state
                .indexing_workspaces
                .borrow_mut()
                .remove(&workspace_key);
            if let Err(error) = result {
                log::debug!(
                    "Backboard native workspace indexing failed for {}: {error:#}",
                    workspace.display()
                );
            }
        })
        .detach();
    }

    pub(crate) fn emit_update(
        &self,
        runtime: &SessionRuntime,
        update: acp::SessionUpdate,
        cx: &mut gpui::AsyncApp,
    ) -> Result<()> {
        runtime
            .thread
            .update(cx, |thread, cx| thread.handle_session_update(update, cx))
            .map_err(|err| anyhow!(err))?
            .map_err(|err| anyhow!("{err:?}"))
    }

    async fn ensure_thread_binding(
        self: Rc<Self>,
        session_id: &acp::SessionId,
        cx: &mut gpui::AsyncApp,
    ) -> Result<String> {
        if let Some(thread_id) = self.session_thread_id(session_id) {
            return Ok(thread_id);
        }

        let runtime = self.runtime_for_session(session_id)?;
        let (_config, client) = self.client()?;
        let mode = runtime.mode.to_string();
        let request = ::backboard::CreateAssistantRequest {
            name: "Backboard IDE Agent".to_string(),
            description: workspace::system_prompt(&runtime.workspace),
            tools: Some(tool_schemas::tool_definitions(&mode)),
            custom_fact_extraction_prompt: None,
            custom_update_memory_prompt: None,
        };
        log::info!(
            "Backboard native endpoint call: POST /assistants then POST /assistants/{{assistant_id}}/threads session_id={} provider={} model={} mode={}",
            session_id,
            runtime.provider,
            runtime.model,
            runtime.mode
        );
        let (assistant_id, thread_id) = gpui_tokio::Tokio::spawn_result(cx, async move {
            let assistant = client.create_assistant(request).await?;
            let assistant_id = json_string(&assistant, &["assistant_id", "id"])
                .context("Backboard create assistant response did not include assistant_id")?;
            let thread = client.create_thread(&assistant_id).await?;
            let thread_id = json_string(&thread, &["thread_id", "id"])
                .context("Backboard create thread response did not include thread_id")?;
            anyhow::Ok((assistant_id, thread_id))
        })
        .await?;

        let record = session_store::SessionRecord {
            workspace: runtime.workspace.to_string_lossy().to_string(),
            assistant_id: Some(assistant_id.clone()),
            thread_id: Some(thread_id.clone()),
            provider: Some(runtime.provider.clone()),
            model: Some(runtime.model.clone()),
            title: runtime
                .workspace
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Backboard")
                .to_string(),
            session_id: session_id.to_string(),
            updated_at: Utc::now().to_rfc3339(),
        };
        session_store::write_session_record(&session_id.to_string(), &record).ok();
        session_store::write_workspace_record(&runtime.workspace, &record).ok();

        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.assistant_id = Some(assistant_id);
            session.thread_id = Some(thread_id.clone());
        }

        self.emit_update(
            &runtime,
            acp::SessionUpdate::SessionInfoUpdate(
                acp::SessionInfoUpdate::new()
                    .title(record.title)
                    .updated_at(record.updated_at),
            ),
            cx,
        )
        .ok();

        Ok(thread_id)
    }
}

impl AgentConnection for BackboardNativeConnection {
    fn agent_id(&self) -> AgentId {
        self.state.agent_id.clone()
    }

    fn telemetry_id(&self) -> SharedString {
        BACKBOARD_TELEMETRY_ID.into()
    }

    fn agent_version(&self) -> Option<SharedString> {
        Some("native-rust".into())
    }

    fn new_session(
        self: Rc<Self>,
        project: Entity<Project>,
        work_dirs: PathList,
        cx: &mut App,
    ) -> Task<Result<Entity<AcpThread>>> {
        let work_dirs = non_empty_work_dirs_or_project_default(work_dirs, &project, cx);
        let Some(workspace) = work_dirs.ordered_paths().next().cloned() else {
            return Task::ready(Err(anyhow!("Working directory cannot be empty")));
        };
        let session_id = acp::SessionId::new(format!("backboard-{}", Uuid::new_v4().simple()));
        let mode = self.state.default_mode.clone();
        let config = self.state.load_config();
        let (provider, model) = BackboardNativeState::fallback_provider_model(&config);
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let action_log = cx.new(|_| ActionLog::new(project.clone()));
        let thread = cx.new(|cx| {
            AcpThread::new(
                None,
                None,
                Some(work_dirs.clone()),
                self.clone(),
                project.clone(),
                action_log,
                session_id.clone(),
                watch::Receiver::constant(self.state.prompt_capabilities.clone()),
                cx,
            )
        });

        self.state.sessions.borrow_mut().insert(
            session_id,
            NativeSession {
                thread: thread.downgrade(),
                workspace: workspace.clone(),
                assistant_id: None,
                thread_id: None,
                current_run_id: None,
                provider: Some(provider),
                model: Some(model),
                mode,
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                cancel_flag,
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
            },
        );
        self.state
            .prepare_workspace_and_start_indexing(workspace, cx);

        Task::ready(Ok(thread))
    }

    fn supports_load_session(&self) -> bool {
        true
    }

    fn load_session(
        self: Rc<Self>,
        session_id: acp::SessionId,
        project: Entity<Project>,
        work_dirs: PathList,
        title: Option<SharedString>,
        cx: &mut App,
    ) -> Task<Result<Entity<AcpThread>>> {
        self.create_loaded_session(session_id, project, work_dirs, title, true, cx)
    }

    fn supports_close_session(&self) -> bool {
        true
    }

    fn close_session(
        self: Rc<Self>,
        session_id: &acp::SessionId,
        _cx: &mut App,
    ) -> Task<Result<()>> {
        self.state.sessions.borrow_mut().remove(session_id);
        Task::ready(Ok(()))
    }

    fn supports_resume_session(&self) -> bool {
        true
    }

    fn resume_session(
        self: Rc<Self>,
        session_id: acp::SessionId,
        project: Entity<Project>,
        work_dirs: PathList,
        title: Option<SharedString>,
        cx: &mut App,
    ) -> Task<Result<Entity<AcpThread>>> {
        self.create_loaded_session(session_id, project, work_dirs, title, false, cx)
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        EMPTY_AUTH_METHODS
    }

    fn authenticate(&self, _method: acp::AuthMethodId, _cx: &mut App) -> Task<Result<()>> {
        Task::ready(Ok(()))
    }

    fn prompt(
        &self,
        user_message_id: UserMessageId,
        params: acp::PromptRequest,
        cx: &mut App,
    ) -> Task<Result<acp::PromptResponse>> {
        let state = self.state.clone();
        cx.spawn(async move |cx| stream::run_prompt(state, user_message_id, params, cx).await)
    }

    fn cancel(&self, session_id: &acp::SessionId, cx: &mut App) {
        let Some((thread_id, run_id, cancel_flag)) =
            self.state.sessions.borrow().get(session_id).map(|session| {
                (
                    session.thread_id.clone(),
                    session.current_run_id.clone(),
                    session.cancel_flag.clone(),
                )
            })
        else {
            return;
        };
        cancel_flag.store(true, Ordering::SeqCst);

        if let (Some(thread_id), Some(run_id)) = (thread_id, run_id) {
            let Ok((_config, client)) = self.state.client() else {
                return;
            };
            log::info!(
                "Backboard native endpoint call: POST /threads/{{thread_id}}/runs/{{run_id}}/cancel session_id={} thread_id={} run_id={}",
                session_id,
                thread_id,
                run_id
            );
            gpui_tokio::Tokio::spawn_result(cx, async move {
                let _ = client.cancel_run(&thread_id, &run_id).await;
                anyhow::Ok(())
            })
            .detach();
        }
    }

    fn model_selector(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Rc<dyn acp_thread::AgentModelSelector>> {
        Some(Rc::new(BackboardModelSelector {
            state: self.state.clone(),
            session_id: session_id.clone(),
        }))
    }

    fn session_modes(
        &self,
        session_id: &acp::SessionId,
        _cx: &App,
    ) -> Option<Rc<dyn AgentSessionModes>> {
        Some(Rc::new(BackboardSessionModes {
            state: self.state.clone(),
            session_id: session_id.clone(),
        }))
    }

    fn session_config_options(
        &self,
        session_id: &acp::SessionId,
        _cx: &App,
    ) -> Option<Rc<dyn AgentSessionConfigOptions>> {
        Some(Rc::new(BackboardConfigOptions {
            state: self.state.clone(),
            session_id: session_id.clone(),
        }))
    }

    fn session_list(&self, _cx: &mut App) -> Option<Rc<dyn AgentSessionList>> {
        Some(Rc::new(BackboardSessionList {
            state: self.state.clone(),
        }))
    }

    fn into_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }
}

impl BackboardNativeConnection {
    fn create_loaded_session(
        self: Rc<Self>,
        session_id: acp::SessionId,
        project: Entity<Project>,
        work_dirs: PathList,
        title: Option<SharedString>,
        replay_history: bool,
        cx: &mut App,
    ) -> Task<Result<Entity<AcpThread>>> {
        let work_dirs = non_empty_work_dirs_or_project_default(work_dirs, &project, cx);
        let Some(workspace) = work_dirs.ordered_paths().next().cloned() else {
            return Task::ready(Err(anyhow!("Working directory cannot be empty")));
        };

        let record = session_store::record_for_session_or_workspace(&session_id, &workspace);
        let config = self.state.load_config();
        let (default_provider, default_model) =
            BackboardNativeState::fallback_provider_model(&config);
        let action_log = cx.new(|_| ActionLog::new(project.clone()));
        let thread = cx.new(|cx| {
            AcpThread::new(
                None,
                title,
                Some(work_dirs.clone()),
                self.clone(),
                project.clone(),
                action_log,
                session_id.clone(),
                watch::Receiver::constant(self.state.prompt_capabilities.clone()),
                cx,
            )
        });

        self.state.sessions.borrow_mut().insert(
            session_id.clone(),
            NativeSession {
                thread: thread.downgrade(),
                workspace: workspace.clone(),
                assistant_id: record
                    .as_ref()
                    .and_then(|record| record.assistant_id.clone()),
                thread_id: record.as_ref().and_then(|record| record.thread_id.clone()),
                current_run_id: None,
                provider: record
                    .as_ref()
                    .and_then(|record| record.provider.clone())
                    .or(Some(default_provider)),
                model: record
                    .as_ref()
                    .and_then(|record| record.model.clone())
                    .or(Some(default_model)),
                mode: self.state.default_mode.clone(),
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                cancel_flag: Arc::new(AtomicBool::new(false)),
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
            },
        );
        self.state
            .prepare_workspace_and_start_indexing(workspace.clone(), cx);

        if replay_history {
            let state = self.state.clone();
            let thread_entity = thread.clone();
            cx.spawn(async move |cx| {
                stream::replay_history(state, &session_id, thread_entity.downgrade(), cx).await?;
                anyhow::Ok(())
            })
            .detach();
        }

        Task::ready(Ok(thread))
    }
}

struct BackboardSessionModes {
    state: Rc<BackboardNativeState>,
    session_id: acp::SessionId,
}

impl AgentSessionModes for BackboardSessionModes {
    fn current_mode(&self) -> acp::SessionModeId {
        self.state
            .sessions
            .borrow()
            .get(&self.session_id)
            .map(|session| session.mode.clone())
            .unwrap_or_else(|| acp::SessionModeId::new("free"))
    }

    fn all_modes(&self) -> Vec<acp::SessionMode> {
        supported_modes()
    }

    fn set_mode(&self, mode: acp::SessionModeId, cx: &mut App) -> Task<Result<()>> {
        let mode = if supported_modes().iter().any(|item| item.id == mode) {
            mode
        } else {
            acp::SessionModeId::new("free")
        };
        if let Some(session) = self.state.sessions.borrow_mut().get_mut(&self.session_id) {
            session.mode = mode.clone();
        }
        let state = self.state.clone();
        let session_id = self.session_id.clone();
        cx.spawn(async move |cx| {
            let runtime = state.runtime_for_session(&session_id)?;
            state.emit_update(
                &runtime,
                acp::SessionUpdate::CurrentModeUpdate(acp::CurrentModeUpdate::new(mode)),
                cx,
            )?;
            Ok(())
        })
    }
}

struct BackboardConfigOptions {
    state: Rc<BackboardNativeState>,
    session_id: acp::SessionId,
}

impl AgentSessionConfigOptions for BackboardConfigOptions {
    fn config_options(&self) -> Vec<acp::SessionConfigOption> {
        let (intensity, feature_settings) = self
            .state
            .sessions
            .borrow()
            .get(&self.session_id)
            .map(|session| (session.intensity.clone(), session.feature_settings.clone()))
            .unwrap_or_else(|| (DEFAULT_INTENSITY.to_string(), FeatureSettings::default()));
        config_options(&intensity, &feature_settings)
    }

    fn set_config_option(
        &self,
        config_id: acp::SessionConfigId,
        value: acp::SessionConfigValueId,
        cx: &mut App,
    ) -> Task<Result<Vec<acp::SessionConfigOption>>> {
        let value = value.to_string();
        let mut options = self.config_options();
        let config_id_string = config_id.to_string();
        let mut changed = false;
        {
            if let Some(session) = self.state.sessions.borrow_mut().get_mut(&self.session_id) {
                match config_id_string.as_str() {
                    "backboard_intensity" => {
                        session.intensity =
                            if matches!(value.as_str(), "fast" | "balanced" | "deep") {
                                value
                            } else {
                                DEFAULT_INTENSITY.to_string()
                            };
                        changed = true;
                    }
                    "backboard_web_search" => {
                        session.feature_settings.web_search =
                            if value == "Auto" { "Auto" } else { "off" }.to_string();
                        changed = true;
                    }
                    "backboard_image_generation" => {
                        session.feature_settings.image_generation =
                            if value == "auto" { "auto" } else { "off" }.to_string();
                        changed = true;
                    }
                    "backboard_voice_mode" => {
                        session.feature_settings.voice_mode =
                            if matches!(value.as_str(), "tts" | "stt" | "conversation") {
                                value
                            } else {
                                "off".to_string()
                            };
                        changed = true;
                    }
                    "backboard_live_voice" => {
                        session.feature_settings.live_voice =
                            if value == "on" { "on" } else { "off" }.to_string();
                        changed = true;
                    }
                    _ => {}
                }
            }
        }
        if changed {
            options = self.config_options();
            let state = self.state.clone();
            let session_id = self.session_id.clone();
            let options_for_update = options.clone();
            cx.spawn(async move |cx| {
                let runtime = state.runtime_for_session(&session_id)?;
                state.emit_update(
                    &runtime,
                    acp::SessionUpdate::ConfigOptionUpdate(acp::ConfigOptionUpdate::new(
                        options_for_update,
                    )),
                    cx,
                )?;
                anyhow::Ok(())
            })
            .detach();
        }
        Task::ready(Ok(options))
    }
}

struct BackboardModelSelector {
    state: Rc<BackboardNativeState>,
    session_id: acp::SessionId,
}

impl acp_thread::AgentModelSelector for BackboardModelSelector {
    fn list_models(&self, cx: &mut App) -> Task<Result<AgentModelList>> {
        let state = self.state.clone();
        cx.spawn(async move |cx| {
            if let Some(models) = state.model_cache.borrow().clone() {
                return Ok(AgentModelList::Grouped(group_models(models)));
            }

            let models = match state.client() {
                Ok((_config, client)) => {
                    log::info!(
                        "Backboard native endpoint call: GET /models?model_type=llm&limit=15000 agent_id={}",
                        state.agent_id
                    );
                    let models = gpui_tokio::Tokio::spawn_result(cx, async move {
                        client.list_models(None, Some("llm"), Some(15_000)).await
                    })
                    .await?;
                    models
                        .into_iter()
                        .filter(|model| !model.provider.is_empty() && !model.name.is_empty())
                        .map(|model| {
                            if let Some(context_limit) = model.context_limit {
                                state.remember_model_context_window(
                                    &model.provider,
                                    &model.name,
                                    context_limit,
                                );
                            }
                            let id = format!("{}/{}", model.provider, model.name);
                            let mut info = AgentModelInfo {
                                id: acp::ModelId::new(id),
                                name: model
                                    .display_name
                                    .unwrap_or_else(|| model.name.clone())
                                    .into(),
                                description: Some(model.provider.clone().into()),
                                icon: Some(acp_thread::AgentModelIcon::Named(IconName::Sparkle)),
                                is_latest: false,
                                cost: None,
                            };
                            if let (Some(input), Some(output)) = (
                                model.input_cost_per_1m_tokens,
                                model.output_cost_per_1m_tokens,
                            ) {
                                info.cost =
                                    Some(format!("${input:.2}/M in, ${output:.2}/M out").into());
                            }
                            info
                        })
                        .collect::<Vec<_>>()
                }
                Err(_) => {
                    let config = state.load_config();
                    let (provider, model) = BackboardNativeState::fallback_provider_model(&config);
                    vec![AgentModelInfo {
                        id: acp::ModelId::new(format!("{provider}/{model}")),
                        name: model.into(),
                        description: Some(provider.into()),
                        icon: Some(acp_thread::AgentModelIcon::Named(IconName::Sparkle)),
                        is_latest: false,
                        cost: None,
                    }]
                }
            };
            *state.model_cache.borrow_mut() = Some(models.clone());
            Ok(AgentModelList::Grouped(group_models(models)))
        })
    }

    fn select_model(&self, model_id: acp::ModelId, _cx: &mut App) -> Task<Result<()>> {
        let model_id = model_id.to_string();
        let (provider, model) = split_model_id(&model_id);
        if let Some(session) = self.state.sessions.borrow_mut().get_mut(&self.session_id) {
            session.provider = Some(provider.clone());
            session.model = Some(model.clone());
            session.context_window_tokens = self
                .state
                .model_context_windows
                .borrow()
                .get(&model_context_key(&provider, &model))
                .copied();
            if let (Some(assistant_id), Some(thread_id)) =
                (session.assistant_id.clone(), session.thread_id.clone())
            {
                let record = session_store::SessionRecord {
                    workspace: session.workspace.to_string_lossy().to_string(),
                    assistant_id: Some(assistant_id),
                    thread_id: Some(thread_id),
                    provider: Some(provider.clone()),
                    model: Some(model.clone()),
                    title: session
                        .workspace
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Backboard")
                        .to_string(),
                    session_id: self.session_id.to_string(),
                    updated_at: Utc::now().to_rfc3339(),
                };
                session_store::write_session_record(&self.session_id.to_string(), &record).ok();
                session_store::write_workspace_record(&session.workspace, &record).ok();
            }
        }
        BackboardConfig::save_model_selection(provider, model).ok();
        Task::ready(Ok(()))
    }

    fn selected_model(&self, _cx: &mut App) -> Task<Result<AgentModelInfo>> {
        let config = self.state.load_config();
        let (default_provider, default_model) =
            BackboardNativeState::fallback_provider_model(&config);
        let (provider, model) = self
            .state
            .sessions
            .borrow()
            .get(&self.session_id)
            .map(|session| {
                (
                    session.provider.clone().unwrap_or(default_provider),
                    session.model.clone().unwrap_or(default_model),
                )
            })
            .unwrap_or((DEFAULT_PROVIDER.to_string(), DEFAULT_MODEL.to_string()));
        Task::ready(Ok(AgentModelInfo {
            id: acp::ModelId::new(format!("{provider}/{model}")),
            name: model.into(),
            description: Some(provider.into()),
            icon: Some(acp_thread::AgentModelIcon::Named(IconName::Sparkle)),
            is_latest: false,
            cost: None,
        }))
    }
}

struct BackboardSessionList {
    state: Rc<BackboardNativeState>,
}

impl AgentSessionList for BackboardSessionList {
    fn list_sessions(
        &self,
        request: AgentSessionListRequest,
        _cx: &mut App,
    ) -> Task<Result<AgentSessionListResponse>> {
        let sessions = session_store::workspace_records(request.cwd.as_deref())
            .into_iter()
            .map(|record| {
                let mut info = AgentSessionInfo::new(record.session_id);
                info.title = Some(record.title.into());
                info.work_dirs = Some(PathList::new(&[std::path::PathBuf::from(record.workspace)]));
                info
            })
            .collect();
        Task::ready(Ok(AgentSessionListResponse::new(sessions)))
    }

    fn notify_refresh(&self) {
        self.state.model_cache.borrow_mut().take();
    }

    fn into_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }
}

fn non_empty_work_dirs_or_project_default(
    work_dirs: PathList,
    project: &Entity<Project>,
    cx: &App,
) -> PathList {
    if work_dirs.is_empty() {
        project.read(cx).default_path_list(cx)
    } else {
        work_dirs
    }
}

fn supported_modes() -> Vec<acp::SessionMode> {
    vec![
        acp::SessionMode::new("agent", "Agent")
            .description("Autonomous edits, terminal commands, indexing, and memories."),
        acp::SessionMode::new("ask", "Ask")
            .description("Read, search, and explain without file writes or shell mutation."),
        acp::SessionMode::new("manual", "Manual")
            .description("Focused edit proposals with explicit diff review."),
        acp::SessionMode::new("free", "Full Access").description(
            "Unrestricted tool access. Terminal commands run without approval prompts.",
        ),
    ]
}

fn config_options(
    intensity: &str,
    feature_settings: &FeatureSettings,
) -> Vec<acp::SessionConfigOption> {
    vec![
        acp::SessionConfigOption::select(
            "backboard_intensity",
            "Intensity",
            intensity.to_string(),
            vec![
                acp::SessionConfigSelectOption::new("fast", "Fast")
                    .description("Prioritize quick streaming and skip extended thinking."),
                acp::SessionConfigSelectOption::new("balanced", "Balanced")
                    .description("Use a small thinking budget when the model supports it."),
                acp::SessionConfigSelectOption::new("deep", "Deep")
                    .description("Use deeper reasoning settings for harder work."),
            ],
        )
        .description("Controls how much extended model thinking Backboard asks for.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_web_search",
            "Web",
            feature_settings.web_search.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not ask Backboard to run web search for this turn."),
                acp::SessionConfigSelectOption::new("Auto", "Auto")
                    .description("Let Backboard use web search when useful."),
            ],
        )
        .description("Controls Backboard web search for each chat turn.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_image_generation",
            "Image",
            feature_settings.image_generation.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not enable the built-in image tool."),
                acp::SessionConfigSelectOption::new("auto", "Auto").description(
                    "Let Backboard call the image generator when the prompt asks for images.",
                ),
            ],
        )
        .description("Enables Backboard image generation for this turn.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_voice_mode",
            "Voice",
            feature_settings.voice_mode.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Send normal text-only chat turns."),
                acp::SessionConfigSelectOption::new("tts", "TTS")
                    .description("Ask Backboard to synthesize the assistant reply as audio."),
                acp::SessionConfigSelectOption::new("stt", "STT")
                    .description("Transcribe attached audio without an assistant reply."),
                acp::SessionConfigSelectOption::new("conversation", "Conversation").description(
                    "Transcribe attached audio, send it to the LLM, and synthesize audio.",
                ),
            ],
        )
        .description("Controls Backboard REST voice mode.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_live_voice",
            "Live Voice",
            feature_settings.live_voice.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not start a realtime voice session."),
                acp::SessionConfigSelectOption::new("on", "On").description(
                    "Prepare Backboard realtime voice settings for live microphone chat.",
                ),
            ],
        )
        .description("Controls Backboard realtime voice WebSocket mode.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
    ]
}

fn group_models(
    models: Vec<AgentModelInfo>,
) -> IndexMap<acp_thread::AgentModelGroupName, Vec<AgentModelInfo>> {
    let mut groups = IndexMap::default();
    for model in models {
        let group = model
            .description
            .clone()
            .unwrap_or_else(|| SharedString::from("Models"));
        groups
            .entry(acp_thread::AgentModelGroupName(group))
            .or_insert_with(Vec::new)
            .push(model);
    }
    groups
}

fn split_model_id(model_id: &str) -> (String, String) {
    model_id
        .split_once('/')
        .map(|(provider, model)| (provider.to_string(), model.to_string()))
        .unwrap_or_else(|| (DEFAULT_PROVIDER.to_string(), model_id.to_string()))
}

fn json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn missing_api_key_message() -> String {
    "Backboard needs an API key before the IDE agent can run. Set it in the shared config with `backboard config set-api-key <key>`.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_options_include_media_and_search_chips() {
        let settings = FeatureSettings {
            web_search: "Auto".to_string(),
            image_generation: "auto".to_string(),
            voice_mode: "tts".to_string(),
            live_voice: "on".to_string(),
        };
        let options = config_options("fast", &settings);
        let ids = options
            .iter()
            .map(|option| option.id.to_string())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"backboard_intensity".to_string()));
        assert!(ids.contains(&"backboard_web_search".to_string()));
        assert!(ids.contains(&"backboard_image_generation".to_string()));
        assert!(ids.contains(&"backboard_voice_mode".to_string()));
        assert!(ids.contains(&"backboard_live_voice".to_string()));
    }
}
