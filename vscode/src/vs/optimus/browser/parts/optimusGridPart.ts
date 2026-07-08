/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/optimusGridPart.css';
import { $, append } from '../../../base/browser/dom.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter, Event } from '../../../base/common/event.js';
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

/**
 * Sessions the user explicitly closed from the grid. Everything else is open
 * by default; the set persists across relaunches so a closed chat stays
 * closed until the user opens it again (e.g. from the sidebar list).
 */
const CLOSED_SESSIONS_STORAGE_KEY = 'optimus.closedSessions';

/**
 * Main content part of the Optimus window: a fixed 3-column x 2-row grid of
 * six compact task cards. A passive renderer in the same sense as the Simple
 * window's SessionsPart — the sessions service drives it via
 * {@link updateVisibleSessions}, and card focus/clicks are reported back via
 * {@link onDidFocusSession}.
 */
export class OptimusGridPart extends Part {

	static readonly SLOT_COUNT = 6;

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	private readonly cards: OptimusCard[] = [];
	private gridContainer: HTMLElement | undefined;
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
		this.ensureCardCount(OptimusGridPart.SLOT_COUNT);

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
		const card = session
			? this.cards.find(c => c.session?.session.sessionId === session.sessionId)
			: this.cards.find(c => !c.session);
		card?.focus();
	}

	private ensureCardCount(count: number): void {
		const gridContainer = assertReturnsDefined(this.gridContainer);
		while (this.cards.length < count) {
			const card = this._register(this.instantiationService.createInstance(OptimusCard, gridContainer));
			this._register(card.onDidAction(action => {
				switch (action.kind) {
					case 'create-session':
						this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
						break;
					case 'close-session':
						// Closing removes the card (and persists the choice);
						// the session itself lives on and can be reopened from
						// the sidebar list.
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
			this.cards.push(card);
		}
	}

	private refreshCards(): void {
		if (!this.gridContainer) {
			return;
		}

		const cards = this.buildCardModels();
		this.ensureCardCount(cards.length);

		for (let i = 0; i < this.cards.length; i++) {
			const cardModel = cards[i];
			const card = this.cards[i];
			card.element.style.display = i < cards.length ? '' : 'none';
			if (i < cards.length) {
				card.bind(cardModel, !!cardModel && cardModel.session.sessionId === this.activeSession?.sessionId);
			}
		}

		// Card sizes depend on how many grid tracks are occupied.
		for (const card of this.cards) {
			card.layout();
		}
	}

	private buildCardModels(): (IOptimusCardSessionModel | undefined)[] {
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

		// Cards are assigned to slots by index, so the model order must be
		// stable across refreshes: visibility arriving later must not reorder
		// sessions, or every card rebinds to a different session and cancels
		// its in-flight chat load. Iterate the service's session list and
		// enrich in place instead of putting visible sessions first.
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

		return [...models, undefined];
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
		for (const card of this.cards) {
			card.layout();
		}
	}

	toJSON(): object {
		return {
			type: Parts.SESSIONS_PART
		};
	}
}
