use collections::HashSet;
use editor::{Editor, EditorElement, EditorEvent, EditorStyle};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, ParentElement, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement, Styled, Subscription, TextStyle, WeakEntity, Window,
    prelude::*,
};
use language::language_settings::SoftWrap;
use settings::Settings;
use theme_settings::ThemeSettings;
use ui::{
    Button, ButtonSize, ButtonStyle, Icon, IconButton, IconSize, Label, LabelSize, TintColor,
    Tooltip, WithScrollbar, prelude::*,
};
use workspace::Workspace;

use crate::ConversationView;
use crate::agent_panel::{
    AgentPanel, AgentPanelEvent, BackboardAgentRunEventState, BackboardAgentRunStatus,
    BackboardAgentRunSummary, BackboardAgentWorkspaceKind, BackboardAgentWorkspaceMode,
    BackboardAgentWorkspaceScope,
};
use crate::thread_metadata_store::ThreadId;
use zed_actions::agent::Chat;

pub struct BackboardAgentWorkspacePage {
    workspace: WeakEntity<Workspace>,
    task_editor: Entity<Editor>,
    selected_scope: BackboardAgentWorkspaceScope,
    selected_kind: BackboardAgentWorkspaceKind,
    selected_mode: BackboardAgentWorkspaceMode,
    selected_thread_id: Option<ThreadId>,
    pending_launch_batch_id: Option<String>,
    run_list_scroll_handle: ScrollHandle,
    dashboard_scroll_handle: ScrollHandle,
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
                let mut editor = Editor::auto_height(2, 5, window, cx);
                editor.set_soft_wrap_mode(SoftWrap::EditorWidth, cx);
                editor.set_placeholder_text(
                    "One task per line. Each line starts an isolated agent...",
                    window,
                    cx,
                );
                editor
            });

            cx.subscribe(&task_editor, Self::handle_task_editor_event)
                .detach();

            let mut subscriptions = Vec::new();
            if let Some(panel) = panel {
                subscriptions.push(cx.observe(&panel, |_, _, cx| cx.notify()));
                subscriptions.push(cx.subscribe_in(&panel, window, Self::handle_agent_panel_event));
            }

            Self {
                workspace,
                task_editor,
                selected_scope: BackboardAgentWorkspaceScope::WholeProject,
                selected_kind: BackboardAgentWorkspaceKind::Build,
                selected_mode: BackboardAgentWorkspaceMode::Agent,
                selected_thread_id: None,
                pending_launch_batch_id: None,
                run_list_scroll_handle: ScrollHandle::new(),
                dashboard_scroll_handle: ScrollHandle::new(),
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
                batch_id,
            } => {
                let should_select = self
                    .pending_launch_batch_id
                    .as_ref()
                    .is_some_and(|pending| pending == batch_id)
                    || self.selected_thread_id.is_none();

                if should_select {
                    self.selected_thread_id = Some(*thread_id);
                    if self
                        .pending_launch_batch_id
                        .as_ref()
                        .is_some_and(|pending| pending == batch_id)
                    {
                        self.pending_launch_batch_id = None;
                        self.task_editor
                            .update(cx, |editor, cx| editor.set_text("", window, cx));
                    }
                    self.focus_selected_conversation(window, cx);
                }
                cx.notify();
            }
            AgentPanelEvent::BackboardWorkspaceLaunchFailed { batch_id } => {
                if self
                    .pending_launch_batch_id
                    .as_ref()
                    .is_some_and(|pending| pending == batch_id)
                {
                    self.pending_launch_batch_id = None;
                    self.task_editor.focus_handle(cx).focus(window, cx);
                    cx.notify();
                }
            }
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

    fn show_configure(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.task_editor.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn create_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        if let Some(thread_id) = panel.create_backboard_workspace_chat(window, cx) {
                            self.selected_thread_id = Some(thread_id);
                        }
                    });
                }
            });
        }
        self.focus_selected_conversation(window, cx);
        cx.notify();
    }

    fn task_lines(&self, cx: &App) -> Vec<String> {
        self.task_editor
            .read(cx)
            .text(cx)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    }

    fn run_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let tasks = self.task_lines(cx);
        if tasks.is_empty() {
            return;
        }

        let mut created_thread_ids = Vec::new();
        let mut pending_batch_id = None;
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        let result = panel.spawn_backboard_workspace_agents(
                            tasks.clone(),
                            self.selected_scope,
                            self.selected_kind,
                            self.selected_mode,
                            window,
                            cx,
                        );
                        if result.pending_worktree_setup && result.accepted_count > 0 {
                            pending_batch_id = Some(result.batch_id.clone());
                        }
                        created_thread_ids = result.created_thread_ids;
                    });
                }
            });
        }

        if let Some(thread_id) = created_thread_ids.first().copied() {
            self.selected_thread_id = Some(thread_id);
            self.task_editor
                .update(cx, |editor, cx| editor.set_text("", window, cx));
            self.focus_selected_conversation(window, cx);
            cx.notify();
        } else if let Some(batch_id) = pending_batch_id {
            self.pending_launch_batch_id = Some(batch_id);
            cx.notify();
        }
    }

    fn focus_selected_conversation(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(thread_id) = self.selected_thread_id
            && let Some(conversation) = self.conversation_for_thread(thread_id, cx)
        {
            conversation.focus_handle(cx).focus(window, cx);
        }
    }

    fn submit_task_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.task_editor.focus_handle(cx).is_focused(window) {
            self.run_agent(window, cx);
            cx.notify();
        }
    }

    fn submit_chat_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.task_editor.focus_handle(cx).is_focused(window) {
            self.run_agent(window, cx);
            cx.notify();
            return;
        }

        let active_thread = self
            .selected_thread_id
            .and_then(|thread_id| self.conversation_for_thread(thread_id, cx))
            .and_then(|conversation| conversation.read(cx).active_thread().cloned());

        if let Some(active_thread) = active_thread {
            active_thread.update(cx, |thread, cx| thread.send(window, cx));
        }
    }

    fn open_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_thread_id = Some(thread_id);
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

    fn render_text_input(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = ThemeSettings::get_global(cx);
        let text_style = TextStyle {
            color: cx.theme().colors().text,
            font_family: settings.ui_font.family.clone(),
            font_features: settings.ui_font.features.clone(),
            font_fallbacks: settings.ui_font.fallbacks.clone(),
            font_size: rems(0.82).into(),
            font_weight: settings.ui_font.weight,
            line_height: relative(1.25),
            ..Default::default()
        };

        EditorElement::new(
            &self.task_editor,
            EditorStyle {
                background: cx.theme().colors().element_background,
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
        let ready = summaries.iter().filter(|summary| summary.can_apply).count();

        h_flex()
            .h(rems_from_px(48.))
            .px_4()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::Sparkle)
                            .size(IconSize::Small)
                            .color(Color::Accent),
                    )
                    .child(
                        v_flex()
                            .gap_0()
                            .child(
                                Label::new("Agent Workspace")
                                    .size(LabelSize::Default)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new("Parallel Backboard chats")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(self.render_counter_pill(
                                format!("{} / 20 chats", summaries.len()),
                                Color::Muted,
                                cx,
                            ))
                            .child(self.render_counter_pill(
                                format!("{running} running"),
                                Color::Accent,
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
                Button::new("new-agent-chat", "New Chat")
                    .start_icon(Icon::new(IconName::Plus))
                    .style(ButtonStyle::Tinted(TintColor::Accent))
                    .size(ButtonSize::Compact)
                    .disabled(summaries.len() >= 20)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.create_chat(window, cx);
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

    fn render_launch_strip(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let task_count = self.task_lines(cx).len();
        let runnable_task_count = task_count.min(20);
        let launch_pending = self.pending_launch_batch_id.is_some();
        let run_label = if launch_pending {
            "Setting up...".to_string()
        } else if runnable_task_count == 1 {
            "Run 1 agent".to_string()
        } else {
            format!("Run {runnable_task_count} agents")
        };

        v_flex()
            .flex_shrink_0()
            .gap_2()
            .p_3()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                Label::new("New agents")
                                    .size(LabelSize::Default)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new(if launch_pending {
                                    "Preparing an isolated workspace"
                                } else {
                                    "One task per line, up to 20"
                                })
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                            ),
                    )
                    .child(
                        Button::new("run-agents", run_label)
                            .start_icon(Icon::new(IconName::PlayFilled))
                            .style(ButtonStyle::Tinted(TintColor::Accent))
                            .size(ButtonSize::Compact)
                            .disabled(task_count == 0 || launch_pending)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_agent(window, cx);
                            })),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .rounded_sm()
                    .border_1()
                    .border_color(cx.theme().colors().border_variant)
                    .bg(cx.theme().colors().element_background)
                    .p_2()
                    .child(self.render_text_input(cx)),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                Label::new("Mode")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .flex_wrap()
                                    .child(
                                        self.render_mode_button(
                                            BackboardAgentWorkspaceMode::Agent,
                                            cx,
                                        ),
                                    )
                                    .child(
                                        self.render_mode_button(
                                            BackboardAgentWorkspaceMode::Ask,
                                            cx,
                                        ),
                                    )
                                    .child(self.render_mode_button(
                                        BackboardAgentWorkspaceMode::Manual,
                                        cx,
                                    ))
                                    .child(
                                        self.render_mode_button(
                                            BackboardAgentWorkspaceMode::Free,
                                            cx,
                                        ),
                                    ),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                Label::new("Scope")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .flex_wrap()
                                    .child(self.render_scope_button(
                                        BackboardAgentWorkspaceScope::WholeProject,
                                        cx,
                                    ))
                                    .child(self.render_scope_button(
                                        BackboardAgentWorkspaceScope::SelectedFiles,
                                        cx,
                                    ))
                                    .child(self.render_scope_button(
                                        BackboardAgentWorkspaceScope::GitChanges,
                                        cx,
                                    ))
                                    .child(self.render_scope_button(
                                        BackboardAgentWorkspaceScope::TestsOnly,
                                        cx,
                                    )),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                Label::new("Type")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .flex_wrap()
                                    .child(
                                        self.render_kind_button(
                                            BackboardAgentWorkspaceKind::Build,
                                            cx,
                                        ),
                                    )
                                    .child(self.render_kind_button(
                                        BackboardAgentWorkspaceKind::Review,
                                        cx,
                                    ))
                                    .child(
                                        self.render_kind_button(
                                            BackboardAgentWorkspaceKind::Test,
                                            cx,
                                        ),
                                    )
                                    .child(
                                        self.render_kind_button(
                                            BackboardAgentWorkspaceKind::Docs,
                                            cx,
                                        ),
                                    ),
                            ),
                    ),
            )
    }

    fn render_left_rail(
        &self,
        summaries: &[BackboardAgentRunSummary],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .w(rems_from_px(380.))
            .min_w(rems_from_px(320.))
            .max_w(rems_from_px(440.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().elevated_surface_background)
            .child(self.render_launch_strip(cx))
            .child(self.render_run_list(summaries, window, cx))
    }

    fn render_run_list(
        &self,
        summaries: &[BackboardAgentRunSummary],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let count = summaries.len();
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .h(rems_from_px(36.))
                    .px_3()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        Label::new("Agents")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(format!("{count} total"))
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(if summaries.is_empty() {
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .px_4()
                    .child(
                        Icon::new(IconName::Sparkle)
                            .size(IconSize::Medium)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Send a task to start an agent.")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .into_any_element()
            } else {
                v_flex()
                    .id("backboard-agent-run-list")
                    .track_scroll(&self.run_list_scroll_handle)
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_2()
                    .child(
                        v_flex().gap_1().children(
                            summaries.iter().cloned().map(|summary| {
                                self.render_agent_row(summary, cx).into_any_element()
                            }),
                        ),
                    )
                    .vertical_scrollbar_for(&self.run_list_scroll_handle, window, cx)
                    .into_any_element()
            })
    }

    fn render_agent_row(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let selected = self.selected_thread_id == Some(thread_id);
        let row_bg = if selected {
            cx.theme().colors().element_selected
        } else {
            cx.theme().colors().editor_background
        };
        let border_color = if selected {
            cx.theme().colors().text_accent
        } else {
            cx.theme().colors().border_variant
        };
        let status_color = Self::status_label_color(summary.status);

        v_flex()
            .id(format!("backboard-agent-row-{thread_key}"))
            .w_full()
            .min_h(rems_from_px(76.))
            .rounded_sm()
            .border_1()
            .border_color(border_color)
            .bg(row_bg)
            .cursor_pointer()
            .hover(|style| style.bg(cx.theme().colors().element_hover))
            .p_2()
            .gap_1()
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_run(thread_id, window, cx);
                this.focus_selected_conversation(window, cx);
            }))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .justify_between()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .min_w_0()
                            .child(self.render_status_dot(summary.status, cx))
                            .child(
                                Label::new(summary.title.clone())
                                    .size(LabelSize::Small)
                                    .color(if selected {
                                        Color::Accent
                                    } else {
                                        Color::Default
                                    })
                                    .truncate(),
                            ),
                    )
                    .child(
                        Label::new(summary.status.label())
                            .size(LabelSize::Small)
                            .color(status_color),
                    ),
            )
            .child(
                Label::new(summary.command.clone())
                    .size(LabelSize::Small)
                    .color(Color::Muted)
                    .truncate(),
            )
            .child(
                h_flex()
                    .gap_2()
                    .justify_between()
                    .child(
                        Label::new(format!("{} files", summary.files_changed))
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .children(
                        summary.cost.clone().map(|cost| {
                            Label::new(cost).size(LabelSize::Small).color(Color::Muted)
                        }),
                    ),
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
                            Icon::new(IconName::Sparkle)
                                .size(IconSize::XLarge)
                                .color(Color::Accent),
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
        for summary in summaries {
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
        let selected = self.selected_thread_id == Some(thread_id);
        let event_rows = summary
            .latest_events
            .iter()
            .take(3)
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

        v_flex()
            .id(format!("backboard-agent-card-{thread_key}"))
            .min_w(rems_from_px(280.))
            .max_w(rems_from_px(360.))
            .h(rems_from_px(232.))
            .flex_1()
            .rounded_sm()
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
                    .h(rems_from_px(38.))
                    .px_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .gap_2()
                            .min_w_0()
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
                                            .truncate(),
                                    )
                                    .child(
                                        Label::new(card_label)
                                            .size(LabelSize::Small)
                                            .color(Color::Accent)
                                            .truncate(),
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
                                                        .color(Color::Accent)
                                                        .truncate(),
                                                ),
                                        )
                                    }),
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
                    .p_2()
                    .flex_1()
                    .child(
                        Label::new(summary.command.clone())
                            .size(LabelSize::Small)
                            .color(Color::Accent)
                            .truncate(),
                    )
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
                                                        .color(Color::Accent)
                                                        .truncate(),
                                                ),
                                        )
                                    })
                                    .when_some(summary.apply_state_label.clone(), |this, label| {
                                        this.child(
                                            Label::new(label)
                                                .size(LabelSize::Small)
                                                .color(Color::Accent)
                                                .truncate(),
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
                            .h(rems_from_px(28.))
                            .px_2()
                            .justify_between()
                            .child(h_flex().gap_2().children(summary.cost.clone().map(|cost| {
                                Label::new(format!("· {cost}"))
                                    .size(LabelSize::Small)
                                    .color(Color::Accent)
                            })))
                            .child(
                                Label::new(format!("{} files", summary.files_changed))
                                    .size(LabelSize::Small)
                                    .color(Color::Accent),
                            ),
                    )
                    .child(
                        h_flex()
                            .h(rems_from_px(34.))
                            .px_2()
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
        let color = Self::status_label_color(status);

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

    fn status_label_color(status: BackboardAgentRunStatus) -> Color {
        match status {
            BackboardAgentRunStatus::Done => Color::Success,
            BackboardAgentRunStatus::Blocked => Color::Warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => Color::Error,
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => Color::Accent,
        }
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
            BackboardAgentRunEventState::Muted => (IconName::ArrowRight, Color::Accent),
        };

        h_flex()
            .h(rems_from_px(21.))
            .min_w_0()
            .gap_1p5()
            .child(Icon::new(icon).size(IconSize::XSmall).color(color))
            .child(
                Label::new(text)
                    .size(LabelSize::Small)
                    .color(color)
                    .truncate(),
            )
    }

    fn render_mode_button(
        &self,
        mode: BackboardAgentWorkspaceMode,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_mode == mode;
        Button::new(format!("agent-mode-button-{}", mode.label()), mode.label())
            .style(if selected {
                ButtonStyle::Tinted(TintColor::Accent)
            } else {
                ButtonStyle::Outlined
            })
            .size(ButtonSize::Compact)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_mode = mode;
                cx.notify();
            }))
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
            .size(ButtonSize::Compact)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_scope = scope;
                cx.notify();
            }))
    }

    fn render_kind_button(
        &self,
        kind: BackboardAgentWorkspaceKind,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_kind == kind;
        Button::new(format!("agent-kind-button-{}", kind.label()), kind.label())
            .style(if selected {
                ButtonStyle::Tinted(TintColor::Accent)
            } else {
                ButtonStyle::Outlined
            })
            .size(ButtonSize::Compact)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_kind = kind;
                cx.notify();
            }))
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
                    Label::new("Use the task composer on the left to open a real Backboard chat.")
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

        h_flex()
            .h(rems_from_px(48.))
            .px_3()
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
                                    .color(Color::Default)
                                    .truncate(),
                            )
                            .child(
                                Label::new(summary.command.clone())
                                    .size(LabelSize::Small)
                                    .color(Color::Muted)
                                    .truncate(),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .child(self.render_status_badge(summary.status, cx))
                    .when(summary.status == BackboardAgentRunStatus::Blocked, |this| {
                        let title = summary.title.clone();
                        let reason = summary.blocked_reason.clone();
                        this.child(
                            Button::new(format!("revise-selected-{thread_key}"), "Revise")
                                .start_icon(Icon::new(IconName::Pencil))
                                .style(ButtonStyle::Outlined)
                                .size(ButtonSize::Compact)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.revise_run(title.clone(), reason.clone(), window, cx);
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
                    .when(summary.worktree_label.is_some(), |this| {
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
            .border_t_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .h(rems_from_px(44.))
                    .px_3()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
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
                                            .color(Color::Accent)
                                            .truncate(),
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
        selected_detail: Option<(BackboardAgentRunSummary, Entity<ConversationView>)>,
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
            .when_some(selected_detail, |this, (summary, conversation)| {
                this.child(self.render_detail_drawer(summary, conversation, cx))
            })
            .when(self.selected_thread_id.is_none(), |this| {
                let chat_count = self.summaries(cx).len();
                this.child(
                    v_flex()
                        .flex_1()
                        .min_h_0()
                        .items_center()
                        .justify_center()
                        .gap_3()
                        .px_5()
                        .child(
                            Icon::new(IconName::ThreadsSidebarRightOpen)
                                .size(IconSize::XLarge)
                                .color(Color::Muted),
                        )
                        .child(
                            Label::new("Select a chat on the left.")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        )
                        .child(
                            Button::new("empty-new-agent-chat", "New Chat")
                                .start_icon(Icon::new(IconName::Plus))
                                .style(ButtonStyle::Tinted(TintColor::Accent))
                                .size(ButtonSize::Compact)
                                .disabled(chat_count >= 20)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.create_chat(window, cx);
                                })),
                        )
                        .when(chat_count >= 20, |this| {
                            this.child(
                                Label::new("Chat limit reached")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                        }),
                )
            })
    }
}

impl Render for BackboardAgentWorkspacePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let summaries = self.summaries(cx);
        let selected_detail = self.selected_thread_id.and_then(|thread_id| {
            let summary = summaries
                .iter()
                .find(|summary| summary.thread_id == thread_id)
                .cloned()?;
            let conversation = self.conversation_for_thread(thread_id, cx)?;
            Some((summary, conversation))
        });
        if self.selected_thread_id.is_some() && selected_detail.is_none() {
            self.selected_thread_id = None;
        }
        let selected_detail = self.selected_thread_id.and_then(|thread_id| {
            let summary = summaries
                .iter()
                .find(|summary| summary.thread_id == thread_id)
                .cloned()?;
            let conversation = self.conversation_for_thread(thread_id, cx)?;
            Some((summary, conversation))
        });

        v_flex()
            .size_full()
            .bg(cx.theme().colors().editor_background)
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
                    .child(
                        div().flex_1().min_w_0().h_full().overflow_hidden().child(
                            self.render_dashboard(summaries.clone(), window, cx)
                                .into_any_element(),
                        ),
                    )
                    .child(self.render_right_panel(selected_detail, window, cx)),
            )
    }
}

