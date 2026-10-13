/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { getClientArea } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { SessionsPart } from './sessionsPart.js';
import { MobileSessionsPart } from './mobile/mobileSessionsPart.js';
import { ISessionSidePanel, SessionView } from './sessionView.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ISessionsGridChangeEvent, ISessionsPartService, IToggleMaximizeSessionEvent, SessionsGridLayout } from '../../services/sessions/browser/sessionsPartService.js';

/**
 * Owns the lifecycle of the {@link SessionsPart}. Selects the mobile vs. desktop
 * variant based on viewport width at construction time. Registered as an eager
 * singleton so the part registers itself with the workbench layout service
 * before the workbench starts laying out parts.
 *
 * The part is a passive renderer: the {@link ISessionsService} drives the
 * grid via {@link updateVisibleSessions}/{@link focusSession} and listens to
 * {@link onDidFocusSession}. The part observes neither the model nor the view.
 */
export class SessionsParts extends Disposable implements ISessionsPartService {

	declare readonly _serviceBrand: undefined;

	private readonly _mainPart: SessionsPart;

	private readonly _onDidToggleMaximizeSession = this._register(new Emitter<IToggleMaximizeSessionEvent>());
	readonly onDidToggleMaximizeSession: Event<IToggleMaximizeSessionEvent> = this._onDidToggleMaximizeSession.event;

	get onDidFocusSession(): Event<string | undefined> {
		return this._mainPart.onDidFocusSession;
	}

	get onDidUpdateGrid(): Event<ISessionsGridChangeEvent> {
		return this._mainPart.onDidUpdateGrid;
	}

	get isSplit(): boolean {
		return this._mainPart.isSplit;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const { width } = getClientArea(mainWindow.document.body);
		const isPhoneLayout = width < 640;

		this._mainPart = this._register(instantiationService.createInstance(isPhoneLayout ? MobileSessionsPart : SessionsPart));
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this._mainPart.updateVisibleSessions(visible, active);
	}

	toggleMaximizeSession(session: IActiveSession | undefined): void {
		if (!session) {
			this._mainPart.toggleMaximizeSession(undefined);
			return;
		}
		const maximized = this._mainPart.toggleMaximizeSession(session.sessionId);
		if (maximized !== undefined) {
			this._onDidToggleMaximizeSession.fire({ session, maximized });
		}
	}

	focusSession(session: IActiveSession | undefined): void {
		this._mainPart.focusSession(session?.sessionId);
	}

	getSessionView(sessionId: string | undefined): SessionView | undefined {
		return this._mainPart.getSessionView(sessionId);
	}

	getProgressIndicator(): IProgressIndicator {
		return this._mainPart.getProgressIndicator();
	}

	getSidePanel(sessionId: string | undefined): ISessionSidePanel | undefined {
		return this._mainPart.getSidePanel(sessionId);
	}

	setSidePanel(sessionId: string | undefined, panel: ISessionSidePanel): void {
		this._mainPart.setSidePanel(sessionId, panel);
	}

	setSidePanelVisible(panel: ISessionSidePanel, visible: boolean): void {
		this._mainPart.setSidePanelVisible(panel, visible);
	}

	isSidePanelVisible(panel: ISessionSidePanel): boolean {
		return this._mainPart.isSidePanelVisible(panel);
	}

	setPendingLayout(layout: SessionsGridLayout): void {
		this._mainPart.setPendingLayout(layout);
	}
}

registerSingleton(ISessionsPartService, SessionsParts, InstantiationType.Eager);
