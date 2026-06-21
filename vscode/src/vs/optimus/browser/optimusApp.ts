/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IOptimusRun, IOptimusTranscript, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';
import { IOptimusHistoryEntry, IOptimusHistoryProvider, IOptimusWorkspaceEntry } from '../common/optimusHistory.js';
import { OptimusRunStore } from './optimusRunStore.js';

interface IOptimusStarterTask {
	readonly id: string;
	readonly provider: OptimusProvider;
}

const starterTasks: readonly IOptimusStarterTask[] = [
	{ id: 'slot-1', provider: OptimusProvider.Backboard },
	{ id: 'slot-2', provider: OptimusProvider.Backboard },
	{ id: 'slot-3', provider: OptimusProvider.Backboard },
	{ id: 'slot-4', provider: OptimusProvider.Backboard },
	{ id: 'slot-5', provider: OptimusProvider.Backboard },
	{ id: 'slot-6', provider: OptimusProvider.Backboard }
];

export class OptimusApp extends Disposable {

	private content!: HTMLElement;
	private cardGrid!: HTMLElement;
	private drawer!: HTMLElement;
	private drawerBody!: HTMLElement;
	private headerActions!: HTMLElement;
	private selectedTranscript: IOptimusTranscript | undefined;
	private isDrawerOpen = true;
	private drawerWidth = 430;
	private selectedStarter: IOptimusStarterTask | undefined;
	private selectedStarterSlot = 0;
	private readonly runSlots = new Map<string, number>();
	private historyEntries: readonly IOptimusHistoryEntry[] = [];
	private workspaces: readonly IOptimusWorkspaceEntry[] = [];
	private selectedWorkspace: string | undefined;
	private selectedHistory: IOptimusHistoryEntry | undefined;
	private isHistoryView = false;
	private isHistoryLoading = false;
	private historyLoadError: string | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly store: OptimusRunStore,
		private readonly historyProvider: IOptimusHistoryProvider | undefined = undefined
	) {
		super();
		this._register(this.store.onDidChange(() => this.renderRuns()));
	}

	start(): void {
		this.container.classList.add('optimus-root');
		this.container.appendChild(this.renderShell());
		this.renderRuns();
		this.refreshHistory().catch(error => {
			this.historyLoadError = error instanceof Error ? error.message : String(error);
			this.isHistoryLoading = false;
			this.renderDrawer();
		});
		this.refreshWorkspaces().catch(console.error);
	}

	private renderShell(): HTMLElement {
		const shell = document.createElement('div');
		shell.className = 'optimus-shell';

		const header = document.createElement('header');
		header.className = 'optimus-header';
		header.appendChild(this.renderBrand());
		this.headerActions = document.createElement('div');
		this.headerActions.className = 'optimus-header-actions';
		header.appendChild(this.headerActions);

		this.content = document.createElement('main');
		this.content.className = 'optimus-content';

		this.cardGrid = document.createElement('section');
		this.cardGrid.className = 'optimus-grid';

		this.drawer = document.createElement('aside');
		this.drawer.className = 'optimus-drawer';
		this.drawer.appendChild(this.renderDrawerResizeHandle());
		this.drawerBody = document.createElement('div');
		this.drawerBody.className = 'optimus-drawer-body';
		this.drawer.appendChild(this.drawerBody);

		this.content.appendChild(this.cardGrid);
		this.content.appendChild(this.drawer);
		shell.appendChild(header);
		shell.appendChild(this.content);
		this.updatePanelLayout();

		return shell;
	}

	private renderBrand(): HTMLElement {
		const brand = document.createElement('div');
		brand.className = 'optimus-brand';

		const title = document.createElement('h1');
		title.textContent = localize('optimus.title', "Optimus");

		const subtitle = document.createElement('p');
		subtitle.textContent = localize('optimus.subtitle', "Standalone multi-agent control surface");

		brand.appendChild(title);
		brand.appendChild(subtitle);
		return brand;
	}

	private renderHeaderActions(): void {
		this.headerActions.replaceChildren();

		const workspaceSelect = document.createElement('select');
		workspaceSelect.className = 'optimus-workspace-select';
		workspaceSelect.title = localize('optimus.workspace.select', "Select workspace");
		workspaceSelect.setAttribute('aria-label', workspaceSelect.title);
		workspaceSelect.appendChild(workspaceOption('', localize('optimus.workspace.all', "All workspaces"), this.historyEntries.length));
		for (const workspace of this.workspaces) {
			workspaceSelect.appendChild(workspaceOption(workspace.id, workspace.label, workspace.chatCount));
		}
		workspaceSelect.value = this.selectedWorkspace ?? '';
		workspaceSelect.addEventListener('change', () => {
			this.selectedWorkspace = workspaceSelect.value || undefined;
			if (this.selectedHistory && !this.historyMatchesSelectedWorkspace(this.selectedHistory)) {
				this.selectedHistory = undefined;
				this.isHistoryView = true;
			}
			this.renderRuns();
		});

		const newAgent = document.createElement('button');
		newAgent.type = 'button';
		newAgent.className = 'optimus-header-button';
		newAgent.textContent = localize('optimus.newAgent', "New Agent");
		newAgent.addEventListener('click', () => {
			this.selectStarter(this.nextOpenSlot());
		});

		const count = document.createElement('span');
		count.className = 'optimus-agent-count';
		const runCount = this.store.runs.length;
		count.textContent = runCount === 1
			? localize('optimus.agentCount.one', "1 agent")
			: localize('optimus.agentCount.many', "{0} agents", runCount);

		const togglePanel = document.createElement('button');
		togglePanel.type = 'button';
		togglePanel.className = 'optimus-header-button icon';
		togglePanel.textContent = this.isDrawerOpen ? '>' : '<';
		togglePanel.title = this.isDrawerOpen
			? localize('optimus.closeChat', "Close chat")
			: localize('optimus.openChatPanel', "Open chat");
		togglePanel.setAttribute('aria-label', togglePanel.title);
		togglePanel.addEventListener('click', () => {
			this.isDrawerOpen = !this.isDrawerOpen;
			this.updatePanelLayout();
			this.renderHeaderActions();
		});

		this.headerActions.appendChild(workspaceSelect);
		this.headerActions.appendChild(newAgent);
		this.headerActions.appendChild(count);
		this.headerActions.appendChild(togglePanel);
	}

	private renderTaskBoard(): HTMLElement {
		const board = document.createElement('section');
		board.className = 'optimus-task-board';
		board.setAttribute('aria-label', localize('optimus.taskBoard.label', "Optimus task launchers"));

		const slottedRuns = this.slottedRuns();
		for (let slot = 0; slot < starterTasks.length; slot++) {
			const run = slottedRuns.get(slot);
			board.appendChild(run ? this.renderRunCard(run) : this.renderStarterTask(slot));
		}

		return board;
	}

	private renderStarterTask(slot: number): HTMLElement {
		const starter = starterTasks[slot];
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `optimus-starter-card${this.selectedStarter?.id === starter.id ? ' selected' : ''}`;
		button.setAttribute('aria-label', localize('optimus.slot.newPrompt', "Start a new Optimus prompt in slot {0}", slot + 1));
		button.setAttribute('aria-pressed', this.selectedStarter?.id === starter.id ? 'true' : 'false');
		button.addEventListener('click', () => this.selectStarter(slot));

		button.append(
			this.renderStarterHeaderSkeleton(),
			this.renderStarterTitleSkeleton(),
			this.renderStarterRowsSkeleton(),
			this.renderStarterFooterSkeleton(),
			this.renderStarterComposerSkeleton()
		);
		return button;
	}

	private renderStarterHeaderSkeleton(): HTMLElement {
		const header = document.createElement('span');
		header.className = 'optimus-starter-preview-header';
		header.setAttribute('aria-hidden', 'true');
		header.appendChild(skeletonDot());
		header.appendChild(skeletonBar('medium'));

		const action = document.createElement('span');
		action.className = 'optimus-starter-action';
		action.textContent = '+';
		header.appendChild(action);

		return header;
	}

	private renderStarterTitleSkeleton(): HTMLElement {
		const title = document.createElement('span');
		title.className = 'optimus-starter-preview-title';
		title.setAttribute('aria-hidden', 'true');
		title.appendChild(skeletonBar('short'));
		title.appendChild(skeletonBar('small'));
		return title;
	}

	private renderStarterRowsSkeleton(): HTMLElement {
		const rows = document.createElement('span');
		rows.className = 'optimus-starter-preview-rows';
		rows.setAttribute('aria-hidden', 'true');
		const rowWidths = ['wide', 'mid', 'full', 'wide', 'short'];
		for (let index = 0; index < rowWidths.length; index++) {
			const row = document.createElement('span');
			row.className = `optimus-starter-preview-row${index === 1 || index === 3 ? ' active' : ''}`;
			row.appendChild(skeletonDot());
			row.appendChild(skeletonBar(rowWidths[index]));
			rows.appendChild(row);
		}
		return rows;
	}

	private renderStarterFooterSkeleton(): HTMLElement {
		const footer = document.createElement('span');
		footer.className = 'optimus-starter-preview-footer';
		footer.setAttribute('aria-hidden', 'true');
		footer.appendChild(skeletonBar('small'));
		footer.appendChild(skeletonBar('tiny'));
		footer.appendChild(skeletonBar('short'));
		return footer;
	}

	private renderStarterComposerSkeleton(): HTMLElement {
		const composer = document.createElement('span');
		composer.className = 'optimus-starter-preview-composer';
		composer.setAttribute('aria-hidden', 'true');
		composer.appendChild(skeletonBar('icon'));
		composer.appendChild(skeletonBar('medium'));
		return composer;
	}

	private selectStarter(slot: number): void {
		this.selectedStarterSlot = slot;
		this.selectedStarter = starterTasks[slot];
		this.selectedHistory = undefined;
		this.isHistoryView = false;
		this.selectedTranscript = undefined;
		this.store.selectRun(undefined);
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.renderRuns();
		this.historyProvider?.openBackboardNewChat?.(this.selectedWorkspace).catch(console.error);
		setTimeout(() => this.drawerBody.querySelector<HTMLTextAreaElement>('.optimus-panel-composer textarea')?.focus(), 0);
	}

	private async createRun(task: string, provider: OptimusProvider): Promise<void> {
		if (!task) {
			this.drawerBody.querySelector<HTMLTextAreaElement>('.optimus-panel-composer textarea')?.focus();
			return;
		}

		const slot = this.selectedStarter ? this.selectedStarterSlot : this.nextOpenSlot();
		await this.store.createRun({
			task,
			provider,
			workspace: this.selectedWorkspace
		});
		this.selectedStarter = undefined;
		const selectedRun = this.store.selectedRun;
		if (selectedRun) {
			this.runSlots.set(selectedRun.id, slot);
			this.openRun(selectedRun.id);
		}
	}

	private renderRuns(): void {
		this.renderHeaderActions();
		this.updatePanelLayout();
		this.cardGrid.replaceChildren();
		this.cardGrid.appendChild(this.renderTaskBoard());
		this.renderDrawer();
	}

	private slottedRuns(): Map<number, IOptimusRun> {
		const bySlot = new Map<number, IOptimusRun>();
		const usedSlots = new Set<number>();
		for (const run of this.store.runs) {
			const mappedSlot = this.runSlots.get(run.id);
			const slot = typeof mappedSlot === 'number' && mappedSlot >= 0 && mappedSlot < starterTasks.length && !usedSlots.has(mappedSlot)
				? mappedSlot
				: this.firstAvailableSlot(usedSlots);
			if (slot === undefined) {
				continue;
			}
			this.runSlots.set(run.id, slot);
			usedSlots.add(slot);
			bySlot.set(slot, run);
		}
		return bySlot;
	}

	private nextOpenSlot(): number {
		return this.firstAvailableSlot(new Set(this.slottedRuns().keys())) ?? 0;
	}

	private firstAvailableSlot(usedSlots: Set<number>): number | undefined {
		for (let slot = 0; slot < starterTasks.length; slot++) {
			if (!usedSlots.has(slot)) {
				return slot;
			}
		}
		return undefined;
	}

	private renderRunCard(run: IOptimusRun): HTMLElement {
		const card = document.createElement('article');
		card.className = `optimus-card ${run.status}${this.store.selectedRun?.id === run.id ? ' selected' : ''}`;
		card.tabIndex = 0;

		const header = document.createElement('div');
		header.className = 'optimus-card-header';
		header.appendChild(statusDot(run.status));

		const title = document.createElement('h2');
		title.textContent = run.title;
		header.appendChild(title);
		header.appendChild(statusBadge(run.status));

		const task = document.createElement('p');
		task.className = 'optimus-card-task';
		task.textContent = run.task;

		const command = document.createElement('div');
		command.className = 'optimus-card-command';
		const commandKind = document.createElement('span');
		commandKind.textContent = run.provider === OptimusProvider.Copilot
			? localize('optimus.command.copilot', "copilot")
			: localize('optimus.command.backboard', "backboard");
		const commandText = document.createElement('code');
		commandText.textContent = run.command ?? run.task;
		command.appendChild(commandKind);
		command.appendChild(commandText);

		const activityList = document.createElement('ol');
		activityList.className = 'optimus-activity';
		for (const event of run.activity.slice(0, 6)) {
			const item = document.createElement('li');
			item.className = event.state;
			item.appendChild(activityGlyph(event.state));
			const text = document.createElement('span');
			text.textContent = event.text;
			item.appendChild(text);
			activityList.appendChild(item);
		}

		const chips = document.createElement('div');
		chips.className = 'optimus-chips';
		if (typeof run.filesChanged === 'number') {
			const changed = document.createElement('span');
			changed.textContent = localize('optimus.filesChanged', "{0} files", run.filesChanged);
			chips.appendChild(changed);
		}
		for (const file of run.touchedFiles.slice(0, 3)) {
			const chip = document.createElement('span');
			chip.textContent = file.split('/').pop() ?? file;
			chips.appendChild(chip);
		}

		const footer = document.createElement('footer');
		footer.className = 'optimus-card-footer';
		footer.appendChild(meta(run.provider));
		footer.appendChild(meta(run.model));
		if (run.branchLabel) {
			footer.appendChild(meta(run.branchLabel));
		}
		if (run.worktreeLabel) {
			footer.appendChild(meta(run.worktreeLabel));
		}
		if (run.cost) {
			footer.appendChild(meta(run.cost));
		}

		const actions = document.createElement('div');
		actions.className = 'optimus-actions';
		actions.appendChild(actionButton(localize('optimus.openChat', "Open Chat"), () => {
			this.openRun(run.id);
			this.store.openWorktree(run.id).catch(console.error);
		}));
		if (run.capabilities.canReview) {
			actions.appendChild(actionButton(localize('optimus.review', "Review"), () => this.store.reviewRun(run.id).catch(console.error)));
		}
		if (run.capabilities.canApply) {
			actions.appendChild(actionButton(localize('optimus.apply', "Apply"), () => this.store.applyRun(run.id).catch(console.error)));
		}
		if (run.capabilities.canOpenWorktree) {
			actions.appendChild(actionButton(localize('optimus.worktree', "Worktree"), () => this.store.openWorktree(run.id).catch(console.error)));
		}
		if (run.capabilities.canStop) {
			actions.appendChild(actionButton(localize('optimus.stop', "Stop"), () => this.store.stopRun(run.id).catch(console.error)));
		}
		if (run.capabilities.canRetry) {
			actions.appendChild(actionButton(localize('optimus.retry', "Retry"), () => this.store.retryRun(run.id).catch(console.error)));
		}
		if (run.capabilities.canDismiss) {
			actions.appendChild(actionButton(localize('optimus.dismiss', "Dismiss"), () => this.store.dismissRun(run.id)));
		}

		const blockedReason = document.createElement('div');
		blockedReason.className = 'optimus-blocked-reason';
		blockedReason.textContent = run.blockedReason ?? '';

		card.appendChild(header);
		card.appendChild(command);
		card.appendChild(task);
		card.appendChild(activityList);
		if (run.blockedReason) {
			card.appendChild(blockedReason);
		}
		card.appendChild(chips);
		card.appendChild(footer);
		card.appendChild(actions);
		card.addEventListener('click', () => this.openRun(run.id));
		card.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.openRun(run.id);
			}
		});

		return card;
	}

	private openRun(runId: string): void {
		this.selectedStarter = undefined;
		this.selectedHistory = undefined;
		this.isHistoryView = false;
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.store.selectRun(runId);
		this.store.openTranscript(runId).then(transcript => {
			this.selectedTranscript = transcript;
			this.renderDrawer();
		}).catch(console.error);
	}

	private renderDrawer(): void {
		this.drawerBody.replaceChildren();
		const run = this.store.selectedRun;
		const starter = run ? undefined : this.selectedStarter;
		const history = run || starter || this.isHistoryView ? undefined : this.selectedHistory;

		const header = document.createElement('div');
		header.className = 'optimus-panel-header';

		const tabs = document.createElement('div');
		tabs.className = 'optimus-panel-tabs';
		const activeTab = document.createElement('button');
		activeTab.type = 'button';
		activeTab.className = 'optimus-panel-tab active';
		activeTab.title = this.isHistoryView
			? localize('optimus.panel.history', "History")
			: run?.title ?? (starter ? this.starterPanelTitle() : undefined) ?? history?.title ?? history?.prompt ?? localize('optimus.chat.emptyTitle', "Select a task");
		const tabLabel = document.createElement('span');
		tabLabel.textContent = this.isHistoryView
			? localize('optimus.panel.historyCount', "History ({0})", this.historyEntries.length)
			: run?.title ?? history?.title ?? history?.prompt ?? (starter ? this.starterPanelTitle() : undefined) ?? localize('optimus.panel.newChat', "New chat");
		activeTab.appendChild(tabLabel);
		tabs.appendChild(activeTab);

		const actions = document.createElement('div');
		actions.className = 'optimus-panel-actions';
		actions.appendChild(panelIconButton('+', localize('optimus.newAgent', "New Agent"), () => this.selectStarter(this.nextOpenSlot())));
		actions.appendChild(panelIconButton('↶', localize('optimus.panel.history', "History"), () => this.openHistoryView()));
		actions.appendChild(panelIconButton('×', localize('optimus.closeChat', "Close chat"), () => {
			this.isDrawerOpen = false;
			this.updatePanelLayout();
			this.renderHeaderActions();
		}));
		header.appendChild(tabs);
		header.appendChild(actions);

		const statusBar = document.createElement('div');
		statusBar.className = 'optimus-panel-status';
		const clock = document.createElement('span');
		clock.className = 'optimus-panel-clock';
		clock.textContent = run?.status === OptimusRunStatus.Running ? localize('optimus.panel.live', "LIVE") : localize('optimus.panel.ready', "Ready");
		const status = document.createElement('span');
		status.textContent = this.isHistoryView
			? this.historyStatusText()
			: run
			? localize('optimus.panel.statusForRun', "{0} via {1}", run.status, run.provider)
			: starter
				? localize('optimus.panel.starterStatus', "Ready to start via {0}", starter.provider)
				: history
					? localize('optimus.panel.historyStatus', "{0} from {1}", history.status ?? 'history', workspaceLabel(history.currentWorkspace))
					: localize('optimus.panel.statusEmpty', "Start or select an agent chat.");
		statusBar.appendChild(clock);
		statusBar.appendChild(status);

		if (this.isHistoryView) {
			this.drawerBody.appendChild(header);
			this.drawerBody.appendChild(statusBar);
			this.drawerBody.appendChild(this.renderHistoryList());
			this.drawerBody.appendChild(this.renderFollowupForm(undefined, undefined, undefined));
			return;
		}

		if (!run) {
			const body = starter ? this.renderStarterPanel() : history ? this.renderHistoryTranscript(history) : this.renderEmptyPanel();
			this.drawerBody.appendChild(header);
			this.drawerBody.appendChild(statusBar);
			this.drawerBody.appendChild(body);
			this.drawerBody.appendChild(this.renderFollowupForm(undefined, starter, history));
			return;
		}

		const messages = document.createElement('div');
		messages.className = 'optimus-panel-log';
		const changeStack = this.renderPanelChangeStack(run);
		if (changeStack) {
			messages.appendChild(changeStack);
		}
		for (const message of this.selectedTranscript?.messages ?? []) {
			const row = document.createElement('div');
			row.className = `optimus-panel-message ${message.author}`;
			const header = document.createElement('div');
			header.className = 'optimus-panel-message-header';
			const author = document.createElement('strong');
			author.textContent = messageAuthorLabel(message.author);
			header.appendChild(author);
			const body = document.createElement('p');
			body.textContent = message.text;
			row.appendChild(header);
			row.appendChild(body);
			messages.appendChild(row);
		}

		this.drawerBody.appendChild(header);
		this.drawerBody.appendChild(statusBar);
		this.drawerBody.appendChild(messages);
		this.drawerBody.appendChild(this.renderFollowupForm(run.id, undefined, undefined));
	}

	private async refreshHistory(): Promise<void> {
		if (!this.historyProvider) {
			return;
		}
		this.isHistoryLoading = true;
		this.historyLoadError = undefined;
		this.renderDrawer();
		try {
			this.historyEntries = await this.historyProvider.listBackboardHistory();
			if (this.selectedHistory && !this.historyEntries.some(entry => entry.id === this.selectedHistory?.id)) {
				this.selectedHistory = undefined;
			}
		} catch (error) {
			this.historyLoadError = error instanceof Error ? error.message : String(error);
		} finally {
			this.isHistoryLoading = false;
			this.renderDrawer();
		}
	}

	private async refreshWorkspaces(): Promise<void> {
		if (!this.historyProvider?.listBackboardWorkspaces) {
			return;
		}
		this.workspaces = await this.historyProvider.listBackboardWorkspaces();
		this.renderHeaderActions();
	}

	private openHistoryView(): void {
		this.selectedStarter = undefined;
		this.store.selectRun(undefined);
		this.isHistoryView = true;
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.renderDrawer();
		this.historyProvider?.openBackboardHistory?.().catch(console.error);
		this.refreshHistory().catch(console.error);
	}

	private openHistoryEntry(entry: IOptimusHistoryEntry): void {
		this.selectedStarter = undefined;
		this.selectedHistory = entry;
		this.isHistoryView = false;
		this.store.selectRun(undefined);
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.renderDrawer();
		this.historyProvider?.openBackboardHistoryEntry?.(entry.id).catch(console.error);
	}

	private historyStatusText(): string {
		if (this.isHistoryLoading) {
			return localize('optimus.panel.historyLoading', "Loading Backboard chat history...");
		}
		if (this.historyLoadError) {
			return localize('optimus.panel.historyError', "Could not load history: {0}", this.historyLoadError);
		}
		return this.selectedWorkspace
			? localize('optimus.panel.historyLoadedForWorkspace', "{0} saved Backboard chats in {1}", this.filteredHistoryEntries().length, this.currentWorkspaceLabel())
			: localize('optimus.panel.historyLoaded', "{0} saved Backboard chats", this.historyEntries.length);
	}

	private renderEmptyPanel(): HTMLElement {
		const placeholder = document.createElement('div');
		placeholder.className = 'optimus-panel-empty';
		const mark = document.createElement('div');
		mark.className = 'optimus-panel-empty-icon';
		mark.setAttribute('aria-hidden', 'true');
		const tagline = document.createElement('div');
		tagline.className = 'optimus-panel-empty-tagline';
		tagline.textContent = localize('optimus.drawer.emptyTagline', "Ask anything about your code");
		const hints = document.createElement('div');
		hints.className = 'optimus-panel-empty-hints';
		for (const text of [
			localize('optimus.drawer.emptyHintExplain', "Try: \"Explain this function\""),
			localize('optimus.drawer.emptyHintBugs', "Try: \"Find bugs in my code\"")
		]) {
			const hint = document.createElement('div');
			hint.className = 'optimus-panel-empty-hint';
			hint.textContent = text;
			hints.appendChild(hint);
		}
		placeholder.append(mark, tagline, hints);
		return placeholder;
	}

	private renderHistoryList(): HTMLElement {
		const list = document.createElement('div');
		list.className = 'optimus-history-list';
		const entries = this.filteredHistoryEntries();
		if (this.isHistoryLoading && !entries.length) {
			const loading = document.createElement('div');
			loading.className = 'optimus-history-empty';
			loading.textContent = localize('optimus.history.loading', "Loading history...");
			list.appendChild(loading);
			return list;
		}
		if (this.historyLoadError) {
			const error = document.createElement('div');
			error.className = 'optimus-history-empty error';
			error.textContent = this.historyLoadError;
			list.appendChild(error);
		}
		if (!entries.length) {
			const empty = document.createElement('div');
			empty.className = 'optimus-history-empty';
			empty.textContent = this.selectedWorkspace
				? localize('optimus.history.emptyForWorkspace', "No Backboard history was found for this workspace.")
				: localize('optimus.history.empty', "No Backboard history was found.");
			list.appendChild(empty);
			return list;
		}
		for (const entry of entries) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `optimus-history-item${this.selectedHistory?.id === entry.id ? ' active' : ''}`;
			button.addEventListener('click', () => this.openHistoryEntry(entry));
			const title = document.createElement('span');
			title.className = 'optimus-history-title';
			title.textContent = entry.title || entry.prompt || localize('optimus.history.untitled', "Untitled chat");
			const meta = document.createElement('span');
			meta.className = 'optimus-history-meta';
			meta.textContent = `${historyTime(entry.updatedAt ?? entry.startedAt)} · ${workspaceLabel(entry.currentWorkspace)} · ${entry.status ?? 'history'}`;
			const preview = document.createElement('span');
			preview.className = 'optimus-history-preview';
			preview.textContent = historyPreview(entry);
			button.append(title, meta, preview);
			list.appendChild(button);
		}
		return list;
	}

	private renderHistoryTranscript(entry: IOptimusHistoryEntry): HTMLElement {
		const messages = document.createElement('div');
		messages.className = 'optimus-panel-log';
		if (entry.fileChanges.length) {
			messages.appendChild(this.renderHistoryChangeStack(entry));
		}
		for (const message of entry.messages) {
			const row = document.createElement('div');
			row.className = `optimus-panel-message ${message.role === 'assistant' ? 'agent' : message.role}`;
			const header = document.createElement('div');
			header.className = 'optimus-panel-message-header';
			const author = document.createElement('strong');
			author.textContent = messageAuthorLabel(message.role);
			header.appendChild(author);
			const body = document.createElement('p');
			body.textContent = message.content;
			row.append(header, body);
			messages.appendChild(row);
		}
		return messages;
	}

	private renderHistoryChangeStack(entry: IOptimusHistoryEntry): HTMLElement {
		const stack = document.createElement('div');
		stack.className = 'optimus-panel-change-stack';
		const reviewCard = document.createElement('div');
		reviewCard.className = 'optimus-panel-review-card';
		const icon = document.createElement('span');
		icon.className = 'optimus-panel-review-icon';
		icon.textContent = '#';
		const title = document.createElement('span');
		title.textContent = localize('optimus.panel.changedFiles', "Changed {0} files", entry.fileChanges.length);
		reviewCard.append(icon, title);
		stack.appendChild(reviewCard);
		for (const change of entry.fileChanges.slice(0, 6)) {
			const fileCard = document.createElement('div');
			fileCard.className = 'optimus-panel-file-card';
			const fileName = document.createElement('span');
			fileName.textContent = change.path;
			const counts = document.createElement('span');
			counts.textContent = `+${change.added ?? 0} -${change.removed ?? 0}`;
			fileCard.append(fileName, counts);
			stack.appendChild(fileCard);
		}
		return stack;
	}

	private renderStarterPanel(): HTMLElement {
		const panel = document.createElement('div');
		panel.className = 'optimus-panel-starter';

		const card = document.createElement('section');
		card.className = 'optimus-panel-starter-card';
		const title = document.createElement('h2');
		title.textContent = this.starterPanelTitle();
		const prompt = document.createElement('p');
		prompt.textContent = localize('optimus.starter.emptyPrompt', "Ready for a new Backboard prompt.");
		card.append(title, prompt);

		const rows = document.createElement('div');
		rows.className = 'optimus-panel-starter-rows';
		for (let index = 0; index < 5; index++) {
			const row = document.createElement('div');
			row.className = 'optimus-panel-starter-row';
			const dot = document.createElement('span');
			const label = document.createElement('span');
			label.textContent = '';
			const bar = document.createElement('span');
			row.append(dot, label, bar);
			rows.appendChild(row);
		}

		panel.append(card, rows);
		return panel;
	}

	private starterPanelTitle(): string {
		return localize('optimus.starter.title', "New prompt");
	}

	private renderPanelChangeStack(run: IOptimusRun): HTMLElement | undefined {
		if (typeof run.filesChanged !== 'number' || run.filesChanged <= 0) {
			return undefined;
		}

		const stack = document.createElement('div');
		stack.className = 'optimus-panel-change-stack';

		const reviewCard = document.createElement('div');
		reviewCard.className = 'optimus-panel-review-card';
		const icon = document.createElement('span');
		icon.className = 'optimus-panel-review-icon';
		icon.textContent = '#';
		const title = document.createElement('span');
		title.textContent = localize('optimus.panel.changedFiles', "Changed {0} files", run.filesChanged);
		const review = document.createElement('button');
		review.type = 'button';
		review.textContent = localize('optimus.review', "Review");
		review.disabled = !run.capabilities.canReview;
		review.addEventListener('click', event => {
			event.stopPropagation();
			this.store.reviewRun(run.id).catch(console.error);
		});
		reviewCard.append(icon, title, review);
		stack.appendChild(reviewCard);

		for (const file of run.touchedFiles.slice(0, 3)) {
			const fileCard = document.createElement('div');
			fileCard.className = 'optimus-panel-file-card';
			const fileName = document.createElement('span');
			fileName.textContent = file;
			const counts = document.createElement('span');
			counts.textContent = '+12 -3';
			fileCard.append(fileName, counts);
			stack.appendChild(fileCard);
		}

		return stack;
	}

	private renderFollowupForm(runId: string | undefined, starter: IOptimusStarterTask | undefined, history: IOptimusHistoryEntry | undefined): HTMLElement {
		const form = document.createElement('form');
		form.className = 'optimus-panel-composer';
		const input = document.createElement('textarea');
		input.rows = 3;
		input.placeholder = runId
			? localize('optimus.followup.placeholder', "Plan, Build, / for commands, @ for context")
			: starter
				? localize('optimus.starter.placeholder', "Ask Optimus to start a Backboard task")
				: history
					? localize('optimus.history.followupPlaceholder', "Message this Backboard chat")
					: localize('optimus.followup.disabledPlaceholder', "Choose an empty slot");
		input.value = '';
		input.disabled = !runId && !starter && !history;

		const toolbar = document.createElement('div');
		toolbar.className = 'optimus-panel-composer-bar';
		const left = document.createElement('div');
		left.className = 'optimus-panel-composer-left';
		left.appendChild(toolbarChip(localize('optimus.chat.mode', "Agent")));
		left.appendChild(toolbarChip(localize('optimus.task.model', "Model Auto")));
		const right = document.createElement('div');
		right.className = 'optimus-panel-composer-right';
		right.appendChild(toolbarChip(localize('optimus.panel.mic', "Mic")));
		const send = document.createElement('button');
		send.type = 'submit';
		send.className = 'optimus-send-button';
		send.title = localize('optimus.send', "Send");
		send.setAttribute('aria-label', send.title);
		send.textContent = '>';
		send.disabled = !runId && !starter && !history;
		right.appendChild(send);
		toolbar.appendChild(left);
		toolbar.appendChild(right);
		form.appendChild(input);
		form.appendChild(toolbar);
		form.addEventListener('submit', event => {
			event.preventDefault();
			const text = input.value.trim();
			if (runId && text) {
				this.store.sendMessage(runId, text, this.selectedWorkspace).then(() => this.openRun(runId)).catch(console.error);
				input.value = '';
			} else if (starter && text) {
				this.createRun(text, starter.provider).catch(console.error);
			} else if (history && text) {
				this.historyProvider?.sendBackboardPrompt?.(text, history.id, history.currentWorkspace ?? this.selectedWorkspace).then(() => {
					input.value = '';
					this.refreshHistory().catch(console.error);
				}).catch(console.error);
			}
		});

		return form;
	}

	private renderDrawerResizeHandle(): HTMLElement {
		const handle = document.createElement('div');
		handle.className = 'optimus-drawer-resize-handle';
		handle.title = localize('optimus.resizeChat', "Resize chat");
		handle.addEventListener('pointerdown', event => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = this.drawerWidth;
			const onPointerMove = (moveEvent: PointerEvent) => {
				this.drawerWidth = clamp(startWidth - (moveEvent.clientX - startX), 360, 720);
				this.updatePanelLayout();
			};
			const onPointerUp = () => {
				document.removeEventListener('pointermove', onPointerMove);
				document.removeEventListener('pointerup', onPointerUp);
			};
			document.addEventListener('pointermove', onPointerMove);
			document.addEventListener('pointerup', onPointerUp);
		});
		handle.addEventListener('dblclick', () => {
			this.drawerWidth = 430;
			this.updatePanelLayout();
		});
		return handle;
	}

	private updatePanelLayout(): void {
		this.content.style.setProperty('--optimus-drawer-width', `${this.drawerWidth}px`);
		this.content.classList.toggle('panel-closed', !this.isDrawerOpen);
	}

	private filteredHistoryEntries(): readonly IOptimusHistoryEntry[] {
		return this.selectedWorkspace
			? this.historyEntries.filter(entry => this.historyMatchesSelectedWorkspace(entry))
			: this.historyEntries;
	}

	private historyMatchesSelectedWorkspace(entry: IOptimusHistoryEntry): boolean {
		return !this.selectedWorkspace || (entry.currentWorkspace || 'default') === this.selectedWorkspace;
	}

	private currentWorkspaceLabel(): string {
		const workspace = this.workspaces.find(workspace => workspace.id === this.selectedWorkspace);
		return workspace?.label ?? workspaceLabel(this.selectedWorkspace);
	}
}

