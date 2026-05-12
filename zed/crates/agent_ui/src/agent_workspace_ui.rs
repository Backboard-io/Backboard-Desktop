use collections::HashSet;
use editor::{Editor, EditorElement, EditorEvent, EditorStyle};
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Subscription, TextStyle, WeakEntity, Window,
    prelude::*,
};
use settings::Settings;
use theme_settings::ThemeSettings;
use ui::{
    Button, ButtonSize, ButtonStyle, Divider, Icon, IconButton, IconSize, Label, LabelSize,
    TintColor, Tooltip, prelude::*,
};
use workspace::{
    Workspace,
    item::{Item, ItemEvent},
};

use crate::agent_panel::{
    AgentPanel, BackboardAgentRunEventState, BackboardAgentRunStatus, BackboardAgentRunSummary,
    BackboardAgentWorkspaceKind, BackboardAgentWorkspaceScope,
};
use crate::thread_metadata_store::ThreadId;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkspacePageMode {
    Dashboard,
    Configure,
}

pub struct BackboardAgentWorkspacePage {
    workspace: WeakEntity<Workspace>,
    task_editor: Entity<Editor>,
    mode: WorkspacePageMode,
    selected_scope: BackboardAgentWorkspaceScope,
    selected_kind: BackboardAgentWorkspaceKind,
    dismissed_threads: HashSet<ThreadId>,
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
            let task_editor = cx.new(|cx| {
                let mut editor = Editor::single_line(window, cx);
                editor.set_placeholder_text("Describe the task...", window, cx);
                editor
            });

            cx.subscribe(&task_editor, Self::handle_task_editor_event)
                .detach();

            let mut subscriptions = Vec::new();
            if let Some(panel) = panel {
                subscriptions.push(cx.observe(&panel, |_, _, cx| cx.notify()));
            }

