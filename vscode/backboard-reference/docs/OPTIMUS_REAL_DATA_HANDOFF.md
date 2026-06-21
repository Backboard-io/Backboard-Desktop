# Optimus Real Data Handoff

This document explains what the Optimus surface is, how it starts, where data currently comes from, what still counts as fake or transitional, and how to continue replacing the remaining fake/demo paths with real shared Backboard/Copilot session state.

It also covers this startup failure:

```text
Failed to load resource: net::ERR_FILE_NOT_FOUND
TypeError: Failed to fetch dynamically imported module:
vscode-file://vscode-app/.../out/vs/optimus/optimus.desktop.main.js
```

## Current Status

Optimus is a standalone VS Code/Electron page under `src/vs/optimus`. It is not a normal workbench editor page. It has its own HTML entrypoint and desktop main module, and it can be opened through the `Open Optimus` command or `--optimus`.

Recent changes removed the explicit demo bridge:

- Deleted: `src/vs/optimus/browser/demoOptimusChatBridge.ts`
- Changed: `src/vs/optimus/browser/optimusApp.ts`

New Optimus prompts no longer create an in-memory fake draft run before a real prompt exists. Starting a task slot now opens/selects a starter prompt state, and submitting sends through the shared Backboard history/command provider.

This is progress, but Optimus is not fully real yet. The right panel is still custom Optimus DOM, and `ElectronOptimusBackboardBridge` still has local `runs` and `transcripts` maps for legacy run-card compatibility. The final product should replace those with real chat/session models.

## What Optimus Is Supposed To Be

Optimus is intended to be a multi-agent control surface:

- Left side: a dashboard of starter slots, real active runs, and recent/history cards.
- Right side: the actual shared Backboard/Copilot conversation surface for the selected card.
- Header: mode switcher, workspace selector, new-agent action, active count, and panel toggle.
- Data source: real shared session/chat state, not Optimus-owned fake state.

The important product rule is:

Optimus should not own the conversation truth. It should render and control shared sessions.

## Entrypoints And Startup

### Command Palette And Menu

The workbench action is:

```text
src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts
```

`OpenOptimusWindowAction` calls `INativeHostService.openOptimusWindow()`.

### Native Window Creation

The native window path is:

```text
src/vs/platform/windows/electron-main/windowsMainService.ts
src/vs/platform/windows/electron-main/windowImpl.ts
src/vs/platform/launch/electron-main/launchMainService.ts
```

`openOptimusWindow()` marks the window config with `optimusWindow: true`.

`windowImpl.ts` sees `configuration.isOptimusWindow` and loads:

```text
vs/optimus/electron-browser/optimus-dev.html
```

in dev, or:

```text
vs/optimus/electron-browser/optimus.html
```

in built mode.

### Renderer Bootstrap

The HTML loads:

```text
src/vs/optimus/electron-browser/optimus.ts
```

That file resolves the native window configuration, sets NLS globals, computes `_VSCODE_FILE_ROOT`, then dynamically imports:

```text
out/vs/optimus/optimus.desktop.main.js
```

in dev output.

The actual app construction is in:

```text
src/vs/optimus/optimus.desktop.main.ts
```

It creates:

- `ElectronOptimusBackboardBridge`
- `ElectronOptimusHistoryProvider`
- `ElectronOptimusNavigationProvider`
- `OptimusRunStore`
- `OptimusApp`

Then it calls `app.start()`.

## Why The ERR_FILE_NOT_FOUND Happens

This error means the Optimus HTML loaded, but the compiled JS module it dynamically imports did not exist in `out/` at that moment:

```text
out/vs/optimus/optimus.desktop.main.js
```

The source file is:

```text
src/vs/optimus/optimus.desktop.main.ts
```

The browser does not import the TypeScript source. It imports the generated JavaScript in `out/`.

Common causes:

- The TypeScript watcher was not running.
- The watcher had not emitted `out/vs/optimus/optimus.desktop.main.js` yet.
- `out/` was cleaned.
- A previous compile failed before emitting Optimus files.
- The window was opened before the dev build caught up.

To verify:

