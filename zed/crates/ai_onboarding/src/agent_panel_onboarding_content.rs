use std::sync::Arc;

use client::{Client, UserStore};
use gpui::{Entity, IntoElement, ParentElement};
use language_model::{LanguageModelRegistry, ZED_CLOUD_PROVIDER_ID};
use ui::prelude::*;

use crate::AgentPanelOnboardingCard;

pub struct AgentPanelOnboarding {
    has_configured_providers: bool,
    continue_with_zed_ai: Arc<dyn Fn(&mut Window, &mut App)>,
}

impl AgentPanelOnboarding {
    pub fn new(
        _user_store: Entity<UserStore>,
        _client: Arc<Client>,
        continue_with_zed_ai: impl Fn(&mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.subscribe(
            &LanguageModelRegistry::global(cx),
            |this: &mut Self, _registry, event: &language_model::Event, cx| match event {
                language_model::Event::ProviderStateChanged(_)
                | language_model::Event::AddedProvider(_)
                | language_model::Event::RemovedProvider(_)
                | language_model::Event::ProvidersChanged => {
                    this.has_configured_providers = Self::has_configured_providers(cx)
                }
                _ => {}
            },
        )
        .detach();

        Self {
            has_configured_providers: Self::has_configured_providers(cx),
            continue_with_zed_ai: Arc::new(continue_with_zed_ai),
        }
    }

    fn has_configured_providers(cx: &App) -> bool {
        LanguageModelRegistry::read_global(cx)
            .visible_providers()
            .iter()
            .any(|provider| provider.is_authenticated(cx) && provider.id() != ZED_CLOUD_PROVIDER_ID)
    }
}

impl Render for AgentPanelOnboarding {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let dismiss = self.continue_with_zed_ai.clone();

        AgentPanelOnboardingCard::new().child(
            v_flex()
                .w_full()
                .relative()
                .gap_3()
                .child(v_flex().gap_1().child(Headline::new("Zed Agent")).child(
                    Label::new("Chat with Zed Agent against this workspace.").color(Color::Muted),
                ))
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            Label::new("Use models and tools configured in Zed")
                                .color(Color::Muted),
                        )
                        .child(
                            Label::new("Streams runs, tool calls, and file edits here")
                                .color(Color::Muted),
                        )
                        .child(
                            Label::new("Reads and writes files through the IDE workspace")
                                .color(Color::Muted),
                        ),
                )
                .child(
                    Button::new("start-zed-agent-chat", "Start Zed Agent Chat")
                        .full_width()
                        .style(ButtonStyle::Tinted(ui::TintColor::Accent))
                        .on_click(move |_, window, cx| dismiss(window, cx)),
                ),
        )
    }
}
