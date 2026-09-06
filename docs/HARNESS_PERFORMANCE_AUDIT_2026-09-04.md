# Backboard harness performance and reliability audit

Audit date: September 4, 2026. Repository HEAD: `ab2cdcc1`. This is an analysis and implementation handoff; product code was not changed. Existing uncommitted work was preserved.

The highest-value work is fixing tool-call identity, eliminating mechanical retry loops, making search results truthful, and reducing unnecessary model work. A shorter system prompt helps, but cannot repair a mismatched tool call or an unavailable executable.

## Scope and evidence limits

The active architecture is the TypeScript CLI in `backboard/cli-ts`, launched by the VS Code agent-host adapter in `backboard/src/vs/platform/agentHost/node/cliTs`. Old `backboard-reference` Rust bridge documents are historical, not the current implementation.

I inventoried the CLI source, tests, scripts, and host adapter; reviewed the active turn, tool, provider, prompt, reasoning, notification, startup, logging, and context paths; scanned supporting modules; and examined local runtime logs. The accompanying inventory distinguishes detailed inspection from inventory/search-only coverage. This is not a claim to have read every line of the upstream VS Code tree, third-party dependencies, or backend service code that is absent from this checkout.

The log scan covered 533 `client.jsonl` files under `~/.backboard_ide/cli-ts-sessions/.backboard/sessions`, including nested worker logs. These contain restored sessions, development tests, multiple models, and different binary versions. Counts below are observed records, not a production failure rate or a controlled benchmark. Logs can continue growing while the app is running. I did not make paid model requests or publish private transcripts.

Validation: CLI TypeScript check passed. Two focused test runs passed 36 and 57 tests, respectively (93 total). Temporary, offline reproductions confirmed three additional current-source problems. Passing existing tests therefore does not establish that these gaps are covered.

## Observed search failures

| Observed failure | Records | Interpretation |
| --- | ---: | --- |
| Grep: quoted boolean/number rejected | 39 | Historical failure; current source already normalizes these scalars. |
| Grep: missing `pattern` | 2 | Later transcript shows Glob-shaped inputs attributed to Grep. |
| Grep: nonexistent path | 2 | Bad path selection; distinguish from missing executable. |
| Glob: missing patterns | 3 | Includes todo-shaped inputs attributed to Glob. |
| Glob: cannot spawn `rg` | 2 | Historical packaging/environment failure; current IDE already prepends bundled ripgrep's directory. |
| **Total** | **48** | **43 Grep, 5 Glob.** |

Useful local evidence:

- `12c522ab-dbbd-4907-ba61-d2d23859070e/client.jsonl:34` and `:47`: repeated quoted `head_limit` rejection on September 2.
- `2ff4cfad-6930-43f4-94b2-6b3c0ba6bc61/client.jsonl:64`, `:66`, `:80`, `:128`, `:130`: repeated quoted scalar failures on September 3.
- `f1f382f8-05a5-4ef6-8ccc-bb0fb692fa20/client.jsonl:22` and `:27`: `ENOENT ... posix_spawn 'rg'`.
- `3f1ee939-62b9-4171-a420-e261d852b263/client.jsonl:51–56`: the same ID starts as Glob and is finalized as Grep with `patterns` input; a second instance is at `:61–68`.
- In that last session, `server.jsonl:37` records the mapped final response with the wrong name/argument pairing. That log is **not raw upstream SSE**; it does not establish whether corruption originated in the remote provider, Backboard service, or a version-specific adapter.

All paths above are relative to the session log directory given under Scope. Keep raw transcripts local; construct small sanitized regression fixtures.

## Timing evidence

| Existing timing event | Samples | Median | Approx. p95 | What it measures |
| --- | ---: | ---: | ---: | --- |
| `provider_tool_announcement` | 1,533 | 7,044 ms | 39,487 ms | Start of provider consumption to first tool announcement; combines transport/provider/generation time. |
| `provider_tool_batch_finalize` | 1,645 | 899 ms | 4,298 ms | First announcement to final tool batch, **not local tool execution**. |
| `mutation_prepare` | 129 | 0.4 ms | 1.6 ms | Recorded preparation span. |
| `checkpoint_pre_flush` | 121 | 1.4 ms | 4.8 ms | Recorded checkpoint flush span. |
| `filesystem_commit` | 121 | 0.2 ms | 0.7 ms | Recorded commit span. |
| `checkpoint_post_flush` | 121 | 0.5 ms | 1.9 ms | Recorded checkpoint flush span. |
| `permission_wait` | 22 | 24,396 ms | 173,160 ms | Waiting for approval; do not attribute this to model thinking. |
| `worker_queued` | 17 | 0.0 ms | 0.1 ms | Small recorded sample of worker queue time. |
| `worker_model` | 15 | 11,254 ms | 17,237 ms | Recorded model-related worker span; not an overall worker duration. |

