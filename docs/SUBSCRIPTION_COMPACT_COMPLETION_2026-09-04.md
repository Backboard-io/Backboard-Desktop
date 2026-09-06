# Subscription compact completion compatibility

## Incident evidence and its limits

Session `4548f343-01fe-48af-88bc-a4774adba13c` used GPT-5.5 through the Codex subscription adapter. The parent task verified the active development runtime was the 02:28 build. The client log records a complete `execute` call followed by a protocol rejection with `readyCount: 1`, `finalCount: 0`, and `reason: missing_call`. Its single bounded retry produced the same structural outcome. The turn then failed. No execution-start or tool-result event was emitted for either rejected call.

This session contains `client.jsonl` and `meta.json`, without a server response capture. The old diagnostic does not distinguish an empty final `output` array from a populated array containing only other item types. Therefore the exact terminal shape in this incident remains unproven. The fix below addresses an independently verified local compatibility defect; it does not attribute the incident conclusively to that defect or to the upstream service. No private arguments, reasoning, credentials, or whole transcripts are included in the fixture or this report.

## Primary contract and local defect

The current OpenAI Codex implementation consumes complete output items independently of the terminal summary. Its SSE adapter emits `OutputItemDone` for `response.output_item.done`. Its `ResponseCompleted` structure contains `id`, `usage`, `usage_metadata`, and `end_turn`; it does not deserialize `output`. See the primary [Codex Responses SSE implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs). These are observations of the current public implementation, not a claim about the exact server revision serving this session.

The primary [Codex stream event handling](https://github.com/openai/codex/blob/main/codex-rs/core/src/stream_events_utils.rs) records completed items and queues tool calls from those completed items. The completion summary is not a retraction of already completed calls. Its [response test fixtures](https://github.com/openai/codex/blob/main/codex-rs/core/tests/common/responses.rs) also construct completion summaries separately from completed function-call items.

Our adapter already retained completed items when `response.output` was absent, but interpreted an explicitly empty array as an authoritative replacement list. That rejected a valid completed call and triggered an unnecessary second model request. The offline fixture now covers the empty-array variant using invented IDs and arguments.

## Narrow reconciliation policy

- Validated `response.output_item.done` items remain authoritative when the terminal `output` is absent or empty. Repeated identical done items remain deduplicated. Argument/name snapshots remain isolated from downstream mutation.
- A populated terminal array must still agree with every ready call's ID, canonical name, and structured arguments. A message-only populated array cannot silently erase a call. Changed names, changed arguments, duplicate final IDs, malformed output arrays, and malformed function-call JSON still fail explicitly.
- Incomplete `output_item.added` or argument-delta fragments are never promoted into executable calls by the compact-summary rule.
- Cancellation is checked when each frame resumes and again after the diagnostic yield. A cancelled attempt does not commit its done items or release a final tool batch; its input and message tail are rolled back by the existing attempt transaction.
- No mutation is executed by this adapter. The existing scheduler, schema validation, permissions, ordered writes, and pre-final retry limits are unchanged.

Every completion emits a metadata-only `provider:diagnostic` with `outputShape` (`absent`, `empty`, `nonempty`, or `invalid`), item count, counts for the fixed item types `function_call`, `reasoning`, `message`, `other`, and `invalid`, plus completed-tool count. Unknown type names and raw item content are never copied. The same shape summary accompanies disagreement warnings. Diagnostic events do not enter model content or count as first visible/provider output.

## Offline regression coverage

`backboard/cli-ts/tests/fixtures/subscription-compact-completion.json` replays a synthetic reasoning item, one completed execute call, its duplicate, and an empty terminal output. Tests verify one ready call, one final action batch, preserved continuation items, and one result submission. Additional cases cover absent and malformed terminal output, fixed-key diagnostics, downstream input mutation, partial fragments, cancellation rollback, and populated contradictory output. Fetch is mocked; no model, network, shell execution, or installed-app relaunch is performed.

Native CLI typechecking passed before tests. The focused subscription adapter and provider consumer suites passed **36 tests, 118 assertions**, including cancellation, bounded retry, identity disagreement, continuation persistence, and the new compact-completion cases. The live dev build and follow-up UI result are owned by the parent task.
