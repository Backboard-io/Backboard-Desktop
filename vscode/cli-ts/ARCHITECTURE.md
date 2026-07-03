# Backboard R-CLI Architecture

Backboard R-CLI is a Bun and TypeScript terminal coding agent.

It is built around a simple rule:

> Core logic emits events. UI, logs, and output modes subscribe to those events.

This keeps the agent loop, tools, provider API, and terminal UI separate.

## Big Picture

```mermaid
flowchart TD
  CLI["src/entrypoints/cli.tsx"]
  Config["src/config"]
  Bus["src/core/bus"]
  Controller["src/core/agent/AgentController.ts"]
  AssistantBinding["src/core/agent/AssistantSessionBinding.ts"]
  Loop["src/core/agent/AgentLoop.ts"]
  Backboard["src/providers/backboard"]
  Scheduler["src/core/tools/ToolScheduler.ts"]
  SkillsController["src/core/skills/SkillController.ts"]
  Skills["src/core/skills"]
  MCPController["src/core/mcp/MCPController.ts"]
  Hooks["src/core/hooks"]
  Tools["src/tools"]
  Session["src/core/session"]
  State["src/state"]
  MCP["src/core/mcp"]
  UI["src/ui"]

  CLI --> Config
  CLI --> Bus
  CLI --> Session
  CLI --> MCP
  CLI --> Hooks
  CLI --> Backboard
  CLI --> Controller
  CLI --> SkillsController
  CLI --> MCPController
  CLI --> UI
  UI --> SkillsController
  UI --> MCPController
  MCPController --> MCP
  SkillsController --> Skills
  Controller --> SkillsController
  Controller --> Hooks
  Controller --> AssistantBinding
  Controller --> Loop
  Loop --> Backboard
  Loop --> Scheduler
  Scheduler --> Hooks
  Scheduler --> Tools
  Controller --> Bus
  Loop --> Bus
  Scheduler --> Bus
  Bus --> Session
  Bus --> State
  State --> UI
```

## Source Layout

`src/entrypoints/`

The process entrypoint. It should stay thin. It reads config, creates runtime objects, starts the UI or headless mode, and flushes logs before exit.

`src/config/`

Environment variables, CLI flags, defaults, profiles, and runtime path layout. Model, memory, profile, thinking, output format, tool filtering decisions, and Backboard R-CLI-owned config path construction live here.

`src/core/bus/`

The typed event system. `AgentEvent` is the shared language between the agent loop, tools, UI, and logs.

`src/core/agent/`

Turn orchestration. This code binds the stable Backboard assistant, builds per-turn prompt/tool overrides, sends user input to Backboard, handles provider events, runs tools when needed, submits tool outputs, and handles cancellation.

`src/core/session/`

Runtime session state and durable logs. It stores the assistant binding, thread id, transcript, usage, todos, and JSONL logs under `.backboard/sessions/<session-id>/`.

`src/core/skills/`

Skill discovery, validation, catalog budgeting, skills.sh listing/import, and activation. Local skills use `.agents/skills/<name>/SKILL.md`; discovery runs only after the user invokes `/skills`. The picker has Repo, Personal, and skills.sh tabs with current-tab search; Personal also shows repo skills marked `active`. The skills.sh tab reads public leaderboard pages and caches them in-process. Remote skills are imported with the official `npx skills add ...` flow, normalized into `.agents/skills`, and then loaded. Only selected skills enter the compact catalog, and full skill bodies are added only for explicit `$skill-name` activation. Bundled support files are listed relative to the skill directory so the agent can read them only when needed.

`src/core/mcp/`

MCP config loading, `/mcp` manager orchestration, curated catalog entries, manual config writing, environment expansion, source-aware disable/remove, server connection management, notification-driven tool refresh, and MCP tool-name generation. `McpController` owns catalog/manual add workflows for the Ink UI. This module owns MCP transport details and returns tool definitions that `src/tools/MCPToolAdapter.tsx` wraps as normal Backboard R-CLI tools.

`src/core/hooks/`