These are pooled historical distributions with a nearest-rank-like index calculation, not estimates for one chosen model or current build. They prioritize investigation; they do not prove that every long turn spends most of its time in reasoning. No clean end-to-end partition exists yet.

The older August 28 `Reply with exactly READY.` benchmarks show OpenAI-profile input usage of 8,372 tokens and Anthropic-profile input usage around 24,070–24,138 tokens. First-visible-token medians were approximately 2.1–2.5 seconds in the five-sample single-agent runs. These tiny historical tests demonstrate baseline request overhead, not comparative provider quality or realistic coding-task speed.

In captured request bodies, 1,761 of 1,942 counted message/tool-output requests explicitly requested medium effort; 160 requested low, 14 max, and 7 null. This does **not** prove dynamic mode caused them: fixed settings can produce the same payload. The current saved global config observed during review had thinking set to null, so historical payloads must not be presented as today's effective setting for every session.

## Findings and priorities

### P0 — Tool identity is not part of early-result reconciliation

[ToolScheduler.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/tools/ToolScheduler.ts:323) reuses an early result by ID and `JSON.stringify(input)` equality. `EarlyExecution` stores no tool identity. An offline reproduction offered `ReadA` with ID `same-id`, then finalized `ReadB` with the same ID and `{}` arguments: only ReadA executed and its result was returned for the finalized call.

The logged Glob/Grep mismatch is related evidence of inconsistent identity across phases, but the exact logged input fails Grep validation, so it takes the error path rather than this wrong-result reuse path. Do not conflate those two observations.

Repair: immutable canonical tool identity plus normalized argument fingerprint, session/attempt scoping, validation of advisory versus authoritative frames, and safe handling of mismatches. Never infer a different tool solely from argument shape. Never solve this by globally disabling parallel or early read execution. Add a sanitized provider replay to locate the upstream mismatch and an independent scheduler regression for same-schema tools.

### P1 — Source/binary drift can make fixed bugs appear persistent

[cliTsProcess.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts:140) prefers a packaged binary before the source fallback. Source fixes need not be in the executable serving the session. The repository binary had a September 3 09:53 mtime; scalar coercion was committed at 10:21; the separately installed Desktop app binary had a 10:54 mtime. Mtimes are suggestive, not proof of embedded content.

[Tool.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/tools/Tool.ts:130) already calls `coerceScalarStrings`; [ToolInputCoercion.test.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/tests/ToolInputCoercion.test.ts) passes. [cliTsAgent.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/src/vs/platform/agentHost/node/cliTs/cliTsAgent.ts:1838) already resolves bundled ripgrep and passes its directory into the subprocess PATH.

Repair: report build SHA, build time, protocol version, prompt/schema versions, executable path, and resolved search executable in the ready handshake/diagnostics. Verify both packaged and source execution under a sparse GUI PATH. Preserve existing fixes instead of duplicating them. Do not silently replace the user's running app during implementation.

### P1 — Search contracts give incomplete or misleading results

[GlobTool.tsx](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/tools/GlobTool.tsx:145) prepends `!` to each exclusion. The shared [Glob prompt](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/prompts/tools/glob.tsx) explicitly suggests `!node_modules/**` through `excludePatterns`. Offline reproduction: `excludePatterns: ["node_modules/**"]` excluded the dependency; `["!node_modules/**"]` returned it. This wastes context and can misdirect code discovery.

[GrepTool.tsx](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/tools/GrepTool.tsx:179) applies `head_limit` after capturing output, so it is not an execution bound. Its 40,000-character slice can cut a path or line mid-record without a truncation marker. Reproduction returned exactly 40,000 characters, no truncation notice, and a trailing partial path. Its `matchCount` counts rendered lines, including context, rather than true matches. A signal-terminated process maps null exit status to 1, potentially masking a non-cap termination as no-match/success.

Glob stops at 1,000 files but returns `Found 1000 files` without saying that more may exist. The existing cap test enshrines that wording. Both tools directly spawn `rg`; Grep and Glob implement separate buffering/exit handling, and Glob stderr is unbounded. Neither has an independent search deadline. Hidden/ignored-file behavior depends on ripgrep defaults and explicit glob overrides; do not claim every dotfile is necessarily omitted.

