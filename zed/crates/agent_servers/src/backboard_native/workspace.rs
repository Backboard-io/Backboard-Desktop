use std::{fs, path::Path};

pub fn system_prompt(workspace: &Path) -> String {
    format!(
        "You are running inside Backboard IDE through Zed's native Rust runtime.\n\
         Workspace: {}\n\n\
         Use the native read/search tools for exploration, native edit/write/delete tools for file changes, \
         and bash/run_terminal_cmd for shell checks. File changes are shown as IDE diffs before they are applied. \
         Keep progress concise, batch independent read/search work, and use todo_write for multi-step tasks.",
        workspace.display()
    )
}

pub fn augment_prompt(message: &str, workspace: &Path, mode: &str) -> String {
    let context = workspace_context(workspace);
    format!(
        "{message}\n\n\
         <backboard_ide_context>\n\
         runtime: native-rust\n\
         mode: {mode}\n\
         workspace: {}\n\
         {context}\n\
         </backboard_ide_context>",
        workspace.display()
    )
}

fn workspace_context(workspace: &Path) -> String {
    let Ok(entries) = fs::read_dir(workspace) else {
        return "workspace_files: unavailable".to_string();
    };
    let mut names = entries
        .filter_map(Result::ok)
        .take(80)
        .map(|entry| {
            let marker = entry
                .file_type()
                .ok()
                .map(|file_type| if file_type.is_dir() { "/" } else { "" })
                .unwrap_or("");
            format!("{}{}", entry.file_name().to_string_lossy(), marker)
        })
        .collect::<Vec<_>>();
    names.sort();
    format!("workspace_files: {}", names.join(", "))
}
