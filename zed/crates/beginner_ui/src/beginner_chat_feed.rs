use acp_thread::{AcpThread, AcpThreadEvent, AgentThreadEntry, AssistantMessageChunk, ToolCallStatus};
use agent_client_protocol::schema as acp;
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, Render, SharedString, Subscription, Window,
};
use ui::{Color, Icon, IconName, IconSize, Label, LabelSize, Vector, VectorName, prelude::*};

struct TaskItem {
    label: String,
    done: bool,
    failed: bool,
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
    focus_handle: FocusHandle,
    _subscription: Subscription,
}

impl BeginnerChatFeed {
    pub fn new(thread: Entity<AcpThread>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.subscribe(&thread, |_, _, _event: &AcpThreadEvent, cx| {
            cx.notify();
        });
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
        let items = collect_items(&self.thread, cx);
        let is_empty = items.is_empty();

        v_flex()
            .id("beginner-feed")
            .flex_1()
            .w_full()
            .overflow_y_scroll()
            .px_4()
            .py_3()
            .gap_3()
            .when(is_empty, |el| {
                el.child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .child(
                            Vector::new(VectorName::BackboardLogo, rems_from_px(10.), rems_from_px(14.)),
                        )
                        .child(
                            Label::new("Thinking…")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                )
            })
            .children(items.into_iter().map(|item| render_item(item, cx)))
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
                let text = text.trim().to_string();
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
                let done = matches!(call.status, ToolCallStatus::Completed);
                let failed = matches!(
                    call.status,
                    ToolCallStatus::Failed | ToolCallStatus::Rejected | ToolCallStatus::Canceled
                );
                let task = TaskItem { label, done, failed };
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

fn render_item(item: FriendlyItem, cx: &App) -> impl IntoElement {
    match item {
        FriendlyItem::UserBubble { index, text } => v_flex()
            .id(index)
            .w_full()
            .items_end()
            .gap_0p5()
            .py_0p5()
            .child(
                Label::new("You")
                    .size(LabelSize::XSmall)
                    .color(Color::Muted),
            )
            .child(
                div()
                    .max_w_3_4()
                    .rounded_xl()
                    .rounded_tr_none()
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

        FriendlyItem::BackboardCard { index, text, tasks } => v_flex()
            .id(index + 10_000)
            .w_full()
            .items_start()
            .gap_1p5()
            .py_0p5()
            .child(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(
                        Vector::new(VectorName::BackboardLogo, rems_from_px(8.), rems_from_px(11.)),
                    )
                    .child(
                        Label::new("Backboard")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .when(!tasks.is_empty(), |el| {
                el.child(
                    v_flex()
                        .max_w_3_4()
                        .rounded_xl()
                        .rounded_tl_none()
                        .bg(cx.theme().colors().surface_background)
                        .border_1()
                        .border_color(cx.theme().colors().border)
                        .px_3()
                        .py_2()
                        .gap_1p5()
                        .children(tasks.into_iter().map(|task| {
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
                                    .color(if task.failed {
                                        Color::Error
                                    } else if task.done {
                                        Color::Created
                                    } else {
                                        Color::Modified
                                    }),
                                )
                                .child(
                                    Label::new(SharedString::from(task.label))
                                        .size(LabelSize::XSmall)
                                        .color(Color::Muted),
                                )
                        })),
                )
            })
            .when_some(text, |el, text_content| {
                el.child(
                    div()
                        .max_w_3_4()
                        .rounded_xl()
                        .rounded_tl_none()
                        .bg(cx.theme().colors().surface_background)
                        .border_1()
                        .border_color(cx.theme().colors().border)
                        .px_3()
                        .py_2()
                        .child(
                            Label::new(SharedString::from(text_content))
                                .size(LabelSize::Small)
                                .color(Color::Default),
                        ),
                )
            })
            .into_any_element(),
    }
}
