use std::{pin::Pin, rc::Rc, time::Instant};

use ::backboard::{AudioAttachment, SendMessageRequest, SubmitToolOutputsRequest};
use acp_thread::{AcpThread, UserMessageId};
use agent_client_protocol::schema as acp;
use anyhow::{Context as _, Result, anyhow};
use base64::Engine as _;
use futures::{Stream, StreamExt as _};
use gpui::{AsyncApp, WeakEntity};
use serde_json::{Value, json};

use super::{
    BackboardNativeState, HISTORY_REPLAY_MAX_MESSAGES, SessionRuntime, missing_api_key_message,
};
use crate::backboard_native::{tool_schemas, tools, workspace};

pub async fn run_prompt(
    state: Rc<BackboardNativeState>,
    _user_message_id: UserMessageId,
    params: acp::PromptRequest,
    cx: &mut AsyncApp,
) -> Result<acp::PromptResponse> {
    let runtime = state.runtime_for_session(&params.session_id)?;
    state.reset_turn_metrics(&params.session_id);
    log::info!(
        "Backboard native prompt start: session_id={} provider={} model={} mode={} intensity={} path=rust-native",
        params.session_id,
        runtime.provider,
        runtime.model,
        runtime.mode,
        runtime.intensity
    );
    runtime
        .cancel_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);

    let prompt_parts = prompt_parts(&params.prompt);
    let message = prompt_parts.text.clone();
    if message.trim().is_empty() {
        if matches!(
            runtime.feature_settings.voice_mode.as_str(),
            "stt" | "conversation"
        ) && prompt_parts.audio.is_empty()
        {
            emit_agent_text(
                &state,
                &runtime,
                "Attach an audio clip before using Backboard voice transcription.",
                cx,
            )?;
            return Ok(acp::PromptResponse::new(acp::StopReason::EndTurn));
        }
        emit_agent_text(
            &state,
            &runtime,
            "Give me a prompt and I will work from the current workspace.",
            cx,
        )?;
        return Ok(acp::PromptResponse::new(acp::StopReason::EndTurn));
    }

    emit_progress(&state, &runtime, "Preparing workspace context.", cx)?;

    let runtime_load_started = Instant::now();
    let (config, client) = match state.client() {
        Ok(parts) => parts,
        Err(_) => {
            emit_agent_text(&state, &runtime, &missing_api_key_message(), cx)?;
            return Ok(acp::PromptResponse::new(acp::StopReason::EndTurn));
        }
    };
    state.record_turn_timing(&params.session_id, "runtime_load_ms", runtime_load_started);

    let assistant_started = Instant::now();
    let thread_id = state
        .clone()
        .ensure_thread_binding(&params.session_id, cx)
        .await?;
    state.record_turn_timing(&params.session_id, "assistant_create_ms", assistant_started);
    let provider = Some(runtime.provider.clone());
    let model = Some(runtime.model.clone());
    let tools = Some(tool_schemas::tool_definitions(&runtime.mode.to_string()));
    let thinking = thinking_payload(&runtime.intensity, &runtime.provider, &runtime.model);
    let voice = voice_payload(&runtime.feature_settings);
    let audio_file = audio_attachment_for_voice(&runtime.feature_settings, &prompt_parts.audio);
    if matches!(
        runtime.feature_settings.voice_mode.as_str(),
        "stt" | "conversation"
    ) && audio_file.is_none()
    {
        emit_agent_text(
            &state,
            &runtime,
            "Attach an audio clip before using Backboard voice transcription.",
            cx,
        )?;
        return Ok(acp::PromptResponse::new(acp::StopReason::EndTurn));
    }
    if runtime.feature_settings.live_voice == "on" {
        let realtime_url = client.realtime_voice_url();
        let setup = realtime_voice_setup(&thread_id, &runtime.feature_settings);
        log::info!(
            "Backboard native realtime voice prepared: session_id={} endpoint={} setup={}",
            params.session_id,
            realtime_url,
            setup
        );
        emit_progress(
            &state,
            &runtime,
            &format!("Realtime voice enabled for {realtime_url}."),
            cx,
        )?;
    }
    let context_pack_started = Instant::now();
    let augmented =
        workspace::augment_prompt(&message, &runtime.workspace, &runtime.mode.to_string());
    state.record_turn_timing(&params.session_id, "context_pack_ms", context_pack_started);
    state.set_estimated_used_tokens(&params.session_id, estimate_tokens(&augmented));
    emit_speed_update(&state, &runtime, cx).ok();

    emit_progress(&state, &runtime, "Sending to model.", cx)?;

    let request = SendMessageRequest {
        content: augmented,
        provider,
        model,
        memory: "Auto".to_string(),
        thinking,
        tools,
        web_search: runtime.feature_settings.web_search.clone(),
        image_generation: Some(runtime.feature_settings.image_generation.clone()),
        image_model_provider: (runtime.feature_settings.image_generation == "auto")
            .then(|| super::DEFAULT_IMAGE_PROVIDER.to_string()),
        image_model_name: (runtime.feature_settings.image_generation == "auto")
            .then(|| super::DEFAULT_IMAGE_MODEL.to_string()),
        voice,
        send_to_llm: send_to_llm_for_voice(&runtime.feature_settings),
        max_tokens: None,
        audio_file,
    };
    let thread_id_for_request = thread_id.clone();
    log::info!(
        "Backboard native endpoint call: POST /threads/{{thread_id}}/messages?stream=true session_id={} thread_id={} provider={} model={}",
        params.session_id,
        thread_id_for_request,
        runtime.provider,
        runtime.model
    );
    let stream = gpui_tokio::Tokio::spawn_result(cx, async move {
        client
            .send_message_stream(&thread_id_for_request, request)
            .await
    })
    .await?;

    let stop = consume_stream(state, runtime, thread_id, stream, cx).await?;
    if config.default_model.is_none() || config.default_provider.is_none() {
        // The API call succeeded using the configured/fallback model. Do not
        // force-write defaults here; selecting a model in the UI owns config persistence.
    }
    Ok(acp::PromptResponse::new(stop))
}

