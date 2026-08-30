# Replacing the Backboard Backend with `cli-ts` — Integration Plan

**Goal:** remove the Backboard-native agent path in the IDE (the Rust `backboard-bridge` +
`backboardAgent.ts`, which run the agent loop as a thin proxy while the *workbench* executes tools)
and replace it with **`cli-ts`** (`backboard-r-cli` v3.0.0), a self-contained TypeScript/Bun coding
agent that owns the whole loop **and runs its own tools**. cli-ts is the more actively maintained
runtime, so the IDE should become a thin client over it.

This folder has four docs:

| Doc | Purpose |
|---|---|
| `00-integration-plan.md` (this) | Architecture decision, the full connection map, phases, risks |
| `01-cli-ts-tool-calls.md` | Every cli-ts tool, where its code lives, safety flags, how each maps into the IDE |
| `02-wire-protocol-and-seam.md` | The new cli-ts **serve** protocol + the exact IDE files to change/delete/add |
| `PROMPT.md` | A single self-contained prompt that instructs an agent to carry out the migration |

cli-ts has already been vendored into the IDE at **`ide/vscode/cli-ts/`** (457 files, extracted from
`origin/equity:cli-ts`).

---

## 1. The two runtimes side by side

The fundamental difference — and the reason this is a real migration, not a drop-in — is **who
executes tools**.

```
 TODAY  (Rust bridge model)                        cli-ts  (owns-the-loop model)
 ─────────────────────────                         ────────────────────────────
 backboardAgent.ts (node)                          cli-ts process (Bun)
   spawns backboard-bridge (Rust)                    AgentController → AgentLoop
   bridge = dumb proxy to Backboard API              ToolScheduler runs tools IN-PROCESS
   ── toolRequested ──►  WORKBENCH runs the tool     Read/Edit/Execute/… hit the FS + shell directly
   ◄─ submitToolResult ─  (edit/terminal/approval    emits AgentEvent JSON stream
       all rendered by vs/workbench/contrib/chat)    (assistant:delta, tool:*, input:request, …)
   bridge runs ONLY web_search / web_fetch natively  bridge runs ALL tools; only AskUser round-trips
```

- **Rust bridge:** `src/vs/platform/agentHost/node/backboard/backboardAgent.ts` spawns
  `extensions/backboard/bin/backboard-bridge`; the workbench owns tool execution and the rich tool
  UX (approval carousels, embedded terminal, per-tool diff). See `bb-docs/deep-dive/04` and `/05`.
- **cli-ts:** `ide/vscode/cli-ts/src/entrypoints/cli.tsx` builds `AgentController` (owns the turn),
  `ToolScheduler` (runs tools), `ToolRegistry` (14 built-in tools + MCP), and emits everything as a
  typed `AgentEvent` stream (`src/core/bus/events.ts`). A `JsonEventStream`
  (`src/core/session/JsonEventStream.ts`) already serializes that stream to stdout under
  `--format json`.

---

## 2. Architecture decision

There are two ways to graft cli-ts in. **We recommend Strategy B.**

### Strategy A — "bridge-shaped adapter" (rejected)

Make cli-ts pretend to be the Rust bridge: add an NDJSON `sendPrompt/submitToolResult/listTools`
command surface to cli-ts, and have cli-ts **delegate tool execution back to the workbench** (client
tools). Keeps `backboardAgent.ts` mostly intact and preserves today's tool UX.

- ✗ Fights cli-ts's design — cli-ts's whole value is its own maintained tool suite; delegating tools
  back to the IDE throws that away and re-creates the split we're trying to delete.
