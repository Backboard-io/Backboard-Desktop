# Backboard Secondary Side Bar / Auxiliary Bar Walkthrough

This document walks through the current Backboard implementation of the right-side
container that VS Code calls the **Auxiliary Bar** and exposes in UI as the
**Secondary Side Bar**.

The codebase has two related implementations:

- The normal workbench auxiliary bar used by the standard editor workbench.
- The Backboard Agents Window auxiliary bar under `src/vs/sessions`, which is
  the right-side details pane for agent sessions.

Most Backboard-specific behavior lives in the second implementation. The Agents
Window keeps the same VS Code concepts, service contracts, and view-container
registries, but replaces the layout shell, part service, default view containers,
storage keys, sizing rules, and some title/action behavior.

## Quick Mental Model

In VS Code vocabulary:

- **Part**: a top-level workbench region such as editor, sidebar, panel, or
  auxiliary bar.
- **Auxiliary Bar**: the `Parts.AUXILIARYBAR_PART` region.
- **Secondary Side Bar**: user-facing label for the auxiliary bar.
- **View container**: a group such as Chat, Changes, Files, or Browser.
- **View**: the actual pane inside the container.
- **Pane composite**: the runtime object for a contributed view container.

In Backboard's Agents Window:

```text
root grid, vertical
|-- titlebar
`-- content, horizontal
    |-- sidebar
    `-- right section, vertical
        |-- top row, horizontal
        |   |-- sessions part
        |   |-- auxiliary bar
        |   `-- editor part
        `-- panel
```

The auxiliary bar is the right-side detail rail in the top row. It usually hosts
Changes, Files, or Browser for the active agent session.

## Source Map

Primary Backboard sessions files:

| Area | File |
| --- | --- |
| Agents Window shell and layout service | `src/vs/sessions/browser/workbench.ts` |
| Desktop auxiliary bar part | `src/vs/sessions/browser/parts/auxiliaryBarPart.ts` |
| Mobile auxiliary bar part | `src/vs/sessions/browser/parts/mobile/mobileAuxiliaryBarPart.ts` |
| Pane composite part service replacement | `src/vs/sessions/browser/paneCompositePartService.ts` |
| Layout defaults / phone classification | `src/vs/sessions/browser/layoutPolicy.ts` |
| Toggle actions | `src/vs/sessions/browser/layoutActions.ts` |
| Sessions menu IDs | `src/vs/sessions/browser/menus.ts` |
| Shared sessions CSS | `src/vs/sessions/browser/media/style.css` |
| Auxiliary bar CSS | `src/vs/sessions/browser/parts/media/auxiliaryBarPart.css` |
| Per-session layout state | `src/vs/sessions/contrib/layout/browser/sessionLayoutController.ts` |
| Changes container registration | `src/vs/sessions/contrib/changes/browser/changes.contribution.ts` |
| Changes titlebar actions | `src/vs/sessions/contrib/changes/browser/changesTitleBarWidget.ts` |
| Files container registration | `src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| Files view implementation | `src/vs/sessions/contrib/files/browser/filesView.ts` |
| Browser container registration | `src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` |
| Browser view implementation | `src/vs/sessions/contrib/browserView/browser/sessionBrowserPanel.ts` |
| Editor/right-panel coupling actions | `src/vs/sessions/contrib/editor/browser/editor.contribution.ts` |
| Sessions entrypoint imports | `src/vs/sessions/sessions.common.main.ts` |

Shared VS Code workbench files that Backboard reuses or mirrors:

| Area | File |
| --- | --- |
| Standard auxiliary bar part | `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` |
| Standard auxiliary bar actions | `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarActions.ts` |
| Part IDs and layout service API | `src/vs/workbench/services/layout/browser/layoutService.ts` |
| Context keys | `src/vs/workbench/common/contextkeys.ts` |
| Chat registered into auxiliary bar | `src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts` |
| Chat view location classes/context | `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts` |

## Shared Workbench Baseline

The normal VS Code auxiliary bar is implemented by
`src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts`.

Important baseline behavior:

- It extends `AbstractPaneCompositePart`.
- It registers itself as `Parts.AUXILIARYBAR_PART`.
- It binds `ActiveAuxiliaryContext` and `AuxiliaryBarFocusContext`.
- It uses `ViewContainerLocation.AuxiliaryBar`.
- It uses the shared pane composite registry ID `Extensions.Auxiliary`.
- Its title menu is `MenuId.AuxiliaryBarTitle`.
- It persists active/pinned/placeholder/workspace-state data under
  `workbench.auxiliarybar.*` keys.
- It has a `minimumWidth` of `170`.
- Its preferred width is the active composite's optimal width, clamped to at
  least `300`.
- It participates in user settings such as `workbench.secondarySideBar.showLabels`
  and `workbench.activityBar.location`.
- It supports extra context menu actions such as moving the secondary side bar
  left/right, toggling labels, and hiding it.
- It has standard actions such as `workbench.action.toggleAuxiliaryBar`,
  `workbench.action.focusAuxiliaryBar`, previous/next auxiliary bar view, and
  maximize/restore.

The shared part is generic. It does not know about Backboard sessions, Changes,
Files, Browser, or per-session layout state.

## Backboard Agents Window Difference

The Backboard Agents Window does not reuse the normal workbench shell. It defines
its own `Workbench` class in `src/vs/sessions/browser/workbench.ts`.

That class implements `IAgentWorkbenchLayoutService`, which refines the normal
`IWorkbenchLayoutService`. It owns:

- The actual `SerializableGrid`.
- The visibility state for sidebar, auxiliary bar, editor, panel, and sessions.
- The persisted workspace-level part visibility key
  `workbench.sessions.partVisibility`.
- The persisted workspace-level part size key `workbench.sessions.partSizes`.
- Special editor maximization behavior.
- Mobile/phone visibility transitions.

The Agents Window still uses the normal `Parts.AUXILIARYBAR_PART` enum value:

```ts
Parts.AUXILIARYBAR_PART === 'workbench.parts.auxiliarybar'
```

That compatibility is important. Existing services, context keys, actions, and
view container registries can still target `ViewContainerLocation.AuxiliaryBar`
and `Parts.AUXILIARYBAR_PART`.

## Part Construction

### Service Replacement

Backboard replaces the normal pane composite part service with
`AgenticPaneCompositePartService` in
`src/vs/sessions/browser/paneCompositePartService.ts`.

That service implements the normal `IPaneCompositePartService` interface. At
construction time it creates and stores one part per pane-composite location:

- `ViewContainerLocation.Panel` -> `PanelPart` or `MobilePanelPart`
- `ViewContainerLocation.Sidebar` -> `SidebarPart` or `MobileSidebarPart`
- `ViewContainerLocation.AuxiliaryBar` -> `AuxiliaryBarPart` or
  `MobileAuxiliaryBarPart`

It decides the mobile subclass from the initial document-body width:

```ts
const { width } = getClientArea(mainWindow.document.body);
const isPhoneLayout = width < 640;
```

It then delegates the usual pane-composite operations to the registered part:

- `openPaneComposite`
- `getActivePaneComposite`
- `getPaneComposite`
- `getPaneComposites`
- `getPinnedPaneCompositeIds`
- `getVisiblePaneCompositeIds`
- `getPaneCompositeIds`
- `getProgressIndicator`
- `hideActivePaneComposite`
- `getLastActivePaneCompositeId`

The service also re-emits `onDidPaneCompositeOpen` and
`onDidPaneCompositeClose` with the corresponding `ViewContainerLocation`.

### Eager Wiring

The sessions entrypoint imports the part service in
`src/vs/sessions/sessions.common.main.ts`:

```ts
import './browser/paneCompositePartService.js';
```

The `Workbench.initLayout()` method then resolves `IPaneCompositePartService`.
That resolution constructs `AgenticPaneCompositePartService`, which constructs
the auxiliary bar part before the grid is built. This matters because
`createWorkbenchLayout()` later asks `getPart(Parts.AUXILIARYBAR_PART)` for a
registered part.

## Backboard AuxiliaryBarPart

The sessions-specific `AuxiliaryBarPart` is in
`src/vs/sessions/browser/parts/auxiliaryBarPart.ts`.

It extends `AbstractPaneCompositePart`, just like the standard workbench part,
but it changes the configuration.

### Storage Keys

Backboard uses sessions-scoped storage keys:

```ts
workbench.agentsession.auxiliarybar.activepanelid
workbench.agentsession.auxiliarybar.pinnedPanels
workbench.agentsession.auxiliarybar.placeholderPanels
workbench.agentsession.auxiliarybar.viewContainersWorkspaceState
```

This keeps the Agents Window right panel separate from the normal VS Code window.
The same user can have a different active/pinned secondary side bar state in the
editor workbench and the agent sessions workbench.

### Constructor Contract

The sessions `AuxiliaryBarPart` calls `super(...)` with:

- `Parts.AUXILIARYBAR_PART`
- title enabled
- trailing separator disabled
- zero border width
- `ActiveAuxiliaryContext`
- `AuxiliaryBarFocusContext`
- CSS class names `auxiliarybar`
- title border color `SIDE_BAR_TITLE_BORDER`
- location `ViewContainerLocation.AuxiliaryBar`
- registry `Extensions.Auxiliary`
- title menu `Menus.AuxiliaryBarTitle`

The title menu is not the shared `MenuId.AuxiliaryBarTitle`. Backboard defines
its own sessions menu ID in `src/vs/sessions/browser/menus.ts`:

```ts
AuxiliaryBarTitle: new MenuId('SessionsAuxiliaryBarTitle')
```

That allows Backboard to contribute title actions without inheriting unrelated
normal workbench title actions.

### Size Rules

Current code:

- `minimumWidth`: `120`
- `maximumWidth`: `Infinity`
- `minimumHeight`: `0`
- `maximumHeight`: `Infinity`
- `preferredHeight`: 40 percent of main container height
- `preferredWidth`: active composite optimal width, clamped to at least `220`
- layout priority: `LayoutPriority.Low`

The `snap` getter has special editor coupling:

```ts
return this.hasAttachedEditorRequiringSidebarSpace() ? false : super.snap;
```

`hasAttachedEditorRequiringSidebarSpace()` returns true only when both the
auxiliary bar and editor part are visible. In that state sash snapping is disabled
so resizing cannot collapse the right-side details pane out from under the
attached editor layout.

Maintenance note: `src/vs/sessions/test/browser/auxiliaryBarPart.test.ts`
currently asserts an older `minimumWidth` value of `270`. The implementation is
currently `120`, so the test is stale relative to this source state.

### Accessibility

`create(parent)` sets:

```ts
role="complementary"
aria-label="Session Details"
```

This is Backboard-specific language. The normal workbench labels this area as
the secondary side bar, while the Agents Window frames it as session details.

### Styling

`updateStyles()` stores theme colors as CSS variables on the part container:

- `--part-background`
- `--part-border-color`
- `--part-foreground`

It also sets `backgroundColor` to `agentsPanelBackground` and clears left/right
border styles. The current shared sessions CSS later forces the right-column
parts to be square and flush, so the historical "card" behavior is mostly
overridden in `src/vs/sessions/browser/media/style.css`.

The dedicated auxiliary bar CSS in
`src/vs/sessions/browser/parts/media/auxiliaryBarPart.css` still defines:

- right-side card shape under `.agent-sessions-workbench .part.auxiliarybar`
- title height and padding
- composite bar action label styling
- active checked-state background
- editor background overrides inside the auxiliary content

The broader `style.css` currently applies stronger flush/square-edged rules:

- `.part.auxiliarybar` gets `margin: 0`, `padding-left: 0`, `border: none`,
  `border-radius: 0`, and editor-background colors.
- split-view wrappers around sessions/editor/auxiliary all get top borders.
- editor and auxiliary split-view wrappers get left borders.
- auxiliary title/content/list/tree/scrollable surfaces are forced to the editor
  background and zero radius.

If the UI looks square and integrated rather than card-like, that comes from the
current global sessions stylesheet rather than the older part-specific CSS.

### Composite Bar Options

The sessions auxiliary bar always shows its composite bar:

```ts
protected shouldShowCompositeBar(): boolean {
	return true;
}
```

The composite bar is always in the title:

```ts
protected getCompositeBarPosition(): CompositeBarPosition {
	return CompositeBarPosition.TITLE;
}
```

Its options differ from the shared workbench part:

- `partContainerClass: 'auxiliarybar'`
- sessions-scoped storage keys
- `icon: false`, so labels are shown rather than icon-only mode
- horizontal action orientation
- `compositeSize: 0`
- `iconSize: 16`
- compact mode enabled
- Backboard agent panel colors and badge colors

Unlike the normal workbench auxiliary bar, the sessions part does not expose a
rich context menu for moving the bar or toggling labels. Its
`fillExtraContextMenuActions` is intentionally empty.

### Run Script Dropdown Special Case

`AuxiliaryBarPart.actionViewItemProvider()` intercepts the action ID:

```ts
workbench.action.agentSessions.runScript
```

When that action appears as a menu item, it is rendered as a
`DropdownWithPrimaryActionViewItem`. The dropdown contents are read from:

```ts
MenuId.for('AgentSessionsRunScriptDropdown')
```

The part owns a `MutableDisposable` for the dropdown view item, the menu, and the
menu change listener. On menu changes it recalculates the flattened dropdown
actions via `getFlatContextMenuActions(...)`.

This is a local rendering customization: the Run Script action is defined
elsewhere, but the auxiliary bar knows how to present it as a split/dropdown
button when it lands in the right-panel title area.

### Layout Method

The sessions auxiliary bar overrides `layout(width, height, top, left)`.

The method returns early if the auxiliary bar is not visible. Otherwise it checks
whether the editor part is visible, computes margins/padding, and calls
`super.layout(...)` with reduced content dimensions.

After that it calls:

```ts
Part.prototype.layout.call(this, width, height, top, left);
```

That restores the full grid-allocated dimensions on the `Part` base class. The
comment explains why: `Part.relayout()` needs the full dimensions, even though
the pane-composite content layout may subtract margins/borders.

Current margins are all zero:

```ts
MARGIN_TOP = 0
MARGIN_BOTTOM = 0
MARGIN_LEFT = 0
```

So the code path is mostly preserving the old shape of the layout method while
the CSS and constants have moved to a flush layout.

### Reacting to Editor Visibility

The constructor listens to `layoutService.onDidChangePartVisibility`.

If the auxiliary bar or editor visibility changes, it fires its own change event.
If the editor part visibility changes and cached dimensions exist, the part
relayouts itself immediately using the last known grid allocation.

This matters because the auxiliary bar's internal content dimensions depend on
whether the adjacent editor is visible. Without the immediate relayout, the
inner pane body can be stale until the next full grid layout pass.

## Mobile Auxiliary Bar

`MobileAuxiliaryBarPart` extends the desktop sessions `AuxiliaryBarPart`.

On non-phone layouts it delegates back to the desktop implementation.

On phone layouts:

- `updateStyles()` first runs the desktop implementation, then clears inline
  background/card CSS variables so phone CSS can own the appearance.
- `layout()` returns early if hidden.
- `layout()` calls `AbstractPaneCompositePart.prototype.layout.call(...)`
  directly with the full dimensions.

This mobile class avoids card margins and border subtraction. The part fills its
grid cell on phone.

The layout policy currently hides the auxiliary bar by default on phone:

```ts
phone -> { sidebar: false, auxiliaryBar: false, panel: false, sessions: true, editor: false }
```

So mobile support exists at the part level, but normal phone startup does not
show the auxiliary bar.

## Workbench Grid Placement

The Agents Window grid is built in `Workbench.createDesktopGridDescriptor()`.

The top-right row is currently:

```ts
data: [sessionsNode, auxiliaryBarNode, editorNode]
```

This is important: in current code, the auxiliary bar sits between the sessions
part and the editor part. The file comments still describe some older wording
like "Chat Bar | Right workbench" and "Changes/Files/Browser | Editor", but the
actual serialized node order is sessions, auxiliary, editor.

The descriptor computes:

- titlebar height
- sidebar width
- right section width
- a `rightWorkColumnWidth`
- sessions width
- auxiliary bar width
- editor width
- panel height

### Defaults

`SessionsLayoutPolicy.getPartVisibilityDefaults()` currently returns:

```ts
phone:
  sidebar: false
  auxiliaryBar: false
  panel: false
  sessions: true
  editor: false

