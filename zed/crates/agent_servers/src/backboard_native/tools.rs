use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    rc::Rc,
    thread,
    time::{Duration, Instant},
};

use acp_thread::{
    AuthorizationKind, PermissionOptions, RequestPermissionOutcome, TerminalProviderEvent,
};
use agent_client_protocol::schema as acp;
use anyhow::{Context as _, Result, anyhow, bail};
use futures::future::join_all;
use globset::{Glob, GlobSetBuilder};
use gpui::{AppContext as _, AsyncApp};
use regex::RegexBuilder;
use serde_json::{Value, json};
use terminal::TerminalBuilder;
use terminal::terminal_settings::{AlternateScroll, CursorShape};
use walkdir::WalkDir;

use super::{BackboardNativeState, SessionRuntime};

const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_SEARCH_RESULTS: usize = 120;
const MAX_OUTPUT_CHARS: usize = 16_000;

#[derive(Clone, Debug)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub args: Value,
}

pub async fn execute_tool_batch(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    tool_calls: Vec<Value>,
    cx: &mut AsyncApp,
) -> Result<Vec<Value>> {
    let calls = tool_calls
        .into_iter()
        .map(parse_tool_call)
        .collect::<Result<Vec<_>>>()?;
    let mut outputs = Vec::with_capacity(calls.len());
    let mut index = 0;

    while index < calls.len() {
        if is_parallel_read_only(&calls[index]) {
            let start = index;
            while index < calls.len() && is_parallel_read_only(&calls[index]) {
                index += 1;
            }
            let group = &calls[start..index];
            if group.len() > 1 {
                emit_progress(
                    state.clone(),
                    runtime,
                    format!(
                        "Backboard is running {} read/search actions in parallel.",
                        group.len()
                    ),
                    cx,
                )?;
                let tasks = group.iter().cloned().map({
                    let runtime = runtime.clone();
                    move |call| {
                        let runtime = runtime.clone();
                        async move {
                            let output = execute_read_only_tool(&runtime.workspace, &call).await;
                            (call, output)
                        }
                    }
                });
                for (call, output) in join_all(tasks).await {
                    let output = output
                        .unwrap_or_else(|err| json!({"success": false, "error": err.to_string()}));
                    emit_tool_result(state.clone(), runtime, &call, &output, cx)?;
                    outputs.push(tool_output_payload(&call, output));
                }
            } else {
                let call = group[0].clone();
                let output = execute_tool_call(state.clone(), runtime, call.clone(), cx).await;
                outputs.push(tool_output_payload(
                    &call,
                    output
                        .unwrap_or_else(|err| json!({"success": false, "error": err.to_string()})),
                ));
            }
        } else {
            let call = calls[index].clone();
            index += 1;
            let output = execute_tool_call(state.clone(), runtime, call.clone(), cx).await;
            outputs.push(tool_output_payload(
                &call,
                output.unwrap_or_else(|err| json!({"success": false, "error": err.to_string()})),
            ));
        }

        if runtime
            .cancel_flag
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            break;
        }
    }

    Ok(outputs)
}

pub fn parse_tool_call(value: Value) -> Result<ToolCallRequest> {
    let id = value
        .get("id")
        .or_else(|| value.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("tool-{}", uuid::Uuid::new_v4().simple()));
    let function = value
        .get("function")
        .and_then(Value::as_object)
        .context("tool call did not include a function object")?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .context("tool call function did not include a name")?
        .to_string();
    let args = match function.get("arguments") {
        Some(Value::String(text)) if !text.trim().is_empty() => serde_json::from_str(text)
            .with_context(|| format!("parsing arguments for tool `{name}`"))?,
        Some(value) => value.clone(),
        None => json!({}),
    };

    Ok(ToolCallRequest { id, name, args })
}

fn is_parallel_read_only(call: &ToolCallRequest) -> bool {
    matches!(
        call.name.as_str(),
        "read_file" | "list_dir" | "glob" | "grep" | "codebase_search" | "read_lints"
    )
}

