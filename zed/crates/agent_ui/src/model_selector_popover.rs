use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use acp_thread::{AgentModelIcon, AgentModelInfo, AgentModelSelector};
use fs::Fs;
use gpui::{Entity, FocusHandle, ObjectFit, img};
use picker::popover_menu::PickerPopoverMenu;
use ui::{ButtonLike, PopoverMenuHandle, Tooltip, prelude::*};

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
        let has_model_icon = model_icon.is_some();

        let trigger = ButtonLike::new("active-model")
            .width(px(28.))
            .height(px(28.).into())
            .child(
                h_flex()
                    .justify_center()
                    .items_center()
                    .when_some(trigger_logo, |this, path| {
                        this.child(
                            img(path)
                                .h(px(14.))
                                .w_auto()
                                .flex_none()
                                .object_fit(ObjectFit::ScaleDown),
                        )
                    })
                    .when(trigger_label.is_none(), |this| {
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
                    .when(trigger_label.is_none() && !has_model_icon, |this| {
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
            gpui::Anchor::BottomRight,
            cx,
        )
        .with_handle(self.menu_handle.clone())
        .render(window, cx)
    }
}
