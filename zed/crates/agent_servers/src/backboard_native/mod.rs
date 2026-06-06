mod mcp;
mod stream;
mod tool_schemas;
mod tools;
mod workspace;

use std::{
    any::Any,
    cell::RefCell,
    collections::BTreeSet,
    fs,
    io::{ErrorKind, Read as _},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use ::backboard::{BackboardClient, BackboardConfig, BackboardModel};
use acp_thread::{
    AcpThread, AgentConnection, AgentModelInfo, AgentModelList, AgentSessionConfigOptions,
    AgentSessionList, AgentSessionListRequest, AgentSessionListResponse, AgentSessionModes,
    AgentSessionTruncate, AuthRequired, UserMessageId,
};
use action_log::ActionLog;
use agent_client_protocol::schema as acp;
use anyhow::{Context as _, Result, anyhow};
use collections::{HashMap, IndexMap};
use futures::{
    FutureExt as _, StreamExt as _,
    future::{LocalBoxFuture, Shared},
};
use gpui::{App, AppContext as _, Entity, SharedString, Task, WeakEntity};
use language_model::icon_for_model_identifiers;
use project::{AgentId, Project, context_server_store::ContextServerStore};
use serde_json::{Map, Value, json};
use ui::IconName;
use util::path_list::PathList;
use uuid::Uuid;
use walkdir::WalkDir;

const BACKBOARD_TELEMETRY_ID: &str = "backboard-native";
const DEFAULT_PROVIDER: &str = "openai";
const DEFAULT_MODEL: &str = "gpt-4o";
const DEFAULT_INTENSITY: &str = "fast";
const DEFAULT_CONTEXT_WINDOW: u64 = 258_000;
const BACKBOARD_SKILL_CONFIG_PREFIX: &str = "backboard_skill:";
const MODEL_CATALOG_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "xai",
    "deepseek",
    "openrouter",
    "aws-bedrock",
    "cohere",
    "cerebras",
    "mistral",
    "groq",
    "together",
    "fireworks",
    "perplexity",
];
const MODEL_CATALOG_PROVIDER_CONCURRENCY: usize = 4;
const TOOL_INCOMPATIBLE_MODELS: &[(&str, &str)] = &[
    ("cerebras", "meta-llama/llama-3.1-8b-instruct"),
    ("cerebras", "qwen/qwen3-235b-a22b-2507"),
    ("cohere", "command-a-03-2025"),
    ("cohere", "command-a-reasoning-08-2025"),
    ("cohere", "command-a-translate-08-2025"),
    ("cohere", "command-r-08-2024"),
    ("cohere", "command-r-plus-08-2024"),
    ("cohere", "command-r7b-12-2024"),
    ("openai", "gpt-5-chat-latest"),
    ("openai", "o1-pro"),
    ("openrouter", "ai21/jamba-large-1.7"),
    ("openrouter", "aion-labs/aion-1.0"),
    ("openrouter", "aion-labs/aion-1.0-mini"),
    ("openrouter", "aion-labs/aion-2.0"),
    ("openrouter", "aion-labs/aion-rp-llama-3.1-8b"),
    ("openrouter", "alfredpros/codellama-7b-instruct-solidity"),
    ("openrouter", "anthracite-org/magnum-v4-72b"),
    ("openrouter", "arcee-ai/maestro-reasoning"),
    ("openrouter", "arcee-ai/spotlight"),
    ("openrouter", "arcee-ai/trinity-large-thinking"),
    ("openrouter", "arcee-ai/trinity-large-thinking:free"),
    ("openrouter", "arcee-ai/virtuoso-large"),
    ("openrouter", "baidu/cobuddy:free"),
    ("openrouter", "baidu/ernie-4.5-21b-a3b"),
    ("openrouter", "baidu/ernie-4.5-21b-a3b-thinking"),
    ("openrouter", "baidu/ernie-4.5-300b-a47b"),
    ("openrouter", "baidu/ernie-4.5-vl-28b-a3b"),
    ("openrouter", "baidu/ernie-4.5-vl-424b-a47b"),
    ("openrouter", "baidu/qianfan-ocr-fast"),
    ("openrouter", "bytedance/ui-tars-1.5-7b"),
    (
        "openrouter",
        "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
    ),
    ("openrouter", "cohere/command-a"),
    ("openrouter", "cohere/command-r-08-2024"),
    ("openrouter", "cohere/command-r-plus-08-2024"),
    ("openrouter", "cohere/command-r7b-12-2024"),
    ("openrouter", "deepcogito/cogito-v2.1-671b"),
    ("openrouter", "deepseek/deepseek-r1-distill-llama-70b"),
    ("openrouter", "deepseek/deepseek-r1-distill-qwen-32b"),
    ("openrouter", "deepseek/deepseek-v3.2-speciale"),
    ("openrouter", "deepseek/deepseek-v4-flash:free"),
    ("openrouter", "google/gemini-2.0-flash-001"),
    ("openrouter", "google/gemini-2.0-flash-lite-001"),
    ("openrouter", "google/gemma-2-27b-it"),
    ("openrouter", "google/gemma-3-27b-it"),
    ("openrouter", "google/gemma-3-4b-it"),
    ("openrouter", "google/gemma-3n-e4b-it"),
    ("openrouter", "google/gemma-4-26b-a4b-it:free"),
    ("openrouter", "google/gemma-4-31b-it:free"),
    ("openrouter", "gryphe/mythomax-l2-13b"),
    ("openrouter", "ibm-granite/granite-4.0-h-micro"),
    ("openrouter", "inflection/inflection-3-pi"),
    ("openrouter", "inflection/inflection-3-productivity"),
    ("openrouter", "liquid/lfm-2-24b-a2b"),
    ("openrouter", "liquid/lfm-2.5-1.2b-instruct:free"),
    ("openrouter", "liquid/lfm-2.5-1.2b-thinking:free"),
    ("openrouter", "mancer/weaver"),
    ("openrouter", "meta-llama/llama-3-70b-instruct"),
    ("openrouter", "meta-llama/llama-3-8b-instruct"),
    ("openrouter", "meta-llama/llama-3.2-11b-vision-instruct"),
    ("openrouter", "meta-llama/llama-3.2-1b-instruct"),
    ("openrouter", "meta-llama/llama-3.2-3b-instruct"),
    ("openrouter", "meta-llama/llama-3.2-3b-instruct:free"),
    ("openrouter", "meta-llama/llama-3.3-70b-instruct:free"),
    ("openrouter", "meta-llama/llama-4-maverick"),
    ("openrouter", "meta-llama/llama-guard-3-8b"),
    ("openrouter", "meta-llama/llama-guard-4-12b"),
    ("openrouter", "microsoft/phi-4"),
    ("openrouter", "microsoft/phi-4-mini-instruct"),
    ("openrouter", "microsoft/wizardlm-2-8x22b"),
    ("openrouter", "minimax/minimax-01"),
    ("openrouter", "minimax/minimax-m2-her"),
    ("openrouter", "mistralai/devstral-medium"),
    ("openrouter", "mistralai/devstral-small"),
    ("openrouter", "mistralai/mistral-7b-instruct-v0.1"),
    ("openrouter", "mistralai/mistral-large-2411"),
    ("openrouter", "mistralai/mistral-medium-3-5"),
    ("openrouter", "mistralai/mistral-small-24b-instruct-2501"),
    ("openrouter", "mistralai/mistral-small-3.1-24b-instruct"),
    ("openrouter", "mistralai/pixtral-large-2411"),
    ("openrouter", "mistralai/voxtral-small-24b-2507"),
    ("openrouter", "morph/morph-v3-fast"),
    ("openrouter", "morph/morph-v3-large"),
    ("openrouter", "nousresearch/hermes-2-pro-llama-3-8b"),
    ("openrouter", "nousresearch/hermes-3-llama-3.1-405b"),
    ("openrouter", "nousresearch/hermes-3-llama-3.1-405b:free"),
    ("openrouter", "nousresearch/hermes-3-llama-3.1-70b"),
    ("openrouter", "nousresearch/hermes-4-405b"),
    ("openrouter", "nousresearch/hermes-4-70b"),
    ("openrouter", "openai/gpt-3.5-turbo-instruct"),
    ("openrouter", "openai/gpt-4o-mini-search-preview"),
    ("openrouter", "openai/gpt-4o-search-preview"),
    ("openrouter", "openai/gpt-5-chat"),
    ("openrouter", "openai/gpt-5.1-codex-max"),
    ("openrouter", "openai/gpt-oss-safeguard-20b"),
    ("openrouter", "openai/o1-pro"),
    ("openrouter", "openai/o3-deep-research"),
    ("openrouter", "openai/o4-mini-deep-research"),
    ("openrouter", "openrouter/bodybuilder"),
    ("openrouter", "openrouter/free"),
    ("openrouter", "openrouter/owl-alpha"),
    ("openrouter", "openrouter/pareto-code"),
    ("openrouter", "perceptron/perceptron-mk1"),
    ("openrouter", "perplexity/sonar"),
    ("openrouter", "perplexity/sonar-deep-research"),
    ("openrouter", "perplexity/sonar-pro"),
    ("openrouter", "perplexity/sonar-pro-search"),
    ("openrouter", "perplexity/sonar-reasoning-pro"),
    ("openrouter", "qwen/qwen-2.5-7b-instruct"),
    ("openrouter", "qwen/qwen-2.5-coder-32b-instruct"),
    ("openrouter", "qwen/qwen2.5-vl-72b-instruct"),
    ("openrouter", "qwen/qwen3-14b"),
    ("openrouter", "qwen/qwen3-coder:free"),
    ("openrouter", "qwen/qwen3-next-80b-a3b-instruct:free"),
    ("openrouter", "rekaai/reka-edge"),
    ("openrouter", "rekaai/reka-flash-3"),
    ("openrouter", "relace/relace-apply-3"),
    ("openrouter", "sao10k/l3-euryale-70b"),
    ("openrouter", "sao10k/l3-lunaris-8b"),
    ("openrouter", "sao10k/l3.1-70b-hanami-x1"),
    ("openrouter", "sao10k/l3.1-euryale-70b"),
    ("openrouter", "sao10k/l3.3-euryale-70b"),
    ("openrouter", "switchpoint/router"),
    ("openrouter", "tencent/hunyuan-a13b-instruct"),
    ("openrouter", "thedrummer/cydonia-24b-v4.1"),
    ("openrouter", "thedrummer/rocinante-12b"),
    ("openrouter", "thedrummer/skyfall-36b-v2"),
    ("openrouter", "thedrummer/unslopnemo-12b"),
    ("openrouter", "undi95/remm-slerp-l2-13b"),
    ("openrouter", "writer/palmyra-x5"),
    ("openrouter", "x-ai/grok-4.20-multi-agent"),
    ("openrouter", "xiaomi/mimo-v2-omni"),
    ("openrouter", "xiaomi/mimo-v2-pro"),
    ("xai", "grok-4.20-multi-agent-0309"),
];
type SharedModelCatalogTask =
    Shared<LocalBoxFuture<'static, std::result::Result<Vec<BackboardModel>, Arc<anyhow::Error>>>>;
