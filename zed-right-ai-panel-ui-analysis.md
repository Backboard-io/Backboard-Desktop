# Zed Agent Workspace Screen Walkthrough

This document describes the live Zed/Backboard Agent Workspace UI as it exists in the current codebase. The right-side chat/detail drawer is one part of the screen, but not the whole product surface. The main subject here is the complete Agent Workspace mode: Zed's surrounding IDE shell, the workspace mode switcher, the compact Backboard header, the dashboard surface, the card grid, shadow tiles, the right drawer, visible button behavior, and the prompt send flow.

It stays on active, visible product behavior from the current source.

## Source Map

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:67): main Agent Workspace page, compact header, API-unavailable state, dashboard cards, shadow tiles, right drawer, resize handle, and card-level chat.
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4063): workspace-agent creation, draft chat creation, run summaries, and button actions such as review, apply, stop, retry, open worktree, and dismiss.
- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2782): conversation-level send pipeline.
- [message_editor.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/message_editor.rs:827): message editor send events.
- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:2602): ACP prompt request, visible user message entry, checkpoint capture, and agent/tool response entries.
- [multi_workspace.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/workspace/src/multi_workspace.rs:509): Agent Workspace mode selection.
- [multi_workspace.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/workspace/src/multi_workspace.rs:3005): Zed shell rendering around the Agent Workspace page.
- [backboard_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/backboard_ui/src/backboard_ui.rs:2584): separate docked Backboard panel. This is adjacent context, not the main Agent Workspace right drawer.

## Word Picture Of The Screen

The Agent Workspace is a full Zed IDE mode, not a floating chat window and not just a right-side assistant panel. When it is open, the normal code editor region is replaced by a dense Backboard workspace surface for creating, watching, and revising agents.

The outer frame is still Zed. The titlebar remains above everything. Under it, the workspace mode switcher is still present, so Agent Workspace reads as a peer of other workspace modes rather than as a detached overlay. The left dock can still sit beside the main area, the bottom dock can still sit below it, the regular Zed status bar can still render at the bottom, and modal/tour layers still belong to the surrounding workspace shell.

Inside that shell, the Backboard page starts with a compact header strip. It is about 30 pixels tall. It has a right-panel toggle icon, a `New Agent` button, and a small live count such as `0 agents`, `1 agent`, or `N agents`. The header does not behave like a marketing hero or chat app title bar. It is closer to panel chrome: small, functional, and quiet.

Below the header is the main dashboard area. It is a rounded, bordered container on a dark editor-native background. Inside that container, cards flow in a wrapping grid. When no real agents exist, the grid is still populated by shadow preview cards. Those shadow cards are translucent, dashed, and clickable. They communicate the shape of future agent cards without pretending any work has happened.

When agents exist, each agent appears as a tile/card in that dashboard. A card reads like a compact job monitor:

- top row: status dot, title, status badge, and open-chat icon
- command strip: the task or command the agent is running
- activity body: recent plan/tool/assistant activity
- file chips: touched files or a fallback such as no files touched
- footer: worktree/review/apply/stop/retry/dismiss controls plus model or cost context
- bottom chat bar: a one-line `Message agent...` input with a send icon

If the user selects a card, the right side of the workspace opens an in-page chat/detail drawer. This is the "right auxiliary bar" in the Agent Workspace. It slides in from the right edge of the dashboard, occupies a fixed resizable width, and shows the selected conversation. It is not the normal Zed right dock. It is part of the Agent Workspace layout.

The drawer has its own compact header. For a selected agent, the header shows the agent title, status dot, status badge, and a close button. For a new draft, it says `New Agent`. Under that header is the real conversation view: the thread transcript, prompt editor, tool cards, approvals, diffs, and assistant output supplied by the existing conversation UI.

When the Backboard API key is not connected, the same screen becomes an unavailable state instead of a card dashboard. The page still has the compact header, then shows an `API not connected` strip, an `Agents unavailable` message, a `Connect API key` button, and supporting copy that says the user can still browse files and inspect the workspace manually.

## Whole Screen Regions

### Zed Shell

