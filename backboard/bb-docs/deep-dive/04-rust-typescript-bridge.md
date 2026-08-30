# The Rust/TypeScript Bridge (`backboard-bridge`) — RETIRED FROM THE AGENT HOST

> **Status (July 2026): replaced.** The agent-host Backboard provider is now `CliTsAgent`
> (`src/vs/platform/agentHost/node/cliTs/`), which spawns the **cli-ts serve process**
> (`extensions/backboard/bin/backboard-cli-ts --serve`, built from `ide/vscode/cli-ts/`) instead of
> this Rust bridge. cli-ts owns the agent loop and executes its own tools; the IDE renders its
> JSONL `AgentEvent` stream. `backboardAgent.ts` and its test were deleted; shared helpers
> (model mapping, session-config schema, credential resolution) moved to
> `node/cliTs/backboardRuntimeShared.ts`. See `bb-docs/cli-ts-migration/`.
>
> **The bridge is now fully deleted.** The extension webview's transport was migrated to the
> cli-ts serve protocol (its `BackboardBridge` class now spawns `bin/backboard-cli-ts --serve`
> and translates serve records into the panel's legacy event shapes), after which
> `extensions/backboard/rust/`, `bin/backboard-bridge`, and the cargo packaging scripts were
> removed. The description below is retained purely as historical documentation.

The bridge is a **Rust binary built from crates vendored into this repo** at
`extensions/backboard/rust/{backboard_bridge,backboard}` (originally derived from the Zed fork's
crates of the same names — the vscode build has **no dependency on `ide/zed/`**; Zed is a separate,
unused product). The VS Code fork spawned it as a subprocess. It speaks
**newline-delimited JSON (NDJSON) over stdin/stdout** and proxies the Backboard HTTP API, including
SSE streaming and two local Rust tools (`web_search` / `web_fetch`). The VS Code fork (TypeScript) is
the parent/host; the Rust binary is the child. **One request → many events → a `done` terminator.**

Key files:
- TS host: `ide/vscode/src/vs/platform/agentHost/node/backboard/backboardAgent.ts` (~4410 lines)
- TS registry: `ide/vscode/src/vs/platform/agentHost/common/pendingRequestRegistry.ts`
- Rust bridge: `extensions/backboard/rust/backboard_bridge/src/main.rs` (~1373 lines)
- Rust client: `extensions/backboard/rust/backboard/src/backboard.rs` + modular `endpoints/*.rs`

```
┌──────────────────────────── Electron main / Node ────────────────────────────┐
│ backboardAgent.ts                                                            │
│                                                                              │
│  BackboardAgent                       BackboardBridgeProcess (:2148)         │
│  ├─ session registry (:175)           ├─ _resolveBridgePath()  (:2249)       │
│  ├─ sendMessage() (:431)              ├─ _ensureProcess()      (:2225)       │
│  ├─ _handleBridgeEvent() (:912)       │    child_process.spawn(binary)       │
│  └─ pendingToolApprovals /            │    cwd = os.homedir()   stdio=pipes   │
│     pendingClientToolCalls (:188)     ├─ send()  → stdin JSON line (:2169)   │
│                                       ├─ stdout → readline → _handleLine     │
│                                       └─ stderr → log '[Backboard bridge]'   │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  {"requestId","command","sessionId","params"}\n
                ▼
┌────────────── Rust subprocess: backboard-bridge ─────────────────────────────┐
│ main.rs                                                                      │
│  tokio runtime; stdin line → BridgeRequest (:54)                             │
│  dispatch match (:173-255):  9 commands + unknown fallback                   │
│  initialize · listModels · listTools · runTool · sendPrompt ·               │
│  submitToolResult · cancel · getSession · disposeSession                     │
│                                                                              │
│  extensions/backboard/rust/backboard/src/backboard.rs — BackboardClient                 │
│    PROD https://app.backboard.io/api   DEV https://dev.app.backboard.io/api  │
│    LOCAL http://localhost:8000  (config.rs:10-12)                            │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTPS + SSE (reqwest)
                ▼
        Backboard API (FastAPI) → LLM providers
```

## Binary resolution & lifecycle

`_resolveBridgePath()` (`backboardAgent.ts:2249`) resolves the binary in order:

1. `process.env.BACKBOARD_BRIDGE_PATH`, then `VSCODE_BACKBOARD_BRIDGE_PATH` — used verbatim if set.
2. Otherwise the first existing of (relative to `appRoot` and `process.cwd()`):
   - `<root>/extensions/backboard/bin/backboard-bridge` — the **shipped** location
   - `<root>/extensions/backboard/rust/target/debug/backboard-bridge` — dev builds
3. If none exist, falls back to the appRoot debug-target path (`candidates[1]`, `:2262`).
   Executable name is `backboard-bridge.exe` on win32 else `backboard-bridge` (`:2250`).

`_ensureProcess(sessionId)` (`:2225`): reuses the live child; if the binary is missing on disk it
throws a build-hint error; otherwise `spawn(binary, [], { cwd: os.homedir(), stdio: ['pipe','pipe','pipe'] })`
(`:2233`). stdout is wrapped in `readline` → `_handleLine` (`:2236`); stderr chunks are logged as
`[Backboard bridge] …`. On `exit`, all pending requests are rejected with `Backboard bridge exited.`
(`:2238`). `dispose()` (`:2159`) kills the child and rejects all pending with `Backboard bridge
disposed.`.

Build: `npm --prefix extensions/backboard run build-bridge` → `cargo build`; the binary is packaged
into the extension (`files: ["bin/**", …]`).

## Wire protocol

**Request (TS → Rust)** — `send()` (`:2169`) writes one JSON object per line to stdin:

```
child.stdin.write(`${JSON.stringify({ requestId, command, sessionId, params })}\n`)   // :2175
```

`requestId = generateUuid()` correlates the request. If an `onEvent` callback is passed, it is
streaming mode (`events` accumulator undefined, resolve value `[doneEvent]`); otherwise events
accumulate into an array. Rust deserializes into `BridgeRequest { request_id, command, session_id,
params }` (`#[serde(rename_all="camelCase")]`, `main.rs:54`). Invalid JSON → a standalone `error`
event with null ids (`main.rs:156`).

**Event (Rust → TS)** — `_handleLine()` (`:2265`) parses each stdout line as a `BridgeEvent`,
correlates by `event.requestId`, calls `pending.onEvent?.(event)`, and — on **`type === 'done'`** —
deletes the pending entry and resolves. Every Rust event carries `type`, `bridgeProtocolVersion`
(=`1`), `requestId`, nullable `sessionId`, plus command-specific fields (`base_event()`,
`main.rs:1183`). The `BridgeEvent` TS interface is at `backboardAgent.ts:71-96`.

`cancel` is fire-and-forget: a *new* `requestId`, command `cancel`, params `{ requestId:
<id-to-cancel> }` (`:2179`) — not awaited.

## Commands — the actual dispatch table

The Rust dispatch is a single `match request.command.as_str()` (`main.rs:173-255`). **There are 9
recognized commands plus an unknown-command fallback** — not the "~25 API proxy commands" a prior
draft claimed.

| TS command | TS call site | Rust arm | Handler | Purpose | Response events |
|---|---|---|---|---|---|
| `initialize` | bridge init | :175 | inline | handshake / protocol version | `initialized` |
| `listModels` | :1400 | :183 | `list_models` :258 | LLM model catalog | `models` → `done{end_turn}` |
| `listTools` | `_fetchTools` :2221 | :198 | `list_tools` :340 | tool schemas for a mode | `tools` → `done{end_turn}` |
| `runTool` | `runTool()` :2184 | :199 | `run_tool` :360 | run a **Rust-native** tool (web_search/web_fetch) | `toolFinished{started}` → `toolFinished{finished}` → `done` |
| `sendPrompt` | `sendMessage` :507 | :214 | `send_prompt` :392 | start an agentic turn (opens SSE) | streaming events → terminal `done` |
| `submitToolResult` | turn loop :540 | :229 | `submit_tool_result` :458 | POST tool outputs, continue run | streaming events → terminal `done` |
| `cancel` | `cancel()` :2180 | :244 | `cancel_request` :649 | set session cancel flag | `done{cancelled}` |
| `getSession` | (unused by TS) | :245 | `get_session` :661 | session binding snapshot | session + `done` |
| `disposeSession` | (unused by TS) | :246 | `dispose_session` :688 | drop server-side session state | `done` |
| *unknown* | — | :247 | `emit_error` | `unknown bridge command` | `error` → `done{error}` |

> ⚠️ **Known gap (verified):** TS `callApi()` (`:2189`) sends **`sendMessage`**,
> **`uploadThreadDocument`**, **`getDocumentStatus`** as bridge commands expecting an `apiResponse`
> event, but **none of these have dispatch arms in the current `main.rs`** — they hit the
> unknown-command arm and return `error`/`done`, so `callApi` resolves `undefined`. The underlying
> `BackboardClient` CRUD methods *exist* in `endpoints/*.rs` but are **not wired into the bridge
> dispatch**. The bridge here proxies only the streaming chat/tool path, not document/assistant CRUD.

## `SendPromptParams` (verbatim, `main.rs:76-106`)

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendPromptParams {
    content: String,
    #[serde(default)] workspace: Option<PathBuf>,
    #[serde(default)] provider: Option<String>,
    #[serde(default)] model: Option<String>,
    #[serde(default)] mode: Option<String>,           // free | ask | manual (tool access)
    #[serde(default)] intensity: Option<String>,      // fast | medium | deep (reasoning effort)
    #[serde(default)] web_search: Option<String>,
    #[serde(default)] image_generation: Option<String>,
    #[serde(default)] voice_mode: Option<String>,
    #[serde(default)] mcp_calls: Option<Value>,
    #[serde(default)] thread_id: Option<String>,      // resume an existing backend thread
    #[serde(default)] assistant_id: Option<String>,
    #[serde(default)] max_tokens: Option<u32>,
    #[serde(default)] config: Option<ConfigParams>,   // env / api_url / api_key overrides
}
```

> Note the current struct has **`mcp_calls`** and **no `files` / `tools` / `audio_file` /
> `image_file`** fields (unlike a prior draft). The `tools` array the TS side sends in `sendPrompt`
> is **ignored** — the bridge recomputes tools server-side via `tool_definitions(&mode)`
> (`main.rs:434`). For `submitToolResult`, TS-sent `tools` **is** honored
> (`SubmitToolResultParams.tools`, `:115`).

`send_prompt` defaults (`main.rs:398-406`): provider `aws-bedrock`, model
`anthropic.claude-sonnet-4-6`, mode `free`, intensity `fast`, voice_mode `off`. It resolves
`thread_id`/`assistant_id` from params or cached session state, prepends a workspace/mode preamble
(`augment_prompt`, `:730`), builds `SendMessageRequest`, then `client.send_message_stream(...)` +
`consume_stream(...)`.

### Tool-access modes → blocked tools

TS access modes: `BACKBOARD_ACCESS_DEFAULT='default'`, `_MANUAL='manual'`, `_FULL='fullAccess'`
(`:63-65`), mapped to bridge `mode` `manual`/`free` (`:2854`). Rust `blocked_tools()` (`main.rs:780`)
gates by mode:

```
 ask     → block ALL writes/exec/read_lints                    (main.rs:782)
 manual  → block bash/terminal/run_code/repl/computer/task/read_lints (:800)
 free    → block nothing                                        (:809)
```

## Streaming events

`consume_stream()` (`main.rs:491`) reads SSE JSON chunks and maps each `chunk["type"]` to a bridge
event. **Before** the match, `tool_calls_required_by_chunk()` short-circuits a tool-call chunk to
`toolRequested` + `done{requires_tool_result}` (`:514-536`).

```
 SSE chunk type                              → bridge event                        (main.rs)
 ───────────────────────────────────────────────────────────────────────────────────────────
 (tool_calls present)                        → toolRequested{runId,threadId,toolCalls}
                                               → done{requires_tool_result}          :519
 run_started                                 → progress "Connected to model." (+run_id) :539
 reasoning_started                           → progress "Planning next step."         :549
 reasoning_streaming | reasoning_delta       → reasoningDelta{text}                    :557
 content_streaming | stt_text_delta          → assistantTextDelta{text}               :567
 media_generated                             → media{chunk}                           :577
 tts_audio_delta | tts_stream_end | stt_stream_end → voice{chunk}                     :585
 run_ended                                   → usage{usage} → done{end_turn}          :593
 run_failed | error                          → error{message} → done{error}           :608
 retry                                       → progress "Retrying Backboard request." :628
 (thread/assistant binding on any chunk)     → sessionBinding{threadId,assistantId}   :1091
 _                                           → ignored                                :636
```

Terminal `stopReason` values: `end_turn`, `requires_tool_result`, `error`, `cancelled`.

**TS-side text hygiene:** `visibleAssistantTextDelta()` (`:2296`) cuts assistant text at the first
`[Called <tool> with parameters:` marker so raw tool transcripts don't leak into chat. Duplicate
tool requests are suppressed via `toolResultRequestKey()` = `threadId:runId:toolCallIds` +
`seenToolRequests` (`:967`); duplicate submissions are tolerated by
`isRecoverableToolOutputSubmissionError()` (`:2358`).

## Request correlation & the turn loop (TS)

`sendMessage()` (`:431-580`):

1. `_materialize(session)` (`:707`) fires `onDidMaterializeSession` once.
2. `_bridge.listTools(mode)` (cached, 5-min TTL) merged with client tools.
3. `_bridge.send('sendPrompt', …, event => _handleBridgeEvent(...))` (`:507`); `await handle.promise`
   (resolves on `done`); drain `firstToolRequests`.
4. **Turn loop** (`:527-560`): for each tool request → `_executeToolCalls` → `_bridge.send(
   'submitToolResult', …, { threadId, runId, toolOutputs, tools, … })` (`:540`) → await → collect the
   next tool requests. Repeat until none remain.
5. `finally` (`:573`): flush text, `writeSharedBackboardThread`, fire `ChatTurnComplete`.

Tool execution parallelism, approval registries, and the client-tool round-trip are documented in
[05-tool-calls.md](05-tool-calls.md). The full SSE grammar end-to-end is in
[09-streaming-sse-protocol.md](09-streaming-sse-protocol.md).

## Rust client `BackboardClient`

Base URLs & env (`endpoints/config.rs:10-12`): `PROD=https://app.backboard.io/api`,
`DEV=https://dev.app.backboard.io/api`, `LOCAL=http://localhost:8000`. `base_url()`
(`backboard.rs:251`): explicit `api_url` wins; else by env (`prod`/`production`→prod, `local`→local,
else→dev; default env `prod`). API key resolution (`:263`): `api_key` field → `env_keys[env]` →
`std::env::var("BACKBOARD_API_KEY")`. HTTP: reqwest, pool idle 60s, connect timeout 30s.

**Config file:** `~/.backboard_ide/config.json` (`config.rs:170`, matching TS `backboardConfigPath()`
`:2903`) — shape `{ env, api_key, api_url, env_keys: {env→key} }`, atomic save with `.json.bak`
backup. The bridge merges TS-supplied `ConfigParams` (env/api_url/api_key) over the loaded config in
`client_from_params()` (`main.rs:702`).

Endpoint modules (`endpoints/mod.rs`):

| Module | Covers |
|---|---|
| `client.rs` / `config.rs` | `BackboardClient` ctor, base URLs, config load/save |
| `stream.rs` | SSE parsing (`sse_json_stream`), retry engine, `message_form` multipart builder |
| `threads.rs` | `create_thread`, `get_thread`, `list_threads`, `send_message` / `send_message_stream` |
| `tools.rs` | `submit_tool_outputs` / `submit_tool_outputs_stream` |
| `assistants.rs` | `create_assistant`, `update_assistant`, `get_assistant`, `list_assistants` |
| `models.rs` | `list_models` (paginated 100/page), `list_providers` |
| `documents.rs` | `upload_document(assistant_id, file_path)` |
| `memories.rs` | `list_memories`, `add_memory` |
| `billing.rs` | `get_recent_usage` |
| `routes.rs` | URL path builders (e.g. `.../submit-tool-outputs?stream=true`) |
| `types.rs` | `SendMessageRequest`, `SubmitToolOutputsRequest`, etc. |

Only the streaming subset (`send_message_stream`, `submit_tool_outputs_stream`, `list_models`,
`list_providers`) is actually reachable through the bridge dispatch; the CRUD methods exist but are
unused by `main.rs` (see the "Known gap" above).

## Session state & persistence

TS `BackboardSession` (`:175`): `threadId`, `materialized`, `pendingClientToolCalls` /
`pendingToolApprovals` registries (`:188`), `currentRequestId`, `clientTools`, `workingDirectory`.
Created provisional (`materialized:false`, `:414`) and materialized on first message. Rust
`SessionState` (`main.rs:47`): `{ thread_id, assistant_id, current_run_id, cancel_flag:
Arc<AtomicBool> }`; `thread_id`/`assistant_id` learned from stream chunks (`record_binding`, `:1091`)
and echoed to TS via `sessionBinding`; `run_id` reused by `submitToolResult`.

Persistence, all under **`~/.backboard_ide/`**:
- `config.json` — credentials (TS `:2903`, Rust `config.rs:170`)
- `panel-state.json` — panel history index (TS `:2084`)
- `threads/<workspace>/<session-id>/thread.json` — per-thread transcripts (`writeSharedBackboardThread`, `:1854`)
- model cache (`_modelCachePath()`, `:1424`, version-gated `BACKBOARD_MODEL_CACHE_VERSION=2`)

## Error handling & resilience

- **SSE retry** lives in the client layer (`endpoints/stream.rs`): `retrying_sse_json_stream`
  reconnects up to `STREAM_MAX_RETRIES = 5` with exponential backoff (base 2s), **only** when nothing
  has streamed yet (`streamed_any` guard) and the error is transient (timeout/connect, or status ∈
  {502,503,504,429}). Each retry surfaces a `retry` chunk → mapped to `progress`.
- **Cancellation:** per-chunk `session_cancel_flag(...).load(SeqCst)` check at the top of
  `consume_stream` → `done{cancelled}` (`:498`); the flag is set by the `cancel` arm (`:649`).
- **Duplicate tool-output suppression** (Rust, `main.rs:1221`): key of
  session+thread+run+sorted-tool-ids guards in-flight and already-submitted sets; stale "No assistant
  message found requiring action" errors are swallowed.
- **TS resilience:** `isRecoverableToolOutputSubmissionError` (`:2358`) swallows double-submit races;
  `backboardDisplayErrorMessage` (`:2366`) rewrites auth/idle-timeout errors with hints.
- **Observability:** a heartbeat (`setHeartbeat`, `:459`) logs `[Backboard latency] <phase>` every 5s
  and emits a visible progress line after 15s; explicit `elapsedMs` traces at `list_tools_done`,
  `send_prompt_done`, `submit_tool_result_done`, etc.
