# IDE Folder Guide

This guide explains the `ide/` tree in this checkout. The IDE is mostly an imported Zed workspace under `ide/zed/`, with Backboard Studio changes layered on top for branding, native agent chat, multi-agent workspace flows, inline completions, packaging, and beginner/simple mode.

Use this as an orientation map before changing code. It explains folders by responsibility, not every individual source file.

## High-Level Map

| Folder | What it does |
| --- | --- |
| `ide/docs/` | Backboard-specific notes, handoff docs, packaging notes, experiments, and this folder guide. |
| `ide/zed/` | The main Rust IDE workspace. This is the upstream Zed codebase plus Backboard Studio modifications. |
| `ide/zed/crates/` | Most application code. Each subfolder is a Rust crate for one feature, platform layer, UI surface, service, or utility. |
| `ide/zed/assets/` | Runtime assets bundled into the editor: fonts, icons, images, keymaps, settings, sounds, themes, and prompts. |
| `ide/zed/script/` | Developer, CI, release, packaging, license, and Backboard bridge scripts. |
| `ide/zed/docs/` | Upstream-style product and developer documentation for the editor. |
| `ide/zed/extensions/` | Built-in and test extensions used by the extension system. |
| `ide/zed/tooling/` | Rust workspace tooling crates for compliance, performance, and repo automation. |
| `ide/zed/target/` | Local Rust build output. This can be huge and should not be treated as source. |

## Backboard-Specific Source Of Truth

These are the folders and files to inspect first for Backboard Studio behavior.

| Area | Main folder or file | Purpose |
| --- | --- | --- |
| Backboard handoff docs | `ide/docs/BACKBOARD_IDE_HANDOFF.md` | Implementation history and source-of-truth map for the IDE integration. |
| Packaging notes | `ide/docs/BACKBOARD_IDE_PACKAGING.md` | How the app is built, why `target/` is large, and what should ship. |
| Embedded CLI plan | `ide/docs/BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md` | Plan for making the IDE work without a globally installed CLI. |
| Python ACP bridge | `ide/zed/script/backboard-ide-acp.py` | JSON-RPC stdio bridge between the Rust IDE and Backboard CLI/runtime behavior. |
| Rust Backboard agent launcher | `ide/zed/crates/agent_servers/src/backboard.rs` | Launches and communicates with the Backboard ACP bridge. |
| ACP transport/client code | `ide/zed/crates/agent_servers/src/acp.rs` | Generic Agent Client Protocol session plumbing. |
| ACP conversation model | `ide/zed/crates/acp_thread/` | Stores agent messages, tool calls, diffs, terminal output, permissions, usage, and progress. |
| Native agent UI | `ide/zed/crates/agent_ui/` | Chat panel, conversation view, agent workspace, Backboard model/config UI, and thread rendering. |
| Beginner/simple mode | `ide/zed/crates/beginner_ui/` | Chat-first beginner workspace, simple mode feed, file changes panel, and preview support. |
| Workspace shell | `ide/zed/crates/workspace/` | Panes, docks, workspace state, welcome screen, and multi-agent full-page shell. |
| App entrypoint | `ide/zed/crates/zed/` | Main binary, app boot, menus, registries, platform wiring, and Backboard Studio app identity. |
| Legacy Backboard client | `ide/zed/crates/backboard/` | Rust HTTP/config client mirror for Backboard APIs. |
| Legacy Backboard panel | `ide/zed/crates/backboard_ui/` | Older standalone Backboard panel. Current main path is ACP chat through `agent_ui`. |
| Inline completions | `ide/zed/crates/edit_prediction/` | Edit prediction providers, including Backboard API routing in this branch. |

## `ide/docs/`

| File or folder | What it does |
| --- | --- |
| `AGItestcase.md` | Local test case notes. |
| `BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md` | Phase plan for bundling the CLI runtime into the IDE package. |
| `BACKBOARD_IDE_HANDOFF.md` | Main handoff document describing what changed in the Zed import and where future agents should work. |
| `BACKBOARD_IDE_PACKAGING.md` | Build, bundle, DMG, target size, and packaging guidance. |
| `erin.md` | Local note file currently present in the docs folder. |
| `testcase*.md` | Local test case and scratch scenario notes. |

## `ide/zed/` Root

