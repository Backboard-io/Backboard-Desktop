# Backboard IDE Handoff

This document explains how the Backboard IDE integration currently works in this checkout, what was added, and where another AI model should continue. It is written as implementation context, not marketing copy.

## Scope And Rule For Future Work

The IDE work lives under:

- `ide/zed/`

The existing CLI lives under:

- `cli/backboard_cli/`

Do not edit `cli/` for IDE UI/runtime work unless the user explicitly approves it. The active IDE chat runtime no longer imports the CLI; it is native Rust. The CLI remains useful as historical/API reference and for the standalone terminal product.

## Current Status / Superseded Docs

This handoff is the current source of truth for `bb-ide-zed` as of May 21, 2026.

- Active branch: `bb-ide-zed`.
- Audited commit range: `origin/main..bb-ide-zed`, 74 commits.
- Current HEAD during this update: `27aeb9ce Update agent_workspace_ui.rs`.
- Current working tree also has uncommitted Rust/UI changes and a docs move/delete state; they are documented below as working tree state.
- Active Backboard IDE chat runtime: Rust native `BackboardNativeConnection`.
- Historical runtime still present: `ide/zed/script/backboard-ide-acp.py`, but it is not the default chat path.

Several docs still describe older planning states. In this working tree the old planning docs appear under untracked `ide/docs/md/` while the tracked root-level copies are deleted; treat those filenames as historical unless this file explicitly says otherwise:

- `ide/docs/md/BACKBOARD_IDE_NATIVE_ENDPOINTS_NEXT_STEPS.md` says Python ACP is still active and native Rust should remain behind a flag. That is superseded: native Rust is the active runtime.
- `ide/docs/md/BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md` planned bundling the Python CLI runtime. That is mostly superseded for active chat because the app now uses the Rust-native runtime, though the packaging/history notes remain useful.
- `ide/docs/md/BACKBOARD_IDE_PACKAGING.md` still contains Python bridge/CLI bundle guidance in places. Packaging has moved toward native runtime metadata for active chat; re-check `script/bundle-mac` before following the old bundle layout.
- `ide/docs/md/IDE_FOLDER_GUIDE.md` still lists the Python ACP bridge as a primary Backboard integration point. Use it as folder orientation, not active runtime truth.
- The testcase markdown under `ide/docs/testcase/` is prompt/sample material for IDE validation, not architecture guidance.

## Current Source-Of-Truth Map

Use this map before changing anything. The Backboard IDE is not one single integration point; it is a native Rust `AgentConnection`, a Rust Backboard endpoint client, a Rust-native tool/index layer, and several Zed UI surfaces rendering `AcpThread` state.

| Area | Source of truth | What it owns |
|------|-----------------|--------------|
| Native Backboard agent server | `ide/zed/crates/agent_servers/src/backboard.rs` | Registers Backboard as the native agent and returns `BackboardNativeConnection`; default mode is `free`. |
| Native runtime | `ide/zed/crates/agent_servers/src/backboard_native/{mod.rs,stream.rs,tools.rs,tool_schemas.rs,workspace.rs,session_store.rs,index.rs}` | Session lifecycle, assistant/thread binding, stream translation, native tools, mode/config chips, workspace prompt, persisted IDE sessions, native codebase index. |
| Backboard Rust API client | `ide/zed/crates/backboard/src/backboard.rs`, `ide/zed/crates/backboard/src/endpoints/**` | Rust HTTP/SSE/multipart client for assistants, threads, streamed messages, tool outputs, cancel, models, usage, voice/realtime helpers. |
| ACP thread model | `ide/zed/crates/acp_thread/src/acp_thread.rs`, `ide/zed/crates/acp_thread/src/connection.rs`, `ide/zed/crates/acp_thread/src/terminal.rs` | Stores conversation entries, tool calls, diffs, display-only terminals, approvals, token/context/cost/speed metrics, and history. |
| Native chat UI | `ide/zed/crates/agent_ui/src/conversation_view.rs`, `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`, `ide/zed/crates/agent_ui/src/config_options.rs`, `ide/zed/crates/agent_ui/src/model_selector*.rs` | Backboard chat surface, composer, model/config controls, Agent Options menu, progress, grouped exploration, collapsed edits, terminal/diff/tool rendering. |
| Agent Workspace | `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`, `ide/zed/crates/agent_ui/src/agent_panel.rs` | Multi-agent dashboard, retained conversations, draft chat promotion, git worktrees, review/apply/stop/retry/dismiss flow, run summaries. |
| Simple/beginner UI | `ide/zed/crates/beginner_ui/src/*.rs` | Beginner chat-first workspace, folder selection, friendly feed, file changes panel, switch-to-editor handoff; chat history home page (BeginnerChatRecord, KVP persistence), curated model filtering (CuratedModelSelector), tab bar home icon |
| Workspace shell and app chrome | `ide/zed/crates/workspace/src/multi_workspace.rs`, `ide/zed/crates/title_bar/src/title_bar.rs`, `ide/zed/crates/zed/src/zed.rs`, `ide/zed/crates/agent_settings/src/agent_settings.rs` | Simple/Expert mode, full-page Multi-Agent rendering, Backboard mode controls, default dock positions, app startup wiring. |
| Inline autocomplete | `ide/zed/crates/edit_prediction/src/backboard.rs` and edit-prediction registry/settings files | BYOK ghost text via Backboard assistant/thread/message APIs; default provider `"backboard"` with legacy alias `"zed"`; cached assistant, 120-second thread TTL, FIM prompt, streaming early exit, strict prose/code filtering, inline completion output publishing. |
| Visual defaults | `ide/zed/assets/fonts/**`, `ide/zed/assets/themes/backboard/backboard_tints.json`, `ide/zed/assets/settings/{default.json,initial_user_settings.json}` | Inter UI font, JetBrains Mono buffer font, Backboard Tints theme family, edit prediction defaults, left-dock defaults for project/outline/collab/git. |
| Historical Python ACP bridge | `ide/zed/script/backboard-ide-acp.py` | Historical bridge and behavior reference only. It should not be treated as the active Backboard IDE chat runtime. |
| CLI runtime | `cli/backboard_cli/` | Standalone CLI product and useful reference for API contracts, prompts, tools, MCP, skills, pricing, semantic index, RLM/subagents. Do not edit for IDE work without explicit approval. |

Rule of thumb:

- If the issue is "Backboard could not start", inspect `agent_servers/src/backboard.rs`, `backboard_native/mod.rs`, API key/config loading, and native runtime logs first.
- If the issue is "model/API behavior is wrong", inspect `backboard/src/backboard.rs`, `backboard/src/endpoints/**`, and `backboard_native/stream.rs`.
- If the issue is "tool/index behavior is wrong", inspect `backboard_native/tools.rs`, `tool_schemas.rs`, and `index.rs`.
- If the issue is "the IDE did not render the thing", inspect `acp_thread` storage first, then `conversation_view/thread_view.rs`.
- If the issue is "Agent Workspace applied/reviewed wrong", inspect `agent_panel.rs` worktree/run metadata before the page view.

## Native Rust Runtime Status (2026-05-21)

This section reflects the current committed branch plus the current dirty working tree. It supersedes older sections in this document that describe the Python ACP bridge as the active Backboard IDE chat path. Those older sections are historical reference for behavior that was ported or replaced.

### Runtime Routing

- `ide/zed/crates/agent_servers/src/backboard.rs` now returns `BackboardNativeConnection` directly from `BackboardAgentServer::connect`.
- The active Backboard IDE chat path is now: Zed Rust agent UI/runtime -> `agent_servers/src/backboard_native/*` -> `backboard` Rust endpoint client -> Backboard HTTP API -> Rust-native tool execution.
- The current Rust path does not start `ide/zed/script/backboard-ide-acp.py`.
- The current Rust path does not import or shell through `cli/backboard_cli/`.
- `ide/zed/script/backboard-ide-acp.py` still exists in the repository as a reference/historical bridge, but it is not the default runtime.
- Generic ACP infrastructure remains in place for other/custom ACP agents. `AcpThread` also remains the internal chat/thread UI model for Backboard because it owns tool cards, diffs, terminals, approvals, token usage, history, and rendering.
- `ide/zed/script/bundle-mac` no longer needs the Python bridge/CLI resources for the active chat runtime. Native-runtime packaging should be re-checked against the current script instead of following old embedded-CLI docs.

### New Native Runtime Modules

New runtime code lives under `ide/zed/crates/agent_servers/src/backboard_native/`:

- `mod.rs`: `BackboardNativeConnection`, session lifecycle, modes, config options, model selector, cancellation, assistant/thread binding, session list integration, feature settings, native turn metrics, and usage snapshot APIs.
- `stream.rs`: prompt handling, Backboard SSE translation, history replay, tool-output continuation, usage/context-window parsing, provider-shaped thinking payloads, and Tokio wrapping for HTTP/SSE futures.
- `tools.rs`: Rust-native execution for advertised IDE tools, tool batching, file edits, terminal cards, permission prompts, shell timeout enforcement, and compressed read/search outputs.
- `tool_schemas.rs`: tool schemas filtered by mode (`agent`, `ask`, `manual`, `free`).
- `workspace.rs`: system prompt and lightweight workspace prompt augmentation.
- `session_store.rs`: persisted IDE session/thread mappings in `~/.backboard/ide_sessions.json`.
- `index.rs`: native codebase index preparation/build/search. It writes CLI-compatible index data under `.backboard_index/codebase_index.json`, prepares `.backboard/scratchpad`, skips heavy/internal directories, and feeds `codebase_search` before falling back to lexical search.

The runtime keeps the existing user-facing modes:

- `agent`: autonomous read/edit/shell/tool flow.
- `ask`: read/search/explain only; mutating and shell tools are hidden/blocked.
- `manual`: focused edit proposals; shell tools are hidden/blocked.
- `free`: shell tools can run without approval prompts.

Current default mode:

- `BackboardAgentServer::new(...)` defaults to `free`.
- Agent Workspace can still create sessions with an explicit mode.
- Mode can now be changed through the `backboard_mode` session config option, and the native runtime emits a current-mode update after mode changes.

### Rust Endpoint Client Work

The `backboard` crate remains the Rust HTTP client source for IDE runtime calls. Endpoint modules live under `ide/zed/crates/backboard/src/endpoints/`, with `[lib] path = "src/backboard.rs"` preserved.

Important runtime-used endpoint methods:

- `list_models(None, Some("llm"), Some(250))`
- `create_assistant(CreateAssistantRequest { ... })`
- `create_thread(&assistant_id)`
- `get_thread(&thread_id)`
- `send_message_stream(&thread_id, SendMessageRequest { ... })`
- `realtime_voice_url()`
- `submit_tool_outputs_stream(&thread_id, &run_id, SubmitToolOutputsRequest { ... })`
- `cancel_run(&thread_id, &run_id)`

Current native composer controls are delivered through session config options, so they render as compact chips in the existing chat control row:

- `Mode`: `Agent`, `Ask`, `Manual`, `Full Access`; maps to native session mode and tool filtering.
- `Intensity`: `Fast`, `Balanced`, `Deep`.
- `Web`: `Off`, `Auto`; maps to message `web_search`.
- `Image`: `Off`, `Auto`; maps to `image_generation=auto`, `image_model_provider=openrouter`, and `image_model_name=google/gemini-3.1-flash-image-preview`.
- `Voice`: `Off`, `TTS`, `STT`, `Conversation`; maps to the REST message `voice` JSON and `send_to_llm`.
- `Live Voice`: `Off`, `On`; prepares the realtime WebSocket URL/setup payload for `wss://.../api/threads/messages?api_key=...`.

REST voice defaults:

- STT: OpenAI `gpt-4o-mini-transcribe`, language `en`.
- TTS: OpenAI `gpt-4o-mini-tts`, voice `alloy`, output format `mp3`.
- Realtime STT setup: ElevenLabs `scribe_v2_realtime`, raw `pcm_16000`.

Audio prompt blocks are decoded and uploaded as multipart `audio_file` for STT and Conversation voice modes. Text-only turns keep the existing form-encoded path.

The Rust SSE endpoint layer now preserves the old Python client's important retry invariant:

- Retry transient request/setup failures before any SSE chunk has been yielded.
- Do not retry after a real SSE chunk has been yielded, because replaying the POST can duplicate user messages or corrupt run/tool state.
- Retry chunks are still emitted as `{"type": "retry", ...}` so the native stream translator can show progress.

HTTP/SSE futures must run on Tokio. The native runtime wraps Backboard network calls with `gpui_tokio::Tokio::spawn_result`; GPUI remains responsible for UI updates and `AcpThread` mutations.

### Stream And Usage Mapping

The native stream translator handles these Backboard chunk types:

- `run_started`
- `reasoning_started`
- `reasoning_streaming`
- `reasoning_delta`
- `reasoning_ended`
- `content_streaming`
- `media_generated`
- `stt_text_delta`
- `stt_stream_end`
- `tts_audio_delta`
- `tool_submit_required`
- `run_ended`
- `run_failed`
- `error`
- `retry`

Important fixes already made:

- Native turn metrics now track timing buckets, counts, slowest tool, first-token latency, and usage snapshots. These are emitted through `backboard_speed` metadata for the same footer/card surfaces that previously consumed Python bridge metrics.
- Context window size is inferred from model/catalog data and remembered per provider/model; `run_ended.context_usage` remains authoritative when present.
- `codebase_search` uses the native `.backboard_index/codebase_index.json` when available and falls back to lexical search when the index is missing or empty.
- Fast intensity now omits `thinking` entirely instead of sending `{"enabled": false}`. The server rejects the `enabled` key.
- Balanced/deep thinking now uses provider-shaped payloads, such as `effort`, `budget_tokens`, or `max_tokens`.
- `run_ended.context_usage` is now parsed as the authoritative context-window source. This fixes the broken `102k / 0 tokens` display.
- Usage metadata now carries input tokens, output tokens, remaining tokens, summary tokens, context percent, context model, and optional max output tokens.
- `media_generated` and `run_ended.generated_media` URLs are rendered as chat resource links.
- `voice_records.stt` transcripts and TTS audio URLs are surfaced in chat when present.
- `AcpThread` now copies those usage metadata fields into `TokenUsage`.
- `agent_ui/src/conversation_view/thread_view.rs` now shows more context-window tooltip stats, including Remaining, Summary, and Context model.

### Rust-Native Tool Layer

Advertised and implemented native tools:

- Read/search: `read_file`, `list_dir`, `glob`, `grep`, `codebase_search`, `read_lints`.
- Mutating files: `write`, `edit`, `search_replace`, `delete_file`, `create_directory`.
- Shell: `bash`, `run_terminal_cmd`.
- Flow: `todo_write`.

Tool behavior:

- Native workspace indexing starts in the background when sessions are created or loaded.
- Read/search tools can batch in parallel.
- Read/search outputs are compressed before being sent back to the model.
- Existing-file writes use `AcpThread::write_text_file` so Zed owns buffers, diffs, action log, and saves.
- New files and deletes currently use direct filesystem operations plus ACP diff/tool updates.
- Shell output is routed into display-only terminal cards through `TerminalProviderEvent`.
- Shell commands are classified conservatively for read-only auto-approval. Package-manager scripts, shell operators, `git pull/reset/push`, `sed -i`, mutating curl, and similar commands still require approval unless Free mode is active.
- Shell timeouts are enforced by spawning, polling, killing on timeout, and reporting timeout text in stderr/output.

### Logging Added For Verification

The native path now logs explicit markers so runtime routing can be verified from app logs:

- `Backboard IDE runtime: using native Rust AgentConnection, not Python ACP/CLI bridge`
- `Backboard native runtime initialized; Python ACP/CLI bridge is not in the active path`
- `Backboard native prompt start: ... path=rust-native`
- `Backboard native endpoint call: POST /threads/{thread_id}/messages?stream=true ...`
- `Backboard native endpoint call: POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true ...`
- `Backboard native endpoint call: GET /threads/{thread_id} ... path=rust-native`
- `Backboard native endpoint call: POST /assistants then POST /assistants/{assistant_id}/threads ...`
- `Backboard native endpoint call: GET /models?model_type=llm&limit=250 ...`
- `Backboard native endpoint call: POST /threads/{thread_id}/runs/{run_id}/cancel ...`

If the old bridge is active, these native markers will be absent and process/log output will reference Python ACP/CLI startup instead.

### ACP Thread And UI Infrastructure Fixes

- `acp_thread/src/acp_thread.rs` now treats `std::io::ErrorKind::NotFound` during checkpoint creation as "no checkpoint available" instead of logging `failed to get old checkpoint`.
- Real checkpoint failures still log.
- `TokenUsage` now has optional fields for remaining/context/summary/model details.
- `thread_view.rs` renders additional context-window tooltip rows.
- Tests and native-agent token usage constructors were updated for the expanded `TokenUsage` struct.

### Verification Already Run

Recent checks run during the migration/debug pass:

- `cargo check -p backboard`
- `cargo check -p backboard_ui`
- `cargo check -p acp_thread`
- `cargo check -p agent_servers`
- `cargo check -p agent`
- `cargo check -p agent_ui`
- `cargo test -p agent_servers backboard_native --lib`
- `cargo test -p backboard --lib`

Current native unit coverage includes:

- Backboard message form serialization for Web/Image/Voice fields.
- Multipart voice request building with `audio_file`.
- Realtime voice URL generation.
- Native media/search/voice config chip inventory.
- `media_generated` resource-link parsing.
- Voice payload defaults for STT/TTS/conversation modes.
- Tool schema filtering for Ask mode.
- Conservative read-only shell classification.
- Fast intensity omitting thinking payload.
- Provider-shaped thinking payloads without `enabled`.
- Parsing authoritative `context_usage` from Backboard `run_ended` chunks.

### Known Follow-Up Areas

- Live IDE/API manual verification is still useful: send a prompt, inspect logs for `path=rust-native`, run a read tool, run an approved shell command, create/edit a file, cancel a turn, and restore a thread.
- Full realtime microphone capture/playback still needs a dedicated composer action/control that streams PCM frames over the prepared WebSocket. The native endpoint URL/setup state exists; the UI capture loop is not complete.
- The Rust-native `read_lints` tool is currently a lightweight placeholder message, not full diagnostics integration.
- `codebase_search` is now native-index-backed when `.backboard_index/codebase_index.json` exists and lexical fallback otherwise. It is still not the full CLI semantic/RLM path.
- MCP, browser, web fetch/search, RLM/subagents, notebook tools, and the CLI's richer skill system are not fully ported into the Rust-native tool layer.
- Older branch-history sections below still mention the Python bridge because that was the active path at the time of those commits. Treat those entries as historical/reference, not current architecture.

## Branch History

Branch range audited:

- `origin/main..bb-ide-zed`
- Commit count: 74
- Current branch: `bb-ide-zed`
- Current HEAD during this handoff update: `27aeb9ce Update agent_workspace_ui.rs`

Important framing:

- `83939300 Cloned Zed` is the baseline IDE import. It added the upstream Zed tree under `ide/zed/` and is intentionally summarized instead of listing all imported files.
- The branch also merged unrelated `origin/main` API/product work on May 13, 2026. Those commits are acknowledged below, but the IDE handoff focuses on files under `ide/zed/` plus the root handoff/feature notes.
- Some old "Current role" bullets below were written before the Rust-native migration. When they describe Python ACP as the live runtime, treat that as historical branch context, not active architecture.

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
  - Historical role: this was the original IDE-to-Backboard path. It has been superseded by the Rust-native runtime in `backboard_native/*`.

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
  - Current role: `EditPredictionProvider::Backboard` (alias `"zed"`) maps to `EditPredictionModel::Backboard`; settings expose `edit_predictions.backboard.api_url/model/timeout_ms`; assistant/thread are cached per API URL so cold start only happens once per session; pre-filter, FIM prompt, SSE streaming with early exit, response gating, and chunking are all applied before ghost text is shown.

### Post-`f701758d` Timeline And Current Head

This section captures the commits that were missing from the older handoff audit.

- `40bf621b` / `7f9397ea` - 2026-05-14 - Packaging docs and handoff relocation.
  - Added `ide/docs/BACKBOARD_IDE_PACKAGING.md`, moved the handoff under `ide/docs/`, and documented release artifacts versus local `target/` output.

- `4141d1ac` - 2026-05-14 - Limit Backboard workspace chats to 20.
  - Added workspace run launch results, batch ids, events, pending worktree setup, and UI handling for the run limit.

- `f4c16e6a` / `a07fcd4f` - 2026-05-14/15 - Agent Workspace UI and metric polish.
  - Added lazy `AgentPanel` creation for workspace flows, terminal-style activity preview, higher-fidelity cost/token/timing cards, better truncation, and cleaner card styling.

- `3fd37581` - 2026-05-14 - Backboard Studio rebrand and diagnostics.
  - Updated app identifiers, URL schemes, packaging metadata, and ACP diagnostics/session-store locking for the old bridge era.

- `16d8ad65` - 2026-05-14 - Token/speed metrics and embedded CLI plan.
  - Added `BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md`, workspace token/context/timing cards, and bridge-side helper HTTP calls. The embedded CLI plan is now mostly historical because native Rust chat is active.

- `972d78bf`, `44d4e494`, `9d0d4475`, `1dac0a06` - 2026-05-14 - Simple Mode web preview and lifecycle fixes.
  - Added `beginner_ui/web_preview.rs`, macOS WKWebView and Windows WebView2 preview support, Enter-to-submit, raw folder navigation, browser-style tabs, per-session dev-server ports 3000-3002, shell login/interactive launch for GUI app PATH, package-manager detection, and hot-reload-friendly follow-up behavior.

- `8c150e8d`, `5d7b446d`, `4cfbbb37` - 2026-05-14/15 - Testcase doc organization.
  - Added detailed landing-page/web-app prompts and sample React app docs, then moved them into `ide/docs/testcase/`. `AGItestcase.md` is now the one-line billion-dollar SaaS stress prompt.

- `9c0d79ca` - 2026-05-15 - Bundle Backboard runtime and update mac packaging.
  - Made mac release work more self-contained for the Python bridge era, renamed DMG artifacts to Backboard Studio, and added packaged resource lookup. Active chat later moved to native Rust, so verify current `bundle-mac` before following older CLI bundle steps.

- `b9154644` - 2026-05-15 - Simple Mode curated models and chat history.
  - Added `CuratedModelSelector`, Simple Mode chat records in KVP key `beginner_chats_v1`, continue/delete chat history, prompt-derived chat names, and a home icon that returns to the landing page without losing the active tab.

- `1a373eb0` / `7c11b716` - 2026-05-15 - IDE folder guide, lofi theme, assets, and Agent Workspace UI adjustments.
  - Added `IDE_FOLDER_GUIDE.md`, `lofi.json`, refreshed app/icon assets, and continued multi-agent workspace layout polish.

- `03ff9704` - 2026-05-15 - ACP runtime docs and bridge hardening.
  - Added temporary endpoint docs, clarified protocol stdout/stderr, improved bundled CLI lookup, tightened read-only shell classification, normalized tool-call payloads, and improved bridge context/tool batching. This is historical for active chat.

- `5a12f887` - 2026-05-15 - IDE chat persistence and chat-entry behavior.
  - Fixed restored history context leakage, session/list/load behavior, archived Backboard chat rescue, and changed the chat button to open the sidebar thread switcher instead of forcing Multi-Agent.

- `f34a5b6e` / `c8039b13` - 2026-05-15 - Rust endpoint docs and endpoint modules.
  - Added `BACKBOARD_IDE_RUST_ENDPOINTS.md`, `BACKBOARD_IDE_NATIVE_ENDPOINTS_NEXT_STEPS.md`, and Rust endpoint modules under `backboard/src/endpoints/**`.

- `eb73b891` / `802278db` - 2026-05-16 - Native Backboard agent runtime.
  - Introduced `agent_servers/src/backboard_native/**`, changed `BackboardAgentServer::connect` to return `BackboardNativeConnection`, expanded `TokenUsage`, added native tool execution, and stopped using the Python ACP/CLI bridge as default chat runtime.

- `e120b050` - 2026-05-19 - Native index, metrics, and tools.
  - Added `backboard_native/index.rs`, background workspace indexing, `.backboard_index/codebase_index.json`, expanded native tool schemas, context-window inference/cache, native speed metadata, token estimates, and index-backed `codebase_search` with lexical fallback. Also changed default session mode to `free`.

- `e0237097` - 2026-05-19 - Backboard inline autocomplete provider.
  - Made `"backboard"` the default edit prediction provider, preserved legacy `"zed"` alias, added BYOK Backboard completions, assistant cache, 120-second thread TTL, stricter `<prefix>/<suffix>/<cursor>` FIM prompting, prose filtering, and inline completion output pub/sub.

- `d30fbac2` / `13b87634` / `9891bf0c` - 2026-05-19 - UX stabilization and icon update.
  - Refined Simple/Expert UX, Home/Chats navigation, onboarding mode cards, model picker grouping/favorites, and Backboard icon usage.

- `c5651083` - 2026-05-20 - UI theming, spacing, and speed notes.
  - Added `CLI_VS_IDE_SPEED_NOTES.md` and broader UI polish across agent UI, editor, terminal, panels, dock, tabs, and status bar. The key product note: the IDE feels faster because the native Rust path removes CLI-side client overhead, not because it lowers model/tool quality.

- `5fcbede3` - 2026-05-20 - Voice/media support and UI controls.
  - Added feature settings for Web/Image/Voice/Live Voice, REST STT/TTS/conversation defaults, realtime voice setup, multipart audio upload, `send_to_llm`, media/STT/TTS stream handling, generated resource links, and compact session control chips.

- `a8fdb493` - 2026-05-20 - Inter, JetBrains Mono, and Backboard Tints.
  - Bundled Inter and JetBrains Mono font files and OFL licenses, added `assets/themes/backboard/backboard_tints.json`, and updated default/initial settings to use Inter for UI and JetBrains Mono for buffers.

- `4b975091` - 2026-05-20 - Backboard mode config and left-dock defaults.
  - Added `backboard_mode` config, current-mode updates, default left docking for project/outline/collab/git panels, non-agent right-dock prevention, and additional Agent Workspace layout/status polish.

- `27aeb9ce` - 2026-05-21 - Agent Workspace UI update.
  - Reduced older selected-detail UI, keeping the right panel as the live `AgentPanel` host. Current dirty work builds on this with draft-only New Chat, first-prompt promotion, and run ordering changes.

### Working Tree / Uncommitted As Of 2026-05-21

The current checkout has uncommitted changes in Rust UI/runtime files. Do not assume these are accidental; preserve them unless the user asks otherwise.

- `agent_servers/src/backboard_native/mod.rs`: adds tests proving `set_config_option` updates native session state for Web, Mode, and Voice options.
- `agent_ui/src/config_options.rs` and `conversation_view/thread_view.rs`: add `ConfigOptionSummary`, per-option cycling, stable picker popover ids, and an Agent Options menu that shows all current config options as clickable rows instead of embedding the full selector UI.
- `picker/src/popover_menu.rs`: allows custom popover ids so multiple config option pickers do not collide.
- `gpui/src/key_dispatch.rs` and `gpui/src/window.rs`: make reused deferred-draw parent-node remapping fallible and skip stale deferred draws rather than asserting.
- `agent_ui/src/model_selector.rs` and `model_selector_popover.rs`: update selected model first, then refresh model list; widen branded trigger and make the label more prominent.
- `agent_ui/src/agent_panel.rs`: adds workspace draft thread persistence, draft-only New Chat, `promote_active_backboard_workspace_draft`, first-prompt run promotion, `auto_select` event semantics, `created_at` run ordering, and guards so drafts do not count as run summaries.
- `agent_ui/src/agent_workspace_ui.rs`: New Chat now focuses a draft without selecting a run card; first send can promote the draft and open a fresh draft; the right panel embeds the live `AgentPanel`.
- `settings_ui/src/settings_ui.rs`: removes an unused sub-page helper.
- Docs working tree: tracked planning docs at `ide/docs/BACKBOARD_IDE_*`, `ide/docs/CLI_VS_IDE_SPEED_NOTES.md`, and `ide/docs/IDE_FOLDER_GUIDE.md` are deleted while copies exist under untracked `ide/docs/md/`. This handoff update intentionally edits only `ide/docs/BACKBOARD_IDE_HANDOFF.md`.

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

### Simple Mode: Curated Models And Chat History Home Page

