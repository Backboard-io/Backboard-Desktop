/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Editor, Simple and Advanced share one native window, and the modes that are
 * not on screen start and keep running in the background. Onboarding and its
 * tours belong only in the mode the user is looking at.
 */
export function isWorkbenchVisible(): boolean {
	return mainWindow.document.visibilityState === 'visible';
}

/** Runs `callback` once, the next time this workbench comes on screen. */
export function onceWorkbenchVisible(callback: () => void): IDisposable {
	const listener = addDisposableListener(mainWindow.document, 'visibilitychange', () => {
		if (isWorkbenchVisible()) {
			listener.dispose();
			callback();
		}
	});
	return listener;
}
