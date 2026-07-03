# Backboard API System Walkthrough

How the Rust bridge and the TypeScript hosts in this repo talk to each other and
to the Backboard HTTP API. Everything referenced here lives inside `ide/vscode`
(this repo) — there is no external Rust/Zed repo involved; the Rust source is
vendored at `extensions/backboard/rust/`.

> Internal engineering reference, verified against live source. A pre-existing,
> more exhaustive snapshot-based version of this material also lives at
> [`backboard-reference/docs/TOOL_CALLS_AND_API.md`](backboard-reference/docs/TOOL_CALLS_AND_API.md)
> (documents a copy under `backboard-reference/source-copies/`). This document
> was cross-checked against the live files directly and the two are in
> agreement as of this writing.

## 1. The three integration points

There are three places in this repo that touch Backboard, all built on the same
Rust bridge binary:

| Component | Path | Role |
|---|---|---|
| Rust bridge process | `extensions/backboard/rust/backboard_bridge/src/main.rs` | Child process; owns prompt construction, tool schemas, HTTP calls to Backboard |
| Rust API client crate | `extensions/backboard/rust/backboard/src/endpoints/*.rs` | HTTP client library the bridge is built on |
| Standalone VS Code extension | `extensions/backboard/src/backboardExtension.ts` (+ `panel/*.ts`) | Spawns the bridge, renders the Backboard webview panel, executes most tools |
| Workbench agent-host adapter | `src/vs/platform/agentHost/node/backboard/backboardAgent.ts` | Wires Backboard into the built-in chat/agent-sessions UI; spawns the **same** bridge binary independently |

The workbench agent-host does **not** duplicate the extension's tool-execution
logic and does not share a running process with it — it spawns its own copy of
the bridge binary and drives it the same way the extension does.

## 2. One-screen mental model

```text
User prompt
  -> TypeScript host (extension OR agent-host)
  -> Rust bridge JSON command: sendPrompt
  -> Rust augments prompt with system prompt + runtime context + tool schemas
  -> Rust HTTP POSTs to Backboard message API with stream=true
  -> Backboard streams text or tool-call requests (SSE)
  -> Rust converts SSE chunks into bridge events
  -> TypeScript renders text or runs local tools
  -> TypeScript sends Rust bridge JSON command: submitToolResult
  -> Rust HTTP POSTs tool outputs back to Backboard
  -> Backboard continues streaming
```

## 3. Bridge protocol (TypeScript ↔ Rust)

The Rust bridge is a child process. TypeScript writes a JSON object + `\n` to
its stdin; Rust writes JSON events + `\n` to its stdout. Both hosts talk to it
identically.

**Request envelope:**

```json
{
  "requestId": "uuid",
  "command": "sendPrompt",
  "sessionId": "sandbox:session-or-panel-id",
  "params": {}
}
```

**Event envelope**, terminated by a `done` event:

```json
{ "type": "assistantTextDelta", "bridgeProtocolVersion": 1, "requestId": "...", "sessionId": "..." }
...
{ "type": "done", "requestId": "...", "sessionId": "...", "stopReason": "end_turn" }
```

### 3.1 Bridge commands

Dispatched in `handle_request` (`main.rs:337`):

| Command | Purpose | Rust entry point |
|---|---|---|
| `initialize` | Handshake, returns bridge protocol version | `main.rs:340` |
| `listModels` | Fetch model list from Backboard, emit `models` | `main.rs:347` |
| `listTools` | Return tool schemas for the current mode | `main.rs:362` |
| `runTool` | Run the small set of Rust-owned tools | `main.rs:363` |
| `sendPrompt` | Send a user prompt, stream the response | `main.rs:378` (`send_prompt`, `main.rs:834-1007`) |
| `submitToolResult` | Submit local tool outputs, stream continuation | `main.rs:393` |
| `cancel` | Cancel the current request/session flag | `main.rs:408` |
| `getSession` | Return bridge session binding state | `main.rs:409` |
| `disposeSession` | Remove bridge session state | `main.rs:410` |
| *(API passthrough)* | Direct HTTP wrapper calls (§5) | `main.rs:411`, via `is_api_command`/`call_api_endpoint` |

