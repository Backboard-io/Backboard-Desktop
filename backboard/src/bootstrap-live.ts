/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The app's entry point. It decides which copy of the application JavaScript
// runs: the one inside the signed app, or a verified live update overlay. It
// cannot itself be live updated, so it must stay small and dependency free.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import minimist from 'minimist';
import { product } from './bootstrap-meta.js';
import { getUserDataPath } from './vs/platform/environment/node/userDataPath.js';
import type { NativeParsedArgs } from './vs/platform/environment/common/argv.js';
import { type ILiveUpdateProductConfiguration, LIVE_APP_ID_ENV, LIVE_APP_SELECTION_ENV, LIVE_BASE_APP_ROOT_ENV, LIVE_UPDATES_DIR_ENV } from './vs/platform/backboardLiveUpdate/common/liveUpdate.js';
import { markLiveAppBad, selectLiveAppRoot } from './vs/platform/backboardLiveUpdate/node/liveUpdateBoot.js';

const baseOutDir = import.meta.dirname;
const args = minimist(process.argv, { string: ['user-data-dir'] }) as NativeParsedArgs;
const liveUpdatesDir = path.join(getUserDataPath(args, product.nameShort ?? 'code-oss-dev'), 'LiveUpdates');

// Every process the app starts inherits these, so the extension host and the
// agent host find the same folder and know which overlay is running.
process.env[LIVE_UPDATES_DIR_ENV] = liveUpdatesDir;
process.env[LIVE_BASE_APP_ROOT_ENV] = path.dirname(baseOutDir);
delete process.env[LIVE_APP_ID_ENV];

let selection: ReturnType<typeof selectLiveAppRoot>;
try {
	selection = selectLiveAppRoot({
		liveUpdatesDir,
		product: product as { backboardVersion?: string; backboardLiveUpdate?: ILiveUpdateProductConfiguration },
		electronVersion: process.versions.electron,
		isDev: !!process.env['VSCODE_DEV'],
	});
} catch (error) {
	selection = { reason: `overlay check failed: ${error}` };
}
process.env[LIVE_APP_SELECTION_ENV] = selection.reason;

if (selection.root && selection.id) {
	process.env[LIVE_APP_ID_ENV] = selection.id;
	try {
		await import(pathToFileURL(path.join(selection.root, 'out', 'main.js')).href);
	} catch (error) {
		// The overlay may already have registered protocols or changed app paths,
		// so it cannot fall back in this process. Relaunch into the installed app.
		console.error(`[live-update] overlay ${selection.id} failed to load: ${error}`);
		markLiveAppBad(liveUpdatesDir, selection.id);
		app.relaunch();
		app.exit(1);
	}
} else {
	await import(pathToFileURL(path.join(baseOutDir, 'main.js')).href);
}
