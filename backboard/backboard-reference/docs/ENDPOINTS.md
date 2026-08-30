# Backboard Endpoint Reference

This document describes the Backboard HTTP endpoints visible in the copied Rust
client and how the bridge reaches them.

There are two relevant Rust client surfaces in this snapshot:

- `source-copies/rust/backboard/src/endpoints/*.rs` contains a modular endpoint
  client.
- `source-copies/rust/backboard/src/backboard.rs` contains a larger client with
  additional wrappers used by the bridge, including delete, billing summary,
  thread document, memory detail, embedding model, and simple tool-output APIs.

When the bridge command table below names a wrapper that is not in
`endpoints/*.rs`, look in `backboard.rs`.

## Base URLs

The config layer selects the base URL before any route is appended.

| Config env | Base URL | Notes |
| --- | --- | --- |
| `prod` / `production` | `https://app.backboard.io/api` | Production default. |
| `dev` / default non-prod | `https://dev.app.backboard.io/api` | Development service. |
| `local` | `http://localhost:8000` | Local Backboard API. |

Config file:

```text
~/.backboard_ide/config.json
```

Normal API requests use:

```text
X-API-Key: <api key>
```

The API key is stored in `~/.backboard_ide/config.json`; see `CREDENTIALS.md`
for the exact JSON shape, precedence rules, and OAuth-token fallback behavior.

Most JSON endpoints use:

```text
Content-Type: application/json
```

Message streaming currently uses form data in the modular `endpoints/stream.rs`
path. The larger `backboard.rs` client has its own message request builder.

## Route Builder

The modular route map is in:

```text
source-copies/rust/backboard/src/endpoints/routes.rs
```

Defined route constants:

| Constant | Path |
| --- | --- |
| `ASSISTANTS` | `/assistants` |
| `THREADS` | `/threads` |
| `MODELS` | `/models` |
| `MODEL_PROVIDERS` | `/models/providers` |
| `RECENT_USAGE` | `/billing/usage/recent` |

Defined route helpers:

| Helper | Path |
| --- | --- |
| `models_by_provider(provider)` | `/models/provider/{provider}` |
| `assistant(assistant_id)` | `/assistants/{assistant_id}` |
| `assistant_threads(assistant_id)` | `/assistants/{assistant_id}/threads` |
| `assistant_documents(assistant_id)` | `/assistants/{assistant_id}/documents` |
| `assistant_memories(assistant_id)` | `/assistants/{assistant_id}/memories` |
| `thread(thread_id)` | `/threads/{thread_id}` |
| `thread_messages(thread_id)` | `/threads/{thread_id}/messages` |
| `run_submit_tool_outputs(thread_id, run_id)` | `/threads/{thread_id}/runs/{run_id}/submit-tool-outputs` |
| `run_submit_tool_outputs_stream(thread_id, run_id)` | `/threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` |
| `run_cancel(thread_id, run_id)` | `/threads/{thread_id}/runs/{run_id}/cancel` |

The larger `backboard.rs` client also hardcodes routes not present in
`routes.rs`; those are listed below.

## Endpoint Groups

### Assistants

Assistant endpoints are for named AI profiles. Assistants can own shared
threads, documents, memory behavior, default tools, and prompt settings.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/assistants` | `list_assistants` | None | `Vec<Value>` or JSON list |
| `POST` | `/assistants` | `create_assistant`, `create_assistant_value` | Assistant JSON | Assistant JSON |
| `GET` | `/assistants/{assistant_id}` | `get_assistant` | None | Assistant JSON |
| `PUT` | `/assistants/{assistant_id}` | `update_assistant`, `update_assistant_value` | Partial assistant JSON | Assistant JSON |
| `DELETE` | `/assistants/{assistant_id}` | `delete_assistant` | None | API JSON |

Typed create body from `types.rs`:

```json
{
  "name": "My Assistant",
  "description": "Assistant description",
  "tools": [],
  "custom_fact_extraction_prompt": "optional",
  "custom_update_memory_prompt": "optional"
}
```

Typed update body:

```json
{
  "name": "New name",
  "description": "New description",
  "tools": []
}
```

Bridge commands:

- `createAssistant`
- `listAssistants`
- `getAssistant`
- `updateAssistant`
- `deleteAssistant`

### Assistant Threads

Assistant-thread endpoints create or list conversations scoped to an assistant.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/assistants/{assistant_id}/threads` | `create_thread` | `{}` | Thread JSON |
| `GET` | `/assistants/{assistant_id}/threads` | `list_threads(Some)` | None | Thread list |