`MultiWorkspace` owns the outer screen. When Agent Workspace mode is active, it wraps the Backboard page with normal Zed pieces: client-side decorations, titlebar, workspace mode switcher, left dock, bottom dock, status bar, workspace tour backdrop, and modal layer.

Source:

- [multi_workspace.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/workspace/src/multi_workspace.rs:3005)

That matters visually because Agent Workspace is not a replacement application inside Zed. It is a mode inside the IDE. The cards and right drawer occupy the central work area, while Zed's persistent frame still makes the whole thing feel like an editor surface.

### Backboard Header

The Backboard page header is rendered before the dashboard. It is compact and operational: a right drawer toggle, a `New Agent` button, and an agent count. The count is based on current run summaries. The toggle reflects whether the in-page drawer is open.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:674)

### Dashboard Surface

The dashboard is the main visual body of the page. It is a full-height rounded container with a border and dark surface fill. Its content scrolls vertically and uses a wrapping row layout with 12-pixel gaps and 12-pixel padding.

When the right drawer is closed, cards target roughly a third of the available width. When the right drawer is open, cards target roughly half of the remaining dashboard width, with a smaller minimum width so the overview stays usable beside the conversation.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:742)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:3001)

### API Unavailable State

If the Backboard API key is not ready, the page does not show fake agent content. It renders a centered unavailable state with an info icon, `Agents unavailable`, explanatory text, a `Connect API key` button, and a smaller note that manual workspace browsing is still possible.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:850)

## Where The UI Comes From

The Agent Workspace is opened by the `OpenBackboardAgentWorkspace` action. That action creates a `BackboardAgentWorkspacePage` if one does not already exist, stores it on `MultiWorkspace`, and switches the workspace into Agent Workspace mode.

Source:

- [agent_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_ui.rs:588)
- [multi_workspace.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/workspace/src/multi_workspace.rs:509)
- [multi_workspace.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/workspace/src/multi_workspace.rs:3005)

Once `multi_agent_expanded` is true, `MultiWorkspace` renders the Agent Workspace page in the main work area. It still keeps IDE shell pieces around it, such as the titlebar, workspace mode switcher, left dock, bottom dock, status bar, tour backdrop, and modal layer.

Inside `BackboardAgentWorkspacePage::render`, the page:

- reads current agent run summaries
- checks whether the Backboard API key is connected
- ensures an underlying `AgentPanel` exists
- decides whether the right drawer should be open
- renders the header
- renders the card dashboard
- conditionally renders the right drawer

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:3001)

The important design detail is that the visible Agent Workspace dashboard is not the same thing as the older docked `AgentPanel`. The Agent Workspace uses `AgentPanel` as the backing layer for conversations and runs, but it renders its own screen and its own right drawer.

## The Right Auxiliary Bar

The right auxiliary bar is rendered by `BackboardAgentWorkspacePage`, not by the normal workspace dock.

It opens when either:

- a real agent card is selected
- a draft chat is open

The page calculates `right_panel_open` from `selected_summary.is_some() || draft_drawer_open`, then reserves a fixed-width column on the right. The visible drawer is positioned absolutely at the right edge and animated with a short slide-in effect.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:3039)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:3108)

The drawer width defaults to 480 pixels, has a minimum of 360 pixels, and is clamped so the dashboard still keeps usable width. The left edge of the drawer has a resize handle. Dragging the handle resizes the chat panel; double-clicking it resets the width.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:37)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:399)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2905)

The drawer has two visible states:

- Selected agent detail: `render_detail_drawer` shows the selected run header and embeds that run's `ConversationView`.
- Draft/new agent chat: `render_right_panel` finds the active draft conversation and renders it under a `New Agent` header.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2780)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2810)

The right drawer also handles the normal right-dock toggle action while this page is focused. In this context, the toggle does not open the regular IDE right dock. It opens or closes the Agent Workspace drawer.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:391)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:3050)

## Cards And Tiles

The card grid is the main Agent Workspace experience. The right drawer is the detail view, but the cards are the control board: they let the user see all running or completed agents at once, identify which ones need attention, inspect file impact, and act without opening every conversation.

