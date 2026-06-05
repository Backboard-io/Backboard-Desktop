use std::{
    path::{Component, Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result, anyhow};
use editor::Editor;
use futures::StreamExt as _;
use gpui::{
    Action, AnyElement, App, AppContext as _, AsyncWindowContext, Context, DismissEvent, Div,
    Entity, EventEmitter, FocusHandle, Focusable, FontWeight, Hsla, MouseButton, ParentElement,
    Render, SharedString, Stateful, Styled, Subscription, Task, WeakEntity, Window, actions, div,
    px, rgb,
};
use serde_json::{Value, json};
use ui::{
    Button, ButtonStyle, Color, CommonAnimationExt, Divider, Icon, IconButton, IconName, Label,
    LabelSize, Tooltip, prelude::*,
};
use util::ResultExt;
use workspace::{
    ModalView, Workspace, WorkspaceTourStep,
    dock::{DockPosition, Panel, PanelEvent},
    render_workspace_tour_highlight,
};
use zed_actions::ConfigureBackboardApiKey;

const BACKBOARD_PANEL_KEY: &str = "backboard_panel";
const DEFAULT_WIDTH: gpui::Pixels = px(380.);
const INITIAL_VISIBLE_MODELS: usize = 120;
const MODEL_LOAD_INCREMENT: usize = 120;
const ACTIVITY_LIMIT: usize = 24;
const LOADING_TICK_MS: u64 = 900;
const INLINE_COMPLETION_CHUNK_OUTPUT_DELAY_MILLIS: u64 = 80;
const LOADING_COPY: &[&str] = &[
    "Initializing everything...",
    "Loading tiny pixels...",
    "Waking up the servers...",
    "Summoning the interface...",
    "Mining fresh data...",
    "Crafting the dashboard...",
    "Generating terrain...",
    "Finding cool stuff...",
    "Loading your world...",
    "Spawning components...",
    "Booting the vibes...",
    "Calibrating buttons...",
    "Preparing inventory...",
    "Fetching the good stuff...",
    "Dusting off the database...",
    "Counting blocks...",
    "Placing pixels...",
    "Charging crystals...",
    "Rendering magic...",
    "Checking coordinates...",
    "Opening the portal...",
    "Syncing reality...",
    "Polishing the UI...",
    "Summoning menus...",
    "Taming loading bar...",
    "Building something cool...",
    "Sharpening tools...",
    "Mixing potions...",
    "Heating up the engine...",
    "Feeding the hamsters...",
    "Untangling cables...",
    "Aligning stars...",
    "Connecting the dots...",
    "Rolling for luck...",
    "Planting ideas...",
    "Harvesting results...",
    "Brewing something useful...",
    "Scanning nearby chunks...",
    "Optimizing the chaos...",
    "Preparing your adventure...",
    "Lighting torches...",
    "Avoiding creepers...",
    "Saving progress...",
    "Loading secret sauce...",
    "Creating possibilities...",
    "Deploying imagination...",
    "Gathering resources...",
    "Assembling blocks...",
    "Forging the experience...",
    "Finding diamonds...",
    "Filtering good ideas...",
    "Spawning greatness...",
    "Crafting the next screen...",
    "Checking if this works...",
    "Making things happen...",
    "Doing computer stuff...",
    "Convincing servers nicely...",
    "Talking to the cloud...",
    "Consulting the algorithm...",
    "Searching the void...",
    "Querying the universe...",
    "Fetching hidden treasures...",
    "Preparing scan results...",
    "Almost there...",
    "Still cooking...",
    "Hold up, magic is happening...",
    "One sec, building it...",
    "Loading the good bits...",
    "Getting things ready...",
    "Making it shiny...",
    "Organizing chaos...",
    "Smoothing the corners...",
    "Adding extra sauce...",
    "Making this look expensive...",
    "Turning pixels into vibes...",
    "Opening the command center...",
    "Running final checks...",
    "Almost done crafting...",
];

actions!(
    backboard,
    [
        /// Toggles focus for the Backboard chat panel.
        ToggleFocus,
        /// Starts a fresh Backboard chat draft.
        NewChat,
        /// Saves the Backboard API key into the shared CLI config.
        SaveApiKey,
        /// Sends the current Backboard chat draft.
        SendPrompt,
    ]
);

const API_MODAL_OVERLAY: Hsla = Hsla {
    h: 240. / 360.,
    s: 0.33,
    l: 0.03,
    a: 0.20,
};

fn api_modal_color(hex: u32) -> Hsla {
    Hsla::from(rgb(hex))
}

pub fn backboard_api_key_is_connected() -> bool {
    backboard::BackboardConfig::load_or_default()
        .api_key()
        .is_some()
}

pub fn show_backboard_api_key_modal(
    workspace: &mut Workspace,
    window: &mut Window,
    cx: &mut App,
    on_api_key_state_changed: impl Fn(&mut App) + 'static,
) {
    show_backboard_api_key_modal_with_dismiss(
        workspace,
        window,
        cx,
        on_api_key_state_changed,
        None,
    );
}

pub fn show_backboard_api_key_modal_with_dismiss(
    workspace: &mut Workspace,
    window: &mut Window,
    cx: &mut App,
    on_api_key_state_changed: impl Fn(&mut App) + 'static,
    on_dismiss: Option<Box<dyn FnOnce(&mut Window, &mut App) + 'static>>,
) {
    let on_api_key_state_changed = Box::new(on_api_key_state_changed);
    workspace.toggle_modal(window, cx, move |window, cx| {
        BackboardApiKeyModal::new(window, cx, on_api_key_state_changed, on_dismiss)
    });
}

pub fn open_backboard_panel_with_prompt(
    workspace: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
    prompt: impl Into<String>,
) {
    workspace.open_panel::<BackboardPanel>(window, cx);
    if let Some(panel) = workspace.panel::<BackboardPanel>(cx) {
        let prompt = prompt.into();
        panel.update(cx, |panel, cx| {
            panel.set_composer_prompt(prompt, window, cx);
        });
    }
}

pub fn init(cx: &mut App) {
    cx.observe_new(|workspace: &mut Workspace, _, _| {
        workspace.register_action(|workspace, _: &ToggleFocus, window, cx| {
            workspace.toggle_panel_focus::<BackboardPanel>(window, cx);
        });
        workspace.register_action(|workspace, _: &NewChat, window, cx| {
            workspace.open_panel::<BackboardPanel>(window, cx);
            if let Some(panel) = workspace.panel::<BackboardPanel>(cx) {
                panel.update(cx, |panel, cx| panel.new_chat(cx));
            }
        });
        workspace.register_action(|workspace, _: &SaveApiKey, window, cx| {
            workspace.open_panel::<BackboardPanel>(window, cx);
            if let Some(panel) = workspace.panel::<BackboardPanel>(cx) {
                panel.update(cx, |panel, cx| panel.save_api_key(window, cx));
            }
        });
        workspace.register_action(|workspace, _: &SendPrompt, window, cx| {
            if let Some(panel) = workspace.panel::<BackboardPanel>(cx) {
                panel.update(cx, |panel, cx| panel.send_prompt(window, cx));
            }
        });
    })
    .detach();
}

pub struct BackboardPanel {
    focus_handle: FocusHandle,
    workspace: WeakEntity<Workspace>,
    messages: Vec<BackboardMessage>,
    composer: Entity<Editor>,
    api_key_editor: Entity<Editor>,
    status: String,
    model_status: String,
    api_ready: bool,
    models_loading: bool,
    streaming: bool,
    activity_open: bool,
    loading_tick: usize,
    activity_log: Vec<String>,
    file_changes: Vec<FileChange>,
    files_changed_open: bool,
    providers: Vec<String>,
    models: Vec<backboard::BackboardModel>,
    visible_model_count: usize,
    model_picker_open: bool,
    selected_provider: Option<String>,
    selected_model: Option<String>,
    thread_id: Option<String>,
    configuring_api_key: bool,
    is_zoomed: bool,
    _workspace_subscription: Option<Subscription>,
    _config_task: Task<()>,
}

struct BackboardMessage {
    role: MessageRole,
    body: String,
    full_body: bool,
}

#[derive(Clone)]
struct FileChange {
    path: String,
    additions: usize,
    deletions: usize,
    preview: Vec<String>,
    expanded: bool,
}

#[derive(Clone, Copy)]
enum MessageRole {
    User,
    Backboard,
    Error,
}

enum BackboardUiEvent {
    Append { index: usize, text: String },
    Activity(String),
    FileChange(FileChange),
    ThreadBound(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ApiKeyModalState {
    EnterKey,
    UseWithoutApi,
    Verifying,
    Success,
    Error,
}

#[derive(Clone, Copy)]
enum ApiKeyModalButtonStyle {
    Primary,
    DisabledPrimary,
    Secondary,
    Text,
    MutedText,
}

type ApiKeyStateChangedCallback = Box<dyn Fn(&mut App)>;
type ApiKeyDismissCallback = Box<dyn FnOnce(&mut Window, &mut App)>;

struct BackboardApiKeyModal {
    focus_handle: FocusHandle,
    api_key_editor: Entity<Editor>,
    state: ApiKeyModalState,
    verification_error: Option<String>,
    on_api_key_state_changed: ApiKeyStateChangedCallback,
    on_dismiss: Option<ApiKeyDismissCallback>,
}

impl BackboardMessage {
    fn compact(role: MessageRole, body: impl Into<String>) -> Self {
        Self {
            role,
            body: body.into(),
            full_body: false,
        }
    }

    fn full(role: MessageRole, body: impl Into<String>) -> Self {
        Self {
            role,
            body: body.into(),
            full_body: true,
        }
    }
}

impl BackboardApiKeyModal {
    fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        on_api_key_state_changed: ApiKeyStateChangedCallback,
        on_dismiss: Option<ApiKeyDismissCallback>,
    ) -> Self {
        let api_key_editor = cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            editor.set_placeholder_text("bbk_****************", window, cx);
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor
        });

        Self {
            focus_handle: cx.focus_handle(),
            api_key_editor,
            state: ApiKeyModalState::EnterKey,
            verification_error: None,
            on_api_key_state_changed,
            on_dismiss,
        }
    }

    fn set_state(&mut self, state: ApiKeyModalState, cx: &mut Context<Self>) {
        self.state = state;
        cx.notify();
    }

    fn notify_api_key_state_changed(&self, cx: &mut App) {
        (self.on_api_key_state_changed)(cx);
    }

    fn verify_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state == ApiKeyModalState::Verifying {
            return;
        }

        let api_key = self.api_key_editor.read(cx).text(cx).trim().to_string();
        if api_key.is_empty() {
            self.verification_error = Some("Paste your API key first.".to_string());
            self.api_key_editor.focus_handle(cx).focus(window, cx);
            self.state = ApiKeyModalState::Error;
            cx.notify();
            return;
        }

        self.state = ApiKeyModalState::Verifying;
        self.verification_error = None;
        cx.notify();

        let base_url = backboard::BackboardConfig::load_or_default().base_url();
        let verification_task = gpui_tokio::Tokio::spawn_result(cx, async move {
            let client = backboard::BackboardClient::new(base_url, api_key.clone());
            client
                .list_providers()
                .await
                .context("verifying Backboard API access")?;
            backboard::BackboardConfig::save_api_key_for_current_env(api_key)
                .context("saving Backboard API key")?;
            anyhow::Ok(())
        });

        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            let result = verification_task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        this.state = ApiKeyModalState::Success;
                        this.verification_error = None;
                        this.notify_api_key_state_changed(cx);
                    }
                    Err(error) => {
                        this.state = ApiKeyModalState::Error;
                        this.verification_error = Some(format!("{error:#}"));
                    }
                }
                cx.notify();
            })
            .log_err();
        })
        .detach();
    }

    fn render_header(&self) -> impl IntoElement {
        let (title, subtitle, title_color) = match self.state {
            ApiKeyModalState::EnterKey => (
                "Connect API key",
                "Add your API key to run agents and generate workspace output.",
                api_modal_color(0x141414),
            ),
            ApiKeyModalState::UseWithoutApi => (
                "Use without API?",
                "Some workspace features will be unavailable.",
                api_modal_color(0x141414),
            ),
            ApiKeyModalState::Verifying => (
                "Verifying API key...",
                "Checking workspace permissions.",
                api_modal_color(0x141414),
            ),
            ApiKeyModalState::Success => (
                "API access ready",
                "Your workspace can now run agents and generate output.",
                api_modal_color(0x141414),
            ),
            ApiKeyModalState::Error => (
                "Couldn't verify API key",
                "Check the key and try again.",
                api_modal_color(0xd83e64),
            ),
        };

        v_flex()
            .px_6()
            .pt_6()
            .pb_4()
            .gap_1()
            .child(
                Label::new(title)
                    .size(LabelSize::Default)
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(title_color)),
            )
            .child(
                Label::new(subtitle)
                    .size(LabelSize::Small)
                    .color(Color::Custom(api_modal_color(0x8f9bad))),
            )
    }

    fn render_api_key_field(&self, _cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_1p5()
            .child(
                Label::new("API key")
                    .size(LabelSize::Small)
                    .color(Color::Custom(api_modal_color(0x141414))),
            )
            .child(
                div()
                    .h(px(36.))
                    .w_full()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(api_modal_color(0xeceff4))
                    .bg(api_modal_color(0xf5f7fa))
                    .px_2()
                    .py_1()
                    .child(self.api_key_editor.clone()),
            )
            .child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .child(
                        Label::new("Your key is stored locally for this workspace.")
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(api_modal_color(0x8f9bad))),
                    )
                    .child(
                        h_flex()
                            .id("backboard-api-key-help")
                            .cursor_pointer()
                            .child(
                                Label::new("Where do I find my API key?")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(api_modal_color(0x5b8cff))),
                            )
                            .on_click(|_, _, cx| {
                                cx.open_url("https://app.backboard.io/dashboard");
                            }),
                    ),
            )
    }

    fn render_status_card(
        title: impl Into<SharedString>,
        detail: impl Into<SharedString>,
        dot_color: Hsla,
        title_color: Hsla,
    ) -> impl IntoElement {
        h_flex()
            .w_full()
            .gap(px(10.))
            .items_start()
            .rounded(px(8.))
            .bg(api_modal_color(0xf5f7fa))
            .px_3()
            .py_3()
            .child(div().mt(px(5.)).size(px(8.)).rounded_full().bg(dot_color))
            .child(
                v_flex()
                    .gap_0p5()
                    .child(
                        Label::new(title)
                            .size(LabelSize::Small)
                            .weight(FontWeight::SEMIBOLD)
                            .color(Color::Custom(title_color)),
                    )
                    .child(
                        Label::new(detail)
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(api_modal_color(0xaeb8c6))),
                    ),
            )
    }

    fn render_access_row(
        icon: IconName,
        color: Hsla,
        label: &'static str,
        label_color: Hsla,
    ) -> impl IntoElement {
        h_flex()
            .gap_2()
            .items_center()
            .child(
                Icon::new(icon)
                    .size(IconSize::XSmall)
                    .color(Color::Custom(color)),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Custom(label_color)),
            )
    }

    fn render_button(
        id: &'static str,
        label: &'static str,
        style: ApiKeyModalButtonStyle,
    ) -> Stateful<Div> {
        let (background, text_color, disabled) = match style {
            ApiKeyModalButtonStyle::Primary => {
                (api_modal_color(0x5b8cff), api_modal_color(0xffffff), false)
            }
            ApiKeyModalButtonStyle::DisabledPrimary => (
                api_modal_color(0x5b8cff).opacity(0.40),
                api_modal_color(0xffffff),
                true,
            ),
            ApiKeyModalButtonStyle::Secondary => {
                (api_modal_color(0xeceff4), api_modal_color(0x141414), false)
            }
            ApiKeyModalButtonStyle::Text => (
                api_modal_color(0xffffff).opacity(0.0),
                api_modal_color(0x8f9bad),
                false,
            ),
            ApiKeyModalButtonStyle::MutedText => (
                api_modal_color(0xffffff).opacity(0.0),
                api_modal_color(0xaeb8c6),
                false,
            ),
        };

        h_flex()
            .id(id)
            .h(px(36.))
            .items_center()
            .justify_center()
            .px_5()
            .rounded(px(8.))
            .bg(background)
            .when(!disabled, |this| this.cursor_pointer())
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(text_color)),
            )
    }

    fn render_enter_key(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex().px_6().pb_4().child(self.render_api_key_field(cx))
    }

    fn render_use_without_api(&self) -> impl IntoElement {
        v_flex()
            .px_6()
            .pb_4()
            .gap_3()
            .child(
                div()
                    .text_sm()
                    .line_height(gpui::relative(1.35))
                    .text_color(api_modal_color(0x8f9bad))
                    .child("You can continue without an API key, but agents, generated outputs, and API-powered workspace actions will be disabled until you connect one."),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(Self::render_access_row(
                        IconName::Dash,
                        api_modal_color(0xddc300),
                        "Agents unavailable",
                        api_modal_color(0x8f9bad),
                    ))
                    .child(Self::render_access_row(
                        IconName::Dash,
                        api_modal_color(0xddc300),
                        "Generated artifacts unavailable",
                        api_modal_color(0x8f9bad),
                    ))
                    .child(Self::render_access_row(
                        IconName::Dash,
                        api_modal_color(0xddc300),
                        "API-powered edits unavailable",
                        api_modal_color(0x8f9bad),
                    ))
                    .child(Self::render_access_row(
                        IconName::Check,
                        api_modal_color(0x2f9f5b),
                        "Manual workspace browsing still available",
                        api_modal_color(0x141414),
                    )),
            )
    }

    fn render_verifying(&self) -> impl IntoElement {
        v_flex().px_6().pb_4().child(Self::render_status_card(
            "Confirming access",
            "Verifying key and workspace permissions.",
            api_modal_color(0xaeb8c6),
            api_modal_color(0x141414),
        ))
    }

    fn render_success(&self) -> impl IntoElement {
        v_flex()
            .px_6()
            .pb_4()
            .gap_3()
            .child(Self::render_status_card(
                "API access ready",
                "Agents can now run tasks and generate output.",
                api_modal_color(0x2f9f5b),
                api_modal_color(0x2f9f5b),
            ))
            .child(
                v_flex()
                    .gap_2()
                    .child(Self::render_access_row(
                        IconName::Check,
                        api_modal_color(0x2f9f5b),
                        "API key verified",
                        api_modal_color(0x141414),
                    ))
                    .child(Self::render_access_row(
                        IconName::Check,
                        api_modal_color(0x2f9f5b),
                        "Workspace permissions ready",
                        api_modal_color(0x141414),
                    ))
                    .child(Self::render_access_row(
                        IconName::Check,
                        api_modal_color(0x2f9f5b),
                        "Agents enabled",
                        api_modal_color(0x141414),
                    )),
            )
    }

    fn render_error(&self) -> impl IntoElement {
        v_flex().px_6().pb_4().child(Self::render_status_card(
            "Invalid or expired API key",
            "Check the key and try again, or generate a new one.",
            api_modal_color(0xd83e64),
            api_modal_color(0xd83e64),
        ))
    }

    fn render_body(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.state {
            ApiKeyModalState::EnterKey => self.render_enter_key(cx).into_any_element(),
            ApiKeyModalState::UseWithoutApi => self.render_use_without_api().into_any_element(),
            ApiKeyModalState::Verifying => self.render_verifying().into_any_element(),
            ApiKeyModalState::Success => self.render_success().into_any_element(),
            ApiKeyModalState::Error => self.render_error().into_any_element(),
        }
    }

    fn render_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state;
        match state {
            ApiKeyModalState::EnterKey => h_flex()
                .px_6()
                .pt_1()
                .pb_6()
                .gap_3()
                .child(
                    Self::render_button(
                        "backboard-api-use-without",
                        "Use without API",
                        ApiKeyModalButtonStyle::Text,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.set_state(ApiKeyModalState::UseWithoutApi, cx);
                    })),
                )
                .child(div().flex_1())
                .child(
                    Self::render_button(
                        "backboard-api-cancel",
                        "Cancel",
                        ApiKeyModalButtonStyle::Secondary,
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                )
                .child(
                    Self::render_button(
                        "backboard-api-verify",
                        "Verify key",
                        ApiKeyModalButtonStyle::Primary,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.verify_api_key(window, cx);
                    })),
                )
                .into_any_element(),
            ApiKeyModalState::UseWithoutApi => h_flex()
                .px_6()
                .pt_1()
                .pb_6()
                .gap_3()
                .child(div().flex_1())
                .child(
                    Self::render_button(
                        "backboard-api-back",
                        "Back",
                        ApiKeyModalButtonStyle::Secondary,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.set_state(ApiKeyModalState::EnterKey, cx);
                    })),
                )
                .child(
                    Self::render_button(
                        "backboard-api-continue-without",
                        "Continue without API",
                        ApiKeyModalButtonStyle::Secondary,
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                )
                .into_any_element(),
            ApiKeyModalState::Verifying => h_flex()
                .px_6()
                .pt_1()
                .pb_6()
                .gap_3()
                .child(div().flex_1())
                .child(
                    Self::render_button(
                        "backboard-api-cancel-verifying",
                        "Cancel",
                        ApiKeyModalButtonStyle::Secondary,
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                )
                .child(Self::render_button(
                    "backboard-api-verifying",
                    "Verifying...",
                    ApiKeyModalButtonStyle::DisabledPrimary,
                ))
                .into_any_element(),
            ApiKeyModalState::Success => h_flex()
                .px_6()
                .pt_1()
                .pb_6()
                .gap_3()
                .child(div().flex_1())
                .child(
                    Self::render_button(
                        "backboard-api-success-continue",
                        "Continue to workspace",
                        ApiKeyModalButtonStyle::Primary,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.notify_api_key_state_changed(cx);
                        cx.emit(DismissEvent);
                    })),
                )
                .into_any_element(),
            ApiKeyModalState::Error => v_flex()
                .px_6()
                .pt_1()
                .pb_6()
                .gap_3()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().flex_1())
                        .child(
                            Self::render_button(
                                "backboard-api-error-cancel",
                                "Cancel",
                                ApiKeyModalButtonStyle::Secondary,
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(DismissEvent))),
                        )
                        .child(
                            Self::render_button(
                                "backboard-api-try-again",
                                "Try again",
                                ApiKeyModalButtonStyle::Primary,
                            )
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.state = ApiKeyModalState::EnterKey;
                                    this.api_key_editor.focus_handle(cx).focus(window, cx);
                                    cx.notify();
                                },
                            )),
                        ),
                )
                .child(
                    h_flex().justify_center().child(
                        Self::render_button(
                            "backboard-api-error-use-without",
                            "Use without API",
                            ApiKeyModalButtonStyle::MutedText,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.set_state(ApiKeyModalState::UseWithoutApi, cx);
                        })),
                    ),
                )
                .into_any_element(),
        }
    }
}