pub(crate) const DEFAULT_IMAGE_PROVIDER: &str = "openrouter";
pub(crate) const DEFAULT_IMAGE_MODEL: &str = "google/gemini-3.1-flash-image-preview";
pub(crate) const DEFAULT_TTS_PROVIDER: &str = "openai";
pub(crate) const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub(crate) const DEFAULT_TTS_VOICE: &str = "alloy";
pub(crate) const DEFAULT_TTS_FORMAT: &str = "mp3";
pub(crate) const DEFAULT_STT_PROVIDER: &str = "openai";
pub(crate) const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub(crate) const DEFAULT_STT_LANGUAGE: &str = "en";
pub(crate) const DEFAULT_REALTIME_STT_MODEL: &str = "scribe_v2_realtime";
const MAX_NATIVE_SNAPSHOT_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_NATIVE_SNAPSHOT_PATHS: usize = 4096;

static EMPTY_AUTH_METHODS: &[acp::AuthMethod] = &[];

pub struct BackboardNativeConnection {
    state: Rc<BackboardNativeState>,
}

pub(crate) struct BackboardNativeState {
    agent_id: AgentId,
    default_mode: acp::SessionModeId,
    sessions: RefCell<HashMap<acp::SessionId, NativeSession>>,
    client_cache: RefCell<Option<CachedBackboardClient>>,
    model_cache: RefCell<Option<Vec<AgentModelInfo>>>,
    model_catalog_task: RefCell<Option<(u64, SharedModelCatalogTask)>>,
    next_model_catalog_task_id: RefCell<u64>,
    model_context_windows: RefCell<HashMap<String, u64>>,
    model_pricing: RefCell<HashMap<String, BackboardModelPricing>>,
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
    rewound_history_context: Option<String>,
    active_user_message_id: Option<UserMessageId>,
    native_snapshots: Vec<NativeTurnSnapshot>,
    context_server_store: Option<Entity<ContextServerStore>>,
    mcp_tools: Vec<mcp::NativeMcpTool>,
    config_tx: watch::Sender<()>,
    config_rx: watch::Receiver<()>,
    cancel_flag: Arc<AtomicBool>,
    metrics: NativeTurnMetrics,
    context_window_tokens: Option<u64>,
    estimated_used_tokens: u64,
    session_total_cost: f64,
}

