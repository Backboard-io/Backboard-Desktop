# Parallel workers and concurrent writes — September 4, 2026

This follow-up implements reliability changes in the active TypeScript harness and desktop host. It preserves the earlier harness/rendering changes and unrelated working-tree edits. Validation uses local fixtures and temporary repositories; no model calls, private-log uploads, installed-app replacement, or application relaunch is required.

This document records the earlier clean-Git validation baseline. A later plain-folder IDE smoke exposed a startup gap; the [subagent startup follow-up](SUBAGENT_STARTUP_FIX_2026-09-04.md) describes the subsequent private-snapshot backend, current plain/dirty-folder support, and expanded validation.

## Runtime contract

- The coordinator can launch sibling workers concurrently with `Agent` or durable background `AgentSpawn` handles. `AgentWait` joins selected handles; `return_when: "any"` returns the first available terminal result and lists pending handles. The default remains waiting for all selected workers. Timeout returns a snapshot while workers continue; cancellation stops the wait.
- Write workers use separate native Git worktrees. Model requests and independent file operations overlap. Git registry updates and coordinator integration remain coordinated. Up to four workers can run in one workspace manager; workers cannot recursively delegate through the coordinator's task manager.
- Give each writer a concrete task, disjoint file ownership, and acceptance criteria. Independent work can proceed concurrently; dependent edits should wait for the preceding worker's integrated result. Same-file integration still uses Git's merge/conflict handling, not last-writer-wins replacement.
- A completed model response is provisional for a writer. The result must be captured and integrated before its edits count as applied coordinator changes. Conflicts retain recoverable worker work and remain visible as conflicts.
- Direct `Write`, `Edit`, and `ApplyPatch` calls share canonical path locks, including aliases. Multi-file operations reserve their complete path set together; waiting for one busy path does not block registration of later independent writes. Disjoint operations remain concurrent; overlapping operations retain reservation order.

## Findings and fixes

### Registration, results, and cancellation

Task registration reserves a handle before asynchronous persistence. Duplicate calls must match the normalized task/session/turn/workspace identity and share the same durable registration. A cancellation generation and registered abort controller cover startup while state is loading or being saved. Idle draining includes registrations as well as executing workers. Terminal results survive persistence failures in memory with explicit durability status; already integrated work must not be rerun just because saving its report failed.

Persisted task records receive stricter validation and independent copies of nested result data. Wait results expose completion counts and pending handles. Prompts explain concurrent writable ownership and first-result joins without requiring delegation for trivial work.

### File locks and undo

The previous lock implementation acquired multi-file locks one at a time. A later single-file writer could overtake a patch blocked on its first path. Whole-set reservation fixes this without serializing unrelated files. A cancelled waiter releases only its own reservation; a later waiter still depends on the earlier active owner.

The previous checkpoint cohort waited for every peer while holding each peer's file locks. An integration reserving multiple paths between two cohort members could form a cycle: the first writer waited for the second writer's checkpoint arrival, integration waited for the first writer's lock, and the second writer waited for integration. Ready captures now coalesce over an event-loop turn without waiting for absent peers. Every write still awaits its durable pre-image before changing bytes and its post-image before releasing its locks. Parallel captures can perform independent reads concurrently; the journal orders its appends.

File tools check cancellation before preparation, after lock acquisition, and after pre-image persistence immediately before committing changes. Once an atomic mutation begins, completion/rollback and post-image persistence retain their durability responsibilities. A test interleaves worker-style integration with a real checkpoint store, then restores both files through undo.

### Integration and recovery

Integration commits an explicitly captured and validated Git tree with fixed parents, then publishes it with a compare-and-swap update. Unrelated staging that appears after the tree was captured stays staged rather than being swept into a worker commit. Foreign staged paths detected before capture preserve the merge/index for recovery instead of discarding user changes. A durable integration or a later external commit is not reset when cancellation arrives late.

Recovery requires an explicit internal worker-merge marker before automatically aborting an interrupted merge. Merely including a worker commit in a user-created merge does not establish ownership. Rename tracking retains both the source and destination path. Shared snapshot inspection no longer prevents an individual cancelled worker from stopping or cancels its independent peers.

### Desktop and provider identity

