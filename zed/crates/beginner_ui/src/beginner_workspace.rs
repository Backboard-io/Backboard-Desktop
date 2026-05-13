use std::path::PathBuf;

use acp_thread::{AcpThread, AcpThreadEvent};
use agent_ui::AgentPanel;
use db::kvp::KeyValueStore;
use editor::Editor;
use gpui::{
    App, AsyncWindowContext, Context, Entity, EventEmitter, FocusHandle, Focusable,
    PathPromptOptions, Render, SharedString, Subscription, Task, WeakEntity, Window,
};
use onboarding::{EXPERIENCE_LEVEL_KVP_KEY, ExperienceLevel};
use project::Project;
use recent_projects::RecentProjectEntry;
use ui::{
    Button, ButtonStyle, Color, Headline, HeadlineSize, Icon, IconButton, IconName, IconSize,
    Label, LabelSize, Tooltip, prelude::*,
};
use util::ResultExt;
use workspace::{MultiWorkspace, Workspace, WorkspaceDb};

use crate::beginner_chat_feed::BeginnerChatFeed;
use crate::file_changes_panel::{FileChangesPanel, FileChangesPanelEvent};

pub enum BeginnerWorkspaceEvent {
    SwitchToEditor,
}

impl EventEmitter<BeginnerWorkspaceEvent> for BeginnerWorkspace {}

enum BeginnerState {
    Landing,
    ActiveProject { project_name: SharedString },
}

