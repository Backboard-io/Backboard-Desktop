use std::collections::HashSet;

use acp_thread::{
    AcpThread, AcpThreadEvent, AgentThreadEntry, AssistantMessageChunk, ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, Hsla, Render, SharedString,
    Subscription, Window,
};
use ui::{Color, Icon, IconName, IconSize, Label, LabelSize, Tooltip, prelude::*};

use crate::simple_design as ds;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChatFeedDisplayMode {
    LiveWork,
}

#[derive(Clone)]
struct TaskItem {
    label: String,
    detail_label: Option<String>,
    kind: TaskKind,
    done: bool,
    failed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskKind {
    Edit,
    Delete,
    Execute,
    Fetch,
    Move,
    Read,
    Search,
    Think,
    Other,
}

enum FriendlyItem {
    UserBubble {
        index: usize,
        text: String,
    },
    BackboardCard {
        index: usize,
        text: Option<String>,
        thought: Option<String>,
        tasks: Vec<TaskItem>,
    },
}

const CHAT_LONG_TOKEN_BREAK_CHARS: usize = 48;

pub struct BeginnerChatFeed {
    thread: Entity<AcpThread>,
    artifact_title: SharedString,
    preview_state: PreviewCardState,
    display_mode: ChatFeedDisplayMode,
    focus_handle: FocusHandle,
    expanded_work_cards: HashSet<usize>,
    collapsed_work_cards: HashSet<usize>,
    _subscription: Subscription,
}

pub enum BeginnerChatFeedEvent {
    ChangesRequested,
    PreviewRequested,
    ShareRequested,
}

impl EventEmitter<BeginnerChatFeedEvent> for BeginnerChatFeed {}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PreviewCardState {
    Building,
    Generating,
    Ready,
    Unavailable,
}

impl BeginnerChatFeed {
    pub fn new(
        thread: Entity<AcpThread>,
        artifact_title: SharedString,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscription = cx.subscribe(&thread, |_, _, _event: &AcpThreadEvent, cx| {
            cx.notify();
        });
        Self {
            thread,
            artifact_title,
            preview_state: PreviewCardState::Building,
            display_mode: ChatFeedDisplayMode::LiveWork,
            focus_handle: cx.focus_handle(),
            expanded_work_cards: HashSet::default(),
            collapsed_work_cards: HashSet::default(),
            _subscription: subscription,
        }
    }

    pub fn set_preview_state(&mut self, preview_state: PreviewCardState, cx: &mut Context<Self>) {
        if self.preview_state == preview_state {
            return;
        }
        self.preview_state = preview_state;
        cx.notify();
    }

    pub fn set_display_mode(&mut self, display_mode: ChatFeedDisplayMode, cx: &mut Context<Self>) {
        if self.display_mode == display_mode {
            return;
        }
        self.display_mode = display_mode;
        cx.notify();
    }
}

impl Focusable for BeginnerChatFeed {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerChatFeed {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let items = collect_items(&self.thread, cx);
        let colors = cx.theme().colors().clone();
        let is_empty = items.is_empty();
        let mut rendered_items = Vec::with_capacity(items.len());
        for item in items {
            rendered_items.push(render_item(
                item,
                &self.artifact_title,
                self.preview_state,
                self.display_mode,
                &self.expanded_work_cards,
                &self.collapsed_work_cards,
                cx,
            ));
        }

        v_flex()
            .id("beginner-feed")
            .h_full()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .items_center()
            .px_6()
            .pt_6()
            .pb(px(220.))
            .gap_3()
            .bg(ds::app_background(cx))
            .when(is_empty, |el| {
                el.child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .child(ds::render_project_mark(ds::UTILITY_ICON_SIZE, cx))
                        .child(
                            Label::new("Loading chat…")
                                .size(LabelSize::Small)
                                .color(Color::Custom(colors.text_muted)),
                        ),
                )
            })
            .children(rendered_items)
    }
}

fn collect_items(thread: &Entity<AcpThread>, cx: &App) -> Vec<FriendlyItem> {
    let entries = thread.read(cx).entries();
    let mut items: Vec<FriendlyItem> = Vec::new();
    // (start_index, text, thought, tasks)
    let mut pending_card: Option<(usize, Option<String>, Option<String>, Vec<TaskItem>)> = None;

    for (index, entry) in entries.iter().enumerate() {
        match entry {
            AgentThreadEntry::UserMessage(msg) => {
                if let Some((card_index, text, thought, tasks)) = pending_card.take() {
                    if text.is_some() || thought.is_some() || !tasks.is_empty() {
                        items.push(FriendlyItem::BackboardCard {
                            index: card_index,
                            text,
                            thought,
                            tasks,
                        });
                    }
                }
                if msg.indented {
                    continue;
                }
                let text = msg.content.to_markdown(cx).to_string();
                let text = clean_user_text(text.trim());
                if !text.is_empty() {
                    items.push(FriendlyItem::UserBubble { index, text });
                }
            }

            AgentThreadEntry::AssistantMessage(msg) => {
                let mut message_parts = Vec::new();
                let mut thought_parts = Vec::new();
                for chunk in &msg.chunks {
                    match chunk {
                        AssistantMessageChunk::Message { block } => {
                            let s = block.to_markdown(cx).to_string();
                            if !s.trim().is_empty() {
                                message_parts.push(s);
                            }
                        }
                        AssistantMessageChunk::Thought { block } => {
                            let s = block.to_markdown(cx).to_string();
                            if !s.trim().is_empty() {
                                thought_parts.push(s);
                            }
                        }
                    }
                }

                let text = message_parts.join("\n\n");
                if !text.trim().is_empty() {
                    match &mut pending_card {
                        Some(card) => {
                            let combined = match &card.1 {
                                Some(existing) => format!("{}\n\n{}", existing, text),
                                None => text,
                            };
                            card.1 = Some(combined);
                        }
                        None => {
                            pending_card = Some((index, Some(text), None, Vec::new()));
                        }
                    }
                }

                let thought = thought_parts.join("\n\n");
                if !thought.trim().is_empty() {
                    match &mut pending_card {
                        Some(card) => {
                            let combined = match &card.2 {
                                Some(existing) => format!("{}\n\n{}", existing, thought),
                                None => thought,
                            };
                            card.2 = Some(combined);
                        }
                        None => {
                            pending_card = Some((index, None, Some(thought), Vec::new()));
                        }
                    }
                }
            }

            AgentThreadEntry::ToolCall(call) => {
                let raw_label = call.label.read(cx).source().to_string();
                let label = translate_tool_label(&call.kind, &raw_label);
                let detail_label = live_work_label(&raw_label);
                let kind = task_kind(&call.kind);
                let done = matches!(call.status, ToolCallStatus::Completed);
                let failed = matches!(
                    call.status,
                    ToolCallStatus::Failed | ToolCallStatus::Rejected | ToolCallStatus::Canceled
                );
                let task = TaskItem {
                    label,
                    detail_label,
                    kind,
                    done,
                    failed,
                };
                match &mut pending_card {
                    Some(card) => card.3.push(task),
                    None => {
                        pending_card = Some((index, None, None, vec![task]));
                    }
                }
            }

            AgentThreadEntry::CompletedPlan(entries) => {
                let mut tasks = entries
                    .iter()
                    .filter_map(|entry| {
                        let raw_label = entry.content.read(cx).source();
                        let label = simplify_plan_label(raw_label);
                        (!label.is_empty()).then_some(TaskItem {
                            label,
                            detail_label: live_work_label(raw_label),
                            kind: TaskKind::Think,
                            done: true,
                            failed: false,
                        })
                    })
                    .collect::<Vec<_>>();
                if tasks.is_empty() {
                    continue;
                }
                match &mut pending_card {
                    Some(card) => card.3.append(&mut tasks),
                    None => {
                        pending_card = Some((index, None, None, tasks));
                    }
                }
            }
        }
    }

    if let Some((card_index, text, thought, tasks)) = pending_card {
        if text.is_some() || thought.is_some() || !tasks.is_empty() {
            items.push(FriendlyItem::BackboardCard {
                index: card_index,
                text,
                thought,
                tasks,
            });
        }
    }

    items
}

