/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsHistoryModal.css';
import { $, addDisposableListener, append, DisposableResizeObserver, EventHelper, EventType, getActiveWindow } from '../../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ACTION_ID_NEW_CHAT } from '../actions/chatActions.js';
import { AgentSessionsControl } from './agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from './agentSessionsFilter.js';
import { IAgentSessionsService } from './agentSessionsService.js';
import { openSession } from './agentSessionsOpener.js';

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

MenuRegistry.appendMenuItem(AgentSessionsHistoryToolbar, {
	command: {
		id: 'agentSessionsViewer.find',
		title: localize('agentSessions.historyModal.find', "Find Agent Session"),
		icon: Codicon.search,
	},
	group: 'navigation',
	order: 2,
});

MenuRegistry.appendMenuItem(AgentSessionsHistoryToolbar, {
	submenu: AgentSessionsHistoryFilterSubMenu,
	title: localize('agentSessions.historyModal.filter', "Filter Agent Sessions"),
	group: 'navigation',
	order: 3,
	icon: Codicon.filter,
});

export class AgentSessionsHistoryModal extends Disposable {

	private control: AgentSessionsControl | undefined;
	private body: HTMLElement | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();
	}

	show(): void {
		const targetWindow = getActiveWindow();
		const workbenchContainer = this.layoutService.getContainer(targetWindow);
		const previousFocus = targetWindow.document.activeElement;
		const overlay = append(workbenchContainer, $('.agent-sessions-history-modal-backdrop'));
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
		modal.setAttribute('aria-labelledby', 'agent-sessions-history-modal-title');
		modal.setAttribute('aria-describedby', 'agent-sessions-history-modal-subtitle');

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
		title.textContent = localize('agentSessions.historyModal.title', "Chat history");
		const subtitle = append(heading, $('span.agent-sessions-history-modal-subtitle'));
		subtitle.id = 'agent-sessions-history-modal-subtitle';
		const updateSubtitle = () => {
			const count = this.agentSessionsService.model.sessions.filter(session => !session.isArchived()).length;
			subtitle.textContent = count === 1
				? localize('agentSessions.historyModal.oneConversation', "1 saved conversation")
				: localize('agentSessions.historyModal.manyConversations', "{0} saved conversations", count);
		};
		this._register(Event.runAndSubscribe(this.agentSessionsService.model.onDidChangeSessions, updateSubtitle));

		const newSessionContainer = append(header, $('.agent-sessions-history-modal-new'));
		const newSessionLabel = localize('agentSessions.historyModal.newSession', "New session");
		const newSessionButton = this._register(new Button(newSessionContainer, {
			...defaultButtonStyles,
			secondary: true,
			supportIcons: true,
			title: newSessionLabel,
			ariaLabel: newSessionLabel,
		}));
		newSessionButton.label = `$(${Codicon.add.id}) ${newSessionLabel}`;
		this._register(newSessionButton.onDidClick(async () => {
			await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
			this.dispose();
		}));

		const toolbarContainer = append(header, $('.agent-sessions-history-modal-toolbar'));
		const closeButton = append(header, $('button.agent-sessions-history-modal-close.codicon.codicon-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('agentSessions.historyModal.close', "Close"));
		closeButton.title = localize('agentSessions.historyModal.close', "Close");
		this._register(addDisposableListener(closeButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.dispose();
		}));

		this.body = append(modal, $('.agent-sessions-history-modal-body'));

		const filter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: AgentSessionsHistoryFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Capped
		}));
		const toolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, AgentSessionsHistoryToolbar, {
			menuOptions: { shouldForwardArgs: true }
		}));
		this._register(Event.runAndSubscribe(filter.onDidChange, () => {
			toolbarContainer.classList.toggle('filtered', !filter.isDefault());
		}));

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
			layout();
			this.control?.focus();
		});
		modal.focus();
	}
}
