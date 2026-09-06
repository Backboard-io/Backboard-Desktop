# Harness implementation and validation — September 4, 2026

Subsequent work on subagents and parallel writes is documented in [the worker reliability report](PARALLEL_WORKER_RELIABILITY_2026-09-04.md), including updated prompt sizes, 1,708 passing CLI tests, and source/compiled offline worker benchmarks. The phase results below retain their original measurement scope.

Implemented against working-tree HEAD `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259`. The dated performance audit was the baseline, not a description assumed to remain correct. Existing unrelated desktop/UI edits were preserved. Active changes target `backboard/cli-ts` and `backboard/src/vs/platform/agentHost/node/cliTs`; reference source copies and the old Rust bridge were not modified.

The changes improve local correctness, bounded search latency, and inference bookkeeping. They do **not** establish a measured live-model completed-task speedup: validation used local tests, synthetic provider streams, and compiled search fixtures without paid model calls. No installed application was replaced or relaunched, and no private transcript or credential was sent to an external service.

## Review by phase

### Tool identity and streaming

- Early results require matching canonical tool name, structurally canonical validated arguments, session, turn, round, and attempt. Object-key order is harmless; array order, scalar types, literal values, and tool identity remain significant.
- Same-name argument changes execute the final validated call. Conflicting complete names and duplicate final IDs fail explicitly. Repeated identical finalization reuses the existing result. Previously answered IDs cannot silently acquire a new identity in later rounds.
- OpenAI/OpenRouter fragment accumulation preserves indices, actual IDs, and fragmented names. Backboard, BYOK, Claude subscription, and Codex subscription boundaries reject malformed or inconsistent complete calls before committing them. Codex complete-message reconciliation retains continuation items.
- Reset cancels active attempts and suppresses orphan events/results. Successful round completion leaves supervised background workers alive; parent cancellation and task management still own their lifetime. Independent safe reads remain concurrent, with permissions, hooks, ordered mutations, and checkpoints preserved.
- New compact identity records trace normalized names and argument fingerprints. Provider first-event, first-visible-event, and stream-total timing complement execution and desktop projection timing. Diagnostic events stay out of parent/child transcript content.

Primary review files: `ToolScheduler.ts`, `ToolCallIdentity.ts`, `ToolRoundProcessor.ts`, `ProviderStreamConsumer.ts`, `ToolCallDeltaAccumulator.ts`, `ToolCallProtocolGuard.ts`, and provider adapters. See [the protocol contract](HARNESS_TOOL_PROTOCOL_CONTRACT.md) for the sanitized historical replay and service-boundary requirements.

The service implementation is outside this repository. The old server record already contains a mapped inconsistent pairing, but no original raw upstream SSE was available. The local guard prevents reuse/persistence of that pairing; it does not establish which remote or historical local component introduced it.

### Grep and Glob

- Shared ripgrep resolution caches capability checks by runtime configuration, including standalone overrides and PATH. The existing host handoff of bundled ripgrep remains intact. Missing/incompatible binaries produce actionable typed failures; unavailable search schemas are removed from subsequent requests in that turn.
- A shared argv-based runner bounds records, stdout, and stderr; handles complete UTF-8 records; terminates and reaps processes; and distinguishes cancellation, deadline, cap, invalid arguments/patterns, unavailable executable, missing path, permission failure, and unexpected termination.
- Grep stops at `head_limit` instead of collecting a large tail first. Glob's 1,000-file cap now describes partial results. Results expose returned count, count unit, truncation, limit reason, and whether a total is known. Context lines are not called matches. Exit code 1 is a successful no-match result, including in desktop rendering.
- Glob's canonical `excludePatterns` contract is unsigned. A single leading `!` is accepted for compatibility and normalized once. Active provider guidance and schemas agree. Hidden/ignored controls, explicit file inputs, literal regex metacharacters, and PCRE capability checks have regression coverage.
- Existing scalar coercion was preserved and expanded with narrow compatibility handling. Optional nulls and unambiguous serialized scalar/array forms are repaired; literal strings remain literal, and `"false"` is false. Invalid schemas produce compact model-visible explanations with structured debugging information retained.

Primary review files: `src/core/search/*`, `GrepTool.tsx`, `GlobTool.tsx`, `coerceInput.ts`, `ToolUiData.ts`, and their tests.

### Failure and reasoning policy

