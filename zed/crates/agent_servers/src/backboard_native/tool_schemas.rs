use serde_json::{Value, json};

pub fn tool_definitions(mode: &str) -> Vec<Value> {
    let blocked = blocked_tools(mode);
    all_tool_definitions()
        .into_iter()
        .filter(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .is_none_or(|name| !blocked.contains(&name))
        })
        .collect()
}

pub fn read_only_task_tool_definitions() -> Vec<Value> {
    const READ_ONLY_TASK_TOOLS: &[&str] = &[
        "read_file",
        "glob",
        "grep",
        "codebase_search",
        "list_dir",
        "web_search",
        "web_fetch",
        "read_lints",
    ];
    all_tool_definitions()
        .into_iter()
        .filter(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .is_some_and(|name| READ_ONLY_TASK_TOOLS.contains(&name))
        })
        .collect()
}

fn blocked_tools(mode: &str) -> &'static [&'static str] {
    match mode {
        "ask" => &[
            "write",
            "edit",
            "search_replace",
            "delete_file",
            "create_directory",
            "bash",
            "run_terminal_cmd",
            "run_code",
            "repl",
            "computer",
            "task",
        ],
        "manual" => &[
            "bash",
            "run_terminal_cmd",
            "run_code",
            "repl",
            "computer",
            "task",
        ],
        _ => &[],
    }
}

