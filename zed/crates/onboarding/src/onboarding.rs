use crate::multibuffer_hint::MultibufferHint;
use agent_ui::{
    AgentPanel, BackboardAgentWorkspaceKind, BackboardAgentWorkspaceMode,
    BackboardAgentWorkspaceScope,
};
use db::kvp::KeyValueStore;
use fs::Fs;
use gpui::{
    Action, AnyElement, App, AppContext, AsyncWindowContext, Context, Entity, EventEmitter,
    FocusHandle, Focusable, Global, IntoElement, KeyContext, ObjectFit, PromptLevel, Render,
    ScrollHandle, SharedString, Subscription, Task, TaskExt, WeakEntity, Window, actions, img,
};
use notifications::status_toast::StatusToast;
use schemars::JsonSchema;
use serde::Deserialize;
use settings::{SettingsStore, VsCodeSettingsSource};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ui::{
    Divider, IconName, IconSize, KeyBinding, ParentElement as _, StatefulInteractiveElement,
    Vector, VectorName, WithScrollbar as _, prelude::*, rems_from_px,
};
use ui_input::InputField;

pub use workspace::welcome::ShowWelcome;
use workspace::welcome::WelcomePage;
use workspace::{
    AppState, InterfaceMode, MultiWorkspace, OpenOptions, OpenVisible, Workspace,
    item::{Item, ItemEvent},
    open_new, register_serializable_item, with_active_or_new_workspace,
};
use zed_actions::{OpenAccountSettings, OpenOnboarding, ResetOnboarding};

mod base_keymap_picker;
mod basics_page;
mod import_settings_page;
pub mod multibuffer_hint;
mod theme_preview;

/// Imports settings from Visual Studio Code.
#[derive(Copy, Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = zed)]
#[serde(deny_unknown_fields)]
pub struct ImportVsCodeSettings {
    #[serde(default)]
    pub skip_prompt: bool,
}

/// Imports settings from Cursor editor.
#[derive(Copy, Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = zed)]
#[serde(deny_unknown_fields)]
pub struct ImportCursorSettings {
    #[serde(default)]
    pub skip_prompt: bool,
}

pub const FIRST_OPEN: &str = "first_open";
pub const DOCS_URL: &str = "https://zed.dev/docs/";
pub const EXPERIENCE_LEVEL_KVP_KEY: &str = "backboard_experience_level";
const BACKBOARD_DASHBOARD_URL: &str = "https://app.backboard.io/dashboard";
const FIRST_RUN_NAV_TIPS_STATE_KEY: &str = "backboard_first_run_nav_tips_state_v1";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ExperienceLevel {
    /// No coding background — chat-first, no file tree.
    Beginner,
    /// Knows how to code — traditional editor with AI assistance.
    Developer,
    /// Power user — full agent mode, all features unlocked.
    Power,
}

impl ExperienceLevel {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "beginner" => Some(Self::Beginner),
            "developer" => Some(Self::Developer),
            "power" => Some(Self::Power),
            _ => None,
        }
    }

    pub fn to_str(self) -> &'static str {
        match self {
            Self::Beginner => "beginner",
            Self::Developer => "developer",
            Self::Power => "power",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum FirstRepoTourWorkflow {
    FixBug,
    UnderstandCodebase,
    GenerateTest,
    RefactorFile,
    ShipFeature,
}

impl FirstRepoTourWorkflow {
    const ALL: [Self; 5] = [
        Self::FixBug,
        Self::UnderstandCodebase,
        Self::GenerateTest,
        Self::RefactorFile,
        Self::ShipFeature,
    ];

    fn from_prompt_answer(answer: usize) -> Self {
        Self::ALL.get(answer).copied().unwrap_or(Self::FixBug)
    }

    fn button_label(self) -> &'static str {
        match self {
            Self::FixBug => "Fix a Bug",
            Self::UnderstandCodebase => "Understand This Codebase",
            Self::GenerateTest => "Generate a Test",
            Self::RefactorFile => "Refactor a File",
            Self::ShipFeature => "Ship a Small Feature",
        }
    }

    fn detail_label(self) -> &'static str {
        match self {
            Self::FixBug => "Draft fix",
            Self::UnderstandCodebase => "Codepath explanation",
            Self::GenerateTest => "Test generated",
            Self::RefactorFile => "Safe edit plan",
            Self::ShipFeature => "Small feature shipped",
        }
    }

    fn focus_file(self) -> &'static str {
        match self {
            Self::GenerateTest => "test/cart.test.js",
            _ => "src/cart.js",
        }
    }

    fn task(self) -> &'static str {
        match self {
            Self::FixBug => {
                "Fix the cart subtotal bug in the sample repo. `calculateSubtotal` in `src/cart.js` should multiply each item's price by its quantity, keep `npm test` passing, and return a short draft fix summary."
            }
            Self::UnderstandCodebase => {
                "Explain the checkout codepath in this sample repo. Start from `src/cart.js`, connect it to `test/cart.test.js`, point out the existing subtotal bug, and return a concise codepath explanation."
            }
            Self::GenerateTest => {
                "Add a focused test that proves cart subtotals account for item quantity. Run `npm test` and summarize the generated test."
            }
            Self::RefactorFile => {
                "Refactor `src/cart.js` for clearer cart total calculations while keeping changes scoped. Start with a safe edit plan, make the smallest useful change, run `npm test`, and summarize the result."
            }
            Self::ShipFeature => {
                "Add support for percentage discount codes in `src/cart.js` and cover it with `node:test`. Keep the API small, run `npm test`, and summarize the shipped change."
            }
        }
    }

    fn kind(self) -> BackboardAgentWorkspaceKind {
        match self {
            Self::UnderstandCodebase => BackboardAgentWorkspaceKind::Review,
            Self::GenerateTest => BackboardAgentWorkspaceKind::Test,
            Self::FixBug | Self::RefactorFile | Self::ShipFeature => {
                BackboardAgentWorkspaceKind::Build
            }
        }
    }

    fn scope(self) -> BackboardAgentWorkspaceScope {
        match self {
            Self::GenerateTest => BackboardAgentWorkspaceScope::TestsOnly,
            _ => BackboardAgentWorkspaceScope::WholeProject,
        }
    }
}

