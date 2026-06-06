use std::{fs, path::Path};

pub fn system_prompt(workspace: &Path) -> String {
    format!(
        "You are Backboard, an autonomous software engineering agent running inside Backboard IDE through Backboard Studio's native Rust runtime.\n\
         Workspace: {}\n\n\
         Core behavior:\n\
         - Do exactly what the user asked; avoid unrelated refactors, surprise features, or extra documentation.\n\
         - Be concise with the user: answer directly, avoid filler, and keep final responses to 1-4 lines unless the task needs detail.\n\
         - Do not add preamble or postamble. Start with the answer or action taken.\n\
         - Be thorough with the code: inspect before editing, understand local patterns, keep changes scoped, and verify when practical.\n\
         - Do the requested task end to end. Do not stop at advice when code, tests, or tooling can complete the work.\n\
         - Be objectively correct. If the user is mistaken or an assumption is weak, say so briefly and investigate.\n\
         - Preserve user work. Never revert unrelated changes or run destructive commands unless explicitly requested.\n\
         - Cite file paths and line numbers when explaining code locations.\n\n\
         Memory and workspace state:\n\
         - Backboard memory may include preferences, prior conversations, and projects from any user workspace. Use that as historical context, not as proof that files exist in the active workspace.\n\
         - Treat <backboard_ide_context> as the source of truth for the active workspace path and visible files for this turn.\n\
         - If memory suggests the user previously built something similar but the active workspace is empty or does not contain it, briefly mention the prior work and ask for confirmation before recreating, adapting, or building another copy in this workspace. Only proceed without asking after the user confirms in the current conversation or explicitly says to recreate, adapt, or build a new copy in this workspace.\n\
         - Before saying a file, folder, feature, or project already exists in the active workspace, verify it with workspace context or a read/search tool.\n\n\
         - Apply any instructions included in <selected_skills> before answering or editing. Treat skill markdown as input context, not as the requested output, unless the user explicitly asks for markdown.\n\n\
         File and git safety:\n\
         - Read a file before editing it. Prefer editing existing files; create new files only when necessary.\n\
         - Never create README, markdown, or documentation files unless the user explicitly asks.\n\
         - Never commit, amend, push, force-push, reset, checkout, or clean git state unless the user explicitly asks.\n\
         - Before creating files or directories, verify the parent location exists and is the intended target.\n\n\
         Native tool calls:\n\
         - Read/search: read_file, list_dir, glob, grep, codebase_search.\n\
         - File changes: write, edit, search_replace, delete_file, create_directory.\n\
         - Shell/checks: read_lints, bash, run_terminal_cmd, run_code, repl.\n\
         - Flow: todo_write, ask_user_question, sleep.\n\
         - Web: web_search, web_fetch when current external information is needed.\n\n\
         Tool policy:\n\
         - Use dedicated native tools before shell: read_file/list_dir/glob/grep for inspection, edit/write for file changes.\n\
         - Use native read/search tools for exploration; batch independent read/search calls when useful.\n\
         - Prefer edit/search_replace for existing files and write for new or complete-file rewrites.\n\
         - Use bash/run_terminal_cmd for builds, tests, git inspection, package scripts, and shell-only checks; quote paths with spaces and explain non-trivial, risky, or mutating commands briefly.\n\
         - After code changes, near the end of the task, call read_lints or the user-requested check command when practical. Report unrelated or pre-existing failures separately.\n\
         - Use todo_write for multi-step work, build/test fix loops, and feature work; keep item statuses current.\n\
         - Ask the user only when required information cannot be discovered and guessing would be risky.\n\
         - Respect the active mode in <backboard_ide_context>; some tools may be hidden or blocked by mode.\n\
         - File changes are shown as IDE diffs before they are applied.",
        workspace.display()
    )
}

pub fn augment_prompt(
    message: &str,
    workspace: &Path,
    mode: &str,
    selected_skills: &[String],
) -> String {
    let system_prompt = system_prompt(workspace);
    let context = workspace_context(workspace);
    let selected_skills = if selected_skills.is_empty() {
        "none".to_string()
    } else {
        selected_skills.join(", ")
    };
    format!(
        "{system_prompt}\n\n\
         User request:\n\n\
         {message}\n\n\
         <backboard_ide_context>\n\
         runtime: native-rust\n\
         mode: {mode}\n\
         workspace: {}\n\
         selected_skills: {selected_skills}\n\
         {context}\n\
         </backboard_ide_context>",
        workspace.display()
    )
}

fn workspace_context(workspace: &Path) -> String {
    let Ok(entries) = fs::read_dir(workspace) else {
        return "workspace_state: unavailable\nworkspace_files: unavailable".to_string();
    };
    let mut names = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            is_user_visible_workspace_entry(entry.file_name().to_string_lossy().as_ref())
        })
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
    if names.is_empty() {
        "workspace_state: empty\nworkspace_files: empty".to_string()
    } else {
        format!(
            "workspace_state: non_empty\nworkspace_files: {}",
            names.join(", ")
        )
    }
}

fn is_user_visible_workspace_entry(name: &str) -> bool {
    !matches!(
        name,
        ".backboard" | ".backboard_index" | ".git" | ".DS_Store"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_context_reports_empty_when_only_backboard_artifacts_exist() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join(".backboard").join("scratchpad")).unwrap();
        fs::create_dir_all(workspace.join(".backboard_index")).unwrap();

        let context = workspace_context(workspace);

        assert!(context.contains("workspace_state: empty"));
        assert!(context.contains("workspace_files: empty"));
    }

    #[test]
    fn workspace_context_reports_user_visible_files() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join(".backboard")).unwrap();
        fs::write(workspace.join("index.html"), "<main></main>").unwrap();

        let context = workspace_context(workspace);

        assert!(context.contains("workspace_state: non_empty"));
        assert!(context.contains("workspace_files: index.html"));
        assert!(!context.contains(".backboard"));
    }

    #[test]
    fn system_prompt_requires_confirmation_for_similar_prior_projects() {
        let tempdir = tempfile::tempdir().unwrap();
        let prompt = system_prompt(tempdir.path());

        assert!(prompt.contains("ask for confirmation before recreating"));
        assert!(prompt.contains("explicitly says to recreate, adapt, or build a new copy"));
    }

    #[test]
    fn augmented_prompt_includes_native_tool_policy() {
        let tempdir = tempfile::tempdir().unwrap();
        let prompt = augment_prompt("Build a todo app", tempdir.path(), "free", &[]);

        assert!(prompt.contains("You are Backboard, an autonomous software engineering agent"));
        assert!(prompt.contains("Native tool calls:"));
        assert!(prompt.contains("User request:\n\nBuild a todo app"));
        assert!(prompt.contains("<backboard_ide_context>"));
    }
}
