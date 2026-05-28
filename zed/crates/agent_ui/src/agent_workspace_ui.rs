use collections::{HashMap, HashSet};
use editor::Editor;
use gpui::{
    AnyElement, App, Context, DefiniteLength, Entity, FocusHandle, Focusable, FontWeight, Hsla,
    InteractiveElement, MouseButton, ParentElement, Pixels, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, prelude::*,
};
use ui::{
    Button, ButtonSize, ButtonStyle, ElevationIndex, Icon, IconButton, IconSize, Label, LabelSize,
    TintColor, Tooltip, Vector, VectorName, WithScrollbar, prelude::*,
};
use workspace::{Workspace, dock::DockPosition};

use crate::ConversationView;
use crate::agent_panel::{
    AgentPanel, AgentPanelEvent, BackboardAgentRunEventState, BackboardAgentRunStatus,
    BackboardAgentRunSummary,
};
use crate::thread_metadata_store::ThreadId;
use zed_actions::{ConfigureBackboardApiKey, agent::Chat};

pub struct BackboardAgentWorkspacePage {
    workspace: WeakEntity<Workspace>,
    focus_handle: FocusHandle,
    selected_thread_id: Option<ThreadId>,
    draft_drawer_open: bool,
    dashboard_scroll_handle: ScrollHandle,
    dismissed_threads: HashSet<ThreadId>,
    card_chat_inputs: HashMap<ThreadId, Entity<Editor>>,
    show_token_context: bool,
    observing_agent_panel: bool,
    _config_task: Task<()>,
    _subscriptions: Vec<Subscription>,
}

struct BackboardAgentWorkspaceHeader {
    agent_count: usize,
    right_panel_open: bool,
}

impl BackboardAgentWorkspaceHeader {
    fn new(summaries: &[BackboardAgentRunSummary], right_panel_open: bool) -> Self {
        Self {
            agent_count: summaries.len(),
            right_panel_open,
        }
    }

    fn render(self, cx: &mut Context<BackboardAgentWorkspacePage>) -> AnyElement {
        let colors = cx.theme().colors();
        let api_key_ready = BackboardAgentWorkspacePage::has_backboard_api_key();
        let agent_label = if self.agent_count == 1 {
            "agent"
        } else {
            "agents"
        };
        let right_panel_open = self.right_panel_open;
        let header_background = colors
            .tab_bar_background
            .blend(colors.panel_background.opacity(0.28));
        let divider_color = colors.border_variant.opacity(0.44);

        h_flex()
            .h(px(30.))
            .p_1()
            .gap_2()
            .items_center()
            .border_b_1()
            .border_color(divider_color)
            .bg(header_background)
            .rounded_t(px(8.))
            .child(
                h_flex()
                    .h_full()
                    .px_1p5()
                    .gap_1p5()
                    .items_center()
                    .child(div().size(px(7.)).rounded_full().bg(colors.text_accent))
                    .child(
                        Label::new("Agent Workspace")
                            .size(LabelSize::Small)
                            .weight(FontWeight::BOLD)
                            .color(Color::Default),
                    )
                    .child(
                        Label::new(format!("{} {}", self.agent_count, agent_label))
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .child(div().flex_1())
            .child(
                h_flex()
                    .h_full()
                    .gap_1()
                    .items_center()
                    .child(
                        IconButton::new("agent-workspace-refresh", IconName::Rerun)
                            .icon_size(IconSize::XSmall)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("Refresh agent workspace"))
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.notify();
                            })),
                    )
                    .child(
                        IconButton::new(
                            "agent-workspace-composer",
                            if right_panel_open {
                                IconName::ThreadsSidebarRightOpen
                            } else {
                                IconName::ThreadsSidebarRightClosed
                            },
                        )
                        .icon_size(IconSize::XSmall)
                        .icon_color(Color::Muted)
                        .tooltip(Tooltip::text(if right_panel_open {
                            "Close chat"
                        } else {
                            "Open composer"
                        }))
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                if right_panel_open {
                                    this.close_detail(cx);
                                } else {
                                    this.create_chat(window, cx);
                                }
                            },
                        )),
                    )
                    .child(
                        Button::new("new-agent-chat", "New Agent")
                            .start_icon(Icon::new(IconName::Plus))
                            .style(ButtonStyle::Subtle)
                            .size(ButtonSize::None)
                            .disabled(!api_key_ready)
                            .when(!api_key_ready, |button| {
                                button.tooltip(Tooltip::text("Connect an API key to create agents"))
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.create_chat(window, cx);
                            })),
                    ),
            )
            .into_any_element()
    }
}

impl BackboardAgentWorkspacePage {
    pub fn new(
        workspace: &Workspace,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> Entity<Self> {
        let panel = workspace.panel::<AgentPanel>(cx);
        let workspace = workspace.weak_handle();

        cx.new(|cx| {
            let mut subscriptions = Vec::new();
            let observing_agent_panel = panel.is_some();
            if let Some(panel) = panel {
                subscriptions.push(cx.observe(&panel, |_, _, cx| cx.notify()));
                subscriptions.push(cx.subscribe_in(&panel, window, Self::handle_agent_panel_event));
            }
            let config_changes = backboard::subscribe_config_changes();
            let config_task = cx.spawn(async move |this, cx| {
                while config_changes.recv().await.is_ok() {
                    this.update(cx, |_, cx| cx.notify()).ok();
                }
            });

            Self {
                workspace,
                focus_handle: cx.focus_handle(),
                selected_thread_id: None,
                draft_drawer_open: false,
                dashboard_scroll_handle: ScrollHandle::new(),
                dismissed_threads: HashSet::default(),
                card_chat_inputs: HashMap::default(),
                show_token_context: false,
                observing_agent_panel,
                _config_task: config_task,
                _subscriptions: subscriptions,
            }
        })
    }

    fn handle_agent_panel_event(
        &mut self,
        panel: &Entity<AgentPanel>,
        event: &AgentPanelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            AgentPanelEvent::BackboardWorkspaceRunCreated {
                thread_id,
                auto_select,
                ..
            } => {
                if *auto_select && self.selected_thread_id.is_none() {
                    self.selected_thread_id = Some(*thread_id);
                    self.draft_drawer_open = false;
                    self.focus_selected_conversation(window, cx);
                }
                cx.notify();
            }
            AgentPanelEvent::BackboardWorkspaceLaunchFailed { .. } => {}
            AgentPanelEvent::ThreadInteracted { .. } => {
                if panel
                    .read(cx)
                    .active_backboard_workspace_draft_thread_id(cx)
                    .is_some()
                {
                    self.selected_thread_id = None;
                    self.draft_drawer_open = true;
                    cx.notify();
                }
            }
            AgentPanelEvent::ActiveViewChanged
            | AgentPanelEvent::ActiveViewFocused
            | AgentPanelEvent::EntryChanged => {}
        }
    }