impl Render for BackboardApiKeyModal {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .inset_0()
            .size_full()
            .occlude()
            .track_focus(&self.focus_handle)
            .bg(API_MODAL_OVERLAY)
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                v_flex().size_full().items_center().justify_center().child(
                    v_flex()
                        .w(px(480.))
                        .max_w(px(480.))
                        .rounded(px(14.))
                        .border_1()
                        .border_color(api_modal_color(0xeceff4))
                        .bg(api_modal_color(0xfbfcfd))
                        .shadow_lg()
                        .child(self.render_header())
                        .child(self.render_body(cx))
                        .child(self.render_footer(cx)),
                ),
            )
    }
}

impl Focusable for BackboardApiKeyModal {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if self.state == ApiKeyModalState::EnterKey || self.state == ApiKeyModalState::Error {
            self.api_key_editor.focus_handle(cx)
        } else {
            self.focus_handle.clone()
        }
    }
}

impl EventEmitter<DismissEvent> for BackboardApiKeyModal {}

impl ModalView for BackboardApiKeyModal {
    fn on_before_dismiss(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> workspace::DismissDecision {
        if let Some(on_dismiss) = self.on_dismiss.take() {
            window.defer(cx, move |window, cx| {
                on_dismiss(window, cx);
            });
        }

        workspace::DismissDecision::Dismiss(true)
    }

    fn render_bare(&self) -> bool {
        true
    }
}

impl BackboardPanel {
    pub fn load(
        workspace: WeakEntity<Workspace>,
        cx: AsyncWindowContext,
    ) -> Task<Result<Entity<Self>>> {
        cx.spawn(async move |cx| {
            workspace.update_in(cx, |_workspace, window, cx| {
                cx.new(|cx| Self::new(workspace.clone(), window, cx))
            })
        })
    }