```sh
ls -la out/vs/optimus/optimus.desktop.main.js
ls -la out/vs/optimus/electron-browser/optimus.js
```

To fix during development, run the normal watch path that emits `out/`:

```sh
npm run watch
```

For a narrower client-only loop:

```sh
npm run watch-client-transpile
npm run watch-client
```

Do not confuse this with:

```sh
npm run typecheck-client
```

`typecheck-client` validates TypeScript but does not emit JavaScript into `out/`, so it will not fix a missing dynamic import file.

## Main Optimus Files

### `src/vs/optimus/browser/optimusApp.ts`

This is the main DOM application.

It owns:

- the header
- mode switcher
- workspace selector
- starter/history grid
- right drawer shell
- custom history transcript rendering
- custom composer
- responsive layout

Important methods:

- `start()`: installs the Optimus root and loads history/workspaces.
- `renderShell()`: creates the main header, grid, and drawer.
- `renderTaskBoard()`: chooses between history cards and starter/run slots.
- `startDraftTask()`: now selects a starter and opens a Backboard new-chat command; it no longer creates a fake queued run.
- `createRun()`: now sends the prompt through `IOptimusHistoryProvider.sendBackboardPrompt()` and refreshes shared history.
- `renderDrawer()`: still renders custom DOM for the right panel.
- `renderHistoryTranscript()`: renders persisted shared history messages as Optimus message cards.
- `renderFollowupForm()`: sends follow-ups either through the old run store path or the shared history provider.

Current limitation:

`renderDrawer()` is still custom UI. It is backed by real shared history for history entries, but it is not the actual `ChatWidget`/Backboard conversation view.

### `src/vs/optimus/browser/optimusRunStore.ts`

This is a transitional local store over `IOptimusChatBridge`.

It owns:

- local run map
- selected run id
- create/send/stop/retry/review/apply/open methods

This should eventually go away or become a thin projection cache over real sessions. It should not be the product source of truth.

### `src/vs/optimus/common/optimusTypes.ts`

This defines the transitional Optimus-local run model:

- `IOptimusRun`
- `IOptimusTranscript`
- `IOptimusRunRequest`
- status enums
- capability flags

This model is useful for rendering cards, but it is not the final source-of-truth model. In the final architecture, cards should be projected from real session metadata such as `IChatSessionItem`, `IAgentSession`, or provider-specific Backboard/Copilot metadata.

### `src/vs/optimus/common/optimusChatBridge.ts`

This defines `IOptimusChatBridge`.

It is currently run-oriented:

```ts
createRun(...)
sendMessage(...)
stopRun(...)
retryRun(...)
openTranscript(...)
```

This shape encourages Optimus to own run state. Long term, replace or shrink it. The better shape is a session bridge:

```ts
listSessions(): Promise<IOptimusSessionSummary[]>;
openSession(resource: URI): Promise<void>;
createSession(request): Promise<URI>;
sendPrompt(resource: URI, prompt: string): Promise<void>;
```

### `src/vs/optimus/electron-browser/optimusBackboardBridge.ts`

This is the current Electron bridge for run actions.

It still has local maps:

```ts
private readonly runs = new Map<string, IOptimusRun>();
private readonly transcripts = new Map<string, IOptimusTranscript>();
```

That is still fake/transitional. It sends commands to the real Backboard panel, but then creates local Optimus summaries like:

- "Sent to Backboard editor panel"
- "Opened shared Backboard right panel"
- "Waiting for Backboard history sync"

This file should be treated as compatibility code, not final architecture.

### `src/vs/optimus/electron-browser/optimusHistoryService.ts`

This is the more real path today.

It calls main-process IPC:

- `vscode:optimusBackboardHistory`
- `vscode:optimusBackboardWorkspaces`
- `vscode:optimusBackboardCommand`
- `vscode:optimusSwitchWindowKind`

It exposes:

- `listBackboardHistory()`
- `listBackboardWorkspaces()`
- `openBackboardHistory()`
- `openBackboardHistoryEntry()`
- `openBackboardNewChat()`
- `sendBackboardPrompt()`

This is the current best bridge because it uses shared Backboard state and commands instead of local fake runs.