pub struct BeginnerWorkspace {
    workspace: WeakEntity<Workspace>,
    #[allow(dead_code)]
    multi_workspace: WeakEntity<MultiWorkspace>,
    project: Entity<Project>,
    focus_handle: FocusHandle,
    state: BeginnerState,
    chat_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    is_agent_running: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    recent_projects: Vec<RecentProjectEntry>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl BeginnerWorkspace {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        multi_workspace: WeakEntity<MultiWorkspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let chat_editor = cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 8, window, cx);
            editor.set_placeholder_text("Describe your project or idea...", window, cx);
            editor
        });

        let load_recent = Self::load_recent_projects(workspace.clone(), window, cx);

        let project = workspace
            .upgrade()
            .map(|ws| ws.read(cx).project().clone())
            .expect("workspace must be alive when BeginnerWorkspace is created");

        // Sync initial state from whatever project worktrees already exist
        // (e.g. user opened a folder from the Editor before switching to Chat).
        let initial_folder = first_visible_worktree_path(&project, cx);
        let state = folder_to_state(initial_folder.as_ref());

        // Keep state in sync when folders are opened or closed from any mode.
        let project_sub =
            cx.subscribe(
                &project,
                |this, _proj, event: &project::Event, cx| match event {
                    project::Event::WorktreeAdded(_) | project::Event::WorktreeRemoved(_) => {
                        this.sync_from_project(cx);
                    }
                    _ => {}
                },
            );

        Self {
            workspace,
            multi_workspace,
            project,
            focus_handle: cx.focus_handle(),
            state,
            chat_editor,
            selected_folder: initial_folder,
            thread: None,
            is_agent_running: false,
            chat_feed: None,
            file_changes_panel: None,
            recent_projects: Vec::new(),
            _tasks: vec![load_recent],
            _subscriptions: vec![project_sub],
        }
    }

    /// Called whenever the project's worktree list changes so the Chat UI
    /// stays in sync with folders opened or closed from any mode.
    fn sync_from_project(&mut self, cx: &mut Context<Self>) {
        let new_folder = first_visible_worktree_path(&self.project, cx);

        // Only reset to Landing when the project truly has no folders —
        // don't discard an in-progress conversation when a second worktree
        // is added (e.g. agent workspace creating a git linked worktree).
        match (&self.state, &new_folder) {
            (BeginnerState::Landing, Some(_)) => {
                // A folder was opened from another mode — switch to active.
                self.selected_folder = new_folder;
                self.state = folder_to_state(self.selected_folder.as_ref());
                cx.notify();
            }
            (BeginnerState::ActiveProject { .. }, None) => {
                // All folders removed — return to landing.
                self.selected_folder = None;
                self.state = BeginnerState::Landing;
                self.chat_feed = None;
                self.thread = None;
                self.file_changes_panel = None;
                self.is_agent_running = false;
                cx.notify();
            }
            _ => {}
        }
    }

    fn load_recent_projects(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn_in(window, async move |this, cx| {
            let Some((fs, db)) = cx
                .update(|_, cx| {
                    let workspace = workspace.upgrade()?;
                    let app_state = workspace.read(cx).app_state().clone();
                    let db = WorkspaceDb::global(cx);
                    Some((app_state.fs.clone(), db))
                })
                .ok()
                .flatten()
            else {
                return;
            };

            let entries = recent_projects::get_recent_projects(None, Some(5), fs, &db).await;
            this.update_in(cx, |this, _window, cx| {
                this.recent_projects = entries;
                cx.notify();
            })
            .ok();
        })
    }

    fn pick_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            this.update_in(cx, |this, _window, cx| {
                this.selected_folder = Some(folder);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() {
            return;
        }

        let folder = match &self.selected_folder {
            Some(f) => f.clone(),
            None => {
                self.pick_folder(window, cx);
                return;
            }
        };

        let project_name = folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Project".to_string());

        self.state = BeginnerState::ActiveProject {
            project_name: SharedString::from(project_name),
        };
        cx.notify();

        let workspace = self.workspace.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            Self::open_folder_and_start_agent(this, workspace, folder, text, cx).await;
        });
        self._tasks.push(task);
    }

    async fn open_folder_and_start_agent(
        this: WeakEntity<Self>,
        workspace: WeakEntity<Workspace>,
        folder: PathBuf,
        text: String,
        cx: &mut AsyncWindowContext,
    ) {
        // Only create the worktree if the project doesn't already have it
        // (e.g. the folder was already opened from the Editor).
        let needs_worktree = cx
            .update(|_, cx| {
                let ws = workspace.upgrade()?;
                let project = ws.read(cx).project().read(cx);
                let already_open = project
                    .visible_worktrees(cx)
                    .any(|wt| wt.read(cx).abs_path().as_ref() == folder.as_path());
                Some(!already_open)
            })
            .ok()
            .flatten()
            .unwrap_or(true);

        if needs_worktree {
            let add_worktree_task = cx
                .update(|_, cx| {
                    let ws = workspace.upgrade()?;
                    let task = ws.update(cx, |workspace, cx| {
                        workspace
                            .project()
                            .update(cx, |project, cx| project.create_worktree(&folder, true, cx))
                    });
                    Some(task)
                })
                .ok()
                .flatten();

            if let Some(task) = add_worktree_task {
                task.await.log_err();
            }
        }

        this.update_in(cx, |bw, window, cx| {
            bw.start_agent_thread(text, window, cx);
        })
        .ok();
    }

    fn start_agent_thread(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let Some(agent_panel) = workspace.read(cx).panel::<AgentPanel>(cx) else {
            return;
        };

        // spawn_beginner_thread returns the ConversationView. The ACP server connects
        // asynchronously, so root_thread() returns None until it's ready. Subscribe and
        // create the feed once the thread actually becomes available.
        let conversation_view = agent_panel.update(cx, |panel, cx| {
            panel.spawn_beginner_thread(text, window, cx)
        });

        let cv_sub = cx.observe(&conversation_view, |this, cv, cx| {
            if this.thread.is_none() {
                if let Some(thread) = cv.read(cx).root_thread(cx) {
                    let thread_sub = cx.subscribe(&thread, |this, _, event, cx| match event {
                        AcpThreadEvent::Stopped(_) | AcpThreadEvent::Error => {
                            this.is_agent_running = false;
                            cx.notify();
                        }
                        _ => {}
                    });
                    this._subscriptions.push(thread_sub);
                    let feed = cx.new(|cx| BeginnerChatFeed::new(thread.clone(), cx));
                    this.chat_feed = Some(feed);
                    this.thread = Some(thread);
                    cx.notify();
                }
            }
        });
        self._subscriptions.push(cv_sub);

        self.is_agent_running = true;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Ask a follow-up...", window, cx);
            editor.set_text("", window, cx);
        });

        let file_panel = cx.new(|cx| FileChangesPanel::new(self.workspace.clone(), cx));
        let file_sub = cx.subscribe(&file_panel, |bw, _, event, cx| {
            bw.handle_file_panel_event(event, cx);
        });
        self._subscriptions.push(file_sub);
        self.file_changes_panel = Some(file_panel);
        cx.notify();
    }

    fn submit_follow_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() || self.is_agent_running {
            return;
        }
        let Some(thread) = self.thread.clone() else {
            return;
        };

        self.chat_editor.update(cx, |editor, cx| {
            editor.set_text("", window, cx);
        });
        self.is_agent_running = true;
        cx.notify();

        cx.spawn(async move |_this, cx| {
            let future = thread.update(cx, |t, cx| t.send(vec![text.as_str().into()], cx));
            future.await.log_err();
        })
        .detach();
    }

    fn handle_file_panel_event(&mut self, event: &FileChangesPanelEvent, cx: &mut Context<Self>) {
        match event {
            FileChangesPanelEvent::OpenInEditor => self.switch_to_editor(cx),
            FileChangesPanelEvent::FileSelected(_path) => {}
        }
    }

    fn switch_to_editor(&mut self, cx: &mut Context<Self>) {
        persist_experience_level(ExperienceLevel::Developer, cx);
        cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
    }

    fn new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state = BeginnerState::Landing;
        self.selected_folder = None;
        self.file_changes_panel = None;
        self.chat_feed = None;
        self.thread = None;
        self.is_agent_running = false;
        // Retain only the project subscription (index 0); clear the rest.
        self._subscriptions.truncate(1);
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Describe your project or idea...", window, cx);
            editor.set_text("", window, cx);
        });
        cx.notify();
    }

    fn open_recent_project(
        &mut self,
        entry: RecentProjectEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = entry.paths.into_iter().next() else {
            return;
        };
        self.selected_folder = Some(path.clone());
        self.state = BeginnerState::ActiveProject {
            project_name: SharedString::from(entry.name.to_string()),
        };
        cx.notify();

        let workspace = self.workspace.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            Self::open_folder_and_start_agent(this, workspace, path, String::new(), cx).await;
        });
        self._tasks.push(task);
    }
}

