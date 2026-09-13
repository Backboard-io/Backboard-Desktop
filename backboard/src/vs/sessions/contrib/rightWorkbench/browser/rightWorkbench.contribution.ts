/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { ExtensionsViewletViewsContribution, ExtensionsViewPaneContainer } from '../../../../workbench/contrib/extensions/browser/extensionsViewlet.js';
import { VIEWLET_ID as EXTENSIONS_VIEWLET_ID } from '../../../../workbench/contrib/extensions/common/extensions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID, OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, RightWorkbenchCommandId, type RightWorkbenchMode, type IRightWorkbenchModeRequest, onDidRequestModeEmitter, setPendingModeRequest } from './rightWorkbench.js';
import { RightWorkbenchViewPane } from './rightWorkbenchViewPane.js';

const rightWorkbenchIcon = registerIcon('sessions-right-workbench-icon', Codicon.layoutPanelRight, localize2('sessionsRightWorkbenchIcon', 'View icon of the right workbench in the sessions window.').value);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

// Sessions and Optimus intentionally omit the full Editor workbench manifest,
// so its Extensions container is not registered even though the extension
// management services are available. Register the same native container and
// view descriptors here so the right-panel Extensions tool is the Editor
// surface, not a parallel custom implementation.
if (!viewContainerRegistry.get(EXTENSIONS_VIEWLET_ID)) {
	viewContainerRegistry.registerViewContainer({
		id: EXTENSIONS_VIEWLET_ID,
		title: localize2('extensions', "Extensions"),
		icon: Codicon.extensions,
		order: 4,
		ctorDescriptor: new SyncDescriptor(ExtensionsViewPaneContainer),
		rejectAddedViews: true,
		alwaysUseContainerInfo: true,
		windowEnablement: WindowEnablement.Both,
	}, ViewContainerLocation.Sidebar);
	registerWorkbenchContribution2('workbench.contrib.sessions.extensionsViewletViews', ExtensionsViewletViewsContribution, WorkbenchPhase.AfterRestored);
}

const rightWorkbenchContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID,
	title: localize2('rightWorkbench', "Right Workbench"),
	icon: rightWorkbenchIcon,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID,
	name: localize2('rightWorkbench.launcher', "Right Workbench"),
	containerIcon: rightWorkbenchIcon,
	ctorDescriptor: new SyncDescriptor(RightWorkbenchViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	windowEnablement: WindowEnablement.Sessions,
}], rightWorkbenchContainer);

// Advanced uses the same right-workbench surface as Simple, but view
// registrations are window-kind scoped. Keep a distinct Optimus registration
// and let the shared commands below select the appropriate ids at runtime.
const optimusRightWorkbenchContainer = viewContainerRegistry.registerViewContainer({
	id: OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID,
	title: localize2('optimusRightWorkbench', "Right Workbench"),
	icon: rightWorkbenchIcon,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Optimus,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID,
	name: localize2('optimusRightWorkbench.launcher', "Right Workbench"),
	containerIcon: rightWorkbenchIcon,
	ctorDescriptor: new SyncDescriptor(RightWorkbenchViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	windowEnablement: WindowEnablement.Optimus,
}], optimusRightWorkbenchContainer);

// Serialize mode requests: two rapid requests (e.g. a completion-popup click
// racing an automatic OpenBrowser) share the single pending-request slot, and
// interleaving lets the first request's cleanup null out the second's before a
// cold-constructing pane consumes it.
const modeRequestSequencer = new Sequencer();

function openRightWorkbenchMode(accessor: ServicesAccessor, request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const viewsService = accessor.get(IViewsService);
	const isOptimusWindow = accessor.get(IWorkbenchEnvironmentService).isOptimusWindow;
	const containerId = isOptimusWindow ? OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID : SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID;
	const viewId = isOptimusWindow ? OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID : SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID;
	return modeRequestSequencer.queue(async () => {
		const modeRequest = typeof request === 'string' ? { mode: request } : request;
		setPendingModeRequest(modeRequest);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		layoutService.setPartHidden(true, Parts.EDITOR_PART);
		await viewsService.openViewContainer(containerId, true);
		await viewsService.openView(viewId, true);
		onDidRequestModeEmitter.fire(modeRequest);
		setPendingModeRequest(undefined);
	});
}

registerAction2(class OpenRightWorkbenchLauncherModeAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenLauncherMode,
			title: localize2('rightWorkbench.openLauncherMode', "Open Right Workbench Launcher"),
			icon: Codicon.layoutPanelRight,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'launcher');
	}
});

registerAction2(class OpenRightWorkbenchEditorAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenEditor,
			title: localize2('rightWorkbench.openEditor', "Open Editor Chat in Right Workbench"),
			icon: Codicon.commentDiscussionSparkle,
		});
	}

	override async run(accessor: ServicesAccessor, options?: { newChat?: boolean }): Promise<void> {
		const isOptimusWindow = accessor.get(IWorkbenchEnvironmentService).isOptimusWindow;
		await openRightWorkbenchMode(accessor, { mode: 'editor', editorSidebar: isOptimusWindow ? true : undefined, newChat: options?.newChat });
	}
});

registerAction2(class OpenRightWorkbenchReviewAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenReview,
			title: localize2('rightWorkbench.openReview', "Open Review in Right Workbench"),
			icon: Codicon.diffMultiple,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'review');
	}
});

registerAction2(class OpenRightWorkbenchFilesAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenFiles,
			title: localize2('rightWorkbench.openFiles', "Open Files in Right Workbench"),
			icon: Codicon.files,
		});
	}

	override async run(accessor: ServicesAccessor, options?: { editorSidebar?: boolean }): Promise<void> {
		await openRightWorkbenchMode(accessor, { mode: 'files', editorSidebar: options?.editorSidebar });
	}
});

registerAction2(class OpenRightWorkbenchBrowserAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenBrowser,
			title: localize2('rightWorkbench.openBrowser', "Open Browser in Right Workbench"),
			icon: Codicon.globe,
		});
	}

	override async run(accessor: ServicesAccessor, urlOrOptions?: string | { url?: string; browserUrl?: string; browserViewId?: string; viewId?: string }): Promise<void> {
		const browserUrl = typeof urlOrOptions === 'string' ? urlOrOptions : urlOrOptions?.url ?? urlOrOptions?.browserUrl;
		const browserViewId = typeof urlOrOptions === 'string' ? undefined : urlOrOptions?.browserViewId ?? urlOrOptions?.viewId;
		await openRightWorkbenchMode(accessor, { mode: 'browser', browserUrl, browserViewId });
	}
});

registerAction2(class OpenRightWorkbenchTerminalAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenTerminal,
			title: localize2('rightWorkbench.openTerminal', "Open Terminal in Bottom Panel"),
			icon: Codicon.terminal,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('workbench.action.terminal.new', { location: TerminalLocation.Panel });
	}
});

registerAction2(class OpenRightWorkbenchSearchAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenSearch,
			title: localize2('rightWorkbench.openSearch', "Open Search in Right Workbench"),
			icon: Codicon.search,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'search');
	}
});

registerAction2(class OpenRightWorkbenchExtensionsAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenExtensions,
			title: localize2('rightWorkbench.openExtensions', "Open Extensions in Right Workbench"),
			icon: Codicon.extensions,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'extensions');
	}
});

registerAction2(class OpenRightWorkbenchMarketplaceAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenMarketplace,
			title: localize2('rightWorkbench.openMarketplace', "Open Marketplace in Right Workbench"),
			icon: Codicon.vm,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'marketplace');
	}
});
