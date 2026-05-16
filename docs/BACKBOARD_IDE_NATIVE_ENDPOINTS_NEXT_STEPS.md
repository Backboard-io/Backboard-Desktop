# Backboard IDE Native Endpoints Next Steps

This document explains what the IDE does today, what the new Rust endpoint folder currently provides, and how to move from "IDE relies on the CLI through a Python ACP bridge" to "IDE talks to Backboard directly through native Rust code."

The current runtime must remain unchanged until the native path reaches parity. The Python bridge still exists and is still the active chat path.

## Current State

The live IDE chat flow is:

```text
Zed Rust agent server
  -> launches ide/zed/script/backboard-ide-acp.py
  -> Python bridge imports cli/backboard_cli
  -> CLI BackboardAPIClient calls Backboard HTTP API
  -> Python bridge executes CLI tools locally
  -> Python bridge sends ACP updates back to Zed
  -> Zed renders messages, tool cards, diffs, terminal output, usage, and cost
```

Current source-of-truth files:

- [`ide/zed/crates/agent_servers/src/backboard.rs`](../zed/crates/agent_servers/src/backboard.rs): still launches the Python ACP bridge.
- [`ide/zed/script/backboard-ide-acp.py`](../zed/script/backboard-ide-acp.py): current IDE runtime bridge, prompt prep, tool execution adapter, and ACP event emitter.
- [`cli/backboard_cli/api/client.py`](../../cli/backboard_cli/api/client.py): current HTTP API behavior used by both CLI chat and the IDE bridge.
- [`cli/backboard_cli/tools/`](../../cli/backboard_cli/tools): current local tool engine used by the bridge.
- [`ide/zed/crates/backboard/src/endpoints/`](../zed/crates/backboard/src/endpoints): new Rust endpoint modules, currently scaffolded and compile-checked, but not yet wired into the live agent runtime.

Important: the new Rust endpoint folder does not change behavior by itself. It prepares the direct Rust client layer, while the active IDE agent still uses Python plus CLI.

## What The Python Bridge Calls Today

The Python ACP bridge actively uses this Backboard API subset:

| Purpose | Route | Rust endpoint module |
|---|---|---|
| Model catalog | `GET /models` | `endpoints/models.rs` |
| Create assistant | `POST /assistants` | `endpoints/assistants.rs` |
| Create thread | `POST /assistants/{assistant_id}/threads` | `endpoints/threads.rs` |
| Replay thread history | `GET /threads/{thread_id}` | `endpoints/threads.rs` |
| Send streamed message | `POST /threads/{thread_id}/messages` | `endpoints/threads.rs` |
| Submit streamed tool outputs | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` | `endpoints/tools.rs` |
| Cancel run | `POST /threads/{thread_id}/runs/{run_id}/cancel` | `endpoints/threads.rs` |

The Rust route inventory lives in [`routes.rs`](../zed/crates/backboard/src/endpoints/routes.rs). It also includes extra routes that existed in the Rust/CLI client surface already: provider catalog, memories, documents, recent billing usage, list threads, and non-streaming helpers.

## Target Architecture

The end state should be:

```text
Zed Rust UI/runtime
  -> native Backboard session runner
  -> ide/zed/crates/backboard Rust endpoint client
  -> Backboard HTTP API
  -> native Rust tool engine
  -> direct Zed chat/thread state updates
