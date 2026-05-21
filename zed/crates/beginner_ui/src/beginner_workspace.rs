use std::path::PathBuf;
use std::rc::Rc;

use acp_thread::{
    AcpThread, AcpThreadEvent, AgentModelList, AgentModelSelector, SelectedPermissionOutcome,
    ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use agent_ui::thread_metadata_store::ThreadMetadataStore;
use agent_ui::{AgentPanel, ConversationView, ModelSelectorPopover};
use db::kvp::KeyValueStore;
use editor::Editor;
use indexmap::IndexMap;
use gpui::{
    App, AsyncWindowContext, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement,
    PathPromptOptions, Render, SharedString, Subscription, Task, WeakEntity, Window,
    WindowControlArea, canvas,
};
use editor::actions::Newline;
use onboarding::{EXPERIENCE_LEVEL_KVP_KEY, ExperienceLevel};
use project::Project;
use ui::{
    Button, ButtonStyle, Color, Headline, HeadlineSize, Icon, IconButton, IconName, IconSize,
    Label, LabelSize, Tooltip, Vector, VectorName, prelude::*, utils::platform_title_bar_height,
};
use util::ResultExt;
use workspace::{MultiWorkspace, PathList, Workspace};

use acp_thread::AgentThreadEntry;

use crate::beginner_chat_feed::BeginnerChatFeed;
use crate::file_changes_panel::{FileChangesPanel, FileChangesPanelEvent};

/// Provider/model ID prefixes for the curated simple-mode model list.
/// Matched against ACP model IDs of the form "provider/model-name".
/// Each entry is (provider_prefix, model_id_prefix, display_name).
static CURATED_MODELS: &[(&str, &str, &str)] = &[
    // ── Anthropic ──────────────────────────────────────────────────────
    ("anthropic", "claude-opus-4",      "Claude Opus 4 · Powerful"),
    ("anthropic", "claude-sonnet-4",    "Claude Sonnet 4 · Balanced"),
    ("anthropic", "claude-haiku-4",     "Claude Haiku 4 · Fast"),
    // ── OpenAI ─────────────────────────────────────────────────────────
    ("openai",    "gpt-5.5",            "GPT-5.5 · Powerful"),
    ("openai",    "gpt-5",              "GPT-5 · Balanced"),
    ("openai",    "gpt-",               "GPT · OpenAI"),
    ("openai",    "o3",                 "o3 · Reasoning"),
    ("openai",    "o4-mini",            "o4-mini · Fast reasoning"),
    // ── Google ─────────────────────────────────────────────────────────
    ("google",    "gemini-2.5-pro",     "Gemini 2.5 Pro · Powerful"),
    ("google",    "gemini-2.5-flash",   "Gemini 2.5 Flash · Fast"),
    ("google",    "gemini-",            "Gemini · Google"),
    // ── DeepSeek ───────────────────────────────────────────────────────
    ("deepseek",  "deepseek-r1",        "DeepSeek R1 · Reasoning"),
    ("deepseek",  "deepseek-v3",        "DeepSeek V3 · Balanced"),
    ("deepseek",  "deepseek-v4",        "DeepSeek V4 · Powerful"),
    ("deepseek",  "deepseek-",          "DeepSeek"),
];

fn curated_display_name(model_id: &str) -> Option<&'static str> {
    let model_part = model_id.split_once('/').map(|(_, m)| m).unwrap_or(model_id);
    CURATED_MODELS.iter().find_map(|&(_, m, name)| {
        if model_part.starts_with(m) {
            Some(name)
        } else {
            None
        }
    })
}

fn model_speed_rank(label: &str, model_id: &str) -> usize {
    let text = format!("{label} {model_id}").to_lowercase();
    if text.contains("fast") || text.contains("haiku") || text.contains("flash") {
        0
    } else if text.contains("reasoning") || text.contains("r1") || text.contains("o3") {
        1
    } else if text.contains("balanced") || text.contains("sonnet") || text.contains("v3") {
        2
    } else if text.contains("powerful") || text.contains("opus") || text.contains("pro") {
        3
    } else {
        4
    }
}

/// Wraps an inner `AgentModelSelector` and returns only the curated model list.
/// Model selection and all mutations pass through to the inner selector unchanged.
struct CuratedModelSelector {
    inner: Rc<dyn AgentModelSelector>,
}

impl AgentModelSelector for CuratedModelSelector {
    fn list_models(&self, cx: &mut App) -> gpui::Task<anyhow::Result<AgentModelList>> {
        let inner = self.inner.clone();
        cx.spawn(async move |cx| {
            let list = cx.update(|cx| inner.list_models(cx)).await?;
            let all_models: Vec<acp_thread::AgentModelInfo> = match list {
                AgentModelList::Flat(models) => models,
                AgentModelList::Grouped(groups) => groups.into_values().flatten().collect(),
            };
            // Filter to curated entries in the defined order.
            let mut grouped: IndexMap<String, Vec<acp_thread::AgentModelInfo>> = IndexMap::default();
            for &(provider_id, model_prefix, display_name) in CURATED_MODELS {
                let info = if let Some(mut info) = all_models.iter().find(|m| {
                    let id: &str = &m.id.0;
                    let model_part = id.split_once('/').map(|(_, part)| part).unwrap_or(id);
                    model_part.starts_with(model_prefix)
                }).cloned() {
                    info.name = SharedString::from(display_name);
                    info
                } else {
                    // Keep options visible in simple mode even if the server omits
                    // them from `available_models` for this session.
                    acp_thread::AgentModelInfo {
                        id: acp::ModelId::new(format!("{provider_id}/{model_prefix}")),
                        name: SharedString::from(display_name),
                        description: None,
                        icon: None,
                        is_latest: false,
                        cost: None,
                    }
                };
                let provider_label = match provider_id {
                    "openai" => "OpenAI",
                    "anthropic" => "Anthropic",
                    "google" => "Google",
                    "deepseek" => "DeepSeek",
                    _ => provider_id,
                };
                grouped
                    .entry(provider_label.to_string())
                    .or_default()
                    .push(info);
            }
            // Fallback: if no curated models are available (provider not configured),
            // show the first 10 from whatever the server provides.
            if grouped.is_empty() {
                return Ok(AgentModelList::Flat(all_models.into_iter().take(10).collect()));
            }
            let grouped = grouped
                .into_iter()
                .map(|(k, mut v)| {
                    v.sort_by_key(|m| model_speed_rank(m.name.as_ref(), m.id.0.as_ref()));
                    (acp_thread::AgentModelGroupName(k.into()), v)
                });
            Ok(AgentModelList::Grouped(grouped.collect()))
        })
    }

    fn select_model(&self, model_id: acp::ModelId, cx: &mut App) -> gpui::Task<anyhow::Result<()>> {
        self.inner.select_model(model_id, cx)
    }

