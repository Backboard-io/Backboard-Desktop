/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import type { ISessionSidePanel, SessionView } from '../../../sessions/browser/parts/sessionView.js';
import { ISessionsGridChangeEvent, ISessionsPartService, IToggleMaximizeSessionEvent } from '../../../sessions/services/sessions/browser/sessionsPartService.js';
import { IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { OptimusGridPart } from './optimusGridPart.js';

/**
 * {@link ISessionsPartService} implementation for the Optimus window, backed
 * by the fixed 3x2 {@link OptimusGridPart} card grid instead of the Simple
 * window's SessionsPart. Session-view specific members are inert: the grid
 * renders compact cards, not full SessionView leaves, so there is no view to
 * hand out or maximize.
 */
export class OptimusSessionsParts extends Disposable implements ISessionsPartService {

	declare readonly _serviceBrand: undefined;

	private readonly _mainPart: OptimusGridPart;

	readonly onDidToggleMaximizeSession: Event<IToggleMaximizeSessionEvent> = Event.None;

	/** The card grid is not the Simple window's split grid. */
	readonly isSplit = false;
	readonly onDidUpdateGrid: Event<ISessionsGridChangeEvent> = Event.None;

	get onDidFocusSession(): Event<string> {
		return this._mainPart.onDidFocusSession;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._mainPart = this._register(instantiationService.createInstance(OptimusGridPart));
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this._mainPart.updateVisibleSessions(visible, active);
	}

	toggleMaximizeSession(_session: IActiveSession | undefined): void {
		// Cards in the fixed grid cannot be maximized.
	}

	focusSession(session: IActiveSession | undefined): void {
		this._mainPart.focusSession(session);
	}

	getSessionView(sessionId: string | undefined): SessionView | undefined {
		return this._mainPart.getSessionView(sessionId);
	}

	getProgressIndicator(): IProgressIndicator {
		return this._mainPart.getProgressIndicator();
	}

	// Cards have no per-session side panels.

	getSidePanel(_sessionId: string | undefined): ISessionSidePanel | undefined {
		return undefined;
	}

	setSidePanel(_sessionId: string | undefined, _panel: ISessionSidePanel): void { }

	setSidePanelVisible(_panel: ISessionSidePanel, _visible: boolean): void { }

	isSidePanelVisible(_panel: ISessionSidePanel): boolean {
		return false;
	}
}

registerSingleton(ISessionsPartService, OptimusSessionsParts, InstantiationType.Eager);
