/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, View, WebContentsView, WebPreferences } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { WindowModeController, WorkbenchMode } from './windowModeController.js';
import { ICodeWindow } from '../../window/electron-main/window.js';

/** Owns the retained workbench renderers displayed in one native window. */
export class WorkbenchWindowGroup extends Disposable {
	private readonly views = new Map<ICodeWindow, { container: View; workbench: WebContentsView }>();
	private active: ICodeWindow | undefined;
	private readonly _onDidActivateMode = this._register(new Emitter<{ window: ICodeWindow; previous?: ICodeWindow }>());
	readonly onDidActivateMode = this._onDidActivateMode.event;
	readonly modeController: WindowModeController;

	constructor(readonly host: BrowserWindow, modeOf: (window: ICodeWindow) => WorkbenchMode) {
		super();
		this.modeController = this._register(new WindowModeController({
			find: mode => this.windows.find(window => modeOf(window) === mode),
			isClosed: () => host.isDestroyed(),
			suspend: window => this.suspend(window),
			activate: window => window.focus(),
		}));
		this._register(Event.fromNodeEventEmitter(host, 'resize')(() => this.layout()));
		this._register(Event.fromNodeEventEmitter(host, 'closed')(() => this.dispose()));
	}

	get windows(): readonly ICodeWindow[] { return [...this.views.keys()]; }
	get activeWindow(): ICodeWindow | undefined { return this.active; }

	add(window: ICodeWindow, webPreferences: WebPreferences): { container: View; workbench: WebContentsView } {
		if (this.views.size >= 3) {
			throw new Error('A native window can retain at most three workbench modes');
		}
		const container = new View();
		const workbench = new WebContentsView({ webPreferences });
		workbench.setBackgroundColor('#00000000');
		container.addChildView(workbench);
		// Initialize at full size underneath the current mode. Chromium gives a
		// never-shown view a zero-sized viewport, which breaks workbench startup.
		this.host.contentView.addChildView(container, 0);
		const view = { container, workbench };
		this.views.set(window, view);
		const [width, height] = this.host.getContentSize();
		container.setBounds({ x: 0, y: 0, width, height });
		workbench.setBounds({ x: 0, y: 0, width, height });
		return view;
	}

	activate(window: ICodeWindow): void {
		const next = this.views.get(window);
		if (!next || this.host.isDestroyed()) {
			return;
		}
		const previousWindow = this.active;
		const previous = this.active && this.views.get(this.active);
		this.active = window;
		// Only reorder when another mode is still preparing beneath the current
		// one. Reattaching a warm view needlessly invalidates its compositor.
		if ([...this.views.values()].some(view => view !== next && view !== previous && view.container.getVisible())) {
			this.host.contentView.addChildView(next.container);
		}
		this.layout();
		next.container.setVisible(true);
		if (previous && previous !== next) {
			previous.container.setVisible(false);
		}
		next.workbench.webContents.focus();
		if (previousWindow !== window) { this._onDidActivateMode.fire({ window, previous: previousWindow }); }
	}

	suspend(window: ICodeWindow): void {
		if (window !== this.active) {
			const view = this.views.get(window);
			view?.container.setVisible(false);
		}
	}

	private layout(): void {
		const view = this.active && this.views.get(this.active);
		if (!view || this.host.isDestroyed()) {
			return;
		}
		const [width, height] = this.host.getContentSize();
		const bounds = view.container.getBounds();
		if (bounds.width !== width || bounds.height !== height) {
			view.container.setBounds({ x: 0, y: 0, width, height });
			view.workbench.setBounds({ x: 0, y: 0, width, height });
		}
	}

	override dispose(): void {
		super.dispose();
		for (const { workbench } of this.views.values()) {
			if (!workbench.webContents.isDestroyed()) {
				workbench.webContents.close({ waitForBeforeUnload: false });
			}
		}
		this.views.clear();
		this.active = undefined;
	}
}