tablet/desktop:
  sidebar: true
  auxiliaryBar: true
  panel: false
  sessions: true
  editor: true
```

That is the current code. Some prose in `src/vs/sessions/LAYOUT.md` says the
editor starts hidden by default. Treat the code as the current truth unless that
spec is updated.

Initial desktop sizes from the policy:

```ts
sideBarSize: 300
auxiliaryBarSize: 340
panelSize: 300
sessionsWidth: width - 300
```

The grid builder then clamps the auxiliary bar further when the editor is also
visible:

- minimum auxiliary width: roughly 22 percent of the right work column, clamped
  between 120 and 180
- maximum auxiliary width: roughly 32 percent of the right work column, capped at
  260
- default auxiliary width: roughly 24 percent of the right work column

If the editor is not visible, the auxiliary bar takes the whole right work
column.

### Persisted Part Sizes

Part sizes are saved in workspace storage under:

```ts
workbench.sessions.partSizes
```

The saved shape is:

```ts
{
	"sidebar": number,
	"auxiliaryBar": number,
	"sessions": number,
	"editor": number,
	"panel": number
}
```

For visible parts, the workbench reads the live grid size. For hidden parts, it
uses the grid cached visible size, so toggling a hidden part back on can restore
the previous dimension.

## Visibility State

The sessions `Workbench` owns visibility in a local `partVisibility` object:

```ts
{
	sidebar: true,
	auxiliaryBar: true,
	editor: false,
	panel: false,
	sessions: true
}
```

Those initializer values are then overwritten during render/init from
`SessionsLayoutPolicy` defaults and stored workspace state.

Only a subset of visibility is persisted globally:

```ts
workbench.sessions.partVisibility
```

It stores:

```ts
{
	"editor": boolean,
	"auxiliaryBar": boolean,
	"sidebar": boolean
}
```

Phone layout skips loading/saving this state.

### `isVisible`

`Workbench.isVisible(part)` returns from `partVisibility` for:

- sidebar
- auxiliary bar
- editor
- panel
- sessions

It always returns false for unsupported parts such as activity bar, status bar,
and banner. Titlebar is considered visible except in phone layout.

### `setPartHidden`

`Workbench.setPartHidden(hidden, part)` dispatches to:

- `setSideBarHidden`
- `setAuxiliaryBarHidden`
- `setEditorHidden`
- `setPanelHidden`
- `setSessionsHidden`

The auxiliary bar path is the interesting one.

## Hiding and Showing the Auxiliary Bar

`setAuxiliaryBarHidden(hidden)` in `workbench.ts` is the main source of truth.

When hiding:

1. It clears `_restoreAttachedEditorMaximizedOnShow`.
2. It records whether the editor was visible in `_restoreEditorOnAuxiliaryBarShow`.
3. If the editor is visible, it hides the editor first.
4. It updates `partVisibility.auxiliaryBar`.
5. It toggles the `.noauxiliarybar` class on the workbench root.
6. It calls `workbenchGrid.setViewVisible(auxiliaryBarPartView, false)`.
7. It hides the active auxiliary pane composite if one is open.
8. It saves global part visibility.

When showing:

1. It updates `partVisibility.auxiliaryBar`.
2. It clears `.noauxiliarybar`.
3. It calls `workbenchGrid.setViewVisible(auxiliaryBarPartView, true)`.
4. If no active auxiliary composite exists, it reopens the last active
   auxiliary pane composite, or the default auxiliary container.
5. It may restore the editor part. The condition is:
   `_restoreEditorOnAuxiliaryBarShow || layoutPolicy.getPartVisibilityDefaults().editor`.
6. It saves global part visibility.

This is stronger coupling than the standard workbench has. In Backboard's
sessions layout, the auxiliary bar and attached editor are treated as a right
work area. Hiding the secondary side bar can also remove the attached editor,
and showing it can bring the editor back.

## Toggle Actions

### Sessions Toggle Action

`src/vs/sessions/browser/layoutActions.ts` registers:

```ts
workbench.action.agentToggleSecondarySidebarVisibility
```

User-facing title:

```text
Toggle Secondary Side Bar Visibility
```

The action:

1. Checks `layoutService.isVisible(Parts.AUXILIARYBAR_PART)`.
2. If currently visible and the editor is visible, hides the editor first.
3. Calls `layoutService.setPartHidden(isCurrentlyVisible, Parts.AUXILIARYBAR_PART)`.
4. Announces the result to screen readers.

The comment notes that hide/show order matters for dimension restoration.

### Changes Titlebar Toggle

`src/vs/sessions/contrib/changes/browser/changesTitleBarWidget.ts` registers:

```ts
workbench.action.agentSessions.toggleChangesView
workbench.action.agentSessions.openChangesInRightPanel
```

The toggle action appears in `Menus.TitleBarSessionMenu` and flips the whole
auxiliary bar. Its icon changes based on `AuxiliaryBarVisibleContext`.

The open action appears in `Menus.AuxiliaryBarTitle` and opens the Changes view
inside the right panel. If the auxiliary bar is hidden, it shows it first.

### Editor Chevron Actions

`src/vs/sessions/contrib/editor/browser/editor.contribution.ts` registers two
editor title actions:

```ts
workbench.action.agentSessions.pushEditorRight
workbench.action.agentSessions.pullEditorLeft
```

When the auxiliary bar is visible, the editor title shows **Push Editor Right**
with a chevron-right icon. Running it hides the auxiliary bar.

When the auxiliary bar is hidden, the same slot shows **Show Secondary Side Bar**
with a chevron-left icon. Running it shows the auxiliary bar.

The gating conditions require:

- sessions window
- not auxiliary window
- top-right editor group
- current `AuxiliaryBarVisibleContext` or its negation

## Context Keys

Backboard reuses the normal workbench auxiliary context keys from
`src/vs/workbench/common/contextkeys.ts`:

```ts
activeAuxiliary
auxiliaryBarFocus
auxiliaryBarVisible
auxiliaryBarMaximized
```

The sessions auxiliary bar binds:

- `ActiveAuxiliaryContext`
- `AuxiliaryBarFocusContext`

Visibility context is managed through the broader workbench context-key handling,
as with normal parts.

Backboard-specific actions also use:

- `IsSessionsWindowContext`
- `IsAuxiliaryWindowContext`
- `SessionsWelcomeVisibleContext`
- `IsPhoneLayoutContext`
- `EditorMaximizedContext`
- `IsTopRightEditorGroupContext`

## View Containers in the Backboard Right Panel

Backboard sessions currently register three main auxiliary view containers.

### Changes

Container ID:

```ts
workbench.view.agentSessions.changesContainer
```

View ID:

```ts
workbench.view.agentSessions.changes
```

Registered in:

```text
src/vs/sessions/contrib/changes/browser/changes.contribution.ts
```

Properties:

- Location: `ViewContainerLocation.AuxiliaryBar`
- Title: `Changes`
- Icon: `Codicon.gitCompare`
- Order: `10`
- Container class: `ChangesViewPaneContainer`
- View class: `ChangesViewPane`
- Not movable
- Not toggleable
- Hidden on phone via `IsPhoneLayoutContext.negate()`
- Sessions-only via `WindowEnablement.Sessions`

It also registers the setting:

```ts
sessions.changes.openSingleFileDiff
```

That setting controls whether clicking a file in the Changes view opens a single
file diff editor rather than the multi-file diff editor.

### Files

Container ID:

```ts
workbench.sessions.auxiliaryBar.filesContainer
```

View IDs:

```ts
sessions.files.explorer
sessions.files.explorer.empty
```

Registered in:

```text
src/vs/sessions/contrib/files/browser/files.contribution.ts
```

Properties:

- Location: `ViewContainerLocation.AuxiliaryBar`
- Title: `Files`
- Icon: `Codicon.files`
- Order: `11`
- Container class: `ViewPaneContainer`
- `mergeViewWithContainerWhenSingleView: true`
- Marked as default for the sessions auxiliary bar
- Sessions-only via `WindowEnablement.Sessions`

The concrete view subclasses the normal workbench `ExplorerView` as
`SessionsExplorerView`. It changes:

- primary action groups to `['1_files']`
- view/list background to `agentsPanelBackground`
- rendering for `sessions.files.action.syncChanges`

The empty view appears when there are zero workspace folders and says:

```text
Folders and files will appear here.
```

The real Files view is hidden on phone and requires at least one workspace
folder.

### Browser

Container ID:

```ts
workbench.sessions.auxiliaryBar.browserContainer
```

View ID:

```ts
sessions.browser.view
```

Registered in:

```text
src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

