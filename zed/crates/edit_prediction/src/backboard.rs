use crate::{
    DebugEvent, EditPredictionFinishedDebugEvent, EditPredictionModelInput,
    EditPredictionStartedDebugEvent, EditPredictionStore,
    prediction::{EditPredictionId, EditPredictionResult},
};
use anyhow::{Context as _, Result};
use backboard_api::{BackboardConfig, BackboardModel};
use credentials_provider::CredentialsProvider;
use futures::{
    AsyncBufReadExt as _, AsyncReadExt as _, FutureExt as _, StreamExt as _, io::BufReader,
};
use gpui::{
    App, AppContext as _, Context, Entity, Global, SharedString, Task,
    http_client::{self, AsyncBody, HttpClient, Method},
};
use language::{ToOffset, ToPoint as _};
use language_model::{ApiKeyState, EnvVar, env_var};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use zeta_prompt::ZetaPromptInput;

/// Prefix context window — ~10–12 lines of context before the cursor.
const FIM_MAX_BEFORE_BYTES: usize = 600;
/// Suffix context window — ~5–6 lines after the cursor so the model can see
/// what code already exists and avoid duplicating it.
const FIM_MAX_AFTER_BYTES: usize = 300;
const COMPLETION_CHUNK_LINE_THRESHOLD: usize = 14;
const COMPLETION_CHUNK_COMPLEXITY_THRESHOLD: usize = 6;
const COMPLETION_TARGET_CHUNK_LINES: usize = 8;
const COMPLETION_MIN_CHUNK_LINES: usize = 3;
pub const BACKBOARD_CREDENTIALS_URL: SharedString =
    SharedString::new_static("https://app.backboard.io/api");

pub static BACKBOARD_TOKEN_ENV_VAR: std::sync::LazyLock<EnvVar> = env_var!("BACKBOARD_API_KEY");

static BACKBOARD_MODEL_CACHE: LazyLock<Mutex<HashMap<String, BackboardModel>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// Prevents multiple concurrent requests from all triggering a registry fetch simultaneously.
// The first request to see a cache miss sets this flag and does the fetch; all others fall
// back to DEBUG_BACKBOARD_MODEL immediately and will benefit from the cache on their next try.
static BACKBOARD_REGISTRY_FETCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static BACKBOARD_ASSISTANT_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const DEBUG_BACKBOARD_MODEL: &str = "claude-haiku-4-5-20251001";

struct GlobalBackboardApiKey(Entity<ApiKeyState>);

impl Global for GlobalBackboardApiKey {}

pub fn backboard_api_token(cx: &mut App) -> Entity<ApiKeyState> {
    if let Some(global) = cx.try_global::<GlobalBackboardApiKey>() {
        return global.0.clone();
    }
    let entity =
        cx.new(|_| ApiKeyState::new(BACKBOARD_CREDENTIALS_URL, BACKBOARD_TOKEN_ENV_VAR.clone()));
    cx.set_global(GlobalBackboardApiKey(entity.clone()));
    entity
}

pub fn load_backboard_api_token(
    cx: &mut App,
) -> Task<Result<(), language_model::AuthenticateError>> {
    let credentials_provider = zed_credentials_provider::global(cx);
    backboard_api_token(cx).update(cx, |key_state, cx| {
        key_state.load_if_needed(BACKBOARD_CREDENTIALS_URL, |s| s, credentials_provider, cx)
    })
}

fn load_cached_backboard_model(base_url: &str) -> Option<BackboardModel> {
    let cache_key = base_url.trim_end_matches('/');
    BACKBOARD_MODEL_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(cache_key).cloned())
}

fn store_cached_backboard_model(base_url: &str, model: &BackboardModel) {
    let cache_key = base_url.trim_end_matches('/');
    if let Ok(mut cache) = BACKBOARD_MODEL_CACHE.lock() {
        cache.insert(cache_key.to_string(), model.clone());
    }
}

fn load_cached_backboard_assistant(base_url: &str) -> Option<String> {
    let cache_key = base_url.trim_end_matches('/');
    BACKBOARD_ASSISTANT_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(cache_key).cloned())
}

fn store_cached_backboard_assistant(base_url: &str, assistant_id: &str) {
    let cache_key = base_url.trim_end_matches('/');
    if let Ok(mut cache) = BACKBOARD_ASSISTANT_CACHE.lock() {
        cache.insert(cache_key.to_string(), assistant_id.to_string());
    }
}

pub struct BackboardCompletions {
    pub api_token: Entity<ApiKeyState>,
    quota_exceeded: bool,
    pub completions_used: u32,
    /// Cached assistant_id so creation is only done once per process lifetime.
    cached_assistant: Option<String>,
    /// Cached Backboard model name so registry discovery is only done once.
    cached_model: Option<BackboardModel>,
}

impl BackboardCompletions {
    pub fn new(cx: &mut App) -> Self {
        Self {
            api_token: backboard_api_token(cx),
            quota_exceeded: false,
            completions_used: 0,
            cached_assistant: None,
            cached_model: None,
        }
    }

    pub fn has_personal_key(&self, cx: &App) -> bool {
        self.api_token.read(cx).has_key() || saved_backboard_api_key().is_some()
    }

    pub fn resolve_api_key(&self, cx: &App) -> Option<Arc<str>> {
        self.api_token
            .read(cx)
            .key(&BACKBOARD_CREDENTIALS_URL)
            .or_else(saved_backboard_api_key)
    }

