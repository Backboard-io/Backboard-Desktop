use std::collections::HashSet;

use anyhow::{Context as _, Result};
use context_server::{
    ContextServerId,
    protocol::ServerCapability,
    types::{
        CallToolParams, Tool,
        requests::{CallTool, ListTools},
    },
};
use futures::future::join_all;
use gpui::AsyncApp;
use language_model::LanguageModelToolSchemaFormat;
use serde_json::{Map, Value, json};

use super::{SessionRuntime, tool_schemas};

#[derive(Clone, Debug)]
pub(crate) struct NativeMcpTool {
    pub generated_name: String,
    pub server_id: ContextServerId,
    pub tool_name: String,
    pub description: String,
    pub input_schema: Value,
}

pub(crate) async fn load_tools(
    runtime: &SessionRuntime,
    cx: &mut AsyncApp,
) -> Result<Vec<NativeMcpTool>> {
    let Some(context_server_store) = runtime.context_server_store.clone() else {
        return Ok(Vec::new());
    };
    let servers = cx.update(|cx| context_server_store.read(cx).running_servers());
    let tool_list_requests = servers.into_iter().filter_map(|server| {
        let client = server.client()?;
        if !client.capable(ServerCapability::Tools) {
            return None;
        }
        let server_id = server.id();
        Some(async move {
            let response = client.request::<ListTools>(()).await;
            (server_id, response)
        })
    });

    let mut server_tools = Vec::new();
    for (server_id, response) in join_all(tool_list_requests).await {
        match response {
            Ok(response) => server_tools.push((server_id, response.tools)),
            Err(error) => {
                log::warn!("Failed to list MCP tools for {server_id}: {error:#}");
            }
        }
    }
    server_tools.sort_by(|(left, _), (right, _)| left.0.cmp(&right.0));

    Ok(build_tool_bindings(server_tools))
}

pub(crate) fn tool_definitions(tools: &[NativeMcpTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            tool_schemas::function_with_parameters(
                &tool.generated_name,
                &tool.description,
                tool.input_schema.clone(),
            )
        })
        .collect()
}

pub(crate) async fn execute_tool(
    runtime: &SessionRuntime,
    tool: &NativeMcpTool,
    args: &Value,
    cx: &mut AsyncApp,
) -> Result<Value> {
    let context_server_store = runtime
        .context_server_store
        .clone()
        .context("MCP context server store is not available for this session")?;
    let server = cx.update(|cx| {
        context_server_store
            .read(cx)
            .get_running_server(&tool.server_id)
    });
    let server =
        server.with_context(|| format!("MCP server `{}` is not running", tool.server_id))?;
    let protocol = server
        .client()
        .with_context(|| format!("MCP server `{}` is not initialized", tool.server_id))?;
    let arguments = match args {
        Value::Null => None,
        Value::Object(map) if map.is_empty() => None,
        value => Some(value.clone()),
    };

    let response = protocol
        .request::<CallTool>(CallToolParams {
            name: tool.tool_name.clone(),
            arguments,
            meta: None,
        })
        .await?;
    let text = response.text_contents();
    let content = serde_json::to_value(&response.content).unwrap_or(Value::Null);

    if response.is_error == Some(true) {
        return Ok(json!({
            "success": false,
            "server": tool.server_id.0.as_ref(),
            "tool": tool.tool_name,
            "error": if text.is_empty() {
                "MCP tool returned an error.".to_string()
            } else {
                text
            },
            "content": content,
            "structured_content": response.structured_content,
        }));
    }

    Ok(json!({
        "success": true,
        "server": tool.server_id.0.as_ref(),
        "tool": tool.tool_name,
        "text": text,
        "content": content,
        "structured_content": response.structured_content,
    }))
}

