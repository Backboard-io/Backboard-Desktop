use anyhow::{Context as _, Result};
use collections::HashMap;
use context_server::{ContextServerCommand, ContextServerId};
use editor::{Editor, EditorElement, EditorStyle};

use gpui::{
    AsyncWindowContext, DismissEvent, Entity, EventEmitter, FocusHandle, Focusable, ScrollHandle,
    Subscription, Task, TaskExt, TextStyle, TextStyleRefinement, UnderlineStyle, WeakEntity,
    prelude::*,
};
use language::{Language, LanguageRegistry};
use markdown::{Markdown, MarkdownElement, MarkdownStyle};
use notifications::status_toast::StatusToast;
use parking_lot::Mutex;
use project::{
    context_server_store::{
        ContextServerStatus, ContextServerStore, ServerStatusChangedEvent,
        registry::ContextServerDescriptorRegistry,
    },
    project_settings::{ContextServerSettings, ProjectSettings},
    worktree_store::WorktreeStore,
};
use settings::{Settings as _, update_settings_file};
use std::{path::PathBuf, sync::Arc};
use theme_settings::ThemeSettings;
use ui::{
    CommonAnimationExt, KeyBinding, Modal, ModalFooter, ModalHeader, Section, Tooltip,
    WithScrollbar, prelude::*,
};
use ui_input::InputField;
use util::ResultExt as _;
use workspace::{ModalView, Workspace};

use crate::AddContextServer;

