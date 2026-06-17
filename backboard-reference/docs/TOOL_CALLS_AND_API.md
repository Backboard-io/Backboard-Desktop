# Tool Calls, Bridge Calls, API Calls, And Prompt Flow

This document is the detailed map for the Backboard runtime copied into
`backboard-reference/source-copies`.

It covers four different things that can all look like "tool calls" when reading
the code:

- Bridge calls: TypeScript sends JSON commands to the Rust bridge over stdin.
- Model tool calls: Backboard/model runtime asks the IDE to run local tools.
- Local tool execution: TypeScript or Rust actually performs the tool work.
- Backboard API calls: Rust sends HTTP requests to `app.backboard.io`,
  `dev.app.backboard.io`, or local Backboard.

## One-Screen Mental Model

```text
User prompt
  -> TypeScript host
  -> Rust bridge JSON command: sendPrompt
  -> Rust augments prompt with system prompt + runtime context + tool schemas
  -> Rust HTTP POSTs to Backboard message API with stream=true
  -> Backboard/model streams text or tool-call requests
  -> Rust converts SSE chunks into bridge events
  -> TypeScript renders text or runs local tools
  -> TypeScript sends Rust bridge JSON command: submitToolResult
  -> Rust HTTP POSTs tool outputs back to Backboard
  -> Backboard/model continues streaming
```

Primary files:

- Rust bridge:
  `source-copies/rust/backboard_bridge/src/main.rs`
- Rust system prompt:
  `source-copies/rust/backboard_bridge/src/backboard_runtime_system_prompt.md`
- Rust API client:
  `source-copies/rust/backboard/src/endpoints/*.rs`
- Standalone extension host:
  `source-copies/typescript/extensions-backboard/src/extension.ts`
- Agent-host adapter:
  `source-copies/typescript/agent-host/backboard/backboardAgent.ts`

## Bridge Protocol

The Rust bridge is a child process. TypeScript writes a JSON object followed by
`\n` to stdin. Rust writes JSON events followed by `\n` to stdout.

All bridge requests use this envelope:

```json
{
  "requestId": "uuid",
  "command": "sendPrompt",
  "sessionId": "sandbox:session-or-panel-id",
  "params": {}
}
```

All bridge events use this rough envelope:

```json
{
  "type": "assistantTextDelta",
  "bridgeProtocolVersion": 1,
  "requestId": "same-request-id",
  "sessionId": "same-session-id"
}
```

The request is considered complete when Rust emits:

```json
{
  "type": "done",
  "requestId": "same-request-id",
  "sessionId": "same-session-id",
  "stopReason": "end_turn"
}
```

### Bridge Commands

| Command | Direction | Purpose | Main implementation |
| --- | --- | --- | --- |
| `initialize` | TS -> Rust | Handshake; returns bridge protocol version. | `handle_request` |
| `listModels` | TS -> Rust | Fetch model list from Backboard and emit `models`. | `list_models`, `collect_models` |
| `listTools` | TS -> Rust | Return tool schemas for the current mode. | `list_tools`, `tool_definitions` |
| `runTool` | TS -> Rust | Run the small set of Rust-owned tools. | `run_tool`, `execute_rust_tool` |
| `sendPrompt` | TS -> Rust | Send a user prompt to Backboard and stream the response. | `send_prompt` |
| `submitToolResult` | TS -> Rust | Submit local tool outputs to Backboard and stream continuation. | `submit_tool_result` |
| `cancel` | TS -> Rust | Cancel the current bridge request/session flag. | `cancel_request` |
| `getSession` | TS -> Rust | Return Rust bridge session binding state. | `get_session` |
| `disposeSession` | TS -> Rust | Remove Rust bridge session state. | `dispose_session` |
| API passthrough commands | TS -> Rust | Call specific Backboard HTTP API wrappers. | `is_api_command`, `call_api_endpoint` |

## Prompt Construction

The system prompt is Markdown embedded into the Rust binary:

```rust
const BACKBOARD_SYSTEM_PROMPT: &str = include_str!("backboard_runtime_system_prompt.md");
```

At runtime, `augment_prompt` wraps the user content:

```text
<Backboard runtime system prompt>

## Runtime Context

- Target workspace root: <workspace path>
- Current Backboard mode for this turn: <ask | manual | free | ...>
- Available tools for this turn: <comma-separated names>

Treat relative file, grep, glob, shell, and edit tool paths as relative to the
target workspace root unless the user explicitly provides another path.

## User Request

<user content>
```

That augmented content is placed in the Backboard message API `content` field.
The model also receives the tool schema list in the separate `tools` field.

## `sendPrompt` Bridge Call

TypeScript sends this command when the user asks Backboard something.

Example:

