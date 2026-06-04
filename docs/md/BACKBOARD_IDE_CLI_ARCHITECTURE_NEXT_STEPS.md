# Backboard IDE CLI Architecture Next Steps

This follow-up tracks the pieces intentionally left out of the first native CLI-architecture port.

## Implemented In The First Port

- Native IDE sessions reuse a cached Backboard HTTP client with tuned pooling and preconnect.
- Assistant tool schemas are synced on assistant create/update instead of being sent with every message and every tool-output submit.
- Simple conversational prompts can skip workspace context packing.
- Agent/Free modes can advertise and execute read-only native `task` subagents for parallel investigation.
- Simple Mode Build continues to use the same Free-mode native backend as the code-editor chat path.

## Deferred Follow-Up

- Port the CLI index service parity into the IDE:
  - multi-language parser coverage
  - richer symbol/chunk metadata
  - optional local vector database storage
  - embedding-backed semantic search
  - incremental update and invalidation behavior
- Compare IDE `codebase_search` ranking against CLI search on medium and large repos.
- Add performance telemetry for index build time, cache hit rate, query latency, and result usefulness.
- Decide whether Simple Mode should surface index warmup state or keep it entirely invisible.

## Acceptance Criteria For The Follow-Up

- `codebase_search` in the IDE returns equivalent or better results than the CLI on the same repository.
- Search remains useful before the vector index is warm by falling back to the current lightweight index.
- Index artifacts stay under `.backboard/` and do not pollute source files.
- The chat sidebar and Simple Mode use the same search path without UI-specific forks.
