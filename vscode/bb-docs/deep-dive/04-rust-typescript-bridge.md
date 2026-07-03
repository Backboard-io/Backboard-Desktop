# The Rust/TypeScript Bridge (`backboard-bridge`)

The bridge is a **Rust binary compiled from the Zed fork's crates**
(`ide/zed/crates/backboard_bridge`, depending on `ide/zed/crates/backboard`) that the VS Code
fork spawns as a subprocess. It speaks **newline-delimited JSON over stdin/stdout** and proxies
the Backboard HTTP API, including SSE streaming and a couple of local Rust tools
(web_search / web_fetch).

```
┌──────────────────────────── Electron main / Node ────────────────────────────┐
│ src/vs/platform/agentHost/node/backboard/backboardAgent.ts                   │
│                                                                              │
│  BackboardAgent                       BackboardBridgeProcess                 │
│  ├─ session registry                  ├─ _ensureProcess()  (:2163-2199)      │
│  ├─ _sendMessage()                    │    child_process.spawn(binary)       │
│  ├─ _handleBridgeEvent()              │    cwd = os.homedir()                │
│  └─ tool approval registries          │    stdio: [pipe, pipe, pipe]         │
│                                       ├─ stdin  ◄── JSON line per request    │
│                                       ├─ stdout ──► readline → BridgeEvent   │
│                                       └─ stderr ──► log '[Backboard bridge]' │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  {"request_id","command","session_id","params"}\n
                ▼
┌────────────── Rust subprocess: backboard-bridge ─────────────────────────────┐
│ ide/zed/crates/backboard_bridge/src/main.rs                                  │
│  tokio runtime; reads stdin lines → BridgeRequest (:141-150)                 │
│  dispatch (:337-434): initialize / listModels / listTools / runTool /        │
│    sendPrompt / submitToolResult / cancel / getSession / disposeSession /    │
│    ~25 direct API proxy commands                                             │
│                                                                              │
│  ide/zed/crates/backboard/src/backboard.rs — BackboardClient                 │
│    PROD https://app.backboard.io/api   DEV https://dev.app.backboard.io/api  │
│    LOCAL http://localhost:8000         (backboard.rs:23-25, config :142-154) │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTPS + SSE (reqwest)
                ▼
        Backboard API (FastAPI) → LLM providers
```

## Binary resolution & lifecycle

`BackboardBridgeProcess._ensureProcess()` (`backboardAgent.ts:2163-2199`) resolves the binary:

1. `BACKBOARD_BRIDGE_PATH` / `VSCODE_BACKBOARD_BRIDGE_PATH` env vars
2. `extensions/backboard/bin/backboard-bridge(.exe)` — the shipped location
3. `extensions/backboard/rust/target/debug/backboard-bridge(.exe)` — dev builds
4. cwd-relative variants of the above

Build: `npm --prefix extensions/backboard run build-bridge` → `cargo build`; the binary is
packaged into the `extensions/backboard` extension (`files: ["bin/**", …]`).

On exit: code+signal logged, all pending requests rejected, process killed on dispose.

## Wire protocol

**Request (TS → Rust)**, one JSON object per line on stdin (`main.rs:141-150`,
written at `backboardAgent.ts:2113`):

```json
{ "request_id": "<uuid>", "command": "sendPrompt", "session_id": "…", "params": { … } }
```

**Event (Rust → TS)**, one JSON object per line on stdout, correlated by `requestId`; a
`done` event (with `stopReason`) terminates the request.

### Commands

| Command | Purpose | Key responses |
|---|---|---|
| `initialize` | handshake | `initialized` (`bridgeProtocolVersion: 1`) |
| `listModels` | model catalog | `models` → `done` |
| `listTools` | tool defs for a mode | `tools` → `done` |
| `runTool` | run a local Rust tool (web_search, web_fetch) | `toolFinished(started/finished)` → `done` |
| `sendPrompt` | send user message, stream reply | streaming events below |
| `submitToolResult` | feed tool outputs back, continue run | streaming events below |
| `cancel` | cancel running request | `done(stopReason: cancelled)` |
| `getSession` / `disposeSession` | session state / cleanup | `session` / `done` |
| ~25 API proxy commands | createAssistant, listThreads, uploadDocument, getBillingBalance, … (`main.rs:607-779`) | `apiResponse { command, data }` |

