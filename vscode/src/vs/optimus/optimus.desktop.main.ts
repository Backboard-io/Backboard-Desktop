/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { domContentLoaded } from '../base/browser/dom.js';
import { mainWindow } from '../base/browser/window.js';
import { OptimusApp } from './browser/optimusApp.js';
import { OptimusRunStore } from './browser/optimusRunStore.js';
import { ElectronOptimusBackboardBridge } from './electron-browser/optimusBackboardBridge.js';
import { ElectronOptimusHistoryProvider, ElectronOptimusNavigationProvider } from './electron-browser/optimusHistoryService.js';

export async function main(): Promise<void> {
	await domContentLoaded(mainWindow);
	mainWindow.document.body.classList.add('optimus-standalone');
	const bridge = new ElectronOptimusBackboardBridge();
	const historyProvider = new ElectronOptimusHistoryProvider();
	const navigationProvider = new ElectronOptimusNavigationProvider();
	const store = new OptimusRunStore(bridge);
	const app = new OptimusApp(mainWindow.document.body, store, historyProvider, navigationProvider);
	app.start();
}

main().catch(error => console.error(error));