enum ConfigurationTarget {
    New,
    Existing {
        id: ContextServerId,
        command: ContextServerCommand,
    },
    ExistingHttp {
        id: ContextServerId,
        url: String,
        headers: HashMap<String, String>,
    },
    Extension {
        id: ContextServerId,
        repository_url: Option<SharedString>,
        installation: Option<extension::ContextServerConfiguration>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConfigurationFormKind {
    Local,
    Remote,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConfigurationViewMode {
    Form,
    Json,
}

struct CustomContextServerConfiguration {
    form: ContextServerForm,
    editor: Entity<Editor>,
    view_mode: ConfigurationViewMode,
}

impl CustomContextServerConfiguration {
    fn new(
        kind: ConfigurationFormKind,
        id: Option<ContextServerId>,
        command: Option<ContextServerCommand>,
        url: Option<String>,
        headers: HashMap<String, String>,
        jsonc_language: Option<Arc<Language>>,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let form = ContextServerForm::new(
            kind,
            id,
            command,
            url,
            headers,
            jsonc_language.clone(),
            window,
            cx,
        );
        let editor = create_json_editor(form.to_json_text(cx), jsonc_language, window, cx);

        Self {
            form,
            editor,
            view_mode: ConfigurationViewMode::Form,
        }
    }

    fn output(&self, cx: &mut App) -> Result<(ContextServerId, ContextServerSettings)> {
        match self.view_mode {
            ConfigurationViewMode::Form => self.form.output(cx),
            ConfigurationViewMode::Json => parse_json_input(&self.editor.read(cx).text(cx)),
        }
    }

    fn sync_form_to_json(&self, window: &mut Window, cx: &mut App) {
        let json = self.form.to_json_text(cx);
        self.editor
            .update(cx, |editor, cx| editor.set_text(json, window, cx));
    }

    fn sync_json_to_form(&mut self, window: &mut Window, cx: &mut App) -> Result<()> {
        let (id, settings) = parse_json_input(&self.editor.read(cx).text(cx))?;
        self.form.apply_settings(id, settings, window, cx);
        Ok(())
    }
}

struct ContextServerForm {
    kind: ConfigurationFormKind,
    name: Entity<InputField>,
    command: Entity<InputField>,
    args: Entity<Editor>,
    env: Entity<Editor>,
    url: Entity<InputField>,
    headers: Entity<Editor>,
}

impl ContextServerForm {
    fn new(
        kind: ConfigurationFormKind,
        id: Option<ContextServerId>,
        command: Option<ContextServerCommand>,
        url: Option<String>,
        headers: HashMap<String, String>,
        jsonc_language: Option<Arc<Language>>,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let name = create_text_input(
            "Name",
            match kind {
                ConfigurationFormKind::Local => "filesystem",
                ConfigurationFormKind::Remote => "remote-server",
            },
            id.as_ref().map(|id| id.0.as_ref()),
            1,
            window,
            cx,
        );

        let (command_text, args_text, env_text) = if let Some(command) = command {
            (
                Some(command.path.to_string_lossy().into_owned()),
                serde_json::to_string_pretty(&command.args).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string_pretty(&command.env.unwrap_or_default())
                    .unwrap_or_else(|_| "{}".to_string()),
            )
        } else {
            (None, String::new(), String::new())
        };

        let command = create_text_input("Command", "npx", command_text.as_deref(), 2, window, cx);
        let args = create_parameter_editor(
            args_text,
            "Arguments, for example: -y @modelcontextprotocol/server-filesystem",
            2,
            6,
            jsonc_language.clone(),
            window,
            cx,
        );
        let env = create_parameter_editor(
            env_text,
            "Environment variables, for example: API_KEY=...",
            2,
            6,
            jsonc_language.clone(),
            window,
            cx,
        );

        let url = create_text_input(
            "URL",
            "https://example.com/mcp",
            url.as_deref(),
            3,
            window,
            cx,
        );
        let headers = create_parameter_editor(
            if headers.is_empty() {
                String::new()
            } else {
                serde_json::to_string_pretty(&headers).unwrap_or_else(|_| "{}".to_string())
            },
            "Headers, for example: Authorization: Bearer <token>",
            4,
            8,
            jsonc_language,
            window,
            cx,
        );

        Self {
            kind,
            name,
            command,
            args,
            env,
            url,
            headers,
        }
    }

    fn output(&self, cx: &mut App) -> Result<(ContextServerId, ContextServerSettings)> {
        let name = self.name.read(cx).text(cx).trim().to_string();
        anyhow::ensure!(!name.is_empty(), "Server name is required");

        match self.kind {
            ConfigurationFormKind::Local => {
                let command = self.command.read(cx).text(cx).trim().to_string();
                anyhow::ensure!(!command.is_empty(), "Command is required");

                let args = parse_args_text(&self.args.read(cx).text(cx))?;
                let env = parse_key_value_text(&self.env.read(cx).text(cx), "environment")?;

                Ok((
                    ContextServerId(name.into()),
                    ContextServerSettings::Stdio {
                        enabled: true,
                        remote: false,
                        command: ContextServerCommand {
                            path: PathBuf::from(command),
                            args,
                            env: (!env.is_empty()).then_some(env),
                            timeout: None,
                        },
                    },
                ))
            }
            ConfigurationFormKind::Remote => {
                let url = self.url.read(cx).text(cx).trim().to_string();
                anyhow::ensure!(!url.is_empty(), "URL is required");
                let headers = parse_key_value_text(&self.headers.read(cx).text(cx), "headers")?;

                Ok((
                    ContextServerId(name.into()),
                    ContextServerSettings::Http {
                        enabled: true,
                        url,
                        headers,
                        timeout: None,
                    },
                ))
            }
        }
    }

    fn to_json_text(&self, cx: &App) -> String {
        let name = self.name.read(cx).text(cx).trim().to_string();
        match self.kind {
            ConfigurationFormKind::Local => {
                let command = self.command.read(cx).text(cx).trim().to_string();
                let args = parse_args_text(&self.args.read(cx).text(cx)).unwrap_or_default();
                let env = parse_key_value_text(&self.env.read(cx).text(cx), "environment")
                    .unwrap_or_default();
                context_server_input(
                    if name.is_empty() {
                        None
                    } else {
                        Some(ContextServerId(name.into()))
                    },
                    ContextServerCommand {
                        path: PathBuf::from(command),
                        args,
                        env: (!env.is_empty()).then_some(env),
                        timeout: None,
                    },
                )
            }
            ConfigurationFormKind::Remote => {
                let url = self.url.read(cx).text(cx).trim().to_string();
                let headers = parse_key_value_text(&self.headers.read(cx).text(cx), "headers")
                    .unwrap_or_default();
                context_server_http_input(
                    if name.is_empty() {
                        None
                    } else {
                        Some(ContextServerId(name.into()))
                    },
                    url,
                    headers,
                )
            }
        }
    }

    fn apply_settings(
        &mut self,
        id: ContextServerId,
        settings: ContextServerSettings,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.name.update(cx, |input, cx| {
            input.set_text(id.0.as_ref(), window, cx);
        });

        match settings {
            ContextServerSettings::Stdio { command, .. } => {
                self.kind = ConfigurationFormKind::Local;
                let command_text = command.path.to_string_lossy().into_owned();
                let args_text =
                    serde_json::to_string_pretty(&command.args).unwrap_or_else(|_| "[]".into());
                let env_text = serde_json::to_string_pretty(&command.env.unwrap_or_default())
                    .unwrap_or_else(|_| "{}".into());

                self.command.update(cx, |input, cx| {
                    input.set_text(&command_text, window, cx);
                });
                self.args
                    .update(cx, |editor, cx| editor.set_text(args_text, window, cx));
                self.env
                    .update(cx, |editor, cx| editor.set_text(env_text, window, cx));
            }
            ContextServerSettings::Http { url, headers, .. } => {
                self.kind = ConfigurationFormKind::Remote;
                let headers_text =
                    serde_json::to_string_pretty(&headers).unwrap_or_else(|_| "{}".into());

                self.url.update(cx, |input, cx| {
                    input.set_text(&url, window, cx);
                });
                self.headers
                    .update(cx, |editor, cx| editor.set_text(headers_text, window, cx));
            }
            ContextServerSettings::Extension { .. } => {}
        }
    }
}

fn create_text_input(
    label: impl Into<SharedString>,
    placeholder: &str,
    text: Option<&str>,
    tab_index: isize,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputField> {
    cx.new(|cx| {
        let input = InputField::new(window, cx, placeholder)
            .label(label)
            .tab_index(tab_index)
            .tab_stop(true);

        if let Some(text) = text {
            input.set_text(text, window, cx);
        }

        input
    })
}

fn create_parameter_editor(
    text: String,
    placeholder: &str,
    min_lines: usize,
    max_lines: usize,
    jsonc_language: Option<Arc<Language>>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Editor> {
    cx.new(|cx| {
        let mut editor = Editor::auto_height(min_lines, max_lines, window, cx);
        editor.set_text(text, window, cx);
        editor.set_placeholder_text(placeholder, window, cx);
        editor.set_show_gutter(false, cx);
        editor.set_soft_wrap_mode(language::language_settings::SoftWrap::EditorWidth, cx);
        if let Some(buffer) = editor.buffer().read(cx).as_singleton() {
            buffer.update(cx, |buffer, cx| buffer.set_language(jsonc_language, cx))
        }
        editor
    })
}

fn create_json_editor(
    json: String,
    jsonc_language: Option<Arc<Language>>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Editor> {
    cx.new(|cx| {
        let mut editor = Editor::auto_height(4, 16, window, cx);
        editor.set_text(json, window, cx);
        editor.set_show_gutter(false, cx);
        editor.set_soft_wrap_mode(language::language_settings::SoftWrap::None, cx);
        if let Some(buffer) = editor.buffer().read(cx).as_singleton() {
            buffer.update(cx, |buffer, cx| buffer.set_language(jsonc_language, cx))
        }
        editor
    })
}

fn parse_args_text(text: &str) -> Result<Vec<String>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }

    if text.starts_with('[') {
        return serde_json_lenient::from_str::<Vec<String>>(text)
            .context("Arguments must be a JSON array of strings");
    }

    Ok(text.split_whitespace().map(str::to_string).collect())
}

fn parse_key_value_text(text: &str, label: &str) -> Result<HashMap<String, String>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(HashMap::default());
    }

    if text.starts_with('{') {
        return serde_json_lenient::from_str::<HashMap<String, String>>(text)
            .with_context(|| format!("{label} must be a JSON object with string values"));
    }

    let mut values = HashMap::default();
    for (ix, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        let Some((key, value)) = line.split_once('=').or_else(|| line.split_once(':')) else {
            anyhow::bail!(
                "{} line {} must use KEY=VALUE or Header: Value",
                label,
                ix + 1
            );
        };
        let key = key.trim();
        anyhow::ensure!(
            !key.is_empty(),
            "{} line {} has an empty key",
            label,
            ix + 1
        );
        values.insert(key.to_string(), value.trim().to_string());
    }

    Ok(values)
}

fn context_server_input(id: Option<ContextServerId>, command: ContextServerCommand) -> String {
    let name = id
        .map(|id| id.0.to_string())
        .unwrap_or_else(|| "some-mcp-server".to_string());
    let name = serde_json::to_string(&name).unwrap_or_else(|_| "\"some-mcp-server\"".to_string());
    let command_path = serde_json::to_string(&command.path).unwrap_or_else(|_| "\"\"".to_string());
    let args = serde_json::to_string_pretty(&command.args).unwrap_or_else(|_| "[]".to_string());
    let env = serde_json::to_string_pretty(&command.env.unwrap_or_default())
        .unwrap_or_else(|_| "{}".to_string());

    format!(
        r#"{{
  /// Configure an MCP server that runs locally via stdin/stdout
  ///
  /// The name of your MCP server
  {name}: {{
    /// The command which runs the MCP server
    "command": {command_path},
    /// The arguments to pass to the MCP server
    "args": {args},
    /// The environment variables to set
    "env": {env}
  }}
}}"#
    )
}