    pub fn new(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let config = backboard::BackboardConfig::load_or_default();
        let api_ready = config.api_key().is_some();
        let status = Self::status_for_config(&config, api_ready);
        let selected_provider = None;
        let selected_model = None;

        let api_key_editor = cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            editor.set_placeholder_text("Paste your Backboard API key...", window, cx);
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor.set_masked(true, cx);
            editor
        });

        let composer = cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 10, window, cx);
            editor.set_placeholder_text(
                "Ask Backboard to build, edit, search, or run tools...",
                window,
                cx,
            );
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor.set_soft_wrap();
            editor
        });

        let initial_message = if api_ready {
            "Backboard IDE is connected. Choose a model, then ask it to inspect files, create code, run tools, or plan work in this workspace."
        } else {
            "Paste your Backboard API key in the setup card above. It saves to the same ~/.backboard/config.json file used by the CLI."
        };

        let config_changes = backboard::subscribe_config_changes();
        let config_task = cx.spawn(async move |this, cx| {
            while config_changes.recv().await.is_ok() {
                this.update(cx, |this, cx| {
                    this.refresh_status(cx);
                })
                .ok();
            }
        });

        let workspace_subscription = workspace.upgrade().map(|workspace| {
            cx.observe(&workspace, |_, _, cx| {
                cx.notify();
            })
        });

        let mut panel = Self {
            focus_handle: cx.focus_handle(),
            workspace,
            messages: vec![BackboardMessage::compact(
                MessageRole::Backboard,
                initial_message,
            )],
            composer,
            api_key_editor,
            status,
            model_status: if api_ready {
                "Loading Backboard model catalog...".into()
            } else {
                "Connect Backboard to load models.".into()
            },
            api_ready,
            models_loading: false,
            streaming: false,
            activity_open: false,
            loading_tick: 0,
            activity_log: Vec::new(),
            file_changes: Vec::new(),
            files_changed_open: true,
            providers: Vec::new(),
            models: Vec::new(),
            visible_model_count: INITIAL_VISIBLE_MODELS,
            model_picker_open: api_ready && selected_model.is_none(),
            selected_provider,
            selected_model,
            thread_id: None,
            configuring_api_key: false,
            is_zoomed: false,
            _workspace_subscription: workspace_subscription,
            _config_task: config_task,
        };

        if panel.api_ready {
            panel.load_models(cx);
        }
        panel.subscribe_inline_completion_outputs(cx);

        panel
    }

    fn status_for_config(config: &backboard::BackboardConfig, api_ready: bool) -> String {
        if api_ready {
            format!(
                "Connected to Backboard {} at {}",
                config.env,
                config.base_url()
            )
        } else {
            "No API key yet. Paste one here or run `backboard config set-api-key <key>`."
                .to_string()
        }
    }

    fn new_chat(&mut self, cx: &mut Context<Self>) {
        self.messages.clear();
        self.messages.push(BackboardMessage::compact(
            MessageRole::Backboard,
            "New Backboard chat started.",
        ));
        self.activity_log.clear();
        self.file_changes.clear();
        self.files_changed_open = true;
        self.activity_open = false;
        self.thread_id = None;
        cx.notify();
    }

    fn refresh_status(&mut self, cx: &mut Context<Self>) {
        let config = backboard::BackboardConfig::load_or_default();
        self.api_ready = config.api_key().is_some();
        self.status = Self::status_for_config(&config, self.api_ready);
        if !self.api_ready {
            self.configuring_api_key = false;
            self.model_picker_open = false;
            self.models_loading = false;
            self.providers.clear();
            self.models.clear();
            self.model_status = "Connect Backboard to load models.".into();
        }
        if self.api_ready && self.models.is_empty() && !self.models_loading {
            self.load_models(cx);
        }
        cx.notify();
    }

    fn load_models(&mut self, cx: &mut Context<Self>) {
        if self.models_loading {
            return;
        }
        if !self.models.is_empty() {
            self.model_status = format!(
                "{} Backboard models loaded across {} providers",
                self.models.len(),
                self.providers.len()
            );
            cx.notify();
            return;
        }

        let config = backboard::BackboardConfig::load_or_default();
        let Ok(client) = backboard::BackboardClient::from_config(config) else {
            self.model_status = "Add a Backboard API key to load models.".into();
            self.models_loading = false;
            return;
        };

        self.models_loading = true;
        self.model_status = "Loading Backboard model catalog...".into();
        cx.notify();

        let models_task = gpui_tokio::Tokio::spawn_result(cx, async move {
            let providers = client.list_providers().await?;
            let models = client.list_models(None, Some("llm"), Some(15000)).await?;
            anyhow::Ok((providers, models))
        });

        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            let result = models_task.await;

            this.update(cx, |this, cx| {
                this.models_loading = false;
                match result {
                    Ok((providers, mut models)) => {
                        this.providers.clear();
                        providers.into_iter().for_each(|provider| {
                            if !this.providers.contains(&provider) {
                                this.providers.push(provider);
                            }
                        });
                        models.sort_by(|a, b| {
                            a.provider
                                .cmp(&b.provider)
                                .then_with(|| a.name.cmp(&b.name))
                        });
                        for provider in models.iter().map(|model| model.provider.clone()) {
                            if !this.providers.contains(&provider) {
                                this.providers.push(provider);
                            }
                        }
                        this.models = models;
                        this.visible_model_count = INITIAL_VISIBLE_MODELS;
                        this.model_status = format!(
                            "{} Backboard models loaded across {} providers",
                            this.models.len(),
                            this.providers.len()
                        );
                    }
                    Err(error) => {
                        this.model_status = format!("Could not load Backboard models: {error:#}");
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn reload_models(&mut self, cx: &mut Context<Self>) {
        if self.models_loading {
            return;
        }
        self.providers.clear();
        self.models.clear();
        self.visible_model_count = INITIAL_VISIBLE_MODELS;
        self.load_models(cx);
    }

    fn save_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let api_key = self.api_key_editor.read(cx).text(cx).trim().to_string();

        if api_key.is_empty() {
            self.status = "Paste your Backboard API key first.".to_string();
            self.api_key_editor.focus_handle(cx).focus(window, cx);
            cx.notify();
            return;
        }

        match backboard::BackboardConfig::save_api_key_for_current_env(api_key) {
            Ok(config) => {
                self.api_ready = true;
                self.configuring_api_key = false;
                self.status = format!("Saved API key to ~/.backboard/config.json ({})", config.env);
                self.api_key_editor
                    .update(cx, |editor, cx| editor.set_text("", window, cx));
                self.messages.push(BackboardMessage::compact(
                    MessageRole::Backboard,
                    "API key saved. The IDE and Backboard CLI now share the same config file.",
                ));
                self.model_picker_open = true;
                self.load_models(cx);
            }
            Err(error) => {
                self.api_ready = false;
                self.status = format!("Could not save API key: {error:#}");
            }
        }

        cx.notify();
    }

    fn open_api_key_settings(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
    }

    fn select_model(&mut self, provider: String, model: String, cx: &mut Context<Self>) {
        self.selected_provider = Some(provider.clone());
        self.selected_model = Some(model.clone());
        self.model_status = format!("Using {provider}/{model}");
        self.model_picker_open = false;
        cx.notify();
    }

    fn toggle_model_picker(&mut self, cx: &mut Context<Self>) {
        self.model_picker_open = !self.model_picker_open;
        if self.model_picker_open && self.models.is_empty() && !self.models_loading {
            self.load_models(cx);
        } else {
            cx.notify();
        }
    }

    fn show_more_models(&mut self, cx: &mut Context<Self>) {
        self.visible_model_count = (self.visible_model_count + MODEL_LOAD_INCREMENT)
            .min(self.models.len().max(INITIAL_VISIBLE_MODELS));
        cx.notify();
    }

    fn set_composer_prompt(&mut self, prompt: String, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |editor, cx| editor.set_text(prompt, window, cx));
        self.composer.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = self.composer.read(cx).text(cx).trim().to_string();
        if prompt.is_empty() {
            self.composer.focus_handle(cx).focus(window, cx);
            return;
        }
        if !self.api_ready || self.streaming {
            return;
        }

        let workspace_root = self.workspace_root(cx);
        let selected_provider = self.selected_provider.clone();
        let selected_model = self.selected_model.clone();
        let thread_id = self.thread_id.clone();
        let response_index = self.messages.len() + 1;

        self.messages
            .push(BackboardMessage::compact(MessageRole::User, prompt.clone()));
        self.messages.push(BackboardMessage::compact(
            MessageRole::Backboard,
            String::new(),
        ));
        self.streaming = true;
        self.activity_open = true;
        self.loading_tick = 0;
        self.activity_log.clear();
        self.file_changes.clear();
        self.files_changed_open = true;
        self.push_activity("Initializing everything...");
        self.push_activity("Opening the portal...");
        self.push_activity("Talking to the cloud...");
        self.status = "Backboard is running...".into();
        self.composer
            .update(cx, |editor, cx| editor.set_text("", window, cx));
        cx.notify();

        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(LOADING_TICK_MS))
                    .await;

                let keep_spinning = this
                    .update(cx, |this, cx| {
                        if !this.streaming {
                            return false;
                        }
                        this.loading_tick = this.loading_tick.wrapping_add(1);
                        if this.loading_tick % 4 == 0 {
                            this.push_activity(
                                LOADING_COPY[this.loading_tick % LOADING_COPY.len()],
                            );
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);

                if !keep_spinning {
                    break;
                }
            }
        })
        .detach();

        let (tx, rx) = async_channel::unbounded();
        let run_task = gpui_tokio::Tokio::spawn_result(cx, async move {
            send_backboard_prompt(
                prompt,
                selected_provider,
                selected_model,
                thread_id,
                workspace_root,
                response_index,
                tx,
            )
            .await
        });

        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            while let Ok(event) = rx.recv().await {
                this.update(cx, |this, cx| {
                    match event {
                        BackboardUiEvent::Append { index, text } => {
                            this.append_to_message(index, &text);
                        }
                        BackboardUiEvent::Activity(activity) => {
                            this.push_activity(activity);
                        }
                        BackboardUiEvent::FileChange(file_change) => {
                            this.record_file_change(file_change);
                        }
                        BackboardUiEvent::ThreadBound(thread_id) => {
                            this.thread_id = Some(thread_id);
                        }
                    }
                    cx.notify();
                })
                .ok();
            }

            let result = run_task.await;

            this.update(cx, |this, cx| {
                this.streaming = false;
                match result {
                    Ok(()) => {
                        if this
                            .messages
                            .get(response_index)
                            .is_some_and(|message| message.body.trim().is_empty())
                        {
                            this.append_to_message(
                                response_index,
                                "Backboard completed without text output.",
                            );
                        }
                        this.refresh_status(cx);
                        this.push_activity("Backboard finished.");
                    }
                    Err(error) => {
                        this.messages.push(BackboardMessage::compact(
                            MessageRole::Error,
                            format!("Backboard run failed: {error:#}"),
                        ));
                        this.push_activity(format!("Run failed: {error:#}"));
                        this.status = "Backboard run failed.".into();
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn workspace_root(&self, cx: &App) -> Option<PathBuf> {
        self.workspace.upgrade().and_then(|workspace| {
            workspace
                .read(cx)
                .root_paths(cx)
                .into_iter()
                .next()
                .map(|path| path.to_path_buf())
        })
    }

    fn append_to_message(&mut self, index: usize, text: &str) {
        if let Some(message) = self.messages.get_mut(index) {
            message.body.push_str(text);
        }
    }

    fn subscribe_inline_completion_outputs(&mut self, cx: &mut Context<Self>) {
        let receiver = backboard::subscribe_inline_completion_outputs();
        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            while let Ok(output) = receiver.recv().await {
                if output.chunks.is_empty() {
                    continue;
                }

                let title = output.title;
                let path = output.path.unwrap_or_else(|| "current buffer".to_string());
                let language = output.language.unwrap_or_else(|| "text".to_string());
                let chunks = output.chunks;
                let chunk_count = chunks.len();

                let started = this.update(cx, |this, cx| {
                    this.start_inline_completion_output(&path, cx);
                });
                if started.is_err() {
                    break;
                }

                for (chunk_index, chunk) in chunks.into_iter().enumerate() {
                    if chunk_index > 0 {
                        cx.background_executor()
                            .timer(Duration::from_millis(
                                INLINE_COMPLETION_CHUNK_OUTPUT_DELAY_MILLIS,
                            ))
                            .await;
                    }

                    let appended = this.update(cx, |this, cx| {
                        this.append_inline_completion_output_chunk(
                            &title,
                            &path,
                            &language,
                            chunk_count,
                            chunk_index,
                            chunk,
                            cx,
                        );
                    });
                    if appended.is_err() {
                        break;
                    }
                }

                if this
                    .update(cx, |this, cx| {
                        this.finish_inline_completion_output(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn start_inline_completion_output(&mut self, path: &str, cx: &mut Context<Self>) {
        self.messages.push(BackboardMessage::compact(
            MessageRole::User,
            format!("Inline autocomplete finished for {path}"),
        ));
        self.streaming = true;
        self.activity_open = false;
        self.status = "Inline autocomplete output is streaming to Backboard.".into();
        self.push_activity("Inline autocomplete output started.");
        cx.notify();
    }

    fn append_inline_completion_output_chunk(
        &mut self,
        title: &str,
        path: &str,
        language: &str,
        chunk_count: usize,
        chunk_index: usize,
        chunk: String,
        cx: &mut Context<Self>,
    ) {
        let heading = if chunk_count > 1 {
            format!(
                "{title} ({}/{})\n{path}\n{language}",
                chunk_index + 1,
                chunk_count
            )
        } else {
            format!("{title}\n{path}\n{language}")
        };
        self.messages.push(BackboardMessage::full(
            MessageRole::Backboard,
            format!("{heading}\n\n{chunk}"),
        ));
        cx.notify();
    }

    fn finish_inline_completion_output(&mut self, cx: &mut Context<Self>) {
        self.streaming = false;
        self.activity_open = false;
        self.status = "Inline autocomplete output is ready in Backboard.".into();
        self.push_activity("Inline autocomplete completed.");
        cx.notify();
    }

    fn push_activity(&mut self, activity: impl Into<String>) {
        let activity = activity.into();
        if self.activity_log.last() == Some(&activity) {
            return;
        }
        self.activity_log.push(activity);
        if self.activity_log.len() > ACTIVITY_LIMIT {
            self.activity_log.remove(0);
        }
    }

    fn record_file_change(&mut self, mut file_change: FileChange) {
        if let Some(existing) = self
            .file_changes
            .iter_mut()
            .find(|existing| existing.path == file_change.path)
        {
            file_change.expanded = existing.expanded;
            *existing = file_change;
        } else {
            self.file_changes.push(file_change);
        }
    }

    fn current_loading_text(&self) -> String {
        if self.streaming {
            LOADING_COPY[self.loading_tick % LOADING_COPY.len()].to_string()
        } else {
            self.activity_log
                .last()
                .cloned()
                .unwrap_or_else(|| "Ready when you are.".into())
        }
    }

    fn toggle_activity(&mut self, cx: &mut Context<Self>) {
        self.activity_open = !self.activity_open;
        cx.notify();
    }

    fn toggle_files_changed(&mut self, cx: &mut Context<Self>) {
        self.files_changed_open = !self.files_changed_open;
        cx.notify();
    }

    fn toggle_file_change(&mut self, path: String, cx: &mut Context<Self>) {
        if let Some(change) = self
            .file_changes
            .iter_mut()
            .find(|change| change.path == path)
        {
            change.expanded = !change.expanded;
        }
        cx.notify();
    }

    fn selected_model_label(&self) -> String {
        self.selected_provider
            .as_ref()
            .zip(self.selected_model.as_ref())
            .map(|(provider, model)| format!("{provider}/{model}"))
            .unwrap_or_else(|| "No model selected".into())
    }

    fn should_show_status(&self) -> bool {
        !self.api_ready || self.models_loading || self.streaming
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(54.))
            .px_4()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().panel_background)
            .child(
                h_flex()
                    .gap_2()
                    .child(Icon::new(IconName::Sparkle).color(Color::Muted))
                    .child(Label::new("Conversation").size(LabelSize::Large)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(Icon::new(IconName::FileCode).color(Color::Muted))
                    .child(
                        Label::new(self.selected_model_label())
                            .size(LabelSize::Small)
                            .color(Color::Muted)
                            .truncate(),
                    )
                    .child(Divider::vertical())
                    .child(
                        IconButton::new("backboard-new-chat", IconName::Plus)
                            .icon_size(IconSize::Small)
                            .tooltip(Tooltip::text("New Backboard Chat"))
                            .on_click(cx.listener(|this, _, _window, cx| this.new_chat(cx))),
                    )
                    .child(
                        IconButton::new("backboard-refresh", IconName::RotateCw)
                            .icon_size(IconSize::Small)
                            .tooltip(Tooltip::text("Refresh Backboard Status"))
                            .on_click(cx.listener(|this, _, _window, cx| {
                                this.refresh_status(cx);
                                cx.notify();
                            })),
                    ),
            )
    }

    fn render_status(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.api_ready {
            return h_flex()
                .h(px(28.))
                .w_full()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .bg(cx.theme().colors().element_background)
                .child(
                    div()
                        .size(px(6.))
                        .rounded_full()
                        .bg(cx.theme().status().warning_border),
                )
                .child(
                    Label::new("API not connected")
                        .size(LabelSize::XSmall)
                        .color(Color::Disabled),
                )
                .into_any_element();
        }

        h_flex()
            .h(px(28.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(cx.theme().colors().element_background)
            .child(
                div()
                    .size(px(6.))
                    .rounded_full()
                    .bg(cx.theme().status().created),
            )
            .child(
                Label::new(self.status.clone())
                    .size(LabelSize::XSmall)
                    .color(Color::Disabled),
            )
            .into_any_element()
    }

    fn render_inline_activity(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let loading_text = if self.streaming {
            format!("Running: {}", self.current_loading_text())
        } else {
            self.current_loading_text()
        };
        let toggle_icon = if self.activity_open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        };

        h_flex()
            .id("backboard-inline-activity-toggle")
            .cursor_pointer()
            .gap_1()
            .px_2()
            .py_1()
            .rounded_md()
            .bg(cx.theme().colors().element_background)
            .on_click(cx.listener(|this, _, _window, cx| this.toggle_activity(cx)))
            .child(if self.streaming {
                Icon::new(IconName::LoadCircle)
                    .size(IconSize::XSmall)
                    .color(Color::Muted)
                    .with_rotate_animation(2)
                    .into_any_element()
            } else {
                Icon::new(IconName::Check)
                    .size(IconSize::XSmall)
                    .color(Color::Muted)
                    .into_any_element()
            })
            .child(
                Label::new(loading_text)
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                Icon::new(toggle_icon)
                    .size(IconSize::XSmall)
                    .color(Color::Muted),
            )
    }

    fn render_activity_details(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .mt_1()
            .ml_1()
            .pl_4()
            .gap_1()
            .border_l_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.34))
            .children(self.activity_log.iter().rev().take(6).map(|activity| {
                h_flex()
                    .gap_2()
                    .child(
                        Icon::new(IconName::Circle)
                            .size(IconSize::XSmall)
                            .color(Color::Muted),
                    )
                    .child(
                        Label::new(activity.clone())
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
            }))
    }

    fn latest_thinking_activity(&self) -> Option<String> {
        self.activity_log.iter().rev().find_map(|activity| {
            let activity = activity.trim();
            if let Some(thinking) = activity.strip_prefix("Thinking: ") {
                Some(thinking.trim().to_string())
            } else if activity.starts_with("Thinking through") {
                Some("Thinking through the request.".to_string())
            } else if activity.starts_with("Finished planning") {
                Some("Finished planning the next step.".to_string())
            } else {
                None
            }
        })
    }

    fn render_thinking_preview(&self, thought: String, cx: &mut Context<Self>) -> impl IntoElement {
        let background = cx
            .theme()
            .colors()
            .editor_background
            .blend(cx.theme().colors().element_background.opacity(0.06));

        h_flex()
            .id("backboard-thinking-preview")
            .w_full()
            .gap_2()
            .items_start()
            .px_3()
            .py_2()
            .rounded(rems_from_px(8.))
            .border_1()
            .border_color(cx.theme().colors().border_variant.opacity(0.24))
            .bg(background)
            .child(if self.streaming {
                Icon::new(IconName::LoadCircle)
                    .size(IconSize::XSmall)
                    .color(Color::Muted)
                    .with_rotate_animation(2)
                    .into_any_element()
            } else {
                Icon::new(IconName::LoadCircle)
                    .size(IconSize::XSmall)
                    .color(Color::Muted)
                    .into_any_element()
            })
            .child(
                v_flex()
                    .gap_0p5()
                    .flex_1()
                    .child(
                        Label::new("Thinking")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .weight(FontWeight::SEMIBOLD),
                    )
                    .child(
                        Label::new(thought)
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            )
    }

    fn render_api_key_setup(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .mx_3()
            .mb_3()
            .p_3()
            .gap_3()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .gap_2()
                    .child(Icon::new(IconName::LockOutlined).color(Color::Accent))
                    .child(Label::new("Connect Backboard").size(LabelSize::Large)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().colors().text_muted)
                    .child("Paste your API key here. It saves to ~/.backboard/config.json, the same config file your Backboard CLI uses."),
            )
            .child(
                v_flex()
                    .min_h(px(38.))
                    .rounded_md()
                    .border_1()
                    .border_color(cx.theme().colors().border)
                    .bg(cx.theme().colors().panel_background)
                    .px_2()
                    .py_1()
                    .child(self.api_key_editor.clone()),
            )
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        Label::new("CLI fallback: backboard config set-api-key <key>")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    )
                    .child(
                        Button::new("backboard-save-api-key", "Save API Key")
                            .style(ButtonStyle::Filled)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_api_key(window, cx)),
                            ),
                    ),
            )
    }

    fn render_api_unavailable_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();

        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .px_6()
            .bg(colors.editor_background)
            .child(
                Icon::new(IconName::Info)
                    .size(IconSize::Custom(rems_from_px(28.)))
                    .color(Color::Muted),
            )
            .child(
                Label::new("API key required")
                    .size(LabelSize::Custom(rems_from_px(16.)))
                    .weight(FontWeight::BOLD)
                    .color(Color::Default),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(colors.text_muted)
                    .line_height(relative(1.32))
                    .child(
                        "Connect an API key to run agents, generate outputs, and use workspace actions.",
                    ),
            )
            .child(
                Button::new("backboard-connect-api-key", "Connect API key")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Large)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_api_key_settings(window, cx);
                    })),
            )
            .child(
                Label::new("Continue without API")
                    .size(LabelSize::Small)
                    .color(Color::Disabled),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .text_center()
                    .text_ui_xs(cx)
                    .text_color(colors.text_disabled)
                    .line_height(relative(1.32))
                    .child("You can still browse files and inspect the workspace manually."),
            )
    }

    fn render_model_drawer(
        &self,
        workspace_tour_step: Option<WorkspaceTourStep>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.selected_model_label();
        let force_model_picker_open = matches!(
            workspace_tour_step,
            Some(WorkspaceTourStep::ModelSelection | WorkspaceTourStep::TutorialModelSelection)
        );
        let model_picker_open = self.model_picker_open || force_model_picker_open;

        let visible_count = self.visible_model_count.min(self.models.len());
        let hidden_count = self.models.len().saturating_sub(visible_count);
        let highlighted_model_ix = if force_model_picker_open {
            self.models
                .iter()
                .take(visible_count)
                .position(|model| {
                    self.selected_provider.as_ref() == Some(&model.provider)
                        && self.selected_model.as_ref() == Some(&model.name)
                })
                .or_else(|| (visible_count > 0).then_some(0))
        } else {
            None
        };
        let mut rows = Vec::new();
        let mut last_provider = String::new();
        for (ix, model) in self.models.iter().take(visible_count).enumerate() {
            if model.provider != last_provider {
                last_provider = model.provider.clone();
                rows.push(
                    h_flex()
                        .id(("backboard-provider", ix))
                        .pt_2()
                        .child(
                            Label::new(last_provider.clone())
                                .size(LabelSize::Small)
                                .color(Color::Accent),
                        )
                        .into_any_element(),
                );
            }

            let provider = model.provider.clone();
            let name = model.name.clone();
            let display = model.display_name.clone().unwrap_or_else(|| name.clone());
            let is_selected = self.selected_provider.as_ref() == Some(&provider)
                && self.selected_model.as_ref() == Some(&name);
            let meta = model
                .context_limit
                .map(|limit| format!("{} ctx", format_number(limit)))
                .unwrap_or_else(|| "catalog model".into());

            let row = h_flex()
                .id(("backboard-model-row", ix))
                .w_full()
                .justify_between()
                .gap_2()
                .px_2()
                .py_1()
                .rounded_md()
                .bg(if is_selected {
                    cx.theme().colors().element_selected
                } else {
                    cx.theme().colors().editor_background
                })
                .child(
                    v_flex()
                        .flex_1()
                        .child(Label::new(display).size(LabelSize::Small))
                        .child(Label::new(meta).size(LabelSize::Small).color(Color::Muted)),
                )
                .child(
                    Button::new(
                        ("backboard-use-model", ix),
                        if is_selected { "Using" } else { "Use" },
                    )
                    .style(if is_selected {
                        ButtonStyle::Subtle
                    } else {
                        ButtonStyle::Tinted(ui::TintColor::Accent)
                    })
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.select_model(provider.clone(), name.clone(), cx);
                    })),
                );
            if highlighted_model_ix == Some(ix) {
                rows.push(render_workspace_tour_highlight(div().child(row), cx).into_any_element());
            } else {
                rows.push(row.into_any_element());
            }
        }

        let drawer = v_flex()
            .border_t_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().panel_background)
            .px_4()
            .py_2()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        h_flex()
                            .flex_1()
                            .gap_2()
                            .child(Icon::new(IconName::Sliders).color(Color::Muted))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .child(Label::new("Backboard Model").size(LabelSize::Small))
                                    .child(
                                        Label::new(selected)
                                            .size(LabelSize::Small)
                                            .color(Color::Muted),
                                    ),
                            ),
                    )
                    .child(
                        Button::new(
                            "backboard-toggle-model-picker",
                            if model_picker_open { "Close" } else { "Models" },
                        )
                        .style(ButtonStyle::Tinted(ui::TintColor::Accent))
                        .disabled(!self.api_ready)
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.toggle_model_picker(cx);
                        })),
                    ),
            )
            .when(model_picker_open, |this| {
                this.child(
                    v_flex()
                        .id("backboard-model-picker-scroll")
                        .overflow_y_scroll()
                        .max_h(px(300.))
                        .p_3()
                        .gap_2()
                        .rounded_xl()
                        .border_1()
                        .border_color(cx.theme().colors().border)
                        .bg(cx.theme().colors().element_background)
                        .child(
                            h_flex()
                                .justify_between()
                                .child(
                                    Label::new(self.model_status.clone())
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                )
                                .child(
                                    Button::new(
                                        "backboard-load-models",
                                        if self.models_loading {
                                            "Loading"
                                        } else {
                                            "Reload"
                                        },
                                    )
                                    .disabled(!self.api_ready || self.models_loading)
                                    .on_click(
                                        cx.listener(|this, _, _window, cx| this.reload_models(cx)),
                                    ),
                                ),
                        )
                        .when(!self.models.is_empty(), |this| {
                            this.child(v_flex().gap_1().children(rows))
                        }),
                )
            })
            .when(model_picker_open && hidden_count > 0, |this| {
                this.child(
                    h_flex()
                        .justify_between()
                        .pt_2()
                        .child(
                            Label::new(format!(
                                "Showing {visible_count} of {} models",
                                self.models.len()
                            ))
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                        )
                        .child(
                            Button::new("backboard-show-more-models", "Show More")
                                .style(ButtonStyle::Tinted(ui::TintColor::Accent))
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.show_more_models(cx);
                                })),
                        ),
                )
            });

        if force_model_picker_open && highlighted_model_ix.is_none() {
            render_workspace_tour_highlight(drawer, cx)
        } else {
            drawer
        }
    }

    fn render_full_message_body(body: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let text_color = cx.theme().colors().text;
        let background = cx
            .theme()
            .colors()
            .editor_background
            .blend(cx.theme().colors().element_background.opacity(0.08));
        let border = cx.theme().colors().border_variant.opacity(0.32);
        let lines = body
            .lines()
            .map(|line| {
                div()
                    .text_sm()
                    .line_height(gpui::relative(1.45))
                    .text_color(text_color)
                    .child(if line.is_empty() {
                        " ".to_string()
                    } else {
                        line.to_string()
                    })
            })
            .collect::<Vec<_>>();

        v_flex()
            .gap_1()
            .p_3()
            .rounded(rems_from_px(8.))
            .border_1()
            .border_color(border)
            .bg(background)
            .children(lines)
    }

    fn render_messages(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let active_backboard_index = self
            .messages
            .iter()
            .rposition(|message| matches!(message.role, MessageRole::Backboard));
        v_flex()
            .id("backboard-messages")
            .flex_1()
            .gap_4()
            .px(rems_from_px(14.))
            .py_3()
            .overflow_y_scroll()
            .children(self.messages.iter().enumerate().map(|(ix, message)| {
                let is_user = matches!(message.role, MessageRole::User);
                let is_active_backboard = matches!(message.role, MessageRole::Backboard)
                    && Some(ix) == active_backboard_index
                    && (self.streaming || !self.activity_log.is_empty());
                let display_body = if message.full_body {
                    strip_thinking_blocks(&message.body)
                } else {
                    compact_message_body(message.role, &message.body)
                };
                let (label, color) = match message.role {
                    MessageRole::User => ("You", Color::Muted),
                    MessageRole::Backboard => ("Backboard", Color::Muted),
                    MessageRole::Error => ("Error", Color::Error),
                };
                let message_surface = cx
                    .theme()
                    .colors()
                    .editor_background
                    .blend(cx.theme().colors().element_background.opacity(0.08));
                let message_hover_surface = cx
                    .theme()
                    .colors()
                    .editor_background
                    .blend(cx.theme().colors().element_background.opacity(0.12));
                let message_border = cx.theme().colors().border_variant.opacity(0.32);
                let message_is_empty = message.body.is_empty();
                let thinking_preview = is_active_backboard.then(|| {
                    self.latest_thinking_activity()
                        .unwrap_or_else(|| "Working through the next step.".to_string())
                });
                let body = if message_is_empty {
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .h(px(6.))
                                .w_full()
                                .rounded_full()
                                .bg(cx.theme().colors().element_background),
                        )
                        .child(
                            div()
                                .h(px(6.))
                                .w_2_3()
                                .rounded_full()
                                .bg(cx.theme().colors().element_background),
                        )
                        .into_any_element()
                } else {
                    div()
                        .text_sm()
                        .line_height(gpui::relative(1.45))
                        .text_color(cx.theme().colors().text)
                        .child(display_body.clone())
                        .into_any_element()
                };

                if is_user {
                    v_flex()
                        .id(("backboard-message-row", ix))
                        .w_full()
                        .gap_2()
                        .p_3()
                        .rounded(rems_from_px(10.))
                        .border_1()
                        .border_color(message_border)
                        .bg(message_surface)
                        .hover(move |style| style.bg(message_hover_surface))
                        .child(
                            Label::new(label)
                                .size(LabelSize::XSmall)
                                .color(color)
                                .weight(FontWeight::SEMIBOLD),
                        )
                        .child(
                            div()
                                .text_sm()
                                .line_height(gpui::relative(1.45))
                                .text_color(cx.theme().colors().text)
                                .child(display_body),
                        )
                        .into_any_element()
                } else {
                    v_flex()
                        .id(("backboard-message-row", ix))
                        .w_full()
                        .gap_2()
                        .when(matches!(message.role, MessageRole::Error), |this| {
                            this.p_3()
                                .rounded(rems_from_px(10.))
                                .border_1()
                                .border_color(cx.theme().status().error_border)
                                .bg(message_surface)
                        })
                        .child(
                            h_flex()
                                .gap_1()
                                .items_center()
                                .when(
                                    matches!(message.role, MessageRole::Backboard)
                                        && message_is_empty,
                                    |this| {
                                        this.child(
                                            Icon::new(IconName::LoadCircle)
                                                .color(color)
                                                .size(IconSize::XSmall)
                                                .with_rotate_animation(2),
                                        )
                                    },
                                )
                                .child(
                                    Label::new(label)
                                        .size(LabelSize::XSmall)
                                        .color(color)
                                        .weight(FontWeight::SEMIBOLD),
                                )
                                .when(is_active_backboard, |this| {
                                    this.child(self.render_inline_activity(cx))
                                }),
                        )
                        .child(if message.full_body {
                            Self::render_full_message_body(&message.body, cx).into_any_element()
                        } else {
                            body
                        })
                        .when_some(thinking_preview, |this, thought| {
                            this.child(self.render_thinking_preview(thought, cx))
                        })
                        .when(is_active_backboard && self.activity_open, |this| {
                            this.child(self.render_activity_details(cx))
                        })
                        .into_any_element()
                }
            }))
            .when(!self.file_changes.is_empty(), |this| {
                this.child(self.render_files_changed(cx))
            })
    }

    fn render_files_changed(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let additions = self
            .file_changes
            .iter()
            .map(|change| change.additions)
            .sum::<usize>();
        let deletions = self
            .file_changes
            .iter()
            .map(|change| change.deletions)
            .sum::<usize>();
        let toggle_icon = if self.files_changed_open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        };

        v_flex()
            .mt_2()
            .rounded_xl()
            .border_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().element_background)
            .child(
                h_flex()
                    .id("backboard-files-changed-toggle")
                    .cursor_pointer()
                    .justify_between()
                    .px_3()
                    .py_2()
                    .on_click(cx.listener(|this, _, _window, cx| this.toggle_files_changed(cx)))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Label::new(format!("{} files changed", self.file_changes.len()))
                                    .size(LabelSize::Small),
                            )
                            .child(
                                Label::new(format!("+{additions}"))
                                    .size(LabelSize::Small)
                                    .color(Color::VersionControlAdded),
                            )
                            .child(
                                Label::new(format!("-{deletions}"))
                                    .size(LabelSize::Small)
                                    .color(Color::VersionControlDeleted),
                            ),
                    )
                    .child(
                        Icon::new(toggle_icon)
                            .size(IconSize::Small)
                            .color(Color::Muted),
                    ),
            )
            .when(self.files_changed_open, |this| {
                this.children(self.file_changes.iter().enumerate().map(|(ix, change)| {
                    let path = change.path.clone();
                    v_flex()
                        .border_t_1()
                        .border_color(cx.theme().colors().border)
                        .child(
                            h_flex()
                                .id(("backboard-file-change", ix))
                                .cursor_pointer()
                                .justify_between()
                                .px_3()
                                .py_2()
                                .on_click(cx.listener(move |this, _, _window, cx| {
                                    this.toggle_file_change(path.clone(), cx)
                                }))
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .child(
                                            Label::new(change.path.clone()).size(LabelSize::Small),
                                        )
                                        .child(
                                            Label::new(format!("+{}", change.additions))
                                                .size(LabelSize::Small)
                                                .color(Color::VersionControlAdded),
                                        )
                                        .child(
                                            Label::new(format!("-{}", change.deletions))
                                                .size(LabelSize::Small)
                                                .color(Color::VersionControlDeleted),
                                        ),
                                )
                                .child(
                                    Icon::new(if change.expanded {
                                        IconName::ChevronDown
                                    } else {
                                        IconName::ChevronRight
                                    })
                                    .size(IconSize::Small)
                                    .color(Color::Muted),
                                ),
                        )
                        .when(change.expanded, |this| {
                            this.child(v_flex().px_3().pb_2().gap_1().children(
                                change.preview.iter().take(12).map(|line| {
                                    let color = if line.starts_with('+') {
                                        Color::VersionControlAdded
                                    } else if line.starts_with('-') {
                                        Color::VersionControlDeleted
                                    } else {
                                        Color::Muted
                                    };
                                    Label::new(line.clone()).size(LabelSize::Small).color(color)
                                }),
                            ))
                        })
                }))
            })
    }

    fn render_composer(
        &self,
        workspace_tour_step: Option<WorkspaceTourStep>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let highlight_chat = matches!(
            workspace_tour_step,
            Some(WorkspaceTourStep::Composer | WorkspaceTourStep::TutorialPrompt)
        );
        let context_tool = div().child(
            IconButton::new("backboard-context", IconName::AtSign)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("Add context")),
        );
        let files_tool = div().child(
            IconButton::new("backboard-files", IconName::FileCode)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("Attach files")),
        );
        let voice_tool = div().child(
            IconButton::new("backboard-voice", IconName::Mic)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("Voice control")),
        );
        let voice_tool = if workspace_tour_step == Some(WorkspaceTourStep::VoiceControl) {
            render_workspace_tour_highlight(voice_tool, cx)
        } else {
            voice_tool
        };
        let skills_tool = div().child(
            IconButton::new("backboard-skills", IconName::Sparkle)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("Skills")),
        );
        let skills_tool = if matches!(
            workspace_tour_step,
            Some(WorkspaceTourStep::Skills | WorkspaceTourStep::TutorialSkills)
        ) {
            render_workspace_tour_highlight(skills_tool, cx)
        } else {
            skills_tool
        };
        let mcp_tool = div().child(
            IconButton::new("backboard-mcps", IconName::Server)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("MCP tools")),
        );
        let mcp_tool = if workspace_tour_step == Some(WorkspaceTourStep::McpTools) {
            render_workspace_tour_highlight(mcp_tool, cx)
        } else {
            mcp_tool
        };
        let agent_options_tool = div().child(
            IconButton::new("backboard-agent-options", IconName::Sliders)
                .icon_size(IconSize::Small)
                .tooltip(Tooltip::text("Agent options")),
        );
        let agent_options_tool = if matches!(
            workspace_tour_step,
            Some(WorkspaceTourStep::AgentOptions | WorkspaceTourStep::TutorialAgentOptions)
        ) {
            render_workspace_tour_highlight(agent_options_tool, cx)
        } else {
            agent_options_tool
        };

        let tools = h_flex()
            .gap_1()
            .child(context_tool)
            .child(files_tool)
            .child(voice_tool)
            .child(skills_tool)
            .child(mcp_tool)
            .child(agent_options_tool);

        let chat_input = v_flex().flex_1().min_w_0().child(self.composer.clone());
        let chat_input = if highlight_chat {
            render_workspace_tour_highlight(chat_input, cx)
        } else {
            chat_input
        };
        let send_tool = div().child(
            IconButton::new("backboard-send", IconName::Send)
                .icon_size(IconSize::Small)
                .disabled(!self.api_ready || self.streaming)
                .tooltip(Tooltip::text(if self.streaming {
                    "Backboard is running"
                } else {
                    "Send to Backboard"
                }))
                .on_click(cx.listener(|this, _, window, cx| this.send_prompt(window, cx))),
        );
        let send_tool = if highlight_chat {
            render_workspace_tour_highlight(send_tool, cx)
        } else {
            send_tool
        };

        let composer = h_flex()
            .min_h(px(58.))
            .gap_2()
            .rounded_xl()
            .border_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().editor_background)
            .px_3()
            .py_2()
            .child(tools)
            .child(chat_input)
            .child(send_tool);

        v_flex()
            .border_t_1()
            .border_color(cx.theme().colors().border)
            .bg(cx.theme().colors().panel_background)
            .px_4()
            .py_3()
            .child(composer)
    }
}

