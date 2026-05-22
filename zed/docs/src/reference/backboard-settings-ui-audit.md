---
title: Backboard Settings UI Audit
description: User-facing Backboard Studio settings tab cleanup checklist.
---

# Backboard Settings UI Audit

This audit covers the actual user-facing settings tab built in `crates/settings_ui/src/page_data.rs`, not every raw key in `assets/settings/default.json`. It is intended as the removal checklist for reworking the settings tab to show only Backboard-relevant settings.

## Remove First

These are visible settings or pages that should be removed from the Backboard settings tab first because the feature is gone, internal-only, or not a current product surface. Keeping the underlying settings parser is fine; this is about the UI.

Status: the first code pass removes the non-developer rows below from the settings tab. Developer rows remain gated to staff/debug builds.

| Page | Section | Setting | Path | Why remove from UI |
|---|---|---|---|---|
| Developer | Feature Flags | Feature Flags | `feature_flags` | Developer-only internals; keep only staff/debug builds. |
| Developer | Instrumentation | Performance Profiler | `instrumentation.performance_profiler.enabled` | Developer-only internals; keep only staff/debug builds. |
| General | Scoped Settings | Preview Channel | `preview_channel_settings` | Advanced inherited scoped-settings surface; not useful in Backboard settings tab yet. |
| General | Scoped Settings | Settings Profiles | `settings_profiles` | Advanced inherited scoped-settings surface; not useful in Backboard settings tab yet. |
| General | Privacy | Telemetry Diagnostics | `telemetry.diagnostics` | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| General | Privacy | Telemetry Metrics | `telemetry.metrics` | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| General | Auto Update | Auto Update | `auto_update` | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| AI | General | Disable AI | `disable_ai` | Global kill-switch remains supported internally, but it is not a normal user preference for Backboard's agent workspace. |
| Editor | Which-key Menu | Show Which-key Menu | `which_key.enabled` | Inherited key-discovery setting; not central to Backboard. |
| Editor | Which-key Menu | Menu Delay | `which_key.delay_ms` | Inherited key-discovery setting; not central to Backboard. |
| Panels | Collaboration Panel | Collaboration Panel Button | `collaboration_panel.button` | Panel for removed collaboration surface. |
| Panels | Collaboration Panel | Collaboration Panel Dock | `collaboration_panel.dock` | Panel for removed collaboration surface. |
| Panels | Collaboration Panel | Collaboration Panel Default Width | `collaboration_panel.dock` | Panel for removed collaboration surface. |
| Collaboration | Calls | Mute On Join | `calls.mute_on_join` | Calls/audio collaboration was removed. |
| Collaboration | Calls | Share On Join | `calls.share_on_join` | Calls/audio collaboration was removed. |
| Collaboration | Calls | Test Audio | Action | Calls/audio collaboration was removed. |
| Collaboration | Calls | Output Audio Device | `audio.experimental.output_audio_device` | Calls/audio collaboration was removed. |
| Collaboration | Calls | Input Audio Device | `audio.experimental.input_audio_device` | Calls/audio collaboration was removed. |
| Network | Network | Server URL | `server_url` | Internal deployment/API routing. |
| Languages & Tools | LSP Pull Diagnostics | Enabled | `diagnostics.lsp_pull_diagnostics.enabled` | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Languages & Tools | LSP Pull Diagnostics | Debounce | `diagnostics.lsp_pull_diagnostics.debounce_ms` | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Languages & Tools | LSP Highlights | Debounce | `lsp_highlight_debounce` | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Language Settings | Formatting | Use On Type Format | `languages.$(language).use_on_type_format` | LSP-backed formatting trigger; not needed for Backboard autocomplete. |
| Language Settings | Tasks | Prefer LSP | `languages.$(language).tasks.prefer_lsp` | LSP-backed task preference; not needed for Backboard autocomplete. |
| Language Settings | Miscellaneous | Code Lens | `code_lens` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | Miscellaneous | LSP Document Colors | `lsp_document_colors` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Enable Language Server | `languages.$(language).enable_language_server` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Language Servers | `languages.$(language).language_servers` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Linked Edits | `languages.$(language).linked_edits` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Go To Definition Fallback | `go_to_definition_fallback` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Go To Definition Scroll Strategy | `go_to_definition_scroll_strategy` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Semantic Tokens | `languages.$(language).semantic_tokens` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | LSP Folding Ranges | `languages.$(language).document_folding_ranges` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | LSP Document Symbols | `languages.$(language).document_symbols` | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP Completions | Enabled | `languages.$(language).completions.lsp` | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |
| Language Settings | LSP Completions | Fetch Timeout (milliseconds) | `languages.$(language).completions.lsp_fetch_timeout_ms` | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |
| Language Settings | LSP Completions | Insert Mode | `languages.$(language).completions.lsp_insert_mode` | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |

## AI Page Pass

This is the current one-by-one decision list for the AI page. The visible page should focus on Backboard's agent workspace, side panel/thread UI, tool execution behavior, context servers, and editor AI predictions.

