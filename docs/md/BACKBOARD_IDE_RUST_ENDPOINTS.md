# Backboard IDE Rust Endpoints

This document describes how to replace the current Python CLI plus ACP bridge path with a native Rust integration inside Backboard Studio.

Target architecture:

```text
Zed Rust UI/runtime -> Rust Backboard client -> Backboard HTTP API -> local Rust tool engine
```

The goal is not to create new backend routes for v1. The goal is to call the existing Backboard API directly from Rust, then execute tools locally in Rust and feed tool outputs back to the same run API the CLI uses today.

## Sources Of Truth

Use these files when implementing or auditing the Rust-native path:

- [`cli/backboard_cli/api/client.py`](../../cli/backboard_cli/api/client.py) is the strongest source of truth for the current HTTP contract.
- [`ide/zed/crates/backboard/src/backboard.rs`](../zed/crates/backboard/src/backboard.rs) is the existing partial Rust mirror of the Backboard client and should become the primary IDE API client.
- [`ide/zed/script/backboard-ide-acp.py`](../zed/script/backboard-ide-acp.py) is the current bridge reference for IDE-specific behavior such as context prewarm, tool batching, file diffs, terminal output, usage updates, and speed metrics.

ACP should only be treated as current-state reference material. The native implementation should not launch `backboard-ide-acp.py` and should not route chat through stdio JSON-RPC.

## API Environments And Auth

Default API roots match the CLI and existing Rust client:

| Environment | Base URL |
|---|---|
| `prod` | `https://app.backboard.io/api` |
| `dev` | `https://dev.app.backboard.io/api` |
| `local` | `http://localhost:8000` |

Auth and request rules:

- Every authenticated request uses `X-API-Key`.
- JSON endpoints use `Content-Type: application/json`.
- Message send endpoints are form-encoded, not JSON.
- Multipart document upload omits `Content-Type: application/json` and lets the HTTP client set the multipart boundary.
- The config shape should remain compatible with `~/.backboard/config.json`: `env`, `api_key`, `api_url`, `default_provider`, `default_model`, `thread_id`, `assistant_id`, and `env_keys`.

API key validation should probe:

```text
GET /assistants?limit=1
```

This mirrors `cli/backboard_cli/api/validation.py` and fails early when a user key belongs to a different environment.

## Endpoint Inventory

These are the endpoints called by the CLI API client and mirrored by the existing Rust client.

| Purpose | Method/path | Body or query | Notes |
|---|---|---|---|
| Validate API key | `GET /assistants?limit=1` | Query `limit=1` | Used as a cheap auth probe. |
| Create assistant | `POST /assistants` | JSON `name`, `description`, optional `tools`, optional custom memory prompts | First step for a chat session. |
| Update assistant tools | `PUT /assistants/{assistant_id}` | JSON subset of `name`, `description`, `tools` | Used when the tool list changes. |
| Get assistant | `GET /assistants/{assistant_id}` | None | Diagnostics/resume support. |
| List assistants | `GET /assistants` | Optional query such as `limit` | CLI listing and validation. |
| Create thread | `POST /assistants/{assistant_id}/threads` | JSON `{}` | Creates the run container for chat. |
| Get thread/history | `GET /threads/{thread_id}` | None | Replays persisted messages/history. |
| List threads | `GET /threads` | None | Global thread list. |
| List assistant threads | `GET /assistants/{assistant_id}/threads` | None | Assistant-scoped thread list. |
| Send message | `POST /threads/{thread_id}/messages` | Form fields below | Streaming or non-streaming depending on `stream`. |
| Submit tool outputs | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs` | JSON payload below | Non-streaming continuation. |
| Stream after tools | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` | JSON payload below | Main tool continuation path. |
| Cancel run | `POST /threads/{thread_id}/runs/{run_id}/cancel` | None | Best-effort cancellation. |
| Upload document | `POST /assistants/{assistant_id}/documents` | Multipart `file` | Assistant document helper. |
| List memories | `GET /assistants/{assistant_id}/memories` | None | Assistant memory helper. |
| Add memory | `POST /assistants/{assistant_id}/memories` | JSON `content`, `tags` | Assistant memory helper. |
| List models | `GET /models?model_type=llm&limit=15000` | Query `model_type`, `limit`, optional `provider` | Model picker/catalog. |
| List providers | `GET /models/providers` | None | Provider picker/catalog. |
| Recent usage/cost | `GET /billing/usage/recent` | Query `page`, `page_size`, optional `model_name`, `input_tokens`, `output_tokens` | Reconciles displayed turn cost. |

Native Rust currently uses the broad `limit=15000` model catalog request. The historical Python ACP bridge has a provider-scoped catalog path that calls the same `/models` endpoint once per major provider and merges the results; that is bridge-specific compatibility behavior to avoid unfiltered catalogs being dominated by Featherless entries, not a separate backend route.

