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
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';

/**
 * Renders a stable mode titlebar switcher in the sessions workbench.
 */
export class OpenInVSCodeTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		private readonly keybindingCommandId: string,
		private readonly openSimpleCommandId: string | undefined,
		private readonly openAdvancedCommandId: string | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('open-in-vscode-titlebar-widget');

		const hoverText = this.keybindingService.appendKeybinding(localize('openInVSCodeHover', "Switch Backboard mode"), this.keybindingCommandId);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));
		container.classList.toggle('optimus-mode', this.environmentService.isOptimusWindow);

		const segments = append(container, $('.backboard-mode-segments'));
		segments.setAttribute('role', 'group');
		segments.setAttribute('aria-label', hoverText);
		const modes = [
			{ label: localize('openInVSCodeSwitcher.agentTab', "Simple"), active: !this.environmentService.isOptimusWindow, run: () => this.openSimpleCommandId ? this.commandService.executeCommand(this.openSimpleCommandId) : undefined },
			{ label: localize('openInVSCodeSwitcher.editor', "Editor"), active: false, run: () => this.action.run() },
			{ label: localize('openInVSCodeSwitcher.advanced', "Advanced"), active: this.environmentService.isOptimusWindow, run: () => this.openAdvancedCommandId ? this.commandService.executeCommand(this.openAdvancedCommandId) : undefined },
		];
		for (const mode of modes) {
			const button = append(segments, $('button.backboard-mode-segment'));
			button.setAttribute('type', 'button');
			button.textContent = mode.label;
			button.setAttribute('aria-pressed', String(mode.active));
			this._register(addDisposableListener(button, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				// Re-selecting the current mode cancels a pending cold switch.
				void mode.run();
			}));
		}
	}
}