            Self {
                workspace,
                task_editor,
                mode: WorkspacePageMode::Dashboard,
                selected_scope: BackboardAgentWorkspaceScope::WholeProject,
                selected_kind: BackboardAgentWorkspaceKind::Build,
                dismissed_threads: HashSet::default(),
                _subscriptions: subscriptions,
            }
        })
    }

    fn handle_task_editor_event(
        &mut self,
        _: Entity<Editor>,
        _: &EditorEvent,
        cx: &mut Context<Self>,
    ) {
        cx.notify();
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

    fn show_dashboard(&mut self, cx: &mut Context<Self>) {
        self.mode = WorkspacePageMode::Dashboard;
        cx.notify();
    }

    fn show_configure(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.mode = WorkspacePageMode::Configure;
        self.task_editor.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn run_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let task = self.task_editor.read(cx).text(cx).trim().to_string();
        if task.is_empty() {
            return;
        }

        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.spawn_backboard_workspace_agent(
                            task,
                            self.selected_scope,
                            self.selected_kind,
                            window,
                            cx,
                        );
                    });
                }
            });
        }

        self.task_editor
            .update(cx, |editor, cx| editor.set_text("", window, cx));
        self.mode = WorkspacePageMode::Dashboard;
        cx.notify();
    }

    fn open_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.activate_backboard_workspace_agent(thread_id, window, cx);
                    });
                    workspace.focus_panel::<AgentPanel>(window, cx);
                }
            });
        }
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

    fn revise_run(
        &mut self,
        title: SharedString,
        blocked_reason: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut prompt = format!(
            "Continue the blocked Backboard agent `{}`. Diagnose what is stuck, adjust the approach, and keep going.",
            title.as_ref()
        );
        if let Some(reason) = blocked_reason {
            prompt.push_str(&format!(" Blocked reason: {}.", reason.as_ref()));
        }
        self.task_editor
            .update(cx, |editor, cx| editor.set_text(prompt, window, cx));
        self.show_configure(window, cx);
    }

    fn dismiss_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        self.dismissed_threads.insert(thread_id);
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

    fn render_text_input(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = ThemeSettings::get_global(cx);
        let text_style = TextStyle {
            color: cx.theme().colors().text,
            font_family: settings.ui_font.family.clone(),
            font_features: settings.ui_font.features.clone(),
            font_fallbacks: settings.ui_font.fallbacks.clone(),
            font_size: rems(0.9).into(),
            font_weight: settings.ui_font.weight,
            line_height: relative(1.35),
            ..Default::default()
        };

        EditorElement::new(
            &self.task_editor,
            EditorStyle {
                background: cx.theme().colors().editor_background,
                local_player: cx.theme().players().local(),
                text: text_style,
                ..Default::default()
            },
        )
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

        h_flex()
            .h(rems_from_px(64.))
            .px_5()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(
                        Icon::new(IconName::Sparkle)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(Label::new("Agent Workspace").size(LabelSize::Large))
                            .child(
                                Label::new("Parallel Backboard sessions streaming in this project")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(self.render_counter_pill(
                                format!("{running} running"),
                                Color::Muted,
                                cx,
                            ))
                            .child(self.render_counter_pill(
                                format!("{done} done"),
                                Color::Success,
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
                            )),
                    ),
            )
            .child(
                Button::new("new-agent", "New agent")
                    .start_icon(Icon::new(IconName::Plus))
                    .style(ButtonStyle::Outlined)
                    .size(ButtonSize::Medium)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_configure(window, cx);
                    })),
            )
    }

    fn render_counter_pill(
        &self,
        label: String,
        color: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().element_background)
            .child(Label::new(label).size(LabelSize::Small).color(color))
    }

    fn render_dashboard(
        &self,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if summaries.is_empty() {
            return v_flex()
                .size_full()
                .id("backboard-agent-workspace-empty")
                .overflow_y_scroll()
                .items_center()
                .justify_center()
                .gap_4()
                .pb(rems_from_px(120.))
                .child(
                    Icon::new(IconName::Sparkle)
                        .size(IconSize::XLarge)
                        .color(Color::Muted),
                )
                .child(Headline::new("No active Backboard agents").size(HeadlineSize::Small))
                .child(
                    Label::new("Create an agent to stream parallel work here.")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .child(
                    Button::new("new-agent-empty", "New agent")
                        .start_icon(Icon::new(IconName::Plus))
                        .style(ButtonStyle::Tinted(TintColor::Accent))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_configure(window, cx);
                        })),
                )
                .into_any_element();
        }

        let blocked_summaries = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Blocked)
            .cloned()
            .collect::<Vec<_>>();
        let mut agent_cards = Vec::with_capacity(summaries.len());
        for summary in summaries {
            agent_cards.push(self.render_agent_card(summary, cx).into_any_element());
        }

        v_flex()
            .size_full()
            .id("backboard-agent-workspace-scroll")
            .overflow_y_scroll()
            .pb(rems_from_px(120.))
            .when(!blocked_summaries.is_empty(), |this| {
                this.child(self.render_blocked_overview(blocked_summaries, cx))
            })
            .child(
                h_flex()
                    .items_start()
                    .flex_wrap()
                    .gap_3()
                    .p_5()
                    .children(agent_cards),
            )
            .into_any_element()
    }

    fn render_blocked_overview(
        &self,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let count = summaries.len();
        let mut rows = Vec::new();
        for summary in summaries.into_iter().take(3) {
            let thread_id = summary.thread_id;
            let title = summary.title.clone();
            let reason = summary.blocked_reason.clone();
            rows.push(
                h_flex()
                    .gap_2()
                    .justify_between()
                    .rounded_sm()
                    .border_1()
                    .border_color(cx.theme().status().warning_border.opacity(0.6))
                    .bg(cx.theme().status().warning_background.opacity(0.06))
                    .px_3()
                    .py_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Icon::new(IconName::Warning)
                                    .size(IconSize::Small)
                                    .color(Color::Warning),
                            )
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(Label::new(title.clone()).size(LabelSize::Default))
                                    .child(
                                        Label::new(
                                            reason
                                                .clone()
                                                .unwrap_or_else(|| "Needs attention".into()),
                                        )
                                        .size(LabelSize::Small)
                                        .color(Color::Warning),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                Button::new(format!("revise-blocked-{thread_id:?}"), "Revise")
                                    .start_icon(Icon::new(IconName::Pencil))
                                    .style(ButtonStyle::Outlined)
                                    .size(ButtonSize::Compact)
                                    .on_click(cx.listener({
                                        let title = title.clone();
                                        let reason = reason.clone();
                                        move |this, _, window, cx| {
                                            this.revise_run(
                                                title.clone(),
                                                reason.clone(),
                                                window,
                                                cx,
                                            );
                                        }
                                    })),
                            )
                            .child(
                                IconButton::new(
                                    format!("open-blocked-{thread_id:?}"),
                                    IconName::ArrowUpRight,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Open blocked chat"))
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.open_run(thread_id, window, cx);
                                    },
                                )),
                            ),
                    )
                    .into_any_element(),
            );
        }

        v_flex()
            .mx_5()
            .mt_4()
            .gap_2()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().status().warning_border.opacity(0.65))
            .bg(cx.theme().status().warning_background.opacity(0.08))
            .p_3()
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Icon::new(IconName::Warning)
                                    .size(IconSize::Small)
                                    .color(Color::Warning),
                            )
                            .child(
                                Label::new(format!(
                                    "{count} blocked agent{suffix}",
                                    suffix = if count == 1 { "" } else { "s" }
                                ))
                                .color(Color::Warning),
                            ),
                    )
                    .child(
                        Label::new("Open detail or revise the prompt to unblock work")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .children(rows)
    }

    fn render_agent_card(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let event_rows = summary
            .latest_events
            .iter()
            .take(5)
            .map(|event| Self::render_event_row(event.text.clone(), event.state))
            .collect::<Vec<_>>();
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
        let card_label = match summary.status {
            BackboardAgentRunStatus::Blocked => "Needs input",
            BackboardAgentRunStatus::Error => "Broken",
            BackboardAgentRunStatus::Canceled => "Stopped",
            BackboardAgentRunStatus::Done => "Finished",
            BackboardAgentRunStatus::Queued => "Queued",
            BackboardAgentRunStatus::Running => "Streaming",
        };

        v_flex()
            .id(format!("backboard-agent-card-{thread_key}"))
            .min_w(rems_from_px(320.))
            .max_w(rems_from_px(480.))
            .h(rems_from_px(310.))
            .flex_1()
            .rounded_md()
            .border_1()
            .border_color(border_color)
            .bg(background)
            .overflow_hidden()
            .cursor_pointer()
            .hover(|style| style.border_color(cx.theme().colors().border))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_run(thread_id, window, cx);
            }))
            .child(
                h_flex()
                    .h(rems_from_px(52.))
                    .px_3()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .gap_2()
                            .child(self.render_status_dot(summary.status, cx))
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(
                                        Label::new(summary.title.clone()).size(LabelSize::Default),
                                    )
                                    .child(
                                        Label::new(card_label)
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    )
                                    .when_some(summary.worktree_label.clone(), |this, label| {
                                        this.child(
                                            h_flex()
                                                .gap_1()
                                                .child(
                                                    Icon::new(IconName::GitWorktree)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Muted),
                                                )
                                                .child(
                                                    Label::new(label)
                                                        .size(LabelSize::Small)
                                                        .color(Color::Muted),
                                                ),
                                        )
                                    }),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
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
                    .gap_2()
                    .p_3()
                    .flex_1()
                    .child(
                        Label::new(summary.command.clone())
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .when(
                        summary.branch_label.is_some() || summary.apply_state_label.is_some(),
                        |this| {
                            this.child(
                                h_flex()
                                    .gap_2()
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
                                                        .color(Color::Muted),
                                                ),
                                        )
                                    })
                                    .when_some(summary.apply_state_label.clone(), |this, label| {
                                        this.child(
                                            Label::new(label)
                                                .size(LabelSize::Small)
                                                .color(Color::Muted),
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
                    })
                    .children(event_rows),
            )
            .child(
                v_flex()
                    .border_t_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .h(rems_from_px(40.))
                            .px_3()
                            .justify_between()
                            .child(h_flex().gap_2().children(summary.cost.clone().map(|cost| {
                                Label::new(format!("· {cost}"))
                                    .size(LabelSize::Small)
                                    .color(Color::Muted)
                            })))
                            .child(
                                Label::new(format!("{} files", summary.files_changed))
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .h(rems_from_px(46.))
                            .px_3()
                            .justify_between()
                            .child(
                                h_flex()
                                    .gap_1()
                                    .when(summary.can_review, |this| {
                                        this.child(
                                            Button::new(
                                                format!("review-agent-{thread_key}"),
                                                "Review",
                                            )
                                            .start_icon(Icon::new(IconName::GitBranch))
                                            .style(ButtonStyle::Outlined)
                                            .size(ButtonSize::Compact)
                                            .on_click(
                                                cx.listener(move |this, _, window, cx| {
                                                    cx.stop_propagation();
                                                    this.review_run(thread_id, window, cx);
                                                }),
                                            ),
                                        )
                                    })
                                    .when(summary.can_apply, |this| {
                                        this.child(
                                            Button::new(
                                                format!("apply-agent-{thread_key}"),
                                                "Apply",
                                            )
                                            .start_icon(Icon::new(IconName::Check))
                                            .style(ButtonStyle::Tinted(TintColor::Accent))
                                            .size(ButtonSize::Compact)
                                            .on_click(
                                                cx.listener(move |this, _, _, cx| {
                                                    cx.stop_propagation();
                                                    this.apply_run(thread_id, cx);
                                                }),
                                            ),
                                        )
                                    })
                                    .when(summary.worktree_label.is_some(), |this| {
                                        this.child(
                                            IconButton::new(
                                                format!("open-worktree-{thread_key}"),
                                                IconName::FolderOpen,
                                            )
                                            .icon_size(IconSize::Small)
                                            .tooltip(Tooltip::text("Open agent worktree"))
                                            .on_click(
                                                cx.listener(move |this, _, window, cx| {
                                                    cx.stop_propagation();
                                                    this.open_worktree(thread_id, window, cx);
                                                }),
                                            ),
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
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.stop_propagation();
                                                    this.stop_run(thread_id, cx);
                                                })),
                                            )
                                        },
                                    )
                                    .when(
                                        summary.status == BackboardAgentRunStatus::Blocked,
                                        |this| {
                                            let title = summary.title.clone();
                                            let reason = summary.blocked_reason.clone();
                                            this.child(
                                                Button::new(
                                                    format!("revise-agent-{thread_key}"),
                                                    "Revise",
                                                )
                                                .start_icon(Icon::new(IconName::Pencil))
                                                .style(ButtonStyle::Outlined)
                                                .size(ButtonSize::Compact)
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        cx.stop_propagation();
                                                        this.revise_run(
                                                            title.clone(),
                                                            reason.clone(),
                                                            window,
                                                            cx,
                                                        );
                                                    },
                                                )),
                                            )
                                        },
                                    )
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
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.stop_propagation();
                                                    this.retry_run(thread_id, cx);
                                                })),
                                            )
                                        },
                                    ),
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
                cx.theme().colors().text_muted
            }
        };

        div().size(px(7.)).rounded_full().bg(color)
    }

    fn render_status_badge(
        &self,
        status: BackboardAgentRunStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let color = match status {
            BackboardAgentRunStatus::Done => Color::Success,
            BackboardAgentRunStatus::Blocked => Color::Warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => Color::Error,
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => Color::Muted,
        };

        div()
            .px_2()
            .py_0p5()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                Label::new(status.label())
                    .size(LabelSize::Small)
                    .color(color),
            )
    }

    fn render_event_row(
        text: SharedString,
        state: BackboardAgentRunEventState,
    ) -> impl IntoElement {
        let (icon, color) = match state {
            BackboardAgentRunEventState::Active => (IconName::LoadCircle, Color::Accent),
            BackboardAgentRunEventState::Done => (IconName::Check, Color::Success),
            BackboardAgentRunEventState::Waiting => (IconName::Warning, Color::Warning),
            BackboardAgentRunEventState::Failed => (IconName::XCircle, Color::Error),
            BackboardAgentRunEventState::Muted => (IconName::ArrowRight, Color::Muted),
        };

        h_flex()
            .gap_2()
            .child(Icon::new(icon).size(IconSize::XSmall).color(color))
            .child(Label::new(text).size(LabelSize::Small).color(color))
    }

    fn render_configure(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let task_is_empty = self.task_editor.read(cx).text(cx).trim().is_empty();

        v_flex()
            .size_full()
            .id("backboard-agent-configure-scroll")
            .overflow_y_scroll()
            .items_center()
            .pt_5()
            .pb(rems_from_px(140.))
            .child(
                v_flex()
                    .w_full()
                    .max_w(rems_from_px(980.))
                    .max_w_full()
                    .px_5()
                    .gap_4()
                    .child(
                        h_flex()
                            .justify_between()
                            .items_center()
                            .child(
                                v_flex()
                                    .gap_1()
                                    .child(Headline::new("New Agent").size(HeadlineSize::Small))
                                    .child(
                                        Label::new("Configure and run")
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    ),
                            )
                            .child(
                                Button::new("back-to-agent-dashboard", "Dashboard")
                                    .start_icon(Icon::new(IconName::ArrowLeft))
                                    .style(ButtonStyle::Outlined)
                                    .size(ButtonSize::Medium)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.show_dashboard(cx);
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .rounded_md()
                            .border_1()
                            .border_color(cx.theme().colors().border)
                            .bg(cx.theme().colors().editor_background)
                            .p_3()
                            .gap_3()
                            .child(self.render_text_input(cx))
                            .child(
                                h_flex()
                                    .justify_between()
                                    .border_t_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .pt_3()
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .child(self.render_attachment_pill(
                                                "0 files attached",
                                                IconName::File,
                                                cx,
                                            ))
                                            .child(self.render_attachment_pill(
                                                "No branch",
                                                IconName::GitBranch,
                                                cx,
                                            )),
                                    )
                                    .child(
                                        Label::new("Describe the task...")
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_5()
                            .items_start()
                            .flex_wrap()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w(rems_from_px(320.))
                                    .child(self.render_scope_selector(cx)),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w(rems_from_px(420.))
                                    .child(self.render_kind_selector(cx)),
                            ),
                    )
                    .child(Divider::horizontal())
                    .child(
                        h_flex()
                            .justify_between()
                            .child(
                                div()
                                    .px_3()
                                    .py_2()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .child(
                                                Icon::new(IconName::BoltOutlined)
                                                    .size(IconSize::Small)
                                                    .color(Color::Muted),
                                            )
                                            .child(
                                                Label::new(format!(
                                                    "{} agent · {}",
                                                    self.selected_kind.label(),
                                                    self.selected_scope.label()
                                                ))
                                                .color(Color::Muted),
                                            ),
                                    ),
                            )
                            .child(
                                Button::new("run-agent", "Run Agent")
                                    .start_icon(Icon::new(IconName::PlayFilled))
                                    .style(ButtonStyle::Tinted(TintColor::Accent))
                                    .size(ButtonSize::Large)
                                    .disabled(task_is_empty)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.run_agent(window, cx);
                                    })),
                            ),
                    ),
            )
    }

    fn render_attachment_pill(
        &self,
        label: &'static str,
        icon: IconName,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                h_flex()
                    .gap_1()
                    .child(Icon::new(icon).size(IconSize::XSmall).color(Color::Muted))
                    .child(Label::new(label).size(LabelSize::Small).color(Color::Muted)),
            )
    }

    fn render_scope_selector(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_2()
            .child(Headline::new("Scope").size(HeadlineSize::XSmall))
            .child(
                h_flex()
                    .gap_2()
                    .flex_wrap()
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::WholeProject, cx))
                    .child(
                        self.render_scope_button(BackboardAgentWorkspaceScope::SelectedFiles, cx),
                    )
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::GitChanges, cx))
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::TestsOnly, cx)),
            )
    }

    fn render_scope_button(
        &self,
        scope: BackboardAgentWorkspaceScope,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_scope == scope;
        Button::new(format!("agent-scope-{}", scope.label()), scope.label())
            .style(if selected {
                ButtonStyle::Tinted(TintColor::Accent)
            } else {
                ButtonStyle::Outlined
            })
            .size(ButtonSize::Medium)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_scope = scope;
                cx.notify();
            }))
    }

    fn render_kind_selector(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_2()
            .child(Headline::new("Agent type").size(HeadlineSize::XSmall))
            .child(
                h_flex()
                    .gap_3()
                    .flex_wrap()
                    .child(self.render_kind_card(
                        BackboardAgentWorkspaceKind::Build,
                        IconName::ToolHammer,
                        "Write or refactor code",
                        cx,
                    ))
                    .child(self.render_kind_card(
                        BackboardAgentWorkspaceKind::Review,
                        IconName::Code,
                        "Analyze and improve",
                        cx,
                    ))
                    .child(self.render_kind_card(
                        BackboardAgentWorkspaceKind::Test,
                        IconName::Debug,
                        "Generate test coverage",
                        cx,
                    ))
                    .child(self.render_kind_card(
                        BackboardAgentWorkspaceKind::Docs,
                        IconName::Book,
                        "Write documentation",
                        cx,
                    )),
            )
    }

    fn render_kind_card(
        &self,
        kind: BackboardAgentWorkspaceKind,
        icon: IconName,
        description: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_kind == kind;
        h_flex()
            .w(rems_from_px(210.))
            .id(format!("agent-kind-{}", kind.label()))
            .h(rems_from_px(76.))
            .items_center()
            .gap_3()
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(if selected {
                cx.theme().colors().text_accent
            } else {
                cx.theme().colors().border_variant
            })
            .bg(if selected {
                cx.theme().colors().element_selected
            } else {
                cx.theme().colors().editor_background
            })
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_kind = kind;
                cx.notify();
            }))
            .child(
                Icon::new(icon)
                    .size(IconSize::Custom(rems_from_px(30.)))
                    .color(if selected {
                        Color::Accent
                    } else {
                        Color::Muted
                    }),
            )
            .child(
                v_flex()
                    .gap_0p5()
                    .child(Label::new(kind.label()).size(LabelSize::Default))
                    .child(
                        Label::new(description)
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
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
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(format!("{files} files modified"))
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(
                Label::new("System healthy")
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
    }
}

impl Render for BackboardAgentWorkspacePage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let summaries = self.summaries(cx);

        v_flex()
            .size_full()
            .bg(cx.theme().colors().editor_background)
            .key_context("BackboardAgentWorkspace")
            .child(self.render_header(&summaries, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(match self.mode {
                        WorkspacePageMode::Dashboard => self
                            .render_dashboard(summaries.clone(), cx)
                            .into_any_element(),
                        WorkspacePageMode::Configure => {
                            self.render_configure(cx).into_any_element()
                        }
                    }),
            )
            .child(self.render_bottom_bar(&summaries, cx))
    }
}

impl EventEmitter<ItemEvent> for BackboardAgentWorkspacePage {}

impl Focusable for BackboardAgentWorkspacePage {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.task_editor.read(cx).focus_handle(cx)
    }
}

impl Item for BackboardAgentWorkspacePage {
    type Event = ItemEvent;

    fn tab_content_text(&self, _detail: usize, _cx: &App) -> SharedString {
        "Agent Workspace".into()
    }

    fn telemetry_event_text(&self) -> Option<&'static str> {
        Some("Backboard Agent Workspace Opened")
    }

    fn show_toolbar(&self) -> bool {
        false
    }

    fn to_item_events(event: &Self::Event, f: &mut dyn FnMut(ItemEvent)) {
        f(*event)
    }
}
