use std::{path::PathBuf, sync::Arc};

use acp_thread::{AcpThread, AcpThreadEvent, AgentThreadEntry};
use agent_client_protocol::schema as acp;
use gpui::{App, Context, Entity, EventEmitter, FocusHandle, Focusable, Render, Subscription};
use ui::{Color, Icon, IconName, IconSize, Label, LabelSize, prelude::*};

#[derive(Clone, Debug)]
pub struct FileChangeEntry {
    pub path: Arc<PathBuf>,
    pub status: ChangeStatus,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChangeStatus {
    Created,
    Modified,
}

pub enum FileChangesPanelEvent {
    FileSelected(Arc<PathBuf>),
}

impl EventEmitter<FileChangesPanelEvent> for FileChangesPanel {}

pub struct FileChangesPanel {
    thread: Entity<AcpThread>,
    focus_handle: FocusHandle,
    entries: Vec<FileChangeEntry>,
    selected_path: Option<Arc<PathBuf>>,
    _subscription: Subscription,
}

impl FileChangesPanel {
    pub fn new(thread: Entity<AcpThread>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.subscribe(&thread, |this, _, event: &AcpThreadEvent, cx| {
            match event {
                AcpThreadEvent::NewEntry | AcpThreadEvent::EntryUpdated(_) => {
                    this.refresh_entries(cx);
                }
                _ => {}
            }
        });
        let mut panel = Self {
            thread,
            focus_handle: cx.focus_handle(),
            entries: Vec::new(),
            selected_path: None,
            _subscription: subscription,
        };
        panel.refresh_entries(cx);
        panel
    }

    fn refresh_entries(&mut self, cx: &App) {
        let entries = self.thread.read(cx).entries();
        // Track unique paths in insertion order, last status wins.
        let mut seen: indexmap::IndexMap<PathBuf, ChangeStatus> = indexmap::IndexMap::new();
        for entry in entries {
            let AgentThreadEntry::ToolCall(call) = entry else {
                continue;
            };
            if call.kind != acp::ToolKind::Edit {
                continue;
            }
            for location in &call.locations {
                let path = location.path.clone();
                let status = if seen.contains_key(&path) {
                    ChangeStatus::Modified
                } else {
                    ChangeStatus::Created
                };
                seen.insert(path, status);
            }
        }
        self.entries = seen
            .into_iter()
            .map(|(path, status)| FileChangeEntry {
                path: Arc::new(path),
                status,
            })
            .collect();
    }

    fn select_file(&mut self, path: Arc<PathBuf>, cx: &mut Context<Self>) {
        self.selected_path = Some(path.clone());
        cx.emit(FileChangesPanelEvent::FileSelected(path));
        cx.notify();
    }
}

impl Focusable for FileChangesPanel {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for FileChangesPanel {
    fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entries = self.entries.clone();
        let selected = self.selected_path.clone();

        v_flex()
            .w(px(240.))
            .h_full()
            .bg(cx.theme().colors().surface_background)
            .border_r_1()
            .border_color(cx.theme().colors().border)
            .child(
                h_flex()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .child(
                        Label::new("Changes")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(if entries.is_empty() {
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
                    )
                    .into_any_element()
            } else {
                v_flex()
                    .id("file-changes-list")
                    .flex_1()
                    .overflow_y_scroll()
                    .p_1()
                    .children(entries.into_iter().map(|entry| {
                        let path = entry.path.clone();
                        let is_selected = selected.as_ref() == Some(&entry.path);
                        let file_name = entry
                            .path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let dir_label = entry
                            .path
                            .parent()
                            .and_then(|p| {
                                let s = p.to_string_lossy();
                                if s.is_empty() { None } else { Some(s.into_owned()) }
                            });

                        v_flex()
                            .id(SharedString::from(
                                entry.path.to_string_lossy().into_owned(),
                            ))
                            .px_2()
                            .py_1()
                            .gap_0p5()
                            .rounded_md()
                            .cursor_pointer()
                            .when(is_selected, |el| {
                                el.bg(cx.theme().colors().element_selected)
                            })
                            .hover(|el| el.bg(cx.theme().colors().element_hover))
                            .on_click(cx.listener(move |this, _, _window, cx| {
                                this.select_file(path.clone(), cx);
                            }))
                            .child(
                                h_flex()
                                    .gap_1p5()
                                    .child(
                                        Icon::new(match entry.status {
                                            ChangeStatus::Created => IconName::Plus,
                                            ChangeStatus::Modified => IconName::Pencil,
                                        })
                                        .size(IconSize::XSmall)
                                        .color(match entry.status {
                                            ChangeStatus::Created => Color::Created,
                                            ChangeStatus::Modified => Color::Modified,
                                        }),
                                    )
                                    .child(
                                        Label::new(SharedString::from(file_name))
                                            .size(LabelSize::Small)
                                            .truncate(),
                                    ),
                            )
                            .when_some(dir_label, |el, dir| {
                                el.child(
                                    Label::new(SharedString::from(dir))
                                        .size(LabelSize::XSmall)
                                        .color(Color::Disabled)
                                        .ml(px(18.))
                                        .truncate(),
                                )
                            })
                    }))
                    .into_any_element()
            })
    }
}