The desktop withholds isolated worker file-edit projections until integration is authoritative. Running, integrating, conflicted, failed, and cancelled workers cannot register unapplied changes in coordinator edit history. Reopening a child uses authoritative workspace state and does not turn a failed tool into a successful one merely because an archive contains a partial edit. A terminal child invalidates an earlier partial archive cache.

Legacy Gemini function calls without upstream IDs now receive IDs unique to each stream. Reusing a small counter starting at zero across streams could otherwise collide across rounds or simultaneous workers. Upstream-provided IDs remain intact.

## Validation

Current-source CLI TypeScript compilation (including the benchmark script) passed. The repository's native TypeScript checker also passed after test-fixture corrections; desktop `typecheck-client` passed. Focused checks passed: 82 mutation/checkpoint/scheduler tests, 71 lifecycle/delegation/prompt tests, 23 Google adapter/schema tests, and 52 desktop host tests. The three Git workspace/integration suites passed 63 tests (266 assertions). The full CLI suite passed **1,708 tests**, with **3 Windows-only skips**, **0 failures**, and 4,565 assertions across 157 files in 79.93 seconds.

The six benchmark trials all passed their correctness assertions. Three parallel workers reached three concurrent provider requests; the serial comparison reached one. Each trial used exactly six provider requests total, completed and persisted all three task results, integrated all three worktrees, and left the expected files and clean index. Median completed-task time was **4,302.31 ms serial** and **2,473.76 ms parallel**, a **42.5% reduction** under the synthetic 300 ms provider delay. Actual Git/worktree/file I/O was measured. See [the machine-readable benchmark](PARALLEL_WORKER_BENCHMARK_2026-09-04.json).

The expanded writable-delegation guidance changes the earlier prompt-size snapshot: current base system plus tool-description bytes are 25,347 (default), 22,640 (OpenAI), and 25,439 (Anthropic/GLM). Enabled client-tool guidance still adds 641 bytes in each profile. These are UTF-8 byte counts, not provider token or latency measurements.

Reproduce the offline worker benchmark from `backboard/cli-ts`:

```sh
bun run test:parallel-workers --output /tmp/backboard-parallel-workers.json
```

It runs the real `AgentSpawn`/`AgentWait` scheduler path, `SubAgentRunner`, child tool loops, `Write`, durable task stores, native worktrees, and integration in temporary repositories. Three alternating serial/parallel trials use three workers with a simulated provider delay. It asserts concurrent child requests, exact final file contents, one authoritative result per child, successful persisted tasks, integrated worker states, and a clean coordinator index. The result is a serial/parallel synthetic comparator, not a before/after live-model latency claim.

The same replay was compiled to a standalone executable and run with `env -i PATH=/usr/bin:/bin`. All six compiled trials passed the same assertions. Median time was 3,805.41 ms serial and 2,075.84 ms parallel (45.5% reduction); this is a separate sparse-PATH run, not a comparison between compiled and source speed. See [compiled replay results](PARALLEL_WORKER_BENCHMARK_COMPILED_2026-09-04.json).

## Boundaries that remain explicit

The clean-coordinator requirement was a boundary of this earlier implementation. It is superseded by the [private-snapshot startup fix](SUBAGENT_STARTUP_FIX_2026-09-04.md), which supports bounded plain and dirty folders while preserving the user's Git state and providing durable undo. The clean-Git measurements above remain a dated baseline rather than evidence for those additional workspace modes.

Worker isolation does not make arbitrary external Git/file-system mutations transactional. Attached-branch publication checks the captured branch and SHA; detached HEAD retains support with a checked no-dereference update. Concurrent external branch switching still has a narrow race on Git versions without atomic symbolic-reference verification. Conflicting external changes must be preserved and surfaced, not silently reconciled. Integrated child previews currently retain the worker's before/after content; a merge combining edits from several writers in the same file may require the coordinator's final diff for the complete combined result.

The launcher prefers packaged binaries. Source edits and local tests do not update the running installed application. Use the deliberate build/relaunch procedure in `HARNESS_IMPLEMENTATION_VALIDATION_2026-09-04.md` and verify runtime identity before evaluating an IDE session. An isolated compiled CLI at `/tmp/backboard-parallel-validation` reports SHA `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259`, dirty source, Bun 1.4.0, application 3.0.2, protocol 1, and build timestamp `2026-09-04T22:24:25.391Z`. No installed build was replaced during this work.