fn build_tool_bindings(server_tools: Vec<(ContextServerId, Vec<Tool>)>) -> Vec<NativeMcpTool> {
    let mut used_names = native_tool_names();
    let mut bindings = Vec::new();

    for (server_id, tools) in server_tools {
        let server_component = sanitize_component(&server_id.0, "server");
        for tool in tools {
            let tool_component = sanitize_component(&tool.name, "tool");
            let generated_name = unique_name(
                format!("mcp__{server_component}__{tool_component}"),
                &mut used_names,
            );
            let tool_name = tool.name;
            let description = tool.description.unwrap_or_else(|| {
                format!("Run MCP tool `{tool_name}` from server `{}`.", server_id.0)
            });
            bindings.push(NativeMcpTool {
                generated_name,
                server_id: server_id.clone(),
                tool_name,
                description,
                input_schema: normalize_input_schema(tool.input_schema),
            });
        }
    }

    bindings
}

fn native_tool_names() -> HashSet<String> {
    tool_schemas::tool_definitions("free")
        .into_iter()
        .filter_map(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn sanitize_component(input: &str, fallback: &str) -> String {
    let mut output = String::new();
    let mut previous_underscore = false;
    for ch in input.chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            previous_underscore = false;
        } else if !previous_underscore {
            output.push('_');
            previous_underscore = true;
        }
    }
    let output = output.trim_matches('_');
    if output.is_empty() {
        fallback.to_string()
    } else if output
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_digit())
    {
        format!("{fallback}_{output}")
    } else {
        output.to_string()
    }
}

