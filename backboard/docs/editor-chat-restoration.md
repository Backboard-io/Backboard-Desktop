# Editor file navigation, rewind, and context usage

## File navigation

Chat edit-card filenames, attached changed-file links, and changed-file summary filenames open the full workspace file. The edit card has an explicit **View Change** button; **Open Changes** on the summary still opens the captured comparisons. Alt activation on a summary filename retains direct comparison access. Deleted edit cards show their before snapshot when the current file no longer exists.

## Rewind and recovery

The selected request is the boundary: rewinding to request N restores the files to before N and disables N and every later request. The CLI now receives the same stable turn ID as the editor. It captures request-start workspace bytes, tool edits, shell side effects, and worker integration records. Reopening retains stable IDs, the selected boundary, and provider usage.

The editor awaits prepare, commit, model refresh, and acknowledgement. Prepare cancels the active turn and waits for managed workers and integrations to stop. Affected buffers are made temporarily readonly and autosave is suspended; unsaved text is backed up separately from disk bytes. Commit validates all known paths and blobs before overwriting, records recovery intent, and rolls back if any file fails. The cursor advances only after success. Repeated transport requests are idempotent. An interrupted disk transaction is recovered before serving requests, and interrupted editor refresh resumes on reopening.

**Chat: Recover Pre-Rewind Files** restores the most recent active rewind backup, including dirty buffers. Every rewind also writes ordinary recovery files, usable even after continuing a new branch:

```
~/.backboard_ide/cli-ts-sessions/.backboard/sessions/<session-id>/checkpoints/
  editor-rewinds.json
  editor-rewind-backups/<transaction-id>/
    disk/manifest.json
    disk/<index>-<filename>
    buffers/manifest.json
    buffers/<index>-<filename>
```

Disk files are byte-exact. Each manifest maps a stored filename to its absolute original path; `existed: false` records original absence. Dirty buffers are stored as UTF-8 text with their intended save encoding in the manifest. Recovery files are private to the local user. The host archives discarded transcripts under `~/.backboard_ide/rewind-history/<session-id>/`. These records are retained with local session data; no remote thread or assistant memory is deleted.

Continuing sends the retained visible user/assistant transcript, tool inputs/results, and attachment references into a fresh provider thread. The inspected API/client has no message-truncation operation. Shared assistant memory and hidden provider reasoning are outside this file-and-visible-conversation rewind.

### Limits

- Durable request checkpoints apply to requests made by this version. Older requests without them report checkpoint unavailable.
- Workspace shell snapshots use the existing CLI index exclusions and ignore files. Generated/dependency/cache folders and ignored shell-only edits are outside that index; explicit tool captures still cover their supported paths.
- Unsupported paths or files beyond capture limits reject a known restore plan before mutation. Arbitrary external processes outside the CLI's managed tools/workers are not stopped by rewind.
- File and dirty-buffer backups apply to affected paths; unrelated files remain outside the restore plan.

## Context data

The API schema is `context_usage`, not `used_context`:

```json
{
  "context_usage": {
    "used_tokens": 12900,
    "context_limit": 1000000,
    "percent": 1.29,
    "summary_tokens": 2000,
    "model": "provider-model-name"
  }
}
```

Path: `providers/backboard/mappers.ts` → usage event → `CliTsAgent` → usage `_meta.backboardContextUsage` → `stateToProgressAdapter.ts` → `ChatContextUsageWidget` / `ChatContextUsageDetails`.

The API snapshot is persisted with each local turn. Used and limit counts must be finite; zero usage is valid, and the limit must be positive. A valid server percentage takes precedence; otherwise the percentage is derived from the API counts. Summary tokens and measured model are shown when supplied. Missing API measurements are unavailable, never guessed from `input_tokens`, `output_tokens`, or model catalog limits. Other providers retain their existing usage handling.
