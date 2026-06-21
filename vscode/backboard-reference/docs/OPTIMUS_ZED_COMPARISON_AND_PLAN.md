# Optimus vs Zed Agent Workspace Comparison and Build Plan

## Executive Summary

This document compares the current Optimus implementation in the Backboard IDE fork with the Zed Agent Workspace and Backboard Tasks surfaces that inspired it. It also records the screenshots discussed during implementation, the product intent that was clarified in the thread, the current state of the code, the gaps that remain, and a concrete implementation plan for making Optimus behave like the desired standalone multi-agent control surface.

The short version is this: Optimus now exists as its own standalone VS Code window/page, can be opened from the Command Palette and File menu, and renders a page with six starter task boxes and a right-side chat-shaped panel. That is meaningful progress from the earlier top-composer version. It is still not yet functionally equivalent to Zed's Agent Workspace. Zed's version is built around real agent threads, live run summaries, the actual conversation view, per-card follow-up chat, saved reusable tasks, worktree state, review/apply controls, and a right panel that is a real chat surface rather than a custom transcript mock.

The target product direction is clear:

- The surface is called **Optimus**, not Workspace.
- Optimus is a standalone page/window, not a workbench editor page.
- Optimus should coordinate chats and runs shared with Copilot and Backboard.
- The right panel should use the same real chat experience as Copilot/Backboard, not an imitation.
- The dashboard should support multiple live agents, not only local demo cards.
- Reusable task prompts should exist, but they should not turn Optimus back into a generic workspace feature.

The main architectural work left is to replace the demo Optimus bridge with a real bridge to existing Backboard/Copilot chat and session infrastructure, then use that bridge to render live run cards and open real conversations in the right panel.

## Screenshot Gallery

### Earlier Agents / Workspace-Style Screen

This screenshot shows the earlier Backboard/Agents-style surface. It has a left session list, a central prompt area, and a right tabbed area for Changes, Files, and Browser.

![Earlier Agents workspace-style screen](/var/folders/tx/bsxbdqs90zl7nmz4nd9yw6ch0000gn/T/codex-clipboard-78e71a4f-964b-4007-893d-5a2a49c33188.png)

Notable characteristics:

- It is visibly an Agents surface rather than an Optimus-specific surface.
- The left side is dominated by session history.
- The center is a single chat composer with starter suggestion chips.
- The right side is a related workspace/file browser panel, not the requested Copilot/Backboard chat panel.
- It is useful as a reference for existing Backboard navigation and chat behavior, but it is not the desired final Optimus shape because the user explicitly rejected making Optimus a workbench/workspace page.

### Earlier Optimus With Top Input

This screenshot shows the first Optimus shape that was rejected. It had a brand block on the left and a single top-level composer spanning the header area.

![Earlier Optimus top composer](/var/folders/tx/bsxbdqs90zl7nmz4nd9yw6ch0000gn/T/codex-clipboard-bbdc643d-7913-4956-821c-a01af7142457.png)

The key problem was structural: the input lived at the top as a single global composer. The requested direction was to remove that top input and make the initial page show a 3x2 set of task boxes ready to use. That request also implied that the right panel should remain visible and match Copilot/Backboard, not behave like a separate custom drawer.

### Current Optimus Render

The latest Optimus render check shows the post-change layout: six starter task boxes in a 3-column by 2-row grid and a right chat rail.

![Current Optimus render](/tmp/optimus-ui-verify.png)

This current page now matches the immediate visual request:

- No top composer.
- Six visible task boxes.
- A persistent right-side chat rail.
- Dark VS Code-like styling.
- Backboard/Copilot provider selection on each starter task box.

It does not yet satisfy the deeper functional requirement that the right panel be the exact same Copilot/Backboard panel. The current right panel is custom DOM rendered by Optimus. It looks like a chat panel, but it is not yet backed by the real shared chat widget or real Backboard/Copilot session model.

### Zed Shadow Agent Preview Card Asset

Zed's empty Agent Workspace uses six shadow preview cards, driven by a bundled asset, as placeholders for future agent cards.

![Zed agent workspace shadow card](/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/zed/assets/images/agent_workspace_shadow_card.png)

This is important because the Zed empty state is not six live text inputs. It is six non-interactive preview cards plus a separate right-panel composer flow. Current Optimus intentionally diverges from this by showing six task inputs, because the latest user request was specifically "have a 3x2 box input ready at the start." That choice is acceptable for Optimus, but it should be recorded as a product decision rather than treated as a faithful Zed clone.

## Product Intent

The implementation should be guided by the user's clarified intent, not by the older "workspace" naming in Zed or the old VS Code workbench assumptions.

### Name and Framing

The feature is **Optimus**. It should not be presented as "Workspace" in user-facing UI. Zed's code and older Backboard experiments use "Agent Workspace" terminology, but the user explicitly asked to make this easier to understand by calling it Optimus. That means internal implementation can reference existing workspace APIs where unavoidable, but the visible surface should say Optimus.

Current state:

- The page title says "Optimus."
- The Command Palette action is "Open Optimus."
- The feature has source under `src/vs/optimus`.

Remaining concern:

- Some related Backboard/Zed reference code and older deleted/removed VS Code paths still use workspace terminology. That is fine for reference docs and migration notes, but new Optimus UI copy should avoid it.

### Standalone Surface

Optimus should be its own standalone page/window. The user rejected associating it with other pages and explicitly said it should not be a workbench. In the VS Code codebase, "workbench" has a specific architectural meaning: the normal editor shell with contributions, panels, services, editors, views, and workbench actions. Optimus should not be another editor page inside that environment.

Current state:

- Optimus has its own Electron browser HTML entrypoint under `src/vs/optimus/electron-browser`.
- Optimus has its own desktop main module under `src/vs/optimus/optimus.desktop.main.ts`.
- `--optimus` is wired through startup.
- `Open Optimus` calls the native host service, which opens an Optimus window.

Remaining concern:

- To share chats with Copilot/Backboard, Optimus will need a bridge back into services that normally live in the workbench or agents/chat infrastructure. The integration must be designed so Optimus can use shared chat/session data without becoming a normal workbench editor page.

### Shared Copilot and Backboard Chats

Optimus should share chats with Copilot/Backboard. This means a chat started or selected in Optimus should not be isolated fake state. It should be backed by the same session/thread/conversation model used by the real chat surfaces. A user should be able to open a Backboard/Copilot conversation from Optimus, continue it, and have that conversation remain available in the normal chat history or related Backboard views.

Current state:

- Optimus currently has a demo run store and demo chat bridge.
- The UI can create fake/local runs and display a transcript-like panel.
- The right rail can send messages through the local Optimus store.

