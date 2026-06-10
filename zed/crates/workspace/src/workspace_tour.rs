use gpui::{App, Div, FontWeight, Hsla, Window, deferred, hsla, px, relative, rgb};
use ui::{Color, Label, LabelSize, prelude::*};

use crate::multi_workspace::MultiWorkspace;

pub type WorkspaceTourClickHandler = Box<dyn Fn(&mut Window, &mut App) + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceTourStep {
    Menu,
    SimpleMode,
    AgentWorkspace,
    CodeEditor,
    Composer,
    ModelSelection,
    AgentOptions,
    VoiceControl,
    Skills,
    McpTools,
    DirectoryPanel,
    GitPanel,
    BottomBar,
    SimpleModeChats,
    SimpleModePrompt,
    SimpleModeOutput,
    SimpleModeSwitcher,
    TutorialModelSelection,
    TutorialAgentOptions,
    TutorialSkills,
    TutorialPrompt,
}

impl WorkspaceTourStep {
    pub const TOTAL: usize = 13;
    pub const SIMPLE_MODE_TOTAL: usize = 4;
    pub const TUTORIAL_TOTAL: usize = 4;

    pub fn index(self) -> usize {
        match self {
            Self::Menu => 1,
            Self::SimpleMode => 2,
            Self::AgentWorkspace => 3,
            Self::CodeEditor => 4,
            Self::Composer => 5,
            Self::ModelSelection => 6,
            Self::AgentOptions => 7,
            Self::VoiceControl => 8,
            Self::Skills => 9,
            Self::McpTools => 10,
            Self::DirectoryPanel => 11,
            Self::GitPanel => 12,
            Self::BottomBar => 13,
            Self::SimpleModeChats => 1,
            Self::SimpleModePrompt => 2,
            Self::SimpleModeOutput => 3,
            Self::SimpleModeSwitcher => 4,
            Self::TutorialModelSelection => 1,
            Self::TutorialAgentOptions => 2,
            Self::TutorialSkills => 3,
            Self::TutorialPrompt => 4,
        }
    }