pub async fn replay_history(
    state: Rc<BackboardNativeState>,
    session_id: &acp::SessionId,
    thread: WeakEntity<AcpThread>,
    cx: &mut AsyncApp,
) -> Result<()> {
    let Some(thread_id) = state.session_thread_id(session_id) else {
        return Ok(());
    };
    log::info!(
        "Backboard native endpoint call: GET /threads/{{thread_id}} session_id={} thread_id={} path=rust-native",
        session_id,
        thread_id
    );
    let (_config, client) = match state.client() {
        Ok(parts) => parts,
        Err(_) => return Ok(()),
    };
    let data =
        gpui_tokio::Tokio::spawn_result(cx, async move { client.get_thread(&thread_id).await })
            .await?;
    let messages = data
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let start = messages.len().saturating_sub(HISTORY_REPLAY_MAX_MESSAGES);

    for message in messages.into_iter().skip(start) {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let update = match role {
            "user" => acp::SessionUpdate::UserMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::from(strip_ide_context(text)),
            )),
            "assistant" => acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::from(strip_ide_context(text)),
            )),
            _ => continue,
        };
        thread
            .update(cx, |thread, cx| thread.handle_session_update(update, cx))
            .map_err(|err| anyhow!(err))?
            .map_err(|err| anyhow!("{err:?}"))?;
    }

    Ok(())
}