- Tool execution state now carries failure category, exit code, timeout, cancellation, retryability, and outcome independently of result prose. Source content containing `Error:` or `exit code:` cannot itself escalate effort or turn a successful search into a failure.
- Dynamic reasoning starts routine discovery and narrow mechanical tasks at low supported effort. Mechanical failures and approval waits do not escalate; a failed validation can justify higher effort. Progress de-escalates continuations. Fixed settings, provider defaults, explicit off intent, unsupported capabilities, and fallback models pass through the resolver rather than a blanket downgrade.
- Diagnostics record requested intent, resolved effort/budget, effective wire setting, and override reason, without reasoning text. Notification requests use the same intent resolver as ordinary turns.
- Subscription `max` is no longer silently mapped to low: its adapter clamps to high and reports that fact. Unspecified effort is omitted. Existing subscription off-to-low and BYOK model-specific forced-none compatibility behavior is reported honestly; this work does not claim those endpoints all support identical semantics or that hiding reasoning eliminates its computation.

Primary review files: `ToolFailure.ts`, `ToolInvocationRunner.ts`, `ThinkingEvidence.ts`, `ToolRoundEvidence.ts`, `config/thinking.dynamic.ts`, `AgentLoop.ts`, and `tests/HarnessThinking.test.ts`. Full-request tests cover mechanical failure, validation failure, no matches, source-code error strings, fixed/off settings, fallback, and unavailable tool filtering.

### Prompts and unnecessary inference

- Shared capability assembly now includes enabled client-tool guidance for OpenAI as well as the other active profiles. Common workflow guidance specifies known-path reads, scoped discovery, proportional planning, meaningful validation, and a stopping rule after relevant checks pass.
- Removed repeated tool-schema tables, blanket planning/checking rules, and trust based merely on `<system-reminder>` formatting. Provider-specific adapters and gated optional capabilities remain.
- Verification uses ordered mutation/validation evidence instead of a 17-call threshold. Read-only investigations do not trigger a cleanup request because they used many tools. Already validated changes finish directly; unchecked changes can use one visible bounded verification phase.
- Deleted hidden todo-reconciliation inference. Unfinished plans remain unfinished; the final answer is not regenerated merely to tidy plan metadata. Historical persisted verification markers retain recovery recognition.

Validation evidence is deliberately conservative: direct recognizable validation commands can clear pending changes, but the harness cannot prove arbitrary shell output or a prose readback satisfied every acceptance criterion. Prompt guidance still asks the model to choose checks for risk and the user's requirements. The desktop's existing setting disabling the extra final-verification nudge was preserved.

## Measured results

### Local search: old HEAD versus changed source

Nine alternating warm trials per case, using local fixture data and the same ripgrep executable. Values are median wall-clock milliseconds:

| Fixture | Baseline | Changed | Interpretation |
| --- | ---: | ---: | --- |
| 640-byte input, head limit 20 | 5.015 | 5.650 | About 0.6 ms metadata/runner overhead |
| 580 KB dense matches, head limit 20 | 5.873 | 6.045 | About 0.2 ms overhead |
| Early match then 32 MiB nonmatching tail, head limit 1 | 20.272 | 4.434 | 78.1% lower latency from stopping early |

This is a bounded-search improvement, not a claim that every small search is faster. The stronger benefit for huge results is truthful bounded output and avoided processing, alongside speed.

### Rendered prompt size

UTF-8 bytes for base system text plus active tool descriptions, measured before/after with the same profile inputs. Optional client-tool guidance is measured separately; token counts and provider cache effects were not estimated.

| Profile | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Default | 42,964 | 24,988 | 41.8% |
| OpenAI | 26,121 | 21,884 | 16.2% |
| Anthropic | 44,835 | 25,380 | 43.4% |
| GLM | 44,835 | 25,380 | 43.4% |

Enabled client-tool guidance adds 641 bytes in every profile; OpenAI previously omitted it entirely.

### Opt-in provider replay

`bun run test:harness-performance --output /tmp/backboard-harness-performance.json` exercises the real AgentLoop and ToolScheduler with synthetic cancellable delays, no network or model cost. Existing live `agent-eval.ts` and `chat-first-token-benchmark.ts` remain available; replay does not treat their live metrics as interchangeable with simulations.

Seven cases pass: eighteen reads, early parallel reads, final-only parallel reads, serial reads, validated edit with an unfinished plan, retry after an early read, and cancellation after an early read.

- Eight early parallel reads: 140.65 ms; final-only parallel comparator: 195.59 ms. The 28.1% difference demonstrates preserved early overlap under the fixture delays, **not** a before/after patch speedup.
- Eighteen reads and the validated edit each use two requests total: initial request plus tool-result continuation. No extra bookkeeping/verification inference; one final answer. The unfinished plan stays unfinished.
- Retry submits one authoritative result despite two read attempts. Cancellation returns in 42.11 ms with no submitted results or late terminal events.