fn first_visible_worktree_path(project: &Entity<Project>, cx: &App) -> Option<PathBuf> {
    project
        .read(cx)
        .visible_worktrees(cx)
        .filter(|wt| !wt.read(cx).is_single_file())
        .next()
        .map(|wt| wt.read(cx).abs_path().to_path_buf())
}

fn folder_to_state(folder: Option<&PathBuf>) -> BeginnerState {
    match folder {
        Some(p) => BeginnerState::ActiveProject {
            project_name: SharedString::from(
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            ),
        },
        None => BeginnerState::Landing,
    }
}

fn persist_experience_level(level: ExperienceLevel, cx: &mut App) {
    let kvp = KeyValueStore::global(cx);
    let level_str = level.to_str().to_string();
    db::write_and_log(cx, move || async move {
        kvp.write_kvp(EXPERIENCE_LEVEL_KVP_KEY.to_string(), level_str)
            .await
    });
}

impl Focusable for BeginnerWorkspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.state {
            BeginnerState::Landing => self.render_landing(window, cx).into_any_element(),
            BeginnerState::ActiveProject { .. } => {
                self.render_active_project(window, cx).into_any_element()
            }
        }
    }
}

impl BeginnerWorkspace {
    fn render_landing(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let folder_label = self
            .selected_folder
            .as_ref()
            .map(|p| {
                SharedString::from(
                    p.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.to_string_lossy().into_owned()),
                )
            })
            .unwrap_or_else(|| SharedString::from("Choose Folder"));

        let recent_projects = self.recent_projects.clone();
        let chat_editor = self.chat_editor.clone();

