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
import { IStorageService, StorageScope } from '../../platform/storage/common/storage.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { ViewPaneContainer } from '../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../workbench/common/views.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { SessionsView, SessionsViewId } from '../../sessions/contrib/sessions/browser/views/sessionsView.js';
import { ISessionsManagementService } from '../../sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../sessions/services/sessions/browser/sessionsService.js';
import { collectOptimusFolderCandidates } from '../common/optimusSessions.js';
import { OPTIMUS_DELETE_SESSION_COMMAND_ID, OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_NEW_SESSION_COMMAND_ID } from '../browser/parts/optimusGridPart.js';
import { OptimusChatViewPane, OptimusChatViewId } from './chat/browser/optimusChatViewPane.js';
import { IPathService } from '../../workbench/services/path/common/pathService.js';
import { SessionType } from '../../workbench/contrib/chat/common/chatSessionsService.js';

// Toolbar/context-menu actions used by the reused SessionsView. In the Simple
// window these are imported by its sessions.contribution; the Optimus manifest
// omits that module, so they are imported here instead.
import '../../sessions/contrib/sessions/browser/views/sessionsViewActions.js';
import '../../sessions/contrib/sessions/browser/sessionsActions.js';

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
const RECENT_WORKSPACES_STORAGE_KEY = 'sessions.recentlyPickedWorkspaces';

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


//#region --- right panel: chat for the active card

const optimusChatViewIcon = registerIcon('optimus-chat-icon', Codicon.commentDiscussion, localize('optimusChatViewIcon', 'Icon for the chat view in the Optimus window'));
const OPTIMUS_CHAT_VIEW_TITLE = localize2('optimus.chat.view.label', "Chat");
const OptimusChatContainerId = 'optimus.workbench.view.chatContainer';
const OPTIMUS_CHAT_PANEL_WIDTH = 400;
// The sessions-window variants of the mode-switching commands (registered in
// sessions.desktop.contribution, which is part of the Optimus manifest). The
// editor-workbench `workbench.action.openAgentsWindow` command is gated on
// NOT being a sessions window, so it cannot be used from here. The Optimus
// window cannot be transformed into an editor window, so Editor mode opens
// in a new window instead of reusing this one.
const OPEN_SIMPLE_WINDOW_COMMAND_ID = 'agents.openAgentsWindow';
const OPEN_EDITOR_WINDOW_COMMAND_ID = 'agents.openSessionInVSCodeNewWindow';

