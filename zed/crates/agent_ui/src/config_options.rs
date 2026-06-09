use std::{cmp::Reverse, rc::Rc, sync::Arc};

use acp_thread::AgentSessionConfigOptions;
use agent_client_protocol::schema as acp;
use agent_servers::AgentServer;

use collections::HashSet;
use fs::Fs;
use fuzzy::StringMatchCandidate;
use gpui::{
    App, BackgroundExecutor, Context, DismissEvent, Entity, Subscription, Task, Window, prelude::*,
};
use ordered_float::OrderedFloat;
use picker::popover_menu::PickerPopoverMenu;
use picker::{Picker, PickerDelegate};
use settings::SettingsStore;
use ui::{
    ButtonLike, ElevationIndex, IconButton, ListItem, ListItemSpacing, PopoverMenuHandle,
    TintColor, Tooltip, prelude::*,
};
use util::ResultExt as _;

use crate::ui::{HoldForDefault, documentation_aside_side};

const PICKER_THRESHOLD: usize = 5;

pub struct ConfigOptionsView {
    config_options: Rc<dyn AgentSessionConfigOptions>,
    selectors: Vec<Entity<ConfigOptionSelector>>,
    agent_server: Rc<dyn AgentServer>,
    fs: Arc<dyn Fs>,
    config_option_ids: Vec<acp::SessionConfigId>,
    option_summaries: Vec<ConfigOptionSummary>,
    _refresh_task: Task<()>,
}

impl ConfigOptionsView {
    pub fn new(
        config_options: Rc<dyn AgentSessionConfigOptions>,
        agent_server: Rc<dyn AgentServer>,
        fs: Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let options = config_options.config_options();
        let selectors =
            Self::build_selectors(&options, &config_options, &agent_server, &fs, window, cx);
        let config_option_ids = Self::config_option_ids(&options);
        let option_summaries = Self::option_summaries_from_options(options);

        let rx = config_options.watch(cx);
        let refresh_task = cx.spawn_in(window, async move |this, cx| {
            if let Some(mut rx) = rx {
                while let Ok(()) = rx.recv().await {
                    this.update_in(cx, |this, window, cx| {
                        this.rebuild_selectors(window, cx);
                        cx.notify();
                    })
                    .log_err();
                }
            }
        });

        Self {
            config_options,
            selectors,
            agent_server,
            fs,
            config_option_ids,
            option_summaries,
            _refresh_task: refresh_task,
        }
    }

    pub fn toggle_category_picker(
        &mut self,
        category: acp::SessionConfigOptionCategory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(config_id) = self.first_config_option_id(category) else {
            return false;
        };

        let Some(selector) = self.selector_for_config_id(&config_id, cx) else {
            return false;
        };

        selector.update(cx, |selector, cx| {
            selector.toggle_picker(window, cx);
        });
        cx.notify();

        true
    }

    pub fn cycle_category_option(
        &mut self,
        category: acp::SessionConfigOptionCategory,
        favorites_only: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(config_id) = self.first_config_option_id(category) else {
            return false;
        };

        let Some(next_value) = self.next_value_for_config(&config_id, favorites_only, cx) else {
            return false;
        };

        let task = self
            .config_options
            .set_config_option(config_id, next_value, cx);

        cx.spawn(async move |this, cx| match task.await {
            Ok(options) => {
                this.update(cx, |this, cx| {
                    this.apply_options_snapshot(options);
                    cx.notify();
                })
                .ok();
            }
            Err(err) => log::error!("Failed to set config option: {:?}", err),
        })
        .detach();
        cx.notify();

        true
    }

    pub(crate) fn option_summaries(&self) -> Vec<ConfigOptionSummary> {
        self.option_summaries.clone()
    }

    pub(crate) fn option_value_summaries(
        &self,
        config_id: &acp::SessionConfigId,
    ) -> Vec<ConfigOptionValueSummary> {
        let current_value = get_current_value(&self.config_options, config_id);

        extract_options(&self.config_options, config_id)
            .into_iter()
            .map(|option| ConfigOptionValueSummary {
                is_current: current_value.as_ref() == Some(&option.value),
                value: option.value,
                name: option.name,
                description: option.description,
            })
            .collect()
    }

    pub(crate) fn category_picker_trigger(
        &self,
        category: acp::SessionConfigOptionCategory,
        cx: &App,
    ) -> Option<ConfigOptionCategoryPickerTrigger> {
        let config_id = self.first_config_option_id(category)?;
        let selector = self.selector_for_config_id(&config_id, cx)?;

        Some(ConfigOptionCategoryPickerTrigger { selector })
    }

    pub(crate) fn option_picker_trigger(
        &self,
        config_id: &acp::SessionConfigId,
        cx: &App,
    ) -> Option<ConfigOptionPickerTrigger> {
        let selector = self.selector_for_config_id(config_id, cx)?;

        Some(ConfigOptionPickerTrigger { selector })
    }

