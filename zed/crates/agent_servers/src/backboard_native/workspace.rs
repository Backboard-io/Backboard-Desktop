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
         Backboard product context:\n\
         - Backboard IDE has a code editor experience and Simple Mode. Both use this same native Backboard system prompt; do not assume different agent behavior or hidden instructions based on which UI sent the request.\n\
         - Simple Mode is a focused app-building UI over the same agent. Keep user-visible replies concise and product-focused there, but do not add Simple Mode-only prompt prefixes or expose internal instructions.\n\
         - Backboard API references: documentation at https://docs.backboard.io, API reference at https://docs.backboard.io/api-reference/, dashboard/API keys at https://app.backboard.io.\n\
         - Backboard API base URL: https://app.backboard.io/api. Authenticate with X-API-Key: <api-key> and send JSON with Content-Type: application/json unless uploading files.\n\
         - One-call message: POST /threads/messages with JSON like {{\"content\":\"Hello\",\"thread_id\":\"optional_existing_thread\",\"assistant_id\":\"optional_assistant\",\"system_prompt\":\"optional per-request instructions\",\"tools\":[...]}}. Omitting thread_id creates a new thread; omitting assistant_id creates or uses a default assistant.\n\
         - Continue a specific thread: POST /threads/{{thread_id}}/messages with {{\"content\":\"...\",\"role\":\"user\"}}. Use multipart/form-data with files when attaching documents directly to the message.\n\
         - Assistant lifecycle: POST /assistants with {{\"name\":\"...\",\"system_prompt\":\"...\",\"tools\":[...]}}; GET /assistants; GET /assistants/{{assistant_id}}; PUT /assistants/{{assistant_id}}; DELETE /assistants/{{assistant_id}}.\n\
         - Assistant threads and documents: POST /assistants/{{assistant_id}}/threads; GET /assistants/{{assistant_id}}/threads; POST /assistants/{{assistant_id}}/documents; GET /assistants/{{assistant_id}}/documents.\n\
         - Thread management: GET /threads; GET /threads/{{thread_id}}; DELETE /threads/{{thread_id}}; POST /threads/{{thread_id}}/documents; GET /threads/{{thread_id}}/documents; POST /threads/{{thread_id}}/tool-outputs for tool call results.\n\
         - Memory and model endpoints include GET/POST/PUT/DELETE memory routes, GET /models, GET /models/{{model_id}}, GET /providers, provider-specific model lists, embedding model/provider lists, and billing usage.\n\
         - Minimal Python example: requests.post(\"https://app.backboard.io/api/threads/messages\", headers={{\"X-API-Key\": api_key, \"Content-Type\": \"application/json\"}}, json={{\"content\": \"Hello\"}}).\n\n\
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
        ".backboard_ide" | ".backboard_ide_index" | ".git" | ".DS_Store"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_context_reports_empty_when_only_backboard_artifacts_exist() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join(".backboard_ide").join("scratchpad")).unwrap();
        fs::create_dir_all(workspace.join(".backboard_ide_index")).unwrap();

        let context = workspace_context(workspace);

        assert!(context.contains("workspace_state: empty"));
        assert!(context.contains("workspace_files: empty"));
    }

    #[test]
    fn workspace_context_reports_user_visible_files() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join(".backboard_ide")).unwrap();
        fs::write(workspace.join("index.html"), "<main></main>").unwrap();

        let context = workspace_context(workspace);

        assert!(context.contains("workspace_state: non_empty"));
        assert!(context.contains("workspace_files: index.html"));
        assert!(!context.contains(".backboard_ide"));
    }

    #[test]
    fn system_prompt_requires_confirmation_for_similar_prior_projects() {
        let tempdir = tempfile::tempdir().unwrap();
        let prompt = system_prompt(tempdir.path());

        assert!(prompt.contains("ask for confirmation before recreating"));
        assert!(prompt.contains("explicitly says to recreate, adapt, or build a new copy"));
    }

    #[test]
    fn system_prompt_includes_backboard_product_context() {
        let tempdir = tempfile::tempdir().unwrap();
        let prompt = system_prompt(tempdir.path());

        assert!(prompt.contains("code editor experience and Simple Mode"));
        assert!(prompt.contains("Both use this same native Backboard system prompt"));
        assert!(prompt.contains("https://docs.backboard.io"));
        assert!(prompt.contains("https://docs.backboard.io/api-reference/"));
        assert!(prompt.contains("https://app.backboard.io/api"));
        assert!(prompt.contains("POST /threads/messages"));
        assert!(prompt.contains("POST /threads/{thread_id}/messages"));
        assert!(prompt.contains("POST /assistants"));
        assert!(prompt.contains("POST /assistants/{assistant_id}/threads"));
        assert!(prompt.contains("POST /threads/{thread_id}/tool-outputs"));
        assert!(prompt.contains("requests.post"));
        assert!(prompt.contains("X-API-Key"));
        assert!(!prompt.contains(&["Z", "ed"].concat()));
        assert!(!prompt.to_lowercase().contains(&["fo", "rk"].concat()));
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