Real agent cards come from `BackboardAgentRunSummary`. The summary is assembled by `AgentPanel` from retained conversations, thread status, tool calls, plan entries, action logs, run metadata, cost, token usage, speed metrics, changed paths, and conflict state.

Source:

- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:317)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4837)

The dashboard renders those summaries as large workspace cards. If no summaries exist, it renders shadow preview tiles instead. If some real cards exist, it fills out the remaining visual space with shadow tiles up to the preview count. That means the dashboard never looks like an empty table; it keeps showing the user where agents will appear and where to click to create one.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:742)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:766)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:794)

### Real Agent Cards

The current dashboard card is a large, fixed-height tile, about 440 pixels tall. It is rounded with a 12px radius, bordered, and filled with an elevated dark surface. It has a pointer cursor and a hover border. Selection changes the border to the accent color and lightly blends the background with the accent, so the selected card stays visible even while the right drawer is open.

Card width changes with the screen state. With the drawer closed, each card targets about 31.5 percent of the dashboard width with a 300px minimum. With the drawer open, each card targets about 48 percent of the remaining dashboard width with a 320px minimum. The result is a grid when the page is wide and a tighter two-column or single-column overview when the conversation drawer takes space.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:742)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1032)

Visually, a real card has six stacked bands.

1. Header band: a 56px row with the status dot, bold truncated title, status badge, and open-chat icon. The icon changes between a closed and open right-sidebar glyph depending on whether the card is selected.
2. Command band: a shaded strip with a `$` marker, the agent kind label, and a one-line cleaned command or task label.
3. Activity body: the flexible middle area. It shows the latest agent events, or a status-specific empty/blocked/queued state.
4. File strip: a short row of file chips, capped to a few path labels plus a `+N more` chip when needed.
5. Footer: compact icon buttons and model/cost context.
6. Card chat bar: a one-line `Message agent...` editor with a chat icon and send button.

The card is intentionally dense. It is not a thumbnail of the conversation. It is a live operational summary that answers: what is this agent doing, is it healthy, what files did it touch, can I stop/retry/apply/review it, and can I send it a quick follow-up?

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1100)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1129)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1148)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1155)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1156)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1157)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1158)

### Card Status

Status appears twice: as a small colored dot and as a badge. The labels are visible product labels:

- `LIVE` for running agents
- `QUEUED` for waiting agents
- `DONE` for completed agents
- `BLOCKED` for agents that need input
- `ERROR` for failed agents
- `STOPPED` for canceled agents

The activity area changes with status. A blocked card centers a warning icon, `Waiting on dependency`, and the blocked reason. A queued card centers an info icon and `Queued - waiting for next step`. A card with no activity shows `No activity yet`. Otherwise, it shows up to six recent activity rows. Those rows use small icons to distinguish active, done, waiting, failed, and muted events.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1220)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1264)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2386)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2404)

### File Chips And Footer

The file strip makes code impact visible without opening the drawer. It takes up to three touched paths, reduces each to its filename, and adds `+N more` when the run touched more than three paths. If it only knows a changed-file count, it shows `1 file` or `N files`. If there is no file activity, it says `No files touched`.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1317)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1765)

The footer is a compact action rail, not a full toolbar. It always includes the worktree or working-directory button, conditionally includes review/apply/stop/revise/retry/dismiss actions, and keeps model or agent-kind context visible in a small sparkle-labeled pill. If cost is available, the card shows it before the model pill.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1395)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1771)

### Card-Level Chat

The card chat bar gives each tile a small follow-up input. It is not a separate chat system. It is a shortcut into the selected run's real conversation. The bar has its own focus styling: when focused, the border uses the focused border color, the background becomes closer to the editor background, and the chat icon turns accent-colored. The send button is disabled when the input is empty, then switches to an accent tinted button when text exists.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1563)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1595)

The card is also a selector. Clicking the card body opens the run in the right drawer. Clicking footer buttons or the send button stops propagation so the action does not also act like a card-body click.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1096)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1395)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1595)

### Shadow Tiles

Shadow tiles are placeholders shown when the dashboard has fewer real agents. They match the real card size and radius, but use a dashed 2px accent border, translucent elevated background, and a preview image asset at reduced opacity. They have a `Create agent` tooltip and a hover border that brightens the accent.

