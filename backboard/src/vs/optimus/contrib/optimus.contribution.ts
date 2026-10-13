/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../browser/parts/media/optimusChrome.css';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow } from '../../base/browser/dom.js';
import { Codicon } from '../../base/common/codicons.js';
import { Event } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import { localize, localize2 } from '../../nls.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ViewPaneContainer } from '../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../workbench/common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionsView, SessionsViewId } from '../../sessions/contrib/sessions/browser/views/sessionsView.js';
// Shared with the agent-sessions workbench, which builds the grid at this width
// so the panel never has to be resized after the window has painted.
import { getOptimusChatPanelWidth } from '../../sessions/browser/layoutPolicy.js';
import { ISessionsManagementService } from '../../sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../sessions/services/sessions/browser/sessionsService.js';
import { RightWorkbenchCommandId } from '../../sessions/contrib/rightWorkbench/browser/rightWorkbench.js';
import { OPTIMUS_CLOSE_SESSION_COMMAND_ID, OPTIMUS_DELETE_SESSION_COMMAND_ID, OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_NEW_SESSION_COMMAND_ID, OPTIMUS_SHOW_DASHBOARD_COMMAND_ID, OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID, OPTIMUS_SHOW_FOCUSED_SESSION_CONTENT_COMMAND_ID } from '../browser/parts/optimusGridPart.js';

// Toolbar/context-menu actions used by the reused SessionsView. In the Simple
// window these are imported by its sessions.contribution; the Optimus manifest
// omits that module, so they are imported here instead.
import '../../sessions/contrib/sessions/browser/views/sessionsViewActions.js';
import '../../sessions/contrib/sessions/browser/sessionsActions.js';

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

//#region --- left sidebar: reused sessions list

const optimusSessionsViewIcon = registerIcon('optimus-sessions-icon', Codicon.commentDiscussionSparkle, localize('optimusSessionsViewIcon', 'Icon for the sessions view in the Optimus window'));
const OPTIMUS_SESSIONS_VIEW_TITLE = localize2('optimus.sessions.view.label', "Sessions");
const OptimusSessionsContainerId = 'optimus.workbench.view.sessionsContainer';

const optimusSessionsViewContainer: ViewContainer = viewContainerRegistry.registerViewContainer({
	id: OptimusSessionsContainerId,
	title: OPTIMUS_SESSIONS_VIEW_TITLE,
	icon: optimusSessionsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OptimusSessionsContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: OptimusSessionsContainerId,
	hideIfEmpty: true,
	order: 6,
	windowEnablement: WindowEnablement.Optimus
}, ViewContainerLocation.Sidebar, { isDefault: true });

const optimusSessionsViewDescriptor: IViewDescriptor = {
	id: SessionsViewId,
	containerIcon: optimusSessionsViewIcon,
	containerTitle: OPTIMUS_SESSIONS_VIEW_TITLE.value,
	singleViewPaneContainerTitle: OPTIMUS_SESSIONS_VIEW_TITLE.value,
	name: OPTIMUS_SESSIONS_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(SessionsView),
	windowEnablement: WindowEnablement.Optimus
};

viewsRegistry.registerViews([optimusSessionsViewDescriptor], optimusSessionsViewContainer);

//#endregion


const OPEN_SIMPLE_WINDOW_COMMAND_ID = 'agents.openAgentsWindow';
const OPEN_EDITOR_WINDOW_COMMAND_ID = 'agents.openSessionInVSCode';

//#region --- actions

function setOptimusRightPanelWidth(layoutService: IWorkbenchLayoutService): void {
	if (!layoutService.isVisible(Parts.AUXILIARYBAR_PART) || layoutService.isAuxiliaryBarMaximized()) {
		return;
	}

	const currentWidth = layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
	const sideBarWidth = layoutService.isVisible(Parts.SIDEBAR_PART) ? layoutService.getSize(Parts.SIDEBAR_PART).width : 0;
	const targetWidth = getOptimusChatPanelWidth(layoutService.mainContainerDimension.width, sideBarWidth);
	if (currentWidth > 0 && Math.abs(currentWidth - targetWidth) > 1) {
		layoutService.resizePart(Parts.AUXILIARYBAR_PART, targetWidth - currentWidth, 0);
	}
}