#[derive(Clone)]
struct CachedBackboardClient {
    base_url: String,
    api_key: String,
    client: BackboardClient,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct BackboardModelPricing {
    input_cost_per_1m_tokens: f64,
    output_cost_per_1m_tokens: f64,
}

#[derive(Clone, Debug)]
struct NativeTurnSnapshot {
    user_message_id: UserMessageId,
    paths: IndexMap<PathBuf, NativePathSnapshot>,
}

#[derive(Clone, Debug)]
enum NativePathSnapshot {
    Missing,
    Directory,
    File(Vec<u8>),
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
    pub context_server_store: Option<Entity<ContextServerStore>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FeatureSettings {
    pub web_search: String,
    pub image_generation: String,
    pub voice_mode: String,
    pub live_voice: String,
    pub mcp_figma: String,
    pub mcp_notion: String,
    pub mcp_google: String,
    pub selected_skills: Vec<String>,
}

impl Default for FeatureSettings {
    fn default() -> Self {
        Self {
            web_search: "off".to_string(),
            image_generation: "off".to_string(),
            voice_mode: "off".to_string(),
            live_voice: "off".to_string(),
            mcp_figma: "auto".to_string(),
            mcp_notion: "off".to_string(),
            mcp_google: "off".to_string(),
            selected_skills: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileSystemSkill {
    pub relative_path: String,
    pub path: PathBuf,
    pub name: String,
    pub description: Option<String>,
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
        "bash" | "run_terminal_cmd" | "read_lints" | "run_code" | "repl" | "computer" => {
            ("shell_tools_ms", "shell_tools_count")
        }
        "read_file" | "list_dir" => ("read_tools_ms", "read_tools_count"),
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

fn round_cost(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
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
        #[cfg(not(test))]
        cleanup_obsolete_home_session_store();
        Self {
            state: Rc::new(BackboardNativeState {
                agent_id,
                default_mode: default_mode.unwrap_or_else(|| acp::SessionModeId::new("free")),
                sessions: RefCell::default(),
                client_cache: RefCell::default(),
                model_cache: RefCell::default(),
                model_catalog_task: RefCell::default(),
                next_model_catalog_task_id: RefCell::default(),
                model_context_windows: RefCell::default(),
                model_pricing: RefCell::default(),
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

    pub(crate) fn has_api_key(&self) -> bool {
        self.load_config().api_key().is_some()
    }

    pub(crate) fn client(&self) -> Result<(BackboardConfig, BackboardClient)> {
        let config = BackboardConfig::load()?;
        let base_url = config.base_url();
        let api_key = config
            .api_key()
            .ok_or(::backboard::BackboardError::MissingApiKey)?;
        if let Some(cache) = self.client_cache.borrow().as_ref()
            && cache.base_url == base_url
            && cache.api_key == api_key
        {
            return Ok((config, cache.client.clone()));
        }

        let client = BackboardClient::new(base_url.clone(), api_key.clone());
        *self.client_cache.borrow_mut() = Some(CachedBackboardClient {
            base_url,
            api_key,
            client: client.clone(),
        });
        Ok((config, client))
    }

    fn warm_client(self: &Rc<Self>, cx: &mut App) {
        let Ok((_config, client)) = self.client() else {
            return;
        };
        cx.spawn(async move |cx| {
            let result =
                gpui_tokio::Tokio::spawn_result(cx, async move { client.warm_connection().await })
                    .await;
            if let Err(error) = result {
                log::debug!("Backboard native connection preconnect failed: {error:#}");
            }
        })
        .detach();
    }

    pub(crate) fn fallback_provider_model(_config: &BackboardConfig) -> (String, String) {
        (DEFAULT_PROVIDER.to_string(), DEFAULT_MODEL.to_string())
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
            context_server_store: session.context_server_store.clone(),
        })
    }

    pub(crate) fn set_mcp_tools(
        &self,
        session_id: &acp::SessionId,
        mcp_tools: Vec<mcp::NativeMcpTool>,
    ) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.mcp_tools = mcp_tools;
        }
    }

    pub(crate) fn mcp_tools(&self, session_id: &acp::SessionId) -> Vec<mcp::NativeMcpTool> {
        self.sessions
            .borrow()
            .get(session_id)
            .map(|session| session.mcp_tools.clone())
            .unwrap_or_default()
    }

    pub(crate) fn mcp_tool_for_name(
        &self,
        session_id: &acp::SessionId,
        name: &str,
    ) -> Option<mcp::NativeMcpTool> {
        self.sessions
            .borrow()
            .get(session_id)?
            .mcp_tools
            .iter()
            .find(|tool| tool.generated_name == name)
            .cloned()
    }

    pub(crate) fn take_rewound_history_context(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<String> {
        self.sessions
            .borrow_mut()
            .get_mut(session_id)
            .and_then(|session| session.rewound_history_context.take())
    }

    pub(crate) fn session_thread_id(&self, session_id: &acp::SessionId) -> Option<String> {
        self.sessions
            .borrow()
            .get(session_id)
            .and_then(|session| session.thread_id.clone())
    }

    pub(crate) fn record_message_thread_binding(
        &self,
        session_id: &acp::SessionId,
        binding: ::backboard::MessageThreadBinding,
    ) -> Option<String> {
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.get_mut(session_id)?;
        if let Some(assistant_id) = binding.assistant_id {
            session.assistant_id = Some(assistant_id);
        }
        if let Some(thread_id) = binding.thread_id {
            if session.thread_id.as_deref() != Some(thread_id.as_str()) {
                log::info!(
                    "Backboard native session bound to remote thread: session_id={} thread_id={}",
                    session_id,
                    thread_id
                );
            }
            session.thread_id = Some(thread_id);
        }
        session.thread_id.clone()
    }

    pub(crate) fn set_current_run_id(&self, session_id: &acp::SessionId, run_id: Option<String>) {
        if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
            session.current_run_id = run_id;
        }
    }

    pub(crate) fn begin_turn(&self, session_id: &acp::SessionId, user_message_id: UserMessageId) {
        let mut sessions = self.sessions.borrow_mut();
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        session.active_user_message_id = Some(user_message_id.clone());
        if session
            .native_snapshots
            .iter()
            .all(|snapshot| snapshot.user_message_id != user_message_id)
        {
            session.native_snapshots.push(NativeTurnSnapshot {
                user_message_id,
                paths: IndexMap::default(),
            });
        }
    }

    pub(crate) fn record_path_before_mutation(
        &self,
        session_id: &acp::SessionId,
        path: &Path,
    ) -> Result<()> {
        self.record_paths_before_mutation(session_id, path, false)
    }

    pub(crate) fn record_path_tree_before_mutation(
        &self,
        session_id: &acp::SessionId,
        path: &Path,
    ) -> Result<()> {
        self.record_paths_before_mutation(session_id, path, true)
    }

    fn record_paths_before_mutation(
        &self,
        session_id: &acp::SessionId,
        path: &Path,
        include_tree: bool,
    ) -> Result<()> {
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("unknown Backboard session: {session_id}"))?;
        let workspace = session.workspace.clone();
        let Some(snapshot) = active_native_snapshot_mut(session) else {
            return Ok(());
        };

        record_missing_parent_dirs(snapshot, &workspace, path)?;
        if include_tree && path.is_dir() {
            for entry in WalkDir::new(path).follow_links(false).into_iter() {
                let entry = entry?;
                record_native_path_snapshot(snapshot, entry.path())?;
            }
        } else {
            record_native_path_snapshot(snapshot, path)?;
        }
        Ok(())
    }

    fn prepare_truncate(
        &self,
        session_id: &acp::SessionId,
        message_id: &UserMessageId,
        cx: &App,
    ) -> Result<()> {
        let thread = self
            .sessions
            .borrow()
            .get(session_id)
            .with_context(|| format!("unknown Backboard session: {session_id}"))?
            .thread
            .clone();

        let rewound_history_context = thread.upgrade().and_then(|thread| {
            let thread = thread.read(cx);
            let target_index = thread.entries().iter().position(|entry| {
                matches!(
                    entry,
                    acp_thread::AgentThreadEntry::UserMessage(message)
                        if message.id.as_ref() == Some(message_id)
                )
            })?;
            let context = thread.entries()[..target_index]
                .iter()
                .filter(|entry| {
                    matches!(
                        entry,
                        acp_thread::AgentThreadEntry::UserMessage(_)
                            | acp_thread::AgentThreadEntry::AssistantMessage(_)
                    )
                })
                .map(|entry| entry.to_markdown(cx))
                .collect::<String>();
            (!context.trim().is_empty()).then_some(context)
        });

        let native_restore_paths = {
            let mut sessions = self.sessions.borrow_mut();
            let session = sessions
                .get_mut(session_id)
                .with_context(|| format!("unknown Backboard session: {session_id}"))?;
            session.current_run_id = None;
            session.cancel_flag.store(true, Ordering::SeqCst);
            session.estimated_used_tokens = 0;
            session.rewound_history_context = rewound_history_context;
            session.active_user_message_id = None;
            take_native_restore_paths(session, message_id)
        };

        restore_native_paths(native_restore_paths)?;

        Ok(())
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

    fn remember_model_pricing(&self, provider: &str, model: &str, pricing: BackboardModelPricing) {
        if !pricing.input_cost_per_1m_tokens.is_finite()
            || !pricing.output_cost_per_1m_tokens.is_finite()
            || pricing.input_cost_per_1m_tokens < 0.0
            || pricing.output_cost_per_1m_tokens < 0.0
        {
            return;
        }

        self.model_pricing
            .borrow_mut()
            .insert(model_context_key(provider, model), pricing);
    }

    pub(crate) fn estimated_turn_cost(
        &self,
        runtime: &SessionRuntime,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Option<f64> {
        let pricing = self
            .model_pricing
            .borrow()
            .get(&model_context_key(&runtime.provider, &runtime.model))
            .copied()?;
        let cost = (input_tokens as f64 * pricing.input_cost_per_1m_tokens
            + output_tokens as f64 * pricing.output_cost_per_1m_tokens)
            / 1_000_000.0;
        (cost.is_finite() && cost >= 0.0).then(|| round_cost(cost))
    }

    pub(crate) fn add_session_cost_delta(
        &self,
        session_id: &acp::SessionId,
        delta: f64,
    ) -> Option<f64> {
        if !delta.is_finite() {
            return None;
        }

        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.get_mut(session_id)?;
        session.session_total_cost = round_cost((session.session_total_cost + delta).max(0.0));
        Some(session.session_total_cost)
    }

    pub(crate) fn session_total_cost(&self, session_id: &acp::SessionId) -> Option<f64> {
        self.sessions
            .borrow()
            .get(session_id)
            .map(|session| session.session_total_cost)
    }

    fn cleanup_obsolete_workspace_storage(&self, workspace: &Path) {
        cleanup_obsolete_path(workspace.join(".backboard"));
        cleanup_obsolete_path(workspace.join(".backboard_index"));
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
}

fn active_native_snapshot_mut(session: &mut NativeSession) -> Option<&mut NativeTurnSnapshot> {
    let user_message_id = session.active_user_message_id.clone()?;
    if let Some(ix) = session
        .native_snapshots
        .iter()
        .position(|snapshot| snapshot.user_message_id == user_message_id)
    {
        return session.native_snapshots.get_mut(ix);
    }

    session.native_snapshots.push(NativeTurnSnapshot {
        user_message_id,
        paths: IndexMap::default(),
    });
    session.native_snapshots.last_mut()
}

fn record_missing_parent_dirs(
    snapshot: &mut NativeTurnSnapshot,
    workspace: &Path,
    path: &Path,
) -> Result<()> {
    let mut parent = path.parent();
    while let Some(dir) = parent {
        if dir == workspace {
            break;
        }
        if dir.starts_with(workspace) && !dir.exists() {
            record_native_path_snapshot(snapshot, dir)?;
        }
        parent = dir.parent();
    }
    Ok(())
}

fn record_native_path_snapshot(snapshot: &mut NativeTurnSnapshot, path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    if snapshot.paths.contains_key(&path) {
        return Ok(());
    }
    if snapshot.paths.len() >= MAX_NATIVE_SNAPSHOT_PATHS {
        log::warn!(
            "Backboard native mutation snapshot path limit reached; skipping {}",
            path.display()
        );
        return Ok(());
    }
    let Some(path_snapshot) = native_path_snapshot(&path)? else {
        return Ok(());
    };
    snapshot.paths.insert(path, path_snapshot);
    Ok(())
}

fn native_path_snapshot(path: &Path) -> Result<Option<NativePathSnapshot>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(Some(NativePathSnapshot::Missing));
        }
        Err(error) => {
            return Err(error).with_context(|| format!("snapshotting {}", path.display()));
        }
    };

    if metadata.is_dir() {
        return Ok(Some(NativePathSnapshot::Directory));
    }
    if metadata.is_file() {
        if metadata.len() > MAX_NATIVE_SNAPSHOT_FILE_BYTES {
            log::warn!(
                "Backboard native mutation snapshot skipped large file {} ({} bytes)",
                path.display(),
                metadata.len()
            );
            return Ok(None);
        }
        let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        return Ok(Some(NativePathSnapshot::File(bytes)));
    }

    Ok(None)
}

fn take_native_restore_paths(
    session: &mut NativeSession,
    message_id: &UserMessageId,
) -> IndexMap<PathBuf, NativePathSnapshot> {
    let Some(start_ix) = session
        .native_snapshots
        .iter()
        .position(|snapshot| &snapshot.user_message_id == message_id)
    else {
        return IndexMap::default();
    };

    let snapshots = session
        .native_snapshots
        .drain(start_ix..)
        .collect::<Vec<_>>();
    let mut paths = IndexMap::default();
    for snapshot in snapshots {
        for (path, path_snapshot) in snapshot.paths {
            if !paths.contains_key(&path) {
                paths.insert(path, path_snapshot);
            }
        }
    }
    paths
}

fn restore_native_paths(paths: IndexMap<PathBuf, NativePathSnapshot>) -> Result<()> {
    let mut missing_paths = Vec::new();

    for (path, path_snapshot) in paths {
        match path_snapshot {
            NativePathSnapshot::File(bytes) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("creating {}", parent.display()))?;
                }
                fs::write(&path, bytes).with_context(|| format!("restoring {}", path.display()))?;
            }
            NativePathSnapshot::Directory => {
                fs::create_dir_all(&path)
                    .with_context(|| format!("restoring directory {}", path.display()))?;
            }
            NativePathSnapshot::Missing => missing_paths.push(path),
        }
    }