    pub fn target(self) -> &'static str {
        match self {
            Self::Menu => "Menu",
            Self::SimpleMode => "Simple Mode",
            Self::AgentWorkspace => "Agent Workspace",
            Self::CodeEditor => "Code Editor",
            Self::Composer => "Composer",
            Self::ModelSelection => "Model Picker",
            Self::AgentOptions => "Agent Options",
            Self::VoiceControl => "Voice",
            Self::Skills => "Skills",
            Self::McpTools => "MCP Tools",
            Self::DirectoryPanel => "Directory",
            Self::GitPanel => "Git",
            Self::BottomBar => "Bottom Icons",
            Self::SimpleModeChats => "Chats",
            Self::SimpleModePrompt => "Prompt",
            Self::SimpleModeOutput => "Output",
            Self::SimpleModeSwitcher => "Modes",
            Self::TutorialModelSelection => "Model",
            Self::TutorialAgentOptions => "Agent Options",
            Self::TutorialSkills => "Skills",
            Self::TutorialPrompt => "First Prompt",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Menu => "Switch views",
            Self::SimpleMode => "Use Simple Mode",
            Self::AgentWorkspace => "Plan with agents",
            Self::CodeEditor => "Edit code",
            Self::Composer => "Send a chat",
            Self::ModelSelection => "Pick a model",
            Self::AgentOptions => "Tune agent options",
            Self::VoiceControl => "Use voice mode",
            Self::Skills => "Use skills",
            Self::McpTools => "Use MCP tools",
            Self::DirectoryPanel => "Browse files",
            Self::GitPanel => "Review changes",
            Self::BottomBar => "Open lower panels",
            Self::SimpleModeChats => "Find your chats",
            Self::SimpleModePrompt => "Describe what to build",
            Self::SimpleModeOutput => "Review the output",
            Self::SimpleModeSwitcher => "Switch modes",
            Self::TutorialModelSelection => "Select a model",
            Self::TutorialAgentOptions => "Choose agent options",
            Self::TutorialSkills => "Review skills",
            Self::TutorialPrompt => "Send the test prompt",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Menu => "Jump between the editor, agents, Git, and Simple Mode.",
            Self::SimpleMode => {
                "Use Simple Mode for focused app-building chats, project previews, and recent work."
            }
            Self::AgentWorkspace => "Use this for larger AI tasks and repo-wide changes.",
            Self::CodeEditor => "Inspect and edit the files.",
            Self::Composer => "Type a request in chat, then send it to the agent.",
            Self::ModelSelection => "Choose the model for speed, cost, or deeper reasoning.",
            Self::AgentOptions => "Open agent options to choose how the agent plans and edits.",
            Self::VoiceControl => "Use voice mode when you want to dictate the prompt.",
            Self::Skills => "Skills add reusable workflows to the composer.",
            Self::McpTools => "MCP tools connect the agent to external capabilities.",
            Self::DirectoryPanel => {
                "Use the left directory to open, create, rename, and move files."
            }
            Self::GitPanel => "Use Git to inspect diffs, stage files, commit, and switch branches.",
            Self::BottomBar => {
                "Click icons to open terminal, diagnostics, Git/search, language, and status menus."
            }
            Self::SimpleModeChats => {
                "Recent chats live here. Start a new chat or reopen previous work from the sidebar."
            }
            Self::SimpleModePrompt => {
                "Type the page, feature, or change you want. Attach a folder when Backboard should work in a project."
            }
            Self::SimpleModeOutput => {
                "Use the output panel for previews, generated files, code changes, and terminals."
            }
            Self::SimpleModeSwitcher => {
                "Use this menu when you need the full code editor or agent workspace."
            }
            Self::TutorialModelSelection => {
                "Pick the model you want to use for the sample repo task."
            }
            Self::TutorialAgentOptions => {
                "Choose how the agent should plan and apply changes for this run."
            }
            Self::TutorialSkills => "Skills can tailor the agent to a specific workflow.",
            Self::TutorialPrompt => "Send the prefilled prompt to make the first sample change.",
        }
    }

    pub fn progress_label(self) -> String {
        let total = if self.is_simple_mode_step() {
            Self::SIMPLE_MODE_TOTAL
        } else if self.is_tutorial_step() {
            Self::TUTORIAL_TOTAL
        } else {
            Self::TOTAL
        };
        let prefix = if self.is_simple_mode_step() {
            "Simple tour"
        } else if self.is_tutorial_step() {
            "Tutorial"
        } else {
            "Step"
        };

        format!("{prefix} {} of {total} - {}", self.index(), self.target())
    }

    pub fn is_simple_mode_step(self) -> bool {
        matches!(
            self,
            Self::SimpleModeChats
                | Self::SimpleModePrompt
                | Self::SimpleModeOutput
                | Self::SimpleModeSwitcher
        )
    }

    pub fn is_tutorial_step(self) -> bool {
        matches!(
            self,
            Self::TutorialModelSelection
                | Self::TutorialAgentOptions
                | Self::TutorialSkills
                | Self::TutorialPrompt
        )
    }

    pub fn next(self) -> Option<Self> {
        match self {
            Self::Menu => Some(Self::SimpleMode),
            Self::SimpleMode => Some(Self::AgentWorkspace),
            Self::AgentWorkspace => Some(Self::CodeEditor),
            Self::CodeEditor => Some(Self::Composer),
            Self::Composer => Some(Self::ModelSelection),
            Self::ModelSelection => Some(Self::AgentOptions),
            Self::AgentOptions => Some(Self::VoiceControl),
            Self::VoiceControl => Some(Self::Skills),
            Self::Skills => Some(Self::McpTools),
            Self::McpTools => Some(Self::DirectoryPanel),
            Self::DirectoryPanel => Some(Self::GitPanel),
            Self::GitPanel => Some(Self::BottomBar),
            Self::BottomBar => None,
            Self::SimpleModeChats => Some(Self::SimpleModePrompt),
            Self::SimpleModePrompt => Some(Self::SimpleModeOutput),
            Self::SimpleModeOutput => Some(Self::SimpleModeSwitcher),
            Self::SimpleModeSwitcher => None,
            Self::TutorialModelSelection => Some(Self::TutorialAgentOptions),
            Self::TutorialAgentOptions => Some(Self::TutorialSkills),
            Self::TutorialSkills => Some(Self::TutorialPrompt),
            Self::TutorialPrompt => None,
        }
    }

    pub fn previous(self) -> Option<Self> {
        match self {
            Self::Menu => None,
            Self::SimpleMode => Some(Self::Menu),
            Self::AgentWorkspace => Some(Self::SimpleMode),
            Self::CodeEditor => Some(Self::AgentWorkspace),
            Self::Composer => Some(Self::CodeEditor),
            Self::ModelSelection => Some(Self::Composer),
            Self::AgentOptions => Some(Self::ModelSelection),
            Self::VoiceControl => Some(Self::AgentOptions),
            Self::Skills => Some(Self::VoiceControl),
            Self::McpTools => Some(Self::Skills),
            Self::DirectoryPanel => Some(Self::McpTools),
            Self::GitPanel => Some(Self::DirectoryPanel),
            Self::BottomBar => Some(Self::GitPanel),
            Self::SimpleModeChats => None,
            Self::SimpleModePrompt => Some(Self::SimpleModeChats),
            Self::SimpleModeOutput => Some(Self::SimpleModePrompt),
            Self::SimpleModeSwitcher => Some(Self::SimpleModeOutput),
            Self::TutorialModelSelection => None,
            Self::TutorialAgentOptions => Some(Self::TutorialModelSelection),
            Self::TutorialSkills => Some(Self::TutorialAgentOptions),
            Self::TutorialPrompt => Some(Self::TutorialSkills),
        }
    }
}

