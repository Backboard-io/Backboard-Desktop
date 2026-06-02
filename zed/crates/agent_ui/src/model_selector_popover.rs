use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use acp_thread::{AgentModelIcon, AgentModelInfo, AgentModelSelector};
use fs::Fs;
use gpui::{Entity, FocusHandle, ObjectFit, img};
use picker::popover_menu::PickerPopoverMenu;
use ui::{ButtonLike, PopoverMenuHandle, TintColor, Tooltip, prelude::*};

use crate::ui::ModelSelectorTooltip;
use crate::{ModelSelector, model_selector::acp_model_selector};

pub struct ModelSelectorPopover {
    selector: Entity<ModelSelector>,
    menu_handle: PopoverMenuHandle<ModelSelector>,
    trigger_label: Option<SharedString>,
    trigger_logo: Option<PathBuf>,
}

impl ModelSelectorPopover {
    pub(crate) fn new(
        selector: Rc<dyn AgentModelSelector>,
        agent_server: Rc<dyn agent_servers::AgentServer>,
        fs: Arc<dyn Fs>,
        menu_handle: PopoverMenuHandle<ModelSelector>,
        focus_handle: FocusHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            selector: cx.new(move |cx| {
                acp_model_selector(selector, agent_server, fs, focus_handle.clone(), window, cx)
            }),
            menu_handle,
            trigger_label: None,
            trigger_logo: None,
        }
    }

    pub fn set_trigger_brand(&mut self, label: SharedString, logo_path: Option<PathBuf>) {
        self.trigger_label = Some(label);
        self.trigger_logo = logo_path;
    }

    pub fn clear_trigger_brand(&mut self) {
        self.trigger_label = None;
        self.trigger_logo = None;
    }

    pub fn toggle(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_handle.toggle(window, cx);
    }

    pub fn active_model<'a>(&self, cx: &'a App) -> Option<&'a AgentModelInfo> {
        self.selector.read(cx).delegate.active_model()
    }

    pub fn cycle_favorite_models(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.selector.update(cx, |selector, cx| {
            selector.delegate.cycle_favorite_models(window, cx);
        });
    }
}

impl Render for ModelSelectorPopover {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selector = self.selector.read(cx);
        let model = selector.delegate.active_model();
        let model_name = model
            .as_ref()
            .map(|model| model.name.clone())
            .unwrap_or_else(|| SharedString::from("Select a Model"));

        let model_icon = model.as_ref().and_then(|model| model.icon.clone());

        let color = if self.menu_handle.is_deployed() {
            Color::Accent
        } else {
            Color::Muted
        };

        let show_cycle_row = selector.delegate.favorites_count() > 1;
        let tooltip_model_name = model_name.clone();

        let tooltip = Tooltip::element({
            move |_, _cx| {
                v_flex()
                    .gap_1()
                    .child(Label::new(tooltip_model_name.clone()).size(LabelSize::Small))
                    .child(
                        ModelSelectorTooltip::new()
                            .show_cycle_row(show_cycle_row)
                            .into_any_element(),
                    )
                    .into_any_element()
            }
        });

        let trigger_label = self.trigger_label.clone();
        let trigger_logo = self.trigger_logo.clone();
        let branded_trigger = trigger_label.is_some() || trigger_logo.is_some();
        let has_trigger_logo = trigger_logo.is_some();
        let has_model_icon = model_icon.is_some();
        let trigger_model_name = if branded_trigger {
            model_name
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .map(SharedString::from)
                .unwrap_or_else(|| model_name.clone())
        } else {
            model_name.clone()
        };
        let trigger_provider_name = model
            .as_ref()
            .and_then(|model| model.description.clone())
            .filter(|provider| !provider.is_empty());

        let trigger = ButtonLike::new("active-model")
            .width(if branded_trigger { px(220.) } else { px(28.) })
            .height(if branded_trigger {
                px(22.).into()
            } else {
                px(28.).into()
            })
            .style(if branded_trigger {
                ButtonStyle::Transparent
            } else {
                ButtonStyle::Subtle
            })
            .when(branded_trigger, |this| {
                this.selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .toggle_state(self.menu_handle.is_deployed())
            })
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .justify_center()
                    .items_center()
                    .when_some(trigger_logo, |this, path| {
                        this.child(
                            img(path)
                                .h(px(12.))
                                .w_auto()
                                .flex_none()
                                .object_fit(ObjectFit::ScaleDown),
                        )
                    })
                    .when(!has_trigger_logo, |this| {
                        this.when_some(model_icon, |this, icon| {
                            this.child(
                                match icon {
                                    AgentModelIcon::Path(path) => Icon::from_external_svg(path),
                                    AgentModelIcon::Named(icon_name) => Icon::new(icon_name),
                                }
                                .color(color)
                                .size(IconSize::XSmall),
                            )
                        })
                    })
                    .when(branded_trigger, |this| {
                        this.child(
                            Icon::new(if self.menu_handle.is_deployed() {
                                IconName::ChevronUp
                            } else {
                                IconName::ChevronDown
                            })
                            .color(Color::Muted)
                            .size(IconSize::XSmall),
                        )
                        .child(
                            h_flex()
                                .min_w_0()
                                .flex_1()
                                .gap_0p5()
                                .items_center()
                                .when_some(
                                    trigger_label.clone().filter(|l| !l.is_empty()),
                                    |this, label| {
                                        this.child(
                                            Label::new(label)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Muted)
                                                .truncate(),
                                        )
                                        .child(
                                            Label::new("·")
                                                .size(LabelSize::XSmall)
                                                .color(Color::Muted)
                                                .alpha(0.6),
                                        )
                                    },
                                )
                                .when_some(trigger_provider_name.clone(), |this, provider| {
                                    this.child(
                                        Label::new(provider)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted)
                                            .truncate(),
                                    )
                                    .child(
                                        Label::new("/")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted)
                                            .alpha(0.6),
                                    )
                                })
                                .child(
                                    Label::new(trigger_model_name.clone())
                                        .size(LabelSize::XSmall)
                                        .color(if self.menu_handle.is_deployed() {
                                            Color::Accent
                                        } else {
                                            Color::Muted
                                        })
                                        .truncate(),
                                ),
                        )
                    })
                    .when(!branded_trigger && !has_model_icon, |this| {
                        this.child(
                            Icon::new(IconName::ChevronDown)
                                .color(color)
                                .size(IconSize::XSmall),
                        )
                    }),
            );

        PickerPopoverMenu::new(
            self.selector.clone(),
            trigger,
            tooltip,
            if branded_trigger {
                gpui::Anchor::BottomLeft
            } else {
                gpui::Anchor::BottomRight
            },
            cx,
        )
        .with_handle(self.menu_handle.clone())
        .render(window, cx)
    }
}
