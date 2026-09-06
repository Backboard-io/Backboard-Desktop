# Failed turn shown as a silent stop

## Local evidence

The GPT-5.5 subscription turn in session `4548f343-01fe-48af-88bc-a4774adba13c` ran from 23:13:16 to 23:13:28 America/Toronto on September 4. It used development packaged runtime build `2026-09-05T02:28:14.417Z` in `/Users/erint/Desktop/test`.

At client sequence 17, one ready `execute` call was absent from the normalized final call list (`missing_call`, readyCount 1 / finalCount 0). The one bounded replay encountered the same condition at sequence 30. Sequence 33 recorded `run:error` and sequence 34 marked the turn failed after 11.85 seconds. No child started. This is a protocol failure before subagent execution, not a missing-Git failure or a subagent randomly exiting. Raw final response frames were not recorded, so the final response shape is not recoverable from these logs.

The host subsequently restored this session. Its stored turn format retained a failed boolean but discarded the live error message, and its restored protocol Turn had no error detail. That explains how reopening an actual failure can leave only a Thought section rather than its actionable error.

A separate Gemini session `9caf01e4-2ad1-408b-817b-614c481350a7` stopped after finding existing utility files. Its actual user prompt explicitly required stopping when existing work was found. This was a prompt-induced stop, not proof that workers require Git.

## Local isolation

The serve entrypoint configures WorkerWorkspaceManager with coordinator checkpoint transactions. Git auto-initialization defaults to false. A plain local folder takes the private snapshot backend; dirty repositories also take this path. Clean repositories can use local Git worktrees. No GitHub account, remote, or network Git connection is required. Snapshot results integrate only when coordinator preimages still match, preserving conflicts and undo durability.

The earlier offline compiled harness fixtures cover three concurrent workers in non-Git/dirty folders and undo; the live three-file test also integrated in this same plain test folder. No new Git repository was created as a workaround for this incident.

Use [the repeatable smoke prompt](SUBAGENT_SMOKE_TEST.md), which reserves a fresh subdirectory rather than requiring an empty or clean workspace.

## Validation

The subscription adapter now retains validated completed call items when terminal output is absent or empty; populated contradictory output still fails. See [the contract report](SUBSCRIPTION_COMPACT_COMPLETION_2026-09-04.md) for primary upstream evidence and the exact incident's missing-capture limitation. Fixed-shape metadata diagnostics now distinguish the possible final forms without capturing content.

The desktop host now persists the compact error type/message and restores it into the failed Turn, preserving the original error over generic fallback messages. Legacy records get an honest generic failure rather than an invented original cause. Error-only child archives also retain their failure detail.

CLI and desktop typechecks passed. The subscription/consumer regressions passed 36 tests (118 assertions); the host suite passed 61 tests, including all seven new durable-error regressions. Two existing archive tests initially exceeded the source runner’s two-second timeout; the full suite passed with a ten-second test-runner timeout, without changing production or test source. The development packaged CLI was rebuilt and signed at `2026-09-05T03:23:19.343Z`. No active app or task was restarted, and no live provider retry was submitted. Restart the development app after active work finishes to load the host-side restoration change. No private transcripts were copied into fixtures or sent to external services.