    missing_paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in missing_paths {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("checking {}", path.display()));
            }
        };

        if metadata.is_dir() {
            match fs::remove_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    log::warn!(
                        "Backboard native restore left non-empty directory {}: {error:#}",
                        path.display()
                    );
                }
            }
        } else {
            fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        }
    }

    Ok(())
}

fn config_watch_channel() -> (watch::Sender<()>, watch::Receiver<()>) {
    watch::channel(())
}

#[cfg(not(test))]
fn cleanup_obsolete_home_session_store() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    cleanup_obsolete_path(
        PathBuf::from(home)
            .join(".backboard")
            .join("ide_sessions.json"),
    );
}

fn cleanup_obsolete_path(path: PathBuf) {
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!(
                "Backboard native could not inspect obsolete local store {}: {error:#}",
                path.display()
            );
            return;
        }
    };

    let result = if metadata.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    match result {
        Ok(()) => {
            log::info!(
                "Backboard native removed obsolete local store: {}",
                path.display()
            );
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            log::warn!(
                "Backboard native could not remove obsolete local store {}: {error:#}",
                path.display()
            );
        }
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
        if !self.state.has_api_key() {
            return Task::ready(Err(missing_api_key_auth_required().into()));
        }

        let work_dirs = non_empty_work_dirs_or_project_default(work_dirs, &project, cx);
        let Some(workspace) = work_dirs.ordered_paths().next().cloned() else {
            return Task::ready(Err(anyhow!("Working directory cannot be empty")));
        };
        let session_id = acp::SessionId::new(format!("backboard-{}", Uuid::new_v4().simple()));
        log::info!(
            "Backboard native session created: session_id={} workspace={}",
            session_id,
            workspace.display()
        );
        let mode = self.state.default_mode.clone();
        let config = self.state.load_config();
        let (provider, model) = BackboardNativeState::fallback_provider_model(&config);
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (config_tx, config_rx) = config_watch_channel();
        let context_server_store = project.read(cx).context_server_store();
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
                rewound_history_context: None,
                active_user_message_id: None,
                native_snapshots: Vec::new(),
                context_server_store: Some(context_server_store),
                mcp_tools: Vec::new(),
                config_tx,
                config_rx,
                cancel_flag,
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
                session_total_cost: 0.0,
            },
        );
        self.state.cleanup_obsolete_workspace_storage(&workspace);
        self.state.warm_client(cx);

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

    fn update_session_work_dirs(
        &self,
        session_id: &acp::SessionId,
        work_dirs: PathList,
        _cx: &mut App,
    ) -> Task<Result<()>> {
        let Some(workspace) = work_dirs.ordered_paths().next().cloned() else {
            return Task::ready(Ok(()));
        };

        {
            let mut sessions = self.state.sessions.borrow_mut();
            let Some(session) = sessions.get_mut(session_id) else {
                return Task::ready(Err(anyhow!("unknown Backboard session: {session_id}")));
            };
            if session.workspace == workspace {
                return Task::ready(Ok(()));
            }

            log::info!(
                "Backboard native session workspace changed: session_id={} previous_workspace={} workspace={}",
                session_id,
                session.workspace.display(),
                workspace.display()
            );
            session.workspace = workspace.clone();
            session.assistant_id = None;
            session.thread_id = None;
            session.current_run_id = None;
            session.config_tx.send(()).ok();
        }

        self.state.cleanup_obsolete_workspace_storage(&workspace);

        Task::ready(Ok(()))
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
                if let Err(error) = client.cancel_run(&thread_id, &run_id).await {
                    log::warn!(
                        "Backboard native cancel_run failed: thread_id={} run_id={} error={error:#}",
                        thread_id,
                        run_id
                    );
                }
                anyhow::Ok(())
            })
            .detach();
        }
    }

    fn truncate(
        &self,
        session_id: &acp::SessionId,
        _cx: &App,
    ) -> Option<Rc<dyn AgentSessionTruncate>> {
        self.state
            .sessions
            .borrow()
            .contains_key(session_id)
            .then(|| {
                Rc::new(BackboardSessionTruncate {
                    state: self.state.clone(),
                    session_id: session_id.clone(),
                }) as Rc<dyn AgentSessionTruncate>
            })
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
        if !self.state.has_api_key() {
            return Task::ready(Err(missing_api_key_auth_required().into()));
        }

        let work_dirs = non_empty_work_dirs_or_project_default(work_dirs, &project, cx);
        let Some(workspace) = work_dirs.ordered_paths().next().cloned() else {
            return Task::ready(Err(anyhow!("Working directory cannot be empty")));
        };

        log::info!(
            "Backboard native session load requested: session_id={} workspace={} replay_history={}",
            session_id,
            workspace.display(),
            replay_history
        );
        let config = self.state.load_config();
        let (default_provider, default_model) =
            BackboardNativeState::fallback_provider_model(&config);
        let (config_tx, config_rx) = config_watch_channel();
        let context_server_store = project.read(cx).context_server_store();
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
                assistant_id: None,
                thread_id: None,
                current_run_id: None,
                provider: Some(default_provider),
                model: Some(default_model),
                mode: self.state.default_mode.clone(),
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                rewound_history_context: None,
                active_user_message_id: None,
                native_snapshots: Vec::new(),
                context_server_store: Some(context_server_store),
                mcp_tools: Vec::new(),
                config_tx,
                config_rx,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
                session_total_cost: 0.0,
            },
        );
        self.state.cleanup_obsolete_workspace_storage(&workspace);
        self.state.warm_client(cx);

        Task::ready(Ok(thread))
    }
}

struct BackboardSessionTruncate {
    state: Rc<BackboardNativeState>,
    session_id: acp::SessionId,
}

