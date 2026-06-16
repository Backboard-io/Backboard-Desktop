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
type WorkspaceViewStateId = 'activeAgents' | 'mixedStatus' | 'completed' | 'chatClosed' | 'chatOpen' | 'chatRunning' | 'chatReview';
type WorkspaceAgentTone = 'live' | 'queued' | 'done' | 'warning';
type WorkspacePanelKind = 'handoff' | 'closed' | 'open' | 'running' | 'review';

interface WorkspaceActivity {
	readonly label: string;
	readonly detail: string;
	readonly tone: WorkspaceAgentTone;
}

interface WorkspaceAgent {
	readonly title: string;
	readonly status: string;
	readonly tone: WorkspaceAgentTone;
	readonly command: string;
	readonly description: string;
	readonly activities: readonly WorkspaceActivity[];
	readonly files: readonly string[];
	readonly model: string;
}

interface WorkspacePanelMessage {
	readonly author: string;
	readonly body: string;
	readonly tone?: WorkspaceAgentTone;
}

interface WorkspacePanel {
	readonly kind: WorkspacePanelKind;
	readonly title: string;
	readonly description: string;
	readonly primaryAction?: string;
	readonly secondaryActions?: readonly string[];
	readonly suggestions?: readonly string[];
	readonly messages?: readonly WorkspacePanelMessage[];
	readonly composerPlaceholder: string;
}

interface WorkspaceViewState {
	readonly id: WorkspaceViewStateId;
	readonly title: string;
	readonly count: string;
	readonly agents: readonly WorkspaceAgent[];
	readonly panel: WorkspacePanel;
}

