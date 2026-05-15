# Backboard IDE Handoff

This document explains how the Backboard IDE integration currently works in this checkout, what was added, and where another AI model should continue. It is written as implementation context, not marketing copy.

## Scope And Rule For Future Work

The IDE work lives under:

- `ide/zed/`

The existing CLI lives under:

- `cli/backboard_cli/`

Do not edit `cli/` for IDE UI/runtime work unless the user explicitly approves it. The current integration imports the CLI as an engine from IDE-owned code, but the CLI source itself should remain untouched.

## Current Source-Of-Truth Map

Use this map before changing anything. The Backboard IDE is not one single integration point; it is a small Rust ACP launcher, a Python bridge that imports the CLI, and several native Zed UI surfaces rendering the same `AcpThread` state.

| Area | Source of truth | What it owns |
|------|-----------------|--------------|
| CLI runtime | `cli/backboard_cli/` | CLI commands, config, API client, chat loop, tool manager, MCP, skills, pricing, semantic index, RLM/subagents |
| CLI HTTP contract | `cli/backboard_cli/api/client.py` | Backboard assistant/thread/message/run/model/billing endpoints consumed by both CLI chat and the IDE bridge |
| Python ACP bridge | `ide/zed/script/backboard-ide-acp.py` | JSON-RPC stdio server, CLI import, IDE session runtime, prompt augmentation, tool execution adapters, file/terminal/diff/plan/usage ACP updates |
| Rust ACP launcher/client | `ide/zed/crates/agent_servers/src/backboard.rs`, `ide/zed/crates/agent_servers/src/acp.rs` | Launches the bridge, negotiates ACP sessions, forwards prompts/cancel/model/mode/config state, handles bridge requests like permissions and `fs/write_text_file` |
| ACP thread model | `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/acp_thread/src/connection.rs`, `ide/zed/crates/acp_thread/src/terminal.rs` | Stores conversation entries, tool calls, diffs, terminal handles/output, token/cost/speed metrics, and permission state |
| Native chat UI | `ide/zed/crates/agent_ui/src/conversation_view.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs` | Backboard chat surface, composer, model/mode/config controls, progress, grouped exploration, collapsed edits, terminal/diff/tool rendering |
| Agent Workspace | `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs` | Multi-agent dashboard, retained conversations, task launcher, git worktrees, review/apply/stop/retry/dismiss flow |
| Simple/beginner UI | `ide/zed/crates/beginner_ui/src/*.rs` | Beginner chat-first workspace, folder selection, friendly feed, file changes panel, switch-to-editor handoff; chat history home page (BeginnerChatRecord, KVP persistence), curated model filtering (CuratedModelSelector), tab bar home icon |
| Workspace shell | `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/title_bar/src/title_bar.rs` | Editor/Agents switching, Simple/Expert mode, full-page Multi-Agent rendering |
| Backboard Rust API client | `ide/zed/crates/backboard/src/backboard.rs` | Rust mirror of the Backboard HTTP client used by older UI code and as a reference for endpoint shapes |
| Inline autocomplete | `ide/zed/crates/edit_prediction/src/backboard.rs` and edit-prediction registry/settings files | BYOK ghost-text completions via Backboard API; separate from ACP chat/Agent Workspace |

Rule of thumb:

- If the issue is "Backboard could not start", inspect Rust launch and bridge import paths first.
- If the issue is "model/tool/API behavior is wrong", inspect `cli/backboard_cli/api/client.py`, the CLI tool manager, and bridge adapters.
- If the issue is "the IDE did not render the thing", inspect `acp_thread` storage first, then `conversation_view/thread_view.rs`.
- If the issue is "Agent Workspace applied/reviewed wrong", inspect `agent_panel.rs` worktree/run metadata before the page view.

## Branch History

Branch range audited:

- `83939300^..HEAD`
- Current branch: `bb-ide-zed`
- Current HEAD during this handoff update: `f701758d Route inline completions to Backboard API`

Important framing:

- `83939300 Cloned Zed` is the baseline IDE import. It added the upstream Zed tree under `ide/zed/` and is intentionally summarized instead of listing all imported files.
- The branch also merged unrelated `origin/main` API/product work on May 13, 2026. Those commits are acknowledged below, but the IDE handoff focuses on files under `ide/zed/` plus the root handoff/feature notes.

### Baseline Import

- `83939300` - 2026-05-11 - ErinTomorri - Cloned Zed.
  - Purpose: imported the upstream Zed codebase under `ide/zed/` as the base for Backboard Studio.
  - Main files changed: roughly 3,968 imported Zed files, including `ide/zed/Cargo.toml`, `ide/zed/Cargo.lock`, `ide/zed/crates/**`, `ide/zed/assets/**`, `ide/zed/docs/**`, `ide/zed/extensions/**`, and Zed build/tooling scripts.
  - Current role: baseline editor/runtime tree. Later commits rebrand and integrate Backboard-specific agent, UI, autocomplete, and workspace behavior on top of it.

### Backboard IDE Architecture And Runtime

- `68a2c090` - 2026-05-11 - ErinTomorri - Add Backboard client and embed Backboard UI.
  - Purpose: added the first Backboard Rust client/UI crates and wired Backboard into the Zed workspace.
  - Main files changed: `ide/zed/crates/backboard/src/backboard.rs`, `ide/zed/crates/backboard_ui/src/backboard_ui.rs`, `ide/zed/Cargo.toml`, `ide/zed/Cargo.lock`, `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`, `ide/zed/crates/agent_servers/src/backboard.rs`.
  - Current role: `backboard` remains the Rust API/config client crate; `backboard_ui` is now an older thin panel while native ACP chat is the main path.

- `e11de945` - 2026-05-11 - ErinTomorri - Add tokio `time` feature to `backboard_ui` workspace.
  - Purpose: enabled time-based async behavior needed by the early Backboard UI crate.
  - Main files changed: `ide/zed/crates/backboard_ui/Cargo.toml`.
  - Current role: small dependency adjustment for the legacy Backboard UI crate.

- `523014c5` - 2026-05-11 - ErinTomorri - Add Backboard native agent and ACP bridge.
  - Purpose: created the native Backboard agent server and the Python ACP stdio bridge that imports the CLI runtime.
  - Main files changed: `ide/zed/crates/agent_servers/src/backboard.rs`, `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/agent_ui/src/conversation_view.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`.
  - Current role: this is the core IDE-to-Backboard path: Rust launches the Python bridge; Python talks to the existing CLI engine; native Zed ACP UI renders the conversation.

- `b46533d4` - 2026-05-11 - ErinTomorri - Add Backboard IDE handoff & workspace UI.
  - Purpose: created this handoff document and introduced the first Agent Workspace UI/runtime hooks.
  - Main files changed: `BACKBOARD_IDE_HANDOFF.md`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`.
  - Current role: the handoff is the source of implementation context for future agents; Agent Workspace evolved from this starting point.

- `dbc50663` - 2026-05-12 - ErinTomorri - Auto-approve safe shell commands; show token usage.
  - Purpose: added conservative read-only command auto-approval, token/context usage display, and richer workspace card behavior.
  - Main files changed: `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/acp_thread/src/acp_thread.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: read-only commands can run without interrupting the user; token usage is carried through ACP and rendered in the chat footer.

- `9656d715` - 2026-05-12 - ErinTomorri - Add ACP configOptions, model-branding, and cost.
  - Purpose: added native ACP config option support, Backboard-branded model selector trigger, and session cost display.
  - Main files changed: `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/agent_servers/src/acp.rs`, `ide/zed/crates/agent_ui/src/config_options.rs`, `ide/zed/crates/agent_ui/src/conversation_view.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/crates/agent_ui/src/model_selector_popover.rs`.
  - Current role: supports `Intensity`, preserves model selection with config options, and renders Backboard/model/cost state in the composer/footer.

- `1eff600d` - 2026-05-12 - ErinTomorri - Backboard IDE: add speed metrics, prewarm, and perf fixes.
  - Purpose: added turn timing metrics, prompt/context prewarming, and fixes for slow file writes/theme loading/log noise.
  - Main files changed: `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/crates/project/src/prettier_store.rs`, `ide/zed/crates/zed/src/main.rs`, `ide/zed/crates/title_bar/src/title_bar.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: provides `_meta.backboard_speed` metrics, context-pack prewarm, no per-file forced formatting on ACP writes, and quieter known log cases.

- `dc4a4a7d` - 2026-05-12 - ErinTomorri - Add tool timing buckets and command timeouts.
  - Purpose: broke speed metrics down by tool class and bounded shell/dev-server command runtime.
  - Main files changed: `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: tracks `read_tools_ms`, `search_tools_ms`, `edit_tools_ms`, `shell_tools_ms`, `slowest_tool`, command wait time, and dev-server startup windows.

- `456d63d6` - 2026-05-13 - ErinTomorri - Web quality defaults and non-git workspace support.
  - Purpose: made website/app prompts higher quality in the IDE and allowed Agent Workspace to run in non-git projects.
  - Main files changed: `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_portal_window.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: website/app turns get extra frontend quality context and capped thinking even on Fast intensity; non-git workspaces run one current-workspace agent with Apply disabled.

- `755ab08f` - 2026-05-13 - ErinTomorri - Backboard: progress updates, metrics, cwd fallback.
  - Purpose: improved ACP progress/metrics transport and made file/tool operations more robust when the working directory is missing or ambiguous.
  - Main files changed: `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/agent_servers/src/acp.rs`, `ide/zed/crates/agent_ui/src/conversation_view.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/script/backboard-ide-acp.py`, `ide/zed/testcase.md`.
  - Current role: status/progress and speed metrics have a fuller path through ACP; cwd fallback helps Backboard operations resolve in IDE sessions.

### UI, Rebrand, Onboarding, And Mode Work

- `6e5e0172` - 2026-05-11 - Youseph El-Khouly - V1: Rebranded the logo's for main page.
  - Purpose: changed the early visible Zed welcome logo/copy toward Backboard.
  - Main files changed: `ide/zed/assets/images/zed_logo.svg`, `ide/zed/crates/workspace/src/welcome.rs`.
  - Current role: initial visual rebrand layer on the imported Zed shell.

- `3b608865` - 2026-05-12 - Youseph El-Khouly - v1: Changed onboarding first page.
  - Purpose: simplified/changed the first onboarding screen.
  - Main files changed: `ide/zed/crates/onboarding/src/basics_page.rs`, `ide/zed/crates/onboarding/src/onboarding.rs`.
  - Current role: part of the Backboard-specific onboarding flow that later gained Simple/Expert choices.

- `bbc45638` - 2026-05-12 - Youseph El-Khouly - Rebrand onboarding, binary, and macOS menu text.
  - Purpose: renamed visible app/menu surfaces to Backboard Studio and added a Backboard dashboard button in onboarding.
  - Main files changed: `ide/zed/crates/paths/src/paths.rs`, `ide/zed/crates/zed/Cargo.toml`, `ide/zed/crates/zed/src/main.rs`, `ide/zed/crates/zed/src/zed/app_menus.rs`, `ide/zed/Cargo.lock`.
  - Current role: keeps the app identity pointed at Backboard Studio rather than Zed on key visible surfaces.

- `28767434` - 2026-05-12 - ErinTomorri - Group exploration entries and add IDE docs.
  - Purpose: collapsed noisy read/search/thought-only entries into grouped exploration rows.
  - Main files changed: `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: keeps chat readable while preserving expandable details for exploration-heavy turns.

- `35f79f86` - 2026-05-12 - Seif Otefa - Rebrand: rename all user-facing "Zed" strings to "Backboard Studio".
  - Purpose: broad user-facing copy pass across settings, providers, onboarding, update UI, language models, and editor surfaces.
  - Main files changed: many `ide/zed/crates/**` files including `agent_ui`, `ai_onboarding`, `language_models`, `onboarding`, `settings_ui`, `title_bar`, `workspace`, and `zed`.
  - Current role: broad Backboard Studio copy layer; future changes should avoid reintroducing user-visible Zed branding except where serialized settings or upstream internals still require it.

- `5d0fd0be` - 2026-05-12 - Youseph El-Khouly - Remove Zed-specific menu items and URLs.
  - Purpose: replaced feedback, support, bug-report, feature-request, and social URLs with Backboard equivalents.
  - Main files changed: `ide/zed/crates/feedback/src/feedback.rs`, `ide/zed/crates/workspace/src/workspace.rs`, `ide/zed/crates/zed/src/zed/app_menus.rs`, `ide/zed/crates/auto_update_ui/src/auto_update_ui.rs`.
  - Current role: prevents Zed support/community flows from surfacing in the Backboard build.

