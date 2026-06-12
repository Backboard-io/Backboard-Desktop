use std::{
    collections::{HashMap, HashSet},
    io::{self, Write as _},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use anyhow::{Context as _, Result, anyhow};
use backboard::{
    BackboardClient, BackboardConfig, BackboardModel, SendMessageRequest, SubmitToolOutputsRequest,
};
use futures::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use uuid::Uuid;

const BRIDGE_PROTOCOL_VERSION: u32 = 1;
const DEFAULT_PROVIDER: &str = "aws-bedrock";
const DEFAULT_MODEL: &str = "anthropic.claude-sonnet-4-6";
const DEFAULT_INTENSITY: &str = "fast";
const DEFAULT_IMAGE_PROVIDER: &str = "openrouter";
const DEFAULT_IMAGE_MODEL: &str = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TTS_PROVIDER: &str = "openai";
const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE: &str = "alloy";
const DEFAULT_TTS_FORMAT: &str = "mp3";
const DEFAULT_STT_PROVIDER: &str = "openai";
const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
const DEFAULT_STT_LANGUAGE: &str = "en";

#[derive(Clone)]
struct BridgeState {
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    writer: EventWriter,
}

#[derive(Clone)]
struct EventWriter {
    stdout: Arc<Mutex<io::Stdout>>,
}

#[derive(Clone)]
struct SessionState {
    thread_id: Option<String>,
    assistant_id: Option<String>,
    current_run_id: Option<String>,
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: String,
    command: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigParams {
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    api_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendPromptParams {
    content: String,
    #[serde(default)]
    workspace: Option<PathBuf>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    intensity: Option<String>,
    #[serde(default)]
    web_search: Option<String>,
    #[serde(default)]
    image_generation: Option<String>,
    #[serde(default)]
    voice_mode: Option<String>,
    #[serde(default)]
    mcp_calls: Option<Value>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    assistant_id: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    config: Option<ConfigParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitToolResultParams {
    thread_id: Option<String>,
    run_id: Option<String>,
    tool_outputs: Vec<Value>,
    #[serde(default)]
    tools: Option<Vec<Value>>,
    #[serde(default)]
    config: Option<ConfigParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunToolParams {
    name: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeModel {
    provider: String,
    name: String,
    model_type: Option<String>,
    display_name: Option<String>,
    context_limit: Option<u64>,
    supports_thinking: Option<bool>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let state = BridgeState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        writer: EventWriter {
            stdout: Arc::new(Mutex::new(io::stdout())),
        },
    };
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<BridgeRequest>(trimmed) {
            Ok(request) => request,
            Err(error) => {
                state.writer.emit(json!({
                    "type": "error",
                    "bridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "requestId": Value::Null,
                    "sessionId": Value::Null,
                    "message": format!("invalid bridge request: {error}")
                }));
                continue;
            }
        };
        handle_request(state.clone(), request).await;
    }

    Ok(())
}

async fn handle_request(state: BridgeState, request: BridgeRequest) {
    match request.command.as_str() {
        "initialize" => {
            state.writer.emit(base_event(
                "initialized",
                &request.request_id,
                request.session_id.as_deref(),
                json!({ "bridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION }),
            ));
        }
        "listModels" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = list_models(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "listTools" => list_tools(&state, &request),
        "runTool" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = run_tool(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "sendPrompt" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = send_prompt(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "submitToolResult" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = submit_tool_result(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "cancel" => cancel_request(&state, &request),
        "getSession" => get_session(&state, &request),
        "disposeSession" => dispose_session(&state, &request),
        command => {
            emit_error(
                &state.writer,
                &anyhow!("unknown bridge command `{command}`"),
                Some(&request.request_id),
                request.session_id.as_deref(),
            );
        }
    }
}

async fn list_models(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let config = serde_json::from_value::<ConfigParams>(
        request.params.get("config").cloned().unwrap_or_default(),
    )
    .unwrap_or(ConfigParams {
        env: None,
        api_url: None,
        api_key: None,
    });
    let provider = request
        .params
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let client = client_from_params(Some(&config))?;
    let models = collect_models(&client, provider.as_deref()).await?;
    state.writer.emit(base_event(
        "models",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "models": models }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
    Ok(())
}

async fn collect_models(
    client: &BackboardClient,
    provider: Option<&str>,
) -> Result<Vec<BridgeModel>> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();

    if let Some(provider) = provider {
        if !is_featherless_provider(provider) {
            add_visible_models(
                &mut models,
                &mut seen,
                client.list_models_by_provider(provider, None).await?,
            );
        }
        return Ok(models);
    }

    add_visible_models(
        &mut models,
        &mut seen,
        client.list_models(None, None, None).await?,
    );
    for provider in client.list_providers().await.unwrap_or_default() {
        if is_featherless_provider(&provider) {
            continue;
        }
        add_visible_models(
            &mut models,
            &mut seen,
            client.list_models_by_provider(&provider, None).await?,
        );
    }

    Ok(models)
}

fn add_visible_models(
    models: &mut Vec<BridgeModel>,
    seen: &mut HashSet<(String, String)>,
    items: Vec<BackboardModel>,
) {
    for model in items.into_iter().filter(model_is_visible) {
        let key = model_key(&model);
        if seen.insert(key) {
            models.push(to_bridge_model(model));
        }
    }
}

fn model_is_visible(model: &BackboardModel) -> bool {
    !model.name.trim().is_empty() && !is_featherless_provider(&model.provider)
}

fn is_featherless_provider(provider: &str) -> bool {
    normalized_provider_key(provider) == "featherless"
}

fn normalized_provider_key(provider: &str) -> String {
    provider.trim().to_lowercase().replace('_', "-")
}

fn model_key(model: &BackboardModel) -> (String, String) {
    (
        normalized_provider_key(&model.provider),
        model.name.trim().to_lowercase(),
    )
}

fn list_tools(state: &BridgeState, request: &BridgeRequest) {
    let mode = request
        .params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    state.writer.emit(base_event(
        "tools",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "tools": tool_definitions(mode) }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
}

async fn run_tool(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let params: RunToolParams = serde_json::from_value(request.params.clone())?;
    let name = params.name.clone();
    state.writer.emit(base_event(
        "toolFinished",
        &request.request_id,
        request.session_id.as_deref(),
        json!({
            "status": "started",
            "name": name,
        }),
    ));
    let output = execute_rust_tool(&params.name, &params.args).await?;
    state.writer.emit(base_event(
        "toolFinished",
        &request.request_id,
        request.session_id.as_deref(),
        json!({
            "status": "finished",
            "name": params.name,
            "output": output,
        }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
    Ok(())
}

async fn send_prompt(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let session_id = request
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let params: SendPromptParams = serde_json::from_value(request.params.clone())?;
    let provider = params
        .provider
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let model = params.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let mode = params.mode.unwrap_or_else(|| "free".to_string());
    let intensity = params
        .intensity
        .unwrap_or_else(|| DEFAULT_INTENSITY.to_string());
    let voice_mode = params.voice_mode.unwrap_or_else(|| "off".to_string());
    let cancel_flag = session_cancel_flag(&state, &session_id);
    cancel_flag.store(false, Ordering::SeqCst);

    let thread_id = params
        .thread_id
        .or_else(|| session_thread_id(&state, &session_id));
    let assistant_id = params
        .assistant_id
        .or_else(|| session_assistant_id(&state, &session_id));
    let client = client_from_params(params.config.as_ref())?;
    let content = augment_prompt(&params.content, params.workspace.as_ref(), &mode);
    state.writer.emit(base_event(
        "progress",
        &request.request_id,
        Some(&session_id),
        json!({ "message": "Sending to Backboard." }),
    ));

    let stream = client
        .send_message_stream(SendMessageRequest {
            thread_id,
            assistant_id,
            content,
            provider: Some(provider.clone()),
            model: Some(model.clone()),
            memory: "Auto".to_string(),
            thinking: thinking_payload(&intensity, &provider, &model),
            tools: Some(tool_definitions(&mode)),
            web_search: params.web_search.unwrap_or_else(|| "off".to_string()),
            image_generation: params.image_generation.clone(),
            image_model_provider: params
                .image_generation
                .as_deref()
                .filter(|value| *value == "auto")
                .map(|_| DEFAULT_IMAGE_PROVIDER.to_string()),
            image_model_name: params
                .image_generation
                .as_deref()
                .filter(|value| *value == "auto")
                .map(|_| DEFAULT_IMAGE_MODEL.to_string()),
            voice: voice_payload(&voice_mode),
            send_to_llm: send_to_llm_for_voice(&voice_mode),
            mcp_calls: params.mcp_calls,
            max_tokens: params.max_tokens,
            audio_file: None,
        })
        .await?;

    consume_stream(state, &request.request_id, &session_id, stream).await
}

async fn submit_tool_result(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let session_id = request
        .session_id
        .clone()
        .context("submitToolResult requires sessionId")?;
    let params: SubmitToolResultParams = serde_json::from_value(request.params.clone())?;
    let thread_id = params
        .thread_id
        .or_else(|| session_thread_id(&state, &session_id))
        .context("submitToolResult requires a threadId")?;
    let run_id = params
        .run_id
        .or_else(|| session_run_id(&state, &session_id))
        .context("submitToolResult requires a runId")?;
    let client = client_from_params(params.config.as_ref())?;
    let tool_outputs = params
        .tool_outputs
        .into_iter()
        .map(normalize_tool_output)
        .collect::<Vec<_>>();
    let stream = client
        .submit_tool_outputs_stream(
            &thread_id,
            &run_id,
            SubmitToolOutputsRequest {
                tool_outputs,
                tools: params.tools,
            },
        )
        .await?;
    consume_stream(state, &request.request_id, &session_id, stream).await
}

async fn consume_stream(
    state: BridgeState,
    request_id: &str,
    session_id: &str,
    mut stream: std::pin::Pin<Box<dyn futures::Stream<Item = Result<Value>> + Send>>,
) -> Result<()> {
    while let Some(chunk) = stream.next().await {
        if session_cancel_flag(&state, session_id).load(Ordering::SeqCst) {
            state.writer.emit(base_event(
                "done",
                request_id,
                Some(session_id),
                json!({ "stopReason": "cancelled" }),
            ));
            return Ok(());
        }
        let chunk = chunk?;
        record_binding(&state, session_id, &chunk);
        let chunk_type = chunk
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if let Some(tool_calls) = tool_calls_required_by_chunk(&chunk) {
            let run_id = run_id_from_chunk(&chunk).or_else(|| session_run_id(&state, session_id));
            if let Some(run_id) = run_id.as_deref() {
                set_session_run_id(&state, session_id, Some(run_id.to_string()));
            }
            state.writer.emit(base_event(
                "toolRequested",
                request_id,
                Some(session_id),
                json!({
                    "runId": run_id,
                    "threadId": session_thread_id(&state, session_id),
                    "toolCalls": tool_calls
                }),
            ));
            state.writer.emit(base_event(
                "done",
                request_id,
                Some(session_id),
                json!({ "stopReason": "requires_tool_result" }),
            ));
            return Ok(());
        }

        match chunk_type {
            "run_started" => {
                let run_id = run_id_from_chunk(&chunk);
                set_session_run_id(&state, session_id, run_id);
                state.writer.emit(base_event(
                    "progress",
                    request_id,
                    Some(session_id),
                    json!({ "message": "Connected to model." }),
                ));
            }
            "reasoning_started" => {
                state.writer.emit(base_event(
                    "progress",
                    request_id,
                    Some(session_id),
                    json!({ "message": "Planning next step." }),
                ));
            }
            "reasoning_streaming" | "reasoning_delta" => {
                if let Some(text) = chunk_text(&chunk) {
                    state.writer.emit(base_event(
                        "reasoningDelta",
                        request_id,
                        Some(session_id),
                        json!({ "text": text }),
                    ));
                }
            }
            "content_streaming" | "stt_text_delta" => {
                if let Some(text) = chunk_text(&chunk) {
                    state.writer.emit(base_event(
                        "assistantTextDelta",
                        request_id,
                        Some(session_id),
                        json!({ "text": text }),
                    ));
                }
            }
            "media_generated" => {
                state.writer.emit(base_event(
                    "media",
                    request_id,
                    Some(session_id),
                    json!({ "chunk": chunk }),
                ));
            }
            "tts_audio_delta" | "tts_stream_end" | "stt_stream_end" => {
                state.writer.emit(base_event(
                    "voice",
                    request_id,
                    Some(session_id),
                    json!({ "chunk": chunk }),
                ));
            }
            "run_ended" => {
                state.writer.emit(base_event(
                    "usage",
                    request_id,
                    Some(session_id),
                    json!({ "usage": usage_payload(&chunk) }),
                ));
                state.writer.emit(base_event(
                    "done",
                    request_id,
                    Some(session_id),
                    json!({ "stopReason": "end_turn" }),
                ));
                return Ok(());
            }
            "run_failed" | "error" => {
                let message = chunk
                    .get("message")
                    .or_else(|| chunk.get("error"))
                    .and_then(Value::as_str)
                    .unwrap_or("Backboard request failed.");
                state.writer.emit(base_event(
                    "error",
                    request_id,
                    Some(session_id),
                    json!({ "message": message, "chunk": chunk }),
                ));
                state.writer.emit(base_event(
                    "done",
                    request_id,
                    Some(session_id),
                    json!({ "stopReason": "error" }),
                ));
                return Ok(());
            }
            "retry" => {
                state.writer.emit(base_event(
                    "progress",
                    request_id,
                    Some(session_id),
                    json!({ "message": "Retrying Backboard request." }),
                ));
            }
            _ => {}
        }
    }

    state.writer.emit(base_event(
        "done",
        request_id,
        Some(session_id),
        json!({ "stopReason": "end_turn" }),
    ));
    Ok(())
}

fn cancel_request(state: &BridgeState, request: &BridgeRequest) {
    if let Some(session_id) = request.session_id.as_deref() {
        session_cancel_flag(state, session_id).store(true, Ordering::SeqCst);
        state.writer.emit(base_event(
            "done",
            &request.request_id,
            Some(session_id),
            json!({ "stopReason": "cancelled" }),
        ));
    }
}

fn get_session(state: &BridgeState, request: &BridgeRequest) {
    let session_id = request.session_id.as_deref();
    let session = session_id.and_then(|id| {
        state
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(id).cloned())
    });
    state.writer.emit(base_event(
        "session",
        &request.request_id,
        session_id,
        json!({
            "threadId": session.as_ref().and_then(|session| session.thread_id.clone()),
            "assistantId": session.as_ref().and_then(|session| session.assistant_id.clone()),
            "runId": session.as_ref().and_then(|session| session.current_run_id.clone())
        }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        session_id,
        json!({ "stopReason": "end_turn" }),
    ));
}

fn dispose_session(state: &BridgeState, request: &BridgeRequest) {
    if let Some(session_id) = request.session_id.as_deref()
        && let Ok(mut sessions) = state.sessions.lock()
    {
        sessions.remove(session_id);
    }
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
}

fn client_from_params(params: Option<&ConfigParams>) -> Result<BackboardClient> {
    let mut config = BackboardConfig::load_or_default();
    if let Some(params) = params {
        if let Some(env) = params
            .env
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            config.env = env.to_string();
        }
        if let Some(api_url) = params
            .api_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            config.api_url = Some(api_url.to_string());
        }
        if let Some(api_key) = params
            .api_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            config.api_key = Some(api_key.to_string());
        }
    }
    BackboardClient::from_config(config)
}

fn augment_prompt(content: &str, workspace: Option<&PathBuf>, mode: &str) -> String {
    let Some(workspace) = workspace else {
        return content.to_string();
    };
    format!(
        "Backboard is running inside VS Code.\nWorkspace: {}\nMode: {mode}\n\nUser request:\n{content}",
        workspace.display()
    )
}

fn thinking_payload(intensity: &str, provider: &str, model: &str) -> Option<Value> {
    if intensity == "fast" {
        return None;
    }
    let deep = intensity == "deep";
    let provider = provider.to_lowercase();
    let model = model.to_lowercase();
    if provider.contains("anthropic") || model.contains("claude") {
        if deep && model.contains("opus") {
            Some(json!({ "effort": "max" }))
        } else {
            Some(json!({ "budget_tokens": if deep { 16384 } else { 4096 } }))
        }
    } else if provider.contains("openai") || model.starts_with('o') || model.contains("gpt-5") {
        Some(json!({ "effort": if deep { "high" } else { "low" } }))
    } else if provider.contains("google") || model.contains("gemini") {
        if model.contains("3.") {
            Some(json!({ "effort": if deep { "high" } else { "low" } }))
        } else {
            Some(json!({ "budget_tokens": if deep { 8192 } else { 2048 } }))
        }
    } else if deep || model.contains("reasoning") {
        Some(json!({ "max_tokens": if deep { 4096 } else { 1024 } }))
    } else {
        None
    }
}

fn tool_definitions(mode: &str) -> Vec<Value> {
    let blocked = blocked_tools(mode);
    all_tool_definitions()
        .into_iter()
        .filter(|tool| {
            tool.pointer("/function/name")
                .and_then(Value::as_str)
                .is_none_or(|name| !blocked.contains(&name))
        })
        .collect()
}

fn blocked_tools(mode: &str) -> &'static [&'static str] {
    match mode {
        "ask" => &[
            "write",
            "write_file",
            "create_file",
            "overwrite_file",
            "edit",
            "edit_file",
            "search_replace",
            "delete_file",
            "create_directory",
            "bash",
            "run_terminal_cmd",
            "run_code",
            "repl",
            "computer",
            "task",
            "read_lints",
        ],
        "manual" => &[
            "bash",
            "run_terminal_cmd",
            "run_code",
            "repl",
            "computer",
            "task",
            "read_lints",
        ],
        _ => &[],
    }
}

fn all_tool_definitions() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"bash","description":"Execute a shell command. Do not use for file operations; use read_file, edit, write, grep, or glob instead.","parameters":{"type":"object","properties":{"command":{"type":"string"},"cmd":{"type":"string"},"description":{"type":"string"},"timeout":{"type":"integer"},"timeout_ms":{"type":"integer"},"working_directory":{"type":"string"},"cwd":{"type":"string"},"is_background":{"type":"boolean"}},"required":["command"]}}}),
        json!({"type":"function","function":{"name":"run_terminal_cmd","description":"Execute a shell command and render output in an IDE terminal.","parameters":{"type":"object","properties":{"command":{"type":"string"},"cmd":{"type":"string"},"description":{"type":"string"},"timeout":{"type":"integer"},"timeout_ms":{"type":"integer"},"working_directory":{"type":"string"},"cwd":{"type":"string"},"is_background":{"type":"boolean"}},"required":["command"]}}}),
        json!({"type":"function","function":{"name":"read_file","description":"Read a text file from the workspace. Supports offset and limit line ranges.","parameters":{"type":"object","properties":{"path":{"type":"string"},"target_file":{"type":"string"},"file_path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}}}}}),
        json!({"type":"function","function":{"name":"write","description":"Write a complete file in the workspace. Prefer edit for existing files.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"target_file":{"type":"string"},"content":{"type":"string"},"contents":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"write_file","description":"Write a complete file in the workspace. Alias for write.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"filePath":{"type":"string"},"target_file":{"type":"string"},"targetFile":{"type":"string"},"content":{"type":"string"},"contents":{"type":"string"},"new_text":{"type":"string"},"newText":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"create_file","description":"Create a file in the workspace, creating parent directories when the VS Code host supports it. Alias for write_file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"filePath":{"type":"string"},"target_file":{"type":"string"},"targetFile":{"type":"string"},"content":{"type":"string"},"contents":{"type":"string"},"new_text":{"type":"string"},"newText":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"overwrite_file","description":"Overwrite a complete file in the workspace. Alias for write_file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"filePath":{"type":"string"},"target_file":{"type":"string"},"targetFile":{"type":"string"},"content":{"type":"string"},"contents":{"type":"string"},"new_text":{"type":"string"},"newText":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"edit","description":"Perform exact string replacement in a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"target_file":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}}}}}),
        json!({"type":"function","function":{"name":"edit_file","description":"Perform exact string replacement in a file. Alias for edit.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"filePath":{"type":"string"},"target_file":{"type":"string"},"targetFile":{"type":"string"},"old_string":{"type":"string"},"oldString":{"type":"string"},"new_string":{"type":"string"},"newString":{"type":"string"},"replace_all":{"type":"boolean"},"replaceAll":{"type":"boolean"}}}}}),
        json!({"type":"function","function":{"name":"search_replace","description":"Search and replace text in a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"target_file":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}}}}}),
        json!({"type":"function","function":{"name":"glob","description":"Find workspace files by glob pattern.","parameters":{"type":"object","properties":{"pattern":{"type":"string"},"target_directory":{"type":"string"}},"required":["pattern"]}}}),
        json!({"type":"function","function":{"name":"grep","description":"Search workspace text files using regular expressions.","parameters":{"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"glob":{"type":"string"},"include":{"type":"string"},"output_mode":{"type":"string","enum":["content","files_with_matches","count"]},"case_insensitive":{"type":"boolean"},"context_lines":{"type":"integer"}},"required":["pattern"]}}}),
        json!({"type":"function","function":{"name":"codebase_search","description":"Search the workspace codebase semantically when available, with lexical fallback in VS Code.","parameters":{"type":"object","properties":{"query":{"type":"string"},"num_results":{"type":"integer"}},"required":["query"]}}}),
        json!({"type":"function","function":{"name":"list_dir","description":"List files in a workspace directory with file types.","parameters":{"type":"object","properties":{"path":{"type":"string"},"target_directory":{"type":"string"},"relative_workspace_path":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"delete_file","description":"Delete a workspace file or directory.","parameters":{"type":"object","properties":{"path":{"type":"string"},"file_path":{"type":"string"},"target_file":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"create_directory","description":"Create a workspace directory.","parameters":{"type":"object","properties":{"path":{"type":"string"},"target_directory":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"web_search","description":"Search the web for current information. Returns summarized results and URLs when available.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}),
        json!({"type":"function","function":{"name":"web_fetch","description":"Fetch URL content as readable text.","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}}),
        json!({"type":"function","function":{"name":"todo_write","description":"Update the agent todo list.","parameters":{"type":"object","properties":{"merge":{"type":"boolean"},"todos":{"type":"array","items":{"type":"object"}}}}}}),
        json!({"type":"function","function":{"name":"read_lints","description":"Read VS Code diagnostics for the workspace or run explicit check commands.","parameters":{"type":"object","properties":{"path":{"type":"string"},"paths":{"type":"array","items":{"type":"string"}},"command":{"type":"string"},"cmd":{"type":"string"},"commands":{"type":"array","items":{"type":"string"}},"working_directory":{"type":"string"},"cwd":{"type":"string"},"timeout":{"type":"integer"}}}}}),
        json!({"type":"function","function":{"name":"task","description":"Run a focused read/search sub-task with local workspace tools.","parameters":{"type":"object","properties":{"prompt":{"type":"string"},"description":{"type":"string"}}}}}),
        json!({"type":"function","function":{"name":"enter_plan_mode","description":"Enter read-only plan mode. Only use when the user explicitly requests planning.","parameters":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}}),
        json!({"type":"function","function":{"name":"exit_plan_mode","description":"Exit plan mode and present an implementation plan for user approval.","parameters":{"type":"object","properties":{"plan":{"type":"string"}},"required":["plan"]}}}),
        json!({"type":"function","function":{"name":"persistence_decide","description":"Persistence-gate decision tool.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["continue","done"]},"reason":{"type":"string"},"focus":{"type":"string"}},"required":["action","reason"]}}}),
        json!({"type":"function","function":{"name":"sleep","description":"Wait for a number of seconds.","parameters":{"type":"object","properties":{"seconds":{"type":"integer"}},"required":["seconds"]}}}),
        json!({"type":"function","function":{"name":"repl","description":"Persistent REPL compatibility tool. VS Code host executes this as a snippet.","parameters":{"type":"object","properties":{"code":{"type":"string"},"language":{"type":"string"},"reset":{"type":"boolean"}},"required":["code"]}}}),
        json!({"type":"function","function":{"name":"run_code","description":"Execute a one-off code snippet.","parameters":{"type":"object","properties":{"code":{"type":"string"},"language":{"type":"string","enum":["python","node","typescript","shell","ruby","go"]},"timeout":{"type":"integer"},"description":{"type":"string"}},"required":["code"]}}}),
        json!({"type":"function","function":{"name":"computer","description":"Desktop automation. This VS Code bridge reports it unsupported until desktop automation is ported.","parameters":{"type":"object","properties":{"action":{"type":"string"},"x":{"type":"integer"},"y":{"type":"integer"},"text":{"type":"string"},"key":{"type":"string"}},"required":["action"]}}}),
        json!({"type":"function","function":{"name":"ask_user_question","description":"Ask the user for required input.","parameters":{"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"allow_multiple":{"type":"boolean"}},"required":["question"]}}}),
    ]
}

fn voice_payload(voice_mode: &str) -> Option<Value> {
    match voice_mode {
        "tts" => Some(json!({
            "tts": {
                "provider": DEFAULT_TTS_PROVIDER,
                "model": DEFAULT_TTS_MODEL,
                "voice": DEFAULT_TTS_VOICE,
                "output_format": DEFAULT_TTS_FORMAT,
            }
        })),
        "stt" => Some(json!({
            "stt": {
                "provider": DEFAULT_STT_PROVIDER,
                "model": DEFAULT_STT_MODEL,
                "language": DEFAULT_STT_LANGUAGE,
            }
        })),
        "conversation" => Some(json!({
            "stt": {
                "provider": DEFAULT_STT_PROVIDER,
                "model": DEFAULT_STT_MODEL,
                "language": DEFAULT_STT_LANGUAGE,
            },
            "tts": {
                "provider": DEFAULT_TTS_PROVIDER,
                "model": DEFAULT_TTS_MODEL,
                "voice": DEFAULT_TTS_VOICE,
                "output_format": DEFAULT_TTS_FORMAT,
            }
        })),
        _ => None,
    }
}

fn send_to_llm_for_voice(voice_mode: &str) -> Option<bool> {
    match voice_mode {
        "stt" => Some(false),
        "tts" | "conversation" => Some(true),
        _ => None,
    }
}

async fn execute_rust_tool(name: &str, args: &Value) -> Result<Value> {
    match name {
        "web_search" => web_search(args).await,
        "web_fetch" => web_fetch(args).await,
        "computer" => Ok(json!({
            "success": false,
            "unsupported": true,
            "error": "The VS Code Backboard bridge does not support desktop automation yet."
        })),
        other => Ok(json!({
            "success": false,
            "unsupported": true,
            "error": format!("Tool `{other}` is executed by the VS Code host adapter, not the Rust network bridge.")
        })),
    }
}

async fn web_search(args: &Value) -> Result<Value> {
    let query = string_arg(args, &["query"]).context("web_search requires query")?;
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding::encode(&query)
    );
    let text = reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let data = serde_json::from_str::<Value>(&text)?;
    let mut results = Vec::new();
    if let Some(text) = data
        .get("AbstractText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        results.push(json!({
            "title": data.get("Heading").and_then(Value::as_str).unwrap_or("DuckDuckGo result"),
            "url": data.get("AbstractURL").and_then(Value::as_str).unwrap_or_default(),
            "snippet": text,
        }));
    }
    if let Some(topics) = data.get("RelatedTopics").and_then(Value::as_array) {
        for topic in topics {
            collect_duckduckgo_topic(topic, &mut results);
            if results.len() >= 8 {
                break;
            }
        }
    }
    Ok(json!({
        "success": true,
        "query": query,
        "results": results,
    }))
}

async fn web_fetch(args: &Value) -> Result<Value> {
    let url = string_arg(args, &["url"]).context("web_fetch requires url")?;
    let text = reqwest::Client::new()
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(json!({
        "success": true,
        "url": url,
        "content": readable_text(&text).chars().take(12_000).collect::<String>(),
    }))
}

fn collect_duckduckgo_topic(topic: &Value, results: &mut Vec<Value>) {
    if let Some(text) = topic.get("Text").and_then(Value::as_str) {
        results.push(json!({
            "title": text.split(" - ").next().unwrap_or(text),
            "url": topic.get("FirstURL").and_then(Value::as_str).unwrap_or_default(),
            "snippet": text,
        }));
    }
    if let Some(topics) = topic.get("Topics").and_then(Value::as_array) {
        for child in topics {
            collect_duckduckgo_topic(child, results);
            if results.len() >= 8 {
                break;
            }
        }
    }
}

fn readable_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(12_000));
    let mut in_tag = false;
    let mut last_space = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !last_space {
                    output.push(' ');
                    last_space = true;
                }
            }
            _ if in_tag => {}
            ch if ch.is_whitespace() => {
                if !last_space {
                    output.push(' ');
                    last_space = true;
                }
            }
            ch => {
                output.push(ch);
                last_space = false;
            }
        }
    }
    output
}

fn string_arg(args: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn to_bridge_model(model: BackboardModel) -> BridgeModel {
    BridgeModel {
        provider: model.provider,
        name: model.name,
        model_type: model.model_type,
        display_name: model.display_name,
        context_limit: model.context_limit,
        supports_thinking: model.supports_thinking,
    }
}

fn normalize_tool_output(value: Value) -> Value {
    let tool_call_id = value
        .get("tool_call_id")
        .or_else(|| value.get("toolCallId"))
        .cloned()
        .unwrap_or(Value::Null);
    let output = value.get("output").cloned().unwrap_or(Value::Null);
    let output = match output {
        Value::String(text) => Value::String(text),
        other => Value::String(other.to_string()),
    };
    json!({ "tool_call_id": tool_call_id, "output": output })
}

fn tool_calls_required_by_chunk(chunk: &Value) -> Option<Vec<Value>> {
    for pointer in [
        "/tool_calls",
        "/data/tool_calls",
        "/required_action/submit_tool_outputs/tool_calls",
        "/data/required_action/submit_tool_outputs/tool_calls",
        "/run/required_action/submit_tool_outputs/tool_calls",
    ] {
        if let Some(calls) = chunk.pointer(pointer).and_then(Value::as_array)
            && !calls.is_empty()
        {
            return Some(calls.to_vec());
        }
    }
    None
}

fn run_id_from_chunk(chunk: &Value) -> Option<String> {
    for pointer in [
        "/run_id",
        "/runId",
        "/id",
        "/run/id",
        "/data/run_id",
        "/data/runId",
    ] {
        if let Some(value) = chunk.pointer(pointer).and_then(Value::as_str)
            && !value.is_empty()
        {
            return Some(value.to_string());
        }
    }
    None
}

fn chunk_text(chunk: &Value) -> Option<String> {
    for key in ["content", "delta", "text", "transcript"] {
        if let Some(value) = chunk.get(key).and_then(Value::as_str)
            && !value.is_empty()
        {
            return Some(value.to_string());
        }
    }
    None
}

fn usage_payload(chunk: &Value) -> Value {
    json!({
        "inputTokens": chunk.get("input_tokens").or_else(|| chunk.get("prompt_tokens")).cloned(),
        "outputTokens": chunk.get("output_tokens").or_else(|| chunk.get("completion_tokens")).cloned(),
        "contextUsage": chunk.get("context_usage").cloned()
    })
}

fn record_binding(state: &BridgeState, session_id: &str, chunk: &Value) {
    let binding = backboard::message_thread_binding(chunk);
    if binding.thread_id.is_none() && binding.assistant_id.is_none() {
        return;
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        let session = sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionState::default);
        if binding.thread_id.is_some() {
            session.thread_id = binding.thread_id;
        }
        if binding.assistant_id.is_some() {
            session.assistant_id = binding.assistant_id;
        }
        state.writer.emit(base_event(
            "sessionBinding",
            "",
            Some(session_id),
            json!({
                "threadId": session.thread_id,
                "assistantId": session.assistant_id
            }),
        ));
    }
}

fn session_cancel_flag(state: &BridgeState, session_id: &str) -> Arc<AtomicBool> {
    state
        .sessions
        .lock()
        .expect("sessions lock")
        .entry(session_id.to_string())
        .or_insert_with(SessionState::default)
        .cancel_flag
        .clone()
}

fn session_thread_id(state: &BridgeState, session_id: &str) -> Option<String> {
    state.sessions.lock().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .and_then(|session| session.thread_id.clone())
    })
}

fn session_assistant_id(state: &BridgeState, session_id: &str) -> Option<String> {
    state.sessions.lock().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .and_then(|session| session.assistant_id.clone())
    })
}

fn session_run_id(state: &BridgeState, session_id: &str) -> Option<String> {
    state.sessions.lock().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .and_then(|session| session.current_run_id.clone())
    })
}

fn set_session_run_id(state: &BridgeState, session_id: &str, run_id: Option<String>) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionState::default)
            .current_run_id = run_id;
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            thread_id: None,
            assistant_id: None,
            current_run_id: None,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl EventWriter {
    fn emit(&self, event: Value) {
        let mut stdout = self.stdout.lock().expect("stdout lock");
        if serde_json::to_writer(&mut *stdout, &event).is_ok() {
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }
}

fn base_event(kind: &str, request_id: &str, session_id: Option<&str>, mut extra: Value) -> Value {
    let mut event = serde_json::Map::new();
    event.insert("type".to_string(), Value::String(kind.to_string()));
    event.insert(
        "bridgeProtocolVersion".to_string(),
        Value::Number(BRIDGE_PROTOCOL_VERSION.into()),
    );
    event.insert(
        "requestId".to_string(),
        Value::String(request_id.to_string()),
    );
    event.insert(
        "sessionId".to_string(),
        session_id
            .map(|id| Value::String(id.to_string()))
            .unwrap_or(Value::Null),
    );
    if let Value::Object(extra) = &mut extra {
        event.extend(std::mem::take(extra));
    }
    Value::Object(event)
}

fn emit_error(
    writer: &EventWriter,
    error: &anyhow::Error,
    request_id: Option<&str>,
    session_id: Option<&str>,
) {
    writer.emit(base_event(
        "error",
        request_id.unwrap_or_default(),
        session_id,
        json!({ "message": format!("{error:#}") }),
    ));
    writer.emit(base_event(
        "done",
        request_id.unwrap_or_default(),
        session_id,
        json!({ "stopReason": "error" }),
    ));
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use backboard::BackboardModel;
    use serde_json::json;

	use super::{
		add_visible_models, is_featherless_provider, model_is_visible, normalize_tool_output,
		thinking_payload, tool_calls_required_by_chunk, tool_definitions, voice_payload,
	};

    #[test]
    fn thinking_payload_omits_fast_and_uses_provider_shapes() {
        assert_eq!(thinking_payload("fast", "openai", "gpt-5"), None);
        assert_eq!(
            thinking_payload("balanced", "openai", "gpt-5").unwrap(),
            json!({ "effort": "low" })
        );
        assert_eq!(
            thinking_payload("deep", "anthropic", "claude-sonnet-4").unwrap(),
            json!({ "budget_tokens": 16384 })
        );
        assert_eq!(
            thinking_payload("balanced", "google", "gemini-2.5-pro").unwrap(),
            json!({ "budget_tokens": 2048 })
        );
    }

    #[test]
    fn ask_mode_only_exposes_read_tools() {
        let names = tool_definitions("ask")
            .into_iter()
            .filter_map(|tool| {
                tool.pointer("/function/name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();

        assert!(names.contains(&"read_file".to_string()));
        assert!(names.contains(&"grep".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"create_file".to_string()));
        assert!(!names.contains(&"edit_file".to_string()));
        assert!(!names.contains(&"bash".to_string()));
    }

    #[test]
    fn full_access_advertises_zed_native_tool_names() {
        let names = tool_definitions("free")
            .into_iter()
            .filter_map(|tool| {
                tool.pointer("/function/name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "bash",
                "run_terminal_cmd",
                "read_file",
                "write",
                "write_file",
                "create_file",
                "overwrite_file",
                "edit",
                "edit_file",
                "search_replace",
                "glob",
                "grep",
                "codebase_search",
                "list_dir",
                "delete_file",
                "create_directory",
                "web_search",
                "web_fetch",
                "todo_write",
                "read_lints",
                "task",
                "enter_plan_mode",
                "exit_plan_mode",
                "persistence_decide",
                "sleep",
                "repl",
                "run_code",
                "computer",
                "ask_user_question",
            ]
        );
    }

    #[test]
    fn featherless_provider_models_are_hidden() {
        let visible = BackboardModel {
            provider: "openai".to_string(),
            name: "featherless-compatible-model".to_string(),
            display_name: Some("Featherless-compatible model".to_string()),
            ..Default::default()
        };
        let provider_hidden = BackboardModel {
            provider: " Featherless ".to_string(),
            name: "meta-llama".to_string(),
            ..Default::default()
        };

        assert!(model_is_visible(&visible));
        assert!(!model_is_visible(&provider_hidden));
        assert!(is_featherless_provider("featherless"));
        assert!(is_featherless_provider("FEATHERLESS"));
    }

    #[test]
    fn model_collection_merges_dedupes_and_preserves_metadata() {
        let mut models = Vec::new();
        let mut seen = HashSet::new();

        add_visible_models(
            &mut models,
            &mut seen,
            vec![
                BackboardModel {
                    provider: "openai".to_string(),
                    name: "same".to_string(),
                    model_type: Some("llm".to_string()),
                    display_name: Some("First".to_string()),
                    ..Default::default()
                },
                BackboardModel {
                    provider: "featherless".to_string(),
                    name: "hidden".to_string(),
                    ..Default::default()
                },
                BackboardModel {
                    provider: "custom".to_string(),
                    name: "rerank".to_string(),
                    model_type: Some("reranker".to_string()),
                    ..Default::default()
                },
            ],
        );
        add_visible_models(
            &mut models,
            &mut seen,
            vec![BackboardModel {
                provider: "OpenAI".to_string(),
                name: " SAME ".to_string(),
                model_type: Some("embedding".to_string()),
                display_name: Some("Second".to_string()),
                ..Default::default()
            }],
        );

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].display_name.as_deref(), Some("First"));
        assert_eq!(models[0].model_type.as_deref(), Some("llm"));
        assert_eq!(models[1].model_type.as_deref(), Some("reranker"));
    }

    #[test]
    fn voice_payload_uses_zed_defaults() {
        let payload = voice_payload("conversation").unwrap();
        assert_eq!(payload["stt"]["model"], "gpt-4o-mini-transcribe");
        assert_eq!(payload["tts"]["model"], "gpt-4o-mini-tts");
        assert_eq!(payload["tts"]["voice"], "alloy");
        assert_eq!(voice_payload("off"), None);
    }

    #[test]
    fn tool_outputs_are_json_strings() {
        let output = normalize_tool_output(json!({
            "toolCallId": "call_1",
            "output": { "success": true, "content": "ok" }
        }));

        assert_eq!(output["tool_call_id"], "call_1");
        assert!(
            output["output"]
                .as_str()
                .unwrap()
                .contains("\"success\":true")
        );
    }

    #[test]
    fn tool_calls_are_detected_inside_data_envelope() {
        let calls = tool_calls_required_by_chunk(&json!({
            "type": "run_requires_action",
            "data": {
                "required_action": {
                    "submit_tool_outputs": {
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "read_file",
                                    "arguments": "{\"path\":\"README.md\"}"
                                }
                            }
                        ]
                    }
                }
            }
        }))
        .unwrap();

        assert_eq!(calls[0]["id"], "call_1");
    }
}
