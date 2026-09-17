# Isolated parallel workers

Write-capable workers use native Git worktrees or private snapshots. Calls emitted in one
coordinator tool round are scheduled concurrently, including independent
worktree creation. Concurrent launches share one burst-scoped repository
inspection; later launches always inspect the current coordinator HEAD again.

For a host session `SESSION` and Agent tool call `WORKER`, the runtime creates:

- branch `agent/SESSION/worker/WORKER`
- worktree `~/.backboard_ide/worktrees/REPOSITORY_HASH/SESSION/WORKER`
- durable metadata in the stable session's `workers.json`

The application-owned root is injectable for tests and embedding. Worker folders
are never created beside the user's repository and are not editor workspaces.

The worker receives that worktree as its cwd and as an enforced write boundary.
Write, Edit, ApplyPatch, Execute cwd, test processes, file tracking, terminal
process groups, event buses, model context, and transcripts are scoped to the
worker. Read-only workers share the coordinator checkout and do not claim
filesystem isolation. Clean Git coordinators retain the native-worktree backend.
Plain folders and dirty repositories use a private Git baseline under the hidden
worktree storage root. That baseline copies current file bytes and never creates
Git metadata, commits, stashes, or resets in the coordinator. Its worker receives
an explicit notice about excluded dependencies and validation limitations.

## Result and integration lifecycle

`WorkerWorkspaceManager` records the starting commit before launch. A successful
worker is captured with `git add -A` and an internal result commit, regardless of
whether the model committed. `WorkerIntegrationManager` merges successful result
commits in capture-completion order while serializing the coordinator's Git
mutations. Ready disjoint results are preflighted and coalesced into one merge
transaction and commit; overlapping ownership groups retry in deterministic
order. An unfinished worker never reserves an integration slot ahead of a ready
result. Once a result commit is captured and persisted, cancelling worker
execution cannot downgrade that completed work or remove its integration
eligibility. A merge uses a no-commit transaction so interrupted state remains
recoverable. The coordinator captures one index tree, verifies its paths belong
to worker results, creates a commit from that exact tree and fixed parents, and
publishes it with a compare-and-swap against the starting branch and HEAD.
Unrelated user staging after tree capture remains staged and is not committed.
A late cancellation does not reset an already durable integration commit.
Attached branch identity is checked before and after publication; detached HEAD
uses a checked non-dereferencing update. Git versions without atomic symbolic-ref
guards still require external branch switches to wait for integration to finish.
A staged coordinator index leaves results pending with an actionable
message and is never committed, stashed, or reset by worker integration.

When a worker merge conflicts, Backboard records the conflicting paths and aborts
only that worker's merge transaction. Its branch, result commit, and worktree stay
recoverable, while unrelated captured results continue through the integration
queue. On restart, an integrated result is recognized by ancestry and an
interrupted merge is recognized from Git state. Automatic abort requires both an
internal integration marker and matching worker parents; foreign staged paths
preserve the merge/index for review. A manual merge containing a worker result
is not assumed to be harness-owned. Older unmarked interrupted merges are kept
for review. Recovery clears owned merge metadata left after a durable commit
without resetting the index or worktree.

## Recovery and cleanup

`WorkerWorkspaceStore` keeps an in-memory record map, coalesces intermediate
progress writes, and atomically replaces a versioned JSON file at durable lifecycle
boundaries. It contains worker identity, prompt, branch, worktree, starting/result
commits, changed files, execution state, integration state, and timestamps.
Recovery only recreates a missing hidden worktree when its exact deterministic
branch still exists. Legacy adjacent `.backboard-workers` paths are preserved but
never recreated. It never invents a missing branch or operates on a path that
does not match the session's deterministic worker path. A clean worker branch
that advanced before result metadata was written is rediscovered, promoted to a
captured result, and included in the ready integration batch.

Archive and deletion wait for active worker/integration/cleanup operations.
Clean integrated worktrees are removed eagerly off the tool-call critical path.
After the removal is durably recorded, the exact merged internal worker branch
and checkpoint refs are deleted; the coordinator merge commit retains the result.
A
failed or cancelled worker with no captured result is removed as soon as Git
proves both that its worktree is clean and that its branch is still exactly at
the starting commit. That terminal cleanup is persisted so recovery and
unarchive do not recreate a no-op worktree. Dirty or manually committed failed
and cancelled worktrees, plus conflicted, partially integrated, or unowned paths,
are preserved and reported. Unarchive never recreates an eagerly cleaned or
legacy adjacent worktree.

## Configuration

The production serve runtime supplies `snapshotMutation`, a coordinator checkpoint
transaction, before workspace recovery starts. Embedders must supply the same
capability to use plain/dirty snapshots; missing capability fails preparation
before a worker/model starts. The older `autoInitializeGit: true` opt-in retains
its explicit coordinator-initialization behavior; it is never enabled implicitly.

Private snapshots include current bytes of every tracked file plus untracked
files permitted by `.gitignore`. Untracked `node_modules`, `.cache`, `.next`,
`.turbo`, `.venv`, `__pycache__`, `.backboard`, and `.backboard_ide` trees are
excluded. Git metadata is always excluded. Tracked files remain included even
when ignored. Symbolic links and special files are refused explicitly. The
snapshot bounds neither the number of source files nor their size; a large
source inventory is never silently cut. Storage must be outside the
coordinator to prevent recursive copying. Private Git attributes disable content
filters and line-ending conversion so binary and CRLF bytes remain exact.
Worker integration applies no file-count or byte ceiling to captured results.

A snapshot integration derives file changes from immutable private Git objects,
checks current coordinator bytes and executable modes against baseline/result,
and acquires the same path locks used by direct mutations. Any differing path
leaves the result in conflict without overwriting it. The coordinator's Git
index and HEAD are untouched. Preimages must be durably checkpointed before
atomic file replacement; postimages and the dedicated worker checkpoint finish
before integration is reported complete. A journal names the exact baseline,
result, and paths. If application or checkpoint finalization is interrupted,
partial work stays recoverable and retries accept only baseline/result states.
No blind rollback overwrites newer edits. Immutable private repositories/result
branches are retained as recovery material; clean worker checkouts can be removed.
External filesystem writers do not participate in in-process locks, so a
concurrent external write between a final byte check and rename remains a race;
this backend is not a filesystem-wide transactional lock.

The default maximum is four workers. Set
`BACKBOARD_MAX_PARALLEL_WORKERS` to a positive integer to lower the limit; values
above four are capped at four. Git is still required for private snapshot object storage and worker isolation.
An unavailable executable, unsupported snapshot entry, or missing checkpoint
transaction produces an explicit preparation failure.

Prefer `AgentSpawnBatch` for two to four independent named assignments, then
`AgentWait` for their stable handles. `Agent` and `AgentSpawn` remain compatible
wrappers around the same task manager. Final validation commands belong in the
coordinator after all worker integrations complete.

## Factory compatibility boundary

This implements the native-worktree, concurrent-worker, result-capture,
integration, recovery, lifecycle, and IDE presentation behavior. It does not add
Factory's separate Droid CLI command surface (`--worktree`) or a standalone
Missions service/dashboard. Backboard uses its existing Agent tool, persistent
task model, and chat UI as those entry points.