    pub fn cycle_option(
        &mut self,
        config_id: &acp::SessionConfigId,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(next_value) = self.next_value_for_config(config_id, false, cx) else {
            return false;
        };

        let task = self
            .config_options
            .set_config_option(config_id.clone(), next_value, cx);

        cx.spawn(async move |this, cx| match task.await {
            Ok(options) => {
                this.update(cx, |this, cx| {
                    this.apply_options_snapshot(options);
                    cx.notify();
                })
                .ok();
            }
            Err(err) => log::error!("Failed to set config option: {:?}", err),
        })
        .detach();
        cx.notify();

        true
    }

    pub fn set_option_value(
        &mut self,
        config_id: acp::SessionConfigId,
        value: acp::SessionConfigValueId,
        cx: &mut Context<Self>,
    ) {
        let task = self.config_options.set_config_option(config_id, value, cx);

        cx.spawn(async move |this, cx| match task.await {
            Ok(options) => {
                this.update(cx, |this, cx| {
                    this.apply_options_snapshot(options);
                    cx.notify();
                })
                .ok();
            }
            Err(err) => log::error!("Failed to set config option: {:?}", err),
        })
        .detach();
        cx.notify();
    }

    fn first_config_option_id(
        &self,
        category: acp::SessionConfigOptionCategory,
    ) -> Option<acp::SessionConfigId> {
        self.config_options
            .config_options()
            .into_iter()
            .find(|option| option.category.as_ref() == Some(&category))
            .map(|option| option.id)
    }

    fn selector_for_config_id(
        &self,
        config_id: &acp::SessionConfigId,
        cx: &App,
    ) -> Option<Entity<ConfigOptionSelector>> {
        self.selectors
            .iter()
            .find(|selector| selector.read(cx).config_id() == config_id)
            .cloned()
    }

    fn next_value_for_config(
        &self,
        config_id: &acp::SessionConfigId,
        favorites_only: bool,
        cx: &mut Context<Self>,
    ) -> Option<acp::SessionConfigValueId> {
        let mut options = extract_options(&self.config_options, config_id);
        if options.is_empty() {
            return None;
        }

        if favorites_only {
            let favorites = self
                .agent_server
                .favorite_config_option_value_ids(config_id, cx);
            options.retain(|option| favorites.contains(&option.value));
            if options.is_empty() {
                return None;
            }
        }

        let current_value = get_current_value(&self.config_options, config_id);
        let current_index = current_value
            .as_ref()
            .and_then(|current| options.iter().position(|option| &option.value == current))
            .unwrap_or(usize::MAX);

        let next_index = if current_index == usize::MAX {
            0
        } else {
            (current_index + 1) % options.len()
        };

        Some(options[next_index].value.clone())
    }

    pub fn refresh_options(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.rebuild_selectors(window, cx);
    }

    fn config_option_ids(options: &[acp::SessionConfigOption]) -> Vec<acp::SessionConfigId> {
        options.iter().map(|option| option.id.clone()).collect()
    }

    fn option_summaries_from_options(
        options: Vec<acp::SessionConfigOption>,
    ) -> Vec<ConfigOptionSummary> {
        options
            .into_iter()
            .map(|option| {
                let current_value_name = match &option.kind {
                    acp::SessionConfigKind::Select(select) => {
                        find_option_name(&select.options, &select.current_value)
                            .unwrap_or_else(|| "Unknown".to_string())
                    }
                    _ => "Unknown".to_string(),
                };

                ConfigOptionSummary {
                    id: option.id,
                    name: option.name,
                    description: option.description,
                    current_value_name,
                }
            })
            .collect()
    }

    fn rebuild_selectors(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let options = self.config_options.config_options();
        self.apply_options_snapshot(options.clone());

        let has_deployed_picker = self
            .selectors
            .iter()
            .any(|selector| selector.read(cx).has_deployed_picker());

        if has_deployed_picker {
            self.selectors = Self::reconcile_selectors(
                &options,
                &self.selectors,
                &self.config_options,
                &self.agent_server,
                &self.fs,
                window,
                cx,
            );
        } else {
            self.selectors = Self::build_selectors(
                &options,
                &self.config_options,
                &self.agent_server,
                &self.fs,
                window,
                cx,
            );
        }

        cx.notify();
    }

    fn apply_options_snapshot(&mut self, options: Vec<acp::SessionConfigOption>) {
        self.config_option_ids = Self::config_option_ids(&options);
        self.option_summaries = Self::option_summaries_from_options(options);
    }

