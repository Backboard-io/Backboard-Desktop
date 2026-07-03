# Backboard IDE Deep Dive — Overview & Index

This folder is a deep-dive into the Backboard IDE architecture, **re-verified against the current
source** (branch `f-ide`, July 2026). Every claim carries a `file:line` anchor. The re-verification
pass corrected several facts from the earlier draft — see **"Corrections from re-verification"** below.

## Documents

| Doc | Topic |
|---|---|
| [01-right-panel-api-flow.md](01-right-panel-api-flow.md) | How a chat request travels from the composer to the network (7 layers) |
| [02-simple-mode-agents.md](02-simple-mode-agents.md) | Simple mode, session providers, session types, and the three "mode" axes |
| [03-backend-endpoints.md](03-backend-endpoints.md) | The Backboard FastAPI endpoint catalog + middleware |
| [04-rust-typescript-bridge.md](04-rust-typescript-bridge.md) | The `backboard-bridge` Rust/TypeScript stdio bridge |
| [05-tool-calls.md](05-tool-calls.md) | Tool-call data model, state machine, permissions, execution, renderers |
| [06-chat-ui.md](06-chat-ui.md) | How the chat UI is generated (data model → renderer → DOM) |
| [07-copilot-remnants.md](07-copilot-remnants.md) | What remains of GitHub Copilot in the right panel & agents |
| [08-right-workbench-tabs.md](08-right-workbench-tabs.md) | The right panel shell: auxiliary bar + Review/Terminal/Browser/Files tabs |
| [09-streaming-sse-protocol.md](09-streaming-sse-protocol.md) | End-to-end streaming grammar: backend SSE → bridge NDJSON → chat model |

## The monorepo picture

The `Espri-API` repo contains the whole Backboard product:

```
Espri-API/
├── main.py + app/            Python FastAPI backend  →  https://app.backboard.io/api
│                             (assistants, threads/messages, memory, models, billing, auth, oauth)
│                             DB: MySQL / AWS RDS    Cache: Redis    Vectors: Turbopuffer
│
├── ide/
│   ├── vscode/               Backboard IDE (VS Code fork)  ← THIS repo
│   │   ├── src/vs/sessions/          the "Agents window" workbench layer (Simple mode)
│   │   ├── src/vs/workbench/         upstream workbench incl. contrib/chat (chat widget)
│   │   ├── src/vs/platform/agentHost/ agent-host protocol client + CliTsAgent (node)
│   │   ├── cli-ts/                   backboard-r-cli — the TS agent runtime the IDE spawns
│   │   └── extensions/backboard/     Backboard extension; ships backboard-cli-ts (+ legacy
│   │                                 vendored bridge crates in rust/, webview-only, pending removal)
│   │
│   └── zed/                  Zed fork (Rust) — SEPARATE product, NOT used by the IDE.
│                             The vscode build has no dependency on this folder; the legacy
│                             bridge crates were vendored into extensions/backboard/rust/.
│
├── cli/                      Backboard CLI (Python)
├── frontend/                 Web dashboard (session-cookie API twin: /api/chat/*)
├── sdk/                      Client SDKs
└── migrations/               DB migrations
```

## High-level data flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Backboard IDE (Electron, VS Code fork)                                     │
│                                                                             │
│  ┌──────────────────────┐  send  ┌──────────────────────────────────────┐  │
│  │  Composer / chat      ├───────►│  sessions layer (src/vs/sessions)   │  │
│  │  (upstream ChatWidget │        │  sessionsManagementService.sendRequest│ │
│  │   wrapped by BB)      │◄───────┤        │ per-session provider        │  │
│  └──────────────────────┘ stream  │  ┌───────────────┬───────────────┐  │  │
│                                   │  │ agentHost      │ copilotChat   │  │  │
│                                   │  │ providers      │ sessions      │  │  │
│                                   │  └──────┬────────┴──────┬────────┘  │  │
│                                   └─────────┼───────────────┼───────────┘  │
│                            local: in-proc   │ remote: wss   │ ext-host      │
│                            IAgentHostService │               │               │
│                              ┌──────────────▼─────┐  ┌──────▼───────────┐   │
│                              │ Agent Host (node)  │  │ Copilot ext      │   │
│                              │ backboardAgent.ts  │  │ (CLI/cloud/      │   │
│                              └──────────┬─────────┘  │  Claude flows)   │   │
│                                         │ stdio NDJSON└──────────────────┘   │
│                              ┌──────────▼─────────┐                         │
│                              │ backboard-bridge   │  (Rust binary built     │
│                              │ (Rust subprocess)  │   from ide/zed crates)  │
│                              └──────────┬─────────┘                         │
└─────────────────────────────────────────┼──────────────────────────────────┘
                                          │ HTTPS + SSE (reqwest)
                              ┌───────────▼──────────────┐
                              │  Backboard API (FastAPI) │
                              │  app.backboard.io/api    │
                              │  → 50+ LLM providers     │
                              │    (via LangChain/Graph) │
                              └──────────────────────────┘
