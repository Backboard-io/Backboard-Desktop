use std::sync::Arc;

use client::TelemetrySettings;
use fs::Fs;
use gpui::{Action, App, IntoElement};
use project::project_settings::ProjectSettings;
use settings::{Settings, update_settings_file};
use theme::{Appearance, SystemAppearance, ThemeRegistry};
use theme_settings::{ThemeAppearanceMode, ThemeName, ThemeSelection, ThemeSettings};
use ui::{
    Divider, StatefulInteractiveElement, SwitchField, TintColor,
    ToggleButtonGroup, ToggleButtonGroupSize, ToggleButtonSimple, Tooltip,
    prelude::*,
};
use vim_mode_setting::VimModeSetting;

use crate::{
    ExperienceLevel, ImportCursorSettings, ImportVsCodeSettings, SettingsImportState,
    theme_preview::{ThemePreviewStyle, ThemePreviewTile},
};

const LIGHT_THEMES: [&str; 3] = ["One Light", "Ayu Light", "Gruvbox Light"];
const DARK_THEMES: [&str; 3] = ["One Dark", "Ayu Dark", "Gruvbox Dark"];
const FAMILY_NAMES: [SharedString; 3] = [
    SharedString::new_static("One"),
    SharedString::new_static("Ayu"),
    SharedString::new_static("Gruvbox"),
];

