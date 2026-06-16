/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacePage.css';
import { $, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';
import { IAgentSession, getAgentChangesSummary, isSessionInProgressStatus } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';

export const OPEN_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.openWorkspacePage';
export const CLOSE_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.closeWorkspacePage';
export const WORKSPACE_PAGE_VISIBLE_CONTEXT_KEY = 'workspacePageVisible';

const OPEN_BACKBOARD_RIGHT_PANEL_COMMAND_ID = 'backboard.openRightPanel';
const WORKSPACE_CARD_SLOTS = 6;

type WorkspaceTone = 'live' | 'needsInput' | 'done' | 'failed';

export const WorkspacePageVisibleContext = new RawContextKey<boolean>(
	WORKSPACE_PAGE_VISIBLE_CONTEXT_KEY,
	false,
	localize('workspacePageVisibleContext', "Whether the Workspace page is visible.")
);

class WorkspacePageContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspacePage';

	private readonly visibleContext: IContextKey<boolean>;
	private container: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private workspaceShell: HTMLElement | undefined;
	private workspaceMain: HTMLElement | undefined;
	private statusBar: HTMLElement | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.visibleContext = WorkspacePageVisibleContext.bindTo(contextKeyService);
		this._register(CommandsRegistry.registerCommand(OPEN_WORKSPACE_PAGE_COMMAND_ID, () => this.show()));
		this._register(CommandsRegistry.registerCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID, () => this.hide()));
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.render()));
	}

	private show(): void {
		if (!this.container) {
			this.create();
		}

		this.render();
		this.container?.classList.add('visible');
		this.container?.setAttribute('aria-hidden', 'false');
		this.visibleContext.set(true);
		this.container?.focus();
		void this.openBackboardRightPanel();
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

		this.body = $('div.workspace-page-body');
		container.appendChild(this.body);

		this.layoutService.mainContainer.appendChild(container);
		this.container = container;
	}

	private render(): void {
		if (!this.body) {
			return;
		}

		const sessions = this.getVisibleSessions();
		if (!this.workspaceShell || !this.workspaceMain || !this.statusBar) {
			clearNode(this.body);
			this.workspaceShell = this.createWorkspaceShell(sessions);
			this.body.appendChild(this.workspaceShell);
			this.statusBar = this.createStatusBar(sessions);
			this.body.appendChild(this.statusBar);
			return;
		}

		const workspaceMain = this.createWorkspaceMain(sessions);
		this.workspaceShell.replaceChild(workspaceMain, this.workspaceMain);
		this.workspaceMain = workspaceMain;

		const statusBar = this.createStatusBar(sessions);
		this.body.replaceChild(statusBar, this.statusBar);
		this.statusBar = statusBar;
	}

	private getVisibleSessions(): IAgentSession[] {
		return this.agentSessionsService.model.sessions
			.filter(session => !session.isArchived())
			.sort((a, b) => (b.timing.lastRequestStarted ?? b.timing.created) - (a.timing.lastRequestStarted ?? a.timing.created))
			.slice(0, WORKSPACE_CARD_SLOTS);
	}

	private createWorkspaceShell(sessions: readonly IAgentSession[]): HTMLElement {
		const shell = $('div.workspace-page-shell');
		this.workspaceMain = this.createWorkspaceMain(sessions);
		shell.appendChild(this.workspaceMain);
		return shell;
	}

	private createWorkspaceMain(sessions: readonly IAgentSession[]): HTMLElement {
		const main = $('section.workspace-page-main');
		main.setAttribute('aria-labelledby', 'workspace-page-heading');

		const header = $('div.workspace-page-main-header');
		const heading = $('div.workspace-page-heading-block');
		const title = $('h1.workspace-page-title');
		title.id = 'workspace-page-heading';
		title.textContent = localize('workspacePage.title', "Agent Workspace");
		const count = $('span.workspace-page-count');
		count.textContent = sessions.length === 1
			? localize('workspacePage.countOne', "1 agent")
			: localize('workspacePage.count', "{0} agents", sessions.length);
		heading.append(title, count);
		header.appendChild(heading);

		const actions = $('div.workspace-page-header-actions');
		actions.append(
			this.createIconButton('filter', localize('workspacePage.action.filter', "Filter agents")),
			this.createIconButton('sort-precedence', localize('workspacePage.action.sort', "Sort agents")),
		);
		header.appendChild(actions);
		main.appendChild(header);

		const grid = $('div.workspace-page-agent-grid');
		for (const session of sessions) {
			grid.appendChild(this.createAgentCard(session));
		}

		for (let i = sessions.length; i < WORKSPACE_CARD_SLOTS; i++) {
			grid.appendChild(this.createPlaceholderCard());
		}
		main.appendChild(grid);

		return main;
	}

	private createAgentCard(session: IAgentSession): HTMLElement {
		const tone = this.getTone(session);
		const card = $('article.workspace-page-agent-card');
		card.dataset.tone = tone;
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.setAttribute('aria-label', localize('workspacePage.openAgent', "Open {0}", session.label));

		this._register(addDisposableListener(card, EventType.CLICK, () => this.openAgentSession(session)));
		this._register(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void this.openAgentSession(session);
			}
		}));

		const header = $('div.workspace-page-agent-header');
		const titleWrap = $('div.workspace-page-agent-title-wrap');
		const statusDot = $('span.workspace-page-status-dot');
		statusDot.dataset.tone = tone;
		const title = $('h2.workspace-page-agent-title');
		title.textContent = session.label;
		titleWrap.append(statusDot, title);
		header.append(titleWrap, this.createStatusPill(this.getStatusLabel(session), tone), this.createIconButton('kebab-vertical', localize('workspacePage.agent.more', "Agent actions")));
		card.appendChild(header);

		const description = this.getDescription(session);
		if (description) {
			const command = $('div.workspace-page-command-row');
			const descriptionLabel = $('span.workspace-page-command-description');
			descriptionLabel.textContent = description;
			command.appendChild(descriptionLabel);
			card.appendChild(command);
		}

		const activityList = $('div.workspace-page-activity-list');
		activityList.appendChild(this.createActivityRow(session));
		card.appendChild(activityList);

		const chips = this.getChips(session);
		if (chips.length) {
			const files = $('div.workspace-page-file-list');
			for (const chipLabel of chips) {
				const chip = $('span.workspace-page-file-chip');
				chip.textContent = chipLabel;
				files.appendChild(chip);
			}
			card.appendChild(files);
		}

		card.appendChild(this.createCardFooter(session));
		return card;
	}

	private createActivityRow(session: IAgentSession): HTMLElement {
		const tone = this.getTone(session);
		const row = $('div.workspace-page-activity-row');
		row.dataset.tone = tone;
		const icon = $('span.codicon.workspace-page-activity-icon');
		icon.classList.add(this.getActivityIcon(session));
		const label = $('span.workspace-page-activity-label');
		label.textContent = this.getActivityLabel(session);
		row.append(icon, label);
		return row;
	}

	private createCardFooter(session: IAgentSession): HTMLElement {
		const footer = $('div.workspace-page-agent-footer');
		const branch = $('span.workspace-page-agent-branch');
		const branchIcon = $('span.codicon.codicon-git-branch.workspace-page-inline-icon');
		const branchLabel = $('span');
		branchLabel.textContent = this.getBranchLabel(session);
		branch.append(branchIcon, branchLabel);

		const model = $('span.workspace-page-agent-model');
		model.textContent = session.providerLabel;
		const openIcon = $('span.codicon.codicon-link-external.workspace-page-inline-icon');
		footer.append(branch, model, openIcon);
		return footer;
	}

	private createPlaceholderCard(): HTMLElement {
		const card = $('article.workspace-page-placeholder-card');
		card.setAttribute('aria-hidden', 'true');

		const header = $('div.workspace-page-placeholder-header');
		header.append($('span.workspace-page-placeholder-dot'), $('span.workspace-page-placeholder-line.name'), $('span.workspace-page-placeholder-spacer'), $('span.workspace-page-placeholder-line.pill'));
		card.appendChild(header);

		const command = $('div.workspace-page-placeholder-command');
		command.append(
			$('span.workspace-page-placeholder-line.short'),
			$('span.workspace-page-placeholder-line.long'),
			$('span.workspace-page-placeholder-line.medium'),
		);
		card.appendChild(command);

		const activity = $('div.workspace-page-placeholder-activity');
		for (let i = 0; i < 4; i++) {
			activity.appendChild($('span.workspace-page-placeholder-line.row'));
		}
		card.appendChild(activity);

		const footer = $('div.workspace-page-placeholder-footer');
		footer.append($('span.workspace-page-placeholder-icon'), $('span.workspace-page-placeholder-spacer'), $('span.workspace-page-placeholder-line.model'));
		card.appendChild(footer);

		return card;
	}

	private createStatusBar(sessions: readonly IAgentSession[]): HTMLElement {
		const statusBar = $('footer.workspace-page-statusbar');
		const left = $('div.workspace-page-statusbar-group');
		left.append(
			this.createStatusItem('git-branch', this.getBranchSummary(sessions)),
			this.createStatusItem('sync', localize('workspacePage.status.sync', "Synced")),
			this.createStatusItem('robot', sessions.length === 1 ? localize('workspacePage.status.oneAgent', "1 agent") : localize('workspacePage.status.agents', "{0} agents", sessions.length)),
		);
		const right = $('div.workspace-page-statusbar-group');
		right.append(
			this.createStatusItem('check', localize('workspacePage.status.ready', "Workspace ready")),
			this.createStatusItem('bell', localize('workspacePage.status.notifications', "0")),
		);
		statusBar.append(left, right);
		return statusBar;
	}

	private createStatusItem(icon: string, label: string): HTMLElement {
		const item = $('span.workspace-page-statusbar-item');
		const iconElement = $('span.codicon.workspace-page-inline-icon');
		iconElement.classList.add(`codicon-${icon}`);
		const labelElement = $('span');
		labelElement.textContent = label;
		item.append(iconElement, labelElement);
		return item;
	}

	private createStatusPill(label: string, tone: WorkspaceTone): HTMLElement {
		const pill = $('span.workspace-page-status-pill');
		pill.dataset.tone = tone;
		pill.textContent = label;
		return pill;
	}

	private createIconButton(icon: string, label: string): HTMLButtonElement {
		const button = $('button.workspace-page-icon-button') as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		const iconElement = $('span.codicon');
		iconElement.classList.add(`codicon-${icon}`);
		button.appendChild(iconElement);
		return button;
	}

	private getTone(session: IAgentSession): WorkspaceTone {
		switch (session.status) {
			case ChatSessionStatus.InProgress:
				return 'live';
			case ChatSessionStatus.NeedsInput:
				return 'needsInput';
			case ChatSessionStatus.Failed:
				return 'failed';
			default:
				return 'done';
		}
	}

	private getStatusLabel(session: IAgentSession): string {
		switch (session.status) {
			case ChatSessionStatus.InProgress:
				return localize('workspacePage.status.live', "LIVE");
			case ChatSessionStatus.NeedsInput:
				return localize('workspacePage.status.needsInput', "NEEDS INPUT");
			case ChatSessionStatus.Failed:
				return localize('workspacePage.status.failed', "FAILED");
			default:
				return localize('workspacePage.status.done', "DONE");
		}
	}

	private getActivityIcon(session: IAgentSession): string {
		switch (session.status) {
			case ChatSessionStatus.InProgress:
				return 'codicon-loading';
			case ChatSessionStatus.NeedsInput:
				return 'codicon-warning';
			case ChatSessionStatus.Failed:
				return 'codicon-error';
			default:
				return 'codicon-check';
		}
	}

	private getActivityLabel(session: IAgentSession): string {
		if (session.status === ChatSessionStatus.InProgress) {
			return localize('workspacePage.activity.working', "Working...");
		}
		if (session.status === ChatSessionStatus.NeedsInput) {
			return localize('workspacePage.activity.needsInput', "Input needed");
		}
		if (session.status === ChatSessionStatus.Failed) {
			return localize('workspacePage.activity.failed', "Failed");
		}
		return localize('workspacePage.activity.completed', "Completed");
	}

	private getDescription(session: IAgentSession): string {
		if (session.description) {
			return typeof session.description === 'string' ? session.description : renderAsPlaintext(session.description);
		}
		if (isSessionInProgressStatus(session.status)) {
			return this.getActivityLabel(session);
		}
		return typeof session.badge === 'string' ? session.badge : session.badge ? renderAsPlaintext(session.badge) : '';
	}

	private getChips(session: IAgentSession): string[] {
		if (Array.isArray(session.changes)) {
			return session.changes
				.map(change => basename(('modifiedUri' in change ? change.modifiedUri : change.uri) as URI))
				.filter(label => !!label)
				.slice(0, 3);
		}

		const summary = getAgentChangesSummary(session.changes);
		if (summary?.files) {
			return [summary.files === 1 ? localize('workspacePage.files.one', "1 file") : localize('workspacePage.files.count', "{0} files", summary.files)];
		}

		return [];
	}

	private getBranchLabel(session: IAgentSession): string {
		const metadata = session.metadata;
		return String(metadata?.branchName ?? metadata?.branch ?? metadata?.baseBranchName ?? metadata?.baseBranch ?? localize('workspacePage.branch.unknown', "workspace"));
	}

	private getBranchSummary(sessions: readonly IAgentSession[]): string {
		return sessions[0] ? this.getBranchLabel(sessions[0]) : localize('workspacePage.branch.main', "main");
	}

	private async openAgentSession(_session: IAgentSession): Promise<void> {
		await this.openBackboardRightPanel();
	}

	private async openBackboardRightPanel(): Promise<void> {
		try {
			await this.commandService.executeCommand(OPEN_BACKBOARD_RIGHT_PANEL_COMMAND_ID);
		} catch {
			// The Backboard extension owns this command and may not be available in all builds.
		}
	}
}

registerWorkbenchContribution2(WorkspacePageContribution.ID, WorkspacePageContribution, WorkbenchPhase.BlockStartup);
