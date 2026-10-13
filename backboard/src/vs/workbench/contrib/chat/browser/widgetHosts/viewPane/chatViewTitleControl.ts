/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatViewTitleControl.css';
import { addDisposableListener, EventType, h } from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { Gesture, EventType as TouchEventType } from '../../../../../../base/browser/touch.js';
import { Delayer } from '../../../../../../base/common/async.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { localize } from '../../../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { AgentSessionsPicker } from '../../agentSessions/agentSessionsPicker.js';
import { getAgentSessionListStatus, IAgentSession } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { openSession } from '../../agentSessions/agentSessionsOpener.js';
import { parseSubagentSessionUri } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

export interface IChatViewTitleDelegate {
	focusChat(): void;
	openChatSession(sessionResource: IChatModel['sessionResource']): Promise<void>;
	openNewChat(): void;
}

export class ChatViewTitleControl extends Disposable {

	private static readonly DEFAULT_TITLE = localize('backboard', "Backboard");
	/** An untitled draft reads as a new chat in the strip, not as the product name. */
	private static readonly DRAFT_TITLE = localize('chat.draftTab', "New Chat");
	private static readonly PICK_AGENT_SESSION_ACTION_ID = 'workbench.action.chat.pickAgentSession';
	/** Stable ids of actions registered elsewhere; referenced by id to avoid import cycles. */
	private static readonly NEW_CHAT_COMMAND_ID = 'workbench.action.chat.newChat';
	private static readonly OPEN_AGENT_SESSION_COMMAND_ID = 'workbench.action.chat.history';
	private static readonly OPEN_BACKBOARD_HISTORY_COMMAND_ID = 'workbench.action.chat.openBackboardHistory';
	private static readonly OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openSettings';
	private static readonly MAX_HISTORY_TABS = 40;
	private static toolbarMenuItemsRegistered = false;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;
	private readonly refreshHistoryTabsDelayer = this._register(new Delayer<void>(250));

	private title: string | undefined = undefined;

	private titleContainer: HTMLElement | undefined;
	private titleLabel = this._register(new MutableDisposable<ChatViewTitleLabel>());

	/** The root `.chat-view-title-container` element (tabs + session toolbars). */
	get element(): HTMLElement | undefined {
		return this.titleContainer;
	}

	private actionsToolbarContainer: HTMLElement | undefined;

	/**
	 * The `.chat-view-title-actions-toolbar` element (+ / history / ⋯). The host
	 * re-parents it to the end of the composite title row so the cluster sits
	 * after the agent-panel tabs and stays visible whichever composite is active.
	 */
	get actionsToolbarElement(): HTMLElement | undefined {
		return this.actionsToolbarContainer;
	}

	private model: IChatModel | undefined;
	private lastDisplayedSession: IChatModel['sessionResource'] | undefined;
	private readonly subagentReturnSessions = new Map<string, IChatModel['sessionResource']>();
	private returningToSession: string | undefined;
	private modelDisposables = this._register(new MutableDisposable());

	private navigationToolbar?: MenuWorkbenchToolBar;
	private actionsToolbar?: MenuWorkbenchToolBar;
	private activeTabLabel: HTMLElement | undefined;
	private tabsContainer: HTMLElement | undefined;
	private tabDisposables = this._register(new DisposableStore());
	private readonly closedSessionTabs = new Set<string>();
	/** Session whose ✕ was just clicked while it still owned the surface. */
	private closingCurrentSession: string | undefined;
	private readonly openSessionTabs = new Map<string, { resource: IChatModel['sessionResource']; label: string }>();
	private tabOrder: string[] = [];
	private lastRenderedCurrentSessionResource: string | undefined;

