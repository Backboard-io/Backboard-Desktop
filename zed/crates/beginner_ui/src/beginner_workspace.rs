use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use acp_thread::{
    AcpThread, AcpThreadEvent, AgentModelInfo, AgentModelList, AgentModelSelector,
    AssistantMessageChunk, SelectedPermissionOutcome, ThreadStatus, ToolCallStatus,
};
use agent_client_protocol::schema as acp;
use agent_ui::thread_metadata_store::{ThreadId, ThreadMetadataStore};
use agent_ui::{
    AddContextServer, AgentPanel, BackboardAgentWorkspaceChatOptions, BackboardAgentWorkspaceKind,
    BackboardAgentWorkspaceMode, BackboardAgentWorkspaceScope, ConversationView,
    ModelSelectorPopover,
};
use anyhow::{Context as AnyhowContext, Result, bail};
use db::kvp::KeyValueStore;
use editor::actions::{Cancel as EditorCancel, Newline};
use editor::{Editor, EditorEvent};
use gpui::{
    Animation, AnimationExt, AnyElement, App, AsyncWindowContext, ClipboardItem, Context,
    DragMoveEvent, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, MouseUpEvent, ObjectFit, PathPromptOptions, Pixels,
    Render, SharedString, Subscription, Task, TextStyleRefinement, WeakEntity, Window,
    WindowControlArea, canvas, ease_out_quint, img,
};
use indexmap::IndexMap;
use onboarding::{EXPERIENCE_LEVEL_KVP_KEY, ExperienceLevel};
use project::Project;
use serde_json::Value;
use settings::Settings;
use terminal_view::TerminalView;
use theme_settings::ThemeSettings;
use ui::{
    Button, ButtonSize, ButtonStyle, Color, ContextMenu, ContextMenuEntry, DropdownMenu,
    DropdownStyle, Icon, IconButton, IconName, IconPosition, IconSize, Label, LabelSize, Tooltip,
    prelude::*,
};
use util::ResultExt;
use workspace::{
    MultiWorkspace, OpenOptions, OpenVisible, PathList, Workspace,
    notifications::DetachAndPromptErr,
};
use zed_actions::{ConfigureBackboardApiKey, OpenSettings, ResetOnboarding};

use acp_thread::AgentThreadEntry;

use crate::beginner_chat_feed::{
    BeginnerChatFeed, BeginnerChatFeedEvent, ChatFeedDisplayMode, PreviewCardState,
};
use crate::file_changes_panel::{FileChangesPanel, FileChangesPanelEvent};
use crate::simple_design as ds;

struct CuratedSimpleModel {
    provider_hint: &'static str,
    model_hints: &'static [&'static str],
    display_name: &'static str,
}

/// Provider/model ID hints for the curated simple-mode model list.
/// Matched against live ACP model IDs returned by the Backboard catalog.
static CURATED_MODELS: &[CuratedSimpleModel] = &[
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-opus-4", "claude-4-opus"],
        display_name: "Claude Opus 4 (maximum reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-sonnet-4", "claude-4-sonnet"],
        display_name: "Claude Sonnet 4 (balanced coding)",
    },
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-haiku-4", "claude-4-haiku"],
        display_name: "Claude Haiku 4 (fast)",
    },
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-3-7-sonnet", "claude-3.7-sonnet"],
        display_name: "Claude 3.7 Sonnet (reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-3-5-sonnet", "claude-3.5-sonnet"],
        display_name: "Claude 3.5 Sonnet (fast coding)",
    },
    CuratedSimpleModel {
        provider_hint: "anthropic",
        model_hints: &["claude-3-5-haiku", "claude-3.5-haiku"],
        display_name: "Claude 3.5 Haiku (fast)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["o3-pro"],
        display_name: "o3-pro (deep reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["o3"],
        display_name: "o3 (reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["o4-mini"],
        display_name: "o4-mini (fast reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["gpt-4.1", "gpt-4-1"],
        display_name: "GPT-4.1 (coding)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["gpt-4o-mini"],
        display_name: "GPT-4o mini (fast general)",
    },
    CuratedSimpleModel {
        provider_hint: "openai",
        model_hints: &["gpt-4o"],
        display_name: "GPT-4o (general)",
    },
    CuratedSimpleModel {
        provider_hint: "google",
        model_hints: &["gemini-2.5-pro", "gemini-2-5-pro"],
        display_name: "Gemini 2.5 Pro (long-context reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "google",
        model_hints: &["gemini-2.5-flash", "gemini-2-5-flash"],
        display_name: "Gemini 2.5 Flash (fast multimodal)",
    },
    CuratedSimpleModel {
        provider_hint: "google",
        model_hints: &["gemini-2.0-flash", "gemini-2-0-flash"],
        display_name: "Gemini 2.0 Flash (fast)",
    },
    CuratedSimpleModel {
        provider_hint: "deepseek",
        model_hints: &["deepseek-r1"],
        display_name: "DeepSeek R1 (reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "deepseek",
        model_hints: &["deepseek-v3", "deepseek-chat"],
        display_name: "DeepSeek V3 (chat and coding)",
    },
    CuratedSimpleModel {
        provider_hint: "deepseek",
        model_hints: &["deepseek-v2.5", "deepseek-v2-5"],
        display_name: "DeepSeek V2.5 (legacy)",
    },
    CuratedSimpleModel {
        provider_hint: "qwen",
        model_hints: &["qwen3"],
        display_name: "Qwen3 (reasoning)",
    },
    CuratedSimpleModel {
        provider_hint: "qwen",
        model_hints: &["qwen2.5-coder", "qwen2-5-coder"],
        display_name: "Qwen2.5 Coder (coding)",
    },
    CuratedSimpleModel {
        provider_hint: "qwen",
        model_hints: &["qwen2.5", "qwen2-5"],
        display_name: "Qwen2.5 (general)",
    },
];

const SIMPLE_LANDING_LOGO_PATH: &str = "images/animation_logo.png";
const SIMPLE_PREVIEW_PORT: u16 = 3000;
const PANEL_OPEN_ANIMATION_MS: u64 = 210;
const SIMPLE_SIDEBAR_HOVER_OPEN_DELAY_MS: u64 = 3000;
const SIMPLE_SIDEBAR_HOVER_OPEN_POLL_MS: u64 = 100;
const PANEL_OPEN_SLIDE_OFFSET_PX: f32 = 28.0;
const RIGHT_PANEL_FADE_START_OPACITY: f32 = 0.94;
const RIGHT_PANEL_CLOSED_WIDTH_PX: f32 = 52.0;
const DOCKED_PANEL_DEFAULT_HEIGHT_PX: f32 = 340.0;
const DOCKED_PANEL_MIN_HEIGHT_PX: f32 = 220.0;
const DOCKED_PANEL_MIN_MAIN_SIZE_PX: f32 = 240.0;
const CLOSED_CHATS_SIDEBAR_WIDTH_PX: f32 = 48.0;
const FILES_SPLIT_MIN_DIRECTORY_WIDTH_PX: f32 = 160.0;
const FILES_SPLIT_MIN_CODE_WIDTH_PX: f32 = 160.0;
const MAX_UNTRACKED_DIFF_BYTES: u64 = 256 * 1024;
const PROJECT_HISTORY_STOP_WORDS: &[&str] = &[
    "a",
    "an",
    "the",
    "make",
    "build",
    "create",
    "add",
    "set",
    "up",
    "me",
    "my",
    "i",
    "want",
    "please",
    "can",
    "you",
    "that",
    "this",
    "it",
    "some",
    "just",
    "something",
    "new",
    "simple",
    "basic",
    "cool",
    "nice",
    "good",
    "great",
    "modern",
    "clean",
    "help",
    "do",
    "write",
    "give",
    "project",
];

struct PreviewLaunch {
    folder: PathBuf,
    command: String,
    url_path: String,
}

fn curated_model_match(model: &AgentModelInfo) -> Option<(usize, &'static str)> {
    curated_model_match_with_provider(model, None)
}

fn curated_model_match_with_provider(
    model: &AgentModelInfo,
    provider_hint: Option<&str>,
) -> Option<(usize, &'static str)> {
    let provider = model_provider_id(model, provider_hint);
    let model_id = model_id_without_provider(model.id.0.as_ref());
    let model_name = model.name.to_lowercase();

    CURATED_MODELS
        .iter()
        .enumerate()
        .find_map(|(index, model)| {
            let provider_hint = canonical_simple_model_provider(model.provider_hint);
            (provider == provider_hint
                && model
                    .model_hints
                    .iter()
                    .any(|model_hint| curated_model_id_matches(&model_id, model_hint, &model_name)))
            .then_some((index, model.display_name))
        })
}

fn model_provider_id(model: &AgentModelInfo, provider_hint: Option<&str>) -> String {
    let model_id = model.id.0.as_ref().to_lowercase();
    if let Some((provider, _)) = model_id.split_once('/') {
        return canonical_simple_model_provider(provider);
    }

    if let Some(provider_hint) = provider_hint {
        let provider = canonical_simple_model_provider(provider_hint);
        if !provider.is_empty() {
            return provider;
        }
    }

    model
        .description
        .as_ref()
        .map(|description| canonical_simple_model_provider(description.as_ref()))
        .unwrap_or_default()
}

fn canonical_simple_model_provider(provider: &str) -> String {
    match provider.trim().to_lowercase().as_str() {
        "google_ai" | "google ai" | "gemini" => "google".to_string(),
        "x_ai" | "x ai" => "xai".to_string(),
        "amazon" | "amazon bedrock" | "amazon-bedrock" | "aws" | "aws_bedrock" | "aws bedrock"
        | "bedrock" => "aws-bedrock".to_string(),
        provider => provider.to_string(),
    }
}

fn model_id_without_provider(model_id: &str) -> String {
    model_id
        .split_once('/')
        .map(|(_, model)| model)
        .unwrap_or(model_id)
        .to_lowercase()
}

fn curated_model_id_matches(model_id: &str, model_hint: &str, model_name: &str) -> bool {
    let model_hint = model_hint.to_lowercase();
    if model_id == model_hint || model_name == model_hint {
        return true;
    }

    let Some(suffix) = model_id.strip_prefix(&model_hint) else {
        return false;
    };
    let Some(suffix) = suffix
        .strip_prefix('-')
        .or_else(|| suffix.strip_prefix('_'))
        .or_else(|| suffix.strip_prefix('.'))
    else {
        return false;
    };

    suffix
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
        || suffix.starts_with("preview")
}

fn relabel_curated_model(mut model: AgentModelInfo) -> Option<(usize, AgentModelInfo)> {
    let (rank, display_name) = curated_model_match(&model)?;
    model.name = SharedString::from(display_name);
    Some((rank, model))
}

fn relabel_curated_model_with_provider(
    mut model: AgentModelInfo,
    provider_hint: Option<&str>,
) -> Option<(usize, AgentModelInfo)> {
    let (rank, display_name) = curated_model_match_with_provider(&model, provider_hint)?;
    model.name = SharedString::from(display_name);
    Some((rank, model))
}

fn dedupe_curated_models(models: Vec<(usize, AgentModelInfo)>) -> Vec<AgentModelInfo> {
    let mut deduped_by_rank = IndexMap::new();
    for (rank, model) in models {
        deduped_by_rank.entry(rank).or_insert(model);
    }

    let mut deduped = deduped_by_rank.into_iter().collect::<Vec<_>>();
    deduped.sort_by_key(|(rank, _)| *rank);
    deduped.into_iter().map(|(_, model)| model).collect()
}

fn curated_or_live_model_list(model_list: AgentModelList) -> AgentModelList {
    match model_list {
        AgentModelList::Flat(list) => {
            let mut curated = list
                .iter()
                .cloned()
                .filter_map(relabel_curated_model)
                .collect::<Vec<_>>();
            if curated.is_empty() {
                return AgentModelList::Flat(list);
            }

            curated.sort_by_key(|(rank, _)| *rank);
            AgentModelList::Flat(dedupe_curated_models(curated))
        }
        AgentModelList::Grouped(groups) => {
            let mut curated_groups = Vec::new();
            for (group_name, models) in &groups {
                let mut curated = models
                    .iter()
                    .cloned()
                    .filter_map(|model| {
                        relabel_curated_model_with_provider(model, Some(group_name.0.as_ref()))
                    })
                    .collect::<Vec<_>>();
                if curated.is_empty() {
                    continue;
                }

                curated.sort_by_key(|(rank, _)| *rank);
                curated_groups.push((group_name.clone(), dedupe_curated_models(curated)));
            }

            if curated_groups.is_empty() {
                AgentModelList::Grouped(groups)
            } else {
                AgentModelList::Grouped(curated_groups.into_iter().collect())
            }
        }
    }
}

#[cfg(test)]
mod simple_mode_draft_tests {
    use super::*;
    use fs::FakeFs;
    use gpui::{TestAppContext, VisualTestContext};
    use language_model::LanguageModelRegistry;
    use project::Project;
    use serde_json::json;
    use settings::SettingsStore;
    use std::{path::Path, sync::atomic::AtomicUsize};

    fn init_test(cx: &mut TestAppContext) {
        cx.update(|cx| {
            let settings_store = SettingsStore::test(cx);
            cx.set_global(settings_store);
            cx.set_global(acp_thread::StubSessionCounter(AtomicUsize::new(0)));
            theme_settings::init(theme::LoadThemes::JustBase, cx);
            editor::init(cx);
            release_channel::init("0.0.0".parse().expect("valid test release version"), cx);
            agent::ThreadStore::init_global(cx);
            agent_ui::thread_metadata_store::ThreadMetadataStore::init_global(cx);
            LanguageModelRegistry::test(cx);
        });
    }

    fn model_info(provider: &str, model: &str, name: &str) -> AgentModelInfo {
        AgentModelInfo {
            id: acp::ModelId::new(format!("{provider}/{model}")),
            name: SharedString::from(name),
            description: Some(SharedString::from(provider)),
            icon: None,
            is_latest: false,
            cost: None,
        }
    }

    fn unprefixed_model_info(model: &str, name: &str) -> AgentModelInfo {
        AgentModelInfo {
            id: acp::ModelId::new(model.to_string()),
            name: SharedString::from(name),
            description: None,
            icon: None,
            is_latest: false,
            cost: None,
        }
    }

    #[test]
    fn curated_model_list_removes_duplicate_variants() {
        let models = AgentModelList::Grouped(IndexMap::from_iter([
            (
                acp_thread::AgentModelGroupName(SharedString::from("OpenAI")),
                vec![
                    model_info("openai", "o3", "o3"),
                    model_info("openai", "o3-2025-04-16", "o3"),
                    model_info("openai", "o3-pro", "o3 Pro"),
                    model_info("openai", "o3-mini", "o3 Mini"),
                    model_info("openai", "gpt-4o", "GPT-4o"),
                    model_info("openai", "gpt-4o-mini", "GPT-4o mini"),
                ],
            ),
            (
                acp_thread::AgentModelGroupName(SharedString::from("Google")),
                vec![
                    model_info("google", "gemini-2.5-flash", "Gemini 2.5 Flash"),
                    model_info("google", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
                ],
            ),
        ]));

        let AgentModelList::Grouped(groups) = curated_or_live_model_list(models) else {
            panic!("curated list should remain grouped");
        };
        let names = groups
            .values()
            .flatten()
            .map(|model| model.name.as_ref().to_string())
            .collect::<Vec<_>>();
        let ids = groups
            .values()
            .flatten()
            .map(|model| model.id.to_string())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["o3", "GPT-4o", "Gemini 2.5 Flash"]);
        assert_eq!(
            ids,
            vec!["openai/o3", "openai/gpt-4o", "google/gemini-2.5-flash"]
        );
    }

    #[test]
    fn curated_model_list_uses_provider_group_for_plain_model_ids() {
        let models = AgentModelList::Grouped(IndexMap::from_iter([
            (
                acp_thread::AgentModelGroupName(SharedString::from("OpenAI")),
                vec![
                    unprefixed_model_info("o3", "o3"),
                    unprefixed_model_info("o3-mini", "o3 Mini"),
                    unprefixed_model_info("gpt-4o", "GPT-4o"),
                    unprefixed_model_info("gpt-4o-mini", "GPT-4o mini"),
                ],
            ),
            (
                acp_thread::AgentModelGroupName(SharedString::from("Google")),
                vec![
                    unprefixed_model_info("gemini-2.5-flash", "Gemini 2.5 Flash"),
                    unprefixed_model_info("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
                ],
            ),
        ]));

        let AgentModelList::Grouped(groups) = curated_or_live_model_list(models) else {
            panic!("curated list should remain grouped");
        };
        let names = groups
            .values()
            .flatten()
            .map(|model| model.name.as_ref().to_string())
            .collect::<Vec<_>>();
        let ids = groups
            .values()
            .flatten()
            .map(|model| model.id.to_string())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["o3", "GPT-4o", "Gemini 2.5 Flash"]);
        assert_eq!(ids, vec!["o3", "gpt-4o", "gemini-2.5-flash"]);
    }

    #[test]
    fn extracts_loopback_preview_urls_from_assistant_text() {
        assert_eq!(
            BeginnerWorkspace::preview_url_from_text("You can play it at http://localhost:8000")
                .as_deref(),
            Some("http://localhost:8000")
        );
        assert_eq!(
            BeginnerWorkspace::preview_url_from_text("Preview: localhost:5173/game.").as_deref(),
            Some("http://localhost:5173/game")
        );
        assert_eq!(
            BeginnerWorkspace::preview_url_from_text(
                "Open [the preview](http://127.0.0.1:3000/index.html)."
            )
            .as_deref(),
            Some("http://127.0.0.1:3000/index.html")
        );
    }

    #[test]
    fn ignores_non_loopback_preview_urls() {
        assert_eq!(
            BeginnerWorkspace::preview_url_from_text("Published at https://example.com"),
            None
        );
        assert_eq!(
            BeginnerWorkspace::preview_url_from_text("Suspicious URL: http://localhost.evil.test"),
            None
        );
    }

    async fn setup_beginner_workspace(
        cx: &mut TestAppContext,
    ) -> (
        Entity<BeginnerWorkspace>,
        Entity<Workspace>,
        VisualTestContext,
    ) {
        init_test(cx);

        let fs = FakeFs::new(cx.executor());
        fs.insert_tree(
            "/project",
            json!({
                "src": {
                    "main.rs": "fn main() {}"
                }
            }),
        )
        .await;
        cx.update(|cx| <dyn fs::Fs>::set_global(fs.clone(), cx));

        let project = Project::test(fs, [], cx).await;
        let multi_workspace =
            cx.add_window(|window, cx| MultiWorkspace::test_new(project.clone(), window, cx));
        let workspace = multi_workspace
            .read_with(cx, |multi_workspace, _cx| {
                multi_workspace.workspace().clone()
            })
            .expect("test multi-workspace should have an active workspace");
        let multi_workspace_weak = multi_workspace
            .entity(cx)
            .expect("test multi-workspace window should have a root entity")
            .downgrade();
        let mut cx = VisualTestContext::from_window(multi_workspace.into(), cx);

        let beginner_workspace = workspace.update_in(&mut cx, |workspace, window, cx| {
            let workspace_weak = workspace.weak_handle();
            cx.new(|cx| BeginnerWorkspace::new(workspace_weak, multi_workspace_weak, window, cx))
        });

        (beginner_workspace, workspace, cx)
    }

    fn visible_worktree_paths(workspace: &Workspace, cx: &App) -> Vec<PathBuf> {
        workspace
            .project()
            .read(cx)
            .visible_worktrees(cx)
            .map(|worktree| worktree.read(cx).abs_path().to_path_buf())
            .collect()
    }

    #[gpui::test]
    async fn test_simple_open_folder_adds_code_editor_worktree(cx: &mut TestAppContext) {
        let (beginner_workspace, workspace, mut cx) = setup_beginner_workspace(cx).await;
        let folder = PathBuf::from("/project");

        beginner_workspace.update_in(&mut cx, |beginner_workspace, window, cx| {
            beginner_workspace.open_folder_as_worktree(folder.clone(), window, cx);
        });
        cx.run_until_parked();

        workspace.read_with(&cx, |workspace, cx| {
            assert_eq!(visible_worktree_paths(workspace, cx), vec![folder]);
        });
    }

    #[gpui::test]
    async fn test_simple_draft_uses_agent_panel_with_selected_folder(cx: &mut TestAppContext) {
        let (beginner_workspace, workspace, mut cx) = setup_beginner_workspace(cx).await;
        let folder = PathBuf::from("/project");

        beginner_workspace.update_in(&mut cx, |beginner_workspace, window, cx| {
            beginner_workspace.selected_folder = Some(folder.clone());
            assert!(
                beginner_workspace
                    .create_simple_agent_draft(window, cx)
                    .is_some()
            );
        });
        cx.run_until_parked();

        let Some(agent_panel) =
            workspace.read_with(&cx, |workspace, cx| workspace.panel::<AgentPanel>(cx))
        else {
            panic!("simple draft should attach an AgentPanel");
        };

        beginner_workspace.read_with(&cx, |beginner_workspace, cx| {
            assert_eq!(
                beginner_workspace.active_conversation_thread_id(cx),
                agent_panel
                    .read(cx)
                    .active_backboard_workspace_draft_thread_id(cx)
            );
        });

        agent_panel.read_with(&cx, |agent_panel, cx| {
            let Some(thread) = agent_panel.active_agent_thread(cx) else {
                panic!("simple draft should create an active agent thread");
            };
            let Some(work_dirs) = thread.read(cx).work_dirs() else {
                panic!("simple draft should pass selected folder work dirs");
            };
            let paths = work_dirs.ordered_paths().cloned().collect::<Vec<_>>();
            assert_eq!(paths, vec![Path::new("/project").to_path_buf()]);
        });
    }
}

fn model_list_contains_id(model_list: &AgentModelList, model_id: &acp::ModelId) -> bool {
    match model_list {
        AgentModelList::Flat(models) => models.iter().any(|model| model.id == *model_id),
        AgentModelList::Grouped(groups) => groups
            .values()
            .any(|models| models.iter().any(|model| model.id == *model_id)),
    }
}

fn first_model_in_list(model_list: &AgentModelList) -> Option<AgentModelInfo> {
    match model_list {
        AgentModelList::Flat(models) => models.first().cloned(),
        AgentModelList::Grouped(groups) => {
            groups.values().find_map(|models| models.first()).cloned()
        }
    }
}

fn fallback_model_for_unsupported_simple_selection(
    model_list: &AgentModelList,
    selected_model: Option<&AgentModelInfo>,
) -> Option<AgentModelInfo> {
    if let Some(selected_model) = selected_model
        && model_list_contains_id(model_list, &selected_model.id)
    {
        return None;
    }

    first_model_in_list(model_list)
}

fn ensure_selected_simple_model_is_supported(
    selector: Rc<dyn AgentModelSelector>,
    cx: &mut App,
) -> Task<Result<()>> {
    let selected_model_task = selector.selected_model(cx);
    let model_list_task = selector.list_models(cx);
    cx.spawn(async move |cx| {
        let selected_model = selected_model_task.await.ok();
        let model_list = curated_or_live_model_list(model_list_task.await?);

        let Some(fallback_model) =
            fallback_model_for_unsupported_simple_selection(&model_list, selected_model.as_ref())
        else {
            return Ok(());
        };

        let previous_model = selected_model
            .as_ref()
            .map(|model| model.id.to_string())
            .unwrap_or_else(|| "none".to_string());
        log::warn!(
            "Simple mode selected model is not in the live model list; switching model previous_model={} replacement_model={}",
            previous_model,
            fallback_model.id
        );

        cx.update(|cx| selector.select_model(fallback_model.id, cx))
            .await?;
        Ok(())
    })
}

fn folder_display_name(folder: &Path) -> SharedString {
    folder
        .file_name()
        .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| SharedString::from(folder.to_string_lossy().into_owned()))
}

fn folder_parent_display_name(folder: &Path) -> Option<SharedString> {
    folder
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
}

fn folder_matches_search(folder: &Path, search_query: &str) -> bool {
    if search_query.is_empty() {
        return true;
    }

    let folder_name = folder_display_name(folder).to_lowercase();
    let parent_name = folder_parent_display_name(folder)
        .map(|name| name.to_lowercase())
        .unwrap_or_default();
    folder_name.contains(search_query)
        || parent_name.contains(search_query)
        || folder
            .to_string_lossy()
            .to_lowercase()
            .contains(search_query)
}

#[derive(Clone, Default)]
struct ComposerGitState {
    is_loading: bool,
    is_git_repository: bool,
    current_branch: Option<SharedString>,
    branches: Vec<SharedString>,
}

/// Wraps an inner `AgentModelSelector` and curates the live Backboard model list.
/// Model selection and all mutations pass through to the inner selector unchanged.
struct CuratedModelSelector {
    inner: Rc<dyn AgentModelSelector>,
}

impl AgentModelSelector for CuratedModelSelector {
    fn list_models(&self, cx: &mut App) -> gpui::Task<anyhow::Result<AgentModelList>> {
        let inner = self.inner.clone();
        cx.spawn(async move |cx| {
            let models = cx.update(|cx| inner.list_models(cx)).await?;
            Ok(curated_or_live_model_list(models))
        })
    }

    fn select_model(&self, model_id: acp::ModelId, cx: &mut App) -> gpui::Task<anyhow::Result<()>> {
        self.inner.select_model(model_id, cx)
    }

    fn selected_model(
        &self,
        cx: &mut App,
    ) -> gpui::Task<anyhow::Result<acp_thread::AgentModelInfo>> {
        // Also apply the curated display name to the selected model so the button label matches.
        let inner = self.inner.clone();
        cx.spawn(async move |cx| {
            let mut info = cx.update(|cx| inner.selected_model(cx)).await?;
            if let Some((_, name)) = curated_model_match(&info) {
                info.name = SharedString::from(name);
            }
            Ok(info)
        })
    }

    fn watch(&self, cx: &mut App) -> Option<watch::Receiver<()>> {
        self.inner.watch(cx)
    }

    fn should_render_footer(&self) -> bool {
        false
    }
}

const BEGINNER_CHATS_KVP_KEY: &str = "beginner_chats_v1";
const BEGINNER_OPEN_TABS_KVP_KEY: &str = "beginner_open_tabs_v1";
const SIMPLE_COMPOSER_MIN_LINES: usize = 3;
const SIMPLE_COMPOSER_MAX_LINES: usize = 12;
const REMOTE_PROJECT_THREAD_SCAN_LIMIT: usize = 25;
static SIMPLE_MODE_OPENED_THIS_PROCESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
struct DraggedSimpleSidebarResize;

#[derive(Debug, Clone)]
struct DraggedSimplePanelResize;

/// A saved simple-mode conversation entry shown on the home page.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BeginnerChatRecord {
    id: String,
    name: String,
    folder_path: String,
    #[serde(default)]
    session_id: Option<String>,
    timestamp_ms: i64,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct BeginnerOpenTabsState {
    #[serde(default)]
    active_record_id: Option<String>,
    #[serde(default)]
    background_record_ids: Vec<String>,
}

impl BeginnerChatRecord {
    fn new(name: String, folder: &PathBuf) -> Self {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            folder_path: folder.to_string_lossy().into_owned(),
            session_id: None,
            timestamp_ms,
        }
    }

    fn folder(&self) -> PathBuf {
        PathBuf::from(&self.folder_path)
    }

    fn display_name(&self) -> SharedString {
        let name = self.name.trim();
        if name.is_empty() || name.chars().all(|ch| ch == '.') {
            SharedString::from("Untitled chat")
        } else {
            SharedString::from(name)
        }
    }
}

fn project_history_terms(text: &str) -> HashSet<String> {
    let mut terms = HashSet::new();
    let mut current = String::new();

    for character in text.chars() {
        if character.is_alphanumeric() {
            current.extend(character.to_lowercase());
            continue;
        }

        if !current.is_empty() {
            if !PROJECT_HISTORY_STOP_WORDS.contains(&current.as_str()) {
                terms.insert(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }

    if !current.is_empty() && !PROJECT_HISTORY_STOP_WORDS.contains(&current.as_str()) {
        terms.insert(current);
    }

    terms
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectMatchConfidence {
    Medium,
    High,
}

impl ProjectMatchConfidence {
    fn as_str(self) -> &'static str {
        match self {
            ProjectMatchConfidence::Medium => "medium",
            ProjectMatchConfidence::High => "high",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ProjectMatchScore {
    score: f32,
    shared_terms: usize,
    prompt_terms: usize,
    record_terms: usize,
    confidence: ProjectMatchConfidence,
}

fn score_project_history_match(
    prompt_terms: &HashSet<String>,
    record_terms: &HashSet<String>,
) -> Option<ProjectMatchScore> {
    if prompt_terms.len() < 2 || record_terms.is_empty() {
        return None;
    }

    let shared_terms = prompt_terms.intersection(record_terms).count();
    if shared_terms < 2 {
        return None;
    }

    let smaller_set_coverage =
        shared_terms as f32 / prompt_terms.len().min(record_terms.len()) as f32;
    let prompt_coverage = shared_terms as f32 / prompt_terms.len() as f32;
    let score = smaller_set_coverage.mul_add(0.7, prompt_coverage * 0.3);
    let confidence = if score >= 0.78 && shared_terms >= 3 {
        ProjectMatchConfidence::High
    } else if score >= 0.62 {
        ProjectMatchConfidence::Medium
    } else {
        return None;
    };

    Some(ProjectMatchScore {
        score,
        shared_terms,
        prompt_terms: prompt_terms.len(),
        record_terms: record_terms.len(),
        confidence,
    })
}

fn scored_similar_prior_project_match<'a>(
    records: &'a [BeginnerChatRecord],
    prompt: &str,
    folder: &Path,
) -> Option<(&'a BeginnerChatRecord, ProjectMatchScore)> {
    let prompt_terms = project_history_terms(prompt);

    records
        .iter()
        .filter(|record| record.folder() != folder)
        .filter_map(|record| {
            let record_terms = project_history_terms(&record.name);
            score_project_history_match(&prompt_terms, &record_terms).map(|score| (record, score))
        })
        .max_by(|(record_a, score_a), (record_b, score_b)| {
            score_a
                .score
                .total_cmp(&score_b.score)
                .then_with(|| record_a.timestamp_ms.cmp(&record_b.timestamp_ms))
        })
}

fn similar_prior_project_match<'a>(
    records: &'a [BeginnerChatRecord],
    prompt: &str,
    folder: &Path,
) -> Option<&'a BeginnerChatRecord> {
    scored_similar_prior_project_match(records, prompt, folder).map(|(record, _)| record)
}

fn prompt_explicitly_requests_another_copy(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    [
        "again",
        "recreate",
        "redo",
        "from scratch",
        "another copy",
        "new copy",
        "separate copy",
        "build another",
        "make another",
    ]
    .iter()
    .any(|phrase| prompt.contains(phrase))
}

#[derive(Clone)]
struct RemoteProjectRecord {
    thread_id: String,
    title: String,
    workspace_path: Option<PathBuf>,
    updated_at: Option<String>,
    search_text: String,
}

fn remote_project_records_from_threads(threads: &[Value]) -> Vec<RemoteProjectRecord> {
    threads
        .iter()
        .filter_map(remote_project_record_from_thread)
        .collect()
}

fn remote_project_record_from_thread(thread: &Value) -> Option<RemoteProjectRecord> {
    let thread_id = json_string(thread, &["thread_id", "id", "uuid"])?;
    let title = json_string(thread, &["title", "name", "display_title"])
        .or_else(|| nested_json_string(thread, &[&["metadata", "title"], &["thread", "title"]]));

    let workspace_path = json_string(
        thread,
        &["workspace", "workspace_path", "folder_path", "project_path"],
    )
    .or_else(|| {
        nested_json_string(
            thread,
            &[
                &["metadata", "workspace"],
                &["metadata", "workspace_path"],
                &["thread", "workspace"],
            ],
        )
    })
    .map(PathBuf::from);

    let mut search_parts = Vec::new();
    if let Some(title) = title.as_deref() {
        search_parts.push(title.to_string());
    }
    for value in [
        json_string(
            thread,
            &["summary", "description", "last_message", "lastMessage"],
        ),
        nested_json_string(
            thread,
            &[
                &["metadata", "summary"],
                &["metadata", "description"],
                &["thread", "summary"],
                &["thread", "description"],
            ],
        ),
        remote_thread_context(thread),
    ]
    .into_iter()
    .flatten()
    {
        search_parts.push(value);
    }

    let search_text = search_parts.join("\n\n");
    if project_history_terms(&search_text).len() < 2 {
        return None;
    }

    let title = title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty() && *title != "Backboard")
        .unwrap_or("Remembered Backboard project")
        .to_string();

    Some(RemoteProjectRecord {
        thread_id,
        title,
        workspace_path,
        updated_at: json_string(
            thread,
            &["updated_at", "updatedAt", "created_at", "createdAt"],
        ),
        search_text,
    })
}

fn scored_similar_remote_project_match<'a>(
    records: &'a [RemoteProjectRecord],
    prompt: &str,
) -> Option<(&'a RemoteProjectRecord, ProjectMatchScore)> {
    let prompt_terms = project_history_terms(prompt);

    records
        .iter()
        .filter_map(|record| {
            let record_terms = project_history_terms(&record.search_text);
            score_project_history_match(&prompt_terms, &record_terms).map(|score| (record, score))
        })
        .max_by(|(record_a, score_a), (record_b, score_b)| {
            score_a
                .score
                .total_cmp(&score_b.score)
                .then_with(|| record_a.updated_at.cmp(&record_b.updated_at))
        })
}

fn similar_remote_project_match<'a>(
    records: &'a [RemoteProjectRecord],
    prompt: &str,
) -> Option<&'a RemoteProjectRecord> {
    scored_similar_remote_project_match(records, prompt).map(|(record, _)| record)
}

async fn load_remote_project_records(
    client: backboard::BackboardClient,
    prompt: &str,
) -> Result<Vec<RemoteProjectRecord>> {
    let threads = client.list_threads(None).await?;
    let mut records = remote_project_records_from_threads(&threads);
    if similar_remote_project_match(&records, prompt).is_some() {
        return Ok(records);
    }

    for thread in threads.iter().take(REMOTE_PROJECT_THREAD_SCAN_LIMIT) {
        let Some(thread_id) = json_string(thread, &["thread_id", "id", "uuid"]) else {
            continue;
        };
        let detailed_thread = match client.get_thread(&thread_id).await {
            Ok(thread) => thread,
            Err(error) => {
                log::debug!(
                    "Simple mode remote project detail lookup failed: thread_id={} error={error:#}",
                    thread_id
                );
                continue;
            }
        };
        let Some(record) = remote_project_record_from_thread(&detailed_thread) else {
            continue;
        };
        if let Some(existing) = records
            .iter_mut()
            .find(|existing| existing.thread_id == record.thread_id)
        {
            *existing = record;
        } else {
            records.push(record);
        }
    }

    Ok(records)
}

fn json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn nested_json_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        let mut current = value;
        for key in *path {
            current = current.get(*key)?;
        }
        current
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn remote_thread_context(thread: &Value) -> Option<String> {
    let messages = thread
        .get("messages")
        .or_else(|| {
            thread
                .get("thread")
                .and_then(|thread| thread.get("messages"))
        })?
        .as_array()?;
    let mut context = String::new();
    for message in messages.iter().rev().take(12).rev() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("message");
        let Some(content) = remote_message_content(message) else {
            continue;
        };
        let content = strip_backboard_ide_context(&content);
        if content.trim().is_empty() {
            continue;
        }
        context.push_str(role);
        context.push_str(": ");
        context.push_str(content.trim());
        context.push_str("\n\n");
        if context.len() > 12_000 {
            context.truncate(12_000);
            context.push_str("\n[truncated]");
            break;
        }
    }
    (!context.trim().is_empty()).then_some(context)
}