fn unique_name(base: String, used_names: &mut HashSet<String>) -> String {
    if used_names.insert(base.clone()) {
        return base;
    }

    let mut suffix = 2;
    loop {
        let candidate = format!("{base}__{suffix}");
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}

fn normalize_input_schema(mut schema: Value) -> Value {
    match &mut schema {
        Value::Object(map) => {
            if map.is_empty() {
                return empty_object_schema();
            }
            map.entry("type".to_string())
                .or_insert_with(|| Value::String("object".to_string()));
            map.entry("properties".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
        }
        _ => return empty_object_schema(),
    }

    if let Err(error) = language_model::tool_schema::adapt_schema_to_format(
        &mut schema,
        LanguageModelToolSchemaFormat::JsonSchema,
    ) {
        log::warn!("Failed to adapt MCP tool schema: {error:#}");
        return empty_object_schema();
    }

    schema
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use context_server::{
        ContextServer,
        test::create_fake_transport,
        types::{
            CallToolParams, CallToolResponse, Implementation, InitializeResponse,
            ListToolsResponse, ProtocolVersion, ServerCapabilities, ToolResponseContent,
            ToolsCapabilities,
            requests::{CallTool, Initialize, ListTools},
        },
    };
    use gpui::{AppContext as _, Entity, TestAppContext, WeakEntity};
    use project::{
        context_server_store::{ContextServerStore, registry::ContextServerDescriptorRegistry},
        worktree_store::{WorktreeIdCounter, WorktreeStore},
    };
    use settings::SettingsStore;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};

    fn tool(name: &str, input_schema: Value) -> Tool {
        Tool {
            name: name.to_string(),
            title: None,
            description: Some(format!("{name} description")),
            input_schema,
            output_schema: None,
            annotations: None,
        }
    }

    fn test_runtime(context_server_store: Option<Entity<ContextServerStore>>) -> SessionRuntime {
        SessionRuntime {
            session_id: agent_client_protocol::schema::SessionId::new("test-session"),
            thread: WeakEntity::new_invalid(),
            workspace: std::env::temp_dir(),
            provider: "openai".to_string(),
            model: "gpt-4o".to_string(),
            mode: agent_client_protocol::schema::SessionModeId::new("free"),
            intensity: "fast".to_string(),
            feature_settings: Default::default(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            context_server_store,
        }
    }

    #[test]
    fn generated_tool_names_are_namespaced_and_unique() {
        let bindings = build_tool_bindings(vec![(
            ContextServerId("mcp-server-github".into()),
            vec![
                tool("Create Issue", json!({})),
                tool("create_issue", json!({})),
            ],
        )]);

        let names = bindings
            .iter()
            .map(|tool| tool.generated_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "mcp__mcp_server_github__create_issue",
                "mcp__mcp_server_github__create_issue__2",
            ]
        );
    }

    #[test]
    fn generated_tool_names_do_not_collide_with_native_tools() {
        let bindings = build_tool_bindings(vec![(
            ContextServerId("native".into()),
            vec![tool("read_file", json!({}))],
        )]);
        let native_names = native_tool_names();

        assert!(!native_names.contains(&bindings[0].generated_name));
        assert_eq!(bindings[0].generated_name, "mcp__native__read_file");
    }

    #[test]
    fn empty_schema_normalizes_to_object_parameters() {
        let bindings = build_tool_bindings(vec![(
            ContextServerId("mcp-server-slack".into()),
            vec![tool("list_channels", json!({}))],
        )]);

        assert_eq!(
            bindings[0].input_schema,
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            })
        );
    }

    #[gpui::test]
    async fn running_context_server_tools_are_listed_and_called(cx: &mut TestAppContext) {
        cx.update(|cx| {
            let settings_store = SettingsStore::test(cx);
            cx.set_global(settings_store);
        });

        let fs = fs::FakeFs::new(cx.executor());
        let worktree_store =
            cx.new(|_| WorktreeStore::local(false, fs, WorktreeIdCounter::default()));
        let registry = cx.new(|_| ContextServerDescriptorRegistry::new());
        let context_server_store =
            cx.new(|cx| ContextServerStore::test(registry, worktree_store.clone(), None, cx));
        let server_id = ContextServerId("mcp-server-github".into());
        let calls = Arc::new(Mutex::new(Vec::<CallToolParams>::new()));
        let tools = vec![tool(
            "create_issue",
            json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string"
                    }
                },
                "required": ["title"]
            }),
        )];

        let transport = create_fake_transport("mcp-server-github", cx.executor())
            .on_request::<Initialize, _>(|_params| async move {
                InitializeResponse {
                    protocol_version: ProtocolVersion(
                        context_server::types::LATEST_PROTOCOL_VERSION.to_string(),
                    ),
                    server_info: Implementation {
                        name: "mcp-server-github".to_string(),
                        title: None,
                        version: "1.0.0".to_string(),
                        description: None,
                    },
                    capabilities: ServerCapabilities {
                        tools: Some(ToolsCapabilities {
                            list_changed: Some(true),
                        }),
                        ..Default::default()
                    },
                    meta: None,
                }
            })
            .on_request::<ListTools, _>({
                let tools = tools.clone();
                move |_params| {
                    let tools = tools.clone();
                    async move {
                        ListToolsResponse {
                            tools,
                            next_cursor: None,
                            meta: None,
                        }
                    }
                }
            })
            .on_request::<CallTool, _>({
                let calls = calls.clone();
                move |params| {
                    let calls = calls.clone();
                    async move {
                        calls.lock().unwrap().push(params);
                        CallToolResponse {
                            content: vec![ToolResponseContent::Text {
                                text: "created".to_string(),
                            }],
                            is_error: Some(false),
                            meta: None,
                            structured_content: Some(json!({ "number": 1 })),
                        }
                    }
                }
            });

        context_server_store.update(cx, |store, cx| {
            store.test_start_server(
                Arc::new(ContextServer::new(server_id.clone(), Arc::new(transport))),
                cx,
            )
        });
        cx.run_until_parked();

        let mut async_cx = cx.to_async();
        let runtime = test_runtime(Some(context_server_store.clone()));
        let bindings = load_tools(&runtime, &mut async_cx).await.unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            bindings[0].generated_name,
            "mcp__mcp_server_github__create_issue"
        );

        let output = execute_tool(
            &runtime,
            &bindings[0],
            &json!({ "title": "Bug report" }),
            &mut async_cx,
        )
        .await
        .unwrap();
        assert_eq!(output["success"], true);
        assert_eq!(output["text"], "created");
        assert_eq!(output["structured_content"], json!({ "number": 1 }));

        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "create_issue");
        assert_eq!(calls[0].arguments, Some(json!({ "title": "Bug report" })));
        drop(calls);

        context_server_store.update(cx, |store, cx| {
            store.stop_server(&server_id, cx).unwrap();
        });
        let error = execute_tool(
            &runtime,
            &bindings[0],
            &json!({ "title": "Bug report" }),
            &mut async_cx,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("is not running"));
    }
}
