use crate::{
    DebugEvent, EditPredictionFinishedDebugEvent, EditPredictionId, EditPredictionModelInput,
    EditPredictionStartedDebugEvent, EditPredictionStore,
    prediction::EditPredictionResult,
};
use anyhow::{Context as _, Result};
use credentials_provider::CredentialsProvider;
use futures::AsyncReadExt as _;
use gpui::{
    App, AppContext as _, Context, Entity, Global, SharedString, Task,
    http_client::{self, AsyncBody, HttpClient, Method, StatusCode},
};
use language::{ToOffset, ToPoint as _};
use language_model::{ApiKeyState, EnvVar, env_var};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use zeta_prompt::ZetaPromptInput;

const BACKBOARD_API_BASE: &str = "https://app.backboard.io/api";


pub const BACKBOARD_CREDENTIALS_URL: SharedString =
    SharedString::new_static("https://app.backboard.io/api");

pub static BACKBOARD_TOKEN_ENV_VAR: std::sync::LazyLock<EnvVar> = env_var!("BACKBOARD_API_KEY");


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
        key_state.load_if_needed(
            BACKBOARD_CREDENTIALS_URL,
            |s| s,
            credentials_provider,
            cx,
        )
    })
}

pub struct BackboardCompletions {
    pub api_token: Entity<ApiKeyState>,
    /// Cached (api_key → assistant_id) so we create one assistant per key per session.
    cached_assistant: Option<(Arc<str>, String)>,
    pub completions_used: u32,
}

impl BackboardCompletions {
    pub fn new(cx: &mut App) -> Self {
        Self {
            api_token: backboard_api_token(cx),
            cached_assistant: None,
            completions_used: 0,
        }
    }

    pub fn has_personal_key(&self, cx: &App) -> bool {
        self.api_token.read(cx).has_key()
    }

