use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use acp_thread::{
    AcpThread, AcpThreadEvent, AgentModelList, AgentModelSelector, SelectedPermissionOutcome,
    ThreadStatus, ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use agent_ui::thread_metadata_store::ThreadMetadataStore;
use agent_ui::{AddContextServer, AgentPanel, ConversationView, ModelSelectorPopover};
use anyhow::{Context as AnyhowContext, bail};
use db::kvp::KeyValueStore;
use editor::actions::Newline;
use editor::{Editor, EditorEvent};
use gpui::{
    AnyElement, App, AsyncWindowContext, BoxShadow, ClipboardItem, Context, DragMoveEvent, Entity,
    EventEmitter, FocusHandle, Focusable, FontWeight, Hsla, IntoElement, MouseButton,
    MouseDownEvent, MouseUpEvent, ObjectFit, PathPromptOptions, Pixels, Render, SharedString,
    Subscription, Task, TextStyleRefinement, WeakEntity, Window, WindowControlArea, canvas, img,
    point, rems,
};
use indexmap::IndexMap;
use onboarding::{EXPERIENCE_LEVEL_KVP_KEY, ExperienceLevel};
use project::Project;
use terminal_view::TerminalView;
use ui::{
    Button, ButtonSize, ButtonStyle, Color, ContextMenu, ContextMenuEntry, DropdownMenu,
    DropdownStyle, ElevationIndex, Icon, IconButton, IconName, IconPosition, IconSize, Label,
    LabelSize, Tooltip, prelude::*,
};
use util::ResultExt;
use workspace::{MultiWorkspace, PathList, Workspace, notifications::DetachAndPromptErr};
use zed_actions::{ConfigureBackboardApiKey, OpenSettings, ResetOnboarding};

use acp_thread::AgentThreadEntry;

use crate::beginner_chat_feed::{BeginnerChatFeed, BeginnerChatFeedEvent, PreviewCardState};
use crate::file_changes_panel::{FileChangesPanel, FileChangesPanelEvent};
use crate::simple_design as ds;

/// Provider/model ID prefixes for the curated simple-mode model list.
/// Matched against ACP model IDs of the form "provider/model-name".
/// Each entry is (provider_prefix, model_id_prefix, display_name).
static CURATED_MODELS: &[(&str, &str, &str)] = &[
    // ── Anthropic ──────────────────────────────────────────────────────
    ("anthropic", "claude-opus-4", "Claude Opus 4 · Powerful"),
    ("anthropic", "claude-sonnet-4", "Claude Sonnet 4 · Balanced"),
    ("anthropic", "claude-haiku-4", "Claude Haiku 4 · Fast"),
    // ── OpenAI ─────────────────────────────────────────────────────────
    ("openai", "gpt-5.5", "GPT-5.5 · Powerful"),
    ("openai", "gpt-5", "GPT-5 · Balanced"),
    ("openai", "gpt-", "GPT · OpenAI"),
    ("openai", "o3", "o3 · Reasoning"),
    ("openai", "o4-mini", "o4-mini · Fast reasoning"),
    // ── Google ─────────────────────────────────────────────────────────
    ("google", "gemini-2.5-pro", "Gemini 2.5 Pro · Powerful"),
    ("google", "gemini-2.5-flash", "Gemini 2.5 Flash · Fast"),
    ("google", "gemini-", "Gemini · Google"),
    // ── DeepSeek ───────────────────────────────────────────────────────
    ("deepseek", "deepseek-r1", "DeepSeek R1 · Reasoning"),
    ("deepseek", "deepseek-v3", "DeepSeek V3 · Balanced"),
    ("deepseek", "deepseek-v4", "DeepSeek V4 · Powerful"),
    ("deepseek", "deepseek-", "DeepSeek"),
];

const SIMPLE_LANDING_LOGO_PATH: &str = "images/animation_logo.png";
const SIMPLE_PREVIEW_PORT: u16 = 3000;

struct PreviewLaunch {
    folder: PathBuf,
    command: String,
    url_path: String,
}

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

fn folder_display_name(folder: &Path) -> SharedString {
    folder
        .file_name()
        .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| SharedString::from(folder.to_string_lossy().into_owned()))
}

fn folder_parent_display_name(folder: &Path) -> Option<SharedString> {
    folder
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
}

fn folder_matches_search(folder: &Path, search_query: &str) -> bool {
    if search_query.is_empty() {
        return true;
    }

    let folder_name = folder_display_name(folder).to_lowercase();
    let parent_name = folder_parent_display_name(folder)
        .map(|name| name.to_lowercase())
        .unwrap_or_default();
    folder_name.contains(search_query)
        || parent_name.contains(search_query)
        || folder
            .to_string_lossy()
            .to_lowercase()
            .contains(search_query)
}

#[derive(Clone, Default)]
struct ComposerGitState {
    is_loading: bool,
    is_git_repository: bool,
    current_branch: Option<SharedString>,
    branches: Vec<SharedString>,
}