Gap:

- Optimus does not yet call the real Backboard/Copilot chat APIs.
- It does not yet render the real Backboard/Copilot chat panel.
- It does not yet preserve or discover real shared sessions.

### Right Panel Requirement

The right panel should be the same as Copilot/Backboard. The user used strong language here: "that right panel should be the exact same as the copilot/backboard." For the implementation plan, this means "matching the look" is not enough. The panel needs to use shared chat behavior and ideally shared chat UI components or a shared embedding adapter.

Current state:

- The right panel has a header, message list, and bottom input.
- It visually resembles a chat panel.

Gap:

- It is custom markup in `OptimusApp`.
- It is not the real `ConversationView`, Copilot chat widget, Backboard panel, or shared chat renderer.
- It does not have the actual model picker, attachment/context controls, session history, input behavior, streaming behavior, tool-call rendering, or command handling that the real panel has.

## Current Optimus State Audit

This section describes what exists now, based on the current repo state and the latest render check.

### Standalone Window and Launch Access

Optimus has been wired as a standalone window. The action lives in:

- `src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts`

The relevant action is `OpenOptimusWindowAction`, with:

- Command id: `workbench.action.openOptimusWindow`
- Title: `Open Optimus`
- Category: `Optimus`
- `f1: true`, which makes it available in the Command Palette.
- A File menu entry under `MenuId.MenubarFileMenu`.

This satisfies the access requirement:

- It can be opened from Command Palette.
- It can be opened from the top menu.
- It is not hidden behind only a CLI flag.

There is also CLI/startup support through the `--optimus` argument. That matters for development, testing, and future launch workflows.

### Current Page Structure

The shell is created in `src/vs/optimus/browser/optimusApp.ts`.

Important current behaviors:

- `renderShell()` creates a root shell, brand header, main content area, task grid, and right drawer.
- `renderBrand()` renders "Optimus" and the subtitle "Standalone multi-agent control surface."
- `renderTaskBoard()` creates six task launchers.
- `renderTaskInput()` creates a form with a textarea, provider select, and Start button.
- `renderRuns()` always renders the task board first, then any run cards.
- `renderRunCard()` renders a card for each run from the store.
- `renderDrawer()` renders the right chat rail.

This is the current DOM-level shape:

```text
optimus-shell
  optimus-header
    optimus-brand
  optimus-content
    optimus-grid
      optimus-task-board
        optimus-task-input x 6
      optimus-card x N
    optimus-drawer
      optimus-drawer-body
        optimus-chat-header
        optimus-chat-empty or optimus-chat-messages
        optimus-chat-input
```

The current render verification confirmed:

- Six `.optimus-task-input` elements.
- Zero `.optimus-composer` elements.
- A right `.optimus-chat-input`.
- A right header showing Backboard by default.

### Current 3x2 Starter Input Grid

The 3x2 grid is implemented in CSS:

- `.optimus-grid` uses `grid-template-columns: repeat(3, minmax(0, 1fr))`.
- `.optimus-task-board` spans all grid columns.
- `.optimus-task-board` also uses three columns and two min-height rows.
- Each `.optimus-task-input` is a grid with the textarea above and select/button footer below.

This directly addresses the visual request that the input be removed from the top and that a 3x2 box input be ready at the start.

Product note:

This is not the same as Zed's empty shadow-card dashboard. It is a more immediately actionable input-first design. That may be correct for Optimus because the user explicitly asked for it. If the product later wants to move closer to Zed, Optimus can keep six boxes but make them "starter agent slots" that become live cards after launch, or it can show shadow cards with a right-panel composer. For now, the six editable boxes are the current accepted design direction.

### Current Right Panel

The right panel is custom Optimus UI:

- Header: `optimus-chat-header`
- Empty state: `optimus-chat-empty`
- Messages: `optimus-chat-messages`
- Message rows: `optimus-chat-message`
- Input: `optimus-chat-input`

It has the basic chat anatomy:

- Provider title.
- Selected run title or "Select a task."
- Center empty message.
- Bottom textarea.
- Send button.

It is visually much closer to a chat panel than the earlier transcript drawer, but it is still not the exact Copilot/Backboard panel.

Specific limitations:

- It uses a plain `<textarea>`, not the same input control as Copilot/Backboard.
- It does not render tool calls, code blocks, markdown, file attachments, or context chips.
- It does not show model selection, voice controls, context menu, or the normal chat toolbar.
- It does not stream real responses from the shared chat runtime.
- It does not open existing shared conversations.

### Current Run Cards

Current run cards show:

- Status dot.
- Title.
- Status badge.
- Task text.
- Up to six activity events.
- Up to three touched file chips.
- Provider/model/cost metadata.
- Actions for Open Chat, Stop, and Retry depending on run status.

This is a good first card skeleton. Compared with Zed, it is much thinner. Zed cards have richer status and lifecycle information:

- Command label.
- Run kind.
- Working directory/worktree.
- Branch label.
- Apply state.
- Blocked reason.
- Files changed count.
- Cost and token/speed metrics.
- Review/apply/open-worktree/stop/retry/dismiss actions.
- Per-card chat input.

Current Optimus cards can be expanded to match this once the backing data exists.

### Current Store and Bridge

The current Optimus implementation is intentionally local/demo-oriented. The store creates and updates runs, and the demo bridge provides mocked behavior. This was useful for getting a page working quickly, but it is now the main blocker to product correctness.

The required next state is not "make the demo store more elaborate." The required next state is a real Optimus bridge that talks to the same Backboard and Copilot session infrastructure used elsewhere in the product.

## Zed Reference Audit

This section summarizes the Zed implementation that is relevant to Optimus.

### Zed Agent Workspace Dashboard

Zed's Agent Workspace implementation lives primarily in:

- `../zed/crates/agent_ui/src/agent_workspace_ui.rs`

The main type is `BackboardAgentWorkspacePage`. It stores:

- A weak reference to the workspace.
- Selected thread id.
- Whether the draft drawer is open.
- Right chat panel width.
- Scroll state.
- Dismissed threads.
- Per-card chat inputs.
- Subscriptions to the agent panel.
- Update throttling state.

The dashboard is driven by `BackboardAgentRunSummary` values. This is an important architectural difference from current Optimus. Zed cards do not own the source of truth. They render summaries derived from the real AgentPanel/thread system. That keeps the dashboard, chat panel, and agent lifecycle in sync.

### Zed Header

Zed's header is compact. It is about 30px high and contains:

- A button to open/close the composer or chat panel.
- A "New Agent" button.
- An agent count indicator.

