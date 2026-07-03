# Migration Prompt — Replace the Backboard Rust Bridge with `cli-ts`

Copy everything below the line into a fresh agent session (Claude Code / Backboard) running at the
repo root `Espri-API/ide/vscode`. It is self-contained.

---

You are migrating the Backboard IDE (a VS Code fork at `Espri-API/ide/vscode`) off its Backboard-native
Rust agent bridge and onto **`cli-ts`** (`backboard-r-cli` v3.0.0), a self-contained TypeScript/Bun
coding agent already vendored at `ide/vscode/cli-ts/`. cli-ts is the maintained runtime and it **owns
its own agent loop and executes its own tools** — unlike the Rust bridge, where the workbench executed
tools. The IDE becomes a thin renderer over cli-ts's event stream.

Read these first (they contain every file:line you need):
- `bb-docs/cli-ts-migration/00-integration-plan.md` — architecture decision (Strategy B), connection map, phases, risks
- `bb-docs/cli-ts-migration/01-cli-ts-tool-calls.md` — the 14 cli-ts tools, their code, safety flags, and IDE mapping
- `bb-docs/cli-ts-migration/02-wire-protocol-and-seam.md` — the serve protocol + exact IDE seam files
- `bb-docs/deep-dive/01`, `/04`, `/05` — how the current send path, Rust bridge, and tool calls work

## Ground rules

- Do NOT change the sessions/provider layer (`LocalAgentHostSessionsProvider`, session type
  `agent-host-backboard`, `sessionsManagementService`, the chat widget). Only the agent-host *agent*
  behind them changes.
- Keep both runtimes selectable behind a setting `backboard.agent.runtime: 'bridge' | 'cli-ts'`
  (default `'bridge'`) until the final cutover phase, so you can A/B them.
- Preserve cli-ts's exact, case-sensitive tool names — they are a model contract.
- Follow the repo's TypeScript conventions in `.claude/CLAUDE.md` (tabs, double-quote localized
  strings, JSDoc, disposables registered on creation, services via constructor DI). Type-check with
  `npm run typecheck-client` after IDE `src/` changes and `bun run validate` inside `cli-ts`.
- Never log API keys/tokens. Route cli-ts serve-mode human/log output to stderr; keep stdout pure JSONL.

## Phase 1 — Build & package cli-ts

1. `cd ide/vscode/cli-ts && bun install && bun run validate && bun run build` — confirm it builds.
2. In `extensions/backboard/package.json`, replace the cargo bridge scripts with a Bun compile:
   - remove/retire `build-bridge`, `package-bridge`, `prepare-bridge` (cargo) — keep them until cutover.
   - add `build-cli-ts` = `bun install --cwd ../../cli-ts && bun build --compile ../../cli-ts/src/entrypoints/cli.tsx --outfile ./bin/backboard-cli-ts`
   - add `prepare-cli-ts` guarded on `command -v bun`.
   - keep `files: ["out/**","media/**","bin/**","package.json"]`.
3. Decide the per-platform build matrix (macOS arm64/x64, win x64, linux x64/arm64) for CI, mirroring
   the old cargo cross-compile.

## Phase 2 — Add cli-ts "serve" mode (persistent, multi-turn)

Today cli-ts headless JSON is one-shot (`ide/vscode/cli-ts/src/entrypoints/cli.tsx:268-290`,
`runHeadless` `:403`). Add a persistent mode:

1. Create `ide/vscode/cli-ts/src/entrypoints/serve.ts` reusing the same wiring as `cli.tsx`
   (`Config`, `EventBus`, `ClientEventLog`, `ServerEventLog`, `JsonEventStream`, `Session`,
   `BackboardClient`, hooks, MCP, `ToolRegistry`, `AgentController`). Instead of one `submit`, run a
   persistent NDJSON control loop on stdin (spec in `02-wire-protocol-and-seam.md` §2):
   `submit / cancel / respondInput / respondPermission / setModel / listModels / listTools / dispose`.
   Stream `JsonEventStream` records on stdout for every bus event; write nothing else to stdout.
2. Add a `--serve` flag in `src/config/flags.ts`; dispatch to `serve.ts` from `cli.tsx` before the
   one-shot branches.
3. Wire `respondInput` to the existing AskUser bridge (`AgentController.ts:402/435/442`,
   `input:request`/`input:response`).
4. Add a **permission gate**: two new events `permission:request` / `permission:response` in
   `src/core/bus/events.ts`, and a hook in `ToolScheduler`/`ToolPolicy` so that — when serve mode's
   permission policy requires it — a write/destructive tool emits `permission:request` and awaits a
   control-channel `respondPermission`. `autoApprove`/`autopilot` policies short-circuit to approved.
   (A minimal v1 may reuse the AskUser path.)
5. Implement `listModels` (`BackboardClient.getModels()`) and `listTools` (`ToolRegistry.list()`) ops.
6. Add Bun tests: serve control parsing, multi-turn submit, cancel-does-not-submit-partial-outputs,
   permission gate, input round-trip. `bun run validate` must pass.