fn all_tool_definitions() -> Vec<Value> {
    vec![
        function(
            "bash",
            "Execute a shell command. Do not use for file operations; use read_file, edit, write, grep, or glob instead. Fresh shell each call. Use working_directory for specific dirs. Set is_background=true for long-running processes.",
            json!({
                "command": {"type": "string", "description": "The shell command to execute"},
                "description": {"type": "string", "description": "Short description of what this command does"},
                "timeout": {"type": "integer", "description": "Timeout in milliseconds"},
                "working_directory": {"type": "string", "description": "Directory to run the command in. Defaults to workspace root."},
                "is_background": {"type": "boolean", "description": "Accepted for compatibility; native runtime starts the process without persisting output"}
            }),
            &["command"],
        ),
        function(
            "run_terminal_cmd",
            "Execute a shell command and render output in an IDE terminal card. Prefer read_file, edit, write, grep, or glob for file operations.",
            json!({
                "command": {"type": "string", "description": "The shell command to execute"},
                "cmd": {"type": "string", "description": "Alias for command"},
                "description": {"type": "string", "description": "Short description of what this command does"},
                "timeout": {"type": "integer", "description": "Timeout in milliseconds"},
                "working_directory": {"type": "string", "description": "Directory to run the command in. Defaults to workspace root."},
                "cwd": {"type": "string", "description": "Alias for working_directory"},
                "is_background": {"type": "boolean", "description": "Run as a background process and return startup status without persisted logs"}
            }),
            &["command"],
        ),
        function(
            "read_file",
            "Read a file. Use target_file or file_path. Supports offset and limit line ranges.",
            json!({
                "target_file": {"type": "string", "description": "Path to file, relative to workspace or absolute"},
                "file_path": {"type": "string", "description": "Alias for target_file"},
                "offset": {"type": "integer", "description": "Starting line number, 1-indexed"},
                "limit": {"type": "integer", "description": "Number of lines to read"}
            }),
            &["target_file"],
        ),
        function(
            "write",
            "Write a complete file. Prefer edit for existing files.",
            json!({
                "file_path": {"type": "string", "description": "Path to file"},
                "contents": {"type": "string", "description": "Complete file contents"}
            }),
            &["file_path", "contents"],
        ),
        function(
            "edit",
            "Perform exact string replacement in a file.",
            json!({
                "file_path": {"type": "string", "description": "Path to file"},
                "old_string": {"type": "string", "description": "Exact text to replace"},
                "new_string": {"type": "string", "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences"}
            }),
            &["file_path", "old_string", "new_string"],
        ),
        function(
            "search_replace",
            "Replace text in a file. Use old_string and new_string. Set replace_all=true only when every occurrence should change.",
            json!({
                "file_path": {"type": "string", "description": "Path to file"},
                "target_file": {"type": "string", "description": "Alias for file_path"},
                "old_string": {"type": "string", "description": "Exact text to replace"},
                "new_string": {"type": "string", "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences"}
            }),
            &["file_path", "old_string", "new_string"],
        ),
        function(
            "glob",
            "Find files by glob pattern, sorted by modification time.",
            json!({
                "pattern": {"type": "string", "description": "Glob pattern such as **/*.rs or src/**/*.ts"},
                "target_directory": {"type": "string", "description": "Directory to search, defaults to workspace root"}
            }),
            &["pattern"],
        ),
        function(
            "grep",
            "Search file contents using regular expressions.",
            json!({
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "File or directory to search, defaults to workspace root"},
                "glob": {"type": "string", "description": "Glob filter for files"},
                "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
                "case_insensitive": {"type": "boolean"},
                "context_lines": {"type": "integer"},
                "multiline": {"type": "boolean"}
            }),
            &["pattern"],
        ),
        function(
            "codebase_search",
            "Search the workspace codebase semantically when the native index is available, with lexical fallback.",
            json!({
                "query": {"type": "string", "description": "Natural-language or keyword query"},
                "num_results": {"type": "integer", "description": "Maximum results to return, 1-15"}
            }),
            &["query"],
        ),
        function(
            "list_dir",
            "List directory contents with file types and sizes.",
            json!({
                "target_directory": {"type": "string", "description": "Directory path, relative to workspace or absolute"}
            }),
            &["target_directory"],
        ),
        function(
            "delete_file",
            "Delete a file or directory.",
            json!({
                "target_file": {"type": "string", "description": "Path to delete"},
                "file_path": {"type": "string", "description": "Alias for target_file"}
            }),
            &["target_file"],
        ),
        function(
            "create_directory",
            "Create a directory and any missing parent directories.",
            json!({
                "path": {"type": "string", "description": "Directory path, relative to workspace or absolute"},
                "target_directory": {"type": "string", "description": "Alias for path"}
            }),
            &["path"],
        ),
        function(
            "web_search",
            "Search the web for real-time information. Returns summarized results and URLs.",
            json!({
                "query": {"type": "string", "description": "The search query. Be specific and include version numbers or dates if relevant."}
            }),
            &["query"],
        ),
        function(
            "web_fetch",
            "Fetch URL content as readable text. Read-only, no binary support.",
            json!({
                "url": {"type": "string", "description": "The full URL to fetch"}
            }),
            &["url"],
        ),
        function(
            "todo_write",
            "Create or update a structured task plan.",
            json!({
                "merge": {"type": "boolean"},
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "content": {"type": "string"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]}
                        },
                        "required": ["id", "content", "status"]
                    }
                }
            }),
            &["merge", "todos"],
        ),
        function(
            "read_lints",
            "Check files for linter errors. Native runtime returns a lightweight status for now.",
            json!({
                "paths": {"type": "array", "items": {"type": "string"}}
            }),
            &[],
        ),
        function(
            "task",
            "Launch a focused read/search sub-agent task for parallel analysis. Use for broad repo questions, investigation, or independent research. The parent agent remains responsible for file edits.",
            json!({
                "prompt": {"type": "string"},
                "description": {"type": "string"}
            }),
            &["prompt", "description"],
        ),
        function(
            "enter_plan_mode",
            "Enter read-only plan mode. Only use when the user explicitly requests planning.",
            json!({
                "reason": {"type": "string"}
            }),
            &["reason"],
        ),
        function(
            "exit_plan_mode",
            "Exit plan mode and present an implementation plan for user approval.",
            json!({
                "plan": {"type": "string"}
            }),
            &["plan"],
        ),
        function(
            "persistence_decide",
            "Persistence-gate decision tool. Only valid for persistence-armed prompts.",
            json!({
                "action": {"type": "string", "enum": ["continue", "done"]},
                "reason": {"type": "string"},
                "focus": {"type": "string"}
            }),
            &["action", "reason"],
        ),
        function(
            "sleep",
            "Wait for specified seconds without holding a shell process. User can interrupt.",
            json!({
                "seconds": {"type": "integer", "description": "Duration to sleep in seconds"}
            }),
            &["seconds"],
        ),
        function(
            "repl",
            "Persistent Python REPL. Native Rust currently runs this as a one-off Python snippet until the persistent REPL is ported.",
            json!({
                "code": {"type": "string"},
                "reset": {"type": "boolean"}
            }),
            &["code"],
        ),
        function(
            "run_code",
            "Execute a one-off code snippet. Supports Python and Shell in the native runtime.",
            json!({
                "code": {"type": "string"},
                "language": {"type": "string", "enum": ["python", "node", "typescript", "shell", "ruby", "go"]},
                "timeout": {"type": "integer"},
                "description": {"type": "string"}
            }),
            &["code"],
        ),
        function(
            "computer",
            "Desktop automation. Native Rust currently reports this as unavailable until desktop automation is ported.",
            json!({
                "action": {"type": "string"},
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "text": {"type": "string"},
                "key": {"type": "string"}
            }),
            &["action"],
        ),
        function(
            "ask_user_question",
            "Ask the user for required input that cannot be inferred.",
            json!({
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
                "allow_multiple": {"type": "boolean"}
            }),
            &["question"],
        ),
    ]
}

