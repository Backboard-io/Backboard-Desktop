/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export const SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.rightWorkbenchContainer';
export const SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID = 'sessions.rightWorkbench.launcherView';

export const enum RightWorkbenchCommandId {
	OpenLauncher = 'workbench.action.sessions.rightWorkbench.openLauncher',
	OpenLauncherMode = 'workbench.action.sessions.rightWorkbench.openLauncherMode',
	OpenReview = 'workbench.action.sessions.rightWorkbench.openReview',
	OpenFiles = 'workbench.action.sessions.rightWorkbench.openFiles',
	OpenBrowser = 'workbench.action.sessions.rightWorkbench.openBrowser',
	OpenTerminal = 'workbench.action.sessions.rightWorkbench.openTerminal',
}

export type RightWorkbenchMode = 'launcher' | 'review' | 'browser' | 'files' | 'terminal';

export const orderedTabModes: readonly RightWorkbenchMode[] = ['review', 'browser', 'files', 'terminal'];

export interface IRightWorkbenchModeRequest {
	readonly mode: RightWorkbenchMode;
	readonly browserUrl?: string;
	readonly browserViewId?: string;
}

export interface IRightWorkbenchModeEntry {
	readonly mode: RightWorkbenchMode;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly shortcut: string;
}

export const onDidRequestModeEmitter = new Emitter<IRightWorkbenchModeRequest>();
export let pendingModeRequest: IRightWorkbenchModeRequest | undefined;

export function setPendingModeRequest(request: IRightWorkbenchModeRequest | undefined): void {
	pendingModeRequest = request;
}