#[derive(Clone, Copy)]
enum OnboardingStep {
    Splash,
    Welcome,
    ExperiencePicker,
    Setup(ExperienceLevel),
    ImportSettings(ExperienceLevel),
    ApiKeySetup(ExperienceLevel),
}

actions!(
    onboarding,
    [
        /// Finish the onboarding process.
        Finish,
        /// Resets the welcome screen hints to their initial state.
        ResetHints,
        /// Opens the Backboard sign-in/dashboard page.
        SignIn,
        /// Opens account settings.
        OpenAccount,
        /// Re-open the experience level picker to switch modes.
        SwitchMode
    ]
);

pub fn init(cx: &mut App) {
    cx.observe_new(|workspace: &mut Workspace, _, _cx| {
        workspace
            .register_action(|_workspace, _: &ResetHints, _, cx| MultibufferHint::set_count(0, cx));
    })
    .detach();

    cx.on_action(|_: &OpenOnboarding, cx| {
        open_onboarding(true, cx);
    });

    cx.on_action(|_: &ResetOnboarding, cx| {
        let kvp = KeyValueStore::global(cx);
        db::write_and_log(cx, move || async move {
            kvp.delete_kvp(FIRST_OPEN.to_string()).await?;
            kvp.delete_kvp(EXPERIENCE_LEVEL_KVP_KEY.to_string()).await?;
            kvp.delete_kvp(FIRST_RUN_NAV_TIPS_STATE_KEY.to_string())
                .await?;
            Ok::<(), anyhow::Error>(())
        });

        open_onboarding(true, cx);
    });

    cx.on_action(|_: &SignIn, cx| {
        cx.open_url(BACKBOARD_DASHBOARD_URL);
    });

    cx.on_action(|_: &OpenAccount, cx| {
        with_active_or_new_workspace(cx, |_, window, cx| {
            window.dispatch_action(OpenAccountSettings.boxed_clone(), cx);
        });
    });

    cx.on_action(|_: &SwitchMode, cx| {
        open_onboarding(true, cx);
    });

    cx.on_action(|_: &ShowWelcome, cx| {
        show_welcome(cx);
    });
    cx.observe_new(|workspace: &mut Workspace, _window, _cx| {
        workspace.register_action(|_workspace, action: &ImportVsCodeSettings, window, cx| {
            let fs = <dyn Fs>::global(cx);
            let action = *action;

            let workspace = cx.weak_entity();

            window
                .spawn(cx, async move |cx: &mut AsyncWindowContext| {
                    handle_import_vscode_settings(
                        workspace,
                        VsCodeSettingsSource::VsCode,
                        action.skip_prompt,
                        fs,
                        cx,
                    )
                    .await
                })
                .detach();
        });

        workspace.register_action(|_workspace, action: &ImportCursorSettings, window, cx| {
            let fs = <dyn Fs>::global(cx);
            let action = *action;

            let workspace = cx.weak_entity();

            window
                .spawn(cx, async move |cx: &mut AsyncWindowContext| {
                    handle_import_vscode_settings(
                        workspace,
                        VsCodeSettingsSource::Cursor,
                        action.skip_prompt,
                        fs,
                        cx,
                    )
                    .await
                })
                .detach();
        });
    })
    .detach();

    base_keymap_picker::init(cx);

    register_serializable_item::<Onboarding>(cx);
    register_serializable_item::<WelcomePage>(cx);
}

fn open_onboarding(reset_to_start: bool, cx: &mut App) {
    with_active_or_new_workspace(cx, move |workspace, window, cx| {
        workspace
            .with_local_workspace(window, cx, move |workspace, window, cx| {
                window.dispatch_action(workspace::CloseAllDocks.boxed_clone(), cx);
                window.dispatch_action(workspace::CloseWorkspaceSidebar.boxed_clone(), cx);

                let existing = workspace
                    .active_pane()
                    .read(cx)
                    .items()
                    .find_map(|item| item.downcast::<Onboarding>());

                if let Some(existing) = existing {
                    if reset_to_start {
                        existing.update(cx, |existing, cx| {
                            existing.restart_splash(cx);
                            cx.notify();
                        });
                    }
                    workspace.activate_item(&existing, true, true, window, cx);
                } else {
                    let page = Onboarding::new(workspace, window, cx);
                    workspace.add_item_to_active_pane(Box::new(page), None, true, window, cx)
                }
            })
            .detach();
    });
}

fn show_welcome(cx: &mut App) {
    with_active_or_new_workspace(cx, |workspace, window, cx| {
        workspace
            .with_local_workspace(window, cx, |workspace, window, cx| {
                let existing = workspace
                    .active_pane()
                    .read(cx)
                    .items()
                    .find_map(|item| item.downcast::<WelcomePage>());

                if let Some(existing) = existing {
                    workspace.activate_item(&existing, true, true, window, cx);
                } else {
                    let settings_page =
                        cx.new(|cx| WelcomePage::new(workspace.weak_handle(), false, window, cx));
                    workspace.add_item_to_active_pane(
                        Box::new(settings_page),
                        None,
                        true,
                        window,
                        cx,
                    )
                }
            })
            .detach();
    });
}

pub fn show_onboarding_view(app_state: Arc<AppState>, cx: &mut App) -> Task<anyhow::Result<()>> {
    telemetry::event!("Onboarding Page Opened");
    open_new(
        Default::default(),
        app_state,
        cx,
        |workspace, window, cx| {
            {
                workspace.close_all_docks(window, cx);
                let onboarding_page = Onboarding::new(workspace, window, cx);
                workspace.add_item_to_center(Box::new(onboarding_page.clone()), window, cx);

                window.focus(&onboarding_page.focus_handle(cx), cx);

                cx.notify();
            };
            let kvp = KeyValueStore::global(cx);
            db::write_and_log(cx, move || async move {
                kvp.write_kvp(FIRST_OPEN.to_string(), "false".to_string())
                    .await
            });
        },
    )
}

struct Onboarding {
    focus_handle: FocusHandle,
    scroll_handle: ScrollHandle,
    step: OnboardingStep,
    splash_frame: usize,
    api_key_field: Entity<InputField>,
    api_key_status: Option<SharedString>,
    _splash_task: Option<Task<()>>,
    _settings_subscription: Subscription,
}