| Folder or file | What it does |
| --- | --- |
| `.cargo/` | Cargo configuration for the Rust workspace. |
| `.cloudflare/` | Cloudflare-related docs proxy and website asset deployment support. |
| `.config/` | Repo-level tool configuration used by development or automation. |
| `.factory/` | Agent/factory prompts and skills used for automated development workflows. |
| `.github/` | GitHub issue templates, discussion templates, actions, and workflows. |
| `.zed/` | Editor-specific workspace configuration. |
| `assets/` | Bundled runtime assets used by the IDE. |
| `ci/` | CI helper configuration. |
| `crates/` | Rust workspace members. This is the bulk of application source. |
| `docs/` | Editor documentation site content and theme files. |
| `extensions/` | Built-in sample/test extensions and extension workflows. |
| `legal/` | Legal, license, and compliance material. |
| `nix/` | Nix development and build support. |
| `script/` | Shell, Python, PowerShell, JS, and release scripts. |
| `target/` | Cargo build artifacts. Large, generated, and safe to ignore for source reading. |
| `tooling/` | Rust tooling crates that support compliance, perf, and custom tasks. |
| `Cargo.toml` | Workspace manifest. Lists all crates, extensions, and tooling members. |
| `Cargo.lock` | Locked dependency graph for reproducible Rust builds. |
| `README.md` | Upstream Zed overview and development links. |
| `Dockerfile-*`, `compose.yml`, `Procfile*` | Container, service, and local process definitions, mostly inherited from upstream Zed infrastructure. |
| `flake.nix`, `default.nix`, `shell.nix` | Nix development/build entrypoints. |
| `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml` | Rust toolchain, formatting, and lint configuration. |
| `LICENSE-*`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` | Project governance and licensing files. |

## `ide/zed/assets/`

| Folder | What it does |
| --- | --- |
| `badge/` | Badge metadata/assets. |
| `fonts/` | Bundled fonts, including `ibm-plex-sans` and `lilex`. |
| `icons/` | Product and file icons, including `file_icons` and icon knockout assets. |
| `images/` | Image assets used by onboarding, welcome, branding, or docs surfaces. |
| `keymaps/` | Default keybindings split by platform folders such as `linux` and `macos`. |
| `prompts/` | Built-in prompt text used by agent or assistant experiences. |
| `settings/` | Default settings JSON and related bundled configuration. |
| `sounds/` | Audio assets used by UI feedback or collaboration features. |
| `themes/` | Bundled syntax/UI themes, including `ayu`, `gruvbox`, and `one`. |

## `ide/zed/docs/`

| Folder | What it does |
| --- | --- |
| `.conventions/` | Documentation conventions, including brand voice guidance. |
| `.doc-examples/` | Example docs content used as references. |
| `src/` | Documentation source. It is organized into `ai`, `business`, `collaboration`, `development`, `extensions`, `languages`, `migrate`, and `reference`. |
| `theme/` | Documentation site theme assets, including CSS and fonts. |

## `ide/zed/extensions/`

| Folder | What it does |
| --- | --- |
| `glsl/` | Built-in GLSL extension with language grammar/config files and Rust extension code. |
| `html/` | Built-in HTML extension with language grammar/config files and Rust extension code. |
| `proto/` | Protocol Buffers extension, including language server support under `src/language_servers`. |
| `test-extension/` | Test extension used to exercise extension APIs. |
| `workflows/` | Shared extension workflow support files. |

## `ide/zed/script/`

| Folder or file group | What it does |
| --- | --- |
| `backboard-ide-acp.py` | Backboard-specific Python bridge used by the native agent integration. |
| `bundle-*`, `install-*`, `upload-*`, `trigger-release` | Platform packaging and release scripts. |
| `bootstrap`, `bootstrap.ps1` | Development bootstrap scripts. |
| `cargo`, `clippy`, `prettier`, `shellcheck-scripts` | Wrapper scripts for common developer checks. |
| `check-*`, `generate-*` | License, docs, links, actions, schemas, terms, and metadata generation/check scripts. |
| `danger/` | Danger JS automation for PR checks. |
| `flatpak/` | Linux Flatpak bundling support. |
| `licenses/` | License templates and cargo-about license policy. |
| `terms/` | Generated or maintained terms assets. |
| `update_top_ranking_issues/` | Python project for issue-ranking automation. |
| `run-background-agent-mvp-local`, `run-unit-evals`, `eval*` | Local agent/evaluation helper scripts. |
| `remote-server`, `zed-local`, `debug-cli` | Local runtime and debugging helpers. |

## `ide/zed/nix/`, `ci/`, `tooling/`

| Folder | What it does |
| --- | --- |
| `nix/dev/` | Nix development shell and environment pieces. |
| `nix/livekit-libwebrtc/` | Nix packaging/build support for LiveKit WebRTC dependencies. |
| `nix/modules/` | Reusable Nix modules. |
| `ci/` | CI helper area. In this checkout it is a small support directory. |
| `tooling/compliance/` | Rust tooling for compliance checks. |
| `tooling/perf/` | Rust tooling for performance measurement and automation. |
| `tooling/xtask/` | Custom Rust task runner and task definitions. |

## `ide/zed/target/`

`target/` is Cargo output, not source. It contains compiled dependencies, binaries, incremental caches, debug symbols, release artifacts, generated bridges, and packaged app outputs. The important subfolders currently visible are:

| Folder | What it does |
| --- | --- |
| `aarch64-apple-darwin/` | Build artifacts for Apple Silicon macOS targets. |
| `cxxbridge/` | Generated C++ bridge artifacts from Rust/C++ interop. |
| `debug/` | Debug build output. This is usually the largest folder. |
| `release/` | Release build output. |

## Common Rust Crate Layout

Most folders under `ide/zed/crates/` follow the same Rust crate pattern:

| Subfolder or file | What it usually means |
| --- | --- |
| `Cargo.toml` | The crate manifest: name, dependencies, features, and library/bin targets. |
| `src/` | The crate's production Rust source. |
| `tests/` | Integration tests. |
| `benches/` | Benchmarks. |
| `examples/` | Example binaries or demos. |
| `migrations/`, `migrations.sqlite/` | Database schema migration files, mostly for service/backend crates. |
| `docs/` | Crate-specific developer notes. |
| `wit/` | WebAssembly Interface Type definitions, used by extension API crates. |
| `k8s/`, `seed/` | Deployment or database seed material, mostly for collaboration/server crates. |

## Crate Groups

### App Shell And Workspace

| Crate folder | What it does |
| --- | --- |
| `zed` | Main app binary. Wires registries, menus, platform services, app startup, and Backboard Studio identity. |
| `workspace` | Core workspace shell: panes, docks, tabs, modal layers, welcome screen, persistence, status bar, and multi-workspace shell. |
| `project` | Project model: worktrees, buffers, language services, search context, and editor-facing project state. |
| `worktree` | Filesystem tree abstraction for project roots. |
| `session` | Persisted editor session state. |
| `client` | Cloud/client state and service access used by app-level features. |
| `db` | Local database layer used by settings, sessions, and feature storage. |
| `settings`, `settings_content`, `settings_json`, `settings_macros`, `settings_ui`, `settings_profile_selector` | Settings data model, JSON parsing, generated schemas/macros, settings pages, and profile selection UI. |
| `paths` | Standard filesystem paths and app identity paths. |
| `release_channel` | Stable/preview/nightly channel information. |
| `zed_actions` | Shared action definitions used by menus, keymaps, and command dispatch. |
| `zed_credentials_provider` | Credential access for Zed/Backboard-integrated services. |
| `zed_env_vars` | Environment variable handling for the app. |

### Backboard And Agent Features

| Crate folder | What it does |
| --- | --- |
| `agent` | Native agent runtime model, thread store, tools, templates, tests, and built-in agent behavior. |
| `agent_servers` | Agent server registry and launchers, including ACP and Backboard server integration. |
| `agent_settings` | Agent-related settings, profiles, prompts, model defaults, and config options. |
| `agent_ui` | Main agent chat UI, conversation renderer, model selector, profile/config UI, inline assistant, terminal codegen, thread archive, and multi-agent workspace UI. |
| `acp_thread` | Agent Client Protocol thread model and transport-facing conversation state. |
| `acp_tools` | Tool definitions/helpers for ACP agent integrations. |
| `backboard` | Rust Backboard API/config client. |
| `backboard_ui` | Older standalone Backboard panel UI. |
| `ai_onboarding` | AI setup and onboarding surfaces. |
| `beginner_ui` | Beginner/simple-mode chat workspace, file change panel, and preview UI. |
| `context_server` | Context-server transport and registry integration for agent tools. |
| `prompt_store` | Stored prompts and prompt history. |
| `rules_library` | Rules and guidance material used by agent workflows. |
| `ui_prompt` | Prompt-oriented UI components. |
| `zeta_prompt` | Prompt material for Zed/Zeta-style assistant behavior. |
| `opencode` | OpenCode integration/provider support. |

### Language Models And Providers

| Crate folder | What it does |
| --- | --- |
| `language_model`, `language_model_core`, `language_models`, `language_models_cloud` | Model abstractions, provider registry, cloud model support, and shared language model types. |
| `anthropic`, `bedrock`, `codestral`, `deepseek`, `google_ai`, `lmstudio`, `mistral`, `ollama`, `open_ai`, `open_router`, `x_ai` | Provider-specific adapters for chat, completions, or model metadata. |
| `copilot`, `copilot_chat`, `copilot_ui` | GitHub Copilot integration, chat behavior, and Copilot-specific UI. |
| `cloud_llm_client` | Client for cloud LLM services. |
| `edit_prediction`, `edit_prediction_cli`, `edit_prediction_context`, `edit_prediction_metrics`, `edit_prediction_types`, `edit_prediction_ui` | Inline completion/edit prediction logic, CLI/eval tools, context building, metrics, shared types, and UI. |
| `eval_cli`, `eval_utils` | Evaluation command-line tools and shared evaluation utilities. |

### Editor, Buffers, Text, And UI

| Crate folder | What it does |
| --- | --- |
| `editor` | Core text editor implementation, display map, scrolling, inlays, git decorations, and editor tests. |
| `multi_buffer` | Editing across multiple excerpts/buffers, used by search, agent context, and diff views. |
| `text` | Text primitives and operations. |
| `rope` | Rope data structure for efficient text storage/editing. |
| `sum_tree` | Tree structure used for indexed aggregation over text/layout data. |
| `buffer_diff`, `streaming_diff` | Diff calculation and streaming diff display support. |
| `diagnostics` | Compiler/LSP diagnostic model and display support. |
| `breadcrumbs` | Breadcrumb UI for symbol/path context. |
| `outline`, `outline_panel` | Symbol outline extraction and outline panel UI. |
| `go_to_line` | Go-to-line UI and command behavior. |
| `file_finder` | Quick-open file finder. |
| `picker`, `fuzzy`, `fuzzy_nucleo` | Picker controls and fuzzy matching engines. |
| `command_palette`, `command_palette_hooks` | Command palette UI and extension points. |
| `keymap_editor`, `which_key` | Keybinding editing and keybinding discovery UI. |
| `vim`, `vim_mode_setting` | Vim mode behavior and settings. |
| `snippet`, `snippet_provider`, `snippets_ui` | Snippet parsing, providers, and UI. |
| `prettier` | Prettier integration for formatting. |
| `language_selector`, `encoding_selector`, `line_ending_selector`, `toolchain_selector` | Selector UI for language mode, file encoding, line endings, and toolchains. |

### Languages, LSP, Debugging, And Extensions

| Crate folder | What it does |
| --- | --- |
| `language`, `language_core`, `language_extension`, `language_tools`, `languages`, `grammars` | Language configuration, syntax grammars, language tooling, and extension-provided language support. |
| `lsp` | Language Server Protocol client and message handling. |
| `dap`, `dap_adapters`, `debug_adapter_extension`, `debugger_tools`, `debugger_ui` | Debug Adapter Protocol model, adapters, extension support, debugger tools, and debugger UI. |
| `extension`, `extension_api`, `extension_cli`, `extension_host`, `extensions_ui` | Extension manifest/runtime model, WIT API, CLI, WASM host, and extension management UI. |
| `node_runtime` | Node runtime management used by language servers/extensions/tooling. |
| `json_schema_store`, `schema_generator` | JSON schema loading/generation for settings and language tooling. |
| `docs_preprocessor` | Documentation preprocessing helper crate. |

### Git, Filesystem, Remote, And Search

| Crate folder | What it does |
| --- | --- |
| `fs` | Filesystem abstraction and tests. |
| `watch` | Filesystem watching. |
| `git`, `git_graph`, `git_hosting_providers`, `git_ui` | Git backend, graph data, hosting-provider support, and Git UI. |
| `project_panel` | File tree/project panel UI. |
| `project_symbols` | Workspace/project symbol search. |
| `recent_projects` | Recent project tracking and UI. |
| `remote`, `remote_connection`, `remote_server` | Remote development model, connection handling, and server support. |
| `search` | Workspace and buffer search. |
| `dev_container` | Development container integration. |
| `open_path_prompt` | Prompt for opening files/folders/paths. |
| `explorer_command_injector` | Windows Explorer integration helper. |

### Terminal, Tasks, Shell, And Process Utilities

| Crate folder | What it does |
| --- | --- |
| `terminal` | Terminal backend integration and terminal data model. |
| `terminal_view` | Terminal UI surface. |
| `task`, `tasks_ui` | Task model, task execution, and task UI. |
| `shell_command_parser` | Parses shell commands. |
| `cli`, `install_cli`, `askpass` | Command-line integration, CLI installer, and askpass credential helper. |
| `env_var` | Environment variable handling. |
| `scheduler` | Scheduling utilities. |
| `repl` | REPL integration. |

### GPUI, Platform, And Components

| Crate folder | What it does |
| --- | --- |
| `gpui` | Main GPUI application framework used by Zed/Backboard Studio. |
| `gpui_platform` | Platform abstraction layer for GPUI. |
| `gpui_macos`, `gpui_linux`, `gpui_windows`, `gpui_web`, `gpui_wgpu` | Platform and renderer-specific GPUI implementations. |
| `gpui_macros`, `gpui_tokio`, `gpui_util`, `gpui_shared_string` | GPUI macros, Tokio integration, utilities, and shared string type. |
| `ui`, `ui_input`, `ui_macros` | Shared UI components, inputs, and UI helper macros. |
| `component`, `component_preview` | Reusable component library and preview tooling. |
| `activity_indicator`, `action_log`, `panel`, `sidebar`, `menu`, `title_bar`, `platform_title_bar`, `tab_switcher` | Common UI surfaces and containers. |
| `icons`, `file_icons` | Icon definitions and file icon mapping. |
| `image_viewer`, `csv_preview`, `markdown`, `markdown_preview`, `svg_preview`, `html_to_markdown` | Viewers, previews, parsers, and renderers for common content types. |
| `theme`, `theme_extension`, `theme_importer`, `theme_selector`, `theme_settings`, `syntax_theme` | Theme data, extension themes, importing, selection, settings, and syntax theme support. |
| `media`, `audio` | Media and audio support. |
| `input_latency_ui`, `inspector_ui`, `miniprofiler_ui` | Diagnostics/performance inspection UI. |
| `notifications`, `feedback`, `onboarding`, `language_onboarding` | User-facing flows for notifications, feedback, first-run onboarding, and language setup. |

### Networking, Cloud, Collaboration, And Services

| Crate folder | What it does |
| --- | --- |
| `http_client`, `http_client_tls`, `reqwest_client`, `aws_http_client`, `net` | HTTP/networking layers and TLS/provider-specific clients. |
| `cloud_api_client`, `cloud_api_types` | Cloud API client and shared API types. |
| `collab`, `collab_ui` | Collaboration backend/service code and collaboration UI. Backboard changes intentionally reduce reliance on Zed collaboration services. |
| `channel` | Channel/store abstractions used by collaboration or app messaging. |
| `call`, `livekit_api`, `livekit_client` | Calling/collaboration media support through LiveKit. |
| `rpc`, `proto` | RPC transport and generated/shared protocol definitions. |
| `telemetry`, `telemetry_events` | Telemetry collection and event definitions. |
| `feature_flags`, `feature_flags_macros` | Feature flag model and helper macros. |
| `auto_update`, `auto_update_helper`, `auto_update_ui` | Auto-update logic, helper binary, and update UI. |
| `crashes` | Crash reporting support. |
| `credentials_provider` | General credential provider support. |
| `web_search`, `web_search_providers` | Web search abstraction and provider implementations. |

### Data, Utility, Benchmark, And Support Crates

| Crate folder | What it does |
| --- | --- |
| `assets` | Rust access to bundled assets. |
| `collections` | Shared collection utilities. |
| `clock`, `time_format` | Time abstractions and formatting. |
| `util`, `util_macros` | General utilities and macros. |
| `refineable`, `refineable/derive_refineable` | Refineable data structures and derive macro. |
| `sqlez`, `sqlez_macros` | SQLite helper layer and macros. |
| `migrator` | Database migration helper. |
| `nc` | Native/cross-platform helper crate inherited from upstream. |
| `denoise` | Denoising/model support crate with examples and model assets. |
| `journal` | Journal/log-like feature support. |
| `zlog`, `zlog_settings` | Logging implementation and settings. |
| `ztracing`, `ztracing_macro`, `etw_tracing` | Tracing/profiling support and platform tracing macros. |
| `system_specs` | System information/spec collection. |
| `windows_resources` | Windows packaging/resource assets. |
| `editor_benchmarks`, `fs_benchmarks`, `project_benchmarks`, `worktree_benchmarks` | Benchmark crates for editor, filesystem, project, and worktree behavior. |

## Crates With Notable Subfolders

| Folder | Subfolders | What they do |
| --- | --- | --- |
| `agent/src/` | `templates`, `tests`, `tools` | Built-in agent prompt templates, tests, and tool implementations. |
| `agent_ui/src/` | `agent_configuration`, `conversation_view`, `ui` | Agent settings/config modals, main conversation renderer, and reusable agent UI widgets. |
| `audio/src/` | `audio_pipeline` | Audio pipeline implementation. |
| `call/src/` | `call_impl` | Calling implementation details. |
| `channel/src/` | `channel_store` | Channel persistence/state. |
| `client/src/` | `proxy`, `telemetry` | Client proxy support and telemetry client pieces. |
| `collab/` | `k8s`, `migrations`, `migrations.sqlite`, `seed`, `src/api`, `src/bin`, `src/db`, `src/entities`, `src/rpc`, `src/services`, `tests/integration` | Collaboration service deployment, database schema, seed data, API/server code, RPC, services, and integration tests. |
| `collab_ui/src/` | `collab_panel`, `notifications` | Collaboration panel and related notifications. |
| `context_server/src/` | `transport` | Context-server transport implementations. |
| `csv_preview/src/` | `renderer`, `table_data_engine`, `types` | CSV rendering, table data engine, and shared preview types. |
| `dap/` | `docs`, `src` | Debug Adapter Protocol docs and implementation. |
| `debugger_ui/src/` | `session`, `tests` | Debugger session UI and tests. |
| `denoise/` | `examples`, `models`, `src` | Denoise examples, bundled models, and implementation. |
| `edit_prediction/` | `benches`, `license_examples`, `license_patterns`, `src` | Inline completion benchmarks, license fixtures/patterns, and provider implementation. |
| `edit_prediction_cli/` | `evals`, `src/prompts` | Evaluation data and prompts for edit prediction experiments. |
| `editor/src/` | `display_map`, `editor_tests`, `git`, `inlays`, `scroll`, `test` | Editor layout model, tests, git decorations, inlays, scrolling, and test helpers. |
| `extension/src/` | `capabilities`, `types` | Extension capabilities and extension type definitions. |
| `extension_api/` | `wit/since_v*` | Versioned WIT API definitions for extensions. |
| `extension_host/src/` | `wasm_host` | WASM extension host. |
| `extensions_ui/src/` | `components` | Reusable extension-management UI components. |
| `fs/tests/` | `integration` | Filesystem integration tests. |

## How To Navigate The IDE Code

Start with the user-visible area you are changing:

| Task | Start here |
| --- | --- |
| Change Backboard chat rendering | `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs` |
| Change Backboard agent launch/runtime | `ide/zed/crates/agent_servers/src/backboard.rs` and `ide/zed/script/backboard-ide-acp.py` |
| Change agent thread state | `ide/zed/crates/acp_thread/` |
| Change multi-agent workspace | `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs` and `ide/zed/crates/workspace/src/multi_workspace.rs` |
| Change beginner/simple mode | `ide/zed/crates/beginner_ui/` |
| Change app boot or menus | `ide/zed/crates/zed/` |
| Change editor behavior | `ide/zed/crates/editor/`, then `project`, `language`, or `workspace` depending on the feature. |
| Change language/LSP behavior | `ide/zed/crates/language/`, `languages/`, `lsp/`, and relevant extension crates. |
| Change packaging | `ide/zed/script/bundle-*`, `ide/zed/crates/zed/Cargo.toml`, and `ide/docs/BACKBOARD_IDE_PACKAGING.md`. |

## Folders To Treat Carefully

| Folder | Why |
| --- | --- |
| `ide/zed/target/` | Generated build output. Do not edit manually or include in source documentation except as build artifact notes. |
| `ide/zed/Cargo.lock` | Large generated dependency lockfile. Edit only through Cargo unless intentionally resolving lockfile conflicts. |
| `ide/zed/crates/gpui*` | Low-level UI/platform layer. Changes can affect the whole app. |
| `ide/zed/crates/workspace`, `project`, `editor` | Core editor architecture. Small changes can have broad user-facing effects. |
| `ide/zed/script/backboard-ide-acp.py` | Critical Backboard runtime bridge. Keep behavior compatible with Rust ACP expectations. |
| `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs` | Large rendering file with many Backboard-specific UI paths. Read nearby state carefully before editing. |
