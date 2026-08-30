# How the Chat UI Is Generated

The chat UI is a hybrid: **Microsoft's upstream chat widget** (`vs/workbench/contrib/chat`) does the
message list, markdown, input editor, and tool parts; **Backboard's sessions layer** wraps it in its
own grid-leaf abstraction, factory, composers, pickers, and CSS.

## Rendering pipeline (data model → DOM)

```
                    SESSIONS WINDOW  (src/vs/sessions — Backboard-owned)
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │ IChatViewFactory  (services/chatView/browser/chatViewFactory.ts:9 — interface)      │
 │   impl ChatViewFactory  (contrib/chat/browser/chatView.ts:277)                      │
 │     createNewChatView() → NewChatView (:34)   createChatView() → ChatView (:104)    │
 │             │ createInstance                                                         │
 │             ▼                                                                        │
 │ AbstractChatView  (browser/parts/chatView.ts:47) — ISerializableView, one grid leaf │
 │   element = $('.chat-view');  kind: 'newSession'|'newChatInSession'|'chat' (:21)     │
 │   showProgressWhile() → ScopedProgressIndicator + ProgressBar (:136)                 │
 │             │ render(element)                                                        │
 │             ▼                                                                        │
 │ NewChatWidget  (contrib/chat/browser/newChatWidget.ts:52)                           │
 │   .sessions-chat-widget                                                              │
 │    └ .new-chat-widget-container   (container-type: size)                             │
 │       └ .new-chat-widget-content  (CSS grid, 5 rows)                                 │
 │          ├ .new-chat-middle-toolbar / .new-chat-middle-section  (welcome, "What      │
 │          │   should Backboard do?")                                                  │
 │          └ .new-chat-composer-stack                                                  │
 │             ├ .new-chat-composer-workspace-row  (workspace picker + git chip)        │
 │             ├ ►► this._widget.render(...)  ◄◄  UPSTREAM ChatWidget                    │
 │             └ .new-chat-middle-suggestions  ("Build a feature"/"Fix a bug"/"Polish") │
 └───────────────────────────────────────────┬─────────────────────────────────────────┘
                                              │ createInstance(ChatWidget, …)
              UPSTREAM  (src/vs/workbench/contrib/chat — mostly Microsoft)
 ┌────────────────────────────────────────────▼─────────────────────────────────────────┐
 │ ChatWidget  (browser/widget/chatWidget.ts:210)                                         │
 │   createInput() → ChatInputPart (.interactive-input-part)             :270            │
 │   createList()  → ChatListWidget → ChatListRenderer rows (.interactive-list) :756,1558│
 │   renderFollowups() → input.renderFollowups()                        :1257            │
 │   onDidChangeItems() central re-render, driven by autorun(...) on viewModel obs :1006 │
 │   setModel(chatModel) ← IChatService.acquireOrLoadSession(...)                        │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

## How Backboard instantiates the upstream widget

`newChatWidget.ts:119-147` — the widget is created under a **scoped** context-key + child
instantiation service (`:115-118`), fully customized through options + delegates + theme tokens
(verbatim):

```ts
this._widget = this._register(scopedInstantiationService.createInstance(
    ChatWidget,
    ChatAgentLocation.Chat,
    undefined,
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
        workspacePickerDelegate: this._createWorkspacePickerDelegate(),
        sessionTypePickerDelegate: this._createSessionTypePickerDelegate(),
        submitHandler: async query => this._sendFromSharedComposer(query),
    },
    {
        listForeground: activeSessionViewForeground,     // Backboard theme tokens
        listBackground: activeSessionViewBackground,
        overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
        inputEditorBackground: activeSessionViewBackground,
        resultEditorBackground: agentsPanelBackground,
    }
));
```

The active-session `ChatView` (`chatView.ts:142-160`) uses `supportsChangingModes: true`, **no**
`isSessionsWindow`, and no delegates/submitHandler — that's the distinction between the new-session
composer and an active chat. Color tokens (`activeSessionViewForeground/Background`,
`agentsPanelBackground`) are Backboard-owned (`sessions/common/theme.ts`); `ChatAgentLocation`,
`ChatModeKind`, `EDITOR_DRAG_AND_DROP_BACKGROUND` are upstream.

## Layout grid & container queries

`src/vs/sessions/contrib/chat/browser/media/chatWidget.css`:

```
.new-chat-widget-content
grid-template-rows: 52px  minmax(56px,1fr)  auto  auto  minmax(56px,1fr)   (:81)
                    ─────  ──────────────  ────  ────  ──────────────
 row 1  52px   header band
 row 2  ≥56px  flexible space above
 row 3  auto   middle section (title / description)          (grid-row: 3, :184)
 row 4  auto   .new-chat-composer-stack (centered)           (grid-row: 4, :144)
 row 5  ≥56px  flexible space below / chat output
