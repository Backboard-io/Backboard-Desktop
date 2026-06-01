---
title: Backboard Settings Cleanup Plan
description: Cleanup spec for Backboard Studio inherited Backboard Studio settings.
---

# Backboard Settings Cleanup Plan

This cleanup spec recommends how Backboard Studio should present, hide, preserve, or eventually remove inherited Backboard Studio settings. The current implementation only removes settings from the user-facing settings UI; it does not remove parser/runtime support from `SettingsContent` or `assets/settings/default.json`.

## Recommended Backboard Taxonomy

1. **Appearance**: `theme`, `icon_theme`, `ui_font_*`, `buffer_font_*`, `agent_ui_font_size`, `agent_buffer_font_size`, core contrast/visual settings.
2. **Simple Mode**: simple-mode launch defaults, chat-first font and layout controls.
3. **Editor Mode**: editor behavior, language settings, formatter/debugger settings, Vim/Helix compatibility.
4. **AI / Models**: `agent.default_model`, `agent.favorite_models`, `language_models.*`, `edit_predictions.*`.
5. **Agent Behavior**: agent panel layout, profiles, tools, tool permissions, context servers, agent servers, notifications, thinking display.
6. **Projects / Workspaces**: restore/session behavior, project panel, file finder, tabs, preview tabs, file scanning, trusted worktrees.
7. **Terminal / Preview**: terminal shell/env/display settings, tasks, Node runtime settings, future preview settings.
8. **Git**: Git enablement, gutter, blame, Git panel, hosting providers, worktree directory.
9. **Advanced Compatibility**: release/platform overrides, feature flags, proxy, telemetry, logging, instrumentation, inherited editor internals.

## Visibility Policy

| Group | Recommended action | Rationale |
|---|---|---|
| `theme`, `icon_theme`, font settings | Keep public | Required for both simple mode and editor mode. Rename visible copy from “Backboard Studio” to “Backboard Studio” where applicable. |
| `agent_ui_font_size`, `agent_buffer_font_size` | Keep public | Directly affects agent readability; settings UI already supports these paths. |
| `agent.default_model`, typed `agent.favorite_models`, model effort/speed/thinking fields | Keep public | Core model selector and chat behavior. Present under “AI / Models”. |
| `disable_ai` | Keep internal only | Global AI kill switch is still read by agent/editor/runtime code, but it is not a normal Backboard user preference. |
| `language_models.*` | Keep public, advanced section | Necessary for self-hosted or external model providers, but keep provider-specific fields collapsed by default. |
| `edit_predictions.*` | Keep public | Backboard uses `provider: backboard`; expose as “Code suggestions”. |
| `agent.profiles.*` and `agent.tool_permissions.*` | Keep public | Core safety and workflow controls for the agent. Use Backboard language: “Agent modes” and “Tool approvals”. |
| `context_servers.*`, `agent_servers.*` | Keep public, advanced | Useful for MCP/ACP integrations. Needs careful docs because invalid commands can break agent integrations. |
| `server_url`, `credentials_url` | Keep internal only | Backboard API routing and credential namespace should not be a normal user setting. Keep documented for internal/deployment use. |
| `proxy` | Keep public, advanced | Required in enterprise networks. Keep technical wording. |
| `terminal.*`, `tasks.*`, `node.*` | Keep public | Agent tools, dev servers, task execution, and preview flows depend on these. |
| `git.*`, `git_panel.*`, `git_hosting_providers` | Keep public | Git and worktree flows are important to Backboard agent/editor work. |
| Project restore/session/file scan settings | Keep public | Users need to control restore, trusted worktrees, hidden/private/read-only file behavior. |
| Project panel, file finder, tab, preview tab, status/title bar settings | Keep public, but reduce prominence | Useful editor-mode settings; not central to simple mode. |
| Core editor and language settings | Keep internal only in Backboard-first docs | Still used in editor mode, but inherited Backboard Studio reference overwhelms Backboard users. Link to advanced editor reference rather than top-level settings UI. |
| LSP/language-server settings | Hide from Backboard settings UI/docs | Backboard edit predictions send local text context directly to the Backboard API; LSP only creates a Tab-key UX conflict when its completion menu is open. |
| Vim/Helix settings | Keep internal only | Valid for editor mode users, not Backboard-first. Surface only under advanced editor compatibility. |
| Calls, audio, collaboration panel, journal, Jupyter, REPL, which-key | Hide from Backboard settings UI/docs | No meaningful Backboard product surface today; retain internally until ownership is decided. |
| Telemetry and auto-update | Hide from Backboard settings UI/docs | Defaults disable collection/update in this fork. Any public exposure needs product/legal review. |
| Release/platform overrides, feature flags, log, instrumentation | Keep internal only | Compatibility and developer diagnostics; not user-facing product settings. |

## Rename And Reword List

