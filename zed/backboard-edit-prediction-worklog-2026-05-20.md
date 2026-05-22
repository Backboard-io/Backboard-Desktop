# Backboard Edit Prediction Worklog - 2026-05-20

This is a detailed recap of the Backboard edit-prediction debugging and stabilization work from May 20, 2026.

## Problem

Backboard edit prediction was failing with:

`Backboard run failed: Conversation roles must alternate user/assistant/user/assistant/...`

The failure surfaced in `crates/edit_prediction/src/edit_prediction.rs:2517` when the Backboard completion task bubbled up an error to the edit-prediction pipeline.

## What We Investigated

### 1. The Backboard completion path

We traced the call chain from the edit-prediction entry point into:

- `crates/edit_prediction/src/backboard.rs`
- `backboard_completion(...)`
- `backboard_completion_with_larger_model_retry(...)`

The first goal was to find whether the error came from:

- the thread being reused incorrectly
- the assistant/thread caches being stale
- the request payload being malformed
- or the provider rejecting the same conversation state repeatedly

### 2. Existing retry logic

The code already had a retry path for invalid threads and model context failures.

We found that:

- invalid thread errors caused a fresh thread to be created
- context errors could trigger a larger model fallback
- but the role-alternation error was not handled robustly enough

## Approaches We Tried

### Approach A: Retry on a fresh thread only

We first added retry handling for the role-alternation failure so that when the provider returned:

`Conversation roles must alternate user/assistant/user/assistant/...`

the code would:

- invalidate the cached thread
- create a new thread
- retry the same prompt

#### Result

This was not enough. The same error kept coming back even after a fresh thread.

### Approach B: Retry at both the stream error layer and the outer retry layer

We widened the retry handling so the same alternation failure was recognized in:

- streamed `run_failed` / `error` payloads
- non-2xx HTTP response bodies

#### Result

This fixed the control flow, but the provider still failed on repeated retries. The logs showed the same failure on new threads.

### Approach C: Restart the assistant as well as the thread

We then changed the retry to reset more state:

- invalidate the cached assistant
- invalidate the cached thread
- resolve a new assistant
- create a new thread from that assistant
- resend the prompt

#### Result

This improved the reset behavior, but the same backend/model combination still failed on the fresh assistant/thread pair.

### Approach D: Add structured-provider-error matching

The logs showed `error_type: "ProviderAPIError"`, so we broadened the matcher to treat that as a retryable role error too.

#### Result

This made the retry path more complete, but it still did not solve the underlying backend failure.

### Approach E: Fall back to another model

We then concluded the issue was not just stale conversation state.

The same model/provider was failing deterministically even on a fresh assistant and fresh thread.

So we added a model fallback path:

- after the fresh-thread retry fails, select another live model from the registry
- restart with that model
- keep the retry path bounded so it does not loop forever on the same backend

#### Result

This changed the behavior from repeated failures to a successful fallback on a different model.

### Approach F: Avoid repeated registry fetches in the hot path

The fallback worked, but it was slow because it could still wait on a live `/models` fetch during retry.

To reduce latency, we cached the full model catalog:

- store the parsed model registry after the first successful fetch
- reuse that cache for alternate-model selection
- avoid another network round-trip before switching models

#### Result

This made the retry path much faster and removed the perception that "nothing is happening" during fallback.

## Final Behavior

The final Backboard behavior now does the following:

1. Tries the current model.
2. If the provider returns a role-alternation failure, it retries once on a fresh assistant/thread.
3. If that still fails, it switches to a different model.
4. Model selection uses the cached registry so fallback is immediate after the first fetch.

## Test Harness Work

We also extended the Backboard test harness in `crates/edit_prediction/src/edit_prediction_tests.rs`.

### Harness capabilities

The harness can now:

- fake the Backboard HTTP API
- count assistant/thread/message requests
- force the first message request to fail
- simulate both:
  - raw alternation errors
  - `ProviderAPIError`
- verify retry behavior after failure

### Regression tests added

We added tests to confirm:

- the code retries on a fresh assistant/thread after a role-alternation failure
- the code retries on a fresh assistant/thread after a `ProviderAPIError`
- the fallback logic eventually succeeds instead of failing the entire prediction

### What the tests proved

The tests ensured the code was not just:

- reusing the same failed thread
- reusing the same failed assistant
- or repeatedly sending the same model into the same backend failure

They verified the recovery path actually changes state and succeeds.

## Verification

We ran targeted test commands during the work:

- `cargo test -p edit_prediction test_backboard_retries_with_fresh_thread_after_role_alternation_failure`
- `cargo test -p edit_prediction test_backboard_retries_with_fresh_thread_after_provider_api_error`
- `cargo test -p edit_prediction backboard_retries_with_fresh_thread_after`

Those passed after the final fallback and cache changes.

## Key Files Changed

- `crates/edit_prediction/src/backboard.rs`
- `crates/edit_prediction/src/edit_prediction_tests.rs`

## Summary

The main issue was not just a stale thread. It was a combination of:

- repeated role-alternation failures from the provider
- retry logic that initially only rotated thread state
- fallback selection that was too slow and too narrow

The final fix is:

- retry once on a fresh assistant/thread
- then switch to a different model
- use cached model registry data so the fallback is fast

That is what turned the Backboard path from repeated failure into a usable recovery path.
