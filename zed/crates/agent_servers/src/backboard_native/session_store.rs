use std::{
    fs,
    path::{Path, PathBuf},
};

use agent_client_protocol::schema as acp;
use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SessionRecord {
    pub workspace: String,
    pub assistant_id: Option<String>,
    pub thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub title: String,
    pub session_id: String,
    pub updated_at: String,
}

pub fn record_for_session_or_workspace(
    session_id: &acp::SessionId,
    workspace: &Path,
) -> Option<SessionRecord> {
    let store = load_session_store().ok()?;
    let session_key = session_id.to_string();
    if let Some(record) = store.get(&session_key).and_then(record_from_value) {
        log::debug!(
            "Loaded Backboard IDE session record: source=session session_id={} workspace={}",
            session_id,
            workspace.display()
        );
        return Some(record);
    }

    let workspace_key = workspace_store_key(workspace);
    if let Some(record) = store.get(&workspace_key).and_then(record_from_value) {
        log::debug!(
            "Loaded Backboard IDE session record: source=workspace session_id={} workspace={}",
            session_id,
            workspace.display()
        );
        return Some(record);
    }

    let record = latest_legacy_record_for_workspace(&store, workspace);
    if record.is_some() {
        log::debug!(
            "Loaded Backboard IDE session record: source=legacy session_id={} workspace={}",
            session_id,
            workspace.display()
        );
    } else {
        log::debug!(
            "No Backboard IDE session record found: session_id={} workspace={}",
            session_id,
            workspace.display()
        );
    }
    record
}

pub fn workspace_records(workspace: Option<&Path>) -> Vec<SessionRecord> {
    let Ok(store) = load_session_store() else {
        return Vec::new();
    };
    let mut records = Vec::new();
    let mut seen_threads = std::collections::HashSet::new();
    for value in store.values() {
        let Some(record) = record_from_value(value) else {
            continue;
        };
        if let Some(workspace) = workspace {
            let Ok(record_workspace) = PathBuf::from(&record.workspace).canonicalize() else {
                continue;
            };
            let Ok(workspace) = workspace.canonicalize() else {
                continue;
            };
            if record_workspace != workspace {
                continue;
            }
        }
        if let Some(thread_id) = &record.thread_id
            && !seen_threads.insert(thread_id.clone())
        {
            continue;
        }
        records.push(record);
    }
    records.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    log::debug!(
        "Loaded Backboard IDE workspace session records: workspace={} count={}",
        workspace
            .map(|workspace| workspace.display().to_string())
            .unwrap_or_else(|| "all".to_string()),
        records.len()
    );
    records
}

pub fn write_session_record(session_id: &str, record: &SessionRecord) -> Result<()> {
    write_record(session_id, record)
}

pub fn write_workspace_record(workspace: &Path, record: &SessionRecord) -> Result<()> {
    write_record(&workspace_store_key(workspace), record)
}

fn write_record(key: &str, record: &SessionRecord) -> Result<()> {
    let path = session_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut store = load_session_store().unwrap_or_default();
    store.insert(key.to_string(), serde_json::to_value(record)?);
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("ide_sessions.json"),
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&tmp, serde_json::to_vec_pretty(&store)?)?;
    fs::rename(tmp, path)?;
    log::debug!(
        "Wrote Backboard IDE session record: key={} session_id={} workspace={}",
        key,
        record.session_id,
        record.workspace
    );
    Ok(())
}

fn load_session_store() -> Result<serde_json::Map<String, Value>> {
    let path = session_store_path()?;
    if !path.exists() {
        return Ok(Default::default());
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("reading Backboard IDE session store at {}", path.display()))?;
    serde_json::from_str(&text)
        .with_context(|| format!("parsing Backboard IDE session store at {}", path.display()))
}

fn record_from_value(value: &Value) -> Option<SessionRecord> {
    serde_json::from_value(value.clone()).ok()
}

fn latest_legacy_record_for_workspace(
    store: &serde_json::Map<String, Value>,
    workspace: &Path,
) -> Option<SessionRecord> {
    let workspace = workspace.canonicalize().ok()?;
    store
        .iter()
        .filter(|(key, _)| key.starts_with("backboard-"))
        .filter_map(|(_, value)| record_from_value(value))
        .filter(|record| {
            PathBuf::from(&record.workspace)
                .canonicalize()
                .is_ok_and(|path| path == workspace)
        })
        .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
}

fn workspace_store_key(workspace: &Path) -> String {
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    format!("workspace::{}", workspace.display())
}

fn session_store_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join(".backboard")
        .join("ide_sessions.json"))
}
