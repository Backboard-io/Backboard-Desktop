mod edit_prediction_provider_setup;
mod feature_flags;
mod tool_permissions_setup;

pub(crate) use edit_prediction_provider_setup::render_edit_prediction_setup_page;
pub(crate) use feature_flags::render_feature_flags_page;
pub(crate) use tool_permissions_setup::render_tool_permissions_setup_page;

pub use tool_permissions_setup::{
    render_copy_path_tool_config, render_create_directory_tool_config,
    render_delete_path_tool_config, render_edit_file_tool_config, render_fetch_tool_config,
    render_move_path_tool_config, render_terminal_tool_config, render_web_search_tool_config,
    render_write_file_tool_config,
};
