/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsViewService } from '../../../browser/sessionsViewService.js';
import { ISandboxPreviewService, SESSIONS_PREVIEW_CONTAINER_ID, SESSIONS_PREVIEW_VIEW_ID } from '../common/preview.js';
import { SandboxPreviewViewPane } from './previewView.js';

interface IPendingPreviewDetection {
	readonly submittedAt: number;
}

const previewViewIcon = registerIcon('sessions-preview-view-icon', Codicon.preview, localize2('sessionsPreviewViewIcon', 'View icon for the Preview view in the sessions window.').value);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const previewViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_PREVIEW_CONTAINER_ID,
	title: localize2('preview', "Preview"),
	icon: previewViewIcon,
	order: 12,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_PREVIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_PREVIEW_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_PREVIEW_CONTAINER_ID,
		title: localize2('preview', "Preview"),
		mnemonicTitle: localize({ key: 'miPreview', comment: ['&& denotes a mnemonic'] }, "Pre&&view"),
		order: 2,
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: SESSIONS_PREVIEW_VIEW_ID,
	name: localize2('preview', "Preview"),
	containerIcon: previewViewIcon,
	ctorDescriptor: new SyncDescriptor(SandboxPreviewViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	weight: 100,
	order: 1,
	windowEnablement: WindowEnablement.Sessions,
}], previewViewContainer);

class SandboxPreviewAutoDetectContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sandboxPreviewAutoDetect';

	private readonly _pendingByResource = new ResourceMap<IPendingPreviewDetection>();
	private readonly _lastDetectionByResource = new ResourceMap<number>();

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsViewService private readonly _sessionsViewService: ISessionsViewService,
		@IChatService private readonly _chatService: IChatService,
		@ISandboxPreviewService private readonly _previewService: ISandboxPreviewService,
	) {
		super();

		const multipleSessionsVisibleObs = derived(reader => this._sessionsViewService.visibleSessions.read(reader).length > 1);

		this._register(this._chatService.onDidSubmitRequest(({ chatSessionResource }) => {
			if (multipleSessionsVisibleObs.get()) {
				return;
			}
			this._pendingByResource.set(chatSessionResource, { submittedAt: Date.now() });
		}));

		this._register(autorun(reader => {
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			if (!activeSession || multipleSessionsVisibleObs.read(reader)) {
				return;
			}

			const pending = this._pendingByResource.get(activeSession.resource);
			const lastTurnEnd = activeSession.lastTurnEnd.read(reader);
			activeSession.changes.read(reader);
			if (!lastTurnEnd) {
				return;
			}

			const detectionStamp = lastTurnEnd.getTime();
			if (pending && detectionStamp < pending.submittedAt) {
				return;
			}
			if (this._lastDetectionByResource.get(activeSession.resource) === detectionStamp) {
				return;
			}

			this._pendingByResource.delete(activeSession.resource);
			this._lastDetectionByResource.set(activeSession.resource, detectionStamp);

			void this._previewService.prepare(activeSession).catch(error => {
				this._previewService.fail(activeSession, error);
			});
		}));
	}
}

registerWorkbenchContribution2(SandboxPreviewAutoDetectContribution.ID, SandboxPreviewAutoDetectContribution, WorkbenchPhase.AfterRestored);