impl Onboarding {
    const SPLASH_LINES: [&'static str; 11] = [
        "                 ████",
        "                 ████",
        "            ███  ████",
        "            ███  ████",
        "       ███  ███  ████",
        "       ███  ███  ████",
        "  ███  ███  ███  ████     ███  ███",
        "  ███  ███  ███  ████     ███  ███",
        "                 ████     ███  ███",
        "                 ████     ███",
        "                 ████",
    ];

    fn new(_workspace: &Workspace, window: &mut Window, cx: &mut App) -> Entity<Self> {
        let font_family_cache = theme::FontFamilyCache::global(cx);

        telemetry::event!("Welcome Agent Setup Viewed");
        Self::preload_onboarding_assets(cx);

        cx.new(|cx| {
            let splash_task = Self::spawn_splash_task(cx);
            let api_key_field = cx.new(|cx| {
                InputField::new(window, cx, "Paste your Backboard API key")
                    .masked(true)
                    .start_icon(IconName::LockOutlined)
            });

            cx.spawn(async move |this, cx| {
                font_family_cache.prefetch(cx).await;
                this.update(cx, |_, cx| {
                    cx.notify();
                })
            })
            .detach();

            Self {
                focus_handle: cx.focus_handle(),
                scroll_handle: ScrollHandle::new(),
                step: OnboardingStep::Splash,
                splash_frame: 0,
                api_key_field,
                api_key_status: None,
                _splash_task: Some(splash_task),
                _settings_subscription: cx
                    .observe_global::<SettingsStore>(move |_, cx| cx.notify()),
            }
        })
    }

    fn preload_onboarding_assets(cx: &App) {
        for path in [
            "onboarding/simple.png",
            "onboarding/simple_dark.png",
            "onboarding/dev.png",
            "onboarding/dev_dark.png",
            "onboarding/Visual_Studio_Code_1.35_icon.svg.png",
            "onboarding/cursor-logo-png_seeklogo-611587.png",
        ] {
            if let Err(error) = cx.asset_source().load(path) {
                zlog::debug!("failed to preload onboarding asset {path}: {error:#}");
            }
        }
    }