Properties:

- Location: `ViewContainerLocation.AuxiliaryBar`
- Title: `Browser`
- Icon: `Codicon.globe`
- Order: `12`
- Container class: `ViewPaneContainer`
- `mergeViewWithContainerWhenSingleView: true`
- Not movable
- Not toggleable
- Hidden on phone via `IsPhoneLayoutContext.negate()`
- Sessions-only via `WindowEnablement.Sessions`

The implementation in `sessionBrowserPanel.ts` provides:

- a URL input
- quick buttons for `:3000`, `:5173`, `:8000`, and `:8080`
- URL normalization for full URLs, localhost hosts, and bare ports
- opening a `BrowserEditorInput` through `IEditorService`
- a list of contextual browser editors from `IBrowserViewWorkbenchService`

This means the auxiliary bar is not itself the browser surface. It is the control
and index surface for browser editor inputs.

## How the Default Active Right-Panel View Is Chosen

There are two layers of defaulting:

1. View-container registration says Files is the default auxiliary container.
2. `LayoutController` chooses Files or Changes based on session state.

The Files contribution passes `{ isDefault: true }` when registering the files
container in `ViewContainerLocation.AuxiliaryBar`.

On workbench restore, `Workbench.restoreParts()` opens the default view container
for every visible location. For the auxiliary bar, that means the default Files
container can open during initial restore.

