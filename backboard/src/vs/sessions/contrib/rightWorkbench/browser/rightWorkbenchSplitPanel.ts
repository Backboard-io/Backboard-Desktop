/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionSidePanel } from '../../../browser/parts/sessionView.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, type IRightWorkbenchModeRequest, type RightWorkbenchMode } from './rightWorkbench.js';
import { IRightWorkbenchViewPaneOptions, RightWorkbenchViewPane } from './rightWorkbenchViewPane.js';

/**
 * The right panel of one column of a split sessions grid. Wraps its own
 * {@link RightWorkbenchViewPane} bound to the column's session, so every
 * visible session keeps independent tabs (review, files, browser, ...).
 */
export class RightWorkbenchSplitPanel extends Disposable implements ISessionSidePanel {

	readonly element: HTMLElement;

	private readonly session = observableValue<IActiveSession | undefined>(this, undefined);
	private readonly pane: RightWorkbenchViewPane;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
	) {
		super();

		this.element = $('.session-split-right-panel');
		// Mirrors the auxiliary bar's `> .content` wrapper so the panel's
		// stylesheets apply unchanged (see rightWorkbenchLauncher.css).
		const content = append(this.element, $('.content'));

		const options: IRightWorkbenchViewPaneOptions = {
			id: SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID,
			title: localize('rightWorkbench.splitPanel', "Right Panel"),
			splitHost: {
				session: this.session,
				reveal: () => this.sessionsPartService.setSidePanelVisible(this, true),
				hide: () => this.sessionsPartService.setSidePanelVisible(this, false),
			},
		};
		this.pane = this._register(instantiationService.createInstance(RightWorkbenchViewPane, options));
		this.pane.headerVisible = false;
		this.pane.render();
		content.appendChild(this.pane.element);
	}

	get mode(): RightWorkbenchMode {
		return this.pane.currentMode;
	}

	openMode(request: IRightWorkbenchModeRequest): Promise<void> {
		return this.pane.openModeRequest(request);
	}

	setSession(session: IActiveSession | undefined): void {
		this.session.set(session, undefined);
	}

	setVisible(visible: boolean): void {
		this.pane.setVisible(visible);
	}

	layout(width: number, height: number): void {
		this.pane.orthogonalSize = width;
		this.pane.layout(height);
	}
}

/**
 * Opens `request` in the side panel of the split grid column showing
 * `sessionId`, creating the panel on first use. Resolves once the mode was
 * applied (or immediately when the grid could not host a panel).
 */
export async function openRightWorkbenchSplitPanelMode(sessionsPartService: ISessionsPartService, instantiationService: IInstantiationService, sessionId: string | undefined, request: IRightWorkbenchModeRequest): Promise<void> {
	let panel = sessionsPartService.getSidePanel(sessionId);
	if (panel instanceof RightWorkbenchSplitPanel) {
		sessionsPartService.setSidePanelVisible(panel, true);
	} else {
		panel = instantiationService.createInstance(RightWorkbenchSplitPanel);
		sessionsPartService.setSidePanel(sessionId, panel);
		if (sessionsPartService.getSidePanel(sessionId) !== panel) {
			return; // not split anymore, or the column is gone: the part disposed it
		}
	}
	await (panel as RightWorkbenchSplitPanel).openMode(request);
}
