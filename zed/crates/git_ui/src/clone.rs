use askpass::{AskPassDelegate, AskPassResult, AskPassSession};
use futures::{FutureExt as _, select_biased};
use gpui::{App, BackgroundExecutor, Context, WeakEntity, Window};
use notifications::status_toast::StatusToast;
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

            let clone_task = workspace
                .update_in(cx, |_workspace, window, cx| {
                    let destination_dir = destination_dir.clone();
                    let repo_url = repo_url.clone();
                    let askpass = crate::askpass_modal::askpass_delegate(
                        "git clone",
                        cx.weak_entity(),
                        window.window_handle(),
                        &mut cx.to_async(),
                    );
                    let executor = cx.background_executor().clone();
                    cx.spawn(async move |_workspace, _cx| {
                        git_clone_with_askpass(
                            destination_dir.as_path(),
                            &repo_url,
                            askpass,
                            executor,
                        )
                        .await
                    })
                })
                .ok()?;

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

async fn git_clone_with_askpass(
    destination_dir: &std::path::Path,
    repo_url: &str,
    askpass: AskPassDelegate,
    executor: BackgroundExecutor,
) -> anyhow::Result<()> {
    let mut askpass = AskPassSession::new(executor, askpass).await?;
    let git_process = new_command("git")
        .current_dir(destination_dir)
        .env("GIT_ASKPASS", askpass.script_path())
        .env("SSH_ASKPASS", askpass.script_path())
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(&["clone", repo_url])
        .spawn()?;

    select_biased! {
        result = askpass.run().fuse() => {
            match result {
                AskPassResult::CancelledByUser => anyhow::bail!(git::repository::REMOTE_CANCELLED_BY_USER),
                AskPassResult::Timedout => anyhow::bail!("Connecting to host timed out"),
            }
        }
        output = git_process.output().fuse() => {
            let output = output?;
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
