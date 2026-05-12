use std::{path::PathBuf, sync::Arc};

use action_log::ActionLog;
use agent_ui::AgentPanel;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, Render, Subscription, WeakEntity,
    Window,
};
use ui::{
    Button, ButtonStyle, Color, Divider, Icon, IconName, IconSize, Label, LabelSize, Tooltip,
    prelude::*,
};
use workspace::Workspace;

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
    OpenInEditor,
}

impl EventEmitter<FileChangesPanelEvent> for FileChangesPanel {}

pub struct FileChangesPanel {
    workspace: WeakEntity<Workspace>,
    focus_handle: FocusHandle,
    entries: Vec<FileChangeEntry>,
    selected_path: Option<Arc<PathBuf>>,
    _subscriptions: Vec<Subscription>,
}

impl FileChangesPanel {
    pub fn new(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        let mut panel = Self {
            workspace,
            focus_handle: cx.focus_handle(),
            entries: Vec::new(),
            selected_path: None,
            _subscriptions: Vec::new(),
        };
        panel.subscribe_to_action_log(cx);
        panel
    }

    fn subscribe_to_action_log(&mut self, cx: &mut Context<Self>) {
        let Some(action_log) = self.current_action_log(cx) else {
            return;
        };
        self._subscriptions
            .push(cx.observe(&action_log, |this, _, cx| {
                this.refresh_entries(cx);
                cx.notify();
            }));
        self.refresh_entries(cx);
    }

    fn current_action_log(&self, cx: &App) -> Option<Entity<ActionLog>> {
        let workspace = self.workspace.upgrade()?;
        let panel = workspace.read(cx).panel::<AgentPanel>(cx)?;
        let thread_view = panel.read(cx).active_thread_view(cx)?;
        let thread = thread_view.read(cx).thread.clone();
        Some(thread.read(cx).action_log().clone())
    }

    fn refresh_entries(&mut self, cx: &App) {
        let Some(action_log) = self.current_action_log(cx) else {
            return;
        };
        let changed_buffers = action_log.read(cx).changed_buffers(cx);
        self.entries = changed_buffers
            .into_keys()
            .filter_map(|buffer| {
                let buffer_ref = buffer.read(cx);
                let rel_path_arc = buffer_ref.file()?.path().clone();
                let path: PathBuf = <util::rel_path::RelPath as AsRef<std::path::Path>>::as_ref(
                    &rel_path_arc,
                )
                .to_path_buf();
                let status = if buffer_ref.file().is_some() {
                    ChangeStatus::Modified
                } else {
                    ChangeStatus::Created
                };
                Some(FileChangeEntry {
                    path: Arc::new(path),
                    status,
                })
            })
            .collect();
        self.entries.sort_by(|a, b| a.path.cmp(&b.path));
    }

    #[allow(dead_code)]
    pub fn resubscribe(&mut self, cx: &mut Context<Self>) {
        self._subscriptions.clear();
        self.subscribe_to_action_log(cx);
    }

    fn open_in_editor(
        &mut self,
        _event: &gpui::ClickEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.emit(FileChangesPanelEvent::OpenInEditor);
    }

    fn select_file(&mut self, path: Arc<PathBuf>, _window: &mut Window, cx: &mut Context<Self>) {
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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

                        h_flex()
                            .id(SharedString::from(entry.path.to_string_lossy().into_owned()))
                            .px_2()
                            .py_1()
                            .gap_2()
                            .rounded_md()
                            .cursor_pointer()
                            .when(is_selected, |el| {
                                el.bg(cx.theme().colors().element_selected)
                            })
                            .hover(|el| el.bg(cx.theme().colors().element_hover))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_file(path.clone(), window, cx);
                            }))
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
                            )
                    }))
                    .into_any_element()
            })
            .child(Divider::horizontal())
            .child(
                div().p_2().child(
                    Button::new("view-in-editor", "View in Editor")
                        .full_width()
                        .style(ButtonStyle::Subtle)
                        .end_icon(Icon::new(IconName::ArrowRight))
                        .tooltip(Tooltip::text("Switch to the full editor"))
                        .on_click(cx.listener(Self::open_in_editor)),
                ),
            )
    }
}