### 3.2 Prompt construction

The system prompt is embedded into the binary at compile time
(`main.rs:44`):

```rust
const BACKBOARD_SYSTEM_PROMPT: &str =
    include_str!("backboard_runtime_system_prompt.md");
```

`augment_prompt` (`main.rs:1797-1836`) wraps the user's message before it's
sent:

```text
<Backboard runtime system prompt>            (conditional, system_prompt_for_request)
<HTTP endpoint reference>                    (conditional, should_include_http_endpoint_reference)

## Runtime Context
- Target workspace root: <workspace path>
- Current Backboard mode for this turn: <ask | manual | free | ...>
- Available tools for this turn: <comma-separated names>

## User Request
<user content>
```

The tool schema list itself is sent separately in the request's `tools` field,
not inlined into the prompt text.

### 3.3 `sendPrompt` → HTTP

TypeScript sends `sendPrompt` with fields like `content`, `workspace`,
`provider`, `model`, `mode`, `intensity`, `memoryMode`, `webSearch`,
`mcpCalls`, and a `config` block (`env`, `api_url`, `access_token`). Rust
turns this into a `SendMessageRequest`
(`extensions/backboard/rust/backboard/src/endpoints/types.rs:25`):

```rust
pub struct SendMessageRequest {
    pub content: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub memory: String,        // default "off"
    pub thinking: Option<Value>,
    pub tools: Option<Vec<Value>>,
    pub web_search: String,
    pub mcp_calls: Option<Value>,
    pub max_tokens: Option<u32>,
}
```

...and calls `BackboardClient::send_message_stream`.

### 3.4 Bridge events emitted while streaming

`send_prompt` / `consume_stream` (`main.rs:834-1007`, `main.rs:1287-1565`)
map Backboard SSE chunks to these bridge event types:

| Event | Meaning |
|---|---|
| `progress` | Human-readable status |
| `assistantTextDelta` | Visible assistant text |
| `reasoningDelta` | Reasoning/planning stream |
| `toolCallStreaming` | Incremental tool-call arguments while streaming |
| `media` | Image/media generation payload |
| `voice` | STT/TTS payload |
| `usage` | Token/cost/usage payload |
| `sessionBinding` | Thread/run/assistant binding state |
| `toolRequested` | Model requested local tool execution (emitted via `emit_tool_requested_events`) |
| `error` | Backboard or bridge error |
| `done` | Request complete, carries `stopReason` |

Example tool request:

```json
{
  "type": "toolRequested",
  "requestId": "b6c7...",
  "sessionId": "sandbox:123",
  "runId": "run_abc",
  "threadId": "thread_xyz",
  "toolCalls": [
    { "id": "call_1", "type": "function",
      "function": { "name": "grep", "arguments": "{\"pattern\":\"BackboardClient\"}" } }
  ]
}
```

## 4. Tool system

### 4.1 Schema + current tool list

Tool schemas are generated in Rust (`all_tool_definitions`, `main.rs:2022-2053`)
in OpenAI function-tool shape. Current full list:

```text
bash, run_terminal_cmd, read_file, write, write_file, create_file,
overwrite_file, append_file, edit, edit_file, search_replace, glob, grep,
codebase_search, list_dir, delete_file, create_directory, web_search,
web_fetch, generate_image, read_lints, enter_plan_mode, exit_plan_mode,
persistence_decide, sleep, repl, run_code, computer
```

### 4.2 Mode-based filtering (`main.rs:1976-2020`)

- **`ask` mode** blocks: `write`, `write_file`, `create_file`, `overwrite_file`,
  `edit`, `edit_file`, `search_replace`, `delete_file`, `create_directory`,
  `bash`, `run_terminal_cmd`, `run_code`, `repl`, `computer`, `task`,
  `read_lints`.
- **`manual` mode** blocks the execution/automation subset: `bash`,
  `run_terminal_cmd`, `run_code`, `repl`, `computer`, `task`, `read_lints`.
- **`free`** and other modes expose the full list (aside from image-tool
  hiding, below).