impl AgentSessionTruncate for BackboardSessionTruncate {
    fn run(&self, message_id: UserMessageId, cx: &mut App) -> Task<Result<()>> {
        Task::ready(
            self.state
                .prepare_truncate(&self.session_id, &message_id, cx),
        )
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

impl BackboardConfigOptions {
    fn current_config(&self) -> (String, String, FeatureSettings, Option<PathBuf>) {
        self.state
            .sessions
            .borrow()
            .get(&self.session_id)
            .map(|session| {
                (
                    session.mode.to_string(),
                    session.intensity.clone(),
                    session.feature_settings.clone(),
                    Some(session.workspace.clone()),
                )
            })
            .unwrap_or_else(|| {
                (
                    "free".to_string(),
                    DEFAULT_INTENSITY.to_string(),
                    FeatureSettings::default(),
                    None,
                )
            })
    }
}

impl AgentSessionConfigOptions for BackboardConfigOptions {
    fn config_options(&self) -> Vec<acp::SessionConfigOption> {
        let (mode, intensity, feature_settings, workspace) = self.current_config();
        config_options(&mode, &intensity, &feature_settings, workspace.as_deref())
    }

    fn set_config_option(
        &self,
        config_id: acp::SessionConfigId,
        value: acp::SessionConfigValueId,
        cx: &mut App,
    ) -> Task<Result<Vec<acp::SessionConfigOption>>> {
        let value = value.to_string();
        let config_id_string = config_id.to_string();
        let mut changed = false;
        let mut changed_mode = None;
        {
            if let Some(session) = self.state.sessions.borrow_mut().get_mut(&self.session_id) {
                match config_id_string.as_str() {
                    "backboard_mode" => {
                        let mode = if supported_modes()
                            .iter()
                            .any(|item| item.id.to_string() == value)
                        {
                            value
                        } else {
                            "free".to_string()
                        };
                        session.mode = acp::SessionModeId::new(mode.clone());
                        changed_mode = Some(mode);
                        changed = true;
                    }
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
                    "backboard_mcp_figma" => {
                        session.feature_settings.mcp_figma =
                            if matches!(value.as_str(), "auto" | "on") {
                                value
                            } else {
                                "off".to_string()
                            };
                        changed = true;
                    }
                    "backboard_mcp_notion" => {
                        session.feature_settings.mcp_notion =
                            if value == "on" { "on" } else { "off" }.to_string();
                        changed = true;
                    }
                    "backboard_mcp_google" => {
                        session.feature_settings.mcp_google =
                            if value == "on" { "on" } else { "off" }.to_string();
                        changed = true;
                    }
                    _ if config_id_string.starts_with(BACKBOARD_SKILL_CONFIG_PREFIX) => {
                        let skill_path =
                            config_id_string.trim_start_matches(BACKBOARD_SKILL_CONFIG_PREFIX);
                        let available_skills = discover_file_system_skills(&session.workspace);
                        if available_skills
                            .iter()
                            .any(|skill| skill.relative_path == skill_path)
                        {
                            let selected = &mut session.feature_settings.selected_skills;
                            if value == "on" {
                                if !selected.iter().any(|selected| selected == skill_path) {
                                    selected.push(skill_path.to_string());
                                }
                            } else {
                                selected.retain(|selected| selected != skill_path);
                            }
                            changed = true;
                        }
                    }
                    _ => {}
                }
                if changed {
                    session.config_tx.send(()).ok();
                }
            }
        }
        let options = self.config_options();
        if changed {
            let state = self.state.clone();
            let session_id = self.session_id.clone();
            let options_for_update = options.clone();
            cx.spawn(async move |cx| {
                let runtime = state.runtime_for_session(&session_id)?;
                if let Some(mode) = changed_mode {
                    state.emit_update(
                        &runtime,
                        acp::SessionUpdate::CurrentModeUpdate(acp::CurrentModeUpdate::new(mode)),
                        cx,
                    )?;
                }
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

    fn watch(&self, _cx: &mut App) -> Option<watch::Receiver<()>> {
        self.state
            .sessions
            .borrow()
            .get(&self.session_id)
            .map(|session| session.config_rx.clone())
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

            let (models, should_cache) = match state.client() {
                Ok((_config, client)) => {
                    let (catalog_task_id, catalog_task) = {
                        if let Some((task_id, task)) = state.model_catalog_task.borrow().clone() {
                            (task_id, task)
                        } else {
                            log::info!(
                                "Backboard native endpoint call: GET /models?model_type=llm&limit=15000 plus provider-scoped model catalogs agent_id={}",
                                state.agent_id
                            );
                            let task = gpui_tokio::Tokio::spawn_result(cx, async move {
                                list_backboard_model_catalog(client).await
                            })
                            .map(|result| result.map_err(Arc::new))
                            .boxed_local()
                            .shared();
                            let task_id = {
                                let mut next_task_id = state.next_model_catalog_task_id.borrow_mut();
                                *next_task_id = next_task_id.saturating_add(1);
                                *next_task_id
                            };
                            *state.model_catalog_task.borrow_mut() = Some((task_id, task.clone()));
                            (task_id, task)
                        }
                    };
                    let catalog_result = catalog_task.await;
                    {
                        let mut model_catalog_task = state.model_catalog_task.borrow_mut();
                        if model_catalog_task
                            .as_ref()
                            .is_some_and(|(task_id, _)| *task_id == catalog_task_id)
                        {
                            model_catalog_task.take();
                        }
                    }
                    let models = match catalog_result {
                        Ok(models) => models,
                        Err(error) => {
                            log::warn!("failed to load Backboard model catalog: {error:#}");
                            Vec::new()
                        }
                    };
                    let models = models
                        .into_iter()
                        .filter(|model| !model.provider.is_empty() && !model.name.is_empty())
                        .filter(|model| !is_featherless_backboard_model(model))
                        .filter(|model| !is_tool_incompatible_backboard_model(model))
                        .map(|model| {
                            if let Some(context_limit) = model.context_limit {
                                state.remember_model_context_window(
                                    &model.provider,
                                    &model.name,
                                    context_limit,
                                );
                            }
                            if let (Some(input_cost_per_1m_tokens), Some(output_cost_per_1m_tokens)) = (
                                model.input_cost_per_1m_tokens,
                                model.output_cost_per_1m_tokens,
                            ) {
                                state.remember_model_pricing(
                                    &model.provider,
                                    &model.name,
                                    BackboardModelPricing {
                                        input_cost_per_1m_tokens,
                                        output_cost_per_1m_tokens,
                                    },
                                );
                            }
                            let id = format!("{}/{}", model.provider, model.name);
                            let display_name = model
                                .display_name
                                .clone()
                                .unwrap_or_else(|| model.name.clone());
                            let mut info = AgentModelInfo {
                                id: acp::ModelId::new(id),
                                name: display_name.clone().into(),
                                description: Some(model.provider.clone().into()),
                                icon: Some(model_icon(&model.provider, &model.name, Some(&display_name))),
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
                        .collect::<Vec<_>>();
                    if models.is_empty() {
                        let config = state.load_config();
                        let (provider, model) =
                            BackboardNativeState::fallback_provider_model(&config);
                        log::warn!(
                            "Backboard model catalog returned no usable models; using uncached fallback model {provider}/{model}"
                        );
                        (vec![fallback_agent_model_info(&config)], false)
                    } else {
                        log::info!(
                            "Backboard model catalog loaded {} usable models agent_id={}",
                            models.len(),
                            state.agent_id
                        );
                        (models, true)
                    }
                }
                Err(_) => {
                    let config = state.load_config();
                    let (provider, model) = BackboardNativeState::fallback_provider_model(&config);
                    log::warn!(
                        "Backboard model catalog unavailable; using uncached fallback model {provider}/{model}"
                    );
                    (vec![fallback_agent_model_info(&config)], false)
                }
            };
            if should_cache {
                *state.model_cache.borrow_mut() = Some(models.clone());
            }
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
        }
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
        let icon = model_icon(&provider, &model, None);
        Task::ready(Ok(AgentModelInfo {
            id: acp::ModelId::new(format!("{provider}/{model}")),
            name: model.into(),
            description: Some(provider.into()),
            icon: Some(icon),
            is_latest: false,
            cost: None,
        }))
    }
}

fn fallback_agent_model_info(config: &BackboardConfig) -> AgentModelInfo {
    let (provider, model) = BackboardNativeState::fallback_provider_model(config);
    let icon = model_icon(&provider, &model, None);
    AgentModelInfo {
        id: acp::ModelId::new(format!("{provider}/{model}")),
        name: model.into(),
        description: Some(provider.into()),
        icon: Some(icon),
        is_latest: false,
        cost: None,
    }
}

fn is_featherless_backboard_model(model: &BackboardModel) -> bool {
    let provider = model.provider.to_lowercase();
    let name = model.name.to_lowercase();
    let display_name = model
        .display_name
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    provider.contains("featherless")
        || name.contains("featherless")
        || display_name.contains("featherless")
}

fn is_tool_incompatible_backboard_model(model: &BackboardModel) -> bool {
    TOOL_INCOMPATIBLE_MODELS.iter().any(|(provider, name)| {
        model.provider.eq_ignore_ascii_case(provider) && model.name.eq_ignore_ascii_case(name)
    })
}

fn model_icon(
    provider: &str,
    model: &str,
    display_name: Option<&str>,
) -> acp_thread::AgentModelIcon {
    acp_thread::AgentModelIcon::Named(
        icon_for_model_identifiers(provider, provider, model, display_name.unwrap_or(model))
            .unwrap_or(IconName::Sparkle),
    )
}

struct BackboardSessionList {
    state: Rc<BackboardNativeState>,
}

impl AgentSessionList for BackboardSessionList {
    fn list_sessions(
        &self,
        _request: AgentSessionListRequest,
        _cx: &mut App,
    ) -> Task<Result<AgentSessionListResponse>> {
        Task::ready(Ok(AgentSessionListResponse::new(Vec::new())))
    }

    fn notify_refresh(&self) {
        self.state.model_cache.borrow_mut().take();
        self.state.model_catalog_task.borrow_mut().take();
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
        acp::SessionMode::new("agent", "Agent").description(
            "Autonomous edits, terminal commands, and memory isolated to this remote thread.",
        ),
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
    mode: &str,
    intensity: &str,
    feature_settings: &FeatureSettings,
    workspace: Option<&Path>,
) -> Vec<acp::SessionConfigOption> {
    let mut options = vec![
        acp::SessionConfigOption::select(
            "backboard_mode",
            "Mode",
            mode.to_string(),
            vec![
                acp::SessionConfigSelectOption::new("agent", "Agent")
                    .description("Autonomous edits, terminal commands, and thread-scoped memory."),
                acp::SessionConfigSelectOption::new("ask", "Ask").description(
                    "Read, search, and explain without file writes or shell mutation.",
                ),
                acp::SessionConfigSelectOption::new("manual", "Manual")
                    .description("Focused edit proposals with explicit diff review."),
                acp::SessionConfigSelectOption::new("free", "Full Access").description(
                    "Unrestricted tool access. Terminal commands run without approval prompts.",
                ),
            ],
        )
        .description("Controls how much autonomy Backboard has for this session.")
        .category(acp::SessionConfigOptionCategory::Mode),
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
        acp::SessionConfigOption::select(
            "backboard_mcp_figma",
            "Figma Links",
            feature_settings.mcp_figma.clone(),
            vec![
                acp::SessionConfigSelectOption::new("auto", "Auto").description(
                    "Enable Figma MCP calls only when the prompt includes a Figma file, frame, group, or board link.",
                ),
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not enable Figma MCP calls automatically."),
                acp::SessionConfigSelectOption::new("on", "Always")
                    .description("Send Figma MCP availability on every turn."),
            ],
        )
        .description("Detects pasted Figma links and enables Backboard Figma MCP calls for that turn.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_mcp_notion",
            "Notion",
            feature_settings.mcp_notion.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not enable Notion MCP calls for this session."),
                acp::SessionConfigSelectOption::new("on", "On")
                    .description("Allow Backboard to use Notion MCP calls when useful."),
            ],
        )
        .description("Controls Backboard Notion MCP calls.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
        acp::SessionConfigOption::select(
            "backboard_mcp_google",
            "Google",
            feature_settings.mcp_google.clone(),
            vec![
                acp::SessionConfigSelectOption::new("off", "Off")
                    .description("Do not enable Google MCP calls for this session."),
                acp::SessionConfigSelectOption::new("on", "On")
                    .description("Allow Backboard to use Google MCP calls when useful."),
            ],
        )
        .description("Controls Backboard Google MCP calls.")
        .category(acp::SessionConfigOptionCategory::ThoughtLevel),
    ];

    if let Some(workspace) = workspace {
        options.extend(
            discover_file_system_skills(workspace)
                .into_iter()
                .map(|skill| {
                    let current_value = if feature_settings
                        .selected_skills
                        .iter()
                        .any(|selected_skill| selected_skill == &skill.relative_path)
                    {
                        "on"
                    } else {
                        "off"
                    };
                    let config_id =
                        format!("{}{}", BACKBOARD_SKILL_CONFIG_PREFIX, skill.relative_path);
                    let description = skill.description.unwrap_or_else(|| {
                        format!("Use instructions from {}.", skill.path.display())
                    });
                    acp::SessionConfigOption::select(
                        config_id,
                        skill.name,
                        current_value.to_string(),
                        vec![
                            acp::SessionConfigSelectOption::new("off", "Off").description(
                                "Do not include this skill in the next Backboard turn.",
                            ),
                            acp::SessionConfigSelectOption::new("on", "On")
                                .description("Include this skill in the next Backboard turn."),
                        ],
                    )
                    .description(description)
                    .category(acp::SessionConfigOptionCategory::ThoughtLevel)
                }),
        );
    }

    options
}

pub(crate) fn discover_file_system_skills(workspace: &Path) -> Vec<FileSystemSkill> {
    let mut relative_paths = BTreeSet::new();
    let mut skills = Vec::new();

    for skills_root in skills_roots_for_workspace(workspace) {
        skills.extend(
            walkdir::WalkDir::new(&skills_root)
                .max_depth(3)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
                .filter_map(|entry| file_system_skill_from_path(&skills_root, entry.path()))
                .filter(|skill| relative_paths.insert(skill.relative_path.clone())),
        );
    }

    skills.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    skills
}

fn skills_roots_for_workspace(workspace: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for ancestor in workspace.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new("skills"))
            && ancestor.is_dir()
        {
            push_skill_root(&mut roots, ancestor.to_path_buf());
        }

        for candidate in skill_root_candidates(ancestor) {
            push_skill_root(&mut roots, candidate);
        }
    }

    for candidate in default_skill_root_candidates() {
        push_skill_root(&mut roots, candidate);
    }

    roots
}

fn skill_root_candidates(ancestor: &Path) -> [PathBuf; 3] {
    [
        ancestor.join("assets").join("skills"),
        ancestor.join("zed").join("assets").join("skills"),
        ancestor
            .join("ide")
            .join("zed")
            .join("assets")
            .join("skills"),
    ]
}

fn default_skill_root_candidates() -> Vec<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![
        manifest_dir
            .join("..")
            .join("..")
            .join("assets")
            .join("skills"),
    ];

    if let Ok(current_dir) = std::env::current_dir() {
        for ancestor in current_dir.ancestors() {
            candidates.extend(skill_root_candidates(ancestor));
        }
    }

    candidates
}

fn push_skill_root(roots: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidate.is_dir() {
        return;
    }

    let candidate = match std::fs::canonicalize(&candidate) {
        Ok(candidate) => candidate,
        Err(_) => candidate,
    };

    if !roots.iter().any(|root| root == &candidate) {
        roots.push(candidate);
    }
}

fn file_system_skill_from_path(
    skills_root: &Path,
    skill_file_path: &Path,
) -> Option<FileSystemSkill> {
    let skill_dir = skill_file_path.parent()?;
    let relative_path = skill_dir
        .strip_prefix(skills_root)
        .ok()?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if relative_path.is_empty() {
        return None;
    }

    let fallback_name = skill_dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(display_name_from_slug)
        .unwrap_or_else(|| relative_path.clone());
    let metadata = read_skill_metadata(skill_file_path);
    Some(FileSystemSkill {
        relative_path,
        path: skill_file_path.to_path_buf(),
        name: metadata
            .name
            .map(|name| display_name_from_slug(&name))
            .unwrap_or(fallback_name),
        description: metadata.description,
    })
}

#[derive(Default)]
struct SkillMetadata {
    name: Option<String>,
    description: Option<String>,
}

fn read_skill_metadata(path: &Path) -> SkillMetadata {
    let Ok(file) = std::fs::File::open(path) else {
        return SkillMetadata::default();
    };
    let mut preview = String::new();
    let mut limited_file = file.take(8192);
    if limited_file.read_to_string(&mut preview).is_err() {
        return SkillMetadata::default();
    }

    parse_skill_metadata(&preview)
}

fn parse_skill_metadata(contents: &str) -> SkillMetadata {
    let mut in_frontmatter = false;
    let mut metadata = SkillMetadata::default();

    for line in contents.lines() {
        if line.trim() == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }

        if !in_frontmatter {
            continue;
        }

        if let Some((key, value)) = line.split_once(':') {
            let value = normalize_frontmatter_value(value);
            match key.trim() {
                "name" => metadata.name = Some(value),
                "description" => metadata.description = Some(value),
                _ => {}
            }
        }
    }

    metadata
}

fn normalize_frontmatter_value(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .to_string()
}

fn display_name_from_slug(value: &str) -> String {
    value
        .split(|character: char| character == '-' || character == '_' || character == '/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            let mut titleized = first.to_uppercase().collect::<String>();
            titleized.push_str(chars.as_str());
            titleized
        })
        .collect::<Vec<_>>()
        .join(" ")
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

async fn list_backboard_model_catalog(client: BackboardClient) -> Result<Vec<BackboardModel>> {
    let mut models = match client.list_models(None, Some("llm"), Some(15_000)).await {
        Ok(models) => models,
        Err(error) => {
            log::debug!("Backboard global model catalog request failed: {error:#}");
            Vec::new()
        }
    };
    let mut providers = MODEL_CATALOG_PROVIDERS
        .iter()
        .map(|provider| provider.to_string())
        .collect::<Vec<_>>();

    match client.list_providers().await {
        Ok(listed_providers) => {
            for provider in listed_providers {
                if !providers.iter().any(|known| known == &provider) {
                    providers.push(provider);
                }
            }
        }
        Err(error) => {
            log::debug!("Backboard model provider catalog request failed: {error:#}");
        }
    }

    let mut scoped_results =
        futures::stream::iter(providers.into_iter().enumerate().map(|(index, provider)| {
            let client = client.clone();
            async move {
                let result = client
                    .list_models(Some(provider.as_str()), Some("llm"), Some(15_000))
                    .await;
                (index, provider, result)
            }
        }))
        .buffer_unordered(MODEL_CATALOG_PROVIDER_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    scoped_results.sort_by_key(|(index, _, _)| *index);

    for (_, provider, result) in scoped_results {
        match result {
            Ok(mut provider_models) => models.append(&mut provider_models),
            Err(error) => {
                log::debug!(
                    "Backboard provider-scoped model catalog request failed provider={provider}: {error:#}"
                );
            }
        }
    }

    let mut seen = BTreeSet::new();
    models.retain(|model| seen.insert(format!("{}\0{}", model.provider, model.name)));
    Ok(models)
}

fn split_model_id(model_id: &str) -> (String, String) {
    model_id
        .split_once('/')
        .map(|(provider, model)| (provider.to_string(), model.to_string()))
        .unwrap_or_else(|| (DEFAULT_PROVIDER.to_string(), model_id.to_string()))
}

pub(crate) fn missing_api_key_message() -> String {
    "Please enter a Backboard API key to use AI features, including agents and Simple Mode. The editor remains available without AI.".to_string()
}

fn missing_api_key_auth_required() -> AuthRequired {
    AuthRequired::new().with_description(missing_api_key_message())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option_current_value(
        options: &[acp::SessionConfigOption],
        id: &str,
    ) -> Option<acp::SessionConfigValueId> {
        options.iter().find_map(|option| {
            if option.id.to_string() != id {
                return None;
            }

            match &option.kind {
                acp::SessionConfigKind::Select(select) => Some(select.current_value.clone()),
                _ => None,
            }
        })
    }

    fn temp_config_path(test_name: &str) -> (PathBuf, PathBuf) {
        let test_root = std::env::temp_dir().join(format!(
            "{test_name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard").join("config.json");
        (test_root, path)
    }

    #[test]
    fn native_state_has_api_key_from_shared_config() {
        let (test_root, path) = temp_config_path("agent-native-backboard-config");
        let _guard = ::backboard::set_config_path_for_testing(path);

        BackboardConfig::save_api_key_for_current_env("bb-agent-key").expect("save api key");

        let connection =
            BackboardNativeConnection::new(AgentId::new("backboard"), Some("free".into()));

        assert!(connection.state.has_api_key());

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn native_mutation_snapshots_restore_truncated_turn_changes() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let workspace = temp_dir.path().to_path_buf();
        fs::create_dir_all(workspace.join("src")).expect("create src");
        fs::write(workspace.join("src/existing.txt"), "old").expect("write existing");
        fs::write(workspace.join("src/deleted.txt"), "before delete").expect("write deleted");

        let connection =
            BackboardNativeConnection::new(AgentId::new("backboard"), Some("free".into()));
        let state = connection.state.clone();
        let session_id = acp::SessionId::new("test-session");
        let (config_tx, config_rx) = config_watch_channel();

        state.sessions.borrow_mut().insert(
            session_id.clone(),
            NativeSession {
                thread: WeakEntity::new_invalid(),
                workspace: workspace.clone(),
                assistant_id: None,
                thread_id: None,
                current_run_id: None,
                provider: Some(DEFAULT_PROVIDER.to_string()),
                model: Some(DEFAULT_MODEL.to_string()),
                mode: acp::SessionModeId::new("free"),
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                rewound_history_context: None,
                active_user_message_id: None,
                native_snapshots: Vec::new(),
                context_server_store: None,
                mcp_tools: Vec::new(),
                config_tx,
                config_rx,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
                session_total_cost: 0.0,
            },
        );

        let message_id = UserMessageId::new();
        state.begin_turn(&session_id, message_id.clone());

        let existing_path = workspace.join("src/existing.txt");
        let created_path = workspace.join("generated/nested.txt");
        let deleted_path = workspace.join("src/deleted.txt");
        state
            .record_path_before_mutation(&session_id, &existing_path)
            .expect("snapshot existing");
        state
            .record_path_before_mutation(&session_id, &created_path)
            .expect("snapshot created");
        state
            .record_path_tree_before_mutation(&session_id, &deleted_path)
            .expect("snapshot deleted");

        fs::write(&existing_path, "new").expect("mutate existing");
        fs::create_dir_all(created_path.parent().unwrap()).expect("create generated dir");
        fs::write(&created_path, "created").expect("write created");
        fs::remove_file(&deleted_path).expect("delete file");

        let paths = {
            let mut sessions = state.sessions.borrow_mut();
            let session = sessions.get_mut(&session_id).unwrap();
            take_native_restore_paths(session, &message_id)
        };
        restore_native_paths(paths).expect("restore snapshots");

        assert_eq!(fs::read_to_string(existing_path).unwrap(), "old");
        assert_eq!(fs::read_to_string(deleted_path).unwrap(), "before delete");
        assert!(!created_path.exists());
        assert!(!workspace.join("generated").exists());
    }

    #[test]
    fn cleanup_obsolete_workspace_storage_removes_backboard_local_dirs() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let workspace = temp_dir.path();
        fs::create_dir_all(workspace.join(".backboard/scratchpad")).expect("create backboard dir");
        fs::create_dir_all(workspace.join(".backboard_index")).expect("create index dir");
        fs::write(workspace.join(".backboard/config.txt"), "obsolete").expect("write artifact");
        fs::write(workspace.join("config.json"), "preserve").expect("write normal file");

        cleanup_obsolete_path(workspace.join(".backboard"));
        cleanup_obsolete_path(workspace.join(".backboard_index"));

        assert!(!workspace.join(".backboard").exists());
        assert!(!workspace.join(".backboard_index").exists());
        assert_eq!(
            fs::read_to_string(workspace.join("config.json")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn fallback_agent_model_uses_builtin_default() {
        let config = BackboardConfig::default();

        let model = fallback_agent_model_info(&config);

        assert_eq!(model.id, acp::ModelId::new("openai/gpt-4o"));
        assert_eq!(model.name, "gpt-4o");
        assert_eq!(
            model.description.as_ref().map(|value| value.as_ref()),
            Some("openai")
        );
        assert_eq!(
            model.icon,
            Some(acp_thread::AgentModelIcon::Named(IconName::AiOpenAi))
        );
    }

    #[test]
    fn featherless_models_are_filtered_from_backboard_catalog() {
        let featherless_provider = BackboardModel {
            provider: "featherless".to_string(),
            name: "qwen3-next-80b".to_string(),
            ..BackboardModel::default()
        };
        let featherless_name = BackboardModel {
            provider: "openrouter".to_string(),
            name: "featherless/qwen3-next-80b".to_string(),
            ..BackboardModel::default()
        };
        let featherless_display_name = BackboardModel {
            provider: "openrouter".to_string(),
            name: "qwen3-next-80b".to_string(),
            display_name: Some("Featherless Qwen3 Next 80B".to_string()),
            ..BackboardModel::default()
        };
        let non_featherless_model = BackboardModel {
            provider: "mistral".to_string(),
            name: "mistral-large-latest".to_string(),
            display_name: Some("Mistral Large".to_string()),
            ..BackboardModel::default()
        };

        assert!(is_featherless_backboard_model(&featherless_provider));
        assert!(is_featherless_backboard_model(&featherless_name));
        assert!(is_featherless_backboard_model(&featherless_display_name));
        assert!(!is_featherless_backboard_model(&non_featherless_model));
    }

    #[test]
    fn tool_incompatible_models_are_filtered_from_backboard_catalog() {
        let incompatible_model = BackboardModel {
            provider: "cohere".to_string(),
            name: "command-a-03-2025".to_string(),
            ..BackboardModel::default()
        };
        let compatible_model = BackboardModel {
            provider: "anthropic".to_string(),
            name: "claude-haiku-4-5-20251001".to_string(),
            ..BackboardModel::default()
        };

        assert_eq!(TOOL_INCOMPATIBLE_MODELS.len(), 133);
        assert!(is_tool_incompatible_backboard_model(&incompatible_model));
        assert!(!is_tool_incompatible_backboard_model(&compatible_model));
    }

    #[test]
    fn config_options_include_media_and_search_chips() {
        let settings = FeatureSettings {
            web_search: "Auto".to_string(),
            image_generation: "auto".to_string(),
            voice_mode: "tts".to_string(),
            live_voice: "on".to_string(),
            mcp_figma: "auto".to_string(),
            mcp_notion: "on".to_string(),
            mcp_google: "on".to_string(),
            selected_skills: Vec::new(),
        };
        let options = config_options("free", "fast", &settings, None);
        let ids = options
            .iter()
            .map(|option| option.id.to_string())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"backboard_intensity".to_string()));
        assert!(ids.contains(&"backboard_web_search".to_string()));
        assert!(ids.contains(&"backboard_image_generation".to_string()));
        assert!(ids.contains(&"backboard_voice_mode".to_string()));
        assert!(ids.contains(&"backboard_live_voice".to_string()));
        assert!(ids.contains(&"backboard_mcp_figma".to_string()));
        assert!(ids.contains(&"backboard_mcp_notion".to_string()));
        assert!(ids.contains(&"backboard_mcp_google".to_string()));
    }

    #[test]
    fn discovers_skills_from_workspace_assets_directory() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let skill_dir = temp_dir
            .path()
            .join("assets")
            .join("skills")
            .join("shopify")
            .join("shopify-admin");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            r#"<!-- generated -->
---
name: shopify-admin
description: "Build against the Shopify Admin API."
---

# Instructions
"#,
        )
        .expect("write skill");

        let workspace = temp_dir.path().join("crates").join("agent");
        let skills = discover_file_system_skills(&workspace);
        let skill = skills
            .iter()
            .find(|skill| skill.relative_path == "shopify/shopify-admin")
            .expect("shopify admin skill should be discovered");

        assert_eq!(skill.name, "Shopify Admin");
        assert_eq!(
            skill.description.as_deref(),
            Some("Build against the Shopify Admin API.")
        );
    }

    #[test]
    fn discovers_skills_from_sibling_zed_assets_directory() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let ide_dir = temp_dir.path().join("ide");
        let skill_dir = ide_dir
            .join("zed")
            .join("assets")
            .join("skills")
            .join("shopify")
            .join("shopify-admin");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            r#"---
name: shopify-admin
description: "Build against the Shopify Admin API."
---
"#,
        )
        .expect("write skill");

        let workspace = ide_dir.join("web");
        let skills = discover_file_system_skills(&workspace);
        let skill = skills
            .iter()
            .find(|skill| skill.relative_path == "shopify/shopify-admin")
            .expect("shopify admin skill should be discovered");

        assert_eq!(
            skill.path,
            std::fs::canonicalize(skill_dir.join("SKILL.md")).expect("canonicalize skill path"),
            "skills should be loaded from ide/zed/assets/skills"
        );
    }

    #[test]
    fn config_options_include_file_system_skills() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let skill_dir = temp_dir
            .path()
            .join("assets")
            .join("skills")
            .join("web")
            .join("modern");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            r#"---
name: modern
description: Modern design guidance.
---
"#,
        )
        .expect("write skill");

        let settings = FeatureSettings {
            selected_skills: vec!["web/modern".to_string()],
            ..Default::default()
        };
        let options = config_options("free", "fast", &settings, Some(temp_dir.path()));

        assert_eq!(
            option_current_value(&options, "backboard_skill:web/modern").as_ref(),
            Some(&acp::SessionConfigValueId::new("on"))
        );
    }

    #[gpui::test]
    async fn config_option_endpoint_updates_native_session_state(cx: &mut gpui::TestAppContext) {
        let connection =
            BackboardNativeConnection::new(AgentId::new("backboard"), Some("free".into()));
        let state = connection.state.clone();
        let session_id = acp::SessionId::new("test-session");
        let (config_tx, config_rx) = config_watch_channel();

        state.sessions.borrow_mut().insert(
            session_id.clone(),
            NativeSession {
                thread: WeakEntity::new_invalid(),
                workspace: PathBuf::from("/workspace"),
                assistant_id: None,
                thread_id: None,
                current_run_id: None,
                provider: Some(DEFAULT_PROVIDER.to_string()),
                model: Some(DEFAULT_MODEL.to_string()),
                mode: acp::SessionModeId::new("free"),
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                rewound_history_context: None,
                active_user_message_id: None,
                native_snapshots: Vec::new(),
                context_server_store: None,
                mcp_tools: Vec::new(),
                config_tx,
                config_rx,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
                session_total_cost: 0.0,
            },
        );

        let config_options = BackboardConfigOptions { state, session_id };

        let web_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_web_search"),
                    acp::SessionConfigValueId::new("Auto"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&web_options, "backboard_web_search").as_ref(),
            Some(&acp::SessionConfigValueId::new("Auto"))
        );

        let mode_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_mode"),
                    acp::SessionConfigValueId::new("agent"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&mode_options, "backboard_mode").as_ref(),
            Some(&acp::SessionConfigValueId::new("agent"))
        );