async fn consume_stream(
    state: Rc<BackboardNativeState>,
    runtime: SessionRuntime,
    thread_id: String,
    mut stream: Pin<Box<dyn Stream<Item = Result<Value>> + Send>>,
    cx: &mut AsyncApp,
) -> Result<acp::StopReason> {
    loop {
        let mut next_stream = None;

        while let Some((chunk, returned_stream)) = next_stream_chunk(stream, cx).await? {
            stream = returned_stream;
            if runtime
                .cancel_flag
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Ok(acp::StopReason::Cancelled);
            }

            let chunk = chunk?;
            match chunk
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "run_started" => {
                    let run_id = chunk
                        .get("run_id")
                        .or_else(|| chunk.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    state.set_current_run_id(&runtime.session_id, run_id);
                    emit_progress(&state, &runtime, "Connected to model.", cx)?;
                }
                "reasoning_started" => {
                    emit_progress(&state, &runtime, "Planning next step.", cx)?;
                }
                "reasoning_streaming" | "reasoning_delta" => {
                    if let Some(text) = chunk_text(&chunk) {
                        state.emit_update(
                            &runtime,
                            acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk::new(
                                acp::ContentBlock::from(text),
                            )),
                            cx,
                        )?;
                    }
                }
                "reasoning_ended" => {}
                "content_streaming" => {
                    if let Some(text) = chunk_text(&chunk) {
                        if state.mark_first_token(&runtime.session_id) {
                            emit_speed_update(&state, &runtime, cx).ok();
                        }
                        emit_agent_text(&state, &runtime, &text, cx)?;
                    }
                }
                "media_generated" => {
                    if runtime.feature_settings.image_generation == "auto" {
                        emit_media_generated(&state, &runtime, &chunk, cx)?;
                    } else {
                        log::warn!(
                            "Backboard native ignored generated media because image generation is off: session_id={}",
                            runtime.session_id
                        );
                    }
                }
                "stt_text_delta" => {
                    if let Some(text) = chunk_text(&chunk) {
                        emit_agent_text(&state, &runtime, &text, cx)?;
                    }
                }
                "stt_stream_end" => {
                    if let Some(transcript) = chunk
                        .get("transcript")
                        .or_else(|| chunk.get("content"))
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        emit_agent_text(
                            &state,
                            &runtime,
                            &format!("\n\nTranscript: {transcript}"),
                            cx,
                        )?;
                    }
                }
                "tts_audio_delta" => {
                    emit_voice_audio_delta(&state, &runtime, &chunk, cx)?;
                }
                "tool_submit_required" => {
                    let run_id = chunk
                        .get("run_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            state
                                .sessions
                                .borrow()
                                .get(&runtime.session_id)
                                .and_then(|session| session.current_run_id.clone())
                        })
                        .context("tool_submit_required did not include a run id")?;
                    let tool_calls = chunk
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    next_stream = Some(
                        submit_tools(state.clone(), &runtime, &thread_id, &run_id, tool_calls, cx)
                            .await?,
                    );
                    break;
                }
                "run_ended" => {
                    if chunk.get("status").and_then(Value::as_str) == Some("requires_action")
                        && chunk.get("tool_calls").is_some()
                    {
                        let run_id = chunk
                            .get("run_id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or_else(|| {
                                state
                                    .sessions
                                    .borrow()
                                    .get(&runtime.session_id)
                                    .and_then(|session| session.current_run_id.clone())
                            })
                            .context("requires_action run_ended did not include a run id")?;
                        let tool_calls = chunk
                            .get("tool_calls")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        next_stream = Some(
                            submit_tools(
                                state.clone(),
                                &runtime,
                                &thread_id,
                                &run_id,
                                tool_calls,
                                cx,
                            )
                            .await?,
                        );
                        break;
                    }
                    if runtime.feature_settings.image_generation == "auto" {
                        emit_generated_media_records(&state, &runtime, &chunk, cx).ok();
                    }
                    emit_voice_records(&state, &runtime, &chunk, cx).ok();
                    emit_usage(&state, &runtime, &chunk, cx).ok();
                    state.set_current_run_id(&runtime.session_id, None);
                    return Ok(acp::StopReason::EndTurn);
                }
                "run_failed" | "error" => {
                    let message = chunk
                        .get("error")
                        .or_else(|| chunk.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Backboard run failed.");
                    emit_agent_text(&state, &runtime, message, cx)?;
                    emit_speed_update(&state, &runtime, cx).ok();
                    state.set_current_run_id(&runtime.session_id, None);
                    return Ok(acp::StopReason::EndTurn);
                }
                "retry" => {
                    emit_progress(&state, &runtime, "Retrying request.", cx)?;
                }
                _ => {}
            }
        }

        if let Some(continuation) = next_stream {
            stream = continuation;
        } else {
            state.set_current_run_id(&runtime.session_id, None);
            return Ok(acp::StopReason::EndTurn);
        }
    }
}

