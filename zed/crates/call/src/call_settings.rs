use settings::{RegisterSetting, Settings};

#[derive(Debug, RegisterSetting)]
pub struct CallSettings {
    pub mute_on_join: bool,
    pub share_on_join: bool,
}

impl Settings for CallSettings {
    fn from_settings(content: &settings::SettingsContent) -> Self {
        let call = content.calls.as_ref();
        CallSettings {
            mute_on_join: call
                .and_then(|settings| settings.mute_on_join)
                .unwrap_or(true),
            share_on_join: call
                .and_then(|settings| settings.share_on_join)
                .unwrap_or(false),
        }
    }
}
