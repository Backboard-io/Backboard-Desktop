use gpui::{App, Hsla, IntoElement, px};
use theme::ActiveTheme;
use ui::{Color, Icon, IconName, IconSize, prelude::*};

pub const BUTTON_HEIGHT: f32 = 24.;
pub const INPUT_HEIGHT: f32 = 28.;
pub const SEGMENTED_HEIGHT: f32 = 23.;
pub const ICON_BUTTON_SIZE: f32 = 24.;
pub const UTILITY_ICON_SIZE: f32 = 16.;
pub const TOP_BAR_HEIGHT: f32 = 44.;
pub const SIDEBAR_WIDTH: f32 = 260.;
pub const RIGHT_PANEL_WIDTH: f32 = 880.;
pub const PREVIEW_DOMINANT_CHAT_WIDTH: f32 = 480.;
pub const CHAT_ROW_HEIGHT: f32 = 36.;
pub const PROJECT_ROW_HEIGHT: f32 = 40.;
pub const CHAT_COMPOSER_MAX_WIDTH: f32 = 920.;
pub const CHAT_MAX_WIDTH: f32 = 448.;
pub const HOME_CONTENT_WIDTH: f32 = 720.;

pub fn app_background(cx: &App) -> Hsla {
    cx.theme().colors().editor_background
}

pub fn panel_background(cx: &App) -> Hsla {
    cx.theme().colors().panel_background
}

pub fn card_background(cx: &App) -> Hsla {
    cx.theme().colors().element_background
}

pub fn field_background(cx: &App) -> Hsla {
    cx.theme().colors().surface_background
}

pub fn selected_background(cx: &App) -> Hsla {
    cx.theme().colors().element_selected
}

pub fn hover_background(cx: &App) -> Hsla {
    cx.theme().colors().element_hover
}

pub fn soft_border(cx: &App) -> Hsla {
    cx.theme().colors().border_variant
}

pub fn accent(cx: &App) -> Hsla {
    cx.theme().colors().text_accent
}

pub fn focus_border(cx: &App) -> Hsla {
    cx.theme().colors().border_focused
}

pub fn separator(cx: &App) -> Hsla {
    cx.theme().colors().border_variant.opacity(0.22)
}

pub fn render_project_mark(size: f32, cx: &App) -> impl IntoElement {
    div()
        .size(px(size))
        .rounded_full()
        .bg(accent(cx).opacity(0.12))
        .flex()
        .items_center()
        .justify_center()
        .child(
            Icon::new(IconName::Sparkle)
                .size(IconSize::Indicator)
                .color(Color::Custom(cx.theme().colors().icon_accent)),
        )
}
