# Backboard IDE Deep Dive — Overview & Index

This folder is a deep-dive into the Backboard IDE architecture, generated from a full-codebase
investigation (July 2026). Each document covers one subsystem with file:line references and
ASCII diagrams.

## Documents

| Doc | Topic |
|---|---|
| [01-right-panel-api-flow.md](01-right-panel-api-flow.md) | How API calls are sent from the right panel of the editor |
| [02-simple-mode-agents.md](02-simple-mode-agents.md) | Simple mode and its agents / session providers |
| [03-backend-endpoints.md](03-backend-endpoints.md) | The full Backboard backend endpoint catalog |
| [04-rust-typescript-bridge.md](04-rust-typescript-bridge.md) | The `backboard-bridge` Rust/TypeScript bridge |
| [05-tool-calls.md](05-tool-calls.md) | Tool-call lifecycle, state machine, and permissions |
| [06-chat-ui.md](06-chat-ui.md) | How the chat UI is generated (data model → renderer → DOM) |
| [07-copilot-remnants.md](07-copilot-remnants.md) | What remains of GitHub Copilot in the right panel & agents |

## The three-repo picture

The `Espri-API` repo contains the whole Backboard product:

```
Espri-API/
├── main.py + app/            Python FastAPI backend  →  https://app.backboard.io/api
│                             (assistants, threads, messages, memory, models, billing, auth)
│
├── ide/
│   ├── vscode/               Backboard IDE (VS Code fork)
│   │   ├── src/vs/sessions/          the "Agents window" workbench layer (Simple mode)
│   │   ├── src/vs/workbench/         upstream workbench incl. contrib/chat (chat widget)
│   │   ├── src/vs/platform/agentHost/ agent-host protocol client + Backboard agent (node)
│   │   └── extensions/backboard/     Backboard extension; ships the Rust bridge binary
│   │
│   └── zed/                  Zed fork (Rust)
│       └── crates/
│           ├── backboard/            Rust HTTP client for the Backboard API
│           └── backboard_bridge/     `backboard-bridge` stdio JSON binary (used by vscode!)
│
├── cli/                      Backboard CLI (Python)
├── frontend/                 Web dashboard
└── sdk/                      Client SDKs
```

## High-level data flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Backboard IDE (Electron, VS Code fork)                                    │
│                                                                            │
│  ┌──────────────────────┐        ┌──────────────────────────────────────┐  │
│  │  Right panel /        │  send  │  sessions layer (src/vs/sessions)   │  │
│  │  Agents window chat   ├───────►│  sessionsManagementService          │  │
│  │  (ChatWidget, reused  │        │        │                            │  │
│  │  upstream VS Code UI) │◄───────┤        ▼ per-session provider       │  │
│  └──────────────────────┘ stream  │  ┌───────────────┬───────────────┐  │  │
│                                   │  │ agentHost      │ copilotChat   │  │  │
│                                   │  │ providers      │ sessions      │  │  │
│                                   │  └──────┬────────┴──────┬────────┘  │  │
│                                   └─────────┼───────────────┼───────────┘  │
│                                             │ WebSocket     │ ext-host      │
│                              ┌──────────────▼─────┐  ┌──────▼───────────┐  │
│                              │ Agent Host (node)  │  │ Copilot ext      │  │
│                              │ backboardAgent.ts  │  │ (CLI/cloud/      │  │
│                              └──────────┬─────────┘  │  Claude flows)   │  │
│                                         │ stdio JSON └──────────────────┘  │
│                              ┌──────────▼─────────┐                        │
│                              │ backboard-bridge   │  (Rust binary from     │
│                              │ (Rust subprocess)  │   ide/zed crates)      │
│                              └──────────┬─────────┘                        │
└─────────────────────────────────────────┼──────────────────────────────────┘
                                          │ HTTPS + SSE
                              ┌───────────▼──────────────┐
                              │  Backboard API (FastAPI) │
                              │  app.backboard.io/api    │
                              │  → LLM providers (50+)   │
                              └──────────────────────────┘
```

## Key takeaways

1. **The right panel is Backboard-owned code** in `src/vs/sessions/` — it does not depend on
   the Copilot extension (see [07-copilot-remnants.md](07-copilot-remnants.md)).
2. **Two transport paths exist**: an agent-host WebSocket protocol (local/remote agent hosts)
   and the stdio Rust bridge that proxies the Backboard HTTP API.
3. **The Rust bridge is literally built from the Zed fork's crates** and shipped inside
   `extensions/backboard/bin/backboard-bridge` — a rare case of a Zed crate powering a VS Code fork.
4. **The chat UI is Microsoft's upstream chat widget** (`vs/workbench/contrib/chat`), wrapped by
   Backboard composers, pickers, and CSS in the sessions layer.
5. **"Simple mode" is the Agents window**, toggled in the title bar against "Editor" mode.
