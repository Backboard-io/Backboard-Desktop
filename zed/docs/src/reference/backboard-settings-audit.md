---
title: Backboard Settings Audit
description: Audit of inherited Zed settings exposed through Backboard Studio defaults and typed settings.
---

# Backboard Settings Audit

This document audits the inherited Zed settings surface as it exists in Backboard Studio. It is documentation-only: no setting is removed or changed by this audit.

## Classification Definitions

- **Directly Useful / Used**: read by Backboard-specific flows, core Backboard agent/editor UX, simple mode, model selection, theme, project/workspace restore, terminal/preview, Git/worktree, or settings UI users actually need.
- **Not Used**: inherited Zed feature setting with no meaningful Backboard surface, disabled/unreachable feature, or no runtime read path relevant to this fork.
- **Gray Area**: still used by editor mode or upstream components, but not central to Backboard product. Keep internally for compatibility unless a cleanup explicitly hides it from UI/docs.

## Evidence Index

- **E00**: Schema metadata in `assets/settings/default.json`; parsed by settings file helpers in `crates/settings/src/settings_file.rs`.
- **E01**: Theme flattening in `crates/settings_content/src/theme.rs::ThemeSettingsContent`; runtime reads in `crates/theme_settings/src/settings.rs::ThemeSettings::from_settings`, `agent_ui_font_size`, and `agent_buffer_font_size`.
- **E02**: Workspace flattening in `crates/settings_content/src/workspace.rs::WorkspaceSettingsContent`; runtime reads in `crates/workspace/src/workspace_settings.rs::WorkspaceSettings::from_settings` and launch behavior in `crates/zed/src/main.rs` around `restore_on_startup` and `preferred_interface_mode`.
- **E03**: Agent flattening in `crates/settings_content/src/agent.rs::AgentSettingsContent`; runtime reads in `crates/agent_settings/src/agent_settings.rs::AgentSettings::from_settings`, `crates/agent/src/thread.rs`, `crates/agent/src/tool_permissions.rs`, and `crates/agent_ui/src/conversation_view/thread_view.rs`.
- **E04**: Backboard API/client routing in `crates/client/src/client.rs::ClientSettings::from_settings`, `ProxySettings::from_settings`, and `crates/client/src/zed_urls.rs`.
- **E05**: Model provider settings in `crates/language_models/src/settings.rs::AllLanguageModelSettings::from_settings` and provider reads in `crates/language_models/src/provider/*`.
- **E06**: Edit prediction defaults in `crates/settings_content/src/language.rs::EditPredictionSettingsContent` and UI reads in `crates/edit_prediction_ui/src/*`.
- **E08**: Terminal settings in `crates/settings_content/src/terminal.rs::TerminalSettingsContent`; runtime reads in `crates/terminal/src/terminal_settings.rs` and `crates/terminal/src/terminal.rs`.
- **E09**: Node settings in `crates/settings_content/src/project.rs::NodeBinarySettings`; runtime reads in `crates/zed/src/main.rs` and project tooling.
- **E10**: Git panel settings in `crates/git_ui/src/git_panel_settings.rs::GitPanelSettings::from_settings` and reads in `crates/git_ui/src/project_diff.rs` and `commit_modal.rs`.
- **E11**: Project Git/worktree settings in `crates/settings_content/src/project.rs::ProjectSettingsContent`; reads in `crates/project/src/git_store.rs`, `crates/editor/src/element.rs`, and `crates/agent_ui/src/thread_worktree_archive.rs`.
- **E12**: Compatibility flattening in `crates/settings_content/src/settings_content.rs::SettingsContent`, `UserSettingsContent`, release-channel overrides, platform overrides, feature flags, logging, and instrumentation.
- **E13**: Panel/tab/status UI settings in `crates/settings_content/src/workspace.rs`, `crates/project_panel/src/project_panel_settings.rs`, `crates/outline_panel/src/outline_panel.rs`, and `crates/settings_ui/src/page_data.rs`.
- **E14**: Editor settings in `crates/settings_content/src/editor.rs::EditorSettingsContent`; runtime reads in `crates/editor/src/editor_settings.rs::EditorSettings::from_settings` and many `EditorSettings::get_global` sites.
- **E15**: Language/project settings in `crates/settings_content/src/language.rs` and `project.rs`; runtime reads via `AllLanguageSettings::get_global` and `ProjectSettings::get_global` in `crates/editor/src` and `crates/project/src/lsp_store.rs`.
- **E16**: Calls/collaboration/audio settings are typed in `SettingsContent` and some upstream UI exists, but these do not map to a current Backboard Studio product surface.
- **E17**: Settings typed or defaulted for inherited Zed behavior where the feature is disabled, absent from Backboard UX, or not meaningful to expose publicly.