async fn execute_tool_call(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    emit_progress(
        state.clone(),
        runtime,
        format!("Backboard is running `{}`.", call.name),
        cx,
    )?;

    if runtime.mode.to_string() == "ask" && is_mutating_tool(&call.name) {
        let output =
            json!({"success": false, "error": format!("{} is disabled in Ask mode.", call.name)});
        emit_tool_result(state, runtime, &call, &output, cx)?;
        return Ok(output);
    }
    if runtime.mode.to_string() == "manual" && is_shell_tool(&call.name) {
        let output = json!({"success": false, "error": format!("{} is disabled in Manual mode.", call.name)});
        emit_tool_result(state, runtime, &call, &output, cx)?;
        return Ok(output);
    }

    match call.name.as_str() {
        "read_file" | "list_dir" | "glob" | "grep" | "codebase_search" | "read_lints" => {
            let output = execute_read_only_tool(&runtime.workspace, &call).await?;
            emit_tool_result(state, runtime, &call, &output, cx)?;
            Ok(output)
        }
        "write" | "edit" | "search_replace" | "delete_file" => {
            execute_file_mutation(state, runtime, &call, cx).await
        }
        "create_directory" => execute_create_directory(state, runtime, &call, cx).await,
        "bash" | "run_terminal_cmd" => execute_shell_tool(state, runtime, &call, cx).await,
        "todo_write" => execute_todo_write(state, runtime, &call, cx),
        _ => {
            let output = json!({"success": false, "error": format!("Unsupported native Backboard IDE tool `{}`.", call.name)});
            emit_tool_result(state, runtime, &call, &output, cx)?;
            Ok(output)
        }
    }
}

async fn execute_read_only_tool(workspace: &Path, call: &ToolCallRequest) -> Result<Value> {
    match call.name.as_str() {
        "read_file" => read_file(workspace, &call.args),
        "list_dir" => list_dir(workspace, &call.args),
        "glob" => glob_files(workspace, &call.args),
        "grep" => grep_files(workspace, &call.args),
        "codebase_search" => codebase_search(workspace, &call.args),
        "read_lints" => Ok(json!({
            "success": true,
            "message": "Native lint diagnostics are not wired yet; run the relevant test or lint command if exact diagnostics are needed."
        })),
        _ => bail!("{} is not a read-only native tool", call.name),
    }
}

async fn execute_file_mutation(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let path =
        path_arg(&call.args).context("file mutation needs file_path, target_file, or path")?;
    let path = resolve_workspace_path(&runtime.workspace, path)?;
    let old_text = fs::read_to_string(&path).ok();
    let new_text = match call.name.as_str() {
        "write" => string_arg(&call.args, &["contents", "content", "new_text"])
            .context("write needs contents")?,
        "edit" | "search_replace" => {
            let old_string = string_arg(&call.args, &["old_string", "search", "old"])
                .context("edit needs old_string")?;
            let new_string = string_arg(&call.args, &["new_string", "replace", "new"])
                .context("edit needs new_string")?;
            let current = old_text
                .clone()
                .with_context(|| format!("reading {}", path.display()))?;
            let replace_all = bool_arg(&call.args, "replace_all");
            let count = current.matches(&old_string).count();
            if count == 0 {
                bail!("old_string was not found in {}", path.display());
            }
            if !replace_all && count > 1 {
                bail!(
                    "old_string occurs {count} times in {}; add more context or set replace_all",
                    path.display()
                );
            }
            if replace_all {
                current.replace(&old_string, &new_string)
            } else {
                current.replacen(&old_string, &new_string, 1)
            }
        }
        "delete_file" => String::new(),
        _ => unreachable!(),
    };

    let diff = acp::Diff::new(path.clone(), new_text.clone()).old_text(old_text.clone());
    let content = vec![acp::ToolCallContent::Diff(diff)];
    let raw_input = Some(call.args.clone());
    let tool_call = acp::ToolCall::new(call.id.clone(), tool_title(call))
        .kind(if call.name == "delete_file" {
            acp::ToolKind::Delete
        } else {
            acp::ToolKind::Edit
        })
        .status(acp::ToolCallStatus::InProgress)
        .content(content.clone())
        .locations(vec![acp::ToolCallLocation::new(path.clone())])
        .raw_input(raw_input)
        .meta(meta_with_tool_name(&call.name));
    emit_tool_call(state.clone(), runtime, tool_call, cx)?;

    if call.name == "delete_file" {
        let executor = cx.background_executor().clone();
        executor
            .spawn({
                let path = path.clone();
                async move {
                    if path.is_dir() {
                        fs::remove_dir_all(path)?;
                    } else if path.exists() {
                        fs::remove_file(path)?;
                    }
                    anyhow::Ok(())
                }
            })
            .await?;
    } else if old_text.is_some() {
        runtime
            .thread
            .update(cx, |thread, cx| {
                thread.write_text_file(path.clone(), new_text.clone(), cx)
            })
            .map_err(|err| anyhow!(err))?
            .await?;
    } else {
        let executor = cx.background_executor().clone();
        executor
            .spawn({
                let path = path.clone();
                let new_text = new_text.clone();
                async move {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(path, new_text)?;
                    anyhow::Ok(())
                }
            })
            .await?;
    }

    let output = json!({"success": true, "path": path, "applied": true});
    emit_tool_update(
        state,
        runtime,
        call,
        acp::ToolCallStatus::Completed,
        content,
        Some(output.clone()),
        cx,
    )?;
    Ok(output)
}

