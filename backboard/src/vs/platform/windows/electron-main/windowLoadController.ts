/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeWindowConfiguration } from '../../window/common/window.js';
import { ICodeWindow } from '../../window/electron-main/window.js';

interface IPendingWindowLoad {
	readonly unload: Promise<boolean>;
	request: object;
}

/** Coordinates overlapping navigations without loading superseded workbenches. */
export class WindowLoadController {
	private readonly pending = new WeakMap<ICodeWindow, IPendingWindowLoad>();

	constructor(private readonly unload: (window: ICodeWindow) => Promise<boolean>) { }

	async load(window: ICodeWindow, prepare: (isCurrent: () => boolean) => Promise<INativeWindowConfiguration>): Promise<boolean> {
		const request = {};
		let pending = this.pending.get(window);
		if (!pending) {
			pending = { unload: window.isReady ? this.unload(window) : Promise.resolve(false), request };
			this.pending.set(window, pending);
		} else {
			pending.request = request;
		}
		const isCurrent = () => this.pending.get(window) === pending && pending.request === request;
		const canLoad = () => isCurrent() && !!window.win && !window.win.isDestroyed();
		try {
			if (await pending.unload || !canLoad()) {
				return false;
			}
			const configuration = await prepare(canLoad);
			if (!canLoad()) {
				return false;
			}
			window.load(configuration);
			return true;
		} finally {
			if (isCurrent()) {
				this.pending.delete(window);
			}
		}
	}
}