| Inherited name | Backboard-facing wording | Recommendation |
|---|---|---|
| “Backboard Studio” in descriptions | “Backboard Studio” | Reword public docs and settings UI copy. Do not rename JSON keys yet. |
| `agent` | Backboard Agent | Reword section label. |
| `agent.default_model` | Default chat model | Keep public. |
| `agent.favorite_models` | Pinned models | Typed-only setting; expose through model selector, not raw JSON first. |
| `agent.profiles` | Agent modes | “Profiles” is implementation language; “modes” is clearer in product UI. |
| `tool_permissions` | Tool approvals | Keep detailed JSON docs under advanced safety. |
| `edit_predictions` | Code suggestions | Use Backboard wording; keep provider internals advanced. |
| `language_models.app.backboard.io` | Backboard hosted models | Rename display copy only. The JSON key may require a compatibility migration later. |
| `server_url` | Backboard API URL | Internal/deployment docs only. |
| `project_panel` | Files sidebar | Public label should match Backboard UI, not inherited Backboard Studio term. |
| `git_panel` | Source control panel | Public label can remain “Git” when space is tight. |
| `collaboration_panel`, `calls`, `audio` | None | Hide until Backboard ships a collaboration/calls product surface. |

## Phased Cleanup

### Phase 1: Documentation And UI Filtering

- Keep `assets/settings/default.json` unchanged.
- Split Backboard docs into a short Backboard-first settings page plus an “Advanced editor compatibility” page.
- Hide **Not Used** groups from Backboard settings UI/docs: calls, audio, collaboration panel, journal, Jupyter, REPL, which-key, telemetry, auto-update.
- Keep inherited editor-mode settings searchable in advanced docs so existing users are not stranded.

Current status: the settings UI now hides collaboration/calls/audio, collaboration panel rows, which-key rows, telemetry rows, auto-update, scoped settings, internal `server_url`, LSP/language-server controls, and the public `disable_ai` toggle. The underlying settings remain available for compatibility.

Command palette/keybindings status: the command palette and keybindings editor now hide removed or internal namespaces including `collab`, `collab_panel`, `channel_modal`, `dev`, `feedback`, `journal`, `lsp_tool`, `notebook`, `remote_debug`, `repl`, and `settings_profile_selector`. User-facing action labels also render `zed::...` and `zed_*::...` namespaces as Backboard-facing names while preserving the raw action IDs for keymap JSON compatibility.

### Phase 2: Product Decisions

- Decide whether Backboard supports collaboration/calls/audio. If not, mark those settings as removal candidates after compatibility telemetry or migration review.
- Decide whether Jupyter/REPL remain packaged editor features. If retained, move them to advanced editor docs; if absent from the product, mark removal candidates.
- Decide whether `language_models.app.backboard.io` should gain a Backboard alias. If renamed, add a migration before changing docs or defaults.
- Decide whether `server_url` should stay in user settings or move to deployment/channel configuration.

### Phase 3: Compatibility Cleanup

- Add a settings UI allowlist by Backboard taxonomy rather than rendering inherited settings wholesale.
- Add aliases or UI labels for renamed concepts without changing JSON keys first.
- Remove only after migrations exist and after confirming no runtime reads remain in the fork.
- Keep release-channel/platform overrides, feature flags, log, and instrumentation internal even if docs are hidden.

## Candidate Removal Backlog

These are not immediate removals. They need a product decision and a code-read validation pass first.

| Candidate | Current recommendation | Removal prerequisite |
|---|---|---|
| `calls.*` | Hide | Confirm calls UI and status indicators are not shipped. |
| `audio.*` | Hide | Confirm no Backboard calls/voice product. |
| `collaboration_panel.*` | Hide | Confirm collaboration panel is unavailable or intentionally unsupported. |
| `journal.*` | Hide | Confirm journal feature is not exposed. |
| `jupyter.*` | Hide | Confirm notebooks/kernels are not a Backboard editor promise. |
| `repl.*` | Hide | Confirm REPL feature is not exposed. |
| `which_key.*` | Hide | Confirm key-discovery popup is not exposed. |
| `auto_update` | Hide | Confirm app update strategy lives outside inherited Backboard Studio updater. |
| `telemetry.*` | Hide | Product/legal decision required before exposing. |

## Validation Plan

- Generate key paths from `assets/settings/default.json` using a JSON-with-comments parser or equivalent lenient parser.
- Verify each default key path appears exactly once in `backboard-settings-audit.md`.
- Spot-check typed-only settings from `crates/settings_content/src/settings_content.rs`, `agent.rs`, `theme.rs`, `workspace.rs`, `project.rs`, `language.rs`, `terminal.rs`, and `language_model.rs`.
- Verify each **Directly Useful / Used** group has at least one concrete read path in the evidence index.
- Review the diff to ensure only documentation files changed.