async fn execute_create_directory(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let path = string_arg(&call.args, &["path", "target_directory", "target_file"])
        .context("create_directory needs path")?;
    let path = resolve_workspace_path(&runtime.workspace, path)?;
    let tool_call = acp::ToolCall::new(call.id.clone(), tool_title(call))
        .kind(acp::ToolKind::Edit)
        .status(acp::ToolCallStatus::InProgress)
        .content(vec![text_content(format!("Creating `{}`", path.display()))])
        .locations(vec![acp::ToolCallLocation::new(path.clone())])
        .raw_input(Some(call.args.clone()))
        .meta(meta_with_tool_name(&call.name));
    emit_tool_call(state.clone(), runtime, tool_call, cx)?;
    let executor = cx.background_executor().clone();
    executor
        .spawn({
            let path = path.clone();
            async move {
                fs::create_dir_all(&path)?;
                anyhow::Ok(())
            }
        })
        .await?;
    let output = json!({"success": true, "path": path});
    emit_tool_update(
        state,
        runtime,
        call,
        acp::ToolCallStatus::Completed,
        vec![text_content(value_to_text(&output))],
        Some(output.clone()),
        cx,
    )?;
    Ok(output)
}

async fn execute_shell_tool(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let command = string_arg(&call.args, &["command"]).context("shell tool needs command")?;
    let cwd = string_arg(&call.args, &["working_directory"])
        .map(|path| resolve_workspace_path(&runtime.workspace, path))
        .transpose()?
        .unwrap_or_else(|| runtime.workspace.clone());
    let read_only = is_read_only_shell_command(&command);
    let auto_approved = read_only || runtime.mode.to_string() == "free";
    let terminal_id = acp::TerminalId::new(format!(
        "backboard-terminal-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let mut meta = meta_with_tool_name(&call.name);
    meta.insert(
        "terminal_info".to_string(),
        json!({"terminal_id": terminal_id.to_string(), "cwd": cwd}),
    );
    let tool_call = acp::ToolCall::new(call.id.clone(), tool_title(call))
        .kind(acp::ToolKind::Execute)
        .status(if auto_approved {
            acp::ToolCallStatus::InProgress
        } else {
            acp::ToolCallStatus::Pending
        })
        .content(vec![
            acp::ToolCallContent::Terminal(acp::Terminal::new(terminal_id.clone())),
            text_content(command.clone()),
        ])
        .raw_input(Some(call.args.clone()))
        .meta(meta.clone());

    if auto_approved {
        emit_tool_call(state.clone(), runtime, tool_call, cx)?;
    } else {
        let options = PermissionOptions::Flat(vec![
            acp::PermissionOption::new("allow", "Allow", acp::PermissionOptionKind::AllowOnce),
            acp::PermissionOption::new("deny", "Deny", acp::PermissionOptionKind::RejectOnce),
        ]);
        let outcome = runtime
            .thread
            .update(cx, |thread, cx| {
                create_display_terminal(
                    thread,
                    &terminal_id,
                    tool_title(call),
                    Some(cwd.clone()),
                    cx,
                )?;
                thread.request_tool_call_authorization(
                    tool_call.clone().into(),
                    options,
                    AuthorizationKind::PermissionGrant,
                    cx,
                )
            })
            .map_err(|err| anyhow!(err))??
            .await;
        let allowed = matches!(
            outcome,
            RequestPermissionOutcome::Selected(ref selected)
                if matches!(
                    selected.option_kind,
                    acp::PermissionOptionKind::AllowOnce | acp::PermissionOptionKind::AllowAlways
                )
        );
        if !allowed {
            let output = json!({"success": false, "error": "Command rejected in Backboard IDE."});
            emit_tool_update(
                state,
                runtime,
                call,
                acp::ToolCallStatus::Failed,
                vec![text_content(value_to_text(&output))],
                Some(output.clone()),
                cx,
            )?;
            return Ok(output);
        }
    }

    let timeout = duration_arg(&call.args, "timeout").unwrap_or_else(|| {
        if read_only {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(120)
        }
    });
    let executor = cx.background_executor().clone();
    let result = executor
        .spawn({
            let command = command.clone();
            let cwd = cwd.clone();
            async move { run_shell_command(&command, &cwd, timeout) }
        })
        .await?;

    runtime
        .thread
        .update(cx, |thread, cx| {
            thread.on_terminal_provider_event(
                TerminalProviderEvent::Output {
                    terminal_id: terminal_id.clone(),
                    data: result.output.clone().into_bytes(),
                },
                cx,
            );
            thread.on_terminal_provider_event(
                TerminalProviderEvent::Exit {
                    terminal_id: terminal_id.clone(),
                    status: acp::TerminalExitStatus::new()
                        .exit_code(result.exit_code.map(|code| code as u32)),
                },
                cx,
            );
        })
        .ok();

    let output = json!({
        "success": result.exit_code == Some(0),
        "exit_code": result.exit_code,
        "stdout": truncate(&result.stdout, MAX_OUTPUT_CHARS),
        "stderr": truncate(&result.stderr, MAX_OUTPUT_CHARS),
        "cwd": cwd,
    });
    emit_tool_update(
        state,
        runtime,
        call,
        if result.exit_code == Some(0) {
            acp::ToolCallStatus::Completed
        } else {
            acp::ToolCallStatus::Failed
        },
        vec![text_content(value_to_text(&output))],
        Some(output.clone()),
        cx,
    )?;
    Ok(output)
}

fn execute_todo_write(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let todos = call
        .args
        .get("todos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entries = todos
        .iter()
        .filter_map(|todo| {
            let content = todo.get("content")?.as_str()?.to_string();
            let status = match todo
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
            {
                "in_progress" => acp::PlanEntryStatus::InProgress,
                "completed" => acp::PlanEntryStatus::Completed,
                _ => acp::PlanEntryStatus::Pending,
            };
            Some(acp::PlanEntry::new(
                content,
                acp::PlanEntryPriority::Medium,
                status,
            ))
        })
        .collect::<Vec<_>>();
    state.emit_update(
        runtime,
        acp::SessionUpdate::Plan(acp::Plan::new(entries)),
        cx,
    )?;
    let output = json!({"success": true, "todos": todos});
    emit_tool_result(state, runtime, call, &output, cx)?;
    Ok(output)
}

fn emit_progress(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    text: String,
    cx: &mut AsyncApp,
) -> Result<()> {
    let mut meta = acp::Meta::new();
    meta.insert("backboardProgress".to_string(), true.into());
    state.emit_update(
        runtime,
        acp::SessionUpdate::AgentThoughtChunk(
            acp::ContentChunk::new(acp::ContentBlock::from(text)).meta(meta),
        ),
        cx,
    )
}

fn emit_tool_result(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    output: &Value,
    cx: &mut AsyncApp,
) -> Result<()> {
    let status = if output
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        acp::ToolCallStatus::Completed
    } else {
        acp::ToolCallStatus::Failed
    };
    let tool_call = acp::ToolCall::new(call.id.clone(), tool_title(call))
        .kind(tool_kind(&call.name))
        .status(status)
        .content(vec![text_content(value_to_text(output))])
        .raw_input(Some(call.args.clone()))
        .raw_output(Some(output.clone()))
        .meta(meta_with_tool_name(&call.name));
    emit_tool_call(state, runtime, tool_call, cx)
}

fn emit_tool_call(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    tool_call: acp::ToolCall,
    cx: &mut AsyncApp,
) -> Result<()> {
    if let Some(meta) = &tool_call.meta
        && let Some(terminal_info) = meta.get("terminal_info")
        && let Some(id) = terminal_info.get("terminal_id").and_then(Value::as_str)
    {
        let cwd = terminal_info
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let terminal_id = acp::TerminalId::new(id);
        runtime
            .thread
            .update(cx, |thread, cx| {
                create_display_terminal(thread, &terminal_id, tool_call.title.clone(), cwd, cx)
            })
            .map_err(|err| anyhow!(err))??;
    }
    state.emit_update(runtime, acp::SessionUpdate::ToolCall(tool_call), cx)
}

fn emit_tool_update(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    status: acp::ToolCallStatus,
    content: Vec<acp::ToolCallContent>,
    raw_output: Option<Value>,
    cx: &mut AsyncApp,
) -> Result<()> {
    state.emit_update(
        runtime,
        acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            call.id.clone(),
            acp::ToolCallUpdateFields::new()
                .status(status)
                .content(content)
                .raw_output(raw_output),
        )),
        cx,
    )
}