pub fn function_with_parameters(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

fn function(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    function_with_parameters(
        name,
        description,
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_names(mode: &str) -> Vec<String> {
        tool_definitions(mode)
            .into_iter()
            .filter_map(|tool| {
                tool.get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    }

    #[test]
    fn ask_mode_hides_mutating_tools() {
        let names = tool_names("ask");

        assert!(names.contains(&"read_file".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"search_replace".to_string()));
        assert!(!names.contains(&"create_directory".to_string()));
        assert!(!names.contains(&"bash".to_string()));
        assert!(!names.contains(&"run_terminal_cmd".to_string()));
        assert!(!names.contains(&"task".to_string()));
    }

    #[test]
    fn full_access_advertises_task_tool() {
        for mode in ["agent", "free"] {
            let names = tool_names(mode);

            assert!(names.contains(&"read_file".to_string()));
            assert!(names.contains(&"task".to_string()));
        }
    }

    #[test]
    fn ask_and_manual_hide_task_tool() {
        for mode in ["ask", "manual"] {
            let names = tool_names(mode);

            assert!(names.contains(&"read_file".to_string()));
            assert!(!names.contains(&"task".to_string()));
        }
    }

    #[test]
    fn task_subagents_receive_read_only_tool_schema() {
        let names = read_only_task_tool_definitions()
            .into_iter()
            .filter_map(|tool| {
                tool.get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();

        assert!(names.contains(&"read_file".to_string()));
        assert!(names.contains(&"grep".to_string()));
        assert!(names.contains(&"codebase_search".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"task".to_string()));
    }

    #[test]
    fn full_access_advertises_supported_native_tools() {
        let names = tool_names("free");

        assert_eq!(
            names,
            vec![
                "bash",
                "run_terminal_cmd",
                "read_file",
                "write",
                "edit",
                "search_replace",
                "glob",
                "grep",
                "codebase_search",
                "list_dir",
                "delete_file",
                "create_directory",
                "web_search",
                "web_fetch",
                "todo_write",
                "read_lints",
                "task",
                "enter_plan_mode",
                "exit_plan_mode",
                "persistence_decide",
                "sleep",
                "repl",
                "run_code",
                "computer",
                "ask_user_question",
            ]
        );
    }
}
