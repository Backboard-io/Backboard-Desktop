# Mega Prompt — Finish the cli-ts Wiring, Remove the Old Implementation, Verify Everything

Copy everything below the line into a fresh agent session at `Espri-API/ide/vscode`. It is
self-contained. Expect this to be a long, multi-phase run; work through the parts in order and keep
a task list.

---

You are finishing the Backboard IDE → cli-ts migration. The agent-host cutover is already done and
live-verified at the protocol level: `CliTsAgent` (`src/vs/platform/agentHost/node/cliTs/`) spawns
`extensions/backboard/bin/backboard-cli-ts --serve` (built from `ide/vscode/cli-ts/`), real turns
complete, the permission gate round-trips, and disk edits land. Your job now has three parts:

- **Part A** — wire the remaining cli-ts features into the IDE (gap list below).
- **Part B** — remove the ENTIRE old implementation: migrate the extension webview off the Rust
  bridge, then delete the bridge crate, binary, packaging, and the old Rust CLI.
- **Part C** — launch the IDE and verify every feature end-to-end against the test matrix.

Read first:
- `bb-docs/cli-ts-migration/README.md` (status + deviations), `00-integration-plan.md`,
  `02-wire-protocol-and-seam.md`
- `bb-docs/deep-dive/01` (send path), `/04` (retired bridge, banner explains what remains), `/05`
- Key code: `src/vs/platform/agentHost/node/cliTs/{cliTsAgent,cliTsProcess,cliTsProtocol,backboardRuntimeShared}.ts`,
  `cli-ts/src/entrypoints/{serve.ts,ServeTypes.ts,serveControl.ts}`,
  `cli-ts/src/core/tools/ToolPermissionGate.ts`, `cli-ts/src/core/bus/events.ts`

Ground rules (same as the first migration prompt):
- Don't change the sessions/provider layer or the chat widget; only the agent, the serve protocol,
  and the extension.
- cli-ts tool names are a model contract — never rename.
- Repo conventions per `.claude/CLAUDE.md`; validate with `npm run typecheck-client` (IDE) and
  `bun run validate` (cli-ts) after every phase; repackage with
  `npm --prefix extensions/backboard run package-cli-ts` whenever cli-ts changes.
- stdout in serve mode stays pure JSONL. Never log credentials.
- Test-as-you-go: for every serve-protocol change, extend the Bun tests; for every CliTsAgent
  change, verify with a scripted stdio session (pattern in Part C.0).

## Part A — Wire the remaining gaps

Work each gap as its own small change with its own validation.

**A1. Thinking / intensity.** Map the IDE's `intensity` session config (`fast`/`balanced`/`deep`,
read via `createBackboardTurnSettings().intensity`) to cli-ts thinking levels
(fast→`low`, balanced→`medium`, deep→`high`) and pass it as `thinking` on the `submit` op.
cli-ts already accepts it (`serve.ts` submit handler → `parseThinking`).

**A2. Plan mode hides write tools.** In `CliTsAgent.sendMessage`, when
`settings.accessMode === BACKBOARD_ACCESS_MANUAL`, additionally pass
`excludedTools: []`? No — manual gates approvals. The IDE's *plan*-style flow normalizes to
`manual` today (`normalizeBackboardMode`: `plan`→manual). Decide and implement: keep `manual` =
gate-everything (current), and add a distinct mapping so a session config `mode: 'plan'` (before
normalization) sends `excludedTools: ['Write','Edit','ApplyPatch','Execute']` AND
`permission: 'default'`. This requires carrying the raw pre-normalized mode through
`createBackboardTurnSettings` (add a field) rather than only the normalized access mode.

**A3. Memory.** Add `memory?: 'off'|'on'|'auto'|'readonly'` to the `submit` op
(`ServeTypes.ts`, `serveControl.ts` validation, serve handler → `config.setMemory(parseMemoryMode(...))`
inside `onStart`). Surface it from the IDE session config: add a `memory` key to
`resolveBackboardSessionConfig`'s schema (in `backboardRuntimeShared.ts`) and pass it through
`CliTsAgent`. Default stays `off`.

