# Backboard Zed API Endpoints

This document explains how the Backboard API is used from the Zed-based IDE in this checkout.
It is based on the live Rust code, with notes from the existing docs folder cross-checked.

## Related Docs

- [`../BACKBOARD_IDE_HANDOFF.md`](../BACKBOARD_IDE_HANDOFF.md): broad handoff and source map.
- [`BACKBOARD_IDE_RUST_ENDPOINTS.md`](BACKBOARD_IDE_RUST_ENDPOINTS.md): broader Rust endpoint contract notes. Some route details there describe older or target behavior.
- [`BACKBOARD_IDE_NATIVE_ENDPOINTS_NEXT_STEPS.md`](BACKBOARD_IDE_NATIVE_ENDPOINTS_NEXT_STEPS.md): historical migration plan from the Python bridge to native Rust.

## Source Map

| Source | Status | Purpose |
| --- | --- | --- |
| [`../../zed/crates/backboard/Cargo.toml`](../../zed/crates/backboard/Cargo.toml) | Live | The crate uses `[lib] path = "src/backboard.rs"`. |
| [`../../zed/crates/backboard/src/backboard.rs`](../../zed/crates/backboard/src/backboard.rs) | Live source of truth | Config, request structs, Backboard HTTP client, SSE parsing, message payloads, model catalog, billing usage, voice URL, and tests. |
| [`../../zed/crates/backboard/src/endpoints/`](../../zed/crates/backboard/src/endpoints) | Reference or unfinished split | Modular endpoint files mirror much of the client, but they are not the compiled crate root in this checkout. Some of these files lag newer live fields and routes. |
| [`../../zed/crates/agent_servers/src/backboard.rs`](../../zed/crates/agent_servers/src/backboard.rs) | Live | Registers the `backboard` agent and returns `BackboardNativeConnection`. |
| [`../../zed/crates/agent_servers/src/backboard_native/`](../../zed/crates/agent_servers/src/backboard_native) | Live | Native chat runtime, prompt preparation, stream translation, tool execution, cancellation, model catalog UI, usage mapping, and feature chips. |
| [`../../zed/crates/edit_prediction/src/backboard.rs`](../../zed/crates/edit_prediction/src/backboard.rs) | Live | Inline completion path that uses Backboard assistant/thread/message endpoints separately from normal chat. |

Important distinction: the active chat path does not currently compile through `src/endpoints/mod.rs`.
When checking actual behavior, read `zed/crates/backboard/src/backboard.rs` first.

## Runtime Shape

The main IDE chat flow is:

```text
Zed agent UI
  -> BackboardAgentServer
  -> BackboardNativeConnection
  -> BackboardClient in zed/crates/backboard/src/backboard.rs
  -> Backboard HTTP or SSE API
  -> local Rust tool execution when the server requests tools
  -> ACP thread updates for chat text, thoughts, tools, diffs, terminal cards, usage, and cost
```

`BackboardAgentServer::connect` logs that the IDE is using the native Rust runtime, not the old Python ACP/CLI bridge.
Generic ACP thread types still exist because the Zed UI uses them as the chat rendering model.

## Config And Auth

Backboard config is loaded from:

```text
~/.backboard/config.json
```

The live config fields used by the Rust client are:

| Field | Meaning |
| --- | --- |
| `env` | Environment selector. Defaults to `prod`. |
| `api_url` | Optional custom base URL. If present, it wins over `env`. |
| `api_key` | Top-level API key. |
| `env_keys` | Per-environment API keys. |

Default base URLs:

| Env | Base URL |
| --- | --- |
| `prod` or `production` | `https://app.backboard.io/api` |
| `local` | `http://localhost:8000` |
| anything else | `https://dev.app.backboard.io/api` |

API key lookup order:

1. Non-empty top-level `api_key`.
2. Non-empty `env_keys[env]`.
3. Non-empty `BACKBOARD_API_KEY` environment variable.

