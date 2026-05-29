use db::kvp::KeyValueStore;
use editor::{Editor, EditorElement, EditorEvent, EditorStyle};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Subscription, TextStyle, WeakEntity, Window, prelude::*,
};
use language::language_settings::SoftWrap;
use settings::Settings;
use theme_settings::ThemeSettings;
use ui::{
    Button, ButtonSize, ButtonStyle, Color, ElevationIndex, Headline, HeadlineSize, Icon,
    IconButton, IconName, IconSize, Label, LabelSize, TintColor, Tooltip, Vector, VectorName,
    prelude::*,
};
use util::ResultExt;
use workspace::{MultiWorkspace, Workspace};

use crate::agent_panel::{
    AgentPanel, BackboardAgentWorkspaceKind, BackboardAgentWorkspaceMode,
    BackboardAgentWorkspaceScope,
};

const TASKS_KVP_KEY: &str = "backboard_tasks_v1";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedBackboardTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl SavedBackboardTask {
    fn new(title: String, prompt: String) -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            prompt,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }
}

#[derive(Clone, Copy)]
struct StarterTask {
    title: &'static str,
    prompt: &'static str,
}

const STARTER_TASKS: &[StarterTask] = &[
    StarterTask {
        title: "Review current changes",
        prompt: "Review the current code changes for bugs, regressions, risky assumptions, and missing tests. Prioritize concrete findings with file references.",
    },
    StarterTask {
        title: "Harden tests",
        prompt: "Inspect the touched code and add or repair focused tests for the highest-risk behavior. Run the smallest relevant test command and report the result.",
    },
    StarterTask {
        title: "Update docs",
        prompt: "Update the relevant documentation for the current implementation. Keep it factual, concise, and aligned with the code in this repository.",
    },
    StarterTask {
        title: "Clean up refactor",
        prompt: "Refactor the selected area for clarity while preserving behavior. Keep changes scoped, follow existing patterns, and run a focused verification command.",
    },
];

pub struct BackboardTasksPage {
    workspace: WeakEntity<Workspace>,
    multi_workspace: WeakEntity<MultiWorkspace>,
    title_editor: Entity<Editor>,
    prompt_editor: Entity<Editor>,
    saved_tasks: Vec<SavedBackboardTask>,
    selected_task_id: Option<String>,
    observing_agent_panel: bool,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<gpui::Task<()>>,
}