const WORKSPACE_VIEW_STATES: Record<WorkspaceViewStateId, WorkspaceViewState> = {
	activeAgents: {
		id: 'activeAgents',
		title: localize('workspacePage.activeAgents.title', "Agent Workspace"),
		count: localize('workspacePage.activeAgents.count', "3 agents"),
		agents: [
			{
				title: 'refactor-api',
				status: localize('workspacePage.agent.status.live', "LIVE"),
				tone: 'live',
				command: '$ build',
				description: localize('workspacePage.agent.refactor.description', "Reworking API boundaries and checking affected imports."),
				activities: [
					{ label: localize('workspacePage.activity.scanning', "Scanning"), detail: localize('workspacePage.activity.refactor.scanning', "routes and middleware"), tone: 'live' },
					{ label: localize('workspacePage.activity.editing', "Editing"), detail: 'api.ts', tone: 'live' },
					{ label: localize('workspacePage.activity.completed', "Completed"), detail: localize('workspacePage.activity.types', "type cleanup"), tone: 'done' },
				],
				files: ['api.ts', 'auth.ts', 'helpers.ts'],
				model: 'Haiku 4.5',
			},
			{
				title: 'workspace-ui',
				status: localize('workspacePage.agent.status.live', "LIVE"),
				tone: 'live',
				command: '$ test',
				description: localize('workspacePage.agent.ui.description', "Matching the workspace shell to the latest Figma view."),
				activities: [
					{ label: localize('workspacePage.activity.rendering', "Rendering"), detail: localize('workspacePage.activity.ui.rendering', "agent cards"), tone: 'live' },
					{ label: localize('workspacePage.activity.checking', "Checking"), detail: localize('workspacePage.activity.ui.checking', "theme tokens"), tone: 'queued' },
					{ label: localize('workspacePage.activity.completed', "Completed"), detail: localize('workspacePage.activity.nav', "navigation shell"), tone: 'done' },
				],
				files: ['workspacePage.ts', 'workspacePage.css'],
				model: 'Sonnet 4.5',
			},
			{
				title: 'fix-layout',
				status: localize('workspacePage.agent.status.review', "REVIEW"),
				tone: 'warning',
				command: '$ lint',
				description: localize('workspacePage.agent.layout.description', "Verifying spacing, overflow, and panel behavior."),
				activities: [
					{ label: localize('workspacePage.activity.waiting', "Waiting"), detail: localize('workspacePage.activity.layout.waiting', "visual review"), tone: 'warning' },
					{ label: localize('workspacePage.activity.completed', "Completed"), detail: localize('workspacePage.activity.layout.completed', "responsive pass"), tone: 'done' },
				],
				files: ['layoutService.ts', 'style.css'],
				model: 'Auto',
			},
		],
		panel: {
			kind: 'handoff',
			title: localize('workspacePage.panel.handoff.title', "Agent moved to workspace"),
			description: localize('workspacePage.panel.handoff.description', "Your agent is now running in the workspace. Start another task here, ask a follow-up, or attach more context."),
			primaryAction: localize('workspacePage.panel.handoff.primary', "Start another agent"),
			secondaryActions: [
				localize('workspacePage.panel.handoff.followUp', "Ask a follow-up"),
				localize('workspacePage.panel.handoff.history', "Open history"),
				localize('workspacePage.panel.handoff.attach', "Attach context"),
			],
			suggestions: [
				localize('workspacePage.panel.suggestion.reviewChanges', "Review recent changes"),
				localize('workspacePage.panel.suggestion.newScreen', "Create a new screen"),
				localize('workspacePage.panel.suggestion.fixLayout', "Fix layout issues"),
				localize('workspacePage.panel.suggestion.explainFile', "Explain this file"),
				localize('workspacePage.panel.suggestion.findBugs', "Find bugs"),
			],
			composerPlaceholder: localize('workspacePage.panel.placeholder.start', "Start another agent, ask a follow-up, or @ mention context..."),
		},
	},
	mixedStatus: {
		id: 'mixedStatus',
		title: localize('workspacePage.mixedStatus.title', "Agent Workspace"),
		count: localize('workspacePage.mixedStatus.count', "3 agents"),
		agents: [],
		panel: {
			kind: 'handoff',
			title: localize('workspacePage.panel.mixed.title', "Workspace is coordinating agents"),
			description: localize('workspacePage.panel.mixed.description', "Some agents are running, some are waiting, and completed work is ready for review."),
			composerPlaceholder: localize('workspacePage.panel.placeholder.followUp', "Ask a follow-up or start the next task..."),
		},
	},
	completed: {
		id: 'completed',
		title: localize('workspacePage.completed.title', "Agent Workspace"),
		count: localize('workspacePage.completed.count', "3 completed"),
		agents: [],
		panel: {
			kind: 'review',
			title: localize('workspacePage.panel.completed.title', "All agents completed"),
			description: localize('workspacePage.panel.completed.description', "Review the completed changes or start another task from the workspace."),
			composerPlaceholder: localize('workspacePage.panel.placeholder.review', "Ask about these results..."),
		},
	},
	chatClosed: {
		id: 'chatClosed',
		title: localize('workspacePage.chatClosed.title', "Agent Workspace"),
		count: localize('workspacePage.chatClosed.count', "2 agents"),
		agents: [],
		panel: {
			kind: 'closed',
			title: localize('workspacePage.panel.closed.title', "Chat closed"),
			description: localize('workspacePage.panel.closed.description', "The workspace remains active while the chat panel is closed."),
			primaryAction: localize('workspacePage.panel.closed.primary', "Open chat"),
			composerPlaceholder: localize('workspacePage.panel.placeholder.openChat', "Open chat to continue..."),
		},
	},
	chatOpen: {
		id: 'chatOpen',
		title: localize('workspacePage.chatOpen.title', "Agent Workspace"),
		count: localize('workspacePage.chatOpen.count', "2 agents"),
		agents: [],
		panel: {
			kind: 'open',
			title: localize('workspacePage.panel.open.title', "Screen modification"),
			description: localize('workspacePage.panel.open.description', "Chat is ready for follow-up work in this workspace."),
			messages: [
				{ author: localize('workspacePage.message.you', "You"), body: localize('workspacePage.message.open.user', "Make the workspace match the new design.") },
				{ author: localize('workspacePage.message.agent', "Agent"), body: localize('workspacePage.message.open.agent', "I can update the workspace layout and keep the mode switch intact."), tone: 'live' },
			],
			composerPlaceholder: localize('workspacePage.panel.placeholder.reply', "Ask a follow-up..."),
		},
	},
	chatRunning: {
		id: 'chatRunning',
		title: localize('workspacePage.chatRunning.title', "Agent Workspace"),
		count: localize('workspacePage.chatRunning.count', "2 agents"),
		agents: [],
		panel: {
			kind: 'running',
			title: localize('workspacePage.panel.running.title', "Screen modification"),
			description: localize('workspacePage.panel.running.description', "The agent is applying the requested workspace changes."),
			messages: [
				{ author: localize('workspacePage.message.agent', "Agent"), body: localize('workspacePage.message.running.agent', "Updating layout, cards, and panel states..."), tone: 'live' },
			],
			composerPlaceholder: localize('workspacePage.panel.placeholder.running', "Add more context while the agent runs..."),
		},
	},
	chatReview: {
		id: 'chatReview',
		title: localize('workspacePage.chatReview.title', "Agent Workspace"),
		count: localize('workspacePage.chatReview.count', "2 agents"),
		agents: [],
		panel: {
			kind: 'review',
			title: localize('workspacePage.panel.review.title', "Ready for review"),
			description: localize('workspacePage.panel.review.description', "The agent finished and is waiting for your review."),
			primaryAction: localize('workspacePage.panel.review.primary', "Review changes"),
			composerPlaceholder: localize('workspacePage.panel.placeholder.reviewChanges', "Ask for revisions or approve the result..."),
		},
	},
};

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
	private viewState: WorkspaceViewStateId = 'activeAgents';

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
		container.appendChild(this.createWorkspaceBody());
		this.layoutService.mainContainer.appendChild(container);
		this.container = container;
	}

	private createWorkspaceBody(): HTMLElement {
		const state = WORKSPACE_VIEW_STATES[this.viewState];
		const body = $('div.workspace-page-body');
		body.dataset.state = state.id;
		body.appendChild(this.createWorkspaceShell(state));
		body.appendChild(this.createStatusBar(state));
		return body;
	}

	private createWorkspaceShell(state: WorkspaceViewState): HTMLElement {
		const shell = $('div.workspace-page-shell');
		shell.appendChild(this.createWorkspaceMain(state));
		shell.appendChild(this.createWorkspacePanel(state.panel));
		return shell;
	}

	private createWorkspaceMain(state: WorkspaceViewState): HTMLElement {
		const main = $('section.workspace-page-main');
		main.setAttribute('aria-labelledby', 'workspace-page-heading');

		const header = $('div.workspace-page-main-header');
		const heading = $('div.workspace-page-heading-block');
		const title = $('h1.workspace-page-title');
		title.id = 'workspace-page-heading';
		title.textContent = state.title;
		const count = $('span.workspace-page-count');
		count.textContent = state.count;
		heading.append(title, count);
		header.appendChild(heading);

		const actions = $('div.workspace-page-header-actions');
		actions.append(
			this.createIconButton('search', localize('workspacePage.action.search', "Search workspace")),
			this.createIconButton('refresh', localize('workspacePage.action.refresh', "Refresh workspace")),
			this.createIconButton('kebab-vertical', localize('workspacePage.action.more', "More actions")),
		);
		header.appendChild(actions);
		main.appendChild(header);

		const grid = $('div.workspace-page-agent-grid');
		for (const agent of this.getAgentsForState(state)) {
			grid.appendChild(this.createAgentCard(agent));
		}
		main.appendChild(grid);

		return main;
	}

	private createAgentCard(agent: WorkspaceAgent): HTMLElement {
		const card = $('article.workspace-page-agent-card');
		card.dataset.tone = agent.tone;

		const header = $('div.workspace-page-agent-header');
		const titleWrap = $('div.workspace-page-agent-title-wrap');
		const statusDot = $('span.workspace-page-status-dot');
		statusDot.dataset.tone = agent.tone;
		const title = $('h2.workspace-page-agent-title');
		title.textContent = agent.title;
		titleWrap.append(statusDot, title);
		header.append(titleWrap, this.createStatusPill(agent.status, agent.tone), this.createIconButton('kebab-vertical', localize('workspacePage.agent.more', "Agent actions")));
		card.appendChild(header);

		const command = $('div.workspace-page-command-row');
		const commandLabel = $('span.workspace-page-command');
		commandLabel.textContent = agent.command;
		const description = $('span.workspace-page-command-description');
		description.textContent = agent.description;
		command.append(commandLabel, description);
		card.appendChild(command);

		const activityList = $('div.workspace-page-activity-list');
		for (const activity of agent.activities) {
			activityList.appendChild(this.createActivityRow(activity));
		}
		card.appendChild(activityList);

		const files = $('div.workspace-page-file-list');
		for (const file of agent.files) {
			const chip = $('span.workspace-page-file-chip');
			chip.textContent = file;
			files.appendChild(chip);
		}
		card.appendChild(files);

		const footer = $('div.workspace-page-agent-footer');
		const branch = $('span.workspace-page-agent-branch');
		const branchIcon = $('span.codicon.codicon-git-branch.workspace-page-inline-icon');
		const branchLabel = $('span');
		branchLabel.textContent = localize('workspacePage.agent.branch', "workspace");
		branch.append(branchIcon, branchLabel);
		const model = $('span.workspace-page-agent-model');
		model.textContent = agent.model;
		const openIcon = $('span.codicon.codicon-link-external.workspace-page-inline-icon');
		footer.append(branch, model, openIcon);
		card.appendChild(footer);

		return card;
	}

	private createWorkspacePanel(panel: WorkspacePanel): HTMLElement {
		const aside = $('aside.workspace-page-panel');
		aside.dataset.kind = panel.kind;

		const header = $('div.workspace-page-panel-header');
		const tab = $('div.workspace-page-panel-tab');
		const tabTitle = $('span.workspace-page-panel-tab-title');
		tabTitle.textContent = panel.title;
		tab.append($('span.codicon.codicon-comment-discussion.workspace-page-panel-tab-icon'), tabTitle);
		const actions = $('div.workspace-page-panel-actions');
		actions.append(
			this.createIconButton('add', localize('workspacePage.panel.newChat', "New chat")),
			this.createIconButton('history', localize('workspacePage.panel.history', "Open history")),
			this.createIconButton('chrome-close', localize('workspacePage.panel.close', "Close panel")),
		);
		header.append(tab, actions);
		aside.appendChild(header);

		const content = $('div.workspace-page-panel-content');
		if (panel.messages?.length) {
			content.appendChild(this.createPanelMessages(panel.messages));
		} else {
			content.appendChild(this.createPanelEmptyState(panel));
		}
		aside.appendChild(content);
		aside.appendChild(this.createComposer(panel));

		return aside;
	}

	private createPanelEmptyState(panel: WorkspacePanel): HTMLElement {
		const empty = $('div.workspace-page-panel-empty');
		const mark = $('div.workspace-page-panel-mark');
		mark.appendChild($('span.codicon.codicon-sparkle'));
		const title = $('h2.workspace-page-panel-title');
		title.textContent = panel.title;
		const description = $('p.workspace-page-panel-description');
		description.textContent = panel.description;
		empty.append(mark, title, description);

		if (panel.primaryAction) {
			const primary = $('button.workspace-page-panel-primary') as HTMLButtonElement;
			primary.type = 'button';
			primary.textContent = panel.primaryAction;
			empty.appendChild(primary);
		}

		if (panel.secondaryActions?.length) {
			const secondary = $('div.workspace-page-panel-secondary-actions');
			for (const action of panel.secondaryActions) {
				const button = $('button.workspace-page-panel-link') as HTMLButtonElement;
				button.type = 'button';
				button.textContent = action;
				secondary.appendChild(button);
			}
			empty.appendChild(secondary);
		}

		if (panel.suggestions?.length) {
			const suggestions = $('div.workspace-page-suggestion-list');
			for (const suggestion of panel.suggestions) {
				const chip = $('button.workspace-page-suggestion-chip') as HTMLButtonElement;
				chip.type = 'button';
				chip.textContent = suggestion;
				suggestions.appendChild(chip);
			}
			empty.appendChild(suggestions);
		}

		return empty;
	}

	private createPanelMessages(messages: readonly WorkspacePanelMessage[]): HTMLElement {
		const list = $('div.workspace-page-message-list');
		for (const message of messages) {
			const row = $('div.workspace-page-message');
			if (message.tone) {
				row.dataset.tone = message.tone;
			}
			const author = $('span.workspace-page-message-author');
			author.textContent = message.author;
			const body = $('p.workspace-page-message-body');
			body.textContent = message.body;
			row.append(author, body);
			list.appendChild(row);
		}
		return list;
	}

	private createComposer(panel: WorkspacePanel): HTMLElement {
		const composer = $('div.workspace-page-composer');
		const input = $('div.workspace-page-composer-input');
		input.textContent = panel.composerPlaceholder;
		const footer = $('div.workspace-page-composer-footer');
		const mode = $('span.workspace-page-composer-mode');
		mode.textContent = localize('workspacePage.composer.mode', "Agent");
		const model = $('span.workspace-page-composer-model');
		model.textContent = localize('workspacePage.composer.model', "Auto");
		const tools = $('div.workspace-page-composer-tools');
		tools.append(
			this.createIconButton('mention', localize('workspacePage.composer.attachContext', "Attach context")),
			this.createIconButton('mic', localize('workspacePage.composer.voice', "Voice input")),
			this.createIconButton('send', localize('workspacePage.composer.send', "Send")),
		);
		footer.append(mode, model, tools);
		composer.append(input, footer);
		return composer;
	}

	private createActivityRow(activity: WorkspaceActivity): HTMLElement {
		const row = $('div.workspace-page-activity-row');
		row.dataset.tone = activity.tone;
		const icon = $('span.codicon.workspace-page-activity-icon');
		icon.classList.add(activity.tone === 'done' ? 'codicon-check' : activity.tone === 'warning' ? 'codicon-warning' : activity.tone === 'queued' ? 'codicon-clock' : 'codicon-loading');
		const label = $('span.workspace-page-activity-label');
		label.textContent = activity.label;
		const detail = $('span.workspace-page-activity-detail');
		detail.textContent = activity.detail;
		row.append(icon, label, detail);
		return row;
	}

	private createStatusBar(state: WorkspaceViewState): HTMLElement {
		const statusBar = $('footer.workspace-page-statusbar');
		const left = $('div.workspace-page-statusbar-group');
		left.append(
			this.createStatusItem('source-control', localize('workspacePage.status.branch', "main")),
			this.createStatusItem('sync', localize('workspacePage.status.sync', "Synced")),
			this.createStatusItem('robot', state.count),
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

	private createStatusPill(label: string, tone: WorkspaceAgentTone): HTMLElement {
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

	private getAgentsForState(state: WorkspaceViewState): readonly WorkspaceAgent[] {
		if (state.agents.length) {
			return state.agents;
		}

		const activeAgents = WORKSPACE_VIEW_STATES.activeAgents.agents;
		if (state.id === 'mixedStatus') {
			return [
				activeAgents[0],
				this.withAgentTone(activeAgents[1], localize('workspacePage.agent.status.queued', "QUEUED"), 'queued'),
				this.withAgentTone(activeAgents[2], localize('workspacePage.agent.status.done', "DONE"), 'done'),
			];
		}

		if (state.id === 'completed') {
			return activeAgents.map(agent => this.withAgentTone(agent, localize('workspacePage.agent.status.done', "DONE"), 'done'));
		}

		return activeAgents.slice(0, 2);
	}

	private withAgentTone(agent: WorkspaceAgent, status: string, tone: WorkspaceAgentTone): WorkspaceAgent {
		return {
			...agent,
			status,
			tone,
			activities: agent.activities.map(activity => ({ ...activity, tone })),
		};
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
