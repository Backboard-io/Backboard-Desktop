/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsHistoryModal.css';
import { $, addDisposableListener, append, DisposableResizeObserver, EventHelper, EventType, getActiveWindow } from '../../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ACTION_ID_NEW_CHAT } from '../actions/chatActions.js';
import { IChatWidgetService } from '../chat.js';
import { AgentSessionsControl } from './agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping, AgentSessionsSorting } from './agentSessionsFilter.js';
import { IAgentSessionsService } from './agentSessionsService.js';
import { openSession } from './agentSessionsOpener.js';
import { isSubscriptionAgentSessionProvider } from './agentSessions.js';

const AgentSessionsHistoryToolbar = new MenuId('AgentSessionsHistoryToolbar');
const AgentSessionsHistoryFilterSubMenu = new MenuId('AgentSessionsHistoryFilterSubMenu');

MenuRegistry.appendMenuItem(AgentSessionsHistoryToolbar, {
	command: {
		id: 'agentSessionsViewer.refresh',
		title: localize('agentSessions.historyModal.refresh', "Refresh Agent Sessions"),
		icon: Codicon.refresh,
	},
	group: 'navigation',
	order: 1,
});

export class AgentSessionsHistoryModal extends Disposable {

	private control: AgentSessionsControl | undefined;
	private body: HTMLElement | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();
	}

	show(options?: { readonly excludeSubscriptionSessions?: boolean; readonly chatContainer?: HTMLElement; readonly openSession?: (resource: URI) => Promise<void> }): void {
		const excludeSubscriptionSessions = options?.excludeSubscriptionSessions === true;
		const targetWindow = getActiveWindow();
		const activeChatWidget = this.chatWidgetService.lastFocusedWidget;
		const chatContainer = options?.chatContainer ?? (activeChatWidget?.domNode.isConnected && activeChatWidget.domNode.ownerDocument.defaultView === targetWindow
			? activeChatWidget.domNode
			: undefined);
		const modalHost = chatContainer ?? this.layoutService.getContainer(targetWindow);
		const previousFocus = targetWindow.document.activeElement;
		const overlay = append(modalHost, $('.agent-sessions-history-modal-backdrop'));
		overlay.classList.toggle('agent-sessions-history-modal-chat-surface', !!chatContainer);
		this._register(toDisposable(() => {
			overlay.remove();
			if (previousFocus instanceof targetWindow.HTMLElement && previousFocus.isConnected) {
				previousFocus.focus();
			}
		}));

		const modal = append(overlay, $('.agent-sessions-history-modal'));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-label', localize('agentSessions.historyModal.title', "Chats"));

		this._register(addDisposableListener(overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === overlay) {
				EventHelper.stop(e, true);
				this.dispose();
			}
		}));
		this._register(addDisposableListener(targetWindow, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				EventHelper.stop(e, true);
				this.dispose();
			} else if (event.keyCode === KeyCode.Tab) {
				const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
					.filter(element => element.offsetParent !== null);
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				const activeElement = targetWindow.document.activeElement;
				if (!first || !last) {
					EventHelper.stop(e, true);
					modal.focus();
				} else if (event.shiftKey && (activeElement === first || activeElement === modal)) {
					EventHelper.stop(e, true);
					last.focus();
				} else if (!event.shiftKey && activeElement === last) {
					EventHelper.stop(e, true);
					first.focus();
				}
			}
		}));

		const header = append(modal, $('.agent-sessions-history-modal-header'));
		const heading = append(header, $('.agent-sessions-history-modal-heading'));
		const title = append(heading, $('span.agent-sessions-history-modal-title'));
		title.id = 'agent-sessions-history-modal-title';
		title.textContent = localize('agentSessions.historyModal.title', "Chats");

		const toolbarContainer = append(header, $('.agent-sessions-history-modal-toolbar'));
		const newSessionLabel = localize('agentSessions.historyModal.newSession', "New chat");
		const newSessionButton = append(header, $('button.agent-sessions-history-modal-icon-button.codicon.codicon-edit')) as HTMLButtonElement;
		newSessionButton.type = 'button';
		newSessionButton.setAttribute('aria-label', newSessionLabel);
		newSessionButton.title = newSessionLabel;
		this._register(addDisposableListener(newSessionButton, EventType.CLICK, async e => {
			EventHelper.stop(e, true);
			await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
			this.dispose();
		}));

		const closeButton = append(header, $('button.agent-sessions-history-modal-icon-button.agent-sessions-history-modal-close.codicon.codicon-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('agentSessions.historyModal.close', "Close"));
		closeButton.title = localize('agentSessions.historyModal.close', "Close");
		this._register(addDisposableListener(closeButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.dispose();
		}));

		const panel = append(modal, $('.agent-sessions-history-modal-panel'));
		const search = append(panel, $('.agent-sessions-history-modal-search'));
		const searchIcon = append(search, $('span.agent-sessions-history-modal-search-icon.codicon.codicon-search'));
		searchIcon.setAttribute('aria-hidden', 'true');
		const searchWidgetContainer = append(search, $('.agent-sessions-history-modal-search-widget'));
		this.body = append(panel, $('.agent-sessions-history-modal-body'));

		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: AgentSessionsHistoryFilterSubMenu,
			sortResults: () => options?.openSession ? AgentSessionsSorting.Updated : undefined,
			groupResults: () => options?.openSession ? AgentSessionsGrouping.Date : AgentSessionsGrouping.Capped,
			overrideExclude: session => excludeSubscriptionSessions && isSubscriptionAgentSessionProvider(session.providerType) ? true : undefined,
		}));
		const toolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, AgentSessionsHistoryToolbar, {
			menuOptions: { shouldForwardArgs: true }
		}));

		this.control = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.body, {
			source: 'chatHistoryModal',
			filter,
			overrideStyles: {},
			getHoverPosition: () => HoverPosition.RIGHT,
			trackActiveEditorSession: () => false,
			collapseOlderSections: () => !options?.openSession,
			hideSectionCount: true,
			hideSessionBadge: true,
			compactShowMore: true,
			compactRows: true,
			showDiffFileCount: false,
			findWidgetContainer: searchWidgetContainer,
			overrideSessionOpen: async (resource, openOptions) => {
				if (options?.openSession) {
					await options.openSession(resource);
					this.dispose();
					return;
				}
				const session = this.agentSessionsService.model.getSession(resource);
				if (session) {
					await this.instantiationService.invokeFunction(openSession, session, openOptions);
					this.dispose();
				}
			},
		}));
		toolbar.context = this.control;

		const layout = () => {
			if (!this.body || !this.control) {
				return;
			}
			this.control.layout(this.body.clientHeight, this.body.clientWidth);
		};

		this._register(addDisposableListener(targetWindow, EventType.RESIZE, layout));
		const resizeObserver = this._register(new DisposableResizeObserver('AgentSessionsHistoryModal', layout));
		resizeObserver.observe(this.body);

		targetWindow.requestAnimationFrame(() => {
			this.control?.openFind();
			const searchInput = searchWidgetContainer.querySelector<HTMLInputElement>('input');
			if (searchInput) {
				const searchLabel = localize('agentSessions.historyModal.search', "Search recent chats");
				searchInput.placeholder = searchLabel;
				searchInput.setAttribute('aria-label', searchLabel);
			}
			layout();
			searchInput?.focus();
		});
		modal.focus();
	}
}
