/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';

/**
 * Pretends this workbench is a mode on or off screen for the current suite.
 * Modes share one native window, and the hidden ones report
 * `visibilityState === 'hidden'`. Animation frames are held in `frames`, so a
 * test decides when a tour that starts on the next frame actually runs.
 */
export function useSimulatedVisibility(): { set(state: DocumentVisibilityState): void; readonly frames: FrameRequestCallback[] } {
	let visibility: DocumentVisibilityState = 'visible';
	const frames: FrameRequestCallback[] = [];
	let requestAnimationFrame: typeof mainWindow.requestAnimationFrame;
	setup(() => {
		visibility = 'visible';
		frames.length = 0;
		Object.defineProperty(mainWindow.document, 'visibilityState', { configurable: true, get: () => visibility });
		requestAnimationFrame = mainWindow.requestAnimationFrame;
		mainWindow.requestAnimationFrame = callback => frames.push(callback);
	});
	teardown(() => {
		Reflect.deleteProperty(mainWindow.document, 'visibilityState');
		mainWindow.requestAnimationFrame = requestAnimationFrame;
	});
	return {
		set: state => {
			visibility = state;
			mainWindow.document.dispatchEvent(new Event('visibilitychange'));
		},
		frames,
	};
}
