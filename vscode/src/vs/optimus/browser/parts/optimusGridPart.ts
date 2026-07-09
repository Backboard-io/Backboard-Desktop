/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/optimusGridPart.css';
import { $, addDisposableListener, append, EventType } from '../../../base/browser/dom.js';
import { localize } from '../../../nls.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { AbstractProgressScope, ScopedProgressIndicator } from '../../../workbench/services/progress/browser/progressIndicator.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../../sessions/common/theme.js';
import { SessionType } from '../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISessionsManagementService, IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../../sessions/services/sessions/common/session.js';
import { OptimusCard, IOptimusCardSessionModel } from './optimusCard.js';

export const OPTIMUS_NEW_SESSION_COMMAND_ID = 'optimus.newSession';
export const OPTIMUS_FOCUS_SESSION_COMMAND_ID = 'optimus.focusSession';
export const OPTIMUS_DELETE_SESSION_COMMAND_ID = 'optimus.deleteSession';
export const OPTIMUS_CLOSE_SESSION_COMMAND_ID = 'optimus.closeSession';

/**
 * Sessions the user explicitly closed from the grid. Everything else is open
 * by default; the set persists across relaunches so a closed chat stays
 * closed until the user opens it again (e.g. from the sidebar list).
 */
const CLOSED_SESSIONS_STORAGE_KEY = 'optimus.closedSessions';

interface ICardEntry {
	readonly card: OptimusCard;
	readonly store: DisposableStore;
}

/**
 * Main content part of the Optimus window: a grid of compact task cards plus
 * a start-a-task placeholder. A passive renderer in the same sense as the
 * Simple window's SessionsPart — the sessions service drives it via
 * {@link updateVisibleSessions}, and card focus/clicks are reported back via
 * {@link onDidFocusSession}.
 *
 * Cards are keyed by session, NOT by grid slot: closing or adding a session
 * must never rebind the remaining cards to different sessions, or their
 * attached live transcripts would be torn down.
 */
export class OptimusGridPart extends Part {

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	/** Six card slots per page (3x2); older sessions paginate. */
	private static readonly PAGE_SIZE = 6;

	private readonly cardEntries = new Map<string, ICardEntry>();
	private placeholderCard: OptimusCard | undefined;
	private gridContainer: HTMLElement | undefined;
	private pageIndex = 0;
	private pagerElement: HTMLElement | undefined;
	private pagerLabel: HTMLElement | undefined;
	private pagerPrevious: HTMLButtonElement | undefined;
	private pagerNext: HTMLButtonElement | undefined;
	private progressBar: ProgressBar | undefined;
	private progressIndicator: IProgressIndicator | undefined;
	private visibleSessions: readonly (IActiveSession | undefined)[] = [];
	private activeSession: IActiveSession | undefined;

	private readonly _onDidFocusSession = this._register(new Emitter<string>());
	readonly onDidFocusSession: Event<string> = this._onDidFocusSession.event;