async fn submit_tools(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    thread_id: &str,
    run_id: &str,
    tool_calls: Vec<Value>,
    cx: &mut AsyncApp,
) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
    emit_progress(
        &state,
        runtime,
        &format!(
            "Running {} tool action{}.",
            tool_calls.len(),
            if tool_calls.len() == 1 { "" } else { "s" }
        ),
        cx,
    )?;
    let tool_batch_started = Instant::now();
    let outputs = tools::execute_tool_batch(state.clone(), runtime, tool_calls, cx).await?;
    state.add_turn_timing(&runtime.session_id, "tool_batch_ms", tool_batch_started);
    emit_speed_update(&state, runtime, cx).ok();
    let (_config, client) = state.client()?;
    let thread_id = thread_id.to_string();
    let run_id = run_id.to_string();
    let request = SubmitToolOutputsRequest {
        tool_outputs: outputs,
        tools: Some(tool_schemas::tool_definitions(&runtime.mode.to_string())),
    };
    log::info!(
        "Backboard native endpoint call: POST /threads/{{thread_id}}/runs/{{run_id}}/submit-tool-outputs?stream=true session_id={} thread_id={} run_id={} path=rust-native",
        runtime.session_id,
        thread_id,
        run_id
    );
    gpui_tokio::Tokio::spawn_result(cx, async move {
        client
            .submit_tool_outputs_stream(&thread_id, &run_id, request)
            .await
    })
    .await
}

async fn next_stream_chunk(
    mut stream: Pin<Box<dyn Stream<Item = Result<Value>> + Send>>,
    cx: &mut AsyncApp,
) -> Result<
    Option<(
        Result<Value>,
        Pin<Box<dyn Stream<Item = Result<Value>> + Send>>,
    )>,
> {
    gpui_tokio::Tokio::spawn_result(cx, async move {
        let next = stream.next().await;
        anyhow::Ok(next.map(|chunk| (chunk, stream)))
    })
    .await
}

fn emit_agent_text(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    text: &str,
    cx: &mut AsyncApp,
) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    state.emit_update(
        runtime,
        acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(acp::ContentBlock::from(
            text.to_string(),
        ))),
        cx,
    )
}

fn emit_progress(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    text: &str,
    cx: &mut AsyncApp,
) -> Result<()> {
    let mut meta = acp::Meta::new();
    meta.insert("backboardProgress".to_string(), true.into());
    state.emit_update(
        runtime,
        acp::SessionUpdate::AgentThoughtChunk(
            acp::ContentChunk::new(acp::ContentBlock::from(text.to_string())).meta(meta),
        ),
        cx,
    )
}

fn emit_usage(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    chunk: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    let input_tokens = usage_number(chunk, &["input_tokens", "prompt_tokens"])
        .or_else(|| nested_usage_number(chunk, &["input_tokens", "prompt_tokens"]))
        .unwrap_or(0);
    let output_tokens = usage_number(chunk, &["output_tokens", "completion_tokens"])
        .or_else(|| nested_usage_number(chunk, &["output_tokens", "completion_tokens"]))
        .unwrap_or(0);
    let context_usage = parse_context_usage(chunk);
    let used = context_usage
        .as_ref()
        .map(|usage| usage.used_tokens)
        .or_else(|| usage_number(chunk, &["used_tokens", "total_tokens"]))
        .or_else(|| nested_usage_number(chunk, &["used_tokens", "total_tokens"]))
        .unwrap_or_else(|| {
            let (snapshot_used, _) = state.usage_snapshot(runtime);
            snapshot_used.max(input_tokens + output_tokens)
        });
    let size = context_usage
        .as_ref()
        .map(|usage| usage.context_limit)
        .or_else(|| {
            usage_number(
                chunk,
                &["context_limit", "context_window", "max_context_tokens"],
            )
        })
        .unwrap_or_else(|| state.context_window_for_runtime(runtime));
    state.set_estimated_used_tokens(&runtime.session_id, used);
    let remaining_tokens = size.saturating_sub(used);
    let context_percent = if size > 0 {
        ((used as f64 / size as f64) * 100.0).round() as u64
    } else {
        0
    };
    let context_model = context_usage
        .as_ref()
        .and_then(|usage| usage.model.clone())
        .unwrap_or_else(|| format!("{}/{}", runtime.provider, runtime.model));
    let summary_tokens = context_usage
        .as_ref()
        .map(|usage| usage.summary_tokens)
        .unwrap_or(0);
    let max_output_tokens = usage_number(
        chunk,
        &[
            "max_output_tokens",
            "output_token_limit",
            "max_completion_tokens",
        ],
    )
    .or_else(|| {
        chunk
            .get("usage")
            .and_then(|usage| usage_number(usage, &["max_output_tokens", "output_token_limit"]))
    });
    let mut meta = acp::Meta::from_iter([
        ("model".to_string(), runtime.model.clone().into()),
        ("provider".to_string(), runtime.provider.clone().into()),
        ("intensity".to_string(), runtime.intensity.clone().into()),
        ("input_tokens".to_string(), input_tokens.into()),
        ("output_tokens".to_string(), output_tokens.into()),
        ("remaining_tokens".to_string(), remaining_tokens.into()),
        ("summary_tokens".to_string(), summary_tokens.into()),
        (
            "context_percent".to_string(),
            context_percent.min(100).into(),
        ),
        ("context_model".to_string(), context_model.into()),
    ]);
    if let Some(max_output_tokens) = max_output_tokens {
        meta.insert("max_output_tokens".to_string(), max_output_tokens.into());
    }
    meta.insert("backboard_speed".to_string(), state.speed_meta(runtime));
    meta.insert(
        "backboard_context".to_string(),
        json!({
            "used_tokens": used,
            "context_limit": size,
            "remaining_tokens": remaining_tokens,
            "summary_tokens": summary_tokens,
            "percent": context_percent.min(100),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }),
    );
    state.emit_update(
        runtime,
        acp::SessionUpdate::UsageUpdate(acp::UsageUpdate::new(used, size).meta(meta)),
        cx,
    )
}