    fn build_selectors(
        options: &[acp::SessionConfigOption],
        config_options: &Rc<dyn AgentSessionConfigOptions>,
        agent_server: &Rc<dyn AgentServer>,
        fs: &Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Entity<ConfigOptionSelector>> {
        options
            .iter()
            .filter(|option| !is_skill_config_option_id(&option.id))
            .map(|option| {
                Self::build_selector(option, config_options, agent_server, fs, window, cx)
            })
            .collect()
    }

    fn reconcile_selectors(
        options: &[acp::SessionConfigOption],
        existing_selectors: &[Entity<ConfigOptionSelector>],
        config_options: &Rc<dyn AgentSessionConfigOptions>,
        agent_server: &Rc<dyn AgentServer>,
        fs: &Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Entity<ConfigOptionSelector>> {
        options
            .iter()
            .filter(|option| !is_skill_config_option_id(&option.id))
            .map(|option| {
                let existing_selector = existing_selectors
                    .iter()
                    .find(|selector| selector.read(cx).config_id() == &option.id)
                    .cloned();

                if let Some(selector) = existing_selector {
                    selector.update(cx, |selector, cx| {
                        selector.refresh_picker(window, cx);
                    });
                    selector
                } else {
                    Self::build_selector(option, config_options, agent_server, fs, window, cx)
                }
            })
            .collect()
    }

    fn build_selector(
        option: &acp::SessionConfigOption,
        config_options: &Rc<dyn AgentSessionConfigOptions>,
        agent_server: &Rc<dyn AgentServer>,
        fs: &Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ConfigOptionSelector> {
        let config_options = config_options.clone();
        let agent_server = agent_server.clone();
        let fs = fs.clone();
        let option_count = count_config_options(option);
        cx.new(|cx| {
            ConfigOptionSelector::new(
                config_options,
                option.id.clone(),
                option_count,
                agent_server,
                fs,
                window,
                cx,
            )
        })
    }
}

#[derive(IntoElement)]
pub(crate) struct ConfigOptionPickerTrigger {
    selector: Entity<ConfigOptionSelector>,
}

impl RenderOnce for ConfigOptionPickerTrigger {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        self.selector
    }
}

#[derive(IntoElement)]
pub(crate) struct ConfigOptionCategoryPickerTrigger {
    selector: Entity<ConfigOptionSelector>,
}

impl RenderOnce for ConfigOptionCategoryPickerTrigger {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        self.selector.update(cx, |selector, cx| {
            if selector.current_option().is_none() {
                return ButtonLike::new("backboard-footer-model-selector")
                    .stop_mouse_down_propagation()
                    .width(px(156.))
                    .height(px(26.).into())
                    .style(ButtonStyle::Subtle)
                    .child(
                        Label::new("Select model")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .truncate(),
                    )
                    .disabled(true)
                    .into_any_element();
            }

            let value_name = selector.current_value_name();
            let provider_label = selector.current_value_description();
            let tooltip_label = format!("Change model: {value_name}");
            let is_deployed = selector.picker_handle.is_deployed();

            let trigger = ButtonLike::new("backboard-footer-model-selector")
                .stop_mouse_down_propagation()
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
                                    .color(if is_deployed {
                                        Color::Accent
                                    } else {
                                        Color::Muted
                                    })
                                    .flex_none(),
                            )
                        })
                        .child(
                            Label::new(value_name)
                                .size(LabelSize::XSmall)
                                .color(Color::Default)
                                .truncate()
                                .flex_1(),
                        )
                        .child(
                            Icon::new(if is_deployed {
                                IconName::ChevronUp
                            } else {
                                IconName::ChevronDown
                            })
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                        ),
                );

            let tooltip = Tooltip::text(tooltip_label);
            PickerPopoverMenu::new(
                selector.picker.clone(),
                trigger,
                tooltip,
                gpui::Anchor::BottomRight,
                cx,
            )
            .id(format!(
                "config-option-footer-picker-{}",
                selector.config_id.0
            ))
            .with_handle(selector.picker_handle.clone())
            .render(window, cx)
            .into_any_element()
        })
    }
}

fn is_skill_config_option_id(config_id: &acp::SessionConfigId) -> bool {
    config_id.to_string().starts_with("backboard_skill:")
}

impl Render for ConfigOptionsView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        if self.selectors.is_empty() {
            return div().into_any_element();
        }

        v_flex()
            .w_full()
            .gap_0()
            .children(
                self.selectors
                    .iter()
                    .cloned()
                    .map(|selector| div().w_full().min_w_0().child(selector)),
            )
            .into_any_element()
    }
}

#[derive(Clone)]
pub(crate) struct ConfigOptionSummary {
    pub id: acp::SessionConfigId,
    pub name: String,
    pub description: Option<String>,
    pub current_value_name: String,
}

#[derive(Clone)]
pub(crate) struct ConfigOptionValueSummary {
    pub value: acp::SessionConfigValueId,
    pub name: String,
    pub description: Option<String>,
    pub is_current: bool,
}

struct ConfigOptionSelector {
    config_options: Rc<dyn AgentSessionConfigOptions>,
    config_id: acp::SessionConfigId,
    picker_handle: PopoverMenuHandle<Picker<ConfigOptionPickerDelegate>>,
    picker: Entity<Picker<ConfigOptionPickerDelegate>>,
    setting_value: bool,
}

