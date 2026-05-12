use agent_client_protocol::schema as acp;
use acp_thread::{AcpThread, AgentThreadEntry, AssistantMessageChunk, ToolCallStatus};
use gpui::{App, Context, Entity, FocusHandle, Focusable, Render, SharedString, Subscription, Window};
use ui::{Color, Icon, IconName, IconSize, Label, LabelSize, prelude::*};

enum FriendlyItem {
    UserBubble { index: usize, text: String },
    AssistantBubble { index: usize, text: String },
    ToolAction { index: usize, label: String, done: bool, failed: bool },
}

pub struct BeginnerChatFeed {
    thread: Entity<AcpThread>,
    focus_handle: FocusHandle,
    _subscription: Subscription,
}

impl BeginnerChatFeed {
    pub fn new(thread: Entity<AcpThread>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe(&thread, |_, _, cx| cx.notify());
        Self {
            thread,
            focus_handle: cx.focus_handle(),
            _subscription: subscription,
        }
    }
}

impl Focusable for BeginnerChatFeed {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerChatFeed {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Collect owned items — all &str are immediately converted to String,
        // so the thread borrow ends before we build the element tree.
        let items = collect_items(&self.thread, cx);

        v_flex()
            .id("beginner-feed")
            .flex_1()
            .w_full()
            .overflow_y_scroll()
            .p_4()
            .gap_3()
            .children(items.into_iter().map(|item| render_item(item, cx)))
    }
}

fn collect_items(thread: &Entity<AcpThread>, cx: &App) -> Vec<FriendlyItem> {
    thread
        .read(cx)
        .entries()
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| friendly_item(index, entry, cx))
        .collect()
}

fn friendly_item(index: usize, entry: &AgentThreadEntry, cx: &App) -> Option<FriendlyItem> {
    match entry {
        AgentThreadEntry::UserMessage(msg) => {
            // Skip workspace-injected system messages (indented = sub-agent task)
            if msg.indented {
                return None;
            }
            let text = msg.content.to_markdown(cx).to_string();
            if text.trim().is_empty() {
                return None;
            }
            Some(FriendlyItem::UserBubble { index, text })
        }

        AgentThreadEntry::AssistantMessage(msg) => {
            // Show only Message chunks — skip Thought (internal reasoning)
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
            if text.trim().is_empty() {
                return None;
            }
            Some(FriendlyItem::AssistantBubble { index, text })
        }

        AgentThreadEntry::ToolCall(call) => {
            let raw_label = call.label.read(cx).source().to_string();
            let label = translate_tool_label(&call.kind, &raw_label);
            let done = matches!(call.status, ToolCallStatus::Completed);
            let failed = matches!(
                call.status,
                ToolCallStatus::Failed | ToolCallStatus::Rejected | ToolCallStatus::Canceled
            );
            Some(FriendlyItem::ToolAction { index, label, done, failed })
        }

        // Internal planning data — not surfaced to beginners
        AgentThreadEntry::CompletedPlan(_) => None,
    }
}

fn translate_tool_label(kind: &acp::ToolKind, raw: &str) -> String {
    match kind {
        acp::ToolKind::Edit => {
            // raw is like "Editing `index.html` +24 -0" — extract the filename
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
            // Truncate to first line and strip markdown backticks for readability
            let first_line = raw.lines().next().unwrap_or(raw).trim();
            first_line.replace('`', "").to_string()
        }
    }
}

fn render_item(item: FriendlyItem, cx: &App) -> impl IntoElement {
    match item {
        FriendlyItem::UserBubble { index, text } => h_flex()
            .id(index)
            .w_full()
            .justify_end()
            .py_1()
            .child(
                div()
                    .max_w(px(480.))
                    .rounded_xl()
                    .bg(cx.theme().colors().element_selected)
                    .px_3()
                    .py_2()
                    .child(
                        Label::new(SharedString::from(text))
                            .size(LabelSize::Small)
                            .color(Color::Default),
                    ),
            )
            .into_any_element(),

        FriendlyItem::AssistantBubble { index, text } => h_flex()
            .id(index + 10_000)
            .w_full()
            .justify_start()
            .py_1()
            .child(
                div()
                    .max_w(px(480.))
                    .rounded_xl()
                    .bg(cx.theme().colors().surface_background)
                    .border_1()
                    .border_color(cx.theme().colors().border)
                    .px_3()
                    .py_2()
                    .child(
                        Label::new(SharedString::from(text))
                            .size(LabelSize::Small)
                            .color(Color::Default),
                    ),
            )
            .into_any_element(),

        FriendlyItem::ToolAction { index, label, done, failed } => h_flex()
            .id(index + 20_000)
            .w_full()
            .gap_2()
            .items_center()
            .px_1()
            .py_0p5()
            .child(
                Icon::new(IconName::Pencil)
                    .size(IconSize::XSmall)
                    .color(if failed {
                        Color::Error
                    } else if done {
                        Color::Created
                    } else {
                        Color::Modified
                    }),
            )
            .child(
                Label::new(SharedString::from(label))
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .into_any_element(),
    }
}
