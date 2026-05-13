use collections::{HashMap, HashSet};
use editor::{Editor, EditorElement, EditorEvent, EditorStyle};
use gpui::{
    AnyWindowHandle, App, Context, Entity, EntityId, EventEmitter, FocusHandle, Focusable, Global,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription,
    TextStyle, TitlebarOptions, WeakEntity, Window, WindowBackgroundAppearance, WindowBounds,
    WindowDecorations, WindowOptions, point, prelude::*, size,
};
use language::language_settings::SoftWrap;
use settings::Settings;
use theme_settings::ThemeSettings;
use ui::{
    Button, ButtonSize, ButtonStyle, Icon, IconButton, IconSize, Label, LabelSize, TintColor,
    Tooltip, prelude::*,
};
use workspace::Workspace;

use crate::{
    ConversationView,
    agent_panel::{
        AgentPanel, BackboardAgentRunEventState, BackboardAgentRunStatus, BackboardAgentRunSummary,
        BackboardAgentWorkspaceKind, BackboardAgentWorkspaceMode, BackboardAgentWorkspaceScope,
    },
    thread_metadata_store::ThreadId,
};

#[derive(Default)]
struct BackboardAgentPortalWindows {
    windows: HashMap<EntityId, AnyWindowHandle>,
}

impl Global for BackboardAgentPortalWindows {}

pub fn open_backboard_agent_portal(
    workspace: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let workspace_handle = workspace.weak_handle();
    let workspace_id = workspace_handle.entity_id();

    if let Some(handle) = cx
        .try_global::<BackboardAgentPortalWindows>()
        .and_then(|global| global.windows.get(&workspace_id).copied())
    {
        window.defer(cx, move |_, cx| {
            handle
                .update(cx, |_, window, _| {
                    window.activate_window();
                })
                .ok();
        });
        return;
    }

    window.defer(cx, move |window, cx| {
        let mut options = WindowOptions::default();
        options.window_bounds = Some(WindowBounds::centered(size(px(1200.), px(760.)), cx));
        options.window_min_size = Some(size(px(900.), px(560.)));
        options.window_background = WindowBackgroundAppearance::Opaque;
        options.window_decorations = Some(WindowDecorations::Client);
        options.titlebar = Some(TitlebarOptions {
            title: Some("Backboard Agent Portal".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(14.), px(14.))),
        });

        let workspace_for_window = workspace_handle.clone();
        match cx.open_window(options, move |window, cx| {
            BackboardAgentPortalWindow::new(workspace_for_window, window, cx)
        }) {
            Ok(handle) => {
                if cx.try_global::<BackboardAgentPortalWindows>().is_none() {
                    cx.set_global(BackboardAgentPortalWindows::default());
                }
                cx.global_mut::<BackboardAgentPortalWindows>()
                    .windows
                    .insert(workspace_id, handle.into());
            }
            Err(error) => {
                if let Some(workspace) = workspace_handle.upgrade() {
                    workspace.update(cx, |workspace, cx| workspace.show_error(&error, cx));
                }
                window.activate_window();
            }
        }
    });
}

pub struct BackboardAgentPortalWindow {
    workspace: WeakEntity<Workspace>,
    task_editor: Entity<Editor>,
    selected_scope: BackboardAgentWorkspaceScope,
    selected_kind: BackboardAgentWorkspaceKind,
    selected_mode: BackboardAgentWorkspaceMode,
    selected_thread_id: Option<ThreadId>,
    show_launcher: bool,
    dismissed_threads: HashSet<ThreadId>,
    _subscriptions: Vec<Subscription>,
}

impl BackboardAgentPortalWindow {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let workspace_id = workspace.entity_id();
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
            cx.on_release(move |_, cx| {
                if cx.try_global::<BackboardAgentPortalWindows>().is_some() {
                    cx.global_mut::<BackboardAgentPortalWindows>()
                        .windows
                        .remove(&workspace_id);
                }
            })
            .detach();

