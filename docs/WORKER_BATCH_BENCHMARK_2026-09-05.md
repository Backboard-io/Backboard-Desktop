# Worker batch offline replay — September 5, 2026

This replay measures the real task manager, worker workspace preparation, child agent loops, Write permissions/checkpoints, integration, durable task records, and cleanup. Its provider emits deterministic local frames. It makes no network requests, uses no model credentials, and does not launch or replace the installed app.

The checkout is based on `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259` and contains user edits plus the current harness changes. A Git SHA alone does not identify that runtime. Results retain a bundle hash when executed from a frozen bundle; source-entry hashes identify only the entrypoint, not all imported modules.

## Workload and comparisons

Three workers each write one assigned file, then finish after one tool-output continuation. The configurable delay applies to each worker's initial provider stream; its continuation emits immediately. Every successful trial asserts exactly six child provider requests, three completed durable tasks, three integrated results, and exact coordinator file contents. Repeated child tool-call IDs deliberately exercise session isolation.

The four modes run the same workload:

- `serial`: start one worker, wait for completion, then start the next.
- `sequential-registration`: issue three separate AgentSpawn calls before one join. This represents sequential tool registration, without artificial parent-model delay.
- `parallel`: submit the three AgentSpawn calls in one scheduler round.
- `batch`: submit one AgentSpawnBatch call, then join its registered handles.

The replay does not measure a live parent model deciding whether to issue one or three calls. Batch may reduce parent inference round trips in actual use, but this fixture adds no speculative time for that benefit. All modes retain the same six child requests.

Clean Git uses native worktree integration. Plain folders and dirty Git use private snapshots. Snapshot trials check three real checkpoint undo operations after the measured completion, restoring original BOM/CRLF bytes, removing newly created worker files, preserving unrelated files, and leaving the dirty Git index and HEAD unchanged. Plain folders must remain free of `.git` metadata.

`--parent-edit` holds the synthetic initial provider responses until all concurrent workers have actually started, then performs a real parent Write to unrelated `README.md`. This deterministic correctness gate tests overlap and parent-edit preservation through integration and worker undo. It changes scheduling and should be compared only with other gated runs. Zero-delay ungated trials record observed overlap; short provider iterator lifetimes need not overlap even when whole workers do.

`joinedMs` ends after AgentWait observes completion. `elapsedMs` also includes draining worker/task cleanup. `registrationMs`, first/last model-ready time, and phase samples explain overhead. Phase totals overlap across workers and are **not** a partition of wall time. Undo verification is outside the measured task time.

## Frozen baseline

[Baseline JSON](WORKER_BATCH_BASELINE_2026-09-05.json) was captured before the batch runtime edits, after a successful CLI typecheck. The old runtime was frozen with `bun build`; only the bundle entrypoint was instrumented to select the synthetic delay, collect existing timing events, and correct its false zero-delay overlap assertion. No bundled runtime module was modified.

| Synthetic delay | Clean Git serial median | Clean Git parallel median | Plain parallel | Dirty Git parallel |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 3855 ms | 2238 ms | 3637 ms | 1159 ms |
| 300 ms | 3315 ms | 1898 ms | 1054 ms | 1110 ms |

Clean Git values are medians of three alternating-order trials; plain and dirty values are single samples. All 16 trials passed their file, request, integration, and applicable undo checks. Zero-delay clean parallel samples ranged from 1444–4182 ms; host/filesystem variation was substantial. In particular, the 300 ms measurements being faster than some zero-delay measurements is evidence that these samples do not support a precise causal before/after speed claim.

## Regression coverage and limits

- [WorkerBatchReplay.test.ts](../backboard/cli-ts/tests/WorkerBatchReplay.test.ts) runs actual batch tools through child loops, permissions, snapshots, integration, and undo with a concurrent parent edit. Sequential registration exercises the same outcome contract.
- [AgentTaskLifecycle.test.ts](../backboard/cli-ts/tests/AgentTaskLifecycle.test.ts) covers duplicate registration, argument/session/turn identity, preparation cancellation, persistence failures, and captured results that must not rerun.
- [AgentWorkerEngine.test.ts](../backboard/cli-ts/tests/AgentWorkerEngine.test.ts) covers all-members-durable-before-launch, duplicate batch replay, preflight conflicts, registration failure, persisted terminal state, shared blocking/background execution, cancellation ownership, and mixed-batch permissions.
- [PrivateSnapshotWorkspace.test.ts](../backboard/cli-ts/tests/PrivateSnapshotWorkspace.test.ts) covers conflicting external edits, binary/index preservation, symlink/cap rejection, and idempotent recovery after checkpoint-finalization interruption.
- [WorkerSnapshotMutation.test.ts](../backboard/cli-ts/tests/WorkerSnapshotMutation.test.ts) reopens the checkpoint store after an interrupted partial application and verifies original preimages survive recovery.
- [WorkerWorkspaceManager.test.ts](../backboard/cli-ts/tests/WorkerWorkspaceManager.test.ts) covers restart reconciliation, pending/already-committed results, interrupted multi-worker merges, recovery path ownership, and conflict isolation.
- [GitWorkerTransactions.test.ts](../backboard/cli-ts/tests/GitWorkerTransactions.test.ts) covers unrelated staging, concurrent HEAD/branch changes, late cancellation, foreign merges, and detached HEAD.

Recovery fixtures inject interruption and reopen durable stores; this replay does not claim a full installed-app process-kill/relaunch test. It also does not measure provider latency, real-model task success, streaming UI rendering, or large repository inventory cost. Existing `agent-eval.ts` and `chat-first-token-benchmark.ts` address different live-provider questions and were not invoked here.

## Reproduction

Run the repository-approved CLI typecheck first. From `backboard/cli-ts`, the focused regression command is:

```sh
bun test tests/WorkerBatchReplay.test.ts
```

For repeatable code identity, freeze the benchmark and its imports after typechecking, then run comparisons sequentially rather than competing for filesystem resources:

```sh
bun build scripts/parallel-worker-benchmark.ts --target bun --outfile /tmp/backboard-worker-batch.mjs
bun /tmp/backboard-worker-batch.mjs --delay-ms 0 --iterations 3 --output /tmp/workers-zero.json
bun /tmp/backboard-worker-batch.mjs --delay-ms 300 --iterations 3 --output /tmp/workers-delay300.json
bun /tmp/backboard-worker-batch.mjs --delay-ms 0 --iterations 1 --modes sequential-registration,batch --workspace non-git,dirty-git --parent-edit --output /tmp/workers-parent-edit.json
```

Each trial creates and removes its own temporary fixture. `--modes`, `--workspace`, `--iterations`, and `--delay-ms` bound the optional run. Generated results contain synthetic paths/identities and performance counters, not private prompts or reasoning.
