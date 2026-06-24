/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { IOptimusRun, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';
import { IOptimusHistoryEntry, IOptimusHistoryProvider, IOptimusLiveState, IOptimusNavigationProvider, IOptimusWorkspaceEntry } from '../common/optimusHistory.js';
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
	private sidebar!: HTMLElement;
	private headerActions!: HTMLElement;
	private selectedStarter: IOptimusStarterTask | undefined;
	private readonly runSlots = new Map<string, number>();
	private historyEntries: readonly IOptimusHistoryEntry[] = [];
	private liveHistoryEntry: IOptimusHistoryEntry | undefined;
	private liveStateRunning = false;
	private workspaces: readonly IOptimusWorkspaceEntry[] = [];
	private selectedWorkspace: string | undefined;
	private selectedHistory: IOptimusHistoryEntry | undefined;
	private draftPrompt = '';
	private pendingPrompt: string | undefined;
	private sidebarStatus: string | undefined;
	private sidebarError: string | undefined;
	private isSendingPrompt = false;
	private pendingLayoutUpdate: number | undefined;
	private pendingHistoryPoll: number | undefined;
	private historyPollsRemaining = 0;

	constructor(
		private readonly container: HTMLElement,
		private readonly store: OptimusRunStore,
		private readonly historyProvider: IOptimusHistoryProvider | undefined = undefined,
		private readonly navigationProvider: IOptimusNavigationProvider | undefined = undefined
	) {
		super();
		this._register(this.store.onDidChange(() => this.renderRuns()));
		this._register(toDisposable(() => this.stopHistoryPolling()));
	}

	start(): void {
		this.container.classList.add('optimus-root');
		this.container.appendChild(this.renderShell());
		this.renderRuns();
		this.refreshHistory().catch(error => {
			console.error(error);
		});
		this.refreshWorkspaces().catch(console.error);
	}

	private renderShell(): HTMLElement {
		const shell = document.createElement('div');
		shell.className = 'optimus-shell';

		const header = document.createElement('header');
		header.className = 'optimus-header';
		header.appendChild(this.renderModeSwitcher());
		header.appendChild(this.renderBrand());
		this.headerActions = document.createElement('div');
		this.headerActions.className = 'optimus-header-actions';
		header.appendChild(this.headerActions);

		this.content = document.createElement('main');
		this.content.className = 'optimus-content';

		this.cardGrid = document.createElement('section');
		this.cardGrid.className = 'optimus-grid';

		this.sidebar = document.createElement('aside');
		this.sidebar.className = 'optimus-sidebar';
		this.sidebar.setAttribute('aria-label', localize('optimus.sidebar.label', "Backboard agent"));

		this.content.appendChild(this.cardGrid);
		this.content.appendChild(this.sidebar);
		shell.appendChild(header);
		shell.appendChild(this.content);
		this.installResponsiveLayout();
		this.updateResponsiveLayout();

		return shell;
	}

	private installResponsiveLayout(): void {
		const ownerWindow = this.container.ownerDocument.defaultView;
		const scheduleLayoutUpdate = () => {
			if (this.pendingLayoutUpdate !== undefined) {
				return;
			}
			this.pendingLayoutUpdate = ownerWindow?.requestAnimationFrame(() => {
				this.pendingLayoutUpdate = undefined;
				this.updateResponsiveLayout();
			});
		};

		if (ownerWindow?.ResizeObserver) {
			const observer = new ownerWindow.ResizeObserver(scheduleLayoutUpdate);
			observer.observe(this.container);
			observer.observe(this.content);
			observer.observe(this.cardGrid);
			observer.observe(this.sidebar);
			this._register(toDisposable(() => observer.disconnect()));
		}
		ownerWindow?.addEventListener('resize', scheduleLayoutUpdate);
		this._register(toDisposable(() => {
			if (this.pendingLayoutUpdate !== undefined) {
				ownerWindow?.cancelAnimationFrame(this.pendingLayoutUpdate);
				this.pendingLayoutUpdate = undefined;
			}
			ownerWindow?.removeEventListener('resize', scheduleLayoutUpdate);
		}));
		scheduleLayoutUpdate();
	}

	private updateResponsiveLayout(): void {
		if (!this.content || !this.cardGrid) {
			return;
		}

		const contentWidth = this.content.clientWidth;
		const contentHeight = this.content.clientHeight;
		const gridWidth = this.cardGrid.clientWidth;
		const gridHeight = this.cardGrid.clientHeight;
		const effectiveGridWidth = gridWidth || contentWidth;
		const oneColumn = effectiveGridWidth > 0 && effectiveGridWidth < 560;
		const twoColumn = !oneColumn && effectiveGridWidth > 0 && effectiveGridWidth < 920;
		const fitTight = contentHeight > 0 && contentHeight < 420;
		const fitCompact = !fitTight && contentHeight > 0 && contentHeight < 560;

		this.content.classList.toggle('optimus-grid-three', !oneColumn && !twoColumn);
		this.content.classList.toggle('optimus-grid-two', twoColumn);
		this.content.classList.toggle('optimus-grid-one', oneColumn);
		this.content.classList.toggle('optimus-fit-normal', !fitCompact && !fitTight);
		this.content.classList.toggle('optimus-fit-compact', fitCompact);
		this.content.classList.toggle('optimus-fit-tight', fitTight);

		const computedGridStyle = this.container.ownerDocument.defaultView?.getComputedStyle(this.cardGrid);
		const gap = computedGridStyle ? parseCssPixels(computedGridStyle.gap) : 12;
		const paddingTop = computedGridStyle ? parseCssPixels(computedGridStyle.paddingTop) : 0;
		const paddingBottom = computedGridStyle ? parseCssPixels(computedGridStyle.paddingBottom) : 0;
		const historyRowHeight = Math.max(132, Math.floor((gridHeight - paddingTop - paddingBottom - gap) / 2));
		this.cardGrid.style.setProperty('--optimus-history-row-height', `${historyRowHeight}px`);
	}

	private renderModeSwitcher(): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = 'optimus-mode-switcher';

		const select = document.createElement('select');
		select.className = 'optimus-mode-select';
		select.title = localize('optimus.mode.select', "Switch Backboard mode");
		select.setAttribute('aria-label', select.title);
		select.appendChild(modeOption('editor', localize('optimus.mode.editor', "Editor")));
		select.appendChild(modeOption('agents', localize('optimus.mode.agents', "Agents")));
		const currentModeOption = modeOption('optimus', localize('optimus.mode.optimus', "Optimus"));
		currentModeOption.hidden = true;
		select.appendChild(currentModeOption);
		select.value = 'optimus';
		select.addEventListener('change', () => {
			const value = select.value;
			if (value === 'editor') {
				this.navigationProvider?.openEditor().catch(console.error);
			} else if (value === 'agents') {
				this.navigationProvider?.openAgents().catch(console.error);
			}
			select.value = 'optimus';
		});
		wrapper.appendChild(select);
		return wrapper;
	}

	private renderBrand(): HTMLElement {
		const brand = document.createElement('div');
		brand.className = 'optimus-brand';

		const title = document.createElement('h1');
		title.textContent = localize('optimus.title', "Optimus");

		const subtitle = document.createElement('p');
		subtitle.textContent = localize('optimus.subtitle', "Multi-agent control");

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
			}
			this.renderRuns();
		});

		const newAgent = document.createElement('button');
		newAgent.type = 'button';
		newAgent.className = 'optimus-header-button optimus-new-agent-button';
		newAgent.textContent = '+';
		newAgent.title = localize('optimus.newAgent', "New Agent");
		newAgent.setAttribute('aria-label', newAgent.title);
		newAgent.addEventListener('click', () => {
			this.startDraftTask(this.nextOpenSlot());
		});

		const count = document.createElement('span');
		count.className = 'optimus-agent-count';
		const runCount = this.filteredHistoryEntries().length || this.store.runs.length;
		count.textContent = runCount === 1
			? localize('optimus.agentCount.one', "1 agent")
			: localize('optimus.agentCount.many', "{0} agents", runCount);

		const openPanel = document.createElement('button');
		openPanel.type = 'button';
		openPanel.className = 'optimus-header-button icon';
		openPanel.textContent = '>';
		openPanel.title = localize('optimus.openBackboardPanel', "Open Backboard panel");
		openPanel.setAttribute('aria-label', openPanel.title);
		openPanel.addEventListener('click', () => this.openBackboardPanel());

		this.headerActions.appendChild(workspaceSelect);
		this.headerActions.appendChild(newAgent);
		this.headerActions.appendChild(count);
		this.headerActions.appendChild(openPanel);
	}

	private renderTaskBoard(): HTMLElement {
		const board = document.createElement('section');
		board.className = 'optimus-task-board';
		board.setAttribute('aria-label', localize('optimus.taskBoard.label', "Optimus task launchers"));

		const slottedRuns = this.slottedRuns();
		const promptEntries = this.promptTileEntries();
		const renderHistoryFeed = slottedRuns.size === 0 && promptEntries.length > 0;
		board.classList.toggle('is-history-feed', renderHistoryFeed);
		this.cardGrid.classList.toggle('is-history-feed', renderHistoryFeed);

		if (renderHistoryFeed) {
			for (const entry of promptEntries) {
				board.appendChild(this.renderPromptTask(entry));
			}
			return board;
		}

		for (let slot = 0; slot < starterTasks.length; slot++) {
			const run = slottedRuns.get(slot);
			board.appendChild(run ? this.renderRunCard(run) : this.renderStarterTask(slot));
		}

		return board;
	}

	private renderPromptTask(historyEntry: IOptimusHistoryEntry): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `optimus-starter-card optimus-prompt-card has-prompt ${historyStatusClass(historyEntry)}${this.selectedHistory?.id === historyEntry.id ? ' selected' : ''}`;
		button.setAttribute('aria-label', localize('optimus.slot.openPrompt', "Open Backboard prompt {0}", promptTileTitle(historyEntry)));
		button.addEventListener('click', () => this.openHistoryEntry(historyEntry));

		button.append(
			this.renderStarterHeaderSkeleton(historyEntry),
			this.renderStarterPromptTitle(historyEntry),
			this.renderStarterPromptRows(historyEntry),
			this.renderStarterPromptFooter(historyEntry),
			this.renderStarterComposerSkeleton()
		);
		return button;
	}

	private renderStarterTask(slot: number, historyEntry?: IOptimusHistoryEntry): HTMLElement {
		const starter = starterTasks[slot];
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `optimus-starter-card${historyEntry ? ` has-prompt ${historyStatusClass(historyEntry)}` : ''}${this.selectedStarter?.id === starter.id ? ' selected' : ''}`;
		button.setAttribute('aria-label', historyEntry
			? localize('optimus.slot.openPrompt', "Open Backboard prompt {0}", promptTileTitle(historyEntry))
			: localize('optimus.slot.newPrompt', "Start a new Optimus prompt in slot {0}", slot + 1));
		button.setAttribute('aria-pressed', this.selectedStarter?.id === starter.id ? 'true' : 'false');
		button.addEventListener('click', () => {
			if (historyEntry) {
				this.openHistoryEntry(historyEntry);
			} else {
				this.startDraftTask(slot);
			}
		});

		button.append(
			this.renderStarterHeaderSkeleton(historyEntry),
			historyEntry ? this.renderStarterPromptTitle(historyEntry) : this.renderStarterTitleSkeleton(),
			historyEntry ? this.renderStarterPromptRows(historyEntry) : this.renderStarterRowsSkeleton(),
			historyEntry ? this.renderStarterPromptFooter(historyEntry) : this.renderStarterFooterSkeleton(),
			this.renderStarterComposerSkeleton()
		);
		return button;
	}

	private renderStarterHeaderSkeleton(historyEntry?: IOptimusHistoryEntry): HTMLElement {
		const header = document.createElement('span');
		header.className = 'optimus-starter-preview-header';
		header.appendChild(skeletonDot());
		if (historyEntry) {
			const label = document.createElement('span');
			label.className = 'optimus-starter-workspace';
			label.textContent = workspaceLabel(historyEntry.currentWorkspace);
			header.appendChild(label);

			const badge = document.createElement('span');
			badge.className = `optimus-starter-status ${historyStatusClass(historyEntry)}`;
			badge.textContent = historyStatusLabel(historyEntry);
			header.appendChild(badge);
		} else {
			header.setAttribute('aria-hidden', 'true');
			header.appendChild(skeletonBar('medium'));
		}

		const action = document.createElement('span');
		action.className = 'optimus-starter-action';
		action.textContent = historyEntry ? '>' : '+';
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

	private renderStarterPromptTitle(entry: IOptimusHistoryEntry): HTMLElement {
		const title = document.createElement('span');
		title.className = 'optimus-starter-preview-title';
		const heading = document.createElement('strong');
		heading.className = 'optimus-starter-prompt-title';
		heading.textContent = promptTileTitle(entry);
		const meta = document.createElement('span');
		meta.className = 'optimus-starter-prompt-meta';
		meta.textContent = `$ ${localize('optimus.history.command.backboard', "backboard")}`;
		title.append(meta, heading);
		return title;
	}

	private renderStarterPromptRows(entry: IOptimusHistoryEntry): HTMLElement {
		const rows = document.createElement('span');
		rows.className = 'optimus-starter-preview-rows';
		const previewLines = promptTileLines(entry);
		for (let index = 0; index < previewLines.length; index++) {
			const row = document.createElement('span');
			row.className = `optimus-starter-preview-row prompt-line${index === 0 ? ' active' : ''}`;
			row.appendChild(skeletonDot());
			const text = document.createElement('span');
			text.className = 'optimus-starter-prompt-line';
			text.textContent = previewLines[index];
			row.appendChild(text);
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

	private renderStarterPromptFooter(entry: IOptimusHistoryEntry): HTMLElement {
		const footer = document.createElement('span');
		footer.className = 'optimus-starter-preview-footer';
		const updated = document.createElement('span');
		updated.className = 'optimus-starter-prompt-meta';
		updated.textContent = historyTime(entry.updatedAt ?? entry.startedAt);
		const files = document.createElement('span');
		files.className = 'optimus-starter-prompt-meta';
		files.textContent = entry.fileChanges.length
			? localize('optimus.history.changedFiles', "{0} changed files", entry.fileChanges.length)
			: localize('optimus.history.noChangedFiles', "No changed files");
		footer.append(updated, files);
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

	private startDraftTask(slot: number): void {
		const starter = starterTasks[slot];
		this.selectedStarter = starter;
		this.selectedHistory = undefined;
		this.store.selectRun(undefined);
		this.sidebarStatus = undefined;
		this.sidebarError = undefined;
		this.renderHeaderActions();
		this.renderRuns();
		this.focusSidebarComposer();
	}

	private renderRuns(): void {
		this.renderHeaderActions();
		this.updateResponsiveLayout();
		this.cardGrid.replaceChildren();
		this.cardGrid.appendChild(this.renderTaskBoard());
		this.renderSidebar();
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

	private promptTileEntries(): readonly IOptimusHistoryEntry[] {
		const entries = [...this.filteredHistoryEntries()];
		if (this.liveHistoryEntry && isBackboardOwnedHistoryEntry(this.liveHistoryEntry) && this.historyMatchesSelectedWorkspace(this.liveHistoryEntry)) {
			const existingIndex = entries.findIndex(entry => entry.id === this.liveHistoryEntry?.id);
			if (existingIndex >= 0) {
				entries[existingIndex] = this.liveHistoryEntry;
			} else {
				entries.unshift(this.liveHistoryEntry);
			}
		}
		return entries
			.sort((first, second) => (second.updatedAt ?? second.startedAt ?? 0) - (first.updatedAt ?? first.startedAt ?? 0));
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
			actions.appendChild(actionButton(localize('optimus.dismiss', "Dismiss"), () => {
				this.store.dismissRun(run.id);
			}));
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
		this.renderHeaderActions();
		this.store.selectRun(runId);
		this.store.openWorktree(runId).catch(console.error);
		this.openBackboardPanel();
	}

	private async refreshHistory(): Promise<void> {
		if (!this.historyProvider) {
			return;
		}
		try {
			this.historyEntries = await this.historyProvider.listBackboardHistory();
			await this.refreshLiveState();
			const selectedHistory = this.selectedHistory
				? this.historyEntries.find(entry => entry.id === this.selectedHistory?.id) ?? (this.liveHistoryEntry?.id === this.selectedHistory.id ? this.liveHistoryEntry : undefined)
				: undefined;
			if (selectedHistory) {
				this.selectedHistory = selectedHistory;
				if (this.pendingPrompt && historyEntryMatchesPrompt(selectedHistory, this.pendingPrompt) && !this.liveStateRunning) {
					this.pendingPrompt = undefined;
					this.isSendingPrompt = false;
					this.sidebarStatus = localize('optimus.sidebar.historyUpdated', "Backboard response updated.");
				}
			} else if (this.pendingPrompt) {
				const pendingPrompt = this.pendingPrompt;
				const pendingHistory = this.historyEntries.find(entry => historyEntryMatchesPrompt(entry, pendingPrompt))
					?? (this.liveHistoryEntry && historyEntryMatchesPrompt(this.liveHistoryEntry, pendingPrompt) ? this.liveHistoryEntry : undefined);
				if (pendingHistory) {
					this.selectedStarter = undefined;
					this.selectedHistory = pendingHistory;
					if (!this.liveStateRunning) {
						this.pendingPrompt = undefined;
						this.isSendingPrompt = false;
						this.sidebarStatus = localize('optimus.sidebar.historyUpdated', "Backboard response updated.");
					}
				}
			} else if (this.selectedHistory) {
				this.selectedHistory = undefined;
			}
		} catch (error) {
			console.error(error);
		} finally {
			this.renderRuns();
		}
	}

	private async refreshLiveState(): Promise<void> {
		const liveState = await this.historyProvider?.readBackboardLiveState?.();
		if (!liveState || isStaleLiveState(liveState)) {
			if (!this.isSendingPrompt) {
				this.liveHistoryEntry = undefined;
				this.liveStateRunning = false;
			}
			return;
		}
		const liveEntry = liveStateToHistoryEntry(liveState);
		this.liveHistoryEntry = liveEntry;
		this.liveStateRunning = liveState.running === true;
		if (this.pendingPrompt && historyEntryMatchesPrompt(liveEntry, this.pendingPrompt)) {
			this.selectedStarter = undefined;
			this.selectedHistory = liveEntry;
			this.isSendingPrompt = liveState.running === true;
			this.sidebarStatus = liveState.status ?? (liveState.running ? localize('optimus.sidebar.streaming', "Backboard is streaming.") : localize('optimus.sidebar.historyUpdated', "Backboard response updated."));
			if (!liveState.running && liveEntry.messages.some(message => sidebarRoleClass(message.role) === 'assistant')) {
				this.pendingPrompt = undefined;
			}
		} else if (this.selectedHistory?.id === liveEntry.id || (!this.selectedHistory && liveState.running)) {
			this.selectedHistory = liveEntry;
			this.sidebarStatus = liveState.status;
			this.isSendingPrompt = liveState.running === true;
		}
	}

	private async refreshWorkspaces(): Promise<void> {
		if (!this.historyProvider?.listBackboardWorkspaces) {
			return;
		}
		this.workspaces = await this.historyProvider.listBackboardWorkspaces();
		this.renderHeaderActions();
	}

	private openHistoryEntry(entry: IOptimusHistoryEntry): void {
		this.selectedStarter = undefined;
		this.selectedHistory = entry;
		this.store.selectRun(undefined);
		this.sidebarStatus = undefined;
		this.sidebarError = undefined;
		this.renderHeaderActions();
		this.renderRuns();
	}

	private openBackboardPanel(): void {
		this.historyProvider?.openBackboardPanel?.().catch(console.error);
	}

	private filteredHistoryEntries(): readonly IOptimusHistoryEntry[] {
		const entries = this.historyEntries.filter(isBackboardOwnedHistoryEntry);
		return this.selectedWorkspace
			? entries.filter(entry => this.historyMatchesSelectedWorkspace(entry))
			: entries;
	}

	private historyMatchesSelectedWorkspace(entry: IOptimusHistoryEntry): boolean {
		return !this.selectedWorkspace || (entry.currentWorkspace || 'default') === this.selectedWorkspace;
	}

	private renderSidebar(): void {
		if (!this.sidebar) {
			return;
		}

		this.sidebar.classList.toggle('working', this.isSendingPrompt);
		this.sidebar.replaceChildren();

		const header = document.createElement('header');
		header.className = 'optimus-sidebar-header';

		const titleBlock = document.createElement('div');
		titleBlock.className = 'optimus-sidebar-title';

		const title = document.createElement('h2');
		title.textContent = localize('optimus.sidebar.title', "Backboard");
		const subtitle = document.createElement('p');
		subtitle.textContent = this.selectedHistory
			? promptTileTitle(this.selectedHistory)
			: localize('optimus.sidebar.newChat', "New Optimus agent");

		titleBlock.append(title, subtitle);
		header.appendChild(titleBlock);

		const actions = document.createElement('div');
		actions.className = 'optimus-sidebar-actions';
		const refresh = document.createElement('button');
		refresh.type = 'button';
		refresh.className = 'optimus-sidebar-icon-button';
		refresh.textContent = '⟳';
		refresh.title = localize('optimus.sidebar.refresh', "Refresh");
		refresh.setAttribute('aria-label', refresh.title);
		refresh.addEventListener('click', () => this.refreshHistory().catch(console.error));
		actions.appendChild(refresh);

		const newChat = document.createElement('button');
		newChat.type = 'button';
		newChat.className = 'optimus-sidebar-icon-button';
		newChat.textContent = '+';
		newChat.title = localize('optimus.sidebar.newAgent', "New Agent");
		newChat.setAttribute('aria-label', newChat.title);
		newChat.addEventListener('click', () => this.startDraftTask(this.nextOpenSlot()));
		actions.appendChild(newChat);
		header.appendChild(actions);

		const body = document.createElement('div');
		body.className = 'optimus-sidebar-body';
		body.setAttribute('role', 'log');
		body.setAttribute('aria-live', this.isSendingPrompt ? 'polite' : 'off');
		const messages = this.selectedHistory?.messages ?? [];
		const selectedContainsPendingPrompt = !!this.pendingPrompt && messages.some(message => message.role === 'user' && normalizeHistoryText(message.content) === normalizeHistoryText(this.pendingPrompt));
		if (messages.length) {
			for (const message of messages) {
				body.appendChild(this.renderSidebarMessage(message.role, message.content));
			}
			if (this.pendingPrompt && !selectedContainsPendingPrompt) {
				body.appendChild(this.renderSidebarMessage('user', this.pendingPrompt));
				body.appendChild(this.renderSidebarStatus(localize('optimus.sidebar.waitingForHistory', "Waiting for Backboard history to update.")));
			}
		} else if (this.pendingPrompt) {
			body.appendChild(this.renderSidebarMessage('user', this.pendingPrompt));
			body.appendChild(this.renderSidebarStatus(localize('optimus.sidebar.waitingForHistory', "Waiting for Backboard history to update.")));
		} else {
			const empty = document.createElement('div');
			empty.className = 'optimus-sidebar-empty';
			empty.textContent = localize('optimus.sidebar.empty', "Start a prompt or select a tile.");
			body.appendChild(empty);
		}

		if (this.sidebarStatus) {
			body.appendChild(this.renderSidebarStatus(this.sidebarStatus));
		}
		if (this.sidebarError) {
			const error = document.createElement('div');
			error.className = 'optimus-sidebar-error';
			error.textContent = this.sidebarError;
			body.appendChild(error);
		}

		const form = document.createElement('form');
		form.className = `optimus-sidebar-composer${this.isSendingPrompt ? ' working' : ''}`;
		form.addEventListener('submit', event => {
			event.preventDefault();
			this.sendSidebarPrompt().catch(console.error);
		});

		let sendButton: HTMLButtonElement | undefined;
		const updateSendButton = () => {
			if (sendButton) {
				sendButton.disabled = this.isSendingPrompt || !this.draftPrompt.trim() || !this.historyProvider?.sendBackboardPrompt;
			}
		};

		const textarea = document.createElement('textarea');
		textarea.className = 'optimus-sidebar-input';
		textarea.rows = 3;
		textarea.value = this.draftPrompt;
		textarea.placeholder = this.selectedHistory
			? localize('optimus.sidebar.followupPlaceholder', "Message this Backboard agent")
			: localize('optimus.sidebar.placeholder', "Ask Backboard to work on something");
		textarea.addEventListener('input', () => {
			this.draftPrompt = textarea.value;
			updateSendButton();
		});
		textarea.addEventListener('focus', () => form.classList.add('focused'));
		textarea.addEventListener('blur', () => form.classList.remove('focused'));
		textarea.addEventListener('keydown', event => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				this.sendSidebarPrompt().catch(console.error);
			}
		});

		const composerBar = document.createElement('div');
		composerBar.className = 'optimus-sidebar-composer-bar';

		const context = document.createElement('span');
		context.className = 'optimus-sidebar-context';
		context.textContent = this.selectedWorkspace
			? workspaceLabel(this.selectedWorkspace)
			: localize('optimus.sidebar.allWorkspaces', "All workspaces");

		const controls = document.createElement('div');
		controls.className = 'optimus-sidebar-controls';
		if (this.isSendingPrompt) {
			const cancel = document.createElement('button');
			cancel.type = 'button';
			cancel.className = 'optimus-sidebar-secondary-button';
			cancel.textContent = localize('optimus.sidebar.cancel', "Cancel");
			cancel.addEventListener('click', () => this.cancelSidebarPrompt().catch(console.error));
			controls.appendChild(cancel);
		}

		const send = document.createElement('button');
		sendButton = send;
		send.type = 'submit';
		send.className = 'optimus-sidebar-send-button';
		send.textContent = localize('optimus.sidebar.send', "Send");
		updateSendButton();
		controls.appendChild(send);

		composerBar.append(context, controls);
		form.append(textarea, composerBar);

		this.sidebar.append(header, body, form);
		this.scrollSidebarToBottom(body);
	}

	private renderSidebarMessage(role: string, content: string): HTMLElement {
		const message = document.createElement('article');
		message.className = `optimus-sidebar-message ${sidebarRoleClass(role)}`;

		const header = document.createElement('header');
		header.className = 'optimus-sidebar-message-header';

		const identity = document.createElement('div');
		identity.className = 'optimus-sidebar-message-identity';

		const avatar = document.createElement('span');
		avatar.className = 'optimus-sidebar-message-avatar';
		avatar.textContent = sidebarRoleAvatar(role);

		const label = document.createElement('span');
		label.className = 'optimus-sidebar-message-role';
		label.textContent = sidebarRoleLabel(role);

		identity.append(avatar, label);
		header.appendChild(identity);

		const text = document.createElement('div');
		text.className = 'optimus-sidebar-message-content';
		text.textContent = content;

		message.append(header, text);
		return message;
	}

	private renderSidebarStatus(text: string): HTMLElement {
		const status = document.createElement('div');
		status.className = 'optimus-sidebar-status';
		status.textContent = text;
		return status;
	}

	private async sendSidebarPrompt(): Promise<void> {
		const prompt = this.draftPrompt.trim();
		if (!prompt || !this.historyProvider?.sendBackboardPrompt) {
			return;
		}

		const chatId = this.selectedHistory?.id;
		this.draftPrompt = '';
		this.pendingPrompt = prompt;
		const optimisticEntry = createPendingHistoryEntry(prompt, chatId, this.selectedWorkspace);
		this.liveHistoryEntry = optimisticEntry;
		this.liveStateRunning = true;
		this.selectedHistory = optimisticEntry;
		this.sidebarStatus = localize('optimus.sidebar.sending', "Sending to Backboard.");
		this.sidebarError = undefined;
		this.isSendingPrompt = true;
		this.renderRuns();

		try {
			await this.historyProvider.sendBackboardPrompt(prompt, chatId, this.selectedWorkspace);
			this.sidebarStatus = localize('optimus.sidebar.waiting', "Waiting for Backboard response.");
			this.startHistoryPolling(prompt);
			await this.refreshHistory();
		} catch (error) {
			this.isSendingPrompt = false;
			this.sidebarStatus = undefined;
			this.sidebarError = error instanceof Error ? error.message : String(error);
			this.renderSidebar();
		}
	}

	private async cancelSidebarPrompt(): Promise<void> {
		if (!this.historyProvider?.cancelBackboardPrompt) {
			return;
		}
		try {
			await this.historyProvider.cancelBackboardPrompt();
			this.isSendingPrompt = false;
			this.sidebarStatus = localize('optimus.sidebar.cancelled', "Cancelled.");
			this.stopHistoryPolling();
			this.renderSidebar();
		} catch (error) {
			this.sidebarError = error instanceof Error ? error.message : String(error);
			this.renderSidebar();
		}
	}

	private startHistoryPolling(prompt: string): void {
		this.pendingPrompt = prompt;
		this.historyPollsRemaining = 120;
		this.scheduleHistoryPoll(300);
	}

	private scheduleHistoryPoll(delay: number): void {
		this.stopHistoryPolling();
		if (this.historyPollsRemaining <= 0) {
			this.isSendingPrompt = false;
			this.sidebarStatus = localize('optimus.sidebar.refreshStopped', "Backboard is still running. Use refresh or select the tile when it appears.");
			this.renderSidebar();
			return;
		}

		const ownerWindow = this.container.ownerDocument.defaultView;
		this.pendingHistoryPoll = ownerWindow?.setTimeout(() => {
			this.pendingHistoryPoll = undefined;
			this.historyPollsRemaining--;
			this.refreshHistory().finally(() => {
				if (this.pendingPrompt && this.historyPollsRemaining > 0) {
					this.scheduleHistoryPoll(500);
				}
			}).catch(console.error);
		}, delay);
	}

	private stopHistoryPolling(): void {
		if (this.pendingHistoryPoll === undefined) {
			return;
		}
		this.container.ownerDocument.defaultView?.clearTimeout(this.pendingHistoryPoll);
		this.pendingHistoryPoll = undefined;
	}

	private focusSidebarComposer(): void {
		const ownerWindow = this.container.ownerDocument.defaultView;
		ownerWindow?.requestAnimationFrame(() => {
			this.sidebar.querySelector<HTMLTextAreaElement>('.optimus-sidebar-input')?.focus();
		});
	}

	private scrollSidebarToBottom(body: HTMLElement): void {
		this.container.ownerDocument.defaultView?.requestAnimationFrame(() => {
			body.scrollTop = body.scrollHeight;
		});
	}
}

function historyEntryMatchesPrompt(entry: IOptimusHistoryEntry, prompt: string): boolean {
	const normalizedPrompt = normalizeHistoryText(prompt);
	return normalizeHistoryText(entry.prompt) === normalizedPrompt
		|| entry.messages.some(message => message.role === 'user' && normalizeHistoryText(message.content) === normalizedPrompt);
}

function isBackboardOwnedHistoryEntry(entry: IOptimusHistoryEntry): boolean {
	return entry.source === undefined || entry.source === 'backboard-panel' || entry.source === 'backboard-thread' || entry.source === 'optimus-live';
}

function createPendingHistoryEntry(prompt: string, chatId: string | undefined, workspace: string | undefined): IOptimusHistoryEntry {
	const now = Date.now();
	return {
		id: chatId ?? `optimus-pending-${now}`,
		source: 'optimus-live',
		title: promptTileTitle({ id: 'pending', messages: [], fileChanges: [], prompt }),
		prompt,
		status: 'Running',
		startedAt: now,
		updatedAt: now,
		currentWorkspace: workspace,
		messages: [{ role: 'user', content: prompt }],
		fileChanges: [],
	};
}

function liveStateToHistoryEntry(state: IOptimusLiveState): IOptimusHistoryEntry {
	return {
		id: state.chatId ?? state.id,
		source: 'optimus-live',
		title: state.prompt ? promptTileTitle({ id: state.id, messages: [], fileChanges: [], prompt: state.prompt }) : undefined,
		prompt: state.prompt,
		status: state.running ? 'Running' : state.status,
		startedAt: state.startedAt,
		updatedAt: state.updatedAt,
		currentWorkspace: state.currentWorkspace,
		messages: state.messages,
		fileChanges: state.fileChanges ?? [],
	};
}

function isStaleLiveState(state: IOptimusLiveState): boolean {
	return typeof state.updatedAt === 'number' && Date.now() - state.updatedAt > 10 * 60 * 1000;
}

function normalizeHistoryText(text: string | undefined): string {
	return text?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function sidebarRoleClass(role: string): string {
	const normalizedRole = role.toLowerCase();
	if (normalizedRole === 'assistant' || normalizedRole === 'agent') {
		return 'assistant';
	}
	if (normalizedRole === 'user') {
		return 'user';
	}
	if (normalizedRole === 'error') {
		return 'error';
	}
	return 'system';
}

function sidebarRoleLabel(role: string): string {
	switch (sidebarRoleClass(role)) {
		case 'assistant':
			return localize('optimus.sidebar.role.assistant', "Backboard");
		case 'user':
			return localize('optimus.sidebar.role.user', "You");
		case 'error':
			return localize('optimus.sidebar.role.error', "Error");
		case 'system':
		default:
			return localize('optimus.sidebar.role.system', "System");
	}
}

function sidebarRoleAvatar(role: string): string {
	switch (sidebarRoleClass(role)) {
		case 'assistant':
			return 'B';
		case 'user':
			return 'U';
		case 'error':
			return '!';
		case 'system':
		default:
			return 'i';
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

function workspaceOption(value: string, label: string, count: number | undefined): HTMLOptionElement {
	const option = document.createElement('option');
	option.value = value;
	option.textContent = typeof count === 'number'
		? localize('optimus.workspace.optionWithCount', "{0} ({1})", label, count)
		: label;
	return option;
}

function modeOption(value: string, label: string): HTMLOptionElement {
	const option = document.createElement('option');
	option.value = value;
	option.textContent = label;
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

function promptTileTitle(entry: IOptimusHistoryEntry): string {
	return entry.prompt || entry.title || entry.messages.find(message => message.role === 'user')?.content || localize('optimus.history.untitled', "Untitled chat");
}

function promptTileLines(entry: IOptimusHistoryEntry): readonly string[] {
	let lastAssistantMessage: string | undefined;
	for (let index = entry.messages.length - 1; index >= 0; index--) {
		if (entry.messages[index].role === 'assistant') {
			lastAssistantMessage = entry.messages[index].content;
			break;
		}
	}
	const lines = [
		entry.prompt,
		entry.messages.find(message => message.role === 'user')?.content,
		lastAssistantMessage,
		historyPreview(entry)
	].filter((line): line is string => !!line?.trim());
	const uniqueLines: string[] = [];
	for (const line of lines) {
		const normalized = line.replace(/\s+/g, ' ').trim();
		if (normalized && !uniqueLines.includes(normalized)) {
			uniqueLines.push(normalized);
		}
	}
	return uniqueLines.length ? uniqueLines.slice(0, 4) : [localize('optimus.history.noPreview', "No transcript preview")];
}

function historyStatusClass(entry: IOptimusHistoryEntry): string {
	const status = entry.status?.toLowerCase() ?? '';
	if (/\b(done|complete|completed|success|succeeded)\b/.test(status)) {
		return 'status-done';
	}
	if (/\b(blocked|error|failed|failure|cancel|canceled|cancelled)\b/.test(status)) {
		return 'status-blocked';
	}
	return 'status-live';
}

function historyStatusLabel(entry: IOptimusHistoryEntry): string {
	const status = entry.status?.trim();
	if (status) {
		return status;
	}
	return localize('optimus.history.status.live', "Live");
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

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
