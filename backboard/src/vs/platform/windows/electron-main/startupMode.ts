/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IOpenConfiguration } from './windows.js';
import type { IWindowsState } from './windowsStateHandler.js';

export function shouldOpenSimpleOnStartup(config: IOpenConfiguration, state: IWindowsState): boolean {
	return !!config.initialStartup && !state.lastActiveWindow && state.openedWindows.length === 0
		&& !config.urisToOpen?.length && !config.cli._.length
		&& !config.cli['file-uri'] && !config.cli['folder-uri']
		&& !config.forceEmpty && !config.forceNewWindow && !config.optimusWindow
		&& !config.forceProfile && !config.forceTempProfile && !config.remoteAuthority
		&& !config.cli.extensionDevelopmentPath && !config.cli.extensionTestsPath;
}
