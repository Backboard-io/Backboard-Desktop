/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize, localize2 } from '../../nls.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../workbench/common/views.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionsView, SessionsViewId } from '../../sessions/contrib/sessions/browser/views/sessionsView.js';
import { ISessionsService } from '../../sessions/services/sessions/browser/sessionsService.js';
import { OPTIMUS_NEW_SESSION_COMMAND_ID } from '../browser/parts/optimusGridPart.js';
import { OptimusChatViewPane, OptimusChatViewId } from './chat/browser/optimusChatViewPane.js';

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


//#region --- right panel: chat for the active card

const optimusChatViewIcon = registerIcon('optimus-chat-icon', Codicon.commentDiscussion, localize('optimusChatViewIcon', 'Icon for the chat view in the Optimus window'));
const OPTIMUS_CHAT_VIEW_TITLE = localize2('optimus.chat.view.label', "Chat");
const OptimusChatContainerId = 'optimus.workbench.view.chatContainer';

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

registerAction2(class OptimusNewSessionAction extends Action2 {
	constructor() {
		super({
			id: OPTIMUS_NEW_SESSION_COMMAND_ID,
			title: localize2('optimus.newSession', "New Task"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ISessionsService).openNewSession();
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

		this.applyLayout();

		// The first full grid layout can re-apply sizes serialized while the
		// auxiliary bar was hidden (its default in the shared agent-sessions
		// workbench), so re-assert the Optimus layout once after it settles.
		this._register(Event.once(this.layoutService.onDidLayoutMainContainer)(() => this.applyLayout()));

		viewsService.openView(OptimusChatViewId, false).catch(() => { /* view opens lazily; ignore */ });
	}

	private applyLayout(): void {
		// Optimus always shows the sessions list (left) and the chat panel
		// (right); the editor pane and bottom panel have no place here — the
		// card grid owns the center.
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);

		// Grown from the minimum width the hidden-serialized leaf restores at.
		const targetWidth = 400;
		const currentWidth = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		if (currentWidth < targetWidth) {
			this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, targetWidth - currentWidth, 0);
		}
	}
}

registerWorkbenchContribution2(OptimusLayoutContribution.ID, OptimusLayoutContribution, WorkbenchPhase.AfterRestored);

//#endregion