	private readonly closedSessions = new Set<string>();

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
	) {
		super(
			Parts.SESSIONS_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);

		try {
			const raw = this.storageService.get(CLOSED_SESSIONS_STORAGE_KEY, StorageScope.PROFILE);
			if (raw) {
				for (const key of JSON.parse(raw) as string[]) {
					this.closedSessions.add(key);
				}
			}
		} catch {
			// Malformed storage: treat everything as open.
		}

		this._register(this.sessionsManagementService.onDidChangeSessions(() => this.refreshCards()));
	}

	private persistClosedSessions(): void {
		this.storageService.store(CLOSED_SESSIONS_STORAGE_KEY, JSON.stringify([...this.closedSessions]), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private closeSession(key: string): void {
		this.closedSessions.add(key);
		this.persistClosedSessions();
		this.refreshCards();
	}

	/** Sessions opened through the service (sidebar click, new chat) un-close themselves. */
	private uncloseSession(key: string): void {
		if (this.closedSessions.delete(key)) {
			this.persistClosedSessions();
		}
	}

	override create(parent: HTMLElement): void {
		// The workbench grid reads `part.element`; the Part base does not set it.
		this.element = parent;
		super.create(parent);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = append(parent, $('.content.optimus-grid-content'));

		this.progressBar = this._register(new ProgressBar(contentArea, defaultProgressBarStyles));
		this.progressBar.hide();

		this.gridContainer = append(contentArea, $('.optimus-grid'));

		// Persistent "start a task" placeholder, always the last grid item.
		const placeholder = this._register(this.instantiationService.createInstance(OptimusCard, this.gridContainer));
		this._register(placeholder.onDidAction(action => {
			if (action.kind === 'create-session') {
				this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
			}
		}));
		this.placeholderCard = placeholder;

		// Pager below the grid; hidden while everything fits on one page.
		this.pagerElement = append(contentArea, $('.optimus-grid-pager'));
		this.pagerPrevious = append(this.pagerElement, $('button')) as HTMLButtonElement;
		this.pagerPrevious.textContent = '‹';
		this.pagerPrevious.title = localize('optimus.pager.previous', "Previous page");
		this.pagerLabel = append(this.pagerElement, $('span.optimus-grid-pager-label'));
		this.pagerNext = append(this.pagerElement, $('button')) as HTMLButtonElement;
		this.pagerNext.textContent = '›';
		this.pagerNext.title = localize('optimus.pager.next', "Next page");
		this._register(addDisposableListener(this.pagerPrevious, EventType.CLICK, () => {
			this.pageIndex = Math.max(0, this.pageIndex - 1);
			this.refreshCards();
		}));
		this._register(addDisposableListener(this.pagerNext, EventType.CLICK, () => {
			this.pageIndex = this.pageIndex + 1;
			this.refreshCards();
		}));

		this.refreshCards();

		return contentArea;
	}

	/**
	 * Reconcile the six fixed slots against the service's visible sessions.
	 * Sessions beyond the sixth slot are not rendered.
	 */
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions = visible;
		this.activeSession = active;
		this.refreshCards();
	}

	focusSession(session: IActiveSession | undefined): void {
		if (!session) {
			this.placeholderCard?.focus();
			return;
		}
		for (const entry of this.cardEntries.values()) {
			if (entry.card.session?.session.sessionId === session.sessionId) {
				entry.card.focus();
				return;
			}
		}
	}

	private createCardEntry(key: string): ICardEntry {
		const gridContainer = assertReturnsDefined(this.gridContainer);
		const store = new DisposableStore();
		const card = store.add(this.instantiationService.createInstance(OptimusCard, gridContainer));
		store.add(card.onDidAction(action => {
			switch (action.kind) {
				case 'create-session':
					this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
					break;
				case 'close-session':
					// Close at the service level first (via command — the
					// sessions service cannot be constructor-injected here,
					// it depends on this part): a session that is open there
					// (e.g. the active one in the right panel) stays in the
					// visible set otherwise, and the visible-means-open rule
					// would instantly un-close it, making the active card
					// impossible to close. The session itself lives on in
					// the sidebar list.
					this.commandService.executeCommand(OPTIMUS_CLOSE_SESSION_COMMAND_ID, action.card.session.resource);
					this.closeSession(action.card.session.resource.toString());
					break;
				case 'focus-session':
					if (action.card.isVisible && action.card.activeSession) {
						this._onDidFocusSession.fire(action.card.activeSession.sessionId);
					} else {
						this.commandService.executeCommand(OPTIMUS_FOCUS_SESSION_COMMAND_ID, action.card.session.resource);
					}
					break;
			}
		}));
		const entry: ICardEntry = { card, store };
		this.cardEntries.set(key, entry);
		return entry;
	}

	private disposeCardEntry(key: string, entry: ICardEntry): void {
		this.cardEntries.delete(key);
		entry.card.element.remove();
		entry.store.dispose();
	}

	private refreshCards(): void {
		const gridContainer = this.gridContainer;
		if (!gridContainer) {
			return;
		}

		// Paginate: six slots per page; the "start a task" placeholder
		// occupies the slot right after the last session, so a full page
		// pushes it onto the next one.
		const allModels = this.buildCardModels();
		const totalItems = allModels.length + 1;
		const totalPages = Math.max(1, Math.ceil(totalItems / OptimusGridPart.PAGE_SIZE));
		this.pageIndex = Math.min(Math.max(0, this.pageIndex), totalPages - 1);
		const pageStart = this.pageIndex * OptimusGridPart.PAGE_SIZE;
		const models = allModels.slice(pageStart, pageStart + OptimusGridPart.PAGE_SIZE);
		const placeholderOnThisPage = allModels.length >= pageStart && allModels.length < pageStart + OptimusGridPart.PAGE_SIZE;
		const modelKeys = new Set(models.map(model => model.session.resource.toString()));

		// Drop cards whose session left this page (closed, deleted, paged out).
		for (const [key, entry] of [...this.cardEntries]) {
			if (!modelKeys.has(key)) {
				this.disposeCardEntry(key, entry);
			}
		}

		// Bind each session to ITS card (creating on demand) and keep the DOM
		// in model order without touching cards that are already in place —
		// reparenting a card would disturb its live transcript.
		let previousElement: HTMLElement | undefined;
		for (const model of models) {
			const key = model.session.resource.toString();
			const entry = this.cardEntries.get(key) ?? this.createCardEntry(key);
			entry.card.bind(model, model.session.sessionId === this.activeSession?.sessionId);

			const element = entry.card.element;
			const expectedPrevious = previousElement ?? null;
			if (element.previousElementSibling !== expectedPrevious) {
				gridContainer.insertBefore(element, expectedPrevious ? expectedPrevious.nextElementSibling : gridContainer.firstElementChild);
			}
			previousElement = element;
		}

		// The placeholder is the last grid item of the page that has room.
		if (this.placeholderCard) {
			this.placeholderCard.element.style.display = placeholderOnThisPage ? '' : 'none';
			if (placeholderOnThisPage && this.placeholderCard.element.nextElementSibling) {
				gridContainer.appendChild(this.placeholderCard.element);
			}
		}

		this.updatePager(totalPages);

		// Card sizes depend on how many grid tracks are occupied.
		this.layoutCards();
	}

	private updatePager(totalPages: number): void {
		if (!this.pagerElement || !this.pagerLabel || !this.pagerPrevious || !this.pagerNext) {
			return;
		}
		this.pagerElement.style.display = totalPages > 1 ? '' : 'none';
		this.pagerLabel.textContent = localize('optimus.pager.label', "{0} of {1}", this.pageIndex + 1, totalPages);
		this.pagerPrevious.disabled = this.pageIndex === 0;
		this.pagerNext.disabled = this.pageIndex >= totalPages - 1;
	}

	private layoutCards(): void {
		for (const entry of this.cardEntries.values()) {
			entry.card.layout();
		}
	}

	private buildCardModels(): IOptimusCardSessionModel[] {
		const isCommittedSession = (session: ISession): boolean => session.status.get() !== SessionStatus.Untitled;
		// Advanced orchestrates Backboard chats only for now: other local
		// agent sessions (Claude Code, Codex, …) stream through per-session
		// CLI processes that are too heavy to mirror in every card.
		const isBackboardSession = (session: ISession): boolean =>
			session.sessionType === 'backboard' || session.sessionType === SessionType.AgentHostBackboard;
		const visibleByKey = new Map<string, IActiveSession>();
		for (const session of this.visibleSessions) {
			if (session && isCommittedSession(session) && isBackboardSession(session)) {
				// A session open through the service (sidebar click, new chat)
				// is open by definition — un-close it so it persists as open.
				this.uncloseSession(session.resource.toString());
				visibleByKey.set(session.resource.toString(), session);
			}
		}

		// Keep the model order stable across refreshes (service list order,
		// visibility enriched in place): cards are keyed by session, but a
		// stable order avoids reparenting card DOM, which would disturb the
		// live transcripts.
		const models: IOptimusCardSessionModel[] = [];
		const seen = new Set<string>();
		for (const session of this.sessionsManagementService.getSessions()) {
			if (!isCommittedSession(session) || !isBackboardSession(session)) {
				continue;
			}

			const key = session.resource.toString();
			if (seen.has(key) || this.closedSessions.has(key)) {
				continue;
			}
			seen.add(key);

			const active = visibleByKey.get(key);
			models.push(active
				? { session: active, chatResource: active.activeChat.get().resource, isVisible: true, activeSession: active }
				: { session, chatResource: session.mainChat.get().resource, isVisible: false });
		}

		// Visible sessions the service list doesn't know yet (e.g. a brand-new
		// chat before its first list refresh) still get a card, at the end.
		for (const [key, active] of visibleByKey) {
			if (!seen.has(key)) {
				seen.add(key);
				models.push({ session: active, chatResource: active.activeChat.get().resource, isVisible: true, activeSession: active });
			}
		}

		return models;
	}

	getProgressIndicator(): IProgressIndicator {
		if (!this.progressIndicator) {
			const progressBar = assertReturnsDefined(this.progressBar);
			const scopeId = Parts.SESSIONS_PART;
			const isVisible = this.layoutService.isVisible(scopeId);
			const onDidVisibilityChange = this.onDidVisibilityChange;
			const scope = this._register(new class extends AbstractProgressScope {
				constructor() {
					super(scopeId, isVisible);
					this._register(onDidVisibilityChange(visible => visible ? this.onScopeOpened(scopeId) : this.onScopeClosed(scopeId)));
				}
			}());
			this.progressIndicator = this._register(new ScopedProgressIndicator(progressBar, scope));
		}
		return this.progressIndicator;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);
		this.layoutCards();
	}

	toJSON(): object {
		return {
			type: Parts.SESSIONS_PART
		};
	}

	override dispose(): void {
		for (const [key, entry] of [...this.cardEntries]) {
			this.disposeCardEntry(key, entry);
		}
		super.dispose();
	}
}