fn context_server_http_input(
    id: Option<ContextServerId>,
    url: String,
    headers: HashMap<String, String>,
) -> String {
    let name = id
        .map(|id| id.0.to_string())
        .unwrap_or_else(|| "some-remote-server".to_string());
    let name =
        serde_json::to_string(&name).unwrap_or_else(|_| "\"some-remote-server\"".to_string());
    let url = serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".to_string());
    let headers = serde_json::to_string_pretty(&headers).unwrap_or_else(|_| "{}".to_string());

    format!(
        r#"{{
  /// Configure an MCP server that you connect to over HTTP
  ///
  /// The name of your remote MCP server
  {name}: {{
    /// The URL of the remote MCP server
    "url": {url},
    /// Any headers to send along
    "headers": {headers}
  }}
}}"#
    )
}

fn parse_json_input(text: &str) -> Result<(ContextServerId, ContextServerSettings)> {
    let value: serde_json::Value = serde_json_lenient::from_str(text)?;
    let object = value.as_object().context("Expected object")?;
    anyhow::ensure!(
        object.len() == 1,
        "Expected exactly one context server configuration"
    );

    let (context_server_name, value) = object.into_iter().next().unwrap();
    if value.get("url").is_some() {
        let url = value
            .get("url")
            .and_then(|value| value.as_str())
            .context("Remote MCP server URL is required")?
            .to_string();
        let headers = value
            .get("headers")
            .map(|headers| serde_json::from_value::<HashMap<String, String>>(headers.clone()))
            .transpose()
            .context("Headers must be an object with string values")?
            .unwrap_or_default();

        Ok((
            ContextServerId(context_server_name.clone().into()),
            ContextServerSettings::Http {
                enabled: true,
                url,
                headers,
                timeout: None,
            },
        ))
    } else {
        let command: ContextServerCommand = serde_json::from_value(value.clone())?;
        Ok((
            ContextServerId(context_server_name.clone().into()),
            ContextServerSettings::Stdio {
                enabled: true,
                remote: false,
                command,
            },
        ))
    }
}

enum ConfigurationSource {
    New {
        configuration: CustomContextServerConfiguration,
    },
    Existing {
        configuration: CustomContextServerConfiguration,
    },
    Extension {
        id: ContextServerId,
        editor: Option<Entity<Editor>>,
        repository_url: Option<SharedString>,
        installation_instructions: Option<Entity<markdown::Markdown>>,
        settings_validator: Option<jsonschema::Validator>,
    },
}

impl ConfigurationSource {
    fn has_configuration_options(&self) -> bool {
        !matches!(self, ConfigurationSource::Extension { editor: None, .. })
    }

    fn is_new(&self) -> bool {
        matches!(self, ConfigurationSource::New { .. })
    }