This is different from current Optimus, which has a larger brand header. The current Optimus header looks clear, but it occupies more vertical space and is more like a product page. Zed's header is more like an operational surface.

Recommendation:

Optimus should eventually move toward Zed's compact operational header, but keep the "Optimus" label. A good compromise:

- Left: Optimus title or icon.
- Next: New Agent button.
- Next: active agent count.
- Right: saved tasks, panel toggle, settings/API status.

### Zed Empty State

Zed uses six shadow preview cards when there are no real runs. The count is controlled by:

```rust
const SHADOW_AGENT_PREVIEW_CARD_COUNT: usize = 6;
```

Those preview cards use:

```rust
include_bytes!("../../../assets/images/agent_workspace_shadow_card.png");
```

The empty state is therefore visual rather than input-driven. Users create a new agent through the header/right-panel flow, not by typing into six independent starter boxes.

Current Optimus diverges here. That divergence is intentional based on the latest UI request.

### Zed Live Agent Cards

Zed's live agent card is significantly richer than current Optimus. The card includes:

- Status dot and status badge.
- Title.
- Command kind and command body.
- Live activity preview.
- File chips.
- Footer metadata.
- Review/apply/open-worktree/stop/retry/dismiss/open-detail actions.
- Per-card chat input.

The card also changes styling based on status:

- Done uses success styling.
- Blocked uses warning styling.
- Error/canceled use error styling.
- Running/queued use standard elevated surface styling.
- Selected cards get accent border.

For Optimus, this means the future card API should not be limited to the current `task`, `activity`, and `touchedFiles` fields. It needs a richer run-summary model.

### Zed Per-Card Chat

Zed has a chat bar at the bottom of each live agent card. This lets users send a quick message to an agent without opening the full right panel. The implementation uses a real editor entity, focus handling, a chat icon, and a send icon button.

Behaviorally:

- Focusing the per-card chat opens/selects the run.
- Sending forwards the text into the underlying thread's message editor.
- The input clears after sending.
- If the conversation cannot be found, the message is restored and the run is opened.

Current Optimus does not have per-card chat. It only has:

- Starter task inputs before launch.
- A right-panel follow-up input after selecting a run.

Per-card chat should be added after real shared conversations are available. Adding it before the real bridge would only deepen the demo abstraction.

### Zed Right Conversation Panel

Zed's right panel is not a hand-rendered transcript. It embeds the actual conversation view:

```rust
.child(conversation)
```

For a selected run, the right drawer renders:

- A compact header with title, status, badge, and close button.
- The actual `ConversationView`.

For an active draft, it renders:

- Header: "New Agent"
- The draft conversation view.

For no active draft, it renders:

- Backboard icon.
- "Open a chat to start Agent Workspace."
- New Chat button.

The panel also has a resize handle, width state, and reset-on-double-click behavior.

This is the strongest evidence for what Optimus should do next. The right panel should not reimplement chat. It should embed or proxy the real chat panel/conversation.

### Zed Saved Tasks Page

Zed also has a Backboard Tasks page:

- `../zed/crates/agent_ui/src/agent_tasks_page.rs`

It includes:

- `SavedBackboardTask` with id, title, prompt, created/updated timestamps.
- Starter tasks: Review current changes, Harden tests, Update docs, Clean up refactor.
- Left panel for saved tasks or starter presets.
- Right editor panel with title and prompt editors.
- Save, Run, and Delete actions.
- Run launches a Backboard workspace agent with whole-project/build/free defaults.

This maps cleanly to an Optimus future feature: saved Optimus tasks. It should not be the first thing implemented after the bridge, but it should be part of the complete plan.

### Zed Run Lifecycle

Zed's AgentPanel owns much of the lifecycle:

- Spawn Backboard workspace agents.
- Track draft thread id.
- Promote drafts.
- Stop runs.
- Retry runs.
- Review runs.
- Apply runs.
- Open worktrees.
- Dismiss runs.
- Activate a run in the dashboard.

Current Optimus has local equivalents for start, stop, retry, open transcript, and send message, but those are not connected to real Backboard/Copilot behavior. The right strategy is to define a small Optimus service interface that can map onto the existing Backboard/Copilot lifecycle rather than duplicating it in the DOM component.

## Gap Analysis

| Category | Zed Reference | Current Optimus | Gap | Priority |
|---|---|---|---|---|
| Naming | Agent Workspace in Zed | Optimus in VS Code | Current naming is correct for user intent | Keep |
| Surface model | Integrated GPUI page with AgentPanel | Standalone Electron page | Optimus is correctly standalone, but lacks real shared service bridge | High |
| Empty state | Six shadow preview cards | Six editable task boxes | Intentional divergence from Zed based on user request | Keep for now |
| Header | Compact operational header | Larger brand header | Optimus feels more like a product page than an agent control deck | Medium |
| Launch boxes | Header/right composer starts agents | Six independent task forms | Current launch model is visible and direct, but needs real backend | High |
| Live cards | Rich summaries with worktree, branch, apply, review, activity | Simple local cards | Need richer run model and real lifecycle actions | High |
| Per-card chat | Present on each card | Missing | Add after shared conversation bridge | Medium-high |
| Right panel | Real ConversationView | Custom chat rail | Biggest functional mismatch | Critical |
| Resizable panel | Present | Missing | Add after real panel embedding | Medium |
| Close/open panel | Present | Missing | Add as part of right-panel work | Medium |
| Saved tasks | Separate BackboardTasksPage | Missing | Add after core bridge/card model | Medium |
| Persistence | KVP-backed saved tasks, thread metadata | Demo/local state | Need real session/task persistence | High |
| Copilot sharing | Agent/thread system | Provider dropdown only | Need real Copilot session adapter | Critical |
| Backboard sharing | Backboard AgentPanel and Backboard API | Provider dropdown only | Need real Backboard adapter | Critical |
| Testing | Visual/unit tests in Zed | Manual render harness only | Need automated tests around bridge, page render, launch | High |

## Recommended Implementation Plan

The implementation should happen in phases. Each phase should leave the product in a coherent state and should avoid making Optimus dependent on the normal workbench shell as a visible page. The core rule is: reuse shared chat/session services, but do not make Optimus a workbench editor.

### Phase 1: Stabilize the Current Optimus Shell

Goal:

Make the current standalone shell reliable and remove any remaining loader/runtime fragility before deeper chat integration.

Actions:

1. Keep the current standalone entrypoints:
   - `src/vs/optimus/electron-browser/optimus.html`
   - `src/vs/optimus/electron-browser/optimus-dev.html`
   - `src/vs/optimus/electron-browser/optimus.ts`
   - `src/vs/optimus/optimus.desktop.main.ts`