## Exhaustive Default Settings Inventory

Source: `assets/settings/default.json`. Object rows and leaf rows are both listed so every user-facing key path in the default file has a single classification row.

| Setting | Category | Classification | Evidence | Backboard impact | Recommended action |
|---|---|---|---|---|---|
| `$schema` | Metadata | Gray Area | E00 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `theme` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `theme.mode` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `theme.light` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `theme.dark` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `icon_theme` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `base_keymap` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `buffer_font_family` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_font_fallbacks` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_font_features` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_font_size` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_font_weight` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_line_height` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `buffer_line_height.custom` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_family` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_fallbacks` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_features` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_features.calt` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_weight` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `ui_font_size` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `agent_ui_font_size` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `agent_buffer_font_size` | Appearance | Directly Useful / Used | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `unnecessary_code_fade` | Appearance | Gray Area | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `active_pane_modifiers` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `active_pane_modifiers.border_size` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `active_pane_modifiers.inactive_opacity` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `bottom_dock_layout` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `pane_split_direction_horizontal` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `pane_split_direction_vertical` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `centered_layout` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `centered_layout.left_padding` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `centered_layout.right_padding` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `image_viewer` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `image_viewer.unit` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `multi_cursor_modifier` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim_mode` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `helix_mode` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hover_popover_enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hover_popover_delay` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hover_popover_sticky` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hover_popover_hiding_delay` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `confirm_quit` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `restore_on_startup` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preferred_interface_mode` | Simple Mode | Directly Useful / Used | E02 | Controls chat-first versus editor launch behavior. | Keep public |
| `cli_default_open_behavior` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `restore_on_file_reopen` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `close_on_file_delete` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `close_panel_on_toggle` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `drop_target_size` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `when_closing_with_no_tabs` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `on_last_window_closed` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `text_rendering_mode` | Appearance | Gray Area | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `zoomed_padding` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `window_decorations` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `use_system_path_prompts` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `use_system_prompts` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `cursor_blink` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `cursor_shape` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hide_mouse` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `focus_follows_mouse` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `focus_follows_mouse.enabled` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `focus_follows_mouse.debounce_ms` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `snippet_sort_order` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `current_line_highlight` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `selection_highlight` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `rounded_selection` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `lsp_highlight_debounce` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `minimum_contrast_for_highlights` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `show_completions_on_input` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `show_completion_documentation` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `colorize_brackets` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completion_menu_scrollbar` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completion_detail_alignment` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diff_view_style` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimum_split_diff_width` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `auto_signature_help` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `show_signature_help_after_edits` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inline_code_actions` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `drag_and_drop_selection` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `drag_and_drop_selection.enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `drag_and_drop_selection.delay` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `code_lens` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `go_to_definition_fallback` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `go_to_definition_scroll_strategy` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics_max_severity` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `show_wrap_guides` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `wrap_guides` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `redact_private_values` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `expand_excerpt_lines` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `excerpt_context_lines` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `private_files` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `use_on_type_format` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `use_autoclose` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `use_auto_surround` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `auto_indent` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `auto_indent_on_paste` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `always_treat_brackets_as_autoclosed` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `allow_rewrap` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `show_edit_predictions` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `edit_predictions_disabled_in` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `show_whitespaces` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `whitespace_map` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `whitespace_map.space` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `whitespace_map.tab` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `calls` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `calls.mute_on_join` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `calls.share_on_join` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `toolbar` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `toolbar.breadcrumbs` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `toolbar.quick_actions` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `toolbar.selections_menu` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `toolbar.agent_review` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `toolbar.code_actions` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `use_system_window_tabs` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `title_bar` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_branch_status_icon` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_branch_name` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_project_items` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_onboarding_banner` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_user_picture` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_user_menu` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_sign_in` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.show_menus` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `title_bar.button_layout` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `audio` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `audio.experimental.auto_microphone_volume` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `audio.experimental.output_audio_device` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `audio.experimental.input_audio_device` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `scrollbar` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.show` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.cursors` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.git_diff` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.search_results` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.selected_text` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.selected_symbol` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.diagnostics` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.axes` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.axes.horizontal` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scrollbar.axes.vertical` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.show` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.display_in` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.thumb` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.thumb_border` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.current_line_highlight` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `minimap.max_width_columns` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `middle_click_paste` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `double_click_in_multibuffer` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.line_numbers` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.runnables` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.bookmarks` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.breakpoints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.folds` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `gutter.min_line_number_digits` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides.enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides.line_width` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides.active_line_width` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides.coloring` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_guides.background_coloring` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scroll_beyond_last_line` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vertical_scroll_margin` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `autoscroll_on_clicks` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `horizontal_scroll_margin` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `scroll_sensitivity` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `mouse_wheel_zoom` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `fast_scroll_sensitivity` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `sticky_scroll` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `sticky_scroll.enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `relative_line_numbers` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search_wrap` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.button` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.whole_word` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.case_sensitive` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.include_ignored` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.regex` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `search.center_on_match` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `seed_search_query_from_cursor` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `use_smartcase_search` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.show_type_hints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.show_parameter_hints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.show_value_hints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.show_other_hints` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.show_background` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.edit_debounce_ms` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.scroll_debounce_ms` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press.control` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press.shift` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press.alt` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press.platform` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `inlay_hints.toggle_on_modifiers_press.function` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `resize_all_panels_in_dock` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `project_panel` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.button` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.hide_gitignore` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.default_width` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.dock` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.entry_spacing` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.file_icons` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.folder_icons` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.git_status` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.indent_size` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_reveal_entries` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.starts_open` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_fold_dirs` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.bold_folder_labels` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.scrollbar` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.scrollbar.show` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.scrollbar.horizontal_scroll` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.show_diagnostics` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.sticky_scroll` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.indent_guides` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.indent_guides.show` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.sort_mode` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.sort_order` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.diagnostic_badges` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.git_status_indicator` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.drag_and_drop` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.hide_root` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.hide_hidden` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_open` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_open.on_create` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_open.on_paste` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `project_panel.auto_open.on_drop` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `outline_panel` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.button` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.default_width` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.dock` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.file_icons` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.folder_icons` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.git_status` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.indent_size` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.auto_reveal_entries` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.auto_fold_dirs` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.indent_guides` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.indent_guides.show` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.scrollbar` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.scrollbar.show` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `outline_panel.expand_outlines_with_depth` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `collaboration_panel` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `collaboration_panel.button` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `collaboration_panel.dock` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `collaboration_panel.default_width` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `git_panel` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.button` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.dock` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.default_width` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.status_style` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.file_icons` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.folder_icons` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.fallback_branch_name` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.sort_by_path` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.collapse_untracked_diff` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.tree_view` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.starts_open` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.show_count_badge` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.scrollbar` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.diff_stats` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_panel.commit_title_max_length` | Git | Directly Useful / Used | E10 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `message_editor` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `message_editor.auto_replace_emoji_shortcode` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `agent` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.inline_assistant_use_streaming_tools` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.enabled` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.button` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.dock` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.flexible` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.sidebar_side` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_width` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_height` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.limit_content_width` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.max_content_width` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_model` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_model.provider` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_model.model` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_model.enable_thinking` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.model_parameters` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.tool_permissions` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.tool_permissions.default` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.tool_permissions.tools` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.single_file_review` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.enable_feedback` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.default_profile` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.name` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.enable_all_context_servers` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.copy_path` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.create_directory` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.delete_path` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.diagnostics` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.apply_code_action` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.edit_file` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.write_file` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.fetch` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.find_path` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.find_references` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.get_code_actions` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.go_to_definition` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.list_directory` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.move_path` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.rename_symbol` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.read_file` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.grep` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.spawn_agent` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.terminal` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.update_plan` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.write.tools.search_web` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.name` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.diagnostics` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.fetch` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.list_directory` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.find_path` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.find_references` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.get_code_actions` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.go_to_definition` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.read_file` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.grep` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.spawn_agent` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.update_plan` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.ask.tools.search_web` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.minimal` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.minimal.name` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.minimal.enable_all_context_servers` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.profiles.minimal.tools` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.notify_when_agent_waiting` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.play_sound_when_agent_done` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.expand_edit_card` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.expand_terminal_card` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.thinking_display` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.cancel_generation_on_terminal_stop` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.use_modifier_to_send` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.message_editor_min_lines` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.show_turn_stats` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent.show_merge_conflict_indicator` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `show_call_status_icon` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `enable_language_server` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `linked_edits` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `semantic_tokens` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `document_folding_ranges` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `document_symbols` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `autosave` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `max_tabs` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `tab_bar` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tab_bar.show` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tab_bar.show_nav_history_buttons` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tab_bar.show_tab_bar_buttons` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tab_bar.show_pinned_tabs_in_separate_row` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.git_status` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.close_position` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.file_icons` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.show_close_button` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.activate_on_close` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `tabs.show_diagnostics` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enabled` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_preview_from_project_panel` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_preview_from_file_finder` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_preview_from_multibuffer` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_preview_multibuffer_from_code_navigation` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_preview_file_from_code_navigation` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `preview_tabs.enable_keep_preview_on_code_navigation` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder.file_icons` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder.modal_max_width` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder.skip_focus_for_active_in_search` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder.include_ignored` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `file_finder.include_channels` | Projects / Workspaces | Directly Useful / Used | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `remove_trailing_whitespace_on_save` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `extend_comment_on_newline` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `extend_list_on_newline` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `indent_list_on_tab` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `ensure_final_newline_on_save` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `line_ending` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `format_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `formatter` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `soft_wrap` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `preferred_line_length` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `hard_tabs` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `tab_size` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `modeline_lines` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debuggers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `word_diff_enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `telemetry` | Advanced Compatibility | Not Used | E17 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `telemetry.diagnostics` | Advanced Compatibility | Not Used | E17 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `telemetry.metrics` | Advanced Compatibility | Not Used | E17 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `disable_ai` | AI / Models | Directly Useful / Used | E04 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `auto_update` | Advanced Compatibility | Not Used | E17 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `lsp_document_colors` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.button` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.include_warnings` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.lsp_pull_diagnostics` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.lsp_pull_diagnostics.enabled` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.lsp_pull_diagnostics.debounce_ms` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline.enabled` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline.update_debounce_ms` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline.padding` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline.min_column` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `diagnostics.inline.max_severity` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `file_scan_exclusions` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `file_scan_inclusions` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `hidden_files` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `read_only_files` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `git` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.disable_git` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.enable_status` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.enable_diff` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.git_gutter` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.gutter_debounce` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame.enabled` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame.delay_ms` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame.padding` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame.show_commit_summary` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.inline_blame.min_column` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.blame` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.blame.show_avatar` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.branch_picker` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.branch_picker.show_author_name` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.hunk_style` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.path_style` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git.worktree_directory` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `git_hosting_providers` | Git | Directly Useful / Used | E11 | Needed for worktrees, diff UI, blame, and agent-assisted Git flows. | Keep public |
| `load_direnv` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `edit_predictions` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.provider` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.disabled_globs` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.mode` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.copilot` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.copilot.enterprise_uri` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.copilot.proxy` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.copilot.proxy_no_verify` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.copilot.enable_next_edit_suggestions` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.codestral` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.codestral.api_url` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.codestral.model` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.codestral.max_tokens` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.ollama` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.ollama.api_url` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.ollama.model` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.ollama.prompt_format` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.ollama.max_output_tokens` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.open_ai_compatible_api` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.open_ai_compatible_api.api_url` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.open_ai_compatible_api.model` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.open_ai_compatible_api.prompt_format` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.open_ai_compatible_api.max_output_tokens` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `edit_predictions.allow_data_collection` | AI / Models | Directly Useful / Used | E06 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `journal` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `journal.path` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `journal.hour_format` | Collaboration / Calls | Not Used | E16 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `status_bar` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.experimental.show` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.show_active_file` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.active_language_button` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.cursor_position_button` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.line_endings_button` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `status_bar.active_encoding_button` | Projects / Workspaces | Gray Area | E13 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `terminal` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.shell` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.dock` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.flexible` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.default_width` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.default_height` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.working_directory` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.blinking` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.cursor_shape` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.alternate_scroll` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.option_as_meta` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.copy_on_select` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.keep_selection_on_copy` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.button` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.env` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.line_height` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.detect_venv` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.detect_venv.on` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.detect_venv.on.directories` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.detect_venv.on.activate_script` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.detect_venv.on.conda_manager` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.toolbar` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.toolbar.breadcrumbs` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.scrollbar` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.scrollbar.show` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.font_weight` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.max_scroll_history_lines` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.scroll_multiplier` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.minimum_contrast` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.path_hyperlink_regexes` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.path_hyperlink_timeout_ms` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.show_count_badge` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `terminal.bell` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `code_actions_on_format` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `tasks` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `tasks.variables` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `tasks.enabled` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `tasks.prefer_lsp` | Terminal / Preview | Directly Useful / Used | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `file_types` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `file_types.JSONC` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `file_types.Markdown` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `file_types.Shell Script` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `node` | Terminal / Preview | Directly Useful / Used | E09 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `node.ignore_system_version` | Terminal / Preview | Directly Useful / Used | E09 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `node.path` | Terminal / Preview | Directly Useful / Used | E09 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `node.npm_path` | Terminal / Preview | Directly Useful / Used | E09 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `auto_install_extensions` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `auto_install_extensions.html` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `granted_extension_capabilities` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions.words` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions.words_min_length` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions.lsp` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions.lsp_fetch_timeout_ms` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `completions.lsp_insert_mode` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Astro` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Astro.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Astro.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Astro.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Astro.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Blade` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Blade.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Blade.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C.format_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C.use_on_type_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C++` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C++.format_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C++.use_on_type_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C++.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.C++.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.CSharp` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.CSharp.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.CSS` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.CSS.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.CSS.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Dart` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Dart.tab_size` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Diff` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Diff.show_edit_predictions` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Diff.remove_trailing_whitespace_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Diff.ensure_final_newline_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.EEx` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.EEx.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Elixir` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Elixir.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Elm` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Elm.tab_size` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Erlang` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Erlang.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Git Commit` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Git Commit.allow_rewrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Git Commit.soft_wrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Git Commit.preferred_line_length` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Go` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Go.hard_tabs` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Go.code_actions_on_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Go.code_actions_on_format.source.organizeImports` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Go.debuggers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.GraphQL` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.GraphQL.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.GraphQL.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HEEx` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HEEx.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HTML` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HTML.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HTML.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HTML+ERB` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.HTML+ERB.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Java` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Java.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Java.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Java.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JavaScript` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JavaScript.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JavaScript.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JavaScript.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSON` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSON.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSON.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSONC` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSONC.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JSONC.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JS+ERB` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.JS+ERB.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Kotlin` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Kotlin.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX.formatter` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.LaTeX.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.format_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.use_on_type_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.remove_trailing_whitespace_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.allow_rewrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.soft_wrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.completions` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.completions.words` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Markdown.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.PHP.prettier.parser` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Plain Text` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Plain Text.allow_rewrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Plain Text.soft_wrap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Plain Text.completions` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Plain Text.completions.words` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Proto` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Proto.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.code_actions_on_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.code_actions_on_format.source.organizeImports.ruff` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.formatter` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.formatter.language_server` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.formatter.language_server.name` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.debuggers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Python.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Ruby` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Ruby.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Rust` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Rust.debuggers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SCSS` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SCSS.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SCSS.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Starlark` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Starlark.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Svelte` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Svelte.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Svelte.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Svelte.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Svelte.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TSX` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TSX.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TSX.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TSX.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Twig` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Twig.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Twig.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TypeScript` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TypeScript.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TypeScript.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.TypeScript.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SystemVerilog` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SystemVerilog.format_on_save` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SystemVerilog.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.SystemVerilog.use_on_type_format` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Vue.js` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Vue.js.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Vue.js.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Vue.js.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.XML` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.XML.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.XML.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.XML.prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.YAML` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.YAML.prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.YAML.prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.YAML+ERB` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.YAML+ERB.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Zig` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `languages.Zig.language_servers` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `language_models` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.anthropic` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.anthropic.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.bedrock` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.google` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.google.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.ollama` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.ollama.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.openai` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.openai.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.openai_compatible` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.opencode` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.opencode.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.open_router` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.open_router.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.lmstudio` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.lmstudio.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.deepseek` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.deepseek.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.mistral` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.mistral.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.vercel_ai_gateway` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.vercel_ai_gateway.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.x_ai` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.x_ai.api_url` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `language_models.zed.dev` | AI / Models | Directly Useful / Used | E05 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep public |
| `session` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `session.restore_unsaved_buffers` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `session.trust_all_worktrees` | Projects / Workspaces | Directly Useful / Used | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Keep public |
| `prettier` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `prettier.allowed` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `prettier.plugins` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `prettier.parser` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `jsx_tag_auto_close` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `jsx_tag_auto_close.enabled` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `lsp` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `dap` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `dap.CodeLLDB` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `dap.CodeLLDB.env` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `dap.CodeLLDB.env.RUST_LOG` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings.button` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings.request_timeout` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings.notifications` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings.notifications.dismiss_timeout_ms` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `global_lsp_settings.semantic_token_rules` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `jupyter` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `jupyter.enabled` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `jupyter.kernel_selections` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `repl` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `repl.max_columns` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `repl.max_lines` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `repl.output_max_height_lines` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `repl.output_max_width_columns` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `vim` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.default_mode` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.toggle_relative_line_numbers` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.use_system_clipboard` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.use_smartcase_find` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.use_regex_search` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.gdefault` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.highlight_on_yank_duration` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.custom_digraphs` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.show_edit_predictions_in_normal_mode` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.cursor_shape` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.cursor_shape.normal` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.cursor_shape.replace` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.cursor_shape.visual` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `vim.cursor_shape.insert` | Editor Mode | Gray Area | E14 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `which_key` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `which_key.enabled` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `which_key.delay_ms` | Editor Mode | Not Used | E14 | Inherited or disabled surface; little Backboard product value. | Hide from Backboard settings UI/docs |
| `server_url` | AI / Models | Directly Useful / Used | E04 | Controls model provider defaults, prediction behavior, or Backboard API routing. | Keep internal only |
| `preview` | Terminal / Preview | Gray Area | E08 | Needed for agent terminal tools, task execution, and preview workflows. | Keep public |
| `nightly` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `nightly.instrumentation` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `nightly.instrumentation.performance_profiler` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `nightly.instrumentation.performance_profiler.enabled` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `stable` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `dev` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `dev.instrumentation` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `dev.instrumentation.performance_profiler` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `dev.instrumentation.performance_profiler.enabled` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `linux` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `macos` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `windows` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `windows.languages` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `windows.languages.PHP` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `windows.languages.PHP.language_servers` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `line_indicator_format` | Appearance | Gray Area | E01 | Controls Backboard and editor visual defaults. | Keep public |
| `proxy` | Advanced Compatibility | Directly Useful / Used | E04 | Required for network access in enterprise environments. | Keep public |
| `command_aliases` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `ssh_connections` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `read_ssh_config` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `context_server_timeout` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `context_servers` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `agent_servers` | Agent Behavior | Directly Useful / Used | E03 | Controls native agent UX, profiles, permissions, and tool behavior. | Keep public |
| `debugger` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.stepping_granularity` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.save_breakpoints` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.timeout` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.dock` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.log_dap_communications` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.format_dap_log_messages` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `debugger.button` | Editor Mode | Gray Area | E15 | Still used by inherited editor mode and language tooling. | Keep internal only |
| `profiles` | Projects / Workspaces | Gray Area | E02 | Affects project restore, panels, tabs, file discovery, and workspace ergonomics. | Needs product decision |
| `log` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `instrumentation` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `instrumentation.performance_profiler` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |
| `instrumentation.performance_profiler.enabled` | Advanced Compatibility | Gray Area | E12 | Compatibility or internal diagnostic behavior. | Keep internal only |

## Typed Settings Not Represented Directly In Default JSON

These keys or key patterns are present in typed settings models or flattened user settings, but are not explicit scalar/object keys in the current default file. They should be included in cleanup planning because users can still configure them or upstream code can read them.

| Setting | Category | Classification | Evidence | Backboard impact | Recommended action |
|---|---|---|---|---|---|
| `agent.favorite_models` | AI / Models | Directly Useful / Used | E03 | Favorites are shown and cycled in the model selector. | Keep public |
| `agent.subagent_model` | Agent Behavior | Directly Useful / Used | E03 | Used when spawning subagents from an agent thread. | Keep public |
| `agent.inline_assistant_model` | Agent Behavior | Directly Useful / Used | E03 | Overrides model choice for inline assistant flows. | Keep public |
| `agent.commit_message_model` | Git | Directly Useful / Used | E03 | Supports AI commit-message generation. | Keep public |
| `agent.thread_summary_model` | Agent Behavior | Directly Useful / Used | E03 | Controls model used for thread summaries. | Keep public |
| `agent.inline_alternatives` | Agent Behavior | Gray Area | E03 | Advanced inline-assist alternative generation. | Keep internal only |
| `agent.default_model.effort` | AI / Models | Directly Useful / Used | E03 | Conversation view writes model reasoning effort to settings. | Keep public |
| `agent.default_model.speed` | AI / Models | Directly Useful / Used | E03 | Conversation view writes model speed preference to settings. | Keep public |
| `agent.profiles.<name>.default_model` | Agent Behavior | Directly Useful / Used | E03 | Profile manager configures default model per profile. | Keep public |
| `agent.profiles.<name>.tools.<tool>` | Agent Behavior | Directly Useful / Used | E03 | Tool picker configures profile tool availability. | Keep public |
| `agent.tool_permissions.tools.<tool>.always_allow` | Agent Behavior | Directly Useful / Used | E03 | Compiled into per-tool permission regex rules. | Keep public |
| `agent.tool_permissions.tools.<tool>.always_deny` | Agent Behavior | Directly Useful / Used | E03 | Compiled into per-tool permission regex rules. | Keep public |
| `agent.tool_permissions.tools.<tool>.always_confirm` | Agent Behavior | Directly Useful / Used | E03 | Compiled into per-tool permission regex rules. | Keep public |
| `credentials_url` | AI / Models | Directly Useful / Used | E04 | Allows Backboard-side credential namespace separation. | Keep internal only |
| `theme_overrides` | Appearance | Gray Area | E01 | Advanced inherited theme customization. | Keep internal only |
| `experimental.theme_overrides` | Appearance | Gray Area | E01 | Experimental inherited theme customization. | Hide from Backboard settings UI/docs |
| `unstable.ui_density` | Appearance | Gray Area | E01 | Experimental density setting used by theme settings. | Hide from Backboard settings UI/docs |
| `markdown_preview_font_family` | Editor Mode | Gray Area | E01 | Inherited markdown preview presentation setting. | Keep internal only |
| `markdown_preview_theme` | Editor Mode | Gray Area | E01 | Inherited markdown preview presentation setting. | Keep internal only |
| `prevent_sharing_in_public_channels` | Projects / Workspaces | Not Used | E15 | Collaboration safety setting without meaningful Backboard surface. | Hide from Backboard settings UI/docs |
| `lsp.<server>.binary` | Editor Mode | Gray Area | E15 | Per-server language tooling override. | Keep internal only |
| `lsp.<server>.settings` | Editor Mode | Gray Area | E15 | Per-server language tooling override. | Keep internal only |
| `lsp.<server>.initialization_options` | Editor Mode | Gray Area | E15 | Per-server language tooling override. | Keep internal only |
| `lsp.<server>.enable_lsp_tasks` | Editor Mode | Gray Area | E15 | Per-server language task integration. | Keep internal only |
| `lsp.<server>.fetch.pre_release` | Editor Mode | Gray Area | E15 | Per-server language-server fetching behavior. | Keep internal only |
| `context_servers.<name>.command` | Agent Behavior | Directly Useful / Used | E03 | MCP/context server launch configuration. | Keep public |
| `context_servers.<name>.timeout` | Agent Behavior | Directly Useful / Used | E03 | Per-context-server timeout override. | Keep public |
| `agent_servers.<name>` | Agent Behavior | Directly Useful / Used | E03 | ACP/custom agent server configuration. | Keep public |
| `feature_flags.<flag>` | Advanced Compatibility | Gray Area | E12 | Developer override path for feature flags. | Keep internal only |
| `release-channel overrides: dev/nightly/preview/stable` | Advanced Compatibility | Gray Area | E12 | Typed flattening through UserSettingsContent channel overrides. | Keep internal only |
| `platform overrides: macos/linux/windows` | Advanced Compatibility | Gray Area | E12 | Typed flattening through UserSettingsContent platform overrides. | Keep internal only |

## Audit Notes

- The default file intentionally carries many editor-mode and language-specific settings inherited from Zed. Most of these are **Gray Area**, not **Not Used**, because editor mode still reads them through `EditorSettings`, `ProjectSettings`, and `AllLanguageSettings`.
- Backboard-specific product weight is concentrated in `preferred_interface_mode`, `server_url`, `agent.*`, `language_models.*`, `edit_predictions.*`, `terminal.*`, `git.*`, project restore/session settings, and visual settings used by both simple mode and editor mode.
- Collaboration, calls, audio, Jupyter, REPL, journal, and which-key settings are inherited surfaces with little current Backboard value. They should be hidden from Backboard settings UI/docs before any removal is attempted.
- Release-channel and platform override blocks are compatibility mechanics. They should stay internal because deleting them could break expected settings merges even if they are not user-facing Backboard concepts.
