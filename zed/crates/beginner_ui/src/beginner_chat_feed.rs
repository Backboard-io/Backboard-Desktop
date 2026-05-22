use acp_thread::{
    AcpThread, AcpThreadEvent, AgentThreadEntry, AssistantMessageChunk, ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, Render, SharedString, Subscription,
    Window,
};
use ui::{Color, Icon, IconName, IconSize, Label, LabelSize, prelude::*};

#[derive(Clone)]
struct TaskItem {
    label: String,
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
        tasks: Vec<TaskItem>,
    },
}

pub struct BeginnerChatFeed {
    thread: Entity<AcpThread>,
    artifact_title: SharedString,
    preview_state: PreviewCardState,
    focus_handle: FocusHandle,
    _subscription: Subscription,
}

pub enum BeginnerChatFeedEvent {
    PreviewRequested,
}

impl EventEmitter<BeginnerChatFeedEvent> for BeginnerChatFeed {}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PreviewCardState {
    Building,
    Generating,
    Ready,
    Unavailable,
}

fn render_simple_project_mark(size: f32, cx: &App) -> impl IntoElement {
    let colors = cx.theme().colors().clone();
    div()
        .size(px(size))
        .rounded_sm()
        .border_1()
        .border_color(colors.border_variant)
        .bg(colors.element_background)
        .flex()
        .items_center()
        .justify_center()
        .child(
            Icon::new(IconName::Sparkle)
                .size(IconSize::Indicator)
                .color(Color::Custom(colors.icon_accent)),
        )
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
            focus_handle: cx.focus_handle(),
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
                cx,
            ));
        }

        v_flex()
            .id("beginner-feed")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .font_family("Inter")
            .px_4()
            .pt_4()
            .pb(px(220.))
            .gap_4()
            .bg(colors.editor_background)
            .when(is_empty, |el| {
                el.child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .child(render_simple_project_mark(16., cx))
                        .child(
                            Label::new("Thinking…")
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
    // (start_index, text, tasks)
    let mut pending_card: Option<(usize, Option<String>, Vec<TaskItem>)> = None;

    for (index, entry) in entries.iter().enumerate() {
        match entry {
            AgentThreadEntry::UserMessage(msg) => {
                if let Some((card_index, text, tasks)) = pending_card.take() {
                    if text.is_some() || !tasks.is_empty() {
                        items.push(FriendlyItem::BackboardCard {
                            index: card_index,
                            text,
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
                let parts: Vec<String> = msg
                    .chunks
                    .iter()
                    .filter_map(|chunk| match chunk {
                        AssistantMessageChunk::Message { block } => {
                            let s = block.to_markdown(cx).to_string();
                            if s.trim().is_empty() { None } else { Some(s) }
                        }
                        AssistantMessageChunk::Thought { .. } => None,
                    })
                    .collect();
                let text = parts.join("\n\n");
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
                            pending_card = Some((index, Some(text), Vec::new()));
                        }
                    }
                }
            }

            AgentThreadEntry::ToolCall(call) => {
                let raw_label = call.label.read(cx).source().to_string();
                let label = translate_tool_label(&call.kind, &raw_label);
                let kind = task_kind(&call.kind);
                let done = matches!(call.status, ToolCallStatus::Completed);
                let failed = matches!(
                    call.status,
                    ToolCallStatus::Failed | ToolCallStatus::Rejected | ToolCallStatus::Canceled
                );
                let task = TaskItem {
                    label,
                    kind,
                    done,
                    failed,
                };
                match &mut pending_card {
                    Some(card) => card.2.push(task),
                    None => {
                        pending_card = Some((index, None, vec![task]));
                    }
                }
            }

            AgentThreadEntry::CompletedPlan(_) => {}
        }
    }

    if let Some((card_index, text, tasks)) = pending_card {
        if text.is_some() || !tasks.is_empty() {
            items.push(FriendlyItem::BackboardCard {
                index: card_index,
                text,
                tasks,
            });
        }
    }

    items
}

fn clean_user_text(text: &str) -> String {
    if looks_like_landing_page_testcase(text) {
        return "build me a landing page".to_string();
    }

    for prefix in [
        "Ask mode: answer without editing files or making project changes unless I explicitly ask you to switch to build mode.",
        "Simple mode: build or edit the project for a nontechnical user. Keep visible explanations short and natural. Avoid raw markdown, command output, implementation checklists, or code details unless the user asks.",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            let rest = rest.trim();
            if looks_like_landing_page_testcase(rest) {
                return "build me a landing page".to_string();
            }
            return rest.to_string();
        }
    }

    text.to_string()
}

fn looks_like_landing_page_testcase(text: &str) -> bool {
    text.contains("Create a single-page hero section")
        && text.contains("fullscreen looping background video")
        && text.contains("Liquid Glass Effect")
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
                return format!("Edited {}", filename);
            }
            "Edited a file".to_string()
        }
        acp::ToolKind::Delete => quoted_filename(raw)
            .map(|filename| format!("Deleted {}", filename))
            .unwrap_or_else(|| "Deleted a file".to_string()),
        acp::ToolKind::Execute => command_task_label(raw),
        acp::ToolKind::Fetch | acp::ToolKind::Read | acp::ToolKind::Search => {
            "Read project context".to_string()
        }
        acp::ToolKind::Move => quoted_filename(raw)
            .map(|filename| format!("Moved {}", filename))
            .unwrap_or_else(|| "Moved a file".to_string()),
        acp::ToolKind::Think => "Planned next step".to_string(),
        _ => {
            let first_line = raw.lines().next().unwrap_or(raw).trim();
            if is_agent_progress_line(first_line) {
                "Worked on your request".to_string()
            } else {
                first_line.replace('`', "").to_string()
            }
        }
    }
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
    cx: &mut Context<BeginnerChatFeed>,
) -> AnyElement {
    let colors = cx.theme().colors().clone();
    match item {
        FriendlyItem::UserBubble { index, text } => v_flex()
            .id(index)
            .w_full()
            .items_start()
            .gap_0p5()
            .py_1()
            .child(
                Label::new("You")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(colors.text_muted)),
            )
            .child(render_message_bubble(text, MessageTone::User, cx))
            .into_any_element(),

        FriendlyItem::BackboardCard { index, text, tasks } => {
            let cleaned_text = text.and_then(|text| clean_assistant_text(&text, &tasks));
            v_flex()
                .id(index + 10_000)
                .w_full()
                .items_start()
                .gap_1p5()
                .py_1()
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(render_simple_project_mark(14., cx))
                        .child(
                            Label::new("Backboard")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(colors.text_muted)),
                        ),
                )
                .when(!tasks.is_empty(), |el| {
                    el.child(
                        v_flex()
                            .w_full()
                            .max_w(px(640.))
                            .min_h(px(96.))
                            .rounded_xl()
                            .bg(colors.element_background)
                            .border_1()
                            .border_color(if tasks.iter().any(|task| task.failed) {
                                cx.theme().status().error_border
                            } else {
                                colors.border_variant
                            })
                            .p_4()
                            .gap_1p5()
                            .child(
                                h_flex()
                                    .gap_4()
                                    .items_center()
                                    .child(render_artifact_tile(cx))
                                    .child(render_artifact_summary(
                                        &tasks,
                                        artifact_title,
                                        preview_state,
                                        cx,
                                    )),
                            )
                            .children(tasks.clone().into_iter().map(|task| {
                                h_flex()
                                    .gap_1p5()
                                    .items_center()
                                    .child(
                                        Icon::new(if task.failed {
                                            IconName::XCircle
                                        } else if task.done {
                                            IconName::Check
                                        } else {
                                            IconName::Circle
                                        })
                                        .size(IconSize::XSmall)
                                        .color(
                                            if task.failed {
                                                Color::Error
                                            } else if task.done {
                                                Color::Accent
                                            } else {
                                                Color::Muted
                                            },
                                        ),
                                    )
                                    .child(
                                        Label::new(SharedString::from(task_row_label(&task)))
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(colors.text_muted)),
                                    )
                            })),
                    )
                })
                .when_some(cleaned_text, |el, text| {
                    el.child(render_message_bubble(text, MessageTone::Assistant, cx))
                })
                .into_any_element()
        }
    }
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
    let lines = chat_lines(&text)
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                div().h(px(7.)).into_any_element()
            } else {
                Label::new(SharedString::from(line))
                    .size(LabelSize::Small)
                    .color(Color::Custom(colors.text))
                    .single_line()
                    .into_any_element()
            }
        })
        .collect::<Vec<_>>();

    div()
        .w_full()
        .max_w(px(640.))
        .rounded_lg()
        .border_1()
        .border_color(colors.border_variant)
        .bg(match tone {
            MessageTone::User => colors.element_background,
            MessageTone::Assistant => colors
                .editor_background
                .blend(colors.element_background.opacity(0.18)),
        })
        .px_3()
        .py_2()
        .child(v_flex().gap_1().children(lines))
}

