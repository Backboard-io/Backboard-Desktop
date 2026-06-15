use std::{
    collections::{HashMap, VecDeque},
    io::Write as _,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use anyhow::{Context as _, Result};
use futures::{Stream, StreamExt as _};
use reqwest::{
    Client, RequestBuilder, Response, StatusCode,
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;

pub const PROD_API_URL: &str = "https://app.backboard.io/api";
pub const DEV_API_URL: &str = "https://dev.app.backboard.io/api";
pub const LOCAL_API_URL: &str = "http://localhost:8000";
const INLINE_COMPLETION_OUTPUT_BACKLOG_LIMIT: usize = 20;

#[derive(Clone, Debug)]
pub struct InlineCompletionOutput {
    pub title: String,
    pub path: Option<String>,
    pub language: Option<String>,
    pub chunks: Vec<String>,
}

static INLINE_COMPLETION_OUTPUT_BACKLOG: LazyLock<Mutex<VecDeque<InlineCompletionOutput>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
static INLINE_COMPLETION_OUTPUT_SUBSCRIBERS: LazyLock<
    Mutex<Vec<async_channel::Sender<InlineCompletionOutput>>>,
> = LazyLock::new(|| Mutex::new(Vec::new()));
static CONFIG_CHANGE_SUBSCRIBERS: LazyLock<Mutex<Vec<async_channel::Sender<BackboardConfig>>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
static CONFIG_PATH_OVERRIDE: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));
static CONFIG_PATH_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub fn publish_inline_completion_output(output: InlineCompletionOutput) {
    {
        let mut backlog = inline_completion_output_backlog();
        backlog.push_back(output.clone());
        while backlog.len() > INLINE_COMPLETION_OUTPUT_BACKLOG_LIMIT {
            backlog.pop_front();
        }
    }

    let mut subscribers = inline_completion_output_subscribers();
    subscribers.retain(|subscriber| subscriber.try_send(output.clone()).is_ok());
}

pub fn subscribe_inline_completion_outputs() -> async_channel::Receiver<InlineCompletionOutput> {
    let (sender, receiver) = async_channel::unbounded();

    {
        let backlog = inline_completion_output_backlog();
        for output in backlog.iter().cloned() {
            if sender.try_send(output).is_err() {
                break;
            }
        }
    }

    inline_completion_output_subscribers().push(sender);
    receiver
}

