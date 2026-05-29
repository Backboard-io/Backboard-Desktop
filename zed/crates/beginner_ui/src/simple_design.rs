use gpui::{App, BoxShadow, Hsla, IntoElement, px};
use theme::ActiveTheme;
use ui::{Color, ElevationIndex, Icon, IconName, IconSize, prelude::*};

pub const FONT_FAMILY: &str = "Inter";

pub const BUTTON_HEIGHT: f32 = 24.;
pub const INPUT_HEIGHT: f32 = 28.;
pub const SEGMENTED_HEIGHT: f32 = 23.;
pub const ICON_BUTTON_SIZE: f32 = 24.;
pub const UTILITY_ICON_SIZE: f32 = 16.;
pub const TAB_BAR_HEIGHT: f32 = 32.;
pub const TOP_BAR_HEIGHT: f32 = 40.;
pub const SIDEBAR_WIDTH: f32 = 260.;
pub const RIGHT_PANEL_WIDTH: f32 = 360.;
pub const PREVIEW_DOMINANT_CHAT_WIDTH: f32 = 480.;
pub const PROJECT_ROW_HEIGHT: f32 = 40.;
pub const CHAT_MAX_WIDTH: f32 = 680.;

pub fn app_background(cx: &App) -> Hsla {
    cx.theme().colors().editor_background
}

pub fn panel_background(cx: &App) -> Hsla {
    cx.theme().colors().panel_background
}

pub fn card_background(cx: &App) -> Hsla {
    cx.theme()
        .colors()
        .surface_background
        .blend(cx.theme().colors().element_background.opacity(0.38))
}

pub fn field_background(cx: &App) -> Hsla {
    cx.theme().colors().surface_background
}

pub fn subtle_card_background(cx: &App) -> Hsla {
    let colors = cx.theme().colors();
    colors
        .surface_background
        .blend(colors.element_background.opacity(0.24))
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
    cx.theme().colors().border_variant.opacity(0.38)
}

pub fn card_shadow(cx: &App) -> Vec<BoxShadow> {
    ElevationIndex::ElevatedSurface.shadow(cx)
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