    pub(crate) fn request_prediction(
        &mut self,
        EditPredictionModelInput {
            buffer,
            snapshot,
            position,
            events,
            related_files,
            debug_tx,
            ..
        }: EditPredictionModelInput,
        credentials_provider: Arc<dyn CredentialsProvider>,
        cx: &mut Context<EditPredictionStore>,
    ) -> Task<Result<Option<EditPredictionResult>>> {
        self.api_token.update(cx, |key_state, cx| {
            _ = key_state.load_if_needed(
                BACKBOARD_CREDENTIALS_URL,
                |s| s,
                credentials_provider,
                cx,
            );
        });

        if self.quota_exceeded {
            return Task::ready(Ok(None));
        }

        let Some(api_key) = self.resolve_api_key(cx) else {
            return Task::ready(Ok(None));
        };
        if api_key.trim().is_empty() {
            log::warn!(
                "backboard: API key is missing — set the BACKBOARD_API_KEY environment variable \
                 or configure credentials for {}",
                BACKBOARD_CREDENTIALS_URL
            );
            return Task::ready(Ok(None));
        }

        let settings = language::language_settings::all_language_settings(None, cx);
        let backboard_settings = settings.edit_predictions.backboard.clone();
        let configured_model = backboard_settings.model.clone();
        let base_url = backboard_settings.api_url.clone();
        let completion_timeout = Duration::from_millis(backboard_settings.timeout_ms);

        let cached_model = self
            .cached_model
            .clone()
            .or_else(|| load_cached_backboard_model(&base_url));
        if let Some(model) = cached_model.as_ref() {
            log::info!("backboard: model cache hit model={}", model.name);
            self.cached_model = Some(model.clone());
        } else {
            log::info!("backboard: model cache miss");
        }

        let cached_assistant = self
            .cached_assistant
            .clone()
            .or_else(|| load_cached_backboard_assistant(&base_url));
        if let Some(assistant_id) = cached_assistant.as_ref() {
            log::info!(
                "backboard: assistant cache hit assistant_id={}",
                assistant_id
            );
            self.cached_assistant = cached_assistant.clone();
        } else {
            log::info!("backboard: assistant cache miss");
        }

        let full_path: Arc<Path> = snapshot
            .file()
            .map(|file| file.full_path(cx))
            .unwrap_or_else(|| "untitled".into())
            .into();

        let language_name: Option<String> = snapshot
            .language()
            .map(|language| language.name().to_string());

        let insertion_point = position.to_point(&snapshot);
        let insertion_offset = insertion_point.to_offset(&snapshot);

        let (excerpt_point_range, _excerpt_offset_range, cursor_offset_in_excerpt) =
            crate::cursor_excerpt::compute_cursor_excerpt(&snapshot, insertion_offset);
        let cursor_excerpt: Arc<str> = snapshot
            .text_for_range(excerpt_point_range.clone())
            .collect::<String>()
            .into();

        if !should_request_completion(&cursor_excerpt, cursor_offset_in_excerpt, insertion_offset) {
            log::debug!("backboard: skipped — pre-filter rejected position");
            return Task::ready(Ok(None));
        }
        log::info!("backboard: completion request started (offset={insertion_offset})");

        let active_buffer = buffer.clone();
        let buffer_for_result = buffer.clone();
        let base_url_for_spawn = base_url.clone();
        let request_start = cx.background_executor().now();
        let http_client = cx.http_client();

        let background_result = cx.background_spawn(async move {
            let related_files = zeta_prompt::filter_redundant_excerpts(
                related_files,
                full_path.as_ref(),
                excerpt_point_range.start.row..excerpt_point_range.end.row,
            );

            let inputs = ZetaPromptInput {
                events,
                related_files: Some(related_files),
                cursor_offset_in_excerpt,
                cursor_path: full_path.clone(),
                cursor_excerpt: cursor_excerpt.clone(),
                excerpt_start_row: Some(excerpt_point_range.start.row),
                excerpt_ranges: Default::default(),
                syntax_ranges: None,
                active_buffer_diagnostics: vec![],
                in_open_source_repo: false,
                can_collect_data: false,
                repo_url: None,
            };

            let prompt = build_completion_prompt(&inputs, language_name.as_deref());
            log::debug!(
                "backboard: prompt preview ({}B): {:?}",
                prompt.len(),
                &prompt[..prompt.len().min(500)]
            );

            if let Some(debug_tx) = &debug_tx {
                debug_tx
                    .unbounded_send(DebugEvent::EditPredictionStarted(
                        EditPredictionStartedDebugEvent {
                            buffer: active_buffer.downgrade(),
                            prompt: Some(prompt[..prompt.len().min(200)].to_string()),
                            position,
                        },
                    ))
                    .ok();
            }

            let request_phase_started = Instant::now();
            let selected_model = resolve_backboard_model(
                &api_key,
                &base_url,
                Some(configured_model.as_str()),
                cached_model.as_ref(),
                &http_client,
            )
            .await
            .context("Backboard model resolution failed")?;
            log::info!(
                "backboard: model resolution finished in {}ms",
                request_phase_started.elapsed().as_millis()
            );
            store_cached_backboard_model(&base_url, &selected_model);

            let request_phase_started = Instant::now();
            log::info!("backboard: completion run started");
            let response_text = backboard_completion(
                &api_key,
                &base_url,
                &selected_model,
                &prompt,
                cached_assistant.as_deref(),
                &http_client,
            )
            .await
            .context("Backboard completion failed")?;
            log::info!(
                "backboard: completion run finished elapsed_ms={}",
                request_phase_started.elapsed().as_millis()
            );

            if let Some(debug_tx) = &debug_tx {
                debug_tx
                    .unbounded_send(DebugEvent::EditPredictionFinished(
                        EditPredictionFinishedDebugEvent {
                            buffer: active_buffer.downgrade(),
                            model_output: Some(response_text.clone()),
                            position,
                        },
                    ))
                    .ok();
            }

            anyhow::Ok(Some((
                selected_model,
                response_text,
                snapshot,
                inputs,
                language_name,
                insertion_offset,
            )))
        });

        cx.spawn(async move |ep_store, cx| {
            let timer = cx.background_executor().timer(completion_timeout);
            let mut background_result = background_result.fuse();
            let mut timer = timer.fuse();

            let interim: Result<
                Option<(
                    BackboardModel,
                    String,
                    language::BufferSnapshot,
                    ZetaPromptInput,
                    Option<String>,
                    usize,
                )>,
            > = futures::select! {
                result = background_result => result,
                _ = timer => Err(anyhow::anyhow!(
                    "Backboard request timed out after {}ms",
                    completion_timeout.as_millis()
                )),
            };

            if let Err(ref err) = interim {
                if is_quota_exceeded_error(err) {
                    ep_store.update(cx, |store, cx| {
                        store.backboard.quota_exceeded = true;
                        cx.notify();
                    })?;
                    return anyhow::Ok(None);
                }
            }

            let result = interim.context("Backboard edit prediction failed")?;
            let Some((
                selected_model,
                response_text,
                old_snapshot,
                inputs,
                language_name,
                insertion_offset,
            )) = result
            else {
                return anyhow::Ok(None);
            };

            ep_store.update(cx, |store, _| {
                store.backboard.cached_model = Some(selected_model.clone());
                if store.backboard.cached_assistant.is_none() {
                    store.backboard.cached_assistant =
                        load_cached_backboard_assistant(&base_url_for_spawn);
                }
            })?;

            let response_str = strip_code_fences(&response_text);
            log::info!(
                "backboard: response received ({} chars): {:?}",
                response_str.len(),
                response_str.chars().take(200).collect::<String>()
            );

            let completion_text = strip_typed_prefix_from_completion(response_str, &inputs);
            if completion_text.len() != response_str.len() {
                log::info!(
                    "backboard: reason=duplicate_prefix stripped {} chars",
                    response_str.len().saturating_sub(completion_text.len())
                );
            }

            let Some(chunks) = filtered_function_completion_chunks(
                &completion_text,
                &inputs,
                language_name.as_deref(),
            ) else {
                return anyhow::Ok(None);
            };
            log::info!(
                "backboard: accepted ({} chunk(s)); preview: {:?}",
                chunks.len(),
                &chunks[0][..chunks[0].len().min(100)]
            );

            let path = inputs.cursor_path.to_string_lossy().to_string();
            backboard_api::publish_inline_completion_output(
                backboard_api::InlineCompletionOutput {
                    title: "Inline autocomplete completion".to_string(),
                    path: Some(path),
                    language: language_name,
                    chunks,
                },
            );

            let insertion_anchor = old_snapshot.anchor_after(insertion_offset);
            let edits: Arc<[(std::ops::Range<language::Anchor>, Arc<str>)]> = vec![(
                insertion_anchor.clone()..insertion_anchor,
                Arc::from(completion_text.as_str()),
            )]
            .into();
            let e2e_latency = cx.background_executor().now() - request_start;
            let result = EditPredictionResult::new(
                EditPredictionId(uuid::Uuid::new_v4().to_string().into()),
                &buffer_for_result,
                &old_snapshot,
                edits,
                None,
                inputs,
                None,
                e2e_latency,
                cx,
            )
            .await;

            anyhow::Ok(Some(result))
        })
    }
}

fn saved_backboard_api_key() -> Option<Arc<str>> {
    BackboardConfig::load_or_default()
        .api_key()
        .map(Arc::<str>::from)
}

/// Pre-filter based purely on the typed text: skip insertion points where a
/// completion would almost never be useful.
fn should_request_completion(
    cursor_excerpt: &str,
    cursor_offset_in_excerpt: usize,
    _insertion_offset: usize,
) -> bool {
    if cursor_excerpt.len() < 5 {
        return false;
    }

    let code_before = &cursor_excerpt[..cursor_offset_in_excerpt];
    let code_after = &cursor_excerpt[cursor_offset_in_excerpt..];

    let current_line_before = code_before.rsplit('\n').next().unwrap_or(code_before);

    // Always trigger on a blank line that follows `:` or `{` — function/class stubs.
    if current_line_before.trim().is_empty() {
        let prev_nonempty = code_before
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let prev_trimmed = prev_nonempty.trim_end();
        if prev_trimmed.ends_with(':') || prev_trimmed.ends_with('{') {
            return true;
        }
    }

    // Always trigger after common expression-continuation characters.
    let trimmed_before = current_line_before.trim_end();
    if trimmed_before.ends_with('.')
        || trimmed_before.ends_with('(')
        || trimmed_before.ends_with(" =")
        || trimmed_before.ends_with('=')
    {
        return true;
    }

    // Skip mid-word — splitting an existing identifier adds nothing.
    if code_after
        .chars()
        .next()
        .is_some_and(|c| c.is_alphanumeric() || c == '_')
        && code_before
            .chars()
            .last()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
    {
        return false;
    }

    // Skip when the cursor is on the same line as a just-closed statement or slice.
    if current_line_before.trim_end().ends_with([';', ']']) {
        return false;
    }

    true
}

#[derive(Debug)]
struct BackboardQuotaExceededError {
    status_code: u16,
}

#[derive(Debug, Deserialize)]
struct CreateAssistantResponse {
    assistant_id: String,
}

#[derive(Debug, Deserialize)]
struct CreateThreadResponse {
    thread_id: String,
}

impl std::fmt::Display for BackboardQuotaExceededError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Backboard quota exceeded (HTTP {})", self.status_code)
    }
}

impl std::error::Error for BackboardQuotaExceededError {}

fn is_quota_exceeded_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<BackboardQuotaExceededError>()
        .is_some()
}

// ── Core HTTP call ────────────────────────────────────────────────────────────