	private lastKnownHeight = 0;

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: IChatViewTitleDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.render(this.container);
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.updateTabs(this.getResolvedTitle())));
		this.refreshHistoryTabs();

		this.registerActions();
	}

	private registerActions(): void {
		const that = this;

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ChatViewTitleControl.PICK_AGENT_SESSION_ACTION_ID,
					title: localize('chat.pickAgentSession', "Pick Agent Session"),
					f1: false,
					menu: [{
						id: MenuId.ChatViewSessionTitleNavigationToolbar,
						group: 'navigation',
						order: 2
					}]
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const instantiationService = accessor.get(IInstantiationService);

				const agentSessionsPicker = instantiationService.createInstance(AgentSessionsPicker, that.titleLabel.value?.element, undefined);
				await agentSessionsPicker.pickAgentSession();
			}
		}));

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ChatViewTitleControl.OPEN_BACKBOARD_HISTORY_COMMAND_ID,
					title: localize('chat.openAgentSession', "Chat History"),
					f1: false,
				});
			}

			run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(ICommandService).executeCommand(ChatViewTitleControl.OPEN_AGENT_SESSION_COMMAND_ID, {
					excludeSubscriptionSessions: true,
				});
			}
		}));

		// Menu items are global registrations — guard so a second window (or a
		// re-created pane) does not register duplicates.
		if (!ChatViewTitleControl.toolbarMenuItemsRegistered) {
			ChatViewTitleControl.toolbarMenuItemsRegistered = true;
			MenuRegistry.appendMenuItem(MenuId.ChatViewSessionTitleToolbar, {
				command: {
					id: ChatViewTitleControl.NEW_CHAT_COMMAND_ID,
					title: localize('chat.newChatTab', "New Chat"),
					icon: Codicon.add,
				},
				group: 'navigation',
				order: 1,
			});
			MenuRegistry.appendMenuItem(MenuId.ChatViewSessionTitleToolbar, {
				command: {
					id: ChatViewTitleControl.OPEN_BACKBOARD_HISTORY_COMMAND_ID,
					title: localize('chat.openAgentSession', "Chat History"),
					icon: Codicon.history,
				},
				group: 'navigation',
				order: 2,
			});
			MenuRegistry.appendMenuItem(MenuId.ChatViewSessionTitleToolbar, {
				command: {
					id: ChatViewTitleControl.OPEN_SETTINGS_COMMAND_ID,
					title: localize('chat.openSettings', "Settings"),
					icon: Codicon.settingsGear,
				},
				group: 'settings',
				order: 3,
			});
		}
	}

	private render(parent: HTMLElement): void {
		const elements = h('div.chat-view-title-container', [
			h('div.chat-view-title-inner', [
				h('div.chat-view-title-tabs@tabsContainer', { role: 'tablist', ariaLabel: localize('chat.sessionTabs', "Chat sessions") }),
				h('div.chat-view-title-navigation-toolbar@navigationToolbar'),
				h('div.chat-view-title-actions-toolbar@actionsToolbar'),
			]),
		]);
		this.tabsContainer = elements.tabsContainer;
		this._register(addDisposableListener(this.tabsContainer, EventType.MOUSE_WHEEL, e => {
			if (!this.tabsContainer || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
				return;
			}

			this.tabsContainer.scrollLeft += e.deltaY;
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false }));

		// Toolbar on the left
		this.navigationToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, elements.navigationToolbar, MenuId.ChatViewSessionTitleNavigationToolbar, {
			actionViewItemProvider: (action: IAction) => {
				if (action.id === ChatViewTitleControl.PICK_AGENT_SESSION_ACTION_ID) {
					this.titleLabel.value = new ChatViewTitleLabel(action);
					this.titleLabel.value.updateTitle(this.title ?? ChatViewTitleControl.DEFAULT_TITLE);

					return this.titleLabel.value;
				}

				return undefined;
			},
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			menuOptions: { shouldForwardArgs: true }
		}));

		// Actions toolbar on the right
		this.actionsToolbarContainer = elements.actionsToolbar;
		this.actionsToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, elements.actionsToolbar, MenuId.ChatViewSessionTitleToolbar, {
			menuOptions: { shouldForwardArgs: true },
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));

		// Title controls
		this.titleContainer = elements.root;
		this._register(Gesture.addTarget(this.titleContainer));
		for (const eventType of [TouchEventType.Tap, EventType.CLICK]) {
			this._register(addDisposableListener(this.titleContainer, eventType, () => {
				this.delegate.focusChat();
			}));
		}

		parent.appendChild(this.titleContainer);
		// The host re-parents these elements between the pane body and the composite
		// title row, so they can outlive `parent` — take them with us on dispose.
		this._register(toDisposable(() => {
			this.titleContainer?.remove();
			this.actionsToolbarContainer?.remove();
		}));
		this.updateTitle(ChatViewTitleControl.DEFAULT_TITLE);
	}

	update(model: IChatModel | undefined): void {
		const resource = model?.sessionResource;
		if (resource && resource.toString() !== this.lastDisplayedSession?.toString()) {
			// Loading can temporarily clear the model; retain the last real source.
			if (parseSubagentSessionUri(resource) && this.lastDisplayedSession && this.returningToSession !== resource.toString()) {
				this.subagentReturnSessions.set(resource.toString(), this.lastDisplayedSession);
			}
			this.returningToSession = undefined;
			this.lastDisplayedSession = resource;
		}
		this.model = model;

		this.modelDisposables.value = model?.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				this.doUpdate();
			}
		});

		this.doUpdate();
		this.refreshHistoryTabs();
	}

	private doUpdate(): void {
		const title = this.getResolvedTitle();

		this.updateTitle(title);

		const context = this.model && {
			$mid: MarshalledId.ChatViewContext,
			sessionResource: this.model.sessionResource
		} satisfies IChatViewTitleActionContext;

		if (this.navigationToolbar) {
			this.navigationToolbar.context = context;
		}

		if (this.actionsToolbar) {
			this.actionsToolbar.context = context;
		}
	}

	/** The strip's label for the session owning the surface. */
	private resolveTabLabel(title: string): string {
		const isEmptyDraft = !this.model || this.model.getRequests().length === 0;
		return isEmptyDraft && title === ChatViewTitleControl.DEFAULT_TITLE ? ChatViewTitleControl.DRAFT_TITLE : title;
	}

	private getResolvedTitle(): string {
		const markdownTitle = new MarkdownString(this.model?.title ?? '');
		this.title = renderAsPlaintext(markdownTitle);
		return this.title.trim() || ChatViewTitleControl.DEFAULT_TITLE;
	}

	private updateTitle(title: string): void {
		if (!this.titleContainer) {
			return;
		}

		this.titleContainer.classList.toggle('visible', this.shouldRender());
		this.titleLabel.value?.updateTitle(title);
		if (this.activeTabLabel) {
			this.activeTabLabel.textContent = this.resolveTabLabel(title);
		}
		this.updateTabs(title);

		const currentHeight = this.getHeight();
		if (currentHeight !== this.lastKnownHeight) {
			this.lastKnownHeight = currentHeight;

			this._onDidChangeHeight.fire();
		}
	}

	private shouldRender(): boolean {
		return true;
	}

	private refreshHistoryTabs(): void {
		void this.refreshHistoryTabsDelayer.trigger(async () => {
			await this.agentSessionsService.model.resolve(undefined);
			this.updateTabs(this.getResolvedTitle());
		}).catch(() => undefined);
	}

	private updateTabs(currentTitle: string): void {
		if (!this.tabsContainer) {
			return;
		}

		this.tabDisposables.clear();
		this.activeTabLabel = undefined;
		const previousScrollLeft = this.tabsContainer.scrollLeft;
		this.tabsContainer.replaceChildren();

		const previousSessionResourceKey = this.lastRenderedCurrentSessionResource;
		const currentSessionResource = this.model?.sessionResource;
		const currentSessionResourceKey = currentSessionResource?.toString();
		const shouldRevealCurrentTab = previousSessionResourceKey !== currentSessionResourceKey;
		this.lastRenderedCurrentSessionResource = currentSessionResourceKey;

		// A session's resource can change identity while it's still "the same"
		// tab from the user's perspective — e.g. a brand-new local draft gets
		// promoted to a persisted resource on its first message
		// (ChatSessionsService#onDidCommitSession). If the previous current
		// resource was never a real, known session (just a local draft we were
		// tracking as the open tab), treat this as a rename: swap it in place
		// instead of leaving the stale draft entry behind and adding the new
		// resource as an additional tab — otherwise sending the first message in
		// a new chat looks like it created a second tab.
		if (
			shouldRevealCurrentTab
			&& previousSessionResourceKey
			&& currentSessionResourceKey
			&& this.openSessionTabs.has(previousSessionResourceKey)
			&& !parseSubagentSessionUri(this.openSessionTabs.get(previousSessionResourceKey)!.resource)
			&& currentSessionResource && !parseSubagentSessionUri(currentSessionResource)
			&& !this.agentSessionsService.model.sessions.some(session => session.resource.toString() === previousSessionResourceKey)
		) {
			const index = this.tabOrder.indexOf(previousSessionResourceKey);
			if (index !== -1) {
				this.tabOrder[index] = currentSessionResourceKey;
			}
			this.openSessionTabs.delete(previousSessionResourceKey);
		}

		// An empty draft never becomes a persistent open tab — it renders as a
		// transient tab for the surface it owns (Devin's "local session" tab)
		// and graduates to a real tab once its first request lands.
		const currentIsEmptyDraft = !this.model || this.model.getRequests().length === 0;
		if (this.closingCurrentSession && this.closingCurrentSession !== currentSessionResourceKey) {
			// The surface has moved on; a later visit is a genuine reopen again.
			this.closingCurrentSession = undefined;
		}
		if (currentSessionResourceKey && this.closingCurrentSession !== currentSessionResourceKey) {
			// Reopening a session whose tab was closed (via history) revives the
			// tab — the session owning the surface always has a visible tab.
			// The one exception is the tab just closed from under the surface:
			// it stays closed while the replacement chat is still loading.
			this.closedSessionTabs.delete(currentSessionResourceKey);
		}
		if (currentSessionResource && currentSessionResourceKey && !this.closedSessionTabs.has(currentSessionResourceKey)) {
			if (currentIsEmptyDraft) {
				this.openSessionTabs.delete(currentSessionResourceKey);
			} else {
				this.openSessionTabs.set(currentSessionResourceKey, { resource: currentSessionResource, label: currentTitle });
			}
		}

		// Devin-style tabs: every session opened in this window keeps a tab in
		// the strip — history stays behind the history (clock) action instead
		// of flooding the strip. The agent-sessions model still resolves live
		// session objects and labels for the tabs that are open.
		const sessionsByResource = new Map(this.agentSessionsService.model.sessions.map(session => [session.resource.toString(), session]));
		for (const resourceKey of this.openSessionTabs.keys()) {
			if (!this.tabOrder.includes(resourceKey)) {
				// New chats append without moving the tabs already open.
				this.tabOrder.push(resourceKey);
			}
		}
		// Returning from a child is navigation, not a draft resource rename.
		// Deduplicate existing entries too, including tabs retained before this fix.
		this.tabOrder = [...new Set(this.tabOrder)].filter(resourceKey => !this.closedSessionTabs.has(resourceKey) && this.openSessionTabs.has(resourceKey));
		if (currentSessionResourceKey && !currentIsEmptyDraft && !this.tabOrder.includes(currentSessionResourceKey)) {
			this.tabOrder.push(currentSessionResourceKey);
		}

		const visibleSessionKeys = this.tabOrder.slice(0, ChatViewTitleControl.MAX_HISTORY_TABS);
		if (currentSessionResourceKey && !currentIsEmptyDraft && !visibleSessionKeys.includes(currentSessionResourceKey)) {
			// The surface's own tab always renders — swap it in for the tail
			// entry when the cap would scroll it out of the strip entirely.
			visibleSessionKeys[visibleSessionKeys.length - 1] = currentSessionResourceKey;
		}
		const renderable = visibleSessionKeys.filter(resourceKey => sessionsByResource.has(resourceKey) || this.openSessionTabs.has(resourceKey));
		const { order, parentOf } = this.nestSubagentTabs(renderable, sessionsByResource);
		for (let index = 0; index < order.length; index++) {
			const resourceKey = order[index];
			const session = sessionsByResource.get(resourceKey);
			const tab = this.openSessionTabs.get(resourceKey);
			const isCurrent = resourceKey === currentSessionResourceKey;
			const resource = session?.resource ?? tab?.resource;
			const parsedSubagent = resource && parseSubagentSessionUri(resource);
			if (isCurrent && parsedSubagent && !parentOf.has(resourceKey)) {
				// The parent's tab is the way back; only when it has been closed
				// does the child carry its own ‹ return affordance.
				this.addBackButton(this.subagentReturnSessions.get(resourceKey) ?? parsedSubagent.parentSession);
			}
			this.addTab({
				label: isCurrent ? currentTitle : (session?.label ?? tab?.label ?? ChatViewTitleControl.DEFAULT_TITLE),
				active: isCurrent,
				isCurrent,
				session,
				sessionResource: session ? undefined : tab?.resource,
				closable: true,
				nested: parentOf.has(resourceKey),
				hasNestedFollower: parentOf.has(order[index + 1]),
			});
		}

		// The current draft gets a transient trailing tab. It can be closed only
		// when another session remains to take over the surface.
		if (currentIsEmptyDraft) {
			this.addTab({
				label: this.resolveTabLabel(currentTitle),
				active: true,
				isCurrent: true,
				isNew: true,
				sessionResource: currentSessionResource,
				closable: this.tabOrder.length > 0,
			});
		}


		if (shouldRevealCurrentTab) {
			// Scroll to wherever the newly active tab actually sits — it's not
			// necessarily near the start once there's history, and jumping to 0
			// unconditionally would scroll it right back out of view.
			const activeTab = this.tabsContainer.querySelector<HTMLElement>('.chat-view-title-tab-active');
			if (activeTab) {
				activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			} else {
				this.tabsContainer.scrollLeft = 0;
			}
		} else {
			this.tabsContainer.scrollLeft = previousScrollLeft;
		}
	}

	/**
	 * Orders the strip so each subagent tab sits directly after the tab of the
	 * session that delegated to it, and reports which tabs nest under a parent.
	 * A subagent whose parent tab is not in the strip stays where it was.
	 */
	private nestSubagentTabs(resourceKeys: readonly string[], sessionsByResource: ReadonlyMap<string, IAgentSession>): { order: string[]; parentOf: Map<string, string> } {
		const present = new Set(resourceKeys);
		const parentOf = new Map<string, string>();
		const childrenOf = new Map<string, string[]>();
		for (const resourceKey of resourceKeys) {
			const resource = sessionsByResource.get(resourceKey)?.resource ?? this.openSessionTabs.get(resourceKey)?.resource;
			const parsed = resource && parseSubagentSessionUri(resource);
			if (!parsed) {
				continue;
			}
			const parentKey = [parsed.parentSession.toString(), this.subagentReturnSessions.get(resourceKey)?.toString()]
				.find(candidate => candidate && candidate !== resourceKey && present.has(candidate));
			if (parentKey) {
				parentOf.set(resourceKey, parentKey);
				childrenOf.set(parentKey, [...childrenOf.get(parentKey) ?? [], resourceKey]);
			}
		}

		const order: string[] = [];
		const visited = new Set<string>();
		const visit = (resourceKey: string) => {
			if (visited.has(resourceKey)) {
				return;
			}
			visited.add(resourceKey);
			order.push(resourceKey);
			for (const child of childrenOf.get(resourceKey) ?? []) {
				visit(child);
			}
		};
		for (const resourceKey of resourceKeys) {
			if (!parentOf.has(resourceKey)) {
				visit(resourceKey);
			}
		}
		// A parent cycle leaves keys unvisited; they still get a tab.
		for (const resourceKey of resourceKeys) {
			if (!visited.has(resourceKey)) {
				parentOf.delete(resourceKey);
				visit(resourceKey);
			}
		}
		return { order, parentOf };
	}

	private addBackButton(parent: IChatModel['sessionResource']): void {
		if (!this.tabsContainer) {
			return;
		}

		const label = localize('chat.backToParentSession', "Back to parent session");
		const back = h('button.chat-view-title-back@root', { type: 'button', title: label, ariaLabel: label }, [
			h('span.chat-view-title-back-icon@icon'),
		]);
		back.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronLeft));
		this.tabsContainer.appendChild(back.root);
		this.tabDisposables.add(addDisposableListener(back.root, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.returningToSession = parent.toString();
			void this.delegate.openChatSession(parent);
		}));
	}

	private addTab(options: { label: string; active: boolean; isCurrent?: boolean; isNew?: boolean; closable?: boolean; session?: IAgentSession; sessionResource?: IChatModel['sessionResource']; nested?: boolean; hasNestedFollower?: boolean }): void {
		if (!this.tabsContainer) {
			return;
		}

		const label = options.label.trim() || ChatViewTitleControl.DEFAULT_TITLE;
		const resource = options.session?.resource ?? options.sessionResource;
		const isSubagent = !!resource && !!parseSubagentSessionUri(resource);
		const tabElements = h('div.chat-view-title-tab@root', { role: 'tab', tabIndex: options.active ? 0 : -1, title: label, ariaLabel: label, ariaSelected: String(options.active) }, [
			h('span.chat-view-title-tab-icon@icon'),
			h('span.chat-view-title-tab-status@status'),
			h('span.chat-view-title-tab-label@label'),
			h('span.codicon.codicon-close.chat-view-title-tab-close@close', { role: 'button', title: localize('chat.closeSessionTab', "Close Tab"), ariaLabel: localize('chat.closeSessionTab', "Close Tab") }),
		]);
		// Not-yet-responded-to sessions show the Backboard mark; sessions with at
		// least one response show a chat bubble. A subagent's icon slot is drawn
		// as a tree connector to the parent tab instead (CSS).
		if (!isSubagent) {
			tabElements.icon.classList.add(...ThemeIcon.asClassNameArray(options.isNew ? ThemeIcon.fromId('backboard-logo') : Codicon.comment));
		}
		tabElements.root.classList.toggle('chat-view-title-tab-subagent', isSubagent);
		tabElements.root.classList.toggle('chat-view-title-tab-nested', !!options.nested);
		tabElements.root.classList.toggle('chat-view-title-tab-has-nested', !!options.hasNestedFollower);
		// A chat still working shows the spinner in its tab, so background work
		// is visible without switching to it.
		if (options.session && getAgentSessionListStatus(options.session) === 'running') {
			const working = localize('chat.sessionTabWorking', "Working...");
			tabElements.status.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.modify(Codicon.loading, 'spin')));
			tabElements.status.title = working;
			tabElements.root.title = `${label} \u2014 ${working}`;
		} else {
			tabElements.status.remove();
		}
		tabElements.label.textContent = label;
		const tab = tabElements.root;
		tab.classList.toggle('chat-view-title-tab-active', options.active);
		if (!options.closable) {
			tabElements.close.remove();
		}

		if (options.active) {
			this.activeTabLabel = tabElements.label;
		}

		this.tabsContainer.appendChild(tab);
		const activate = () => {
			if (options.isCurrent) {
				this.delegate.focusChat();
			} else if (options.session) {
				void this.instantiationService.invokeFunction(openSession, options.session);
			} else if (options.sessionResource) {
				void this.delegate.openChatSession(options.sessionResource);
			} else {
				this.delegate.focusChat();
			}
		};
		this.tabDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			activate();
		}));
		this.tabDisposables.add(addDisposableListener(tab, EventType.KEY_DOWN, e => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
				e.preventDefault();
				e.stopPropagation();
				const tabs = Array.from(this.tabsContainer!.querySelectorAll<HTMLElement>('[role="tab"]'));
				const index = tabs.indexOf(tab);
				const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
				for (const item of tabs) {
					item.tabIndex = item === tabs[next] ? 0 : -1;
				}
				tabs[next]?.focus();
			} else if ((e.key === 'Delete' || e.key === 'Backspace') && options.closable) {
				e.preventDefault();
				e.stopPropagation();
				this.closeTab(options);
			} else if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				activate();
			}
		}));

		if (options.closable) {
			this.tabDisposables.add(addDisposableListener(tabElements.close, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.closeTab(options);
			}));
		}
	}

	private closeTab(options: { isCurrent?: boolean; session?: IAgentSession; sessionResource?: IChatModel['sessionResource'] }): void {
		const resourceKey = options.session?.resource.toString() ?? options.sessionResource?.toString();
		const markClosed = () => {
			if (resourceKey) {
				this.closedSessionTabs.add(resourceKey);
				this.openSessionTabs.delete(resourceKey);
			}
			this.updateTabs(this.getResolvedTitle());
		};

		if (!options.isCurrent) {
			markClosed();
			return;
		}

		// Until the surface actually moves to another chat, this key must not be
		// revived as "the session owning the surface".
		this.closingCurrentSession = resourceKey;

		// Closing the tab that owns the surface hands it to the neighbouring
		// tab — the closed marker only sticks once another session is current,
		// because `updateTabs` revives the tab of whichever session owns the
		// surface.
		const index = resourceKey ? this.tabOrder.indexOf(resourceKey) : -1;
		const next = index === -1
			? this.tabOrder[0]
			: (this.tabOrder[index + 1] ?? this.tabOrder[index - 1]);
		if (next && this.openSessionTabs.has(next)) {
			void this.activateSessionTab(next).then(markClosed, markClosed);
		} else {
			markClosed();
			// Nothing left to switch to: fall back to the panel's resting
			// state, a fresh draft tab.
			this.delegate.openNewChat();
		}
	}

	private activateSessionTab(resourceKey: string): Promise<unknown> {
		const session = this.agentSessionsService.model.sessions.find(s => s.resource.toString() === resourceKey);
		if (session) {
			return this.instantiationService.invokeFunction(openSession, session);
		}
		const tab = this.openSessionTabs.get(resourceKey);
		if (tab) {
			return this.delegate.openChatSession(tab.resource);
		}
		return Promise.resolve();
	}

	getHeight(): number {
		if (!this.titleContainer || this.titleContainer.style.display === 'none') {
			return 0;
		}

		return this.titleContainer.offsetHeight;
	}
}

class ChatViewTitleLabel extends ActionViewItem {

	private title: string | undefined;

	private titleLabel: HTMLSpanElement | undefined = undefined;

	constructor(action: IAction, options?: IActionViewItemOptions) {
		super(null, action, { ...options, icon: false, label: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('chat-view-title-action-item');
		this.label?.classList.add('chat-view-title-label-container');

		this.titleLabel = this.label?.appendChild(h('span.chat-view-title-label').root);

		this.updateLabel();
	}

	updateTitle(title: string): void {
		this.title = title;

		this.updateLabel();
	}

	protected override updateLabel(): void {
		if (!this.titleLabel) {
			return;
		}

		if (this.title) {
			this.titleLabel.textContent = this.title;
		} else {
			this.titleLabel.textContent = '';
		}
	}
}
