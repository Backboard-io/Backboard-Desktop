use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{LazyLock, Mutex, MutexGuard},
    time::Duration,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackboardConfig {
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub assistant_id: Option<String>,
    #[serde(default)]
    pub env_keys: HashMap<String, String>,
}

fn default_env() -> String {
    "prod".into()
}

impl BackboardConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("reading Backboard config at {}", path.display()))?;
        let mut config: Self = serde_json::from_str(&contents)
            .with_context(|| format!("parsing Backboard config at {}", path.display()))?;
        config.promote_legacy_default_env();
        Ok(config)
    }

    pub fn load_or_default() -> Self {
        Self::load().unwrap_or_default()
    }

    pub fn save_api_key_for_current_env(api_key: impl Into<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.promote_legacy_default_env();
        let api_key = api_key.into().trim().to_string();
        let env = config.env.to_lowercase();

        config.env_keys.insert(env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn clear_api_key_for_current_env() -> Result<Self> {
        let mut config = Self::load_or_default();
        config.promote_legacy_default_env();
        let env = config.env.to_lowercase();

        config.api_key = None;
        config.env_keys.remove(&env);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn save_model_selection(
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.default_provider = Some(provider.into());
        config.default_model = Some(model.into());
        config.save()?;
        Ok(config)
    }

    pub fn save_session(assistant_id: Option<String>, thread_id: Option<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        if assistant_id.is_some() {
            config.assistant_id = assistant_id;
        }
        if thread_id.is_some() {
            config.thread_id = thread_id;
        }
        config.save()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let dir = path
            .parent()
            .context("Backboard config path does not have a parent directory")?;

        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating Backboard config dir at {}", dir.display()))?;
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing Backboard config at {}", path.display()))?;

        #[cfg(unix)]
        {
            let permissions = std::fs::Permissions::from_mode(0o600);
            let _ = std::fs::set_permissions(&path, permissions);
        }

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

    fn promote_legacy_default_env(&mut self) {
        if self.api_url.is_none() && self.env.eq_ignore_ascii_case("dev") {
            if let Some(api_key) = self.env_keys.get("dev").cloned() {
                self.env_keys.entry("prod".to_string()).or_insert(api_key);
            }
            self.env = default_env();
        }
    }
}

fn non_empty_api_key(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

impl Default for BackboardConfig {
    fn default() -> Self {
        Self {
            env: default_env(),
            api_key: None,
            api_url: None,
            default_provider: None,
            default_model: None,
            thread_id: None,
            assistant_id: None,
            env_keys: HashMap::default(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".backboard").join("config.json"))
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
    #[serde(default = "default_memory")]
    pub memory: String,
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

fn default_memory() -> String {
    "Auto".into()
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
            memory: default_memory(),
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

#[derive(Clone, Debug, Default, Serialize)]
pub struct RecentUsageQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub page_size: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BackboardModel {
    #[serde(default)]
    pub provider: String,
    #[serde(default, alias = "id", alias = "model_id")]
    pub name: String,
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

impl BackboardClient {
    pub fn from_config(config: BackboardConfig) -> Result<Self> {
        let api_key = config.api_key().ok_or(BackboardError::MissingApiKey)?;
        Ok(Self::new(config.base_url(), api_key))
    }

    pub fn from_cli_config() -> Result<Self> {
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
        let _ = response.bytes().await;
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

    pub async fn send_message(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Value> {
        let request = request.with_thread_id(thread_id);
        self.json(self.message_request_builder(self.url("/threads/messages"), request, false)?)
            .await
    }

    pub async fn send_message_stream(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let request = request.with_thread_id(thread_id);
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

    pub async fn list_models(
        &self,
        provider: Option<&str>,
        model_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let mut params = vec![
            ("model_type", model_type.unwrap_or("llm").to_string()),
            ("limit", limit.unwrap_or(15000).to_string()),
        ];
        if let Some(provider) = provider {
            params.push(("provider", provider.to_string()));
        }
        let data: Value = self
            .json(
                self.client
                    .get(self.url("/models"))
                    .headers(self.json_headers()?)
                    .query(&params),
            )
            .await?;
        let values = data
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        values
            .into_iter()
            .map(serde_json::from_value)
            .collect::<serde_json::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub async fn list_providers(&self) -> Result<Vec<String>> {
        let data: Value = self
            .json(
                self.client
                    .get(self.url("/models/providers"))
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
        let page_size = query.page_size.clamp(1, 100).to_string();
        let mut params = vec![("page", "1".to_string()), ("page_size", page_size)];
        if let Some(model_name) = query.model_name {
            params.push(("model_name", model_name));
        }
        if let Some(input_tokens) = query.input_tokens {
            params.push(("input_tokens", input_tokens.to_string()));
        }
        if let Some(output_tokens) = query.output_tokens {
            params.push(("output_tokens", output_tokens.to_string()));
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

async fn parse_json_response<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let text = response.text().await?;
    Ok(serde_json::from_str(&text)?)
}

fn message_form(request: &SendMessageRequest, stream: bool) -> Result<Vec<(String, String)>> {
    let mut form = vec![
        ("content".to_string(), request.content.clone()),
        ("stream".to_string(), stream.to_string()),
        ("memory".to_string(), request.memory.clone()),
        ("web_search".to_string(), request.web_search.clone()),
    ];
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
    body.insert("memory".to_string(), request.memory.clone().into());
    body.insert("web_search".to_string(), request.web_search.clone().into());
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
        let _ = message_json(request, stream);
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
    fn default_config_uses_production_api() {
        let config = BackboardConfig::default();

        assert_eq!(config.env, "prod");
        assert_eq!(config.base_url(), PROD_API_URL);
    }

    #[test]
    fn legacy_dev_config_without_custom_url_promotes_to_production() {
        let mut config = BackboardConfig {
            env: "dev".to_string(),
            api_key: Some("bb-prod-key".to_string()),
            env_keys: HashMap::from([("dev".to_string(), "bb-prod-key".to_string())]),
            ..BackboardConfig::default()
        };

        config.promote_legacy_default_env();

        assert_eq!(config.env, "prod");
        assert_eq!(config.base_url(), PROD_API_URL);
        assert_eq!(
            config.env_keys.get("prod").map(String::as_str),
            Some("bb-prod-key")
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
    fn backboard_model_accepts_catalog_aliases() {
        let model: BackboardModel = serde_json::from_value(json!({
            "provider": "deepseek",
            "id": "deepseek-chat",
            "context_window": 64000,
        }))
        .expect("model aliases should deserialize");

        assert_eq!(model.provider, "deepseek");
        assert_eq!(model.name, "deepseek-chat");
        assert_eq!(model.context_limit, Some(64000));
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