        let voice_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_voice_mode"),
                    acp::SessionConfigValueId::new("tts"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&voice_options, "backboard_voice_mode").as_ref(),
            Some(&acp::SessionConfigValueId::new("tts"))
        );

        let figma_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_mcp_figma"),
                    acp::SessionConfigValueId::new("auto"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&figma_options, "backboard_mcp_figma").as_ref(),
            Some(&acp::SessionConfigValueId::new("auto"))
        );

        let notion_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_mcp_notion"),
                    acp::SessionConfigValueId::new("on"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&notion_options, "backboard_mcp_notion").as_ref(),
            Some(&acp::SessionConfigValueId::new("on"))
        );

        let google_options = cx
            .update(|cx| {
                config_options.set_config_option(
                    acp::SessionConfigId::new("backboard_mcp_google"),
                    acp::SessionConfigValueId::new("on"),
                    cx,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            option_current_value(&google_options, "backboard_mcp_google").as_ref(),
            Some(&acp::SessionConfigValueId::new("on"))
        );
    }

    #[gpui::test]
    async fn updating_work_dirs_updates_native_session_workspace(cx: &mut gpui::TestAppContext) {
        let old_workspace = tempfile::tempdir().expect("create old workspace");
        let new_workspace = tempfile::tempdir().expect("create new workspace");
        let connection =
            BackboardNativeConnection::new(AgentId::new("backboard"), Some("free".into()));
        let state = connection.state.clone();
        let session_id = acp::SessionId::new("test-session");
        let (config_tx, config_rx) = config_watch_channel();

        state.sessions.borrow_mut().insert(
            session_id.clone(),
            NativeSession {
                thread: WeakEntity::new_invalid(),
                workspace: old_workspace.path().to_path_buf(),
                assistant_id: None,
                thread_id: None,
                current_run_id: None,
                provider: Some(DEFAULT_PROVIDER.to_string()),
                model: Some(DEFAULT_MODEL.to_string()),
                mode: acp::SessionModeId::new("free"),
                intensity: DEFAULT_INTENSITY.to_string(),
                feature_settings: FeatureSettings::default(),
                rewound_history_context: None,
                active_user_message_id: None,
                native_snapshots: Vec::new(),
                context_server_store: None,
                mcp_tools: Vec::new(),
                config_tx,
                config_rx,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                metrics: NativeTurnMetrics::default(),
                context_window_tokens: None,
                estimated_used_tokens: 0,
                session_total_cost: 0.0,
            },
        );

        cx.update(|cx| {
            connection.update_session_work_dirs(
                &session_id,
                PathList::new(&[new_workspace.path()]),
                cx,
            )
        })
        .await
        .expect("work dirs update should succeed");

        assert_eq!(
            state
                .sessions
                .borrow()
                .get(&session_id)
                .map(|session| session.workspace.clone()),
            Some(new_workspace.path().to_path_buf())
        );
    }
}
