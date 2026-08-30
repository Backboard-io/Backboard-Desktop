# The Serve Protocol & the IDE Seam

This doc specifies (a) the new **cli-ts serve protocol** the IDE will speak, and (b) the exact
IDE-side seam — what `CliTsAgent` replaces and how it plugs into the agent host. Read
`00-integration-plan.md` first for the architecture decision.

## 1. Why a new "serve" mode is needed

cli-ts's existing headless JSON mode is **one-shot** (`src/entrypoints/cli.tsx:268-290`,
`runHeadless` `:403`): it reads a single prompt (`--print` or piped stdin), runs
`controller.submit(prompt)` once, flushes, and exits. `JsonEventStream`
(`src/core/session/JsonEventStream.ts`) writes one JSONL record per bus event to stdout, but there is
**no channel to send follow-up turns, cancel, answer AskUser, or change the model**. The IDE needs a
long-lived session with many turns.

So Phase 2 adds `src/entrypoints/serve.ts`: same `Config`/`EventBus`/`AgentController`/`JsonEventStream`
wiring as `cli.tsx`, but instead of one `submit`, it runs a **persistent NDJSON control loop** on
stdin while streaming `JsonEventStream` records on stdout.

```
 IDE  (CliTsAgent, node)                         cli-ts serve (Bun)
 ─────────────────────────                       ────────────────────
 stdin  ── {op:"submit", prompt, model?, …}\n ──►  AgentController.submit(prompt)
 stdout ◄── {type:"turn:start", payload:{…}}\n ──   JsonEventStream (bus.onAny)
 stdout ◄── {type:"assistant:delta", …}\n     ──
 stdout ◄── {type:"tool:requested", …}\n      ──
 stdout ◄── {type:"input:request", …}\n       ──   AskUser (ctx.askUser)
 stdin  ── {op:"respondInput", id, answer}\n  ──►  input:response → tool continues
 stdout ◄── {type:"tool:result", …}\n         ──
 stdout ◄── {type:"turn:end", status}\n       ──
 stdin  ── {op:"cancel"}\n                    ──►  controller.cancel()
 stdin  ── {op:"dispose"}\n                   ──►  flush + exit
```

## 2. Control channel (IDE → cli-ts), stdin NDJSON

One JSON object per line. Proposed ops:

```ts
type ServeControl =
  | { op: "submit"; requestId: string; prompt: string;
      model?: string; thinking?: string; excludedTools?: string[];
      permission?: "default" | "autoApprove" | "autopilot" }
  | { op: "cancel"; requestId?: string }
  | { op: "respondInput"; id: string; answer: string }         // answers input:request (AskUser)
  | { op: "respondPermission"; id: string; decision: "approve" | "deny"; reason?: string }
  | { op: "setModel"; model: string }
  | { op: "listModels"; requestId: string }                    // → emits a models record
  | { op: "listTools"; requestId: string }                     // → emits a tools record
  | { op: "dispose" };
```

- `submit` maps to `AgentController.submit(prompt)`; the per-turn `model`/`thinking`/`excludedTools`/
  `permission` become local per-turn overrides (cli-ts already supports per-turn `system_prompt`/
  `tools` overrides without resetting the thread — `ARCHITECTURE.md` §Turn Flow).
- `cancel` maps to `controller.cancel({ clearQueue: true })` (`cli.tsx:311`).
- `respondInput` resolves an outstanding `input:request` (drives `AgentController`'s
  `input:response`, `AgentController.ts:402`).
- `respondPermission` resolves a `permission:request` (new gate, doc 01).
- `listModels` → `BackboardClient.getModels()`; `listTools` → `ToolRegistry.list()`.

## 3. Event channel (cli-ts → IDE), stdout JSONL

Unchanged from today's `JsonEventStream` record shape (`JsonEventStream.ts:4-11`):

