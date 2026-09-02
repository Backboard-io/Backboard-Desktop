# Isolated parallel workers

Write-capable `Agent` calls use native Git worktrees. Calls emitted in one
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
filesystem isolation. A write worker starts only from a clean, existing Git
checkout. If the coordinator has staged, unstaged, or untracked changes, the
runtime routes the caller toward direct main-agent file tools instead of giving
the worker a stale committed view. It never stashes or resets user state.

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
recoverable. A staged coordinator index leaves results pending with an actionable
message and is never committed, stashed, or reset by worker integration.

When a worker merge conflicts, Backboard records the conflicting paths and aborts
only that worker's merge transaction. Its branch, result commit, and worktree stay
recoverable, while unrelated captured results continue through the integration
queue. On restart, an integrated result is recognized by ancestry and an
interrupted merge is recognized from Git state.

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

The feature is active for write-capable `Agent` calls in an existing clean Git
repository. Non-Git and unborn repositories are rejected by default without
creating `.git` metadata. Embedders can explicitly opt into local initialization
and a baseline commit with `autoInitializeGit: true`; no production call site
enables it implicitly. Existing repositories and their history are left intact.

The default maximum is four workers. Set
`BACKBOARD_MAX_PARALLEL_WORKERS` to a positive integer to lower the limit; values
above four are capped at four. If Git is unavailable, the checkout is dirty, or
the folder is not an initialized repository, parallel writes stop with an
explicit error instead of sharing a writable folder or mutating repository
metadata.

The coordinator should emit two to four independent `Agent` calls in the same
model response. Final validation commands belong in the coordinator after all
worker integrations complete.

## Factory compatibility boundary

This implements the native-worktree, concurrent-worker, result-capture,
integration, recovery, lifecycle, and IDE presentation behavior. It does not add
Factory's separate Droid CLI command surface (`--worktree`) or a standalone
Missions service/dashboard. Backboard uses its existing Agent tool, persistent
task model, and chat UI as those entry points.
