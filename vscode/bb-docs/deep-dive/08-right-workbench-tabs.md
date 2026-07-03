# The Right Panel Shell — Auxiliary Bar + Tabs

The "right panel" in the Agents (Simple) window is the **right workbench**: an auxiliary-bar part
that hosts a single view pane, which internally draws a **multi-tab shell** — Review, Terminal,
Browser, Files (plus a Launcher home state). This is 100% Backboard core code with zero imports from
`extensions/copilot`. The chat composer that lives *left* of this panel is documented in
[01](01-right-panel-api-flow.md) and [06](06-chat-ui.md).

```
┌─ Agents window ───────────────────────────────────────────────────────────────┐
│ ┌──────────┬────────────────────────┬──────────────────────────────────────┐  │
│ │ sessions │  chat composer /        │  RIGHT WORKBENCH (auxiliary bar)     │  │
│ │  list    │  active chat            │  ┌────────────────────────────────┐  │  │
│ │(sidebar) │  (SESSIONS_PART)        │  │ [Review][Term][Browser][Files]+│  │  │
│ │          │                         │  │ ──────────────────────────────  │  │  │
│ │          │                         │  │  active mode body:              │  │  │
│ │          │                         │  │   review → reviewTree           │  │  │
│ │          │                         │  │   terminal → ITerminalInstance  │  │  │
│ │          │                         │  │   browser → BrowserEditor       │  │  │
│ │          │                         │  │   files → SessionsExplorerView  │  │  │
│ │          │                         │  └────────────────────────────────┘  │  │
│ └──────────┴────────────────────────┴──────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

## The auxiliary bar part

`src/vs/sessions/browser/parts/auxiliaryBarPart.ts` — `AuxiliaryBarPart extends
AbstractPaneCompositePart` (`:45`), a simplified sessions-window auxiliary bar. Storage keys at
`:47-50` (`workbench.agentsession.auxiliarybar.*`). It hosts view containers registered at
`ViewContainerLocation.AuxiliaryBar` — it is the shell chrome; the tab UI lives in the view pane
below.

## Registration

`src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.contribution.ts`:

- View **container** `SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID` at
  `ViewContainerLocation.AuxiliaryBar`, `isDefault:true`, `windowEnablement:
  WindowEnablement.Sessions` (`:23-32`).
- **Exactly one view**, `SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID` → `RightWorkbenchViewPane`
  (`:34-42`), `canToggleVisibility:false`, `canMoveView:false`. **The tabs are drawn inside this one
  pane, not as separate VS Code views.**
- **Open commands** (`:58-128`) — one `Action2` per mode: `OpenLauncherMode`, `OpenReview`,
  `OpenFiles`, `OpenBrowser` (accepts a URL/options object, `:109`), `OpenTerminal`. All route
  through `openRightWorkbenchMode` (`:44-56`), which sets `pendingModeRequest`, forces the auxiliary
  bar visible + hides editor/panel, opens the view, and fires `onDidRequestModeEmitter`.

## Mode / tab model

`src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.ts`:

```ts
export type RightWorkbenchMode = 'launcher' | 'review' | 'browser' | 'files' | 'terminal';   // :21
export const orderedTabModes = ['review', 'browser', 'files', 'terminal'];                    // :23
export interface IRightWorkbenchModeRequest { mode; browserUrl?; browserViewId?; }            // :25
```

`'launcher'` is the empty/home state, **not** a tab. Cross-component signalling is via the
module-level `onDidRequestModeEmitter` (`:38`) + `pendingModeRequest` (`:39`).

## The view pane that renders the tabs

`src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbenchViewPane.ts` —
`RightWorkbenchViewPane extends ViewPane` (`:91`). Tabs are **internal DOM state**
(`IRightWorkbenchTabState`, `:77-86` — each carries its own `mode`, plus optional
`terminalInstance` / `browserUrl` / `browserViewId` / `browserInput` / `selectedFile`), not VS Code
views. Multiple tabs of the same mode can coexist (e.g. two terminals).

- `renderBody` (`:198`) builds `.sessions-right-workbench-shell`, subscribes to
  `onDidRequestModeEmitter` (`:166`) → `openMode`.
- `renderShell` (`:354`): if `activeMode === 'launcher'` → `renderLauncher` (`:382`); otherwise
  `renderModeHeader` (tab bar) + a body switch (`:389-402`): `review→renderReview`,
  `browser→renderBrowser`, `files→renderFiles`, `terminal→renderTerminal`.
- Tab bar: `renderModeHeader` (`:405`) / `renderTab` (`:434`) — each tab shows its mode icon +
  instance label + close button; a `+` button opens the mode picker.
- `activateSingleSurface` (`:251`) keeps editor/panel hidden so the auxiliary bar is the single
  surface.

### The tab catalogue — `getModeEntries()` (`:607-614`, verbatim)

```ts
return [
    { mode: 'review',   icon: Codicon.diffMultiple, label: "Review",   shortcut: '' },
    { mode: 'terminal', icon: Codicon.terminal,     label: "Terminal", shortcut: '' },
    { mode: 'browser',  icon: Codicon.globe,        label: "Browser",  shortcut: '' },
    { mode: 'files',    icon: Codicon.files,        label: "Files",    shortcut: '' },
];
```

(`getModeIcon` `:616` uses `Codicon.file` for the `files` *tab* vs `Codicon.files` in the launcher
row; `getTabLabel` `:631` — `browser`→"New tab", `files`→"Open file".)

## What each mode embeds

Each mode's content is rendered by a dedicated method that embeds a **real workbench editor/part
inside the auxiliary pane** rather than opening it in the editor area:

| Mode | Renderer | Embeds |
|---|---|---|
| `review` | `renderReview` | `reviewTree.ts` (`IReviewResource` folder tree of session changes — see doc 05) |
| `terminal` | `renderTerminal` | an `ITerminalInstance` via the terminal editor service |
| `browser` | `renderBrowser` | `BrowserEditor` / `BrowserEditorInput` |
| `files` | `renderFiles` | the sessions files explorer `SessionsExplorerView` |

### Review tab detail

`reviewTree.ts`: `IReviewResource` (`:20-28`) = `{ key, sourceUri, status, additions?, deletions?,
open() }`. `buildReviewTreeChildren(resources)` (`:42`) builds a `ResourceTree` and recursively
converts it to `ICompressedTreeElement`. Companions: `ReviewTreeDelegate` (`:67`), `ReviewTreeSorter`
(`:79`), `ReviewTreeRenderer`. The review tab is the right-panel mirror of the Changes view — both
consume `ISessionChangeset` from the agent-host state protocol (doc 05). The commit action is
`github.copilot.sessions.commit`, whose handler lives in the Copilot CLI extension (doc 07).

## Why "tabs are DOM state, not views" matters

Because the tabs are internal state of a single view pane rather than registered VS Code views:

- multiple instances of the same mode can coexist (two terminals, several browser tabs);
- each tab keeps its own live object (`terminalInstance`, `browserInput`) across tab switches;
- the tabs don't appear in the command palette / view registry and can't be dragged out — they're
  bespoke sessions-window chrome, not part of the general workbench view system.