    fn spawn_splash_task(cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            for frame in 1..=Self::SPLASH_LINES.len() {
                cx.background_executor()
                    .timer(Duration::from_millis(150))
                    .await;
                this.update(cx, |this, cx| {
                    this.splash_frame = frame;
                    cx.notify();
                })
                .ok();
            }

            cx.background_executor()
                .timer(Duration::from_millis(850))
                .await;
            this.update(cx, |this, cx| {
                if matches!(this.step, OnboardingStep::Splash) {
                    this.step = OnboardingStep::Welcome;
                    cx.notify();
                }
            })
            .ok();
        })
    }

    fn restart_splash(&mut self, cx: &mut Context<Self>) {
        self.step = OnboardingStep::Splash;
        self.splash_frame = 0;
        self._splash_task = Some(Self::spawn_splash_task(cx));
    }

    fn on_finish(&mut self, _: &Finish, window: &mut Window, cx: &mut Context<Self>) {
        let level = match self.step {
            OnboardingStep::Setup(level) if Self::shows_import_settings_step(level) => {
                self.step = OnboardingStep::ImportSettings(level);
                cx.notify();
                return;
            }
            OnboardingStep::ImportSettings(level) => {
                self.step = OnboardingStep::ApiKeySetup(level);
                cx.notify();
                return;
            }
            OnboardingStep::Setup(level) => level,
            OnboardingStep::ApiKeySetup(level) => level,
            OnboardingStep::Splash | OnboardingStep::Welcome | OnboardingStep::ExperiencePicker => {
                return;
            }
        };

        self.finish_setup(level, window, cx);
    }

    fn finish_setup(
        &mut self,
        level: ExperienceLevel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let kvp = KeyValueStore::global(cx);
        let level_str = level.to_str().to_string();
        db::write_and_log(cx, move || async move {
            kvp.write_kvp(EXPERIENCE_LEVEL_KVP_KEY.to_string(), level_str)
                .await
        });

        telemetry::event!("Finish Setup");

        let interface_mode = match level {
            ExperienceLevel::Beginner => InterfaceMode::Simple,
            ExperienceLevel::Developer | ExperienceLevel::Power => InterfaceMode::Expert,
        };

        // Switch the running MultiWorkspace immediately so the user sees the change now.
        if let Some(mw) = window.root::<MultiWorkspace>().flatten() {
            mw.update(cx, |mw, cx| {
                mw.set_interface_mode(interface_mode, window, cx);
            });
        }

        Self::show_first_repo_tour_prompt(window, cx);

        match level {
            ExperienceLevel::Beginner => {
                close_onboarding_tab(cx);
            }
            ExperienceLevel::Developer | ExperienceLevel::Power => {
                go_to_welcome_page(cx);
            }
        }
    }

    fn show_first_repo_tour_prompt(window: &mut Window, cx: &mut Context<Self>) {
        let answers = [
            FirstRepoTourWorkflow::FixBug.button_label(),
            FirstRepoTourWorkflow::UnderstandCodebase.button_label(),
            FirstRepoTourWorkflow::GenerateTest.button_label(),
            FirstRepoTourWorkflow::RefactorFile.button_label(),
            FirstRepoTourWorkflow::ShipFeature.button_label(),
        ];
        let prompt = window.prompt(
            PromptLevel::Info,
            "Start here: fix a bug",
            Some(
                "A sample repo will open now. Pick a focused first task; the recommended path is a draft bug fix.",
            ),
            &answers,
            cx,
        );

        window
            .spawn(cx, async move |cx| {
                let workflow = match prompt.await {
                    Ok(answer) => FirstRepoTourWorkflow::from_prompt_answer(answer),
                    Err(error) => {
                        zlog::error!("first repo tour prompt closed before selection: {error}");
                        return anyhow::Ok(());
                    }
                };

                let repo_path = Self::create_first_repo_tour_repo(cx).await?;

                cx.update(|window, cx| {
                    Self::start_first_repo_tour(workflow, repo_path, window, cx);
                })?;

                let milestone_detail = format!(
                    "Success milestones:\nRepo connected: backboard-tour-repo\nFirst task started: {}\nExpected output: {}",
                    workflow.button_label(),
                    workflow.detail_label(),
                );
                let milestone_prompt = cx.update(|window, cx| {
                    window.prompt(
                        PromptLevel::Info,
                        "Repo tour started",
                        Some(&milestone_detail),
                        &["Open Agent Workspace"],
                        cx,
                    )
                })?;

                if milestone_prompt.await.is_ok() {
                    cx.update(|window, cx| {
                        if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
                            multi_workspace.update(cx, |multi_workspace, cx| {
                                multi_workspace.set_multi_agent_expanded(true, window, cx);
                            });
                        }
                    })?;
                }

                anyhow::Ok(())
            })
            .detach_and_log_err(cx);
    }

    async fn create_first_repo_tour_repo(cx: &mut AsyncWindowContext) -> anyhow::Result<PathBuf> {
        let fs = cx.update(|_, cx| <dyn Fs>::global(cx))?;
        let repo_path = Self::first_repo_tour_path();
        fs.create_dir(&repo_path).await?;

        for (relative_path, contents) in Self::first_repo_tour_files() {
            fs.write(&repo_path.join(relative_path), contents.as_bytes())
                .await?;
        }

        Ok(repo_path)
    }

    fn first_repo_tour_path() -> PathBuf {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis());
        std::env::temp_dir().join(format!("backboard-tour-repo-{timestamp_ms}"))
    }

    fn first_repo_tour_files() -> [(&'static Path, &'static str); 5] {
        [
            (
                Path::new("package.json"),
                r#"{
  "name": "backboard-tour-repo",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
"#,
            ),
            (
                Path::new("README.md"),
                r#"# Backboard Tour Repo

This tiny checkout service is intentionally small so the first Agent task can produce useful output quickly.

Try one focused workflow:

- Fix the cart subtotal bug
- Explain the checkout codepath
- Generate a focused regression test
- Refactor the cart file safely
- Ship percentage discount support
"#,
            ),
            (
                Path::new("src/cart.js"),
                r#"export function calculateSubtotal(items) {
  return items.reduce((total, item) => total + item.price, 0);
}

export function calculateTax(subtotal, taxRate) {
  return Number((subtotal * taxRate).toFixed(2));
}

export function formatReceipt(items, taxRate = 0.08) {
  const subtotal = calculateSubtotal(items);
  const tax = calculateTax(subtotal, taxRate);
  const total = subtotal + tax;

  return {
    itemCount: items.reduce((count, item) => count + item.quantity, 0),
    subtotal,
    tax,
    total,
  };
}
"#,
            ),
            (
                Path::new("test/cart.test.js"),
                r#"import assert from "node:assert/strict";
import test from "node:test";

import { calculateSubtotal, formatReceipt } from "../src/cart.js";

test("calculateSubtotal includes each item's quantity", () => {
  const items = [
    { name: "Notebook", price: 8, quantity: 2 },
    { name: "Pen", price: 3, quantity: 4 },
  ];

  assert.equal(calculateSubtotal(items), 28);
});

test("formatReceipt returns item count, tax, and total", () => {
  const receipt = formatReceipt([{ name: "Mug", price: 10, quantity: 2 }], 0.1);

  assert.deepEqual(receipt, {
    itemCount: 2,
    subtotal: 20,
    tax: 2,
    total: 22,
  });
});
"#,
            ),
            (Path::new(".gitignore"), "node_modules\n.DS_Store\n"),
        ]
    }

    fn start_first_repo_tour(
        workflow: FirstRepoTourWorkflow,
        repo_path: PathBuf,
        _window: &mut Window,
        cx: &mut App,
    ) {
        with_active_or_new_workspace(cx, move |workspace, window, cx| {
            let focus_path = repo_path.join(workflow.focus_file());
            let open_task = workspace.open_paths(
                vec![repo_path.clone(), focus_path],
                OpenOptions {
                    visible: Some(OpenVisible::All),
                    focus: Some(true),
                    ..Default::default()
                },
                None,
                window,
                cx,
            );
            cx.spawn(async move |_, _| {
                for result in open_task.await.into_iter().flatten() {
                    if let Err(error) = result {
                        zlog::error!("failed to open first repo tour path: {error:#}");
                    }
                }
            })
            .detach();

            window.defer(cx, |window, cx| {
                if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
                    multi_workspace.update(cx, |multi_workspace, cx| {
                        multi_workspace.set_multi_agent_expanded(true, window, cx);
                    });
                }
            });

            let workspace_handle = cx.weak_entity();
            cx.spawn_in(window, async move |_, cx| {
                let panel = match workspace_handle
                    .read_with(cx, |workspace, cx| workspace.panel::<AgentPanel>(cx))
                {
                    Ok(Some(panel)) => panel,
                    Ok(None) => {
                        let panel = AgentPanel::load(workspace_handle.clone(), cx.clone()).await?;
                        workspace_handle.update_in(&mut cx.clone(), |workspace, window, cx| {
                            if let Some(existing_panel) = workspace.panel::<AgentPanel>(cx) {
                                existing_panel
                            } else {
                                workspace.add_panel(panel.clone(), window, cx);
                                panel
                            }
                        })?
                    }
                    Err(error) => {
                        zlog::error!("failed to read workspace for first repo tour: {error:#}");
                        return anyhow::Ok(());
                    }
                };

                panel.update_in(&mut cx.clone(), |panel, window, cx| {
                    panel.spawn_backboard_workspace_tour_agent(
                        workflow.task().to_string(),
                        repo_path,
                        workflow.scope(),
                        workflow.kind(),
                        BackboardAgentWorkspaceMode::Free,
                        window,
                        cx,
                    );
                })?;

                anyhow::Ok(())
            })
            .detach_and_log_err(cx);
        });
    }

    fn shows_import_settings_step(level: ExperienceLevel) -> bool {
        matches!(level, ExperienceLevel::Developer | ExperienceLevel::Power)
    }

    fn primary_setup_action_label(&self) -> &'static str {
        match self.step {
            OnboardingStep::Setup(level) if Self::shows_import_settings_step(level) => "Continue",
            OnboardingStep::ImportSettings(_) => "Continue",
            OnboardingStep::Setup(_) | OnboardingStep::ApiKeySetup(_) => "Finish Setup",
            OnboardingStep::Splash | OnboardingStep::Welcome | OnboardingStep::ExperiencePicker => {
                "Finish Setup"
            }
        }
    }

    fn go_back_from_setup(&mut self, cx: &mut Context<Self>) {
        self.step = match self.step {
            OnboardingStep::ApiKeySetup(level) => OnboardingStep::ImportSettings(level),
            OnboardingStep::ImportSettings(level) => OnboardingStep::Setup(level),
            OnboardingStep::Setup(_) => OnboardingStep::ExperiencePicker,
            step => step,
        };
        cx.notify();
    }

    fn save_api_key_and_finish(
        &mut self,
        level: ExperienceLevel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let api_key = self.api_key_field.read(cx).text(cx).trim().to_string();

        if api_key.is_empty() {
            self.api_key_status = Some("Paste an API key or skip for now.".into());
            self.api_key_field
                .read(cx)
                .focus_handle(cx)
                .focus(window, cx);
            cx.notify();
            return;
        }

        match backboard::BackboardConfig::save_api_key_for_current_env(api_key) {
            Ok(_) => {
                self.api_key_status = Some("API key saved.".into());
                self.finish_setup(level, window, cx);
            }
            Err(error) => {
                self.api_key_status = Some(format!("Could not save API key: {error:#}").into());
                cx.notify();
            }
        }
    }

    fn render_page(&mut self, cx: &mut Context<Self>) -> AnyElement {
        match self.step {
            OnboardingStep::Splash => self.render_splash(cx),
            OnboardingStep::Welcome => self.render_welcome(cx),
            OnboardingStep::ExperiencePicker => self.render_experience_picker(cx),
            OnboardingStep::Setup(level) => {
                crate::basics_page::render_basics_page(level, cx).into_any_element()
            }
            OnboardingStep::ImportSettings(_) => {
                crate::import_settings_page::render_import_settings_page(cx).into_any_element()
            }
            OnboardingStep::ApiKeySetup(level) => self.render_api_key_setup(level, cx),
        }
    }

    fn render_startup_logo(&self) -> impl IntoElement {
        Vector::new(VectorName::ZedLogo, rems_from_px(132.), rems_from_px(210.))
            .color(Color::Accent)
    }

    fn render_splash(&mut self, _cx: &mut Context<Self>) -> AnyElement {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(v_flex().items_center().child(self.render_startup_logo()))
            .into_any_element()
    }

    fn render_welcome(&mut self, cx: &mut Context<Self>) -> AnyElement {
        h_flex()
            .w_full()
            .min_h(rems_from_px(620.))
            .items_center()
            .justify_center()
            .gap_10()
            .flex_wrap()
            .child(
                v_flex()
                    .w(rems_from_px(400.))
                    .items_center()
                    .gap_6()
                    .child(Vector::square(VectorName::ZedLogo, rems_from_px(56.)))
                    .child(
                        v_flex()
                            .items_center()
                            .gap_0p5()
                            .child(
                                div()
                                    .w_full()
                                    .text_center()
                                    .child(Headline::new("Backboard Studio").size(HeadlineSize::Large)),
                            )
                            .child(
                                div().w_full().text_center().child(
                                    Label::new("Your AI-native workspace")
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                            ),
                    )
                    .child(
                        v_flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div().w_full().text_center().child(
                                    Headline::new("Make yourself at home")
                                        .size(HeadlineSize::XLarge),
                                ),
                            )
                            .child(
                                div().w_full().text_center().child(
                                    Label::new(
                                        "Start with a space that feels familiar, then shape it around the way you like to build.",
                                    )
                                    .size(LabelSize::Large)
                                    .color(Color::Muted),
                                )
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .justify_center()
                            .flex_wrap()
                            .child(Self::render_welcome_pill(
                                IconName::Sparkle,
                                "Pick your flow",
                                Color::Accent,
                                cx,
                            ))
                            .child(Self::render_welcome_pill(
                                IconName::Settings,
                                "Bring your setup",
                                Color::Created,
                                cx,
                            ))
                            .child(Self::render_welcome_pill(
                                IconName::Code,
                                "Keep your tools close",
                                Color::Modified,
                                cx,
                            )),
                    )
                    .child(
                        div().rounded_full().overflow_hidden().child(
                            Button::new("continue-from-welcome", "Get Started")
                                .style(ButtonStyle::Filled)
                                .size(ButtonSize::Large)
                                .width(rems_from_px(180.))
                                .end_icon(Icon::new(IconName::ArrowRight).size(IconSize::Small))
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.step = OnboardingStep::ExperiencePicker;
                                    cx.notify();
                                })),
                        ),
                    ),
            )
            .into_any_element()
    }

    fn render_welcome_pill(
        icon: IconName,
        label: &'static str,
        color: Color,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .items_center()
            .gap_1p5()
            .rounded_full()
            .border_1()
            .border_color(cx.theme().colors().border_variant)
            .bg(cx.theme().colors().element_background.opacity(0.55))
            .px_2p5()
            .py_1()
            .child(Icon::new(icon).size(IconSize::Small).color(color))
            .child(Label::new(label).size(LabelSize::Small).color(Color::Muted))
    }

    fn render_experience_picker(&mut self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .w_full()
            .py_10()
            .items_center()
            .gap_8()
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div().w_full().text_center().child(
                            Headline::new("Choose your front door").size(HeadlineSize::Large),
                        ),
                    )
                    .child(
                        div().w_full().text_center().child(
                            Label::new(
                                "Start where you feel most at home. You can switch modes any time.",
                            )
                            .color(Color::Muted)
                            .size(LabelSize::Small),
                        ),
                    ),
            )
            .child(
                h_flex()
                    .gap_6()
                    .items_stretch()
                    .justify_center()
                    .flex_wrap()
                    .child(self.render_level_card(
                        ExperienceLevel::Beginner,
                        true,
                        "Simple",
                        "Chat first",
                        "A streamlined workspace for prompting, previewing, and iterating.",
                        cx,
                    ))
                    .child(self.render_level_card(
                        ExperienceLevel::Developer,
                        false,
                        "Developer",
                        "Editor first",
                        "The full workspace with files, terminal, editor, and agents visible.",
                        cx,
                    )),
            )
            .into_any_element()
    }

    fn render_level_card(
        &mut self,
        level: ExperienceLevel,
        is_simple: bool,
        title: &'static str,
        eyebrow: &'static str,
        description: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors();

        div()
            .id(SharedString::from(title))
            .w(rems_from_px(520.))
            .flex()
            .flex_col()
            .gap_4()
            .cursor_pointer()
            .hover(|style| style.opacity(0.92))
            .on_click(cx.listener(move |this, _, _window, cx| {
                this.step = OnboardingStep::Setup(level);
                cx.notify();
            }))
            .child(
                div()
                    .w_full()
                    .h(rems_from_px(312.))
                    .rounded_md()
                    .border_1()
                    .border_color(colors.border_variant)
                    .bg(colors.editor_background)
                    .overflow_hidden()
                    .child(
                        self.render_mode_screenshot(Self::mode_screenshot_path(is_simple, cx), cx)
                            .into_any_element(),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap_4()
                    .child(
                        v_flex()
                            .min_w_0()
                            .flex_1()
                            .gap_1()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .child(Headline::new(title).size(HeadlineSize::Large))
                                    .child(
                                        Label::new(eyebrow)
                                            .size(LabelSize::Small)
                                            .color(Color::Accent),
                                    ),
                            )
                            .child(
                                Label::new(description)
                                    .color(Color::Muted)
                                    .size(LabelSize::Small),
                            ),
                    )
                    .child(
                        div().rounded_full().overflow_hidden().child(
                            Button::new(SharedString::from(format!("continue-{title}")), "Start")
                                .style(ButtonStyle::Subtle)
                                .width(rems_from_px(112.))
                                .end_icon(Icon::new(IconName::ArrowRight).size(IconSize::Small))
                                .on_click(cx.listener(move |this, _, _window, cx| {
                                    this.step = OnboardingStep::Setup(level);
                                    cx.notify();
                                })),
                        ),
                    ),
            )
    }

    fn render_mode_screenshot(&self, path: &'static str, _cx: &Context<Self>) -> impl IntoElement {
        img(path)
            .size_full()
            .object_fit(ObjectFit::Contain)
            .with_fallback(|| div().size_full().into_any_element())
    }

    fn mode_screenshot_path(is_simple: bool, cx: &Context<Self>) -> &'static str {
        match (is_simple, cx.theme().appearance()) {
            (true, theme::Appearance::Dark) => "onboarding/simple_dark.png",
            (false, theme::Appearance::Dark) => "onboarding/dev_dark.png",
            (true, _) => "onboarding/simple.png",
            (false, _) => "onboarding/dev.png",
        }
    }

    fn render_api_key_setup(
        &mut self,
        level: ExperienceLevel,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let has_key = backboard::BackboardConfig::load_or_default()
            .api_key()
            .is_some();
        let status = self.api_key_status.clone();

        v_flex()
            .id("api-key-setup-page")
            .w_full()
            .py_12()
            .items_center()
            .gap_7()
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(Headline::new("Connect Backboard").size(HeadlineSize::Large))
                    .child(
                        Label::new("Add your API key now, or skip it for later.")
                            .color(Color::Muted)
                            .size(LabelSize::Small),
                    ),
            )
            .child(
                v_flex()
                    .w(rems_from_px(520.))
                    .rounded_lg()
                    .border_1()
                    .border_color(cx.theme().colors().border_variant)
                    .bg(cx.theme().colors().element_background.opacity(0.35))
                    .p_5()
                    .gap_5()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .size(rems_from_px(34.))
                                    .rounded_md()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .bg(cx.theme().colors().text_accent.opacity(0.12))
                                    .child(
                                        Icon::new(if has_key {
                                            IconName::Check
                                        } else {
                                            IconName::LockOutlined
                                        })
                                        .size(IconSize::Small)
                                        .color(if has_key {
                                            Color::Success
                                        } else {
                                            Color::Accent
                                        }),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(Label::new(if has_key {
                                        "API key configured"
                                    } else {
                                        "Paste your Backboard API key"
                                    }))
                                    .child(
                                        Label::new(
                                            "No key handy? Skip this and connect later from Settings.",
                                        )
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                    ),
                            ),
                    )
                    .when(!has_key, |this| this.child(self.api_key_field.clone()))
                    .when_some(status, |this, status| {
                        this.child(
                            Label::new(status)
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        )
                    })
                    .child(
                        div().rounded_full().overflow_hidden().child(
                            Button::new("open-backboard-dashboard", "Open Backboard Dashboard")
                                .style(ButtonStyle::OutlinedGhost)
                                .full_width()
                                .on_click(|_, _, cx| {
                                    cx.open_url(BACKBOARD_DASHBOARD_URL);
                                }),
                        ),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .when(!has_key, |this| {
                                this.child(
                                    div().rounded_full().overflow_hidden().flex_1().child(
                                        Button::new("skip-api-key", "Skip for now")
                                            .style(ButtonStyle::Subtle)
                                            .full_width()
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.finish_setup(level, window, cx);
                                            })),
                                    ),
                                )
                            })
                            .child(
                                div().rounded_full().overflow_hidden().flex_1().child(
                                    Button::new(
                                        "save-api-key-and-finish",
                                        if has_key {
                                            "Finish Setup"
                                        } else {
                                            "Save and Finish"
                                        },
                                    )
                                    .style(ButtonStyle::Filled)
                                    .full_width()
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            if has_key {
                                                this.finish_setup(level, window, cx);
                                            } else {
                                                this.save_api_key_and_finish(level, window, cx);
                                            }
                                        },
                                    )),
                                ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_asset_preloads(&self) -> impl IntoElement {
        div()
            .id("onboarding-asset-preloads")
            .absolute()
            .top(px(-10000.))
            .left(px(-10000.))
            .size(px(1.))
            .overflow_hidden()
            .opacity(0.)
            .children(
                [
                    "onboarding/simple.png",
                    "onboarding/simple_dark.png",
                    "onboarding/dev.png",
                    "onboarding/dev_dark.png",
                    "onboarding/Visual_Studio_Code_1.35_icon.svg.png",
                    "onboarding/cursor-logo-png_seeklogo-611587.png",
                ]
                .map(|path| {
                    img(path)
                        .size(rems_from_px(320.))
                        .object_fit(ObjectFit::Contain)
                        .into_any_element()
                }),
            )
    }
}