fn clean_user_text(text: &str) -> String {
    let text = text.trim();
    if let Some(text) = strip_visible_prompt_prefix(text) {
        return text.trim().to_string();
    }

    for prefix in [
        "Ask mode: answer without editing files or making project changes unless I explicitly ask you to switch to build mode.",
        "Simple mode: build or edit the project for a nontechnical user. Keep visible explanations short and natural. Avoid raw markdown, command output, implementation checklists, or code details unless the user asks.",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            let rest = rest.trim();
            return rest.to_string();
        }
    }

    text.to_string()
}

fn simplify_plan_label(raw: &str) -> String {
    let label = raw
        .trim()
        .trim_start_matches('-')
        .trim_start_matches('*')
        .replace("**", "")
        .replace('`', "");
    if let Some(progress) = simplified_progress_line(&label) {
        progress
    } else {
        label
    }
}

fn strip_visible_prompt_prefix(text: &str) -> Option<String> {
    for marker in ["Simple build mode:", "Simple mode:", "Ask mode:"] {
        if !text.starts_with(marker) {
            continue;
        }

        if let Some((_, rest)) = text.split_once("\n\n") {
            return Some(rest.trim().to_string());
        }

        if marker == "Simple build mode:" {
            let rest = text
                .lines()
                .skip_while(|line| {
                    let line = line.trim();
                    line.is_empty()
                        || line.starts_with("Simple build mode:")
                        || line.starts_with("- ")
                })
                .collect::<Vec<_>>()
                .join("\n");
            return Some(rest.trim().to_string());
        }

        if marker == "Ask mode:" {
            let rest = text
                .lines()
                .skip(1)
                .skip_while(|line| line.trim().starts_with("Ask focused clarifying questions"))
                .collect::<Vec<_>>()
                .join("\n");
            return Some(rest.trim().to_string());
        }
    }

    None
}

fn task_kind(kind: &acp::ToolKind) -> TaskKind {
    match kind {
        acp::ToolKind::Edit => TaskKind::Edit,
        acp::ToolKind::Delete => TaskKind::Delete,
        acp::ToolKind::Execute => TaskKind::Execute,
        acp::ToolKind::Fetch => TaskKind::Fetch,
        acp::ToolKind::Move => TaskKind::Move,
        acp::ToolKind::Read => TaskKind::Read,
        acp::ToolKind::Search => TaskKind::Search,
        acp::ToolKind::Think => TaskKind::Think,
        _ => TaskKind::Other,
    }
}

fn translate_tool_label(kind: &acp::ToolKind, raw: &str) -> String {
    match kind {
        acp::ToolKind::Edit => {
            if looks_like_text_rewrite(raw) {
                return "Reworded text".to_string();
            }
            if let Some(filename) = quoted_filename(raw) {
                return format!("Updated {}", filename);
            }
            "Updated a file".to_string()
        }
        acp::ToolKind::Delete => quoted_filename(raw)
            .map(|filename| format!("Deleted {}", filename))
            .unwrap_or_else(|| "Deleted a file".to_string()),
        acp::ToolKind::Execute => command_task_label(raw),
        acp::ToolKind::Fetch => "Opened a reference".to_string(),
        acp::ToolKind::Read => "Read project context".to_string(),
        acp::ToolKind::Search => "Searched the project".to_string(),
        acp::ToolKind::Move => quoted_filename(raw)
            .map(|filename| format!("Moved {}", filename))
            .unwrap_or_else(|| "Moved a file".to_string()),
        acp::ToolKind::Think => "Planned next step".to_string(),
        _ => {
            let first_line = raw.lines().next().unwrap_or(raw).trim();
            if let Some(progress) = simplified_progress_line(first_line) {
                progress
            } else {
                first_line.replace('`', "").to_string()
            }
        }
    }
}