const optimusChatViewContainer: ViewContainer = viewContainerRegistry.registerViewContainer({
	id: OptimusChatContainerId,
	title: OPTIMUS_CHAT_VIEW_TITLE,
	icon: optimusChatViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OptimusChatContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: OptimusChatContainerId,
	hideIfEmpty: false,
	order: 1,
	windowEnablement: WindowEnablement.Optimus
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

const optimusChatViewDescriptor: IViewDescriptor = {
	id: OptimusChatViewId,
	containerIcon: optimusChatViewIcon,
	containerTitle: OPTIMUS_CHAT_VIEW_TITLE.value,
	singleViewPaneContainerTitle: OPTIMUS_CHAT_VIEW_TITLE.value,
	name: OPTIMUS_CHAT_VIEW_TITLE,
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(OptimusChatViewPane),
	windowEnablement: WindowEnablement.Optimus
};

viewsRegistry.registerViews([optimusChatViewDescriptor], optimusChatViewContainer);

//#endregion


//#region --- actions

function setOptimusChatPanelWidth(layoutService: IWorkbenchLayoutService): void {
	if (!layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
		return;
	}

	const currentWidth = layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
	if (currentWidth > 0 && currentWidth !== OPTIMUS_CHAT_PANEL_WIDTH) {
		layoutService.resizePart(Parts.AUXILIARYBAR_PART, OPTIMUS_CHAT_PANEL_WIDTH - currentWidth, 0);
	}
}

function showOptimusCenter(layoutService: IWorkbenchLayoutService): void {
	layoutService.setPartHidden(false, Parts.SESSIONS_PART);
	layoutService.setPartHidden(true, Parts.EDITOR_PART);
	layoutService.setPartHidden(true, Parts.PANEL_PART);
}

// Takes resolved services rather than a ServicesAccessor: callers invoke this
// after awaiting other work, and accessors are only valid synchronously
// during the action's run invocation.
async function revealOptimusChatPanel(layoutService: IWorkbenchLayoutService, viewsService: IViewsService, focus: boolean): Promise<unknown> {
	showOptimusCenter(layoutService);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	setOptimusChatPanelWidth(layoutService);

	return viewsService.openView(OptimusChatViewId, focus);
}

async function getPreferredOptimusFolderUri(accessor: ServicesAccessor): Promise<URI | undefined> {
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const storageService = accessor.get(IStorageService);
	const pathService = accessor.get(IPathService);

	const recentWorkspaces: URI[] = [];

	try {
		const rawRecentWorkspaces = storageService.get(RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
		if (rawRecentWorkspaces) {
			const parsed = JSON.parse(rawRecentWorkspaces) as Array<{ readonly uri?: UriComponents }>;
			for (const entry of parsed) {
				if (entry.uri) {
					recentWorkspaces.push(URI.revive(entry.uri));
				}
			}
		}
	} catch {
		// Ignore malformed recent-workspace storage and continue with other fallbacks.
	}

	const candidates = collectOptimusFolderCandidates(
		sessionsService.activeSession.get(),
		workspaceContextService.getWorkspace().folders.map(folder => folder.uri),
		recentWorkspaces,
		sessionsManagementService.getSessions(),
	);

	for (const candidate of candidates) {
		if (candidate && sessionsManagementService.resolveWorkspace(candidate)) {
			return candidate;
		}
	}

	const userHome = pathService.userHome({ preferLocal: true });
	if (sessionsManagementService.resolveWorkspace(userHome)) {
		return userHome;
	}

	return undefined;
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
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const viewsService = accessor.get(IViewsService);
		const folderUri = await getPreferredOptimusFolderUri(accessor);
		if (!folderUri) {
			throw new Error('Unable to create an Optimus task because no session provider can resolve a workspace folder.');
		}

		const backboardType = sessionsManagementService.getSessionTypesForFolder(folderUri).find(candidate =>
			candidate.sessionType.id === 'backboard' ||
			`agent-host-${candidate.sessionType.id}` === SessionType.AgentHostBackboard ||
			candidate.sessionType.id === SessionType.AgentHostBackboard
		);

		sessionsService.openNewSession({
			folderUri,
			forceNew: true,
			providerId: backboardType?.providerId,
			sessionTypeId: backboardType?.sessionType.id,
		});

		await revealOptimusChatPanel(layoutService, viewsService, true);
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
		const viewsService = accessor.get(IViewsService);
		await sessionsService.openSession(URI.revive(resource), { preserveFocus: true });
		await revealOptimusChatPanel(layoutService, viewsService, true);
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
		const viewsService = accessor.get(IViewsService);
		const session = sessionsManagementService.getSession(sessionResource);
		if (!session) {
			return;
		}

		const wasActive = sessionsService.activeSession.get()?.resource.toString() === session.resource.toString();
		await sessionsManagementService.deleteSession(session);
		if (wasActive) {
			sessionsService.unsetNewSession();
			await revealOptimusChatPanel(layoutService, viewsService, false);
		}
	}
});

//#endregion


//#region --- layout

/**
 * The agent-sessions workbench hides the auxiliary bar by default (it opens
 * on demand in the Simple window). Optimus's right chat panel lives there and
 * should always be visible, so unhide it once the workbench has restored.
 */
class OptimusLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusLayout';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService viewsService: IViewsService,
	) {
		super();

		this.applyInitialLayout();

		// The first full grid layout can re-apply sizes serialized while the
		// auxiliary bar was hidden (its default in the shared agent-sessions
		// workbench), so re-assert the Optimus layout once after it settles.
		this._register(Event.once(this.layoutService.onDidLayoutMainContainer)(() => this.ensureRightPanelWidth()));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if ((e.partId === Parts.EDITOR_PART || e.partId === Parts.PANEL_PART) && e.visible) {
				this.ensureOptimusCenter();
			}
			if (e.partId === Parts.AUXILIARYBAR_PART && e.visible) {
				this.ensureRightPanelWidth();
			}
		}));

		viewsService.openView(OptimusChatViewId, false).catch(() => { /* view opens lazily; ignore */ });
	}

	private applyInitialLayout(): void {
		// Optimus starts with both side panels visible, but after startup each
		// panel is user-controlled through Optimus's own chrome buttons.
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.ensureOptimusCenter();
		this.ensureRightPanelWidth();
	}

	private ensureOptimusCenter(): void {
		showOptimusCenter(this.layoutService);
	}

	private ensureRightPanelWidth(): void {
		setOptimusChatPanelWidth(this.layoutService);
	}
}

