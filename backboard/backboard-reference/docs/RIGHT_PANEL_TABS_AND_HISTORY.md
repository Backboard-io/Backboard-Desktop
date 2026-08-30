# Backboard Right Panel Tabs And History

This doc maps how the Backboard right-panel tab strip and history button work, where the code lives, and what to change when the behavior breaks.

## Source Files

Right-panel tab row:

```text
src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.ts
src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTitleControl.css
```

History button action:

```text
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts
```

History modal:

```text
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsHistoryModal.ts
src/vs/workbench/contrib/chat/browser/agentSessions/media/agentSessionsHistoryModal.css
```

Session list/control used inside the modal:

```text
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsControl.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsService.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsModel.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsOpener.ts
```

## Mental Model

The right panel has two different session UIs:

1. The history tab row in the chat title area.
2. The full history modal opened by the history button.

They both read from the same session source:

```ts
IAgentSessionsService.model.sessions
```

They both open sessions through:

```ts
openSession(...)
```

The tab row is now a compact history surface. It explicitly refreshes the provider-backed session model, renders the newest history sessions, and keeps the active session visible even when it is older than the visible tab cap. The history modal is still the full picker/list.

## Tab Row Flow

The tab UI is owned by `ChatViewTitleControl`.

Important fields:

```ts
private tabsContainer: HTMLElement | undefined;
private tabDisposables = this._register(new DisposableStore());
private readonly closedSessionTabs = new Set<string>();
private model: IChatModel | undefined;
private readonly refreshHistoryTabsDelayer = this._register(new Delayer<void>(250));
```

The current chat model is passed in through:

```ts
update(model: IChatModel | undefined): void {
	this.model = model;
	this.modelDisposables.value = model?.onDidChange(e => {
		if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
			this.doUpdate();
		}
	});
	this.doUpdate();
}
```

`doUpdate()` resolves the visible title and refreshes the tab row:

```ts
private doUpdate(): void {
	const title = this.getResolvedTitle();
	this.updateTitle(title);
}
```

`updateTitle()` updates the active tab label and calls `updateTabs(title)`:

```ts
private updateTitle(title: string): void {
	this.titleContainer.classList.toggle('visible', this.shouldRender());
	this.titleLabel.value?.updateTitle(title);
	if (this.activeTabLabel) {
		this.activeTabLabel.textContent = title;
	}
	this.updateTabs(title);
}
```

The title control also asks the same session model used by the history modal to refresh from registered providers:

```ts
private refreshHistoryTabs(): void {
	void this.refreshHistoryTabsDelayer.trigger(async () => {
		await this.agentSessionsService.model.resolve(undefined);
		this.updateTabs(this.getResolvedTitle());
	}).catch(() => undefined);
}
```

This is what makes tabs behave like history tabs instead of only rendering whatever happened to be in memory.

## Current Tab Render Logic

The current implementation keeps horizontal scroll stable, renders recent history in recency order, and keeps the current session visible:

```ts
private updateTabs(currentTitle: string): void {
	if (!this.tabsContainer) {
		return;
	}

	this.tabDisposables.clear();
	const previousScrollLeft = this.tabsContainer.scrollLeft;
	this.tabsContainer.replaceChildren();

	const currentSessionResource = this.model?.sessionResource;
	let didRenderCurrentSession = false;

	const sessions = this.getHistoryTabSessions(currentSessionResource);

	for (const session of sessions) {
		const isCurrentSession = !!currentSessionResource && isEqual(session.resource, currentSessionResource);
		didRenderCurrentSession ||= isCurrentSession;

		this.addTab({
			label: isCurrentSession ? currentTitle : session.label,
			active: isCurrentSession,
			isCurrent: isCurrentSession,
			session,
		});
	}

	if (!didRenderCurrentSession) {
		this.addTab({
			label: currentTitle,
			active: true,
			isCurrent: true,
		});
	}

	this.tabsContainer.scrollLeft = previousScrollLeft;
}
```

The history-tab selection logic is:

