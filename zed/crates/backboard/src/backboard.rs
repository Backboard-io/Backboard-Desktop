use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    pin::Pin,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use anyhow::{Context as _, Result};
use futures::{Stream, StreamExt as _};
use reqwest::{
    Client, Response, StatusCode,
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const PROD_API_URL: &str = "https://app.backboard.io/api";
pub const DEV_API_URL: &str = "https://dev.app.backboard.io/api";
pub const LOCAL_API_URL: &str = "http://localhost:8000";

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
    "dev".into()
}

impl BackboardConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("reading Backboard config at {}", path.display()))?;
        serde_json::from_str(&contents)
            .with_context(|| format!("parsing Backboard config at {}", path.display()))
    }

    pub fn load_or_default() -> Self {
        Self::load().unwrap_or_default()
    }

    pub fn save_api_key_for_current_env(api_key: impl Into<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        let api_key = api_key.into();
        let env = config.env.to_lowercase();

        config.env_keys.insert(env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;

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
        self.api_key.clone().or_else(|| {
            self.env_keys
                .get(&self.env.to_lowercase())
                .filter(|key| !key.is_empty())
                .cloned()
        })
    }
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

#[derive(Clone, Debug, Serialize)]
pub struct SendMessageRequest {
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
    pub max_tokens: Option<u32>,
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
            content: String::new(),
            provider: None,
            model: None,
            memory: default_memory(),
            thinking: None,
            tools: None,
            web_search: default_web_search(),
            max_tokens: None,
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
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
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
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
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
        self.json(
            self.client
                .post(self.url(&format!("/threads/{thread_id}/messages")))
                .header("X-API-Key", self.api_key_header()?)
                .form(&message_form(request, false)?),
        )
        .await
    }

    pub async fn send_message_stream(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let response = self
            .client
            .post(self.url(&format!("/threads/{thread_id}/messages")))
            .header("X-API-Key", self.api_key_header()?)
            .form(&message_form(request, true)?)
            .send()
            .await?;
        let response = self.ensure_success(response).await?;
        Ok(Box::pin(sse_json_stream(response)))
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

async fn parse_json_response<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let text = response.text().await?;
    Ok(serde_json::from_str(&text)?)
}

fn message_form(request: SendMessageRequest, stream: bool) -> Result<Vec<(String, String)>> {
    let mut form = vec![
        ("content".to_string(), request.content),
        ("stream".to_string(), stream.to_string()),
        ("memory".to_string(), request.memory),
        ("web_search".to_string(), request.web_search),
    ];
    if let Some(provider) = request.provider {
        form.push(("llm_provider".to_string(), provider));
    }
    if let Some(model) = request.model {
        form.push(("model_name".to_string(), model));
    }
    if let Some(max_tokens) = request.max_tokens {
        form.push(("max_tokens".to_string(), max_tokens.to_string()));
    }
    if let Some(thinking) = request.thinking {
        form.push(("thinking".to_string(), serde_json::to_string(&thinking)?));
    }
    if let Some(tools) = request.tools {
        form.push(("tools".to_string(), serde_json::to_string(&tools)?));
    }
    Ok(form)
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