fn render_preview_feature_card(
    title: &'static str,
    subtitle: &'static str,
    accent_background: Hsla,
    cx: &mut Context<BeginnerWorkspace>,
) -> impl IntoElement {
    v_flex()
        .flex_1()
        .min_w_0()
        .h(px(108.))
        .rounded(px(8.))
        .border_1()
        .border_color(ds::soft_border(cx))
        .bg(ds::field_background(cx))
        .p_4()
        .gap_2()
        .child(div().size(px(24.)).rounded(px(6.)).bg(accent_background))
        .child(
            Label::new(title)
                .size(LabelSize::Small)
                .weight(FontWeight::SEMIBOLD)
                .color(Color::Custom(ds::text(cx))),
        )
        .child(
            Label::new(subtitle)
                .size(LabelSize::XSmall)
                .color(Color::Custom(ds::text_muted(cx))),
        )
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
            let mut grouped: IndexMap<String, Vec<acp_thread::AgentModelInfo>> =
                IndexMap::default();
            for &(provider_id, model_prefix, display_name) in CURATED_MODELS {
                let info = if let Some(mut info) = all_models
                    .iter()
                    .find(|m| {
                        let id: &str = &m.id.0;
                        let model_part = id.split_once('/').map(|(_, part)| part).unwrap_or(id);
                        model_part.starts_with(model_prefix)
                    })
                    .cloned()
                {
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
                return Ok(AgentModelList::Flat(
                    all_models.into_iter().take(10).collect(),
                ));
            }
            let grouped = grouped.into_iter().map(|(k, mut v)| {
                v.sort_by_key(|m| model_speed_rank(m.name.as_ref(), m.id.0.as_ref()));
                (acp_thread::AgentModelGroupName(k.into()), v)
            });
            Ok(AgentModelList::Grouped(grouped.collect()))
        })
    }

    fn select_model(&self, model_id: acp::ModelId, cx: &mut App) -> gpui::Task<anyhow::Result<()>> {
        self.inner.select_model(model_id, cx)
    }

    fn selected_model(
        &self,
        cx: &mut App,
    ) -> gpui::Task<anyhow::Result<acp_thread::AgentModelInfo>> {
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
const BEGINNER_OPEN_TABS_KVP_KEY: &str = "beginner_open_tabs_v1";
const SIMPLE_COMPOSER_MIN_LINES: usize = 3;
const SIMPLE_COMPOSER_MAX_LINES: usize = 12;
static SIMPLE_MODE_OPENED_THIS_PROCESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
struct DraggedSimpleSidebarResize;

#[derive(Debug, Clone)]
struct DraggedSimplePanelResize;

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

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct BeginnerOpenTabsState {
    #[serde(default)]
    active_record_id: Option<String>,
    #[serde(default)]
    background_record_ids: Vec<String>,
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

    fn display_name(&self) -> SharedString {
        let name = self.name.trim();
        if name.is_empty() || name.chars().all(|ch| ch == '.') {
            SharedString::from("Untitled chat")
        } else {
            SharedString::from(name)
        }
    }
}

pub enum BeginnerWorkspaceEvent {
    SwitchToEditor,
}

impl EventEmitter<BeginnerWorkspaceEvent> for BeginnerWorkspace {}

enum BeginnerState {
    Landing,
    ActiveProject,
}

#[derive(Clone, Copy, PartialEq)]
enum LeftTab {
    Files,
}

enum RightPanel {
    Preview,
    CodeEmpty,
    CodeView {
        title: SharedString,
        content: SharedString,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArtifactIllustrationState {
    Empty,
    Working,
    Error,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RightPanelMode {
    Artifact,
    Launcher,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RightPanelOption {
    Files,
    SideChat,
    Design,
    Code,
    Terminal,
}

impl RightPanelOption {
    const VISIBLE: [RightPanelOption; 5] = [
        RightPanelOption::Files,
        RightPanelOption::SideChat,
        RightPanelOption::Design,
        RightPanelOption::Code,
        RightPanelOption::Terminal,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Files => "Files",
            Self::SideChat => "Side chat",
            Self::Design => "Design",
            Self::Code => "Code",
            Self::Terminal => "Terminal",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Files => IconName::FolderOpen,
            Self::SideChat => IconName::Chat,
            Self::Design => IconName::Public,
            Self::Code => IconName::FileCode,
            Self::Terminal => IconName::Terminal,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChatMode {
    Ask,
    Build,
}

impl ChatMode {
    fn label(self) -> &'static str {
        match self {
            ChatMode::Ask => "Ask",
            ChatMode::Build => "Build",
        }
    }

    fn placeholder(self) -> &'static str {
        "Ask Backboard..."
    }

    fn follow_up_placeholder(self) -> &'static str {
        "Ask Backboard..."
    }

    fn prompt_prefix(self) -> &'static str {
        match self {
            ChatMode::Ask => {
                concat!(
                    "Ask mode: answer without editing files or making project changes unless I explicitly ask you to switch to build mode.\n",
                    "Ask focused clarifying questions when the request is underspecified, especially when the answer depends on project goals, audience, constraints, or user intent."
                )
            }
            ChatMode::Build => {
                concat!(
                    "Simple build mode: build or edit the project for a nontechnical user.\n",
                    "- Default to creating a polished web app or page when the user asks for a product, app, page, dashboard, tool, game, or visual experience and does not specify another medium.\n",
                    "- Do not force a web app when the user explicitly asks for another artifact, such as docs, scripts, data work, configuration, terminal help, or repository cleanup.\n",
                    "- Ask focused clarifying questions before building when core product, audience, content, brand, data, platform, or style choices are missing. Prefer 1-3 short questions at a time, and state sensible defaults when proceeding would be better than waiting.\n",
                    "- Keep visible chat replies short, natural, and outcome-focused. Do not show code, filenames, commands, raw logs, markdown-heavy checklists, or implementation details unless the user asks.\n",
                    "- Do not narrate implementation mechanics in chat. Avoid phrases like updating files, creating HTML/CSS/JavaScript files, editing components, running commands, or changing specific filenames. Say what user-facing experience is being built instead.\n",
                    "- Summarize edits as product changes. Let the UI expose file counts and read-only diffs separately, such as Backboard changed 3 files.\n",
                    "- Treat code and diffs as read-only review surfaces for the user.\n",
                    "- After creating or updating a runnable artifact, start or refresh the preview."
                )
            }
        }
    }

    fn prepare_message(self, text: String) -> String {
        text
    }
}

struct ProjectSession {
    chat_record_id: Option<String>,
    state: BeginnerState,
    tab_name: SharedString,
    chat_mode: ChatMode,
    chat_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    pending_conversation_view: Option<Entity<ConversationView>>,
    active_conversation_view: Option<Entity<ConversationView>>,
    queued_composer_submit: Option<String>,
    model_selector: Option<Entity<ModelSelectorPopover>>,
    is_agent_running: bool,
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    raw_browse_path: Option<PathBuf>,
    right_panel: RightPanel,
    right_panel_open: bool,
    right_panel_mode: RightPanelMode,
    right_panel_option: RightPanelOption,
    share_dialog_open: bool,
    preview_url: Option<String>,
    preview_visible: bool,
    is_preview_generating: bool,
    terminal_view: Option<Entity<TerminalView>>,
    terminal_working_directory: Option<PathBuf>,
    // Fixed local preview port used by the active simple-mode preview.
    dev_server_port: Option<u16>,
    #[allow(dead_code)]
    web_preview: Option<crate::web_preview::WebPreview>,
    dev_server_task: Option<Task<()>>,
    subscriptions: Vec<Subscription>,
}

struct SidebarProjectGroup {
    folder_path: PathBuf,
    records: Vec<BeginnerChatRecord>,
}

impl SidebarProjectGroup {
    fn new(folder_path: PathBuf) -> Self {
        Self {
            folder_path,
            records: Vec::new(),
        }
    }

    fn add_record(&mut self, record: BeginnerChatRecord) {
        self.records.push(record);
    }
}

pub struct BeginnerWorkspace {
    workspace: WeakEntity<Workspace>,
    #[allow(dead_code)]
    multi_workspace: WeakEntity<MultiWorkspace>,
    project: Entity<Project>,
    focus_handle: FocusHandle,
    state: BeginnerState,
    active_chat_record_id: Option<String>,
    // Human-readable tab name generated from the initial prompt.
    tab_name: SharedString,
    chat_mode: ChatMode,
    chat_editor: Entity<Editor>,
    chat_search_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    composer_git_state: ComposerGitState,
    composer_git_state_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    // Kept alive for the entire session lifetime. The ConversationView owns the
    // ThreadView which owns the send task — dropping it cancels in-flight sends.
    // "pending" while connecting; remains alive after connected to keep ThreadView alive.
    pending_conversation_view: Option<Entity<ConversationView>>,
    // Kept alive after connection so that ThreadView (and its send tasks) are not dropped.
    active_conversation_view: Option<Entity<ConversationView>>,
    queued_composer_submit: Option<String>,
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
    right_panel_open: bool,
    right_panel_mode: RightPanelMode,
    right_panel_option: RightPanelOption,
    chat_panel_width: Pixels,
    share_dialog_open: bool,
    // URL of the running dev server once it's ready.
    preview_url: Option<String>,
    preview_visible: bool,
    is_preview_generating: bool,
    terminal_view: Option<Entity<TerminalView>>,
    terminal_working_directory: Option<PathBuf>,
    // Fixed local preview port used by the active simple-mode preview.
    dev_server_port: Option<u16>,
    // Polling task for start_dev_server; stored per-session so it cancels on stash/switch.
    dev_server_task: Option<Task<()>>,
    // Embedded web preview. Created lazily in render() once we have both a
    // preview_url and the Window handle. None on Linux (unsupported).
    web_preview: Option<crate::web_preview::WebPreview>,
    // Shows a notice when the user tries to open a 4th tab.
    show_tab_limit_notice: bool,
    chats_sidebar_open: bool,
    chats_sidebar_width: Pixels,
    background_sessions: Vec<ProjectSession>,
    chat_history: Vec<BeginnerChatRecord>,
    pending_open_tabs: Option<BeginnerOpenTabsState>,
    open_tabs_loaded: bool,
    open_tabs_restored: bool,
    _tasks: Vec<Task<()>>,
    _project_subscription: Subscription,
    _search_subscription: Subscription,
    session_subscriptions: Vec<Subscription>,
}

impl BeginnerWorkspace {
    fn handle_enter_submit(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_follow_up(window, cx);
    }

    fn has_backboard_api_key() -> bool {
        backboard::BackboardConfig::load_or_default()
            .api_key()
            .is_some()
    }

    fn open_api_key_settings(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
    }

    fn make_chat_editor(
        window: &mut Window,
        cx: &mut Context<Self>,
        placeholder: &str,
    ) -> (Entity<Editor>, Subscription) {
        let workspace = cx.entity().downgrade();
        let editor = cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 10, window, cx);
            editor.set_placeholder_text(placeholder, window, cx);
            editor.set_soft_wrap();
            editor
        });
        let subscription = editor.update(cx, |editor, _cx| {
            let workspace = workspace.clone();
            editor.register_action(move |_: &Newline, window, cx| {
                workspace
                    .update(cx, |this, cx| {
                        this.submit_follow_up(window, cx);
                    })
                    .ok();
            })
        });
        (editor, subscription)
    }

    fn make_search_editor(window: &mut Window, cx: &mut Context<Self>) -> Entity<Editor> {
        cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            editor.set_text_style_refinement(TextStyleRefinement {
                color: Some(ds::sidebar_emphasis_text(cx)),
                font_size: Some(rems(0.9375).into()),
                font_weight: Some(FontWeight::SEMIBOLD),
                ..Default::default()
            });
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor
        })
    }

    fn current_tab_title(&self) -> SharedString {
        match &self.state {
            BeginnerState::ActiveProject => self.tab_name.clone(),
            BeginnerState::Landing => SharedString::from("Simple Page Builder"),
        }
    }

    fn project_tab_count(&self) -> usize {
        usize::from(matches!(self.state, BeginnerState::ActiveProject))
            + self
                .background_sessions
                .iter()
                .filter(|session| matches!(session.state, BeginnerState::ActiveProject))
                .count()
    }

    fn stash_current_session_and_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, BeginnerState::Landing) {
            self.new_project(window, cx);
            return;
        }

        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();

        let (replacement_editor, enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let session = ProjectSession {
            chat_record_id: self.active_chat_record_id.take(),
            state: std::mem::replace(&mut self.state, BeginnerState::Landing),
            tab_name: std::mem::replace(&mut self.tab_name, SharedString::from("Home")),
            chat_mode: std::mem::replace(&mut self.chat_mode, ChatMode::Build),
            chat_editor: std::mem::replace(&mut self.chat_editor, replacement_editor),
            selected_folder: self.selected_folder.take(),
            thread: self.thread.take(),
            pending_conversation_view: self.pending_conversation_view.take(),
            active_conversation_view: self.active_conversation_view.take(),
            queued_composer_submit: self.queued_composer_submit.take(),
            model_selector: self.model_selector.take(),
            is_agent_running: std::mem::replace(&mut self.is_agent_running, false),
            agent_finished: std::mem::replace(&mut self.agent_finished, false),
            chat_feed: self.chat_feed.take(),
            file_changes_panel: self.file_changes_panel.take(),
            left_tab: std::mem::replace(&mut self.left_tab, LeftTab::Files),
            show_raw_files: std::mem::replace(&mut self.show_raw_files, false),
            raw_browse_path: self.raw_browse_path.take(),
            right_panel: std::mem::replace(&mut self.right_panel, RightPanel::Preview),
            right_panel_open: std::mem::replace(&mut self.right_panel_open, false),
            right_panel_mode: std::mem::replace(
                &mut self.right_panel_mode,
                RightPanelMode::Artifact,
            ),
            right_panel_option: std::mem::replace(
                &mut self.right_panel_option,
                RightPanelOption::Files,
            ),
            share_dialog_open: std::mem::replace(&mut self.share_dialog_open, false),
            preview_url: self.preview_url.take(),
            preview_visible: std::mem::replace(&mut self.preview_visible, false),
            is_preview_generating: std::mem::replace(&mut self.is_preview_generating, false),
            terminal_view: self.terminal_view.take(),
            terminal_working_directory: self.terminal_working_directory.take(),
            dev_server_port: self.dev_server_port.take(),
            // Drop the live webview by not carrying it into the stash.
            // Only the active session may own a live preview; starting another
            // preview clears stashed preview state and restarts the fixed port.
            web_preview: None,
            dev_server_task: self.dev_server_task.take(),
            subscriptions: std::mem::take(&mut self.session_subscriptions),
        };
        // Drop the active webview so the WKWebView is removed from the window immediately.
        self.web_preview = None;
        // The new editor's Enter-to-submit subscription belongs to the fresh session.
        self.session_subscriptions.push(enter_sub);
        self.background_sessions.push(session);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn switch_to_session(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.background_sessions.len() {
            return;
        }
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        let session = &mut self.background_sessions[ix];
        session.preview_url = None;
        session.preview_visible = false;
        session.is_preview_generating = false;
        session.web_preview = None;
        session.dev_server_port = None;
        session.dev_server_task = None;

        std::mem::swap(&mut self.active_chat_record_id, &mut session.chat_record_id);
        std::mem::swap(&mut self.state, &mut session.state);
        std::mem::swap(&mut self.tab_name, &mut session.tab_name);
        std::mem::swap(&mut self.chat_mode, &mut session.chat_mode);
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
        std::mem::swap(
            &mut self.queued_composer_submit,
            &mut session.queued_composer_submit,
        );
        std::mem::swap(&mut self.model_selector, &mut session.model_selector);
        std::mem::swap(&mut self.is_agent_running, &mut session.is_agent_running);
        std::mem::swap(&mut self.agent_finished, &mut session.agent_finished);
        std::mem::swap(&mut self.chat_feed, &mut session.chat_feed);
        std::mem::swap(
            &mut self.file_changes_panel,
            &mut session.file_changes_panel,
        );
        std::mem::swap(&mut self.left_tab, &mut session.left_tab);
        std::mem::swap(&mut self.show_raw_files, &mut session.show_raw_files);
        std::mem::swap(&mut self.raw_browse_path, &mut session.raw_browse_path);
        std::mem::swap(&mut self.right_panel, &mut session.right_panel);
        std::mem::swap(&mut self.right_panel_open, &mut session.right_panel_open);
        std::mem::swap(&mut self.right_panel_mode, &mut session.right_panel_mode);
        std::mem::swap(
            &mut self.right_panel_option,
            &mut session.right_panel_option,
        );
        std::mem::swap(&mut self.share_dialog_open, &mut session.share_dialog_open);
        std::mem::swap(&mut self.preview_url, &mut session.preview_url);
        std::mem::swap(&mut self.preview_visible, &mut session.preview_visible);
        std::mem::swap(
            &mut self.is_preview_generating,
            &mut session.is_preview_generating,
        );
        std::mem::swap(&mut self.terminal_view, &mut session.terminal_view);
        std::mem::swap(
            &mut self.terminal_working_directory,
            &mut session.terminal_working_directory,
        );
        std::mem::swap(&mut self.dev_server_port, &mut session.dev_server_port);
        std::mem::swap(&mut self.dev_server_task, &mut session.dev_server_task);
        // Drop the active webview — background sessions never hold a live one.
        // render() will recreate it from preview_url for the new active session.
        self.web_preview = None;
        std::mem::swap(&mut self.session_subscriptions, &mut session.subscriptions);
        let placeholder = if matches!(self.state, BeginnerState::ActiveProject) {
            self.chat_mode.follow_up_placeholder()
        } else {
            self.chat_mode.placeholder()
        };
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(placeholder, window, cx);
        });
        self.refresh_composer_git_state_if_needed(cx);
        self.restore_active_chat_if_needed(window, cx);
        self.save_open_tabs(cx);
        cx.notify();
    }

    pub fn new(
        workspace: WeakEntity<Workspace>,
        multi_workspace: WeakEntity<MultiWorkspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (chat_editor, chat_enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let chat_search_editor = Self::make_search_editor(window, cx);
        let search_sub = cx.subscribe(&chat_search_editor, |_, _, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Edited { .. }) {
                cx.notify();
            }
        });

        let load_recent = Self::load_chat_history(workspace.clone(), cx);
        let config_changes = backboard::subscribe_config_changes();
        let watch_api_key = cx.spawn(async move |this, cx| {
            while config_changes.recv().await.is_ok() {
                this.update(cx, |_, cx| cx.notify()).ok();
            }
        });

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
            active_chat_record_id: None,
            tab_name: SharedString::from("Home"),
            chat_mode: ChatMode::Build,
            chat_editor,
            chat_search_editor,
            selected_folder: initial_folder,
            composer_git_state: ComposerGitState::default(),
            composer_git_state_folder: None,
            thread: None,
            pending_conversation_view: None,
            active_conversation_view: None,
            queued_composer_submit: None,
            model_selector: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            raw_browse_path: None,
            right_panel: RightPanel::Preview,
            right_panel_open: false,
            right_panel_mode: RightPanelMode::Artifact,
            right_panel_option: RightPanelOption::Files,
            chat_panel_width: px(ds::CHAT_PANEL_WIDTH),
            share_dialog_open: false,
            preview_url: None,
            preview_visible: false,
            is_preview_generating: false,
            terminal_view: None,
            terminal_working_directory: None,
            dev_server_port: None,
            dev_server_task: None,
            web_preview: None,
            show_tab_limit_notice: false,
            chats_sidebar_open: true,
            chats_sidebar_width: px(ds::SIDEBAR_WIDTH),
            background_sessions: Vec::new(),
            chat_history: Vec::new(),
            pending_open_tabs: None,
            open_tabs_loaded: false,
            open_tabs_restored: false,
            _tasks: vec![load_recent, watch_api_key],
            _project_subscription: project_sub,
            _search_subscription: search_sub,
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
            (BeginnerState::ActiveProject, None) => {
                // All folders removed — return to landing.
                self.selected_folder = None;
                self.clear_composer_git_state();
                self.state = BeginnerState::Landing;
                self.chat_feed = None;
                self.thread = None;
                self.pending_conversation_view = None;
                self.active_conversation_view = None;
                self.queued_composer_submit = None;
                self.file_changes_panel = None;
                self.is_agent_running = false;
                self.right_panel = RightPanel::Preview;
                self.right_panel_open = false;
                self.right_panel_mode = RightPanelMode::Artifact;
                self.right_panel_option = RightPanelOption::Files;
                self.share_dialog_open = false;
                self.preview_url = None;
                self.preview_visible = false;
                self.is_preview_generating = false;
                self.terminal_view = None;
                self.terminal_working_directory = None;
                self.web_preview = None;
                cx.notify();
            }
            _ => {}
        }
    }

    fn load_chat_history(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let kvp = cx.update(|cx| {
                let _ = workspace; // keep alive
                KeyValueStore::global(cx)
            });
            let records = kvp
                .read_kvp(BEGINNER_CHATS_KVP_KEY)
                .log_err()
                .flatten()
                .and_then(|json| serde_json::from_str::<Vec<BeginnerChatRecord>>(&json).log_err())
                .unwrap_or_default();
            let open_tabs = kvp
                .read_kvp(BEGINNER_OPEN_TABS_KVP_KEY)
                .log_err()
                .flatten()
                .and_then(|json| serde_json::from_str::<BeginnerOpenTabsState>(&json).log_err())
                .unwrap_or_default();
            this.update(cx, |this, cx| {
                this.chat_history = records;
                this.pending_open_tabs = Some(open_tabs);
                this.open_tabs_loaded = true;
                cx.notify();
            })
            .ok();
        })
    }

    fn save_chat_history(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let records = self.chat_history.clone();
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&records) {
                kvp.write_kvp(BEGINNER_CHATS_KVP_KEY.to_string(), json)
                    .await
                    .log_err();
            }
        })
        .detach();
    }

    fn save_open_tabs(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let state = BeginnerOpenTabsState {
            active_record_id: self.active_chat_record_id.clone(),
            background_record_ids: self
                .background_sessions
                .iter()
                .filter_map(|session| session.chat_record_id.clone())
                .collect(),
        };
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&state) {
                kvp.write_kvp(BEGINNER_OPEN_TABS_KVP_KEY.to_string(), json)
                    .await
                    .log_err();
            }
        })
        .detach();
    }

    fn run_git_command(folder: &Path, args: &[&str]) -> anyhow::Result<String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .output()
            .with_context(|| format!("failed to run git in {}", folder.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let command = args.join(" ");
            if stderr.is_empty() {
                bail!("git {command} failed");
            }
            bail!("git {command} failed: {stderr}");
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn read_composer_git_state(folder: &Path) -> anyhow::Result<ComposerGitState> {
        let inside_worktree =
            Self::run_git_command(folder, &["rev-parse", "--is-inside-work-tree"])?;
        if inside_worktree != "true" {
            bail!("{} is not a git repository", folder.display());
        }

        let branch_name = Self::run_git_command(folder, &["branch", "--show-current"])?;
        let current_branch = if branch_name.is_empty() {
            Self::run_git_command(folder, &["rev-parse", "--short", "HEAD"])
                .ok()
                .filter(|sha| !sha.is_empty())
        } else {
            Some(branch_name)
        }
        .map(SharedString::from);

        let branches = Self::run_git_command(folder, &["branch", "--format=%(refname:short)"])?
            .lines()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(|branch| SharedString::from(branch.to_string()))
            .collect();

        Ok(ComposerGitState {
            is_loading: false,
            is_git_repository: true,
            current_branch,
            branches,
        })
    }

    fn clear_composer_git_state(&mut self) {
        self.composer_git_state = ComposerGitState::default();
        self.composer_git_state_folder = None;
    }

    fn refresh_composer_git_state_if_needed(&mut self, cx: &mut Context<Self>) {
        if self.composer_git_state_folder == self.selected_folder {
            return;
        }

        self.composer_git_state_folder = self.selected_folder.clone();
        let Some(folder) = self.selected_folder.clone() else {
            self.composer_git_state = ComposerGitState::default();
            return;
        };

        self.composer_git_state = ComposerGitState {
            is_loading: true,
            ..ComposerGitState::default()
        };

        cx.spawn(async move |this, cx| {
            let folder_for_git = folder.clone();
            let state = cx
                .background_spawn(async move { Self::read_composer_git_state(&folder_for_git) })
                .await;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder) {
                    return;
                }

                this.composer_git_state = state.unwrap_or_default();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn switch_composer_git_branch(
        &mut self,
        branch_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return;
        };

        cx.spawn_in(window, async move |this, cx| {
            let folder_for_git = folder.clone();
            let branch_name_for_git = branch_name.clone();
            let state = cx
                .background_spawn(async move {
                    Self::run_git_command(
                        &folder_for_git,
                        &["switch", branch_name_for_git.as_str()],
                    )?;
                    Self::read_composer_git_state(&folder_for_git)
                })
                .await?;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() == Some(&folder) {
                    this.composer_git_state_folder = Some(folder);
                    this.composer_git_state = state;
                    cx.notify();
                }
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err("Failed to switch branch", window, cx, |_, _, _| None);
    }

    fn initialize_composer_git_repository(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return;
        };

        self.composer_git_state = ComposerGitState {
            is_loading: true,
            ..ComposerGitState::default()
        };
        self.composer_git_state_folder = Some(folder.clone());
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let folder_for_git = folder.clone();
            let state = cx
                .background_spawn(async move {
                    Self::run_git_command(&folder_for_git, &["init"])?;
                    Self::read_composer_git_state(&folder_for_git)
                })
                .await?;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder) {
                    return;
                }

                this.composer_git_state = state;
                cx.notify();
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err(
            "Failed to initialize Git repository",
            window,
            cx,
            |_, _, _| None,
        );
    }

    fn add_chat_record(&mut self, name: String, folder: &PathBuf, cx: &mut App) -> String {
        let record = BeginnerChatRecord::new(name, folder);
        let id = record.id.clone();
        // Insert at front so most-recent appears first; cap at 50 entries.
        self.chat_history.insert(0, record);
        self.chat_history.truncate(50);
        self.save_chat_history(cx);
        id
    }

    fn touch_chat_record(&mut self, id: &str, cx: &mut App) {
        let Some(index) = self.chat_history.iter().position(|record| record.id == id) else {
            return;
        };
        let mut record = self.chat_history.remove(index);
        record.timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(record.timestamp_ms);
        self.chat_history.insert(0, record);
        self.save_chat_history(cx);
    }

    fn update_latest_chat_record_session_id(
        &mut self,
        folder: &PathBuf,
        session_id: String,
        cx: &mut App,
    ) {
        let record = if let Some(active_id) = self.active_chat_record_id.clone() {
            self.chat_history
                .iter_mut()
                .find(|record| record.id == active_id)
        } else {
            self.chat_history
                .iter_mut()
                .find(|record| record.folder() == *folder && record.session_id.is_none())
        };

        if let Some(record) = record {
            record.session_id = Some(session_id);
            self.save_chat_history(cx);
        }
    }

    fn delete_chat_record(&mut self, id: String, cx: &mut App) {
        self.chat_history.retain(|r| r.id != id);
        self.background_sessions
            .retain(|session| session.chat_record_id.as_deref() != Some(id.as_str()));
        if self.active_chat_record_id.as_deref() == Some(id.as_str()) {
            self.active_chat_record_id = None;
        }
        self.save_chat_history(cx);
        self.save_open_tabs(cx);
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
            let conversation_view_to_send = this
                .update_in(cx, |this, window, cx| {
                    this.selected_folder = Some(folder);
                    this.refresh_composer_git_state_if_needed(cx);
                    if let (Some(thread), Some(folder)) =
                        (this.thread.clone(), this.selected_folder.clone())
                    {
                        thread.update(cx, |thread, cx| {
                            thread.set_work_dirs(PathList::new(&[folder]), cx);
                        });
                    }
                    // If the user already typed a prompt, submit immediately so they
                    // don't need to click "Create Project" a second time.
                    let has_text = !this.chat_editor.read(cx).text(cx).trim().is_empty();
                    if has_text {
                        this.submit(window, cx);
                        None
                    } else if this.active_conversation_view.as_ref().is_some_and(|view| {
                        view.read(cx)
                            .root_message_editor_is_empty(cx)
                            .is_some_and(|is_empty| !is_empty)
                    }) {
                        this.active_conversation_view.clone()
                    } else {
                        if this.thread.is_none() {
                            this.start_agent_thread(String::new(), window, cx);
                            this.is_agent_running = false;
                        }
                        cx.notify();
                        None
                    }
                })
                .ok()
                .flatten();

            if let Some(conversation_view) = conversation_view_to_send {
                conversation_view
                    .downgrade()
                    .update_in(cx, |view, window, cx| {
                        view.send_root_message_editor(window, cx);
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return;
        }

        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() {
            return;
        }
        let agent_text = self.chat_mode.prepare_message(text.clone());

        let folder = match &self.selected_folder {
            Some(f) => f.clone(),
            None => {
                self.pick_folder(window, cx);
                return;
            }
        };

        let chat_name = generate_chat_name(&text);
        self.tab_name = SharedString::from(chat_name.clone());
        self.state = BeginnerState::ActiveProject;
        // Save the chat to history before starting, so it appears on the home page
        // even if the user immediately closes without waiting for the agent.
        let record_id = self.add_chat_record(chat_name, &folder, cx);
        self.active_chat_record_id = Some(record_id);
        self.save_open_tabs(cx);

        // If a draft thread is already present (for pre-send model selection),
        // keep it and send as follow-up so the chosen model is respected.
        if self.thread.is_some() {
            self.submit_follow_up(window, cx);
            return;
        }

        if self.pending_conversation_view.is_some() || self.active_conversation_view.is_some() {
            self.queued_composer_submit = Some(agent_text);
            self.chat_editor.update(cx, |editor, cx| {
                editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
                editor.set_text("", window, cx);
            });
            Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
            self.clear_current_preview_state();
            self.is_agent_running = true;
            self.agent_finished = false;
            self.send_queued_composer_submit(window, cx);
            cx.notify();
            return;
        }

        // Clear all previous session state so the new project starts completely fresh.
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.share_dialog_open = false;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        cx.notify();

        let workspace = self.workspace.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            Self::open_folder_and_start_agent(this, workspace, folder, agent_text, cx).await;
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
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.share_dialog_open = false;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
            editor.set_text("", window, cx);
        });
        cx.notify();
    }

    fn ensure_composer_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key()
            || self.thread.is_some()
            || self.pending_conversation_view.is_some()
            || self.active_conversation_view.is_some()
        {
            return;
        }

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
        let conversation_view = agent_panel.update(cx, |panel, cx| {
            panel.spawn_beginner_thread(String::new(), work_dirs, window, cx)
        });
        self.bind_conversation_view(conversation_view, window, cx);
    }

    fn configure_thread_composer(
        &self,
        conversation_view: &Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prompt_prefix = SharedString::from(self.chat_mode.prompt_prefix());
        let draft_text = self.chat_editor.read(cx).text(cx);
        let workspace = cx.entity().downgrade();
        conversation_view.update(cx, |conversation_view, cx| {
            conversation_view.set_root_prompt_prefix(Some(prompt_prefix), cx);
            conversation_view.set_root_message_editor_auto_height(
                SIMPLE_COMPOSER_MIN_LINES,
                Some(SIMPLE_COMPOSER_MAX_LINES),
                cx,
            );
            conversation_view.seed_root_message_text_if_empty(draft_text, window, cx);
            conversation_view.set_root_before_send_hook(
                Some(Rc::new(move |text, window, cx| {
                    workspace
                        .update(cx, |workspace, cx| {
                            workspace.prepare_thread_composer_send(text, window, cx)
                        })
                        .unwrap_or(false)
                })),
                cx,
            );
        });
    }

    fn sync_thread_prompt_prefix(&self, cx: &mut Context<Self>) {
        let prompt_prefix = SharedString::from(self.chat_mode.prompt_prefix());
        if let Some(conversation_view) = self
            .active_conversation_view
            .as_ref()
            .or(self.pending_conversation_view.as_ref())
        {
            conversation_view.update(cx, |conversation_view, cx| {
                conversation_view.set_root_prompt_prefix(Some(prompt_prefix), cx);
            });
        }
    }

    fn prepare_thread_composer_send(
        &mut self,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return false;
        }

        let text = text.trim();
        if text.is_empty() {
            return false;
        }

        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return false;
        };

        let work_dirs = PathList::new(&[folder.clone()]);
        if let Some(thread) = self.thread.clone() {
            thread.update(cx, |thread, cx| {
                thread.set_work_dirs(work_dirs.clone(), cx);
            });
        }

        if matches!(self.state, BeginnerState::Landing) {
            let chat_name = generate_chat_name(text);
            self.tab_name = SharedString::from(chat_name.clone());
            self.state = BeginnerState::ActiveProject;
            let record_id = self.add_chat_record(chat_name, &folder, cx);
            self.active_chat_record_id = Some(record_id.clone());
            if let Some(thread) = self.thread.clone() {
                let session_id = thread.read(cx).session_id().0.to_string();
                self.update_latest_chat_record_session_id(&folder, session_id, cx);
                thread.update(cx, |thread, cx| {
                    thread.set_provisional_title(SharedString::from(generate_chat_name(text)), cx);
                });
            }
            self.save_open_tabs(cx);
        } else if let Some(record_id) = self.active_chat_record_id.clone() {
            self.touch_chat_record(&record_id, cx);
        }

        self.web_preview = None;
        self.preview_url = None;
        self.preview_visible = false;
        self.is_preview_generating = false;
        self.is_agent_running = true;
        self.agent_finished = false;
        cx.notify();
        true
    }

    fn submit_follow_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return;
        }

        // If no agent thread has started yet (e.g. app launched with a project
        // already open), treat this as the initial submission.
        if self.thread.is_none() {
            self.submit(window, cx);
            return;
        }

        if self.selected_folder.is_none() {
            self.submit(window, cx);
            return;
        }

        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() || self.is_agent_running {
            return;
        }
        let agent_text = self.chat_mode.prepare_message(text);
        let Some(thread) = self.thread.clone() else {
            return;
        };
        if let Some(folder) = self.selected_folder.clone() {
            thread.update(cx, |thread, cx| {
                thread.set_work_dirs(PathList::new(&[folder]), cx);
            });
        }
        if let Some(record_id) = self.active_chat_record_id.clone() {
            self.touch_chat_record(&record_id, cx);
        }

        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
            editor.set_text("", window, cx);
        });
        // Stop any old preview while the next response and preview are generated.
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.is_agent_running = true;
        cx.notify();

        cx.spawn(async move |_this, cx| {
            let future = thread.update(cx, |t, cx| t.send(vec![agent_text.as_str().into()], cx));
            future.await.log_err();
        })
        .detach();
    }

    fn handle_file_panel_event(&mut self, event: &FileChangesPanelEvent, cx: &mut Context<Self>) {
        match event {
            FileChangesPanelEvent::FileSelected(_path) => {
                self.show_changes_diff(cx);
            }
        }
    }

    fn handle_chat_feed_event(&mut self, event: &BeginnerChatFeedEvent, cx: &mut Context<Self>) {
        match event {
            BeginnerChatFeedEvent::PreviewRequested => self.show_preview(cx),
            BeginnerChatFeedEvent::ChangesRequested => self.show_changes_diff(cx),
            BeginnerChatFeedEvent::ShareRequested => {
                self.share_dialog_open = true;
                cx.notify();
            }
        }
    }

    fn has_failed_tool_call(&self, cx: &App) -> bool {
        self.thread.as_ref().is_some_and(|thread| {
            thread.read(cx).entries().iter().any(|entry| {
                matches!(
                    entry,
                    AgentThreadEntry::ToolCall(call)
                        if matches!(
                            call.status,
                            ToolCallStatus::Failed
                                | ToolCallStatus::Rejected
                                | ToolCallStatus::Canceled
                        )
                )
            })
        })
    }

    fn show_preview(&mut self, cx: &mut Context<Self>) {
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = true;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Design;

        if self.selected_folder.is_some() {
            self.open_web_app_if_present(cx);
            return;
        }

        if self.preview_url.is_none() {
            cx.notify();
            return;
        }

        self.preview_visible = true;
        cx.notify();
    }

    fn open_artifact_panel(&mut self, cx: &mut Context<Self>) {
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = true;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Design;
        if self.preview_url.is_some() {
            self.preview_visible = true;
        }
        cx.notify();
    }

    fn select_right_panel_option(
        &mut self,
        option: RightPanelOption,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.right_panel_option = option;
        self.right_panel_open = true;

        match option {
            RightPanelOption::Files => {
                self.right_panel_mode = RightPanelMode::Launcher;
                self.preview_visible = false;
                self.web_preview = None;
                if self.raw_browse_path.is_none() {
                    self.raw_browse_path = self.selected_folder.clone();
                }
                cx.notify();
            }
            RightPanelOption::SideChat => {
                self.right_panel_mode = RightPanelMode::Launcher;
                self.preview_visible = false;
                self.web_preview = None;
                cx.notify();
            }
            RightPanelOption::Design => {
                self.right_panel = RightPanel::Preview;
                self.right_panel_open = true;
                self.right_panel_mode = RightPanelMode::Artifact;
                if self.preview_url.is_some() {
                    self.preview_visible = true;
                    cx.notify();
                } else if self.selected_folder.is_some() {
                    self.open_web_app_if_present(cx);
                } else {
                    cx.notify();
                }
            }
            RightPanelOption::Code => {
                self.show_code_artifact(cx);
            }
            RightPanelOption::Terminal => {
                self.right_panel_mode = RightPanelMode::Launcher;
                self.preview_visible = false;
                self.web_preview = None;
                self.raw_browse_path = None;
                self.ensure_right_panel_terminal(window, cx);
                cx.notify();
            }
        }
    }

    fn preview_card_state(&self) -> PreviewCardState {
        if self.preview_url.is_some() {
            PreviewCardState::Ready
        } else if self.is_preview_generating {
            PreviewCardState::Generating
        } else if self.agent_finished {
            PreviewCardState::Unavailable
        } else {
            PreviewCardState::Building
        }
    }

    fn terminal_working_directory(&self) -> Option<PathBuf> {
        self.selected_folder.clone().or_else(|| {
            std::env::var_os("HOME").map(|home| {
                let home = PathBuf::from(home);
                let desktop = home.join("Desktop");
                if desktop.is_dir() { desktop } else { home }
            })
        })
    }

    fn ensure_right_panel_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(working_directory) = self.terminal_working_directory() else {
            return;
        };

        if self.terminal_view.is_some()
            && self.terminal_working_directory.as_ref() == Some(&working_directory)
        {
            return;
        }

        self.terminal_view = None;
        self.terminal_working_directory = Some(working_directory.clone());
        let project = self.project.clone();
        let weak_project = self.project.downgrade();
        let workspace = self.workspace.clone();

        cx.spawn_in(window, async move |this, cx| {
            let create_terminal = project.update(cx, |project, cx| {
                project.create_terminal_shell(Some(working_directory.clone()), cx)
            });
            let terminal = create_terminal.await?;

            this.update_in(cx, |this, window, cx| {
                if this.terminal_working_directory.as_ref() != Some(&working_directory) {
                    return;
                }

                let terminal_view = cx.new(|cx| {
                    TerminalView::new(
                        terminal.clone(),
                        workspace.clone(),
                        None,
                        weak_project.clone(),
                        window,
                        cx,
                    )
                });
                this.terminal_view = Some(terminal_view);
                cx.notify();
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err("Failed to open terminal", window, cx, |_, _, _| None);
    }

    fn open_file_read_only(&mut self, path: &std::path::Path) {
        let resolved_path = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(folder) = self.selected_folder.as_ref() {
            folder.join(path)
        } else {
            path.to_path_buf()
        };
        let title = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let content = match std::fs::read_to_string(&resolved_path) {
            Ok(content) => content,
            Err(error) => format!(
                "Unable to read {} as text: {error}",
                resolved_path.display()
            ),
        };
        self.right_panel = RightPanel::CodeView {
            title: SharedString::from(title),
            content: SharedString::from(content),
        };
        self.right_panel_open = true;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Code;
        self.preview_visible = false;
        self.web_preview = None;
    }

    fn artifact_file_paths(&self, cx: &App) -> Vec<PathBuf> {
        let Some(thread) = self.thread.as_ref() else {
            return Vec::new();
        };

        let mut paths = IndexMap::new();
        for entry in thread.read(cx).entries() {
            let AgentThreadEntry::ToolCall(call) = entry else {
                continue;
            };
            if call.kind != acp::ToolKind::Edit {
                continue;
            }
            for location in &call.locations {
                paths.insert(location.path.clone(), ());
            }
        }
        paths.into_keys().collect()
    }

    fn show_code_artifact(&mut self, cx: &mut Context<Self>) {
        self.preview_visible = false;
        self.web_preview = None;
        self.right_panel_option = RightPanelOption::Code;
        if !matches!(self.right_panel, RightPanel::CodeView { .. }) {
            if let Some(path) = self.artifact_file_paths(cx).into_iter().next() {
                self.open_file_read_only(&path);
            } else {
                self.right_panel = RightPanel::CodeEmpty;
                self.right_panel_open = true;
                self.right_panel_mode = RightPanelMode::Artifact;
            }
        }
        cx.notify();
    }

    fn show_changes_diff(&mut self, cx: &mut Context<Self>) {
        let Some(thread) = self.thread.as_ref() else {
            self.show_code_artifact(cx);
            return;
        };

        let diffs = thread
            .read(cx)
            .entries()
            .iter()
            .flat_map(|entry| entry.diffs())
            .map(|diff| diff.read(cx).to_markdown(cx))
            .filter(|diff| !diff.trim().is_empty())
            .collect::<Vec<_>>();

        if diffs.is_empty() {
            self.show_code_artifact(cx);
            return;
        }

        self.right_panel = RightPanel::CodeView {
            title: SharedString::from("Changes"),
            content: SharedString::from(diffs.join("\n\n")),
        };
        self.right_panel_open = true;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Code;
        self.preview_visible = false;
        self.web_preview = None;
        cx.notify();
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
        let Some(next_ix) = self
            .background_sessions
            .iter()
            .position(|session| matches!(session.state, BeginnerState::ActiveProject))
        else {
            // Last tab — reset to landing rather than closing the window.
            self.new_project(window, cx);
            return;
        };

        // Bring a real project session forward, then discard the old active.
        self.switch_to_session(next_ix, window, cx);
        self.background_sessions.remove(next_ix);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn close_background_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.background_sessions.len() {
            self.background_sessions.remove(ix);
            self.show_tab_limit_notice = false;
            self.save_open_tabs(cx);
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

    fn set_chat_mode(&mut self, mode: ChatMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.chat_mode == mode {
            return;
        }
        self.chat_mode = mode;
        let placeholder = if matches!(self.state, BeginnerState::ActiveProject) {
            mode.follow_up_placeholder()
        } else {
            mode.placeholder()
        };
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(placeholder, window, cx);
        });
        self.sync_thread_prompt_prefix(cx);
        cx.notify();
    }

    fn artifact_title(&self) -> SharedString {
        let title = self.tab_name.as_ref().trim();
        if !title.is_empty() && title != "Home" {
            return self.tab_name.clone();
        }

        self.selected_folder
            .as_ref()
            .and_then(|folder| folder.file_name())
            .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| SharedString::from("Landing Page"))
    }

    #[allow(dead_code)]
    pub fn switch_to_editor(&mut self, cx: &mut Context<Self>) {
        persist_experience_level(ExperienceLevel::Developer, cx);
        cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
    }

    fn open_web_app_if_present(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.selected_folder.clone() else {
            return;
        };

        self.reset_all_preview_state();
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);

        for candidate in Self::preview_candidate_dirs(&root, 2) {
            if let Some(command) = Self::package_preview_command(&candidate, SIMPLE_PREVIEW_PORT) {
                self.start_preview_server(
                    PreviewLaunch {
                        folder: candidate,
                        command,
                        url_path: "/".to_string(),
                    },
                    cx,
                );
                return;
            }
        }

        // Static HTML fallback — make it available from the chat Preview button.
        if let Some(html_path) = Self::static_preview_html_path(&root) {
            self.start_static_preview_server(html_path, cx);
            return;
        }
        self.is_preview_generating = false;
        cx.notify();
    }

    fn preview_candidate_dirs(root: &Path, max_depth: usize) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let mut dirs = vec![(root.to_path_buf(), 0usize)];

        while let Some((dir, depth)) = dirs.pop() {
            candidates.push(dir.clone());
            if depth >= max_depth {
                continue;
            }

            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut child_dirs = read_dir
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .filter(|path| {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    name != "node_modules"
                        && name != "target"
                        && name != "dist"
                        && name != "build"
                        && !name.starts_with('.')
                })
                .collect::<Vec<_>>();
            child_dirs.sort();
            for child in child_dirs.into_iter().rev() {
                dirs.push((child, depth + 1));
            }
        }

        candidates
    }

    fn package_preview_command(folder: &Path, port: u16) -> Option<String> {
        let package_json = folder.join("package.json");
        let package = std::fs::read_to_string(package_json).ok()?;
        let package: serde_json::Value = serde_json::from_str(&package).ok()?;
        let scripts = package
            .get("scripts")
            .and_then(|scripts| scripts.as_object());
        let (pkg_manager, install_cmd) = Self::package_manager_commands(folder);
        let install_if_needed = format!("if [ ! -d node_modules ]; then {install_cmd}; fi");

        if let Some(scripts) = scripts {
            for script_name in ["dev", "start", "serve", "preview"] {
                let Some(script_body) = scripts.get(script_name).and_then(|script| script.as_str())
                else {
                    continue;
                };
                let args = Self::preview_script_args(script_body, port);
                let run = Self::package_run_command(pkg_manager, script_name, &args);
                return Some(format!("{install_if_needed} && {run}"));
            }
        }

        if Self::package_has_dependency(&package, "next") {
            return Some(format!(
                "{install_if_needed} && {}",
                Self::package_exec_command(
                    pkg_manager,
                    &format!("next dev -H 127.0.0.1 -p {port}")
                )
            ));
        }
        if Self::package_has_dependency(&package, "vite") {
            return Some(format!(
                "{install_if_needed} && {}",
                Self::package_exec_command(
                    pkg_manager,
                    &format!("vite --host 127.0.0.1 --port {port}")
                )
            ));
        }

        None
    }

    fn package_manager_commands(folder: &Path) -> (&'static str, &'static str) {
        if folder.join("pnpm-lock.yaml").exists() {
            ("pnpm", "pnpm install")
        } else if folder.join("bun.lockb").exists() || folder.join("bun.lock").exists() {
            ("bun", "bun install")
        } else if folder.join("yarn.lock").exists() {
            ("yarn", "yarn install")
        } else {
            ("npm", "npm install")
        }
    }

    fn package_run_command(pkg_manager: &str, script_name: &str, args: &str) -> String {
        match pkg_manager {
            "yarn" => format!("yarn run {script_name}{args}"),
            "pnpm" => format!("pnpm run {script_name}{args}"),
            "bun" => format!("bun run {script_name}{args}"),
            _ => format!("npm run {script_name}{args}"),
        }
    }

    fn package_exec_command(pkg_manager: &str, command: &str) -> String {
        match pkg_manager {
            "pnpm" => format!("pnpm exec {command}"),
            "bun" => format!("bunx {command}"),
            "yarn" => format!("yarn {command}"),
            _ => format!("npx {command}"),
        }
    }

    fn preview_script_args(script_body: &str, port: u16) -> String {
        let lower = script_body.to_lowercase();
        if lower.contains("react-scripts") {
            String::new()
        } else if lower.contains("next") {
            format!(" -- -H 127.0.0.1 -p {port}")
        } else if lower.contains("vite")
            || lower.contains("astro")
            || lower.contains("svelte")
            || lower.contains("webpack")
            || lower.contains("parcel")
        {
            format!(" -- --host 127.0.0.1 --port {port}")
        } else {
            format!(" -- --port {port}")
        }
    }

    fn package_has_dependency(package: &serde_json::Value, dependency: &str) -> bool {
        ["dependencies", "devDependencies", "peerDependencies"]
            .into_iter()
            .any(|section| {
                package
                    .get(section)
                    .and_then(|deps| deps.as_object())
                    .is_some_and(|deps| deps.contains_key(dependency))
            })
    }

    fn static_preview_html_path(root: &Path) -> Option<PathBuf> {
        let mut dirs = vec![(root.to_path_buf(), 0usize)];
        let mut first_html = None;

        while let Some((dir, depth)) = dirs.pop() {
            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries = read_dir
                .flatten()
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            entries.sort();

            for path in entries {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if path.is_dir() {
                    if depth < 2
                        && name != "node_modules"
                        && name != "target"
                        && !name.starts_with('.')
                    {
                        dirs.push((path, depth + 1));
                    }
                    continue;
                }

                let is_html = path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
                if !is_html {
                    continue;
                }

                if name.eq_ignore_ascii_case("index.html") {
                    return Some(path);
                }
                first_html.get_or_insert(path);
            }
        }

        first_html
    }

    fn start_static_preview_server(&mut self, html_path: PathBuf, cx: &mut Context<Self>) {
        let folder = html_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.selected_folder.clone().unwrap_or_default());
        let file_name = html_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "index.html".to_string());
        let url_path = if file_name.eq_ignore_ascii_case("index.html") {
            "/".to_string()
        } else {
            format!("/{}", Self::url_path_segment(&file_name))
        };
        let default_path = serde_json::to_string(&format!("/{file_name}"))
            .unwrap_or_else(|_| "\"/index.html\"".to_string());
        let node_script = format!(
            "const http=require('http'),fs=require('fs'),path=require('path');\
const root=process.cwd();\
const types={{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon'}};\
http.createServer((req,res)=>{{\
let url=(req.url||'/').split('?')[0];\
let pathname=url==='/'?{}:url;\
let decoded;try{{decoded=decodeURIComponent(pathname)}}catch{{decoded={}}}\
let file=path.normalize(path.join(root,decoded));\
if(!file.startsWith(root)){{res.writeHead(403);res.end('Forbidden');return;}}\
fs.readFile(file,(err,data)=>{{\
if(err){{res.writeHead(404);res.end('Not found');return;}}\
res.writeHead(200,{{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream'}});\
res.end(data);\
}});\
}}).listen({},'127.0.0.1');",
            default_path, default_path, SIMPLE_PREVIEW_PORT
        );
        let command = format!(
            "if command -v python3 >/dev/null 2>&1; then python3 -m http.server {} --bind 127.0.0.1; elif command -v node >/dev/null 2>&1; then node -e {}; else python -m http.server {}; fi",
            SIMPLE_PREVIEW_PORT,
            Self::shell_quote(&node_script),
            SIMPLE_PREVIEW_PORT
        );

        self.start_preview_server(
            PreviewLaunch {
                folder,
                command,
                url_path,
            },
            cx,
        );
    }

    fn url_path_segment(segment: &str) -> String {
        let mut encoded = String::new();
        for byte in segment.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    fn reset_all_preview_state(&mut self) {
        self.clear_current_preview_state();

        for session in &mut self.background_sessions {
            session.preview_url = None;
            session.preview_visible = false;
            session.is_preview_generating = false;
            session.web_preview = None;
            session.dev_server_port = None;
            session.dev_server_task = None;
        }
    }

    fn clear_current_preview_state(&mut self) {
        self.preview_url = None;
        self.preview_visible = false;
        self.is_preview_generating = false;
        self.web_preview = None;
        self.dev_server_port = None;
        self.dev_server_task = None;
    }

    fn kill_preview_port(port: u16) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "lsof -ti :{port} | xargs kill -9 2>/dev/null; true"
                ))
                .status()
                .ok();
        }

        #[cfg(target_os = "windows")]
        {
            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
                    ),
                ])
                .status()
                .ok();
        }
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn shell_quote_path(path: &Path) -> String {
        Self::shell_quote(&path.to_string_lossy())
    }

    fn is_http_preview_ready(port: u16) -> bool {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) =
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(350))
        else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(700)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(350)));
        let request =
            format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        if std::io::Write::write_all(&mut stream, request.as_bytes()).is_err() {
            return false;
        }
        let mut response = [0u8; 512];
        let Ok(bytes_read) = std::io::Read::read(&mut stream, &mut response) else {
            return false;
        };
        if bytes_read == 0 {
            return false;
        }
        let response = String::from_utf8_lossy(&response[..bytes_read]);
        let Some(status) = response
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
        else {
            return false;
        };
        (200..400).contains(&status)
    }

    fn start_preview_server(&mut self, launch: PreviewLaunch, cx: &mut Context<Self>) {
        let port = SIMPLE_PREVIEW_PORT;
        self.dev_server_port = Some(port);
        self.preview_url = None;
        self.preview_visible = false;
        self.is_preview_generating = true;
        self.web_preview = None;
        cx.notify();

        let task = cx.spawn(async move |this, cx| {
            Self::kill_preview_port(port);
            cx.background_executor()
                .timer(std::time::Duration::from_millis(400))
                .await;

            // Use the interactive login shell so ~/.zshrc / ~/.bashrc are sourced —
            // this makes nvm, Homebrew, mise, etc. available even from a GUI app launch.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let folder_arg = Self::shell_quote_path(&launch.folder);
            let dev_cmd = format!("cd {folder_arg} && {}", launch.command);

            let spawned = std::process::Command::new(&shell)
                .args(["-i", "-l", "-c", &dev_cmd])
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                .env("HOSTNAME", "127.0.0.1")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok();

            if !spawned {
                this.update(cx, |this, cx| {
                    this.is_preview_generating = false;
                    this.preview_visible = false;
                    this.preview_url = None;
                    this.dev_server_port = None;
                    cx.notify();
                })
                .ok();
                return;
            }

            // Poll until the app serves an HTTP page. A bare TCP connection can
            // open before the dev server is actually ready to render.
            for _ in 0..180 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(500))
                    .await;
                if Self::is_http_preview_ready(port) {
                    let url = format!("http://localhost:{port}{}", launch.url_path);
                    this.update(cx, |this, cx| {
                        this.web_preview = None;
                        this.preview_visible = true;
                        this.is_preview_generating = false;
                        this.preview_url = Some(url);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            }
            this.update(cx, |this, cx| {
                this.is_preview_generating = false;
                this.preview_visible = false;
                this.preview_url = None;
                this.dev_server_port = None;
                cx.notify();
            })
            .ok();
        });
        // Replace any previous polling task — dropping the old one cancels it.
        self.dev_server_task = Some(task);
    }

    #[allow(dead_code)]
    fn new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.state = BeginnerState::Landing;
        self.active_chat_record_id = None;
        self.selected_folder = None;
        self.clear_composer_git_state();
        self.file_changes_panel = None;
        self.chat_feed = None;
        self.thread = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.show_raw_files = false;
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.share_dialog_open = false;
        self.clear_current_preview_state();
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.chat_mode = ChatMode::Build;
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, self.chat_mode.placeholder());
        self.chat_editor = chat_editor;
        self.session_subscriptions.clear();
        self.session_subscriptions.push(enter_sub);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn open_chat_record(
        &mut self,
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_chat_record_id.as_deref() == Some(record.id.as_str()) {
            self.restore_active_chat_if_needed(window, cx);
            self.save_open_tabs(cx);
            cx.notify();
            return;
        }

        if let Some(ix) = self
            .background_sessions
            .iter()
            .position(|session| session.chat_record_id.as_deref() == Some(record.id.as_str()))
        {
            self.switch_to_session(ix, window, cx);
            self.save_open_tabs(cx);
            return;
        }

        let active_is_empty_landing = matches!(self.state, BeginnerState::Landing)
            && self.thread.is_none()
            && self.pending_conversation_view.is_none()
            && self.chat_editor.read(cx).text(cx).trim().is_empty();
        let total_tabs = 1 + self.background_sessions.len();
        if !active_is_empty_landing && total_tabs >= 3 {
            self.show_tab_limit_notice = true;
            cx.notify();
            return;
        }

        if !active_is_empty_landing {
            self.stash_current_session_and_reset(window, cx);
        }

        self.open_chat_record_in_place(record, window, cx);
        self.save_open_tabs(cx);
    }

    fn open_chat_record_in_place(
        &mut self,
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path = record.folder();
        let chat_name = SharedString::from(record.name.clone());
        self.reset_current_session_for_record(window, cx);
        self.active_chat_record_id = Some(record.id.clone());
        self.selected_folder = Some(path.clone());
        self.refresh_composer_git_state_if_needed(cx);
        self.tab_name = chat_name.clone();
        self.state = BeginnerState::ActiveProject;
        self.chat_mode = ChatMode::Build;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
        });
        self.restore_thread_for_folder(record.clone(), path.clone(), window, cx);
        cx.notify();

        // Do not auto-add worktrees on resume; simple mode should stay uncluttered.
        let _ = window;
    }

    fn reset_current_session_for_record(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.chat_mode = ChatMode::Build;
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, self.chat_mode.placeholder());
        self.chat_editor = chat_editor;
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.show_raw_files = false;
        self.raw_browse_path = None;
        self.right_panel = RightPanel::Preview;
        self.right_panel_open = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.share_dialog_open = false;
        self.clear_current_preview_state();
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.session_subscriptions.clear();
        self.session_subscriptions.push(enter_sub);
    }

    fn restore_active_chat_if_needed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(thread) = self.thread.clone() {
            self.restore_preview_for_thread_if_present(&thread, cx);
            return;
        }
        if self.pending_conversation_view.is_some() {
            return;
        }
        let Some(record_id) = self.active_chat_record_id.clone() else {
            return;
        };
        let Some(record) = self
            .chat_history
            .iter()
            .find(|record| record.id == record_id)
            .cloned()
        else {
            return;
        };
        self.restore_thread_for_folder(record.clone(), record.folder(), window, cx);
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
            .or_else(|| {
                store_ref
                    .entries_for_path(&path_list, None)
                    .chain(store_ref.entries_for_main_worktree_path(&path_list, None))
                    .max_by_key(|entry| entry.updated_at)
            })
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
            self.bind_conversation_view(conversation_view.clone(), window, cx);
            self.schedule_restore_timeout(conversation_view, cx);
        }
    }

    fn restore_preview_for_thread_if_present(
        &mut self,
        thread: &Entity<AcpThread>,
        cx: &mut Context<Self>,
    ) {
        if self.is_agent_running || self.preview_url.is_some() || self.is_preview_generating {
            return;
        }

        let has_artifact_work = thread.read(cx).entries().iter().any(|entry| match entry {
            AgentThreadEntry::ToolCall(call) => {
                matches!(call.kind, acp::ToolKind::Edit | acp::ToolKind::Execute)
            }
            _ => false,
        });
        if !has_artifact_work {
            return;
        }

        self.open_web_app_if_present(cx);
    }

    fn bind_conversation_view(
        &mut self,
        conversation_view: Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_conversation_view = Some(conversation_view.clone());
        let cv_sub = cx.observe_in(&conversation_view, window, |this, cv, window, cx| {
            this.handle_conversation_view_update(&cv, window, cx);
        });
        self.session_subscriptions.push(cv_sub);
        self.handle_conversation_view_update(&conversation_view, window, cx);
    }

    fn handle_conversation_view_update(
        &mut self,
        conversation_view: &Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (is_loading, root_thread) = {
            let cv_ref = conversation_view.read(cx);
            (cv_ref.is_loading(), cv_ref.root_thread(cx))
        };

        if self.thread.is_some() {
            return;
        }

        if let Some(thread) = root_thread {
            let thread_sub = cx.subscribe(&thread, |this, thread_entity, event, cx| match event {
                AcpThreadEvent::Stopped(_) => {
                    this.is_agent_running = false;
                    this.agent_finished = true;
                    if this.preview_url.is_none() {
                        this.open_web_app_if_present(cx);
                    }
                    cx.notify();
                }
                AcpThreadEvent::NewEntry | AcpThreadEvent::EntryUpdated(_) => {
                    this.is_agent_running = thread_entity.read(cx).status() != ThreadStatus::Idle;
                    cx.notify();
                }
                AcpThreadEvent::Error => {
                    this.is_agent_running = false;
                    this.agent_finished = false;
                    cx.notify();
                }
                AcpThreadEvent::ToolAuthorizationRequested(tool_call_id) => {
                    let outcome =
                        thread_entity
                            .read(cx)
                            .tool_call(tool_call_id)
                            .and_then(|(_, call)| {
                                if let ToolCallStatus::WaitingForConfirmation { options, .. } =
                                    &call.status
                                {
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
            });
            self.session_subscriptions.push(thread_sub);
            let artifact_title = self.artifact_title();
            let feed =
                cx.new(|cx| BeginnerChatFeed::new(thread.clone(), artifact_title.clone(), cx));
            let feed_sub = cx.subscribe(&feed, |bw, _, event, cx| {
                bw.handle_chat_feed_event(event, cx);
            });
            self.session_subscriptions.push(feed_sub);
            self.chat_feed = Some(feed);
            let file_panel = cx.new(|cx| FileChangesPanel::new(thread.clone(), cx));
            let file_sub = cx.subscribe(&file_panel, |bw, _, event, cx| {
                bw.handle_file_panel_event(event, cx);
            });
            self.session_subscriptions.push(file_sub);
            self.file_changes_panel = Some(file_panel);
            self.thread = Some(thread.clone());
            if let Some(folder) = self.selected_folder.clone() {
                let sid = thread.read(cx).session_id().0.to_string();
                self.update_latest_chat_record_session_id(&folder, sid, cx);
            }
            self.restore_preview_for_thread_if_present(&thread, cx);
            self.active_conversation_view = self.pending_conversation_view.take();
            if let Some(conversation_view) = self.active_conversation_view.as_ref() {
                self.configure_thread_composer(conversation_view, window, cx);
            }
            self.model_selector = self
                .active_conversation_view
                .as_ref()
                .and_then(|cv_entity| {
                    cv_entity.update(cx, |cv_ref, cx| {
                        cv_ref.make_root_model_selector_wrapped(
                            |inner| {
                                Rc::new(CuratedModelSelector { inner })
                                    as Rc<dyn AgentModelSelector>
                            },
                            window,
                            cx,
                        )
                    })
                });
            if let Some(model_selector) = self.model_selector.as_ref() {
                let logo_path =
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../app/logo.png");
                model_selector.update(cx, |model_selector, _cx| {
                    model_selector
                        .set_trigger_brand(SharedString::from("Backboard model"), Some(logo_path));
                });
            }
            self.send_queued_composer_submit(window, cx);
            cx.notify();
        } else if !is_loading {
            self.is_agent_running = false;
            self.pending_conversation_view = None;
            self.active_conversation_view = None;
            self.queued_composer_submit = None;
            cx.notify();
        }
    }

    fn send_queued_composer_submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.queued_composer_submit.take() else {
            return;
        };

        let Some(conversation_view) = self.active_conversation_view.clone() else {
            self.queued_composer_submit = Some(text);
            return;
        };

        conversation_view.update(cx, |conversation_view, cx| {
            conversation_view.seed_root_message_text_if_empty(text, window, cx);
            conversation_view.send_root_message_editor(window, cx);
        });
    }

    fn schedule_restore_timeout(
        &mut self,
        conversation_view: Entity<ConversationView>,
        cx: &mut Context<Self>,
    ) {
        let pending_id = conversation_view.entity_id();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(8))
                .await;
            this.update(cx, |this, cx| {
                let still_pending = this
                    .pending_conversation_view
                    .as_ref()
                    .is_some_and(|view| view.entity_id() == pending_id);
                if this.thread.is_none() && still_pending {
                    this.is_agent_running = false;
                    this.pending_conversation_view = None;
                    this.active_conversation_view = None;
                    this.queued_composer_submit = None;
                    this.chat_feed = None;
                    this.file_changes_panel = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn make_session_for_record(
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ProjectSession {
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let folder = record.folder();
        ProjectSession {
            chat_record_id: Some(record.id.clone()),
            state: BeginnerState::ActiveProject,
            tab_name: SharedString::from(record.name.clone()),
            chat_mode: ChatMode::Build,
            chat_editor,
            selected_folder: Some(folder),
            thread: None,
            pending_conversation_view: None,
            active_conversation_view: None,
            queued_composer_submit: None,
            model_selector: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            raw_browse_path: None,
            right_panel: RightPanel::Preview,
            right_panel_open: false,
            right_panel_mode: RightPanelMode::Artifact,
            right_panel_option: RightPanelOption::Files,
            share_dialog_open: false,
            preview_url: None,
            preview_visible: false,
            is_preview_generating: false,
            terminal_view: None,
            terminal_working_directory: None,
            dev_server_port: None,
            web_preview: None,
            dev_server_task: None,
            subscriptions: vec![enter_sub],
        }
    }

    fn restore_persisted_open_tabs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open_tabs_restored || !self.open_tabs_loaded {
            return;
        }
        self.open_tabs_restored = true;

        let Some(open_tabs) = self.pending_open_tabs.take() else {
            return;
        };

        let simple_mode_was_opened = SIMPLE_MODE_OPENED_THIS_PROCESS.swap(true, Ordering::AcqRel);
        if !matches!(self.state, BeginnerState::Landing) || !self.background_sessions.is_empty() {
            self.save_open_tabs(cx);
            return;
        }

        // The first Simple Mode entry in an app session should land on Home.
        // If the user later closes/reopens Simple Mode in the same session, restore
        // the chats they explicitly opened.
        if !simple_mode_was_opened {
            self.save_open_tabs(cx);
            cx.notify();
            return;
        }

        let find_record = |id: &str, records: &[BeginnerChatRecord]| {
            records.iter().find(|record| record.id == id).cloned()
        };

        let active_record = open_tabs
            .active_record_id
            .as_deref()
            .and_then(|id| find_record(id, &self.chat_history))
            .or_else(|| {
                open_tabs
                    .background_record_ids
                    .iter()
                    .find_map(|id| find_record(id, &self.chat_history))
            });
        let active_record_id = active_record.as_ref().map(|record| record.id.clone());

        if let Some(record) = active_record {
            self.open_chat_record_in_place(record, window, cx);
        }

        for record_id in open_tabs.background_record_ids {
            if Some(record_id.as_str()) == active_record_id.as_deref() {
                continue;
            }
            if self.background_sessions.len() >= 2 {
                break;
            }
            if let Some(record) = find_record(&record_id, &self.chat_history) {
                self.background_sessions
                    .push(Self::make_session_for_record(record, window, cx));
            }
        }

        self.save_open_tabs(cx);
        cx.notify();
    }
}

/// Generate a human-readable title from the user's initial prompt (like ChatGPT/Claude naming).
/// Uses sentence case and keeps up to 6 meaningful words.
fn generate_chat_name(prompt: &str) -> String {
    const STOP_WORDS: &[&str] = &[
        "a",
        "an",
        "the",
        "make",
        "build",
        "create",
        "add",
        "set",
        "up",
        "me",
        "my",
        "i",
        "want",
        "please",
        "can",
        "you",
        "that",
        "this",
        "it",
        "some",
        "just",
        "something",
        "new",
        "simple",
        "basic",
        "cool",
        "nice",
        "good",
        "great",
        "modern",
        "clean",
        "help",
        "do",
        "write",
        "give",
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
        return "Untitled project".to_string();
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

impl Focusable for BeginnerWorkspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.restore_persisted_open_tabs(window, cx);

        let should_show_embedded_preview = self.right_panel_open
            && self.right_panel_mode == RightPanelMode::Artifact
            && matches!(self.right_panel, RightPanel::Preview)
            && self.preview_visible
            && self.preview_url.is_some();

        // Lazily create the embedded web preview only after the user asks to view it.
        // Returns None on unsupported platforms (Linux/Wayland).
        if should_show_embedded_preview && self.web_preview.is_none() {
            if let Some(url) = self.preview_url.clone() {
                self.web_preview = crate::web_preview::WebPreview::new(window, &url);
            }
        } else if !should_show_embedded_preview {
            self.web_preview = None;
        }

        // If the URL changed after the view was already created, navigate it.
        if let (true, Some(preview), Some(url)) = (
            should_show_embedded_preview,
            &mut self.web_preview,
            &self.preview_url,
        ) {
            preview.load_url(url);
        }

        match &self.state {
            BeginnerState::Landing => self.render_landing(window, cx).into_any_element(),
            BeginnerState::ActiveProject => {
                self.render_active_project(window, cx).into_any_element()
            }
        }
    }
}

impl BeginnerWorkspace {
    fn render_tab_limit_notice(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .items_center()
            .bg(cx.theme().colors().surface_background)
            .border_b_1()
            .border_color(ds::separator(cx))
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

    fn reset_simple_sidebar_width(&mut self, cx: &mut Context<Self>) {
        self.chats_sidebar_width = px(ds::SIDEBAR_WIDTH);
        cx.notify();
    }

    fn resize_simple_sidebar(
        &mut self,
        event: &DragMoveEvent<DraggedSimpleSidebarResize>,
        cx: &mut Context<Self>,
    ) {
        let available_width = event.bounds.right() - event.bounds.left();
        if available_width <= px(0.) {
            return;
        }

        let minimum_sidebar_width = px(ds::SIDEBAR_MIN_WIDTH).min(available_width);
        let reserved_width = px(ds::CHAT_PANEL_MIN_WIDTH + ds::RIGHT_PANEL_MIN_WIDTH);
        let maximum_sidebar_width = (available_width - reserved_width).max(minimum_sidebar_width);
        let requested_sidebar_width = event.event.position.x - event.bounds.left();
        let sidebar_width =
            requested_sidebar_width.clamp(minimum_sidebar_width, maximum_sidebar_width);

        if self.chats_sidebar_width != sidebar_width {
            self.chats_sidebar_width = sidebar_width;
            cx.notify();
        }
    }

    fn render_simple_sidebar_resize_handle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("simple-sidebar-resize-divider")
            .absolute()
            .right_0()
            .top_0()
            .h_full()
            .w(px(1.))
            .bg(ds::panel_divider(cx))
            .child(
                div()
                    .id("simple-sidebar-resize-handle")
                    .absolute()
                    .left(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                    .top_0()
                    .h_full()
                    .w(px(ds::PANEL_RESIZE_HANDLE_WIDTH))
                    .cursor_col_resize()
                    .block_mouse_except_scroll()
                    .tooltip(Tooltip::text("Resize sidebar"))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseUpEvent, _, cx| {
                            if event.click_count == 2 {
                                this.reset_simple_sidebar_width(cx);
                            }
                            cx.stop_propagation();
                        }),
                    )
                    .on_drag(DraggedSimpleSidebarResize, |_, _, _, cx| {
                        cx.stop_propagation();
                        cx.new(|_| gpui::Empty)
                    }),
            )
    }

    fn simple_sidebar_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let multi_workspace = self.multi_workspace.clone();
        let sidebar_is_open = self.chats_sidebar_open;

        ContextMenu::build(window, cx, move |menu, _window, _cx| {
            let open_editor_workspace = multi_workspace.clone();
            let open_agent_workspace = multi_workspace.clone();
            let toggle_sidebar = beginner_workspace.clone();
            let show_panel_options = beginner_workspace.clone();
            let open_terminal = beginner_workspace.clone();
            let reset_animation = multi_workspace.clone();

            menu.item(
                ContextMenuEntry::new("Open in Code Editor")
                    .icon(IconName::FileCode)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        open_editor_workspace
                            .update(cx, |multi_workspace, cx| {
                                multi_workspace.open_code_editor(window, cx);
                            })
                            .log_err();
                    }),
            )
            .item(
                ContextMenuEntry::new("Open in Agents")
                    .icon(IconName::ZedAgentTwo)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        open_agent_workspace
                            .update(cx, |multi_workspace, cx| {
                                multi_workspace.open_agent_workspace(window, cx);
                            })
                            .log_err();
                    }),
            )
            .separator()
            .item(
                ContextMenuEntry::new(if sidebar_is_open {
                    "Close Sidebar"
                } else {
                    "Open Sidebar"
                })
                .icon(if sidebar_is_open {
                    IconName::ThreadsSidebarLeftOpen
                } else {
                    IconName::ThreadsSidebarLeftClosed
                })
                .icon_position(IconPosition::Start)
                .handler(move |_window, cx| {
                    toggle_sidebar
                        .update(cx, |this, cx| {
                            this.chats_sidebar_open = !this.chats_sidebar_open;
                            cx.notify();
                        })
                        .log_err();
                }),
            )
            .item(
                ContextMenuEntry::new("Panel Options")
                    .icon(IconName::ThreadsSidebarRightOpen)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        show_panel_options
                            .update(cx, |this, cx| {
                                this.select_right_panel_option(RightPanelOption::Files, window, cx);
                            })
                            .log_err();
                    }),
            )
            .item(
                ContextMenuEntry::new("Open Terminal")
                    .icon(IconName::Terminal)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        open_terminal
                            .update(cx, |this, cx| {
                                this.select_right_panel_option(
                                    RightPanelOption::Terminal,
                                    window,
                                    cx,
                                );
                            })
                            .log_err();
                    }),
            )
            .separator()
            .item(
                ContextMenuEntry::new("Dashboard")
                    .icon(IconName::ArrowUpRight)
                    .icon_position(IconPosition::Start)
                    .handler(|_window, cx| {
                        cx.open_url("https://app.backboard.io");
                    }),
            )
            .item(
                ContextMenuEntry::new("Settings")
                    .icon(IconName::Settings)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(OpenSettings), cx);
                    }),
            )
            .item(
                ContextMenuEntry::new("Configure API Key")
                    .icon(IconName::Sliders)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
                    }),
            )
            .item(
                ContextMenuEntry::new("Reset Animation")
                    .icon(IconName::HistoryRerun)
                    .icon_position(IconPosition::Start)
                    .handler(move |_window, cx| {
                        reset_animation
                            .update(cx, |multi_workspace, cx| {
                                multi_workspace.replay_startup_loading_animation(cx);
                            })
                            .log_err();
                    }),
            )
            .item(
                ContextMenuEntry::new("Reset Onboarding")
                    .icon(IconName::RotateCcw)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(ResetOnboarding), cx);
                    }),
            )
        })
    }

    fn render_simple_sidebar_menu_button(
        &self,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        DropdownMenu::new_with_element(
            id,
            Icon::new(IconName::Menu)
                .size(IconSize::XSmall)
                .color(Color::Muted)
                .into_any_element(),
            self.simple_sidebar_menu(window, cx),
        )
        .style(DropdownStyle::Ghost)
        .trigger_size(ButtonSize::Compact)
        .no_chevron()
    }

    fn reset_simple_panel_width(&mut self, cx: &mut Context<Self>) {
        self.chat_panel_width = px(ds::CHAT_PANEL_WIDTH);
        cx.notify();
    }

    fn resize_simple_panels(
        &mut self,
        event: &DragMoveEvent<DraggedSimplePanelResize>,
        cx: &mut Context<Self>,
    ) {
        let available_width = event.bounds.right() - event.bounds.left();
        if available_width <= px(0.) {
            return;
        }

        let minimum_chat_width = px(ds::CHAT_PANEL_MIN_WIDTH).min(available_width);
        let maximum_chat_width =
            (available_width - px(ds::RIGHT_PANEL_MIN_WIDTH)).max(minimum_chat_width);
        let requested_chat_width = event.event.position.x - event.bounds.left();
        let chat_panel_width = requested_chat_width.clamp(minimum_chat_width, maximum_chat_width);

        if self.chat_panel_width != chat_panel_width {
            self.chat_panel_width = chat_panel_width;
            cx.notify();
        }
    }

    fn render_simple_panel_resize_handle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("simple-panel-resize-divider")
            .relative()
            .h_full()
            .w(px(1.))
            .flex_shrink_0()
            .bg(ds::panel_divider(cx))
            .child(
                div()
                    .id("simple-panel-resize-handle")
                    .absolute()
                    .left(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                    .top_0()
                    .h_full()
                    .w(px(ds::PANEL_RESIZE_HANDLE_WIDTH))
                    .cursor_col_resize()
                    .block_mouse_except_scroll()
                    .tooltip(Tooltip::text("Resize panels"))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseUpEvent, _, cx| {
                            if event.click_count == 2 {
                                this.reset_simple_panel_width(cx);
                            }
                            cx.stop_propagation();
                        }),
                    )
                    .on_drag(DraggedSimplePanelResize, |_, _, _, cx| {
                        cx.stop_propagation();
                        cx.new(|_| gpui::Empty)
                    }),
            )
    }

    fn render_open_artifact_panel_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);

        div()
            .w(px(44.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(ds::separator(cx))
            .bg(ds::app_background(cx))
            .flex()
            .items_start()
            .justify_center()
            .pt_2()
            .child(
                div()
                    .id("open-artifact-panel")
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(move |el| el.bg(hover_background))
                    .tooltip(Tooltip::text("Open right panel"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.open_artifact_panel(cx);
                    }))
                    .child(
                        Icon::new(IconName::ThreadsSidebarRightClosed)
                            .size(IconSize::Small)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    ),
            )
    }

    fn render_sidebar_api_status_banner(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(24.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(ds::chip_background(cx))
            .child(div().size(px(5.)).rounded_full().bg(ds::warning(cx)))
            .child(
                Label::new("API not connected")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(ds::text_disabled(cx))),
            )
    }

    fn render_sidebar_no_api_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .px_4()
            .pb_8()
            .gap_3()
            .child(
                Icon::new(IconName::Info)
                    .size(IconSize::Medium)
                    .color(Color::Muted),
            )
            .child(
                Label::new("Agent chats unavailable")
                    .size(LabelSize::Small)
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .max_w(px(190.))
                    .text_center()
                    .text_size(rems_from_px(12.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.36))
                    .child("Connect an API key to start chats, run agents, and generate output."),
            )
            .child(
                Button::new("simple-sidebar-configure-api-key", "Connect API key")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Default)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_api_key_settings(window, cx);
                    })),
            )
    }

    fn render_chats_sidebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let action_hover = ds::sidebar_hover_background(cx);
        let api_key_ready = Self::has_backboard_api_key();
        let can_start_new =
            matches!(self.state, BeginnerState::Landing) || self.project_tab_count() < 3;
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let top_bar_offset = if traffic_lights { 8. } else { 0. };
        let search_query = self
            .chat_search_editor
            .read(cx)
            .text(cx)
            .trim()
            .to_lowercase();
        let matches_query =
            |title: &str| search_query.is_empty() || title.to_lowercase().contains(&search_query);
        let mut project_groups: IndexMap<String, SidebarProjectGroup> = IndexMap::default();
        if api_key_ready {
            for record in self.chat_history.clone() {
                let folder_path = record.folder();
                let record_matches_query = matches_query(record.display_name().as_ref());
                let folder_matches_query = folder_matches_search(&folder_path, &search_query);
                if record_matches_query || folder_matches_query {
                    let folder_key = folder_path.to_string_lossy().into_owned();
                    project_groups
                        .entry(folder_key)
                        .or_insert_with(|| SidebarProjectGroup::new(folder_path))
                        .add_record(record);
                }
            }

            for folder_path in
                self.selected_folder
                    .iter()
                    .chain(self.background_sessions.iter().filter_map(|session| {
                        matches!(session.state, BeginnerState::ActiveProject)
                            .then_some(session.selected_folder.as_ref())
                            .flatten()
                    }))
            {
                if !folder_matches_search(folder_path, &search_query) {
                    continue;
                }

                let folder_key = folder_path.to_string_lossy().into_owned();
                if !project_groups.contains_key(&folder_key) {
                    project_groups
                        .insert(folder_key, SidebarProjectGroup::new(folder_path.clone()));
                }
            }
        }
        let project_groups: Vec<_> = project_groups.into_values().collect();
        let no_project_groups = project_groups.is_empty();
        let empty_project_title = if search_query.is_empty() {
            "No chats yet"
        } else {
            "No matching chats"
        };
        let empty_project_subtitle = if search_query.is_empty() {
            "Start a new project to get started."
        } else {
            "Try a different search."
        };
        let search_focus_handle = self.chat_search_editor.focus_handle(cx);
        let search_field_is_empty = search_query.is_empty();
        let search_field_is_focused = search_focus_handle.is_focused(window);

        v_flex()
            .relative()
            .w(self.chats_sidebar_width)
            .min_w(px(ds::SIDEBAR_MIN_WIDTH))
            .h_full()
            .flex_shrink_0()
            .bg(ds::sidebar_background(cx))
            .child(div().absolute().inset_0().bg(ds::sidebar_glow_wash(cx)))
            .child(div().absolute().inset_0().bg(ds::sidebar_edge_wash(cx)))
            .when(!api_key_ready, |el| {
                el.child(self.render_sidebar_api_status_banner(cx))
            })
            .child(
                v_flex()
                    .flex_none()
                    .px_2()
                    .pb_1()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .h(px(ds::TOP_BAR_HEIGHT + top_bar_offset))
                            .pt(px(top_bar_offset))
                            .items_center()
                            .gap_1()
                            .when(traffic_lights, |el| {
                                el.pl(px(ui::utils::TRAFFIC_LIGHT_PADDING))
                            })
                            .pr_1()
                            .child(
                                div()
                                    .h_full()
                                    .w(px(0.))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .window_control_area(WindowControlArea::Drag),
                            )
                            .child(div().flex_1())
                            .child(self.render_simple_sidebar_menu_button(
                                "simple-sidebar-actions-menu",
                                window,
                                cx,
                            ))
                            .child(
                                div()
                                    .id("simple-sidebar-close")
                                    .size(px(24.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |el| el.bg(action_hover))
                                    .tooltip(Tooltip::text("Close sidebar"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.chats_sidebar_open = false;
                                        cx.notify();
                                    }))
                                    .child(
                                        Icon::new(IconName::ThreadsSidebarLeftOpen)
                                            .size(IconSize::XSmall)
                                            .color(Color::Custom(ds::sidebar_icon(cx))),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-new-chat")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .mt(px(6.))
                            .px_3()
                            .gap_2p5()
                            .items_center()
                            .rounded_lg()
                            .when(api_key_ready && can_start_new, |el| {
                                el.cursor_pointer()
                                    .hover(move |el| el.bg(action_hover))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_tab_limit_notice = false;
                                        this.go_home(window, cx);
                                    }))
                            })
                            .when(api_key_ready && !can_start_new, |el| {
                                el.cursor_pointer()
                                    .tooltip(Tooltip::text("3 project limit reached"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.show_tab_limit_notice = true;
                                        cx.notify();
                                    }))
                            })
                            .when(!api_key_ready, |el| el.opacity(0.35))
                            .child(Icon::new(IconName::Plus).size(IconSize::XSmall).color(
                                if can_start_new && api_key_ready {
                                    Color::Custom(ds::sidebar_icon(cx))
                                } else {
                                    Color::Disabled
                                },
                            ))
                            .child(
                                Label::new("New chat")
                                    .size(LabelSize::Default)
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(if can_start_new && api_key_ready {
                                        Color::Custom(ds::sidebar_emphasis_text(cx))
                                    } else {
                                        Color::Disabled
                                    }),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-chat-search")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .px_3()
                            .gap_2p5()
                            .items_center()
                            .rounded_lg()
                            .when(api_key_ready, |el| el.hover(move |el| el.bg(action_hover)))
                            .when(!api_key_ready, |el| el.opacity(0.35))
                            .on_click({
                                let search_focus_handle = search_focus_handle.clone();
                                move |_, window, cx| {
                                    window.focus(&search_focus_handle, cx);
                                }
                            })
                            .child(
                                Icon::new(IconName::MagnifyingGlass)
                                    .size(IconSize::XSmall)
                                    .color(Color::Custom(ds::sidebar_icon(cx))),
                            )
                            .child(
                                div()
                                    .relative()
                                    .h_full()
                                    .flex()
                                    .items_center()
                                    .flex_1()
                                    .min_w_0()
                                    .child(self.chat_search_editor.clone())
                                    .when(
                                        search_field_is_empty && !search_field_is_focused,
                                        |el| {
                                            el.child(
                                                div()
                                                    .absolute()
                                                    .inset_0()
                                                    .flex()
                                                    .items_center()
                                                    .child(
                                                        Label::new("Search chats")
                                                            .size(LabelSize::Default)
                                                            .weight(FontWeight::SEMIBOLD)
                                                            .color(Color::Custom(
                                                                ds::sidebar_emphasis_text(cx),
                                                            ))
                                                            .truncate(),
                                                    ),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("simple-sidebar-mcp-section")
                            .mt(px(6.))
                            .px_2()
                            .gap_0p5()
                            .child(
                                h_flex().h(px(22.)).px_1().items_center().child(
                                    Label::new("MCP")
                                        .size(LabelSize::XSmall)
                                        .weight(FontWeight::SEMIBOLD)
                                        .color(Color::Custom(ds::sidebar_text_muted(cx))),
                                ),
                            )
                            .child(
                                h_flex()
                                    .id("simple-sidebar-connect-mcp")
                                    .h(px(ds::CHAT_ROW_HEIGHT))
                                    .px_3()
                                    .gap_2p5()
                                    .items_center()
                                    .rounded_lg()
                                    .cursor_pointer()
                                    .hover({
                                        let action_hover = action_hover;
                                        move |el| el.bg(action_hover)
                                    })
                                    .tooltip(Tooltip::text("Connect an MCP server"))
                                    .on_click(|_, window, cx| {
                                        window.dispatch_action(Box::new(AddContextServer), cx);
                                    })
                                    .child(
                                        Icon::new(IconName::Server)
                                            .size(IconSize::XSmall)
                                            .color(Color::Custom(ds::sidebar_icon(cx))),
                                    )
                                    .child(
                                        Label::new("Connect MCP server")
                                            .size(LabelSize::Default)
                                            .weight(FontWeight::SEMIBOLD)
                                            .color(Color::Custom(ds::sidebar_emphasis_text(cx)))
                                            .truncate(),
                                    ),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .id("chat-history-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_2()
                    .pb_2()
                    .gap_0p5()
                    .when(!api_key_ready, |el| {
                        el.child(self.render_sidebar_no_api_state(cx))
                    })
                    .when(api_key_ready, |el| {
                        el.child(
                            h_flex().h(px(28.)).px_1().items_center().child(
                                Label::new("Projects")
                                    .size(LabelSize::XSmall)
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(Color::Custom(ds::sidebar_text_muted(cx))),
                            ),
                        )
                    })
                    .when(api_key_ready && no_project_groups, |el| {
                        el.child(
                            v_flex()
                                .px_2()
                                .py_2()
                                .gap_0p5()
                                .child(
                                    Label::new(empty_project_title)
                                        .size(LabelSize::Small)
                                        .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                )
                                .child(
                                    Label::new(empty_project_subtitle)
                                        .size(LabelSize::XSmall)
                                        .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                ),
                        )
                    })
                    .children(project_groups.into_iter().map(|project_group| {
                        let folder_name = folder_display_name(&project_group.folder_path);
                        let parent_name = folder_parent_display_name(&project_group.folder_path);

                        v_flex()
                            .w_full()
                            .pt_1p5()
                            .child(
                                h_flex()
                                    .h(px(30.))
                                    .px_2()
                                    .gap_2()
                                    .items_center()
                                    .child(
                                        Icon::new(IconName::Folder)
                                            .size(IconSize::Small)
                                            .color(Color::Custom(ds::sidebar_icon(cx))),
                                    )
                                    .child(
                                        Label::new(folder_name)
                                            .size(LabelSize::Small)
                                            .weight(FontWeight::SEMIBOLD)
                                            .color(Color::Custom(ds::sidebar_emphasis_text(cx)))
                                            .truncate(),
                                    )
                                    .when_some(parent_name, |el, parent_name| {
                                        el.child(
                                            Label::new(parent_name)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Custom(
                                                    ds::sidebar_emphasis_text(cx).opacity(0.72),
                                                ))
                                                .truncate(),
                                        )
                                    }),
                            )
                            .when(project_group.records.is_empty(), |el| {
                                el.child(
                                    h_flex()
                                        .h(px(ds::CHAT_ROW_HEIGHT))
                                        .pl(px(32.))
                                        .pr_3()
                                        .items_center()
                                        .child(
                                            Label::new("No chats")
                                                .size(LabelSize::Small)
                                                .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                        ),
                                )
                            })
                            .children(project_group.records.into_iter().map(|record| {
                                let name = record.display_name();
                                let record_id = record.id.clone();
                                let row_group =
                                    SharedString::from(format!("chat-entry-{record_id}"));
                                let is_active = self.active_chat_record_id.as_deref()
                                    == Some(record_id.as_str());
                                let background_session_index =
                                    self.background_sessions.iter().position(|session| {
                                        session.chat_record_id.as_deref()
                                            == Some(record_id.as_str())
                                    });
                                let record_for_click = record.clone();
                                let record_id_for_delete = record_id.clone();
                                let hover_bg = ds::sidebar_hover_background(cx);
                                h_flex()
                                    .id(SharedString::from(format!("chat-{record_id}")))
                                    .group(row_group.clone())
                                    .h(px(34.))
                                    .pl(px(32.))
                                    .pr_3()
                                    .gap_2()
                                    .rounded_lg()
                                    .cursor_pointer()
                                    .when(is_active, |el| {
                                        el.bg(ds::sidebar_selected_background(cx))
                                    })
                                    .hover(move |el| el.bg(hover_bg))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_chat_record(record_for_click.clone(), window, cx);
                                    }))
                                    .child(
                                        v_flex().flex_1().min_w_0().child(
                                            Label::new(name)
                                                .size(LabelSize::Small)
                                                .color(Color::Custom(ds::sidebar_text(cx)))
                                                .truncate(),
                                        ),
                                    )
                                    .child(
                                        div()
                                            .id(SharedString::from(format!(
                                                "chat-del-{record_id_for_delete}"
                                            )))
                                            .size(px(16.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded_full()
                                            .flex_none()
                                            .cursor_pointer()
                                            .when(!is_active, |el| {
                                                el.visible_on_hover(row_group.clone())
                                            })
                                            .hover(move |el| el.bg(hover_bg))
                                            .on_click(cx.listener(
                                                move |this, _event, window, cx| {
                                                    cx.stop_propagation();
                                                    if is_active {
                                                        this.close_active_session(window, cx);
                                                    } else if let Some(session_index) =
                                                        background_session_index
                                                    {
                                                        this.close_background_session(
                                                            session_index,
                                                            cx,
                                                        );
                                                    } else {
                                                        this.delete_chat_record(
                                                            record_id_for_delete.clone(),
                                                            cx,
                                                        );
                                                    }
                                                    cx.notify();
                                                },
                                            ))
                                            .child(
                                                Icon::new(IconName::Close)
                                                    .size(IconSize::XSmall)
                                                    .color(Color::Custom(ds::sidebar_text_muted(
                                                        cx,
                                                    ))),
                                            ),
                                    )
                            }))
                    })),
            )
            .child(self.render_simple_sidebar_resize_handle(cx))
    }

    fn render_closed_chats_sidebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .relative()
            .w(px(48.))
            .h_full()
            .flex_shrink_0()
            .bg(ds::sidebar_background(cx))
            .child(div().absolute().inset_0().bg(ds::sidebar_glow_wash(cx)))
            .child(div().absolute().inset_0().bg(ds::sidebar_edge_wash(cx)))
            .border_r_1()
            .border_color(ds::separator(cx))
            .child(
                v_flex()
                    .h(px(ds::TOP_BAR_HEIGHT))
                    .items_center()
                    .justify_center()
                    .px_2()
                    .child(
                        div()
                            .id("simple-sidebar-open")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover({
                                let hover_background = ds::sidebar_hover_background(cx);
                                move |el| el.bg(hover_background)
                            })
                            .tooltip(Tooltip::text("Open sidebar"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.chats_sidebar_open = true;
                                cx.notify();
                            }))
                            .child(
                                Icon::new(IconName::ThreadsSidebarLeftClosed)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::sidebar_icon(cx))),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .items_center()
                    .child(self.render_simple_sidebar_menu_button(
                        "simple-closed-sidebar-actions-menu",
                        window,
                        cx,
                    ))
                    .child(div().flex_1().window_control_area(WindowControlArea::Drag)),
            )
    }

    fn render_simple_header(
        &self,
        title: SharedString,
        is_running: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .h(px(ds::TOP_BAR_HEIGHT))
            .w_full()
            .flex_shrink_0()
            .px_3()
            .gap_2()
            .items_center()
            .bg(ds::app_background(cx))
            .border_b_1()
            .border_color(ds::separator(cx))
            .child(div().size(px(16.)).flex_none())
            .child(
                Label::new(title)
                    .size(LabelSize::Custom(rems_from_px(13.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(div().size(px(12.)).flex_none())
            .child(div().flex_1())
            .when(is_running, |el| {
                el.child(
                    Icon::new(IconName::LoadCircle)
                        .size(IconSize::Medium)
                        .color(Color::Custom(ds::accent(cx))),
                )
            })
            .child(div().size(px(16.)).flex_none())
    }

    fn render_empty_conversation(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let (headline, subtext_first, subtext_second) = match self.chat_mode {
            ChatMode::Ask => (
                "What do you want to ask?",
                "Ask about this project without changing files.",
                "Backboard will keep the project unchanged.",
            ),
            ChatMode::Build => (
                "What are we building today?",
                "Describe a page, feature, or change.",
                "Backboard will generate the output.",
            ),
        };
        v_flex()
            .items_center()
            .gap_3()
            .w_full()
            .max_w(px(360.))
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        img(SIMPLE_LANDING_LOGO_PATH)
                            .size(px(52.))
                            .object_fit(ObjectFit::Contain)
                            .with_fallback(|| div().size(px(52.)).into_any_element()),
                    )
                    .child(
                        Label::new(headline)
                            .size(LabelSize::Custom(rems_from_px(22.)))
                            .weight(FontWeight::BOLD)
                            .color(Color::Custom(ds::text(cx))),
                    )
                    .when(!subtext_first.is_empty(), |el| {
                        el.child(
                            v_flex()
                                .items_center()
                                .child(
                                    Label::new(subtext_first)
                                        .size(LabelSize::Custom(rems_from_px(13.)))
                                        .color(Color::Custom(ds::text_muted(cx).opacity(0.78))),
                                )
                                .child(
                                    Label::new(subtext_second)
                                        .size(LabelSize::Custom(rems_from_px(13.)))
                                        .color(Color::Custom(ds::text_muted(cx).opacity(0.78))),
                                ),
                        )
                    }),
            )
    }

    fn render_landing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let api_key_ready = Self::has_backboard_api_key();
        if api_key_ready {
            self.ensure_composer_thread(window, cx);
        }
        self.refresh_composer_git_state_if_needed(cx);

        v_flex()
            .relative()
            .key_context("BeginnerLanding")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::handle_enter_submit))
            .size_full()
            .when(self.show_tab_limit_notice, |el| {
                el.child(self.render_tab_limit_notice(cx))
            })
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .on_drag_move::<DraggedSimpleSidebarResize>(cx.listener(
                        |this, event, _, cx| {
                            this.resize_simple_sidebar(event, cx);
                        },
                    ))
                    .child(if self.chats_sidebar_open {
                        self.render_chats_sidebar(window, cx).into_any_element()
                    } else {
                        self.render_closed_chats_sidebar(window, cx)
                            .into_any_element()
                    })
                    .child(
                        h_flex()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_hidden()
                            .on_drag_move::<DraggedSimplePanelResize>(cx.listener(
                                |this, event, _, cx| {
                                    this.resize_simple_panels(event, cx);
                                },
                            ))
                            .child(
                                v_flex()
                                    .when(api_key_ready && self.right_panel_open, |el| {
                                        el.w(self.chat_panel_width)
                                            .min_w(px(ds::CHAT_PANEL_MIN_WIDTH))
                                            .flex_shrink_0()
                                    })
                                    .when(!api_key_ready || !self.right_panel_open, |el| {
                                        el.flex_1().min_w_0()
                                    })
                                    .min_h_0()
                                    .h_full()
                                    .overflow_hidden()
                                    .bg(ds::app_background(cx))
                                    .when(!api_key_ready, |el| {
                                        el.child(self.render_api_status_banner(cx))
                                    })
                                    .child(if api_key_ready {
                                        v_flex()
                                            .flex_1()
                                            .min_h_0()
                                            .items_center()
                                            .justify_center()
                                            .px_4()
                                            .pb(rems_from_px(96.))
                                            .child(
                                                v_flex()
                                                    .w_full()
                                                    .max_w(px(920.))
                                                    .items_center()
                                                    .gap_6()
                                                    .child(self.render_empty_conversation(cx))
                                                    .child(self.render_input_bar(
                                                        false,
                                                        false,
                                                        draft_is_empty,
                                                        true,
                                                        api_key_ready,
                                                        window,
                                                        cx,
                                                    )),
                                            )
                                            .into_any_element()
                                    } else {
                                        v_flex()
                                            .flex_1()
                                            .min_h_0()
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .items_center()
                                                    .justify_center()
                                                    .px_4()
                                                    .child(self.render_api_key_required(cx)),
                                            )
                                            .child(self.render_input_bar(
                                                false,
                                                false,
                                                draft_is_empty,
                                                false,
                                                api_key_ready,
                                                window,
                                                cx,
                                            ))
                                            .into_any_element()
                                    }),
                            )
                            .when(api_key_ready && self.right_panel_open, |el| {
                                el.child(self.render_simple_panel_resize_handle(cx))
                                    .child(self.render_right_panel(false, None, false, cx))
                            })
                            .when(api_key_ready && !self.right_panel_open, |el| {
                                el.child(self.render_open_artifact_panel_button(cx))
                            }),
                    ),
            )
            .when(self.share_dialog_open, |el| {
                el.child(self.render_share_dialog(cx))
            })
    }

    fn render_active_project(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let is_running = self.is_agent_running;
        let is_connecting = self.pending_conversation_view.is_some();
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let api_key_ready = Self::has_backboard_api_key();
        if api_key_ready {
            self.ensure_composer_thread(window, cx);
        }
        self.refresh_composer_git_state_if_needed(cx);
        let preview_url = self.preview_url.clone();
        let active_title = self.current_tab_title();
        let preview_card_state = self.preview_card_state();
        let colors = cx.theme().colors().clone();

        v_flex()
            .relative()
            .size_full()
            .on_action(cx.listener(Self::handle_enter_submit))
            .when(self.show_tab_limit_notice, |el| {
                el.child(self.render_tab_limit_notice(cx))
            })
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .on_drag_move::<DraggedSimpleSidebarResize>(cx.listener(
                        |this, event, _, cx| {
                            this.resize_simple_sidebar(event, cx);
                        },
                    ))
                    .child(if self.chats_sidebar_open {
                        self.render_chats_sidebar(window, cx).into_any_element()
                    } else {
                        self.render_closed_chats_sidebar(window, cx)
                            .into_any_element()
                    })
                    .child(
                        h_flex()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_hidden()
                            .on_drag_move::<DraggedSimplePanelResize>(cx.listener(
                                |this, event, _, cx| {
                                    this.resize_simple_panels(event, cx);
                                },
                            ))
                            .child(
                                v_flex()
                                    .when(api_key_ready && self.right_panel_open, |el| {
                                        el.w(self.chat_panel_width)
                                            .min_w(px(ds::CHAT_PANEL_MIN_WIDTH))
                                            .flex_shrink_0()
                                    })
                                    .when(!api_key_ready || !self.right_panel_open, |el| {
                                        el.flex_1().min_w_0()
                                    })
                                    .min_h_0()
                                    .h_full()
                                    .overflow_hidden()
                                    .bg(ds::app_background(cx))
                                    .child(self.render_simple_header(
                                        active_title.clone(),
                                        is_running || is_connecting,
                                        cx,
                                    ))
                                    .when(!api_key_ready, |el| {
                                        el.child(self.render_api_status_banner(cx)).child(
                                            v_flex()
                                                .flex_1()
                                                .min_h_0()
                                                .items_center()
                                                .justify_center()
                                                .px_4()
                                                .child(self.render_api_key_required(cx)),
                                        )
                                    })
                                    .when(api_key_ready, |el| {
                                        el.when_some(self.chat_feed.as_ref(), |el, feed| {
                                            feed.update(cx, |feed, cx| {
                                                feed.set_preview_state(preview_card_state, cx);
                                            });
                                            el.child(
                                                v_flex()
                                                    .h_full()
                                                    .flex_1()
                                                    .min_h_0()
                                                    .overflow_hidden()
                                                    .child(feed.clone()),
                                            )
                                        })
                                    })
                                    .when(api_key_ready && self.chat_feed.is_none(), |el| {
                                        let (headline, subtext) = if is_connecting {
                                            (
                                                "Loading chat",
                                                "Backboard is restoring this conversation.",
                                            )
                                        } else if self.chat_mode == ChatMode::Ask {
                                            (
                                                "What do you want to ask?",
                                                "Ask about this project without changing files.",
                                            )
                                        } else {
                                            (
                                                "What do you want to build?",
                                                "Describe a page, feature, or change.",
                                            )
                                        };
                                        el.child(
                                            v_flex()
                                                .flex_1()
                                                .min_h_0()
                                                .items_center()
                                                .justify_center()
                                                .px_4()
                                                .pb(rems_from_px(48.))
                                                .child(if is_connecting {
                                                    v_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .child(
                                                            Label::new(headline)
                                                                .size(LabelSize::Large)
                                                                .color(Color::Custom(colors.text)),
                                                        )
                                                        .child(
                                                            Label::new(subtext)
                                                                .size(LabelSize::Small)
                                                                .color(Color::Custom(
                                                                    colors.text_muted,
                                                                )),
                                                        )
                                                        .into_any_element()
                                                } else {
                                                    self.render_empty_conversation(cx)
                                                        .into_any_element()
                                                }),
                                        )
                                    })
                                    .when(api_key_ready && (is_running || is_connecting), |el| {
                                        let status = if is_connecting {
                                            SharedString::from("Loading chat...")
                                        } else if self.chat_mode == ChatMode::Ask {
                                            SharedString::from("Thinking...")
                                        } else if self.is_preview_generating {
                                            SharedString::from("Starting local preview")
                                        } else {
                                            SharedString::from(format!(
                                                "Working on {}",
                                                self.artifact_title().as_ref()
                                            ))
                                        };
                                        el.child(
                                            h_flex()
                                                .flex_shrink_0()
                                                .px_4()
                                                .py_2()
                                                .gap_2()
                                                .items_center()
                                                .child(
                                                    Icon::new(IconName::LoadCircle)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Custom(colors.icon_accent)),
                                                )
                                                .child(
                                                    Label::new(status)
                                                        .size(LabelSize::XSmall)
                                                        .color(Color::Custom(colors.text_muted)),
                                                ),
                                        )
                                    })
                                    .child(self.render_input_bar(
                                        is_running,
                                        is_connecting,
                                        draft_is_empty,
                                        false,
                                        api_key_ready,
                                        window,
                                        cx,
                                    )),
                            )
                            .when(api_key_ready && self.right_panel_open, |el| {
                                el.child(self.render_simple_panel_resize_handle(cx)).child(
                                    self.render_right_panel(is_running, preview_url, false, cx),
                                )
                            })
                            .when(api_key_ready && !self.right_panel_open, |el| {
                                el.child(self.render_open_artifact_panel_button(cx))
                            }),
                    ),
            )
            .when(self.share_dialog_open, |el| {
                el.child(self.render_share_dialog(cx))
            })
    }

    fn render_artifact_illustration(
        &self,
        state: ArtifactIllustrationState,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let accent = ds::accent(cx);
        let primary_line = match state {
            ArtifactIllustrationState::Empty => ds::illustration_line_primary(cx),
            ArtifactIllustrationState::Working => accent,
            ArtifactIllustrationState::Error => ds::error(cx).opacity(0.22),
        };
        let secondary_top_line = match state {
            ArtifactIllustrationState::Error => {
                Some((px(29.), px(12.), ds::error(cx).opacity(0.22)))
            }
            ArtifactIllustrationState::Working => {
                Some((px(35.), px(8.), ds::illustration_line_secondary(cx)))
            }
            ArtifactIllustrationState::Empty => None,
        };
        let primary_width = match state {
            ArtifactIllustrationState::Empty => px(34.),
            ArtifactIllustrationState::Working => px(26.),
            ArtifactIllustrationState::Error => px(16.),
        };

        div()
            .relative()
            .w(px(64.))
            .h(px(50.))
            .overflow_hidden()
            .rounded(px(8.))
            .child(
                div()
                    .absolute()
                    .left(px(10.))
                    .top(px(12.))
                    .w(px(52.))
                    .h(px(38.))
                    .rounded(px(6.))
                    .bg(ds::illustration_shadow(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .w(px(52.))
                    .h(px(38.))
                    .rounded(px(4.))
                    .bg(ds::illustration_page(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(11.))
                    .w(primary_width)
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(primary_line),
            )
            .children(secondary_top_line.map(|(left, width, color)| {
                div()
                    .absolute()
                    .left(left)
                    .top(px(11.))
                    .w(width)
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(color)
            }))
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(19.))
                    .w(px(26.))
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(ds::illustration_line_secondary(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(27.))
                    .w(px(18.))
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(ds::illustration_shadow(cx)),
            )
    }

    fn render_empty_artifact_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Empty, cx))
            .child(
                Label::new("No artifact yet")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .w(px(240.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.54))
                    .child("Ask Backboard to build something and the output will appear here."),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("generate-artifact", "Generate artifact")
                            .style(ButtonStyle::Filled)
                            .size(ButtonSize::Default)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_chat_mode(ChatMode::Build, window, cx);
                                this.apply_suggested_prompt("Make a landing page", window, cx);
                                this.submit_follow_up(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .id("try-artifact-prompt")
                            .h(px(24.))
                            .min_w(px(56.))
                            .px_2p5()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_chat_mode(ChatMode::Build, window, cx);
                                this.apply_suggested_prompt("Make a landing page", window, cx);
                            }))
                            .child(
                                Label::new("Try a prompt")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::accent(cx))),
                            ),
                    ),
            )
    }

    fn render_artifact_working_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Working, cx))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::LoadCircle)
                            .size(IconSize::XSmall)
                            .color(Color::Custom(ds::accent(cx))),
                    )
                    .child(
                        Label::new("Starting preview...")
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::accent(cx))),
                    ),
            )
            .child(
                Label::new("Preparing preview...")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                Label::new("Looking for a runnable app.")
                    .size(LabelSize::Custom(rems_from_px(13.)))
                    .color(Color::Custom(ds::text_muted(cx))),
            )
    }

    fn render_artifact_error_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Error, cx))
            .child(
                Label::new("Preview unavailable")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .w(px(240.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.46))
                    .child("No runnable app was detected. Backboard can still make more changes."),
            )
            .child(
                Button::new("retry-artifact-preview", "Try again")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Default)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.open_web_app_if_present(cx);
                    })),
            )
    }

    fn render_design_preview_fallback(
        &self,
        url: String,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors().clone();
        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .bg(ds::app_background(cx))
            .child(
                v_flex()
                    .w_full()
                    .h_full()
                    .overflow_hidden()
                    .bg(ds::app_background(cx))
                    .child(
                        h_flex()
                            .h(px(44.))
                            .px_4()
                            .gap_3()
                            .items_center()
                            .border_b_1()
                            .border_color(ds::separator(cx))
                            .child(
                                Label::new("MyApp")
                                    .size(LabelSize::Default)
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(Color::Custom(ds::text(cx))),
                            )
                            .child(div().flex_1())
                            .child(
                                h_flex()
                                    .gap_4()
                                    .child(
                                        Label::new("Home")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    )
                                    .child(
                                        Label::new("Features")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    )
                                    .child(
                                        Label::new("Pricing")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    )
                                    .child(
                                        Label::new("Pricing")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    ),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .gap_5()
                            .px_8()
                            .child(
                                v_flex()
                                    .items_center()
                                    .gap_4()
                                    .child(
                                        Label::new("Build something amazing")
                                            .size(LabelSize::Custom(rems_from_px(36.)))
                                            .weight(FontWeight::BOLD)
                                            .color(Color::Custom(ds::text(cx))),
                                    )
                                    .child(
                                        div()
                                            .max_w(px(520.))
                                            .text_center()
                                            .text_size(rems_from_px(18.))
                                            .text_color(ds::text_muted(cx))
                                            .line_height(relative(1.55))
                                            .child("A clean, minimal landing page\ngenerated by Backboard."),
                                    )
                                    .child(
                                        Button::new("open-generated-preview", "Get Started")
                                            .style(ButtonStyle::Filled)
                                            .size(ButtonSize::Compact)
                                            .label_size(LabelSize::XSmall)
                                            .on_click(cx.listener(move |_, _, _, cx| {
                                                cx.open_url(&url);
                                            })),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .w_full()
                                    .max_w(px(880.))
                                    .gap_5()
                                    .child(render_preview_feature_card(
                                        "Fast",
                                        "A short feature description goes here.",
                                        colors.element_background,
                                        cx,
                                    ))
                                    .child(render_preview_feature_card(
                                        "Secure",
                                        "A short feature description goes here.",
                                        colors.status_bar_background,
                                        cx,
                                    ))
                                    .child(render_preview_feature_card(
                                        "Simple",
                                        "A short feature description goes here.",
                                        colors.element_background,
                                        cx,
                                    )),
                            ),
                    ),
            )
    }

    fn render_right_panel_option_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);

        h_flex()
            .items_center()
            .gap(px(4.))
            .children(RightPanelOption::VISIBLE.into_iter().map(|option| {
                let is_selected = self.right_panel_option == option;
                let tab_id = SharedString::from(format!(
                    "right-panel-tab-{}",
                    option.label().to_lowercase().replace(' ', "-")
                ));

                h_flex()
                    .id(tab_id)
                    .size(px(34.))
                    .items_center()
                    .justify_center()
                    .rounded(px(8.))
                    .tooltip(Tooltip::text(option.label()))
                    .when(is_selected, |el| el.bg(ds::selected_background(cx)))
                    .when(!is_selected, |el| {
                        el.cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_right_panel_option(option, window, cx);
                            }))
                    })
                    .child(
                        Icon::new(option.icon())
                            .size(IconSize::Small)
                            .color(Color::Custom(if is_selected {
                                ds::text(cx)
                            } else {
                                ds::icon_muted(cx)
                            })),
                    )
            }))
    }

    fn render_right_panel_launcher(&self, cx: &mut Context<Self>) -> AnyElement {
        let hover_background = ds::hover_background(cx);

        v_flex()
            .flex_1()
            .min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
            .h_full()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .px_5()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(cx))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("right-panel-expand")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Expand panel"))
                            .child(
                                Icon::new(IconName::Maximize)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    )
                    .child(
                        div()
                            .id("right-panel-close")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.right_panel_open = false;
                                this.preview_visible = false;
                                cx.notify();
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(match self.right_panel_option {
                RightPanelOption::Files => self.render_right_panel_files_state(cx),
                RightPanelOption::Terminal => self.render_right_panel_terminal_state(cx),
                RightPanelOption::SideChat | RightPanelOption::Design | RightPanelOption::Code => {
                    self.render_right_panel_side_chat_launcher_state(cx)
                }
            })
            .into_any_element()
    }

    fn render_right_panel_side_chat_launcher_state(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .flex_1()
            .min_h_0()
            .px_6()
            .py_5()
            .gap_5()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::Chat)
                            .size(IconSize::Small)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    )
                    .child(
                        Label::new("Side chat")
                            .size(LabelSize::Custom(rems_from_px(15.)))
                            .weight(FontWeight::SEMIBOLD)
                            .color(Color::Custom(ds::text(cx))),
                    ),
            )
            .child(
                div()
                    .max_w(px(440.))
                    .text_size(rems_from_px(13.))
                    .line_height(relative(1.44))
                    .text_color(ds::text_muted(cx))
                    .child("Ask for follow-up changes while keeping the generated artifact, files, and terminal available in this panel."),
            )
            .child(div().flex_1())
            .child(
                h_flex()
                    .w_full()
                    .h(px(42.))
                    .items_center()
                    .gap_2()
                    .border_t_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .pt_3()
                    .child(
                        Button::new("right-panel-open-side-chat", "Open artifact")
                            .style(ButtonStyle::Subtle)
                            .size(ButtonSize::Medium)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.select_right_panel_option(RightPanelOption::Design, window, cx);
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_right_panel_files_state(&self, cx: &mut Context<Self>) -> AnyElement {
        #[derive(Clone)]
        struct BrowserEntry {
            path: PathBuf,
            label: SharedString,
            is_directory: bool,
        }

        let Some(root) = self.selected_folder.clone() else {
            return v_flex()
                .flex_1()
                .min_h_0()
                .items_center()
                .justify_center()
                .px_8()
                .gap_4()
                .child(
                    Icon::new(IconName::FolderOpen)
                        .size(IconSize::Custom(rems_from_px(28.)))
                        .color(Color::Custom(ds::icon_muted(cx))),
                )
                .child(
                    Label::new("No folder selected")
                        .size(LabelSize::Custom(rems_from_px(18.)))
                        .weight(FontWeight::SEMIBOLD)
                        .color(Color::Custom(ds::text(cx))),
                )
                .child(
                    div()
                        .max_w(px(340.))
                        .text_center()
                        .text_size(rems_from_px(13.))
                        .line_height(relative(1.38))
                        .text_color(ds::text_muted(cx))
                        .child("Choose a project folder to browse files in this panel."),
                )
                .child(
                    Button::new("right-panel-choose-folder", "Choose folder")
                        .style(ButtonStyle::Filled)
                        .size(ButtonSize::Medium)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.pick_folder(window, cx);
                        })),
                )
                .into_any_element();
        };

        let browse_path = self
            .raw_browse_path
            .clone()
            .filter(|path| path.starts_with(&root))
            .unwrap_or_else(|| root.clone());
        let current_label = browse_path
            .strip_prefix(&root)
            .ok()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder_display_name(&root).to_string());

        let mut entries = Vec::new();
        let mut error_label = None;
        match std::fs::read_dir(&browse_path) {
            Ok(read_dir) => {
                let mut entry_error_count = 0usize;
                for entry_result in read_dir {
                    let entry = match entry_result {
                        Ok(entry) => entry,
                        Err(_) => {
                            entry_error_count += 1;
                            continue;
                        }
                    };
                    let file_name = entry.file_name();
                    let label = file_name.to_string_lossy().into_owned();
                    if label.starts_with('.') {
                        continue;
                    }
                    let file_type = match entry.file_type() {
                        Ok(file_type) => file_type,
                        Err(_) => {
                            entry_error_count += 1;
                            continue;
                        }
                    };
                    entries.push(BrowserEntry {
                        path: entry.path(),
                        label: SharedString::from(label),
                        is_directory: file_type.is_dir(),
                    });
                }
                if entry_error_count > 0 {
                    error_label = Some(SharedString::from(format!(
                        "{entry_error_count} item(s) could not be read."
                    )));
                }
            }
            Err(error) => {
                error_label = Some(SharedString::from(format!(
                    "Unable to read {}: {error}",
                    browse_path.display()
                )));
            }
        }

        entries.sort_by(|left, right| {
            right.is_directory.cmp(&left.is_directory).then_with(|| {
                left.label
                    .as_ref()
                    .to_lowercase()
                    .cmp(&right.label.as_ref().to_lowercase())
            })
        });

        v_flex()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .bg(ds::app_background(cx))
            .child(
                v_flex()
                    .flex_shrink_0()
                    .gap_1()
                    .px_5()
                    .pt_4()
                    .pb_3()
                    .child(
                        h_flex()
                            .h(px(32.))
                            .items_center()
                            .gap_2()
                            .border_b_1()
                            .border_color(ds::separator(cx).opacity(0.45))
                            .child(
                                Icon::new(IconName::MagnifyingGlass)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            )
                            .child(
                                Label::new("Filter files...")
                                    .size(LabelSize::Small)
                                    .color(Color::Custom(ds::text_disabled(cx))),
                            ),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_1p5()
                            .items_center()
                            .pt_1()
                            .child(
                                Icon::new(IconName::Folder)
                                    .size(IconSize::XSmall)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            )
                            .child(
                                Label::new(current_label)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text_muted(cx)))
                                    .truncate(),
                            ),
                    ),
            )
            .when_some(error_label, |el, error| {
                el.child(
                    h_flex()
                        .mx_4()
                        .mb_2()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(ds::soft_border(cx))
                        .bg(ds::field_background(cx))
                        .px_3()
                        .py_2()
                        .child(
                            Label::new(error)
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx))),
                        ),
                )
            })
            .child(
                v_flex()
                    .id("right-panel-files-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_4()
                    .pb_4()
                    .when(browse_path != root, |el| {
                        let parent_path = browse_path.parent().map(Path::to_path_buf);
                        el.when_some(parent_path, |el, parent_path| {
                            el.child(self.render_file_browser_row(
                                "right-panel-file-parent",
                                SharedString::from(".."),
                                parent_path,
                                true,
                                cx,
                            ))
                        })
                    })
                    .children(entries.into_iter().enumerate().map(|(index, entry)| {
                        self.render_file_browser_row(
                            SharedString::from(format!("right-panel-file-row-{index}")),
                            entry.label,
                            entry.path,
                            entry.is_directory,
                            cx,
                        )
                    })),
            )
            .into_any_element()
    }

    fn render_file_browser_row(
        &self,
        id: impl Into<SharedString>,
        label: SharedString,
        path: PathBuf,
        is_directory: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover_background = ds::hover_background(cx);
        let icon = if is_directory {
            IconName::Folder
        } else {
            Self::file_browser_icon(&path)
        };

        h_flex()
            .id(id.into())
            .h(px(36.))
            .w_full()
            .items_center()
            .gap_2()
            .rounded(px(6.))
            .px_2()
            .cursor_pointer()
            .hover(move |el| el.bg(hover_background))
            .on_click(cx.listener(move |this, _, _, cx| {
                if is_directory {
                    this.raw_browse_path = Some(path.clone());
                } else {
                    this.open_file_read_only(path.as_path());
                }
                cx.notify();
            }))
            .child(
                Icon::new(if is_directory {
                    IconName::ChevronRight
                } else {
                    icon
                })
                .size(IconSize::XSmall)
                .color(Color::Custom(if is_directory {
                    ds::icon_muted(cx)
                } else {
                    ds::text_muted(cx)
                })),
            )
            .when(is_directory, |el| {
                el.child(
                    Icon::new(IconName::Folder)
                        .size(IconSize::Small)
                        .color(Color::Custom(ds::icon_muted(cx))),
                )
            })
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Custom(ds::text(cx)))
                    .truncate(),
            )
            .into_any_element()
    }

    fn file_browser_icon(path: &Path) -> IconName {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("rs") => IconName::FileRust,
            Some("md" | "mdx") => IconName::FileMarkdown,
            Some("toml") => IconName::FileToml,
            Some("json") => IconName::Json,
            Some("js" | "jsx" | "ts" | "tsx" | "py" | "css" | "html" | "yml" | "yaml") => {
                IconName::FileCode
            }
            _ => IconName::File,
        }
    }

    fn render_right_panel_terminal_state(&self, cx: &mut Context<Self>) -> AnyElement {
        let working_directory = self
            .terminal_working_directory
            .clone()
            .or_else(|| self.terminal_working_directory());
        let folder_name = working_directory
            .as_deref()
            .map(folder_display_name)
            .unwrap_or_else(|| SharedString::from("No folder"));

        v_flex()
            .flex_1()
            .min_h_0()
            .bg(ds::app_background(cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .px_5()
                    .py_4()
                    .gap_3()
                    .child(
                        h_flex()
                            .h(px(28.))
                            .items_center()
                            .gap_2()
                            .child(
                                Icon::new(IconName::Terminal)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            )
                            .child(
                                Label::new(folder_name.clone())
                                    .size(LabelSize::Small)
                                    .color(Color::Custom(ds::text_muted(cx)))
                                    .truncate(),
                            ),
                    )
                    .child(if let Some(terminal_view) = self.terminal_view.clone() {
                        div()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .child(terminal_view)
                            .into_any_element()
                    } else {
                        v_flex()
                            .flex_1()
                            .min_h(px(220.))
                            .items_center()
                            .justify_center()
                            .gap_3()
                            .child(
                                Icon::new(IconName::LoadCircle)
                                    .size(IconSize::Medium)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            )
                            .child(
                                Label::new("Starting terminal...")
                                    .size(LabelSize::Small)
                                    .color(Color::Custom(ds::text_muted(cx))),
                            )
                            .into_any_element()
                    }),
            )
            .into_any_element()
    }

    fn render_code_empty_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.render_empty_artifact_state(cx)
    }

    fn render_code_file_tree(
        &self,
        selected_title: &SharedString,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        let mut paths = self.artifact_file_paths(cx);
        if paths.is_empty() {
            paths.push(PathBuf::from(selected_title.as_ref()));
        }

        v_flex()
            .w(px(220.))
            .h_full()
            .flex_shrink_0()
            .overflow_hidden()
            .p_2()
            .bg(ds::app_background(cx))
            .border_r_1()
            .border_color(ds::separator(cx).opacity(0.42))
            .child(
                div().px_2().mb_1().child(
                    Label::new("Generated files")
                        .size(LabelSize::XSmall)
                        .color(Color::Custom(ds::text_muted(cx))),
                ),
            )
            .children(paths.into_iter().enumerate().map(|(index, path)| {
                let display_path = self
                    .selected_folder
                    .as_ref()
                    .and_then(|folder| path.strip_prefix(folder).ok())
                    .unwrap_or(path.as_path());
                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                let dir_label = display_path.parent().and_then(|parent| {
                    let label = parent.to_string_lossy();
                    if label.is_empty() {
                        None
                    } else {
                        Some(label.into_owned())
                    }
                });
                let is_selected = file_name == selected_title.as_ref();
                let row_id = SharedString::from(format!("artifact-code-file-{index}"));
                let path_for_click = path.clone();

                v_flex()
                    .id(row_id)
                    .min_h(px(34.))
                    .w_full()
                    .gap_0p5()
                    .rounded(px(4.))
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .when(is_selected, |el| el.bg(ds::accent(cx).opacity(0.16)))
                    .hover(move |el| el.bg(hover_background))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_file_read_only(&path_for_click);
                        cx.notify();
                    }))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .items_center()
                            .child(Icon::new(IconName::FileCode).size(IconSize::XSmall).color(
                                Color::Custom(if is_selected {
                                    ds::accent(cx)
                                } else {
                                    ds::icon_muted(cx)
                                }),
                            ))
                            .child(
                                Label::new(file_name)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text(cx)))
                                    .truncate(),
                            ),
                    )
                    .when_some(dir_label, |el, dir| {
                        el.child(
                            Label::new(SharedString::from(dir))
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx)))
                                .ml(px(18.))
                                .truncate(),
                        )
                    })
            }))
    }

    fn render_code_artifact_state(
        &self,
        title: &SharedString,
        content: &SharedString,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let readonly_label = if title.as_ref() == "Changes" {
            "Diff is read only"
        } else {
            "Code is read only"
        };
        let lines: Vec<_> = content
            .as_ref()
            .lines()
            .take(500)
            .enumerate()
            .map(|(index, line)| (index + 1, SharedString::from(line.to_string())))
            .collect();

        h_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .child(self.render_code_file_tree(title, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_hidden()
                    .bg(ds::app_background(cx))
                    .child(
                        h_flex()
                            .h(px(32.))
                            .w_full()
                            .items_center()
                            .gap_2()
                            .px_3()
                            .border_b_1()
                            .border_color(ds::separator(cx))
                            .child(
                                Icon::new(IconName::LockOutlined)
                                    .size(IconSize::XSmall)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            )
                            .child(
                                Label::new(readonly_label)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text_muted(cx))),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("artifact-code-scroll")
                            .flex_1()
                            .overflow_y_scroll()
                            .py_3()
                            .children(lines.into_iter().map(|(line_number, line)| {
                                h_flex()
                                    .h(px(18.))
                                    .w_full()
                                    .items_center()
                                    .child(
                                        div()
                                            .w(px(56.))
                                            .h_full()
                                            .flex()
                                            .items_center()
                                            .justify_end()
                                            .border_r_1()
                                            .border_color(ds::separator(cx))
                                            .pr_3()
                                            .text_size(rems_from_px(11.))
                                            .font_family("Roboto Mono")
                                            .text_color(ds::text_muted(cx))
                                            .line_height(px(18.))
                                            .child(line_number.to_string()),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .h_full()
                                            .overflow_hidden()
                                            .px_2()
                                            .text_size(rems_from_px(11.))
                                            .font_family("Roboto Mono")
                                            .text_color(ds::text(cx))
                                            .line_height(px(18.))
                                            .child(line),
                                    )
                            })),
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
        let is_code_view = matches!(
            self.right_panel,
            RightPanel::CodeEmpty | RightPanel::CodeView { .. }
        );
        if self.right_panel_mode == RightPanelMode::Launcher {
            return self.render_right_panel_launcher(cx);
        }

        let has_webview = self.web_preview.is_some();
        let has_failed_artifact = self.has_failed_tool_call(cx);
        let workspace = cx.entity().downgrade();
        let artifact_title = self.artifact_title();
        let panel_title = match &self.right_panel {
            RightPanel::CodeEmpty => SharedString::from("App.tsx"),
            RightPanel::CodeView { title, .. } => title.clone(),
            RightPanel::Preview => artifact_title.clone(),
        };
        let hover_background = ds::hover_background(cx);
        let preview_url_for_browser = preview_url.clone();
        let preview_url_for_viewport = preview_url.clone();
        let has_selected_folder = self.selected_folder.is_some();
        let code_content_for_copy = match &self.right_panel {
            RightPanel::CodeView { content, .. } => Some(content.as_ref().to_string()),
            _ => None,
        };

        v_flex()
            .when(preview_dominant, |el| el.flex_1())
            .when(!preview_dominant, |el| {
                el.flex_1().min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
            })
            .h_full()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .px_5()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(cx))
                    .when(is_code_view, |el| {
                        el.child(
                            Icon::new(IconName::Split)
                                .size(IconSize::Small)
                                .color(Color::Custom(ds::icon_muted(cx))),
                        )
                    })
                    .child(
                        Label::new(panel_title)
                            .size(LabelSize::Small)
                            .color(Color::Custom(ds::text_muted(cx)))
                            .truncate(),
                    )
                    .child(div().flex_1())
                    .when(!is_code_view, |el| {
                        el.child(
                            div()
                                .id("artifact-viewport")
                                .size(px(28.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(ds::strong_border(cx))
                                .when(preview_url_for_viewport.is_some(), |el| {
                                    el.cursor_pointer()
                                        .hover(move |el| el.bg(hover_background))
                                        .tooltip(Tooltip::text("Show preview"))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.show_preview(cx);
                                        }))
                                })
                                .child(
                                    Icon::new(IconName::Screen)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                        .child(
                            div()
                                .id("artifact-refresh")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .when(has_selected_folder, |el| {
                                    el.cursor_pointer()
                                        .hover(move |el| el.bg(hover_background))
                                        .tooltip(Tooltip::text("Refresh artifact preview"))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.open_web_app_if_present(cx);
                                        }))
                                })
                                .child(
                                    Icon::new(IconName::RotateCw)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                        .child(
                            div()
                                .id("artifact-more")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .child(
                                    Icon::new(IconName::Ellipsis)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                    })
                    .when(is_code_view, |el| {
                        el.child(
                            div()
                                .id("artifact-copy-code")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .tooltip(Tooltip::text("Copy code"))
                                .when_some(code_content_for_copy, |el, content| {
                                    el.cursor_pointer()
                                        .hover(move |el| el.bg(hover_background))
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                content.clone(),
                                            ));
                                        }))
                                })
                                .child(
                                    Icon::new(IconName::Copy)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                        .child(
                            div()
                                .id("artifact-search-code")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .tooltip(Tooltip::text("Search code"))
                                .child(
                                    Icon::new(IconName::MagnifyingGlass)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                        .child(
                            div()
                                .id("artifact-code-more")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .child(
                                    Icon::new(IconName::Ellipsis)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                    })
                    .child(
                        div()
                            .id("artifact-close-panel")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.right_panel_open = false;
                                this.preview_visible = false;
                                cx.notify();
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(match &self.right_panel {
                RightPanel::CodeEmpty => self.render_code_empty_state(cx).into_any_element(),
                RightPanel::CodeView { title, content } => self
                    .render_code_artifact_state(title, content, cx)
                    .into_any_element(),
                RightPanel::Preview => {
                    if has_failed_artifact {
                        self.render_artifact_error_state(cx).into_any_element()
                    } else if has_webview {
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
                    } else if let Some(url) = preview_url_for_browser {
                        self.render_design_preview_fallback(url, cx)
                            .into_any_element()
                    } else if is_running {
                        self.render_artifact_working_state(cx).into_any_element()
                    } else {
                        self.render_empty_artifact_state(cx).into_any_element()
                    }
                }
            })
            .into_any_element()
    }

    fn render_share_dialog(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .size_full()
            .inset_0()
            .occlude()
            .bg(gpui::black().opacity(0.35))
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.share_dialog_open = false;
                    cx.notify();
                }),
            )
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(480.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(ds::soft_border(cx))
                    .bg(ds::card_background(cx))
                    .shadow_sm()
                    .occlude()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        v_flex()
                            .gap_3()
                            .p_6()
                            .child(
                                Label::new("Share this workspace")
                                    .size(LabelSize::Custom(rems_from_px(18.)))
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(Color::Custom(ds::text(cx))),
                            )
                            .child(
                                div()
                                    .text_size(rems_from_px(13.))
                                    .text_color(ds::text_muted(cx))
                                    .line_height(relative(1.46))
                                    .child("Invite someone to review the result or try the IDE with this project."),
                            )
                            .child(
                                div()
                                    .text_size(rems_from_px(13.))
                                    .text_color(ds::text_muted(cx))
                                    .line_height(relative(1.46))
                                    .child("Your project is ready. Share it with a teammate, reviewer, or friend."),
                            )
                            .child(
                                h_flex()
                                    .h(px(36.))
                                    .items_center()
                                    .gap_2()
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(ds::soft_border(cx))
                                    .bg(ds::field_background(cx))
                                    .px_3()
                                    .child(
                                        Label::new("backboard.dev/share/project-dashboard")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text(cx)))
                                            .truncate(),
                                    )
                                    .child(div().flex_1())
                                    .child(
                                        Button::new("copy-share-link", "Copy")
                                            .style(ButtonStyle::Subtle)
                                            .size(ButtonSize::Compact)
                                            .label_size(LabelSize::XSmall),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .gap_2()
                                    .child(
                                        Label::new("Send invite to")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    )
                                    .child(
                                        h_flex()
                                            .h(px(36.))
                                            .items_center()
                                            .rounded(px(8.))
                                            .border_1()
                                            .border_color(ds::soft_border(cx))
                                            .bg(ds::field_background(cx))
                                            .px_3()
                                            .child(
                                                Label::new("teammate@example.com")
                                                    .size(LabelSize::Small)
                                                    .color(Color::Custom(ds::text_disabled(cx))),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .h(px(64.))
                            .px_6()
                            .gap_2()
                            .items_center()
                            .justify_end()
                            .border_t_1()
                            .border_color(ds::separator(cx))
                            .child(
                                Button::new("share-maybe-later", "Maybe later")
                                    .style(ButtonStyle::Subtle)
                                    .size(ButtonSize::Medium)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.share_dialog_open = false;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("share-workspace", "Share")
                                    .style(ButtonStyle::Filled)
                                    .size(ButtonSize::Medium)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.share_dialog_open = false;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }

    fn render_api_status_banner(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(28.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(ds::chip_background(cx))
            .child(div().size(px(6.)).rounded_full().bg(ds::warning(cx)))
            .child(
                Label::new("API not connected")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(ds::text_disabled(cx))),
            )
    }

    fn render_api_key_required(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .max_w(px(380.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .child(
                Icon::new(IconName::Info)
                    .size(IconSize::Custom(rems_from_px(24.)))
                    .color(Color::Muted),
            )
            .child(
                Label::new("API key required")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::BOLD)
                    .color(Color::Default),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(cx.theme().colors().text_muted)
                    .line_height(relative(1.32))
                    .child("Connect an API key to start chats, run agents, and generate output."),
            )
            .child(
                Button::new("simple-configure-api-key", "Connect API key")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Large)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_api_key_settings(window, cx);
                    })),
            )
            .child(
                Label::new("Continue without API")
                    .size(LabelSize::Small)
                    .color(Color::Disabled),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .text_center()
                    .text_ui_xs(cx)
                    .text_color(cx.theme().colors().text_disabled)
                    .line_height(relative(1.32))
                    .child("You can still view the project manually."),
            )
    }

    fn render_composer_footer_trigger(
        &self,
        icon: IconName,
        label: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        h_flex()
            .h(px(28.))
            .min_w_0()
            .items_center()
            .gap_1p5()
            .child(
                Icon::new(icon)
                    .size(IconSize::Small)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Custom(ds::text_muted(cx)))
                    .truncate(),
            )
            .child(
                Icon::new(IconName::ChevronDown)
                    .size(IconSize::XSmall)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
            .into_any_element()
    }

    fn composer_folder_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let selected_folder = self.selected_folder.clone();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            if let Some(folder) = selected_folder.as_ref() {
                menu = menu
                    .item(
                        ContextMenuEntry::new(folder.to_string_lossy().into_owned())
                            .icon(IconName::Folder)
                            .icon_position(IconPosition::Start)
                            .disabled(true),
                    )
                    .separator();
            }

            let label = if selected_folder.is_some() {
                "Change folder"
            } else {
                "Choose folder"
            };
            menu.item(
                ContextMenuEntry::new(label)
                    .icon(IconName::FolderOpen)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        beginner_workspace
                            .update(cx, |this, cx| {
                                this.pick_folder(window, cx);
                            })
                            .log_err();
                    }),
            )
        })
    }

    fn composer_work_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        ContextMenu::build(window, cx, |menu, _window, _cx| {
            menu.item(
                ContextMenuEntry::new("Work locally")
                    .icon(IconName::Screen)
                    .icon_position(IconPosition::Start)
                    .toggle(IconPosition::End, true),
            )
        })
    }

    fn composer_branch_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let selected_folder = self.selected_folder.clone();
        let git_state = self.composer_git_state.clone();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            if selected_folder.is_none() {
                let choose_workspace = beginner_workspace.clone();
                return menu.item(
                    ContextMenuEntry::new("Choose folder")
                        .icon(IconName::FolderOpen)
                        .icon_position(IconPosition::Start)
                        .handler(move |window, cx| {
                            choose_workspace
                                .update(cx, |this, cx| {
                                    this.pick_folder(window, cx);
                                })
                                .log_err();
                        }),
                );
            }

            if git_state.is_loading {
                return menu.item(ContextMenuEntry::new("Checking Git...").disabled(true));
            }

            if !git_state.is_git_repository {
                let initialize_workspace = beginner_workspace.clone();
                return menu.item(
                    ContextMenuEntry::new("Initialize Git repository")
                        .icon(IconName::GitBranch)
                        .icon_position(IconPosition::Start)
                        .handler(move |window, cx| {
                            initialize_workspace
                                .update(cx, |this, cx| {
                                    this.initialize_composer_git_repository(window, cx);
                                })
                                .log_err();
                        }),
                );
            }

            if git_state.branches.is_empty() {
                return menu.item(ContextMenuEntry::new("No local branches").disabled(true));
            }

            for branch in git_state.branches {
                let is_current = git_state
                    .current_branch
                    .as_ref()
                    .is_some_and(|current| current.as_ref() == branch.as_ref());
                let branch_name = branch.to_string();
                let switch_workspace = beginner_workspace.clone();
                menu = menu.item(
                    ContextMenuEntry::new(branch)
                        .icon(IconName::GitBranch)
                        .icon_position(IconPosition::Start)
                        .toggle(IconPosition::End, is_current)
                        .disabled(is_current)
                        .handler(move |window, cx| {
                            switch_workspace
                                .update(cx, |this, cx| {
                                    this.switch_composer_git_branch(
                                        branch_name.clone(),
                                        window,
                                        cx,
                                    );
                                })
                                .log_err();
                        }),
                );
            }

            menu
        })
    }

    fn render_composer_footer(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let folder_label = self
            .selected_folder
            .as_ref()
            .map(|folder| folder_display_name(folder))
            .unwrap_or_else(|| SharedString::from("Choose folder"));

        let branch_label = if self.selected_folder.is_none() {
            SharedString::from("No folder")
        } else if self.composer_git_state.is_loading {
            SharedString::from("Checking Git")
        } else if let Some(branch) = self.composer_git_state.current_branch.clone() {
            branch
        } else if self.composer_git_state.is_git_repository {
            SharedString::from("Detached HEAD")
        } else {
            SharedString::from("Connect Git")
        };

        h_flex()
            .w_full()
            .items_center()
            .gap_3()
            .px_4()
            .pt_2()
            .pb_3()
            .child(
                DropdownMenu::new_with_element(
                    "simple-composer-folder",
                    self.render_composer_footer_trigger(IconName::FolderOpen, folder_label, cx),
                    self.composer_folder_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .no_chevron(),
            )
            .child(
                DropdownMenu::new_with_element(
                    "simple-composer-work-mode",
                    self.render_composer_footer_trigger(
                        IconName::Screen,
                        SharedString::from("Work locally"),
                        cx,
                    ),
                    self.composer_work_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .no_chevron(),
            )
            .child(
                DropdownMenu::new_with_element(
                    "simple-composer-branch",
                    self.render_composer_footer_trigger(IconName::GitBranch, branch_label, cx),
                    self.composer_branch_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .no_chevron(),
            )
            .child(div().flex_1())
            .into_any_element()
    }

    fn composer_shadow(focused: bool, cx: &App) -> Vec<BoxShadow> {
        let mut shadows = ElevationIndex::ElevatedSurface.shadow(cx);
        shadows.push(BoxShadow {
            color: ds::accent(cx).opacity(if focused { 0.24 } else { 0.14 }),
            offset: point(px(0.), px(0.)),
            blur_radius: px(if focused { 24. } else { 18. }),
            spread_radius: px(0.),
        });
        shadows.push(BoxShadow {
            color: ds::accent(cx).opacity(if focused { 0.16 } else { 0.08 }),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(1.),
        });
        shadows
    }

    fn render_input_bar(
        &self,
        is_running: bool,
        is_connecting: bool,
        draft_is_empty: bool,
        centered: bool,
        api_key_ready: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !api_key_ready {
            return v_flex()
                .flex_shrink_0()
                .h(px(56.))
                .w_full()
                .px_4()
                .pt_2()
                .pb_3()
                .bg(ds::app_background(cx))
                .child(
                    h_flex()
                        .h(px(36.))
                        .w_full()
                        .items_center()
                        .rounded_lg()
                        .bg(cx.theme().colors().element_background.opacity(0.5))
                        .px_3()
                        .child(
                            Label::new("API key required")
                                .size(LabelSize::Small)
                                .color(Color::Disabled),
                        ),
                )
                .into_any_element();
        }

        let colors = cx.theme().colors().clone();
        let composer_surface_bg = colors
            .editor_background
            .blend(colors.element_background.opacity(0.08));
        let composer_border = colors.border_variant.opacity(0.5);
        let composer_shadow = Self::composer_shadow(false, cx);
        let root_composer_focus =
            self.active_conversation_view
                .as_ref()
                .and_then(|conversation_view| {
                    conversation_view
                        .read(cx)
                        .root_message_editor_focus_handle(cx)
                });
        if let Some(conversation_view) = self.active_conversation_view.clone()
            && let Some(composer) = conversation_view.update(cx, |conversation_view, cx| {
                conversation_view.render_embedded_root_message_editor(window, cx)
            })
        {
            let composer = v_flex()
                .w_full()
                .rounded(px(28.))
                .overflow_hidden()
                .border_1()
                .border_color(composer_border)
                .bg(composer_surface_bg)
                .shadow(composer_shadow)
                .when_some(root_composer_focus, |el, focus_handle| {
                    el.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        window.focus(&focus_handle, cx);
                    })
                })
                .when(centered, |el| el.max_w(px(920.)))
                .child(composer)
                .child(self.render_composer_footer(window, cx))
                .into_any_element();

            return v_flex()
                .flex_shrink_0()
                .w_full()
                .when(centered, |el| el.items_center())
                .when(!centered, |el| el.px_2().pt_1().pb_1p5())
                .child(composer)
                .when(is_running, |el| {
                    el.child(
                        h_flex().justify_end().child(
                            Button::new("cancel-task", "Cancel")
                                .style(ButtonStyle::Subtle)
                                .size(ButtonSize::Medium)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.cancel_running_task(cx);
                                })),
                        ),
                    )
                })
                .when(self.agent_finished, |el| {
                    el.child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap_3()
                            .rounded(px(10.))
                            .border_1()
                            .border_color(ds::soft_border(cx))
                            .bg(ds::field_background(cx))
                            .px_3()
                            .py_2()
                            .child(
                                Label::new("Get notified when Backboard finishes a task?")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text_muted(cx))),
                            )
                            .child(div().flex_1())
                            .child(
                                Button::new("enable-notifications", "Enable")
                                    .style(ButtonStyle::Subtle)
                                    .size(ButtonSize::Compact)
                                    .label_size(LabelSize::XSmall)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.approve_changes(cx);
                                    })),
                            )
                            .child(
                                Button::new("dismiss-notifications", "Not now")
                                    .style(ButtonStyle::Subtle)
                                    .size(ButtonSize::Compact)
                                    .label_size(LabelSize::XSmall)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.agent_finished = false;
                                        cx.notify();
                                    })),
                            ),
                    )
                })
                .when(is_connecting, |el| {
                    el.child(
                        h_flex().justify_end().child(
                            Label::new("Connecting...")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx))),
                        ),
                    )
                })
                .into_any_element();
        }

        let is_disabled = is_running || is_connecting || draft_is_empty || !api_key_ready;
        let icon_hover_bg = ds::hover_background(cx);
        let next_mode = match self.chat_mode {
            ChatMode::Ask => ChatMode::Build,
            ChatMode::Build => ChatMode::Ask,
        };
        let focus_handle = self.chat_editor.focus_handle(cx);
        let colors = cx.theme().colors().clone();
        let editor_focused = focus_handle.is_focused(window);
        let editor_bg_color = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.18));
        let composer_surface_bg = colors
            .editor_background
            .blend(colors.element_background.opacity(0.08));
        let composer_border = if editor_focused {
            colors.border_focused
        } else {
            colors.border_variant.opacity(0.5)
        };
        let composer_hover_border = colors.border_variant.opacity(0.62);
        let composer_shadow = Self::composer_shadow(editor_focused, cx);

        v_flex()
            .flex_shrink_0()
            .w_full()
            .items_center()
            .bg(editor_bg_color)
            .px_2()
            .pt_1()
            .pb_1p5()
            .child(
                v_flex()
                    .w_full()
                    .max_w_full()
                    .flex_shrink()
                    .flex_grow()
                    .justify_between()
                    .min_h(px(92.))
                    .rounded_lg()
                    .border_1()
                    .border_color(composer_border)
                    .hover(move |el| el.border_color(composer_hover_border))
                    .bg(composer_surface_bg)
                    .shadow(composer_shadow)
                    .track_focus(&focus_handle)
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        window.focus(&focus_handle, cx);
                    })
                    .px_3()
                    .pt_2()
                    .pb_1p5()
                    .child(
                        v_flex()
                            .w_full()
                            .min_h(px(64.))
                            .child(self.chat_editor.clone())
                            .child(
                                h_flex()
                                    .w_full()
                                    .flex_none()
                                    .items_center()
                                    .justify_between()
                                    .flex_wrap()
                                    .gap_1()
                                    .mt_0p5()
                                    .pt_1()
                                    .border_t_1()
                                    .border_color(colors.border_variant.opacity(0.22))
                                    .child(
                                        div()
                                            .id("simple-add-folder")
                                            .when(centered, |el| el.size(px(24.)))
                                            .when(!centered, |el| el.size(px(24.)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.))
                                            .cursor_pointer()
                                            .hover(move |el| el.bg(icon_hover_bg))
                                            .tooltip(Tooltip::text("Attach project root directory"))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.pick_folder(window, cx);
                                            }))
                                            .child(
                                                Icon::new(IconName::Plus)
                                                    .size(IconSize::Small)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .when_some(self.selected_folder.as_ref(), |el, folder| {
                                        let folder_name = folder
                                            .file_name()
                                            .map(|name| name.to_string_lossy().into_owned())
                                            .unwrap_or_else(|| {
                                                folder.to_string_lossy().into_owned()
                                            });
                                        el.child(
                                            h_flex()
                                                .min_w_0()
                                                .gap_1p5()
                                                .items_center()
                                                .child(
                                                    Icon::new(IconName::Folder)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Custom(ds::icon_muted(cx))),
                                                )
                                                .child(
                                                    Label::new(folder_name)
                                                        .size(LabelSize::XSmall)
                                                        .color(Color::Custom(ds::text(cx)))
                                                        .truncate(),
                                                ),
                                        )
                                    })
                                    .when_some(self.model_selector.clone(), |el, selector| {
                                        el.child(selector)
                                    })
                                    .child(div().flex_1())
                                    .child(
                                        h_flex()
                                            .id("simple-mode-toggle")
                                            .gap_1()
                                            .items_center()
                                            .min_w(px(48.))
                                            .px_1p5()
                                            .rounded(px(4.))
                                            .overflow_hidden()
                                            .when(
                                                !is_running && !is_connecting && api_key_ready,
                                                |el| {
                                                    el.cursor_pointer()
                                                        .hover(move |el| el.bg(icon_hover_bg))
                                                        .tooltip(Tooltip::text("Switch chat mode"))
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.set_chat_mode(
                                                                    next_mode, window, cx,
                                                                );
                                                            },
                                                        ))
                                                },
                                            )
                                            .child(
                                                div()
                                                    .size(px(10.))
                                                    .rounded(px(2.))
                                                    .bg(ds::status_dot(cx)),
                                            )
                                            .child(
                                                Label::new(self.chat_mode.label())
                                                    .size(LabelSize::Small)
                                                    .color(Color::Custom(ds::mode_text(cx))),
                                            )
                                            .child(
                                                Icon::new(IconName::ChevronDown)
                                                    .size(IconSize::XSmall)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("simple-mic")
                                            .when(centered, |el| el.size(px(24.)))
                                            .when(!centered, |el| el.size(px(24.)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.))
                                            .tooltip(Tooltip::text("Voice input"))
                                            .child(
                                                Icon::new(IconName::Mic)
                                                    .size(IconSize::Small)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("simple-send")
                                            .when(centered, |el| el.size(px(24.)).rounded(px(4.)))
                                            .when(!centered, |el| el.size(px(24.)).rounded(px(4.)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .when(!is_disabled, |el| {
                                                el.cursor_pointer()
                                                    .hover(move |el| el.bg(icon_hover_bg))
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.submit_follow_up(window, cx);
                                                    }))
                                            })
                                            .when(!api_key_ready, |el| {
                                                el.tooltip(Tooltip::text(
                                                    "Enter a Backboard API key to use AI features.",
                                                ))
                                            })
                                            .child(
                                                Icon::new(IconName::Send)
                                                    .size(IconSize::Small)
                                                    .color(Color::Custom(if centered {
                                                        if is_disabled {
                                                            ds::icon_muted(cx)
                                                        } else {
                                                            ds::accent(cx)
                                                        }
                                                    } else if is_disabled {
                                                        ds::icon_muted(cx)
                                                    } else {
                                                        ds::accent(cx)
                                                    })),
                                            ),
                                    ),
                            ),
                    ),
            )
            .when(is_running, |el| {
                el.child(
                    h_flex().justify_end().child(
                        Button::new("cancel-task", "Cancel")
                            .style(ButtonStyle::Subtle)
                            .size(ButtonSize::Medium)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.cancel_running_task(cx);
                            })),
                    ),
                )
            })
            .when(self.agent_finished, |el| {
                el.child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .gap_3()
                        .rounded(px(10.))
                        .border_1()
                        .border_color(ds::soft_border(cx))
                        .bg(ds::field_background(cx))
                        .px_3()
                        .py_2()
                        .child(
                            Label::new("Get notified when Backboard finishes a task?")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx))),
                        )
                        .child(div().flex_1())
                        .child(
                            Button::new("enable-notifications", "Enable")
                                .style(ButtonStyle::Subtle)
                                .size(ButtonSize::Compact)
                                .label_size(LabelSize::XSmall)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.approve_changes(cx);
                                })),
                        )
                        .child(
                            Button::new("dismiss-notifications", "Not now")
                                .style(ButtonStyle::Subtle)
                                .size(ButtonSize::Compact)
                                .label_size(LabelSize::XSmall)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.agent_finished = false;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when(is_connecting, |el| {
                el.child(
                    h_flex().justify_end().child(
                        Label::new("Connecting...")
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::text_muted(cx))),
                    ),
                )
            })
            .into_any_element()
    }
}
