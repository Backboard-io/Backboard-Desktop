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
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { localize } from '../../../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { AgentSessionsPicker } from '../../agentSessions/agentSessionsPicker.js';
import { IAgentSession } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { openSession } from '../../agentSessions/agentSessionsOpener.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

export interface IChatViewTitleDelegate {
	focusChat(): void;
	openChatSession(sessionResource: IChatModel['sessionResource']): Promise<void>;
}

export class ChatViewTitleControl extends Disposable {

	private static readonly DEFAULT_TITLE = localize('chat', "New Chat");
	private static readonly PICK_AGENT_SESSION_ACTION_ID = 'workbench.action.chat.pickAgentSession';
	private static readonly MAX_HISTORY_TABS = 40;

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

	private model: IChatModel | undefined;
	private modelDisposables = this._register(new MutableDisposable());

	private navigationToolbar?: MenuWorkbenchToolBar;
	private actionsToolbar?: MenuWorkbenchToolBar;
	private activeTabLabel: HTMLElement | undefined;
	private tabsContainer: HTMLElement | undefined;
	private tabDisposables = this._register(new DisposableStore());
	private readonly closedSessionTabs = new Set<string>();
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
	}

	private render(parent: HTMLElement): void {
		const elements = h('div.chat-view-title-container', [
			h('div.chat-view-title-inner', [
				h('div.chat-view-title-tabs@tabsContainer'),
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
		this.updateTitle(ChatViewTitleControl.DEFAULT_TITLE);
	}

	update(model: IChatModel | undefined): void {
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
			this.activeTabLabel.textContent = title;
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
			&& !this.agentSessionsService.model.sessions.some(session => session.resource.toString() === previousSessionResourceKey)
		) {
			const index = this.tabOrder.indexOf(previousSessionResourceKey);
			if (index !== -1) {
				this.tabOrder[index] = currentSessionResourceKey;
			}
			this.openSessionTabs.delete(previousSessionResourceKey);
		}

		if (currentSessionResource && currentSessionResourceKey && !this.closedSessionTabs.has(currentSessionResourceKey)) {
			this.openSessionTabs.set(currentSessionResourceKey, { resource: currentSessionResource, label: currentTitle });
		}

		const sessions = this.getHistoryTabSessions();
		for (const session of sessions) {
			const resourceKey = session.resource.toString();
			if (!this.tabOrder.includes(resourceKey)) {
				this.tabOrder.push(resourceKey);
			}
		}

		const sessionsByResource = new Map(sessions.map(session => [session.resource.toString(), session]));
		const knownSessionResources = new Set(this.agentSessionsService.model.sessions.map(session => session.resource.toString()));
		this.tabOrder = this.tabOrder.filter(resourceKey => {
			return !this.closedSessionTabs.has(resourceKey)
				&& (
					sessionsByResource.has(resourceKey) ||
					(this.openSessionTabs.has(resourceKey) && !knownSessionResources.has(resourceKey))
				);
		});
		if (currentSessionResourceKey && !this.tabOrder.includes(currentSessionResourceKey)) {
			this.tabOrder.unshift(currentSessionResourceKey);
		}

		for (const resourceKey of this.tabOrder.slice(0, ChatViewTitleControl.MAX_HISTORY_TABS)) {
			const session = sessionsByResource.get(resourceKey);
			const tab = this.openSessionTabs.get(resourceKey);
			if (!session && !tab) {
				continue;
			}
			const isCurrent = resourceKey === currentSessionResourceKey;
			this.addTab({
				label: isCurrent ? currentTitle : (session?.label ?? tab?.label ?? ChatViewTitleControl.DEFAULT_TITLE),
				active: isCurrent,
				isCurrent,
				// The current tab shows the "new session" icon until it has a response;
				// every other (history) tab necessarily already has one.
				isNew: isCurrent && (!this.model || this.model.getRequests().length === 0),
				session,
				sessionResource: session ? undefined : tab?.resource,
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

	private getHistoryTabSessions(): IAgentSession[] {
		return this.agentSessionsService.model.sessions
			.filter(session => !session.isArchived())
			.filter(session => !this.closedSessionTabs.has(session.resource.toString()))
			.sort((a, b) => this.getHistoryTabTime(b) - this.getHistoryTabTime(a) || a.label.localeCompare(b.label))
			.slice(0, ChatViewTitleControl.MAX_HISTORY_TABS);
	}

	private getHistoryTabTime(session: IAgentSession): number {
		return session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created;
	}

	private addTab(options: { label: string; active: boolean; isCurrent?: boolean; isNew?: boolean; session?: IAgentSession; sessionResource?: IChatModel['sessionResource'] }): void {
		if (!this.tabsContainer) {
			return;
		}

		const label = options.label.trim() || ChatViewTitleControl.DEFAULT_TITLE;
		const tabElements = h('div.chat-view-title-tab@root', { role: 'button', tabIndex: 0, title: label }, [
			h('span.chat-view-title-tab-icon@icon'),
			h('span.chat-view-title-tab-label@label'),
			h('span.codicon.codicon-close.chat-view-title-tab-close@close', { role: 'button', title: localize('chat.closeSessionTab', "Close Tab"), ariaLabel: localize('chat.closeSessionTab', "Close Tab") }),
		]);
		// Not-yet-responded-to sessions show the Backboard mark; sessions with at
		// least one response show a chat bubble.
		tabElements.icon.classList.add(...ThemeIcon.asClassNameArray(options.isNew ? ThemeIcon.fromId('backboard-logo') : Codicon.comment));
		tabElements.label.textContent = label;
		const tab = tabElements.root;
		tab.classList.toggle('chat-view-title-tab-active', options.active);

		if (options.active) {
			this.activeTabLabel = tabElements.label;
		}

		this.tabsContainer.appendChild(tab);
		this.tabDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			if (options.session) {
				void this.instantiationService.invokeFunction(openSession, options.session);
			} else if (options.sessionResource) {
				void this.delegate.openChatSession(options.sessionResource);
			} else {
				this.delegate.focusChat();
			}
		}));

		this.tabDisposables.add(addDisposableListener(tabElements.close, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			if (options.session) {
				this.closedSessionTabs.add(options.session.resource.toString());
			} else if (options.sessionResource) {
				const resourceKey = options.sessionResource.toString();
				this.closedSessionTabs.add(resourceKey);
				this.openSessionTabs.delete(resourceKey);
			}
			this.updateTabs(this.getResolvedTitle());
		}));
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