registerWorkbenchContribution2(OptimusLayoutContribution.ID, OptimusLayoutContribution, WorkbenchPhase.AfterRestored);

class OptimusChromeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusChrome';

	private readonly sidebarButton: HTMLButtonElement;
	private readonly secondaryButton: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.layoutService.mainContainer.querySelector('.optimus-window-chrome')?.remove();
		const chrome = append(this.layoutService.mainContainer, $('div.optimus-window-chrome'));

		const modeButton = append(chrome, $('button.optimus-window-chrome-mode'));
		modeButton.title = localize('optimusChrome.mode', "Switch Backboard mode");
		modeButton.setAttribute('aria-haspopup', 'menu');
		modeButton.setAttribute('aria-expanded', 'false');
		append(modeButton, $('span.optimus-window-chrome-mode-icon.codicon.codicon-layout'));
		append(modeButton, $('span.optimus-window-chrome-mode-label')).textContent = localize('optimusChrome.advanced', "Advanced");
		append(modeButton, $('span.optimus-window-chrome-mode-chevron.codicon.codicon-chevron-down'));

		this.sidebarButton = append(chrome, $('button.optimus-window-chrome-button.optimus-window-chrome-sidebar.codicon'));
		this.sidebarButton.title = localize('optimusChrome.toggleSidebar', "Toggle left panel");
		this.sidebarButton.setAttribute('aria-label', this.sidebarButton.title);

		this.secondaryButton = append(chrome, $('button.optimus-window-chrome-button.optimus-window-chrome-secondary.codicon'));
		this.secondaryButton.title = localize('optimusChrome.toggleRightPanel', "Toggle right panel");
		this.secondaryButton.setAttribute('aria-label', this.secondaryButton.title);

		this._register(addDisposableListener(this.sidebarButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.layoutService.setPartHidden(this.layoutService.isVisible(Parts.SIDEBAR_PART), Parts.SIDEBAR_PART);
		}));
		this._register(addDisposableListener(this.secondaryButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.layoutService.setPartHidden(this.layoutService.isVisible(Parts.AUXILIARYBAR_PART), Parts.AUXILIARYBAR_PART);
			if (this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				setOptimusChatPanelWidth(this.layoutService);
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
		this.updateState();
	}

	private updateState(): void {
		const sidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left', sidebarVisible);
		this.sidebarButton.classList.toggle('codicon-layout-sidebar-left-off', !sidebarVisible);
		this.sidebarButton.classList.toggle('checked', sidebarVisible);

		const secondaryVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		this.secondaryButton.classList.toggle('codicon-layout-sidebar-right', secondaryVisible);
		this.secondaryButton.classList.toggle('codicon-layout-sidebar-right-off', !secondaryVisible);
		this.secondaryButton.classList.toggle('checked', secondaryVisible);
	}
}

registerWorkbenchContribution2(OptimusChromeContribution.ID, OptimusChromeContribution, WorkbenchPhase.AfterRestored);

//#endregion
