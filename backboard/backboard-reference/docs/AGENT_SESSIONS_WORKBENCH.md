# Agent Sessions Workbench Walkthrough

This document explains the agent sessions workspace in this VS Code fork: where it lives, what each panel does, how the workbench starts, how sessions are rendered, and why the editor area is optional.

The key idea is that the agent sessions window is not just the normal VS Code workbench with a chat view opened. It is a dedicated workbench layer under `src/vs/sessions` that reuses many workbench services but owns its own shell layout and session grid.

## Source Map

Primary files:

- `src/vs/sessions/sessions.common.main.ts`
  - Shared entry point for the sessions workbench.
  - Imports common workbench services, chat, terminal, SCM, editor, and sessions contributions.

- `src/vs/sessions/sessions.desktop.main.ts`
  - Desktop/Electron entry point.
  - Adds native services, remote agent hosts, desktop terminal support, dialogs, browser view support, and desktop-only contributions.

- `src/vs/sessions/browser/workbench.ts`
  - Custom sessions workbench shell.
  - Creates titlebar, sidebar, sessions part, optional editor part, panel, auxiliary bar, notifications, and layout grid.

- `src/vs/sessions/browser/parts/sessionsPart.ts`
  - Main central agent surface.
  - Hosts a grid of `SessionView` leaves.

- `src/vs/sessions/browser/parts/sessionView.ts`
  - One visible session slot.
  - Hosts the session header, chat tabs, floating toolbar, and the current chat/new-chat view.

- `src/vs/sessions/contrib/chat/browser/chatView.ts`
  - Concrete chat views used inside a `SessionView`.
  - Wraps normal workbench `ChatWidget` for active chats.

- `src/vs/sessions/services/sessions/browser/sessionsService.ts`
  - View-state service.
  - Owns visible sessions, active session, sticky sessions, grid restore, navigation, and focus.

- `src/vs/sessions/services/sessions/browser/sessionsManagementService.ts`
  - Model/lifecycle service.
  - Talks to session providers, creates sessions, sends requests, archives/deletes sessions, and mirrors provider events.

- `src/vs/sessions/browser/parts/editorPart.ts`
  - Sessions-specific wrapper around the normal VS Code editor part.

- `src/vs/sessions/browser/parts/editorParts.ts`
  - Registers the sessions-specific editor groups service.

## High-Level Architecture

Normal VS Code workbench:

```text
src/vs/workbench

titlebar
activity/sidebar
editor area
panel
auxiliary bar
statusbar
```

Agent sessions workbench:

```text
src/vs/sessions

custom titlebar
sidebar with Sessions view
main SessionsPart grid
optional editor part
bottom panel
right auxiliary bar
notifications
mobile-specific shell variants
```

The sessions workbench can import from `src/vs/workbench`, but normal workbench code should not import from `src/vs/sessions`. That keeps the agent-session shell layered on top of the workbench instead of making the base workbench depend on the agent UI.

## Entry Points

### Common Sessions Entry

`src/vs/sessions/sessions.common.main.ts` selectively imports workbench services and contributions needed by the sessions shell.

It includes foundations like:

- editor core
- workbench editor service
- workbench views service
- chat shared contributions
- terminal
- SCM/git
- output
- webviews
- markdown
- authentication
- configuration
- extensions management
- MCP

Then it adds sessions-specific contributions:

```ts
import './browser/paneCompositePartService.js';
import './browser/parts/editorParts.js';
import './browser/parts/sessionsParts.js';
import './services/sessions/browser/sessionsService.js';
import './contrib/chat/browser/chat.contribution.js';
import './contrib/sessions/browser/sessions.contribution.js';
import './services/sessions/browser/sessionsManagementService.js';
```

This tells you the shell is assembled from normal workbench building blocks plus sessions-specific replacements.

### Desktop Sessions Entry

`src/vs/sessions/sessions.desktop.main.ts` imports the common entry and adds desktop/native services:

```ts
import './sessions.common.main.js';
import './electron-browser/sessions.main.js';
import '../workbench/electron-browser/desktop.contribution.js';
```

It also wires in local/remote agent host support:

```ts
import '../workbench/services/agentHost/electron-browser/agentHostService.js';
import '../platform/agentHost/electron-browser/remoteAgentHostService.js';
import '../platform/agentHost/electron-browser/sshRemoteAgentHostService.js';
import '../platform/agentHost/electron-browser/wslRemoteAgentHostService.js';
import './contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js';
```

## Workbench Startup Flow

The sessions workbench startup is implemented in `src/vs/sessions/browser/workbench.ts`.

The important sequence is:

```ts
startup(): IInstantiationService {
	const instantiationService = this.initServices(this.serviceCollection);

	instantiationService.invokeFunction(accessor => {
		this.initLayout(accessor);

		Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).start(accessor);
		Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor);

		this.renderWorkbench(instantiationService, notificationService, storageService, configurationService);
		this.createWorkbenchLayout();
		this.createWorkbenchManagement(instantiationService);
		this.layout();
		this.restore(lifecycleService);
	});

	return instantiationService;
}
```

Conceptually:

1. Register the sessions workbench as the layout service.
2. Instantiate contributed services.
3. Start workbench contributions and editor factories.
4. Create DOM containers for all shell parts.
5. Create the serialized grid layout.
6. Restore visible view containers.
7. Restore previously visible agent sessions.

## Main Shell Panels

The shell creates these workbench parts:

```ts
{ id: Parts.TITLEBAR_PART, classes: ['titlebar'] }
{ id: Parts.SIDEBAR_PART, classes: ['sidebar', 'left'] }
{ id: Parts.AUXILIARYBAR_PART, classes: ['auxiliarybar', 'basepanel', 'right'] }
{ id: Parts.PANEL_PART, classes: ['panel', 'basepanel', positionToString(this.getPanelPosition())] }
```

Then it separately creates:

```ts
this.createEditorPart();
this.createSessionsPart();
```

The result is:

```text
Titlebar
└─ Right section
   ├─ Sidebar
   └─ Main body
      ├─ SessionsPart
      ├─ EditorPart, optional
      ├─ AuxiliaryBar
      └─ Panel
```

## Sidebar: Sessions View

The Sessions view is registered in `src/vs/sessions/contrib/sessions/browser/sessions.contribution.ts`.

```ts
const SessionsContainerId = 'agentic.workbench.view.sessionsContainer';

const agentSessionsViewContainer = Registry
	.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: SessionsContainerId,
		title: AGENT_SESSIONS_VIEW_TITLE,
		icon: agentSessionsViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			SessionsContainerId,
			{ mergeViewWithContainerWhenSingleView: true }
		]),
		hideIfEmpty: true,
		order: 6,
		windowEnablement: WindowEnablement.Sessions
	}, ViewContainerLocation.Sidebar, { isDefault: true });
```

It then registers the actual view:

```ts
const sessionsViewPaneDescriptor: IViewDescriptor = {
	id: SessionsViewId,
	name: AGENT_SESSIONS_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(SessionsView),
	windowEnablement: WindowEnablement.Sessions
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry)
	.registerViews([sessionsViewPaneDescriptor], agentSessionsViewContainer);
```

This is the left-side list/picker area for sessions.

## Pane Composite Service

The sessions workbench replaces the normal pane composite part service with `AgenticPaneCompositePartService`.

File: `src/vs/sessions/browser/paneCompositePartService.ts`

```ts
export class AgenticPaneCompositePartService extends Disposable implements IPaneCompositePartService {
	private readonly paneCompositeParts = new Map<ViewContainerLocation, IPaneCompositePart>();

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();

		const { width } = getClientArea(mainWindow.document.body);
		const isPhoneLayout = width < 640;

		this.registerPart(ViewContainerLocation.Panel, instantiationService.createInstance(isPhoneLayout ? MobilePanelPart : PanelPart));
		this.registerPart(ViewContainerLocation.Sidebar, instantiationService.createInstance(isPhoneLayout ? MobileSidebarPart : SidebarPart));
		this.registerPart(ViewContainerLocation.AuxiliaryBar, instantiationService.createInstance(isPhoneLayout ? MobileAuxiliaryBarPart : AuxiliaryBarPart));
	}
}
```

This service owns the sidebar, panel, and auxiliary bar pane-composite parts for the sessions shell. It also chooses mobile variants when the viewport is narrow.