function statusDot(status: OptimusRunStatus): HTMLElement {
	const dot = document.createElement('span');
	dot.className = `optimus-status-dot ${status}`;
	return dot;
}

function statusBadge(status: OptimusRunStatus): HTMLElement {
	const badge = document.createElement('span');
	badge.className = `optimus-status-badge ${status}`;
	badge.textContent = status;
	return badge;
}

function activityGlyph(state: OptimusActivityState): HTMLElement {
	const glyph = document.createElement('span');
	glyph.className = `optimus-activity-glyph ${state}`;
	glyph.textContent = state === OptimusActivityState.Done ? 'OK' : state === OptimusActivityState.Failed ? '!' : '>';
	return glyph;
}

function meta(text: string): HTMLElement {
	const item = document.createElement('span');
	item.className = 'optimus-meta';
	item.textContent = text;
	return item;
}

function toolbarChip(label: string): HTMLElement {
	const item = document.createElement('span');
	item.className = 'optimus-toolbar-chip';
	item.textContent = label;
	return item;
}

function workspaceOption(value: string, label: string, count: number | undefined): HTMLOptionElement {
	const option = document.createElement('option');
	option.value = value;
	option.textContent = typeof count === 'number'
		? localize('optimus.workspace.optionWithCount', "{0} ({1})", label, count)
		: label;
	return option;
}