Clicking a shadow card calls `create_chat`, which opens a new draft conversation in the right drawer.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:30)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1180)

## What Buttons Do

### Header Buttons

The header has a right-panel toggle and a `New Agent` button.

The right-panel toggle:

- closes the right drawer if a selected run or draft is already open
- otherwise creates a new draft chat

The `New Agent` button:

- ensures an `AgentPanel` exists
- creates or reuses a draft Backboard workspace chat
- closes the regular docked right panel if that panel had the backing `AgentPanel`
- opens the in-page right drawer
- focuses the draft conversation when possible

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:112)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:340)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4149)

### Card Selection

Clicking the card body or its open-chat icon calls `open_run`. That marks the run as selected, closes draft mode, activates the matching retained thread in `AgentPanel`, and focuses the conversation in the right drawer.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:452)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1096)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1118)

### Card Footer Actions

The footer buttons stop propagation so clicking them does not also select the card accidentally.

- Open worktree: opens the agent worktree or working directory.
- Review: opens the agent diff pane for that thread.
- Apply: applies a completed worktree patch back to the base workspace when allowed.
- Stop: cancels a running or queued thread.
- Revise: opens the blocked agent in the right drawer for follow-up.
- Retry: retries a failed or canceled thread.
- Dismiss: removes a finished, failed, or canceled card from the workspace view.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1395)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:584)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:596)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:608)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:620)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:632)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:644)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:649)

The actual backing methods live on `AgentPanel`:

- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4574)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4592)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4615)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4655)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4813)

### Right Drawer Buttons

The selected-run drawer repeats key actions in its own header: revise, review, apply, open worktree, stop, retry, and dismiss. These call the same page-level methods as the card footer.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2595)

The drawer close button persists the active prompt, clears the selected run or draft, and hides the drawer.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:487)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:2947)

## What Happens When You Send A Prompt

There are two visible send entry points in this screen:

- the real conversation composer inside the right drawer
- the small `Message agent...` bar inside each card

Both route into the same underlying conversation machinery.

### Sending From A Card

The card chat bar is a small single-line editor with a chat icon and a send icon. Focusing it opens that run in the right drawer without stealing focus from the input. Clicking the send icon stops event propagation so the card itself is not selected twice.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:517)
- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:1563)

When the user sends from the card:

1. The card input text is read and trimmed.
2. Empty text simply refocuses the card input.
3. The run is opened without forcing focus away from the card input.
4. The card input is cleared.
5. The matching `ConversationView` and root `ThreadView` are found.
6. The text is inserted into the real thread message editor.
7. `ThreadView::send` is called.

Source:

- [agent_workspace_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_workspace_ui.rs:542)

If the conversation or thread view cannot be found, the text is restored into the card input and the run is opened for the user instead of silently losing the message.

### Sending From The Conversation Composer

The conversation composer is handled by `MessageEditor`. When it receives the chat action, it clears inlay hints and emits `MessageEditorEvent::Send`.

Source:

- [message_editor.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/message_editor.rs:827)
- [message_editor.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/message_editor.rs:886)

`ThreadView` subscribes to that event. On `Send`, it calls `ThreadView::send`, which delegates to `try_send`.

Source:

- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:1663)
- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2782)

`try_send` handles the visible cases:

- If contents are still loading, it refuses the send.
- If the editor is empty, it does nothing.
- If the thread is already generating, it queues the message.
- If the text is a login/logout command, it handles auth behavior.
- Otherwise, it emits an interaction event and sends the editor content.

Source:

- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2786)

`send_impl` resolves message contents, clears stale error/feedback/editing state, optionally follows the agent, clears the editor, and passes resolved content to `send_content`.

Source:

- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2873)

`send_content` starts the visible turn:

1. Marks the message content as loading.
2. Starts a turn and records the in-flight prompt.
3. Collapses the editor expansion.
4. Scrolls the transcript to the end.
5. Sets or updates the first-message title when appropriate.
6. Records read buffers in the action log.
7. Emits `Agent Message Sent` telemetry.
8. Calls `AcpThread::send`.
9. Updates the generating indicator.
10. On completion, emits `Agent Turn Completed` telemetry.

