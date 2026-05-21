# Backboard IDE Embedded CLI Next Steps

This document defines the implementation steps to make the IDE work without a user-installed CLI.

Target outcome:

- The IDE launches with no global CLI install.
- The CLI runtime is bundled inside the IDE tree/package.
- The user enters an API key in IDE settings/onboarding.
- Agent chat, Agent Workspace, tools, and inline completion work from that IDE-managed key.

## Current State Summary

Today the ACP bridge (`ide/zed/script/backboard-ide-acp.py`) imports runtime code from `cli/backboard_cli/` by searching for a repo-level `cli` directory (or `BACKBOARD_CLI_ROOT`).

Implication:

- Running from a moved/copied `ide/` folder without `../cli` breaks imports.
- End users can hit setup issues if CLI/runtime paths are not present.

## Desired Architecture

Move from repo-coupled imports to IDE-owned runtime loading:

1. Vendor an IDE-owned Backboard runtime under `ide/zed/vendor/backboard_cli/` (or similar path under `ide/zed/`).
2. Update ACP bridge path resolution to prefer bundled runtime first.
3. Keep `BACKBOARD_CLI_ROOT` as an override for local dev/debug only.
4. Store API key in IDE settings/secure store and inject it into bridge runtime env.
5. Remove end-user dependency on external CLI installation.

## Phase Plan

## Phase 1: Bundle Runtime In IDE Tree

1. Create a stable vendor location:
   - `ide/zed/vendor/backboard_cli/`
2. Add a sync script:
   - `ide/zed/script/sync-backboard-cli.sh`
   - Copies required modules from `cli/backboard_cli/` into vendor path.
3. Add a manifest file:
   - `ide/zed/vendor/backboard_cli/VERSION`
   - Contains CLI source commit hash and sync date.
4. Update docs with "single source of truth" policy:
   - CLI remains authored in `cli/backboard_cli/`
   - IDE vendor copy is release/runtime artifact.

Definition of done:

- IDE can import runtime from vendored path with `../cli` removed.

## Phase 2: ACP Bridge Path Strategy

File: `ide/zed/script/backboard-ide-acp.py`

1. Change `_find_cli_root()` order:
   - `BACKBOARD_CLI_ROOT` (dev override)
   - bundled vendor path (`ide/zed/vendor`)
   - legacy repo `../cli` fallback (temporary)
2. Add explicit startup diagnostics to stderr:
   - resolved runtime root
   - whether bundled vs override vs fallback path used
3. Add hard failure message if none resolve:
   - user-friendly text surfaced into IDE thread event
   - include remediation for dev builds

Definition of done:

- Bridge starts reliably from bundled runtime without external CLI.

## Phase 3: API Key Managed In IDE

1. Add/confirm Backboard API key field in IDE settings UI:
   - Keep user flow inside Backboard Studio settings/onboarding.
2. Store key in secure storage path used by IDE (do not require shell env export).
3. Ensure ACP launcher passes key to bridge process env (or bridge reads secure source).
4. Unify with inline completion key usage so chat + completion use same configured credential.
5. Add validation UX:
   - "Test key" action or first-run connectivity check with clear error message.

Definition of done:

- New user can install app, paste key in IDE UI, and run chat/tools without CLI setup.

## Phase 4: Packaging And Release

1. Include vendored runtime in build artifacts (macOS app/package pipeline).
2. Add CI check that bundle contains required runtime modules.
3. Add smoke test job:
   - run IDE ACP startup with no `BACKBOARD_CLI_ROOT`
   - verify session create + prompt send + tool call round-trip.
4. Remove legacy `../cli` fallback after one release cycle (optional but recommended).

Definition of done:

- Packaged app works on clean machine with only API key entry.

## Phase 5: Reliability And Ownership

1. Add a CI drift check:
   - fails if vendored runtime commit marker does not match expected source update.
2. Add owner docs:
   - who updates vendor runtime
   - how often
   - regression test checklist
3. Add rollback switch:
   - keep `BACKBOARD_CLI_ROOT` override for emergency runtime pinning in dev/internal builds.

Definition of done:

- Runtime update process is deterministic and low risk.

## Implementation Checklist (Concrete File Touches)

Core code:

- `ide/zed/script/backboard-ide-acp.py` (path resolver + startup messaging)
- `ide/zed/crates/agent_servers/src/backboard.rs` (ensure env/key pass-through path remains consistent)
- `ide/zed/crates/agent_ui/src/...` settings/onboarding surfaces for API key UX consistency

New files:

- `ide/zed/vendor/backboard_cli/...` (vendored runtime modules)
- `ide/zed/vendor/backboard_cli/VERSION`
- `ide/zed/script/sync-backboard-cli.sh`
- Optional: `ide/docs/BACKBOARD_IDE_EMBEDDED_CLI_RELEASE_CHECKLIST.md`

Docs updates:

- `ide/docs/BACKBOARD_IDE_HANDOFF.md` source-of-truth and runtime layout notes
- `ide/docs/BACKBOARD_IDE_PACKAGING.md` artifact inclusion and smoke test notes

## Risks And Mitigations

Risk: Runtime drift between source CLI and vendored copy.
- Mitigation: sync script + VERSION file + CI drift check.

Risk: Hidden path assumptions in runtime modules.
- Mitigation: run smoke tests from packaged artifact and from moved `ide/` tree.

Risk: API key handling divergence between chat and completion paths.
- Mitigation: single credential source in IDE settings and shared accessor.

Risk: Larger package size.
- Mitigation: vendor only required runtime modules, prune non-runtime assets.

## Acceptance Criteria

1. Clean machine, no global CLI: IDE chat starts and responds.
2. Moved/copied IDE tree with bundled runtime: ACP bridge boots.
3. API key entered only in IDE settings: chat + tools + completion work.
4. Agent Workspace task launch/review/apply still functions.
5. No required manual environment variable exports for end users.

## Recommended Execution Order

1. Phase 1 + Phase 2 in same PR (runtime vendoring + resolver).
2. Phase 3 in next PR (API key UX and storage hardening).
3. Phase 4 + Phase 5 in release hardening PR (CI + packaging + drift controls).