/// Sends a single message to a fresh Backboard thread and streams the response.
///
/// A new thread is created for every call so there is no accumulated conversation
/// history between completions. The assistant is reused from the cache to avoid its
/// creation round-trip. The ephemeral thread_id is never stored after the request.
async fn backboard_completion(
    api_key: &str,
    base_url: &str,
    selected_model: &BackboardModel,
    prompt: &str,
    cached_assistant_id: Option<&str>,
    http_client: &Arc<dyn HttpClient>,
) -> Result<String> {
    let base_url = base_url.trim_end_matches('/');

    let assistant_id = if let Some(aid) = cached_assistant_id {
        log::info!("backboard: assistant cache hit assistant_id={}", aid);
        aid.to_string()
    } else {
        let cold_start_started = Instant::now();
        log::info!("backboard: assistant cache miss -> creating assistant");
        let body = serde_json::to_vec(&serde_json::json!({
            "name": "Backboard Studio Inline Completion"
        }))?;
        let assistant_started = Instant::now();
        log::info!("backboard: create assistant started");
        let assistant = backboard_post_json(
            http_client,
            api_key,
            &format!("{base_url}/assistants"),
            body,
        )
        .await
        .context("Backboard: create_assistant failed")?;
        log::info!(
            "backboard: create assistant finished elapsed_ms={}",
            assistant_started.elapsed().as_millis()
        );
        let response: CreateAssistantResponse = serde_json::from_value(assistant)
            .context("Backboard: failed to parse create_assistant response")?;
        let assistant_id = response.assistant_id;
        if assistant_id.is_empty() {
            anyhow::bail!("Backboard: create_assistant response missing assistant_id");
        }
        log::info!("backboard: created assistant_id={}", assistant_id);
        store_cached_backboard_assistant(base_url, &assistant_id);
        log::info!(
            "backboard: cold start finished elapsed_ms={}",
            cold_start_started.elapsed().as_millis()
        );
        assistant_id
    };

    let thread_started = Instant::now();
    log::info!(
        "backboard: autocomplete run creating ephemeral thread assistant_id={}",
        assistant_id
    );
    let thread = backboard_post_json(
        http_client,
        api_key,
        &format!("{base_url}/assistants/{assistant_id}/threads"),
        serde_json::to_vec(&serde_json::json!({}))?,
    )
    .await
    .context("Backboard: create_thread failed")?;
    log::info!(
        "backboard: create thread finished elapsed_ms={}",
        thread_started.elapsed().as_millis()
    );
    let response: CreateThreadResponse = serde_json::from_value(thread)
        .context("Backboard: failed to parse create_thread response")?;
    let thread_id = response.thread_id;
    if thread_id.is_empty() {
        anyhow::bail!("Backboard: create_thread response missing thread_id");
    }
    log::debug!("backboard: ephemeral thread_id={} (not cached)", thread_id);

    let completion_started = Instant::now();
    log::info!(
        "backboard: running completion with model={} base_url={}",
        selected_model.name,
        base_url
    );
    log::info!(
        "backboard: run payload assistant_id={} thread_id={} provider={} model_name={} model_id_sent={:?}",
        assistant_id,
        thread_id,
        selected_model.provider,
        selected_model.name,
        Some(format!(
            "{}/{}",
            selected_model.provider, selected_model.name
        ))
    );

    let form_body = encode_form_body(&[
        ("content", prompt),
        ("stream", "true"),
        ("memory", "off"),
        ("web_search", "off"),
        ("llm_provider", selected_model.provider.as_str()),
        ("model_name", selected_model.name.as_str()),
        ("max_tokens", "256"),
    ]);

    let request = http_client::Request::builder()
        .method(Method::POST)
        .uri(format!("{base_url}/threads/{thread_id}/messages"))
        .header("X-API-Key", api_key)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(AsyncBody::from(form_body))?;

    let run_started = Instant::now();
    let mut response = http_client.send(request).await?;

    if !response.status().is_success() {
        let status = response.status();
        let mut error_body = String::new();
        response
            .body_mut()
            .read_to_string(&mut error_body)
            .await
            .ok();
        if status.as_u16() == 402 || status.as_u16() == 429 {
            return Err(BackboardQuotaExceededError {
                status_code: status.as_u16(),
            }
            .into());
        }
        log::info!("backboard: raw run error body: {}", error_body);
        if is_model_not_supported_message(&error_body) {
            anyhow::bail!(unsupported_backboard_model_message(
                selected_model.name.as_str(),
                base_url
            ));
        }
        anyhow::bail!("Backboard API error {}: {}", status, error_body);
    }

    let reader = BufReader::new(response.into_body());
    let mut lines = reader.lines();
    let mut accumulated = String::new();

    while let Some(line_result) = lines.next().await {
        let line = line_result.context("Backboard: stream read error")?;
        let line = line.trim();
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let chunk: Value =
            serde_json::from_str(payload).context("Backboard: failed to parse SSE chunk")?;
        let chunk_type = chunk
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        log::debug!("backboard: stream event type={}", chunk_type);

        match chunk_type {
            "content_streaming" => {
                if let Some(content) = chunk.get("content").and_then(Value::as_str) {
                    accumulated.push_str(content);
                    let non_ws = accumulated.chars().filter(|c| !c.is_whitespace()).count();
                    if non_ws >= 5 && accumulated.contains('\n') {
                        log::info!(
                            "backboard: parsed completion length={} (early return)",
                            accumulated.len()
                        );
                        log::info!(
                            "backboard: completion request finished in {}ms",
                            completion_started.elapsed().as_millis()
                        );
                        return Ok(accumulated);
                    }
                }
            }
            "run_ended" => {
                let final_content = chunk
                    .get("content")
                    .or_else(|| chunk.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !final_content.is_empty() && accumulated.is_empty() {
                    accumulated = final_content.to_string();
                }
                break;
            }
            "run_failed" | "error" => {
                let error = chunk
                    .get("error")
                    .or_else(|| chunk.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error");
                log::info!("backboard: raw run error payload: {}", payload);
                if is_model_not_supported_message(error) {
                    anyhow::bail!(unsupported_backboard_model_message(
                        selected_model.name.as_str(),
                        base_url
                    ));
                }
                anyhow::bail!("Backboard run failed: {}", error);
            }
            _ => {}
        }
    }

    log::info!("backboard: parsed completion length={}", accumulated.len());
    log::info!(
        "backboard: completion run finished elapsed_ms={}",
        run_started.elapsed().as_millis()
    );
    Ok(accumulated)
}

fn is_model_not_supported_message(error: &str) -> bool {
    error.contains("is not supported")
}

fn unsupported_backboard_model_message(model: &str, base_url: &str) -> String {
    format!(
        "Backboard model `{model}` is not supported by the current Backboard API at \
         `{base_url}`. Choose a supported Backboard model or switch api_url/backend to \
         OpenRouter. You can fetch the live model registry from `/models` or override \
         `edit_predictions.backboard.model` in settings."
    )
}

async fn resolve_backboard_model(
    api_key: &str,
    base_url: &str,
    configured_model: Option<&str>,
    cached_model: Option<&BackboardModel>,
    http_client: &Arc<dyn HttpClient>,
) -> Result<BackboardModel> {
    if let Some(configured_model) = configured_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        if cached_model
            .as_ref()
            .is_some_and(|model| model.name == configured_model)
        {
            log::info!("backboard: model cache hit model={}", configured_model);
        } else {
            log::info!(
                "backboard: using configured Backboard model override={}",
                configured_model
            );
        }
        return Ok(BackboardModel {
            provider: cached_model
                .as_ref()
                .map(|model| model.provider.clone())
                .unwrap_or_else(|| "anthropic".to_string()),
            name: configured_model.to_string(),
            ..Default::default()
        });
    }

    if let Some(cached_model) = cached_model.filter(|model| !model.name.trim().is_empty()) {
        log::info!("backboard: model cache hit model={}", cached_model.name);
        return Ok(cached_model.clone());
    }

    // Only one concurrent request should fetch the registry. If another is already in flight,
    // use the hardcoded fallback immediately — the cache will be populated by the time that
    // request finishes and the next keypress will get the real model.
    if BACKBOARD_REGISTRY_FETCH_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!(
            "backboard: registry fetch already in progress, using fallback model={}",
            DEBUG_BACKBOARD_MODEL
        );
        return Ok(BackboardModel {
            provider: "anthropic".to_string(),
            name: DEBUG_BACKBOARD_MODEL.to_string(),
            ..Default::default()
        });
    }

    log::info!("backboard: model cache miss, fetching registry");
    let models = fetch_backboard_models(api_key, base_url, http_client)
        .await
        .unwrap_or_else(|err| {
            log::warn!(
                "backboard: model registry fetch failed: {err:#}, falling back to {}",
                DEBUG_BACKBOARD_MODEL
            );
            vec![]
        });
    BACKBOARD_REGISTRY_FETCH_IN_PROGRESS.store(false, Ordering::SeqCst);

    let model = select_preferred_backboard_model(models).unwrap_or_else(|| {
        log::warn!(
            "backboard: no suitable model in registry, falling back to {}",
            DEBUG_BACKBOARD_MODEL
        );
        BackboardModel {
            provider: "anthropic".to_string(),
            name: DEBUG_BACKBOARD_MODEL.to_string(),
            ..Default::default()
        }
    });
    log::info!(
        "backboard: selected model={} provider={}",
        model.name,
        model.provider
    );
    Ok(model)
}