Source:

- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2912)
- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2949)

## What The ACP Thread Does With The Prompt

`AcpThread::send` is where the prompt becomes visible thread state.

It converts the content blocks into a visible user message, creates an ACP `PromptRequest`, captures a user message id, then starts a turn. During that turn it:

- pushes an `AgentThreadEntry::UserMessage` into the thread
- asks git for a checkpoint and attaches it to the last user message when available
- calls `connection.prompt(message_id, request, cx)`

Source:

- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:177)
- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:2602)

After that, the connection streams updates back into the thread. Those updates become assistant messages, plan entries, tool calls, terminal output, diffs, status updates, and permission prompts.

Tool calls are first-class visible entries. A tool call has a label, kind, content, status, locations, optional raw input/output, and optional terminal or diff content.

Source:

- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:252)

Tool call statuses are visible states:

- `Pending`
- `Waiting for confirmation`
- `Running`
- `Completed`
- `Failed`
- `Rejected`
- `Canceled`

Source:

- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:595)

When a tool needs permission, the thread inserts or updates a tool call with `WaitingForConfirmation`. The UI then renders permission controls for that tool call. If the user approves, the tool starts running; if the user rejects, it becomes rejected.

Source:

- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:2472)
- [acp_thread.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/acp_thread/src/acp_thread.rs:2506)

The conversation renders tool activity as compact cards. Terminal tools get command-specific headers such as `Approve command`, `Running command`, `Command failed`, `Command canceled`, or `Command complete`. Non-terminal tools use the same card shell when they are edits, confirmations, or status-bearing tool calls.

Source:

- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:9790)
- [thread_view.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/conversation_view/thread_view.rs:10043)

## How Agent Runs Are Created

The visible `New Agent` path creates a draft conversation. That draft only becomes a real run once the user sends meaningful prompt content.

Source:

- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4149)
- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4312)

Saved tasks and batch launches can create real workspace agents directly. `spawn_backboard_workspace_agents` accepts up to 20 tasks, creates isolated worktree-backed runs when a local repository is available, or current-workspace runs otherwise.

Source:

- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:4063)
- [agent_tasks_page.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_tasks_page.rs:277)

For each workspace-agent run, the prompt is wrapped with visible run context: agent type, scope, mode, workspace guidance, and task. That is what makes the card represent a specific worker rather than a generic chat.

Source:

- [agent_panel.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/agent_ui/src/agent_panel.rs:445)

## Design Language

The Agent Workspace uses Zed's IDE-native design language:

- dark editor surfaces
- restrained borders
- compact typography
- 12px rounded workspace containers and cards
- small icon buttons
- status colors used sparingly
- dense summaries instead of wide chat bubbles
- rows, chips, badges, and cards built for scanning

The screen feels like a control room for running agents, not a consumer chat product. The cards make parallel work visible. The right drawer keeps the full conversation close without replacing the dashboard. Zed's surrounding shell keeps the page anchored inside the IDE instead of making it feel like a separate chat app.

There is also a separate docked Backboard panel. That panel is a normal Zed dock panel named `Backboard`, defaults to the right dock, and has its own header, status, model drawer, message list, and composer. It is useful adjacent context, but it is not the Agent Workspace right drawer described above.

Source:

- [backboard_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/backboard_ui/src/backboard_ui.rs:2584)
- [backboard_ui.rs](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/crates/backboard_ui/src/backboard_ui.rs:2642)

## Mental Model

Think of the Agent Workspace as three layers:

1. `MultiWorkspace` decides this mode owns the main editor area.
2. `BackboardAgentWorkspacePage` paints the visible dashboard, cards, and right drawer.
3. `AgentPanel`, `ThreadView`, `MessageEditor`, and `AcpThread` provide the actual conversation and agent runtime behavior.

The card grid is the overview. The right drawer is the focused conversation. The underlying thread is the source of truth. Sending a prompt turns the small visible input into a structured ACP prompt request, and the streamed response comes back as transcript entries, tool cards, status changes, file changes, and action buttons that update the dashboard cards.
