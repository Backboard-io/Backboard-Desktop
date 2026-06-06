use anyhow::Result;
use backboard::BackboardConfig;
use edit_prediction::{
    ApiKeyState,
    backboard::{BACKBOARD_CREDENTIALS_URL, backboard_api_token},
};
use gpui::{App, Entity, ScrollHandle, TaskExt, prelude::*};

use ui::{ButtonLink, ConfiguredApiCard, prelude::*};

use crate::{
    SettingsWindow,
    components::{SettingsInputField, SettingsSectionHeader},
};

pub(crate) fn render_edit_prediction_setup_page(
    _settings_window: &SettingsWindow,
    scroll_handle: &ScrollHandle,
    window: &mut Window,
    cx: &mut Context<SettingsWindow>,
) -> AnyElement {
    let providers = [Some(
        render_api_key_provider(
            "B",
            "Backboard AI",
            ApiKeyDocs::Link {
                dashboard_url: "https://app.backboard.io/dashboard/api-keys".into(),
            },
            backboard_api_token(cx),
            |_cx| BACKBOARD_CREDENTIALS_URL,
            None,
            window,
            cx,
        )
        .into_any_element(),
    )];

    div()
        .size_full()
        .child(
            v_flex()
                .id("ep-setup-page")
                .min_w_0()
                .size_full()
                .px_8()
                .pb_16()
                .overflow_y_scroll()
                .track_scroll(&scroll_handle)
                .children(providers.into_iter().flatten()),
        )
        .into_any_element()
}