    pub fn resolve_api_key(&self, cx: &App) -> Option<Arc<str>> {
        self.api_token.read(cx).key(&BACKBOARD_CREDENTIALS_URL)
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

        let Some(api_key) = self.resolve_api_key(cx) else {
            return Task::ready(Ok(None));
        };
        let api_key_for_cache = api_key.clone();

        let full_path: Arc<Path> = snapshot
            .file()
            .map(|file| file.full_path(cx))
            .unwrap_or_else(|| "untitled".into())
            .into();

        let settings = language::language_settings::all_language_settings(None, cx);
        let backboard_settings = settings.edit_predictions.backboard.clone();
        let model_name = backboard_settings.model.clone();
        let llm_provider = backboard_settings.provider.clone();

        let http_client = cx.http_client();
        let cursor_point = position.to_point(&snapshot);
        let request_start = cx.background_executor().now();
        let active_buffer = buffer.clone();

        let cached_assistant = self.cached_assistant.clone();

        let result = cx.background_spawn(async move {
            let cursor_offset = cursor_point.to_offset(&snapshot);
            let (excerpt_point_range, _excerpt_offset_range, cursor_offset_in_excerpt) =
                crate::cursor_excerpt::compute_cursor_excerpt(&snapshot, cursor_offset);

            let related_files = zeta_prompt::filter_redundant_excerpts(
                related_files,
                full_path.as_ref(),
                excerpt_point_range.start.row..excerpt_point_range.end.row,
            );

            let cursor_excerpt: Arc<str> = snapshot
                .text_for_range(excerpt_point_range.clone())
                .collect::<String>()
                .into();

            let inputs = ZetaPromptInput {
                events,
                related_files: Some(related_files),
                cursor_offset_in_excerpt,
                cursor_path: full_path.clone(),
                cursor_excerpt,
                excerpt_start_row: Some(excerpt_point_range.start.row),
                excerpt_ranges: Default::default(),
                syntax_ranges: None,
                active_buffer_diagnostics: vec![],
                in_open_source_repo: false,
                can_collect_data: false,
                repo_url: None,
            };

            let prompt = build_prompt(&inputs);

            if let Some(debug_tx) = &debug_tx {
                debug_tx
                    .unbounded_send(DebugEvent::EditPredictionStarted(
                        EditPredictionStartedDebugEvent {
                            buffer: active_buffer.downgrade(),
                            prompt: Some(prompt.clone()),
                            position,
                        },
                    ))
                    .ok();
            }

            let assistant_id = ensure_assistant_id(
                &api_key,
                cached_assistant.as_ref(),
                http_client.as_ref(),
            )
            .await
            .context("Failed to get Backboard assistant ID")?;

            let thread_id = create_thread(&api_key, &assistant_id, http_client.as_ref())
                .await
                .context("Failed to create Backboard thread")?;

            let response_text = send_message(
                &api_key,
                &thread_id,
                &prompt,
                &llm_provider,
                &model_name,
                http_client.as_ref(),
            )
            .await
            .context("Failed to send Backboard message")?;

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

            // Strip any code fences the model may have added.
            let response_str = response_text
                .trim_start_matches("```python\n")
                .trim_start_matches("```\n")
                .trim_end_matches("\n```")
                .trim_end_matches("```");

            // Pure insertion at cursor — never deletes any existing text.
            let cursor_anchor = snapshot.anchor_after(cursor_offset);
            let edits: Vec<(std::ops::Range<language::Anchor>, Arc<str>)> =
                if response_str.is_empty() || response_str == "None" {
                    vec![]
                } else {
                    vec![(cursor_anchor.clone()..cursor_anchor, Arc::from(response_str))]
                };

            anyhow::Ok((assistant_id, thread_id, edits, snapshot, inputs))
        });

        cx.spawn(async move |ep_store, cx| {
            let result = result.await.context("Backboard edit prediction failed");

            let _is_quota_exceeded = result
                .as_ref()
                .err()
                .is_some_and(is_quota_exceeded_error);

            ep_store.update(cx, |store, cx| {
                if let Ok((ref assistant_id, _, _, _, _)) = result {
                    let cached = (api_key_for_cache.clone(), assistant_id.clone());
                    store.backboard.cached_assistant = Some(cached);
                }
                cx.notify();
            })?;

            let (_, _, edits, old_snapshot, inputs) = result?;
            anyhow::Ok(Some(
                EditPredictionResult::new(
                    EditPredictionId(uuid::Uuid::new_v4().to_string().into()),
                    &buffer,
                    &old_snapshot,
                    edits.into(),
                    None,
                    inputs,
                    None,
                    cx.background_executor().now() - request_start,
                    cx,
                )
                .await,
            ))
        })
    }
}

#[derive(Serialize)]
struct CreateAssistantRequest {
    name: String,
}

#[derive(Deserialize)]
struct CreateAssistantResponse {
    assistant_id: String,
}

#[derive(Deserialize)]
struct CreateThreadResponse {
    thread_id: String,
}

#[derive(Serialize)]
struct SendMessageRequest {
    content: String,
    llm_provider: String,
    model_name: String,
    stream: bool,
    memory: String,
}

#[derive(Deserialize)]
struct MessageResponse {
    content: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("Backboard free tier quota exceeded")]
struct BackboardQuotaExceededError;

fn is_quota_exceeded_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<BackboardQuotaExceededError>()
        .is_some()
}

async fn ensure_assistant_id(
    api_key: &str,
    cached: Option<&(Arc<str>, String)>,
    http_client: &dyn HttpClient,
) -> Result<String> {
    if let Some((cached_key, cached_id)) = cached {
        if cached_key.as_ref() == api_key {
            return Ok(cached_id.clone());
        }
    }

    let body = CreateAssistantRequest {
        name: "Backboard IDE Completions".into(),
    };
    let request = http_client::Request::builder()
        .method(Method::POST)
        .uri(format!("{BACKBOARD_API_BASE}/assistants"))
        .header("Content-Type", "application/json")
        .header("X-API-Key", api_key)
        .body(AsyncBody::from(serde_json::to_vec(&body)?))?;

    let mut response = http_client.send(request).await?;
    let mut body_bytes = Vec::new();
    response.body_mut().read_to_end(&mut body_bytes).await?;

    if response.status() == StatusCode::PAYMENT_REQUIRED {
        anyhow::bail!(BackboardQuotaExceededError);
    }
    if !response.status().is_success() {
        anyhow::bail!(
            "Backboard /assistants returned {}: {}",
            response.status(),
            String::from_utf8_lossy(&body_bytes)
        );
    }

    let parsed: CreateAssistantResponse =
        serde_json::from_slice(&body_bytes).context("Failed to parse assistant response")?;
    Ok(parsed.assistant_id)
}

