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
        ],
        "manual" => &["bash", "run_terminal_cmd"],
        _ => &[],
    }
}

fn all_tool_definitions() -> Vec<Value> {
    vec![
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
            "list_dir",
            "List directory contents with file types and sizes.",
            json!({
                "target_directory": {"type": "string", "description": "Directory path, relative to workspace or absolute"}
            }),
            &["target_directory"],
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
            "Search workspace code by natural-language query. The native IDE runtime uses a fast local lexical fallback.",
            json!({
                "query": {"type": "string", "description": "Natural language search query"},
                "target_directories": {"type": "array", "items": {"type": "string"}},
                "num_results": {"type": "integer"}
            }),
            &["query"],
        ),
        function(
            "read_lints",
            "Read diagnostics/lints for paths. The native runtime returns a lightweight status for now.",
            json!({
                "paths": {"type": "array", "items": {"type": "string"}}
            }),
            &[],
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
            "Alias for edit. Replace exact text in a file.",
            json!({
                "file_path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"}
            }),
            &["file_path", "old_string", "new_string"],
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
                "path": {"type": "string", "description": "Directory path"},
                "target_directory": {"type": "string", "description": "Alias for path"}
            }),
            &["path"],
        ),
        function(
            "bash",
            "Run a shell command in the workspace. Read-only commands auto-run; mutating commands require approval unless in Free mode.",
            json!({
                "command": {"type": "string", "description": "Shell command to execute"},
                "description": {"type": "string", "description": "Short description"},
                "timeout": {"type": "integer", "description": "Timeout in milliseconds"},
                "working_directory": {"type": "string", "description": "Working directory"},
                "is_background": {"type": "boolean", "description": "Accepted for compatibility; native runtime captures bounded output"}
            }),
            &["command"],
        ),
        function(
            "run_terminal_cmd",
            "Alias for bash.",
            json!({
                "command": {"type": "string"},
                "timeout": {"type": "integer"},
                "working_directory": {"type": "string"}
            }),
            &["command"],
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
    ]
}

fn function(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_mode_hides_mutating_tools() {
        let names = tool_definitions("ask")
            .into_iter()
            .filter_map(|tool| {
                tool.get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();

        assert!(names.contains(&"read_file".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"bash".to_string()));
    }
}