            Self {
                workspace,
                task_editor,
                selected_scope: BackboardAgentWorkspaceScope::WholeProject,
                selected_kind: BackboardAgentWorkspaceKind::Build,
                selected_mode: BackboardAgentWorkspaceMode::Agent,
                selected_thread_id: None,
                show_launcher: false,
                dismissed_threads: HashSet::default(),
                _subscriptions: Vec::new(),
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

    fn panel(&self, cx: &App) -> Option<Entity<AgentPanel>> {
        self.workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
    }

    fn summaries(&self, cx: &App) -> Vec<BackboardAgentRunSummary> {
        self.panel(cx)
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

    fn selected_conversation(&self, cx: &App) -> Option<Entity<ConversationView>> {
        let thread_id = self.selected_thread_id?;
        self.panel(cx).and_then(|panel| {
            panel
                .read(cx)
                .backboard_workspace_conversation_view(thread_id, cx)
        })
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

    fn workspace_name(&self, cx: &App) -> SharedString {
        self.workspace
            .upgrade()
            .and_then(|workspace| {
                workspace
                    .read(cx)
                    .project()
                    .read(cx)
                    .worktree_root_names(cx)
                    .next()
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "Backboard".to_string())
            .into()
    }

    fn focus_launcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_launcher = true;
        self.task_editor.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn run_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let tasks = self.task_lines(cx);
        if tasks.is_empty() {
            return;
        }

        let mut spawned = 0;
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                spawned = panel.spawn_backboard_workspace_agents(
                    tasks.clone(),
                    self.selected_scope,
                    self.selected_kind,
                    self.selected_mode,
                    window,
                    cx,
                );
            });
        }

        if spawned > 0 {
            self.task_editor
                .update(cx, |editor, cx| editor.set_text("", window, cx));
            self.show_launcher = false;
            cx.notify();
        }
    }