Bridge commands:

- `createAssistantThread`
- `listAssistantThreads`

### Threads

Thread endpoints manage conversation containers.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/threads` | `list_threads(None)` | None | Thread list |
| `GET` | `/threads/{thread_id}` | `get_thread` | None | Thread JSON |
| `DELETE` | `/threads/{thread_id}` | `delete_thread` | None | API JSON |
| `POST` | `/threads/{thread_id}/messages` | `add_thread_message` | Message JSON | Message JSON |
| `POST` | `/threads/{thread_id}/runs/{run_id}/cancel` | `cancel_run` | None | Boolean success in Rust |

Bridge commands:

- `listThreads`
- `getThread`
- `deleteThread`
- `addThreadMessage`

The cancel route is used by the Rust client, but the current bridge `cancel`
command primarily sets the local cancellation flag and emits `done`; it does not
always imply an HTTP cancel call.

### Primary Message API

The system prompt states the public primary API is:

```text
POST /threads/messages
```

The larger `backboard.rs` client implements this direct route:

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/threads/messages` | `send_message`, `send_message_value` | Message body | Message JSON |
| `POST` | `/threads/messages` | `send_message_stream` | Message body with stream flag | SSE stream |

The modular `endpoints/threads.rs` client sends to:

```text
POST /threads/{thread_id}/messages
```

with form data. The bridge snapshot currently builds a `SendMessageRequest`
without requiring an existing thread, so the larger direct `/threads/messages`
path is the API shape to keep in mind for auto-created threads.

Common message fields from the system prompt and Rust request types:

| Field | Purpose |
| --- | --- |
| `content` | User message; in this runtime it contains the augmented system prompt plus user request. |
| `thread_id` | Continue an existing conversation. |
| `assistant_id` | Start or continue under a shared assistant profile. |
| `llm_provider` / `provider` | Model provider. |
| `model_name` / `model` | Model name. |
| `stream` | Enable SSE response. |
| `thinking` | Provider-specific reasoning config. |
| `memory` | Memory Lite mode such as `Auto`, `Readonly`, or off. |
| `memory_pro` | Higher-accuracy memory mode. |
| `web_search` | Backboard web-search mode. |
| `tools` | OpenAI-style function schema array. |
| `parallel_tool_calls` | Runtime sets this to `false` for this bridge loop. |
| `mcp_calls` | Optional MCP call settings/payload. |
| `max_tokens` | Optional output cap. |
| `image_generation` | Image generation mode. |
| `image_model_provider` | Provider for image generation. |
| `image_model_name` | Model for image generation. |
| `voice` | STT/TTS settings. |
| `audio_file` | Audio payload for STT/conversation modes. |

Bridge commands:

- `sendPrompt` uses streaming and maps SSE chunks into bridge events.
- `sendMessage` is an API passthrough command for a direct message request.

Important implementation detail:

- The Rust bridge defines a rich `SendMessageRequest`.
- Verify the active request builder before assuming every field is serialized.
  In the modular `endpoints/stream.rs` helper, only a subset of fields is turned
  into form data.

### Tool Outputs

