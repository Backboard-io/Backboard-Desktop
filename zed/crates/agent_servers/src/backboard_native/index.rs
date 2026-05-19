use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use walkdir::WalkDir;

const MAX_INDEXED_FILE_BYTES: u64 = 200_000;
const MAX_BLOCK_CONTENT_CHARS: usize = 5_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CodebaseIndex {
    pub blocks: Vec<CodeBlock>,
    pub file_count: usize,
    pub block_count: usize,
    pub ruvector_enabled: bool,
    pub indexed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CodeBlock {
    pub id: String,
    pub file_path: String,
    pub language: String,
    pub block_type: String,
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    pub docstring: String,
    pub signature: String,
    pub metadata: BTreeMap<String, Value>,
}

pub(crate) fn workspace_key(workspace: &Path) -> PathBuf {
    workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf())
}

pub(crate) fn prepare_workspace(workspace: &Path) -> Result<()> {
    fs::create_dir_all(workspace.join(".backboard").join("scratchpad")).with_context(|| {
        format!(
            "creating Backboard workspace state in {}",
            workspace.display()
        )
    })
}

pub(crate) fn build_workspace_index(workspace: &Path) -> Result<CodebaseIndex> {
    let index_dir = workspace.join(".backboard_index");
    fs::create_dir_all(&index_dir)
        .with_context(|| format!("creating Backboard index cache in {}", index_dir.display()))?;

    let mut blocks = Vec::new();
    let mut file_count = 0;
    for entry in WalkDir::new(workspace)
        .into_iter()
        .filter_entry(should_enter)
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !should_index_file(path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > MAX_INDEXED_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        file_count += 1;
        blocks.push(file_level_block(workspace, path, &content, metadata.len()));
    }

    let index = CodebaseIndex {
        file_count,
        block_count: blocks.len(),
        blocks,
        ruvector_enabled: false,
        indexed_at: workspace.display().to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&index)?;
    let index_file = index_path(workspace);
    let tmp = index_file.with_file_name(format!(
        ".{}.{}.tmp",
        index_file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("codebase_index.json"),
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, index_file)?;
    Ok(index)
}

pub(crate) fn search_index(
    workspace: &Path,
    query: &str,
    limit: usize,
) -> Result<Option<Vec<Value>>> {
    let index = load_index(workspace)?;
    if index.blocks.is_empty() {
        return Ok(None);
    }
    let terms = search_terms(query);
    if terms.is_empty() {
        return Ok(Some(Vec::new()));
    }

    let mut hits = Vec::new();
    for block in index.blocks {
        let haystack = format!(
            "{}\n{}\n{}\n{}\n{}",
            block.file_path, block.name, block.signature, block.docstring, block.content
        )
        .to_lowercase();
        let mut score = terms
            .iter()
            .filter(|term| haystack.contains(term.as_str()))
            .count();
        if score == 0 {
            continue;
        }
        let path_lower = block.file_path.to_lowercase();
        for term in &terms {
            if path_lower.contains(term) {
                score += 2;
            }
            if block.name.to_lowercase().contains(term) {
                score += 3;
            }
        }
        hits.push((
            score,
            json!({
                "path": workspace.join(&block.file_path),
                "score": score,
                "preview": truncate(&block.content, 4000),
            }),
        ));
    }

    hits.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(Some(
        hits.into_iter().take(limit).map(|(_, hit)| hit).collect(),
    ))
}

fn load_index(workspace: &Path) -> Result<CodebaseIndex> {
    let path = index_path(workspace);
    let text = fs::read_to_string(&path)
        .with_context(|| format!("reading Backboard codebase index at {}", path.display()))?;
    serde_json::from_str(&text)
        .with_context(|| format!("parsing Backboard codebase index at {}", path.display()))
}

fn index_path(workspace: &Path) -> PathBuf {
    workspace
        .join(".backboard_index")
        .join("codebase_index.json")
}

fn file_level_block(workspace: &Path, path: &Path, content: &str, file_size: u64) -> CodeBlock {
    let relative_path = path
        .strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let line_count = content.lines().count().max(1);
    let language = language_for_path(path).to_string();
    let mut metadata = BTreeMap::new();
    metadata.insert("is_file_level".to_string(), json!(true));
    metadata.insert("full_path".to_string(), json!(path));
    metadata.insert("size".to_string(), json!(file_size));

    CodeBlock {
        id: format!(
            "file_{}",
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, relative_path.as_bytes()).simple()
        ),
        file_path: relative_path,
        language,
        block_type: "file".to_string(),
        name: name.clone(),
        start_line: 1,
        end_line: line_count,
        content: truncate(content, MAX_BLOCK_CONTENT_CHARS),
        docstring: file_summary(content),
        signature: format!("File: {name}"),
        metadata,
    }
}

