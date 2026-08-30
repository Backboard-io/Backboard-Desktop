/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import type { SessionView } from '../../../sessions/browser/parts/sessionView.js';
import { ISessionsPartService, IToggleMaximizeSessionEvent } from '../../../sessions/services/sessions/browser/sessionsPartService.js';
import { IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { JarvisCanvasPart } from './jarvisCanvasPart.js';

/**
 * Binds the Sessions service to the unlimited Jarvis canvas. Session focus and
 * visibility stay on the shared service contract, while maximization is inert
 * because every canvas card already has independent geometry.
 */
export class JarvisSessionsParts extends Disposable implements ISessionsPartService {

	declare readonly _serviceBrand: undefined;

	private readonly mainPart: JarvisCanvasPart;

	readonly onDidToggleMaximizeSession: Event<IToggleMaximizeSessionEvent> = Event.None;

	get onDidFocusSession(): Event<string> {
		return this.mainPart.onDidFocusSession;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.mainPart = this._register(instantiationService.createInstance(JarvisCanvasPart));
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.mainPart.updateVisibleSessions(visible, active);
	}

	toggleMaximizeSession(_session: IActiveSession | undefined): void {
		// Spatial cards resize independently.
	}

	focusSession(session: IActiveSession | undefined): void {
		this.mainPart.focusSession(session);
	}

	getSessionView(_sessionId: string | undefined): SessionView | undefined {
		return this.mainPart.getSessionView(_sessionId);
	}

	getProgressIndicator(): IProgressIndicator {
		return this.mainPart.getProgressIndicator();
	}
}

registerSingleton(ISessionsPartService, JarvisSessionsParts, InstantiationType.Eager);
