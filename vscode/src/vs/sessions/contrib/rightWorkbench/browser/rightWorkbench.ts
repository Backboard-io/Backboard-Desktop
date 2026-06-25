/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