The checked-in [results artifact](HARNESS_VALIDATION_RESULTS_2026-09-04.json) contains sanitized measurement data and validation scope.

## Validation and deployment boundaries

Final validation: **1,673 CLI tests passed, 3 Windows-specific tests skipped, 0 failed**, with 4,393 assertions across 154 files (77.87 seconds). **56 desktop adapter tests passed**. CLI TypeScript checking, desktop `typecheck-client`, Biome checking of 113 changed/new CLI files, `git diff --check`, an isolated compiled CLI build, and a sparse-PATH compiled search smoke also passed. Earlier runs exposed and helped fix a detached-worker lifetime regression, diagnostic relay pollution, and stale prompt assertions; these are resolved in the final run.

Desktop tests load the changed TypeScript adapter/test modules through a temporary transpilation loader, using the repository's existing compiled dependencies. This tests the current adapter source without overwriting the running IDE's `out/` files. It is not a full application packaging or live IDE end-to-end run.

Regression coverage includes tool identity/alias/key order/duplicate events, retry and cancellation lifecycle, ordered mutations, argument coercion, search output/error distinctions, UTF-8 boundaries, missing executables/paths, hidden/ignored files, actual provider payloads, notifications, permissions, checkpoint/undo behavior, worker recovery, and desktop result projection. Local process and loopback callback tests require access beyond a restricted sandbox; the offline suite was run with that access rather than weakening tests.

## Identify and adopt the build

Historical and current local logs were inspected under `~/.backboard_ide/cli-ts-sessions/.backboard/sessions` and the desktop log roots. Different records came from different binaries/settings. Observed executable paths include:

- Installed application: `/Users/erint/Desktop/Backboard Studio.app/Contents/Resources/app/extensions/backboard/bin/backboard-cli-ts`.
- Development application: `/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/extensions/backboard/bin/backboard-cli-ts`.

The development agenthost log inspected was `~/Library/Application Support/code-oss-dev/logs/20260904T152504/agenthost.log`. Its existing ready records predate the new identity fields. The launcher prefers packaged binaries over source; editing CLI source alone does not update either packaged executable.

The serve handshake now reports executable path, source/compiled mode, source SHA, build timestamp/dirty flag, Bun/application/protocol versions, prompt version/hash, schema hash, and resolved ripgrep capability. Per-request hashes and effective thinking settings explain configuration changes within a session. The desktop logs the handshake alongside its existing executable fingerprint. `--runtime-info` provides a no-auth/no-network binary diagnostic; prompt/schema hashes are computed with the configured serve/request context rather than guessed by that standalone command.

An isolated current-source CLI was built at `/tmp/backboard-harness-validation`. Its identity reports SHA `ab2cdcc1f589a56b7c9d7f955a79b4cc6d78b259`, dirty source, application 3.0.2, Bun 1.4.0, protocol 1, prompt version `2026-09-04.1`, and build timestamp `2026-09-04T21:25:53.629Z`. The sparse-PATH search fixture used the repository's bundled ripgrep 15.0.0; ordinary runtime diagnostics resolved the available ripgrep 15.2.0 from PATH. These are distinct verified configurations.

Reproduce the isolated build from `backboard/cli-ts`:

```sh
BACKBOARD_CLI_OUTFILE=/tmp/backboard-harness-validation bun run build
/tmp/backboard-harness-validation --runtime-info
bun build --compile tests/fixtures/search-build-smoke.ts --outfile /tmp/backboard-search-smoke
env -i PATH=/usr/bin:/bin BACKBOARD_RIPGREP_PATH=/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/node_modules/@vscode/ripgrep/bin/rg /tmp/backboard-search-smoke
```

To adopt later in the repository development application, run `npm --prefix extensions/backboard run package-cli-ts` from `backboard`, then deliberately restart the intended development app/session and verify its ready identity. This packages, copies, and signs the CLI; it was **not** run during validation because it changes the executable used by the user's IDE. Alternatively, set `BACKBOARD_CLI_TS_PATH=/tmp/backboard-harness-validation` when deliberately launching a separate development instance. Updating the installed application requires its normal packaging/install workflow; a repository build does not update that app.

Remaining external validation is a representative live-model task matrix across supported providers and the original upstream stream contract. Use the new identity/timing events to compare completed-task success and latency without reading private reasoning. No blanket performance or provider-equivalence claim is made ahead of that measurement.
