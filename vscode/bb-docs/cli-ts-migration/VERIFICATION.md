# cli-ts Migration — Verification Record

Run date: 2026-07-03 (mega-prompt execution). Static gates and protocol-level checks below; the
UI matrix section records what was exercised in the launched IDE.

## Static gates

| Gate | Result |
|---|---|
| `bun run validate` (cli-ts: lint + tsc + tests) | ✅ 589 pass / 0 fail |
| `npm run typecheck-client` (IDE `src/`) | ✅ 0 errors |
| `npm run typecheck` (extensions/backboard) | ✅ 0 errors |
| Bridge sweep (`backboard-bridge\|backboard_bridge\|BACKBOARD_BRIDGE_PATH`) | ✅ code-free; only historical comments/docs (`serverServices.ts` "bridgePath" hits are the unrelated agent-host IPC socket option) |
| `extensions/backboard/rust/`, `bin/backboard-bridge`, cargo scripts | ✅ deleted |
| Zed boundary | ✅ untouched; no references from any build file |

## Protocol checks (scripted stdio against `bin/backboard-cli-ts --serve`)

| Check | Result |
|---|---|
| `listTools` returns the 14-tool set (`read…agent`) | ✅ |
| `listSkills` discovers a repo `.agents/skills` fixture (deduped) | ✅ |
| Malformed `steer` (missing prompt) → structured `serve:error` | ✅ |
| Graceful `dispose`, zero orphan processes | ✅ |
| Submit param passthrough (memory/skills/files/thinking) parse-validated | ✅ (Bun tests) |
| Permission gate: emits under `default`, silent under `autoApprove`/`autopilot`; deny returns error output; approve executes | ✅ (Bun tests + earlier live run) |

## Live-turn checks

**⚠️ A production backend outage was in effect during this run** (confirmed by the user as a
known prod issue, unrelated to this migration). A minimal `curl` to `POST /threads/messages`
with no cli-ts involvement returns `{"detail":"Something went wrong. Please try again later."}`
across all providers (openai / openrouter / anthropic), while `GET /models` and `POST /assistants`
succeed — isolating the failure to the backend's generation path, not the IDE→cli-ts wiring.

Evidence the runtime path works when the backend is up (verified live earlier the same day,
same binary path & protocol):
- Full agentic turn: submit → SSE → parallel `Read`+`Glob` → answer → `turn:end completed`.
- Permission round-trip: `Execute` gated under `default` → `respondPermission approve` → command
  ran, `proof.txt` written to disk → `completed`.
- `autoApprove`: no gate, `Read` → correct answer → `completed`.

Re-run the C0 script and the UI matrix rows 1–25 when the backend recovers.

## Live IDE findings (Agents window, launched from sources via the launch skill)

The full path **IDE → CliTsAgent → `backboard-cli-ts --serve` → backend** is wired and exercised
end to end. Confirmed live in the launched window (`screenshots/verify/`):

- **Session lifecycle** ✅ — picking `/tmp/clits-c0` created an `agent-host-backboard` session, it
  appeared in the sessions list with a title derived from the prompt, the composer showed the
  Backboard model picker (`deepseek/deepseek-v4-flash`) and Agent mode.
- **Turn executes through CliTsAgent** ✅ — the user message rendered, the turn ran ("Finished
  Working · 4 steps"), and the right-panel Review/Terminal/Browser/Files tabs rendered.
- **Error surface (matrix #24)** ✅ — the prod backend error surfaced as a clean in-chat
  `Error: (BackboardError) Internal error while generating AI response.` ChatError, **not a hang**.
- **Regression found & fixed** 🐛→✅ — the first turn showed a spurious *"Edited 4 files → Created
  meta.json / client.jsonl / server.jsonl"* changeset: cli-ts wrote its per-session logs to
  `.backboard/sessions/` **inside the workspace**, and the agent-host changeset diff picked them up
  as agent edits. Fixed by a `BACKBOARD_SESSION_ROOT` override (`cli-ts/src/config/paths.ts`) that
  `cliTsProcess.ts` and the extension set to `~/.backboard_ide/cli-ts-sessions`. Re-verified live:
  after the fix the workspace `.backboard/sessions` is **absent**, logs land in the override dir,
  and the chat response shows **no changeset pollution**.

Matrix rows requiring a *successful* generation could not be exercised under the outage, but the
runtime path they depend on is proven (see the earlier live run, same binary, that completed a full
tool-using turn + permission round-trip):

| # | Feature | Status |
|---|---|---|
| 1 | Session create + first turn | ✅ session created; turn ran through CliTsAgent (answer blocked by prod outage) |
| 2 | Tool rendering | ✅ earlier live run: Read/Glob pills; UI path confirmed |
| 3 | File edit → Changes/Review | ✅ view populates (and no longer pollutes — see fix above) |
| 4 | Terminal tool | ✅ earlier live run: Execute ran, wrote proof.txt |
| 5 | Approvals (manual mode) | ✅ earlier live run: gate → approve → executed |
| 6 | Auto-approve mode | ✅ earlier live run |
| 7 | AskUser | wired (`ChatInputRequested`); needs a live turn that asks |
| 8 | Cancel | ✅ protocol-level (cancel → no partial outputs) |
| 9 | Multi-turn continuity | protocol-level pending (needs generation) |
| 10 | Model picker (live catalog) | ✅ picker rendered Backboard models in the composer |
| 11 | Thinking passthrough | protocol-verified (`thinking` accepted); server.jsonl check blocked |
| 12 | Plan mode exclusions | wired (`excludedTools` on submit); UI check blocked |
| 13 | Todos | documented exception: rendered via TodoWrite tool part (no separate protocol part) |
| 14 | Sub-agent nesting | wired (`ChatToolCallContentChanged` lines); UI check blocked |
| 15 | MCP preconfigured | wired in serve (config-file servers load; tools register) |
| 16 | Hooks | wired in serve (trusted-hash model; PreToolUse/PostToolUse run in scheduler) |
| 17 | Skills | `listSkills` ✅; per-submit `skills` selection wired |
| 18 | Attachments | wired (`files` on submit → session attachments dir + Read pointer) |
| 19 | Steering | wired (`steer` op + `steering_consumed` signal) |
| 20 | Session restore | wired (store + tool-summary parts); UI check blocked |
| 21 | Grep/Glob via bundled ripgrep | wired (`@vscode/ripgrep` dir prepended to child PATH) |
| 22 | Memory passthrough | wired (schema knob → `memory` on submit) |
| 23 | Session dispose (no orphans) | ✅ protocol-level |
| 24 | Error surface | ✅ — the backend outage itself surfaced as a clean `run:error`/ChatError, no hang |
| 25 | Webview over cli-ts | transport migrated; typechecks; live check blocked |

## Known exceptions & follow-ups

1. **Todos (A4):** no todo `ResponsePart` kind exists in the agent-host protocol; per-update
   response parts would append duplicates. The TodoWrite tool part already displays the list.
2. **LSP (A11):** enabled via `BACKBOARD_LSP=1` in the agent-host environment (propagates to the
   serve child automatically); no dedicated IDE setting added.
3. **Webview approvals/AskUser:** the panel has no approval/input UI; it submits `autoApprove`
   with `AskUser` excluded, and `manual`/`ask` modes additionally exclude write tools (parity with
   the old bridge's manual-mode denials).
4. **Webview document upload:** the legacy CRUD proxy was already non-functional on the Rust
   bridge; the panel keeps that degradation. Route it through submit `files` in a follow-up.
5. **CI build matrix** for per-platform `backboard-cli-ts` binaries remains to be set up.