fn emit_speed_update(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    cx: &mut AsyncApp,
) -> Result<()> {
    let mut meta = acp::Meta::new();
    meta.insert("backboard_speed".to_string(), state.speed_meta(runtime));
    let (used, size) = state.usage_snapshot(runtime);
    let remaining_tokens = size.saturating_sub(used);
    let context_percent = if size > 0 {
        ((used as f64 / size as f64) * 100.0).round() as u64
    } else {
        0
    };
    meta.insert("model".to_string(), runtime.model.clone().into());
    meta.insert("provider".to_string(), runtime.provider.clone().into());
    meta.insert("intensity".to_string(), runtime.intensity.clone().into());
    meta.insert("remaining_tokens".to_string(), remaining_tokens.into());
    meta.insert(
        "context_percent".to_string(),
        context_percent.min(100).into(),
    );
    meta.insert(
        "context_model".to_string(),
        format!("{}/{}", runtime.provider, runtime.model).into(),
    );
    state.emit_update(
        runtime,
        acp::SessionUpdate::UsageUpdate(acp::UsageUpdate::new(used, size).meta(meta)),
        cx,
    )
}

fn emit_media_generated(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    chunk: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    let links = generated_media_links(chunk);
    if links.is_empty() {
        emit_progress(state, runtime, "Generated media.", cx)?;
        return Ok(());
    }
    for link in links {
        state.emit_update(
            runtime,
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::ResourceLink(link),
            )),
            cx,
        )?;
    }
    Ok(())
}

fn emit_generated_media_records(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    chunk: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    for link in generated_media_links(chunk) {
        state.emit_update(
            runtime,
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::ResourceLink(link),
            )),
            cx,
        )?;
    }
    Ok(())
}

fn emit_voice_audio_delta(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    chunk: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    if let Some(url) = chunk
        .get("url")
        .or_else(|| chunk.get("audio_url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
    {
        let mut link = acp::ResourceLink::new("Backboard voice audio", url);
        link.mime_type = chunk
            .get("mime_type")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(Some("audio/mpeg".to_string()));
        state.emit_update(
            runtime,
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::ResourceLink(link),
            )),
            cx,
        )?;
    }
    Ok(())
}

