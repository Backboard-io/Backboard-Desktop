/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, nativeImage } from 'electron';
import { FileAccess } from '../../base/common/network.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { isMacintosh } from '../../base/common/platform.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';

export const DOCK_ICON_SETTING = 'window.dockIcon';

/** Dock icon choices (see `window.dockIcon`), each a 1024px PNG in ./media. */
const DOCK_ICONS: Record<string, string> = {
	classic: 'dock-classic.png',
	octopus: 'dock-octopus.png',
	peek: 'dock-peek.png',
	terminal: 'dock-terminal.png',
	face: 'dock-face.png',
};

/**
 * Swaps the macOS Dock icon at runtime to the one picked in `window.dockIcon`.
 * Only applies while the app runs; a Dock pin of a closed app still shows the bundle icon.
 */
export class DockIconController extends Disposable {

	/** Leaves the bundle icon alone until someone picks a non-classic icon. */
	private changed = false;

	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();

		if (!isMacintosh || !app.dock) {
			return;
		}

		this.apply();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DOCK_ICON_SETTING)) {
				this.apply();
			}
		}));
	}

	private apply(): void {
		const value = this.configurationService.getValue<string>(DOCK_ICON_SETTING);
		const file = DOCK_ICONS[value] ?? DOCK_ICONS.classic;
		if (file === DOCK_ICONS.classic && !this.changed) {
			return;
		}

		const image = nativeImage.createFromPath(FileAccess.asFileUri(`vs/code/electron-main/media/${file}`).fsPath);
		if (image.isEmpty()) {
			this.logService.warn(`[dockIcon] missing icon image: ${file}`);
			return;
		}

		app.dock!.setIcon(image);
		this.changed = true;
	}
}