## Main Agent Surface: SessionsPart

`SessionsPart` is the main central surface for agent work.

File: `src/vs/sessions/browser/parts/sessionsPart.ts`

It is a `Part` that contains an internal `SerializableGrid<SessionView>`:

```ts
export class SessionsPart extends Part {
	protected _gridWidget: SerializableGrid<SessionView> | undefined;
	private readonly _slots: IGridSlot[] = [];
}
```

Each slot is:

```ts
interface IGridSlot {
	readonly view: SessionView;
	readonly disposables: DisposableStore;
	boundSessionId: string | undefined;
}
```

There is always at least one slot. If no session is active, the slot renders a new-session composer.

### Grid Creation

When the part is created, it seeds the grid with a placeholder:

```ts
const placeholder = this._createSlot();
this._gridWidget = this._register(new SerializableGrid(
	placeholder.view,
	{ styles: { separatorBorder: this._gridSeparatorBorder } }
));
this._slots.push(placeholder);
contentArea.appendChild(this._gridWidget.element);
```

### Reconciliation

The central method is `updateVisibleSessions`:

```ts
updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
	const desiredCount = Math.max(visible.length, 1);

	while (this._slots.length < desiredCount) {
		const slot = this._createSlot();
		const reference = this._slots[this._slots.length - 1].view;
		this._gridWidget.addView(slot.view, Sizing.Distribute, reference, Direction.Right);
		this._slots.push(slot);
	}

	while (this._slots.length > desiredCount) {
		const slot = this._slots.pop()!;
		this._gridWidget.removeView(slot.view, Sizing.Distribute);
		slot.disposables.dispose();
	}

	for (let i = 0; i < this._slots.length; i++) {
		const slot = this._slots[i];
		const session = visible[i];
		slot.boundSessionId = session?.sessionId;
		slot.view.openSession(session, {
			renderSessionTypePickerInControls: this._renderSessionTypePickerInControls
		});
	}
}
```

This is a renderer. It does not decide which sessions should be visible. It receives that from `SessionsService`.

## SessionView

Each `SessionView` is one visible grid leaf.

File: `src/vs/sessions/browser/parts/sessionView.ts`

It owns:

- `SessionHeader`
- `ChatCompositeBar`
- current chat/new-chat view
- floating toolbar
- scoped context keys
- active/inactive styling

Constructor shape:

```ts
this._centeredContentContainer = $('.session-view-centered-content');
this.element.appendChild(this._centeredContentContainer);

this._header = this._register(scopedInstantiationService.createInstance(SessionHeader));
this._centeredContentContainer.appendChild(this._header.element);

this._compositeBar = this._register(scopedInstantiationService.createInstance(ChatCompositeBar));
this._centeredContentContainer.appendChild(this._compositeBar.element);

this._contentContainer = $('.session-view-content');
this.element.appendChild(this._contentContainer);

this._floatingToolbar = this._register(scopedInstantiationService.createInstance(SessionViewFloatingToolbar));
this.element.appendChild(this._floatingToolbar.element);
```

### Choosing What To Render

`SessionView.openSession` switches between three modes:

```ts
let desiredKind: ChatViewKind;

if (session === undefined || session.isCreated.read(reader) === false) {
	desiredKind = 'newSession';
} else if (session.activeChat.read(reader).status.read(reader) === SessionStatus.Untitled) {
	desiredKind = 'newChatInSession';
} else {
	desiredKind = 'chat';
}
```

Then it creates the right view:

```ts
if (!view || view.kind !== desiredKind) {
	view = desiredKind === 'chat'
		? this.chatViewFactory.createChatView()
		: this.chatViewFactory.createNewChatView(desiredKind === 'newChatInSession', options);

	this._contentContainer.replaceChildren(view.element);
	this._currentView.value = view;
}
```

So a session slot is stable, but its inner content can change from composer to active chat.

## Chat Views

Concrete chat views live in `src/vs/sessions/contrib/chat/browser/chatView.ts`.

There are two main classes:

```ts
export class NewChatView extends AbstractChatView { ... }
export class ChatView extends AbstractChatView { ... }
```

`NewChatView` hosts either:

- `NewChatWidget`
- `NewChatInSessionWidget`

`ChatView` hosts the normal workbench `ChatWidget`:

```ts
this._widget = this._register(scopedInstantiationService.createInstance(
	ChatWidget,
	ChatAgentLocation.Chat,
	undefined,
	{
		autoScroll: mode => mode !== ChatModeKind.Ask,
		renderFollowups: true,
		supportsFileReferences: true,
		enableImplicitContext: true,
		enableWorkingSet: 'explicit',
		supportsChangingModes: true,
		dndContainer: this.element,
	},
	this._buildStyles(this._isActive)
));
```

The sessions workbench therefore reuses the real chat stack instead of implementing a separate transcript renderer.

## SessionsService vs SessionsManagementService

There are two separate services for sessions.

### SessionsManagementService

File: `src/vs/sessions/services/sessions/browser/sessionsManagementService.ts`

This is the model/lifecycle service. It:

- gathers sessions from all providers
- creates new sessions
- sends requests
- archives/unarchives/deletes sessions
- handles provider events
- tracks in-progress new sessions
- maps chat resources back to owning sessions

Representative API:

```ts
getSessions(): ISession[]
getSession(resource: URI): ISession | undefined
createNewSession(...)
sendRequest(...)
archiveSession(...)
deleteSession(...)
```

### SessionsService

File: `src/vs/sessions/services/sessions/browser/sessionsService.ts`

This is the view-state service. It:

- owns the active visible session
- owns the visible session list
- restores the previous grid
- handles session navigation
- pins/sticks sessions in the grid
- closes sessions from the grid
- tells `SessionsPart` what to render

The most important autorun is:

```ts
this._register(autorun(reader => {
	const visible = this.visibleSessions.read(reader);
	const active = this._visibility.activeSession.read(reader);
	const preserveFocus = this._visibility.activePreserveFocus.read(reader);

	this.sessionsPartService.updateVisibleSessions(visible, active);

	const activeId = active?.sessionId;
	if (activeId !== this._focusedActiveSessionId) {
		this._focusedActiveSessionId = activeId;
		if (!preserveFocus) {
			this.sessionsPartService.focusSession(active);
		}
	}
}));
```

This is the bridge from state to UI.

## Optional Editor Part

The optional editor is a full VS Code editor area, but it is not the default center of the agent sessions window.

In the sessions workbench:

- the primary center is `SessionsPart`
- the editor area is hidden by default
- it appears beside the sessions grid when something opens an editor
- it hides again when all main editor groups are empty

### Registration

File: `src/vs/sessions/browser/parts/editorParts.ts`

```ts
export class EditorParts extends EditorPartsBase {
	protected override createMainEditorPart(): MainEditorPart {
		return this.instantiationService.createInstance(MainEditorPart, this);
	}
}

registerSingleton(IEditorGroupsService, EditorParts, InstantiationType.Eager);
```

This replaces the editor groups service with a subclass that creates a sessions-specific main editor part.

### Sessions-Specific MainEditorPart

File: `src/vs/sessions/browser/parts/editorPart.ts`

```ts
export class MainEditorPart extends MainEditorPartBase {
	override get minimumWidth() {
		return Math.max(300, super.minimumWidth);
	}

	override priority = LayoutPriority.High;

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			return;
		}

		super.layout(adjustedWidth, adjustedHeight, top, left);
	}
}
```

It still inherits the normal editor behavior:

- editor groups
- tabs
- editor panes
- diff editors
- custom editors
- file editors
- settings editors

The wrapper mostly adjusts layout behavior for the sessions shell.

### Show On Editor Open

File: `src/vs/sessions/browser/workbench.ts`

```ts
this._register(this.editorService.onWillOpenEditor(e => {
	if (this._editorPartAutoVisibilitySuppressionCount > 0) {
		return;
	}

	const targetsMainEditorPart = this.editorGroupService.mainPart.groups.some(group => group.id === e.groupId);
	if (!targetsMainEditorPart) {
		return;
	}

	if (!this.partVisibility.editor) {
		this.setEditorHidden(false);
		this.restoreAttachedEditorMaximizedState();
	}
}));
```

The guard matters: modal editor opens and programmatic suppressed opens should not force the main editor area to appear.

### Hide On Last Editor Close