### `src/vs/code/electron-main/app.ts`

This owns the main-process Optimus IPC handlers:

- `vscode:optimusBackboardHistory`
- `vscode:optimusBackboardWorkspaces`
- `vscode:optimusBackboardCommand`

It also reads Backboard history from:

- `~/.backboard_ide/panel-state.json`
- `~/.backboard_ide/threads/**/*.json`
- `~/.backboard_ide/optimus-shared-chat-history.json`

And it writes Optimus commands to:

```text
~/.backboard_ide/optimus-command.json
```

Important limitation:

This is real persisted/shared Backboard state, but it is not a live in-memory chat model. It is a file-backed bridge.

### `extensions/backboard/src/extension.ts`

This is the current Backboard extension-side consumer of Optimus commands.

It watches:

```text
~/.backboard_ide/optimus-command.json
```

and dispatches commands:

- `newChat`
- `showHistory`
- `showChat`
- `openHistoryEntry`
- `sendPrompt`
- `cancel`
- `reviewChanges`

This means Optimus can tell the existing Backboard panel what to do without owning Backboard internals.

Important limitation:

This is still an indirect file command bridge. It is useful, but the final Optimus right panel should not depend on a separate Backboard webview being opened elsewhere.

## What Counts As Fake Or Transitional Now

### Removed

`src/vs/optimus/browser/demoOptimusChatBridge.ts` was explicit fake data. It created fake runs, fake touched files, fake branches, fake cost, and fake transcripts. It has been removed.

### Still Transitional

`ElectronOptimusBackboardBridge` still creates local `IOptimusRun` objects and local transcripts after sending commands to Backboard. That means any path using `OptimusRunStore.createRun()` still gets synthetic Optimus cards.

`OptimusRunStore` still stores local runs. It should not remain as the primary state model.

`IOptimusRun` and `IOptimusTranscript` are Optimus-specific representations. They should become view models derived from real session data, not persisted/owned state.

`renderHistoryTranscript()` renders messages itself. The messages may be real persisted history, but the UI is still custom Optimus DOM.

`renderFollowupForm()` is still a custom composer. It can send through real Backboard command paths, but it is not the actual chat input widget.

`readOptimusBackboardHistory()` normalizes file snapshots. That is real saved data, but not a live model.

## The Right Panel: Today vs Target

### Today

The right panel is an Optimus `aside`:

```text
optimus-drawer
  optimus-drawer-body
    recentTabsShell
    statusBar
    viewStack
    composer
```

It shows one of:

- empty state
- starter prompt state
- history list
- history transcript
- legacy selected run transcript

This is useful, but it is not the real shared chat surface.

### Target

The right panel should host the real chat/session surface.

The strongest existing candidate is the Sessions chat view stack:

```text
src/vs/sessions/browser/parts/chatView.ts
src/vs/sessions/contrib/chat/browser/chatView.ts
src/vs/sessions/services/chatView/browser/chatViewFactory.ts
```

`ChatView` creates a real `ChatWidget`, loads a real chat model through `IChatService.acquireOrLoadSession()`, and locks the widget to the correct coding agent/session type.

The final right panel should do this:

```text
Optimus selected card
  -> real session/chat resource
  -> ChatView.setChat(real IChat)
  -> ChatWidget renders actual conversation
```

It should not do this:

```text
Optimus selected card
  -> IOptimusTranscript
  -> renderMessageCard()
  -> custom textarea composer
```

## Hard Architectural Constraint

The standalone Optimus window currently does not boot the full workbench or Sessions service graph. A real `ChatWidget` needs many workbench services:

- `IChatService`
- `IChatSessionsService`
- `IContextKeyService`
- `IInstantiationService`
- `IConfigurationService`
- `IThemeService`
- `ILogService`
- chat contribution registrations
- session provider registrations

You cannot safely just import `ChatWidget` into `src/vs/optimus` and instantiate it in the current standalone renderer. It will either fail due to missing services or create a parallel, incomplete chat world.

This creates two implementation choices.

## Recommended Direction

### Option A: Make Optimus A Sessions/Workbench-Backed Standalone Surface

