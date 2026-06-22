/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { IOptimusRun, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';
import { IOptimusHistoryEntry, IOptimusHistoryProvider, IOptimusNavigationProvider, IOptimusWorkspaceEntry } from '../common/optimusHistory.js';
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
	private headerActions!: HTMLElement;
	private selectedStarter: IOptimusStarterTask | undefined;
	private readonly runSlots = new Map<string, number>();
	private historyEntries: readonly IOptimusHistoryEntry[] = [];
	private workspaces: readonly IOptimusWorkspaceEntry[] = [];
	private selectedWorkspace: string | undefined;
	private selectedHistory: IOptimusHistoryEntry | undefined;
	private pendingLayoutUpdate: number | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly store: OptimusRunStore,
		private readonly historyProvider: IOptimusHistoryProvider | undefined = undefined,
		private readonly navigationProvider: IOptimusNavigationProvider | undefined = undefined
	) {
		super();
		this._register(this.store.onDidChange(() => this.renderRuns()));
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

		this.content.appendChild(this.cardGrid);
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

		const openWorkbench = document.createElement('button');
		openWorkbench.type = 'button';
		openWorkbench.className = 'optimus-header-button optimus-workbench-button';
		openWorkbench.textContent = localize('optimus.openWorkbench', "Workbench");
		openWorkbench.title = localize('optimus.openWorkbench.title', "Switch Optimus to the editor workbench");
		openWorkbench.setAttribute('aria-label', openWorkbench.title);
		openWorkbench.addEventListener('click', () => {
			this.navigationProvider?.openOptimusWorkbench().catch(console.error);
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
		const runCount = this.store.runs.length;
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
		this.headerActions.appendChild(openWorkbench);
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
		this.renderHeaderActions();
		this.renderRuns();
		this.historyProvider?.openBackboardNewChat?.(this.selectedWorkspace).catch(console.error);
	}

	private renderRuns(): void {
		this.renderHeaderActions();
		this.updateResponsiveLayout();
		this.cardGrid.replaceChildren();
		this.cardGrid.appendChild(this.renderTaskBoard());
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
		return [...this.filteredHistoryEntries()]
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
			if (this.selectedHistory && !this.historyEntries.some(entry => entry.id === this.selectedHistory?.id)) {
				this.selectedHistory = undefined;
			}
		} catch (error) {
			console.error(error);
		} finally {
			this.renderRuns();
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
		this.renderHeaderActions();
		this.historyProvider?.openBackboardHistoryEntry?.(entry.id).catch(console.error);
	}

	private openBackboardPanel(): void {
		this.historyProvider?.openBackboardPanel?.().catch(console.error);
	}

	private filteredHistoryEntries(): readonly IOptimusHistoryEntry[] {
		return this.selectedWorkspace
			? this.historyEntries.filter(entry => this.historyMatchesSelectedWorkspace(entry))
			: this.historyEntries;
	}

	private historyMatchesSelectedWorkspace(entry: IOptimusHistoryEntry): boolean {
		return !this.selectedWorkspace || (entry.currentWorkspace || 'default') === this.selectedWorkspace;
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