```json
{
  "requestId": "b6c7...",
  "command": "sendPrompt",
  "sessionId": "sandbox:123",
  "params": {
    "content": "Find where the Backboard API client lives",
    "workspace": "/Users/name/repo",
    "provider": "aws-bedrock",
    "model": "anthropic.claude-sonnet-4-6",
    "mode": "free",
    "intensity": "fast",
    "memoryMode": "Auto",
    "webSearch": "off",
    "imageGeneration": null,
    "mcpCalls": ["filesystem", "github"],
    "config": {
      "env": "prod",
      "api_url": null,
      "access_token": null
    }
  }
}
```

Rust turns that into a `SendMessageRequest` with fields like:

```json
{
  "thread_id": "existing thread if any",
  "assistant_id": "existing assistant if any",
  "content": "augmented prompt",
  "provider": "aws-bedrock",
  "model": "anthropic.claude-sonnet-4-6",
  "memory": "Auto",
  "thinking": null,
  "tools": ["function schemas"],
  "parallel_tool_calls": false,
  "web_search": "off",
  "image_generation": null,
  "mcp_calls": ["filesystem", "github"]
}
```

Then Rust uses `BackboardClient::send_message_stream`.

## Message API Request

The message request is sent as form data, not JSON, in the copied code.

Implemented in:

- `source-copies/rust/backboard/src/endpoints/threads.rs`
- `source-copies/rust/backboard/src/endpoints/stream.rs`

Current Rust route:

```text
POST /threads/{thread_id}/messages
X-API-Key: <api key>
Content-Type: application/x-www-form-urlencoded
```

Current form fields emitted by `message_form`:

| Field | Source |
| --- | --- |
| `content` | Augmented prompt |
| `stream` | `true` for streaming |
| `memory` | `Auto`, `Readonly`, or empty/off |
| `web_search` | Backboard web search mode |
| `llm_provider` | Selected provider |
| `model_name` | Selected model |
| `max_tokens` | Optional max token cap |
| `thinking` | Provider-specific reasoning payload JSON |
| `tools` | JSON string of OpenAI-style tool definitions |

Note: `SendMessageRequest` has more fields than this form helper currently
serializes. If you need to verify whether fields like `image_generation`,
`voice`, `mcp_calls`, or `audio_file` are actually transmitted, check and update
`message_form`.

## Stream Events From Backboard

Rust parses SSE lines that look like:

```text
data: {"type":"content_streaming","delta":"hello"}
```

into JSON chunks.

Then `consume_stream` maps Backboard chunks to bridge events.

Important bridge events:

| Bridge event | Meaning | Typical TypeScript handling |
| --- | --- | --- |
| `progress` | Human-readable status. | Show progress/status text. |
| `assistantTextDelta` | Visible assistant text. | Append markdown to UI. |
| `reasoningDelta` | Reasoning/planning stream. | Usually progress display. |
| `media` | Image/media generation payload. | Show media in panel. |
| `voice` | STT/TTS payload. | Voice UI handling. |
| `usage` | Token/cost/usage payload. | Store/display usage. |
| `sessionBinding` | Thread/run/assistant binding state. | Persist session metadata. |
| `toolRequested` | Model requested local tool execution. | Execute tools, submit outputs. |
| `error` | Backboard or bridge error. | Show error. |
| `done` | Current bridge request is complete. | Resolve pending request. |

Example text event:

```json
{
  "type": "assistantTextDelta",
  "requestId": "b6c7...",
  "sessionId": "sandbox:123",
  "text": "The Backboard API client is in `client.rs`."
}
```

Example tool request event:

```json
{
  "type": "toolRequested",
  "requestId": "b6c7...",
  "sessionId": "sandbox:123",
  "runId": "run_abc",
  "threadId": "thread_xyz",
  "toolCalls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "grep",
        "arguments": "{\"pattern\":\"BackboardClient\",\"path\":\"extensions/backboard/rust\"}"
      }
    }
  ]
}
```

## Tool Schema List

Tool schemas are generated by Rust in `all_tool_definitions`.