fn emit_voice_records(
    state: &Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    chunk: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    let Some(records) = chunk.get("voice_records") else {
        return Ok(());
    };
    if let Some(transcript) = records
        .get("stt")
        .and_then(|stt| stt.get("transcript").or_else(|| stt.get("text")))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        emit_agent_text(state, runtime, &format!("\n\nTranscript: {transcript}"), cx)?;
    }
    for link in voice_record_links(records) {
        state.emit_update(
            runtime,
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                acp::ContentBlock::ResourceLink(link),
            )),
            cx,
        )?;
    }
    Ok(())
}

fn generated_media_links(chunk: &Value) -> Vec<acp::ResourceLink> {
    let mut links = Vec::new();
    collect_media_links(chunk.get("generated_media"), &mut links);
    collect_media_links(chunk.get("media"), &mut links);
    collect_media_links(Some(chunk), &mut links);
    links
}

fn collect_media_links(value: Option<&Value>, links: &mut Vec<acp::ResourceLink>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(items) => {
            for item in items {
                collect_media_links(Some(item), links);
            }
        }
        Value::Object(object) => {
            if let Some(url) = object
                .get("url")
                .or_else(|| object.get("image_url"))
                .or_else(|| object.get("download_url"))
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
            {
                let mut link = acp::ResourceLink::new(
                    object
                        .get("name")
                        .or_else(|| object.get("document_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("Backboard generated image"),
                    url,
                );
                link.mime_type = object
                    .get("mime_type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                link.size = object.get("file_size_bytes").and_then(Value::as_i64);
                links.push(link);
            }
        }
        _ => {}
    }
}

fn voice_record_links(records: &Value) -> Vec<acp::ResourceLink> {
    let mut links = Vec::new();
    if let Some(tts) = records.get("tts") {
        collect_audio_links(Some(tts), &mut links);
    }
    links
}

fn collect_audio_links(value: Option<&Value>, links: &mut Vec<acp::ResourceLink>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(items) => {
            for item in items {
                collect_audio_links(Some(item), links);
            }
        }
        Value::Object(object) => {
            if let Some(url) = object
                .get("url")
                .or_else(|| object.get("audio_url"))
                .or_else(|| object.get("download_url"))
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
            {
                let mut link = acp::ResourceLink::new("Backboard voice audio", url);
                link.mime_type = object
                    .get("mime_type")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(Some("audio/mpeg".to_string()));
                links.push(link);
            }
        }
        _ => {}
    }
}

#[derive(Clone, Debug)]
struct ContextUsage {
    used_tokens: u64,
    context_limit: u64,
    summary_tokens: u64,
    model: Option<String>,
}

fn parse_context_usage(chunk: &Value) -> Option<ContextUsage> {
    let block = chunk.get("context_usage")?.as_object()?;
    let used_tokens = value_to_u64(block.get("used_tokens")?)?;
    let context_limit = value_to_u64(block.get("context_limit")?)?;
    if context_limit == 0 {
        return None;
    }
    let summary_tokens = block
        .get("summary_tokens")
        .and_then(value_to_u64)
        .unwrap_or(0);
    let model = block
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    Some(ContextUsage {
        used_tokens,
        context_limit,
        summary_tokens,
        model,
    })
}

fn usage_number(chunk: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| chunk.get(*key).and_then(value_to_u64))
}

fn nested_usage_number(chunk: &Value, keys: &[&str]) -> Option<u64> {
    chunk
        .get("usage")
        .and_then(|usage| usage_number(usage, keys))
}

fn value_to_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            value.as_f64().and_then(|number| {
                if number >= 0.0 {
                    Some(number.round() as u64)
                } else {
                    None
                }
            })
        })
        .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
}

fn estimate_tokens(text: &str) -> u64 {
    ((text.chars().count() as f64) / 4.0).ceil().max(1.0) as u64
}

#[derive(Clone, Debug, Default)]
struct PromptParts {
    text: String,
    audio: Vec<AudioAttachment>,
}