Tool outputs let the local IDE return results after the model requested function
calls.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/threads/{thread_id}/runs/{run_id}/submit-tool-outputs` | `submit_tool_outputs` | Tool outputs JSON | Continuation JSON |
| `POST` | `/threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` | `submit_tool_outputs_stream` | Tool outputs JSON | SSE stream |
| `POST` | `/threads/tool-outputs` | `submit_tool_outputs_simple` | Tool outputs JSON | API JSON |

Body shape:

```json
{
  "tool_outputs": [
    {
      "tool_call_id": "call_abc",
      "output": "{\"success\":true,\"content\":\"result text\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a text file from the workspace."
      }
    }
  ]
}
```

Bridge commands:

- `submitToolResult`
- `submitToolOutputsSimple`

`submitToolResult` is the tool-call loop path. It streams the model continuation
after tool results are submitted.

### Documents

Documents can be attached at assistant scope or thread scope.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/assistants/{assistant_id}/documents` | `list_assistant_documents` | None | Documents JSON |
| `POST` | `/assistants/{assistant_id}/documents` | `upload_document` | Multipart `file` | Document JSON |
| `GET` | `/threads/{thread_id}/documents` | `list_thread_documents` | None | Documents JSON |
| `POST` | `/threads/{thread_id}/documents` | `upload_thread_document` | Multipart `file` | Document JSON |
| `GET` | `/documents/{document_id}/status` | `get_document_status` | None | Status JSON |
| `DELETE` | `/documents/{document_id}` | `delete_document` | None | API JSON |

Bridge commands:

- `listAssistantDocuments`
- `uploadAssistantDocument`
- `listThreadDocuments`
- `uploadThreadDocument`
- `getDocumentStatus`
- `deleteDocument`

Upload implementation details:

- Reads the local file bytes.
- Uses multipart form field name `file`.
- Applies API-key auth.

### Memories

Memory endpoints are assistant-scoped except for operation status.

| Method | Path | Rust wrapper | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/assistants/{assistant_id}/memories` | `list_memories` | None | Memory list |
| `POST` | `/assistants/{assistant_id}/memories` | `add_memory`, `add_memory_value` | Memory JSON | Memory JSON |
| `POST` | `/assistants/{assistant_id}/memories/search` | `search_memories` | Search JSON | Search result JSON |
| `GET` | `/assistants/{assistant_id}/memories/{memory_id}` | `get_memory` | None | Memory JSON |
| `PUT` | `/assistants/{assistant_id}/memories/{memory_id}` | `update_memory` | Memory JSON | Memory JSON |
| `DELETE` | `/assistants/{assistant_id}/memories/{memory_id}` | `delete_memory` | None | API JSON |
| `GET` | `/assistants/memories/operations/{operation_id}` | `get_memory_operation_status` | None | Operation JSON |

Bridge commands:

- `listMemories`
- `searchMemories`
- `addMemory`
- `getMemory`
- `updateMemory`
- `deleteMemory`
- `getMemoryOperationStatus`

Simple typed add body:

```json
{
  "content": "Remember this fact",
  "tags": ["project", "preference"]
}
```

The bridge `addMemory` passthrough uses arbitrary JSON from `body`, so newer API
fields can pass through without changing the typed helper.

### Models

Model endpoints drive model pickers and capability discovery.

| Method | Path | Rust wrapper | Query | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/models` | `list_models` | `model_type`, `provider`, `skip`, `limit` | Paged models |
| `GET` | `/models/{model_name}` | `get_model` | None | Model JSON |
| `GET` | `/models/providers` | `list_providers` | None | Provider list |
| `GET` | `/models/provider/{provider_name}` | `list_models_by_provider` | `skip`, `limit` | Paged models |
| `GET` | `/models/embedding/all` | `list_embedding_models` | None | Embedding models JSON |
| `GET` | `/models/embedding/providers` | `list_embedding_providers` | None | Embedding providers JSON |
| `GET` | `/models/embedding/{model_name}` | `get_embedding_model` | None | Embedding model JSON |

Bridge commands:

- `listModels`
- `getModel`
- `listProviders`
- `listModelsByProvider`
- `listEmbeddingModels`
- `listEmbeddingProviders`
- `getEmbeddingModel`

Bridge-specific model behavior:

- `listModels` calls `collect_models`.
- It fetches LLM models first and then provider-specific models.
- It filters hidden/non-LLM providers for UI display.
- It currently hides `featherless` in the Rust bridge and additional providers
  in TypeScript UI filtering.

