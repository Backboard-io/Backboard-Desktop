use std::path::PathBuf;

use acp_thread::{AcpThread, AcpThreadEvent, SelectedPermissionOutcome, ToolCallStatus};
use agent_client_protocol::schema as acp;
use agent_ui::{AgentPanel, ConversationView};
use db::kvp::KeyValueStore;
use editor::Editor;
use gpui::{
    App, AsyncWindowContext, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement,
    PathPromptOptions, Render, SharedString, Subscription, Task, WeakEntity, Window,
    WindowControlArea, canvas,
};
use onboarding::{EXPERIENCE_LEVEL_KVP_KEY, ExperienceLevel};
use project::Project;
use recent_projects::RecentProjectEntry;
use ui::{
    Button, ButtonStyle, Color, Headline, HeadlineSize, Icon, IconButton, IconName, IconSize,
    Label, LabelSize, Tooltip, prelude::*, utils::platform_title_bar_height,
};
use util::ResultExt;
use workspace::{MultiWorkspace, PathList, Workspace, WorkspaceDb};

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

#[derive(Clone, Copy, PartialEq)]
enum LeftTab {
    Files,
    Changes,
}

enum RightPanel {
    Preview,
    CodeView {
        title: SharedString,
        content: SharedString,
    },
}

struct ProjectSession {
    state: BeginnerState,
    chat_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    pending_conversation_view: Option<Entity<ConversationView>>,
    active_conversation_view: Option<Entity<ConversationView>>,
    is_agent_running: bool,
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    right_panel: RightPanel,
    preview_url: Option<String>,
    web_preview: Option<crate::web_preview::WebPreview>,
    subscriptions: Vec<Subscription>,
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
    // Kept alive for the entire session lifetime. The ConversationView owns the
    // ThreadView which owns the send task — dropping it cancels in-flight sends.
    // "pending" while connecting; remains alive after connected to keep ThreadView alive.
    pending_conversation_view: Option<Entity<ConversationView>>,
    // Kept alive after connection so that ThreadView (and its send tasks) are not dropped.
    active_conversation_view: Option<Entity<ConversationView>>,
    is_agent_running: bool,
    // Set when agent finishes so approve/revert actions are shown.
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    right_panel: RightPanel,
    // URL of the running dev server once it's ready.
    preview_url: Option<String>,
    // Embedded web preview. Created lazily in render() once we have both a
    // preview_url and the Window handle. None on Linux (unsupported).
    web_preview: Option<crate::web_preview::WebPreview>,
    background_sessions: Vec<ProjectSession>,
    recent_projects: Vec<RecentProjectEntry>,
    _tasks: Vec<Task<()>>,
    _project_subscription: Subscription,
    session_subscriptions: Vec<Subscription>,
}