async fn fetch_backboard_models(
    api_key: &str,
    base_url: &str,
    http_client: &Arc<dyn HttpClient>,
) -> Result<Vec<BackboardModel>> {
    let base_url = base_url.trim_end_matches('/');
    let response = backboard_get_json(
        http_client,
        api_key,
        &format!("{base_url}/models?model_type=llm&limit=200"),
    )
    .await
    .context("Backboard: list_models failed")?;
    let raw_response = serde_json::to_string(&response).unwrap_or_default();
    log::info!(
        "backboard: model registry response: {}",
        &raw_response[..raw_response.len().min(1000)]
    );

    let models = response
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    models
        .into_iter()
        .map(serde_json::from_value)
        .collect::<serde_json::Result<Vec<_>>>()
        .map_err(Into::into)
}

// Providers known to serve reliable, code-capable models suitable for autocomplete.
// Models from any other provider are excluded regardless of price.
const AUTOCOMPLETE_TRUSTED_PROVIDERS: &[&str] = &["anthropic", "openai", "deepseek"];

fn select_preferred_backboard_model(models: Vec<BackboardModel>) -> Option<BackboardModel> {
    // Only consider models from trusted providers. This prevents the cost-only ranking from
    // selecting unrelated models (e.g. story generators, image models) that happen to be cheap.
    let trusted: Vec<BackboardModel> = models
        .into_iter()
        .filter(|m| {
            let provider_lower = m.provider.to_ascii_lowercase();
            AUTOCOMPLETE_TRUSTED_PROVIDERS
                .iter()
                .any(|p| provider_lower.contains(p))
        })
        .collect();

    fn score(model: &BackboardModel) -> (f64, u64, &str, &str) {
        let cost = model.input_cost_per_1m_tokens.unwrap_or(f64::INFINITY)
            + model.output_cost_per_1m_tokens.unwrap_or(f64::INFINITY);
        let context_limit = model.context_limit.unwrap_or(u64::MAX);
        (
            cost,
            context_limit,
            model.provider.as_str(),
            model.name.as_str(),
        )
    }

    trusted.into_iter().min_by(|left, right| {
        let left_score = score(left);
        let right_score = score(right);
        left_score
            .0
            .partial_cmp(&right_score.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_score.1.cmp(&right_score.1))
            .then_with(|| left_score.2.cmp(right_score.2))
            .then_with(|| left_score.3.cmp(right_score.3))
    })
}

async fn backboard_post_json(
    http_client: &Arc<dyn HttpClient>,
    api_key: &str,
    url: &str,
    body: Vec<u8>,
) -> Result<Value> {
    let request = http_client::Request::builder()
        .method(Method::POST)
        .uri(url)
        .header("X-API-Key", api_key)
        .header("Content-Type", "application/json")
        .body(AsyncBody::from(body))?;
    let mut response = http_client.send(request).await?;
    if !response.status().is_success() {
        let status = response.status();
        let mut error_body = String::new();
        response
            .body_mut()
            .read_to_string(&mut error_body)
            .await
            .ok();
        anyhow::bail!("Backboard API error {}: {}", status, error_body);
    }
    let mut response_body = String::new();
    response
        .body_mut()
        .read_to_string(&mut response_body)
        .await?;
    log::info!(
        "backboard: POST {} response: {}",
        url,
        &response_body[..response_body.len().min(400)]
    );
    serde_json::from_str(&response_body).context("Failed to parse Backboard JSON response")
}

#[allow(dead_code)]
async fn backboard_get_json(
    http_client: &Arc<dyn HttpClient>,
    api_key: &str,
    url: &str,
) -> Result<Value> {
    let request = http_client::Request::builder()
        .method(Method::GET)
        .uri(url)
        .header("X-API-Key", api_key)
        .header("Content-Type", "application/json")
        .body(AsyncBody::from(Vec::new()))?;
    let mut response = http_client.send(request).await?;
    if !response.status().is_success() {
        let status = response.status();
        let mut error_body = String::new();
        response
            .body_mut()
            .read_to_string(&mut error_body)
            .await
            .ok();
        anyhow::bail!("Backboard API error {}: {}", status, error_body);
    }
    let mut response_body = String::new();
    response
        .body_mut()
        .read_to_string(&mut response_body)
        .await?;
    serde_json::from_str(&response_body).context("Failed to parse Backboard JSON response")
}

fn encode_form_body(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            b => {
                let hi = char::from_digit((b >> 4) as u32, 16).unwrap_or('0');
                let lo = char::from_digit((b & 0xf) as u32, 16).unwrap_or('0');
                encoded.push('%');
                encoded.push(hi.to_ascii_uppercase());
                encoded.push(lo.to_ascii_uppercase());
            }
        }
    }
    encoded
}

// ── Prompt building ───────────────────────────────────────────────────────────

const BACKBOARD_INLINE_SYSTEM_PROMPT: &str = "\
You are an inline code completion engine.\n\
Return ONLY the exact code that should be inserted at the cursor.\n\
Do not explain.\n\
Do not describe the surrounding code.\n\
Do not mention your role.\n\
Do not mention the prompt.\n\
Do not mention system instructions.\n\
Do not use markdown.\n\
Do not use code fences.\n\
Do not include natural language.\n\
Do not repeat the prefix.\n\
If no useful code completion exists, return an empty string.";

fn build_completion_prompt(inputs: &ZetaPromptInput, language_name: Option<&str>) -> String {
    let cursor_offset = inputs
        .cursor_offset_in_excerpt
        .min(inputs.cursor_excerpt.len());
    let full_before = &inputs.cursor_excerpt[..cursor_offset];
    let full_after = &inputs.cursor_excerpt[cursor_offset..];
    let code_before = trim_prefix_to_last_n_bytes(full_before, FIM_MAX_BEFORE_BYTES);
    let code_after = &full_after[..full_after.len().min(FIM_MAX_AFTER_BYTES)];
    let lang = language_name.unwrap_or("code");

    format!(
        "{system_prompt}\n\n\
         Complete the code at <cursor>.\n\n\
         Rules:\n\
         - Output only the code to insert at <cursor>.\n\
         - No explanations.\n\
         - No markdown.\n\
         - No prose.\n\
         - No comments unless the prefix is already inside a comment.\n\
         - Keep it short.\n\n\
         Language: {lang}\n\n\
         <prefix>\n{code_before}\n</prefix>\n\
         <suffix>\n{code_after}\n</suffix>\n\
         <cursor>",
        system_prompt = BACKBOARD_INLINE_SYSTEM_PROMPT,
    )
}

/// Returns the suffix of `s` starting at a UTF-8 char boundary such that
/// the result is at most `max_bytes` long.
fn trim_prefix_to_last_n_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let start = s.len() - max_bytes;
    let start = (start..=s.len())
        .find(|&i| s.is_char_boundary(i))
        .unwrap_or(s.len());
    &s[start..]
}

fn strip_code_fences(response: &str) -> &str {
    let text = if response.starts_with("```") {
        let after_fence = &response[3..];
        after_fence
            .find('\n')
            .map(|i| &after_fence[i + 1..])
            .unwrap_or(after_fence)
    } else {
        response
    };
    text.trim_end_matches("```").trim_end_matches("\n```")
}

// Remove any leading portion of `completion` that duplicates what the user has already typed
// on the current line. This handles models that echo back the prefix when completing mid-token
// (e.g. cursor after `user.` and model returns `user.name;` instead of just `name;`).
fn strip_typed_prefix_from_completion(completion: &str, inputs: &ZetaPromptInput) -> String {
    let cursor_offset = inputs
        .cursor_offset_in_excerpt
        .min(inputs.cursor_excerpt.len());
    let code_before = &inputs.cursor_excerpt[..cursor_offset];
    // Use rfind to get the actual current line — .lines().last() skips trailing newlines
    // and would return the previous line when the cursor is at the start of a new line.
    let current_line = if let Some(newline_pos) = code_before.rfind('\n') {
        &code_before[newline_pos + 1..]
    } else {
        code_before
    };
    let typed = current_line.trim_start();
    if typed.is_empty() {
        return completion.to_string();
    }
    let completion_trimmed = completion.trim_start_matches(|c: char| c == ' ' || c == '\t');
    if let Some(rest) = completion_trimmed.strip_prefix(typed) {
        return rest.to_string();
    }
    completion.to_string()
}