async fn create_thread(
    api_key: &str,
    assistant_id: &str,
    http_client: &dyn HttpClient,
) -> Result<String> {
    let request = http_client::Request::builder()
        .method(Method::POST)
        .uri(format!(
            "{BACKBOARD_API_BASE}/assistants/{assistant_id}/threads"
        ))
        .header("Content-Type", "application/json")
        .header("X-API-Key", api_key)
        .body(AsyncBody::from(&b"{}"[..]))?;

    let mut response = http_client.send(request).await?;
    let mut body_bytes = Vec::new();
    response.body_mut().read_to_end(&mut body_bytes).await?;

    if response.status() == StatusCode::PAYMENT_REQUIRED {
        anyhow::bail!(BackboardQuotaExceededError);
    }
    if !response.status().is_success() {
        anyhow::bail!(
            "Backboard /threads returned {}: {}",
            response.status(),
            String::from_utf8_lossy(&body_bytes)
        );
    }

    let parsed: CreateThreadResponse =
        serde_json::from_slice(&body_bytes).context("Failed to parse thread response")?;
    Ok(parsed.thread_id)
}

async fn send_message(
    api_key: &str,
    thread_id: &str,
    prompt: &str,
    llm_provider: &str,
    model_name: &str,
    http_client: &dyn HttpClient,
) -> Result<String> {
    let body = SendMessageRequest {
        content: prompt.to_string(),
        llm_provider: llm_provider.to_string(),
        model_name: model_name.to_string(),
        stream: false,
        memory: "off".into(),
    };

    let request = http_client::Request::builder()
        .method(Method::POST)
        .uri(format!("{BACKBOARD_API_BASE}/threads/{thread_id}/messages"))
        .header("Content-Type", "application/json")
        .header("X-API-Key", api_key)
        .body(AsyncBody::from(serde_json::to_vec(&body)?))?;

    let mut response = http_client.send(request).await?;
    let mut body_bytes = Vec::new();
    response.body_mut().read_to_end(&mut body_bytes).await?;

    if response.status() == StatusCode::PAYMENT_REQUIRED {
        anyhow::bail!(BackboardQuotaExceededError);
    }
    if !response.status().is_success() {
        anyhow::bail!(
            "Backboard /messages returned {}: {}",
            response.status(),
            String::from_utf8_lossy(&body_bytes)
        );
    }

    let parsed: MessageResponse =
        serde_json::from_slice(&body_bytes).context("Failed to parse message response")?;
    Ok(parsed.content.unwrap_or_default())
}

fn build_prompt(inputs: &ZetaPromptInput) -> String {
    let code_before = &inputs.cursor_excerpt[..inputs.cursor_offset_in_excerpt];
    let code_after = &inputs.cursor_excerpt[inputs.cursor_offset_in_excerpt..];
    let file_path = inputs.cursor_path.to_string_lossy();

    let mut prompt = format!(
        "You are a code completion engine. \
         Complete the code at the cursor position marked with <CURSOR>. \
         Output ONLY the text to insert at <CURSOR>. \
         Do not repeat any code that already exists. \
         Do not include markdown code fences. \
         Do not explain anything.\n\n\
         File: {file_path}\n\n\
         {code_before}<CURSOR>{code_after}"
    );

    // Add recent edit context if available.
    if !inputs.events.is_empty() {
        prompt.push_str("\n\nRecent edits (for context only):\n");
        for event in inputs.events.iter().take(5) {
            zeta_prompt::write_event(&mut prompt, event);
        }
    }

    prompt
}
