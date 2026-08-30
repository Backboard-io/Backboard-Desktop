# Backboard Studio R-CLI integration

This directory vendors the public
[Backboard R-CLI](https://github.com/Backboard-io/Backboard-R-CLI) source so the
open-source IDE and its bundled agent backend can be built and audited from the
same repository.

## Upstream snapshot

- Repository: `https://github.com/Backboard-io/Backboard-R-CLI`
- Commit: `f909c83344bb0317dd44d42f272c09d51ea6c991`
- R-CLI version: `3.0.2`
- Snapshot date: `2026-08-12`
- License: MIT (see `LICENSE`)

## Studio integration patches

The vendored source stays functionally owned by R-CLI. Backboard Studio carries
only the small host integration needed to run that public runtime inside the
IDE:

- `--serve`, an NDJSON stdin/stdout transport used by the desktop agent host;
- per-turn model, thinking, permission, memory, feature, and tool-exclusion
  settings supplied by the IDE;
- IDE-owned session roots so logs, checkpoints, and BYOK conversation state do
  not appear as changes in the opened workspace;
- binary target selection for Studio's cross-platform release builds;
- before/after file-edit metadata so Studio can render and persist inline
  review diffs; and
- focused tests for the transport parser and integration-only configuration.

Provider routing, authentication, the agent loop, tools, permission decisions,
checkpoints, MCP, skills, session state, and terminal UI come from the public
R-CLI source.

## Updating the snapshot

1. Fetch the desired public R-CLI commit and replace this directory with that
   tree, excluding only generated dependencies and compiled binaries.
2. Reapply the documented Studio integration patches above.
3. Update the commit, version, and date in this file.
4. Run `bun install --frozen-lockfile`, `bun run validate`, and `bun run build`
   here, then run the Backboard Studio typecheck and protocol smoke test.