impl EventEmitter<PanelEvent> for BackboardPanel {}

impl Focusable for BackboardPanel {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Panel for BackboardPanel {
    fn persistent_name() -> &'static str {
        "Backboard"
    }

    fn panel_key() -> &'static str {
        BACKBOARD_PANEL_KEY
    }

    fn position(&self, _window: &Window, _cx: &App) -> DockPosition {
        DockPosition::Right
    }

    fn position_is_valid(&self, position: DockPosition) -> bool {
        matches!(position, DockPosition::Left | DockPosition::Right)
    }

    fn set_position(
        &mut self,
        _position: DockPosition,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
    }

    fn default_size(&self, _window: &Window, _cx: &App) -> gpui::Pixels {
        DEFAULT_WIDTH
    }

    fn icon(&self, _window: &Window, _cx: &App) -> Option<IconName> {
        Some(IconName::Sparkle)
    }

    fn icon_tooltip(&self, _window: &Window, _cx: &App) -> Option<&'static str> {
        Some("Backboard")
    }

    fn toggle_action(&self) -> Box<dyn Action> {
        Box::new(ToggleFocus)
    }

    fn is_agent_panel(&self) -> bool {
        true
    }

    fn is_zoomed(&self, _window: &Window, _cx: &App) -> bool {
        self.is_zoomed
    }

    fn set_zoomed(&mut self, zoomed: bool, _window: &mut Window, _cx: &mut Context<Self>) {
        self.is_zoomed = zoomed;
    }

    fn activation_priority(&self) -> u32 {
        8
    }
}