- ✗ Large, ongoing churn inside cli-ts (a client-tool round-trip it doesn't want).

### Strategy B — "cli-ts owns the loop and tools" (recommended)

cli-ts runs the full loop and executes tools directly in the workspace `cwd`. The IDE spawns cli-ts
in a new **persistent serve mode** and becomes a renderer: it maps the `AgentEvent` stream onto the
chat model / tool-invocation UI, drives its Changes/Review view by diffing the working tree against a
per-turn checkpoint, and answers approvals/AskUser over a control channel.

- ✓ Matches how the IDE **already** hosts an external CLI agent that runs its own tools — the Copilot
  CLI via `@github/copilot/sdk` (`CopilotCLISession`, `bb-docs/deep-dive/07`). We are doing the same
  thing for the Backboard-native path.
- ✓ cli-ts stays upstream-maintainable; the IDE shrinks.
- ⚠ The IDE's richest tool UX (live embedded terminal, per-tool approval carousel) must now be driven
  from cli-ts events rather than workbench-side execution. Some fidelity is rebuilt (below); some
  degrades to output rendering.

Everything below assumes Strategy B.

---

## 3. The connection map (where everything is connected)

```
┌───────────────────────── Backboard IDE (Electron / VS Code fork) ─────────────────────────┐
│                                                                                           │
│  sessions layer  (src/vs/sessions)                                                        │
│    LocalAgentHostSessionsProvider  ── session type 'agent-host-backboard'                  │
│           │  sendRequest → chatService → agent-host protocol (bb-docs/deep-dive/01)        │
│           ▼                                                                                │
│  agent host process (node)  src/vs/platform/agentHost/node/agentHostMain.ts               │
│    :185  agentService.registerProvider(createInstance( BackboardAgent ))   ◄── SWAP HERE   │
│           │                                                                                │
│    ┌──────┴──────────────────────────────────────────────────────────────────────┐       │
│    │  REPLACE  BackboardAgent  with  CliTsAgent                                     │       │
│    │  (src/vs/platform/agentHost/node/backboard/backboardAgent.ts →                 │       │
│    │   src/vs/platform/agentHost/node/cliTs/cliTsAgent.ts)                          │       │
│    │    • spawns cli-ts serve process instead of backboard-bridge                   │       │
│    │    • translates AgentEvent  ⇄  agent-host actions / IChatProgress              │       │
│    │    • forwards approvals + AskUser over the control channel                      │       │
│    └──────┬──────────────────────────────────────────────────────────────────────┘       │
│           │  NDJSON control (stdin)  +  JsonEventStream (stdout)                            │
└───────────┼────────────────────────────────────────────────────────────────────────────────┘
            ▼
┌──────────── cli-ts serve process (Bun)  ide/vscode/cli-ts ────────────────────────────────┐
│  NEW  src/entrypoints/serve.ts   (persistent; reuses Config/EventBus/AgentController)       │
│    stdin  ◄── {op:"submit"|"cancel"|"respondInput"|"respondPermission"|"setModel"|"dispose"}│
│    stdout ──► JsonEventStream records  {type, payload: AgentEvent}                          │
│           │                                                                                 │
│    AgentController → AgentLoop → ToolScheduler → ToolRegistry (14 tools + MCP)              │
│           │                    │                                                            │
│    BackboardClient ────────────┼──────────────► Backboard API (POST /threads/messages,     │
│    (src/providers/backboard)   │                 /threads/tool-outputs, GET /models, …)     │
│           tools run HERE ───────┘  Read/Edit/Execute on cwd; edits land on disk             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3a. IDE side — files to change / delete

| File | Change |
|---|---|
| `src/vs/platform/agentHost/node/agentHostMain.ts:185` | register `CliTsAgent` instead of `BackboardAgent` (feature-flag both during transition) |
| `src/vs/platform/agentHost/node/agentHostServerMain.ts` | same swap for the remote/server agent host |
| `src/vs/platform/agentHost/node/backboard/backboardAgent.ts` | **delete** after cutover (this is the Rust-bridge driver); replaced by `node/cliTs/cliTsAgent.ts` + `cliTsProcess.ts` |
| `src/vs/platform/agentHost/test/node/backboardAgent.test.ts` | replace with `cliTsAgent.test.ts` |
| `extensions/backboard/package.json` | replace the `build-bridge`/`package-bridge`/`prepare-bridge` cargo scripts with a `bun build --compile` step; change `files` from `bin/backboard-bridge` to the cli-ts bundle |
| `extensions/backboard/rust/` | **delete** after cutover (the Rust bridge crate) |
| `ide/vscode/cli` (Rust CLI crate) | out of scope for the bridge swap, but review — it is separate from `backboard_bridge` |
| Persistence `~/.backboard_ide/` (`backboardAgent.ts` config/threads/panel-state) | reconcile with cli-ts's `~/.backboard/` + `.backboard/sessions/` (doc 02 §Config) |

The **provider/session-type layer does not change**: `LocalAgentHostSessionsProvider`, session type
`agent-host-backboard`, `sessionsManagementService`, and the whole `bb-docs/deep-dive/01` send path
stay. Only the agent-host *agent* behind them changes.

### 3b. cli-ts side — files to add / touch

| File | Change |
|---|---|
| `src/entrypoints/serve.ts` (**new**) | persistent NDJSON control loop; reuse `Config`, `EventBus`, `AgentController`, `JsonEventStream`; add `listModels`/`listTools`/`respondInput`/`respondPermission`/`cancel`/`setModel`/`dispose` ops |
| `src/config/flags.ts` | add a `--serve` flag; `cli.tsx` dispatches to `serve.ts` when set |
| `src/entrypoints/cli.tsx:268-290` | branch to serve mode before the one-shot headless/UI branches |
| `src/core/tools/ToolScheduler.ts` / `ToolPolicy.ts` | add a **permission gate** callback so serve mode can emit a `permission:request` and await a control-channel decision (or route through the existing `askUser` bridge) |
| `src/core/bus/events.ts` | add `permission:request` / `permission:response` (or reuse `input:request`) |
| `src/providers/backboard/*` | none functionally — already targets the same API; ensure env/auth is injected from the IDE (doc 02) |

---

## 4. Event & control mapping (cli-ts ⇄ IDE chat model)

The IDE's chat model consumes `IChatProgress` items / agent-host actions (`bb-docs/deep-dive/01`,
`/05`). `CliTsAgent` translates the `AgentEvent` stream into them:

| cli-ts `AgentEvent` (`events.ts`) | IDE chat-model effect |
|---|---|
| `session:created {sessionId, threadId}` | bind session ↔ backend thread |
| `turn:start {turnId}` | begin response / `ChatTurnStarted` |
| `assistant:delta {text}` | append `markdownContent` delta (streamed) |
| `assistant:message {text}` | finalize message text |
| `assistant:message:discard` | drop a superseded streamed message |
| `tool:requested {calls[]}` | create `IChatToolInvocation` per call — `Streaming` |
| `tool:pending {toolCallId,name,inputSummary}` | `WaitingForConfirmation` (if approval needed) |
| `tool:start {name,inputSummary,agentMode?}` | `Executing` |
| `tool:progress {toolCallId,data}` | `state.progress` observable |
| `tool:result {title,detail,detailLines,agentOutput?}` | `Completed` (+ file-edit → changeset, §5) |
| `tool:error {error}` | `Completed`(error) / `Cancelled` |
| `agent:child_tool_start/result` | nested sub-agent tool rows (`subagent` toolSpecificData) |
| `turn:end {status,durationMs}` | `ChatTurnComplete` (map status: completed/failed/cancelled) |
| `turn:cancelled` | cancelled turn |
| `input:request {question,options}` | confirmation / elicitation UI → answer via `respondInput` |
| `permission:request` (new) | approval carousel → answer via `respondPermission` |
| `todos:updated {todos[]}` | todo-list tool part |
| `usage {inputTokens,outputTokens,…}` | usage footer |
| `system:warning {message}` | warning notice |
| `run:error {error}` | `ChatError` action |

Control channel (IDE → cli-ts serve): `submit(prompt, model?, thinking?, excludedTools?)`, `cancel`,
`respondInput(id, answer)`, `respondPermission(id, decision)`, `setModel(model)`, `dispose`. Full
spec in doc 02.

---

## 5. Tool execution & UX rebinding (Strategy B specifics)

Because cli-ts runs tools itself, the IDE rebinds its tool UX to cli-ts's event stream and to the
filesystem:

- **File edits (Write / Edit / ApplyPatch):** cli-ts writes to disk in `cwd`. The IDE drives its
  Changes/Review view (`ISessionChangeset`, `bb-docs/deep-dive/05` §"File-edit tools") by **diffing
  the working tree against a per-turn checkpoint** (git tree snapshot / stash taken at `turn:start`).
  cli-ts's `tool:result.detailLines` already carries a diff summary to seed the pill.
- **Terminal (Execute):** render `tool:start`/`tool:progress`/`tool:result` as a terminal tool part.
  A live embedded terminal (today's `ChatTerminalToolProgressPart`) is not free — either render
  captured output, or add streamed stdout to `tool:progress` in cli-ts for closer fidelity.
- **AskUser:** `input:request` → the IDE's confirmation/elicitation UI; answer via `respondInput`.
- **Approvals / permission levels:** today's `ChatPermissionLevel` (default/autoApprove/autopilot,
  `bb-docs/deep-dive/05`) and the per-session mode (interactive/plan/autopilot) map to a serve-mode
  **permission policy**: the IDE passes the level at `submit`, and cli-ts emits `permission:request`
  for calls that need confirmation. `--excluded-tools` hides tools (e.g. plan mode → exclude
  Write/Edit/Execute/ApplyPatch).
- **Browser / Computer:** cli-ts has its own `Browser` and `Computer` tools that overlap the IDE's
  Browser tab and computer-use. Decide per tool: either let cli-ts own them, or hide them
  (`--excluded-tools Browser,Computer`) and keep the IDE's. Recommended v1: hide, keep the IDE's.
- **MCP / skills / hooks:** these now live in cli-ts (`.backboard/mcp.json`, `~/.backboard/hooks.json`,
  `.agents/skills`). Point the IDE's customization UI (`aiCustomizationTreeView`) at cli-ts's config
  locations, or defer MCP/skill management to cli-ts entirely for v1.

---

## 6. Model & session-config mapping

| IDE concept (`bb-docs/deep-dive/02`) | cli-ts input |
|---|---|
| selected model id (model picker) | `submit(model)` / `setModel` → cli-ts `--model provider/model` |
| session mode `interactive` | full tools, approvals on per permission level |
| session mode `plan` | `--excluded-tools Write,Edit,ApplyPatch,Execute` + read-only posture |
| session mode `autopilot` | permission policy = auto-approve |
| `ChatPermissionLevel` default/autoApprove/autopilot | serve-mode permission policy (emit vs auto-answer `permission:request`) |
| thinking / intensity | cli-ts `--thinking <level>` |
| workspace folder | cli-ts `--cwd <path>` (per session) |
| memory | cli-ts `--memory <mode>` |
| API key / URL | env `BACKBOARD_API_KEY` / `BACKBOARD_API_URL` injected into the spawn (doc 02 §Config) |

Model & tool **pickers** in the IDE should be fed by cli-ts `listModels` / `listTools` control ops
(cli-ts already has `BackboardClient.getModels()` and `ToolRegistry.list()`), replacing the bridge's
`listModels`/`listTools`.

---

## 7. Phased rollout

```
 Phase 0  Vendoring (DONE)         cli-ts at ide/vscode/cli-ts
 Phase 1  Build & package          bun build --compile → per-platform binary; wire into
                                    extensions/backboard packaging; path resolution
 Phase 2  cli-ts serve mode        src/entrypoints/serve.ts + control protocol + permission gate
                                    + listModels/listTools ops; unit tests
 Phase 3  IDE CliTsAgent           new node/cliTs/cliTsAgent.ts implementing the agent-host agent
                                    interface; event translation; register behind a setting flag
 Phase 4  Tool/UX rebind           changeset-from-FS diff, terminal rendering, approvals, AskUser,
                                    model/tool pickers from cli-ts
 Phase 5  Cutover & delete         flip the flag on by default; delete backboardAgent.ts,
                                    extensions/backboard/rust, bin/backboard-bridge; update docs
```

Run Phases 3–4 behind a boolean setting (e.g. `backboard.agent.runtime: 'bridge' | 'cli-ts'`) so you
can A/B the two runtimes on the same `agent-host-backboard` session type before deleting the Rust
path.

---

## 8. Risks & open decisions

| Risk / decision | Notes |
|---|---|
| **Bun runtime packaging** | cli-ts is Bun. Ship a `bun build --compile` standalone binary per platform (macOS arm64/x64, win x64, linux x64/arm64) — a build matrix comparable to the cargo cross-compile it replaces. Alternatively require a bundled `bun`. Decide in Phase 1. |
| **Tool UX parity** | Live embedded terminal + per-tool approval carousel were workbench-executed. With cli-ts owning tools, they are driven from events; live terminal fidelity needs streamed stdout in `tool:progress`. |
| **Approval/security parity** | Tool execution moves into the cli-ts process with cli-ts's permission model. Build the `permission:request` gate so the IDE's approval levels still hold. |
| **Changes/Review source** | Must switch from AHP changeset events to FS-diff-vs-checkpoint. Ensure a reliable per-turn snapshot (git). |
| **MCP/skills ownership** | Moves to cli-ts config files; reconcile with the IDE's customization UI or defer to cli-ts. |
| **Credentials & paths** | cli-ts uses `~/.backboard/config.json`; IDE uses `~/.backboard_ide/`. Inject env at spawn; pick one on-disk source of truth (doc 02 §Config). |
| **Multi-turn thread continuity** | serve mode must keep one `AgentController`/thread across turns (cli-ts `AssistantSessionBinding` already does this); verify cancel does not submit partial tool outputs (cli-ts guarantees this — `AGENTS.md`). |
| **Remote agent hosts** | `agentHostServerMain.ts` also registers the agent; the cli-ts binary must be present in remote/tunnel environments too. |

See `02-wire-protocol-and-seam.md` for the concrete protocol and file-level changes, and
`01-cli-ts-tool-calls.md` for the tool inventory and per-tool mapping.
