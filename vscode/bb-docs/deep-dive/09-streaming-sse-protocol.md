# The Streaming Protocol — End to End

A single agentic turn crosses **three protocols**, each with its own event vocabulary:

```
 Backend SSE (HTTP)          Bridge NDJSON (stdio)        Chat model (observables)
 text/event-stream    ──►    one JSON per line     ──►    IChatProgress → autorun
 (FastAPI, langgraph)        (Rust ↔ TypeScript)          (upstream ChatWidget re-render)
```

This doc lines the three up so you can follow one delta from the LLM to the DOM, and back to the
tool-result submission that continues the run.

## The three vocabularies, side by side

| Concept | Backend SSE (`langgraph_service.py` / `thread_service.py`) | Bridge event (`main.rs`) | Chat delta (`backboardAgent.ts`) |
|---|---|---|---|
| turn opened | `run_started {run_id, provider, model_name}` (:4634) | `progress "Connected to model."` (:539) + `run_id` | progress note |
| reasoning | `reasoning_started/_streaming/_ended` (:5152,:886,:5183) | `reasoningDelta {text}` (:557) | `_appendReasoning` |
| visible text | `content_streaming {content, accumulated_content}` (:6137) | `assistantTextDelta {text}` (:567) | `visibleAssistantTextDelta` (marker-stripped) |
| tool request | `tool_submit_required {run_id, tool_calls}` (:6376) → msg REQUIRES_ACTION, stream pauses | `toolRequested {runId, threadId, toolCalls}` (:519) → `done{requires_tool_result}` | queue `toolRequests` |
| continuation | `run_continuing {run_id, phase}` (thread_service:2725) | (streamed as normal events) | — |
| thread binding | (chunk carries thread/assistant) | `sessionBinding {threadId, assistantId}` (:1091) | update `SessionState` |
| media / voice | `media_generated`, `tts_*`, `stt_*` | `media {chunk}` (:577), `voice {chunk}` (:585) | multimodal handlers |
| usage | carried **inside** `run_ended` (`input/output/total_tokens`) | `usage {usage}` (:593) | usage footer |
| done | `run_ended {status:"completed", content, context_usage, …}` (:7412) | `done {stopReason:end_turn}` (:600) | resolve turn |
| error | `error` / `run_failed {error, error_type}` | `error {message}` → `done{error}` (:608) | ChatError action |
| retry | `retry` (from `stream.rs` reconnect) | `progress "Retrying…"` (:628) | progress note |
| cancel | run marked cancelled; stream polls & bails | `done {stopReason:cancelled}` (:498) | — |

> Two mapping subtleties worth remembering:
> - The backend has **no standalone `usage` event** — token counts ride inside `run_ended`. The
>   bridge splits them into a separate `usage` event before `done`.
> - The agentic pause is `tool_submit_required` on the wire; the assistant message is set to
>   `REQUIRES_ACTION` and the SSE stream **returns**. The turn only continues when the IDE POSTs to
>   `submit-tool-outputs`.

## Backend SSE framing

Both stream endpoints return `StreamingResponse(..., media_type="text/event-stream")` wrapped by
`_sse_with_keepalive`, framing each dict as `data: {json}\n\n` (`threads.py:1332`, `:1551`). Headers
(`:185`): `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection:
keep-alive`; idle `: keepalive` comment frames (`:220`). The router re-emits chunks from
`thread_service.add_message_to_thread_stream` (`:1441`), which wraps
`langgraph_service.invoke_graph_stream` (`:4598`) for the LLM chunks and adds its own orchestration
events (`message_received`, `user_message`, `memory_operation_created`, `memory_retrieved`,
`message_saved`, `context_summary`).

## Bridge SSE→NDJSON translation

The Rust `consume_stream()` (`main.rs:491`) reads SSE JSON chunks (via `sse_json_stream` in
`stream.rs`, which buffers bytes, splits on `\n`, strips the `data: ` prefix, skips `[DONE]`) and
maps `chunk["type"]` to a bridge event (full table in [04](04-rust-typescript-bridge.md)). Retry and
backoff live in `retrying_sse_json_stream` (`stream.rs`): up to 5 reconnects with 2s·2ⁿ backoff, only
before any bytes have streamed, only on transient errors or status ∈ {502,503,504,429}.