HTTP requests authenticate with:

```text
X-API-Key: <key>
```

Realtime voice derives a WebSocket URL with the key in the query string:

```text
wss://app.backboard.io/api/threads/messages?api_key=<url-encoded-key>
```

There is no dedicated live validation method in `BackboardClient`. The UI checks whether a key exists before creating a session; invalid keys surface when an API request fails. Older docs mention `GET /assistants?limit=1` as a cheap validation probe, but that is not implemented as a named helper in the live client.

## Endpoint Inventory

These are the Backboard routes exposed or used by the live Rust code.

| Purpose | Method and path | Main caller | Payload or query | Notes |
| --- | --- | --- | --- | --- |
| Warm connection | `GET <base_url>` | `BackboardNativeState::warm_client` | None | Used as a best-effort preconnect. |
| Create assistant | `POST /assistants` | Backboard client, inline completion | JSON | Normal chat does not currently pre-create an assistant; inline completion does. |
| Update assistant | `PUT /assistants/{assistant_id}` | Backboard client helper | JSON | Supported by client; not central to the active chat turn. |
| Get assistant | `GET /assistants/{assistant_id}` | Backboard client helper | None | Diagnostic/helper surface. |
| List assistants | `GET /assistants` | Backboard client helper | None | No `limit` query in the live helper. |
| Create thread | `POST /assistants/{assistant_id}/threads` | Backboard client, inline completion | JSON `{}` | Inline completion creates ephemeral threads; normal chat relies on `/threads/messages` to create or bind on first turn. |
| Get thread | `GET /threads/{thread_id}` | Backboard client helper/history support | None | Used for replay/history support when wired by runtime code. |
| List threads | `GET /threads` | Backboard client helper | None | Global list helper. |
| List assistant threads | `GET /assistants/{assistant_id}/threads` | Backboard client helper | None | Assistant-scoped list helper. |
| Send chat message | `POST /threads/messages` | `backboard_native::stream::run_prompt` | JSON for text; multipart for audio | Current main native chat path. `thread_id` is optional in the body. |
| Send inline-completion message | `POST /threads/{thread_id}/messages` | `edit_prediction/src/backboard.rs` | Form encoded | Separate inline completion path, not the main chat path. |
| Submit tool outputs | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs` | Backboard client helper | JSON | Non-streaming helper. |
| Submit tool outputs and continue stream | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` | Native chat and sub-agent tools | JSON, SSE response | Main tool continuation path. |
| Cancel run | `POST /threads/{thread_id}/runs/{run_id}/cancel` | `BackboardNativeConnection::cancel` | None | Best effort; local cancellation flag is also set. |
| Upload document | `POST /assistants/{assistant_id}/documents` | Backboard client helper | Multipart `file` | Supporting surface. |
| List memories | `GET /assistants/{assistant_id}/memories` | Backboard client helper | None | Supporting surface. |
| Add memory | `POST /assistants/{assistant_id}/memories` | Backboard client helper | JSON | Body contains `content` and `tags`. |
| List models | `GET /models` | Native model selector, inline completion | `model_type=llm`, `limit`, optional `provider` | Native chat uses `limit=15000`; inline completion uses `limit=200`. |
| List providers | `GET /models/providers` | Native model selector | None | Used to expand provider-scoped model catalog calls. |
| Recent usage | `GET /billing/usage/recent` | Native stream usage reconciliation | `page=1`, `page_size`, optional `model_name`, `input_tokens`, `output_tokens` | Failure returns `None` instead of failing the turn. |
| Realtime voice | `WS /threads/messages?api_key=...` | Live voice setup helper | Initial setup JSON, then audio frames by caller | The client constructs the URL/setup; socket driving is outside the endpoint helper. |

## Main Chat Turn