    fn from_target(
        target: ConfigurationTarget,
        language_registry: Arc<LanguageRegistry>,
        jsonc_language: Option<Arc<Language>>,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        match target {
            ConfigurationTarget::New => ConfigurationSource::New {
                configuration: CustomContextServerConfiguration::new(
                    ConfigurationFormKind::Local,
                    None,
                    None,
                    None,
                    HashMap::default(),
                    jsonc_language,
                    window,
                    cx,
                ),
            },
            ConfigurationTarget::Existing { id, command } => ConfigurationSource::Existing {
                configuration: CustomContextServerConfiguration::new(
                    ConfigurationFormKind::Local,
                    Some(id),
                    Some(command),
                    None,
                    HashMap::default(),
                    jsonc_language,
                    window,
                    cx,
                ),
            },
            ConfigurationTarget::ExistingHttp {
                id,
                url,
                headers: auth,
            } => ConfigurationSource::Existing {
                configuration: CustomContextServerConfiguration::new(
                    ConfigurationFormKind::Remote,
                    Some(id),
                    None,
                    Some(url),
                    auth,
                    jsonc_language,
                    window,
                    cx,
                ),
            },
            ConfigurationTarget::Extension {
                id,
                repository_url,
                installation,
            } => {
                let settings_validator = installation.as_ref().and_then(|installation| {
                    jsonschema::validator_for(&installation.settings_schema)
                        .context("Failed to load JSON schema for context server settings")
                        .log_err()
                });
                let installation_instructions = installation.as_ref().map(|installation| {
                    let installation_instructions = installation
                        .installation_instructions
                        .replace("In your Zed settings", "In your Backboard Studio settings");
                    cx.new(|cx| {
                        Markdown::new(
                            installation_instructions.into(),
                            Some(language_registry.clone()),
                            None,
                            cx,
                        )
                    })
                });
                ConfigurationSource::Extension {
                    id,
                    repository_url,
                    installation_instructions,
                    settings_validator,
                    editor: installation.map(|installation| {
                        create_json_editor(
                            installation.default_settings,
                            jsonc_language,
                            window,
                            cx,
                        )
                    }),
                }
            }
        }
    }

    fn output(&self, cx: &mut App) -> Result<(ContextServerId, ContextServerSettings)> {
        match self {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => configuration.output(cx),
            ConfigurationSource::Extension {
                id,
                editor,
                settings_validator,
                ..
            } => {
                let text = editor
                    .as_ref()
                    .context("No output available")?
                    .read(cx)
                    .text(cx);
                let settings = serde_json_lenient::from_str::<serde_json::Value>(&text)?;
                if let Some(settings_validator) = settings_validator
                    && let Err(error) = settings_validator.validate(&settings)
                {
                    return Err(anyhow::anyhow!(error.to_string()));
                }
                Ok((
                    id.clone(),
                    ContextServerSettings::Extension {
                        enabled: true,
                        remote: false,
                        settings,
                    },
                ))
            }
        }
    }
}

fn resolve_context_server_extension(
    id: ContextServerId,
    worktree_store: Entity<WorktreeStore>,
    cx: &mut App,
) -> Task<Option<ConfigurationTarget>> {
    let registry = ContextServerDescriptorRegistry::default_global(cx).read(cx);

    let Some(descriptor) = registry.context_server_descriptor(&id.0) else {
        return Task::ready(None);
    };

    let extension = crate::agent_configuration::resolve_extension_for_context_server(&id, cx);
    cx.spawn(async move |cx| {
        let installation = descriptor
            .configuration(worktree_store, cx)
            .await
            .context("Failed to resolve context server configuration")
            .log_err()
            .flatten();

        Some(ConfigurationTarget::Extension {
            id,
            repository_url: extension
                .and_then(|(_, manifest)| manifest.repository.clone().map(SharedString::from)),
            installation,
        })
    })
}

enum State {
    Idle,
    Waiting,
    AuthRequired { server_id: ContextServerId },
    Authenticating { _server_id: ContextServerId },
    Error(SharedString),
}

pub struct ConfigureContextServerModal {
    context_server_store: Entity<ContextServerStore>,
    workspace: WeakEntity<Workspace>,
    source: ConfigurationSource,
    state: State,
    original_server_id: Option<ContextServerId>,
    scroll_handle: ScrollHandle,
    _auth_subscription: Option<Subscription>,
}

impl ConfigureContextServerModal {
    pub fn register(
        workspace: &mut Workspace,
        language_registry: Arc<LanguageRegistry>,
        _window: Option<&mut Window>,
        _cx: &mut Context<Workspace>,
    ) {
        workspace.register_action({
            move |_workspace, _: &AddContextServer, window, cx| {
                let workspace_handle = cx.weak_entity();
                let language_registry = language_registry.clone();
                window
                    .spawn(cx, async move |cx| {
                        Self::show_modal(
                            ConfigurationTarget::New,
                            language_registry,
                            workspace_handle,
                            cx,
                        )
                        .await
                    })
                    .detach_and_log_err(cx);
            }
        });
    }