```ts
this._register(this.editorService.onDidCloseEditor(() => {
	if (this._editorPartAutoVisibilitySuppressionCount > 0) {
		return;
	}

	if (this.partVisibility.editor && this.areAllGroupsInMainPartEmpty()) {
		this.rememberAttachedEditorMaximizedState();
		this.setEditorHidden(true);
	}
}));
```

The editor disappears only when all main editor groups are empty:

```ts
private areAllGroupsInMainPartEmpty(): boolean {
	for (const group of this.editorGroupService.mainPart.groups) {
		if (!group.isEmpty) {
			return false;
		}
	}
	return true;
}
```

### Reveal Layout

When the editor is revealed for the first time, the sessions workbench makes it an even split with the sessions area:

```ts
private setEditorHidden(hidden: boolean): void {
	const shouldApplyEvenSplit = !hidden && !this._hasAppliedInitialEditorSplit;

	const mainAreaWidthBeforeReveal = shouldApplyEvenSplit
		? this.workbenchGrid.getViewSize(this.sessionsPartView).width
		: 0;

	this.workbenchGrid.setViewVisible(this.editorPartView, !hidden);

	if (shouldApplyEvenSplit) {
		this._hasAppliedInitialEditorSplit = true;
		this._applyEditorSplitSize(mainAreaWidthBeforeReveal);
	}
}
```

The split size:

```ts
private _applyEditorSplitSize(mainAreaWidth: number): void {
	const targetEditorWidth = Math.max(300, Math.floor(mainAreaWidth / 2));
	const currentEditorSize = this.workbenchGrid.getViewSize(this.editorPartView);

	this.workbenchGrid.resizeView(this.editorPartView, {
		width: targetEditorWidth,
		height: currentEditorSize.height
	});
}
```

So the first reveal is friendly: sessions and editor share the main area 50/50. Later reveals preserve the user's resized width.

### Layout Position

The desktop grid places the editor between sessions and the auxiliary bar:

```ts
const topRightSection: ISerializedNode = {
	type: 'branch',
	data: [sessionsNode, editorNode, auxiliaryBarNode],
	size: topRightHeight
};
```

Visual shape:

```text
Sidebar | SessionsPart | Optional Editor | AuxiliaryBar
        |              |                 |
        |              Panel             |
```

## Grid Descriptor

The shell layout is built from a `SerializableGrid`.

File: `src/vs/sessions/browser/workbench.ts`

```ts
const workbenchGrid = SerializableGrid.deserialize(
	this.createGridDescriptor(),
	{ fromJSON },
	{ proportionalLayout: false }
);

this.mainContainer.prepend(workbenchGrid.element);
this.workbenchGrid = workbenchGrid;
```

The descriptor includes:

- titlebar leaf
- sidebar leaf
- sessions leaf
- editor leaf
- auxiliary bar leaf
- panel leaf

Each part has a `visible` field derived from `partVisibility`.

For the optional editor:

```ts
const editorNode: ISerializedLeafNode = {
	type: 'leaf',
	data: { type: Parts.EDITOR_PART },
	size: editorSize,
	visible: this.partVisibility.editor
};
```

That is why the editor can exist structurally but be hidden visually.

## Focus Model

The session grid promotes a session to active when its view receives focus or pointer down.

In `SessionsPart`:

```ts
const fireFocus = () => {
	if (slot.boundSessionId !== undefined) {
		this._onDidFocusSession.fire(slot.boundSessionId);
	}
};

disposables.add(addDisposableListener(view.element, EventType.FOCUS_IN, fireFocus, true));
disposables.add(addDisposableGenericMouseDownListener(view.element, fireFocus, true));
```

In `SessionsService`:

```ts
this._register(this.sessionsPartService.onDidFocusSession(sessionId => {
	const session = this.visibleSessions.get().find(s => s?.sessionId === sessionId);
	if (session) {
		this.setActive(session);
	}
}));
```

This makes keyboard/mouse focus and logical active session stay aligned.

## Restore Flow

During workbench restore:

```ts
private restore(lifecycleService: ILifecycleService): void {
	this.restoreParts();

	void this.sessionsService.restoreVisibleSessions().catch(e => {
		this.logService.error('[Workbench] restoreVisibleSessions failed', e);
	});

	lifecycleService.phase = LifecyclePhase.Restored;
	this.setRestored();
}
```

