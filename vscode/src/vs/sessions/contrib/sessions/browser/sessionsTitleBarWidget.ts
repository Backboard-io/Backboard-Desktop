/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionsTitleBarWidget.css';
import { $, addDisposableListener, EventType, reset } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MenuRegistry, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { Menus } from '../../../browser/menus.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { autorun } from '../../../../base/common/observable.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from './sessionsActions.js';

const OPEN_SESSION_IN_VSCODE_COMMAND_ID = 'agents.openSessionInVSCode';
const OPEN_IN_VSCODE_COMMAND_ID = 'sessions.openInVSCode';
const CLOSE_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.closeWorkspacePage';

type TitlebarPage = 'sandbox' | 'editor';

/**
 * Sessions Title Bar Widget - renders the active chat session
 * in the command center of the agent sessions workbench.
 *
 * Shows the current chat session as a clickable pill with:
 * - Kind icon at the beginning (provider type icon)
 * - Repository folder name and active branch/worktree name when available
 *
 * Session actions (changes, terminal, etc.) are rendered via the
 * SessionTitleActions menu toolbar next to this widget.
 *
 * On click, opens the sessions picker.
 */
export class SessionsTitleBarWidget extends BaseActionViewItem {

	private _container: HTMLElement | undefined;
	private readonly _dynamicDisposables = this._register(new DisposableStore());

	/** Cached render state to avoid unnecessary DOM rebuilds */
	private _lastRenderState: string | undefined;

	/** Guard to prevent re-entrant rendering */
	private _isRendering = false;

