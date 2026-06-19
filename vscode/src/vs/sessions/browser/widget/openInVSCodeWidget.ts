/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/openInVSCode.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction, toAction } from '../../../base/common/actions.js';
import { localize } from '../../../nls.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';

const OPEN_BACKBOARD_AGENTS_COMMAND_ID = 'backboard.agents.open';
const OPEN_BACKBOARD_WORKSPACE_COMMAND_ID = 'backboard.workspace.open';
const BACKBOARD_WORKSPACE_EDITOR_ID = 'workbench.editor.backboardWorkspace';

/**
 * Renders a stable Editor / Agents titlebar switcher in the sessions workbench.
 */
export class OpenInVSCodeTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		private readonly keybindingCommandId: string,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('open-in-vscode-titlebar-widget');

		const hoverText = this.keybindingService.appendKeybinding(localize('openInVSCodeHover', "Switch to Editor"), this.keybindingCommandId);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const triggerButton = append(container, $('button.open-in-vscode-titlebar-widget-trigger'));
		triggerButton.setAttribute('aria-haspopup', 'menu');
		triggerButton.setAttribute('aria-expanded', 'false');
		const currentIcon = append(triggerButton, $('span.open-in-vscode-titlebar-widget-icon.codicon'));
		currentIcon.setAttribute('aria-hidden', 'true');
		const currentLabel = append(triggerButton, $('span.open-in-vscode-titlebar-widget-label'));
		const chevron = append(triggerButton, $('span.open-in-vscode-titlebar-widget-chevron.codicon.codicon-chevron-down'));
		chevron.setAttribute('aria-hidden', 'true');

		const showMenu = () => {
			const workspaceActive = this.editorService.activeEditorPane?.getId() === BACKBOARD_WORKSPACE_EDITOR_ID;
			triggerButton.setAttribute('aria-expanded', 'true');
			this.contextMenuService.showContextMenu({
				getAnchor: () => triggerButton,
				getActions: () => [
					toAction({
						id: 'agents.action.mode.editor',
						label: localize('openInVSCodeSwitcher.editor', "Editor"),
						run: () => this.action.run(),
					}),
					toAction({
						id: 'agents.action.mode.agents',
						label: localize('openInVSCodeSwitcher.agents', "Agents"),
						checked: !workspaceActive,
						run: () => this.commandService.executeCommand(OPEN_BACKBOARD_AGENTS_COMMAND_ID),
					}),
					toAction({
						id: 'agents.action.mode.workspace',
						label: localize('openInVSCodeSwitcher.workspace', "Workspace"),
						checked: workspaceActive,
						run: () => this.commandService.executeCommand(OPEN_BACKBOARD_WORKSPACE_COMMAND_ID),
					}),
				],
				onHide: () => triggerButton.setAttribute('aria-expanded', 'false'),
			});
		};

		const updateLabel = () => {
			const workspaceActive = this.editorService.activeEditorPane?.getId() === BACKBOARD_WORKSPACE_EDITOR_ID;
			currentIcon.className = workspaceActive
				? 'open-in-vscode-titlebar-widget-icon codicon codicon-robot'
				: 'open-in-vscode-titlebar-widget-icon codicon codicon-window';
			currentLabel.textContent = workspaceActive
				? localize('openInVSCodeSwitcher.workspace', "Workspace")
				: localize('openInVSCodeSwitcher.agents', "Agents");
		};
		this._register(this.editorService.onDidActiveEditorChange(updateLabel));
		updateLabel();

		this._register(addDisposableListener(triggerButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			showMenu();
		}));
		this._register(addDisposableListener(triggerButton, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
				EventHelper.stop(event, true);
				showMenu();
			}
		}));
	}
}