fn is_non_completion(response: &str) -> bool {
    if response.is_empty() || response == "None" {
        return true;
    }
    if response.chars().all(|c| c.is_whitespace()) {
        return true;
    }
    let trimmed = response.trim();

    // Reject prompt echo — model returned FIM tags or language header
    let first_line = trimmed.lines().next().unwrap_or("");
    if first_line.starts_with("File: ")
        || first_line.starts_with("Language: ")
        || first_line.contains("[CURSOR]")
        || first_line.contains("<cursor>")
        || first_line.contains("<|fim_prefix|>")
        || first_line.contains("<|fim_suffix|>")
        || first_line.contains("<|fim_middle|>")
        || first_line.contains("<fim_prefix>")
        || first_line.contains("<fim_suffix>")
        || first_line.contains("<fim_middle>")
        || first_line.contains("<CURSOR>")
        || first_line.contains("<prefix>")
        || first_line.contains("<suffix>")
    {
        log::info!("backboard: rejected reason=prompt_echo");
        return true;
    }

    // Reject known assistant-speak prefixes (first line starts with these)
    let lower_first = first_line.trim().to_ascii_lowercase();
    let assistant_prefixes = [
        "i appreciate",
        "i notice",
        "i can see",
        "i'm sorry",
        "i am sorry",
        "looking at",
        "based on",
        "this appears",
        "it appears",
        "it seems",
        "you've asked",
        "you've provided",
        "you have provided",
        "you have asked",
        "let me clarify",
        "let me explain",
        "to complete",
        "to answer",
        "here is",
        "here's",
        "here are",
        "the cursor",
        "the code",
        "this code",
        "the prefix",
        "the suffix",
        "there is",
        "there are",
        "in this",
        "in the",
        "as an inline",
        "as a code",
        "my role",
        "my job",
        "i need to",
        "i should",
        "i would",
        "i will",
        "certainly",
        "sure,",
        "of course",
        "note:",
        "note that",
        "please note",
        "please provide",
    ];
    if assistant_prefixes
        .iter()
        .any(|p| lower_first.starts_with(p))
    {
        log::info!("backboard: rejected reason=assistant_preamble");
        return true;
    }

    // Reject completions that mention meta-concepts about the prompt/role
    let lower_full = trimmed.to_ascii_lowercase();
    let meta_phrases = [
        "system prompt",
        "conflicting instruction",
        "my role is",
        "i need to clarify",
        "i should clarify",
        "code completion engine",
        "fill-in-the-middle",
        "fim engine",
        "inline completion",
        "i'm an",
        "i am an",
        "as an ai",
        "as a language model",
    ];
    if meta_phrases.iter().any(|p| lower_full.contains(p)) {
        log::info!("backboard: rejected reason=meta_phrases");
        return true;
    }

    // Reject all-comment lines with no code symbols
    let all_comment_lines = trimmed.lines().all(|line| {
        let t = line.trim();
        t.is_empty()
            || t.starts_with("//")
            || t.starts_with('#')
            || t.starts_with("/*")
            || t.starts_with('*')
    });
    if all_comment_lines {
        let has_code = trimmed
            .chars()
            .any(|c| matches!(c, '{' | '}' | '(' | ')' | ';' | '=' | ':' | ','));
        if !has_code {
            log::info!("backboard: rejected reason=all_comments");
            return true;
        }
    }

    // Reject completions where any non-comment line looks like prose
    if contains_prose_like_line(trimmed) {
        log::info!("backboard: rejected reason=prose_not_code");
        return true;
    }

    false
}

fn contains_prose_like_line(text: &str) -> bool {
    text.lines().any(is_prose_like_line)
}

fn is_prose_like_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("//")
        || trimmed.starts_with('#')
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
    {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    let prose_phrases = [
        "looking at the context",
        "looking at the code",
        "based on the pattern",
        "based on the code",
        "based on the context",
        "this appears to be",
        "the cursor is positioned",
        "the cursor appears",
        "in this case",
        "it looks like",
        "it appears that",
        "as an ai",
        "as a language model",
        "the code suggests",
        "the surrounding code",
        "the function uses",
        "returns a",
        "you've provided",
        "you have provided",
        "i notice",
        "i appreciate",
        "i can see",
        "system prompt",
        "code completion",
        "fill-in-the-middle",
    ];
    if prose_phrases.iter().any(|phrase| lower.contains(phrase)) {
        return true;
    }

    let has_code_symbols = trimmed.chars().any(|c| {
        matches!(
            c,
            '{' | '}' | '(' | ')' | ';' | '=' | '[' | ']' | ':' | '<' | '>' | '_' | '"' | '\''
        )
    });

    let word_count = trimmed.split_whitespace().count();

    // Sentence with punctuation and no code symbols
    let sentence_like =
        word_count >= 8 && trimmed.chars().any(|c| c == '.' || c == ',') && !has_code_symbols;
    if sentence_like {
        return true;
    }

    // Uppercase-starting, multi-word, no code symbols
    word_count >= 6
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
        && !has_code_symbols
}

fn filtered_function_completion_chunks(
    response: &str,
    inputs: &ZetaPromptInput,
    language_name: Option<&str>,
) -> Option<Vec<String>> {
    let completion = normalize_completion_text(response);
    if is_non_completion(&completion) {
        return None;
    }

    if completion.trim().is_empty() {
        log::info!("backboard: rejected reason=empty_completion");
        return None;
    }

    let cursor_offset = inputs
        .cursor_offset_in_excerpt
        .min(inputs.cursor_excerpt.len());
    let code_before = &inputs.cursor_excerpt[..cursor_offset];
    // Use rfind to find what has actually been typed on the current line. .lines().last()
    // does not yield a trailing empty line, so it would return the comment when the cursor
    // is on a fresh empty line below one — causing the midline limit to fire incorrectly.
    let current_line = if let Some(newline_pos) = code_before.rfind('\n') {
        &code_before[newline_pos + 1..]
    } else {
        code_before
    };
    let is_midline = !current_line.trim().is_empty();
    let max_lines: usize = if is_midline { 4 } else { 15 };
    let line_count = completion.lines().count();
    if line_count > max_lines {
        log::info!(
            "backboard: rejected reason=too_long lines={} max={}",
            line_count,
            max_lines
        );
        return None;
    }

    let code_after = &inputs.cursor_excerpt[cursor_offset..];
    if completion_duplicates_existing_code(&completion, code_after) {
        log::info!("backboard: rejected reason=duplicates_existing_code");
        return None;
    }

    let language = detect_language(language_name, &inputs.cursor_path);
    if let Some(reason) = validate_completion_syntax(&completion, inputs, language) {
        log::info!("backboard: rejected reason={}", reason);
        return None;
    }

    log::info!("backboard: accepted reason=accepted");
    Some(split_completion_into_chunks(&completion))
}

fn completion_duplicates_existing_code(completion: &str, code_after: &str) -> bool {
    if code_after.trim().is_empty() {
        return false;
    }
    let completion_lines: Vec<&str> = completion
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if completion_lines.is_empty() {
        return false;
    }
    let after_lines: std::collections::HashSet<&str> = code_after
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let duplicate_count = completion_lines
        .iter()
        .filter(|l| after_lines.contains(*l))
        .count();
    duplicate_count * 100 / completion_lines.len() > 40
}

fn normalize_completion_text(response: &str) -> String {
    let response = response.trim_matches(|c| c == '\n' || c == '\r').trim_end();
    if let Some(fenced_block) = extract_first_code_fence(response) {
        return fenced_block.replace("<CURSOR>", "").trim_end().to_string();
    }
    response.replace("<CURSOR>", "")
}

fn extract_first_code_fence(response: &str) -> Option<String> {
    let start = response.find("```")?;
    let after_start = &response[start + 3..];
    let after_language = after_start
        .find('\n')
        .map(|index| &after_start[index + 1..])
        .unwrap_or(after_start);
    let end = after_language.find("```")?;
    Some(
        after_language[..end]
            .trim_matches(|c| c == '\n' || c == '\r')
            .to_string(),
    )
}

fn starts_with_control_keyword(lower: &str) -> bool {
    [
        "if ",
        "for ",
        "while ",
        "match ",
        "switch ",
        "return ",
        "break ",
        "continue ",
        "else ",
        "try ",
        "catch ",
    ]
    .iter()
    .any(|keyword| lower.starts_with(keyword))
}

