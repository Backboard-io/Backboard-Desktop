use crate::{
    DEFAULT_THREAD_TITLE, SelectPermissionGranularity,
    agent_configuration::{
        ConfigureContextServerModal, configure_context_server_modal::default_markdown_style,
    },
    config_options::ConfigOptionSummary,
    ui::documentation_aside_side,
};
use agent_client_protocol::schema as acp;
use context_server::ContextServerId;
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::message_editor::SharedSessionCapabilities;
use acp_thread::{ContentBlock, PlanEntry};
use cloud_api_types::{SubmitAgentThreadFeedbackBody, SubmitAgentThreadFeedbackCommentsBody};
use editor::actions::OpenExcerpts;
use extension_host::ExtensionStore;

use gpui::TaskExt;
use gpui::{DismissEvent, List, UniformListScrollHandle, uniform_list};
use heapless::Vec as ArrayVec;
use language_model::{LanguageModelEffortLevel, Speed};
use settings::{SidebarSide, update_settings_file};
use ui::{
    ButtonLike, ButtonSize, ElevationIndex, SpinnerLabel, SpinnerVariant, SplitButton,
    SplitButtonStyle, Tab,
};
use workspace::{OpenOptions, OpenVisible, SERIALIZATION_THROTTLE_TIME};

use super::*;

pub(super) type BeforeSendHook = Rc<dyn Fn(&str, &mut Window, &mut App) -> bool>;

fn prefix_content_blocks(
    prompt_prefix: &str,
    mut content: Vec<acp::ContentBlock>,
) -> Vec<acp::ContentBlock> {
    if prompt_prefix.trim().is_empty() {
        return content;
    }

    for block in &mut content {
        if let acp::ContentBlock::Text(text) = block {
            if text.text.trim().is_empty() {
                continue;
            }

            let user_text = std::mem::take(&mut text.text);
            text.text = format!("{prompt_prefix}\n\n{user_text}");
            return content;
        }
    }

    content.insert(
        0,
        acp::ContentBlock::Text(acp::TextContent::new(prompt_prefix.to_string())),
    );
    content
}

fn prompt_title_for_content_blocks(contents: &[acp::ContentBlock]) -> Option<SharedString> {
    let text = contents
        .iter()
        .filter_map(|block| match block {
            acp::ContentBlock::Text(text_content) => Some(text_content.text.clone()),
            acp::ContentBlock::ResourceLink(resource_link) => {
                Some(format!("@{}", resource_link.name))
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let title = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(util::truncate_and_trailoff(title, 200).into())
}

#[derive(Default)]
struct ThreadFeedbackState {
    feedback: Option<ThreadFeedback>,
    comments_editor: Option<Entity<Editor>>,
}

#[derive(Clone, Debug)]
struct ExplorationGroup {
    start: usize,
    end: usize,
    reads: usize,
    searches: usize,
    fetches: usize,
    thoughts: usize,
    active: bool,
}

impl ThreadFeedbackState {
    pub fn submit(
        &mut self,
        thread: Entity<AcpThread>,
        feedback: ThreadFeedback,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(telemetry) = thread.read(cx).connection().telemetry() else {
            return;
        };

        let project = thread.read(cx).project().read(cx);
        let client = project.client();
        let user_store = project.user_store();
        let organization = user_store.read(cx).current_organization();

        if self.feedback == Some(feedback) {
            return;
        }

        self.feedback = Some(feedback);
        match feedback {
            ThreadFeedback::Positive => {
                self.comments_editor = None;
            }
            ThreadFeedback::Negative => {
                self.comments_editor = Some(Self::build_feedback_comments_editor(window, cx));
            }
        }
        let session_id = thread.read(cx).session_id().clone();
        let parent_session_id = thread.read(cx).parent_session_id().cloned();
        let agent_telemetry_id = thread.read(cx).connection().telemetry_id();
        let task = telemetry.thread_data(&session_id, cx);
        let rating = match feedback {
            ThreadFeedback::Positive => "positive",
            ThreadFeedback::Negative => "negative",
        };
        cx.background_spawn(async move {
            let thread = task.await?;

            client
                .cloud_client()
                .submit_agent_feedback(SubmitAgentThreadFeedbackBody {
                    organization_id: organization.map(|organization| organization.id.clone()),
                    agent: agent_telemetry_id.to_string(),
                    session_id: session_id.to_string(),
                    parent_session_id: parent_session_id.map(|id| id.to_string()),
                    rating: rating.to_string(),
                    thread,
                })
                .await?;

            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
    }

    pub fn submit_comments(&mut self, thread: Entity<AcpThread>, cx: &mut App) {
        let Some(telemetry) = thread.read(cx).connection().telemetry() else {
            return;
        };

        let Some(comments) = self
            .comments_editor
            .as_ref()
            .map(|editor| editor.read(cx).text(cx))
            .filter(|text| !text.trim().is_empty())
        else {
            return;
        };

        self.comments_editor.take();

        let project = thread.read(cx).project().read(cx);
        let client = project.client();
        let user_store = project.user_store();
        let organization = user_store.read(cx).current_organization();

        let session_id = thread.read(cx).session_id().clone();
        let agent_telemetry_id = thread.read(cx).connection().telemetry_id();
        let task = telemetry.thread_data(&session_id, cx);
        cx.background_spawn(async move {
            let thread = task.await?;

            client
                .cloud_client()
                .submit_agent_feedback_comments(SubmitAgentThreadFeedbackCommentsBody {
                    organization_id: organization.map(|organization| organization.id.clone()),
                    agent: agent_telemetry_id.to_string(),
                    session_id: session_id.to_string(),
                    comments,
                    thread,
                })
                .await?;

            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
    }

    pub fn clear(&mut self) {
        *self = Self::default()
    }

    pub fn dismiss_comments(&mut self) {
        self.comments_editor.take();
    }

    fn build_feedback_comments_editor(window: &mut Window, cx: &mut App) -> Entity<Editor> {
        let buffer = cx.new(|cx| {
            let empty_string = String::new();
            MultiBuffer::singleton(cx.new(|cx| Buffer::local(empty_string, cx)), cx)
        });

        let editor = cx.new(|cx| {
            let mut editor = Editor::new(
                editor::EditorMode::AutoHeight {
                    min_lines: 1,
                    max_lines: Some(4),
                },
                buffer,
                None,
                window,
                cx,
            );
            editor.set_placeholder_text(
                "What went wrong? Share your feedback so we can improve.",
                window,
                cx,
            );
            editor
        });

        editor.read(cx).focus_handle(cx).focus(window, cx);
        editor
    }
}

struct GeneratingSpinner {
    variant: SpinnerVariant,
}

impl GeneratingSpinner {
    fn new(variant: SpinnerVariant) -> Self {
        Self { variant }
    }
}

impl Render for GeneratingSpinner {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        SpinnerLabel::with_variant(self.variant).size(LabelSize::Small)
    }
}

#[derive(IntoElement)]
struct GeneratingSpinnerElement {
    variant: SpinnerVariant,
}

impl GeneratingSpinnerElement {
    fn new(variant: SpinnerVariant) -> Self {
        Self { variant }
    }
}

impl RenderOnce for GeneratingSpinnerElement {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = match self.variant {
            SpinnerVariant::Dots => "generating-spinner-view",
            SpinnerVariant::Sand => "confirmation-spinner-view",
            _ => "spinner-view",
        };
        window.with_id(id, |window| {
            window.use_state(cx, |_, _| GeneratingSpinner::new(self.variant))
        })
    }
}

struct AgentOptionsMenu {
    focus_handle: FocusHandle,
    config_options_view: Entity<ConfigOptionsView>,
    workspace: WeakEntity<Workspace>,
    scroll_handle: ScrollHandle,
    skills_scroll_handle: UniformListScrollHandle,
    expanded_skill_categories: HashSet<String>,
    mode: AgentOptionsMenuMode,
}

#[derive(Clone, Copy)]
enum AgentOptionsMenuMode {
    All,
    Skills,
}

#[derive(Clone)]
enum SkillListRow {
    SectionLabel(SharedString),
    CreateSkill,
    Empty(&'static str),
    CategoryHeader {
        category: String,
        option_count: usize,
        collapsed: bool,
    },
    Option(ConfigOptionSummary),
}

struct RecommendedMcpServerStatus {
    extension_id: &'static str,
    label: &'static str,
    installed: bool,
    server_ids: Vec<Arc<str>>,
}

fn recommended_mcp_install_status(cx: &App) -> (usize, usize) {
    let extension_ids = crate::recommended_mcp_extension_ids();
    let total_count = extension_ids.len();
    let installed_count = ExtensionStore::try_global(cx)
        .map(|extension_store| {
            let extension_store = extension_store.read(cx);
            extension_ids
                .iter()
                .filter(|extension_id| {
                    extension_store
                        .installed_extensions()
                        .contains_key(extension_id.as_ref())
                })
                .count()
        })
        .unwrap_or(0);

    (installed_count, total_count)
}

fn recommended_mcp_server_statuses(cx: &App) -> Vec<RecommendedMcpServerStatus> {
    const RECOMMENDED_MCP_SERVERS: &[(&str, &str)] = &[
        ("mcp-server-github", "GitHub"),
        ("mcp-server-slack", "Slack"),
        ("mcp-server-supabase", "Supabase"),
        ("mcp-server-figma", "Figma"),
        ("mcp-server-shopify-dev", "Shopify"),
    ];

    let extension_store = ExtensionStore::try_global(cx);
    RECOMMENDED_MCP_SERVERS
        .iter()
        .map(|(extension_id, label)| {
            let server_ids = extension_store
                .as_ref()
                .and_then(|extension_store| {
                    extension_store
                        .read(cx)
                        .installed_extensions()
                        .get(*extension_id)
                        .map(|entry| {
                            entry
                                .manifest
                                .context_servers
                                .keys()
                                .cloned()
                                .collect::<Vec<_>>()
                        })
                })
                .unwrap_or_default();

            RecommendedMcpServerStatus {
                extension_id,
                label,
                installed: !server_ids.is_empty(),
                server_ids,
            }
        })
        .collect()
}

impl AgentOptionsMenu {
    fn new(
        config_options_view: Entity<ConfigOptionsView>,
        workspace: WeakEntity<Workspace>,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            config_options_view,
            workspace,
            scroll_handle: ScrollHandle::new(),
            skills_scroll_handle: UniformListScrollHandle::new(),
            expanded_skill_categories: HashSet::default(),
            mode: AgentOptionsMenuMode::All,
        }
    }

    fn skills(
        config_options_view: Entity<ConfigOptionsView>,
        workspace: WeakEntity<Workspace>,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            config_options_view,
            workspace,
            scroll_handle: ScrollHandle::new(),
            skills_scroll_handle: UniformListScrollHandle::new(),
            expanded_skill_categories: HashSet::default(),
            mode: AgentOptionsMenuMode::Skills,
        }
    }
}

impl Focusable for AgentOptionsMenu {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EventEmitter<DismissEvent> for AgentOptionsMenu {}

impl Render for AgentOptionsMenu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let option_summaries = self.config_options_view.read(cx).option_summaries();
        let (title, icon, footer, options_list) = match self.mode {
            AgentOptionsMenuMode::All => {
                let session_options = option_summaries
                    .into_iter()
                    .filter(|option| {
                        let option_id = option.id.to_string();
                        !option_id.starts_with("backboard_skill:")
                            && !option_id.starts_with("backboard_mcp_")
                            && option_id != "backboard_voice_mode"
                            && option_id != "backboard_live_voice"
                    })
                    .collect::<Vec<_>>();

                let mut list = v_flex().gap_1();

                if session_options.is_empty() {
                    list = list.child(self.render_empty_options("No session options available."));
                } else {
                    list = list.child(self.render_option_group(session_options, cx));
                }

                let options_list = list.into_any_element();
                (
                    "Agent Options",
                    IconName::Sliders,
                    "Click an option to change it.",
                    options_list,
                )
            }
            AgentOptionsMenuMode::Skills => {
                let skill_options = option_summaries
                    .into_iter()
                    .filter(|option| option.id.to_string().starts_with("backboard_skill:"))
                    .collect::<Vec<_>>();
                let options_list = self.render_skills_list(skill_options, cx);
                (
                    "Skills",
                    IconName::Box,
                    "Click a skill to toggle it.",
                    options_list,
                )
            }
        };

        let is_skills_menu = matches!(self.mode, AgentOptionsMenuMode::Skills);
        let options_container = if is_skills_menu {
            div()
                .id("agent-options-menu-options")
                .max_h_96()
                .overflow_y_hidden()
                .child(options_list)
                .vertical_scrollbar_for(&self.skills_scroll_handle, window, cx)
                .into_any_element()
        } else {
            div()
                .id("agent-options-menu-options")
                .max_h(px(280.))
                .overflow_y_scroll()
                .child(options_list)
                .vertical_scrollbar_for(&self.scroll_handle, window, cx)
                .into_any_element()
        };
        let (menu_min_width, menu_max_width) = if is_skills_menu {
            (px(300.), px(340.))
        } else {
            (px(244.), px(280.))
        };
        let colors = cx.theme().colors();

        div()
            .key_context("AgentOptionsMenu")
            .track_focus(&self.focus_handle)
            .p_1()
            .min_w(menu_min_width)
            .max_w(menu_max_width)
            .rounded_md()
            .border_1()
            .border_color(colors.border_variant.opacity(0.64))
            .bg(colors.elevated_surface_background)
            .elevation_2(cx)
            .child(
                v_flex()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .px_1()
                            .py_0p5()
                            .child(
                                Label::new(title)
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            )
                            .child(Icon::new(icon).size(IconSize::XSmall).color(Color::Muted)),
                    )
                    .child(
                        div()
                            .h(px(1.))
                            .w_full()
                            .bg(colors.border_variant.opacity(0.48)),
                    )
                    .child(options_container)
                    .child(
                        Label::new(footer)
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .mx_1()
                            .mt_0p5()
                            .mb_0p5(),
                    ),
            )
    }
}

impl AgentOptionsMenu {
    fn render_skills_list(
        &mut self,
        skill_options: Vec<ConfigOptionSummary>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut grouped_options = BTreeMap::new();
        for option in skill_options {
            grouped_options
                .entry(Self::skill_category_label(&option.id))
                .or_insert_with(Vec::new)
                .push(option);
        }

        let mut rows = vec![
            SkillListRow::SectionLabel(SharedString::from("Create")),
            SkillListRow::CreateSkill,
        ];

        if grouped_options.is_empty() {
            rows.push(SkillListRow::Empty("No skills available."));
        } else {
            for (category, options) in grouped_options {
                let collapsed = !self.expanded_skill_categories.contains(&category);
                let option_count = options.len();
                rows.push(SkillListRow::CategoryHeader {
                    category: category.clone(),
                    option_count,
                    collapsed,
                });
                if !collapsed {
                    rows.extend(options.into_iter().map(SkillListRow::Option));
                }
            }
        }

        let row_count = rows.len();
        let rows = Rc::new(rows);

        uniform_list(
            "agent-options-skills-list",
            row_count,
            cx.processor(
                move |this, visible_range: std::ops::Range<usize>, _window, cx| {
                    visible_range
                        .filter_map(|index| rows.get(index).cloned())
                        .map(|row| this.render_skill_list_row(row, cx))
                        .collect()
                },
            ),
        )
        .w_full()
        .max_h_96()
        .with_sizing_behavior(gpui::ListSizingBehavior::Infer)
        .track_scroll(&self.skills_scroll_handle)
        .into_any_element()
    }

    fn bundled_skills_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("assets")
            .join("skills")
    }

    fn skill_preview_path(option_id: &acp::SessionConfigId) -> Option<PathBuf> {
        option_id
            .0
            .strip_prefix("backboard_skill:")
            .map(|relative_path| {
                Self::bundled_skills_root()
                    .join(relative_path)
                    .join("preview.png")
            })
    }

    fn custom_skill_dir(option_id: &acp::SessionConfigId) -> Option<PathBuf> {
        let relative_path = option_id.0.strip_prefix("backboard_skill:custom/")?;
        let relative_path = Path::new(relative_path);
        if relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            return None;
        }

        Some(
            Self::bundled_skills_root()
                .join("custom")
                .join(relative_path),
        )
    }

    fn skill_category_label(option_id: &acp::SessionConfigId) -> String {
        option_id
            .0
            .strip_prefix("backboard_skill:")
            .and_then(|relative_path| relative_path.split('/').next())
            .filter(|category| !category.is_empty())
            .map(Self::display_name_from_slug)
            .unwrap_or_else(|| "Other".to_string())
    }

    fn display_name_from_slug(value: &str) -> String {
        value
            .split(|character: char| character == '-' || character == '_')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                let Some(first) = chars.next() else {
                    return String::new();
                };
                let mut titleized = first.to_uppercase().collect::<String>();
                titleized.push_str(chars.as_str());
                titleized
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn next_new_skill_path() -> Option<(PathBuf, String)> {
        let custom_root = Self::bundled_skills_root().join("custom");
        for index in 1..1000 {
            let slug = if index == 1 {
                "new-skill".to_string()
            } else {
                format!("new-skill-{index}")
            };
            let path = custom_root.join(&slug).join("SKILL.md");
            if !path.exists() {
                return Some((path, slug));
            }
        }
        None
    }

    fn new_skill_template(slug: &str) -> String {
        format!(
            "---\nname: {slug}\ndescription: Describe when to use this skill.\n---\n\n# {}\n\nWrite the instructions this skill should add to Backboard when enabled.\n",
            Self::display_name_from_slug(slug)
        )
    }

    fn create_new_skill(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((skill_path, slug)) = Self::next_new_skill_path() else {
            log::error!("Could not allocate a new Backboard skill path");
            return;
        };

        let Some(parent_dir) = skill_path.parent() else {
            log::error!(
                "New Backboard skill path has no parent: {}",
                skill_path.display()
            );
            return;
        };

        if let Err(error) = std::fs::create_dir_all(parent_dir) {
            log::error!(
                "Failed to create Backboard skill directory {}: {error:#}",
                parent_dir.display()
            );
            return;
        }

        if let Err(error) = std::fs::write(&skill_path, Self::new_skill_template(&slug)) {
            log::error!(
                "Failed to write Backboard skill file {}: {error:#}",
                skill_path.display()
            );
            return;
        }

        self.config_options_view
            .update(cx, |view, cx| view.refresh_options(window, cx));

        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                let open_task = workspace.open_abs_path(
                    skill_path.clone(),
                    OpenOptions {
                        visible: Some(OpenVisible::OnlyFiles),
                        ..Default::default()
                    },
                    window,
                    cx,
                );
                cx.spawn(async move |_, _| {
                    if let Err(error) = open_task.await {
                        log::error!("Failed to open Backboard skill file: {error:#}");
                    }
                })
                .detach();
            });
        }

        cx.notify();
    }

    fn delete_custom_skill(
        &self,
        option_id: acp::SessionConfigId,
        skill_dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.config_options_view.update(cx, |view, cx| {
            view.set_option_value(option_id, acp::SessionConfigValueId::new("off"), cx);
        });

        if let Err(error) = std::fs::remove_dir_all(&skill_dir) {
            log::error!(
                "Failed to delete Backboard skill directory {}: {error:#}",
                skill_dir.display()
            );
        }

        self.config_options_view
            .update(cx, |view, cx| view.refresh_options(window, cx));
        cx.notify();
    }

    fn toggle_skill_category(&mut self, category: String, cx: &mut Context<Self>) {
        if !self.expanded_skill_categories.insert(category.clone()) {
            self.expanded_skill_categories.remove(&category);
        }
        cx.notify();
    }

    fn render_empty_options(&self, label: &'static str) -> AnyElement {
        div()
            .px_2()
            .py_1()
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
            .into_any_element()
    }

    fn render_create_skill_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        ButtonLike::new("agent-option-create-skill")
            .full_width()
            .height(px(32.).into())
            .style(ButtonStyle::Subtle)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_2()
                            .items_center()
                            .child(
                                Icon::new(IconName::Plus)
                                    .size(IconSize::XSmall)
                                    .color(Color::Muted),
                            )
                            .child(
                                Label::new("New Skill")
                                    .size(LabelSize::Small)
                                    .color(Color::Default)
                                    .truncate(),
                            ),
                    )
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .tooltip(Tooltip::text("Create a filesystem skill"))
            .on_click(cx.listener(|this, _, window, cx| {
                this.create_new_skill(window, cx);
            }))
    }

    fn render_skill_list_row(&self, row: SkillListRow, cx: &mut Context<Self>) -> AnyElement {
        match row {
            SkillListRow::SectionLabel(label) => self.render_skill_section_label(label, cx),
            SkillListRow::CreateSkill => self.render_create_skill_row(cx).into_any_element(),
            SkillListRow::Empty(label) => self.render_skill_empty_row(label),
            SkillListRow::CategoryHeader {
                category,
                option_count,
                collapsed,
            } => self.render_skill_category_header(category, option_count, collapsed, cx),
            SkillListRow::Option(option) => self.render_option_row(option, cx).into_any_element(),
        }
    }

    fn render_skill_section_label(
        &self,
        label: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let colors = cx.theme().colors();
        v_flex()
            .h(px(32.))
            .w_full()
            .justify_end()
            .gap_1()
            .child(
                div()
                    .h(px(1.))
                    .w_full()
                    .bg(colors.border_variant.opacity(0.32)),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .mx_1()
                    .mb_0p5(),
            )
            .into_any_element()
    }

    fn render_skill_empty_row(&self, label: &'static str) -> AnyElement {
        div()
            .h(px(32.))
            .w_full()
            .px_2()
            .flex()
            .items_center()
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
            .into_any_element()
    }

    fn render_skill_category_header(
        &self,
        category: String,
        option_count: usize,
        collapsed: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let colors = cx.theme().colors();
        let category_for_click = category.clone();
        div()
            .h(px(32.))
            .w_full()
            .border_t_1()
            .border_color(colors.border_variant.opacity(0.32))
            .child(
                ButtonLike::new(format!("skill-category-{category}"))
                    .full_width()
                    .height(px(31.).into())
                    .style(ButtonStyle::Subtle)
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1()
                                    .items_center()
                                    .child(
                                        Icon::new(if collapsed {
                                            IconName::ChevronRight
                                        } else {
                                            IconName::ChevronDown
                                        })
                                        .size(IconSize::XSmall)
                                        .color(Color::Muted),
                                    )
                                    .child(
                                        Label::new(category)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted)
                                            .truncate(),
                                    ),
                            )
                            .child(
                                Label::new(option_count.to_string())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.toggle_skill_category(category_for_click.clone(), cx);
                    })),
            )
            .into_any_element()
    }

    fn render_section_label(
        &self,
        label: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = label.into();
        let colors = cx.theme().colors();
        v_flex()
            .gap_0p5()
            .pt_0p5()
            .child(
                div()
                    .h(px(1.))
                    .w_full()
                    .bg(colors.border_variant.opacity(0.32)),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .mx_1(),
            )
            .into_any_element()
    }

    fn render_option_group(
        &self,
        options: Vec<ConfigOptionSummary>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        v_flex()
            .children(
                options
                    .into_iter()
                    .map(|option| self.render_option_row(option, cx).into_any_element()),
            )
            .into_any_element()
    }

    fn render_option_row(
        &self,
        option: ConfigOptionSummary,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let option_id = option.id.clone();
        let description = option.description.clone();
        let preview_path = matches!(self.mode, AgentOptionsMenuMode::Skills)
            .then(|| Self::skill_preview_path(&option.id))
            .flatten();
        let custom_skill_dir = matches!(self.mode, AgentOptionsMenuMode::Skills)
            .then(|| Self::custom_skill_dir(&option.id))
            .flatten();
        let (row_height, label_size) = if matches!(self.mode, AgentOptionsMenuMode::Skills) {
            (px(32.), LabelSize::Small)
        } else {
            (px(26.), LabelSize::XSmall)
        };
        let option_id_for_delete = option.id.clone();
        let delete_button_id = format!("delete-custom-skill-{}", option_id_for_delete.0);

        ButtonLike::new(ElementId::Name(
            format!("agent-option-{}", option.id.0).into(),
        ))
        .full_width()
        .height(row_height.into())
        .style(ButtonStyle::Subtle)
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div().min_w_0().flex_1().child(
                        Label::new(option.name)
                            .size(label_size)
                            .color(Color::Default)
                            .truncate(),
                    ),
                )
                .child(
                    h_flex()
                        .flex_none()
                        .items_center()
                        .gap_1()
                        .child(
                            Label::new(option.current_value_name)
                                .size(LabelSize::XSmall)
                                .color(Color::Muted)
                                .truncate(),
                        )
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .size(IconSize::XSmall)
                                .color(Color::Muted),
                        )
                        .when_some(custom_skill_dir, |this, skill_dir| {
                            this.child(
                                IconButton::new(delete_button_id, IconName::Trash)
                                    .icon_size(IconSize::XSmall)
                                    .icon_color(Color::Muted)
                                    .tooltip(Tooltip::text("Delete custom skill"))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.delete_custom_skill(
                                            option_id_for_delete.clone(),
                                            skill_dir.clone(),
                                            window,
                                            cx,
                                        );
                                        cx.stop_propagation();
                                    })),
                            )
                        }),
                ),
        )
        .tooltip(Tooltip::element(move |_window, _cx| {
            let mut content = v_flex().gap_1();
            if let Some(preview_path) = preview_path.as_ref()
                && preview_path.is_file()
            {
                content = content.child(
                    div()
                        .w(px(280.))
                        .h(px(160.))
                        .rounded_sm()
                        .overflow_hidden()
                        .border_1()
                        .border_color(_cx.theme().colors().border_variant)
                        .child(
                            img(preview_path.clone())
                                .size_full()
                                .object_fit(ObjectFit::ScaleDown),
                        ),
                );
            }
            if let Some(description) = description.clone() {
                content = content.child(
                    Label::new(description)
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                );
            }
            content.into_any()
        }))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.config_options_view.update(cx, |view, cx| {
                view.cycle_option(&option_id, cx);
            });
        }))
    }
}

pub enum AcpThreadViewEvent {
    Interacted,
}

impl EventEmitter<AcpThreadViewEvent> for ThreadView {}

#[cfg(feature = "audio")]
#[derive(Default)]
enum DictationState {
    #[default]
    Idle,
    Recording {
        stop_tx: async_channel::Sender<()>,
    },
    Transcribing,
}

#[cfg(feature = "audio")]
fn record_dictation_wav(stop_rx: async_channel::Receiver<()>) -> anyhow::Result<Vec<u8>> {
    use anyhow::{Context as _, anyhow};
    use rodio::Source as _;

    let mut microphone = audio::open_input_stream(None).context("opening microphone")?;
    let channels = microphone.channels().get();
    let sample_rate = microphone.sample_rate().get();
    let max_samples = sample_rate as usize * channels as usize * 300;
    let min_samples = sample_rate as usize / 4;
    let mut samples = Vec::new();

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        if samples.len() >= max_samples {
            break;
        }
        let Some(sample) = microphone.next() else {
            break;
        };
        samples.push(sample.clamp(-1.0, 1.0));
    }

    if samples.len() < min_samples {
        return Err(anyhow!("recording was too short"));
    }

    Ok(encode_wav_pcm16(&samples, channels, sample_rate))
}

#[cfg(feature = "audio")]
fn encode_wav_pcm16(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() as u32 * 2;
    let mut wav = Vec::with_capacity(44 + data_len as usize);

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * channels as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&(channels * 2).to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());

    for sample in samples {
        let sample = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }

    wav
}

#[cfg(feature = "audio")]
async fn transcribe_backboard_dictation(wav: Vec<u8>) -> anyhow::Result<String> {
    use agent_servers::backboard::{
        AudioAttachment, BackboardClient, BackboardConfig, CreateAssistantRequest,
        SendMessageRequest,
    };
    use anyhow::{Context as _, anyhow};
    use serde_json::json;

    let config = BackboardConfig::load().context("loading Backboard config")?;
    let client =
        BackboardClient::from_config(config.clone()).context("creating Backboard client")?;

    let thread_id = if let Some(thread_id) = config.thread_id.clone() {
        thread_id
    } else {
        let assistant_id = if let Some(assistant_id) = config.assistant_id.clone() {
            assistant_id
        } else {
            let assistant = client
                .create_assistant(CreateAssistantRequest {
                    name: "Backboard Dictation".to_string(),
                    description:
                        "Transcribes short microphone dictation clips for the Backboard IDE."
                            .to_string(),
                    tools: None,
                    custom_fact_extraction_prompt: None,
                    custom_update_memory_prompt: None,
                })
                .await?;
            json_string(&assistant, &["assistant_id", "id"])
                .context("Backboard create assistant response did not include assistant_id")?
        };

        let thread = client.create_thread(&assistant_id).await?;
        json_string(&thread, &["thread_id", "id"])
            .context("Backboard create thread response did not include thread_id")?
    };

    let response = client
        .send_message(
            &thread_id,
            SendMessageRequest {
                content: "Transcribe this dictation audio. Return only the transcript text."
                    .to_string(),
                voice: Some(json!({
                    "stt": {
                        "provider": "openai",
                        "model": "gpt-4o-mini-transcribe",
                        "language": "en",
                    }
                })),
                send_to_llm: Some(false),
                audio_file: Some(AudioAttachment {
                    data: wav,
                    file_name: "backboard-dictation.wav".to_string(),
                    mime_type: "audio/wav".to_string(),
                }),
                ..SendMessageRequest::default()
            },
        )
        .await?;

    transcript_from_response(&response)
        .map(|transcript| transcript.trim().to_string())
        .filter(|transcript| !transcript.is_empty())
        .ok_or_else(|| anyhow!("Backboard did not return a transcript"))
}

#[cfg(feature = "audio")]
fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

#[cfg(feature = "audio")]
fn transcript_from_response(value: &serde_json::Value) -> Option<String> {
    use serde_json::Value;

    fn direct_string(value: &Value) -> Option<String> {
        [
            &["voice_records", "stt", "transcript"][..],
            &["voice_records", "stt", "text"][..],
            &["stt", "transcript"][..],
            &["stt", "text"][..],
            &["transcript"][..],
            &["text"][..],
            &["content"][..],
            &["message", "content"][..],
        ]
        .into_iter()
        .find_map(|path| {
            path.iter()
                .try_fold(value, |value, key| value.get(*key))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    }

    if let Some(text) = direct_string(value) {
        return Some(text);
    }

    match value {
        Value::Array(items) => items.iter().find_map(transcript_from_response),
        Value::Object(object) => [
            "message", "content", "result", "response", "data", "choices",
        ]
        .into_iter()
        .filter_map(|key| object.get(key))
        .find_map(transcript_from_response),
        _ => None,
    }
}

/// Tracks the user's permission dropdown selection state for a specific tool call.
///
/// Default (no entry in the map) means the last dropdown choice is selected,
/// which is typically "Only this time".
#[derive(Clone)]
pub(crate) enum PermissionSelection {
    /// A specific choice from the dropdown (e.g., "Always for terminal", "Only this time").
    /// The index corresponds to the position in the `choices` list from `PermissionOptions`.
    Choice(usize),
    /// "Select options…" mode where individual command patterns can be toggled.
    /// Contains the indices of checked patterns in the `patterns` list.
    /// All patterns start checked when this mode is first activated.
    SelectedPatterns(Vec<usize>),
}

impl PermissionSelection {
    /// Returns the choice index if a specific dropdown choice is selected,
    /// or `None` if in per-command pattern mode.
    pub(crate) fn choice_index(&self) -> Option<usize> {
        match self {
            Self::Choice(index) => Some(*index),
            Self::SelectedPatterns(_) => None,
        }
    }

    fn is_pattern_checked(&self, index: usize) -> bool {
        match self {
            Self::SelectedPatterns(checked) => checked.contains(&index),
            _ => false,
        }
    }

    fn has_any_checked_patterns(&self) -> bool {
        match self {
            Self::SelectedPatterns(checked) => !checked.is_empty(),
            _ => false,
        }
    }

    fn toggle_pattern(&mut self, index: usize) {
        if let Self::SelectedPatterns(checked) = self {
            if let Some(pos) = checked.iter().position(|&i| i == index) {
                checked.swap_remove(pos);
            } else {
                checked.push(index);
            }
        }
    }
}

pub struct ThreadView {
    pub session_id: acp::SessionId,
    pub parent_session_id: Option<acp::SessionId>,
    pub thread: Entity<AcpThread>,
    pub(crate) conversation: Entity<super::Conversation>,
    pub server_view: WeakEntity<ConversationView>,
    pub agent_icon: IconName,
    pub agent_icon_from_external_svg: Option<SharedString>,
    pub agent_id: AgentId,
    pub agent_display_name: SharedString,
    pub focus_handle: FocusHandle,
    pub workspace: WeakEntity<Workspace>,
    pub entry_view_state: Entity<EntryViewState>,
    pub title_editor: Entity<Editor>,
    pub config_options_view: Option<Entity<ConfigOptionsView>>,
    pub mode_selector: Option<Entity<ModeSelector>>,
    pub model_selector: Option<Entity<ModelSelectorPopover>>,
    pub profile_selector: Option<Entity<ProfileSelector>>,
    pub permission_dropdown_handle: PopoverMenuHandle<ContextMenu>,
    pub thread_retry_status: Option<RetryStatus>,
    pub(super) thread_error: Option<ThreadError>,
    pub thread_error_markdown: Option<Entity<Markdown>>,
    pub token_limit_callout_dismissed: bool,
    pub last_token_limit_telemetry: Option<acp_thread::TokenUsageRatio>,
    thread_feedback: ThreadFeedbackState,
    pub list_state: ListState,
    pub session_capabilities: SharedSessionCapabilities,
    /// Tracks which tool calls have their content/output expanded.
    /// Used for showing/hiding tool call results, terminal output, etc.
    pub expanded_tool_calls: HashSet<acp::ToolCallId>,
    command_details_expanded: HashSet<acp::ToolCallId>,
    expanded_assistant_turns: HashSet<usize>,
    collapsed_assistant_turns: HashSet<usize>,
    assistant_turn_durations: HashMap<usize, Duration>,
    pub expanded_tool_call_raw_inputs: HashSet<acp::ToolCallId>,
    pub expanded_thinking_blocks: HashSet<(usize, usize)>,
    auto_expanded_thinking_block: Option<(usize, usize)>,
    user_toggled_thinking_blocks: HashSet<(usize, usize)>,
    pub subagent_scroll_handles: RefCell<HashMap<acp::SessionId, ScrollHandle>>,
    pub edits_expanded: bool,
    pub plan_expanded: bool,
    pub queue_expanded: bool,
    pub editor_expanded: bool,
    pub should_be_following: bool,
    pub editing_message: Option<usize>,
    pub local_queued_messages: Vec<QueuedMessage>,
    pub queued_message_editors: Vec<Entity<MessageEditor>>,
    pub queued_message_editor_subscriptions: Vec<Subscription>,
    pub last_synced_queue_length: usize,
    pub turn_fields: TurnFields,
    pub discarded_partial_edits: HashSet<acp::ToolCallId>,
    pub is_loading_contents: bool,
    pub new_server_version_available: Option<SharedString>,
    pub resumed_without_history: bool,
    pub(crate) permission_selections: HashMap<acp::ToolCallId, PermissionSelection>,
    pub _cancel_task: Option<Task<()>>,
    _save_task: Option<Task<()>>,
    _draft_resolve_task: Option<Task<()>>,
    pub skip_queue_processing_count: usize,
    pub user_interrupted_generation: bool,
    pub can_fast_track_queue: bool,
    pub hovered_edited_file_buttons: Option<usize>,
    pub in_flight_prompt: Option<Vec<acp::ContentBlock>>,
    pub _subscriptions: Vec<Subscription>,
    pub message_editor: Entity<MessageEditor>,
    prompt_prefix: Option<SharedString>,
    before_send_hook: Option<BeforeSendHook>,
    #[cfg(feature = "audio")]
    dictation_state: DictationState,
    pub add_context_menu_handle: PopoverMenuHandle<ContextMenu>,
    agent_options_menu_handle: PopoverMenuHandle<ContextMenu>,
    skills_options_menu_handle: PopoverMenuHandle<ContextMenu>,
    pub thinking_effort_menu_handle: PopoverMenuHandle<ContextMenu>,
    pub project: WeakEntity<Project>,
    pub show_external_source_prompt_warning: bool,
    pub show_codex_windows_warning: bool,
    pub multi_root_callout_dismissed: bool,
    pub generating_indicator_in_list: bool,
}
impl Focusable for ThreadView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if self.parent_session_id.is_some() {
            self.focus_handle.clone()
        } else {
            self.active_editor(cx).focus_handle(cx)
        }
    }
}

#[derive(Default)]
pub struct TurnFields {
    pub _turn_timer_task: Option<Task<()>>,
    pub last_turn_duration: Option<Duration>,
    pub last_turn_tokens: Option<u64>,
    pub turn_generation: usize,
    pub turn_started_at: Option<Instant>,
    pub turn_tokens: Option<u64>,
}

impl ThreadView {
    pub(crate) fn new(
        thread: Entity<AcpThread>,
        conversation: Entity<super::Conversation>,
        server_view: WeakEntity<ConversationView>,
        agent_icon: IconName,
        agent_icon_from_external_svg: Option<SharedString>,
        agent_id: AgentId,
        agent_display_name: SharedString,
        workspace: WeakEntity<Workspace>,
        entry_view_state: Entity<EntryViewState>,
        config_options_view: Option<Entity<ConfigOptionsView>>,
        mode_selector: Option<Entity<ModeSelector>>,
        model_selector: Option<Entity<ModelSelectorPopover>>,
        profile_selector: Option<Entity<ProfileSelector>>,
        list_state: ListState,
        session_capabilities: SharedSessionCapabilities,
        resumed_without_history: bool,
        project: WeakEntity<Project>,
        thread_store: Option<Entity<ThreadStore>>,
        prompt_store: Option<Entity<PromptStore>>,
        initial_content: Option<AgentInitialContent>,
        mut subscriptions: Vec<Subscription>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let session_id = thread.read(cx).session_id().clone();
        let parent_session_id = thread.read(cx).parent_session_id().cloned();

        let has_commands = !session_capabilities.read().available_commands().is_empty();
        let placeholder = placeholder_text(agent_display_name.as_ref(), has_commands);

        let mut should_auto_submit = false;
        let mut show_external_source_prompt_warning = false;

        let message_editor = cx.new(|cx| {
            let mut editor = MessageEditor::new(
                workspace.clone(),
                project.clone(),
                thread_store,
                prompt_store,
                session_capabilities.clone(),
                agent_id.clone(),
                &placeholder,
                editor::EditorMode::AutoHeight {
                    min_lines: AgentSettings::get_global(cx).message_editor_min_lines,
                    max_lines: Some(AgentSettings::get_global(cx).set_message_editor_max_lines()),
                },
                window,
                cx,
            );
            if let Some(content) = initial_content {
                match content {
                    AgentInitialContent::ThreadSummary { session_id, title } => {
                        editor.insert_thread_summary(session_id, title, window, cx);
                    }
                    AgentInitialContent::ContentBlock {
                        blocks,
                        auto_submit,
                    } => {
                        should_auto_submit = auto_submit;
                        editor.set_message(blocks, window, cx);
                    }
                    AgentInitialContent::FromExternalSource(prompt) => {
                        show_external_source_prompt_warning = true;
                        // SECURITY: Be explicit about not auto submitting prompt from external source.
                        should_auto_submit = false;
                        editor.set_message(
                            vec![acp::ContentBlock::Text(acp::TextContent::new(
                                prompt.into_string(),
                            ))],
                            window,
                            cx,
                        );
                    }
                }
            } else if let Some(draft) = thread.read(cx).draft_prompt() {
                editor.set_message(draft.to_vec(), window, cx);
            }
            editor
        });

        let show_codex_windows_warning = cfg!(windows)
            && project.upgrade().is_some_and(|p| p.read(cx).is_local())
            && agent_id.as_ref() == "Codex";

        let title_editor = {
            let can_edit = thread.update(cx, |thread, cx| thread.can_set_title(cx));
            let editor = cx.new(|cx| {
                let mut editor = Editor::single_line(window, cx);
                if let Some(title) = thread.read(cx).title() {
                    editor.set_text(title, window, cx);
                } else {
                    editor.set_text(DEFAULT_THREAD_TITLE, window, cx);
                }
                editor.set_read_only(!can_edit);
                editor
            });
            subscriptions.push(cx.subscribe_in(&editor, window, Self::handle_title_editor_event));
            editor
        };

        subscriptions.push(cx.subscribe_in(
            &entry_view_state,
            window,
            Self::handle_entry_view_event,
        ));

        subscriptions.push(cx.subscribe_in(
            &message_editor,
            window,
            Self::handle_message_editor_event,
        ));

        subscriptions.push(cx.observe(&message_editor, |this, editor, cx| {
            let is_empty = editor.read(cx).text(cx).is_empty();
            let draft_contents_task = if is_empty {
                None
            } else {
                Some(editor.update(cx, |editor, cx| editor.draft_contents(cx)))
            };
            this._draft_resolve_task = Some(cx.spawn(async move |this, cx| {
                let draft = if let Some(task) = draft_contents_task {
                    let blocks = task.await.ok().filter(|b| !b.is_empty());
                    blocks
                } else {
                    None
                };
                this.update(cx, |this, cx| {
                    this.thread.update(cx, |thread, cx| {
                        thread.set_draft_prompt(draft, cx);
                    });
                    this.schedule_save(cx);
                })
                .ok();
            }));
        }));

        if let Some(config_options_view) = config_options_view.as_ref() {
            subscriptions.push(cx.observe(config_options_view, |_, _, cx| {
                cx.notify();
            }));
        }

        let mut this = Self {
            session_id,
            parent_session_id,
            focus_handle: cx.focus_handle(),
            thread,
            conversation,
            server_view,
            agent_icon,
            agent_icon_from_external_svg,
            agent_id,
            agent_display_name,
            workspace,
            entry_view_state,
            title_editor,
            config_options_view,
            mode_selector,
            model_selector,
            profile_selector,
            list_state,
            session_capabilities,
            resumed_without_history,
            _subscriptions: subscriptions,
            permission_dropdown_handle: PopoverMenuHandle::default(),
            thread_retry_status: None,
            thread_error: None,
            thread_error_markdown: None,
            token_limit_callout_dismissed: false,
            last_token_limit_telemetry: None,
            thread_feedback: Default::default(),
            expanded_tool_calls: HashSet::default(),
            command_details_expanded: HashSet::default(),
            expanded_assistant_turns: HashSet::default(),
            collapsed_assistant_turns: HashSet::default(),
            assistant_turn_durations: HashMap::default(),
            expanded_tool_call_raw_inputs: HashSet::default(),
            expanded_thinking_blocks: HashSet::default(),
            auto_expanded_thinking_block: None,
            user_toggled_thinking_blocks: HashSet::default(),
            subagent_scroll_handles: RefCell::new(HashMap::default()),
            edits_expanded: false,
            plan_expanded: false,
            queue_expanded: true,
            editor_expanded: false,
            should_be_following: false,
            editing_message: None,
            local_queued_messages: Vec::new(),
            queued_message_editors: Vec::new(),
            queued_message_editor_subscriptions: Vec::new(),
            last_synced_queue_length: 0,
            turn_fields: TurnFields::default(),
            discarded_partial_edits: HashSet::default(),
            is_loading_contents: false,
            new_server_version_available: None,
            permission_selections: HashMap::default(),
            _cancel_task: None,
            _save_task: None,
            _draft_resolve_task: None,
            skip_queue_processing_count: 0,
            user_interrupted_generation: false,
            can_fast_track_queue: false,
            hovered_edited_file_buttons: None,
            in_flight_prompt: None,
            message_editor,
            prompt_prefix: None,
            before_send_hook: None,
            #[cfg(feature = "audio")]
            dictation_state: DictationState::default(),
            add_context_menu_handle: PopoverMenuHandle::default(),
            agent_options_menu_handle: PopoverMenuHandle::default(),
            skills_options_menu_handle: PopoverMenuHandle::default(),
            thinking_effort_menu_handle: PopoverMenuHandle::default(),
            project,
            show_external_source_prompt_warning,
            show_codex_windows_warning,
            multi_root_callout_dismissed: false,
            generating_indicator_in_list: false,
        };

        this.sync_generating_indicator(cx);
        this.sync_editor_mode_for_empty_state(cx);
        let list_state_for_scroll = this.list_state.clone();
        let thread_view = cx.entity().downgrade();

        this.list_state
            .set_scroll_handler(move |_event, _window, cx| {
                let list_state = list_state_for_scroll.clone();
                let thread_view = thread_view.clone();
                // N.B. We must defer because the scroll handler is called while the
                // ListState's RefCell is mutably borrowed. Reading logical_scroll_top()
                // directly would panic from a double borrow.
                cx.defer(move |cx| {
                    let scroll_top = list_state.logical_scroll_top();
                    let _ = thread_view.update(cx, |this, cx| {
                        if let Some(thread) = this.as_native_thread(cx) {
                            thread.update(cx, |thread, _cx| {
                                thread.set_ui_scroll_position(Some(scroll_top));
                            });
                        }
                        this.schedule_save(cx);
                    });
                });
            });

        if should_auto_submit {
            this.send(window, cx);
        }
        this
    }

    /// Schedule a throttled save of the thread state (draft prompt, scroll position, etc.).
    /// Multiple calls within `SERIALIZATION_THROTTLE_TIME` are coalesced into a single save.
    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        self._save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(SERIALIZATION_THROTTLE_TIME)
                .await;
            this.update(cx, |this, cx| {
                if let Some(thread) = this.as_native_thread(cx) {
                    thread.update(cx, |_thread, cx| cx.notify());
                }
            })
            .ok();
        }));
    }

    pub fn handle_message_editor_event(
        &mut self,
        _editor: &Entity<MessageEditor>,
        event: &MessageEditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            MessageEditorEvent::Send => self.send(window, cx),
            MessageEditorEvent::SendImmediately => self.interrupt_and_send(window, cx),
            MessageEditorEvent::Cancel => self.cancel_generation(cx),
            MessageEditorEvent::Focus => {
                self.cancel_editing(&Default::default(), window, cx);
            }
            MessageEditorEvent::LostFocus => {}
            MessageEditorEvent::InputAttempted { .. } => {}
        }
    }

    pub(crate) fn as_native_connection(
        &self,
        cx: &App,
    ) -> Option<Rc<agent::NativeAgentConnection>> {
        let acp_thread = self.thread.read(cx);
        acp_thread.connection().clone().downcast()
    }

    pub fn as_native_thread(&self, cx: &App) -> Option<Entity<agent::Thread>> {
        let acp_thread = self.thread.read(cx);
        self.as_native_connection(cx)?
            .thread(acp_thread.session_id(), cx)
    }

    pub(super) fn set_prompt_prefix(&mut self, prompt_prefix: Option<SharedString>) {
        self.prompt_prefix = prompt_prefix;
    }

    pub(super) fn set_before_send_hook(&mut self, before_send_hook: Option<BeforeSendHook>) {
        self.before_send_hook = before_send_hook;
    }

    /// Resolves the message editor's contents into content blocks. For profiles
    /// that do not enable any tools, directory mentions are expanded to inline
    /// file contents since the agent can't read files on its own.
    fn resolve_message_contents(
        &self,
        message_editor: &Entity<MessageEditor>,
        cx: &mut App,
    ) -> Task<Result<(Vec<acp::ContentBlock>, Vec<Entity<Buffer>>)>> {
        let expand = self.as_native_thread(cx).is_some_and(|thread| {
            let thread = thread.read(cx);
            AgentSettings::get_global(cx)
                .profiles
                .get(thread.profile())
                .is_some_and(|profile| profile.tools.is_empty())
        });
        let contents =
            message_editor.update(cx, |message_editor, cx| message_editor.contents(expand, cx));
        let Some(prompt_prefix) = self.prompt_prefix.clone() else {
            return contents;
        };
        cx.spawn(async move |_cx| {
            let (content, tracked_buffers) = contents.await?;
            Ok((
                prefix_content_blocks(&prompt_prefix, content),
                tracked_buffers,
            ))
        })
    }

    pub fn current_model_id(&self, cx: &App) -> Option<String> {
        let selector = self.model_selector.as_ref()?;
        let model = selector.read(cx).active_model(cx)?;
        Some(model.id.to_string())
    }

    pub fn current_model_label(&self, cx: &App) -> Option<SharedString> {
        let selector = self.model_selector.as_ref()?;
        let model = selector.read(cx).active_model(cx)?;
        Some(model.name.clone())
    }

    fn current_model_provider_label(&self, cx: &App) -> Option<SharedString> {
        let selector = self.model_selector.as_ref()?;
        let model = selector.read(cx).active_model(cx)?;
        model.description.clone()
    }

    pub fn current_mode_id(&self, cx: &App) -> Option<Arc<str>> {
        if let Some(thread) = self.as_native_thread(cx) {
            Some(thread.read(cx).profile().0.clone())
        } else {
            let mode_selector = self.mode_selector.as_ref()?;
            Some(mode_selector.read(cx).mode().0)
        }
    }

    fn is_subagent(&self) -> bool {
        self.parent_session_id.is_some()
    }

    fn backboard_logo_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../app/logo.png")
    }

    fn render_backboard_logo(&self, size: Pixels) -> impl IntoElement {
        img(Self::backboard_logo_path())
            .h(size)
            .w_auto()
            .flex_none()
            .object_fit(ObjectFit::ScaleDown)
    }

    fn render_backboard_status(
        &self,
        state_label: &'static str,
        emphasize: bool,
        cx: &App,
    ) -> impl IntoElement {
        let model_label = self.current_model_label(cx);

        h_flex()
            .gap_1p5()
            .items_center()
            .child(self.render_backboard_logo(px(18.)))
            .child(
                v_flex()
                    .gap_0p5()
                    .overflow_hidden()
                    .child(
                        Label::new(self.agent_display_name.clone())
                            .size(LabelSize::Small)
                            .color(if emphasize {
                                Color::Default
                            } else {
                                Color::Muted
                            }),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .overflow_hidden()
                            .child(
                                Label::new(state_label)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            )
                            .when_some(model_label, |this, model| {
                                this.child(
                                    Label::new(model)
                                        .size(LabelSize::XSmall)
                                        .color(Color::Muted),
                                )
                            }),
                    ),
            )
    }

    fn render_assistant_message_header(
        &self,
        model_label: Option<SharedString>,
        _cx: &App,
    ) -> impl IntoElement {
        h_flex()
            .gap_1()
            .items_center()
            .child(self.render_backboard_logo(px(14.)))
            .child(
                Label::new(self.agent_display_name.clone())
                    .size(LabelSize::XSmall)
                    .color(Color::Muted),
            )
            .when_some(model_label, |this, model| {
                this.child(
                    Label::new(model)
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                )
            })
    }

    fn is_backboard_progress_text(text: &str) -> bool {
        let text = text.trim_start();
        text.starts_with("Backboard ")
            || text.starts_with("Loading the Backboard agent runtime.")
            || text.starts_with("Preparing workspace context and tools.")
            || text.starts_with("Preparing workspace context.")
            || text.starts_with("Sending the task to the selected model.")
            || text.starts_with("Sending to model.")
            || text.starts_with("Connected to model.")
            || text.starts_with("Planning next step.")
            || text.starts_with("Running ")
            || text.starts_with("Retrying request.")
            || text.starts_with("Realtime voice enabled ")
            || text.starts_with("Generated media.")
            || text.starts_with("Updating the visible task plan.")
    }

    fn render_backboard_progress_status(
        &self,
        markdown: Entity<Markdown>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let label = markdown
            .read(cx)
            .source()
            .trim()
            .trim_end_matches('.')
            .to_string();

        h_flex()
            .gap_1p5()
            .items_center()
            .opacity(0.72)
            .child(self.render_backboard_logo(px(11.)))
            .child(
                Label::new(label)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted)
                    .truncate(),
            )
            .into_any_element()
    }

    fn render_backboard_footer_status(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let model_label = self
            .current_model_label(cx)
            .unwrap_or_else(|| SharedString::from("Select model"));
        let provider_label = self.current_model_provider_label(cx);
        let tooltip_label = format!("Change model: {model_label}");

        ButtonLike::new("backboard-footer-model-selector")
            .width(px(156.))
            .height(px(26.).into())
            .style(ButtonStyle::Subtle)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .when_some(provider_label, |this, provider| {
                        this.child(
                            Label::new(provider)
                                .size(LabelSize::XSmall)
                                .color(Color::Muted)
                                .flex_none(),
                        )
                    })
                    .child(
                        Label::new(model_label)
                            .size(LabelSize::XSmall)
                            .color(Color::Default)
                            .truncate()
                            .flex_1(),
                    )
                    .child(
                        Icon::new(IconName::ChevronDown)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .tooltip(Tooltip::text(tooltip_label))
            .on_click(cx.listener(|this, _, window, cx| {
                this.toggle_model_selector(window, cx);
            }))
    }

    fn render_selected_model_readout(&self, cx: &App) -> Option<impl IntoElement> {
        let model_label = self.current_model_label(cx)?;
        let provider_label = self.current_model_provider_label(cx);

        Some(
            h_flex()
                .min_w_0()
                .max_w_64()
                .gap_1()
                .items_center()
                .when_some(provider_label, |this, provider| {
                    this.child(
                        Label::new(provider)
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .flex_none(),
                    )
                })
                .child(
                    Label::new(model_label)
                        .size(LabelSize::XSmall)
                        .color(Color::Muted)
                        .truncate(),
                ),
        )
    }

    fn toggle_model_selector(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread.read(cx).status() != ThreadStatus::Idle {
            return;
        }
        if let Some(config_options_view) = self.config_options_view.clone() {
            let handled = config_options_view.update(cx, |view, cx| {
                view.toggle_category_picker(acp::SessionConfigOptionCategory::Model, window, cx)
            });
            if handled {
                return;
            }
        }

        if let Some(model_selector) = self.model_selector.clone() {
            model_selector.update(cx, |model_selector, cx| model_selector.toggle(window, cx));
        }
    }

    fn toggle_session_options(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread.read(cx).status() != ThreadStatus::Idle {
            return;
        }

        if self.config_options_view.is_some() {
            self.agent_options_menu_handle.toggle(window, cx);
            return;
        }

        if let Some(profile_selector) = self.profile_selector.clone() {
            profile_selector.read(cx).menu_handle().toggle(window, cx);
        } else if let Some(mode_selector) = self.mode_selector.clone() {
            mode_selector.read(cx).menu_handle().toggle(window, cx);
        }
    }

    fn render_session_options_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.config_options_view.is_none()
            && self.profile_selector.is_none()
            && self.mode_selector.is_none()
        {
            return None;
        }

        let focus_handle = self.message_editor.focus_handle(cx);

        if let Some(config_options_view) = self.config_options_view.clone() {
            let menu_handle = self.agent_options_menu_handle.clone();
            return Some(
                PopoverMenu::new("thread-agent-options-menu")
                    .trigger_with_tooltip(
                        IconButton::new("thread-session-options", IconName::Sliders)
                            .icon_size(IconSize::Small)
                            .icon_color(Color::Muted)
                            .style(ButtonStyle::Transparent)
                            .shape(ui::IconButtonShape::Square),
                        move |_, cx| {
                            Tooltip::for_action_in(
                                "Change Agent Options",
                                &ToggleProfileSelector,
                                &focus_handle,
                                cx,
                            )
                        },
                    )
                    .anchor(gpui::Anchor::BottomRight)
                    .offset(gpui::Point {
                        x: px(0.0),
                        y: px(-2.0),
                    })
                    .with_handle(menu_handle)
                    .menu(move |window, cx| {
                        Some(Self::build_agent_options_context_menu(
                            config_options_view.clone(),
                            window,
                            cx,
                        ))
                    })
                    .into_any_element(),
            );
        }

        Some(
            IconButton::new("thread-session-options", IconName::Sliders)
                .icon_size(IconSize::Small)
                .icon_color(Color::Muted)
                .style(ButtonStyle::Transparent)
                .shape(ui::IconButtonShape::Square)
                .tooltip(move |_, cx| {
                    Tooltip::for_action_in(
                        "Change Agent Options",
                        &ToggleProfileSelector,
                        &focus_handle,
                        cx,
                    )
                })
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_session_options(window, cx);
                }))
                .into_any_element(),
        )
    }

    fn render_skills_options_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let config_options_view = self.config_options_view.clone()?;
        let workspace = self.workspace.clone();
        let menu_handle = self.skills_options_menu_handle.clone();
        let enabled_skills = self.enabled_skill_summaries(cx);
        let enabled_skill_count = enabled_skills.len();
        let tooltip = Self::skills_button_tooltip(&enabled_skills);
        let badge = (enabled_skill_count > 0)
            .then(|| Self::render_enabled_skill_count_badge(enabled_skill_count, cx));
        let icon_color = if enabled_skill_count > 0 {
            Color::Accent
        } else {
            Color::Muted
        };

        Some(
            PopoverMenu::new("thread-skills-options-menu")
                .trigger_with_tooltip(
                    ButtonLike::new("thread-skills-options")
                        .width(px(24.))
                        .height(px(22.).into())
                        .size(ButtonSize::None)
                        .style(ButtonStyle::Transparent)
                        .child(
                            div()
                                .relative()
                                .size_5()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    Icon::new(IconName::Box)
                                        .size(IconSize::Small)
                                        .color(icon_color),
                                )
                                .when_some(badge, |this, badge| this.child(badge)),
                        ),
                    move |_, cx| Tooltip::simple(tooltip.clone(), cx),
                )
                .anchor(gpui::Anchor::BottomRight)
                .offset(gpui::Point {
                    x: px(0.0),
                    y: px(-2.0),
                })
                .with_handle(menu_handle)
                .menu(move |window, cx| {
                    Some(Self::build_skills_context_menu(
                        config_options_view.clone(),
                        workspace.clone(),
                        window,
                        cx,
                    ))
                })
                .into_any_element(),
        )
    }

    fn build_agent_options_context_menu(
        config_options_view: Entity<ConfigOptionsView>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<ContextMenu> {
        let options = config_options_view
            .read(cx)
            .option_summaries()
            .into_iter()
            .filter(Self::is_agent_option_summary)
            .collect::<Vec<_>>();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            menu = menu.key_context("AgentOptionsMenu").header("Agent Options");

            if options.is_empty() {
                return menu.label("No session options available.");
            }

            for option in options.clone() {
                let option_id = option.id.clone();
                let submenu_label =
                    SharedString::from(format!("{}: {}", option.name, option.current_value_name));
                let config_options_view = config_options_view.clone();

                menu = menu.submenu_with_icon(
                    submenu_label,
                    IconName::Sliders,
                    move |mut menu, _window, cx| {
                        let choices = config_options_view
                            .read(cx)
                            .option_value_summaries(&option_id);

                        if choices.is_empty() {
                            return menu.label("No values available.");
                        }

                        for choice in choices {
                            let option_id_for_choice = option_id.clone();
                            let value = choice.value.clone();
                            let is_current = choice.is_current;
                            let config_options_view = config_options_view.clone();
                            let mut entry = ContextMenuEntry::new(choice.name)
                                .toggle(IconPosition::End, is_current)
                                .disabled(is_current)
                                .handler(move |_window, cx| {
                                    config_options_view.update(cx, |view, cx| {
                                        view.set_option_value(
                                            option_id_for_choice.clone(),
                                            value.clone(),
                                            cx,
                                        );
                                    });
                                });

                            if let Some(description) = choice.description {
                                entry = entry.documentation_aside(
                                    documentation_aside_side(cx),
                                    move |_cx| Label::new(description.clone()).into_any_element(),
                                );
                            }

                            menu = menu.item(entry);
                        }

                        menu
                    },
                );
            }

            menu
        })
    }

    fn build_skills_context_menu(
        config_options_view: Entity<ConfigOptionsView>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<ContextMenu> {
        let mut grouped_options = BTreeMap::new();
        for option in config_options_view
            .read(cx)
            .option_summaries()
            .into_iter()
            .filter(|option| option.id.0.starts_with("backboard_skill:"))
        {
            grouped_options
                .entry(AgentOptionsMenu::skill_category_label(&option.id))
                .or_insert_with(Vec::new)
                .push(option);
        }

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            let config_options_view_for_create = config_options_view.clone();
            let workspace_for_create = workspace.clone();
            menu = menu
                .key_context("SkillsMenu")
                .header("Skills")
                .custom_entry(
                    |_window, _cx| {
                        Self::render_context_menu_status_row(
                            "New Skill".into(),
                            "Create".into(),
                            IconName::Plus,
                            Color::Muted,
                            Color::Accent,
                        )
                    },
                    move |window, cx| {
                        Self::create_new_skill_from_context_menu(
                            config_options_view_for_create.clone(),
                            workspace_for_create.clone(),
                            window,
                            cx,
                        );
                    },
                );

            if grouped_options.is_empty() {
                return menu.separator().label("No skills available.");
            }

            menu = menu.separator();

            for (category, options) in grouped_options.clone() {
                let config_options_view = config_options_view.clone();
                let category_for_header = category.clone();
                menu = menu.submenu_with_icon(
                    category,
                    IconName::Box,
                    move |mut menu, _window, _cx| {
                        menu = menu.header(category_for_header.clone());

                        for option in options.clone() {
                            let option_id = option.id.clone();
                            let label = SharedString::from(option.name);
                            let status = SharedString::from(option.current_value_name);
                            let enabled = status.to_string().eq_ignore_ascii_case("on");
                            let description = option.description.clone();
                            let preview_path = option
                                .id
                                .0
                                .starts_with("backboard_skill:web/")
                                .then(|| AgentOptionsMenu::skill_preview_path(&option.id))
                                .flatten();
                            let tooltip_id = format!("skill-preview-tooltip-{}", option.id.0);
                            let config_options_view = config_options_view.clone();

                            menu = menu.custom_entry(
                                move |_window, _cx| {
                                    Self::render_skill_context_menu_row(
                                        tooltip_id.clone(),
                                        label.clone(),
                                        status.clone(),
                                        if enabled {
                                            IconName::Check
                                        } else {
                                            IconName::Box
                                        },
                                        if enabled {
                                            Color::Success
                                        } else {
                                            Color::Muted
                                        },
                                        if enabled { Color::Accent } else { Color::Muted },
                                        preview_path.clone(),
                                        description.clone(),
                                    )
                                },
                                move |_window, cx| {
                                    config_options_view.update(cx, |view, cx| {
                                        view.cycle_option(&option_id, cx);
                                    });
                                },
                            );
                        }

                        menu
                    },
                );
            }

            menu
        })
    }

    fn is_agent_option_summary(option: &ConfigOptionSummary) -> bool {
        let option_id = option.id.to_string();
        !option_id.starts_with("backboard_skill:")
            && !option_id.starts_with("backboard_mcp_")
            && option_id != "backboard_voice_mode"
            && option_id != "backboard_live_voice"
    }

    fn create_new_skill_from_context_menu(
        config_options_view: Entity<ConfigOptionsView>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some((skill_path, slug)) = AgentOptionsMenu::next_new_skill_path() else {
            log::error!("Could not allocate a new Backboard skill path");
            return;
        };

        let Some(parent_dir) = skill_path.parent() else {
            log::error!(
                "New Backboard skill path has no parent: {}",
                skill_path.display()
            );
            return;
        };

        if let Err(error) = std::fs::create_dir_all(parent_dir) {
            log::error!(
                "Failed to create Backboard skill directory {}: {error:#}",
                parent_dir.display()
            );
            return;
        }

        if let Err(error) = std::fs::write(&skill_path, AgentOptionsMenu::new_skill_template(&slug))
        {
            log::error!(
                "Failed to write Backboard skill file {}: {error:#}",
                skill_path.display()
            );
            return;
        }

        config_options_view.update(cx, |view, cx| view.refresh_options(window, cx));

        if let Some(workspace) = workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                let open_task = workspace.open_abs_path(
                    skill_path.clone(),
                    OpenOptions {
                        visible: Some(OpenVisible::OnlyFiles),
                        ..Default::default()
                    },
                    window,
                    cx,
                );
                cx.spawn(async move |_, _| {
                    if let Err(error) = open_task.await {
                        log::error!("Failed to open Backboard skill file: {error:#}");
                    }
                })
                .detach();
            });
        }
    }

    fn render_skill_context_menu_row(
        tooltip_id: String,
        label: SharedString,
        status: SharedString,
        icon: IconName,
        icon_color: Color,
        status_color: Color,
        preview_path: Option<PathBuf>,
        description: Option<String>,
    ) -> AnyElement {
        let row =
            Self::render_context_menu_status_row(label, status, icon, icon_color, status_color);

        if preview_path.is_none() && description.is_none() {
            return row;
        }

        div()
            .w_full()
            .child(row)
            .id(ElementId::Name(tooltip_id.into()))
            .tooltip(Tooltip::element(move |_window, cx| {
                let mut content = v_flex().gap_1();
                if let Some(preview_path) = preview_path.as_ref()
                    && preview_path.is_file()
                {
                    content = content.child(
                        div()
                            .w(px(280.))
                            .h(px(160.))
                            .rounded_sm()
                            .overflow_hidden()
                            .border_1()
                            .border_color(cx.theme().colors().border_variant)
                            .child(
                                img(preview_path.clone())
                                    .size_full()
                                    .object_fit(ObjectFit::ScaleDown),
                            ),
                    );
                }
                if let Some(description) = description.clone() {
                    content = content.child(
                        Label::new(description)
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    );
                }
                content.into_any()
            }))
            .into_any_element()
    }

    fn enabled_skill_summaries(&self, cx: &App) -> Vec<ConfigOptionSummary> {
        self.config_options_view
            .as_ref()
            .map(|config_options_view| {
                config_options_view
                    .read(cx)
                    .option_summaries()
                    .into_iter()
                    .filter(Self::is_enabled_skill_summary)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn is_enabled_skill_summary(option: &ConfigOptionSummary) -> bool {
        option.id.0.starts_with("backboard_skill:")
            && option.current_value_name.eq_ignore_ascii_case("on")
    }

    fn skills_button_tooltip(enabled_skills: &[ConfigOptionSummary]) -> SharedString {
        if enabled_skills.is_empty() {
            return SharedString::from("Skills: none enabled");
        }

        let mut skill_names = enabled_skills
            .iter()
            .take(3)
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let remaining = enabled_skills.len().saturating_sub(3);
        if remaining > 0 {
            skill_names.push_str(&format!(" +{remaining} more"));
        }

        let suffix = if enabled_skills.len() == 1 {
            "skill"
        } else {
            "skills"
        };
        SharedString::from(format!(
            "{} {suffix} enabled: {skill_names}",
            enabled_skills.len()
        ))
    }

    fn render_enabled_skill_count_badge(count: usize, cx: &App) -> AnyElement {
        let label = if count > 99 {
            "99+".to_string()
        } else {
            count.to_string()
        };

        div()
            .absolute()
            .top_neg_0p5()
            .right_neg_0p5()
            .h(rems_from_px(12.))
            .min_w(rems_from_px(12.))
            .px(rems_from_px(2.))
            .rounded_full()
            .border_1()
            .border_color(cx.theme().status().info_border)
            .bg(cx.theme().status().info_background)
            .flex()
            .items_center()
            .justify_center()
            .child(
                Label::new(label)
                    .size(LabelSize::Custom(rems_from_px(8.)))
                    .color(Color::Default),
            )
            .into_any_element()
    }

    /// Returns the currently active editor, either for a message that is being
    /// edited or the editor for a new message.
    pub(crate) fn active_editor(&self, cx: &App) -> Entity<MessageEditor> {
        if let Some(index) = self.editing_message
            && let Some(editor) = self
                .entry_view_state
                .read(cx)
                .entry(index)
                .and_then(|entry| entry.message_editor())
                .cloned()
        {
            editor
        } else {
            self.message_editor.clone()
        }
    }

    pub fn has_queued_messages(&self) -> bool {
        !self.local_queued_messages.is_empty()
    }

    pub fn is_imported_thread(&self, cx: &App) -> bool {
        let Some(thread) = self.as_native_thread(cx) else {
            return false;
        };
        thread.read(cx).is_imported()
    }

    // events

    pub fn handle_entry_view_event(
        &mut self,
        _: &Entity<EntryViewState>,
        event: &EntryViewEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match &event.view_event {
            ViewEvent::NewDiff(tool_call_id) => {
                let is_zed_native_agent = self.agent_id.as_ref() == agent::ZED_AGENT_ID.as_ref();
                let is_backboard_agent = self.agent_id.as_ref() == "backboard";
                if !is_backboard_agent
                    && AgentSettings::get_global(cx).expand_edit_card
                    && !is_zed_native_agent
                {
                    self.expanded_tool_calls.insert(tool_call_id.clone());
                }
            }
            ViewEvent::NewTerminal(tool_call_id) => {
                if self.agent_id.as_ref() != "backboard"
                    && AgentSettings::get_global(cx).expand_terminal_card
                {
                    self.expanded_tool_calls.insert(tool_call_id.clone());
                }
            }
            ViewEvent::TerminalMovedToBackground(tool_call_id) => {
                self.expanded_tool_calls.remove(tool_call_id);
            }
            ViewEvent::MessageEditorEvent(_editor, MessageEditorEvent::Focus) => {
                if let Some(AgentThreadEntry::UserMessage(user_message)) =
                    self.thread.read(cx).entries().get(event.entry_index)
                    && self.thread.read(cx).supports_truncate(cx)
                    && user_message.id.is_some()
                    && !self.is_subagent()
                {
                    self.editing_message = Some(event.entry_index);
                    cx.notify();
                }
            }
            ViewEvent::MessageEditorEvent(editor, MessageEditorEvent::LostFocus) => {
                if let Some(AgentThreadEntry::UserMessage(user_message)) =
                    self.thread.read(cx).entries().get(event.entry_index)
                    && self.thread.read(cx).supports_truncate(cx)
                    && user_message.id.is_some()
                    && !self.is_subagent()
                {
                    if editor.read(cx).text(cx).as_str() == user_message.content.to_markdown(cx) {
                        self.editing_message = None;
                        cx.notify();
                    }
                }
            }
            ViewEvent::MessageEditorEvent(_editor, MessageEditorEvent::SendImmediately) => {}
            ViewEvent::MessageEditorEvent(editor, MessageEditorEvent::Send) => {
                if !self.is_subagent() {
                    self.regenerate(event.entry_index, editor.clone(), window, cx);
                }
            }
            ViewEvent::MessageEditorEvent(_editor, MessageEditorEvent::Cancel) => {
                self.cancel_editing(&Default::default(), window, cx);
            }
            ViewEvent::MessageEditorEvent(_editor, MessageEditorEvent::InputAttempted { .. }) => {}
            ViewEvent::OpenDiffLocation {
                path,
                position,
                split,
            } => {
                self.open_diff_location(path, *position, *split, window, cx);
            }
        }
    }

    fn open_diff_location(
        &self,
        path: &str,
        position: Point,
        split: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.upgrade() else {
            return;
        };
        let Some(project_path) = project.read(cx).find_project_path(path, cx) else {
            return;
        };

        let open_task = if split {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.split_path(project_path, window, cx)
                })
                .log_err()
        } else {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.open_path(project_path, None, true, window, cx)
                })
                .log_err()
        };

        let Some(open_task) = open_task else {
            return;
        };

        window
            .spawn(cx, async move |cx| {
                let item = open_task.await?;
                let Some(editor) = item.downcast::<Editor>() else {
                    return anyhow::Ok(());
                };
                editor.update_in(cx, |editor, window, cx| {
                    editor.change_selections(
                        SelectionEffects::scroll(Autoscroll::center()),
                        window,
                        cx,
                        |selections| {
                            selections.select_ranges([position..position]);
                        },
                    );
                })?;
                anyhow::Ok(())
            })
            .detach_and_log_err(cx);
    }

    // turns

    pub fn start_turn(&mut self, cx: &mut Context<Self>) -> usize {
        self.turn_fields.turn_generation += 1;
        let generation = self.turn_fields.turn_generation;
        self.turn_fields.turn_started_at = Some(Instant::now());
        self.turn_fields.last_turn_duration = None;
        self.turn_fields.last_turn_tokens = None;
        self.turn_fields.turn_tokens = Some(0);
        self.turn_fields._turn_timer_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        }));
        generation
    }

    pub fn stop_turn(&mut self, generation: usize, cx: &mut Context<Self>) {
        if self.turn_fields.turn_generation != generation {
            return;
        }
        let duration = self
            .turn_fields
            .turn_started_at
            .take()
            .map(|started| started.elapsed());
        self.turn_fields.last_turn_duration = duration;
        if let Some(duration) = duration {
            let entries = self.thread.read(cx).entries();
            let start = entries
                .iter()
                .rposition(|entry| matches!(entry, AgentThreadEntry::UserMessage(_)))
                .map_or(0, |ix| ix + 1);
            self.assistant_turn_durations.insert(start, duration);
        }
        self.turn_fields.last_turn_tokens = self.turn_fields.turn_tokens.take();
        self.turn_fields._turn_timer_task = None;
    }

    pub fn update_turn_tokens(&mut self, cx: &App) {
        if let Some(usage) = self.thread.read(cx).token_usage() {
            if let Some(tokens) = &mut self.turn_fields.turn_tokens {
                *tokens += usage.output_tokens;
                self.emit_token_limit_telemetry_if_needed(cx);
            }
        }
    }

    fn emit_token_limit_telemetry_if_needed(&mut self, cx: &App) {
        let (ratio, agent_telemetry_id, session_id) = {
            let thread_data = self.thread.read(cx);
            let Some(token_usage) = thread_data.token_usage() else {
                return;
            };
            (
                token_usage.ratio(),
                thread_data.connection().telemetry_id(),
                thread_data.session_id().clone(),
            )
        };

        let kind = match ratio {
            acp_thread::TokenUsageRatio::Normal => {
                self.last_token_limit_telemetry = None;
                return;
            }
            acp_thread::TokenUsageRatio::Warning => "warning",
            acp_thread::TokenUsageRatio::Exceeded => "exceeded",
        };

        let should_skip = self
            .last_token_limit_telemetry
            .as_ref()
            .is_some_and(|last| *last >= ratio);
        if should_skip {
            return;
        }

        self.last_token_limit_telemetry = Some(ratio);

        telemetry::event!(
            "Agent Token Limit Warning",
            agent = agent_telemetry_id,
            session_id = session_id,
            kind = kind,
        );
    }

    // sending

    fn clear_external_source_prompt_warning(&mut self, cx: &mut Context<Self>) {
        if self.show_external_source_prompt_warning {
            self.show_external_source_prompt_warning = false;
            cx.notify();
        }
    }

    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let thread = &self.thread;

        if self.is_loading_contents {
            return;
        }

        let message_editor = self.message_editor.clone();

        let is_editor_empty = message_editor.read(cx).is_empty(cx);
        let is_generating = thread.read(cx).status() != ThreadStatus::Idle;

        let has_queued = self.has_queued_messages();
        if is_editor_empty && self.can_fast_track_queue && has_queued {
            self.can_fast_track_queue = false;
            self.send_queued_message_at_index(0, true, window, cx);
            return;
        }

        if is_editor_empty {
            return;
        }

        if is_generating {
            cx.emit(AcpThreadViewEvent::Interacted);
            self.queue_message(message_editor, window, cx);
            return;
        }

        let text = message_editor.read(cx).text(cx);
        let text = text.trim();
        if text == "/login" || text == "/logout" {
            let connection = thread.read(cx).connection().clone();
            let can_login = !connection.auth_methods().is_empty();
            // Does the agent have a specific logout command? Prefer that in case they need to reset internal state.
            let logout_supported = text == "/logout"
                && self
                    .session_capabilities
                    .read()
                    .available_commands()
                    .iter()
                    .any(|command| command.name == "logout");
            if can_login && !logout_supported {
                message_editor.update(cx, |editor, cx| editor.clear(window, cx));
                self.clear_external_source_prompt_warning(cx);

                let connection = self.thread.read(cx).connection().clone();
                window.defer(cx, {
                    let agent_id = self.agent_id.clone();
                    let server_view = self.server_view.clone();
                    move |window, cx| {
                        ConversationView::handle_auth_required(
                            server_view.clone(),
                            AuthRequired::new(),
                            agent_id,
                            connection,
                            window,
                            cx,
                        );
                    }
                });
                cx.notify();
                return;
            }
        }

        if let Some(before_send_hook) = self.before_send_hook.clone()
            && !before_send_hook(text, window, cx)
        {
            return;
        }

        cx.emit(AcpThreadViewEvent::Interacted);
        self.send_impl(message_editor, window, cx)
    }

    pub fn send_impl(
        &mut self,
        message_editor: Entity<MessageEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let contents = self.resolve_message_contents(&message_editor, cx);

        self.thread_error.take();
        self.thread_feedback.clear();
        self.editing_message.take();

        if self.should_be_following {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.follow(CollaboratorId::Agent, window, cx);
                })
                .ok();
        }

        let contents_task = cx.spawn_in(window, async move |_this, cx| {
            let (contents, tracked_buffers) = contents.await?;

            if contents.is_empty() {
                return Ok(None);
            }

            let _ = cx.update(|window, cx| {
                message_editor.update(cx, |message_editor, cx| {
                    message_editor.clear(window, cx);
                });
            });

            Ok(Some((contents, tracked_buffers)))
        });

        self.send_content(contents_task, window, cx);
    }

    pub fn send_content(
        &mut self,
        contents_task: Task<anyhow::Result<Option<(Vec<acp::ContentBlock>, Vec<Entity<Buffer>>)>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let session_id = self.thread.read(cx).session_id().clone();
        let parent_session_id = self.thread.read(cx).parent_session_id().cloned();
        let agent_telemetry_id = self.thread.read(cx).connection().telemetry_id();
        let is_first_message = self.thread.read(cx).entries().is_empty();
        let should_replace_initial_title = self.uses_compact_assistant_turns() && {
            let thread = self.thread.read(cx);
            thread.title().is_some_and(|title| {
                let title = title.as_ref();
                title == "Backboard"
                    || thread.work_dirs().is_some_and(|work_dirs| {
                        work_dirs.ordered_paths().any(|path| {
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name == title)
                        })
                    })
            })
        };
        let thread = self.thread.downgrade();

        self.is_loading_contents = true;

        let model_id = self.current_model_id(cx);
        let mode_id = self.current_mode_id(cx);
        let guard = cx.new(|_| ());
        cx.observe_release(&guard, |this, _guard, cx| {
            this.is_loading_contents = false;
            cx.notify();
        })
        .detach();

        let side = match AgentSettings::get_global(cx).sidebar_side() {
            SidebarSide::Left => "left",
            SidebarSide::Right => "right",
        };

        let task = cx.spawn_in(window, async move |this, cx| {
            let Some((contents, tracked_buffers)) = contents_task.await? else {
                return Ok(());
            };

            let generation = this.update(cx, |this, cx| {
                this.clear_external_source_prompt_warning(cx);
                let generation = this.start_turn(cx);
                this.in_flight_prompt = Some(contents.clone());
                generation
            })?;

            this.update_in(cx, |this, _window, cx| {
                this.set_editor_is_expanded(false, cx);
            })?;

            let _ = this.update(cx, |this, cx| {
                this.list_state.scroll_to_end();
                cx.notify();
            });

            let _stop_turn = defer({
                let this = this.clone();
                let mut cx = cx.clone();
                move || {
                    this.update(&mut cx, |this, cx| {
                        this.stop_turn(generation, cx);
                        cx.notify();
                    })
                    .ok();
                }
            });
            if is_first_message && let Some(title) = prompt_title_for_content_blocks(&contents) {
                let set_title = thread.update(cx, |thread, cx| {
                    if should_replace_initial_title {
                        if thread.title().as_ref() != Some(&title) {
                            return Some(thread.set_title(title, cx));
                        }
                    } else if thread.title().is_none() {
                        thread.set_provisional_title(title, cx);
                    }
                    None
                })?;
                if let Some(set_title) = set_title {
                    set_title.await?;
                }
            }

            let turn_start_time = Instant::now();
            let send = thread.update(cx, |thread, cx| {
                thread.action_log().update(cx, |action_log, cx| {
                    for buffer in tracked_buffers {
                        action_log.buffer_read(buffer, cx)
                    }
                });
                drop(guard);

                telemetry::event!(
                    "Agent Message Sent",
                    agent = agent_telemetry_id,
                    session = session_id,
                    parent_session_id = parent_session_id.as_ref().map(|id| id.to_string()),
                    model = model_id,
                    mode = mode_id,
                    side = side
                );

                thread.send(contents, cx)
            })?;

            let _ = this.update(cx, |this, cx| {
                this.sync_generating_indicator(cx);
                cx.notify();
            });

            let res = send.await;
            let turn_time_ms = turn_start_time.elapsed().as_millis();
            drop(_stop_turn);
            let status = if res.is_ok() {
                let _ = this.update(cx, |this, _| this.in_flight_prompt.take());
                "success"
            } else {
                "failure"
            };
            telemetry::event!(
                "Agent Turn Completed",
                agent = agent_telemetry_id,
                session = session_id,
                parent_session_id = parent_session_id.as_ref().map(|id| id.to_string()),
                model = model_id,
                mode = mode_id,
                status,
                turn_time_ms,
                side = side
            );
            res.map(|_| ())
        });

        cx.spawn(async move |this, cx| {
            if let Err(err) = task.await {
                this.update(cx, |this, cx| {
                    this.handle_thread_error(err, cx);
                })
                .ok();
            } else {
                this.update(cx, |this, cx| {
                    let should_be_following = this
                        .workspace
                        .update(cx, |workspace, _| {
                            workspace.is_being_followed(CollaboratorId::Agent)
                        })
                        .unwrap_or_default();
                    this.should_be_following = should_be_following;
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn interrupt_and_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let thread = &self.thread;

        if self.is_loading_contents {
            return;
        }

        cx.emit(AcpThreadViewEvent::Interacted);

        let message_editor = self.message_editor.clone();
        if thread.read(cx).status() == ThreadStatus::Idle {
            self.send_impl(message_editor, window, cx);
            return;
        }

        self.stop_current_and_send_new_message(message_editor, window, cx);
    }

    fn stop_current_and_send_new_message(
        &mut self,
        message_editor: Entity<MessageEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thread = self.thread.clone();
        self.skip_queue_processing_count = 0;
        self.user_interrupted_generation = true;

        let cancelled = thread.update(cx, |thread, cx| thread.cancel(cx));

        cx.spawn_in(window, async move |this, cx| {
            cancelled.await;

            this.update_in(cx, |this, window, cx| {
                this.send_impl(message_editor, window, cx);
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn handle_thread_error(
        &mut self,
        error: impl Into<ThreadError>,
        cx: &mut Context<Self>,
    ) {
        let error = error.into();
        self.emit_thread_error_telemetry(&error, cx);
        self.thread_error = Some(error);
        cx.notify();
    }

    fn emit_thread_error_telemetry(&self, error: &ThreadError, cx: &mut Context<Self>) {
        let (error_kind, acp_error_code, message): (&str, Option<SharedString>, SharedString) =
            match error {
                ThreadError::PaymentRequired => (
                    "payment_required",
                    None,
                    "You reached your free usage limit. Upgrade to Backboard Pro for more prompts."
                        .into(),
                ),
                ThreadError::Refusal => {
                    let model_or_agent_name = self.current_model_name(cx);
                    let message = format!(
                        "{} refused to respond to this prompt. This can happen when a model believes the prompt violates its content policy or safety guidelines, so rephrasing it can sometimes address the issue.",
                        model_or_agent_name
                    );
                    ("refusal", None, message.into())
                }
                ThreadError::AuthenticationRequired(message) => {
                    ("authentication_required", None, message.clone())
                }
                ThreadError::RateLimitExceeded { provider } => (
                    "rate_limit_exceeded",
                    None,
                    format!("{provider}'s rate limit was reached.").into(),
                ),
                ThreadError::ServerOverloaded { provider } => (
                    "server_overloaded",
                    None,
                    format!("{provider}'s servers are temporarily unavailable.").into(),
                ),
                ThreadError::PromptTooLarge => (
                    "prompt_too_large",
                    None,
                    "Context too large for the model's context window.".into(),
                ),
                ThreadError::NoApiKey { provider } => (
                    "no_api_key",
                    None,
                    format!("No API key configured for {provider}.").into(),
                ),
                ThreadError::StreamError { provider } => (
                    "stream_error",
                    None,
                    format!("Connection to {provider}'s API was interrupted.").into(),
                ),
                ThreadError::InvalidApiKey { provider } => (
                    "invalid_api_key",
                    None,
                    format!("Invalid or expired API key for {provider}.").into(),
                ),
                ThreadError::PermissionDenied { provider } => (
                    "permission_denied",
                    None,
                    format!(
                        "{provider}'s API rejected the request due to insufficient permissions."
                    )
                    .into(),
                ),
                ThreadError::RequestFailed => (
                    "request_failed",
                    None,
                    "Request could not be completed after multiple attempts.".into(),
                ),
                ThreadError::MaxOutputTokens => (
                    "max_output_tokens",
                    None,
                    "Model reached its maximum output length.".into(),
                ),
                ThreadError::NoModelSelected => {
                    ("no_model_selected", None, "No model selected.".into())
                }
                ThreadError::ApiError { provider } => (
                    "api_error",
                    None,
                    format!("{provider}'s API returned an unexpected error.").into(),
                ),
                ThreadError::Other {
                    acp_error_code,
                    message,
                } => ("other", acp_error_code.clone(), message.clone()),
            };

        let agent_telemetry_id = self.thread.read(cx).connection().telemetry_id();
        let session_id = self.thread.read(cx).session_id().clone();
        let parent_session_id = self
            .thread
            .read(cx)
            .parent_session_id()
            .map(|id| id.to_string());

        telemetry::event!(
            "Agent Panel Error Shown",
            agent = agent_telemetry_id,
            session_id = session_id,
            parent_session_id = parent_session_id,
            kind = error_kind,
            acp_error_code = acp_error_code,
            message = message,
        );
    }

    pub fn cancel_generation(&mut self, cx: &mut Context<Self>) {
        self.thread_retry_status.take();
        self.thread_error.take();
        self.user_interrupted_generation = true;
        self._cancel_task = Some(self.thread.update(cx, |thread, cx| thread.cancel(cx)));
        self.sync_generating_indicator(cx);
        cx.notify();
    }

    pub fn retry_generation(&mut self, cx: &mut Context<Self>) {
        self.thread_error.take();

        let thread = &self.thread;
        if !thread.read(cx).can_retry(cx) {
            return;
        }

        let task = thread.update(cx, |thread, cx| thread.retry(cx));
        cx.emit(AcpThreadViewEvent::Interacted);
        self.sync_generating_indicator(cx);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = task.await;

            this.update(cx, |this, cx| {
                if let Err(err) = result {
                    this.handle_thread_error(err, cx);
                }
            })
        })
        .detach();
    }

    pub fn regenerate(
        &mut self,
        entry_ix: usize,
        message_editor: Entity<MessageEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_loading_contents {
            return;
        }
        let thread = self.thread.clone();

        let Some(user_message_id) = thread.update(cx, |thread, _| {
            thread.entries().get(entry_ix)?.user_message()?.id.clone()
        }) else {
            return;
        };

        cx.spawn_in(window, async move |this, cx| {
            // Check if there are any edits from prompts before the one being regenerated.
            //
            // If there are, we keep/accept them since we're not regenerating the prompt that created them.
            //
            // If editing the prompt that generated the edits, restore the checkpoint
            // captured before that prompt. This also reverts filesystem changes made
            // outside the action log, such as shell-created files.
            let has_earlier_edits = thread.read_with(cx, |thread, _| {
                thread
                    .entries()
                    .iter()
                    .take(entry_ix)
                    .any(|entry| entry.diffs().next().is_some())
            });

            if has_earlier_edits {
                thread.update(cx, |thread, cx| {
                    thread.action_log().update(cx, |action_log, cx| {
                        action_log.keep_all_edits(None, cx);
                    });
                });
            }

            thread
                .update(cx, |thread, cx| {
                    thread.restore_checkpoint(user_message_id, cx)
                })
                .await?;
            this.update_in(cx, |thread, window, cx| {
                cx.emit(AcpThreadViewEvent::Interacted);
                thread.send_impl(message_editor, window, cx);
                thread.focus_handle(cx).focus(window, cx);
            })?;
            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
    }

    // message queueing

    fn queue_message(
        &mut self,
        message_editor: Entity<MessageEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let is_idle = self.thread.read(cx).status() == acp_thread::ThreadStatus::Idle;

        if is_idle {
            self.send_impl(message_editor, window, cx);
            return;
        }

        let contents = self.resolve_message_contents(&message_editor, cx);

        cx.spawn_in(window, async move |this, cx| {
            let (content, tracked_buffers) = contents.await?;

            if content.is_empty() {
                return Ok::<(), anyhow::Error>(());
            }

            this.update_in(cx, |this, window, cx| {
                this.add_to_queue(content, tracked_buffers, cx);
                this.can_fast_track_queue = true;
                message_editor.update(cx, |message_editor, cx| {
                    message_editor.clear(window, cx);
                });
                cx.notify();
            })?;
            Ok(())
        })
        .detach_and_log_err(cx);
    }

    pub fn add_to_queue(
        &mut self,
        content: Vec<acp::ContentBlock>,
        tracked_buffers: Vec<Entity<Buffer>>,
        cx: &mut Context<Self>,
    ) {
        self.local_queued_messages.push(QueuedMessage {
            content,
            tracked_buffers,
        });
        self.sync_queue_flag_to_native_thread(cx);
    }

    pub fn remove_from_queue(
        &mut self,
        index: usize,
        cx: &mut Context<Self>,
    ) -> Option<QueuedMessage> {
        if index < self.local_queued_messages.len() {
            let removed = self.local_queued_messages.remove(index);
            self.sync_queue_flag_to_native_thread(cx);
            Some(removed)
        } else {
            None
        }
    }

    pub fn sync_queue_flag_to_native_thread(&self, cx: &mut Context<Self>) {
        if let Some(native_thread) = self.as_native_thread(cx) {
            let has_queued = self.has_queued_messages();
            native_thread.update(cx, |thread, _| {
                thread.set_has_queued_message(has_queued);
            });
        }
    }

    pub fn send_queued_message_at_index(
        &mut self,
        index: usize,
        is_send_now: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(queued) = self.remove_from_queue(index, cx) else {
            return;
        };

        cx.emit(AcpThreadViewEvent::Interacted);

        self.message_editor.focus_handle(cx).focus(window, cx);

        let content = queued.content;
        let tracked_buffers = queued.tracked_buffers;

        // Only increment skip count for "Send Now" operations (out-of-order sends)
        // Normal auto-processing from the Stopped handler doesn't need to skip.
        // We only skip the Stopped event from the cancelled generation, NOT the
        // Stopped event from the newly sent message (which should trigger queue processing).
        if is_send_now {
            let is_generating =
                self.thread.read(cx).status() == acp_thread::ThreadStatus::Generating;
            self.skip_queue_processing_count += if is_generating { 1 } else { 0 };
        }

        let cancelled = self.thread.update(cx, |thread, cx| thread.cancel(cx));

        let workspace = self.workspace.clone();

        let should_be_following = self.should_be_following;
        let contents_task = cx.spawn_in(window, async move |_this, cx| {
            cancelled.await;
            if should_be_following {
                workspace
                    .update_in(cx, |workspace, window, cx| {
                        workspace.follow(CollaboratorId::Agent, window, cx);
                    })
                    .ok();
            }

            Ok(Some((content, tracked_buffers)))
        });

        self.send_content(contents_task, window, cx);
    }

    pub fn move_queued_message_to_main_editor(
        &mut self,
        index: usize,
        attempt: Option<InputAttempt>,
        cursor_offset: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(queued_message) = self.remove_from_queue(index, cx) else {
            return false;
        };
        let queued_content = queued_message.content;
        let message_editor = self.message_editor.clone();

        window.focus(&message_editor.focus_handle(cx), cx);

        let adjusted_cursor_offset = if message_editor.read(cx).is_empty(cx) {
            message_editor.update(cx, |editor, cx| {
                editor.set_message(queued_content, window, cx);
            });
            cursor_offset
        } else {
            let existing_len = message_editor.read(cx).text(cx).len();
            let separator = "\n\n";
            message_editor.update(cx, |editor, cx| {
                editor.append_message(queued_content, Some(separator), window, cx);
            });
            cursor_offset.map(|offset| existing_len + separator.len() + offset)
        };

        message_editor.update(cx, |editor, cx| {
            if let Some(offset) = adjusted_cursor_offset {
                editor.set_cursor_offset(offset, window, cx);
            }
            match attempt {
                Some(InputAttempt::Text(text)) => {
                    editor.insert_text(&text, window, cx);
                }
                Some(InputAttempt::Paste(clipboard)) => {
                    editor.paste_item(&clipboard, window, cx);
                }
                None => {}
            }
        });

        cx.notify();
        true
    }

    // editor methods

    pub fn expand_message_editor(
        &mut self,
        _: &ExpandMessageEditor,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.list_state.item_count() == 0 {
            return;
        }
        self.set_editor_is_expanded(!self.editor_expanded, cx);
        cx.stop_propagation();
        cx.notify();
    }

    pub fn set_editor_is_expanded(&mut self, is_expanded: bool, cx: &mut Context<Self>) {
        self.editor_expanded = is_expanded;
        self.message_editor.update(cx, |editor, cx| {
            if is_expanded {
                editor.set_mode(
                    EditorMode::Full {
                        scale_ui_elements_with_buffer_font_size: false,
                        show_active_line_background: false,
                        sizing_behavior: SizingBehavior::ExcludeOverscrollMargin,
                    },
                    cx,
                )
            } else {
                let agent_settings = AgentSettings::get_global(cx);
                editor.set_mode(
                    EditorMode::AutoHeight {
                        min_lines: agent_settings.message_editor_min_lines,
                        max_lines: Some(agent_settings.set_message_editor_max_lines()),
                    },
                    cx,
                )
            }
        });
        cx.notify();
    }

    pub(crate) fn set_message_editor_auto_height(
        &mut self,
        min_lines: usize,
        max_lines: Option<usize>,
        cx: &mut Context<Self>,
    ) {
        self.editor_expanded = false;
        self.message_editor.update(cx, |editor, cx| {
            editor.set_mode(
                EditorMode::AutoHeight {
                    min_lines,
                    max_lines,
                },
                cx,
            );
        });
        cx.notify();
    }

    pub fn handle_title_editor_event(
        &mut self,
        title_editor: &Entity<Editor>,
        event: &EditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thread = &self.thread;

        match event {
            EditorEvent::BufferEdited => {
                // We only want to set the title if the user has actively edited
                // it. If the title editor is not focused, we programmatically
                // changed the text, so we don't want to set the title again.
                if !title_editor.read(cx).is_focused(window) {
                    return;
                }

                let new_title = title_editor.read(cx).text(cx);
                thread.update(cx, |thread, cx| {
                    thread
                        .set_title(new_title.into(), cx)
                        .detach_and_log_err(cx);
                })
            }
            EditorEvent::Blurred => {
                if title_editor.read(cx).text(cx).is_empty() {
                    title_editor.update(cx, |editor, cx| {
                        editor.set_text(DEFAULT_THREAD_TITLE, window, cx);
                    });
                }
            }
            _ => {}
        }
    }

    pub fn cancel_editing(&mut self, _: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.editing_message.take()
            && let Some(editor) = &self
                .entry_view_state
                .read(cx)
                .entry(index)
                .and_then(|e| e.message_editor())
                .cloned()
        {
            editor.update(cx, |editor, cx| {
                if let Some(user_message) = self
                    .thread
                    .read(cx)
                    .entries()
                    .get(index)
                    .and_then(|e| e.user_message())
                {
                    editor.set_message(user_message.chunks.clone(), window, cx);
                }
            })
        };
        self.message_editor.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    pub fn authorize_tool_call(
        &mut self,
        session_id: acp::SessionId,
        tool_call_id: acp::ToolCallId,
        outcome: SelectedPermissionOutcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.conversation.update(cx, |conversation, cx| {
            conversation.authorize_tool_call(session_id, tool_call_id, outcome, cx);
        });
        if self.should_be_following {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.follow(CollaboratorId::Agent, window, cx);
                })
                .ok();
        }
        cx.notify();
    }

    pub fn allow_always(&mut self, _: &AllowAlways, window: &mut Window, cx: &mut Context<Self>) {
        self.authorize_pending_tool_call(acp::PermissionOptionKind::AllowAlways, window, cx);
    }

    pub fn allow_once(&mut self, _: &AllowOnce, window: &mut Window, cx: &mut Context<Self>) {
        self.authorize_pending_with_granularity(true, window, cx);
    }

    pub fn reject_once(&mut self, _: &RejectOnce, window: &mut Window, cx: &mut Context<Self>) {
        self.authorize_pending_with_granularity(false, window, cx);
    }

    pub fn authorize_pending_tool_call(
        &mut self,
        kind: acp::PermissionOptionKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<()> {
        let session_id = self.thread.read(cx).session_id().clone();
        self.conversation.update(cx, |conversation, cx| {
            conversation.authorize_pending_tool_call(&session_id, kind, cx)
        })?;
        if self.should_be_following {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.follow(CollaboratorId::Agent, window, cx);
                })
                .ok();
        }
        cx.notify();
        Some(())
    }

    fn is_waiting_for_confirmation(entry: &AgentThreadEntry) -> bool {
        if let AgentThreadEntry::ToolCall(tool_call) = entry {
            matches!(
                tool_call.status,
                ToolCallStatus::WaitingForConfirmation { .. }
            )
        } else {
            false
        }
    }

    fn handle_authorize_tool_call(
        &mut self,
        action: &AuthorizeToolCall,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tool_call_id = acp::ToolCallId::new(action.tool_call_id.clone());
        let option_id = acp::PermissionOptionId::new(action.option_id.clone());
        let option_kind = match action.option_kind.as_str() {
            "AllowOnce" => acp::PermissionOptionKind::AllowOnce,
            "AllowAlways" => acp::PermissionOptionKind::AllowAlways,
            "RejectOnce" => acp::PermissionOptionKind::RejectOnce,
            "RejectAlways" => acp::PermissionOptionKind::RejectAlways,
            _ => acp::PermissionOptionKind::AllowOnce,
        };

        let session_id = self.thread.read(cx).session_id().clone();
        self.authorize_tool_call(
            session_id,
            tool_call_id,
            SelectedPermissionOutcome::new(option_id, option_kind),
            window,
            cx,
        );
    }

    pub fn handle_select_permission_granularity(
        &mut self,
        action: &SelectPermissionGranularity,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tool_call_id = acp::ToolCallId::new(action.tool_call_id.clone());
        self.permission_selections
            .insert(tool_call_id, PermissionSelection::Choice(action.index));

        cx.notify();
    }

    pub fn handle_toggle_command_pattern(
        &mut self,
        action: &crate::ToggleCommandPattern,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tool_call_id = acp::ToolCallId::new(action.tool_call_id.clone());

        match self.permission_selections.get_mut(&tool_call_id) {
            Some(PermissionSelection::SelectedPatterns(checked)) => {
                // Already in pattern mode — toggle the individual pattern.
                if let Some(pos) = checked.iter().position(|&i| i == action.pattern_index) {
                    checked.swap_remove(pos);
                } else {
                    checked.push(action.pattern_index);
                }
            }
            _ => {
                // First click: activate "Select options" with all patterns checked.
                let thread = self.thread.read(cx);
                let pattern_count = thread
                    .entries()
                    .iter()
                    .find_map(|entry| {
                        if let AgentThreadEntry::ToolCall(call) = entry {
                            if call.id == tool_call_id {
                                if let ToolCallStatus::WaitingForConfirmation { options, .. } =
                                    &call.status
                                {
                                    if let PermissionOptions::DropdownWithPatterns {
                                        patterns,
                                        ..
                                    } = options
                                    {
                                        return Some(patterns.len());
                                    }
                                }
                            }
                        }
                        None
                    })
                    .unwrap_or(0);
                self.permission_selections.insert(
                    tool_call_id,
                    PermissionSelection::SelectedPatterns((0..pattern_count).collect()),
                );
            }
        }
        cx.notify();
    }

    fn authorize_pending_with_granularity(
        &mut self,
        is_allow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<()> {
        let session_id = self.thread.read(cx).session_id().clone();
        let (returned_session_id, tool_call_id, _) = self
            .conversation
            .read(cx)
            .pending_tool_call(&session_id, cx)?;
        self.authorize_with_granularity(returned_session_id, tool_call_id, is_allow, window, cx)
    }

    fn authorize_with_granularity(
        &mut self,
        session_id: acp::SessionId,
        tool_call_id: acp::ToolCallId,
        is_allow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<()> {
        let selection = self.permission_selections.get(&tool_call_id).cloned();
        let result = self.conversation.update(cx, |conversation, cx| {
            conversation.authorize_with_granularity(
                session_id,
                tool_call_id,
                selection.as_ref(),
                is_allow,
                cx,
            )
        });
        if self.should_be_following {
            self.workspace
                .update(cx, |workspace, cx| {
                    workspace.follow(CollaboratorId::Agent, window, cx);
                })
                .ok();
        }
        cx.notify();
        result
    }

    // edits

    pub fn keep_all(&mut self, _: &KeepAll, _window: &mut Window, cx: &mut Context<Self>) {
        let thread = &self.thread;
        let telemetry = ActionLogTelemetry::from(thread.read(cx));
        let action_log = thread.read(cx).action_log().clone();
        action_log.update(cx, |action_log, cx| {
            action_log.keep_all_edits(Some(telemetry), cx)
        });
    }

    pub fn reject_all(&mut self, _: &RejectAll, _window: &mut Window, cx: &mut Context<Self>) {
        let thread = &self.thread;
        let telemetry = ActionLogTelemetry::from(thread.read(cx));
        let action_log = thread.read(cx).action_log().clone();
        let has_changes = action_log.read(cx).changed_buffers(cx).len() > 0;

        action_log
            .update(cx, |action_log, cx| {
                action_log.reject_all_edits(Some(telemetry), cx)
            })
            .detach();

        if has_changes {
            if let Some(workspace) = self.workspace.upgrade() {
                workspace.update(cx, |workspace, cx| {
                    crate::ui::show_undo_reject_toast(workspace, action_log, cx);
                });
            }
        }
    }

    pub fn undo_last_reject(
        &mut self,
        _: &UndoLastReject,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thread = &self.thread;
        let action_log = thread.read(cx).action_log().clone();
        action_log
            .update(cx, |action_log, cx| action_log.undo_last_reject(cx))
            .detach()
    }

    pub fn open_edited_buffer(
        &mut self,
        buffer: &Entity<Buffer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thread = &self.thread;

        let Some(diff) =
            AgentDiffPane::deploy(thread.clone(), self.workspace.clone(), window, cx).log_err()
        else {
            return;
        };

        diff.update(cx, |diff, cx| {
            diff.move_to_path(PathKey::for_buffer(buffer, cx), window, cx)
        })
    }

    // thread stuff

    fn share_thread(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some((thread, project)) = self.as_native_thread(cx).zip(self.project.upgrade()) else {
            return;
        };

        let client = project.read(cx).client();
        let workspace = self.workspace.clone();
        let session_id = thread.read(cx).id().to_string();

        let load_task = thread.read(cx).to_db(cx);

        cx.spawn(async move |_this, cx| {
            let db_thread = load_task.await;

            let shared_thread = SharedThread::from_db_thread(&db_thread);
            let thread_data = shared_thread.to_bytes()?;
            let title = shared_thread.title.to_string();

            client
                .request(proto::ShareAgentThread {
                    session_id: session_id.clone(),
                    title,
                    thread_data,
                })
                .await?;

            let share_url = client::zed_urls::shared_agent_thread_url(&session_id);

            cx.update(|cx| {
                if let Some(workspace) = workspace.upgrade() {
                    workspace.update(cx, |workspace, cx| {
                        struct ThreadSharedToast;
                        workspace.show_toast(
                            Toast::new(
                                NotificationId::unique::<ThreadSharedToast>(),
                                "Thread shared!",
                            )
                            .on_click(
                                "Copy URL",
                                move |_window, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        share_url.clone(),
                                    ));
                                },
                            ),
                            cx,
                        );
                    });
                }
            });

            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
    }

    pub fn sync_thread(
        &mut self,
        project: Entity<Project>,
        server_view: Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.is_imported_thread(cx) {
            return;
        }

        let Some(session_list) = self
            .as_native_connection(cx)
            .and_then(|connection| connection.session_list(cx))
            .and_then(|list| list.downcast::<NativeAgentSessionList>())
        else {
            return;
        };
        let thread_store = session_list.thread_store().clone();

        let client = project.read(cx).client();
        let session_id = self.thread.read(cx).session_id().clone();
        cx.spawn_in(window, async move |this, cx| {
            let response = client
                .request(proto::GetSharedAgentThread {
                    session_id: session_id.to_string(),
                })
                .await?;

            let shared_thread = SharedThread::from_bytes(&response.thread_data)?;

            let db_thread = shared_thread.to_db_thread();

            thread_store
                .update(&mut cx.clone(), |store, cx| {
                    store.save_thread(session_id.clone(), db_thread, Default::default(), cx)
                })
                .await?;

            server_view.update_in(cx, |server_view, window, cx| server_view.reset(window, cx))?;

            this.update_in(cx, |this, _window, cx| {
                if let Some(workspace) = this.workspace.upgrade() {
                    workspace.update(cx, |workspace, cx| {
                        struct ThreadSyncedToast;
                        workspace.show_toast(
                            Toast::new(
                                NotificationId::unique::<ThreadSyncedToast>(),
                                "Thread synced with latest version",
                            )
                            .autohide(),
                            cx,
                        );
                    });
                }
            })?;

            anyhow::Ok(())
        })
        .detach_and_log_err(cx);
    }

    pub fn restore_checkpoint(&mut self, message_id: &UserMessageId, cx: &mut Context<Self>) {
        self.thread
            .update(cx, |thread, cx| {
                thread.restore_checkpoint(message_id.clone(), cx)
            })
            .detach_and_log_err(cx);
    }

    pub fn clear_thread_error(&mut self, cx: &mut Context<Self>) {
        self.thread_error = None;
        self.thread_error_markdown = None;
        self.token_limit_callout_dismissed = true;
        cx.notify();
    }

    fn is_following(&self, cx: &App) -> bool {
        match self.thread.read(cx).status() {
            ThreadStatus::Generating => self
                .workspace
                .read_with(cx, |workspace, _| {
                    workspace.is_being_followed(CollaboratorId::Agent)
                })
                .unwrap_or(false),
            _ => self.should_be_following,
        }
    }

    fn toggle_following(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let following = self.is_following(cx);

        self.should_be_following = !following;
        if self.thread.read(cx).status() == ThreadStatus::Generating {
            self.workspace
                .update(cx, |workspace, cx| {
                    if following {
                        workspace.unfollow(CollaboratorId::Agent, window, cx);
                    } else {
                        workspace.follow(CollaboratorId::Agent, window, cx);
                    }
                })
                .ok();
        }

        telemetry::event!("Follow Agent Selected", following = !following);
    }

    // other

    pub fn render_thread_retry_status_callout(&self) -> Option<Callout> {
        let state = self.thread_retry_status.as_ref()?;

        let next_attempt_in = state
            .duration
            .saturating_sub(Instant::now().saturating_duration_since(state.started_at));
        if next_attempt_in.is_zero() {
            return None;
        }

        let next_attempt_in_secs = next_attempt_in.as_secs() + 1;

        let retry_message = if state.max_attempts == 1 {
            if next_attempt_in_secs == 1 {
                "Retrying. Next attempt in 1 second.".to_string()
            } else {
                format!("Retrying. Next attempt in {next_attempt_in_secs} seconds.")
            }
        } else if next_attempt_in_secs == 1 {
            format!(
                "Retrying. Next attempt in 1 second (Attempt {} of {}).",
                state.attempt, state.max_attempts,
            )
        } else {
            format!(
                "Retrying. Next attempt in {next_attempt_in_secs} seconds (Attempt {} of {}).",
                state.attempt, state.max_attempts,
            )
        };

        Some(
            Callout::new()
                .icon(IconName::Warning)
                .severity(Severity::Warning)
                .title(state.last_error.clone())
                .description(retry_message),
        )
    }

    fn activity_bar_bg(&self, cx: &Context<Self>) -> Hsla {
        let colors = cx.theme().colors();
        let editor_bg_color = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.62));
        let active_color = cx.theme().colors().element_selected;
        editor_bg_color.blend(active_color.opacity(0.3))
    }

    pub fn render_activity_bar(
        &self,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        let thread = self.thread.read(cx);
        let action_log = thread.action_log();
        let telemetry = ActionLogTelemetry::from(thread);
        let changed_buffers = action_log.read(cx).changed_buffers(cx);
        let plan = thread.plan();
        let queue_is_empty = !self.has_queued_messages();
        let is_generating = matches!(thread.status(), ThreadStatus::Generating);
        let show_static_edits =
            is_generating && !changed_buffers.is_empty() && thread.parent_session_id().is_none();

        let subagents_awaiting_permission = self.render_subagents_awaiting_permission(cx);
        let has_subagents_awaiting = subagents_awaiting_permission.is_some();

        if !show_static_edits && plan.is_empty() && queue_is_empty && !has_subagents_awaiting {
            return None;
        }

        // Temporarily always enable ACP edit controls. This is temporary, to lessen the
        // impact of a nasty bug that causes them to sometimes be disabled when they shouldn't
        // be, which blocks you from being able to accept or reject edits. This switches the
        // bug to be that sometimes it's enabled when it shouldn't be, which at least doesn't
        // block you from using the panel.
        let pending_edits = false;

        let plan_expanded = self.plan_expanded;
        let edits_expanded = self.edits_expanded;
        let queue_expanded = self.queue_expanded;

        let max_content_width = AgentSettings::get_global(cx).max_content_width;

        h_flex()
            .w_full()
            .px_2()
            .justify_center()
            .child(
                v_flex()
                    .when_some(max_content_width, |this, max_w| this.flex_basis(max_w))
                    .when(max_content_width.is_none(), |this| this.w_full())
                    .flex_shrink()
                    .flex_grow_0()
                    .max_w_full()
                    .bg(self.activity_bar_bg(cx))
                    .border_1()
                    .border_b_0()
                    .border_color(cx.theme().colors().border_variant.opacity(0.68))
                    .rounded_t_md()
                    .shadow(vec![gpui::BoxShadow {
                        color: cx.theme().colors().border_variant.opacity(0.5),
                        offset: point(px(1.), px(-1.)),
                        blur_radius: px(2.),
                        spread_radius: px(0.),
                    }])
                    .when_some(subagents_awaiting_permission, |this, element| {
                        this.child(element)
                    })
                    .when(
                        has_subagents_awaiting
                            && (!plan.is_empty() || show_static_edits || !queue_is_empty),
                        |this| this.child(Divider::horizontal().color(DividerColor::Border)),
                    )
                    .when(!plan.is_empty(), |this| {
                        this.child(self.render_plan_summary(plan, window, cx))
                            .when(plan_expanded, |parent| {
                                parent.child(self.render_plan_entries(plan, window, cx))
                            })
                    })
                    .when(!plan.is_empty() && show_static_edits, |this| {
                        this.child(Divider::horizontal().color(DividerColor::Border))
                    })
                    .when(show_static_edits, |this| {
                        this.child(self.render_edits_summary(
                            &changed_buffers,
                            edits_expanded,
                            pending_edits,
                            cx,
                        ))
                        .when(edits_expanded, |parent| {
                            parent.child(self.render_edited_files(
                                action_log,
                                telemetry.clone(),
                                &changed_buffers,
                                pending_edits,
                                cx,
                            ))
                        })
                    })
                    .when(!queue_is_empty, |this| {
                        this.when(!plan.is_empty() || show_static_edits, |this| {
                            this.child(Divider::horizontal().color(DividerColor::Border))
                        })
                        .child(self.render_message_queue_summary(window, cx))
                        .when(queue_expanded, |parent| {
                            parent.child(self.render_message_queue_entries(window, cx))
                        })
                    }),
            )
            .into_any()
            .into()
    }

    fn render_final_edits_section(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let thread = self.thread.read(cx);
        if matches!(thread.status(), ThreadStatus::Generating)
            || thread.parent_session_id().is_some()
        {
            return None;
        }

        let action_log = thread.action_log();
        let telemetry = ActionLogTelemetry::from(thread);
        let changed_buffers = action_log.read(cx).changed_buffers(cx);
        if changed_buffers.is_empty() {
            return None;
        }

        // Keep ACP edit controls enabled, matching the static activity bar behavior.
        let pending_edits = false;
        let edits_expanded = self.edits_expanded;

        Some(
            v_flex()
                .px(rems_from_px(14.))
                .pt_1()
                .pb_3()
                .child(
                    v_flex()
                        .w_full()
                        .rounded_md()
                        .border_1()
                        .border_color(cx.theme().colors().border_variant.opacity(0.68))
                        .bg(self.activity_bar_bg(cx))
                        .overflow_hidden()
                        .child(self.render_edits_summary(
                            &changed_buffers,
                            edits_expanded,
                            pending_edits,
                            cx,
                        ))
                        .when(edits_expanded, |parent| {
                            parent.child(self.render_edited_files(
                                action_log,
                                telemetry,
                                &changed_buffers,
                                pending_edits,
                                cx,
                            ))
                        }),
                )
                .into_any_element(),
        )
    }

    fn render_edited_files(
        &self,
        action_log: &Entity<ActionLog>,
        telemetry: ActionLogTelemetry,
        changed_buffers: &BTreeMap<Entity<Buffer>, Entity<BufferDiff>>,
        pending_edits: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let editor_bg_color = cx.theme().colors().editor_background;

        // Sort edited files alphabetically for consistency with Git diff view
        let mut sorted_buffers: Vec<_> = changed_buffers.iter().collect();
        sorted_buffers.sort_by(|(buffer_a, _), (buffer_b, _)| {
            let path_a = buffer_a.read(cx).file().map(|f| f.path().clone());
            let path_b = buffer_b.read(cx).file().map(|f| f.path().clone());
            path_a.cmp(&path_b)
        });

        v_flex()
            .id("edited_files_list")
            .max_h_40()
            .overflow_y_scroll()
            .child(
                v_flex().children(sorted_buffers.into_iter().enumerate().flat_map(
                    |(index, (buffer, diff))| {
                        let file = buffer.read(cx).file()?;
                        let path = file.path();
                        let path_style = file.path_style(cx);
                        let separator = file.path_style(cx).primary_separator();

                        let file_path = path.parent().and_then(|parent| {
                            if parent.is_empty() {
                                None
                            } else {
                                Some(
                                    Label::new(format!(
                                        "{}{separator}",
                                        parent.display(path_style)
                                    ))
                                    .color(Color::Muted)
                                    .size(LabelSize::XSmall)
                                    .buffer_font(cx),
                                )
                            }
                        });

                        let file_name = path.file_name().map(|name| {
                            Label::new(name.to_string())
                                .size(LabelSize::XSmall)
                                .buffer_font(cx)
                                .ml_1()
                        });

                        let full_path = path.display(path_style).to_string();

                        let file_icon = FileIcons::get_icon(path.as_std_path(), cx)
                            .map(Icon::from_path)
                            .map(|icon| icon.color(Color::Muted).size(IconSize::Small))
                            .unwrap_or_else(|| {
                                Icon::new(IconName::File)
                                    .color(Color::Muted)
                                    .size(IconSize::Small)
                            });

                        let file_stats = DiffStats::single_file(buffer.read(cx), diff.read(cx), cx);

                        let buttons = self.render_edited_files_buttons(
                            index,
                            buffer,
                            action_log,
                            &telemetry,
                            pending_edits,
                            editor_bg_color,
                            cx,
                        );

                        let element = h_flex()
                            .group("edited-code")
                            .id(("file-container", index))
                            .relative()
                            .min_w_0()
                            .p_1p5()
                            .gap_2()
                            .justify_between()
                            .bg(editor_bg_color)
                            .when(index < changed_buffers.len() - 1, |parent| {
                                parent.border_color(cx.theme().colors().border).border_b_1()
                            })
                            .child(
                                h_flex()
                                    .id(("file-name-path", index))
                                    .cursor_pointer()
                                    .pr_0p5()
                                    .gap_0p5()
                                    .rounded_xs()
                                    .child(file_icon)
                                    .children(file_name)
                                    .children(file_path)
                                    .child(
                                        DiffStat::new(
                                            "file",
                                            file_stats.lines_added as usize,
                                            file_stats.lines_removed as usize,
                                        )
                                        .label_size(LabelSize::XSmall),
                                    )
                                    .hover(|s| s.bg(cx.theme().colors().element_hover))
                                    .tooltip({
                                        move |_, cx| {
                                            Tooltip::with_meta(
                                                "Go to File",
                                                None,
                                                full_path.clone(),
                                                cx,
                                            )
                                        }
                                    })
                                    .on_click({
                                        let buffer = buffer.clone();
                                        cx.listener(move |this, _, window, cx| {
                                            this.open_edited_buffer(&buffer, window, cx);
                                        })
                                    }),
                            )
                            .child(buttons);

                        Some(element)
                    },
                )),
            )
            .into_any_element()
    }

    fn render_edited_files_buttons(
        &self,
        index: usize,
        buffer: &Entity<Buffer>,
        action_log: &Entity<ActionLog>,
        telemetry: &ActionLogTelemetry,
        pending_edits: bool,
        editor_bg_color: Hsla,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .id("edited-buttons-container")
            .visible_on_hover("edited-code")
            .absolute()
            .right_0()
            .px_1()
            .gap_1()
            .bg(editor_bg_color)
            .on_hover(cx.listener(move |this, is_hovered, _window, cx| {
                if *is_hovered {
                    this.hovered_edited_file_buttons = Some(index);
                } else if this.hovered_edited_file_buttons == Some(index) {
                    this.hovered_edited_file_buttons = None;
                }
                cx.notify();
            }))
            .child(
                Button::new("review", "Review")
                    .label_size(LabelSize::Small)
                    .on_click({
                        let buffer = buffer.clone();
                        cx.listener(move |this, _, window, cx| {
                            this.open_edited_buffer(&buffer, window, cx);
                        })
                    }),
            )
            .child(
                Button::new(("reject-file", index), "Reject")
                    .label_size(LabelSize::Small)
                    .disabled(pending_edits)
                    .on_click({
                        let buffer = buffer.clone();
                        let action_log = action_log.clone();
                        let telemetry = telemetry.clone();
                        move |_, _, cx| {
                            action_log.update(cx, |action_log, cx| {
                                action_log
                                    .reject_edits_in_ranges(
                                        buffer.clone(),
                                        vec![Anchor::min_max_range_for_buffer(
                                            buffer.read(cx).remote_id(),
                                        )],
                                        Some(telemetry.clone()),
                                        cx,
                                    )
                                    .0
                                    .detach_and_log_err(cx);
                            })
                        }
                    }),
            )
            .child(
                Button::new(("keep-file", index), "Keep")
                    .label_size(LabelSize::Small)
                    .disabled(pending_edits)
                    .on_click({
                        let buffer = buffer.clone();
                        let action_log = action_log.clone();
                        let telemetry = telemetry.clone();
                        move |_, _, cx| {
                            action_log.update(cx, |action_log, cx| {
                                action_log.keep_edits_in_range(
                                    buffer.clone(),
                                    Anchor::min_max_range_for_buffer(buffer.read(cx).remote_id()),
                                    Some(telemetry.clone()),
                                    cx,
                                );
                            })
                        }
                    }),
            )
    }

    fn collect_subagent_items_for_sessions(
        entries: &[AgentThreadEntry],
        awaiting_session_ids: &[acp::SessionId],
        cx: &App,
    ) -> Vec<(SharedString, usize)> {
        let tool_calls_by_session: HashMap<_, _> = entries
            .iter()
            .enumerate()
            .filter_map(|(entry_ix, entry)| {
                let AgentThreadEntry::ToolCall(tool_call) = entry else {
                    return None;
                };
                let info = tool_call.subagent_session_info.as_ref()?;
                let summary_text = tool_call.label.read(cx).source().to_string();
                let subagent_summary = if summary_text.is_empty() {
                    SharedString::from("Subagent")
                } else {
                    SharedString::from(summary_text)
                };
                Some((info.session_id.clone(), (subagent_summary, entry_ix)))
            })
            .collect();

        awaiting_session_ids
            .iter()
            .filter_map(|session_id| tool_calls_by_session.get(session_id).cloned())
            .collect()
    }

    fn render_subagents_awaiting_permission(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let awaiting = self.conversation.read(cx).subagents_awaiting_permission(cx);

        if awaiting.is_empty() {
            return None;
        }

        let awaiting_session_ids: Vec<_> = awaiting
            .iter()
            .map(|(session_id, _)| session_id.clone())
            .collect();

        let thread = self.thread.read(cx);
        let entries = thread.entries();
        let subagent_items =
            Self::collect_subagent_items_for_sessions(entries, &awaiting_session_ids, cx);

        if subagent_items.is_empty() {
            return None;
        }

        let item_count = subagent_items.len();

        Some(
            v_flex()
                .child(
                    h_flex()
                        .py_1()
                        .px_2()
                        .w_full()
                        .gap_1()
                        .border_b_1()
                        .border_color(cx.theme().colors().border)
                        .child(
                            Label::new("Subagents Awaiting Permission:")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        )
                        .child(Label::new(item_count.to_string()).size(LabelSize::Small)),
                )
                .child(
                    v_flex().children(subagent_items.into_iter().enumerate().map(
                        |(ix, (label, entry_ix))| {
                            let is_last = ix == item_count - 1;
                            let group = format!("group-{}", entry_ix);

                            h_flex()
                                .cursor_pointer()
                                .id(format!("subagent-permission-{}", entry_ix))
                                .group(&group)
                                .p_1()
                                .pl_2()
                                .min_w_0()
                                .w_full()
                                .gap_1()
                                .justify_between()
                                .bg(cx.theme().colors().editor_background)
                                .hover(|s| s.bg(cx.theme().colors().element_hover))
                                .when(!is_last, |this| {
                                    this.border_b_1().border_color(cx.theme().colors().border)
                                })
                                .child(
                                    h_flex()
                                        .gap_1p5()
                                        .child(
                                            Icon::new(IconName::Circle)
                                                .size(IconSize::XSmall)
                                                .color(Color::Warning),
                                        )
                                        .child(
                                            Label::new(label)
                                                .size(LabelSize::Small)
                                                .color(Color::Muted)
                                                .truncate(),
                                        ),
                                )
                                .child(
                                    div().visible_on_hover(&group).child(
                                        Label::new("Scroll to Subagent")
                                            .size(LabelSize::Small)
                                            .color(Color::Muted)
                                            .truncate(),
                                    ),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.list_state.scroll_to(ListOffset {
                                        item_ix: entry_ix,
                                        offset_in_item: px(0.0),
                                    });
                                    cx.notify();
                                }))
                        },
                    )),
                )
                .into_any(),
        )
    }

    fn render_message_queue_summary(
        &self,
        _window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let queue_count = self.local_queued_messages.len();
        let title: SharedString = if queue_count == 1 {
            "1 Queued Message".into()
        } else {
            format!("{} Queued Messages", queue_count).into()
        };

        h_flex()
            .p_1()
            .w_full()
            .gap_1()
            .justify_between()
            .when(self.queue_expanded, |this| {
                this.border_b_1().border_color(cx.theme().colors().border)
            })
            .child(
                h_flex()
                    .id("queue_summary")
                    .gap_1()
                    .child(Disclosure::new("queue_disclosure", self.queue_expanded))
                    .child(Label::new(title).size(LabelSize::Small).color(Color::Muted))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.queue_expanded = !this.queue_expanded;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("clear_queue", "Clear All")
                    .label_size(LabelSize::Small)
                    .key_binding(
                        KeyBinding::for_action(&ClearMessageQueue, cx)
                            .map(|kb| kb.size(rems_from_px(12.))),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.clear_queue(cx);
                        this.can_fast_track_queue = false;
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn clear_queue(&mut self, cx: &mut Context<Self>) {
        self.local_queued_messages.clear();
        self.sync_queue_flag_to_native_thread(cx);
    }

    fn render_plan_summary(
        &self,
        plan: &Plan,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let plan_expanded = self.plan_expanded;
        let stats = plan.stats();

        let title = if let Some(entry) = stats.in_progress_entry
            && !plan_expanded
        {
            h_flex()
                .cursor_default()
                .relative()
                .w_full()
                .gap_1()
                .truncate()
                .child(
                    Label::new("Current:")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().colors().text_muted)
                        .line_clamp(1)
                        .child(MarkdownElement::new(
                            entry.content.clone(),
                            plan_label_markdown_style(&entry.status, window, cx),
                        )),
                )
                .when(stats.pending > 0, |this| {
                    this.child(
                        h_flex()
                            .absolute()
                            .top_0()
                            .right_0()
                            .h_full()
                            .child(div().min_w_8().h_full().bg(linear_gradient(
                                90.,
                                linear_color_stop(self.activity_bar_bg(cx), 1.),
                                linear_color_stop(self.activity_bar_bg(cx).opacity(0.2), 0.),
                            )))
                            .child(
                                div().pr_0p5().bg(self.activity_bar_bg(cx)).child(
                                    Label::new(format!("{} left", stats.pending))
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                            ),
                    )
                })
        } else {
            let status_label = if stats.pending == 0 {
                "All Done".to_string()
            } else if stats.completed == 0 {
                format!("{} Tasks", plan.entries.len())
            } else {
                format!("{}/{}", stats.completed, plan.entries.len())
            };

            h_flex()
                .w_full()
                .gap_1()
                .justify_between()
                .child(
                    Label::new("Plan")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .child(
                    Label::new(status_label)
                        .size(LabelSize::Small)
                        .color(Color::Muted)
                        .mr_1(),
                )
        };

        h_flex()
            .id("plan_summary")
            .p_1()
            .w_full()
            .gap_1()
            .when(plan_expanded, |this| {
                this.border_b_1().border_color(cx.theme().colors().border)
            })
            .child(Disclosure::new("plan_disclosure", plan_expanded))
            .child(title.flex_1())
            .child(
                IconButton::new("dismiss-plan", IconName::Close)
                    .icon_size(IconSize::XSmall)
                    .shape(ui::IconButtonShape::Square)
                    .tooltip(Tooltip::text("Clear Plan"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.thread.update(cx, |thread, cx| thread.clear_plan(cx));
                        cx.stop_propagation();
                    })),
            )
            .on_click(cx.listener(|this, _, _, cx| {
                this.plan_expanded = !this.plan_expanded;
                cx.notify();
            }))
            .into_any_element()
    }

    fn render_plan_entries(
        &self,
        plan: &Plan,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .id("plan_items_list")
            .max_h_40()
            .overflow_y_scroll()
            .child(
                v_flex().children(plan.entries.iter().enumerate().flat_map(|(index, entry)| {
                    let entry_bg = cx.theme().colors().editor_background;
                    let tooltip_text: SharedString =
                        entry.content.read(cx).source().to_string().into();

                    Some(
                        h_flex()
                            .id(("plan_entry_row", index))
                            .py_1()
                            .px_2()
                            .gap_2()
                            .justify_between()
                            .relative()
                            .bg(entry_bg)
                            .when(index < plan.entries.len() - 1, |parent| {
                                parent.border_color(cx.theme().colors().border).border_b_1()
                            })
                            .overflow_hidden()
                            .child(
                                h_flex()
                                    .id(("plan_entry", index))
                                    .gap_1p5()
                                    .min_w_0()
                                    .text_xs()
                                    .text_color(cx.theme().colors().text_muted)
                                    .child(match entry.status {
                                        acp::PlanEntryStatus::InProgress => {
                                            Icon::new(IconName::TodoProgress)
                                                .size(IconSize::Small)
                                                .color(Color::Accent)
                                                .with_rotate_animation(2)
                                                .into_any_element()
                                        }
                                        acp::PlanEntryStatus::Completed => {
                                            Icon::new(IconName::TodoComplete)
                                                .size(IconSize::Small)
                                                .color(Color::Success)
                                                .into_any_element()
                                        }
                                        acp::PlanEntryStatus::Pending | _ => {
                                            Icon::new(IconName::TodoPending)
                                                .size(IconSize::Small)
                                                .color(Color::Muted)
                                                .into_any_element()
                                        }
                                    })
                                    .child(MarkdownElement::new(
                                        entry.content.clone(),
                                        plan_label_markdown_style(&entry.status, window, cx),
                                    )),
                            )
                            .child(div().absolute().top_0().right_0().h_full().w_8().bg(
                                linear_gradient(
                                    90.,
                                    linear_color_stop(entry_bg, 1.),
                                    linear_color_stop(entry_bg.opacity(0.), 0.),
                                ),
                            ))
                            .tooltip(Tooltip::text(tooltip_text)),
                    )
                })),
            )
            .into_any_element()
    }

    fn render_completed_plan(
        &self,
        entries: &[PlanEntry],
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        v_flex()
            .px(rems_from_px(14.))
            .py_1p5()
            .w_full()
            .child(
                v_flex()
                    .w_full()
                    .rounded_md()
                    .border_1()
                    .border_color(self.tool_card_border_color(cx))
                    .child(
                        h_flex()
                            .px_2()
                            .py_1()
                            .gap_1()
                            .bg(self.tool_card_header_bg(cx))
                            .border_b_1()
                            .border_color(self.tool_card_border_color(cx))
                            .child(
                                Label::new("Completed Plan")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(
                                Label::new(format!(
                                    "— {} {}",
                                    entries.len(),
                                    if entries.len() == 1 { "step" } else { "steps" }
                                ))
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                            ),
                    )
                    .child(
                        v_flex().children(entries.iter().enumerate().map(|(index, entry)| {
                            h_flex()
                                .py_1()
                                .px_2()
                                .gap_1p5()
                                .when(index < entries.len() - 1, |this| {
                                    this.border_b_1().border_color(cx.theme().colors().border)
                                })
                                .child(
                                    Icon::new(IconName::TodoComplete)
                                        .size(IconSize::Small)
                                        .color(Color::Success),
                                )
                                .child(
                                    div()
                                        .max_w_full()
                                        .overflow_x_hidden()
                                        .text_xs()
                                        .text_color(cx.theme().colors().text_muted)
                                        .child(MarkdownElement::new(
                                            entry.content.clone(),
                                            default_markdown_style(window, cx),
                                        )),
                                )
                        })),
                    ),
            )
            .into_any()
    }

    fn render_edits_summary(
        &self,
        changed_buffers: &BTreeMap<Entity<Buffer>, Entity<BufferDiff>>,
        expanded: bool,
        pending_edits: bool,
        cx: &Context<Self>,
    ) -> Div {
        const EDIT_NOT_READY_TOOLTIP_LABEL: &str = "Wait until file edits are complete.";

        let focus_handle = self.focus_handle(cx);

        h_flex()
            .p_1()
            .justify_between()
            .flex_wrap()
            .when(expanded, |this| {
                this.border_b_1().border_color(cx.theme().colors().border)
            })
            .child(
                h_flex()
                    .id("edits-container")
                    .cursor_pointer()
                    .gap_1()
                    .child(Disclosure::new("edits-disclosure", expanded))
                    .map(|this| {
                        if pending_edits {
                            this.child(
                                Label::new(format!(
                                    "Editing {} {}…",
                                    changed_buffers.len(),
                                    if changed_buffers.len() == 1 {
                                        "file"
                                    } else {
                                        "files"
                                    }
                                ))
                                .color(Color::Muted)
                                .size(LabelSize::Small)
                                .with_animation(
                                    "edit-label",
                                    Animation::new(Duration::from_secs(2))
                                        .repeat()
                                        .with_easing(pulsating_between(0.3, 0.7)),
                                    |label, delta| label.alpha(delta),
                                ),
                            )
                        } else {
                            let stats = DiffStats::all_files(changed_buffers, cx);
                            let dot_divider = || {
                                Label::new("•")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Disabled)
                            };

                            this.child(
                                Label::new("Edits")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            )
                            .child(dot_divider())
                            .child(
                                Label::new(format!(
                                    "{} {}",
                                    changed_buffers.len(),
                                    if changed_buffers.len() == 1 {
                                        "file"
                                    } else {
                                        "files"
                                    }
                                ))
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                            )
                            .child(dot_divider())
                            .child(DiffStat::new(
                                "total",
                                stats.lines_added as usize,
                                stats.lines_removed as usize,
                            ))
                        }
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.edits_expanded = !this.edits_expanded;
                        cx.notify();
                    })),
            )
            .child(
                h_flex()
                    .gap_1()
                    .child(
                        IconButton::new("review-changes", IconName::ListTodo)
                            .icon_size(IconSize::Small)
                            .tooltip({
                                let focus_handle = focus_handle.clone();
                                move |_window, cx| {
                                    Tooltip::for_action_in(
                                        "Review Changes",
                                        &OpenAgentDiff,
                                        &focus_handle,
                                        cx,
                                    )
                                }
                            })
                            .on_click(cx.listener(|_, _, window, cx| {
                                window.dispatch_action(OpenAgentDiff.boxed_clone(), cx);
                            })),
                    )
                    .child(Divider::vertical().color(DividerColor::Border))
                    .child(
                        Button::new("reject-all-changes", "Reject All")
                            .label_size(LabelSize::Small)
                            .disabled(pending_edits)
                            .when(pending_edits, |this| {
                                this.tooltip(Tooltip::text(EDIT_NOT_READY_TOOLTIP_LABEL))
                            })
                            .key_binding(
                                KeyBinding::for_action_in(&RejectAll, &focus_handle.clone(), cx)
                                    .map(|kb| kb.size(rems_from_px(12.))),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.reject_all(&RejectAll, window, cx);
                            })),
                    )
                    .child(
                        Button::new("keep-all-changes", "Keep All")
                            .label_size(LabelSize::Small)
                            .disabled(pending_edits)
                            .when(pending_edits, |this| {
                                this.tooltip(Tooltip::text(EDIT_NOT_READY_TOOLTIP_LABEL))
                            })
                            .key_binding(
                                KeyBinding::for_action_in(&KeepAll, &focus_handle, cx)
                                    .map(|kb| kb.size(rems_from_px(12.))),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.keep_all(&KeepAll, window, cx);
                            })),
                    ),
            )
    }

    fn is_subagent_canceled_or_failed(&self, cx: &App) -> bool {
        let Some(parent_session_id) = self.parent_session_id.as_ref() else {
            return false;
        };

        let my_session_id = self.thread.read(cx).session_id().clone();

        self.server_view
            .upgrade()
            .and_then(|sv| sv.read(cx).thread_view(parent_session_id))
            .is_some_and(|parent_view| {
                parent_view
                    .read(cx)
                    .thread
                    .read(cx)
                    .tool_call_for_subagent(&my_session_id)
                    .is_some_and(|tc| {
                        matches!(
                            tc.status,
                            ToolCallStatus::Canceled
                                | ToolCallStatus::Failed
                                | ToolCallStatus::Rejected
                        )
                    })
            })
    }

    pub(crate) fn render_subagent_titlebar(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        if self.parent_session_id.is_none() {
            return None;
        }
        let parent_session_id = self.thread.read(cx).parent_session_id()?.clone();

        let server_view = self.server_view.clone();
        let thread = self.thread.clone();
        let is_done = thread.read(cx).status() == ThreadStatus::Idle;
        let is_canceled_or_failed = self.is_subagent_canceled_or_failed(cx);

        let max_content_width = AgentSettings::get_global(cx).max_content_width;

        Some(
            h_flex()
                .w_full()
                .h(Tab::container_height(cx))
                .border_b_1()
                .when(is_done && is_canceled_or_failed, |this| {
                    this.border_dashed()
                })
                .border_color(cx.theme().colors().border)
                .bg(cx.theme().colors().editor_background.opacity(0.2))
                .child(
                    h_flex()
                        .size_full()
                        .when_some(max_content_width, |this, max_w| this.max_w(max_w).mx_auto())
                        .pl_2()
                        .pr_1()
                        .flex_shrink_0()
                        .justify_between()
                        .gap_1()
                        .child(
                            h_flex()
                                .flex_1()
                                .gap_2()
                                .child(
                                    Icon::new(IconName::ForwardArrowUp)
                                        .size(IconSize::Small)
                                        .color(Color::Muted),
                                )
                                .child(self.title_editor.clone())
                                .when(is_done && is_canceled_or_failed, |this| {
                                    this.child(Icon::new(IconName::Close).color(Color::Error))
                                })
                                .when(is_done && !is_canceled_or_failed, |this| {
                                    this.child(Icon::new(IconName::Check).color(Color::Success))
                                }),
                        )
                        .child(
                            h_flex()
                                .gap_0p5()
                                .when(!is_done, |this| {
                                    this.child(
                                        IconButton::new("stop_subagent", IconName::Stop)
                                            .icon_size(IconSize::Small)
                                            .icon_color(Color::Error)
                                            .tooltip(Tooltip::text("Stop Subagent"))
                                            .on_click(move |_, _, cx| {
                                                thread.update(cx, |thread, cx| {
                                                    thread.cancel(cx).detach();
                                                });
                                            }),
                                    )
                                })
                                .child(
                                    IconButton::new("minimize_subagent", IconName::Dash)
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Minimize Subagent"))
                                        .on_click(move |_, window, cx| {
                                            let _ = server_view.update(cx, |server_view, cx| {
                                                server_view.navigate_to_thread(
                                                    parent_session_id.clone(),
                                                    window,
                                                    cx,
                                                );
                                            });
                                        }),
                                ),
                        ),
                ),
        )
    }

    pub(crate) fn render_message_editor(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_message_editor_with_container(window, cx, true)
    }

    pub(crate) fn render_message_editor_embedded(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_message_editor_with_container(window, cx, false)
    }

    fn render_message_editor_with_container(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        include_container: bool,
    ) -> AnyElement {
        if self.is_subagent() {
            return div().into_any_element();
        }

        let focus_handle = self.message_editor.focus_handle(cx);
        let colors = cx.theme().colors();
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

        let editor_expanded = self.editor_expanded;
        let (expand_icon, expand_tooltip) = if editor_expanded {
            (IconName::Minimize, "Minimize Message Editor")
        } else {
            (IconName::Maximize, "Expand Message Editor")
        };

        let has_messages = self.list_state.item_count() > 0;
        let fills_container = editor_expanded;

        let editor = v_flex()
            .w_full()
            .max_w_full()
            .when(fills_container, |this| this.h_full())
            .flex_shrink()
            .flex_grow()
            .justify_between()
            .map(|this| {
                if has_messages {
                    this.on_action(cx.listener(Self::expand_message_editor))
                        .when(editor_expanded, |this| this.h(vh(0.8, window)))
                } else {
                    this
                }
            })
            .child(
                v_flex()
                    .relative()
                    .w_full()
                    .min_h(px(92.))
                    .when(fills_container, |this| this.flex_1())
                    .px_3()
                    .pt_2()
                    .pb_1p5()
                    .when(include_container, |this| {
                        this.rounded_lg()
                            .border_1()
                            .border_color(composer_border)
                            .hover(|style| style.border_color(colors.border_variant.opacity(0.62)))
                            .bg(composer_surface_bg)
                            .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
                    })
                    .track_focus(&focus_handle)
                    .child(self.message_editor.clone())
                    .when(has_messages, |this| {
                        this.child(
                            h_flex()
                                .absolute()
                                .top_0()
                                .right_0()
                                .opacity(0.5)
                                .hover(|s| s.opacity(1.0))
                                .child(
                                    IconButton::new("toggle-height", expand_icon)
                                        .icon_size(IconSize::Small)
                                        .icon_color(Color::Muted)
                                        .tooltip({
                                            move |_window, cx| {
                                                Tooltip::for_action_in(
                                                    expand_tooltip,
                                                    &ExpandMessageEditor,
                                                    &focus_handle,
                                                    cx,
                                                )
                                            }
                                        })
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.expand_message_editor(
                                                &ExpandMessageEditor,
                                                window,
                                                cx,
                                            );
                                        })),
                                ),
                        )
                    })
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
                                h_flex()
                                    .min_w_0()
                                    .flex_1()
                                    .overflow_hidden()
                                    .items_center()
                                    .gap_1()
                                    .child(self.render_add_context_button(cx))
                                    .map(|this| {
                                        if let Some(model_selector) = self.model_selector.clone() {
                                            this.child(model_selector)
                                        } else if self.agent_display_name.as_ref() == "Backboard" {
                                            this.child(self.render_backboard_footer_status(cx))
                                        } else {
                                            this.children(self.render_selected_model_readout(cx))
                                        }
                                    }),
                            )
                            .child(
                                h_flex()
                                    .flex_none()
                                    .flex_wrap()
                                    .items_center()
                                    .justify_end()
                                    .gap_1()
                                    .child(self.render_dictation_button(cx))
                                    .when(include_container, |this| {
                                        this.child(self.render_follow_toggle(cx))
                                    })
                                    .children(self.render_fast_mode_control(cx))
                                    .children(self.render_thinking_control(cx))
                                    .children(self.render_token_usage(cx))
                                    .children(self.render_skills_options_button(cx))
                                    .children(self.render_session_options_button(cx))
                                    .child(self.render_send_button(cx)),
                            ),
                    ),
            );

        if !include_container {
            return editor.into_any();
        }

        h_flex()
            .px_2()
            .pt_1()
            .pb_1p5()
            .bg(editor_bg_color)
            .justify_center()
            .child(editor)
            .into_any()
    }

    fn render_message_queue_entries(
        &self,
        _window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let message_editor = self.message_editor.read(cx);
        let focus_handle = message_editor.focus_handle(cx);

        let queued_message_editors = &self.queued_message_editors;
        let queue_len = queued_message_editors.len();
        let can_fast_track = self.can_fast_track_queue && queue_len > 0;

        v_flex()
            .id("message_queue_list")
            .max_h_40()
            .overflow_y_scroll()
            .children(
                queued_message_editors
                    .iter()
                    .enumerate()
                    .map(|(index, editor)| {
                        let is_next = index == 0;
                        let (icon_color, tooltip_text) = if is_next {
                            (Color::Accent, "Next in Queue")
                        } else {
                            (Color::Muted, "In Queue")
                        };

                        let editor_focused = editor.focus_handle(cx).is_focused(_window);
                        let keybinding_size = rems_from_px(12.);

                        h_flex()
                            .group("queue_entry")
                            .w_full()
                            .p_1p5()
                            .gap_1()
                            .bg(cx.theme().colors().editor_background)
                            .when(index < queue_len - 1, |this| {
                                this.border_b_1()
                                    .border_color(cx.theme().colors().border_variant)
                            })
                            .child(
                                div()
                                    .id("next_in_queue")
                                    .child(
                                        Icon::new(IconName::Circle)
                                            .size(IconSize::Small)
                                            .color(icon_color),
                                    )
                                    .tooltip(Tooltip::text(tooltip_text)),
                            )
                            .child(editor.clone())
                            .child(if editor_focused {
                                h_flex()
                                    .gap_1()
                                    .min_w(rems_from_px(150.))
                                    .justify_end()
                                    .child(
                                        IconButton::new(("edit", index), IconName::Pencil)
                                            .icon_size(IconSize::Small)
                                            .tooltip(|_window, cx| {
                                                Tooltip::with_meta(
                                                    "Edit Queued Message",
                                                    None,
                                                    "Type anything to edit",
                                                    cx,
                                                )
                                            })
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.move_queued_message_to_main_editor(
                                                    index, None, None, window, cx,
                                                );
                                            })),
                                    )
                                    .child(
                                        Button::new(("send_now_focused", index), "Send Now")
                                            .label_size(LabelSize::Small)
                                            .style(ButtonStyle::Outlined)
                                            .key_binding(
                                                KeyBinding::for_action_in(
                                                    &SendImmediately,
                                                    &editor.focus_handle(cx),
                                                    cx,
                                                )
                                                .map(|kb| kb.size(keybinding_size)),
                                            )
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.send_queued_message_at_index(
                                                    index, true, window, cx,
                                                );
                                            })),
                                    )
                            } else {
                                h_flex()
                                    .when(!is_next, |this| this.visible_on_hover("queue_entry"))
                                    .gap_1()
                                    .min_w(rems_from_px(150.))
                                    .justify_end()
                                    .child(
                                        IconButton::new(("delete", index), IconName::Trash)
                                            .icon_size(IconSize::Small)
                                            .tooltip({
                                                let focus_handle = focus_handle.clone();
                                                move |_window, cx| {
                                                    if is_next {
                                                        Tooltip::for_action_in(
                                                            "Remove Message from Queue",
                                                            &RemoveFirstQueuedMessage,
                                                            &focus_handle,
                                                            cx,
                                                        )
                                                    } else {
                                                        Tooltip::simple(
                                                            "Remove Message from Queue",
                                                            cx,
                                                        )
                                                    }
                                                }
                                            })
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.remove_from_queue(index, cx);
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        IconButton::new(("edit", index), IconName::Pencil)
                                            .icon_size(IconSize::Small)
                                            .tooltip({
                                                let focus_handle = focus_handle.clone();
                                                move |_window, cx| {
                                                    if is_next {
                                                        Tooltip::for_action_in(
                                                            "Edit",
                                                            &EditFirstQueuedMessage,
                                                            &focus_handle,
                                                            cx,
                                                        )
                                                    } else {
                                                        Tooltip::simple("Edit", cx)
                                                    }
                                                }
                                            })
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.move_queued_message_to_main_editor(
                                                    index, None, None, window, cx,
                                                );
                                            })),
                                    )
                                    .child(
                                        Button::new(("send_now", index), "Send Now")
                                            .label_size(LabelSize::Small)
                                            .when(is_next, |this| this.style(ButtonStyle::Outlined))
                                            .when(is_next && message_editor.is_empty(cx), |this| {
                                                let action: Box<dyn gpui::Action> =
                                                    if can_fast_track {
                                                        Box::new(Chat)
                                                    } else {
                                                        Box::new(SendNextQueuedMessage)
                                                    };

                                                this.key_binding(
                                                    KeyBinding::for_action_in(
                                                        action.as_ref(),
                                                        &focus_handle.clone(),
                                                        cx,
                                                    )
                                                    .map(|kb| kb.size(keybinding_size)),
                                                )
                                            })
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.send_queued_message_at_index(
                                                    index, true, window, cx,
                                                );
                                            })),
                                    )
                            })
                    }),
            )
            .into_any_element()
    }

    fn supports_split_token_display(&self, cx: &App) -> bool {
        self.as_native_thread(cx)
            .and_then(|thread| thread.read(cx).model())
            .is_some_and(|model| model.supports_split_token_display())
    }

    fn render_token_usage(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let thread = self.thread.read(cx);
        let usage = thread.token_usage().cloned();
        if usage.is_none() && self.agent_display_name.as_ref() != "Backboard" {
            return None;
        }
        let usage = usage.unwrap_or_default();
        let has_usage = usage.max_tokens > 0 || usage.used_tokens > 0;
        let show_split = has_usage && self.supports_split_token_display(cx);

        let cost_label = thread.cost().map(|cost| {
            let precision = if cost.amount > 0.0 && cost.amount < 0.01 {
                4
            } else {
                2
            };
            if cost.currency.as_ref() == "USD" {
                format!("${:.prec$}", cost.amount, prec = precision)
            } else {
                format!("{:.prec$} {}", cost.amount, cost.currency, prec = precision)
            }
        });
        let speed_metrics = thread.speed_metrics().cloned();

        let progress_color = |ratio: f32| -> Hsla {
            if ratio >= 0.85 {
                cx.theme().status().warning
            } else {
                cx.theme().colors().text_muted
            }
        };

        let used = crate::humanize_token_count(usage.used_tokens);
        let max = crate::humanize_token_count(usage.max_tokens);
        let input_tokens_label = crate::humanize_token_count(usage.input_tokens);
        let output_tokens_label = crate::humanize_token_count(usage.output_tokens);
        let remaining_tokens_label = usage
            .remaining_tokens
            .map(crate::humanize_token_count)
            .unwrap_or_else(|| {
                crate::humanize_token_count(usage.max_tokens.saturating_sub(usage.used_tokens))
            });
        let summary_tokens_label = usage
            .summary_tokens
            .map(crate::humanize_token_count)
            .unwrap_or_else(|| "0".to_string());
        let context_model_label = usage.context_model.clone().or_else(|| {
            speed_metrics
                .as_ref()
                .and_then(|metrics| match (&metrics.provider, &metrics.model) {
                    (Some(provider), Some(model)) => Some(format!("{provider}/{model}").into()),
                    (_, Some(model)) => Some(model.clone()),
                    _ => None,
                })
        });

        let progress_ratio = if usage.max_tokens > 0 {
            usage.used_tokens as f32 / usage.max_tokens as f32
        } else {
            0.0
        };

        let ring_size = px(16.0);
        let stroke_width = px(2.);

        let percentage = format!("{}%", (progress_ratio * 100.0).round() as u32);
        let percentage = usage
            .context_percent
            .map(|percent| format!("{}%", percent.min(100)))
            .unwrap_or(percentage);
        let tooltip_separator_color = Color::Custom(cx.theme().colors().text_disabled.opacity(0.6));

        let (user_rules_count, first_user_rules_id, project_rules_count, project_entry_ids) = self
            .as_native_thread(cx)
            .map(|thread| {
                let project_context = thread.read(cx).project_context().read(cx);
                let user_rules_count = project_context.user_rules.len();
                let first_user_rules_id = project_context.user_rules.first().map(|r| r.uuid.0);
                let project_entry_ids = project_context
                    .worktrees
                    .iter()
                    .filter_map(|wt| wt.rules_file.as_ref())
                    .map(|rf| ProjectEntryId::from_usize(rf.project_entry_id))
                    .collect::<Vec<_>>();
                let project_rules_count = project_entry_ids.len();
                (
                    user_rules_count,
                    first_user_rules_id,
                    project_rules_count,
                    project_entry_ids,
                )
            })
            .unwrap_or_default();

        let workspace = self.workspace.clone();

        let max_output_tokens = self
            .as_native_thread(cx)
            .and_then(|thread| thread.read(cx).model())
            .and_then(|model| model.max_output_tokens())
            .unwrap_or(0);
        let input_max_label =
            crate::humanize_token_count(usage.max_tokens.saturating_sub(max_output_tokens));
        let output_max_label = crate::humanize_token_count(max_output_tokens);

        let build_tooltip = {
            let tooltip_percentage = percentage.clone();
            let tooltip_used = used.clone();
            let tooltip_max = max.clone();
            let tooltip_cost_label = cost_label.clone();
            let tooltip_speed_metrics = speed_metrics.clone();
            move |_window: &mut Window, cx: &mut App| {
                let percentage = tooltip_percentage.clone();
                let used = tooltip_used.clone();
                let max = tooltip_max.clone();
                let input_tokens_label = input_tokens_label.clone();
                let output_tokens_label = output_tokens_label.clone();
                let input_max_label = input_max_label.clone();
                let output_max_label = output_max_label.clone();
                let remaining_tokens = remaining_tokens_label.clone();
                let summary_tokens = summary_tokens_label.clone();
                let context_model = context_model_label.clone();
                let project_entry_ids = project_entry_ids.clone();
                let workspace = workspace.clone();
                let cost_label = tooltip_cost_label.clone();
                let speed_metrics = tooltip_speed_metrics.clone();
                cx.new(move |_cx| TokenUsageTooltip {
                    percentage,
                    used,
                    max,
                    input_tokens: input_tokens_label,
                    output_tokens: output_tokens_label,
                    input_max: input_max_label,
                    output_max: output_max_label,
                    remaining_tokens,
                    summary_tokens,
                    context_model,
                    show_split,
                    cost_label,
                    speed_metrics,
                    separator_color: tooltip_separator_color,
                    user_rules_count,
                    first_user_rules_id,
                    project_rules_count,
                    project_entry_ids,
                    workspace,
                })
                .into()
            }
        };

        Some(
            h_flex()
                .id(if show_split {
                    "split_token_usage"
                } else {
                    "circular_progress_tokens"
                })
                .flex_shrink_0()
                .items_center()
                .justify_center()
                .w(px(28.))
                .h(px(28.))
                .child(
                    CircularProgress::new(
                        usage.used_tokens as f32,
                        usage.max_tokens.max(1) as f32,
                        ring_size,
                        cx,
                    )
                    .stroke_width(stroke_width)
                    .progress_color(progress_color(progress_ratio)),
                )
                .hoverable_tooltip(build_tooltip)
                .into_any_element(),
        )
    }

    fn fast_mode_available(&self, cx: &Context<Self>) -> bool {
        if !cx.is_staff() {
            return false;
        }
        self.as_native_thread(cx)
            .and_then(|thread| thread.read(cx).model())
            .map(|model| model.supports_fast_mode())
            .unwrap_or(false)
    }

    fn render_fast_mode_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.fast_mode_available(cx) {
            return None;
        }

        let thread = self.as_native_thread(cx)?.read(cx);

        let (tooltip_label, color, icon) = if matches!(thread.speed(), Some(Speed::Fast)) {
            ("Disable Fast Mode", Color::Muted, IconName::FastForward)
        } else {
            (
                "Enable Fast Mode",
                Color::Custom(cx.theme().colors().icon_disabled.opacity(0.8)),
                IconName::FastForwardOff,
            )
        };

        let focus_handle = self.message_editor.focus_handle(cx);

        Some(
            IconButton::new("fast-mode", icon)
                .icon_size(IconSize::Small)
                .icon_color(color)
                .style(ButtonStyle::Transparent)
                .shape(ui::IconButtonShape::Square)
                .tooltip(move |_, cx| {
                    Tooltip::for_action_in(tooltip_label, &ToggleFastMode, &focus_handle, cx)
                })
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.toggle_fast_mode(cx);
                }))
                .into_any_element(),
        )
    }

    fn render_thinking_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let thread = self.as_native_thread(cx)?.read(cx);
        let model = thread.model()?;

        let supports_thinking = model.supports_thinking();
        if !supports_thinking {
            return None;
        }

        let thinking = thread.thinking_enabled();

        let (tooltip_label, icon, color) = if thinking {
            (
                "Disable Thinking Mode",
                IconName::ThinkingMode,
                Color::Muted,
            )
        } else {
            (
                "Enable Thinking Mode",
                IconName::ThinkingModeOff,
                Color::Custom(cx.theme().colors().icon_disabled.opacity(0.8)),
            )
        };

        let focus_handle = self.message_editor.focus_handle(cx);

        let thinking_toggle = IconButton::new("thinking-mode", icon)
            .icon_size(IconSize::Small)
            .icon_color(color)
            .style(ButtonStyle::Transparent)
            .shape(ui::IconButtonShape::Square)
            .tooltip(move |_, cx| {
                Tooltip::for_action_in(tooltip_label, &ToggleThinkingMode, &focus_handle, cx)
            })
            .on_click(cx.listener(move |this, _, _window, cx| {
                if let Some(thread) = this.as_native_thread(cx) {
                    thread.update(cx, |thread, cx| {
                        let enable_thinking = !thread.thinking_enabled();
                        thread.set_thinking_enabled(enable_thinking, cx);

                        let favorite_key = thread.model().map(|model| {
                            (model.provider_id().0.to_string(), model.id().0.to_string())
                        });
                        let fs = thread.project().read(cx).fs().clone();
                        update_settings_file(fs, cx, move |settings, _| {
                            if let Some(agent) = settings.agent.as_mut() {
                                if let Some(default_model) = agent.default_model.as_mut() {
                                    default_model.enable_thinking = enable_thinking;
                                }
                                if let Some((provider_id, model_id)) = &favorite_key {
                                    agent.update_favorite_model(
                                        provider_id,
                                        model_id,
                                        |favorite| favorite.enable_thinking = enable_thinking,
                                    );
                                }
                            }
                        });
                    });
                }
            }));

        if model.supported_effort_levels().is_empty() {
            return Some(thinking_toggle.into_any_element());
        }

        if !model.supported_effort_levels().is_empty() && !thinking {
            return Some(thinking_toggle.into_any_element());
        }

        let left_btn = thinking_toggle;
        let right_btn = self.render_effort_selector(
            model.supported_effort_levels(),
            thread.thinking_effort().cloned(),
            cx,
        );

        Some(
            SplitButton::new(left_btn, right_btn.into_any_element())
                .style(SplitButtonStyle::Transparent)
                .into_any_element(),
        )
    }

    fn render_effort_selector(
        &self,
        supported_effort_levels: Vec<LanguageModelEffortLevel>,
        selected_effort: Option<String>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let weak_self = cx.weak_entity();

        let default_effort_level = supported_effort_levels
            .iter()
            .find(|effort_level| effort_level.is_default)
            .cloned();

        let selected = selected_effort.and_then(|effort| {
            supported_effort_levels
                .iter()
                .find(|level| level.value == effort)
                .cloned()
        });

        let label = selected
            .clone()
            .or(default_effort_level)
            .map_or("Select Effort".into(), |effort| effort.name);

        let (label_color, icon) = if self.thinking_effort_menu_handle.is_deployed() {
            (Color::Accent, IconName::ChevronUp)
        } else {
            (Color::Muted, IconName::ChevronDown)
        };

        let focus_handle = self.message_editor.focus_handle(cx);
        let show_cycle_row = supported_effort_levels.len() > 1;

        let tooltip = Tooltip::element({
            move |_, cx| {
                let mut content = v_flex().gap_1().child(
                    h_flex()
                        .gap_2()
                        .justify_between()
                        .child(Label::new("Change Thinking Effort"))
                        .child(KeyBinding::for_action_in(
                            &ToggleThinkingEffortMenu,
                            &focus_handle,
                            cx,
                        )),
                );

                if show_cycle_row {
                    content = content.child(
                        h_flex()
                            .pt_1()
                            .gap_2()
                            .justify_between()
                            .border_t_1()
                            .border_color(cx.theme().colors().border_variant)
                            .child(Label::new("Cycle Thinking Effort"))
                            .child(KeyBinding::for_action_in(
                                &CycleThinkingEffort,
                                &focus_handle,
                                cx,
                            )),
                    );
                }

                content.into_any_element()
            }
        });

        PopoverMenu::new("effort-selector")
            .trigger_with_tooltip(
                ButtonLike::new_rounded_right("effort-selector-trigger")
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .child(Label::new(label).size(LabelSize::Small).color(label_color))
                    .child(Icon::new(icon).size(IconSize::XSmall).color(Color::Muted)),
                tooltip,
            )
            .menu(move |window, cx| {
                Some(ContextMenu::build(window, cx, |mut menu, _window, _cx| {
                    menu = menu.header("Change Thinking Effort");

                    for effort_level in supported_effort_levels.clone() {
                        let is_selected = selected
                            .as_ref()
                            .is_some_and(|selected| selected.value == effort_level.value);
                        let entry = ContextMenuEntry::new(effort_level.name)
                            .toggleable(IconPosition::End, is_selected);

                        menu.push_item(entry.handler({
                            let effort = effort_level.value.clone();
                            let weak_self = weak_self.clone();
                            move |_window, cx| {
                                let effort = effort.clone();
                                weak_self
                                    .update(cx, |this, cx| {
                                        if let Some(thread) = this.as_native_thread(cx) {
                                            thread.update(cx, |thread, cx| {
                                                thread.set_thinking_effort(
                                                    Some(effort.to_string()),
                                                    cx,
                                                );

                                                let favorite_key = thread.model().map(|model| {
                                                    (
                                                        model.provider_id().0.to_string(),
                                                        model.id().0.to_string(),
                                                    )
                                                });
                                                let fs = thread.project().read(cx).fs().clone();
                                                update_settings_file(fs, cx, move |settings, _| {
                                                    if let Some(agent) = settings.agent.as_mut() {
                                                        if let Some(default_model) =
                                                            agent.default_model.as_mut()
                                                        {
                                                            default_model.effort =
                                                                Some(effort.to_string());
                                                        }
                                                        if let Some((provider_id, model_id)) =
                                                            &favorite_key
                                                        {
                                                            agent.update_favorite_model(
                                                                provider_id,
                                                                model_id,
                                                                |favorite| {
                                                                    favorite.effort =
                                                                        Some(effort.to_string())
                                                                },
                                                            );
                                                        }
                                                    }
                                                });
                                            });
                                        }
                                    })
                                    .ok();
                            }
                        }));
                    }

                    menu
                }))
            })
            .with_handle(self.thinking_effort_menu_handle.clone())
            .offset(gpui::Point {
                x: px(0.0),
                y: px(-2.0),
            })
            .anchor(gpui::Anchor::BottomLeft)
    }

    #[cfg(feature = "audio")]
    fn render_dictation_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let (tooltip, icon_color, style, disabled) = match self.dictation_state {
            DictationState::Idle => (
                "Start Dictation",
                Color::Muted,
                ButtonStyle::Transparent,
                false,
            ),
            DictationState::Recording { .. } => (
                "Stop Dictation",
                Color::Error,
                ButtonStyle::Tinted(TintColor::Error),
                false,
            ),
            DictationState::Transcribing => (
                "Transcribing Dictation",
                Color::Accent,
                ButtonStyle::Subtle,
                true,
            ),
        };

        IconButton::new("dictation", IconName::Mic)
            .icon_size(IconSize::Small)
            .icon_color(icon_color)
            .style(style)
            .shape(ui::IconButtonShape::Square)
            .disabled(disabled)
            .tooltip(Tooltip::text(tooltip))
            .on_click(cx.listener(|this, _, window, cx| {
                this.toggle_dictation(window, cx);
            }))
            .into_any_element()
    }

    #[cfg(not(feature = "audio"))]
    fn render_dictation_button(&self, _cx: &mut Context<Self>) -> AnyElement {
        IconButton::new("dictation", IconName::Mic)
            .icon_size(IconSize::Small)
            .icon_color(Color::Disabled)
            .style(ButtonStyle::Subtle)
            .shape(ui::IconButtonShape::Square)
            .disabled(true)
            .tooltip(Tooltip::text("Dictation unavailable in this build"))
            .into_any_element()
    }

    #[cfg(feature = "audio")]
    fn toggle_dictation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.dictation_state {
            DictationState::Idle => self.start_dictation(window, cx),
            DictationState::Recording { stop_tx } => {
                let _ = stop_tx.try_send(());
                self.dictation_state = DictationState::Transcribing;
                cx.notify();
            }
            DictationState::Transcribing => {}
        }
    }

    #[cfg(feature = "audio")]
    fn start_dictation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (stop_tx, stop_rx) = async_channel::bounded(1);
        self.dictation_state = DictationState::Recording { stop_tx };
        cx.notify();

        let thread_view = cx.weak_entity();
        let record_task = cx.background_spawn(async move { record_dictation_wav(stop_rx) });

        window
            .spawn(cx, async move |cx| {
                let result = async {
                    let wav = record_task.await?;
                    gpui_tokio::Tokio::spawn_result(cx, transcribe_backboard_dictation(wav)).await
                }
                .await;

                cx.update(|window, cx| {
                    thread_view
                        .update(cx, |this, cx| {
                            this.finish_dictation(result, window, cx);
                        })
                        .ok();
                })
                .ok();

                anyhow::Ok(())
            })
            .detach_and_log_err(cx);
    }

    #[cfg(feature = "audio")]
    fn finish_dictation(
        &mut self,
        result: anyhow::Result<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dictation_state = DictationState::Idle;

        match result {
            Ok(transcript) => {
                let transcript = transcript.trim();
                if transcript.is_empty() {
                    self.show_dictation_toast("No speech was detected.", cx);
                } else {
                    let current_text = self.message_editor.read(cx).text(cx);
                    let separator = if current_text
                        .chars()
                        .last()
                        .is_some_and(|last| !last.is_whitespace())
                    {
                        " "
                    } else {
                        ""
                    };
                    self.message_editor.update(cx, |editor, cx| {
                        editor.insert_text(&format!("{separator}{transcript}"), window, cx);
                    });
                    self.message_editor.focus_handle(cx).focus(window, cx);
                }
            }
            Err(error) => {
                log::error!("Dictation failed: {error:#}");
                self.show_dictation_toast(format!("Dictation failed: {error:#}"), cx);
            }
        }

        cx.notify();
    }

    #[cfg(feature = "audio")]
    fn show_dictation_toast(&self, message: impl Into<String>, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };

        workspace.update(cx, |workspace, cx| {
            struct DictationToast;
            workspace.show_toast(
                Toast::new(NotificationId::unique::<DictationToast>(), message.into()).autohide(),
                cx,
            );
        });
    }

    fn render_send_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let message_editor = self.message_editor.read(cx);
        let is_editor_empty = message_editor.is_empty(cx);
        let focus_handle = message_editor.focus_handle(cx);

        let is_generating = self.thread.read(cx).status() != ThreadStatus::Idle;

        if self.is_loading_contents {
            div()
                .id("loading-message-content")
                .px_1()
                .tooltip(Tooltip::text("Loading Added Context…"))
                .child(loading_contents_spinner(IconSize::default()))
                .into_any_element()
        } else if is_generating && is_editor_empty {
            IconButton::new("stop-generation", IconName::Stop)
                .icon_color(Color::Error)
                .style(ButtonStyle::Tinted(TintColor::Error))
                .shape(ui::IconButtonShape::Square)
                .icon_size(IconSize::Small)
                .tooltip(move |_window, cx| {
                    Tooltip::for_action("Stop Generation", &editor::actions::Cancel, cx)
                })
                .on_click(cx.listener(|this, _event, _, cx| this.cancel_generation(cx)))
                .into_any_element()
        } else {
            let send_icon = if is_generating {
                IconName::QueueMessage
            } else {
                IconName::Send
            };
            IconButton::new("send-message", send_icon)
                .shape(ui::IconButtonShape::Square)
                .icon_size(IconSize::Small)
                .map(|this| {
                    if is_editor_empty && !is_generating {
                        this.disabled(true)
                            .style(ButtonStyle::Subtle)
                            .icon_color(Color::Disabled)
                    } else {
                        this.style(ButtonStyle::Tinted(TintColor::Accent))
                            .icon_color(Color::Accent)
                    }
                })
                .tooltip(move |_window, cx| {
                    if is_editor_empty && !is_generating {
                        Tooltip::for_action("Type to Send", &Chat, cx)
                    } else if is_generating {
                        let focus_handle = focus_handle.clone();

                        Tooltip::element(move |_window, cx| {
                            v_flex()
                                .gap_1()
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .justify_between()
                                        .child(Label::new("Queue and Send"))
                                        .child(KeyBinding::for_action_in(&Chat, &focus_handle, cx)),
                                )
                                .child(
                                    h_flex()
                                        .pt_1()
                                        .gap_2()
                                        .justify_between()
                                        .border_t_1()
                                        .border_color(cx.theme().colors().border_variant)
                                        .child(Label::new("Send Immediately"))
                                        .child(KeyBinding::for_action_in(
                                            &SendImmediately,
                                            &focus_handle,
                                            cx,
                                        )),
                                )
                                .into_any_element()
                        })(_window, cx)
                    } else {
                        Tooltip::for_action("Send Message", &Chat, cx)
                    }
                })
                .on_click(cx.listener(|this, _, window, cx| {
                    this.send(window, cx);
                }))
                .into_any_element()
        }
    }

    fn render_add_context_button(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let focus_handle = self.message_editor.focus_handle(cx);
        let weak_self = cx.weak_entity();

        PopoverMenu::new("add-context-menu")
            .trigger_with_tooltip(
                IconButton::new("add-context", IconName::Plus)
                    .icon_size(IconSize::Small)
                    .icon_color(Color::Muted)
                    .style(ButtonStyle::Transparent)
                    .shape(ui::IconButtonShape::Square),
                {
                    move |_window, cx| {
                        Tooltip::for_action_in(
                            "Add Context",
                            &OpenAddContextMenu,
                            &focus_handle,
                            cx,
                        )
                    }
                },
            )
            .anchor(gpui::Anchor::BottomLeft)
            .with_handle(self.add_context_menu_handle.clone())
            .offset(gpui::Point {
                x: px(0.0),
                y: px(-2.0),
            })
            .menu(move |window, cx| {
                weak_self
                    .update(cx, |this, cx| this.build_add_context_menu(window, cx))
                    .ok()
            })
    }

    fn build_add_context_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let message_editor = self.message_editor.clone();
        let workspace = self.workspace.clone();
        let weak_self = cx.weak_entity();
        let session_capabilities = self.session_capabilities.read();
        let supports_images = session_capabilities.supports_images();
        let supports_embedded_context = session_capabilities.supports_embedded_context();

        let has_editor_selection = workspace
            .upgrade()
            .and_then(|ws| {
                ws.read(cx)
                    .active_item(cx)
                    .and_then(|item| item.downcast::<Editor>())
            })
            .is_some_and(|editor| {
                editor.update(cx, |editor, cx| {
                    editor.has_non_empty_selection(&editor.display_snapshot(cx))
                })
            });

        let has_terminal_selection = workspace
            .upgrade()
            .and_then(|ws| ws.read(cx).panel::<TerminalPanel>(cx))
            .is_some_and(|panel| !panel.read(cx).terminal_selections(cx).is_empty());

        let has_selection = has_editor_selection || has_terminal_selection;

        ContextMenu::build(window, cx, move |menu, _window, _cx| {
            let weak_self_for_mcp = weak_self.clone();

            menu.key_context("AddContextMenu")
                .header("Context")
                .submenu_with_colored_icon(
                    "MCP Servers",
                    IconName::Box,
                    Color::Accent,
                    move |menu, _window, cx| {
                        ThreadView::build_mcp_context_submenu(menu, weak_self_for_mcp.clone(), cx)
                    },
                )
                .item(
                    ContextMenuEntry::new("Files & Directories")
                        .icon(IconName::File)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .handler({
                            let message_editor = message_editor.clone();
                            move |window, cx| {
                                message_editor.focus_handle(cx).focus(window, cx);
                                message_editor.update(cx, |editor, cx| {
                                    editor.insert_context_type("file", window, cx);
                                });
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Symbols")
                        .icon(IconName::Code)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .handler({
                            let message_editor = message_editor.clone();
                            move |window, cx| {
                                message_editor.focus_handle(cx).focus(window, cx);
                                message_editor.update(cx, |editor, cx| {
                                    editor.insert_context_type("symbol", window, cx);
                                });
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Threads")
                        .icon(IconName::Thread)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .handler({
                            let message_editor = message_editor.clone();
                            move |window, cx| {
                                message_editor.focus_handle(cx).focus(window, cx);
                                message_editor.update(cx, |editor, cx| {
                                    editor.insert_context_type("thread", window, cx);
                                });
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Rules")
                        .icon(IconName::Reader)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .handler({
                            let message_editor = message_editor.clone();
                            move |window, cx| {
                                message_editor.focus_handle(cx).focus(window, cx);
                                message_editor.update(cx, |editor, cx| {
                                    editor.insert_context_type("rule", window, cx);
                                });
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Image")
                        .icon(IconName::Image)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .disabled(!supports_images)
                        .handler({
                            let message_editor = message_editor.clone();
                            move |window, cx| {
                                message_editor.focus_handle(cx).focus(window, cx);
                                message_editor.update(cx, |editor, cx| {
                                    editor.add_images_from_picker(window, cx);
                                });
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Selection")
                        .icon(IconName::CursorIBeam)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .disabled(!has_selection)
                        .handler({
                            move |window, cx| {
                                window.dispatch_action(
                                    zed_actions::agent::AddSelectionToThread.boxed_clone(),
                                    cx,
                                );
                            }
                        }),
                )
                .item(
                    ContextMenuEntry::new("Branch Diff")
                        .icon(IconName::GitBranch)
                        .icon_color(Color::Muted)
                        .icon_size(IconSize::XSmall)
                        .disabled(!supports_embedded_context)
                        .handler({
                            move |window, cx| {
                                message_editor.update(cx, |editor, cx| {
                                    editor.insert_branch_diff_crease(window, cx);
                                });
                            }
                        }),
                )
        })
    }

    fn build_mcp_context_submenu(
        mut menu: ContextMenu,
        thread_view: WeakEntity<Self>,
        cx: &mut Context<ContextMenu>,
    ) -> ContextMenu {
        let (installed_count, total_count) = recommended_mcp_install_status(cx);
        let (setup_status, setup_status_color, setup_icon): (SharedString, Color, IconName) =
            if total_count > 0 && installed_count == total_count {
                ("Configure".into(), Color::Success, IconName::Check)
            } else if installed_count == 0 {
                ("Install".into(), Color::Accent, IconName::Download)
            } else {
                (
                    format!("{installed_count}/{total_count} installed").into(),
                    Color::Accent,
                    IconName::Download,
                )
            };

        let thread_view_for_setup = thread_view.clone();
        menu = menu.header("MCP Servers").custom_entry(
            {
                let setup_status = setup_status.clone();
                move |_window, _cx| {
                    Self::render_context_menu_status_row(
                        "Set Up MCP Servers".into(),
                        setup_status.clone(),
                        setup_icon,
                        setup_status_color,
                        setup_status_color,
                    )
                }
            },
            move |window, cx| {
                thread_view_for_setup
                    .update(cx, |this, cx| {
                        this.install_recommended_mcp_servers(window, cx);
                    })
                    .ok();
            },
        );

        menu = menu.separator().header("Custom MCP Server").custom_entry(
            move |_window, _cx| {
                Self::render_context_menu_status_row(
                    "Custom".into(),
                    "Add".into(),
                    IconName::Plus,
                    Color::Muted,
                    Color::Accent,
                )
            },
            move |window, cx| {
                window.dispatch_action(crate::AddContextServer.boxed_clone(), cx);
            },
        );

        menu = menu.separator().header("Bundled MCP Servers");

        for server in recommended_mcp_server_statuses(cx) {
            let thread_view_for_server = thread_view.clone();
            let server_ids = server.server_ids.clone();
            let installed = server.installed;
            let label = SharedString::from(server.label);
            let status = if installed {
                SharedString::from("Configure")
            } else {
                SharedString::from("Install")
            };
            let status_color = if installed {
                Color::Muted
            } else {
                Color::Accent
            };
            let icon = if installed {
                IconName::Check
            } else {
                IconName::Download
            };
            let icon_color = if installed {
                Color::Success
            } else {
                Color::Muted
            };

            menu = menu.custom_entry(
                move |_window, _cx| {
                    Self::render_context_menu_status_row(
                        label.clone(),
                        status.clone(),
                        icon,
                        icon_color,
                        status_color,
                    )
                },
                move |window, cx| {
                    thread_view_for_server
                        .update(cx, |this, cx| {
                            if installed {
                                this.configure_first_mcp_server(server_ids.clone(), window, cx);
                            } else {
                                this.install_recommended_mcp_servers(window, cx);
                            }
                        })
                        .ok();
                },
            );
        }

        menu
    }

    fn render_context_menu_status_row(
        label: SharedString,
        status: SharedString,
        icon: IconName,
        icon_color: Color,
        status_color: Color,
    ) -> AnyElement {
        h_flex()
            .min_w(px(260.))
            .w_full()
            .items_center()
            .justify_between()
            .gap_3()
            .child(
                h_flex()
                    .min_w_0()
                    .items_center()
                    .gap_1p5()
                    .child(Icon::new(icon).size(IconSize::XSmall).color(icon_color))
                    .child(Label::new(label).color(Color::Default).truncate()),
            )
            .child(
                h_flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .child(
                        Label::new(status)
                            .size(LabelSize::Small)
                            .color(status_color)
                            .truncate(),
                    )
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    ),
            )
            .into_any_element()
    }

    fn install_recommended_mcp_servers(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else {
            log::error!("Could not install recommended MCP servers: workspace unavailable");
            return;
        };

        workspace.update(cx, |workspace, cx| {
            let language_registry = workspace.app_state().languages.clone();
            crate::install_recommended_mcp_servers(workspace, language_registry, window, cx);
        });
    }

    fn configure_first_mcp_server(
        &self,
        server_ids: Vec<Arc<str>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(server_id) = server_ids.first().cloned() else {
            self.install_recommended_mcp_servers(window, cx);
            return;
        };
        let Some(workspace) = self.workspace.upgrade() else {
            log::error!("Could not configure MCP server: workspace unavailable");
            return;
        };

        workspace.update(cx, |workspace, cx| {
            let language_registry = workspace.app_state().languages.clone();
            let workspace_handle = cx.weak_entity();
            let task = ConfigureContextServerModal::show_modal_for_existing_server(
                ContextServerId(server_id),
                language_registry,
                workspace_handle,
                window,
                cx,
            );
            cx.spawn(async move |_, _| {
                if let Err(error) = task.await {
                    log::error!("Failed to configure MCP server: {error:#}");
                }
            })
            .detach();
        });
    }

    fn render_follow_toggle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let following = self.is_following(cx);

        let tooltip_label = if following {
            if self.agent_id.as_ref() == agent::ZED_AGENT_ID.as_ref() {
                format!("Stop Following the {}", self.agent_id)
            } else {
                format!("Stop Following {}", self.agent_id)
            }
        } else {
            if self.agent_id.as_ref() == agent::ZED_AGENT_ID.as_ref() {
                format!("Follow the {}", self.agent_id)
            } else {
                format!("Follow {}", self.agent_id)
            }
        };

        IconButton::new("follow-agent", IconName::Crosshair)
            .icon_size(IconSize::Small)
            .icon_color(Color::Muted)
            .style(ButtonStyle::Transparent)
            .shape(ui::IconButtonShape::Square)
            .toggle_state(following)
            .selected_icon_color(Some(Color::Custom(cx.theme().players().agent().cursor)))
            .tooltip(move |_window, cx| {
                if following {
                    Tooltip::for_action(tooltip_label.clone(), &Follow, cx)
                } else {
                    Tooltip::with_meta(
                        tooltip_label.clone(),
                        Some(&Follow),
                        "Track the agent's location as it reads and edits files.",
                        cx,
                    )
                }
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.toggle_following(window, cx);
            }))
    }
}

struct TokenUsageTooltip {
    percentage: String,
    used: String,
    max: String,
    input_tokens: String,
    output_tokens: String,
    input_max: String,
    output_max: String,
    remaining_tokens: String,
    summary_tokens: String,
    context_model: Option<SharedString>,
    show_split: bool,
    cost_label: Option<String>,
    speed_metrics: Option<acp_thread::SpeedMetrics>,
    separator_color: Color,
    user_rules_count: usize,
    first_user_rules_id: Option<uuid::Uuid>,
    project_rules_count: usize,
    project_entry_ids: Vec<ProjectEntryId>,
    workspace: WeakEntity<Workspace>,
}

fn format_duration_ms(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{:.1}s", ms / 1000.0)
    } else {
        format!("{}ms", ms.round() as u64)
    }
}

fn speed_metric_row(label: &'static str, value: f64) -> AnyElement {
    h_flex()
        .gap_1()
        .justify_between()
        .child(Label::new(label).color(Color::Muted))
        .child(Label::new(format_duration_ms(value)))
        .into_any_element()
}

fn render_speed_metric_rows(metrics: &acp_thread::SpeedMetrics) -> Vec<AnyElement> {
    let mut rows = Vec::new();
    if let Some(value) = metrics.first_token_ms {
        rows.push(speed_metric_row("First token", value));
    }
    if let Some(value) = metrics.total_turn_ms {
        rows.push(speed_metric_row("Total turn", value));
    }
    if let Some(value) = metrics.runtime_load_ms {
        rows.push(speed_metric_row("Runtime", value));
    }
    if let Some(value) = metrics.model_list_ms {
        rows.push(speed_metric_row("Models", value));
    }
    if let Some(value) = metrics.assistant_create_ms {
        rows.push(speed_metric_row("Assistant", value));
    }
    if let Some(value) = metrics.context_pack_ms {
        rows.push(speed_metric_row("Context pack", value));
    }
    if let Some(value) = metrics.semantic_context_ms {
        rows.push(speed_metric_row("Semantic context", value));
    }
    if let Some(value) = metrics.tool_batch_ms {
        rows.push(speed_metric_row("Tools", value));
    }
    if let Some(value) = metrics.shell_tools_ms {
        rows.push(speed_metric_row("Shell", value));
    }
    if let Some(value) = metrics.read_tools_ms {
        rows.push(speed_metric_row("Reads", value));
    }
    if let Some(value) = metrics.search_tools_ms {
        rows.push(speed_metric_row("Searches", value));
    }
    if let Some(value) = metrics.edit_tools_ms {
        rows.push(speed_metric_row("Edits", value));
    }
    if let Some(value) = metrics.other_tools_ms {
        rows.push(speed_metric_row("Other tools", value));
    }
    if let (Some(name), Some(value)) = (metrics.slowest_tool.as_ref(), metrics.slowest_tool_ms) {
        rows.push(
            h_flex()
                .gap_1()
                .justify_between()
                .child(Label::new("Slowest tool").color(Color::Muted))
                .child(Label::new(format!(
                    "{} {}",
                    name,
                    format_duration_ms(value)
                )))
                .into_any_element(),
        );
    }
    if let Some(value) = metrics.file_write_ms {
        rows.push(speed_metric_row("File writes", value));
    }
    if let Some(value) = metrics.command_wait_ms {
        rows.push(speed_metric_row("Approval wait", value));
    }
    if let Some(intensity) = metrics.intensity.as_ref() {
        rows.push(
            h_flex()
                .gap_1()
                .justify_between()
                .child(Label::new("Intensity").color(Color::Muted))
                .child(Label::new(intensity.clone()))
                .into_any_element(),
        );
    }
    rows
}

fn speed_stat_row(label: &'static str, value: u64) -> AnyElement {
    h_flex()
        .gap_1()
        .justify_between()
        .child(Label::new(label).color(Color::Muted))
        .child(Label::new(value.to_string()))
        .into_any_element()
}

fn render_speed_stat_rows(metrics: &acp_thread::SpeedMetrics) -> Vec<AnyElement> {
    let mut rows = Vec::new();
    if let Some(model) = metrics.model.as_ref() {
        rows.push(
            h_flex()
                .gap_1()
                .justify_between()
                .child(Label::new("Model").color(Color::Muted))
                .child(Label::new(model.clone()))
                .into_any_element(),
        );
    }
    if let Some(provider) = metrics.provider.as_ref() {
        rows.push(
            h_flex()
                .gap_1()
                .justify_between()
                .child(Label::new("Provider").color(Color::Muted))
                .child(Label::new(provider.clone()))
                .into_any_element(),
        );
    }
    if let Some(value) = metrics.tool_calls_count {
        rows.push(speed_stat_row("Tool calls", value));
    }
    if let Some(value) = metrics.shell_tools_count {
        rows.push(speed_stat_row("Shell calls", value));
    }
    if let Some(value) = metrics.read_tools_count {
        rows.push(speed_stat_row("Read calls", value));
    }
    if let Some(value) = metrics.search_tools_count {
        rows.push(speed_stat_row("Search calls", value));
    }
    if let Some(value) = metrics.edit_tools_count {
        rows.push(speed_stat_row("Edit calls", value));
    }
    if let Some(value) = metrics.other_tools_count {
        rows.push(speed_stat_row("Other calls", value));
    }
    rows
}

impl Render for TokenUsageTooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let separator_color = self.separator_color;
        let percentage = self.percentage.clone();
        let used = self.used.clone();
        let max = self.max.clone();
        let input_tokens = self.input_tokens.clone();
        let output_tokens = self.output_tokens.clone();
        let input_max = self.input_max.clone();
        let output_max = self.output_max.clone();
        let remaining_tokens = self.remaining_tokens.clone();
        let summary_tokens = self.summary_tokens.clone();
        let context_model = self.context_model.clone();
        let show_split = self.show_split;
        let cost_label = self.cost_label.clone();
        let speed_metrics = self.speed_metrics.clone();
        let user_rules_count = self.user_rules_count;
        let first_user_rules_id = self.first_user_rules_id;
        let project_rules_count = self.project_rules_count;
        let project_entry_ids = self.project_entry_ids.clone();
        let workspace = self.workspace.clone();

        ui::tooltip_container(cx, move |container, cx| {
            container
                .min_w_40()
                .child(
                    Label::new("Context")
                        .color(Color::Muted)
                        .size(LabelSize::Small),
                )
                .when(!show_split, |this| {
                    this.child(
                        h_flex()
                            .gap_0p5()
                            .child(Label::new(percentage.clone()))
                            .child(Label::new("\u{2022}").color(separator_color).mx_1())
                            .child(Label::new(used.clone()))
                            .child(Label::new("/").color(separator_color))
                            .child(Label::new(max.clone()).color(Color::Muted)),
                    )
                })
                .when(show_split, |this| {
                    this.child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .gap_0p5()
                                    .child(Label::new("Input:").color(Color::Muted).mr_0p5())
                                    .child(Label::new(input_tokens))
                                    .child(Label::new("/").color(separator_color))
                                    .child(Label::new(input_max).color(Color::Muted)),
                            )
                            .child(
                                h_flex()
                                    .gap_0p5()
                                    .child(Label::new("Output:").color(Color::Muted).mr_0p5())
                                    .child(Label::new(output_tokens))
                                    .child(Label::new("/").color(separator_color))
                                    .child(Label::new(output_max).color(Color::Muted)),
                            ),
                    )
                })
                .child(
                    v_flex()
                        .mt_1p5()
                        .pt_1p5()
                        .gap_0p5()
                        .border_t_1()
                        .border_color(cx.theme().colors().border_variant)
                        .child(
                            Label::new("Window")
                                .color(Color::Muted)
                                .size(LabelSize::Small),
                        )
                        .child(
                            h_flex()
                                .gap_0p5()
                                .justify_between()
                                .child(Label::new("Remaining").color(Color::Muted))
                                .child(Label::new(remaining_tokens)),
                        )
                        .child(
                            h_flex()
                                .gap_0p5()
                                .justify_between()
                                .child(Label::new("Summary").color(Color::Muted))
                                .child(Label::new(summary_tokens)),
                        )
                        .when_some(context_model, |this, context_model| {
                            this.child(
                                h_flex()
                                    .gap_0p5()
                                    .justify_between()
                                    .child(Label::new("Context model").color(Color::Muted))
                                    .child(Label::new(context_model)),
                            )
                        }),
                )
                .when_some(cost_label, |this, cost_label| {
                    this.child(
                        v_flex()
                            .mt_1p5()
                            .pt_1p5()
                            .gap_0p5()
                            .border_t_1()
                            .border_color(cx.theme().colors().border_variant)
                            .child(
                                Label::new("Cost")
                                    .color(Color::Muted)
                                    .size(LabelSize::Small),
                            )
                            .child(Label::new(cost_label)),
                    )
                })
                .when_some(speed_metrics, |this, speed_metrics| {
                    let stat_rows = render_speed_stat_rows(&speed_metrics);
                    this.child(
                        v_flex()
                            .mt_1p5()
                            .pt_1p5()
                            .gap_0p5()
                            .border_t_1()
                            .border_color(cx.theme().colors().border_variant)
                            .child(
                                Label::new("Speed")
                                    .color(Color::Muted)
                                    .size(LabelSize::Small),
                            )
                            .children(render_speed_metric_rows(&speed_metrics)),
                    )
                    .when(!stat_rows.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .mt_1p5()
                                .pt_1p5()
                                .gap_0p5()
                                .border_t_1()
                                .border_color(cx.theme().colors().border_variant)
                                .child(
                                    Label::new("Stats")
                                        .color(Color::Muted)
                                        .size(LabelSize::Small),
                                )
                                .children(stat_rows),
                        )
                    })
                })
                .when(
                    user_rules_count > 0 || project_rules_count > 0,
                    move |this| {
                        this.child(
                            v_flex()
                                .mt_1p5()
                                .pt_1p5()
                                .pb_0p5()
                                .gap_0p5()
                                .border_t_1()
                                .border_color(cx.theme().colors().border_variant)
                                .child(
                                    Label::new("Rules")
                                        .color(Color::Muted)
                                        .size(LabelSize::Small),
                                )
                                .child(
                                    v_flex()
                                        .mx_neg_1()
                                        .when(user_rules_count > 0, move |this| {
                                            this.child(
                                                Button::new(
                                                    "open-user-rules",
                                                    format!("{} user rules", user_rules_count),
                                                )
                                                .end_icon(
                                                    Icon::new(IconName::ArrowUpRight)
                                                        .color(Color::Muted)
                                                        .size(IconSize::XSmall),
                                                )
                                                .on_click(move |_, window, cx| {
                                                    window.dispatch_action(
                                                        Box::new(OpenRulesLibrary {
                                                            prompt_to_select: first_user_rules_id,
                                                        }),
                                                        cx,
                                                    );
                                                }),
                                            )
                                        })
                                        .when(project_rules_count > 0, move |this| {
                                            let workspace = workspace.clone();
                                            let project_entry_ids = project_entry_ids.clone();
                                            this.child(
                                                Button::new(
                                                    "open-project-rules",
                                                    format!(
                                                        "{} project rules",
                                                        project_rules_count
                                                    ),
                                                )
                                                .end_icon(
                                                    Icon::new(IconName::ArrowUpRight)
                                                        .color(Color::Muted)
                                                        .size(IconSize::XSmall),
                                                )
                                                .on_click(move |_, window, cx| {
                                                    let _ =
                                                        workspace.update(cx, |workspace, cx| {
                                                            let project =
                                                                workspace.project().read(cx);
                                                            let paths = project_entry_ids
                                                                .iter()
                                                                .flat_map(|id| {
                                                                    project.path_for_entry(*id, cx)
                                                                })
                                                                .collect::<Vec<_>>();
                                                            for path in paths {
                                                                workspace
                                                                    .open_path(
                                                                        path, None, true, window,
                                                                        cx,
                                                                    )
                                                                    .detach_and_log_err(cx);
                                                            }
                                                        });
                                                }),
                                            )
                                        }),
                                ),
                        )
                    },
                )
        })
    }
}

impl ThreadView {
    fn uses_compact_assistant_turns(&self) -> bool {
        self.agent_id.as_ref() == "backboard" || self.agent_display_name.as_ref() == "Backboard"
    }

    fn assistant_turn_bounds_for_index(
        &self,
        entries: &[AgentThreadEntry],
        index: usize,
        cx: &Context<Self>,
    ) -> Option<(usize, usize)> {
        if !self.uses_compact_assistant_turns() {
            return None;
        }

        if matches!(entries.get(index)?, AgentThreadEntry::UserMessage(_)) {
            return None;
        }

        let mut start = index;
        while start > 0 && !matches!(entries[start - 1], AgentThreadEntry::UserMessage(_)) {
            start -= 1;
        }

        let mut end = index + 1;
        while end < entries.len() && !matches!(entries[end], AgentThreadEntry::UserMessage(_)) {
            end += 1;
        }

        let is_active_turn = matches!(self.thread.read(cx).status(), ThreadStatus::Generating)
            && end == entries.len();
        if !is_active_turn
            && let Some(final_response_ix) =
                self.assistant_turn_final_response_index(entries, start, end, cx)
        {
            if index >= final_response_ix {
                return None;
            }

            end = final_response_ix;
            if start == end {
                return None;
            }
        }

        Some((start, end))
    }

    fn active_assistant_turn_bounds(
        &self,
        entries: &[AgentThreadEntry],
        cx: &Context<Self>,
    ) -> Option<(usize, usize)> {
        if !self.uses_compact_assistant_turns() {
            return None;
        }

        if !matches!(self.thread.read(cx).status(), ThreadStatus::Generating) {
            return None;
        }

        let start = entries
            .iter()
            .rposition(|entry| matches!(entry, AgentThreadEntry::UserMessage(_)))
            .map_or(0, |ix| ix + 1);

        Some((start, entries.len()))
    }

    fn assistant_turn_is_expanded(
        &self,
        start: usize,
        end: usize,
        total_entries: usize,
        cx: &Context<Self>,
    ) -> bool {
        if self.collapsed_assistant_turns.contains(&start) {
            return false;
        }

        if self.expanded_assistant_turns.contains(&start) {
            return true;
        }

        matches!(self.thread.read(cx).status(), ThreadStatus::Generating) && end == total_entries
    }

    fn assistant_turn_status_label(
        &self,
        start: usize,
        end: usize,
        total_entries: usize,
        cx: &Context<Self>,
    ) -> String {
        let is_active_turn = matches!(self.thread.read(cx).status(), ThreadStatus::Generating)
            && end == total_entries;

        if is_active_turn {
            return self
                .turn_fields
                .turn_started_at
                .map(|started_at| {
                    format!("Working for {}", duration_alt_display(started_at.elapsed()))
                })
                .unwrap_or_else(|| "Working".to_string());
        }

        if end == total_entries
            && let Some(duration) = self.turn_fields.last_turn_duration
        {
            return format!("Worked for {}", duration_alt_display(duration));
        }

        if let Some(duration) = self.assistant_turn_durations.get(&start) {
            return format!("Worked for {}", duration_alt_display(*duration));
        }

        "Worked".to_string()
    }

    fn render_assistant_turn_row(
        &self,
        start: usize,
        end: usize,
        index: usize,
        entries: &[AgentThreadEntry],
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let total_entries = entries.len();
        let is_expanded = self.assistant_turn_is_expanded(start, end, total_entries, cx);
        let label = self.assistant_turn_status_label(start, end, total_entries, cx);

        let mut row = v_flex().w_full();
        if index == start {
            row = row.child(self.render_assistant_turn_header(start, is_expanded, label, cx));
        }

        if is_expanded {
            if let Some(group) = self.exploration_group_at(entries, index, cx) {
                if index != group.start {
                    return if index == start {
                        row.into_any_element()
                    } else {
                        Empty.into_any_element()
                    };
                }

                row = row.child(self.render_exploration_group(
                    &group,
                    entries.len(),
                    entries,
                    window,
                    cx,
                ));
            } else {
                row =
                    row.child(self.render_entry(index, entries.len(), &entries[index], window, cx));
            }
        }

        if end == total_entries
            && ((is_expanded && index + 1 == end) || (!is_expanded && index == start))
        {
            row = row.children(self.render_final_edits_section(cx));
        }

        row.into_any_element()
    }

    fn render_assistant_turn_generating_row(
        &self,
        start: usize,
        end: usize,
        entries: &[AgentThreadEntry],
        cx: &Context<Self>,
    ) -> AnyElement {
        let total_entries = entries.len();
        let is_expanded = self.assistant_turn_is_expanded(start, end, total_entries, cx);
        let label = self.assistant_turn_status_label(start, end, total_entries, cx);
        let confirmation = entries
            .last()
            .is_some_and(|entry| Self::is_waiting_for_confirmation(entry));

        let mut row = v_flex().w_full();
        if start == total_entries {
            row = row.child(self.render_assistant_turn_header(start, is_expanded, label, cx));
        }

        if is_expanded {
            row = row.child(self.render_generating(confirmation, cx));
        }

        row.into_any_element()
    }

    fn render_assistant_turn_header(
        &self,
        start: usize,
        is_expanded: bool,
        label: String,
        cx: &Context<Self>,
    ) -> AnyElement {
        let header_id = SharedString::from(format!("assistant-turn-{start}"));

        h_flex()
            .id(header_id.clone())
            .group(&header_id)
            .mx(rems_from_px(14.))
            .pt_1()
            .pb_1()
            .justify_between()
            .items_center()
            .cursor(CursorStyle::PointingHand)
            .border_b_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.7))
            .hover(|style| style.bg(cx.theme().colors().element_hover.opacity(0.35)))
            .child(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
                    .child(
                        Disclosure::new(("assistant-turn-disclosure", start), is_expanded)
                            .opened_icon(IconName::ChevronUp)
                            .closed_icon(IconName::ChevronDown)
                            .visible_on_hover(&header_id),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if is_expanded {
                    this.expanded_assistant_turns.remove(&start);
                    this.collapsed_assistant_turns.insert(start);
                } else {
                    this.collapsed_assistant_turns.remove(&start);
                    this.expanded_assistant_turns.insert(start);
                }
                cx.notify();
            }))
            .into_any_element()
    }

    fn render_entries(&mut self, cx: &mut Context<Self>) -> List {
        let max_content_width = AgentSettings::get_global(cx).max_content_width;
        let centered_container = move |content: AnyElement| {
            h_flex().w_full().justify_center().child(
                div()
                    .when_some(max_content_width, |this, max_w| this.max_w(max_w))
                    .w_full()
                    .child(content),
            )
        };

        list(
            self.list_state.clone(),
            cx.processor(move |this, index: usize, window, cx| {
                let entries = this.thread.read(cx).entries();
                if let Some(entry) = entries.get(index) {
                    if let Some((start, end)) =
                        this.assistant_turn_bounds_for_index(entries, index, cx)
                    {
                        if index != start {
                            let is_expanded =
                                this.assistant_turn_is_expanded(start, end, entries.len(), cx);
                            if !is_expanded {
                                return Empty.into_any();
                            }
                        }

                        let rendered =
                            this.render_assistant_turn_row(start, end, index, entries, window, cx);
                        return centered_container(rendered).into_any_element();
                    }

                    if let Some(group) = this.exploration_group_at(entries, index, cx) {
                        if index != group.start {
                            return Empty.into_any();
                        }
                        let rendered = this.render_exploration_group(
                            &group,
                            entries.len(),
                            entries,
                            window,
                            cx,
                        );
                        return centered_container(rendered).into_any_element();
                    }

                    let rendered = this.render_entry(index, entries.len(), entry, window, cx);
                    centered_container(rendered.into_any_element()).into_any_element()
                } else if this.generating_indicator_in_list {
                    if let Some((start, end)) = this.active_assistant_turn_bounds(entries, cx) {
                        let rendered =
                            this.render_assistant_turn_generating_row(start, end, entries, cx);
                        return centered_container(rendered).into_any_element();
                    }
                    let confirmation = entries
                        .last()
                        .is_some_and(|entry| Self::is_waiting_for_confirmation(entry));
                    let rendered = this.render_generating(confirmation, cx);
                    centered_container(rendered.into_any_element()).into_any_element()
                } else {
                    Empty.into_any()
                }
            }),
        )
        .with_sizing_behavior(gpui::ListSizingBehavior::Auto)
        .flex_grow()
    }

    fn exploration_group_at(
        &self,
        entries: &[AgentThreadEntry],
        index: usize,
        cx: &Context<Self>,
    ) -> Option<ExplorationGroup> {
        if !self.is_exploration_entry(entries.get(index)?, cx) {
            return None;
        }

        let mut start = index;
        while start > 0 && self.is_exploration_entry(&entries[start - 1], cx) {
            start -= 1;
        }

        let mut end = index + 1;
        while end < entries.len() && self.is_exploration_entry(&entries[end], cx) {
            end += 1;
        }

        let mut group = ExplorationGroup {
            start,
            end,
            reads: 0,
            searches: 0,
            fetches: 0,
            thoughts: 0,
            active: false,
        };

        for entry in &entries[start..end] {
            match entry {
                AgentThreadEntry::ToolCall(tool_call) => {
                    group.active |= matches!(
                        tool_call.status,
                        ToolCallStatus::Pending | ToolCallStatus::InProgress
                    );
                    match tool_call.kind {
                        acp::ToolKind::Read => group.reads += 1,
                        acp::ToolKind::Search => group.searches += 1,
                        acp::ToolKind::Fetch => group.fetches += 1,
                        _ => {}
                    }
                }
                AgentThreadEntry::AssistantMessage(_) => group.thoughts += 1,
                _ => {}
            }
        }

        let tool_count = group.reads + group.searches + group.fetches;
        if tool_count >= 2 || (tool_count >= 1 && group.thoughts >= 1) {
            Some(group)
        } else {
            None
        }
    }

    fn is_exploration_entry(&self, entry: &AgentThreadEntry, cx: &Context<Self>) -> bool {
        match entry {
            AgentThreadEntry::ToolCall(tool_call) => matches!(
                tool_call.kind,
                acp::ToolKind::Read | acp::ToolKind::Search | acp::ToolKind::Fetch
            ),
            AgentThreadEntry::AssistantMessage(message) => {
                self.is_thought_only_assistant_message(message, cx)
            }
            _ => false,
        }
    }

    fn is_thought_only_assistant_message(
        &self,
        message: &AssistantMessage,
        cx: &Context<Self>,
    ) -> bool {
        let mut saw_thought = false;
        for chunk in &message.chunks {
            match chunk {
                AssistantMessageChunk::Thought { block } => {
                    if block
                        .markdown()
                        .is_some_and(|md| !md.read(cx).source().trim().is_empty())
                    {
                        saw_thought = true;
                    }
                }
                AssistantMessageChunk::Message { block } => {
                    if block
                        .markdown()
                        .is_some_and(|md| !md.read(cx).source().trim().is_empty())
                    {
                        return false;
                    }
                }
            }
        }
        saw_thought
    }

    fn assistant_message_has_regular_content(
        &self,
        message: &AssistantMessage,
        cx: &Context<Self>,
    ) -> bool {
        message.chunks.iter().any(|chunk| match chunk {
            AssistantMessageChunk::Message { block } => block
                .markdown()
                .is_some_and(|md| !md.read(cx).source().trim().is_empty()),
            AssistantMessageChunk::Thought { .. } => false,
        })
    }

    fn assistant_turn_final_response_index(
        &self,
        entries: &[AgentThreadEntry],
        start: usize,
        end: usize,
        cx: &Context<Self>,
    ) -> Option<usize> {
        if end <= start {
            return None;
        }

        let final_ix = end - 1;
        let AgentThreadEntry::AssistantMessage(message) = entries.get(final_ix)? else {
            return None;
        };

        if self.assistant_message_has_regular_content(message, cx) {
            Some(final_ix)
        } else {
            None
        }
    }

    fn assistant_message_has_visible_content(
        &self,
        message: &AssistantMessage,
        entry_ix: usize,
        total_entries: usize,
        cx: &Context<Self>,
    ) -> bool {
        let is_last = entry_ix + 1 == total_entries;
        let is_generating = matches!(self.thread.read(cx).status(), ThreadStatus::Generating);

        message.chunks.iter().any(|chunk| match chunk {
            AssistantMessageChunk::Message { block } => block
                .markdown()
                .is_some_and(|md| !md.read(cx).source().trim().is_empty()),
            AssistantMessageChunk::Thought { block } => block.markdown().is_some_and(|md| {
                let source = md.read(cx).source().to_string();
                if source.trim().is_empty() {
                    return false;
                }

                if Self::is_backboard_progress_text(&source) {
                    is_last && is_generating
                } else {
                    true
                }
            }),
        })
    }

    fn is_first_visible_assistant_content_in_turn(
        &self,
        entry_ix: usize,
        total_entries: usize,
        cx: &Context<Self>,
    ) -> bool {
        let entries = self.thread.read(cx).entries();

        for previous_ix in (0..entry_ix).rev() {
            match &entries[previous_ix] {
                AgentThreadEntry::UserMessage(_) => break,
                AgentThreadEntry::AssistantMessage(message) => {
                    if self.assistant_message_has_visible_content(
                        message,
                        previous_ix,
                        total_entries,
                        cx,
                    ) {
                        return false;
                    }
                }
                AgentThreadEntry::ToolCall(_) | AgentThreadEntry::CompletedPlan(_) => {}
            }
        }

        true
    }

    fn render_exploration_group(
        &self,
        group: &ExplorationGroup,
        total_entries: usize,
        entries: &[AgentThreadEntry],
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let group_id =
            acp::ToolCallId::new(format!("exploration-group-{}-{}", group.start, group.end));
        let is_open = self.expanded_tool_calls.contains(&group_id);
        let header_id = SharedString::from(format!("exploration-group-{}", group.start));
        let summary = self.exploration_group_summary(group);

        let detail_rows = (group.start..group.end).filter_map(|entry_ix| {
            let AgentThreadEntry::ToolCall(tool_call) = entries.get(entry_ix)? else {
                return None;
            };
            Some(self.render_exploration_detail_row(entry_ix, tool_call, window, cx))
        });

        let thread = self.thread.clone();
        let needs_controls = group.end == total_entries;

        v_flex()
            .mx(rems_from_px(14.))
            .my_0p5()
            .rounded(rems_from_px(6.))
            .border_1()
            .border_color(self.tool_card_border_color(cx))
            .bg(cx
                .theme()
                .colors()
                .editor_background
                .blend(cx.theme().colors().element_background.opacity(0.08)))
            .overflow_hidden()
            .child(
                h_flex()
                    .id(header_id.clone())
                    .group(&header_id)
                    .w_full()
                    .justify_between()
                    .px_1p5()
                    .py_0p5()
                    .hover(|style| style.bg(cx.theme().colors().element_hover))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .items_center()
                            .child(
                                Icon::new(IconName::ToolSearch)
                                    .size(IconSize::XSmall)
                                    .color(Color::Muted),
                            )
                            .child(
                                Label::new(summary)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        Disclosure::new(("exploration-group-disclosure", group.start), is_open)
                            .opened_icon(IconName::ChevronUp)
                            .closed_icon(IconName::ChevronDown)
                            .visible_on_hover(&header_id),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if is_open {
                            this.expanded_tool_calls.remove(&group_id);
                        } else {
                            this.expanded_tool_calls.insert(group_id.clone());
                        }
                        cx.notify();
                    })),
            )
            .when(is_open, |this| {
                this.child(
                    v_flex()
                        .gap_0p5()
                        .px_2()
                        .py_1()
                        .border_t_1()
                        .border_color(cx.theme().colors().border_variant.opacity(0.26))
                        .children(detail_rows),
                )
            })
            .when(needs_controls, |this| {
                this.child(self.render_thread_controls(&thread, cx))
            })
            .into_any_element()
    }

    fn exploration_group_summary(&self, group: &ExplorationGroup) -> String {
        let mut parts = Vec::new();
        if group.reads > 0 {
            parts.push(format!(
                "explored {} file{}",
                group.reads,
                if group.reads == 1 { "" } else { "s" }
            ));
        }
        if group.searches > 0 {
            parts.push(format!(
                "ran {} search{}",
                group.searches,
                if group.searches == 1 { "" } else { "es" }
            ));
        }
        if group.fetches > 0 {
            parts.push(format!(
                "fetched {} result{}",
                group.fetches,
                if group.fetches == 1 { "" } else { "s" }
            ));
        }

        let summary = if parts.is_empty() {
            "checked workspace context".to_string()
        } else {
            parts.join(", ")
        };

        if group.active {
            format!("Exploring: {}", summary)
        } else {
            let mut chars = summary.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => summary,
            }
        }
    }

    fn render_exploration_detail_row(
        &self,
        entry_ix: usize,
        tool_call: &ToolCall,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let icon = match tool_call.kind {
            acp::ToolKind::Read => IconName::File,
            acp::ToolKind::Search => IconName::ToolSearch,
            acp::ToolKind::Fetch => IconName::MagnifyingGlass,
            _ => IconName::ToolSearch,
        };

        h_flex()
            .id(("exploration-detail-row", entry_ix))
            .gap_1p5()
            .items_center()
            .child(Icon::new(icon).size(IconSize::XSmall).color(Color::Muted))
            .child(div().text_xs().child(self.render_markdown(
                tool_call.label.clone(),
                MarkdownStyle::themed(MarkdownFont::Agent, window, cx).with_buffer_font(cx),
            )))
            .into_any_element()
    }

    fn render_user_message_content(
        &self,
        content: &ContentBlock,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        match content {
            ContentBlock::Empty => Empty.into_any_element(),
            ContentBlock::Markdown { markdown } => div()
                .text_ui(cx)
                .child(self.render_markdown(
                    markdown.clone(),
                    MarkdownStyle::themed(MarkdownFont::Agent, window, cx).with_buffer_font(cx),
                ))
                .into_any_element(),
            ContentBlock::ResourceLink { resource_link } => {
                self.render_user_message_resource_link(resource_link, cx)
            }
            ContentBlock::Image { image } => img(image.clone())
                .max_w_80()
                .max_h_80()
                .object_fit(ObjectFit::ScaleDown)
                .into_any_element(),
        }
    }

    fn render_user_message_resource_link(
        &self,
        resource_link: &acp::ResourceLink,
        cx: &Context<Self>,
    ) -> AnyElement {
        let uri: SharedString = resource_link.uri.clone().into();
        let label: SharedString = resource_link.name.clone().into();
        let button_id = SharedString::from(format!("user-message-resource-{}", uri));

        Button::new(button_id, label)
            .label_size(LabelSize::Small)
            .color(Color::Muted)
            .start_icon(Icon::new(IconName::File).size(IconSize::XSmall))
            .truncate(true)
            .on_click(cx.listener({
                let workspace = self.workspace.clone();
                move |_, _, window, cx: &mut Context<Self>| {
                    open_link(uri.clone(), &workspace, window, cx);
                }
            }))
            .into_any_element()
    }

    fn render_entry(
        &self,
        entry_ix: usize,
        total_entries: usize,
        entry: &AgentThreadEntry,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let is_indented = entry.is_indented();
        let is_first_indented = is_indented
            && self
                .thread
                .read(cx)
                .entries()
                .get(entry_ix.saturating_sub(1))
                .is_none_or(|entry| !entry.is_indented());

        let primary = match &entry {
            AgentThreadEntry::UserMessage(message) => {
                let Some(editor) = self
                    .entry_view_state
                    .read(cx)
                    .entry(entry_ix)
                    .and_then(|entry| entry.message_editor())
                    .cloned()
                else {
                    return Empty.into_any_element();
                };

                let editing = self.editing_message == Some(entry_ix);
                let editor_focus = editor.focus_handle(cx).is_focused(window);
                let focus_border = cx.theme().colors().border_focused;

                let has_checkpoint_button = message
                    .checkpoint
                    .as_ref()
                    .is_some_and(|checkpoint| checkpoint.show);

                let is_subagent = self.is_subagent();
                let can_rewind = self.thread.read(cx).supports_truncate(cx);
                let is_editable = can_rewind && message.id.is_some() && !is_subagent;
                let agent_name = if is_subagent {
                    "subagents".into()
                } else {
                    self.agent_id.clone()
                };
                let colors = cx.theme().colors();
                let prompt_surface = colors
                    .editor_background
                    .blend(colors.element_background.opacity(0.08));
                let prompt_hover_surface = colors
                    .editor_background
                    .blend(colors.element_background.opacity(0.12));
                let prompt_border = colors.border_variant.opacity(0.32);
                let prompt_hover_border = colors.border_variant.opacity(0.48);
                let editing_surface = colors
                    .editor_background
                    .blend(colors.element_background.opacity(0.1));

                v_flex()
                    .id(("user_message", entry_ix))
                    .map(|this| {
                        if is_first_indented {
                            this.pt_0p5()
                        } else {
                            this.pt_2()
                        }
                    })
                    .pb_3()
                    .px(rems_from_px(14.))
                    .gap_2()
                    .w_full()
                    .when(is_editable && has_checkpoint_button, |this| {
                        this.children(message.id.clone().map(|message_id| {
                            h_flex()
                                .px_3()
                                .gap_2()
                                .child(Divider::horizontal())
                                .child(
                                    Button::new("restore-checkpoint", "Restore Checkpoint")
                                        .start_icon(Icon::new(IconName::Undo).size(IconSize::XSmall).color(Color::Muted))
                                        .label_size(LabelSize::XSmall)
                                        .color(Color::Muted)
                                        .tooltip(Tooltip::text("Restores all files in the project to the content they had at this point in the conversation."))
                                        .on_click(cx.listener(move |this, _, _window, cx| {
                                            this.restore_checkpoint(&message_id, cx);
                                        }))
                                )
                                    .child(Divider::horizontal())
                        }))
                    })
                    .child(
                        div()
                            .relative()
                            .child(if editing {
                                v_flex()
                                    .gap_2()
                                    .p_3()
                                    .rounded(rems_from_px(10.))
                                    .bg(editing_surface)
                                    .border_1()
                                    .when(is_indented, |this| {
                                        this.py_2().px_2()
                                    })
                                    .border_color(if editor_focus {
                                        focus_border
                                    } else {
                                        prompt_hover_border
                                    })
                                    .when(!editor_focus, |this| this.border_dashed())
                                    .child(
                                        Label::new("You")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .text_ui(cx)
                                    .child(editor.clone().into_any_element())
                                    .into_any_element()
                            } else {
                                v_flex()
                                    .id(("edit-user-message", entry_ix))
                                    .relative()
                                    .gap_2()
                                    .p_3()
                                    .rounded(rems_from_px(10.))
                                    .bg(prompt_surface)
                                    .border_1()
                                    .when(is_indented, |this| {
                                        this.py_1p5().px_2()
                                    })
                                    .border_color(prompt_border)
                                    .when(is_subagent, |this| this.border_dashed())
                                    .when(is_editable, |this| {
                                        let editor = editor.clone();
                                        this.cursor(CursorStyle::PointingHand)
                                            .hover(|style| {
                                                style
                                                    .bg(prompt_hover_surface)
                                                    .border_color(prompt_hover_border)
                                            })
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.editing_message = Some(entry_ix);
                                                editor.focus_handle(cx).focus(window, cx);
                                                cx.notify();
                                            }))
                                    })
                                    .child(
                                        Label::new("You")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(self.render_user_message_content(
                                        &message.content,
                                        window,
                                        cx,
                                    ))
                                    .child(
                                        div()
                                            .absolute()
                                            .top_0()
                                            .left_0()
                                            .size_0()
                                            .overflow_hidden()
                                            .opacity(0.)
                                            .child(editor.clone().into_any_element()),
                                    )
                                    .into_any_element()
                            })
                            .when(editing && editor_focus, |this| {
                                let base_container = h_flex()
                                    .absolute()
                                    .top_neg_3p5()
                                    .right_3()
                                    .gap_0p5();

                                let is_loading_contents = self.is_loading_contents;
                                if is_editable {
                                    this.child(
                                        base_container
                                            .child(
                                                IconButton::new("cancel", IconName::Close)
                                                    .disabled(is_loading_contents)
                                                    .icon_color(Color::Error)
                                                    .icon_size(IconSize::XSmall)
                                                    .on_click(cx.listener(Self::cancel_editing))
                                            )
                                            .child(
                                                if is_loading_contents {
                                                    div()
                                                        .id("loading-edited-message-content")
                                                        .tooltip(Tooltip::text("Loading Added Context…"))
                                                        .child(loading_contents_spinner(IconSize::XSmall))
                                                        .into_any_element()
                                                } else {
                                                    IconButton::new("regenerate", IconName::Return)
                                                        .icon_color(Color::Muted)
                                                        .icon_size(IconSize::XSmall)
                                                        .tooltip(Tooltip::text(
                                                            "Editing will restart the thread from this point."
                                                        ))
                                                        .on_click(cx.listener({
                                                            let editor = editor.clone();
                                                            move |this, _, window, cx| {
                                                                this.regenerate(
                                                                    entry_ix, editor.clone(), window, cx,
                                                                );
                                                            }
                                                        })).into_any_element()
                                                }
                                            )
                                    )
                                } else {
                                    this.child(
                                        base_container
                                            .border_dashed()
                                            .child(IconButton::new("non_editable", IconName::PencilUnavailable)
                                                .icon_size(IconSize::Small)
                                                .icon_color(Color::Muted)
                                                .style(ButtonStyle::Transparent)
                                                .tooltip(Tooltip::element({
                                                    let agent_name = agent_name.clone();
                                                    move |_, _| {
                                                        v_flex()
                                                            .gap_1()
                                                            .child(Label::new("Unavailable Editing"))
                                                            .child(
                                                                div().max_w_64().child(
                                                                    Label::new(format!(
                                                                        "Editing previous messages is not available for {} yet.",
                                                                        agent_name
                                                                    ))
                                                                    .size(LabelSize::Small)
                                                                    .color(Color::Muted),
                                                                ),
                                                            )
                                                            .into_any_element()
                                                    }
                                                }))),
                                    )
                                }
                            }),
                    )
                    .into_any()
            }
            AgentThreadEntry::AssistantMessage(AssistantMessage {
                chunks,
                indented: _,
                is_subagent_output,
                model_label,
            }) => {
                let mut is_blank = true;
                let mut rendered_regular_content = false;
                let is_last = entry_ix + 1 == total_entries;

                let style = MarkdownStyle::themed(MarkdownFont::Agent, window, cx);
                let message_body = v_flex()
                    .w_full()
                    .gap_1p5()
                    .children(chunks.iter().enumerate().filter_map(
                        |(chunk_ix, chunk)| match chunk {
                            AssistantMessageChunk::Message { block } => {
                                block.markdown().and_then(|md| {
                                    let this_is_blank = md.read(cx).source().trim().is_empty();
                                    is_blank = is_blank && this_is_blank;
                                    if this_is_blank {
                                        return None;
                                    }
                                    rendered_regular_content = true;

                                    Some(
                                        self.render_markdown(md.clone(), style.clone())
                                            .into_any_element(),
                                    )
                                })
                            }
                            AssistantMessageChunk::Thought { block } => {
                                block.markdown().and_then(|md| {
                                    let source = md.read(cx).source().to_string();
                                    let this_is_blank = source.trim().is_empty();
                                    if Self::is_backboard_progress_text(&source) {
                                        let is_generating = matches!(
                                            self.thread.read(cx).status(),
                                            ThreadStatus::Generating
                                        );
                                        if is_last && is_generating && !this_is_blank {
                                            is_blank = false;
                                            return Some(
                                                self.render_backboard_progress_status(
                                                    md.clone(),
                                                    cx,
                                                ),
                                            );
                                        }
                                        return None;
                                    }
                                    is_blank = is_blank && this_is_blank;
                                    if this_is_blank {
                                        return None;
                                    }
                                    rendered_regular_content = true;
                                    Some(
                                        self.render_thinking_block(
                                            entry_ix,
                                            chunk_ix,
                                            md.clone(),
                                            model_label.clone(),
                                            window,
                                            cx,
                                        )
                                        .into_any_element(),
                                    )
                                })
                            }
                        },
                    ))
                    .into_any();

                if is_blank {
                    Empty.into_any()
                } else {
                    let show_header = !*is_subagent_output
                        && rendered_regular_content
                        && self.is_first_visible_assistant_content_in_turn(
                            entry_ix,
                            total_entries,
                            cx,
                        );

                    v_flex()
                        .px(rems_from_px(14.))
                        .when(show_header, |this| this.pt_1().pb_0p5())
                        .when(!show_header, |this| this.pt_0().pb_0p5())
                        .when(is_last, |this| this.pb_2())
                        .gap_2()
                        .w_full()
                        .text_ui(cx)
                        .when(show_header, |this| {
                            this.child(
                                self.render_assistant_message_header(model_label.clone(), cx),
                            )
                        })
                        .child(self.render_message_context_menu(entry_ix, message_body, cx))
                        .when_some(
                            self.entry_view_state
                                .read(cx)
                                .entry(entry_ix)
                                .and_then(|entry| entry.focus_handle(cx)),
                            |this, handle| this.track_focus(&handle),
                        )
                        .into_any()
                }
            }
            AgentThreadEntry::ToolCall(tool_call) => {
                let tool_call = self.render_any_tool_call(
                    self.thread.read(cx).session_id(),
                    entry_ix,
                    tool_call,
                    &self.focus_handle(cx),
                    false,
                    window,
                    cx,
                );

                if let Some(handle) = self
                    .entry_view_state
                    .read(cx)
                    .entry(entry_ix)
                    .and_then(|entry| entry.focus_handle(cx))
                {
                    tool_call.track_focus(&handle).into_any()
                } else {
                    tool_call.into_any()
                }
            }
            AgentThreadEntry::CompletedPlan(entries) => {
                self.render_completed_plan(entries, window, cx)
            }
        };

        let is_subagent_output = self.is_subagent()
            && matches!(entry, AgentThreadEntry::AssistantMessage(msg) if msg.is_subagent_output);

        let primary = if is_subagent_output {
            v_flex()
                .w_full()
                .child(
                    h_flex()
                        .id("subagent_output")
                        .px_5()
                        .py_1()
                        .gap_2()
                        .child(Divider::horizontal())
                        .child(
                            h_flex()
                                .gap_1()
                                .child(
                                    Icon::new(IconName::ForwardArrowUp)
                                        .color(Color::Muted)
                                        .size(IconSize::Small),
                                )
                                .child(
                                    Label::new("Subagent Output")
                                        .size(LabelSize::Custom(self.tool_name_font_size()))
                                        .color(Color::Muted),
                                ),
                        )
                        .child(Divider::horizontal())
                        .tooltip(Tooltip::text("Everything below this line was sent as output from this subagent to the main agent.")),
                )
                .child(primary)
                .into_any_element()
        } else {
            primary
        };

        let thread = self.thread.clone();

        let primary = if is_indented {
            let line_top = if is_first_indented {
                rems_from_px(-12.0)
            } else {
                rems_from_px(0.0)
            };

            div()
                .relative()
                .w_full()
                .pl_5()
                .bg(cx.theme().colors().panel_background.opacity(0.2))
                .child(
                    div()
                        .absolute()
                        .left(rems_from_px(18.0))
                        .top(line_top)
                        .bottom_0()
                        .w_px()
                        .bg(cx.theme().colors().border_variant.opacity(0.62)),
                )
                .child(primary)
                .into_any_element()
        } else {
            primary
        };

        let needs_confirmation = Self::is_waiting_for_confirmation(entry);

        let comments_editor = self.thread_feedback.comments_editor.clone();

        let primary = if entry_ix + 1 == total_entries {
            v_flex()
                .w_full()
                .child(primary)
                .when(!needs_confirmation, |this| {
                    this.child(self.render_thread_controls(&thread, cx))
                })
                .when_some(comments_editor, |this, editor| {
                    this.child(Self::render_feedback_feedback_editor(editor, cx))
                })
                .children(self.render_final_edits_section(cx))
                .into_any_element()
        } else {
            primary
        };

        if let Some(editing_index) = self.editing_message
            && editing_index < entry_ix
        {
            let is_subagent = self.is_subagent();

            let backdrop = div()
                .id(("backdrop", entry_ix))
                .size_full()
                .absolute()
                .inset_0()
                .bg(cx.theme().colors().panel_background)
                .opacity(0.8)
                .block_mouse_except_scroll()
                .on_click(cx.listener(Self::cancel_editing));

            div()
                .relative()
                .child(primary)
                .when(!is_subagent, |this| this.child(backdrop))
                .into_any_element()
        } else {
            primary
        }
    }

    fn render_feedback_feedback_editor(editor: Entity<Editor>, cx: &Context<Self>) -> Div {
        h_flex()
            .key_context("AgentFeedbackMessageEditor")
            .on_action(cx.listener(move |this, _: &menu::Cancel, _, cx| {
                this.thread_feedback.dismiss_comments();
                cx.notify();
            }))
            .on_action(cx.listener(move |this, _: &menu::Confirm, _window, cx| {
                this.submit_feedback_message(cx);
            }))
            .p_2()
            .mb_2()
            .mx_5()
            .gap_1()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.24))
            .bg(cx
                .theme()
                .colors()
                .editor_background
                .blend(cx.theme().colors().element_background.opacity(0.06)))
            .child(div().w_full().child(editor))
            .child(
                h_flex()
                    .child(
                        IconButton::new("dismiss-feedback-message", IconName::Close)
                            .icon_color(Color::Error)
                            .icon_size(IconSize::XSmall)
                            .shape(ui::IconButtonShape::Square)
                            .on_click(cx.listener(move |this, _, _window, cx| {
                                this.thread_feedback.dismiss_comments();
                                cx.notify();
                            })),
                    )
                    .child(
                        IconButton::new("submit-feedback-message", IconName::Return)
                            .icon_size(IconSize::XSmall)
                            .shape(ui::IconButtonShape::Square)
                            .on_click(cx.listener(move |this, _, _window, cx| {
                                this.submit_feedback_message(cx);
                            })),
                    ),
            )
    }

    fn render_thread_controls(
        &self,
        thread: &Entity<AcpThread>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let is_generating = matches!(thread.read(cx).status(), ThreadStatus::Generating);
        if is_generating {
            return Empty.into_any_element();
        }

        let open_as_markdown = IconButton::new("open-as-markdown", IconName::FileMarkdown)
            .shape(ui::IconButtonShape::Square)
            .icon_size(IconSize::Small)
            .icon_color(Color::Ignored)
            .tooltip(Tooltip::text("Open Thread as Markdown"))
            .on_click(cx.listener(move |this, _, window, cx| {
                if let Some(workspace) = this.workspace.upgrade() {
                    this.open_thread_as_markdown(workspace, window, cx)
                        .detach_and_log_err(cx);
                }
            }));

        let scroll_to_recent_user_prompt =
            IconButton::new("scroll_to_recent_user_prompt", IconName::ForwardArrow)
                .shape(ui::IconButtonShape::Square)
                .icon_size(IconSize::Small)
                .icon_color(Color::Ignored)
                .tooltip(Tooltip::text("Scroll To Most Recent User Prompt"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.scroll_to_most_recent_user_prompt(cx);
                }));

        let scroll_to_top = IconButton::new("scroll_to_top", IconName::ArrowUp)
            .shape(ui::IconButtonShape::Square)
            .icon_size(IconSize::Small)
            .icon_color(Color::Ignored)
            .tooltip(Tooltip::text("Scroll To Top"))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.scroll_to_top(cx);
            }));

        let show_stats = AgentSettings::get_global(cx).show_turn_stats;
        let last_turn_clock = show_stats
            .then(|| {
                self.turn_fields
                    .last_turn_duration
                    .filter(|&duration| duration > STOPWATCH_THRESHOLD)
                    .map(|duration| {
                        Label::new(duration_alt_display(duration))
                            .size(LabelSize::Small)
                            .color(Color::Muted)
                    })
            })
            .flatten();

        let last_turn_tokens_label = last_turn_clock
            .is_some()
            .then(|| {
                self.turn_fields
                    .last_turn_tokens
                    .filter(|&tokens| tokens > TOKEN_THRESHOLD)
                    .map(|tokens| {
                        Label::new(format!("{} tokens", crate::humanize_token_count(tokens)))
                            .size(LabelSize::Small)
                            .color(Color::Muted)
                    })
            })
            .flatten();

        let mut container = h_flex()
            .w_full()
            .py_1()
            .px(rems_from_px(14.))
            .gap_px()
            .opacity(0.6)
            .hover(|s| s.opacity(1.))
            .justify_end()
            .when(
                last_turn_tokens_label.is_some() || last_turn_clock.is_some(),
                |this| {
                    this.child(
                        h_flex()
                            .gap_1()
                            .px_1()
                            .when_some(last_turn_tokens_label, |this, label| this.child(label))
                            .when_some(last_turn_clock, |this, label| this.child(label)),
                    )
                },
            );

        let enable_thread_feedback = util::maybe!({
            let project = thread.read(cx).project().read(cx);
            let user_store = project.user_store();
            if let Some(configuration) = user_store.read(cx).current_organization_configuration() {
                if !configuration.is_agent_thread_feedback_enabled {
                    return false;
                }
            }

            AgentSettings::get_global(cx).enable_feedback
                && self.thread.read(cx).connection().telemetry().is_some()
        });

        if enable_thread_feedback {
            let feedback = self.thread_feedback.feedback;

            let tooltip_meta = || {
                SharedString::new(
                    "Rating the thread sends all of your current conversation to the Backboard team.",
                )
            };

            container = container
                    .child(
                        IconButton::new("feedback-thumbs-up", IconName::ThumbsUp)
                            .shape(ui::IconButtonShape::Square)
                            .icon_size(IconSize::Small)
                            .icon_color(match feedback {
                                Some(ThreadFeedback::Positive) => Color::Accent,
                                _ => Color::Ignored,
                            })
                            .tooltip(move |window, cx| match feedback {
                                Some(ThreadFeedback::Positive) => {
                                    Tooltip::text("Thanks for your feedback!")(window, cx)
                                }
                                _ => {
                                    Tooltip::with_meta("Helpful Response", None, tooltip_meta(), cx)
                                }
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.handle_feedback_click(ThreadFeedback::Positive, window, cx);
                            })),
                    )
                    .child(
                        IconButton::new("feedback-thumbs-down", IconName::ThumbsDown)
                            .shape(ui::IconButtonShape::Square)
                            .icon_size(IconSize::Small)
                            .icon_color(match feedback {
                                Some(ThreadFeedback::Negative) => Color::Accent,
                                _ => Color::Ignored,
                            })
                            .tooltip(move |window, cx| match feedback {
                                Some(ThreadFeedback::Negative) => {
                                    Tooltip::text(
                                    "We appreciate your feedback and will use it to improve in the future.",
                                )(window, cx)
                                }
                                _ => {
                                    Tooltip::with_meta(
                                        "Not Helpful Response",
                                        None,
                                        tooltip_meta(),
                                        cx,
                                    )
                                }
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.handle_feedback_click(ThreadFeedback::Negative, window, cx);
                            })),
                    );
        }

        container
            .child(open_as_markdown)
            .child(scroll_to_recent_user_prompt)
            .child(scroll_to_top)
            .into_any_element()
    }

    pub(crate) fn scroll_to_most_recent_user_prompt(&mut self, cx: &mut Context<Self>) {
        let entries = self.thread.read(cx).entries();
        if entries.is_empty() {
            return;
        }

        // Find the most recent user message and scroll it to the top of the viewport.
        // (Fallback: if no user message exists, scroll to the bottom.)
        if let Some(ix) = entries
            .iter()
            .rposition(|entry| matches!(entry, AgentThreadEntry::UserMessage(_)))
        {
            self.list_state.scroll_to(ListOffset {
                item_ix: ix,
                offset_in_item: px(0.0),
            });
            cx.notify();
        } else {
            self.scroll_to_end(cx);
        }
    }

    pub fn scroll_to_end(&mut self, cx: &mut Context<Self>) {
        self.list_state.scroll_to_end();
        cx.notify();
    }

    fn handle_feedback_click(
        &mut self,
        feedback: ThreadFeedback,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.thread_feedback
            .submit(self.thread.clone(), feedback, window, cx);
        cx.notify();
    }

    fn submit_feedback_message(&mut self, cx: &mut Context<Self>) {
        let thread = self.thread.clone();
        self.thread_feedback.submit_comments(thread, cx);
        cx.notify();
    }

    pub(crate) fn scroll_to_top(&mut self, cx: &mut Context<Self>) {
        self.list_state.scroll_to(ListOffset::default());
        cx.notify();
    }

    fn scroll_output_page_up(
        &mut self,
        _: &ScrollOutputPageUp,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let page_height = self.list_state.viewport_bounds().size.height;
        self.list_state.scroll_by(-page_height * 0.9);
        cx.notify();
    }

    fn scroll_output_page_down(
        &mut self,
        _: &ScrollOutputPageDown,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let page_height = self.list_state.viewport_bounds().size.height;
        self.list_state.scroll_by(page_height * 0.9);
        cx.notify();
    }

    fn scroll_output_line_up(
        &mut self,
        _: &ScrollOutputLineUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.list_state.scroll_by(-window.line_height() * 3.);
        cx.notify();
    }

    fn scroll_output_line_down(
        &mut self,
        _: &ScrollOutputLineDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.list_state.scroll_by(window.line_height() * 3.);
        cx.notify();
    }

    fn scroll_output_to_top(
        &mut self,
        _: &ScrollOutputToTop,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.scroll_to_top(cx);
    }

    fn scroll_output_to_bottom(
        &mut self,
        _: &ScrollOutputToBottom,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.scroll_to_end(cx);
    }

    fn scroll_output_to_previous_message(
        &mut self,
        _: &ScrollOutputToPreviousMessage,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entries = self.thread.read(cx).entries();
        let current_ix = self.list_state.logical_scroll_top().item_ix;
        if let Some(target_ix) = (0..current_ix)
            .rev()
            .find(|&i| matches!(entries.get(i), Some(AgentThreadEntry::UserMessage(_))))
        {
            self.list_state.scroll_to(ListOffset {
                item_ix: target_ix,
                offset_in_item: px(0.),
            });
            cx.notify();
        }
    }

    fn scroll_output_to_next_message(
        &mut self,
        _: &ScrollOutputToNextMessage,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entries = self.thread.read(cx).entries();
        let current_ix = self.list_state.logical_scroll_top().item_ix;
        if let Some(target_ix) = (current_ix + 1..entries.len())
            .find(|&i| matches!(entries.get(i), Some(AgentThreadEntry::UserMessage(_))))
        {
            self.list_state.scroll_to(ListOffset {
                item_ix: target_ix,
                offset_in_item: px(0.),
            });
            cx.notify();
        }
    }

    pub fn open_thread_as_markdown(
        &self,
        workspace: Entity<Workspace>,
        window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<()>> {
        let markdown_language_task = workspace
            .read(cx)
            .app_state()
            .languages
            .language_for_name("Markdown");

        let thread = self.thread.read(cx);
        let thread_title = thread
            .title()
            .unwrap_or_else(|| DEFAULT_THREAD_TITLE.into())
            .to_string();
        let markdown = thread.to_markdown(cx);

        let project = workspace.read(cx).project().clone();
        window.spawn(cx, async move |cx| {
            let markdown_language = markdown_language_task.await?;

            let buffer = project
                .update(cx, |project, cx| {
                    project.create_buffer(Some(markdown_language), false, cx)
                })
                .await?;

            buffer.update(cx, |buffer, cx| {
                buffer.set_text(markdown, cx);
                buffer.set_capability(language::Capability::ReadWrite, cx);
            });

            workspace.update_in(cx, |workspace, window, cx| {
                let buffer = cx
                    .new(|cx| MultiBuffer::singleton(buffer, cx).with_title(thread_title.clone()));

                workspace.add_item_to_active_pane(
                    Box::new(cx.new(|cx| {
                        let mut editor =
                            Editor::for_multibuffer(buffer, Some(project.clone()), window, cx);
                        editor.set_breadcrumb_header(thread_title);
                        editor.disable_mouse_wheel_zoom();
                        editor
                    })),
                    None,
                    true,
                    window,
                    cx,
                );
            })?;
            anyhow::Ok(())
        })
    }

    pub(crate) fn sync_editor_mode_for_empty_state(&mut self, cx: &mut Context<Self>) {
        let has_messages = self.list_state.item_count() > 0;
        let v2_empty_state = !has_messages;

        let mode = if v2_empty_state {
            EditorMode::Full {
                scale_ui_elements_with_buffer_font_size: false,
                show_active_line_background: false,
                sizing_behavior: SizingBehavior::Default,
            }
        } else {
            EditorMode::AutoHeight {
                min_lines: AgentSettings::get_global(cx).message_editor_min_lines,
                max_lines: Some(AgentSettings::get_global(cx).set_message_editor_max_lines()),
            }
        };
        self.message_editor.update(cx, |editor, cx| {
            editor.set_mode(mode, cx);
        });
    }

    /// Ensures the list item count includes (or excludes) an extra item for the generating indicator
    pub(crate) fn sync_generating_indicator(&mut self, cx: &App) {
        let is_generating = matches!(self.thread.read(cx).status(), ThreadStatus::Generating);

        if is_generating && !self.generating_indicator_in_list {
            let entries_count = self.thread.read(cx).entries().len();
            self.list_state.splice(entries_count..entries_count, 1);
            self.generating_indicator_in_list = true;
        } else if !is_generating && self.generating_indicator_in_list {
            let entries_count = self.thread.read(cx).entries().len();
            self.list_state.splice(entries_count..entries_count + 1, 0);
            self.generating_indicator_in_list = false;
        }
    }

    fn render_generating(&self, confirmation: bool, cx: &App) -> impl IntoElement {
        let show_stats = AgentSettings::get_global(cx).show_turn_stats;
        let elapsed_label = show_stats
            .then(|| {
                self.turn_fields.turn_started_at.and_then(|started_at| {
                    let elapsed = started_at.elapsed();
                    (elapsed > STOPWATCH_THRESHOLD).then(|| duration_alt_display(elapsed))
                })
            })
            .flatten();

        let is_blocked_on_terminal_command =
            !confirmation && self.is_blocked_on_terminal_command(cx);
        let is_waiting = confirmation || self.thread.read(cx).has_in_progress_tool_calls();

        let turn_tokens_label = elapsed_label
            .is_some()
            .then(|| {
                self.turn_fields
                    .turn_tokens
                    .filter(|&tokens| tokens > TOKEN_THRESHOLD)
                    .map(|tokens| crate::humanize_token_count(tokens))
            })
            .flatten();

        let arrow_icon = if is_waiting {
            IconName::ArrowUp
        } else {
            IconName::ArrowDown
        };
        let status_label = if confirmation {
            None
        } else if is_blocked_on_terminal_command {
            Some("Command running")
        } else if is_waiting {
            Some("Thinking")
        } else {
            Some("Streaming")
        };

        h_flex()
            .id("generating-spinner")
            .py_2()
            .px(rems_from_px(22.))
            .gap_2()
            .items_center()
            .map(|this| {
                if confirmation {
                    this.child(
                        h_flex()
                            .w_2()
                            .justify_center()
                            .child(GeneratingSpinnerElement::new(SpinnerVariant::Sand)),
                    )
                    .child(
                        div().min_w(rems(8.)).child(
                            LoadingLabel::new("Awaiting Confirmation")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                    )
                } else if is_blocked_on_terminal_command {
                    this
                } else {
                    this.child(
                        h_flex()
                            .w_2()
                            .justify_center()
                            .child(GeneratingSpinnerElement::new(SpinnerVariant::Dots)),
                    )
                }
            })
            .children(status_label.map(|label| {
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Muted)
                    .into_any_element()
            }))
            .when_some(elapsed_label, |this, elapsed| {
                this.child(
                    Label::new(elapsed)
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
            })
            .when_some(turn_tokens_label, |this, tokens| {
                this.child(
                    h_flex()
                        .gap_0p5()
                        .child(
                            Icon::new(arrow_icon)
                                .size(IconSize::XSmall)
                                .color(Color::Muted),
                        )
                        .child(
                            Label::new(format!("{} tokens", tokens))
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                )
            })
            .into_any_element()
    }

    pub(crate) fn auto_expand_streaming_thought(&mut self, cx: &mut Context<Self>) {
        let thinking_display = AgentSettings::get_global(cx).thinking_display;

        if !matches!(
            thinking_display,
            ThinkingBlockDisplay::Auto | ThinkingBlockDisplay::Preview
        ) {
            return;
        }

        let key = {
            let thread = self.thread.read(cx);
            if thread.status() != ThreadStatus::Generating {
                return;
            }
            let entries = thread.entries();
            let last_ix = entries.len().saturating_sub(1);
            match entries.get(last_ix) {
                Some(AgentThreadEntry::AssistantMessage(msg)) => match msg.chunks.last() {
                    Some(AssistantMessageChunk::Thought { .. }) => {
                        Some((last_ix, msg.chunks.len() - 1))
                    }
                    _ => None,
                },
                _ => None,
            }
        };

        if let Some(key) = key {
            if self.auto_expanded_thinking_block != Some(key) {
                self.auto_expanded_thinking_block = Some(key);
                self.expanded_thinking_blocks.insert(key);
                cx.notify();
            }
        } else if self.auto_expanded_thinking_block.is_some() {
            if thinking_display == ThinkingBlockDisplay::Auto {
                if let Some(key) = self.auto_expanded_thinking_block {
                    if !self.user_toggled_thinking_blocks.contains(&key) {
                        self.expanded_thinking_blocks.remove(&key);
                    }
                }
            }
            self.auto_expanded_thinking_block = None;
            cx.notify();
        }
    }

    pub(crate) fn clear_auto_expand_tracking(&mut self) {
        self.auto_expanded_thinking_block = None;
    }

    fn toggle_thinking_block_expansion(&mut self, key: (usize, usize), cx: &mut Context<Self>) {
        let thinking_display = AgentSettings::get_global(cx).thinking_display;

        match thinking_display {
            ThinkingBlockDisplay::Auto => {
                let is_open = self.expanded_thinking_blocks.contains(&key)
                    || self.user_toggled_thinking_blocks.contains(&key);

                if is_open {
                    self.expanded_thinking_blocks.remove(&key);
                    self.user_toggled_thinking_blocks.remove(&key);
                } else {
                    self.expanded_thinking_blocks.insert(key);
                    self.user_toggled_thinking_blocks.insert(key);
                }
            }
            ThinkingBlockDisplay::Preview => {
                let is_user_expanded = self.user_toggled_thinking_blocks.contains(&key);
                let is_in_expanded_set = self.expanded_thinking_blocks.contains(&key);

                if is_user_expanded {
                    self.user_toggled_thinking_blocks.remove(&key);
                    self.expanded_thinking_blocks.remove(&key);
                } else if is_in_expanded_set {
                    self.user_toggled_thinking_blocks.insert(key);
                } else {
                    self.expanded_thinking_blocks.insert(key);
                    self.user_toggled_thinking_blocks.insert(key);
                }
            }
            ThinkingBlockDisplay::AlwaysExpanded => {
                if self.user_toggled_thinking_blocks.contains(&key) {
                    self.user_toggled_thinking_blocks.remove(&key);
                } else {
                    self.user_toggled_thinking_blocks.insert(key);
                }
            }
            ThinkingBlockDisplay::AlwaysCollapsed => {
                if self.user_toggled_thinking_blocks.contains(&key) {
                    self.user_toggled_thinking_blocks.remove(&key);
                    self.expanded_thinking_blocks.remove(&key);
                } else {
                    self.expanded_thinking_blocks.insert(key);
                    self.user_toggled_thinking_blocks.insert(key);
                }
            }
        }

        cx.notify();
    }

    fn render_thinking_block(
        &self,
        entry_ix: usize,
        chunk_ix: usize,
        chunk: Entity<Markdown>,
        model_label: Option<SharedString>,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let header_id = SharedString::from(format!("thinking-block-header-{}", entry_ix));
        let card_header_id = SharedString::from("inner-card-header");

        let key = (entry_ix, chunk_ix);

        let thinking_display = AgentSettings::get_global(cx).thinking_display;
        let is_user_toggled = self.user_toggled_thinking_blocks.contains(&key);
        let is_in_expanded_set = self.expanded_thinking_blocks.contains(&key);

        let (is_open, is_constrained) = match thinking_display {
            ThinkingBlockDisplay::Auto => {
                let is_open = is_user_toggled || is_in_expanded_set;
                (is_open, false)
            }
            ThinkingBlockDisplay::Preview => {
                let is_open = is_user_toggled || is_in_expanded_set;
                let is_constrained = is_in_expanded_set && !is_user_toggled;
                (is_open, is_constrained)
            }
            ThinkingBlockDisplay::AlwaysExpanded => (!is_user_toggled, false),
            ThinkingBlockDisplay::AlwaysCollapsed => (is_user_toggled, false),
        };

        let should_auto_scroll = self.auto_expanded_thinking_block == Some(key);

        let scroll_handle = self
            .entry_view_state
            .read(cx)
            .entry(entry_ix)
            .and_then(|entry| entry.scroll_handle_for_assistant_message_chunk(chunk_ix));

        if should_auto_scroll {
            if let Some(ref handle) = scroll_handle {
                handle.scroll_to_bottom();
            }
        }

        let panel_bg = cx.theme().colors().panel_background;

        v_flex()
            .gap_0p5()
            .opacity(0.72)
            .child(
                h_flex()
                    .id(header_id)
                    .group(&card_header_id)
                    .relative()
                    .w_full()
                    .pr_1()
                    .justify_between()
                    .child(
                        h_flex()
                            .h(window.line_height() - px(4.))
                            .gap_1()
                            .overflow_hidden()
                            .child(self.render_backboard_logo(px(12.)))
                            .child(
                                h_flex()
                                    .gap_0p5()
                                    .overflow_hidden()
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().colors().text_muted)
                                            .child("Backboard thinking"),
                                    )
                                    .when_some(model_label, |this, model| {
                                        this.child(
                                            Label::new(model)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Muted),
                                        )
                                    }),
                            ),
                    )
                    .child(
                        Disclosure::new(("expand", entry_ix), is_open)
                            .opened_icon(IconName::ChevronUp)
                            .closed_icon(IconName::ChevronDown)
                            .visible_on_hover(&card_header_id)
                            .on_click(cx.listener(
                                move |this, _event: &ClickEvent, _window, cx| {
                                    this.toggle_thinking_block_expansion(key, cx);
                                },
                            )),
                    )
                    .on_click(cx.listener(move |this, _event: &ClickEvent, _window, cx| {
                        this.toggle_thinking_block_expansion(key, cx);
                    })),
            )
            .when(is_open, |this| {
                this.child(
                    div()
                        .when(is_constrained, |this| this.relative())
                        .child(
                            div()
                                .id(("thinking-content", chunk_ix))
                                .ml_1()
                                .pl_2()
                                .border_l_1()
                                .border_color(self.tool_card_border_color(cx).opacity(0.6))
                                .text_xs()
                                .when(is_constrained, |this| this.max_h_64())
                                .when_some(scroll_handle, |this, scroll_handle| {
                                    this.track_scroll(&scroll_handle)
                                })
                                .overflow_hidden()
                                .child(self.render_markdown(
                                    chunk,
                                    MarkdownStyle::themed(MarkdownFont::Agent, window, cx),
                                )),
                        )
                        .when(is_constrained, |this| {
                            this.child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .size_full()
                                    .bg(linear_gradient(
                                        180.,
                                        linear_color_stop(panel_bg.opacity(0.8), 0.),
                                        linear_color_stop(panel_bg.opacity(0.), 0.1),
                                    ))
                                    .block_mouse_except_scroll(),
                            )
                        }),
                )
            })
            .into_any_element()
    }

    fn render_message_context_menu(
        &self,
        entry_ix: usize,
        message_body: AnyElement,
        cx: &Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let workspace = self.workspace.clone();

        right_click_menu(format!("agent_context_menu-{}", entry_ix))
            .trigger(move |_, _, _| message_body)
            .menu(move |window, cx| {
                let focus = window.focused(cx);
                let entity = entity.clone();
                let workspace = workspace.clone();

                ContextMenu::build(window, cx, move |menu, _, cx| {
                    let this = entity.read(cx);
                    let is_at_top = this.list_state.logical_scroll_top().item_ix == 0;

                    let chunks =
                        this.thread.read(cx).entries().get(entry_ix).and_then(
                            |entry| match &entry {
                                AgentThreadEntry::AssistantMessage(msg) => Some(&msg.chunks),
                                _ => None,
                            },
                        );

                    let has_selection = chunks
                        .map(|chunks| {
                            chunks.iter().any(|chunk| {
                                let md = match chunk {
                                    AssistantMessageChunk::Message { block } => block.markdown(),
                                    AssistantMessageChunk::Thought { block } => block.markdown(),
                                };
                                md.map_or(false, |m| m.read(cx).selected_text().is_some())
                            })
                        })
                        .unwrap_or(false);

                    let context_menu_link = chunks.and_then(|chunks| {
                        chunks.iter().find_map(|chunk| {
                            let md = match chunk {
                                AssistantMessageChunk::Message { block } => block.markdown(),
                                AssistantMessageChunk::Thought { block } => block.markdown(),
                            };
                            md.and_then(|m| m.read(cx).context_menu_link().cloned())
                        })
                    });

                    let copy_this_agent_response =
                        ContextMenuEntry::new("Copy This Agent Response").handler({
                            let entity = entity.clone();
                            move |_, cx| {
                                entity.update(cx, |this, cx| {
                                    let entries = this.thread.read(cx).entries();
                                    if let Some(text) =
                                        Self::get_agent_message_content(entries, entry_ix, cx)
                                    {
                                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                                    }
                                });
                            }
                        });

                    let scroll_item = if is_at_top {
                        ContextMenuEntry::new("Scroll to Bottom").handler({
                            let entity = entity.clone();
                            move |_, cx| {
                                entity.update(cx, |this, cx| {
                                    this.scroll_to_end(cx);
                                });
                            }
                        })
                    } else {
                        ContextMenuEntry::new("Scroll to Top").handler({
                            let entity = entity.clone();
                            move |_, cx| {
                                entity.update(cx, |this, cx| {
                                    this.scroll_to_top(cx);
                                });
                            }
                        })
                    };

                    let open_thread_as_markdown = ContextMenuEntry::new("Open Thread as Markdown")
                        .handler({
                            let entity = entity.clone();
                            let workspace = workspace.clone();
                            move |window, cx| {
                                if let Some(workspace) = workspace.upgrade() {
                                    entity
                                        .update(cx, |this, cx| {
                                            this.open_thread_as_markdown(workspace, window, cx)
                                        })
                                        .detach_and_log_err(cx);
                                }
                            }
                        });

                    menu.when_some(focus, |menu, focus| menu.context(focus))
                        .when_some(context_menu_link, |menu, url| {
                            menu.entry("Copy Link", None, move |_, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(url.to_string()));
                            })
                            .separator()
                        })
                        .action_disabled_when(
                            !has_selection,
                            "Copy Selection",
                            Box::new(markdown::CopyAsMarkdown),
                        )
                        .item(copy_this_agent_response)
                        .separator()
                        .item(scroll_item)
                        .item(open_thread_as_markdown)
                })
            })
            .into_any_element()
    }

    fn get_agent_message_content(
        entries: &[AgentThreadEntry],
        entry_index: usize,
        cx: &App,
    ) -> Option<String> {
        let entry = entries.get(entry_index)?;
        if matches!(entry, AgentThreadEntry::UserMessage(_)) {
            return None;
        }

        let start_index = (0..entry_index)
            .rev()
            .find(|&i| matches!(entries.get(i), Some(AgentThreadEntry::UserMessage(_))))
            .map(|i| i + 1)
            .unwrap_or(0);

        let end_index = (entry_index + 1..entries.len())
            .find(|&i| matches!(entries.get(i), Some(AgentThreadEntry::UserMessage(_))))
            .map(|i| i - 1)
            .unwrap_or(entries.len() - 1);

        let parts: Vec<String> = (start_index..=end_index)
            .filter_map(|i| entries.get(i))
            .filter_map(|entry| {
                if let AgentThreadEntry::AssistantMessage(message) = entry {
                    let text: String = message
                        .chunks
                        .iter()
                        .filter_map(|chunk| match chunk {
                            AssistantMessageChunk::Message { block } => {
                                let markdown = block.to_markdown(cx);
                                if markdown.trim().is_empty() {
                                    None
                                } else {
                                    Some(markdown.to_string())
                                }
                            }
                            AssistantMessageChunk::Thought { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");

                    if text.is_empty() { None } else { Some(text) }
                } else {
                    None
                }
            })
            .collect();

        let text = parts.join("\n\n");
        if text.is_empty() { None } else { Some(text) }
    }

    fn is_blocked_on_terminal_command(&self, cx: &App) -> bool {
        let thread = self.thread.read(cx);
        if !matches!(thread.status(), ThreadStatus::Generating) {
            return false;
        }

        let mut has_running_terminal_call = false;

        for entry in thread.entries().iter().rev() {
            match entry {
                AgentThreadEntry::UserMessage(_) => break,
                AgentThreadEntry::ToolCall(tool_call)
                    if matches!(
                        tool_call.status,
                        ToolCallStatus::InProgress | ToolCallStatus::Pending
                    ) =>
                {
                    if matches!(tool_call.kind, acp::ToolKind::Execute) {
                        has_running_terminal_call = true;
                    } else {
                        return false;
                    }
                }
                AgentThreadEntry::ToolCall(_)
                | AgentThreadEntry::AssistantMessage(_)
                | AgentThreadEntry::CompletedPlan(_) => {}
            }
        }

        has_running_terminal_call
    }

    fn render_collapsible_command(
        &self,
        group: SharedString,
        is_preview: bool,
        command: Entity<Markdown>,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        // The label's markdown source is a fenced code block (```\n...\n```);
        // strip the fences so the copy button yields just the command text.
        let command_source = command.read(cx).source();
        let command_text = Self::markdown_code_block_text(&command_source);

        let mut style = MarkdownStyle::themed(MarkdownFont::Agent, window, cx).with_buffer_font(cx);
        style.container_style.text.font_size = Some(rems_from_px(11.).into());
        style.container_style.text.line_height = Some(rems_from_px(15.).into());
        style.height_is_multiple_of_line_height = true;

        let header_bg = self.tool_card_header_bg(cx);
        let run_command_label = if is_preview {
            Some(
                h_flex().h_6().child(
                    Label::new("Run Command")
                        .buffer_font(cx)
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                ),
            )
        } else {
            None
        };
        // Suppress the code block's built-in copy button so we don't stack two
        // copy buttons on top of each other; the outer button below is the one
        // we want, because it copies the unfenced command text.
        let markdown_element =
            self.render_markdown(command, style)
                .code_block_renderer(CodeBlockRenderer::Default {
                    copy_button_visibility: CopyButtonVisibility::Hidden,
                    border: false,
                });
        let copy_button = CopyButton::new("copy-command", command_text)
            .tooltip_label("Copy Command")
            .visible_on_hover(group.clone());

        v_flex()
            .group(group)
            .relative()
            .p_1()
            .bg(header_bg)
            .when(is_preview, |this| this.pt_0p5().children(run_command_label))
            .child(markdown_element)
            .child(div().absolute().top_1().right_1().child(copy_button))
    }

    fn markdown_code_block_text(source: &str) -> String {
        let trimmed = source.trim();
        if !trimmed.starts_with("```") {
            return source.to_string();
        }

        let mut lines = trimmed.lines();
        lines.next();
        lines
            .take_while(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn render_terminal_tool_call(
        &self,
        active_session_id: &acp::SessionId,
        entry_ix: usize,
        terminal: &Entity<acp_thread::Terminal>,
        tool_call: &ToolCall,
        focus_handle: &FocusHandle,
        is_subagent: bool,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let terminal_data = terminal.read(cx);
        let working_dir = terminal_data.working_dir();
        let started_at = terminal_data.started_at();

        let tool_failed = matches!(
            &tool_call.status,
            ToolCallStatus::Rejected | ToolCallStatus::Canceled | ToolCallStatus::Failed
        );

        let confirmation_options = match &tool_call.status {
            ToolCallStatus::WaitingForConfirmation { options, .. } => Some(options),
            _ => None,
        };
        let needs_confirmation = confirmation_options.is_some();

        let output = terminal_data.output();
        let command_finished = output.is_some()
            && !matches!(
                tool_call.status,
                ToolCallStatus::InProgress | ToolCallStatus::Pending
            );
        let truncated_output =
            output.is_some_and(|output| output.original_content_len > output.content.len());
        let output_line_count = output.map(|output| output.content_line_count).unwrap_or(0);

        let command_failed = command_finished
            && output.is_some_and(|o| o.exit_status.is_some_and(|status| !status.success()));

        let time_elapsed = if let Some(output) = output {
            output.ended_at.duration_since(started_at)
        } else {
            started_at.elapsed()
        };

        let header_id =
            SharedString::from(format!("terminal-tool-header-{}", terminal.entity_id()));
        let header_group = SharedString::from(format!(
            "terminal-tool-header-group-{}",
            terminal.entity_id()
        ));
        let header_bg = self.tool_card_header_bg(cx);
        let border_color = self.tool_card_border_color(cx);

        let working_dir = working_dir
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "current directory".to_string());

        let command_element = self.render_collapsible_command(
            header_group.clone(),
            false,
            tool_call.label.clone(),
            window,
            cx,
        );

        let is_expanded = self.command_details_expanded.contains(&tool_call.id);

        let header = h_flex()
            .id(header_id)
            .py_0p5()
            .pl_1()
            .pr_0p5()
            .flex_none()
            .gap_1()
            .justify_between()
            .child(
                h_flex()
                    .id(("command-summary", terminal.entity_id()))
                    .min_w_0()
                    .flex_1()
                    .gap_1p5()
                    .items_center()
                    .child(
                        Icon::new(IconName::ToolTerminal)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(if needs_confirmation {
                            "Approve command"
                        } else if !command_finished {
                            "Running command"
                        } else if command_failed {
                            "Command failed"
                        } else {
                            "Command complete"
                        })
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(working_dir.clone())
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .truncate_start()
                            .flex_1(),
                    )
                    .tooltip(Tooltip::text("Command details are hidden by default.")),
            )
            .child(
                Disclosure::new(
                    SharedString::from(format!(
                        "terminal-tool-disclosure-{}",
                        terminal.entity_id()
                    )),
                    is_expanded,
                )
                .opened_icon(IconName::ChevronUp)
                .closed_icon(IconName::ChevronDown)
                .visible_on_hover(&header_group)
                .on_click(cx.listener({
                    let id = tool_call.id.clone();
                    move |this, _event, _window, cx| {
                        if is_expanded {
                            this.command_details_expanded.remove(&id);
                        } else {
                            this.command_details_expanded.insert(id.clone());
                        }
                        cx.notify();
                    }
                })),
            )
            .when(time_elapsed > Duration::from_secs(10), |header| {
                header.child(
                    Label::new(format!("({})", duration_alt_display(time_elapsed)))
                        .buffer_font(cx)
                        .color(Color::Muted)
                        .size(LabelSize::XSmall),
                )
            })
            .when(!command_finished && !needs_confirmation, |header| {
                header
                    .gap_1p5()
                    .child(
                        Icon::new(IconName::ArrowCircle)
                            .size(IconSize::XSmall)
                            .color(Color::Muted)
                            .with_rotate_animation(2)
                    )
                    .child(div().h(relative(0.6)).ml_1p5().child(Divider::vertical().color(DividerColor::Border)))
                    .child(
                        IconButton::new(
                            SharedString::from(format!("stop-terminal-{}", terminal.entity_id())),
                            IconName::Stop
                        )
                        .icon_size(IconSize::Small)
                        .icon_color(Color::Error)
                        .tooltip(move |_window, cx| {
                            Tooltip::with_meta(
                                "Stop This Command",
                                None,
                                "Also possible by placing your cursor inside the terminal and using regular terminal bindings.",
                                cx,
                            )
                        })
                        .on_click({
                            let terminal = terminal.clone();
                            cx.listener(move |this, _event, _window, cx| {
                                terminal.update(cx, |terminal, cx| {
                                    terminal.stop_by_user(cx);
                                });
                                if AgentSettings::get_global(cx).cancel_generation_on_terminal_stop {
                                    this.cancel_generation(cx);
                                }
                            })
                        }),
                    )
            })
            .when(truncated_output, |header| {
                let tooltip = if let Some(output) = output {
                    if output_line_count + 10 > terminal::MAX_SCROLL_HISTORY_LINES {
                       format!("Output exceeded terminal max lines and was \
                            truncated, the model received the first {}.", format_file_size(output.content.len() as u64, true))
                    } else {
                        format!(
                            "Output is {} long, and to avoid unexpected token usage, \
                                only {} was sent back to the agent.",
                            format_file_size(output.original_content_len as u64, true),
                             format_file_size(output.content.len() as u64, true)
                        )
                    }
                } else {
                    "Output was truncated".to_string()
                };

                header.child(
                    h_flex()
                        .id(("terminal-tool-truncated-label", terminal.entity_id()))
                        .gap_1()
                        .child(
                            Icon::new(IconName::Info)
                                .size(IconSize::XSmall)
                                .color(Color::Ignored),
                        )
                        .child(
                            Label::new("Truncated")
                                .color(Color::Muted)
                                .size(LabelSize::XSmall),
                        )
                        .tooltip(Tooltip::text(tooltip)),
                )
            })
            .when(tool_failed || command_failed, |header| {
                header.child(
                    div()
                        .id(("terminal-tool-error-code-indicator", terminal.entity_id()))
                        .child(
                            Icon::new(IconName::Close)
                                .size(IconSize::Small)
                                .color(Color::Error),
                        )
                        .when_some(output.and_then(|o| o.exit_status), |this, status| {
                            this.tooltip(Tooltip::text(format!(
                                "Exited with code {}",
                                status.code().unwrap_or(-1),
                            )))
                        }),
                )
            })
;

        let terminal_view = self
            .entry_view_state
            .read(cx)
            .entry(entry_ix)
            .and_then(|entry| entry.terminal(terminal));

        v_flex()
            .when(!is_subagent, |this| {
                this.my_0p5()
                    .mx(rems_from_px(14.))
                    .border_1()
                    .when(tool_failed || command_failed, |card| card.border_dashed())
                    .border_color(border_color)
                    .rounded(rems_from_px(6.))
            })
            .overflow_hidden()
            .child(
                v_flex()
                    .group(&header_group)
                    .bg(header_bg)
                    .text_xs()
                    .child(header)
                    .when(is_expanded || needs_confirmation, |this| {
                        this.child(command_element)
                    }),
            )
            .when(is_expanded && terminal_view.is_some(), |this| {
                this.child(
                    div()
                        .pt_1()
                        .border_t_1()
                        .when(tool_failed || command_failed, |card| card.border_dashed())
                        .border_color(border_color)
                        .bg(cx
                            .theme()
                            .colors()
                            .editor_background
                            .blend(cx.theme().colors().panel_background.opacity(0.18)))
                        .text_ui_sm(cx)
                        .h_full()
                        .children(terminal_view.map(|terminal_view| {
                            let element = if terminal_view
                                .read(cx)
                                .content_mode(window, cx)
                                .is_scrollable()
                            {
                                div().h_72().child(terminal_view).into_any_element()
                            } else {
                                terminal_view.into_any_element()
                            };

                            div()
                                .on_action(cx.listener(|_this, _: &NewTerminal, window, cx| {
                                    window.dispatch_action(NewThread.boxed_clone(), cx);
                                    cx.stop_propagation();
                                }))
                                .child(element)
                                .into_any_element()
                        })),
                )
            })
            .when_some(confirmation_options, |this, options| {
                let is_first = self.is_first_tool_call(active_session_id, &tool_call.id, cx);
                this.child(self.render_permission_buttons(
                    self.thread.read(cx).session_id().clone(),
                    is_first,
                    options,
                    entry_ix,
                    tool_call.id.clone(),
                    focus_handle,
                    cx,
                ))
            })
            .into_any()
    }

    fn is_first_tool_call(
        &self,
        active_session_id: &acp::SessionId,
        tool_call_id: &acp::ToolCallId,
        cx: &App,
    ) -> bool {
        self.conversation
            .read(cx)
            .pending_tool_call(active_session_id, cx)
            .map_or(false, |(pending_session_id, pending_tool_call_id, _)| {
                self.thread.read(cx).session_id() == &pending_session_id
                    && tool_call_id == &pending_tool_call_id
            })
    }

    fn render_any_tool_call(
        &self,
        active_session_id: &acp::SessionId,
        entry_ix: usize,
        tool_call: &ToolCall,
        focus_handle: &FocusHandle,
        is_subagent: bool,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        let has_terminals = tool_call.terminals().next().is_some();

        div().w_full().map(|this| {
            if tool_call.is_subagent() {
                this.child(
                    self.render_subagent_tool_call(
                        active_session_id,
                        entry_ix,
                        tool_call,
                        tool_call
                            .subagent_session_info
                            .as_ref()
                            .map(|i| i.session_id.clone()),
                        focus_handle,
                        window,
                        cx,
                    ),
                )
            } else if has_terminals {
                this.children(tool_call.terminals().map(|terminal| {
                    self.render_terminal_tool_call(
                        active_session_id,
                        entry_ix,
                        terminal,
                        tool_call,
                        focus_handle,
                        is_subagent,
                        window,
                        cx,
                    )
                }))
            } else {
                this.child(self.render_tool_call(
                    active_session_id,
                    entry_ix,
                    tool_call,
                    focus_handle,
                    is_subagent,
                    window,
                    cx,
                ))
            }
        })
    }

    fn render_tool_call(
        &self,
        active_session_id: &acp::SessionId,
        entry_ix: usize,
        tool_call: &ToolCall,
        focus_handle: &FocusHandle,
        is_subagent: bool,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        let card_header_id = SharedString::from("inner-tool-call-header");

        let failed_or_canceled = match &tool_call.status {
            ToolCallStatus::Rejected | ToolCallStatus::Canceled | ToolCallStatus::Failed => true,
            _ => false,
        };

        let needs_confirmation = matches!(
            tool_call.status,
            ToolCallStatus::WaitingForConfirmation { .. }
        );
        let is_terminal_tool = matches!(tool_call.kind, acp::ToolKind::Execute);

        let is_edit =
            matches!(tool_call.kind, acp::ToolKind::Edit) || tool_call.diffs().next().is_some();

        let is_cancelled_edit = is_edit && matches!(tool_call.status, ToolCallStatus::Canceled);
        let (has_revealed_diff, tool_call_output_focus, tool_call_output_focus_handle) = tool_call
            .diffs()
            .next()
            .and_then(|diff| {
                let editor = self
                    .entry_view_state
                    .read(cx)
                    .entry(entry_ix)
                    .and_then(|entry| entry.editor_for_diff(diff))?;
                let has_revealed_diff = diff.read(cx).has_revealed_range(cx);
                let has_focus = editor.read(cx).is_focused(window);
                let focus_handle = editor.focus_handle(cx);
                Some((has_revealed_diff, has_focus, focus_handle))
            })
            .unwrap_or_else(|| (false, false, focus_handle.clone()));

        let use_card_layout = needs_confirmation || is_edit || is_terminal_tool;
        let use_card_layout = use_card_layout
            || matches!(
                tool_call.status,
                ToolCallStatus::Pending
                    | ToolCallStatus::InProgress
                    | ToolCallStatus::Completed
                    | ToolCallStatus::Failed
                    | ToolCallStatus::Canceled
            );

        let has_image_content = tool_call.content.iter().any(|c| c.image().is_some());
        let is_collapsible = !tool_call.content.is_empty() && !needs_confirmation;
        let mut is_open = if is_terminal_tool {
            self.command_details_expanded.contains(&tool_call.id)
        } else {
            self.expanded_tool_calls.contains(&tool_call.id)
        };

        is_open |= needs_confirmation;

        let should_show_raw_input = !is_terminal_tool && !is_edit && !has_image_content;

        let input_output_header = |label: SharedString| {
            Label::new(label)
                .size(LabelSize::XSmall)
                .color(Color::Muted)
                .buffer_font(cx)
        };

        let tool_output_display = if is_open {
            match &tool_call.status {
                ToolCallStatus::WaitingForConfirmation { options, .. } => v_flex()
                    .w_full()
                    .children(
                        tool_call
                            .content
                            .iter()
                            .enumerate()
                            .map(|(content_ix, content)| {
                                div()
                                    .child(self.render_tool_call_content(
                                        active_session_id,
                                        entry_ix,
                                        content,
                                        content_ix,
                                        tool_call,
                                        use_card_layout,
                                        has_image_content,
                                        failed_or_canceled,
                                        focus_handle,
                                        window,
                                        cx,
                                    ))
                                    .into_any_element()
                            }),
                    )
                    .when(should_show_raw_input, |this| {
                        let is_raw_input_expanded =
                            self.expanded_tool_call_raw_inputs.contains(&tool_call.id);

                        let input_header = if is_raw_input_expanded {
                            "Raw Input:"
                        } else {
                            "View Raw Input"
                        };

                        this.child(
                            v_flex()
                                .p_2()
                                .gap_1()
                                .border_t_1()
                                .border_color(self.tool_card_border_color(cx))
                                .child(
                                    h_flex()
                                        .id("disclosure_container")
                                        .pl_0p5()
                                        .gap_1()
                                        .justify_between()
                                        .rounded_xs()
                                        .hover(|s| s.bg(cx.theme().colors().element_hover))
                                        .child(input_output_header(input_header.into()))
                                        .child(
                                            Disclosure::new(
                                                ("raw-input-disclosure", entry_ix),
                                                is_raw_input_expanded,
                                            )
                                            .opened_icon(IconName::ChevronUp)
                                            .closed_icon(IconName::ChevronDown),
                                        )
                                        .on_click(cx.listener({
                                            let id = tool_call.id.clone();

                                            move |this: &mut Self, _, _, cx| {
                                                if this.expanded_tool_call_raw_inputs.contains(&id)
                                                {
                                                    this.expanded_tool_call_raw_inputs.remove(&id);
                                                } else {
                                                    this.expanded_tool_call_raw_inputs
                                                        .insert(id.clone());
                                                }
                                                cx.notify();
                                            }
                                        })),
                                )
                                .when(is_raw_input_expanded, |this| {
                                    this.children(tool_call.raw_input_markdown.clone().map(
                                        |input| {
                                            self.render_markdown(
                                                input,
                                                MarkdownStyle::themed(
                                                    MarkdownFont::Agent,
                                                    window,
                                                    cx,
                                                ),
                                            )
                                        },
                                    ))
                                }),
                        )
                    })
                    .child(self.render_permission_buttons(
                        self.thread.read(cx).session_id().clone(),
                        self.is_first_tool_call(active_session_id, &tool_call.id, cx),
                        options,
                        entry_ix,
                        tool_call.id.clone(),
                        focus_handle,
                        cx,
                    ))
                    .into_any(),
                ToolCallStatus::Pending | ToolCallStatus::InProgress
                    if is_edit
                        && tool_call.content.is_empty()
                        && self.as_native_connection(cx).is_some() =>
                {
                    self.render_diff_loading(cx)
                }
                ToolCallStatus::Pending
                | ToolCallStatus::InProgress
                | ToolCallStatus::Completed
                | ToolCallStatus::Failed
                | ToolCallStatus::Canceled => v_flex()
                    .when(should_show_raw_input, |this| {
                        this.mt_1p5().w_full().child(
                            v_flex()
                                .ml(rems(0.4))
                                .px_3p5()
                                .pb_1()
                                .gap_1()
                                .border_l_1()
                                .border_color(self.tool_card_border_color(cx))
                                .child(input_output_header("Raw Input:".into()))
                                .children(tool_call.raw_input_markdown.clone().map(|input| {
                                    div().id(("tool-call-raw-input-markdown", entry_ix)).child(
                                        self.render_markdown(
                                            input,
                                            MarkdownStyle::themed(MarkdownFont::Agent, window, cx),
                                        ),
                                    )
                                }))
                                .child(input_output_header("Output:".into())),
                        )
                    })
                    .children(
                        tool_call
                            .content
                            .iter()
                            .enumerate()
                            .map(|(content_ix, content)| {
                                div().id(("tool-call-output", entry_ix)).child(
                                    self.render_tool_call_content(
                                        active_session_id,
                                        entry_ix,
                                        content,
                                        content_ix,
                                        tool_call,
                                        use_card_layout,
                                        has_image_content,
                                        failed_or_canceled,
                                        focus_handle,
                                        window,
                                        cx,
                                    ),
                                )
                            }),
                    )
                    .into_any(),
                ToolCallStatus::Rejected => Empty.into_any(),
            }
            .into()
        } else {
            None
        };

        v_flex()
            .map(|this| {
                if is_subagent {
                    this
                } else if use_card_layout {
                    this.my_0p5()
                        .rounded(rems_from_px(6.))
                        .border_1()
                        .when(failed_or_canceled, |this| this.border_dashed())
                        .border_color(self.tool_card_border_color(cx))
                        .bg(
                            cx.theme()
                                .colors()
                                .editor_background
                                .blend(cx.theme().colors().element_background.opacity(0.04)),
                        )
                        .overflow_hidden()
                } else {
                    this.my_0p5()
                }
            })
            .when(!is_subagent, |this| {
                this.mx(rems_from_px(14.))
            })
            .map(|this| {
                if is_terminal_tool {
                    let command_status = match &tool_call.status {
                        ToolCallStatus::WaitingForConfirmation { .. } => "Approve command",
                        ToolCallStatus::Pending | ToolCallStatus::InProgress => "Running command",
                        ToolCallStatus::Failed | ToolCallStatus::Rejected => "Command failed",
                        ToolCallStatus::Canceled => "Command canceled",
                        ToolCallStatus::Completed => "Command complete",
                    };

                    this.child(
                        h_flex()
                            .group(&card_header_id)
                            .relative()
                            .w_full()
                            .justify_between()
                            .px_1()
                            .py_0p5()
                            .rounded_t(rems_from_px(5.))
                            .bg(self.tool_card_header_bg(cx))
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1()
                                    .items_center()
                                    .h(window.line_height() - px(2.))
                                    .child(
                                        Icon::new(IconName::ToolTerminal)
                                            .size(IconSize::XSmall)
                                            .color(Color::Muted),
                                    )
                                    .child(
                                        Label::new(command_status)
                                            .size(LabelSize::Custom(self.tool_name_font_size()))
                                            .color(Color::Muted),
                                    ),
                            )
                            .child(
                                h_flex().pr_0p5().when(is_collapsible, |this| {
                                    this.child(
                                        Disclosure::new(("expand-output", entry_ix), is_open)
                                            .opened_icon(IconName::ChevronUp)
                                            .closed_icon(IconName::ChevronDown)
                                            .visible_on_hover(&card_header_id)
                                            .on_click(cx.listener({
                                                let id = tool_call.id.clone();
                                                move |this: &mut Self, _, _, cx| {
                                                    if is_open {
                                                        this.command_details_expanded.remove(&id);
                                                    } else {
                                                        this.command_details_expanded
                                                            .insert(id.clone());
                                                    }
                                                    cx.notify();
                                                }
                                            })),
                                    )
                                }),
                            ),
                    )
                    .when(is_open || needs_confirmation, |this| {
                        this.child(self.render_collapsible_command(
                            card_header_id.clone(),
                            true,
                            tool_call.label.clone(),
                            window,
                            cx,
                        ))
                    })
                } else {
                    this.child(
                        h_flex()
                            .group(&card_header_id)
                            .relative()
                            .w_full()
                            .justify_between()
                            .when(use_card_layout, |this| {
                                this.p_0p5()
                                    .rounded_t(rems_from_px(6.))
                                    .bg(self.tool_card_header_bg(cx))
                            })
                            .child(self.render_tool_call_label(
                                entry_ix,
                                tool_call,
                                is_edit,
                                is_cancelled_edit,
                                has_revealed_diff,
                                use_card_layout,
                                window,
                                cx,
                            ))
                            .child(
                                h_flex()
                                    .when(is_collapsible || failed_or_canceled, |this| {
                                        let diff_for_discard = if has_revealed_diff
                                            && is_cancelled_edit
                                        {
                                            tool_call.diffs().next().cloned()
                                        } else {
                                            None
                                        };

                                        this.child(
                                            h_flex()
                                                .pr_0p5()
                                                .gap_1()
                                                .when(is_collapsible, |this| {
                                                    this.child(
                                                        Disclosure::new(
                                                            ("expand-output", entry_ix),
                                                            is_open,
                                                        )
                                                        .opened_icon(IconName::ChevronUp)
                                                        .closed_icon(IconName::ChevronDown)
                                                        .visible_on_hover(&card_header_id)
                                                        .on_click(cx.listener({
                                                            let id = tool_call.id.clone();
                                                            move |this: &mut Self,
                                                                  _,
                                                                  _,
                                                                  cx: &mut Context<Self>| {
                                                                if is_open {
                                                                    this.expanded_tool_calls
                                                                        .remove(&id);
                                                                } else {
                                                                    this.expanded_tool_calls
                                                                        .insert(id.clone());
                                                                }
                                                                cx.notify();
                                                            }
                                                        })),
                                                    )
                                                })
                                                .when(failed_or_canceled, |this| {
                                                    if is_cancelled_edit && !has_revealed_diff {
                                                        this.child(
                                                            div()
                                                                .id(entry_ix)
                                                                .tooltip(Tooltip::text(
                                                                    "Interrupted Edit",
                                                                ))
                                                                .child(
                                                                    Icon::new(IconName::XCircle)
                                                                        .color(Color::Muted)
                                                                        .size(IconSize::Small),
                                                                ),
                                                        )
                                                    } else if is_cancelled_edit {
                                                        this
                                                    } else {
                                                        this.child(
                                                            Icon::new(IconName::Close)
                                                                .color(Color::Error)
                                                                .size(IconSize::Small),
                                                        )
                                                    }
                                                })
                                                .when_some(diff_for_discard, |this, diff| {
                                                    let tool_call_id = tool_call.id.clone();
                                                    let is_discarded = self
                                                        .discarded_partial_edits
                                                        .contains(&tool_call_id);

                                                    this.when(!is_discarded, |this| {
                                                        this.child(
                                                            IconButton::new(
                                                                ("discard-partial-edit", entry_ix),
                                                                IconName::Undo,
                                                            )
                                                            .icon_size(IconSize::Small)
                                                            .tooltip(move |_, cx| {
                                                                Tooltip::with_meta(
                                                                    "Discard Interrupted Edit",
                                                                    None,
                                                                    "You can discard this interrupted partial edit and restore the original file content.",
                                                                    cx,
                                                                )
                                                            })
                                                            .on_click(cx.listener({
                                                                let tool_call_id =
                                                                    tool_call_id.clone();
                                                                move |this, _, _window, cx| {
                                                                    let diff_data = diff.read(cx);
                                                                    let base_text = diff_data
                                                                        .base_text()
                                                                        .clone();
                                                                    let buffer =
                                                                        diff_data.buffer().clone();
                                                                    buffer.update(
                                                                        cx,
                                                                        |buffer, cx| {
                                                                            buffer.set_text(
                                                                                base_text.as_ref(),
                                                                                cx,
                                                                            );
                                                                        },
                                                                    );
                                                                    this.discarded_partial_edits
                                                                        .insert(
                                                                            tool_call_id.clone(),
                                                                        );
                                                                    cx.notify();
                                                                }
                                                            })),
                                                        )
                                                    })
                                                }),
                                        )
                                    })
                                    .when(tool_call_output_focus, |this| {
                                        this.child(
                                            Button::new("open-file-button", "Open File")
                                                .style(ButtonStyle::Outlined)
                                                .label_size(LabelSize::Small)
                                                .key_binding(
                                                    KeyBinding::for_action_in(&OpenExcerpts, &tool_call_output_focus_handle, cx)
                                                        .map(|s| s.size(rems_from_px(12.))),
                                                )
                                                .on_click(|_, window, cx| {
                                                    window.dispatch_action(
                                                        Box::new(OpenExcerpts),
                                                        cx,
                                                    )
                                                }),
                                        )
                                    }),
                            )

                    )
                }
            })
            .children(tool_output_display)
    }

    fn render_permission_buttons(
        &self,
        session_id: acp::SessionId,
        is_first: bool,
        options: &PermissionOptions,
        entry_ix: usize,
        tool_call_id: acp::ToolCallId,
        focus_handle: &FocusHandle,
        cx: &Context<Self>,
    ) -> Div {
        match options {
            PermissionOptions::Flat(options) => self.render_permission_buttons_flat(
                session_id,
                is_first,
                options,
                entry_ix,
                tool_call_id,
                focus_handle,
                cx,
            ),
            PermissionOptions::Dropdown(choices) => self.render_permission_buttons_with_dropdown(
                is_first,
                choices,
                None,
                entry_ix,
                session_id,
                tool_call_id,
                focus_handle,
                cx,
            ),
            PermissionOptions::DropdownWithPatterns {
                choices,
                patterns,
                tool_name,
            } => self.render_permission_buttons_with_dropdown(
                is_first,
                choices,
                Some((patterns, tool_name)),
                entry_ix,
                session_id,
                tool_call_id,
                focus_handle,
                cx,
            ),
        }
    }

    fn render_permission_buttons_with_dropdown(
        &self,
        is_first: bool,
        choices: &[PermissionOptionChoice],
        patterns: Option<(&[PermissionPattern], &str)>,
        entry_ix: usize,
        session_id: acp::SessionId,
        tool_call_id: acp::ToolCallId,
        focus_handle: &FocusHandle,
        cx: &Context<Self>,
    ) -> Div {
        let selection = self.permission_selections.get(&tool_call_id);

        let selected_index = selection
            .and_then(|s| s.choice_index())
            .unwrap_or_else(|| choices.len().saturating_sub(1));

        let dropdown_label: SharedString =
            if matches!(selection, Some(PermissionSelection::SelectedPatterns(_))) {
                "Always for selected commands".into()
            } else {
                choices
                    .get(selected_index)
                    .or(choices.last())
                    .map(|choice| choice.label())
                    .unwrap_or_else(|| "Only this time".into())
            };

        let dropdown = if let Some((pattern_list, tool_name)) = patterns {
            self.render_permission_granularity_dropdown_with_patterns(
                choices,
                pattern_list,
                tool_name,
                dropdown_label,
                entry_ix,
                tool_call_id.clone(),
                is_first,
                cx,
            )
        } else {
            self.render_permission_granularity_dropdown(
                choices,
                dropdown_label,
                entry_ix,
                tool_call_id.clone(),
                selected_index,
                is_first,
                cx,
            )
        };

        h_flex()
            .w_full()
            .p_1()
            .gap_1()
            .justify_between()
            .border_t_1()
            .border_color(self.tool_card_border_color(cx))
            .child(
                h_flex()
                    .gap_0p5()
                    .child(
                        Button::new(("allow-btn", entry_ix), "Allow")
                            .start_icon(
                                Icon::new(IconName::Check)
                                    .size(IconSize::XSmall)
                                    .color(Color::Success),
                            )
                            .label_size(LabelSize::Small)
                            .when(is_first, |this| {
                                this.key_binding(
                                    KeyBinding::for_action_in(
                                        &AllowOnce as &dyn Action,
                                        focus_handle,
                                        cx,
                                    )
                                    .map(|kb| kb.size(rems_from_px(12.))),
                                )
                            })
                            .on_click(cx.listener({
                                let session_id = session_id.clone();
                                let tool_call_id = tool_call_id.clone();
                                move |this, _, window, cx| {
                                    this.authorize_with_granularity(
                                        session_id.clone(),
                                        tool_call_id.clone(),
                                        true,
                                        window,
                                        cx,
                                    );
                                }
                            })),
                    )
                    .child(
                        Button::new(("deny-btn", entry_ix), "Deny")
                            .start_icon(
                                Icon::new(IconName::Close)
                                    .size(IconSize::XSmall)
                                    .color(Color::Error),
                            )
                            .label_size(LabelSize::Small)
                            .when(is_first, |this| {
                                this.key_binding(
                                    KeyBinding::for_action_in(
                                        &RejectOnce as &dyn Action,
                                        focus_handle,
                                        cx,
                                    )
                                    .map(|kb| kb.size(rems_from_px(12.))),
                                )
                            })
                            .on_click(cx.listener({
                                move |this, _, window, cx| {
                                    this.authorize_with_granularity(
                                        session_id.clone(),
                                        tool_call_id.clone(),
                                        false,
                                        window,
                                        cx,
                                    );
                                }
                            })),
                    ),
            )
            .child(dropdown)
    }

    fn render_permission_granularity_dropdown(
        &self,
        choices: &[PermissionOptionChoice],
        current_label: SharedString,
        entry_ix: usize,
        tool_call_id: acp::ToolCallId,
        selected_index: usize,
        is_first: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let menu_options: Vec<(usize, SharedString)> = choices
            .iter()
            .enumerate()
            .map(|(i, choice)| (i, choice.label()))
            .collect();

        let permission_dropdown_handle = self.permission_dropdown_handle.clone();

        PopoverMenu::new(("permission-granularity", entry_ix))
            .with_handle(permission_dropdown_handle)
            .trigger(
                Button::new(("granularity-trigger", entry_ix), current_label)
                    .end_icon(
                        Icon::new(IconName::ChevronDown)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .label_size(LabelSize::Small)
                    .when(is_first, |this| {
                        this.key_binding(
                            KeyBinding::for_action_in(
                                &crate::OpenPermissionDropdown as &dyn Action,
                                &self.focus_handle(cx),
                                cx,
                            )
                            .map(|kb| kb.size(rems_from_px(12.))),
                        )
                    }),
            )
            .menu(move |window, cx| {
                let tool_call_id = tool_call_id.clone();
                let options = menu_options.clone();

                Some(ContextMenu::build(window, cx, move |mut menu, _, _| {
                    for (index, display_name) in options.iter() {
                        let display_name = display_name.clone();
                        let index = *index;
                        let tool_call_id_for_entry = tool_call_id.clone();
                        let is_selected = index == selected_index;
                        menu = menu.toggleable_entry(
                            display_name,
                            is_selected,
                            IconPosition::End,
                            None,
                            move |window, cx| {
                                window.dispatch_action(
                                    SelectPermissionGranularity {
                                        tool_call_id: tool_call_id_for_entry.0.to_string(),
                                        index,
                                    }
                                    .boxed_clone(),
                                    cx,
                                );
                            },
                        );
                    }

                    menu
                }))
            })
            .into_any_element()
    }

    fn render_permission_granularity_dropdown_with_patterns(
        &self,
        choices: &[PermissionOptionChoice],
        patterns: &[PermissionPattern],
        _tool_name: &str,
        current_label: SharedString,
        entry_ix: usize,
        tool_call_id: acp::ToolCallId,
        is_first: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let default_choice_index = choices.len().saturating_sub(1);
        let menu_options: Vec<(usize, SharedString)> = choices
            .iter()
            .enumerate()
            .map(|(i, choice)| (i, choice.label()))
            .collect();

        let pattern_options: Vec<(usize, SharedString)> = patterns
            .iter()
            .enumerate()
            .map(|(i, cp)| {
                (
                    i,
                    SharedString::from(format!("Always for `{}` commands", cp.display_name)),
                )
            })
            .collect();

        let pattern_count = patterns.len();
        let permission_dropdown_handle = self.permission_dropdown_handle.clone();
        let view = cx.entity().downgrade();

        PopoverMenu::new(("permission-granularity", entry_ix))
            .with_handle(permission_dropdown_handle.clone())
            .anchor(gpui::Anchor::TopRight)
            .attach(gpui::Anchor::BottomRight)
            .trigger(
                Button::new(("granularity-trigger", entry_ix), current_label)
                    .end_icon(
                        Icon::new(IconName::ChevronDown)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .label_size(LabelSize::Small)
                    .when(is_first, |this| {
                        this.key_binding(
                            KeyBinding::for_action_in(
                                &crate::OpenPermissionDropdown as &dyn Action,
                                &self.focus_handle(cx),
                                cx,
                            )
                            .map(|kb| kb.size(rems_from_px(12.))),
                        )
                    }),
            )
            .menu(move |window, cx| {
                let tool_call_id = tool_call_id.clone();
                let options = menu_options.clone();
                let patterns = pattern_options.clone();
                let view = view.clone();
                let dropdown_handle = permission_dropdown_handle.clone();

                Some(ContextMenu::build_persistent(
                    window,
                    cx,
                    move |menu, _window, cx| {
                        let mut menu = menu;

                        // Read fresh selection state from the view on each rebuild.
                        let selection: Option<PermissionSelection> = view.upgrade().and_then(|v| {
                            let view = v.read(cx);
                            view.permission_selections.get(&tool_call_id).cloned()
                        });

                        let is_pattern_mode =
                            matches!(selection, Some(PermissionSelection::SelectedPatterns(_)));

                        // Granularity choices: "Always for terminal", "Only this time"
                        for (index, display_name) in options.iter() {
                            let display_name = display_name.clone();
                            let index = *index;
                            let tool_call_id_for_entry = tool_call_id.clone();
                            let is_selected = !is_pattern_mode
                                && selection
                                    .as_ref()
                                    .and_then(|s| s.choice_index())
                                    .map_or(index == default_choice_index, |ci| ci == index);

                            let view = view.clone();
                            menu = menu.toggleable_entry(
                                display_name,
                                is_selected,
                                IconPosition::End,
                                None,
                                move |_window, cx| {
                                    view.update(cx, |this, cx| {
                                        this.permission_selections.insert(
                                            tool_call_id_for_entry.clone(),
                                            PermissionSelection::Choice(index),
                                        );
                                        cx.notify();
                                    })
                                    .log_err();
                                },
                            );
                        }

                        menu = menu.separator().header("Select Options…");

                        for (pattern_index, label) in patterns.iter() {
                            let label = label.clone();
                            let pattern_index = *pattern_index;
                            let tool_call_id_for_pattern = tool_call_id.clone();
                            let is_checked = selection
                                .as_ref()
                                .is_some_and(|s| s.is_pattern_checked(pattern_index));

                            let view = view.clone();
                            menu = menu.toggleable_entry(
                                label,
                                is_checked,
                                IconPosition::End,
                                None,
                                move |_window, cx| {
                                    view.update(cx, |this, cx| {
                                        let selection = this
                                            .permission_selections
                                            .get_mut(&tool_call_id_for_pattern);

                                        match selection {
                                            Some(PermissionSelection::SelectedPatterns(_)) => {
                                                // Already in pattern mode — toggle.
                                                this.permission_selections
                                                    .get_mut(&tool_call_id_for_pattern)
                                                    .expect("just matched above")
                                                    .toggle_pattern(pattern_index);
                                            }
                                            _ => {
                                                // First click: activate pattern mode
                                                // with all patterns checked.
                                                this.permission_selections.insert(
                                                    tool_call_id_for_pattern.clone(),
                                                    PermissionSelection::SelectedPatterns(
                                                        (0..pattern_count).collect(),
                                                    ),
                                                );
                                            }
                                        }
                                        cx.notify();
                                    })
                                    .log_err();
                                },
                            );
                        }

                        let any_patterns_checked = selection
                            .as_ref()
                            .is_some_and(|s| s.has_any_checked_patterns());
                        let dropdown_handle = dropdown_handle.clone();
                        menu = menu.custom_row(move |_window, _cx| {
                            div()
                                .py_1()
                                .w_full()
                                .child(
                                    Button::new("apply-patterns", "Apply")
                                        .full_width()
                                        .style(ButtonStyle::Outlined)
                                        .label_size(LabelSize::Small)
                                        .disabled(!any_patterns_checked)
                                        .on_click({
                                            let dropdown_handle = dropdown_handle.clone();
                                            move |_event, _window, cx| {
                                                dropdown_handle.hide(cx);
                                            }
                                        }),
                                )
                                .into_any_element()
                        });

                        menu
                    },
                ))
            })
            .into_any_element()
    }

    fn render_permission_buttons_flat(
        &self,
        session_id: acp::SessionId,
        is_first: bool,
        options: &[acp::PermissionOption],
        entry_ix: usize,
        tool_call_id: acp::ToolCallId,
        focus_handle: &FocusHandle,
        cx: &Context<Self>,
    ) -> Div {
        let mut seen_kinds: ArrayVec<acp::PermissionOptionKind, 3, u8> = ArrayVec::new();

        div()
            .p_1()
            .border_t_1()
            .border_color(self.tool_card_border_color(cx))
            .w_full()
            .v_flex()
            .gap_0p5()
            .children(options.iter().map(move |option| {
                let option_id = SharedString::from(option.option_id.0.clone());
                Button::new((option_id, entry_ix), option.name.clone())
                    .map(|this| {
                        let (icon, action) = match option.kind {
                            acp::PermissionOptionKind::AllowOnce => (
                                Icon::new(IconName::Check)
                                    .size(IconSize::XSmall)
                                    .color(Color::Success),
                                Some(&AllowOnce as &dyn Action),
                            ),
                            acp::PermissionOptionKind::AllowAlways => (
                                Icon::new(IconName::CheckDouble)
                                    .size(IconSize::XSmall)
                                    .color(Color::Success),
                                Some(&AllowAlways as &dyn Action),
                            ),
                            acp::PermissionOptionKind::RejectOnce => (
                                Icon::new(IconName::Close)
                                    .size(IconSize::XSmall)
                                    .color(Color::Error),
                                Some(&RejectOnce as &dyn Action),
                            ),
                            acp::PermissionOptionKind::RejectAlways | _ => (
                                Icon::new(IconName::Close)
                                    .size(IconSize::XSmall)
                                    .color(Color::Error),
                                None,
                            ),
                        };

                        let this = this.start_icon(icon);

                        let Some(action) = action else {
                            return this;
                        };

                        if !is_first || seen_kinds.contains(&option.kind) {
                            return this;
                        }

                        seen_kinds.push(option.kind).unwrap();

                        this.key_binding(
                            KeyBinding::for_action_in(action, focus_handle, cx)
                                .map(|kb| kb.size(rems_from_px(12.))),
                        )
                    })
                    .label_size(LabelSize::Small)
                    .style(ButtonStyle::Outlined)
                    .on_click(cx.listener({
                        let tool_call_id = tool_call_id.clone();
                        let option_id = option.option_id.clone();
                        let option_kind = option.kind;
                        let session_id = session_id.clone();
                        move |this, _, window, cx| {
                            this.authorize_tool_call(
                                session_id.clone(),
                                tool_call_id.clone(),
                                SelectedPermissionOutcome::new(option_id.clone(), option_kind),
                                window,
                                cx,
                            );
                        }
                    }))
            }))
    }

    fn render_diff_loading(&self, cx: &Context<Self>) -> AnyElement {
        let bar = |n: u64, width_class: &str| {
            let bg_color = cx.theme().colors().element_active;
            let base = h_flex().h_1().rounded_full();

            let modified = match width_class {
                "w_4_5" => base.w_3_4(),
                "w_1_4" => base.w_1_4(),
                "w_2_4" => base.w_2_4(),
                "w_3_5" => base.w_3_5(),
                "w_2_5" => base.w_2_5(),
                _ => base.w_1_2(),
            };

            modified.with_animation(
                ElementId::Integer(n),
                Animation::new(Duration::from_secs(2)).repeat(),
                move |tab, delta| {
                    let delta = (delta - 0.15 * n as f32) / 0.7;
                    let delta = 1.0 - (0.5 - delta).abs() * 2.;
                    let delta = ease_in_out(delta.clamp(0., 1.));
                    let delta = 0.1 + 0.9 * delta;

                    tab.bg(bg_color.opacity(delta))
                },
            )
        };

        v_flex()
            .p_2()
            .gap_1()
            .rounded_b_md()
            .bg(cx.theme().colors().editor_background)
            .child(bar(0, "w_4_5"))
            .child(bar(1, "w_1_4"))
            .child(bar(2, "w_2_4"))
            .child(bar(3, "w_3_5"))
            .child(bar(4, "w_2_5"))
            .into_any_element()
    }

    fn render_tool_call_label(
        &self,
        entry_ix: usize,
        tool_call: &ToolCall,
        is_edit: bool,
        has_failed: bool,
        has_revealed_diff: bool,
        use_card_layout: bool,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        let has_location = tool_call.locations.len() == 1;
        let is_file = tool_call.kind == acp::ToolKind::Edit && has_location;
        let is_subagent_tool_call = tool_call.is_subagent();

        let file_icon = if has_location {
            FileIcons::get_icon(&tool_call.locations[0].path, cx)
                .map(|from_path| Icon::from_path(from_path).color(Color::Muted))
                .unwrap_or(Icon::new(IconName::ToolPencil).color(Color::Muted))
        } else {
            Icon::new(IconName::ToolPencil).color(Color::Muted)
        };
        let edit_summary = if is_edit {
            self.edit_tool_call_summary(tool_call, cx)
        } else {
            None
        };

        let tool_icon = if is_file && has_failed && has_revealed_diff {
            div()
                .id(entry_ix)
                .tooltip(Tooltip::text("Interrupted Edit"))
                .child(DecoratedIcon::new(
                    file_icon,
                    Some(
                        IconDecoration::new(
                            IconDecorationKind::Triangle,
                            self.tool_card_header_bg(cx),
                            cx,
                        )
                        .color(cx.theme().status().warning)
                        .position(gpui::Point {
                            x: px(-2.),
                            y: px(-2.),
                        }),
                    ),
                ))
                .into_any_element()
        } else if is_file {
            div().child(file_icon).into_any_element()
        } else if is_subagent_tool_call {
            Icon::new(self.agent_icon)
                .size(IconSize::Small)
                .color(Color::Muted)
                .into_any_element()
        } else {
            Icon::new(match tool_call.kind {
                acp::ToolKind::Read => IconName::ToolSearch,
                acp::ToolKind::Edit => IconName::ToolPencil,
                acp::ToolKind::Delete => IconName::ToolDeleteFile,
                acp::ToolKind::Move => IconName::ArrowRightLeft,
                acp::ToolKind::Search => IconName::ToolSearch,
                acp::ToolKind::Execute => IconName::ToolTerminal,
                acp::ToolKind::Think => IconName::ToolThink,
                acp::ToolKind::Fetch => IconName::ToolWeb,
                acp::ToolKind::SwitchMode => IconName::ArrowRightLeft,
                acp::ToolKind::Other | _ => IconName::ToolHammer,
            })
            .size(IconSize::Small)
            .color(Color::Muted)
            .into_any_element()
        };

        let gradient_overlay = {
            div()
                .absolute()
                .top_0()
                .right_0()
                .w_12()
                .h_full()
                .map(|this| {
                    if use_card_layout {
                        this.bg(linear_gradient(
                            90.,
                            linear_color_stop(self.tool_card_header_bg(cx), 1.),
                            linear_color_stop(self.tool_card_header_bg(cx).opacity(0.2), 0.),
                        ))
                    } else {
                        this.bg(linear_gradient(
                            90.,
                            linear_color_stop(cx.theme().colors().panel_background, 1.),
                            linear_color_stop(
                                cx.theme().colors().panel_background.opacity(0.2),
                                0.,
                            ),
                        ))
                    }
                })
        };

        h_flex()
            .relative()
            .w_full()
            .h(window.line_height() - px(2.))
            .text_size(self.tool_name_font_size())
            .gap_1()
            .when(has_location || use_card_layout, |this| this.px_1())
            .when(has_location, |this| {
                this.cursor(CursorStyle::PointingHand)
                    .rounded(rems_from_px(3.)) // Concentric border radius
                    .hover(|s| s.bg(cx.theme().colors().element_hover.opacity(0.5)))
            })
            .overflow_hidden()
            .child(tool_icon)
            .child(
                if let Some((path, file_name, added, removed)) = edit_summary {
                    let mut summary = h_flex()
                        .id(("open-tool-call-location", entry_ix))
                        .w_full()
                        .min_w_0()
                        .gap_1p5()
                        .child(Label::new("Editing").color(Color::Muted))
                        .child(Label::new(file_name).color(Color::Accent).truncate())
                        .child(
                            DiffStat::new(("tool-call-edit-stat", entry_ix), added, removed)
                                .label_size(LabelSize::Custom(self.tool_name_font_size())),
                        )
                        .tooltip({
                            let path = path.clone();
                            move |_, cx| Tooltip::with_meta("Go to File", None, path.clone(), cx)
                        });
                    if has_location {
                        summary = summary.on_click(cx.listener(move |this, _, window, cx| {
                            this.open_tool_call_location(entry_ix, 0, window, cx);
                        }));
                    }
                    summary.into_any_element()
                } else if has_location {
                    h_flex()
                        .id(("open-tool-call-location", entry_ix))
                        .w_full()
                        .map(|this| {
                            if use_card_layout {
                                this.text_color(cx.theme().colors().text)
                            } else {
                                this.text_color(cx.theme().colors().text_muted)
                            }
                        })
                        .child(
                            self.render_markdown(
                                tool_call.label.clone(),
                                MarkdownStyle {
                                    prevent_mouse_interaction: true,
                                    ..MarkdownStyle::themed(MarkdownFont::Agent, window, cx)
                                        .with_muted_text(cx)
                                },
                            ),
                        )
                        .tooltip(Tooltip::text("Go to File"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_tool_call_location(entry_ix, 0, window, cx);
                        }))
                        .into_any_element()
                } else {
                    h_flex()
                        .w_full()
                        .child(
                            self.render_markdown(
                                tool_call.label.clone(),
                                MarkdownStyle::themed(MarkdownFont::Agent, window, cx)
                                    .with_muted_text(cx),
                            ),
                        )
                        .into_any()
                },
            )
            .when(!is_edit, |this| this.child(gradient_overlay))
    }

    fn edit_tool_call_summary(
        &self,
        tool_call: &ToolCall,
        cx: &App,
    ) -> Option<(String, String, usize, usize)> {
        let diff = tool_call.diffs().next()?;
        let diff = diff.read(cx);
        let path = diff.file_path(cx).or_else(|| {
            tool_call
                .locations
                .first()
                .map(|location| location.path.to_string_lossy().into_owned())
        })?;
        let file_name = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(path.as_str())
            .to_string();
        let new_text = diff.buffer().read(cx).text();
        let (added, removed) =
            Self::line_delta_counts(diff.base_text().as_ref(), new_text.as_str());
        Some((path, file_name, added, removed))
    }

    fn line_delta_counts(old_text: &str, new_text: &str) -> (usize, usize) {
        let old_lines = old_text.lines().collect::<Vec<_>>();
        let new_lines = new_text.lines().collect::<Vec<_>>();
        let mut prefix = 0;
        while prefix < old_lines.len()
            && prefix < new_lines.len()
            && old_lines[prefix] == new_lines[prefix]
        {
            prefix += 1;
        }

        let mut suffix = 0;
        while suffix + prefix < old_lines.len()
            && suffix + prefix < new_lines.len()
            && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
        {
            suffix += 1;
        }

        (
            new_lines.len().saturating_sub(prefix + suffix),
            old_lines.len().saturating_sub(prefix + suffix),
        )
    }

    fn open_tool_call_location(
        &self,
        entry_ix: usize,
        location_ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<()> {
        let (tool_call_location, agent_location) = self
            .thread
            .read(cx)
            .entries()
            .get(entry_ix)?
            .location(location_ix)?;

        let project_path = self
            .project
            .upgrade()?
            .read(cx)
            .find_project_path(&tool_call_location.path, cx)?;

        let open_task = self
            .workspace
            .update(cx, |workspace, cx| {
                workspace.open_path(project_path, None, true, window, cx)
            })
            .log_err()?;
        window
            .spawn(cx, async move |cx| {
                let item = open_task.await?;

                let Some(active_editor) = item.downcast::<Editor>() else {
                    return anyhow::Ok(());
                };

                active_editor.update_in(cx, |editor, window, cx| {
                    let snapshot = editor.buffer().read(cx).snapshot(cx);
                    if snapshot.as_singleton().is_some()
                        && let Some(anchor) = snapshot.anchor_in_excerpt(agent_location.position)
                    {
                        editor.change_selections(Default::default(), window, cx, |selections| {
                            selections.select_anchor_ranges([anchor..anchor]);
                        })
                    } else {
                        let row = tool_call_location.line.unwrap_or_default();
                        editor.change_selections(Default::default(), window, cx, |selections| {
                            selections.select_ranges([Point::new(row, 0)..Point::new(row, 0)]);
                        })
                    }
                })?;

                anyhow::Ok(())
            })
            .detach_and_log_err(cx);

        None
    }

    fn render_tool_call_content(
        &self,
        session_id: &acp::SessionId,
        entry_ix: usize,
        content: &ToolCallContent,
        context_ix: usize,
        tool_call: &ToolCall,
        card_layout: bool,
        is_image_tool_call: bool,
        has_failed: bool,
        focus_handle: &FocusHandle,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        match content {
            ToolCallContent::ContentBlock(content) => {
                if let Some(resource_link) = content.resource_link() {
                    self.render_resource_link(resource_link, cx)
                } else if let Some(markdown) = content.markdown() {
                    self.render_markdown_output(
                        markdown.clone(),
                        tool_call.id.clone(),
                        context_ix,
                        card_layout,
                        window,
                        cx,
                    )
                } else if let Some(image) = content.image() {
                    let location = tool_call.locations.first().cloned();
                    self.render_image_output(
                        entry_ix,
                        image.clone(),
                        location,
                        card_layout,
                        is_image_tool_call,
                        cx,
                    )
                } else {
                    Empty.into_any_element()
                }
            }
            ToolCallContent::Diff(diff) => {
                self.render_diff_editor(entry_ix, diff, tool_call, has_failed, cx)
            }
            ToolCallContent::Terminal(terminal) => self.render_terminal_tool_call(
                session_id,
                entry_ix,
                terminal,
                tool_call,
                focus_handle,
                false,
                window,
                cx,
            ),
        }
    }

    fn render_resource_link(
        &self,
        resource_link: &acp::ResourceLink,
        cx: &Context<Self>,
    ) -> AnyElement {
        let uri: SharedString = resource_link.uri.clone().into();
        let is_file = resource_link.uri.strip_prefix("file://");

        let Some(project) = self.project.upgrade() else {
            return Empty.into_any_element();
        };

        let label: SharedString = if let Some(abs_path) = is_file {
            if let Some(project_path) = project
                .read(cx)
                .project_path_for_absolute_path(&Path::new(abs_path), cx)
                && let Some(worktree) = project
                    .read(cx)
                    .worktree_for_id(project_path.worktree_id, cx)
            {
                worktree
                    .read(cx)
                    .full_path(&project_path.path)
                    .to_string_lossy()
                    .to_string()
                    .into()
            } else {
                abs_path.to_string().into()
            }
        } else {
            uri.clone()
        };

        let button_id = SharedString::from(format!("item-{}", uri));

        div()
            .ml(rems(0.4))
            .pl_2p5()
            .border_l_1()
            .border_color(self.tool_card_border_color(cx))
            .overflow_hidden()
            .child(
                Button::new(button_id, label)
                    .label_size(LabelSize::Small)
                    .color(Color::Muted)
                    .truncate(true)
                    .when(is_file.is_none(), |this| {
                        this.end_icon(
                            Icon::new(IconName::ArrowUpRight)
                                .size(IconSize::XSmall)
                                .color(Color::Muted),
                        )
                    })
                    .on_click(cx.listener({
                        let workspace = self.workspace.clone();
                        move |_, _, window, cx: &mut Context<Self>| {
                            open_link(uri.clone(), &workspace, window, cx);
                        }
                    })),
            )
            .into_any_element()
    }

    fn render_diff_editor(
        &self,
        entry_ix: usize,
        diff: &Entity<acp_thread::Diff>,
        tool_call: &ToolCall,
        has_failed: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let tool_progress = matches!(
            &tool_call.status,
            ToolCallStatus::InProgress | ToolCallStatus::Pending
        );

        let revealed_diff_editor = if let Some(entry) =
            self.entry_view_state.read(cx).entry(entry_ix)
            && let Some(editor) = entry.editor_for_diff(diff)
            && diff.read(cx).has_revealed_range(cx)
        {
            Some(editor)
        } else {
            None
        };

        let show_top_border = !has_failed || revealed_diff_editor.is_some();

        v_flex()
            .h_full()
            .when(show_top_border, |this| {
                this.border_t_1()
                    .when(has_failed, |this| this.border_dashed())
                    .border_color(self.tool_card_border_color(cx))
            })
            .child(if let Some(editor) = revealed_diff_editor {
                editor.into_any_element()
            } else if tool_progress && self.as_native_connection(cx).is_some() {
                self.render_diff_loading(cx)
            } else {
                Empty.into_any()
            })
            .into_any()
    }

    fn render_markdown_output(
        &self,
        markdown: Entity<Markdown>,
        tool_call_id: acp::ToolCallId,
        context_ix: usize,
        card_layout: bool,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let button_id = SharedString::from(format!("tool_output-{:?}", tool_call_id));

        v_flex()
            .gap_1()
            .map(|this| {
                if card_layout {
                    this.p_1p5().when(context_ix > 0, |this| {
                        this.border_t_1()
                            .border_color(self.tool_card_border_color(cx))
                    })
                } else {
                    this.ml(rems(0.4))
                        .px_2()
                        .border_l_1()
                        .border_color(self.tool_card_border_color(cx))
                }
            })
            .text_xs()
            .text_color(cx.theme().colors().text_muted)
            .child(self.render_markdown(
                markdown,
                MarkdownStyle::themed(MarkdownFont::Agent, window, cx),
            ))
            .when(!card_layout, |this| {
                this.child(
                    IconButton::new(button_id, IconName::ChevronUp)
                        .full_width()
                        .style(ButtonStyle::Outlined)
                        .icon_color(Color::Muted)
                        .on_click(cx.listener({
                            move |this: &mut Self, _, _, cx: &mut Context<Self>| {
                                this.expanded_tool_calls.remove(&tool_call_id);
                                cx.notify();
                            }
                        })),
                )
            })
            .into_any_element()
    }

    fn render_image_output(
        &self,
        entry_ix: usize,
        image: Arc<gpui::Image>,
        location: Option<acp::ToolCallLocation>,
        card_layout: bool,
        show_dimensions: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let dimensions_label = if show_dimensions {
            let format_name = match image.format() {
                gpui::ImageFormat::Png => "PNG",
                gpui::ImageFormat::Jpeg => "JPEG",
                gpui::ImageFormat::Webp => "WebP",
                gpui::ImageFormat::Gif => "GIF",
                gpui::ImageFormat::Svg => "SVG",
                gpui::ImageFormat::Bmp => "BMP",
                gpui::ImageFormat::Tiff => "TIFF",
                gpui::ImageFormat::Ico => "ICO",
                gpui::ImageFormat::Pnm => "PNM",
            };
            let dimensions = image::ImageReader::new(std::io::Cursor::new(image.bytes()))
                .with_guessed_format()
                .ok()
                .and_then(|reader| reader.into_dimensions().ok());
            dimensions.map(|(w, h)| format!("{}×{} {}", w, h, format_name))
        } else {
            None
        };

        v_flex()
            .gap_1()
            .map(|this| {
                if card_layout {
                    this
                } else {
                    this.ml(rems(0.4))
                        .px_2()
                        .border_l_1()
                        .border_color(self.tool_card_border_color(cx))
                }
            })
            .when(dimensions_label.is_some() || location.is_some(), |this| {
                this.child(
                    h_flex()
                        .w_full()
                        .justify_between()
                        .items_center()
                        .children(dimensions_label.map(|label| {
                            Label::new(label)
                                .size(LabelSize::XSmall)
                                .color(Color::Muted)
                                .buffer_font(cx)
                        }))
                        .when_some(location, |this, _loc| {
                            this.child(
                                Button::new(("go-to-file", entry_ix), "Go to File")
                                    .label_size(LabelSize::Small)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_tool_call_location(entry_ix, 0, window, cx);
                                    })),
                            )
                        }),
                )
            })
            .child(
                img(image)
                    .max_w_96()
                    .max_h_96()
                    .object_fit(ObjectFit::ScaleDown),
            )
            .into_any_element()
    }

    fn render_subagent_tool_call(
        &self,
        active_session_id: &acp::SessionId,
        entry_ix: usize,
        tool_call: &ToolCall,
        subagent_session_id: Option<acp::SessionId>,
        focus_handle: &FocusHandle,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        let subagent_thread_view = subagent_session_id.and_then(|session_id| {
            self.server_view
                .upgrade()
                .and_then(|server_view| server_view.read(cx).as_connected())
                .and_then(|connected| connected.threads.get(&session_id))
        });

        let content = self.render_subagent_card(
            active_session_id,
            entry_ix,
            subagent_thread_view,
            tool_call,
            focus_handle,
            window,
            cx,
        );

        v_flex().mx_5().my_1p5().gap_3().child(content)
    }

    fn render_subagent_card(
        &self,
        active_session_id: &acp::SessionId,
        entry_ix: usize,
        thread_view: Option<&Entity<ThreadView>>,
        tool_call: &ToolCall,
        focus_handle: &FocusHandle,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let thread = thread_view
            .as_ref()
            .map(|view| view.read(cx).thread.clone());
        let subagent_session_id = thread
            .as_ref()
            .map(|thread| thread.read(cx).session_id().clone());
        let action_log = thread.as_ref().map(|thread| thread.read(cx).action_log());
        let changed_buffers = action_log
            .map(|log| log.read(cx).changed_buffers(cx))
            .unwrap_or_default();

        let is_pending_tool_call = thread_view
            .as_ref()
            .and_then(|tv| {
                let sid = tv.read(cx).thread.read(cx).session_id();
                self.conversation.read(cx).pending_tool_call(sid, cx)
            })
            .is_some();

        let is_expanded = self.expanded_tool_calls.contains(&tool_call.id);
        let files_changed = changed_buffers.len();
        let diff_stats = DiffStats::all_files(&changed_buffers, cx);

        let is_running = matches!(
            tool_call.status,
            ToolCallStatus::Pending
                | ToolCallStatus::InProgress
                | ToolCallStatus::WaitingForConfirmation { .. }
        );

        let is_failed = matches!(
            tool_call.status,
            ToolCallStatus::Failed | ToolCallStatus::Rejected
        );

        let is_cancelled = matches!(tool_call.status, ToolCallStatus::Canceled)
            || tool_call.content.iter().any(|c| match c {
                ToolCallContent::ContentBlock(ContentBlock::Markdown { markdown }) => {
                    markdown.read(cx).source() == "User canceled"
                }
                _ => false,
            });

        let thread_title = thread
            .as_ref()
            .and_then(|t| t.read(cx).title())
            .filter(|t| !t.is_empty());
        let tool_call_label = tool_call.label.read(cx).source().to_string();
        let has_tool_call_label = !tool_call_label.is_empty();

        let has_title = thread_title.is_some() || has_tool_call_label;
        let has_no_title_or_canceled = !has_title || is_failed || is_cancelled;

        let title: SharedString = if let Some(thread_title) = thread_title {
            thread_title
        } else if !tool_call_label.is_empty() {
            tool_call_label.into()
        } else if is_cancelled {
            "Subagent Canceled".into()
        } else if is_failed {
            "Subagent Failed".into()
        } else {
            "Spawning Agent…".into()
        };

        let card_header_id = format!("subagent-header-{}", entry_ix);
        let status_icon = format!("status-icon-{}", entry_ix);
        let diff_stat_id = format!("subagent-diff-{}", entry_ix);

        let icon = h_flex().w_4().justify_center().child(if is_running {
            SpinnerLabel::new()
                .size(LabelSize::Small)
                .into_any_element()
        } else if is_cancelled {
            div()
                .id(status_icon)
                .child(
                    Icon::new(IconName::Circle)
                        .size(IconSize::Small)
                        .color(Color::Custom(
                            cx.theme().colors().icon_disabled.opacity(0.5),
                        )),
                )
                .tooltip(Tooltip::text("Subagent Cancelled"))
                .into_any_element()
        } else if is_failed {
            div()
                .id(status_icon)
                .child(
                    Icon::new(IconName::Close)
                        .size(IconSize::Small)
                        .color(Color::Error),
                )
                .tooltip(Tooltip::text("Subagent Failed"))
                .into_any_element()
        } else {
            Icon::new(IconName::Check)
                .size(IconSize::Small)
                .color(Color::Success)
                .into_any_element()
        });

        let has_expandable_content = thread
            .as_ref()
            .map_or(false, |thread| !thread.read(cx).entries().is_empty());

        let tooltip_meta_description = if is_expanded {
            "Click to Collapse"
        } else {
            "Click to Preview"
        };

        let error_message = self.subagent_error_message(&tool_call.status, tool_call, cx);

        v_flex()
            .w_full()
            .rounded_md()
            .border_1()
            .when(has_no_title_or_canceled, |this| this.border_dashed())
            .border_color(self.tool_card_border_color(cx))
            .overflow_hidden()
            .child(
                h_flex()
                    .group(&card_header_id)
                    .h_8()
                    .p_1()
                    .w_full()
                    .justify_between()
                    .when(!has_no_title_or_canceled, |this| {
                        this.bg(self.tool_card_header_bg(cx))
                    })
                    .child(
                        h_flex()
                            .id(format!("subagent-title-{}", entry_ix))
                            .px_1()
                            .min_w_0()
                            .size_full()
                            .gap_2()
                            .justify_between()
                            .rounded_sm()
                            .overflow_hidden()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .w_full()
                                    .gap_1p5()
                                    .child(icon)
                                    .child(
                                        Label::new(title.to_string())
                                            .size(LabelSize::Custom(self.tool_name_font_size()))
                                            .truncate(),
                                    )
                                    .when(files_changed > 0, |this| {
                                        this.child(
                                            Label::new(format!(
                                                "— {} {} changed",
                                                files_changed,
                                                if files_changed == 1 { "file" } else { "files" }
                                            ))
                                            .size(LabelSize::Custom(self.tool_name_font_size()))
                                            .color(Color::Muted),
                                        )
                                        .child(
                                            DiffStat::new(
                                                diff_stat_id.clone(),
                                                diff_stats.lines_added as usize,
                                                diff_stats.lines_removed as usize,
                                            )
                                            .label_size(LabelSize::Custom(
                                                self.tool_name_font_size(),
                                            )),
                                        )
                                    }),
                            )
                            .when(!has_no_title_or_canceled && !is_pending_tool_call, |this| {
                                this.tooltip(move |_, cx| {
                                    Tooltip::with_meta(
                                        title.to_string(),
                                        None,
                                        tooltip_meta_description,
                                        cx,
                                    )
                                })
                            })
                            .when(has_expandable_content && !is_pending_tool_call, |this| {
                                this.cursor_pointer()
                                    .hover(|s| s.bg(cx.theme().colors().element_hover))
                                    .child(
                                        div().visible_on_hover(card_header_id).child(
                                            Icon::new(if is_expanded {
                                                IconName::ChevronUp
                                            } else {
                                                IconName::ChevronDown
                                            })
                                            .color(Color::Muted)
                                            .size(IconSize::Small),
                                        ),
                                    )
                                    .on_click(cx.listener({
                                        let tool_call_id = tool_call.id.clone();
                                        move |this, _, _, cx| {
                                            if this.expanded_tool_calls.contains(&tool_call_id) {
                                                this.expanded_tool_calls.remove(&tool_call_id);
                                            } else {
                                                this.expanded_tool_calls
                                                    .insert(tool_call_id.clone());
                                            }
                                            let expanded =
                                                this.expanded_tool_calls.contains(&tool_call_id);
                                            telemetry::event!("Subagent Toggled", expanded);
                                            cx.notify();
                                        }
                                    }))
                            }),
                    )
                    .when(is_running && subagent_session_id.is_some(), |buttons| {
                        buttons.child(
                            IconButton::new(format!("stop-subagent-{}", entry_ix), IconName::Stop)
                                .icon_size(IconSize::Small)
                                .icon_color(Color::Error)
                                .tooltip(Tooltip::text("Stop Subagent"))
                                .when_some(
                                    thread_view
                                        .as_ref()
                                        .map(|view| view.read(cx).thread.clone()),
                                    |this, thread| {
                                        this.on_click(cx.listener(
                                            move |_this, _event, _window, cx| {
                                                telemetry::event!("Subagent Stopped");
                                                thread.update(cx, |thread, cx| {
                                                    thread.cancel(cx).detach();
                                                });
                                            },
                                        ))
                                    },
                                ),
                        )
                    }),
            )
            .when_some(thread_view, |this, thread_view| {
                let thread = &thread_view.read(cx).thread;
                let tv_session_id = thread.read(cx).session_id();
                let pending_tool_call = self
                    .conversation
                    .read(cx)
                    .pending_tool_call(tv_session_id, cx);

                let nav_session_id = tv_session_id.clone();

                let fullscreen_toggle = h_flex()
                    .id(entry_ix)
                    .py_1()
                    .w_full()
                    .justify_center()
                    .border_t_1()
                    .when(is_failed, |this| this.border_dashed())
                    .border_color(self.tool_card_border_color(cx))
                    .cursor_pointer()
                    .hover(|s| s.bg(cx.theme().colors().element_hover))
                    .child(
                        Icon::new(IconName::Maximize)
                            .color(Color::Muted)
                            .size(IconSize::Small),
                    )
                    .tooltip(Tooltip::text("Make Subagent Full Screen"))
                    .on_click(cx.listener(move |this, _event, window, cx| {
                        telemetry::event!("Subagent Maximized");
                        this.server_view
                            .update(cx, |this, cx| {
                                this.navigate_to_thread(nav_session_id.clone(), window, cx);
                            })
                            .ok();
                    }));

                if is_running && let Some((_, subagent_tool_call_id, _)) = pending_tool_call {
                    if let Some((entry_ix, tool_call)) =
                        thread.read(cx).tool_call(&subagent_tool_call_id)
                    {
                        this.child(Divider::horizontal().color(DividerColor::Border))
                            .child(thread_view.read(cx).render_any_tool_call(
                                active_session_id,
                                entry_ix,
                                tool_call,
                                focus_handle,
                                true,
                                window,
                                cx,
                            ))
                            .child(fullscreen_toggle)
                    } else {
                        this
                    }
                } else {
                    this.when(is_expanded, |this| {
                        this.child(self.render_subagent_expanded_content(
                            thread_view,
                            tool_call,
                            window,
                            cx,
                        ))
                        .when_some(error_message, |this, message| {
                            this.child(
                                Callout::new()
                                    .severity(Severity::Error)
                                    .icon(IconName::XCircle)
                                    .title(message),
                            )
                        })
                        .child(fullscreen_toggle)
                    })
                }
            })
            .into_any_element()
    }

    fn render_subagent_expanded_content(
        &self,
        thread_view: &Entity<ThreadView>,
        tool_call: &ToolCall,
        window: &Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        const MAX_PREVIEW_ENTRIES: usize = 8;

        let subagent_view = thread_view.read(cx);
        let session_id = subagent_view.thread.read(cx).session_id().clone();

        let is_canceled_or_failed = matches!(
            tool_call.status,
            ToolCallStatus::Canceled | ToolCallStatus::Failed | ToolCallStatus::Rejected
        );

        let editor_bg = cx.theme().colors().editor_background;
        let overlay = {
            div()
                .absolute()
                .inset_0()
                .size_full()
                .bg(linear_gradient(
                    180.,
                    linear_color_stop(editor_bg.opacity(0.5), 0.),
                    linear_color_stop(editor_bg.opacity(0.), 0.1),
                ))
                .block_mouse_except_scroll()
        };

        let entries = subagent_view.thread.read(cx).entries();
        let total_entries = entries.len();
        let mut entry_range = if let Some(info) = tool_call.subagent_session_info.as_ref() {
            info.message_start_index
                ..info
                    .message_end_index
                    .map(|i| (i + 1).min(total_entries))
                    .unwrap_or(total_entries)
        } else {
            0..total_entries
        };
        entry_range.start = entry_range
            .end
            .saturating_sub(MAX_PREVIEW_ENTRIES)
            .max(entry_range.start);
        let start_ix = entry_range.start;

        let scroll_handle = self
            .subagent_scroll_handles
            .borrow_mut()
            .entry(subagent_view.session_id.clone())
            .or_default()
            .clone();

        scroll_handle.scroll_to_bottom();

        let rendered_entries: Vec<AnyElement> = entries
            .get(entry_range)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let actual_ix = start_ix + i;
                subagent_view.render_entry(actual_ix, total_entries, entry, window, cx)
            })
            .collect();

        v_flex()
            .w_full()
            .border_t_1()
            .when(is_canceled_or_failed, |this| this.border_dashed())
            .border_color(self.tool_card_border_color(cx))
            .overflow_hidden()
            .child(
                div()
                    .pb_1()
                    .min_h_0()
                    .id(format!("subagent-entries-{}", session_id))
                    .track_scroll(&scroll_handle)
                    .children(rendered_entries),
            )
            .h_56()
            .child(overlay)
            .into_any_element()
    }

    fn subagent_error_message(
        &self,
        status: &ToolCallStatus,
        tool_call: &ToolCall,
        cx: &App,
    ) -> Option<SharedString> {
        if matches!(status, ToolCallStatus::Failed) {
            tool_call.content.iter().find_map(|content| {
                if let ToolCallContent::ContentBlock(block) = content {
                    if let acp_thread::ContentBlock::Markdown { markdown } = block {
                        let source = markdown.read(cx).source().to_string();
                        if !source.is_empty() {
                            if source == "User canceled" {
                                return None;
                            } else {
                                return Some(SharedString::from(source));
                            }
                        }
                    }
                }
                None
            })
        } else {
            None
        }
    }

    fn tool_card_header_bg(&self, cx: &Context<Self>) -> Hsla {
        cx.theme()
            .colors()
            .editor_background
            .blend(cx.theme().colors().element_background.opacity(0.1))
    }

    fn tool_card_border_color(&self, cx: &Context<Self>) -> Hsla {
        cx.theme().colors().border_variant.opacity(0.34)
    }

    fn tool_name_font_size(&self) -> Rems {
        rems_from_px(12.)
    }

    pub(crate) fn render_thread_error(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let content = match self.thread_error.as_ref()? {
            ThreadError::Other { message, .. } => {
                self.render_any_thread_error(message.clone(), window, cx)
            }
            ThreadError::Refusal => self.render_refusal_error(cx),
            ThreadError::AuthenticationRequired(error) => {
                self.render_authentication_required_error(error.clone(), cx)
            }
            ThreadError::PaymentRequired => self.render_payment_required_error(cx),
            ThreadError::RateLimitExceeded { provider } => self.render_error_callout(
                "Rate Limit Reached",
                format!(
                    "{provider}'s rate limit was reached. Backboard Studio will retry automatically. \
                    You can also wait a moment and try again."
                )
                .into(),
                true,
                true,
                cx,
            ),
            ThreadError::ServerOverloaded { provider } => self.render_error_callout(
                "Provider Unavailable",
                format!(
                    "{provider}'s servers are temporarily unavailable. Backboard Studio will retry \
                    automatically. If the problem persists, check the provider's status page."
                )
                .into(),
                true,
                true,
                cx,
            ),
            ThreadError::PromptTooLarge => self.render_prompt_too_large_error(cx),
            ThreadError::NoApiKey { provider } => self.render_error_callout(
                "API Key Missing",
                format!(
                    "No API key is configured for {provider}. \
                    Add your key via the Agent Panel settings to continue."
                )
                .into(),
                false,
                true,
                cx,
            ),
            ThreadError::StreamError { provider } => self.render_error_callout(
                "Connection Interrupted",
                format!(
                    "The connection to {provider}'s API was interrupted. Backboard Studio will retry \
                    automatically. If the problem persists, check your network connection."
                )
                .into(),
                true,
                true,
                cx,
            ),
            ThreadError::InvalidApiKey { provider } => self.render_error_callout(
                "Invalid API Key",
                format!(
                    "The API key for {provider} is invalid or has expired. \
                    Update your key via the Agent Panel settings to continue."
                )
                .into(),
                false,
                false,
                cx,
            ),
            ThreadError::PermissionDenied { provider } => self.render_error_callout(
                "Permission Denied",
                format!(
                    "{provider}'s API rejected the request due to insufficient permissions. \
                    Check that your API key has access to this model."
                )
                .into(),
                false,
                false,
                cx,
            ),
            ThreadError::RequestFailed => self.render_error_callout(
                "Request Failed",
                "The request could not be completed after multiple attempts. \
                Try again in a moment."
                    .into(),
                true,
                false,
                cx,
            ),
            ThreadError::MaxOutputTokens => self.render_error_callout(
                "Output Limit Reached",
                "The model stopped because it reached its maximum output length. \
                You can ask it to continue where it left off."
                    .into(),
                false,
                false,
                cx,
            ),
            ThreadError::NoModelSelected => self.render_error_callout(
                "No Model Selected",
                "Select a model from the model picker below to get started.".into(),
                false,
                false,
                cx,
            ),
            ThreadError::ApiError { provider } => self.render_error_callout(
                "API Error",
                format!(
                    "{provider}'s API returned an unexpected error. \
                    If the problem persists, try switching models or restarting Backboard Studio."
                )
                .into(),
                true,
                true,
                cx,
            ),
        };

        Some(div().child(content))
    }

    fn render_refusal_error(&self, cx: &mut Context<'_, Self>) -> Callout {
        let model_or_agent_name = self.current_model_name(cx);
        let refusal_message = format!(
            "{} refused to respond to this prompt. \
            This can happen when a model believes the prompt violates its content policy \
            or safety guidelines, so rephrasing it can sometimes address the issue.",
            model_or_agent_name
        );

        Callout::new()
            .severity(Severity::Error)
            .title("Request Refused")
            .icon(IconName::XCircle)
            .description(refusal_message.clone())
            .actions_slot(self.create_copy_button(&refusal_message))
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn render_authentication_required_error(
        &self,
        error: SharedString,
        cx: &mut Context<Self>,
    ) -> Callout {
        Callout::new()
            .severity(Severity::Error)
            .title("Authentication Required")
            .icon(IconName::XCircle)
            .description(error.clone())
            .actions_slot(
                h_flex()
                    .gap_0p5()
                    .child(self.authenticate_button(cx))
                    .child(self.create_copy_button(error)),
            )
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn render_payment_required_error(&self, cx: &mut Context<Self>) -> Callout {
        const ERROR_MESSAGE: &str =
            "You reached your free usage limit. Upgrade to Backboard Pro for more prompts.";

        Callout::new()
            .severity(Severity::Error)
            .icon(IconName::XCircle)
            .title("Free Usage Exceeded")
            .description(ERROR_MESSAGE)
            .actions_slot(
                h_flex()
                    .gap_0p5()
                    .child(self.upgrade_button(cx))
                    .child(self.create_copy_button(ERROR_MESSAGE)),
            )
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn render_error_callout(
        &self,
        title: &'static str,
        message: SharedString,
        show_retry: bool,
        show_copy: bool,
        cx: &mut Context<Self>,
    ) -> Callout {
        let can_resume = show_retry && self.thread.read(cx).can_retry(cx);
        let show_actions = can_resume || show_copy;

        Callout::new()
            .severity(Severity::Error)
            .icon(IconName::XCircle)
            .title(title)
            .description(message.clone())
            .when(show_actions, |callout| {
                callout.actions_slot(
                    h_flex()
                        .gap_0p5()
                        .when(can_resume, |this| this.child(self.retry_button(cx)))
                        .when(show_copy, |this| {
                            this.child(self.create_copy_button(message.clone()))
                        }),
                )
            })
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn render_prompt_too_large_error(&self, cx: &mut Context<Self>) -> Callout {
        const MESSAGE: &str = "This conversation is too long for the model's context window. \
            Start a new thread or remove some attached files to continue.";

        Callout::new()
            .severity(Severity::Error)
            .icon(IconName::XCircle)
            .title("Context Too Large")
            .description(MESSAGE)
            .actions_slot(
                h_flex()
                    .gap_0p5()
                    .child(self.new_thread_button(cx))
                    .child(self.create_copy_button(MESSAGE)),
            )
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn retry_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Button::new("retry", "Retry")
            .label_size(LabelSize::Small)
            .style(ButtonStyle::Filled)
            .on_click(cx.listener(|this, _, _, cx| {
                this.retry_generation(cx);
            }))
    }

    fn new_thread_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Button::new("new_thread", "New Thread")
            .label_size(LabelSize::Small)
            .style(ButtonStyle::Filled)
            .on_click(cx.listener(|this, _, window, cx| {
                this.clear_thread_error(cx);
                window.dispatch_action(NewThread.boxed_clone(), cx);
            }))
    }

    fn upgrade_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Button::new("upgrade", "Upgrade")
            .label_size(LabelSize::Small)
            .style(ButtonStyle::Tinted(ui::TintColor::Accent))
            .on_click(cx.listener({
                move |this, _, _, cx| {
                    this.clear_thread_error(cx);
                    cx.open_url(&zed_urls::upgrade_to_zed_pro_url(cx));
                }
            }))
    }

    fn authenticate_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        Button::new("authenticate", "Authenticate")
            .label_size(LabelSize::Small)
            .style(ButtonStyle::Filled)
            .on_click(cx.listener({
                move |this, _, window, cx| {
                    let server_view = this.server_view.clone();
                    let agent_name = this.agent_id.clone();

                    this.clear_thread_error(cx);
                    if let Some(message) = this.in_flight_prompt.take() {
                        this.message_editor.update(cx, |editor, cx| {
                            editor.set_message(message, window, cx);
                        });
                    }
                    let connection = this.thread.read(cx).connection().clone();
                    window.defer(cx, |window, cx| {
                        ConversationView::handle_auth_required(
                            server_view,
                            AuthRequired::new(),
                            agent_name,
                            connection,
                            window,
                            cx,
                        );
                    })
                }
            }))
    }

    fn current_model_name(&self, cx: &App) -> SharedString {
        // For native agent (Backboard), use the specific model name (e.g., "Claude 3.5 Sonnet")
        // For ACP agents, use the agent name (e.g., "Claude Agent", "Gemini CLI")
        // This provides better clarity about what refused the request
        if self.as_native_connection(cx).is_some() {
            self.model_selector
                .clone()
                .and_then(|selector| selector.read(cx).active_model(cx))
                .map(|model| model.name.clone())
                .unwrap_or_else(|| SharedString::from("The model"))
        } else {
            // ACP agent - use the agent name (e.g., "Claude Agent", "Gemini CLI")
            self.agent_id.0.clone()
        }
    }

    fn render_any_thread_error(
        &mut self,
        error: SharedString,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Callout {
        let can_resume = self.thread.read(cx).can_retry(cx);

        let markdown = if let Some(markdown) = &self.thread_error_markdown {
            markdown.clone()
        } else {
            let markdown = cx.new(|cx| Markdown::new(error.clone(), None, None, cx));
            self.thread_error_markdown = Some(markdown.clone());
            markdown
        };

        let markdown_style =
            MarkdownStyle::themed(MarkdownFont::Agent, window, cx).with_muted_text(cx);
        let description = self
            .render_markdown(markdown, markdown_style)
            .into_any_element();

        Callout::new()
            .severity(Severity::Error)
            .icon(IconName::XCircle)
            .title("An Error Happened")
            .description_slot(description)
            .actions_slot(
                h_flex()
                    .gap_0p5()
                    .when(can_resume, |this| {
                        this.child(
                            IconButton::new("retry", IconName::RotateCw)
                                .icon_size(IconSize::Small)
                                .tooltip(Tooltip::text("Retry Generation"))
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.retry_generation(cx);
                                })),
                        )
                    })
                    .child(self.create_copy_button(error.to_string())),
            )
            .dismiss_action(self.dismiss_error_button(cx))
    }

    fn render_markdown(&self, markdown: Entity<Markdown>, style: MarkdownStyle) -> MarkdownElement {
        let workspace = self.workspace.clone();
        MarkdownElement::new(markdown, style).on_url_click(move |text, window, cx| {
            open_link(text, &workspace, window, cx);
        })
    }

    fn create_copy_button(&self, message: impl Into<String>) -> impl IntoElement {
        let message = message.into();

        CopyButton::new("copy-error-message", message).tooltip_label("Copy Error Message")
    }

    fn dismiss_error_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        IconButton::new("dismiss", IconName::Close)
            .icon_size(IconSize::Small)
            .tooltip(Tooltip::text("Dismiss"))
            .on_click(cx.listener({
                move |this, _, _, cx| {
                    this.clear_thread_error(cx);
                    cx.notify();
                }
            }))
    }

    fn render_resume_notice(_cx: &Context<Self>) -> AnyElement {
        let description = "This agent does not support viewing previous messages. However, your session will still continue from where you last left off.";

        Callout::new()
            .border_position(ui::BorderPosition::Bottom)
            .severity(Severity::Info)
            .icon(IconName::Info)
            .title("Resumed Session")
            .description(description)
            .into_any_element()
    }

    fn render_codex_windows_warning(&self, cx: &mut Context<Self>) -> Callout {
        Callout::new()
            .icon(IconName::Warning)
            .severity(Severity::Warning)
            .title("Codex on Windows")
            .description("For best performance, run Codex in Windows Subsystem for Linux (WSL2)")
            .actions_slot(
                Button::new("open-wsl-modal", "Open in WSL").on_click(cx.listener({
                    move |_, _, _window, cx| {
                        #[cfg(windows)]
                        _window.dispatch_action(
                            zed_actions::wsl_actions::OpenWsl::default().boxed_clone(),
                            cx,
                        );
                        cx.notify();
                    }
                })),
            )
            .dismiss_action(
                IconButton::new("dismiss", IconName::Close)
                    .icon_size(IconSize::Small)
                    .icon_color(Color::Muted)
                    .tooltip(Tooltip::text("Dismiss Warning"))
                    .on_click(cx.listener({
                        move |this, _, _, cx| {
                            this.show_codex_windows_warning = false;
                            cx.notify();
                        }
                    })),
            )
    }

    fn render_external_source_prompt_warning(&self, cx: &mut Context<Self>) -> Callout {
        Callout::new()
            .icon(IconName::Warning)
            .severity(Severity::Warning)
            .title("Review before sending")
            .description("This prompt was pre-filled by an external link. Read it carefully before you send it.")
            .dismiss_action(
                IconButton::new("dismiss-external-source-prompt-warning", IconName::Close)
                    .icon_size(IconSize::Small)
                    .icon_color(Color::Muted)
                    .tooltip(Tooltip::text("Dismiss Warning"))
                    .on_click(cx.listener({
                        move |this, _, _, cx| {
                            this.show_external_source_prompt_warning = false;
                            cx.notify();
                        }
                    })),
            )
    }

    fn render_multi_root_callout(&self, cx: &mut Context<Self>) -> Option<Callout> {
        if self.multi_root_callout_dismissed {
            return None;
        }

        if self.as_native_connection(cx).is_some() {
            return None;
        }

        let project = self.project.upgrade()?;
        let worktree_count = project.read(cx).visible_worktrees(cx).count();
        if worktree_count <= 1 {
            return None;
        }

        let work_dirs = self.thread.read(cx).work_dirs()?;
        let active_dir = work_dirs
            .ordered_paths()
            .next()
            .and_then(|p| p.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "one folder".to_string());

        let description = format!(
            "This agent only operates on \"{}\". Other folders in this workspace are not accessible to it.",
            active_dir
        );

        Some(
            Callout::new()
                .severity(Severity::Warning)
                .icon(IconName::Warning)
                .title("External Agents currently don't support multi-root workspaces")
                .description(description)
                .border_position(ui::BorderPosition::Bottom)
                .dismiss_action(
                    IconButton::new("dismiss-multi-root-callout", IconName::Close)
                        .icon_size(IconSize::Small)
                        .tooltip(Tooltip::text("Dismiss"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.multi_root_callout_dismissed = true;
                            cx.notify();
                        })),
                ),
        )
    }

    fn render_new_version_callout(&self, version: &SharedString, cx: &mut Context<Self>) -> Div {
        let server_view = self.server_view.clone();
        let has_version = !version.is_empty();
        let title = if has_version {
            "New version available"
        } else {
            "Agent update available"
        };
        let button_label = if has_version {
            format!("Update to v{}", version)
        } else {
            "Reconnect".to_string()
        };

        v_flex().w_full().justify_end().child(
            h_flex()
                .p_2()
                .pr_3()
                .w_full()
                .gap_1p5()
                .border_t_1()
                .border_color(cx.theme().colors().border_variant.opacity(0.68))
                .bg(cx
                    .theme()
                    .colors()
                    .element_background
                    .blend(cx.theme().colors().panel_background.opacity(0.2)))
                .child(
                    h_flex()
                        .flex_1()
                        .gap_1p5()
                        .child(
                            Icon::new(IconName::Download)
                                .color(Color::Accent)
                                .size(IconSize::Small),
                        )
                        .child(Label::new(title).size(LabelSize::Small)),
                )
                .child(
                    Button::new("update-button", button_label)
                        .label_size(LabelSize::Small)
                        .style(ButtonStyle::Tinted(TintColor::Accent))
                        .on_click(move |_, window, cx| {
                            server_view
                                .update(cx, |view, cx| view.reset(window, cx))
                                .ok();
                        }),
                ),
        )
    }

    fn render_token_limit_callout(&self, cx: &mut Context<Self>) -> Option<Callout> {
        if self.token_limit_callout_dismissed || self.as_native_thread(cx).is_none() {
            return None;
        }

        let token_usage = self.thread.read(cx).token_usage()?;
        let ratio = token_usage.ratio();

        let (severity, icon, title) = match ratio {
            acp_thread::TokenUsageRatio::Normal => return None,
            acp_thread::TokenUsageRatio::Warning => (
                Severity::Warning,
                IconName::Warning,
                "Thread reaching the token limit soon",
            ),
            acp_thread::TokenUsageRatio::Exceeded => (
                Severity::Error,
                IconName::XCircle,
                "Thread reached the token limit",
            ),
        };

        let description = "To continue, start a new thread from a summary.";

        Some(
            Callout::new()
                .severity(severity)
                .icon(icon)
                .title(title)
                .description(description)
                .actions_slot(
                    h_flex().gap_0p5().child(
                        Button::new("start-new-thread", "Start New Thread")
                            .label_size(LabelSize::Small)
                            .on_click(cx.listener(|this, _, window, cx| {
                                let session_id = this.thread.read(cx).session_id().clone();
                                window.dispatch_action(
                                    crate::NewNativeAgentThreadFromSummary {
                                        from_session_id: session_id,
                                    }
                                    .boxed_clone(),
                                    cx,
                                );
                            })),
                    ),
                )
                .dismiss_action(self.dismiss_error_button(cx)),
        )
    }

    fn open_permission_dropdown(
        &mut self,
        _: &crate::OpenPermissionDropdown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let menu_handle = self.permission_dropdown_handle.clone();
        window.defer(cx, move |window, cx| {
            menu_handle.toggle(window, cx);
        });
    }

    fn open_add_context_menu(
        &mut self,
        _action: &OpenAddContextMenu,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let menu_handle = self.add_context_menu_handle.clone();
        window.defer(cx, move |window, cx| {
            menu_handle.toggle(window, cx);
        });
    }

    fn toggle_fast_mode(&mut self, cx: &mut Context<Self>) {
        if !self.fast_mode_available(cx) {
            return;
        }
        let Some(thread) = self.as_native_thread(cx) else {
            return;
        };
        thread.update(cx, |thread, cx| {
            let new_speed = thread
                .speed()
                .map(|speed| speed.toggle())
                .unwrap_or(Speed::Fast);
            thread.set_speed(new_speed, cx);

            let favorite_key = thread
                .model()
                .map(|model| (model.provider_id().0.to_string(), model.id().0.to_string()));
            let fs = thread.project().read(cx).fs().clone();
            update_settings_file(fs, cx, move |settings, _| {
                if let Some(agent) = settings.agent.as_mut() {
                    if let Some(default_model) = agent.default_model.as_mut() {
                        default_model.speed = Some(new_speed);
                    }
                    if let Some((provider_id, model_id)) = &favorite_key {
                        agent.update_favorite_model(provider_id, model_id, |favorite| {
                            favorite.speed = Some(new_speed)
                        });
                    }
                }
            });
        });
    }

    fn cycle_thinking_effort(&mut self, cx: &mut Context<Self>) {
        let Some(thread) = self.as_native_thread(cx) else {
            return;
        };

        let (effort_levels, current_effort) = {
            let thread_ref = thread.read(cx);
            let Some(model) = thread_ref.model() else {
                return;
            };
            if !model.supports_thinking() || !thread_ref.thinking_enabled() {
                return;
            }
            let effort_levels = model.supported_effort_levels();
            if effort_levels.is_empty() {
                return;
            }
            let current_effort = thread_ref.thinking_effort().cloned();
            (effort_levels, current_effort)
        };

        let current_index = current_effort.and_then(|current| {
            effort_levels
                .iter()
                .position(|level| level.value == current)
        });
        let next_index = match current_index {
            Some(index) => (index + 1) % effort_levels.len(),
            None => 0,
        };
        let next_effort = effort_levels[next_index].value.to_string();

        thread.update(cx, |thread, cx| {
            thread.set_thinking_effort(Some(next_effort.clone()), cx);

            let favorite_key = thread
                .model()
                .map(|model| (model.provider_id().0.to_string(), model.id().0.to_string()));
            let fs = thread.project().read(cx).fs().clone();
            update_settings_file(fs, cx, move |settings, _| {
                if let Some(agent) = settings.agent.as_mut() {
                    if let Some(default_model) = agent.default_model.as_mut() {
                        default_model.effort = Some(next_effort.clone());
                    }
                    if let Some((provider_id, model_id)) = &favorite_key {
                        agent.update_favorite_model(provider_id, model_id, |favorite| {
                            favorite.effort = Some(next_effort)
                        });
                    }
                }
            });
        });
    }

    fn toggle_thinking_effort_menu(
        &mut self,
        _action: &ToggleThinkingEffortMenu,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let menu_handle = self.thinking_effort_menu_handle.clone();
        window.defer(cx, move |window, cx| {
            menu_handle.toggle(window, cx);
        });
    }
}

impl Render for ThreadView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_messages = self.list_state.item_count() > 0;
        let list_state = self.list_state.clone();
        let colors = cx.theme().colors();
        let thread_bg = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.68));

        let conversation = v_flex()
            .when(self.resumed_without_history, |this| {
                this.child(Self::render_resume_notice(cx))
            })
            .map(|this| {
                if has_messages {
                    this.flex_1()
                        .min_h_0()
                        .w_full()
                        .child(self.render_entries(cx))
                        .vertical_scrollbar_for(&list_state, window, cx)
                        .into_any()
                } else {
                    this.flex_1().min_h_0().w_full().into_any()
                }
            });

        v_flex()
            .key_context("AcpThread")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &menu::Cancel, _, cx| {
                if this.parent_session_id.is_none() {
                    this.cancel_generation(cx);
                }
            }))
            .on_action(cx.listener(|this, _: &workspace::GoBack, window, cx| {
                if let Some(parent_session_id) = this.thread.read(cx).parent_session_id().cloned() {
                    this.server_view
                        .update(cx, |view, cx| {
                            view.navigate_to_thread(parent_session_id, window, cx);
                        })
                        .ok();
                }
            }))
            .on_action(cx.listener(Self::keep_all))
            .on_action(cx.listener(Self::reject_all))
            .on_action(cx.listener(Self::undo_last_reject))
            .on_action(cx.listener(Self::allow_always))
            .on_action(cx.listener(Self::allow_once))
            .on_action(cx.listener(Self::reject_once))
            .on_action(cx.listener(Self::handle_authorize_tool_call))
            .on_action(cx.listener(Self::handle_select_permission_granularity))
            .on_action(cx.listener(Self::handle_toggle_command_pattern))
            .on_action(cx.listener(Self::open_permission_dropdown))
            .on_action(cx.listener(Self::open_add_context_menu))
            .on_action(cx.listener(Self::scroll_output_page_up))
            .on_action(cx.listener(Self::scroll_output_page_down))
            .on_action(cx.listener(Self::scroll_output_line_up))
            .on_action(cx.listener(Self::scroll_output_line_down))
            .on_action(cx.listener(Self::scroll_output_to_top))
            .on_action(cx.listener(Self::scroll_output_to_bottom))
            .on_action(cx.listener(Self::scroll_output_to_previous_message))
            .on_action(cx.listener(Self::scroll_output_to_next_message))
            .on_action(cx.listener(|this, _: &ToggleFastMode, _window, cx| {
                this.toggle_fast_mode(cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleThinkingMode, _window, cx| {
                if this.thread.read(cx).status() != ThreadStatus::Idle {
                    return;
                }
                if let Some(thread) = this.as_native_thread(cx) {
                    thread.update(cx, |thread, cx| {
                        thread.set_thinking_enabled(!thread.thinking_enabled(), cx);
                    });
                }
            }))
            .on_action(cx.listener(|this, _: &CycleThinkingEffort, _window, cx| {
                if this.thread.read(cx).status() != ThreadStatus::Idle {
                    return;
                }
                this.cycle_thinking_effort(cx);
            }))
            .on_action(
                cx.listener(|this, action: &ToggleThinkingEffortMenu, window, cx| {
                    if this.thread.read(cx).status() != ThreadStatus::Idle {
                        return;
                    }
                    this.toggle_thinking_effort_menu(action, window, cx);
                }),
            )
            .on_action(cx.listener(|this, _: &SendNextQueuedMessage, window, cx| {
                this.send_queued_message_at_index(0, true, window, cx);
            }))
            .on_action(cx.listener(|this, _: &RemoveFirstQueuedMessage, _, cx| {
                this.remove_from_queue(0, cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &EditFirstQueuedMessage, window, cx| {
                this.move_queued_message_to_main_editor(0, None, None, window, cx);
            }))
            .on_action(cx.listener(|this, _: &ClearMessageQueue, _, cx| {
                this.local_queued_messages.clear();
                this.sync_queue_flag_to_native_thread(cx);
                this.can_fast_track_queue = false;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleProfileSelector, window, cx| {
                if this.thread.read(cx).status() != ThreadStatus::Idle {
                    return;
                }
                if let Some(config_options_view) = this.config_options_view.clone() {
                    let handled = config_options_view.update(cx, |view, cx| {
                        view.toggle_category_picker(
                            acp::SessionConfigOptionCategory::Mode,
                            window,
                            cx,
                        )
                    });
                    if handled {
                        return;
                    }
                }

                if let Some(profile_selector) = this.profile_selector.clone() {
                    profile_selector.read(cx).menu_handle().toggle(window, cx);
                } else if let Some(mode_selector) = this.mode_selector.clone() {
                    mode_selector.read(cx).menu_handle().toggle(window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &CycleModeSelector, window, cx| {
                if this.thread.read(cx).status() != ThreadStatus::Idle {
                    return;
                }
                if let Some(config_options_view) = this.config_options_view.clone() {
                    let handled = config_options_view.update(cx, |view, cx| {
                        view.cycle_category_option(
                            acp::SessionConfigOptionCategory::Mode,
                            false,
                            cx,
                        )
                    });
                    if handled {
                        return;
                    }
                }

                if let Some(profile_selector) = this.profile_selector.clone() {
                    profile_selector.update(cx, |profile_selector, cx| {
                        profile_selector.cycle_profile(cx);
                    });
                } else if let Some(mode_selector) = this.mode_selector.clone() {
                    mode_selector.update(cx, |mode_selector, cx| {
                        mode_selector.cycle_mode(window, cx);
                    });
                }
            }))
            .on_action(cx.listener(|this, _: &ToggleModelSelector, window, cx| {
                this.toggle_model_selector(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CycleFavoriteModels, window, cx| {
                if this.thread.read(cx).status() != ThreadStatus::Idle {
                    return;
                }
                if let Some(config_options_view) = this.config_options_view.clone() {
                    let handled = config_options_view.update(cx, |view, cx| {
                        view.cycle_category_option(
                            acp::SessionConfigOptionCategory::Model,
                            true,
                            cx,
                        )
                    });
                    if handled {
                        return;
                    }
                }

                if let Some(model_selector) = this.model_selector.clone() {
                    model_selector.update(cx, |model_selector, cx| {
                        model_selector.cycle_favorite_models(window, cx);
                    });
                }
            }))
            .size_full()
            .bg(thread_bg)
            .children(self.render_subagent_titlebar(cx))
            .child(conversation)
            .children(self.render_multi_root_callout(cx))
            .children(self.render_activity_bar(window, cx))
            .when(self.show_external_source_prompt_warning, |this| {
                this.child(self.render_external_source_prompt_warning(cx))
            })
            .when(self.show_codex_windows_warning, |this| {
                this.child(self.render_codex_windows_warning(cx))
            })
            .children(self.render_thread_retry_status_callout())
            .children(self.render_thread_error(window, cx))
            .when_some(
                match has_messages {
                    true => None,
                    false => self.new_server_version_available.clone(),
                },
                |this, version| this.child(self.render_new_version_callout(&version, cx)),
            )
            .children(self.render_token_limit_callout(cx))
            .child(self.render_message_editor(window, cx))
    }
}

pub(crate) fn open_link(
    url: SharedString,
    workspace: &WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(workspace) = workspace.upgrade() else {
        cx.open_url(&url);
        return;
    };

    if let Some(mention) = MentionUri::parse(&url, workspace.read(cx).path_style(cx)).log_err() {
        workspace.update(cx, |workspace, cx| match mention {
            MentionUri::File { abs_path } => {
                let project = workspace.project();
                let Some(path) =
                    project.update(cx, |project, cx| project.find_project_path(abs_path, cx))
                else {
                    return;
                };

                workspace
                    .open_path(path, None, true, window, cx)
                    .detach_and_log_err(cx);
            }
            MentionUri::PastedImage { .. } => {}
            MentionUri::Directory { abs_path } => {
                let project = workspace.project();
                let Some(entry_id) = project.update(cx, |project, cx| {
                    let path = project.find_project_path(abs_path, cx)?;
                    project.entry_for_path(&path, cx).map(|entry| entry.id)
                }) else {
                    return;
                };

                project.update(cx, |_, cx| {
                    cx.emit(project::Event::RevealInProjectPanel(entry_id));
                });
            }
            MentionUri::Symbol {
                abs_path: path,
                line_range,
                ..
            }
            | MentionUri::Selection {
                abs_path: Some(path),
                line_range,
            } => {
                let project = workspace.project();
                let Some(path) =
                    project.update(cx, |project, cx| project.find_project_path(path, cx))
                else {
                    return;
                };

                let item = workspace.open_path(path, None, true, window, cx);
                window
                    .spawn(cx, async move |cx| {
                        let Some(editor) = item.await?.downcast::<Editor>() else {
                            return Ok(());
                        };
                        let range =
                            Point::new(*line_range.start(), 0)..Point::new(*line_range.start(), 0);
                        editor
                            .update_in(cx, |editor, window, cx| {
                                editor.change_selections(
                                    SelectionEffects::scroll(Autoscroll::center()),
                                    window,
                                    cx,
                                    |s| s.select_ranges(vec![range]),
                                );
                            })
                            .ok();
                        anyhow::Ok(())
                    })
                    .detach_and_log_err(cx);
            }
            MentionUri::Selection { abs_path: None, .. } => {}
            MentionUri::Thread { id, name } => {
                if let Some(panel) = workspace.panel::<AgentPanel>(cx) {
                    panel.update(cx, |panel, cx| {
                        panel.open_thread(id, None, Some(name.into()), window, cx)
                    });
                }
            }
            MentionUri::Rule { id, .. } => {
                let PromptId::User { uuid } = id else {
                    return;
                };
                window.dispatch_action(
                    Box::new(OpenRulesLibrary {
                        prompt_to_select: Some(uuid.0),
                    }),
                    cx,
                )
            }
            MentionUri::Fetch { url } => {
                cx.open_url(url.as_str());
            }
            MentionUri::Diagnostics { .. } => {}
            MentionUri::TerminalSelection { .. } => {}
            MentionUri::GitDiff { .. } => {}
            MentionUri::MergeConflict { .. } => {}
        })
    } else {
        cx.open_url(&url);
    }
}