fn create_display_terminal(
    thread: &mut acp_thread::AcpThread,
    terminal_id: &acp::TerminalId,
    label: String,
    cwd: Option<PathBuf>,
    cx: &mut gpui::Context<acp_thread::AcpThread>,
) -> Result<()> {
    let builder = TerminalBuilder::new_display_only(
        CursorShape::default(),
        AlternateScroll::On,
        None,
        0,
        cx.background_executor(),
        thread.project().read(cx).path_style(cx),
    )?;
    let lower = cx.new(|cx| builder.subscribe(cx));
    thread.on_terminal_provider_event(
        TerminalProviderEvent::Created {
            terminal_id: terminal_id.clone(),
            label,
            cwd,
            output_byte_limit: None,
            terminal: lower,
        },
        cx,
    );
    Ok(())
}

fn read_file(workspace: &Path, args: &Value) -> Result<Value> {
    let path = path_arg(args).context("read_file needs target_file or file_path")?;
    let path = resolve_workspace_path(workspace, path)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_READ_BYTES {
        bail!(
            "{} is too large to read directly ({} bytes)",
            path.display(),
            metadata.len()
        );
    }
    let content =
        fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let lines = content.lines().collect::<Vec<_>>();
    let offset = int_arg(args, "offset").unwrap_or(1);
    let limit = int_arg(args, "limit").unwrap_or(lines.len() as i64).max(0) as usize;
    let start = if offset < 0 {
        lines.len().saturating_sub(offset.unsigned_abs() as usize)
    } else {
        (offset as usize).saturating_sub(1)
    };
    let selected = lines
        .iter()
        .enumerate()
        .skip(start)
        .take(limit)
        .map(|(index, line)| format!("{}|{}", index + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(json!({
        "success": true,
        "path": path,
        "content": truncate(&selected, MAX_OUTPUT_CHARS),
        "line_count": lines.len()
    }))
}

fn list_dir(workspace: &Path, args: &Value) -> Result<Value> {
    let path = string_arg(args, &["target_directory", "path"]).unwrap_or_else(|| ".".to_string());
    let path = resolve_workspace_path(workspace, path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path(),
            "type": if metadata.is_dir() { "directory" } else { "file" },
            "size": metadata.len(),
        }));
    }
    entries.sort_by_key(|entry| {
        entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
    });
    Ok(json!({"success": true, "path": path, "entries": entries}))
}

