# Worker engine implementation — 2026-09-05

The active TypeScript runtime now routes Agent, AgentSpawn, and AgentSpawnBatch
through AgentTaskManager. A batch durably registers all members before launching
new work, returns stable handles, and rejects conflicting replay arguments.
AgentCancel validates session ownership before cancelling any selected worker.
AgentWait supports bounded waits. Existing worker concurrency and permission
enforcement remain in place.

The task record owns public lifecycle revisions. Execution and integration are
separate states; a finished model or successful spawn is not integrated success.
Desktop worker rows consume this record, reject stale revisions, and reconcile
durable task history when reopening. Workspace managers retain responsibility
for preparation, capture, integration, and cleanup, reporting their progress to
the task manager rather than deciding desktop completion independently.

Integration stores exact coordinator before/after bytes and file modes in
content-addressed durable blobs. Modern desktop diffs use these records; missing
records produce a limitation rather than a fabricated worker-proposal diff.
Task metadata and integration snapshots share the durable atomic-write helper.
Plain folders and dirty repositories use the existing private snapshot backend;
GitHub and a remote are unnecessary. A local Git executable remains required.

## Validation

- Final CLI typecheck: passed, including new engine tests and benchmark source.
- Final desktop `npm run typecheck-client`: passed.
- Final focused engine, spawn/wait, Agent, and lifecycle run: 68 passed,
  0 failed, 309 assertions. Includes cancellation while durable start is pending,
  stale progress, replay, batch durability, and legacy revision recovery.
- Earlier workspace run: 68 passed, 302 assertions before the final shared
  durable-writer extraction. Earlier batch replay: 3 passed, including three
  concurrent writers, parent edits, plain/dirty folders, integration, and undo.
- Earlier desktop host/tracker run: 78 passed. Browser run had 132 passes and
  one stylesheet-loading fixture failure; its fixture was adjusted, but the full
  browser rerun was stopped at the user's request.

The user requested stopping subagents and reducing further testing. All three
implementation agents were interrupted; no larger benchmark matrix or live app
restart was performed. The final history-hydration refinement is typechecked,
but has not had another host regression run. No new end-to-end latency improvement
is claimed. Baseline measurements and their variance are recorded in
[the benchmark report](WORKER_BATCH_BENCHMARK_2026-09-05.md).

Pending worker updates are not yet piggybacked onto arbitrary model tool results.
Workspace backends remain separate implementations behind existing managers.
External filesystem writers still cannot be made transactional by in-process
path locks. Crash fixtures are not a complete operating-system kill matrix.

## Development build and relaunch

From `/Users/erint/Documents/GitHub/Backboard-Desktop/backboard`:

```sh
npm --prefix extensions/backboard run package-cli-ts
```

Desktop source also needs current transpiled output. Use the existing development
watcher; if none is running, start `npm run watch-client-transpile` and wait for
its initial pass. Do not run a clean transpile over a live development app.
After active user tasks finish, quit the development app and relaunch with:

```sh
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh
```

The skip flag assumes Electron, dependencies, and transpiled output are already
prepared. Packaging updates the repository binary, not the installed app, and
does not replace the executable of an already running agent process.
