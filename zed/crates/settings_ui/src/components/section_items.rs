use gpui::{FontWeight, IntoElement, ParentElement, Styled, px};
use ui::{Divider, DividerColor, prelude::*};

#[derive(IntoElement)]
pub struct SettingsSectionHeader {
    icon: Option<IconName>,
    brand_letter: Option<SharedString>,
    label: SharedString,
    no_padding: bool,
}

impl SettingsSectionHeader {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            icon: None,
            brand_letter: None,
            no_padding: false,
        }
    }

    #[allow(dead_code)]
    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn brand_letter(mut self, letter: impl Into<SharedString>) -> Self {
        self.brand_letter = Some(letter.into());
        self
    }

    pub fn no_padding(mut self, no_padding: bool) -> Self {
        self.no_padding = no_padding;
        self
    }
}

impl RenderOnce for SettingsSectionHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let label = Label::new(self.label)
            .size(LabelSize::Small)
            .color(Color::Muted)
            .buffer_font(cx);

        v_flex()
            .w_full()
            .when(!self.no_padding, |this| this.px_8())
            .gap_1p5()
            .map(|this| {
                if let Some(letter) = self.brand_letter {
                    this.child(
                        h_flex()
                            .gap_1p5()
                            .child(
                                div()
                                    .size(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(3.))
                                    .bg(cx.theme().colors().element_background)
                                    .child(
                                        Label::new(letter)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Default)
                                            .weight(FontWeight::BOLD),
                                    ),
                            )
                            .child(label),
                    )
                } else if let Some(icon) = self.icon {
                    this.child(
                        h_flex()
                            .gap_1p5()
                            .child(Icon::new(icon).color(Color::Muted))
                            .child(label),
                    )
                } else {
                    this.child(label)
                }
            })
            .child(Divider::horizontal().color(DividerColor::BorderFaded))
    }
}