impl Render for Onboarding {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let is_setup = matches!(
            self.step,
            OnboardingStep::Setup(_)
                | OnboardingStep::ImportSettings(_)
                | OnboardingStep::ApiKeySetup(_)
        );
        let is_intro = matches!(self.step, OnboardingStep::Splash | OnboardingStep::Welcome);
        let is_experience_picker = matches!(self.step, OnboardingStep::ExperiencePicker);
        let primary_setup_action_label = self.primary_setup_action_label();

        div()
            .image_cache(gpui::retain_all("onboarding-page"))
            .key_context({
                let mut ctx = KeyContext::new_with_defaults();
                ctx.add("Onboarding");
                ctx.add("menu");
                ctx
            })
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(cx.theme().colors().editor_background)
            .child(self.render_asset_preloads())
            .on_action(cx.listener(Self::on_finish))
            .on_action(cx.listener(|_, _: &menu::SelectNext, window, cx| {
                window.focus_next(cx);
                cx.notify();
            }))
            .on_action(cx.listener(|_, _: &menu::SelectPrevious, window, cx| {
                window.focus_prev(cx);
                cx.notify();
            }))
            .vertical_scrollbar_for(&self.scroll_handle, window, cx)
            .child(
                div()
                    .id("page-content")
                    .size_full()
                    .overflow_y_scroll()
                    .child(
                        v_flex()
                            .min_w_0()
                            .max_w(rems_from_px(if is_experience_picker {
                                1280.
                            } else if is_intro {
                                960.
                            } else {
                                920.
                            }))
                            .w_full()
                            .mx_auto()
                            .p_12()
                            .gap_6()
                            .when(!is_intro, |this| {
                                this.child(
                                    h_flex()
                                        .w_full()
                                        .gap_4()
                                        .justify_between()
                                        .child(
                                            h_flex()
                                                .gap_4()
                                                .child(Vector::square(
                                                    VectorName::ZedLogo,
                                                    rems(2.5),
                                                ))
                                                .child(
                                                    v_flex()
                                                        .child(
                                                            Headline::new("Backboard Studio")
                                                                .size(HeadlineSize::Small),
                                                        )
                                                        .child(
                                                            Label::new("Focused setup")
                                                                .color(Color::Muted)
                                                                .size(LabelSize::Small)
                                                                .italic(),
                                                        ),
                                                ),
                                        )
                                        .when(is_setup, |this| {
                                            this.child(
                                                h_flex()
                                                    .gap_3()
                                                    .child(
                                                        Button::new("back", "← Back")
                                                            .style(ButtonStyle::Subtle)
                                                            .size(ButtonSize::Medium)
                                                            .on_click(cx.listener(
                                                                |this, _, _, cx| {
                                                                    this.go_back_from_setup(cx);
                                                                },
                                                            )),
                                                    )
                                                    .child(
                                                        Button::new(
                                                            "finish_setup",
                                                            primary_setup_action_label,
                                                        )
                                                        .style(ButtonStyle::Filled)
                                                        .size(ButtonSize::Medium)
                                                        .width(rems_from_px(160.))
                                                        .key_binding(KeyBinding::for_action_in(
                                                            &Finish,
                                                            &self.focus_handle,
                                                            cx,
                                                        ))
                                                        .on_click(|_, window, cx| {
                                                            window.dispatch_action(
                                                                Finish.boxed_clone(),
                                                                cx,
                                                            );
                                                        }),
                                                    ),
                                            )
                                        }),
                                )
                            })
                            .when(!is_intro, |this| {
                                this.child(
                                    Divider::horizontal().color(ui::DividerColor::BorderVariant),
                                )
                            })
                            .child(self.render_page(cx)),
                    )
                    .track_scroll(&self.scroll_handle),
            )
    }
}