function showOptimusCenter(layoutService: IWorkbenchLayoutService): void {
	layoutService.setPartHidden(false, Parts.SESSIONS_PART);
	layoutService.setPartHidden(true, Parts.EDITOR_PART);
}

async function revealOptimusWorkspace(layoutService: IWorkbenchLayoutService, commandService: ICommandService): Promise<void> {
	showOptimusCenter(layoutService);
	// A focused task keeps the original Simple-mode workbench launcher. The
	// editor-style tool rail is reserved for the dashboard/new-task surface.
	await commandService.executeCommand(RightWorkbenchCommandId.OpenLauncherMode);
	setOptimusRightPanelWidth(layoutService);
}

async function revealOptimusEditorTools(layoutService: IWorkbenchLayoutService, commandService: ICommandService): Promise<void> {
	showOptimusCenter(layoutService);
	layoutService.setAuxiliaryBarMaximized(false);
	await commandService.executeCommand(RightWorkbenchCommandId.OpenEditor);
	setOptimusRightPanelWidth(layoutService);
}

registerAction2(class OptimusNewSessionAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_NEW_SESSION_COMMAND_ID,
			title: localize2('optimus.newSession', "New Task"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const commandService = accessor.get(ICommandService);

		// Keep the Advanced dashboard in place and reveal the same agent composer
		// used by the Editor window. New chat is a panel action, not a mode switch
		// into the Simple window.
		sessionsService.openNewSession({ forceNew: true });
		await commandService.executeCommand(RightWorkbenchCommandId.OpenEditor, { newChat: true });
	}
});

registerAction2(class OptimusFocusSessionAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_FOCUS_SESSION_COMMAND_ID,
			title: localize2('optimus.focusSession', "Focus Optimus Session"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, resource: URI | UriComponents): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const commandService = accessor.get(ICommandService);
		await sessionsService.openSession(URI.revive(resource), { preserveFocus: true });
		await commandService.executeCommand(OPTIMUS_SHOW_FOCUSED_SESSION_CONTENT_COMMAND_ID, sessionsService.activeSession.get());
		await revealOptimusWorkspace(layoutService, commandService);
	}
});

registerAction2(class OptimusShowDashboardAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_SHOW_DASHBOARD_COMMAND_ID,
			title: localize2('optimus.showDashboard', "Show Sessions Dashboard"),
			f1: false,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		accessor.get(ICommandService).executeCommand(OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID);
		layoutService.setAuxiliaryBarMaximized(false);
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		showOptimusCenter(layoutService);
	}
});

registerAction2(class OptimusCloseSessionAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_CLOSE_SESSION_COMMAND_ID,
			title: localize2('optimus.closeSession', "Close Optimus Session"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, resource: URI | UriComponents): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const session = sessionsManagementService.getSession(URI.revive(resource));
		if (session) {
			// Remove from the service's open set; the grid's persisted closed
			// set (maintained by the caller) keeps the card away.
			sessionsService.closeSession(session);
		}
	}
});

registerAction2(class OptimusDeleteSessionAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_DELETE_SESSION_COMMAND_ID,
			title: localize2('optimus.deleteSession', "Delete Optimus Session"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, resource: URI | UriComponents): Promise<void> {
		const sessionResource = URI.revive(resource);
		const sessionsService = accessor.get(ISessionsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const session = sessionsManagementService.getSession(sessionResource);
		if (!session) {
			return;
		}

		const wasActive = sessionsService.activeSession.get()?.resource.toString() === session.resource.toString();
		await sessionsManagementService.deleteSession(session);
		if (wasActive) {
			sessionsService.unsetNewSession();
			accessor.get(ICommandService).executeCommand(OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID);
			layoutService.setAuxiliaryBarMaximized(false);
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			showOptimusCenter(layoutService);
		}
	}
});