2. Verify `--optimus` consistently opens a window and remains alive.
   - The previous launch attempt showed the Electron process exiting early in the throwaway launch environment.
   - Logs did not show a renderer error, but this should be debugged before declaring standalone launch complete.

3. Keep the CSS loading model simple.
   - Use a direct `<link rel="stylesheet" href="../browser/media/optimus.css">`.
   - Avoid dynamic CSS imports in `optimus.desktop.main.ts`.
   - Avoid inline scripts that violate CSP.

4. Add a small smoke test or documented manual test for:
   - Command Palette open.
   - File menu open.
   - `--optimus` open.
   - Six task boxes render.
   - Right panel renders.

Acceptance:

- Optimus opens reliably from Command Palette, File menu, and CLI.
- No Trusted Types errors.
- No missing CSS or JS resource errors.
- No top composer appears.
- The six input boxes and right rail render in both dev and built output.

### Phase 2: Define a Real Optimus Session Bridge

Goal:

Replace the demo bridge with a real service boundary that can list/create/select/send to shared Backboard and Copilot conversations.

The key is to avoid baking Backboard/Copilot implementation details directly into `OptimusApp`. The app should depend on an interface that exposes the product-level operations Optimus needs.

Recommended interface shape:

```ts
interface IOptimusSessionBridge {
	listRuns(): Promise<IOptimusRunSummary[]>;
	createRun(request: IOptimusCreateRunRequest): Promise<IOptimusRunSummary>;
	openConversation(runId: string): Promise<IOptimusConversationHandle>;
	sendMessage(runId: string, message: string): Promise<void>;
	stopRun(runId: string): Promise<void>;
	retryRun(runId: string): Promise<void>;
	reviewRun?(runId: string): Promise<void>;
	applyRun?(runId: string): Promise<void>;
	openWorktree?(runId: string): Promise<void>;
	onDidChangeRuns: Event<void>;
}
```

The exact VS Code service registration will need to match the surrounding architecture, but the principle should hold:

- `OptimusApp` renders state and calls bridge methods.
- The bridge owns chat/session wiring.
- Backboard and Copilot adapters can be separate behind the bridge.

Run summary fields should be expanded to cover what the UI needs:

- id
- provider
- title
- task/command
- status
- blocked reason
- model/provider metadata
- cost/token/speed metadata
- touched files/files changed
- branch/worktree state
- apply/review capabilities
- latest activity events
- backing conversation/session resource

Acceptance:

- Demo/local run state is removed from the product path or isolated behind a mock/test bridge.
- Creating a Backboard run uses real Backboard infrastructure.
- Creating a Copilot run uses real Copilot/session infrastructure where available.
- The UI no longer invents transcripts that cannot be opened in the real chat system.

### Phase 3: Replace the Custom Right Rail With Real Chat

Goal:

Make the right panel use the same Backboard/Copilot chat surface, not custom Optimus transcript markup.

This is the most important phase because it directly addresses the user's "exact same as copilot/backboard" requirement.

Implementation options:

1. Preferred: embed a shared chat/conversation component.
   - Backboard equivalent: reuse the real Backboard conversation/panel widget or a renderer extracted from it.
   - Copilot equivalent: reuse the chat widget/session renderer.

2. Acceptable fallback: bridge to an existing chat webview/renderer with identical backing model and shared input behavior.
   - This is only acceptable if the user-visible behavior is truly the same.
   - It should not diverge into a separate Optimus transcript implementation.

3. Not acceptable for final: keep `optimus-chat-messages` and `optimus-chat-input` as the production chat experience.
   - These can remain temporarily as a placeholder while the bridge is developed.

The panel should support:

- Selected run conversation.
- New/draft conversation.
- Empty state with "New Agent" or equivalent action.
- Close button.
- Status badge.
- Real input controls.
- Real message rendering.
- Streaming updates.
- Tool-call and file/context rendering.

Acceptance:

- Selecting a run opens the actual shared conversation.
- Sending in the right panel updates the same conversation visible from Backboard/Copilot surfaces.
- Existing Backboard/Copilot chat controls behave the same in Optimus.
- The custom transcript renderer is removed or left only as a test/mock fallback.

### Phase 4: Upgrade Cards to Live Agent Run Cards

Goal:

Bring Optimus cards closer to Zed's live run cards while keeping the six starter inputs at the top as requested.

Card content should include:

- Status dot and status badge.
- Title.
- Command/task text.
- Provider and model.
- Latest activity.
- Touched file chips.
- Files changed count.
- Branch/worktree label.
- Cost/token usage when available.
- Blocked reason when blocked.
- Apply/review/open-worktree/stop/retry/dismiss actions as capabilities allow.

Card behavior should include:

- Click opens the shared conversation in the right panel.
- Stop stops real run.
- Retry retries real run.
- Review opens review flow.
- Apply applies changes.
- Open worktree opens the run worktree.
- Dismiss hides completed/failed cards without deleting shared history.

Recommendation:

Do not add every Zed control at once if the backing service cannot support it yet. Use capability flags from the bridge:

- `canStop`
- `canRetry`
- `canReview`
- `canApply`
- `canOpenWorktree`
- `canDismiss`

This prevents the UI from showing buttons that cannot work.

Acceptance:

- Starting a task creates a real live card.
- Card state updates as the run progresses.
- Selecting a card opens the real conversation.
- Available actions call real lifecycle methods.
- Unsupported actions are not shown.

### Phase 5: Add Per-Card Quick Chat

Goal:

Add Zed-like quick follow-up inputs to live cards.

This should happen after Phase 3 because per-card chat should send to the real conversation. It should not send to a separate fake transcript.

Behavior:

- Each live run card can show a compact "Message agent..." input.
- Focusing the input selects the run.
- Sending a message routes to the same underlying conversation shown in the right panel.
- If send fails, restore the text and surface the error.
- Empty sends focus the input and do nothing.

Acceptance:

- Card quick chat and right-panel chat stay in sync.
- A message sent from the card appears in the shared conversation.
- The selected run updates when a card input receives focus.

### Phase 6: Add Saved Optimus Tasks

Goal:

Model saved/reusable tasks after Zed's `BackboardTasksPage` while keeping Optimus branding.

The feature should support:

- Saved task id.
- Title.
- Prompt.
- Created/updated timestamps.
- Starter presets.
- Save.
- Run.
- Delete.
- Select/edit.

Starter presets can start from Zed's defaults:

- Review current changes.
- Harden tests.
- Update docs.
- Clean up refactor.

Recommended Optimus adaptation:

- Do not create a separate "Workspace Tasks" page.
- Add a compact saved-tasks drawer, modal, or tab inside Optimus.
- The six starter boxes can optionally be populated from saved tasks or presets.