fn file_summary(content: &str) -> String {
    let summary = content
        .lines()
        .take(50)
        .filter_map(|line| {
            let stripped = line.trim();
            if [
                "import ", "from ", "const ", "let ", "var ", "package ", "use ",
            ]
            .iter()
            .any(|prefix| stripped.starts_with(prefix))
            {
                Some(stripped)
            } else {
                None
            }
        })
        .take(20)
        .collect::<Vec<_>>()
        .join("\n");
    if summary.is_empty() {
        truncate(content, 500)
    } else {
        summary
    }
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .filter(|term| term.len() > 2)
        .collect()
}

fn should_enter(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    !(entry.file_type().is_dir()
        && matches!(
            name.as_ref(),
            ".git"
                | ".backboard"
                | ".backboard_index"
                | "node_modules"
                | "dist"
                | "build"
                | "target"
                | ".next"
                | ".nuxt"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".tox"
                | ".mypy_cache"
                | ".pytest_cache"
                | ".ruff_cache"
                | ".svelte-kit"
                | "coverage"
                | "vendor"
        ))
}

fn should_index_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_lowercase().as_str(),
                "rs" | "py"
                    | "js"
                    | "jsx"
                    | "ts"
                    | "tsx"
                    | "go"
                    | "java"
                    | "kt"
                    | "kts"
                    | "c"
                    | "h"
                    | "cc"
                    | "cpp"
                    | "cxx"
                    | "hpp"
                    | "cs"
                    | "php"
                    | "rb"
                    | "swift"
                    | "scala"
                    | "sh"
                    | "bash"
                    | "zsh"
                    | "fish"
                    | "sql"
                    | "html"
                    | "css"
                    | "scss"
                    | "sass"
                    | "vue"
                    | "svelte"
                    | "json"
                    | "toml"
                    | "yaml"
                    | "yml"
                    | "md"
                    | "txt"
                    | "xml"
                    | "proto"
                    | "graphql"
                    | "gql"
            )
        })
        .unwrap_or(false)
}

fn language_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "rs" => "rust",
        "py" => "python",
        "js" | "jsx" => "javascript",
        "ts" | "tsx" => "typescript",
        "go" => "go",
        "java" => "java",
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "html" => "html",
        "css" | "scss" | "sass" => "css",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" => "markdown",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        _ => "text",
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n...[truncated]");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_workspace_and_writes_cli_compatible_index() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            workspace.join("src/main.rs"),
            "use std::fmt;\nfn backboard_marker() {}\n",
        )
        .unwrap();

        prepare_workspace(workspace).unwrap();
        let index = build_workspace_index(workspace).unwrap();

        assert!(workspace.join(".backboard").join("scratchpad").is_dir());
        assert!(
            workspace
                .join(".backboard_index/codebase_index.json")
                .is_file()
        );
        assert_eq!(index.file_count, 1);
        assert_eq!(index.block_count, 1);
        assert!(!index.ruvector_enabled);
        assert_eq!(index.blocks[0].file_path, "src/main.rs");
        assert_eq!(index.blocks[0].block_type, "file");
    }

    #[test]
    fn index_skips_backboard_and_heavy_directories() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::create_dir_all(workspace.join(".backboard")).unwrap();
        fs::create_dir_all(workspace.join(".backboard_index")).unwrap();
        fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(workspace.join("target/debug")).unwrap();
        fs::write(workspace.join("src/app.ts"), "export const unique_app = 1;").unwrap();
        fs::write(workspace.join(".backboard/hidden.ts"), "hidden_backboard").unwrap();
        fs::write(
            workspace.join(".backboard_index/hidden.ts"),
            "hidden_backboard_index",
        )
        .unwrap();
        fs::write(workspace.join("node_modules/pkg/index.js"), "hidden_node").unwrap();
        fs::write(workspace.join("target/debug/main.rs"), "hidden_target").unwrap();

        let index = build_workspace_index(workspace).unwrap();
        let paths = index
            .blocks
            .iter()
            .map(|block| block.file_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src/app.ts"]);
    }

    #[test]
    fn search_index_returns_ranked_matches() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            workspace.join("src/search.rs"),
            "fn needle_function() { let needle_value = true; }",
        )
        .unwrap();
        build_workspace_index(workspace).unwrap();

        let hits = search_index(workspace, "needle function", 5)
            .unwrap()
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert!(
            hits[0]
                .get("preview")
                .and_then(Value::as_str)
                .unwrap()
                .contains("needle_function")
        );
    }
}