### `sendPrompt` params (the big one)

```rust
SendPromptParams {
  content, workspace?, provider?, model?,
  mode?,            // free | ask | manual   (tool access level)
  intensity?,       // fast | medium | deep  (reasoning effort)
  web_search?, image_generation?, voice_mode?,
  audio_file?, image_file?, files: [FileAttachmentParams],
  tools?: [Tool],   // OpenAI function-schema format
  thread_id?,       // resume an existing backend thread
  assistant_id?, max_tokens?, config?,
}
```

Tool-access modes (`main.rs:1988-2020`):

```
 ask     → no bash/write/edit/code-execution tools offered
 manual  → no bash/code-execution; edits require manual approval
 free    → all tools, no approval
```

### Streaming events (both `sendPrompt` and `submitToolResult`)

```
run_started ─► reasoning_started ─► reasoning_streaming/reasoning_delta*
            ─► content_streaming* ─► assistantTextDelta*        (visible text)
            ─► toolCallStreaming*    {toolCallId, toolName, argumentsChars, path}
            ─► toolRequested        {runId, threadId, toolCalls[]}   ← agent wants tools
            ─► media_generated / tts_audio_delta / stt_text_delta    (multimodal)
            ─► usage / usage_summary {input_tokens, output_tokens, context_usage}
            ─► run_ended / message_completed / done {stopReason}
            ─► error / run_failed {message} / retry
```

Stream handling in `main.rs:1287-1565`: tool-call argument chunks are accumulated per call id;
raw model tool markers (`<|tool_call_begin|>` etc.) are stripped from visible text; completion
is detected from multiple event spellings and `finish_reason`.

## Request correlation & the turn loop on the TS side

```ts
// backboardAgent.ts:479-495
const handle = this._bridge.send('sendPrompt', bridgeSessionId, params,
	event => this._handleBridgeEvent(...));   // fires per streamed event
session.currentRequestId = handle.requestId;
await handle.promise;                        // resolves on 'done'
```

Full agentic turn:

```
 UI message
   │ sendPrompt ──────────────────────────► bridge ──► POST /threads/{id}/messages (SSE)
   │ ◄── assistantTextDelta* ◄────────────  SSE chunks
   │ ◄── toolRequested {toolCalls[]}
   │
   ├─ TS executes tools (parallel iff all read-only and mode ≠ manual,
   │  else sequential) — see doc 05 for approval flow
   │
   │ submitToolResult {thread_id, run_id, tool_outputs[]} ──► bridge
   │        ──► POST /threads/{id}/runs/{rid}/submit-tool-outputs?stream=true
   │ ◄── more deltas / more toolRequested … (loop)
   │ ◄── done {stopReason}
   ▼
 turn persisted to ~/.backboard_ide/threads/<workspace>/<session-id>/thread.json
 (panel state: ~/.backboard_ide/panel-state.json)      backboardAgent.ts:1792-1896
```

Session state (`backboardAgent.ts:171-188`): `threadId` binds the IDE session to a backend
thread; `pendingClientToolCalls` and `pendingToolApprovals` registries track in-flight tool
work; sessions are created provisionally (`:337-393`) and materialized on first message
(`:677-687`).

## Error handling & resilience

- **Upstream idle timeout recovery** (`main.rs:1596-1600`): message matching
  "upstream idle timeout" triggers one automatic reconnect
  (`MAX_UPSTREAM_IDLE_RECOVERY_ATTEMPTS = 1`).
- **Duplicate tool-output suppression** (`main.rs:1221-1279`): a key of
  session+thread+run+sorted tool-call-ids guards both in-flight and already-submitted sets;
  stale "No assistant message found requiring action" errors are swallowed.
- **TS side** (`backboardAgent.ts:533-544`): recoverable submission errors suppressed; others
  surface as ChatError actions in the UI.
- **Observability**: latency trace stages (`turn_start`, `post_stream_open`,
  `stream_first_chunk`, `submit_tool_result_done`, … `backboardAgent.ts:898-905`) logged under
  `[Backboard latency]`; a heartbeat emits progress every 5s once a phase stalls >15s
  (`:431-449`).