Command hook config loading, project-hook trust checks, hook hashing, command execution, hook manager summaries and writes, and hook event orchestration. `HookController` is called by `AgentController` for session and prompt hooks, and by `ToolScheduler` for pre/post tool hooks. `HookManagerController` owns the `/hooks` UI data for listing events, matchers, and hook details, and for adding/removing hooks.

`src/core/tools/`

Generic tool infrastructure. It owns the tool base class, registry, Zod-to-JSON-schema conversion, tool execution context, and scheduling rules.

`src/providers/backboard/`

Backboard REST transport and response mapping. Provider-specific API shapes should stay here.

`src/tools/`

Concrete tools. Each tool has one file and one clear job.

`src/prompts/`

System prompt and tool prompt modules. Model-facing wording belongs here, not inside the tool executor code.

`src/state/`

Pure UI reducer logic. It converts `AgentEvent` values into `AppState`.

`src/ui/`

Ink and React terminal UI. Components render state and call controller methods. They should not run tools or call Backboard directly.

`src/utils/`

Small generic helpers only.

`tests/`

Bun tests for config, events, logs, mappers, scheduler behavior, MCP catalog behavior, and agent loop behavior.

## Startup Flow

The main startup path begins in `src/entrypoints/cli.tsx`.

1. Parse early commands: `login`, `logout`, `--help`, and `--version`.
2. If `login` was requested, run browser-based Backboard OAuth and save returned credentials.
3. Create `Config`.
4. If interactive startup has no credentials, render the Login or Exit screen. Login runs browser-based Backboard OAuth and retries config creation.
5. Create a session id.
6. Create `.backboard/sessions/<session-id>/`.
7. Create `EventBus`.
8. Attach `ClientEventLog`.
9. Attach `JsonEventStream` if `--format json` is enabled.
10. Create `Session`.
11. Create `BackboardClient`.
12. Load hook config and create `HookController` plus `HookManagerController`; untrusted project hooks emit non-fatal warnings.
13. Load MCP config, connect enabled MCP servers, and emit non-fatal warnings.
14. Register the default tools, including MCP adapters when MCP tools are available.
15. Build or reuse a Backboard assistant for the current system prompt and tool set.
16. Create `SkillController`.
17. Create `McpController`.
18. Create `AgentController`.
19. Run either headless mode or the Ink UI.
20. Close MCP transports and flush client and server logs before exit.

## Interactive Flow

In normal terminal mode, the user talks to `src/ui/App.tsx`.

```mermaid
sequenceDiagram
  participant User
  participant UI as Ink UI
  participant Controller as AgentController
  participant Loop as AgentLoop
  participant Bus as EventBus
  participant Store as UI Store

  User->>UI: Type message
  UI->>Controller: submit(text)
  Controller->>Bus: user:message
  Controller->>Loop: run(text)
  Loop->>Bus: turn:start
  Bus->>Store: reduce event
  Store->>UI: render new state
```

Slash commands are parsed in `src/ui/commands/index.ts`.

Current commands:

- `/help`
- `/clear`
- `/exit`
- `/quit`
- `/model`
- `/mcp` to manage MCP servers
- `/hooks` to manage command hooks
- `/skills` to open the Repo / Personal / skills.sh picker
- `/skill-name` for loaded skills

## Turn Flow

`AgentController` is the public facade used by the UI for agent turns.

It owns:

- One active turn at a time
- The turn `AbortController`
- Ask-user prompts from tools
- The `ToolScheduler`
- Creation of a fresh `AgentLoop` for each submitted message
- Assistant/session binding for the stable base prompt and tool schemas
- Session and prompt hook execution before a turn reaches Backboard

`SkillController` owns `/skills` discovery, picker state, selected-skill
catalogs, skills.sh imports, and activated skill prompt expansion for turns.

`AssistantSessionBinding` resolves or creates one base Backboard assistant for
the session. Dynamic skills, refreshed MCP tools, and lazy tool prompts stay
local and are sent through Backboard's per-turn `system_prompt` and `tools`
overrides, so the backend thread is preserved when those local capabilities
change.