function skeletonDot(): HTMLElement {
	const item = document.createElement('span');
	item.className = 'optimus-skeleton-dot';
	return item;
}

function skeletonBar(width: string): HTMLElement {
	const item = document.createElement('span');
	item.className = `optimus-skeleton-bar ${width}`;
	return item;
}

function panelIconButton(label: string, title: string, handler: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'optimus-panel-icon-button';
	button.textContent = label;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', event => {
		event.stopPropagation();
		handler();
	});
	return button;
}

function messageAuthorLabel(author: string): string {
	if (author === 'user') {
		return localize('optimus.message.user', "You");
	}
	if (author === 'agent' || author === 'assistant') {
		return localize('optimus.message.assistant', "Assistant");
	}
	if (author === 'system') {
		return localize('optimus.message.system', "System");
	}
	return author;
}

function workspaceLabel(workspace: string | undefined): string {
	if (!workspace) {
		return localize('optimus.history.defaultWorkspace', "default");
	}
	const normalized = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
	return normalized[normalized.length - 1] ?? workspace;
}

function historyPreview(entry: IOptimusHistoryEntry): string {
	const last = entry.messages[entry.messages.length - 1]?.content;
	return last || entry.prompt || localize('optimus.history.noPreview', "No transcript preview");
}

function historyTime(timestamp: number | undefined): string {
	if (!timestamp) {
		return localize('optimus.history.unknownTime', "unknown time");
	}
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return localize('optimus.history.unknownTime', "unknown time");
	}
	return date.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

function actionButton(label: string, handler: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.addEventListener('click', event => {
		event.stopPropagation();
		handler();
	});
	return button;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
