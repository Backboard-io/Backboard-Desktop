use crate::{
    git_panel::{GitPanel, GitPanelChangeSummary},
    project_diff::{self, ProjectDiff},
};
use gpui::{
    Action, Anchor, Entity, EntityId, FocusHandle, Focusable, FontWeight, MouseButton, Subscription,
};
use project::Project;
use ui::{
    Button, ButtonSize, ButtonStyle, ContextMenu, Icon, IconName, IconSize, LabelSize, PopoverMenu,
    TintColor, Tooltip, prelude::*,
};
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
        let (border_variant, toolbar_bg, element_background) = {
            let colors = cx.theme().colors();
            (
                colors.border_variant,
                colors
                    .panel_background
                    .blend(colors.tab_bar_background.opacity(0.28)),
                colors.element_background,
            )
        };
        let (
            repo_name,
            has_repository,
            branch_name,
            has_branch,
            remote_summary,
            change_summary,
            can_stage_all,
            can_unstage_all,
            can_commit,
        ) = {
            let panel = self.git_panel.read(cx);
            let repo_name = panel.active_repository_name(cx);
            let branch_name = panel.active_branch_name(cx);

            (
                repo_name.clone().unwrap_or_else(|| "No repository".into()),
                repo_name.is_some(),
                branch_name.clone().unwrap_or_else(|| "No branch".into()),
                branch_name.is_some(),
                panel
                    .active_remote_summary(cx)
                    .unwrap_or_else(|| "No remote".into()),
                panel.change_summary(cx),
                panel.can_stage_all(),
                panel.can_unstage_all(),
                panel.can_commit(),
            )
        };

        let status_icon = if change_summary.conflicts > 0 {
            IconName::Warning
        } else if change_summary.changed > 0 {
            IconName::FileGit
        } else {
            IconName::Check
        };

        let status_color = if change_summary.conflicts > 0 {
            Color::VersionControlConflict
        } else if change_summary.changed > 0 {
            Color::VersionControlModified
        } else {
            Color::Success
        };

        h_flex()
            .h(px(64.))
            .w_full()
            .flex_shrink_0()
            .gap_3()
            .px_3()
            .border_b_1()
            .border_color(border_variant.opacity(0.42))
            .bg(toolbar_bg)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_3()
                    .items_center()
                    .child(
                        div()
                            .size(px(30.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_sm()
                            .border_1()
                            .border_color(border_variant.opacity(0.34))
                            .bg(element_background.opacity(0.28))
                            .child(
                                Icon::new(IconName::Github)
                                    .size(IconSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        v_flex()
                            .min_w_0()
                            .gap_1()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1()
                                    .child(
                                        Label::new(repo_name)
                                            .size(LabelSize::Default)
                                            .weight(FontWeight::SEMIBOLD)
                                            .truncate(),
                                    )
                                    .child(Label::new("/").size(LabelSize::Small).color(
                                        Color::Custom(cx.theme().colors().text_muted.opacity(0.48)),
                                    ))
                                    .child(
                                        Label::new(branch_name)
                                            .size(LabelSize::Default)
                                            .color(if has_branch {
                                                Color::Default
                                            } else {
                                                Color::Muted
                                            })
                                            .truncate(),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1p5()
                                    .child(Self::render_status_pill(
                                        "git-workspace-change-summary",
                                        status_icon,
                                        Self::format_change_summary(change_summary),
                                        status_color,
                                        cx,
                                    ))
                                    .child(Self::render_status_pill(
                                        "git-workspace-remote-summary",
                                        IconName::RotateCw,
                                        remote_summary,
                                        Color::Muted,
                                        cx,
                                    )),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap_1()
                    .child(self.render_repository_menu(has_repository))
                    .child(self.render_branch_menu(has_repository, has_branch))
                    .child(self.render_sync_menu(has_repository, has_branch))
                    .child(self.render_changes_menu(
                        has_repository,
                        change_summary,
                        can_stage_all,
                        can_unstage_all,
                        can_commit,
                    ))
                    .child(
                        Button::new("git-workspace-commit", "Commit")
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Tinted(TintColor::Accent))
                            .start_icon(Icon::new(IconName::GitCommit))
                            .disabled(!can_commit)
                            .tooltip(Tooltip::text("Commit changes"))
                            .on_click(|_, window, cx| {
                                window.dispatch_action(git::Commit.boxed_clone(), cx);
                            }),
                    )
                    .child(
                        self.git_panel
                            .update(cx, |panel, cx| panel.render_workspace_more_menu(cx)),
                    ),
            )
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                cx.stop_propagation();
            })
    }

    fn render_status_pill(
        id: &'static str,
        icon: IconName,
        label: impl Into<SharedString>,
        color: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors();

        h_flex()
            .id(id)
            .h(px(20.))
            .max_w(px(320.))
            .min_w_0()
            .gap_1()
            .px_2()
            .rounded_sm()
            .border_1()
            .border_color(colors.border_variant.opacity(0.28))
            .bg(colors.element_background.opacity(0.18))
            .child(Icon::new(icon).size(IconSize::XSmall).color(color))
            .child(
                Label::new(label)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .truncate(),
            )
    }

    fn menu_trigger(
        id: &'static str,
        label: &'static str,
        icon: IconName,
        disabled: bool,
    ) -> Button {
        Button::new(id, label)
            .size(ButtonSize::Compact)
            .style(ButtonStyle::Subtle)
            .label_size(LabelSize::Small)
            .start_icon(Icon::new(icon).size(IconSize::XSmall))
            .end_icon(Icon::new(IconName::ChevronDown).size(IconSize::XSmall))
            .disabled(disabled)
    }

    fn render_repository_menu(&self, has_repository: bool) -> impl IntoElement {
        let focus_handle = self.focus_handle.clone();

        PopoverMenu::new("git-workspace-repository-menu")
            .trigger_with_tooltip(
                Self::menu_trigger(
                    "git-workspace-repository-menu-trigger",
                    "Repository",
                    IconName::Github,
                    false,
                ),
                Tooltip::text("Repository actions"),
            )
            .menu(move |window, cx| {
                Some(ContextMenu::build(window, cx, |menu, _, _| {
                    menu.context(focus_handle.clone())
                        .action(
                            "Select Repository",
                            zed_actions::git::SelectRepo.boxed_clone(),
                        )
                        .action("Clone Repository", git::Clone.boxed_clone())
                        .separator()
                        .action_disabled_when(
                            !has_repository,
                            "Refresh",
                            git::Refresh.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_repository,
                            "Open Diff",
                            project_diff::Diff.boxed_clone(),
                        )
                }))
            })
            .anchor(Anchor::BottomRight)
    }

    fn render_branch_menu(&self, has_repository: bool, has_branch: bool) -> impl IntoElement {
        let focus_handle = self.focus_handle.clone();

        PopoverMenu::new("git-workspace-branch-menu")
            .trigger_with_tooltip(
                Self::menu_trigger(
                    "git-workspace-branch-menu-trigger",
                    "Branch",
                    IconName::GitBranch,
                    !has_repository,
                ),
                Tooltip::text("Branch and worktree actions"),
            )
            .menu(move |window, cx| {
                Some(ContextMenu::build(window, cx, |menu, _, _| {
                    menu.context(focus_handle.clone())
                        .action_disabled_when(
                            !has_repository,
                            "Switch Branch",
                            zed_actions::git::Branch.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_branch,
                            "Create Pull Request",
                            zed_actions::git::CreatePullRequest.boxed_clone(),
                        )
                        .separator()
                        .action_disabled_when(
                            !has_branch,
                            "Rename Branch",
                            git::RenameBranch::default().boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_branch,
                            "Copy Branch Name",
                            git::CopyBranchName.boxed_clone(),
                        )
                        .separator()
                        .action_disabled_when(
                            !has_repository,
                            "Worktrees",
                            zed_actions::git::Worktree.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_repository,
                            "View Stash",
                            zed_actions::git::ViewStash.boxed_clone(),
                        )
                }))
            })
            .anchor(Anchor::BottomRight)
    }

    fn render_sync_menu(&self, has_repository: bool, has_branch: bool) -> impl IntoElement {
        let focus_handle = self.focus_handle.clone();

        PopoverMenu::new("git-workspace-sync-menu")
            .trigger_with_tooltip(
                Self::menu_trigger(
                    "git-workspace-sync-menu-trigger",
                    "Sync",
                    IconName::RotateCw,
                    !has_repository,
                ),
                Tooltip::text("Fetch, pull, and push"),
            )
            .menu(move |window, cx| {
                Some(ContextMenu::build(window, cx, |menu, _, _| {
                    menu.context(focus_handle.clone())
                        .action_disabled_when(!has_branch, "Sync Changes", git::Sync.boxed_clone())
                        .action_disabled_when(!has_repository, "Fetch", git::Fetch.boxed_clone())
                        .action_disabled_when(
                            !has_repository,
                            "Fetch From",
                            git::FetchFrom.boxed_clone(),
                        )
                        .separator()
                        .action_disabled_when(!has_branch, "Pull", git::Pull.boxed_clone())
                        .action_disabled_when(
                            !has_branch,
                            "Pull (Rebase)",
                            git::PullRebase.boxed_clone(),
                        )
                        .separator()
                        .action_disabled_when(!has_branch, "Push", git::Push.boxed_clone())
                        .action_disabled_when(!has_branch, "Push To", git::PushTo.boxed_clone())
                        .action_disabled_when(
                            !has_branch,
                            "Force Push",
                            git::ForcePush.boxed_clone(),
                        )
                }))
            })
            .anchor(Anchor::BottomRight)
    }

    fn render_changes_menu(
        &self,
        has_repository: bool,
        change_summary: GitPanelChangeSummary,
        can_stage_all: bool,
        can_unstage_all: bool,
        can_commit: bool,
    ) -> impl IntoElement {
        let focus_handle = self.focus_handle.clone();
        let has_changes = change_summary.changed > 0;
        let has_tracked_changes = change_summary.tracked > 0;
        let has_new_changes = change_summary.new_files > 0;

        PopoverMenu::new("git-workspace-changes-menu")
            .trigger_with_tooltip(
                Self::menu_trigger(
                    "git-workspace-changes-menu-trigger",
                    "Changes",
                    IconName::FileGit,
                    !has_repository,
                ),
                Tooltip::text("Working tree actions"),
            )
            .menu(move |window, cx| {
                Some(ContextMenu::build(window, cx, |menu, _, _| {
                    menu.context(focus_handle.clone())
                        .action_disabled_when(
                            !can_stage_all,
                            "Stage All",
                            git::StageAll.boxed_clone(),
                        )
                        .action_disabled_when(
                            !can_unstage_all,
                            "Unstage All",
                            git::UnstageAll.boxed_clone(),
                        )
                        .action_disabled_when(!can_commit, "Commit", git::Commit.boxed_clone())
                        .action_disabled_when(!can_commit, "Amend Commit", git::Amend.boxed_clone())
                        .separator()
                        .action_disabled_when(
                            !has_changes,
                            "Stash All",
                            git::StashAll.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_repository,
                            "View Stash",
                            zed_actions::git::ViewStash.boxed_clone(),
                        )
                        .separator()
                        .action_disabled_when(
                            !has_changes,
                            "Open Modified Files",
                            git::OpenModifiedFiles.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_tracked_changes,
                            "Discard Tracked Changes",
                            git::RestoreTrackedFiles.boxed_clone(),
                        )
                        .action_disabled_when(
                            !has_new_changes,
                            "Trash Untracked Files",
                            git::TrashUntrackedFiles.boxed_clone(),
                        )
                }))
            })
            .anchor(Anchor::BottomRight)
    }

    fn format_change_summary(summary: GitPanelChangeSummary) -> SharedString {
        if summary.changed == 0 {
            return "Clean".into();
        }

        let changed = match summary.changed {
            1 => "1 changed file".to_string(),
            count => format!("{count} changed files"),
        };

        if summary.conflicts > 0 {
            return format!("{changed}, {} conflicted", summary.conflicts).into();
        }

        match (summary.staged, summary.unstaged) {
            (0, unstaged) => format!("{changed}, {unstaged} unstaged").into(),
            (staged, 0) => format!("{changed}, {staged} staged").into(),
            (staged, unstaged) => format!("{changed}, {staged} staged, {unstaged} unstaged").into(),
        }
    }

    fn render_left_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();
        let changes_count = self.git_panel.read(cx).changes_count();

        v_flex()
            .w(px(360.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(colors.border_variant.opacity(0.38))
            .bg(colors.panel_background.opacity(0.68))
            .child(
                h_flex()
                    .h(px(42.))
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(colors.border_variant.opacity(0.34))
                    .px_2()
                    .gap_1()
                    .child(
                        h_flex()
                            .id("git-workspace-changes-tab")
                            .h(px(28.))
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .gap_2()
                            .rounded_sm()
                            .bg(colors.element_selected.opacity(0.18))
                            .child(Label::new("Changes"))
                            .child(
                                div()
                                    .min_w(px(20.))
                                    .h(px(20.))
                                    .px_1p5()
                                    .rounded_full()
                                    .bg(colors.element_background.opacity(0.5))
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
                            .h(px(28.))
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .rounded_sm()
                            .hover(|style| style.bg(colors.element_hover.opacity(0.32)))
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
