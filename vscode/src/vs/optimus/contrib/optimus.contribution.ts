/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../base/browser/dom.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import { localize, localize2 } from '../../nls.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { toAction } from '../../base/common/actions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
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
import { OPTIMUS_CLOSE_SESSION_COMMAND_ID, OPTIMUS_DELETE_SESSION_COMMAND_ID, OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_NEW_SESSION_COMMAND_ID, OPTIMUS_SET_SEARCH_QUERY_COMMAND_ID, OPTIMUS_SHOW_DASHBOARD_COMMAND_ID, OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID, OPTIMUS_SHOW_FOCUSED_SESSION_CONTENT_COMMAND_ID } from '../browser/parts/optimusGridPart.js';

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


// The sessions-window variants of the mode-switching commands (registered in
// sessions.desktop.contribution, which is part of the Optimus manifest). The
// editor-workbench `workbench.action.openAgentsWindow` command is gated on
// NOT being a sessions window, so it cannot be used from here. Both commands
// transform the CURRENT window in place (Simple reuses the window for the
// agents workspace; Editor opens the active session's folder in it) — mode
// switching moves one window between modes rather than juggling windows.
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
	layoutService.setPartHidden(true, Parts.PANEL_PART);
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
	await commandService.executeCommand(RightWorkbenchCommandId.OpenFiles, { editorSidebar: true });
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
			if ((e.partId === Parts.EDITOR_PART || e.partId === Parts.PANEL_PART) && e.visible) {
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
	private readonly sidebarButton: HTMLButtonElement;
	private readonly secondaryButton: HTMLButtonElement;
	private readonly backButton: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.layoutService.mainContainer.querySelector('.optimus-window-chrome')?.remove();
		const chrome = append(this.layoutService.mainContainer, $('div.optimus-window-chrome'));
		this.chrome = chrome;

		const modeButton = append(chrome, $('button.optimus-window-chrome-mode')) as HTMLButtonElement;
		modeButton.type = 'button';
		modeButton.title = localize('optimusChrome.mode', "Switch Backboard mode");
		modeButton.setAttribute('aria-haspopup', 'menu');
		modeButton.setAttribute('aria-expanded', 'false');
		append(modeButton, $('span.optimus-window-chrome-mode-icon.codicon.codicon-layout'));
		append(modeButton, $('span.optimus-window-chrome-mode-label')).textContent = localize('optimusChrome.advanced', "Advanced");
		append(modeButton, $('span.optimus-window-chrome-mode-chevron.codicon.codicon-chevron-down'));

		const navigationCluster = append(chrome, $('div.optimus-window-navigation-cluster'));
		const navigation = append(navigationCluster, $('div.optimus-window-navigation'));
		this.backButton = append(navigation, $('button.optimus-window-nav-button.codicon.codicon-arrow-left')) as HTMLButtonElement;
		this.backButton.type = 'button';
		this.backButton.setAttribute('aria-label', localize('optimusChrome.backToSessions', "Back to Sessions"));
		this._register(addDisposableListener(this.backButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.commandService.executeCommand(OPTIMUS_SHOW_DASHBOARD_COMMAND_ID);
		}));

		const commandCenter = append(navigationCluster, $('div.optimus-window-command-center'));
		append(commandCenter, $('span.codicon.codicon-search.optimus-window-command-icon'));
		const commandInput = append(commandCenter, $('input.optimus-window-command-input')) as HTMLInputElement;
		commandInput.type = 'search';
		commandInput.placeholder = localize('optimusChrome.search.placeholder', "Search sessions...");
		commandInput.setAttribute('aria-label', localize('optimusChrome.search.ariaLabel', "Search Sessions"));
		this._register(addDisposableListener(commandInput, EventType.INPUT, () => {
			this.commandService.executeCommand(OPTIMUS_SET_SEARCH_QUERY_COMMAND_ID, commandInput.value);
		}));
		const shortcuts = append(commandCenter, $('div.optimus-window-command-shortcuts'));
		append(shortcuts, $('span.optimus-window-command-key')).textContent = '⌘';
		append(shortcuts, $('span.optimus-window-command-key')).textContent = 'A';

		const actions = append(chrome, $('div.optimus-window-actions'));
		this.sidebarButton = append(actions, $('button.optimus-window-chrome-button.optimus-window-chrome-sidebar.codicon'));
		this.sidebarButton.type = 'button';
		this.sidebarButton.title = localize('optimusChrome.toggleSidebar', "Toggle left panel");
		this.sidebarButton.setAttribute('aria-label', this.sidebarButton.title);

		// No view-mode button here: the dashboard's own Board / List switcher is
		// the labelled control for that, and duplicating it in the chrome gave
		// two affordances for one piece of state.
		this.secondaryButton = append(actions, $('button.optimus-window-chrome-button.optimus-window-chrome-secondary.codicon')) as HTMLButtonElement;
		this.secondaryButton.type = 'button';
		this.secondaryButton.title = localize('optimusChrome.toggleRightPanel', "Toggle right panel");
		this.secondaryButton.setAttribute('aria-label', this.secondaryButton.title);

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
		this._register(addDisposableListener(modeButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			modeButton.setAttribute('aria-expanded', 'true');
			this.contextMenuService.showContextMenu({
				getAnchor: () => modeButton,
				// Same order as the Simple window's mode switcher menu.
				getActions: () => [
					toAction({
						id: 'optimus.mode.editor',
						label: localize('optimusChrome.editor', "Editor"),
						run: () => this.commandService.executeCommand(OPEN_EDITOR_WINDOW_COMMAND_ID),
					}),
					toAction({
						id: 'optimus.mode.advanced',
						label: localize('optimusChrome.advanced', "Advanced"),
						checked: true,
						run: () => undefined,
					}),
					toAction({
						id: 'optimus.mode.simple',
						label: localize('optimusChrome.simple', "Simple"),
						run: () => this.commandService.executeCommand(OPEN_SIMPLE_WINDOW_COMMAND_ID),
					}),
				],
				onHide: () => modeButton.setAttribute('aria-expanded', 'false'),
			});
		}));

		this._register(this.layoutService.onDidChangePartVisibility(() => this.updateState()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.updateState()));
		this._register(this.layoutService.onDidChangeAuxiliaryBarMaximized(() => this.updateState()));
		this.updateState();
	}

	private updateState(): void {
		const sidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
		const sidebarWidth = sidebarVisible ? this.layoutService.getSize(Parts.SIDEBAR_PART).width : 0;
		this.chrome.style.setProperty('--optimus-sidebar-width', `${sidebarWidth}px`);
		this.chrome.classList.toggle('sidebar-visible', sidebarVisible);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left', sidebarVisible);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left-off', !sidebarVisible);
		this.sidebarButton.classList.toggle('checked', sidebarVisible);
		const rightPanelVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		const rightPanelWidth = rightPanelVisible ? this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width : 0;
		this.chrome.style.setProperty('--optimus-right-workbench-width', `${rightPanelWidth}px`);
		this.secondaryButton.classList.toggle('codicon-layout-sidebar-right', rightPanelVisible);
		this.secondaryButton.classList.toggle('codicon-layout-sidebar-right-off', !rightPanelVisible);
		this.secondaryButton.classList.toggle('checked', rightPanelVisible);
		const focusedSession = this.isFocusedSession();
		this.chrome.classList.toggle('focused-session', focusedSession);
		this.backButton.disabled = !focusedSession;
	}

	private isFocusedSession(): boolean {
		return !!this.layoutService.mainContainer.querySelector('.optimus-grid-content.focused-session');
	}
}

// BlockRestore, not AfterRestored: the window chrome is part of the frame, not
// something loaded into it. Built on idle after `Restored` it visibly drops in
// on top of an already-painted window every time the mode is switched. It only
// touches `mainContainer` and the layout/context-key services, all of which are
// available this early.
registerWorkbenchContribution2(OptimusChromeContribution.ID, OptimusChromeContribution, WorkbenchPhase.BlockRestore);

//#endregion