After session state is available, `LayoutController._syncAuxiliaryBarVisibility`
applies session-aware logic:

- If there is no session resource or no workspace, do nothing.
- If the session is untitled, open Files.
- If saved state exists and says the auxiliary bar was hidden, hide it.
- If saved state exists with an active container ID, open that container.
- If the active session has changes, open Changes.
- Otherwise open Files.

That is the main answer to "why am I seeing Files vs Changes?"

## Per-Session Right-Panel State

`LayoutController` persists per-session view state under:

```ts
sessions.layoutState
```

The relevant shape is:

```ts
{
	sessionResource: string,
	viewState?: {
		auxiliaryBarVisible: boolean,
		auxiliaryBarActiveViewContainerId: string | undefined
	},
	editorWorkingSet?: IEditorWorkingSet
}
```

The controller captures state when switching away from a session:

- whether `Parts.AUXILIARYBAR_PART` is visible
- active auxiliary view container ID from
  `IPaneCompositePartService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)`

It captures current state again on storage save for the active session, unless
multiple sessions are visible.

### Multiple Visible Sessions

When more than one session is visible, the controller deletes per-session
auxiliary and panel state for visible sessions and does not sync right-panel
visibility from active-session changes.

Reason: with multiple sessions side by side, there is one shared right panel.
Applying per-session show/hide on focus changes would make the layout jump while
the user moves between visible sessions.