impl Focusable for BackboardAgentWorkspacePage {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.task_editor.read(cx).focus_handle(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation_view::tests::init_test;
    use fs::FakeFs;
    use gpui::{TestAppContext, VisualTestContext};
    use project::Project;
    use serde_json::json;
    use std::path::Path;
    use workspace::MultiWorkspace;

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
    async fn test_workspace_agent_page_new_chat_selects_retained_conversation(
        cx: &mut TestAppContext,
    ) {
        let (_workspace, panel, page, mut cx) = setup_workspace_page(cx, true).await;

        page.update_in(&mut cx, |page, window, cx| {
            page.create_chat(window, cx);
        });
        cx.run_until_parked();

        let selected_thread_id = page.read_with(&cx, |page, _cx| {
            page.selected_thread_id
                .expect("created workspace chat should be selected")
        });

        panel.read_with(&cx, |panel, cx| {
            let conversation = panel
                .backboard_workspace_conversation_view(selected_thread_id, cx)
                .expect("selected workspace chat should expose a real conversation");
            assert_eq!(conversation.read(cx).parent_id(), selected_thread_id);
            assert!(panel.is_retained_thread(&selected_thread_id));
        });
    }

    #[gpui::test]
    async fn test_workspace_agent_page_git_launch_creates_shared_threads_immediately(
        cx: &mut TestAppContext,
    ) {
        let (_workspace, panel, page, mut cx) = setup_workspace_page(cx, true).await;
        let prompt = "fix the chat composer\npolish the run list";

        page.update_in(&mut cx, |page, window, cx| {
            page.task_editor
                .update(cx, |editor, cx| editor.set_text(prompt, window, cx));
            page.task_editor.focus_handle(cx).focus(window, cx);
            page.run_agent(window, cx);
        });

        page.read_with(&cx, |page, cx| {
            assert_eq!(page.task_editor.read(cx).text(cx), "");
            assert!(
                page.pending_launch_batch_id.is_none(),
                "git workspaces should no longer use async worktree setup"
            );
            assert!(page.selected_thread_id.is_some());
        });

        cx.run_until_parked();

        let selected_thread_id = page.read_with(&cx, |page, cx| {
            assert_eq!(page.task_editor.read(cx).text(cx), "");
            assert!(page.pending_launch_batch_id.is_none());
            page.selected_thread_id
                .expect("first created git workspace agent should be selected")
        });

        panel.read_with(&cx, |panel, cx| {
            let summaries = panel.backboard_agent_run_summaries(cx);
            assert_eq!(summaries.len(), 2);
            for summary in summaries {
                assert_eq!(
                    summary
                        .apply_state_label
                        .as_ref()
                        .map(|label| label.as_ref()),
                    Some("Current workspace")
                );
                assert!(summary.worktree_label.is_none());
                assert!(summary.branch_label.is_none());
            }
            let conversation = panel
                .backboard_workspace_conversation_view(selected_thread_id, cx)
                .expect("selected git workspace chat should expose a real conversation");
            assert_eq!(conversation.read(cx).parent_id(), selected_thread_id);
            assert!(panel.is_retained_thread(&selected_thread_id));
        });
    }
}
