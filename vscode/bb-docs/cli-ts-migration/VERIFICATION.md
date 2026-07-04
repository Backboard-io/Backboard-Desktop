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

## Post-migration regression fixes (reported by user)

Two regressions were reported after the cutover and fixed:

### 1. Inline file-edit diffs stopped showing
**Cause:** `CliTsAgent` didn't attach `ToolResultFileEditContent` to tool results. The old bridge
built these via `FileEditTracker` disk snapshots — impossible here because cli-ts executes the edit
before the IDE sees the event, so "before" can't be snapshotted from disk.
**Fix:** cli-ts's `Write`/`Edit`/`ApplyPatch` tools now emit `fileEdits: [{path, before, after}]`
(they hold both in memory); a new `FileEditTracker.recordExplicitEdit(...)` persists them to the
session DB and returns the `ToolResultFileEditContent`; `CliTsAgent` attaches it to
`ChatToolCallComplete` (awaiting the async build before `ChatTurnComplete`).
**Verified (source serve):** a `Write` turn emits
`fileEdits: [{path: hello.py, before: '', after: "print('hi')\n"}]`; the file lands on disk. The
Changes/Review view (git-diff based) already worked; this restores the inline diff card.

### 2. Slow to first token (~3.5s vs old bridge ~2s)
Attacked in layers (a 5-agent latency audit workflow confirmed the root causes and ranked the fixes):

**2a. Assistant list-scan per session.** `ensureAssistant` did `GET /assistants` (~1.1s) + often
`POST /assistants` on every session to find/create the fingerprint-matching assistant.
→ **Fix:** disk cache `fingerprint → assistant_id` (`~/.backboard/assistants-cache.json`); a hit
skips the scan.