`restoreParts()` opens the default view containers for visible sidebar/panel/auxiliary bar:

```ts
const partsToRestore = [
	{ location: ViewContainerLocation.Sidebar, visible: this.partVisibility.sidebar },
	{ location: ViewContainerLocation.Panel, visible: this.partVisibility.panel },
	{ location: ViewContainerLocation.AuxiliaryBar, visible: this.partVisibility.auxiliaryBar },
];
```

Then `SessionsService.restoreVisibleSessions()` restores the session grid state.

## Mobile Behavior

The sessions workbench has mobile-specific parts:

- `MobileSessionsPart`
- `MobilePanelPart`
- `MobileSidebarPart`
- `MobileAuxiliaryBarPart`
- `MobileTitlebarPart`

The shell chooses mobile variants based on viewport width:

```ts
const { width } = getClientArea(mainWindow.document.body);
const isPhoneLayout = width < 640;
```

On phone layout:

- the normal titlebar is hidden
- a mobile titlebar is created
- sidebar can act like a drawer
- panel and auxiliary bar can be hidden/showed as overlays
- mobile browser back behavior can close transient UI layers

## End-To-End Example: Opening A File From Chat

Expected path:

```text
Agent/session UI triggers open editor
        |
IEditorService opens a file/diff/editor
        |
sessions workbench sees onWillOpenEditor
        |
if target is a main editor group:
        |
setEditorHidden(false)
        |
SerializableGrid reveals editorNode
        |
MainEditorPart lays out normal VS Code editor UI
```

When the file closes:

```text
IEditorService.onDidCloseEditor
        |
areAllGroupsInMainPartEmpty()
        |
setEditorHidden(true)
        |
SerializableGrid hides editorNode
        |
SessionsPart returns to using the space
```

## Why The Editor Is Optional

The agent sessions window is optimized around chat/session work. The central interaction is not "edit a file first"; it is "work with one or more agent sessions first."

The editor is still available because agent workflows naturally open files, diffs, settings, and generated changes. But it should not consume space until it is needed.

So the design is:

```text
Default state:
SessionsPart owns the main area.

When code/file context appears:
EditorPart appears beside SessionsPart.

When editor context goes away:
EditorPart hides and gives space back.
```

## Glossary

- `SessionsPart`
  - Main central grid for visible sessions.

- `SessionView`
  - One visible grid leaf inside `SessionsPart`.

- `NewChatView`
  - Composer view for a new session or a new chat in an existing session.

- `ChatView`
  - Active transcript view. Wraps normal workbench `ChatWidget`.

- `SessionsService`
  - View-state controller for active/visible/restored sessions.

- `SessionsManagementService`
  - Provider/model lifecycle controller.

- `IEditorGroupsService`
  - Normal VS Code editor group service, overridden in sessions to create a sessions-specific main editor part.

- `MainEditorPart`
  - Normal editor part behavior with sessions-specific layout adjustments.

- `SerializableGrid`
  - Workbench layout primitive used for both shell layout and internal session grid layout.

## Quick Debugging Guide

To understand why a session is or is not visible:

1. Check `SessionsService.visibleSessions`.
2. Check `SessionsService.activeSession`.
3. Check calls to `sessionsPartService.updateVisibleSessions`.
4. Check `SessionsPart.updateVisibleSessions`.
5. Check `SessionView.openSession`.

To understand why the editor appeared:

1. Check `IEditorService.onWillOpenEditor`.
2. Confirm the target editor group is in `editorGroupService.mainPart.groups`.
3. Check `setEditorHidden(false)`.
4. Check whether `_hasAppliedInitialEditorSplit` forced a 50/50 split.

To understand why the editor disappeared:

1. Check `IEditorService.onDidCloseEditor`.
2. Check `areAllGroupsInMainPartEmpty`.
3. Check `setEditorHidden(true)`.

To understand panel/sidebar/auxiliary behavior:

1. Check `AgenticPaneCompositePartService`.
2. Check `SidebarPart`, `PanelPart`, and `AuxiliaryBarPart` under `src/vs/sessions/browser/parts`.
3. Check view container registrations under `src/vs/sessions/contrib`.

