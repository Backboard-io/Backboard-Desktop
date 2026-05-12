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
use recent_projects::RecentProjectEntry;
use ui::{Button, ButtonStyle, Color, Divider, Icon, IconName, Label, LabelSize, Tooltip, prelude::*};
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

        Self {
            workspace,
            multi_workspace,
            focus_handle: cx.focus_handle(),
            state: BeginnerState::Landing,
            chat_editor,
            selected_folder: None,
            thread: None,
            is_agent_running: false,
            chat_feed: None,
            file_changes_panel: None,
            recent_projects: Vec::new(),
            _tasks: vec![load_recent],
            _subscriptions: Vec::new(),
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

        // spawn_beginner_thread creates the ACP thread directly and returns the entity
        // without touching the panel's active view — the sidebar never opens or focuses.
        let thread = agent_panel.update(cx, |panel, cx| {
            panel.spawn_beginner_thread(text, window, cx)
        });

        if let Some(thread) = thread {
            let thread_sub = cx.subscribe(&thread, |this, _, event, cx| {
                match event {
                    AcpThreadEvent::Stopped(_) | AcpThreadEvent::Error => {
                        this.is_agent_running = false;
                        cx.notify();
                    }
                    _ => {}
                }
            });
            self._subscriptions.push(thread_sub);
            let feed = cx.new(|cx| BeginnerChatFeed::new(thread.clone(), cx));
            self.chat_feed = Some(feed);
            self.thread = Some(thread);
        }

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
        self._subscriptions.clear();
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
            let add_worktree_task = cx
                .update(|_, cx| {
                    let ws = workspace.upgrade()?;
                    let task = ws.update(cx, |workspace, cx| {
                        workspace
                            .project()
                            .update(cx, |project, cx| project.create_worktree(&path, true, cx))
                    });
                    Some(task)
                })
                .ok()
                .flatten();

            if let Some(task) = add_worktree_task {
                task.await.log_err();
            }

            this.update_in(cx, |bw, window, cx| {
                bw.start_agent_thread(String::new(), window, cx);
            })
            .ok();
        });
        self._tasks.push(task);
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
                self.render_active_project(cx).into_any_element()
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
            .size_full()
            .items_center()
            .justify_center()
            .gap_6()
            .bg(cx.theme().colors().background)
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Backboard Studio")
                            .size(LabelSize::Large)
                            .color(Color::Default),
                    )
                    .child(
                        Label::new("What do you want to build?")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(
                v_flex()
                    .w(px(560.))
                    .gap_3()
                    .child(
                        div()
                            .w_full()
                            .rounded_lg()
                            .border_1()
                            .border_color(cx.theme().colors().border)
                            .bg(cx.theme().colors().editor_background)
                            .p_3()
                            .child(chat_editor),
                    )
                    .child(
                        h_flex()
                            .gap_2()
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
            .when(!recent_projects.is_empty(), |el| {
                el.child(Divider::horizontal_dashed())
                    .child(
                        Label::new("Recent Projects")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .flex_wrap()
                            .max_w(px(600.))
                            .children(recent_projects.into_iter().map(|entry| {
                                let name = entry.name.clone();
                                let entry_for_click = RecentProjectEntry {
                                    name: entry.name.clone(),
                                    full_path: entry.full_path.clone(),
                                    paths: entry.paths.clone(),
                                    workspace_id: entry.workspace_id,
                                    timestamp: entry.timestamp,
                                };
                                div()
                                    .id(SharedString::from(format!("recent-{}", name)))
                                    .px_4()
                                    .py_2()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(cx.theme().colors().border)
                                    .bg(cx.theme().colors().surface_background)
                                    .cursor_pointer()
                                    .hover(|el| el.bg(cx.theme().colors().element_hover))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_recent_project(entry_for_click.clone(), window, cx);
                                    }))
                                    .child(Label::new(name).size(LabelSize::Small))
                            })),
                    )
            })
    }

    fn render_active_project(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let project_name = match &self.state {
            BeginnerState::ActiveProject { project_name } => project_name.clone(),
            _ => SharedString::from("Project"),
        };
        let is_running = self.is_agent_running;
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();

        v_flex()
            .size_full()
            .bg(cx.theme().colors().background)
            // Header bar
            .child(
                h_flex()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().title_bar_background)
                    .gap_2()
                    .child(Label::new(project_name).size(LabelSize::Small).color(Color::Default))
                    .child(div().flex_1())
                    .child(
                        Button::new("new-project", "New Project")
                            .style(ButtonStyle::Subtle)
                            .start_icon(Icon::new(IconName::Plus))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_project(window, cx);
                            })),
                    )
                    .child(
                        Button::new("open-editor", "Open Editor")
                            .style(ButtonStyle::Subtle)
                            .end_icon(Icon::new(IconName::ArrowRight))
                            .tooltip(Tooltip::text("Switch to the full code editor"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.switch_to_editor(cx);
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
                            // Chat feed
                            .when_some(self.chat_feed.as_ref(), |el, feed| {
                                el.child(feed.clone())
                            })
                            .when(self.chat_feed.is_none(), |el| {
                                el.child(
                                    div()
                                        .flex_1()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(
                                            Label::new("Starting up...")
                                                .size(LabelSize::Small)
                                                .color(Color::Muted),
                                        ),
                                )
                            })
                            // Follow-up input
                            .child(
                                v_flex()
                                    .border_t_1()
                                    .border_color(cx.theme().colors().border)
                                    .bg(cx.theme().colors().surface_background)
                                    .p_3()
                                    .gap_2()
                                    .child(
                                        div()
                                            .w_full()
                                            .rounded_lg()
                                            .border_1()
                                            .border_color(cx.theme().colors().border)
                                            .bg(cx.theme().colors().editor_background)
                                            .p_3()
                                            .child(self.chat_editor.clone()),
                                    )
                                    .child(
                                        h_flex()
                                            .justify_end()
                                            .child(
                                                Button::new("send-follow-up", "Send")
                                                    .style(ButtonStyle::Filled)
                                                    .end_icon(Icon::new(IconName::ArrowRight))
                                                    .disabled(is_running || draft_is_empty)
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.submit_follow_up(window, cx);
                                                    })),
                                            ),
                                    ),
                            ),
                    ),
            )
    }
}