**A4. Todos.** Handle `todos:updated` in `CliTsAgent._handleAgentEvent`: translate to the chat
todo-list part. Find how the Copilot/Claude agents emit todo state (grep `todoList` /
`IChatTodoListContent` in `src/vs/platform/agentHost/node/claude/` for the action shape) and mirror
it. If there is no protocol action for todos, render a `ChatResponsePart` fallback and note it.

**A5. Sub-agent nesting.** Handle `agent:child_tool_start`/`agent:child_tool_result`: at minimum,
stream child tool activity into the parent `Agent` tool call via `ChatToolCallContentChanged`
(compact "↳ Read src/foo.ts — done" lines). Full subagent sessions
(`IAgentSubagentStartedSignal`) are optional — only do it if the signal shapes line up cleanly.

**A6. Steering & queued messages.** Add a `steer` op to serve
(`{op:'steer', requestId, prompt}` → `AgentController.steer`) and implement
`CliTsAgent.setPendingMessages` to consume steering messages via it. Queued messages can map to
plain `submit` (cli-ts queues internally).

**A7. Skills over serve.** Add serve ops `listSkills` (→ `SkillController` discovery: repo +
personal tabs; skip skills.sh) and note that `$skill-name` activation already works inside prompt
text once a skill is selected into the catalog. Minimal IDE surface: none required for v1 — but
make `submit` accept `skills?: string[]` (names to select into the catalog for the turn) and have
serve select them via `SkillController` before the turn. Wire the IDE side only if the
customization UI has an obvious hook; otherwise document how to use it.

**A8. Attachments (images).** The old bridge uploaded images/documents. cli-ts `submit` is
text-only. Add `files?: {fileName, mimeType, dataBase64}[]` to the submit op; in serve, write them
to a temp dir under the session dir and append "Attached file (read it with the Read tool):
<path>" to the prompt (documents), and for images decide: (a) same treatment, or (b) extend
`RunMessageRequestBuilder` to attach them to the Backboard message (bigger; only if the provider
layer makes it easy). Update `CliTsAgent.promptWithAttachmentContext` to send binary attachments
through this instead of dropping them.

**A9. ripgrep.** Point cli-ts's Grep/Glob at VS Code's bundled ripgrep when PATH lacks `rg`:
in `cliTsProcess.ts`, prepend the directory of `@vscode/ripgrep`'s `rgPath` (see how the workbench
resolves it — grep `vscode-ripgrep|rgPath` in `src/`) to the child's `PATH`.

**A10. Session-config schema honesty.** In `resolveBackboardSessionConfig`
(`backboardRuntimeShared.ts`), remove or repurpose knobs that are now no-ops (`webSearch`,
`imageGeneration`) and keep `mode`, `intensity` (now → thinking), and the new `memory`. Check what
the composer pickers render from this schema so nothing dangles.

**A11. LSP.** Pass `--lsp` at spawn when a new setting (agent-host side, mirror how OTel settings
flow) enables it; default off. Optional — skip if the setting plumbing costs more than it's worth,
but say so.

**A12. History fidelity (stretch).** Persist tool-call summaries per stored turn in
`CliTsAgent._writeStore` (name + title per `tool:result`) and reconstruct them as response parts in
`getSessionMessages`. Skip if the `Turn` shape makes this awkward; prompt+response is acceptable.

After each item: `bun run validate` (if cli-ts touched), `npm run typecheck-client` (if IDE
touched), plus a scripted stdio check where applicable.

## Part B — Remove the old implementation entirely