#[derive(Clone, Copy)]
pub enum WorkspaceTourPlacement {
    BelowRight,
    AboveRight,
    BottomLeft,
    InsideTop,
    InsideTopBelowWindowControls,
    TopLeft,
    TopRight,
}

pub(crate) struct WorkspaceTourHandlers {
    pub previous: Option<WorkspaceTourClickHandler>,
    pub next: WorkspaceTourClickHandler,
    pub skip: WorkspaceTourClickHandler,
}

pub(crate) fn workspace_tour_handlers(step: WorkspaceTourStep) -> WorkspaceTourHandlers {
    WorkspaceTourHandlers {
        previous: step.previous().map(|previous_step| {
            Box::new(move |window: &mut Window, cx: &mut App| {
                if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
                    window.defer(cx, move |window, cx| {
                        multi_workspace.update(cx, |multi_workspace, cx| {
                            multi_workspace.go_to_workspace_tour_step(previous_step, window, cx);
                        });
                    });
                }
            }) as WorkspaceTourClickHandler
        }),
        next: Box::new(move |window: &mut Window, cx: &mut App| {
            if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
                window.defer(cx, move |window, cx| {
                    multi_workspace.update(cx, |multi_workspace, cx| {
                        if let Some(next_step) = step.next() {
                            multi_workspace.go_to_workspace_tour_step(next_step, window, cx);
                        } else {
                            multi_workspace.finish_workspace_tour(window, cx);
                        }
                    });
                });
            }
        }),
        skip: Box::new(|window: &mut Window, cx: &mut App| {
            if let Some(multi_workspace) = window.root::<MultiWorkspace>().flatten() {
                window.defer(cx, move |window, cx| {
                    multi_workspace.update(cx, |multi_workspace, cx| {
                        multi_workspace.finish_workspace_tour(window, cx);
                    });
                });
            }
        }),
    }
}

