use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    net::{IpAddr, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    rc::Rc,
    sync::mpsc::{self, TryRecvError},
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

use super::{BackboardNativeState, SessionRuntime, index, mcp, rounded_ms};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 120;
const MAX_OUTPUT_CHARS: usize = 16_000;
const MAX_GLOB_RESULTS: usize = 10_000;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
const READ_ONLY_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const CHECK_COMMAND_TIMEOUT: Duration = Duration::from_secs(90);
const INSTALL_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const DEV_SERVER_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(180);

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
    let mut calls = Vec::new();
    let mut outputs = Vec::with_capacity(tool_calls.len());
    for raw_call in tool_calls {
        match parse_tool_call(raw_call.clone()) {
            Ok(call) => calls.push(call),
            Err(err) => {
                let call = malformed_tool_call(raw_call, err);
                let output = json!({
                    "success": false,
                    "error": "Backboard returned a malformed tool call. The IDE skipped execution and reported the issue back to the model.",
                    "details": call.args.get("parse_error").cloned().unwrap_or(Value::Null),
                });
                emit_tool_result(state.clone(), runtime, &call, &output, cx)?;
                outputs.push(tool_output_payload(&call, output));
            }
        }
    }
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
                            let started_at = Instant::now();
                            let output = execute_read_only_tool(&runtime.workspace, &call).await;
                            (call, output, rounded_ms(started_at.elapsed()))
                        }
                    }
                });
                for (call, output, duration_ms) in join_all(tasks).await {
                    state.record_tool_duration_ms(&runtime.session_id, &call.name, duration_ms);
                    let output = output
                        .unwrap_or_else(|err| json!({"success": false, "error": err.to_string()}));
                    emit_tool_result(state.clone(), runtime, &call, &output, cx)?;
                    outputs.push(tool_output_payload(&call, output));
                }
            } else {
                let call = group[0].clone();
                let output =
                    execute_timed_tool_call(state.clone(), runtime, call.clone(), cx).await;
                outputs.push(tool_output_payload(
                    &call,
                    output
                        .unwrap_or_else(|err| json!({"success": false, "error": err.to_string()})),
                ));
            }
        } else {
            let call = calls[index].clone();
            index += 1;
            let output = execute_timed_tool_call(state.clone(), runtime, call.clone(), cx).await;
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

async fn execute_timed_tool_call(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let name = call.name.clone();
    let started_at = Instant::now();
    let output = execute_tool_call(state.clone(), runtime, call, cx).await;
    state.record_tool_duration_ms(&runtime.session_id, &name, rounded_ms(started_at.elapsed()));
    output
}

pub fn parse_tool_call(value: Value) -> Result<ToolCallRequest> {
    let id = tool_call_id(&value);
    let function = value.get("function").and_then(Value::as_object);
    let name = function
        .and_then(|function| function.get("name"))
        .or_else(|| value.get("name"))
        .or_else(|| value.get("function_name"))
        .or_else(|| value.get("tool_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .context("tool call function did not include a name")?
        .to_string();
    let arguments = function
        .and_then(|function| function.get("arguments"))
        .or_else(|| value.get("arguments"))
        .or_else(|| value.get("args"))
        .or_else(|| value.get("input"));
    let args = match arguments {
        Some(Value::String(text)) if !text.trim().is_empty() => serde_json::from_str(text)
            .with_context(|| format!("parsing arguments for tool `{name}`"))?,
        Some(value) => value.clone(),
        None => json!({}),
    };

    Ok(ToolCallRequest { id, name, args })
}

fn tool_call_id(value: &Value) -> String {
    value
        .get("id")
        .or_else(|| value.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("tool-{}", uuid::Uuid::new_v4().simple()))
}

fn malformed_tool_call(value: Value, err: anyhow::Error) -> ToolCallRequest {
    ToolCallRequest {
        id: tool_call_id(&value),
        name: "invalid_tool_call".to_string(),
        args: json!({
            "parse_error": err.to_string(),
            "raw_tool_call": value,
        }),
    }
}

fn is_parallel_read_only(call: &ToolCallRequest) -> bool {
    matches!(
        call.name.as_str(),
        "read_file"
            | "list_dir"
            | "glob"
            | "glob_file_search"
            | "grep"
            | "codebase_search"
            | "read_lints"
            | "web_search"
            | "web_fetch"
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

    if let Some(mcp_tool) = state.mcp_tool_for_name(&runtime.session_id, &call.name) {
        let output = mcp::execute_tool(runtime, &mcp_tool, &call.args, cx)
            .await
            .unwrap_or_else(|err| json!({"success": false, "error": err.to_string()}));
        emit_tool_result(state, runtime, &call, &output, cx)?;
        return Ok(output);
    }

    match call.name.as_str() {
        "read_file" | "list_dir" | "glob" | "glob_file_search" | "grep" | "codebase_search"
        | "read_lints" | "web_search" | "web_fetch" => {
            let output = execute_read_only_tool(&runtime.workspace, &call).await?;
            emit_tool_result(state, runtime, &call, &output, cx)?;
            Ok(output)
        }
        "write" | "edit" | "search_replace" | "delete_file" => {
            execute_file_mutation(state, runtime, &call, cx).await
        }
        "create_directory" => execute_create_directory(state, runtime, &call, cx).await,
        "bash" | "run_terminal_cmd" => execute_shell_tool(state, runtime, &call, cx).await,
        "run_code" | "repl" => execute_code_tool(state, runtime, &call, cx).await,
        "todo_write" => execute_todo_write(state, runtime, &call, cx),
        "enter_plan_mode" | "exit_plan_mode" | "persistence_decide" | "sleep" | "task"
        | "computer" | "ask_user_question" => execute_flow_tool(state, runtime, &call, cx).await,
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
        "glob" | "glob_file_search" => glob_files(workspace, &call.args),
        "grep" => grep_files(workspace, &call.args),
        "codebase_search" => codebase_search(workspace, &call.args),
        "read_lints" => Ok(json!({
            "success": true,
            "message": "Native lint diagnostics are not wired yet; run the relevant test or lint command if exact diagnostics are needed."
        })),
        "web_search" => web_search(workspace, &call.args),
        "web_fetch" => web_fetch(workspace, &call.args),
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

    let write_started_at = Instant::now();
    if call.name == "delete_file" {
        state
            .record_path_tree_before_mutation(&runtime.session_id, &path)
            .with_context(|| format!("snapshotting {}", path.display()))?;
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
        state
            .record_path_before_mutation(&runtime.session_id, &path)
            .with_context(|| format!("snapshotting {}", path.display()))?;
        runtime
            .thread
            .update(cx, |thread, cx| {
                thread.write_text_file(path.clone(), new_text.clone(), cx)
            })
            .map_err(|err| anyhow!(err))?
            .await?;
    } else {
        state
            .record_path_before_mutation(&runtime.session_id, &path)
            .with_context(|| format!("snapshotting {}", path.display()))?;
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
    state.add_turn_duration_ms(
        &runtime.session_id,
        "file_write_ms",
        rounded_ms(write_started_at.elapsed()),
    );

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
    state
        .record_path_before_mutation(&runtime.session_id, &path)
        .with_context(|| format!("snapshotting {}", path.display()))?;
    let executor = cx.background_executor().clone();
    let write_started_at = Instant::now();
    executor
        .spawn({
            let path = path.clone();
            async move {
                fs::create_dir_all(&path)?;
                anyhow::Ok(())
            }
        })
        .await?;
    state.add_turn_duration_ms(
        &runtime.session_id,
        "file_write_ms",
        rounded_ms(write_started_at.elapsed()),
    );
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
    let command = extract_shell_command(&call.name, &call.args);
    if command.trim().is_empty() || command.trim() == call.name {
        bail!(
            "{} needs a concrete shell command in command, cmd, code, or script",
            call.name
        );
    }
    let cwd = string_arg(&call.args, &["working_directory", "cwd"])
        .map(|path| resolve_workspace_path(&runtime.workspace, path))
        .transpose()?
        .unwrap_or_else(|| runtime.workspace.clone());
    let read_only = is_read_only_shell_command(&command);
    let auto_approved = read_only || runtime.mode.to_string() == "free";
    let timeout = command_timeout(&command, &call.args, read_only);
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
            text_content(format!(
                "{command}\n\nBackboard timeout: {:.0}s",
                timeout.as_secs_f64()
            )),
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

    if bool_arg(&call.args, "is_background") {
        let output = run_background_command(&command, &cwd)?;
        emit_tool_update(
            state,
            runtime,
            call,
            acp::ToolCallStatus::Completed,
            vec![text_content(value_to_text(&output))],
            Some(output.clone()),
            cx,
        )?;
        return Ok(output);
    }
    emit_terminal_output(runtime, &terminal_id, format!("$ {command}\n"), cx);
    let command_started_at = Instant::now();
    let is_dev_server = is_dev_server_command(&command);
    let result =
        run_shell_command_streaming(&command, &cwd, timeout, runtime, &terminal_id, cx).await?;
    state.add_turn_duration_ms(
        &runtime.session_id,
        "command_wait_ms",
        rounded_ms(command_started_at.elapsed()),
    );

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
        "success": result.exit_code == Some(0) || (result.timed_out && is_dev_server),
        "exit_code": result.exit_code,
        "stdout": truncate(&result.stdout, MAX_OUTPUT_CHARS),
        "stderr": truncate(&result.stderr, MAX_OUTPUT_CHARS),
        "output": truncate(&result.output, MAX_OUTPUT_CHARS),
        "cwd": cwd,
        "timed_out": result.timed_out,
        "note": if result.timed_out && is_dev_server {
            "Backboard stopped this long-running dev-server command after the startup window. Use captured output to verify startup."
        } else {
            ""
        },
    });
    emit_tool_update(
        state,
        runtime,
        call,
        if output
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
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

async fn execute_code_tool(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let code = string_arg(&call.args, &["code"]).context("run_code/repl needs code")?;
    let language = string_arg(&call.args, &["language"]).unwrap_or_else(|| "python".to_string());
    let command = match language.as_str() {
        "shell" => code,
        "node" | "typescript" => format!("node <<'JS'\n{code}\nJS"),
        "ruby" => format!("ruby <<'RB'\n{code}\nRB"),
        "go" => format!(
            "cat > /tmp/backboard-run-code.go <<'GO'\n{code}\nGO\ngo run /tmp/backboard-run-code.go"
        ),
        _ => format!("python3 <<'PY'\n{code}\nPY"),
    };
    let mut args = call.args.clone();
    if let Some(object) = args.as_object_mut() {
        object.insert("command".to_string(), command.into());
        object
            .entry("description".to_string())
            .or_insert_with(|| format!("Running {}", call.name).into());
    }
    let shell_call = ToolCallRequest {
        id: call.id.clone(),
        name: "bash".to_string(),
        args,
    };
    execute_shell_tool(state, runtime, &shell_call, cx).await
}

async fn execute_flow_tool(
    state: Rc<BackboardNativeState>,
    runtime: &SessionRuntime,
    call: &ToolCallRequest,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let output = match call.name.as_str() {
        "enter_plan_mode" => json!({
            "success": true,
            "message": "Plan mode entered. Explore read-only, then call exit_plan_mode with the complete plan."
        }),
        "exit_plan_mode" => json!({
            "success": true,
            "plan": string_arg(&call.args, &["plan"]).unwrap_or_default(),
            "message": "Plan submitted for user review."
        }),
        "persistence_decide" => json!({
            "success": false,
            "error": "persistence_decide is only valid when persistence is armed; native persistence is not wired yet."
        }),
        "sleep" => {
            let seconds = int_arg(&call.args, "seconds").unwrap_or(1).clamp(1, 300) as u64;
            let executor = cx.background_executor().clone();
            executor
                .spawn(async move {
                    thread::sleep(Duration::from_secs(seconds));
                })
                .await;
            json!({"success": true, "slept_seconds": seconds})
        }
        "task" => json!({
            "success": false,
            "error": "Native sub-agent task execution is not wired yet. Use direct read/search/edit tools in this session."
        }),
        "computer" => json!({
            "success": false,
            "error": "Native desktop automation is not wired yet."
        }),
        "ask_user_question" => json!({
            "success": false,
            "error": "Interactive user-question tools are not wired in the native runtime yet. Ask in the assistant response instead."
        }),
        _ => json!({"success": false, "error": format!("Unsupported flow tool `{}`.", call.name)}),
    };
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

fn emit_terminal_output(
    runtime: &SessionRuntime,
    terminal_id: &acp::TerminalId,
    data: impl Into<Vec<u8>>,
    cx: &mut AsyncApp,
) {
    runtime
        .thread
        .update(cx, |thread, cx| {
            thread.on_terminal_provider_event(
                TerminalProviderEvent::Output {
                    terminal_id: terminal_id.clone(),
                    data: data.into(),
                },
                cx,
            );
        })
        .ok();
}

fn read_file(workspace: &Path, args: &Value) -> Result<Value> {
    let path = path_arg(args).context("read_file needs target_file or file_path")?;
    let path = resolve_workspace_path(workspace, path)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_READ_BYTES
        && int_arg(args, "offset").is_none()
        && int_arg(args, "limit").is_none()
    {
        return Ok(json!({
            "success": true,
            "large_file": true,
            "size": metadata.len(),
            "message": format!("File is {} bytes. Use offset/limit params to read sections, or bash with head/tail/wc for inspection.", metadata.len())
        }));
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
    let mut walked = 0usize;
    let mut truncated = false;
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(skip_hidden_heavy_dirs)
    {
        walked += 1;
        if walked > MAX_GLOB_RESULTS {
            truncated = true;
            break;
        }
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
        .take(MAX_GLOB_RESULTS)
        .map(|(_, path)| path)
        .collect::<Vec<_>>();
    Ok(
        json!({"success": true, "pattern": glob, "files": files, "count": files.len(), "truncated": truncated}),
    )
}

fn grep_files(workspace: &Path, args: &Value) -> Result<Value> {
    if let Ok(output) = grep_files_with_rg(workspace, args) {
        return Ok(output);
    }
    grep_files_with_walkdir(workspace, args)
}

fn grep_files_with_rg(workspace: &Path, args: &Value) -> Result<Value> {
    let pattern = string_arg(args, &["pattern"]).context("grep needs pattern")?;
    let root = string_arg(args, &["path"])
        .map(|path| resolve_workspace_path(workspace, path))
        .transpose()?
        .unwrap_or_else(|| workspace.to_path_buf());
    let mut command = Command::new("rg");
    command.arg("--json").arg(&pattern);
    if bool_arg(args, "case_insensitive") {
        command.arg("-i");
    }
    if let Some(context_lines) = int_arg(args, "context_lines") {
        command.arg("-C").arg(context_lines.to_string());
    }
    if bool_arg(args, "multiline") {
        command.arg("-U").arg("--multiline-dotall");
    }
    if let Some(glob) = string_arg(args, &["glob"]) {
        command.arg("--glob").arg(glob);
    }
    command.arg(root);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().context("starting rg")?;
    let stdout = child.stdout.take().context("capturing rg stdout")?;
    let reader = BufReader::new(stdout);
    let mode = string_arg(args, &["output_mode"]).unwrap_or_else(|| "content".to_string());
    let mut matches = Vec::new();
    let mut files = BTreeSet::new();
    let mut counts = BTreeMap::<String, usize>::new();

    for line in reader.lines().take(MAX_SEARCH_RESULTS * 3) {
        let line = line?;
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("match") {
            continue;
        }
        let Some(data) = event.get("data") else {
            continue;
        };
        let path = data
            .get("path")
            .and_then(|path| path.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if path.is_empty() {
            continue;
        }
        files.insert(path.clone());
        *counts.entry(path.clone()).or_default() += 1;
        if mode == "content" && matches.len() < MAX_SEARCH_RESULTS {
            matches.push(json!({
                "file": path,
                "line_number": data.get("line_number").and_then(Value::as_u64).unwrap_or_default(),
                "line": data.get("lines").and_then(|lines| lines.get("text")).and_then(Value::as_str).unwrap_or_default(),
            }));
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    match mode.as_str() {
        "files_with_matches" => {
            let count = files.len();
            Ok(json!({
                "success": true,
                "files": files.into_iter().collect::<Vec<_>>(),
                "count": count
            }))
        }
        "count" => Ok(json!({"success": true, "counts": counts})),
        _ => Ok(json!({"success": true, "matches": matches, "count": matches.len()})),
    }
}

fn grep_files_with_walkdir(workspace: &Path, args: &Value) -> Result<Value> {
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
    if let Ok(Some(results)) = index::search_index(workspace, &query, limit) {
        return Ok(json!({
            "success": true,
            "query": query,
            "results": results,
        }));
    }

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

fn web_fetch(workspace: &Path, args: &Value) -> Result<Value> {
    let url = string_arg(args, &["url"]).context("web_fetch needs url")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("web_fetch requires an http or https URL");
    }
    if let Some(error) = ssrf_block_reason(&url) {
        bail!(error);
    }
    let command = format!("curl -L --max-time 20 {}", shell_quote(&url));
    let result = run_shell_command(&command, workspace, Duration::from_secs(30))?;
    Ok(json!({
        "success": result.exit_code == Some(0),
        "url": url,
        "content": truncate(&result.stdout, MAX_OUTPUT_CHARS),
        "stderr": truncate(&result.stderr, 4000),
        "exit_code": result.exit_code,
    }))
}

fn web_search(workspace: &Path, args: &Value) -> Result<Value> {
    let query = string_arg(args, &["query"]).context("web_search needs query")?;
    let command = format!(
        "curl -L --max-time 15 --get --data-urlencode {} --data-urlencode format=json --data-urlencode no_html=1 --data-urlencode skip_disambig=1 https://api.duckduckgo.com/",
        shell_quote(&format!("q={query}"))
    );
    let result = run_shell_command(&command, workspace, Duration::from_secs(20))?;
    if result.exit_code != Some(0) {
        return Ok(json!({
            "success": false,
            "error": truncate(&result.stderr, 4000),
            "query": query,
        }));
    }
    let data: Value = serde_json::from_str(&result.stdout).context("parsing web_search JSON")?;
    let mut results = Vec::new();
    if let Some(abstract_text) = data.get("AbstractText").and_then(Value::as_str)
        && !abstract_text.is_empty()
    {
        results.push(json!({
            "title": data.get("Heading").and_then(Value::as_str).unwrap_or_default(),
            "snippet": abstract_text,
            "url": data.get("AbstractURL").and_then(Value::as_str).unwrap_or_default(),
        }));
    }
    if let Some(topics) = data.get("RelatedTopics").and_then(Value::as_array) {
        for topic in topics.iter().take(8) {
            if let Some(text) = topic.get("Text").and_then(Value::as_str) {
                results.push(json!({
                    "title": text.chars().take(100).collect::<String>(),
                    "snippet": text,
                    "url": topic.get("FirstURL").and_then(Value::as_str).unwrap_or_default(),
                }));
            }
        }
    }
    Ok(json!({
        "success": true,
        "query": query,
        "count": results.len(),
        "results": results,
        "message": if results.is_empty() { "No instant results found. Try web_fetch with a specific documentation URL." } else { "" },
    }))
}

fn ssrf_block_reason(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme.split('/').next().unwrap_or_default();
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .trim_matches('[')
        .split(':')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if host.is_empty() {
        return Some("URL missing hostname".to_string());
    }
    if matches!(
        host.as_str(),
        "localhost" | "ip6-localhost" | "ip6-loopback"
    ) {
        return Some("Blocked: localhost is not reachable via web_fetch.".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return blocked_ip_reason(&host, ip);
    }
    let addresses = (host.as_str(), 80).to_socket_addrs().ok()?;
    for address in addresses {
        if let Some(reason) = blocked_ip_reason(&host, address.ip()) {
            return Some(reason);
        }
    }
    None
}

fn blocked_ip_reason(host: &str, ip: IpAddr) -> Option<String> {
    let blocked = match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_link_local()
                || ip.is_private()
                || ip.is_multicast()
                || ip.is_unspecified()
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified() || ip.is_multicast(),
    };
    blocked.then(|| format!("Blocked: {host} resolves to private or local address {ip}."))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn extract_shell_command(name: &str, args: &Value) -> String {
    string_arg(args, &["command", "cmd", "code", "script"]).unwrap_or_else(|| name.to_string())
}

fn command_timeout(command: &str, args: &Value, read_only: bool) -> Duration {
    if is_dev_server_command(command) {
        return DEV_SERVER_STARTUP_TIMEOUT;
    }
    if let Some(timeout) = duration_arg(args, "timeout") {
        return timeout.min(MAX_COMMAND_TIMEOUT);
    }
    if read_only {
        READ_ONLY_COMMAND_TIMEOUT
    } else if is_install_command(command) {
        INSTALL_COMMAND_TIMEOUT
    } else if is_check_command(command) {
        CHECK_COMMAND_TIMEOUT
    } else {
        DEFAULT_COMMAND_TIMEOUT
    }
}

fn is_dev_server_command(command: &str) -> bool {
    let command = normalized_command(command);
    [
        "npm run dev",
        "npm start",
        "pnpm dev",
        "pnpm start",
        "yarn dev",
        "yarn start",
        "bun dev",
        "bun start",
        "vite",
        "next dev",
    ]
    .iter()
    .any(|marker| command == *marker || command.starts_with(&format!("{marker} ")))
}

fn is_install_command(command: &str) -> bool {
    let tokens = command_tokens(command);
    let Some(executable) = tokens.first().map(|token| executable_name(token)) else {
        return false;
    };
    match executable.as_str() {
        "npm" => tokens
            .get(1)
            .is_some_and(|arg| matches!(arg.as_str(), "install" | "i" | "ci")),
        "pnpm" | "yarn" | "bun" => tokens
            .get(1)
            .is_some_and(|arg| matches!(arg.as_str(), "install" | "i" | "add")),
        _ => false,
    }
}

fn is_check_command(command: &str) -> bool {
    let tokens = command_tokens(command);
    let Some(executable) = tokens.first().map(|token| executable_name(token)) else {
        return false;
    };
    matches!(
        executable.as_str(),
        "cargo" | "go" | "pytest" | "ruff" | "tsc" | "vitest" | "jest" | "eslint"
    ) || matches!(executable.as_str(), "npm" | "pnpm" | "yarn" | "bun")
        && tokens
            .iter()
            .any(|token| matches!(token.as_str(), "test" | "build" | "lint" | "check"))
}

fn normalized_command(command: &str) -> String {
    let mut normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.ends_with('&') {
        normalized.pop();
        normalized = normalized.trim_end().to_string();
    }
    if let Some(rest) = normalized.strip_prefix("cd ")
        && let Some((_, command)) = rest.split_once("&&")
    {
        normalized = command.trim().to_string();
    }
    normalized.to_lowercase()
}

fn command_tokens(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|token| token.trim_matches(['"', '\'']).to_string())
        .collect()
}

fn executable_name(token: &str) -> String {
    Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_string()
}

fn shell_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let Some(home) = std::env::var_os("HOME") else {
        return current;
    };
    let backboard_bin = PathBuf::from(home).join(".backboard").join("bin");
    format!("{}:{current}", backboard_bin.display())
}

#[derive(Debug)]
struct ShellResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    output: String,
    timed_out: bool,
}

enum ShellEvent {
    Output(Vec<u8>),
    Finished(Result<ShellResult, String>),
}

async fn run_shell_command_streaming(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    runtime: &SessionRuntime,
    terminal_id: &acp::TerminalId,
    cx: &mut AsyncApp,
) -> Result<ShellResult> {
    let receiver = spawn_shell_command(command.to_string(), cwd.to_path_buf(), timeout);
    loop {
        match receiver.try_recv() {
            Ok(ShellEvent::Output(data)) => emit_terminal_output(runtime, terminal_id, data, cx),
            Ok(ShellEvent::Finished(result)) => {
                return result.map_err(|error| anyhow!(error));
            }
            Err(TryRecvError::Empty) => {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }
            Err(TryRecvError::Disconnected) => bail!("shell command runner disconnected"),
        }
    }
}

fn spawn_shell_command(
    command: String,
    cwd: PathBuf,
    timeout: Duration,
) -> mpsc::Receiver<ShellEvent> {
    let (event_tx, event_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = run_shell_command_with_events(&command, &cwd, timeout, &event_tx)
            .map_err(|error| error.to_string());
        let _ = event_tx.send(ShellEvent::Finished(result));
    });
    event_rx
}

fn run_shell_command_with_events(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    event_tx: &mpsc::Sender<ShellEvent>,
) -> Result<ShellResult> {
    let started = Instant::now();
    let mut command_builder = shell_command_builder(command);
    let mut child = command_builder
        .current_dir(cwd)
        .env("PATH", shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (chunk_tx, chunk_rx) = mpsc::channel::<(bool, Vec<u8>)>();
    let mut pumps = Vec::new();
    if let Some(stdout) = stdout {
        pumps.push(spawn_pipe_pump(stdout, false, chunk_tx.clone()));
    }
    if let Some(stderr) = stderr {
        pumps.push(spawn_pipe_pump(stderr, true, chunk_tx.clone()));
    }
    drop(chunk_tx);

    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut timed_out = false;
    loop {
        while let Ok((is_stderr, data)) = chunk_rx.try_recv() {
            if is_stderr {
                stderr_bytes.extend_from_slice(&data);
            } else {
                stdout_bytes.extend_from_slice(&data);
            }
            let _ = event_tx.send(ShellEvent::Output(data));
        }
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            child.kill().ok();
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }

    let output = child.wait_with_output()?;
    for pump in pumps {
        let _ = pump.join();
    }
    stdout_bytes.extend_from_slice(&output.stdout);
    stderr_bytes.extend_from_slice(&output.stderr);
    while let Ok((is_stderr, data)) = chunk_rx.try_recv() {
        if is_stderr {
            stderr_bytes.extend_from_slice(&data);
        } else {
            stdout_bytes.extend_from_slice(&data);
        }
        let _ = event_tx.send(ShellEvent::Output(data));
    }

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    if timed_out {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "Command timed out after {}ms",
            timeout.as_millis()
        ));
        let _ = event_tx.send(ShellEvent::Output(
            format!("\nCommand timed out after {}ms\n", timeout.as_millis()).into_bytes(),
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
            Some(124)
        } else {
            output.status.code()
        },
        stdout,
        stderr,
        output: combined,
        timed_out,
    })
}

fn spawn_pipe_pump<R>(
    reader: R,
    is_stderr: bool,
    chunk_tx: mpsc::Sender<(bool, Vec<u8>)>,
) -> thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let mut buffer = Vec::new();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = chunk_tx.send((is_stderr, buffer));
                }
                Err(_) => break,
            }
        }
    })
}

fn shell_command_builder(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut command_builder = Command::new("cmd");
        command_builder.arg("/C").arg(command);
        command_builder
    } else {
        let mut command_builder = Command::new("bash");
        command_builder.arg("-lc").arg(command);
        command_builder
    }
}

fn run_shell_command(command: &str, cwd: &Path, timeout: Duration) -> Result<ShellResult> {
    let started = Instant::now();
    let mut command_builder = shell_command_builder(command);

    let mut child = command_builder
        .current_dir(cwd)
        .env("PATH", shell_path())
        .stdin(Stdio::null())
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
            Some(124)
        } else {
            output.status.code()
        },
        stdout,
        stderr,
        output: combined,
        timed_out,
    })
}