//#endregion


//#region --- layout

/**
 * Keeps the Optimus layout — board in the centre, chat docked on the right —
 * as parts come and go at runtime.
 *
 * The workbench now starts from these same defaults (see
 * `getOptimusPartVisibilityDefaults` in the sessions layout policy), so
 * `applyInitialLayout` is a no-op on a clean start and exists only to repair a
 * layout that restored wrong. That is deliberate: this contribution runs on
 * idle after `Restored`, long after the window has painted, so anything it
 * actually changes is a visible jump.
 */
class OptimusLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusLayout';
	private lastAvailableWorkspaceWidth = 0;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		this.applyInitialLayout();

		// The first full grid layout can re-apply sizes serialized while the
		// auxiliary bar was hidden (its default in the shared agent-sessions
		// workbench), so re-assert the Optimus layout once after it settles.
		this._register(Event.once(this.layoutService.onDidLayoutMainContainer)(() => this.ensureRightPanelWidth()));
		this._register(this.layoutService.onDidLayoutMainContainer(dimension => {
			const sideBarWidth = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? this.layoutService.getSize(Parts.SIDEBAR_PART).width : 0;
			const availableWorkspaceWidth = dimension.width - sideBarWidth;
			if (availableWorkspaceWidth === this.lastAvailableWorkspaceWidth) {
				return;
			}
			this.lastAvailableWorkspaceWidth = availableWorkspaceWidth;
			this.ensureRightPanelWidth();
		}));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			// Keep the board in the centre, but leave the bottom panel alone so
			// a focused chat's terminal toggle can stay open.
			if (e.partId === Parts.EDITOR_PART && e.visible) {
				this.ensureOptimusCenter();
			}
			if (e.partId === Parts.AUXILIARYBAR_PART && e.visible) {
				this.ensureRightPanelWidth();
			}
			if (e.partId === Parts.SIDEBAR_PART && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.ensureRightPanelWidth();
			}
		}));

	}

	private applyInitialLayout(): void {
		// The Advanced flow starts on the dashboard with its optional editor
		// tools panel closed.
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setAuxiliaryBarMaximized(false);
		this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.ensureOptimusCenter();
	}

	private ensureOptimusCenter(): void {
		showOptimusCenter(this.layoutService);
	}

	private ensureRightPanelWidth(): void {
		setOptimusRightPanelWidth(this.layoutService);
	}
}

registerWorkbenchContribution2(OptimusLayoutContribution.ID, OptimusLayoutContribution, WorkbenchPhase.AfterRestored);

class OptimusChromeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusChrome';

	private readonly chrome: HTMLElement;
	private readonly modeButton: HTMLElement;
	private readonly panelActions: HTMLElement;
	private readonly leftControls: HTMLElement;
	private readonly sidebarButton: HTMLButtonElement;
	private readonly secondaryButton: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.layoutService.mainContainer.querySelector('.optimus-window-chrome')?.remove();
		const chrome = $('div.optimus-window-chrome.optimus-inline-chrome');
		this.chrome = chrome;
		this._register(toDisposable(() => chrome.remove()));

		const modeButton = this.modeButton = append(chrome, $('div.backboard-mode-segments'));
		this._register(toDisposable(() => modeButton.remove()));
		modeButton.setAttribute('role', 'group');
		modeButton.setAttribute('aria-label', localize('optimusChrome.mode', "Switch Backboard mode"));
		for (const mode of [
			{ label: localize('optimusChrome.agent', "Simple"), command: OPEN_SIMPLE_WINDOW_COMMAND_ID, active: false },
			{ label: localize('optimusChrome.editor', "Editor"), command: OPEN_EDITOR_WINDOW_COMMAND_ID, active: false },
			{ label: localize('optimusChrome.advanced', "Advanced"), command: 'workbench.action.openOptimusWindow', active: true },
		]) {
			const button = append(modeButton, $('button.backboard-mode-segment'));
			button.setAttribute('type', 'button');
			button.textContent = mode.label;
			button.setAttribute('aria-pressed', String(mode.active));
			this._register(addDisposableListener(button, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				void this.commandService.executeCommand(mode.command);
			}));
		}

		this.leftControls = $('div.optimus-left-controls');
		this._register(toDisposable(() => this.leftControls.remove()));

		const actions = this.panelActions = append(chrome, $('div.optimus-window-actions'));
		this.sidebarButton = append(actions, $('button.optimus-window-chrome-button.optimus-window-chrome-sidebar.codicon'));
		this.sidebarButton.type = 'button';
		this.sidebarButton.title = localize('optimusChrome.toggleSidebar', "Toggle left panel");
		this.sidebarButton.setAttribute('aria-label', this.sidebarButton.title);

		// No view-mode button here: the dashboard's own Board / Kanban switcher is
		// the labelled control for that, and duplicating it in the chrome gave
		// two affordances for one piece of state.
		this.secondaryButton = append(actions, $('button.optimus-window-chrome-button.optimus-window-chrome-secondary.codicon')) as HTMLButtonElement;
		this.secondaryButton.type = 'button';
		this.secondaryButton.title = localize('optimusChrome.toggleRightPanel', "Toggle right panel");
		this.secondaryButton.setAttribute('aria-label', this.secondaryButton.title);
		this._register(toDisposable(() => this.sidebarButton.remove()));
		this._register(toDisposable(() => this.secondaryButton.remove()));

		this._register(addDisposableListener(this.sidebarButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.layoutService.setPartHidden(this.layoutService.isVisible(Parts.SIDEBAR_PART), Parts.SIDEBAR_PART);
		}));
		this._register(addDisposableListener(this.secondaryButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			if (this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			} else if (this.isFocusedSession()) {
				void revealOptimusWorkspace(this.layoutService, this.commandService);
			} else {
				void revealOptimusEditorTools(this.layoutService, this.commandService);
			}
		}));

		this._register(this.layoutService.onDidChangePartVisibility(() => this.updateState()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.updateState()));
		this._register(this.layoutService.onDidChangeAuxiliaryBarMaximized(() => this.updateState()));
		const dashboard = this.layoutService.mainContainer.querySelector('.optimus-grid-content');
		if (dashboard) {
			// Follow dashboard/focused navigation only, never streamed transcript DOM.
			const observer = new (getWindow(this.layoutService.mainContainer).MutationObserver)(() => this.mountControls());
			observer.observe(dashboard, { attributes: true, attributeFilter: ['class'] });
			this._register(toDisposable(() => observer.disconnect()));
		}
		const panel = this.layoutService.mainContainer.querySelector('.part.auxiliarybar');
		if (panel) {
			const observer = new (getWindow(panel).MutationObserver)(records => {
				// Reattach after tool headers are rebuilt, ignoring transcript updates.
				if (!this.secondaryButton.isConnected || records.some(record => [...record.addedNodes].some(node =>
					node.nodeType === 1 && (node as Element).matches('.sessions-right-workbench-editor-activity, .sessions-right-workbench-header')))) {
					this.mountControls();
				}
			});
			observer.observe(panel, { childList: true, subtree: true });
			this._register(toDisposable(() => observer.disconnect()));
		}
		this.updateState();
	}

	private mountControls(): void {
		const root = this.layoutService.mainContainer;
		const focused = this.isFocusedSession();
		const sidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
		const rightVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		// Focused chats already have the Simple session toolbar (environment,
		// terminal, right panel). Parking Optimus chrome there duplicated the
		// close control as a stray X on the title row.
		if (focused) {
			this.chrome.remove();
		} else {
			const target = root.querySelector('.optimus-dashboard-controls');
			if (target && this.chrome.parentElement !== target) {
				target.appendChild(this.chrome);
			}
		}
		const leftTarget = root.querySelector(focused
			? '.optimus-focused-session-header .sessions-panel-header-left'
			: '.optimus-dashboard-primary');
		if (leftTarget && this.leftControls.parentElement !== leftTarget) {
			leftTarget.prepend(this.leftControls);
		}
		this.leftControls.hidden = sidebarVisible;
		const modeTarget = sidebarVisible ? root.querySelector('.sidebar-part-header .sessions-panel-header-left') : this.leftControls;
		if (modeTarget) {
			if (this.modeButton.parentElement !== modeTarget) {
				modeTarget.appendChild(this.modeButton);
			}
		} else if (this.modeButton.parentElement !== this.chrome) {
			this.chrome.insertBefore(this.modeButton, this.panelActions);
		}
		const placePanelButton = (button: HTMLButtonElement, visible: boolean, selector: string, closeLabel: string, openLabel: string): void => {
			const header = visible ? root.querySelector(selector) : undefined;
			const destination = header ?? (button === this.sidebarButton ? this.leftControls : this.panelActions);
			if (button.parentElement !== destination) {
				destination.appendChild(button);
			}
			button.classList.toggle('optimus-panel-close', !!header);
			button.title = visible ? closeLabel : openLabel;
			button.setAttribute('aria-label', button.title);
			button.setAttribute('aria-expanded', String(visible));
		};
		placePanelButton(this.sidebarButton, sidebarVisible, '.sidebar-part-header .sessions-panel-header-right',
			localize('optimusChrome.closeLeft', "Close Left Panel"), localize('optimusChrome.openLeft', "Open Left Panel"));
		if (focused) {
			this.secondaryButton.remove();
		} else {
			placePanelButton(this.secondaryButton, rightVisible, '.part.auxiliarybar .sessions-right-workbench-editor-activity, .part.auxiliarybar .sessions-right-workbench-header',
				localize('optimusChrome.closeRight', "Close Right Panel"), localize('optimusChrome.openRight', "Open Right Panel"));
		}
		this.chrome.style.display = this.modeButton.parentElement === this.chrome || this.panelActions.childElementCount > 0 ? '' : 'none';
	}

	private updateState(): void {
		const sidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
		this.layoutService.mainContainer.classList.toggle('optimus-sidebar-hidden', !sidebarVisible);
		const sidebarWidth = sidebarVisible ? this.layoutService.getSize(Parts.SIDEBAR_PART).width : 0;
		this.chrome.style.setProperty('--optimus-sidebar-width', `${sidebarWidth}px`);
		this.chrome.classList.toggle('sidebar-visible', sidebarVisible);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left', sidebarVisible);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left-off', !sidebarVisible);
		this.sidebarButton.classList.toggle('checked', sidebarVisible);
		const rightPanelVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		const rightPanelWidth = rightPanelVisible ? this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width : 0;
		this.chrome.style.setProperty('--optimus-right-workbench-width', `${rightPanelWidth}px`);
		this.secondaryButton.classList.remove('codicon-layout-sidebar-right');
		this.secondaryButton.classList.toggle('codicon-close', rightPanelVisible);
		this.secondaryButton.classList.toggle('codicon-layout-sidebar-right-off', !rightPanelVisible);
		this.secondaryButton.classList.toggle('checked', rightPanelVisible);
		const focusedSession = this.isFocusedSession();
		this.chrome.classList.toggle('focused-session', focusedSession);
		this.mountControls();
	}

	private isFocusedSession(): boolean {
		return !!this.layoutService.mainContainer.querySelector('.optimus-grid-content.focused-session');
	}
}

// The dashboard toolbar exists at BlockRestore; mount its controls before
// idle work so switching modes does not produce a second chrome row.
registerWorkbenchContribution2(OptimusChromeContribution.ID, OptimusChromeContribution, WorkbenchPhase.BlockRestore);

//#endregion
