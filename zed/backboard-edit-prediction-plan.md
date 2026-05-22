# Backboard Edit Prediction Plan

This is the follow-up plan after the Backboard retry and fallback work.

## Current State

The system now:

- retries a role-alternation failure on a fresh assistant/thread
- falls back to a different model when the same backend keeps failing
- caches the model catalog so fallback is faster
- has regression tests covering the failure modes we hit

That got the path working, but the behavior still needs cleanup and tuning before it feels close to a polished product.

## Goals For The Next Pass

1. Make the hot path faster and less noisy.
2. Reduce how much recovery logic is needed at runtime.
3. Measure quality instead of guessing.
4. Improve confidence that the fallback model/provider is actually good enough.
5. Keep the test harness covering the exact failure modes we care about.

## Priority 1: Reduce Hot-Path Latency

### Problem

Even after the caching fix, the edit-prediction path still does a lot:

- assistant initialization
- thread initialization
- warmup checks
- model selection
- retry branching

### Next steps

- Reuse safe assistant/thread state more aggressively.
- Avoid redundant warmup work during the request if the cache is already valid.
- Trim any extra model discovery or provider switching from the critical path.
- Identify which log events correspond to actual user-perceived delay.

### Success criteria

- lower time from request creation to first token
- fewer live network calls in the common case
- less time spent in retries before a suggestion appears

## Priority 2: Make Model Selection Smarter

### Problem

The current fallback logic keeps things working, but it is still reactive.

It can switch models only after the first choice fails, which means we are not yet choosing the best backend up front.

### Next steps

- rank models by observed reliability, not just registry order or cost
- prefer stable providers first
- avoid choosing a model family known to fail for this path
- keep the alternate-model fallback as a safety net, not the main plan

### Success criteria

- fewer retries on the first attempt
- fewer provider switches during a request
- more consistent completion quality across requests

## Priority 3: Add Real Metrics

### Problem

Right now we mostly have logs and test assertions.
That is good for debugging, but not enough for deciding which model/provider is actually better.

### Next steps

- record latency by stage:
  - request created
  - debounce finished
  - assistant ready
  - thread ready
  - first token
  - completion finished
- record failure counts by reason:
  - role alternation
  - provider API error
  - context overflow
  - invalid thread
  - empty completion
- record acceptance or rejection outcomes per model/provider
- compare fallback usage across models

### Success criteria

- we can tell which providers are slow or unreliable
- we can tune against data instead of logs alone
- we can identify regressions quickly

## Priority 4: Simplify Recovery Behavior

### Problem

The recovery path now has several layers:

- thread reset
- assistant reset
- model fallback
- cached registry reuse

That works, but it is harder to reason about than it needs to be.

### Next steps

- collapse retry decision making into a single recovery policy
- keep one place responsible for deciding:
  - retry same backend
  - reset state
  - switch model
  - stop and surface error
- remove duplicate role-error handling if it is still present in multiple branches

### Success criteria

- fewer nested retry branches
- easier-to-read logs
- less duplicated state management

## Priority 5: Strengthen the Test Harness

### What we already have

The current harness can:

- fake the Backboard API
- count assistants, threads, and messages
- force specific failures
- validate retry and fallback behavior

### Next steps

- add one test for startup timing or warm cache behavior
- add one test for provider-family fallback selection
- add one test that proves we do not keep retrying the same bad backend endlessly
- add one test for the “fast path” where the cache is already hot

### Success criteria

- the harness covers both failure and normal-case performance behavior
- regressions in retry logic are caught immediately
- fallback policy changes are safe to make

## Short-Term Implementation Order

1. Add metrics for request latency and failure reasons.
2. Simplify the retry policy so the decision tree is easier to follow.
3. Improve model/provider ranking using the new metrics.
4. Add the missing harness coverage for warm-cache and fallback behavior.
5. Revisit startup/warmup behavior once the data is visible.

## What To Watch For

- repeated use of the same provider family after failure
- long gaps before `first_token`
- too many assistant/thread creations
- repeated fallback to a model that also fails
- test coverage that only checks correctness, not speed or stability

## Practical Definition Of “Better”

We are closer to Cursor/Copilot quality when:

- the first suggestion appears quickly
- the model choice is usually right the first time
- fallback is rare and fast
- the system does not thrash on provider failures
- tests prove the hot path and fallback path both behave as expected