Repair: a shared bounded search runner with explicit status, cancellation/deadline/cap distinctions, UTF-8-safe complete records, truncation flags, truthful counts, consistent path handling, and a documented inclusion/exclusion contract. Add explicit hidden/ignored controls where needed. Keep default ignore behavior efficient; do not globally enable unrestricted scanning. Use a files-only mode for discovery, targeted content for inspection, and an explicit bounded fallback if search capability is unavailable.

### P1 — Reasoning escalation treats infrastructure errors as hard reasoning problems

[thinking.dynamic.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/config/thinking.dynamic.ts) starts ordinary dynamic user requests at medium; any tool failure raises effort to high, and two consecutive failed rounds can request max. [ToolRoundEvidence.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/agent/ToolRoundEvidence.ts) extracts failure signals partly by searching arbitrary output text for `Error:` or `exit code:`. It computes `readOnlyOnly` but the dynamic decision does not use it.

Consequences: validation mistakes, absent binaries, missing paths, approval failures, or even diagnostic strings found in source can be mistaken for evidence that more thinking will help. Maximum is not requested forever: a `maxUsed` flag and a success reset already exist. This remains a poor escalation signal.

Repair: typed error/exit metadata, cheap-task handling, and escalation based on repeated semantic failures after a meaningful change in approach. Preserve explicit user effort settings. Provide observable effective settings and reasons, not a second LLM classification request. Dynamic maximum should require strong evidence or explicit user choice, not two mechanical failures.

Also audit adapter parity: [CodexSubscriptionClient.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/providers/subscription/CodexSubscriptionClient.ts:98) maps null, undefined, and max to low; the BYOK OpenAI adapter has model-specific forced-none behavior. Their UI labels therefore cannot be assumed to mean identical wire behavior. Verify current provider contracts before changing these mappings; a lower setting is not guaranteed to remove all internal reasoning.

### P1 — Completion can trigger hidden extra model work

[FinalVerificationNotification.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/agent/notifications/FinalVerificationNotification.ts) fires after 17 calls for an enabled user turn, with the default enabled. This counts reads/searches too, not just risky changes. [AssistantAccumulator.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/agent/AssistantAccumulator.ts) can withhold a potential final answer until the extra verification request replaces it; commentary in such segments is delayed until finalization.

[TodoReconciliationNotification.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/agent/notifications/TodoReconciliationNotification.ts) can run up to five hidden passes and offers the full tool set. It has useful protections already: null thinking, a pass cap, and a stall break. But “bookkeeping” can still trigger arbitrary work and additional model round trips. Its prompt tells the model to update todos, while the implementation deliberately exposes tools to finish work.

These are **current-source mechanisms**, not quantified causes in the scanned historical requests: the request scan found no matching notification prompt bodies. Measure their activation in the current build before claiming a realized speedup.

Repair: verification based on mutation risk, acceptance criteria, and missing validation evidence; no extra inference solely because a read-only task reached a call threshold. Keep unfinished work visible. Reconcile todo metadata at most once when truly needed, with a narrow tool set and bounded latency; if actual work remains, continue visibly. Do not mark unresolved tasks complete to make the UI stop spinning.

### P1 — Prompt rules encourage unnecessary work and differ by profile

The active prompts are not one file. [profiles/index.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/prompts/profiles/index.ts) selects shared/default, OpenAI, Anthropic, or GLM implementations. Tool descriptions also vary by profile. Editing legacy `prompts/system/core.tsx` alone will miss active paths.

Specific issues:

- Anthropic's verification section says to discover lint/typecheck/tests and **run all of them** unless told to skip. For a large VS Code fork, this is expensive and often unrelated to a small change. Replace with relevant validation, fixed acceptance criteria, and a stop rule after sufficient checks pass.
- The startup Todo reminder says every non-trivial task **must** call TodoWrite and asserts a performance benefit. Tool guidance ties todo use to as few as three calls. This encourages repeated planning/bookkeeping even for short tasks.
- Shared Grep text suggests broad speculative searches, while other text says to choose the narrowest safe scope. Make the discovery sequence explicit: known path → direct read; unknown path → one scoped discovery; investigate candidates; widen only with a reason.
- Repeated prose parameter tables duplicate JSON schemas and drift. For example, the shared Grep table omits implemented `fixed_string` and `head_limit`.
- The OpenAI system builder does not include `clientTools` guidance. Reproduction showed `clientToolsEnabled` added 639 characters in other profiles and zero in OpenAI. Fix the shared capability assembly without copying lengthy persona text.
- Harness reminders should be trusted only through their actual privileged source. Anthropic currently blanket-trusts text labeled `<system-reminder>`; files and tool outputs can contain those same tags. Clarify provenance rather than increasing instruction volume.