fn glob_files(workspace: &Path, args: &Value) -> Result<Value> {
    let pattern = string_arg(args, &["pattern", "glob_pattern"]).context("glob needs pattern")?;
    let target = string_arg(args, &["target_directory", "path"]).unwrap_or_else(|| ".".to_string());
    let root = resolve_workspace_path(workspace, target)?;
    let glob = if pattern.starts_with("**/") || pattern.contains('/') {
        pattern
    } else {
        format!("**/{pattern}")
    };
    let mut builder = GlobSetBuilder::new();
    builder.add(Glob::new(&glob)?);
    let set = builder.build()?;
    let mut matches = Vec::new();
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(skip_hidden_heavy_dirs)
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
        if set.is_match(relative) {
            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());
            matches.push((modified, entry.path().to_path_buf()));
        }
    }
    matches.sort_by(|left, right| right.0.cmp(&left.0));
    let files = matches
        .into_iter()
        .take(MAX_SEARCH_RESULTS)
        .map(|(_, path)| path)
        .collect::<Vec<_>>();
    Ok(json!({"success": true, "pattern": glob, "files": files}))
}

fn grep_files(workspace: &Path, args: &Value) -> Result<Value> {
    let pattern = string_arg(args, &["pattern"]).context("grep needs pattern")?;
    let root = string_arg(args, &["path"])
        .map(|path| resolve_workspace_path(workspace, path))
        .transpose()?
        .unwrap_or_else(|| workspace.to_path_buf());
    let mut builder = RegexBuilder::new(&pattern);
    builder.case_insensitive(bool_arg(args, "case_insensitive"));
    builder.multi_line(bool_arg(args, "multiline"));
    let regex = builder.build()?;
    let output_mode = string_arg(args, &["output_mode"]).unwrap_or_else(|| "content".to_string());
    let glob_filter = string_arg(args, &["glob"])
        .map(|glob| {
            let mut builder = GlobSetBuilder::new();
            builder.add(Glob::new(&glob)?);
            builder.build()
        })
        .transpose()?;
    let mut results = Vec::new();
    let mut count = 0usize;

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(skip_hidden_heavy_dirs)
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if let Some(filter) = &glob_filter {
            let relative = path.strip_prefix(&root).unwrap_or(path);
            if !filter.is_match(relative) {
                continue;
            }
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let mut file_matched = false;
        for (line_index, line) in text.lines().enumerate() {
            if regex.is_match(line) {
                count += 1;
                file_matched = true;
                if output_mode == "content" {
                    results.push(json!({
                        "path": path,
                        "line": line_index + 1,
                        "content": line,
                    }));
                }
                if results.len() >= MAX_SEARCH_RESULTS {
                    break;
                }
            }
        }
        if file_matched && output_mode == "files_with_matches" {
            results.push(json!(path));
        }
        if results.len() >= MAX_SEARCH_RESULTS {
            break;
        }
    }
    Ok(json!({"success": true, "count": count, "results": results}))
}

