use askpass::EncryptedPassword;
use client::Client;
use editor::Editor;
use futures::channel::oneshot;
use gpui::{AppContext, DismissEvent, Entity, EventEmitter, Focusable, Styled};
use ui::{
    ActiveTheme, AnyElement, App, Button, Clickable, Color, Context, Disableable, DynamicSpacing,
    FluentBuilder, Headline, HeadlineSize, Icon, IconName, IconSize, InteractiveElement,
    IntoElement, Label, LabelCommon, LabelSize, ParentElement, Render, SharedString, StyledExt,
    StyledTypography, Window, div, h_flex, v_flex,
};
use util::maybe;
use workspace::ModalView;
use zeroize::Zeroize;

pub(crate) struct AskPassModal {
    operation: SharedString,
    prompt: SharedString,
    editor: Entity<Editor>,
    tx: Option<oneshot::Sender<EncryptedPassword>>,
    github_user_code: Option<SharedString>,
    github_sign_in_error: Option<SharedString>,
    is_signing_in_to_github: bool,
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
            github_user_code: None,
            github_sign_in_error: None,
            is_signing_in_to_github: false,
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

    fn is_github_prompt(&self) -> bool {
        crate::github_account::is_github_askpass_prompt(&self.prompt)
    }

    fn sign_in_to_github(&mut self, cx: &mut Context<Self>) {
        if self.is_signing_in_to_github {
            return;
        }

        let Some(tx) = self.tx.take() else {
            return;
        };
        self.is_signing_in_to_github = true;
        self.github_sign_in_error = None;
        cx.notify();

        let prompt = self.prompt.to_lowercase();
        cx.spawn(async move |this, cx| {
            let client = cx.update(|cx| Client::global(cx));
            let this_for_code = this.clone();
            let result =
                crate::github_account::sign_in_and_store(client, cx, move |user_code, cx| {
                    this_for_code
                        .update(cx, |this, cx| {
                            this.github_user_code = Some(user_code);
                            cx.notify();
                        })
                        .ok();
                })
                .await
                .and_then(|credentials| {
                    crate::github_account::encrypted_response_for_prompt(&prompt, credentials)
                });

            this.update(cx, |this, cx| {
                match result {
                    Ok(Some(response)) => {
                        tx.send(response).ok();
                        cx.emit(DismissEvent);
                    }
                    Ok(None) => {
                        this.github_sign_in_error =
                            Some("GitHub did not ask for a username or password.".into());
                    }
                    Err(error) => {
                        this.github_sign_in_error = Some(error.to_string().into());
                    }
                }
                this.is_signing_in_to_github = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn render_github_sign_in(&mut self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .gap_1p5()
                    .child(Icon::new(IconName::Github).size(IconSize::Small))
                    .child(Label::new("Sign in with GitHub").size(LabelSize::Small)),
            )
            .child(
                Label::new("Backboard needs your GitHub sign-in to continue this Git operation.")
                    .color(Color::Muted)
                    .size(LabelSize::Small),
            )
            .when_some(self.github_user_code.clone(), |this, user_code| {
                this.child(
                    v_flex()
                        .gap_1()
                        .child(
                            Label::new("Enter this code in the GitHub browser window:")
                                .color(Color::Muted)
                                .size(LabelSize::Small),
                        )
                        .child(Label::new(user_code).size(LabelSize::Large)),
                )
            })
            .when_some(self.github_sign_in_error.clone(), |this, error| {
                this.child(Label::new(error).color(Color::Error).size(LabelSize::Small))
            })
            .child(
                Button::new("github-sign-in", "Sign in with GitHub")
                    .start_icon(Icon::new(IconName::Github).size(IconSize::XSmall))
                    .label_size(LabelSize::Small)
                    .disabled(self.is_signing_in_to_github)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.sign_in_to_github(cx);
                    })),
            )
            .into_any_element()
    }
}

impl Render for AskPassModal {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .child({
                let content = div()
                    .font_buffer(cx)
                    .text_buffer(cx)
                    .py_2()
                    .px_3()
                    .bg(cx.theme().colors().editor_background)
                    .border_t_1()
                    .border_color(cx.theme().colors().border_variant)
                    .size_full()
                    .overflow_hidden();

                if self.is_github_prompt() {
                    content.child(self.render_github_sign_in(cx))
                } else {
                    content
                        .child(self.prompt.clone())
                        .child(self.editor.clone())
                }
            })
    }
}
