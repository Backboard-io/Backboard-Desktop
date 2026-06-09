use crate::askpass_modal::AskPassModal;
use anyhow::{Context as _, anyhow};
use askpass::AskPassDelegate;
use futures::{FutureExt as _, select_biased};
use git::repository::{AskPassResult, AskPassSession};
use gpui::{App, BackgroundExecutor, Context, WeakEntity, Window};
use notifications::status_toast::StatusToast;
use std::path::PathBuf;
use std::sync::Arc;
use ui::{Color, Icon, IconName, IconSize, SharedString};
use util::ResultExt;
use util::command::new_command;
use workspace::{self, Workspace};

pub fn clone_and_open(
    repo_url: SharedString,
    workspace: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
    on_success: Arc<
        dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + Send + Sync + 'static,
    >,
) {
    let destination_prompt = cx.prompt_for_paths(gpui::PathPromptOptions {
        files: false,
        directories: true,
        multiple: false,
        prompt: Some("Select as Repository Destination".into()),
    });
    let askpass_delegate = askpass_delegate("clone", workspace.clone(), window, cx);
    let background_executor = cx.background_executor().clone();

    window
        .spawn(cx, async move |cx| {
            let mut paths = destination_prompt.await.ok()?.ok()??;
            let mut destination_dir = paths.pop()?;

            let repo_name = repo_url
                .split('/')
                .next_back()
                .map(|name| name.strip_suffix(".git").unwrap_or(name))
                .unwrap_or("repository")
                .to_owned();

            let clone_task = background_executor.spawn({
                let background_executor = background_executor.clone();
                let destination_dir = destination_dir.clone();
                let repo_url = repo_url.clone();
                async move {
                    git_clone_with_askpass(
                        destination_dir,
                        repo_url,
                        askpass_delegate,
                        background_executor,
                    )
                    .await
                }
            });

            if let Err(error) = clone_task.await {
                workspace
                    .update(cx, |workspace, cx| {
                        let toast = StatusToast::new(error.to_string(), cx, |this, _| {
                            this.icon(
                                Icon::new(IconName::XCircle)
                                    .size(IconSize::Small)
                                    .color(Color::Error),
                            )
                            .dismiss_button(true)
                        });
                        workspace.toggle_status_toast(toast, cx);
                    })
                    .log_err();
                return None;
            }

            let has_worktrees = workspace
                .read_with(cx, |workspace, cx| {
                    workspace.project().read(cx).worktrees(cx).next().is_some()
                })
                .ok()?;

            let prompt_answer = if has_worktrees {
                cx.update(|window, cx| {
                    window.prompt(
                        gpui::PromptLevel::Info,
                        &format!("Git Clone: {}", repo_name),
                        None,
                        &["Add repo to project", "Open repo in new project"],
                        cx,
                    )
                })
                .ok()?
                .await
                .ok()?
            } else {
                // Don't ask if project is empty
                0
            };

            destination_dir.push(&repo_name);

            match prompt_answer {
                0 => {
                    workspace
                        .update_in(cx, |workspace, window, cx| {
                            let create_task = workspace.project().update(cx, |project, cx| {
                                project.create_worktree(destination_dir.as_path(), true, cx)
                            });

                            let workspace_weak = cx.weak_entity();
                            let on_success = on_success.clone();
                            cx.spawn_in(window, async move |_window, cx| {
                                if create_task.await.log_err().is_some() {
                                    workspace_weak
                                        .update_in(cx, |workspace, window, cx| {
                                            (on_success)(workspace, window, cx);
                                        })
                                        .ok();
                                }
                            })
                            .detach();
                        })
                        .ok()?;
                }
                1 => {
                    workspace
                        .update(cx, move |workspace, cx| {
                            let app_state = workspace.app_state().clone();
                            let destination_path = destination_dir.clone();
                            let on_success = on_success.clone();

                            workspace::open_new(
                                Default::default(),
                                app_state,
                                cx,
                                move |workspace, window, cx| {
                                    cx.activate(true);

                                    let create_task =
                                        workspace.project().update(cx, |project, cx| {
                                            project.create_worktree(
                                                destination_path.as_path(),
                                                true,
                                                cx,
                                            )
                                        });

                                    let workspace_weak = cx.weak_entity();
                                    cx.spawn_in(window, async move |_window, cx| {
                                        if create_task.await.log_err().is_some() {
                                            workspace_weak
                                                .update_in(cx, |workspace, window, cx| {
                                                    (on_success)(workspace, window, cx);
                                                })
                                                .ok();
                                        }
                                    })
                                    .detach();
                                },
                            )
                            .detach();
                        })
                        .ok();
                }
                _ => {}
            }

            Some(())
        })
        .detach();
}

fn askpass_delegate(
    operation: impl Into<SharedString>,
    workspace: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> AskPassDelegate {
    let operation = operation.into();
    let window = window.window_handle();
    AskPassDelegate::new(&mut cx.to_async(), move |prompt, tx, cx| {
        let workspace = workspace.clone();
        let operation = operation.clone();
        let window = window.clone();
        cx.spawn(async move |cx| {
            match crate::github_account::askpass_response_for_prompt(&prompt, cx).await {
                Ok(Some(response)) => {
                    tx.send(response).ok();
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!("failed to load GitHub credential for askpass: {error}");
                }
            }

            window
                .update(cx, |_, window, cx| {
                    workspace.update(cx, |workspace, cx| {
                        workspace.toggle_modal(window, cx, |window, cx| {
                            AskPassModal::new(operation.clone(), prompt.into(), tx, window, cx)
                        });
                    })
                })
                .ok();
        })
        .detach();
    })
}

async fn git_clone_with_askpass(
    destination_dir: PathBuf,
    repo_url: SharedString,
    askpass_delegate: AskPassDelegate,
    background_executor: BackgroundExecutor,
) -> anyhow::Result<()> {
    let mut askpass = AskPassSession::new(background_executor.clone(), askpass_delegate).await?;
    let mut command = new_command("git");
    command
        .current_dir(destination_dir)
        .args(["clone", repo_url.as_ref()])
        .env("GIT_ASKPASS", askpass.script_path())
        .env("SSH_ASKPASS", askpass.script_path())
        .env("SSH_ASKPASS_REQUIRE", "force");
    let git_process = command.spawn()?;

    select_biased! {
        result = askpass.run().fuse() => {
            match result {
                AskPassResult::CancelledByUser => Err(anyhow!("git clone cancelled by user")),
                AskPassResult::Timedout => Err(anyhow!("Connecting to host timed out")),
            }
        }
        output = git_process.output().fuse() => {
            let output = output.context("failed to run git clone")?;
            if !output.status.success() {
                anyhow::bail!(
                    "git clone failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }

            Ok(())
        }
    }
}