fn live_work_label(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_start_matches('-')
        .trim_start_matches('*')
        .trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn quoted_filename(raw: &str) -> Option<String> {
    let start = raw.find('`')?;
    let end = raw[start + 1..].find('`')?;
    let path = &raw[start + 1..start + 1 + end];
    Some(display_file_name(path))
}

fn display_file_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn looks_like_text_rewrite(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    lower.contains("reword")
        || lower.contains("rewrite")
        || lower.contains("copy")
        || lower.contains("text")
        || lower.contains("content")
}

fn command_task_label(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("npm")
        || lower.contains("pnpm")
        || lower.contains("yarn")
        || lower.contains("bun")
        || lower.contains("dev")
        || lower.contains("vite")
    {
        "Started app server".to_string()
    } else if lower.contains("install") {
        "Installed dependencies".to_string()
    } else if lower.contains("test") || lower.contains("check") || lower.contains("build") {
        "Checked the project".to_string()
    } else {
        "Ran a command".to_string()
    }
}

fn render_item(
    item: FriendlyItem,
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
    display_mode: ChatFeedDisplayMode,
    expanded_work_cards: &HashSet<usize>,
    collapsed_work_cards: &HashSet<usize>,
    cx: &mut Context<BeginnerChatFeed>,
) -> AnyElement {
    match item {
        FriendlyItem::UserBubble { index, text } => h_flex()
            .id(index)
            .w_full()
            .min_w_0()
            .justify_center()
            .py_1()
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .max_w(px(ds::CHAT_MAX_WIDTH))
                    .justify_end()
                    .child(render_message_bubble(text, MessageTone::User, cx)),
            )
            .into_any_element(),

        FriendlyItem::BackboardCard {
            index,
            text,
            thought,
            tasks,
        } => {
            let visible_text =
                text.and_then(|text| visible_assistant_text(&text, &tasks, display_mode));
            let visible_thought =
                thought.and_then(|thought| visible_thought_text(&thought, display_mode));
            let can_show_feedback = !tasks.is_empty()
                && preview_state == PreviewCardState::Ready
                && !tasks.iter().any(|task| task.failed);
            let work_expanded =
                work_card_is_expanded(index, &tasks, expanded_work_cards, collapsed_work_cards);
            v_flex()
                .id(index + 10_000)
                .w_full()
                .min_w_0()
                .items_center()
                .gap_2()
                .py_1()
                .when(tasks.is_empty(), |el| {
                    el.when(display_mode == ChatFeedDisplayMode::LiveWork, |el| {
                        el.when_some(visible_thought.clone(), |el, thought| {
                            el.child(render_thought_block(thought, cx))
                        })
                    })
                    .when_some(visible_text.clone(), |el, text| {
                        el.child(render_assistant_message_row(text, cx))
                    })
                })
                .when(!tasks.is_empty(), |el| {
                    let is_running = tasks.iter().any(|task| !task.done && !task.failed);
                    let show_artifact = !is_running
                        || preview_state == PreviewCardState::Ready
                        || tasks.iter().any(|task| task.failed);
                    el.child(render_work_section(
                        index,
                        visible_thought,
                        &tasks,
                        work_expanded,
                        display_mode,
                        cx,
                    ))
                    .when_some(visible_text.clone(), |el, text| {
                        el.child(render_assistant_message_row(text, cx))
                    })
                    .when(show_artifact, |el| {
                        el.child(render_artifact_card(
                            &tasks,
                            artifact_title,
                            preview_state,
                            cx,
                        ))
                    })
                })
                .when(can_show_feedback, |el| {
                    el.child(render_feedback_row(index, cx))
                })
                .into_any_element()
        }
    }
}

fn work_card_is_expanded(
    index: usize,
    tasks: &[TaskItem],
    expanded_work_cards: &HashSet<usize>,
    collapsed_work_cards: &HashSet<usize>,
) -> bool {
    if expanded_work_cards.contains(&index) {
        return true;
    }

    if collapsed_work_cards.contains(&index) {
        return false;
    }

    if tasks.iter().any(|task| !task.done && !task.failed) {
        return true;
    }

    if tasks.iter().any(|task| task.failed) {
        return true;
    }

    false
}

fn render_work_section(
    index: usize,
    thought: Option<String>,
    tasks: &[TaskItem],
    is_expanded: bool,
    display_mode: ChatFeedDisplayMode,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let header_id = SharedString::from(format!("simple-work-card-{index}"));
    let is_running = tasks.iter().any(|task| !task.done && !task.failed);
    let label = work_status_label(tasks, is_running);
    let hover_background = ds::hover_background(cx);
    let file_changes = file_change_count(tasks);
    let changes_label = changed_files_label(file_changes);

    v_flex()
        .w_full()
        .min_w_0()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .gap_2()
        .when(is_expanded, |el| {
            el.rounded(px(12.))
                .border_1()
                .border_color(ds::soft_border(cx))
                .bg(ds::field_background(cx).opacity(0.5))
                .p_2()
        })
        .child(
            h_flex()
                .id(header_id)
                .w_full()
                .min_w_0()
                .items_center()
                .justify_between()
                .gap_2()
                .px_2()
                .py_1p5()
                .rounded(px(8.))
                .cursor_pointer()
                .hover(move |el| el.bg(hover_background.opacity(0.28)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if is_expanded {
                        this.expanded_work_cards.remove(&index);
                        this.collapsed_work_cards.insert(index);
                    } else {
                        this.collapsed_work_cards.remove(&index);
                        this.expanded_work_cards.insert(index);
                    }
                    cx.notify();
                }))
                .child(
                    h_flex()
                        .min_w_0()
                        .items_center()
                        .gap_2()
                        .child(
                            Icon::new(if is_running {
                                IconName::LoadCircle
                            } else {
                                IconName::CheckDouble
                            })
                            .size(IconSize::XSmall)
                            .color(Color::Custom(if is_running {
                                ds::accent(cx)
                            } else {
                                ds::icon_muted(cx)
                            })),
                        )
                        .child(
                            Label::new(label)
                                .size(LabelSize::Small)
                                .color(Color::Custom(ds::text_muted(cx))),
                        )
                        .when(file_changes > 0 && !is_running, |el| {
                            el.child(
                                div()
                                    .id(SharedString::from(format!(
                                        "simple-work-card-changes-{index}"
                                    )))
                                    .px_2()
                                    .py_0p5()
                                    .rounded(px(4.))
                                    .border_1()
                                    .border_color(ds::soft_border(cx))
                                    .bg(ds::field_background(cx))
                                    .hover(move |el| el.bg(hover_background.opacity(0.55)))
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.stop_propagation();
                                        cx.emit(BeginnerChatFeedEvent::ChangesRequested);
                                    }))
                                    .child(
                                        Label::new(changes_label.clone())
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    ),
                            )
                        })
                        .when(file_changes == 0 || is_running, |el| {
                            el.child(
                                Label::new(work_summary_label(tasks))
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text_muted(cx).opacity(0.72))),
                            )
                        })
                        .child(
                            Icon::new(if is_expanded {
                                IconName::ChevronUp
                            } else {
                                IconName::ChevronDown
                            })
                            .size(IconSize::XSmall)
                            .color(Color::Custom(ds::icon_muted(cx))),
                        ),
                ),
        )
        .when(is_expanded, |el| {
            el.when(display_mode == ChatFeedDisplayMode::LiveWork, |el| {
                el.when_some(thought, |el, thought| {
                    el.child(render_thought_block(thought, cx))
                })
            })
            .child(render_task_list(tasks, display_mode, cx))
        })
}

fn file_change_count(tasks: &[TaskItem]) -> usize {
    tasks
        .iter()
        .filter(|task| {
            matches!(
                task.kind,
                TaskKind::Edit | TaskKind::Delete | TaskKind::Move
            )
        })
        .count()
}

fn changed_files_label(file_changes: usize) -> SharedString {
    SharedString::from(format!(
        "Backboard changed {} {}",
        file_changes,
        if file_changes == 1 { "file" } else { "files" }
    ))
}