Model object fields accepted by Rust:

```json
{
  "provider": "openai",
  "name": "gpt-5",
  "model_type": "llm",
  "display_name": "GPT-5",
  "context_window": 128000,
  "supports_thinking": true,
  "input_cost_per_1m_tokens": 1.25,
  "output_cost_per_1m_tokens": 10.0
}
```

The Rust model type also accepts aliases:

- `id` or `model_id` for `name`
- `context_window` or `max_context_tokens` for `context_limit`

### Billing And Usage

Billing endpoints fetch credit balance and usage summaries.

| Method | Path | Rust wrapper | Query | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/billing/balance` | `get_billing_balance` | None | Balance JSON |
| `GET` | `/billing/usage/recent` | `get_recent_usage` | Usage filters | Usage page JSON or `None` on non-success |
| `GET` | `/billing/usage/summary` | `get_usage_summary` | `range` | Summary JSON |

Bridge commands:

- `getBillingBalance`
- `getRecentUsage`
- `getUsageSummary`

Recent usage query fields supported by bridge parsing:

| Input alias | Sent query |
| --- | --- |
| `page` | `page` |
| `pageSize` / `page_size` | `page_size` |
| `model`, `modelName`, `model_name` | `model` or `model_name`, depending client path |
| `inputTokens` / `input_tokens` | `input_tokens` |
| `outputTokens` / `output_tokens` | `output_tokens` |
| `start` | `start` |
| `end` | `end` |
| `creditType` / `credit_type` | `credit_type` |
| `sortBy` / `sort_by` | `sort_by` |
| `sortOrder` / `sort_order` | `sort_order` |

Usage summary supports:

```json
{
  "range": "30d"
}
```

## Bridge API Command Dispatch

The bridge accepts direct API commands through `call_api_endpoint`.

Generic bridge request:

```json
{
  "requestId": "api-1",
  "command": "listThreads",
  "sessionId": null,
  "params": {
    "config": {
      "env": "prod"
    },
    "query": {},
    "body": {}
  }
}
```

Generic bridge response:

```json
{
  "type": "apiResponse",
  "requestId": "api-1",
  "sessionId": null,
  "command": "listThreads",
  "data": {
    "threads": []
  }
}
```

Parameter names used by dispatch:

| Param | Used by |
| --- | --- |
| `assistantId` / Rust `assistant_id` | Assistant-scoped routes |
| `threadId` / Rust `thread_id` | Thread-scoped routes |
| `documentId` / Rust `document_id` | Document routes |
| `memoryId` / Rust `memory_id` | Memory detail routes |
| `operationId` / Rust `operation_id` | Memory operation status |
| `modelName` / Rust `model_name` | Model routes |
| `providerName` / Rust `provider_name` | Provider route |
| `filePath` / Rust `file_path` | Upload routes |
| `body` | JSON body passthrough |
| `query` | Query object for usage endpoints |
| `config` | Env/API URL/access token config |

## Endpoint Debugging

If an endpoint fails:

1. Confirm the bridge command is in `is_api_command`.
2. Confirm `call_api_endpoint` reads the parameter you are passing.
3. Confirm the wrapper exists in either `endpoints/*.rs` or `backboard.rs`.
4. Confirm the route path matches current Backboard API docs.
5. Confirm the request body style: JSON, form data, or multipart.
6. Confirm auth uses the expected API key config.
7. Check whether the wrapper returns typed JSON, raw `Value`, `Vec<Value>`, or
   `Option<Value>`.
8. Check stream handling separately for message and tool-output endpoints.

## Endpoint Search Strings

```text
routes::
ASSISTANTS
THREADS
MODELS
MODEL_PROVIDERS
RECENT_USAGE
create_assistant
delete_assistant
create_thread
send_message_stream
send_message_value
submit_tool_outputs_stream
submit_tool_outputs_simple
upload_document
upload_thread_document
list_memories
search_memories
get_memory_operation_status
list_models_by_provider
list_embedding_models
get_billing_balance
get_usage_summary
call_api_endpoint
is_api_command
```