impl EventEmitter<ItemEvent> for Onboarding {}

impl Focusable for Onboarding {
    fn focus_handle(&self, _: &App) -> gpui::FocusHandle {
        self.focus_handle.clone()
    }
}

impl Item for Onboarding {
    type Event = ItemEvent;

    fn tab_content_text(&self, _detail: usize, _cx: &App) -> SharedString {
        "Onboarding".into()
    }

    fn telemetry_event_text(&self) -> Option<&'static str> {
        Some("Onboarding Page Opened")
    }

    fn show_toolbar(&self) -> bool {
        false
    }

    fn can_split(&self) -> bool {
        false
    }

    fn is_fullscreen_onboarding(&self) -> bool {
        true
    }

    fn to_item_events(event: &Self::Event, f: &mut dyn FnMut(workspace::item::ItemEvent)) {
        f(*event)
    }
}

fn close_onboarding_tab(cx: &mut App) {
    with_active_or_new_workspace(cx, |workspace, window, cx| {
        let Some(onboarding_id) = workspace.active_pane().read(cx).items().find_map(|item| {
            item.downcast::<Onboarding>()?;
            Some(item.item_id())
        }) else {
            return;
        };

        workspace.active_pane().update(cx, |pane, cx| {
            pane.remove_item(onboarding_id, false, false, window, cx);
        });
    });
}

