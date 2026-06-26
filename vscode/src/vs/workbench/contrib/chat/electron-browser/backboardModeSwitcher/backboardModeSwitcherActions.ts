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
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ToggleTitleBarConfigAction } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { BACKBOARD_MODE_SWITCHER_COMMAND_ID, ChatConfiguration, OPEN_AGENTS_WINDOW_COMMAND_ID, OPEN_AGENTS_WINDOW_PRECONDITION } from '../../common/constants.js';
import { OPEN_BACKBOARD_WORKSPACE_COMMAND_ID } from '../backboardWorkspace/backboardWorkspaceConstants.js';
import { IBackboardWorkspaceService } from '../backboardWorkspace/backboardWorkspaceService.js';

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

	private static readonly STORAGE_PREFIX = 'backboard.editorMode.panelClosed.';
	private static readonly PANEL_PARTS = [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART] as const;

	private triggerButton: HTMLButtonElement | undefined;
	private currentIcon: HTMLElement | undefined;
	private currentLabel: HTMLElement | undefined;

	private suppressVisibilityTracking = false;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IBackboardWorkspaceService private readonly workspaceService: IBackboardWorkspaceService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
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
			this.showMenu();
		}));
		this._register(addDisposableListener(this.triggerButton, EventType.KEY_DOWN, e => this.handleKeyDown(e)));
		this._register(this.editorService.onDidActiveEditorChange(() => this.updateState()));
		this._register(this.workspaceService.onDidChangeVisibility(() => this.updateState()));
		this._register(this.layoutService.onDidChangePartVisibility(e => this.handlePartVisibilityChange(e)));

		this.updateState();
	}

	private handlePartVisibilityChange(e: { readonly partId: string; readonly visible: boolean }): void {
		// Only record explicit user changes while in Editor mode and not while
		// we are programmatically restoring panel visibility on mode entry.
		if (this.suppressVisibilityTracking) {
			return;
		}
		if (!this.isEditorModeActive()) {
			return;
		}
		if (!BackboardModeTitleBarWidget.PANEL_PARTS.some(p => p === e.partId)) {
			return;
		}
		this.storageService.store(
			BackboardModeTitleBarWidget.STORAGE_PREFIX + e.partId,
			e.visible ? '0' : '1',
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}

	private isEditorModeActive(): boolean {
		return !this.isAgentsActive() && !this.isWorkspaceActive();
	}

	private isPanelClosedByUser(part: string): boolean {
		return this.storageService.get(BackboardModeTitleBarWidget.STORAGE_PREFIX + part, StorageScope.PROFILE, '0') === '1';
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
			EventHelper.stop(event, true);
			this.showMenu();
		}
	}

	private showMenu(): void {
		if (!this.triggerButton) {
			return;
		}

		const agentsActive = this.isAgentsActive();
		const workspaceActive = this.isWorkspaceActive();
		this.triggerButton.setAttribute('aria-expanded', 'true');
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.triggerButton!,
			getActions: () => [
				toAction({
					id: 'workbench.action.mode.editor',
					label: localize('backboardModeSwitcher.editor', "Editor"),
					checked: !agentsActive && !workspaceActive,
					run: () => this.openEditor(),
				}),
				toAction({
					id: 'workbench.action.mode.workspace',
					label: localize('backboardModeSwitcher.workspace', "Advanced"),
					checked: workspaceActive,
					run: () => this.openWorkspace(),
				}),
				toAction({
					id: 'workbench.action.mode.agents',
					label: localize('backboardModeSwitcher.agents', "Simple"),
					checked: agentsActive,
					run: () => this.openAgents(),
				}),
			],
			onHide: () => this.triggerButton?.setAttribute('aria-expanded', 'false'),
		});
	}

	private openAgents(): void {
		this.workspaceService.hide();
		void this.commandService.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
	}

	private openWorkspace(): void {
		void this.commandService.executeCommand(OPEN_BACKBOARD_WORKSPACE_COMMAND_ID);
	}

	private openEditor(): void {
		if (this.isWorkspaceActive()) {
			this.workspaceService.hide();
			return;
		}

		if (this.isAgentsActive()) {
			void this.commandService.executeCommand(CLOSE_ACTIVE_EDITOR_COMMAND_ID);
		}

		// Entering Editor mode: ensure the left, bottom, and right panels are
		// visible, unless the user previously closed them while in Editor mode.
		// Suppress tracking so our own restore calls are not recorded as user
		// intent.
		this.suppressVisibilityTracking = true;
		try {
			for (const part of BackboardModeTitleBarWidget.PANEL_PARTS) {
				if (this.isPanelClosedByUser(part)) {
					continue;
				}
				if (!this.layoutService.isVisible(part)) {
					this.layoutService.setPartHidden(false, part);
				}
			}
		} finally {
			this.suppressVisibilityTracking = false;
		}

		// When the bottom panel (terminal) is being shown, make sure the
		// Terminal view is the active composite rather than Problems/Output.
		if (!this.isPanelClosedByUser(Parts.PANEL_PART) && this.layoutService.isVisible(Parts.PANEL_PART)) {
			void this.paneCompositeService.openPaneComposite(TERMINAL_VIEW_ID, ViewContainerLocation.Panel, false);
		}
	}

	private isAgentsActive(): boolean {
		return this.editorService.activeEditorPane?.getId() === AGENT_SESSIONS_WELCOME_PAGE_ID;
	}

	private isWorkspaceActive(): boolean {
		return this.workspaceService.visible;
	}

	private updateState(): void {
		const agentsActive = this.isAgentsActive();
		const workspaceActive = this.isWorkspaceActive();
		this.currentIcon?.classList.toggle('codicon-window', !agentsActive && !workspaceActive);
		this.currentIcon?.classList.toggle('codicon-layout', workspaceActive);
		this.currentIcon?.classList.toggle('codicon-robot', agentsActive);
		const label = workspaceActive
			? localize('backboardModeSwitcher.workspace', "Advanced")
			: agentsActive
				? localize('backboardModeSwitcher.agents', "Simple")
				: localize('backboardModeSwitcher.editor', "Editor");
		this.currentLabel?.replaceChildren(label);
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
