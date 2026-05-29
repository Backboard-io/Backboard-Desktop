use db::kvp::KeyValueStore;
use editor::{Editor, EditorElement, EditorEvent, EditorStyle};
use gpui::{
    App, ClipboardItem, Context, Entity, FocusHandle, Focusable, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Subscription, TextStyle, WeakEntity, Window,
    prelude::*,
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

const SKILLS_KVP_KEY: &str = "backboard_skills_v1";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedBackboardSkill {
    pub id: String,
    pub section: String,
    pub title: String,
    pub prompt: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl SavedBackboardSkill {
    fn new(section: String, title: String, prompt: String) -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            section,
            title,
            prompt,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }
}

#[derive(Clone, Copy)]
struct SkillTemplate {
    section: &'static str,
    title: &'static str,
    description: &'static str,
    prompt: &'static str,
}

const SECTIONS: &[&str] = &["Websites", "Shopify", "Design Systems", "Product"];

const SKILL_TEMPLATES: &[SkillTemplate] = &[
    SkillTemplate {
        section: "Websites",
        title: "Website From Brief",
        description: "Turn a product brief into a production-quality website starting point.",
        prompt: r#"---
name: website-from-brief
description: Use when creating a website from a product, brand, or service brief.
---

# Website From Brief

Build the first usable version of the site, not a placeholder landing page.

Start by identifying the audience, primary action, proof points, and content hierarchy. Use the existing codebase and design system before adding new abstractions. Create a strong first viewport with the product, place, person, or offer immediately visible. Use real or generated bitmap imagery when visual assets are needed.

Deliver responsive desktop and mobile layouts, complete navigation, polished empty/error/loading states where relevant, and concise on-page copy. Verify the result in the browser and fix visible layout issues before reporting back."#,
    },
    SkillTemplate {
        section: "Websites",
        title: "SaaS App Screen",
        description: "Create a dense, work-focused SaaS screen instead of a marketing shell.",
        prompt: r#"---
name: saas-app-screen
description: Use when creating an operational SaaS, CRM, admin, or internal-tool interface.
---

# SaaS App Screen

Build the actual tool surface as the first screen. Favor compact information density, predictable navigation, visible controls, useful defaults, and clear table/list/detail workflows.

Avoid oversized hero sections, decorative cards, abstract gradients, and marketing composition. Use icons for common actions, restrained color, 8px-or-smaller card radii unless the design system says otherwise, and stable dimensions for toolbars, filters, tabs, counters, and repeated rows.

Include realistic data, selected/hover/empty states, and mobile behavior. Run the local app and inspect the screen for overlap, clipping, and unreadable text."#,
    },
    SkillTemplate {
        section: "Shopify",
        title: "Product Detail Page",
        description: "Build a Shopify PDP basis with merchandising, variants, trust, and conversion details.",
        prompt: r#"---
name: shopify-product-detail-page
description: Use when building or improving a Shopify product detail page.
---

# Shopify Product Detail Page

Create a product detail page that helps a shopper evaluate, configure, and buy the item.

Include product media, title, price, variant selectors, quantity, add-to-cart, shipping/returns cues, accordions for details, reviews or social proof, related products, and inventory or urgency states where appropriate. Use swatches for color and familiar controls for variants. Keep the layout responsive and make the buy box usable on mobile.

Use the existing storefront framework and theme conventions. Avoid generic stock-like imagery when the product needs to be inspectable. Verify the page renders cleanly across desktop and mobile."#,
    },
    SkillTemplate {
        section: "Shopify",
        title: "Collection Page",
        description: "Create a merchandised collection view with filters, sort, and product cards.",
        prompt: r#"---
name: shopify-collection-page
description: Use when building or improving a Shopify collection or category page.
---

# Shopify Collection Page

Build a collection page optimized for browsing and comparison.

Include collection heading, concise supporting copy, filter controls, sort, product grid, product cards with image, price, badges, ratings or reviews if available, quick add where appropriate, empty results, and mobile filter behavior. Make product imagery prominent and consistent. Avoid decorative wrappers that reduce scanability.

Preserve existing theme structure and data-loading conventions. Verify filter controls, layout wrapping, and card text fit on mobile and desktop."#,
    },
    SkillTemplate {
        section: "Design Systems",
        title: "Design System Starter",
        description: "Generate a reusable foundation from an existing app or new product direction.",
        prompt: r#"---
name: design-system-starter
description: Use when establishing reusable UI foundations, tokens, and components.
---

# Design System Starter

Create or refine the practical foundations first: color roles, typography scale, spacing, elevation, radius, interaction states, and core components.

Build components with realistic variants and states: buttons, inputs, selects, tabs, cards, alerts, tables or lists, modals, and navigation. Prefer existing tokens and component patterns. Keep naming stable and implementation-oriented.

Document usage through examples in the app where possible. Verify contrast, focus states, responsive behavior, and text fitting."#,
    },
    SkillTemplate {
        section: "Product",
        title: "Feature Basis",
        description: "Turn a rough feature request into a usable first implementation.",
        prompt: r#"---
name: feature-basis
description: Use when turning an ambiguous feature idea into a concrete implementation basis.
---

# Feature Basis

Read the local code first, identify the smallest coherent user workflow, and implement that workflow end to end.

Make conservative assumptions that match the codebase. Add focused controls, states, and data structures users would naturally expect. Avoid unrelated refactors. If the request is under-specified, pick a clear default and make the result easy to extend.

Run the smallest relevant verification command. Report what changed, what was verified, and any remaining product questions."#,
    },
];

pub struct BackboardSkillsPage {
    workspace: WeakEntity<Workspace>,
    multi_workspace: WeakEntity<MultiWorkspace>,
    title_editor: Entity<Editor>,
    prompt_editor: Entity<Editor>,
    saved_skills: Vec<SavedBackboardSkill>,
    selected_skill_id: Option<String>,
    selected_section: SharedString,
    observing_agent_panel: bool,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<gpui::Task<()>>,
}

impl BackboardSkillsPage {
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
                editor.set_placeholder_text("Skill name", window, cx);
                editor
            });
            let prompt_editor = cx.new(|cx| {
                let mut editor = Editor::auto_height(12, 28, window, cx);
                editor.set_soft_wrap_mode(SoftWrap::EditorWidth, cx);
                editor.set_placeholder_text(
                    "Write the SKILL.md-style instructions this prompt should apply...",
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
                saved_skills: Vec::new(),
                selected_skill_id: None,
                selected_section: "Websites".into(),
                observing_agent_panel: false,
                _subscriptions: Vec::new(),
                _tasks: Vec::new(),
            };
            let load_task = page.load_skills(cx);
            page._tasks.push(load_task);
            page
        })
    }

    fn handle_editor_event(&mut self, _: Entity<Editor>, _: &EditorEvent, cx: &mut Context<Self>) {
        cx.notify();
    }

    fn load_skills(&self, cx: &mut Context<Self>) -> gpui::Task<()> {
        cx.spawn(async move |this, cx| {
            let skills = cx.update(|cx| {
                let kvp = KeyValueStore::global(cx);
                decode_skills(kvp.read_kvp(SKILLS_KVP_KEY).log_err().flatten())
            });
            this.update(cx, |this, cx| {
                this.saved_skills = skills;
                cx.notify();
            })
            .ok();
        })
    }

    fn persist_skills(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let skills = self.saved_skills.clone();
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&skills) {
                kvp.write_kvp(SKILLS_KVP_KEY.to_string(), json)
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

    fn select_section(&mut self, section: &'static str, cx: &mut Context<Self>) {
        self.selected_section = section.into();
        cx.notify();
    }

    fn select_template(
        &mut self,
        template: SkillTemplate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selected_skill_id = None;
        self.selected_section = template.section.into();
        self.title_editor
            .update(cx, |editor, cx| editor.set_text(template.title, window, cx));
        self.prompt_editor.update(cx, |editor, cx| {
            editor.set_text(template.prompt, window, cx)
        });
        self.prompt_editor
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
        cx.notify();
    }

    fn select_saved_skill(
        &mut self,
        skill: SavedBackboardSkill,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selected_skill_id = Some(skill.id.clone());
        self.selected_section = skill.section.clone().into();
        self.title_editor
            .update(cx, |editor, cx| editor.set_text(skill.title, window, cx));
        self.prompt_editor
            .update(cx, |editor, cx| editor.set_text(skill.prompt, window, cx));
        self.prompt_editor
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
        cx.notify();
    }

    fn new_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_skill_id = None;
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

    fn save_current_skill(&mut self, cx: &mut Context<Self>) {
        let prompt = self.prompt_text(cx);
        if prompt.is_empty() {
            return;
        }

        let title = normalize_title(self.title_text(cx), &prompt);
        let section = self.selected_section.to_string();
        if let Some(selected_id) = self.selected_skill_id.clone()
            && let Some(skill) = self
                .saved_skills
                .iter_mut()
                .find(|skill| skill.id == selected_id)
        {
            skill.section = section;
            skill.title = title;
            skill.prompt = prompt;
            skill.updated_at_ms = now_ms();
            self.persist_skills(cx);
            cx.notify();
            return;
        }

        let skill = SavedBackboardSkill::new(section, title, prompt);
        self.selected_skill_id = Some(skill.id.clone());
        self.saved_skills.insert(0, skill);
        self.persist_skills(cx);
        cx.notify();
    }

    fn delete_current_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(selected_id) = self.selected_skill_id.take() {
            self.saved_skills.retain(|skill| skill.id != selected_id);
            self.persist_skills(cx);
        }
        self.new_skill(window, cx);
    }

    fn copy_current_skill(&self, cx: &mut Context<Self>) {
        let prompt = self.prompt_text(cx);
        if !prompt.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(prompt));
        }
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

    fn run_current_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let skill = self.prompt_text(cx);
        if skill.is_empty() {
            return;
        }

        let title = normalize_title(self.title_text(cx), &skill);
        let prompt = format!(
            "Use this skill as your operating instructions for the next task.\n\n<skill name=\"{title}\">\n{skill}\n</skill>\n\nApply the skill to the current workspace. If the concrete target is ambiguous, inspect the repository first and make a conservative implementation choice."
        );

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
            line_height: relative(1.32),
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

    fn render_section_button(
        &self,
        section: &'static str,
        count: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_section.as_ref() == section;
        let background = if selected {
            cx.theme().colors().element_selected
        } else {
            cx.theme().colors().elevated_surface_background
        };

        h_flex()
            .id(format!("backboard-skill-section-{section}"))
            .w_full()
            .h(rems_from_px(34.))
            .items_center()
            .justify_between()
            .rounded_sm()
            .px_2()
            .bg(background)
            .cursor_pointer()
            .hover(|style| style.bg(cx.theme().colors().element_hover))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_section(section, cx);
            }))
            .child(
                Label::new(section)
                    .size(LabelSize::Small)
                    .color(if selected {
                        Color::Accent
                    } else {
                        Color::Default
                    }),
            )
            .child(
                Label::new(count.to_string())
                    .size(LabelSize::XSmall)
                    .color(Color::Muted),
            )
    }

    fn render_template_card(
        &self,
        template: SkillTemplate,
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
                Label::new(template.title)
                    .size(LabelSize::Small)
                    .color(Color::Default),
            )
            .child(
                Label::new(template.description)
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new(format!("use-skill-template-{}", template.title), "Use")
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_template(template, window, cx);
                            })),
                    )
                    .child(
                        IconButton::new(
                            format!("copy-skill-template-{}", template.title),
                            IconName::Copy,
                        )
                        .icon_size(IconSize::Small)
                        .tooltip(Tooltip::text("Copy skill prompt"))
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                template.prompt.to_string(),
                            ));
                        }),
                    ),
            )
    }

    fn render_saved_skill_card(
        &self,
        skill: SavedBackboardSkill,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_skill_id.as_deref() == Some(skill.id.as_str());
        let id = skill.id.clone();
        let title = skill.title.clone();
        let prompt = skill.prompt.clone();
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
            .id(format!("saved-backboard-skill-{id}"))
            .w_full()
            .min_h(rems_from_px(78.))
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
                this.select_saved_skill(skill.clone(), window, cx);
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

    fn render_left_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let saved_count = self.saved_skills.len();

        v_flex()
            .w(rems_from_px(260.))
            .min_w(rems_from_px(240.))
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
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                Icon::new(IconName::Book)
                                    .size(IconSize::Small)
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new("Skills")
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            ),
                    )
                    .child(
                        Button::new("new-backboard-skill", "New")
                            .start_icon(Icon::new(IconName::Plus))
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_skill(window, cx);
                            })),
                    ),
            )
            .child(
                v_flex()
                    .p_2()
                    .gap_1()
                    .child(
                        Label::new("Sections")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    )
                    .children(SECTIONS.iter().copied().map(|section| {
                        let count = SKILL_TEMPLATES
                            .iter()
                            .filter(|template| template.section == section)
                            .count();
                        self.render_section_button(section, count, cx)
                            .into_any_element()
                    }))
                    .child(self.render_section_button("Saved", saved_count, cx)),
            )
    }

    fn render_library_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let selected_section = self.selected_section.to_string();
        let cards = if selected_section == "Saved" {
            self.saved_skills
                .iter()
                .cloned()
                .map(|skill| self.render_saved_skill_card(skill, cx).into_any_element())
                .collect::<Vec<_>>()
        } else {
            SKILL_TEMPLATES
                .iter()
                .copied()
                .filter(|template| template.section == selected_section)
                .map(|template| self.render_template_card(template, cx).into_any_element())
                .collect::<Vec<_>>()
        };

        v_flex()
            .w(rems_from_px(420.))
            .min_w(rems_from_px(320.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().panel_background)
            .child(
                h_flex()
                    .h(rems_from_px(52.))
                    .px_3()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(
                        Label::new(&selected_section)
                            .size(LabelSize::Small)
                            .color(Color::Default),
                    )
                    .child(
                        Label::new("Prompt library")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(
                v_flex()
                    .id("backboard-skills-library-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .gap_2()
                    .children(cards)
                    .when(
                        selected_section == "Saved" && self.saved_skills.is_empty(),
                        |this| {
                            this.child(
                                v_flex()
                                    .items_center()
                                    .gap_2()
                                    .pt_8()
                                    .child(
                                        Icon::new(IconName::Sparkle)
                                            .size(IconSize::Medium)
                                            .color(Color::Muted),
                                    )
                                    .child(
                                        Headline::new("No saved skills yet")
                                            .size(HeadlineSize::XSmall)
                                            .color(Color::Accent),
                                    )
                                    .child(
                                        Label::new(
                                            "Use a starter, edit it, then save it as a reusable skill.",
                                        )
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                    ),
                            )
                        },
                    ),
            )
    }

    fn render_editor_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let can_use = self.has_prompt(cx);
        let can_delete = self.selected_skill_id.is_some();

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
                                Vector::square(VectorName::BackboardLogo, rems_from_px(16.))
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new("Skills")
                                    .size(LabelSize::Small)
                                    .color(Color::Default),
                            )
                            .child(
                                Label::new("Claude-style prompt bases")
                                    .size(LabelSize::Small)
                                    .color(Color::Muted),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("save-backboard-skill", "Save")
                                    .size(ButtonSize::Compact)
                                    .style(ButtonStyle::Subtle)
                                    .disabled(!can_use)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.save_current_skill(cx);
                                    })),
                            )
                            .child(
                                IconButton::new("copy-backboard-skill", IconName::Copy)
                                    .icon_size(IconSize::Small)
                                    .disabled(!can_use)
                                    .tooltip(Tooltip::text("Copy skill prompt"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.copy_current_skill(cx);
                                    })),
                            )
                            .child(
                                Button::new("run-backboard-skill", "Run")
                                    .start_icon(Icon::new(IconName::PlayFilled))
                                    .size(ButtonSize::Compact)
                                    .style(ButtonStyle::Tinted(TintColor::Accent))
                                    .disabled(!can_use)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.run_current_skill(window, cx);
                                    })),
                            )
                            .child(
                                IconButton::new("delete-backboard-skill", IconName::Trash)
                                    .icon_size(IconSize::Small)
                                    .disabled(!can_delete)
                                    .tooltip(Tooltip::text("Delete skill"))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.delete_current_skill(window, cx);
                                    })),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .id("backboard-skill-editor-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .gap_3()
                    .child(
                        v_flex()
                            .max_w(rems_from_px(860.))
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
                            .max_w(rems_from_px(860.))
                            .gap_1()
                            .child(
                                h_flex()
                                    .justify_between()
                                    .child(
                                        Label::new("SKILL.md prompt")
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    )
                                    .child(
                                        Label::new(self.selected_section.clone())
                                            .size(LabelSize::Small)
                                            .color(Color::Accent),
                                    ),
                            )
                            .child(
                                div()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(cx.theme().colors().border_variant)
                                    .bg(cx.theme().colors().element_background)
                                    .shadow(ElevationIndex::ElevatedSurface.shadow(cx))
                                    .p_2()
                                    .child(self.render_text_editor(&self.prompt_editor, 0.84, cx)),
                            ),
                    ),
            )
    }
}