fn clean_assistant_text(text: &str, tasks: &[TaskItem]) -> Option<String> {
    if looks_like_technical_progress(text) || (!tasks.is_empty() && looks_like_work_narration(text))
    {
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
        if in_code_block
            || line.is_empty()
            || is_shell_noise(line)
            || is_agent_progress_line(line)
            || is_work_narration_line(line)
        {
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

        let line = line
            .replace("**", "")
            .replace('`', "")
            .replace("AI", "Backboard");
        let line = line.trim();
        if !line.is_empty() && !is_overly_technical(line) {
            cleaned.push(line.to_string());
        }
    }

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.join("\n"))
    }
}

fn chat_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for paragraph in readable_paragraphs(text) {
        if paragraph.is_empty() {
            if !lines.last().is_some_and(|line| line.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }
        lines.extend(wrap_chat_paragraph(&paragraph, 74));
        lines.push(String::new());
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
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

fn wrap_chat_paragraph(paragraph: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in paragraph.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
            continue;
        }
        if current.chars().count() + 1 + word.chars().count() > max_chars {
            lines.push(current);
            current = word.to_string();
        } else {
            current.push(' ');
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn looks_like_technical_progress(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("npm ")
        || lower.contains("pnpm ")
        || lower.contains("yarn ")
        || lower.contains("```")
        || lower.contains("lucide")
        || lower.contains("responsive:")
        || lower.contains("inter font")
        || lower.contains("run dev")
}

fn is_agent_progress_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("now let")
        || lower.starts_with("let me ")
        || lower.starts_with("i'll start")
        || lower.starts_with("i'll create")
        || lower.starts_with("i’ll start")
        || lower.starts_with("i’ll create")
        || lower.starts_with("good!")
        || lower.starts_with("perfect!")
        || lower.starts_with("excellent!")
        || lower.starts_with("the workspace is empty")
        || lower.starts_with("we need to install")
        || lower.contains("tool call was not completed")
}

fn looks_like_work_narration(text: &str) -> bool {
    readable_paragraphs(text)
        .iter()
        .filter(|line| is_work_narration_line(line))
        .count()
        >= 2
}

fn is_work_narration_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("setting up the project")
        || lower.contains("project structure")
        || lower.contains("checking the project")
        || lower.contains("check if there's an existing project")
        || lower.contains("create a new vite")
        || lower.contains("add tailwind")
        || lower.contains("create the config")
        || lower.contains("update the files")
        || lower.contains("test the build")
        || lower.contains("start the dev server")
        || lower.contains("start the preview server")
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

fn task_row_label(task: &TaskItem) -> String {
    match task.kind {
        TaskKind::Edit => task.label.clone(),
        TaskKind::Delete => task.label.clone(),
        TaskKind::Move => task.label.clone(),
        TaskKind::Execute => task.label.clone(),
        TaskKind::Fetch | TaskKind::Read | TaskKind::Search => "Read project context".to_string(),
        TaskKind::Think => "Planned next step".to_string(),
        TaskKind::Other => task.label.clone(),
    }
}

fn render_artifact_summary(
    tasks: &[TaskItem],
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
    cx: &mut Context<BeginnerChatFeed>,
) -> impl IntoElement {
    let status = artifact_status(tasks, artifact_title, preview_state);
    let colors = cx.theme().colors().clone();

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
                        .rounded_sm()
                        .border_1()
                        .border_color(colors.border_variant)
                        .bg(colors.element_background)
                        .cursor_pointer()
                        .hover(|el| el.border_color(colors.text_accent))
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
            title: SharedString::from("Could not finish changes"),
            metadata: SharedString::from("Review the failed step and try again."),
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
            title: SharedString::from("Starting local preview"),
            metadata: SharedString::from("Waiting for the app server to respond."),
        },
        PreviewCardState::Ready => ArtifactStatus {
            title: SharedString::from("Preview ready"),
            metadata: artifact_title.clone(),
        },
        PreviewCardState::Unavailable => ArtifactStatus {
            title: SharedString::from("Changes finished"),
            metadata: SharedString::from("No runnable preview was detected."),
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
                title: SharedString::from(format!("Updating {}", artifact_title.as_ref())),
                metadata: SharedString::from(metadata),
            }
        }
    }
}

fn active_edit_title(task: &TaskItem) -> String {
    if task.label == "Reworded text" {
        "Rewording text".to_string()
    } else {
        format!("Editing {}", active_task_target(task))
    }
}

fn active_task_target(task: &TaskItem) -> String {
    task.label
        .strip_prefix("Edited ")
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
                .border_1()
                .border_color(colors.border_variant)
                .bg(colors.editor_background),
        )
        .child(
            div()
                .absolute()
                .left(px(0.))
                .top(px(0.))
                .w(px(52.))
                .h(px(68.))
                .rounded_md()
                .border_1()
                .border_color(colors.border_variant)
                .bg(colors.element_background)
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