fn go_to_welcome_page(cx: &mut App) {
    with_active_or_new_workspace(cx, |workspace, window, cx| {
        let Some(onboarding_id) = workspace.active_pane().read(cx).items().find_map(|item| {
            let _ = item.downcast::<Onboarding>()?;
            Some(item.item_id())
        }) else {
            return;
        };

        workspace.active_pane().update(cx, |pane, cx| {
            pane.remove_item(onboarding_id, false, false, window, cx);
            window.focus(&pane.focus_handle(cx), cx);
        });
    });
}

pub async fn handle_import_vscode_settings(
    workspace: WeakEntity<Workspace>,
    source: VsCodeSettingsSource,
    skip_prompt: bool,
    fs: Arc<dyn Fs>,
    cx: &mut AsyncWindowContext,
) {
    use util::truncate_and_remove_front;

    let vscode_settings =
        match settings::VsCodeSettings::load_user_settings(source, fs.clone()).await {
            Ok(vscode_settings) => vscode_settings,
            Err(err) => {
                zlog::error!("{err:?}");
                let _ = cx.prompt(
                    gpui::PromptLevel::Info,
                    &format!("Could not find or load a {source} settings file"),
                    None,
                    &["Ok"],
                );
                return;
            }
        };

    if !skip_prompt {
        let prompt = cx.prompt(
            gpui::PromptLevel::Warning,
            &format!(
                "Importing {} settings may overwrite your existing settings. \
                Will import settings from {}",
                vscode_settings.source,
                truncate_and_remove_front(&vscode_settings.path.to_string_lossy(), 128),
            ),
            None,
            &["Ok", "Cancel"],
        );
        let result = cx.spawn(async move |_| prompt.await.ok()).await;
        if result != Some(0) {
            return;
        }
    };

    let Ok(result_channel) = cx.update(|_, cx| {
        let source = vscode_settings.source;
        let path = vscode_settings.path.clone();
        let result_channel = cx
            .global::<SettingsStore>()
            .import_vscode_settings(fs, vscode_settings);
        zlog::info!("Imported {source} settings from {}", path.display());
        result_channel
    }) else {
        return;
    };

    let result = result_channel.await;
    workspace
        .update_in(cx, |workspace, _, cx| match result {
            Ok(_) => {
                let confirmation_toast = StatusToast::new(
                    format!("Your {} settings were successfully imported.", source),
                    cx,
                    |this, _| {
                        this.icon(
                            Icon::new(IconName::Check)
                                .size(IconSize::Small)
                                .color(Color::Success),
                        )
                        .dismiss_button(true)
                    },
                );
                SettingsImportState::update(cx, |state, _| match source {
                    VsCodeSettingsSource::VsCode => {
                        state.vscode = true;
                    }
                    VsCodeSettingsSource::Cursor => {
                        state.cursor = true;
                    }
                });
                workspace.toggle_status_toast(confirmation_toast, cx);
            }
            Err(_) => {
                let error_toast = StatusToast::new(
                    "Failed to import settings. See log for details",
                    cx,
                    |this, _| {
                        this.icon(
                            Icon::new(IconName::Close)
                                .size(IconSize::Small)
                                .color(Color::Error),
                        )
                        .action("Open Log", |window, cx| {
                            window.dispatch_action(workspace::OpenLog.boxed_clone(), cx)
                        })
                        .dismiss_button(true)
                    },
                );
                workspace.toggle_status_toast(error_toast, cx);
            }
        })
        .ok();
}