fn work_status_label(tasks: &[TaskItem], is_running: bool) -> SharedString {
    if let Some(active_task) = tasks.iter().rev().find(|task| !task.done && !task.failed) {
        return SharedString::from(active_task_status_label(active_task));
    }

    if is_running {
        SharedString::from("Working in your project")
    } else {
        SharedString::from("Work completed")
    }
}

fn active_task_status_label(task: &TaskItem) -> String {
    match task.kind {
        TaskKind::Edit => active_edit_title(task),
        TaskKind::Delete => format!("Deleting {}", active_task_target(task)),
        TaskKind::Execute => command_status_title(&task.label),
        TaskKind::Fetch => "Opening a reference".to_string(),
        TaskKind::Move => format!("Moving {}", active_task_target(task)),
        TaskKind::Read => "Reading project context".to_string(),
        TaskKind::Search => "Searching the project".to_string(),
        TaskKind::Think => "Planning next step".to_string(),
        TaskKind::Other => task.label.clone(),
    }
}

fn work_summary_label(tasks: &[TaskItem]) -> SharedString {
    let file_changes = file_change_count(tasks);
    let commands = tasks
        .iter()
        .filter(|task| task.kind == TaskKind::Execute)
        .count();
    let context_steps = tasks
        .iter()
        .filter(|task| {
            matches!(
                task.kind,
                TaskKind::Fetch | TaskKind::Read | TaskKind::Search
            )
        })
        .count();

    let mut parts = Vec::new();
    if file_changes > 0 {
        parts.push(format!(
            "{} file {}",
            file_changes,
            if file_changes == 1 {
                "change"
            } else {
                "changes"
            }
        ));
    }
    if commands > 0 {
        parts.push(format!(
            "{} {}",
            commands,
            if commands == 1 { "command" } else { "commands" }
        ));
    }
    if context_steps > 0 {
        parts.push(format!(
            "{} context {}",
            context_steps,
            if context_steps == 1 { "step" } else { "steps" }
        ));
    }

    if parts.is_empty() {
        SharedString::from(format!(
            "{} {}",
            tasks.len(),
            if tasks.len() == 1 { "step" } else { "steps" }
        ))
    } else {
        SharedString::from(parts.join(" · "))
    }
}

fn render_task_list(
    tasks: &[TaskItem],
    display_mode: ChatFeedDisplayMode,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let rows = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| render_task_row(index, task, display_mode, cx).into_any_element())
        .collect::<Vec<_>>();

    v_flex()
        .w_full()
        .min_w_0()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .gap_1()
        .when(display_mode == ChatFeedDisplayMode::LiveWork, |el| {
            el.gap_1p5()
        })
        .children(rows)
}

fn render_task_row(
    index: usize,
    task: &TaskItem,
    display_mode: ChatFeedDisplayMode,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let status_icon = if task.failed {
        IconName::XCircle
    } else if task.done {
        IconName::Check
    } else {
        IconName::Circle
    };
    let color = if task.failed {
        ds::error(cx)
    } else if task.done {
        ds::text_muted(cx)
    } else {
        ds::accent(cx)
    };
    let kind_icon = task_kind_icon(task.kind);
    let detailed = display_mode == ChatFeedDisplayMode::LiveWork;
    let label = if detailed {
        task.detail_label.as_deref().unwrap_or(task.label.as_str())
    } else {
        task.label.as_str()
    };
    let label_element: AnyElement = if detailed {
        render_chat_copy(chat_text_for_display(label), ds::text(cx), cx).into_any_element()
    } else {
        Label::new(SharedString::from(label.to_string()))
            .size(LabelSize::Small)
            .color(Color::Custom(ds::text(cx)))
            .truncate()
            .into_any_element()
    };

    h_flex()
        .id(SharedString::from(format!("simple-task-row-{index}")))
        .w_full()
        .min_w_0()
        .min_h(px(28.))
        .items_center()
        .gap_2()
        .when(detailed, |el| {
            el.rounded(px(7.))
                .border_1()
                .border_color(ds::soft_border(cx).opacity(0.72))
                .bg(ds::field_background(cx).opacity(0.62))
                .px_2()
                .py_1()
                .items_start()
        })
        .child(
            Icon::new(status_icon)
                .size(IconSize::XSmall)
                .color(Color::Custom(color)),
        )
        .when(detailed, |el| {
            el.child(
                Icon::new(kind_icon)
                    .size(IconSize::XSmall)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
        })
        .child(label_element)
}

fn task_kind_icon(kind: TaskKind) -> IconName {
    match kind {
        TaskKind::Edit => IconName::ToolPencil,
        TaskKind::Delete => IconName::ToolDeleteFile,
        TaskKind::Execute => IconName::ToolTerminal,
        TaskKind::Fetch => IconName::ToolWeb,
        TaskKind::Move => IconName::ArrowRightLeft,
        TaskKind::Read => IconName::Reader,
        TaskKind::Search => IconName::ToolSearch,
        TaskKind::Think => IconName::ToolThink,
        TaskKind::Other => IconName::ToolHammer,
    }
}

fn render_artifact_card(
    tasks: &[TaskItem],
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    v_flex()
        .w_full()
        .min_w_0()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .min_h(px(96.))
        .rounded(px(14.))
        .bg(ds::card_background(cx))
        .border_1()
        .border_color(ds::soft_border(cx))
        .when(tasks.iter().any(|task| task.failed), |el| {
            el.border_color(ds::error(cx)).bg(ds::error_background(cx))
        })
        .p_4()
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .gap_4()
                .items_center()
                .child(render_artifact_tile(cx))
                .child(render_artifact_summary(
                    tasks,
                    artifact_title,
                    preview_state,
                    cx,
                )),
        )
}

#[derive(Clone, Copy)]
enum MessageTone {
    User,
    Assistant,
}

fn render_message_bubble(
    text: String,
    tone: MessageTone,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let colors = cx.theme().colors().clone();
    let text = chat_text_for_display(&text);

    div()
        .min_w_0()
        .max_w(px(match tone {
            MessageTone::User => 640.,
            MessageTone::Assistant => 720.,
        }))
        .overflow_x_hidden()
        .when(matches!(tone, MessageTone::User), |el| {
            el.bg(ds::field_background(cx))
                .border_1()
                .border_color(ds::soft_border(cx))
                .rounded(px(12.))
                .px_3()
                .py_2()
        })
        .when(matches!(tone, MessageTone::Assistant), |el| {
            el.px_1().py_1()
        })
        .child(
            v_flex()
                .w_full()
                .min_w_0()
                .gap_1p5()
                .child(render_chat_copy(text, colors.text, cx)),
        )
}

fn render_assistant_message_row(
    text: String,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    h_flex()
        .w_full()
        .min_w_0()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .justify_start()
        .child(render_message_bubble(text, MessageTone::Assistant, cx))
}