fn remote_message_content(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(content) = content.as_str() {
        return Some(content.to_string());
    }

    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
                .or_else(|| {
                    part.get("text")
                        .and_then(|text| text.get("value"))
                        .and_then(Value::as_str)
                })
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

fn strip_backboard_ide_context(text: &str) -> String {
    text.split("<backboard_ide_context>")
        .next()
        .unwrap_or(text)
        .trim_end()
        .to_string()
}

fn remote_build_on_top_message(
    record: &RemoteProjectRecord,
    prior_context: Option<&str>,
    prompt: &str,
) -> String {
    let mut message = format!(
        "Build on top of the previously remembered Backboard project \"{}\".\n\
         Previous remote thread id: {}\n",
        record.title, record.thread_id
    );
    if let Some(workspace_path) = record.workspace_path.as_ref() {
        message.push_str(&format!(
            "Previous workspace path when known: {}\n",
            workspace_path.display()
        ));
    }
    if let Some(updated_at) = record.updated_at.as_deref() {
        message.push_str(&format!("Previous project updated at: {updated_at}\n"));
    }
    if let Some(prior_context) = prior_context.filter(|context| !context.trim().is_empty()) {
        message.push_str("\nPrevious project conversation context:\n");
        message.push_str(prior_context.trim());
        message.push_str("\n");
    }
    message.push_str(
        "\nUser's new request:\n\
         ",
    );
    message.push_str(prompt);
    message.push_str(
        "\n\nIf the previous project files are not present in the active workspace, recreate the needed base from the remembered context before applying the new request.",
    );
    message
}

pub enum BeginnerWorkspaceEvent {
    SwitchToEditor,
}

impl EventEmitter<BeginnerWorkspaceEvent> for BeginnerWorkspace {}

enum BeginnerState {
    Landing,
    ActiveProject,
}

#[derive(Clone, Copy, PartialEq)]
enum LeftTab {
    Files,
}

enum RightPanel {
    Preview,
    CodeDiff {
        selected_path: Option<SharedString>,
    },
    CodeView {
        path: PathBuf,
        title: SharedString,
        editor: Entity<Editor>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SimplePanelDock {
    Left,
    Right,
    Top,
    Bottom,
}

impl SimplePanelDock {
    fn is_side(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

#[derive(Clone)]
struct CodeDiffFile {
    path: SharedString,
    old_path: Option<SharedString>,
    status: CodeDiffFileStatus,
    additions: usize,
    deletions: usize,
    content: Option<SharedString>,
}

#[derive(Default)]
struct CodeDiffState {
    folder: Option<PathBuf>,
    files: Vec<CodeDiffFile>,
    loading_files: bool,
    loading_content_path: Option<SharedString>,
    error: Option<SharedString>,
    generation: u64,
    content_generation: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodeDiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Binary,
}

impl CodeDiffFileStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Added => "Added",
            Self::Modified => "Modified",
            Self::Deleted => "Deleted",
            Self::Renamed => "Renamed",
            Self::Binary => "Binary",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Added => IconName::Plus,
            Self::Modified => IconName::Pencil,
            Self::Deleted => IconName::Trash,
            Self::Renamed => IconName::FileCode,
            Self::Binary => IconName::File,
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Added => Color::Created,
            Self::Modified => Color::Modified,
            Self::Deleted => Color::Deleted,
            Self::Renamed => Color::Modified,
            Self::Binary => Color::Muted,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArtifactIllustrationState {
    Empty,
    Working,
    Error,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RightPanelMode {
    Artifact,
    Launcher,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RightPanelOption {
    Files,
    Design,
    Code,
    Terminal,
}

impl RightPanelOption {
    const ALL: [Self; 3] = [Self::Files, Self::Design, Self::Code];

    fn label(self) -> &'static str {
        match self {
            Self::Files => "Files",
            Self::Design => "Browser",
            Self::Code => "Review",
            Self::Terminal => "Terminal",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Files => IconName::FileTree,
            Self::Design => IconName::Public,
            Self::Code => IconName::Code,
            Self::Terminal => IconName::Terminal,
        }
    }

    fn element_id(self) -> &'static str {
        match self {
            Self::Files => "right-panel-tab-files",
            Self::Design => "right-panel-tab-preview",
            Self::Code => "right-panel-tab-code",
            Self::Terminal => "right-panel-tab-terminal",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChatMode {
    Ask,
    Build,
}

impl ChatMode {
    fn label(self) -> &'static str {
        match self {
            ChatMode::Ask => "Ask",
            ChatMode::Build => "Build",
        }
    }

    fn placeholder(self) -> &'static str {
        "Ask Backboard..."
    }

    fn follow_up_placeholder(self) -> &'static str {
        "Ask Backboard..."
    }

    fn prompt_prefix(self) -> &'static str {
        match self {
            ChatMode::Ask => {
                concat!(
                    "Ask mode: answer without editing files or making project changes unless I explicitly ask you to switch to build mode.\n",
                    "Ask focused clarifying questions when the request is underspecified, especially when the answer depends on project goals, audience, constraints, or user intent."
                )
            }
            ChatMode::Build => {
                concat!(
                    "Simple build mode: build or edit the project for a nontechnical user.\n",
                    "- Default to creating a polished web app or page when the user asks for a product, app, page, dashboard, tool, game, or visual experience and does not specify another medium.\n",
                    "- Do not force a web app when the user explicitly asks for another artifact, such as docs, scripts, data work, configuration, terminal help, or repository cleanup.\n",
                    "- Ask focused clarifying questions before building when core product, audience, content, brand, data, platform, or style choices are missing. Prefer 1-3 short questions at a time, and state sensible defaults when proceeding would be better than waiting.\n",
                    "- Keep visible chat replies short, natural, and outcome-focused. Do not show code, filenames, commands, raw logs, markdown-heavy checklists, or implementation details unless the user asks.\n",
                    "- When the work is done, reply like a chat message in 1-2 sentences. Avoid Features or Controls reports; mention the result and how to try it.\n",
                    "- Do not narrate implementation mechanics in chat. Avoid phrases like updating files, creating HTML/CSS/JavaScript files, editing components, running commands, or changing specific filenames. Say what user-facing experience is being built instead.\n",
                    "- Summarize edits as product changes. Let the UI expose file counts and read-only diffs separately, such as Backboard changed 3 files.\n",
                    "- Treat code and diffs as read-only review surfaces for the user.\n",
                    "- After creating or updating a runnable artifact, start or refresh the preview."
                )
            }
        }
    }

    fn agent_workspace_mode(self) -> BackboardAgentWorkspaceMode {
        match self {
            ChatMode::Ask => BackboardAgentWorkspaceMode::Ask,
            ChatMode::Build => BackboardAgentWorkspaceMode::Free,
        }
    }

    fn prepare_message(self, text: String) -> String {
        text
    }
}

struct ProjectSession {
    chat_record_id: Option<String>,
    state: BeginnerState,
    tab_name: SharedString,
    chat_mode: ChatMode,
    chat_feed_display_mode: ChatFeedDisplayMode,
    chat_editor: Entity<Editor>,
    browser_address_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    pending_conversation_view: Option<Entity<ConversationView>>,
    active_conversation_view: Option<Entity<ConversationView>>,
    queued_composer_submit: Option<String>,
    model_selector: Option<Entity<ModelSelectorPopover>>,
    is_agent_running: bool,
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    raw_browse_path: Option<PathBuf>,
    right_panel: RightPanel,
    code_diff_state: CodeDiffState,
    right_panel_open: bool,
    right_panel_closing: bool,
    right_panel_expanded: bool,
    right_panel_animation_generation: u64,
    right_panel_mode: RightPanelMode,
    right_panel_option: RightPanelOption,
    right_panel_tabs: Vec<RightPanelOption>,
    active_right_panel_tab: Option<RightPanelOption>,
    right_panel_dock: SimplePanelDock,
    right_panel_height: Pixels,
    bottom_panel_open: bool,
    bottom_panel_closing: bool,
    bottom_panel_animation_generation: u64,
    share_dialog_open: bool,
    preview_url: Option<String>,
    preview_visible: bool,
    is_preview_generating: bool,
    terminal_view: Option<Entity<TerminalView>>,
    terminal_working_directory: Option<PathBuf>,
    right_terminal_view: Option<Entity<TerminalView>>,
    right_terminal_working_directory: Option<PathBuf>,
    // Fixed local preview port used by the active simple-mode preview.
    dev_server_port: Option<u16>,
    #[allow(dead_code)]
    web_preview: Option<crate::web_preview::WebPreview>,
    dev_server_task: Option<Task<()>>,
    subscriptions: Vec<Subscription>,
}

enum SimilarProjectConfirmationAction {
    InitialSubmit {
        prompt: String,
        agent_text: String,
        folder: PathBuf,
    },
    ThreadComposer {
        prompt: String,
    },
}

impl SimilarProjectConfirmationAction {
    fn prompt_text(&self) -> String {
        match self {
            SimilarProjectConfirmationAction::InitialSubmit { prompt, .. }
            | SimilarProjectConfirmationAction::ThreadComposer { prompt } => prompt.clone(),
        }
    }
}

struct SimilarProjectConfirmation {
    source: SimilarProjectConfirmationSource,
    prior_project_name: SharedString,
    prior_project_location: Option<PathBuf>,
    target_folder: PathBuf,
    match_score: ProjectMatchScore,
    action: SimilarProjectConfirmationAction,
}

enum SimilarProjectConfirmationSource {
    Local(BeginnerChatRecord),
    Remote(RemoteProjectRecord),
}

impl SimilarProjectConfirmationSource {
    fn kind(&self) -> &'static str {
        match self {
            SimilarProjectConfirmationSource::Local(_) => "local",
            SimilarProjectConfirmationSource::Remote(_) => "remote",
        }
    }

    fn id(&self) -> &str {
        match self {
            SimilarProjectConfirmationSource::Local(record) => &record.id,
            SimilarProjectConfirmationSource::Remote(record) => &record.thread_id,
        }
    }
}

struct SidebarProjectGroup {
    folder_path: PathBuf,
    records: Vec<BeginnerChatRecord>,
}

impl SidebarProjectGroup {
    fn new(folder_path: PathBuf) -> Self {
        Self {
            folder_path,
            records: Vec::new(),
        }
    }

    fn add_record(&mut self, record: BeginnerChatRecord) {
        self.records.push(record);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SimpleModeTarget {
    Simple,
    CodeEditor,
    Agents,
}

pub struct BeginnerWorkspace {
    workspace: WeakEntity<Workspace>,
    multi_workspace: WeakEntity<MultiWorkspace>,
    project: Entity<Project>,
    focus_handle: FocusHandle,
    state: BeginnerState,
    active_chat_record_id: Option<String>,
    // Human-readable tab name generated from the initial prompt.
    tab_name: SharedString,
    chat_mode: ChatMode,
    chat_feed_display_mode: ChatFeedDisplayMode,
    chat_editor: Entity<Editor>,
    chat_search_editor: Entity<Editor>,
    browser_address_editor: Entity<Editor>,
    selected_folder: Option<PathBuf>,
    composer_git_state: ComposerGitState,
    composer_git_state_folder: Option<PathBuf>,
    thread: Option<Entity<AcpThread>>,
    // Kept alive for the entire session lifetime. The ConversationView owns the
    // ThreadView which owns the send task — dropping it cancels in-flight sends.
    // "pending" while connecting; remains alive after connected to keep ThreadView alive.
    pending_conversation_view: Option<Entity<ConversationView>>,
    // Kept alive after connection so that ThreadView (and its send tasks) are not dropped.
    active_conversation_view: Option<Entity<ConversationView>>,
    queued_composer_submit: Option<String>,
    // Model selector extracted from the ThreadView once connected.
    model_selector: Option<Entity<ModelSelectorPopover>>,
    is_agent_running: bool,
    // Set when agent finishes so approve/revert actions are shown.
    agent_finished: bool,
    chat_feed: Option<Entity<BeginnerChatFeed>>,
    file_changes_panel: Option<Entity<FileChangesPanel>>,
    left_tab: LeftTab,
    show_raw_files: bool,
    raw_browse_path: Option<PathBuf>,
    right_panel: RightPanel,
    code_diff_state: CodeDiffState,
    right_panel_open: bool,
    right_panel_closing: bool,
    right_panel_expanded: bool,
    right_panel_animation_generation: u64,
    right_panel_mode: RightPanelMode,
    right_panel_option: RightPanelOption,
    right_panel_tabs: Vec<RightPanelOption>,
    active_right_panel_tab: Option<RightPanelOption>,
    right_panel_dock: SimplePanelDock,
    right_panel_height: Pixels,
    chat_panel_width: Pixels,
    bottom_panel_open: bool,
    bottom_panel_closing: bool,
    bottom_panel_animation_generation: u64,
    share_dialog_open: bool,
    // URL of the running dev server once it's ready.
    preview_url: Option<String>,
    preview_visible: bool,
    is_preview_generating: bool,
    terminal_view: Option<Entity<TerminalView>>,
    terminal_working_directory: Option<PathBuf>,
    right_terminal_view: Option<Entity<TerminalView>>,
    right_terminal_working_directory: Option<PathBuf>,
    // Fixed local preview port used by the active simple-mode preview.
    dev_server_port: Option<u16>,
    // Polling task for start_dev_server; stored per-session so it cancels on stash/switch.
    dev_server_task: Option<Task<()>>,
    // Embedded web preview. Created lazily in render() once we have both a
    // preview_url and the Window handle. None on Linux (unsupported).
    web_preview: Option<crate::web_preview::WebPreview>,
    chats_sidebar_open: bool,
    chats_sidebar_closing: bool,
    chats_sidebar_animation_generation: u64,
    chats_sidebar_width: Pixels,
    pending_chats_sidebar_hover_open: Option<Task<()>>,
    background_sessions: Vec<ProjectSession>,
    chat_history: Vec<BeginnerChatRecord>,
    pending_similar_project_confirmation: Option<SimilarProjectConfirmation>,
    pending_open_tabs: Option<BeginnerOpenTabsState>,
    open_tabs_loaded: bool,
    open_tabs_restored: bool,
    files_sidebar_collapsed: bool,
    _tasks: Vec<Task<()>>,
    _project_subscription: Subscription,
    _search_subscription: Subscription,
    session_subscriptions: Vec<Subscription>,
}

impl BeginnerWorkspace {
    fn handle_enter_submit(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_follow_up(window, cx);
    }

    fn has_backboard_api_key() -> bool {
        backboard::BackboardConfig::load_or_default()
            .api_key()
            .is_some()
    }

    fn open_api_key_settings(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
    }

    fn make_chat_editor(
        window: &mut Window,
        cx: &mut Context<Self>,
        placeholder: &str,
    ) -> (Entity<Editor>, Subscription) {
        let workspace = cx.entity().downgrade();
        let editor = cx.new(|cx| {
            let mut editor = Editor::auto_height(3, 10, window, cx);
            editor.set_placeholder_text(placeholder, window, cx);
            editor.set_soft_wrap();
            editor
        });
        let subscription = editor.update(cx, |editor, _cx| {
            let workspace = workspace.clone();
            editor.register_action(move |_: &Newline, window, cx| {
                workspace
                    .update(cx, |this, cx| {
                        this.submit_follow_up(window, cx);
                    })
                    .ok();
            })
        });
        (editor, subscription)
    }

    fn make_search_editor(window: &mut Window, cx: &mut Context<Self>) -> Entity<Editor> {
        cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            let mut text_style = Self::simple_mode_editor_text_style(cx);
            text_style.color = Some(ds::sidebar_emphasis_text(cx));
            text_style.font_size = Some(rems_from_px(14.).into());
            text_style.font_weight = Some(FontWeight::MEDIUM);
            editor.set_text_style_refinement(text_style);
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor
        })
    }

    fn make_browser_address_editor(
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<Editor>, Subscription) {
        let workspace = cx.entity().downgrade();
        let editor = cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            editor.set_placeholder_text("Enter a URL", window, cx);
            let mut text_style = Self::simple_mode_editor_text_style(cx);
            text_style.color = Some(ds::text_muted(cx));
            editor.set_text_style_refinement(text_style);
            editor.set_show_gutter(false, cx);
            editor.set_show_wrap_guides(false, cx);
            editor.set_show_indent_guides(false, cx);
            editor
        });
        let address_editor = editor.clone();
        let subscription = editor.update(cx, |editor, _cx| {
            let workspace = workspace.clone();
            let address_editor = address_editor.clone();
            editor.register_action(move |_: &Newline, window, cx| {
                let url_text = address_editor.read(cx).text(cx);
                workspace
                    .update(cx, |this, cx| {
                        this.navigate_browser_to_input(url_text, window, cx);
                    })
                    .log_err();
            })
        });
        (editor, subscription)
    }

    fn simple_mode_editor_text_style(cx: &mut App) -> TextStyleRefinement {
        let settings = ThemeSettings::get_global(cx);
        TextStyleRefinement {
            font_family: Some(settings.ui_font.family.clone()),
            font_features: Some(settings.ui_font.features.clone()),
            font_fallbacks: settings.ui_font.fallbacks.clone(),
            font_size: Some(settings.ui_font_size(cx).into()),
            font_weight: Some(settings.ui_font.weight),
            ..Default::default()
        }
    }

    fn make_file_preview_editor(
        path: PathBuf,
        content: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<Editor> {
        let editor = cx.new(|cx| {
            let mut editor = Editor::multi_line(window, cx);
            editor.set_text(content, window, cx);
            editor
        });
        cx.subscribe(&editor, move |_, editor, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Edited { .. }) {
                let text = editor.read(cx).text(cx);
                std::fs::write(&path, text)
                    .with_context(|| format!("failed to write {}", path.display()))
                    .log_err();
            }
        })
        .detach();
        editor
    }

    fn current_tab_title(&self) -> SharedString {
        match &self.state {
            BeginnerState::ActiveProject => self.tab_name.clone(),
            BeginnerState::Landing => SharedString::from("Simple Page Builder"),
        }
    }

    fn stash_current_session_and_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, BeginnerState::Landing) {
            self.new_project(window, cx);
            return;
        }

        self.pending_similar_project_confirmation = None;
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();

        let (replacement_editor, enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let (replacement_browser_address_editor, browser_enter_sub) =
            Self::make_browser_address_editor(window, cx);
        let session = ProjectSession {
            chat_record_id: self.active_chat_record_id.take(),
            state: std::mem::replace(&mut self.state, BeginnerState::Landing),
            tab_name: std::mem::replace(&mut self.tab_name, SharedString::from("Home")),
            chat_mode: std::mem::replace(&mut self.chat_mode, ChatMode::Build),
            chat_feed_display_mode: std::mem::replace(
                &mut self.chat_feed_display_mode,
                ChatFeedDisplayMode::LiveWork,
            ),
            chat_editor: std::mem::replace(&mut self.chat_editor, replacement_editor),
            browser_address_editor: std::mem::replace(
                &mut self.browser_address_editor,
                replacement_browser_address_editor,
            ),
            selected_folder: self.selected_folder.take(),
            thread: self.thread.take(),
            pending_conversation_view: self.pending_conversation_view.take(),
            active_conversation_view: self.active_conversation_view.take(),
            queued_composer_submit: self.queued_composer_submit.take(),
            model_selector: self.model_selector.take(),
            is_agent_running: std::mem::replace(&mut self.is_agent_running, false),
            agent_finished: std::mem::replace(&mut self.agent_finished, false),
            chat_feed: self.chat_feed.take(),
            file_changes_panel: self.file_changes_panel.take(),
            left_tab: std::mem::replace(&mut self.left_tab, LeftTab::Files),
            show_raw_files: std::mem::replace(&mut self.show_raw_files, false),
            raw_browse_path: self.raw_browse_path.take(),
            right_panel: std::mem::replace(&mut self.right_panel, RightPanel::Preview),
            code_diff_state: std::mem::take(&mut self.code_diff_state),
            right_panel_open: std::mem::replace(&mut self.right_panel_open, false),
            right_panel_closing: std::mem::replace(&mut self.right_panel_closing, false),
            right_panel_expanded: std::mem::replace(&mut self.right_panel_expanded, false),
            right_panel_animation_generation: std::mem::replace(
                &mut self.right_panel_animation_generation,
                0,
            ),
            right_panel_mode: std::mem::replace(
                &mut self.right_panel_mode,
                RightPanelMode::Artifact,
            ),
            right_panel_option: std::mem::replace(
                &mut self.right_panel_option,
                RightPanelOption::Files,
            ),
            right_panel_tabs: std::mem::take(&mut self.right_panel_tabs),
            active_right_panel_tab: self.active_right_panel_tab.take(),
            right_panel_dock: std::mem::replace(&mut self.right_panel_dock, SimplePanelDock::Right),
            right_panel_height: std::mem::replace(
                &mut self.right_panel_height,
                px(DOCKED_PANEL_DEFAULT_HEIGHT_PX),
            ),
            bottom_panel_open: std::mem::replace(&mut self.bottom_panel_open, false),
            bottom_panel_closing: std::mem::replace(&mut self.bottom_panel_closing, false),
            bottom_panel_animation_generation: std::mem::replace(
                &mut self.bottom_panel_animation_generation,
                0,
            ),
            share_dialog_open: std::mem::replace(&mut self.share_dialog_open, false),
            preview_url: self.preview_url.take(),
            preview_visible: std::mem::replace(&mut self.preview_visible, false),
            is_preview_generating: std::mem::replace(&mut self.is_preview_generating, false),
            terminal_view: self.terminal_view.take(),
            terminal_working_directory: self.terminal_working_directory.take(),
            right_terminal_view: self.right_terminal_view.take(),
            right_terminal_working_directory: self.right_terminal_working_directory.take(),
            dev_server_port: self.dev_server_port.take(),
            // Drop the live webview by not carrying it into the stash.
            // Only the active session may own a live preview; starting another
            // preview clears stashed preview state and restarts the fixed port.
            web_preview: None,
            dev_server_task: self.dev_server_task.take(),
            subscriptions: std::mem::take(&mut self.session_subscriptions),
        };
        // Drop the active webview so the WKWebView is removed from the window immediately.
        self.web_preview = None;
        // The new editor's Enter-to-submit subscription belongs to the fresh session.
        self.session_subscriptions.push(enter_sub);
        self.session_subscriptions.push(browser_enter_sub);
        self.background_sessions.push(session);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn switch_to_session(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.background_sessions.len() {
            return;
        }
        self.pending_similar_project_confirmation = None;
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        let session = &mut self.background_sessions[ix];
        session.preview_url = None;
        session.preview_visible = false;
        session.is_preview_generating = false;
        session.web_preview = None;
        session.dev_server_port = None;
        session.dev_server_task = None;

        std::mem::swap(&mut self.active_chat_record_id, &mut session.chat_record_id);
        std::mem::swap(&mut self.state, &mut session.state);
        std::mem::swap(&mut self.tab_name, &mut session.tab_name);
        std::mem::swap(&mut self.chat_mode, &mut session.chat_mode);
        std::mem::swap(
            &mut self.chat_feed_display_mode,
            &mut session.chat_feed_display_mode,
        );
        std::mem::swap(&mut self.chat_editor, &mut session.chat_editor);
        std::mem::swap(
            &mut self.browser_address_editor,
            &mut session.browser_address_editor,
        );
        std::mem::swap(&mut self.selected_folder, &mut session.selected_folder);
        std::mem::swap(&mut self.thread, &mut session.thread);
        std::mem::swap(
            &mut self.pending_conversation_view,
            &mut session.pending_conversation_view,
        );
        std::mem::swap(
            &mut self.active_conversation_view,
            &mut session.active_conversation_view,
        );
        std::mem::swap(
            &mut self.queued_composer_submit,
            &mut session.queued_composer_submit,
        );
        std::mem::swap(&mut self.model_selector, &mut session.model_selector);
        std::mem::swap(&mut self.is_agent_running, &mut session.is_agent_running);
        std::mem::swap(&mut self.agent_finished, &mut session.agent_finished);
        std::mem::swap(&mut self.chat_feed, &mut session.chat_feed);
        std::mem::swap(
            &mut self.file_changes_panel,
            &mut session.file_changes_panel,
        );
        std::mem::swap(&mut self.left_tab, &mut session.left_tab);
        std::mem::swap(&mut self.show_raw_files, &mut session.show_raw_files);
        std::mem::swap(&mut self.raw_browse_path, &mut session.raw_browse_path);
        std::mem::swap(&mut self.right_panel, &mut session.right_panel);
        std::mem::swap(&mut self.code_diff_state, &mut session.code_diff_state);
        std::mem::swap(&mut self.right_panel_open, &mut session.right_panel_open);
        std::mem::swap(
            &mut self.right_panel_closing,
            &mut session.right_panel_closing,
        );
        std::mem::swap(
            &mut self.right_panel_expanded,
            &mut session.right_panel_expanded,
        );
        std::mem::swap(
            &mut self.right_panel_animation_generation,
            &mut session.right_panel_animation_generation,
        );
        std::mem::swap(&mut self.right_panel_mode, &mut session.right_panel_mode);
        std::mem::swap(
            &mut self.right_panel_option,
            &mut session.right_panel_option,
        );
        std::mem::swap(&mut self.right_panel_tabs, &mut session.right_panel_tabs);
        std::mem::swap(
            &mut self.active_right_panel_tab,
            &mut session.active_right_panel_tab,
        );
        std::mem::swap(&mut self.right_panel_dock, &mut session.right_panel_dock);
        std::mem::swap(
            &mut self.right_panel_height,
            &mut session.right_panel_height,
        );
        std::mem::swap(&mut self.bottom_panel_open, &mut session.bottom_panel_open);
        std::mem::swap(
            &mut self.bottom_panel_closing,
            &mut session.bottom_panel_closing,
        );
        std::mem::swap(
            &mut self.bottom_panel_animation_generation,
            &mut session.bottom_panel_animation_generation,
        );
        std::mem::swap(&mut self.share_dialog_open, &mut session.share_dialog_open);
        std::mem::swap(&mut self.preview_url, &mut session.preview_url);
        std::mem::swap(&mut self.preview_visible, &mut session.preview_visible);
        std::mem::swap(
            &mut self.is_preview_generating,
            &mut session.is_preview_generating,
        );
        std::mem::swap(&mut self.terminal_view, &mut session.terminal_view);
        std::mem::swap(
            &mut self.terminal_working_directory,
            &mut session.terminal_working_directory,
        );
        std::mem::swap(
            &mut self.right_terminal_view,
            &mut session.right_terminal_view,
        );
        std::mem::swap(
            &mut self.right_terminal_working_directory,
            &mut session.right_terminal_working_directory,
        );
        std::mem::swap(&mut self.dev_server_port, &mut session.dev_server_port);
        std::mem::swap(&mut self.dev_server_task, &mut session.dev_server_task);
        // Drop the active webview — background sessions never hold a live one.
        // render() will recreate it from preview_url for the new active session.
        self.web_preview = None;
        std::mem::swap(&mut self.session_subscriptions, &mut session.subscriptions);
        let placeholder = if matches!(self.state, BeginnerState::ActiveProject) {
            self.chat_mode.follow_up_placeholder()
        } else {
            self.chat_mode.placeholder()
        };
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(placeholder, window, cx);
        });
        self.refresh_composer_git_state_if_needed(cx);
        self.restore_active_chat_if_needed(window, cx);
        self.save_open_tabs(cx);
        cx.notify();
    }

    pub fn new(
        workspace: WeakEntity<Workspace>,
        multi_workspace: WeakEntity<MultiWorkspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (chat_editor, chat_enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let chat_search_editor = Self::make_search_editor(window, cx);
        let (browser_address_editor, browser_enter_sub) =
            Self::make_browser_address_editor(window, cx);
        let search_sub = cx.subscribe(&chat_search_editor, |_, _, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::Edited { .. }) {
                cx.notify();
            }
        });

        let load_recent = Self::load_chat_history(workspace.clone(), cx);
        let config_changes = backboard::subscribe_config_changes();
        let watch_api_key = cx.spawn(async move |this, cx| {
            while config_changes.recv().await.is_ok() {
                this.update(cx, |_, cx| cx.notify()).log_err();
            }
        });

        let project = workspace
            .upgrade()
            .map(|ws| ws.read(cx).project().clone())
            .expect("workspace must be alive when BeginnerWorkspace is created");

        // Always start simple mode on Home. Existing editor worktrees should not
        // force simple mode into an active project state on launch/resume.
        let initial_folder = None;
        let state = BeginnerState::Landing;

        // Keep state in sync when folders are opened or closed from any mode.
        let project_sub =
            cx.subscribe(
                &project,
                |this, _proj, event: &project::Event, cx| match event {
                    project::Event::WorktreeAdded(_) | project::Event::WorktreeRemoved(_) => {
                        this.sync_from_project(cx);
                    }
                    _ => {}
                },
            );

        Self {
            workspace,
            multi_workspace,
            project,
            focus_handle: cx.focus_handle(),
            state,
            active_chat_record_id: None,
            tab_name: SharedString::from("Home"),
            chat_mode: ChatMode::Build,
            chat_feed_display_mode: ChatFeedDisplayMode::LiveWork,
            chat_editor,
            chat_search_editor,
            browser_address_editor,
            selected_folder: initial_folder,
            composer_git_state: ComposerGitState::default(),
            composer_git_state_folder: None,
            thread: None,
            pending_conversation_view: None,
            active_conversation_view: None,
            queued_composer_submit: None,
            model_selector: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            raw_browse_path: None,
            right_panel: RightPanel::Preview,
            code_diff_state: CodeDiffState::default(),
            right_panel_open: false,
            right_panel_closing: false,
            right_panel_expanded: false,
            right_panel_animation_generation: 0,
            right_panel_mode: RightPanelMode::Artifact,
            right_panel_option: RightPanelOption::Files,
            right_panel_tabs: Vec::new(),
            active_right_panel_tab: None,
            right_panel_dock: SimplePanelDock::Right,
            right_panel_height: px(DOCKED_PANEL_DEFAULT_HEIGHT_PX),
            chat_panel_width: px(ds::CHAT_PANEL_WIDTH),
            bottom_panel_open: false,
            bottom_panel_closing: false,
            bottom_panel_animation_generation: 0,
            share_dialog_open: false,
            preview_url: None,
            preview_visible: false,
            is_preview_generating: false,
            terminal_view: None,
            terminal_working_directory: None,
            right_terminal_view: None,
            right_terminal_working_directory: None,
            dev_server_port: None,
            dev_server_task: None,
            web_preview: None,
            chats_sidebar_open: true,
            chats_sidebar_closing: false,
            chats_sidebar_animation_generation: 0,
            chats_sidebar_width: px(ds::SIDEBAR_WIDTH),
            pending_chats_sidebar_hover_open: None,
            background_sessions: Vec::new(),
            chat_history: Vec::new(),
            pending_similar_project_confirmation: None,
            pending_open_tabs: None,
            open_tabs_loaded: false,
            open_tabs_restored: false,
            files_sidebar_collapsed: false,
            _tasks: vec![load_recent, watch_api_key],
            _project_subscription: project_sub,
            _search_subscription: search_sub,
            session_subscriptions: vec![chat_enter_sub, browser_enter_sub],
        }
    }

    /// Called whenever the project's worktree list changes so the Chat UI
    /// stays in sync with folders opened or closed from any mode.
    fn sync_from_project(&mut self, cx: &mut Context<Self>) {
        // When multiple sessions are active the user manages folders explicitly via
        // stash/switch. The project accumulates worktrees from all sessions, so
        // first_visible_worktree_path would return a stale folder from any session.
        // Only auto-sync in single-session mode.
        if !self.background_sessions.is_empty() {
            return;
        }

        let new_folder = first_visible_worktree_path(&self.project, cx);

        // Only reset to Landing when the project truly has no folders —
        // don't discard an in-progress conversation when a second worktree
        // is added (e.g. agent workspace creating a git linked worktree).
        match (&self.state, &new_folder) {
            (BeginnerState::Landing, Some(_)) => {}
            (BeginnerState::ActiveProject, None) => {
                // All folders removed — return to landing.
                self.selected_folder = None;
                self.clear_composer_git_state();
                self.state = BeginnerState::Landing;
                self.chat_feed = None;
                self.thread = None;
                self.pending_conversation_view = None;
                self.active_conversation_view = None;
                self.queued_composer_submit = None;
                self.pending_similar_project_confirmation = None;
                self.file_changes_panel = None;
                self.is_agent_running = false;
                self.right_panel = RightPanel::Preview;
                self.code_diff_state = CodeDiffState::default();
                self.right_panel_open = false;
                self.right_panel_closing = false;
                self.right_panel_expanded = false;
                self.right_panel_mode = RightPanelMode::Artifact;
                self.right_panel_option = RightPanelOption::Files;
                self.reset_right_panel_tabs();
                self.share_dialog_open = false;
                self.preview_url = None;
                self.preview_visible = false;
                self.is_preview_generating = false;
                self.bottom_panel_open = false;
                self.bottom_panel_closing = false;
                self.bottom_panel_animation_generation = 0;
                self.terminal_view = None;
                self.terminal_working_directory = None;
                self.right_terminal_view = None;
                self.right_terminal_working_directory = None;
                self.web_preview = None;
                cx.notify();
            }
            _ => {}
        }
    }

    fn ensure_agent_panel(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<AgentPanel>> {
        let workspace = self.workspace.upgrade()?;
        Some(workspace.update(cx, |workspace, cx| {
            AgentPanel::ensure_attached(workspace, window, cx)
        }))
    }

    fn agent_workspace_chat_options(&self) -> BackboardAgentWorkspaceChatOptions {
        BackboardAgentWorkspaceChatOptions {
            mode: self.chat_mode.agent_workspace_mode(),
            work_dirs: self
                .selected_folder
                .as_ref()
                .map(|folder| PathList::new(&[folder.clone()])),
            focus: false,
            source: "beginner_ui",
            suppress_notifications: true,
        }
    }

    fn active_conversation_thread_id(&self, cx: &App) -> Option<ThreadId> {
        self.active_conversation_view
            .as_ref()
            .or(self.pending_conversation_view.as_ref())
            .map(|conversation_view| conversation_view.read(cx).parent_id())
    }

    fn create_simple_agent_draft(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<ConversationView>> {
        if self.selected_folder.is_none() {
            return None;
        }

        let options = self.agent_workspace_chat_options();
        let panel = self.ensure_agent_panel(window, cx)?;
        let conversation_view = panel.update(cx, |panel, cx| {
            let thread_id =
                panel.create_backboard_workspace_chat_with_options(options, window, cx)?;
            panel.backboard_workspace_conversation_view(thread_id, cx)
        })?;
        self.bind_conversation_view(conversation_view.clone(), window, cx);
        Some(conversation_view)
    }

    fn discard_simple_agent_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self
            .workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
        else {
            return;
        };
        let Some(thread_id) = panel
            .read(cx)
            .active_backboard_workspace_draft_thread_id(cx)
        else {
            return;
        };

        panel.update(cx, |panel, cx| {
            panel.remove_thread(thread_id, window, cx);
        });
        if self.active_conversation_thread_id(cx) == Some(thread_id) {
            self.thread = None;
            self.chat_feed = None;
            self.file_changes_panel = None;
            self.pending_conversation_view = None;
            self.active_conversation_view = None;
            self.queued_composer_submit = None;
            self.model_selector = None;
            self.is_agent_running = false;
            self.agent_finished = false;
        }
    }

    fn open_folder_as_worktree(
        &mut self,
        folder: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let task = workspace.update(cx, |workspace, cx| {
            workspace.open_paths(
                vec![folder],
                OpenOptions {
                    visible: Some(OpenVisible::All),
                    focus: Some(false),
                    ..Default::default()
                },
                None,
                window,
                cx,
            )
        });
        self._tasks
            .push(cx.spawn_in(window, async move |_this, _cx| {
                for result in task.await.into_iter().flatten() {
                    result.log_err();
                }
            }));
    }

    fn load_chat_history(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            let kvp = cx.update(|cx| {
                let _ = workspace; // keep alive
                KeyValueStore::global(cx)
            });
            let records = kvp
                .read_kvp(BEGINNER_CHATS_KVP_KEY)
                .log_err()
                .flatten()
                .and_then(|json| serde_json::from_str::<Vec<BeginnerChatRecord>>(&json).log_err())
                .unwrap_or_default();
            let open_tabs = kvp
                .read_kvp(BEGINNER_OPEN_TABS_KVP_KEY)
                .log_err()
                .flatten()
                .and_then(|json| serde_json::from_str::<BeginnerOpenTabsState>(&json).log_err())
                .unwrap_or_default();
            this.update(cx, |this, cx| {
                this.chat_history = records;
                this.pending_open_tabs = Some(open_tabs);
                this.open_tabs_loaded = true;
                cx.notify();
            })
            .ok();
        })
    }

    fn save_chat_history(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let records = self.chat_history.clone();
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&records) {
                kvp.write_kvp(BEGINNER_CHATS_KVP_KEY.to_string(), json)
                    .await
                    .log_err();
            }
        })
        .detach();
    }

    fn save_open_tabs(&self, cx: &mut App) {
        let kvp = KeyValueStore::global(cx);
        let state = BeginnerOpenTabsState {
            active_record_id: self.active_chat_record_id.clone(),
            background_record_ids: self
                .background_sessions
                .iter()
                .filter_map(|session| session.chat_record_id.clone())
                .collect(),
        };
        cx.background_spawn(async move {
            if let Ok(json) = serde_json::to_string(&state) {
                kvp.write_kvp(BEGINNER_OPEN_TABS_KVP_KEY.to_string(), json)
                    .await
                    .log_err();
            }
        })
        .detach();
    }

    fn run_git_command_raw(folder: &Path, args: &[&str]) -> anyhow::Result<String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .output()
            .with_context(|| format!("failed to run git in {}", folder.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let command = args.join(" ");
            if stderr.is_empty() {
                bail!("git {command} failed");
            }
            bail!("git {command} failed: {stderr}");
        }

        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn run_git_command(folder: &Path, args: &[&str]) -> anyhow::Result<String> {
        Ok(Self::run_git_command_raw(folder, args)?.trim().to_string())
    }

    fn read_composer_git_state(folder: &Path) -> anyhow::Result<ComposerGitState> {
        let inside_worktree =
            Self::run_git_command(folder, &["rev-parse", "--is-inside-work-tree"])?;
        if inside_worktree != "true" {
            bail!("{} is not a git repository", folder.display());
        }

        let branch_name = Self::run_git_command(folder, &["branch", "--show-current"])?;
        let current_branch = if branch_name.is_empty() {
            Self::run_git_command(folder, &["rev-parse", "--short", "HEAD"])
                .ok()
                .filter(|sha| !sha.is_empty())
        } else {
            Some(branch_name)
        }
        .map(SharedString::from);

        let branches = Self::run_git_command(folder, &["branch", "--format=%(refname:short)"])?
            .lines()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(|branch| SharedString::from(branch.to_string()))
            .collect();

        Ok(ComposerGitState {
            is_loading: false,
            is_git_repository: true,
            current_branch,
            branches,
        })
    }

    fn clear_composer_git_state(&mut self) {
        self.composer_git_state = ComposerGitState::default();
        self.composer_git_state_folder = None;
    }

    fn refresh_composer_git_state_if_needed(&mut self, cx: &mut Context<Self>) {
        if self.composer_git_state_folder == self.selected_folder {
            return;
        }

        self.composer_git_state_folder = self.selected_folder.clone();
        let Some(folder) = self.selected_folder.clone() else {
            self.composer_git_state = ComposerGitState::default();
            return;
        };

        self.composer_git_state = ComposerGitState {
            is_loading: true,
            ..ComposerGitState::default()
        };

        cx.spawn(async move |this, cx| {
            let folder_for_git = folder.clone();
            let state = cx
                .background_spawn(async move { Self::read_composer_git_state(&folder_for_git) })
                .await;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder) {
                    return;
                }

                this.composer_git_state = state.unwrap_or_default();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn switch_composer_git_branch(
        &mut self,
        branch_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return;
        };

        cx.spawn_in(window, async move |this, cx| {
            let folder_for_git = folder.clone();
            let branch_name_for_git = branch_name.clone();
            let state = cx
                .background_spawn(async move {
                    Self::run_git_command(
                        &folder_for_git,
                        &["switch", branch_name_for_git.as_str()],
                    )?;
                    Self::read_composer_git_state(&folder_for_git)
                })
                .await?;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() == Some(&folder) {
                    this.composer_git_state_folder = Some(folder);
                    this.composer_git_state = state;
                    cx.notify();
                }
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err("Failed to switch branch", window, cx, |_, _, _| None);
    }

    fn initialize_composer_git_repository(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return;
        };

        self.composer_git_state = ComposerGitState {
            is_loading: true,
            ..ComposerGitState::default()
        };
        self.composer_git_state_folder = Some(folder.clone());
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let folder_for_git = folder.clone();
            let state = cx
                .background_spawn(async move {
                    Self::run_git_command(&folder_for_git, &["init"])?;
                    Self::read_composer_git_state(&folder_for_git)
                })
                .await?;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder) {
                    return;
                }

                this.composer_git_state = state;
                cx.notify();
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err(
            "Failed to initialize Git repository",
            window,
            cx,
            |_, _, _| None,
        );
    }

    fn add_chat_record(&mut self, name: String, folder: &PathBuf, cx: &mut App) -> String {
        let record = BeginnerChatRecord::new(name, folder);
        let id = record.id.clone();
        // Insert at front so most-recent appears first; cap at 50 entries.
        self.chat_history.insert(0, record);
        self.chat_history.truncate(50);
        self.save_chat_history(cx);
        id
    }

    fn touch_chat_record(&mut self, id: &str, cx: &mut App) {
        let Some(index) = self.chat_history.iter().position(|record| record.id == id) else {
            return;
        };
        let mut record = self.chat_history.remove(index);
        record.timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(record.timestamp_ms);
        self.chat_history.insert(0, record);
        self.save_chat_history(cx);
    }

    fn update_latest_chat_record_session_id(
        &mut self,
        folder: &PathBuf,
        session_id: String,
        cx: &mut App,
    ) {
        let record = if let Some(active_id) = self.active_chat_record_id.clone() {
            self.chat_history
                .iter_mut()
                .find(|record| record.id == active_id)
        } else {
            self.chat_history
                .iter_mut()
                .find(|record| record.folder() == *folder && record.session_id.is_none())
        };

        if let Some(record) = record {
            record.session_id = Some(session_id);
            self.save_chat_history(cx);
        }
    }

    fn delete_chat_record(&mut self, id: String, cx: &mut App) {
        self.chat_history.retain(|r| r.id != id);
        self.background_sessions
            .retain(|session| session.chat_record_id.as_deref() != Some(id.as_str()));
        if self.active_chat_record_id.as_deref() == Some(id.as_str()) {
            self.active_chat_record_id = None;
        }
        self.save_chat_history(cx);
        self.save_open_tabs(cx);
    }

    fn confirm_similar_project_if_needed(
        &mut self,
        prompt: &str,
        folder: &Path,
        action: SimilarProjectConfirmationAction,
        cx: &mut Context<Self>,
    ) -> bool {
        if prompt_explicitly_requests_another_copy(prompt) {
            self.pending_similar_project_confirmation = None;
            return false;
        }

        let Some((record, match_score)) =
            scored_similar_prior_project_match(&self.chat_history, prompt, folder)
        else {
            self.pending_similar_project_confirmation = None;
            return false;
        };
        let record = record.clone();

        log::info!(
            "Simple mode found similar prior project before send: prompt={} prior_project={} prior_folder={} active_folder={} match_score={:.3} confidence={} shared_terms={} prompt_terms={} record_terms={}",
            prompt,
            record.name,
            record.folder_path,
            folder.display(),
            match_score.score,
            match_score.confidence.as_str(),
            match_score.shared_terms,
            match_score.prompt_terms,
            match_score.record_terms
        );

        self.pending_similar_project_confirmation = Some(SimilarProjectConfirmation {
            source: SimilarProjectConfirmationSource::Local(record.clone()),
            prior_project_name: record.display_name(),
            prior_project_location: Some(record.folder()),
            target_folder: folder.to_path_buf(),
            match_score,
            action,
        });
        cx.notify();
        true
    }

    fn continue_similar_project_confirmation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(confirmation) = self.pending_similar_project_confirmation.take() else {
            return;
        };

        log::info!(
            "Simple mode similar project action selected: action=create_new source={} source_id={} target_folder={} match_score={:.3} confidence={}",
            confirmation.source.kind(),
            confirmation.source.id(),
            confirmation.target_folder.display(),
            confirmation.match_score.score,
            confirmation.match_score.confidence.as_str()
        );

        self.continue_similar_project_action(confirmation.action, window, cx);
    }

    fn continue_similar_project_action(
        &mut self,
        action: SimilarProjectConfirmationAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            SimilarProjectConfirmationAction::InitialSubmit {
                prompt,
                agent_text,
                folder,
            } => {
                self.submit_initial_project(prompt, agent_text, folder, window, cx);
            }
            SimilarProjectConfirmationAction::ThreadComposer { prompt } => {
                self.prepare_thread_composer_send_confirmed(prompt, window, cx);
            }
        }
    }

    fn confirm_remote_similar_project_if_needed(
        &mut self,
        prompt: &str,
        folder: &Path,
        action: SimilarProjectConfirmationAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if prompt_explicitly_requests_another_copy(prompt) {
            return false;
        }

        let config = backboard::BackboardConfig::load_or_default();
        let Ok(client) = backboard::BackboardClient::from_config(config) else {
            return false;
        };

        let prompt = prompt.to_string();
        let folder = folder.to_path_buf();
        log::info!(
            "Simple mode loading remote project history before send: active_folder={}",
            folder.display()
        );
        cx.spawn_in(window, async move |this, cx| {
            let lookup_prompt = prompt.clone();
            let threads = gpui_tokio::Tokio::spawn_result(cx, async move {
                load_remote_project_records(client, &lookup_prompt).await
            })
            .await;

            this.update_in(cx, |this, window, cx| {
                let records = match threads {
                    Ok(records) => records,
                    Err(error) => {
                        log::warn!(
                            "Simple mode remote project history lookup failed: active_folder={} error={error:#}",
                            folder.display()
                        );
                        this.continue_similar_project_action(action, window, cx);
                        return;
                    }
                };

                let Some((record, match_score)) =
                    scored_similar_remote_project_match(&records, &prompt)
                else {
                    this.continue_similar_project_action(action, window, cx);
                    return;
                };
                let record = record.clone();

                log::info!(
                    "Simple mode found remote similar project before send: prompt={} prior_project={} thread_id={} active_folder={} match_score={:.3} confidence={} shared_terms={} prompt_terms={} record_terms={}",
                    prompt,
                    record.title,
                    record.thread_id,
                    folder.display(),
                    match_score.score,
                    match_score.confidence.as_str(),
                    match_score.shared_terms,
                    match_score.prompt_terms,
                    match_score.record_terms
                );

                this.pending_similar_project_confirmation = Some(SimilarProjectConfirmation {
                    source: SimilarProjectConfirmationSource::Remote(record.clone()),
                    prior_project_name: SharedString::from(record.title.clone()),
                    prior_project_location: record.workspace_path.clone(),
                    target_folder: folder,
                    match_score,
                    action,
                });
                cx.notify();
            })
            .ok();
        })
        .detach();

        true
    }

    fn build_on_previous_version_confirmation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(confirmation) = self.pending_similar_project_confirmation.take() else {
            return;
        };
        log::info!(
            "Simple mode similar project action selected: action=build_on_top source={} source_id={} target_folder={} match_score={:.3} confidence={}",
            confirmation.source.kind(),
            confirmation.source.id(),
            confirmation.target_folder.display(),
            confirmation.match_score.score,
            confirmation.match_score.confidence.as_str()
        );
        let prompt = confirmation.action.prompt_text();
        match confirmation.source {
            SimilarProjectConfirmationSource::Local(record) => {
                let record_id = record.id.clone();

                self.open_chat_record(record, window, cx);
                if self.active_chat_record_id.as_deref() != Some(record_id.as_str()) {
                    cx.notify();
                    return;
                }

                self.queued_composer_submit = Some(prompt);
                self.send_queued_composer_submit(window, cx);
                cx.notify();
            }
            SimilarProjectConfirmationSource::Remote(record) => {
                self.build_on_remote_previous_version(
                    record,
                    prompt,
                    confirmation.target_folder,
                    window,
                    cx,
                );
            }
        }
    }

    fn build_on_remote_previous_version(
        &mut self,
        record: RemoteProjectRecord,
        prompt: String,
        target_folder: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let config = backboard::BackboardConfig::load_or_default();
        let client = backboard::BackboardClient::from_config(config).ok();
        cx.spawn_in(window, async move |this, cx| {
            let thread_context = if let Some(client) = client {
                let thread_id = record.thread_id.clone();
                match gpui_tokio::Tokio::spawn_result(cx, async move {
                    client.get_thread(&thread_id).await
                })
                .await
                {
                    Ok(thread) => remote_thread_context(&thread),
                    Err(error) => {
                        log::warn!(
                            "Simple mode remote project thread context lookup failed: thread_id={} error={error:#}",
                            record.thread_id
                        );
                        None
                    }
                }
            } else {
                None
            };

            this.update_in(cx, |this, window, cx| {
                let agent_text =
                    remote_build_on_top_message(&record, thread_context.as_deref(), &prompt);
                this.submit_initial_project(prompt, agent_text, target_folder, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn pick_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            let conversation_view_to_send = this
                .update_in(cx, |this, window, cx| {
                    this.selected_folder = Some(folder.clone());
                    this.open_folder_as_worktree(folder.clone(), window, cx);
                    this.refresh_composer_git_state_if_needed(cx);
                    if let (Some(thread), Some(folder)) =
                        (this.thread.clone(), this.selected_folder.clone())
                    {
                        thread.update(cx, |thread, cx| {
                            thread.set_work_dirs(PathList::new(&[folder]), cx);
                        });
                    }
                    // If the user already typed a prompt, submit immediately so they
                    // don't need to click "Create Project" a second time.
                    let has_text = !this.chat_editor.read(cx).text(cx).trim().is_empty();
                    if has_text {
                        this.submit(window, cx);
                        None
                    } else if this.active_conversation_view.as_ref().is_some_and(|view| {
                        view.read(cx)
                            .root_message_editor_is_empty(cx)
                            .is_some_and(|is_empty| !is_empty)
                    }) {
                        this.active_conversation_view.clone()
                    } else {
                        if this.thread.is_none() {
                            this.create_simple_agent_draft(window, cx);
                            this.is_agent_running = false;
                        }
                        cx.notify();
                        None
                    }
                })
                .ok()
                .flatten();

            if let Some(conversation_view) = conversation_view_to_send {
                conversation_view
                    .downgrade()
                    .update_in(cx, |view, window, cx| {
                        view.send_root_message_editor(window, cx);
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return;
        }

        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() {
            return;
        }
        let agent_text = self.chat_mode.prepare_message(text.clone());

        let folder = match &self.selected_folder {
            Some(f) => f.clone(),
            None => {
                self.pick_folder(window, cx);
                return;
            }
        };

        if self.confirm_similar_project_if_needed(
            &text,
            &folder,
            SimilarProjectConfirmationAction::InitialSubmit {
                prompt: text.clone(),
                agent_text: agent_text.clone(),
                folder: folder.clone(),
            },
            cx,
        ) {
            return;
        }

        if self.confirm_remote_similar_project_if_needed(
            &text,
            &folder,
            SimilarProjectConfirmationAction::InitialSubmit {
                prompt: text.clone(),
                agent_text: agent_text.clone(),
                folder: folder.clone(),
            },
            window,
            cx,
        ) {
            return;
        }

        self.submit_initial_project(text, agent_text, folder, window, cx);
    }

    fn submit_initial_project(
        &mut self,
        text: String,
        agent_text: String,
        folder: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_similar_project_confirmation = None;
        self.selected_folder = Some(folder.clone());
        let chat_name = generate_chat_name(&text);
        self.tab_name = SharedString::from(chat_name.clone());
        self.state = BeginnerState::ActiveProject;
        // Save the chat to history before starting, so it appears on the home page
        // even if the user immediately closes without waiting for the agent.
        let record_id = self.add_chat_record(chat_name, &folder, cx);
        self.active_chat_record_id = Some(record_id);
        self.save_open_tabs(cx);

        // If a draft thread is already present (for pre-send model selection),
        // keep it and send as follow-up so the chosen model is respected.
        if self.thread.is_some() {
            self.submit_follow_up(window, cx);
            return;
        }

        if self.pending_conversation_view.is_some() || self.active_conversation_view.is_some() {
            self.queued_composer_submit = Some(agent_text);
            self.chat_editor.update(cx, |editor, cx| {
                editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
                editor.set_text("", window, cx);
            });
            self.is_agent_running = true;
            self.agent_finished = false;
            self.open_live_preview_panel(cx);
            self.ensure_live_preview_started(cx);
            self.send_queued_composer_submit(window, cx);
            cx.notify();
            return;
        }

        // Clear all previous session state so the new project starts completely fresh.
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.right_panel = RightPanel::Preview;
        self.code_diff_state = CodeDiffState::default();
        self.right_panel_open = false;
        self.right_panel_closing = false;
        self.right_panel_expanded = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.reset_right_panel_tabs();
        self.share_dialog_open = false;
        self.bottom_panel_open = false;
        self.bottom_panel_closing = false;
        self.bottom_panel_animation_generation = 0;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.right_terminal_view = None;
        self.right_terminal_working_directory = None;
        self.open_live_preview_panel(cx);
        self.ensure_live_preview_started(cx);
        cx.notify();

        let task = cx.spawn_in(window, async move |this, cx| {
            Self::open_folder_and_start_agent(this, folder, agent_text, cx).await;
        });
        self._tasks.push(task);
    }

    async fn open_folder_and_start_agent(
        this: WeakEntity<Self>,
        folder: PathBuf,
        text: String,
        cx: &mut AsyncWindowContext,
    ) {
        // Ensure the folder has a git repository so the diff panel works.
        // git init is safe on an existing repository and fast enough to await.
        let folder_for_git = folder.clone();
        cx.background_spawn(async move {
            Self::run_git_command(&folder_for_git, &["init"]).log_err();
        })
        .await;

        this.update_in(cx, |bw, window, cx| {
            // Force a re-check of git state now that the repository is initialized.
            bw.composer_git_state_folder = None;
            bw.open_folder_as_worktree(folder.clone(), window, cx);
            bw.refresh_composer_git_state_if_needed(cx);
            bw.start_agent_thread(text, window, cx);
        })
        .ok();
    }

    fn start_agent_thread(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        if !text.trim().is_empty() {
            self.queued_composer_submit = Some(text);
        }

        if self.create_simple_agent_draft(window, cx).is_none() {
            return;
        }

        self.is_agent_running = true;
        self.agent_finished = false;
        if self.preview_url.is_none() && !self.is_preview_generating {
            Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
            self.clear_current_preview_state();
        }
        self.right_panel = RightPanel::Preview;
        self.code_diff_state = CodeDiffState::default();
        self.right_panel_open = false;
        self.right_panel_closing = false;
        self.right_panel_expanded = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.reset_right_panel_tabs();
        self.share_dialog_open = false;
        self.bottom_panel_open = false;
        self.bottom_panel_closing = false;
        self.bottom_panel_animation_generation = 0;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.right_terminal_view = None;
        self.right_terminal_working_directory = None;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
            editor.set_text("", window, cx);
        });
        self.open_live_preview_panel(cx);
        self.ensure_live_preview_started(cx);
        cx.notify();
    }

    fn ensure_composer_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key()
            || self.selected_folder.is_none()
            || self.thread.is_some()
            || self.pending_conversation_view.is_some()
            || self.active_conversation_view.is_some()
        {
            return;
        }

        self.create_simple_agent_draft(window, cx);
    }

    fn configure_thread_composer(
        &self,
        conversation_view: &Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prompt_prefix = SharedString::from(self.chat_mode.prompt_prefix());
        let draft_text = self.chat_editor.read(cx).text(cx);
        let thread_id = conversation_view.read(cx).parent_id();
        let hook_conversation_view = conversation_view.clone();
        let workspace = cx.entity().downgrade();
        conversation_view.update(cx, |conversation_view, cx| {
            conversation_view.set_root_prompt_prefix(Some(prompt_prefix), cx);
            conversation_view.set_root_message_editor_auto_height(
                SIMPLE_COMPOSER_MIN_LINES,
                Some(SIMPLE_COMPOSER_MAX_LINES),
                cx,
            );
            conversation_view.seed_root_message_text_if_empty(draft_text, window, cx);
            conversation_view.set_root_before_send_hook(
                Some(Rc::new(move |text, window, cx| {
                    let conversation_view = hook_conversation_view.clone();
                    workspace
                        .update(cx, |workspace, cx| {
                            workspace.prepare_thread_composer_send(
                                thread_id,
                                conversation_view,
                                text,
                                window,
                                cx,
                            )
                        })
                        .unwrap_or(false)
                })),
                cx,
            );
        });
    }

    fn sync_thread_prompt_prefix(&self, cx: &mut Context<Self>) {
        let prompt_prefix = SharedString::from(self.chat_mode.prompt_prefix());
        if let Some(conversation_view) = self
            .active_conversation_view
            .as_ref()
            .or(self.pending_conversation_view.as_ref())
        {
            conversation_view.update(cx, |conversation_view, cx| {
                conversation_view.set_root_prompt_prefix(Some(prompt_prefix), cx);
            });
        }
    }

    fn prepare_thread_composer_send(
        &mut self,
        active_thread_id: ThreadId,
        conversation_view: Entity<ConversationView>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.prepare_thread_composer_send_impl(
            active_thread_id,
            conversation_view,
            text,
            true,
            window,
            cx,
        )
    }

    fn prepare_thread_composer_send_confirmed(
        &mut self,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(conversation_view) = self.active_conversation_view.clone() else {
            self.queued_composer_submit = Some(text);
            self.ensure_composer_thread(window, cx);
            return false;
        };
        let active_thread_id = conversation_view.read(cx).parent_id();
        self.prepare_thread_composer_send_impl(
            active_thread_id,
            conversation_view,
            &text,
            false,
            window,
            cx,
        )
    }

    fn prepare_thread_composer_send_impl(
        &mut self,
        active_thread_id: ThreadId,
        conversation_view: Entity<ConversationView>,
        text: &str,
        check_similar_projects: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return false;
        }

        let text = text.trim();
        if text.is_empty() {
            return false;
        }

        let Some(folder) = self.selected_folder.clone() else {
            self.pick_folder(window, cx);
            return false;
        };

        if check_similar_projects
            && matches!(self.state, BeginnerState::Landing)
            && self.confirm_similar_project_if_needed(
                text,
                &folder,
                SimilarProjectConfirmationAction::ThreadComposer {
                    prompt: text.to_string(),
                },
                cx,
            )
        {
            return false;
        }

        if check_similar_projects
            && matches!(self.state, BeginnerState::Landing)
            && self.confirm_remote_similar_project_if_needed(
                text,
                &folder,
                SimilarProjectConfirmationAction::ThreadComposer {
                    prompt: text.to_string(),
                },
                window,
                cx,
            )
        {
            return false;
        }

        self.open_folder_as_worktree(folder.clone(), window, cx);

        let work_dirs = PathList::new(&[folder.clone()]);
        if let Some(thread) = self.thread.clone() {
            thread.update(cx, |thread, cx| {
                thread.set_work_dirs(work_dirs.clone(), cx);
            });
        }

        let panel = self
            .workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx));
        if panel.as_ref().is_some_and(|panel| {
            panel
                .read(cx)
                .is_unpromoted_backboard_workspace_draft_thread(active_thread_id)
        }) {
            let Some(panel) = panel else {
                return false;
            };
            let promoted = panel.update(cx, |panel, cx| {
                panel.promote_backboard_workspace_draft_thread(
                    active_thread_id,
                    conversation_view.clone(),
                    text.to_string(),
                    BackboardAgentWorkspaceScope::WholeProject,
                    BackboardAgentWorkspaceKind::Build,
                    self.chat_mode.agent_workspace_mode(),
                    cx,
                )
            });
            if promoted != Some(active_thread_id) {
                return false;
            }
        }

        if matches!(self.state, BeginnerState::Landing) {
            let chat_name = generate_chat_name(text);
            self.tab_name = SharedString::from(chat_name.clone());
            self.state = BeginnerState::ActiveProject;
            let record_id = self.add_chat_record(chat_name, &folder, cx);
            self.active_chat_record_id = Some(record_id.clone());
            if let Some(thread) = self.thread.clone() {
                let session_id = thread.read(cx).session_id().0.to_string();
                self.update_latest_chat_record_session_id(&folder, session_id, cx);
                thread.update(cx, |thread, cx| {
                    thread.set_provisional_title(SharedString::from(generate_chat_name(text)), cx);
                });
            }
            self.save_open_tabs(cx);
        } else if let Some(record_id) = self.active_chat_record_id.clone() {
            self.touch_chat_record(&record_id, cx);
        }

        self.is_agent_running = true;
        self.agent_finished = false;
        self.open_live_preview_panel(cx);
        self.ensure_live_preview_started(cx);
        cx.notify();
        self.send_conversation_message_after_model_check(
            conversation_view,
            text.to_string(),
            window,
            cx,
        );
        false
    }

    fn submit_follow_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !Self::has_backboard_api_key() {
            cx.notify();
            return;
        }

        if self.thread.is_none() {
            self.submit(window, cx);
            return;
        }

        if self.selected_folder.is_none() {
            self.submit(window, cx);
            return;
        }

        let text = self.chat_editor.read(cx).text(cx).trim().to_string();
        if text.is_empty() || self.is_agent_running {
            return;
        }
        let agent_text = self.chat_mode.prepare_message(text);
        if let Some(folder) = self.selected_folder.clone() {
            if let Some(thread) = self.thread.clone() {
                thread.update(cx, |thread, cx| {
                    thread.set_work_dirs(PathList::new(&[folder]), cx);
                });
            }
        }
        if let Some(record_id) = self.active_chat_record_id.clone() {
            self.touch_chat_record(&record_id, cx);
        }

        if self.pending_conversation_view.is_some() {
            self.queued_composer_submit = Some(agent_text);
            self.chat_editor.update(cx, |editor, cx| {
                editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
                editor.set_text("", window, cx);
            });
            self.is_agent_running = true;
            self.agent_finished = false;
            self.open_live_preview_panel(cx);
            self.ensure_live_preview_started(cx);
            cx.notify();
            return;
        }

        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
            editor.set_text("", window, cx);
        });
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.is_agent_running = true;
        self.agent_finished = false;
        self.open_live_preview_panel(cx);
        self.ensure_live_preview_started(cx);
        cx.notify();

        if let Some(conversation_view) = self.active_conversation_view.clone() {
            self.send_conversation_message_after_model_check(
                conversation_view,
                agent_text,
                window,
                cx,
            );
        } else if let Some(thread) = self.thread.clone() {
            cx.spawn(async move |_this, cx| {
                let future = thread.update(cx, |thread, cx| {
                    thread.send(vec![agent_text.as_str().into()], cx)
                });
                future.await.log_err();
            })
            .detach();
        } else {
            self.queued_composer_submit = Some(agent_text);
            self.start_agent_thread(String::new(), window, cx);
        }
    }

    fn handle_file_panel_event(
        &mut self,
        event: &FileChangesPanelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FileChangesPanelEvent::FileSelected(path) => {
                self.open_file_read_only(path.as_path(), window, cx);
                cx.notify();
            }
        }
    }

    fn handle_chat_feed_event(
        &mut self,
        event: &BeginnerChatFeedEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            BeginnerChatFeedEvent::PreviewRequested => self.show_preview(window, cx),
            BeginnerChatFeedEvent::ChangesRequested => self.show_code_artifact(cx),
            BeginnerChatFeedEvent::ShareRequested => {
                self.share_dialog_open = true;
                cx.notify();
            }
        }
    }

    fn has_failed_tool_call(&self, cx: &App) -> bool {
        self.thread.as_ref().is_some_and(|thread| {
            thread.read(cx).entries().iter().any(|entry| {
                matches!(
                    entry,
                    AgentThreadEntry::ToolCall(call)
                        if matches!(
                            call.status,
                            ToolCallStatus::Failed
                                | ToolCallStatus::Rejected
                                | ToolCallStatus::Canceled
                        )
                )
            })
        })
    }

    fn open_right_panel(&mut self) {
        if !self.right_panel_open || self.right_panel_closing {
            self.right_panel_animation_generation =
                self.right_panel_animation_generation.saturating_add(1);
        }
        self.right_panel_open = true;
        self.right_panel_closing = false;
    }

    fn focus_primary_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus_handle) =
            self.active_conversation_view
                .as_ref()
                .and_then(|conversation_view| {
                    conversation_view
                        .read(cx)
                        .root_message_editor_focus_handle(cx)
                })
        {
            window.focus(&focus_handle, cx);
        } else {
            let focus_handle = self.chat_editor.focus_handle(cx);
            window.focus(&focus_handle, cx);
        }
    }

    fn toggle_right_panel_expanded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_right_panel();
        self.right_panel_expanded = !self.right_panel_expanded;
        self.web_preview = None;
        self.right_panel_animation_generation =
            self.right_panel_animation_generation.saturating_add(1);
        if !self.right_panel_expanded {
            self.focus_primary_composer(window, cx);
        }
        cx.notify();
    }

    fn close_right_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.clear_current_preview_state();
        self.focus_primary_composer(window, cx);

        if !self.right_panel_open {
            self.right_panel_closing = false;
            self.right_panel_expanded = false;
            cx.notify();
            return;
        }

        if self.right_panel_closing {
            return;
        }

        self.right_panel_closing = true;
        self.right_panel_animation_generation =
            self.right_panel_animation_generation.saturating_add(1);
        let generation = self.right_panel_animation_generation;
        let close_panel = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                .await;
            this.update(cx, |this, cx| {
                if this.right_panel_closing && this.right_panel_animation_generation == generation {
                    this.right_panel_open = false;
                    this.right_panel_closing = false;
                    this.right_panel_expanded = false;
                    cx.notify();
                }
            })
            .ok();
        });
        self._tasks.push(close_panel);
        cx.notify();
    }

    fn open_chats_sidebar(&mut self, cx: &mut Context<Self>) {
        self.pending_chats_sidebar_hover_open.take();
        if !self.chats_sidebar_open || self.chats_sidebar_closing {
            self.chats_sidebar_animation_generation =
                self.chats_sidebar_animation_generation.saturating_add(1);
        }
        self.chats_sidebar_open = true;
        self.chats_sidebar_closing = false;
        cx.notify();
    }

    fn mouse_is_in_collapsed_chats_sidebar(window: &Window) -> bool {
        let mouse_position = window.mouse_position();
        let viewport_size = window.viewport_size();

        mouse_position.x >= px(0.)
            && mouse_position.x <= px(CLOSED_CHATS_SIDEBAR_WIDTH_PX)
            && mouse_position.y >= px(0.)
            && mouse_position.y <= viewport_size.height
    }

    fn delay_open_chats_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.chats_sidebar_open && !self.chats_sidebar_closing {
            return;
        }

        if self.pending_chats_sidebar_hover_open.is_some() {
            return;
        }

        self.pending_chats_sidebar_hover_open = Some(cx.spawn_in(window, async move |this, cx| {
            for _ in 0..(SIMPLE_SIDEBAR_HOVER_OPEN_DELAY_MS / SIMPLE_SIDEBAR_HOVER_OPEN_POLL_MS) {
                cx.background_executor()
                    .timer(Duration::from_millis(SIMPLE_SIDEBAR_HOVER_OPEN_POLL_MS))
                    .await;

                let should_continue = this
                    .update_in(cx, |this, window, cx| {
                        if this.pending_chats_sidebar_hover_open.is_none() {
                            return false;
                        }

                        if !Self::mouse_is_in_collapsed_chats_sidebar(window) {
                            this.pending_chats_sidebar_hover_open.take();
                            cx.notify();
                            return false;
                        }

                        true
                    })
                    .ok()
                    .unwrap_or(false);

                if !should_continue {
                    return;
                }
            }

            this.update_in(cx, |this, window, cx| {
                this.pending_chats_sidebar_hover_open.take();
                if Self::mouse_is_in_collapsed_chats_sidebar(window)
                    && (!this.chats_sidebar_open || this.chats_sidebar_closing)
                {
                    this.open_chats_sidebar(cx);
                }
            })
            .ok();
        }));
    }

    fn close_chats_sidebar(&mut self, cx: &mut Context<Self>) {
        self.pending_chats_sidebar_hover_open.take();
        if !self.chats_sidebar_open {
            self.chats_sidebar_closing = false;
            cx.notify();
            return;
        }

        if self.chats_sidebar_closing {
            return;
        }

        self.chats_sidebar_closing = true;
        self.chats_sidebar_animation_generation =
            self.chats_sidebar_animation_generation.saturating_add(1);
        let generation = self.chats_sidebar_animation_generation;
        let close_sidebar = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                .await;
            this.update(cx, |this, cx| {
                if this.chats_sidebar_closing
                    && this.chats_sidebar_animation_generation == generation
                {
                    this.chats_sidebar_open = false;
                    this.chats_sidebar_closing = false;
                    cx.notify();
                }
            })
            .ok();
        });
        self._tasks.push(close_sidebar);
        cx.notify();
    }

    fn activate_right_panel_tab(&mut self, option: RightPanelOption) {
        if !self.right_panel_tabs.contains(&option) {
            self.right_panel_tabs.push(option);
        }
        self.active_right_panel_tab = Some(option);
        self.right_panel_option = option;
        self.open_right_panel();
    }

    fn reset_right_panel_tabs(&mut self) {
        self.right_panel_tabs.clear();
        self.active_right_panel_tab = None;
        self.right_panel_option = RightPanelOption::Files;
    }

    fn open_live_preview_panel(&mut self, cx: &mut Context<Self>) {
        if self.chat_mode != ChatMode::Build {
            return;
        }

        self.right_panel = RightPanel::Preview;
        self.activate_right_panel_tab(RightPanelOption::Design);
        self.right_panel_mode = RightPanelMode::Artifact;
        self.preview_visible = self.preview_url.is_some();
        cx.notify();
    }

    fn ensure_live_preview_started(&mut self, cx: &mut Context<Self>) {
        if self.chat_mode != ChatMode::Build {
            return;
        }

        if self.selected_folder.is_some()
            && self.preview_url.is_none()
            && !self.is_preview_generating
        {
            self.open_web_app_if_present(cx);
        }
    }

    fn close_right_panel_tab(
        &mut self,
        option: RightPanelOption,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let removed_index = self.right_panel_tabs.iter().position(|tab| *tab == option);
        let Some(removed_index) = removed_index else {
            return;
        };

        self.right_panel_tabs.remove(removed_index);
        if option == RightPanelOption::Design {
            Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
            self.clear_current_preview_state();
        }

        if self.active_right_panel_tab == Some(option) {
            if let Some(next_option) = self
                .right_panel_tabs
                .get(removed_index)
                .or_else(|| {
                    removed_index
                        .checked_sub(1)
                        .and_then(|ix| self.right_panel_tabs.get(ix))
                })
                .copied()
            {
                self.select_right_panel_option(next_option, window, cx);
            } else {
                self.active_right_panel_tab = None;
                self.right_panel = RightPanel::Preview;
                self.right_panel_mode = RightPanelMode::Artifact;
                Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
                self.clear_current_preview_state();
                cx.notify();
            }
        } else {
            cx.notify();
        }
    }

    fn show_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.right_panel = RightPanel::Preview;
        self.activate_right_panel_tab(RightPanelOption::Design);
        self.right_panel_mode = RightPanelMode::Artifact;

        if self.selected_folder.is_some()
            && self.preview_url.is_none()
            && !self.is_preview_generating
        {
            self.open_web_app_if_present(cx);
        }

        if let Some(url) = self.preview_url.clone() {
            self.navigate_browser_to_url(url, window, cx);
        } else {
            cx.notify();
        }
    }

    fn normalize_browser_url(input: String) -> Option<String> {
        let input = input.trim();
        if input.is_empty() {
            return None;
        }

        if input.contains("://") || input.starts_with("file:") {
            return Some(input.to_string());
        }

        if input.starts_with("localhost") || input.starts_with("127.") || input.starts_with("[::1]")
        {
            return Some(format!("http://{input}"));
        }

        Some(format!("https://{input}"))
    }

    fn navigate_browser_to_input(
        &mut self,
        input: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(url) = Self::normalize_browser_url(input) {
            self.navigate_browser_to_url(url, window, cx);
        }
    }

    fn navigate_browser_to_url(
        &mut self,
        url: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let address_label = Self::browser_address_label(Some(&url));
        self.browser_address_editor.update(cx, |editor, cx| {
            editor.set_text(address_label, window, cx);
        });
        self.preview_url = Some(url);
        self.preview_visible = true;
        self.web_preview = None;
        self.right_panel = RightPanel::Preview;
        self.activate_right_panel_tab(RightPanelOption::Design);
        self.right_panel_mode = RightPanelMode::Artifact;
        cx.notify();
    }

    fn open_artifact_panel(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.right_panel = RightPanel::Preview;
        self.open_right_panel();
        self.right_panel_mode = RightPanelMode::Artifact;
        self.active_right_panel_tab = None;
        self.preview_visible = false;
        self.web_preview = None;
        cx.notify();
    }

    fn select_right_panel_option(
        &mut self,
        option: RightPanelOption,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if option == RightPanelOption::Terminal {
            self.open_bottom_terminal_panel(window, cx);
            return;
        }

        self.activate_right_panel_tab(option);

        match option {
            RightPanelOption::Files => {
                self.right_panel_mode = RightPanelMode::Launcher;
                self.preview_visible = false;
                self.web_preview = None;
                if self.raw_browse_path.is_none() {
                    self.raw_browse_path = self.selected_folder.clone();
                }
                cx.notify();
            }
            RightPanelOption::Design => {
                self.right_panel = RightPanel::Preview;
                self.right_panel_mode = RightPanelMode::Artifact;
                self.preview_visible = self.preview_url.is_some();
                self.web_preview = None;
                if let Some(url) = self.preview_url.clone() {
                    let address_label = Self::browser_address_label(Some(&url));
                    self.browser_address_editor.update(cx, |editor, cx| {
                        editor.set_text(address_label, window, cx);
                    });
                    cx.notify();
                } else if self.selected_folder.is_some() {
                    self.open_web_app_if_present(cx);
                } else {
                    self.browser_address_editor.update(cx, |editor, cx| {
                        editor.set_text("", window, cx);
                    });
                    cx.notify();
                }
            }
            RightPanelOption::Code => {
                self.show_code_artifact(cx);
            }
            RightPanelOption::Terminal => {}
        }
    }

    fn open_bottom_terminal_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.bottom_panel_open || self.bottom_panel_closing {
            self.bottom_panel_animation_generation =
                self.bottom_panel_animation_generation.saturating_add(1);
        }
        if self.right_panel_open
            && matches!(
                self.active_right_panel_tab,
                Some(RightPanelOption::Files | RightPanelOption::Code | RightPanelOption::Terminal)
            )
        {
            self.close_right_panel(window, cx);
        }
        self.bottom_panel_open = true;
        self.bottom_panel_closing = false;
        self.ensure_bottom_terminal(window, cx);
        cx.notify();
    }

    fn close_bottom_panel(&mut self, cx: &mut Context<Self>) {
        if !self.bottom_panel_open {
            self.bottom_panel_closing = false;
            cx.notify();
            return;
        }

        if self.bottom_panel_closing {
            return;
        }

        self.bottom_panel_closing = true;
        self.bottom_panel_animation_generation =
            self.bottom_panel_animation_generation.saturating_add(1);
        let generation = self.bottom_panel_animation_generation;
        let close_panel = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                .await;
            this.update(cx, |this, cx| {
                if this.bottom_panel_closing && this.bottom_panel_animation_generation == generation
                {
                    this.bottom_panel_open = false;
                    this.bottom_panel_closing = false;
                    cx.notify();
                }
            })
            .ok();
        });
        self._tasks.push(close_panel);
        cx.notify();
    }

    fn preview_card_state(&self) -> PreviewCardState {
        if self.is_preview_generating {
            PreviewCardState::Generating
        } else if self.preview_url.is_some() {
            PreviewCardState::Ready
        } else if self.agent_finished {
            PreviewCardState::Unavailable
        } else {
            PreviewCardState::Building
        }
    }

    fn terminal_working_directory(&self) -> Option<PathBuf> {
        self.selected_folder.clone().or_else(|| {
            std::env::var_os("HOME").map(|home| {
                let home = PathBuf::from(home);
                let desktop = home.join("Desktop");
                if desktop.is_dir() { desktop } else { home }
            })
        })
    }

    fn ensure_bottom_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(working_directory) = self.terminal_working_directory() else {
            return;
        };

        if self.terminal_view.is_some()
            && self.terminal_working_directory.as_ref() == Some(&working_directory)
        {
            return;
        }

        self.terminal_view = None;
        self.terminal_working_directory = Some(working_directory.clone());
        let project = self.project.clone();
        let weak_project = self.project.downgrade();
        let workspace = self.workspace.clone();

        cx.spawn_in(window, async move |this, cx| {
            let create_terminal = project.update(cx, |project, cx| {
                project.create_terminal_shell(Some(working_directory.clone()), cx)
            });
            let terminal = create_terminal.await?;

            this.update_in(cx, |this, window, cx| {
                if this.terminal_working_directory.as_ref() != Some(&working_directory) {
                    return;
                }

                let terminal_view = cx.new(|cx| {
                    TerminalView::new(
                        terminal.clone(),
                        workspace.clone(),
                        None,
                        weak_project.clone(),
                        window,
                        cx,
                    )
                });
                this.terminal_view = Some(terminal_view);
                cx.notify();
            })?;

            anyhow::Ok(())
        })
        .detach_and_prompt_err("Failed to open terminal", window, cx, |_, _, _| None);
    }

    fn code_view_for_path(
        &self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> RightPanel {
        let resolved_path = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(folder) = self.selected_folder.as_ref() {
            folder.join(path)
        } else {
            path.to_path_buf()
        };
        let title = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let content = match std::fs::read_to_string(&resolved_path) {
            Ok(content) => content,
            Err(error) => format!(
                "Unable to read {} as text: {error}",
                resolved_path.display()
            ),
        };
        RightPanel::CodeView {
            editor: Self::make_file_preview_editor(resolved_path.clone(), &content, window, cx),
            path: resolved_path,
            title: SharedString::from(title),
        }
    }

    fn open_file_read_only(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        self.right_panel = self.code_view_for_path(path, window, cx);
        self.activate_right_panel_tab(RightPanelOption::Code);
        self.right_panel_mode = RightPanelMode::Artifact;
        self.preview_visible = false;
        self.web_preview = None;
    }

    fn preview_file_in_files_panel(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.right_panel = self.code_view_for_path(path, window, cx);
        self.activate_right_panel_tab(RightPanelOption::Files);
        self.right_panel_mode = RightPanelMode::Launcher;
        self.preview_visible = false;
        self.web_preview = None;
    }

    fn artifact_file_paths(&self, cx: &App) -> Vec<PathBuf> {
        let Some(thread) = self.thread.as_ref() else {
            return Vec::new();
        };

        let mut paths = IndexMap::new();
        for entry in thread.read(cx).entries() {
            let AgentThreadEntry::ToolCall(call) = entry else {
                continue;
            };
            if call.kind != acp::ToolKind::Edit {
                continue;
            }
            for location in &call.locations {
                paths.insert(location.path.clone(), ());
            }
        }
        paths.into_keys().collect()
    }

    fn show_code_artifact(&mut self, cx: &mut Context<Self>) {
        self.activate_right_panel_tab(RightPanelOption::Code);
        self.right_panel_mode = RightPanelMode::Artifact;
        self.preview_visible = false;
        self.web_preview = None;
        self.right_panel = RightPanel::CodeDiff {
            selected_path: None,
        };
        self.refresh_code_diff_files(cx);
        cx.notify();
    }

    fn refresh_code_diff_files(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.selected_folder.clone() else {
            self.code_diff_state = CodeDiffState::default();
            cx.notify();
            return;
        };

        let folder_changed = self.code_diff_state.folder.as_ref() != Some(&folder);
        self.code_diff_state.folder = Some(folder.clone());
        if folder_changed {
            self.code_diff_state.files.clear();
        }
        self.code_diff_state.loading_files = true;
        self.code_diff_state.loading_content_path = None;
        self.code_diff_state.error = None;
        self.code_diff_state.generation = self.code_diff_state.generation.saturating_add(1);
        let generation = self.code_diff_state.generation;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let folder_for_git = folder.clone();
            let files = cx
                .background_spawn(
                    async move { Self::load_git_diff_files_for_folder(&folder_for_git) },
                )
                .await;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder)
                    || this.code_diff_state.generation != generation
                {
                    return;
                }

                this.code_diff_state.loading_files = false;
                let selected_path = match files {
                    Ok(files) => {
                        this.code_diff_state.files = files;
                        this.code_diff_state.error = None;

                        let current_path = match &this.right_panel {
                            RightPanel::CodeDiff { selected_path } => selected_path.clone(),
                            _ => None,
                        };
                        let selected_path = current_path
                            .filter(|path| {
                                this.code_diff_state
                                    .files
                                    .iter()
                                    .any(|file| file.path.as_ref() == path.as_ref())
                            })
                            .or_else(|| {
                                this.code_diff_state
                                    .files
                                    .first()
                                    .map(|file| file.path.clone())
                            });

                        if let RightPanel::CodeDiff {
                            selected_path: path,
                        } = &mut this.right_panel
                        {
                            *path = selected_path.clone();
                        }
                        selected_path
                    }
                    Err(error) => {
                        this.code_diff_state.files.clear();
                        this.code_diff_state.error = Some(SharedString::from(error.to_string()));
                        None
                    }
                };

                if let Some(selected_path) = selected_path {
                    this.load_code_diff_content_for_path(selected_path, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_code_diff_content_for_path(&mut self, path: SharedString, cx: &mut Context<Self>) {
        if self.code_diff_state.loading_content_path.as_ref() == Some(&path) {
            return;
        }

        let Some(file) = self
            .code_diff_state
            .files
            .iter()
            .find(|file| file.path.as_ref() == path.as_ref())
        else {
            return;
        };
        if file.content.is_some() {
            return;
        }

        let Some(folder) = self.selected_folder.clone() else {
            return;
        };
        let status = file.status;
        let path_for_git = path.as_ref().to_string();
        self.code_diff_state.loading_content_path = Some(path);
        self.code_diff_state.content_generation =
            self.code_diff_state.content_generation.saturating_add(1);
        let generation = self.code_diff_state.content_generation;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let folder_for_git = folder.clone();
            let path_for_task = path_for_git.clone();
            let content = cx
                .background_spawn(async move {
                    Self::load_git_diff_content_for_file(&folder_for_git, &path_for_task, status)
                })
                .await;

            this.update(cx, |this, cx| {
                if this.selected_folder.as_ref() != Some(&folder)
                    || this.code_diff_state.content_generation != generation
                {
                    return;
                }

                if this
                    .code_diff_state
                    .loading_content_path
                    .as_ref()
                    .map(|path| path.as_ref())
                    == Some(path_for_git.as_str())
                {
                    this.code_diff_state.loading_content_path = None;
                }

                let content = match content {
                    Ok(content) => content,
                    Err(error) => format!("Unable to load diff for {path_for_git}: {error}"),
                };
                let parsed_file = Self::parse_git_diff_file(content.clone());
                if let Some(file) = this
                    .code_diff_state
                    .files
                    .iter_mut()
                    .find(|file| file.path.as_ref() == path_for_git)
                {
                    if let Some(parsed_file) = parsed_file {
                        file.old_path = parsed_file.old_path;
                        file.status = parsed_file.status;
                        file.additions = parsed_file.additions;
                        file.deletions = parsed_file.deletions;
                    }
                    file.content = Some(SharedString::from(content));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn cancel_running_task(&mut self, cx: &mut Context<Self>) {
        if let Some(thread_id) = self.active_conversation_thread_id(cx)
            && let Some(panel) = self
                .workspace
                .upgrade()
                .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
        {
            let canceled = panel.update(cx, |panel, cx| panel.cancel_thread(&thread_id, cx));
            if canceled {
                self.is_agent_running = false;
                self.agent_finished = true;
                cx.notify();
                return;
            }
        }

        let Some(thread) = self.thread.clone() else {
            return;
        };
        let task = thread.update(cx, |t, cx| t.cancel(cx));
        self._tasks.push(cx.spawn(async move |_this, _cx| {
            task.await;
        }));
        self.is_agent_running = false;
        self.agent_finished = true;
        cx.notify();
    }

    fn close_active_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(next_ix) = self
            .background_sessions
            .iter()
            .position(|session| matches!(session.state, BeginnerState::ActiveProject))
        else {
            // Last tab — reset to landing rather than closing the window.
            self.new_project(window, cx);
            return;
        };

        // Bring a real project session forward, then discard the old active.
        self.switch_to_session(next_ix, window, cx);
        self.background_sessions.remove(next_ix);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn close_background_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.background_sessions.len() {
            self.background_sessions.remove(ix);
            self.save_open_tabs(cx);
            cx.notify();
        }
    }

    fn go_home(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, BeginnerState::Landing) {
            return;
        }
        self.stash_current_session_and_reset(window, cx);
    }

    fn apply_suggested_prompt(
        &mut self,
        prompt: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_text(prompt, window, cx);
        });
        cx.notify();
    }

    fn set_chat_mode(&mut self, mode: ChatMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.chat_mode == mode {
            return;
        }
        self.chat_mode = mode;
        let placeholder = if matches!(self.state, BeginnerState::ActiveProject) {
            mode.follow_up_placeholder()
        } else {
            mode.placeholder()
        };
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(placeholder, window, cx);
        });
        if self
            .workspace
            .upgrade()
            .and_then(|workspace| workspace.read(cx).panel::<AgentPanel>(cx))
            .and_then(|panel| {
                panel
                    .read(cx)
                    .active_backboard_workspace_draft_thread_id(cx)
            })
            .is_some()
        {
            self.discard_simple_agent_draft(window, cx);
            self.ensure_composer_thread(window, cx);
        }
        self.sync_thread_prompt_prefix(cx);
        cx.notify();
    }

    fn artifact_title(&self) -> SharedString {
        let title = self.tab_name.as_ref().trim();
        if !title.is_empty() && title != "Home" {
            return self.tab_name.clone();
        }

        self.selected_folder
            .as_ref()
            .and_then(|folder| folder.file_name())
            .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| SharedString::from("Landing Page"))
    }

    #[allow(dead_code)]
    pub fn switch_to_editor(&mut self, cx: &mut Context<Self>) {
        persist_experience_level(ExperienceLevel::Developer, cx);
        cx.emit(BeginnerWorkspaceEvent::SwitchToEditor);
    }

    fn open_web_app_if_present(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.selected_folder.clone() else {
            return;
        };

        self.reset_all_preview_state();
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);

        for candidate in Self::preview_candidate_dirs(&root, 2) {
            if let Some(command) = Self::package_preview_command(&candidate, SIMPLE_PREVIEW_PORT) {
                self.start_preview_server(
                    PreviewLaunch {
                        folder: candidate,
                        command,
                        url_path: "/".to_string(),
                    },
                    cx,
                );
                return;
            }
        }

        // Static HTML fallback — make it available from the chat Preview button.
        if let Some(html_path) = Self::static_preview_html_path(&root) {
            self.start_static_preview_server(html_path, cx);
            return;
        }
        self.is_preview_generating = false;
        cx.notify();
    }

    fn preview_candidate_dirs(root: &Path, max_depth: usize) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let mut dirs = vec![(root.to_path_buf(), 0usize)];

        while let Some((dir, depth)) = dirs.pop() {
            candidates.push(dir.clone());
            if depth >= max_depth {
                continue;
            }

            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut child_dirs = read_dir
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .filter(|path| {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    name != "node_modules"
                        && name != "target"
                        && name != "dist"
                        && name != "build"
                        && !name.starts_with('.')
                })
                .collect::<Vec<_>>();
            child_dirs.sort();
            for child in child_dirs.into_iter().rev() {
                dirs.push((child, depth + 1));
            }
        }

        candidates
    }

    fn package_preview_command(folder: &Path, port: u16) -> Option<String> {
        let package_json = folder.join("package.json");
        let package = std::fs::read_to_string(package_json).ok()?;
        let package: serde_json::Value = serde_json::from_str(&package).ok()?;
        let scripts = package
            .get("scripts")
            .and_then(|scripts| scripts.as_object());
        let (pkg_manager, install_cmd) = Self::package_manager_commands(folder);
        let install_if_needed = format!("if [ ! -d node_modules ]; then {install_cmd}; fi");

        if let Some(scripts) = scripts {
            for script_name in ["dev", "start", "serve", "preview"] {
                let Some(script_body) = scripts.get(script_name).and_then(|script| script.as_str())
                else {
                    continue;
                };
                let args = Self::preview_script_args(script_body, port);
                let run = Self::package_run_command(pkg_manager, script_name, &args);
                return Some(format!("{install_if_needed} && {run}"));
            }
        }

        if Self::package_has_dependency(&package, "next") {
            return Some(format!(
                "{install_if_needed} && {}",
                Self::package_exec_command(
                    pkg_manager,
                    &format!("next dev -H 127.0.0.1 -p {port}")
                )
            ));
        }
        if Self::package_has_dependency(&package, "vite") {
            return Some(format!(
                "{install_if_needed} && {}",
                Self::package_exec_command(
                    pkg_manager,
                    &format!("vite --host 127.0.0.1 --port {port}")
                )
            ));
        }

        None
    }

    fn package_manager_commands(folder: &Path) -> (&'static str, &'static str) {
        if folder.join("pnpm-lock.yaml").exists() {
            ("pnpm", "pnpm install")
        } else if folder.join("bun.lockb").exists() || folder.join("bun.lock").exists() {
            ("bun", "bun install")
        } else if folder.join("yarn.lock").exists() {
            ("yarn", "yarn install")
        } else {
            ("npm", "npm install")
        }
    }

    fn package_run_command(pkg_manager: &str, script_name: &str, args: &str) -> String {
        match pkg_manager {
            "yarn" => format!("yarn run {script_name}{args}"),
            "pnpm" => format!("pnpm run {script_name}{args}"),
            "bun" => format!("bun run {script_name}{args}"),
            _ => format!("npm run {script_name}{args}"),
        }
    }

    fn package_exec_command(pkg_manager: &str, command: &str) -> String {
        match pkg_manager {
            "pnpm" => format!("pnpm exec {command}"),
            "bun" => format!("bunx {command}"),
            "yarn" => format!("yarn {command}"),
            _ => format!("npx {command}"),
        }
    }

    fn preview_script_args(script_body: &str, port: u16) -> String {
        let lower = script_body.to_lowercase();
        if lower.contains("react-scripts") {
            String::new()
        } else if lower.contains("next") {
            format!(" -- -H 127.0.0.1 -p {port}")
        } else if lower.contains("vite")
            || lower.contains("astro")
            || lower.contains("svelte")
            || lower.contains("webpack")
            || lower.contains("parcel")
        {
            format!(" -- --host 127.0.0.1 --port {port}")
        } else {
            format!(" -- --port {port}")
        }
    }

    fn package_has_dependency(package: &serde_json::Value, dependency: &str) -> bool {
        ["dependencies", "devDependencies", "peerDependencies"]
            .into_iter()
            .any(|section| {
                package
                    .get(section)
                    .and_then(|deps| deps.as_object())
                    .is_some_and(|deps| deps.contains_key(dependency))
            })
    }

    fn static_preview_html_path(root: &Path) -> Option<PathBuf> {
        let mut dirs = vec![(root.to_path_buf(), 0usize)];
        let mut first_html = None;

        while let Some((dir, depth)) = dirs.pop() {
            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries = read_dir
                .flatten()
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            entries.sort();

            for path in entries {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if path.is_dir() {
                    if depth < 2
                        && name != "node_modules"
                        && name != "target"
                        && !name.starts_with('.')
                    {
                        dirs.push((path, depth + 1));
                    }
                    continue;
                }

                let is_html = path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
                if !is_html {
                    continue;
                }

                if name.eq_ignore_ascii_case("index.html") {
                    return Some(path);
                }
                first_html.get_or_insert(path);
            }
        }

        first_html
    }

    fn start_static_preview_server(&mut self, html_path: PathBuf, cx: &mut Context<Self>) {
        let folder = html_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.selected_folder.clone().unwrap_or_default());
        let file_name = html_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "index.html".to_string());
        let url_path = if file_name.eq_ignore_ascii_case("index.html") {
            "/".to_string()
        } else {
            format!("/{}", Self::url_path_segment(&file_name))
        };
        let default_path = serde_json::to_string(&format!("/{file_name}"))
            .unwrap_or_else(|_| "\"/index.html\"".to_string());
        let node_script = format!(
            "const http=require('http'),fs=require('fs'),path=require('path');\
const root=process.cwd();\
const types={{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon'}};\
http.createServer((req,res)=>{{\
let url=(req.url||'/').split('?')[0];\
let pathname=url==='/'?{}:url;\
let decoded;try{{decoded=decodeURIComponent(pathname)}}catch{{decoded={}}}\
let file=path.normalize(path.join(root,decoded));\
if(!file.startsWith(root)){{res.writeHead(403);res.end('Forbidden');return;}}\
fs.readFile(file,(err,data)=>{{\
if(err){{res.writeHead(404);res.end('Not found');return;}}\
res.writeHead(200,{{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream'}});\
res.end(data);\
}});\
}}).listen({},'127.0.0.1');",
            default_path, default_path, SIMPLE_PREVIEW_PORT
        );
        let command = format!(
            "if command -v python3 >/dev/null 2>&1; then python3 -m http.server {} --bind 127.0.0.1; elif command -v node >/dev/null 2>&1; then node -e {}; else python -m http.server {}; fi",
            SIMPLE_PREVIEW_PORT,
            Self::shell_quote(&node_script),
            SIMPLE_PREVIEW_PORT
        );

        self.start_preview_server(
            PreviewLaunch {
                folder,
                command,
                url_path,
            },
            cx,
        );
    }

    fn url_path_segment(segment: &str) -> String {
        let mut encoded = String::new();
        for byte in segment.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    fn reset_all_preview_state(&mut self) {
        self.clear_current_preview_state();

        for session in &mut self.background_sessions {
            session.preview_url = None;
            session.preview_visible = false;
            session.is_preview_generating = false;
            session.web_preview = None;
            session.dev_server_port = None;
            session.dev_server_task = None;
        }
    }

    fn clear_current_preview_state(&mut self) {
        self.preview_url = None;
        self.preview_visible = false;
        self.is_preview_generating = false;
        self.web_preview = None;
        self.dev_server_port = None;
        self.dev_server_task = None;
    }

    fn kill_preview_port(port: u16) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "lsof -ti :{port} | xargs kill -9 2>/dev/null; true"
                ))
                .status()
                .ok();
        }

        #[cfg(target_os = "windows")]
        {
            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
                    ),
                ])
                .status()
                .ok();
        }
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn shell_quote_path(path: &Path) -> String {
        Self::shell_quote(&path.to_string_lossy())
    }

    fn is_http_preview_ready(port: u16) -> bool {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) =
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(350))
        else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(700)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(350)));
        let request =
            format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        if std::io::Write::write_all(&mut stream, request.as_bytes()).is_err() {
            return false;
        }
        let mut response = [0u8; 512];
        let Ok(bytes_read) = std::io::Read::read(&mut stream, &mut response) else {
            return false;
        };
        if bytes_read == 0 {
            return false;
        }
        let response = String::from_utf8_lossy(&response[..bytes_read]);
        let Some(status) = response
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
        else {
            return false;
        };
        (200..400).contains(&status)
    }

    fn start_preview_server(&mut self, launch: PreviewLaunch, cx: &mut Context<Self>) {
        let port = SIMPLE_PREVIEW_PORT;
        let url = format!("http://localhost:{port}{}", launch.url_path);
        let browser_tab_active = self.active_right_panel_tab == Some(RightPanelOption::Design);
        self.dev_server_port = Some(port);
        self.preview_url = Some(url.clone());
        self.preview_visible = browser_tab_active;
        self.is_preview_generating = true;
        self.web_preview = None;
        cx.notify();

        let task = cx.spawn(async move |this, cx| {
            Self::kill_preview_port(port);
            cx.background_executor()
                .timer(std::time::Duration::from_millis(400))
                .await;

            // Use the interactive login shell so ~/.zshrc / ~/.bashrc are sourced —
            // this makes nvm, Homebrew, mise, etc. available even from a GUI app launch.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let folder_arg = Self::shell_quote_path(&launch.folder);
            let dev_cmd = format!("cd {folder_arg} && {}", launch.command);

            let spawned = std::process::Command::new(&shell)
                .args(["-i", "-l", "-c", &dev_cmd])
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                .env("HOSTNAME", "127.0.0.1")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok();

            if !spawned {
                this.update(cx, |this, cx| {
                    this.is_preview_generating = false;
                    this.preview_visible = false;
                    this.preview_url = None;
                    this.dev_server_port = None;
                    cx.notify();
                })
                .ok();
                return;
            }

            // Poll until the app serves an HTTP page. A bare TCP connection can
            // open before the dev server is actually ready to render.
            for _ in 0..180 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(500))
                    .await;
                if Self::is_http_preview_ready(port) {
                    let url = url.clone();
                    this.update(cx, |this, cx| {
                        let browser_tab_active =
                            this.active_right_panel_tab == Some(RightPanelOption::Design);
                        this.web_preview = None;
                        this.right_panel = RightPanel::Preview;
                        this.right_panel_mode = RightPanelMode::Artifact;
                        this.preview_visible = browser_tab_active;
                        this.is_preview_generating = false;
                        this.preview_url = Some(url);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            }
            this.update(cx, |this, cx| {
                this.is_preview_generating = false;
                this.preview_visible = false;
                this.preview_url = None;
                this.dev_server_port = None;
                cx.notify();
            })
            .ok();
        });
        // Replace any previous polling task — dropping the old one cancels it.
        self.dev_server_task = Some(task);
    }

    #[allow(dead_code)]
    fn new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.pending_similar_project_confirmation = None;
        self.state = BeginnerState::Landing;
        self.active_chat_record_id = None;
        self.selected_folder = None;
        self.clear_composer_git_state();
        self.file_changes_panel = None;
        self.chat_feed = None;
        self.thread = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.show_raw_files = false;
        self.right_panel = RightPanel::Preview;
        self.code_diff_state = CodeDiffState::default();
        self.right_panel_open = false;
        self.right_panel_closing = false;
        self.right_panel_expanded = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.reset_right_panel_tabs();
        self.share_dialog_open = false;
        self.clear_current_preview_state();
        self.bottom_panel_open = false;
        self.bottom_panel_closing = false;
        self.bottom_panel_animation_generation = 0;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.right_terminal_view = None;
        self.right_terminal_working_directory = None;
        self.chat_mode = ChatMode::Build;
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, self.chat_mode.placeholder());
        let (browser_address_editor, browser_enter_sub) =
            Self::make_browser_address_editor(window, cx);
        self.chat_editor = chat_editor;
        self.browser_address_editor = browser_address_editor;
        self.session_subscriptions.clear();
        self.session_subscriptions.push(enter_sub);
        self.session_subscriptions.push(browser_enter_sub);
        self.save_open_tabs(cx);
        cx.notify();
    }

    fn open_chat_record(
        &mut self,
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_chat_record_id.as_deref() == Some(record.id.as_str()) {
            self.restore_active_chat_if_needed(window, cx);
            self.save_open_tabs(cx);
            cx.notify();
            return;
        }

        if let Some(ix) = self
            .background_sessions
            .iter()
            .position(|session| session.chat_record_id.as_deref() == Some(record.id.as_str()))
        {
            self.switch_to_session(ix, window, cx);
            self.save_open_tabs(cx);
            return;
        }

        let active_is_empty_landing = matches!(self.state, BeginnerState::Landing)
            && self.thread.is_none()
            && self.pending_conversation_view.is_none()
            && self.chat_editor.read(cx).text(cx).trim().is_empty();
        if !active_is_empty_landing {
            self.stash_current_session_and_reset(window, cx);
        }

        self.open_chat_record_in_place(record, window, cx);
        self.save_open_tabs(cx);
    }

    fn open_chat_record_in_place(
        &mut self,
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path = record.folder();
        let chat_name = SharedString::from(record.name.clone());
        self.reset_current_session_for_record(window, cx);
        self.active_chat_record_id = Some(record.id.clone());
        self.selected_folder = Some(path.clone());
        self.open_folder_as_worktree(path.clone(), window, cx);
        self.refresh_composer_git_state_if_needed(cx);
        self.tab_name = chat_name.clone();
        self.state = BeginnerState::ActiveProject;
        self.chat_mode = ChatMode::Build;
        self.chat_editor.update(cx, |editor, cx| {
            editor.set_placeholder_text(self.chat_mode.follow_up_placeholder(), window, cx);
        });
        self.restore_thread_for_folder(record.clone(), path.clone(), window, cx);
        cx.notify();
    }

    fn reset_current_session_for_record(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        Self::kill_preview_port(SIMPLE_PREVIEW_PORT);
        self.pending_similar_project_confirmation = None;
        self.chat_mode = ChatMode::Build;
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, self.chat_mode.placeholder());
        self.chat_editor = chat_editor;
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.queued_composer_submit = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        self.show_raw_files = false;
        self.raw_browse_path = None;
        self.right_panel = RightPanel::Preview;
        self.code_diff_state = CodeDiffState::default();
        self.right_panel_open = false;
        self.right_panel_closing = false;
        self.right_panel_expanded = false;
        self.right_panel_mode = RightPanelMode::Artifact;
        self.right_panel_option = RightPanelOption::Files;
        self.reset_right_panel_tabs();
        self.share_dialog_open = false;
        self.clear_current_preview_state();
        self.bottom_panel_open = false;
        self.bottom_panel_closing = false;
        self.bottom_panel_animation_generation = 0;
        self.terminal_view = None;
        self.terminal_working_directory = None;
        self.right_terminal_view = None;
        self.right_terminal_working_directory = None;
        self.session_subscriptions.clear();
        self.session_subscriptions.push(enter_sub);
        let (browser_address_editor, browser_enter_sub) =
            Self::make_browser_address_editor(window, cx);
        self.browser_address_editor = browser_address_editor;
        self.session_subscriptions.push(browser_enter_sub);
    }

    fn restore_active_chat_if_needed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(thread) = self.thread.clone() {
            self.restore_preview_for_thread_if_present(&thread, cx);
            return;
        }
        if self.pending_conversation_view.is_some() {
            return;
        }
        let Some(record_id) = self.active_chat_record_id.clone() else {
            return;
        };
        let Some(record) = self
            .chat_history
            .iter()
            .find(|record| record.id == record_id)
            .cloned()
        else {
            return;
        };
        self.restore_thread_for_folder(record.clone(), record.folder(), window, cx);
    }

    fn restore_thread_for_folder(
        &mut self,
        record: BeginnerChatRecord,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let Some(agent_panel) = workspace.read(cx).panel::<AgentPanel>(cx) else {
            return;
        };
        let Some(store) = ThreadMetadataStore::try_global(cx) else {
            return;
        };

        let path_list = PathList::new(&[path.clone()]);
        let store_ref = store.read(cx);
        let metadata = record
            .session_id
            .as_ref()
            .and_then(|sid| {
                let session = acp::SessionId::new(sid.clone());
                store_ref.entry_by_session(&session)
            })
            .or_else(|| {
                store_ref
                    .entries_for_path(&path_list, None)
                    .chain(store_ref.entries_for_main_worktree_path(&path_list, None))
                    .max_by_key(|entry| entry.updated_at)
            })
            .or_else(|| {
                // Fallback for legacy history rows where folder path matching is unreliable.
                store_ref
                    .entries()
                    .filter(|entry| entry.display_title() == self.tab_name)
                    .max_by_key(|entry| entry.updated_at)
            });

        let Some(metadata) = metadata else {
            return;
        };

        let thread_id = metadata.thread_id;
        let work_dirs = Some(path_list);
        self.open_folder_as_worktree(path.clone(), window, cx);
        let options = BackboardAgentWorkspaceChatOptions {
            mode: self.chat_mode.agent_workspace_mode(),
            work_dirs,
            focus: false,
            source: "beginner_ui",
            suppress_notifications: true,
        };
        let conversation_view = agent_panel.update(cx, |panel, cx| {
            panel.open_backboard_workspace_chat_from_thread_id(thread_id, options, window, cx)
        });
        self.thread = None;
        self.chat_feed = None;
        self.file_changes_panel = None;
        self.pending_conversation_view = None;
        self.active_conversation_view = None;
        self.model_selector = None;
        self.is_agent_running = false;
        self.agent_finished = false;
        if let Some(conversation_view) = conversation_view {
            self.bind_conversation_view(conversation_view.clone(), window, cx);
            self.schedule_restore_timeout(conversation_view, cx);
        }
    }

    fn restore_preview_for_thread_if_present(
        &mut self,
        thread: &Entity<AcpThread>,
        cx: &mut Context<Self>,
    ) {
        if self.restore_preview_url_from_thread(thread, cx) {
            return;
        }

        if self.preview_url.is_some() || self.is_preview_generating {
            return;
        }

        let has_artifact_work = thread.read(cx).entries().iter().any(|entry| match entry {
            AgentThreadEntry::ToolCall(call) => {
                matches!(call.kind, acp::ToolKind::Edit | acp::ToolKind::Execute)
            }
            _ => false,
        });
        if !has_artifact_work {
            return;
        }

        self.open_web_app_if_present(cx);
    }

    fn restore_preview_url_from_thread(
        &mut self,
        thread: &Entity<AcpThread>,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(url) = Self::preview_url_from_thread(thread, cx) else {
            return false;
        };

        let url_changed = self.preview_url.as_deref() != Some(url.as_str());
        self.preview_url = Some(url.clone());
        self.preview_visible = self.active_right_panel_tab == Some(RightPanelOption::Design);
        self.is_preview_generating = false;
        self.dev_server_port = None;
        self.dev_server_task = None;
        if url_changed {
            self.web_preview = None;
        }
        cx.notify();
        true
    }

    fn preview_url_from_thread(thread: &Entity<AcpThread>, cx: &App) -> Option<String> {
        thread.read(cx).entries().iter().rev().find_map(|entry| {
            let AgentThreadEntry::AssistantMessage(message) = entry else {
                return None;
            };
            message.chunks.iter().rev().find_map(|chunk| {
                let AssistantMessageChunk::Message { block } = chunk else {
                    return None;
                };
                Self::preview_url_from_text(block.to_markdown(cx))
            })
        })
    }

    fn preview_url_from_text(text: &str) -> Option<String> {
        for (start, _) in text.char_indices() {
            let candidate = text.get(start..)?;
            if !Self::starts_with_preview_url_prefix(candidate) {
                continue;
            }

            let end = candidate
                .char_indices()
                .find_map(|(index, character)| {
                    (index > 0 && Self::is_preview_url_hard_delimiter(character)).then_some(index)
                })
                .unwrap_or(candidate.len());
            let candidate = &candidate[..end];
            if let Some(url) = Self::loopback_preview_url_from_candidate(candidate) {
                return Some(url);
            }
        }

        None
    }

    fn starts_with_preview_url_prefix(candidate: &str) -> bool {
        let lower = candidate.to_lowercase();
        lower.starts_with("http://localhost")
            || lower.starts_with("https://localhost")
            || lower.starts_with("http://127.")
            || lower.starts_with("https://127.")
            || lower.starts_with("http://[::1]")
            || lower.starts_with("https://[::1]")
            || lower.starts_with("localhost:")
            || lower.starts_with("127.")
            || lower.starts_with("[::1]:")
    }

    fn is_preview_url_hard_delimiter(character: char) -> bool {
        character.is_whitespace() || matches!(character, '<' | '>' | '"' | '\'' | '`')
    }

    fn loopback_preview_url_from_candidate(candidate: &str) -> Option<String> {
        let candidate = Self::trim_preview_url_candidate(candidate);
        let url = Self::normalize_browser_url(candidate.to_string())?;
        Self::is_loopback_http_url(&url).then_some(url)
    }

    fn trim_preview_url_candidate(candidate: &str) -> &str {
        let lower = candidate.to_lowercase();
        let host_bracket_end = if lower.starts_with("http://[")
            || lower.starts_with("https://[")
            || lower.starts_with("[")
        {
            candidate.find(']').map(|index| index + 1).unwrap_or(0)
        } else {
            0
        };

        let mut candidate = if let Some(index) = candidate
            .get(host_bracket_end..)
            .and_then(|suffix| suffix.find(']').map(|index| host_bracket_end + index))
        {
            &candidate[..index]
        } else {
            candidate
        };

        candidate = candidate.trim_end_matches(|character| {
            matches!(character, '.' | ',' | ';' | ':' | '!' | '?' | ')' | '}')
        });
        candidate
    }

    fn is_loopback_http_url(url: &str) -> bool {
        let Some(rest) = Self::strip_http_scheme(url) else {
            return false;
        };

        let Some((host, after_host)) = Self::split_url_host(rest) else {
            return false;
        };
        if !Self::is_loopback_host(host) {
            return false;
        }

        if after_host.is_empty() {
            return true;
        }

        match after_host.chars().next() {
            Some(':') => {
                let port_end = after_host[1..]
                    .char_indices()
                    .find_map(|(index, character)| {
                        (!character.is_ascii_digit()).then_some(index + 1)
                    })
                    .unwrap_or(after_host.len());
                if port_end == 1 {
                    return false;
                }
                after_host.get(port_end..).is_some_and(|after_port| {
                    after_port.is_empty()
                        || matches!(after_port.chars().next(), Some('/' | '?' | '#'))
                })
            }
            Some('/' | '?' | '#') => true,
            _ => false,
        }
    }

    fn strip_http_scheme(url: &str) -> Option<&str> {
        const HTTP: &str = "http://";
        const HTTPS: &str = "https://";

        if url
            .get(..HTTP.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(HTTP))
        {
            url.get(HTTP.len()..)
        } else if url
            .get(..HTTPS.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(HTTPS))
        {
            url.get(HTTPS.len()..)
        } else {
            None
        }
    }

    fn split_url_host(rest: &str) -> Option<(&str, &str)> {
        if rest.starts_with('[') {
            let host_end = rest.find(']')? + 1;
            return Some((&rest[..host_end], &rest[host_end..]));
        }

        let host_end = rest
            .char_indices()
            .find_map(|(index, character)| {
                matches!(character, ':' | '/' | '?' | '#').then_some(index)
            })
            .unwrap_or(rest.len());
        if host_end == 0 {
            return None;
        }
        Some((&rest[..host_end], &rest[host_end..]))
    }

    fn is_loopback_host(host: &str) -> bool {
        host.eq_ignore_ascii_case("localhost")
            || host == "[::1]"
            || host
                .parse::<std::net::Ipv4Addr>()
                .is_ok_and(|address| address.octets()[0] == 127)
    }

    fn refresh_live_preview_after_tool_update(
        &mut self,
        thread: &Entity<AcpThread>,
        entry_index: usize,
        cx: &mut Context<Self>,
    ) {
        if self.preview_url.is_none() {
            return;
        }

        let should_refresh = thread
            .read(cx)
            .entries()
            .get(entry_index)
            .is_some_and(|entry| match entry {
                AgentThreadEntry::ToolCall(call) => {
                    matches!(call.status, ToolCallStatus::Completed)
                        && matches!(
                            call.kind,
                            acp::ToolKind::Edit
                                | acp::ToolKind::Delete
                                | acp::ToolKind::Move
                                | acp::ToolKind::Execute
                        )
                }
                _ => false,
            });

        if should_refresh {
            self.web_preview = None;
            cx.notify();
        }
    }

    fn bind_conversation_view(
        &mut self,
        conversation_view: Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_conversation_view = Some(conversation_view.clone());
        let cv_sub = cx.observe_in(&conversation_view, window, |this, cv, window, cx| {
            this.handle_conversation_view_update(&cv, window, cx);
        });
        self.session_subscriptions.push(cv_sub);
        self.handle_conversation_view_update(&conversation_view, window, cx);
    }

    fn handle_conversation_view_update(
        &mut self,
        conversation_view: &Entity<ConversationView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (is_loading, root_thread) = {
            let cv_ref = conversation_view.read(cx);
            (cv_ref.is_loading(), cv_ref.root_thread(cx))
        };

        if self.thread.is_some() {
            return;
        }

        if let Some(thread) = root_thread {
            let thread_sub = cx.subscribe(&thread, |this, thread_entity, event, cx| match event {
                AcpThreadEvent::Stopped(_) => {
                    this.is_agent_running = false;
                    this.agent_finished = true;
                    let restored_preview_url =
                        this.restore_preview_url_from_thread(&thread_entity, cx);
                    if !restored_preview_url && this.preview_url.is_none() {
                        this.open_web_app_if_present(cx);
                    } else if !restored_preview_url {
                        this.web_preview = None;
                    }
                    cx.notify();
                }
                AcpThreadEvent::NewEntry => {
                    this.is_agent_running = thread_entity.read(cx).status() != ThreadStatus::Idle;
                    this.restore_preview_for_thread_if_present(&thread_entity, cx);
                    cx.notify();
                }
                AcpThreadEvent::EntryUpdated(entry_index) => {
                    this.is_agent_running = thread_entity.read(cx).status() != ThreadStatus::Idle;
                    this.restore_preview_for_thread_if_present(&thread_entity, cx);
                    this.refresh_live_preview_after_tool_update(&thread_entity, *entry_index, cx);
                    cx.notify();
                }
                AcpThreadEvent::Error => {
                    this.is_agent_running = false;
                    this.agent_finished = false;
                    cx.notify();
                }
                AcpThreadEvent::ToolAuthorizationRequested(tool_call_id) => {
                    let outcome =
                        thread_entity
                            .read(cx)
                            .tool_call(tool_call_id)
                            .and_then(|(_, call)| {
                                if let ToolCallStatus::WaitingForConfirmation { options, .. } =
                                    &call.status
                                {
                                    let option = options.first_option_of_kind(
                                        acp::PermissionOptionKind::AllowOnce,
                                    )?;
                                    Some(SelectedPermissionOutcome::new(
                                        option.option_id.clone(),
                                        option.kind,
                                    ))
                                } else {
                                    None
                                }
                            });
                    if let Some(outcome) = outcome {
                        let id = tool_call_id.clone();
                        thread_entity.update(cx, |t, cx| {
                            t.authorize_tool_call(id, outcome, cx);
                        });
                    }
                }
                _ => {}
            });
            self.session_subscriptions.push(thread_sub);
            if let Some(folder) = self.selected_folder.clone() {
                thread.update(cx, |thread, cx| {
                    thread.set_work_dirs(PathList::new(&[folder]), cx);
                });
            }
            let artifact_title = self.artifact_title();
            let feed =
                cx.new(|cx| BeginnerChatFeed::new(thread.clone(), artifact_title.clone(), cx));
            feed.update(cx, |feed, cx| {
                feed.set_display_mode(self.chat_feed_display_mode, cx);
            });
            let feed_sub = cx.subscribe_in(&feed, window, |bw, _, event, window, cx| {
                bw.handle_chat_feed_event(event, window, cx);
            });
            self.session_subscriptions.push(feed_sub);
            self.chat_feed = Some(feed);
            let file_panel = cx.new(|cx| FileChangesPanel::new(thread.clone(), cx));
            let file_sub = cx.subscribe_in(&file_panel, window, |bw, _, event, window, cx| {
                bw.handle_file_panel_event(event, window, cx);
            });
            self.session_subscriptions.push(file_sub);
            self.file_changes_panel = Some(file_panel);
            self.thread = Some(thread.clone());
            if let Some(folder) = self.selected_folder.clone() {
                let sid = thread.read(cx).session_id().0.to_string();
                self.update_latest_chat_record_session_id(&folder, sid, cx);
            }
            self.restore_preview_for_thread_if_present(&thread, cx);
            self.active_conversation_view = self.pending_conversation_view.take();
            if let Some(conversation_view) = self.active_conversation_view.as_ref() {
                self.configure_thread_composer(conversation_view, window, cx);
            }
            self.model_selector = self
                .active_conversation_view
                .as_ref()
                .and_then(|cv_entity| {
                    cv_entity.update(cx, |cv_ref, cx| {
                        cv_ref.make_root_model_selector_wrapped(
                            |inner| {
                                Rc::new(CuratedModelSelector { inner })
                                    as Rc<dyn AgentModelSelector>
                            },
                            window,
                            cx,
                        )
                    })
                });
            if let Some(model_selector) = self.model_selector.as_ref() {
                model_selector.update(cx, |model_selector, _cx| {
                    model_selector.set_trigger_brand(SharedString::from(""), None);
                });
            }
            // Replace the thread view's model selector with the curated one so the
            // embedded editor picker shows only the simple-mode model list.
            let curated_selector = self.model_selector.clone();
            if let Some(cv_entity) = self.active_conversation_view.as_ref() {
                cv_entity.update(cx, |cv, cx| {
                    if let Some(thread_view) = cv.root_thread_view() {
                        thread_view.update(cx, |thread_view, _cx| {
                            thread_view.model_selector = curated_selector;
                        });
                    }
                });
            }
            self.send_queued_composer_submit(window, cx);
            cx.notify();
        } else if !is_loading {
            self.is_agent_running = false;
            self.pending_conversation_view = None;
            self.active_conversation_view = None;
            self.queued_composer_submit = None;
            cx.notify();
        }
    }

    fn send_queued_composer_submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.queued_composer_submit.take() else {
            return;
        };

        let Some(conversation_view) = self.active_conversation_view.clone() else {
            self.queued_composer_submit = Some(text);
            if self.pending_conversation_view.is_none() {
                self.is_agent_running = false;
                cx.notify();
            }
            return;
        };

        self.send_conversation_message_after_model_check(conversation_view, text, window, cx);
    }

    fn send_conversation_message_after_model_check(
        &mut self,
        conversation_view: Entity<ConversationView>,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selector = self
            .thread
            .as_ref()
            .and_then(|thread| {
                let thread = thread.read(cx);
                thread.connection().model_selector(thread.session_id())
            })
            .map(|inner| Rc::new(CuratedModelSelector { inner }) as Rc<dyn AgentModelSelector>);

        cx.spawn_in(window, async move |_this, cx| {
            if let Some(selector) = selector {
                match cx
                    .update(|_window, cx| ensure_selected_simple_model_is_supported(selector, cx))
                {
                    Ok(task) => {
                        task.await.log_err();
                    }
                    Err(error) => {
                        log::warn!("failed to validate simple mode model selection: {error:#}");
                    }
                }
            }

            conversation_view
                .update_in(cx, |conversation_view, window, cx| {
                    conversation_view.seed_root_message_text_if_empty(text, window, cx);
                    conversation_view.send_root_message_editor_without_before_send_hook(window, cx);
                })
                .ok();
        })
        .detach();
    }

    fn schedule_restore_timeout(
        &mut self,
        conversation_view: Entity<ConversationView>,
        cx: &mut Context<Self>,
    ) {
        let pending_id = conversation_view.entity_id();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(8))
                .await;
            this.update(cx, |this, cx| {
                let still_pending = this
                    .pending_conversation_view
                    .as_ref()
                    .is_some_and(|view| view.entity_id() == pending_id);
                if this.thread.is_none() && still_pending {
                    this.is_agent_running = false;
                    this.pending_conversation_view = None;
                    this.active_conversation_view = None;
                    this.queued_composer_submit = None;
                    this.chat_feed = None;
                    this.file_changes_panel = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn make_session_for_record(
        record: BeginnerChatRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ProjectSession {
        let (chat_editor, enter_sub) =
            Self::make_chat_editor(window, cx, ChatMode::Build.placeholder());
        let (browser_address_editor, browser_enter_sub) =
            Self::make_browser_address_editor(window, cx);
        let folder = record.folder();
        ProjectSession {
            chat_record_id: Some(record.id.clone()),
            state: BeginnerState::ActiveProject,
            tab_name: SharedString::from(record.name.clone()),
            chat_mode: ChatMode::Build,
            chat_feed_display_mode: ChatFeedDisplayMode::LiveWork,
            chat_editor,
            browser_address_editor,
            selected_folder: Some(folder),
            thread: None,
            pending_conversation_view: None,
            active_conversation_view: None,
            queued_composer_submit: None,
            model_selector: None,
            is_agent_running: false,
            agent_finished: false,
            chat_feed: None,
            file_changes_panel: None,
            left_tab: LeftTab::Files,
            show_raw_files: false,
            raw_browse_path: None,
            right_panel: RightPanel::Preview,
            code_diff_state: CodeDiffState::default(),
            right_panel_open: false,
            right_panel_closing: false,
            right_panel_expanded: false,
            right_panel_animation_generation: 0,
            right_panel_mode: RightPanelMode::Artifact,
            right_panel_option: RightPanelOption::Files,
            right_panel_tabs: Vec::new(),
            active_right_panel_tab: None,
            right_panel_dock: SimplePanelDock::Right,
            right_panel_height: px(DOCKED_PANEL_DEFAULT_HEIGHT_PX),
            bottom_panel_open: false,
            bottom_panel_closing: false,
            bottom_panel_animation_generation: 0,
            share_dialog_open: false,
            preview_url: None,
            preview_visible: false,
            is_preview_generating: false,
            terminal_view: None,
            terminal_working_directory: None,
            right_terminal_view: None,
            right_terminal_working_directory: None,
            dev_server_port: None,
            web_preview: None,
            dev_server_task: None,
            subscriptions: vec![enter_sub, browser_enter_sub],
        }
    }

    fn restore_persisted_open_tabs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open_tabs_restored || !self.open_tabs_loaded {
            return;
        }
        self.open_tabs_restored = true;

        let Some(open_tabs) = self.pending_open_tabs.take() else {
            return;
        };

        let simple_mode_was_opened = SIMPLE_MODE_OPENED_THIS_PROCESS.swap(true, Ordering::AcqRel);
        if !matches!(self.state, BeginnerState::Landing) || !self.background_sessions.is_empty() {
            self.save_open_tabs(cx);
            return;
        }

        // The first Simple Mode entry in an app session should land on Home.
        // If the user later closes/reopens Simple Mode in the same session, restore
        // the chats they explicitly opened.
        if !simple_mode_was_opened {
            self.save_open_tabs(cx);
            cx.notify();
            return;
        }

        let find_record = |id: &str, records: &[BeginnerChatRecord]| {
            records.iter().find(|record| record.id == id).cloned()
        };

        let active_record = open_tabs
            .active_record_id
            .as_deref()
            .and_then(|id| find_record(id, &self.chat_history))
            .or_else(|| {
                open_tabs
                    .background_record_ids
                    .iter()
                    .find_map(|id| find_record(id, &self.chat_history))
            });
        let active_record_id = active_record.as_ref().map(|record| record.id.clone());

        if let Some(record) = active_record {
            self.open_chat_record_in_place(record, window, cx);
        }

        for record_id in open_tabs.background_record_ids {
            if Some(record_id.as_str()) == active_record_id.as_deref() {
                continue;
            }
            if let Some(record) = find_record(&record_id, &self.chat_history) {
                self.background_sessions
                    .push(Self::make_session_for_record(record, window, cx));
            }
        }

        self.save_open_tabs(cx);
        cx.notify();
    }
}

/// Generate a human-readable title from the user's initial prompt (like ChatGPT/Claude naming).
/// Uses sentence case and keeps up to 6 meaningful words.
fn generate_chat_name(prompt: &str) -> String {
    const STOP_WORDS: &[&str] = &[
        "a",
        "an",
        "the",
        "make",
        "build",
        "create",
        "add",
        "set",
        "up",
        "me",
        "my",
        "i",
        "want",
        "please",
        "can",
        "you",
        "that",
        "this",
        "it",
        "some",
        "just",
        "something",
        "new",
        "simple",
        "basic",
        "cool",
        "nice",
        "good",
        "great",
        "modern",
        "clean",
        "help",
        "do",
        "write",
        "give",
    ];

    let words: Vec<String> = prompt
        .split_whitespace()
        .filter_map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| c.is_alphabetic())
                .collect::<String>()
                .to_lowercase();
            if clean.is_empty() || STOP_WORDS.contains(&clean.as_str()) {
                None
            } else {
                Some(clean)
            }
        })
        .take(6)
        .collect();

    if words.is_empty() {
        return "Untitled project".to_string();
    }

    // Sentence case: capitalize first word only.
    let mut result = String::new();
    for (i, word) in words.iter().enumerate() {
        if i == 0 {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                result.push_str(&first.to_uppercase().to_string());
                result.push_str(chars.as_str());
            }
        } else {
            result.push(' ');
            result.push_str(word);
        }
    }
    result
}