- When Backboard's built-in image generation is enabled for a turn, Rust hides
  `generate_image`/`image_generate` so Backboard's own image path can emit
  `media` events instead.

### 4.3 Execution split

Most tools run in TypeScript; a few run in Rust. Dispatch on the TS side is
`executeTool` in `extensions/backboard/src/backboardExtension.ts:2825-2882`:

| Tool(s) | Executed by |
|---|---|
| `read_file`, `list_dir`, `glob`, `grep`, `codebase_search` | TypeScript (local implementation) |
| `write`, `write_file`, `create_file`, `overwrite_file` | TypeScript (`writeFileTool`) |
| `append_file` | TypeScript (`appendFileTool`) |
| `edit`, `edit_file`, `search_replace` | TypeScript (`editFileTool`) |
| `delete_file` | TypeScript (`deleteFileTool`) |
| `create_directory` | TypeScript (`createDirectoryTool`) |
| `bash`, `run_terminal_cmd` | TypeScript (`runShellTool`) |
| `run_code`, `repl` | TypeScript (`runCodeTool`) |
| `read_lints` | TypeScript (diagnostics/shell) |
| `todo_write`, `sleep`, `task`, `enter_plan_mode`, `exit_plan_mode`, `persistence_decide` | TypeScript (stub/compatibility responses) |
| `web_search`, `web_fetch`, `computer` | Rust, via `runRustTool` → bridge `runTool` command |
| `generate_image`/`image_generate` | Backboard API/runtime (acknowledgment on the TS side; hidden from the tool list when API image generation is active) |

Parsing an incoming tool call is done by `parseToolCall`
(`backboardExtension.ts:3336-3350`), which tolerates several shapes:

```json
{ "id": "call_1", "name": "read_file", "args": { "path": "src/foo.ts", "offset": 1, "limit": 80 } }
```

`id` is pulled from any of `id | tool_call_id | toolCallId | call_id | callId`;
name from `function.name | name | tool_name | toolName`; args from
`arguments | args | parameters | input` (root or under `function`).

### 4.4 Submitting tool outputs back to Backboard

TypeScript sends `submitToolResult` to the bridge:

```json
{
  "requestId": "c8d9...",
  "command": "submitToolResult",
  "sessionId": "sandbox:123",
  "params": {
    "threadId": "thread_xyz",
    "runId": "run_abc",
    "toolOutputs": [{ "tool_call_id": "call_1", "output": "{\"success\":true,\"content\":\"...\"}" }],
    "tools": [ { "type": "function", "function": { "name": "read_file" } } ],
    "config": { "env": "prod" }
  }
}
```

Rust normalizes output keys, de-duplicates repeated submissions, then calls:

```text
POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true
X-API-Key: <api key>
Content-Type: application/json
```

with body `{"tool_outputs": [...], "tools": [...]}`. Backboard then streams a
continuation through the same SSE parser.

## 5. Rust HTTP client (`extensions/backboard/rust/backboard/src/endpoints/`)

### 5.1 Config & auth (`config.rs`)

```text
~/.backboard_ide/config.json
```

Base URL resolution (`config.rs:114-124`):

| Env | Base URL |
|---|---|
| `prod` / `production` | `https://app.backboard.io/api` |
| `local` | `http://localhost:8000` |
| default / any other value (dev) | `https://dev.app.backboard.io/api` |

API key resolution precedence: config file, then `BACKBOARD_API_KEY` env var
(`config.rs:126-140`). All requests carry `X-API-Key: <api key>`.

### 5.2 Client (`client.rs`)

```rust
pub struct BackboardClient {
    client: Client,      // reqwest
    base_url: String,
    api_key: String,
}
```

`json_headers()` (`client.rs:48`) builds `X-API-Key` + `Content-Type:
application/json`; `api_key_header()` (`client.rs:58`) validates the key as a
header value.

### 5.3 Message send form fields (`stream.rs:13`, `message_form`)

`POST /threads/{thread_id}/messages` is sent as
`application/x-www-form-urlencoded`, not JSON:

| Field | Source |
|---|---|
| `content` | Augmented prompt |
| `stream` | `"true"` for streaming |
| `memory` | `Auto`, `Readonly`, or off |
| `web_search` | Backboard web search mode |
| `llm_provider` | Selected provider (conditional) |
| `model_name` | Selected model (conditional) |
| `max_tokens` | Optional cap (conditional) |
| `thinking` | Provider-specific reasoning payload JSON (conditional) |
| `tools` | JSON string of tool definitions (conditional) |

### 5.4 Streaming + retry (`stream.rs`)

```rust
const STREAM_MAX_RETRIES: u32 = 5;
const STREAM_RETRY_BASE_DELAY: Duration = Duration::from_secs(2);
```

`sse_json_stream` (`stream.rs:41`) parses `data: {json}` lines, skipping
`[DONE]`/empty lines. `retrying_sse_json_stream` (`stream.rs:93`) wraps it
with exponential backoff (`2^attempt * base_delay`), retrying on HTTP
429/502/503/504 and transient network errors (timeout/connect/request/body).

### 5.5 Route table (`routes.rs`)

```rust
pub const ASSISTANTS: &str = "/assistants";
pub const THREADS: &str = "/threads";
pub const MODELS: &str = "/models";
pub const MODEL_PROVIDERS: &str = "/models/providers";
pub const RECENT_USAGE: &str = "/billing/usage/recent";
// plus builders: assistant(id), assistant_threads(id), thread(id),
// thread_messages(id), run_submit_tool_outputs(thread_id, run_id), ...
```

## 6. API passthrough (direct HTTP calls, bypassing prompt/stream logic)

Beyond `sendPrompt`, the bridge accepts direct API commands (`is_api_command`,
`main.rs:604-636`; dispatch in `call_api_endpoint`, `main.rs:638-780`). The
TypeScript side calls these via `callApi()`.

| Bridge command | Rust wrapper | HTTP route |
|---|---|---|
| `createAssistant` | `create_assistant_value` | `POST /assistants` |
| `listAssistants` | `list_assistants` | `GET /assistants` |
| `getAssistant` | `get_assistant` | `GET /assistants/{assistant_id}` |
| `updateAssistant` | `update_assistant_value` | `PUT /assistants/{assistant_id}` |
| `deleteAssistant` | `delete_assistant` | `DELETE /assistants/{assistant_id}` |
| `createAssistantThread` | `create_thread` | `POST /assistants/{assistant_id}/threads` |
| `listAssistantThreads` | `list_threads(Some)` | `GET /assistants/{assistant_id}/threads` |
| `listAssistantDocuments` | `list_assistant_documents` | `GET /assistants/{assistant_id}/documents` |
| `uploadAssistantDocument` | `upload_document` | `POST /assistants/{assistant_id}/documents` |
| `sendMessage` | `send_message_value` | message API wrapper |
| `submitToolOutputsSimple` | `submit_tool_outputs_simple` | tool-outputs wrapper |
| `listThreads` | `list_threads(None)` | `GET /threads` |
| `getThread` | `get_thread` | `GET /threads/{thread_id}` |
| `deleteThread` | `delete_thread` | `DELETE /threads/{thread_id}` |
| `listThreadDocuments` | `list_thread_documents` | `GET /threads/{thread_id}/documents` |
| `uploadThreadDocument` | `upload_thread_document` | `POST /threads/{thread_id}/documents` |
| `addThreadMessage` | `add_thread_message` | `POST /threads/{thread_id}/messages` |
| `getDocumentStatus` | `get_document_status` | `GET /documents/{document_id}/status` |
| `deleteDocument` | `delete_document` | `DELETE /documents/{document_id}` |
| `listMemories` | `list_memories` | `GET /assistants/{assistant_id}/memories` |
| `searchMemories` | `search_memories` | `POST /assistants/{assistant_id}/memories/search` |
| `addMemory` | `add_memory_value` | `POST /assistants/{assistant_id}/memories` |
| `getMemory` | `get_memory` | `GET /assistants/{assistant_id}/memories/{memory_id}` |
| `updateMemory` | `update_memory` | `PUT /assistants/{assistant_id}/memories/{memory_id}` |
| `deleteMemory` | `delete_memory` | `DELETE /assistants/{assistant_id}/memories/{memory_id}` |
| `getMemoryOperationStatus` | `get_memory_operation_status` | `GET /assistants/memories/operations/{operation_id}` |
| `getModel` | `get_model` | `GET /models/{model_name}` |
| `listProviders` | `list_providers` | `GET /models/providers` |
| `listModelsByProvider` | `list_models_by_provider` | `GET /models/provider/{provider_name}` |
| `listEmbeddingModels` | `list_embedding_models` | `GET /models/embedding/all` |
| `listEmbeddingProviders` | `list_embedding_providers` | `GET /models/embedding/providers` |
| `getEmbeddingModel` | `get_embedding_model` | `GET /models/embedding/{model_name}` |
| `getBillingBalance` | `get_billing_balance` | `GET /billing/balance` |
| `getRecentUsage` | `get_recent_usage` | `GET /billing/usage/recent` |
| `getUsageSummary` | `get_usage_summary` | `GET /billing/usage/summary` |