impl Render for BackboardPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let workspace_tour_step = self
            .workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).workspace_tour_step())
            .or_else(|| {
                Workspace::for_window(window, cx)
                    .and_then(|workspace| workspace.read(cx).workspace_tour_step())
            });

        v_flex()
            .size_full()
            .key_context("BackboardPanel")
            .track_focus(&self.focus_handle(cx))
            .bg(cx.theme().colors().editor_background)
            .child(self.render_header(cx))
            .when(self.should_show_status(), |this| {
                this.child(self.render_status(cx))
            })
            .when(self.configuring_api_key && self.api_ready, |this| {
                this.child(self.render_api_key_setup(cx))
            })
            .when(!self.api_ready, |this| {
                this.child(self.render_api_unavailable_state(cx))
            })
            .when(self.api_ready, |this| {
                this.child(self.render_messages(cx))
                    .child(self.render_model_drawer(workspace_tour_step, cx))
            })
            .child(self.render_composer(workspace_tour_step, cx))
    }
}

async fn send_backboard_prompt(
    prompt: String,
    provider: Option<String>,
    model: Option<String>,
    existing_thread_id: Option<String>,
    workspace_root: Option<PathBuf>,
    response_index: usize,
    tx: async_channel::Sender<BackboardUiEvent>,
) -> Result<()> {
    let config = backboard::BackboardConfig::load()?;
    let client = backboard::BackboardClient::from_config(config)?;

    let request = backboard::SendMessageRequest {
        thread_id: existing_thread_id.clone(),
        content: prompt,
        provider,
        model,
        tools: Some(file_tools()),
        ..Default::default()
    };

    let mut current_run_id = None;
    let mut thread_id = existing_thread_id;
    let mut stream = client.send_message_stream(request).await?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if let Some(returned_thread_id) = backboard::message_thread_id(&chunk) {
            if thread_id.as_deref() != Some(returned_thread_id.as_str()) {
                thread_id = Some(returned_thread_id.clone());
                if tx
                    .send(BackboardUiEvent::ThreadBound(returned_thread_id))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
        }
        if let Some(run_id) = run_id_from_chunk(&chunk) {
            current_run_id = Some(run_id);
        }
        handle_stream_text(&tx, response_index, &chunk).await;

        if let Some(tool_calls) = tool_calls_from_chunk(&chunk) {
            let Some(run_id) = current_run_id.clone().or_else(|| run_id_from_chunk(&chunk)) else {
                push_activity_event(
                    &tx,
                    "Backboard requested tools but did not include a run id.",
                )
                .await;
                continue;
            };
            let Some(thread_id) = thread_id.clone() else {
                push_activity_event(
                    &tx,
                    "Backboard requested tools before returning a thread id.",
                )
                .await;
                continue;
            };
            push_activity_event(
                &tx,
                format!("Running {} workspace tool(s)...", tool_calls.len()),
            )
            .await;
            let (outputs, file_changes, activities) =
                execute_tool_calls(tool_calls, workspace_root.as_deref());
            for activity in activities {
                push_activity_event(&tx, activity).await;
            }
            for file_change in file_changes {
                if tx
                    .send(BackboardUiEvent::FileChange(file_change))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
            push_activity_event(
                &tx,
                format!("Submitted {} tool result(s) to Backboard.", outputs.len()),
            )
            .await;
            let mut tool_stream = client
                .submit_tool_outputs_stream(
                    &thread_id,
                    &run_id,
                    backboard::SubmitToolOutputsRequest {
                        tool_outputs: outputs,
                        tools: Some(file_tools()),
                    },
                )
                .await?;
            while let Some(chunk) = tool_stream.next().await {
                let chunk = chunk?;
                if let Some(returned_thread_id) = backboard::message_thread_id(&chunk) {
                    if thread_id.as_str() != returned_thread_id.as_str() {
                        if tx
                            .send(BackboardUiEvent::ThreadBound(returned_thread_id))
                            .await
                            .is_err()
                        {
                            return Ok(());
                        }
                    }
                }
                handle_stream_text(&tx, response_index, &chunk).await;
            }
        }
    }

    Ok(())
}

async fn handle_stream_text(
    tx: &async_channel::Sender<BackboardUiEvent>,
    response_index: usize,
    chunk: &Value,
) {
    let Some(text) = text_from_chunk(chunk) else {
        if let Some(status) = status_from_chunk(chunk) {
            push_activity_event(tx, status).await;
        }
        return;
    };

    if tx
        .send(BackboardUiEvent::Append {
            index: response_index,
            text,
        })
        .await
        .is_err()
    {
        return;
    }
}

async fn push_activity_event(
    tx: &async_channel::Sender<BackboardUiEvent>,
    activity: impl Into<String>,
) {
    if tx
        .send(BackboardUiEvent::Activity(activity.into()))
        .await
        .is_err()
    {
        return;
    }
}

fn text_from_chunk(chunk: &Value) -> Option<String> {
    let chunk_type = chunk
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match chunk_type {
        "content_streaming" => chunk
            .get("content")
            .and_then(value_to_text)
            .and_then(clean_stream_text),
        "reasoning_streaming" => None,
        "run_ended" => chunk
            .get("content")
            .or_else(|| chunk.get("message"))
            .and_then(value_to_text)
            .and_then(clean_stream_text),
        "error" | "run_failed" => chunk
            .get("error")
            .or_else(|| chunk.get("message"))
            .and_then(value_to_text)
            .map(|text| format!("Error: {text}")),
        _ => None,
    }
}

fn status_from_chunk(chunk: &Value) -> Option<String> {
    match chunk.get("type").and_then(Value::as_str)? {
        "reasoning_started" => Some("Thinking through the request...".into()),
        "reasoning_streaming" => chunk
            .get("content")
            .and_then(value_to_text)
            .map(|text| strip_thinking_blocks(&text))
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("Thinking: {}", truncate_chars(text.trim(), 160)))
            .or_else(|| Some("Thinking through the request...".into())),
        "reasoning_ended" => Some("Finished planning the next step.".into()),
        "tool_submit_required" => Some("Backboard requested tool access.".into()),
        _ => None,
    }
}

