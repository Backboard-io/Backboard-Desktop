use gpui::Pixels;
use settings::{RegisterSetting, Settings};
use ui::px;
use workspace::dock::DockPosition;

#[derive(Debug, RegisterSetting)]
pub struct CollaborationPanelSettings {
    pub button: bool,
    pub dock: DockPosition,
    pub default_width: Pixels,
}

impl Settings for CollaborationPanelSettings {
    fn from_settings(content: &settings::SettingsContent) -> Self {
        let panel = content.collaboration_panel.as_ref();

        Self {
            button: false,
            dock: panel
                .and_then(|settings| settings.dock)
                .unwrap_or(settings::DockPosition::Left)
                .into(),
            default_width: panel
                .and_then(|settings| settings.default_width)
                .map(px)
                .unwrap_or(px(240.)),
        }
    }
}