fn first_visible_worktree_path(project: &Entity<Project>, cx: &App) -> Option<PathBuf> {
    project
        .read(cx)
        .visible_worktrees(cx)
        .filter(|wt| !wt.read(cx).is_single_file())
        .next()
        .map(|wt| wt.read(cx).abs_path().to_path_buf())
}

#[allow(dead_code)]
fn persist_experience_level(level: ExperienceLevel, cx: &mut App) {
    let kvp = KeyValueStore::global(cx);
    let level_str = level.to_str().to_string();
    db::write_and_log(cx, move || async move {
        kvp.write_kvp(EXPERIENCE_LEVEL_KVP_KEY.to_string(), level_str)
            .await
    });
}

impl Focusable for BeginnerWorkspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BeginnerWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui_font = theme_settings::setup_ui_font(window, cx);
        self.restore_persisted_open_tabs(window, cx);

        let should_show_embedded_preview = self.right_panel_open
            && self.right_panel_mode == RightPanelMode::Artifact
            && matches!(self.right_panel, RightPanel::Preview)
            && self.preview_visible
            && self.preview_url.is_some();

        // Lazily create the embedded web preview only after the user asks to view it.
        // Returns None on unsupported platforms (Linux/Wayland).
        if should_show_embedded_preview && self.web_preview.is_none() {
            if let Some(url) = self.preview_url.clone() {
                self.web_preview = crate::web_preview::WebPreview::new(window, &url);
            }
        } else if !should_show_embedded_preview {
            self.web_preview = None;
        }

        // If the URL changed after the view was already created, navigate it.
        if let (true, Some(preview), Some(url)) = (
            should_show_embedded_preview,
            &mut self.web_preview,
            &self.preview_url,
        ) {
            preview.load_url(url);
        }

        div().size_full().font(ui_font).child(match &self.state {
            BeginnerState::Landing => self.render_landing(window, cx).into_any_element(),
            BeginnerState::ActiveProject => {
                self.render_active_project(window, cx).into_any_element()
            }
        })
    }
}

