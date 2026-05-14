mod beginner_chat_feed;
mod beginner_workspace;
mod file_changes_panel;
mod web_preview;

pub use beginner_workspace::{BeginnerWorkspace, BeginnerWorkspaceEvent};

use gpui::actions;

actions!(
    beginner_ui,
    [
        /// Switches from Beginner Mode to the standard Developer editor.
        SwitchToEditor,
        /// Starts a fresh project in Beginner Mode.
        NewBeginnerProject,
    ]
);
