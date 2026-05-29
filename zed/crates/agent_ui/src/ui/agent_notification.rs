use gpui::{
    App, Context, EventEmitter, FontWeight, IntoElement, PlatformDisplay, Size, Window,
    WindowBackgroundAppearance, WindowBounds, WindowDecorations, WindowKind, WindowOptions, point,
    svg,
};
use release_channel::ReleaseChannel;
use std::rc::Rc;
use ui::{IconButtonShape, Render, Tooltip, prelude::*};

const BACKBOARD_LOGO_PATH: &str = "images/backboard_logo.svg";

pub struct AgentNotification {
    title: SharedString,
    caption: Option<SharedString>,
    icon: IconName,
    project_name: Option<SharedString>,
}

impl AgentNotification {
    pub fn new(
        title: impl Into<SharedString>,
        caption: Option<SharedString>,
        icon: IconName,
        project_name: Option<impl Into<SharedString>>,
    ) -> Self {
        Self {
            title: title.into(),
            caption: caption,
            icon,
            project_name: project_name.map(|name| name.into()),
        }
    }

    pub fn window_options(screen: Rc<dyn PlatformDisplay>, cx: &App) -> WindowOptions {
        let size = Size {
            width: px(400.),
            height: px(72.),
        };

        let notification_margin_width = px(16.);
        let notification_margin_height = px(-48.);

        let bounds = gpui::Bounds::<Pixels> {
            origin: screen.bounds().top_right()
                - point(
                    size.width + notification_margin_width,
                    notification_margin_height,
                ),
            size,
        };

        let app_id = ReleaseChannel::global(cx).app_id();

        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            focus: false,
            show: true,
            kind: WindowKind::PopUp,
            is_movable: false,
            display_id: Some(screen.id()),
            window_background: WindowBackgroundAppearance::Transparent,
            app_id: Some(app_id.to_owned()),
            window_min_size: None,
            window_decorations: Some(WindowDecorations::Client),
            tabbing_identifier: None,
            ..Default::default()
        }
    }
}

pub enum AgentNotificationEvent {
    Accepted,
    Dismissed,
}

impl EventEmitter<AgentNotificationEvent> for AgentNotification {}

impl AgentNotification {
    pub fn accept(&mut self, cx: &mut Context<Self>) {
        cx.emit(AgentNotificationEvent::Accepted);
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        cx.emit(AgentNotificationEvent::Dismissed);
    }
}

impl Render for AgentNotification {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui_font = theme_settings::setup_ui_font(window, cx);
        let colors = cx.theme().colors();
        let metadata_separator = || {
            div()
                .size(px(3.))
                .rounded_full()
                .bg(colors.text_muted.opacity(0.6))
        };
        let has_caption = self.caption.is_some();
        let has_metadata = self.project_name.is_some() || self.caption.is_some();
        let notification_icon = if self.icon == IconName::ZedAssistant {
            svg()
                .path(BACKBOARD_LOGO_PATH)
                .h(px(30.))
                .w(px(22.))
                .flex_none()
                .into_any_element()
        } else {
            Icon::new(self.icon)
                .color(Color::Muted)
                .size(IconSize::Small)
                .into_any_element()
        };

        h_flex()
            .id("agent-notification")
            .size_full()
            .overflow_hidden()
            .occlude()
            .p_2()
            .gap_3()
            .justify_between()
            .elevation_2(cx)
            .text_ui(cx)
            .font(ui_font)
            .rounded_lg()
            .child(
                h_flex()
                    .min_w_0()
                    .flex_1()
                    .gap_3()
                    .items_center()
                    .child(notification_icon)
                    .child(
                        v_flex()
                            .min_w_0()
                            .flex_1()
                            .gap_0p5()
                            .child(
                                Label::new(self.title.clone())
                                    .size(LabelSize::Default)
                                    .weight(FontWeight::MEDIUM)
                                    .truncate(),
                            )
                            .when(has_metadata, |this| {
                                this.child(
                                    h_flex()
                                        .min_w_0()
                                        .gap_1p5()
                                        .items_center()
                                        .when_some(
                                            self.project_name.clone(),
                                            |description, project_name| {
                                                let project = div()
                                                    .min_w_0()
                                                    .max_w(if has_caption {
                                                        px(120.)
                                                    } else {
                                                        px(220.)
                                                    })
                                                    .truncate()
                                                    .child(
                                                        Label::new(project_name)
                                                            .size(LabelSize::Small)
                                                            .color(Color::Muted)
                                                            .truncate(),
                                                    );
                                                let mut row = h_flex().gap_1p5().child(project);
                                                if has_caption {
                                                    row = row.child(metadata_separator());
                                                }
                                                description.child(row)
                                            },
                                        )
                                        .when_some(self.caption.clone(), |description, caption| {
                                            description.child(
                                                div().min_w_0().flex_1().child(
                                                    Label::new(caption)
                                                        .size(LabelSize::Small)
                                                        .color(Color::Muted)
                                                        .truncate(),
                                                ),
                                            )
                                        }),
                                )
                            }),
                    ),
            )
            .child(
                h_flex()
                    .flex_none()
                    .gap_1()
                    .items_center()
                    .child(
                        Button::new("open", "View")
                            .style(ButtonStyle::Tinted(ui::TintColor::Accent))
                            .on_click({
                                cx.listener(move |this, _event, _, cx| {
                                    this.accept(cx);
                                })
                            }),
                    )
                    .child(
                        IconButton::new("dismiss", IconName::Close)
                            .shape(IconButtonShape::Square)
                            .icon_size(IconSize::XSmall)
                            .icon_color(Color::Muted)
                            .style(ButtonStyle::Transparent)
                            .tooltip(Tooltip::text("Dismiss"))
                            .on_click({
                                cx.listener(move |this, _event, _, cx| {
                                    this.dismiss(cx);
                                })
                            }),
                    ),
            )
    }
}