`AgentLoop` drives one user turn until it reaches a terminal state.

```mermaid
flowchart TD
  A["User message"] --> B["Backboard /threads/messages"]
  B --> C{"Provider event"}
  C -->|"assistant_text"| D["Emit assistant:message"]
  C -->|"usage"| E["Emit usage"]
  C -->|"completed"| F["Emit turn:end completed"]
  C -->|"failed"| G["Emit run:error"]
  C -->|"requires_action"| H["Run requested tools"]
  H --> I["Record tool results"]
  I --> J["Backboard /threads/tool-outputs"]
  J --> C
```

Important turn rules:

- A cancelled turn does not submit partial tool outputs.
- Repeated tool call ids are ignored after they have been answered once in the same turn.
- Tool outputs are submitted only for currently pending tool calls.
- Backboard is the source of truth for thread and run status.
- `SessionStart` hooks run lazily before the first submitted turn; `SessionEnd` only fires if `SessionStart` ran, keeping the pair symmetric.
- `UserPromptSubmit` hooks can block a prompt before it is logged or sent.
- `Stop` hooks run for every turn that started, whatever the outcome, and receive that outcome as `status`.

## Hooks

Hooks are command hooks. Backboard R-CLI does not load JavaScript plugins into the CLI process.

Config files:

- Project: `<repo-root>/.backboard/hooks.json`
- User: `~/.backboard/hooks.json`

User hooks are trusted by default. Project hooks are loaded but skipped unless their computed `sha256:` hash appears in the user config's `trustedProjectHookHashes` list. This keeps shared project config reviewable without silently running new local commands.

Hook events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SessionEnd`

`Stop` and `SessionEnd` hooks run for side effects only; their output is not fed
back into the turn, and as teardown hooks they are time-bounded so a slow hook
cannot block turn completion or process exit. Matchers only apply to
`PreToolUse`/`PostToolUse`; a matcher on any other event is ignored rather than
silently dropping the hook. A `PreToolUse`/`PostToolUse` hook that matches a tool
forces that tool to run serially, so a broad matcher disables parallel tool
execution.

Hook commands receive one JSON object on stdin. They may print a JSON object on stdout. A non-zero exit code emits a warning; exit code `2` blocks the current prompt or tool with stderr as the reason. Hook processes receive a sanitized environment plus `Q_PROJECT_DIR`, `Q_SESSION_ID`, and `Q_CWD`.

`HookController` runs matching trusted hooks serially. Prompt hooks can block a turn or add model-visible context. Tool hooks run inside `ToolScheduler`; pre-tool hooks can deny execution or replace parsed input, and post-tool hooks see the raw tool output (not Backboard R-CLI's hook-context decoration) and can replace it. Pre- and post-hook context are merged into a single model-visible block.

The `/hooks` command opens an interactive manager in the Ink UI. It lists supported hook events with configured counts, shows matchers and hook details, and supports adding and removing hooks (personal or project) through `HookManagerController`. Users can also edit `hooks.json` directly.

## Event System

The event bus is in `src/core/bus/EventBus.ts`.

The event types are defined in `src/core/bus/events.ts`.

Events are synchronous. This matters because the UI and client log should see the same events in the same order.

Main event groups:

- Session events: `session:created`
- Message events: `user:message`, `assistant:message`
- Turn events: `turn:start`, `turn:end`, `turn:cancelled`
- Tool events: `tool:requested`, `tool:start`, `tool:result`, `tool:error`
- User input bridge: `input:request`, `input:response`
- State events: `todos:updated`, `usage`
- System events: `system:warning`
- Error events: `run:error`

Add a new event only when multiple parts of the app need to react to it.

## Session And Logs

Each run creates:

```text
.backboard/sessions/<session-id>/
  client.jsonl
  server.jsonl
  meta.json