enum ApiKeyDocs {
    Link { dashboard_url: SharedString },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ApiKeySyncStatus {
    Saved,
    Cleared,
    Error(String),
}

fn render_api_key_provider(
    brand_letter: &'static str,
    title: &'static str,
    docs: ApiKeyDocs,
    api_key_state: Entity<ApiKeyState>,
    current_url: fn(&mut App) -> SharedString,
    additional_fields: Option<AnyElement>,
    window: &mut Window,
    cx: &mut Context<SettingsWindow>,
) -> impl IntoElement {
    let weak_page = cx.weak_entity();
    let credentials_provider = zed_credentials_provider::global(cx);
    let sync_status = window.use_keyed_state(format!("{title}-api-key-sync-status"), cx, |_, _| {
        None::<ApiKeySyncStatus>
    });
    _ = window.use_keyed_state(current_url(cx), cx, |_, cx| {
        let task = api_key_state.update(cx, |key_state, cx| {
            key_state.load_if_needed(
                current_url(cx),
                |state| state,
                credentials_provider.clone(),
                cx,
            )
        });
        cx.spawn(async move |_, cx| {
            task.await.ok();
            weak_page
                .update(cx, |_, cx| {
                    cx.notify();
                })
                .ok();
        })
    });

    let has_config_file_key = backboard_config_file_has_key();
    let has_key = has_config_file_key || backboard_api_key_from_env();
    let (env_var_name, is_from_env_var) = api_key_state.read_with(cx, |state, _| {
        let is_from_env_var = !has_config_file_key && backboard_api_key_from_env();
        (Some(state.env_var_name().clone()), is_from_env_var)
    });

    let sync_status_for_write = sync_status.clone();
    let write_key = move |api_key: Option<String>, cx: &mut App| {
        let api_key = api_key.and_then(|key| non_empty_key(&key));
        let sync_result = sync_backboard_config_api_key(api_key);
        let (api_key, status) = match sync_result {
            Ok(result) => result,
            Err(error) => {
                sync_status_for_write.update(cx, |status, cx| {
                    *status = Some(ApiKeySyncStatus::Error(format!("{error:#}")));
                    cx.notify();
                });
                return;
            }
        };
        sync_status_for_write.update(cx, |current_status, cx| {
            *current_status = Some(status);
            cx.notify();
        });
        let credentials_provider = zed_credentials_provider::global(cx);
        api_key_state
            .update(cx, |key_state, cx| {
                let url = current_url(cx);
                key_state.store(
                    url,
                    api_key,
                    |key_state| key_state,
                    credentials_provider,
                    cx,
                )
            })
            .detach_and_log_err(cx);
    };
    let sync_status = sync_status.read(cx).clone();

    let base_container = v_flex().id(title).min_w_0().pt_8().gap_1p5();
    let header = SettingsSectionHeader::new(title)
        .brand_letter(brand_letter)
        .no_padding(true);
    let button_link_label = format!("{} dashboard", title);
    let description = match docs {
        ApiKeyDocs::Link { dashboard_url } => h_flex()
            .w_full()
            .min_w_0()
            .flex_wrap()
            .gap_0p5()
            .child(
                Label::new("Visit the")
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                ButtonLink::new(button_link_label, dashboard_url)
                    .no_icon(true)
                    .label_size(LabelSize::Small)
                    .label_color(Color::Muted),
            )
            .child(
                Label::new("to generate an API key.")
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            ),
    };
    let configured_card_label = if is_from_env_var {
        "API Key Set in Environment Variable"
    } else {
        "API Key Configured"
    };

    let container = if has_key {
        base_container.child(header).child(
            ConfiguredApiCard::new(configured_card_label)
                .button_label("Reset Key")
                .button_tab_index(0)
                .disabled(is_from_env_var)
                .when_some(env_var_name, |this, env_var_name| {
                    this.when(is_from_env_var, |this| {
                        this.tooltip_label(format!(
                            "To reset your API key, unset the {} environment variable.",
                            env_var_name
                        ))
                    })
                })
                .on_click(move |_, _, cx| {
                    write_key(None, cx);
                }),
        )
    } else {
        base_container.child(header).child(
            h_flex()
                .pt_2p5()
                .w_full()
                .min_w_0()
                .justify_between()
                .child(
                    v_flex()
                        .w_full()
                        .min_w_0()
                        .max_w_1_2()
                        .child(Label::new("API Key"))
                        .child(description)
                        .when_some(env_var_name, |this, env_var_name| {
                            this.child({
                                let label = format!(
                                    "Or set the {} env var and restart Backboard Studio.",
                                    env_var_name.as_ref()
                                );
                                Label::new(label).size(LabelSize::Small).color(Color::Muted)
                            })
                        }),
                )
                .child(
                    SettingsInputField::new()
                        .tab_index(0)
                        .with_placeholder("xxxxxxxxxxxxxxxxxxxx")
                        .on_confirm(move |api_key, _window, cx| {
                            write_key(api_key.filter(|key| !key.is_empty()), cx);
                        }),
                ),
        )
    };

    container
        .when_some(sync_status, |this, status| {
            this.child(render_api_key_sync_status(status))
        })
        .when_some(additional_fields, |this, additional_fields| {
            this.child(
                div()
                    .map(|this| if has_key { this.mt_1() } else { this.mt_4() })
                    .px_neg_8()
                    .border_t_1()
                    .border_color(cx.theme().colors().border_variant)
                    .child(additional_fields),
            )
        })
}

fn backboard_config_file_has_key() -> bool {
    let config = BackboardConfig::load_or_default();
    config.api_key.as_deref().and_then(non_empty_key).is_some()
        || config
            .env_keys
            .get(&config.env.to_lowercase())
            .and_then(|key| non_empty_key(key))
            .is_some()
}

fn backboard_api_key_from_env() -> bool {
    std::env::var("BACKBOARD_API_KEY")
        .ok()
        .and_then(|key| non_empty_key(&key))
        .is_some()
}

fn non_empty_key(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

fn sync_backboard_config_api_key(
    api_key: Option<String>,
) -> Result<(Option<String>, ApiKeySyncStatus)> {
    match api_key {
        Some(api_key) => {
            let config = BackboardConfig::save_api_key_for_current_env(api_key)?;
            Ok((config.api_key(), ApiKeySyncStatus::Saved))
        }
        None => {
            BackboardConfig::clear_api_key_for_current_env()?;
            Ok((None, ApiKeySyncStatus::Cleared))
        }
    }
}

fn render_api_key_sync_status(status: ApiKeySyncStatus) -> impl IntoElement {
    let (message, color) = match status {
        ApiKeySyncStatus::Saved => (
            "Saved to ~/.backboard/config.json".to_string(),
            Color::Success,
        ),
        ApiKeySyncStatus::Cleared => (
            "Removed from ~/.backboard/config.json".to_string(),
            Color::Muted,
        ),
        ApiKeySyncStatus::Error(error) => {
            (format!("Could not update API key: {error}"), Color::Error)
        }
    };

    Label::new(message).size(LabelSize::Small).color(color)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_config_path(test_name: &str) -> (PathBuf, PathBuf) {
        let test_root = std::env::temp_dir().join(format!(
            "{test_name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = test_root.join(".backboard").join("config.json");
        (test_root, path)
    }

    #[test]
    fn sync_backboard_api_key_writes_shared_config_before_reporting_success() {
        let (test_root, path) = temp_config_path("settings-backboard-save");
        let _guard = backboard::set_config_path_for_testing(path.clone());

        let (api_key, status) =
            sync_backboard_config_api_key(Some("  bb-settings-key  ".to_string())).unwrap();

        assert_eq!(api_key.as_deref(), Some("bb-settings-key"));
        assert_eq!(status, ApiKeySyncStatus::Saved);

        let config = BackboardConfig::load().unwrap();
        assert_eq!(config.api_key.as_deref(), Some("bb-settings-key"));
        assert_eq!(
            config.env_keys.get("prod").map(String::as_str),
            Some("bb-settings-key")
        );
        assert!(path.exists());

        std::fs::remove_dir_all(test_root).ok();
    }

    #[test]
    fn sync_backboard_api_key_reset_clears_shared_config_key() {
        let (test_root, path) = temp_config_path("settings-backboard-reset");
        let _guard = backboard::set_config_path_for_testing(path);

        sync_backboard_config_api_key(Some("bb-settings-key".to_string())).unwrap();
        let (api_key, status) = sync_backboard_config_api_key(None).unwrap();

        assert_eq!(api_key, None);
        assert_eq!(status, ApiKeySyncStatus::Cleared);

        let config = BackboardConfig::load().unwrap();
        assert_eq!(config.api_key, None);
        assert_eq!(config.env_keys.get("prod"), None);

        std::fs::remove_dir_all(test_root).ok();
    }
}