Response comes back wrapped as an `apiResponse` bridge event:

```json
{ "type": "apiResponse", "requestId": "api-1", "command": "getAssistant", "data": { "id": "asst_123" } }
```

## 7. TypeScript host #1: the standalone extension (`extensions/backboard/`)

`extension.ts` is a 6-line re-export; the real implementation is
`backboardExtension.ts` plus `panel/*.ts`.

### 7.1 Bridge process lifecycle (`backboardExtension.ts:2544-2603`)

- Resolves the bridge binary from (in order): a configured override path,
  `extensions/backboard/rust/target/{debug|release}/backboard-bridge` (dev
  build), or the packaged `extensions/backboard/bin/backboard-bridge`.
- Talks to it over stdin/stdout using the JSON-line protocol from §3, read via
  `readline` (`backboardExtension.ts:2564`).
- Restarts the process on credential change (`:2297`), kills on timeout
  (`:2501`), and handles unexpected exit (`:2576`).

The `BackboardBridge` class exposes `listModels()`, `listTools()`,
`runRustTool()`, `callApi()`, and `send()`, with a 24h model cache (v2) and a
per-mode 24h tool cache (v1).

### 7.2 Config & state on disk

| Purpose | Path |
|---|---|
| API key / env config | `~/.backboard_ide/config.json` |
| Panel UI state | `~/.backboard_ide/panel-state.json` |
| Thread cache | `~/.backboard_ide/threads/*.json` |

### 7.3 Webview panel files (`extensions/backboard/src/panel/`)

| File | Responsibility |
|---|---|
| `panelHtml.ts` | Builds the webview's HTML shell, resource URIs, stylesheets |
| `header.ts` | Panel header (settings, model indicator) |
| `composer.ts` | Message input/composition UI |
| `history.ts` | Conversation history pane |
| `modelSelect.ts` | Model picker + tool list display |
| `tabs.ts` | Recent tabs/checkpoints UI |

## 8. TypeScript host #2: the workbench agent-host (`src/vs/platform/agentHost/node/backboard/backboardAgent.ts`)

This is a separate integration used by the built-in chat/agent-sessions UI
(distinct from the standalone `backboard.panel` webview). It implements the
workbench's `IAgent` interface (`backboardAgent.ts:308-420`) with
`createSession()`, `resolveSessionConfig()`, and `sendMessage()`, exposing
`onDidSessionProgress` / `onDidMaterializeSession`.

It spawns its **own** instance of the same bridge binary via
`BackboardBridgeProcess` (`:2147-2283`, spawn at `:2234`) and speaks the exact
same stdin/stdout JSON-line protocol as the extension — it does not share a
process or import the extension's tool-execution code, and delegates tool
execution and API calls to the bridge the same way (`runTool()`, `callApi()`),
with its own 10-minute tool cache keyed by mode+config.

Default model/provider constants (`:38-64`):

```typescript
const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_MODEL_ID = 'openrouter/deepseek/deepseek-v4-flash';
// SANDBOX_PROVIDER_ORDER: 12 providers, priority order (aws-bedrock = 0 ... ollama = 11)
// BUNDLED_BACKBOARD_MODELS: 20 hardcoded fallback models (:132-154),
//   spanning anthropic/*, openrouter/*, aws-bedrock/*, google/*, x-ai/*, openai/*
```