Smoke test:
`printf '{"op":"submit","requestId":"1","prompt":"list files then stop"}\n{"op":"dispose"}\n' | bun run src/entrypoints/serve.ts --serve --cwd <some repo>` — expect ordered JSONL records ending in `turn:end` then exit.

## Phase 3 — Add the IDE `CliTsAgent`

Mirror the Rust-bridge driver structure. Create `src/vs/platform/agentHost/node/cliTs/`:

1. `cliTsProcess.ts` — mirror `BackboardBridgeProcess` (`node/backboard/backboardAgent.ts:2148`):
   `_resolveCliTsPath()` (env `BACKBOARD_CLI_TS_PATH` → `extensions/backboard/bin/backboard-cli-ts` →
   dev fallback `bun run cli-ts/src/entrypoints/serve.ts`), spawn with `--serve --cwd <folder>` and
   injected `BACKBOARD_API_KEY`/`BACKBOARD_API_URL` env, stdout `readline` → parse JSONL records,
   stderr → log `[cli-ts]`, a control writer, and dispose/reject-pending-on-exit.
2. `cliTsProtocol.ts` — the `ServeControl` / `JsonEventRecord` types and a mapper from `AgentEvent`
   → the agent-host actions / `IChatProgress` the chat model expects (mapping table in
   `00-integration-plan.md` §4).
3. `cliTsAgent.ts` — implement the **same agent-host agent interface `BackboardAgent` implements**
   (createSession, sendMessage, listModels, listTools, cancel, disposeSession). One cli-ts process
   per session; each user message → a `submit` op; translate the event stream into streamed chat
   progress; forward `input:request`/`permission:request` to the IDE's confirmation UI and answer via
   the control channel.
4. Register it behind the setting in `src/vs/platform/agentHost/node/agentHostMain.ts:185` and the
   equivalent line in `agentHostServerMain.ts`:
   `agentService.registerProvider(instantiationService.createInstance(cfg.runtime === 'cli-ts' ? CliTsAgent : BackboardAgent))`.
5. Add the setting schema for `backboard.agent.runtime`.

## Phase 4 — Rebind tool UX (Strategy B)

1. **File edits → Changes/Review:** snapshot the working tree (git tree/stash) at `turn:start`; on
   `tool:result` for Write/Edit/ApplyPatch (and at `turn:end`), diff vs the snapshot and feed the
   IDE's `ISessionChangeset` (`bb-docs/deep-dive/05` §File-edit tools) so the Changes view and the
   right-panel Review tab (`bb-docs/deep-dive/08`) render as today. Seed pills from
   `tool:result.detailLines`.
2. **Terminal (Execute):** render `tool:start`/`tool:progress`/`tool:result` as a terminal tool part.
   If you want live output, stream stdout via `tool:progress` in cli-ts's `ExecuteTool`.
3. **AskUser & approvals:** map `input:request` and `permission:request` to the IDE confirmation/
   elicitation UI; answer via `respondInput`/`respondPermission`. Map the IDE's `ChatPermissionLevel`
   and session mode (interactive/plan/autopilot) to the `submit` op's `permission` + `excludedTools`
   (plan mode → exclude `Write,Edit,ApplyPatch,Execute`).
4. **Browser/Computer:** for v1, exclude cli-ts's `Browser`/`Computer` (`--excluded-tools
   Browser,Computer`) and keep the IDE's own Browser tab / computer-use.
5. **Model/tool pickers:** feed the IDE model picker from `listModels` and the tool list from
   `listTools`.
6. **MCP/skills:** for v1, defer MCP + skill management to cli-ts's own config
   (`.backboard/mcp.json`, `~/.backboard/hooks.json`, `.agents/skills`); optionally point the IDE's
   `aiCustomizationTreeView` at those paths later.

## Phase 5 — Cutover & delete

1. Flip `backboard.agent.runtime` default to `'cli-ts'`.
2. Delete `src/vs/platform/agentHost/node/backboard/backboardAgent.ts` and its test; delete
   `extensions/backboard/rust/` and the `bin/backboard-bridge` output and the cargo scripts.
3. `grep -rn "backboardAgent\|backboard-bridge\|BACKBOARD_BRIDGE_PATH" src/vs extensions/backboard` —
   confirm no dangling references.
4. Update `bb-docs/deep-dive/04` (bridge) and `/05` (tool calls) to describe the cli-ts runtime, and
   the `00-overview.md` dataflow diagram.

## Definition of done

- A default `agent-host-backboard` session runs entirely through cli-ts: streams assistant text,
  shows tool calls with correct names, edits files (visible in Changes/Review), runs shell commands,
  answers AskUser, honors approvals, cancels cleanly, and preserves the thread across turns.
- `npm run typecheck-client` (IDE) and `bun run validate` (cli-ts) both pass; no references to the
  Rust bridge remain.
- The Rust bridge, its crate, and its packaging are removed.