impl ConfigOptionSelector {
    pub fn new(
        config_options: Rc<dyn AgentSessionConfigOptions>,
        config_id: acp::SessionConfigId,
        option_count: usize,
        agent_server: Rc<dyn AgentServer>,
        fs: Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let is_searchable = option_count >= PICKER_THRESHOLD;

        let picker = {
            let config_options = config_options.clone();
            let config_id = config_id.clone();
            let agent_server = agent_server.clone();
            let fs = fs.clone();
            cx.new(move |picker_cx| {
                let delegate = ConfigOptionPickerDelegate::new(
                    config_options,
                    config_id,
                    agent_server,
                    fs,
                    window,
                    picker_cx,
                );

                if is_searchable {
                    Picker::list(delegate, window, picker_cx)
                } else {
                    Picker::nonsearchable_list(delegate, window, picker_cx)
                }
                .show_scrollbar(true)
                .width(rems(20.))
                .max_height(Some(rems(20.).into()))
            })
        };

        Self {
            config_options,
            config_id,
            picker_handle: PopoverMenuHandle::default(),
            picker,
            setting_value: false,
        }
    }

    fn current_option(&self) -> Option<acp::SessionConfigOption> {
        self.config_options
            .config_options()
            .into_iter()
            .find(|opt| opt.id == self.config_id)
    }

    fn config_id(&self) -> &acp::SessionConfigId {
        &self.config_id
    }

    fn toggle_picker(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker_handle.toggle(window, cx);
    }

    fn has_deployed_picker(&self) -> bool {
        self.picker_handle.is_deployed()
    }

    fn refresh_picker(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker.update(cx, |picker, cx| {
            picker.delegate.refresh_options(cx);
            picker.refresh(window, cx);
        });
    }

    fn current_value_name(&self) -> String {
        let Some(option) = self.current_option() else {
            return "Unknown".to_string();
        };

        match &option.kind {
            acp::SessionConfigKind::Select(select) => {
                find_option_name(&select.options, &select.current_value)
                    .unwrap_or_else(|| "Unknown".to_string())
            }
            _ => "Unknown".to_string(),
        }
    }

    fn current_value_description(&self) -> Option<SharedString> {
        let current_value = get_current_value(&self.config_options, &self.config_id)?;
        extract_options(&self.config_options, &self.config_id)
            .into_iter()
            .find(|option| option.value == current_value)
            .and_then(|option| option.description)
            .filter(|description| !description.is_empty())
            .map(SharedString::from)
    }

    fn render_trigger_button(&self, _window: &mut Window, _cx: &mut Context<Self>) -> ButtonLike {
        let Some(option) = self.current_option() else {
            return ButtonLike::new("config-option-trigger")
                .stop_mouse_down_propagation()
                .full_width()
                .height(px(30.).into())
                .child(
                    Label::new("Unknown")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                )
                .disabled(true);
        };

        let is_deployed = self.picker_handle.is_deployed();
        let icon = if self.picker_handle.is_deployed() {
            IconName::ChevronUp
        } else {
            IconName::ChevronDown
        };
        let option_name = option.name.clone();
        let value_name = self.current_value_name();

        ButtonLike::new(ElementId::Name(
            format!("config-option-{}", option.id.0).into(),
        ))
        .stop_mouse_down_propagation()
        .full_width()
        .height(px(32.).into())
        .style(ButtonStyle::Subtle)
        .selected_style(ButtonStyle::Tinted(TintColor::Accent))
        .toggle_state(is_deployed)
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div().min_w_0().flex_1().child(
                        Label::new(option_name)
                            .size(LabelSize::Small)
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
                            Label::new(value_name)
                                .size(LabelSize::XSmall)
                                .color(if is_deployed {
                                    Color::Accent
                                } else {
                                    Color::Muted
                                })
                                .truncate(),
                        )
                        .child(
                            Icon::new(icon)
                                .size(IconSize::XSmall)
                                .color(if is_deployed {
                                    Color::Accent
                                } else {
                                    Color::Muted
                                }),
                        ),
                ),
        )
        .disabled(self.setting_value)
    }
}

impl Render for ConfigOptionSelector {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(option) = self.current_option() else {
            return div().into_any_element();
        };

        let trigger_button = self.render_trigger_button(window, cx);

        let option_name = option.name.clone();
        let option_description: Option<SharedString> = option.description.map(Into::into);

        let tooltip = Tooltip::element(move |_window, _cx| {
            let mut content = v_flex().gap_1().child(Label::new(option_name.clone()));
            if let Some(desc) = option_description.as_ref() {
                content = content.child(
                    Label::new(desc.clone())
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                );
            }
            content.into_any()
        });

        div()
            .w_full()
            .min_w_0()
            .child(
                PickerPopoverMenu::new(
                    self.picker.clone(),
                    trigger_button,
                    tooltip,
                    gpui::Anchor::BottomRight,
                    cx,
                )
                .id(format!("config-option-picker-popover-{}", self.config_id.0))
                .with_handle(self.picker_handle.clone())
                .render(window, cx),
            )
            .into_any_element()
    }
}