## Chat-model side

On the TS side, `_handleBridgeEvent` (`backboardAgent.ts:912`) turns each NDJSON event into an
AHP action; `agentHostSessionHandler` mutates the chat model, and `chatServiceImpl`'s
`progressCallback` (`:1116`) calls `model.acceptResponseProgress(...)` → `ChatResponseModel.updateContent`
→ `onDidChange` → the upstream `ChatWidget` re-renders the affected row (see [01](01-right-panel-api-flow.md#response-streaming-back-into-the-panel)
and [06](06-chat-ui.md)).

## One full turn, all three layers

```
 IDE (TS backboardAgent)        │ NDJSON stdio │   Rust bridge (main.rs)   │  Backend SSE (/api)
 ───────────────────────────────────────────────────────────────────────────────────────────────
 sendMessage() :431             │              │                           │
   listTools(mode) ─────────────► listTools ───►  list_tools :340          │
                    ◄──── tools ; done ◄──────── emit                       │
   send('sendPrompt',…,onEvent) ► sendPrompt ──►  send_prompt :392         │
     :507                       │              │   send_message_stream ─────► POST /threads/{id}/messages?stream=true
                    ◄─ progress "Connected" ◄─── run_started :539          ◄─ run_started
                    ◄─ sessionBinding ◄───────── record_binding :1091      ◄─ chunk{thread/assistant}
   _handleBridgeEvent :912       │              │                           │
     ◄─ reasoningDelta ◄──────── reasoning_delta :557                       ◄─ reasoning_streaming
     ◄─ assistantTextDelta ◄──── content_streaming :567                     ◄─ content_streaming
        (visibleAssistantTextDelta strips "[Called X with parameters:")     │
  ┌─ tool_calls chunk ─────────────────────────  tool_calls_required :514  ◄─ tool_submit_required
  │  ◄─ toolRequested ◄────────── :519  (dedup threadId:runId:ids :967)     │  (msg→REQUIRES_ACTION,
  │  ◄─ done{requires_tool_result} ◄─ :529 ── handle.promise resolves       │   SSE returns)
  │                               │              │                           │
  │  TURN LOOP :527               │              │                           │
  │   _executeToolCalls :1083     │              │                           │
  │    parallel iff >1 & read-only & mode≠manual │  (manual→pendingToolApprovals;
  │    client tool→pendingClientToolCalls)       │   Rust-native web_search/web_fetch run here)
  │   send('submitToolResult',…) ► submitToolResult► submit_tool_result :458 │
  │     :540  {threadId,runId,     │              │  submit_tool_outputs_stream ─► POST .../runs/{rid}/submit-tool-outputs?stream=true
  │           toolOutputs,tools}   │              │                           │
  │                    ◄─ assistantTextDelta ◄─── consume_stream :491        ◄─ content_streaming…
  └──◄── more tool_calls? → loop repeats ◄─────── toolRequested / or         ◄─ (more tool_calls) or
                    ◄─ usage ◄──────────────────── run_ended :593            ◄─ run_ended {*_tokens,
                    ◄─ done{end_turn} ◄─────────── :600 ── loop exits         │   content, context_usage}
   finally :573  flush text ; writeSharedThread ; ChatTurnComplete           │
```

**Cancellation:** TS `cancel()` writes `{command:cancel, params:{requestId}}` → Rust sets
`cancel_flag` (`main.rs:649`) → `consume_stream`'s next-iteration check emits `done{cancelled}`
(`:498`); on the backend, `POST /threads/{id}/runs/{run_id}/cancel` (`threads.py:1691`) marks the run
so its stream polls and bails.

**Errors:** any `run_failed`/`error` chunk → bridge `error` + `done{error}` (`main.rs:608`);
transient network/5xx are retried up to 5× inside `stream.rs`, surfacing `retry` → `progress`.

## See also

- Endpoint definitions and the message/tool-output request shapes: [03](03-backend-endpoints.md).
- Bridge command table, `SendPromptParams`, tool-access modes: [04](04-rust-typescript-bridge.md).
- Tool execution, approval, and rendering of the `tool_submit_required` pause: [05](05-tool-calls.md).