Editor working sets are preserved separately.

### Auto-Reveal on New Changes

The layout controller listens for chat request submissions and active session
change state.

On submit, it records:

- whether the active session already had changes
- submission timestamp

When the turn completes, if the session had no changes before and now has
changes, it calls:

```ts
layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART)
```

It also deletes saved view state for that session so the auxiliary bar remains
visible on the next switch.

This auto-reveal is skipped on mobile web.

## Relationship With Editor Working Sets

The current sessions layout can have both an auxiliary bar and an attached editor
in the right work area.

Several code paths coordinate them:

- `Workbench.onWillOpenEditor`: if an editor opens into a main editor group, the
  auxiliary bar is shown first if hidden, then the editor is shown.
- `setAuxiliaryBarHidden(true)`: hides the editor first if visible.
- `setAuxiliaryBarHidden(false)`: may restore the editor if it was previously
  visible or if desktop defaults say the editor should be visible.
- `_applyEditorSplitSize()`: the first time the editor is revealed, sizes the
  auxiliary bar to about 24 percent of the right work column and gives the rest
  to the editor.
- `LayoutController._applyWorkingSet()`: when modal-only editor mode is off and
  a saved working set exists, reveals the editor part before applying the working
  set.

The right panel is therefore not just a passive side bar. It is part of a
two-surface right workspace with the editor.

## Maximization

The normal workbench auxiliary bar supports maximize/restore actions through
`workbench.action.maximizeAuxiliaryBar` and
`workbench.action.restoreAuxiliaryBar`.

The sessions workbench explicitly does not support auxiliary bar maximization:

```ts
toggleMaximizedAuxiliaryBar(): void {
	// No-op
}

setAuxiliaryBarMaximized(_maximized: boolean): boolean {
	return false;
}

isAuxiliaryBarMaximized(): boolean {
	return false;
}
```

This is in `src/vs/sessions/browser/workbench.ts`.

There is editor maximization support, but that is separate. Maximizing the editor
hides sidebar and sessions parts while ensuring the editor is visible. It does
not maximize the auxiliary bar.

## Focus

`Workbench.focusPart(Parts.AUXILIARYBAR_PART)` focuses the active pane composite
at `ViewContainerLocation.AuxiliaryBar`.

The `AgenticPaneCompositePartService` also exposes the active pane composite so
other code can open/focus/hide view containers without knowing the concrete part
class.

## Empty State / Active Auxiliary Mode Classes

`Workbench.registerAuxiliaryEmptyStateListeners()` watches
`IPaneCompositePartService.onDidPaneCompositeOpen` and
`onDidPaneCompositeClose` for the auxiliary bar location.

It toggles root classes:

```ts
sessions-auxiliary-files-active
sessions-auxiliary-browser-active
```

The active container IDs it checks are:

```ts
workbench.sessions.auxiliaryBar.filesContainer
workbench.sessions.auxiliaryBar.browserContainer
```

These classes let CSS or other UI react to which right-panel mode is currently
active.

## Normal Editor Workbench Chat in the Auxiliary Bar

Backboard also modifies the standard workbench chat registration.

In `src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts`, the
Chat view container is registered into:

```ts
ViewContainerLocation.AuxiliaryBar
```

with:

```ts
{ isDefault: true, doNotRegisterOpenCommand: true }
```

The chat icon is `backboard_icon.svg`, and the title is `Chat`.

This is separate from the Agents Window auxiliary bar. It means the normal
editor workbench can default Chat into the secondary side bar. In the Agents
Window, the session chat itself is primarily rendered inside the central
`SessionsPart`, while the auxiliary bar is used for details like Changes, Files,
and Browser.

`ChatViewPane` still assumes AuxiliaryBar as its fallback location when it cannot
resolve a view location. It sets context/classes such as:

- `chat-view-location-auxiliarybar`
- `chat-view-location-sidebar`
- `chat-view-location-panel`
- `chat-view-position-left`
- `chat-view-position-right`

Those classes explain some chat CSS that is scoped by location even though the
Agents Window has its own central chat surface.

## Startup Sequence

At a high level:

1. `SessionsBrowserMain` or desktop sessions main creates
   `src/vs/sessions/browser/workbench.ts` instead of the normal workbench.
2. `Workbench.startup()` initializes services.
3. `initLayout()` resolves `IPaneCompositePartService`, causing
   `AgenticPaneCompositePartService` to create the sessions auxiliary bar part.
4. `renderWorkbench()` creates DOM containers for titlebar, sidebar, auxiliary
   bar, panel, editor, and sessions.
5. `createWorkbenchLayout()` builds the `SerializableGrid`.
6. `restoreParts()` opens default view containers for visible sidebar, panel, and
   auxiliary bar locations.
7. `sessionsService.restoreVisibleSessions()` restores session views.
8. `LayoutController` observes active session state and opens Files or Changes
   according to saved state and changes state.

## Commands and IDs Cheat Sheet

Part ID:

```ts
workbench.parts.auxiliarybar
```

Location:

```ts
ViewContainerLocation.AuxiliaryBar
```

Standard workbench toggle:

```ts
workbench.action.toggleAuxiliaryBar
```

Sessions toggle:

```ts
workbench.action.agentToggleSecondarySidebarVisibility
```

Sessions Changes toggle/open:

```ts
workbench.action.agentSessions.toggleChangesView
workbench.action.agentSessions.openChangesInRightPanel
```

Editor chevrons:

```ts
workbench.action.agentSessions.pushEditorRight
workbench.action.agentSessions.pullEditorLeft
```

View containers:

```ts
workbench.view.agentSessions.changesContainer
workbench.sessions.auxiliaryBar.filesContainer
workbench.sessions.auxiliaryBar.browserContainer
```

Views:

```ts
workbench.view.agentSessions.changes
sessions.files.explorer
sessions.files.explorer.empty
sessions.browser.view
```

Global sessions visibility storage:

```ts
workbench.sessions.partVisibility
```

Global sessions part sizes storage:

```ts
workbench.sessions.partSizes
```

Per-session layout storage:

```ts
sessions.layoutState
```

Auxiliary bar pane-composite storage:

```ts
workbench.agentsession.auxiliarybar.activepanelid
workbench.agentsession.auxiliarybar.pinnedPanels
workbench.agentsession.auxiliarybar.placeholderPanels
workbench.agentsession.auxiliarybar.viewContainersWorkspaceState
```

## Common Flows

### Opening the Agents Window

1. The sessions workbench starts.
2. Desktop defaults make sidebar, sessions, auxiliary bar, and currently editor
   visible unless saved state changes that.