fn codebase_search(workspace: &Path, args: &Value) -> Result<Value> {
    let query = string_arg(args, &["query"]).context("codebase_search needs query")?;
    let limit = int_arg(args, "num_results").unwrap_or(15).clamp(1, 15) as usize;
    let terms = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .filter(|term| term.len() > 2)
        .collect::<Vec<_>>();
    let mut hits = Vec::new();
    for entry in WalkDir::new(workspace)
        .into_iter()
        .filter_entry(skip_hidden_heavy_dirs)
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let haystack = format!("{}\n{}", path.display(), text).to_lowercase();
        let score = terms
            .iter()
            .filter(|term| haystack.contains(term.as_str()))
            .count();
        if score == 0 {
            continue;
        }
        let preview = text.lines().take(24).collect::<Vec<_>>().join("\n");
        hits.push((
            score,
            json!({
                "path": path,
                "score": score,
                "preview": truncate(&preview, 4000),
            }),
        ));
    }
    hits.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(json!({
        "success": true,
        "query": query,
        "results": hits.into_iter().take(limit).map(|(_, hit)| hit).collect::<Vec<_>>()
    }))
}

#[derive(Debug)]
struct ShellResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    output: String,
}

fn run_shell_command(command: &str, cwd: &Path, timeout: Duration) -> Result<ShellResult> {
    let started = Instant::now();
    let mut command_builder = if cfg!(target_os = "windows") {
        let mut command_builder = Command::new("cmd");
        command_builder.arg("/C").arg(command);
        command_builder
    } else {
        let mut command_builder = Command::new("bash");
        command_builder.arg("-lc").arg(command);
        command_builder
    };

    let mut child = command_builder
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let timed_out = loop {
        if child.try_wait()?.is_some() {
            break false;
        }
        if started.elapsed() >= timeout {
            child.kill().ok();
            break true;
        }
        thread::sleep(Duration::from_millis(50));
    };

    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if timed_out {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "Command timed out after {}ms",
            timeout.as_millis()
        ));
    }
    let combined = if stderr.is_empty() {
        stdout.clone()
    } else if stdout.is_empty() {
        stderr.clone()
    } else {
        format!("{stdout}\n{stderr}")
    };
    Ok(ShellResult {
        exit_code: if timed_out {
            None
        } else {
            output.status.code()
        },
        stdout,
        stderr,
        output: combined,
    })
}

