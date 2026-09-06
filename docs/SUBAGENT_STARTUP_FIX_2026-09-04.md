# Subagent startup follow-up — September 4, 2026

## Incident and verified cause

The latest IDE smoke (session `44cc0e15-881a-42c9-90ed-f35911750dcf`) attempted six write workers in an ordinary non-Git desktop folder. All six were rejected before useful worker execution because the default launch path required a Git repository. The previous [parallel-worker validation](PARALLEL_WORKER_RELIABILITY_2026-09-04.md) covered clean Git repositories; it did not establish that the same workflow worked in plain or dirty folders. The session used the repository development binary built at `2026-09-04T22:56:31.346Z`. There were no child model logs. Parent provider streams accounted for 131.1 of 132.2 seconds; retries of the same unavailable backend added provider rounds. No private transcript or credentials are included here.

## Changes

- Plain folders and dirty Git workspaces now use an application-owned Git snapshot outside the user's folder. Workers still receive separate private checkouts. The snapshot retains current working bytes for tracked files and bounded eligible untracked source files; it does not initialize Git in the user folder, stash work, reset it, or commit the user's index.
- Snapshot results integrate only where current coordinator files match the captured baseline or an already applied result. Conflicts preserve the worker result. Coordinator mutations use the real checkpoint recorder, including durable pre-images, post-images, and a finalized undo checkpoint for each worker integration.
- Direct `node --test` invocations now count as typed validation evidence, including failure and successful-check behavior; compound commands remain excluded.
- Task state remains queued through preparation and becomes running when worker execution actually starts. Preparation failures remain explicit terminal failures.
- When the requested workspace is a repository subfolder, the worker starts in the corresponding private subfolder. Permission scope remains the original requested folder. Live projection and archive recovery retain the same coordinator identity.
- Desktop recovery explicitly uses `workers.json`'s `coordinatorCwd`, never the private snapshot `repositoryRoot`, for displayed file paths. The existing integration gate also applies to snapshot workers: proposed edits do not enter coordinator edit history before integration. Failed and conflicted worker outcomes remain failed after reopening.

The private snapshot is bounded to 10,000 files, 128 MiB total, and 16 MiB per file. Git metadata, ignored untracked files, and common dependency/cache directories are excluded. Unsupported file kinds and capture limits produce explicit preparation errors rather than silently creating an incomplete snapshot. See the implementation's snapshot notice and capability errors for the current contract.

## Validation completed

The current native CLI typecheck, including `scripts/parallel-worker-benchmark.ts`, and desktop `typecheck-client` passed. The source-loaded desktop suite passed **52 tests**, including a snapshot archive whose private Git repository differs from its actual coordinator folder. That fixture verifies path projection, integration gating, failure state, and recovered edit persistence using an in-memory session database. No installed build or running application was replaced for these tests.

The expanded offline replay passed **all eight scenarios**. It exercises the actual `AgentSpawn`/`AgentWait` scheduler, child loops, file tools, workspaces, result integration, task persistence, and snapshot undo. Provider responses use a synthetic 300 ms delay, with no network/model calls.

| Source replay | Completed-task time | Correctness |
| --- | ---: | --- |
| Clean Git, serial median of three | 3,483.53 ms | 3 integrated workers, 6 provider requests |
| Clean Git, parallel median of three | 1,747.66 ms | 3 simultaneous worker requests, 3 integrated workers |
| Plain folder, parallel | 931.36 ms | 3 integrated workers, 3 undo operations; no `.git` created |
| Dirty Git folder, parallel | 1,244.56 ms | 3 integrated workers, 3 undo operations; original HEAD, staged content, and index bytes preserved |

The clean-Git comparator shows **49.83% lower median time** for parallel execution under the configured synthetic delay. It is not a before/after live-model result. The snapshot cases verify a newly supported startup path, not a speed comparison against the former rejection path. Undo runs outside the completed-task timing and checks original BOM/CRLF working bytes, deletion of a newly created worker file, and preservation of unrelated user files.

Reproduce from `backboard/cli-ts`:

```sh
bun run scripts/parallel-worker-benchmark.ts --output /tmp/backboard-snapshot-source.json
```

The [source replay evidence](SUBAGENT_SNAPSHOT_SOURCE_2026-09-04.json) and [compiled sparse-PATH replay evidence](SUBAGENT_SNAPSHOT_COMPILED_2026-09-04.json) are recorded alongside this report. An initial restricted subagent run could not perform the macOS process inventory required for real isolated-process cleanup. The successful replay used the root execution environment with actual cleanup enabled.

## Final validation and runtime identity

- Full CLI suite: **1,725 passed, 3 Windows-only skips, 0 failures**, with 4,645 assertions across 159 files in 82.87 seconds. Focused workspace tests passed 71 cases; lifecycle/tool/prompt tests passed 67; desktop host tests passed 52. Checkpoint coverage includes reopening the store after interrupted application and restoring the original pre-images.
- Compiled replay with `env -i PATH=/usr/bin:/bin`: **all eight scenarios passed**. Clean Git median 3,777.41 ms serial versus 2,057.56 ms parallel (45.53% reduction). Plain folder 1,164.53 ms; dirty Git 1,289.86 ms. Both snapshot scenarios integrated three workers and passed three undo operations.
- Development packaged binary rebuilt and signed successfully: `backboard/extensions/backboard/bin/backboard-cli-ts`. Build timestamp `2026-09-04T23:15:42.645Z`, source HEAD `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259` with dirty working changes, Bun 1.4.0, application 3.0.2, protocol 1. Signed binary SHA-256: `126952c463bdf27b1e50718a99b88f708c666389c75946908c196faa50eff2b3`. Dirty HEAD alone does not identify the modified source; the build timestamp and binary digest distinguish this build.
- No running application was restarted and no separately installed app was replaced. A fresh development-app session will use the rebuilt binary. The host also fingerprints executable size/mtime and replaces a stale serve process on its next process acquisition. Live model success after this update has not been claimed.

The launcher prefers packaged binaries. From `backboard`, the update command is `npm --prefix extensions/backboard run package-cli-ts`; inspect it with `extensions/backboard/bin/backboard-cli-ts --runtime-info`. The direct diagnostic used this shell’s ripgrep resolution; the desktop host continues prepending its bundled ripgrep directory, so the next serve handshake is authoritative for GUI search capability. No restart is needed for a fresh development session. See [the harness validation report](HARNESS_IMPLEMENTATION_VALIDATION_2026-09-04.md) for the separate installed-app build procedure.

The build validated above still used worker before/after previews for integrated changes. The [September 5 workspace follow-up](WORKSPACE_LIFECYCLE_INTEGRATION_2026-09-05.md) adds exact coordinator integration records for new native Git and snapshot integrations. Snapshot integration remains conservative about changed coordinator pre-images; it does not overwrite conflicting external edits.
