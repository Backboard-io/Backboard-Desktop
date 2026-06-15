/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacePage.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

export const OPEN_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.openWorkspacePage';
export const CLOSE_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.closeWorkspacePage';
export const WORKSPACE_PAGE_VISIBLE_CONTEXT_KEY = 'workspacePageVisible';

const OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID = 'workbench.action.openWorkspaceInAgentsWindow';
const FOCUS_ACTIVE_EDITOR_GROUP_COMMAND_ID = 'workbench.action.focusActiveEditorGroup';

type WorkspacePageMode = 'sandbox' | 'editor' | 'workspace';

export const WorkspacePageVisibleContext = new RawContextKey<boolean>(
	WORKSPACE_PAGE_VISIBLE_CONTEXT_KEY,
	false,
	localize('workspacePageVisibleContext', "Whether the Workspace page is visible.")
);

class WorkspacePageContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspacePage';

	private readonly visibleContext: IContextKey<boolean>;
	private container: HTMLElement | undefined;
	private navButtons: HTMLButtonElement[] = [];

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.visibleContext = WorkspacePageVisibleContext.bindTo(contextKeyService);
		this._register(CommandsRegistry.registerCommand(OPEN_WORKSPACE_PAGE_COMMAND_ID, () => this.show()));
		this._register(CommandsRegistry.registerCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID, () => this.hide()));
	}

	private show(): void {
		if (this.visibleContext.get()) {
			this.container?.focus();
			return;
		}

		if (!this.container) {
			this.create();
		}

		this.container?.classList.add('visible');
		this.container?.setAttribute('aria-hidden', 'false');
		this.visibleContext.set(true);
		this.container?.focus();
	}

	private hide(): void {
		if (!this.visibleContext.get()) {
			return;
		}

		this.container?.classList.remove('visible');
		this.container?.setAttribute('aria-hidden', 'true');
		this.visibleContext.set(false);
	}

	private create(): void {
		const container = document.createElement('div');
		container.classList.add('workspace-page');
		container.tabIndex = -1;
		container.setAttribute('role', 'main');
		container.setAttribute('aria-label', localize('workspacePageLabel', "Workspace"));
		container.setAttribute('aria-hidden', 'true');
		container.appendChild(this.createNavbar());
		this.layoutService.mainContainer.appendChild(container);
		this.container = container;
	}

	private createNavbar(): HTMLElement {
		const nav = $('div.workspace-page-navbar');
		nav.setAttribute('role', 'tablist');
		nav.setAttribute('aria-label', localize('workspacePageNavbarAriaLabel', "IDE view"));

		this.navButtons = [
			this.createNavbarButton('sandbox', localize('sandboxView', "Sandbox"), async () => {
				this.hide();
				await this.commandService.executeCommand(OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID);
			}),
			this.createNavbarButton('editor', localize('editorView', "Editor"), async () => {
				this.hide();
				await this.commandService.executeCommand(FOCUS_ACTIVE_EDITOR_GROUP_COMMAND_ID);
			}),
			this.createNavbarButton('workspace', localize('workspaceView', "Workspace"), async () => {
				this.show();
			}),
		];

		for (const button of this.navButtons) {
			nav.appendChild(button);
		}

		this.updateNavbarChecked();
		return nav;
	}

	private createNavbarButton(mode: WorkspacePageMode, label: string, run: () => void | Promise<void>): HTMLButtonElement {
		const button = $('button.workspace-page-navbar-button') as HTMLButtonElement;
		button.type = 'button';
		button.dataset.mode = mode;
		button.textContent = label;
		button.setAttribute('role', 'tab');
		button.title = label;

		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			void run();
		}));
		this._register(addDisposableListener(button, EventType.KEY_DOWN, event => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault();
				event.stopPropagation();
				this.focusAdjacentNavbarButton(button, event.key === 'ArrowRight');
			}
		}));

		return button;
	}

	private updateNavbarChecked(): void {
		for (const button of this.navButtons) {
			const checked = button.dataset.mode === 'workspace';
			button.classList.toggle('checked', checked);
			button.setAttribute('aria-selected', String(checked));
			button.tabIndex = checked ? 0 : -1;
		}
	}

	private focusAdjacentNavbarButton(button: HTMLButtonElement, next: boolean): void {
		const index = this.navButtons.indexOf(button);
		if (index === -1) {
			return;
		}

		const nextIndex = (index + (next ? 1 : -1) + this.navButtons.length) % this.navButtons.length;
		this.navButtons[nextIndex]?.focus();
	}
}

registerWorkbenchContribution2(WorkspacePageContribution.ID, WorkspacePageContribution, WorkbenchPhase.BlockStartup);