fn inline_completion_output_backlog() -> MutexGuard<'static, VecDeque<InlineCompletionOutput>> {
    match INLINE_COMPLETION_OUTPUT_BACKLOG.lock() {
        Ok(backlog) => backlog,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn inline_completion_output_subscribers()
-> MutexGuard<'static, Vec<async_channel::Sender<InlineCompletionOutput>>> {
    match INLINE_COMPLETION_OUTPUT_SUBSCRIBERS.lock() {
        Ok(subscribers) => subscribers,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub fn publish_config_change(config: BackboardConfig) {
    let mut subscribers = config_change_subscribers();
    subscribers.retain(|subscriber| subscriber.try_send(config.clone()).is_ok());
}

pub fn subscribe_config_changes() -> async_channel::Receiver<BackboardConfig> {
    let (sender, receiver) = async_channel::unbounded();
    config_change_subscribers().push(sender);
    receiver
}

fn config_change_subscribers() -> MutexGuard<'static, Vec<async_channel::Sender<BackboardConfig>>> {
    match CONFIG_CHANGE_SUBSCRIBERS.lock() {
        Ok(subscribers) => subscribers,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn config_path_override() -> MutexGuard<'static, Option<PathBuf>> {
    match CONFIG_PATH_OVERRIDE.lock() {
        Ok(path) => path,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[doc(hidden)]
pub struct ConfigPathOverrideGuard {
    previous_path: Option<PathBuf>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for ConfigPathOverrideGuard {
    fn drop(&mut self) {
        *config_path_override() = self.previous_path.take();
    }
}

#[doc(hidden)]
pub fn set_config_path_for_testing(path: impl Into<PathBuf>) -> ConfigPathOverrideGuard {
    let lock = match CONFIG_PATH_TEST_LOCK.lock() {
        Ok(lock) => lock,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut override_path = config_path_override();
    let previous_path = override_path.replace(path.into());

    ConfigPathOverrideGuard {
        previous_path,
        _lock: lock,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackboardConfig {
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub env_keys: HashMap<String, String>,
}

fn default_env() -> String {
    "prod".into()
}

impl BackboardConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let map = read_config_map(&path)?;
        let mut config: Self = serde_json::from_value(Value::Object(map))
            .with_context(|| format!("parsing Backboard config at {}", path.display()))?;
        config.normalize_env();
        config.promote_legacy_default_env();
        Ok(config)
    }

    pub fn load_or_default() -> Self {
        Self::load().unwrap_or_default()
    }

    pub fn save_api_key_for_current_env(api_key: impl Into<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();
        let api_key = api_key.into().trim().to_string();
        let env = config.env.to_lowercase();

        config.env_keys.insert(env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn save_api_key_for_env(api_key: impl Into<String>, env: impl AsRef<str>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();

        let api_key = api_key.into().trim().to_string();
        let target_env = normalize_env(env.as_ref());
        let current_env = config.env.to_lowercase();

        if target_env != current_env {
            if let Some(current_key) = config.api_key.as_deref().and_then(non_empty_api_key) {
                config.env_keys.entry(current_env).or_insert(current_key);
            }
            config.env = target_env.clone();
            config.api_url = default_api_url_override_for_env(&target_env);
        }

        config.env_keys.insert(target_env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn clear_api_key_for_current_env() -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();
        let env = config.env.to_lowercase();

        config.api_key = None;
        config.env_keys.remove(&env);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let dir = path
            .parent()
            .context("Backboard config path does not have a parent directory")?;
        let mut existing = read_config_map(&path)?;
        let overlay = serde_json::to_value(self)?
            .as_object()
            .cloned()
            .context("Backboard config did not serialize to an object")?;

        for (key, value) in overlay {
            existing.insert(key, value);
        }

        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating Backboard config dir at {}", dir.display()))?;
        write_config_atomically(&path, dir, &existing)
            .with_context(|| format!("writing Backboard config at {}", path.display()))?;
        write_config_backup(&path, dir, &existing);

        Ok(())
    }

    pub fn base_url(&self) -> String {
        self.api_url
            .clone()
            .unwrap_or_else(|| match self.env.to_lowercase().as_str() {
                "prod" | "production" => PROD_API_URL.into(),
                "local" => LOCAL_API_URL.into(),
                _ => DEV_API_URL.into(),
            })
            .trim_end_matches('/')
            .to_string()
    }

    pub fn api_key(&self) -> Option<String> {
        self.api_key
            .as_deref()
            .and_then(non_empty_api_key)
            .or_else(|| {
                self.env_keys
                    .get(&self.env.to_lowercase())
                    .and_then(|key| non_empty_api_key(key))
            })
            .or_else(|| {
                std::env::var("BACKBOARD_API_KEY")
                    .ok()
                    .and_then(|key| non_empty_api_key(&key))
            })
    }

    fn normalize_env(&mut self) {
        self.env = normalize_env(&self.env);
    }

    fn promote_legacy_default_env(&mut self) {
        if self.api_url.is_none() && self.env.eq_ignore_ascii_case("dev") {
            if let Some(api_key) = self
                .env_keys
                .get("dev")
                .cloned()
                .or_else(|| self.api_key.as_deref().and_then(non_empty_api_key))
            {
                self.env_keys.entry("prod".to_string()).or_insert(api_key);
            }
            self.env = default_env();
        }
    }
}

fn normalize_env(env: &str) -> String {
    match env.trim().to_lowercase().as_str() {
        "production" => "prod".to_string(),
        "development" => "dev".to_string(),
        "" => default_env(),
        env => env.to_string(),
    }
}

fn default_api_url_override_for_env(env: &str) -> Option<String> {
    (env == "dev").then(|| DEV_API_URL.to_string())
}

fn non_empty_api_key(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

fn read_config_contents(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let backup = path.with_extension("json.bak");
            std::fs::read_to_string(&backup).with_context(|| {
                format!(
                    "reading Backboard config at {} or backup at {}",
                    path.display(),
                    backup.display()
                )
            })
        }
        Err(error) => {
            Err(error).with_context(|| format!("reading Backboard config at {}", path.display()))
        }
    }
}

fn read_config_map(path: &Path) -> Result<Map<String, Value>> {
    match read_config_contents(path) {
        Ok(contents) => match serde_json::from_str::<Value>(&contents) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Ok(Map::new()),
            Err(error) => {
                preserve_corrupt_config(path)?;
                let backup = path.with_extension("json.bak");
                match std::fs::read_to_string(&backup) {
                    Ok(contents) => match serde_json::from_str::<Value>(&contents) {
                        Ok(Value::Object(map)) => Ok(map),
                        _ => Ok(Map::new()),
                    },
                    Err(backup_error) if backup_error.kind() == std::io::ErrorKind::NotFound => {
                        Ok(Map::new())
                    }
                    Err(backup_error) => Err(backup_error).with_context(|| {
                        format!("reading Backboard config backup at {}", backup.display())
                    }),
                }
                .with_context(|| {
                    format!(
                        "parsing Backboard config at {} failed before backup recovery: {error}",
                        path.display()
                    )
                })
            }
        },
        Err(error) => {
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                Ok(Map::new())
            } else {
                Err(error)
            }
        }
    }
}

fn preserve_corrupt_config(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let corrupt_path = path.with_file_name(format!(
        "{}.corrupt-{timestamp}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config.json")
    ));
    std::fs::rename(path, &corrupt_path).with_context(|| {
        format!(
            "preserving corrupt Backboard config at {}",
            corrupt_path.display()
        )
    })
}

fn write_config_atomically(path: &Path, dir: &Path, config: &Map<String, Value>) -> Result<()> {
    let temp_path = temp_config_path(dir, "tmp");
    let contents = serde_json::to_vec_pretty(config)?;

    let write_result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .with_context(|| {
                format!("creating temp Backboard config at {}", temp_path.display())
            })?;
        set_private_permissions(&temp_path)?;
        file.write_all(&contents)
            .with_context(|| format!("writing temp Backboard config at {}", temp_path.display()))?;
        std::fs::rename(&temp_path, path).with_context(|| {
            format!(
                "replacing Backboard config {} with {}",
                path.display(),
                temp_path.display()
            )
        })?;
        set_private_permissions(path)?;
        Ok(())
    })();

    if write_result.is_err() && temp_path.exists() {
        if let Err(error) = std::fs::remove_file(&temp_path) {
            eprintln!(
                "warning: failed to remove temp Backboard config at {}: {error}",
                temp_path.display()
            );
        }
    }

    write_result
}

fn write_config_backup(path: &Path, dir: &Path, config: &Map<String, Value>) {
    let backup_path = path.with_extension("json.bak");
    let temp_path = temp_config_path(dir, "bak.tmp");
    let Ok(contents) = serde_json::to_vec_pretty(config) else {
        return;
    };

    let write_result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        set_private_permissions(&temp_path)?;
        file.write_all(&contents)?;
        std::fs::rename(&temp_path, &backup_path)?;
        set_private_permissions(&backup_path)?;
        Ok(())
    })();

    if write_result.is_err() && temp_path.exists() {
        if let Err(error) = std::fs::remove_file(&temp_path) {
            eprintln!(
                "warning: failed to remove temp Backboard config backup at {}: {error}",
                temp_path.display()
            );
        }
    }
}

fn temp_config_path(dir: &Path, suffix: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    dir.join(format!(
        "config.{}.{}.{}",
        std::process::id(),
        timestamp,
        suffix
    ))
}

fn set_private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, permissions).with_context(|| {
            format!(
                "setting permissions on Backboard config at {}",
                path.display()
            )
        })?;
    }

    Ok(())
}