3. The auxiliary bar grid node is created visible.
4. `restoreParts()` opens the default auxiliary container. Files is registered as
   default.
5. When active session state arrives, `LayoutController` can switch the active
   auxiliary container to Changes if the session has changes.

### User Hides the Secondary Side Bar

1. A toggle action calls `setPartHidden(true, Parts.AUXILIARYBAR_PART)`.
2. If editor is visible, `setAuxiliaryBarHidden(true)` hides editor first.
3. The auxiliary grid view is hidden.
4. The active auxiliary pane composite is hidden.
5. `.noauxiliarybar` is added to the root.
6. Global sessions part visibility is stored.
7. On the next storage save or session switch, per-session state may capture
   `auxiliaryBarVisible: false`.

### User Shows the Secondary Side Bar

1. A toggle action calls `setPartHidden(false, Parts.AUXILIARYBAR_PART)`.
2. The auxiliary grid view is shown.
3. Last active auxiliary container, or default container, is opened.
4. The editor may be restored.
5. `.noauxiliarybar` is removed.
6. Global sessions part visibility is stored.

### User Switches Sessions

1. `LayoutController` sees active session resource change.
2. It captures the outgoing session's auxiliary visibility and active container.
3. If multiple sessions are visible, it skips per-session sync.
4. Otherwise it applies saved incoming state if present.
5. If no saved state, it opens Changes when the session has changes and Files
   otherwise.

### Agent Produces First Changes

1. On chat submit, `LayoutController` records whether the session already had
   changes.
2. When the turn completes, it checks whether changes are now present.
3. If this is the transition from no changes to changes, it reveals the auxiliary
   bar.
4. It deletes saved right-panel state for that session so future switches do not
   immediately hide it again.

## Current Implementation Notes

- The sessions auxiliary bar is a Backboard-specific subclass, not the normal
  workbench auxiliary bar.
- The sessions right panel is backed by the normal VS Code view-container and
  pane-composite infrastructure.
- The part ID and view location are standard, which keeps shared services usable.
- The title menu is sessions-specific: `Menus.AuxiliaryBarTitle`.
- Files is registered as the default sessions auxiliary container.
- Changes can override the default based on active session changes.
- Browser is another auxiliary container, but browser pages open as editor inputs.
- Phone layout hides the auxiliary bar by default and gates the desktop views.
- Auxiliary bar maximization is deliberately a no-op in the sessions workbench.
- Editor maximization is supported and separate.
- The auxiliary bar and editor are coupled in the current sessions layout.
- Current code defaults desktop/tablet editor visibility to true when auxiliary
  bar visibility is true; some older layout docs still say editor hidden.
- Current code sets auxiliary minimum width to `120`; the existing test still
  expects `270`.

## Where to Change What

Use this map when editing behavior:

| Desired change | Start here |
| --- | --- |
| Change right panel default width | `src/vs/sessions/browser/layoutPolicy.ts` and `Workbench.createDesktopGridDescriptor()` |
| Change minimum/optimal width | `src/vs/sessions/browser/parts/auxiliaryBarPart.ts` |
| Change hide/show behavior | `Workbench.setAuxiliaryBarHidden()` |
| Change toggle command behavior | `src/vs/sessions/browser/layoutActions.ts` |
| Change session switch behavior | `src/vs/sessions/contrib/layout/browser/sessionLayoutController.ts` |
| Change when Changes auto-opens | `LayoutController` pending-turn logic |
| Add a right-panel container | Register a `ViewContainerLocation.AuxiliaryBar` container in a sessions contribution |
| Add a title action | Contribute to `Menus.AuxiliaryBarTitle` |
| Change Files view | `src/vs/sessions/contrib/files/browser/filesView.ts` |
| Change Browser view | `src/vs/sessions/contrib/browserView/browser/sessionBrowserPanel.ts` |
| Change visual chrome | `src/vs/sessions/browser/media/style.css` and `parts/media/auxiliaryBarPart.css` |
| Change mobile behavior | `layoutPolicy.ts`, `MobileAuxiliaryBarPart`, and mobile contribution gating |
| Change normal editor-workbench secondary side bar | `src/vs/workbench/browser/parts/auxiliarybar/*` |

## Practical Debugging Checklist

When the right panel is not doing what you expect:

1. Check whether you are in the normal workbench or the sessions workbench.
2. Check `Parts.AUXILIARYBAR_PART` visibility through `IWorkbenchLayoutService`.
3. Check the active pane composite at `ViewContainerLocation.AuxiliaryBar`.
4. Check whether `.noauxiliarybar` is on the root `.agent-sessions-workbench`.
5. Check whether multiple sessions are visible; per-session sync is suppressed.
6. Check `sessions.layoutState` for saved hidden state.
7. Check `workbench.sessions.partVisibility` for workspace-global hidden state.
8. Check whether phone layout is active; the desktop auxiliary views are gated.
9. Check whether the editor was hidden because the auxiliary bar was hidden.
10. Check whether a contribution module is imported by `sessions.common.main.ts`.