impl BeginnerWorkspace {
    fn make_chat_editor(window: &mut Window, cx: &mut Context<Self>, placeholder: &str) -> Entity<Editor> {
        cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 8, window, cx);
            editor.set_placeholder_text(placeholder, window, cx);
            editor
        })
    }

    fn current_tab_title(&self) -> SharedString {
        match &self.state {
            BeginnerState::ActiveProject { project_name } => project_name.clone(),
            BeginnerState::Landing => SharedString::from("New Project"),
        }
    }

    fn stash_current_session_and_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let replacement_editor = Self::make_chat_editor(window, cx, "Describe your project or idea...");
        let session = ProjectSession {
            state: std::mem::replace(&mut self.state, BeginnerState::Landing),
            chat_editor: std::mem::replace(&mut self.chat_editor, replacement_editor),
            selected_folder: self.selected_folder.take(),
            thread: self.thread.take(),
            pending_conversation_view: self.pending_conversation_view.take(),
            active_conversation_view: self.active_conversation_view.take(),
            is_agent_running: std::mem::replace(&mut self.is_agent_running, false),
            agent_finished: std::mem::replace(&mut self.agent_finished, false),
            chat_feed: self.chat_feed.take(),
            file_changes_panel: self.file_changes_panel.take(),
            left_tab: std::mem::replace(&mut self.left_tab, LeftTab::Files),
            show_raw_files: std::mem::replace(&mut self.show_raw_files, false),
            right_panel: std::mem::replace(&mut self.right_panel, RightPanel::Preview),
            preview_url: self.preview_url.take(),
            // Drop the live webview — only the active session may hold one.
            // The preview_url is preserved so it can be recreated on switch-back.
            web_preview: None,
            subscriptions: std::mem::take(&mut self.session_subscriptions),
        };
        self.background_sessions.push(session);
        cx.notify();
    }

    fn switch_to_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.background_sessions.len() {
            return;
        }
        let session = &mut self.background_sessions[ix];
        std::mem::swap(&mut self.state, &mut session.state);
        std::mem::swap(&mut self.chat_editor, &mut session.chat_editor);
        std::mem::swap(&mut self.selected_folder, &mut session.selected_folder);
        std::mem::swap(&mut self.thread, &mut session.thread);
        std::mem::swap(
            &mut self.pending_conversation_view,
            &mut session.pending_conversation_view,
        );
        std::mem::swap(
            &mut self.active_conversation_view,
            &mut session.active_conversation_view,
        );
        std::mem::swap(&mut self.is_agent_running, &mut session.is_agent_running);
        std::mem::swap(&mut self.agent_finished, &mut session.agent_finished);
        std::mem::swap(&mut self.chat_feed, &mut session.chat_feed);
        std::mem::swap(&mut self.file_changes_panel, &mut session.file_changes_panel);
        std::mem::swap(&mut self.left_tab, &mut session.left_tab);
        std::mem::swap(&mut self.show_raw_files, &mut session.show_raw_files);
        std::mem::swap(&mut self.right_panel, &mut session.right_panel);
        std::mem::swap(&mut self.preview_url, &mut session.preview_url);
        // Drop the active webview — background sessions never hold a live one.
        // render() will recreate it from preview_url for the new active session.
        self.web_preview = None;
        std::mem::swap(&mut self.session_subscriptions, &mut session.subscriptions);
        cx.notify();
    }

    pub fn new(
        workspace: WeakEntity<Workspace>,
        multi_workspace: WeakEntity<MultiWorkspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let chat_editor = Self::make_chat_editor(window, cx, "Describe your project or idea...");

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
            pending_conversation_view: None,
            active_conversation_view: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            right_panel: RightPanel::Preview,
            preview_url: None,
            web_preview: None,
            background_sessions: Vec::new(),
            recent_projects: Vec::new(),
            _tasks: vec![load_recent],
            _project_subscription: project_sub,
            session_subscriptions: Vec::new(),
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
                self.pending_conversation_view = None;
                self.active_conversation_view = None;
                self.file_changes_panel = None;
                self.is_agent_running = false;
                self.preview_url = None;
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
        // Start the agent immediately for faster perceived response.
        this.update_in(cx, |bw, window, cx| {
            bw.start_agent_thread(text, window, cx);
        })
        .ok();

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

    }

    fn start_agent_thread(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let Some(agent_panel) = workspace.read(cx).panel::<AgentPanel>(cx) else {
            return;
        };

        let work_dirs = self
            .selected_folder
            .as_ref()
            .map(|folder| PathList::new(&[folder.clone()]));

        // spawn_beginner_thread returns the ConversationView. The ACP server connects
        // asynchronously, so root_thread() returns None until it's ready. Subscribe and
        // create the feed once the thread actually becomes available.
        let conversation_view = agent_panel.update(cx, |panel, cx| {
            panel.spawn_beginner_thread(text, work_dirs, window, cx)
        });

        // Store the entity to keep it alive until the ACP server connects.
        // Without this strong reference the ConversationView would be dropped
        // before root_thread() ever returns Some.
        self.pending_conversation_view = Some(conversation_view.clone());

        let cv_sub = cx.observe(&conversation_view, |this, cv, cx| {
            let (is_loading, root_thread) = {
                let cv_ref = cv.read(cx);
                (cv_ref.is_loading(), cv_ref.root_thread(cx))
            };

            if this.thread.is_none() {
                if let Some(thread) = root_thread {
                    let thread_sub = cx.subscribe(&thread, |this, thread_entity, event, cx| {
                        match event {
                            AcpThreadEvent::Stopped(_) => {
                                this.is_agent_running = false;
                                this.agent_finished = true;
                                this.open_web_app_if_present(cx);
                                cx.notify();
                            }

                            AcpThreadEvent::Error => {
                                this.is_agent_running = false;
                                this.agent_finished = false;
                                cx.notify();
                            }
                            AcpThreadEvent::ToolAuthorizationRequested(tool_call_id) => {
                                // Auto-accept all tool calls in beginner mode so the agent
                                // is never blocked waiting for a confirmation the user cannot
                                // see from the chat UI.
                                let outcome = thread_entity.read(cx)
                                    .tool_call(tool_call_id)
                                    .and_then(|(_, call)| {
                                        if let ToolCallStatus::WaitingForConfirmation { options, .. } = &call.status {
                                            let option = options.first_option_of_kind(
                                                acp::PermissionOptionKind::AllowOnce,
                                            )?;
                                            Some(SelectedPermissionOutcome::new(
                                                option.option_id.clone(),
                                                option.kind,
                                            ))
                                        } else {
                                            None
                                        }
                                    });
                                if let Some(outcome) = outcome {
                                    let id = tool_call_id.clone();
                                    thread_entity.update(cx, |t, cx| {
                                        t.authorize_tool_call(id, outcome, cx);
                                    });
                                }
                            }
                            _ => {}
                        }
                    });
                    this.session_subscriptions.push(thread_sub);
                    let feed = cx.new(|cx| BeginnerChatFeed::new(thread.clone(), cx));
                    this.chat_feed = Some(feed);
                    let file_panel = cx.new(|cx| FileChangesPanel::new(thread.clone(), cx));
                    let file_sub = cx.subscribe(&file_panel, |bw, _, event, cx| {
                        bw.handle_file_panel_event(event, cx);
                    });
                    this.session_subscriptions.push(file_sub);
                    this.file_changes_panel = Some(file_panel);
                    this.thread = Some(thread);
                    // Move CV from pending → active so the ConversationView (and the
                    // ThreadView it owns) stays alive while the agent is running.
                    // Dropping it here would cancel the in-flight send task.
                    this.active_conversation_view = this.pending_conversation_view.take();
                    cx.notify();
                } else if !is_loading {
                    this.is_agent_running = false;
                    this.pending_conversation_view = None;
                    this.active_conversation_view = None;
                    cx.notify();
                }
            }
        });
        self.session_subscriptions.push(cv_sub);

        self.is_agent_running = true;
        self.agent_finished = false;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Ask a follow-up...", window, cx);
            editor.set_text("", window, cx);
        });
        cx.notify();
    }

    fn submit_follow_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // If no agent thread has started yet (e.g. app launched with a project
        // already open), treat this as the initial submission.
        if self.thread.is_none() {
            self.submit(window, cx);
            return;
        }

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
        // Drop the webview so the layout reverts to chat-dominant while building.
        self.web_preview = None;
        self.preview_url = None;
        self.is_agent_running = true;
        cx.notify();

        cx.spawn(async move |_this, cx| {
            let future = thread.update(cx, |t, cx| t.send(vec![text.as_str().into()], cx));
            future.await.log_err();
        })
        .detach();
    }

    fn handle_file_panel_event(&mut self, event: &FileChangesPanelEvent, _cx: &mut Context<Self>) {
        match event {
            FileChangesPanelEvent::FileSelected(path) => {
                self.open_file_read_only(path.as_path());
            }
        }
    }

    fn open_file_read_only(&mut self, path: &std::path::Path) {
        let title = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let content = std::fs::read_to_string(path)
            .unwrap_or_else(|_| "Unable to read this file as text.".to_string());
        self.right_panel = RightPanel::CodeView {
            title: SharedString::from(title),
            content: SharedString::from(content),
        };
    }

    fn cancel_running_task(&mut self, cx: &mut Context<Self>) {
        let Some(thread) = self.thread.clone() else {
            return;
        };
        let task = thread.update(cx, |t, cx| t.cancel(cx));
        self._tasks.push(cx.spawn(async move |_this, _cx| {
            task.await;
        }));
        self.is_agent_running = false;
        self.agent_finished = true;
        cx.notify();
    }

    fn approve_changes(&mut self, cx: &mut Context<Self>) {
        self.agent_finished = false;
        cx.notify();
    }

    fn revert_changes(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.selected_folder.clone() else {
            return;
        };
        let task = cx.spawn(async move |_this, _cx| {
            let _ = std::process::Command::new("git")
                .arg("-C")
                .arg(&folder)
                .arg("restore")
                .arg("--staged")
                .arg("--worktree")
                .arg(".")
                .output();
        });
        self._tasks.push(task);
        self.agent_finished = false;
        cx.notify();
    }

    fn apply_suggested_prompt(
        &mut self,
        prompt: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_text(prompt, window, cx);
        });
        cx.notify();
    }

    #[allow(dead_code)]
    pub fn switch_to_editor(&mut self, cx: &mut Context<Self>) {
        persist_experience_level(ExperienceLevel::Developer, cx);
        cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
    }

    fn open_project_in_finder(&self, cx: &mut App) {
        if let Some(folder) = &self.selected_folder {
            let url = format!("file://{}", folder.display());
            cx.open_url(&url);
        }
    }

    fn open_web_app_if_present(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.selected_folder.clone() else {
            return;
        };

        // Search the root and one level of subdirectories for a runnable project.
        // Agents often create a subdirectory (e.g. `my-folder/tree-site/`) rather
        // than placing files directly in the selected root.
        let mut candidates: Vec<PathBuf> = vec![root.clone()];
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if path.is_dir() && name != "node_modules" && name != "target" && !name.starts_with('.') {
                    candidates.push(path);
                }
            }
        }

        for candidate in &candidates {
            let package_json = candidate.join("package.json");
            if package_json.exists() {
                if let Ok(content) = std::fs::read_to_string(&package_json) {
                    if content.contains("\"dev\"") {
                        self.start_dev_server(candidate.clone(), cx);
                        return;
                    }
                }
            }
        }

        // Static HTML fallback — show in the embedded preview panel.
        for candidate in &candidates {
            let index = candidate.join("index.html");
            if index.exists() {
                self.web_preview = None;
                self.preview_url = Some(format!("file://{}", index.display()));
                cx.notify();
                return;
            }
        }
    }

    fn start_dev_server(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        let task = cx.spawn(async move |this, cx| {
            const PORT: u16 = 3000;

            // Kill anything already listening on the port so the new server
            // always gets a clean start. Works on macOS and Linux; no-op on Windows.
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                std::process::Command::new("sh")
                    .arg("-c")
                    .arg(format!("lsof -ti :{PORT} | xargs kill -9 2>/dev/null; true"))
                    .status()
                    .ok();
                // Give the OS a moment to reclaim the port.
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(400))
                    .await;
            }

            let port_arg = format!("--port={PORT}");
            let spawned = std::process::Command::new("npm")
                .arg("run")
                .arg("dev")
                .arg("--")
                .arg(port_arg)
                .env("PORT", PORT.to_string())
                .current_dir(&folder)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok();

            if !spawned {
                return;
            }

            let port = PORT;

            // Poll selected localhost port until it responds (up to 20 s).
            for _ in 0..40 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(500))
                    .await;
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    let url = format!("http://localhost:{port}");
                    this.update(cx, |this, cx| {
                        // Drop the old webview so render() creates a fresh one
                        // pointing at the new server — even if the port number
                        // is the same as a previous project.
                        this.web_preview = None;
                        this.preview_url = Some(url);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            }
        });
        self._tasks.push(task);
    }

    #[allow(dead_code)]
    fn new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state = BeginnerState::Landing;
        self.selected_folder = None;
        self.file_changes_panel = None;
        self.chat_feed = None;
        self.thread = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.show_raw_files = false;
        self.right_panel = RightPanel::Preview;
        self.preview_url = None;
        self.web_preview = None;
        self.session_subscriptions.clear();
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
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Ask a follow-up...", window, cx);
        });
        cx.notify();

        // Only add the worktree; the agent starts when the user sends a message.
        let workspace = self.workspace.clone();
        let task = cx.spawn_in(window, async move |_this, cx| {
            let needs_worktree = cx
                .update(|_, cx| {
                    let ws = workspace.upgrade()?;
                    let project = ws.read(cx).project().read(cx);
                    let already_open = project
                        .visible_worktrees(cx)
                        .any(|wt| wt.read(cx).abs_path().as_ref() == path.as_path());
                    Some(!already_open)
                })
                .ok()
                .flatten()
                .unwrap_or(true);

            if needs_worktree {
                let add_task = cx
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
                if let Some(task) = add_task {
                    task.await.log_err();
                }
            }
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

#[allow(dead_code)]
fn persist_experience_level(level: ExperienceLevel, cx: &mut App) {
    let kvp = KeyValueStore::global(cx);
    let level_str = level.to_str().to_string();
    db::write_and_log(cx, move || async move {
        kvp.write_kvp(EXPERIENCE_LEVEL_KVP_KEY.to_string(), level_str)
            .await
    });
}

fn tab_button(
    label: &'static str,
    active: bool,
    cx: &Context<BeginnerWorkspace>,
) -> gpui::Stateful<Div> {
    div()
        .id(label)
        .flex_1()
        .py_2()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .when(active, |el| el.bg(cx.theme().colors().element_selected))
        .hover(|el| el.bg(cx.theme().colors().element_hover))
        .child(
            Label::new(label)
                .size(LabelSize::Small)
                .color(if active { Color::Default } else { Color::Muted }),
        )
}

fn project_file_sections(folder: &PathBuf) -> Vec<(String, PathBuf, bool)> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };

    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            dirs.push((name, path));
        } else {
            files.push((name, path));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut entries: Vec<(String, PathBuf, bool)> = Vec::new();

    for (name, path) in dirs {
        entries.push((name, path, true));
    }

    for (name, path) in files {
        entries.push((name, path, false));
    }

    entries
}

