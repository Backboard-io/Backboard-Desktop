use crate::{git_panel::GitPanel, project_diff::ProjectDiff};
use gpui::{
    Action, ClickEvent, Entity, EntityId, FocusHandle, Focusable, MouseButton, Subscription,
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
            .tab_bar_background
            .blend(colors.editor_background.opacity(0.28));
        let muted_panel_bg = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.38));

        h_flex()
            .h(px(56.))
            .w_full()
            .flex_shrink_0()
            .items_center()
            .gap_2()
            .px_3()
            .border_b_1()
            .border_color(colors.border_variant.opacity(0.55))
            .bg(toolbar_bg)
            .child(
                h_flex()
                    .min_w(px(180.))
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .size(px(28.))
                            .rounded_md()
                            .border_1()
                            .border_color(colors.border_variant.opacity(0.5))
                            .bg(muted_panel_bg)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::GitBranch)
                                    .size(IconSize::Small)
                                    .color(Color::Accent),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_0()
                            .min_w_0()
                            .child(
                                Label::new("Git workspace")
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new(format!("{changes_count} changed files"))
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    ),
            )
            .child(div().flex_1())
            .child(self.render_toolbar_chip(
                "git-workspace-repository",
                IconName::LockOutlined,
                "Repository",
                repo_name,
                Some("Select repository"),
                move |_, window, cx| {
                    window.dispatch_action(zed_actions::git::SelectRepo.boxed_clone(), cx);
                },
                cx,
            ))
            .child(self.render_toolbar_chip(
                "git-workspace-branch",
                IconName::GitBranch,
                "Branch",
                branch_name,
                Some("Switch branch"),
                move |_, window, cx| {
                    window.dispatch_action(zed_actions::git::Branch.boxed_clone(), cx);
                },
                cx,
            ))
            .child(self.render_toolbar_chip(
                "git-workspace-fetch",
                IconName::RotateCw,
                "Remote",
                "Fetch origin",
                Some("Fetch updates from remote"),
                move |_, window, cx| {
                    window.dispatch_action(git::Fetch.boxed_clone(), cx);
                },
                cx,
            ))
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cx.stop_propagation();
            })
    }

    fn render_toolbar_chip(
        &self,
        id: &'static str,
        icon: IconName,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
        tooltip: Option<&'static str>,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors();
        let label = label.into();
        let value = value.into();

        h_flex()
            .id(id)
            .h(px(34.))
            .max_w(px(240.))
            .min_w(px(148.))
            .px_2()
            .gap_2()
            .items_center()
            .rounded_md()
            .border_1()
            .border_color(colors.border_variant.opacity(0.5))
            .bg(colors
                .panel_background
                .blend(colors.editor_background.opacity(0.28)))
            .cursor_pointer()
            .hover(|style| style.bg(colors.element_hover.opacity(0.35)))
            .on_click(on_click)
            .when_some(tooltip, |this, tooltip| {
                this.tooltip(Tooltip::text(tooltip))
            })
            .child(Icon::new(icon).size(IconSize::Small).color(Color::Muted))
            .child(
                v_flex()
                    .min_w_0()
                    .child(
                        Label::new(label)
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(value)
                            .size(LabelSize::Small)
                            .color(Color::Default)
                            .truncate(),
                    ),
            )
            .child(
                div().ml_auto().child(
                    Icon::new(IconName::ChevronDown)
                        .size(IconSize::XSmall)
                        .color(Color::Muted),
                ),
            )
    }

    fn render_left_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();
        let changes_count = self.git_panel.read(cx).changes_count();
        let sidebar_bg = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.2));

        v_flex()
            .w(px(360.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(colors.border_variant.opacity(0.5))
            .bg(sidebar_bg)
            .child(
                h_flex()
                    .h(px(48.))
                    .flex_shrink_0()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .border_b_1()
                    .border_color(colors.border_variant.opacity(0.5))
                    .child(
                        h_flex()
                            .id("git-workspace-changes-tab")
                            .gap_2()
                            .items_center()
                            .child(Icon::new(IconName::FileGit).size(IconSize::Small))
                            .child(Label::new("Changes"))
                            .child(
                                Label::new(changes_count.to_string())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("git-workspace-history-tab")
                            .h(px(26.))
                            .px_2()
                            .gap_1()
                            .items_center()
                            .rounded_md()
                            .border_1()
                            .border_color(colors.border_variant.opacity(0.36))
                            .bg(colors.element_background.opacity(0.45))
                            .child(Icon::new(IconName::GitGraph).size(IconSize::XSmall))
                            .child(
                                Label::new("History")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
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
        let editor_background = cx.theme().colors().editor_background;
        let diff_background =
            editor_background.blend(cx.theme().colors().panel_background.opacity(0.12));
        let diff_border = cx.theme().colors().border_variant.opacity(0.45);

        v_flex()
            .id("git-workspace-view")
            .track_focus(&self.focus_handle)
            .key_context("GitWorkspaceView")
            .size_full()
            .overflow_hidden()
            .bg(editor_background)
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
                            .p_2()
                            .bg(diff_background)
                            .child(
                                div()
                                    .size_full()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(diff_border)
                                    .overflow_hidden()
                                    .bg(editor_background)
                                    .child(self.project_diff.clone()),
                            ),
                    ),
            )
    }
}