Persistence:

- Use an existing VS Code storage service if available in the standalone Optimus environment.
- Avoid inventing a separate JSON file unless there is no appropriate storage service.
- If using storage is blocked by standalone isolation, define a small bridge method for saved task persistence.

Acceptance:

- Users can save a prompt as a task.
- Users can run a saved task as a real Backboard/Copilot run.
- Saved tasks persist across restarts.
- Saved tasks do not reintroduce "Workspace" naming.

### Phase 7: Right Panel Open/Close and Resize

Goal:

Match Zed's operational ergonomics.

Features:

- Right panel close button.
- Header toggle to reopen composer/chat.
- Resizable right panel with minimum width.
- Double-click resize handle resets to default.
- Responsive behavior for narrow windows.

Recommended constants, adapted from Zed:

- Default panel width: around 480px.
- Minimum panel width: around 360px.
- Resize handle width: around 8px.
- Opening animation: optional, around 200ms if easy.

Acceptance:

- Users can close the right panel.
- Users can reopen it without losing selected run.
- Users can resize it.
- Layout does not overlap at desktop or narrow widths.

## Data Flow Design

The final Optimus data flow should look like this:

```text
User starts task in Optimus
  -> OptimusApp calls IOptimusSessionBridge.createRun()
  -> Bridge delegates to Backboard or Copilot adapter
  -> Adapter creates shared chat/session/run
  -> Bridge emits run list changed
  -> OptimusRunStore refreshes summaries
  -> OptimusApp renders live card
  -> User opens card
  -> Optimus right panel opens shared conversation
```

For follow-up messages:

```text
User sends message in right panel or card quick chat
  -> Shared chat component or bridge sends message to backing session
  -> Backboard/Copilot runtime streams response
  -> Shared conversation updates
  -> Optimus card summary updates latest activity/status
```

For lifecycle actions:

```text
User clicks Stop/Retry/Review/Apply/Open Worktree
  -> OptimusApp calls bridge method
  -> Bridge routes to provider-specific implementation
  -> Run summary updates through event
  -> Card re-renders with new status/capabilities
```

## Public Interfaces and Types

The current type set should be expanded from demo-oriented run and transcript types into provider-backed session summaries.

Recommended public-ish Optimus types:

```ts
enum OptimusProvider {
	Backboard = 'backboard',
	Copilot = 'copilot'
}

enum OptimusRunStatus {
	Queued = 'queued',
	Running = 'running',
	Done = 'done',
	Blocked = 'blocked',
	Error = 'error',
	Canceled = 'canceled'
}

interface IOptimusRunSummary {
	id: string;
	provider: OptimusProvider;
	title: string;
	command: string;
	status: OptimusRunStatus;
	model?: string;
	cost?: string;
	tokenUsage?: IOptimusTokenUsage;
	speedMetrics?: IOptimusSpeedMetrics;
	latestEvents: IOptimusRunEvent[];
	touchedPaths: string[];
	filesChanged?: number;
	branchLabel?: string;
	worktreeLabel?: string;
	blockedReason?: string;
	capabilities: IOptimusRunCapabilities;
	conversationRef: IOptimusConversationRef;
}

interface IOptimusRunCapabilities {
	canStop: boolean;
	canRetry: boolean;
	canReview: boolean;
	canApply: boolean;
	canOpenWorktree: boolean;
	canDismiss: boolean;
	canQuickChat: boolean;
}
```

The specific names can change to match repo conventions, but the important decision is that cards should render from summaries and capability flags rather than guessing from provider/status alone.

## Current Files of Interest

### Current Optimus

- `src/vs/optimus/browser/optimusApp.ts`
  - Builds the current page shell.
  - Renders the six task inputs.
  - Renders run cards.
  - Renders the custom right chat rail.

- `src/vs/optimus/browser/media/optimus.css`
  - Defines the current 3x2 task grid.
  - Defines current card and right-rail styling.

- `src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts`
  - Defines `OpenOptimusWindowAction`.
  - Exposes Optimus through the Command Palette and File menu.

### Current Optimus Supporting Files

- `src/vs/optimus/common/optimusTypes.ts`
  - Current shared Optimus types.

- `src/vs/optimus/common/optimusChatBridge.ts`
  - Current bridge abstraction.

- `src/vs/optimus/browser/optimusRunStore.ts`
  - Current run state manager.

- `src/vs/optimus/browser/demoOptimusChatBridge.ts`
  - Current demo bridge.
  - Should not remain the production backing implementation.

- `src/vs/optimus/electron-browser/optimus.ts`
  - Standalone renderer bootstrap.

- `src/vs/optimus/optimus.desktop.main.ts`
  - Standalone page main entry.

### Zed Reference

- `../zed/crates/agent_ui/src/agent_workspace_ui.rs`
  - Main Agent Workspace dashboard and right panel.

- `../zed/crates/agent_ui/src/agent_tasks_page.rs`
  - Saved tasks UI and starter presets.

- `../zed/crates/agent_ui/src/agent_panel.rs`
  - AgentPanel lifecycle, run spawning, draft promotion, run actions.

- `../zed/crates/backboard_ui/src/backboard_ui.rs`
  - Backboard panel, API key flow, composer, messages, model selection.

## Acceptance Criteria

The final Optimus implementation should satisfy these requirements.

### Launch and Shell

- `Open Optimus` appears in the Command Palette.
- `Open Optimus` appears in the File menu.
- `--optimus` opens the standalone Optimus page.
- Optimus is not shown as a normal workbench editor page.
- The page title and user-facing copy say Optimus, not Workspace.

### Initial UI

- No top composer appears.
- The initial view shows six starter task boxes or an explicitly chosen Zed-like six-card empty state.
- The current accepted default is six starter task boxes.
- The right panel is visible by default on desktop-sized windows.
- Text does not overlap at common desktop and narrow widths.

### Chat Sharing

- Backboard tasks create or open real Backboard conversations.
- Copilot tasks create or open real Copilot conversations where supported.
- The right panel renders the same shared chat experience used by Backboard/Copilot.
- Messages sent in Optimus are visible in the shared conversation history.
- Existing shared chats can be opened from Optimus.

### Live Runs

- Starting a task creates a live run card.
- Run cards update as the run progresses.
- Run cards show meaningful status, activity, files, and metadata.
- Stop/retry/review/apply/open-worktree actions appear only when supported.
- Completed or failed cards can be dismissed without deleting history.

### Saved Tasks

- Users can save reusable Optimus tasks.
- Users can run saved tasks.
- Users can delete saved tasks.
- Starter presets are available when no saved tasks exist or from a preset picker.