    fn selected_model(&self, cx: &mut App) -> gpui::Task<anyhow::Result<acp_thread::AgentModelInfo>> {
        // Also apply the curated display name to the selected model so the button label matches.
        let inner = self.inner.clone();
        cx.spawn(async move |cx| {
            let mut info = cx.update(|cx| inner.selected_model(cx)).await?;
            if let Some(name) = curated_display_name(&info.id.0) {
                info.name = SharedString::from(name);
            }
            Ok(info)
        })
    }

    fn watch(&self, cx: &mut App) -> Option<watch::Receiver<()>> {
        self.inner.watch(cx)
    }

    fn should_render_footer(&self) -> bool {
        false
    }
}

const BEGINNER_CHATS_KVP_KEY: &str = "beginner_chats_v1";

/// A saved simple-mode conversation entry shown on the home page.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BeginnerChatRecord {
    id: String,
    name: String,
    folder_path: String,
    #[serde(default)]
    session_id: Option<String>,
    timestamp_ms: i64,
}

impl BeginnerChatRecord {
    fn new(name: String, folder: &PathBuf) -> Self {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            folder_path: folder.to_string_lossy().into_owned(),
            session_id: None,
            timestamp_ms,
        }
    }

    fn folder(&self) -> PathBuf {
        PathBuf::from(&self.folder_path)
    }

    fn folder_name(&self) -> SharedString {
        PathBuf::from(&self.folder_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned().into())
            .unwrap_or_else(|| SharedString::from(self.folder_path.as_str()))
    }
}

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
    tab_name: SharedString,
    chat_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    pending_conversation_view: Option<Entity<ConversationView>>,
    active_conversation_view: Option<Entity<ConversationView>>,
    model_selector: Option<Entity<ModelSelectorPopover>>,
    is_agent_running: bool,
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    raw_browse_path: Option<PathBuf>,
    right_panel: RightPanel,
    preview_url: Option<String>,
    // Port claimed by this session's dev server (3000–3002). None until first start.
    dev_server_port: Option<u16>,
    #[allow(dead_code)]
    web_preview: Option<crate::web_preview::WebPreview>,
    dev_server_task: Option<Task<()>>,
    subscriptions: Vec<Subscription>,
}

pub struct BeginnerWorkspace {
    workspace: WeakEntity<Workspace>,
    #[allow(dead_code)]
    multi_workspace: WeakEntity<MultiWorkspace>,
    project: Entity<Project>,
    focus_handle: FocusHandle,
    state: BeginnerState,
    // Human-readable tab name generated from the initial prompt.
    tab_name: SharedString,
    chat_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    // Kept alive for the entire session lifetime. The ConversationView owns the
    // ThreadView which owns the send task — dropping it cancels in-flight sends.
    // "pending" while connecting; remains alive after connected to keep ThreadView alive.
    pending_conversation_view: Option<Entity<ConversationView>>,
    // Kept alive after connection so that ThreadView (and its send tasks) are not dropped.
    active_conversation_view: Option<Entity<ConversationView>>,
    // Model selector extracted from the ThreadView once connected.
    model_selector: Option<Entity<ModelSelectorPopover>>,
    is_agent_running: bool,
    // Set when agent finishes so approve/revert actions are shown.
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    raw_browse_path: Option<PathBuf>,
    right_panel: RightPanel,
    // URL of the running dev server once it's ready.
    preview_url: Option<String>,
    // Port claimed by this session (3000–3002). Persists across stash/switch so the
    // server is never killed when switching tabs — only reclaimed when a session is reset.
    dev_server_port: Option<u16>,
    // Polling task for start_dev_server; stored per-session so it cancels on stash/switch.
    dev_server_task: Option<Task<()>>,
    // Embedded web preview. Created lazily in render() once we have both a
    // preview_url and the Window handle. None on Linux (unsupported).
    web_preview: Option<crate::web_preview::WebPreview>,
    // Shows a notice when the user tries to open a 4th tab.
    show_tab_limit_notice: bool,
    chats_sidebar_open: bool,
    background_sessions: Vec<ProjectSession>,
    chat_history: Vec<BeginnerChatRecord>,
    _tasks: Vec<Task<()>>,
    _project_subscription: Subscription,
    session_subscriptions: Vec<Subscription>,
}

impl BeginnerWorkspace {
    fn handle_enter_submit(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_follow_up(window, cx);
    }