fn get_theme_family_themes(theme_name: &str) -> Option<(&'static str, &'static str)> {
    for i in 0..LIGHT_THEMES.len() {
        if LIGHT_THEMES[i] == theme_name || DARK_THEMES[i] == theme_name {
            return Some((LIGHT_THEMES[i], DARK_THEMES[i]));
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
        .gap_2()
        .child(
            h_flex().justify_between().child(Label::new("Theme")).child(
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
                        ToggleButtonSimple::new(
                            MODE_NAMES[mode as usize].clone(),
                            move |_, _, cx| {
                                write_mode_change(mode, cx);

                                telemetry::event!(
                                    "Welcome Theme mode Changed",
                                    from = theme_mode,
                                    to = mode
                                );
                            },
                        )
                    }),
                )
                .size(ToggleButtonGroupSize::Medium)
                .tab_index(tab_index)
                .selected_index(theme_mode as usize)
                .style(ui::ToggleButtonGroupStyle::Outlined)
                .width(rems_from_px(3. * 64.)),
            ),
        )
        .child(
            h_flex()
                .gap_2()
                .justify_between()
                .children(render_theme_previews(tab_index, &theme_selection, cx)),
        );

    fn render_theme_previews(
        tab_index: &mut isize,
        theme_selection: &ThemeSelection,
        cx: &mut App,
    ) -> [impl IntoElement; 3] {
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

        let theme_names = match appearance {
            Appearance::Light => LIGHT_THEMES,
            Appearance::Dark => DARK_THEMES,
        };

        let themes = theme_names.map(|theme| theme_registry.get(theme).unwrap());

        [0, 1, 2].map(|index| {
            let theme = &themes[index];
            let is_selected = theme.name == current_theme_name;
            let name = theme.name.clone();
            let colors = cx.theme().colors();

            v_flex()
                .w_full()
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
                            let theme_name = theme.name.clone();
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
                                let (light, dark) = (
                                    theme_registry.get(LIGHT_THEMES[index]).unwrap(),
                                    theme_registry.get(DARK_THEMES[index]).unwrap(),
                                );
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
                    Label::new(FAMILY_NAMES[index].clone())
                        .color(Color::Muted)
                        .size(LabelSize::Small),
                )
        })
    }

    fn write_mode_change(mode: ThemeAppearanceMode, cx: &mut App) {
        let fs = <dyn Fs>::global(cx);
        update_settings_file(fs, cx, move |settings, _cx| {
            theme_settings::set_mode(settings, mode);
        });
    }

    fn write_theme_change(
        theme: impl Into<Arc<str>>,
        theme_mode: ThemeAppearanceMode,
        cx: &mut App,
    ) {
        let fs = <dyn Fs>::global(cx);
        let theme = theme.into();
        update_settings_file(fs, cx, move |settings, cx| match theme_mode {
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
    }
}

fn render_telemetry_section(tab_index: &mut isize, cx: &App) -> impl IntoElement {
    let fs = <dyn Fs>::global(cx);

    v_flex()
        .gap_4()
        .child(
            SwitchField::new(
                "onboarding-telemetry-metrics",
                None::<&str>,
                Some("Help improve Backboard Studio by sending anonymous usage data".into()),
                if TelemetrySettings::get_global(cx).metrics {
                    ui::ToggleState::Selected
                } else {
                    ui::ToggleState::Unselected
                },
                {
                    let fs = fs.clone();
                    move |selection, _, cx| {
                        let enabled = match selection {
                            ToggleState::Selected => true,
                            ToggleState::Unselected => false,
                            ToggleState::Indeterminate => {
                                return;
                            }
                        };

                        update_settings_file(fs.clone(), cx, move |setting, _| {
                            setting.telemetry.get_or_insert_default().metrics = Some(enabled);
                        });

                        // This telemetry event shouldn't fire when it's off. If it does we'll be alerted
                        // and can fix it in a timely manner to respect a user's choice.
                        telemetry::event!(
                            "Welcome Page Telemetry Metrics Toggled",
                            options = if enabled { "on" } else { "off" }
                        );
                    }
                },
            )
            .tab_index({
                *tab_index += 1;
                *tab_index
            }),
        )
        .child(
            SwitchField::new(
                "onboarding-telemetry-crash-reports",
                None::<&str>,
                Some(
                    "Help fix Backboard Studio by sending crash reports so we can fix critical issues fast"
                        .into(),
                ),
                if TelemetrySettings::get_global(cx).diagnostics {
                    ui::ToggleState::Selected
                } else {
                    ui::ToggleState::Unselected
                },
                {
                    let fs = fs.clone();
                    move |selection, _, cx| {
                        let enabled = match selection {
                            ToggleState::Selected => true,
                            ToggleState::Unselected => false,
                            ToggleState::Indeterminate => {
                                return;
                            }
                        };

                        update_settings_file(fs.clone(), cx, move |setting, _| {
                            setting.telemetry.get_or_insert_default().diagnostics = Some(enabled);
                        });

                        // This telemetry event shouldn't fire when it's off. If it does we'll be alerted
                        // and can fix it in a timely manner to respect a user's choice.
                        telemetry::event!(
                            "Welcome Page Telemetry Diagnostics Toggled",
                            options = if enabled { "on" } else { "off" }
                        );
                    }
                },
            )
            .tab_index({
                *tab_index += 1;
                *tab_index
            }),
        )
}


fn render_vim_mode_switch(
    tab_index: &mut isize,
    mention_neovim: bool,
    cx: &mut App,
) -> impl IntoElement {
    let toggle_state = if VimModeSetting::get_global(cx).0 {
        ui::ToggleState::Selected
    } else {
        ui::ToggleState::Unselected
    };
    let description: SharedString = if mention_neovim {
        "Coming from Neovim? Use our first-class implementation of Vim Mode".into()
    } else {
        "Use Vim-style keybindings while editing".into()
    };
    SwitchField::new(
        "onboarding-vim-mode",
        Some("Vim Mode"),
        Some(description),
        toggle_state,
        {
            let fs = <dyn Fs>::global(cx);
            move |&selection, _, cx| {
                let vim_mode = match selection {
                    ToggleState::Selected => true,
                    ToggleState::Unselected => false,
                    ToggleState::Indeterminate => {
                        return;
                    }
                };
                update_settings_file(fs.clone(), cx, move |setting, _| {
                    setting.vim_mode = Some(vim_mode);
                });

                telemetry::event!(
                    "Welcome Vim Mode Toggled",
                    options = if vim_mode { "on" } else { "off" },
                );
            }
        },
    )
    .tab_index({
        *tab_index += 1;
        *tab_index - 1
    })
}

fn render_worktree_auto_trust_switch(tab_index: &mut isize, cx: &mut App) -> impl IntoElement {
    let toggle_state = if ProjectSettings::get_global(cx).session.trust_all_worktrees {
        ui::ToggleState::Selected
    } else {
        ui::ToggleState::Unselected
    };

    let tooltip_description = "Backboard Studio can only allow services like language servers, project settings, and MCP servers to run after you mark a new project as trusted.";

    SwitchField::new(
        "onboarding-auto-trust-worktrees",
        Some("Trust All Projects By Default"),
        Some("Automatically mark all new projects as trusted to unlock all Backboard's features".into()),
        toggle_state,
        {
            let fs = <dyn Fs>::global(cx);
            move |&selection, _, cx| {
                let trust = match selection {
                    ToggleState::Selected => true,
                    ToggleState::Unselected => false,
                    ToggleState::Indeterminate => {
                        return;
                    }
                };
                update_settings_file(fs.clone(), cx, move |setting, _| {
                    setting.session.get_or_insert_default().trust_all_worktrees = Some(trust);
                });

                telemetry::event!(
                    "Welcome Page Worktree Auto Trust Toggled",
                    options = if trust { "on" } else { "off" }
                );
            }
        },
    )
    .tab_index({
        *tab_index += 1;
        *tab_index - 1
    })
    .tooltip(Tooltip::text(tooltip_description))
}

fn render_setting_import_button(
    tab_index: isize,
    label: SharedString,
    action: &dyn Action,
    imported: bool,
) -> impl IntoElement + 'static {
    let action = action.boxed_clone();

    Button::new(label.clone(), label.clone())
        .style(ButtonStyle::OutlinedGhost)
        .size(ButtonSize::Medium)
        .label_size(LabelSize::Small)
        .selected_style(ButtonStyle::Tinted(TintColor::Accent))
        .toggle_state(imported)
        .tab_index(tab_index)
        .when(imported, |this| {
            this.end_icon(Icon::new(IconName::Check).size(IconSize::Small))
                .color(Color::Success)
        })
        .on_click(move |_, window, cx| {
            telemetry::event!("Welcome Import Settings", import_source = label,);
            window.dispatch_action(action.boxed_clone(), cx);
        })
}

