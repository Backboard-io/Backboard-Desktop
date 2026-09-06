# Tool-call protocol contract and replay

Verified against the September 4, 2026 working checkout. These changes target `backboard/cli-ts` and its active desktop adapter, preserving existing unrelated edits.

## Identity invariant

An early read result is reusable only when the final call has the same ID, canonical registered tool name, validated argument structure, session, turn, round, and retry attempt. Object keys are sorted for comparison; arrays, scalar types, literal strings, and values remain significant. Tool aliases use the registry's existing mapping. No tool name is inferred from argument shape.

Only read-only, concurrency-safe calls before the first incomplete or mutating call may execute early. Permission checks, trusted-hook barriers, ordered mutations, checkpoint boundaries, and cancellation remain active. Same-name argument corrections discard the early read and execute the validated final input. Conflicting complete tool names produce a protocol error. Duplicate final IDs are rejected before mutation; repeated identical finalization shares its existing result. Reset aborts active attempt work and discards reuse state.

Advisory names can be fragments or use provisional UI IDs, so they are not treated as authoritative arguments or executed independently. Complete ready/final messages supply execution identity. The consumer rejects an inconsistent final batch before assistant call persistence; BYOK also guards before its own conversation commit.

## Provider boundary

The Backboard service implementation is not present in this checkout. Its client accepts `tool_call_start`, `tool_call_ready`, and `tool_submit_required`; raw OpenAI-style deltas are only an advisory UI source. The historical client records in session `3f1ee939-62b9-4171-a420-e261d852b263` confirm a Glob ready/start followed by Grep under the same ID with Glob-shaped input. Server record 37 is already a mapped `requires_action`, not raw upstream SSE. It cannot establish which remote component or older local adapter introduced the disagreement.

The later Gemini Backboard UI smoke test reproduced `agent_spawn` → `glob` with an unchanged ID and input hash at the service boundary. See [the sanitized incident and remote retry contract](BACKBOARD_WORKER_PROTOCOL_INCIDENT_2026-09-04.md). The client stops at the terminal protocol rejection; it does not replay already submitted remote outputs without a service idempotency guarantee.

`backboard/cli-ts/tests/fixtures/tool-identity-mismatch.json` reconstructs that shape with invented IDs, a synthetic path, and no transcript content. Replaying it now produces a non-retryable protocol failure; it never relabels the call or submits an early Glob result as Grep output. A service-side contract test should feed the same ID/name/arguments through every provider accumulator, continuation merge, ready message, and final batch and require identity preservation. Actual upstream SSE is still needed to locate the historical source.

OpenAI/OpenRouter accumulation is indexed, supports interleaved independent calls and fragmented names, and requires real final IDs. Replaced IDs, duplicate IDs at different indices, ambiguous missing indices, and malformed final JSON fail explicitly. Anthropic rejects input deltas without an active block and repeated active block indices. Google uses its full function-call parts and stable IDs; BYOK validates complete calls before persistence. Claude subscription validates complete call batches before persistence. Codex subscription no longer turns malformed JSON into `{}`; it deduplicates identical done items and reconciles complete response output before committing, retaining provider continuation items.

Google calls without a provider-supplied ID receive a UUID-scoped stream prefix plus an index. The index alone previously repeated across model rounds and concurrent workers. Generated IDs remain local bookkeeping and are omitted from Gemini's wire payload; actual provider IDs are preserved.

Codex subscription treats complete `output_item.done` items as authoritative when the completion summary omits its output or includes an empty output array. Populated final arrays still undergo strict identity reconciliation. See [the compact completion contract, incident limits, and offline fixture](SUBSCRIPTION_COMPACT_COMPLETION_2026-09-04.md).

## Worker edit projection

An isolated worker's tool result describes proposed writes in its private checkout. Desktop live results and recovered archives do not register these as coordinator file edits until `workspace.status` is `Integrated` or the durable worker record reports `integrationStatus: integrated`. Running, pending, failed, conflicted, and cancelled work preserves its transcript without advertising an applied coordinator diff. Reopening also avoids reattaching stale edit records saved by older builds. Legacy workers that operate directly in the shared workspace retain direct edit tracking.

The desktop reloads the child archive at its terminal event rather than retaining an earlier partial cached read. Recovery preserves failed tool status when attaching rich content, and failed/cancelled/conflicted workspace outcomes cannot become successful turns merely because the private model finished normally.

Legacy precision limit: old recovered diffs use the worker's recorded before/after text after integration. New integrations persist exact coordinator before/after snapshots tied to their integration transaction, including native Git merges of independent edits to one file. See [the workspace revision and integration-record contract](WORKSPACE_LIFECYCLE_INTEGRATION_2026-09-05.md). Runtime checkpoints remain authoritative for durable undo.

## Diagnostics

- `tool:identity`: session/turn/round/attempt, call ID, canonical name, phase, argument hash, and mismatch reason. Arguments are never included in these added records.
- Backboard server response `toolIdentityTrace`: at most 256 mapped identity records. Set `BACKBOARD_TRACE_TOOL_FRAMES=1` only for a diagnostic run to also capture sanitized raw index/ID/name fragments, argument byte lengths, and hashes. It never records raw argument values or reasoning text. With the option absent, raw-fragment hashing is skipped.
- `provider_first_event`, `provider_first_visible`, and `provider_stream_total` complement existing tool announcement/finalization timings. Local thinking-setting diagnostics do not count as the first provider response. Transport activity counts for transport liveness, but not visible output.
- `provider:diagnostic` records bounded completion shape and fixed item-type counts. It never records raw item payloads or unknown type strings, and does not produce visible output or first-response timings.

The added telemetry does not change existing private session-log retention policy. Keep raw historical logs local.

## Validation and offline benchmark

The focused Phase 1 suite passed 127 tests across ToolCallRound, ToolIdentityRegression, mappers, BackboardClient, ProviderStreamConsumer, CodexSubscriptionClient, ByokClient, and OpenRouterAdapter after a clean CLI typecheck. It covers canonical name/argument mismatch, aliases, reordered keys, duplicate calls, early reads, mutation barriers, provisional IDs, invalid JSON/schemas, retries, cancellation, and late event suppression.

Run the opt-in offline measurement with:

```sh
cd backboard/cli-ts
bun run scripts/harness-performance-benchmark.ts --output /tmp/backboard-harness-performance.json
```

This runs the real AgentLoop/ToolScheduler with synthetic provider frames and cancellable tool delays. It makes no network requests and does not run shell commands or modify application installations. Seven replay cases passed: eighteen reads, early parallel reads, final-only parallel reads, serial reads, a validated edit with an unfinished plan, retry after an early read, and cancellation after an early read.

One local run measured 139.9 ms for eight early parallel reads, 195.3 ms when ready frames were omitted, and 590.7 ms when the same reads were serialized. The 55.4 ms / 28.4% difference demonstrates preserved overlap under the configured delays, not a live-model speedup or a before/after measurement of the old checkout. Eighteen reads and a validated edit each finished with exactly two model requests (initial plus tool-result continuation), one final answer, and no bookkeeping/verification inference. The unfinished plan stayed unfinished. Cancellation returned in 41.3 ms with zero submitted results and zero late terminal events. Retry returned one authoritative result, despite two read attempts.

Live-model completed-task latency, provider quality, and the original remote stream defect require an authorized representative live run. The replay separates local correctness and scheduling cost from those unmeasured factors.