Bridge path resolution (`:2248-2262`) checks the `BACKBOARD_BRIDGE_PATH` env
var, then falls back to relative paths under the app root — mirroring the
extension's own resolution order in §7.1.

## 9. Crates and dependencies

`extensions/backboard/rust/Cargo.toml` is a two-member workspace
(`backboard`, `backboard_bridge`):

```toml
[workspace.dependencies]
anyhow = "1.0.86"
async-channel = "2.5.0"
futures = "0.3.32"
reqwest = <custom "zed-reqwest" fork, 0.12.15-zed, pinned to a git rev>
serde = "1.0.221"
serde_json = "1.0.144"
tokio = "1"
urlencoding = "2.1.2"
uuid = "1.1.2"
```

`backboard` (the client crate) additionally depends on `dirs` (for resolving
`~/.backboard_ide`). `backboard_bridge` depends on `backboard` plus the shared
async/serde stack.

## 10. Debugging checklist

**Tool calls not working:**
1. `tool_definitions`/`all_tool_definitions` (`main.rs:1976-2053`) — is the tool exposed?
2. `blocked_tools` — is the current mode hiding it?
3. `augment_prompt` — are available tool names present in the prompt context?
4. `consume_stream` — are tool calls detected in the SSE chunks?
5. `emit_tool_requested_events` — are `threadId`/`runId`/`toolCalls` emitted?
6. TS `parseToolCall` / `executeTool` — is the tool name matched correctly?
7. `toolOutput` wrapper shape, then `submit_tool_result`'s dedup guard.
8. `submit_tool_outputs_stream`'s HTTP response.

**API calls not working:**
1. `config.rs` — correct base URL selected?
2. `client.rs` — API key header actually being set?
3. `routes.rs` — correct endpoint path?
4. The specific endpoint wrapper file under `endpoints/`.
5. `call_api_endpoint` dispatch, then TS-side `callApi()` usage.
6. Bridge stderr/logs for `Backboard API returned <status>`.

**Prompt behavior wrong:**
1. `backboard_runtime_system_prompt.md`.
2. `augment_prompt`.
3. Current mode + available tool names.
4. `tools` payload from `tool_definitions_for_request`.
5. `message_form` — is the intended field actually being sent as form data?

## 11. File index

**Rust bridge**
- `extensions/backboard/rust/backboard_bridge/src/main.rs` — command dispatch, prompt augmentation, tool schemas, stream→event mapping
- `extensions/backboard/rust/backboard_bridge/src/backboard_runtime_system_prompt.md` — embedded system prompt

**Rust HTTP client crate**
- `extensions/backboard/rust/backboard/src/endpoints/config.rs` — env/base URL/API key
- `extensions/backboard/rust/backboard/src/endpoints/client.rs` — `BackboardClient`, headers
- `extensions/backboard/rust/backboard/src/endpoints/routes.rs` — path constants/builders
- `extensions/backboard/rust/backboard/src/endpoints/types.rs` — request/response structs
- `extensions/backboard/rust/backboard/src/endpoints/stream.rs` — form encoding, SSE parsing, retry
- `extensions/backboard/rust/backboard/src/endpoints/{assistants,threads,models,billing,documents,tools}.rs` — per-feature HTTP calls

**Standalone VS Code extension**
- `extensions/backboard/src/extension.ts` — thin re-export
- `extensions/backboard/src/backboardExtension.ts` — bridge lifecycle, tool execution, config/state
- `extensions/backboard/src/panel/*.ts` — webview UI
- `extensions/backboard/src/types.ts`, `updates.ts`

**Workbench agent-host**
- `src/vs/platform/agentHost/node/backboard/backboardAgent.ts` — `IAgent` implementation, own `BackboardBridgeProcess`, default models/providers

**Existing deeper reference**
- `backboard-reference/docs/TOOL_CALLS_AND_API.md` — snapshot-based version of this material, plus additional docs in `backboard-reference/docs/` (SSO, onboarding, endpoints, extension architecture)
