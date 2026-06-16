/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { SESSIONS_FILES_CONTAINER_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerView } from './filesView.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ActiveSessionHasGitRepositoryContext, ActiveSessionHasGitSyncActionRunningContext, IsNewChatSessionContext, IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export { SESSIONS_FILES_CONTAINER_ID } from './filesView.js';

const filesViewIcon = registerIcon('sessions-files-view-icon', Codicon.files, localize2('sessionsFilesViewIcon', 'View icon of the files view in the sessions window.').value);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

// Files view container
const filesViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_FILES_CONTAINER_ID,
	title: localize2('files', "Files"),
	icon: filesViewIcon,
	order: 11,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_FILES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_FILES_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_FILES_CONTAINER_ID,
		title: localize2('explore', "Explorer"),
		mnemonicTitle: localize({ key: 'miFiles', comment: ['&& denotes a mnemonic'] }, "Fil&&es"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE },
		order: 0
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: SESSIONS_FILES_VIEW_ID,
	name: localize2('files', "Files"),
	containerIcon: filesViewIcon,
	ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
	canToggleVisibility: false,
	canMoveView: false,
	when: IsPhoneLayoutContext.negate(),
	windowEnablement: WindowEnablement.Sessions,
}], filesViewContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.syncChanges',
			title: localize2('syncChanges', "Sync Changes"),
			icon: Codicon.sync,
			precondition: ActiveSessionHasGitSyncActionRunningContext.negate(),
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext,
					IsNewChatSessionContext,
					ActiveSessionHasGitRepositoryContext,
					ContextKeyExpr.equals('view', SESSIONS_FILES_VIEW_ID),
				)
			},
		});
	}

	async run(accessor: ServicesAccessor) {
		const commandService = accessor.get(ICommandService);
		const contextKeyService = accessor.get(IContextKeyService);
		const contextService = accessor.get(IWorkspaceContextService);

		const workspaceFolder = contextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			return;
		}

		const isSyncActionRunning = ActiveSessionHasGitSyncActionRunningContext.bindTo(contextKeyService);
		isSyncActionRunning.set(true);

		try {
			await commandService.executeCommand('git.sync', workspaceFolder.uri);
		} finally {
			isSyncActionRunning.set(false);
		}
	}
});
