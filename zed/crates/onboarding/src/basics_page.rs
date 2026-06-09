use std::{fmt::Display, future::Future, sync::Arc};

use fs::Fs;
use gpui::{Action, App, IntoElement};
use notifications::status_toast::StatusToast;
use settings::{Settings, SettingsFileUpdateResult, update_settings_file_with_recovery};
use theme::{Appearance, SystemAppearance, ThemeRegistry};
use theme_settings::{ThemeAppearanceMode, ThemeName, ThemeSelection, ThemeSettings};
use ui::{
    StatefulInteractiveElement, ToggleButtonGroup, ToggleButtonGroupSize, ToggleButtonSimple,
    prelude::*,
};
use workspace::with_active_or_new_workspace;

use crate::{
    ExperienceLevel,
    theme_preview::{ThemePreviewStyle, ThemePreviewTile},
};

struct ThemeChoice {
    label: SharedString,
    light: &'static str,
    dark: &'static str,
}

const THEME_CHOICES: [ThemeChoice; 13] = [
    ThemeChoice {
        label: SharedString::new_static("Backboard Blue"),
        light: "Backboard Light Blue",
        dark: "Backboard Dark Blue",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Yellow"),
        light: "Backboard Light Yellow",
        dark: "Backboard Dark Yellow",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Orange"),
        light: "Backboard Light Orange",
        dark: "Backboard Dark Orange",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Red"),
        light: "Backboard Light Red",
        dark: "Backboard Dark Red",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Brown"),
        light: "Backboard Light Brown",
        dark: "Backboard Dark Brown",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Paper"),
        light: "Backboard Paper",
        dark: "Backboard Paper Dark",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Rose"),
        light: "Backboard Rose",
        dark: "Backboard Rose Dark",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Core"),
        light: "Backboard Daylight",
        dark: "Backboard Midnight",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Ember"),
        light: "Backboard Pearl",
        dark: "Backboard Ember",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Mirage"),
        light: "Backboard Pearl",
        dark: "Backboard Mirage",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Earth"),
        light: "Backboard Wheat",
        dark: "Backboard Hearth",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Hearth High"),
        light: "Backboard Wheat High",
        dark: "Backboard Hearth High",
    },
    ThemeChoice {
        label: SharedString::new_static("Backboard Hearth Low"),
        light: "Backboard Wheat Low",
        dark: "Backboard Hearth Low",
    },
];

fn get_theme_family_themes(theme_name: &str) -> Option<(&'static str, &'static str)> {
    for choice in THEME_CHOICES {
        if choice.light == theme_name || choice.dark == theme_name {
            return Some((choice.light, choice.dark));
        }
    }
    None
}

