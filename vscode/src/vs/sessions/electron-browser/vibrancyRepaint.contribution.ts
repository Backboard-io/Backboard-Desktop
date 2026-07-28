/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { isMacintosh } from '../../base/common/platform.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../workbench/common/contributions.js';

/**
 * macOS: the agent-sessions style windows are transparent vibrancy windows,
 * and the compositor can fail to clear damaged regions over the translucent
 * sidebar when an overlay is removed — a closed context menu or picker then
 * lingers as a faint ghost blended into the glass until something else
 * repaints that area. This contribution schedules a full window repaint
 * right after such overlays hide so any stale pixels are wiped immediately.
 */
export class VibrancyRepaintContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsVibrancyRepaint';

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IQuickInputService quickInputService: IQuickInputService,
		@INativeHostService nativeHostService: INativeHostService,
	) {
		super();

		if (!isMacintosh) {
			return;
		}

		// Delay slightly so the overlay's DOM removal has painted before the
		// full repaint replaces the frame; coalesces bursts of hide events.
		const repaintScheduler = this._register(new RunOnceScheduler(() => nativeHostService.invalidateWindowRepaint(), 100));

		this._register(contextMenuService.onDidHideContextMenu(() => repaintScheduler.schedule()));
		this._register(quickInputService.onHide(() => repaintScheduler.schedule()));

		// The boot reveal flips the grid and every part from `opacity: 0` to
		// opaque in one frame (see `revealWorkbench`), which is the same kind of
		// large style flip that leaves stale pixels over the glass — and it runs
		// on every mode switch, since switching reloads the window in place. The
		// main process invalidates on `did-finish-load`, but that lands before
		// the workbench has painted anything, so the flip needs its own repaint.
		// This contribution starts after `Restored`, i.e. after the reveal.
		repaintScheduler.schedule();

		// Scrolling smears stale pixels over the glass the same way. `wheel`
		// carries trackpad and mouse scrolling over the workbench lists, which
		// scroll via transforms and never emit native scroll events; `scroll`
		// covers the real scroll containers, including when they are driven by
		// the keyboard or moved programmatically (revealing a session in the
		// list) and no wheel event is ever produced. Both feed the same
		// trailing-edge scheduler, so a burst still costs one repaint once it
		// settles, whichever way it was driven.
		this._register(addDisposableListener(mainWindow, 'wheel', () => repaintScheduler.schedule(), { capture: true, passive: true }));
		this._register(addDisposableListener(mainWindow, 'scroll', () => repaintScheduler.schedule(), { capture: true, passive: true }));
	}
}
