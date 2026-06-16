/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { CHANGES_VIEW_CONTAINER_ID, CHANGES_VIEW_ID } from '../../changes/common/changes.js';
import { SESSIONS_FILES_CONTAINER_ID, SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID } from '../../files/browser/filesView.js';
import { SESSIONS_PREVIEW_CONTAINER_ID, SESSIONS_PREVIEW_VIEW_ID } from '../../preview/common/preview.js';

const RIGHT_PANEL_VIEWS = new Map<string, readonly string[]>([
	[CHANGES_VIEW_CONTAINER_ID, [CHANGES_VIEW_ID]],
	[SESSIONS_FILES_CONTAINER_ID, [SESSIONS_FILES_VIEW_ID, SESSIONS_FILES_EMPTY_VIEW_ID]],
	[SESSIONS_PREVIEW_CONTAINER_ID, [SESSIONS_PREVIEW_VIEW_ID]],
]);

class SessionsRightPanelViewsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessionsRightPanelViews';

	private readonly _pendingContainers = new Set<string>();

	constructor(
		@IPaneCompositePartService private readonly _paneCompositePartService: IPaneCompositePartService,
		@IViewsService private readonly _viewsService: IViewsService,
	) {
		super();
		this._register(this._paneCompositePartService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
				this._ensureContainerView(e.composite.getId());
			}
		}));

		for (const containerId of RIGHT_PANEL_VIEWS.keys()) {
			if (this._viewsService.isViewContainerActive(containerId)) {
				this._ensureContainerView(containerId);
			}
		}
	}

	private _ensureContainerView(containerId: string): void {
		const viewIds = RIGHT_PANEL_VIEWS.get(containerId);
		if (!viewIds || this._pendingContainers.has(containerId)) {
			return;
		}

		this._pendingContainers.add(containerId);
		queueMicrotask(() => {
			void this._openFirstAvailableView(containerId, viewIds).finally(() => {
				this._pendingContainers.delete(containerId);
			});
		});
	}

	private async _openFirstAvailableView(containerId: string, viewIds: readonly string[]): Promise<void> {
		if (!this._viewsService.isViewContainerActive(containerId)) {
			return;
		}

		for (const viewId of viewIds) {
			const opened = await this._viewsService.openView(viewId, false);
			if (opened) {
				return;
			}
		}
	}
}

registerWorkbenchContribution2(SessionsRightPanelViewsContribution.ID, SessionsRightPanelViewsContribution, WorkbenchPhase.AfterRestored);
