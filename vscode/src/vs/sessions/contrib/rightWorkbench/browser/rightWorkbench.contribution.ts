/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, RightWorkbenchCommandId, type RightWorkbenchMode, type IRightWorkbenchModeRequest, onDidRequestModeEmitter, setPendingModeRequest } from './rightWorkbench.js';
import { RightWorkbenchViewPane } from './rightWorkbenchViewPane.js';

const rightWorkbenchIcon = registerIcon('sessions-right-workbench-icon', Codicon.layoutPanelRight, localize2('sessionsRightWorkbenchIcon', 'View icon of the right workbench in the sessions window.').value);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
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

async function openRightWorkbenchMode(accessor: ServicesAccessor, request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
	const modeRequest = typeof request === 'string' ? { mode: request } : request;
	setPendingModeRequest(modeRequest);
	const layoutService = accessor.get(IWorkbenchLayoutService);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	layoutService.setPartHidden(true, Parts.EDITOR_PART);
	layoutService.setPartHidden(true, Parts.PANEL_PART);
	await accessor.get(IViewsService).openViewContainer(SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, true);
	onDidRequestModeEmitter.fire(modeRequest);
	setPendingModeRequest(undefined);
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

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'files');
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

	override async run(accessor: ServicesAccessor, urlOrOptions?: string | { url?: string }): Promise<void> {
		const browserUrl = typeof urlOrOptions === 'string' ? urlOrOptions : urlOrOptions?.url;
		await openRightWorkbenchMode(accessor, { mode: 'browser', browserUrl });
	}
});

registerAction2(class OpenRightWorkbenchTerminalAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenTerminal,
			title: localize2('rightWorkbench.openTerminal', "Open Terminal in Right Workbench"),
			icon: Codicon.terminal,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'terminal');
	}
});