    pub fn show_modal_for_existing_server(
        server_id: ContextServerId,
        language_registry: Arc<LanguageRegistry>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<()>> {
        let Some(settings) = ProjectSettings::get_global(cx)
            .context_servers
            .get(&server_id.0)
            .cloned()
            .or_else(|| {
                ContextServerDescriptorRegistry::default_global(cx)
                    .read(cx)
                    .context_server_descriptor(&server_id.0)
                    .map(|_| ContextServerSettings::default_extension())
            })
        else {
            return Task::ready(Err(anyhow::anyhow!("Context server not found")));
        };

        window.spawn(cx, async move |cx| {
            let target = match settings {
                ContextServerSettings::Stdio {
                    enabled: _,
                    command,
                    ..
                } => Some(ConfigurationTarget::Existing {
                    id: server_id,
                    command,
                }),
                ContextServerSettings::Http {
                    enabled: _,
                    url,
                    headers,
                    timeout: _,
                    ..
                } => Some(ConfigurationTarget::ExistingHttp {
                    id: server_id,
                    url,
                    headers,
                }),
                ContextServerSettings::Extension { .. } => {
                    match workspace
                        .update(cx, |workspace, cx| {
                            resolve_context_server_extension(
                                server_id,
                                workspace.project().read(cx).worktree_store(),
                                cx,
                            )
                        })
                        .ok()
                    {
                        Some(task) => task.await,
                        None => None,
                    }
                }
            };

            match target {
                Some(target) => Self::show_modal(target, language_registry, workspace, cx).await,
                None => Err(anyhow::anyhow!("Failed to resolve context server")),
            }
        })
    }

    fn show_modal(
        target: ConfigurationTarget,
        language_registry: Arc<LanguageRegistry>,
        workspace: WeakEntity<Workspace>,
        cx: &mut AsyncWindowContext,
    ) -> Task<Result<()>> {
        cx.spawn(async move |cx| {
            let jsonc_language = language_registry.language_for_name("jsonc").await.ok();
            workspace.update_in(cx, |workspace, window, cx| {
                let workspace_handle = cx.weak_entity();
                let context_server_store = workspace.project().read(cx).context_server_store();
                workspace.toggle_modal(window, cx, |window, cx| Self {
                    context_server_store,
                    workspace: workspace_handle,
                    state: State::Idle,
                    original_server_id: match &target {
                        ConfigurationTarget::Existing { id, .. } => Some(id.clone()),
                        ConfigurationTarget::ExistingHttp { id, .. } => Some(id.clone()),
                        ConfigurationTarget::Extension { id, .. } => Some(id.clone()),
                        ConfigurationTarget::New => None,
                    },
                    source: ConfigurationSource::from_target(
                        target,
                        language_registry,
                        jsonc_language,
                        window,
                        cx,
                    ),
                    scroll_handle: ScrollHandle::new(),
                    _auth_subscription: None,
                })
            })
        })
    }

    fn set_error(&mut self, err: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.state = State::Error(err.into());
        cx.notify();
    }

    fn confirm(&mut self, _: &menu::Confirm, cx: &mut Context<Self>) {
        if matches!(
            self.state,
            State::Waiting | State::AuthRequired { .. } | State::Authenticating { .. }
        ) {
            return;
        }

        self.state = State::Idle;
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };

        let (id, settings) = match self.source.output(cx) {
            Ok(val) => val,
            Err(error) => {
                self.set_error(error.to_string(), cx);
                return;
            }
        };

        self.state = State::Waiting;

        let existing_server = self.context_server_store.read(cx).get_running_server(&id);
        if existing_server.is_some() {
            self.context_server_store.update(cx, |store, cx| {
                store.stop_server(&id, cx).log_err();
            });
        }

        let wait_for_context_server_task =
            wait_for_context_server(&self.context_server_store, id.clone(), cx);
        cx.spawn({
            let id = id.clone();
            async move |this, cx| {
                let result = wait_for_context_server_task.await;
                this.update(cx, |this, cx| match result {
                    Ok(ContextServerStatus::Running) => {
                        this.state = State::Idle;
                        this.show_configured_context_server_toast(id, cx);
                        cx.emit(DismissEvent);
                    }
                    Ok(ContextServerStatus::AuthRequired) => {
                        this.state = State::AuthRequired { server_id: id };
                        cx.notify();
                    }
                    Err(err) => {
                        this.set_error(err, cx);
                    }
                    Ok(_) => {}
                })
            }
        })
        .detach();

        let settings_changed =
            ProjectSettings::get_global(cx).context_servers.get(&id.0) != Some(&settings);

        if settings_changed {
            // When we write the settings to the file, the context server will be restarted.
            workspace.update(cx, |workspace, cx| {
                let fs = workspace.app_state().fs.clone();
                let original_server_id = self.original_server_id.clone();
                update_settings_file(fs.clone(), cx, move |current, _| {
                    if let Some(original_id) = original_server_id {
                        if original_id != id {
                            current.project.context_servers.remove(&original_id.0);
                        }
                    }
                    current
                        .project
                        .context_servers
                        .insert(id.0, settings.into());
                });
            });
        } else if let Some(existing_server) = existing_server {
            self.context_server_store
                .update(cx, |store, cx| store.start_server(existing_server, cx));
        }
    }

    fn cancel(&mut self, _: &menu::Cancel, cx: &mut Context<Self>) {
        cx.emit(DismissEvent);
    }

    fn authenticate(&mut self, server_id: ContextServerId, cx: &mut Context<Self>) {
        self.context_server_store.update(cx, |store, cx| {
            store.authenticate_server(&server_id, cx).log_err();
        });

        self.state = State::Authenticating {
            _server_id: server_id.clone(),
        };

        self._auth_subscription = Some(cx.subscribe(
            &self.context_server_store,
            move |this, _, event: &ServerStatusChangedEvent, cx| {
                if event.server_id != server_id {
                    return;
                }
                match &event.status {
                    ContextServerStatus::Running => {
                        this._auth_subscription = None;
                        this.state = State::Idle;
                        this.show_configured_context_server_toast(event.server_id.clone(), cx);
                        cx.emit(DismissEvent);
                    }
                    ContextServerStatus::AuthRequired => {
                        this._auth_subscription = None;
                        this.state = State::AuthRequired {
                            server_id: event.server_id.clone(),
                        };
                        cx.notify();
                    }
                    ContextServerStatus::Error(error) => {
                        this._auth_subscription = None;
                        this.set_error(error.clone(), cx);
                    }
                    ContextServerStatus::Authenticating
                    | ContextServerStatus::Starting
                    | ContextServerStatus::Stopped => {}
                }
            },
        ));

        cx.notify();
    }