| Setting | Path | Surface | Evidence | Decision |
|---|---|---|---|---|
| Disable AI | `disable_ai` | Internal global kill switch | Read by `crates/zed/src/zed.rs`, `crates/workspace/src/multi_workspace.rs`, `crates/project/src/context_server_store.rs`, and `crates/copilot/src/copilot.rs`. | Removed from user-facing AI page; keep parser/runtime support internally. |
| Threads Sidebar Side | `agent.sidebar_side` | Backboard side panel / thread sidebar | Read by `crates/workspace/src/multi_workspace.rs`, `crates/sidebar/src/sidebar.rs`, `crates/agent_ui/src/conversation_view.rs`, and `crates/agent_ui/src/threads_archive_view.rs`. | Keep public. |
| Tool Permissions | `agent.tool_permissions` | Native agent workspace tool approvals | Rendered by `crates/settings_ui/src/pages/tool_permissions_setup.rs`; applied in agent tool permission flow. | Keep public. |
| Single File Review | `agent.single_file_review` | Agent edit review UX | Read by `crates/agent_ui/src/agent_diff.rs`. | Keep public. |
| Enable Feedback | `agent.enable_feedback` | Agent response/edit feedback buttons | Read by `crates/agent_ui/src/conversation_view/thread_view.rs` and `crates/agent_ui/src/inline_prompt_editor.rs`. | Keep public if feedback remains a product signal; otherwise hide later with product approval. |
| Notify When Agent Waiting | `agent.notify_when_agent_waiting` | Agent waiting/confirmation notifications | Read by `crates/agent_ui/src/agent_panel.rs` and `crates/agent_ui/src/conversation_view.rs`. | Keep public. |
| Play Sound When Agent Done | `agent.play_sound_when_agent_done` | Agent completion/waiting notification sound | Read by `crates/agent_ui/src/agent_panel.rs` and `crates/agent_ui/src/conversation_view.rs`. | Keep public. |
| Expand Edit Card | `agent.expand_edit_card` | Agent thread edit-card display | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public. |
| Expand Terminal Card | `agent.expand_terminal_card` | Agent thread terminal-card display | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public. |
| Thinking Display | `agent.thinking_display` | Agent reasoning block display | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public. |
| Cancel Generation On Terminal Stop | `agent.cancel_generation_on_terminal_stop` | Terminal tool behavior inside agent turns | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public. |
| Use Modifier To Send | `agent.use_modifier_to_send` | Agent message editor send behavior | Read by `crates/agent_ui/src/message_editor.rs`. | Keep public. |
| Message Editor Min Lines | `agent.message_editor_min_lines` | Agent message editor layout | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public. |
| Show Turn Stats | `agent.show_turn_stats` | Agent thread timing/stat display | Read by `crates/agent_ui/src/conversation_view/thread_view.rs`. | Keep public or move to advanced agent behavior. |
| Show Merge Conflict Indicator | `agent.show_merge_conflict_indicator` | Agent-assisted Git conflict resolution | Read by `crates/git_ui/src/conflict_view.rs`. | Keep public because it connects Git and agent workflow. |
| Context Server Timeout | `context_server_timeout` | Context server / MCP tool calls | Read by `crates/project/src/context_server_store.rs` through project settings resolution. | Keep public. |
| Configure Providers | `edit_predictions.providers` | Backboard AI API key setup for edit predictions | Rendered by `crates/settings_ui/src/pages/edit_prediction_provider_setup.rs`. | Keep editor AI. |
| Data Collection | `edit_predictions.allow_data_collection` | Edit prediction data sharing preference | Merged into `AllLanguageSettings` in `crates/language/src/language_settings.rs`. | Keep only while edit predictions are public. |
| Show Edit Predictions | `languages.$(language).show_edit_predictions` | Editor AI prediction visibility | Read by `crates/editor/src/editor.rs` and toggled by `crates/edit_prediction_ui/src/edit_prediction_button.rs`. | Keep editor AI. |
| Disable in Language Scopes | `languages.$(language).edit_predictions_disabled_in` | Advanced editor AI exclusions | Read by `crates/editor/src/editor.rs`. | Keep advanced editor AI. |
| Display Mode | `edit_predictions.mode` | Edit prediction preview behavior | Read by `crates/language/src/language_settings.rs` and updated by `crates/edit_prediction_ui/src/edit_prediction_button.rs`. | Keep editor AI; path corrected from stale `edit_prediction.display_mode`. |

## Command Palette And Keybindings Pass

| Surface | Action group | Decision | Evidence |
|---|---|---|---|
| Command palette | `lsp_tool::*` | Hidden from user view | Backboard edit predictions do not use LSP completions or language-server context. |
| Keybindings editor | `lsp_tool::*` | Hidden from user view | The keybindings editor now applies the command palette visibility filter before listing mapped or unmapped actions. |
| Command palette and keybindings editor | `collab::*`, `collab_panel::*`, `channel_modal::*`, `repl::*`, `journal::*`, `notebook::*`, `settings_profile_selector::*`, `feedback::*`, `remote_debug::*`, `dev::*` | Hidden from user view | These are removed, internal, Zed-specific, or non-Backboard product surfaces. |
| Command palette and keybindings editor | `zed::...`, `zed_*::...` display labels | Reworded for Backboard | `command_palette::humanize_action_name` now renders these as Backboard-facing labels while retaining raw action IDs for keymap JSON compatibility. |

## Pre-Cleanup User-Facing Inventory