impl Default for BackboardConfig {
    fn default() -> Self {
        Self {
            env: default_env(),
            api_key: None,
            api_url: None,
            env_keys: HashMap::default(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    if let Some(path) = config_path_override().clone() {
        return Ok(path);
    }

    let home = dirs::home_dir().context("failed to determine user profile directory")?;
    Ok(home.join(".backboard_ide").join("config.json"))
}

#[derive(Debug, Error)]
pub enum BackboardError {
    #[error("Backboard API key is missing. Run `backboard config set-api-key <key>`.")]
    MissingApiKey,
    #[error("Backboard API returned {status}: {body}")]
    Api { status: StatusCode, body: String },
}

#[derive(Clone)]
pub struct BackboardClient {
    client: Client,
    base_url: String,
    api_key: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateAssistantRequest {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_fact_extraction_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_update_memory_prompt: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateAssistantRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
}

#[derive(Clone, Debug)]
pub struct AudioAttachment {
    pub data: Vec<u8>,
    pub file_name: String,
    pub mime_type: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SendMessageRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_pro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(default = "default_web_search")]
    pub web_search: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_model_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_to_llm: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_calls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing)]
    pub audio_file: Option<AudioAttachment>,
}

fn default_web_search() -> String {
    "off".into()
}

impl Default for SendMessageRequest {
    fn default() -> Self {
        Self {
            thread_id: None,
            assistant_id: None,
            content: String::new(),
            provider: None,
            model: None,
            memory: Some("Auto".to_string()),
            memory_pro: None,
            thinking: None,
            tools: None,
            web_search: default_web_search(),
            image_generation: None,
            image_model_provider: None,
            image_model_name: None,
            voice: None,
            send_to_llm: None,
            mcp_calls: None,
            max_tokens: None,
            audio_file: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SubmitToolOutputsRequest {
    pub tool_outputs: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MessageThreadBinding {
    pub thread_id: Option<String>,
    pub assistant_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RecentUsageQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<String>,
    pub page_size: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct UsageSummaryQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BackboardModel {
    #[serde(default)]
    pub provider: String,
    #[serde(default, alias = "id", alias = "model_id")]
    pub name: String,
    #[serde(default)]
    pub model_type: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, alias = "context_window", alias = "max_context_tokens")]
    pub context_limit: Option<u64>,
    #[serde(default)]
    pub supports_thinking: Option<bool>,
    #[serde(default)]
    pub input_cost_per_1m_tokens: Option<f64>,
    #[serde(default)]
    pub output_cost_per_1m_tokens: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct ListModelsResponse {
    #[serde(default)]
    models: Vec<BackboardModel>,
    #[serde(default)]
    total: Option<u64>,
}

const MODELS_ROUTE: &str = "/models";
const MODEL_PROVIDERS_ROUTE: &str = "/models/providers";
const MODEL_PAGE_SIZE: usize = 100;

fn model_provider_route(provider_name: &str) -> String {
    format!("/models/provider/{}", urlencoding::encode(provider_name))
}

fn list_models_query_params(
    provider: Option<&str>,
    model_type: Option<&str>,
    skip: usize,
    limit: usize,
) -> Vec<(&'static str, String)> {
    let mut params = Vec::new();
    if let Some(model_type) = model_type {
        params.push(("model_type", model_type.to_string()));
    }
    params.push(("skip", skip.to_string()));
    params.push(("limit", limit.to_string()));
    if let Some(provider) = provider {
        params.push(("provider", provider.to_string()));
    }
    params
}

impl BackboardClient {
    pub fn from_config(config: BackboardConfig) -> Result<Self> {
        let api_key = config.api_key().ok_or(BackboardError::MissingApiKey)?;
        Ok(Self::new(config.base_url(), api_key))
    }

    pub fn from_saved_config() -> Result<Self> {
        Self::from_config(BackboardConfig::load()?)
    }

    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        let client = Client::builder()
            .http2_adaptive_window(true)
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(Some(Duration::from_secs(60)))
            .tcp_keepalive(Some(Duration::from_secs(60)))
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn warm_connection(&self) -> Result<()> {
        let response = self
            .client
            .get(self.base_url.clone())
            .header("X-API-Key", self.api_key_header()?)
            .send()
            .await?;
        response.bytes().await?;
        Ok(())
    }

    pub async fn create_assistant(&self, request: CreateAssistantRequest) -> Result<Value> {
        self.json(
            self.client
                .post(self.url("/assistants"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn update_assistant(
        &self,
        assistant_id: &str,
        request: UpdateAssistantRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .put(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn update_assistant_value(
        &self,
        assistant_id: &str,
        request: Value,
    ) -> Result<Value> {
        self.json_value(
            self.client
                .put(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn create_assistant_value(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/assistants"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn get_assistant(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_assistants(&self) -> Result<Vec<Value>> {
        self.json(
            self.client
                .get(self.url("/assistants"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_assistant(&self, assistant_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn create_thread(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/threads")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&json!({}))?),
        )
        .await
    }

    pub async fn get_thread(&self, thread_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&format!("/threads/{thread_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_threads(&self, assistant_id: Option<&str>) -> Result<Vec<Value>> {
        let path = assistant_id.map_or_else(
            || "/threads".to_string(),
            |id| format!("/assistants/{id}/threads"),
        );
        self.json(
            self.client
                .get(self.url(&path))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/threads/{thread_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_assistant_documents(&self, assistant_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}/documents")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_thread_documents(&self, thread_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/threads/{thread_id}/documents")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn send_message(&self, request: SendMessageRequest) -> Result<Value> {
        self.json(self.message_request_builder(self.url("/threads/messages"), request, false)?)
            .await
    }

    pub async fn send_message_value(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/threads/messages"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn send_message_in_thread(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Value> {
        self.send_message(request.with_thread_id(thread_id)).await
    }

    pub async fn send_message_stream(
        &self,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        validate_message_request(&request, true)?;
        let client = self.client.clone();
        let url = self.url("/threads/messages");
        let api_key = self.api_key_header()?;
        Ok(retrying_sse_json_stream(move || {
            message_request_builder(
                client.clone(),
                url.clone(),
                api_key.clone(),
                request.clone(),
                true,
            )
        }))
    }

    pub async fn send_message_stream_in_thread(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        self.send_message_stream(request.with_thread_id(thread_id))
            .await
    }

    pub fn realtime_voice_url(&self) -> String {
        realtime_voice_url(&self.base_url, &self.api_key)
    }

    pub async fn upload_document(&self, assistant_id: &str, file_path: &Path) -> Result<Value> {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document")
            .to_string();
        let bytes = std::fs::read(file_path)
            .with_context(|| format!("reading document {}", file_path.display()))?;
        let form = Form::new().part("file", Part::bytes(bytes).file_name(file_name));
        self.json(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/documents")))
                .header("X-API-Key", self.api_key_header()?)
                .multipart(form),
        )
        .await
    }

    pub async fn upload_thread_document(&self, thread_id: &str, file_path: &Path) -> Result<Value> {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document")
            .to_string();
        let bytes = std::fs::read(file_path)
            .with_context(|| format!("reading document {}", file_path.display()))?;
        let form = Form::new().part("file", Part::bytes(bytes).file_name(file_name));
        self.json_value(
            self.client
                .post(self.url(&format!("/threads/{thread_id}/documents")))
                .header("X-API-Key", self.api_key_header()?)
                .multipart(form),
        )
        .await
    }

    pub async fn get_document_status(&self, document_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/documents/{document_id}/status")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_document(&self, document_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/documents/{document_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_memories(&self, assistant_id: &str) -> Result<Vec<Value>> {
        self.json(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}/memories")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn add_memory(
        &self,
        assistant_id: &str,
        content: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/memories")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(
                    &json!({ "content": content.into(), "tags": tags }),
                )?),
        )
        .await
    }

    pub async fn search_memories(&self, assistant_id: &str, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/memories/search")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn add_memory_value(&self, assistant_id: &str, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/memories")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn get_memory(&self, assistant_id: &str, memory_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}/memories/{memory_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn update_memory(
        &self,
        assistant_id: &str,
        memory_id: &str,
        request: Value,
    ) -> Result<Value> {
        self.json_value(
            self.client
                .put(self.url(&format!("/assistants/{assistant_id}/memories/{memory_id}")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn delete_memory(&self, assistant_id: &str, memory_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/assistants/{assistant_id}/memories/{memory_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn get_memory_operation_status(&self, operation_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/assistants/memories/operations/{operation_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_models(
        &self,
        provider: Option<&str>,
        model_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let mut skip = 0usize;
        let mut models = Vec::new();

        while models.len() < max_records {
            let current_limit = MODEL_PAGE_SIZE.min(max_records - models.len());
            let params = list_models_query_params(provider, model_type, skip, current_limit);

            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(MODELS_ROUTE))
                        .headers(self.json_headers()?)
                        .query(&params),
                )
                .await?;
            let received = page.models.len();
            models.extend(page.models);

            if received == 0 {
                break;
            }
            skip += received;
            if let Some(total) = page.total {
                if skip as u64 >= total {
                    break;
                }
            }
        }

        Ok(models)
    }

    pub async fn list_models_by_provider(
        &self,
        provider_name: &str,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let mut skip = 0usize;
        let mut models = Vec::new();
        let route = model_provider_route(provider_name);

        while models.len() < max_records {
            let current_limit = MODEL_PAGE_SIZE.min(max_records - models.len());
            let params = [
                ("skip", skip.to_string()),
                ("limit", current_limit.to_string()),
            ];

            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(&route))
                        .headers(self.json_headers()?)
                        .query(&params),
                )
                .await?;
            let received = page.models.len();
            models.extend(page.models);

            if received == 0 {
                break;
            }
            skip += received;
            if let Some(total) = page.total {
                if skip as u64 >= total {
                    break;
                }
            }
        }

        Ok(models)
    }

    pub async fn list_providers(&self) -> Result<Vec<String>> {
        let data: Value = self
            .json(
                self.client
                    .get(self.url(MODEL_PROVIDERS_ROUTE))
                    .headers(self.json_headers()?),
            )
            .await?;
        Ok(data
            .get("providers")
            .and_then(Value::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn get_model(&self, model_name: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/models/{}", urlencoding::encode(model_name))))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_embedding_models(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/models/embedding/all"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_embedding_providers(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/models/embedding/providers"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn get_embedding_model(&self, model_name: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!(
                    "/models/embedding/{}",
                    urlencoding::encode(model_name)
                )))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn submit_tool_outputs(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&format!(
                    "/threads/{thread_id}/runs/{run_id}/submit-tool-outputs"
                )))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn submit_tool_outputs_stream(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let response = self
            .client
            .post(self.url(&format!(
                "/threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true"
            )))
            .headers(self.json_headers()?)
            .body(serde_json::to_vec(&request)?)
            .send()
            .await?;
        let response = self.ensure_success(response).await?;
        Ok(Box::pin(sse_json_stream(response)))
    }

    pub async fn submit_tool_outputs_simple(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/threads/tool-outputs"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn add_thread_message(&self, thread_id: &str, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url(&format!("/threads/{thread_id}/messages")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn cancel_run(&self, thread_id: &str, run_id: &str) -> Result<bool> {
        let response = self
            .client
            .post(self.url(&format!("/threads/{thread_id}/runs/{run_id}/cancel")))
            .headers(self.json_headers()?)
            .send()
            .await?;
        Ok(response.status().is_success())
    }

    pub async fn get_recent_usage(&self, query: RecentUsageQuery) -> Result<Option<Value>> {
        let mut params = vec![
            ("page", query.page.unwrap_or(1).to_string()),
            ("page_size", query.page_size.clamp(1, 100).to_string()),
        ];
        if let Some(model) = query.model {
            params.push(("model", model));
        }
        if let Some(input_tokens) = query.input_tokens {
            params.push(("input_tokens", input_tokens.to_string()));
        }
        if let Some(output_tokens) = query.output_tokens {
            params.push(("output_tokens", output_tokens.to_string()));
        }
        if let Some(start) = query.start {
            params.push(("start", start));
        }
        if let Some(end) = query.end {
            params.push(("end", end));
        }
        if let Some(credit_type) = query.credit_type {
            params.push(("credit_type", credit_type));
        }
        if let Some(sort_by) = query.sort_by {
            params.push(("sort_by", sort_by));
        }
        if let Some(sort_order) = query.sort_order {
            params.push(("sort_order", sort_order));
        }
        let response = self
            .client
            .get(self.url("/billing/usage/recent"))
            .headers(self.json_headers()?)
            .query(&params)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(Some(parse_json_response(response).await?))
        } else {
            Ok(None)
        }
    }

    pub async fn get_billing_balance(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/billing/balance"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn get_usage_summary(&self, query: UsageSummaryQuery) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(range) = query.range {
            params.push(("range", range));
        }
        self.json_value(
            self.client
                .get(self.url("/billing/usage/summary"))
                .headers(self.json_headers()?)
                .query(&params),
        )
        .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn message_request_builder(
        &self,
        url: String,
        request: SendMessageRequest,
        stream: bool,
    ) -> Result<RequestBuilder> {
        validate_message_request(&request, stream)?;
        Ok(message_request_builder(
            self.client.clone(),
            url,
            self.api_key_header()?,
            request,
            stream,
        ))
    }

    fn json_headers(&self) -> Result<reqwest::header::HeaderMap> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("X-API-Key", self.api_key_header()?);
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        Ok(headers)
    }

    fn api_key_header(&self) -> Result<reqwest::header::HeaderValue> {
        reqwest::header::HeaderValue::from_str(&self.api_key)
            .context("Backboard API key is not a valid HTTP header value")
    }

    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let response = request.send().await?;
        let response = self.ensure_success(response).await?;
        parse_json_response(response).await
    }

    async fn json_value(&self, request: reqwest::RequestBuilder) -> Result<Value> {
        let response = request.send().await?;
        let response = self.ensure_success(response).await?;
        parse_json_value_response(response).await
    }

    async fn ensure_success(&self, response: Response) -> Result<Response> {
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(BackboardError::Api { status, body }.into())
    }
}

impl SendMessageRequest {
    fn with_thread_id(mut self, thread_id: &str) -> Self {
        if self.thread_id.is_none() {
            self.thread_id = Some(thread_id.to_string());
        }
        self
    }
}

pub fn message_thread_binding(value: &Value) -> MessageThreadBinding {
    MessageThreadBinding {
        thread_id: message_thread_id(value),
        assistant_id: message_assistant_id(value),
    }
}

pub fn message_thread_id(value: &Value) -> Option<String> {
    json_string_at(
        value,
        &[
            &["thread_id"],
            &["threadId"],
            &["thread", "id"],
            &["thread", "thread_id"],
            &["data", "thread_id"],
            &["data", "threadId"],
            &["data", "thread", "id"],
            &["message", "thread_id"],
            &["message", "threadId"],
            &["run", "thread_id"],
            &["run", "threadId"],
        ],
    )
}

pub fn message_assistant_id(value: &Value) -> Option<String> {
    json_string_at(
        value,
        &[
            &["assistant_id"],
            &["assistantId"],
            &["assistant", "id"],
            &["assistant", "assistant_id"],
            &["data", "assistant_id"],
            &["data", "assistantId"],
            &["data", "assistant", "id"],
            &["message", "assistant_id"],
            &["message", "assistantId"],
            &["run", "assistant_id"],
            &["run", "assistantId"],
        ],
    )
}

fn json_string_at(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        let mut current = value;
        for key in path.iter().copied() {
            current = current.get(key)?;
        }
        current
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    })
}

async fn parse_json_response<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let text = response.text().await?;
    Ok(serde_json::from_str(&text)?)
}

async fn parse_json_value_response(response: Response) -> Result<Value> {
    let text = response.text().await?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    Ok(serde_json::from_str(&text)?)
}

fn message_form(request: &SendMessageRequest, stream: bool) -> Result<Vec<(String, String)>> {
    let mut form = vec![
        ("content".to_string(), request.content.clone()),
        ("stream".to_string(), stream.to_string()),
        ("web_search".to_string(), request.web_search.clone()),
    ];
    if let Some(memory) = request.memory.clone() {
        form.push(("memory".to_string(), memory));
    }
    if let Some(memory_pro) = request.memory_pro.clone() {
        form.push(("memory_pro".to_string(), memory_pro));
    }
    if let Some(thread_id) = request.thread_id.clone() {
        form.push(("thread_id".to_string(), thread_id));
    }
    if let Some(assistant_id) = request.assistant_id.clone() {
        form.push(("assistant_id".to_string(), assistant_id));
    }
    if let Some(provider) = request.provider.clone() {
        form.push(("llm_provider".to_string(), provider));
    }
    if let Some(model) = request.model.clone() {
        form.push(("model_name".to_string(), model));
    }
    if let Some(image_generation) = request.image_generation.clone() {
        form.push(("image_generation".to_string(), image_generation));
    }
    if let Some(image_model_provider) = request.image_model_provider.clone() {
        form.push(("image_model_provider".to_string(), image_model_provider));
    }
    if let Some(image_model_name) = request.image_model_name.clone() {
        form.push(("image_model_name".to_string(), image_model_name));
    }
    if let Some(voice) = request.voice.clone() {
        form.push(("voice".to_string(), serde_json::to_string(&voice)?));
    }
    if let Some(send_to_llm) = request.send_to_llm {
        form.push(("send_to_llm".to_string(), send_to_llm.to_string()));
    }
    if let Some(mcp_calls) = request.mcp_calls.clone() {
        form.push(("mcp_calls".to_string(), serde_json::to_string(&mcp_calls)?));
    }
    if let Some(max_tokens) = request.max_tokens {
        form.push(("max_tokens".to_string(), max_tokens.to_string()));
    }
    if let Some(thinking) = request.thinking.clone() {
        form.push(("thinking".to_string(), serde_json::to_string(&thinking)?));
    }
    if let Some(tools) = request.tools.clone() {
        form.push(("tools".to_string(), serde_json::to_string(&tools)?));
    }
    Ok(form)
}

fn message_json(request: &SendMessageRequest, stream: bool) -> Value {
    let mut body = Map::new();
    body.insert("content".to_string(), request.content.clone().into());
    body.insert("stream".to_string(), stream.into());
    body.insert("web_search".to_string(), request.web_search.clone().into());
    if let Some(memory) = request.memory.clone() {
        body.insert("memory".to_string(), memory.into());
    }
    if let Some(memory_pro) = request.memory_pro.clone() {
        body.insert("memory_pro".to_string(), memory_pro.into());
    }
    if let Some(thread_id) = request.thread_id.clone() {
        body.insert("thread_id".to_string(), thread_id.into());
    }
    if let Some(assistant_id) = request.assistant_id.clone() {
        body.insert("assistant_id".to_string(), assistant_id.into());
    }
    if let Some(provider) = request.provider.clone() {
        body.insert("llm_provider".to_string(), provider.into());
    }
    if let Some(model) = request.model.clone() {
        body.insert("model_name".to_string(), model.into());
    }
    if let Some(image_generation) = request.image_generation.clone() {
        body.insert("image_generation".to_string(), image_generation.into());
    }
    if let Some(image_model_provider) = request.image_model_provider.clone() {
        body.insert(
            "image_model_provider".to_string(),
            image_model_provider.into(),
        );
    }
    if let Some(image_model_name) = request.image_model_name.clone() {
        body.insert("image_model_name".to_string(), image_model_name.into());
    }
    if let Some(voice) = request.voice.clone() {
        body.insert("voice".to_string(), voice);
    }
    if let Some(send_to_llm) = request.send_to_llm {
        body.insert("send_to_llm".to_string(), send_to_llm.to_string().into());
    }
    if let Some(mcp_calls) = request.mcp_calls.clone() {
        body.insert("mcp_calls".to_string(), mcp_calls);
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert("max_tokens".to_string(), max_tokens.into());
    }
    if let Some(thinking) = request.thinking.clone() {
        body.insert("thinking".to_string(), thinking);
    }
    if let Some(tools) = request.tools.clone() {
        body.insert("tools".to_string(), tools.into());
    }
    Value::Object(body)
}

pub fn message_request_log_json(request: &SendMessageRequest, stream: bool) -> Value {
    let mut body = message_json(request, stream);
    if let Some(audio) = request.audio_file.as_ref() {
        if let Some(map) = body.as_object_mut() {
            map.insert(
                "audio_file".to_string(),
                json!({
                    "file_name": audio.file_name.clone(),
                    "mime_type": audio.mime_type.clone(),
                    "bytes": audio.data.len()
                }),
            );
        }
    }
    body
}

fn message_multipart_form(request: SendMessageRequest, stream: bool) -> Result<Form> {
    let mut form = Form::new();
    for (key, value) in message_form(&request, stream)? {
        form = form.text(key, value);
    }
    if let Some(audio) = request.audio_file {
        let part = Part::bytes(audio.data)
            .file_name(audio.file_name)
            .mime_str(&audio.mime_type)?;
        form = form.part("audio_file", part);
    }
    Ok(form)
}

fn message_request_builder(
    client: Client,
    url: String,
    api_key: reqwest::header::HeaderValue,
    request: SendMessageRequest,
    stream: bool,
) -> RequestBuilder {
    let builder = client.post(url).header("X-API-Key", api_key);
    if request.audio_file.is_some() {
        builder.multipart(message_multipart_form(request, stream).unwrap_or_else(|_| Form::new()))
    } else {
        builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(message_json(&request, stream).to_string())
    }
}

fn validate_message_request(request: &SendMessageRequest, stream: bool) -> Result<()> {
    if request.audio_file.is_some() {
        message_multipart_form(request.clone(), stream).map(|_| ())
    } else {
        message_json(request, stream);
        Ok(())
    }
}

fn realtime_voice_url(base_url: &str, api_key: &str) -> String {
    let mut base = base_url.trim_end_matches('/').to_string();
    if let Some(rest) = base.strip_prefix("https://") {
        base = format!("wss://{rest}");
    } else if let Some(rest) = base.strip_prefix("http://") {
        base = format!("ws://{rest}");
    }
    format!(
        "{base}/threads/messages?api_key={}",
        urlencoding::encode(api_key)
    )
}

fn sse_json_stream(response: Response) -> impl Stream<Item = Result<Value>> {
    let stream = Box::pin(response.bytes_stream());
    futures::stream::unfold(
        (stream, String::new(), VecDeque::<Result<Value>>::new()),
        |(mut stream, mut buffer, mut pending)| async move {
            loop {
                if let Some(item) = pending.pop_front() {
                    return Some((item, (stream, buffer, pending)));
                }

                let Some(chunk) = stream.next().await else {
                    return None;
                };

                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        return Some((Err(error.into()), (stream, buffer, pending)));
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));
                let Some(line_end) = buffer.rfind('\n') else {
                    continue;
                };

                let remaining = buffer.split_off(line_end + 1);
                let complete = std::mem::replace(&mut buffer, remaining);
                for line in complete.lines() {
                    let line = line.trim();
                    let Some(payload) = line.strip_prefix("data: ") else {
                        continue;
                    };
                    let payload = payload.trim();
                    if payload.is_empty() || payload == "[DONE]" {
                        continue;
                    }
                    pending.push_back(serde_json::from_str(payload).map_err(Into::into));
                }
            }
        },
    )
}

const STREAM_MAX_RETRIES: u32 = 5;
const STREAM_RETRY_BASE_DELAY: Duration = Duration::from_secs(2);

struct RetryStreamState<F> {
    make_request: F,
    attempt: u32,
    streamed_any: bool,
    stream: Option<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>>,
    sleep_before_request: Option<Duration>,
}

fn retrying_sse_json_stream<F>(make_request: F) -> Pin<Box<dyn Stream<Item = Result<Value>> + Send>>
where
    F: FnMut() -> RequestBuilder + Send + 'static,
{
    Box::pin(futures::stream::unfold(
        RetryStreamState {
            make_request,
            attempt: 0,
            streamed_any: false,
            stream: None,
            sleep_before_request: None,
        },
        |mut state| async move {
            loop {
                if let Some(stream) = state.stream.as_mut() {
                    match stream.next().await {
                        Some(Ok(value)) => {
                            state.streamed_any = true;
                            return Some((Ok(value), state));
                        }
                        Some(Err(error)) => {
                            if state.streamed_any
                                || state.attempt >= STREAM_MAX_RETRIES
                                || !is_transient_error(&error)
                            {
                                return Some((Err(error), state));
                            }
                            let retry = retry_chunk(state.attempt, None, Some(error.to_string()));
                            state.attempt += 1;
                            state.stream = None;
                            state.sleep_before_request = Some(retry_delay(state.attempt - 1));
                            return Some((Ok(retry), state));
                        }
                        None => return None,
                    }
                }

                if let Some(delay) = state.sleep_before_request.take() {
                    tokio::time::sleep(delay).await;
                }

                match (state.make_request)().send().await {
                    Ok(response) if response.status().is_success() => {
                        state.stream = Some(Box::pin(sse_json_stream(response)));
                    }
                    Ok(response)
                        if is_retryable_status(response.status())
                            && state.attempt < STREAM_MAX_RETRIES =>
                    {
                        let status = response.status();
                        let retry = retry_chunk(state.attempt, Some(status), None);
                        state.attempt += 1;
                        state.sleep_before_request = Some(retry_delay(state.attempt - 1));
                        return Some((Ok(retry), state));
                    }
                    Ok(response) => {
                        let status = response.status();
                        let body = response.text().await.unwrap_or_default();
                        return Some((Err(BackboardError::Api { status, body }.into()), state));
                    }
                    Err(error)
                        if is_transient_reqwest_error(&error)
                            && state.attempt < STREAM_MAX_RETRIES =>
                    {
                        let retry = retry_chunk(state.attempt, None, Some(error.to_string()));
                        state.attempt += 1;
                        state.sleep_before_request = Some(retry_delay(state.attempt - 1));
                        return Some((Ok(retry), state));
                    }
                    Err(error) => return Some((Err(error.into()), state)),
                }
            }
        },
    ))
}

fn retry_chunk(attempt: u32, status: Option<StatusCode>, error: Option<String>) -> Value {
    let delay = retry_delay(attempt).as_secs_f64();
    let mut chunk = json!({
        "type": "retry",
        "attempt": attempt + 1,
        "max_retries": STREAM_MAX_RETRIES,
        "delay": delay,
    });
    if let Some(status) = status {
        chunk["status_code"] = json!(status.as_u16());
    }
    if let Some(error) = error {
        chunk["error"] = json!(error);
    }
    chunk
}

fn retry_delay(attempt: u32) -> Duration {
    STREAM_RETRY_BASE_DELAY.saturating_mul(2u32.saturating_pow(attempt))
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
    )
}

fn is_transient_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(is_transient_reqwest_error)
}

fn is_transient_reqwest_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_config_uses_production_env() {
        let config = BackboardConfig::default();

        assert_eq!(config.env, "prod");
        assert_eq!(config.base_url(), PROD_API_URL);
    }

    #[test]
    fn development_config_uses_development_api() {
        let config = BackboardConfig {
            env: "dev".to_string(),
            api_key: Some("bb-dev-key".to_string()),
            env_keys: HashMap::from([("dev".to_string(), "bb-dev-key".to_string())]),
            ..BackboardConfig::default()
        };

        assert_eq!(config.env, "dev");
        assert_eq!(config.base_url(), DEV_API_URL);
        assert_eq!(
            config.env_keys.get("dev").map(String::as_str),
            Some("bb-dev-key")
        );
    }

    #[test]
    fn api_key_trims_saved_values_and_ignores_blank_keys() {
        let mut config = BackboardConfig {
            env: "prod".to_string(),
            api_key: Some("  bb-top-level-key  ".to_string()),
            ..BackboardConfig::default()
        };

        assert_eq!(config.api_key().as_deref(), Some("bb-top-level-key"));

        config.api_key = Some("  ".to_string());
        config
            .env_keys
            .insert("prod".to_string(), "  bb-env-key  ".to_string());

        assert_eq!(config.api_key().as_deref(), Some("bb-env-key"));
    }

    #[test]
    fn config_serializes_only_api_access_fields() {
        let config = BackboardConfig {
            env: "local".to_string(),
            api_key: Some("bb-key".to_string()),
            api_url: Some("http://localhost:8000".to_string()),
            env_keys: HashMap::from([("local".to_string(), "bb-key".to_string())]),
        };

        let value = serde_json::to_value(config).unwrap();

        assert_eq!(value["env"], "local");
        assert_eq!(value["api_key"], "bb-key");
        assert_eq!(value["api_url"], "http://localhost:8000");
        assert_eq!(value["env_keys"]["local"], "bb-key");
        assert!(value.get("assistant_id").is_none());
        assert!(value.get("thread_id").is_none());
        assert!(value.get("default_provider").is_none());
        assert!(value.get("default_model").is_none());
    }

    #[test]
    fn saving_api_key_writes_ide_config_file() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        let _guard = set_config_path_for_testing(path.clone());

        let config =
            BackboardConfig::save_api_key_for_current_env("  bb-test-key  ").expect("save api key");

        assert_eq!(config.api_key().as_deref(), Some("bb-test-key"));

        let contents = std::fs::read_to_string(&path).expect("read config file");
        let value: serde_json::Value = serde_json::from_str(&contents).expect("parse config");

        assert_eq!(value["env"], "prod");
        assert_eq!(value["api_key"], "bb-test-key");
        assert_eq!(value["env_keys"]["prod"], "bb-test-key");
        assert!(path.with_extension("json.bak").is_file());

        #[cfg(unix)]
        {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn saving_api_key_preserves_unrelated_config_fields() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-preserve-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        std::fs::create_dir_all(path.parent().unwrap()).expect("create config dir");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "env": "prod",
                "api_key": "old-key",
                "env_keys": {
                    "prod": "old-key",
                    "dev": "dev-key"
                },
                "default_provider": "aws-bedrock",
                "default_model": "anthropic.claude-opus-4-7",
                "assistant_id": "asst-1",
                "thread_id": "thread-1",
                "mcp_servers": {
                    "custom": {
                        "command": "python",
                        "args": ["-m", "server"],
                        "enabled": true
                    }
                },
                "thinking_config": {
                    "effort": "high"
                }
            }))
            .unwrap(),
        )
        .expect("write existing config");
        let _guard = set_config_path_for_testing(path.clone());

        BackboardConfig::save_api_key_for_current_env("new-key").expect("save api key");

        let contents = std::fs::read_to_string(&path).expect("read config file");
        let value: serde_json::Value = serde_json::from_str(&contents).expect("parse config");

        assert_eq!(value["env"], "prod");
        assert_eq!(value["api_key"], "new-key");
        assert_eq!(value["env_keys"]["prod"], "new-key");
        assert_eq!(value["env_keys"]["dev"], "dev-key");
        assert_eq!(value["default_provider"], "aws-bedrock");
        assert_eq!(value["default_model"], "anthropic.claude-opus-4-7");
        assert_eq!(value["assistant_id"], "asst-1");
        assert_eq!(value["thread_id"], "thread-1");
        assert_eq!(value["mcp_servers"]["custom"]["command"], "python");
        assert_eq!(value["thinking_config"]["effort"], "high");

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn loading_legacy_default_development_config_promotes_to_production() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-legacy-env-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        std::fs::create_dir_all(path.parent().unwrap()).expect("create config dir");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "env": "dev",
                "api_key": "legacy-key",
                "api_url": null,
                "env_keys": {
                    "dev": "legacy-key"
                }
            }))
            .unwrap(),
        )
        .expect("write legacy config");
        let _guard = set_config_path_for_testing(path.clone());

        let config = BackboardConfig::load().expect("load config");

        assert_eq!(config.env, "prod");
        assert_eq!(config.base_url(), PROD_API_URL);
        assert_eq!(config.api_key().as_deref(), Some("legacy-key"));
        assert_eq!(
            config.env_keys.get("prod").map(String::as_str),
            Some("legacy-key")
        );

        BackboardConfig::save_api_key_for_current_env("new-prod-key").expect("save api key");

        let contents = std::fs::read_to_string(&path).expect("read config file");
        let value: serde_json::Value = serde_json::from_str(&contents).expect("parse config");

        assert_eq!(value["env"], "prod");
        assert_eq!(value["api_key"], "new-prod-key");
        assert_eq!(value["env_keys"]["prod"], "new-prod-key");
        assert_eq!(value["env_keys"]["dev"], "legacy-key");

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn explicit_development_api_url_keeps_development_env() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-explicit-dev-env-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        std::fs::create_dir_all(path.parent().unwrap()).expect("create config dir");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "env": "dev",
                "api_key": "dev-key",
                "api_url": DEV_API_URL,
                "env_keys": {
                    "dev": "dev-key"
                }
            }))
            .unwrap(),
        )
        .expect("write dev config");
        let _guard = set_config_path_for_testing(path);

        let config = BackboardConfig::load().expect("load config");

        assert_eq!(config.env, "dev");
        assert_eq!(config.base_url(), DEV_API_URL);
        assert_eq!(config.api_key().as_deref(), Some("dev-key"));
        assert_eq!(config.env_keys.get("prod"), None);

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn saving_api_key_for_detected_development_env_survives_reload() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-detected-dev-env-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        let _guard = set_config_path_for_testing(path.clone());

        let config =
            BackboardConfig::save_api_key_for_env("  bb-dev-key  ", "dev").expect("save api key");

        assert_eq!(config.env, "dev");
        assert_eq!(config.api_url.as_deref(), Some(DEV_API_URL));
        assert_eq!(config.api_key().as_deref(), Some("bb-dev-key"));

        let reloaded = BackboardConfig::load().expect("load config");

        assert_eq!(reloaded.env, "dev");
        assert_eq!(reloaded.base_url(), DEV_API_URL);
        assert_eq!(reloaded.api_key().as_deref(), Some("bb-dev-key"));
        assert_eq!(reloaded.env_keys.get("prod"), None);

        let contents = std::fs::read_to_string(&path).expect("read config file");
        let value: serde_json::Value = serde_json::from_str(&contents).expect("parse config");

        assert_eq!(value["env"], "dev");
        assert_eq!(value["api_url"], DEV_API_URL);
        assert_eq!(value["api_key"], "bb-dev-key");
        assert_eq!(value["env_keys"]["dev"], "bb-dev-key");
        assert!(value["env_keys"].get("prod").is_none());

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn saving_api_key_publishes_saved_config_change() {
        let test_root = std::env::temp_dir().join(format!(
            "backboard-config-publish-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard_ide").join("config.json");
        let _guard = set_config_path_for_testing(path);
        let config_changes = subscribe_config_changes();

        BackboardConfig::save_api_key_for_current_env("published-key").expect("save api key");

        let published = config_changes.try_recv().expect("published config change");
        assert_eq!(published.env, "prod");
        assert_eq!(published.api_key().as_deref(), Some("published-key"));
        assert_eq!(
            published.env_keys.get("prod").map(String::as_str),
            Some("published-key")
        );

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn backboard_model_accepts_catalog_aliases() {
        let model: BackboardModel = serde_json::from_value(json!({
            "provider": "deepseek",
            "id": "deepseek-chat",
            "model_type": "reranker",
            "context_window": 64000,
        }))
        .expect("model aliases should deserialize");

        assert_eq!(model.provider, "deepseek");
        assert_eq!(model.name, "deepseek-chat");
        assert_eq!(model.model_type.as_deref(), Some("reranker"));
        assert_eq!(model.context_limit, Some(64000));
    }

    #[test]
    fn list_models_query_omits_model_type_when_absent() {
        let params = list_models_query_params(None, None, 0, 100);

        assert_eq!(
            params,
            vec![("skip", "0".to_string()), ("limit", "100".to_string())]
        );
    }

    #[test]
    fn list_models_query_includes_explicit_model_type() {
        let params = list_models_query_params(None, Some("llm"), 0, 100);

        assert_eq!(
            params,
            vec![
                ("model_type", "llm".to_string()),
                ("skip", "0".to_string()),
                ("limit", "100".to_string())
            ]
        );
    }

    #[test]
    fn model_provider_route_encodes_provider_name() {
        assert_eq!(
            model_provider_route("openai compatible"),
            "/models/provider/openai%20compatible"
        );
    }

    #[test]
    fn message_form_serializes_media_voice_and_search_fields() {
        let request = SendMessageRequest {
            thread_id: Some("thread_123".to_string()),
            content: "make a diagram".to_string(),
            provider: Some("openai".to_string()),
            model: Some("gpt-4o".to_string()),
            web_search: "Auto".to_string(),
            image_generation: Some("auto".to_string()),
            image_model_provider: Some("openrouter".to_string()),
            image_model_name: Some("google/gemini-3.1-flash-image-preview".to_string()),
            voice: Some(json!({
                "tts": {
                    "provider": "openai",
                    "model": "gpt-4o-mini-tts",
                    "voice": "alloy",
                }
            })),
            send_to_llm: Some(true),
            mcp_calls: Some(json!(["figma"])),
            ..SendMessageRequest::default()
        };

        let form = message_form(&request, true).unwrap();
        assert!(form.contains(&("thread_id".to_string(), "thread_123".to_string())));
        assert!(form.contains(&("web_search".to_string(), "Auto".to_string())));
        assert!(form.contains(&("image_generation".to_string(), "auto".to_string())));
        assert!(form.contains(&("image_model_provider".to_string(), "openrouter".to_string())));
        assert!(form.contains(&(
            "image_model_name".to_string(),
            "google/gemini-3.1-flash-image-preview".to_string()
        )));
        assert!(form.iter().any(|(key, value)| {
            key == "voice" && value.contains("gpt-4o-mini-tts") && value.contains("alloy")
        }));
        assert!(form.contains(&("send_to_llm".to_string(), "true".to_string())));
        assert!(form.contains(&("mcp_calls".to_string(), "[\"figma\"]".to_string())));
    }

    #[test]
    fn message_json_serializes_recommended_send_message_payload() {
        let request = SendMessageRequest {
            thread_id: Some("thread_123".to_string()),
            content: "say hello".to_string(),
            provider: Some("openai".to_string()),
            model: Some("gpt-4o".to_string()),
            web_search: "Auto".to_string(),
            voice: Some(json!({
                "tts": {
                    "provider": "openai",
                    "model": "gpt-4o-mini-tts",
                    "voice": "alloy",
                }
            })),
            send_to_llm: Some(true),
            ..SendMessageRequest::default()
        };

        let body = message_json(&request, true);

        assert_eq!(body["thread_id"], "thread_123");
        assert_eq!(body["stream"], true);
        assert_eq!(body["llm_provider"], "openai");
        assert_eq!(body["model_name"], "gpt-4o");
        assert_eq!(body["web_search"], "Auto");
        assert_eq!(body["send_to_llm"], "true");
        assert_eq!(body["voice"]["tts"]["model"], "gpt-4o-mini-tts");
        assert!(body.get("provider").is_none());
        assert!(body.get("model").is_none());
    }

    #[test]
    fn message_json_omits_ids_for_first_turn_request() {
        let request = SendMessageRequest {
            content: "start a new task".to_string(),
            provider: Some("openai".to_string()),
            model: Some("gpt-4o".to_string()),
            ..SendMessageRequest::default()
        };

        let body = message_json(&request, true);

        assert_eq!(body["stream"], true);
        assert!(body.get("thread_id").is_none());
        assert!(body.get("assistant_id").is_none());
    }

    #[test]
    fn message_thread_binding_extracts_returned_ids() {
        let chunk = json!({
            "type": "run_started",
            "data": {
                "thread": {"id": "thread_123"},
                "assistant_id": "assistant_456"
            }
        });

        let binding = message_thread_binding(&chunk);

        assert_eq!(binding.thread_id.as_deref(), Some("thread_123"));
        assert_eq!(binding.assistant_id.as_deref(), Some("assistant_456"));
    }

    #[test]
    fn message_json_omits_tools_when_not_supplied() {
        let request = SendMessageRequest {
            thread_id: Some("thread_123".to_string()),
            content: "say hello".to_string(),
            tools: None,
            ..SendMessageRequest::default()
        };

        let body = message_json(&request, true);

        assert!(body.get("tools").is_none());
    }

    #[test]
    fn submit_tool_outputs_omits_tools_when_not_supplied() {
        let request = SubmitToolOutputsRequest {
            tool_outputs: vec![json!({"tool_call_id": "call_1", "output": "{}"})],
            tools: None,
        };
        let body = serde_json::to_value(&request).unwrap();

        assert!(body.get("tool_outputs").is_some());
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn multipart_message_accepts_audio_file() {
        let request = SendMessageRequest {
            thread_id: Some("thread_123".to_string()),
            voice: Some(json!({
                "stt": {
                    "provider": "openai",
                    "model": "gpt-4o-mini-transcribe",
                    "language": "en",
                }
            })),
            send_to_llm: Some(false),
            audio_file: Some(AudioAttachment {
                data: vec![1, 2, 3],
                file_name: "voice.mp3".to_string(),
                mime_type: "audio/mpeg".to_string(),
            }),
            ..SendMessageRequest::default()
        };

        message_multipart_form(request, true).expect("multipart form should build");
    }

    #[test]
    fn realtime_voice_url_uses_ws_scheme_and_encoded_key() {
        assert_eq!(
            realtime_voice_url("https://app.backboard.io/api", "key with spaces"),
            "wss://app.backboard.io/api/threads/messages?api_key=key%20with%20spaces"
        );
    }
}