```ts
interface JsonEventRecord {
  timestamp: string;
  session_id: string;
  sequence: number;                 // monotonic — use for ordering
  source: "client";
  type: AgentEvent["type"];
  payload: AgentEvent;              // the full event (src/core/bus/events.ts)
}
```

The full `AgentEvent` union (23 members) and its IDE mapping are in `00-integration-plan.md` §4. Two
new members to add for serve mode:

```ts
| { type: "permission:request"; request: { id: string; toolCallId: string; name: string; inputSummary: string } }
| { type: "permission:response"; response: { id: string; decision: "approve" | "deny" } }
```

`stdout` must stay pure JSONL in serve mode (no Ink, no logs) — cli-ts already reserves stdout for
machine output in JSON mode (`AGENTS.md` §UI Rules). Route all human/log text to stderr.

## 4. Session & turn semantics

- **One serve process per IDE agent-host session.** The IDE's `agent-host-backboard` session ↔ one
  cli-ts process ↔ one Backboard thread (kept stable by `AssistantSessionBinding`).
- **Multi-turn:** each IDE user message → one `submit` op → one `turn:start … turn:end` cycle. The
  thread persists across turns.
- **Cancellation:** `cancel` → `AbortSignal` propagates to the Backboard request and running tools;
  cli-ts guarantees no partial/stale tool outputs are submitted (`AGENTS.md`).
