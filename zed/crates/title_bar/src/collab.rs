use std::rc::Rc;

use gpui::{AnyElement, App, IntoElement, ScreenCaptureSource, Window};
use ui::prelude::*;

use crate::TitleBar;

pub fn toggle_screen_sharing(
    _screen: anyhow::Result<Option<Rc<dyn ScreenCaptureSource>>>,
    _window: &mut Window,
    _cx: &mut App,
) {
}

pub fn toggle_mute(_cx: &mut App) {}

pub fn toggle_deafen(_cx: &mut App) {}

impl TitleBar {
    pub(crate) fn render_collaborator_list(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex().id("collaborator-list").w_full()
    }

    pub(crate) fn render_call_controls(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        Vec::new()
    }
}