    fn show_configured_context_server_toast(&self, id: ContextServerId, cx: &mut App) {
        self.workspace
            .update(cx, {
                |workspace, cx| {
                    let status_toast = StatusToast::new(
                        format!("{} configured successfully.", id.0),
                        cx,
                        |this, _cx| {
                            this.icon(
                                Icon::new(IconName::ToolHammer)
                                    .size(IconSize::Small)
                                    .color(Color::Muted),
                            )
                            .action("Dismiss", |_, _| {})
                        },
                    );

                    workspace.toggle_status_toast(status_toast, cx);
                }
            })
            .log_err();
    }
}

impl ModalView for ConfigureContextServerModal {}

impl Focusable for ConfigureContextServerModal {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        match &self.source {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => match configuration.view_mode {
                ConfigurationViewMode::Form => configuration.form.name.focus_handle(cx),
                ConfigurationViewMode::Json => configuration.editor.focus_handle(cx),
            },
            ConfigurationSource::Extension { editor, .. } => editor
                .as_ref()
                .map(|editor| editor.focus_handle(cx))
                .unwrap_or_else(|| cx.focus_handle()),
        }
    }
}

impl EventEmitter<DismissEvent> for ConfigureContextServerModal {}

impl ConfigureContextServerModal {
    fn render_modal_header(&self) -> ModalHeader {
        let text: SharedString = match &self.source {
            ConfigurationSource::New { .. } => "Add MCP Server".into(),
            ConfigurationSource::Existing { .. } => "Configure MCP Server".into(),
            ConfigurationSource::Extension { id, .. } => format!("Configure {}", id.0).into(),
        };
        ModalHeader::new().headline(text)
    }

    fn render_modal_description(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        const MODAL_DESCRIPTION: &str =
            "Check the server docs for required arguments and environment variables.";

        if let ConfigurationSource::Extension {
            installation_instructions: Some(installation_instructions),
            ..
        } = &self.source
        {
            div()
                .pb_2()
                .text_sm()
                .child(MarkdownElement::new(
                    installation_instructions.clone(),
                    default_markdown_style(window, cx),
                ))
                .into_any_element()
        } else {
            Label::new(MODAL_DESCRIPTION)
                .color(Color::Muted)
                .into_any_element()
        }
    }

    fn render_tab_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let kind = match &self.source {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => configuration.form.kind,
            _ => return None,
        };