```

## Two transports, one funnel

Every outgoing chat request goes through **one funnel** —
`SessionsManagementService.sendRequest` (`src/vs/sessions/services/sessions/browser/sessionsManagementService.ts:451`) —
then fans out to a per-session provider. There are two live transports:

1. **Agent-host protocol** — a JSON-RPC channel (`RemoteAgentHostProtocolClient`) that is either
   in-process (`local-agent-host`, no socket) or a **WebSocket** (`agenthost-*`, remote hosts).
   Backboard-native sessions route here → `backboardAgent.ts` → the Rust bridge.
2. **Extension host** — legacy Copilot CLI / cloud / Claude Code session flows that still call into
   the bundled `extensions/copilot` extension (see [07](07-copilot-remnants.md)).

## Key takeaways

1. **The right panel is Backboard-owned code** in `src/vs/sessions/` — it has zero imports from
   `extensions/copilot` (see [07](07-copilot-remnants.md), [08](08-right-workbench-tabs.md)).
2. **The chat UI is Microsoft's upstream `ChatWidget`** (`vs/workbench/contrib/chat`), wrapped by
   Backboard composers, delegates, and CSS in the sessions layer ([06](06-chat-ui.md)).
3. **The agent-host Backboard runtime is now cli-ts** (July 2026): `CliTsAgent`
   (`src/vs/platform/agentHost/node/cliTs/`) spawns `backboard-cli-ts --serve` (built from
   `ide/vscode/cli-ts/`), which owns the agent loop and executes its own tools; the IDE renders its
   JSONL event stream. The Rust `backboard-bridge` remains only for the extension webview
   ([04](04-rust-typescript-bridge.md), `bb-docs/cli-ts-migration/`).
4. **"Simple mode" is a window toggle** (Editor ↔ Agents window). It is *distinct* from the
   per-session execution `mode` (interactive/plan/autopilot) and from the runtime's tool-access
   mapping (manual → interactive approvals) — orthogonal axes, easily confused
   ([02](02-simple-mode-agents.md)).

## Corrections from re-verification (vs. the earlier draft)

These were wrong or stale in the prior version of this folder and are fixed in the current docs:

| Was | Actually |
|---|---|
| Backend DB "Postgres" | **MySQL / AWS RDS** (PyMySQL/aiomysql; `app/core/database.py`) |
| Email "SendGrid" | **Resend** (+ Gmail SMTP fallback); `app/core/config.py:114` |
| "middleware: IP blocking → CORS → CSRF" | IPBlock → CORS → request-timing; **no CSRF** middleware (public, credential-less CORS) |
| Bridge "~25 API proxy commands" | The Rust bridge dispatches **9 commands** (`main.rs:173-255`); CRUD proxy commands are **not** wired — `callApi` currently no-ops |
| Bridge config `~/.backboard/config.json` | **`~/.backboard_ide/config.json`** (both TS and Rust) |
| `SendPromptParams` fields `audio_file/image_file/files/tools` | current struct has `mcp_calls`, no `files/tools` (`main.rs:76-106`); `tools` is recomputed server-side |
| Session types `copilotcli` / generic "cloud"/"claude" | real IDs: `copilotcli`, `copilot-cloud-agent`, `claude-code`, `local`, `agent-host-backboard` |
| Add-message endpoint `threads.py:1506` | `add_message_to_thread` is **`threads.py:802`**; `:1506` is `submit-tool-outputs` |
| WebSocket token `?connectionToken=` | query param is **`tkn`** (`connectionTokenQueryName`); bare address defaults to **`ws://`** |
