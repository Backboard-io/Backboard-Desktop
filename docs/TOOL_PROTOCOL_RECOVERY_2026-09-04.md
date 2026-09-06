# Subscription tool reconciliation follow-up

The development session `74a7ecc0-8913-4998-ab6e-c13506891712` used build `2026-09-04T23:15:42.645Z`. It announced one Glob call, began a speculative read, retracted it, then failed at subscription completed-output reconciliation. The session log did not contain the final raw provider item. It cannot establish whether the disagreement involved a missing call, name, or arguments, or attribute it to the remote endpoint. Frozen-input checks found no mutation in the current Glob parse/UI/execution path.

The subscription adapter now compares canonical registered tool names and structurally canonical JSON arguments, while retaining immutable identity snapshots and yielding independent ready-call objects. Harmless aliases/key order do not fail reconciliation; actual name/input changes and missing final calls remain invalid. Disagreement diagnostics contain bounded IDs/names and SHA-256 argument fingerprints, never argument values.

Only this adapter's disagreement before releasing a final tool batch requests one immediate retry. The consumer resets speculative reads and rows, discards invalid partial text, retains the same model/reasoning settings, and respects cancellation. A second failure remains terminal. Generic protocol failures are not made retryable. The adapter rolls back uncommitted response items before replay, so rejected calls cannot leak into persisted continuation input. Mutations remain gated behind finalization; the retry does not replay previously submitted tool outputs as local mutations.

Native TypeScript compilation passed. All 125 tests across seven affected suites passed (381 assertions, 5.60 seconds): subscription adapter, stream consumer, accumulator, identity regressions, scheduler, thinking policy, and loop smoke. The consumer fixture uses the actual subscription adapter with offline SSE and verifies unchanged request input/reasoning across recovery, an aborted early read, no orphan result, bounded retry, and cancellation.

The development packaged runtime was rebuilt and signed. `--runtime-info` reports compiled build timestamp `2026-09-05T02:12:34.531Z`, source HEAD `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259` with dirty changes, Bun 1.4.0, application 3.0.2, protocol 1. No running app was restarted and no separately installed app replaced. Live provider behavior after this update remains unverified; fresh development sessions use the rebuilt binary.


## Identical final-list duplicates

Session `683e6184-c8ac-4d33-8d27-caaa5ae5fde3` (Backboard/Gemini, older build `2026-09-04T23:15:42.645Z`) failed at `2026-09-05T02:10:02Z`. Its mapped trace establishes two final entries with the same call ID, `glob` name, and identical argument fingerprint, matching the ready call. The generic protocol guard incorrectly rejected this repeated identical invocation. Raw upstream SSE was not captured, so the report does not assign the duplication to a specific upstream component.

The provider boundary now collapses identical same-ID entries using canonical tool names and structural argument comparison, preserving first occurrence order. Different IDs remain separate even with identical arguments. Same-ID entries with different names or arguments still reject the complete batch before mutation. The scheduler remains strict about duplicate IDs passed directly; normalization happens at the protocol boundary. Regression coverage runs the actual mapper and scheduler to verify a duplicated mutation and repeated finalization produce one execution/result.

Native TypeScript compilation and 101 tests across five affected suites passed (332 assertions, 5.51 seconds). The development runtime was rebuilt/signed and `--runtime-info` verified build `2026-09-05T02:14:28.216Z`. No running app was restarted.