### Regression

- Existing Backboard/Copilot chat surfaces still open normally.
- Existing Agents/Backboard infrastructure is not broken.
- Optimus does not accidentally reintroduce the rejected workspace/workbench page.

## Test Plan

### Static Checks

Run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use --silent && npm run typecheck-client
```

Run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use --silent && npm run valid-layers-check
```

Expected:

- Both pass.
- No new layer violations from Optimus importing workbench-only services directly into the standalone page.

### Build Check

Run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use --silent && npm run transpile-client
```

Expected:

- `out/vs/optimus` is regenerated.
- `out/vs/optimus/browser/media/optimus.css` exists.
- `out/vs/optimus/browser/optimusApp.js` exists.
- No missing Optimus CSS/JS resources at runtime.

### Render Check

Use a lightweight browser harness or Playwright against the compiled modules.

Expected:

- `.optimus-task-input` count is six.
- `.optimus-composer` count is zero.
- Right panel exists.
- No page errors.
- No console errors for missing resources.

### Manual Launch Checks

Command Palette:

1. Start the dev IDE.
2. Open Command Palette.
3. Run `Open Optimus`.
4. Verify the standalone Optimus page opens.

File menu:

1. Start the dev IDE.
2. Open File menu.
3. Select `Open Optimus`.
4. Verify the standalone Optimus page opens.

CLI:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use --silent
TMPDIR=/tmp .agents/skills/launch/scripts/launch.sh -- --optimus
```

Expected:

- Optimus remains open.
- The debug port remains reachable.
- No early Electron exit.

### Shared Chat Checks

After the real bridge is implemented:

1. Start a Backboard task from Optimus.
2. Confirm a Backboard conversation is created.
3. Send a message in Optimus right panel.
4. Open the same conversation from the normal Backboard/Copilot surface.
5. Confirm the message appears there.

Repeat for Copilot if the Copilot adapter supports creating/opening a session from Optimus.

### Run Lifecycle Checks

For Backboard:

- Start a run.
- Confirm card appears.
- Confirm activity updates.
- Stop running task.
- Retry failed/canceled task.
- Review changes when available.
- Apply changes when available.
- Open worktree when available.
- Dismiss completed card.

For Copilot:

- Start or open supported Copilot session.
- Confirm card appears with provider/model.
- Confirm messages and status update.
- Hide unsupported actions.

### Saved Task Checks

After saved tasks are added:

- Create a saved task.
- Restart IDE.
- Confirm task persists.
- Edit task.
- Run task.
- Delete task.
- Confirm starter presets appear when no saved tasks exist or from the preset picker.

## Implementation Risks

### Standalone Window Service Access

Optimus is not a normal workbench page. Many chat services may assume the workbench environment. The bridge must avoid direct imports that violate layer rules or pull the entire workbench into the standalone page.

Mitigation:

- Put provider-specific integration behind main/native/shared services.
- Use IPC or service boundaries already allowed for standalone windows.
- Run `valid-layers-check` frequently.

### Exact Chat UI Reuse

The hardest part is reusing the exact Backboard/Copilot chat panel. The current chat widgets may not be written as embeddable standalone components.

Mitigation:

- First identify the smallest reusable chat renderer boundary.
- If extraction is required, extract a shared component used by both normal chat and Optimus.
- Do not permanently fork the UI.

### Provider Differences

Backboard and Copilot may not expose identical concepts. Backboard has agents, runs, worktrees, review/apply, and tool output. Copilot may expose sessions, models, and chat history differently.

Mitigation:

- Use provider capability flags.
- Render only supported actions.
- Keep the summary model broad but optional.

### Demo State Drift

The demo bridge is useful for local UI development but dangerous if it remains mixed with production behavior.

Mitigation:

- Keep demo bridge only in tests, story/dev harnesses, or a clearly marked fallback.
- Production Optimus should fail clearly if real bridge wiring is unavailable rather than silently showing fake data.

### Screenshot Durability

Some screenshots in this document point to temp paths from the local Codex session. Those are useful for immediate context but may not be durable forever.

Mitigation:

- If this document becomes long-lived team documentation, copy relevant screenshots into a stable docs asset directory and update links.

## Recommended Milestone Breakdown

### Milestone 1: Reliable Optimus Shell

Deliverables:

- Standalone launch works.
- Current UI renders.
- Loader/CSP/resource errors are gone.
- Command Palette/File menu/CLI launch documented.

### Milestone 2: Shared Session Bridge

Deliverables:

- `IOptimusSessionBridge` or equivalent exists.
- Backboard adapter creates/listens to real runs.
- Copilot adapter can list/open or create supported sessions.
- Demo bridge isolated.

### Milestone 3: Real Right Panel

Deliverables:

- Right panel renders real shared chat.
- Selected run opens shared conversation.
- Draft/new agent chat path exists.
- Custom transcript renderer removed from production path.

### Milestone 4: Live Run Cards

Deliverables:

- Cards use real summaries.
- Cards show status/activity/files/model/cost.
- Stop/retry/review/apply/open-worktree actions route to real lifecycle.
- Cards update live.

### Milestone 5: Saved Tasks

Deliverables:

- Saved task model and persistence.
- Starter presets.
- Save/run/delete/edit UX.
- Saved tasks launch real Optimus runs.

### Milestone 6: Zed-Level Polish

Deliverables:

- Per-card quick chat.
- Right panel resize.
- Close/reopen panel behavior.
- Compact operational header.
- Visual refinements based on Zed card proportions.

## Decision Log

### Decision: The Surface Is Optimus

The final surface should say Optimus. Do not reuse "Agent Workspace" as visible product naming, even though the Zed reference uses that name.

### Decision: Standalone, Not Workbench

Optimus should remain a standalone page/window. Reusing services is allowed; turning Optimus into a normal workbench editor page is not.

### Decision: Keep Six Starter Inputs for Now

The current six starter input boxes match the latest direct user request. Zed's shadow cards are useful for visual inspiration, but the current Optimus initial state should remain input-first unless product direction changes.

### Decision: Right Panel Must Be Real Shared Chat

The current custom right rail is temporary. The final right panel must use real Backboard/Copilot chat behavior.

### Decision: Bridge Before Polish

Do not spend too much time making the demo UI prettier before replacing the demo bridge. The highest-value next work is shared session integration.

## Already Built

Current implementation already includes:

- A standalone Optimus source tree under `src/vs/optimus`.
- Optimus HTML/CSS/TS entrypoints.
- Command Palette action.
- File menu action.
- `--optimus` startup argument.
- Six starter task inputs.
- Provider selector per starter input.
- Start button per starter input.
- Basic run cards.
- Basic right chat rail.
- Build output generation through `npm run transpile-client`.