impl Focusable for BeginnerWorkspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Lazily create the embedded web preview the first time we have a preview URL
        // and the Window handle. Returns None on unsupported platforms (Linux/Wayland).
        if self.preview_url.is_some() && self.web_preview.is_none() {
            if let Some(url) = self.preview_url.clone() {
                self.web_preview = crate::web_preview::WebPreview::new(window, &url);
            }
        }

        // If the URL changed after the view was already created, navigate it.
        if let (Some(preview), Some(url)) = (&mut self.web_preview, &self.preview_url) {
            preview.load_url(url);
        }

        match &self.state {
            BeginnerState::Landing => self.render_landing(window, cx).into_any_element(),
            BeginnerState::ActiveProject { .. } => {
                self.render_active_project(window, cx).into_any_element()
            }
        }
    }
}

impl BeginnerWorkspace {
    fn render_landing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        let header_height = platform_title_bar_height(window);
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let suggested_prompts = [
            "Build a clean landing page with pricing and FAQ.",
            "Create a contact form with validation and success state.",
            "Add dark mode toggle and save preference.",
        ];
        let background_titles: Vec<SharedString> = self
            .background_sessions
            .iter()
            .map(|s| match &s.state {
                BeginnerState::ActiveProject { project_name } => project_name.clone(),
                BeginnerState::Landing => SharedString::from("New Project"),
            })
            .collect();