## Message Wire Format

`POST /threads/{thread_id}/messages` sends form data:

| Field | Required | Meaning |
|---|---:|---|
| `content` | Yes | User prompt, including any IDE-added context pack. |
| `stream` | Yes | `"true"` for SSE, `"false"` for JSON response. |
| `llm_provider` | Yes in current callers | Provider name such as `openai`. |
| `model_name` | Yes in current callers | Model name such as `gpt-4o`. |
| `memory` | Yes | Usually `"Auto"`. |
| `web_search` | Yes | `"off"` or `"Auto"` from the Web composer chip. |
| `image_generation` | No | `"auto"` when the Image chip is enabled. |
| `image_model_provider` | No | Image model provider. IDE default: `openrouter`. |
| `image_model_name` | No | Image model name. IDE default: `google/gemini-3.1-flash-image-preview`. |
| `voice` | No | JSON-encoded REST voice config with `stt`, `tts`, or both. |
| `send_to_llm` | No | `"false"` for STT-only, `"true"` for TTS/conversation voice modes. |
| `audio_file` | No | Multipart audio file for REST STT/conversation mode. |
| `thinking` | No | JSON-encoded reasoning controls. |
| `tools` | No | JSON-encoded tool definitions for this turn. |
| `max_tokens` | No | Output cap from config. |

`thinking` examples used by the CLI contract:

```json
null
{}
{"effort":"high"}
{"budget_tokens":8192}
{"max_tokens":4096}
```

The native Rust client should keep this as a `serde_json::Value` field and serialize it into the form body only when present.

Text-only turns use form encoding. Voice STT and conversation turns use multipart form data so `audio_file` can be uploaded while keeping scalar fields as strings and `voice`/`tools`/`thinking` JSON-stringified.

REST voice defaults in the IDE:

- STT: `{"provider":"openai","model":"gpt-4o-mini-transcribe","language":"en"}`
- TTS: `{"provider":"openai","model":"gpt-4o-mini-tts","voice":"alloy","output_format":"mp3"}`

Realtime voice uses a WebSocket URL derived from the configured API root:

```text
wss://app.backboard.io/api/threads/messages?api_key=...
```

The first text frame is a setup JSON object containing `thread_id`, `voice.stt` with ElevenLabs `scribe_v2_realtime`, optional `voice.tts`, model settings, and memory settings. Audio frames are raw `pcm_16000` when a live microphone capture control is connected.

## Streaming Contract

Streaming responses are SSE. Each useful payload arrives as:

```text
data: {"type":"content_streaming","content":"..."}
```

Ignore blank lines, comments, non-`data:` lines, empty payloads, and `[DONE]`.

The Rust stream processor should support these chunk types initially:

| Chunk type | Native IDE behavior |
|---|---|
| `run_started` | Store the active `run_id`; show turn started/progress state. |
| `reasoning_started` | Mark thinking active; render thought/progress UI. |
| `reasoning_streaming` | Append reasoning/thought text. |
| `reasoning_delta` | Treat like reasoning delta. |
| `reasoning_ended` | Mark thinking inactive and close the thought block. |
| `content_streaming` | Append assistant-visible text. |
| `media_generated` | Render generated image/media URLs as resource links in chat. |
| `stt_text_delta` | Append streaming transcript text. |
| `stt_stream_end` | Render the final transcript. |
| `tts_audio_delta` | Render an audio resource link when the event includes a URL. |
| `tool_submit_required` | Execute local tools, submit outputs, and continue the stream. |
| `run_ended` | Record usage/cost/context, render `generated_media` and `voice_records`, and finish unless status requires tools. |
| `run_failed` | Surface a failed assistant message and diagnostic detail. |
| `error` | Surface a failed assistant message and diagnostic detail. |
| `retry` | Optional client-side synthetic event for pre-stream retry notices. |

Keep unknown chunks as `serde_json::Value` and log them instead of failing the turn. The CLI has seen provider-specific shape changes, so forward compatibility matters more than over-typing v1.

## Tool Continuation Wire Format

When the server requests tools, it supplies a `run_id` and a list of tool calls. The local runtime executes them and calls:

```text
POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true
```

Payload:

```json
{
  "tool_outputs": [
    {
      "tool_call_id": "call_123",
      "output": "{\"success\":true,\"content\":\"...\"}"
    }
  ],
  "tools": []
}
```

Rules:

- `tool_call_id` must match the server-provided tool call ID exactly.
- `output` is a JSON string, not a nested object.
- Include `tools` when the current tool schema should override the assistant's stored tools.
- Use the streaming endpoint for the main IDE path so the assistant can continue immediately after tool results.
- The non-streaming endpoint exists for helper paths and tests.

## Retry And Timeout Rules