pub fn render_workspace_tour_target(
    target: Div,
    step: WorkspaceTourStep,
    placement: WorkspaceTourPlacement,
    cx: &App,
) -> Div {
    decorate_workspace_tour_target(target, step, placement, workspace_tour_handlers(step), cx)
}

pub fn render_workspace_tour_highlight(target: Div, cx: &App) -> Div {
    let palette = WorkspaceTourPalette::new(cx);
    target.relative().child(
        deferred(
            div()
                .absolute()
                .inset_0()
                .rounded(px(8.))
                .border_2()
                .border_color(palette.highlight_border)
                .bg(palette.highlight_fill),
        )
        .with_priority(7),
    )
}

pub(crate) fn render_workspace_tour_callout(
    target: Div,
    step: WorkspaceTourStep,
    placement: WorkspaceTourPlacement,
    cx: &App,
) -> Div {
    let palette = WorkspaceTourPalette::new(cx);
    target.relative().child(
        deferred(render_workspace_tour_card(
            step,
            placement,
            palette,
            workspace_tour_handlers(step),
        ))
        .with_priority(6),
    )
}

#[derive(Clone, Copy)]
struct WorkspaceTourPalette {
    overlay: Hsla,
    highlight_fill: Hsla,
    highlight_border: Hsla,
    card_background: Hsla,
    step_text: Hsla,
    title_text: Hsla,
    body_text: Hsla,
    button_background: Hsla,
    button_text: Hsla,
    subtle_text: Hsla,
}

impl WorkspaceTourPalette {
    fn new(cx: &App) -> Self {
        if cx.theme().appearance() == theme::Appearance::Dark {
            Self {
                overlay: hsla(240. / 360., 0.33, 0.03, 0.35),
                highlight_fill: Hsla::from(rgb(0x81a1c1)).opacity(0.12),
                highlight_border: Hsla::from(rgb(0x81a1c1)).opacity(0.9),
                card_background: Hsla::from(rgb(0x181818)),
                step_text: Hsla::from(rgb(0x7f7f7f)),
                title_text: Hsla::from(rgb(0xf2f2f2)),
                body_text: Hsla::from(rgb(0xa5a5a5)),
                button_background: Hsla::from(rgb(0x4a4a4a)),
                button_text: Hsla::from(rgb(0xf2f2f2)),
                subtle_text: Hsla::from(rgb(0x7f7f7f)),
            }
        } else {
            Self {
                overlay: hsla(240. / 360., 0.33, 0.03, 0.24),
                highlight_fill: Hsla::from(rgb(0x5b8cff)).opacity(0.12),
                highlight_border: Hsla::from(rgb(0x5b8cff)).opacity(0.9),
                card_background: Hsla::from(rgb(0xffffff)),
                step_text: Hsla::from(rgb(0x8f9bad)),
                title_text: Hsla::from(rgb(0x141414)),
                body_text: Hsla::from(rgb(0x6f7b8c)),
                button_background: Hsla::from(rgb(0xeceff4)),
                button_text: Hsla::from(rgb(0x141414)),
                subtle_text: Hsla::from(rgb(0x8f9bad)),
            }
        }
    }
}

pub(crate) fn render_workspace_tour_backdrop(cx: &App) -> impl IntoElement {
    let palette = WorkspaceTourPalette::new(cx);
    deferred(div().absolute().inset_0().size_full().bg(palette.overlay)).with_priority(1)
}

pub(crate) fn decorate_workspace_tour_target(
    target: Div,
    step: WorkspaceTourStep,
    placement: WorkspaceTourPlacement,
    handlers: WorkspaceTourHandlers,
    cx: &App,
) -> Div {
    let palette = WorkspaceTourPalette::new(cx);
    render_workspace_tour_highlight(target, cx).child(
        deferred(render_workspace_tour_card(
            step, placement, palette, handlers,
        ))
        .with_priority(6),
    )
}