fn tool_output_payload(call: &ToolCallRequest, output: Value) -> Value {
    json!({
        "tool_call_id": call.id,
        "output": serde_json::to_string(&compress_output(&call.name, output)).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn compress_output(name: &str, mut output: Value) -> Value {
    if !matches!(
        name,
        "read_file" | "list_dir" | "glob" | "grep" | "codebase_search" | "read_lints"
    ) {
        return output;
    }
    if let Some(object) = output.as_object_mut() {
        for key in ["content", "output", "stdout", "stderr", "message"] {
            if let Some(value) = object.get_mut(key)
                && let Some(text) = value.as_str()
            {
                *value = truncate(text, 8000).into();
            }
        }
        if let Some(results) = object.get_mut("results")
            && let Some(array) = results.as_array_mut()
            && array.len() > 50
        {
            let truncated = array.len() - 50;
            array.truncate(50);
            array.push(json!({"truncated": truncated}));
        }
        object.insert(
            "_backboard_note".to_string(),
            "Read/search output compressed for model context; use read_file for exact full content."
                .into(),
        );
    }
    output
}

fn text_content(text: impl Into<String>) -> acp::ToolCallContent {
    acp::ToolCallContent::from(acp::ContentBlock::from(text.into()))
}

fn meta_with_tool_name(name: &str) -> acp::Meta {
    acp::Meta::from_iter([(acp_thread::TOOL_NAME_META_KEY.to_string(), name.into())])
}

fn tool_title(call: &ToolCallRequest) -> String {
    match call.name.as_str() {
        "read_file" => format!("Reading `{}`", path_arg(&call.args).unwrap_or_default()),
        "list_dir" => format!(
            "Listing `{}`",
            string_arg(&call.args, &["target_directory", "path"])
                .unwrap_or_else(|| ".".to_string())
        ),
        "glob" => format!(
            "Finding `{}`",
            string_arg(&call.args, &["pattern", "glob_pattern"]).unwrap_or_default()
        ),
        "grep" => format!(
            "Searching `{}`",
            string_arg(&call.args, &["pattern"]).unwrap_or_default()
        ),
        "write" | "edit" | "search_replace" | "delete_file" => {
            format!("Editing `{}`", path_arg(&call.args).unwrap_or_default())
        }
        "bash" | "run_terminal_cmd" => string_arg(&call.args, &["description"])
            .unwrap_or_else(|| string_arg(&call.args, &["command"]).unwrap_or_default()),
        other => other.to_string(),
    }
}

fn tool_kind(name: &str) -> acp::ToolKind {
    match name {
        "read_file" | "list_dir" | "read_lints" => acp::ToolKind::Read,
        "glob" | "grep" | "codebase_search" => acp::ToolKind::Search,
        "write" | "edit" | "search_replace" | "create_directory" => acp::ToolKind::Edit,
        "delete_file" => acp::ToolKind::Delete,
        "bash" | "run_terminal_cmd" => acp::ToolKind::Execute,
        "todo_write" => acp::ToolKind::Think,
        _ => acp::ToolKind::Other,
    }
}

fn is_mutating_tool(name: &str) -> bool {
    matches!(
        name,
        "write"
            | "edit"
            | "search_replace"
            | "delete_file"
            | "create_directory"
            | "bash"
            | "run_terminal_cmd"
    )
}

fn is_shell_tool(name: &str) -> bool {
    matches!(name, "bash" | "run_terminal_cmd")
}

fn is_read_only_shell_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed
        .chars()
        .any(|ch| matches!(ch, ';' | '&' | '|' | '>' | '<' | '`' | '$' | '\n' | '\r'))
    {
        return false;
    }

    let tokens = trimmed.split_whitespace().collect::<Vec<_>>();
    let Some(first) = tokens.first() else {
        return false;
    };
    let executable = Path::new(first)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(first);
    let args = &tokens[1..];

    if !matches!(
        executable,
        "cat"
            | "du"
            | "fd"
            | "file"
            | "find"
            | "git"
            | "grep"
            | "head"
            | "ls"
            | "pwd"
            | "rg"
            | "sed"
            | "stat"
            | "tail"
            | "tree"
            | "curl"
            | "wc"
    ) {
        return false;
    }

    if args.iter().any(|arg| is_unsafe_read_flag(arg)) {
        return false;
    }

    match executable {
        "curl" => is_read_only_curl_command(args),
        "git" => is_read_only_git_command(args),
        "sed" => is_read_only_sed_command(args),
        _ => true,
    }
}

fn is_unsafe_read_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--delete"
            | "--exec"
            | "--execdir"
            | "--ok"
            | "--okdir"
            | "-delete"
            | "-exec"
            | "-execdir"
            | "-ok"
            | "-okdir"
            | "-i"
            | "-i''"
            | "-i\"\""
            | "--in-place"
    )
}

fn is_read_only_git_command(args: &[&str]) -> bool {
    let mut cleaned = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index] {
            "-C" => index += 2,
            "--no-pager" | "--paginate" => index += 1,
            arg => {
                cleaned.push(arg);
                index += 1;
            }
        }
    }

    let Some((subcommand, rest)) = cleaned.split_first() else {
        return true;
    };
    match *subcommand {
        "blame" | "describe" | "diff" | "grep" | "log" | "ls-files" | "ls-tree" | "rev-parse"
        | "show" | "status" => true,
        "branch" => {
            rest.is_empty()
                || rest.iter().all(|arg| {
                    matches!(
                        *arg,
                        "--show-current" | "--list" | "-a" | "-r" | "-v" | "-vv" | "--verbose"
                    ) || !arg.starts_with('-')
                })
        }
        "remote" => {
            rest.is_empty()
                || rest
                    .iter()
                    .all(|arg| matches!(*arg, "-v" | "--verbose" | "show"))
        }
        "config" => rest.first().is_some_and(|arg| {
            matches!(
                *arg,
                "--get" | "--get-all" | "--get-regexp" | "--list" | "-l" | "--show-origin"
            )
        }),
        "stash" => rest
            .first()
            .is_some_and(|arg| matches!(*arg, "list" | "show")),
        _ => false,
    }
}