fn render_thought_block(text: String, cx: &mut Context<BeginnerChatFeed>) -> impl IntoElement {
    let text = chat_text_for_display(&text);
    h_flex()
        .w_full()
        .min_w_0()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .min_h(px(36.))
        .items_start()
        .gap_2()
        .rounded(px(10.))
        .border_1()
        .border_color(ds::soft_border(cx).opacity(0.74))
        .bg(ds::field_background(cx).opacity(0.48))
        .px_3()
        .py_2()
        .child(
            Icon::new(IconName::QueueMessage)
                .size(IconSize::XSmall)
                .color(Color::Custom(ds::icon_muted(cx))),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(render_chat_copy(text, ds::text_muted(cx), cx)),
        )
}

fn visible_assistant_text(
    text: &str,
    tasks: &[TaskItem],
    display_mode: ChatFeedDisplayMode,
) -> Option<String> {
    if is_internal_mode_response(text) {
        return None;
    }

    if display_mode == ChatFeedDisplayMode::LiveWork {
        live_assistant_text(text)
    } else {
        clean_assistant_text(text, tasks)
    }
}

fn visible_thought_text(text: &str, display_mode: ChatFeedDisplayMode) -> Option<String> {
    if display_mode == ChatFeedDisplayMode::LiveWork {
        live_thought_text(text)
    } else {
        clean_thought_text(text, display_mode)
    }
}

fn live_assistant_text(text: &str) -> Option<String> {
    live_feed_text(text)
}

fn live_thought_text(text: &str) -> Option<String> {
    live_feed_text(text)
}

