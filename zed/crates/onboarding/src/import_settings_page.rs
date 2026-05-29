use gpui::{Action, App, IntoElement, ObjectFit, img};
use ui::{TintColor, prelude::*, rems_from_px};

use crate::{ImportCursorSettings, ImportVsCodeSettings, SettingsImportState};

fn render_setting_import_card(
    tab_index: isize,
    label: SharedString,
    description: SharedString,
    asset_path: &'static str,
    action: &dyn Action,
    imported: bool,
    cx: &App,
) -> impl IntoElement + 'static {
    let button_action = action.boxed_clone();
    let action_label = label.clone();
    let card_id = SharedString::from(format!("import-card-{label}"));
    let colors = cx.theme().colors();

    h_flex()
        .id(card_id)
        .w_full()
        .items_center()
        .justify_between()
        .gap_4()
        .rounded_md()
        .px_2()
        .py_3()
        .tab_index(tab_index)
        .hover(|style| style.bg(colors.element_hover.opacity(0.45)))
        .child(
            h_flex()
                .min_w_0()
                .items_center()
                .gap_3()
                .child(
                    div()
                        .size(rems_from_px(44.))
                        .rounded_md()
                        .bg(colors.element_background.opacity(0.55))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            img(asset_path)
                                .size(rems_from_px(26.))
                                .object_fit(ObjectFit::Contain)
                                .with_fallback(|| div().size(rems_from_px(26.)).into_any_element()),
                        ),
                )
                .child(
                    v_flex()
                        .min_w_0()
                        .gap_0p5()
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(Headline::new(label.clone()).size(HeadlineSize::Small))
                                .when(imported, |this| {
                                    this.child(
                                        Icon::new(IconName::Check)
                                            .size(IconSize::Small)
                                            .color(Color::Success),
                                    )
                                }),
                        )
                        .child(
                            Label::new(description)
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                ),
        )
        .child(
            Button::new(
                SharedString::from(format!("import-{label}")),
                if imported { "Imported" } else { "Import" },
            )
            .style(ButtonStyle::Subtle)
            .selected_style(ButtonStyle::Tinted(TintColor::Accent))
            .toggle_state(imported)
            .width(rems_from_px(104.))
            .when(imported, |this| {
                this.end_icon(Icon::new(IconName::Check).size(IconSize::Small))
                    .color(Color::Success)
            })
            .on_click(move |_, window, cx| {
                telemetry::event!("Welcome Import Settings", import_source = action_label,);
                window.dispatch_action(button_action.boxed_clone(), cx);
            }),
        )
}

pub(crate) fn render_import_settings_page(cx: &mut App) -> impl IntoElement {
    let import_state = SettingsImportState::global(cx);
    let imports: [(SharedString, SharedString, &'static str, &dyn Action, bool); 2] = [
        (
            "VS Code".into(),
            "Bring keybindings and settings.".into(),
            "onboarding/Visual_Studio_Code_1.35_icon.svg.png",
            &ImportVsCodeSettings { skip_prompt: false },
            import_state.vscode,
        ),
        (
            "Cursor".into(),
            "Bring your Cursor setup.".into(),
            "onboarding/cursor-logo-png_seeklogo-611587.png",
            &ImportCursorSettings { skip_prompt: false },
            import_state.cursor,
        ),
    ];

    let mut tab_index = 0;
    let [vscode, cursor] = imports.map(|(label, description, asset_path, action, imported)| {
        tab_index += 1;
        render_setting_import_card(
            tab_index - 1,
            label,
            description,
            asset_path,
            action,
            imported,
            cx,
        )
    });

    v_flex()
        .id("import-settings-page")
        .w_full()
        .py_10()
        .items_center()
        .gap_7()
        .child(
            v_flex()
                .items_center()
                .gap_2()
                .child(Headline::new("Bring your setup").size(HeadlineSize::Large))
                .child(
                    Label::new("One click. Skip it if you want a fresh start.")
                        .color(Color::Muted)
                        .size(LabelSize::Small),
                ),
        )
        .child(
            v_flex()
                .w(rems_from_px(680.))
                .gap_1()
                .child(vscode)
                .child(cursor),
        )
        .child(
            Button::new("skip-import-settings", "Skip for now")
                .style(ButtonStyle::Subtle)
                .on_click(|_, window, cx| {
                    window.dispatch_action(crate::Finish.boxed_clone(), cx);
                }),
        )
}
