/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { IOptimusRun, IOptimusTranscript, OptimusActivityState, OptimusProvider, OptimusRunStatus } from '../common/optimusTypes.js';
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
	private draftRunCounter = 0;
	private readonly draftRunIds = new Set<string>();
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
		header.appendChild(this.renderModeSwitcher());
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
		this.installResponsiveLayout();
		this.updatePanelLayout();

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
				this.updatePanelLayout();
			});
		};

		if (ownerWindow?.ResizeObserver) {
			const observer = new ownerWindow.ResizeObserver(scheduleLayoutUpdate);
			observer.observe(this.container);
			observer.observe(this.content);
			observer.observe(this.cardGrid);
			observer.observe(this.drawer);
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
		const drawerHeight = this.drawer.clientHeight;
		const panelBelow = this.isDrawerOpen && contentWidth > 0 && contentWidth < 760;
		const effectiveGridWidth = panelBelow ? contentWidth : gridWidth;
		const oneColumn = effectiveGridWidth > 0 && effectiveGridWidth < 560;
		const twoColumn = !oneColumn && effectiveGridWidth > 0 && effectiveGridWidth < 920;
		const fitTight = contentHeight > 0 && contentHeight < 520;
		const fitCompact = !fitTight && contentHeight > 0 && contentHeight < 700;
		const panelTight = this.isDrawerOpen && drawerHeight > 0 && drawerHeight < 360;
		const panelCompact = this.isDrawerOpen && !panelTight && drawerHeight > 0 && drawerHeight < 520;

		this.content.classList.toggle('optimus-panel-side', this.isDrawerOpen && !panelBelow);
		this.content.classList.toggle('optimus-panel-below', panelBelow);
		this.content.classList.toggle('optimus-grid-three', !oneColumn && !twoColumn);
		this.content.classList.toggle('optimus-grid-two', twoColumn);
		this.content.classList.toggle('optimus-grid-one', oneColumn);
		this.content.classList.toggle('optimus-fit-normal', !fitCompact && !fitTight);
		this.content.classList.toggle('optimus-fit-compact', fitCompact);
		this.content.classList.toggle('optimus-fit-tight', fitTight);
		this.content.classList.toggle('optimus-panel-compact', panelCompact);
		this.content.classList.toggle('optimus-panel-tight', panelTight);
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
		select.appendChild(modeOption('optimus', localize('optimus.mode.optimus', "Optimus")));
		select.appendChild(modeOption('jarvis', localize('optimus.mode.jarvis', "Jarvis")));
		select.value = 'optimus';
		select.addEventListener('change', () => {
			const value = select.value;
			if (value === 'editor') {
				this.navigationProvider?.openEditor().catch(console.error);
			} else if (value === 'agents') {
				this.navigationProvider?.openAgents().catch(console.error);
			} else if (value === 'optimus') {
				this.navigationProvider?.openOptimus().catch(console.error);
			} else {
				this.navigationProvider?.openJarvis().catch(console.error);
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
			this.startDraftTask(this.nextOpenSlot());
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
		const promptEntries = this.promptTileEntries();
		for (let slot = 0; slot < starterTasks.length; slot++) {
			const run = slottedRuns.get(slot);
			board.appendChild(run ? this.renderRunCard(run) : this.renderStarterTask(slot, promptEntries[slot]));
		}

		return board;
	}

	private renderStarterTask(slot: number, historyEntry: IOptimusHistoryEntry | undefined): HTMLElement {
		const starter = starterTasks[slot];
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `optimus-starter-card${historyEntry ? ' has-prompt' : ''}${this.selectedStarter?.id === starter.id ? ' selected' : ''}`;
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
		meta.textContent = `${historyTime(entry.updatedAt ?? entry.startedAt)} · ${entry.status ?? localize('optimus.history.chat', "chat")}`;
		title.append(heading, meta);
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
		const workspace = document.createElement('span');
		workspace.className = 'optimus-starter-prompt-meta';
		workspace.textContent = workspaceLabel(entry.currentWorkspace);
		const files = document.createElement('span');
		files.className = 'optimus-starter-prompt-meta';
		files.textContent = entry.fileChanges.length
			? localize('optimus.history.changedFiles', "{0} changed files", entry.fileChanges.length)
			: localize('optimus.history.noChangedFiles', "No changed files");
		footer.append(workspace, files);
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
		const runId = `optimus-draft-${Date.now()}-${++this.draftRunCounter}`;
		const now = Date.now();
		this.selectedStarterSlot = slot;
		this.selectedStarter = undefined;
		this.selectedHistory = undefined;
		this.isHistoryView = false;
		this.selectedTranscript = { runId, messages: [] };
		this.runSlots.set(runId, slot);
		this.draftRunIds.add(runId);
		this.store.addRun({
			id: runId,
			title: localize('optimus.draft.title', "New task"),
			provider: starter.provider,
			status: OptimusRunStatus.Queued,
			task: localize('optimus.draft.task', "Waiting for a prompt"),
			command: localize('optimus.draft.command', "Message Backboard..."),
			activity: [{
				id: `${runId}-waiting`,
				text: localize('optimus.draft.activity', "Ready for your prompt"),
				state: OptimusActivityState.Waiting,
				timestamp: now
			}],
			touchedFiles: [],
			model: localize('optimus.draft.model', "Model Auto"),
			workspace: this.selectedWorkspace,
			capabilities: {
				canStop: false,
				canRetry: false,
				canReview: false,
				canApply: false,
				canOpenWorktree: false,
				canDismiss: true,
				canQuickChat: true
			}
		});
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.renderRuns();
		this.historyProvider?.openBackboardNewChat?.(this.selectedWorkspace).catch(console.error);
	}

	private async createRun(task: string, provider: OptimusProvider): Promise<void> {
		if (!task) {
			this.drawerBody.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
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

	private promptTileEntries(): readonly IOptimusHistoryEntry[] {
		return [...this.filteredHistoryEntries()]
			.sort((first, second) => (second.updatedAt ?? second.startedAt ?? 0) - (first.updatedAt ?? first.startedAt ?? 0))
			.slice(0, starterTasks.length);
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
			actions.appendChild(actionButton(localize('optimus.dismiss', "Dismiss"), () => {
				this.draftRunIds.delete(run.id);
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
		this.isHistoryView = false;
		this.isDrawerOpen = true;
		this.updatePanelLayout();
		this.renderHeaderActions();
		this.store.selectRun(runId);
		if (this.draftRunIds.has(runId)) {
			this.selectedTranscript = { runId, messages: [] };
			this.renderDrawer();
			return;
		}
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
		this.drawerBody.appendChild(this.renderRecentTabsShell(run, starter, history));
		this.drawerBody.appendChild(this.renderBackboardStatus(run, starter, history));

		const viewStack = document.createElement('div');
		viewStack.className = 'viewStack';

		if (this.isHistoryView) {
			viewStack.appendChild(this.renderHistoryList());
			this.drawerBody.appendChild(viewStack);
			this.drawerBody.appendChild(this.renderFollowupForm(undefined, undefined, undefined));
			return;
		}

		if (!run) {
			viewStack.appendChild(starter ? this.renderStarterPanel() : history ? this.renderHistoryTranscript(history) : this.renderEmptyPanel());
			this.drawerBody.appendChild(viewStack);
			this.drawerBody.appendChild(this.renderFollowupForm(undefined, starter, history));
			return;
		}

		const messages = document.createElement('div');
		messages.className = 'log viewPane active';
		const changeStack = this.renderPanelChangeStack(run);
		if (changeStack) {
			messages.appendChild(changeStack);
		}
		for (const message of this.selectedTranscript?.messages ?? []) {
			messages.appendChild(this.renderMessageCard(message.author, message.text));
		}
		if (this.draftRunIds.has(run.id) && !(this.selectedTranscript?.messages.length)) {
			messages.appendChild(this.renderDraftEmptyState());
		}

		viewStack.appendChild(messages);
		this.drawerBody.appendChild(viewStack);
		this.drawerBody.appendChild(this.renderFollowupForm(run.id, undefined, undefined));
	}

	private renderRecentTabsShell(run: IOptimusRun | undefined, starter: IOptimusStarterTask | undefined, history: IOptimusHistoryEntry | undefined): HTMLElement {
		const shell = document.createElement('div');
		shell.className = 'recentTabsShell';

		const tabs = document.createElement('div');
		tabs.className = 'recentTabs';
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', localize('optimus.panel.recentChats', "Recent chats"));

		const activeTab = document.createElement('button');
		activeTab.type = 'button';
		activeTab.className = `recentTab active${run?.status === OptimusRunStatus.Running ? ' running' : ''}`;
		activeTab.title = this.panelTitle(run, starter, history);
		const tabLabel = document.createElement('span');
		tabLabel.className = 'recentTabLabel';
		tabLabel.textContent = this.isHistoryView
			? localize('optimus.panel.historyCount', "History ({0})", this.historyEntries.length)
			: this.panelTitle(run, starter, history);
		activeTab.appendChild(tabLabel);
		tabs.appendChild(activeTab);

		const actions = document.createElement('div');
		actions.className = 'recentTabsActions';
		actions.appendChild(panelIconButton('+', localize('optimus.newAgent', "New Agent"), () => this.startDraftTask(this.nextOpenSlot())));
		actions.appendChild(panelIconButton('H', localize('optimus.panel.history', "History"), () => this.openHistoryView()));
		actions.appendChild(panelIconButton('×', localize('optimus.closeChat', "Close chat"), () => {
			this.isDrawerOpen = false;
			this.updatePanelLayout();
			this.renderHeaderActions();
		}));

		shell.append(tabs, actions);
		return shell;
	}

	private renderBackboardStatus(run: IOptimusRun | undefined, starter: IOptimusStarterTask | undefined, history: IOptimusHistoryEntry | undefined): HTMLElement {
		const statusBar = document.createElement('div');
		statusBar.className = 'statusBar';
		const clock = document.createElement('div');
		clock.className = 'runClock';
		clock.textContent = run?.status === OptimusRunStatus.Running ? localize('optimus.panel.live', "LIVE") : localize('optimus.panel.ready', "Ready");
		const status = document.createElement('div');
		status.className = 'status';
		status.textContent = this.isHistoryView
			? this.historyStatusText()
			: run
			? this.draftRunIds.has(run.id)
				? localize('optimus.panel.draftStatus', "Choose a prompt to start this Backboard task.")
				: localize('optimus.panel.statusForRun', "{0} via {1}", run.status, run.provider)
			: starter
				? localize('optimus.panel.starterStatus', "Ready to start via {0}", starter.provider)
				: history
					? localize('optimus.panel.historyStatus', "{0} from {1}", history.status ?? 'history', workspaceLabel(history.currentWorkspace))
					: localize('optimus.panel.statusEmpty', "Start or select an agent chat.");
		statusBar.append(clock, status);
		return statusBar;
	}

	private panelTitle(run: IOptimusRun | undefined, starter: IOptimusStarterTask | undefined, history: IOptimusHistoryEntry | undefined): string {
		if (this.isHistoryView) {
			return localize('optimus.panel.history', "History");
		}
		return run?.title ?? history?.title ?? history?.prompt ?? (starter ? this.starterPanelTitle() : undefined) ?? localize('optimus.chat.emptyTitle', "Select a task");
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
		const log = document.createElement('div');
		log.className = 'log viewPane active';
		const placeholder = document.createElement('div');
		placeholder.className = 'emptyState';
		const mark = document.createElement('div');
		mark.className = 'emptyIcon';
		mark.setAttribute('aria-hidden', 'true');
		const tagline = document.createElement('div');
		tagline.className = 'emptyTagline';
		tagline.textContent = localize('optimus.drawer.emptyTagline', "Ask anything about your code");
		const hints = document.createElement('div');
		hints.className = 'emptyHints';
		for (const text of [
			localize('optimus.drawer.emptyHintExplain', "Try: \"Explain this function\""),
			localize('optimus.drawer.emptyHintBugs', "Try: \"Find bugs in my code\"")
		]) {
			const hint = document.createElement('div');
			hint.className = 'emptyHint';
			hint.textContent = text;
			hints.appendChild(hint);
		}
		placeholder.append(mark, tagline, hints);
		log.appendChild(placeholder);
		return log;
	}

	private renderDraftEmptyState(): HTMLElement {
		const placeholder = document.createElement('div');
		placeholder.className = 'emptyState';
		const tagline = document.createElement('div');
		tagline.className = 'emptyTagline';
		tagline.textContent = localize('optimus.drawer.draftTagline', "Write a prompt to start this task.");
		const hints = document.createElement('div');
		hints.className = 'emptyHints';
		const hint = document.createElement('div');
		hint.className = 'emptyHint';
		hint.textContent = localize('optimus.drawer.draftHint', "The first message creates a real Backboard run.");
		hints.appendChild(hint);
		placeholder.append(tagline, hints);
		return placeholder;
	}

	private renderHistoryList(): HTMLElement {
		const list = document.createElement('div');
		list.className = 'historyPane viewPane active';
		const entries = this.filteredHistoryEntries();
		if (this.isHistoryLoading && !entries.length) {
			const loading = document.createElement('div');
			loading.className = 'historyEmpty';
			loading.textContent = localize('optimus.history.loading', "Loading history...");
			list.appendChild(loading);
			return list;
		}
		if (this.historyLoadError) {
			const error = document.createElement('div');
			error.className = 'historyEmpty error';
			error.textContent = this.historyLoadError;
			list.appendChild(error);
		}
		if (!entries.length) {
			const empty = document.createElement('div');
			empty.className = 'historyEmpty';
			empty.textContent = this.selectedWorkspace
				? localize('optimus.history.emptyForWorkspace', "No Backboard history was found for this workspace.")
				: localize('optimus.history.empty', "No Backboard history was found.");
			list.appendChild(empty);
			return list;
		}
		const historyList = document.createElement('div');
		historyList.className = 'historyList';
		for (const entry of entries) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `historyItem${this.selectedHistory?.id === entry.id ? ' active' : ''}`;
			button.addEventListener('click', () => this.openHistoryEntry(entry));
			const title = document.createElement('span');
			title.className = 'historyItemTitle';
			title.textContent = entry.title || entry.prompt || localize('optimus.history.untitled', "Untitled chat");
			const meta = document.createElement('span');
			meta.className = 'historyItemMeta';
			const metaText = document.createElement('span');
			metaText.textContent = `${historyTime(entry.updatedAt ?? entry.startedAt)} · ${workspaceLabel(entry.currentWorkspace)}`;
			const status = document.createElement('span');
			status.className = `historyItemStatus ${entry.status ?? ''}`;
			status.textContent = entry.status ?? 'history';
			meta.append(metaText, status);
			const preview = document.createElement('span');
			preview.className = 'historyItemPreview';
			preview.textContent = historyPreview(entry);
			button.append(title, meta, preview);
			historyList.appendChild(button);
		}
		list.appendChild(historyList);
		return list;
	}

	private renderHistoryTranscript(entry: IOptimusHistoryEntry): HTMLElement {
		const messages = document.createElement('div');
		messages.className = 'log viewPane active';
		if (entry.fileChanges.length) {
			messages.appendChild(this.renderHistoryChangeStack(entry));
		}
		for (const message of entry.messages) {
			messages.appendChild(this.renderMessageCard(message.role === 'assistant' ? 'agent' : message.role, message.content));
		}
		return messages;
	}

	private renderMessageCard(author: string, text: string): HTMLElement {
		const row = document.createElement('div');
		row.className = `messageCard ${author === 'agent' ? 'assistant' : author}`;
		const header = document.createElement('div');
		header.className = 'messageHeader';
		const label = document.createElement('strong');
		label.className = 'messageRole';
		label.textContent = messageAuthorLabel(author);
		header.appendChild(label);
		const body = document.createElement('div');
		body.className = 'messageText';
		body.textContent = text;
		row.append(header, body);
		return row;
	}

	private renderHistoryChangeStack(entry: IOptimusHistoryEntry): HTMLElement {
		const stack = document.createElement('div');
		stack.className = 'changeStack visible';
		const reviewCard = document.createElement('div');
		reviewCard.className = 'reviewCard';
		const header = document.createElement('div');
		header.className = 'reviewHeader';
		const icon = document.createElement('span');
		icon.className = 'typeDot';
		icon.textContent = '#';
		const title = document.createElement('span');
		title.className = 'reviewTitle';
		title.textContent = localize('optimus.panel.changedFiles', "Changed {0} files", entry.fileChanges.length);
		header.append(icon, title);
		reviewCard.appendChild(header);
		stack.appendChild(reviewCard);
		for (const change of entry.fileChanges.slice(0, 6)) {
			const fileCard = document.createElement('div');
			fileCard.className = 'reviewFile';
			const fileName = document.createElement('span');
			fileName.className = 'reviewFileName';
			fileName.textContent = change.path;
			const counts = document.createElement('span');
			counts.className = 'fileCount add';
			counts.textContent = `+${change.added ?? 0} -${change.removed ?? 0}`;
			fileCard.append(fileName, counts);
			stack.appendChild(fileCard);
		}
		return stack;
	}

	private renderStarterPanel(): HTMLElement {
		const panel = document.createElement('div');
		panel.className = 'log viewPane active';

		const state = document.createElement('div');
		state.className = 'emptyState';
		const tagline = document.createElement('div');
		tagline.className = 'emptyTagline';
		tagline.textContent = localize('optimus.starter.emptyPrompt', "Ready for a new Backboard prompt.");
		state.appendChild(tagline);
		panel.appendChild(state);
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
		stack.className = 'changeStack visible';

		const reviewCard = document.createElement('div');
		reviewCard.className = 'reviewCard';
		const header = document.createElement('div');
		header.className = 'reviewHeader';
		const icon = document.createElement('span');
		icon.className = 'typeDot';
		icon.textContent = '#';
		const title = document.createElement('span');
		title.className = 'reviewTitle';
		title.textContent = localize('optimus.panel.changedFiles', "Changed {0} files", run.filesChanged);
		const review = document.createElement('button');
		review.type = 'button';
		review.className = 'reviewButton';
		review.textContent = localize('optimus.review', "Review");
		review.disabled = !run.capabilities.canReview;
		review.addEventListener('click', event => {
			event.stopPropagation();
			this.store.reviewRun(run.id).catch(console.error);
		});
		header.append(icon, title, review);
		reviewCard.appendChild(header);
		stack.appendChild(reviewCard);

		for (const file of run.touchedFiles.slice(0, 3)) {
			const fileCard = document.createElement('div');
			fileCard.className = 'reviewFile';
			const fileName = document.createElement('span');
			fileName.className = 'reviewFileName';
			fileName.textContent = file;
			const counts = document.createElement('span');
			counts.className = 'fileCount add';
			counts.textContent = '+12 -3';
			fileCard.append(fileName, counts);
			stack.appendChild(fileCard);
		}

		return stack;
	}

	private renderFollowupForm(runId: string | undefined, starter: IOptimusStarterTask | undefined, history: IOptimusHistoryEntry | undefined): HTMLElement {
		const composer = document.createElement('div');
		composer.className = 'composer';
		const form = document.createElement('form');
		const input = document.createElement('textarea');
		input.rows = 2;
		input.placeholder = runId
			? localize('optimus.followup.placeholder', "Message Backboard...")
			: starter
				? localize('optimus.starter.placeholder', "Message Backboard...")
				: history
					? localize('optimus.history.followupPlaceholder', "Message Backboard...")
					: localize('optimus.followup.disabledPlaceholder', "Choose an empty slot");
		input.value = '';
		input.disabled = !runId && !starter && !history;

		const card = document.createElement('div');
		card.className = 'composerCard';
		const toolbar = document.createElement('div');
		toolbar.className = 'composerBar';
		const left = document.createElement('div');
		left.className = 'barLeft';
		left.appendChild(this.renderModeButton());
		left.appendChild(this.renderModelButton());
		const right = document.createElement('div');
		right.className = 'barRight';
		right.appendChild(this.renderComposerIconButton('○', localize('optimus.panel.web', "Web search")));
		right.appendChild(this.renderComposerIconButton('◌', localize('optimus.panel.image', "Image output")));
		right.appendChild(this.renderComposerIconButton('◍', localize('optimus.panel.usage', "Usage details")));
		right.appendChild(this.renderComposerIconButton('●', localize('optimus.panel.mic', "Start speech-to-text")));
		const send = document.createElement('button');
		send.type = 'submit';
		send.className = 'iconButton sendButton';
		send.title = localize('optimus.send', "Send");
		send.setAttribute('aria-label', send.title);
		send.textContent = '>';
		send.disabled = !runId && !starter && !history;
		input.addEventListener('input', () => {
			send.classList.toggle('ready', !!input.value.trim() && !send.disabled);
		});
		right.appendChild(send);
		toolbar.appendChild(left);
		toolbar.appendChild(right);
		card.appendChild(input);
		card.appendChild(toolbar);
		form.appendChild(card);
		composer.appendChild(form);
		form.addEventListener('submit', event => {
			event.preventDefault();
			const text = input.value.trim();
			if (runId && text && this.draftRunIds.has(runId)) {
				const draftRun = this.store.selectedRun;
				const slot = this.runSlots.get(runId) ?? this.nextOpenSlot();
				const provider = draftRun?.provider ?? OptimusProvider.Backboard;
				this.store.dismissRun(runId);
				this.runSlots.delete(runId);
				this.draftRunIds.delete(runId);
				this.selectedStarterSlot = slot;
				this.selectedStarter = starterTasks[slot] ?? starterTasks[0];
				this.createRun(text, provider).then(() => {
					input.value = '';
				}).catch(console.error);
			} else if (runId && text) {
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

		return composer;
	}

	private renderModeButton(): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'modeButton active';
		button.title = localize('optimus.chat.modeTitle', "Mode and reasoning");
		const glyph = document.createElement('span');
		glyph.className = 'modeGlyph';
		const label = document.createElement('span');
		label.className = 'modeLabel';
		label.textContent = localize('optimus.chat.mode', "Agent");
		const chevron = document.createElement('span');
		chevron.className = 'modelValue';
		chevron.textContent = '⌄';
		button.append(glyph, label, chevron);
		return button;
	}

	private renderModelButton(): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'modelButton';
		button.title = localize('optimus.task.model', "Backboard model");
		const icon = document.createElement('span');
		icon.className = 'modelIcon';
		icon.textContent = '□';
		const prefix = document.createElement('span');
		prefix.className = 'modelPrefix';
		prefix.textContent = localize('optimus.model.prefix', "Model");
		const value = document.createElement('span');
		value.className = 'modelValue';
		value.textContent = localize('optimus.model.auto', "Auto");
		const chevron = document.createElement('span');
		chevron.className = 'modelValue';
		chevron.textContent = '⌄';
		button.append(icon, prefix, value, chevron);
		return button;
	}

	private renderComposerIconButton(label: string, title: string): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'iconButton featureButton';
		button.title = title;
		button.setAttribute('aria-label', title);
		button.textContent = label;
		return button;
	}

	private renderDrawerResizeHandle(): HTMLElement {
		const handle = document.createElement('div');
		handle.className = 'optimus-drawer-resize-handle';
		handle.title = localize('optimus.resizeChat', "Resize chat");
		handle.addEventListener('pointerdown', event => {
			event.preventDefault();
			handle.setPointerCapture(event.pointerId);
			const startX = event.clientX;
			const startWidth = this.drawerWidth;
			const onPointerMove = (moveEvent: PointerEvent) => {
				this.drawerWidth = this.clampDrawerWidth(startWidth - (moveEvent.clientX - startX));
				this.updatePanelLayout();
			};
			const onPointerUp = (upEvent: PointerEvent) => {
				if (handle.hasPointerCapture(upEvent.pointerId)) {
					handle.releasePointerCapture(upEvent.pointerId);
				}
				document.removeEventListener('pointermove', onPointerMove);
				document.removeEventListener('pointerup', onPointerUp);
				document.removeEventListener('pointercancel', onPointerUp);
			};
			document.addEventListener('pointermove', onPointerMove);
			document.addEventListener('pointerup', onPointerUp);
			document.addEventListener('pointercancel', onPointerUp);
		});
		handle.addEventListener('dblclick', () => {
			this.drawerWidth = this.clampDrawerWidth(430);
			this.updatePanelLayout();
		});
		return handle;
	}

	private updatePanelLayout(): void {
		this.updateResponsiveLayout();
		this.drawerWidth = this.clampDrawerWidth(this.drawerWidth);
		this.content.style.setProperty('--optimus-drawer-width', `${this.drawerWidth}px`);
		this.content.classList.toggle('panel-closed', !this.isDrawerOpen);
	}

	private clampDrawerWidth(width: number): number {
		const viewportWidth = this.container.ownerDocument.defaultView?.innerWidth ?? 1200;
		const contentWidth = this.content?.clientWidth || viewportWidth;
		if (contentWidth < 760) {
			return clamp(width, 260, Math.max(260, contentWidth));
		}
		const minimumGridWidth = contentWidth >= 1180 ? 900 : 620;
		const maximum = Math.max(260, Math.min(640, contentWidth * 0.36, contentWidth - minimumGridWidth));
		const minimum = Math.min(280, maximum);
		return clamp(width, minimum, maximum);
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

function panelIconButton(label: string, title: string, handler: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'recentActionButton';
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