fn live_feed_text(text: &str) -> Option<String> {
    if is_internal_mode_response(text) {
        return None;
    }

    let mut lines = Vec::new();
    for raw_line in readable_paragraphs(text) {
        let line = raw_line
            .trim()
            .replace("<thinking>", "")
            .replace("</thinking>", "");
        let line = line.trim();
        if line.is_empty() || is_low_value_progress_line(line) {
            continue;
        }
        push_unique_line(&mut lines, line.to_string());
    }

    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn clean_assistant_text(text: &str, tasks: &[TaskItem]) -> Option<String> {
    if is_internal_mode_response(text) {
        return None;
    }

    let mut cleaned = Vec::new();
    let mut in_code_block = false;
    for raw_line in readable_paragraphs(text) {
        let mut line = raw_line.trim();
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block || line.is_empty() || is_shell_noise(line) {
            continue;
        }

        line = line
            .trim_start_matches('#')
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if let Some((prefix, rest)) = line.split_once(". ")
            && prefix.chars().all(|ch| ch.is_ascii_digit())
        {
            line = rest.trim();
        }

        if let Some(progress) = simplified_progress_line(line) {
            push_unique_line(&mut cleaned, progress);
            continue;
        }

        if let Some(progress) = simple_mode_progress_rewrite(line) {
            push_unique_line(&mut cleaned, progress);
            continue;
        }

        let line = line
            .replace("**", "")
            .replace('`', "")
            .replace("AI", "Backboard");
        let line = line.trim();
        if !line.is_empty() && !is_overly_technical(line) {
            push_unique_line(&mut cleaned, line.to_string());
        }
    }

    if let Some(summary) = conversational_feature_summary(&cleaned) {
        return Some(summary);
    }

    if cleaned.is_empty() {
        if tasks.is_empty() {
            None
        } else {
            Some("I'm working through the changes and will keep the preview updated.".to_string())
        }
    } else {
        Some(cleaned.join("\n"))
    }
}

fn clean_thought_text(text: &str, display_mode: ChatFeedDisplayMode) -> Option<String> {
    if display_mode != ChatFeedDisplayMode::LiveWork {
        return None;
    }

    let mut cleaned = Vec::new();
    let mut in_code_block = false;
    for raw_line in readable_paragraphs(text) {
        let mut line = raw_line.trim();
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block || line.is_empty() || is_shell_noise(line) {
            continue;
        }

        line = line
            .trim_start_matches('#')
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if is_low_value_progress_line(line) {
            continue;
        }
        if let Some(line) = friendly_progress_status_line(line) {
            push_unique_line(&mut cleaned, line);
            continue;
        }
        if let Some(progress) = simplified_progress_line(line) {
            push_unique_line(&mut cleaned, progress);
            continue;
        }

        let line = line
            .replace("<thinking>", "")
            .replace("</thinking>", "")
            .replace("**", "")
            .replace('`', "")
            .replace("AI", "Backboard");
        let line = line.trim();
        if !line.is_empty() {
            push_unique_line(&mut cleaned, line.to_string());
        }
    }

    cleaned.into_iter().last()
}

fn simple_mode_progress_rewrite(line: &str) -> Option<String> {
    let lower = line.to_lowercase();

    if lower.contains("updating the files") {
        return Some("I'm working on it.".to_string());
    }

    if lower.contains("html")
        && lower.contains("css")
        && lower.contains("javascript")
        && lower.contains("file")
    {
        if let Some(for_index) = lower.find(" for ") {
            let subject = line[for_index + 5..].trim().trim_end_matches(':');
            if !subject.is_empty() {
                return Some(format!("I'm building {subject}."));
            }
        }
        return Some("I'm building the experience.".to_string());
    }

    None
}

fn conversational_feature_summary(lines: &[String]) -> Option<String> {
    if !looks_like_feature_report(lines) {
        return None;
    }

    let intro = lines
        .iter()
        .find(|line| is_completion_intro(line))
        .map(|line| sentence_from_line(line))
        .unwrap_or_else(|| "It's ready.".to_string());

    let features = lines
        .iter()
        .filter_map(|line| feature_report_item(line))
        .filter(|item| !is_control_item(item))
        .map(|item| chat_item_text(&item))
        .take(6)
        .collect::<Vec<_>>();
    let controls = lines
        .iter()
        .filter_map(|line| feature_report_item(line))
        .filter(|item| is_control_item(item))
        .map(|item| chat_item_text(&item))
        .take(3)
        .collect::<Vec<_>>();

    let mut sentences = vec![intro];
    if !features.is_empty() {
        sentences.push(format!("I added {}.", natural_join(&features)));
    }
    if !controls.is_empty() {
        sentences.push(format!("Use {}.", natural_join(&controls)));
    }

    Some(sentences.join(" "))
}

fn looks_like_feature_report(lines: &[String]) -> bool {
    let has_report_heading = lines.iter().any(|line| {
        let lower = line.trim().trim_end_matches(':').to_lowercase();
        lower == "the game features"
            || lower == "features"
            || lower == "controls"
            || lower.ends_with(" features")
    });
    let item_count = lines
        .iter()
        .filter(|line| feature_report_item(line).is_some())
        .count();

    has_report_heading && item_count >= 3
}

fn feature_report_item(line: &str) -> Option<String> {
    let (title, description) = line.split_once(':')?;
    let title = title.trim();
    if title.is_empty() || description.trim().is_empty() {
        return None;
    }

    let lower = title.to_lowercase();
    if lower == "features"
        || lower == "the game features"
        || lower.ends_with(" features")
        || lower == "controls"
    {
        return None;
    }

    Some(title.to_string())
}

fn is_completion_intro(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("ready") || lower.contains("complete") || lower.contains("done")
}

fn sentence_from_line(line: &str) -> String {
    let trimmed = line
        .trim()
        .trim_end_matches(|character: char| !character.is_alphanumeric() && character != ')')
        .trim();
    if trimmed.is_empty() {
        return "It's ready.".to_string();
    }

    format!("{trimmed}.")
}

fn chat_item_text(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            let ascii_letters = word
                .chars()
                .filter(|character| character.is_ascii_alphabetic())
                .collect::<String>();
            if ascii_letters.len() > 1
                && ascii_letters
                    .chars()
                    .all(|character| character.is_ascii_uppercase())
            {
                word.to_string()
            } else {
                word.to_lowercase()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_control_item(item: &str) -> bool {
    let lower = item.to_lowercase();
    lower.contains("key") || lower.contains("wasd") || lower.contains("spacebar")
}

fn natural_join(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [one, two] => format!("{one} and {two}"),
        _ => {
            let mut joined = items[..items.len() - 1].join(", ");
            joined.push_str(", and ");
            joined.push_str(&items[items.len() - 1]);
            joined
        }
    }
}

fn friendly_progress_status_line(line: &str) -> Option<String> {
    let trimmed = line.trim().trim_end_matches('.');
    let lower = trimmed.to_lowercase();

    if lower.starts_with("connected to model")
        || lower.starts_with("sending to model")
        || lower.starts_with("sending the task to the selected model")
        || lower.starts_with("retrying request")
    {
        return Some("Thinking through it.".to_string());
    }

    if lower.starts_with("loading the backboard agent runtime") {
        return Some("Starting Backboard.".to_string());
    }

    if lower.starts_with("preparing workspace context") {
        return Some("Checking the project.".to_string());
    }

    if lower.starts_with("planning next step") {
        return Some("Planning next step.".to_string());
    }

    if lower.starts_with("updating the visible task plan") {
        return Some("Updating the plan.".to_string());
    }

    if lower.starts_with("backboard is running ") || lower.starts_with("running ") {
        let tool_name = extract_progress_tool_name(trimmed).unwrap_or_default();
        return Some(match tool_name.as_str() {
            "bash" | "computer" | "repl" | "run_code" | "run_terminal_cmd" => {
                "Running a command.".to_string()
            }
            "list_dir" | "read_file" | "read_lints" => "Reading project context.".to_string(),
            "grep" | "find_path" | "find_references" | "go_to_definition" => {
                "Searching the project.".to_string()
            }
            "write" | "edit" | "search_replace" => "Updating files.".to_string(),
            "create_directory" => "Creating a folder.".to_string(),
            "delete_file" => "Deleting a file.".to_string(),
            "move_path" | "copy_path" => "Moving a file.".to_string(),
            "web_search" | "fetch" => "Opening a reference.".to_string(),
            "update_plan" => "Updating the plan.".to_string(),
            "" => "Working in your project.".to_string(),
            _ => "Working in your project.".to_string(),
        });
    }

    None
}

fn extract_progress_tool_name(line: &str) -> Option<String> {
    if let Some(start) = line.find('`') {
        let rest = &line[start + 1..];
        if let Some(end) = rest.find('`') {
            return Some(rest[..end].to_string());
        }
    }

    line.strip_prefix("Running ")
        .map(str::trim)
        .map(|tool| tool.trim_end_matches('.').to_string())
}

fn is_low_value_progress_line(line: &str) -> bool {
    let lower = line.trim().to_lowercase();
    lower.starts_with("connected to model")
        || lower.starts_with("sending to model")
        || lower.starts_with("sending the task to the selected model")
        || lower.starts_with("retrying request")
        || lower.starts_with("generated media")
        || lower.starts_with("realtime voice enabled")
}

fn is_internal_mode_response(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }

    (lower.contains("simple build mode")
        || lower.contains("simple mode guidelines")
        || lower.contains("build mode guidelines")
        || lower.contains("nontechnical user"))
        && (lower.starts_with("got it")
            || lower.starts_with("i understand")
            || lower.starts_with("i'm ready")
            || lower.starts_with("i’m ready")
            || lower.contains("what would you like to build"))
        || (lower.starts_with("it looks like the workspace is empty")
            && lower.contains("provide more details"))
}

fn push_unique_line(lines: &mut Vec<String>, line: String) {
    if lines.last().is_some_and(|last| last == &line) {
        return;
    }
    lines.push(line);
}

fn readable_paragraphs(text: &str) -> Vec<String> {
    let normalized = text
        .replace(":Now ", ":\nNow ")
        .replace(":Let ", ":\nLet ")
        .replace(".Now ", ".\nNow ")
        .replace(".Let ", ".\nLet ");
    normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn chat_text_for_display(text: &str) -> SharedString {
    let paragraphs = readable_paragraphs(text)
        .into_iter()
        .map(|paragraph| break_long_chat_tokens(&paragraph, CHAT_LONG_TOKEN_BREAK_CHARS))
        .collect::<Vec<_>>();
    SharedString::from(paragraphs.join("\n\n"))
}

fn render_chat_copy(text: SharedString, color: Hsla, cx: &App) -> impl IntoElement {
    div()
        .w_full()
        .min_w_0()
        .overflow_x_hidden()
        .text_ui_sm(cx)
        .line_height(relative(1.42))
        .text_color(color)
        .child(text)
}

fn break_long_chat_tokens(paragraph: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, token) in paragraph.split_whitespace().enumerate() {
        if index > 0 {
            output.push(' ');
        }

        if token.chars().count() <= max_chars {
            output.push_str(token);
            continue;
        }

        let mut token_chars = token.chars().peekable();
        while token_chars.peek().is_some() {
            for _ in 0..max_chars {
                let Some(ch) = token_chars.next() else {
                    break;
                };
                output.push(ch);
            }
            if token_chars.peek().is_some() {
                output.push('\n');
            }
        }
    }
    output
}

fn simplified_progress_line(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if lower.contains("tool call was not completed") {
        return Some("I need to retry one step.".to_string());
    }
    if lower.contains("start the dev server") || lower.contains("start the preview server") {
        return Some("I'm starting the preview.".to_string());
    }
    if lower.contains("test the build")
        || lower.contains("checking the project")
        || lower.contains("npm run")
        || lower.contains("run dev")
    {
        return Some("I'm checking the result.".to_string());
    }
    if lower.contains("update the files")
        || lower.starts_with("i'll create")
        || lower.starts_with("i'll update")
        || lower.starts_with("i’ll create")
        || lower.starts_with("i’ll update")
    {
        return Some("I'm updating the files.".to_string());
    }
    if lower.contains("setting up the project")
        || lower.contains("create a new vite")
        || lower.contains("add tailwind")
        || lower.contains("create the config")
        || lower.contains("we need to install")
    {
        return Some("I'm setting up the app.".to_string());
    }
    if lower.contains("project structure")
        || lower.contains("check if there's an existing project")
        || lower.starts_with("i'll start")
        || lower.starts_with("i’ll start")
        || lower.starts_with("let me ")
        || lower.starts_with("now let")
    {
        return Some("I'm checking the project.".to_string());
    }
    if lower.starts_with("good!")
        || lower.starts_with("perfect!")
        || lower.starts_with("excellent!")
    {
        return Some("That step worked.".to_string());
    }
    if lower.starts_with("the workspace is empty") {
        return Some("I'm starting from an empty project.".to_string());
    }
    None
}

fn is_shell_noise(line: &str) -> bool {
    let lower = line.to_lowercase();
    matches!(lower.as_str(), "bash" | "sh" | "shell" | "console")
        || lower.starts_with("npm ")
        || lower.starts_with("pnpm ")
        || lower.starts_with("yarn ")
        || lower.starts_with("bun ")
        || lower.starts_with("cd ")
        || lower.starts_with("cat ")
        || lower.starts_with("sed ")
        || lower.starts_with("mkdir ")
}

fn is_overly_technical(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("lucide react")
        || lower.contains("antialiased")
        || lower.contains("grid on desktop")
        || lower.contains("brand-")
        || lower.contains("npm run")
        || lower.contains("package.json")
}

fn render_artifact_summary(
    tasks: &[TaskItem],
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let status = artifact_status(tasks, artifact_title, preview_state);
    let colors = cx.theme().colors().clone();
    let preview_hover_border = ds::accent(cx);

    h_flex()
        .flex_1()
        .min_w_0()
        .gap_3()
        .items_center()
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_1()
                .child(
                    Label::new(status.title)
                        .size(LabelSize::Default)
                        .color(Color::Custom(colors.text)),
                )
                .child(
                    Label::new(status.metadata)
                        .size(LabelSize::Small)
                        .color(Color::Custom(colors.text_muted)),
                ),
        )
        .when(
            preview_state == PreviewCardState::Ready && !tasks.iter().any(|task| task.failed),
            |el| {
                el.child(
                    div()
                        .id("simple-artifact-preview")
                        .min_w(px(56.))
                        .px_2p5()
                        .py_1()
                        .rounded(px(4.))
                        .bg(ds::field_background(cx))
                        .border_1()
                        .border_color(ds::soft_border(cx))
                        .cursor_pointer()
                        .hover(move |el| el.bg(preview_hover_border.opacity(0.12)))
                        .on_click(cx.listener(|_, _, _, cx| {
                            cx.emit(BeginnerChatFeedEvent::PreviewRequested);
                        }))
                        .child(
                            Label::new("Preview")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(colors.text)),
                        ),
                )
            },
        )
}

