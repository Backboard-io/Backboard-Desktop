/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/panelEdgePreview.css';
import { $, addDisposableListener, append, EventType } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';

/** Lightweight edge affordances that reveal closed panels without shifting the chat. */
export class PanelEdgePreview extends Disposable {
	constructor(container: HTMLElement, @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService) {
		super();
		for (const side of ['left', 'right'] as const) {
			const part = side === 'left' ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;
			const label = side === 'left' ? localize('openSidebar', "Open Sidebar") : localize('openRightPanel', "Open Right Panel");
			const edge = append(container, $(`.sessions-panel-edge-preview.${side}`));
			this._register(toDisposable(() => edge.remove()));
			const button = append(edge, $('button', { type: 'button', 'aria-label': label }));
			const preview = append(button, $('.sessions-panel-edge-card'));
			append(preview, $(`.codicon.codicon-layout-sidebar-${side}`, { 'aria-hidden': 'true' }));
			append(preview, $('strong', {}, label));
			append(preview, $('span.sessions-panel-edge-description', {}, side === 'left'
				? localize('sidebarPreview', "Threads and projects")
				: localize('rightPanelPreview', "Review, files, terminal and browser")));
			const skeleton = append(preview, $('.sessions-panel-edge-skeleton', { 'aria-hidden': 'true' }));
			for (let row = 0; row < 5; row++) {
				append(skeleton, $('span'));
			}
			append(preview, $('span.sessions-panel-edge-hint', {}, localize('clickToOpen', "Click to open")));
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				layoutService.setPartHidden(false, part);
				layoutService.focusPart(part);
			}));
			this._register(addDisposableListener(button, EventType.KEY_DOWN, event => {
				if (event.key === 'Escape') {
					edge.classList.add('dismissed');
					button.blur();
				}
			}));
			this._register(addDisposableListener(edge, EventType.MOUSE_LEAVE, () => edge.classList.remove('dismissed')));
			this._register(addDisposableListener(button, EventType.FOCUS, () => edge.classList.remove('dismissed')));
		}
	}
}
