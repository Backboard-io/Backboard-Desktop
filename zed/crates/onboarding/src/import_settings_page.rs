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
) -> impl IntoElement + 'static {
    let button_action = action.boxed_clone();
    let action_label = label.clone();

    v_flex()
        .id(label.clone())
        .w(rems_from_px(360.))
        .gap_4()
        .tab_index(tab_index)
        .child(
            v_flex()
                .gap_0p5()
                .child(Headline::new(label.clone()).size(HeadlineSize::Small))
                .child(
                    Label::new(description)
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                ),
        )
        .child(
            div()
                .w_full()
                .h(rems_from_px(180.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    img(asset_path)
                        .size(rems_from_px(120.))
                        .object_fit(ObjectFit::Contain)
                        .with_fallback(|| div().size(rems_from_px(120.)).into_any_element()),
                ),
        )
        .child(
            div().rounded_full().overflow_hidden().w_full().child(
                Button::new(
                    SharedString::from(format!("import-{label}")),
                    if imported {
                        "Imported"
                    } else {
                        "Import settings"
                    },
                )
                .style(ButtonStyle::OutlinedGhost)
                .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                .toggle_state(imported)
                .full_width()
                .when(imported, |this| {
                    this.end_icon(Icon::new(IconName::Check).size(IconSize::Small))
                        .color(Color::Success)
                })
                .on_click(move |_, window, cx| {
                    telemetry::event!("Welcome Import Settings", import_source = action_label,);
                    window.dispatch_action(button_action.boxed_clone(), cx);
                }),
            ),
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
        )
    });

    v_flex()
        .id("import-settings-page")
        .w_full()
        .py_12()
        .items_center()
        .gap_8()
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
        .child(h_flex().gap_6().flex_wrap().child(vscode).child(cursor))
        .child(
            Button::new("skip-import-settings", "Skip for now")
                .style(ButtonStyle::Subtle)
                .on_click(|_, window, cx| {
                    window.dispatch_action(crate::Finish.boxed_clone(), cx);
                }),
        )
}