**2b. Volatile assistant fingerprint (the real culprit).** The base-assistant system prompt included
`buildStartupEnvironmentPrompt` — today's date, CWD, git branch, tool versions, and the top-level
directory listing — so the fingerprint (and cache key) changed **every day / workspace / branch /
file change**. The cache almost never hit, and the backend accumulated assistant sprawl.
→ **Fix:** `baseSystemPrompt()` now excludes the volatile env (it still reaches the model via the
per-turn `system_prompt` override — cli-ts's stated "stable base assistant" design). The fingerprint
is now stable on both axes (prompt + deterministically-ordered base tools).
→ **Verified:** two sessions in **different workspaces** now share **one** cache entry — session A
(cold, empty cache) 2.32s, session B (different cwd) **1.64s warm**. Previously B would have been
full cold.

**2c. Serial network pre-flight.** `resolveAssistantId` and `createRuntimeThinkingResolver` were
awaited one-after-another before the message.
→ **Fix:** run them concurrently (`Promise.all`), overlapped with local pre-flight.

**2d. Eager spawn + assistant pre-warm.** The serve process spawned lazily on the first message, and
even the first-ever turn paid the assistant create.
→ **Fix:** new serve `warmup` op (`AgentController.prewarmAssistant()`); `CliTsAgent.createSession`
spawns the process and fires `warmup` when the composer opens — so spawn (~0.2s) and the first-ever
assistant resolution (~1.4s) happen during user think-time. `AssistantSessionBinding` now dedupes
concurrent resolves so warmup can't race the first turn into creating two assistants.
→ **Verified:** first-ever turn (empty cache) **2.71s → 1.57s** with warmup during think-time.

**2e. Per-turn micro-costs.** Memoized `detectCommandShell()` (was up to 5 `existsSync` per turn) and
cached thinking-metadata by (provider, model) (was a `GET /models/thinking-metadata` every turn).
Both runtime caches are disabled under tests (`BACKBOARD_DISABLE_RUNTIME_CACHES`).

**Net:** first token went from **3.34s** → **~1.34–1.64s** (warm, any workspace) / **~1.57s**
(first-ever turn with warmup) — at or below the old bridge, approaching the backend LLM floor
(~1.3s). `bun run validate`: **593 pass, 0 fail**.

### Regression-fix caveats
- Also fixed: cli-ts session logs were landing in the workspace `.backboard/sessions/` and showing
  as phantom agent edits in the Changes view. `BACKBOARD_SESSION_ROOT` (set by `cliTsProcess.ts` and
  the extension to `~/.backboard_ide/cli-ts-sessions`) moves them out; verified the workspace stays
  clean.
- The assistant cache has a small staleness risk: if an assistant is manually deleted server-side,
  the cached id goes stale and a turn fails. `invalidateAssistantCache` is provided but not yet
  wired to the send-failure path — a follow-up. (The tool never deletes assistants, so the risk is
  low.)
- Heavy local serve-mode testing left macOS `syspolicyd` jammed (uninterruptible `UE` processes),
  making the freshly-copied `bin/backboard-cli-ts` slow to pass first-exec code-signing on this
  machine. The binary is byte-identical to the working in-place build; a clean environment (or the
  stuck processes clearing) resolves it. All fixes were verified via the `bun run` source path.

## Liveness / "feels faster" improvements (reported by user)

The migrated experience felt static and slow. Three fixes:

### 1. Reasoning / thinking now streams live (biggest win)
**Cause:** cli-ts's provider mapper dropped the backend's `reasoning_streaming` chunks entirely
(its `ProviderEvent` union had only `assistant_delta`/`requires_action`/`usage`). On thinking
models — especially at high/"deep" intensity — that meant **seconds of dead air** while the model
reasoned. The old Rust bridge streamed reasoning, so the old UI felt alive.
**Fix (cli-ts):** `mappers.ts` maps `reasoning_streaming`/`reasoning_delta` → a new
`reasoning_delta` provider event (with cumulative-delta normalization); `ProviderStreamConsumer` →
`AssistantAccumulator.appendReasoning` → a new `assistant:reasoning` AgentEvent.
**Fix (IDE):** `CliTsAgent` maps `assistant:reasoning` → a `Reasoning` response part + streamed
`ChatReasoning` deltas (a fresh reasoning block per tool round, so the UI shows distinct
think → act → think steps).
**Verified (source serve):** a thinking-model turn emitted **7 reasoning chunks + 5 assistant
chunks** and completed — previously reasoning was zero.

### 2. Diff counters animate (the "numbers changing as lines are added/removed" ask)
**Constraint:** the backend delivers tool-call arguments **complete, not streamed** (cli-ts parses
`function.arguments` as a whole string), so there is no authentic byte-by-byte "lines appearing"
data to show.
**Fix:** `ChatEditPillElement.setDiff` now count-up-animates the `+added` / `-removed` labels from
their previous values to the new targets (eased, duration scaled by change size, capped at 700ms,
honors `prefers-reduced-motion`). Combined with the fileEdits fix — which makes
`onToolCallEditsApplied` fire per edit mid-turn — each edit makes the numbers visibly tick up.

### 3. First-token latency (from the prior round, reinforces "feels faster")
Assistant-id disk cache: cold **3.34s** → warm **1.34s**.

### 4. Instant status line fills the send→first-token dead air (perceived latency)
**Cause:** even at the warm ~1.3s floor, `CliTsAgent.sendMessage` emitted **nothing** to the
transcript between turn start and the first `assistant:delta`. For the default (non-reasoning)
model — which streams no reasoning to fill the gap — the user saw only a generic spinner for
~1.7s, so the turn *felt* frozen even though raw latency was at the backend floor.
**Fix (IDE-only, no cli-ts / wire change):** `CliTsAgent.sendMessage` now fires one
`SystemNotification` response part (`"Thinking…"`) **synchronously, before the submit round-trip**,
right after the turn state is created. The active turn already exists (`ChatTurnStarted` is reduced
before `sendMessage` runs), so it renders on the first frame. The agent-host adapter
(`stateToProgressAdapter.systemNotificationToProgress`) maps `SystemNotification` →
`{ kind: 'progressMessage' }` — an **ephemeral, shimmering** status line that upstream
(`ChatProgressContentPart.isHidden`) **auto-hides the instant any real content** (markdown,
reasoning, or a tool call) follows it, so it leaves **no transcript clutter**. Deliberately *not*
gated by `didCreateStatusPart`, so genuine `system:warning`s still surface as their own line.
**Net effect:** a content-shaped, animated status appears at **~0.0s** instead of 1.7s of dead air,
then cleanly gives way to the streamed response.
**Verified:** `npm run typecheck-client` passes; no cli-ts agent tests assert the part sequence.

## "cli-ts serve process exited" — root cause & fix (reported by user)

**Symptom:** turns failed in the IDE with `Error: (BackboardSendFailed) cli-ts serve process
exited.` No new session logs were created — the process died before writing `serve:ready`.

**Root cause:** `bun build --compile` appends the JS bundle to the executable **after** ad-hoc
code-signing, leaving an **invalid signature** (`codesign --verify` → "code or signature have been
modified"). The in-place build binary happened to run (it passed first-exec verification once, then
the result was cached), but the **`cp`-ed copy** the IDE actually spawns
(`extensions/backboard/bin/backboard-cli-ts`) is a new file that macOS AMFI re-verifies on first
exec — and because the signature is invalid, it **kills the process** (SIGKILL, no output). The IDE
saw the child exit and surfaced the generic error. (My heavy local testing had also jammed
`syspolicyd`, which is why it sometimes *hung* instead of dying.)

**Fix:**
1. **Packaging re-signs the binary** after copy: `extensions/backboard/package.json` `package-cli-ts`
   now runs `codesign --force --sign - ./bin/backboard-cli-ts` (guarded on `command -v codesign`, so
   it no-ops on Linux/Windows, which don't have this issue). Re-signing covers the whole file
   (bundle included) → `valid on disk` / `satisfies its Designated Requirement`.
2. **The current `bin/` binary was re-signed** so the user's IDE works immediately.
3. **The error is now actionable:** `CliTsServeProcess` detects an early exit with no output and
   reports "the packaged binary's code signature is invalid (macOS kills it on first run). Rebuild
   with: npm --prefix extensions/backboard run package-cli-ts", plus the exit code/signal and stderr
   tail.

**Verified** through the exact `bin/backboard-cli-ts` the IDE spawns: launches in 0.2s, streams
reasoning + assistant text, emits fileEdits (before/after), writes the file, completes, exits 0.

## DSML tool-call leak rendered as raw text (reported by user)

**Symptom:** mid-turn, the transcript filled with dozens of repeated copies of raw DeepSeek
tool-call markup (`<｜DSML｜tool_calls> <｜DSML｜invoke name="edit"> ...`) rendered as assistant
prose. Session log (`sess_19300660`) confirms the tokens arrived as `assistant:delta` events and
that two parsed `edit` calls also failed Zod validation (`expected string, received undefined`).

**Root cause (two layers):**
1. **Backend (prod):** the DSML function-call parser failed on a complex `edit` call (the
   `edits` array param, `string="false"`), leaking the model's raw tool tokens into
   `content_streaming` and mangling parsed calls' arguments. Backend-side bug — needs a server
   fix; local code can only contain the blast radius.
2. **Local amplifier:** `normalizeContentDelta`'s divergence fallback re-emitted overlapping
   frame content wholesale on every frame once the stream stopped prefix-extending — turning one
   leak into ~19 repeated blobs.

**Fix (cli-ts `mappers.ts`):**
- Unified `normalizeStreamText` for content + reasoning: longest-common-prefix recovery on
  cumulative divergence, duplicate-frame dedupe (≥8 chars, so legitimate short token repeats
  still stream), and segment-cumulative recovery (frames that strictly extend the previous
  frame after the backend restarts accumulation). Never re-emits already-emitted text.
- `suppressDsmlMarkup`: content deltas are truncated at the first `<｜DSML｜` marker in the
  accumulated message — leaked tool markup never renders, prose before the marker is kept.
- `stripDsmlMarkup` applied to `completed.finalText` so the finalization/dedupe path cannot
  reintroduce the markup.

**Verified:** 7 new regression tests replaying the incident shapes; full `bun run validate`
green (600 tests). Binary repackaged + re-signed; live serve turn completes.

## Glob "ripgrep failed (exit 1)" + phantom build-artifact edits (reported by user)

**Symptom 1:** Glob failed with `Error: ripgrep failed (exit 1)` in a large workspace even
though matching files existed. **Cause:** `GlobTool` kills rg with SIGTERM once stdout passes
80KB (~ the user's `*.md` listing was 92KB); the kill yields `code=null`, which both failed the
`code !== 0 && code !== 1` check and rendered as the misleading "exit 1" via `code ?? 1`.
**Fix:** a self-inflicted cap-stop now resolves as a truncated success (partial last line
dropped, `[results truncated …]` note, `Found N+ files` title); only genuine non-0/1 exits or
external signal deaths reject, with the signal named. `GrepTool.run` got the same hardening
(cap-stop → success; `code=null` without a cap-stop → explicit "killed by SIGx" error).
**Verified live:** the exact failing scenario (md glob over `~/Desktop/Backboard`) through the
packaged binary now returns `Found 1000+ files`, zero tool errors.

**Symptom 2:** a turn's "Finished Working" recap listed `Created .18bf…bun-build`,
`Created backboard`, `Edited backboard-cli-ts`, `Deleted backboard-cli-ts.cstemp`. **Cause:**
the per-turn workspace FS watcher attributes any mid-turn change to the turn; a concurrent
`package-cli-ts` rebuild (bun compile + codesign) ran while the turn was open, and its scratch
files passed the `isIgnoredAgentPath` filter. **Fix:** the temp-write pattern now also matches
`*.bun-build` (bun compile scratch) and `*.cstemp` (macOS codesign temp); unit test extended.
The built binaries themselves (`backboard`, `backboard-cli-ts`) remain trackable by design —
when the agent itself runs a build, its outputs are legitimate turn artifacts; they only
appeared here because an external rebuild collided with the open turn.

## Composer pickers: stale models + "No Backboard options" (reported by user)

**Symptoms:** the model picker sometimes showed a stale/default list, and the gear menu showed
"No Backboard options" on fresh sessions.

**Causes & fixes (all IDE-side, no binary change):**
1. `CliTsAgent` only refreshed the model list **after the first submit**
   (`_refreshModelsOnce` was called solely from `sendMessage`), so until then the picker showed
   the static `BUNDLED_BACKBOARD_MODELS`. Fix: `_prewarm` now fires `listModels` immediately
   after the `warmup` op — models load in parallel with assistant warmup while the composer is
   open.
2. Every composer picker (mode, permissions, generic chips, …) independently called
   `resolveSessionConfig` for the same `(provider, workingDirectory)` at mount. Fix: new
   `resolveSessionConfigShared` helper dedupes concurrent identical calls into one in-flight
   round-trip (results are not cached — only the in-flight promise is shared).
3. The gear dropdown rendered the dead-end "No Backboard options" while the schema was still
   resolving. Fix: `AgentHostGenericConfigChips.hasResolvedSchema()` distinguishes
   loading-vs-empty; the dropdown now shows "Loading Backboard options…" until the schema
   arrives.
4. **Model-list disk cache** (follow-up: "models load so incredibly slow"): the backend fetch
   itself is ~0.75s, but it cannot start until a serve process exists (prewarm needs a chosen
   workspace; otherwise first submit). `CliTsAgent` now persists the fetched list to
   `~/.backboard_ide/models-cache.json` (keyed by API URL) and hydrates it at construction —
   the picker shows the real 400+ model list instantly at window start, refreshed in the
   background whenever the next serve process spawns.

## "spawn …/backboard-cli-ts ENOENT" with the binary present (reported by user)

**Symptom:** `BackboardSendFailed: cli-ts serve process failed to start: spawn
…/extensions/backboard/bin/backboard-cli-ts ENOENT` while the binary existed on disk.

**Root cause (reproduced):** Node reports a **missing spawn `cwd`** as `spawn <command> ENOENT`
— the error names the binary even though it's the working directory that's gone. This happens
when a session is restored against a deleted/renamed folder.

**Fix:** `CliTsServeProcess.ensureProcess` validates the working directory before spawning and
throws the real reason: "The session's working directory no longer exists: <path>. Start a new
session from an existing folder." The sendMessage catch path already routes this into a
ChatError bubble.

**Full re-verification of the packaged binary** (rebuilt + re-signed):
`bun run validate` green (600 tests) · serve handshake `ready=True models=419 tools=14` ·
live turn with `autoApprove`: Glob `Found 1000+ files` (truncation fix live), Execute exit 0,
ApplyPatch create `+4/-0` and edit `+1/-1` both with `fileEdits` diff payloads, turn
`completed`, file content correct on disk.

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
