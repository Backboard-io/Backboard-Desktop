/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ISessionSidePanel, SessionView } from '../../../browser/parts/sessionView.js';
import { IActiveSession } from '../common/sessionsManagement.js';
import { IProgressIndicator } from '../../../../platform/progress/common/progress.js';
import { Event } from '../../../../base/common/event.js';

export const ISessionsPartService = createDecorator<ISessionsPartService>('sessionsPartService');

/**
 * Payload for {@link ISessionsPartService.onDidToggleMaximizeSession}.
 */
export interface IToggleMaximizeSessionEvent {
	readonly session: IActiveSession;
	/** The session view's maximized state after the toggle. */
	readonly maximized: boolean;
}

/**
 * Shape of a split sessions grid: a session id, or cells split side by side
 * (`h`) or stacked (`v`).
 */
export type SessionsGridLayout = string | { readonly split: 'h' | 'v'; readonly cells: readonly SessionsGridLayout[] };

/**
 * Payload for {@link ISessionsPartService.onDidUpdateGrid}.
 */
export interface ISessionsGridChangeEvent {
	/** Whether more than one session was visible before the update. */
	readonly wasSplit: boolean;
	/** Whether more than one session is visible after the update. */
	readonly isSplit: boolean;
	/** Ids of the sessions whose columns were not visible before (`undefined` for the placeholder). */
	readonly addedSessionIds: readonly (string | undefined)[];
	/**
	 * When the grid collapses to a single column: that column's visible side
	 * panel, if it had one. It is disposed right after the event.
	 */
	readonly collapsingSidePanel: ISessionSidePanel | undefined;
}

export interface ISessionsPartService {
	readonly _serviceBrand: undefined;

	/**
	 * Reconciles the part's grid so it renders exactly the given visible
	 * sessions (and active session). Called by the view service whenever the
	 * visible sessions or active session change. The part is a passive renderer:
	 * it does not observe the model itself.
	 */
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void;

	/**
	 * Fires with the session id of a grid slot that received keyboard focus. The
	 * view service listens to promote that session to the active session. Fires
	 * with `undefined` for the new-session placeholder only while the grid is
	 * split.
	 */
	readonly onDidFocusSession: Event<string | undefined>;

	/** Whether more than one session is visible side by side. */
	readonly isSplit: boolean;

	/** Fires after a reconciliation that leaves, enters or changes a split grid. */
	readonly onDidUpdateGrid: Event<ISessionsGridChangeEvent>;

	/**
	 * Returns the side panel of the column showing the given session (or the
	 * placeholder column for `undefined`), whether shown or hidden.
	 */
	getSidePanel(sessionId: string | undefined): ISessionSidePanel | undefined;

	/**
	 * Makes `panel` the side panel of the column showing the given session and
	 * shows it. Side panels only exist while the grid is split; the part owns
	 * the panel from now on and disposes it when its column goes away or the
	 * grid collapses (the panel is disposed right away otherwise).
	 */
	setSidePanel(sessionId: string | undefined, panel: ISessionSidePanel): void;

	/** Shows or hides a side panel previously given to {@link setSidePanel}. */
	setSidePanelVisible(panel: ISessionSidePanel, visible: boolean): void;

	isSidePanelVisible(panel: ISessionSidePanel): boolean;

	/**
	 * Arranges the next reconciliation's grid in `layout` (e.g. a 2×2 grid of
	 * chats), provided it shows exactly the sessions the layout names. Cells of
	 * sessions that stay visible are reused. Optional: grids without free-form
	 * layouts ignore it.
	 */
	setPendingLayout?(layout: SessionsGridLayout): void;

	/**
	 * Toggles the maximized state of the session view hosting the given session
	 * in the sessions part's grid.
	 */
	toggleMaximizeSession(session: IActiveSession | undefined): void;

	/**
	 * Fires after the maximized state of a session view was toggled via
	 * {@link toggleMaximizeSession}. Does not fire when the call was a no-op
	 * (e.g. the session was not visible or fewer than two views were present).
	 */
	readonly onDidToggleMaximizeSession: Event<IToggleMaximizeSessionEvent>;

	/**
	 * Moves keyboard focus into the chat input of the session view hosting the
	 * given session, or into the placeholder (new-session) view when `session`
	 * is `undefined`. No-op if no matching slot is currently mounted.
	 */
	focusSession(session: IActiveSession | undefined): void;

	/**
	 * Returns the {@link SessionView} hosting the given session id, or the
	 * placeholder (new-session) view when `sessionId` is `undefined`. Returns
	 * `undefined` if no matching slot is currently mounted in the grid.
	 */
	getSessionView(sessionId: string | undefined): SessionView | undefined;

	/**
	 * Returns the progress indicator for the sessions part, which drives the
	 * progress bar shown at the top of the part's content area.
	 */
	getProgressIndicator(): IProgressIndicator;
}
