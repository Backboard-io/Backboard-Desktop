/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/openInVSCode.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../base/common/actions.js';
import { localize } from '../../../nls.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IProductService } from '../../../platform/product/common/productService.js';

/**
 * Renders a stable Editor / Agents titlebar switcher in the sessions workbench.
 */
export class OpenInVSCodeTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		private readonly keybindingCommandId: string,
		@IProductService private readonly productService: IProductService,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('open-in-vscode-titlebar-widget');
		container.setAttribute('role', 'group');

		// Set quality attribute for distro icon selection. Only set when quality is
		// known so that the CSS fallback icon is used in dev builds.
		const quality = this.productService.quality;
		const hoverText = this.keybindingService.appendKeybinding(localize('openInVSCodeHover', "Switch to Editor"), this.keybindingCommandId);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const editorButton = append(container, $('button.open-in-vscode-titlebar-widget-option.editor'));
		if (quality) {
			editorButton.setAttribute('data-product-quality', quality);
		}
		const icon = append(editorButton, $('span.open-in-vscode-titlebar-widget-icon'));
		icon.setAttribute('aria-hidden', 'true');
		append(editorButton, $('span.open-in-vscode-titlebar-widget-label')).textContent = localize('openInVSCodeSwitcher.editor', "Editor");

		const agentsButton = append(container, $('button.open-in-vscode-titlebar-widget-option.agents.checked'));
		agentsButton.textContent = localize('openInVSCodeSwitcher.agents', "Agents");
		agentsButton.setAttribute('aria-pressed', 'true');
		editorButton.setAttribute('aria-pressed', 'false');

		this._register(addDisposableListener(editorButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.action.run();
		}));
		this._register(addDisposableListener(editorButton, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				EventHelper.stop(event, true);
				this.action.run();
			}
		}));
		this._register(addDisposableListener(agentsButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
		}));
	}
}