These changes landed in the May 15 Simple Mode work and remain part of the current product direction.

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
- Native Rust runtime: `ide/zed/crates/agent_servers/src/backboard_native/`
- Native chat UI: `ide/zed/crates/agent_ui/src/conversation_view.rs`
- Thread/tool rendering: `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- Agent panel ownership/runtime: `ide/zed/crates/agent_ui/src/agent_panel.rs`
- Agent Workspace full-page view: `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- Multi-agent workspace page: `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
- Agent action registration: `ide/zed/crates/agent_ui/src/agent_ui.rs`
- Backboard Rust API/config client: `ide/zed/crates/backboard/src/backboard.rs`
- Older thin Backboard panel: `ide/zed/crates/backboard_ui/src/backboard_ui.rs`
- Historical Python ACP bridge: `ide/zed/script/backboard-ide-acp.py`

Runtime flow:

1. Zed opens the native Backboard agent.
2. `BackboardAgentServer::connect()` returns `BackboardNativeConnection`.
3. The native runtime creates/restores assistant/thread ids, prepares workspace context, starts background indexing, and sends streamed Backboard API requests through the Rust endpoint client.
4. Stream chunks are translated directly into `AcpThread` updates: assistant text, progress, tool calls, terminal output, diffs, media links, voice transcripts/audio links, usage, context, speed metrics, and mode/config state.
5. Rust-native tools execute local reads/searches/edits/shell commands, then submit JSON-string tool outputs back to the same Backboard run.
6. Zed's native agent UI renders the conversation, tool cards, terminal cards, diffs, model/config controls, and command approval UI.

## CLI API Surface

The CLI and IDE both use the assistant/thread/run API family. For the active IDE path, treat `ide/zed/crates/backboard/src/backboard.rs` and `ide/zed/crates/backboard/src/endpoints/**` as the direct implementation. `cli/backboard_cli/api/client.py` remains the strongest historical/reference source for behavior the Rust client was intended to mirror.

The API base URL comes from `~/.backboard/config.json`:

- `env = "prod"` defaults to `https://app.backboard.io/api`
- `env = "dev"` defaults to `https://dev.app.backboard.io/api`
- `env = "local"` defaults to `http://localhost:8000`
- Explicit `api_url` wins over the env default.
- The API key is sent as `X-API-Key`.
- API key preflight uses `GET /assistants?limit=1` through `cli/backboard_cli/api/validation.py`; `set-api-key` can probe prod/dev and switch the saved env to the one that accepts the key.

The backend and SDK also expose newer stateful convenience endpoints such as `/threads/messages`, but the IDE native runtime path documented here is the assistant/thread/run path below.

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

The CLI is a full agent runtime, not just a thin HTTP wrapper. This section is reference material for the standalone CLI and for behavior that the older Python ACP bridge reused. The active IDE chat runtime is Rust native and does not import the CLI.

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

The CLI runtime includes services the older IDE bridge reused and the native runtime may still use as parity reference:

- `AdvancedToolManager` for file/search/shell/web/todo/task/MCP/tool execution.
- `MCPManager` for external tool schemas and tool dispatch.
- `SkillManager` for skill discovery and prompt sections.
- `build_system_prompt(...)` for the base agent system prompt.
- `PricingService` for model catalog and cost estimates.
- Semantic index support through config or `BB_INDEXING`.
- `RLMEngine` and `SubagentManager` for recursive/subagent task execution.
- Persistent Python REPL and code execution helpers.
- Browser/computer harness hooks where enabled by the CLI tool layer.

Historical note: the Python bridge did not run `backboard chat` as a subprocess. It imported Python modules in-process and adapted terminal-oriented behavior into ACP session updates. The active runtime no longer uses this path.

## Historical Python ACP Bridge Contract

`ide/zed/script/backboard-ide-acp.py` was the IDE-owned adapter between Zed ACP and the CLI runtime. It is still in the repository as historical/reference code, but it is not the active Backboard IDE chat path as of May 21, 2026.

### Historical Launch Contract

The pre-native path was:

1. Zed requested the native `backboard` agent.
2. `BackboardAgentServer.connect()` built an `AgentServerCommand`.
3. The command launched `backboard-ide-acp.py` with Python.
4. Rust `agent_servers/src/acp.rs` spoke ACP JSON-RPC over the child process stdio.
5. The bridge redirected accidental Python stdout to stderr so only protocol JSON went to stdout.

Historical env vars:

| Env var | Purpose |
|---------|---------|
| `BACKBOARD_IDE_ACP_PATH` | Override the bridge script path |
| `BACKBOARD_CLI_ROOT` | Override the CLI root inserted into `sys.path` |
| `BACKBOARD_CLI_PATH` | Helps resolve a sibling Python executable for packaged installs |
| `BACKBOARD_IDE_PYTHON` | Override Python executable |
| `BACKBOARD_IDE=zed` | Marks the runtime as IDE-owned |
| `NO_BROWSER=1` | Prevents browser launch when the IDE delegate requests no browser |

### Historical ACP Methods Handled

The bridge handled these JSON-RPC requests/notifications:

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

The bridge also sent requests back into the IDE:

- `session/request_permission` for command/tool approval.
- `fs/write_text_file` so editor buffers, diffs, action log, and saves are owned by Zed.

### Historical Session Runtime

Each `BackboardIdeSession` owned:

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

Session mapping was persisted in `~/.backboard/ide_sessions.json` so a loaded IDE ACP session could bind back to the Backboard assistant/thread when possible.

### Historical Prompt Augmentation

Before calling `POST /threads/{thread_id}/messages`, the bridge created an IDE context pack. Depending on intensity and request shape, it could include:

- workspace path
- lightweight file tree
- package/stack hints
- git branch/status/diff stats
- project rules
- active editor/embedded ACP context
- semantic code-search hits
- website/app quality guidance for frontend requests

Fast intensity kept the pack smaller and normally skipped semantic search. Balanced/Deep could add semantic hits. Website/app turns got extra frontend guidance and capped thinking even when the selected intensity was Fast.

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

## Backboard Editor To Native Runtime Flow

This is the current flow for a normal Backboard chat turn and for Agent Workspace auto-submitted tasks.

1. User submits a prompt in the native Backboard composer, Beginner UI follow-up box, or Agent Workspace task launcher.
2. `ThreadView.send()` resolves editor content and clears/queues the composer.
3. `AcpThread.send()` optimistically appends the local user message and asks the active `AgentConnection` to prompt.
4. `BackboardNativeConnection` receives the prompt directly inside Rust, resolves the `NativeSession`, records turn metrics, and ensures assistant/thread binding.
5. The native runtime builds workspace context, uses or refreshes the native codebase index, applies mode/config settings, and calls `BackboardClient::send_message_stream`.
6. The backend streams text, reasoning state, media/voice chunks, tool requests, usage, context, and run end/failure chunks.
7. `backboard_native/stream.rs` maps visible assistant text, progress, media links, STT/TTS data, usage, and speed metadata into `AcpThread` updates.
8. When tools are requested, `backboard_native/tools.rs` executes Rust-native tools and submits JSON-string outputs through `submit_tool_outputs_stream`.
9. `AcpThread.handle_session_update()` stores messages, tool calls, plans, terminal data, usage, cost, context, and speed metrics.
10. `ThreadView` renders assistant text, progress, grouped exploration rows, collapsed write/edit cards, terminal cards, diff cards, media/resource links, permission buttons, config chips, and footer context/cost.

The file-edit path is still editor-owned:

1. Model calls `write`, `edit`, `search_replace`, or `delete_file`.
2. Native tools compute old/new text and build ACP-visible tool/diff state.
3. Existing-file writes go through `AcpThread::write_text_file(path, content)` so buffers, diffs, action log, and saves remain Zed-owned.
4. New files and deletes currently use direct filesystem operations plus ACP diff/tool updates.

Terminal output follows a display-only terminal path:

1. Native shell tools create terminal cards through `TerminalProviderEvent`.
2. Output is streamed/buffered into display-only terminal state.
3. Exit, timeout, and cancellation metadata are surfaced back through the tool card.

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
- Mode/config controls for Mode, Intensity, Web, Image, Voice, and Live Voice.
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
- A right-side live `AgentPanel` host for the selected/draft chat, plus run cards on the dashboard.

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
- The native session uses `free` mode by default so Simple Mode does not show tool-confirmation popups to non-technical users.
- The initial prompt is `AgentInitialContent::ContentBlock { auto_submit: true }`.
- The beginner feed observes the same `AcpThread` entries as native chat but hides thought-only chunks and simplifies tool labels.
- The file changes panel watches the active thread action log, not a separate file-scanning runtime.
- When the agent finishes, `open_web_app_if_present` searches the project root and one level of subdirectories for a `package.json` with a `"dev"` script or an `index.html`. It starts `npm run dev` for Next.js/Vite projects or sets `preview_url` to a `file://` URL for static HTML.
- Before starting a dev server, the code claims/reuses a session-specific port and kills only that port when needed.
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
- It pre-filters the cursor position, creates/reuses a cached Backboard assistant and thread, sends a FIM prompt, streams the response with early exit, filters and optionally chunks the completion, then inserts ghost text at the cursor.
- It does not use `backboard-ide-acp.py`, `AcpThread`, Agent Workspace, or CLI tools.

## Tooling, Permissions, And Modes

The active IDE runtime exposes Rust-native tool schemas and adapters. The older Python bridge exposed the CLI tool system; that path is historical.

### Tool Catalog

`backboard_native/tool_schemas.rs` and `backboard_native/tools.rs` provide the active native catalog:

- Read/search: `read_file`, `list_dir`, `glob`, `grep`, `codebase_search`, `read_lints`.
- File mutation: `write`, `edit`, `search_replace`, `delete_file`, `create_directory`.
- Shell: `bash`, `run_terminal_cmd`.
- Flow: `todo_write`.

The native runtime filters definitions before sending them to the backend so the model sees only tools allowed for the current mode/config. MCP, browser, web fetch/search, RLM/subagents, notebook tools, and the CLI skill system are not fully ported into the Rust-native tool layer.

### Mode Restrictions

| Mode | Native runtime behavior |
|------|-----------------|
| `ask` | Blocks mutating file tools and shell tools; read/search/explain tools remain available. |
| `manual` | Focused edit proposal mode; shell tools are hidden/blocked. |
| `agent` | Autonomous coding mode; risky shell commands ask permission unless classified safe read-only. |
| `free` / `Full Access` | Full tool access; routine shell approvals are bypassed. This is the default for new Backboard sessions. |

Ask/Manual/Agent/Free are ACP session modes, not separate backend products. They change tool availability and approval behavior before the request reaches the model.

### File Tool Adapters

The native tool layer has dedicated adapters for IDE-safe file changes:

- `write`, `edit`, and `search_replace` compute diffs and use `AcpThread::write_text_file` for existing-file writes.
- `delete_file` emits diff/tool updates, then deletes the path.
- `create_directory` has a dedicated directory path.
- New files and deletes currently use direct filesystem operations plus ACP tool/diff updates.

Path handling should remain workspace/worktree confined for mutations. Agent Workspace runs must keep writes inside each run's assigned worktree or current-workspace path.

### Shell Policy

Shell tools are intentionally stricter than file/search tools:

- Native shell classification auto-approves simple read-only commands such as safe `git`, `ls`, `pwd`, `cat`, `sed`, `rg`, and similar inspection commands.
- Commands with shell metacharacters, destructive flags, network mutation, dangerous git operations, or sensitive paths do not get read-only auto-approval.
- `agent` mode asks the IDE for approval before risky shell execution.
- `free` mode bypasses routine shell approvals.

Timeout classes:

- Read-only commands get short timeouts.
- Normal commands get bounded timeouts.
- Test/build/check commands can get longer timeouts.
- Install commands get longer still.
- Dev-server commands get a startup window, then are stopped so the turn does not hang on a never-ending server process.

### Tool Batching And Output Compression

The native runtime optimizes read-heavy tool turns:

- Consecutive read-only IDE tools can run in parallel.
- Mutating tools, shell tools, and todos remain sequential.
- Tool outputs are compressed before being returned to the model to avoid flooding the next prompt.

This is why a turn can show one grouped exploration row in the UI even when the model actually read several files and ran searches underneath.

### ACP Rendering Hooks

Important native update paths:

- Shell tool execution creates display-only terminal cards through `TerminalProviderEvent`.
- Terminal output/exit metadata is routed into `acp_thread/src/terminal.rs`.
- `todo_write` output becomes ACP plan entries.
- `usage_update` carries context-window tokens and cost.
- `usage_update._meta.backboard_speed` carries native timing buckets parsed by `acp_thread::SpeedMetrics`.
- Backboard progress thoughts use `_meta.backboardProgress` so `AcpThread` can keep them separate from normal assistant text.

## Backboard Agent Server

File:

- `ide/zed/crates/agent_servers/src/backboard.rs`

Main types/constants:

- `BACKBOARD_AGENT_ID = "backboard"`
- `BACKBOARD_AGENT_NAME = "Backboard"`
- `BackboardAgentServer`

The server implements Zed's `AgentServer` trait. It returns Backboard as the native agent and defaults to ACP mode `free`. Agent Workspace can construct a Backboard server instance with a different default mode for a retained thread.

When `connect` runs:

- It logs `Backboard IDE runtime: using native Rust AgentConnection, not Python ACP/CLI bridge`.
- It returns `Rc<BackboardNativeConnection>` from `crate::backboard_native::BackboardNativeConnection::new(...)`.
- It does not build an `AgentServerCommand`.
- It does not launch `ide/zed/script/backboard-ide-acp.py`.
- It does not resolve `BACKBOARD_CLI_ROOT`, `BACKBOARD_CLI_PATH`, or `BACKBOARD_IDE_PYTHON` for active chat.

This file should remain the Rust boundary between Zed's agent-server registry and Backboard's native `AgentConnection`.

## Historical Python ACP Bridge

File:

- `ide/zed/script/backboard-ide-acp.py`

This section is retained as branch-history/reference material only. Do not use it as the active runtime map.

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

### Historical Rationale For The Python Bridge

Python was chosen for the first serious milestone because the existing Backboard CLI was already Python and already owned the hard parts:

- agent engine
- Backboard API client behavior
- tool definitions and execution
- MCP manager
- skills
- subagents
- codebase/search/indexing behavior
- memories/config/model defaults
- cancellation/tool orchestration patterns

Keeping the ACP bridge in Python let the IDE call the same runtime directly instead of rewriting or re-modeling all of that in Rust. That reduced early product risk: the IDE got closer to CLI parity quickly, and fixes to the agent runtime still lived in one source of truth.

The later Rust-native path became the active direction because:

- startup latency and packaging needed to stop depending on Python/CLI resources for core chat
- Rust endpoint coverage became broad enough for the IDE runtime
- native ACP/thread state, metrics, tool schemas, and workspace indexing could be kept inside the Zed process
- Agent Workspace and Simple Mode needed tighter coupling to the live `AgentPanel`

Current boundary: Rust owns the Backboard IDE chat runtime (`backboard_native/*`), ACP-thread rendering, native tools, workspace indexing, and UI state. Python remains a historical parity reference plus standalone CLI runtime, not the active IDE bridge.

### Config And API Key

Shared config path:

- `~/.backboard/config.json`

The historical bridge used that config for provider/model defaults and the Backboard API key through the CLI config/client. The native runtime now reads the same Backboard config concepts through Rust-side config/client code. Do not print or copy the API key into docs, logs, or UI. If another model needs to debug key loading, inspect config shape only and redact secrets.

Session mapping path:

- `~/.backboard/ide_sessions.json`

The historical bridge persisted IDE session mappings with:

- ACP session id
- workspace path
- Backboard assistant id
- Backboard thread id
- provider
- model
- title

### Models

ACP model methods included:

- `session/set_model`
- model state reporting from `BackboardIdeSession.model_state()`

Model ids are represented as:

- `provider/model`

If the model list API failed, the historical bridge fell back to defaults from `~/.backboard/config.json` or hardcoded defaults:

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

The chat composer now exposes native Backboard config chips for `Mode`, `Intensity`, `Web`, `Image`, `Voice`, and `Live Voice`. `Intensity` is separate from model selection and is meant to control speed/cost feel by changing how much extra reasoning/work the native runtime requests when supported.

Relevant files:

- Native state and behavior: `ide/zed/crates/agent_servers/src/backboard_native/mod.rs`
- Native feature/options plumbing: `ide/zed/crates/agent_servers/src/backboard_native/tool_schemas.rs`
- Config option UI: `ide/zed/crates/agent_ui/src/config_options.rs`
- Composer/model selector UI: `ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- Branded model selector trigger: `ide/zed/crates/agent_ui/src/model_selector_popover.rs`

ACP surface:

- `BackboardNativeConnection` exposes `backboard_mode`, `backboard_intensity`, `backboard_web`, `backboard_image`, `backboard_voice`, and `backboard_live_voice`.
- `session/set_config_option` updates native session state and emits a current-mode/options refresh.
- The intensity option uses ACP category `thought_level`, so the Rust UI labels it as `Intensity: Fast`, `Intensity: Balanced`, or `Intensity: Deep`.

Current behavior:

- Default runtime mode is `free`.
- `Fast`, `Balanced`, and `Deep` are carried in the native request/session state instead of the Python `_thinking_payload()` path.
- Web/Image/Voice/Live Voice feature chips feed native request metadata and stream handling.

Important nuance:

- Intensity does not change the selected model.
- Intensity does not expose private chain-of-thought.
- Intensity only affects request metadata/payload where the selected provider/model supports thinking-style options. If a provider ignores those fields, the UI may still change while model behavior does not materially change.
- Model selector and config options must coexist. `agent_servers/src/acp.rs::config_state()` intentionally preserves modes/models even when `configOptions` are present; otherwise the Backboard model popup falls back to `Select model` and cannot open correctly.

### Modes

Backboard IDE modes are enforced in the native runtime:

- `agent`: full tool access, with command approval.
- `ask`: read/search only. Mutating tools and shell tools are blocked.
- `manual`: file edit proposal flow, shell/subagent tasks blocked.
- `free`: unrestricted tool access, and shell commands run without approval prompts.

Mode-blocked tool sets:

- `Ask`: blocks mutating tools and shell tools.
- `Manual`: blocks shell tools and unported task/subagent-style tools.
- `Free`: default for Backboard Studio and bypasses shell approval prompts.

### File Writes And Command Safety

Current native behavior:

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

Shell tools:

- `bash`
- `run_terminal_cmd`

Read-only auto-approval is intentionally conservative. The native runtime auto-approves simple commands such as `pwd`, `ls`, `cat`, `rg`, `grep`, `head`, `tail`, `wc`, `stat`, `file`, safe `find`, safe `sed`, safe read-only `git` commands such as `git status`, `git diff`, `git log`, and `git show`, and safe-read `curl` invocations (`curl <url>`, `curl -L <url>`, `curl -I <url>`, `curl -X GET <url>`).

The native runtime does not auto-approve commands with shell control syntax, redirects, command substitution, package managers, GitHub mutation risk, or dangerous git operations. Examples that must keep asking for permission include:

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

The native runtime builds IDE/workspace prompt context in `backboard_native/workspace.rs` and session request metadata in `backboard_native/mod.rs`. The historical Python bridge appended similar guidance in `_ensure_thread_binding()`. Preserve these product rules when editing the native prompt path:

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

The native runtime also needs to preserve the website/app/UI quality profile that was introduced in the bridge era:

- injects frontend quality guidance into `<backboard_ide_context>`
- includes broader file context and semantic context when available
- sends a capped thinking payload equivalent to `Balanced`

This keeps normal IDE turns fast while making webpage generation closer to CLI quality. The separate `CLI_VS_IDE_SPEED_NOTES.md` explains why IDE turns feel faster now: native startup avoids Python/CLI process boot, and `Fast` mode trims unnecessary context/thinking for normal editor tasks.

### Live Progress

The native runtime avoids exposing private chain-of-thought. Instead it emits high-level progress notes and stream metadata through ACP:

- "Backboard is reading your request."
- "Backboard connected to the model."
- "Backboard is planning the next step."
- "Backboard is preparing tool actions."
- "Backboard is running N tool actions."
- "Waiting for approval: ..."
- "Applying `path`."

Expected progress behavior:

- Prompt/model/tool phases should produce visible status without leaking private reasoning.
- Tool preparation and command waits should surface as progress or tool cards, not hidden stalls.
- Completion, error, and cancel should stop active progress state cleanly.

This makes the chat feel alive during model reasoning, tool preparation, and command waits without showing private reasoning.

### Context Window Display

The chat footer renders the ACP thread token usage as a compact context-window control:

- percentage full
- used context tokens
- total context window tokens
- cumulative session cost when available

The native runtime emits this through ACP usage updates and native speed metadata. It should not create a visible `Usage` tool card. `acp_thread` accepts `UsageUpdate` and stores it in `TokenUsage`, which `conversation_view/thread_view.rs` renders next to the Backboard/model controls.

### Pricing / Cost Display

The active IDE runtime should prefer server-provided usage/cost data and native model metadata. Do not assume the native chat path imports CLI `PricingService`; that was the Python bridge implementation.

Native IDE behavior:

- `backboard_native/stream.rs` consumes usage, timing, and metadata chunks from the Backboard stream.
- `backboard_native/mod.rs` tracks turn timing buckets, first-token latency, tool counts, slowest tool, usage snapshots, and session totals where available.
- Server-provided cost fields such as `amount_deducted_usd`, `cost_usd`, `turn_cost_usd`, or `cost` should be forwarded into ACP usage/cost state when present.
- `acp_thread` stores this as `TokenUsage` / `SessionCost`.
- `thread_view.rs::render_token_usage()` shows `Session cost: $...` under context-window tokens and includes the same cost in the token tooltip when available.

Important nuance:

- This is a session display estimate unless the server included a billed amount.
- The CLI has a deeper reconciliation path through `/billing/usage/recent`; the IDE currently does not run that delayed reconciliation.
- Keep CLI pricing code unchanged unless the user explicitly asks for CLI work.

## Inline Autocomplete (Edit Predictions)

Backboard Studio includes a native inline autocomplete feature powered by the Backboard API. It shows ghost text at the cursor as you type, accepted with Tab, dismissed with Esc.

### Provider Routing

Zed's edit prediction system has an `EditPredictionProvider` enum in settings. The `Backboard` variant (serialized as `"backboard"`, also accepts legacy alias `"zed"`) is the Backboard provider:

- Settings: `"edit_predictions": { "provider": "backboard" }`
- Registry maps `EditPredictionProvider::Backboard` → `EditPredictionModel::Backboard`
- `EditPredictionStore` dispatches `EditPredictionModel::Backboard` → `BackboardCompletions::request_prediction()`

The `"zed"` alias is kept for backward compatibility with existing settings files. New settings should use `"backboard"`.

### API Flow

The provider uses cached assistants plus short-lived reusable completion threads:

1. Cold start: `POST /api/assistants` creates a named assistant and caches it in a process-level `LazyLock` map keyed by API URL.
2. First completion for that assistant: `POST /api/assistants/{id}/threads` creates a thread and stores it with a creation timestamp.
3. Later completions: the thread is reused only while it matches the cached assistant and is younger than `THREAD_CACHE_TTL_SECS = 120`; after that the provider creates a fresh thread.
4. Every completion: `POST /api/threads/{id}/messages` with `stream=true` sends the FIM prompt and streams the completion.
5. Accepted inline text is published through `backboard_api::publish_inline_completion_output(...)` for IDE-side completion telemetry.

The assistant cache, thread cache, and model cache are process-static `LazyLock<Mutex<HashMap>>` maps. An in-flight guard (`BackboardRequestInFlightGuard`) ensures only one completion request is active per API URL at a time; a second trigger while one is in flight is silently dropped.

Auth: `X-API-Key: {user_key}` header on every request.

Model: resolved from user settings → cached model → current debug fallback. The live registry path is present historically, but the current code bypasses it and falls back to `claude-haiku-4-5-20251001` via Anthropic.

### Pre-Filter

Before making any HTTP request, `should_request_completion()` inspects the cursor position and skips positions where a completion would rarely be useful:

- Always triggers on a blank line after a line ending with `:` or `{` (function/class stubs).
- Always triggers after `.`, `(`, `=`, or ` =` (expression continuation).
- Skips mid-word positions (alphanumeric/underscore on both sides of cursor).
- Skips when the current line ends with `;` or `]`.

This avoids API calls for positions where completions are almost never useful.

### Pure Cursor Insertion

Completions use a Copilot-style pure insertion approach — the edit is always an empty-range replacement at the cursor:

```
(cursor_anchor..cursor_anchor, response_text)
```

The old range is always empty so the model can never delete existing text. This differs from Zed's native Zeta/Mercury approach which diffs the model output against a large editable region and can produce large deletions when general-purpose LLMs return unexpected text.

### Prompt Format

The prompt sent to Backboard uses a Fill-in-the-Middle (FIM) format with a windowed context:

```
System:
You are an inline code completion engine.
Return ONLY the exact code that should be inserted at the cursor.
Do not explain. Do not use markdown. Do not repeat the prefix. ...

User:
Complete the code at <cursor>.

Rules:
- Output only the code to insert at <cursor>.
- Do not include explanations or markdown.
- Keep the completion short.
- Return an empty string if no useful completion exists.

Language: {lang}

<prefix>
{code_before_cursor (max 600 bytes)}
</prefix>
<suffix>
{code_after_cursor (max 300 bytes)}
</suffix>
<cursor>
```

Context window is intentionally small: 600 bytes before the cursor and 300 bytes after. Larger windows cause chat models to regenerate whole file sections instead of producing targeted insertions.

### SSE Streaming And Early Exit

The completion endpoint is called with `stream=true`. The bridge reads SSE `data:` lines and returns early when:

- A `content_streaming` chunk arrives that brings the total accumulated text to ≥5 non-whitespace characters AND the accumulated text contains at least one newline.
- A `run_ended` event arrives.
- The configurable timeout elapses (default 20 seconds).

Early return avoids waiting for the full model response when a short, useful completion has already arrived. A fused `futures::select!` races the background stream against the timeout.

### Response Filtering

`filtered_function_completion_chunks()` gates whether a completion is shown, based on both the completion text and cursor context. A completion passes only when at least one of the following is true:

- Cursor is on a blank line (both the line before and line after the cursor are empty).
- Cursor is completing a function definition (last non-empty line before cursor starts with `fn`, `def`, `function`, etc.).
- Cursor is inside a function body (detected via brace depth for brace-style languages, indentation depth for Python/Ruby).
- The completion itself looks like a function definition or top-level definition (`class`, `struct`, `enum`, `interface`, `import`, etc.).

Additional rejections applied to the completion text before the context check:

- Empty or whitespace-only completions.
- Completions longer than 30 lines.
- Completions that duplicate existing code after the cursor (>40% non-empty line overlap).
- Completions that are prose rather than code (detected by phrase list, sentence structure heuristics, and absence of code symbols).
- Completions that echo prompt structure markers (`<|fim_prefix|>`, `<cursor>`, `File:`, `Language:`, etc.).

### Chunking

When a passing completion has more than 14 lines or 6 control-flow statements (`COMPLETION_CHUNK_LINE_THRESHOLD` / `COMPLETION_CHUNK_COMPLEXITY_THRESHOLD`), `split_completion_into_chunks()` breaks it into smaller pieces. Each chunk targets ~8 lines (`COMPLETION_TARGET_CHUNK_LINES`) and splits at blank lines, closing braces at depth ≤1, or when the line count hits the target.

### Model Resolution

`resolve_backboard_model()` picks the model in this order:

1. `edit_predictions.backboard.model` from user settings if non-empty.
2. Cached model from the previous completion in the same session.
3. Current debug fallback: `claude-haiku-4-5-20251001` via Anthropic provider.

Historical note: an earlier path queried the live model registry from `GET /models`; the current checked-in code bypasses that branch.

### BYOK Model

Completions are entirely BYOK (bring your own key). If no API key is configured, `request_prediction()` returns `Task::ready(Ok(None))` and no completion fires. HTTP 402 and 429 responses set `quota_exceeded = true` on the store, silently suppressing further completions for the session.

The user enters their key in: Settings → Editor → Edit Predictions → Configure Providers → Backboard AI.

The key is stored in the system keychain via `ApiKeyState` and can also be set via `BACKBOARD_API_KEY` environment variable.

### Configurable Settings

Users can override the API URL, model, and timeout in settings JSON:

```json
{
  "edit_predictions": {
    "provider": "backboard",
    "backboard": {
      "api_url": "https://app.backboard.io/api",
      "model": "claude-haiku-4-5-20251001",
      "timeout_ms": 20000
    }
  }
}
```

`api_url` defaults to `https://app.backboard.io/api`. `model` defaults to the `default_model` saved in `~/.backboard/config.json`; if that field is missing, the runtime setting starts empty and model resolution uses the cache/fallback path above. `timeout_ms` defaults to 20,000 (20 seconds).

### Key Files

| File | Role |
|------|------|
| `crates/edit_prediction/src/backboard.rs` | `BackboardCompletions`, BYOK API key, process-level assistant/thread/model caches, 120-second thread TTL, in-flight guard, pre-filter, FIM prompt builder, SSE streaming with early exit, inline output publishing, stricter prose/marker filter, chunk splitter |
| `crates/edit_prediction/src/edit_prediction.rs` | `EditPredictionModel::Backboard` variant, dispatch to `BackboardCompletions`, `backboard` field on `EditPredictionStore` |
| `crates/zed/src/zed/edit_prediction_registry.rs` | Maps `EditPredictionProvider::Backboard` (alias `"zed"`) → `EditPredictionModel::Backboard`, loads API token |
| `crates/settings_content/src/language.rs` | `BackboardSettingsContent` with `api_url`, `model`, and `timeout_ms` fields |
| `crates/language/src/language_settings.rs` | `BackboardSettings` runtime struct with `api_url`, `model`, `timeout_ms`; wired into `EditPredictionSettings` |
| `crates/settings_ui/src/pages/edit_prediction_provider_setup.rs` | Settings UI — shows only the Backboard AI API key card, all other providers removed |

### Testing Autocomplete

```sh
BACKBOARD_API_KEY=your_key cargo run -p zed
```

1. Set `"edit_predictions": { "provider": "backboard" }` in settings JSON (`Cmd+,`)
2. Open Settings → Editor → Edit Predictions → Configure Providers → paste API key
3. Open any code file, type the start of a function definition or an expression ending with `.`/`(`/`=`, pause ~1 second
4. Ghost text appears — Tab to accept, Esc to dismiss
5. `Cmd+Alt+Z` manually triggers a prediction

To watch API calls and filter decisions in real time:

```sh
BACKBOARD_API_KEY=your_key RUST_LOG=edit_prediction=debug cargo run -p zed 2>&1 | grep -i backboard
```

### Debugging Autocomplete

If no ghost text appears:

1. Confirm `"provider": "backboard"` (or the legacy `"zed"`) is set in edit predictions settings.
2. Confirm the API key is saved (Settings → Configure Providers should show "API Key Configured").
3. Check `RUST_LOG=edit_prediction=debug` output for `backboard: skipped` — the pre-filter may be rejecting the position.
4. Check for `backboard: filtered` log lines — the response filter may be rejecting the completion (`is_non_completion`, `filtered — no matching context`, etc.).
5. Check for Backboard API errors — 401 means the key format is wrong; 402/429 means quota exceeded and completions are suppressed for the session.

If completions delete or replace existing code:

1. Check `backboard.rs::request_prediction` — edits must be `(cursor_anchor..cursor_anchor, text)` not a range replacement.
2. Do not re-introduce `compute_edits` from `zeta.rs` — that function uses text diff and is designed only for fine-tuned Zeta/Mercury models, not general-purpose LLMs.

If completions fire in wrong positions (mid-word, after completed statements, etc.):

1. Check `should_request_completion()` in `backboard.rs` — the pre-filter should reject those positions.
2. The filter is intentionally conservative; new trigger conditions should be added there, not removed.

If completions show LLM prose or prompt echo instead of code:

1. Check `is_non_completion()` and `contains_prose_like_line()` in `backboard.rs`.
2. Add the offending phrase to the `prose_phrases` list or the prompt-echo detector in `is_non_completion`.

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

Native runtime entry:

- The Rust server constructs `BackboardNativeConnection` directly from `ide/zed/crates/agent_servers/src/backboard.rs`.
- The conceptual CLI entry `backboard ide acp` and `script/backboard-ide-acp.py` remain historical bridge references only.
- The active chat path does not need `BACKBOARD_IDE_ACP_PATH`, `BACKBOARD_CLI_ROOT`, `BACKBOARD_CLI_PATH`, or `BACKBOARD_IDE_PYTHON`.

## Important Ownership Notes

The native IDE runtime is the active source-of-truth for Backboard Studio chat:

- tools
- ACP stream translation
- workspace indexing and `codebase_search`
- Backboard Rust API client integration
- mode/config feature chips
- usage/speed/media stream metadata
- model config

The IDE layer is source-of-truth for:

- native ACP connection behavior
- chat UX
- progress/timeline presentation
- command approval UI
- diff/tool rendering
- multi-agent workspace dashboard
- Zed/Backboard branding in the editor

The CLI is still valuable reference material for MCP, skills, subagents, richer semantic search, and standalone agent behavior. Do not treat it as the active IDE runtime unless the user explicitly asks to revive that path.

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

The native runtime is still catching up to some historical CLI/bridge depth:

- MCP/browser/web fetch/RLM/subagents/notebook/skills are not fully ported into `backboard_native/*`.
- Some CLI tool shapes may need Rust-native adapters over time.
- File writes auto-apply because the user requested not to approve writes.
- Commands require approval outside `free`; `free` mode intentionally bypasses shell approval prompts.

## Build / Verification Commands

Run from:

- `ide/zed/`

Useful checks:

```sh
cargo check --locked -p agent_ui
cargo check --locked -p agent_ui -p agent_servers -p acp_thread
cargo test -p agent_ui --no-fail-fast workspace_agent
cargo test -p agent_servers backboard_native --lib
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
rg -n "BackboardNativeConnection|backboard_native|usage_update|codebase_search|Live Voice|backboard_mode" BACKBOARD_IDE_HANDOFF.md
markdownlint BACKBOARD_IDE_HANDOFF.md
```

`markdownlint` is optional because it may not be installed in every local checkout. If it is missing, manually inspect table pipes, heading spacing, and fenced code blocks.

## Debugging / Maintenance Playbook

Use this table when you need to decide where to start. The deeper step-by-step guide follows immediately after it.

| Symptom | First files to inspect | Likely failure boundary |
|---------|------------------------|-------------------------|
| Missing API key, wrong env, or 401/402 on first turn | `ide/zed/crates/backboard/src/backboard.rs`, `ide/zed/crates/backboard/src/endpoints/**`, `backboard_native/mod.rs` | Rust config/API-key validation |
| Native runtime cannot start | `ide/zed/crates/agent_servers/src/backboard.rs`, `ide/zed/crates/agent_servers/src/backboard_native/mod.rs` | `BackboardNativeConnection` construction, config loading, session init |
| Model selector empty or config option missing | `backboard_native/mod.rs`, `agent_servers/src/acp.rs`, `conversation_view.rs`, `config_options.rs` | ACP model/config state transport |
| Tool permission card stuck | `backboard_native/tools.rs`, `agent_servers/src/acp.rs::handle_request_permission`, `acp_thread.rs::request_tool_call_authorization`, `thread_view.rs` | Native permission round trip |
| File edit did not appear in IDE diff | `backboard_native/tools.rs`, `agent_servers/src/acp.rs::handle_write_text_file`, `acp_thread.rs::write_text_file` | Native tool adapter or IDE-owned file write |
| Terminal card missing or output appears late | `backboard_native/tools.rs`, `backboard_native/stream.rs`, `agent_servers/src/acp.rs::handle_session_notification`, `acp_thread/src/terminal.rs` | Terminal metadata or terminal provider buffering |
| Agent Workspace apply/review is wrong | `agent_panel.rs`, `agent_workspace_ui.rs`, `agent_diff.rs` | Worktree metadata, batch conflict detection, patch application |
| Context/cost/speed display wrong | `backboard_native/stream.rs`, `backboard_native/mod.rs`, `acp_thread.rs::SpeedMetrics`, `thread_view.rs::render_token_usage` | ACP `usage_update` / `backboard_speed` payload or UI footer rendering |
| Autocomplete not firing | `edit_prediction/src/backboard.rs`, edit-prediction registry/settings files | Separate Backboard API completion path, not ACP; check pre-filter log (`backboard: skipped`) and response filter log (`backboard: filtered`) |

Maintenance rules:

- Keep `cli/` unchanged unless the user explicitly asks for CLI work.
- Prefer adding IDE adapters in `backboard_native/tools.rs` / `tool_schemas.rs` when a tool needs special IDE rendering.
- Keep `fs/write_text_file` as the preferred write path for Backboard chat/Agent Workspace file edits.
- Do not expose private reasoning text; progress/thought chunks should stay summarized.
- Preserve retry guards that prevent duplicate streamed messages or duplicate tool-output submissions.
- Keep mode restrictions enforced before tools are sent to the backend.
- Treat Agent Workspace current-workspace runs and git-worktree runs differently; only worktree runs can be applied.

## Debugging Guide

If Backboard fails to launch:

1. Check `ide/zed/crates/agent_servers/src/backboard.rs`.
2. Confirm `BackboardAgentServer::connect()` returns `BackboardNativeConnection`.
3. Check `ide/zed/crates/agent_servers/src/backboard_native/mod.rs`.
4. Confirm `~/.backboard/config.json` exists and contains valid Backboard config.
5. Check logs for `Backboard IDE runtime: using native Rust AgentConnection`.

If chat is blank or stuck:

1. Check `ide/zed/crates/agent_servers/src/backboard_native/stream.rs`.
2. Check `ide/zed/crates/agent_servers/src/backboard_native/mod.rs`.
3. Confirm assistant/thread binding is created or restored.
4. Confirm stream chunks are mapped into `AcpThread` updates.
5. Check model/config state transport through `session/set_model` and `session/set_config_option`.

If the model popup does not open:

1. Check `ide/zed/crates/agent_ui/src/model_selector_popover.rs`.
2. Confirm the Backboard pill is rendering `ModelSelectorPopover`, not a custom `div`.
3. Check `ModelSelectorPopover::set_trigger_brand(...)`.
4. Check `conversation_view.rs` still creates `model_selector` when ACP `models` are present.
5. Check `agent_servers/src/acp.rs::config_state()` preserves `models` even when `configOptions` are present.

If file writes do not appear:

1. Check `backboard_native/tools.rs`.
2. Check `agent_servers/src/acp.rs::handle_write_text_file`.
3. Check `acp_thread.rs::write_text_file`.
4. Check native diff/tool metadata shape.
5. Check `thread_view.rs` diff/tool rendering.

If commands do not ask approval outside `free` mode:

1. Check native shell tool classification in `backboard_native/tools.rs`.
2. Check mode state in `backboard_native/mod.rs`.
3. Check permission request emission.
4. Check `conversation_view.rs` permission request routing.
5. Do not bypass command approval outside `free` mode.

If pricing/cost does not show:

1. Check `backboard_native/stream.rs` usage/cost chunk handling.
2. Check `backboard_native/mod.rs` usage snapshot/session total handling.
3. Confirm ACP `usage_update` includes `cost` when server data is present.
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

1. Check `ide/zed/crates/agent_servers/src/backboard_native/mod.rs`.
2. Per-turn timings are collected in native turn metrics and emitted on `usage_update._meta.backboard_speed`.
3. The footer reads those metrics through `acp_thread::SpeedMetrics` and `thread_view.rs::render_token_usage()`.
4. Important timing keys: `runtime_load_ms`, `model_list_ms`, `assistant_create_ms`, `context_pack_ms`, `semantic_context_ms`, `first_token_ms`, `tool_batch_ms`, `shell_tools_ms`, `read_tools_ms`, `search_tools_ms`, `edit_tools_ms`, `other_tools_ms`, `slowest_tool`, `slowest_tool_ms`, `file_write_ms`, `command_wait_ms`, and `total_turn_ms`.
5. If `first_token_ms` is high while local timings are low, the delay is provider/model latency rather than IDE setup.

If every prompt appears to rebuild Backboard setup:

1. Check native session reuse in `backboard_native/mod.rs`.
2. Check assistant/thread binding and session-store restoration.
3. Check native tool-schema reuse in `backboard_native/tool_schemas.rs`.
4. MCP startup is not yet the active native path; do not debug native startup by chasing the old Python MCP manager first.

If the model keeps manually exploring too much:

1. Check `backboard_native/workspace.rs`.
2. Check `backboard_native/index.rs` and `.backboard_index/codebase_index.json`.
3. The native workspace context should include bounded file tree/package/git/project-rule/editor context, plus native index hits when available.
4. Keep context pack limits bounded so context help does not become context drag.

If read/search tool batches are slow:

1. Check `backboard_native/tools.rs`.
2. Check `backboard_native/index.rs` for `codebase_search` index availability and lexical fallback.
3. Writes, shell commands, and todos must remain approval/mode-safe.
4. Tool outputs should stay compact before being returned to the model.

If shell commands are slow:

1. Check shell handling in `backboard_native/tools.rs`.
2. Command timeout defaults are capped by command type: read-only commands are short, normal commands are bounded, install/check commands get more time, and dev-server commands get only a startup window.
3. Long-running dev-server commands such as `npm run dev`, `pnpm dev`, `vite`, `next dev`, and `python -m http.server` are stopped after the startup window so the agent does not sit on a never-ending process.
4. Dev-server detection also handles the common `cd <dir> && npm run dev ... &` shape, but the system prompt tells agents not to append `&`.
5. If a background child keeps stdout/stderr open after the shell exits, native command handling should cancel output pump tasks after a short drain window so the prompt lock can release.
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

- `ide/zed/crates/agent_servers/src/backboard_native/mod.rs`
  - Active native Backboard runtime: session lifecycle, assistant/thread binding, mode/config options, cancellation, feature settings, model state, usage snapshots, native turn metrics, and session-list integration.
  - Default runtime mode is `free`, and Agent Workspace can provide per-run defaults.

- `ide/zed/crates/agent_servers/src/backboard_native/stream.rs`
  - Maps Backboard streaming chunks into ACP-visible text, progress, media/resource links, STT/TTS stream chunks, usage updates, and `backboard_speed` metadata.

- `ide/zed/crates/agent_servers/src/backboard_native/tools.rs`
  - Active Rust-native tool executor for file reads/writes/search, shell commands, todos, and mode-aware permission behavior.

- `ide/zed/crates/agent_servers/src/backboard_native/tool_schemas.rs`
  - Active Rust-native tool schema catalog, including read/search, mutation, shell, todo, and expanded Backboard feature/tool metadata.

- `ide/zed/crates/agent_servers/src/backboard_native/workspace.rs`
  - Builds bounded workspace context for native Backboard turns.

- `ide/zed/crates/agent_servers/src/backboard_native/session_store.rs`
  - Persists/restores native IDE session metadata.

- `ide/zed/crates/agent_servers/src/backboard_native/index.rs`
  - Builds and queries the background native codebase index under `.backboard_index/codebase_index.json`; `codebase_search` uses it before lexical fallback.

- `ide/zed/script/backboard-ide-acp.py`
  - Historical Python JSON-RPC stdio bridge. It is no longer launched by the active Backboard chat runtime.
  - Keep it as behavioral reference for older CLI parity, MCP/subagent/skills behavior, and branch history.

- `ide/zed/crates/agent_servers/src/backboard.rs`
  - Rust `AgentServer` implementation for the native Backboard agent.
  - Returns `BackboardNativeConnection`, exposes Backboard as the visible native agent, logs the native runtime path, and supports Agent Workspace sessions with alternate native default modes.

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
  - Renders ACP config option controls such as Backboard `Mode`, `Intensity`, `Web`, `Image`, `Voice`, and `Live Voice`.
  - Current dirty work adds Agent Options row cycling and custom picker popover ids so the compact session chips behave consistently.

### Agent Workspace And Retained Runtime

- `ide/zed/crates/agent_ui/src/agent_panel.rs`
  - Owns active and retained Backboard conversations.
  - Provides the Agent Workspace helper surface: spawn, activate, stop, retry, review, open worktree, apply, dismiss, and summarize Backboard workspace agents.
  - Creates isolated git worktrees for git-backed runs, preserves per-agent `work_dirs`, tracks batch/apply metadata, maps ACP thread state into card summaries, and keeps non-git runs in the current workspace with Apply disabled.
  - Current dirty work adds persisted draft thread id, draft-only New Chat behavior, first-prompt draft promotion, `auto_select` event semantics, and `created_at` ordering.

- `ide/zed/crates/agent_ui/src/agent_workspace_ui.rs`
  - Current full-page Multi-Agent workspace page.
  - Renders task input, mode/scope/type controls, dashboard counters, grouped cards, card controls, draft/new-chat state, live right-panel `AgentPanel`, and status strips.
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
  - Loads BYOK API key from keychain or `BACKBOARD_API_KEY`, calls `https://app.backboard.io/api`, caches assistants, reuses completion threads with a 120-second TTL, sends the FIM cursor prompt, publishes inline completion output, strips code fences/markers/prose, and returns pure cursor insertion edits.

- `ide/zed/crates/edit_prediction/src/edit_prediction.rs`
  - Adds `EditPredictionModel::Backboard`, stores `BackboardCompletions` on `EditPredictionStore`, and dispatches Backboard prediction requests.
  - Keeps Backboard edits as insertions at the cursor; do not reintroduce Zeta/Mercury diff-based replacement for Backboard completions.

- `ide/zed/crates/zed/src/zed/edit_prediction_registry.rs`
  - Routes serialized settings provider `EditPredictionProvider::Backboard` to `EditPredictionModel::Backboard`; legacy serialized alias `"zed"` is still accepted.
  - Loads the Backboard API token and presents Backboard as the active edit prediction model.

- `ide/zed/crates/settings_content/src/language.rs`
  - Adds serialized settings content for `edit_predictions.backboard.api_url`, `edit_predictions.backboard.model`, and `edit_predictions.backboard.timeout_ms`.

- `ide/zed/crates/language/src/language_settings.rs`
  - Adds runtime `BackboardSettings` defaults: API URL `https://app.backboard.io/api`, model from `~/.backboard/config.json` `default_model` when present, and timeout `20_000`.

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

- `ide/zed/assets/fonts/**`
  - Bundles Inter for UI and JetBrains Mono for buffer/editor typography.

- `ide/zed/assets/themes/backboard/backboard_tints.json`
  - Adds the Backboard Tints theme family.

- `ide/zed/assets/settings/default.json`, `ide/zed/assets/settings/initial_user_settings.json`
  - Defaults Backboard Studio visual settings, edit prediction provider `"backboard"`, and left-side docks for project, outline, collab, and git.

### Older Backboard API/UI Crates And Reference Notes

- `ide/zed/crates/backboard/src/backboard.rs`
  - Rust Backboard API/config client crate from the early integration.
  - Active native chat uses this Rust API/client layer plus `ide/zed/crates/backboard/src/endpoints/**`.

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

### Historical Python ACP Bridge (`ide/zed/script/backboard-ide-acp.py`)

- Historical bridge work added visible-history sanitization for prompt augmentation payloads:
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

- Historical Backboard ACP diagnostics write to `~/.backboard/logs/ide-agent.log`; native runtime diagnostics should be checked in Rust/Zed logs first.
- UI thread list persistence/visibility is backed by `sidebar_threads` in:
  - `~/Library/Application Support/Backboard Studio/db/0-dev/db.sqlite` (active data in this environment).