Each tool schema follows OpenAI function-tool shape:

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read a text file from the workspace. Supports offset and limit line ranges.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string" },
        "target_file": { "type": "string" },
        "file_path": { "type": "string" },
        "offset": { "type": "integer" },
        "limit": { "type": "integer" }
      }
    }
  }
}
```

### Tool Modes

The bridge filters tools by mode.

`ask` mode blocks mutating and command-execution tools:

- `write`
- `write_file`
- `create_file`
- `overwrite_file`
- `edit`
- `edit_file`
- `search_replace`
- `delete_file`
- `create_directory`
- `bash`
- `run_terminal_cmd`
- `run_code`
- `repl`
- `computer`
- `task`
- `read_lints`

`manual` mode blocks command/automation-style tools:

- `bash`
- `run_terminal_cmd`
- `run_code`
- `repl`
- `computer`
- `task`
- `read_lints`

Other modes, including `free`, expose the full list unless extra filtering is
applied.

When Backboard image generation is enabled for a turn, Rust hides local image
tools named:

- `generate_image`
- `image_generate`

That allows Backboard's built-in image generation path to produce
`media_generated` events.

## Tool Ownership Table

| Tool | Schema defined in Rust | Executed by | Notes |
| --- | --- | --- | --- |
| `bash` | Yes | TypeScript | Runs shell command from workspace root. |
| `run_terminal_cmd` | Yes | TypeScript | Alias-style shell execution. |
| `read_file` | Yes | TypeScript | Reads UTF-8 file, supports line range. |
| `write` | Yes | TypeScript | Writes complete file. |
| `write_file` | Yes | TypeScript | Alias for complete write. |
| `create_file` | Yes | TypeScript | Alias for write/create. |
| `overwrite_file` | Yes | TypeScript | Alias for overwrite. |
| `edit` | Yes | TypeScript | Exact replacement. |
| `edit_file` | Yes | TypeScript | Alias for exact replacement. |
| `search_replace` | Yes | TypeScript | Alias for exact replacement. |
| `glob` | Yes | TypeScript | Uses `rg --files` with fallback. |
| `grep` | Yes | TypeScript | Uses `rg` with include/path options. |
| `codebase_search` | Yes | TypeScript | Semantic/fallback workspace search. |
| `list_dir` | Yes | TypeScript | Directory listing. |
| `delete_file` | Yes | TypeScript | Removes file or directory. |
| `create_directory` | Yes | TypeScript | Creates directory. |
| `web_search` | Yes | Rust | DuckDuckGo instant-answer style fetch. |
| `web_fetch` | Yes | Rust | Fetches readable URL text with local/private network blocking. |
| `generate_image` | Yes | Mostly Backboard API/runtime | Hidden when API image generation is enabled. |
| `todo_write` | Yes | TypeScript | Compatibility status result. |
| `read_lints` | Yes | TypeScript | Diagnostics/check commands. |
| `task` | Yes | TypeScript | Currently reports sub-agent unavailable in Sandbox. |
| `enter_plan_mode` | Yes | TypeScript | Compatibility response. |
| `exit_plan_mode` | Yes | TypeScript | Compatibility response. |
| `persistence_decide` | Yes | TypeScript | Compatibility response. |
| `sleep` | Yes | TypeScript | Waits seconds. |
| `repl` | Yes | TypeScript | Compatibility REPL/snippet path. |
| `run_code` | Yes | TypeScript | Runs one-off code snippet. |
| `computer` | Yes | Rust | Currently returns unsupported. |

## Local Tool Execution

The important TypeScript switch is `executeBackboardTool`.

Input after parsing:

```json
{
  "id": "call_1",
  "name": "read_file",
  "args": {
    "path": "extensions/backboard/rust/crates/backboard/src/endpoints/client.rs",
    "offset": 1,
    "limit": 80
  }
}
```

Output returned to the Backboard model is plain text or compact JSON.

Example successful output wrapper sent back to Rust:

```json
{
  "tool_call_id": "call_1",
  "output": "{\"success\":true,\"content\":\"file contents here\"}"
}
```

Example failed output wrapper:

```json
{
  "tool_call_id": "call_1",
  "output": "{\"success\":false,\"content\":\"ENOENT: no such file or directory\"}"
}
```

The UI also emits local session actions for tool start, input delta, ready,
content changed, and complete. Those are workbench UI events, not Backboard API
events.

## Tool Output Submission

After TypeScript executes one or more tool calls, it sends:

```json
{
  "requestId": "c8d9...",
  "command": "submitToolResult",
  "sessionId": "sandbox:123",
  "params": {
    "threadId": "thread_xyz",
    "runId": "run_abc",
    "toolOutputs": [
      {
        "tool_call_id": "call_1",
        "output": "{\"success\":true,\"content\":\"...\"}"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "..."
        }
      }
    ],
    "config": {
      "env": "prod"
    }
  }
}
```

Rust normalizes output keys, deduplicates repeated submissions, then calls:

```text
POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true
X-API-Key: <api key>
Content-Type: application/json
```

Payload:

```json
{
  "tool_outputs": [
    {
      "tool_call_id": "call_1",
      "output": "{\"success\":true,\"content\":\"...\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "..."
      }
    }
  ]
}
```

Backboard then streams the continuation response through the same SSE parser.

## API Passthrough Commands

The Rust bridge also accepts direct API commands. TypeScript can call these
through `callApi`.

The bridge command list is defined in `is_api_command`.

| Bridge command | Rust API wrapper | HTTP route |
| --- | --- | --- |
| `createAssistant` | `create_assistant_value` | `POST /assistants` |
| `listAssistants` | `list_assistants` | `GET /assistants` |
| `getAssistant` | `get_assistant` | `GET /assistants/{assistant_id}` |
| `updateAssistant` | `update_assistant_value` | `PUT /assistants/{assistant_id}` |
| `deleteAssistant` | `delete_assistant` | `DELETE /assistants/{assistant_id}` |
| `createAssistantThread` | `create_thread` | `POST /assistants/{assistant_id}/threads` |
| `listAssistantThreads` | `list_threads(Some)` | `GET /assistants/{assistant_id}/threads` |
| `listAssistantDocuments` | `list_assistant_documents` | `GET /assistants/{assistant_id}/documents` |
| `uploadAssistantDocument` | `upload_document` | `POST /assistants/{assistant_id}/documents` |
| `sendMessage` | `send_message_value` | Message API wrapper |
| `submitToolOutputsSimple` | `submit_tool_outputs_simple` | Tool outputs wrapper |
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

Example API passthrough bridge request:

```json
{
  "requestId": "api-1",
  "command": "getAssistant",
  "sessionId": null,
  "params": {
    "assistantId": "asst_123",
    "config": {
      "env": "prod"
    }
  }
}
```

Example bridge response:

```json
{
  "type": "apiResponse",
  "requestId": "api-1",
  "command": "getAssistant",
  "data": {
    "id": "asst_123",
    "name": "Example"
  }
}
```

## Config And Credentials

Config is loaded from:

```text
~/.backboard_ide/config.json
```

Base URLs:

| Env | Base URL |
| --- | --- |
| `prod` / `production` | `https://app.backboard.io/api` |
| `dev` / default non-prod | `https://dev.app.backboard.io/api` |
| `local` | `http://localhost:8000` |