**B1. Migrate the extension webview off the Rust bridge.** `extensions/backboard/src/backboardExtension.ts`
(~3000 lines) spawns `backboard-bridge` directly (`resolveBridgePath` ~line 2590, spawn ~2548) and
speaks the old NDJSON bridge protocol (`sendPrompt`/`submitToolResult`/`listModels`/...). Replace
its transport with the cli-ts serve protocol:
1. Map the webview's bridge calls → serve ops: `sendPrompt`→`submit` (the webview's tool loop
   disappears — cli-ts runs tools; keep rendering from `tool:*` events), `listModels`→`listModels`,
   `cancel`→`cancel`. Reuse the record shapes from `cliTsProtocol.ts` (copy the types into the
   extension; extensions can't import `vs/` internals).
2. Spawn `bin/backboard-cli-ts --serve --cwd <workspaceRoot>` with the same credential env the
   extension already resolves (it has its own config/env handling — reuse it).
3. Render `assistant:delta`/`tool:*`/`permission:request`/`input:request` in the webview; answer
   permissions/inputs from webview buttons via `respondPermission`/`respondInput`.
4. Remove the `backboard.bridgePath` setting; add `backboard.cliPath` override if useful.
5. If the webview turns out to be dead code (check whether `backboard.panel` view is still
   reachable in the product — grep contributions and ask the layout), prefer DELETING the webview
   chat path over migrating it. Investigate first; deleting beats porting.

**B2. Delete the bridge.** Once B1 lands (or the webview chat path is deleted):
`git rm -r extensions/backboard/rust`, delete `extensions/backboard/bin/backboard-bridge`, remove
`prepare-bridge`/`build-bridge`/`package-bridge` from `extensions/backboard/package.json` (keep the
cli-ts scripts; `compile` drops `prepare-bridge`), remove bridge-era settings from the extension
manifest (`backboard.bridgePath`, and audit `backboard.mode/intensity/voiceMode/webSearch/
imageGeneration/mcpFigma/mcpNotion/mcpGoogle` — delete those the webview no longer uses).

**B3. Do NOT delete `ide/vscode/cli/`.** Verified: that folder is `code-cli`, **upstream VS Code's
Rust tunnel CLI** (`cli/Cargo.toml` → `name = "code-cli"`), not Backboard code. Leave it alone.

**HARD BOUNDARY: never touch the Zed IDE.** Nothing under `Espri-API/ide/zed/` may be modified,
deleted, or "cleaned up" by this migration — including `ide/zed/crates/backboard_bridge` and
`ide/zed/crates/backboard`. Zed is a separate product with its own lifecycle. The scope of "remove
the old implementation" is strictly the VS Code fork (`ide/vscode/`): the extension's bridge
spawn, `extensions/backboard/rust/`, `bin/backboard-bridge`, and the cargo packaging scripts.
(The Python CLI at the monorepo root `Espri-API/cli/` is also out of scope.)

**B4. Final sweep.** `grep -rn "backboard-bridge\|backboard_bridge\|BACKBOARD_BRIDGE_PATH\|bridgePath"
src extensions build scripts --include="*.{ts,json,mjs}"` → only historical docs may match. Update
`bb-docs/cli-ts-migration/README.md` (remove the deviation note) and `bb-docs/deep-dive/04`'s
banner (bridge now fully deleted).

## Part C — Full feature verification in the running IDE

**C0. Protocol pre-check (no IDE needed).** Scripted stdio session against
`extensions/backboard/bin/backboard-cli-ts --serve` in a scratch git repo (inject
`BACKBOARD_API_KEY` from `~/.backboard_ide/config.json` the way `cliTsCredentialEnv()` does):
submit → tools → completed; permission default → gate → approve → tool runs; deny → error output +
model continues; cancel mid-turn → `turn:end cancelled`, no partial outputs; multi-turn thread
continuity (second submit references first answer); `listModels`/`listTools`; dispose drains.

**C1. Launch.** Use the repo's launch skill (`.agents/skills/launch`) to start Code OSS from
sources with debug ports, or `./scripts/code.sh`. Ensure the `VS Code - Build` watch task has
compiled first. Open the Agents (Simple) window.

**C2. Test matrix.** For each row: exercise in the UI, confirm the observable result, and check
the agent-host log (`[cli-ts]` lines) when in doubt. Fix what fails, revalidate, retest.

| # | Feature | Steps | Pass criteria |
|---|---|---|---|
| 1 | Session create + first turn | New `agent-host-backboard` session on a scratch repo; ask "summarize this repo" | streamed markdown answer; session appears in list with title |
| 2 | Tool rendering | "read package.json and list its scripts" | Read tool pill with input + result; correct answer |
| 3 | File edit → Changes/Review | "add a comment line to README.md" | edit lands on disk; Changes view + right-panel Review tab show the diff after the turn |
| 4 | Terminal tool | "run `ls -la` and tell me what you see" | Execute tool part with output |
| 5 | Approvals (interactive/manual mode) | switch session mode so approvals gate; ask for a file write | approval carousel appears; Approve runs; Deny returns error to model, turn continues |
| 6 | Auto-approve mode | same request in default/autopilot | no carousel, tool runs |
| 7 | AskUser | "ask me whether to proceed with A or B before doing anything" | input UI appears; answer flows back; agent references the choice |
| 8 | Cancel | start a long task, hit stop | turn ends cancelled; next turn works; thread intact |
| 9 | Multi-turn continuity | "remember the word 'pineapple'", then "what word?" | second turn recalls it (same thread) |
| 10 | Model picker | switch models mid-session; ask "which model are you?" | picker lists live catalog (post-refresh); turn uses the switch |
| 11 | Thinking (A1) | set intensity deep; ask a reasoning question | `thinking` passed (check server.jsonl in `.backboard/sessions/`) |
| 12 | Plan mode (A2) | plan mode; "edit README" | Write/Edit unavailable to the model or gated per your A2 decision |
| 13 | Todos (A4) | "make a 3-step todo list, then work through it" | todo part updates in chat |
| 14 | Sub-agents (A5) | "use the Agent tool to have a subagent count files" | nested activity visible on the Agent tool call |
| 15 | MCP preconfigured | add a trivial stdio server to `.backboard/mcp.json` in the scratch repo; ask agent to use it | `mcp__*` tool call succeeds |
| 16 | Hooks | project `PreToolUse` hook (trusted) that denies `Execute` | Execute blocked with hook reason |
| 17 | Skills (A7) | put a skill in `.agents/skills/`; invoke per your A7 surface | skill instructions affect the turn |
| 18 | Attachments (A8) | attach an image + a text file to a message | agent sees/uses them per A8 design |
| 19 | Steering (A6) | send a follow-up mid-turn | steering consumed per A6 |
| 20 | Session restore | reload window; reopen the session | history renders (per A12 fidelity); new turns work |
| 21 | Grep/Glob (A9) | "find all TODO comments" | rg-backed search works (bundled ripgrep) |
| 22 | Memory (A3) | enable memory on a session; check server.jsonl | `memory` field sent |
| 23 | Session dispose | delete a session | serve process exits (no orphans: `pgrep -f backboard-cli-ts`) |
| 24 | Error surface | break the API key env for a session | clear ChatError in chat, not a hang |
| 25 | Webview (post-B1) | open the Backboard panel (if kept) | chat works over cli-ts; zero bridge processes |

**C3. Definition of done.**
- Matrix rows all pass (or each failure has a fix or a written, justified exception).
- `bun run validate` and `npm run typecheck-client` green; extension compiles.
- `pgrep -f backboard-bridge` finds nothing during any test; the ONLY agent runtime is
  `backboard-cli-ts`.
- `extensions/backboard/rust`, `bin/backboard-bridge`, cargo scripts, and (if B3 confirms it's
  Backboard's) the old `cli/` crate are gone.
- Docs updated: migration README (deviation removed), deep-dive 04 banner, and a short
  `VERIFICATION.md` in `bb-docs/cli-ts-migration/` recording the matrix results.

Report at the end: what passed, what you fixed along the way, what remains (with reasons).
