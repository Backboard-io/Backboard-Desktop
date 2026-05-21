use collections::HashSet;
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement,
    ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement, Styled,
    Subscription, WeakEntity, Window, prelude::*,
};
use ui::{
    Button, ButtonSize, ButtonStyle, ElevationIndex, Icon, IconButton, IconSize, Label, LabelSize,
    TintColor, Tooltip, Vector, VectorName, WithScrollbar, prelude::*,
};
use workspace::Workspace;

use crate::ConversationView;
use crate::agent_panel::{
    AgentPanel, AgentPanelEvent, BackboardAgentRunEventState, BackboardAgentRunStatus,
    BackboardAgentRunSummary,
};
use crate::thread_metadata_store::ThreadId;
use zed_actions::agent::Chat;

pub struct BackboardAgentWorkspacePage {
    workspace: WeakEntity<Workspace>,
    focus_handle: FocusHandle,
    selected_thread_id: Option<ThreadId>,
    dashboard_scroll_handle: ScrollHandle,
    dismissed_threads: HashSet<ThreadId>,
    show_token_context: bool,
    observing_agent_panel: bool,
    _subscriptions: Vec<Subscription>,
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

            Self {
                workspace,
                focus_handle: cx.focus_handle(),
                selected_thread_id: None,
                dashboard_scroll_handle: ScrollHandle::new(),
                dismissed_threads: HashSet::default(),
                show_token_context: false,
                observing_agent_panel,
                _subscriptions: subscriptions,
            }
        })
    }

    fn handle_agent_panel_event(
        &mut self,
        _: &Entity<AgentPanel>,
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
                    self.focus_selected_conversation(window, cx);
                }
                cx.notify();
            }
            AgentPanelEvent::BackboardWorkspaceLaunchFailed { .. } => {}
            AgentPanelEvent::ActiveViewChanged
            | AgentPanelEvent::ActiveViewFocused
            | AgentPanelEvent::EntryChanged
            | AgentPanelEvent::ThreadInteracted { .. } => {}
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

    fn create_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.ensure_agent_panel(window, cx) {
            panel.update(cx, |panel, cx| {
                panel.create_backboard_workspace_chat(window, cx);
            });
        }
        self.selected_thread_id = None;
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
        self.selected_thread_id = None;
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
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let running = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Running)
            .count();
        let done = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Done)
            .count();
        let blocked = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Blocked)
            .count();
        let ready = summaries.iter().filter(|summary| summary.can_apply).count();
        let colors = cx.theme().colors();
        let header_background = colors
            .tab_bar_background
            .blend(colors.panel_background.opacity(0.32));

        h_flex()
            .h(rems_from_px(40.))
            .px_3()
            .gap_3()
            .justify_between()
            .border_b_1()
            .border_color(colors.border_variant.opacity(0.58))
            .bg(header_background)
            .child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(
                                Vector::square(VectorName::ZedLogo, rems_from_px(14.))
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new("Agent Workspace")
                                    .size(LabelSize::Small)
                                    .weight(FontWeight::BOLD)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new("Parallel chats")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(self.render_header_stat(
                                summaries.len().to_string(),
                                "of 20",
                                Color::Muted,
                            ))
                            .child(self.render_header_stat(
                                running.to_string(),
                                "running",
                                Color::Accent,
                            ))
                            .child(self.render_header_stat(
                                done.to_string(),
                                "done",
                                if done > 0 {
                                    Color::Success
                                } else {
                                    Color::Muted
                                },
                            ))
                            .child(self.render_header_stat(
                                ready.to_string(),
                                "ready",
                                if ready > 0 {
                                    Color::Success
                                } else {
                                    Color::Muted
                                },
                            ))
                            .child(self.render_header_stat(
                                blocked.to_string(),
                                "blocked",
                                if blocked > 0 {
                                    Color::Warning
                                } else {
                                    Color::Muted
                                },
                            ))
                            .child(
                                Button::new(
                                    "toggle-token-context-cards",
                                    if self.show_token_context {
                                        "Hide context"
                                    } else {
                                        "Show context"
                                    },
                                )
                                .size(ButtonSize::Compact)
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_token_context = !this.show_token_context;
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                Button::new("new-agent-chat", "New Chat")
                    .start_icon(Icon::new(IconName::Plus))
                    .style(ButtonStyle::Subtle)
                    .size(ButtonSize::Compact)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.create_chat(window, cx);
                    })),
            )
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
        &self,
        summaries: Vec<BackboardAgentRunSummary>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if summaries.is_empty() {
            return v_flex()
                .size_full()
                .id("backboard-agent-workspace-empty")
                .overflow_hidden()
                .gap_3()
                .p_4()
                .child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .pb(rems_from_px(96.))
                        .child(
                            div()
                                .size(rems_from_px(56.))
                                .rounded_lg()
                                .border_1()
                                .border_color(cx.theme().colors().border_variant)
                                .bg(cx.theme().colors().element_background)
                                .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    Vector::square(VectorName::ZedLogo, rems_from_px(30.))
                                        .color(Color::Accent),
                                ),
                        )
                        .child(
                            Headline::new("No active Backboard agents")
                                .size(HeadlineSize::XSmall)
                                .color(Color::Accent),
                        )
                        .child(
                            Label::new("Use New Chat to start a shared-workspace coding chat.")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                )
                .into_any_element();
        }

        let blocked_summaries = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Blocked)
            .cloned()
            .collect::<Vec<_>>();
        let mut summary_groups = Vec::<(Option<String>, Vec<BackboardAgentRunSummary>)>::new();
        for summary in summaries.iter().cloned() {
            let key = summary
                .batch_id
                .as_ref()
                .filter(|_| summary.batch_size > 1)
                .map(|batch_id| batch_id.as_ref().to_string());
            if let Some((_, group_summaries)) = summary_groups
                .iter_mut()
                .find(|(existing_key, _)| *existing_key == key)
            {
                group_summaries.push(summary);
            } else {
                summary_groups.push((key, vec![summary]));
            }
        }
        let group_elements = summary_groups
            .into_iter()
            .map(|(batch_id, summaries)| match batch_id {
                Some(batch_id) if summaries.len() > 1 => {
                    self.render_batch_group(batch_id, summaries, cx)
                }
                _ => h_flex()
                    .items_start()
                    .flex_wrap()
                    .gap_2()
                    .children(
                        summaries
                            .into_iter()
                            .map(|summary| self.render_agent_card(summary, cx).into_any_element()),
                    )
                    .into_any_element(),
            })
            .collect::<Vec<_>>();

        v_flex()
            .size_full()
            .id("backboard-agent-workspace-scroll")
            .track_scroll(&self.dashboard_scroll_handle)
            .overflow_y_scroll()
            .pb_4()
            .when(!blocked_summaries.is_empty(), |this| {
                this.child(self.render_blocked_overview(blocked_summaries, cx))
            })
            .child(v_flex().gap_3().p_4().children(group_elements))
            .vertical_scrollbar_for(&self.dashboard_scroll_handle, window, cx)
            .into_any_element()
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
        let color = match status {
            BackboardAgentRunStatus::Done => cx.theme().status().success,
            BackboardAgentRunStatus::Blocked => cx.theme().status().warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => {
                cx.theme().status().error
            }
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => {
                cx.theme().colors().text_accent
            }
        };

        div().size(px(7.)).rounded_full().bg(color)
    }

    fn render_status_badge(
        &self,
        status: BackboardAgentRunStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (color, border, background) = match status {
            BackboardAgentRunStatus::Done => (
                Color::Success,
                cx.theme().status().success_border.opacity(0.72),
                cx.theme().status().success_background.opacity(0.16),
            ),
            BackboardAgentRunStatus::Blocked => (
                Color::Warning,
                cx.theme().status().warning_border.opacity(0.72),
                cx.theme().status().warning_background.opacity(0.16),
            ),
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => (
                Color::Error,
                cx.theme().status().error_border.opacity(0.72),
                cx.theme().status().error_background.opacity(0.13),
            ),
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => (
                Color::Accent,
                cx.theme().colors().text_accent.opacity(0.45),
                cx.theme().colors().element_active.opacity(0.24),
            ),
        };

        div()
            .h(rems_from_px(22.))
            .px_2()
            .rounded_full()
            .border_1()
            .border_color(border)
            .bg(background)
            .flex()
            .items_center()
            .child(
                Label::new(status.label())
                    .size(LabelSize::Small)
                    .weight(FontWeight::MEDIUM)
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
            .flex_1()
            .min_h_0()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
            .overflow_hidden()
            .child(
                h_flex()
                    .min_h(rems_from_px(62.))
                    .px_3()
                    .py_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .bg(cx.theme().colors().elevated_surface_background)
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .size(rems_from_px(30.))
                                    .rounded_md()
                                    .border_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .bg(cx.theme().colors().element_background)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        Vector::square(VectorName::ZedLogo, rems_from_px(16.))
                                            .color(Self::status_label_color(summary.status)),
                                    ),
                            )
                            .child(self.render_status_dot(summary.status, cx))
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .gap_0()
                                    .child(
                                        Label::new(summary.title.clone())
                                            .size(LabelSize::Small)
                                            .weight(FontWeight::MEDIUM)
                                            .color(Color::Default),
                                    )
                                    .child(
                                        Label::new(summary.status.label())
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    ),
                            ),
                    )
                    .child(
                        IconButton::new(
                            format!("close-agent-detail-{thread_key}"),
                            IconName::Close,
                        )
                        .icon_size(IconSize::Small)
                        .tooltip(Tooltip::text("Close detail"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.close_detail(cx);
                        })),
                    ),
            )
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
            .w(rems_from_px(560.))
            .min_w(rems_from_px(420.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(match agent_panel {
                Some(panel) => div()
                    .size_full()
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
}

impl Render for BackboardAgentWorkspacePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let summaries = self.summaries(cx);
        let selected_detail_exists = self.selected_thread_id.and_then(|thread_id| {
            summaries
                .iter()
                .find(|summary| summary.thread_id == thread_id)?;
            self.conversation_for_thread(thread_id, cx)?;
            Some(())
        });
        if self.selected_thread_id.is_some() && selected_detail_exists.is_none() {
            self.selected_thread_id = None;
        }
        let agent_panel = self.ensure_agent_panel(window, cx);
        let colors = cx.theme().colors();
        let workspace_background = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.42));

        v_flex()
            .size_full()
            .bg(workspace_background)
            .key_context("BackboardAgentWorkspace")
            .on_action(cx.listener(|this, _: &Chat, window, cx| {
                this.submit_chat_action(window, cx);
            }))
            .child(self.render_header(&summaries, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(workspace_background)
                    .child(
                        div().flex_1().min_w_0().h_full().overflow_hidden().child(
                            self.render_dashboard(summaries.clone(), window, cx)
                                .into_any_element(),
                        ),
                    )
                    .child(self.render_right_panel(agent_panel, window, cx)),
            )
            .child(self.render_bottom_bar(&summaries, cx))
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
    async fn test_workspace_agent_page_new_chat_focuses_draft_without_card(
        cx: &mut TestAppContext,
    ) {
        let (_workspace, panel, page, mut cx) = setup_workspace_page(cx, true).await;

        page.update_in(&mut cx, |page, window, cx| {
            page.create_chat(window, cx);
        });

        page.read_with(&cx, |page, _cx| {
            assert!(
                page.selected_thread_id.is_none(),
                "draft-only workspace chat should not select a run card"
            );
        });

        panel.read_with(&cx, |panel, cx| {
            let draft_thread_id = panel
                .active_backboard_workspace_draft_thread_id(cx)
                .expect("New Chat should focus a Backboard workspace draft");
            assert!(!panel.is_retained_thread(&draft_thread_id));
            assert!(panel.backboard_agent_run_summaries(cx).is_empty());
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
    }
}