#[derive(Clone)]
enum ConfigOptionPickerEntry {
    Separator(SharedString),
    Option(ConfigOptionValue),
}

#[derive(Clone)]
struct ConfigOptionValue {
    value: acp::SessionConfigValueId,
    name: String,
    description: Option<String>,
    group: Option<String>,
}

struct ConfigOptionPickerDelegate {
    config_options: Rc<dyn AgentSessionConfigOptions>,
    config_id: acp::SessionConfigId,
    agent_server: Rc<dyn AgentServer>,
    fs: Arc<dyn Fs>,
    filtered_entries: Vec<ConfigOptionPickerEntry>,
    all_options: Vec<ConfigOptionValue>,
    selected_index: usize,
    selected_description: Option<(usize, SharedString, bool)>,
    favorites: HashSet<acp::SessionConfigValueId>,
    _settings_subscription: Subscription,
}

impl ConfigOptionPickerDelegate {
    fn new(
        config_options: Rc<dyn AgentSessionConfigOptions>,
        config_id: acp::SessionConfigId,
        agent_server: Rc<dyn AgentServer>,
        fs: Arc<dyn Fs>,
        window: &mut Window,
        cx: &mut Context<Picker<Self>>,
    ) -> Self {
        let favorites = agent_server.favorite_config_option_value_ids(&config_id, cx);

        let all_options = extract_options(&config_options, &config_id);
        let filtered_entries = options_to_picker_entries(&all_options, &favorites);

        let current_value = get_current_value(&config_options, &config_id);
        let selected_index = current_value
            .and_then(|current| {
                filtered_entries.iter().position(|entry| {
                    matches!(entry, ConfigOptionPickerEntry::Option(opt) if opt.value == current)
                })
            })
            .unwrap_or(0);

        let agent_server_for_subscription = agent_server.clone();
        let config_id_for_subscription = config_id.clone();
        let settings_subscription =
            cx.observe_global_in::<SettingsStore>(window, move |picker, window, cx| {
                let new_favorites = agent_server_for_subscription
                    .favorite_config_option_value_ids(&config_id_for_subscription, cx);
                if new_favorites != picker.delegate.favorites {
                    picker.delegate.favorites = new_favorites;
                    picker.refresh(window, cx);
                }
            });

        cx.notify();

        Self {
            config_options,
            config_id,
            agent_server,
            fs,
            filtered_entries,
            all_options,
            selected_index,
            selected_description: None,
            favorites,
            _settings_subscription: settings_subscription,
        }
    }

    fn current_value(&self) -> Option<acp::SessionConfigValueId> {
        get_current_value(&self.config_options, &self.config_id)
    }

    fn refresh_options(&mut self, cx: &mut App) {
        self.favorites = self
            .agent_server
            .favorite_config_option_value_ids(&self.config_id, cx);
        self.all_options = extract_options(&self.config_options, &self.config_id);
        self.filtered_entries = options_to_picker_entries(&self.all_options, &self.favorites);
        self.selected_description = None;

        let current_value = self.current_value();
        self.selected_index = current_value
            .and_then(|current| {
                self.filtered_entries.iter().position(|entry| {
                    matches!(entry, ConfigOptionPickerEntry::Option(opt) if opt.value == current)
                })
            })
            .unwrap_or(0);
    }
}

impl PickerDelegate for ConfigOptionPickerDelegate {
    type ListItem = AnyElement;

    fn match_count(&self) -> usize {
        self.filtered_entries.len()
    }

    fn selected_index(&self) -> usize {
        self.selected_index
    }

    fn set_selected_index(&mut self, ix: usize, _: &mut Window, cx: &mut Context<Picker<Self>>) {
        self.selected_index = ix.min(self.filtered_entries.len().saturating_sub(1));
        cx.notify();
    }

    fn can_select(&self, ix: usize, _window: &mut Window, _cx: &mut Context<Picker<Self>>) -> bool {
        match self.filtered_entries.get(ix) {
            Some(ConfigOptionPickerEntry::Option(_)) => true,
            Some(ConfigOptionPickerEntry::Separator(_)) | None => false,
        }
    }

    fn placeholder_text(&self, _window: &mut Window, _cx: &mut App) -> Arc<str> {
        "Select an option…".into()
    }

    fn update_matches(
        &mut self,
        query: String,
        window: &mut Window,
        cx: &mut Context<Picker<Self>>,
    ) -> Task<()> {
        let all_options = self.all_options.clone();

        cx.spawn_in(window, async move |this, cx| {
            let filtered_options = match this
                .read_with(cx, |_, cx| {
                    if query.is_empty() {
                        None
                    } else {
                        Some((all_options.clone(), query.clone(), cx.background_executor().clone()))
                    }
                })
                .ok()
                .flatten()
            {
                Some((options, q, executor)) => fuzzy_search_options(options, &q, executor).await,
                None => all_options,
            };

            this.update_in(cx, |this, window, cx| {
                this.delegate.filtered_entries =
                    options_to_picker_entries(&filtered_options, &this.delegate.favorites);

                let current_value = this.delegate.current_value();
                let new_index = current_value
                    .and_then(|current| {
                        this.delegate.filtered_entries.iter().position(|entry| {
                            matches!(entry, ConfigOptionPickerEntry::Option(opt) if opt.value == current)
                        })
                    })
                    .unwrap_or(0);

                this.set_selected_index(new_index, Some(picker::Direction::Down), true, window, cx);
                cx.notify();
            })
            .ok();
        })
    }