    fn stop_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                panel.stop_backboard_workspace_agent(thread_id, cx);
            });
        }
    }

    fn retry_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                panel.retry_backboard_workspace_agent(thread_id, cx);
            });
        }
    }

    fn review_run(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                panel.review_backboard_workspace_agent(thread_id, window, cx);
            });
        }
    }

    fn apply_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                panel.apply_backboard_workspace_agent(thread_id, cx);
            });
        }
    }

    fn open_worktree(&mut self, thread_id: ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel(cx) {
            panel.update(cx, |panel, cx| {
                panel.open_backboard_workspace_agent_worktree(thread_id, window, cx);
            });
        }
    }

    fn dismiss_run(&mut self, thread_id: ThreadId, cx: &mut Context<Self>) {
        self.dismissed_threads.insert(thread_id);
        if self.selected_thread_id == Some(thread_id) {
            self.selected_thread_id = None;
        }
        cx.notify();
    }

    fn render_window_chrome(
        &self,
        summaries: &[BackboardAgentRunSummary],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let running = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Running)
            .count();
        let suffix = if running == 1 {
            "1 agent running".to_string()
        } else {
            format!("{running} agents running")
        };

        h_flex()
            .h(rems_from_px(44.))
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .justify_center()
            .child(
                h_flex()
                    .gap_2()
                    .rounded_md()
                    .border_1()
                    .border_color(cx.theme().colors().border_variant)
                    .bg(cx.theme().colors().element_background)
                    .px_3()
                    .py_1()
                    .child(
                        Icon::new(IconName::Command)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(format!("{} - {suffix}", self.workspace_name(cx).as_ref()))
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    )
                    .child(
                        div()
                            .rounded_sm()
                            .bg(cx.theme().colors().element_selected)
                            .px_1p5()
                            .child(Label::new("K").size(LabelSize::Small).color(Color::Muted)),
                    ),
            )
    }

    fn render_left_rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .w(rems_from_px(48.))
            .h_full()
            .border_r_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .items_center()
            .py_4()
            .justify_between()
            .child(
                v_flex()
                    .gap_4()
                    .items_center()
                    .child(self.render_rail_icon(IconName::Split, true, "Agent workspace"))
                    .child(self.render_rail_icon(IconName::MagnifyingGlass, false, "Search"))
                    .child(self.render_rail_icon(IconName::GitBranch, false, "Branches"))
                    .child(self.render_rail_icon(IconName::ZedAgent, false, "Agents"))
                    .child(self.render_rail_icon(IconName::Box, false, "Artifacts")),
            )
            .child(self.render_rail_icon(IconName::Settings, false, "Settings"))
    }

    fn render_rail_icon(
        &self,
        icon: IconName,
        selected: bool,
        tooltip: &'static str,
    ) -> impl IntoElement {
        div()
            .id(format!("portal-rail-icon-{tooltip}"))
            .size(rems_from_px(28.))
            .rounded_sm()
            .flex()
            .items_center()
            .justify_center()
            .bg(if selected {
                gpui::transparent_black()
            } else {
                gpui::transparent_black()
            })
            .child(Icon::new(icon).size(IconSize::Small).color(if selected {
                Color::Accent
            } else {
                Color::Muted
            }))
            .tooltip(Tooltip::text(tooltip))
    }

    fn render_toolbar(
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
        let done = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Done)
            .count();
        let ready = summaries.iter().filter(|summary| summary.can_apply).count();
        let blocked = summaries
            .iter()
            .filter(|summary| summary.status == BackboardAgentRunStatus::Blocked)
            .count();
        let label = if active == 1 {
            "1 agent running".to_string()
        } else {
            format!("{active} agents running")
        };

        h_flex()
            .h(rems_from_px(40.))
            .px_4()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .justify_between()
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .size(px(6.))
                            .rounded_full()
                            .bg(cx.theme().colors().text_accent),
                    )
                    .child(
                        Icon::new(IconName::ZedAgent)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    )
                    .child(Label::new(label).color(Color::Accent))
                    .child(self.render_count_pill(format!("{done} done"), Color::Success, cx))
                    .child(self.render_count_pill(
                        format!("{ready} ready"),
                        if ready > 0 {
                            Color::Success
                        } else {
                            Color::Muted
                        },
                        cx,
                    ))
                    .child(self.render_count_pill(
                        format!("{blocked} blocked"),
                        if blocked > 0 {
                            Color::Warning
                        } else {
                            Color::Muted
                        },
                        cx,
                    )),
            )
            .child(
                Button::new("add-agent", "Add agent")
                    .start_icon(Icon::new(IconName::Plus))
                    .style(ButtonStyle::Outlined)
                    .size(ButtonSize::Compact)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.focus_launcher(window, cx);
                    })),
            )
    }

    fn render_launcher(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let task_count = self.task_lines(cx).len();
        let run_label = if task_count == 1 {
            "Run 1 agent".to_string()
        } else {
            format!("Run {task_count} agents")
        };
        let settings = ThemeSettings::get_global(cx);
        let text_style = TextStyle {
            color: cx.theme().colors().text_accent,
            font_family: settings.ui_font.family.clone(),
            font_features: settings.ui_font.features.clone(),
            font_fallbacks: settings.ui_font.fallbacks.clone(),
            font_size: rems(0.82).into(),
            font_weight: settings.ui_font.weight,
            line_height: relative(1.25),
            ..Default::default()
        };

        v_flex()
            .gap_2()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().elevated_surface_background)
            .p_2()
            .child(
                h_flex()
                    .gap_2()
                    .items_start()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .rounded_sm()
                            .border_1()
                            .border_color(cx.theme().colors().border_variant)
                            .bg(cx.theme().colors().element_background)
                            .p_2()
                            .child(EditorElement::new(
                                &self.task_editor,
                                EditorStyle {
                                    background: cx.theme().colors().element_background,
                                    local_player: cx.theme().players().local(),
                                    text: text_style,
                                    ..Default::default()
                                },
                            )),
                    )
                    .child(
                        Button::new("run-agents", run_label)
                            .start_icon(Icon::new(IconName::PlayFilled))
                            .style(ButtonStyle::Tinted(TintColor::Accent))
                            .size(ButtonSize::Compact)
                            .disabled(task_count == 0)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run_agents(window, cx);
                            })),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .flex_wrap()
                    .items_center()
                    .child(
                        Label::new("Mode")
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    )
                    .child(self.render_mode_button(BackboardAgentWorkspaceMode::Agent, cx))
                    .child(self.render_mode_button(BackboardAgentWorkspaceMode::Ask, cx))
                    .child(self.render_mode_button(BackboardAgentWorkspaceMode::Manual, cx))
                    .child(self.render_mode_button(BackboardAgentWorkspaceMode::Free, cx))
                    .child(
                        Label::new("Scope")
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    )
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::WholeProject, cx))
                    .child(
                        self.render_scope_button(BackboardAgentWorkspaceScope::SelectedFiles, cx),
                    )
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::GitChanges, cx))
                    .child(self.render_scope_button(BackboardAgentWorkspaceScope::TestsOnly, cx))
                    .child(
                        Label::new("Type")
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    )
                    .child(self.render_kind_button(BackboardAgentWorkspaceKind::Build, cx))
                    .child(self.render_kind_button(BackboardAgentWorkspaceKind::Review, cx))
                    .child(self.render_kind_button(BackboardAgentWorkspaceKind::Test, cx))
                    .child(self.render_kind_button(BackboardAgentWorkspaceKind::Docs, cx)),
            )
    }

    fn render_mode_button(
        &self,
        mode: BackboardAgentWorkspaceMode,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_mode == mode;
        Button::new(format!("portal-agent-mode-{}", mode.label()), mode.label())
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
        Button::new(
            format!("portal-agent-scope-{}", scope.label()),
            scope.label(),
        )
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
        Button::new(format!("portal-agent-kind-{}", kind.label()), kind.label())
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

    fn render_main_area(
        &self,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if summaries.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .p_6()
                .child(
                    v_flex()
                        .w(rems_from_px(720.))
                        .gap_4()
                        .child(Label::new("No active Backboard agents").color(Color::Accent))
                        .child(self.render_launcher(cx)),
                )
                .into_any_element();
        }

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
        let groups = summary_groups
            .into_iter()
            .map(|(batch_id, summaries)| match batch_id {
                Some(batch_id) if summaries.len() > 1 => self
                    .render_batch_group(batch_id, summaries, cx)
                    .into_any_element(),
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
            .id("portal-agent-card-scroll")
            .overflow_y_scroll()
            .p_3()
            .gap_3()
            .children(groups)
            .into_any_element()
    }

    fn render_batch_group(
        &self,
        batch_id: String,
        summaries: Vec<BackboardAgentRunSummary>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
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
        let short_id = batch_id.chars().take(8).collect::<String>();
        let cards = summaries
            .into_iter()
            .map(|summary| self.render_agent_card(summary, cx).into_any_element())
            .collect::<Vec<_>>();

        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .px_1()
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
                            .child(self.render_count_pill(
                                format!("{running} running"),
                                Color::Accent,
                                cx,
                            ))
                            .child(self.render_count_pill(
                                format!("{blocked} blocked"),
                                if blocked > 0 {
                                    Color::Warning
                                } else {
                                    Color::Muted
                                },
                                cx,
                            ))
                            .child(self.render_count_pill(
                                format!("{done} done"),
                                Color::Success,
                                cx,
                            ))
                            .child(self.render_count_pill(
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
    }

    fn render_agent_card(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        let selected = self.selected_thread_id == Some(thread_id);
        let status_color = Self::status_color(summary.status, cx);
        let meta = match (summary.kind_label.clone(), summary.scope_label.clone()) {
            (Some(kind), Some(scope)) => format!("{} - {}", kind.as_ref(), scope.as_ref()),
            (Some(kind), None) => kind.to_string(),
            (None, Some(scope)) => scope.to_string(),
            (None, None) => "Build - Whole Project".to_string(),
        };

        v_flex()
            .id(format!("portal-agent-card-{thread_key}"))
            .w(rems_from_px(350.))
            .max_w_full()
            .rounded_sm()
            .border_1()
            .border_color(if selected {
                cx.theme().colors().text_accent
            } else {
                cx.theme().colors().border_variant
            })
            .bg(cx.theme().colors().elevated_surface_background)
            .overflow_hidden()
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_thread_id = Some(thread_id);
                this.show_launcher = false;
                cx.notify();
            }))
            .child(
                h_flex()
                    .h(rems_from_px(34.))
                    .px_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_2()
                            .child(div().size(px(7.)).rounded_full().bg(status_color))
                            .child(
                                Icon::new(IconName::ZedAgent)
                                    .size(IconSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                Label::new(summary.title.clone())
                                    .size(LabelSize::Small)
                                    .color(Color::Accent)
                                    .truncate(),
                            )
                            .child(self.render_status_badge(summary.status, cx)),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(Label::new(meta).size(LabelSize::Small).color(Color::Muted)),
                    ),
            )
            .child(
                div()
                    .px_2()
                    .py_2()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        div().line_clamp(2).child(
                            Label::new(summary.command.clone())
                                .size(LabelSize::Small)
                                .color(Color::Accent),
                        ),
                    ),
            )
            .child(self.render_files_section(&summary, cx))
            .when_some(summary.blocked_reason.clone(), |this, reason| {
                this.child(
                    h_flex()
                        .gap_1()
                        .px_2()
                        .py_1()
                        .border_b_1()
                        .border_color(cx.theme().colors().border_variant)
                        .child(
                            Icon::new(IconName::Warning)
                                .size(IconSize::XSmall)
                                .color(Color::Warning),
                        )
                        .child(
                            Label::new(reason)
                                .size(LabelSize::Small)
                                .color(Color::Warning)
                                .truncate(),
                        ),
                )
            })
            .child(self.render_events_section(&summary, cx))
            .child(self.render_card_actions(summary, cx))
    }

    fn render_files_section(
        &self,
        summary: &BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let paths = summary.touched_paths.iter().take(3).collect::<Vec<_>>();
        v_flex()
            .gap_1()
            .px_2()
            .py_2()
            .border_b_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Icon::new(IconName::FileCode)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(format!("Files touched - {}", summary.files_changed))
                            .size(LabelSize::Small)
                            .color(Color::Accent),
                    ),
            )
            .children(paths.into_iter().map(|path| {
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .size(px(5.))
                            .rounded_full()
                            .bg(cx.theme().colors().text_muted),
                    )
                    .child(
                        Label::new(path.to_string())
                            .size(LabelSize::Small)
                            .color(Color::Muted)
                            .truncate(),
                    )
                    .into_any_element()
            }))
            .when(summary.touched_paths.is_empty(), |this| {
                this.child(
                    Label::new("Waiting for file activity")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
            })
    }

    fn render_events_section(
        &self,
        summary: &BackboardAgentRunSummary,
        _cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .mx_2()
            .my_2()
            .gap_1()
            .children(summary.latest_events.iter().take(3).map(|event| {
                let (icon, color) = match event.state {
                    BackboardAgentRunEventState::Active => (IconName::LoadCircle, Color::Accent),
                    BackboardAgentRunEventState::Done => (IconName::Check, Color::Success),
                    BackboardAgentRunEventState::Waiting => (IconName::Warning, Color::Warning),
                    BackboardAgentRunEventState::Failed => (IconName::XCircle, Color::Error),
                    BackboardAgentRunEventState::Muted => (IconName::ArrowRight, Color::Muted),
                };
                h_flex()
                    .gap_2()
                    .child(Icon::new(icon).size(IconSize::XSmall).color(color))
                    .child(
                        Label::new(event.text.clone())
                            .size(LabelSize::Small)
                            .color(color)
                            .truncate(),
                    )
                    .into_any_element()
            }))
    }

    fn render_card_actions(
        &self,
        summary: BackboardAgentRunSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let thread_id = summary.thread_id;
        let thread_key = thread_id.to_key_string();
        h_flex()
            .h(rems_from_px(34.))
            .px_2()
            .justify_between()
            .border_t_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                h_flex()
                    .gap_1()
                    .when(summary.can_review, |this| {
                        this.child(
                            Button::new(format!("portal-review-{thread_key}"), "Review")
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
                            Button::new(format!("portal-apply-{thread_key}"), "Apply")
                                .start_icon(Icon::new(IconName::Check))
                                .style(ButtonStyle::Tinted(TintColor::Accent))
                                .size(ButtonSize::Compact)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.apply_run(thread_id, cx);
                                })),
                        )
                    })
                    .when(summary.worktree_label.is_some(), |this| {
                        this.child(
                            IconButton::new(
                                format!("portal-open-worktree-{thread_key}"),
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
                            BackboardAgentRunStatus::Running | BackboardAgentRunStatus::Queued
                        ),
                        |this| {
                            this.child(
                                IconButton::new(
                                    format!("portal-stop-{thread_key}"),
                                    IconName::Stop,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Stop agent"))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        cx.stop_propagation();
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
                                    format!("portal-retry-{thread_key}"),
                                    IconName::Rerun,
                                )
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Retry agent"))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.retry_run(thread_id, cx);
                                    },
                                )),
                            )
                        },
                    ),
            )
            .child(
                IconButton::new(format!("portal-dismiss-{thread_key}"), IconName::Check)
                    .icon_size(IconSize::Small)
                    .tooltip(Tooltip::text("Dismiss card"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.dismiss_run(thread_id, cx);
                    })),
            )
    }

    fn render_status_badge(
        &self,
        status: BackboardAgentRunStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .px_2()
            .py_0p5()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .child(
                Label::new(status.label())
                    .size(LabelSize::Small)
                    .color(Self::status_color_label(status)),
            )
    }

    fn render_count_pill(
        &self,
        label: String,
        color: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .px_1p5()
            .py_0p5()
            .rounded_sm()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .child(Label::new(label).size(LabelSize::Small).color(color))
    }

    fn status_color(status: BackboardAgentRunStatus, cx: &mut Context<Self>) -> gpui::Hsla {
        match status {
            BackboardAgentRunStatus::Done => cx.theme().status().success,
            BackboardAgentRunStatus::Blocked => cx.theme().status().warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => {
                cx.theme().status().error
            }
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => {
                cx.theme().colors().text_accent
            }
        }
    }

    fn status_color_label(status: BackboardAgentRunStatus) -> Color {
        match status {
            BackboardAgentRunStatus::Done => Color::Success,
            BackboardAgentRunStatus::Blocked => Color::Warning,
            BackboardAgentRunStatus::Error | BackboardAgentRunStatus::Canceled => Color::Error,
            BackboardAgentRunStatus::Queued | BackboardAgentRunStatus::Running => Color::Accent,
        }
    }

    fn render_chat_drawer(
        &self,
        selected: Option<Entity<ConversationView>>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let show_drawer = selected.is_some() || self.show_launcher;
        let selected_is_none = selected.is_none();
        div().when(show_drawer, |this| {
            this.w(rems_from_px(390.))
                .h_full()
                .border_l_1()
                .border_color(cx.theme().colors().border_variant)
                .bg(cx.theme().colors().editor_background)
                .child(
                    v_flex()
                        .size_full()
                        .child(
                            h_flex()
                                .h(rems_from_px(40.))
                                .px_3()
                                .justify_between()
                                .border_b_1()
                                .border_color(cx.theme().colors().border_variant)
                                .child(Label::new("Agent Chat").color(Color::Accent))
                                .child(
                                    IconButton::new("close-agent-chat", IconName::Close)
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Close chat"))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.selected_thread_id = None;
                                            this.show_launcher = false;
                                            cx.notify();
                                        })),
                                ),
                        )
                        .when(self.show_launcher, |this| {
                            this.child(div().p_3().child(self.render_launcher(cx)))
                        })
                        .when_some(selected, |this, conversation| {
                            this.child(
                                div()
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_hidden()
                                    .child(conversation),
                            )
                        })
                        .when(selected_is_none && !self.show_launcher, |this| {
                            this.child(
                                v_flex()
                                    .flex_1()
                                    .items_center()
                                    .justify_center()
                                    .child(Label::new("Select an agent").color(Color::Muted)),
                            )
                        }),
                )
        })
    }

    fn render_status_bar(
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
        let branch = summaries
            .iter()
            .find_map(|summary| summary.branch_label.clone())
            .unwrap_or_else(|| "main".into());

        h_flex()
            .h(rems_from_px(26.))
            .px_3()
            .justify_between()
            .border_t_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().tab_bar_background)
            .child(
                h_flex()
                    .gap_4()
                    .child(
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
                    .child(
                        Label::new(format!(
                            "{active} active agent{}",
                            if active == 1 { "" } else { "s" }
                        ))
                        .size(LabelSize::Small)
                        .color(Color::Accent),
                    )
                    .child(
                        Label::new(format!(
                            "{files} file{} modified",
                            if files == 1 { "" } else { "s" }
                        ))
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .child(
                        Icon::new(IconName::SignalHigh)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("System healthy")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
    }
}

impl Render for BackboardAgentPortalWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let summaries = self.summaries(cx);
        let selected = self.selected_conversation(cx);

        v_flex()
            .size_full()
            .bg(cx.theme().colors().editor_background)
            .key_context("BackboardAgentPortal")
            .child(self.render_window_chrome(&summaries, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_left_rail(cx))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .size_full()
                            .child(self.render_toolbar(&summaries, cx))
                            .child(self.render_main_area(summaries.clone(), cx)),
                    )
                    .child(self.render_chat_drawer(selected, cx)),
            )
            .child(self.render_status_bar(&summaries, cx))
    }
}

impl EventEmitter<()> for BackboardAgentPortalWindow {}

impl Focusable for BackboardAgentPortalWindow {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.task_editor.read(cx).focus_handle(cx)
    }
}
