# Backboard worker call identity incident

## Observed boundary

The local UI smoke test used the development runtime built at 02:14:28 and the Gemini 3.5 Flash Backboard route. In session `e7328f82-43a8-45ca-8e9b-630a46cba57a`, server log record 8 records a continuation on the run-scoped `submit-tool-outputs?stream=true` endpoint after a completed TodoWrite.

Its compact identity trace records one call, `a28adf1d-1912-46ba-b107-5665f8356ecf`, as `agent_spawn` at start and ready, then `glob` in the final batch. Ready and final have identical argument fingerprints. The client announced the worker but did not execute it; the final batch was rejected before tool execution.

These are mapped service events, not raw Gemini SSE. Current `mapToolCall` copies `function.name` directly from each service message. The raw OpenAI-compatible chunk accumulator only emits advisory start events; it does not select the name of a ready or final call. The evidence therefore identifies disagreement at the Backboard service protocol boundary. It does not identify which upstream provider or service component introduced it. No complete private transcripts or arguments were copied into this report or fixture.

The parent agent's subsequent live run limited each response to one spawn. Three workers integrated their separate files and the requested Node validation passed. That is a successful recovery observation, not proof of the service's internal cause or a guarantee that single-call responses avoid every defect.

## Local response and retry contract

The identity guard remains terminal for this route. `BackboardClient` now stops consuming immediately after a failed event, retaining that failure in its diagnostics. A trailing completion cannot overwrite the rejection, and direct client consumers cannot receive a later final batch.

Automatic protocol retries are deliberately not enabled for Backboard. A retry of this continuation would POST already submitted tool outputs to a server-owned run. This checkout contains no service implementation, rollback endpoint, or documented idempotency contract proving that replay cannot consume the output twice, append duplicate conversation state, or start another continuation. The local `RetryableToolProtocolError` facility used for reversible local subscription attempts is insufficient to establish remote safety. No calls are relabelled based on their arguments.

Before enabling a bounded retry, the service contract must provide a stable idempotency key or replayable attempt identifier for both initial messages and tool-output continuations, guarantee that repeated submissions cannot create duplicate provider/tool work, and specify cancellation and state recovery after an inconsistent response. A service-side test should replay interleaved calls through provider mapping, stream state, ready messages, final batches, and continuation persistence while asserting unchanged call IDs, names, and arguments.

The offline fixture `backboard/cli-ts/tests/fixtures/backboard-worker-identity-mismatch.json` contains invented IDs, synthetic arguments, and the observed name-switch shape. Mapper and client regressions assert matching input hashes, preserved reported names, no accepted final batch, one remote POST, a non-retryable failure, and rejection of a trailing completion. Fetch is mocked; these tests incur no network or model cost.

## Review rendering discovered by the smoke test

The successful worker run exposed an independent desktop presentation defect. The three worker records listed only their intended module paths, but filesystem fallback reporting included the created directory and `.backboard-write-<UUID>` atomic siblings. The watcher checked existence rather than file type, and its temporary-path filter did not recognize the new integration writer.

The desktop now excludes only the integration writer's exact UUID-v4 sibling shape and checks final file type. Existing restored-response filtering uses the same narrow predicate, so old temporary review rows disappear without deleting user files or modifying durable checkpoints. Ordinary dotfiles and files sharing only the prefix remain visible.

Completed private worker writes cannot receive a second successful tool-completion action in the desktop protocol. The adapter previously tried to attach integrated diffs that way; the reducer ignored the already completed call. The parent now receives a distinct, deterministic integration-result record after authoritative integration, with persisted before/after content and computed line counts. It does not rerun the write. Repeated recovery retains one such record, and parent history avoids counting both the integration result and the child's same edits. An otherwise empty live child receives its durable final answer before child completion.

For disjoint files, these snapshots describe the integrated changes exactly. The existing limitation for Git merges of concurrent edits to the same file remains: recovered worker snapshots describe that worker's delta, while runtime integration checkpoints own the exact coordinator undo state. No coordinator before-content is inferred from its current files.

The tracker also now returns a live create record without a before URI when its existing durable classification is Create. Its creation decision is unchanged. A regression verifies that a known pre-existing empty file keeps its before snapshot and Edit kind.

## Offline validation

- CLI native typecheck passed; mapper/Backboard client replay suites: **29 passed**, 69 assertions.
- Desktop `typecheck-client` passed after the final tracker and lifecycle changes.
- Host, watcher, and restored-recap suites: **75 passed**. After the tracker change, host and tracker suites: **69 passed** (overlapping host coverage, not an additive total).
- The new host fixture uses an in-memory SessionDatabase and the real FileEditTracker. It verifies one parent integration result under concurrent duplicate publication, net first-before/last-after snapshots, persisted nonzero line counts, omitted no-op paths, and a stable recovery ID. Separate cases cover successful handle return remaining active, immediate startup failure, integration-gated completion, and the durable child answer arriving before completion.

Tests used source transpilation through a temporary Node loader; they did not replace the installed application. The parent task owns the final live UI smoke result and build identity.