Some captured requests had roughly 40–42 KB of serialized tool definitions in addition to an 11 KB system prompt. This is an optimization target for duplicated descriptions and irrelevant tool exposure, not proof that input prefill is the dominant delay.

Repair: one compact shared behavioral contract, short optional capability modules, generated/validated schema examples, proportionate verification, and stop conditions. Keep provider differences only where justified by measured behavior. The implementation prompt includes a candidate replacement for testing.

### P2 — Missing parent stream deadline and weak liveness distinctions

[AgentLoop.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/core/agent/AgentLoop.ts:116) configures a 30-second event-idle timeout only for subagents. Parent consumers default to no idle timeout. [BackboardClient.ts](/Users/erint/Documents/GitHub/Backboard-Desktop/backboard/cli-ts/src/providers/backboard/BackboardClient.ts:418) emits activity for keepalives/partial frames, and the consumer's timer resets per event. A stream can therefore appear alive without making semantic progress.

Repair: separate transport liveness, meaningful progress, first-event delay, total elapsed policy, and approval/tool wait phases. Make them configurable and model-aware. Preserve cancellation, retry limits, and provider history. Do not replay a possibly accepted mutating request blindly after timeout. Do not mistake lack of visible prose for lack of progress during large streamed tool arguments.

### P2 — Startup, catalogs, persistence, and UI need measurement before more refactoring

- `serve.ts` awaits MCP initialization before ready; an enabled slow server can delay startup. MCP connections are already parallel. Refreshes already have a 60-second gate; model catalogs already have a five-minute cache. Avoid proposing those existing optimizations as new work.
- `AgentController.runTurn` already parallelizes dynamic tool sync, skill context, assistant resolution, and thinking metadata; existing threads skip assistant resolution. Startup probes are already parallel with short individual timeouts.
- Consider background initialization of optional services and stable snapshot publication. Do not let the advertised tool set change underneath an active round or omit explicitly requested skills.
- Early reads and concurrency-safe batching already work. There is no general bounded local-tool concurrency pool in the scheduler: add limits only with throughput/CPU evidence and preserve dependency and permission barriers.
- `JsonlWriter` serializes append operations and offers batching, but ordinary `write()` queues one append per record. This could add disk/event-loop pressure in long streams. Reasoning updates already coalesce to approximately 10 per second in current source; worker forwarding already has batching. Profile before duplicating those fixes, and preserve checkpoint durability independently of lossy display telemetry.
- Long turns accumulate tool outputs; `Read` loads a whole file up to 5 MB before slicing lines. The current auto-compaction policy waits until after a turn and uses an 85% threshold. Inspect context headroom on long tool loops and per-result budgets; don't reset a live remote thread mid-tool submission or casually discard reasoning continuation items required by a provider.
- The browser bridge logged eight 60-second `openBrowserPage` failures and an older 300-second failure. Current code already reduced that browser timeout. Fix readiness/approval visibility and cancellation propagation; do not merely shorten the timeout again or auto-approve everything.

## What to preserve

Keep scoped permissions, cancellation, ordered mutations, dirty-worktree protection, checkpoint flush boundaries, existing concurrency, stable call IDs, provider continuation data, and accurate incomplete-task reporting. The measured checkpoint spans are too small to justify weakening undo durability to improve speed.

## Proposed implementation order

1. Capture a current baseline and runtime/build identity; commit sanitized replay fixtures.
2. Fix tool identity reconciliation and diagnose advisory/final mismatches.
3. Correct search contracts, output limits, and packaged search availability.
4. Introduce typed failure categories and useful effective-reasoning telemetry.
5. Remove unnecessary completion inference and align concise prompt/capability assembly.
6. Add stream liveness bounds and run quality/latency evaluations.
7. Optimize optional startup, logging, context, and rendering only where remaining measurements justify it.

For API guidance, concise direct reasoning-model prompts and fewer sequential requests are supported by [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices) and [latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization). The latter cautions that prompt-length reductions alone can have modest latency effects; measure behavior and round trips as well as token counts.

Use `HARNESS_IMPROVEMENT_AGENT_PROMPT.md` as the implementation handoff. It contains concrete tests, rollout requirements, and a candidate runtime system prompt.
