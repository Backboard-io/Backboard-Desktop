use crate::{git_panel::GitPanel, project_diff::ProjectDiff};
use gpui::{
    Action, ClickEvent, Entity, EntityId, FocusHandle, Focusable, FontWeight, MouseButton, Pixels,
    Subscription,
};
use project::Project;
use ui::{Icon, IconName, IconSize, LabelSize, Tooltip, prelude::*};
use workspace::Workspace;

pub struct GitWorkspaceView {
    git_panel: Entity<GitPanel>,
    project_diff: Entity<ProjectDiff>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl GitWorkspaceView {
    pub fn new(
        project: Entity<Project>,
        workspace: Entity<Workspace>,
        git_panel: Entity<GitPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let project_diff = cx.new(|cx| ProjectDiff::new(project, workspace.clone(), window, cx));
        let focus_handle = cx.focus_handle();
        let subscriptions = vec![
            cx.observe(&git_panel, |_, _, cx| cx.notify()),
            cx.observe(&project_diff, |_, _, cx| cx.notify()),
        ];

        Self {
            git_panel,
            project_diff,
            focus_handle,
            _subscriptions: subscriptions,
        }
    }

    pub fn git_panel_entity_id(&self) -> EntityId {
        self.git_panel.entity_id()
    }

    fn render_top_bar(&self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();
        let panel = self.git_panel.read(cx);
        let repo_name = panel
            .active_repository_name(cx)
            .unwrap_or_else(|| "No repository".into());
        let branch_name = panel
            .active_branch_name(cx)
            .unwrap_or_else(|| "No branch".into());
        let changes_count = panel.changes_count();
        let toolbar_bg = colors
            .panel_background
            .blend(colors.tab_bar_background.opacity(0.56));

        h_flex()
            .h(px(74.))
            .w_full()
            .flex_shrink_0()
            .border_b_1()
            .border_color(colors.border_variant)
            .bg(toolbar_bg)
            .child(self.render_toolbar_tile(
                "git-workspace-repository",
                IconName::LockOutlined,
                "Current Repository",
                repo_name,
                px(390.),
                true,
                Some("Select repository"),
                move |_, window, cx| {
                    window.dispatch_action(zed_actions::git::SelectRepo.boxed_clone(), cx);
                },
                cx,
            ))
            .child(self.render_toolbar_tile(
                "git-workspace-branch",
                IconName::GitBranch,
                "Current Branch",
                branch_name,
                px(350.),
                true,
                Some("Switch branch"),
                move |_, window, cx| {
                    window.dispatch_action(zed_actions::git::Branch.boxed_clone(), cx);
                },
                cx,
            ))
            .child(self.render_toolbar_tile(
                "git-workspace-fetch",
                IconName::RotateCw,
                "Fetch origin",
                format!("{changes_count} changed files"),
                px(350.),
                false,
                Some("Fetch updates from remote"),
                move |_, window, cx| {
                    window.dispatch_action(git::Fetch.boxed_clone(), cx);
                },
                cx,
            ))
            .child(div().flex_1().h_full())
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cx.stop_propagation();
            })
    }

    fn render_toolbar_tile(
        &self,
        id: &'static str,
        icon: IconName,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
        width: Pixels,
        show_chevron: bool,
        tooltip: Option<&'static str>,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors();
        let label = label.into();
        let value = value.into();

        h_flex()
            .id(id)
            .h_full()
            .w(width)
            .px_4()
            .gap_3()
            .items_center()
            .border_r_1()
            .border_color(colors.border_variant)
            .cursor_pointer()
            .hover(|style| style.bg(colors.element_hover.opacity(0.45)))
            .on_click(on_click)
            .when_some(tooltip, |this, tooltip| {
                this.tooltip(Tooltip::text(tooltip))
            })
            .child(Icon::new(icon).size(IconSize::Medium).color(Color::Default))
            .child(
                v_flex()
                    .min_w_0()
                    .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
                    .child(
                        Label::new(value)
                            .size(LabelSize::Default)
                            .color(Color::Default)
                            .weight(FontWeight::BOLD)
                            .truncate(),
                    ),
            )
            .when(show_chevron, |this| {
                this.child(
                    div().ml_auto().child(
                        Icon::new(IconName::ChevronDown)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    ),
                )
            })
    }

    fn render_left_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();
        let changes_count = self.git_panel.read(cx).changes_count();

        v_flex()
            .w(px(390.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(colors.border_variant)
            .bg(colors.panel_background)
            .child(
                h_flex()
                    .h(px(44.))
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(colors.border_variant)
                    .child(
                        h_flex()
                            .id("git-workspace-changes-tab")
                            .h_full()
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .gap_2()
                            .border_b_2()
                            .border_color(colors.border_selected)
                            .child(Label::new("Changes"))
                            .child(
                                div()
                                    .min_w(px(20.))
                                    .h(px(20.))
                                    .px_1p5()
                                    .rounded_full()
                                    .bg(colors.element_selected)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        Label::new(changes_count.to_string())
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("git-workspace-history-tab")
                            .h_full()
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .child(Label::new("History").color(Color::Muted)),
                    ),
            )
            .child(div().flex_1().min_h_0().child(self.git_panel.clone()))
    }
}

impl Focusable for GitWorkspaceView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for GitWorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();

        v_flex()
            .id("git-workspace-view")
            .track_focus(&self.focus_handle)
            .key_context("GitWorkspaceView")
            .size_full()
            .overflow_hidden()
            .bg(colors.editor_background)
            .child(self.render_top_bar(window, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_left_sidebar(cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .child(self.project_diff.clone()),
                    ),
            )
    }
}
