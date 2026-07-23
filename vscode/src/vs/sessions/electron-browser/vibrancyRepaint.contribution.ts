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

		// Scrolling smears stale pixels over the glass the same way. `wheel` is
		// used rather than `scroll` because the workbench lists scroll via
		// transforms and never emit native scroll events; the trailing-edge
		// scheduler means one repaint per scroll burst, after momentum settles.
		this._register(addDisposableListener(mainWindow, 'wheel', () => repaintScheduler.schedule(), { capture: true, passive: true }));
	}
}