fn clean_stream_text(text: String) -> Option<String> {
    let text = strip_thinking_blocks(&text);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn compact_message_body(role: MessageRole, body: &str) -> String {
    let cleaned = strip_thinking_blocks(body);
    let max_lines = match role {
        MessageRole::User => 1,
        MessageRole::Backboard | MessageRole::Error => 2,
    };
    let mut lines = cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let mut preview = lines.by_ref().take(max_lines).collect::<Vec<_>>().join(" ");
    let had_more_lines = lines.next().is_some();
    preview = truncate_chars(&preview, 220);
    if had_more_lines && !preview.ends_with("...") {
        preview.push_str(" ...");
    }
    preview
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn strip_thinking_blocks(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;

    loop {
        let Some(start) = rest.find("<thinking>") else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let after_start = &rest[start + "<thinking>".len()..];
        let Some(end) = after_start.find("</thinking>") else {
            break;
        };
        rest = &after_start[end + "</thinking>".len()..];
    }

    output
        .replace("<thinking>", "")
        .replace("</thinking>", "")
        .trim()
        .to_string()
}

fn value_to_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if value.is_array() || value.is_object() {
        return Some(value.to_string());
    }
    None
}

fn run_id_from_chunk(chunk: &Value) -> Option<String> {
    chunk
        .get("run_id")
        .or_else(|| chunk.pointer("/run/id"))
        .or_else(|| {
            (chunk.get("type").and_then(Value::as_str) == Some("run_started"))
                .then(|| chunk.get("id"))
                .flatten()
        })
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn tool_calls_from_chunk(chunk: &Value) -> Option<&Vec<Value>> {
    let has_tool_status = chunk.get("type").and_then(Value::as_str) == Some("tool_submit_required")
        || (chunk.get("type").and_then(Value::as_str) == Some("run_ended")
            && chunk.get("status").and_then(Value::as_str) == Some("requires_action"));
    if !has_tool_status {
        return None;
    }
    chunk.get("tool_calls")?.as_array()
}

struct ToolExecution {
    result: Value,
    file_change: Option<FileChange>,
    activity: Option<String>,
}

fn execute_tool_calls(
    tool_calls: &[Value],
    workspace_root: Option<&Path>,
) -> (Vec<Value>, Vec<FileChange>, Vec<String>) {
    let mut outputs = Vec::new();
    let mut file_changes = Vec::new();
    let mut activities = Vec::new();

    for tool_call in tool_calls {
        let tool_call_id = tool_call
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let execution = execute_tool_call(tool_call, workspace_root);
        if let Some(file_change) = execution.file_change {
            file_changes.push(file_change);
        }
        if let Some(activity) = execution.activity {
            activities.push(activity);
        }
        outputs.push(json!({
                "tool_call_id": tool_call_id,
            "output": serde_json::to_string(&execution.result).unwrap_or_else(|_| "{\"success\":false}".into())
        }));
    }

    (outputs, file_changes, activities)
}

fn execute_tool_call(tool_call: &Value, workspace_root: Option<&Path>) -> ToolExecution {
    let name = tool_call
        .pointer("/function/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = parse_tool_args(tool_call.pointer("/function/arguments"));

    match name {
        "read_file" => {
            let activity = arg_string(
                &args,
                &["target_file", "file_path", "path", "file", "filename"],
            )
            .map(|path| format!("Reading {path}"));
            ToolExecution {
                result: read_file_tool(&args, workspace_root),
                file_change: None,
                activity,
            }
        }
        "write" => write_file_tool(&args, workspace_root),
        _ => ToolExecution {
            result: json!({
                "success": false,
                "error": format!("Unsupported IDE tool: {name}. Supported tools: read_file, write")
            }),
            file_change: None,
            activity: Some(format!("Skipped unsupported tool: {name}")),
        },
    }
}

fn parse_tool_args(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or_else(|_| json!({})),
        Some(value) => value.clone(),
        None => json!({}),
    }
}

fn read_file_tool(args: &Value, workspace_root: Option<&Path>) -> Value {
    let Some(root) = workspace_root else {
        return json!({"success": false, "error": "No local workspace root is available."});
    };
    let Some(target) = arg_string(
        args,
        &["target_file", "file_path", "path", "file", "filename"],
    ) else {
        return json!({"success": false, "error": "read_file needs target_file or file_path."});
    };
    let Ok(path) = resolve_workspace_path(root, &target) else {
        return json!({"success": false, "error": "Path must stay inside the opened workspace."});
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => return json!({"success": false, "error": error.to_string()}),
    };

    let lines: Vec<&str> = content.lines().collect();
    let offset = arg_i64(args, "offset");
    let limit = arg_i64(args, "limit");
    let total = lines.len();
    let start = match offset {
        Some(value) if value < 0 => total.saturating_sub(value.unsigned_abs() as usize),
        Some(value) if value > 0 => value as usize - 1,
        _ => 0,
    };
    let end = limit
        .map(|limit| start.saturating_add(limit.max(0) as usize))
        .unwrap_or(total)
        .min(total);
    let numbered = lines[start..end]
        .iter()
        .enumerate()
        .map(|(ix, line)| format!("{:6}|{}", start + ix + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    json!({
        "success": true,
        "content": numbered,
        "total_lines": total,
        "showing": format!("{}-{}", start + 1, end),
    })
}

fn write_file_tool(args: &Value, workspace_root: Option<&Path>) -> ToolExecution {
    let Some(root) = workspace_root else {
        return ToolExecution {
            result: json!({"success": false, "error": "No local workspace root is available."}),
            file_change: None,
            activity: Some("Could not write file: no workspace root.".into()),
        };
    };
    let Some(target) = arg_string(args, &["file_path", "path", "filename", "target_file"]) else {
        return ToolExecution {
            result: json!({"success": false, "error": "write needs file_path."}),
            file_change: None,
            activity: Some("Could not write file: missing file_path.".into()),
        };
    };
    let Some(contents) = arg_string(args, &["contents", "content"]) else {
        return ToolExecution {
            result: json!({"success": false, "error": "write needs contents."}),
            file_change: None,
            activity: Some(format!("Could not write {target}: missing contents.")),
        };
    };
    let Ok(path) = resolve_workspace_path(root, &target) else {
        return ToolExecution {
            result: json!({"success": false, "error": "Path must stay inside the opened workspace."}),
            file_change: None,
            activity: Some(format!("Blocked write outside workspace: {target}")),
        };
    };
    let before = std::fs::read_to_string(&path).ok();
    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        return ToolExecution {
            result: json!({"success": false, "error": error.to_string()}),
            file_change: None,
            activity: Some(format!("Could not create parent directories for {target}.")),
        };
    }
    match std::fs::write(&path, contents) {
        Ok(()) => {
            let after = std::fs::read_to_string(&path).unwrap_or_default();
            ToolExecution {
                result: json!({"success": true, "message": format!("Wrote file: {target}")}),
                file_change: Some(build_file_change(target.clone(), before.as_deref(), &after)),
                activity: Some(format!("Wrote {target}")),
            }
        }
        Err(error) => ToolExecution {
            result: json!({"success": false, "error": error.to_string()}),
            file_change: None,
            activity: Some(format!("Could not write {target}: {error}")),
        },
    }
}

fn build_file_change(path: String, before: Option<&str>, after: &str) -> FileChange {
    let before_lines = before
        .map(|before| before.lines().collect::<Vec<_>>())
        .unwrap_or_default();
    let after_lines = after.lines().collect::<Vec<_>>();
    let max_len = before_lines.len().max(after_lines.len());
    let mut additions = 0;
    let mut deletions = 0;
    let mut preview = Vec::new();

    for index in 0..max_len {
        let before_line = before_lines.get(index).copied();
        let after_line = after_lines.get(index).copied();
        if before_line == after_line {
            continue;
        }
        if let Some(line) = before_line {
            deletions += 1;
            if preview.len() < 24 {
                preview.push(format!("- {}", truncate_chars(line.trim(), 140)));
            }
        }
        if let Some(line) = after_line {
            additions += 1;
            if preview.len() < 24 {
                preview.push(format!("+ {}", truncate_chars(line.trim(), 140)));
            }
        }
    }

    if preview.is_empty() {
        preview.push("No textual diff preview available.".into());
    }

    FileChange {
        path,
        additions,
        deletions,
        preview,
        expanded: false,
    }
}

fn arg_string(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn resolve_workspace_path(root: &Path, target: &str) -> Result<PathBuf> {
    let target = PathBuf::from(target);
    let joined = if target.is_absolute() {
        target
    } else {
        root.join(target)
    };

    if joined
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(anyhow!("parent traversal is not allowed"));
    }

    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let parent = joined
        .parent()
        .map(|parent| {
            parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf())
        })
        .unwrap_or_else(|| root.clone());
    if !parent.starts_with(&root) {
        return Err(anyhow!("path escapes workspace"));
    }

    Ok(joined)
}

fn file_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file from the opened workspace. Use target_file or file_path. Supports optional offset and limit line parameters.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_file": {"type": "string", "description": "Path relative to the opened workspace"},
                        "file_path": {"type": "string", "description": "Alias for target_file"},
                        "offset": {"type": "integer", "description": "Starting line number, 1-indexed"},
                        "limit": {"type": "integer", "description": "Number of lines to read"}
                    },
                    "required": ["target_file"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write",
                "description": "Write or create a file inside the opened workspace. Overwrites the whole file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path relative to the opened workspace"},
                        "contents": {"type": "string", "description": "Complete file contents"}
                    },
                    "required": ["file_path", "contents"]
                }
            }
        }),
    ]
}

fn format_number(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{}M", value / 1_000_000)
    } else if value >= 1_000 {
        format!("{}K", value / 1_000)
    } else {
        value.to_string()
    }
}