fn is_read_only_sed_command(args: &[&str]) -> bool {
    if args
        .iter()
        .any(|arg| matches!(*arg, "-i" | "--in-place") || arg.starts_with("-i"))
    {
        return false;
    }
    args.iter()
        .filter(|arg| !arg.starts_with('-'))
        .all(|script| !script.contains("w ") && !script.ends_with('w') && !script.contains("e "))
}

fn is_read_only_curl_command(args: &[&str]) -> bool {
    if args.is_empty() {
        return false;
    }

    let mut method = "GET";
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        match arg {
            "-I" | "--head" => {
                method = "HEAD";
                index += 1;
            }
            "-X" | "--request" => {
                let Some(next) = args.get(index + 1) else {
                    return false;
                };
                method = next.trim();
                if !is_safe_curl_method(method) {
                    return false;
                }
                index += 2;
            }
            "--" => break,
            _ if arg.starts_with("--request=") => {
                method = arg.split_once('=').map_or("", |(_, method)| method).trim();
                if !is_safe_curl_method(method) {
                    return false;
                }
                index += 1;
            }
            _ if arg.starts_with("-X") && arg != "-X" => {
                method = arg.trim_start_matches("-X").trim_start_matches('=').trim();
                if !is_safe_curl_method(method) {
                    return false;
                }
                index += 1;
            }
            _ if is_mutating_curl_arg(arg) => return false,
            _ => index += 1,
        }
    }

    is_safe_curl_method(method)
}

fn is_safe_curl_method(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD")
}

fn is_mutating_curl_arg(arg: &str) -> bool {
    matches!(
        arg,
        "-d" | "--data"
            | "--data-binary"
            | "--data-raw"
            | "--data-urlencode"
            | "-F"
            | "--form"
            | "--form-string"
            | "-T"
            | "--upload-file"
            | "-o"
            | "--output"
            | "-O"
            | "--remote-name"
            | "--remote-name-all"
            | "--remote-header-name"
            | "-J"
    ) || arg.starts_with("-d")
        || arg.starts_with("--data")
        || arg.starts_with("-F")
        || arg.starts_with("--form")
        || arg.starts_with("-T")
        || arg.starts_with("--upload-file")
        || arg.starts_with("-o")
        || arg.starts_with("--output=")
}

fn resolve_workspace_path(workspace: &Path, path: impl AsRef<str>) -> Result<PathBuf> {
    let input = path.as_ref();
    if input.trim().is_empty() {
        bail!("path cannot be empty");
    }
    let raw = PathBuf::from(input);
    let joined = if raw.is_absolute() {
        raw
    } else {
        workspace.join(raw)
    };
    let normalized = normalize_path(&joined);
    let workspace = normalize_path(workspace);
    if !normalized.starts_with(&workspace) {
        bail!(
            "path {} is outside workspace {}",
            normalized.display(),
            workspace.display()
        );
    }
    Ok(normalized)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn skip_hidden_heavy_dirs(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    !(entry.file_type().is_dir()
        && matches!(
            name.as_ref(),
            ".git" | "node_modules" | "target" | ".next" | ".venv" | "__pycache__"
        ))
}

fn path_arg(args: &Value) -> Option<String> {
    string_arg(
        args,
        &[
            "target_file",
            "file_path",
            "path",
            "target_path",
            "target_directory",
        ],
    )
}

fn string_arg(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn duration_arg(args: &Value, key: &str) -> Option<Duration> {
    int_arg(args, key).map(|millis| Duration::from_millis(millis.clamp(1_000, 600_000) as u64))
}

fn value_to_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
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
    fn read_only_shell_detection_blocks_mutation() {
        assert!(is_read_only_shell_command("git status --short"));
        assert!(is_read_only_shell_command("git -C ide/zed status"));
        assert!(is_read_only_shell_command("rg Backboard ide/zed"));
        assert!(is_read_only_shell_command("curl -I https://example.com"));
        assert!(!is_read_only_shell_command(""));
        assert!(!is_read_only_shell_command("rm -rf target"));
        assert!(!is_read_only_shell_command("find . -delete"));
        assert!(!is_read_only_shell_command("git reset --hard"));
        assert!(!is_read_only_shell_command("git pull"));
        assert!(!is_read_only_shell_command("npm run build"));
        assert!(!is_read_only_shell_command("sed -i s/a/b/g file"));
        assert!(!is_read_only_shell_command(
            "curl -X POST https://example.com"
        ));
    }
}