impl BeginnerWorkspace {
    fn reset_simple_sidebar_width(&mut self, cx: &mut Context<Self>) {
        self.chats_sidebar_width = px(ds::SIDEBAR_WIDTH);
        cx.notify();
    }

    fn resize_simple_sidebar(
        &mut self,
        event: &DragMoveEvent<DraggedSimpleSidebarResize>,
        cx: &mut Context<Self>,
    ) {
        let available_width = event.bounds.right() - event.bounds.left();
        if available_width <= px(0.) {
            return;
        }

        let minimum_sidebar_width = px(ds::SIDEBAR_MIN_WIDTH).min(available_width);
        let reserved_width = px(ds::CHAT_PANEL_MIN_WIDTH + ds::RIGHT_PANEL_MIN_WIDTH);
        let maximum_sidebar_width = (available_width - reserved_width).max(minimum_sidebar_width);
        let requested_sidebar_width = event.event.position.x - event.bounds.left();
        let sidebar_width =
            requested_sidebar_width.clamp(minimum_sidebar_width, maximum_sidebar_width);

        if self.chats_sidebar_width != sidebar_width {
            self.chats_sidebar_width = sidebar_width;
            cx.notify();
        }
    }

    fn render_simple_sidebar_resize_handle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("simple-sidebar-resize-divider")
            .absolute()
            .right_0()
            .top_0()
            .h_full()
            .w(px(1.))
            .child(
                div()
                    .id("simple-sidebar-resize-handle")
                    .absolute()
                    .left(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                    .top_0()
                    .h_full()
                    .w(px(ds::PANEL_RESIZE_HANDLE_WIDTH))
                    .cursor_col_resize()
                    .block_mouse_except_scroll()
                    .tooltip(Tooltip::text("Resize sidebar"))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseUpEvent, _, cx| {
                            if event.click_count == 2 {
                                this.reset_simple_sidebar_width(cx);
                            }
                            cx.stop_propagation();
                        }),
                    )
                    .on_drag(DraggedSimpleSidebarResize, |_, _, _, cx| {
                        cx.stop_propagation();
                        cx.new(|_| gpui::Empty)
                    }),
            )
    }

    fn simple_sidebar_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let sidebar_is_open = self.chats_sidebar_open && !self.chats_sidebar_closing;

        ContextMenu::build(window, cx, move |menu, _window, _cx| {
            let toggle_sidebar = beginner_workspace.clone();
            let show_panel_options = beginner_workspace.clone();
            let open_terminal = beginner_workspace.clone();

            menu.item(
                ContextMenuEntry::new(if sidebar_is_open {
                    "Close Sidebar"
                } else {
                    "Open Sidebar"
                })
                .icon(if sidebar_is_open {
                    IconName::ThreadsSidebarLeftOpen
                } else {
                    IconName::ThreadsSidebarLeftClosed
                })
                .icon_position(IconPosition::Start)
                .handler(move |_window, cx| {
                    toggle_sidebar
                        .update(cx, |this, cx| {
                            if this.chats_sidebar_open && !this.chats_sidebar_closing {
                                this.close_chats_sidebar(cx);
                            } else {
                                this.open_chats_sidebar(cx);
                            }
                        })
                        .log_err();
                }),
            )
            .item(
                ContextMenuEntry::new("Panel Options")
                    .icon(IconName::ThreadsSidebarRightOpen)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        show_panel_options
                            .update(cx, |this, cx| {
                                this.select_right_panel_option(RightPanelOption::Files, window, cx);
                            })
                            .log_err();
                    }),
            )
            .item(
                ContextMenuEntry::new("Open Terminal")
                    .icon(IconName::Terminal)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        open_terminal
                            .update(cx, |this, cx| {
                                this.open_bottom_terminal_panel(window, cx);
                            })
                            .log_err();
                    }),
            )
            .separator()
            .item(
                ContextMenuEntry::new("Dashboard")
                    .icon(IconName::ArrowUpRight)
                    .icon_position(IconPosition::Start)
                    .handler(|_window, cx| {
                        cx.open_url("https://app.backboard.io");
                    }),
            )
            .item(
                ContextMenuEntry::new("Settings")
                    .icon(IconName::Settings)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(OpenSettings), cx);
                    }),
            )
            .item(
                ContextMenuEntry::new("Configure API Key")
                    .icon(IconName::Sliders)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(ConfigureBackboardApiKey), cx);
                    }),
            )
            .item(
                ContextMenuEntry::new("Reset Onboarding")
                    .icon(IconName::RotateCcw)
                    .icon_position(IconPosition::Start)
                    .handler(|window, cx| {
                        window.dispatch_action(Box::new(ResetOnboarding), cx);
                    }),
            )
        })
    }

    fn render_simple_sidebar_menu_button(
        &self,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        DropdownMenu::new_with_element(
            id,
            Icon::new(IconName::Menu)
                .size(IconSize::XSmall)
                .color(Color::Muted)
                .into_any_element(),
            self.simple_sidebar_menu(window, cx),
        )
        .style(DropdownStyle::Ghost)
        .trigger_size(ButtonSize::Compact)
        .no_chevron()
    }

    fn render_simple_sidebar_row_icon(icon_name: IconName, color: Color) -> impl IntoElement {
        div()
            .w(px(ds::SIDEBAR_ROW_ICON_SLOT_WIDTH))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(Icon::new(icon_name).size(IconSize::Small).color(color))
    }

    fn render_simple_sidebar_row_label(
        label: impl Into<SharedString>,
        color: Color,
    ) -> impl IntoElement {
        Label::new(label)
            .size(LabelSize::Custom(rems_from_px(14.)))
            .weight(FontWeight::MEDIUM)
            .color(color)
            .truncate()
    }

    fn reset_simple_panel_width(&mut self, cx: &mut Context<Self>) {
        self.chat_panel_width = px(ds::CHAT_PANEL_WIDTH);
        self.right_panel_height = px(DOCKED_PANEL_DEFAULT_HEIGHT_PX);
        cx.notify();
    }

    fn visible_chats_sidebar_width(&self) -> Pixels {
        if self.chats_sidebar_open {
            self.chats_sidebar_width
        } else {
            px(CLOSED_CHATS_SIDEBAR_WIDTH_PX)
        }
    }

    fn render_chats_sidebar_slot(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.chats_sidebar_open {
            return h_flex()
                .id("simple-closed-sidebar-width-slot")
                .h_full()
                .w(px(CLOSED_CHATS_SIDEBAR_WIDTH_PX))
                .flex_shrink_0()
                .overflow_hidden()
                .bg(ds::sidebar_background(cx))
                .child(self.render_closed_chats_sidebar(window, cx))
                .into_any_element();
        }

        let is_closing = self.chats_sidebar_closing;
        let target_width = self.chats_sidebar_width;
        let closed_width = px(CLOSED_CHATS_SIDEBAR_WIDTH_PX);

        h_flex()
            .id("simple-sidebar-width-slot")
            .h_full()
            .w(target_width)
            .flex_shrink_0()
            .overflow_hidden()
            .bg(ds::sidebar_background(cx))
            .child(self.render_chats_sidebar(window, cx))
            .with_animation(
                (
                    "simple-sidebar-width",
                    self.chats_sidebar_animation_generation,
                ),
                Animation::new(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                    .with_easing(ease_out_quint()),
                move |slot, delta| {
                    let visible_progress = if is_closing { 1.0 - delta } else { delta };
                    let width = closed_width + (target_width - closed_width) * visible_progress;
                    slot.w(width.max(closed_width))
                },
            )
            .into_any_element()
    }

    fn target_right_panel_width(&self, window: &Window) -> Pixels {
        if self.right_panel_expanded {
            return window
                .viewport_size()
                .width
                .max(px(RIGHT_PANEL_CLOSED_WIDTH_PX));
        }

        let content_width =
            (window.viewport_size().width - self.visible_chats_sidebar_width()).max(px(0.));
        let minimum_chat_width = px(ds::CHAT_PANEL_MIN_WIDTH).min(content_width);
        let maximum_chat_width =
            (content_width - px(ds::RIGHT_PANEL_MIN_WIDTH)).max(minimum_chat_width);
        let chat_panel_width = self
            .chat_panel_width
            .clamp(minimum_chat_width, maximum_chat_width);
        let target_width = (content_width - chat_panel_width).max(px(ds::RIGHT_PANEL_MIN_WIDTH));

        target_width
            .min(content_width.max(px(RIGHT_PANEL_CLOSED_WIDTH_PX)))
            .max(px(RIGHT_PANEL_CLOSED_WIDTH_PX))
    }

    fn target_right_panel_height(&self, window: &Window) -> Pixels {
        if self.right_panel_expanded {
            return window
                .viewport_size()
                .height
                .max(px(RIGHT_PANEL_CLOSED_WIDTH_PX));
        }

        let content_height = window.viewport_size().height.max(px(0.));
        let minimum_panel_height = px(DOCKED_PANEL_MIN_HEIGHT_PX).min(content_height);
        let maximum_panel_height =
            (content_height - px(DOCKED_PANEL_MIN_MAIN_SIZE_PX)).max(minimum_panel_height);

        self.right_panel_height
            .clamp(minimum_panel_height, maximum_panel_height)
            .max(px(RIGHT_PANEL_CLOSED_WIDTH_PX))
    }

    fn resize_simple_panels(
        &mut self,
        event: &DragMoveEvent<DraggedSimplePanelResize>,
        cx: &mut Context<Self>,
    ) {
        if self.right_panel_dock.is_side() {
            let available_width = event.bounds.right() - event.bounds.left();
            if available_width <= px(0.) {
                return;
            }

            let minimum_chat_width = px(ds::CHAT_PANEL_MIN_WIDTH).min(available_width);
            let maximum_chat_width =
                (available_width - px(ds::RIGHT_PANEL_MIN_WIDTH)).max(minimum_chat_width);
            let requested_chat_width = match self.right_panel_dock {
                SimplePanelDock::Left => event.bounds.right() - event.event.position.x,
                SimplePanelDock::Right => event.event.position.x - event.bounds.left(),
                SimplePanelDock::Top | SimplePanelDock::Bottom => unreachable!(),
            };
            let chat_panel_width =
                requested_chat_width.clamp(minimum_chat_width, maximum_chat_width);

            if self.chat_panel_width != chat_panel_width {
                self.chat_panel_width = chat_panel_width;
                cx.notify();
            }
        } else {
            let available_height = event.bounds.bottom() - event.bounds.top();
            if available_height <= px(0.) {
                return;
            }

            let minimum_panel_height = px(DOCKED_PANEL_MIN_HEIGHT_PX).min(available_height);
            let maximum_panel_height =
                (available_height - px(DOCKED_PANEL_MIN_MAIN_SIZE_PX)).max(minimum_panel_height);
            let requested_panel_height = match self.right_panel_dock {
                SimplePanelDock::Top => event.event.position.y - event.bounds.top(),
                SimplePanelDock::Bottom => event.bounds.bottom() - event.event.position.y,
                SimplePanelDock::Left | SimplePanelDock::Right => unreachable!(),
            };
            let right_panel_height =
                requested_panel_height.clamp(minimum_panel_height, maximum_panel_height);

            if self.right_panel_height != right_panel_height {
                self.right_panel_height = right_panel_height;
                cx.notify();
            }
        }
    }

    fn render_simple_panel_resize_handle(&self, cx: &mut Context<Self>) -> AnyElement {
        let drag_handle = |el: Div, cursor_is_row_resize: bool| {
            let el = el
                .id("simple-panel-resize-handle")
                .absolute()
                .block_mouse_except_scroll()
                .tooltip(Tooltip::text("Resize panels"))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|_, _: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                    }),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, event: &MouseUpEvent, _, cx| {
                        if event.click_count == 2 {
                            this.reset_simple_panel_width(cx);
                        }
                        cx.stop_propagation();
                    }),
                )
                .on_drag(DraggedSimplePanelResize, |_, _, _, cx| {
                    cx.stop_propagation();
                    cx.new(|_| gpui::Empty)
                });

            if cursor_is_row_resize {
                el.cursor_row_resize()
            } else {
                el.cursor_col_resize()
            }
        };

        match self.right_panel_dock {
            SimplePanelDock::Right => div()
                .id("simple-panel-resize-divider")
                .absolute()
                .left_0()
                .top_0()
                .h_full()
                .w(px(1.))
                .child(drag_handle(
                    div()
                        .left(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                        .top_0()
                        .h_full()
                        .w(px(ds::PANEL_RESIZE_HANDLE_WIDTH)),
                    false,
                ))
                .into_any_element(),
            SimplePanelDock::Left => div()
                .id("simple-panel-resize-divider")
                .absolute()
                .right_0()
                .top_0()
                .h_full()
                .w(px(1.))
                .child(drag_handle(
                    div()
                        .right(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                        .top_0()
                        .h_full()
                        .w(px(ds::PANEL_RESIZE_HANDLE_WIDTH)),
                    false,
                ))
                .into_any_element(),
            SimplePanelDock::Bottom => div()
                .id("simple-panel-resize-divider")
                .absolute()
                .top_0()
                .left_0()
                .w_full()
                .h(px(1.))
                .child(drag_handle(
                    div()
                        .top(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                        .left_0()
                        .w_full()
                        .h(px(ds::PANEL_RESIZE_HANDLE_WIDTH)),
                    true,
                ))
                .into_any_element(),
            SimplePanelDock::Top => div()
                .id("simple-panel-resize-divider")
                .absolute()
                .bottom_0()
                .left_0()
                .w_full()
                .h(px(1.))
                .child(drag_handle(
                    div()
                        .bottom(px(-ds::PANEL_RESIZE_HANDLE_WIDTH / 2.))
                        .left_0()
                        .w_full()
                        .h(px(ds::PANEL_RESIZE_HANDLE_WIDTH)),
                    true,
                ))
                .into_any_element(),
        }
    }

    fn render_right_panel_slide_shell(
        &self,
        is_running: bool,
        preview_url: Option<String>,
        preview_dominant: bool,
        target_size: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_closing = self.right_panel_closing;
        let dock = self.right_panel_dock;
        let content =
            self.render_right_panel(is_running, preview_url, preview_dominant, window, cx);
        let resize_handle = (!preview_dominant).then(|| self.render_simple_panel_resize_handle(cx));

        let panel = match dock {
            SimplePanelDock::Right => h_flex()
                .id("right-panel-slide-shell")
                .relative()
                .w(target_size)
                .min_w(target_size)
                .max_w(target_size)
                .flex_shrink_0()
                .h_full()
                .overflow_hidden()
                .border_l_1()
                .border_color(ds::panel_edge_line(cx))
                .bg(ds::app_background(cx))
                .child(content)
                .children(resize_handle),
            SimplePanelDock::Left => h_flex()
                .id("right-panel-slide-shell")
                .relative()
                .w(target_size)
                .min_w(target_size)
                .max_w(target_size)
                .flex_shrink_0()
                .h_full()
                .overflow_hidden()
                .border_r_1()
                .border_color(ds::panel_edge_line(cx))
                .bg(ds::app_background(cx))
                .child(content)
                .children(resize_handle),
            SimplePanelDock::Top => v_flex()
                .id("right-panel-slide-shell")
                .relative()
                .h(target_size)
                .min_h(target_size)
                .max_h(target_size)
                .flex_shrink_0()
                .w_full()
                .overflow_hidden()
                .child(content)
                .children(resize_handle),
            SimplePanelDock::Bottom => v_flex()
                .id("right-panel-slide-shell")
                .relative()
                .h(target_size)
                .min_h(target_size)
                .max_h(target_size)
                .flex_shrink_0()
                .w_full()
                .overflow_hidden()
                .children(resize_handle)
                .child(content),
        };

        panel
            .with_animation(
                ("right-panel-slide", self.right_panel_animation_generation),
                Animation::new(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                    .with_easing(ease_out_quint()),
                move |panel, delta| {
                    let visible_progress = if is_closing { 1.0 - delta } else { delta };
                    panel.opacity(
                        RIGHT_PANEL_FADE_START_OPACITY
                            + visible_progress * (1.0 - RIGHT_PANEL_FADE_START_OPACITY),
                    )
                },
            )
            .into_any_element()
    }

    fn render_right_panel_slot(
        &self,
        is_running: bool,
        preview_url: Option<String>,
        preview_dominant: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.right_panel_open {
            return self.render_open_artifact_panel_button(cx);
        }

        let preview_dominant = preview_dominant || self.right_panel_expanded;
        let is_closing = self.right_panel_closing;
        let dock = self.right_panel_dock;
        let target_size = if dock.is_side() {
            self.target_right_panel_width(window)
        } else {
            self.target_right_panel_height(window)
        };
        let closed_size = px(RIGHT_PANEL_CLOSED_WIDTH_PX);

        let slot = match dock {
            SimplePanelDock::Left | SimplePanelDock::Right => h_flex()
                .id("right-panel-width-slot")
                .h_full()
                .w(target_size)
                .flex_shrink_0()
                .overflow_hidden()
                .bg(ds::sidebar_background(cx))
                .child(self.render_right_panel_slide_shell(
                    is_running,
                    preview_url,
                    preview_dominant,
                    target_size,
                    window,
                    cx,
                )),
            SimplePanelDock::Top | SimplePanelDock::Bottom => v_flex()
                .id("right-panel-width-slot")
                .w_full()
                .h(target_size)
                .flex_shrink_0()
                .overflow_hidden()
                .bg(ds::sidebar_background(cx))
                .child(self.render_right_panel_slide_shell(
                    is_running,
                    preview_url,
                    preview_dominant,
                    target_size,
                    window,
                    cx,
                )),
        };

        slot.with_animation(
            ("right-panel-width", self.right_panel_animation_generation),
            Animation::new(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                .with_easing(ease_out_quint()),
            move |slot, delta| {
                let visible_progress = if is_closing { 1.0 - delta } else { delta };
                let size = closed_size + (target_size - closed_size) * visible_progress;

                if dock.is_side() {
                    slot.w(size.max(closed_size))
                } else {
                    slot.h(size.max(closed_size))
                }
            },
        )
        .into_any_element()
    }

    fn render_middle_panel_shell(
        &self,
        content: AnyElement,
        min_width: Option<Pixels>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let has_min_width = min_width.is_some();

        div()
            .id("simple-middle-panel")
            .flex_1()
            .min_h_0()
            .h_full()
            .relative()
            .when_some(min_width, |el, min_width| el.min_w(min_width))
            .when(!has_min_width, |el| el.min_w_0())
            .child(
                div()
                    .absolute()
                    .left(px(-ds::PANEL_OVERLAP))
                    .top_0()
                    .right_0()
                    .bottom_0()
                    .overflow_hidden()
                    .rounded_tl(px(ds::PANEL_CORNER_RADIUS))
                    .rounded_bl(px(ds::PANEL_CORNER_RADIUS))
                    .border_1()
                    .border_color(ds::panel_edge_line(cx))
                    .bg(ds::app_background(cx))
                    .pl(px(ds::PANEL_OVERLAP))
                    .child(content),
            )
            .into_any_element()
    }

    fn render_main_with_right_panel(
        &self,
        main_content: AnyElement,
        is_running: bool,
        preview_url: Option<String>,
        right_panel_expanded: bool,
        api_key_ready: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let panel = api_key_ready.then(|| {
            self.render_right_panel_slot(is_running, preview_url, right_panel_expanded, window, cx)
        });
        let main_content = self.render_middle_panel_shell(
            main_content,
            (api_key_ready && self.right_panel_open).then(|| px(ds::CHAT_PANEL_MIN_WIDTH)),
            cx,
        );

        if right_panel_expanded {
            return h_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .bg(ds::sidebar_background(cx))
                .on_drag_move::<DraggedSimplePanelResize>(cx.listener(|this, event, _, cx| {
                    this.resize_simple_panels(event, cx);
                }))
                .children(panel)
                .into_any_element();
        }

        match self.right_panel_dock {
            SimplePanelDock::Left => h_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .bg(ds::sidebar_background(cx))
                .on_drag_move::<DraggedSimplePanelResize>(cx.listener(|this, event, _, cx| {
                    this.resize_simple_panels(event, cx);
                }))
                .children(panel)
                .child(main_content)
                .into_any_element(),
            SimplePanelDock::Right => h_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .bg(ds::sidebar_background(cx))
                .on_drag_move::<DraggedSimplePanelResize>(cx.listener(|this, event, _, cx| {
                    this.resize_simple_panels(event, cx);
                }))
                .child(main_content)
                .children(panel)
                .into_any_element(),
            SimplePanelDock::Top => v_flex()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .h_full()
                .bg(ds::sidebar_background(cx))
                .on_drag_move::<DraggedSimplePanelResize>(cx.listener(|this, event, _, cx| {
                    this.resize_simple_panels(event, cx);
                }))
                .children(panel)
                .child(main_content)
                .into_any_element(),
            SimplePanelDock::Bottom => v_flex()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .h_full()
                .bg(ds::sidebar_background(cx))
                .on_drag_move::<DraggedSimplePanelResize>(cx.listener(|this, event, _, cx| {
                    this.resize_simple_panels(event, cx);
                }))
                .child(main_content)
                .children(panel)
                .into_any_element(),
        }
    }

    fn target_bottom_panel_height(&self, window: &Window) -> Pixels {
        let content_height = window.viewport_size().height.max(px(0.));
        let minimum_panel_height = px(DOCKED_PANEL_MIN_HEIGHT_PX).min(content_height);
        let maximum_panel_height =
            (content_height - px(DOCKED_PANEL_MIN_MAIN_SIZE_PX)).max(minimum_panel_height);

        px(DOCKED_PANEL_DEFAULT_HEIGHT_PX).clamp(minimum_panel_height, maximum_panel_height)
    }

    fn render_main_with_bottom_panel(
        &self,
        main_content: AnyElement,
        api_key_ready: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !api_key_ready || !self.bottom_panel_open {
            return main_content;
        }

        let bottom_panel_height = self.target_bottom_panel_height(window);
        v_flex()
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .bg(ds::sidebar_background(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .child(main_content),
            )
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(bottom_panel_height)
                    .flex_shrink_0()
                    .overflow_hidden()
                    .rounded_t(px(ds::PANEL_CORNER_RADIUS))
                    .bg(ds::sidebar_background(cx))
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .top_0()
                            .bottom_0()
                            .overflow_hidden()
                            .rounded_t(px(ds::PANEL_CORNER_RADIUS))
                            .bg(ds::sidebar_background(cx))
                            .child(self.render_bottom_terminal_slot(bottom_panel_height, cx)),
                    ),
            )
            .into_any_element()
    }

    fn render_bottom_terminal_slot(&self, height: Pixels, cx: &mut Context<Self>) -> AnyElement {
        let is_closing = self.bottom_panel_closing;

        v_flex()
            .id("simple-bottom-terminal-slot")
            .w_full()
            .h(height)
            .flex_shrink_0()
            .overflow_hidden()
            .rounded_t(px(ds::PANEL_CORNER_RADIUS))
            .bg(ds::sidebar_background(cx))
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(height)
                    .overflow_hidden()
                    .rounded_t(px(ds::PANEL_CORNER_RADIUS))
                    .child(self.render_bottom_terminal_panel(height, cx))
                    .with_animation(
                        ("bottom-panel-slide", self.bottom_panel_animation_generation),
                        Animation::new(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                            .with_easing(ease_out_quint()),
                        move |panel, delta| {
                            let visible_progress = if is_closing { 1.0 - delta } else { delta };
                            let offset = height * (1.0 - visible_progress);
                            panel.top(offset).opacity(visible_progress)
                        },
                    ),
            )
            .into_any_element()
    }

    fn render_bottom_terminal_panel(
        &self,
        height: Pixels,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);

        v_flex()
            .id("simple-bottom-terminal-panel")
            .relative()
            .h(height)
            .min_h(height)
            .max_h(height)
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .rounded_t(px(ds::PANEL_CORNER_RADIUS))
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(36.))
                    .flex_shrink_0()
                    .px_3()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(
                        Icon::new(IconName::Terminal)
                            .size(IconSize::XSmall)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    )
                    .child(
                        Label::new("Terminal")
                            .size(LabelSize::Small)
                            .weight(FontWeight::SEMIBOLD)
                            .color(Color::Custom(ds::text(cx))),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("simple-bottom-terminal-close")
                            .size(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close bottom panel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.close_bottom_panel(cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::XSmall)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(if let Some(terminal_view) = self.terminal_view.clone() {
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(terminal_view)
                    .into_any_element()
            } else {
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .child(
                        Icon::new(IconName::LoadCircle)
                            .size(IconSize::Medium)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    )
                    .child(
                        Label::new("Starting terminal...")
                            .size(LabelSize::Small)
                            .color(Color::Custom(ds::text_muted(cx))),
                    )
                    .into_any_element()
            })
    }

    fn render_open_artifact_panel_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let hover_background = ds::hover_background(cx);

        let button = div()
            .id("open-artifact-panel")
            .size(px(30.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(move |el| el.bg(hover_background))
            .tooltip(Tooltip::text("Open panel"))
            .on_click(cx.listener(|this, _, window, cx| {
                this.open_artifact_panel(window, cx);
            }))
            .child(
                Icon::new(IconName::ThreadsSidebarRightClosed)
                    .size(IconSize::Small)
                    .color(Color::Custom(ds::icon_muted(cx))),
            );

        match self.right_panel_dock {
            SimplePanelDock::Left | SimplePanelDock::Right => div()
                .w(px(RIGHT_PANEL_CLOSED_WIDTH_PX))
                .h_full()
                .flex_shrink_0()
                .overflow_hidden()
                .when(self.right_panel_dock == SimplePanelDock::Left, |el| {
                    el.border_r_1()
                })
                .when(self.right_panel_dock == SimplePanelDock::Right, |el| {
                    el.border_l_1()
                })
                .border_color(ds::panel_edge_line(cx))
                .bg(ds::app_background(cx))
                .flex()
                .items_start()
                .justify_center()
                .pt_5()
                .px_2()
                .child(button)
                .into_any_element(),
            SimplePanelDock::Top | SimplePanelDock::Bottom => div()
                .h(px(44.))
                .w_full()
                .flex_shrink_0()
                .when(self.right_panel_dock == SimplePanelDock::Top, |el| {
                    el.border_b_1()
                })
                .when(self.right_panel_dock == SimplePanelDock::Bottom, |el| {
                    el.border_t_1()
                })
                .border_color(ds::panel_edge_line(cx))
                .bg(ds::app_background(cx))
                .flex()
                .items_center()
                .justify_end()
                .pr_2()
                .child(button)
                .into_any_element(),
        }
    }

    fn render_sidebar_api_status_banner(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(24.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(ds::chip_background(cx))
            .child(div().size(px(5.)).rounded_full().bg(ds::warning(cx)))
            .child(
                Label::new("API not connected")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(ds::text_disabled(cx))),
            )
    }

    fn render_sidebar_no_api_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .px_4()
            .pb_8()
            .gap_3()
            .child(
                Icon::new(IconName::Info)
                    .size(IconSize::Medium)
                    .color(Color::Muted),
            )
            .child(
                Label::new("Agent chats unavailable")
                    .size(LabelSize::Small)
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .max_w(px(190.))
                    .text_center()
                    .text_size(rems_from_px(12.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.36))
                    .child("Connect an API key to start chats, run agents, and generate output."),
            )
            .child(
                Button::new("simple-sidebar-configure-api-key", "Connect API key")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Default)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_api_key_settings(window, cx);
                    })),
            )
    }

    fn render_chats_sidebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let action_hover = ds::sidebar_hover_background(cx);
        let api_key_ready = Self::has_backboard_api_key();
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let top_bar_offset = if traffic_lights { 8. } else { 0. };
        let search_query = self
            .chat_search_editor
            .read(cx)
            .text(cx)
            .trim()
            .to_lowercase();
        let matches_query =
            |title: &str| search_query.is_empty() || title.to_lowercase().contains(&search_query);
        let mut project_groups: IndexMap<String, SidebarProjectGroup> = IndexMap::default();
        if api_key_ready {
            for record in self.chat_history.clone() {
                let folder_path = record.folder();
                let record_matches_query = matches_query(record.display_name().as_ref());
                let folder_matches_query = folder_matches_search(&folder_path, &search_query);
                if record_matches_query || folder_matches_query {
                    let folder_key = folder_path.to_string_lossy().into_owned();
                    project_groups
                        .entry(folder_key)
                        .or_insert_with(|| SidebarProjectGroup::new(folder_path))
                        .add_record(record);
                }
            }

            for folder_path in
                self.selected_folder
                    .iter()
                    .chain(self.background_sessions.iter().filter_map(|session| {
                        matches!(session.state, BeginnerState::ActiveProject)
                            .then_some(session.selected_folder.as_ref())
                            .flatten()
                    }))
            {
                if !folder_matches_search(folder_path, &search_query) {
                    continue;
                }

                let folder_key = folder_path.to_string_lossy().into_owned();
                if !project_groups.contains_key(&folder_key) {
                    project_groups
                        .insert(folder_key, SidebarProjectGroup::new(folder_path.clone()));
                }
            }
        }
        let project_groups: Vec<_> = project_groups.into_values().collect();
        let no_project_groups = project_groups.is_empty();
        let empty_project_title = if search_query.is_empty() {
            "No chats yet"
        } else {
            "No matching chats"
        };
        let empty_project_subtitle = if search_query.is_empty() {
            "Start a new project to get started."
        } else {
            "Try a different search."
        };
        let search_focus_handle = self.chat_search_editor.focus_handle(cx);
        let search_field_is_empty = search_query.is_empty();
        let search_field_is_focused = search_focus_handle.is_focused(window);
        let sidebar_opacity = if window.is_window_active() {
            0.58
        } else {
            0.72
        };
        let is_closing = self.chats_sidebar_closing;
        let animation_generation = self.chats_sidebar_animation_generation;

        v_flex()
            .relative()
            .w(self.chats_sidebar_width)
            .min_w(px(ds::SIDEBAR_MIN_WIDTH))
            .h_full()
            .flex_shrink_0()
            .opacity(sidebar_opacity)
            .bg(ds::sidebar_background(cx))
            .child(div().absolute().inset_0().bg(ds::sidebar_glow_wash(cx)))
            .child(div().absolute().inset_0().bg(ds::sidebar_edge_wash(cx)))
            .when(!api_key_ready, |el| {
                el.child(self.render_sidebar_api_status_banner(cx))
            })
            .child(
                v_flex()
                    .flex_none()
                    .pl_1()
                    .pr(px(ds::PANEL_OVERLAP + 8.))
                    .pb_1()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .h(px(ds::TOP_BAR_HEIGHT + top_bar_offset))
                            .pt(px(top_bar_offset))
                            .items_center()
                            .gap_1()
                            .when(traffic_lights, |el| {
                                el.pl(px(ui::utils::TRAFFIC_LIGHT_PADDING))
                            })
                            .pr_1()
                            .child(
                                div()
                                    .h_full()
                                    .w(px(0.))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .window_control_area(WindowControlArea::Drag),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .id("simple-sidebar-open-bottom-panel")
                                    .size(px(24.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .tooltip(Tooltip::text(if api_key_ready {
                                        "Open bottom panel"
                                    } else {
                                        "Connect API key to open bottom panel"
                                    }))
                                    .when(api_key_ready, |el| {
                                        el.cursor_pointer()
                                            .hover(move |el| el.bg(action_hover))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.open_bottom_terminal_panel(window, cx);
                                            }))
                                    })
                                    .when(!api_key_ready, |el| el.opacity(0.35))
                                    .child(
                                        Icon::new(IconName::ExpandUp)
                                            .size(IconSize::XSmall)
                                            .color(Color::Custom(ds::sidebar_icon(cx))),
                                    ),
                            )
                            .child(self.render_simple_sidebar_menu_button(
                                "simple-sidebar-actions-menu",
                                window,
                                cx,
                            ))
                            .child(
                                div()
                                    .id("simple-sidebar-close")
                                    .size(px(24.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |el| el.bg(action_hover))
                                    .tooltip(Tooltip::text("Close sidebar"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.close_chats_sidebar(cx);
                                    }))
                                    .child(
                                        Icon::new(IconName::ThreadsSidebarLeftOpen)
                                            .size(IconSize::XSmall)
                                            .color(Color::Custom(ds::sidebar_icon(cx))),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-settings")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .mt(px(6.))
                            .px_2()
                            .gap_1p5()
                            .items_center()
                            .rounded_lg()
                            .cursor_pointer()
                            .hover(move |el| el.bg(action_hover))
                            .tooltip(Tooltip::text("Open settings"))
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(OpenSettings), cx);
                            })
                            .child(Self::render_simple_sidebar_row_icon(
                                IconName::Settings,
                                Color::Custom(ds::sidebar_icon(cx)),
                            ))
                            .child(Self::render_simple_sidebar_row_label(
                                "Settings",
                                Color::Custom(ds::sidebar_emphasis_text(cx)),
                            )),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-new-chat")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .px_2()
                            .gap_1p5()
                            .items_center()
                            .rounded_lg()
                            .when(api_key_ready, |el| {
                                el.cursor_pointer()
                                    .hover(move |el| el.bg(action_hover))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.go_home(window, cx);
                                    }))
                            })
                            .when(!api_key_ready, |el| el.opacity(0.35))
                            .child(Self::render_simple_sidebar_row_icon(
                                IconName::Plus,
                                if api_key_ready {
                                    Color::Custom(ds::sidebar_icon(cx))
                                } else {
                                    Color::Disabled
                                },
                            ))
                            .child(Self::render_simple_sidebar_row_label(
                                "New chat",
                                if api_key_ready {
                                    Color::Custom(ds::sidebar_emphasis_text(cx))
                                } else {
                                    Color::Disabled
                                },
                            )),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-chat-search")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .px_2()
                            .gap_1p5()
                            .items_center()
                            .rounded_lg()
                            .when(api_key_ready, |el| el.hover(move |el| el.bg(action_hover)))
                            .when(!api_key_ready, |el| el.opacity(0.35))
                            .on_click({
                                let search_focus_handle = search_focus_handle.clone();
                                move |_, window, cx| {
                                    window.focus(&search_focus_handle, cx);
                                }
                            })
                            .child(Self::render_simple_sidebar_row_icon(
                                IconName::MagnifyingGlass,
                                Color::Custom(ds::sidebar_icon(cx)),
                            ))
                            .child(
                                div()
                                    .relative()
                                    .h_full()
                                    .flex()
                                    .items_center()
                                    .flex_1()
                                    .min_w_0()
                                    .child(self.chat_search_editor.clone())
                                    .when(
                                        search_field_is_empty && !search_field_is_focused,
                                        |el| {
                                            el.child(
                                                div()
                                                    .absolute()
                                                    .inset_0()
                                                    .flex()
                                                    .items_center()
                                                    .child(
                                                        Label::new("Search chats")
                                                            .size(LabelSize::Custom(rems_from_px(
                                                                14.,
                                                            )))
                                                            .weight(FontWeight::MEDIUM)
                                                            .color(Color::Custom(
                                                                ds::sidebar_emphasis_text(cx),
                                                            ))
                                                            .truncate(),
                                                    ),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("simple-sidebar-connect-mcp")
                            .h(px(ds::CHAT_ROW_HEIGHT))
                            .mt(px(6.))
                            .px_2()
                            .gap_1p5()
                            .items_center()
                            .rounded_lg()
                            .cursor_pointer()
                            .hover({
                                let action_hover = action_hover;
                                move |el| el.bg(action_hover)
                            })
                            .tooltip(Tooltip::text("Connect an MCP server"))
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(AddContextServer), cx);
                            })
                            .child(Self::render_simple_sidebar_row_icon(
                                IconName::Server,
                                Color::Custom(ds::sidebar_icon(cx)),
                            ))
                            .child(Self::render_simple_sidebar_row_label(
                                "Connect MCP server",
                                Color::Custom(ds::sidebar_emphasis_text(cx)),
                            )),
                    ),
            )
            .child(
                v_flex()
                    .id("chat-history-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pl_1()
                    .pr(px(ds::PANEL_OVERLAP + 8.))
                    .pb_2()
                    .gap_0p5()
                    .when(!api_key_ready, |el| {
                        el.child(self.render_sidebar_no_api_state(cx))
                    })
                    .when(api_key_ready, |el| {
                        el.child(
                            h_flex().h(px(28.)).px_1().items_center().child(
                                Label::new("Projects")
                                    .size(LabelSize::Default)
                                    .weight(FontWeight::MEDIUM)
                                    .color(Color::Custom(ds::sidebar_text_muted(cx))),
                            ),
                        )
                    })
                    .when(api_key_ready && no_project_groups, |el| {
                        el.child(
                            v_flex()
                                .px_2()
                                .py_2()
                                .gap_0p5()
                                .child(
                                    Label::new(empty_project_title)
                                        .size(LabelSize::Default)
                                        .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                )
                                .child(
                                    Label::new(empty_project_subtitle)
                                        .size(LabelSize::Small)
                                        .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                ),
                        )
                    })
                    .children(project_groups.into_iter().map(|project_group| {
                        let folder_name = folder_display_name(&project_group.folder_path);

                        v_flex()
                            .w_full()
                            .pt_1p5()
                            .child(
                                h_flex()
                                    .h(px(ds::CHAT_ROW_HEIGHT))
                                    .px_2()
                                    .gap_1p5()
                                    .items_center()
                                    .child(Self::render_simple_sidebar_row_icon(
                                        IconName::Folder,
                                        Color::Custom(ds::sidebar_icon(cx)),
                                    ))
                                    .child(
                                        Label::new(folder_name)
                                            .size(LabelSize::Custom(rems_from_px(14.)))
                                            .weight(FontWeight::SEMIBOLD)
                                            .color(Color::Custom(ds::sidebar_emphasis_text(cx)))
                                            .truncate(),
                                    ),
                            )
                            .when(project_group.records.is_empty(), |el| {
                                el.child(
                                    h_flex()
                                        .h(px(ds::CHAT_ROW_HEIGHT))
                                        .pl(px(34.))
                                        .pr_3()
                                        .items_center()
                                        .child(
                                            Label::new("No chats")
                                                .size(LabelSize::Default)
                                                .color(Color::Custom(ds::sidebar_text_subtle(cx))),
                                        ),
                                )
                            })
                            .children(project_group.records.into_iter().map(|record| {
                                let name = record.display_name();
                                let record_id = record.id.clone();
                                let row_group =
                                    SharedString::from(format!("chat-entry-{record_id}"));
                                let is_active = self.active_chat_record_id.as_deref()
                                    == Some(record_id.as_str());
                                let background_session_index =
                                    self.background_sessions.iter().position(|session| {
                                        session.chat_record_id.as_deref()
                                            == Some(record_id.as_str())
                                    });
                                let record_for_click = record.clone();
                                let record_id_for_delete = record_id.clone();
                                let hover_bg = ds::sidebar_hover_background(cx);
                                h_flex()
                                    .id(SharedString::from(format!("chat-{record_id}")))
                                    .group(row_group.clone())
                                    .h(px(ds::CHAT_ROW_HEIGHT))
                                    .pl(px(34.))
                                    .pr_3()
                                    .gap_2()
                                    .rounded_lg()
                                    .cursor_pointer()
                                    .when(is_active, |el| {
                                        el.bg(ds::sidebar_selected_background(cx))
                                    })
                                    .hover(move |el| el.bg(hover_bg))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_chat_record(record_for_click.clone(), window, cx);
                                    }))
                                    .child(
                                        v_flex().flex_1().min_w_0().child(
                                            Label::new(name)
                                                .size(LabelSize::Custom(rems_from_px(14.)))
                                                .color(Color::Custom(ds::sidebar_text(cx)))
                                                .truncate(),
                                        ),
                                    )
                                    .child(
                                        div()
                                            .id(SharedString::from(format!(
                                                "chat-del-{record_id_for_delete}"
                                            )))
                                            .size(px(16.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded_full()
                                            .flex_none()
                                            .cursor_pointer()
                                            .when(!is_active, |el| {
                                                el.visible_on_hover(row_group.clone())
                                            })
                                            .hover(move |el| el.bg(hover_bg))
                                            .on_click(cx.listener(
                                                move |this, _event, window, cx| {
                                                    cx.stop_propagation();
                                                    if is_active {
                                                        this.close_active_session(window, cx);
                                                    } else if let Some(session_index) =
                                                        background_session_index
                                                    {
                                                        this.close_background_session(
                                                            session_index,
                                                            cx,
                                                        );
                                                    } else {
                                                        this.delete_chat_record(
                                                            record_id_for_delete.clone(),
                                                            cx,
                                                        );
                                                    }
                                                    cx.notify();
                                                },
                                            ))
                                            .child(
                                                Icon::new(IconName::Close)
                                                    .size(IconSize::XSmall)
                                                    .color(Color::Custom(ds::sidebar_text_muted(
                                                        cx,
                                                    ))),
                                            ),
                                    )
                            }))
                    })),
            )
            .child(self.render_simple_sidebar_resize_handle(cx))
            .with_animation(
                ("simple-sidebar-open-slide", animation_generation),
                Animation::new(Duration::from_millis(PANEL_OPEN_ANIMATION_MS))
                    .with_easing(ease_out_quint()),
                move |sidebar, delta| {
                    let visible_progress = if is_closing { 1.0 - delta } else { delta };
                    let offset = PANEL_OPEN_SLIDE_OFFSET_PX * (1.0 - visible_progress);
                    let opacity = if is_closing {
                        visible_progress
                    } else {
                        0.82 + visible_progress * 0.18
                    };
                    sidebar.relative().left(px(-offset)).opacity(opacity)
                },
            )
    }

    fn render_closed_chats_sidebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let sidebar_opacity = if window.is_window_active() {
            0.58
        } else {
            0.72
        };
        let traffic_lights = cfg!(target_os = "macos") && !window.is_fullscreen();
        let title_bar_height = ui::utils::platform_title_bar_height(window);

        v_flex()
            .relative()
            .w(px(48.))
            .h_full()
            .flex_shrink_0()
            .opacity(sidebar_opacity)
            .bg(ds::sidebar_background(cx))
            .on_mouse_move(cx.listener(|this, _, window, cx| {
                this.delay_open_chats_sidebar(window, cx);
            }))
            .child(div().absolute().inset_0().bg(ds::sidebar_glow_wash(cx)))
            .child(div().absolute().inset_0().bg(ds::sidebar_edge_wash(cx)))
            .border_r_1()
            .border_color(ds::panel_edge_line(cx))
            .when(traffic_lights, |el| {
                el.child(
                    div()
                        .h(title_bar_height)
                        .flex_none()
                        .window_control_area(WindowControlArea::Drag),
                )
            })
            .child(
                v_flex()
                    .when(!traffic_lights, |el| el.h(px(ds::TOP_BAR_HEIGHT)))
                    .when(traffic_lights, |el| el.py_1())
                    .items_center()
                    .justify_center()
                    .px_2()
                    .child(
                        div()
                            .id("simple-sidebar-open")
                            .relative()
                            .left(px(-8.))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover({
                                let hover_background = ds::sidebar_hover_background(cx);
                                move |el| el.bg(hover_background)
                            })
                            .tooltip(Tooltip::text("Open sidebar"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open_chats_sidebar(cx);
                            }))
                            .child(
                                Icon::new(IconName::ThreadsSidebarLeftClosed)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::sidebar_icon(cx))),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .items_center()
                    .child(div().relative().left(px(-8.)).child(
                        self.render_simple_sidebar_menu_button(
                            "simple-closed-sidebar-actions-menu",
                            window,
                            cx,
                        ),
                    ))
                    .child(div().flex_1().window_control_area(WindowControlArea::Drag)),
            )
    }

    fn simple_mode_targets() -> [SimpleModeTarget; 3] {
        [
            SimpleModeTarget::Simple,
            SimpleModeTarget::CodeEditor,
            SimpleModeTarget::Agents,
        ]
    }

    fn simple_mode_target_label(target: SimpleModeTarget) -> &'static str {
        match target {
            SimpleModeTarget::Simple => "Simple Mode",
            SimpleModeTarget::CodeEditor => "Code Editor",
            SimpleModeTarget::Agents => "Agents",
        }
    }

    fn open_simple_mode_target(
        &mut self,
        target: SimpleModeTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match target {
            SimpleModeTarget::Simple => {}
            SimpleModeTarget::CodeEditor => {
                persist_experience_level(ExperienceLevel::Developer, cx);
                self.multi_workspace
                    .update(cx, |multi_workspace, cx| {
                        multi_workspace.open_code_editor(window, cx);
                    })
                    .log_err();
            }
            SimpleModeTarget::Agents => {
                persist_experience_level(ExperienceLevel::Developer, cx);
                self.multi_workspace
                    .update(cx, |multi_workspace, cx| {
                        multi_workspace.open_agent_workspace(window, cx);
                    })
                    .log_err();
            }
        }
    }

    fn simple_mode_menu(&self, window: &mut Window, cx: &mut Context<Self>) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            for target in Self::simple_mode_targets() {
                menu = menu.toggleable_entry(
                    Self::simple_mode_target_label(target),
                    target == SimpleModeTarget::Simple,
                    IconPosition::Start,
                    None,
                    {
                        let beginner_workspace = beginner_workspace.clone();
                        move |window, cx| {
                            beginner_workspace
                                .update(cx, |beginner_workspace, cx| {
                                    beginner_workspace.open_simple_mode_target(target, window, cx);
                                })
                                .log_err();
                        }
                    },
                );
            }

            menu
        })
    }

    fn render_simple_mode_buttons(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        DropdownMenu::new(
            "simple-workspace-mode-menu",
            Self::simple_mode_target_label(SimpleModeTarget::Simple),
            self.simple_mode_menu(window, cx),
        )
        .style(DropdownStyle::Ghost)
        .trigger_size(ButtonSize::Compact)
        .trigger_tooltip(|_, cx| Tooltip::simple("Switch interface mode", cx).into())
    }

    fn render_simple_header(
        &self,
        title: SharedString,
        is_running: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .h(px(ds::TOP_BAR_HEIGHT))
            .w_full()
            .flex_shrink_0()
            .px_3()
            .gap_2()
            .items_center()
            .bg(ds::app_background(cx))
            .border_b_1()
            .border_color(ds::separator(cx))
            .child(
                div().min_w_0().flex_1().child(
                    Label::new(title)
                        .size(LabelSize::Custom(rems_from_px(13.)))
                        .weight(FontWeight::SEMIBOLD)
                        .color(Color::Custom(ds::text(cx)))
                        .truncate(),
                ),
            )
            .when(is_running, |el| {
                el.child(
                    Icon::new(IconName::LoadCircle)
                        .size(IconSize::Medium)
                        .color(Color::Custom(ds::accent(cx))),
                )
            })
            .child(self.render_simple_mode_buttons(window, cx))
            .child(div().size(px(16.)).flex_none())
    }

    fn render_empty_conversation(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let (headline, subtext_first, subtext_second) = match self.chat_mode {
            ChatMode::Ask => (
                "What do you want to ask?",
                "Ask about this project without changing files.",
                "Backboard will keep the project unchanged.",
            ),
            ChatMode::Build => (
                "What are we building today?",
                "Describe a page, feature, or change.",
                "Backboard will generate the output.",
            ),
        };
        v_flex()
            .items_center()
            .gap_3()
            .w_full()
            .max_w(px(360.))
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        img(SIMPLE_LANDING_LOGO_PATH)
                            .size(px(52.))
                            .object_fit(ObjectFit::Contain)
                            .with_fallback(|| div().size(px(52.)).into_any_element()),
                    )
                    .child(
                        Label::new(headline)
                            .size(LabelSize::Custom(rems_from_px(22.)))
                            .weight(FontWeight::BOLD)
                            .color(Color::Custom(ds::text(cx))),
                    )
                    .when(!subtext_first.is_empty(), |el| {
                        el.child(
                            v_flex()
                                .items_center()
                                .child(
                                    Label::new(subtext_first)
                                        .size(LabelSize::Custom(rems_from_px(13.)))
                                        .color(Color::Custom(ds::text_muted(cx).opacity(0.78))),
                                )
                                .child(
                                    Label::new(subtext_second)
                                        .size(LabelSize::Custom(rems_from_px(13.)))
                                        .color(Color::Custom(ds::text_muted(cx).opacity(0.78))),
                                ),
                        )
                    }),
            )
    }

    fn render_similar_project_confirmation(
        &self,
        confirmation: &SimilarProjectConfirmation,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let prior_location = confirmation
            .prior_project_location
            .as_ref()
            .map(|folder| folder_display_name(folder))
            .unwrap_or_else(|| SharedString::from("Backboard history"));
        let target_folder = folder_display_name(&confirmation.target_folder);
        let prior_project_name = confirmation.prior_project_name.as_ref();
        let source_label = prior_location.clone();
        let message = if prior_project_name == "Remembered Backboard project" {
            format!("Continue from saved context, or start fresh in {target_folder}.")
        } else {
            format!(
                "Continue from \"{}\", or start fresh in {}.",
                confirmation.prior_project_name, target_folder
            )
        };

        v_flex()
            .w(px(560.))
            .max_w(relative(1.))
            .min_w_0()
            .gap_2()
            .rounded(px(10.))
            .border_1()
            .border_color(ds::soft_border(cx).opacity(0.82))
            .bg(ds::field_background(cx).opacity(0.72))
            .p_3()
            .child(
                h_flex()
                    .gap_3()
                    .items_start()
                    .min_w_0()
                    .child(
                        div()
                            .size(px(30.))
                            .flex_none()
                            .rounded(px(8.))
                            .bg(ds::accent(cx).opacity(0.12))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::Folder)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::accent(cx))),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .min_w_0()
                                    .child(
                                        Label::new("Similar project found")
                                            .size(LabelSize::Small)
                                            .weight(FontWeight::SEMIBOLD)
                                            .color(Color::Custom(ds::text(cx))),
                                    )
                                    .child(
                                        div()
                                            .max_w(px(180.))
                                            .min_w_0()
                                            .rounded(px(999.))
                                            .border_1()
                                            .border_color(ds::soft_border(cx).opacity(0.74))
                                            .px_2()
                                            .py_0p5()
                                            .child(
                                                Label::new(source_label)
                                                    .size(LabelSize::XSmall)
                                                    .color(Color::Custom(ds::text_muted(cx)))
                                                    .truncate(),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .min_w_0()
                                    .whitespace_normal()
                                    .text_size(rems_from_px(13.))
                                    .text_color(ds::text_muted(cx))
                                    .line_height(relative(1.34))
                                    .child(message),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .flex_wrap()
                    .pl(px(42.))
                    .child(
                        Button::new("similar-project-build-on-previous", "Build on top")
                            .style(ButtonStyle::Filled)
                            .size(ButtonSize::Compact)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.build_on_previous_version_confirmation(window, cx);
                            })),
                    )
                    .child(
                        Button::new("similar-project-build", "Create new project")
                            .style(ButtonStyle::Outlined)
                            .size(ButtonSize::Compact)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.continue_similar_project_confirmation(window, cx);
                            })),
                    ),
            )
    }

    fn render_landing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let api_key_ready = Self::has_backboard_api_key();
        let right_panel_expanded =
            api_key_ready && self.right_panel_open && self.right_panel_expanded;
        let mode_buttons_top = if api_key_ready { 10. } else { 38. };
        if api_key_ready {
            self.ensure_composer_thread(window, cx);
        }
        self.refresh_composer_git_state_if_needed(cx);

        v_flex()
            .relative()
            .key_context("BeginnerLanding")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::handle_enter_submit))
            .on_action(cx.listener(|this, _: &EditorCancel, _, cx| {
                if this.is_agent_running {
                    this.cancel_running_task(cx);
                }
            }))
            .size_full()
            .bg(ds::sidebar_background(cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(ds::sidebar_background(cx))
                    .on_drag_move::<DraggedSimpleSidebarResize>(cx.listener(
                        |this, event, _, cx| {
                            this.resize_simple_sidebar(event, cx);
                        },
                    ))
                    .when(!right_panel_expanded, |el| {
                        el.child(self.render_chats_sidebar_slot(window, cx))
                    })
                    .child(
                        self.render_main_with_bottom_panel(
                            self.render_main_with_right_panel(
                                v_flex()
                                    .flex_1()
                                    .relative()
                                    .when(api_key_ready && self.right_panel_open, |el| {
                                        el.min_w(px(ds::CHAT_PANEL_MIN_WIDTH))
                                    })
                                    .when(!api_key_ready || !self.right_panel_open, |el| {
                                        el.min_w_0()
                                    })
                                    .min_h_0()
                                    .h_full()
                                    .overflow_hidden()
                                    .bg(ds::app_background(cx))
                                    .when(!api_key_ready, |el| {
                                        el.child(self.render_api_status_banner(cx))
                                    })
                                    .child(if api_key_ready {
                                        v_flex()
                                            .flex_1()
                                            .min_h_0()
                                            .items_center()
                                            .justify_center()
                                            .px_4()
                                            .pb(rems_from_px(96.))
                                            .child(
                                                v_flex()
                                                    .w_full()
                                                    .max_w(px(ds::CHAT_MAX_WIDTH))
                                                    .items_center()
                                                    .gap_6()
                                                    .child(self.render_empty_conversation(cx))
                                                    .when_some(
                                                        self.pending_similar_project_confirmation
                                                            .as_ref(),
                                                        |el, confirmation| {
                                                            el.child(
                                                                self.render_similar_project_confirmation(
                                                                    confirmation,
                                                                    cx,
                                                                ),
                                                            )
                                                        },
                                                    )
                                                    .child(self.render_input_bar(
                                                        false,
                                                        false,
                                                        draft_is_empty,
                                                        true,
                                                        api_key_ready,
                                                        window,
                                                        cx,
                                                    )),
                                            )
                                            .into_any_element()
                                    } else {
                                        v_flex()
                                            .flex_1()
                                            .min_h_0()
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .items_center()
                                                    .justify_center()
                                                    .px_4()
                                                    .child(self.render_api_key_required(cx)),
                                            )
                                            .child(self.render_input_bar(
                                                false,
                                                false,
                                                draft_is_empty,
                                                false,
                                                api_key_ready,
                                                window,
                                                cx,
                                            ))
                                            .into_any_element()
                                    })
                                    .child(
                                        h_flex()
                                            .absolute()
                                            .top(px(mode_buttons_top))
                                            .right(px(14.))
                                            .child(self.render_simple_mode_buttons(window, cx)),
                                    )
                                    .into_any_element(),
                                false,
                                None,
                                right_panel_expanded,
                                api_key_ready,
                                window,
                                cx,
                            ),
                            api_key_ready,
                            window,
                            cx,
                        ),
                    ),
            )
            .when(self.share_dialog_open, |el| {
                el.child(self.render_share_dialog(cx))
            })
    }

    fn render_active_project(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let is_running = self.is_agent_running;
        let is_connecting = self.pending_conversation_view.is_some();
        let draft_is_empty = self.chat_editor.read(cx).text(cx).trim().is_empty();
        let api_key_ready = Self::has_backboard_api_key();
        let right_panel_expanded =
            api_key_ready && self.right_panel_open && self.right_panel_expanded;
        if api_key_ready {
            self.ensure_composer_thread(window, cx);
        }
        self.refresh_composer_git_state_if_needed(cx);
        let preview_url = self.preview_url.clone();
        let active_title = self.current_tab_title();
        let preview_card_state = self.preview_card_state();
        let colors = cx.theme().colors().clone();

        v_flex()
            .relative()
            .size_full()
            .bg(ds::sidebar_background(cx))
            .on_action(cx.listener(Self::handle_enter_submit))
            .on_action(cx.listener(|this, _: &EditorCancel, _, cx| {
                if this.is_agent_running {
                    this.cancel_running_task(cx);
                }
            }))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(ds::sidebar_background(cx))
                    .on_drag_move::<DraggedSimpleSidebarResize>(cx.listener(
                        |this, event, _, cx| {
                            this.resize_simple_sidebar(event, cx);
                        },
                    ))
                    .when(!right_panel_expanded, |el| {
                        el.child(self.render_chats_sidebar_slot(window, cx))
                    })
                    .child(
                        self.render_main_with_bottom_panel(
                            self.render_main_with_right_panel(
                                v_flex()
                                    .flex_1()
                                    .when(api_key_ready && self.right_panel_open, |el| {
                                        el.min_w(px(ds::CHAT_PANEL_MIN_WIDTH))
                                    })
                                    .when(!api_key_ready || !self.right_panel_open, |el| {
                                        el.min_w_0()
                                    })
                                    .min_h_0()
                                    .h_full()
                                    .overflow_hidden()
                                    .bg(ds::app_background(cx))
                                    .child(self.render_simple_header(
                                        active_title.clone(),
                                        is_running || is_connecting,
                                        window,
                                        cx,
                                    ))
                                    .when(!api_key_ready, |el| {
                                        el.child(self.render_api_status_banner(cx)).child(
                                            v_flex()
                                                .flex_1()
                                                .min_h_0()
                                                .items_center()
                                                .justify_center()
                                                .px_4()
                                                .child(self.render_api_key_required(cx)),
                                        )
                                    })
                                    .when(api_key_ready, |el| {
                                        el.when_some(self.chat_feed.as_ref(), |el, feed| {
                                            feed.update(cx, |feed, cx| {
                                                feed.set_preview_state(preview_card_state, cx);
                                                feed.set_display_mode(
                                                    self.chat_feed_display_mode,
                                                    cx,
                                                );
                                            });
                                            el.child(
                                                v_flex()
                                                    .h_full()
                                                    .flex_1()
                                                    .min_h_0()
                                                    .overflow_hidden()
                                                    .child(feed.clone()),
                                            )
                                        })
                                    })
                                    .when(api_key_ready && self.chat_feed.is_none(), |el| {
                                        let (headline, subtext) = if is_connecting {
                                            (
                                                "Backboard is connecting",
                                                "Your agent is starting up.",
                                            )
                                        } else if self.chat_mode == ChatMode::Ask {
                                            (
                                                "What do you want to ask?",
                                                "Ask about this project without changing files.",
                                            )
                                        } else {
                                            (
                                                "What do you want to build?",
                                                "Describe a page, feature, or change.",
                                            )
                                        };
                                        el.child(
                                            v_flex()
                                                .flex_1()
                                                .min_h_0()
                                                .items_center()
                                                .justify_center()
                                                .px_4()
                                                .pb(rems_from_px(48.))
                                                .child(if is_connecting {
                                                    v_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .child(
                                                            Label::new(headline)
                                                                .size(LabelSize::Large)
                                                                .color(Color::Custom(colors.text)),
                                                        )
                                                        .child(
                                                            Label::new(subtext)
                                                                .size(LabelSize::Small)
                                                                .color(Color::Custom(
                                                                    colors.text_muted,
                                                                )),
                                                        )
                                                        .into_any_element()
                                                } else {
                                                    self.render_empty_conversation(cx)
                                                        .into_any_element()
                                                }),
                                        )
                                    })
                                    .when(api_key_ready && (is_running || is_connecting), |el| {
                                        let status = if is_connecting {
                                            SharedString::from("Thought for 1s")
                                        } else if self.chat_mode == ChatMode::Ask {
                                            SharedString::from("Thinking...")
                                        } else if self.is_preview_generating {
                                            SharedString::from("Starting local preview")
                                        } else {
                                            SharedString::from(format!(
                                                "Working on {}",
                                                self.artifact_title().as_ref()
                                            ))
                                        };
                                        el.child(
                                            h_flex()
                                                .flex_shrink_0()
                                                .px_4()
                                                .py_2()
                                                .gap_2()
                                                .items_center()
                                                .child(
                                                    Icon::new(IconName::LoadCircle)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Custom(colors.icon_accent)),
                                                )
                                                .child(
                                                    Label::new(status)
                                                        .size(LabelSize::XSmall)
                                                        .color(Color::Custom(colors.text_muted)),
                                                ),
                                        )
                                    })
                                    .child(self.render_input_bar(
                                        is_running,
                                        is_connecting,
                                        draft_is_empty,
                                        false,
                                        api_key_ready,
                                        window,
                                        cx,
                                    ))
                                    .into_any_element(),
                                is_running,
                                preview_url,
                                right_panel_expanded,
                                api_key_ready,
                                window,
                                cx,
                            ),
                            api_key_ready,
                            window,
                            cx,
                        ),
                    ),
            )
            .when(self.share_dialog_open, |el| {
                el.child(self.render_share_dialog(cx))
            })
    }

    fn render_artifact_illustration(
        &self,
        state: ArtifactIllustrationState,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let accent = ds::accent(cx);
        let primary_line = match state {
            ArtifactIllustrationState::Empty => ds::illustration_line_primary(cx),
            ArtifactIllustrationState::Working => accent,
            ArtifactIllustrationState::Error => ds::error(cx).opacity(0.22),
        };
        let secondary_top_line = match state {
            ArtifactIllustrationState::Error => {
                Some((px(29.), px(12.), ds::error(cx).opacity(0.22)))
            }
            ArtifactIllustrationState::Working => {
                Some((px(35.), px(8.), ds::illustration_line_secondary(cx)))
            }
            ArtifactIllustrationState::Empty => None,
        };
        let primary_width = match state {
            ArtifactIllustrationState::Empty => px(34.),
            ArtifactIllustrationState::Working => px(26.),
            ArtifactIllustrationState::Error => px(16.),
        };

        div()
            .relative()
            .w(px(64.))
            .h(px(50.))
            .overflow_hidden()
            .rounded(px(8.))
            .child(
                div()
                    .absolute()
                    .left(px(10.))
                    .top(px(12.))
                    .w(px(52.))
                    .h(px(38.))
                    .rounded(px(6.))
                    .bg(ds::illustration_shadow(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .w(px(52.))
                    .h(px(38.))
                    .rounded(px(4.))
                    .bg(ds::illustration_page(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(11.))
                    .w(primary_width)
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(primary_line),
            )
            .children(secondary_top_line.map(|(left, width, color)| {
                div()
                    .absolute()
                    .left(left)
                    .top(px(11.))
                    .w(width)
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(color)
            }))
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(19.))
                    .w(px(26.))
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(ds::illustration_line_secondary(cx)),
            )
            .child(
                div()
                    .absolute()
                    .left(px(9.))
                    .top(px(27.))
                    .w(px(18.))
                    .h(px(3.))
                    .rounded(px(1.5))
                    .bg(ds::illustration_shadow(cx)),
            )
    }

    fn render_empty_artifact_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Empty, cx))
            .child(
                Label::new("No artifact yet")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .w(px(240.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.54))
                    .child("Ask Backboard to build something and the output will appear here."),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("generate-artifact", "Generate artifact")
                            .style(ButtonStyle::Filled)
                            .size(ButtonSize::Default)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_chat_mode(ChatMode::Build, window, cx);
                                this.apply_suggested_prompt("Make a landing page", window, cx);
                                this.submit_follow_up(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .id("try-artifact-prompt")
                            .h(px(24.))
                            .min_w(px(56.))
                            .px_2p5()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_chat_mode(ChatMode::Build, window, cx);
                                this.apply_suggested_prompt("Make a landing page", window, cx);
                            }))
                            .child(
                                Label::new("Try a prompt")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::accent(cx))),
                            ),
                    ),
            )
    }

    fn render_artifact_working_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Working, cx))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Icon::new(IconName::LoadCircle)
                            .size(IconSize::XSmall)
                            .color(Color::Custom(ds::accent(cx))),
                    )
                    .child(
                        Label::new("Starting preview...")
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::accent(cx))),
                    ),
            )
            .child(
                Label::new("Preparing preview...")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                Label::new("Looking for a runnable app.")
                    .size(LabelSize::Custom(rems_from_px(13.)))
                    .color(Color::Custom(ds::text_muted(cx))),
            )
    }

    fn render_browser_external_fallback(
        &self,
        preview_url: String,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let display_url = Self::browser_address_label(Some(&preview_url));
        let preview_url_for_open = preview_url.clone();
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Empty, cx))
            .child(
                Label::new("Preview running")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .w(px(280.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.46))
                    .child(format!("The app is serving at {}.", display_url.as_ref())),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("open-running-preview", "Open in browser")
                            .style(ButtonStyle::Filled)
                            .size(ButtonSize::Default)
                            .label_size(LabelSize::XSmall)
                            .on_click(move |_, _, cx| {
                                cx.open_url(preview_url_for_open.as_str());
                            }),
                    )
                    .child(
                        Button::new("retry-running-preview", "Reload")
                            .style(ButtonStyle::Subtle)
                            .size(ButtonSize::Default)
                            .label_size(LabelSize::XSmall)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.web_preview = None;
                                this.preview_visible = this.preview_url.is_some();
                                cx.notify();
                            })),
                    ),
            )
    }

    fn render_artifact_error_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_4()
            .child(self.render_artifact_illustration(ArtifactIllustrationState::Error, cx))
            .child(
                Label::new("Preview unavailable")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .w(px(240.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(ds::text_muted(cx))
                    .line_height(relative(1.46))
                    .child("No runnable app was detected. Backboard can still make more changes."),
            )
            .child(
                Button::new("retry-artifact-preview", "Try again")
                    .style(ButtonStyle::Filled)
                    .size(ButtonSize::Default)
                    .label_size(LabelSize::XSmall)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.open_web_app_if_present(cx);
                    })),
            )
    }

    fn render_design_preview_fallback(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div().flex_1().min_h_0().bg(ds::app_background(cx))
    }

    fn render_artifact_browser_shell(
        &self,
        preview_url: Option<String>,
        content: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);

        v_flex()
            .flex_1()
            .min_h_0()
            .size_full()
            .overflow_hidden()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .flex_shrink_0()
                    .px_5()
                    .gap_3()
                    .items_center()
                    .bg(ds::app_background(cx))
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(window, cx))
                    .child(div().flex_1())
                    .child(
                        self.render_right_panel_expand_button("artifact-browser-expand-panel", cx),
                    )
                    .child(
                        div()
                            .id("artifact-browser-close-panel")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_right_panel(window, cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(self.render_browser_status_bar(preview_url, cx))
            .child(
                v_flex()
                    .id("artifact-browser-page")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .bg(ds::app_background(cx))
                    .child(content),
            )
    }

    fn render_browser_status_bar(
        &self,
        preview_url: Option<String>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let has_url = preview_url.is_some();
        let address = Self::browser_address_label(preview_url.as_ref());
        let (status_icon, status_label, status_color) = if self.is_preview_generating {
            (
                IconName::LoadCircle,
                "Loading preview",
                Color::Custom(ds::accent(cx)),
            )
        } else if self.web_preview.is_some() {
            (
                IconName::Check,
                "Browser live",
                Color::Custom(ds::accent(cx)),
            )
        } else if has_url {
            (
                IconName::ArrowUpRight,
                "Open externally",
                Color::Custom(ds::text_muted(cx)),
            )
        } else {
            (
                IconName::Circle,
                "No preview URL",
                Color::Custom(ds::text_muted(cx)),
            )
        };
        let hover_background = ds::hover_background(cx);

        h_flex()
            .h(px(42.))
            .flex_shrink_0()
            .px_5()
            .gap_2()
            .items_center()
            .bg(ds::app_background(cx))
            .border_b_1()
            .border_color(ds::separator(cx).opacity(0.34))
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .h(px(28.))
                    .items_center()
                    .gap_2()
                    .rounded(px(7.))
                    .border_1()
                    .border_color(ds::soft_border(cx).opacity(0.62))
                    .bg(ds::field_background(cx).opacity(0.58))
                    .px_2()
                    .child(
                        Icon::new(IconName::Public)
                            .size(IconSize::XSmall)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    )
                    .child(
                        Label::new(address)
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::text_muted(cx)))
                            .truncate()
                            .flex_1(),
                    ),
            )
            .child(
                h_flex()
                    .min_w(px(118.))
                    .items_center()
                    .justify_end()
                    .gap_1p5()
                    .child(
                        Icon::new(status_icon)
                            .size(IconSize::XSmall)
                            .color(status_color),
                    )
                    .child(
                        Label::new(status_label)
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::text_muted(cx)))
                            .truncate(),
                    ),
            )
            .when_some(preview_url.clone(), |el, url| {
                let url_for_open = url.clone();
                el.child(
                    div()
                        .id("artifact-browser-reload")
                        .size(px(26.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |el| el.bg(hover_background))
                        .tooltip(Tooltip::text("Reload preview"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.preview_url = Some(url.clone());
                            this.preview_visible = true;
                            this.web_preview = None;
                            cx.notify();
                        }))
                        .child(
                            Icon::new(IconName::RotateCw)
                                .size(IconSize::XSmall)
                                .color(Color::Custom(ds::icon_muted(cx))),
                        ),
                )
                .child(
                    div()
                        .id("artifact-browser-open-external")
                        .size(px(26.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |el| el.bg(hover_background))
                        .tooltip(Tooltip::text("Open in browser"))
                        .on_click(move |_, _, cx| {
                            cx.open_url(url_for_open.as_str());
                        })
                        .child(
                            Icon::new(IconName::ArrowUpRight)
                                .size(IconSize::XSmall)
                                .color(Color::Custom(ds::icon_muted(cx))),
                        ),
                )
            })
    }

    fn right_panel_tab_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let workspace = cx.entity().downgrade();
        let active_option = self.active_right_panel_tab;

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            menu = menu.header("New tab");

            for option in RightPanelOption::ALL {
                let workspace = workspace.clone();
                menu = menu.item(
                    ContextMenuEntry::new(option.label())
                        .icon(option.icon())
                        .icon_position(IconPosition::Start)
                        .toggle(IconPosition::End, active_option == Some(option))
                        .handler(move |window, cx| {
                            workspace
                                .update(cx, |this, cx| {
                                    this.select_right_panel_option(option, window, cx);
                                })
                                .log_err();
                        }),
                );
            }

            menu
        })
    }

    fn render_right_panel_option_tabs(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        let border_color = ds::soft_border(cx);
        let active_option = self.active_right_panel_tab;

        h_flex()
            .h(px(40.))
            .min_w_0()
            .flex_1()
            .max_w(px(560.))
            .items_center()
            .gap_1p5()
            .overflow_hidden()
            .child(
                DropdownMenu::new_with_element(
                    "right-panel-new-tab",
                    div()
                        .size(px(32.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .border_1()
                        .border_color(border_color)
                        .bg(ds::chip_background(cx))
                        .hover(move |el| el.bg(hover_background))
                        .child(
                            Icon::new(IconName::Plus)
                                .size(IconSize::Small)
                                .color(Color::Custom(ds::icon_muted(cx))),
                        )
                        .into_any_element(),
                    self.right_panel_tab_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .attach(gpui::Anchor::BottomLeft)
                .no_chevron(),
            )
            .children(
                self.right_panel_tabs
                    .iter()
                    .copied()
                    .filter(|option| *option != RightPanelOption::Terminal)
                    .map(|option| {
                        let is_active = active_option == Some(option);
                        let tab_color = Color::Custom(if is_active {
                            ds::text(cx)
                        } else {
                            ds::icon_muted(cx)
                        });
                        let close_hover_background = hover_background;

                        h_flex()
                            .id(option.element_id())
                            .h(px(32.))
                            .max_w(px(118.))
                            .min_w(px(82.))
                            .items_center()
                            .gap_1p5()
                            .pl(px(10.))
                            .pr(px(6.))
                            .rounded_full()
                            .border_1()
                            .border_color(border_color)
                            .cursor_pointer()
                            .tooltip(Tooltip::text(option.label()))
                            .when(is_active, |el| el.bg(ds::selected_background(cx)))
                            .when(!is_active, |el| el.hover(move |el| el.bg(hover_background)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.select_right_panel_option(option, window, cx);
                            }))
                            .child(
                                Icon::new(option.icon())
                                    .size(IconSize::XSmall)
                                    .color(tab_color),
                            )
                            .child(
                                Label::new(option.label())
                                    .size(LabelSize::XSmall)
                                    .color(tab_color)
                                    .truncate()
                                    .flex_1(),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "{}-close",
                                        option.element_id()
                                    )))
                                    .size(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .cursor_pointer()
                                    .hover(move |el| el.bg(close_hover_background))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.close_right_panel_tab(option, window, cx);
                                    }))
                                    .child(
                                        Icon::new(IconName::Close)
                                            .size(IconSize::XSmall)
                                            .color(tab_color),
                                    ),
                            )
                    }),
            )
    }

    fn render_right_panel_expand_button(
        &self,
        id: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        let expanded = self.right_panel_expanded;
        let (icon, tooltip) = if expanded {
            (IconName::Minimize, "Restore panel")
        } else {
            (IconName::Maximize, "Expand panel")
        };

        div()
            .id(id)
            .size(px(28.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(move |el| el.bg(hover_background))
            .tooltip(Tooltip::text(tooltip))
            .on_click(cx.listener(|this, _, window, cx| {
                this.toggle_right_panel_expanded(window, cx);
            }))
            .child(
                Icon::new(icon)
                    .size(IconSize::Small)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
    }

    fn render_right_panel_launcher(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover_background = ds::hover_background(cx);

        v_flex()
            .flex_1()
            .min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
            .h_full()
            .overflow_hidden()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .px_5()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(window, cx))
                    .child(div().flex_1())
                    .child(self.render_right_panel_expand_button("right-panel-expand", cx))
                    .child(
                        div()
                            .id("right-panel-close")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_right_panel(window, cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(match self.right_panel_option {
                RightPanelOption::Files => self.render_right_panel_files_state(cx),
                RightPanelOption::Terminal => self.render_right_panel_files_state(cx),
                RightPanelOption::Design => self.render_empty_artifact_state(cx).into_any_element(),
                RightPanelOption::Code => match &self.right_panel {
                    RightPanel::CodeDiff { .. } => {
                        self.render_code_diff_state(cx).into_any_element()
                    }
                    RightPanel::CodeView { title, editor, .. } => self
                        .render_code_artifact_state(title, editor.clone(), cx)
                        .into_any_element(),
                    _ => self.render_code_empty_state(cx).into_any_element(),
                },
            })
            .into_any_element()
    }

    fn render_right_panel_blank(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let hover_background = ds::hover_background(cx);

        v_flex()
            .flex_1()
            .min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
            .h_full()
            .overflow_hidden()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .px_5()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(window, cx))
                    .child(div().flex_1())
                    .child(self.render_right_panel_expand_button("right-panel-expand", cx))
                    .child(
                        div()
                            .id("right-panel-close")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_right_panel(window, cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(div().flex_1().min_h_0().bg(ds::app_background(cx)))
            .into_any_element()
    }

    fn render_right_panel_files_state(&self, cx: &mut Context<Self>) -> AnyElement {
        #[derive(Clone)]
        struct BrowserEntry {
            path: PathBuf,
            label: SharedString,
            is_directory: bool,
        }

        let Some(root) = self.selected_folder.clone() else {
            return v_flex()
                .flex_1()
                .min_h_0()
                .items_center()
                .justify_center()
                .px_8()
                .gap_4()
                .child(
                    Icon::new(IconName::FolderOpen)
                        .size(IconSize::Custom(rems_from_px(28.)))
                        .color(Color::Custom(ds::icon_muted(cx))),
                )
                .child(
                    Label::new("No folder selected")
                        .size(LabelSize::Custom(rems_from_px(18.)))
                        .weight(FontWeight::SEMIBOLD)
                        .color(Color::Custom(ds::text(cx))),
                )
                .child(
                    div()
                        .max_w(px(340.))
                        .text_center()
                        .text_size(rems_from_px(13.))
                        .line_height(relative(1.38))
                        .text_color(ds::text_muted(cx))
                        .child("Choose a project folder to browse files in this panel."),
                )
                .child(
                    Button::new("right-panel-choose-folder", "Choose folder")
                        .style(ButtonStyle::Filled)
                        .size(ButtonSize::Medium)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.pick_folder(window, cx);
                        })),
                )
                .into_any_element();
        };

        let browse_path = self
            .raw_browse_path
            .clone()
            .filter(|path| path.starts_with(&root))
            .unwrap_or_else(|| root.clone());
        let current_label = browse_path
            .strip_prefix(&root)
            .ok()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder_display_name(&root).to_string());

        let mut entries = Vec::new();
        let mut error_label = None;
        match std::fs::read_dir(&browse_path) {
            Ok(read_dir) => {
                let mut entry_error_count = 0usize;
                for entry_result in read_dir {
                    let entry = match entry_result {
                        Ok(entry) => entry,
                        Err(_) => {
                            entry_error_count += 1;
                            continue;
                        }
                    };
                    let file_name = entry.file_name();
                    let label = file_name.to_string_lossy().into_owned();
                    if label.starts_with('.') {
                        continue;
                    }
                    let file_type = match entry.file_type() {
                        Ok(file_type) => file_type,
                        Err(_) => {
                            entry_error_count += 1;
                            continue;
                        }
                    };
                    entries.push(BrowserEntry {
                        path: entry.path(),
                        label: SharedString::from(label),
                        is_directory: file_type.is_dir(),
                    });
                }
                if entry_error_count > 0 {
                    error_label = Some(SharedString::from(format!(
                        "{entry_error_count} item(s) could not be read."
                    )));
                }
            }
            Err(error) => {
                error_label = Some(SharedString::from(format!(
                    "Unable to read {}: {error}",
                    browse_path.display()
                )));
            }
        }

        entries.sort_by(|left, right| {
            right.is_directory.cmp(&left.is_directory).then_with(|| {
                left.label
                    .as_ref()
                    .to_lowercase()
                    .cmp(&right.label.as_ref().to_lowercase())
            })
        });

        let entry_count = entries.len();
        let item_count_label = if entry_count == 1 {
            SharedString::from("1 item")
        } else {
            SharedString::from(format!("{entry_count} items"))
        };
        let selected_path = match &self.right_panel {
            RightPanel::CodeView { path, .. } => Some(path.clone()),
            _ => None,
        };
        let selected_code_view = match &self.right_panel {
            RightPanel::CodeView {
                path,
                title,
                editor,
            } => Some((path.clone(), title.clone(), editor.clone())),
            _ => None,
        };

        let files_sidebar_collapsed = self.files_sidebar_collapsed;

        h_flex()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .when(!files_sidebar_collapsed, |el| {
                el.child(
                    v_flex()
                        .flex_1()
                        .flex_basis(relative(0.5))
                        .min_w(px(FILES_SPLIT_MIN_DIRECTORY_WIDTH_PX))
                        .h_full()
                        .overflow_hidden()
                        .border_r_1()
                        .border_color(ds::separator(cx).opacity(0.5))
                        .child(
                            h_flex()
                                .h(px(52.))
                                .items_center()
                                .px_3()
                                .gap_2()
                                .border_b_1()
                                .border_color(ds::separator(cx).opacity(0.45))
                                .child(
                                    Icon::new(IconName::FileTree)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                )
                                .child(
                                    v_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .gap_0p5()
                                        .child(
                                            Label::new("File directory")
                                                .size(LabelSize::Small)
                                                .weight(FontWeight::SEMIBOLD)
                                                .color(Color::Custom(ds::text(cx))),
                                        )
                                        .child(
                                            Label::new(current_label)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Custom(ds::text_muted(cx)))
                                                .truncate(),
                                        ),
                                )
                                .child(
                                    IconButton::new(
                                        "files-collapse-sidebar",
                                        IconName::ChevronLeft,
                                    )
                                    .style(ButtonStyle::Subtle)
                                    .icon_size(IconSize::Small)
                                    .tooltip(Tooltip::text("Collapse sidebar"))
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.files_sidebar_collapsed = true;
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    h_flex()
                                        .h(px(22.))
                                        .flex_shrink_0()
                                        .items_center()
                                        .rounded(px(11.))
                                        .border_1()
                                        .border_color(ds::soft_border(cx))
                                        .bg(ds::chip_background(cx))
                                        .px_2()
                                        .child(
                                            Label::new(item_count_label)
                                                .size(LabelSize::XSmall)
                                                .color(Color::Custom(ds::text_muted(cx))),
                                        ),
                                ),
                        )
                        .when_some(error_label, |el, error| {
                            el.child(
                                h_flex()
                                    .mx_2()
                                    .mt_2()
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(ds::soft_border(cx))
                                    .bg(ds::field_background(cx))
                                    .px_3()
                                    .py_2()
                                    .child(
                                        Label::new(error)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    ),
                            )
                        })
                        .child(
                            v_flex()
                                .id("right-panel-files-list")
                                .flex_1()
                                .min_h_0()
                                .overflow_y_scroll()
                                .p_2()
                                .when(browse_path != root, |el| {
                                    let parent_path = browse_path.parent().map(Path::to_path_buf);
                                    el.when_some(parent_path, |el, parent_path| {
                                        el.child(self.render_file_browser_row(
                                            "right-panel-file-parent",
                                            SharedString::from("Parent folder"),
                                            parent_path,
                                            true,
                                            false,
                                            cx,
                                        ))
                                    })
                                })
                                .when(entry_count == 0, |el| {
                                    el.child(
                                        v_flex()
                                            .flex_1()
                                            .items_center()
                                            .justify_center()
                                            .gap_2()
                                            .px_4()
                                            .child(
                                                Icon::new(IconName::FolderOpen)
                                                    .size(IconSize::Medium)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            )
                                            .child(
                                                Label::new("This folder is empty")
                                                    .size(LabelSize::Small)
                                                    .color(Color::Custom(ds::text_muted(cx))),
                                            ),
                                    )
                                })
                                .children(entries.into_iter().enumerate().map(|(index, entry)| {
                                    let is_selected =
                                        selected_path.as_ref().map_or(false, |selected_path| {
                                            selected_path == &entry.path
                                        });
                                    self.render_file_browser_row(
                                        SharedString::from(format!("right-panel-file-row-{index}")),
                                        entry.label,
                                        entry.path,
                                        entry.is_directory,
                                        is_selected,
                                        cx,
                                    )
                                })),
                        ),
                )
            })
            .child(
                v_flex()
                    .flex_1()
                    .flex_basis(relative(0.5))
                    .min_w(px(FILES_SPLIT_MIN_CODE_WIDTH_PX))
                    .h_full()
                    .overflow_hidden()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .when(files_sidebar_collapsed, |el| {
                                el.child(
                                    h_flex()
                                        .h(px(52.))
                                        .items_center()
                                        .px_3()
                                        .gap_2()
                                        .border_b_1()
                                        .border_color(ds::separator(cx).opacity(0.45))
                                        .child(
                                            IconButton::new(
                                                "files-expand-sidebar",
                                                IconName::ChevronRight,
                                            )
                                            .style(ButtonStyle::Subtle)
                                            .icon_size(IconSize::Small)
                                            .tooltip(Tooltip::text("Expand sidebar"))
                                            .on_click(
                                                cx.listener(|this, _, _, cx| {
                                                    this.files_sidebar_collapsed = false;
                                                    cx.notify();
                                                }),
                                            ),
                                        ),
                                )
                            })
                            .child(match selected_code_view {
                                Some((path, title, editor)) => {
                                    self.render_files_code_preview(&path, &title, editor, cx)
                                }
                                None => self.render_file_preview_empty_state(cx),
                            }),
                    ),
            )
            .into_any_element()
    }

    fn render_files_code_preview(
        &self,
        path: &Path,
        title: &SharedString,
        editor: Entity<Editor>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover_background = ds::hover_background(cx);
        let path_label = self
            .selected_folder
            .as_ref()
            .and_then(|folder| path.strip_prefix(folder).ok())
            .unwrap_or(path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .filter(|parent| !parent.is_empty())
            .unwrap_or_else(|| "Project root".to_string());
        let content_for_copy = editor.read(cx).text(cx);

        v_flex()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(
                h_flex()
                    .h(px(52.))
                    .items_center()
                    .gap_2()
                    .px_3()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.45))
                    .child(
                        Icon::new(Self::file_browser_icon(path))
                            .size(IconSize::Small)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                Label::new(title.clone())
                                    .size(LabelSize::Small)
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(Color::Custom(ds::text(cx)))
                                    .truncate(),
                            )
                            .child(
                                Label::new(SharedString::from(path_label))
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text_muted(cx)))
                                    .truncate(),
                            ),
                    )
                    .child(
                        div()
                            .id("right-panel-files-copy-code")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Copy code"))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    content_for_copy.clone(),
                                ));
                            }))
                            .child(
                                Icon::new(IconName::Copy)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(
                div()
                    .id("right-panel-files-code-editor")
                    .flex_1()
                    .h_full()
                    .min_h_0()
                    .overflow_hidden()
                    .child(editor),
            )
            .into_any_element()
    }

    fn render_file_preview_empty_state(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .gap_3()
            .px_6()
            .child(
                div()
                    .size(px(52.))
                    .rounded(px(12.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_1()
                    .border_color(ds::soft_border(cx))
                    .bg(ds::field_background(cx))
                    .child(
                        Icon::new(IconName::FileCode)
                            .size(IconSize::Medium)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    ),
            )
            .child(
                Label::new("Select a file")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .max_w(px(260.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .line_height(relative(1.44))
                    .text_color(ds::text_muted(cx))
                    .child("Choose a file from the directory to preview its contents here."),
            )
            .into_any_element()
    }

    fn render_file_browser_row(
        &self,
        id: impl Into<SharedString>,
        label: SharedString,
        path: PathBuf,
        is_directory: bool,
        is_selected: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover_background = ds::hover_background(cx);
        let icon = if is_directory {
            IconName::Folder
        } else {
            Self::file_browser_icon(&path)
        };
        let icon_color = if is_selected {
            ds::accent(cx)
        } else if is_directory {
            ds::icon_muted(cx)
        } else {
            ds::text_muted(cx)
        };
        let row_label_color = if is_selected {
            ds::accent(cx)
        } else {
            ds::text(cx)
        };

        h_flex()
            .id(id.into())
            .h(px(34.))
            .w_full()
            .items_center()
            .gap_2()
            .rounded(px(6.))
            .px_2()
            .cursor_pointer()
            .when(is_selected, |el| el.bg(ds::accent(cx).opacity(0.13)))
            .hover(move |el| el.bg(hover_background))
            .on_click(cx.listener(move |this, _, window, cx| {
                if is_directory {
                    this.raw_browse_path = Some(path.clone());
                } else {
                    this.preview_file_in_files_panel(path.as_path(), window, cx);
                }
                cx.notify();
            }))
            .child(
                Icon::new(icon)
                    .size(IconSize::Small)
                    .color(Color::Custom(icon_color)),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Custom(row_label_color))
                    .truncate()
                    .flex_1(),
            )
            .when(is_directory, |el| {
                el.child(
                    Icon::new(IconName::ChevronRight)
                        .size(IconSize::XSmall)
                        .color(Color::Custom(ds::icon_muted(cx))),
                )
            })
            .into_any_element()
    }

    fn render_code_lines(
        &self,
        id: &'static str,
        content: &SharedString,
        is_diff: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let settings = ThemeSettings::get_global(cx);
        let code_font_family = settings.buffer_font.family.clone();
        let lines: Vec<_> = content
            .as_ref()
            .lines()
            .take(500)
            .enumerate()
            .map(|(index, line)| (index + 1, SharedString::from(line.to_string())))
            .collect();

        v_flex()
            .id(id)
            .flex_1()
            .overflow_y_scroll()
            .py_3()
            .children(lines.into_iter().map(|(line_number, line)| {
                let line_text = line.as_ref();
                let is_diff_header = is_diff
                    && (line_text.starts_with("diff --")
                        || line_text.starts_with("---")
                        || line_text.starts_with("+++")
                        || line_text.starts_with("@@"));
                let is_added =
                    is_diff && line_text.starts_with('+') && !line_text.starts_with("+++");
                let is_deleted =
                    is_diff && line_text.starts_with('-') && !line_text.starts_with("---");
                let is_context = is_diff && line_text.starts_with(' ');
                let text_color = if is_added {
                    Color::VersionControlAdded.color(cx)
                } else if is_deleted {
                    Color::VersionControlDeleted.color(cx)
                } else if is_diff_header {
                    ds::text_muted(cx)
                } else {
                    ds::text(cx)
                };
                let added_background = Color::VersionControlAdded.color(cx).opacity(0.08);
                let deleted_background = Color::VersionControlDeleted.color(cx).opacity(0.08);
                let gutter_width = if is_diff { px(32.) } else { px(56.) };
                let gutter_text = if is_diff {
                    if is_added {
                        "+"
                    } else if is_deleted {
                        "-"
                    } else if line_text.starts_with("@@") {
                        "@"
                    } else {
                        ""
                    }
                    .to_string()
                } else {
                    line_number.to_string()
                };
                let display_line = if is_added || is_deleted || is_context {
                    SharedString::from(line_text[1..].to_string())
                } else {
                    line.clone()
                };

                h_flex()
                    .h(px(18.))
                    .w_full()
                    .items_center()
                    .when(is_added, |el| el.bg(added_background))
                    .when(is_deleted, |el| el.bg(deleted_background))
                    .child(
                        div()
                            .w(gutter_width)
                            .h_full()
                            .flex()
                            .items_center()
                            .justify_end()
                            .border_r_1()
                            .border_color(ds::separator(cx))
                            .pr_3()
                            .text_buffer(cx)
                            .font_family(code_font_family.clone())
                            .text_color(ds::text_muted(cx))
                            .line_height(px(18.))
                            .child(gutter_text),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_hidden()
                            .px_2()
                            .text_buffer(cx)
                            .font_family(code_font_family.clone())
                            .text_color(text_color)
                            .line_height(px(18.))
                            .child(display_line),
                    )
            }))
            .into_any_element()
    }

    fn file_browser_icon(path: &Path) -> IconName {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("rs") => IconName::FileRust,
            Some("md" | "mdx") => IconName::FileMarkdown,
            Some("toml") => IconName::FileToml,
            Some("json") => IconName::Json,
            Some("js" | "jsx" | "ts" | "tsx" | "py" | "css" | "html" | "yml" | "yaml") => {
                IconName::FileCode
            }
            _ => IconName::File,
        }
    }

    fn render_code_empty_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.render_empty_artifact_state(cx)
    }

    fn parse_git_diff_file(content: String) -> Option<CodeDiffFile> {
        let mut path = None;
        let mut old_path = None;
        let mut fallback_path = None;
        let mut additions = 0;
        let mut deletions = 0;

        for line in content.lines() {
            if let Some(diff_paths) = line.strip_prefix("diff --git ") {
                fallback_path = diff_paths
                    .split_once(" b/")
                    .map(|(_, path)| path.to_string())
                    .or_else(|| {
                        diff_paths
                            .rsplit_once(' ')
                            .map(|(_, path)| path.to_string())
                    });
            } else if let Some(path_line) = line.strip_prefix("+++ b/") {
                path = Some(path_line.to_string());
            } else if path.is_none()
                && let Some(path_line) = line.strip_prefix("--- a/")
            {
                path = Some(path_line.to_string());
            } else if let Some(path_line) = line.strip_prefix("rename from ") {
                old_path = Some(path_line.to_string());
            } else if let Some(path_line) = line.strip_prefix("rename to ") {
                path = Some(path_line.to_string());
            }

            if line.starts_with('+') && !line.starts_with("+++") {
                additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                deletions += 1;
            }
        }

        let status = if content.contains("\nnew file mode ") {
            CodeDiffFileStatus::Added
        } else if content.contains("\ndeleted file mode ") {
            CodeDiffFileStatus::Deleted
        } else if content.contains("\nrename from ") {
            CodeDiffFileStatus::Renamed
        } else if content.contains("Binary files ") {
            CodeDiffFileStatus::Binary
        } else {
            CodeDiffFileStatus::Modified
        };

        Some(CodeDiffFile {
            path: SharedString::from(path.or(fallback_path)?),
            old_path: old_path.map(SharedString::from),
            status,
            additions,
            deletions,
            content: Some(SharedString::from(content)),
        })
    }

    fn parse_git_diff_numstat(content: &str) -> HashMap<String, (usize, usize)> {
        let mut stats = HashMap::new();
        for line in content.lines() {
            let mut columns = line.split('\t');
            let additions = columns
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or_default();
            let deletions = columns
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or_default();
            let Some(path) = columns.next() else {
                continue;
            };
            stats.insert(path.to_string(), (additions, deletions));
        }
        stats
    }

    fn parse_git_diff_name_status(
        content: &str,
        stats: &HashMap<String, (usize, usize)>,
    ) -> Vec<CodeDiffFile> {
        content
            .lines()
            .filter_map(|line| {
                let mut columns = line.split('\t');
                let status_code = columns.next()?;
                let status = match status_code.chars().next()? {
                    'A' => CodeDiffFileStatus::Added,
                    'D' => CodeDiffFileStatus::Deleted,
                    'R' => CodeDiffFileStatus::Renamed,
                    _ => CodeDiffFileStatus::Modified,
                };
                let old_path = if matches!(status, CodeDiffFileStatus::Renamed) {
                    columns.next().map(SharedString::from)
                } else {
                    None
                };
                let path = columns.next()?;
                let (additions, deletions) = stats.get(path).copied().unwrap_or_default();

                Some(CodeDiffFile {
                    path: SharedString::from(path.to_string()),
                    old_path,
                    status,
                    additions,
                    deletions,
                    content: None,
                })
            })
            .collect()
    }

    fn git_root_for_folder(folder: &Path) -> anyhow::Result<PathBuf> {
        Self::run_git_command(folder, &["rev-parse", "--show-toplevel"]).map(PathBuf::from)
    }

    fn load_git_diff_files_for_folder(folder: &Path) -> anyhow::Result<Vec<CodeDiffFile>> {
        // Auto-initialize git so the diff panel works even on projects that were created
        // before git was initialized, or when the folder is not yet a repository.
        if Self::run_git_command(folder, &["rev-parse", "--is-inside-work-tree"]).is_err() {
            Self::run_git_command(folder, &["init"]).log_err();
        }
        let root = Self::git_root_for_folder(folder)?;
        let name_status = Self::run_git_command_raw(
            &root,
            &["diff", "--name-status", "--find-renames", "HEAD", "--"],
        )
        .or_else(|_| {
            Self::run_git_command_raw(&root, &["diff", "--name-status", "--find-renames"])
        })?;
        let numstat = Self::run_git_command_raw(
            &root,
            &["diff", "--numstat", "--find-renames", "HEAD", "--"],
        )
        .or_else(|_| Self::run_git_command_raw(&root, &["diff", "--numstat", "--find-renames"]))?;
        let stats = Self::parse_git_diff_numstat(&numstat);
        let mut files = Self::parse_git_diff_name_status(&name_status, &stats);

        let untracked_files =
            Self::run_git_command_raw(&root, &["ls-files", "--others", "--exclude-standard", "-z"])
                .unwrap_or_default();
        for path in untracked_files.split('\0').filter(|path| !path.is_empty()) {
            let relative_path = Path::new(path);
            if !root.join(relative_path).is_file()
                || files.iter().any(|file| file.path.as_ref() == path)
            {
                continue;
            }

            files.push(CodeDiffFile {
                path: SharedString::from(path.to_string()),
                old_path: None,
                status: CodeDiffFileStatus::Added,
                additions: 0,
                deletions: 0,
                content: None,
            });
        }

        Ok(files)
    }

    fn load_git_diff_content_for_file(
        folder: &Path,
        path: &str,
        status: CodeDiffFileStatus,
    ) -> anyhow::Result<String> {
        let root = Self::git_root_for_folder(folder)?;
        let content = Self::run_git_command_raw(
            &root,
            &["diff", "--no-color", "--find-renames", "HEAD", "--", path],
        )
        .or_else(|_| {
            Self::run_git_command_raw(&root, &["diff", "--no-color", "--find-renames", "--", path])
        })?;

        if !content.trim().is_empty() || !matches!(status, CodeDiffFileStatus::Added) {
            return Ok(content);
        }

        Self::load_untracked_diff_content(&root, Path::new(path))
    }

    fn load_untracked_diff_content(root: &Path, path: &Path) -> anyhow::Result<String> {
        let absolute_path = root.join(path);
        let display_path = path.to_string_lossy();
        let mut content = format!(
            "diff --git a/{display_path} b/{display_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{display_path}\n"
        );

        let metadata = std::fs::metadata(&absolute_path)
            .with_context(|| format!("failed to read metadata for {}", absolute_path.display()))?;
        if metadata.len() > MAX_UNTRACKED_DIFF_BYTES {
            content.push_str("Binary files /dev/null and b/");
            content.push_str(&display_path);
            content.push_str(" differ\n");
            return Ok(content);
        }

        match std::fs::read_to_string(&absolute_path) {
            Ok(new_text) => {
                content.push_str(&language::unified_diff("", &new_text));
            }
            Err(_) => {
                content.push_str("Binary files /dev/null and b/");
                content.push_str(&display_path);
                content.push_str(" differ\n");
            }
        }

        Ok(content)
    }

    fn render_code_diff_state(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let files = &self.code_diff_state.files;
        let selected_path = match &self.right_panel {
            RightPanel::CodeDiff { selected_path } => selected_path.as_ref(),
            _ => None,
        };
        let selected_file = selected_path
            .and_then(|selected_path| {
                files
                    .iter()
                    .find(|file| file.path.as_ref() == selected_path.as_ref())
            })
            .or_else(|| files.first());

        if let Some(selected_file) = selected_file {
            let total_additions = files.iter().map(|file| file.additions).sum::<usize>();
            let total_deletions = files.iter().map(|file| file.deletions).sum::<usize>();
            let selected_content = selected_file.content.clone();
            let selected_path = selected_file.path.clone();
            let is_selected_content_loading = self
                .code_diff_state
                .loading_content_path
                .as_ref()
                .map(|path| path.as_ref())
                == Some(selected_path.as_ref())
                || selected_content.is_none();

            let files_sidebar_collapsed = self.files_sidebar_collapsed;

            return h_flex()
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_hidden()
                .when(!files_sidebar_collapsed, |el| {
                    el.child(
                        v_flex()
                            .w(px(260.))
                            .h_full()
                            .flex_shrink_0()
                            .overflow_hidden()
                            .border_r_1()
                            .border_color(ds::separator(cx).opacity(0.5))
                            .child(
                                h_flex()
                                    .h(px(52.))
                                    .items_center()
                                    .px_3()
                                    .gap_2()
                                    .border_b_1()
                                    .border_color(ds::separator(cx).opacity(0.45))
                                    .child(
                                        Icon::new(IconName::Split)
                                            .size(IconSize::Small)
                                            .color(Color::Custom(ds::icon_muted(cx))),
                                    )
                                    .child(
                                        v_flex()
                                            .flex_1()
                                            .min_w_0()
                                            .gap_0p5()
                                            .child(
                                                Label::new("Changed files")
                                                    .size(LabelSize::Small)
                                                    .weight(FontWeight::SEMIBOLD)
                                                    .color(Color::Custom(ds::text(cx))),
                                            )
                                            .child(
                                                Label::new(format!(
                                                    "{} files  +{} -{}{}",
                                                    files.len(),
                                                    total_additions,
                                                    total_deletions,
                                                    if self.code_diff_state.loading_files {
                                                        "  refreshing"
                                                    } else {
                                                        ""
                                                    }
                                                ))
                                                .size(LabelSize::XSmall)
                                                .color(Color::Custom(ds::text_muted(cx)))
                                                .truncate(),
                                            ),
                                    )
                                    .child(
                                        IconButton::new(
                                            "diff-collapse-sidebar",
                                            IconName::ChevronLeft,
                                        )
                                        .style(ButtonStyle::Subtle)
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Collapse sidebar"))
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.files_sidebar_collapsed = true;
                                                cx.notify();
                                            }),
                                        ),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .id("artifact-diff-file-list")
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scroll()
                                    .p_2()
                                    .children(files.iter().enumerate().map(|(index, file)| {
                                        let path = file.path.clone();
                                        let is_selected = path.as_ref() == selected_path.as_ref();
                                        let row_id =
                                            SharedString::from(format!("diff-file-{index}"));
                                        let icon_color = if is_selected {
                                            ds::accent(cx)
                                        } else {
                                            file.status.color().color(cx)
                                        };

                                        v_flex()
                                            .id(row_id)
                                            .min_h(px(44.))
                                            .w_full()
                                            .gap_0p5()
                                            .rounded(px(6.))
                                            .px_2()
                                            .py_1()
                                            .cursor_pointer()
                                            .when(is_selected, |el| {
                                                el.bg(ds::accent(cx).opacity(0.14))
                                            })
                                            .hover({
                                                let hover_background = ds::hover_background(cx);
                                                move |el| el.bg(hover_background)
                                            })
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                if let RightPanel::CodeDiff { selected_path } =
                                                    &mut this.right_panel
                                                {
                                                    *selected_path = Some(path.clone());
                                                }
                                                this.load_code_diff_content_for_path(
                                                    path.clone(),
                                                    cx,
                                                );
                                                cx.notify();
                                            }))
                                            .child(
                                                h_flex()
                                                    .w_full()
                                                    .items_center()
                                                    .gap_1p5()
                                                    .child(
                                                        Icon::new(file.status.icon())
                                                            .size(IconSize::XSmall)
                                                            .color(Color::Custom(icon_color)),
                                                    )
                                                    .child(
                                                        Label::new(file.path.clone())
                                                            .size(LabelSize::XSmall)
                                                            .color(Color::Custom(if is_selected {
                                                                ds::accent(cx)
                                                            } else {
                                                                ds::text(cx)
                                                            }))
                                                            .truncate()
                                                            .flex_1(),
                                                    ),
                                            )
                                            .child(
                                                h_flex()
                                                    .ml(px(18.))
                                                    .gap_2()
                                                    .items_center()
                                                    .child(
                                                        Label::new(file.status.label())
                                                            .size(LabelSize::XSmall)
                                                            .color(Color::Custom(ds::text_muted(
                                                                cx,
                                                            ))),
                                                    )
                                                    .child(
                                                        Label::new(format!("+{}", file.additions))
                                                            .size(LabelSize::XSmall)
                                                            .color(Color::VersionControlAdded),
                                                    )
                                                    .child(
                                                        Label::new(format!("-{}", file.deletions))
                                                            .size(LabelSize::XSmall)
                                                            .color(Color::VersionControlDeleted),
                                                    ),
                                            )
                                    })),
                            ),
                    )
                })
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .overflow_hidden()
                        .child(
                            h_flex()
                                .h(px(52.))
                                .items_center()
                                .gap_2()
                                .px_3()
                                .border_b_1()
                                .border_color(ds::separator(cx).opacity(0.45))
                                .when(files_sidebar_collapsed, |el| {
                                    el.child(
                                        IconButton::new(
                                            "diff-expand-sidebar",
                                            IconName::ChevronRight,
                                        )
                                        .style(ButtonStyle::Subtle)
                                        .icon_size(IconSize::Small)
                                        .tooltip(Tooltip::text("Expand sidebar"))
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.files_sidebar_collapsed = false;
                                                cx.notify();
                                            }),
                                        ),
                                    )
                                })
                                .child(
                                    Icon::new(selected_file.status.icon())
                                        .size(IconSize::Small)
                                        .color(selected_file.status.color()),
                                )
                                .child(
                                    v_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .gap_0p5()
                                        .child(
                                            Label::new(selected_file.path.clone())
                                                .size(LabelSize::Small)
                                                .weight(FontWeight::SEMIBOLD)
                                                .color(Color::Custom(ds::text(cx)))
                                                .truncate(),
                                        )
                                        .child(
                                            Label::new(format!(
                                                "{}  +{} -{}",
                                                selected_file.status.label(),
                                                selected_file.additions,
                                                selected_file.deletions
                                            ))
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(ds::text_muted(cx)))
                                            .truncate(),
                                        ),
                                ),
                        )
                        .child(if let Some(selected_content) = selected_content {
                            self.render_code_lines(
                                "artifact-diff-scroll",
                                &selected_content,
                                true,
                                cx,
                            )
                        } else {
                            v_flex()
                                .flex_1()
                                .min_h_0()
                                .items_center()
                                .justify_center()
                                .gap_3()
                                .child(
                                    Icon::new(IconName::LoadCircle)
                                        .size(IconSize::Medium)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                )
                                .child(
                                    Label::new(if is_selected_content_loading {
                                        "Loading diff..."
                                    } else {
                                        "Select a file"
                                    })
                                    .size(LabelSize::Small)
                                    .color(Color::Custom(ds::text_muted(cx))),
                                )
                                .into_any_element()
                        }),
                )
                .into_any_element();
        }

        if self.code_diff_state.loading_files {
            return v_flex()
                .flex_1()
                .min_h_0()
                .items_center()
                .justify_center()
                .gap_3()
                .child(
                    Icon::new(IconName::LoadCircle)
                        .size(IconSize::Medium)
                        .color(Color::Custom(ds::icon_muted(cx))),
                )
                .child(
                    Label::new("Loading changed files...")
                        .size(LabelSize::Small)
                        .color(Color::Custom(ds::text_muted(cx))),
                )
                .into_any_element();
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .gap_3()
            .px_6()
            .child(
                div()
                    .size(px(52.))
                    .rounded(px(12.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_1()
                    .border_color(ds::soft_border(cx))
                    .bg(ds::field_background(cx))
                    .child(
                        Icon::new(IconName::Split)
                            .size(IconSize::Medium)
                            .color(Color::Custom(ds::icon_muted(cx))),
                    ),
            )
            .child(
                Label::new("No diff yet")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::SEMIBOLD)
                    .color(Color::Custom(ds::text(cx))),
            )
            .child(
                div()
                    .max_w(px(280.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .line_height(relative(1.44))
                    .text_color(ds::text_muted(cx))
                    .child(self.code_diff_state.error.clone().unwrap_or_else(|| {
                        SharedString::from(
                            "Code changes will appear here after the agent edits files.",
                        )
                    })),
            )
            .into_any_element()
    }

    fn render_code_file_tree(
        &self,
        selected_title: &SharedString,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover_background = ds::hover_background(cx);
        let mut paths = self.artifact_file_paths(cx);
        if paths.is_empty() {
            paths.push(PathBuf::from(selected_title.as_ref()));
        }

        v_flex()
            .w(px(220.))
            .h_full()
            .flex_shrink_0()
            .overflow_hidden()
            .p_2()
            .border_r_1()
            .border_color(ds::separator(cx).opacity(0.42))
            .child(
                div().px_2().mb_1().child(
                    Label::new("Generated files")
                        .size(LabelSize::XSmall)
                        .color(Color::Custom(ds::text_muted(cx))),
                ),
            )
            .children(paths.into_iter().enumerate().map(|(index, path)| {
                let display_path = self
                    .selected_folder
                    .as_ref()
                    .and_then(|folder| path.strip_prefix(folder).ok())
                    .unwrap_or(path.as_path());
                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                let dir_label = display_path.parent().and_then(|parent| {
                    let label = parent.to_string_lossy();
                    if label.is_empty() {
                        None
                    } else {
                        Some(label.into_owned())
                    }
                });
                let is_selected = file_name == selected_title.as_ref();
                let row_id = SharedString::from(format!("artifact-code-file-{index}"));
                let path_for_click = path.clone();

                v_flex()
                    .id(row_id)
                    .min_h(px(34.))
                    .w_full()
                    .gap_0p5()
                    .rounded(px(4.))
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .when(is_selected, |el| el.bg(ds::accent(cx).opacity(0.16)))
                    .hover(move |el| el.bg(hover_background))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_file_read_only(&path_for_click, window, cx);
                        cx.notify();
                    }))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .items_center()
                            .child(Icon::new(IconName::FileCode).size(IconSize::XSmall).color(
                                Color::Custom(if is_selected {
                                    ds::accent(cx)
                                } else {
                                    ds::icon_muted(cx)
                                }),
                            ))
                            .child(
                                Label::new(file_name)
                                    .size(LabelSize::XSmall)
                                    .color(Color::Custom(ds::text(cx)))
                                    .truncate(),
                            ),
                    )
                    .when_some(dir_label, |el, dir| {
                        el.child(
                            Label::new(SharedString::from(dir))
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx)))
                                .ml(px(18.))
                                .truncate(),
                        )
                    })
            }))
    }

    fn render_code_artifact_state(
        &self,
        title: &SharedString,
        editor: Entity<Editor>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .child(self.render_code_file_tree(title, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_hidden()
                    .child(
                        div()
                            .id("artifact-code-editor")
                            .flex_1()
                            .h_full()
                            .min_h_0()
                            .overflow_hidden()
                            .child(editor),
                    ),
            )
    }

    fn browser_address_label(preview_url: Option<&String>) -> SharedString {
        let Some(preview_url) = preview_url else {
            return SharedString::from("about:blank");
        };

        let display_url = preview_url
            .strip_prefix("https://")
            .or_else(|| preview_url.strip_prefix("http://"))
            .or_else(|| preview_url.strip_prefix("file://"))
            .unwrap_or(preview_url.as_str())
            .trim_end_matches('/');

        if display_url.is_empty() {
            SharedString::from(preview_url.clone())
        } else {
            SharedString::from(display_url.to_string())
        }
    }

    fn render_right_panel(
        &self,
        is_running: bool,
        preview_url: Option<String>,
        preview_dominant: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.active_right_panel_tab.is_none() {
            return self.render_right_panel_blank(window, cx);
        }

        let is_code_view = matches!(
            self.right_panel,
            RightPanel::CodeDiff { .. } | RightPanel::CodeView { .. }
        );
        let is_diff_view = matches!(self.right_panel, RightPanel::CodeDiff { .. });
        if self.right_panel_mode == RightPanelMode::Launcher {
            return self.render_right_panel_launcher(window, cx);
        }

        if matches!(self.right_panel, RightPanel::Preview) {
            let has_webview = self.web_preview.is_some();
            let has_failed_artifact = self.has_failed_tool_call(cx);
            let workspace = cx.entity().downgrade();
            let available_preview_url = preview_url.clone();
            let content = if has_failed_artifact {
                self.render_artifact_error_state(cx).into_any_element()
            } else if has_webview {
                canvas(
                    move |bounds, window, cx| {
                        let viewport_height = f32::from(window.viewport_size().height);
                        if let Some(ws) = workspace.upgrade() {
                            if let Some(preview) = ws.read(cx).web_preview.as_ref() {
                                preview.set_frame(bounds, viewport_height);
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .flex_1()
                .w_full()
                .into_any_element()
            } else if let Some(preview_url) = preview_url.clone()
                && !self.is_preview_generating
            {
                self.render_browser_external_fallback(preview_url, cx)
                    .into_any_element()
            } else if is_running || self.is_preview_generating {
                self.render_artifact_working_state(cx).into_any_element()
            } else {
                self.render_design_preview_fallback(cx).into_any_element()
            };

            return v_flex()
                .when(preview_dominant, |el| el.flex_1())
                .when(!preview_dominant, |el| {
                    el.flex_1().min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
                })
                .h_full()
                .overflow_hidden()
                .bg(ds::app_background(cx))
                .child(
                    self.render_artifact_browser_shell(
                        self.preview_visible
                            .then_some(available_preview_url)
                            .flatten(),
                        content,
                        window,
                        cx,
                    ),
                )
                .into_any_element();
        }

        let has_webview = self.web_preview.is_some();
        let has_failed_artifact = self.has_failed_tool_call(cx);
        let workspace = cx.entity().downgrade();
        let artifact_title = self.artifact_title();
        let panel_title = match &self.right_panel {
            RightPanel::CodeDiff { .. } => SharedString::from("Diff"),
            RightPanel::CodeView { title, .. } => title.clone(),
            RightPanel::Preview => artifact_title.clone(),
        };
        let hover_background = ds::hover_background(cx);
        let preview_url_for_browser = preview_url.clone();
        let code_content_for_copy = match &self.right_panel {
            RightPanel::CodeView { editor, .. } => Some(editor.read(cx).text(cx)),
            _ => None,
        };

        v_flex()
            .when(preview_dominant, |el| el.flex_1())
            .when(!preview_dominant, |el| {
                el.flex_1().min_w(px(ds::RIGHT_PANEL_MIN_WIDTH))
            })
            .h_full()
            .overflow_hidden()
            .bg(ds::app_background(cx))
            .child(
                h_flex()
                    .h(px(52.))
                    .px_5()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(ds::separator(cx).opacity(0.42))
                    .child(self.render_right_panel_option_tabs(window, cx))
                    .when(!is_diff_view, |el| {
                        el.child(
                            Icon::new(if is_code_view {
                                IconName::Split
                            } else {
                                IconName::Public
                            })
                            .size(IconSize::Small)
                            .color(Color::Custom(ds::icon_muted(cx))),
                        )
                        .child(
                            Label::new(panel_title.clone())
                                .size(LabelSize::Small)
                                .color(Color::Custom(ds::text_muted(cx)))
                                .truncate(),
                        )
                    })
                    .child(div().flex_1())
                    .when(is_code_view && !is_diff_view, |el| {
                        el.child(
                            div()
                                .id("artifact-copy-code")
                                .size(px(16.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .tooltip(Tooltip::text("Copy code"))
                                .when_some(code_content_for_copy, |el, content| {
                                    el.cursor_pointer()
                                        .hover(move |el| el.bg(hover_background))
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                content.clone(),
                                            ));
                                        }))
                                })
                                .child(
                                    Icon::new(IconName::Copy)
                                        .size(IconSize::Small)
                                        .color(Color::Custom(ds::icon_muted(cx))),
                                ),
                        )
                    })
                    .child(self.render_right_panel_expand_button("artifact-expand-panel", cx))
                    .child(
                        div()
                            .id("artifact-close-panel")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover_background))
                            .tooltip(Tooltip::text("Close panel"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_right_panel(window, cx);
                            }))
                            .child(
                                Icon::new(IconName::Close)
                                    .size(IconSize::Small)
                                    .color(Color::Custom(ds::icon_muted(cx))),
                            ),
                    ),
            )
            .child(match &self.right_panel {
                RightPanel::CodeDiff { .. } => self.render_code_diff_state(cx).into_any_element(),
                RightPanel::CodeView { title, editor, .. } => self
                    .render_code_artifact_state(title, editor.clone(), cx)
                    .into_any_element(),
                RightPanel::Preview => {
                    let browser_url = preview_url_for_browser.clone();
                    let content = if has_failed_artifact {
                        self.render_artifact_error_state(cx).into_any_element()
                    } else if has_webview {
                        canvas(
                            move |bounds, window, cx| {
                                let viewport_height = f32::from(window.viewport_size().height);
                                if let Some(ws) = workspace.upgrade() {
                                    if let Some(preview) = ws.read(cx).web_preview.as_ref() {
                                        preview.set_frame(bounds, viewport_height);
                                    }
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .flex_1()
                        .w_full()
                        .into_any_element()
                    } else if let Some(preview_url) = preview_url_for_browser.clone()
                        && !self.is_preview_generating
                    {
                        self.render_browser_external_fallback(preview_url, cx)
                            .into_any_element()
                    } else if is_running || self.is_preview_generating {
                        self.render_artifact_working_state(cx).into_any_element()
                    } else {
                        self.render_design_preview_fallback(cx).into_any_element()
                    };

                    self.render_artifact_browser_shell(browser_url, content, window, cx)
                        .into_any_element()
                }
            })
            .into_any_element()
    }

    fn render_share_dialog(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .size_full()
            .inset_0()
            .occlude()
            .bg(gpui::black().opacity(0.35))
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.share_dialog_open = false;
                    cx.notify();
                }),
            )
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(480.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(ds::soft_border(cx))
                    .bg(ds::card_background(cx))
                    .shadow_sm()
                    .occlude()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        v_flex()
                            .gap_3()
                            .p_6()
                            .child(
                                Label::new("Share this workspace")
                                    .size(LabelSize::Custom(rems_from_px(18.)))
                                    .weight(FontWeight::SEMIBOLD)
                                    .color(Color::Custom(ds::text(cx))),
                            )
                            .child(
                                div()
                                    .text_size(rems_from_px(13.))
                                    .text_color(ds::text_muted(cx))
                                    .line_height(relative(1.46))
                                    .child("Invite someone to review the result or try the IDE with this project."),
                            )
                            .child(
                                div()
                                    .text_size(rems_from_px(13.))
                                    .text_color(ds::text_muted(cx))
                                    .line_height(relative(1.46))
                                    .child("Your project is ready. Share it with a teammate, reviewer, or friend."),
                            )
                            .child(
                                h_flex()
                                    .h(px(36.))
                                    .items_center()
                                    .gap_2()
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(ds::soft_border(cx))
                                    .bg(ds::field_background(cx))
                                    .px_3()
                                    .child(
                                        Label::new("backboard.dev/share/project-dashboard")
                                            .size(LabelSize::Small)
                                            .color(Color::Custom(ds::text(cx)))
                                            .truncate(),
                                    )
                                    .child(div().flex_1())
                                    .child(
                                        Button::new("copy-share-link", "Copy")
                                            .style(ButtonStyle::Subtle)
                                            .size(ButtonSize::Compact)
                                            .label_size(LabelSize::XSmall),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .gap_2()
                                    .child(
                                        Label::new("Send invite to")
                                            .size(LabelSize::XSmall)
                                            .color(Color::Custom(ds::text_muted(cx))),
                                    )
                                    .child(
                                        h_flex()
                                            .h(px(36.))
                                            .items_center()
                                            .rounded(px(8.))
                                            .border_1()
                                            .border_color(ds::soft_border(cx))
                                            .bg(ds::field_background(cx))
                                            .px_3()
                                            .child(
                                                Label::new("teammate@example.com")
                                                    .size(LabelSize::Small)
                                                    .color(Color::Custom(ds::text_disabled(cx))),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .h(px(64.))
                            .px_6()
                            .gap_2()
                            .items_center()
                            .justify_end()
                            .border_t_1()
                            .border_color(ds::separator(cx))
                            .child(
                                Button::new("share-maybe-later", "Maybe later")
                                    .style(ButtonStyle::Subtle)
                                    .size(ButtonSize::Medium)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.share_dialog_open = false;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("share-workspace", "Share")
                                    .style(ButtonStyle::Filled)
                                    .size(ButtonSize::Medium)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.share_dialog_open = false;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }

    fn render_api_status_banner(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .h(px(28.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(ds::chip_background(cx))
            .child(div().size(px(6.)).rounded_full().bg(ds::warning(cx)))
            .child(
                Label::new("API not connected")
                    .size(LabelSize::XSmall)
                    .color(Color::Custom(ds::text_disabled(cx))),
            )
    }

    fn render_api_key_required(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .max_w(px(380.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .child(
                Icon::new(IconName::Info)
                    .size(IconSize::Custom(rems_from_px(24.)))
                    .color(Color::Muted),
            )
            .child(
                Label::new("API key required")
                    .size(LabelSize::Custom(rems_from_px(15.)))
                    .weight(FontWeight::BOLD)
                    .color(Color::Default),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .text_center()
                    .text_size(rems_from_px(13.))
                    .text_color(cx.theme().colors().text_muted)
                    .line_height(relative(1.32))
                    .child("Connect an API key to start chats, run agents, and generate output."),
            )
            .child(
                Button::new("simple-configure-api-key", "Connect API key")
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
                    .text_color(cx.theme().colors().text_disabled)
                    .line_height(relative(1.32))
                    .child("You can still view the project manually."),
            )
    }

    fn render_composer_footer_trigger(
        &self,
        icon: IconName,
        label: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        h_flex()
            .h(px(28.))
            .min_w_0()
            .items_center()
            .gap_1p5()
            .child(
                Icon::new(icon)
                    .size(IconSize::Small)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
            .child(
                Label::new(label)
                    .size(LabelSize::Small)
                    .color(Color::Custom(ds::text_muted(cx)))
                    .truncate(),
            )
            .child(
                Icon::new(IconName::ChevronDown)
                    .size(IconSize::XSmall)
                    .color(Color::Custom(ds::icon_muted(cx))),
            )
            .into_any_element()
    }

    fn composer_folder_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let selected_folder = self.selected_folder.clone();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            if let Some(folder) = selected_folder.as_ref() {
                menu = menu
                    .item(
                        ContextMenuEntry::new(folder.to_string_lossy().into_owned())
                            .icon(IconName::Folder)
                            .icon_position(IconPosition::Start)
                            .disabled(true),
                    )
                    .separator();
            }

            let label = if selected_folder.is_some() {
                "Change folder"
            } else {
                "Choose folder"
            };
            menu.item(
                ContextMenuEntry::new(label)
                    .icon(IconName::FolderOpen)
                    .icon_position(IconPosition::Start)
                    .handler(move |window, cx| {
                        beginner_workspace
                            .update(cx, |this, cx| {
                                this.pick_folder(window, cx);
                            })
                            .log_err();
                    }),
            )
        })
    }

    fn composer_branch_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ContextMenu> {
        let beginner_workspace = cx.entity().downgrade();
        let selected_folder = self.selected_folder.clone();
        let git_state = self.composer_git_state.clone();

        ContextMenu::build(window, cx, move |mut menu, _window, _cx| {
            if selected_folder.is_none() {
                let choose_workspace = beginner_workspace.clone();
                return menu.item(
                    ContextMenuEntry::new("Choose folder")
                        .icon(IconName::FolderOpen)
                        .icon_position(IconPosition::Start)
                        .handler(move |window, cx| {
                            choose_workspace
                                .update(cx, |this, cx| {
                                    this.pick_folder(window, cx);
                                })
                                .log_err();
                        }),
                );
            }

            if git_state.is_loading {
                return menu.item(ContextMenuEntry::new("Checking Git...").disabled(true));
            }

            if !git_state.is_git_repository {
                let initialize_workspace = beginner_workspace.clone();
                return menu.item(
                    ContextMenuEntry::new("Initialize Git repository")
                        .icon(IconName::GitBranch)
                        .icon_position(IconPosition::Start)
                        .handler(move |window, cx| {
                            initialize_workspace
                                .update(cx, |this, cx| {
                                    this.initialize_composer_git_repository(window, cx);
                                })
                                .log_err();
                        }),
                );
            }

            if git_state.branches.is_empty() {
                return menu.item(ContextMenuEntry::new("No local branches").disabled(true));
            }

            for branch in git_state.branches {
                let is_current = git_state
                    .current_branch
                    .as_ref()
                    .is_some_and(|current| current.as_ref() == branch.as_ref());
                let branch_name = branch.to_string();
                let switch_workspace = beginner_workspace.clone();
                menu = menu.item(
                    ContextMenuEntry::new(branch)
                        .icon(IconName::GitBranch)
                        .icon_position(IconPosition::Start)
                        .toggle(IconPosition::End, is_current)
                        .disabled(is_current)
                        .handler(move |window, cx| {
                            switch_workspace
                                .update(cx, |this, cx| {
                                    this.switch_composer_git_branch(
                                        branch_name.clone(),
                                        window,
                                        cx,
                                    );
                                })
                                .log_err();
                        }),
                );
            }

            menu
        })
    }

    fn render_composer_footer(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let folder_label = self
            .selected_folder
            .as_ref()
            .map(|folder| folder_display_name(folder))
            .unwrap_or_else(|| SharedString::from("Choose folder"));

        let branch_label = if self.selected_folder.is_none() {
            SharedString::from("No folder")
        } else if self.composer_git_state.is_loading {
            SharedString::from("Checking Git")
        } else if let Some(branch) = self.composer_git_state.current_branch.clone() {
            branch
        } else if self.composer_git_state.is_git_repository {
            SharedString::from("Detached HEAD")
        } else {
            SharedString::from("Connect Git")
        };

        h_flex()
            .w_full()
            .items_center()
            .gap_3()
            .px_1()
            .pt_1p5()
            .pb_0()
            .child(
                DropdownMenu::new_with_element(
                    "simple-composer-folder",
                    self.render_composer_footer_trigger(IconName::FolderOpen, folder_label, cx),
                    self.composer_folder_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .no_chevron(),
            )
            .child(
                DropdownMenu::new_with_element(
                    "simple-composer-branch",
                    self.render_composer_footer_trigger(IconName::GitBranch, branch_label, cx),
                    self.composer_branch_menu(window, cx),
                )
                .style(DropdownStyle::Ghost)
                .trigger_size(ButtonSize::None)
                .no_chevron(),
            )
            .child(div().flex_1())
            .into_any_element()
    }

    fn render_input_bar(
        &self,
        is_running: bool,
        is_connecting: bool,
        draft_is_empty: bool,
        centered: bool,
        api_key_ready: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !api_key_ready {
            return v_flex()
                .flex_shrink_0()
                .h(px(56.))
                .w_full()
                .px_4()
                .pt_2()
                .pb_3()
                .bg(ds::app_background(cx))
                .child(
                    h_flex()
                        .h(px(36.))
                        .w_full()
                        .items_center()
                        .rounded_lg()
                        .bg(cx.theme().colors().element_background.opacity(0.5))
                        .px_3()
                        .child(
                            Label::new("API key required")
                                .size(LabelSize::Small)
                                .color(Color::Disabled),
                        ),
                )
                .into_any_element();
        }

        let colors = cx.theme().colors().clone();
        let composer_surface_bg = colors
            .surface_background
            .blend(colors.element_background.opacity(0.24));
        let composer_border = colors.border_variant.opacity(0.82);
        let composer_hover_border = colors.border_variant.opacity(0.96);
        let root_composer_focus =
            self.active_conversation_view
                .as_ref()
                .and_then(|conversation_view| {
                    conversation_view
                        .read(cx)
                        .root_message_editor_focus_handle(cx)
                });
        if let Some(conversation_view) = self.active_conversation_view.clone()
            && let Some(composer) = conversation_view.update(cx, |conversation_view, cx| {
                conversation_view.render_embedded_root_message_editor(window, cx)
            })
        {
            let composer_shell = v_flex()
                .key_context("AcpThread")
                .w_full()
                .rounded(px(18.))
                .overflow_hidden()
                .border_1()
                .border_color(composer_border)
                .hover(move |el| el.border_color(composer_hover_border))
                .bg(composer_surface_bg)
                .when_some(root_composer_focus, |el, focus_handle| {
                    el.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        window.focus(&focus_handle, cx);
                    })
                })
                .child(composer)
                .into_any_element();
            let composer = v_flex()
                .w_full()
                .when(centered, |el| el.max_w(px(ds::CHAT_MAX_WIDTH)))
                .gap_1()
                .child(composer_shell)
                .child(self.render_composer_footer(window, cx))
                .into_any_element();

            return v_flex()
                .flex_shrink_0()
                .w_full()
                .when(centered, |el| el.items_center())
                .when(!centered, |el| el.px_2().pt_1().pb_1p5())
                .child(composer)
                .when(is_connecting, |el| {
                    el.child(
                        h_flex().justify_end().child(
                            Label::new("Connecting...")
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(ds::text_muted(cx))),
                        ),
                    )
                })
                .into_any_element();
        }

        let is_disabled = is_running || is_connecting || draft_is_empty || !api_key_ready;
        let icon_hover_bg = ds::hover_background(cx);
        let next_mode = match self.chat_mode {
            ChatMode::Ask => ChatMode::Build,
            ChatMode::Build => ChatMode::Ask,
        };
        let focus_handle = self.chat_editor.focus_handle(cx);
        let colors = cx.theme().colors().clone();
        let editor_focused = focus_handle.is_focused(window);
        let editor_bg_color = colors
            .panel_background
            .blend(colors.editor_background.opacity(0.18));
        let composer_surface_bg = colors
            .surface_background
            .blend(colors.element_background.opacity(0.24));
        let composer_border = if editor_focused {
            colors.border_focused
        } else {
            colors.border_variant.opacity(0.82)
        };
        let composer_hover_border = if editor_focused {
            colors.border_focused
        } else {
            colors.border_variant.opacity(0.96)
        };

        v_flex()
            .flex_shrink_0()
            .w_full()
            .items_center()
            .bg(editor_bg_color)
            .px_2()
            .pt_1()
            .pb_1p5()
            .child(
                v_flex()
                    .w_full()
                    .when(centered, |el| el.max_w(px(ds::CHAT_MAX_WIDTH)))
                    .child(
                        v_flex()
                            .w_full()
                            .max_w_full()
                            .flex_shrink()
                            .flex_grow()
                            .justify_between()
                            .min_h(px(92.))
                            .rounded(px(18.))
                            .border_1()
                            .border_color(composer_border)
                            .hover(move |el| el.border_color(composer_hover_border))
                            .bg(composer_surface_bg)
                            .track_focus(&focus_handle)
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                window.focus(&focus_handle, cx);
                            })
                            .px_3()
                            .pt_2()
                            .pb_1p5()
                            .child(self.chat_editor.clone())
                            .child(
                                h_flex()
                                    .w_full()
                                    .flex_none()
                                    .items_center()
                                    .justify_between()
                                    .flex_wrap()
                                    .gap_1()
                                    .mt_0p5()
                                    .pt_1()
                                    .border_t_1()
                                    .border_color(colors.border_variant.opacity(0.22))
                                    .child(
                                        div()
                                            .id("simple-add-folder")
                                            .when(centered, |el| el.size(px(24.)))
                                            .when(!centered, |el| el.size(px(24.)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.))
                                            .cursor_pointer()
                                            .hover(move |el| el.bg(icon_hover_bg))
                                            .tooltip(Tooltip::text("Attach project root directory"))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.pick_folder(window, cx);
                                            }))
                                            .child(
                                                Icon::new(IconName::Plus)
                                                    .size(IconSize::Small)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .when_some(self.selected_folder.as_ref(), |el, folder| {
                                        let folder_name = folder
                                            .file_name()
                                            .map(|name| name.to_string_lossy().into_owned())
                                            .unwrap_or_else(|| {
                                                folder.to_string_lossy().into_owned()
                                            });
                                        el.child(
                                            h_flex()
                                                .min_w_0()
                                                .gap_1p5()
                                                .items_center()
                                                .child(
                                                    Icon::new(IconName::Folder)
                                                        .size(IconSize::XSmall)
                                                        .color(Color::Custom(ds::icon_muted(cx))),
                                                )
                                                .child(
                                                    Label::new(folder_name)
                                                        .size(LabelSize::XSmall)
                                                        .color(Color::Custom(ds::text(cx)))
                                                        .truncate(),
                                                ),
                                        )
                                    })
                                    .when_some(self.model_selector.clone(), |el, selector| {
                                        el.child(selector)
                                    })
                                    .child(div().flex_1())
                                    .child(
                                        h_flex()
                                            .id("simple-mode-toggle")
                                            .gap_1()
                                            .items_center()
                                            .min_w(px(48.))
                                            .px_1p5()
                                            .rounded(px(4.))
                                            .overflow_hidden()
                                            .when(
                                                !is_running && !is_connecting && api_key_ready,
                                                |el| {
                                                    el.cursor_pointer()
                                                        .hover(move |el| el.bg(icon_hover_bg))
                                                        .tooltip(Tooltip::text("Switch chat mode"))
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.set_chat_mode(
                                                                    next_mode, window, cx,
                                                                );
                                                            },
                                                        ))
                                                },
                                            )
                                            .child(
                                                div()
                                                    .size(px(10.))
                                                    .rounded(px(2.))
                                                    .bg(ds::status_dot(cx)),
                                            )
                                            .child(
                                                Label::new(self.chat_mode.label())
                                                    .size(LabelSize::Small)
                                                    .color(Color::Custom(ds::mode_text(cx))),
                                            )
                                            .child(
                                                Icon::new(IconName::ChevronDown)
                                                    .size(IconSize::XSmall)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("simple-mic")
                                            .when(centered, |el| el.size(px(24.)))
                                            .when(!centered, |el| el.size(px(24.)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.))
                                            .tooltip(Tooltip::text("Voice input"))
                                            .child(
                                                Icon::new(IconName::Mic)
                                                    .size(IconSize::Small)
                                                    .color(Color::Custom(ds::icon_muted(cx))),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id("simple-send")
                                            .size(px(32.))
                                            .rounded(px(8.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .when(!is_disabled, |el| {
                                                el.cursor_pointer()
                                                    .hover(move |el| el.bg(icon_hover_bg))
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.submit_follow_up(window, cx);
                                                    }))
                                            })
                                            .when(!api_key_ready, |el| {
                                                el.tooltip(Tooltip::text(
                                                    "Enter a Backboard API key to use AI features.",
                                                ))
                                            })
                                            .child(
                                                Icon::new(IconName::Send)
                                                    .size(IconSize::Medium)
                                                    .color(Color::Custom(if is_disabled {
                                                        ds::icon_muted(cx)
                                                    } else {
                                                        ds::accent(cx)
                                                    })),
                                            ),
                                    ),
                            ),
                    ),
            )
            .when(is_connecting, |el| {
                el.child(
                    h_flex().justify_end().child(
                        Label::new("Connecting...")
                            .size(LabelSize::XSmall)
                            .color(Color::Custom(ds::text_muted(cx))),
                    ),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str, name: &str, provider: &str) -> AgentModelInfo {
        AgentModelInfo {
            id: acp::ModelId::new(id),
            name: SharedString::from(name),
            description: Some(SharedString::from(provider)),
            icon: None,
            is_latest: false,
            cost: None,
        }
    }

    #[test]
    fn fallback_model_for_unsupported_simple_selection_uses_first_live_model() {
        let stale_model = model("deepseek/deepseek-r1", "DeepSeek R1", "deepseek");
        let live_model = model(
            "openrouter/000ADI/Qwen2.5-0.5B-Instruct-Gensyn-Swarm-grazing_bellowing_locust",
            "Qwen2.5 Swarm",
            "openrouter",
        );
        let model_list = AgentModelList::Flat(vec![live_model.clone()]);

        let fallback =
            fallback_model_for_unsupported_simple_selection(&model_list, Some(&stale_model))
                .expect("stale model should pick a live fallback");

        assert_eq!(fallback.id.to_string(), live_model.id.to_string());
    }

    #[test]
    fn fallback_model_for_unsupported_simple_selection_keeps_supported_model() {
        let live_model = model(
            "openrouter/000ADI/Qwen2.5-0.5B-Instruct-Gensyn-Swarm-grazing_bellowing_locust",
            "Qwen2.5 Swarm",
            "openrouter",
        );
        let model_list = AgentModelList::Flat(vec![live_model.clone()]);

        assert!(
            fallback_model_for_unsupported_simple_selection(&model_list, Some(&live_model))
                .is_none()
        );
    }

    #[test]
    fn curated_model_labels_distinguish_same_provider_variants() {
        let model_list = AgentModelList::Flat(vec![
            model("anthropic/claude-opus-4-20250514", "Claude", "anthropic"),
            model("anthropic/claude-sonnet-4-20250514", "Claude", "anthropic"),
            model("anthropic/claude-3-5-haiku-20241022", "Claude", "anthropic"),
        ]);

        let AgentModelList::Flat(models) = curated_or_live_model_list(model_list) else {
            panic!("expected flat model list");
        };
        let names = models
            .iter()
            .map(|model| model.name.to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "Claude Opus 4 (maximum reasoning)",
                "Claude Sonnet 4 (balanced coding)",
                "Claude 3.5 Haiku (fast)",
            ]
        );
    }

    #[test]
    fn curated_model_labels_match_openrouter_model_prefixes() {
        let model_list = AgentModelList::Flat(vec![model(
            "openrouter/anthropic/claude-sonnet-4-20250514",
            "Claude",
            "openrouter",
        )]);

        let AgentModelList::Flat(models) = curated_or_live_model_list(model_list) else {
            panic!("expected flat model list");
        };

        assert_eq!(
            models[0].name.to_string(),
            "Claude Sonnet 4 (balanced coding)"
        );
    }

    #[test]
    fn similar_prior_project_match_finds_project_in_another_folder() {
        let records = vec![BeginnerChatRecord {
            id: "project-a".to_string(),
            name: "Mario kart game".to_string(),
            folder_path: "/tmp/project-a".to_string(),
            session_id: None,
            timestamp_ms: 1,
        }];

        let matched =
            similar_prior_project_match(&records, "make a Mario Kart game", Path::new("/tmp/b"));

        assert_eq!(matched.map(|record| record.id.as_str()), Some("project-a"));
    }

    #[test]
    fn project_history_terms_split_punctuation() {
        let terms = project_history_terms("make a Mario-Kart game");

        assert!(terms.contains("mario"));
        assert!(terms.contains("kart"));
        assert!(terms.contains("game"));
    }

    #[test]
    fn similar_prior_project_match_ranks_best_project() {
        let records = vec![
            BeginnerChatRecord {
                id: "weaker".to_string(),
                name: "Mario game".to_string(),
                folder_path: "/tmp/project-a".to_string(),
                session_id: None,
                timestamp_ms: 2,
            },
            BeginnerChatRecord {
                id: "stronger".to_string(),
                name: "Mario kart battle game".to_string(),
                folder_path: "/tmp/project-b".to_string(),
                session_id: None,
                timestamp_ms: 1,
            },
        ];

        let matched =
            similar_prior_project_match(&records, "make a Mario Kart game", Path::new("/tmp/c"));

        assert_eq!(matched.map(|record| record.id.as_str()), Some("stronger"));
    }

    #[test]
    fn similar_prior_project_match_ignores_current_folder() {
        let records = vec![BeginnerChatRecord {
            id: "project-a".to_string(),
            name: "Mario kart game".to_string(),
            folder_path: "/tmp/project-a".to_string(),
            session_id: None,
            timestamp_ms: 1,
        }];

        let matched = similar_prior_project_match(
            &records,
            "make a Mario Kart game",
            Path::new("/tmp/project-a"),
        );

        assert!(matched.is_none());
    }

    #[test]
    fn similar_prior_project_match_ignores_generic_single_term_matches() {
        let records = vec![BeginnerChatRecord {
            id: "project-a".to_string(),
            name: "Racing game".to_string(),
            folder_path: "/tmp/project-a".to_string(),
            session_id: None,
            timestamp_ms: 1,
        }];

        let matched = similar_prior_project_match(&records, "make a game", Path::new("/tmp/b"));

        assert!(matched.is_none());
    }

    #[test]
    fn explicit_another_copy_prompt_skips_confirmation_gate() {
        assert!(prompt_explicitly_requests_another_copy(
            "make a Mario Kart game again in this folder"
        ));
    }

    #[test]
    fn remote_project_records_extract_durable_thread_metadata() {
        let threads = vec![json!({
            "id": "remote-thread-a",
            "title": "Mario kart game",
            "metadata": {
                "workspace_path": "/Users/test/project-a"
            },
            "updated_at": "2026-06-03T12:00:00Z"
        })];

        let records = remote_project_records_from_threads(&threads);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].thread_id, "remote-thread-a");
        assert_eq!(records[0].title, "Mario kart game");
        assert_eq!(
            records[0].workspace_path.as_deref(),
            Some(Path::new("/Users/test/project-a"))
        );
    }

    #[test]
    fn similar_remote_project_match_uses_thread_content_not_session_id() {
        let threads = vec![json!({
            "thread_id": "remote-thread-a",
            "title": "Backboard",
            "messages": [
                {
                    "role": "user",
                    "content": "make a Mario Kart racing game with drifting and item boxes"
                }
            ]
        })];
        let records = remote_project_records_from_threads(&threads);

        let matched = similar_remote_project_match(&records, "make a Mario Kart game");

        assert_eq!(
            matched.map(|record| record.thread_id.as_str()),
            Some("remote-thread-a")
        );
    }

    #[test]
    fn similar_remote_project_match_ranks_best_project_context() {
        let threads = vec![
            json!({
                "thread_id": "remote-thread-a",
                "title": "Mario game",
            }),
            json!({
                "thread_id": "remote-thread-b",
                "title": "Backboard",
                "messages": [
                    {
                        "role": "user",
                        "content": "make a Mario Kart battle game with drifting"
                    }
                ]
            }),
        ];
        let records = remote_project_records_from_threads(&threads);

        let matched = similar_remote_project_match(&records, "make a Mario Kart game");

        assert_eq!(
            matched.map(|record| record.thread_id.as_str()),
            Some("remote-thread-b")
        );
    }

    #[test]
    fn remote_build_on_top_message_includes_prior_thread_context() {
        let record = RemoteProjectRecord {
            thread_id: "remote-thread-a".to_string(),
            title: "Mario kart game".to_string(),
            workspace_path: Some(PathBuf::from("/Users/test/project-a")),
            updated_at: None,
            search_text: "Mario kart game".to_string(),
        };

        let message = remote_build_on_top_message(
            &record,
            Some("user: make a Mario Kart game\n\nassistant: created a racing prototype"),
            "add a battle mode",
        );

        assert!(message.contains("remote-thread-a"));
        assert!(message.contains("/Users/test/project-a"));
        assert!(message.contains("created a racing prototype"));
        assert!(message.contains("add a battle mode"));
    }
}