struct ArtifactStatus {
    title: SharedString,
    metadata: SharedString,
}

fn artifact_status(
    tasks: &[TaskItem],
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
) -> ArtifactStatus {
    if tasks.iter().any(|task| task.failed) {
        return ArtifactStatus {
            title: SharedString::from("Preview unavailable"),
            metadata: SharedString::from("Try generating the artifact again."),
        };
    }

    if let Some(active_task) = tasks.iter().rev().find(|task| !task.done) {
        let title = match active_task.kind {
            TaskKind::Edit => active_edit_title(active_task),
            TaskKind::Delete => format!("Deleting {}", active_task_target(active_task)),
            TaskKind::Execute => command_status_title(&active_task.label),
            TaskKind::Fetch | TaskKind::Read | TaskKind::Search => {
                "Reading project context".to_string()
            }
            TaskKind::Move => format!("Moving {}", active_task_target(active_task)),
            TaskKind::Think => "Planning next step".to_string(),
            TaskKind::Other => active_task.label.clone(),
        };
        return ArtifactStatus {
            title: SharedString::from(title),
            metadata: SharedString::from("Working in your project"),
        };
    }

    match preview_state {
        PreviewCardState::Generating => ArtifactStatus {
            title: SharedString::from("Starting preview..."),
            metadata: SharedString::from("Looking for a runnable app."),
        },
        PreviewCardState::Ready => ArtifactStatus {
            title: artifact_title.clone(),
            metadata: {
                let changed_files = file_change_count(tasks);
                if changed_files > 0 {
                    changed_files_label(changed_files)
                } else {
                    SharedString::from("Preview ready")
                }
            },
        },
        PreviewCardState::Unavailable => ArtifactStatus {
            title: SharedString::from("Preview unavailable"),
            metadata: SharedString::from("No runnable app was detected."),
        },
        PreviewCardState::Building => {
            let changed_files = tasks
                .iter()
                .filter(|task| {
                    matches!(
                        task.kind,
                        TaskKind::Edit | TaskKind::Delete | TaskKind::Move
                    )
                })
                .count();
            let commands = tasks
                .iter()
                .filter(|task| task.kind == TaskKind::Execute)
                .count();
            let metadata = if changed_files > 0 && commands > 0 {
                format!("{changed_files} file changes · {commands} commands")
            } else if changed_files > 0 {
                format!("{changed_files} file changes")
            } else if commands > 0 {
                format!("{commands} commands")
            } else {
                "Working in your project".to_string()
            };
            ArtifactStatus {
                title: SharedString::from(format!("Building {}...", artifact_title.as_ref())),
                metadata: SharedString::from(metadata),
            }
        }
    }
}

fn active_edit_title(task: &TaskItem) -> String {
    if task.label == "Reworded text" {
        "Rewording text".to_string()
    } else {
        format!("Updating {}", active_task_target(task))
    }
}

fn active_task_target(task: &TaskItem) -> String {
    task.label
        .strip_prefix("Updated ")
        .or_else(|| task.label.strip_prefix("Edited "))
        .or_else(|| task.label.strip_prefix("Deleted "))
        .or_else(|| task.label.strip_prefix("Moved "))
        .unwrap_or(task.label.as_str())
        .to_string()
}