fn render_import_settings_section(tab_index: &mut isize, cx: &mut App) -> impl IntoElement {
    let import_state = SettingsImportState::global(cx);
    let imports: [(SharedString, &dyn Action, bool); 2] = [
        (
            "VS Code".into(),
            &ImportVsCodeSettings { skip_prompt: false },
            import_state.vscode,
        ),
        (
            "Cursor".into(),
            &ImportCursorSettings { skip_prompt: false },
            import_state.cursor,
        ),
    ];

    let [vscode, cursor] = imports.map(|(label, action, imported)| {
        *tab_index += 1;
        render_setting_import_button(*tab_index - 1, label, action, imported)
    });

    h_flex()
        .gap_2()
        .flex_wrap()
        .justify_between()
        .child(
            v_flex()
                .gap_0p5()
                .max_w_5_6()
                .child(Label::new("Import Settings"))
                .child(
                    Label::new("Automatically pull your settings from other editors")
                        .color(Color::Muted),
                ),
        )
        .child(h_flex().gap_1().child(vscode).child(cursor))
}

fn render_ai_section(_cx: &mut App) -> impl IntoElement {
    v_flex()
        .gap_0p5()
        .child(Label::new("Agent Setup"))
        .child(
            Label::new(
                "Open your Backboard dashboard to set up an API key and start working with Backboard agents.",
            )
            .color(Color::Muted),
        )
        .child(
            Button::new("open-backboard-dashboard", "Open Backboard Dashboard")
                .style(ButtonStyle::Outlined)
                .size(ButtonSize::Medium)
                .full_width()
                .on_click(|_, _, cx| {
                    cx.open_url("https://app.backboard.io");
                }),
        )
}

pub(crate) fn render_basics_page(level: ExperienceLevel, cx: &mut App) -> impl IntoElement {
    let mut tab_index = 0;

    let show_import = matches!(level, ExperienceLevel::Developer | ExperienceLevel::Power);
    let show_vim = matches!(level, ExperienceLevel::Developer | ExperienceLevel::Power);
    let show_worktree_trust = matches!(level, ExperienceLevel::Power);
    let mention_neovim = matches!(level, ExperienceLevel::Power);

    v_flex()
        .id("basics-page")
        .gap_6()
        .child(render_theme_section(&mut tab_index, cx))
        .child(render_ai_section(cx))
        .when(show_import, |this| {
            this.child(render_import_settings_section(&mut tab_index, cx))
        })
        .when(show_vim, |this| {
            this.child(render_vim_mode_switch(&mut tab_index, mention_neovim, cx))
        })
        .when(show_worktree_trust, |this| {
            this.child(render_worktree_auto_trust_switch(&mut tab_index, cx))
        })
        .child(Divider::horizontal().color(ui::DividerColor::BorderVariant))
        .child(render_telemetry_section(&mut tab_index, cx))
}