    fn make_chat_editor(window: &mut Window, cx: &mut Context<Self>, placeholder: &str) -> (Entity<Editor>, Subscription) {
        let workspace = cx.entity().downgrade();
        let editor = cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 8, window, cx);
            editor.set_placeholder_text(placeholder, window, cx);
            editor
        });
        let subscription = editor.update(cx, |editor, _cx| {
            let workspace = workspace.clone();
            editor.register_action(move |_: &Newline, window, cx| {
                workspace.update(cx, |this, cx| {
                    this.submit_follow_up(window, cx);
                }).ok();
            })
        });
        (editor, subscription)
    }

    fn current_tab_title(&self) -> SharedString {
        match &self.state {
            BeginnerState::ActiveProject { .. } => self.tab_name.clone(),
            BeginnerState::Landing => SharedString::from("New Project"),
        }
    }

    fn stash_current_session_and_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (replacement_editor, enter_sub) = Self::make_chat_editor(window, cx, "Describe your project or idea...");
        let session = ProjectSession {
            state: std::mem::replace(&mut self.state, BeginnerState::Landing),
            tab_name: std::mem::replace(&mut self.tab_name, SharedString::from("New Project")),
            chat_editor: std::mem::replace(&mut self.chat_editor, replacement_editor),
            selected_folder: self.selected_folder.take(),
            thread: self.thread.take(),
            pending_conversation_view: self.pending_conversation_view.take(),
            active_conversation_view: self.active_conversation_view.take(),
            model_selector: self.model_selector.take(),
            is_agent_running: std::mem::replace(&mut self.is_agent_running, false),
            agent_finished: std::mem::replace(&mut self.agent_finished, false),
            chat_feed: self.chat_feed.take(),
            file_changes_panel: self.file_changes_panel.take(),
            left_tab: std::mem::replace(&mut self.left_tab, LeftTab::Files),
            show_raw_files: std::mem::replace(&mut self.show_raw_files, false),
            raw_browse_path: self.raw_browse_path.take(),
            right_panel: std::mem::replace(&mut self.right_panel, RightPanel::Preview),
            preview_url: self.preview_url.take(),
            dev_server_port: self.dev_server_port.take(),
            // Drop the live webview by not carrying it into the stash.
            // preview_url and dev_server_port are preserved so the server stays alive
            // on its port and can be shown again on switch-back.
            web_preview: None,
            dev_server_task: self.dev_server_task.take(),
            subscriptions: std::mem::take(&mut self.session_subscriptions),
        };
        // Drop the active webview so the WKWebView is removed from the window immediately.
        self.web_preview = None;
        // The new editor's Enter-to-submit subscription belongs to the fresh session.
        self.session_subscriptions.push(enter_sub);
        self.background_sessions.push(session);
        cx.notify();
    }

    fn switch_to_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.background_sessions.len() {
            return;
        }
        let session = &mut self.background_sessions[ix];
        std::mem::swap(&mut self.state, &mut session.state);
        std::mem::swap(&mut self.tab_name, &mut session.tab_name);
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
        std::mem::swap(&mut self.model_selector, &mut session.model_selector);
        std::mem::swap(&mut self.is_agent_running, &mut session.is_agent_running);
        std::mem::swap(&mut self.agent_finished, &mut session.agent_finished);
        std::mem::swap(&mut self.chat_feed, &mut session.chat_feed);
        std::mem::swap(&mut self.file_changes_panel, &mut session.file_changes_panel);
        std::mem::swap(&mut self.left_tab, &mut session.left_tab);
        std::mem::swap(&mut self.show_raw_files, &mut session.show_raw_files);
        std::mem::swap(&mut self.raw_browse_path, &mut session.raw_browse_path);
        std::mem::swap(&mut self.right_panel, &mut session.right_panel);
        std::mem::swap(&mut self.preview_url, &mut session.preview_url);
        std::mem::swap(&mut self.dev_server_port, &mut session.dev_server_port);
        std::mem::swap(&mut self.dev_server_task, &mut session.dev_server_task);
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
        let (chat_editor, chat_enter_sub) = Self::make_chat_editor(window, cx, "Describe your project or idea...");

        let load_recent = Self::load_chat_history(workspace.clone(), cx);

        let project = workspace
            .upgrade()
            .map(|ws| ws.read(cx).project().clone())
            .expect("workspace must be alive when BeginnerWorkspace is created");

        // Always start simple mode on Home. Existing editor worktrees should not
        // force simple mode into an active project state on launch/resume.
        let initial_folder = None;
        let state = BeginnerState::Landing;

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
            tab_name: SharedString::from("New Project"),
            chat_editor,
            selected_folder: initial_folder,
            thread: None,
            pending_conversation_view: None,
            active_conversation_view: None,
            model_selector: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            raw_browse_path: None,
            right_panel: RightPanel::Preview,
            preview_url: None,
            dev_server_port: None,
            dev_server_task: None,
            web_preview: None,
            show_tab_limit_notice: false,
            chats_sidebar_open: true,
            background_sessions: Vec::new(),
            chat_history: Vec::new(),
            _tasks: vec![load_recent],
            _project_subscription: project_sub,
            session_subscriptions: vec![chat_enter_sub],
        }
    }

    /// Called whenever the project's worktree list changes so the Chat UI
    /// stays in sync with folders opened or closed from any mode.
    fn sync_from_project(&mut self, cx: &mut Context<Self>) {
        // When multiple sessions are active the user manages folders explicitly via
        // stash/switch. The project accumulates worktrees from all sessions, so
        // first_visible_worktree_path would return a stale folder from any session.
        // Only auto-sync in single-session mode.
        if !self.background_sessions.is_empty() {
            return;
        }

        let new_folder = first_visible_worktree_path(&self.project, cx);

        // Only reset to Landing when the project truly has no folders —
        // don't discard an in-progress conversation when a second worktree
        // is added (e.g. agent workspace creating a git linked worktree).
        match (&self.state, &new_folder) {
            (BeginnerState::Landing, Some(_)) => {}
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

    fn load_chat_history(
        workspace: WeakEntity<Workspace>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let kvp = cx.update(|cx| {
                let _ = workspace; // keep alive
                KeyValueStore::global(cx)
            });
            let Some(json) = kvp.read_kvp(BEGINNER_CHATS_KVP_KEY).log_err().flatten() else {
                return;
            };
            let Some(records) = serde_json::from_str::<Vec<BeginnerChatRecord>>(&json).log_err() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.chat_history = records;
                cx.notify();
            }).ok();
        })
    }

    fn save_chat_history(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let records = self.chat_history.clone();
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&records) {
                kvp.write_kvp(BEGINNER_CHATS_KVP_KEY.to_string(), json).await.log_err();
            }
        }).detach();
    }

    fn add_chat_record(&mut self, name: String, folder: &PathBuf, cx: &mut App) {
        let record = BeginnerChatRecord::new(name, folder);
        // Insert at front so most-recent appears first; cap at 50 entries.
        self.chat_history.insert(0, record);
        self.chat_history.truncate(50);
        self.save_chat_history(cx);
    }

    fn update_latest_chat_record_session_id(
        &mut self,
        folder: &PathBuf,
        session_id: String,
        cx: &mut App,
    ) {
        if let Some(record) = self
            .chat_history
            .iter_mut()
            .find(|r| r.folder() == *folder && r.session_id.is_none())
        {
            record.session_id = Some(session_id);
            self.save_chat_history(cx);
        }
    }

    fn delete_chat_record(&mut self, id: String, cx: &mut App) {
        self.chat_history.retain(|r| r.id != id);
        self.save_chat_history(cx);
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
            this.update_in(cx, |this, window, cx| {
                this.selected_folder = Some(folder);
                // If the user already typed a prompt, submit immediately so they
                // don't need to click "Create Project" a second time.
                let has_text = !this.chat_editor.read(cx).text(cx).trim().is_empty();
                if has_text {
                    this.submit(window, cx);
                } else {
                    if this.thread.is_none() {
                        this.start_agent_thread(String::new(), window, cx);
                        this.is_agent_running = false;
                    }
                    cx.notify();
                }
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

        let chat_name = generate_chat_name(&text);
        self.tab_name = SharedString::from(chat_name.clone());
        self.state = BeginnerState::ActiveProject {
            project_name: SharedString::from(project_name),
        };
        // Save the chat to history before starting, so it appears on the home page
        // even if the user immediately closes without waiting for the agent.
        self.add_chat_record(chat_name, &folder, cx);

        // If a draft thread is already present (for pre-send model selection),
        // keep it and send as follow-up so the chosen model is respected.
        if self.thread.is_some() {
            self.submit_follow_up(window, cx);
            return;
        }

        // Clear all previous session state so the new project starts completely fresh.
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.web_preview = None;
        self.preview_url = None;
        self.dev_server_port = None;
        self.dev_server_task = None;
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

        // Keep simple mode workspace-light: pass folder as thread workdir but do not
        // auto-open it as an editor worktree.
        let _ = (workspace, folder);

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

        self.bind_conversation_view(conversation_view, window, cx);

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
        // Hide the webview so layout reverts to chat-dominant while the agent runs.
        // Keep preview_url so the running dev server is reused (not restarted) after.
        self.web_preview = None;
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

    fn close_active_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_tab_limit_notice = false;
        if self.background_sessions.is_empty() {
            // Last tab — reset to landing rather than closing the window.
            self.new_project(window, cx);
        } else {
            // Bring the first background session forward, then discard the old active.
            self.switch_to_session(0, cx);
            self.background_sessions.remove(0);
            cx.notify();
        }
    }

    fn close_background_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.background_sessions.len() {
            self.background_sessions.remove(ix);
            self.show_tab_limit_notice = false;
            cx.notify();
        }
    }

    fn go_home(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, BeginnerState::Landing) {
            return;
        }
        self.stash_current_session_and_reset(window, cx);
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

    /// Picks the lowest port in 3000–3002 not already claimed by another session.
    fn claim_dev_server_port(&self) -> u16 {
        let used: std::collections::HashSet<u16> = self
            .background_sessions
            .iter()
            .filter_map(|s| s.dev_server_port)
            .collect();
        for port in 3000u16..3003 {
            if !used.contains(&port) {
                return port;
            }
        }
        3000 // all three taken — reuse 3000 (shouldn't happen with max 3 tabs)
    }

    fn start_dev_server(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        // Reuse the already-claimed port for this session; claim a fresh one if first start.
        let port = self.dev_server_port.unwrap_or_else(|| self.claim_dev_server_port());
        self.dev_server_port = Some(port);

        let task = cx.spawn(async move |this, cx| {
            // Kill only the specific port being claimed so other sessions' servers survive.
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                std::process::Command::new("sh")
                    .arg("-c")
                    .arg(format!("lsof -ti :{port} | xargs kill -9 2>/dev/null; true"))
                    .status()
                    .ok();
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(400))
                    .await;
            }

            // Detect the package manager from lockfiles present in the project folder.
            let pkg_manager = if folder.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if folder.join("bun.lockb").exists() || folder.join("bun.lock").exists() {
                "bun"
            } else if folder.join("yarn.lock").exists() {
                "yarn"
            } else {
                "npm"
            };

            // Use the interactive login shell so ~/.zshrc / ~/.bashrc are sourced —
            // this makes nvm, Homebrew, mise, etc. available even from a GUI app launch.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let dev_cmd = format!(
                "cd {} && {} run dev -- --port={}",
                folder.display(),
                pkg_manager,
                port,
            );

            let spawned = std::process::Command::new(&shell)
                .args(["-i", "-l", "-c", &dev_cmd])
                .env("PORT", port.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok();

            if !spawned {
                return;
            }

            // Poll until the port responds (up to 30 s).
            for _ in 0..60 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(500))
                    .await;
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    let url = format!("http://localhost:{port}");
                    this.update(cx, |this, cx| {
                        this.web_preview = None;
                        this.preview_url = Some(url);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            }
        });
        // Replace any previous polling task — dropping the old one cancels it.
        self.dev_server_task = Some(task);
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
        self.dev_server_port = None;
        self.dev_server_task = None;
        self.web_preview = None;
        self.session_subscriptions.clear();
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Describe your project or idea...", window, cx);
            editor.set_text("", window, cx);
        });
        cx.notify();
    }

    fn open_chat_record(
        &mut self,
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path = record.folder();
        let chat_name = SharedString::from(record.name.clone());
        self.selected_folder = Some(path.clone());
        self.tab_name = chat_name.clone();
        self.state = BeginnerState::ActiveProject {
            project_name: record.folder_name(),
        };
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text("Ask a follow-up...", window, cx);
        });
        self.restore_thread_for_folder(record.clone(), path.clone(), window, cx);
        cx.notify();

        // Do not auto-add worktrees on resume; simple mode should stay uncluttered.
        let _ = window;
    }

    fn restore_thread_for_folder(
        &mut self,
        record: BeginnerChatRecord,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let Some(agent_panel) = workspace.read(cx).panel::<AgentPanel>(cx) else {
            return;
        };
        let Some(store) = ThreadMetadataStore::try_global(cx) else {
            return;
        };

        let path_list = PathList::new(&[path]);
        let store_ref = store.read(cx);
        let metadata = record
            .session_id
            .as_ref()
            .and_then(|sid| {
                let session = acp::SessionId::new(sid.clone());
                store_ref.entry_by_session(&session)
            })
            .or_else(|| store_ref
            .entries_for_path(&path_list, None)
            .chain(store_ref.entries_for_main_worktree_path(&path_list, None))
            .max_by_key(|entry| entry.updated_at)
            )
            .or_else(|| {
                // Fallback for legacy history rows where folder path matching is unreliable.
                store_ref
                    .entries()
                    .filter(|entry| entry.display_title() == self.tab_name)
                    .max_by_key(|entry| entry.updated_at)
            });

        let Some(metadata) = metadata else {
            return;
        };

        let thread_id = metadata.thread_id;
        let work_dirs = Some(path_list);
        let conversation_view = agent_panel.update(cx, |panel, cx| {
            panel.spawn_beginner_thread_from_thread_id(thread_id, work_dirs, window, cx)
        });
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        if let Some(conversation_view) = conversation_view {
            self.bind_conversation_view(conversation_view, window, cx);
        }
    }

    fn bind_conversation_view(
        &mut self,
        conversation_view: Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_conversation_view = Some(conversation_view.clone());
        let cv_sub = cx.observe_in(&conversation_view, window, |this, cv, window, cx| {
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
                                if this.preview_url.is_none() {
                                    this.open_web_app_if_present(cx);
                                }
                                cx.notify();
                            }
                            AcpThreadEvent::Error => {
                                this.is_agent_running = false;
                                this.agent_finished = false;
                                cx.notify();
                            }
                            AcpThreadEvent::ToolAuthorizationRequested(tool_call_id) => {
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
                    this.thread = Some(thread.clone());
                    if let Some(folder) = this.selected_folder.clone() {
                        let sid = thread.read(cx).session_id().0.to_string();
                        this.update_latest_chat_record_session_id(&folder, sid, cx);
                    }
                    this.active_conversation_view = this.pending_conversation_view.take();
                    this.model_selector = this
                        .active_conversation_view
                        .as_ref()
                        .and_then(|cv_entity| {
                            cv_entity.update(cx, |cv_ref, cx| {
                                cv_ref.make_root_model_selector_wrapped(
                                    |inner| Rc::new(CuratedModelSelector { inner }) as Rc<dyn AgentModelSelector>,
                                    window,
                                    cx,
                                )
                            })
                        });
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
    }
}


/// Generate a human-readable title from the user's initial prompt (like ChatGPT/Claude naming).
/// Uses sentence case and keeps up to 6 meaningful words.
fn generate_chat_name(prompt: &str) -> String {
    const STOP_WORDS: &[&str] = &[
        "a", "an", "the", "make", "build", "create", "add", "set", "up", "me", "my",
        "i", "want", "please", "can", "you", "that", "this", "it", "some", "just",
        "something", "new", "simple", "basic", "cool", "nice", "good", "great",
        "modern", "clean", "help", "do", "write", "give",
    ];

    let words: Vec<String> = prompt
        .split_whitespace()
        .filter_map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| c.is_alphabetic())
                .collect::<String>()
                .to_lowercase();
            if clean.is_empty() || STOP_WORDS.contains(&clean.as_str()) {
                None
            } else {
                Some(clean)
            }
        })
        .take(6)
        .collect();

    if words.is_empty() {
        return "New Project".to_string();
    }

    // Sentence case: capitalize first word only.
    let mut result = String::new();
    for (i, word) in words.iter().enumerate() {
        if i == 0 {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                result.push_str(&first.to_uppercase().to_string());
                result.push_str(chars.as_str());
            }
        } else {
            result.push(' ');
            result.push_str(word);
        }
    }
    result
}