## Still Missing

The remaining work is substantial:

- Real Backboard session bridge.
- Real Copilot session bridge.
- Shared chat panel embedding.
- Existing shared chat discovery/opening.
- Real run summary model.
- Real lifecycle actions.
- Per-card quick chat.
- Saved tasks.
- Right panel resize/close behavior.
- Robust launch automation for `--optimus`.
- Automated regression tests.

## Screenshot-by-Screenshot Product Read

This section records the practical design read from each screenshot. It is intentionally more product-facing than the code audit because screenshots reveal hierarchy, density, and workflow assumptions that are not obvious from source.

### Earlier Agents Screen: What It Gets Right

The earlier Agents screen is not the final Optimus surface, but it shows several mature behaviors that Optimus should eventually inherit.

First, it has session continuity. The left rail lists recent chats with names, folders, and time information. That tells the user this is not a one-shot prompt box. There is history, and history is navigable. Optimus currently has no equivalent. It can show cards for runs created in its current local store, but it does not yet discover or list existing Backboard/Copilot conversations. If Optimus is meant to "share their chats with Copilot/Backboard," a future version needs a way to expose shared history without recreating the whole Agents left rail.

Second, the center of the earlier screen contains a real composer experience. Even though the user rejected the top/input placement for Optimus, the composer itself has important controls: context add, model/provider display, microphone, filter/options, and a send shortcut. The current Optimus starter boxes only have a textarea, provider dropdown, and Start button. That is enough for a launch stub, but it is not enough for parity with Backboard/Copilot chat.

Third, the right side has operational tabs: Changes, Files, Browser. The user asked for the right panel to be the same as Copilot/Backboard, not this file/browser panel. Still, these tabs point to a broader product expectation: agent work is not only messages. It involves files, changes, browsing, and review context. Zed's live cards cover some of this in a dashboard-oriented way through files changed, branch/worktree, review/apply, and open-worktree actions. Optimus should prefer the Zed card model over copying the earlier Agents right tab model.

### Earlier Agents Screen: What Optimus Should Avoid

Optimus should avoid copying the left session list wholesale. The user specifically pushed away from associating Optimus with other pages. A large session rail would make Optimus feel like another chat workspace rather than a multi-agent launch and control surface. Existing chat history should be accessible, but it should not dominate the first viewport.

Optimus should also avoid the central empty-state prompt copy from the earlier screen. Text like "What should Backboard do?" and "Pick a workspace" conflicts with the user direction to call the feature Optimus and not frame it as Workspace. Any copied empty state must be rewritten.

Finally, the earlier screen's main composer is one-at-a-time. Optimus is supposed to feel like a multi-agent control surface. The six starter boxes create an immediate sense that multiple tasks can be started or staged. That is one reason the current Optimus design, while less mature, is aligned with the new product direction.

### Earlier Optimus Top-Composer Screen: What It Gets Right

The rejected Optimus screenshot still had useful qualities:

- It was clearly branded as Optimus.
- It was standalone and visually separated from the normal VS Code shell.
- It had a direct Backboard/Copilot provider selector.
- It had a large, easy-to-understand Start button.

Those are worth keeping. The main issue was not brand or basic controls; it was layout. The single top input made Optimus feel like a horizontal prompt bar, not a dashboard. It also consumed the header area and made the page feel top-heavy. The current design fixes that by moving input into six boxes in the main body.

### Earlier Optimus Top-Composer Screen: What It Gets Wrong

The top-composer screen collapsed all launch intent into one input. For a single-agent chat app, that is acceptable. For Optimus, it hides the multi-agent concept. A user cannot see six potential tasks, compare them, or think in batches. It also left no visual space for live run cards to become the primary content after launch.

The right panel was absent from that screenshot. The user called this out indirectly by asking for the right panel to match Copilot/Backboard. Optimus should treat the right panel as a first-class part of the product, not something that appears only after opening a run.

### Current Optimus Screen: What It Gets Right

The current Optimus screenshot correctly addresses the immediate visual feedback. It has six visible starter boxes arranged as a 3x2 board. The first box is focused. The top composer is gone. The right panel is visible from the beginning. The page is dark, restrained, and closer to an operational tool than a marketing page.

The current page also preserves the provider choice directly next to each task. That is useful for fast mixed-provider work. A user can start one Backboard task and one Copilot task from the same grid without changing a global setting. This may be better than Zed's model if Optimus is explicitly cross-provider.

The current right panel has the right rough anatomy: header, empty message area, bottom input. It is not the real panel yet, but the space reservation is correct. That matters because the layout will not need to be completely redesigned when the real shared chat component is embedded.

### Current Optimus Screen: What Is Still Weak

The current six boxes are visually identical and empty. They do not yet communicate task presets, saved tasks, run status, or multi-agent strategy. Zed's shadow cards communicate "agent work will appear here" more clearly, while Zed's saved tasks communicate "these are reusable agent prompts." Optimus currently says "Give an agent a task" six times. That is functional but not yet sophisticated.

The page also lacks a compact operational header. "Optimus" and "Standalone multi-agent control surface" are useful for early development, but they may be too descriptive for a daily-use surface. Once the product is stable, the header should shrink and trade explanatory text for controls: New Agent, saved tasks, active count, panel toggle, provider/account status.

The right panel empty state says "Select a run to inspect its chat" while the input placeholder says "Open a task to chat." That is understandable, but it reveals the temporary nature of the panel. In the real product, the empty state should either open a new Backboard/Copilot draft or explain that selecting a live card opens its shared conversation. Better: provide a visible New Agent action in the right panel.

### Zed Shadow Card Asset: What It Communicates

The Zed shadow card asset is not just decoration. It encodes an expected card structure:

- A top header strip.
- A title/status region.
- A command or prompt section.
- Activity rows.
- A footer region.
- A bottom input or control area.

This gives the user a preview of what live cards will look like. It makes the empty dashboard feel like a waiting control deck rather than a blank form. Optimus can borrow this concept even while keeping live starter inputs. For example, each starter input box could eventually be styled as a "pre-run card" with the same header/footer structure as live cards. Starting the task would promote the starter card into a live run card instead of adding a separate card below.

## Traceability Matrix

This matrix maps user intent to the current implementation and the next required build step.

