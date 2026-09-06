# Subagent live UI validation

Testing used the running Backboard Studio Dev app through native computer controls, in the existing test folder. Only new smoke fixture files under `smoke-ui-20260904/` were requested. Existing project files were preserved.

## Observed live behavior

Session `e7328f82-43a8-45ca-8e9b-630a46cba57a` confirmed the packaged runtime build `2026-09-05T02:14:28.216Z` and desktop-bundled ripgrep. The first multi-call request on Backboard/Gemini 3.5 Flash failed safely: one ID announced as `agent_spawn` finalized as `glob`, with the same argument fingerprint. The mapped service-boundary trace establishes inconsistent identity, not which upstream component caused it. No invalid spawn executed. Unlike the local subscription adapter, the remote Backboard conversation/submit-output API has no verified idempotent retry contract; automatic replay must not be guessed.

A visible retry requested one background spawn per response, without waiting between spawns. All three writers completed and integrated:

| Worker | Runtime start (UTC) | Model finish (UTC) | Result |
| --- | --- | --- | --- |
| Alpha | 02:16:46.209 | 02:16:54.269 | alpha.mjs integrated |
| Beta | 02:16:53.560 | 02:17:02.655 | beta.mjs integrated |
| Gamma | 02:17:01.338 | 02:17:15.962 | gamma.mjs integrated |

Intervals overlap pairwise; this run does not prove all three models were active simultaneously. The coordinator imported the three modules and checked their sum was 6. The terminal visibly reported `Alpha: 1 Beta: 2 Gamma: 3` and `Validation successful!`. The final table and display equation rendered legibly.

## UI defects reproduced

- Named worker updates were hidden inside collapsed Worked and expanded rows only said Worker: Ran subagent.
- A completed spawn tool could make the worker count appear complete while the actual background worker remained running.
- Filesystem fallback tracking counted a created directory and three `.backboard-write-UUID` atomic-write intermediates as changed files.
- The three real created modules showed unknown changes as +0/-0 rather than their actual content diff.
- Opening an already completed worker initially showed its prompt with an empty assistant transcript.

## Implemented fixes and validation

- Compact cyan agent glyphs and muted named updates remain visible outside collapsed Worked. Expanded rows are flat and compact; navigation, accessibility, confirmations, and lazy child transcripts remain intact.
- Agent/AgentSpawn accept a bounded optional name, preserved across live progress and recovery. Names do not change task identity or deduplication.
- The model receives the spawn handle immediately, while the frontend invocation stays running until actual worker completion/integration. Trusted CLI terminal events can update a detached worker after its parent turn closes. Startup failure terminates its child; cancellation/failure is not displayed as success.
- Directory notifications and exact atomic-write temporary files no longer create false file edits. Integrated worker changes publish a single persisted parent review result with line counts. Empty completed child chats hydrate their archived final answer.
- Live create metadata now agrees with persisted create classification. Existing empty files remain edits.

Validation: desktop and CLI typechecks passed; 315 browser tests passed across renderer, subagent content, progress adapter, and host chat suites; 75 host/watcher/history tests passed; a subsequent host/tracker batch passed 69 tests (overlapping coverage); 29 provider protocol tests passed; 58 name/lifecycle/spawn tests passed. `git diff --check` passed.

The development packaged CLI was rebuilt and signed at `2026-09-05T02:28:14.417Z`. The installed production app was not replaced.

## Post-build visual limitation

The live pre-update test and its final table/equation were inspected through native screen controls. Post-update UI behavior passed the browser tests, but final native visual verification is incomplete: the full transpile test task cleaned `out/`, which triggered the existing development auto-relauncher before resources were copied back. The app log recorded a missing generated `out/vs/base/common/semver/semver.js`; that resource was subsequently restored by the completed build. Computer Use could no longer acquire the development window (repeated timeout). Terminal control was rejected by Computer Use and was not bypassed. The development app needs reopening before another live named-worker test. Do not describe the updated native UI as visually verified.

For future tests against a running development watcher, use its incremental outputs rather than running a clean full transpile over the live `out/` directory.

The remaining Backboard service-boundary identity mismatch is documented in [the contract report](BACKBOARD_WORKER_PROTOCOL_INCIDENT_2026-09-04.md). The successful retry used one spawn per response with overlapping background work; this does not establish that the affected route safely supports multiple different calls in one response. General same-file merged worker review diffs still use worker snapshots; exact coordinator undo checkpoints remain authoritative.