Keep Optimus visually standalone, but run it inside a service environment that already has the real chat/session services.

This is the cleaner product path.

Implementation idea:

1. Keep `Open Optimus` opening a special Optimus window.
2. Instead of booting a minimal `vs/optimus/optimus.desktop.main.js`, boot a Sessions/workbench-backed page mode.
3. Add an Optimus part/view inside the Sessions layer that can use `IChatViewFactory`.
4. Render the Optimus dashboard on the left and a real `ChatView` on the right.

Pros:

- Real `ChatWidget`.
- Real session model.
- Real agent lifecycle.
- No duplicate composer.
- No fake transcript rendering.

Cons:

- Bigger architecture change.
- Requires Optimus to share more of the Sessions/workbench runtime.

### Option B: Build A Minimal Chat Service Host Inside Optimus

Keep the current lightweight standalone Optimus renderer, but manually bootstrap enough services to create `ChatView`.

This is not recommended unless there is a strong reason Optimus must avoid Sessions/workbench runtime.

Pros:

- Keeps current standalone bootstrap.

Cons:

- Easy to create duplicated services.
- High risk of missing chat/session contributions.
- Harder to keep behavior identical to Backboard/Copilot.

### Option C: Embed/Proxy The Backboard Extension Webview

Use the existing `extensions/backboard` webview as the right panel.

This is a compatibility fallback, not the best final design.

Pros:

- Fastest route to "looks like real Backboard."
- Reuses current Backboard panel implementation.

Cons:

- Webviews are not designed to be moved across windows/surfaces.
- Still not the standard `ChatWidget`.
- Couples Optimus to extension-webview internals.

## Concrete Implementation Plan

### Phase 1: Stop Creating Optimus-Owned Runs

Goal:

No new Optimus prompt should create a synthetic `IOptimusRun`.

Current progress:

- `startDraftTask()` no longer creates an in-memory queued run.
- `createRun()` sends through `historyProvider.sendBackboardPrompt()`.
- The explicit demo bridge has been removed.

Next:

- Remove or deprecate `OptimusRunStore.createRun()` call sites.
- Remove legacy selected-run transcript paths from `OptimusApp`.
- Remove the `IOptimusChatBridge.createRun()` path once no call sites use it.
- Keep run-card rendering only if cards are backed by real session summaries.

Search commands:

```sh
rg -n "createRun\\(|OptimusRunStore|IOptimusRun|IOptimusTranscript|openTranscript|renderMessageCard|renderFollowupForm" src/vs/optimus
```

### Phase 2: Replace `IOptimusRun` With Session Summaries

Create a new summary type that is explicitly derived from real state:

```ts
export interface IOptimusSessionSummary {
	readonly resource: URI;
	readonly title: string;
	readonly providerId: string;
	readonly status: 'queued' | 'running' | 'blocked' | 'done' | 'error' | 'canceled';
	readonly workspace?: string;
	readonly updatedAt?: number;
	readonly fileChanges?: {
		readonly files: number;
		readonly insertions?: number;
		readonly deletions?: number;
	};
	readonly canOpen: boolean;
	readonly canStop: boolean;
	readonly canReview: boolean;
}
```

Then implement a provider:

```ts
export interface IOptimusSessionProvider {
	readonly onDidChangeSessions: Event<void>;
	listSessions(): Promise<readonly IOptimusSessionSummary[]>;
	openSession(resource: URI): Promise<void>;
	createSession(prompt: string, workspace?: URI): Promise<URI>;
	sendPrompt(resource: URI, prompt: string): Promise<void>;
}
```

Map from:

- `IAgentSessionsService.model.sessions`
- `IChatSessionsService` items/providers
- Backboard history snapshots as a temporary fallback

The left grid should render `IOptimusSessionSummary`, not `IOptimusRun`.

### Phase 3: Replace The Right Panel With A Real Chat Host

Create an Optimus right-panel host interface:

```ts
export interface IOptimusChatSurface {
	readonly element: HTMLElement;
	openNewChat(workspace?: URI): void;
	openChat(chat: IChat, historyKey?: string): void;
	prefillInput(text: string): void;
	sendQuery(text: string): void;
	layout(width: number, height: number): void;
}
```