        v_flex()
            .key_context("BeginnerLanding")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .items_center()
            .justify_center()
            .gap_8()
            .bg(cx.theme().colors().panel_background)
            .child(
                div().absolute().top_3().right_3().child(
                    IconButton::new("simple-mode-settings", IconName::Settings)
                        .icon_size(IconSize::Small)
                        .tooltip(Tooltip::text("Switch to Expert mode"))
                        .on_click(cx.listener(|_, _, _, cx| {
                            cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
                        })),
                ),
            )
            // Logo + headline
            .child(
                v_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                Icon::new(IconName::Sparkle)
                                    .size(IconSize::Custom(rems(1.75)))
                                    .color(Color::Accent),
                            )
                            .child(Headline::new("Backboard").size(HeadlineSize::XLarge)),
                    )
                    .child(
                        Label::new("What do you want to build today?")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            // Input card
            .child(
                v_flex()
                    .w(px(580.))
                    .gap_2()
                    .rounded_xl()
                    .border_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().editor_background)
                    .p_3()
                    .child(chat_editor)
                    .child(
                        h_flex()
                            .gap_2()
                            .pt_1()
                            .child(
                                Button::new("choose-folder", folder_label)
                                    .style(ButtonStyle::Subtle)
                                    .start_icon(Icon::new(IconName::FolderOpen))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.pick_folder(window, cx);
                                    })),
                            )
                            .child(div().flex_1())
                            .child(
                                Button::new("build", "Build with AI")
                                    .style(ButtonStyle::Filled)
                                    .end_icon(Icon::new(IconName::ArrowRight))
                                    .disabled(draft_is_empty)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.submit(window, cx);
                                    })),
                            ),
                    ),
            )
            // Recent projects
            .when(!recent_projects.is_empty(), |el| {
                el.child(
                    v_flex()
                        .items_center()
                        .gap_3()
                        .child(
                            h_flex()
                                .w(px(580.))
                                .items_center()
                                .gap_2()
                                .child(div().flex_1().h_px().bg(cx.theme().colors().border))
                                .child(
                                    Label::new("Recent")
                                        .size(LabelSize::XSmall)
                                        .color(Color::Muted),
                                )
                                .child(div().flex_1().h_px().bg(cx.theme().colors().border)),
                        )
                        .child(h_flex().gap_2().flex_wrap().max_w(px(580.)).children(
                            recent_projects.into_iter().map(|entry| {
                                let name = entry.name.clone();
                                let entry_for_click = RecentProjectEntry {
                                    name: entry.name.clone(),
                                    full_path: entry.full_path.clone(),
                                    paths: entry.paths.clone(),
                                    workspace_id: entry.workspace_id,
                                    timestamp: entry.timestamp,
                                };
                                h_flex()
                                    .id(SharedString::from(format!("recent-{}", name)))
                                    .px_3()
                                    .py_1p5()
                                    .gap_1p5()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(cx.theme().colors().border)
                                    .bg(cx.theme().colors().surface_background)
                                    .cursor_pointer()
                                    .hover(|el| el.bg(cx.theme().colors().element_hover))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_recent_project(
                                            entry_for_click.clone(),
                                            window,
                                            cx,
                                        );
                                    }))
                                    .child(
                                        Icon::new(IconName::Folder)
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(Label::new(name).size(LabelSize::Small))
                            }),
                        )),
                )
            })
    }

    fn render_active_project(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let project_name = match &self.state {
            BeginnerState::ActiveProject { project_name } => project_name.clone(),
            _ => SharedString::from("Project"),
        };
        let is_running = self.is_agent_running;
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();

        v_flex()
            .size_full()
            .bg(cx.theme().colors().panel_background)
            // Header bar
            .child(
                h_flex()
                    .px_3()
                    .h_8()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().title_bar_background)
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::Sparkle)
                            .size(IconSize::Small)
                            .color(Color::Accent),
                    )
                    .child(
                        Label::new(project_name)
                            .size(LabelSize::Small)
                            .color(Color::Default),
                    )
                    .child(div().flex_1())
                    .child(
                        IconButton::new("new-project", IconName::Plus)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("New project"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_project(window, cx);
                            })),
                    )
                    .child(
                        IconButton::new("simple-mode-settings", IconName::Settings)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("Switch to Expert mode"))
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
                            })),
                    ),
            )
            // Body
            .child(
                h_flex()
                    .flex_1()
                    .overflow_hidden()
                    // Left: file changes panel
                    .when_some(self.file_changes_panel.as_ref(), |el, panel| {
                        el.child(panel.clone())
                    })
                    // Right: chat feed + follow-up input
                    .child(
                        v_flex()
                            .flex_1()
                            .h_full()
                            .overflow_hidden()
                            .bg(cx.theme().colors().panel_background)
                            // Chat feed
                            .when_some(self.chat_feed.as_ref(), |el, feed| {
                                el.child(feed.clone())
                            })
                            .when(self.chat_feed.is_none(), |el| {
                                el.child(
                                    v_flex()
                                        .flex_1()
                                        .items_center()
                                        .justify_center()
                                        .gap_2()
                                        .pb(rems_from_px(48.))
                                        .child(
                                            Icon::new(IconName::Sparkle)
                                                .size(IconSize::XLarge)
                                                .color(Color::Accent),
                                        )
                                        .child(
                                            Label::new("What do you want to build?")
                                                .size(LabelSize::Default)
                                                .color(Color::Default),
                                        )
                                        .child(
                                            Label::new("Describe it below and Backboard will start building.")
                                                .size(LabelSize::Small)
                                                .color(Color::Muted),
                                        ),
                                )
                            })
                            // Follow-up input
                            .child(self.render_input_bar(is_running, draft_is_empty, window, cx)),
                    ),
            )
    }

    fn render_input_bar(
        &self,
        is_running: bool,
        draft_is_empty: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .border_t_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().panel_background)
            .px_3()
            .pt_2()
            .pb_3()
            .gap_2()
            .child(
                v_flex()
                    .w_full()
                    .rounded_xl()
                    .border_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().editor_background)
                    .px_3()
                    .py_2()
                    .child(self.chat_editor.clone()),
            )
            .child(
                h_flex().justify_end().child(
                    Button::new(
                        "send-follow-up",
                        if is_running { "Running…" } else { "Send" },
                    )
                    .style(ButtonStyle::Filled)
                    .end_icon(Icon::new(IconName::ArrowRight))
                    .disabled(is_running || draft_is_empty)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.submit_follow_up(window, cx);
                    })),
                ),
            )
    }
}
