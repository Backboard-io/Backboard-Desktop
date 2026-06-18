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
		const overlay = append(workbenchContainer, $('.agent-sessions-history-modal-backdrop'));
		this._register(toDisposable(() => overlay.remove()));

		const modal = append(overlay, $('.agent-sessions-history-modal'));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-label', localize('agentSessions.historyModal.label', "Chat Session History"));

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
			}
		}));

		const header = append(modal, $('.agent-sessions-history-modal-header'));
		const title = append(header, $('span.agent-sessions-history-modal-title'));
		title.textContent = localize('agentSessions.historyModal.title', "Sessions");

		const toolbarContainer = append(header, $('.agent-sessions-history-modal-toolbar'));
		const closeButton = append(header, $('.agent-sessions-history-modal-close.codicon.codicon-close'));
		closeButton.tabIndex = 0;
		closeButton.setAttribute('role', 'button');
		closeButton.setAttribute('aria-label', localize('agentSessions.historyModal.close', "Close"));
		closeButton.title = localize('agentSessions.historyModal.close', "Close");
		this._register(addDisposableListener(closeButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.dispose();
		}));
		this._register(addDisposableListener(closeButton, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
				EventHelper.stop(e, true);
				this.dispose();
			}
		}));

		const newSessionContainer = append(modal, $('.agent-sessions-history-modal-new'));
		const newSessionButton = this._register(new Button(newSessionContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('agentSessions.historyModal.newSession', "New Session");
		this._register(newSessionButton.onDidClick(async () => {
			await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
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
