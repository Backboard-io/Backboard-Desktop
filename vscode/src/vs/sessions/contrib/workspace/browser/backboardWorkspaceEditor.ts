/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/backboardWorkspaceEditor.css';
import { $, Dimension, EventType, addDisposableListener, append, clearNode, size } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISession, ISessionChangesSummary, ISessionFileChange, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { BackboardWorkspaceEditorInput } from './backboardWorkspaceEditorInput.js';

const OPEN_BACKBOARD_AGENTS_COMMAND_ID = 'backboard.agents.open';

type WorkspaceCardKind = 'live' | 'done' | 'blocked' | 'idle';

interface IWorkspaceCardSlot {
	readonly session: ISession;
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
}

export class BackboardWorkspaceEditor extends EditorPane {

	static readonly ID = 'workbench.editor.backboardWorkspace';

	private root: HTMLElement | undefined;
	private agentCount: HTMLElement | undefined;
	private cardsContainer: HTMLElement | undefined;
	private dimension: Dimension | undefined;

	private readonly cards = new Map<string, IWorkspaceCardSlot>();
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly cardRenderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(BackboardWorkspaceEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.backboard-workspace-editor'));
		this.root.tabIndex = -1;

		const shell = append(this.root, $('.backboard-workspace-shell'));
		const header = append(shell, $('.backboard-workspace-header'));

		const title = append(header, $('h1.backboard-workspace-title'));
		title.textContent = localize('backboardWorkspace.title', "Agent Workspace");
		this.agentCount = append(header, $('.backboard-workspace-agent-count'));

		const spacer = append(header, $('.backboard-workspace-header-spacer'));
		spacer.setAttribute('aria-hidden', 'true');
		this.appendHeaderIcon(header, localize('backboardWorkspace.filter', "Filter agents"), Codicon.filter);
		this.appendHeaderIcon(header, localize('backboardWorkspace.sort', "Sort agents"), Codicon.sortPrecedence);

		this.cardsContainer = append(shell, $('.backboard-workspace-grid'));

		this.renderDisposables.add(this.sessionsManagementService.onDidChangeSessions(() => this.render()));
		this.renderDisposables.add(autorun(reader => {
			this.updateSelectedCard(this.sessionsService.activeSession.read(reader)?.sessionId);
		}));

		this.render();
	}

	override async setInput(input: BackboardWorkspaceEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.render();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (!this.root) {
			return;
		}

		size(this.root, dimension.width, dimension.height);
	}

	override focus(): void {
		super.focus();
		this.root?.focus();
	}

	private render(): void {
		const sessions = this.getWorkspaceSessions();
		this.updateHeader(sessions);
		this.renderCards(sessions);
	}

	private updateHeader(sessions: ISession[]): void {
		if (!this.agentCount) {
			return;
		}

		this.agentCount.textContent = sessions.length === 1
			? localize('backboardWorkspace.oneAgent', "1 agent")
			: localize('backboardWorkspace.agentCount', "{0} agents", sessions.length);
	}

	private renderCards(sessions: ISession[]): void {
		if (!this.cardsContainer) {
			return;
		}

		const liveIds = new Set(sessions.map(session => session.sessionId));
		for (const [sessionId, slot] of this.cards) {
			if (!liveIds.has(sessionId)) {
				slot.disposables.dispose();
				this.cards.delete(sessionId);
			}
		}

		this.cardRenderDisposables.clear();
		clearNode(this.cardsContainer);

		if (sessions.length === 0) {
			this.renderEmptyState();
			return;
		}

		for (const session of sessions) {
			let slot = this.cards.get(session.sessionId);
			if (!slot) {
				slot = this.createCardSlot(session);
				this.cards.set(session.sessionId, slot);
			}
			this.cardsContainer.appendChild(slot.element);
		}

		this.updateSelectedCard(this.sessionsService.activeSession.get()?.sessionId);
	}