        v_flex()
            .key_context("BeginnerLanding")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(cx.theme().colors().panel_background)
            // Drag strip that holds the traffic lights and the settings button.
            .child(
                h_flex()
                    .h(header_height)
                    .w_full()
                    .flex_shrink_0()
                    .window_control_area(WindowControlArea::Drag)
                    .when(traffic_lights, |this| {
                        this.pl(px(ui::utils::TRAFFIC_LIGHT_PADDING))
                    })
                    .justify_end()
                    .items_center()
                    .pr_2()
                    .child(
                        IconButton::new("new-project-tab", IconName::Plus)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("New project tab"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.stash_current_session_and_reset(window, cx);
                            })),
                    ),
            )
            .when(!background_titles.is_empty(), |el| {
                el.child(
                    h_flex()
                        .px_2()
                        .py_1()
                        .gap_1()
                        .border_b_1()
                        .border_color(cx.theme().colors().border)
                        .children(background_titles.into_iter().enumerate().map(|(ix, title)| {
                            Button::new(SharedString::from(format!("landing-bg-tab-{ix}")), title)
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.switch_to_session(ix, cx);
                                }))
                        })),
                )
            })
            // Centered content
            .child(
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_8()
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
                    .child(
                        h_flex()
                            .w(px(580.))
                            .gap_2()
                            .flex_wrap()
                            .children(suggested_prompts.into_iter().map(|prompt| {
                                Button::new(SharedString::from(prompt), SharedString::from(prompt))
                                    .style(ButtonStyle::Subtle)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.apply_suggested_prompt(prompt, window, cx);
                                    }))
                            })),
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
                    }),
            )
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
        let is_connecting = self.pending_conversation_view.is_some();
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let header_height = platform_title_bar_height(window);
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let left_tab = self.left_tab;
        let preview_url = self.preview_url.clone();
        let active_title = self.current_tab_title();
        // When the preview is live and nothing is running, let it take most of
        // the space. When the agent is building, chat takes priority.
        let preview_dominant = self.web_preview.is_some() && !is_running;
        let background_titles: Vec<SharedString> = self
            .background_sessions
            .iter()
            .map(|s| match &s.state {
                BeginnerState::ActiveProject { project_name } => project_name.clone(),
                BeginnerState::Landing => SharedString::from("New Project"),
            })
            .collect();

        v_flex()
            .size_full()
            .bg(cx.theme().colors().panel_background)
            // Title bar
            .child(
                h_flex()
                    .px_3()
                    .h(header_height)
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().title_bar_background)
                    .window_control_area(WindowControlArea::Drag)
                    .when(traffic_lights, |this| {
                        this.pl(px(ui::utils::TRAFFIC_LIGHT_PADDING))
                    })
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
                        IconButton::new("open-in-finder", IconName::FolderOpen)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("Open folder in Finder"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open_project_in_finder(cx);
                            })),
                    )
                    .child(
                        IconButton::new("new-project", IconName::Plus)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .tooltip(Tooltip::text("New project"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.stash_current_session_and_reset(window, cx);
                            })),
                    ),
            )
            .when(!background_titles.is_empty(), |el| {
                el.child(
                    h_flex()
                        .px_2()
                        .py_1()
                        .gap_1()
                        .border_b_1()
                        .border_color(cx.theme().colors().border)
                        .child(
                            Button::new("active-tab", active_title)
                                .style(ButtonStyle::Filled),
                        )
                        .children(background_titles.into_iter().enumerate().map(|(ix, title)| {
                            Button::new(SharedString::from(format!("bg-tab-{ix}")), title)
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.switch_to_session(ix, cx);
                                }))
                        })),
                )
            })
            // 3-column body
            .child(
                h_flex()
                    .flex_1()
                    .overflow_hidden()
                    // ── Left panel: project nav ──────────────────────────────
                    .child(self.render_left_panel(left_tab, cx))
                    // ── Centre: chat activity + input ────────────────────────
                    .child(
                        v_flex()
                            .when(preview_dominant, |el| el.w(px(340.)).flex_shrink_0())
                            .when(!preview_dominant, |el| el.flex_1().min_w(px(320.)))
                            .h_full()
                            .overflow_hidden()
                            .border_x_1()
                            .border_color(cx.theme().colors().border)
                            .bg(cx.theme().colors().panel_background)
                            .when_some(self.chat_feed.as_ref(), |el, feed| {
                                el.child(feed.clone())
                            })
                            .when(self.chat_feed.is_none(), |el| {
                                let (headline, subtext) = if is_connecting {
                                    ("Connecting to Backboard...", "Your agent is starting up.")
                                } else {
                                    (
                                        "What do you want to build?",
                                        "Describe it below and Backboard will start building.",
                                    )
                                };
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
                                            Label::new(headline)
                                                .size(LabelSize::Default)
                                                .color(Color::Default),
                                        )
                                        .child(
                                            Label::new(subtext)
                                                .size(LabelSize::Small)
                                                .color(Color::Muted),
                                        ),
                                )
                            })
                            .when(is_running || is_connecting, |el| {
                                let status = if is_connecting {
                                    "Starting your task..."
                                } else {
                                    "Working on your request..."
                                };
                                el.child(
                                    h_flex()
                                        .px_3()
                                        .py_1()
                                        .child(
                                            Label::new(status)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Muted),
                                        ),
                                )
                            })
                            .child(self.render_input_bar(
                                is_running,
                                is_connecting,
                                draft_is_empty,
                                window,
                                cx,
                            )),
                    )
                    // ── Right panel: preview ─────────────────────────────────
                    .child(self.render_right_panel(is_running, preview_url, preview_dominant, cx)),
            )
    }

    fn render_left_panel(
        &mut self,
        active_tab: LeftTab,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let has_project = self.selected_folder.is_some();

        v_flex()
            .w(px(220.))
            .h_full()
            .flex_shrink_0()
            .bg(cx.theme().colors().surface_background)
            // Tab strip
            .child(
                h_flex()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .child(
                        tab_button("Files", active_tab == LeftTab::Files, cx)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.left_tab = LeftTab::Files;
                                cx.notify();
                            })),
                    )
                    .child(
                        tab_button("Changes", active_tab == LeftTab::Changes, cx)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.left_tab = LeftTab::Changes;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                h_flex()
                    .px_2()
                    .py_1p5()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .justify_between()
                    .items_center()
                    .child(
                        Label::new(if self.show_raw_files {
                            "Raw Files"
                        } else {
                            "Simple Categories"
                        })
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                    )
                    .child(
                        Button::new(
                            "toggle-raw-files",
                            if self.show_raw_files {
                                "Simple View"
                            } else {
                                "Raw View"
                            },
                        )
                        .style(ButtonStyle::Subtle)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_raw_files = !this.show_raw_files;
                            cx.notify();
                        })),
                    ),
            )
            // Tab body
            .child(if active_tab == LeftTab::Files {
                v_flex()
                    .id("files-tab-body")
                    .flex_1()
                    .overflow_y_scroll()
                    .p_2()
                    .gap_0p5()
                    .when(!has_project, |el| {
                        el.child(
                            div()
                                .flex_1()
                                .flex()
                                .items_center()
                                .justify_center()
                                .p_4()
                                .child(
                                    Label::new("No project open")
                                        .size(LabelSize::Small)
                                        .color(Color::Disabled),
                                ),
                        )
                    })
                    .when_some(self.selected_folder.as_ref(), |el, folder| {
                        if self.show_raw_files {
                            el.children(project_file_sections(folder).into_iter().map(
                                |(name, path, is_dir)| {
                                    h_flex()
                                        .id(SharedString::from(format!(
                                            "raw-file-{}",
                                            path.to_string_lossy()
                                        )))
                                        .px_2()
                                        .py_1()
                                        .gap_1p5()
                                        .rounded_md()
                                        .when(!is_dir, |row| row.cursor_pointer())
                                        .hover(|row| row.bg(cx.theme().colors().element_hover))
                                        .when(!is_dir, |row| {
                                            row.on_click(cx.listener(move |this, _, _, cx| {
                                                this.open_file_read_only(path.as_path());
                                                cx.notify();
                                            }))
                                        })
                                        .child(
                                            Icon::new(if is_dir {
                                                IconName::Folder
                                            } else {
                                                IconName::File
                                            })
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                        )
                                        .child(
                                            Label::new(SharedString::from(name))
                                                .size(LabelSize::Small)
                                                .color(if is_dir {
                                                    Color::Default
                                                } else {
                                                    Color::Muted
                                                }),
                                        )
                                },
                            ))
                        } else {
                            let categories = [
                                "Pages",
                                "Components",
                                "Styles",
                                "Assets",
                                "Forms",
                                "Settings",
                            ];
                            el.children(categories.into_iter().map(|category| {
                                h_flex()
                                    .px_2()
                                    .py_1()
                                    .gap_1p5()
                                    .rounded_md()
                                    .child(
                                        Icon::new(IconName::Folder)
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(Label::new(category).size(LabelSize::Small))
                            }))
                        }
                    })
                    .into_any_element()
            } else {
                v_flex()
                    .flex_1()
                    .overflow_hidden()
                    .when_some(self.file_changes_panel.as_ref(), |el, panel| {
                        el.child(
                            div()
                                .flex_1()
                                .overflow_hidden()
                                .child(panel.clone()),
                        )
                    })
                    .when(self.file_changes_panel.is_none(), |el| {
                        el.child(
                            div()
                                .flex_1()
                                .flex()
                                .items_center()
                                .justify_center()
                                .p_4()
                                .child(
                                    Label::new("No changes yet")
                                        .size(LabelSize::Small)
                                        .color(Color::Disabled),
                                ),
                        )
                    })
                    .into_any_element()
            })
    }

    fn render_right_panel(
        &self,
        is_running: bool,
        preview_url: Option<String>,
        preview_dominant: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let RightPanel::CodeView { title, content } = &self.right_panel {
            return v_flex()
                .w(px(420.))
                .h_full()
                .flex_shrink_0()
                .bg(cx.theme().colors().surface_background)
                .child(
                    h_flex()
                        .px_3()
                        .py_2()
                        .border_b_1()
                        .border_color(cx.theme().colors().border)
                        .gap_1p5()
                        .items_center()
                        .child(
                            Icon::new(IconName::File)
                                .size(IconSize::XSmall)
                                .color(Color::Muted),
                        )
                        .child(Label::new(title.clone()).size(LabelSize::Small))
                        .child(div().flex_1())
                        .child(
                            Button::new("back-to-preview", "Back to Preview")
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.right_panel = RightPanel::Preview;
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .overflow_hidden()
                        .p_3()
                        .child(
                            Label::new(content.clone())
                                .size(LabelSize::XSmall)
                                .color(Color::Default),
                        ),
                )
                .into_any_element();
        }

        let has_webview = self.web_preview.is_some();
        let workspace = cx.entity().downgrade();

        v_flex()
            .when(preview_dominant, |el| el.flex_1())
            .when(!preview_dominant, |el| el.w(px(320.)).flex_shrink_0())
            .h_full()
            .bg(cx.theme().colors().surface_background)
            // Header
            .child(
                h_flex()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .gap_1p5()
                    .items_center()
                    .child(
                        Icon::new(IconName::ToolWeb)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Preview")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(div().flex_1())
                    .when_some(preview_url.as_ref(), |el, url| {
                        let url = url.clone();
                        el.child(
                            IconButton::new("open-preview", IconName::ArrowUpRight)
                                .icon_size(IconSize::XSmall)
                                .icon_color(Color::Muted)
                                .tooltip(Tooltip::text("Open in browser"))
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.open_url(&url);
                                })),
                        )
                    }),
            )
            // Body
            .child(if has_webview {
                // Transparent fill element — its bounds in prepaint tell the native WKWebView
                // exactly where to render itself.
                canvas(
                    move |bounds, window, cx| {
                        let viewport_height = f32::from(window.viewport_size().height);
                        if let Some(ws) = workspace.upgrade() {
                            if let Some(preview) = ws.read(cx).web_preview.as_ref() {
                                preview.set_frame(bounds, viewport_height);
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .flex_1()
                .w_full()
                .into_any_element()
            } else if let Some(url) = preview_url {
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .p_4()
                    .child(
                        Icon::new(IconName::ToolWeb)
                            .size(IconSize::Custom(rems(2.)))
                            .color(Color::Accent),
                    )
                    .child(
                        Label::new("Preview ready")
                            .size(LabelSize::Default)
                            .color(Color::Default),
                    )
                    .child(
                        Label::new(SharedString::from(url.clone()))
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Button::new("open-in-browser", "Open in Browser")
                            .style(ButtonStyle::Filled)
                            .end_icon(Icon::new(IconName::ArrowUpRight))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.open_url(&url);
                            })),
                    )
                    .into_any_element()
            } else if is_running {
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .p_4()
                    .child(
                        Icon::new(IconName::Sparkle)
                            .size(IconSize::XLarge)
                            .color(Color::Accent),
                    )
                    .child(
                        Label::new("Building your app…")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .into_any_element()
            } else {
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .p_4()
                    .child(
                        Icon::new(IconName::ToolWeb)
                            .size(IconSize::XLarge)
                            .color(Color::Disabled),
                    )
                    .child(
                        Label::new("Preview will appear here")
                            .size(LabelSize::Small)
                            .color(Color::Disabled),
                    )
                    .child(
                        Label::new("Describe what you want to build")
                            .size(LabelSize::XSmall)
                            .color(Color::Disabled),
                    )
                    .into_any_element()
            })
            .into_any_element()
    }

    fn render_input_bar(
        &self,
        is_running: bool,
        is_connecting: bool,
        draft_is_empty: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let button_label = if is_connecting {
            "Connecting…"
        } else if is_running {
            "Running…"
        } else {
            "Send"
        };
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
                h_flex()
                    .justify_end()
                    .gap_2()
                    .when(is_running, |el| {
                        el.child(
                            Button::new("cancel-task", "Cancel")
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.cancel_running_task(cx);
                                })),
                        )
                    })
                    .child(
                        Button::new("send-follow-up", button_label)
                            .style(ButtonStyle::Filled)
                            .end_icon(Icon::new(IconName::ArrowRight))
                            .disabled(is_running || is_connecting || draft_is_empty)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.submit_follow_up(window, cx);
                            })),
                    ),
            )
            .when(self.agent_finished, |el| {
                el.child(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("approve-changes", "Approve Changes")
                                .style(ButtonStyle::Filled)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.approve_changes(cx);
                                })),
                        )
                        .child(
                            Button::new("revert-changes", "Revert Changes")
                                .style(ButtonStyle::Subtle)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.revert_changes(cx);
                                })),
                        ),
                )
            })
    }
}