| Page | Section | Setting | Path | Recommendation | Reason |
|---|---|---|---|---|---|
| Developer | Feature Flags | Feature Flags | `feature_flags` | Remove from normal UI | Developer-only internals; keep only staff/debug builds. |
| Developer | Instrumentation | Performance Profiler | `instrumentation.performance_profiler.enabled` | Remove from normal UI | Developer-only internals; keep only staff/debug builds. |
| General | Mode | Interface Mode | Action | Keep | Core startup/security/restore behavior. |
| General | General Settings | When Closing With No Tabs | `when_closing_with_no_tabs` | Keep advanced editor only | Window/app-shell behavior, not Backboard-first. |
| General | General Settings | On Last Window Closed | `on_last_window_closed` | Keep advanced editor only | Window/app-shell behavior, not Backboard-first. |
| General | General Settings | Use System Path Prompts | `use_system_path_prompts` | Keep advanced editor only | Window/app-shell behavior, not Backboard-first. |
| General | General Settings | Use System Prompts | `use_system_prompts` | Keep advanced editor only | Window/app-shell behavior, not Backboard-first. |
| General | General Settings | Redact Private Values | `redact_private_values` | Keep | Relevant to project privacy or CLI workflow. |
| General | General Settings | Private Files | `worktree.private_files` | Keep | Relevant to project privacy or CLI workflow. |
| General | General Settings | CLI Default Open Behavior | `cli_default_open_behavior` | Keep | Relevant to project privacy or CLI workflow. |
| General | Security | Trust All Projects By Default | `session.trust_all_projects` | Keep | Core startup/security/restore behavior. |
| General | Workspace Restoration | Restore Unsaved Buffers | `session.restore_unsaved_buffers` | Keep | Core startup/security/restore behavior. |
| General | Workspace Restoration | Restore On Startup | `restore_on_startup` | Keep | Core startup/security/restore behavior. |
| General | Scoped Settings | Preview Channel | `preview_channel_settings` | Remove for now | Advanced inherited scoped-settings surface; not useful in Backboard settings tab yet. |
| General | Scoped Settings | Settings Profiles | `settings_profiles` | Remove for now | Advanced inherited scoped-settings surface; not useful in Backboard settings tab yet. |
| General | Privacy | Telemetry Diagnostics | `telemetry.diagnostics` | Remove | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| General | Privacy | Telemetry Metrics | `telemetry.metrics` | Remove | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| General | Auto Update | Auto Update | `auto_update` | Remove | Not a Backboard user workflow; needs product/legal/update-channel decision before exposure. |
| Appearance | Theme | Theme Mode | `theme$` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Theme | Icon Theme | `icon_theme$` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Font Family | `buffer_font_family` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Font Size | `buffer_font_size` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Font Weight | `buffer_font_weight` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Line Height | `buffer_line_height$` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Font Features | `buffer_font_features` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Buffer Font | Font Fallbacks | `buffer_font_fallbacks` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | UI Font | Font Family | `ui_font_family` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | UI Font | Font Size | `ui_font_size` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | UI Font | Font Weight | `ui_font_weight` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | UI Font | Font Features | `ui_font_features` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | UI Font | Font Fallbacks | `ui_font_fallbacks` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Agent Panel Font | UI Font Size | `agent_ui_font_size` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Agent Panel Font | Buffer Font Size | `agent_buffer_font_size` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Text Rendering | Text Rendering Mode | `text_rendering_mode` | Keep | Theme/font controls are user-facing and shared by simple/editor modes. |
| Appearance | Cursor | Multi Cursor Modifier | `multi_cursor_modifier` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Cursor | Cursor Blink | `cursor_blink` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Cursor | Cursor Shape | `cursor_shape` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Cursor | Hide Mouse | `hide_mouse` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Highlighting | Unnecessary Code Fade | `unnecessary_code_fade` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Highlighting | Current Line Highlight | `current_line_highlight` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Highlighting | Selection Highlight | `selection_highlight` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Highlighting | Rounded Selection | `rounded_selection` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Highlighting | Minimum Contrast For Highlights | `minimum_contrast_for_highlights` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Guides | Show Wrap Guides | `show_wrap_guides` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Appearance | Guides | Wrap Guides | `wrap_guides` | Keep advanced editor only | Editor polish controls, not Backboard-first settings. |
| Keymap | Keybindings | Edit Keybindings | Action | Keep advanced editor only | Keybindings are useful for editor users but not Backboard-first. |
| Keymap | Base Keymap | Base Keymap | `base_keymap` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Keymap | Modal Editing | Vim Mode | `vim_mode` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Keymap | Modal Editing | Helix Mode | `helix_mode` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Auto Save | Auto Save Mode | `autosave$` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Which-key Menu | Show Which-key Menu | `which_key.enabled` | Remove | Inherited key-discovery setting; not central to Backboard. |
| Editor | Which-key Menu | Menu Delay | `which_key.delay_ms` | Remove | Inherited key-discovery setting; not central to Backboard. |
| Editor | Multibuffer | Double Click In Multibuffer | `double_click_in_multibuffer` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Multibuffer | Expand Excerpt Lines | `expand_excerpt_lines` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Multibuffer | Excerpt Context Lines | `excerpt_context_lines` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Multibuffer | Expand Outlines With Depth | `outline_panel.expand_outlines_with_depth` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Multibuffer | Diff View Style | `diff_view_style` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Multibuffer | Minimum Split Diff Width | `minimum_split_diff_width` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Scroll Beyond Last Line | `scroll_beyond_last_line` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Vertical Scroll Margin | `vertical_scroll_margin` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Horizontal Scroll Margin | `horizontal_scroll_margin` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Scroll Sensitivity | `scroll_sensitivity` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Mouse Wheel Zoom | `mouse_wheel_zoom` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Fast Scroll Sensitivity | `fast_scroll_sensitivity` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Autoscroll On Clicks | `autoscroll_on_clicks` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrolling | Sticky Scroll | `sticky_scroll.enabled` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Signature Help | Auto Signature Help | `auto_signature_help` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Signature Help | Show Signature Help After Edits | `show_signature_help_after_edits` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Signature Help | Snippet Sort Order | `snippet_sort_order` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Hover Popover | Enabled | `hover_popover_enabled` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Hover Popover | Delay | `hover_popover_delay` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Hover Popover | Sticky | `hover_popover_sticky` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Hover Popover | Hiding Delay | `hover_popover_hiding_delay` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Drag And Drop Selection | Enabled | `drag_and_drop_selection.enabled` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Drag And Drop Selection | Delay | `drag_and_drop_selection.delay` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Show Line Numbers | `gutter.line_numbers` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Relative Line Numbers | `relative_line_numbers` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Show Runnables | `gutter.runnables` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Show Breakpoints | `gutter.breakpoints` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Show Bookmarks | `gutter.bookmarks` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Show Folds | `gutter.folds` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Min Line Number Digits | `gutter.min_line_number_digits` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Gutter | Inline Code Actions | `inline_code_actions` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Show | `scrollbar` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Cursors | `scrollbar.cursors` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Git Diff | `scrollbar.git_diff` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Search Results | `scrollbar.search_results` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Selected Text | `scrollbar.selected_text` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Selected Symbol | `scrollbar.selected_symbol` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Diagnostics | `scrollbar.diagnostics` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Horizontal Scrollbar | `scrollbar.axes.horizontal` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Scrollbar | Vertical Scrollbar | `scrollbar.axes.vertical` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Show | `minimap.show` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Display In | `minimap.display_in` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Thumb | `minimap.thumb` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Thumb Border | `minimap.thumb_border` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Current Line Highlight | `minimap.current_line_highlight` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Minimap | Max Width Columns | `minimap.max_width_columns` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Toolbar | Breadcrumbs | `toolbar.breadcrumbs` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Toolbar | Quick Actions | `toolbar.quick_actions` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Toolbar | Selections Menu | `toolbar.selections_menu` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Toolbar | Agent Review | `toolbar.agent_review` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Toolbar | Code Actions | `toolbar.code_actions` | Keep advanced editor only | Editor-mode behavior; not Backboard-first settings. |
| Editor | Vim | Default Mode | `vim.default_mode` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Toggle Relative Line Numbers | `vim.toggle_relative_line_numbers` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Use System Clipboard | `vim.use_system_clipboard` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Use Smartcase Find | `vim.use_smartcase_find` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Global Substitution Default | `vim.gdefault` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Highlight on Yank Duration | `vim.highlight_on_yank_duration` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Regex Search | `vim.use_regex_search` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Show Edit Predictions in Normal Mode | `vim.show_edit_predictions_in_normal_mode` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Cursor Shape - Normal Mode | `vim.cursor_shape.normal` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Cursor Shape - Insert Mode | `vim.cursor_shape.insert` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Cursor Shape - Replace Mode | `vim.cursor_shape.replace` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Cursor Shape - Visual Mode | `vim.cursor_shape.visual` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Editor | Vim | Custom Digraphs | `vim.custom_digraphs` | Keep advanced editor only | Useful only for editor power users; hide from simple Backboard settings. |
| Languages & Tools | File Types | File Type Associations | `file_type_associations` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Diagnostics | Max Severity | `diagnostics_max_severity` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Diagnostics | Include Warnings | `diagnostics.include_warnings` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Inline Diagnostics | Enabled | `diagnostics.inline.enabled` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Inline Diagnostics | Update Debounce | `diagnostics.inline.update_debounce_ms` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Inline Diagnostics | Padding | `diagnostics.inline.padding` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | Inline Diagnostics | Minimum Column | `diagnostics.inline.min_column` | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Languages & Tools | LSP Pull Diagnostics | Enabled | `diagnostics.lsp_pull_diagnostics.enabled` | Remove from user UI | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Languages & Tools | LSP Pull Diagnostics | Debounce | `diagnostics.lsp_pull_diagnostics.debounce_ms` | Remove from user UI | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Languages & Tools | LSP Highlights | Debounce | `lsp_highlight_debounce` | Remove from user UI | LSP does not feed Backboard edit predictions or agent autocomplete. |
| Languages & Tools | Languages | Languages & Tools | Action | Keep advanced editor only | Language tooling is editor-mode behavior. |
| Search & Files | Search | Whole Word | `search.whole_word` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Case Sensitive | `search.case_sensitive` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Use Smartcase Search | `use_smartcase_search` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Include Ignored | `search.include_ignored` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Regex | `search.regex` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Search Wrap | `search_wrap` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Center on Match | `editor.search.center_on_match` | Keep | Useful for projects and agent context. |
| Search & Files | Search | Seed Search Query From Cursor | `seed_search_query_from_cursor` | Keep | Useful for projects and agent context. |
| Search & Files | File Finder | Include Ignored in Search | `file_finder.include_ignored` | Keep | Useful for projects and agent context. |
| Search & Files | File Finder | File Icons | `file_finder.file_icons` | Keep | Useful for projects and agent context. |
| Search & Files | File Finder | Modal Max Width | `file_finder.modal_max_width` | Keep | Useful for projects and agent context. |
| Search & Files | File Finder | Skip Focus For Active In Search | `file_finder.skip_focus_for_active_in_search` | Keep | Useful for projects and agent context. |
| Search & Files | File Scan | File Scan Exclusions | `file_scan_exclusions` | Keep | Useful for projects and agent context. |
| Search & Files | File Scan | File Scan Inclusions | `file_scan_inclusions` | Keep | Useful for projects and agent context. |
| Search & Files | File Scan | Restore File State | `restore_on_file_reopen` | Keep | Useful for projects and agent context. |
| Search & Files | File Scan | Close on File Delete | `close_on_file_delete` | Keep | Useful for projects and agent context. |
| Window & Layout | Status Bar | Project Panel Button | `project_panel.button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Active Language Button | `status_bar.active_language_button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Active Encoding Button | `status_bar.active_encoding_button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Cursor Position Button | `status_bar.cursor_position_button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Line Endings Button | `status_bar.line_endings_button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Terminal Button | `terminal.button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Diagnostics Button | `diagnostics.button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Project Search Button | `search.button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Debugger Button | `debugger.button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Status Bar | Active File Name | `status_bar.show_active_file` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Branch Status Icon | `title_bar.show_branch_status_icon` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Branch Name | `title_bar.show_branch_name` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Project Items | `title_bar.show_project_items` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Onboarding Banner | `title_bar.show_onboarding_banner` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Sign In | `title_bar.show_sign_in` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show User Menu | `title_bar.show_user_menu` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show User Picture | `title_bar.show_user_picture` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Show Menus | `title_bar.show_menus` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Title Bar | Button Layout | `title_bar.button_layout$` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Show Tab Bar | `tab_bar.show` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Show Git Status In Tabs | `tabs.git_status` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Show File Icons In Tabs | `tabs.file_icons` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Tab Close Position | `tabs.close_position` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Maximum Tabs | `max_tabs` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Show Navigation History Buttons | `tab_bar.show_nav_history_buttons` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Show Tab Bar Buttons | `tab_bar.show_tab_bar_buttons` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Bar | Pinned Tabs Layout | `tab_bar.show_pinned_tabs_in_separate_row` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Settings | Activate On Close | `tabs.activate_on_close` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Settings | Tab Show Diagnostics | `tabs.show_diagnostics` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Tab Settings | Show Close Button | `tabs.show_close_button` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Preview Tabs Enabled | `preview_tabs.enabled` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Preview From Project Panel | `preview_tabs.enable_preview_from_project_panel` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Preview From File Finder | `preview_tabs.enable_preview_from_file_finder` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Preview From Multibuffer | `preview_tabs.enable_preview_from_multibuffer` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Preview Multibuffer From Code Navigation | `preview_tabs.enable_preview_multibuffer_from_code_navigation` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Preview File From Code Navigation | `preview_tabs.enable_preview_file_from_code_navigation` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Preview Tabs | Enable Keep Preview On Code Navigation | `preview_tabs.enable_keep_preview_on_code_navigation` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Layout | Bottom Dock Layout | `bottom_dock_layout` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Layout | Centered Layout Left Padding | `centered_layout.left_padding` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Layout | Centered Layout Right Padding | `centered_layout.right_padding` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Layout | Focus Follows Mouse | `focus_follows_mouse.enabled` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Layout | Focus Follows Mouse Debounce ms | `focus_follows_mouse.debounce_ms` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Window | Use System Window Tabs | `use_system_window_tabs` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Window | Window Decorations | `window_decorations` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Pane Modifiers | Inactive Opacity | `active_pane_modifiers.inactive_opacity` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Pane Modifiers | Border Size | `active_pane_modifiers.border_size` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Pane Modifiers | Zoomed Padding | `zoomed_padding` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Pane Split Direction | Vertical Split Direction | `pane_split_direction_vertical` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Window & Layout | Pane Split Direction | Horizontal Split Direction | `pane_split_direction_horizontal` | Keep advanced editor only | Mostly inherited shell/editor layout controls. |
| Panels | Project Panel | Project Panel Dock | `project_panel.dock` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Project Panel Default Width | `project_panel.default_width` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Hide .gitignore | `project_panel.hide_gitignore` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Entry Spacing | `project_panel.entry_spacing` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | File Icons | `project_panel.file_icons` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Folder Icons | `project_panel.folder_icons` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Git Status | `project_panel.git_status` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Indent Size | `project_panel.indent_size` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Auto Reveal Entries | `project_panel.auto_reveal_entries` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Starts Open | `project_panel.starts_open` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Auto Fold Directories | `project_panel.auto_fold_dirs` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Bold Folder Labels | `project_panel.bold_folder_labels` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Show Scrollbar | `project_panel.scrollbar.show` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Horizontal Scroll | `project_panel.scrollbar.horizontal_scroll` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Show Diagnostics | `project_panel.show_diagnostics` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Diagnostic Badges | `project_panel.diagnostic_badges` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Git Status Indicator | `project_panel.git_status_indicator` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Sticky Scroll | `project_panel.sticky_scroll` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Show Indent Guides | `project_panel.indent_guides.show` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Drag and Drop | `project_panel.drag_and_drop` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Hide Root | `project_panel.hide_root` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Hide Hidden | `project_panel.hide_hidden` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Sort Mode | `project_panel.sort_mode` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Sort Order | `project_panel.sort_order` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Auto Open Files On Create | `project_panel.auto_open.on_create` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Auto Open Files On Paste | `project_panel.auto_open.on_paste` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Auto Open Files On Drop | `project_panel.auto_open.on_drop` | Keep | Active Backboard workflow surface. |
| Panels | Project Panel | Hidden Files | `worktree.hidden_files` | Keep | Active Backboard workflow surface. |
| Panels | Terminal Panel | Terminal Dock | `terminal.dock` | Keep | Active Backboard workflow surface. |
| Panels | Terminal Panel | Terminal Panel Flexible Sizing | `terminal.flexible` | Keep | Active Backboard workflow surface. |
| Panels | Terminal Panel | Show Count Badge | `terminal.show_count_badge` | Keep | Active Backboard workflow surface. |
| Panels | Outline Panel | Outline Panel Button | `outline_panel.button` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Outline Panel Dock | `outline_panel.dock` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Outline Panel Default Width | `outline_panel.default_width` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | File Icons | `outline_panel.file_icons` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Folder Icons | `outline_panel.folder_icons` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Git Status | `outline_panel.git_status` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Indent Size | `outline_panel.indent_size` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Auto Reveal Entries | `outline_panel.auto_reveal_entries` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Auto Fold Directories | `outline_panel.auto_fold_dirs` | Keep advanced editor only | Editor navigation panel. |
| Panels | Outline Panel | Show Indent Guides | `outline_panel.indent_guides.show` | Keep advanced editor only | Editor navigation panel. |
| Panels | Git Panel | Git Panel Button | `git_panel.button` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Git Panel Dock | `git_panel.dock` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Git Panel Default Width | `git_panel.default_width` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Git Panel Status Style | `git_panel.status_style` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Fallback Branch Name | `git_panel.fallback_branch_name` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Sort By Path | `git_panel.sort_by_path` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Collapse Untracked Diff | `git_panel.collapse_untracked_diff` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Tree View | `git_panel.tree_view` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | File Icons | `git_panel.file_icons` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Folder Icons | `git_panel.folder_icons` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Diff Stats | `git_panel.diff_stats` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Show Count Badge | `git_panel.show_count_badge` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Commit Title Max Length | `git_panel.commit_title_max_length` | Keep | Active Backboard workflow surface. |
| Panels | Git Panel | Scroll Bar | `git_panel.scrollbar.show` | Keep | Active Backboard workflow surface. |
| Panels | Debugger Panel | Debugger Panel Dock | `debugger.dock` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Panels | Collaboration Panel | Collaboration Panel Button | `collaboration_panel.button` | Remove | Panel for removed collaboration surface. |
| Panels | Collaboration Panel | Collaboration Panel Dock | `collaboration_panel.dock` | Remove | Panel for removed collaboration surface. |
| Panels | Collaboration Panel | Collaboration Panel Default Width | `collaboration_panel.dock` | Remove | Panel for removed collaboration surface. |
| Panels | Agent Panel | Agent Panel Button | `agent.button` | Keep | Core AI/agent/product workflow. |
| Panels | Agent Panel | Agent Panel Dock | `agent.dock` | Keep | Core AI/agent/product workflow. |
| Panels | Agent Panel | Agent Panel Flexible Sizing | `agent.flexible` | Keep | Core AI/agent/product workflow. |
| Panels | Agent Panel | Agent Panel Default Width | `agent.default_width` | Keep | Core AI/agent/product workflow. |
| Panels | Agent Panel | Agent Panel Default Height | `agent.default_height` | Keep | Core AI/agent/product workflow. |
| Panels | Agent Panel | Limit Content Width | `agent.limit_content_width` | Keep | Core AI/agent/product workflow. |
| Debugger | General | Stepping Granularity | `debugger.stepping_granularity` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Debugger | General | Save Breakpoints | `debugger.save_breakpoints` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Debugger | General | Timeout | `debugger.timeout` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Debugger | General | Log DAP Communications | `debugger.log_dap_communications` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Debugger | General | Format DAP Log Messages | `debugger.format_dap_log_messages` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Terminal | Environment | Shell | `terminal.shell$` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Environment | Working Directory | `terminal.working_directory$` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Environment | Environment Variables | `terminal.env` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Environment | Detect Virtual Environment | `terminal.detect_venv` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Font | Font Size | `terminal.font_size` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Font | Font Family | `terminal.font_family` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Font | Font Fallbacks | `terminal.font_fallbacks` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Font | Font Weight | `terminal.font_weight` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Font | Font Features | `terminal.font_features` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Display Settings | Line Height | `terminal.line_height` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Display Settings | Cursor Shape | `terminal.cursor_shape` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Display Settings | Cursor Blinking | `terminal.blinking` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Display Settings | Alternate Scroll | `terminal.alternate_scroll` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Display Settings | Minimum Contrast | `terminal.minimum_contrast` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Behavior Settings | Option As Meta | `terminal.option_as_meta` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Behavior Settings | Copy On Select | `terminal.copy_on_select` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Behavior Settings | Keep Selection On Copy | `terminal.keep_selection_on_copy` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Behavior Settings | Audible Bell | `terminal.bell` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Layout Settings | Default Width | `terminal.default_width` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Layout Settings | Default Height | `terminal.default_height` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Advanced Settings | Max Scroll History Lines | `terminal.max_scroll_history_lines` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Advanced Settings | Scroll Multiplier | `terminal.scroll_multiplier` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Toolbar | Breadcrumbs | `terminal.toolbar.breadcrumbs` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Terminal | Scrollbar | Show Scrollbar | `terminal.scrollbar.show` | Keep | Needed for agent tools, tasks, previews, and developer workflows. |
| Version Control | Git Integration | Disable Git Integration | `git.disable_git` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Git Gutter | Visibility | `git.git_gutter` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Git Gutter | Debounce | `git.gutter_debounce` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Inline Git Blame | Enabled | `git.inline_blame.enabled` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Inline Git Blame | Delay | `git.inline_blame.delay_ms` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Inline Git Blame | Padding | `git.inline_blame.padding` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Inline Git Blame | Minimum Column | `git.inline_blame.min_column` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Inline Git Blame | Show Commit Summary | `git.inline_blame.show_commit_summary` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Git Blame View | Show Avatar | `git.blame.show_avatar` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Branch Picker | Show Author Name | `git.branch_picker.show_author_name` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Git Hunks | Hunk Style | `git.hunk_style` | Keep | Needed for worktrees, diff, blame, and source control. |
| Version Control | Git Hunks | Path Style | `git.path_style` | Keep | Needed for worktrees, diff, blame, and source control. |
| Collaboration | Calls | Mute On Join | `calls.mute_on_join` | Remove | Calls/audio collaboration was removed. |
| Collaboration | Calls | Share On Join | `calls.share_on_join` | Remove | Calls/audio collaboration was removed. |
| Collaboration | Calls | Test Audio | Action | Remove | Calls/audio collaboration was removed. |
| Collaboration | Calls | Output Audio Device | `audio.experimental.output_audio_device` | Remove | Calls/audio collaboration was removed. |
| Collaboration | Calls | Input Audio Device | `audio.experimental.input_audio_device` | Remove | Calls/audio collaboration was removed. |
| AI | General | Threads Sidebar Side | `agent.sidebar_side` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Tool Permissions | `agent.tool_permissions` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Single File Review | `agent.single_file_review` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Enable Feedback | `agent.enable_feedback` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Notify When Agent Waiting | `agent.notify_when_agent_waiting` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Play Sound When Agent Done | `agent.play_sound_when_agent_done` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Expand Edit Card | `agent.expand_edit_card` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Expand Terminal Card | `agent.expand_terminal_card` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Thinking Display | `agent.thinking_display` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Cancel Generation On Terminal Stop | `agent.cancel_generation_on_terminal_stop` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Use Modifier To Send | `agent.use_modifier_to_send` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Message Editor Min Lines | `agent.message_editor_min_lines` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Show Turn Stats | `agent.show_turn_stats` | Keep | Core AI/agent/product workflow. |
| AI | Agent Configuration | Show Merge Conflict Indicator | `agent.show_merge_conflict_indicator` | Keep | Core AI/agent/product workflow. |
| AI | Context Servers | Context Server Timeout | `context_server_timeout` | Keep | Core AI/agent/product workflow. |
| AI | Edit Predictions | Configure Providers | `edit_predictions.providers` | Keep editor AI | Editor-mode AI provider setup; real Backboard AI surface but not part of the agent side panel. |
| AI | Edit Predictions | Data Collection | `edit_predictions.allow_data_collection` | Keep editor AI | Controls edit-prediction data sharing; keep visible only if edit predictions remain public. |
| AI | Edit Predictions | Show Edit Predictions | `languages.$(language).show_edit_predictions` | Keep editor AI | Controls editor prediction visibility. |
| AI | Edit Predictions | Disable in Language Scopes | `languages.$(language).edit_predictions_disabled_in` | Keep advanced editor AI | Advanced language-scope exclusion for editor predictions. |
| AI | Edit Predictions | Display Mode | `edit_predictions.mode` | Keep editor AI | Controls edit prediction preview behavior in buffers. |
| Network | Network | Proxy | `proxy` | Keep advanced | Enterprise network support. |
| Network | Network | Server URL | `server_url` | Remove from user UI | Internal deployment/API routing. |
| Language Settings | Indentation | Tab Size | `languages.$(language).tab_size` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indentation | Hard Tabs | `languages.$(language).hard_tabs` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indentation | Auto Indent | `languages.$(language).auto_indent` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indentation | Auto Indent On Paste | `languages.$(language).auto_indent_on_paste` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Wrapping | Soft Wrap | `languages.$(language).soft_wrap` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Wrapping | Show Wrap Guides | `languages.$(language).show_wrap_guides` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Wrapping | Preferred Line Length | `languages.$(language).preferred_line_length` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Wrapping | Wrap Guides | `languages.$(language).wrap_guides` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Wrapping | Allow Rewrap | `languages.$(language).allow_rewrap` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indent Guides | Enabled | `languages.$(language).indent_guides.enabled` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indent Guides | Line Width | `languages.$(language).indent_guides.line_width` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indent Guides | Active Line Width | `languages.$(language).indent_guides.active_line_width` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indent Guides | Coloring | `languages.$(language).indent_guides.coloring` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Indent Guides | Background Coloring | `languages.$(language).indent_guides.background_coloring` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Format On Save | `languages.$(language).format_on_save` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Remove Trailing Whitespace On Save | `languages.$(language).remove_trailing_whitespace_on_save` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Ensure Final Newline On Save | `languages.$(language).ensure_final_newline_on_save` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Line Ending | `languages.$(language).line_ending` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Formatter | `languages.$(language).formatter` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Formatting | Use On Type Format | `languages.$(language).use_on_type_format` | Remove from user UI | LSP-backed formatting trigger; not needed for Backboard autocomplete. |
| Language Settings | Formatting | Code Actions On Format | `languages.$(language).code_actions_on_format` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Autoclose | Use Autoclose | `languages.$(language).use_autoclose` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Autoclose | Use Auto Surround | `languages.$(language).use_auto_surround` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Autoclose | Always Treat Brackets As Autoclosed | `languages.$(language).always_treat_brackets_as_autoclosed` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Autoclose | JSX Tag Auto Close | `languages.$(language).jsx_tag_auto_close` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Whitespace | Show Whitespaces | `languages.$(language).show_whitespaces` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Whitespace | Space Whitespace Indicator | `languages.$(language).whitespace_map.space` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Whitespace | Tab Whitespace Indicator | `languages.$(language).whitespace_map.tab` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Show Completions On Input | `languages.$(language).show_completions_on_input` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Show Completion Documentation | `languages.$(language).show_completion_documentation` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Words | `languages.$(language).completions.words` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Words Min Length | `languages.$(language).completions.words_min_length` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Completion Menu Scrollbar | `editor.completion_menu_scrollbar` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Completions | Completion Detail Alignment | `editor.completion_detail_alignment` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Enabled | `languages.$(language).inlay_hints.enabled` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Show Value Hints | `languages.$(language).inlay_hints.show_value_hints` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Show Type Hints | `languages.$(language).inlay_hints.show_type_hints` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Show Parameter Hints | `languages.$(language).inlay_hints.show_parameter_hints` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Show Other Hints | `languages.$(language).inlay_hints.show_other_hints` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Show Background | `languages.$(language).inlay_hints.show_background` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Edit Debounce Ms | `languages.$(language).inlay_hints.edit_debounce_ms` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Scroll Debounce Ms | `languages.$(language).inlay_hints.scroll_debounce_ms` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Inlay Hints | Toggle On Modifiers Press | Action | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Tasks | Enabled | `languages.$(language).tasks.enabled` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Tasks | Variables | `languages.$(language).tasks.variables` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Tasks | Prefer LSP | `languages.$(language).tasks.prefer_lsp` | Remove from user UI | LSP-backed task preference; not needed for Backboard autocomplete. |
| Language Settings | Miscellaneous | Word Diff Enabled | `languages.$(language).word_diff_enabled` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Debuggers | `languages.$(language).debuggers` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Middle Click Paste | `languages.$(language).editor.middle_click_paste` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Extend Comment On Newline | `languages.$(language).extend_comment_on_newline` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Colorize Brackets | `languages.$(language).colorize_brackets` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Vim/Emacs Modeline Support | `modeline_lines` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Image Viewer | `image_viewer.unit` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Auto Replace Emoji Shortcode | `message_editor.auto_replace_emoji_shortcode` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Drop Size Target | `drop_target_size` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Miscellaneous | Code Lens | `code_lens` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | Miscellaneous | LSP Document Colors | `lsp_document_colors` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Enable Language Server | `languages.$(language).enable_language_server` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Language Servers | `languages.$(language).language_servers` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Linked Edits | `languages.$(language).linked_edits` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Go To Definition Fallback | `go_to_definition_fallback` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Go To Definition Scroll Strategy | `go_to_definition_scroll_strategy` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | Semantic Tokens | `languages.$(language).semantic_tokens` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | LSP Folding Ranges | `languages.$(language).document_folding_ranges` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP | LSP Document Symbols | `languages.$(language).document_symbols` | Remove from user UI | Language-server editor feature; not needed for Backboard autocomplete. |
| Language Settings | LSP Completions | Enabled | `languages.$(language).completions.lsp` | Remove from user UI | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |
| Language Settings | LSP Completions | Fetch Timeout (milliseconds) | `languages.$(language).completions.lsp_fetch_timeout_ms` | Remove from user UI | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |
| Language Settings | LSP Completions | Insert Mode | `languages.$(language).completions.lsp_insert_mode` | Remove from user UI | LSP completions do not feed Backboard edit predictions; they only compete with Tab accept when the menu is open. |
| Language Settings | Debuggers | Debuggers | `languages.$(language).debuggers` | Keep advanced editor only | Debugger is editor-mode functionality. |
| Language Settings | Prettier | Allowed | `languages.$(language).prettier.allowed` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Prettier | Parser | `languages.$(language).prettier.parser` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Prettier | Plugins | `languages.$(language).prettier.plugins` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Prettier | Options | `languages.$(language).prettier.options` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Edit Predictions | Configure Providers | `edit_predictions.providers` | Keep | Core AI/agent/product workflow. |
| Language Settings | Edit Predictions | Data Collection | `edit_predictions.allow_data_collection` | Keep | Core AI/agent/product workflow. |
| Language Settings | Edit Predictions | Show Edit Predictions | `languages.$(language).show_edit_predictions` | Keep advanced editor only | Per-language editor/tooling behavior. |
| Language Settings | Edit Predictions | Disable in Language Scopes | `languages.$(language).edit_predictions_disabled_in` | Keep advanced editor only | Per-language editor/tooling behavior. |

## Suggested First Code Pass

1. Remove `collaboration_page()` from `settings_data`.
2. Remove the `Collaboration Panel` section from `panels_page()`.
3. Remove `Privacy` and `Auto Update` sections from `general_page()`.
4. Remove `Scoped Settings` from `general_page()` until profiles/preview-channel settings have a Backboard UI story.
5. Remove `Server URL` from `network_page()`; keep only `Proxy` as an advanced network setting.
6. Keep `Developer` only behind staff/debug as it is today.

## Longer-Term Reorganization

Move `Keep advanced editor only` rows behind an “Advanced Editor” grouping or an explicit editor-mode-only filter. This keeps Backboard simple mode clean without breaking editor-mode users who rely on inherited Zed behavior.