```ts
private getHistoryTabSessions(currentSessionResource: IChatModel['sessionResource'] | undefined): IAgentSession[] {
	const sortedSessions = this.agentSessionsService.model.sessions
		.filter(session => !session.isArchived())
		.filter(session => {
			const isCurrentSession = !!currentSessionResource && isEqual(session.resource, currentSessionResource);
			return isCurrentSession || !this.closedSessionTabs.has(session.resource.toString());
		})
		.sort((a, b) => this.getHistoryTabTime(b) - this.getHistoryTabTime(a) || a.label.localeCompare(b.label));

	const visibleSessions = sortedSessions.slice(0, ChatViewTitleControl.MAX_HISTORY_TABS);
	if (!currentSessionResource || visibleSessions.some(session => isEqual(session.resource, currentSessionResource))) {
		return visibleSessions;
	}

	const currentSession = sortedSessions.find(session => isEqual(session.resource, currentSessionResource));
	if (!currentSession) {
		return visibleSessions;
	}

	if (visibleSessions.length < ChatViewTitleControl.MAX_HISTORY_TABS) {
		visibleSessions.push(currentSession);
	} else {
		visibleSessions[visibleSessions.length - 1] = currentSession;
	}

	return visibleSessions;
}
```

Why this matters:

- The tab row now uses provider-backed session history.
- The newest history sessions are shown first.
- The visible history tab count is capped.
- The active/current session is always kept visible.
- Preserve `scrollLeft`, or tab navigation feels jumpy.
- Always render the current session even if it was not in the session model yet.

## Tab Click And Close Code

Tab creation is handled by `addTab(...)`.

Open a session:

```ts
this.tabDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
	e.preventDefault();
	e.stopPropagation();
	if (options.session) {
		void this.instantiationService.invokeFunction(openSession, options.session);
	} else {
		this.delegate.focusChat();
	}
}));
```

Close a tab:

```ts
this.tabDisposables.add(addDisposableListener(tabElements.close, EventType.CLICK, e => {
	e.preventDefault();
	e.stopPropagation();
	if (options.session) {
		this.closedSessionTabs.add(options.session.resource.toString());
	}
	this.updateTabs(this.getResolvedTitle());
}));
```

Important detail: closing a tab does not archive/delete the session. It only hides that session from the compact history tab row through:

```ts
closedSessionTabs
```

The full session still exists and should still appear in the history modal.

## History Button Flow

The history button is registered in `PickAgentSessionAction`.

Command ID:

```ts
workbench.action.chat.history
```

Registration:

```ts
export class PickAgentSessionAction extends Action2 {
	constructor() {
		super({
			id: `workbench.action.chat.history`,
			title: localize2('agentSessions.open', "Open Agent Session..."),
			menu: [
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', ChatViewId),
					group: 'navigation',
					order: 2
				},
				{
					id: MenuId.EditorTitle,
					when: ActiveEditorContext.isEqualTo(ChatEditorInput.EditorID),
				}
			],
			category: AGENT_SESSIONS_CATEGORY,
			icon: Codicon.history,
			f1: true,
			precondition: ChatContextKeys.enabled
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);

		currentAgentSessionsHistoryModal?.dispose();
		currentAgentSessionsHistoryModal = instantiationService.createInstance(AgentSessionsHistoryModal);
		currentAgentSessionsHistoryModal.show();
	}
}
```

The button appears in the right panel title area because it contributes to:

```ts
MenuId.ViewTitle
```

with:

```ts
when: ContextKeyExpr.equals('view', ChatViewId)
```

If the history button is visible but does nothing, check:

```text
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsHistoryModal.ts
```

If the history button disappears, check the `view === ChatViewId` context.

## History Modal Flow

The modal is created by:

```ts
currentAgentSessionsHistoryModal = instantiationService.createInstance(AgentSessionsHistoryModal);
currentAgentSessionsHistoryModal.show();
```

Inside `AgentSessionsHistoryModal.show()`:

1. It appends a backdrop to the workbench container.
2. It creates a dialog.
3. It adds close handling.
4. It adds a New Session button.
5. It creates `AgentSessionsFilter`.
6. It creates `AgentSessionsControl`.
7. It wires session opening through `overrideSessionOpen`.

The important open-session part:

```ts
this.control = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.body, {
	source: 'chatHistoryModal',
	filter,
	overrideStyles: {},
	getHoverPosition: () => HoverPosition.RIGHT,
	trackActiveEditorSession: () => false,
	collapseOlderSections: () => true,
	overrideSessionOpen: async (resource, openOptions) => {
		const session = this.agentSessionsService.model.getSession(resource);
		if (session) {
			await this.instantiationService.invokeFunction(openSession, session, openOptions);
			this.dispose();
		}
	},
}));
```

This means the modal does not own session loading. It delegates opening to the same shared `openSession(...)` path.

## Full Click Path

History button:

```text
View title button
-> workbench.action.chat.history
-> PickAgentSessionAction.run()
-> createInstance(AgentSessionsHistoryModal)
-> AgentSessionsHistoryModal.show()
-> AgentSessionsControl renders sessions
-> click session
-> openSession(...)
-> modal closes
```

