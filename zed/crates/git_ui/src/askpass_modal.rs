use crate::github_account::{GitHubAccountState, GitHubAccountStore, GitHubPromptKind};
use askpass::EncryptedPassword;
use client::Client;
use editor::Editor;
use futures::channel::oneshot;
use gpui::{
    AnyWindowHandle, AppContext, AsyncApp, DismissEvent, Entity, EventEmitter, Focusable, Styled,
    Subscription, Task, WeakEntity,
};
use std::sync::Arc;
use ui::{
    ActiveTheme, AnyElement, App, Button, Clickable, Color, Context, DynamicSpacing, FluentBuilder,
    Headline, HeadlineSize, Icon, IconName, IconSize, InteractiveElement, IntoElement, Label,
    LabelCommon, LabelSize, ParentElement, Render, SharedString, StyledExt, StyledTypography,
    Window, div, h_flex, v_flex,
};
use util::maybe;
use workspace::ModalView;
use workspace::Workspace;
use zeroize::Zeroize;

pub(crate) fn askpass_delegate(
    operation: impl Into<SharedString>,
    workspace: WeakEntity<Workspace>,
    window: AnyWindowHandle,
    cx: &mut AsyncApp,
) -> git::repository::AskPassDelegate {
    let operation = operation.into();
    git::repository::AskPassDelegate::new(cx, move |prompt, tx, cx| {
        if let Some(prompt_kind) = GitHubPromptKind::parse(&prompt) {
            let workspace = workspace.clone();
            let operation = operation.clone();
            let window = window;
            cx.spawn(async move |cx| {
                let client = workspace
                    .read_with(cx, |workspace, _| workspace.client().clone())
                    .ok();

                if let Some(client) = client.clone() {
                    match crate::github_account::load_valid_credentials(client, cx).await {
                        Ok(Some(credentials)) => {
                            if let Ok(response) = prompt_kind.response(&credentials) {
                                tx.send(response).ok();
                                return;
                            }
                        }
                        Ok(None) => {}
                        Err(error) => log::warn!("failed to load GitHub credentials: {error:#}"),
                    }
                }

                if let Some(client) = client {
                    window
                        .update(cx, |_, window, cx| {
                            workspace.update(cx, |workspace, cx| {
                                workspace.toggle_modal(window, cx, |window, cx| {
                                    AskPassModal::new_github(
                                        operation.clone(),
                                        prompt.into(),
                                        prompt_kind,
                                        client,
                                        tx,
                                        window,
                                        cx,
                                    )
                                });
                            })
                        })
                        .ok();
                }
            })
            .detach();
            return;
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
}

pub(crate) struct AskPassModal {
    operation: SharedString,
    prompt: SharedString,
    editor: Entity<Editor>,
    tx: Option<oneshot::Sender<EncryptedPassword>>,
    github_prompt_kind: Option<GitHubPromptKind>,
    github_account: Option<Entity<GitHubAccountStore>>,
    github_client: Option<Arc<Client>>,
    github_response_task: Option<Task<()>>,
    _github_subscription: Option<Subscription>,
}

impl EventEmitter<DismissEvent> for AskPassModal {}
impl ModalView for AskPassModal {}
impl Focusable for AskPassModal {
    fn focus_handle(&self, cx: &App) -> gpui::FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl AskPassModal {
    pub fn new(
        operation: SharedString,
        prompt: SharedString,
        tx: oneshot::Sender<EncryptedPassword>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let editor = cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            if prompt.contains("yes/no") || prompt.contains("Username") {
                editor.set_masked(false, cx);
            } else {
                editor.set_masked(true, cx);
            }
            editor
        });
        Self {
            operation,
            prompt,
            editor,
            tx: Some(tx),
            github_prompt_kind: None,
            github_account: None,
            github_client: None,
            github_response_task: None,
            _github_subscription: None,
        }
    }

    pub fn new_github(
        operation: SharedString,
        prompt: SharedString,
        prompt_kind: GitHubPromptKind,
        client: Arc<Client>,
        tx: oneshot::Sender<EncryptedPassword>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let editor = cx.new(|cx| {
            let mut editor = Editor::single_line(window, cx);
            editor.set_masked(false, cx);
            editor
        });
        let github_account = cx.new(|cx| GitHubAccountStore::new(client.clone(), cx));
        let github_subscription = cx.observe(&github_account, |this, _, cx| {
            this.try_send_github_response(cx);
            cx.notify();
        });

        Self {
            operation,
            prompt,
            editor,
            tx: Some(tx),
            github_prompt_kind: Some(prompt_kind),
            github_account: Some(github_account),
            github_client: Some(client),
            github_response_task: None,
            _github_subscription: Some(github_subscription),
        }
    }

    fn cancel(&mut self, _: &menu::Cancel, _window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(DismissEvent);
    }

    fn confirm(&mut self, _: &menu::Confirm, window: &mut Window, cx: &mut Context<Self>) {
        maybe!({
            let tx = self.tx.take()?;
            let mut text = self.editor.update(cx, |this, cx| {
                let text = this.text(cx);
                this.clear(window, cx);
                text
            });
            let pw = askpass::EncryptedPassword::try_from(text.as_ref()).ok()?;
            text.zeroize();
            tx.send(pw).ok();
            Some(())
        });

        cx.emit(DismissEvent);
    }

    fn render_hint(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let color = cx.theme().status().info_background;
        if self.github_account.is_some() {
            return None;
        }
        if (self.prompt.contains("Password") || self.prompt.contains("Username"))
            && self.prompt.contains("github.com")
        {
            return Some(
            div()
                .p_2()
                .bg(color)
                .border_t_1()
                .border_color(cx.theme().status().info_border)
                .child(
                    h_flex().gap_2()
                        .child(
                            Icon::new(IconName::Github).size(IconSize::Small)
                        )
                        .child(
                            Label::new("You may need to configure git for Github.")
                                .size(LabelSize::Small),
                        )
                        .child(Button::new("learn-more", "Learn more").color(Color::Accent).label_size(LabelSize::Small).on_click(|_, _, cx| {
                            cx.open_url("https://docs.github.com/en/get-started/git-basics/set-up-git#authenticating-with-github-from-git")
                        })),
                )
                .into_any_element(),
        );
        }
        None
    }

    fn try_send_github_response(&mut self, cx: &mut Context<Self>) {
        if self.github_response_task.is_some() {
            return;
        }

        let Some(tx) = self.tx.take() else {
            return;
        };
        let Some(prompt_kind) = self.github_prompt_kind else {
            self.tx = Some(tx);
            return;
        };
        let Some(client) = self.github_client.clone() else {
            self.tx = Some(tx);
            return;
        };
        let signed_in = self
            .github_account
            .as_ref()
            .map(|account| {
                matches!(
                    account.read(cx).state(),
                    GitHubAccountState::SignedIn { .. }
                )
            })
            .unwrap_or(false);
        if !signed_in {
            self.tx = Some(tx);
            return;
        }

        self.github_response_task = Some(cx.spawn(async move |this, cx| {
            let result = async {
                let credentials = crate::github_account::load_valid_credentials(client, cx)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("GitHub credentials were not stored"))?;
                prompt_kind.response(&credentials)
            }
            .await;

            this.update(cx, |this, cx| {
                match result {
                    Ok(response) => {
                        tx.send(response).ok();
                        cx.emit(DismissEvent);
                    }
                    Err(error) => {
                        log::warn!("failed to answer GitHub askpass prompt: {error:#}");
                        this.github_response_task = None;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn render_github_sign_in(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let account = self.github_account.clone()?;
        let state = account.read(cx).state().clone();

        let content = match state {
            GitHubAccountState::Checking => v_flex()
                .gap_2()
                .child(Label::new("Checking GitHub sign-in...").size(LabelSize::Small)),
            GitHubAccountState::SignedOut => v_flex().gap_2().child(
                Button::new("github-sign-in", "Sign in with GitHub")
                    .start_icon(Icon::new(IconName::Github).size(IconSize::Small))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(account) = this.github_account.clone() {
                            account.update(cx, |account, cx| account.sign_in(cx));
                        }
                    })),
            ),
            GitHubAccountState::SigningIn {
                user_code,
                verification_uri,
                status,
            } => v_flex()
                .gap_2()
                .child(Label::new(status).size(LabelSize::Small))
                .child(
                    h_flex()
                        .gap_2()
                        .child(Label::new(user_code.clone()).size(LabelSize::Large))
                        .child(Button::new("copy-github-code", "Copy").on_click(
                            move |_, _, cx| {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                    user_code.to_string(),
                                ));
                            },
                        )),
                )
                .child(
                    Button::new("open-github-device", "Open GitHub")
                        .on_click(move |_, _, cx| cx.open_url(&verification_uri)),
                ),
            GitHubAccountState::SignedIn { login, .. } => v_flex()
                .gap_2()
                .child(Label::new(format!("Signed in to GitHub as {login}")).size(LabelSize::Small))
                .child(Label::new("Continuing git authentication...").size(LabelSize::Small)),
            GitHubAccountState::Error { message, sso_url } => {
                let sso_url_for_button = sso_url.clone();
                v_flex()
                    .gap_2()
                    .child(
                        Label::new(message)
                            .size(LabelSize::Small)
                            .color(Color::Error),
                    )
                    .when_some(sso_url_for_button, |this, sso_url| {
                        this.child(
                            Button::new("open-github-sso", "Authorize SSO")
                                .on_click(move |_, _, cx| cx.open_url(&sso_url)),
                        )
                    })
                    .child(
                        Button::new("retry-github-sign-in", "Sign in with GitHub")
                            .start_icon(Icon::new(IconName::Github).size(IconSize::Small))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(account) = this.github_account.clone() {
                                    account.update(cx, |account, cx| account.sign_in(cx));
                                }
                            })),
                    )
            }
        };

        Some(
            v_flex()
                .gap_3()
                .p_3()
                .child(Label::new("GitHub authentication required").size(LabelSize::Small))
                .child(content)
                .into_any_element(),
        )
    }
}

impl Render for AskPassModal {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.try_send_github_response(cx);

        v_flex()
            .key_context("PasswordPrompt")
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::confirm))
            .elevation_2(cx)
            .size_full()
            .child(
                h_flex()
                    .font_buffer(cx)
                    .px(DynamicSpacing::Base12.rems(cx))
                    .pt(DynamicSpacing::Base08.rems(cx))
                    .pb(DynamicSpacing::Base04.rems(cx))
                    .rounded_t_sm()
                    .w_full()
                    .gap_1p5()
                    .child(Icon::new(IconName::GitBranch).size(IconSize::XSmall))
                    .child(h_flex().gap_1().overflow_x_hidden().child(
                        div().max_w_96().overflow_x_hidden().text_ellipsis().child(
                            Headline::new(self.operation.clone()).size(HeadlineSize::XSmall),
                        ),
                    )),
            )
            .child(
                div()
                    .font_buffer(cx)
                    .text_buffer(cx)
                    .py_2()
                    .px_3()
                    .bg(cx.theme().colors().editor_background)
                    .border_t_1()
                    .border_color(cx.theme().colors().border_variant)
                    .size_full()
                    .overflow_hidden()
                    .child(self.prompt.clone())
                    .when(self.github_account.is_none(), |this| {
                        this.child(self.editor.clone())
                    })
                    .children(self.render_github_sign_in(cx)),
            )
            .children(self.render_hint(cx))
    }
}