impl BackboardTasksPage {
    pub fn new(
        workspace: &Workspace,
        multi_workspace: WeakEntity<MultiWorkspace>,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> Entity<Self> {
        let workspace = workspace.weak_handle();
        cx.new(|cx| {
            let title_editor = cx.new(|cx| {
                let mut editor = Editor::auto_height(1, 2, window, cx);
                editor.set_placeholder_text("Task name", window, cx);
                editor
            });
            let prompt_editor = cx.new(|cx| {
                let mut editor = Editor::auto_height(5, 14, window, cx);
                editor.set_soft_wrap_mode(SoftWrap::EditorWidth, cx);
                editor.set_placeholder_text(
                    "Describe the task this saved agent should run...",
                    window,
                    cx,
                );
                editor
            });

            cx.subscribe(&title_editor, Self::handle_editor_event)
                .detach();
            cx.subscribe(&prompt_editor, Self::handle_editor_event)
                .detach();

            let mut page = Self {
                workspace,
                multi_workspace,
                title_editor,
                prompt_editor,
                saved_tasks: Vec::new(),
                selected_task_id: None,
                observing_agent_panel: false,
                _subscriptions: Vec::new(),
                _tasks: Vec::new(),
            };
            let load_task = page.load_tasks(cx);
            page._tasks.push(load_task);
            page
        })
    }

    fn handle_editor_event(&mut self, _: Entity<Editor>, _: &EditorEvent, cx: &mut Context<Self>) {
        cx.notify();
    }

    fn load_tasks(&self, cx: &mut Context<Self>) -> gpui::Task<()> {
        cx.spawn(async move |this, cx| {
            let tasks = cx.update(|cx| {
                let kvp = KeyValueStore::global(cx);
                decode_tasks(kvp.read_kvp(TASKS_KVP_KEY).log_err().flatten())
            });
            this.update(cx, |this, cx| {
                this.saved_tasks = tasks;
                cx.notify();
            })
            .ok();
        })
    }

    fn persist_tasks(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let tasks = self.saved_tasks.clone();
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&tasks) {
                kvp.write_kvp(TASKS_KVP_KEY.to_string(), json)
                    .await
                    .log_err();
            }
        })
        .detach();
    }

    fn title_text(&self, cx: &App) -> String {
        self.title_editor.read(cx).text(cx).trim().to_string()
    }

    fn prompt_text(&self, cx: &App) -> String {
        self.prompt_editor.read(cx).text(cx).trim().to_string()
    }

    fn has_prompt(&self, cx: &App) -> bool {
        !self.prompt_text(cx).is_empty()
    }

    fn select_task(
        &mut self,
        task: SavedBackboardTask,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selected_task_id = Some(task.id.clone());
        self.title_editor
            .update(cx, |editor, cx| editor.set_text(task.title, window, cx));
        self.prompt_editor
            .update(cx, |editor, cx| editor.set_text(task.prompt, window, cx));
        self.prompt_editor
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
        cx.notify();
    }

    fn use_starter(&mut self, starter: StarterTask, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_task_id = None;
        self.title_editor
            .update(cx, |editor, cx| editor.set_text(starter.title, window, cx));
        self.prompt_editor
            .update(cx, |editor, cx| editor.set_text(starter.prompt, window, cx));
        self.prompt_editor
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
        cx.notify();
    }

    fn new_task(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_task_id = None;
        self.title_editor
            .update(cx, |editor, cx| editor.set_text("", window, cx));
        self.prompt_editor
            .update(cx, |editor, cx| editor.set_text("", window, cx));
        self.title_editor
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
        cx.notify();
    }

    fn save_current_task(&mut self, cx: &mut Context<Self>) {
        let prompt = self.prompt_text(cx);
        if prompt.is_empty() {
            return;
        }

        let title = normalize_title(self.title_text(cx), &prompt);
        if let Some(selected_id) = self.selected_task_id.clone()
            && let Some(task) = self
                .saved_tasks
                .iter_mut()
                .find(|task| task.id == selected_id)
        {
            task.title = title;
            task.prompt = prompt;
            task.updated_at_ms = now_ms();
            self.persist_tasks(cx);
            cx.notify();
            return;
        }

        let task = SavedBackboardTask::new(title, prompt);
        self.selected_task_id = Some(task.id.clone());
        self.saved_tasks.insert(0, task);
        self.persist_tasks(cx);
        cx.notify();
    }

    fn delete_current_task(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(selected_id) = self.selected_task_id.take() {
            self.saved_tasks.retain(|task| task.id != selected_id);
            self.persist_tasks(cx);
        }
        self.new_task(window, cx);
    }

    fn ensure_agent_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<AgentPanel>> {
        let workspace = self.workspace.upgrade()?;
        let panel = workspace.update(cx, |workspace, cx| {
            workspace.panel::<AgentPanel>(cx).unwrap_or_else(|| {
                let panel = cx.new(|cx| AgentPanel::new(workspace, None, window, cx));
                workspace.add_panel(panel.clone(), window, cx);
                panel
            })
        });

        if !self.observing_agent_panel {
            self._subscriptions
                .push(cx.observe(&panel, |_, _, cx| cx.notify()));
            self.observing_agent_panel = true;
        }

        Some(panel)
    }

    fn run_current_task(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = self.prompt_text(cx);
        if prompt.is_empty() {
            return;
        }

        let mut created_thread_ids = Vec::new();
        if let Some(panel) = self.ensure_agent_panel(window, cx) {
            panel.update(cx, |panel, cx| {
                let result = panel.spawn_backboard_workspace_agents(
                    vec![prompt],
                    BackboardAgentWorkspaceScope::WholeProject,
                    BackboardAgentWorkspaceKind::Build,
                    BackboardAgentWorkspaceMode::Free,
                    window,
                    cx,
                );
                created_thread_ids = result.created_thread_ids;
            });
        }

        if let Some(thread_id) = created_thread_ids.first().copied()
            && let Some(workspace) = self.workspace.upgrade()
        {
            workspace.update(cx, |workspace, cx| {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.activate_backboard_workspace_agent(thread_id, window, cx);
                    });
                }
            });
        }

        self.multi_workspace
            .update(cx, |multi_workspace, cx| {
                multi_workspace.set_multi_agent_expanded(true, window, cx);
            })
            .ok();
    }

    fn render_text_editor(
        &self,
        editor: &Entity<Editor>,
        font_size: f32,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let settings = ThemeSettings::get_global(cx);
        let text_style = TextStyle {
            color: cx.theme().colors().text,
            font_family: settings.ui_font.family.clone(),
            font_features: settings.ui_font.features.clone(),
            font_fallbacks: settings.ui_font.fallbacks.clone(),
            font_size: rems(font_size).into(),
            font_weight: settings.ui_font.weight,
            line_height: relative(1.3),
            ..Default::default()
        };

        EditorElement::new(
            editor,
            EditorStyle {
                background: cx.theme().colors().element_background,
                local_player: cx.theme().players().local(),
                text: text_style,
                ..Default::default()
            },
        )
    }

    fn render_task_row(
        &self,
        task: SavedBackboardTask,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_task_id.as_deref() == Some(task.id.as_str());
        let id = task.id.clone();
        let title = task.title.clone();
        let prompt = task.prompt.clone();
        let border_color = if selected {
            cx.theme().colors().text_accent
        } else {
            cx.theme().colors().border_variant
        };
        let background = if selected {
            cx.theme().colors().element_selected
        } else {
            cx.theme().colors().editor_background
        };

        v_flex()
            .id(format!("saved-backboard-task-{id}"))
            .w_full()
            .min_h(rems_from_px(72.))
            .rounded_md()
            .border_1()
            .border_color(border_color)
            .bg(background)
            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
            .cursor_pointer()
            .hover(|style| style.bg(cx.theme().colors().element_hover))
            .p_2()
            .gap_1()
            .on_click(cx.listener(move |this, _, window, cx| {
                this.select_task(task.clone(), window, cx);
            }))
            .child(Label::new(title).size(LabelSize::Small).color(if selected {
                Color::Accent
            } else {
                Color::Default
            }))
            .child(
                Label::new(first_line(&prompt))
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
    }

    fn render_starter_card(
        &self,
        starter: StarterTask,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
            .p_3()
            .gap_2()
            .child(
                Label::new(starter.title)
                    .size(LabelSize::Small)
                    .color(Color::Default),
            )
            .child(
                Label::new(first_line(starter.prompt))
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                Button::new(format!("use-starter-{}", starter.title), "Use")
                    .size(ButtonSize::Compact)
                    .style(ButtonStyle::Subtle)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.use_starter(starter, window, cx);
                    })),
            )
    }

    fn render_left_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .w(rems_from_px(360.))
            .min_w(rems_from_px(300.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().elevated_surface_background)
            .child(
                h_flex()
                    .h(rems_from_px(52.))
                    .px_3()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        Label::new("Saved tasks")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Button::new("new-saved-task", "New")
                            .start_icon(Icon::new(IconName::Plus))
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_task(window, cx);
                            })),
                    ),
            )
            .child(if self.saved_tasks.is_empty() {
                v_flex()
                    .id("backboard-tasks-starters-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .gap_2()
                    .child(
                        Label::new("Start from a preset")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .children(
                        STARTER_TASKS.iter().copied().map(|starter| {
                            self.render_starter_card(starter, cx).into_any_element()
                        }),
                    )
                    .into_any_element()
            } else {
                v_flex()
                    .id("backboard-tasks-list-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_2()
                    .gap_1()
                    .children(
                        self.saved_tasks
                            .iter()
                            .cloned()
                            .map(|task| self.render_task_row(task, cx).into_any_element()),
                    )
                    .into_any_element()
            })
    }

    fn render_editor_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let can_run = self.has_prompt(cx);
        let can_delete = self.selected_task_id.is_some();

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .h(rems_from_px(56.))
                    .px_4()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                Vector::square(VectorName::ZedLogo, rems_from_px(16.))
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new("Tasks")
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new("Saved agent prompts")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("save-backboard-task", "Save")
                                    .size(ButtonSize::Compact)
                                    .style(ButtonStyle::Subtle)
                                    .disabled(!can_run)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.save_current_task(cx);
                                    })),
                            )
                            .child(
                                Button::new("run-backboard-task", "Run")
                                    .start_icon(Icon::new(IconName::PlayFilled))
                                    .size(ButtonSize::Compact)
                                    .style(ButtonStyle::Tinted(TintColor::Accent))
                                    .disabled(!can_run)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.run_current_task(window, cx);
                                    })),
                            )
                            .child(
                                IconButton::new("delete-backboard-task", IconName::Trash)
                                    .icon_size(IconSize::Small)
                                    .disabled(!can_delete)
                                    .tooltip(Tooltip::text("Delete task"))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.delete_current_task(window, cx);
                                    })),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .id("backboard-task-editor-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .gap_3()
                    .child(
                        v_flex()
                            .max_w(rems_from_px(760.))
                            .gap_1()
                            .child(
                                Label::new("Name")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                div()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .bg(cx.theme().colors().element_background)
                                    .p_2()
                                    .child(self.render_text_editor(&self.title_editor, 0.86, cx)),
                            ),
                    )
                    .child(
                        v_flex()
                            .max_w(rems_from_px(760.))
                            .gap_1()
                            .child(
                                Label::new("Prompt")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                div()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .bg(cx.theme().colors().element_background)
                                    .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
                                    .p_2()
                                    .child(self.render_text_editor(&self.prompt_editor, 0.86, cx)),
                            ),
                    )
                    .when(self.saved_tasks.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .max_w(rems_from_px(760.))
                                .items_center()
                                .gap_2()
                                .pt_8()
                                .child(
                                    Icon::new(IconName::Sparkle)
                                        .size(IconSize::Medium)
                                        .color(Color::Muted),
                                )
                                .child(
                                    Headline::new("Create a reusable task")
                                        .size(HeadlineSize::XSmall)
                                        .color(Color::Accent),
                                )
                                .child(
                                    Label::new("Save prompts you run often, then launch them as Backboard agents.")
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                        )
                    }),
            )
    }
}