    fn confirm(&mut self, _secondary: bool, window: &mut Window, cx: &mut Context<Picker<Self>>) {
        if let Some(ConfigOptionPickerEntry::Option(option)) =
            self.filtered_entries.get(self.selected_index)
        {
            if window.modifiers().secondary() {
                let default_value = self
                    .agent_server
                    .default_config_option(self.config_id.0.as_ref(), cx);
                let is_default = default_value.as_deref() == Some(&*option.value.0);

                self.agent_server.set_default_config_option(
                    self.config_id.0.as_ref(),
                    if is_default {
                        None
                    } else {
                        Some(option.value.0.as_ref())
                    },
                    self.fs.clone(),
                    cx,
                );
            }

            let task = self.config_options.set_config_option(
                self.config_id.clone(),
                option.value.clone(),
                cx,
            );

            cx.spawn(async move |_, _| {
                if let Err(err) = task.await {
                    log::error!("Failed to set config option: {:?}", err);
                }
            })
            .detach();

            cx.emit(DismissEvent);
        }
    }

    fn dismissed(&mut self, window: &mut Window, cx: &mut Context<Picker<Self>>) {
        cx.defer_in(window, |picker, window, cx| {
            picker.set_query("", window, cx);
        });
    }

    fn render_match(
        &self,
        ix: usize,
        selected: bool,
        _: &mut Window,
        cx: &mut Context<Picker<Self>>,
    ) -> Option<Self::ListItem> {
        match self.filtered_entries.get(ix)? {
            ConfigOptionPickerEntry::Separator(title) => Some(
                div()
                    .when(ix > 0, |this| this.mt_1())
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .text_color(cx.theme().colors().text_muted)
                            .child(title.clone()),
                    )
                    .into_any_element(),
            ),
            ConfigOptionPickerEntry::Option(option) => {
                let current_value = self.current_value();
                let is_selected = current_value.as_ref() == Some(&option.value);

                let default_value = self
                    .agent_server
                    .default_config_option(self.config_id.0.as_ref(), cx);
                let is_default = default_value.as_deref() == Some(&*option.value.0);

                let is_favorite = self.favorites.contains(&option.value);

                let option_name = option.name.clone();
                let description = option.description.clone();

                Some(
                    div()
                        .id(("config-option-picker-item", ix))
                        .when_some(description, |this, desc| {
                            let desc: SharedString = desc.into();
                            this.on_hover(cx.listener(move |menu, hovered, _, cx| {
                                if *hovered {
                                    menu.delegate.selected_description =
                                        Some((ix, desc.clone(), is_default));
                                } else if matches!(menu.delegate.selected_description, Some((id, _, _)) if id == ix)
                                {
                                    menu.delegate.selected_description = None;
                                }
                                cx.notify();
                            }))
                        })
                        .child(
                            ListItem::new(ix)
                                .inset(true)
                                .spacing(ListItemSpacing::Sparse)
                                .toggle_state(selected)
                                .child(h_flex().w_full().child(Label::new(option_name).truncate()))
                                .end_slot(div().pr_2().when(is_selected, |this| {
                                    this.child(Icon::new(IconName::Check).color(Color::Accent))
                                }))
                                .end_slot_on_hover(div().pr_1p5().child({
                                    let (icon, color, tooltip) = if is_favorite {
                                        (IconName::StarFilled, Color::Accent, "Unfavorite")
                                    } else {
                                        (IconName::Star, Color::Default, "Favorite")
                                    };

                                    let config_id = self.config_id.clone();
                                    let value_id = option.value.clone();
                                    let agent_server = self.agent_server.clone();
                                    let fs = self.fs.clone();

                                    IconButton::new(("toggle-favorite-config-option", ix), icon)
                                        .layer(ElevationIndex::ElevatedSurface)
                                        .icon_color(color)
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text(tooltip))
                                        .on_click(move |_, _, cx| {
                                            agent_server.toggle_favorite_config_option_value(
                                                config_id.clone(),
                                                value_id.clone(),
                                                !is_favorite,
                                                fs.clone(),
                                                cx,
                                            );
                                        })
                                })),
                        )
                        .into_any_element(),
                )
            }
        }
    }

    fn documentation_aside(
        &self,
        _window: &mut Window,
        cx: &mut Context<Picker<Self>>,
    ) -> Option<ui::DocumentationAside> {
        self.selected_description
            .as_ref()
            .map(|(_, description, is_default)| {
                let description = description.clone();
                let is_default = *is_default;

                let side = documentation_aside_side(cx);

                ui::DocumentationAside::new(
                    side,
                    Rc::new(move |_| {
                        v_flex()
                            .gap_1()
                            .child(Label::new(description.clone()))
                            .child(HoldForDefault::new(is_default))
                            .into_any_element()
                    }),
                )
            })
    }

    fn documentation_aside_index(&self) -> Option<usize> {
        self.selected_description.as_ref().map(|(ix, _, _)| *ix)
    }
}