```

`client.jsonl`

The local event trace. It records every `AgentEvent`.

`server.jsonl`

The Backboard request and response trace. Sensitive headers are redacted before writing.

`meta.json`

Basic session metadata: session id, creation time, cwd, model, and profile.

Logging rules:

- Never write API keys, auth headers, or session tokens to disk.
- Keep logs ordered.
- Flush logs before exit.
- Keep local logs detailed enough to reconstruct a run.

## Backboard Provider

`src/providers/backboard/BackboardClient.ts` is the only place that should make Backboard HTTP requests.

Current endpoints:

- `POST /threads/messages`
- `POST /threads/tool-outputs`
- `GET /models`
- `GET /assistants?limit=200`
- `POST /assistants`

`src/providers/backboard/mappers.ts` converts Backboard responses into provider events consumed by `AgentLoop`.

Provider rule:

> Keep Backboard response shape knowledge inside `src/providers/backboard/`.

Do not leak raw Backboard response handling into UI, tools, or the agent scheduler.

## Tools

Concrete tools live in `src/tools/`.

Default tools are registered in `src/tools/index.ts`.

Each tool:

- Extends `Tool<I, O>`
- Has a case-sensitive `name`
- Has a Zod `inputSchema`
- Parses input through the base `Tool`
- Receives a `ToolContext`
- Returns a `ToolResult`

Tool names are part of the model contract. Do not rename them casually.

Current default tools:

- `Read`
- `Create`
- `Edit`
- `Execute`
- `Grep`
- `Glob`
- `FetchUrl`
- `WebSearch`
- `AskUser`
- `TodoWrite`
- `mcp__server__tool` adapters when MCP tools are configured and allowed

## MCP

MCP support is explicit and user-triggered in v1.

Config files:

- Project: `<repo-root>/.backboard/mcp.json`
- User: `~/.backboard/mcp.json`

User config wins over project config field-by-field. Config supports stdio servers, Streamable HTTP servers, per-server `timeoutMs`, global `timeoutMs`, `enabledTools`, `disabledTools`, and in-memory `${VAR}` / `${VAR:-fallback}` expansion. Missing variables produce `system:warning` events and do not crash startup.

The `/mcp` command opens a picker titled `Manage MCP servers`. The Ink UI calls `McpController` for curated catalog listing, manual input parsing, project config writes, source-aware disable/remove, and runtime activation. The catalog is checked-in data and does not fetch the official MCP registry or Glama at runtime. New entries are written to project `.backboard/mcp.json`, connected immediately, wrapped as `McpToolAdapter` tools, and registered in the current `ToolRegistry`. Loaded servers retain the project/user config source(s) they came from; disable writes to the highest-precedence source and remove deletes the server from its loaded source file(s). Servers that advertise `tools.listChanged` mark themselves dirty on `notifications/tools/list_changed`; before the next turn, Backboard R-CLI re-lists those servers with paginated `tools/list` calls and syncs added, removed, or changed MCP tools into the shared registry.

MCP tools are wrapped by `McpToolAdapter` and then scheduled like any other tool. Read-only/concurrency behavior comes from MCP annotations:

- `readOnlyHint: true` and not destructive: read-only and concurrency-safe
- `destructiveHint: true`: destructive and serial
- Missing annotations: conservative serial execution

HTTP MCP servers can use browser OAuth through `McpOAuthProvider`, which opens
the system browser, receives the authorization callback through a `localhost`
redirect, and stores MCP OAuth client/tokens under `~/.backboard/mcp-oauth/`
with restrictive file permissions. If the preferred callback port is occupied,
Backboard R-CLI tries the remaining callback port range before registering the OAuth client.
V1 does not include MCP resource tools or SSE transport.

## Tool Scheduling

`ToolScheduler` decides how tool calls run.

Rules:

- Read-only and concurrency-safe calls can run in parallel.
- Write, destructive, or user-interactive calls run alone and in order.
- Calls with matching command hooks run alone and in order because hook commands have no concurrency metadata.
- `PreToolUse` hooks run before each tool call and can deny or rewrite the input.
- `PostToolUse` hooks run after success or failure and can rewrite the model-visible output.
- Unknown tools return an error output instead of crashing the turn.
- Invalid arguments return an error output instead of crashing the turn.
- Cancellation throws `AbortError`.

Tool authors must mark these methods truthfully:

```ts
isReadOnly(input: I): boolean
isConcurrencySafe(input: I): boolean
isDestructive(input: I): boolean
```

The default is conservative: a tool is concurrency-safe only if it is read-only.

## UI

The UI is in `src/ui/`.

The UI should:

- Render `AppState`
- Subscribe to `EventBus`
- Call `AgentController` methods
- Parse slash commands
- Show model selection
- Show ask-user prompts
- Show status, usage, todos, messages, and tool calls

The UI should not:

- Execute tools
- Submit Backboard requests
- Mutate session internals
- Contain provider-specific logic

State projection is kept in `src/state/Store.ts` so it can be tested without rendering Ink.

## Config

`Config` merges values in this order:

```text
defaults < profile < CLI flags
```

The default profile is `coding`.

Defaults:

- Memory: `off`
- Memory profile: `code`
- Model: `openai/gpt-5.5`

Important environment variables:

- `BACKBOARD_API_KEY`
- `BACKBOARD_API_URL`
- `BACKBOARD_OAUTH_CLIENT_ID`

`BACKBOARD_API_KEY` is the default credential path. `backboard login` is an explicit OAuth path that uses the built-in first-party client id by default (`BACKBOARD_OAUTH_CLIENT_ID` overrides it; `bun run build` inlines any override into the compiled binary). The login flow uses the OAuth 2.0 device-authorization grant: it requests a device code, surfaces a verification URL and user code, polls the token endpoint until the user approves in a browser, and stores the returned personal API key in `~/.backboard/config.json`. Environment variables override that file for CI and development. OAuth client secrets are not used by the CLI.

Q-owned project, user, and session paths are built by `src/config/paths.ts`.
Core modules should ask that helper for `.backboard` paths instead of assembling them
inline.

MCP config expands environment variables in memory only. Never persist expanded secrets in `.backboard/mcp.json`.

## Prompts

Prompt modules live in `src/prompts/`.

Rules:

- System prompt text belongs in `src/prompts/system/`.
- Tool prompt text belongs in `src/prompts/tools/`.
- Keep prompts short and specific.
- Do not hide model instructions inside tool executor code.

## Adding A Tool

1. Create `src/tools/<Name>Tool.tsx`.
2. Extend `Tool<I, O>`.
3. Define a Zod schema.
4. Implement `execute`.
5. Mark read-only, concurrency-safe, and destructive behavior correctly.
6. Add a prompt module in `src/prompts/tools/`.
7. Export the prompt from `src/prompts/tools/index.tsx`.
8. Register the tool in `src/tools/index.ts`.
9. Add tests for schema, execution, and scheduler behavior when relevant.

## Adding UI Behavior

Use this path for most UI work:

1. Add or reuse an `AgentEvent`.
2. Update `src/state/Store.ts` to project that event into `AppState`.
3. Render the state in a component under `src/ui/components/`.
4. Add tests for reducer behavior when the change is stateful.

Only add direct component state when the state is purely local UI state, like an open selector or temporary input mode.

## Adding Provider Behavior

Use this path for Backboard API changes:

1. Add types in `src/providers/backboard/types.ts`.
2. Add or update request methods in `BackboardClient`.
3. Map raw responses to provider events in `mappers.ts`.
4. Keep `AgentLoop` consuming provider events, not raw HTTP responses.
5. Add mapper tests.

## Design Boundaries

Keep these boundaries strict:

- UI does not execute tools.
- Tools do not call Backboard.
- Providers do not render UI.
- Config does not run turns.
- Prompts do not belong in tool implementations.
- Session logs do not store secrets.
- Core agent code should not know Ink details.

When in doubt, pass information through an event instead of adding a cross-layer import.

## Validation

Before handing off code changes, run:

```sh
bun run validate
bun run build
```

For Backboard or tool-loop changes, also run a live smoke test when appropriate:

```sh
./backboard --print "summarize this repo"
```
