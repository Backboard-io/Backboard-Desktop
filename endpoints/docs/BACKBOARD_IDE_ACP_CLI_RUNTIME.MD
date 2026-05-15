# Backboard IDE ACP CLI Runtime

This document describes the current runtime wiring between the Backboard IDE ACP bridge and the Backboard CLI codebase in this checkout. It is implementation context for internal engineers and future agents, not end-user CLI help.

## Key Distinction

The ACP bridge does not run the `backboard` command surface as a subprocess, and it does not parse a CLI `README`. Instead, `ide/zed/script/backboard-ide-acp.py` imports Python runtime modules in-process from the CLI package under the repo-root `cli/backboard_cli`.

Important negative facts for the current state:

- There is no `backboard` subprocess between the IDE and the runtime.
- There is no CLI README parsing path in the ACP bridge.
- There is no IDE-local endpoints layer yet. The IDE still depends on CLI runtime modules.

## Runtime Discovery

`ide/zed/script/backboard-ide-acp.py` resolves the CLI runtime with `_find_cli_root()`.

Resolution order is exactly:

1. `BACKBOARD_CLI_ROOT`
2. A colocated packaged runtime at `ide/zed/script/cli`
3. A parent walk-up search for `cli` directories

The resolver treats a path as valid only if it contains `backboard_cli/`.

In this checkout, the effective source-tree runtime is the repo-root `cli/` directory:

- `cli/backboard_cli/`

After resolution, the bridge prepends that `cli` root to `sys.path`.

The bridge also checks for bundled Python dependencies here:

- `ide/zed/script/python`

If that directory exists, it is added to `sys.path` after the CLI root so packaged builds can ship Python dependencies alongside the bridge.

## What The ACP Bridge Imports

The bridge reuses the CLI runtime in two ways.

### Direct Symbol Loading

For a small set of chat helpers, the bridge loads files directly from `backboard_cli/cli/chat/` with `_load_cli_chat_symbol(...)` instead of importing the chat package normally. This avoids running `chat/__init__.py` and the interactive prompt-toolkit setup that the IDE bridge does not need.

The two direct loads are:

- `PricingService` from `pricing.py`
- `build_system_prompt(...)` from `prompt.py`

If either load fails, the bridge falls back to a minimal local implementation so ACP startup can still surface a degraded experience instead of failing immediately.

### Imported Runtime Classes

The main runtime surface is imported directly from the CLI package:

- `BackboardAPIClient`
- `AdvancedToolManager`
- `MCPManager`
- `RLMEngine`
- `SubagentManager`
- `SkillManager`
- shared CLI `config`

This is the same underlying runtime family the CLI chat stack uses. The ACP bridge does not reimplement tool orchestration, MCP wiring, skills, prompt building, or subagent execution from scratch.

## ACP Session Assembly

Inside `_ensure_runtime()`, the bridge assembles the runtime objects for the IDE session in-process:

- syncs CLI config from disk
- binds the current workspace into the shared config
- creates `BackboardAPIClient()`
- creates `AdvancedToolManager(...)`
- creates `MCPManager(...)` and attaches it to the tool manager
- starts enabled MCP servers
- creates `RLMEngine(...)`
- creates `SubagentManager(...)`
- wires the engine and subagent manager back into the tool manager

This is the key runtime handoff: the ACP session owns the IDE-facing lifecycle, but the actual agent/tool machinery still comes from CLI Python modules.

## CLI Surface Vs ACP Surface

The normal CLI entrypoint is the packaged console script:

- `backboard = "backboard_cli.main:main"` in `cli/pyproject.toml`

`backboard_cli.main` exposes the user-facing CLI command surface through `argparse`, including:

- bare `backboard` chat
- `backboard -p ...`
- `backboard config ...`
- `backboard new`
- `backboard reset`
- `backboard list`
- `backboard --update`
- `backboard --uninstall`

The ACP bridge bypasses that command interface. It does not invoke `backboard_cli.main:main`, and it does not reuse the CLI's terminal UI loop.

Instead, ACP reuses lower-level runtime layers such as:

- `cli/backboard_cli/cli/chat/context_mixin.py`
- `cli/backboard_cli/cli/chat/prompt.py`
- `cli/backboard_cli/skills/manager.py`

That reuse matters because the same runtime concepts still drive both surfaces:

- tool definitions from `AdvancedToolManager`
- prompt construction from `build_system_prompt(...)`
- skill injection from `SkillManager.build_prompt_section()`
- MCP setup from `MCPManager`
- recursive/subagent execution from `RLMEngine` and `SubagentManager`

The bridge then adds IDE-specific prompt text and ACP session behavior on top of that reused base.

## Markdown The ACP Actually Reads

The ACP bridge does read markdown-like project guidance, but not from CLI README files.

### Workspace Rule Files

`backboard-ide-acp.py` reads these workspace files in `_rules_summary()` when they exist:

- `CLAUDE.md`
- `AGENTS.md`
- `.cursorrules`
- `.backboard/rules.md`

These files are read from the active workspace and summarized into prompt context.

### Built-In Skills

`SkillManager` loads built-in skills from package data under:

- `backboard_cli/builtin_skills/{name}/SKILL.md`

Those skills are discovered with `importlib.resources`, which lets them survive wheel packaging.

### Workspace Skills

`SkillManager` also loads workspace-local skills from:

- `<workspace>/.backboard/skills/{name}/SKILL.md`

Workspace skills override built-ins of the same name.

### How Markdown Affects Prompt Construction

There are two main markdown-to-prompt paths:

- `SkillManager.build_prompt_section()` concatenates active `SKILL.md` content into the system prompt.
- `_rules_summary()` pulls in workspace rule files as additional context for the IDE session.

So the ACP bridge is influenced by markdown guidance, but that guidance comes from workspace rules and skills, not from a CLI README or a separate IDE endpoints spec.

## Short Call Flow

At a high level, the current call flow is:

1. Rust launches the Backboard agent server integration.
2. The Rust ACP layer starts `ide/zed/script/backboard-ide-acp.py`.
3. The Python bridge resolves a CLI runtime root and imports CLI Python modules in-process.
4. The bridge builds the IDE session runtime with `BackboardAPIClient`, `AdvancedToolManager`, `MCPManager`, `RLMEngine`, `SubagentManager`, and `SkillManager`.
5. The bridge creates or reuses assistant/thread state through the Backboard API.
6. Tool calls, tool outputs, terminal updates, diffs, and progress are translated into ACP events for the IDE UI.

Supporting background for the Rust/UI side lives in:

- `ide/docs/BACKBOARD_IDE_HANDOFF.md`

That handoff document is the broader IDE integration map. This file is narrower: it explains the current ACP-to-CLI runtime dependency specifically.

## Current Checkout Notes

For this repository state:

- The bridge source is `ide/zed/script/backboard-ide-acp.py`.
- The effective CLI runtime is the repo-root `cli/backboard_cli/`.
- The dependency is still current-state product behavior, not just a packaging detail.

## DMG Compilation Impact

The macOS DMG build is not neutral on this architecture choice. The current bundle path already reflects the CLI dependency.

Today, `ide/zed/script/bundle-mac` runs `bundle_backboard_runtime()`, which does all of the following before the final DMG is created:

- copies `script/backboard-ide-acp.py` into `Contents/Resources/backboard/`
- copies `../../cli/backboard_cli` into `Contents/Resources/backboard/cli/`
- copies selected CLI metadata files such as `pyproject.toml`, `requirements.txt`, and `setup.py`
- optionally installs Python dependencies from `../../cli` into `Contents/Resources/backboard/python`

That means the current DMG compilation process is coupled to the CLI runtime layout.

### If We Do Not Create Our Own IDE Endpoints

If the IDE keeps depending on the CLI runtime:

- DMG compilation must keep bundling the ACP bridge plus the CLI Python package tree.
- The bundle script must keep packaging Python dependencies needed by that runtime, or the shipped app risks import failures at launch.
- Path resolution in `backboard-ide-acp.py` must keep supporting the packaged `Contents/Resources/backboard/...` layout.
- Changes to CLI module structure can break DMG builds or runtime startup if the bundle script is not updated in lockstep.
- The final `.app` and `.dmg` stay larger because they include both the IDE and the embedded Python runtime/resources for the CLI-based agent path.

Operationally, this is the lower-risk path for feature parity because the DMG still ships the same runtime the IDE uses in development. The tradeoff is packaging complexity and artifact size.

### If We Do Create Our Own IDE Endpoints

If the IDE gets its own local endpoints and stops depending on `cli/backboard_cli` for the ACP runtime:

- DMG compilation no longer needs to copy the CLI package tree into `Contents/Resources/backboard/cli/`.
- The `bundle_backboard_runtime()` step can shrink substantially or disappear, depending on whether the ACP bridge remains Python-based.
- If the new local endpoints are native Rust or another already-bundled runtime, the Python dependency install step into `Contents/Resources/backboard/python` can likely be removed too.
- The packaged app becomes less sensitive to CLI source-tree drift because the DMG is no longer built around `../../cli`.
- The final `.app` and `.dmg` should get smaller and simpler because fewer extra runtime files have to be staged, signed, and verified.

The tradeoff is that the runtime work moves earlier in the roadmap. The DMG build gets simpler only after the IDE-owned endpoint layer exists and fully replaces the current ACP-to-CLI import path.

### Practical Decision Summary

For DMG compilation specifically:

- keeping the CLI dependency means easier runtime reuse now, but a heavier and more fragile bundle step
- creating IDE-owned endpoints means more implementation work up front, but a cleaner long-term DMG pipeline

If the IDE is moved toward IDE-owned local endpoints later, this document should be updated or replaced. The forward-looking plan for that work lives here:

- `ide/docs/BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md`