Back it with `IChatViewFactory`:

```ts
const view = chatViewFactory.createChatView();
container.replaceChildren(view.element);
view.setChat(chat, historyKey);
```

For new chats:

```ts
const view = chatViewFactory.createNewChatView(false, options);
container.replaceChildren(view.element);
view.prefillInput(prompt);
```

This requires Optimus to run in an environment where `IChatViewFactory` is registered.

### Phase 4: Remove Custom Transcript And Composer UI

Once the real chat host exists, remove from `OptimusApp`:

- `selectedTranscript`
- `renderHistoryTranscript()`
- `renderMessageCard()`
- `renderFollowupForm()`
- `renderPanelChangeStack()` if the real chat/change widgets cover it
- legacy run follow-up branches

The right panel should only contain:

- real chat host mount
- optional thin Optimus chrome around it, if needed

### Phase 5: Remove File-Backed Command Bridge For Live Operations

The file bridge can remain temporarily for compatibility:

```text
~/.backboard_ide/optimus-command.json
```

But live Optimus operations should eventually call real services directly.

Remove or demote:

- `vscode:optimusBackboardCommand`
- `writeOptimusBackboardCommand()`
- Backboard extension watcher for `optimus-command.json`

Keep file-backed history only as a fallback/import path, not as the primary live surface.

### Phase 6: Validation

Required after TypeScript changes:

```sh
npm run typecheck-client
npm run valid-layers-check
```

For the runtime missing-file problem, also verify generated output:

```sh
ls -la out/vs/optimus/optimus.desktop.main.js
ls -la out/vs/optimus/electron-browser/optimus.js
```

Then open Optimus from:

- Command Palette: `Open Optimus`
- CLI: app binary with `--optimus`

Manual behavior checks:

- Optimus opens without `ERR_FILE_NOT_FOUND`.
- New Agent opens the right panel without creating a fake queued run card.
- Sending a prompt goes to the shared Backboard panel/history path.
- History refresh shows the real saved Backboard entry.
- Opening a history card opens the shared Backboard history entry.
- No message in the UI says "demo", "future adapter", or "fake".

## Migration Checklist

- [x] Delete explicit `DemoOptimusChatBridge`.
- [x] Stop starter slots from creating fake queued runs.
- [x] Send new prompts through shared Backboard provider.
- [ ] Stop using `ElectronOptimusBackboardBridge.runs`.
- [ ] Stop using `ElectronOptimusBackboardBridge.transcripts`.
- [ ] Replace `OptimusRunStore` with real session summaries.
- [ ] Replace `IOptimusRun` rendering with projected `IOptimusSessionSummary`.
- [ ] Replace custom drawer transcript with real `ChatView`.
- [ ] Replace custom composer with real `ChatWidget` input.
- [ ] Stop using `optimus-command.json` for live chat operations.
- [ ] Keep file-backed history only as fallback/import.

## Practical Next Patch

The next high-value patch should remove the legacy run path from `OptimusApp`.

Target removals:

```text
selectedTranscript
openRun()
renderRunCard() dependency on IOptimusRun
renderMessageCard()
renderPanelChangeStack()
store.openTranscript()
```

Replace with:

```text
selectedSessionResource
openSession(resource)
renderSessionCard(summary)
real chat host mount
```

Do not spend more time making `IOptimusRun` richer. That improves the wrong abstraction. The real product value comes from replacing it with real shared session state.

## Summary

Optimus is already a useful standalone shell. The explicit demo bridge is gone, and new prompt submission now goes through the shared Backboard path. The remaining work is to stop treating Optimus as a run owner. The left side should become a projection of real sessions, and the right side should become a host for the real chat/session UI.

The `ERR_FILE_NOT_FOUND` startup failure is a separate generated-output issue: the dev renderer tried to import `out/vs/optimus/optimus.desktop.main.js`, but that emitted file was missing at runtime. Run the watch/transpile pipeline and verify `out/vs/optimus/optimus.desktop.main.js` exists before opening Optimus.
