use gpui::{App, Hsla, IntoElement, px, white};
use theme::ActiveTheme;
use ui::{Color, Icon, IconName, IconSize, prelude::*};

pub const UTILITY_ICON_SIZE: f32 = 16.;
pub const TOP_BAR_HEIGHT: f32 = 44.;
pub const SIDEBAR_WIDTH: f32 = 260.;
pub const SIDEBAR_MIN_WIDTH: f32 = 200.;
pub const CHAT_PANEL_WIDTH: f32 = 540.;
pub const CHAT_PANEL_MIN_WIDTH: f32 = 360.;
pub const RIGHT_PANEL_MIN_WIDTH: f32 = 320.;
pub const PANEL_RESIZE_HANDLE_WIDTH: f32 = 8.;
pub const CHAT_ROW_HEIGHT: f32 = 36.;
pub const PROJECT_ROW_HEIGHT: f32 = 40.;
pub const CHAT_MAX_WIDTH: f32 = 880.;

pub fn app_background(cx: &App) -> Hsla {
    cx.theme().colors().editor_background
}

pub fn sidebar_background(cx: &App) -> Hsla {
    let colors = cx.theme().colors();
    let opacity = if cx.theme().appearance().is_light() {
        0.78
    } else {
        0.66
    };
    colors
        .title_bar_background
        .blend(colors.panel_background.opacity(0.14))
        .opacity(opacity)
}

pub fn sidebar_hover_background(cx: &App) -> Hsla {
    let opacity = if cx.theme().appearance().is_light() {
        0.36
    } else {
        0.64
    };
    cx.theme().colors().element_hover.opacity(opacity)
}

pub fn sidebar_selected_background(cx: &App) -> Hsla {
    let opacity = if cx.theme().appearance().is_light() {
        0.52
    } else {
        0.78
    };
    cx.theme().colors().element_selected.opacity(opacity)
}

pub fn sidebar_text(cx: &App) -> Hsla {
    let opacity = if cx.theme().appearance().is_light() {
        0.88
    } else {
        0.94
    };
    cx.theme().colors().text.opacity(opacity)
}

pub fn sidebar_emphasis_text(_cx: &App) -> Hsla {
    white()
}

pub fn sidebar_text_muted(cx: &App) -> Hsla {
    let colors = cx.theme().colors();
    if cx.theme().appearance().is_light() {
        colors.text.opacity(0.58)
    } else {
        colors.text_muted.opacity(0.82)
    }
}

pub fn sidebar_text_subtle(cx: &App) -> Hsla {
    let colors = cx.theme().colors();
    if cx.theme().appearance().is_light() {
        colors.text.opacity(0.42)
    } else {
        colors.text_muted.opacity(0.58)
    }
}

pub fn sidebar_icon(cx: &App) -> Hsla {
    if cx.theme().appearance().is_light() {
        cx.theme().colors().text.opacity(0.52)
    } else {
        cx.theme().colors().icon_muted.opacity(0.86)
    }
}

pub fn sidebar_status_dot(cx: &App) -> Hsla {
    if cx.theme().appearance().is_light() {
        cx.theme().colors().text.opacity(0.48)
    } else {
        cx.theme().colors().icon_muted.opacity(0.82)
    }
}

pub fn card_background(cx: &App) -> Hsla {
    cx.theme().colors().surface_background
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
    cx.theme().colors().border_variant.opacity(0.56)
}

pub fn accent(cx: &App) -> Hsla {
    cx.theme().colors().text_accent
}

pub fn separator(cx: &App) -> Hsla {
    cx.theme().colors().border_variant.opacity(0.34)
}

pub fn panel_divider(cx: &App) -> Hsla {
    cx.theme().colors().border_variant.opacity(0.72)
}

pub fn strong_border(cx: &App) -> Hsla {
    cx.theme().colors().border_variant
}

pub fn text(cx: &App) -> Hsla {
    cx.theme().colors().text
}

pub fn text_muted(cx: &App) -> Hsla {
    cx.theme().colors().text_muted
}

pub fn text_disabled(cx: &App) -> Hsla {
    cx.theme().colors().text_disabled
}

pub fn mode_text(cx: &App) -> Hsla {
    cx.theme().colors().text
}

pub fn icon_muted(cx: &App) -> Hsla {
    cx.theme().colors().icon_muted
}

pub fn status_dot(cx: &App) -> Hsla {
    cx.theme().colors().icon_muted
}

pub fn warning(cx: &App) -> Hsla {
    cx.theme().status().warning_border
}

pub fn error(cx: &App) -> Hsla {
    cx.theme().status().error
}

pub fn error_background(cx: &App) -> Hsla {
    cx.theme().status().error.opacity(0.08)
}

pub fn chip_background(cx: &App) -> Hsla {
    cx.theme().colors().element_background
}

pub fn illustration_shadow(cx: &App) -> Hsla {
    cx.theme().colors().border_variant.opacity(0.48)
}

pub fn illustration_page(cx: &App) -> Hsla {
    cx.theme().colors().element_background
}

pub fn illustration_line_primary(cx: &App) -> Hsla {
    cx.theme().colors().text_muted
}

pub fn illustration_line_secondary(cx: &App) -> Hsla {
    cx.theme().colors().icon_muted
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