Tab click:

```text
ChatViewTitleControl.updateTabs()
-> addTab(session)
-> click tab
-> openSession(...)
-> chat model updates
-> updateTitle()
-> updateTabs()
```

Tab close:

```text
click tab close
-> closedSessionTabs.add(session.resource.toString())
-> updateTabs()
-> session hidden from tab row only
```

## Common Bugs And Fixes

### Tab jumps when clicked

Cause:

```text
updateTabs() rebuilds the list and loses scroll position.
```

Fix:

```text
Render history tabs in recency order, preserve scrollLeft, and keep the active session visible without doing a separate active-tab-first pass.
```

Keep this behavior:

```ts
const previousScrollLeft = this.tabsContainer.scrollLeft;
...
this.tabsContainer.scrollLeft = previousScrollLeft;
```

### Closed tab comes back immediately

Cause:

```text
closedSessionTabs is not checked during session filtering.
```

Fix:

```ts
return isCurrentSession || !this.closedSessionTabs.has(session.resource.toString());
```

The current session should still render even if it was previously closed, because it is now active again.

### Current tab label is stale

Cause:

```text
activeTabLabel was not updated after model title changed.
```

Fix:

```ts
if (this.activeTabLabel) {
	this.activeTabLabel.textContent = title;
}
```

### History button disappears

Cause:

```text
The ViewTitle menu context is not ChatViewId.
```

Check:

```ts
when: ContextKeyExpr.equals('view', ChatViewId)
```

If Backboard moves external/extension views into the same container, make sure the active view is still the Backboard chat view when the history button should show.

### History button visible but click does nothing

Check the action implementation first:

```ts
async run(accessor: ServicesAccessor): Promise<void> {
	const instantiationService = accessor.get(IInstantiationService);

	currentAgentSessionsHistoryModal?.dispose();
	currentAgentSessionsHistoryModal = instantiationService.createInstance(AgentSessionsHistoryModal);
	currentAgentSessionsHistoryModal.show();
}
```

Then check modal construction:

```text
AgentSessionsHistoryModal constructor dependencies
AgentSessionsHistoryModal.show()
AgentSessionsControl creation
```

### History opens but sessions do not open

Check this block:

```ts
overrideSessionOpen: async (resource, openOptions) => {
	const session = this.agentSessionsService.model.getSession(resource);
	if (session) {
		await this.instantiationService.invokeFunction(openSession, session, openOptions);
		this.dispose();
	}
},
```

If `getSession(resource)` returns undefined, the list item resource and model resource are out of sync.

## Where To Make Changes

Use this table when deciding what to edit.

| Goal | File | Function/Class |
| --- | --- | --- |
| Change tab layout | `chatViewTitleControl.css` | `.chat-view-title-*` |
| Change tab ordering | `chatViewTitleControl.ts` | `updateTabs()` |
| Change tab close behavior | `chatViewTitleControl.ts` | `addTab()` close listener |
| Change tab click behavior | `chatViewTitleControl.ts` | `addTab()` tab listener |
| Change history button registration | `agentSessionsActions.ts` | `PickAgentSessionAction` |
| Change history modal layout | `agentSessionsHistoryModal.css` | modal classes |
| Change history modal behavior | `agentSessionsHistoryModal.ts` | `AgentSessionsHistoryModal.show()` |
| Change session list behavior | `agentSessionsControl.ts` | `AgentSessionsControl` |
| Change session source/model | `agentSessionsService.ts`, `agentSessionsModel.ts` | service/model |
| Change actual open behavior | `agentSessionsOpener.ts` | `openSession(...)` |

## Safe Implementation Order

1. Fix command/action behavior first.
2. Fix data/session resource matching second.
3. Fix rendering/order third.
4. Fix CSS after behavior works.
5. Test tab click, tab close, history open, modal session open.

Do not start with CSS if clicks are broken. Most real failures here come from action registration, stale view context, resource mismatch, or rebuilding the tab list incorrectly.

## Smoke Tests

Run these after changing the tab/history code:

```text
1. Open Backboard right panel.
2. Start a new chat.
3. Send a message.
4. Open another session.
5. Click between tabs.
6. Confirm tabs do not change position.
7. Close a non-active tab.
8. Confirm it disappears from the tab row only.
9. Click the history button.
10. Confirm the history modal opens.
11. Click an old session in the modal.
12. Confirm the modal closes and the session opens.
```

Focused lint:

```sh
./node_modules/.bin/eslint \
  src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.ts \
  src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts \
  src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsHistoryModal.ts
```