impl Render for BackboardSkillsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .size_full()
            .bg(cx.theme().colors().editor_background)
            .child(self.render_left_panel(cx))
            .child(self.render_library_panel(cx))
            .child(self.render_editor_panel(cx))
    }
}

impl Focusable for BackboardSkillsPage {
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

fn decode_skills(raw: Option<String>) -> Vec<SavedBackboardSkill> {
    raw.and_then(|json| serde_json::from_str::<Vec<SavedBackboardSkill>>(&json).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_skills_empty_and_corrupt_json_fail_open() {
        assert!(decode_skills(None).is_empty());
        assert!(decode_skills(Some("not json".to_string())).is_empty());
    }

    #[test]
    fn test_decode_skills_round_trips_saved_skill() {
        let skill = SavedBackboardSkill {
            id: "skill-1".to_string(),
            section: "Websites".to_string(),
            title: "Website".to_string(),
            prompt: "Build a site".to_string(),
            created_at_ms: 1,
            updated_at_ms: 2,
        };
        let json = serde_json::to_string(&vec![skill.clone()]).unwrap();
        assert_eq!(decode_skills(Some(json)), vec![skill]);
    }

    #[test]
    fn test_normalize_title_uses_prompt_fallback() {
        assert_eq!(
            normalize_title("".to_string(), "  Build the PDP\nthen test it"),
            "Build the PDP"
        );
        assert_eq!(
            normalize_title("  Shopify PDP  ".to_string(), "Build"),
            "Shopify PDP"
        );
    }
}