    fn summaries(&self, cx: &App) -> Vec<BackboardAgentRunSummary> {
        self.workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
            .map(|panel| {
                panel
                    .read(cx)
                    .backboard_agent_run_summaries(cx)
                    .into_iter()
                    .filter(|summary| !self.dismissed_threads.contains(&summary.thread_id))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn has_backboard_api_key() -> bool {
        backboard::BackboardConfig::load_or_default()
            .api_key()
            .is_some()
    }

    fn open_api_key_settings(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
    }

    fn ensure_agent_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<AgentPanel>> {
        let workspace = self.workspace.upgrade()?;
        let panel = workspace.update(cx, |workspace, cx| {
            workspace.panel::<AgentPanel>(cx).unwrap_or_else(|| {
                let panel = cx.new(|cx| AgentPanel::new(workspace, None, window, cx));
                workspace.add_panel(panel.clone(), window, cx);
                panel
            })
        });

        if !self.observing_agent_panel {
            self._subscriptions
                .push(cx.observe(&panel, |_, _, cx| cx.notify()));
            self._subscriptions.push(cx.subscribe_in(
                &panel,
                window,
                Self::handle_agent_panel_event,
            ));
            self.observing_agent_panel = true;
        }

        Some(panel)
    }

    pub(crate) fn create_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.ensure_agent_panel(window, cx) {
            panel.update(cx, |panel, cx| {
                panel.create_backboard_workspace_chat(window, cx);
            });
        }
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                let right_dock = workspace.dock_at_position(DockPosition::Right).clone();
                right_dock.update(cx, |dock, cx| {
                    if dock.panel_index_for_type::<AgentPanel>().is_some() {
                        dock.set_open(false, window, cx);
                    }
                });
            });
        }
        self.selected_thread_id = None;
        self.draft_drawer_open = true;
        cx.notify();
    }

    fn focus_selected_conversation(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(thread_id) = self.selected_thread_id
            && let Some(conversation) = self.conversation_for_thread(thread_id, cx)
        {
            conversation.focus_handle(cx).focus(window, cx);
        }
    }

    fn submit_chat_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.ensure_agent_panel(window, cx) else {
            return;
        };

        let active_thread = self
            .selected_thread_id
            .and_then(|thread_id| self.conversation_for_thread(thread_id, cx))
            .and_then(|conversation| conversation.read(cx).active_thread().cloned())
            .or_else(|| panel.read(cx).active_thread_view(cx));

        if let Some(active_thread) = active_thread {
            active_thread.update(cx, |thread, cx| thread.send(window, cx));
        }
    }

    fn open_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_thread_id = Some(thread_id);
        self.draft_drawer_open = false;
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        if panel.active_thread_id(cx) != Some(thread_id) {
                            panel.activate_retained_thread(thread_id, true, window, cx);
                        }
                    });
                }
            });
        }
        self.focus_selected_conversation(window, cx);
        cx.notify();
    }

    fn close_detail(&mut self, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.persist_active_prompt(cx);
                    });
                }
            });
        }
        self.selected_thread_id = None;
        self.draft_drawer_open = false;
        cx.notify();
    }

    fn conversation_for_thread(
        &self,
        thread_id: ThreadId,
        cx: &App,
    ) -> Option<Entity<ConversationView>> {
        self.workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
            .and_then(|panel| {
                panel
                    .read(cx)
                    .backboard_workspace_conversation_view(thread_id, cx)
            })
    }

    fn card_chat_input(
        &mut self,
        thread_id: ThreadId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<Editor> {
        self.card_chat_inputs
            .entry(thread_id)
            .or_insert_with(|| {
                cx.new(|cx| {
                    let mut editor = Editor::single_line(window, cx);
                    editor.set_placeholder_text("Message agent...", window, cx);
                    editor
                })
            })
            .clone()
    }

    fn send_card_chat(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.card_chat_inputs.get(&thread_id).cloned() else {
            return;
        };
        let text = input.read(cx).text(cx);
        let message = text.trim();
        if message.is_empty() {
            input.focus_handle(cx).focus(window, cx);
            return;
        }
        let message = message.to_string();

        input.update(cx, |editor, cx| {
            editor.clear(window, cx);
        });

        let Some(conversation) = self.conversation_for_thread(thread_id, cx) else {
            input.update(cx, |editor, cx| {
                editor.set_text(text.as_str(), window, cx);
            });
            self.open_run(thread_id, window, cx);
            return;
        };
        let Some(thread_view) = conversation.read(cx).root_thread_view() else {
            input.update(cx, |editor, cx| {
                editor.set_text(text.as_str(), window, cx);
            });
            self.open_run(thread_id, window, cx);
            return;
        };

        thread_view.update(cx, |thread_view, cx| {
            thread_view.message_editor.update(cx, |message_editor, cx| {
                message_editor.clear(window, cx);
                message_editor.insert_text(&message, window, cx);
            });
            thread_view.send(window, cx);
        });
        cx.notify();
    }

    fn stop_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.stop_backboard_workspace_agent(thread_id, cx);
                    });
                }
            });
        }
    }

    fn retry_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.retry_backboard_workspace_agent(thread_id, cx);
                    });
                }
            });
        }
    }

    fn review_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.review_backboard_workspace_agent(thread_id, window, cx);
                    });
                }
            });
        }
    }

    fn apply_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.apply_backboard_workspace_agent(thread_id, cx);
                    });
                }
            });
        }
    }

    fn open_worktree(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.open_backboard_workspace_agent_worktree(thread_id, window, cx);
                    });
                }
            });
        }
    }

    fn revise_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        self.open_run(thread_id, window, cx);
        self.focus_selected_conversation(window, cx);
    }

    fn dismiss_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        self.dismissed_threads.insert(thread_id);
        self.card_chat_inputs.remove(&thread_id);
        if self.selected_thread_id == Some(thread_id) {
            self.selected_thread_id = None;
        }
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.dismiss_backboard_workspace_agent(thread_id, window, cx);
                    });
                }
            });
        }
        cx.notify();
    }

    fn render_header(
        &self,
        summaries: &[BackboardAgentRunSummary],
        right_panel_open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        BackboardAgentWorkspaceHeader::new(summaries, right_panel_open).render(cx)
    }

    fn render_header_stat(
        &self,
        value: String,
        label: &'static str,
        color: Color,
    ) -> impl IntoElement {
        h_flex()
            .gap_1()
            .child(
                Label::new(value)
                    .size(LabelSize::Small)
                    .weight(FontWeight::MEDIUM)
                    .color(color),
            )
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
    }

    fn render_counter_pill(
        &self,
        label: String,
        color: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (border, background) = match color {
            Color::Success => (
                cx.theme().status().success_border.opacity(0.62),
                cx.theme().status().success_background.opacity(0.14),
            ),
            Color::Warning => (
                cx.theme().status().warning_border.opacity(0.62),
                cx.theme().status().warning_background.opacity(0.14),
            ),
            Color::Error => (
                cx.theme().status().error_border.opacity(0.62),
                cx.theme().status().error_background.opacity(0.12),
            ),
            Color::Accent => (
                cx.theme().colors().text_accent.opacity(0.45),
                cx.theme().colors().element_active.opacity(0.22),
            ),
            _ => (
                cx.theme().colors().border_variant,
                cx.theme().colors().element_background,
            ),
        };

        div()
            .min_w(rems_from_px(88.))
            .h(rems_from_px(28.))
            .px_2()
            .rounded_sm()
            .border_1()
            .border_color(border)
            .bg(background)
            .flex()
            .items_center()
            .justify_center()
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .weight(FontWeight::MEDIUM)
                    .color(color),
            )
    }

    fn render_dashboard(
        &mut self,
        summaries: Vec<BackboardAgentRunSummary>,
        right_panel_open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let editor_background = cx.theme().colors().editor_background;
        let card_width = if right_panel_open {
            relative(0.48)
        } else {
            relative(0.235)
        };
        let card_min_width = if right_panel_open { px(320.) } else { px(260.) };

        if summaries.is_empty() {
            return v_flex()
                .size_full()
                .id("backboard-agent-workspace-empty")
                .overflow_hidden()
                .bg(editor_background)
                .child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_3()
                        .px_6()
                        .child(
                            div()
                                .size(px(56.))
                                .rounded(px(8.))
                                .border_1()
                                .border_color(cx.theme().colors().border_variant.opacity(0.58))
                                .bg(cx.theme().colors().elevated_surface_background)
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    Icon::new(IconName::Sparkle)
                                        .size(IconSize::XLarge)
                                        .color(Color::Custom(cx.theme().colors().text_accent)),
                                ),
                        )
                        .child(
                            Label::new("No agents in workspace")
                                .size(LabelSize::Default)
                                .weight(FontWeight::BOLD)
                                .color(Color::Default),
                        )
                        .child(
                            Label::new(
                                "Create an agent to track parallel tasks, reviews, and completed work here.",
                            )
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    Button::new("empty-new-agent-chat", "Create agent")
                                        .start_icon(Icon::new(IconName::Plus))
                                        .style(ButtonStyle::Filled)
                                        .size(ButtonSize::Compact)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.create_chat(window, cx);
                                        })),
                                )
                                .child(
                                    Button::new("empty-open-chat-history", "Open chat history")
                                        .style(ButtonStyle::Subtle)
                                        .size(ButtonSize::Compact)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.create_chat(window, cx);
                                        })),
                                ),
                        ),
                )
                .into_any_element();
        }

        let cards = summaries
            .into_iter()
            .map(|summary| {
                self.render_agent_workspace_card(summary, card_width, card_min_width, window, cx)
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        v_flex()
            .size_full()
            .id("backboard-agent-workspace-scroll")
            .track_scroll(&self.dashboard_scroll_handle)
            .overflow_y_scroll()
            .bg(editor_background)
            .child(
                h_flex()
                    .items_start()
                    .content_start()
                    .flex_wrap()
                    .gap(px(12.))
                    .p(px(12.))
                    .children(cards),
            )
            .vertical_scrollbar_for(&self.dashboard_scroll_handle, window, cx)
            .into_any_element()
    }

    fn render_api_status_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(28.))
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(cx.theme().colors().element_background)
            .child(
                div()
                    .size(px(6.))
                    .rounded_full()
                    .bg(cx.theme().status().warning_border),
            )
            .child(
                Label::new("API not connected")
                    .size(LabelSize::XSmall)
                    .color(Color::Disabled),
            )
    }

    fn render_api_unavailable_workspace(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let editor_background = cx.theme().colors().editor_background;
        let text_muted = cx.theme().colors().text_muted;
        let text_disabled = cx.theme().colors().text_disabled;

        v_flex()
            .flex_1()
            .min_h_0()
            .bg(editor_background)
            .child(self.render_api_status_bar(cx))
            .child(
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap(px(14.))
                    .px_6()
                    .child(
                        Icon::new(IconName::Info)
                            .size(IconSize::Custom(rems_from_px(28.)))
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Agents unavailable")
                            .size(LabelSize::Custom(rems_from_px(16.)))
                            .weight(FontWeight::BOLD)
                            .color(Color::Default),
                    )
                    .child(
                        div()
                            .max_w(px(360.))
                            .text_center()
                            .text_size(rems_from_px(13.))
                            .text_color(text_muted)
                            .line_height(relative(1.32))
                            .child(
                                "Connect an API key to create agents, run tasks, and generate workspace output.",
                            ),
                    )
                    .child(
                        Button::new("agent-workspace-connect-api-key", "Connect API key")
                            .style(ButtonStyle::Filled)
                            .size(ButtonSize::Large)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_api_key_settings(window, cx);
                            })),
                    )
                    .child(
                        Label::new("Continue without agents")
                            .size(LabelSize::Small)
                            .color(Color::Disabled),
                    )
                    .child(
                        div()
                            .max_w(px(360.))
                            .text_center()
                            .text_ui_xs(cx)
                            .text_color(text_disabled)
                            .line_height(relative(1.32))
                            .child("You can still browse files and inspect the workspace manually."),
                    ),
            )
    }

    fn render_batch_group(
        &self,
        batch_id: String,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let running = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Running)
            .count();
        let blocked = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Blocked)
            .count();
        let done = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Done)
            .count();
        let ready = summaries.iter().filter(|summary| summary.can_apply).count();
        let batch_size = summaries
            .iter()
            .map(|summary| summary.batch_size)
            .max()
            .unwrap_or(summaries.len());
        let cards = summaries
            .into_iter()
            .map(|summary| self.render_agent_card(summary, cx).into_any_element())
            .collect::<Vec<_>>();
        let short_id = batch_id.chars().take(8).collect::<String>();

        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Label::new(format!("Batch {short_id}"))
                                    .size(LabelSize::Small)
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new(format!("{batch_size} threads"))
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(self.render_counter_pill(
                                format!("{running} running"),
                                Color::Accent,
                                cx,
                            ))
                            .child(self.render_counter_pill(
                                format!("{blocked} blocked"),
                                if blocked > 0 {
                                    Color::Warning
                                } else {
                                    Color::Muted
                                },
                                cx,
                            ))
                            .child(self.render_counter_pill(
                                format!("{done} done"),
                                Color::Success,
                                cx,
                            ))
                            .child(self.render_counter_pill(
                                format!("{ready} ready"),
                                if ready > 0 {
                                    Color::Success
                                } else {
                                    Color::Muted
                                },
                                cx,
                            )),
                    ),
            )
            .child(h_flex().items_start().flex_wrap().gap_2().children(cards))
            .into_any_element()
    }

    fn render_blocked_overview(
        &self,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let count = summaries.len();
        let suffix = if count == 1 { "" } else { "s" };

        h_flex()
            .mx_5()
            .mt_2()
            .gap_2()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().status().warning_border.opacity(0.45))
            .bg(cx.theme().status().warning_background.opacity(0.04))
            .px_2()
            .py_1()
            .child(
                Icon::new(IconName::Warning)
                    .size(IconSize::XSmall)
                    .color(Color::Warning),
            )
            .child(
                Label::new(format!("{count} blocked agent{suffix}"))
                    .size(LabelSize::XSmall)
                    .color(Color::Warning),
            )
    }

    fn render_agent_workspace_card(
        &mut self,
        summary: BackboardAgentRunSummary,
        card_width: DefiniteLength,
        card_min_width: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let selected = self.selected_thread_id == Some(thread_id);
        let (
            text_accent,
            text,
            border_variant,
            elevated_surface_background,
            panel_background,
            hover_border,
        ) = {
            let colors = cx.theme().colors();
            (
                colors.text_accent,
                colors.text,
                colors.border_variant,
                colors.elevated_surface_background,
                colors.panel_background,
                colors.border,
            )
        };
        let border_color = if selected {
            text_accent
        } else {
            border_variant.opacity(0.58)
        };
        let background = if selected {
            elevated_surface_background.blend(text_accent.opacity(0.035))
        } else {
            elevated_surface_background
        };
        let command = Self::clean_command_label(summary.command.as_ref());
        let command_kind = summary
            .kind_label
            .as_ref()
            .map(|label| label.as_ref().to_lowercase())
            .unwrap_or_else(|| "build".to_string());
        let chat_input = self.card_chat_input(thread_id, window, cx);

        v_flex()
            .id(format!("backboard-agent-card-{thread_key}"))
            .w(card_width)
            .min_w(card_min_width)
            .max_w(relative(1.))
            .h(px(420.))
            .flex_none()
            .rounded(px(8.))
            .border_1()
            .border_color(border_color)
            .bg(background)
            .overflow_hidden()
            .cursor_pointer()
            .hover(move |style| style.border_color(hover_border))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_run(thread_id, window, cx);
            }))
            .child(
                h_flex()
                    .h(px(56.))
                    .px_3()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(border_variant.opacity(0.36))
                    .child(self.render_status_dot(summary.status, cx))
                    .child(
                        Label::new(summary.title.clone())
                            .size(LabelSize::Default)
                            .weight(FontWeight::BOLD)
                            .color(Color::Custom(text))
                            .truncate()
                            .flex_1(),
                    )
                    .child(self.render_status_badge(summary.status, cx))
                    .child(
                        IconButton::new(
                            format!("open-agent-detail-{thread_key}"),
                            if selected {
                                IconName::ThreadsSidebarRightOpen
                            } else {
                                IconName::ThreadsSidebarRightClosed
                            },
                        )
                        .icon_size(IconSize::XSmall)
                        .icon_color(Color::Muted)
                        .tooltip(Tooltip::text("Open chat"))
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.open_run(thread_id, window, cx);
                            },
                        )),
                    ),
            )
            .child(
                v_flex()
                    .min_h(px(58.))
                    .px_3()
                    .py_1p5()
                    .gap_0p5()
                    .border_b_1()
                    .border_color(border_variant.opacity(0.28))
                    .bg(panel_background.opacity(0.18))
                    .child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .child(Label::new("$").size(LabelSize::Small).color(Color::Muted))
                            .child(
                                Label::new(command_kind)
                                    .size(LabelSize::Small)
                                    .weight(FontWeight::MEDIUM)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .text_ui_sm(cx)
                            .line_height(relative(1.28))
                            .text_color(text)
                            .line_clamp(1)
                            .child(command),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(self.render_card_activity(&summary, cx)),
            )
            .child(self.render_card_file_chips(&summary, cx))
            .child(self.render_card_footer(&summary, thread_key, cx))
            .child(self.render_card_chat_bar(thread_id, chat_input, window, cx))
    }

    fn render_card_activity(
        &self,
        summary: &BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if summary.status == BackboardAgentRunStatus::Blocked {
            let reason = summary
                .blocked_reason
                .clone()
                .unwrap_or_else(|| "Waiting for input before this agent can continue.".into());
            let blocked_color = Color::Custom(cx.theme().status().error);
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .px_6()
                .child(
                    Icon::new(IconName::Warning)
                        .size(IconSize::Small)
                        .color(blocked_color),
                )
                .child(
                    Label::new("Waiting on dependency")
                        .size(LabelSize::Small)
                        .weight(FontWeight::BOLD)
                        .color(blocked_color),
                )
                .child(
                    div()
                        .max_w(px(420.))
                        .text_center()
                        .text_ui_sm(cx)
                        .line_height(relative(1.32))
                        .text_color(cx.theme().colors().text_muted)
                        .line_clamp(3)
                        .child(reason),
                )
                .into_any_element();
        }

        if summary.status == BackboardAgentRunStatus::Queued {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .px_5()
                .child(
                    Icon::new(IconName::Info)
                        .size(IconSize::XSmall)
                        .color(Color::Custom(cx.theme().status().info)),
                )
                .child(
                    Label::new("Queued - waiting for next step")
                        .size(LabelSize::Small)
                        .line_height_style(LineHeightStyle::UiLabel)
                        .color(Color::Muted),
                )
                .into_any_element();
        }

        let rows = summary
            .latest_events
            .iter()
            .take(6)
            .map(|event| Self::render_workspace_activity_row(event.text.clone(), event.state, cx))
            .collect::<Vec<_>>();

        if rows.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_1()
                .child(
                    Icon::new(IconName::Circle)
                        .size(IconSize::XSmall)
                        .color(Color::Muted),
                )
                .child(
                    Label::new("No activity yet")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .into_any_element();
        }

        v_flex()
            .size_full()
            .gap_1()
            .px_3()
            .py_2()
            .children(rows)
            .into_any_element()
    }

    fn render_card_file_chips(
        &self,
        summary: &BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let total_touched_paths = summary.touched_paths.len();
        let mut labels = summary
            .touched_paths
            .iter()
            .take(3)
            .map(|path| Self::file_chip_label(path))
            .collect::<Vec<_>>();

        if labels.is_empty() && summary.files_changed > 0 {
            labels.push(format!(
                "{} {}",
                summary.files_changed,
                if summary.files_changed == 1 {
                    "file"
                } else {
                    "files"
                }
            ));
        }
        if total_touched_paths > 3 {
            labels.push(format!("+{} more", total_touched_paths - 3));
        }

        if labels.is_empty() {
            return h_flex()
                .min_h(px(38.))
                .px_3()
                .py_1p5()
                .items_center()
                .border_t_1()
                .border_color(cx.theme().colors().border_variant.opacity(0.28))
                .child(
                    Label::new("No files touched")
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                )
                .into_any_element();
        }

        h_flex()
            .min_h(px(38.))
            .px_3()
            .py_1p5()
            .gap_1p5()
            .items_center()
            .flex_wrap()
            .border_t_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.28))
            .children(labels.into_iter().map(|label| {
                h_flex()
                    .gap_1()
                    .items_center()
                    .px_2()
                    .py_0p5()
                    .rounded(px(4.))
                    .border_1()
                    .border_color(cx.theme().colors().border_variant.opacity(0.36))
                    .bg(cx.theme().colors().panel_background.opacity(0.28))
                    .child(
                        Icon::new(IconName::Info)
                            .size(IconSize::XSmall)
                            .color(Color::Custom(cx.theme().status().info)),
                    )
                    .child(
                        Label::new(label)
                            .size(LabelSize::XSmall)
                            .color(Color::Default)
                            .truncate(),
                    )
            }))
            .into_any_element()
    }

    fn render_card_footer(
        &self,
        summary: &BackboardAgentRunSummary,
        thread_key: String,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let border_variant = cx.theme().colors().border_variant;
        let success = cx.theme().status().success;
        let warning = cx.theme().status().warning;
        let error = cx.theme().status().error;

        h_flex()
            .h(px(38.))
            .px_3()
            .gap_1p5()
            .items_center()
            .border_t_1()
            .border_color(border_variant.opacity(0.42))
            .child(
                IconButton::new(format!("open-worktree-{thread_key}"), IconName::FolderOpen)
                    .icon_size(IconSize::XSmall)
                    .icon_color(Color::Muted)
                    .tooltip(Tooltip::text(if summary.working_directory_is_worktree {
                        "Open agent worktree"
                    } else {
                        "Open agent working directory"
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_worktree(thread_id, window, cx);
                    })),
            )
            .when(summary.can_review, |this| {
                this.child(
                    IconButton::new(format!("review-agent-{thread_key}"), IconName::GitBranch)
                        .icon_size(IconSize::XSmall)
                        .icon_color(Color::Muted)
                        .tooltip(Tooltip::text("Review changes"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.review_run(thread_id, window, cx);
                        })),
                )
            })
            .when(summary.can_apply, |this| {
                this.child(
                    IconButton::new(format!("apply-agent-{thread_key}"), IconName::Check)
                        .icon_size(IconSize::XSmall)
                        .icon_color(Color::Custom(success))
                        .tooltip(Tooltip::text("Apply changes"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.apply_run(thread_id, cx);
                        })),
                )
            })
            .child(div().flex_1())
            .children(summary.cost.clone().map(|cost| {
                Label::new(cost)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .alpha(0.85)
            }))
            .child(
                Label::new(Self::footer_model_label(summary))
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .alpha(0.85),
            )
            .child(
                IconButton::new(
                    format!("open-agent-chat-{thread_key}"),
                    IconName::ThreadsSidebarRightClosed,
                )
                .icon_size(IconSize::XSmall)
                .icon_color(Color::Muted)
                .tooltip(Tooltip::text("Open chat"))
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.open_run(thread_id, window, cx);
                })),
            )
            .when(
                matches!(
                    summary.status,
                    BackboardAgentRunStatus::Running | BackboardAgentRunStatus::Queued
                ),
                |this| {
                    this.child(
                        IconButton::new(format!("stop-agent-{thread_key}"), IconName::Stop)
                            .icon_size(IconSize::XSmall)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("Stop agent"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.stop_run(thread_id, cx);
                            })),
                    )
                },
            )
            .when(summary.status == BackboardAgentRunStatus::Blocked, |this| {
                this.child(
                    IconButton::new(format!("revise-agent-{thread_key}"), IconName::Pencil)
                        .icon_size(IconSize::XSmall)
                        .icon_color(Color::Custom(warning))
                        .tooltip(Tooltip::text("Revise blocked agent"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.revise_run(thread_id, window, cx);
                        })),
                )
            })
            .when(
                matches!(
                    summary.status,
                    BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled
                ),
                |this| {
                    this.child(
                        IconButton::new(format!("retry-agent-{thread_key}"), IconName::Rerun)
                            .icon_size(IconSize::XSmall)
                            .icon_color(Color::Custom(error))
                            .tooltip(Tooltip::text("Retry agent"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.retry_run(thread_id, cx);
                            })),
                    )
                },
            )
            .when(
                matches!(
                    summary.status,
                    BackboardAgentRunStatus::Done
                        | BackboardAgentRunStatus::Error
                        | BackboardAgentRunStatus::Canceled
                ),
                |this| {
                    this.child(
                        IconButton::new(format!("dismiss-agent-{thread_key}"), IconName::Check)
                            .icon_size(IconSize::XSmall)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("Dismiss card"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.dismiss_run(thread_id, window, cx);
                            })),
                    )
                },
            )
    }

    fn render_card_chat_bar(
        &self,
        thread_id: ThreadId,
        editor: Entity<Editor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_key = thread_id.to_key_string();
        let colors = cx.theme().colors();
        let focus_handle = editor.focus_handle(cx);
        let focused = focus_handle.is_focused(window);
        let input_border = if focused {
            colors.border_focused
        } else {
            colors.border_variant.opacity(0.46)
        };
        let input_background = colors
            .editor_background
            .blend(colors.element_background.opacity(0.06));

        h_flex()
            .id(format!("agent-card-chat-bar-{thread_key}"))
            .h(px(50.))
            .px_2()
            .gap_1p5()
            .items_center()
            .border_t_1()
            .border_color(colors.border_variant.opacity(0.32))
            .bg(colors.panel_background.opacity(0.16))
            .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation();
            })
            .on_click(cx.listener(|_, _, _, cx| {
                cx.stop_propagation();
            }))
            .on_action(cx.listener(move |this, _: &Chat, window, cx| {
                this.send_card_chat(thread_id, window, cx);
            }))
            .child(
                Icon::new(IconName::Chat)
                    .size(IconSize::XSmall)
                    .color(Color::Muted),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(34.))
                    .px_2()
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(input_border)
                    .bg(input_background)
                    .track_focus(&focus_handle)
                    .child(editor),
            )
            .child(
                IconButton::new(
                    format!("send-agent-card-message-{thread_key}"),
                    IconName::Send,
                )
                .icon_size(IconSize::XSmall)
                .icon_color(Color::Muted)
                .tooltip(Tooltip::text("Send message"))
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.send_card_chat(thread_id, window, cx);
                })),
            )
    }

    fn render_workspace_activity_row(
        text: SharedString,
        state: BackboardAgentRunEventState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (icon, icon_color, text_color) = match state {
            BackboardAgentRunEventState::Active => (
                IconName::LoadCircle,
                Color::Custom(cx.theme().status().info),
                Color::Default,
            ),
            BackboardAgentRunEventState::Done => {
                let color = Color::Custom(cx.theme().status().success);
                (IconName::Check, color, color)
            }
            BackboardAgentRunEventState::Waiting => (
                IconName::Info,
                Color::Custom(cx.theme().status().info),
                Color::Muted,
            ),
            BackboardAgentRunEventState::Failed => {
                let color = Color::Custom(cx.theme().status().error);
                (IconName::Warning, color, color)
            }
            BackboardAgentRunEventState::Muted => (IconName::Info, Color::Muted, Color::Default),
        };

        h_flex()
            .items_start()
            .min_w_0()
            .gap_1p5()
            .px_1p5()
            .py_1()
            .rounded(px(5.))
            .border_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.22))
            .bg(cx.theme().colors().panel_background.opacity(0.16))
            .child(
                div()
                    .w(px(16.))
                    .h(px(18.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .flex_none()
                    .child(Icon::new(icon).size(IconSize::XSmall).color(icon_color)),
            )
            .child(
                Label::new(text)
                    .size(LabelSize::Small)
                    .line_height_style(LineHeightStyle::UiLabel)
                    .color(text_color)
                    .truncate()
                    .flex_1(),
            )
            .into_any_element()
    }

    fn clean_command_label(command: &str) -> SharedString {
        command
            .trim()
            .trim_start_matches('$')
            .trim()
            .to_string()
            .into()
    }

    fn file_chip_label(path: &str) -> String {
        path.rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(path)
            .to_string()
    }

    fn footer_model_label(summary: &BackboardAgentRunSummary) -> SharedString {
        summary
            .speed_metrics
            .as_ref()
            .and_then(|metrics| metrics.model.clone().map(SharedString::from))
            .or_else(|| summary.kind_label.clone())
            .unwrap_or_else(|| "Agent".into())
    }

    fn render_agent_card(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let selected = self.selected_thread_id == Some(thread_id);
        let (border_color, background) = match summary.status {
            BackboardAgentRunStatus::Done => (
                cx.theme().status().success_border.opacity(0.6),
                cx.theme().status().success_background.opacity(0.08),
            ),
            BackboardAgentRunStatus::Blocked => (
                cx.theme().status().warning_border.opacity(0.7),
                cx.theme().status().warning_background.opacity(0.08),
            ),
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => (
                cx.theme().status().error_border.opacity(0.65),
                cx.theme().status().error_background.opacity(0.07),
            ),
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => (
                cx.theme().colors().border_variant,
                cx.theme().colors().elevated_surface_background,
            ),
        };
        let border_color = if selected {
            cx.theme().colors().text_accent
        } else {
            border_color
        };
        let card_label = match summary.status {
            BackboardAgentRunStatus::Blocked => "Needs input",
            BackboardAgentRunStatus::Error => "Broken",
            BackboardAgentRunStatus::Canceled => "Stopped",
            BackboardAgentRunStatus::Done => "Finished",
            BackboardAgentRunStatus::Queued => "Queued",
            BackboardAgentRunStatus::Running => "Streaming",
        };
        let working_directory_icon = if summary.working_directory_is_worktree {
            IconName::GitWorktree
        } else {
            IconName::Folder
        };
        let working_directory_tooltip = summary.working_directory_path.clone();

        v_flex()
            .id(format!("backboard-agent-card-{thread_key}"))
            .min_w(rems_from_px(320.))
            .max_w(rems_from_px(420.))
            .min_h(rems_from_px(248.))
            .flex_1()
            .rounded_lg()
            .border_1()
            .border_color(border_color)
            .bg(background)
            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
            .overflow_hidden()
            .cursor_pointer()
            .hover(|style| style.border_color(cx.theme().colors().border))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_run(thread_id, window, cx);
            }))
            .child(
                h_flex()
                    .min_h(rems_from_px(50.))
                    .px_3()
                    .py_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .gap_2()
                            .min_w_0()
                            .items_center()
                            .child(
                                Vector::square(VectorName::ZedLogo, rems_from_px(14.))
                                    .color(Self::status_label_color(summary.status)),
                            )
                            .child(self.render_status_dot(summary.status, cx))
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .gap_0()
                                    .child(
                                        Label::new(summary.title.clone())
                                            .size(LabelSize::Small)
                                            .color(match summary.status {
                                                BackboardAgentRunStatus::Blocked => Color::Warning,
                                                BackboardAgentRunStatus::Error
                                                | BackboardAgentRunStatus::Canceled => Color::Error,
                                                BackboardAgentRunStatus::Done => Color::Success,
                                                BackboardAgentRunStatus::Queued
                                                | BackboardAgentRunStatus::Running => Color::Accent,
                                            })
                                            .weight(FontWeight::MEDIUM),
                                    )
                                    .child(
                                        Label::new(card_label)
                                            .size(LabelSize::Small)
                                            .color(Color::Muted)
                                            .alpha(0.8),
                                    )
                                    .when_some(
                                        summary.working_directory_label.clone(),
                                        |this, label| {
                                            let tooltip = working_directory_tooltip
                                                .clone()
                                                .unwrap_or_else(|| label.clone());
                                            this.child(
                                                h_flex()
                                                    .id(format!("agent-directory-{thread_key}"))
                                                    .gap_1()
                                                    .min_w_0()
                                                    .tooltip(Tooltip::text(tooltip.to_string()))
                                                    .child(
                                                        Icon::new(working_directory_icon)
                                                            .size(IconSize::XSmall)
                                                            .color(Color::Muted),
                                                    )
                                                    .child(
                                                        Label::new(label)
                                                            .size(LabelSize::Small)
                                                            .color(Color::Accent),
                                                    ),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(self.render_status_badge(summary.status, cx))
                            .child(
                                IconButton::new(
                                    format!("open-agent-detail-{thread_key}"),
                                    IconName::ArrowUpRight,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Open chat detail"))
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.open_run(thread_id, window, cx);
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .py_2()
                    .px_3()
                    .flex_1()
                    .min_h_0()
                    .child(if self.show_token_context {
                        self.render_token_context_preview(&summary, cx)
                            .into_any_element()
                    } else {
                        self.render_terminal_preview(&summary, cx)
                            .into_any_element()
                    })
                    .when(
                        summary.branch_label.is_some() || summary.apply_state_label.is_some(),
                        |this| {
                            this.child(
                                h_flex()
                                    .gap_1()
                                    .flex_wrap()
                                    .when_some(summary.branch_label.clone(), |this, branch| {
                                        this.child(
                                            h_flex()
                                                .gap_1()
                                                .child(
                                                    Icon::new(IconName::GitBranch)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Muted),
                                                )
                                                .child(
                                                    Label::new(branch)
                                                        .size(LabelSize::Small)
                                                        .color(Color::Accent),
                                                ),
                                        )
                                    })
                                    .when_some(summary.apply_state_label.clone(), |this, label| {
                                        this.child(
                                            Label::new(label)
                                                .size(LabelSize::Small)
                                                .color(Color::Accent),
                                        )
                                    }),
                            )
                        },
                    )
                    .when_some(summary.blocked_reason.clone(), |this, reason| {
                        this.child(
                            div()
                                .rounded_sm()
                                .border_1()
                                .border_color(cx.theme().status().warning_border.opacity(0.55))
                                .bg(cx.theme().status().warning_background.opacity(0.08))
                                .px_2()
                                .py_1()
                                .child(
                                    h_flex()
                                        .gap_1p5()
                                        .child(
                                            Icon::new(IconName::Warning)
                                                .size(IconSize::XSmall)
                                                .color(Color::Warning),
                                        )
                                        .child(
                                            Label::new(reason)
                                                .size(LabelSize::Small)
                                                .color(Color::Warning),
                                        ),
                                ),
                        )
                    }),
            )
            .child(
                h_flex()
                    .h(rems_from_px(36.))
                    .px_3()
                    .justify_between()
                    .border_t_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Label::new(format!("{} files", summary.files_changed))
                                    .size(LabelSize::Small)
                                    .color(Color::Accent),
                            )
                            .children(summary.cost.clone().map(|cost| {
                                Label::new(cost).size(LabelSize::Small).color(Color::Muted)
                            })),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .when(summary.can_review, |this| {
                                this.child(
                                    Button::new(format!("review-agent-{thread_key}"), "Review")
                                        .start_icon(Icon::new(IconName::GitBranch))
                                        .style(ButtonStyle::Outlined)
                                        .size(ButtonSize::Compact)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            this.review_run(thread_id, window, cx);
                                        })),
                                )
                            })
                            .when(summary.can_apply, |this| {
                                this.child(
                                    Button::new(format!("apply-agent-{thread_key}"), "Apply")
                                        .start_icon(Icon::new(IconName::Check))
                                        .style(ButtonStyle::Tinted(TintColor::Accent))
                                        .size(ButtonSize::Compact)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            cx.stop_propagation();
                                            this.apply_run(thread_id, cx);
                                        })),
                                )
                            })
                            .when(summary.working_directory_is_worktree, |this| {
                                this.child(
                                    IconButton::new(
                                        format!("open-worktree-{thread_key}"),
                                        IconName::FolderOpen,
                                    )
                                    .icon_size(IconSize::Small)
                                    .tooltip(Tooltip::text("Open agent worktree"))
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            this.open_worktree(thread_id, window, cx);
                                        },
                                    )),
                                )
                            })
                            .when(
                                matches!(
                                    summary.status,
                                    BackboardAgentRunStatus::Running
                                        | BackboardAgentRunStatus::Queued
                                ),
                                |this| {
                                    this.child(
                                        IconButton::new(
                                            format!("stop-agent-{thread_key}"),
                                            IconName::Stop,
                                        )
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Stop agent"))
                                        .on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                this.stop_run(thread_id, cx);
                                            }),
                                        ),
                                    )
                                },
                            )
                            .when(summary.status == BackboardAgentRunStatus::Blocked, |this| {
                                this.child(
                                    Button::new(format!("revise-agent-{thread_key}"), "Revise")
                                        .start_icon(Icon::new(IconName::Pencil))
                                        .style(ButtonStyle::Outlined)
                                        .size(ButtonSize::Compact)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            this.revise_run(thread_id, window, cx);
                                        })),
                                )
                            })
                            .when(
                                matches!(
                                    summary.status,
                                    BackboardAgentRunStatus::Error
                                        | BackboardAgentRunStatus::Canceled
                                ),
                                |this| {
                                    this.child(
                                        IconButton::new(
                                            format!("retry-agent-{thread_key}"),
                                            IconName::Rerun,
                                        )
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Retry agent"))
                                        .on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                this.retry_run(thread_id, cx);
                                            }),
                                        ),
                                    )
                                },
                            )
                            .when(
                                matches!(
                                    summary.status,
                                    BackboardAgentRunStatus::Done
                                        | BackboardAgentRunStatus::Error
                                        | BackboardAgentRunStatus::Canceled
                                ),
                                |this| {
                                    this.child(
                                        IconButton::new(
                                            format!("dismiss-agent-{thread_key}"),
                                            IconName::Check,
                                        )
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Dismiss card"))
                                        .on_click(
                                            cx.listener(move |this, _, window, cx| {
                                                cx.stop_propagation();
                                                this.dismiss_run(thread_id, window, cx);
                                            }),
                                        ),
                                    )
                                },
                            )
                            .when(
                                matches!(
                                    summary.status,
                                    BackboardAgentRunStatus::Running
                                        | BackboardAgentRunStatus::Blocked
                                        | BackboardAgentRunStatus::Queued
                                ),
                                |this| {
                                    this.child(
                                        IconButton::new(
                                            format!("open-running-agent-{thread_key}"),
                                            IconName::ArrowUpRight,
                                        )
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Open chat detail"))
                                        .on_click(
                                            cx.listener(move |this, _, window, cx| {
                                                cx.stop_propagation();
                                                this.open_run(thread_id, window, cx);
                                            }),
                                        ),
                                    )
                                },
                            ),
                    ),
            )
    }

    fn render_terminal_preview(
        &self,
        summary: &BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let event_rows = summary
            .latest_events
            .iter()
            .take(4)
            .map(|event| Self::render_terminal_event_row(event.text.clone(), event.state, cx))
            .collect::<Vec<_>>();

        v_flex()
            .flex_1()
            .min_h(rems_from_px(124.))
            .overflow_y_hidden()
            .child(
                h_flex()
                    .h(rems_from_px(20.))
                    .gap_1p5()
                    .child(
                        Icon::new(IconName::Command)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("live activity")
                            .size(LabelSize::Small)
                            .buffer_font(cx)
                            .color(Color::Muted),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .pt_1()
                    .child(
                        h_flex()
                            .items_start()
                            .gap_1p5()
                            .min_w_0()
                            .child(
                                Label::new("$")
                                    .size(LabelSize::Small)
                                    .buffer_font(cx)
                                    .color(Color::Accent)
                                    .flex_none(),
                            )
                            .child(
                                Label::new(summary.command.clone())
                                    .size(LabelSize::Small)
                                    .buffer_font(cx)
                                    .line_height_style(LineHeightStyle::UiLabel)
                                    .color(Color::Default)
                                    .flex_1(),
                            ),
                    )
                    .children(event_rows),
            )
    }

    fn render_token_context_preview(
        &self,
        summary: &BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut lines = Self::token_context_lines(summary);
        if lines.is_empty() {
            lines.push("Usage metrics will appear after the first model response.".to_string());
        }

        v_flex()
            .flex_1()
            .min_h(rems_from_px(124.))
            .child(v_flex().gap_1().children(lines.into_iter().map(|line| {
                h_flex()
                    .items_start()
                    .min_w_0()
                    .gap_1p5()
                    .child(Icon::new(IconName::ArrowRight).size(IconSize::XSmall))
                    .child(
                        Label::new(line)
                            .size(LabelSize::Small)
                            .buffer_font(cx)
                            .line_height_style(LineHeightStyle::UiLabel)
                            .color(Color::Muted)
                            .flex_1(),
                    )
                    .into_any_element()
            })))
    }

    fn token_context_lines(summary: &BackboardAgentRunSummary) -> Vec<String> {
        let mut lines = Vec::new();

        if let Some(usage) = summary.token_usage.as_ref()
            && (usage.max_tokens > 0
                || usage.used_tokens > 0
                || usage.input_tokens > 0
                || usage.output_tokens > 0)
        {
            let used = crate::humanize_token_count(usage.used_tokens);
            let max = crate::humanize_token_count(usage.max_tokens);
            let input = crate::humanize_token_count(usage.input_tokens);
            let output = crate::humanize_token_count(usage.output_tokens);
            lines.push(format!("{used} / {max} tokens"));
            lines.push(format!("input / output: {input} / {output}"));
        }

        if let Some(cost) = summary.cost.as_ref() {
            lines.push(format!("cost: {cost}"));
        }

        if let Some(metrics) = summary.speed_metrics.as_ref() {
            Self::push_speed_line(&mut lines, "first token", metrics.first_token_ms);
            Self::push_speed_line(&mut lines, "total turn", metrics.total_turn_ms);
            Self::push_speed_line(&mut lines, "runtime", metrics.runtime_load_ms);
            Self::push_speed_line(&mut lines, "models", metrics.model_list_ms);
            Self::push_speed_line(&mut lines, "assistant", metrics.assistant_create_ms);
            Self::push_speed_line(&mut lines, "context pack", metrics.context_pack_ms);
            Self::push_speed_line(&mut lines, "semantic context", metrics.semantic_context_ms);
            Self::push_speed_line(&mut lines, "tools", metrics.tool_batch_ms);
            Self::push_speed_line(&mut lines, "shell", metrics.shell_tools_ms);
            Self::push_speed_line(&mut lines, "reads", metrics.read_tools_ms);
            Self::push_speed_line(&mut lines, "searches", metrics.search_tools_ms);
            Self::push_speed_line(&mut lines, "edits", metrics.edit_tools_ms);
            Self::push_speed_line(&mut lines, "other tools", metrics.other_tools_ms);
            Self::push_speed_line(&mut lines, "file writes", metrics.file_write_ms);
            Self::push_speed_line(&mut lines, "approval wait", metrics.command_wait_ms);

            if let (Some(name), Some(value)) =
                (metrics.slowest_tool.as_ref(), metrics.slowest_tool_ms)
            {
                lines.push(format!("slowest tool: {} {}", name, Self::format_ms(value)));
            }
            if let Some(model) = metrics.model.as_ref() {
                lines.push(format!("model: {model}"));
            }
            if let Some(provider) = metrics.provider.as_ref() {
                lines.push(format!("provider: {provider}"));
            }
            if let Some(intensity) = metrics.intensity.as_ref() {
                lines.push(format!("intensity: {intensity}"));
            }
            if let Some(value) = metrics.tool_calls_count {
                lines.push(format!("tool calls: {value}"));
            }
            if let Some(value) = metrics.shell_tools_count {
                lines.push(format!("shell calls: {value}"));
            }
            if let Some(value) = metrics.read_tools_count {
                lines.push(format!("read calls: {value}"));
            }
            if let Some(value) = metrics.search_tools_count {
                lines.push(format!("search calls: {value}"));
            }
            if let Some(value) = metrics.edit_tools_count {
                lines.push(format!("edit calls: {value}"));
            }
            if let Some(value) = metrics.other_tools_count {
                lines.push(format!("other calls: {value}"));
            }
        }

        lines
    }

    fn push_speed_line(lines: &mut Vec<String>, label: &'static str, value: Option<f64>) {
        if let Some(value) = value {
            lines.push(format!("{label}: {}", Self::format_ms(value)));
        }
    }

    fn format_ms(value: f64) -> String {
        if value >= 1000.0 {
            format!("{:.1}s", value / 1000.0)
        } else {
            format!("{}ms", value.round() as u64)
        }
    }

    fn render_terminal_event_row(
        text: SharedString,
        state: BackboardAgentRunEventState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (icon, color) = match state {
            BackboardAgentRunEventState::Active => (IconName::LoadCircle, Color::Accent),
            BackboardAgentRunEventState::Done => (IconName::Check, Color::Success),
            BackboardAgentRunEventState::Waiting => (IconName::Warning, Color::Warning),
            BackboardAgentRunEventState::Failed => (IconName::XCircle, Color::Error),
            BackboardAgentRunEventState::Muted => (IconName::ArrowRight, Color::Muted),
        };

        h_flex()
            .items_start()
            .min_w_0()
            .gap_1p5()
            .child(Icon::new(icon).size(IconSize::XSmall).color(color))
            .child(
                Label::new(text)
                    .size(LabelSize::Small)
                    .buffer_font(cx)
                    .line_height_style(LineHeightStyle::UiLabel)
                    .color(color)
                    .flex_1(),
            )
            .into_any_element()
    }

    fn render_status_dot(
        &self,
        status: BackboardAgentRunStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let color: Hsla = match status {
            BackboardAgentRunStatus::Done => cx.theme().status().success,
            BackboardAgentRunStatus::Blocked => cx.theme().status().error,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => {
                cx.theme().status().error
            }
            BackboardAgentRunStatus::Queued => cx.theme().colors().icon_muted,
            BackboardAgentRunStatus::Running => cx.theme().status().info,
        };

        div().size(px(7.)).rounded_full().bg(color)
    }

    fn render_status_badge(
        &self,
        status: BackboardAgentRunStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (label, color, border, background) = match status {
            BackboardAgentRunStatus::Done => (
                "DONE",
                Color::Custom(cx.theme().status().success),
                cx.theme().status().success_border.opacity(0.72),
                cx.theme().status().success_background.opacity(0.16),
            ),
            BackboardAgentRunStatus::Blocked => (
                "BLOCKED",
                Color::Custom(cx.theme().status().error),
                cx.theme().status().error_border.opacity(0.72),
                cx.theme().status().error_background.opacity(0.13),
            ),
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => (
                if status == BackboardAgentRunStatus::Canceled {
                    "STOPPED"
                } else {
                    "ERROR"
                },
                Color::Custom(cx.theme().status().error),
                cx.theme().status().error_border.opacity(0.72),
                cx.theme().status().error_background.opacity(0.13),
            ),
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => (
                if status == BackboardAgentRunStatus::Queued {
                    "QUEUED"
                } else {
                    "LIVE"
                },
                if status == BackboardAgentRunStatus::Queued {
                    Color::Custom(cx.theme().colors().text_muted)
                } else {
                    Color::Custom(cx.theme().status().info)
                },
                if status == BackboardAgentRunStatus::Queued {
                    cx.theme().colors().border_variant.opacity(0.72)
                } else {
                    cx.theme().status().info_border.opacity(0.72)
                },
                if status == BackboardAgentRunStatus::Queued {
                    cx.theme().colors().element_background.opacity(0.2)
                } else {
                    cx.theme().status().info_background.opacity(0.16)
                },
            ),
        };

        div()
            .h(rems_from_px(20.))
            .px_2()
            .rounded(px(4.))
            .border_1()
            .border_color(border)
            .bg(background)
            .flex()
            .items_center()
            .child(
                Label::new(label)
                    .size(LabelSize::XSmall)
                    .weight(FontWeight::BOLD)
                    .color(color),
            )
    }

    fn status_label_color(status: BackboardAgentRunStatus) -> Color {
        match status {
            BackboardAgentRunStatus::Done => Color::Success,
            BackboardAgentRunStatus::Blocked => Color::Warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => Color::Error,
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => Color::Accent,
        }
    }

    fn render_bottom_bar(
        &self,
        summaries: &[BackboardAgentRunSummary],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let active = summaries
            .iter()
            .filter(|summary| {
                matches!(
                    summary.status,
                    BackboardAgentRunStatus::Running
                        | BackboardAgentRunStatus::Blocked
                        | BackboardAgentRunStatus::Queued
                )
            })
            .count();
        let files = summaries
            .iter()
            .map(|summary| summary.files_changed)
            .sum::<usize>();

        h_flex()
            .h(rems_from_px(28.))
            .px_4()
            .justify_between()
            .border_t_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().tab_bar_background)
            .child(
                h_flex()
                    .gap_4()
                    .child(
                        Label::new(format!("{active} active agents"))
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    )
                    .child(
                        Label::new(format!("{files} files modified"))
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    ),
            )
            .child(
                Label::new("System healthy")
                    .size(LabelSize::Small)
                    .color(Color::Accent),
            )
    }

    fn render_main_pane(
        &self,
        summaries: &[BackboardAgentRunSummary],
        selected_detail: Option<(BackboardAgentRunSummary, Entity<ConversationView>)>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match selected_detail {
            Some((summary, conversation)) => v_flex()
                .size_full()
                .min_w_0()
                .bg(cx.theme().colors().editor_background)
                .child(self.render_selected_agent_header(summary, cx))
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .overflow_hidden()
                        .child(conversation),
                )
                .into_any_element(),
            None if summaries.is_empty() => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_3()
                .px_8()
                .bg(cx.theme().colors().editor_background)
                .child(
                    Icon::new(IconName::Sparkle)
                        .size(IconSize::XLarge)
                        .color(Color::Muted),
                )
                .child(
                    Headline::new("Start an agent")
                        .size(HeadlineSize::XSmall)
                        .color(Color::Default),
                )
                .child(
                    Label::new("Use New Chat to open a real Backboard chat.")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .into_any_element(),
            None => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .px_8()
                .bg(cx.theme().colors().editor_background)
                .child(
                    Icon::new(IconName::ThreadsSidebarRightOpen)
                        .size(IconSize::XLarge)
                        .color(Color::Muted),
                )
                .child(
                    Label::new("Select an agent to continue its chat.")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .into_any_element(),
        }
    }

    fn render_selected_agent_header(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let working_directory_icon = if summary.working_directory_is_worktree {
            IconName::GitWorktree
        } else {
            IconName::Folder
        };
        let working_directory_tooltip = summary.working_directory_path.clone();

        h_flex()
            .min_h(rems_from_px(62.))
            .px_3()
            .py_2()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .min_w_0()
                    .gap_2()
                    .child(self.render_status_dot(summary.status, cx))
                    .child(
                        v_flex()
                            .min_w_0()
                            .gap_0()
                            .child(
                                Label::new(summary.title.clone())
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new(summary.command.clone())
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .when_some(summary.working_directory_label.clone(), |this, label| {
                                let tooltip = working_directory_tooltip
                                    .clone()
                                    .unwrap_or_else(|| label.clone());
                                this.child(
                                    h_flex()
                                        .id(format!("selected-agent-directory-{thread_key}"))
                                        .gap_1()
                                        .min_w_0()
                                        .tooltip(Tooltip::text(tooltip.to_string()))
                                        .child(
                                            Icon::new(working_directory_icon)
                                                .size(IconSize::XSmall)
                                                .color(Color::Muted),
                                        )
                                        .child(
                                            Label::new(label)
                                                .size(LabelSize::Small)
                                                .color(Color::Accent),
                                        ),
                                )
                            }),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .child(self.render_status_badge(summary.status, cx))
                    .when(summary.status == BackboardAgentRunStatus::Blocked, |this| {
                        this.child(
                            Button::new(format!("revise-selected-{thread_key}"), "Revise")
                                .start_icon(Icon::new(IconName::Pencil))
                                .style(ButtonStyle::Outlined)
                                .size(ButtonSize::Compact)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.revise_run(thread_id, window, cx);
                                })),
                        )
                    })
                    .when(summary.can_review, |this| {
                        this.child(
                            Button::new(format!("review-selected-{thread_key}"), "Review")
                                .start_icon(Icon::new(IconName::GitBranch))
                                .style(ButtonStyle::Outlined)
                                .size(ButtonSize::Compact)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.review_run(thread_id, window, cx);
                                })),
                        )
                    })
                    .when(summary.can_apply, |this| {
                        this.child(
                            Button::new(format!("apply-selected-{thread_key}"), "Apply")
                                .start_icon(Icon::new(IconName::Check))
                                .style(ButtonStyle::Tinted(TintColor::Accent))
                                .size(ButtonSize::Compact)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.apply_run(thread_id, cx);
                                })),
                        )
                    })
                    .when(summary.working_directory_is_worktree, |this| {
                        this.child(
                            IconButton::new(
                                format!("open-selected-worktree-{thread_key}"),
                                IconName::FolderOpen,
                            )
                            .icon_size(IconSize::Small)
                            .tooltip(Tooltip::text("Open agent worktree"))
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.open_worktree(thread_id, window, cx);
                                },
                            )),
                        )
                    })
                    .when(
                        matches!(
                            summary.status,
                            BackboardAgentRunStatus::Running | BackboardAgentRunStatus::Queued
                        ),
                        |this| {
                            this.child(
                                IconButton::new(
                                    format!("stop-selected-agent-{thread_key}"),
                                    IconName::Stop,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Stop agent"))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.stop_run(thread_id, cx);
                                    },
                                )),
                            )
                        },
                    )
                    .when(
                        matches!(
                            summary.status,
                            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled
                        ),
                        |this| {
                            this.child(
                                IconButton::new(
                                    format!("retry-selected-agent-{thread_key}"),
                                    IconName::Rerun,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Retry agent"))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.retry_run(thread_id, cx);
                                    },
                                )),
                            )
                        },
                    )
                    .when(
                        matches!(
                            summary.status,
                            BackboardAgentRunStatus::Done
                                | BackboardAgentRunStatus::Error
                                | BackboardAgentRunStatus::Canceled
                        ),
                        |this| {
                            this.child(
                                IconButton::new(
                                    format!("dismiss-selected-agent-{thread_key}"),
                                    IconName::Check,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Dismiss agent"))
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.dismiss_run(thread_id, window, cx);
                                    },
                                )),
                            )
                        },
                    ),
            )
    }

    fn render_detail_drawer(
        &self,
        summary: BackboardAgentRunSummary,
        conversation: Entity<ConversationView>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_key = summary.thread_id.to_key_string();

        v_flex()
            .id(format!("backboard-agent-detail-{thread_key}"))
            .w_full()
            .h_full()
            .flex_1()
            .min_h_0()
            .bg(cx.theme().colors().editor_background)
            .overflow_hidden()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(conversation),
            )
    }

    fn render_right_panel(
        &self,
        agent_panel: Option<Entity<AgentPanel>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .w(rems_from_px(480.))
            .min_w(rems_from_px(360.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(match agent_panel {
                Some(panel) => div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(panel)
                    .into_any_element(),
                None => v_flex()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .px_5()
                    .child(
                        div()
                            .size(rems_from_px(52.))
                            .rounded_lg()
                            .border_1()
                            .border_color(cx.theme().colors().border_variant)
                            .bg(cx.theme().colors().element_background)
                            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Vector::square(VectorName::ZedLogo, rems_from_px(28.))
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        Label::new("Open a chat to start Agent Workspace.")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Button::new("empty-new-agent-chat", "New Chat")
                            .start_icon(Icon::new(IconName::Plus))
                            .style(ButtonStyle::Tinted(TintColor::Accent))
                            .size(ButtonSize::Compact)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.create_chat(window, cx);
                            })),
                    )
                    .into_any_element(),
            })
    }

    fn render_chat_panel_frame(
        &self,
        content: AnyElement,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .w(rems_from_px(480.))
            .min_w(rems_from_px(360.))
            .h_full()
            .flex_shrink_0()
            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
            .child(content)
    }
}

impl Render for BackboardAgentWorkspacePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let summaries = self.summaries(cx);
        let api_key_ready = Self::has_backboard_api_key();
        let selected_summary = self.selected_thread_id.and_then(|thread_id| {
            summaries
                .iter()
                .find(|summary| summary.thread_id == thread_id)
                .cloned()
        });
        if self.selected_thread_id.is_some() && selected_summary.is_none() {
            self.selected_thread_id = None;
        }

        if !api_key_ready {
            return v_flex()
                .size_full()
                .bg(cx.theme().colors().editor_background)
                .key_context("BackboardAgentWorkspace")
                .child(self.render_header(&summaries, false, cx))
                .child(self.render_api_unavailable_workspace(cx));
        }

        let agent_panel = self.ensure_agent_panel(window, cx);
        let draft_drawer_open = self.draft_drawer_open
            && selected_summary.is_none()
            && agent_panel.as_ref().is_some_and(|panel| {
                panel
                    .read(cx)
                    .active_backboard_workspace_draft_thread_id(cx)
                    .is_some()
            });
        if self.draft_drawer_open && !draft_drawer_open && selected_summary.is_none() {
            self.draft_drawer_open = false;
        }
        let selected_conversation = selected_summary
            .as_ref()
            .and_then(|summary| self.conversation_for_thread(summary.thread_id, cx));
        let right_panel_open = selected_summary.is_some() || draft_drawer_open;
        let colors = cx.theme().colors();
        let workspace_background = colors.editor_background;
        let workspace_body_background = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.42));
        let workspace_body_panel_background = colors
            .element_background
            .blend(colors.panel_background.opacity(0.34));
        let workspace_body_border = colors.border_variant.opacity(0.5);

        v_flex()
            .size_full()
            .bg(workspace_background)
            .key_context("BackboardAgentWorkspace")
            .on_action(cx.listener(|this, _: &Chat, window, cx| {
                this.submit_chat_action(window, cx);
            }))
            .child(self.render_header(&summaries, right_panel_open, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .p_1()
                    .overflow_hidden()
                    .bg(workspace_body_background)
                    .child(
                        h_flex()
                            .size_full()
                            .rounded_xl()
                            .border_1()
                            .border_color(workspace_body_border)
                            .overflow_hidden()
                            .bg(workspace_body_panel_background)
                            .child(
                                div().flex_1().min_w_0().h_full().overflow_hidden().child(
                                    self.render_dashboard(
                                        summaries.clone(),
                                        right_panel_open,
                                        window,
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            )
                            .when(right_panel_open, |this| {
                                if let Some(summary) = selected_summary.clone()
                                    && let Some(conversation) = selected_conversation.clone()
                                {
                                    this.child(
                                        self.render_chat_panel_frame(
                                            self.render_detail_drawer(summary, conversation, cx)
                                                .into_any_element(),
                                            cx,
                                        ),
                                    )
                                } else {
                                    this.child(
                                        self.render_chat_panel_frame(
                                            self.render_right_panel(
                                                agent_panel.clone(),
                                                window,
                                                cx,
                                            )
                                            .into_any_element(),
                                            cx,
                                        ),
                                    )
                                }
                            }),
                    ),
            )
    }
}

impl Focusable for BackboardAgentWorkspacePage {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_panel::{
        BackboardAgentWorkspaceKind, BackboardAgentWorkspaceMode, BackboardAgentWorkspaceScope,
    };
    use crate::conversation_view::tests::init_test;
    use fs::FakeFs;
    use gpui::{TestAppContext, VisualTestContext};
    use project::Project;
    use serde_json::json;
    use std::path::Path;
    use workspace::MultiWorkspace;

    fn test_summary() -> BackboardAgentRunSummary {
        BackboardAgentRunSummary {
            thread_id: ThreadId::new(),
            title: "A long task title that should wrap cleanly".into(),
            command: "Run a real workspace task".into(),
            status: BackboardAgentRunStatus::Done,
            blocked_reason: None,
            kind_label: None,
            scope_label: None,
            worktree_label: None,
            working_directory_label: None,
            working_directory_path: None,
            working_directory_is_worktree: false,
            branch_label: None,
            apply_state_label: None,
            can_apply: false,
            can_review: false,
            progress: 100,
            cost: None,
            token_usage: None,
            speed_metrics: None,
            files_changed: 0,
            latest_events: Vec::new(),
            touched_paths: Vec::new(),
            conflicting_paths: Vec::new(),
            batch_id: None,
            batch_index: 0,
            batch_size: 1,
            is_active_thread: false,
        }
    }

    #[test]
    fn test_workspace_context_lines_omit_missing_metric_placeholders() {
        let summary = test_summary();
        let lines = BackboardAgentWorkspacePage::token_context_lines(&summary);

        assert!(lines.is_empty());
    }

    #[test]
    fn test_workspace_context_lines_render_real_metrics() {
        let mut summary = test_summary();
        summary.cost = Some("$0.0042".into());
        summary.token_usage = Some(acp_thread::TokenUsage {
            used_tokens: 1234,
            max_tokens: 8000,
            input_tokens: 1000,
            output_tokens: 234,
            max_output_tokens: Some(2000),
            remaining_tokens: Some(6766),
            summary_tokens: Some(0),
            context_percent: Some(15),
            context_model: Some("backboard/backboard-test-model".into()),
        });
        summary.speed_metrics = Some(acp_thread::SpeedMetrics {
            first_token_ms: Some(321.0),
            total_turn_ms: Some(2450.0),
            context_pack_ms: Some(40.0),
            model: Some("backboard-test-model".into()),
            provider: Some("backboard".into()),
            tool_calls_count: Some(3),
            ..Default::default()
        });

        let lines = BackboardAgentWorkspacePage::token_context_lines(&summary);
        let text = lines.join("\n");

        assert!(text.contains("1.2k / 8k tokens"));
        assert!(text.contains("input / output: 1k / 234"));
        assert!(text.contains("cost: $0.0042"));
        assert!(text.contains("first token: 321ms"));
        assert!(text.contains("total turn: 2.5s"));
        assert!(text.contains("context pack: 40ms"));
        assert!(text.contains("model: backboard-test-model"));
        assert!(text.contains("provider: backboard"));
        assert!(text.contains("tool calls: 3"));
        assert!(!text.contains("..."));
        assert!(!text.contains("--"));
        assert!(!text.contains("not available"));
    }

    async fn setup_workspace_page(
        cx: &mut TestAppContext,
        with_git: bool,
    ) -> (
        Entity<Workspace>,
        Entity<AgentPanel>,
        Entity<BackboardAgentWorkspacePage>,
        VisualTestContext,
    ) {
        init_test(cx);
        cx.update(|cx| {
            agent::ThreadStore::init_global(cx);
            language_model::LanguageModelRegistry::test(cx);
        });

        let fs = FakeFs::new(cx.executor());
        cx.update(|cx| <dyn fs::Fs>::set_global(fs.clone(), cx));

        let project = if with_git {
            fs.insert_tree(
                "/project",
                json!({
                    ".git": {},
                    "src": { "main.rs": "fn main() {}" }
                }),
            )
            .await;
            Project::test(fs.clone(), [Path::new("/project")], cx).await
        } else {
            Project::test(fs.clone(), [], cx).await
        };
        cx.executor().run_until_parked();

        let multi_workspace =
            cx.add_window(|window, cx| MultiWorkspace::test_new(project.clone(), window, cx));
        let _ = multi_workspace.update(cx, |multi_workspace, _window, cx| {
            multi_workspace.set_multi_agent_expanded(true, cx);
        });
        let workspace = multi_workspace
            .read_with(cx, |multi_workspace, _cx| {
                multi_workspace.workspace().clone()
            })
            .unwrap();
        let mut cx = VisualTestContext::from_window(multi_workspace.into(), cx);

        let panel = workspace.update_in(&mut cx, |workspace, window, cx| {
            let panel = cx.new(|cx| AgentPanel::new(workspace, None, window, cx));
            workspace.add_panel(panel.clone(), window, cx);
            panel
        });
        let page = workspace.update_in(&mut cx, |workspace, window, cx| {
            BackboardAgentWorkspacePage::new(workspace, window, cx)
        });

        (workspace, panel, page, cx)
    }

    #[gpui::test]
    async fn test_workspace_agent_page_new_chat_focuses_draft_in_right_panel(
        cx: &mut TestAppContext,
    ) {
        let (workspace, panel, page, mut cx) = setup_workspace_page(cx, true).await;

        page.update_in(&mut cx, |page, window, cx| {
            page.create_chat(window, cx);
        });

        page.read_with(&cx, |page, _cx| {
            assert!(
                page.selected_thread_id.is_none(),
                "draft-only workspace chat should not select a run card"
            );
            assert!(
                page.draft_drawer_open,
                "New Agent should open the right-panel composer"
            );
        });
        workspace.read_with(&cx, |workspace, cx| {
            assert!(
                !workspace
                    .dock_at_position(DockPosition::Right)
                    .read(cx)
                    .is_open(),
                "New Agent should not open the docked right panel"
            );
        });

        panel.read_with(&cx, |panel, cx| {
            let draft_thread_id = panel
                .active_backboard_workspace_draft_thread_id(cx)
                .expect("New Chat should focus a Backboard workspace draft");
            assert!(!panel.is_retained_thread(&draft_thread_id));
            assert!(panel.backboard_agent_run_summaries(cx).is_empty());
        });

        page.update(&mut cx, |page, cx| {
            page.close_detail(cx);
        });
        page.read_with(&cx, |page, _cx| {
            assert!(
                !page.draft_drawer_open,
                "closing detail should hide the right-panel composer"
            );
            assert!(page.selected_thread_id.is_none());
        });
    }

    #[gpui::test]
    async fn test_workspace_agent_page_new_chat_creates_missing_panel_after_folder_open(
        cx: &mut TestAppContext,
    ) {
        init_test(cx);
        cx.update(|cx| {
            agent::ThreadStore::init_global(cx);
            language_model::LanguageModelRegistry::test(cx);
        });

        let fs = FakeFs::new(cx.executor());
        cx.update(|cx| <dyn fs::Fs>::set_global(fs.clone(), cx));
        fs.insert_tree(
            "/project",
            json!({
                ".git": {},
                "src": { "main.rs": "fn main() {}" }
            }),
        )
        .await;
        let project = Project::test(fs.clone(), [Path::new("/project")], cx).await;
        cx.executor().run_until_parked();

        let multi_workspace =
            cx.add_window(|window, cx| MultiWorkspace::test_new(project.clone(), window, cx));
        let _ = multi_workspace.update(cx, |multi_workspace, _window, cx| {
            multi_workspace.set_multi_agent_expanded(true, cx);
        });
        let workspace = multi_workspace
            .read_with(cx, |multi_workspace, _cx| {
                multi_workspace.workspace().clone()
            })
            .unwrap();
        let mut cx = VisualTestContext::from_window(multi_workspace.into(), cx);

        let page = workspace.update_in(&mut cx, |workspace, window, cx| {
            BackboardAgentWorkspacePage::new(workspace, window, cx)
        });
        assert!(
            workspace.read_with(&cx, |workspace, cx| {
                workspace.panel::<AgentPanel>(cx).is_none()
            }),
            "the regression setup should open the workspace page before AgentPanel exists"
        );

        page.update_in(&mut cx, |page, window, cx| {
            page.create_chat(window, cx);
        });

        page.read_with(&cx, |page, _cx| {
            assert!(page.observing_agent_panel);
            assert!(
                page.selected_thread_id.is_none(),
                "new chat should be a draft, not a selected run"
            );
            assert!(
                page.draft_drawer_open,
                "new chat should use the right-panel composer"
            );
        });
        workspace.read_with(&cx, |workspace, cx| {
            assert!(
                !workspace
                    .dock_at_position(DockPosition::Right)
                    .read(cx)
                    .is_open(),
                "new chat should not open the docked right panel"
            );
        });
        let panel = workspace.read_with(&cx, |workspace, cx| {
            workspace
                .panel::<AgentPanel>(cx)
                .expect("New Chat should lazily attach AgentPanel")
        });

        panel.read_with(&cx, |panel, cx| {
            let draft_thread_id = panel
                .active_backboard_workspace_draft_thread_id(cx)
                .expect("New Chat should lazily attach AgentPanel and focus a draft");
            assert!(!panel.is_retained_thread(&draft_thread_id));
            assert!(panel.backboard_agent_run_summaries(cx).is_empty());
        });
    }

    #[gpui::test]
    async fn test_workspace_agent_page_first_draft_send_promotes_and_opens_next_draft(
        cx: &mut TestAppContext,
    ) {
        let (_workspace, panel, page, mut cx) = setup_workspace_page(cx, false).await;

        page.update_in(&mut cx, |page, window, cx| {
            page.create_chat(window, cx);
        });

        let sent_thread_id = panel.read_with(&cx, |panel, cx| {
            panel
                .active_backboard_workspace_draft_thread_id(cx)
                .expect("New Chat should focus a draft")
        });
        panel.update(&mut cx, |panel, cx| {
            assert_eq!(
                panel.promote_active_backboard_workspace_draft(
                    "build the dashboard".to_string(),
                    BackboardAgentWorkspaceScope::WholeProject,
                    BackboardAgentWorkspaceKind::Build,
                    BackboardAgentWorkspaceMode::Free,
                    cx,
                ),
                Some(sent_thread_id)
            );
        });
        panel.update_in(&mut cx, |panel, window, cx| {
            panel.create_backboard_workspace_chat(window, cx);
        });

        page.read_with(&cx, |page, _cx| {
            assert!(
                page.selected_thread_id.is_none(),
                "auto-promoted run should not steal focus from the fresh draft"
            );
        });
        panel.read_with(&cx, |panel, cx| {
            assert!(panel.is_retained_thread(&sent_thread_id));
            let next_draft_id = panel
                .active_backboard_workspace_draft_thread_id(cx)
                .expect("first send should open a fresh workspace draft");
            assert_ne!(next_draft_id, sent_thread_id);

            let summaries = panel.backboard_agent_run_summaries(cx);
            assert_eq!(summaries.len(), 1);
            assert_eq!(summaries[0].thread_id, sent_thread_id);
            assert_eq!(summaries[0].command.as_ref(), "build the dashboard");
        });

        page.update_in(&mut cx, |page, window, cx| {
            page.open_run(sent_thread_id, window, cx);
        });
        page.read_with(&cx, |page, cx| {
            assert_eq!(page.selected_thread_id, Some(sent_thread_id));
            assert!(
                !page.draft_drawer_open,
                "opening a tile should switch from draft drawer to run chat drawer"
            );
            assert!(
                page.conversation_for_thread(sent_thread_id, cx).is_some(),
                "opening a tile should expose the selected run chat"
            );
        });
    }
}
