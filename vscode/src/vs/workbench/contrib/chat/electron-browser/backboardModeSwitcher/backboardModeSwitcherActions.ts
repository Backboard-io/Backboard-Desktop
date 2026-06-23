/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './media/backboardModeSwitcher.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction, toAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ToggleTitleBarConfigAction } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { BACKBOARD_MODE_SWITCHER_COMMAND_ID, ChatConfiguration, OPEN_AGENTS_WINDOW_COMMAND_ID, OPEN_AGENTS_WINDOW_PRECONDITION } from '../../common/constants.js';

const CLOSE_ACTIVE_EDITOR_COMMAND_ID = 'workbench.action.closeActiveEditor';
const AGENT_SESSIONS_WELCOME_PAGE_ID = 'agentSessionsWelcomePage';

export class BackboardModeSwitcherAction extends Action2 {
	constructor() {
		super({
			id: BACKBOARD_MODE_SWITCHER_COMMAND_ID,
			title: localize2('backboardModeSwitcher', "Backboard Mode Switcher"),
			category: CHAT_CATEGORY,
			precondition: OPEN_AGENTS_WINDOW_PRECONDITION,
			f1: false,
			menu: [{
				id: MenuId.TitleBarLeft,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.and(
					OPEN_AGENTS_WINDOW_PRECONDITION,
					ContextKeyExpr.notEquals(`config.${ChatConfiguration.TitleBarOpenInAgentsWindowEnabled}`, false),
				),
			}],
		});
	}

	run(): void { }
}

export class ToggleBackboardModeSwitcherTitleBarAction extends ToggleTitleBarConfigAction {
	constructor() {
		super(
			ChatConfiguration.TitleBarOpenInAgentsWindowEnabled,
			localize('toggle.backboardModeSwitcher', 'Backboard Switcher'),
			localize('toggle.backboardModeSwitcherDescription', "Toggle visibility of the Editor / Agents switcher in the title bar"),
			6,
			OPEN_AGENTS_WINDOW_PRECONDITION,
		);
	}
}

class BackboardModeTitleBarWidget extends BaseActionViewItem {

	private triggerButton: HTMLButtonElement | undefined;
	private currentIcon: HTMLElement | undefined;
	private currentLabel: HTMLElement | undefined;
	private preserveFocusOnMenuHide = false;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('backboard-mode-titlebar-widget');

		const hoverText = this.keybindingService.appendKeybinding(localize('backboardModeSwitcherHover', "Switch Backboard mode"), BACKBOARD_MODE_SWITCHER_COMMAND_ID);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		this.triggerButton = append(container, $('button.backboard-mode-titlebar-widget-trigger'));
		this.triggerButton.setAttribute('aria-haspopup', 'menu');
		this.triggerButton.setAttribute('aria-expanded', 'false');
		this.currentIcon = append(this.triggerButton, $('span.backboard-mode-titlebar-widget-icon.codicon'));
		this.currentIcon.setAttribute('aria-hidden', 'true');
		this.currentLabel = append(this.triggerButton, $('span.backboard-mode-titlebar-widget-label'));
		const chevron = append(this.triggerButton, $('span.backboard-mode-titlebar-widget-chevron.codicon.codicon-chevron-down'));
		chevron.setAttribute('aria-hidden', 'true');

		this._register(addDisposableListener(this.triggerButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.showMenu(false);
		}));
		this._register(addDisposableListener(this.triggerButton, EventType.KEY_DOWN, e => this.handleKeyDown(e)));
		this._register(this.editorService.onDidActiveEditorChange(() => this.updateState()));

		this.updateState();
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
			EventHelper.stop(event, true);
			this.showMenu(true);
		}
	}

	private showMenu(preserveFocusOnHide: boolean): void {
		if (!this.triggerButton) {
			return;
		}

		const agentsActive = this.isAgentsActive();
		this.preserveFocusOnMenuHide = preserveFocusOnHide;
		this.triggerButton.setAttribute('aria-expanded', 'true');
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.triggerButton!,
			getActions: () => [
				toAction({
					id: 'workbench.action.mode.editor',
					label: localize('backboardModeSwitcher.editor', "Editor"),
					checked: !agentsActive,
					run: () => this.openEditor(),
				}),
				toAction({
					id: 'workbench.action.mode.agents',
					label: localize('backboardModeSwitcher.agents', "Agents"),
					checked: agentsActive,
					run: () => this.openAgents(),
				}),
			],
			onHide: () => {
				this.triggerButton?.setAttribute('aria-expanded', 'false');
				if (!this.preserveFocusOnMenuHide) {
					this.clearPointerFocus();
				}
				this.preserveFocusOnMenuHide = false;
			},
		});
	}

	private openAgents(): void {
		this.clearPointerFocus();
		this.commandService.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
	}

	private openEditor(): void {
		this.clearPointerFocus();
		if (this.editorService.activeEditorPane?.getId() === AGENT_SESSIONS_WELCOME_PAGE_ID) {
			this.commandService.executeCommand(CLOSE_ACTIVE_EDITOR_COMMAND_ID);
		}
	}

	private clearPointerFocus(): void {
		if (this.preserveFocusOnMenuHide) {
			return;
		}

		this.triggerButton?.blur();
		this.element?.classList.remove('active', 'focused');
	}

	private isAgentsActive(): boolean {
		return this.editorService.activeEditorPane?.getId() === AGENT_SESSIONS_WELCOME_PAGE_ID;
	}

	private updateState(): void {
		const agentsActive = this.isAgentsActive();
		this.currentIcon?.classList.toggle('codicon-window', !agentsActive);
		this.currentIcon?.classList.toggle('codicon-robot', agentsActive);
		this.currentLabel?.replaceChildren(agentsActive
			? localize('backboardModeSwitcher.agents', "Agents")
			: localize('backboardModeSwitcher.editor', "Editor"));
	}
}

export class BackboardModeSwitcherContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardModeSwitcher.desktop';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBarLeft, BACKBOARD_MODE_SWITCHER_COMMAND_ID, (action, options) => {
			return instantiationService.createInstance(BackboardModeTitleBarWidget, action, options);
		}, undefined));
	}
}
