# Workspace revisions and exact integration records

This follow-up replaces the modern-worker preview limitation described in [the startup report](SUBAGENT_STARTUP_FIX_2026-09-04.md) and [the tool protocol contract](HARNESS_TOOL_PROTOCOL_CONTRACT.md). The active backend choices remain unchanged: native worktrees and merges for clean Git repositories, private snapshots and coordinator checkpoints for plain or dirty folders.

## Workspace lifecycle contract

Each persisted worker record has a monotonic `revision`. Legacy records without the field load as revision zero. The workspace store assigns the next revision to every accepted update and rejects writes carrying an older explicit revision, preventing delayed lifecycle messages from overwriting newer state. Updates to distinct workers remain independently ordered and coalescible. Copies returned by the store and progress callbacks do not share nested change records with internal state.

`executionStatus` and `integrationStatus` remain separate. A completed child can still have pending, integrating, or conflicted changes. Public workspace progress carries both fields and its workspace revision. The task manager owns the separate canonical public task revision; consumers must not compare task revisions numerically with workspace revisions. Cleanup can emit a newer workspace revision after the worker's original integrated return value.

## Exact coordinator changes

New integrations persist `integrationChanges`, an array of coordinator file records:

```ts
{
  filePath: string; // absolute coordinator path
  before?: { contentPath: string; sha256: string; byteLength: number; mode: number };
  after?:  { contentPath: string; sha256: string; byteLength: number; mode: number };
}
```

An absent side means the file did not exist; a present zero-byte blob represents an empty file. Modes use Git file-kind/executable modes (`100644`, `100755`, or `120000`, in octal). Byte-identical mode changes remain records. Byte-and-mode-identical paths are omitted. An empty array proves no coordinator change; an undefined array means exact capture was unavailable, including legacy records.

Content is stored as immutable, content-addressed files beneath the directory containing `workers.json`, at `worker-integrations/blobs/<sha256>`. Blob and record writes use temporary files, file sync, atomic rename, and directory sync. Identical concurrent blob writes are coalesced. Neither raw bytes nor blobs are copied into progress events; those carry references. The desktop validates the owned blob location, hash, length, and coordinator paths before rendering them.

Native Git captures the actual coordinator pre-images under the existing owned-path locks. After Git stages its merge, it captures the actual checkout bytes, including CRLF conversion, and verifies that the affected paths do not differ from the staged integration. Before publishing the commit, it durably stores an internal `integrationPlan` tied to the coordinator base commit, staged tree, and worker result. The successful result returns the actual published commit ID rather than rereading a potentially newer HEAD. A later peer's before/after record therefore includes prior peer changes in the same file.

If the process loses the final metadata acknowledgement after commit, recovery finds the merge whose first parent, worker parent, and tree match the durable plan. A later unrelated user commit does not change the recovered snapshots or integration identity. If a user instead manually integrates a different tree, the prepared plan is not advertised as that user's actual changes.

Private snapshots capture actual coordinator states after validating the existing before/after compatibility rules and before invoking the checkpoint wrapper. The internal plan survives a partial apply or lost acknowledgement; recovery retains its original pre-images when some files already contain their intended result. New paths already at their intended state are omitted rather than invented as changes. The checkpoint recorder continues to own undo durability and recovery.

Only successful integration publishes `integrationChanges` in workspace progress. Pending plans, conflicts, and partial writes never become applied review records. Modern desktop review no longer needs to reconstruct coordinator edits from private child previews. Legacy records without exact snapshots retain their existing compatibility behavior.

Capture is bounded to 10,000 paths, 16 MiB per file, and 128 MiB per before/after image. Unsupported file kinds, changed files, or exceeded limits fail explicitly while retaining the worker result. Capture checks cancellation between paths and blob writes, and Git subprocess checks carry the same signal. The existing completed-result durability boundary remains in force: stopping a completed worker does not rewind an already committed integration.

## Validation

The native CLI compiler passed before the focused workspace suites. The new cases cover legacy revisions, stale writes, exact empty-file presence and mode changes, concurrent identical blob writes, same-file peer merges with CRLF checkout bytes, and recovery after a committed integration followed by a newer user commit. Snapshot tests cover BOM/CRLF edits, empty creates/deletes, and exact records after checkpoint acknowledgement loss. Final focused and benchmark results are recorded by the parent task.