fn render_theme_section(tab_index: &mut isize, cx: &mut App) -> impl IntoElement {
    let theme_selection = ThemeSettings::get_global(cx).theme.clone();
    let system_appearance = theme::SystemAppearance::global(cx);

    let theme_mode = theme_selection
        .mode()
        .unwrap_or_else(|| match *system_appearance {
            Appearance::Light => ThemeAppearanceMode::Light,
            Appearance::Dark => ThemeAppearanceMode::Dark,
        });

    return v_flex()
        .w_full()
        .items_center()
        .gap_7()
        .child(
            v_flex()
                .items_center()
                .gap_2()
                .child(Headline::new("Choose your theme").size(HeadlineSize::Large))
                .child(
                    Label::new("Start with a look you like. You can change it anytime.")
                        .color(Color::Muted)
                        .size(LabelSize::Small),
                ),
        )
        .child(
            ToggleButtonGroup::single_row(
                "theme-selector-onboarding-dark-light",
                [
                    ThemeAppearanceMode::Light,
                    ThemeAppearanceMode::Dark,
                    ThemeAppearanceMode::System,
                ]
                .map(|mode| {
                    const MODE_NAMES: [SharedString; 3] = [
                        SharedString::new_static("Light"),
                        SharedString::new_static("Dark"),
                        SharedString::new_static("System"),
                    ];
                    ToggleButtonSimple::new(MODE_NAMES[mode as usize].clone(), move |_, _, cx| {
                        write_mode_change(mode, cx);

                        telemetry::event!(
                            "Welcome Theme mode Changed",
                            from = theme_mode,
                            to = mode
                        );
                    })
                }),
            )
            .size(ToggleButtonGroupSize::Medium)
            .tab_index(tab_index)
            .selected_index(theme_mode as usize)
            .style(ui::ToggleButtonGroupStyle::Outlined)
            .width(rems_from_px(3. * 72.)),
        )
        .child(
            h_flex()
                .w_full()
                .justify_center()
                .gap_5()
                .flex_wrap()
                .children(render_theme_previews(tab_index, &theme_selection, cx)),
        );

    fn render_theme_previews(
        tab_index: &mut isize,
        theme_selection: &ThemeSelection,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        let system_appearance = SystemAppearance::global(cx);
        let theme_registry = ThemeRegistry::global(cx);

        let theme_seed = 0xBEEF as f32;
        let theme_mode = theme_selection
            .mode()
            .unwrap_or_else(|| match *system_appearance {
                Appearance::Light => ThemeAppearanceMode::Light,
                Appearance::Dark => ThemeAppearanceMode::Dark,
            });
        let appearance = match theme_mode {
            ThemeAppearanceMode::Light => Appearance::Light,
            ThemeAppearanceMode::Dark => Appearance::Dark,
            ThemeAppearanceMode::System => *system_appearance,
        };
        let current_theme_name: SharedString = theme_selection.name(appearance).0.into();

        let mut rendered_theme_names = Vec::new();

        THEME_CHOICES
            .iter()
            .filter_map(|choice| {
                let theme_name = if theme_mode == ThemeAppearanceMode::System {
                    choice.light
                } else {
                    match appearance {
                        Appearance::Light => choice.light,
                        Appearance::Dark => choice.dark,
                    }
                };

                if theme_mode != ThemeAppearanceMode::System
                    && rendered_theme_names.contains(&theme_name)
                {
                    return None;
                }
                rendered_theme_names.push(theme_name);

                Some((choice, theme_registry.get(theme_name).ok()?))
            })
            .map(|(choice, theme)| {
                let is_selected = match theme_selection {
                    ThemeSelection::Dynamic { mode, light, dark }
                        if *mode == ThemeAppearanceMode::System =>
                    {
                        light.0.as_ref() == choice.light && dark.0.as_ref() == choice.dark
                    }
                    _ => theme.name == current_theme_name,
                };
                let name = theme.name.clone();
                let colors = cx.theme().colors();

                v_flex()
                    .w(rems_from_px(236.))
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .child(
                        h_flex()
                            .id(name)
                            .relative()
                            .w_full()
                            .border_2()
                            .border_color(colors.border_transparent)
                            .rounded(ThemePreviewTile::ROOT_RADIUS)
                            .map(|this| {
                                if is_selected {
                                    this.border_color(colors.border_selected)
                                } else {
                                    this.opacity(0.8).hover(|s| s.border_color(colors.border))
                                }
                            })
                            .tab_index({
                                *tab_index += 1;
                                *tab_index - 1
                            })
                            .focus(|mut style| {
                                style.border_color = Some(colors.border_focused);
                                style
                            })
                            .on_click({
                                let theme_name = if theme_mode == ThemeAppearanceMode::System {
                                    SharedString::new_static(choice.dark)
                                } else {
                                    theme.name.clone()
                                };
                                let current_theme_name = current_theme_name.clone();

                                move |_, _, cx| {
                                    write_theme_change(theme_name.clone(), theme_mode, cx);
                                    telemetry::event!(
                                        "Welcome Theme Changed",
                                        from = current_theme_name,
                                        to = theme_name
                                    );
                                }
                            })
                            .map(|this| {
                                if theme_mode == ThemeAppearanceMode::System {
                                    let Ok(light) = theme_registry.get(choice.light) else {
                                        return this;
                                    };
                                    let Ok(dark) = theme_registry.get(choice.dark) else {
                                        return this;
                                    };
                                    this.child(
                                        ThemePreviewTile::new(light, theme_seed)
                                            .style(ThemePreviewStyle::SideBySide(dark)),
                                    )
                                } else {
                                    this.child(
                                        ThemePreviewTile::new(theme.clone(), theme_seed)
                                            .style(ThemePreviewStyle::Bordered),
                                    )
                                }
                            }),
                    )
                    .child(
                        Label::new(choice.label.clone())
                            .color(Color::Muted)
                            .size(LabelSize::Small),
                    )
                    .into_any_element()
            })
            .collect()
    }

    fn write_mode_change(mode: ThemeAppearanceMode, cx: &mut App) {
        let fs = <dyn Fs>::global(cx);
        let update_result = update_settings_file_with_recovery(fs, cx, move |settings, _cx| {
            theme_settings::set_mode(settings, mode);
        });
        handle_theme_settings_update(update_result, cx);
    }

    fn write_theme_change(
        theme: impl Into<Arc<str>>,
        theme_mode: ThemeAppearanceMode,
        cx: &mut App,
    ) {
        let fs = <dyn Fs>::global(cx);
        let theme = theme.into();
        let update_result =
            update_settings_file_with_recovery(fs, cx, move |settings, cx| match theme_mode {
                ThemeAppearanceMode::System => {
                    let (light_theme, dark_theme) =
                        get_theme_family_themes(&theme).unwrap_or((theme.as_ref(), theme.as_ref()));

                    settings.theme.theme = Some(settings::ThemeSelection::Dynamic {
                        mode: ThemeAppearanceMode::System,
                        light: ThemeName(light_theme.into()),
                        dark: ThemeName(dark_theme.into()),
                    });
                }
                ThemeAppearanceMode::Light => theme_settings::set_theme(
                    settings,
                    theme,
                    Appearance::Light,
                    *SystemAppearance::global(cx),
                ),
                ThemeAppearanceMode::Dark => theme_settings::set_theme(
                    settings,
                    theme,
                    Appearance::Dark,
                    *SystemAppearance::global(cx),
                ),
            });
        handle_theme_settings_update(update_result, cx);
    }

    fn handle_theme_settings_update<F, E>(update_result: F, cx: &mut App)
    where
        F: Future<Output = Result<anyhow::Result<SettingsFileUpdateResult>, E>> + 'static,
        E: Display + 'static,
    {
        cx.spawn(async move |cx| {
            let update_result = match update_result.await {
                Ok(update_result) => update_result,
                Err(error) => Err(anyhow::anyhow!(
                    "settings update task was canceled: {error}"
                )),
            };

            cx.update(|cx| match update_result {
                Ok(SettingsFileUpdateResult::Updated) => {}
                Ok(SettingsFileUpdateResult::RecoveredInvalidUserSettings) => {
                    with_active_or_new_workspace(cx, |workspace, _window, cx| {
                        let toast = StatusToast::new(
                            "Theme saved. Invalid settings were backed up and repaired.",
                            cx,
                            |this, _| {
                                this.icon(
                                    Icon::new(IconName::Check)
                                        .size(IconSize::Small)
                                        .color(Color::Success),
                                )
                                .dismiss_button(true)
                            },
                        );
                        workspace.toggle_status_toast(toast, cx);
                    });
                }
                Err(error) => {
                    zlog::error!("Failed to update onboarding theme settings: {error:?}");
                    with_active_or_new_workspace(cx, |workspace, _window, cx| {
                        let toast = StatusToast::new(
                            "Theme could not be saved. See log for details.",
                            cx,
                            |this, _| {
                                this.icon(
                                    Icon::new(IconName::Close)
                                        .size(IconSize::Small)
                                        .color(Color::Error),
                                )
                                .action("Open Log", |window, cx| {
                                    window.dispatch_action(workspace::OpenLog.boxed_clone(), cx)
                                })
                                .dismiss_button(true)
                            },
                        );
                        workspace.toggle_status_toast(toast, cx);
                    });
                }
            });
        })
        .detach();
    }
}

pub(crate) fn render_basics_page(_level: ExperienceLevel, cx: &mut App) -> impl IntoElement {
    let mut tab_index = 0;

    v_flex()
        .id("basics-page")
        .w_full()
        .py_12()
        .items_center()
        .gap_6()
        .child(render_theme_section(&mut tab_index, cx))
}