        let tab = |label: &'static str, active: bool| {
            div()
                .id(label)
                .cursor_pointer()
                .p_1()
                .text_sm()
                .border_b_1()
                .when(active, |this| {
                    this.border_color(cx.theme().colors().border_focused)
                })
                .when(!active, |this| {
                    this.border_color(gpui::transparent_black())
                        .text_color(cx.theme().colors().text_muted)
                        .hover(|s| s.text_color(cx.theme().colors().text))
                })
                .child(label)
        };

        Some(
            h_flex()
                .pt_1()
                .mb_2p5()
                .gap_1()
                .border_b_1()
                .border_color(cx.theme().colors().border.opacity(0.5))
                .child(
                    tab("Local", kind == ConfigurationFormKind::Local).on_click(cx.listener(
                        |this, _, window, cx| {
                            match &mut this.source {
                                ConfigurationSource::New { configuration }
                                | ConfigurationSource::Existing { configuration } => {
                                    configuration.form.kind = ConfigurationFormKind::Local;
                                    if configuration.view_mode == ConfigurationViewMode::Json {
                                        configuration.sync_form_to_json(window, cx);
                                    }
                                }
                                ConfigurationSource::Extension { .. } => {}
                            }
                            cx.notify();
                        },
                    )),
                )
                .child(
                    tab("Remote", kind == ConfigurationFormKind::Remote).on_click(cx.listener(
                        |this, _, window, cx| {
                            match &mut this.source {
                                ConfigurationSource::New { configuration }
                                | ConfigurationSource::Existing { configuration } => {
                                    configuration.form.kind = ConfigurationFormKind::Remote;
                                    if configuration.view_mode == ConfigurationViewMode::Json {
                                        configuration.sync_form_to_json(window, cx);
                                    }
                                }
                                ConfigurationSource::Extension { .. } => {}
                            }
                            cx.notify();
                        },
                    )),
                )
                .into_any_element(),
        )
    }

    fn render_editor_box(&self, editor: &Entity<Editor>, cx: &App) -> Div {
        div()
            .p_2()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().editor_background)
            .child({
                let settings = ThemeSettings::get_global(cx);
                let text_style = TextStyle {
                    color: cx.theme().colors().text,
                    font_family: settings.buffer_font.family.clone(),
                    font_fallbacks: settings.buffer_font.fallbacks.clone(),
                    font_size: settings.buffer_font_size(cx).into(),
                    font_weight: settings.buffer_font.weight,
                    line_height: relative(settings.buffer_line_height.value()),
                    ..Default::default()
                };
                EditorElement::new(
                    editor,
                    EditorStyle {
                        background: cx.theme().colors().editor_background,
                        local_player: cx.theme().players().local(),
                        text: text_style,
                        syntax: cx.theme().syntax().clone(),
                        ..Default::default()
                    },
                )
            })
    }

    fn render_parameter_field(
        &self,
        label: &'static str,
        description: &'static str,
        editor: &Entity<Editor>,
        cx: &App,
    ) -> Div {
        v_flex()
            .gap_1()
            .child(Label::new(label).size(LabelSize::Small))
            .child(
                Label::new(description)
                    .size(LabelSize::XSmall)
                    .color(Color::Muted),
            )
            .child(self.render_editor_box(editor, cx))
    }

    fn render_form_content(&self, form: &ContextServerForm, cx: &App) -> AnyElement {
        v_flex()
            .gap_3()
            .child(form.name.clone())
            .child(match form.kind {
                ConfigurationFormKind::Local => v_flex()
                    .gap_3()
                    .child(
                        Label::new("Runs locally via stdin/stdout.")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(form.command.clone())
                    .child(self.render_parameter_field(
                        "Arguments",
                        "Use space-separated arguments or a JSON array.",
                        &form.args,
                        cx,
                    ))
                    .child(self.render_parameter_field(
                        "Environment variables",
                        "Use KEY=VALUE lines or a JSON object.",
                        &form.env,
                        cx,
                    )),
                ConfigurationFormKind::Remote => v_flex()
                    .gap_3()
                    .child(
                        Label::new("Connects to a remote MCP server over HTTP.")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(form.url.clone())
                    .child(self.render_parameter_field(
                        "Headers",
                        "Use Header: Value lines or a JSON object.",
                        &form.headers,
                        cx,
                    )),
            })
            .into_any_element()
    }

    fn render_modal_content(&self, cx: &App) -> AnyElement {
        match &self.source {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => match configuration.view_mode {
                ConfigurationViewMode::Form => self.render_form_content(&configuration.form, cx),
                ConfigurationViewMode::Json => self
                    .render_editor_box(&configuration.editor, cx)
                    .into_any_element(),
            },
            ConfigurationSource::Extension { editor, .. } => {
                let Some(editor) = editor else {
                    return div().into_any_element();
                };
                self.render_editor_box(editor, cx).into_any_element()
            }
        }
    }

    fn toggle_configuration_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &mut self.source {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => match configuration.view_mode {
                ConfigurationViewMode::Form => {
                    configuration.sync_form_to_json(window, cx);
                    configuration.view_mode = ConfigurationViewMode::Json;
                    self.state = State::Idle;
                    configuration.editor.focus_handle(cx).focus(window, cx);
                }
                ConfigurationViewMode::Json => {
                    if let Err(error) = configuration.sync_json_to_form(window, cx) {
                        self.set_error(error.to_string(), cx);
                        return;
                    }
                    configuration.view_mode = ConfigurationViewMode::Form;
                    self.state = State::Idle;
                    configuration.form.name.focus_handle(cx).focus(window, cx);
                }
            },
            ConfigurationSource::Extension { .. } => {}
        }

        cx.notify();
    }

    fn render_modal_footer(&self, cx: &mut Context<Self>) -> ModalFooter {
        let focus_handle = self.focus_handle(cx);
        let is_busy = matches!(
            self.state,
            State::Waiting | State::AuthRequired { .. } | State::Authenticating { .. }
        );
        let view_toggle_label = match &self.source {
            ConfigurationSource::New { configuration }
            | ConfigurationSource::Existing { configuration } => match configuration.view_mode {
                ConfigurationViewMode::Form => Some("JSON View"),
                ConfigurationViewMode::Json => Some("Form View"),
            },
            ConfigurationSource::Extension { .. } => None,
        };

        ModalFooter::new()
            .start_slot::<Button>(if let Some(label) = view_toggle_label {
                Some(
                    Button::new("toggle-configuration-view", label)
                        .style(ButtonStyle::Outlined)
                        .label_size(LabelSize::Small)
                        .on_click(cx.listener(|this, _event, window, cx| {
                            this.toggle_configuration_view(window, cx);
                        })),
                )
            } else if let ConfigurationSource::Extension {
                repository_url: Some(repository_url),
                ..
            } = &self.source
            {
                Some(
                    Button::new("open-repository", "Open Repository")
                        .end_icon(
                            Icon::new(IconName::ArrowUpRight)
                                .size(IconSize::Small)
                                .color(Color::Muted),
                        )
                        .tooltip({
                            let repository_url = repository_url.clone();
                            move |_window, cx| {
                                Tooltip::with_meta(
                                    "Open Repository",
                                    None,
                                    repository_url.clone(),
                                    cx,
                                )
                            }
                        })
                        .on_click({
                            let repository_url = repository_url.clone();
                            move |_, _, cx| cx.open_url(&repository_url)
                        }),
                )
            } else {
                None
            })
            .end_slot(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new(
                            "cancel",
                            if self.source.has_configuration_options() {
                                "Cancel"
                            } else {
                                "Dismiss"
                            },
                        )
                        .key_binding(
                            KeyBinding::for_action_in(&menu::Cancel, &focus_handle, cx)
                                .map(|kb| kb.size(rems_from_px(12.))),
                        )
                        .on_click(
                            cx.listener(|this, _event, _window, cx| this.cancel(&menu::Cancel, cx)),
                        ),
                    )
                    .children(self.source.has_configuration_options().then(|| {
                        Button::new(
                            "add-server",
                            if self.source.is_new() {
                                "Add Server"
                            } else {
                                "Configure Server"
                            },
                        )
                        .disabled(is_busy)
                        .key_binding(
                            KeyBinding::for_action_in(&menu::Confirm, &focus_handle, cx)
                                .map(|kb| kb.size(rems_from_px(12.))),
                        )
                        .on_click(
                            cx.listener(|this, _event, _window, cx| {
                                this.confirm(&menu::Confirm, cx)
                            }),
                        )
                    })),
            )
    }

    fn render_loading(&self, label: impl Into<SharedString>) -> Div {
        h_flex()
            .h_8()
            .gap_1p5()
            .justify_center()
            .child(
                Icon::new(IconName::LoadCircle)
                    .size(IconSize::XSmall)
                    .color(Color::Muted)
                    .with_rotate_animation(3),
            )
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
    }

    fn render_auth_required(&self, server_id: &ContextServerId, cx: &mut Context<Self>) -> Div {
        h_flex()
            .h_8()
            .min_w_0()
            .w_full()
            .gap_2()
            .justify_center()
            .child(
                h_flex()
                    .gap_1p5()
                    .child(
                        Icon::new(IconName::Info)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new("Authenticate to connect this server")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .child(
                Button::new("authenticate-server", "Authenticate")
                    .style(ButtonStyle::Outlined)
                    .label_size(LabelSize::Small)
                    .on_click({
                        let server_id = server_id.clone();
                        cx.listener(move |this, _event, _window, cx| {
                            this.authenticate(server_id.clone(), cx);
                        })
                    }),
            )
    }

    fn render_modal_error(error: SharedString) -> Div {
        h_flex()
            .h_8()
            .gap_1p5()
            .justify_center()
            .child(
                Icon::new(IconName::Warning)
                    .size(IconSize::Small)
                    .color(Color::Warning),
            )
            .child(
                div()
                    .w_full()
                    .child(Label::new(error).size(LabelSize::Small).color(Color::Muted)),
            )
    }
}

impl Render for ConfigureContextServerModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .elevation_3(cx)
            .w(rems(40.))
            .key_context("ConfigureContextServerModal")
            .on_action(
                cx.listener(|this, _: &menu::Cancel, _window, cx| this.cancel(&menu::Cancel, cx)),
            )
            .on_action(
                cx.listener(|this, _: &menu::Confirm, _window, cx| {
                    this.confirm(&menu::Confirm, cx)
                }),
            )
            .capture_any_mouse_down(cx.listener(|this, _, window, cx| {
                this.focus_handle(cx).focus(window, cx);
            }))
            .child(
                Modal::new("configure-context-server", None)
                    .header(self.render_modal_header())
                    .section(
                        Section::new().child(
                            div()
                                .size_full()
                                .child(
                                    div()
                                        .id("modal-content")
                                        .max_h(vh(0.7, window))
                                        .overflow_y_scroll()
                                        .track_scroll(&self.scroll_handle)
                                        .child(self.render_modal_description(window, cx))
                                        .children(self.render_tab_bar(cx))
                                        .child(self.render_modal_content(cx))
                                        .child(match &self.state {
                                            State::Idle => div(),
                                            State::Waiting => {
                                                self.render_loading("Connecting Server…")
                                            }
                                            State::AuthRequired { server_id } => {
                                                self.render_auth_required(&server_id.clone(), cx)
                                            }
                                            State::Authenticating { .. } => {
                                                self.render_loading("Authenticating…")
                                            }
                                            State::Error(error) => {
                                                Self::render_modal_error(error.clone())
                                            }
                                        }),
                                )
                                .vertical_scrollbar_for(&self.scroll_handle, window, cx),
                        ),
                    )
                    .footer(self.render_modal_footer(cx)),
            )
    }
}