```

`.new-chat-widget-container` declares `container-type: size` (`:30`), enabling `@container` queries:

| Breakpoint | Effect | Line |
|---|---|---|
| `max-width: 620px` | header/composer/middle shrink | :568 |
| `max-width: 430px` | folder-modal compaction | :549 |
| `max-width: 360px` | reduce composer inset | :629 |
| `max-width: 330px` | **icon-only pickers** (hide `.sessions-chat-dropdown-label`; keep permission label) | :832 |
| `max-width: 240px` | drop the permission-picker label too | :858 |

Surrounding sessions-window chrome: `src/vs/sessions/browser/media/style.css` and
`sessionsViewPane.css` (region backgrounds via `--sessions-main-region-background`).

## Streaming updates — observable-driven

There is no manual DOM patching in Backboard code:

- Text deltas append to the response model's markdown; `ChatWidget.onDidChangeItems` (`:1006`)
  re-renders the affected row.
- Tool invocations re-render on `state` / `toolSpecificDataKind` changes (doc 05).
- Executing tools update via `progress: IObservable<{message?, progress?}>`.
- The git-status chip re-renders via an `autorun` on the session's workspace observable
  (`newChatWidget.ts:266-302`): `_updateGitStatus` renders a `.new-chat-git-status-item.branch` chip
  with `Codicon.gitBranch` and the branch name.

### Session-caching quirk (`newChatWidget.ts:104-110`)

The widget freezes on the draft session once a new one commits, so the composer doesn't flicker:

```ts
this._session = derivedObservableWithCache<IActiveSession | undefined>(this, (reader, prev) => {
    const active = this.sessionsService.activeSession.read(reader);
    if (active && active.isCreated.read(reader)) { return prev; }  // committed → keep draft
    return active;
});
```

(Carries a `TODO @sandy081`, `:103`, acknowledging the widget shouldn't read `activeSession`
directly.)

## History loading & session creation

- On load, the workspace picker is synced from the active session **without firing events** —
  `_syncWorkspacePickerFromActiveSession()` (`:351-364`) calls `setSelectedWorkspace(folderUri,
  { fireEvent: false })` so it doesn't accidentally create a duplicate session; returns `true` if a
  session was found.
- Agent-host providers register lazily, so there is **no timeout** — `_scheduleRecreateOnProviderChange()`
  (`:412-436`) listens on `onDidChangeSessionTypes` and recreates the draft when a better/late
  provider can serve the folder, guarding against recreating an already-committed draft.
- Async history loads show an indeterminate progress bar through `AbstractChatView.showProgressWhile()`
  with optional delay to avoid flashes.

## What's Backboard vs upstream

| Piece | Owner | Anchor |
|---|---|---|
| `AbstractChatView` grid leaf + progress bar | **Backboard** | browser/parts/chatView.ts:47,136 |
| `IChatViewFactory` + `ChatViewFactory` | **Backboard** | chatViewFactory.ts:9; contrib/chat/browser/chatView.ts:277 |
| `NewChatView` / `ChatView` wrappers | **Backboard** | contrib/chat/browser/chatView.ts:34,104 |
| `NewChatWidget` DOM shell, welcome, suggestions, workspace row, git chip | **Backboard** | newChatWidget.ts:204-339 |
| Workspace / session-type / permission / mode pickers (delegates) | **Backboard** | newChatWidget.ts:99,112 |
| Composer↔session plumbing (derivedObservableWithCache, recreate-on-provider-change) | **Backboard** | newChatWidget.ts:104,412 |
| Inner `ChatWidget`: input part, list, followups, ChatListRenderer, autorun | **Upstream** | workbench/contrib/chat/browser/widget/chatWidget.ts:210,270,756,1257,1558 |
| Chat model / `IChatService.acquireOrLoadSession` | **Upstream** | chatWidget API |
| `.new-chat-*` CSS + container queries | **Backboard** | contrib/chat/browser/media/chatWidget.css |
| `.interactive-*` classes (overridden via descendant selectors only) | **Upstream** | chatWidget.css:157,635 |
| Theme tokens `activeSessionViewBackground` etc. | **Backboard** | sessions/common/theme.ts |

So Backboard owns the grid-leaf abstraction, the factory, the new-session composer DOM, pickers,
git chip, and all `.new-chat-*` CSS — and instantiates the *unmodified* upstream `ChatWidget`,
feeding it a model via `IChatService.acquireOrLoadSession`. The rendering machinery itself is
upstream.
