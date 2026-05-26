use gpui::{App, Context, Empty, Entity, IntoElement, Render, SharedString, Window};
use project::{
    Project,
    git_store::{GitStore, GitStoreEvent, RepositoryEvent},
};
use ui::{Button, Icon, PopoverMenu, Tooltip, prelude::*};
use workspace::{HideStatusItem, StatusItemView, Workspace, item::ItemHandle};

const MAX_BRANCH_NAME_LENGTH: usize = 40;
const MAX_SHORT_SHA_LENGTH: usize = 8;

pub struct BranchStatusButton {
    workspace: gpui::WeakEntity<Workspace>,
    project: Entity<Project>,
    _subscription: gpui::Subscription,
}

impl BranchStatusButton {
    pub fn new(workspace: &Workspace, cx: &mut Context<Self>) -> Self {
        let project = workspace.project().clone();
        let git_store = project.read(cx).git_store().clone();
        let subscription = cx.subscribe(&git_store, Self::on_git_store_event);

        Self {
            workspace: workspace.weak_handle(),
            project,
            _subscription: subscription,
        }
    }

    fn on_git_store_event(
        &mut self,
        _git_store: Entity<GitStore>,
        event: &GitStoreEvent,
        cx: &mut Context<Self>,
    ) {
        let branch_changed = matches!(
            event,
            GitStoreEvent::ActiveRepositoryChanged(_)
                | GitStoreEvent::RepositoryAdded
                | GitStoreEvent::RepositoryRemoved(_)
                | GitStoreEvent::RepositoryUpdated(
                    _,
                    RepositoryEvent::HeadChanged
                        | RepositoryEvent::BranchListChanged
                        | RepositoryEvent::StatusesChanged,
                    _
                )
        );

        if branch_changed {
            cx.notify();
        }
    }
}

impl Render for BranchStatusButton {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(workspace) = self.workspace.upgrade() else {
            return Empty.into_any_element();
        };
        let Some(repository) = self.project.read(cx).active_repository(cx) else {
            return Empty.into_any_element();
        };

        let (label, tooltip, icon_name, icon_color) = {
            let repo = repository.read(cx);
            let status = repo.status_summary();
            let tracked = status.index + status.worktree;
            let (icon_name, icon_color) = if status.conflict > 0 {
                (IconName::Warning, Color::VersionControlConflict)
            } else if tracked.modified > 0 {
                (IconName::SquareDot, Color::VersionControlModified)
            } else if tracked.added > 0 || status.untracked > 0 {
                (IconName::SquarePlus, Color::VersionControlAdded)
            } else if tracked.deleted > 0 {
                (IconName::SquareMinus, Color::VersionControlDeleted)
            } else {
                (IconName::GitBranch, Color::Muted)
            };

            let branch_name = repo
                .branch
                .as_ref()
                .map(|branch| branch.name())
                .map(|name| util::truncate_and_trailoff(name, MAX_BRANCH_NAME_LENGTH))
                .or_else(|| {
                    repo.head_commit.as_ref().map(|commit| {
                        commit
                            .sha
                            .chars()
                            .take(MAX_SHORT_SHA_LENGTH)
                            .collect::<String>()
                    })
                });

            let Some(branch_name) = branch_name else {
                return Empty.into_any_element();
            };

            let tooltip = if repo.branch.is_some() {
                format!("Currently Checked Out: {branch_name}")
            } else {
                format!("Detached HEAD: {branch_name}")
            };

            (branch_name, tooltip, icon_name, icon_color)
        };

        PopoverMenu::new("status-bar-branch-menu")
            .menu(move |window, cx| {
                Some(crate::git_picker::popover(
                    workspace.downgrade(),
                    Some(repository.clone()),
                    crate::git_picker::GitPickerTab::Branches,
                    gpui::rems(34.),
                    window,
                    cx,
                ))
            })
            .trigger_with_tooltip(
                Button::new("status-bar-branch-trigger", SharedString::from(label))
                    .label_size(LabelSize::Small)
                    .color(Color::Muted)
                    .start_icon(
                        Icon::new(icon_name)
                            .size(IconSize::XSmall)
                            .color(icon_color),
                    ),
                move |_window, cx| {
                    Tooltip::with_meta(
                        "Branch & Stash",
                        Some(&zed_actions::git::Branch),
                        tooltip.clone(),
                        cx,
                    )
                },
            )
            .anchor(gpui::Anchor::BottomLeft)
            .into_any_element()
    }
}

impl StatusItemView for BranchStatusButton {
    fn set_active_pane_item(
        &mut self,
        _: Option<&dyn ItemHandle>,
        _window: &mut Window,
        _: &mut Context<Self>,
    ) {
    }

    fn hide_setting(&self, _: &App) -> Option<HideStatusItem> {
        None
    }
}