| User intent | Current evidence | Current status | Next step |
|---|---|---|---|
| "Call it Optimus" | UI title and command say Optimus | Done for current UI | Keep all new copy Optimus-specific |
| "Not workspace" | Source lives under `src/vs/optimus`; standalone entrypoint exists | Mostly done | Avoid visible Workspace copy in future tasks/saved docs |
| "Not a workbench" | Separate HTML/desktop entrypoint and native open path | Mostly done | Ensure chat bridge does not turn it into a workbench editor |
| "Share chats with Copilot/Backboard" | Provider dropdown exists only | Not done | Build real session bridge |
| "Right panel exact same as Copilot/Backboard" | Custom right rail exists | Not done | Embed/reuse real chat component |
| "Remove top input" | `.optimus-composer` removed from current source | Done | Regression check in UI tests |
| "3x2 box input ready at start" | Six `.optimus-task-input` nodes render | Done | Connect boxes to real task launch |
| "Compare to Zed" | This document maps Zed code and screenshots | Done as documentation | Use as implementation guide |

## Detailed Implementation Notes for the Shared Chat Bridge

The bridge is the most important technical decision. It should be designed before any large UI polish because it determines what data the UI can honestly show.

### Bridge Responsibilities

The bridge should own provider-specific work. Optimus UI should not know how to create a Backboard assistant thread, how to open a Copilot session resource, or how to apply Backboard worktree changes. It should call product-level methods and render returned summaries.

Responsibilities:

- Discover existing provider sessions relevant to Optimus.
- Create new provider-backed runs.
- Convert provider-specific run/session state into Optimus summaries.
- Expose events for run/session changes.
- Route lifecycle actions to the correct provider.
- Provide handles or mount instructions for the real chat UI.
- Persist saved task data or delegate persistence to the correct storage service.

Non-responsibilities:

- The bridge should not render DOM.
- The bridge should not make layout decisions.
- The bridge should not fake production messages.
- The bridge should not expose provider internals directly to `OptimusApp`.

### Backboard Adapter

The Backboard adapter should map most closely to Zed. Backboard has the richer run lifecycle, including worktrees, apply/review state, tool calls, and file changes.

Expected Backboard adapter behavior:

- Start a Backboard run from a task prompt.
- Track the backing thread id.
- Return a run summary with status, title, command/task, latest activity, files changed, touched paths, branch/worktree labels, model, cost, and capabilities.
- Open the real Backboard conversation in the right panel.
- Send follow-up messages to the same thread.
- Stop/retry/review/apply/open-worktree where supported.

The adapter should treat Backboard as the first provider to fully support the Zed-like dashboard because the Zed reference is Backboard-oriented.

### Copilot Adapter

Copilot may not support every Backboard lifecycle concept. That is acceptable. The adapter should still support shared chat behavior where possible.

Expected Copilot adapter behavior:

- Create or open a Copilot-backed session if supported by existing infrastructure.
- Return a run/session summary with provider, title, status, model, and latest activity.
- Open the real Copilot chat in the right panel.
- Send follow-up messages through the same Copilot session.
- Hide Backboard-only actions such as apply/review/open-worktree unless equivalent functionality exists.

The key is not to force Copilot into the Backboard model. Optimus should be multi-provider, but provider capabilities should be explicit.

### Conversation Mounting

The right panel needs a way to mount the real conversation. There are a few possible approaches:

1. The bridge returns an embeddable component/view object.
2. The bridge returns a session resource and Optimus asks a shared chat renderer to mount it.
3. The bridge owns an iframe/webview-like mount point.
4. The bridge opens an existing panel inside the right area through an IPC-controlled host.

The first two are preferable because they keep the right panel native and testable. The fourth is riskier because it can couple Optimus to workbench layout behavior.

The implementation should start by identifying the smallest existing chat renderer that can be reused outside the normal workbench shell. If no such renderer exists, the right move is to extract one, not to copy the markup.

## Detailed UI Evolution Plan

### Starter Box to Live Card Promotion

Current Optimus appends live cards after the starter board. That works but may become visually crowded. A better future interaction is card promotion:

1. User types in starter box.
2. User selects provider.
3. User clicks Start.
4. The starter box becomes a queued/running live card.
5. A new empty starter box appears if fewer than six starter slots remain.

This preserves the 3x2 launch feel while making the dashboard feel alive. It also avoids a permanent wall of empty inputs above real work.

If promotion is too large for the next phase, keep the current "starter board above cards" behavior until the bridge is working. Do not block backend correctness on this polish.

### Header Evolution

The current header should eventually become more compact. Suggested final header:

```text
Optimus | New Agent | 3 active | 2 blocked | Saved Tasks | Backboard connected | [right panel toggle]
```

Rules:

- Keep it short.
- Do not include explanatory product copy after the feature is stable.
- Show API/account status only when useful.
- Use icons with tooltips for panel toggle/settings.

### Right Panel Empty State

The current empty state is serviceable but passive. A better final empty state:

- Backboard/Copilot icon or provider selector.
- Text: "Start or select an agent chat."
- Primary action: New Agent.
- Secondary action: Open existing chat.

This reinforces that the right panel is a chat surface, not merely an inspector.

### Card Density

Zed cards are taller and denser than current Optimus starter boxes. Optimus live cards should target an operational density:

- Tall enough to show 4-6 activity rows.
- Wide enough for title, status, and primary metadata.
- No nested cards.
- Buttons should be compact and action-specific.
- File chips should truncate safely.
- Long task text should clamp rather than expand the card indefinitely.

The card should be readable at three columns on a wide display and two columns when the right panel consumes width.

## Documentation Maintenance Notes

This file is intentionally large because it captures design intent, code references, screenshots, and a build plan in one place. It should be treated as a planning artifact, not as end-user documentation.

When implementation progresses:

- Update the "Already Built" and "Still Missing" sections.
- Replace temp screenshot links with stable checked-in assets.
- Mark completed milestones.
- Remove obsolete demo-bridge warnings once the demo bridge is no longer in the production path.
- Add final architecture diagrams only after the bridge shape is known.

If this document becomes too large for daily use, split it later into:

- `OPTIMUS_ZED_COMPARISON.md`
- `OPTIMUS_ARCHITECTURE.md`
- `OPTIMUS_IMPLEMENTATION_PLAN.md`

For now, keeping it in one file is useful because the product direction is still being consolidated.

## Conclusion

Current Optimus is a useful first standalone shell and now matches the immediate visual correction: no top composer, six starter inputs, and a right-side chat-shaped panel. It is not yet the Zed-equivalent multi-agent control surface. The Zed reference shows that the real product value comes from connecting dashboard cards, right-panel conversations, saved tasks, and run lifecycle actions to one shared agent/session model.

The next implementation should focus on the shared session bridge and real right-panel chat embedding. Once that is in place, live cards, lifecycle controls, per-card chat, and saved tasks can be layered on without rewriting the UI again.