	private renderEmptyState(): void {
		if (!this.cardsContainer) {
			return;
		}

		const empty = append(this.cardsContainer, $('.backboard-workspace-empty'));
		empty.appendChild(renderIcon(Codicon.layoutPanel));
		const title = append(empty, $('.backboard-workspace-empty-title'));
		title.textContent = localize('backboardWorkspace.emptyTitle', "No agents yet");
		const message = append(empty, $('.backboard-workspace-empty-message'));
		message.textContent = localize('backboardWorkspace.emptyMessage', "Start a Backboard chat to track active work for this workspace.");

		const button = append(empty, $('button.backboard-workspace-empty-action')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.sparkle));
		const text = document.createElement('span');
		text.textContent = localize('backboardWorkspace.emptyAction', "New Chat");
		button.appendChild(text);
		this.cardRenderDisposables.add(addDisposableListener(button, EventType.CLICK, () => this.openNewChat()));
	}

	private createCardSlot(session: ISession): IWorkspaceCardSlot {
		const disposables = new DisposableStore();
		const card = $('.backboard-workspace-card');
		card.tabIndex = 0;
		card.setAttribute('role', 'button');

		const top = append(card, $('.backboard-workspace-card-header'));
		const dot = append(top, $('.backboard-workspace-status-dot'));
		const title = append(top, $('.backboard-workspace-card-title'));
		const status = append(top, $('.backboard-workspace-status-pill'));
		const menu = append(top, $('button.backboard-workspace-card-menu')) as HTMLButtonElement;
		menu.type = 'button';
		menu.setAttribute('aria-label', localize('backboardWorkspace.cardMenu', "Agent actions"));
		menu.appendChild(renderIcon(Codicon.ellipsis));

		const command = append(card, $('.backboard-workspace-command'));
		const commandLabel = append(command, $('.backboard-workspace-command-label'));
		const commandText = append(command, $('.backboard-workspace-command-text'));
		const activity = append(card, $('.backboard-workspace-activity-list'));
		const files = append(card, $('.backboard-workspace-file-chips'));
		const footer = append(card, $('.backboard-workspace-card-footer'));

		const open = () => this.openSessionInAgents(session);
		disposables.add(addDisposableListener(card, EventType.CLICK, open));
		disposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open();
			}
		}));
		disposables.add(addDisposableListener(menu, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
		}));

		disposables.add(autorun(reader => {
			const sessionTitle = session.title.read(reader) || localize('backboardWorkspace.untitled', "New Agent");
			const sessionStatus = session.status.read(reader);
			const changes = session.changes.read(reader);
			const changesSummary = session.changesSummary?.read(reader);
			const updatedAt = session.updatedAt.read(reader);
			const lastTurnEnd = session.lastTurnEnd.read(reader);
			const description = session.description.read(reader)?.value;
			const modelId = session.modelId.read(reader);
			const mode = session.mode.read(reader);
			const kind = this.statusKind(sessionStatus);

			card.setAttribute('aria-label', localize('backboardWorkspace.openChat', "Open {0} in Agents", sessionTitle));
			card.classList.toggle('live', kind === 'live');
			card.classList.toggle('done', kind === 'done');
			card.classList.toggle('blocked', kind === 'blocked');
			card.classList.toggle('idle', kind === 'idle');

			dot.className = `backboard-workspace-status-dot ${kind}`;
			title.textContent = sessionTitle;
			status.textContent = this.statusLabel(sessionStatus);
			status.className = `backboard-workspace-status-pill ${kind}`;
			commandLabel.textContent = this.commandLabel(mode?.id, session.sessionType, session.providerId);
			commandText.textContent = this.commandText(description, sessionStatus, changes, changesSummary);

			clearNode(activity);
			this.renderActivity(activity, kind, sessionStatus, changes, changesSummary, updatedAt, lastTurnEnd, description);

			clearNode(files);
			this.renderFiles(files, changes);

			clearNode(footer);
			this.renderFooter(footer, kind, modelId, session.providerId, updatedAt);
		}));

		return { session, element: card, disposables };
	}

	private getWorkspaceSessions(): ISession[] {
		return this.sessionsManagementService.getSessions()
			.filter(session => !session.isArchived.get())
			.sort((a, b) => b.updatedAt.get().getTime() - a.updatedAt.get().getTime());
	}

	private appendHeaderIcon(container: HTMLElement, label: string, icon: ThemeIcon): HTMLButtonElement {
		const button = append(container, $('button.backboard-workspace-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		return button;
	}

	private openNewChat(): void {
		void this.commandService.executeCommand(OPEN_BACKBOARD_AGENTS_COMMAND_ID)
			.then(() => this.sessionsService.openNewSession());
	}

	private openSessionInAgents(session: ISession): void {
		void this.commandService.executeCommand(OPEN_BACKBOARD_AGENTS_COMMAND_ID)
			.then(() => this.sessionsService.openSession(session.resource));
	}

	private updateSelectedCard(activeId: string | undefined): void {
		for (const slot of this.cards.values()) {
			slot.element.classList.toggle('selected', slot.session.sessionId === activeId);
		}
	}

	private renderActivity(container: HTMLElement, kind: WorkspaceCardKind, status: SessionStatus, changes: readonly ISessionFileChange[], changesSummary: ISessionChangesSummary | undefined, updatedAt: Date, lastTurnEnd: Date | undefined, description: string | undefined): void {
		if (kind === 'blocked') {
			const blocked = append(container, $('.backboard-workspace-blocked-state'));
			blocked.appendChild(renderIcon(status === SessionStatus.Error ? Codicon.error : Codicon.warning));
			const title = append(blocked, $('.backboard-workspace-blocked-title'));
			title.textContent = status === SessionStatus.Error
				? localize('backboardWorkspace.errorTitle', "Needs attention")
				: localize('backboardWorkspace.blockedTitle', "Waiting on dependency");
			const message = append(blocked, $('.backboard-workspace-blocked-message'));
			message.textContent = description || localize('backboardWorkspace.blockedMessage', "This agent is paused until the next input is provided.");
			return;
		}

		if (kind === 'done') {
			const visibleChanges = changes.slice(0, 2);
			if (visibleChanges.length === 0) {
				this.appendSuccessRow(container, this.activityTime(lastTurnEnd ?? updatedAt), localize('backboardWorkspace.completedNoFiles', "Run completed"));
			} else {
				for (const change of visibleChanges) {
					this.appendSuccessRow(container, this.activityTime(updatedAt), localize('backboardWorkspace.fileUpdated', "{0} updated", this.fileLabel((isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri).path)));
				}
			}
			this.appendTimelineRow(container, this.activityTime(updatedAt), changesSummary
				? localize('backboardWorkspace.changesSummary', "{0} files changed", changesSummary.files)
				: localize('backboardWorkspace.completedSummary', "Workspace changes are ready"));
			return;
		}

		const visibleChanges = changes.slice(0, 5);
		if (visibleChanges.length === 0) {
			this.appendToolRow(container, this.emptyActivityLabel(status, description));
			return;
		}

		for (const change of visibleChanges) {
			this.appendToolRow(container, localize('backboardWorkspace.writeFile', "write_file {0}", this.fileLabel((isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri).path)));
		}
		this.appendSuccessRow(container, this.activityTime(updatedAt), changesSummary
			? localize('backboardWorkspace.changedFiles', "{0} files touched", changesSummary.files)
			: localize('backboardWorkspace.latestChange', "latest file change recorded"));
	}

	private renderFiles(container: HTMLElement, changes: readonly ISessionFileChange[]): void {
		const visibleChanges = changes.slice(0, 3);
		if (visibleChanges.length === 0) {
			const chip = append(container, $('.backboard-workspace-file-chip.muted'));
			chip.appendChild(renderIcon(Codicon.info));
			const text = document.createElement('span');
			text.textContent = localize('backboardWorkspace.noFileChips', "No file changes");
			chip.appendChild(text);
			return;
		}

		for (const change of visibleChanges) {
			const chip = append(container, $('.backboard-workspace-file-chip'));
			chip.appendChild(renderIcon(Codicon.info));
			const text = document.createElement('span');
			text.textContent = this.fileLabel((isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri).path);
			chip.appendChild(text);
		}

		if (changes.length > visibleChanges.length) {
			const chip = append(container, $('.backboard-workspace-file-chip'));
			chip.appendChild(renderIcon(Codicon.info));
			const text = document.createElement('span');
			text.textContent = localize('backboardWorkspace.moreFiles', "+{0} more", changes.length - visibleChanges.length);
			chip.appendChild(text);
		}
	}

	private renderFooter(container: HTMLElement, kind: WorkspaceCardKind, modelId: string | undefined, providerId: string, updatedAt: Date): void {
		const left = append(container, $('.backboard-workspace-card-footer-left'));
		left.title = fromNow(updatedAt, true, true);
		switch (kind) {
			case 'live':
				left.appendChild(renderIcon(Codicon.circleOutline));
				break;
			case 'done':
				left.appendChild(renderIcon(Codicon.check));
				left.appendChild(renderIcon(Codicon.gitBranch));
				break;
			case 'blocked':
				left.appendChild(renderIcon(Codicon.refresh));
				break;
			case 'idle':
				left.appendChild(renderIcon(Codicon.circle));
				break;
		}

		const spacer = append(container, $('.backboard-workspace-card-footer-spacer'));
		spacer.setAttribute('aria-hidden', 'true');

		const model = append(container, $('.backboard-workspace-card-model'));
		model.textContent = this.modelLabel(modelId, providerId);
		container.appendChild(renderIcon(Codicon.linkExternal));
	}

	private appendToolRow(container: HTMLElement, label: string): void {
		const row = append(container, $('.backboard-workspace-activity-row.tool'));
		append(row, $('.backboard-workspace-activity-dot'));
		const text = document.createElement('span');
		text.textContent = label;
		row.appendChild(text);
	}

	private appendSuccessRow(container: HTMLElement, time: string, label: string): void {
		const row = append(container, $('.backboard-workspace-activity-row.success'));
		const timeNode = append(row, $('.backboard-workspace-activity-time'));
		timeNode.textContent = time;
		row.appendChild(renderIcon(Codicon.check));
		const text = document.createElement('span');
		text.textContent = label;
		row.appendChild(text);
	}

	private appendTimelineRow(container: HTMLElement, time: string, label: string): void {
		const row = append(container, $('.backboard-workspace-activity-row.timeline'));
		const timeNode = append(row, $('.backboard-workspace-activity-time'));
		timeNode.textContent = time;
		const marker = append(row, $('.backboard-workspace-activity-question'));
		marker.textContent = '?';
		const text = document.createElement('span');
		text.textContent = label;
		row.appendChild(text);
	}

	private statusKind(status: SessionStatus): WorkspaceCardKind {
		switch (status) {
			case SessionStatus.InProgress:
				return 'live';
			case SessionStatus.Completed:
				return 'done';
			case SessionStatus.NeedsInput:
			case SessionStatus.Error:
				return 'blocked';
			case SessionStatus.Untitled:
			default:
				return 'idle';
		}
	}

	private statusLabel(status: SessionStatus): string {
		switch (status) {
			case SessionStatus.InProgress:
				return localize('backboardWorkspace.status.live', "LIVE");
			case SessionStatus.Completed:
				return localize('backboardWorkspace.status.done', "DONE");
			case SessionStatus.NeedsInput:
				return localize('backboardWorkspace.status.blocked', "BLOCKED");
			case SessionStatus.Error:
				return localize('backboardWorkspace.status.error', "ERROR");
			case SessionStatus.Untitled:
			default:
				return localize('backboardWorkspace.status.idle', "IDLE");
		}
	}

	private commandLabel(modeId: string | undefined, sessionType: string, providerId: string): string {
		if (modeId) {
			return `$ ${modeId}`;
		}

		return sessionType || providerId;
	}

	private commandText(description: string | undefined, status: SessionStatus, changes: readonly ISessionFileChange[], changesSummary: ISessionChangesSummary | undefined): string {
		if (description) {
			return description;
		}

		if (changesSummary) {
			return localize('backboardWorkspace.changeSummaryCommandText', "{0} files changed", changesSummary.files);
		}

		if (changes.length > 0) {
			return localize('backboardWorkspace.changeCountCommandText', "{0} files changed", changes.length);
		}

		switch (status) {
			case SessionStatus.Completed:
				return localize('backboardWorkspace.doneCommandText', "Auto-generated changes are ready to review");
			case SessionStatus.NeedsInput:
			case SessionStatus.Error:
				return localize('backboardWorkspace.blockedCommandText', "Waiting for follow-up before continuing");
			case SessionStatus.InProgress:
				return localize('backboardWorkspace.runningCommandText', "Agent is working");
			case SessionStatus.Untitled:
			default:
				return localize('backboardWorkspace.emptyCommandText', "No request sent yet");
		}
	}

	private emptyActivityLabel(status: SessionStatus, description: string | undefined): string {
		if (description) {
			return description;
		}

		switch (status) {
			case SessionStatus.InProgress:
				return localize('backboardWorkspace.runningDefault', "Agent is working");
			case SessionStatus.Completed:
				return localize('backboardWorkspace.noFilesTouched', "No file changes");
			case SessionStatus.NeedsInput:
			case SessionStatus.Error:
				return localize('backboardWorkspace.waitingDefault', "Waiting for follow-up");
			case SessionStatus.Untitled:
			default:
				return localize('backboardWorkspace.noActivityYet', "No activity yet");
		}
	}

	private activityTime(date: Date): string {
		return fromNow(date, true, true);
	}

	private modelLabel(modelId: string | undefined, providerId: string): string {
		const raw = modelId || providerId;
		const leaf = raw.replace(/^~/, '').split('/').pop() || raw;
		const normalized = leaf.replace(/^claude[-_]?/i, '').replace(/[-_]+/g, ' ').trim();
		if (/haiku/i.test(normalized)) {
			return localize('backboardWorkspace.modelHaiku', "Haiku 4.5");
		}
		if (/sonnet/i.test(normalized)) {
			return localize('backboardWorkspace.modelSonnet', "Sonnet 4.6");
		}
		if (/gemini/i.test(normalized)) {
			return localize('backboardWorkspace.modelGemini', "Gemini Flash");
		}
		return normalized || raw;
	}

	private fileLabel(path: string): string {
		return path.split(/[\\/]/).pop() || path;
	}

	override dispose(): void {
		for (const slot of this.cards.values()) {
			slot.disposables.dispose();
		}
		this.cards.clear();
		super.dispose();
	}
}