fn command_status_title(label: &str) -> String {
    let lower = label.to_lowercase();
    if lower.contains("npm")
        || lower.contains("pnpm")
        || lower.contains("yarn")
        || lower.contains("bun")
        || lower.contains("dev")
    {
        "Starting app server".to_string()
    } else if lower.contains("install") {
        "Installing dependencies".to_string()
    } else if lower.contains("check") || lower.contains("test") || lower.contains("build") {
        "Checking the project".to_string()
    } else if lower == "ran a command" {
        "Running a command".to_string()
    } else if lower == "started app server" {
        "Starting app server".to_string()
    } else if lower == "installed dependencies" {
        "Installing dependencies".to_string()
    } else if lower == "checked the project" {
        "Checking the project".to_string()
    } else {
        label.to_string()
    }
}

fn render_artifact_tile(cx: &App) -> impl IntoElement {
    let colors = cx.theme().colors().clone();
    div()
        .relative()
        .w(px(58.))
        .h(px(72.))
        .flex_none()
        .child(
            div()
                .absolute()
                .right(px(0.))
                .top(px(4.))
                .w(px(48.))
                .h(px(64.))
                .rounded_md()
                .bg(ds::app_background(cx)),
        )
        .child(
            div()
                .absolute()
                .left(px(0.))
                .top(px(0.))
                .w(px(52.))
                .h(px(68.))
                .rounded_md()
                .bg(ds::card_background(cx))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .size(px(18.))
                        .rounded_full()
                        .bg(colors.text_accent.opacity(0.12))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            Icon::new(IconName::Code)
                                .size(IconSize::Indicator)
                                .color(Color::Custom(colors.icon_accent)),
                        ),
                ),
        )
}

fn render_feedback_row(index: usize, cx: &mut Context<BeginnerChatFeed>) -> impl IntoElement {
    h_flex()
        .max_w(px(ds::CHAT_MAX_WIDTH))
        .w_full()
        .gap_1()
        .items_center()
        .child(render_feedback_button(
            SharedString::from(format!("simple-feedback-up-{index}")),
            IconName::ThumbsUp,
            "Good response",
            false,
            cx,
        ))
        .child(render_feedback_button(
            SharedString::from(format!("simple-feedback-down-{index}")),
            IconName::ThumbsDown,
            "Bad response",
            false,
            cx,
        ))
        .child(render_feedback_button(
            SharedString::from(format!("simple-feedback-copy-{index}")),
            IconName::Copy,
            "Copy",
            false,
            cx,
        ))
        .child(render_feedback_button(
            SharedString::from(format!("simple-feedback-share-{index}")),
            IconName::ArrowUpRight,
            "Share",
            true,
            cx,
        ))
}

fn render_feedback_button(
    id: SharedString,
    icon: IconName,
    tooltip: &'static str,
    emits_share: bool,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let hover_background = ds::hover_background(cx);
    div()
        .id(id)
        .size(px(26.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .tooltip(Tooltip::text(tooltip))
        .hover(move |el| el.bg(hover_background))
        .when(emits_share, |el| {
            el.on_click(cx.listener(|_, _, _, cx| {
                cx.emit(BeginnerChatFeedEvent::ShareRequested);
            }))
        })
        .child(
            Icon::new(icon)
                .size(IconSize::XSmall)
                .color(Color::Custom(ds::icon_muted(cx))),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_feature_report_as_chat_summary() {
        let text = "\
Your Mario Kart racing game is ready!

The game features:

Character Selection: Choose from Mario, Luigi, Princess Peach, or Yoshi
Racing Mechanics: Use arrow keys to steer and accelerate around the track
Power-ups: Collect bananas, fire flowers, stars, and rockets
Lap System: Complete 3 laps to finish the race
Backboard Opponents: Race against 3 computer-controlled racers
Live Stats: Track your speed, lap progress, position, and race time

Controls:

Arrow keys (or WASD): Steer and accelerate
Spacebar: Use collected power-ups
";

        assert_eq!(
            clean_assistant_text(text, &[]).as_deref(),
            Some(
                "Your Mario Kart racing game is ready. I added character selection, racing mechanics, power-ups, lap system, backboard opponents, and live stats. Use arrow keys (or WASD) and spacebar."
            )
        );
    }

    #[test]
    fn live_assistant_text_preserves_agent_details() {
        let text = "\
I'll inspect `src/App.tsx` first.

```bash
npm test
```

Then I'll update the layout.";

        assert_eq!(
            live_assistant_text(text).as_deref(),
            Some(
                "I'll inspect `src/App.tsx` first.\n```bash\nnpm test\n```\nThen I'll update the layout."
            )
        );
    }

    #[test]
    fn live_thought_text_keeps_multiple_progress_lines() {
        let text = "\
<thinking>Preparing workspace context.</thinking>
Sending to model.
Backboard is running `read_file`.";

        assert_eq!(
            live_thought_text(text).as_deref(),
            Some(
                "Preparing workspace context.\nSending to model.\nBackboard is running `read_file`."
            )
        );
    }

    #[test]
    fn work_card_expands_while_task_is_running() {
        let tasks = vec![TaskItem {
            label: "Read project context".to_string(),
            detail_label: Some("Reading `src/App.tsx`".to_string()),
            kind: TaskKind::Read,
            done: false,
            failed: false,
        }];

        assert!(work_card_is_expanded(
            7,
            &tasks,
            &HashSet::default(),
            &HashSet::default()
        ));
    }

    #[test]
    fn cleans_simple_mode_prompt_prefix_from_user_message() {
        let text = "\
Simple build mode: build or edit the project for a nontechnical user.
- Default to creating a polished web app or page when the user asks for a product, app, page, dashboard, tool, game, or visual experience and does not specify another medium.
- After creating or updating a runnable artifact, start or refresh the preview.

Make a recipe app";

        assert_eq!(clean_user_text(text), "Make a recipe app");
    }

    #[test]
    fn cleans_simple_mode_prompt_prefix_without_blank_separator() {
        let text = "\
Simple build mode: build or edit the project for a nontechnical user.
- Default to creating a polished web app or page when the user asks for a product, app, page, dashboard, tool, game, or visual experience and does not specify another medium.
- After creating or updating a runnable artifact, start or refresh the preview.
Make a recipe app";

        assert_eq!(clean_user_text(text), "Make a recipe app");
    }

    #[test]
    fn hides_simple_mode_instruction_acknowledgement() {
        let text = "Got it—I understand the simple build mode guidelines. I'm ready to help you create or edit a project for a nontechnical user, focusing on web apps and polished experiences.\n\nWhat would you like to build?";

        assert_eq!(
            visible_assistant_text(text, &[], ChatFeedDisplayMode::LiveWork),
            None
        );
    }

    #[test]
    fn hides_connection_progress_in_live_feed() {
        assert_eq!(live_feed_text("Connected to model."), None);
        assert_eq!(live_feed_text("Sending to model."), None);
    }
}