#[derive(Default, Copy, Clone)]
pub struct SettingsImportState {
    pub cursor: bool,
    pub vscode: bool,
}

impl Global for SettingsImportState {}

impl SettingsImportState {
    pub fn global(cx: &App) -> Self {
        cx.try_global().cloned().unwrap_or_default()
    }
    pub fn update<R>(cx: &mut App, f: impl FnOnce(&mut Self, &mut App) -> R) -> R {
        cx.update_default_global(f)
    }
}

impl workspace::SerializableItem for Onboarding {
    fn serialized_item_kind() -> &'static str {
        "OnboardingPage"
    }

    fn cleanup(
        workspace_id: workspace::WorkspaceId,
        alive_items: Vec<workspace::ItemId>,
        _window: &mut Window,
        cx: &mut App,
    ) -> gpui::Task<gpui::Result<()>> {
        workspace::delete_unloaded_items(
            alive_items,
            workspace_id,
            "onboarding_pages",
            &persistence::OnboardingPagesDb::global(cx),
            cx,
        )
    }

    fn deserialize(
        _project: Entity<project::Project>,
        workspace: WeakEntity<Workspace>,
        workspace_id: workspace::WorkspaceId,
        item_id: workspace::ItemId,
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::Task<gpui::Result<Entity<Self>>> {
        let db = persistence::OnboardingPagesDb::global(cx);
        window.spawn(cx, async move |cx| {
            if let Some(_) = db.get_onboarding_page(item_id, workspace_id)? {
                workspace.update_in(cx, |workspace, window, cx| {
                    Onboarding::new(workspace, window, cx)
                })
            } else {
                Err(anyhow::anyhow!("No onboarding page to deserialize"))
            }
        })
    }

    fn serialize(
        &mut self,
        workspace: &mut Workspace,
        item_id: workspace::ItemId,
        _closing: bool,
        _window: &mut Window,
        cx: &mut ui::Context<Self>,
    ) -> Option<gpui::Task<gpui::Result<()>>> {
        let workspace_id = workspace.database_id()?;

        let db = persistence::OnboardingPagesDb::global(cx);
        Some(
            cx.background_spawn(
                async move { db.save_onboarding_page(item_id, workspace_id).await },
            ),
        )
    }

    fn should_serialize(&self, event: &Self::Event) -> bool {
        event == &ItemEvent::UpdateTab
    }
}

mod persistence {
    use db::{
        query,
        sqlez::{domain::Domain, thread_safe_connection::ThreadSafeConnection},
        sqlez_macros::sql,
    };
    use workspace::WorkspaceDb;

    pub struct OnboardingPagesDb(ThreadSafeConnection);

    impl Domain for OnboardingPagesDb {
        const NAME: &str = stringify!(OnboardingPagesDb);

        const MIGRATIONS: &[&str] = &[
            sql!(
                        CREATE TABLE onboarding_pages (
                            workspace_id INTEGER,
                            item_id INTEGER UNIQUE,
                            page_number INTEGER,

                            PRIMARY KEY(workspace_id, item_id),
                            FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
                            ON DELETE CASCADE
                        ) STRICT;
            ),
            sql!(
                        CREATE TABLE onboarding_pages_2 (
                            workspace_id INTEGER,
                            item_id INTEGER UNIQUE,

                            PRIMARY KEY(workspace_id, item_id),
                            FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
                            ON DELETE CASCADE
                        ) STRICT;
                        INSERT INTO onboarding_pages_2 SELECT workspace_id, item_id FROM onboarding_pages;
                        DROP TABLE onboarding_pages;
                        ALTER TABLE onboarding_pages_2 RENAME TO onboarding_pages;
            ),
        ];
    }

    db::static_connection!(OnboardingPagesDb, [WorkspaceDb]);

    impl OnboardingPagesDb {
        query! {
            pub async fn save_onboarding_page(
                item_id: workspace::ItemId,
                workspace_id: workspace::WorkspaceId
            ) -> Result<()> {
                INSERT OR REPLACE INTO onboarding_pages(item_id, workspace_id)
                VALUES (?, ?)
            }
        }

        query! {
            pub fn get_onboarding_page(
                item_id: workspace::ItemId,
                workspace_id: workspace::WorkspaceId
            ) -> Result<Option<workspace::ItemId>> {
                SELECT item_id
                FROM onboarding_pages
                WHERE item_id = ? AND workspace_id = ?
            }
        }
    }
}