- `81183082` - 2026-05-12 - ErinTomorri - Add Backboard Agent Portal and multi-task launcher.
  - Purpose: added an older separate-window portal for multi-agent task launching and expanded Agent Workspace controls.
  - Main files changed: `ide/zed/crates/agent_ui/src/agent_portal_window.rs`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`, `ide/zed/script/backboard-ide-acp.py`.
  - Current role: `agent_portal_window.rs` remains as the older portal implementation; the current preferred UI is the full-page Multi-Agent workspace.

- `09083594` - 2026-05-12 - Seif Otefa - Create components for beginner chat interface.
  - Purpose: introduced a beginner-focused chat/workspace UI crate.
  - Main files changed: `ide/zed/crates/beginner_ui/Cargo.toml`, `ide/zed/crates/beginner_ui/src/beginner_ui.rs`, `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`, `ide/zed/crates/beginner_ui/src/beginner_chat_feed.rs`, `ide/zed/crates/beginner_ui/src/file_changes_panel.rs`.
  - Current role: provides Simple mode's beginner/chat-first workspace components.

- `a178eb3a` - 2026-05-13 - Youseph El-Khouly - Remove Zed collaboration infrastructure and disconnect from Zed servers.
  - Purpose: stripped Zed collaboration server/keybinding/menu behavior from the Backboard build.
  - Main files changed: `ide/zed/crates/title_bar/src/collab.rs`, `ide/zed/crates/title_bar/src/title_bar.rs`, `ide/zed/crates/zed/src/main.rs`, `ide/zed/crates/zed/src/zed.rs`, `ide/zed/assets/keymaps/default-*.json`, `ide/zed/assets/settings/default.json`, `ide/zed/crates/extension_host/src/extension_host.rs`, `ide/zed/crates/language_models/src/language_models.rs`.
  - Current role: Backboard Studio no longer connects to Zed collaboration infrastructure; old collab UI is inert/minimized.

- `b1157b0b` - 2026-05-13 - Youseph El-Khouly - Remove OpenSettings action from agent panel.
  - Purpose: removed a settings action from the Backboard agent panel menu.
  - Main files changed: `ide/zed/crates/agent_ui/src/agent_panel.rs`.
  - Current role: keeps the agent menu tighter and avoids an unwanted settings route.

- `81929251` - 2026-05-13 - Seif Otefa - Update workflow setup to Simple and Expert mode.
  - Purpose: added Simple/Expert mode selection, settings toggle, title-bar mode switching, and beginner workspace integration.
  - Main files changed: `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`, `ide/zed/crates/beginner_ui/src/beginner_chat_feed.rs`, `ide/zed/crates/title_bar/src/title_bar.rs`, `ide/zed/crates/settings_ui/src/page_data.rs`, `ide/zed/crates/onboarding/src/onboarding.rs`, `ide/zed/crates/zed/src/main.rs`, `ide/zed/crates/zed/src/zed.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs`.
  - Current role: `InterfaceMode::Simple` shows the beginner/chat-first workspace; `InterfaceMode::Expert` shows the normal editor and agent surfaces.

- `a0a0c69a` - 2026-05-13 - Seif Otefa - Fix traffic light overlay, add agent tab, and fix mode switching.
  - Purpose: refined the top mode UI, fixed macOS traffic-light overlap, added notes for Backboard modes/features, and prevented mode switching from routing back to onboarding.
  - Main files changed: `backboard_studio_features.txt`, `backboard_studio_mode_features.txt`, `ide/zed/crates/title_bar/src/title_bar.rs`, `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/beginner_ui/src/**`, `ide/zed/crates/onboarding/src/**`, `ide/zed/crates/zed/src/**`, `ide/zed/crates/gpui_macos/src/window.rs`.
  - Current role: the feature text files are planning/reference notes; the UI changes keep Simple/Expert/Multi-Agent switching usable on macOS.

### Multi-Agent Workspace And Apply Flow

- `f23dde2f` - 2026-05-12 - ErinTomorri - Add agent worktree, apply/review & free mode.
  - Purpose: moved Agent Workspace toward git-linked worktrees, review/apply controls, and the `free` approval mode.
  - Main files changed: `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/script/backboard-ide-acp.py`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: git-backed runs use isolated worktrees and apply patches back to the base workspace; `free` mode bypasses shell approval prompts.

- `59efd845` - 2026-05-13 - ErinTomorri - Add agent workspace modes, batching & apply flow.
  - Purpose: added Agent/Ask/Manual/Free modes to workspace launches, multi-task batching, batch conflict checks, and richer apply/review metadata.
  - Main files changed: `ide/zed/crates/agent_ui/src/agent_panel.rs`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_portal_window.rs`, `ide/zed/crates/agent_servers/src/backboard.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: one task line becomes one retained Backboard ACP thread; git runs are batched, tracked, reviewable, and applied with conflict guards.

- `bbada1db` - 2026-05-13 - ErinTomorri - Integrate full-page multi-agent workspace.
  - Purpose: moved Agent Workspace into the full-page `MultiWorkspace` experience instead of opening it as an editor tab or separate window.
  - Main files changed: `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_ui.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: `agent::OpenBackboardAgentWorkspace` sets `multi_agent_expanded = true`; the normal editor panes/panels are hidden while Multi-Agent is active.

### Inline Autocomplete

- `f701758d` - 2026-05-13 - Youseph El-Khouly - Route inline completions to Backboard API.
  - Purpose: rerouted Zed edit predictions to Backboard API-backed inline completions using BYOK credentials and pure cursor insertion.
  - Main files changed: `ide/zed/crates/edit_prediction/src/backboard.rs`, `ide/zed/crates/edit_prediction/src/edit_prediction.rs`, `ide/zed/crates/zed/src/zed/edit_prediction_registry.rs`, `ide/zed/crates/language/src/language_settings.rs`, `ide/zed/crates/settings_content/src/language.rs`, `ide/zed/crates/settings_ui/src/pages/edit_prediction_provider_setup.rs`, `BACKBOARD_IDE_HANDOFF.md`.
  - Current role: `EditPredictionProvider::Zed` maps to `EditPredictionModel::Backboard`; settings expose `edit_predictions.backboard.provider/model`; the settings UI shows only the Backboard AI API key card.

### Documentation-Only And Merge Commits

- `aa87cbf1` - 2026-05-12 - ErinTomorri - Update `BACKBOARD_IDE_HANDOFF.md`.
  - Purpose: documentation-only handoff update.
  - Main files changed: `BACKBOARD_IDE_HANDOFF.md`.

- `f7953db0` - 2026-05-13 - Seif Otefa - Merge remote-tracking branch `origin/main` into `bb-ide-zed`.
  - Purpose: pulled unrelated mainline API/product work into the IDE branch.
  - Main files changed: `app/routers/billing.py`, `app/routers/threads.py`, `app/services/assistant_service.py`, `app/services/customerio_service.py`, `frontend/src/components/OnboardingQuestionnaire.js`, `frontend/src/pages/MemoriesPage.js`.
  - Current role: not IDE-specific; avoid using it as guidance for `ide/zed/` work.


- `794625f4` - 2026-05-13 - Seif Otefa - Merge remote-tracking branch `origin/bb-ide-zed` into `bb-ide-zed`.
  - Purpose: integrated earlier IDE/runtime/rebrand work including collaboration removal, web quality defaults, progress metrics, and cwd fallback.
  - Main files changed: `BACKBOARD_IDE_HANDOFF.md`, `ide/zed/script/backboard-ide-acp.py`, `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/agent_servers/src/acp.rs`, `ide/zed/crates/agent_ui/src/**`, `ide/zed/crates/title_bar/src/**`, `ide/zed/crates/zed/src/**`.
  - Current role: merge node; inspect the individual commits above (`a178eb3a`, `456d63d6`, `b1157b0b`, `755ab08f`) for intent.

- `4efc5c64` - 2026-05-13 - ErinTomorri - Merge remote-tracking branch `origin/bb-ide-zed` into `bb-ide-zed`.
  - Purpose: integrated Simple/Expert mode and mode-switching refinements with Agent Workspace batching work.
  - Main files changed: `backboard_studio_features.txt`, `backboard_studio_mode_features.txt`, `ide/zed/crates/beginner_ui/src/**`, `ide/zed/crates/title_bar/src/title_bar.rs`, `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/agent_ui/src/**`, `ide/zed/crates/zed/src/**`.
  - Current role: merge node; inspect `81929251`, `a0a0c69a`, and `59efd845` for implementation intent.

### Simple Mode: Curated Models And Chat History Home Page (Uncommitted As Of 2026-05-15)

The changes below are local on `bb-ide-zed` and have not yet been committed. They represent the current working state.

**CuratedModelSelector and model filtering**

- Files changed: `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`, `ide/zed/crates/agent_ui/src/conversation_view.rs`.
- Purpose: Simple mode shows only ~11 curated models (selected Anthropic, OpenAI, Google, and DeepSeek entries) instead of exposing the full 100+ model list.
- Implementation: `CuratedModelSelector` is a newtype struct wrapping `Rc<dyn AgentModelSelector>`. It filters `list_models` results against a `CURATED_MODELS` table keyed by provider/model id, rewrites display names, and delegates `select_model`/`watch`/`should_render_footer` to the inner selector. `ConversationView` gained a `make_root_model_selector_wrapped` method that accepts a `FnOnce(Rc<dyn AgentModelSelector>) -> Rc<dyn AgentModelSelector>` closure, builds a fresh `Entity<ModelSelectorPopover>` using the wrapped selector, and returns it. `BeginnerWorkspace::start_agent_thread` calls this via `cx.observe_in` to rebuild the model selector whenever the active conversation view changes.
- Key pattern: `cx.observe_in` (not `cx.observe`) is required here because `make_root_model_selector_wrapped` needs `&mut Window` to construct a new `ModelSelectorPopover`.

**Chat history home page**

- Files changed: `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`, `ide/zed/crates/beginner_ui/Cargo.toml`.
- Added Cargo dependencies: `serde.workspace`, `serde_json.workspace`, `uuid.workspace`.
- Purpose: The "New Project" landing page is now a proper home page showing all past chats (name, folder, timestamp), allowing users to continue or delete them — similar to the ChatGPT or Claude home page.
- Implementation:
  - `BeginnerChatRecord` is a new serializable struct with fields `id` (UUID v4), `name` (prompt-derived), `folder_path`, and `timestamp_ms`.
  - Records are stored as a JSON array under the KVP key `beginner_chats_v1` via `KeyValueStore::global`.
  - `load_chat_history` replaces `load_recent_projects`; `save_chat_history`, `add_chat_record`, and `delete_chat_record` manage the list (capped at 50 entries, newest first).
  - `add_chat_record` is called from `submit()` on every new conversation start.
  - `open_chat_record` replaces `open_recent_project`; it restores `selected_folder`, `tab_name`, and `BeginnerState::ActiveProject` then re-creates the workspace worktree.
  - The sidebar in `render_landing` shows a chat list: folder icon + v_flex(chat name, folder label) + delete × button. Delete calls `cx.stop_propagation()` (not `event.stop_propagation()` — `ClickEvent` does not have that method).
  - `generate_chat_name` (renamed from `generate_tab_name`) uses sentence case, keeps up to 6 meaningful words, and strips fewer stop words than before. Example: "make a raptors fan website" → "Raptors fan website".

**Tab bar home icon and go_home**

- Files changed: `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`.
- Purpose: users can return to the home page from any active chat without losing the tab.
- Implementation: `render_tab_bar` prepends a home-icon button (using `IconName::Thread`) before the active chat tab. The button is highlighted with `element_selected` background when the workspace is already on the landing page; otherwise it shows a hover highlight. Clicking it calls `go_home`, which calls `stash_current_session_and_reset` if the state is not already `BeginnerState::Landing`.

## High-Level Architecture

Backboard IDE is a Zed fork using Zed's native agent infrastructure. The important pieces are:

- Rust agent server: `ide/zed/crates/agent_servers/src/backboard.rs`
- Python ACP bridge: `ide/zed/script/backboard-ide-acp.py`
- Native chat UI: `ide/zed/crates/agent_ui/src/conversation_view.rs`
- Thread/tool rendering: `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- Agent panel ownership/runtime: `ide/zed/crates/agent_ui/src/agent_panel.rs`
- Agent Workspace full-page view: `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- Multi-agent workspace page: `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- Agent action registration: `ide/zed/crates/agent_ui/src/agent_ui.rs`
- Backboard Rust API/config client: `ide/zed/crates/backboard/src/backboard.rs`
- Older thin Backboard panel: `ide/zed/crates/backboard_ui/src/backboard_ui.rs`

Runtime flow:

1. Zed opens the native Backboard agent.
2. `BackboardAgentServer` launches `ide/zed/script/backboard-ide-acp.py` over stdio.
3. The Python bridge imports the existing CLI package from `cli/backboard_cli`.
4. The bridge speaks ACP JSON-RPC to Zed and streams model text, progress notes, tool calls, terminal output, diffs, plans, model state, and permission requests.
5. Zed's native agent UI renders the conversation, tool cards, terminal cards, diffs, model selector, and command approval UI.

## CLI API Surface

The CLI and IDE bridge use the assistant/thread/run API shape exposed by `BackboardAPIClient`. Treat `cli/backboard_cli/api/client.py` as the strongest source of truth for what the current IDE bridge consumes. `ide/zed/crates/backboard/src/backboard.rs` mirrors the same endpoint family in Rust for older Backboard UI/reference code.

The API base URL comes from `~/.backboard/config.json`:

- `env = "prod"` defaults to `https://app.backboard.io/api`
- `env = "dev"` defaults to `https://dev.app.backboard.io/api`
- `env = "local"` defaults to `http://localhost:8000`
- Explicit `api_url` wins over the env default.
- The API key is sent as `X-API-Key`.
- API key preflight uses `GET /assistants?limit=1` through `cli/backboard_cli/api/validation.py`; `set-api-key` can probe prod/dev and switch the saved env to the one that accepts the key.

The backend and SDK also expose newer stateful convenience endpoints such as `/threads/messages`, but the CLI/IDE path documented here is the assistant/thread/run path below.

### Endpoint Matrix Used By CLI And IDE

| Feature | Method/path | Payload shape | Current callers |
|---------|-------------|---------------|-----------------|
| Create assistant | `POST /assistants` | JSON `name`, `description`, optional `tools`, optional custom memory prompts | CLI first-run chat, IDE bridge `_ensure_thread_binding`, RLM engine |
| Update assistant | `PUT /assistants/{assistant_id}` | JSON with any of `name`, `description`, `tools` | CLI MCP refresh path when tool schemas change |
| Get assistant | `GET /assistants/{assistant_id}` | None | CLI/diagnostic paths |
| List assistants | `GET /assistants` | Optional query in validation path | CLI listing and API key validation |
| Create thread | `POST /assistants/{assistant_id}/threads` | JSON `{}` | CLI chat, IDE bridge sessions, RLM engine |
| Get thread | `GET /threads/{thread_id}` | None | Resume/history paths |
| List threads | `GET /threads` | None | CLI listing |
| List assistant threads | `GET /assistants/{assistant_id}/threads` | None | CLI listing filtered by assistant |
| Send message | `POST /threads/{thread_id}/messages` | Form data, stream false | Non-streaming helpers/tests/older Rust path |
| Stream message | `POST /threads/{thread_id}/messages` | Form data, stream true | Main CLI chat and IDE bridge prompt path |
| Submit tool outputs | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs` | JSON `tool_outputs`, optional `tools` | Tool-call continuation when not streaming |
| Stream after tools | `POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true` | JSON `tool_outputs`, optional `tools` | Main CLI/IDE multi-round tool path |
| Cancel run | `POST /threads/{thread_id}/runs/{run_id}/cancel` | None | CLI Ctrl+C and IDE cancel |
| Upload document | `POST /assistants/{assistant_id}/documents` | Multipart file | CLI document helpers and Rust client |
| List memories | `GET /assistants/{assistant_id}/memories` | None | CLI memory helpers |
| Add memory | `POST /assistants/{assistant_id}/memories` | JSON `content`, `tags` | CLI memory helpers |
| List models | `GET /models` | Query `model_type`, `limit`, optional `provider` | CLI model picker, IDE model state, pricing catalog |
| List providers | `GET /models/providers` | None | CLI model picker |
| Recent billing usage | `GET /billing/usage/recent` | Query `page`, `page_size`, optional `model_name`, `input_tokens`, `output_tokens` | CLI post-run cost reconciliation |

### Message Form Fields

The streaming and non-streaming message paths send form data instead of JSON:

| Field | Meaning |
|-------|---------|
| `content` | User message or bridge-augmented IDE prompt |
| `stream` | `"true"` for SSE, `"false"` for one-shot JSON |
| `llm_provider` | Provider id such as `openai`, `anthropic`, `google`, `openrouter` |
| `model_name` | Model id within the provider |
| `memory` | CLI default is `Auto`; IDE bridge currently sends memory through the same client default unless overridden |
| `web_search` | Usually `off`; CLI can opt in, IDE bridge sends explicit context/tools instead |
| `max_tokens` | Optional, from CLI config |
| `thinking` | Optional JSON string with provider-specific reasoning controls |
| `tools` | Optional JSON string with current tool definitions so MCP/mode changes apply immediately |

The `thinking` value is normalized by `state/config.py`:

- OpenAI/xAI style models use `effort`.
- Anthropic/Gemini budget models use `budget_tokens`.
- OpenRouter/Cerebras style models may use `max_tokens`.
- The IDE bridge applies its `Intensity` option before sending the value.

### Streaming Chunks Consumed By Runtime

`send_message_stream` and `submit_tool_outputs` yield decoded SSE `data:` payloads. The CLI chat loop and IDE bridge both consume the same event family:

| Chunk type | Meaning in CLI/IDE |
|------------|--------------------|
| `retry` | Client is backing off before any committed streamed chunk reached the caller |
| `run_started` | Server created/started the run; bridge stores `run_id` for cancellation and tool submit |
| `reasoning_started` | Model entered a reasoning block; bridge shows progress without exposing private chain-of-thought |
| `reasoning_streaming` / `reasoning_delta` | Reasoning is still active; used as phase/progress only |
| `reasoning_ended` | Model left reasoning phase |
| `content_streaming` | Assistant-visible text chunk |
| `tool_submit_required` | Model requested tool calls; client must execute tools and submit outputs |
| `run_ended` | Run finished or ended in `requires_action`; carries token/cost/context fields when available |
| `run_failed` | Server-side run failure |
| `error` | API/stream error payload |

### Retry And Keepalive Rules

The streaming client has one extremely important invariant: retry is only safe before any SSE chunk has been yielded to the caller.

- Before first yielded chunk, transient `502`, `503`, `504`, `429`, and httpx transport errors can back off and retry.
- After any chunk is yielded, a retry would duplicate the user message or re-submit tool outputs against a run whose state may already have advanced.
- `submit_tool_outputs` follows the same rule because the server may flip the assistant message from `REQUIRES_ACTION` to `COMPLETED` before the continuation finishes streaming.
- SSE keepalive uses an adaptive timer. Time-to-first-chunk and active reasoning get a larger budget; a separate "meaningful silence" detector catches streams that only emit comment keepalives while the upstream LLM is stuck.

If a future issue shows duplicated user messages, mismatched run IDs, or "no assistant message found requiring action", inspect these retry guards before changing tool execution.

## How The CLI Works

The CLI is a full agent runtime, not just a thin HTTP wrapper. The IDE bridge imports this runtime directly and adapts its events into ACP.

### Entrypoint And Commands

`cli/backboard_cli/main.py` owns command-line parsing:

- `backboard` starts the default interactive chat.
- `backboard -p "..."` sends a one-shot initial prompt.
- `backboard -w <path>` sets the workspace used by tools.
- `--debug` enables debug behavior/logging.
- `--thinking` / `--think LEVEL` changes saved reasoning intensity.
- `--update`, `--upgrade`, `--uninstall`, `--version`, and `--check-code` run maintenance flows.
- `config` subcommands manage API keys, URL/env, model defaults, OpenAI key, and MCP add/enable/disable/remove/list/show.
- `chat`, `new`, `reset`, `list`, `update`, and `uninstall` are explicit subcommands; no subcommand falls back to chat.

When stdout is not a TTY, `main.py` forces quiet/non-color behavior and disables autoplay. That keeps scripting/IDE embedding from inheriting interactive terminal assumptions.

### Config Lifecycle

`cli/backboard_cli/state/config.py` owns persisted state in `~/.backboard/config.json`.

Important persisted values:

- `api_key` and env-specific `env_keys`
- `env`, `api_url`, and derived `web_url`
- `assistant_id` and `thread_id` for CLI chat reuse
- `default_provider` and `default_model`
- `thinking_config`
- MCP server definitions and enabled/disabled state
- theme/autoplay/bell/expert-mode and indexing flags

The config layer writes with restrictive permissions and keeps backup/recovery paths for corrupt JSON. Config commands in `cli/backboard_cli/cli/commands/config.py` validate keys before saving when possible.

### Chat Lifecycle

Interactive chat starts through `cli/backboard_cli/cli/commands/session.py`:

1. `cmd_chat()` resolves the workspace path.
2. `ensure_api_key()` validates or prompts for an API key.
3. `BackboardAPIClient` is created from live config.
4. `ChatInterface(api_client, workspace)` is created.
5. `chat.start(initial_prompt=..., one_shot=...)` enters the chat loop.
6. On the first turn, the CLI creates or reuses an assistant and thread.
7. `send_mixin.py` calls `api_client.send_message_stream(...)`.
8. Stream chunks update CLI display, cost/token estimates, and run state.
9. `tool_submit_required` triggers `_handle_tool_calls`.
10. Tool outputs are sent through `api_client.submit_tool_outputs(...)`.
11. The stream can repeat model -> tools -> submit outputs until the run ends.

`ChatInterface` is composed from mixins for context, activity display, sending, tools, commands, model selection, MCP thread management, VCS, skills, harness/browser support, and export.

### Runtime Services

The CLI runtime includes services the IDE bridge deliberately reuses:

- `AdvancedToolManager` for file/search/shell/web/todo/task/MCP/tool execution.
- `MCPManager` for external tool schemas and tool dispatch.
- `SkillManager` for skill discovery and prompt sections.
- `build_system_prompt(...)` for the base agent system prompt.
- `PricingService` for model catalog and cost estimates.
- Semantic index support through config or `BB_INDEXING`.
- `RLMEngine` and `SubagentManager` for recursive/subagent task execution.
- Persistent Python REPL and code execution helpers.
- Browser/computer harness hooks where enabled by the CLI tool layer.

The IDE bridge does not run `backboard chat` as a subprocess. It imports the Python modules above, creates the same objects in-process, and then replaces terminal-oriented display with ACP session updates.

## Python ACP Bridge Contract

`ide/zed/script/backboard-ide-acp.py` is the IDE-owned adapter between Zed ACP and the CLI runtime.

### Launch Contract

The path is:

1. Zed requests the native `backboard` agent.
2. `BackboardAgentServer.connect()` builds an `AgentServerCommand`.
3. The command launches `backboard-ide-acp.py` with Python.
4. Rust `agent_servers/src/acp.rs` speaks ACP JSON-RPC over the child process stdio.
5. The bridge redirects accidental Python stdout to stderr so only protocol JSON goes to stdout.

Important env vars:

| Env var | Purpose |
|---------|---------|
| `BACKBOARD_IDE_ACP_PATH` | Override the bridge script path |
| `BACKBOARD_CLI_ROOT` | Override the CLI root inserted into `sys.path` |
| `BACKBOARD_CLI_PATH` | Helps resolve a sibling Python executable for packaged installs |
| `BACKBOARD_IDE_PYTHON` | Override Python executable |
| `BACKBOARD_IDE=zed` | Marks the runtime as IDE-owned |
| `NO_BROWSER=1` | Prevents browser launch when the IDE delegate requests no browser |

### ACP Methods Handled

The bridge handles these JSON-RPC requests/notifications:

| Method | Bridge behavior |
|--------|-----------------|
| `initialize` | Returns agent info, prompt capabilities, session capabilities, and load-session support |
| `authenticate` | No-op success; API key lives in Backboard config |
| `session/new` | Creates `BackboardIdeSession` for the workspace cwd and returns modes/models/config options |
| `session/load` | Restores session mapping when possible, then loads/replays history |
| `session/list` | Reads saved IDE session mappings |
| `session/set_mode` | Updates mode (`agent`, `ask`, `manual`, `free`) and clears tool cache |
| `session/set_model` | Parses provider/model and persists it for the bound session |
| `session/set_config_option` | Currently supports `backboard_intensity` (`fast`, `balanced`, `deep`) |
| `session/prompt` | Extracts prompt blocks, augments context, sends Backboard message stream |
| `session/close` | Closes the IDE session |
| `session/cancel` | Cancels the local turn, backend run, and active subprocesses |

The bridge also sends requests back into the IDE:

- `session/request_permission` for command/tool approval.
- `fs/write_text_file` so editor buffers, diffs, action log, and saves are owned by Zed.

### Session Runtime

Each `BackboardIdeSession` owns:

- workspace path and selected mode/model/intensity
- `BackboardAPIClient`
- `AdvancedToolManager`
- `MCPManager`
- `RLMEngine` and `SubagentManager`
- assistant/thread ids
- current run id for cancellation
- model catalog and pricing cache
- context prewarm cache
- speed/timing buckets
- terminal/tool/file-write bookkeeping

Session mapping is persisted in `~/.backboard/ide_sessions.json` so a loaded IDE ACP session can bind back to the Backboard assistant/thread when possible.

### Prompt Augmentation

Before calling `POST /threads/{thread_id}/messages`, the bridge creates an IDE context pack. Depending on intensity and request shape, it can include:

- workspace path
- lightweight file tree
- package/stack hints
- git branch/status/diff stats
- project rules
- active editor/embedded ACP context
- semantic code-search hits
- website/app quality guidance for frontend requests

Fast intensity keeps the pack smaller and normally skips semantic search. Balanced/Deep can add semantic hits. Website/app turns get extra frontend guidance and capped thinking even when the selected intensity is Fast.

### Stream Mapping

The bridge consumes Backboard SSE chunks and emits ACP updates:

- Assistant text -> `session/update` agent message chunks.
- Reasoning state -> progress/thought chunks without exposing private reasoning.
- Tool calls -> ACP `ToolCall` / `ToolCallUpdate` entries.
- File writes/edits/deletes -> diff tool cards plus IDE write requests.
- Shell commands -> terminal tool cards plus terminal output/exit metadata.
- `todo_write` -> ACP plan entries.
- Usage/cost/context -> ACP `usage_update`.
- Timing -> `usage_update._meta.backboard_speed`.

### Cancellation

The cancel path is intentionally multi-layered:

1. User cancels in the IDE.
2. Rust sends ACP `session/cancel`.
3. Bridge sets the local cancel event.
4. Bridge calls `api_client.cancel_run(thread_id, run_id)` when a run id is known.
5. Bridge asks `AdvancedToolManager.cancel_active_subprocesses()` to stop active foreground commands.
6. Pending terminal output is finalized with exit/cancel metadata.

## Backboard Editor To ACP Bridge Flow

This is the exact flow for a normal Backboard chat turn and for Agent Workspace auto-submitted tasks.

1. User submits a prompt in the native Backboard composer, Beginner UI follow-up box, or Agent Workspace task launcher.
2. `ThreadView.send()` resolves editor content and clears/queues the composer.
3. `AcpThread.send()` optimistically appends the local user message and asks the `AgentConnection` to prompt.
4. Rust `agent_servers/src/acp.rs` sends JSON-RPC `session/prompt` with the ACP session id and prompt blocks.
5. `BackboardIdeSession.prompt()` serializes the turn through `_prompt_lock`.
6. `_run_prompt()` extracts text/resources, starts heartbeat progress, ensures runtime, augments the prompt, and ensures assistant/thread binding.
7. The bridge calls `api_client.send_message_stream(thread_id, augmented_message, provider, model, tools, thinking, web_search="off")`.
8. The backend streams text, reasoning state, tool requests, usage, and run end/failure chunks.
9. `_consume_stream()` turns visible assistant text into ACP agent message chunks.
10. When tools are requested, `_handle_tool_submit()` executes bridge/CLI tools and calls `submit_tool_outputs`.
11. The bridge emits `session/update` for every visible unit of work.
12. `AcpThread.handle_session_update()` stores messages, tool calls, plans, terminal data, usage, cost, and speed metrics.
13. `ThreadView` renders assistant text, progress, grouped exploration rows, collapsed write/edit cards, terminal cards, diff cards, permission buttons, and footer context/cost.

The file-edit path is the most important special case:

1. Model calls `write`, `edit`, `search_replace`, or `delete_file`.
2. Bridge computes old/new text and builds an ACP diff item.
3. Bridge emits the tool call/diff state so the chat can show what changed.
4. For writes/edits/search-replace, bridge calls Rust request `fs/write_text_file`.
5. `agent_servers/src/acp.rs` handles that request by calling `AcpThread::write_text_file(path, content)`.
6. `AcpThread` applies the edit through editor-owned buffer/save/action-log plumbing.
7. The UI sees the result as a real editor-backed diff/change instead of a blind Python file write.
8. If the IDE write request fails, the bridge has a direct write fallback, but that is the less desirable path because it bypasses some editor-owned state.

Terminal output follows a parallel metadata path:

1. Bridge emits a tool call with `_meta.terminal_info`.
2. Rust creates/registers a display-only terminal for that tool call.
3. Bridge streams `_meta.terminal_output` chunks.
4. Rust forwards chunks to the terminal provider, buffering output if it arrives before the terminal object exists.
5. Bridge emits `_meta.terminal_exit` when the command finishes, times out, or is cancelled.

## IDE Screens And Backboard Editor Flow

The IDE has several Backboard entry points that all end up on native ACP sessions.

### Native Agent Panel And Chat

Primary files:

- `ide/zed/crates/agent_ui/src/conversation_view.rs`
- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- `ide/zed/crates/agent_ui/src/agent_panel.rs`

What the user sees:

- Backboard-branded native agent conversation.
- Composer placeholder: "Message Backboard - @ to include context".
- Backboard/model pill opening the ACP model selector.
- Mode/config controls for Agent/Ask/Manual/Free and Intensity.
- Permission prompts for tools/commands.
- Tool cards, grouped exploration, terminal cards, diff cards, plan state, context-window tokens, cost, and speed metrics.

What owns the state:

- `ConversationView` owns the selected/root thread view and connection lifecycle.
- `ThreadView` renders entries from `AcpThread`.
- `AgentPanel` owns active and retained conversations and creates Backboard sessions.
- `AcpThread` is the single source of truth for messages/tool calls/usage once ACP updates arrive.

### Agent Workspace / Multi-Agent Screen

Primary files:

- `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- `ide/zed/crates/agent_ui/src/agent_panel.rs`
- `ide/zed/crates/workspace/src/multi_workspace.rs`

What the user sees:

- Full-page `Agent Workspace` / `Multi-Agent` dashboard.
- One task per line input.
- Scope controls: Whole Project, Selected Files, Git Changes, Tests Only.
- Type controls: Build, Review, Test, Docs.
- Mode controls: Agent, Ask, Manual, Free.
- Run cards grouped by batch, with status, cost, changed files, events, branch/worktree labels, apply state, and actions.
- Detail drawer with the real `ConversationView` for the selected agent.

Runtime behavior:

- Each task line becomes a retained native Backboard conversation.
- In git projects, each task gets a linked worktree and branch from the same base commit.
- The ACP session work_dirs point at that agent worktree, so reads/writes happen in isolation.
- `Review` opens the existing `AgentDiffPane`.
- `Apply` diffs the worktree against the base commit and applies the patch into the base workspace with `git apply --3way`.
- Same-batch conflicts are detected by changed path overlap and block apply until resolved.
- In non-git projects, only one current-workspace run starts; changes are live and Apply is disabled.

### Beginner / Simple Workspace

Primary files:

- `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`
- `ide/zed/crates/beginner_ui/src/beginner_chat_feed.rs`
- `ide/zed/crates/beginner_ui/src/file_changes_panel.rs`
- `ide/zed/crates/beginner_ui/src/web_preview.rs`

What the user sees:

- Beginner landing/active-project flow.
- Folder selection before starting an agent when needed.
- Chat-first prompt/follow-up box. **Enter submits** (registered via `editor.register_action` for `editor::actions::Newline` — subscription stored in `session_subscriptions` to stay alive).
- Friendly feed that turns raw ACP messages/tool calls into simpler labels.
- File changes panel listing created/modified files with a route back into the editor.
- Raw file browser with **folder navigation**: clicking a folder drills into it; a back row appears at the top to go up. `raw_browse_path: Option<PathBuf>` tracks the current directory (separate from `selected_folder`).
- Embedded web preview panel that shows the running dev server inline (macOS WKWebView, Windows WebView2).
- Layout flips when the preview is live: preview takes most of the space; chat shrinks to a narrow 340 px column on the left. When the agent is building again, chat takes priority.
- Session tab bar shows proper browser-style tabs: active tab has a raised bordered background, inactive tabs are muted with hover highlight. Rendered by `render_tab_bar(active_title, background_titles, cx)`.

Runtime behavior:

- `BeginnerWorkspace` asks `AgentPanel::spawn_beginner_thread(text, work_dirs, ...)` to create a native Backboard ACP thread.
- `spawn_beginner_thread` passes `work_dirs` so the agent writes into the correct folder and creates the `ConversationView` with `suppress_notifications = true` so tool-confirmation popups are never shown in Simple Mode.
- The ACP session uses `free` mode so the Python bridge auto-approves every tool call without asking the user.
- The initial prompt is `AgentInitialContent::ContentBlock { auto_submit: true }`.
- The beginner feed observes the same `AcpThread` entries as native chat but hides thought-only chunks and simplifies tool labels.
- The file changes panel watches the active thread action log, not a separate file-scanning runtime.
- When the agent finishes, `open_web_app_if_present` searches the project root and one level of subdirectories for a `package.json` with a `"dev"` script or an `index.html`. It starts `npm run dev` for Next.js/Vite projects or sets `preview_url` to a `file://` URL for static HTML.
- Before starting a new dev server, the code kills any existing process on port 3000 with `lsof -ti :3000 | xargs kill -9` (macOS/Linux), waits 400 ms, then starts fresh. The preview URL is always `http://localhost:3000`.
- Each session claims a unique port (3000, 3001, or 3002) stored in `dev_server_port: Option<u16>`, which is stashed/swapped alongside `preview_url`. `claim_dev_server_port()` scans background sessions to find the lowest free port. `start_dev_server` only kills that specific port — other sessions' servers are left running. This allows up to 3 live dev servers simultaneously; switching tabs shows the correct session's preview without restarting anything.
- `start_dev_server` runs via `$SHELL -i -l -c "cd <folder> && <pm> run dev -- --port=<port>"` so both `~/.zprofile` and `~/.zshrc` are sourced, making nvm/Homebrew/mise available from a GUI app launch. The plain `Command::new("npm")` path fails because macOS GUI apps get a minimal PATH.
- Package manager is auto-detected from lockfiles: `pnpm-lock.yaml` → pnpm, `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, fallback → npm.
- The polling task is stored in `dev_server_task: Option<Task<()>>` on both `BeginnerWorkspace` and `ProjectSession`. Replacing this field drops and cancels the old task, preventing stale tasks from firing on the wrong session when tabs are switched.
- **Follow-up behavior:** `submit_follow_up` only clears `web_preview` (hides the preview, reverts to chat-dominant layout) but keeps `preview_url`. The running dev server hot-reloads the code changes. When `AcpThreadEvent::Stopped` fires again, the code checks `if preview_url.is_none()` before calling `open_web_app_if_present` — if a server is already running, it just calls `cx.notify()` and `render()` recreates the `WebPreview` from the stored URL. The server is never killed/restarted on a follow-up.
- Multiple project sessions are supported with "+". Each session is stashed/restored with its full state. **Critical:** `self.web_preview = None` must be called after building the stash struct to actually drop the live WKWebView — setting `web_preview: None` in the `ProjectSession` literal only prevents the stash from holding a copy, it does not drop the active one.

### Embedded Web Preview (`web_preview.rs`)

The web preview embeds a native webview as a transparent overlay inside the GPUI window, positioned by a `canvas` element in `render_right_panel`.

Platform support:

| Platform | Implementation | Notes |
|----------|----------------|-------|
| macOS | `WKWebView` via `cocoa`/`objc` crates | Climbs from GPUI's Metal NSView to its `superview` (the window's `contentView`) so the webview is a sibling of the Metal layer, not a child of it |
| Windows | WebView2 child window via `wry = "0.55"` | Uses `build_as_child(window)` with GPUI's `Win32WindowHandle`; coordinates already top-left |
| Linux | Not embedded — `preview_url` shows "Open in Browser" button | GPUI uses Wayland; wry child views require X11 |

Key facts for future changes:

- `WebPreview::new(window, url)` is called lazily in `BeginnerWorkspace::render()`. It should only be called once per project session.
- When `start_dev_server` fires or when `open_web_app_if_present` sets `preview_url`, `web_preview` is set to `None` first so `render()` creates a fresh webview pointed at the new URL — even if the port number is reused.
- The macOS `WKWebView` configuration must not call `setValue:forKey: allowFileAccessFromFileURLs` on `WKPreferences`. That private KVC key was removed in macOS 26 and causes an EXC_BAD_ACCESS crash.
- `set_frame` on macOS does the Y-flip: `ns_y = viewport_height - gpui_y - element_height`. This is passed through the `canvas` prepaint closure in `render_right_panel`.
- Layout: `preview_dominant = web_preview.is_some() && !is_running`. When true, the right panel gets `flex_1` and the chat panel is fixed at `340 px`. When false, chat gets `flex_1` and the preview panel is `320 px`.
- Sending a follow-up message clears `web_preview` (reverts to chat-dominant layout) but keeps `preview_url` so the running dev server is reused — it is only restarted when `preview_url` is None (first build or explicitly reset).

The `wry` crate is a Windows-only workspace dependency (`[target.'cfg(target_os = "windows")'.dependencies]` in `beginner_ui/Cargo.toml`). On macOS the `cocoa`/`objc` crates are used directly. Adding the `os-webview` wry feature on Linux would pull in GTK/webkit2gtk — do not enable it.

### Workspace And Title Bar Switching

Primary files:

- `ide/zed/crates/workspace/src/multi_workspace.rs`
- `ide/zed/crates/title_bar/src/title_bar.rs`
- `ide/zed/crates/agent_ui/src/agent_ui.rs`

Important behavior:

- Expert mode can show the normal Code Editor or full-page Multi-Agent view.
- Simple mode renders the Beginner workspace.
- `OpenBackboardAgentWorkspace` sets `MultiWorkspace.multi_agent_expanded = true`.
- The title bar exposes Editor/Agents style switching; the workspace shell exposes Code Editor/Multi-Agent tabs.
- The Agent Workspace is not an editor tab. It is rendered by the workspace shell.

### Inline Autocomplete Is Separate

Inline autocomplete is a Backboard API integration, but it is not ACP chat:

- It lives under `ide/zed/crates/edit_prediction/src/backboard.rs` and related edit-prediction settings/registry files.
- It uses BYOK API key storage through edit-prediction provider setup.
- It creates/reuses a Backboard assistant, creates a thread, sends a completion prompt, and inserts ghost text at the cursor.
- It does not use `backboard-ide-acp.py`, `AcpThread`, Agent Workspace, or CLI tools.

## Tooling, Permissions, And Modes

The IDE bridge exposes the CLI tool system through ACP-friendly adapters.

### Tool Catalog

`AdvancedToolManager.get_tool_definitions()` provides the base catalog:

- File tools: `read_file`, `write`, `edit`, `delete_file`, `create_directory`, `edit_notebook`
- Search/tools over the workspace: `glob`, `glob_file_search`, `grep`, `list_dir`, `codebase_search`, `read_lints`
- Shell/code execution: `bash`, `run_terminal_cmd`, `repl`, `run_code`, `computer`
- Web tools: `web_search`, `web_fetch`
- Planning/control: `todo_write`, `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, `persistence_decide`, `sleep`
- Subagents: `task`
- MCP tools: appended from enabled MCP servers
- Memory/update hooks where supported by the CLI tool layer

The bridge does not blindly pass every CLI tool through in every mode. It filters definitions before sending them to the backend so the model sees only tools allowed for the current ACP mode.

### Mode Restrictions

| Mode | Bridge behavior |
|------|-----------------|
| `ask` | Blocks mutating file tools, shell/code/computer tools, and `task`; read/search/web/planning tools remain available |
| `manual` | Blocks shell/code/computer tools and `task`; file proposals can still be adapted through IDE diff/write paths |
| `agent` | Normal autonomous coding mode; shell commands generally ask permission unless they are safe read-only commands |
| `free` | More autonomous mode; routine shell approvals are bypassed by the bridge |

Ask/Manual/Agent/Free are ACP session modes, not separate backend products. They change tool availability and approval behavior before the request reaches the model.

### File Tool Adapters

The bridge has dedicated adapters for IDE-safe file changes:

- `write`, `edit`, and `search_replace` compute a diff and request `fs/write_text_file`.
- `delete_file` computes a diff/delete tool card, then deletes the path.
- `create_directory` has a dedicated directory proposal path.
- Mutating tools without a dedicated IDE adapter fail closed with a message that a diff adapter is needed.

Path handling is workspace-confined for mutations through the CLI tool manager and bridge path resolution. Reads can inspect broader context where the CLI allows it, but writes should remain inside the session workspace/worktree.

### Shell Policy

Shell tools are intentionally stricter than file/search tools:

- `_is_read_only_shell_command()` auto-approves simple read-only commands such as safe `git`, `ls`, `pwd`, `cat`, `sed`, `rg`, and similar inspection commands.
- Commands with shell metacharacters, destructive flags, network mutation, dangerous git operations, or sensitive paths do not get read-only auto-approval.
- `agent` mode asks the IDE for approval before risky shell execution.
- `free` mode bypasses routine shell approvals.
- The CLI tool manager still runs sandbox checks for destructive commands and sensitive paths.

Timeout classes:

- Read-only commands get short timeouts.
- Normal commands get bounded timeouts.
- Test/build/check commands can get longer timeouts.
- Install commands get longer still.
- Dev-server commands get a startup window, then are stopped so the turn does not hang on a never-ending server process.

### Tool Batching And Output Compression

The bridge optimizes read-heavy tool turns:

- Consecutive read-only IDE tools can run in parallel.
- Identical read-only tool calls are de-duped.
- Mutating tools, shell tools, todos, subagents, MCP calls, and memory operations remain sequential.
- Tool outputs are compressed before being returned to the model to avoid flooding the next prompt.

This is why a turn can show one grouped exploration row in the UI even when the model actually read several files and ran searches underneath.

### ACP Rendering Hooks

Important metadata/update paths:

- `_meta.terminal_info` creates a terminal card.
- `_meta.terminal_output` appends command output.
- `_meta.terminal_exit` marks command completion.
- `todo_write` output becomes ACP plan entries via `_emit_plan_from_todos()`.
- `usage_update` carries context-window tokens and cost.
- `usage_update._meta.backboard_speed` carries timing buckets parsed by `acp_thread::SpeedMetrics`.
- Backboard progress thoughts use `_meta.backboardProgress` so `AcpThread` can keep them separate from normal assistant text.

## Backboard Agent Server

File:

- `ide/zed/crates/agent_servers/src/backboard.rs`

Main types/constants:

- `BACKBOARD_AGENT_ID = "backboard"`
- `BACKBOARD_AGENT_NAME = "Backboard"`
- `BackboardAgentServer`
- Env overrides:
  - `BACKBOARD_IDE_ACP_PATH`
  - `BACKBOARD_CLI_PATH`
  - `BACKBOARD_CLI_ROOT`
  - `BACKBOARD_IDE_PYTHON`

The server implements Zed's `AgentServer` trait. It returns Backboard as the native agent and defaults to ACP mode `agent`. Agent Workspace can construct a Backboard server instance with a different default mode for that retained thread, such as `free`, before the ACP session auto-submits its initial task.

When `connect` runs, it builds an `AgentServerCommand` pointing at the Python bridge:

- Default bridge path: `ide/zed/script/backboard-ide-acp.py`
- Default CLI root: `ide/zed/../../cli`
- Default Python: resolved by `backboard_python()`

The server also passes IDE-specific environment:

- `BACKBOARD_IDE=zed`
- `NO_BROWSER=1` when the delegate store requests no browser
- Proxy env from `load_proxy_env(cx)`

This file should remain the Rust boundary between Zed and the Python ACP bridge. If a future model needs to change launch behavior, command resolution, or env forwarding, this is the first place to inspect.

## Python ACP Bridge

File:

- `ide/zed/script/backboard-ide-acp.py`

Purpose:

- IDE-owned JSON-RPC stdio server.
- Imports the CLI engine without editing CLI code.
- Converts CLI/model/tool events into ACP session updates Zed already knows how to render.

Important classes/functions:

- `BackboardIdeAcpServer`: JSON-RPC request router.
- `BackboardIdeSession`: per-workspace/per-session runtime.
- `_find_cli_root()`: resolves CLI root from `BACKBOARD_CLI_ROOT` or checkout layout.
- `_shared_config_defaults()`: reads non-secret defaults from `~/.backboard/config.json`.
- `_is_read_only_shell_command()`: conservative auto-approval gate for simple read-only shell commands.
- `_ensure_thread_binding()`: creates Backboard assistant/thread and injects IDE-specific system prompt.
- `_consume_stream()`: maps streaming model events into ACP-visible text/progress/tool work.
- `_execute_tool_call()`: dispatches model tool calls.
- `_propose_file_change()`: computes and applies file diffs for write/edit/delete.
- `_run_shell_tool()`: auto-runs safe read-only commands and asks approval for risky commands.
- `_run_shell_subprocess()`: streams terminal output for shell commands.
- `_usage()`: emits ACP `usage_update` events for the chat context-window display instead of rendering usage as a tool card.
- `_emit_plan_from_todos()`: maps `todo_write` output into ACP plan state.
- `_start_heartbeat()` / `_heartbeat_loop()` / `_stop_heartbeat()`: emits truthful progress notes during long gaps.

CLI imports used by the bridge:

- `backboard_cli.agent.engine.RLMEngine`
- `backboard_cli.agent.subagents.SubagentManager`
- `backboard_cli.api.client.BackboardAPIClient`
- `backboard_cli.api.mcp.manager.MCPManager`
- `backboard_cli.cli.chat.pricing.PricingService`
- `backboard_cli.cli.chat.prompt.build_system_prompt`
- `backboard_cli.skills.manager.SkillManager`
- `backboard_cli.state.config.config`
- `backboard_cli.tools.manager.AdvancedToolManager`

The bridge redirects accidental `stdout` output to `stderr` so protocol messages can use clean stdout:

- `PROTOCOL_STDOUT = sys.stdout`
- `sys.stdout = sys.stderr`

### Why The Bridge Is Python Instead Of Rust

Python was chosen for the first serious milestone because the existing Backboard CLI is already Python and already owns the hard parts:

- agent engine
- Backboard API client behavior
- tool definitions and execution
- MCP manager
- skills
- subagents
- codebase/search/indexing behavior
- memories/config/model defaults
- cancellation/tool orchestration patterns

Keeping the ACP bridge in Python lets the IDE call the same runtime directly instead of rewriting or re-modeling all of that in Rust. That reduces product risk: the IDE gets closer to CLI parity quickly, and fixes to the agent runtime continue to live in one source of truth.

A Rust ACP bridge could make sense later if:

- startup latency from Python becomes a real bottleneck
- distribution/packaging needs a single native binary
- the CLI runtime is exposed through a stable local server/API
- the agent engine is ported to Rust or split into language-neutral services
- we need tighter type safety around ACP protocol evolution

The tradeoff is that a Rust bridge today would either duplicate the Python CLI agent stack or shell out/scrape another process. Duplication would slow iteration and risk behavior drift; process scraping would be less reliable than structured ACP events. For now, the best boundary is Rust for Zed integration/UI and Python for the Backboard agent runtime bridge.

### Config And API Key

Shared config path:

- `~/.backboard/config.json`

The bridge uses that config for provider/model defaults and the Backboard API key through the CLI config/client. Do not print or copy the API key into docs, logs, or UI. If another model needs to debug key loading, inspect config shape only and redact secrets.

Session mapping path:

- `~/.backboard/ide_sessions.json`

The bridge persists IDE session mappings with:

- ACP session id
- workspace path
- Backboard assistant id
- Backboard thread id
- provider
- model
- title

### Models

ACP methods include:

- `session/set_model`
- model state reporting from `BackboardIdeSession.model_state()`

Model ids are represented as:

- `provider/model`

If the model list API fails, the bridge falls back to defaults from `~/.backboard/config.json` or hardcoded defaults:

- provider: `openai`
- model: `gpt-4o`

Model popup behavior:

- The left Backboard/model pill in the chat composer is the real model selector trigger.
- The duplicate right-side model selector was removed.
- The trigger is implemented by `ModelSelectorPopover` and branded with Backboard text/logo through `set_trigger_brand(...)`.
- Do not replace this with a separate clickable `div`: GPUI popovers need their actual rendered trigger in the tree for anchoring and focus. The earlier custom-click approach showed `Select model` and did not open reliably.

Relevant files:

- `ide/zed/crates/agent_ui/src/model_selector_popover.rs`
- `ide/zed/crates/agent_ui/src/conversation_view.rs`
- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`

### Intensity

The chat composer exposes an ACP config option named `Intensity`. This is separate from model selection and is meant to control speed/cost feel by changing how much extended thinking the bridge asks the model to do.

Relevant files:

- Bridge state and behavior: `ide/zed/script/backboard-ide-acp.py`
- ACP config option plumbing: `ide/zed/crates/agent_servers/src/acp.rs`
- Config option UI: `ide/zed/crates/agent_ui/src/config_options.rs`
- Composer/model selector UI: `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- Branded model selector trigger: `ide/zed/crates/agent_ui/src/model_selector_popover.rs`

ACP surface:

- `BackboardIdeSession.config_options()` returns `backboard_intensity`.
- `session/set_config_option` updates `session.intensity`.
- The option uses ACP category `thought_level`, so the Rust UI labels it as `Intensity: Fast`, `Intensity: Balanced`, or `Intensity: Deep`.

Behavior in `_thinking_payload()`:

- `Fast`: normally returns `None`, so the bridge does not request extended thinking. This is the default because the user said Backboard felt slow.
- `Fast` + website/app/UI task: uses the same capped thinking behavior as `Balanced` so generated webpages do not lose visible design quality.
- `Balanced`: starts from the CLI-configured thinking payload, then caps token budget-like fields to `2048` when present.
- `Deep`: uses the CLI-configured thinking payload as-is through `config.thinking_for_provider(provider, model)`.

Important nuance:

- Intensity does not change the selected model.
- Intensity does not expose private chain-of-thought.
- Intensity only affects the request payload sent by the IDE bridge when the selected provider/model supports thinking-style options. If a provider ignores those fields, the UI may still change while model behavior does not materially change.
- Model selector and config options must coexist. `agent_servers/src/acp.rs::config_state()` intentionally preserves modes/models even when `configOptions` are present; otherwise the Backboard model popup falls back to `Select model` and cannot open correctly.

### Modes

Backboard IDE modes are enforced in the bridge:

- `agent`: full tool access, with command approval.
- `ask`: read/search only. Mutating tools and shell tools are blocked.
- `manual`: file edit proposal flow, shell/subagent tasks blocked.
- `free`: unrestricted tool access, and shell commands run without approval prompts.

Mode-blocked tool sets:

- `ASK_BLOCKED_TOOLS = MUTATING_TOOLS | SHELL_TOOLS | {"task"}`
- `MANUAL_BLOCKED_TOOLS = SHELL_TOOLS | {"task"}`

### File Writes And Command Safety

Current behavior:

- File writes/edits/deletes are allowed without user approval.
- File changes still emit ACP diff/tool cards so the UI can show what happened.
- Directory creation is allowed without approval.
- Obvious read-only shell commands can auto-run without approval.
- In `free` mode, shell commands run without approval prompts.
- Outside `free` mode, mutating, complex, package-manager, GitHub, or repo-destructive commands still require user approval through `session/request_permission`.

Mutating tools:

- `write`
- `edit`
- `search_replace`
- `delete_file`
- `create_directory`
- `edit_notebook`

Shell tools:

- `bash`
- `run_terminal_cmd`
- `run_code`
- `repl`
- `computer`

Read-only auto-approval is intentionally conservative. The bridge currently auto-approves simple commands such as `pwd`, `ls`, `cat`, `rg`, `grep`, `head`, `tail`, `wc`, `stat`, `file`, safe `find`, safe `sed`, safe read-only `git` commands such as `git status`, `git diff`, `git log`, and `git show`, and safe-read `curl` invocations (`curl <url>`, `curl -L <url>`, `curl -I <url>`, `curl -X GET <url>`).

The bridge does not auto-approve commands with shell control syntax, redirects, command substitution, package managers, GitHub mutation risk, or dangerous git operations. Examples that must keep asking for permission include:

- `git push`
- `git pull`
- `git reset`
- `git clean`
- `git checkout` / `git switch`
- `git commit`
- `npm install`
- `npm run ...`
- `pnpm ...`
- `rm`, `mv`, `cp`, `chmod`, `chown`
- any command using `>`, `<`, `|`, `;`, `&&`, backticks, or `$()` style expansion
- `curl` upload or mutation patterns such as `curl -X POST ...`, `curl -d ...`, `curl -F ...`, `curl -T ...`, and `curl -o/--output/...`

The user explicitly asked that reading commands should be automatically approved, but anything that can damage the codebase or GitHub repo must ask for permission first. When unsure, require permission.

### Website/App Prompt Defaults

The bridge appends an IDE-specific system prompt in `_ensure_thread_binding()`. For website/app requests, it tells the agent:

- Use Next.js TypeScript for empty workspaces unless the user asks for static/single-file HTML.
- Baseline files should include:
  - `package.json`
  - `app/page.tsx`
  - `app/layout.tsx`
  - `app/globals.css`
  - `next.config.js` or `next.config.mjs` when needed
- Follow existing app stack if one exists.
- Verify with install/build/dev-server checks when practical.
- Build a real usable first screen instead of a placeholder, scaffold, or generic card stack.
- Treat responsive layout, spacing, typography, color contrast, interaction states, and relevant assets/icons as part of the task.
- Avoid decorative filler such as generic gradients, blobs, and vague copy when the prompt calls for a concrete product or experience.
- Only require browser/screenshot inspection when browser tooling is available or the user explicitly asks for visual verification.
- Run dev-server checks in the foreground without appending `&`; the bridge stops dev-server commands after a short startup window.

**Simple Mode absolute rules** (appended at the end of the system prompt, labeled "BACKBOARD STUDIO SIMPLE MODE — ABSOLUTE RULES"):
1. Never output phrases like `run npm run dev`, `run the dev server`, `to preview`, `open http://localhost`, or any terminal command or localhost URL.
2. The IDE automatically installs dependencies, starts the dev server, and shows the preview. The user does nothing.
3. End every completed response with a friendly 2–4 sentence plain-language description of what was built (no file paths, commands, or URLs).
4. The user is non-technical and will never open a terminal.

This is why future website generation should not collapse into only `index.html` or a bare static scaffold.

The bridge also detects website/app/UI turns at prompt time. On those turns, even when the visible `Intensity` selector is set to `Fast`, it activates a website quality profile:

- injects frontend quality guidance into `<backboard_ide_context>`
- includes broader file context and semantic context when available
- sends a capped thinking payload equivalent to `Balanced`

This keeps normal IDE turns fast while making webpage generation closer to CLI quality.

### Live Progress

The bridge avoids exposing private chain-of-thought. Instead it emits high-level progress notes through ACP:

- "Backboard is reading your request."
- "Backboard connected to the model."
- "Backboard is planning the next step."
- "Backboard is preparing tool actions."
- "Backboard is running N tool actions."
- "Waiting for approval: ..."
- "Applying `path`."

Heartbeat behavior:

- A heartbeat task starts when a prompt begins.
- If no visible event is sent for roughly 2.5 seconds, it emits a truthful status based on the current phase.
- Heartbeat stops on completion, error, or cancel.

This makes the chat feel alive during model reasoning, tool preparation, and command waits without showing private reasoning.

### Context Window Display

The chat footer renders the ACP thread token usage as a compact context-window control:

- percentage full
- used context tokens
- total context window tokens
- cumulative session cost when available

The bridge emits this through ACP `usage_update` from `_usage()`. It should not create a visible `Usage` tool card. `acp_thread` accepts `UsageUpdate` and stores it in `TokenUsage`, which `conversation_view/thread_view.rs` renders next to the Backboard/model controls.

### Pricing / Cost Display

The IDE bridge reuses the CLI pricing implementation without editing CLI files.

CLI source-of-truth:

- `cli/backboard_cli/cli/chat/pricing.py`
- Class: `PricingService`

Pricing lookup order in the CLI service:

1. Live model catalog from `/models`, using `input_cost_per_1m_tokens` and `output_cost_per_1m_tokens`.
2. Persistent snapshot: `~/.backboard/pricing_snapshot.json`.
3. Tagged last-resort fallback table for common models.

IDE behavior:

- `BackboardIdeSession` constructs `PricingService()`.
- `model_state()` calls `self.pricing.update_from_catalog(models)` when the model list loads successfully.
- `_usage()` receives input/output tokens from `run_ended` chunks.
- `_record_usage_cost()` first checks for server-provided cost fields such as `amount_deducted_usd`, `cost_usd`, `turn_cost_usd`, or `cost`.
- If the server did not include a cost, the bridge estimates with `PricingService.cost_for_turn(provider, model, input_tokens, output_tokens)`.
- The bridge accumulates `session_total_cost` and emits ACP `usage_update.cost = { amount, currency: "USD" }`.
- `acp_thread` stores this as `SessionCost`.
- `thread_view.rs::render_token_usage()` shows `Session cost: $...` under context-window tokens and includes the same cost in the token tooltip.

Important nuance:

- This is a session display estimate unless the server included a billed amount.
- The CLI has a deeper reconciliation path through `/billing/usage/recent`; the IDE currently does not run that delayed reconciliation.
- The IDE only imports `PricingService`; it does not modify `cli/`.

## Inline Autocomplete (Edit Predictions)

Backboard Studio includes a native inline autocomplete feature powered by the Backboard API. It shows ghost text at the cursor as you type, accepted with Tab, dismissed with Esc.

### Provider Routing

Zed's edit prediction system has an `EditPredictionProvider` enum in settings. The `Zed` variant is repurposed as the Backboard provider:

- Settings: `"edit_predictions": { "provider": "zed" }`
- Registry maps `EditPredictionProvider::Zed` → `EditPredictionModel::Backboard`
- `EditPredictionStore` dispatches `EditPredictionModel::Backboard` → `BackboardCompletions::request_prediction()`

No new provider enum variant was added — `Zed` was reused to avoid changing serialized settings keys.

### API Flow

Each completion fires three sequential HTTP calls to `https://app.backboard.io/api`:

1. `POST /api/assistants` — create or reuse a named assistant (cached per session per API key)
2. `POST /api/assistants/{id}/threads` — create a fresh thread for this completion
3. `POST /api/threads/{id}/messages` — send the prompt, receive the completion text

Auth: `X-API-Key: {user_key}` header on every request.

Model: `deepseek/deepseek-chat` via provider `openrouter` (default, configurable in settings).

### Pure Cursor Insertion

Completions use a Copilot-style pure insertion approach — the edit is always an empty-range replacement at the cursor:

```
(cursor_anchor..cursor_anchor, response_text)
```

The old range is always empty so the model can never delete existing text. This differs from Zed's native Zeta/Mercury approach which diffs the model output against a large editable region and can produce large deletions when general-purpose LLMs return unexpected text.

### Prompt Format

The prompt sent to Backboard:

```
You are a code completion engine. Complete the code at the cursor position marked with <CURSOR>.
Output ONLY the text to insert at <CURSOR>. Do not repeat any code that already exists.
Do not include markdown code fences. Do not explain anything.

File: {file_path}

{code_before_cursor}<CURSOR>{code_after_cursor}
```

Recent edit events from the buffer are appended as context when available.

Code fence stripping runs on the response before the edit is constructed to handle models that wrap output in ` ```python\n` or ` ``` ` blocks.

### BYOK Model

Completions are entirely BYOK (bring your own key). If no API key is configured, `request_prediction()` returns `Task::ready(Ok(None))` and no completion fires. There is no embedded free-tier key and no quota tracking.

The user enters their key in: Settings → Editor → Edit Predictions → Configure Providers → Backboard AI.

The key is stored in the system keychain via `ApiKeyState` and can also be set via `BACKBOARD_API_KEY` environment variable.

### Configurable Model Settings

Users can override the provider and model in settings JSON:

```json
{
  "edit_predictions": {
    "provider": "zed",
    "backboard": {
      "provider": "openrouter",
      "model": "deepseek/deepseek-chat"
    }
  }
}
```

### Key Files

| File | Role |
|------|------|
| `crates/edit_prediction/src/backboard.rs` | `BackboardCompletions`, API key state, 3-step API calls, prompt builder, response parsing |
| `crates/edit_prediction/src/edit_prediction.rs` | `EditPredictionModel::Backboard` variant, dispatch to `BackboardCompletions`, `backboard` field on `EditPredictionStore` |
| `crates/zed/src/zed/edit_prediction_registry.rs` | Maps `EditPredictionProvider::Zed` → `EditPredictionModel::Backboard`, loads API token |
| `crates/settings_content/src/language.rs` | `BackboardSettingsContent` with `provider` and `model` fields |
| `crates/language/src/language_settings.rs` | `BackboardSettings` runtime struct, wired into `EditPredictionSettings` |
| `crates/settings_ui/src/pages/edit_prediction_provider_setup.rs` | Settings UI — shows only the Backboard AI API key card, all other providers removed |

### Testing Autocomplete

```sh
BACKBOARD_API_KEY=your_key cargo run -p zed
```

1. Set `"edit_predictions": { "provider": "zed" }` in settings JSON (`Cmd+,`)
2. Open Settings → Editor → Edit Predictions → Configure Providers → paste API key
3. Open any code file, type the start of a statement, pause ~1 second
4. Ghost text appears — Tab to accept, Esc to dismiss
5. `Cmd+Alt+Z` manually triggers a prediction

To watch API calls in real time:

```sh
BACKBOARD_API_KEY=your_key RUST_LOG=edit_prediction=debug cargo run -p zed 2>&1 | grep -i backboard
```

### Debugging Autocomplete

If no ghost text appears:

1. Confirm `"provider": "zed"` is set in edit predictions settings.
2. Confirm the API key is saved (Settings → Configure Providers should show "API Key Configured").
3. Check `RUST_LOG=edit_prediction=debug` output for Backboard API errors.
4. Confirm the key is valid — a 401 response means key format is wrong; a 402 means quota exceeded.

If completions delete or replace existing code:

1. Check `backboard.rs::request_prediction` — edits must be `(cursor_anchor..cursor_anchor, text)` not a range replacement.
2. Do not re-introduce `compute_edits` from `zeta.rs` — that function uses text diff and is designed only for fine-tuned Zeta/Mercury models, not general-purpose LLMs.

If the provider dropdown in settings shows other providers (Mercury, Codestral, etc.):

1. Check `edit_prediction_provider_setup.rs` — only the Backboard AI card should be rendered.
2. The `render_provider_dropdown` and all non-Backboard provider functions were intentionally removed.

## Native Chat UI

Primary files:

- `ide/zed/crates/agent_ui/src/conversation_view.rs`
- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- `ide/zed/crates/agent_ui/src/agent_panel.rs`

The chat interface is still Zed's native agent conversation surface, but visible labels were shifted toward Backboard.

Key behavior:

- The visible native agent name is "Backboard".
- The composer placeholder says "Message Backboard - @ to include context".
- Assistant/message headers show Backboard plus the active model when available.
- The left Backboard/model pill opens the native ACP model selector.
- Backboard uses native ACP config surfaces for `Agent` mode and `Intensity`.
- Tool calls, terminal cards, diffs, and permission requests use existing Zed ACP rendering.
- The right-side duplicate model selector was removed.

Important paths:

- `conversation_view.rs`
  - Handles connection, model selector/config option setup, permission request routing, active model naming, composer placeholder text.
- `thread_view.rs`
  - Renders conversation entries, assistant chunks, thoughts/progress, tool calls, collapsed/expanded tool output, terminal cards, diff cards, and permission buttons.
- `agent_panel.rs`
  - Owns the active/retained conversations and routes actions for opening Backboard, workspace agents, terminal, and threads.

## Collapsed Writing/Edit Cards

File:

- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`

User-requested behavior:

- Writing/editing boxes should be automatically compressed.
- User can expand/un-collapse them.

Implementation detail:

- Backboard edit/write tool calls render as compact cards by default.
- Expand/collapse state is tracked in `expanded_tool_calls`.
- The UI keeps meaningful card titles like `Writing src/App.tsx` or `Editing styles.css` while hiding large content until the user expands.

If a future change breaks this, search for:

- `expanded_tool_calls`
- `render_any_tool_call`
- `render_tool_call_content`
- `render_diff_editor`
- Backboard-specific tool call labels/status in `thread_view.rs`

## Grouped Exploration Cards

File:

- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`

User-requested behavior:

- Do not show a long stack of individual `Reading ...`, `Searching ...`, and `Backboard thinking` entries.
- Group those low-noise exploration steps into one clean, theme-native row, similar to: `Explored 3 files, ran 1 search`.
- The group can be expanded/collapsed so details are still available.

Implementation detail:

- `render_entries()` checks `exploration_group_at(...)` before rendering an individual entry.
- Consecutive entries are grouped when they are:
  - read tool calls (`ToolKind::Read`)
  - search tool calls (`ToolKind::Search`)
  - fetch tool calls (`ToolKind::Fetch`)
  - assistant messages that contain only thought/progress chunks and no real assistant message text
- Only low-noise runs are grouped. The UI does not hide:
  - user messages
  - normal assistant text
  - edits/diffs
  - terminal commands
  - command approvals
  - completed plans
- The group header is rendered by `render_exploration_group(...)`.
- Detail rows are rendered by `render_exploration_detail_row(...)`.
- Expansion state reuses `expanded_tool_calls` with synthetic ids like `exploration-group-START-END`.
- If the group is the final list item, it still renders `render_thread_controls(...)` so feedback/retry controls are not lost.

If a future change breaks grouping, search for:

- `ExplorationGroup`
- `exploration_group_at`
- `is_exploration_entry`
- `is_thought_only_assistant_message`
- `render_exploration_group`

## Agent Workspace Page

Relevant files:

- `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- Legacy portal window implementation: `ide/zed/crates/agent_ui/src/agent_portal_window.rs`
- Full-page shell switcher: `ide/zed/crates/workspace/src/multi_workspace.rs`

Action registration:

- `ide/zed/crates/agent_ui/src/agent_ui.rs`
- Action: `agent::OpenBackboardAgentWorkspace`

Menu entry:

- `ide/zed/crates/agent_ui/src/agent_panel.rs`
- "Agent Workspace" item in the Backboard new-thread/menu area.

Purpose:

- Full-page Agent Workspace surface for multiple Backboard agents running at once.
- Inspired by the user's provided grid/dashboard mockup.
- Reuses real Backboard native ACP conversations rather than building a separate fake runtime.
- `agent::OpenBackboardAgentWorkspace` sets `MultiWorkspace.multi_agent_expanded = true`; it must not add `BackboardAgentWorkspacePage` as an editor tab.
- `MultiWorkspace` renders a top `Code Editor` / `Multi-Agent` switcher. The switcher is inset from the top-left so macOS traffic-light controls do not cover the tabs. `Multi-Agent` hides normal editor panes, side panels, bottom dock, and status bar until the user switches back to `Code Editor`.

### Page UI

`BackboardAgentWorkspacePage` includes two modes:

- Dashboard
- Configure

Dashboard:

- Header counters:
  - running
  - done
  - ready to apply
  - blocked
- Scrollable main dashboard with responsive cards grouped by batch when multiple tasks launch together.
- Persistent right task rail for writing one task per line, choosing mode/scope/type, and launching agents.
- Empty state points users to the right task rail.
- Selected agent details render in the right rail below the task composer.
- Bottom status strip with active agent count, changed file count, and system status.

Configure view:

- Single-line task prompt.
- Scope selector:
  - `Whole Project`
  - `Selected Files`
  - `Git Changes`
  - `Tests Only`
- Agent type selector:
  - `Build`
  - `Review`
  - `Test`
  - `Docs`
- `Run Agent` button.

Defaults:

- Scope: `Whole Project`
- Type: `Build`
- Mode: `Agent`

The Agent Workspace launcher also exposes mode selection:

- `Agent`: normal autonomous coding with command approval.
- `Ask`: planning/answering mode with mutating tools blocked by the bridge.
- `Manual`: file proposal style, with shell/subagent tasks blocked by the bridge.
- `Free`: autonomous mode where routine shell command approvals are bypassed by the bridge.

### Agent Workspace Runtime

Implemented in:

- `ide/zed/crates/agent_ui/src/agent_panel.rs`

New/public helper surface:

- `spawn_backboard_workspace_agent(...)`
- `activate_backboard_workspace_agent(...)`
- `stop_backboard_workspace_agent(...)`
- `retry_backboard_workspace_agent(...)`
- `review_backboard_workspace_agent(...)`
- `open_backboard_workspace_agent_worktree(...)`
- `apply_backboard_workspace_agent(...)`
- `dismiss_backboard_workspace_agent(...)`
- `backboard_agent_run_summaries(...)`

The workspace page asks `AgentPanel` to create a managed git worktree when a local git repository exists, then spawn a native Backboard conversation with:

- `Agent::NativeAgent`
- auto-submit initial content
- `work_dirs = PathList::new(&[agent_worktree_path])`
- a workspace-specific prompt
- source: `"agent_workspace"`

Worktree behavior:

- One submitted task line becomes one retained Backboard thread/session.
- One retained thread is one ACP session and one `ConversationView`; parallel coding should use separate retained threads rather than sharing a single chat conversation.
- Each Agent Workspace run creates a branch like `backboard/agent/<task-slug>-<id>`.
- The worktree path is resolved with the existing `git.worktree_directory` setting through `Repository::path_for_new_linked_worktree`.
- Multi-task git launches plan all worktree paths first, create all linked worktrees as one batch, roll back attempted worktrees if any creation fails, and only then start the agent threads.
- New worktrees are added to the project before their ACP sessions start, so `fs/write_text_file` and editor diffs resolve inside each agent worktree.
- `AgentPanel::update_thread_work_dirs` preserves per-agent work_dirs instead of replacing them with the project-wide default path list.

Git tree model:

- The user's open project remains the base workspace.
- Each git-backed Agent Workspace run creates a linked worktree from the same `base_commit`.
- The run's ACP session receives only that worktree path in `work_dirs`, so reads/writes and tool diffs happen inside the isolated worktree.
- The run metadata stores `base_workspace_path`, `worktree_path`, `branch_name`, `base_commit`, `batch_id`, `batch_index`, and `batch_size`.
- Apply compares the isolated worktree against `base_commit`, then applies that patch into the base workspace with `git apply --3way`.
- Worktrees are intentionally not deleted when cards are dismissed; they remain inspectable until cleaned up separately.

Non-git behavior:

- If there is no local repository, Agent Workspace starts one current-workspace Backboard thread instead of showing a git-required error.
- Current-workspace runs set `current_workspace: true`, show `Current workspace`, keep Review enabled, and disable Apply because changes are already live in the project.
- If multiple tasks are submitted without git, only the first starts; isolated parallel agents still require git worktrees.

The prompt says the spawned worker is a Backboard Agent Workspace worker and includes:

- agent type
- scope
- selected ACP mode
- whether the run is in an isolated worktree or the current workspace
- task
- instruction to stream concise progress
- permission to read/write files in its isolated agent worktree
- reminder to follow the selected approval mode
- reminder to preserve unrelated user changes and call out conflicts

### Retained Conversations

The page does not own the model connection itself. `AgentPanel` owns conversations.

Background workspace agents are inserted into:

- `AgentPanel.retained_threads`

That lets multiple sessions continue streaming even when not selected in the main chat panel.

Clicking a card calls:

- `backboard_workspace_conversation_view(thread_id, ...)`

That renders the corresponding retained conversation in the Agent Workspace page's in-page detail drawer. The normal right Backboard chat panel should stay hidden while the full Multi-Agent page is active.

### Card Summary Mapping

`backboard_agent_run_summaries()` converts ACP thread state into card summaries:

- Status:
  - `queued`
  - `running`
  - `done`
  - `blocked`
  - `error`
  - `canceled`
- Timeline:
  - plan entries
  - assistant progress/thought chunks
  - tool calls
  - terminal activity
  - file write/edit events
- Metrics:
  - progress estimate
  - cost if available
  - changed file count
  - touched paths
  - batch id/index/size
  - worktree/branch label
  - apply state
- Controls:
  - open detail
  - stop
  - review changes
  - apply to workspace
  - open worktree
  - retry
  - dismiss completed/error/canceled cards

Apply/review behavior:

- `Review` opens the existing `AgentDiffPane` for that agent thread.
- Before `Apply`, Agent Workspace refreshes changed paths from sibling worktrees in the same batch.
- If two unapplied runs in the same visible batch touch the same path, affected cards become `blocked` and Apply is disabled until the conflict is resolved by applying, dismissing, or manually changing one run.
- If there is no batch conflict, `Apply` generates `git diff --binary <base_commit>` from the agent worktree and applies it to the base workspace with `git apply --3way`.
- If apply fails, the card becomes `blocked` with the git apply error.
- Applied runs are marked `Applied`; dismissing an applied card removes the run metadata.
- Dismissing a card removes its run metadata from the Agent Workspace page. Linked worktree directories are not deleted by dismiss.

## Public Interfaces Added

Action:

- `agent::OpenBackboardAgentWorkspace`

Rust module:

- `agent_workspace_ui`
- `workspace::multi_workspace` owns the top `Code Editor` / `Multi-Agent` switcher and full-page expansion state.
- `agent_portal_window` remains in the tree as the older separate-window implementation, but the workspace action should open the full-page Multi-Agent mode.

Relevant file:

- `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`

AgentPanel helper methods:

- `spawn_backboard_workspace_agent`
- `activate_backboard_workspace_agent`
- `stop_backboard_workspace_agent`
- `retry_backboard_workspace_agent`
- `review_backboard_workspace_agent`
- `open_backboard_workspace_agent_worktree`
- `apply_backboard_workspace_agent`
- `dismiss_backboard_workspace_agent`
- `backboard_agent_run_summaries`

ACP bridge command:

- The Rust server launches `ide/zed/script/backboard-ide-acp.py`.
- The conceptual CLI entry remains `backboard ide acp`, but current IDE-owned launch path is the script above.

Env overrides:

- `BACKBOARD_IDE_ACP_PATH=/absolute/path/to/backboard-ide-acp.py`
- `BACKBOARD_CLI_ROOT=/absolute/path/to/cli`
- `BACKBOARD_CLI_PATH=/absolute/path/to/backboard`
- `BACKBOARD_IDE_PYTHON=/absolute/path/to/python`

## Important Ownership Notes

The CLI is source-of-truth for agent intelligence:

- tools
- MCP
- skills
- subagents
- semantic/codebase search
- Backboard API client
- model config

The IDE layer is source-of-truth for:

- ACP bridge behavior
- chat UX
- progress/timeline presentation
- command approval UI
- diff/tool rendering
- multi-agent workspace dashboard
- Zed/Backboard branding in the editor

Future work should keep that boundary unless the user changes direction.

## Known Caveats / Next Work

The Agent Workspace page is a v1 implementation:

- Git-backed projects use one git worktree per Agent Workspace run.
- Parallel agents write inside isolated agent worktrees when git is available.
- Multi-task launches are tracked as batches with shared batch metadata and grouped UI cards.
- For git-backed runs, the main workspace changes only when the user clicks `Apply`.
- Non-git projects run one Agent Workspace thread directly in the current workspace.
- Apply conflict detection first compares changed paths across visible sibling runs in the same batch, then still relies on `git apply --3way` as the final merge guard.
- Cards summarize native ACP thread state; the full source of truth remains the chat detail view.
- UI tests for fake ACP concurrent sessions are still a future task.
- Full packaging rebrand is deferred:
  - app binary/package names
  - bundle IDs
  - icons
  - installers
  - docs

The ACP bridge is still IDE-owned Python:

- It imports the CLI, but does not modify it.
- Some CLI tool shapes may need more adapters over time.
- File writes auto-apply because the user requested not to approve writes.
- Commands require approval in `agent` mode; `free` mode intentionally bypasses shell approval prompts.

## Build / Verification Commands

Run from:

- `ide/zed/`

Useful checks:

```sh
cargo check --locked -p agent_ui
cargo check --locked -p agent_ui -p agent_servers -p acp_thread
cargo test -p agent_ui --no-fail-fast workspace_agent
python3 -m py_compile script/backboard-ide-acp.py
```

On Erin's current macOS setup, the targeted `agent_ui` test command may fail before tests run if the Metal shader compiler is not installed. The observed local error says to run `xcodebuild -downloadComponent MetalToolchain`. `cargo check -p agent_ui` still passes without that component.

Formatting:

```sh
cargo fmt -p agent_ui
```

Before handing off, check that CLI is untouched:

```sh
git status --short cli
```

For this handoff document itself:

```sh
rg -n "^##|^###" BACKBOARD_IDE_HANDOFF.md
rg -n "POST /assistants|POST /threads/\\{thread_id\\}/messages|submit-tool-outputs|GET /models|usage_update|fs/write_text_file" BACKBOARD_IDE_HANDOFF.md
markdownlint BACKBOARD_IDE_HANDOFF.md
```

`markdownlint` is optional because it may not be installed in every local checkout. If it is missing, manually inspect table pipes, heading spacing, and fenced code blocks.

## Debugging / Maintenance Playbook

Use this table when you need to decide where to start. The deeper step-by-step guide follows immediately after it.

| Symptom | First files to inspect | Likely failure boundary |
|---------|------------------------|-------------------------|
| Missing API key, wrong env, or 401/402 on first turn | `cli/backboard_cli/state/config.py`, `cli/backboard_cli/api/validation.py`, `cli/backboard_cli/api/client.py` | Config/env/API-key validation |
| Bridge cannot launch or import CLI | `ide/zed/crates/agent_servers/src/backboard.rs`, `ide/zed/script/backboard-ide-acp.py` | Python path, CLI root, env vars, stdout protocol cleanliness |
| Model selector empty or config option missing | `backboard-ide-acp.py::model_state`, `backboard-ide-acp.py::config_options`, `ide/zed/crates/agent_servers/src/acp.rs`, `conversation_view.rs` | ACP model/config state transport |
| Tool permission card stuck | `backboard-ide-acp.py::_request_tool_permission`, `agent_servers/src/acp.rs::handle_request_permission`, `acp_thread.rs::request_tool_call_authorization`, `thread_view.rs` | JSON-RPC permission round trip |
| File edit did not appear in IDE diff | `backboard-ide-acp.py::_propose_file_change`, `backboard-ide-acp.py::_write_file_via_ide`, `agent_servers/src/acp.rs::handle_write_text_file`, `acp_thread.rs::write_text_file` | Bridge diff adapter or IDE-owned file write |
| Terminal card missing or output appears late | `backboard-ide-acp.py::_run_shell_tool`, `backboard-ide-acp.py::_run_shell_subprocess`, `agent_servers/src/acp.rs::handle_session_notification`, `acp_thread/src/terminal.rs` | `_meta.terminal_*` metadata or terminal provider buffering |
| Agent Workspace apply/review is wrong | `agent_panel.rs`, `agent_workspace_ui.rs`, `agent_diff.rs` | Worktree metadata, batch conflict detection, patch application |
| Context/cost/speed display wrong | `backboard-ide-acp.py::_usage`, `backboard-ide-acp.py::_speed_meta`, `acp_thread.rs::SpeedMetrics`, `thread_view.rs::render_token_usage` | ACP `usage_update` payload or UI footer rendering |
| Autocomplete not firing | `edit_prediction/src/backboard.rs`, edit-prediction registry/settings files | Separate Backboard API completion path, not ACP |

Maintenance rules:

- Keep `cli/` unchanged unless the user explicitly asks for CLI work.
- Prefer adding IDE adapters in `backboard-ide-acp.py` when a CLI tool needs special IDE rendering.
- Keep `fs/write_text_file` as the preferred write path for Backboard chat/Agent Workspace file edits.
- Do not expose private reasoning text; progress/thought chunks should stay summarized.
- Preserve retry guards that prevent duplicate streamed messages or duplicate tool-output submissions.
- Keep mode restrictions enforced before tools are sent to the backend.
- Treat Agent Workspace current-workspace runs and git-worktree runs differently; only worktree runs can be applied.

## Debugging Guide

If Backboard fails to launch:

1. Check `ide/zed/crates/agent_servers/src/backboard.rs`.
2. Confirm `bridge_script_path()` resolves to `ide/zed/script/backboard-ide-acp.py`.
3. Confirm Python exists or set `BACKBOARD_IDE_PYTHON`.
4. Confirm CLI root exists or set `BACKBOARD_CLI_ROOT`.
5. Confirm `~/.backboard/config.json` exists and contains valid Backboard config.

If chat is blank or stuck:

1. Check `ide/zed/script/backboard-ide-acp.py`.
2. Inspect bridge stderr/logs for `CLI_IMPORT_ERROR`.
3. Confirm JSON-RPC messages are only written to protocol stdout.
4. Check heartbeat/progress methods:
   - `_start_heartbeat`
   - `_heartbeat_loop`
   - `_emit_progress`
5. Check model state:
   - `model_state`
   - `session/set_model`

If the model popup does not open:

1. Check `ide/zed/crates/agent_ui/src/model_selector_popover.rs`.
2. Confirm the Backboard pill is rendering `ModelSelectorPopover`, not a custom `div`.
3. Check `ModelSelectorPopover::set_trigger_brand(...)`.
4. Check `conversation_view.rs` still creates `model_selector` when ACP `models` are present.
5. Check `agent_servers/src/acp.rs::config_state()` preserves `models` even when `configOptions` are present.

If file writes do not appear:

1. Check `_execute_tool_call`.
2. Check `_propose_file_change`.
3. Check `_write_file_via_ide`.
4. Check diff item shape from `_diff_item`.
5. Check `thread_view.rs` diff/tool rendering.

If commands do not ask approval outside `free` mode:

1. Check `SHELL_TOOLS`.
2. Check `_run_shell_tool`.
3. Check `_request_tool_permission`.
4. Check `conversation_view.rs` permission request routing.
5. Do not bypass command approval outside `free` mode.

If pricing/cost does not show:

1. Check `_usage()` and `_record_usage_cost()` in `ide/zed/script/backboard-ide-acp.py`.
2. Confirm model catalog loading calls `self.pricing.update_from_catalog(models)`.
3. Confirm `usage_update` includes `cost`.
4. Check `acp_thread` usage update handling stores `SessionCost`.
5. Check `thread_view.rs::render_token_usage()`.

If reading/searching entries are noisy again:

1. Check `ExplorationGroup` in `thread_view.rs`.
2. Check `render_entries()` still calls `exploration_group_at(...)`.
3. Confirm read/search/fetch tool kinds are still coming through as `ToolKind::Read`, `ToolKind::Search`, and `ToolKind::Fetch`.
4. Confirm progress-only assistant messages are identified by `is_thought_only_assistant_message(...)`.
5. Do not group edit/diff/terminal/approval entries.

If chat/editor turns feel slow while files are being written:

1. Check `ide/zed/crates/acp_thread/src/acp_thread.rs::write_text_file`.
2. Backboard ACP writes intentionally edit and save the buffer without forcing `project.format(...)` after every file write.
3. This avoids repeated Prettier discovery/server startup during multi-file agent work, especially in newly created or untrusted worktrees.
4. User-visible diffs, buffer edits, action log entries, and saves still flow through the editor-owned ACP write path.
5. If formatting is desired, prefer an explicit user-approved command or manual format after the agent turn instead of per-file automatic formatting.

If Backboard feels slow before the first model token:

1. Check `ide/zed/script/backboard-ide-acp.py`.
2. Per-turn timings are collected in `_speed_timings` / `_speed_totals` and emitted on `usage_update._meta.backboard_speed`.
3. The footer reads those metrics through `acp_thread::SpeedMetrics` and `thread_view.rs::render_token_usage()`.
4. Important timing keys: `runtime_load_ms`, `model_list_ms`, `assistant_create_ms`, `context_pack_ms`, `semantic_context_ms`, `first_token_ms`, `tool_batch_ms`, `shell_tools_ms`, `read_tools_ms`, `search_tools_ms`, `edit_tools_ms`, `other_tools_ms`, `slowest_tool`, `slowest_tool_ms`, `file_write_ms`, `command_wait_ms`, and `total_turn_ms`.
5. If `first_token_ms` is high while local timings are low, the delay is provider/model latency rather than IDE setup.

If every prompt appears to rebuild Backboard setup:

1. Check model list caching in `BackboardIdeSession.model_state()`.
2. Check tool definition caching in `_tool_definitions()`.
3. Check system prompt/skills caching in `_system_prompt()`.
4. MCP startup should remain lazy: `MCPManager.start_all()` registers cached schemas only; live MCP processes start on first tool use.

If the model keeps manually exploring too much:

1. Check `_prewarm_context()`, `_augment_prompt_with_context()`, and `_format_context_pack()`.
2. The IDE context pack includes lightweight file tree, stack/package hints, git status/diff stat, project rules, embedded editor context, and optional semantic hits.
3. Fast intensity keeps the context pack smaller and skips semantic search; Balanced/Deep may add indexed semantic hits when available.
4. Keep `CONTEXT_PACK_MAX_CHARS` bounded so context help does not become context drag.

If read/search tool batches are slow:

1. Check `_execute_tool_batch()` and `_execute_read_only_batch_parallel()`.
2. Contiguous groups of read/search/fetch/lint tools in `READ_ONLY_IDE_TOOLS` run concurrently, even when the same batch later contains a write or command.
3. Writes, shell commands, todos, memories, subagents, and MCP tools remain sequential/approval-safe.
4. Tool outputs are compressed by `_compress_tool_output()` before being returned to the model.

If shell commands are slow:

1. Check `_run_shell_tool()` and `_run_shell_subprocess()` in `ide/zed/script/backboard-ide-acp.py`.
2. Command timeout defaults are capped by command type: read-only commands are short, normal commands are bounded, install/check commands get more time, and dev-server commands get only a startup window.
3. Long-running dev-server commands such as `npm run dev`, `pnpm dev`, `vite`, `next dev`, and `python -m http.server` are stopped after the startup window so the agent does not sit on a never-ending process.
4. Dev-server detection also handles the common `cd <dir> && npm run dev ... &` shape, but the system prompt tells agents not to append `&`.
5. If a background child keeps stdout/stderr open after the shell exits, `_run_shell_subprocess()` cancels output pump tasks after a short drain window so the prompt lock can release.
6. Terminal output is batched with `TERMINAL_UPDATE_INTERVAL_SECONDS` before updating the UI, which keeps noisy commands from making the chat feel frozen.
7. Command approval wait time is tracked separately as `command_wait_ms`; do not confuse that with actual command runtime.

If the console shows Prettier `empty metadata for initial path` spam:

1. Check `ide/zed/crates/project/src/prettier_store.rs`.
2. That exact metadata-not-ready condition is downgraded to debug logging.
3. Other Prettier resolution failures should still log as errors.
4. If it still appears as an error, verify the message still contains `empty metadata for initial path`.
5. Also check whether the generated project worktree is trusted; untrusted worktrees delay language server/tooling startup.

If the console shows `Is a directory` or repeated JSON theme parse errors from `zed/src/main.rs`:

1. Check `ide/zed/crates/zed/src/main.rs::load_user_themes_in_background`.
2. Check `ide/zed/crates/zed/src/main.rs::watch_themes`.
3. Theme loading now skips directories before trying to load bytes.
4. Invalid custom theme JSON can still produce parse errors; the watcher should no longer try to parse folders as theme files.

If Agent Workspace crashes:

1. Check `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs` first. The older portal implementation lives in `ide/zed/crates/agent_ui/src/agent_portal_window.rs`.
2. Avoid reading `Workspace` while already inside a `Workspace` update.
3. In constructors called from a workspace action, use the provided `&Workspace` directly instead of `workspace.read(cx)`.
4. The recent crash fixed here was caused by re-reading `Workspace` in `BackboardAgentWorkspacePage::new`.

If Agent Workspace cards do not update:

1. Check `BackboardAgentWorkspacePage::summaries`.
2. Check the page observes `AgentPanel`.
3. Check `AgentPanel::conversation_views`.
4. Check `AgentPanel::backboard_agent_run_summaries`.
5. Confirm background agents are in `retained_threads`.

## Current Modified/Added IDE Files To Know

The current Backboard IDE work has touched or added these important files. This is a current-state map, not just a historical diff list.

### ACP Runtime And Backboard Agent Boundary

- `ide/zed/script/backboard-ide-acp.py`
  - Python JSON-RPC stdio bridge launched by the native Rust agent server.
  - Imports the existing CLI engine from `cli/backboard_cli` and adapts CLI/model/tool events into ACP session updates.
  - Owns IDE-specific behavior for modes, `Intensity`, model state, usage/cost/speed updates, progress heartbeat, safe command auto-approval, free-mode shell approval bypass, website quality prompts, context prewarm, read/search batching, command timeouts, and file diff emission.

- `ide/zed/crates/agent_servers/src/backboard.rs`
  - Rust `AgentServer` implementation for the native Backboard agent.
  - Resolves and launches `script/backboard-ide-acp.py`, passes IDE/CLI/Python env overrides, exposes Backboard as the visible native agent, and supports Agent Workspace sessions with alternate default ACP modes.

- `ide/zed/crates/agent_servers/src/acp.rs`
  - Shared ACP connection/session plumbing used by Backboard and other ACP agents.
  - Backboard-relevant changes preserve model selection when `configOptions` are present and carry config state, progress, permissions, and metrics through the native ACP layer.

- `ide/zed/crates/acp_thread/src/acp_thread.rs`
  - Stores ACP thread state, usage/cost/speed metrics, plans, tool events, permissions, and file write effects.
  - Backboard file writes intentionally update/save editor buffers without forcing project formatting after every write, which avoids slow Prettier startup during multi-file agent runs.

### Native Chat, Tools, And Model UI

- `ide/zed/crates/agent_ui/src/conversation_view.rs`
  - Owns the active native agent conversation view, connection setup, permissions, model/config option state, active model display, and Backboard composer placeholder.
  - Routes Backboard permission requests and keeps the left model pill tied to the real `ModelSelectorPopover`.

- `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
  - Renders assistant/user messages, Backboard progress notes, tool calls, terminal cards, diff cards, permission buttons, token/context/cost/speed footer, and collapsed write/edit cards.
  - Contains exploration grouping (`ExplorationGroup`) so read/search/fetch/thought-only runs collapse into expandable summary rows.

- `ide/zed/crates/agent_ui/src/model_selector_popover.rs`
  - Native model selector popover used by the composer.
  - Backboard branding is applied through `set_trigger_brand(...)`; do not replace the trigger with a custom clickable `div`, because GPUI popover anchoring depends on the rendered trigger.

- `ide/zed/crates/agent_ui/src/config_options.rs`
  - Renders ACP config option controls such as Backboard `Intensity`.
  - The bridge provides `backboard_intensity`; the Rust UI labels it as Fast, Balanced, or Deep under the thought-level category.

### Agent Workspace And Retained Runtime

- `ide/zed/crates/agent_ui/src/agent_panel.rs`
  - Owns active and retained Backboard conversations.
  - Provides the Agent Workspace helper surface: spawn, activate, stop, retry, review, open worktree, apply, dismiss, and summarize Backboard workspace agents.
  - Creates isolated git worktrees for git-backed runs, preserves per-agent `work_dirs`, tracks batch/apply metadata, maps ACP thread state into card summaries, and keeps non-git runs in the current workspace with Apply disabled.

- `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
  - Current full-page Multi-Agent workspace page.
  - Renders task input, mode/scope/type controls, dashboard counters, grouped cards, card controls, selected run details, retained conversation detail views, and status strips.
  - This is the preferred Agent Workspace UI. It is shown by expanding `MultiWorkspace`, not by opening a normal editor tab.

- `ide/zed/crates/agent_ui/src/agent_portal_window.rs`
  - Older separate-window Backboard Agent Portal implementation.
  - Still useful as reference for card rendering and launcher behavior, but current product flow should prefer `BackboardAgentWorkspacePage`.

- `ide/zed/crates/agent_ui/src/agent_ui.rs`
  - Registers Backboard agent actions and exports `BackboardAgentWorkspacePage`.
  - `agent::OpenBackboardAgentWorkspace` now expands the full-page Multi-Agent workspace.

- `ide/zed/crates/workspace/src/multi_workspace.rs`
  - Owns `InterfaceMode::{Simple, Expert}` and `multi_agent_expanded`.
  - Renders Simple mode, normal Expert/editor mode, and the full-page Multi-Agent surface; hides editor panes/side panels/dock/status while Multi-Agent is active.

### Simple/Expert Mode And Beginner UI

- `ide/zed/crates/beginner_ui/src/beginner_ui.rs`
  - Public exports and beginner-mode actions/events.

- `ide/zed/crates/beginner_ui/src/beginner_workspace.rs`
  - Simple mode's chat-first workspace, landing/active-project states, and switch-to-Expert event.

- `ide/zed/crates/beginner_ui/src/beginner_chat_feed.rs`
  - Beginner chat feed surface used by Simple mode.

- `ide/zed/crates/beginner_ui/src/file_changes_panel.rs`
  - Beginner-oriented file change display component.

- `ide/zed/crates/onboarding/src/onboarding.rs`
  - Backboard onboarding flow, including experience-level selection that maps Beginner to Simple mode and Developer/Power to Expert mode.

- `ide/zed/crates/onboarding/src/basics_page.rs`
  - Backboard-branded onboarding basics page, telemetry/trust choices, and dashboard/API-key entry point.

- `ide/zed/crates/settings_ui/src/page_data.rs`
  - Settings entries for Backboard Studio, including the Simple/Expert mode toggle and Backboard-branded settings text.

- `ide/zed/crates/title_bar/src/title_bar.rs`
  - Top bar mode switcher and Multi-Agent/Expert/Simple controls.
  - Also contains residual collab/update UI paths that were rebranded or disconnected from Zed services.

### Inline Autocomplete / Edit Predictions

- `ide/zed/crates/edit_prediction/src/backboard.rs`
  - Backboard inline autocomplete provider.
  - Loads BYOK API key from keychain or `BACKBOARD_API_KEY`, calls `https://app.backboard.io/api`, creates/reuses a completion assistant, creates a fresh thread per completion, sends the cursor prompt, strips code fences, and returns pure cursor insertion edits.

- `ide/zed/crates/edit_prediction/src/edit_prediction.rs`
  - Adds `EditPredictionModel::Backboard`, stores `BackboardCompletions` on `EditPredictionStore`, and dispatches Backboard prediction requests.
  - Keeps Backboard edits as insertions at the cursor; do not reintroduce Zeta/Mercury diff-based replacement for Backboard completions.

- `ide/zed/crates/zed/src/zed/edit_prediction_registry.rs`
  - Routes serialized settings provider `EditPredictionProvider::Zed` to `EditPredictionModel::Backboard`.
  - Loads the Backboard API token and presents Backboard as the active edit prediction model.

- `ide/zed/crates/settings_content/src/language.rs`
  - Adds serialized settings content for `edit_predictions.backboard.provider` and `edit_predictions.backboard.model`.

- `ide/zed/crates/language/src/language_settings.rs`
  - Adds runtime `BackboardSettings` defaults: provider `openrouter`, model `deepseek/deepseek-chat`.

- `ide/zed/crates/settings_ui/src/pages/edit_prediction_provider_setup.rs`
  - Settings UI for edit prediction credentials.
  - Currently stripped to the Backboard AI API key card and links users to `https://app.backboard.io/dashboard/api-keys`.

### Rebrand, App Shell, And Zed Service Removal

- `ide/zed/crates/zed/src/main.rs`
  - Backboard-branded app startup surfaces and known theme-loading fix that skips directories before parsing custom theme JSON.

- `ide/zed/crates/zed/src/zed.rs`
  - Main app wiring for Simple/Expert selection, BeginnerWorkspace creation, and BackboardAgentWorkspacePage creation.

- `ide/zed/crates/zed/src/zed/app_menus.rs`
  - macOS/app menu rebrand and removal/replacement of Zed-specific menu entries.

- `ide/zed/crates/paths/src/paths.rs`
  - App naming/path identity adjusted for Backboard Studio.

- `ide/zed/crates/feedback/src/feedback.rs`
  - Zed feedback/support flows removed or replaced with Backboard destinations.

- `ide/zed/crates/title_bar/src/collab.rs`
  - Zed collaboration UI/infrastructure mostly stripped or disabled for Backboard Studio.

- `ide/zed/assets/keymaps/default-linux.json`, `ide/zed/assets/keymaps/default-macos.json`, `ide/zed/assets/keymaps/default-windows.json`
  - Zed collaboration keybindings removed.

### Older Backboard API/UI Crates And Reference Notes

- `ide/zed/crates/backboard/src/backboard.rs`
  - Rust Backboard API/config client crate from the early integration.
  - Still relevant for API/config concepts, though chat intelligence currently flows through the Python ACP bridge and CLI runtime.

- `ide/zed/crates/backboard_ui/src/backboard_ui.rs`
  - Older thin Backboard UI panel.
  - Useful historical reference, but native `agent_ui` + ACP is now the primary chat surface.

- `backboard_studio_features.txt`
  - Product/feature planning notes for Backboard Studio modes, pricing, built-in AI, and agent experiences.

- `backboard_studio_mode_features.txt`
  - Product/layout planning notes for Chat, Code, and Agent Workspace modes.

- `ide/zed/testcase.md`
  - Local test case notes added with the progress/metrics/cwd fallback work.

Preserve unrelated dirty files, especially existing `ide/zed/Cargo.lock` changes, unless the user explicitly asks to reset or clean them. Do not edit `cli/` for IDE runtime/UI work unless the user explicitly approves it.

## 2026-05-15 Follow-Up (Session Persistence + Chat Entry)

This follow-up documents fixes applied after users reported:

- IDE context blobs showing in visible restored chat history.
- Multiple projects/chats restoring incorrectly or opening as fresh chats.
- Some chats disappearing after restart despite successful in-session runs.
- Chat button routing users to the Agent Workspace page instead of opening the chat list/sidebar.

### Python ACP Bridge (`ide/zed/script/backboard-ide-acp.py`)

- Added visible-history sanitization for prompt augmentation payloads:
  - strips `<backboard_ide_context>...</backboard_ide_context>` before replaying history into UI chunks.
- Hardened stream handling:
  - catches stream exceptions and emits a visible interruption message instead of hanging on indefinite "Thinking…".
- Limited replay payload volume:
  - added `HISTORY_REPLAY_MAX_MESSAGES` cap for history replay on load.
- Fixed workspace/session binding behavior:
  - when `session/load` switches to a different `cwd`, resets assistant/thread/replay caches to avoid cross-workspace bleed.
  - restore path supports workspace-keyed records and legacy records.
  - `session/new` reverted to creating a new session id (do not collapse multiple chats into one workspace singleton).
  - `session/list` reverted to listing all sessions (no workspace dedupe), preserving multi-chat identity.
- Added load diagnostics:
  - `session_load_state`
  - `session_load_fresh_thread`
  - `session_load_replay_done`
  - `session_replay_fetch_failed`

### Thread Metadata / Archive Behavior (`ide/zed/crates/agent_ui/src/thread_metadata_store.rs`)

Root cause discovered in the real Backboard Studio DB (`~/Library/Application Support/Backboard Studio/db/0-dev/db.sqlite`):

- many valid Backboard chats were present in `sidebar_threads` but marked `archived=1`, which made them appear missing after restart.

Fixes:

- Prevent default auto-archive for Backboard ACP sessions when `worktree_paths` is empty:
  - for `session_id` starting with `backboard-`, default archived state is forced non-archived.
- If an existing Backboard session row is archived, metadata refresh now unarchives it.
- Added one-time startup rescue migration:
  - key: `thread-metadata-backboard-archive-rescue`
  - action: unarchive archived rows where `session_id LIKE 'backboard-%'`.
- Added DB helper:
  - `ThreadMetadataDb::unarchive_backboard_sessions()`.

### Chat Button UX Change (`ide/zed/crates/agent_ui/src/agent_ui.rs`)

- `OpenBackboardAgentWorkspace` action now opens/focuses the sidebar thread switcher instead of forcing full-page multi-agent workspace.
  - calls `multi_workspace.open_sidebar(cx)`.
  - dispatches `ToggleThreadSwitcher { select_last: false }`.

### Observability Note

- Backboard ACP diagnostics write to `~/.backboard/logs/ide-agent.log`.
- UI thread list persistence/visibility is backed by `sidebar_threads` in:
  - `~/Library/Application Support/Backboard Studio/db/0-dev/db.sqlite` (active data in this environment).