fn run_background_command(command: &str, cwd: &Path) -> Result<Value> {
    let output_dir = cwd.join(".backboard").join("background");
    fs::create_dir_all(&output_dir)?;
    let output_file = output_dir.join(format!("{}.log", uuid::Uuid::new_v4().simple()));
    let stdout = File::create(&output_file)?;
    let stderr = stdout.try_clone()?;
    let mut command_builder = if cfg!(target_os = "windows") {
        let mut command_builder = Command::new("cmd");
        command_builder.arg("/C").arg(command);
        command_builder
    } else {
        let mut command_builder = Command::new("bash");
        command_builder.arg("-lc").arg(command);
        command_builder
    };
    let child = command_builder
        .current_dir(cwd)
        .env("PATH", shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()?;
    Ok(json!({
        "success": true,
        "pid": child.id(),
        "output_file": output_file,
        "message": format!("Background process started (PID: {}). Output: {}", child.id(), output_file.display())
    }))
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
        "read_file"
            | "list_dir"
            | "glob"
            | "grep"
            | "codebase_search"
            | "read_lints"
            | "web_search"
            | "web_fetch"
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
        "glob" | "glob_file_search" => format!(
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
        "bash" | "run_terminal_cmd" | "run_code" | "repl" => {
            string_arg(&call.args, &["description"])
                .unwrap_or_else(|| string_arg(&call.args, &["command"]).unwrap_or_default())
        }
        other => other.to_string(),
    }
}

fn tool_kind(name: &str) -> acp::ToolKind {
    match name {
        "read_file" | "list_dir" | "read_lints" => acp::ToolKind::Read,
        "glob" | "glob_file_search" | "grep" | "codebase_search" | "web_search" | "web_fetch" => {
            acp::ToolKind::Search
        }
        "write" | "edit" | "search_replace" | "create_directory" => acp::ToolKind::Edit,
        "delete_file" => acp::ToolKind::Delete,
        "bash" | "run_terminal_cmd" | "run_code" | "repl" | "computer" => acp::ToolKind::Execute,
        "todo_write" | "enter_plan_mode" | "exit_plan_mode" | "persistence_decide" | "task" => {
            acp::ToolKind::Think
        }
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
            | "run_code"
            | "repl"
            | "computer"
            | "task"
    )
}

fn is_shell_tool(name: &str) -> bool {
    matches!(
        name,
        "bash" | "run_terminal_cmd" | "run_code" | "repl" | "computer"
    )
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
            ".git"
                | ".backboard"
                | ".backboard_index"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
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

fn path_arg(args: &Value) -> Option<String> {
    string_arg(
        args,
        &[
            "target_file",
            "file_path",
            "path",
            "filepath",
            "file",
            "filename",
            "target",
            "absolute_path",
            "src",
            "source_file",
            "target_path",
            "target_directory",
        ],
    )
}

fn string_arg(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = args.get(*key)?;
        let value = if let Some(array) = value.as_array()
            && array.len() == 1
        {
            array.first()?
        } else {
            value
        };
        match value {
            Value::String(text) => (!text.trim().is_empty()).then(|| text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        }
    })
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
    })
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
    fn parse_tool_call_accepts_top_level_name_shape() {
        let call = parse_tool_call(json!({
            "id": "call_1",
            "name": "read_file",
            "arguments": "{\"target_file\":\"src/main.rs\"}",
        }))
        .unwrap();

        assert_eq!(call.id, "call_1");
        assert_eq!(call.name, "read_file");
        assert_eq!(call.args, json!({"target_file": "src/main.rs"}));
    }

    #[test]
    fn malformed_tool_call_preserves_id_for_error_output() {
        let raw = json!({
            "id": "call_missing_name",
            "function": {
                "arguments": "{}"
            },
        });
        let err = parse_tool_call(raw.clone()).unwrap_err();
        let call = malformed_tool_call(raw, err);

        assert_eq!(call.id, "call_missing_name");
        assert_eq!(call.name, "invalid_tool_call");
        assert_eq!(
            call.args.get("parse_error").and_then(Value::as_str),
            Some("tool call function did not include a name")
        );
    }

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

    #[test]
    fn tool_args_accept_python_bridge_alias_shapes() {
        let args = json!({
            "filepath": ["src/main.rs"],
            "offset": "12",
            "limit": 30,
        });

        assert_eq!(path_arg(&args).as_deref(), Some("src/main.rs"));
        assert_eq!(int_arg(&args, "offset"), Some(12));
        assert_eq!(int_arg(&args, "limit"), Some(30));
    }

    #[test]
    fn web_fetch_blocks_local_targets() {
        assert!(ssrf_block_reason("http://localhost:3000").is_some());
        assert!(ssrf_block_reason("http://127.0.0.1:3000").is_some());
    }

    #[test]
    fn codebase_search_falls_back_when_index_is_missing() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            workspace.join("src/main.rs"),
            "fn fallback_marker() { println!(\"fallback search\"); }",
        )
        .unwrap();

        let output = codebase_search(workspace, &json!({"query": "fallback marker"})).unwrap();

        assert_eq!(output.get("success").and_then(Value::as_bool), Some(true));
        let results = output.get("results").and_then(Value::as_array).unwrap();
        assert_eq!(results.len(), 1);
        assert!(
            results[0]
                .get("preview")
                .and_then(Value::as_str)
                .unwrap()
                .contains("fallback_marker")
        );
    }

    #[test]
    fn codebase_search_uses_index_and_ignores_backboard_artifacts() {
        let tempdir = tempfile::tempdir().unwrap();
        let workspace = tempdir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::create_dir_all(workspace.join(".backboard")).unwrap();
        fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
        fs::write(
            workspace.join("src/main.rs"),
            "fn indexed_marker() { println!(\"indexed search\"); }",
        )
        .unwrap();
        fs::write(
            workspace.join(".backboard/hidden.rs"),
            "indexed_marker hidden",
        )
        .unwrap();
        fs::write(
            workspace.join("node_modules/pkg/hidden.rs"),
            "indexed_marker hidden",
        )
        .unwrap();
        index::build_workspace_index(workspace).unwrap();

        let output = codebase_search(workspace, &json!({"query": "indexed marker"})).unwrap();

        let results = output.get("results").and_then(Value::as_array).unwrap();
        assert_eq!(results.len(), 1);
        assert!(
            results[0]
                .get("path")
                .and_then(Value::as_str)
                .unwrap()
                .ends_with("src/main.rs")
        );
    }
}