fn first_visible_worktree_path(project: &Entity<Project>, cx: &App) -> Option<PathBuf> {
    project
        .read(cx)
        .visible_worktrees(cx)
        .filter(|wt| !wt.read(cx).is_single_file())
        .next()
        .map(|wt| wt.read(cx).abs_path().to_path_buf())
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
    /// Renders a horizontal tab strip with closeable tabs.
    /// Active tab has a raised border style; background tabs are clickable and closeable.
    fn render_tab_bar(
        &self,
        active_title: SharedString,
        background_titles: Vec<SharedString>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let border = cx.theme().colors().border;
        let active_bg = cx.theme().colors().editor_background;
        let inactive_hover = cx.theme().colors().element_hover;
        let total_tabs = 1 + background_titles.len();
        let can_add = total_tabs < 3;
        // Only show a close button on the active tab when it can be meaningfully closed:
        // either there are other tabs to switch to, or this is an active project (closing
        // returns to landing). Don't show X on the sole "New Project" landing tab.
        let show_active_close = !background_titles.is_empty()
            || matches!(self.state, BeginnerState::ActiveProject { .. });

        let is_on_landing = matches!(self.state, BeginnerState::Landing);
        let chats_open = self.chats_sidebar_open;

        h_flex()
            .h(px(32.))
            .w_full()
            .flex_shrink_0()
            .items_end()
            .px_2()
            .gap_0p5()
            .border_b_1()
            .border_color(border)
            // Chats toggle
            .child(
                div()
                    .id("tab-chats")
                    .h(px(28.))
                    .w(px(28.))
                    .mb_px()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .cursor_pointer()
                    .when(chats_open, |el| el.bg(cx.theme().colors().element_selected))
                    .when(!chats_open, |el| el.hover(|el| el.bg(cx.theme().colors().element_hover)))
                    .tooltip(Tooltip::text("Chats"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.chats_sidebar_open = !this.chats_sidebar_open;
                        cx.notify();
                    }))
                    .child(
                        Icon::new(IconName::Thread)
                            .size(IconSize::XSmall)
                            .color(if chats_open { Color::Default } else { Color::Muted }),
                    ),
            )
            // Home button
            .child(
                div()
                    .id("tab-home")
                    .h(px(28.))
                    .w(px(28.))
                    .mb_px()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .cursor_pointer()
                    .when(is_on_landing, |el| {
                        el.bg(cx.theme().colors().element_selected)
                    })
                    .when(!is_on_landing, |el| {
                        el.hover(|el| el.bg(cx.theme().colors().element_hover))
                    })
                    .tooltip(Tooltip::text("Home"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.go_home(window, cx);
                    }))
                    .child(
                        Icon::new(IconName::OpenFolder)
                            .size(IconSize::XSmall)
                            .color(if is_on_landing { Color::Default } else { Color::Muted }),
                    ),
            )
            // Active tab (hidden on Home/New Project page)
            .when(!is_on_landing, |this| {
                this.child(
                    h_flex()
                        .id("tab-active")
                        .h(px(28.))
                        .pl_3()
                        .pr_1p5()
                        .gap_1p5()
                        .items_center()
                        .rounded_t_md()
                        .border_1()
                        .border_b_0()
                        .border_color(border)
                        .bg(active_bg)
                        .child(
                            Label::new(active_title)
                                .size(LabelSize::Small)
                                .color(Color::Default),
                        )
                        .when(show_active_close, |el| {
                            el.child(
                                div()
                                    .id("tab-active-close")
                                    .size(px(14.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_sm()
                                    .cursor_pointer()
                                    .hover(|el| el.bg(cx.theme().colors().element_hover))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.close_active_session(window, cx);
                                    }))
                                    .child(
                                        Icon::new(IconName::Close)
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                    ),
                            )
                        }),
                )
            })
            // Background session tabs
            .children(background_titles.into_iter().enumerate().map(|(ix, title)| {
                h_flex()
                    .id(SharedString::from(format!("tab-bg-{ix}")))
                    .h(px(26.))
                    .pl_3()
                    .pr_1p5()
                    .gap_1p5()
                    .items_center()
                    .rounded_t_md()
                    .cursor_pointer()
                    .hover(move |el| el.bg(inactive_hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.switch_to_session(ix, cx);
                    }))
                    .child(
                        Label::new(title)
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("tab-bg-close-{ix}")))
                            .size(px(14.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_sm()
                            .cursor_pointer()
                            .hover(move |el| el.bg(inactive_hover))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.close_background_session(ix, cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    )
            }))
            .child(div().flex_1())
            // "+" always visible; at limit it shows a notice instead of opening
            .child(
                h_flex()
                    .h_full()
                    .items_center()
                    .child(
                        IconButton::new("tab-bar-new", IconName::Plus)
                            .icon_size(IconSize::XSmall)
                            .icon_color(if can_add { Color::Muted } else { Color::Disabled })
                            .tooltip(Tooltip::text(if can_add {
                                "New project tab"
                            } else {
                                "3 project limit reached"
                            }))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if can_add {
                                    this.show_tab_limit_notice = false;
                                    this.stash_current_session_and_reset(window, cx);
                                } else {
                                    this.show_tab_limit_notice = true;
                                    cx.notify();
                                }
                            })),
                    ),
            )
    }

    fn render_tab_limit_notice(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .items_center()
            .bg(cx.theme().colors().surface_background)
            .border_b_1()
            .border_color(cx.theme().colors().border)
            .child(
                Icon::new(IconName::Warning)
                    .size(IconSize::XSmall)
                    .color(Color::Warning),
            )
            .child(
                Label::new("You have 3 projects open — the maximum. Close or replace one to start a new project.")
                    .size(LabelSize::Small)
                    .color(Color::Default),
            )
            .child(div().flex_1())
            .child(
                IconButton::new("dismiss-limit-notice", IconName::Close)
                    .icon_size(IconSize::XSmall)
                    .icon_color(Color::Muted)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_tab_limit_notice = false;
                        cx.notify();
                    })),
            )
    }

    fn render_chats_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let border = cx.theme().colors().border;
        let chat_history = self.chat_history.clone();
        let no_history = chat_history.is_empty();

        v_flex()
            .w(px(240.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(border)
            .bg(cx.theme().colors().surface_background)
            .child(
                v_flex()
                    .id("chat-history-list")
                    .flex_1()
                    .overflow_y_scroll()
                    .p_2()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .px_1()
                            .py_0p5()
                            .child(
                                Label::new("Chats")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    )
                    .when(no_history, |el| {
                        el.child(
                            v_flex()
                                .px_2()
                                .py_2()
                                .gap_0p5()
                                .child(
                                    Label::new("No chats yet")
                                        .size(LabelSize::Small)
                                        .color(Color::Disabled),
                                )
                                .child(
                                    Label::new("Start a new project to get started.")
                                        .size(LabelSize::XSmall)
                                        .color(Color::Disabled),
                                ),
                        )
                    })
                    .children(chat_history.into_iter().map(|record| {
                        let name = SharedString::from(record.name.clone());
                        let folder_label = record.folder_name();
                        let record_for_click = record.clone();
                        let record_id_for_delete = record.id.clone();
                        let hover_bg = cx.theme().colors().element_hover;
                        h_flex()
                            .id(SharedString::from(format!("chat-{}", record.id)))
                            .group("chat-entry")
                            .px_2()
                            .py_1()
                            .gap_1p5()
                            .rounded_md()
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_bg))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_chat_record(record_for_click.clone(), window, cx);
                            }))
                            .child(
                                Icon::new(IconName::Folder)
                                    .size(IconSize::XSmall)
                                    .color(Color::Muted),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_0p5()
                                    .child(
                                        Label::new(name)
                                            .size(LabelSize::Small)
                                            .truncate(),
                                    )
                                    .child(
                                        Label::new(folder_label)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted)
                                            .truncate(),
                                    ),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "chat-del-{}",
                                        record_id_for_delete.clone()
                                    )))
                                    .size(px(14.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_sm()
                                    .flex_none()
                                    .cursor_pointer()
                                    .hover(move |el| el.bg(hover_bg))
                                    .on_click(cx.listener(move |this, _event, _, cx| {
                                        cx.stop_propagation();
                                        this.delete_chat_record(record_id_for_delete.clone(), cx);
                                        cx.notify();
                                    }))
                                    .child(
                                        Icon::new(IconName::Close)
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                    ),
                            )
                    })),
            )
    }

    fn render_landing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let no_history = self.chat_history.is_empty();
        let chat_editor = self.chat_editor.clone();
        let header_height = platform_title_bar_height(window);
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let background_titles: Vec<SharedString> = self
            .background_sessions
            .iter()
            .map(|s| match &s.state {
                BeginnerState::Landing => SharedString::from("New Project"),
                BeginnerState::ActiveProject { .. } => s.tab_name.clone(),
            })
            .collect();

        let border = cx.theme().colors().border;

        v_flex()
            .key_context("BeginnerLanding")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::handle_enter_submit))
            .size_full()
            .bg(cx.theme().colors().editor_background)
            // Title bar drag strip
            .child(
                h_flex()
                    .h(header_height)
                    .w_full()
                    .flex_shrink_0()
                    .window_control_area(WindowControlArea::Drag)
                    .when(traffic_lights, |this| {
                        this.pl(px(ui::utils::TRAFFIC_LIGHT_PADDING))
                    })
                    .border_b_1()
                    .border_color(border)
                    .bg(cx.theme().colors().title_bar_background),
            )
            .child(self.render_tab_bar(
                SharedString::from("New Project"),
                background_titles,
                cx,
            ))
            .when(self.show_tab_limit_notice, |el| {
                el.child(self.render_tab_limit_notice(cx))
            })
            // Body: left sidebar + main content
            .child(
                h_flex()
                    .flex_1()
                    .overflow_hidden()
                    .when(self.chats_sidebar_open, |el| el.child(self.render_chats_sidebar(cx)))
                    // ── Main content ──────────────────────────────────────────
                    .child(
                        v_flex()
                            .flex_1()
                            .h_full()
                            .items_center()
                            .justify_center()
                            .gap_5()
                            .px_8()
                            .py_8()
                            // Headline
                            .child(
                                v_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        Headline::new(if no_history {
                                            "Welcome to Backboard"
                                        } else {
                                            "Start a new project"
                                        })
                                        .size(HeadlineSize::Large),
                                    )
                                    .child(
                                        Label::new(if no_history {
                                            "Create a project and describe what you want to build."
                                        } else {
                                            "Describe your idea and Backboard will start building."
                                        })
                                        .size(LabelSize::Default)
                                        .color(Color::Muted),
                                    ),
                            )
                            // Onboarding steps
                            .child(
                                v_flex()
                                    .w(px(520.))
                                    .gap_3()
                                    .children(
                                        [
                                            (
                                                "Create a project",
                                                "Set up a new project in seconds.",
                                            ),
                                            (
                                                "Describe your idea",
                                                "Tell Backboard what you want to build.",
                                            ),
                                            (
                                                "See it come to life",
                                                "Preview your app as you build.",
                                            ),
                                        ]
                                        .into_iter()
                                        .map(|(title, subtitle)| {
                                            h_flex()
                                                .gap_2()
                                                .items_start()
                                                .child(
                                                    v_flex()
                                                        .gap_0p5()
                                                        .child(
                                                            Label::new(title)
                                                                .size(LabelSize::Default)
                                                                .color(Color::Default),
                                                        )
                                                        .child(
                                                            Label::new(subtitle)
                                                                .size(LabelSize::Small)
                                                                .color(Color::Muted),
                                                        ),
                                                )
                                        }),
                                    ),
                            )
                            // Divider
                            .child(div().w(px(520.)).h_px().bg(border))
                            // Input card
                            .child(
                                v_flex()
                                    .w(px(520.))
                                    .gap_3()
                                    .rounded_xl()
                                    .border_1()
                                    .border_color(border)
                                    .bg(cx.theme().colors().editor_background)
                                    .p_4()
                                    .child(chat_editor)
                                    .child(
                                        h_flex()
                                            .pt_1()
                                            .gap_2()
                                            .items_center()
                                            .child(
                                                Button::new("attach-folder", "Attach")
                                                    .style(ButtonStyle::Subtle)
                                                    .start_icon(Icon::new(IconName::FolderOpen))
                                                    .tooltip(Tooltip::text(
                                                        "Attach project root directory",
                                                    ))
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.pick_folder(window, cx);
                                                    })),
                                            )
                                            .child(div().flex_1())
                                            .child(
                                                Button::new("create-project", "Create Project")
                                                    .style(ButtonStyle::Filled)
                                                    .end_icon(Icon::new(IconName::ArrowRight))
                                                    .disabled(draft_is_empty)
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.submit(window, cx);
                                                    })),
                                            ),
                                    ),
                            )
                            // Hint
                            .child(
                                h_flex()
                                    .gap_1p5()
                                    .items_center()
                                    .child(
                                        Label::new(
                                            "Not sure what to build? Try one of the examples above.",
                                        )
                                        .size(LabelSize::XSmall)
                                        .color(Color::Muted),
                                    ),
                            )
                            // Template chips
                            .child(
                                h_flex()
                                    .w(px(520.))
                                    .justify_center()
                                    .gap_2()
                                    .flex_wrap()
                                    .children(
                                        [
                                            (
                                                "Landing page",
                                                "Build a modern landing page with hero, features, and pricing sections.",
                                            ),
                                            (
                                                "Dashboard",
                                                "Build a dashboard with charts, stats, and a data table.",
                                            ),
                                            (
                                                "Web app",
                                                "Build a web app with user authentication and a main workspace.",
                                            ),
                                        ]
                                        .into_iter()
                                        .map(|(label, prompt)| {
                                            h_flex()
                                                .id(SharedString::from(format!(
                                                    "template-{}",
                                                    label
                                                )))
                                                .px_3()
                                                .py_1p5()
                                                .gap_1p5()
                                                .rounded_lg()
                                                .border_1()
                                                .border_color(border)
                                                .bg(cx.theme().colors().surface_background)
                                                .cursor_pointer()
                                                .hover(|el| {
                                                    el.bg(cx.theme().colors().element_hover)
                                                })
                                                .on_click(cx.listener(move |this, _, window, cx| {
                                                    this.apply_suggested_prompt(prompt, window, cx);
                                                }))
                                                .child(
                                                    Label::new(label).size(LabelSize::Small),
                                                )
                                        }),
                                    ),
                            ),
                    ),
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
                BeginnerState::Landing => SharedString::from("New Project"),
                BeginnerState::ActiveProject { .. } => s.tab_name.clone(),
            })
            .collect();

        v_flex()
            .size_full()
            .on_action(cx.listener(Self::handle_enter_submit))
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
                        Vector::new(VectorName::BackboardLogo, rems_from_px(10.), rems_from_px(14.)),
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
                    ),
            )
            .child(self.render_tab_bar(active_title, background_titles, cx))
            .when(self.show_tab_limit_notice, |el| {
                el.child(self.render_tab_limit_notice(cx))
            })
            // 3-column body
            .child(
                h_flex()
                    .flex_1()
                    .overflow_hidden()
                    .when(self.chats_sidebar_open, |el| el.child(self.render_chats_sidebar(cx)))
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
                                            Vector::new(VectorName::BackboardLogo, rems_from_px(18.), rems_from_px(24.)),
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

        // Collect user messages from the thread for the conversation history section.
        let conversation_history: Vec<String> = self
            .thread
            .as_ref()
            .map(|thread| {
                thread
                    .read(cx)
                    .entries()
                    .iter()
                    .filter_map(|entry| {
                        if let AgentThreadEntry::UserMessage(msg) = entry {
                            if msg.indented {
                                return None;
                            }
                            let text = msg.content.to_markdown(cx).to_string();
                            let text = text.trim().to_string();
                            if text.is_empty() { None } else { Some(text) }
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        v_flex()
            .w(px(220.))
            .h_full()
            .flex_shrink_0()
            .bg(cx.theme().colors().surface_background)
            // Search bar
            .child(
                h_flex()
                    .px_2()
                    .py_1p5()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .gap_1p5()
                    .items_center()
                    .child(
                        Icon::new(IconName::MagnifyingGlass)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Search")
                            .size(LabelSize::Small)
                            .color(Color::Disabled),
                    ),
            )
            // Scrollable body
            .child(
                v_flex()
                    .id("left-panel-body")
                    .flex_1()
                    .overflow_y_scroll()
                    // Conversation history section
                    .when(!conversation_history.is_empty(), |el| {
                        el.child(
                            v_flex()
                                .p_2()
                                .gap_0p5()
                                .child(
                                    h_flex()
                                        .px_1()
                                        .py_0p5()
                                        .child(
                                            Label::new("Conversation")
                                                .size(LabelSize::XSmall)
                                                .color(Color::Muted),
                                        ),
                                )
                                .children(
                                    conversation_history.into_iter().enumerate().map(|(ix, text)| {
                                        let truncated = if text.len() > 40 {
                                            format!("{}…", &text[..40])
                                        } else {
                                            text
                                        };
                                        h_flex()
                                            .id(SharedString::from(format!("history-{ix}")))
                                            .px_2()
                                            .py_1()
                                            .gap_1p5()
                                            .rounded_md()
                                            .cursor_pointer()
                                            .hover(|el| el.bg(cx.theme().colors().element_hover))
                                            .child(
                                                Icon::new(IconName::MagnifyingGlass)
                                                    .size(IconSize::XSmall)
                                                    .color(Color::Disabled),
                                            )
                                            .child(
                                                Label::new(SharedString::from(truncated))
                                                    .size(LabelSize::XSmall)
                                                    .color(Color::Muted)
                                                    .truncate(),
                                            )
                                    }),
                                ),
                        )
                        .child(
                            div()
                                .mx_2()
                                .h_px()
                                .bg(cx.theme().colors().border),
                        )
                    })
                    // Project section
                    .child(
                        v_flex()
                            .p_2()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .px_1()
                                    .py_0p5()
                                    .justify_between()
                                    .items_center()
                                    .child(
                                        Label::new("Project")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(
                                        Button::new(
                                            "toggle-raw-files",
                                            if self.show_raw_files { "Simple" } else { "Raw" },
                                        )
                                        .style(ButtonStyle::Subtle)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.show_raw_files = !this.show_raw_files;
                                            cx.notify();
                                        })),
                                    ),
                            )
                            .when(!has_project, |el| {
                                el.child(
                                    div()
                                        .px_2()
                                        .py_4()
                                        .child(
                                            Label::new("No project open")
                                                .size(LabelSize::Small)
                                                .color(Color::Disabled),
                                        ),
                                )
                            })
                            .when_some(self.selected_folder.as_ref(), |el, root_folder| {
                                if self.show_raw_files {
                                    let browse_root =
                                        self.raw_browse_path.as_ref().unwrap_or(root_folder);
                                    let in_subdir = self.raw_browse_path.is_some();
                                    let browse_root = browse_root.clone();
                                    let root_folder = root_folder.clone();
                                    el.when(in_subdir, |el| {
                                        let parent = browse_root
                                            .parent()
                                            .map(|p| p.to_path_buf())
                                            .filter(|p| p.starts_with(&root_folder));
                                        el.child(
                                            h_flex()
                                                .id("raw-back")
                                                .px_2()
                                                .py_1()
                                                .gap_1p5()
                                                .rounded_md()
                                                .cursor_pointer()
                                                .hover(|row| {
                                                    row.bg(cx.theme().colors().element_hover)
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.raw_browse_path = parent.clone();
                                                    cx.notify();
                                                }))
                                                .child(
                                                    Icon::new(IconName::ArrowLeft)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Muted),
                                                )
                                                .child(
                                                    Label::new(
                                                        browse_root
                                                            .file_name()
                                                            .map(|n| n.to_string_lossy().into_owned())
                                                            .unwrap_or_default(),
                                                    )
                                                    .size(LabelSize::Small)
                                                    .color(Color::Muted),
                                                ),
                                        )
                                    })
                                    .children(
                                        project_file_sections(&browse_root).into_iter().map(
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
                                                    .cursor_pointer()
                                                    .hover(|row| {
                                                        row.bg(cx.theme().colors().element_hover)
                                                    })
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if is_dir {
                                                            this.raw_browse_path =
                                                                Some(path.clone());
                                                            cx.notify();
                                                        } else {
                                                            this.open_file_read_only(path.as_path());
                                                            cx.notify();
                                                        }
                                                    }))
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
                                        ),
                                    )
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
                            }),
                    )
                    // Changes section
                    .child(
                        v_flex()
                            .p_2()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .px_1()
                                    .py_0p5()
                                    .justify_between()
                                    .items_center()
                                    .child(
                                        Label::new("Changes")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(
                                        div()
                                            .id("toggle-changes-tab")
                                            .cursor_pointer()
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.left_tab = match this.left_tab {
                                                    LeftTab::Changes => LeftTab::Files,
                                                    LeftTab::Files => LeftTab::Changes,
                                                };
                                                cx.notify();
                                            }))
                                            .child(
                                                Label::new(if active_tab == LeftTab::Changes {
                                                    "Hide"
                                                } else {
                                                    "Show"
                                                })
                                                .size(LabelSize::XSmall)
                                                .color(Color::Accent),
                                            ),
                                    ),
                            )
                            .when(active_tab == LeftTab::Changes, |el| {
                                el.when_some(self.file_changes_panel.as_ref(), |el, panel| {
                                    el.child(panel.clone())
                                })
                                .when(self.file_changes_panel.is_none(), |el| {
                                    el.child(
                                        div().px_2().py_2().child(
                                            Label::new("No changes yet")
                                                .size(LabelSize::Small)
                                                .color(Color::Disabled),
                                        ),
                                    )
                                })
                            }),
                    ),
            )
    }

    fn render_right_panel(
        &self,
        is_running: bool,
        preview_url: Option<String>,
        preview_dominant: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_code_view = matches!(self.right_panel, RightPanel::CodeView { .. });
        let border = cx.theme().colors().border;
        let tab_active_bg = cx.theme().colors().editor_background;
        let tab_hover = cx.theme().colors().element_hover;
        let has_webview = self.web_preview.is_some();
        let workspace = cx.entity().downgrade();

        v_flex()
            .when(preview_dominant, |el| el.flex_1())
            .when(!preview_dominant, |el| el.w(px(320.)).flex_shrink_0())
            .h_full()
            .bg(cx.theme().colors().surface_background)
            // Tab bar: Preview | Code
            .child(
                h_flex()
                    .h(px(36.))
                    .border_b_1()
                    .border_color(border)
                    .bg(cx.theme().colors().panel_background)
                    // Preview tab
                    .child(
                        h_flex()
                            .id("right-tab-preview")
                            .h_full()
                            .px_3()
                            .gap_1p5()
                            .items_center()
                            .cursor_pointer()
                            .border_b_2()
                            .when(!is_code_view, |el| {
                                el.border_color(cx.theme().colors().text_accent)
                                    .bg(tab_active_bg)
                            })
                            .when(is_code_view, |el| {
                                el.border_color(gpui::transparent_white())
                                    .hover(move |el| el.bg(tab_hover))
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.right_panel = RightPanel::Preview;
                                cx.notify();
                            }))
                            .child(
                                Icon::new(IconName::ToolWeb)
                                    .size(IconSize::XSmall)
                                    .color(if !is_code_view { Color::Default } else { Color::Muted }),
                            )
                            .child(
                                Label::new("Preview")
                                    .size(LabelSize::Small)
                                    .color(if !is_code_view { Color::Default } else { Color::Muted }),
                            ),
                    )
                    // Code tab — only shown when a file is open
                    .when(is_code_view, |el| {
                        el.child(
                            h_flex()
                                .id("right-tab-code")
                                .h_full()
                                .px_3()
                                .gap_1p5()
                                .items_center()
                                .cursor_pointer()
                                .border_b_2()
                                .border_color(cx.theme().colors().text_accent)
                                .bg(tab_active_bg)
                                .child(
                                    Icon::new(IconName::File)
                                        .size(IconSize::XSmall)
                                        .color(Color::Default),
                                )
                                .child(
                                    Label::new("Code").size(LabelSize::Small).color(Color::Default),
                                ),
                        )
                    })
                    .child(div().flex_1())
                    // Open-in-browser icon button when URL is available in preview mode
                    .when(!is_code_view, |el| {
                        el.when_some(preview_url.as_ref(), |el, url| {
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
                            .pr_1()
                        })
                    }),
            )
            // URL bar — shown in Preview mode when a URL is available
            .when(!is_code_view, |el| {
                el.child(
                    h_flex()
                        .px_2()
                        .py_1p5()
                        .border_b_1()
                        .border_color(border)
                        .gap_1p5()
                        .items_center()
                        .child(
                            Icon::new(IconName::ToolWeb)
                                .size(IconSize::XSmall)
                                .color(Color::Disabled),
                        )
                        .child(
                            div()
                                .flex_1()
                                .rounded_md()
                                .bg(tab_active_bg)
                                .border_1()
                                .border_color(border)
                                .px_2()
                                .py_0p5()
                                .child(
                                    Label::new(SharedString::from(
                                        preview_url
                                            .as_deref()
                                            .unwrap_or("No preview running")
                                            .to_string(),
                                    ))
                                    .size(LabelSize::XSmall)
                                    .color(if preview_url.is_some() {
                                        Color::Default
                                    } else {
                                        Color::Disabled
                                    })
                                    .truncate(),
                                ),
                        ),
                )
            })
            // Panel body
            .child(if is_code_view {
                if let RightPanel::CodeView { title, content } = &self.right_panel {
                    v_flex()
                        .flex_1()
                        .overflow_hidden()
                        .child(
                            h_flex()
                                .px_3()
                                .py_1p5()
                                .border_b_1()
                                .border_color(border)
                                .gap_1()
                                .items_center()
                                .child(
                                    Icon::new(IconName::File)
                                        .size(IconSize::XSmall)
                                        .color(Color::Muted),
                                )
                                .child(Label::new(title.clone()).size(LabelSize::XSmall).color(Color::Muted)),
                        )
                        .child(
                            v_flex()
                                .id("code-view-scroll")
                                .flex_1()
                                .overflow_y_scroll()
                                .p_3()
                                .child(
                                    Label::new(content.clone())
                                        .size(LabelSize::XSmall)
                                        .color(Color::Default),
                                ),
                        )
                        .into_any_element()
                } else {
                    div().flex_1().into_any_element()
                }
            } else if has_webview {
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
                        Vector::new(VectorName::BackboardLogo, rems_from_px(18.), rems_from_px(24.)),
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
            .when_some(self.model_selector.clone(), |el, selector| {
                el.child(
                    h_flex()
                        .justify_start()
                        .pt_0p5()
                        .child(selector),
                )
            })
    }
}
