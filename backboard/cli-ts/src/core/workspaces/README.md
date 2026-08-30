# Isolated parallel workers

Write-capable `Agent` calls use native Git worktrees. Calls emitted in one
coordinator tool round are scheduled concurrently; worktree creation is briefly
serialized because Git's worktree registry is shared, while model/tool execution
is not.

For a host session `SESSION` and Agent tool call `WORKER`, the runtime creates:

- branch `agent/SESSION/worker/WORKER`
- worktree `<repository>.backboard-workers/SESSION/WORKER`
- durable metadata in the stable session's `workers.json`

The worker receives that worktree as its cwd and as an enforced write boundary.
Write, Edit, ApplyPatch, Execute cwd, test processes, file tracking, terminal
process groups, event buses, model context, and transcripts are scoped to the
worker. Read-only workers share the coordinator checkout and do not claim
filesystem isolation.

## Result and integration lifecycle

`WorkerWorkspaceManager` records the starting commit before launch. A successful
worker is captured with `git add -A` and an internal result commit, regardless of
whether the model committed. `WorkerIntegrationManager` merges successful result
commits in allocation order. A merge uses a no-commit transaction so cancellation
can abort or roll back before a late result becomes visible.

Conflicts remain in the coordinator checkout with `MERGE_HEAD` intact. The worker
branch, result commit, and worktree are preserved, and the conflicting paths are
reported to the coordinator and UI. Later integrations remain pending until the
earlier conflict is resolved. On restart, an integrated result is recognized by
ancestry and an interrupted merge is recognized from Git state.

## Recovery and cleanup

`WorkerWorkspaceStore` atomically replaces a versioned JSON record containing
worker identity, prompt, branch, worktree, starting/result commits, changed files,
execution state, integration state, and timestamps. Recovery only recreates a
missing worktree when its exact deterministic branch still exists. It never
invents a missing branch or operates on a path that does not match the session's
deterministic worker path.

Archive and deletion wait for active worker/integration operations. Checkpoint
refs are removed before clean integrated worktrees. Branches are retained. Dirty,
failed, cancelled, conflicted, partially integrated, or unowned paths are
preserved and reported. Unarchive reattaches missing clean worktrees from their
preserved branches.

## Configuration

The feature is active for write-capable `Agent` calls. When the coordinator cwd
is not already a Git repository, Backboard initializes a local repository and
captures the folder's current state in an internal baseline commit before any
worker starts. This adds local `.git` metadata but never configures or pushes a
remote. Existing repositories and their history are left intact.

The default maximum is four workers. Set
`BACKBOARD_MAX_PARALLEL_WORKERS` to a positive integer to lower the limit; values
above four are capped at four. If Git is not installed or automatic setup cannot
complete, parallel writes stop with an explicit error instead of sharing a
writable folder.

The coordinator should emit two to four independent `Agent` calls in the same
model response. Final validation commands belong in the coordinator after all
worker integrations complete.

## Factory compatibility boundary

This implements the native-worktree, concurrent-worker, result-capture,
integration, recovery, lifecycle, and IDE presentation behavior. It does not add
Factory's separate Droid CLI command surface (`--worktree`) or a standalone
Missions service/dashboard. Backboard uses its existing Agent tool, persistent
task model, and chat UI as those entry points.