fn wait_for_context_server(
    context_server_store: &Entity<ContextServerStore>,
    context_server_id: ContextServerId,
    cx: &mut App,
) -> Task<Result<ContextServerStatus, Arc<str>>> {
    use std::time::Duration;

    const WAIT_TIMEOUT: Duration = Duration::from_secs(120);

    let (tx, rx) = futures::channel::oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let context_server_id_for_timeout = context_server_id.clone();
    let subscription = cx.subscribe(context_server_store, move |_, event, _cx| {
        let ServerStatusChangedEvent { server_id, status } = event;

        if server_id != &context_server_id {
            return;
        }

        match status {
            ContextServerStatus::Running | ContextServerStatus::AuthRequired => {
                if let Some(tx) = tx.lock().take() {
                    let _ = tx.send(Ok(status.clone()));
                }
            }
            ContextServerStatus::Stopped => {
                if let Some(tx) = tx.lock().take() {
                    let _ = tx.send(Err("Context server stopped running".into()));
                }
            }
            ContextServerStatus::Error(error) => {
                if let Some(tx) = tx.lock().take() {
                    let _ = tx.send(Err(error.clone()));
                }
            }
            ContextServerStatus::Starting | ContextServerStatus::Authenticating => {}
        }
    });

    cx.spawn(async move |cx| {
        let timeout = cx.background_executor().timer(WAIT_TIMEOUT);
        let result = futures::future::select(rx, timeout).await;
        drop(subscription);
        match result {
            futures::future::Either::Left((Ok(inner), _)) => inner,
            futures::future::Either::Left((Err(_), _)) => {
                Err(Arc::from("Context server store was dropped"))
            }
            futures::future::Either::Right(_) => Err(Arc::from(format!(
                "Timed out waiting for context server `{}` to start. Check the Backboard Studio log for details.",
                context_server_id_for_timeout
            ))),
        }
    })
}

pub(crate) fn default_markdown_style(window: &Window, cx: &App) -> MarkdownStyle {
    let theme_settings = ThemeSettings::get_global(cx);
    let colors = cx.theme().colors();
    let mut text_style = window.text_style();
    text_style.refine(&TextStyleRefinement {
        font_family: Some(theme_settings.ui_font.family.clone()),
        font_fallbacks: theme_settings.ui_font.fallbacks.clone(),
        font_features: Some(theme_settings.ui_font.features.clone()),
        font_size: Some(TextSize::XSmall.rems(cx).into()),
        color: Some(colors.text_muted),
        ..Default::default()
    });

    MarkdownStyle {
        base_text_style: text_style.clone(),
        selection_background_color: colors.element_selection_background,
        link: TextStyleRefinement {
            background_color: Some(colors.editor_foreground.opacity(0.025)),
            underline: Some(UnderlineStyle {
                color: Some(colors.text_accent.opacity(0.5)),
                thickness: px(1.),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    }
}