API authentication uses:

```text
X-API-Key: <api key>
```

The TypeScript extension also handles OAuth setup and may store OAuth tokens in
the same config file. The Rust API client ultimately needs an API key header for
normal API requests.

## TypeScript Host Split

There are two TypeScript adapters in this reference snapshot.

### Standalone extension host

File:

```text
source-copies/typescript/extensions-backboard/src/extension.ts
```

This owns:

- `backboard.panel` webview.
- Backboard commands.
- OAuth and API-key prompts.
- Panel state under `~/.backboard_ide`.
- Model and tool metadata caches.
- Bridge process lifecycle.
- Panel rendering for tool calls and outputs.

### Agent-host integration

File:

```text
source-copies/typescript/agent-host/backboard/backboardAgent.ts
```

This owns:

- `IAgent` implementation.
- Agent sessions and restored history.
- Workbench session actions.
- Tool-call UI status.
- Local tool execution.
- Tool-output submission through the bridge.

## Concrete Debugging Checklist

When tool calls do not work:

1. Check `tool_definitions(mode)` in Rust to confirm the tool is exposed.
2. Check `blocked_tools(mode)` to confirm the current mode is not hiding it.
3. Check `augment_prompt` to confirm available tool names are included in the
   prompt context.
4. Check Backboard SSE chunks in `consume_stream` to confirm tool calls are
   detected.
5. Check `emit_tool_requested_events` to confirm `threadId`, `runId`, and
   `toolCalls` are emitted.
6. Check TypeScript `parseToolCall` and `executeBackboardTool`.
7. Check the tool-specific TypeScript function.
8. Check `toolOutput` wrapper shape.
9. Check `submit_tool_result` and duplicate-submission guard.
10. Check `submit_tool_outputs_stream` HTTP response.

When API calls do not work:

1. Check `config.rs` for selected base URL.
2. Check `client.rs` for API key header creation.
3. Check `routes.rs` for the endpoint path.
4. Check the endpoint wrapper file.
5. Check `call_api_endpoint` command dispatch.
6. Check TypeScript `callApi` usage.
7. Check bridge logs for `Backboard API returned <status>`.

When prompt behavior is wrong:

1. Check `backboard_runtime_system_prompt.md`.
2. Check `augment_prompt`.
3. Check the current mode and available tool names.
4. Check the `tools` payload generated by `tool_definitions_for_request`.
5. Check `message_form` to verify the intended fields are actually sent.

## Search Strings That Matter

Use these strings with `rg` in either the original repo or the copied reference:

```text
BACKBOARD_SYSTEM_PROMPT
augment_prompt
tool_definitions_for_request
tool_definitions
all_tool_definitions
blocked_tools
send_prompt
submit_tool_result
consume_stream
tool_calls_required_by_chunk
emit_tool_requested_events
execute_rust_tool
BackboardBridgeProcess
BackboardBridge
executeBackboardTool
parseToolCall
toolOutput
callApi
send_message_stream
submit_tool_outputs_stream
message_form
sse_json_stream
retrying_sse_json_stream
BackboardClient
json_headers
api_key_header
routes::
```
