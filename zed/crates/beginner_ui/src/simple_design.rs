use gpui::{App, Background, Hsla, IntoElement, linear_color_stop, linear_gradient, px, white};
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

pub fn sidebar_background(cx: &App) -> Background {
    let colors = cx.theme().colors();
    let is_light = cx.theme().appearance().is_light();
    let base = colors
        .editor_background
        .blend(
            colors
                .title_bar_background
                .opacity(if is_light { 0.58 } else { 0.68 }),
        )
        .blend(
            colors
                .panel_background
                .opacity(if is_light { 0.18 } else { 0.22 }),
        )
        .alpha(1.0);
    let glow = base
        .blend(
            colors
                .text_accent
                .opacity(if is_light { 0.045 } else { 0.095 }),
        )
        .alpha(1.0);
    let depth = colors
        .title_bar_background
        .blend(base.opacity(if is_light { 0.72 } else { 0.62 }))
        .alpha(1.0);

    linear_gradient(
        104.,
        linear_color_stop(glow, 0.),
        linear_color_stop(depth, 1.),
    )
}

pub fn sidebar_glow_wash(cx: &App) -> Background {
    let colors = cx.theme().colors();
    let is_light = cx.theme().appearance().is_light();
    let glow = colors
        .text_accent
        .blend(
            colors
                .title_bar_background
                .opacity(if is_light { 0.46 } else { 0.28 }),
        )
        .opacity(if is_light { 0.11 } else { 0.2 });

    linear_gradient(
        142.,
        linear_color_stop(glow, 0.),
        linear_color_stop(glow.opacity(0.), 0.74),
    )
}

pub fn sidebar_edge_wash(cx: &App) -> Background {
    let colors = cx.theme().colors();
    let is_light = cx.theme().appearance().is_light();
    let edge = colors
        .panel_background
        .blend(
            colors
                .text_accent
                .opacity(if is_light { 0.18 } else { 0.32 }),
        )
        .opacity(if is_light { 0.08 } else { 0.14 });

    linear_gradient(
        90.,
        linear_color_stop(edge, 0.),
        linear_color_stop(edge.opacity(0.), 0.52),
    )
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
