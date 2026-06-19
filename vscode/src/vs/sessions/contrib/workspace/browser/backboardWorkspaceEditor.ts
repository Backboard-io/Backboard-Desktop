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
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { SessionView } from '../../../browser/parts/sessionView.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { BackboardWorkspaceEditorInput } from './backboardWorkspaceEditorInput.js';

interface IWorkspaceCardSlot {
	readonly session: ISession;
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
}

export class BackboardWorkspaceEditor extends EditorPane {

	static readonly ID = 'workbench.editor.backboardWorkspace';

	private root: HTMLElement | undefined;
	private cardsContainer: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private detailView: SessionView | undefined;
	private dimension: Dimension | undefined;

	private readonly cards = new Map<string, IWorkspaceCardSlot>();
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly previewDisposables = this._register(new DisposableStore());
	private readonly renderSessionTypePickerInControls = observableValue<boolean>(this, true);

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
	) {
		super(BackboardWorkspaceEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.backboard-workspace-editor'));

		const center = append(this.root, $('.backboard-workspace-center'));
		const header = append(center, $('.backboard-workspace-header'));
		const title = append(header, $('.backboard-workspace-title'));
		title.textContent = localize('backboardWorkspace.title', "Workspace");
		const subtitle = append(header, $('.backboard-workspace-subtitle'));
		subtitle.textContent = localize('backboardWorkspace.subtitle', "Open a workspace card, then continue the shared Copilot chat on the right.");

		this.cardsContainer = append(center, $('.backboard-workspace-cards'));

		this.detailContainer = append(this.root, $('.backboard-workspace-detail'));
		this.detailView = this._register(this.instantiationService.createInstance(SessionView));
		this.detailContainer.appendChild(this.detailView.element);

		this.renderDisposables.add(this.sessionsManagementService.onDidChangeSessions(() => this.renderCards()));
		this.renderDisposables.add(autorun(reader => {
			const active = this.sessionsService.activeSession.read(reader);
			this.detailView?.openSession(active, { renderSessionTypePickerInControls: this.renderSessionTypePickerInControls });
			this.detailView?.setActive(true);
			this.updateSelectedCard(active?.sessionId);
		}));

		this.renderCards();
	}

	override async setInput(input: BackboardWorkspaceEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderCards();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (!this.root || !this.detailView) {
			return;
		}

		size(this.root, dimension.width, dimension.height);
		const detailWidth = dimension.width <= 900 ? dimension.width : Math.min(Math.max(Math.floor(dimension.width * 0.34), 360), 560);
		const detailHeight = dimension.width <= 900 ? Math.floor(dimension.height * 0.48) : dimension.height;
		const detailLeft = dimension.width <= 900 ? 0 : dimension.width - detailWidth;
		const detailTop = dimension.width <= 900 ? dimension.height - detailHeight : 0;
		this.detailView.layout(detailWidth, detailHeight, detailTop, detailLeft);
	}

	override focus(): void {
		super.focus();
		this.detailView?.focus();
	}

	private renderCards(): void {
		if (!this.cardsContainer) {
			return;
		}

		const sessions = this.sessionsManagementService.getSessions()
			.filter(session => !session.isArchived.get())
			.sort((a, b) => b.updatedAt.get().getTime() - a.updatedAt.get().getTime());
		const liveIds = new Set(sessions.map(session => session.sessionId));
		for (const [sessionId, slot] of this.cards) {
			if (!liveIds.has(sessionId)) {
				slot.disposables.dispose();
				this.cards.delete(sessionId);
			}
		}

		this.previewDisposables.clear();
		clearNode(this.cardsContainer);

		for (const session of sessions) {
			let slot = this.cards.get(session.sessionId);
			if (!slot) {
				slot = this.createCardSlot(session);
				this.cards.set(session.sessionId, slot);
			}
			this.cardsContainer.appendChild(slot.element);
		}

		this.renderNewAgentCard();
		this.updateSelectedCard(this.sessionsService.activeSession.get()?.sessionId);
	}

	private renderNewAgentCard(): void {
		const container = this.cardsContainer;
		if (!container) {
			return;
		}

		const card = $('.backboard-workspace-card.backboard-workspace-card-new');
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.setAttribute('aria-label', localize('backboardWorkspace.newChatAria', "Create a new workspace chat"));
		card.appendChild(renderIcon(Codicon.sparkle));
		const label = append(card, $('.backboard-workspace-card-new-label'));
		label.textContent = localize('backboardWorkspace.newChat', "New Chat");

		const create = () => {
			this.sessionsService.openNewSession();
			this.detailView?.focus();
		};
		this.previewDisposables.add(addDisposableListener(card, EventType.CLICK, create));
		this.previewDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				create();
			}
		}));
		container.appendChild(card);
	}

	private createCardSlot(session: ISession): IWorkspaceCardSlot {
		const disposables = new DisposableStore();
		const card = $('.backboard-workspace-card');
		card.tabIndex = 0;
		card.setAttribute('role', 'button');

		const top = append(card, $('.backboard-workspace-card-top'));
		const icon = append(top, $('.backboard-workspace-card-status-icon'));
		const titleBlock = append(top, $('.backboard-workspace-card-title-block'));
		const title = append(titleBlock, $('.backboard-workspace-card-title'));
		const subtitle = append(titleBlock, $('.backboard-workspace-card-subtitle'));
		const status = append(top, $('.backboard-workspace-card-status'));
		const command = append(card, $('.backboard-workspace-card-command'));
		const activity = append(card, $('.backboard-workspace-card-activity'));
		const files = append(card, $('.backboard-workspace-card-files'));
		const footer = append(card, $('.backboard-workspace-card-footer'));

		const open = () => {
			void this.sessionsService.openSession(session.resource, { preserveFocus: true });
			this.detailView?.focus();
		};
		disposables.add(addDisposableListener(card, EventType.CLICK, open));
		disposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open();
			}
		}));

		disposables.add(autorun(reader => {
			const sessionTitle = session.title.read(reader) || localize('backboardWorkspace.untitled', "New Chat");
			const sessionStatus = session.status.read(reader);
			const workspace = session.workspace.read(reader);
			const changes = session.changes.read(reader);
			const changesSummary = session.changesSummary?.read(reader);
			const updatedAt = session.updatedAt.read(reader);
			const description = session.description.read(reader);

			card.setAttribute('aria-label', localize('backboardWorkspace.openChat', "Open {0}", sessionTitle));
			card.classList.toggle('running', sessionStatus === SessionStatus.InProgress);
			card.classList.toggle('blocked', sessionStatus === SessionStatus.NeedsInput);
			card.classList.toggle('done', sessionStatus === SessionStatus.Completed);
			card.classList.toggle('error', sessionStatus === SessionStatus.Error);

			clearNode(icon);
			icon.appendChild(renderIcon(this.statusIcon(sessionStatus)));
			title.textContent = sessionTitle;
			subtitle.textContent = workspace?.label ?? localize('backboardWorkspace.noWorkspace', "No workspace selected");
			status.textContent = this.statusLabel(sessionStatus);
			command.textContent = description?.value || localize('backboardWorkspace.defaultCommand', "Backboard workspace chat");

			clearNode(activity);
			this.appendActivityRow(activity, this.activityText(sessionStatus), this.statusIcon(sessionStatus));
			this.appendActivityRow(activity, changes.length > 0 || changesSummary
				? localize('backboardWorkspace.changedFiles', "{0} changed files", changesSummary?.files ?? changes.length)
				: localize('backboardWorkspace.noFilesTouched', "No files touched yet"), changes.length > 0 || changesSummary ? Codicon.diff : Codicon.file);

			clearNode(files);
			const visibleChanges = changes.slice(0, 3);
			if (visibleChanges.length === 0) {
				const chip = append(files, $('.backboard-workspace-card-file-chip.muted'));
				chip.textContent = localize('backboardWorkspace.noFileChips', "No file changes");
			} else {
				for (const change of visibleChanges) {
					const chip = append(files, $('.backboard-workspace-card-file-chip'));
					chip.textContent = this.fileLabel((isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri).path);
				}
				if (changes.length > visibleChanges.length) {
					const chip = append(files, $('.backboard-workspace-card-file-chip'));
					chip.textContent = localize('backboardWorkspace.moreFiles', "+{0} more", changes.length - visibleChanges.length);
				}
			}

			clearNode(footer);
			this.appendFooterItem(footer, fromNow(updatedAt, true, true), Codicon.clock);
			this.appendFooterItem(footer, session.providerId.includes('backboard') ? localize('backboardWorkspace.backboardProvider', "Backboard") : session.providerId, Codicon.sparkle);
		}));

		return { session, element: card, disposables };
	}

	private updateSelectedCard(activeId: string | undefined): void {
		for (const slot of this.cards.values()) {
			slot.element.classList.toggle('selected', slot.session.sessionId === activeId);
		}
	}

	private appendActivityRow(container: HTMLElement, label: string, icon: ThemeIcon): void {
		const row = append(container, $('.backboard-workspace-card-activity-row'));
		row.appendChild(renderIcon(icon));
		const text = document.createElement('span');
		text.textContent = label;
		row.appendChild(text);
	}

	private appendFooterItem(container: HTMLElement, label: string, icon: ThemeIcon): void {
		const item = append(container, $('.backboard-workspace-card-footer-item'));
		item.appendChild(renderIcon(icon));
		const text = document.createElement('span');
		text.textContent = label;
		item.appendChild(text);
	}

	private statusIcon(status: SessionStatus): ThemeIcon {
		switch (status) {
			case SessionStatus.InProgress:
				return Codicon.loading;
			case SessionStatus.NeedsInput:
				return Codicon.warning;
			case SessionStatus.Completed:
				return Codicon.check;
			case SessionStatus.Error:
				return Codicon.error;
			case SessionStatus.Untitled:
			default:
				return Codicon.circleOutline;
		}
	}

	private statusLabel(status: SessionStatus): string {
		switch (status) {
			case SessionStatus.InProgress:
				return localize('backboardWorkspace.status.running', "Running");
			case SessionStatus.NeedsInput:
				return localize('backboardWorkspace.status.blocked', "Needs Input");
			case SessionStatus.Completed:
				return localize('backboardWorkspace.status.done', "Done");
			case SessionStatus.Error:
				return localize('backboardWorkspace.status.error', "Error");
			case SessionStatus.Untitled:
			default:
				return localize('backboardWorkspace.status.draft', "Draft");
		}
	}

	private activityText(status: SessionStatus): string {
		switch (status) {
			case SessionStatus.InProgress:
				return localize('backboardWorkspace.activity.running', "Chat is running");
			case SessionStatus.NeedsInput:
				return localize('backboardWorkspace.activity.blocked', "Waiting for input");
			case SessionStatus.Completed:
				return localize('backboardWorkspace.activity.done', "Run completed");
			case SessionStatus.Error:
				return localize('backboardWorkspace.activity.error', "Run needs attention");
			case SessionStatus.Untitled:
			default:
				return localize('backboardWorkspace.activity.draft', "Draft ready");
		}
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
