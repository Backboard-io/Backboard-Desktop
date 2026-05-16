use std::{collections::VecDeque, pin::Pin, time::Duration};

use anyhow::Result;
use futures::{Stream, StreamExt as _};
use reqwest::{Response, StatusCode};
use serde_json::{Value, json};

use super::{BackboardError, SendMessageRequest};

const STREAM_MAX_RETRIES: u32 = 5;
const STREAM_RETRY_BASE_DELAY: Duration = Duration::from_secs(2);

pub(crate) fn message_form(
    request: SendMessageRequest,
    stream: bool,
) -> Result<Vec<(String, String)>> {
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

pub(crate) fn sse_json_stream(response: Response) -> impl Stream<Item = Result<Value>> {
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

struct RetryStreamState<F> {
    make_request: F,
    attempt: u32,
    streamed_any: bool,
    stream: Option<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>>,
    sleep_before_request: Option<Duration>,
}

pub(crate) fn retrying_sse_json_stream<F>(
    make_request: F,
) -> Pin<Box<dyn Stream<Item = Result<Value>> + Send>>
where
    F: FnMut() -> reqwest::RequestBuilder + Send + 'static,
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
