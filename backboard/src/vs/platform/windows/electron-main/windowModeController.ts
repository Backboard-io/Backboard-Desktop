/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ICodeWindow } from '../../window/electron-main/window.js';

export type WorkbenchMode = 'simple' | 'editor' | 'advanced';

interface IWindowModeHost {
	find(mode: WorkbenchMode): ICodeWindow | undefined;
	isClosed(): boolean;
	suspend(window: ICodeWindow): void;
	activate(window: ICodeWindow): void;
}

/** Reuses one workbench per mode and lets only the newest request activate it. */
export class WindowModeController extends Disposable {
	private request = 0;
	private readonly pendingModes = new Map<WorkbenchMode, Promise<ICodeWindow | undefined>>();

	private preloadScheduled = false;

	constructor(private readonly host: IWindowModeHost) { super(); }

	/** Warm missing modes serially, leaving a gap for interactive startup work. */
	schedulePreload(open: (mode: WorkbenchMode) => Promise<ICodeWindow[]>, onError: (error: unknown) => void): void {
		if (this.preloadScheduled || this.host.isClosed() || this._store.isDisposed) { return; }
		this.preloadScheduled = true;
		const modes: WorkbenchMode[] = ['simple', 'editor', 'advanced'];
		const remaining = modes.filter(mode => !this.host.find(mode));
		const scheduler = this._register(new RunOnceScheduler(async () => {
			if (this.host.isClosed() || this._store.isDisposed) { return; }
			// Let an interactive cold switch finish before starting another renderer.
			if (this.pendingModes.size) { scheduler.schedule(); return; }
			const mode = remaining.shift();
			if (!mode) { return; }
			try { await this.preload(mode, () => open(mode)); }
			catch (error) { onError(error); }
			if (remaining.length && !this.host.isClosed() && !this._store.isDisposed) { scheduler.schedule(); }
		}, 1000));
		scheduler.schedule();
	}

	/** Never navigate an existing mode or change the user's activation request. */
	async preload(mode: WorkbenchMode, open: () => Promise<ICodeWindow[]>): Promise<ICodeWindow | undefined> {
		if (this.host.isClosed() || this._store.isDisposed) { return undefined; }
		const pending = this.pendingModes.get(mode);
		if (pending) { return pending; }
		return this.host.find(mode) ?? this.load(mode, open);
	}

	private async load(mode: WorkbenchMode, open: () => Promise<ICodeWindow[]>): Promise<ICodeWindow | undefined> {
		const loading = (async () => {
			const opened = (await open())[0];
			if (opened && !opened.isReady) {
				const listeners = new DisposableStore();
				try {
					await new Promise<void>(resolve => {
						listeners.add(opened.onDidSignalReady(() => resolve()));
						listeners.add(opened.onDidClose(() => resolve()));
						if (opened.isReady || !opened.win) { resolve(); }
					});
				} finally { listeners.dispose(); }
			}
			if (opened) { this.host.suspend(opened); }
			return opened;
		})();
		this.pendingModes.set(mode, loading);
		try { return await loading; }
		finally { if (this.pendingModes.get(mode) === loading) { this.pendingModes.delete(mode); } }
	}

	async open(mode: WorkbenchMode, open: (existing?: ICodeWindow) => Promise<ICodeWindow[]>, matches: (window: ICodeWindow) => boolean = () => true): Promise<ICodeWindow | undefined> {
		const request = ++this.request;
		// Serialize cold loads for each slot. Different modes can prepare independently,
		// but repeated clicks must never allocate additional retained workbenches.
		const pending = this.pendingModes.get(mode);
		if (pending) { await pending; }
		if (request !== this.request || this.host.isClosed() || this._store.isDisposed) { return undefined; }
		const existing = this.host.find(mode);
		let window = existing;
		if (!existing || !existing.isReady || !matches(existing)) {
			window = await this.load(mode, () => open(existing));
		}
		if (request !== this.request || !window?.isReady || this.host.isClosed() || this._store.isDisposed) { return undefined; }
		this.host.activate(window);
		return window;
	}
}
