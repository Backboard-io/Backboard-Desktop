use acp_thread::{
    AcpThread, AcpThreadEvent, AgentThreadEntry, AssistantMessageChunk, ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, Hsla, Render, SharedString,
    Subscription, Window, rgb,
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
    Execute,
    Fetch,
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

fn simple_color(hex: u32) -> Hsla {
    rgb(hex).into()
}

fn render_simple_project_mark(size: f32) -> impl IntoElement {
    div()
        .size(px(size))
        .rounded_sm()
        .border_1()
        .border_color(simple_color(0xdde3ea))
        .bg(simple_color(0xfbfcfd))
        .flex()
        .items_center()
        .justify_center()
        .child(
            Icon::new(IconName::Sparkle)
                .size(IconSize::Indicator)
                .color(Color::Custom(simple_color(0x5b8cff))),
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
            .pb_16()
            .gap_4()
            .bg(simple_color(0xffffff))
            .when(is_empty, |el| {
                el.child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .child(render_simple_project_mark(16.))
                        .child(
                            Label::new("Thinking…")
                                .size(LabelSize::Small)
                                .color(Color::Custom(simple_color(0x8f9bad))),
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
    for prefix in [
        "Ask mode: answer without editing files or making project changes unless I explicitly ask you to switch to build mode.",
        "Simple mode: build or edit the project for a nontechnical user. Keep visible explanations short and natural. Avoid raw markdown, command output, implementation checklists, or code details unless the user asks.",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }

    text.to_string()
}

fn task_kind(kind: &acp::ToolKind) -> TaskKind {
    match kind {
        acp::ToolKind::Edit => TaskKind::Edit,
        acp::ToolKind::Execute => TaskKind::Execute,
        acp::ToolKind::Fetch => TaskKind::Fetch,
        _ => TaskKind::Other,
    }
}

fn translate_tool_label(kind: &acp::ToolKind, raw: &str) -> String {
    match kind {
        acp::ToolKind::Edit => {
            if let Some(start) = raw.find('`') {
                if let Some(end) = raw[start + 1..].find('`') {
                    let filename = &raw[start + 1..start + 1 + end];
                    return format!("Updated {}", filename);
                }
            }
            "Updated a file".to_string()
        }
        acp::ToolKind::Execute => "Ran a command".to_string(),
        acp::ToolKind::Fetch => "Explored your project".to_string(),
        _ => {
            let first_line = raw.lines().next().unwrap_or(raw).trim();
            first_line.replace('`', "").to_string()
        }
    }
}

fn render_item(
    item: FriendlyItem,
    artifact_title: &SharedString,
    preview_state: PreviewCardState,
    cx: &mut Context<BeginnerChatFeed>,
) -> AnyElement {
    match item {
        FriendlyItem::UserBubble { index, text } => v_flex()
            .id(index)
            .w_full()
            .items_start()
            .gap_0p5()
            .py_0p5()
            .child(
                Label::new("You")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(simple_color(0xaeb8c6))),
            )
            .child(render_message_bubble(text, MessageTone::User))
            .into_any_element(),

        FriendlyItem::BackboardCard { index, text, tasks } => {
            let cleaned_text = text.and_then(|text| clean_assistant_text(&text, &tasks));
            v_flex()
                .id(index + 10_000)
                .w_full()
                .items_start()
                .gap_1p5()
                .py_0p5()
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(render_simple_project_mark(14.))
                        .child(
                            Label::new("Backboard")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(simple_color(0xaeb8c6))),
                        ),
                )
                .when(!tasks.is_empty(), |el| {
                    el.child(
                        v_flex()
                            .w_full()
                            .max_w(px(448.))
                            .min_h(px(96.))
                            .rounded_xl()
                            .bg(simple_color(0xfbfcfd))
                            .border_1()
                            .border_color(if tasks.iter().any(|task| task.failed) {
                                simple_color(0xb92f52)
                            } else {
                                simple_color(0xf5f7fa)
                            })
                            .p_4()
                            .gap_1p5()
                            .child(
                                h_flex()
                                    .gap_4()
                                    .items_center()
                                    .child(render_artifact_tile())
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
                                                Color::Custom(simple_color(0xb92f52))
                                            } else if task.done {
                                                Color::Custom(simple_color(0x5b8cff))
                                            } else {
                                                Color::Custom(simple_color(0x8f9bad))
                                            },
                                        ),
                                    )
                                    .child(
                                        Label::new(SharedString::from(task.label))
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(simple_color(0x8f9bad))),
                                    )
                            })),
                    )
                })
                .when_some(cleaned_text, |el, text| {
                    el.child(render_message_bubble(text, MessageTone::Assistant))
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

fn render_message_bubble(text: String, tone: MessageTone) -> impl IntoElement {
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        lines.push(if trimmed.is_empty() {
            div().h(px(6.)).into_any_element()
        } else {
            div()
                .whitespace_normal()
                .line_height(relative(1.45))
                .child(
                    Label::new(SharedString::from(trimmed.to_string()))
                        .size(LabelSize::Small)
                        .color(Color::Custom(simple_color(0x111722))),
                )
                .into_any_element()
        });
    }

    div()
        .w_full()
        .max_w(px(448.))
        .rounded_lg()
        .border_1()
        .border_color(simple_color(0xf5f7fa))
        .bg(match tone {
            MessageTone::User => simple_color(0xfbfcfd),
            MessageTone::Assistant => simple_color(0xffffff),
        })
        .px_3()
        .py_2()
        .child(v_flex().gap_0p5().children(lines))
}

fn clean_assistant_text(text: &str, tasks: &[TaskItem]) -> Option<String> {
    if !tasks.is_empty() && looks_like_technical_progress(text) {
        return None;
    }

    let mut cleaned = Vec::new();
    let mut in_code_block = false;
    for raw_line in text.lines() {
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
                        .color(Color::Custom(simple_color(0x111722))),
                )
                .child(
                    Label::new(status.metadata)
                        .size(LabelSize::Small)
                        .color(Color::Custom(simple_color(0x8f9bad))),
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
                        .border_color(simple_color(0xdde3ea))
                        .bg(simple_color(0xffffff))
                        .cursor_pointer()
                        .hover(|el| el.border_color(simple_color(0x5b8cff)))
                        .on_click(cx.listener(|_, _, _, cx| {
                            cx.emit(BeginnerChatFeedEvent::PreviewRequested);
                        }))
                        .child(
                            Label::new("Preview")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(simple_color(0x141414))),
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
            TaskKind::Edit => format!("Editing {}", active_task_target(active_task)),
            TaskKind::Execute => command_status_title(&active_task.label),
            TaskKind::Fetch => "Reading project context".to_string(),
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
                .filter(|task| task.kind == TaskKind::Edit)
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

fn active_task_target(task: &TaskItem) -> String {
    task.label
        .strip_prefix("Updated ")
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
    } else {
        label.to_string()
    }
}

fn render_artifact_tile() -> impl IntoElement {
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
                .border_color(simple_color(0xeceff4))
                .bg(simple_color(0xffffff)),
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
                .border_color(simple_color(0xeceff4))
                .bg(simple_color(0xffffff))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .size(px(18.))
                        .rounded_full()
                        .bg(simple_color(0x5b8cff).opacity(0.12))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            Icon::new(IconName::Code)
                                .size(IconSize::Indicator)
                                .color(Color::Custom(simple_color(0x5b8cff))),
                        ),
                ),
        )
}
