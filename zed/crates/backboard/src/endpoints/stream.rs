use std::collections::VecDeque;

use anyhow::Result;
use futures::{Stream, StreamExt as _};
use reqwest::Response;
use serde_json::Value;

use super::SendMessageRequest;

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