Preserve the CLI's retry safety rules:

- Retry transient HTTP status codes `502`, `503`, `504`, and `429` with exponential backoff before streaming begins.
- Retry transient transport failures only before any SSE chunk has been yielded to the caller.
- Do not retry after the first streamed chunk. At that point the backend may already have persisted the user message, started a run, or flipped an assistant message from `REQUIRES_ACTION` to `COMPLETED`.
- For `submit-tool-outputs`, do not retry after any streamed chunk because the server may already have committed tool messages and continued the run.
- Keep a stream keepalive/stall detector, but make it reasoning-aware so long thinking phases do not false-fail.

This rule prevents duplicate user messages, mismatched run IDs, and the server error shape where a second tool-output submit cannot find an assistant message requiring action.

## Native Rust Integration Design

Extend `ide/zed/crates/backboard/src/backboard.rs` into the primary Backboard IDE client:

- Keep one reusable HTTP client with API key/base URL from Backboard config.
- Keep the existing request structs where they already exist: assistant create/update, message send, tool output submit, model list, usage query.
- Add typed response structs where the shape is stable and useful to UI code.
- Keep streaming chunks and tool call payloads as `serde_json::Value` until the backend contract is stable enough for strict enums.
- Expose both JSON calls and boxed streams of decoded SSE JSON chunks.

Replace the ACP bridge with native state updates:

- Session creation should create or restore a Backboard assistant/thread mapping without launching Python.
- Message send should build the IDE system prompt/context pack in Rust and call `send_message_stream`.
- Assistant text, thought/progress chunks, tool calls, diffs, terminal output, plan updates, usage, cost, and cancellation should update the existing Rust chat/thread state directly.
- Cancellation should cancel local work and best-effort call `POST /threads/{thread_id}/runs/{run_id}/cancel`.
- Diagnostics should include HTTP status, endpoint path, run ID, thread ID, and the raw unknown chunk when relevant.

Keep the current speed wins from the bridge:

- Prewarm workspace context on session creation/load.
- Cache model catalog and tool definitions.
- Compress read/search/fetch outputs before sending them back to the model.
- Batch independent read-only tool calls.
- Route file edits through native diff/write UI instead of opaque tool output.
- Stream shell output into native terminal cards.

## Rust Tool Engine Shape

Replacing ACP does not replace the CLI tool engine by itself. The IDE needs a local Rust tool layer that exposes model-callable tool definitions, executes tool calls, and returns JSON-string outputs.

Recommended tool categories:

| Category | Tools | Execution rule |
|---|---|---|
| Read/search | `read_file`, `list_dir`, `glob`, `grep`, `codebase_search`, `read_lints` | Safe to batch in parallel when no mutating tool conflicts. |
| Mutating files | `write`, `edit`, `search_replace`, `delete_file`, `create_directory` | Execute sequentially through native diff/write adapters. |
| Shell | `bash`, `run_terminal_cmd` | Auto-approve conservative read-only commands; bypass approval in Free mode; otherwise request user approval. |
| Flow | `todo_write`, `task`, plan/status updates | Update native plan/progress UI and preserve output order. |
| Optional future | MCP, browser, `web_search`, `web_fetch` | Add after the core chat/edit loop works natively. |

Minimum tool engine contract:

```rust
struct ToolCall {
    id: String,
    name: String,
    arguments: serde_json::Value,
}

struct ToolOutput {
    tool_call_id: String,
    output: String,
}
```

Tool outputs should be ordered to match the incoming tool calls even when execution is parallelized internally.

## Suggested Implementation Sequence

1. Promote `ide/zed/crates/backboard/src/backboard.rs` to the main IDE API client and fill any missing CLI behaviors: API key validation, retry policy, reasoning-aware SSE stall detection, and safer streamed retry boundaries.
2. Add a native Backboard session runner that creates/restores assistant/thread IDs and streams messages without ACP.
3. Add the Rust stream processor and map chunks into the existing chat/thread UI state.
4. Port the bridge's context-pack prewarm and system prompt assembly into Rust.
5. Implement the minimum local Rust tools: file read/list/glob/grep, write/edit/delete/create directory, shell command execution, and todo/plan updates.
6. Add tool batching and output compression.
7. Remove the Python bridge launch path only after the native runner can complete multi-round tool conversations.

## Acceptance Checks

- The native path can create an assistant and thread, send a streamed message, and render assistant text.
- A `tool_submit_required` chunk executes local tools, calls `submit-tool-outputs?stream=true`, and continues the same run.
- Cancelling a turn cancels local tools and calls the run cancel endpoint best-effort.
- The doc/source audit confirms every endpoint in `cli/backboard_cli/api/client.py` is represented above.
- The code clearly separates existing Backboard API routes from Rust-side client abstractions and future Rust tool engine work.
