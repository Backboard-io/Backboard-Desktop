/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { OPEN_BACKBOARD_WORKSPACE_COMMAND_ID } from './backboardWorkspaceConstants.js';
import { IBackboardWorkspaceService } from './backboardWorkspaceService.js';

registerAction2(class OpenBackboardWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: OPEN_BACKBOARD_WORKSPACE_COMMAND_ID,
			title: localize2('openBackboardWorkspace', "Open Advanced"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IBackboardWorkspaceService).show();
	}
});

class BackboardWorkspaceStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardWorkspaceStartup';

	constructor(
		@IBackboardWorkspaceService workspaceService: IBackboardWorkspaceService,
	) {
		super();
		void workspaceService;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	BackboardWorkspaceStartupContribution,
	LifecyclePhase.Restored,
);