impl Render for BackboardTasksPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .size_full()
            .bg(cx.theme().colors().editor_background)
            .child(self.render_left_panel(cx))
            .child(self.render_editor_panel(cx))
    }
}

impl Focusable for BackboardTasksPage {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.prompt_editor.read(cx).focus_handle(cx)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_title(title: String, prompt: &str) -> String {
    let title = title.trim();
    if !title.is_empty() {
        return title.to_string();
    }

    first_line(prompt)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect::<String>()
}

fn first_line(text: &str) -> SharedString {
    text.lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(140)
        .collect::<String>()
        .into()
}

fn decode_tasks(raw: Option<String>) -> Vec<SavedBackboardTask> {
    raw.and_then(|json| serde_json::from_str::<Vec<SavedBackboardTask>>(&json).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_tasks_empty_and_corrupt_json_fail_open() {
        assert!(decode_tasks(None).is_empty());
        assert!(decode_tasks(Some("not json".to_string())).is_empty());
    }

    #[test]
    fn test_decode_tasks_round_trips_saved_task() {
        let task = SavedBackboardTask {
            id: "task-1".to_string(),
            title: "Review".to_string(),
            prompt: "Review the diff".to_string(),
            created_at_ms: 1,
            updated_at_ms: 2,
        };
        let json = serde_json::to_string(&vec![task.clone()]).unwrap();
        assert_eq!(decode_tasks(Some(json)), vec![task]);
    }

    #[test]
    fn test_normalize_title_uses_prompt_fallback() {
        assert_eq!(
            normalize_title("".to_string(), "  Review the auth flow\nthen test it"),
            "Review the auth flow"
        );
        assert_eq!(
            normalize_title("  Custom title  ".to_string(), "Review"),
            "Custom title"
        );
    }
}