fn render_workspace_tour_card(
    step: WorkspaceTourStep,
    placement: WorkspaceTourPlacement,
    palette: WorkspaceTourPalette,
    handlers: WorkspaceTourHandlers,
) -> Div {
    let primary_label = if step.next().is_none() {
        "Done"
    } else {
        "Next"
    };

    let back = h_flex()
        .id("workspace-tour-back")
        .h(px(24.))
        .items_center()
        .justify_center()
        .px_2p5()
        .rounded(px(4.))
        .bg(palette
            .button_background
            .opacity(if handlers.previous.is_some() {
                1.0
            } else {
                0.45
            }))
        .when_some(handlers.previous, |this, previous| {
            this.cursor_pointer()
                .hover(move |this| this.bg(palette.button_background.opacity(0.82)))
                .on_click(move |_, window, cx| previous(window, cx))
        })
        .child(
            Label::new("Back")
                .size(LabelSize::XSmall)
                .color(Color::Custom(palette.button_text)),
        );

    let skip = h_flex()
        .id("workspace-tour-skip")
        .cursor_pointer()
        .px_1()
        .py_0p5()
        .child(
            Label::new("Skip")
                .size(LabelSize::XSmall)
                .color(Color::Custom(palette.subtle_text)),
        )
        .on_click(move |_, window, cx| (handlers.skip)(window, cx));

    let next = h_flex()
        .id("workspace-tour-next")
        .h(px(24.))
        .items_center()
        .justify_center()
        .px_2p5()
        .rounded(px(4.))
        .bg(palette.button_background)
        .cursor_pointer()
        .hover(move |this| this.bg(palette.button_background.opacity(0.82)))
        .on_click(move |_, window, cx| (handlers.next)(window, cx))
        .child(
            Label::new(primary_label)
                .size(LabelSize::XSmall)
                .color(Color::Custom(palette.button_text)),
        );

    let card = v_flex()
        .gap_1p5()
        .px_3p5()
        .py_3()
        .rounded(px(6.))
        .bg(palette.card_background)
        .shadow_lg()
        .child(
            Label::new(step.progress_label())
                .size(LabelSize::XSmall)
                .color(Color::Custom(palette.step_text)),
        )
        .child(
            Label::new(step.title())
                .size(LabelSize::Small)
                .weight(FontWeight::SEMIBOLD)
                .color(Color::Custom(palette.title_text)),
        )
        .child(
            Label::new(step.description())
                .size(LabelSize::XSmall)
                .color(Color::Custom(palette.body_text)),
        )
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap_2()
                .pt_1p5()
                .child(back)
                .child(div().flex_1())
                .child(skip)
                .child(next),
        );
    let card = if matches!(
        placement,
        WorkspaceTourPlacement::BottomLeft
            | WorkspaceTourPlacement::InsideTop
            | WorkspaceTourPlacement::InsideTopBelowWindowControls
    ) {
        card.w_full()
    } else {
        card.w(px(280.))
    };

    match placement {
        WorkspaceTourPlacement::BelowRight => div()
            .absolute()
            .top(relative(1.0))
            .right(px(12.))
            .mt(px(8.))
            .child(card),
        WorkspaceTourPlacement::AboveRight => div()
            .absolute()
            .bottom(relative(1.0))
            .right(px(12.))
            .mb(px(8.))
            .child(card),
        WorkspaceTourPlacement::BottomLeft => div()
            .absolute()
            .bottom(px(96.))
            .left(px(12.))
            .right(px(12.))
            .child(card),
        WorkspaceTourPlacement::InsideTop => div()
            .absolute()
            .top(px(12.))
            .left(px(8.))
            .right(px(8.))
            .child(card),
        WorkspaceTourPlacement::InsideTopBelowWindowControls => div()
            .absolute()
            .top(px(44.))
            .left(px(8.))
            .right(px(8.))
            .child(card),
        WorkspaceTourPlacement::TopLeft => div().absolute().top(px(12.)).left(px(12.)).child(card),
        WorkspaceTourPlacement::TopRight => {
            div().absolute().top(px(12.)).right(px(12.)).child(card)
        }
    }
}
