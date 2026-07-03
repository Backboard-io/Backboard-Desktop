# How the Chat UI Is Generated

The chat UI is a hybrid: **Microsoft's upstream chat widget** (`vs/workbench/contrib/chat`)
does the message list, markdown, and tool parts; **Backboard's sessions layer** wraps it in
its own composers, pickers, layout grid, and CSS.

## Rendering pipeline (data model → DOM)

```
 Session data model (IActiveSession)
 ├─ workspace: IObservable<ISessionWorkspace>
 ├─ isCreated: IObservable<boolean>
 └─ chat model (via IChatService)
     ├─ messages: markdown / content parts
     └─ tool invocations: state: IObservable<StateKind>   (doc 05)
                │  observables mutate as stream arrives
                ▼
 AbstractChatView                     src/vs/sessions/browser/parts/chatView.ts:47-157
 ├─ kind: 'newSession' | 'newChatInSession' | 'chat'
 ├─ element: HTMLElement ('.chat-view', a grid leaf)
 ├─ setChat() / prefillInput() / sendQuery() / attach()
 └─ showProgressWhile()  (lazy ScopedProgressIndicator, :136-147)
                │  created by
                ▼
 IChatViewFactory                     src/vs/sessions/services/chatView/browser/chatViewFactory.ts:17-31
 ├─ createNewChatView(isNewChatInSession, options)
 └─ createChatView()
                │  concrete impls in src/vs/sessions/contrib/chat/browser/
                ▼
 NewChatWidget                        src/vs/sessions/contrib/chat/browser/newChatWidget.ts
 │  render(parent) (:202-242):
 │   .sessions-chat-widget
 │     └─ .new-chat-widget-container
 │          └─ .new-chat-widget-content        (CSS grid, 5 rows)
 │               ├─ middle section (toolbar/title)
 │               └─ .new-chat-composer-stack
 │                    ├─ workspace row (picker + git status chip)
 │                    ├─ ChatWidget.render()   ← upstream widget
 │                    └─ composer suggestions
                │
                ▼
 ChatWidget (UPSTREAM)                src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts
 ├─ InputPart   — editor, model/mode/workspace/session-type/permission pickers
 ├─ ListPart    — virtualized message list
 └─ Followups
                │
                ▼
 ChatListRenderer + chatContentMarkdownRenderer
 ├─ per message: role, content parts (text, markdown, refs, tool invocations…)
 ├─ autorun() on observables → row re-render on each stream delta
 └─ tool invocation parts (doc 05) chosen by state
                │
                ▼
 DOM (CSS grid + flex, themed via color tokens)
```

## How Backboard instantiates the upstream widget

`newChatWidget.ts:119-147` — the important knobs:

```ts
scopedInstantiationService.createInstance(ChatWidget,
	ChatAgentLocation.Chat, undefined,
	{
		autoScroll: mode => mode !== ChatModeKind.Ask,
		renderFollowups: true,
		supportsFileReferences: true,
		rendererOptions: {
			referencesExpandedWhenEmptyResponse: false,
			progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
		},
		enableImplicitContext: true,
		enableWorkingSet: 'explicit',
		supportsChangingModes: false,
		isSessionsWindow: true,               // ← sessions-window styling/behavior
		inputEditorMinLines: 2,
		workspacePickerDelegate: …,           // Backboard delegates injected
		sessionTypePickerDelegate: …,
		submitHandler: async query => this._sendFromSharedComposer(query),
	},
	{ listForeground: activeSessionViewForeground, /* Backboard color tokens */ });
```

So Backboard customizes the widget entirely through options + delegates + theme tokens —
the rendering machinery itself is upstream.

## Layout grid & CSS

`src/vs/sessions/contrib/chat/browser/media/chatWidget.css:76-93`:

```
.new-chat-widget-content
grid-template-rows: 52px  minmax(56px,1fr)  auto  auto  minmax(56px,1fr)
                    ─────  ──────────────  ────  ────  ──────────────
 row 1  52px   simple header
 row 2  ≥56px  flexible space above
 row 3  auto   title / description
 row 4  auto   .new-chat-composer-stack  (centered, width min(1120px, 100%-96px))
 row 5  ≥56px  flexible space below / chat output
```

Responsive picker behavior uses container queries: below 330px the pickers go icon-only, with
the permission picker keeping its label until 240px (`:829-862`). Session-window chrome CSS
lives in `src/vs/sessions/browser/media/style.css` and
`src/vs/sessions/contrib/sessions/browser/media/sessionsViewPane.css`.

## Streaming updates

Everything is observable-driven — there is no manual DOM patching in Backboard code:

- Text deltas append to the message's markdown content; the renderer's `autorun` re-renders
  that row.
- Tool invocations re-render on `state` / `toolSpecificDataKind` changes.
- Executing tools update via `progress: IObservable<{message?, progress?}>`.
- The git status chip re-renders via `autorun` on the session's workspace observable
  (`newChatWidget.ts:266-302`).

Session caching quirk (`newChatWidget.ts:104-110`): the widget caches the previous session
while a new one is mid-creation, so the composer doesn't flicker:

```ts
this._session = derivedObservableWithCache((reader, prev) => {
	const active = this.sessionsService.activeSession.read(reader);
	if (active && active.isCreated.read(reader)) { return prev; }
	return active;
});
```

## History loading & session creation

- On load, the workspace picker is synced from the active session **without firing events**
  (prevents accidentally creating a new session): `_syncWorkspacePickerFromActiveSession()`
  (`:351-364`); if no active session but a restored folder exists, a session is created
  (`:231-239`).
- Late-registering providers can upgrade a session's type after the fact:
  `_createNewSession()` schedules `_scheduleRecreateOnProviderChange()` when the preferred
  provider isn't servable yet (`:372-388`).
- Async history loads show an indeterminate progress bar through
  `AbstractChatView.showProgressWhile()` with optional delay to avoid flashes.

## What's Backboard vs upstream

| Piece | Owner |
|---|---|
| Message list, markdown renderer, tool invocation parts, input editor | **Upstream** `vs/workbench/contrib/chat` |
| Composer stack, grid layout, suggestions, empty state | Backboard (`sessions/contrib/chat`) |
| Workspace / session-type / permission / mode pickers | Backboard delegates |
| Colors, sessions-window CSS | Backboard (`sessions/**/media`) |
| Chat view lifecycle (factory, AbstractChatView, parts grid) | Backboard (`sessions/browser/parts`) |