fn extract_options(
    config_options: &Rc<dyn AgentSessionConfigOptions>,
    config_id: &acp::SessionConfigId,
) -> Vec<ConfigOptionValue> {
    let Some(option) = config_options
        .config_options()
        .into_iter()
        .find(|opt| &opt.id == config_id)
    else {
        return Vec::new();
    };

    match &option.kind {
        acp::SessionConfigKind::Select(select) => match &select.options {
            acp::SessionConfigSelectOptions::Ungrouped(options) => options
                .iter()
                .map(|opt| ConfigOptionValue {
                    value: opt.value.clone(),
                    name: opt.name.clone(),
                    description: opt.description.clone(),
                    group: None,
                })
                .collect(),
            acp::SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| {
                    group.options.iter().map(|opt| ConfigOptionValue {
                        value: opt.value.clone(),
                        name: opt.name.clone(),
                        description: opt.description.clone(),
                        group: Some(group.name.clone()),
                    })
                })
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn get_current_value(
    config_options: &Rc<dyn AgentSessionConfigOptions>,
    config_id: &acp::SessionConfigId,
) -> Option<acp::SessionConfigValueId> {
    config_options
        .config_options()
        .into_iter()
        .find(|opt| &opt.id == config_id)
        .and_then(|opt| match &opt.kind {
            acp::SessionConfigKind::Select(select) => Some(select.current_value.clone()),
            _ => None,
        })
}

fn options_to_picker_entries(
    options: &[ConfigOptionValue],
    favorites: &HashSet<acp::SessionConfigValueId>,
) -> Vec<ConfigOptionPickerEntry> {
    let mut entries = Vec::new();

    let mut favorite_options = Vec::new();

    for option in options {
        if favorites.contains(&option.value) {
            favorite_options.push(option.clone());
        }
    }

    if !favorite_options.is_empty() {
        entries.push(ConfigOptionPickerEntry::Separator("Favorites".into()));
        for option in favorite_options {
            entries.push(ConfigOptionPickerEntry::Option(option));
        }

        // If the remaining list would start ungrouped (group == None), insert a separator so
        // Favorites doesn't visually run into the main list.
        if let Some(option) = options.first()
            && option.group.is_none()
        {
            entries.push(ConfigOptionPickerEntry::Separator("All Options".into()));
        }
    }

    let mut current_group: Option<String> = None;
    for option in options {
        if option.group != current_group {
            if let Some(group_name) = &option.group {
                entries.push(ConfigOptionPickerEntry::Separator(
                    group_name.clone().into(),
                ));
            }
            current_group = option.group.clone();
        }
        entries.push(ConfigOptionPickerEntry::Option(option.clone()));
    }

    entries
}

async fn fuzzy_search_options(
    options: Vec<ConfigOptionValue>,
    query: &str,
    executor: BackgroundExecutor,
) -> Vec<ConfigOptionValue> {
    let candidates = options
        .iter()
        .enumerate()
        .map(|(ix, opt)| StringMatchCandidate::new(ix, &opt.name))
        .collect::<Vec<_>>();

    let mut matches = fuzzy::match_strings(
        &candidates,
        query,
        false,
        true,
        100,
        &Default::default(),
        executor,
    )
    .await;

    matches.sort_unstable_by_key(|mat| {
        let candidate = &candidates[mat.candidate_id];
        (Reverse(OrderedFloat(mat.score)), candidate.id)
    });

    matches
        .into_iter()
        .map(|mat| options[mat.candidate_id].clone())
        .collect()
}

fn find_option_name(
    options: &acp::SessionConfigSelectOptions,
    value_id: &acp::SessionConfigValueId,
) -> Option<String> {
    match options {
        acp::SessionConfigSelectOptions::Ungrouped(opts) => opts
            .iter()
            .find(|o| &o.value == value_id)
            .map(|o| o.name.clone()),
        acp::SessionConfigSelectOptions::Grouped(groups) => groups.iter().find_map(|group| {
            group
                .options
                .iter()
                .find(|o| &o.value == value_id)
                .map(|o| o.name.clone())
        }),
        _ => None,
    }
}

fn count_config_options(option: &acp::SessionConfigOption) -> usize {
    match &option.kind {
        acp::SessionConfigKind::Select(select) => match &select.options {
            acp::SessionConfigSelectOptions::Ungrouped(options) => options.len(),
            acp::SessionConfigSelectOptions::Grouped(groups) => {
                groups.iter().map(|g| g.options.len()).sum()
            }
            _ => 0,
        },
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use std::{any::Any, cell::RefCell};

    use acp_thread::AgentConnection;
    use agent_servers::{AgentServer, AgentServerDelegate};
    use anyhow::Result;
    use fs::FakeFs;
    use gpui::{TestAppContext, VisualTestContext};
    use project::{AgentId, Project};
    use settings::SettingsStore;

    use super::*;

    struct TestConfigOptions {
        options: Rc<RefCell<Vec<acp::SessionConfigOption>>>,
    }

    impl AgentSessionConfigOptions for TestConfigOptions {
        fn config_options(&self) -> Vec<acp::SessionConfigOption> {
            self.options.borrow().clone()
        }

        fn set_config_option(
            &self,
            config_id: acp::SessionConfigId,
            value: acp::SessionConfigValueId,
            _cx: &mut App,
        ) -> Task<Result<Vec<acp::SessionConfigOption>>> {
            for option in self.options.borrow_mut().iter_mut() {
                if option.id == config_id
                    && let acp::SessionConfigKind::Select(select) = &mut option.kind
                {
                    select.current_value = value.clone();
                }
            }

            Task::ready(Ok(self.config_options()))
        }
    }

    struct TestAgentServer;

    impl AgentServer for TestAgentServer {
        fn logo(&self) -> IconName {
            IconName::BackboardAssistant
        }

        fn agent_id(&self) -> AgentId {
            AgentId::new("test-agent")
        }

        fn connect(
            &self,
            _delegate: AgentServerDelegate,
            _project: Entity<Project>,
            _cx: &mut App,
        ) -> Task<Result<Rc<dyn AgentConnection>>> {
            Task::ready(Err(anyhow::anyhow!("unused test server")))
        }

        fn into_any(self: Rc<Self>) -> Rc<dyn Any> {
            self
        }
    }

    fn model_config_options(
        current_value: &str,
        values: &[(&str, &str)],
    ) -> Vec<acp::SessionConfigOption> {
        vec![
            acp::SessionConfigOption::select(
                "test_model",
                "Model",
                current_value.to_string(),
                values
                    .iter()
                    .map(|(value, name)| {
                        acp::SessionConfigSelectOption::new(value.to_string(), name.to_string())
                    })
                    .collect::<Vec<_>>(),
            )
            .category(acp::SessionConfigOptionCategory::Model),
        ]
    }

    fn init_test(cx: &mut TestAppContext) {
        cx.update(|cx| {
            let settings_store = SettingsStore::test(cx);
            cx.set_global(settings_store);
            theme_settings::init(theme::LoadThemes::JustBase, cx);
            editor::init(cx);
        });
    }

    #[gpui::test]
    fn refresh_preserves_deployed_config_option_picker(cx: &mut TestAppContext) {
        init_test(cx);

        let options = Rc::new(RefCell::new(model_config_options(
            "gpt-5",
            &[("gpt-5", "GPT-5"), ("gpt-5-mini", "GPT-5 mini")],
        )));
        let config_options: Rc<dyn AgentSessionConfigOptions> = Rc::new(TestConfigOptions {
            options: options.clone(),
        });
        let agent_server = Rc::new(TestAgentServer);
        let fs = FakeFs::new(cx.executor());

        let window = cx.add_window({
            let config_options = config_options.clone();
            let agent_server = agent_server.clone();
            let fs = fs.clone();
            move |window, cx| ConfigOptionsView::new(config_options, agent_server, fs, window, cx)
        });
        let view = window
            .entity(cx)
            .expect("config options view should be the window root entity");
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        view.update_in(&mut cx, |view, window, cx| {
            assert!(view.toggle_category_picker(
                acp::SessionConfigOptionCategory::Model,
                window,
                cx,
            ));
        });
        cx.run_until_parked();

        let selector_id_before = view.read_with(&cx, |view, cx| {
            let selector = view.selectors.first().expect("model selector should exist");
            assert!(selector.read(cx).has_deployed_picker());
            selector.entity_id()
        });

        *options.borrow_mut() = model_config_options(
            "claude-sonnet",
            &[
                ("gpt-5", "GPT-5"),
                ("claude-sonnet", "Claude Sonnet"),
                ("gemini-flash", "Gemini Flash"),
            ],
        );

        view.update_in(&mut cx, |view, window, cx| {
            view.refresh_options(window, cx);
        });
        cx.run_until_parked();

        view.read_with(&cx, |view, cx| {
            let selector = view
                .selectors
                .first()
                .expect("model selector should remain");
            assert_eq!(selector.entity_id(), selector_id_before);
            assert!(selector.read(cx).has_deployed_picker());

            let option_names = selector
                .read(cx)
                .picker
                .read(cx)
                .delegate
                .all_options
                .iter()
                .map(|option| option.name.as_str())
                .collect::<Vec<_>>();
            assert_eq!(option_names, vec!["GPT-5", "Claude Sonnet", "Gemini Flash"]);
        });
    }
}