	constructor(
		action: SubmenuItemAction,
		options: IBaseActionViewItemOptions | undefined,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(undefined, action, options);

		// Re-render when the active session's title or workspace changes
		this._register(autorun(reader => {
			const sessionData = this.sessionsManagementService.activeSession.read(reader);
			if (sessionData) {
				sessionData.title.read(reader);
				sessionData.workspace.read(reader);
			}
			this._lastRenderState = undefined;
			this._render();
		}));

		// Re-render when sessions data changes (e.g., changes info updated)
		this._register(this.sessionsManagementService.onDidChangeSessions(() => {
			this._lastRenderState = undefined;
			this._render();
		}));

		// Re-render when providers change (affects provider picker visibility)
		this._register(this.sessionsProvidersService.onDidChangeProviders(() => {
			this._lastRenderState = undefined;
			this._render();
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this._container = container;
		container.classList.add('agent-sessions-titlebar-container');

		// Initial render
		this._render();
	}

	override setFocusable(_focusable: boolean): void {
		// Don't set focusable on the container
	}

	// Override onClick to prevent the base class from running the underlying
	// submenu action when the widget handles clicks itself.
	override onClick(): void {
		// No-op: click handling is done by the pill handler
	}

	private _render(): void {
		if (!this._container) {
			return;
		}

		if (this._isRendering) {
			return;
		}
		this._isRendering = true;

		try {
			const sessionTitle = this._getSessionTitle() ?? localize('newSession', "New Sandbox");
			const workspaceLabel = this._getRepositoryLabel();

			// Build a render-state key from all displayed data
			const activePage = this._getActivePage();
			const renderState = `${sessionTitle ?? ''}|${workspaceLabel ?? ''}|${activePage}`;

			// Skip re-render if state hasn't changed
			if (this._lastRenderState === renderState) {
				return;
			}
			this._lastRenderState = renderState;

			// Clear existing content
			reset(this._container);
			this._dynamicDisposables.clear();

			// Set up container as a tablist switch.
			this._container.removeAttribute('aria-hidden');
			this._container.setAttribute('role', 'tablist');
			this._container.setAttribute('aria-label', localize('ideViewSwitchAriaLabel', "IDE view"));
			this._container.tabIndex = -1;

			const buttons = [
				this._createSwitchButton('sandbox', localize('sandboxView', "Sandbox"), () => this.commandService.executeCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID)),
				this._createSwitchButton('editor', localize('editorView', "Editor"), async () => {
					await this.commandService.executeCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID);
					return this._openEditorWindow();
				}),
			];

			for (const button of buttons) {
				this._container.appendChild(button);
			}

			this._updateChecked(buttons, activePage);
		} finally {
			this._isRendering = false;
		}
	}

	private _createSwitchButton(page: TitlebarPage, label: string, run: () => Promise<unknown> | undefined): HTMLButtonElement {
		const button = $('button.agent-sessions-titlebar-switch-button') as HTMLButtonElement;
		button.type = 'button';
		button.dataset.page = page;
		button.textContent = label;
		button.setAttribute('role', 'tab');
		button.title = label;

		this._dynamicDisposables.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			run();
		}));
		this._dynamicDisposables.add(addDisposableListener(button, EventType.KEY_DOWN, event => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault();
				event.stopPropagation();
				this._focusAdjacentButton(button, event.key === 'ArrowRight');
			}
		}));

		return button;
	}

	private _updateChecked(buttons: HTMLButtonElement[], activePage: TitlebarPage): void {
		for (const button of buttons) {
			const checked = button.dataset.page === activePage;
			button.classList.toggle('checked', checked);
			button.setAttribute('aria-selected', String(checked));
			button.tabIndex = checked ? 0 : -1;
		}
	}

	private _focusAdjacentButton(button: HTMLButtonElement, next: boolean): void {
		const buttons = Array.from(button.parentElement?.querySelectorAll<HTMLButtonElement>('.agent-sessions-titlebar-switch-button') ?? []);
		const index = buttons.indexOf(button);
		if (index === -1) {
			return;
		}
		const nextIndex = (index + (next ? 1 : -1) + buttons.length) % buttons.length;
		buttons[nextIndex]?.focus();
	}

	private _openEditorWindow(): Promise<unknown> {
		const commandId = CommandsRegistry.getCommand(OPEN_SESSION_IN_VSCODE_COMMAND_ID) ? OPEN_SESSION_IN_VSCODE_COMMAND_ID : OPEN_IN_VSCODE_COMMAND_ID;
		return this.commandService.executeCommand(commandId);
	}

	private _getActivePage(): TitlebarPage {
		return 'sandbox';
	}

	/**
	 * Get the display title for the active session.
	 */
	private _getSessionTitle(): string | undefined {
		const sessionData = this.sessionsManagementService.activeSession.get();
		return sessionData?.title.get()?.trim() || undefined;
	}

	/**
	 * Get the repository label for the active session.
	 */
	private _getRepositoryLabel(): string | undefined {
		const sessionData = this.sessionsManagementService.activeSession.get();
		if (sessionData) {
			const workspace = sessionData.workspace.get();
			if (workspace) {
				return workspace.label;
			}
		}
		return undefined;
	}

}

/**
 * Provides custom rendering for the sessions title bar widget
 * in the command center. Uses IActionViewItemService to render a custom widget
 * for the TitleBarControlMenu submenu.
 */
export class SessionsTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessionsTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Register the submenu item in the Agent Sessions command center
		this._register(MenuRegistry.appendMenuItem(Menus.CommandCenter, {
			submenu: Menus.TitleBarSessionTitle,
			title: localize('agentSessionsControl', "Sandbox"),
			order: 101,
			when: ContextKeyExpr.and(IsAuxiliaryWindowContext.negate(), SessionsWelcomeVisibleContext.negate())
		}));

		// Register a placeholder action so the submenu appears
		this._register(MenuRegistry.appendMenuItem(Menus.TitleBarSessionTitle, {
			command: {
				id: SHOW_SESSIONS_PICKER_COMMAND_ID,
				title: localize('showSessions', "Show Sandbox"),
			},
			group: 'a_sessions',
			order: 1,
			when: IsAuxiliaryWindowContext.negate()
		}));

		this._register(actionViewItemService.register(Menus.CommandCenter, Menus.TitleBarSessionTitle, (action, options) => {
			if (!(action instanceof SubmenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(SessionsTitleBarWidget, action, options);
		}, undefined));
	}
}
