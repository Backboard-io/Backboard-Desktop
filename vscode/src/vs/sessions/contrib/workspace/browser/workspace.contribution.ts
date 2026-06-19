/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BackboardWorkspaceEditor } from './backboardWorkspaceEditor.js';
import { BackboardWorkspaceEditorInput } from './backboardWorkspaceEditorInput.js';
import { WorkspaceFolderManagementContribution } from './workspaceFolderManagement.js';

export const OPEN_BACKBOARD_WORKSPACE_COMMAND_ID = 'backboard.workspace.open';
export const OPEN_BACKBOARD_AGENTS_COMMAND_ID = 'backboard.agents.open';

const BACKBOARD_WORKSPACE_PAGE_ACTIVE_CLASS = 'backboard-workspace-page-active';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		BackboardWorkspaceEditor,
		BackboardWorkspaceEditor.ID,
		localize('backboardWorkspaceEditor', "Workspace")
	),
	[
		new SyncDescriptor(BackboardWorkspaceEditorInput)
	]
);

registerAction2(class OpenBackboardWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: OPEN_BACKBOARD_WORKSPACE_COMMAND_ID,
			title: localize2('openBackboardWorkspace', "Open Workspace"),
			category: Categories.View,
			f1: true,
			icon: Codicon.layoutPanel,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(false, Parts.EDITOR_PART);
		layoutService.mainContainer.classList.add(BACKBOARD_WORKSPACE_PAGE_ACTIVE_CLASS);
		await editorService.openEditor(BackboardWorkspaceEditorInput.instance, { pinned: true });
		layoutService.setPartHidden(true, Parts.SESSIONS_PART);
		layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		layoutService.setPartHidden(true, Parts.PANEL_PART);
	}
});

registerAction2(class OpenBackboardAgentsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_BACKBOARD_AGENTS_COMMAND_ID,
			title: localize2('openBackboardAgents', "Open Agents"),
			category: Categories.View,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.mainContainer.classList.remove(BACKBOARD_WORKSPACE_PAGE_ACTIVE_CLASS);
		layoutService.setPartHidden(false, Parts.SESSIONS_PART);
		layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		layoutService.setPartHidden(true, Parts.EDITOR_PART);
	}
});

class BackboardWorkspacePageStateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardWorkspacePageState';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));
		this.update();
	}

	override dispose(): void {
		this.layoutService.mainContainer.classList.remove(BACKBOARD_WORKSPACE_PAGE_ACTIVE_CLASS);
		super.dispose();
	}

	private update(): void {
		this.layoutService.mainContainer.classList.toggle(
			BACKBOARD_WORKSPACE_PAGE_ACTIVE_CLASS,
			this.editorService.activeEditorPane?.getId() === BackboardWorkspaceEditor.ID
		);
	}
}

registerWorkbenchContribution2(WorkspaceFolderManagementContribution.ID, WorkspaceFolderManagementContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(BackboardWorkspacePageStateContribution.ID, BackboardWorkspacePageStateContribution, WorkbenchPhase.BlockRestore);