fn prompt_parts(blocks: &[acp::ContentBlock]) -> PromptParts {
    let mut audio = Vec::new();
    let text = blocks
        .iter()
        .map(|block| match block {
            acp::ContentBlock::Text(text) => text.text.clone(),
            acp::ContentBlock::ResourceLink(link) => format!("Referenced resource: {}", link.uri),
            acp::ContentBlock::Resource(resource) => {
                serde_json::to_string(resource).unwrap_or_default()
            }
            acp::ContentBlock::Image(_) => {
                "[Image omitted in native Backboard runtime]".to_string()
            }
            acp::ContentBlock::Audio(_) => {
                if let Some(attachment) = audio_attachment_from_block(block) {
                    audio.push(attachment);
                }
                String::new()
            }
            _ => String::new(),
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    PromptParts { text, audio }
}

fn audio_attachment_from_block(block: &acp::ContentBlock) -> Option<AudioAttachment> {
    let acp::ContentBlock::Audio(audio) = block else {
        return None;
    };
    let data = base64::engine::general_purpose::STANDARD
        .decode(audio.data.as_bytes())
        .ok()?;
    let extension = match audio.mime_type.as_str() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/webm" => "webm",
        "audio/mp4" | "audio/m4a" => "m4a",
        _ => "audio",
    };
    Some(AudioAttachment {
        data,
        file_name: format!("backboard-voice-input.{extension}"),
        mime_type: audio.mime_type.clone(),
    })
}

fn audio_attachment_for_voice(
    feature_settings: &super::FeatureSettings,
    attachments: &[AudioAttachment],
) -> Option<AudioAttachment> {
    matches!(feature_settings.voice_mode.as_str(), "stt" | "conversation")
        .then(|| attachments.first().cloned())
        .flatten()
}

fn voice_payload(feature_settings: &super::FeatureSettings) -> Option<Value> {
    match feature_settings.voice_mode.as_str() {
        "tts" => Some(json!({
            "tts": {
                "provider": super::DEFAULT_TTS_PROVIDER,
                "model": super::DEFAULT_TTS_MODEL,
                "voice": super::DEFAULT_TTS_VOICE,
                "output_format": super::DEFAULT_TTS_FORMAT,
            }
        })),
        "stt" => Some(json!({
            "stt": {
                "provider": super::DEFAULT_STT_PROVIDER,
                "model": super::DEFAULT_STT_MODEL,
                "language": super::DEFAULT_STT_LANGUAGE,
            }
        })),
        "conversation" => Some(json!({
            "stt": {
                "provider": super::DEFAULT_STT_PROVIDER,
                "model": super::DEFAULT_STT_MODEL,
                "language": super::DEFAULT_STT_LANGUAGE,
            },
            "tts": {
                "provider": super::DEFAULT_TTS_PROVIDER,
                "model": super::DEFAULT_TTS_MODEL,
                "voice": super::DEFAULT_TTS_VOICE,
                "output_format": super::DEFAULT_TTS_FORMAT,
            }
        })),
        _ => None,
    }
}

fn realtime_voice_setup(thread_id: &str, feature_settings: &super::FeatureSettings) -> Value {
    json!({
        "thread_id": thread_id,
        "voice": {
            "stt": {
                "provider": super::DEFAULT_REALTIME_STT_PROVIDER,
                "model": super::DEFAULT_REALTIME_STT_MODEL,
                "audio_format": "pcm_16000",
            },
            "tts": (feature_settings.voice_mode == "conversation").then(|| json!({
                "provider": super::DEFAULT_TTS_PROVIDER,
                "model": super::DEFAULT_TTS_MODEL,
                "voice": super::DEFAULT_TTS_VOICE,
                "output_format": super::DEFAULT_TTS_FORMAT,
            })),
        },
        "llm_provider": "openai",
        "model_name": "gpt-4o",
        "memory": "Auto",
    })
}

fn send_to_llm_for_voice(feature_settings: &super::FeatureSettings) -> Option<bool> {
    match feature_settings.voice_mode.as_str() {
        "stt" => Some(false),
        "tts" | "conversation" => Some(true),
        _ => None,
    }
}

fn chunk_text(chunk: &Value) -> Option<String> {
    chunk
        .get("content")
        .or_else(|| chunk.get("text"))
        .or_else(|| chunk.get("delta"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn thinking_payload(intensity: &str, provider: &str, model: &str) -> Option<Value> {
    let effort = match intensity {
        "fast" => return None,
        "balanced" => "low",
        "deep" => "max",
        _ => return None,
    };
    Some(thinking_for_provider(provider, model, effort))
        .filter(|payload| payload.as_object().is_some_and(|object| !object.is_empty()))
}

fn thinking_for_provider(provider: &str, model: &str, effort: &str) -> Value {
    let provider = provider.to_lowercase();
    let model = model.to_lowercase().replace('_', "-");
    match provider.as_str() {
        "openai" | "xai" => json!({ "effort": effort }),
        "google" => json!({
            "effort": effort,
            "budget_tokens": effort_budget_tokens(effort).min(32768),
        }),
        "anthropic" => json!({ "budget_tokens": anthropic_budget_tokens(effort) }),
        "aws-bedrock" if model.contains("opus-4-7") => json!({ "effort": effort }),
        "aws-bedrock" => json!({ "budget_tokens": anthropic_budget_tokens(effort) }),
        "openrouter" | "cerebras" => json!({ "max_tokens": effort_max_tokens(effort) }),
        _ => json!({}),
    }
}

fn effort_budget_tokens(effort: &str) -> u64 {
    match effort {
        "low" => 2048,
        "medium" => 4096,
        "high" => 10000,
        "max" => 24576,
        _ => 8192,
    }
}

fn effort_max_tokens(effort: &str) -> u64 {
    match effort {
        "low" => 1024,
        "medium" => 2048,
        "high" => 4096,
        "max" => 8192,
        _ => 4096,
    }
}

fn anthropic_budget_tokens(effort: &str) -> u64 {
    match effort {
        "low" => 2048,
        "medium" => 8192,
        "high" | "max" => 16384,
        _ => 8192,
    }
}

fn strip_ide_context(text: &str) -> String {
    text.split("<backboard_ide_context>")
        .next()
        .unwrap_or(text)
        .trim_end()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_intensity_omits_thinking_payload() {
        assert_eq!(thinking_payload("fast", "openai", "gpt-4o"), None);
    }

    #[test]
    fn thinking_payload_uses_provider_schema_without_enabled_key() {
        let openai = thinking_payload("balanced", "openai", "gpt-4o").unwrap();
        assert_eq!(openai, json!({"effort": "low"}));
        assert!(openai.get("enabled").is_none());

        assert_eq!(
            thinking_payload("deep", "anthropic", "claude-sonnet-4").unwrap(),
            json!({"budget_tokens": 16384})
        );
        assert_eq!(
            thinking_payload("balanced", "openrouter", "some-reasoning-model").unwrap(),
            json!({"max_tokens": 1024})
        );
    }

    #[test]
    fn parses_authoritative_context_usage_block() {
        let chunk = json!({
            "type": "run_ended",
            "input_tokens": 1200,
            "output_tokens": 300,
            "context_usage": {
                "used_tokens": "42000",
                "context_limit": 102400,
                "summary_tokens": 5000,
                "model": "openai/gpt-5"
            }
        });

        let usage = parse_context_usage(&chunk).expect("context_usage should parse");
        assert_eq!(usage.used_tokens, 42000);
        assert_eq!(usage.context_limit, 102400);
        assert_eq!(usage.summary_tokens, 5000);
        assert_eq!(usage.model.as_deref(), Some("openai/gpt-5"));
    }

    #[test]
    fn voice_payload_uses_backboard_defaults() {
        let settings = super::super::FeatureSettings {
            voice_mode: "conversation".to_string(),
            ..Default::default()
        };

        assert_eq!(
            voice_payload(&settings),
            Some(json!({
                "stt": {
                    "provider": "openai",
                    "model": "gpt-4o-mini-transcribe",
                    "language": "en",
                },
                "tts": {
                    "provider": "openai",
                    "model": "gpt-4o-mini-tts",
                    "voice": "alloy",
                    "output_format": "mp3",
                }
            }))
        );
        assert_eq!(send_to_llm_for_voice(&settings), Some(true));
    }

    #[test]
    fn generated_media_links_accept_media_generated_shape() {
        let chunk = json!({
            "type": "media_generated",
            "generated_media": [{
                "document_id": "doc_123",
                "media_type": "image",
                "mime_type": "image/png",
                "file_size_bytes": 904100,
                "url": "https://example.com/generated.png"
            }]
        });

        let links = generated_media_links(&chunk);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].uri, "https://example.com/generated.png");
        assert_eq!(links[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(links[0].size, Some(904100));
    }
}