```

This target removes two dependencies from the IDE chat path:

- No Python process for chat runtime.
- No import of `cli/backboard_cli` for API calls or local tool execution.

The backend API does not need new routes for v1. The IDE should call the existing Backboard API routes through the Rust endpoint modules.

## Migration Plan

### 1. Harden The Rust Endpoint Client

Bring `ide/zed/crates/backboard/src/endpoints` to full parity with the Python client before wiring it into the live IDE agent.

Required work:

- Add API key validation for `GET /assistants?limit=1`.
- Match the Python client's streamed retry rule: retry transient errors only before the first SSE chunk; never retry after streaming starts.
- Add reasoning-aware SSE keepalive/stall handling.
- Preserve form encoding for `POST /threads/{thread_id}/messages`.
- Preserve JSON-string tool outputs for submit-tool-outputs.
- Keep unknown SSE chunks as `serde_json::Value` so provider-specific payload changes do not break the IDE.

Acceptance checks:

- `cargo check -p backboard`
- Unit tests for route construction.
- Unit tests for message form encoding.
- Unit tests for SSE `data:` parsing, `[DONE]`, comments, partial chunks, and unknown chunk passthrough.

### 2. Add A Native Session Runner Behind A Flag

Create a Rust session runner that can perform one Backboard chat turn without launching Python, but keep it disabled by default.

Recommended location:

```text
ide/zed/crates/agent_servers/src/backboard_native.rs
```

Responsibilities:

- Load Backboard config and model selection.
- Create or restore assistant/thread IDs.
- Build the same system prompt and context pack the Python bridge builds today.
- Call `BackboardClient::send_message_stream`.
- Track `run_id`, thinking state, usage, and cancellation.
- Convert streamed chunks into native message/progress/tool events.

Recommended guard:

```text
BACKBOARD_NATIVE_ENDPOINTS=1
```

Default behavior must remain the Python bridge until the native runner passes parity checks.

### 3. Reuse Existing UI State First, Then Remove ACP Concepts Later

The current Zed chat UI already knows how to render assistant text, tool calls, diffs, terminal cards, usage, cost, and progress through the existing thread model.

Migration should be two steps:

- First: bypass the external Python ACP process but emit equivalent Rust-side updates into the existing chat/thread state.
- Later: remove ACP-specific naming and protocol assumptions if the UI no longer needs them.

This avoids doing the API migration, tool-engine migration, and chat UI rewrite all at once.

### 4. Port The IDE-Specific Prompt And Context Layer

The Python bridge is fast partly because it prewarms and compresses context. The native Rust path needs the same behavior before it replaces the bridge.

Port these behaviors:

- Workspace context prewarm on session creation/load.
- Tool definition cache.
- Model catalog cache.
- Fast/default thinking behavior.
- Website/app quality prompt additions.
- Read/search output compression before tool results go back to the model.
- Speed timing buckets for total turn, context pack, model wait, tool batch, shell, edit, read, and search.

Acceptance check:

- A native Rust turn should not require more exploratory tool calls than the bridge for the same prompt.

### 5. Build The Native Rust Tool Engine

Replacing the endpoint client does not replace the CLI tool system. The IDE needs local Rust tool execution before it can fully stop relying on `cli/backboard_cli`.

Minimum v1 tools:

| Tool group | Required behavior |
|---|---|
| Read/search | `read_file`, `list_dir`, `glob`, `grep`, `read_lints`; safe to batch in parallel. |
| File mutation | `write`, `edit`, `search_replace`, `delete_file`, `create_directory`; route through native diff/write UI. |
| Shell | `bash`, `run_terminal_cmd`; read-only auto-approval, Free mode bypass, approval for risky commands. |
| Flow | `todo_write` and plan/progress updates. |

Defer MCP, browser tools, semantic `codebase_search`, `web_search`, and `web_fetch` until the core file/edit/shell loop works.

Tool outputs must preserve the API contract:

```json
{
  "tool_call_id": "call_id_from_server",
  "output": "{\"success\":true,\"content\":\"...\"}"
}
```

### 6. Add A/B Parity Testing

Before switching defaults, run the same prompts through both paths:

- Current Python bridge path.
- Native Rust endpoint path behind `BACKBOARD_NATIVE_ENDPOINTS=1`.

Compare:

- Assistant/thread creation.
- Streamed text.
- Tool call handling.
- Multi-round tool continuation.
- File diffs.
- Shell output.
- Cancellation.
- Usage/cost display.
- Chat history replay.
- Failure behavior for bad API key, bad model, network interruption, and tool failure.

### 7. Switch Default Only After Parity

Once the native path passes parity:

- Flip default agent runtime to the Rust native runner.
- Keep Python bridge fallback behind an env var for one release.
- Log which runtime is active in diagnostics.
- Remove packaged Python/CLI dependency only after the fallback window is no longer needed.

## Do Not Break These While Migrating

- `ide/zed/script/backboard-ide-acp.py` must remain present until the native path is the default and fallback is no longer needed.
- `BackboardAgentServer::connect` should keep launching Python unless the native feature flag is explicitly enabled.
- The API wire contract must not change: same routes, same auth header, same form fields, same SSE shape, same tool output payload.
- Tool output order must match incoming tool call order even if read-only tools execute in parallel.
- Do not retry streamed message or tool-output POSTs after the first SSE chunk has been yielded.

## Practical Next PRs

Recommended PR order:

1. Add endpoint client parity tests for routes, form encoding, and SSE parsing.
2. Add retry/keepalive parity to the Rust endpoint client.
3. Add `backboard_native.rs` session runner behind `BACKBOARD_NATIVE_ENDPOINTS=1`.
4. Stream assistant text and run cancellation through the native path.
5. Add native read/search tools.
6. Add native file mutation tools with diff cards.
7. Add native shell tools with terminal cards and approvals.
8. Add parity harness comparing Python bridge and Rust native runs.
9. Flip the default runtime after parity.

The safe mental model: first make Rust able to talk to Backboard exactly like the Python client, then make Rust able to execute local tools exactly like the CLI, and only then remove the Python bridge from the default IDE path.
