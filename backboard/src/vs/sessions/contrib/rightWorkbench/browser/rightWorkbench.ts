/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { IObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';

export const SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.rightWorkbenchContainer';
export const SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID = 'sessions.rightWorkbench.launcherView';
export const OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID = 'workbench.optimus.auxiliaryBar.rightWorkbenchContainer';
export const OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID = 'optimus.rightWorkbench.launcherView';
/** Resolves when a hosted media URL was uploaded (desktop only: it needs a request without CORS). */
export const CANVAS_HOSTED_MEDIA_TIME_COMMAND_ID = '_sessions.canvas.hostedMediaTime';

export const enum RightWorkbenchCommandId {
	OpenLauncher = 'workbench.action.sessions.rightWorkbench.openLauncher',
	OpenLauncherMode = 'workbench.action.sessions.rightWorkbench.openLauncherMode',
	OpenEditor = 'workbench.action.sessions.rightWorkbench.openEditor',
	OpenReview = 'workbench.action.sessions.rightWorkbench.openReview',
	OpenCanvas = 'workbench.action.sessions.rightWorkbench.openCanvas',
	OpenFiles = 'workbench.action.sessions.rightWorkbench.openFiles',
	OpenBrowser = 'workbench.action.sessions.rightWorkbench.openBrowser',
	OpenTerminal = 'workbench.action.sessions.rightWorkbench.openTerminal',
	OpenSearch = 'workbench.action.sessions.rightWorkbench.openSearch',
	OpenExtensions = 'workbench.action.sessions.rightWorkbench.openExtensions',
	OpenMarketplace = 'workbench.action.sessions.rightWorkbench.openMarketplace',
}

export type RightWorkbenchMode = 'launcher' | 'editor' | 'review' | 'browser' | 'files' | 'terminal' | 'search' | 'extensions' | 'marketplace';

export const orderedTabModes: readonly RightWorkbenchMode[] = ['editor', 'files', 'search', 'review', 'extensions', 'marketplace', 'browser', 'terminal'];

export interface IRightWorkbenchModeRequest {
	readonly mode: RightWorkbenchMode;
	readonly browserUrl?: string;
	readonly browserViewId?: string;
	/** For `browser` requests: give the page its own tab (e.g. a link opened with target=_blank). */
	readonly newTab?: boolean;
	readonly editorSidebar?: boolean;
	/** Start a fresh task in the embedded Editor-style chat surface. */
	readonly newChat?: boolean;
	/**
	 * For `launcher` requests: only reveal the panel when a tab is already
	 * active instead of switching it back to the launcher.
	 */
	readonly preserveActiveTab?: boolean;
	/** For `review` requests: the changed file whose diff to select. */
	readonly reviewResource?: URI;
}

export interface IRightWorkbenchModeEntry {
	readonly mode: RightWorkbenchMode;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly shortcut: string;
}

/**
 * Hosts a right workbench pane outside the auxiliary bar, as the side panel
 * of one column of a split sessions grid. Such a pane works against its
 * column's session instead of the window's active session, never listens to
 * {@link onDidRequestModeEmitter} (requests are routed to it directly), and
 * shows/hides itself through the host instead of the auxiliary bar.
 */
export interface IRightWorkbenchSplitHost {
	readonly session: IObservable<IActiveSession | undefined>;
	reveal(): void;
	hide(): void;
}

export const onDidRequestModeEmitter = new Emitter<IRightWorkbenchModeRequest>();
export let pendingModeRequest: IRightWorkbenchModeRequest | undefined;

export function setPendingModeRequest(request: IRightWorkbenchModeRequest | undefined): void {
	pendingModeRequest = request;
}