1. `BackboardAgentServer` creates a `BackboardNativeConnection`.
2. A new native session is created with a local `AcpThread`, workspace path, mode, provider/model defaults, feature settings, and no remote `thread_id`.
3. On prompt, the runtime loads `~/.backboard/config.json`, gets or creates a cached `BackboardClient`, and builds the turn settings.
4. The runtime collects enabled MCP tools, builds native tool schemas, selects provider/model, computes thinking payload, voice payload, image settings, web search setting, and optional audio attachment.
5. The user message is augmented with workspace context unless it is on the simple fast path.
6. The runtime sends `SendMessageRequest` to `POST /threads/messages` with `stream=true`.
7. If this is the first turn, no `thread_id` is sent. The runtime watches streamed chunks for thread and assistant identifiers and records them with `record_message_thread_binding`.
8. Later turns include the recorded `thread_id` in the message body.
9. SSE chunks are translated into ACP thread updates.
10. If Backboard sends a tool request, the IDE executes local Rust tools, submits outputs to `submit-tool-outputs?stream=true`, and consumes the continuation stream.
11. When the run ends, the runtime emits final media/voice records, usage, context metadata, and optional cost reconciliation.

## Main Chat Message Body

For text-only chat, the live client sends JSON to `POST /threads/messages`.

Core fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `content` | string | User prompt after IDE context augmentation. |
| `stream` | boolean | `true` for SSE. |
| `memory` | string | Usually `Auto`; simple fast path uses `Off`. |
| `web_search` | string | `off` or `Auto`. |
| `thread_id` | string, optional | Present after the first remote thread binding. |
| `assistant_id` | string, optional | Supported by request struct; active chat sends `None`. |
| `llm_provider` | string, optional | Provider selected in the model UI. |
| `model_name` | string, optional | Model selected in the model UI. |
| `thinking` | object, optional | Provider-shaped reasoning controls from the Intensity chip. |
| `tools` | array, optional | Native and enabled MCP tool definitions for the turn. |
| `max_tokens` | number, optional | Output cap when configured. |
| `mcp_calls` | object or array, optional | Built from enabled MCP call groups such as Figma. |

Image fields when image generation is enabled:

| Field | Value |
| --- | --- |
| `image_generation` | `auto` |
| `image_model_provider` | Default image provider from the native runtime. |
| `image_model_name` | Default image model from the native runtime. |

Voice fields:

| Field | Meaning |
| --- | --- |
| `voice` | JSON object containing `stt`, `tts`, or both. |
| `send_to_llm` | Serialized as `"false"` for STT-only and `"true"` for TTS/conversation modes. |
| `audio_file` | Multipart file part when STT or conversation mode uploads audio. |

If `audio_file` is present, the client switches from JSON to multipart form data. Scalar fields are text parts, JSON fields are stringified, and the file is attached as `audio_file`.

## Inline Completion Path

Inline completion is separate from normal chat.

It does this for each completion run:

1. Reuse a cached assistant ID when available; otherwise `POST /assistants`.
2. Create a fresh ephemeral thread with `POST /assistants/{assistant_id}/threads`.
3. Send a streamed form request to `POST /threads/{thread_id}/messages`.
4. Use `memory=off`, `web_search=off`, selected provider/model, and `max_tokens=256`.
5. Do not persist the ephemeral thread after the completion request.

Inline completion fetches models with:

```text
GET /models?model_type=llm&limit=200
```

## Streaming Contract

Backboard streaming responses are server-sent events. The client reads lines that start with:

```text
data: <json>
```

The parser ignores non-data lines, empty payloads, and `[DONE]`.

The native runtime currently handles these chunk types:

| Chunk type | IDE behavior |
| --- | --- |
| `run_started` | Stores current `run_id` and emits progress. |
| `reasoning_started` | Emits planning progress. |
| `reasoning_streaming` | Emits thought text. |
| `reasoning_delta` | Emits thought text. |
| `reasoning_ended` | Ends the thought phase. |
| `content_streaming` | Emits assistant text. |
| `media_generated` | Emits generated media resource links when image generation is enabled. |
| `stt_text_delta` | Emits transcript text. |
| `stt_stream_end` | Emits final transcript text. |
| `tts_audio_delta` | Emits audio resource links. |
| `tts_audio_chunk` | Ignored by the chat UI. |
| `tts_stream_end` | Emits audio links and can close the turn after `run_ended`. |
| `tool_submit_required` | Executes local tools and submits outputs. |
| `run_ended` | Emits generated media, voice records, usage, context metadata, and ends the turn. |
| `run_failed` | Emits the failure text and ends the turn. |
| `error` | Emits the failure text and ends the turn. |
| `retry` | Emits retry progress. |

The runtime also treats chunks with `status: "requires_action"` and a `required_action.submit_tool_outputs.tool_calls` shape as tool requests, even if the chunk type is not exactly `tool_submit_required`.

## Tool Continuation

When the stream asks for tools, the runtime:

1. Extracts `tool_calls`.
2. Extracts `run_id` from the chunk or from the stored current run.
3. Uses the current remote `thread_id`.
4. Executes the local Rust tool batch.
5. Sends JSON to `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true`.
6. Consumes the returned SSE continuation.

Payload shape:

```json
{
  "tool_outputs": [
    {
      "tool_call_id": "call_id_from_backboard",
      "output": "{\"success\":true,\"content\":\"...\"}"
    }
  ]
}
```

Rules that matter:

- `tool_call_id` must match the server-provided ID.
- `output` is a JSON string, not a nested object.
- Valid grouped calls are returned in call order, including read-only groups executed with ordered joins. Malformed raw calls are converted to error outputs during parsing.
- The active runtime normally omits `tools` on continuation; tool definitions are sent on the original turn.

## Model Catalog Flow

The native model selector fetches the catalog in layers:

1. Try a broad catalog request:

   ```text
   GET /models?model_type=llm&limit=15000
   ```

2. Fetch providers:

   ```text
   GET /models/providers
   ```

3. Merge those providers with a built-in provider list.
4. Fetch provider-scoped model lists concurrently:

   ```text
   GET /models?model_type=llm&limit=15000&provider=<provider>
   ```

This avoids depending only on the broad catalog and gives the UI better provider grouping.

## Usage And Cost

`run_ended` chunks can include authoritative usage and context metadata. The runtime parses fields such as input/output tokens, context used, context limit, summary tokens, and model.

After usage is emitted, the runtime may reconcile billed cost with:

```text
GET /billing/usage/recent?page=1&page_size=<1..100>&model_name=<model>&input_tokens=<n>&output_tokens=<n>
```

If billing usage fails or is ambiguous, the chat turn still succeeds and cost is left unchanged.

## Cancellation

Cancellation is two-layered:

1. Set the local session cancellation flag so local tool execution and sub-agent loops stop cooperatively.
2. If a remote `thread_id` and `run_id` are known, call:

   ```text
   POST /threads/{thread_id}/runs/{run_id}/cancel
   ```

The remote cancel call is best effort. Failure is logged but does not block local cancellation.

## Current Gotchas

- The live compiled Backboard client is `src/backboard.rs`, not the `src/endpoints/` module tree.
- The active native chat route is `POST /threads/messages` with `thread_id` in the payload. Older docs and the endpoint mirror describe `POST /threads/{thread_id}/messages`.
- Text-only native chat uses JSON. Inline completion still uses form-encoded `POST /threads/{thread_id}/messages`.
- `submit_tool_outputs_stream` in live `src/backboard.rs` currently opens the SSE stream directly after `ensure_success`; the modular `endpoints/tools.rs` version has pre-stream retry logic but is not compiled as the crate root.
- The live client supports assistant/thread helpers, documents, memories, models, providers, usage, and cancellation, but the main chat path does not call `create_assistant` or `create_thread` before the first user message.
- There is no named live API-key validation helper; missing keys are caught before session creation, while invalid keys fail on API calls.
