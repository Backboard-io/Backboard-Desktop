/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { domContentLoaded } from '../base/browser/dom.js';
import { mainWindow } from '../base/browser/window.js';
import { JarvisApp } from './browser/jarvisApp.js';
import { ElectronJarvisBridge } from './electron-browser/jarvisBridge.js';

export async function main(): Promise<void> {
	await domContentLoaded(mainWindow);
	mainWindow.document.body.classList.add('jarvis-standalone');
	const app = new JarvisApp(mainWindow.document.body, new ElectronJarvisBridge());
	await app.start();
}

main().catch(error => console.error(error));