- **Backpressure/ordering:** rely on `sequence`; the IDE processes records in order.
- **Lifecycle:** `dispose` flushes logs (`clientLog`/`serverLog`) and closes MCP transports (mirror
  `cli.tsx`'s `flush()` `:258`), then exits.

## 5. The IDE seam — what `CliTsAgent` replaces

### 5a. The single registration line

`src/vs/platform/agentHost/node/agentHostMain.ts:185`:

```ts
agentService.registerProvider(instantiationService.createInstance(BackboardAgent));
//                                                                 ^^^^^^^^^^^^^^ swap → CliTsAgent
```

Same line exists in `agentHostServerMain.ts` for the remote/server agent host. Behind a setting
(`backboard.agent.runtime: 'bridge' | 'cli-ts'`) register one or the other during transition.

### 5b. New files (mirror the bridge's structure)

```
 src/vs/platform/agentHost/node/backboard/backboardAgent.ts   (Rust-bridge driver — DELETE at cutover)
        │  becomes
        ▼
 src/vs/platform/agentHost/node/cliTs/
   cliTsAgent.ts      implements the agent-host agent interface (createSession, sendMessage,
                      listModels, listTools, cancel, disposeSession) — the same interface
                      BackboardAgent implements today. Translates AgentEvent ⇄ AHP actions.
   cliTsProcess.ts    spawns & supervises the cli-ts serve subprocess (mirror BackboardBridgeProcess,
                      backboardAgent.ts:2148): _resolveCliTsPath(), spawn, stdout readline → records,
                      stderr → log, control writer, dispose/reject-on-exit.
   cliTsProtocol.ts   the ServeControl / JsonEventRecord types + a small mapper AgentEvent→IChatProgress.
```

`CliTsAgent` keeps the same **outer contract** as `BackboardAgent` (so `LocalAgentHostSessionsProvider`,
the session type `agent-host-backboard`, and the send path in `bb-docs/deep-dive/01` are untouched).
What changes is the *inside*: instead of the NDJSON `sendPrompt/submitToolResult` command protocol
with workbench-side tool execution, it speaks the serve protocol and lets cli-ts run tools.

### 5c. Binary resolution (mirror `_resolveBridgePath`)

`backboardAgent.ts:2249` resolves `extensions/backboard/bin/backboard-bridge`. `cliTsProcess.ts`'s
`_resolveCliTsPath()` resolves the packaged cli-ts binary instead, e.g.:

1. env `BACKBOARD_CLI_TS_PATH` / `VSCODE_BACKBOARD_CLI_TS_PATH`
2. `<appRoot>/extensions/backboard/bin/backboard-cli-ts(.exe)` (the `bun build --compile` output)
3. dev fallback: run `bun run <appRoot>/cli-ts/src/entrypoints/serve.ts` when a dev flag is set

Spawn with `--serve` (and `--cwd <workspaceFolder>`), `stdio: ['pipe','pipe','pipe']`, and the
credential env injected (§6).

## 6. Config, credentials & paths

| Concern | Rust-bridge today | cli-ts |
|---|---|---|
| API key | `~/.backboard_ide/config.json` / `BACKBOARD_API_KEY` (`backboardAgent.ts:2876`) | `~/.backboard/config.json` / `BACKBOARD_API_KEY` (`cli-ts` README §Env) |
| API URL | `BACKBOARD_API_URL` | `BACKBOARD_API_URL` (default prod) |
| threads/transcripts | `~/.backboard_ide/threads/…` | `.backboard/sessions/<id>/` (client/server jsonl) |
| panel state | `~/.backboard_ide/panel-state.json` | n/a (IDE keeps its own) |

**Recommendation:** at spawn, inject `BACKBOARD_API_KEY` / `BACKBOARD_API_URL` from the IDE's existing
credential source into the cli-ts process env so cli-ts needs no separate login. Keep the IDE as the
source of truth for auth; cli-ts's `~/.backboard/config.json` is a fallback for standalone use. Point
cli-ts session logs under the workspace `.backboard/sessions/` (already git-ignored) or redirect via
config if you want them centralized.

## 7. Packaging (`extensions/backboard`)

Today (`extensions/backboard/package.json`):

```json
"prepare-bridge": "sh -c 'if command -v cargo …; then npm run package-bridge; …'",
"build-bridge":   "cargo build --manifest-path ./rust/Cargo.toml -p backboard_bridge",
"package-bridge": "npm run build-bridge && mkdir -p ./bin && cp ./rust/target/debug/backboard-bridge ./bin/backboard-bridge && chmod 755 ./bin/backboard-bridge",
"files": ["out/**", "media/**", "bin/**", "package.json"]
```

After migration, replace the cargo steps with a Bun compile of cli-ts:

```json
"build-cli-ts":   "bun install --cwd ../../cli-ts && bun build --compile ../../cli-ts/src/entrypoints/cli.tsx --outfile ./bin/backboard-cli-ts",
"prepare-cli-ts": "sh -c 'if command -v bun >/dev/null 2>&1; then npm run build-cli-ts; else echo \"Skipping cli-ts build: bun not found.\"; fi'"
```

Keep `files: ["out/**","media/**","bin/**","package.json"]` — now `bin/` holds `backboard-cli-ts`.
Delete `extensions/backboard/rust/` and the `bin/backboard-bridge` output once the cli-ts path is the
default. Cross-platform: run the `bun build --compile` per target in CI (macOS arm64/x64, win x64,
linux x64/arm64), same matrix idea as the cargo cross-compile.

## 8. Validation checklist

- `cd ide/vscode/cli-ts && bun install && bun run validate && bun run build` passes.
- serve mode: `printf '{"op":"submit","requestId":"1","prompt":"list files"}\n{"op":"dispose"}\n' | bun run src/entrypoints/serve.ts --serve --cwd /some/repo` streams JSONL records and exits cleanly.
- IDE: with `backboard.agent.runtime: 'cli-ts'`, an `agent-host-backboard` session sends a message,
  streams assistant text, shows tool calls, edits a file, and the Changes/Review view shows the diff.
- Cancel mid-turn leaves no partial tool outputs; the thread survives across turns.
- Model picker and tool list populate from cli-ts `listModels`/`listTools`.
- Remove the Rust path (`backboardAgent.ts`, `extensions/backboard/rust`, `bin/backboard-bridge`) and
  confirm no dangling imports (`grep -rn backboardAgent src/vs`).