fn split_completion_into_chunks(completion: &str) -> Vec<String> {
    let line_count = completion.lines().count();
    let complexity = completion_complexity(completion);
    if line_count <= COMPLETION_CHUNK_LINE_THRESHOLD
        && complexity <= COMPLETION_CHUNK_COMPLEXITY_THRESHOLD
    {
        return vec![completion.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_line_count = 0usize;
    let mut brace_depth = 0i32;

    for line in completion.lines() {
        current.push_str(line);
        current.push('\n');
        current_line_count += 1;

        for c in line.chars() {
            match c {
                '{' | '(' | '[' => brace_depth += 1,
                '}' | ')' | ']' => brace_depth = brace_depth.saturating_sub(1),
                _ => {}
            }
        }

        let line_is_blank = line.trim().is_empty();
        let low_depth_boundary = brace_depth <= 1 && line.trim_end().ends_with('}');
        let size_boundary = current_line_count >= COMPLETION_TARGET_CHUNK_LINES;
        if current_line_count >= COMPLETION_MIN_CHUNK_LINES
            && (line_is_blank || low_depth_boundary || size_boundary)
        {
            push_completion_chunk(&mut chunks, &mut current);
            current_line_count = 0;
        }
    }

    push_completion_chunk(&mut chunks, &mut current);
    if chunks.is_empty() {
        vec![completion.to_string()]
    } else {
        chunks
    }
}

fn push_completion_chunk(chunks: &mut Vec<String>, current: &mut String) {
    let chunk = current.trim_end();
    if !chunk.is_empty() {
        chunks.push(chunk.to_string());
    }
    current.clear();
}

fn completion_complexity(completion: &str) -> usize {
    completion
        .lines()
        .filter(|line| {
            let lower = line.trim_start().to_ascii_lowercase();
            starts_with_control_keyword(&lower)
                || lower.starts_with("elif ")
                || lower.starts_with("except ")
                || lower.starts_with("defer ")
                || lower.starts_with("guard ")
        })
        .count()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Language {
    Python,
    TypeScriptJs,
    Unknown,
}

fn detect_language(name: Option<&str>, path: &std::path::Path) -> Language {
    let name_hint = name.unwrap_or("").to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if name_hint.contains("python") || ext == "py" {
        Language::Python
    } else if name_hint.contains("typescript")
        || name_hint.contains("javascript")
        || matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
    {
        Language::TypeScriptJs
    } else {
        Language::Unknown
    }
}

// Returns a rejection reason code if the completion fails syntax/formatting validation,
// or None if it is acceptable. Checks are fast and local — no full-file parsing.
fn validate_completion_syntax(
    completion: &str,
    inputs: &ZetaPromptInput,
    language: Language,
) -> Option<&'static str> {
    let cursor_offset = inputs
        .cursor_offset_in_excerpt
        .min(inputs.cursor_excerpt.len());
    let code_before = &inputs.cursor_excerpt[..cursor_offset];
    let code_after = &inputs.cursor_excerpt[cursor_offset..];

    let current_line_before = if let Some(pos) = code_before.rfind('\n') {
        &code_before[pos + 1..]
    } else {
        code_before
    };
    let current_line_after = code_after.lines().next().unwrap_or("");

    // Find the most recent non-empty line before the cursor, skipping whitespace-only lines.
    let prev_nonempty_line = code_before
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");

    let is_midline = !current_line_before.trim().is_empty();
    let current_indent = current_line_before.len() - current_line_before.trim_start().len();

    let first_line = completion.lines().next().unwrap_or("");
    let first_trimmed = first_line.trim_start();

    // --- Python-specific ---
    if language == Language::Python {
        // Reject C-style block delimiters that have no place in Python.
        for line in completion.lines() {
            let t = line.trim();
            if t == "{" || t.ends_with(" {") || t == "}" || t.starts_with("} ") || t == "};" {
                return Some("python_c_style_braces");
            }
        }

        // After a line ending in ':', the completion must land at a deeper indent level.
        // The effective indentation in the document is cursor column + completion-line indent,
        // because the cursor is already positioned after any auto-inserted whitespace.
        if !is_midline && prev_nonempty_line.trim_end().ends_with(':') {
            let prev_indent = prev_nonempty_line.len() - prev_nonempty_line.trim_start().len();
            let first_content = completion
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("");
            let completion_indent = first_content.len() - first_content.trim_start().len();
            let effective_indent = current_indent + completion_indent;
            if effective_indent <= prev_indent {
                return Some("python_needs_indent_after_colon");
            }
        }

        // Inside an indented block, reject completions whose lines jump to column 0
        // with a top-level declaration keyword.
        if !is_midline && current_indent > 0 {
            for line in completion.lines() {
                let line_trimmed = line.trim_start();
                let line_indent = line.len() - line_trimmed.len();
                if line_indent == 0 && !line_trimmed.is_empty() {
                    if line_trimmed.starts_with("def ")
                        || line_trimmed.starts_with("class ")
                        || line_trimmed.starts_with("import ")
                        || line_trimmed.starts_with("from ")
                        || line_trimmed.starts_with('@')
                    {
                        return Some("python_top_level_decl_in_block");
                    }
                }
            }
        }
    }

    // --- Mid-line content validation (language-independent) ---
    if is_midline {
        let is_decl = first_trimmed.starts_with("import ")
            || first_trimmed.starts_with("from ")
            || first_trimmed.starts_with("function ")
            || first_trimmed.starts_with("async function ")
            || first_trimmed.starts_with("class ")
            || first_trimmed.starts_with("def ");
        if is_decl {
            return Some("midline_starts_with_declaration");
        }

        if language == Language::TypeScriptJs {
            let is_ts_export_decl = first_trimmed.starts_with("export function ")
                || first_trimmed.starts_with("export default ")
                || first_trimmed.starts_with("export class ")
                || first_trimmed.starts_with("export const ");
            if is_ts_export_decl {
                return Some("midline_starts_with_declaration");
            }
        }
    }

    // --- Bracket safety at the insertion point ---
    // If completion ends with a closing bracket and code_after begins with the same one,
    // and completion has more closes than opens for that bracket type, it is duplicating
    // a bracket already present in the document.
    let last_char = completion.trim_end().chars().last();
    let first_after_char = current_line_after.trim_start().chars().next();
    if let (Some(last), Some(first)) = (last_char, first_after_char) {
        if last == first && matches!(last, ')' | '}' | ']') {
            let (opens, closes) = match last {
                ')' => (
                    completion.chars().filter(|&c| c == '(').count(),
                    completion.chars().filter(|&c| c == ')').count(),
                ),
                '}' => (
                    completion.chars().filter(|&c| c == '{').count(),
                    completion.chars().filter(|&c| c == '}').count(),
                ),
                ']' => (
                    completion.chars().filter(|&c| c == '[').count(),
                    completion.chars().filter(|&c| c == ']').count(),
                ),
                _ => (0, 0),
            };
            if closes > opens {
                return Some("duplicate_closing_bracket");
            }
        }
    }

    // --- TypeScript/JavaScript: imports outside the import section ---
    if language == Language::TypeScriptJs && !is_midline {
        let is_import_line = first_trimmed.starts_with("import ")
            || first_trimmed.starts_with("import{")
            || first_trimmed.starts_with("import type ");
        if is_import_line {
            let past_imports = code_before
                .lines()
                .filter(|l| !l.trim().is_empty())
                .any(|l| {
                    let t = l.trim_start();
                    !t.starts_with("import ")
                        && !t.starts_with("import{")
                        && !t.starts_with("import type ")
                        && !t.starts_with("//")
                        && !t.starts_with("/*")
                        && !t.starts_with('*')
                        && !t.starts_with("\"use ")
                        && !t.starts_with("'use ")
                });
            if past_imports {
                return Some("ts_import_outside_import_section");
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn input(cursor_excerpt: &str, cursor_offset_in_excerpt: usize) -> ZetaPromptInput {
        input_with_lang(cursor_excerpt, cursor_offset_in_excerpt, "test.rs")
    }

    fn input_with_lang(
        cursor_excerpt: &str,
        cursor_offset_in_excerpt: usize,
        path: &str,
    ) -> ZetaPromptInput {
        ZetaPromptInput {
            events: vec![],
            related_files: Some(vec![]),
            cursor_offset_in_excerpt,
            cursor_path: Arc::from(Path::new(path)),
            cursor_excerpt: cursor_excerpt.into(),
            excerpt_start_row: None,
            excerpt_ranges: Default::default(),
            syntax_ranges: None,
            active_buffer_diagnostics: vec![],
            in_open_source_repo: false,
            can_collect_data: false,
            repo_url: None,
        }
    }

    #[test]
    fn accepts_any_valid_code_completion() {
        let inputs = input("", 0);
        assert!(filtered_function_completion_chunks("const value = 1;", &inputs, None).is_some());
        assert!(filtered_function_completion_chunks("return value;", &inputs, None).is_some());
        assert!(filtered_function_completion_chunks("import os", &inputs, None).is_some());
        assert!(filtered_function_completion_chunks("class Foo:", &inputs, None).is_some());
        assert!(
            filtered_function_completion_chunks("fn parse_value() {}", &inputs, None).is_some()
        );
        let context = "fn parse_value() {\n    ";
        let body = input(context, context.len());
        assert!(
            filtered_function_completion_chunks("let value = 1;\nreturn value;", &body, None)
                .is_some()
        );
    }

    #[test]
    fn splits_large_function_completion() {
        let top_level = input("", 0);
        let completion = "fn parse_value() {\n    if true {\n        one();\n    }\n\n    for item in items {\n        two(item);\n    }\n\n    while ready() {\n        three();\n    }\n\n    four();\n}";
        let Some(chunks) = filtered_function_completion_chunks(completion, &top_level, None) else {
            panic!("large function completion should pass the filter");
        };
        assert!(chunks.len() > 1);
    }

    #[test]
    fn fim_prompt_contains_cursor_and_context() {
        let excerpt = "def greet():\n    name = \"world\"\n    print(\"hello\")\n";
        let cursor = excerpt.find("print").unwrap();
        let inputs = input(excerpt, cursor);
        let prompt = build_completion_prompt(&inputs, Some("python"));
        assert!(prompt.contains(BACKBOARD_INLINE_SYSTEM_PROMPT));
        assert!(prompt.contains("<cursor>"));
        assert!(prompt.contains("Language: python"));
        // both prefix and suffix content must appear inline
        assert!(prompt.contains("name = \"world\""));
        assert!(prompt.contains("print(\"hello\")"));
    }

    #[test]
    fn fim_echo_and_prose_rejected_by_non_completion_filter() {
        // Model echoing the [CURSOR] marker back
        assert!(is_non_completion("def greet()[CURSOR]:\n    pass"));
        // Model echoing old-style FIM tokens
        assert!(is_non_completion(
            "<|fim_prefix|>some code<|fim_suffix|>more<|fim_middle|>"
        ));
        // Model echoing new-style FIM tags
        assert!(is_non_completion("<prefix>\nsome code\n</prefix>"));
        // Prose response
        assert!(is_non_completion(
            "Looking at the context, this appears to be a helper function."
        ));
        // Mixed prose and code
        assert!(is_non_completion("Here's the completion:\ndef foo(): pass"));
    }

    #[test]
    fn rejects_assistant_prose() {
        // Natural language prefixes
        assert!(is_non_completion(
            "I appreciate you providing context, but I need to clarify..."
        ));
        assert!(is_non_completion(
            "Looking at this Python code, I need to complete..."
        ));
        assert!(is_non_completion(
            "I notice there's some confusion in the prompt."
        ));
        assert!(is_non_completion(
            "You've provided multiple system prompts..."
        ));
        assert!(is_non_completion(
            "Based on the pattern, this looks like a helper function."
        ));
        assert!(is_non_completion("Here is the completion you requested:"));
        assert!(is_non_completion(
            "To complete this code, I would suggest..."
        ));
        // Valid code should pass
        assert!(!is_non_completion("response.json()"));
        assert!(!is_non_completion("return response.json()"));
        assert!(!is_non_completion("except Exception as e:"));
        assert!(!is_non_completion("headers=headers,\n        json=payload"));
        assert!(!is_non_completion(
            "    value = compute(x)\n    return value"
        ));
    }

    #[test]
    fn strips_typed_prefix_mid_token() {
        // Cursor is after `user.` — model echoes back the full typed prefix
        let context = "const userName = user.";
        let inputs = input(context, context.len());
        let result = strip_typed_prefix_from_completion("const userName = user.name;", &inputs);
        assert_eq!(result, "name;");
    }

    #[test]
    fn strips_typed_prefix_with_leading_indent() {
        // Completion carries indentation from the line; trim_start normalises before matching
        let context = "fn foo() {\n    let x = user.";
        let inputs = input(context, context.len());
        let result = strip_typed_prefix_from_completion("    let x = user.name;", &inputs);
        assert_eq!(result, "name;");
    }

    #[test]
    fn does_not_strip_prefix_when_cursor_at_line_start() {
        // Line before cursor is empty — nothing to strip
        let context = "fn foo() {\n";
        let inputs = input(context, context.len());
        let result = strip_typed_prefix_from_completion("    let x = 1;", &inputs);
        assert_eq!(result, "    let x = 1;");
    }

    #[test]
    fn does_not_strip_prefix_when_completion_does_not_match() {
        // Completion doesn't start with the typed text — return unchanged
        let context = "const foo = bar.";
        let inputs = input(context, context.len());
        let result = strip_typed_prefix_from_completion("baz;", &inputs);
        assert_eq!(result, "baz;");
    }

    #[test]
    fn prefix_strip_is_case_sensitive() {
        let context = "const value = myObj.";
        let inputs = input(context, context.len());
        // Exact case match — strip succeeds
        let result = strip_typed_prefix_from_completion("const value = myObj.prop;", &inputs);
        assert_eq!(result, "prop;");
        // Different case — no strip
        let result2 = strip_typed_prefix_from_completion("const Value = myObj.prop;", &inputs);
        assert_eq!(result2, "const Value = myObj.prop;");
    }

    #[test]
    fn rejects_stripped_completion_that_becomes_empty() {
        // Model echoes back exactly what was typed — nothing useful remains after strip
        let context = "const x = myObj.";
        let inputs = input(context, context.len());
        let stripped = strip_typed_prefix_from_completion("const x = myObj.", &inputs);
        assert_eq!(stripped, "");
        assert!(filtered_function_completion_chunks(&stripped, &inputs, None).is_none());
    }

    #[test]
    fn rejects_midline_completion_exceeding_four_lines() {
        // Cursor is mid-line → max_lines = 4; five-line completion must be rejected
        let context = "const x = ";
        let inputs = input(context, context.len());
        let completion = "foo()\n    .bar()\n    .baz()\n    .qux()\n    .quux()";
        assert!(filtered_function_completion_chunks(completion, &inputs, None).is_none());
    }

    #[test]
    fn accepts_midline_completion_within_four_lines() {
        // Cursor is mid-line → max_lines = 4; exactly four lines must be accepted
        let context = "const x = ";
        let inputs = input(context, context.len());
        let completion = "foo()\n    .bar()\n    .baz()\n    .qux()";
        assert!(filtered_function_completion_chunks(completion, &inputs, None).is_some());
    }

    #[test]
    fn accepts_block_level_completion_up_to_fifteen_lines() {
        // Cursor at start of empty excerpt → block-level → max_lines = 15
        let top_level = input("", 0);
        let completion = "fn a() { a(); }\nfn b() { b(); }\nfn c() { c(); }\nfn d() { d(); }\n\
            fn e() { e(); }\nfn f() { f(); }\nfn g() { g(); }\nfn h() { h(); }\n\
            fn i() { i(); }\nfn j() { j(); }\nfn k() { k(); }\nfn l() { l(); }\n\
            fn m() { m(); }\nfn n() { n(); }\nfn o() { o(); }";
        assert_eq!(completion.lines().count(), 15);
        assert!(filtered_function_completion_chunks(completion, &top_level, None).is_some());
    }

    #[test]
    fn rejects_block_level_completion_exceeding_fifteen_lines() {
        // Same as above but one extra line — must be rejected
        let top_level = input("", 0);
        let completion = "fn a() { a(); }\nfn b() { b(); }\nfn c() { c(); }\nfn d() { d(); }\n\
            fn e() { e(); }\nfn f() { f(); }\nfn g() { g(); }\nfn h() { h(); }\n\
            fn i() { i(); }\nfn j() { j(); }\nfn k() { k(); }\nfn l() { l(); }\n\
            fn m() { m(); }\nfn n() { n(); }\nfn o() { o(); }\nfn p() { p(); }";
        assert_eq!(completion.lines().count(), 16);
        assert!(filtered_function_completion_chunks(completion, &top_level, None).is_none());
    }

    #[test]
    fn accepts_block_level_after_comment_line() {
        // Cursor on the empty line immediately below a comment — must be treated as block-level
        // (max 15 lines), not midline. The bug: .lines().last() returned the comment text,
        // making is_midline=true and capping at 4 lines.
        let context = "    // fetch user data\n    ";
        let inputs = input(context, context.len());
        let completion = "let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\nlet e = 5;";
        assert!(filtered_function_completion_chunks(completion, &inputs, None).is_some());
    }

    #[test]
    fn does_not_strip_prefix_when_cursor_is_below_comment() {
        // Cursor on empty line after a comment — nothing typed, so nothing should be stripped
        let context = "// some comment\n";
        let inputs = input(context, context.len());
        let result = strip_typed_prefix_from_completion("let x = 1;", &inputs);
        assert_eq!(result, "let x = 1;");
    }

    // ── Syntax validation tests ───────────────────────────────────────────────

    #[test]
    fn rejects_python_c_style_braces() {
        let context = "def foo():\n    ";
        let inputs = input_with_lang(context, context.len(), "test.py");
        // C-style block opener is invalid Python syntax
        assert!(
            filtered_function_completion_chunks("if x {\n    return 1\n}", &inputs, Some("Python"))
                .is_none()
        );
    }

    #[test]
    fn rejects_python_unindented_completion_after_colon() {
        // Cursor on new line after ':', current auto-indent is 0, completion also at col 0
        let context = "def foo():\n";
        let inputs = input_with_lang(context, context.len(), "test.py");
        // 'pass' at column 0 with prev_indent 0 → effective_indent 0 <= prev_indent 0 → reject
        assert!(filtered_function_completion_chunks("pass", &inputs, Some("Python")).is_none());
    }

    #[test]
    fn accepts_python_indented_completion_after_colon() {
        // Cursor on new line after ':', auto-indent = 4 spaces
        let context = "def foo():\n    ";
        let inputs = input_with_lang(context, context.len(), "test.py");
        // effective_indent = 4 (current) + 0 (completion) = 4 > prev_indent 0 → accept
        assert!(
            filtered_function_completion_chunks("return 42", &inputs, Some("Python")).is_some()
        );
    }

    #[test]
    fn rejects_python_top_level_decl_inside_block() {
        // Cursor is inside an indented block; completion jumps to column 0 with a def
        let context = "def foo():\n    ";
        let inputs = input_with_lang(context, context.len(), "test.py");
        let completion = "\ndef bar():\n    pass";
        assert!(filtered_function_completion_chunks(completion, &inputs, Some("Python")).is_none());
    }

    #[test]
    fn rejects_midline_import_statement() {
        let context = "const result = ";
        let inputs = input_with_lang(context, context.len(), "test.ts");
        assert!(
            filtered_function_completion_chunks(
                "import { foo } from './foo';",
                &inputs,
                Some("TypeScript")
            )
            .is_none()
        );
    }

    #[test]
    fn rejects_midline_named_function_declaration() {
        let context = "const handler = ";
        let inputs = input_with_lang(context, context.len(), "test.ts");
        assert!(
            filtered_function_completion_chunks(
                "function processData() { return data; }",
                &inputs,
                Some("TypeScript")
            )
            .is_none()
        );
    }

    #[test]
    fn rejects_midline_class_declaration() {
        let context = "const obj = ";
        let inputs = input_with_lang(context, context.len(), "test.ts");
        assert!(
            filtered_function_completion_chunks(
                "class MyClass { constructor() {} }",
                &inputs,
                Some("TypeScript")
            )
            .is_none()
        );
    }

    #[test]
    fn rejects_duplicate_close_paren() {
        // code_after starts with ')'; completion ends with ')' and has more closes than opens
        let inputs = input_with_lang("foo()", 4, "test.ts");
        // completion "x)" has 0 opens, 1 close; after starts with ')' → duplicate
        assert!(filtered_function_completion_chunks("x)", &inputs, Some("TypeScript")).is_none());
    }

    #[test]
    fn accepts_balanced_completion_before_close_paren() {
        // Completion is internally balanced even though code_after starts with ')'
        let inputs = input_with_lang("foo()", 4, "test.ts");
        // "bar(x)" has 1 open, 1 close → closes == opens → not a duplicate
        assert!(
            filtered_function_completion_chunks("bar(x)", &inputs, Some("TypeScript")).is_some()
        );
    }

    #[test]
    fn rejects_ts_import_outside_import_section() {
        // code_before contains non-import code, so completing an import here is wrong
        let code_before = "import React from 'react';\nconst x = 1;\n";
        let inputs = input_with_lang(code_before, code_before.len(), "test.ts");
        assert!(
            filtered_function_completion_chunks(
                "import { useState } from 'react';",
                &inputs,
                Some("TypeScript")
            )
            .is_none()
        );
    }

    #[test]
    fn accepts_ts_import_at_file_top() {
        // code_before contains only import lines — completing another import is valid
        let code_before = "import React from 'react';\n";
        let inputs = input_with_lang(code_before, code_before.len(), "test.ts");
        assert!(
            filtered_function_completion_chunks(
                "import { useState } from 'react';",
                &inputs,
                Some("TypeScript")
            )
            .is_some()
        );
    }

    // ── Stateless autocomplete HTTP tests ────────────────────────────────────

    #[derive(Default)]
    struct BackboardCallLog {
        assistants_created: usize,
        threads_created: usize,
        messages_sent: usize,
        thread_ids_used: Vec<String>,
        last_message_body: String,
    }

    fn make_backboard_fake_http_client(
        completion_text: &'static str,
    ) -> (Arc<dyn HttpClient>, Arc<Mutex<BackboardCallLog>>) {
        let log = Arc::new(Mutex::new(BackboardCallLog::default()));
        let log_for_client = log.clone();
        let client = gpui::http_client::FakeHttpClient::create(move |req| {
            let log = log_for_client.clone();
            let method = req.method().clone();
            let path = req.uri().path().to_string();
            let mut body_stream = req.into_body();
            async move {
                use futures::AsyncReadExt as _;
                let mut body_bytes = Vec::new();
                body_stream.read_to_end(&mut body_bytes).await.ok();
                let body_str = String::from_utf8_lossy(&body_bytes).to_string();

                if method == Method::POST && path.ends_with("/assistants") {
                    log.lock().unwrap().assistants_created += 1;
                    Ok(http_client::Response::builder()
                        .status(200)
                        .body(r#"{"assistant_id":"test-assistant"}"#.into())
                        .unwrap())
                } else if method == Method::POST && path.ends_with("/threads") {
                    let thread_num = {
                        let mut l = log.lock().unwrap();
                        l.threads_created += 1;
                        l.threads_created
                    };
                    let tid = format!("thread-{thread_num}");
                    Ok(http_client::Response::builder()
                        .status(200)
                        .body(format!(r#"{{"thread_id":"{tid}"}}"#).into())
                        .unwrap())
                } else if method == Method::POST && path.ends_with("/messages") {
                    let thread_id = path
                        .strip_prefix("/threads/")
                        .and_then(|s| s.strip_suffix("/messages"))
                        .unwrap_or("unknown")
                        .to_string();
                    {
                        let mut l = log.lock().unwrap();
                        l.messages_sent += 1;
                        l.thread_ids_used.push(thread_id);
                        l.last_message_body = body_str;
                    }
                    let sse = format!(
                        "data: {{\"type\":\"run_ended\",\"content\":\"{completion_text}\"}}\n\n"
                    );
                    Ok(http_client::Response::builder()
                        .status(200)
                        .body(sse.into())
                        .unwrap())
                } else {
                    Ok(http_client::Response::builder()
                        .status(404)
                        .body("Not Found".into())
                        .unwrap())
                }
            }
        });
        (client, log)
    }

    fn test_model() -> BackboardModel {
        BackboardModel {
            provider: "anthropic".to_string(),
            name: "claude-haiku-4-5-20251001".to_string(),
            ..Default::default()
        }
    }

    #[gpui::test]
    async fn test_backboard_creates_fresh_thread_per_request(cx: &mut gpui::TestAppContext) {
        let (http_client, log) = make_backboard_fake_http_client("return x;");
        let model = test_model();

        cx.background_executor
            .spawn(async move {
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
            })
            .await;

        let log = log.lock().unwrap();
        assert_eq!(
            log.threads_created, 2,
            "each request must create its own thread"
        );
        assert_eq!(log.messages_sent, 2);
        assert_ne!(
            log.thread_ids_used[0], log.thread_ids_used[1],
            "second request must not reuse the first thread_id"
        );
    }

    #[gpui::test]
    async fn test_backboard_reuses_assistant_across_requests(cx: &mut gpui::TestAppContext) {
        let (http_client, log) = make_backboard_fake_http_client("return x;");
        let model = test_model();

        cx.background_executor
            .spawn(async move {
                // First call — no cached assistant, creates one
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
                // Second call — pass the cached assistant_id so it is reused
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    Some("test-assistant"),
                    &http_client,
                )
                .await
                .unwrap();
            })
            .await;

        let log = log.lock().unwrap();
        assert_eq!(
            log.assistants_created, 1,
            "assistant must be created only once"
        );
        assert_eq!(log.threads_created, 2);
    }

    #[gpui::test]
    async fn test_backboard_request_has_memory_off(cx: &mut gpui::TestAppContext) {
        let (http_client, log) = make_backboard_fake_http_client("return x;");
        let model = test_model();

        cx.background_executor
            .spawn(async move {
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
            })
            .await;

        let body = log.lock().unwrap().last_message_body.clone();
        assert!(
            body.contains("memory=off"),
            "request body must contain memory=off, got: {body}"
        );
    }

    #[gpui::test]
    async fn test_backboard_request_has_web_search_off(cx: &mut gpui::TestAppContext) {
        let (http_client, log) = make_backboard_fake_http_client("return x;");
        let model = test_model();

        cx.background_executor
            .spawn(async move {
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
            })
            .await;

        let body = log.lock().unwrap().last_message_body.clone();
        assert!(
            body.contains("web_search=off"),
            "request body must contain web_search=off, got: {body}"
        );
    }

    #[gpui::test]
    async fn test_backboard_thread_id_not_cached_after_request(cx: &mut gpui::TestAppContext) {
        let (http_client, log) = make_backboard_fake_http_client("return x;");
        let model = test_model();
        let model2 = model.clone();

        cx.background_executor
            .spawn(async move {
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model,
                    "prompt",
                    None,
                    &http_client,
                )
                .await
                .unwrap();
            })
            .await;

        // The BACKBOARD_THREAD_CACHE no longer exists — thread_id is ephemeral.
        // Verify by checking threads_created: a second call with no cached thread must
        // create another thread rather than finding one in the (removed) cache.
        let (http_client2, log2) = make_backboard_fake_http_client("return x;");
        cx.background_executor
            .spawn(async move {
                backboard_completion(
                    "test-key",
                    "http://fake",
                    &model2,
                    "prompt",
                    Some("test-assistant"),
                    &http_client2,
                )
                .await
                .unwrap();
            })
            .await;

        drop(log.lock().unwrap());
        assert_eq!(
            log2.lock().unwrap().threads_created,
            1,
            "second isolated call must create its own thread — no cross-call thread cache"
        );
    }
}
