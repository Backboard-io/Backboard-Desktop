/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderBackboardAuthSetup } from '../../../workbench/contrib/chat/browser/backboardAuthSetup.js';
import { BackboardAuthContextKeys, hasAlternativeBackboardCredentials } from '../../../workbench/contrib/chat/common/backboardAuth.js';
import './media/sessionView.css';
import { $, addDisposableListener, EventType, size } from '../../../base/browser/dom.js';
import { ISerializableView, IViewSize } from '../../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import product from '../../../platform/product/common/product.js';
import { asCssVariable } from '../../../platform/theme/common/colorUtils.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';
import { IChatViewFactory } from '../../services/chatView/browser/chatViewFactory.js';
import { AbstractChatView, ChatViewKind, IChatViewOptions } from './chatView.js';
import { ChatCompositeBar } from './chatCompositeBar.js';
import { SessionHeader, SessionViewFloatingToolbar } from './sessionHeader.js';
import { ISessionContext, SessionContext } from '../../services/sessions/browser/sessionContext.js';
import { autorun, observableValue } from '../../../base/common/observable.js';
import { SessionIsArchivedContext, SessionIsCreatedContext, SessionIsMaximizedContext, SessionIsReadContext, SessionIsStickyContext, SessionSupportsMultipleChatsContext, ChatSessionProviderIdContext, ChatSessionTypeContext, SessionHasChangesContext } from '../../common/contextkeys.js';
import { activeSessionViewBackground, activeSessionViewForeground, inactiveSessionViewBackground, inactiveSessionViewForeground } from '../../common/theme.js';
import { SessionStatus } from '../../services/sessions/common/session.js';
import { localize } from '../../../nls.js';
import { ChatResourceNavigationHistory } from './chatResourceNavigationHistory.js';

/**
 * Options passed to {@link SessionView.openSession}. Extends the chat view
 * options so they can be forwarded to the new-chat views the host creates.
 */
export interface ISessionViewOptions extends IChatViewOptions { }

export interface IChatResourceViewContext {
	readonly title: string;
	readonly agentName?: string;
	readonly status?: string;
}

/**
 * A stable single-slot grid leaf that handles switching between concrete
 * chat views internally. `SessionsPart` delegates `openSession(...)` to
 * this host so it no longer needs to remove/add grid views when the active
 * chat view kind changes.
 *
 * Also hosts the {@link SessionHeader} and {@link ChatCompositeBar} so that they
 * live alongside the chat view they relate to.
 */
export class SessionView extends Disposable implements ISerializableView {

	static readonly TYPE = 'sessions.sessionView';
	private static readonly CENTERED_CONTENT_MAX_WIDTH = 950;
	private static readonly CHAT_NAVIGATION_HEIGHT = 44;
	private static readonly ACTIVE_BACKGROUND = asCssVariable(activeSessionViewBackground);
	private static readonly ACTIVE_FOREGROUND = asCssVariable(activeSessionViewForeground);
	private static readonly INACTIVE_BACKGROUND = asCssVariable(inactiveSessionViewBackground);
	private static readonly INACTIVE_FOREGROUND = asCssVariable(inactiveSessionViewForeground);

	readonly element: HTMLElement = $('.session-view');

	readonly minimumWidth = 200;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 200;
	readonly maximumHeight = Number.POSITIVE_INFINITY;

	private readonly _onDidChange = this._register(new Emitter<IViewSize | undefined>());
	readonly onDidChange: Event<IViewSize | undefined> = this._onDidChange.event;
	private readonly _onDidChangeCanNavigateBack = this._register(new Emitter<boolean>());
	readonly onDidChangeCanNavigateBack: Event<boolean> = this._onDidChangeCanNavigateBack.event;

	private readonly _header: SessionHeader;
	private readonly _compositeBar: ChatCompositeBar;
	private readonly _chatNavigationElement: HTMLElement;
	private readonly _chatBackButton: HTMLButtonElement;
	private readonly _chatNavigationTitle: HTMLElement;
	private readonly _chatNavigationMeta: HTMLElement;
	private readonly _floatingToolbar: SessionViewFloatingToolbar;
	private readonly _centeredContentContainer: HTMLElement;
	private _headerInPanel = false;
	private readonly _contentContainer: HTMLElement;
	private readonly _scopedInstantiationService: IInstantiationService;
	private readonly _backboardAuthEnabledKey: IContextKey<boolean>;
	private readonly _backboardSignedInKey: IContextKey<boolean>;
	private readonly _backboardAlternativeAuthKey: IContextKey<boolean>;
	private _backboardAuthGateOverlay: HTMLElement | undefined;

	private readonly _currentView = this._register(new MutableDisposable<AbstractChatView>());
	private _lastLayout: { readonly width: number; readonly height: number; readonly top: number; readonly left: number } | undefined;

	private _openSessionDisposables = this._register(new DisposableStore());
	private _currentSession: IActiveSession | undefined;
	private _chatResourceOverride: URI | undefined;
	private readonly _chatResourceHistory = new ChatResourceNavigationHistory();
	private readonly _chatResourceContexts = new Map<string, IChatResourceViewContext>();
	private _hasOpenedSession = false;

	private readonly _sessionIsCreatedKey: IContextKey<boolean>;
	private readonly _sessionIsStickyKey: IContextKey<boolean>;
	private readonly _sessionIsMaximizedKey: IContextKey<boolean>;
	private readonly _sessionSupportsMultipleChatsKey: IContextKey<boolean>;
	private readonly _sessionIsReadKey: IContextKey<boolean>;
	private readonly _sessionIsArchivedKey: IContextKey<boolean>;
	private readonly _chatSessionProviderIdKey: IContextKey<string>;
	private readonly _chatSessionTypeKey: IContextKey<string>;
	private readonly _sessionHasChangesKey: IContextKey<boolean>;

	/** Whether this view currently hosts the active session in the grid. */
	private _isActive = true;

	private readonly _sessionObs = observableValue<IActiveSession | undefined>(this, undefined);

	constructor(
		@IChatViewFactory private readonly chatViewFactory: IChatViewFactory,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();

		// Scoped context key service so toolbars hosted within can react to
		// session-specific context keys (e.g. sessionIsCreated, sessionIsSticky).
		const scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		this._sessionIsCreatedKey = SessionIsCreatedContext.bindTo(scopedContextKeyService);
		this._sessionIsStickyKey = SessionIsStickyContext.bindTo(scopedContextKeyService);
		this._sessionIsMaximizedKey = SessionIsMaximizedContext.bindTo(scopedContextKeyService);
		this._sessionSupportsMultipleChatsKey = SessionSupportsMultipleChatsContext.bindTo(scopedContextKeyService);
		this._sessionIsReadKey = SessionIsReadContext.bindTo(scopedContextKeyService);
		this._sessionIsArchivedKey = SessionIsArchivedContext.bindTo(scopedContextKeyService);
		this._chatSessionProviderIdKey = ChatSessionProviderIdContext.bindTo(scopedContextKeyService);
		this._chatSessionTypeKey = ChatSessionTypeContext.bindTo(scopedContextKeyService);
		this._sessionHasChangesKey = SessionHasChangesContext.bindTo(scopedContextKeyService);
		this._backboardAuthEnabledKey = contextKeyService.createKey('backboard.authGateEnabled', contextKeyService.getContextKeyValue<boolean>('backboard.authGateEnabled') === true);
		this._backboardAlternativeAuthKey = BackboardAuthContextKeys.alternativeConfigured.bindTo(contextKeyService);
		this._backboardSignedInKey = contextKeyService.createKey('backboard.signedIn', contextKeyService.getContextKeyValue<boolean>('backboard.signedIn') === true);

		// Scoped service exposing this view's session so toolbars and contributed
		// action view items (e.g. the changes diff stats in the header) can read it.
		this._scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService],
			[ISessionContext, new SessionContext(this._sessionObs)],
		)));


		// Expose the centered-content cap as a CSS variable so styles that need
		// to align with the centered band (e.g. the chat-view progress bar) can
		// reference it without duplicating the constant.
		this.element.style.setProperty('--session-view-centered-content-max-width', `${SessionView.CENTERED_CONTENT_MAX_WIDTH}px`);

		// The header and composite bar (tabs) are hosted in a centered, width-capped
		// container so they align with the centered chat content. The chat content
		// itself lives in a full-width container so its transcript list spans the
		// whole session view and its scrollbar stays pinned to the right edge; the
		// chat rows and input self-center at the same max-width via CSS.
		this._centeredContentContainer = $('.session-view-centered-content');
		this.element.appendChild(this._centeredContentContainer);

		this._header = this._register(this._scopedInstantiationService.createInstance(SessionHeader));
		this._centeredContentContainer.appendChild(this._header.element);

		this._compositeBar = this._register(this._scopedInstantiationService.createInstance(ChatCompositeBar));
		this._centeredContentContainer.appendChild(this._compositeBar.element);

		this._chatNavigationElement = $('.session-view-chat-navigation');
		this._chatNavigationElement.hidden = true;
		this._chatNavigationElement.setAttribute('role', 'navigation');
		this._chatBackButton = $('button.session-view-chat-back') as HTMLButtonElement;
		this._chatBackButton.type = 'button';
		this._chatBackButton.ariaLabel = localize('sessions.backToMainThreadAriaLabel', 'Back to main thread');
		this._chatBackButton.append(
			$('span.codicon.codicon-arrow-left', { 'aria-hidden': 'true' }),
			$('span.session-view-chat-back-label', undefined, localize('sessions.mainThread', 'Main thread')),
		);
		this._chatNavigationTitle = $('.session-view-chat-navigation-title');
		this._chatNavigationMeta = $('.session-view-chat-navigation-meta');
		const identity = $('.session-view-chat-navigation-identity');
		identity.append(this._chatNavigationTitle, this._chatNavigationMeta);
		this._chatNavigationElement.append(
			this._chatBackButton,
			$('span.session-view-chat-navigation-separator', { 'aria-hidden': 'true' }, '/'),
			identity,
		);
		this._centeredContentContainer.appendChild(this._chatNavigationElement);
		this._register(addDisposableListener(this._chatBackButton, EventType.CLICK, () => {
			if (this.navigateToMainThread()) {
				this.focus();
			}
		}));

		this._contentContainer = $('.session-view-content');
		this.element.appendChild(this._contentContainer);

		this._floatingToolbar = this._register(this._scopedInstantiationService.createInstance(SessionViewFloatingToolbar));
		this.element.appendChild(this._floatingToolbar.element);
		this._createBackboardAuthGate();
		this._updateBackboardAuthGate();
		this._refreshBackboardAuthGateFromConfig().catch(error => {
			this.logService.error(`[Backboard] Failed to refresh agents middle panel auth gate: ${error instanceof Error ? error.message : String(error)}`);
		});

		this._applyActiveSessionStyles();

		// Re-layout children when the header or composite bar changes visibility/height
		this._register(this._header.onDidChangeVisibility(() => this._layoutChildren()));
		this._register(this._header.onDidChangeHeight(() => this._layoutChildren()));
		this._register(this._compositeBar.onDidChangeVisibility(() => this._layoutChildren()));
		this._register(this._compositeBar.onDidChangeHeight(() => this._layoutChildren()));
		this._register(contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(backboardAuthGateContextKeys)) {
				this._updateBackboardAuthGate();
			}
		}));
	}

	openSession(session: IActiveSession | undefined, options: ISessionViewOptions): void {
		if (this._hasOpenedSession && this._currentSession === session) {
			return;
		}
		this._hasOpenedSession = true;
		this._currentSession = session;
		this._chatResourceOverride = undefined;
		this._chatResourceHistory.reset();
		this._chatResourceContexts.clear();
		this._updateChatNavigation();
		this._sessionObs.set(session, undefined);
		this._openSessionDisposables.clear();

		this._openSessionDisposables.add(this._handleContextKeys(session));

		// Distinguishes a draft graduating into a real chat (the user sent the
		// first prompt while this autorun was live) from the initial view
		// created when a session is opened, which must not animate.
		let isFirstRun = true;
		this._openSessionDisposables.add(autorun(reader => {
			let desiredKind: ChatViewKind;
			const activeChat = session?.activeChat.read(reader);
			if (activeChat && this._chatResourceOverride && this._chatResourceHistory.root && !isEqual(this._chatResourceHistory.root, activeChat.resource)) {
				// Selecting another top-level chat is an explicit exit from the child
				// transcript. Do not let the remembered override trap the old child in
				// the view after the session's active chat has changed.
				this._chatResourceOverride = undefined;
				this._chatResourceHistory.reset();
				this._chatResourceContexts.clear();
				this._updateChatNavigation();
			}
			if (session === undefined || session.isCreated.read(reader) === false) {
				desiredKind = 'newSession';
			} else if (activeChat?.status.read(reader) === SessionStatus.Untitled) {
				desiredKind = 'newChatInSession';
			} else {
				desiredKind = 'chat';
			}

			let view = this._currentView.value;
			let animateGraduation = false;
			let composerInputRect: DOMRect | undefined;

			if (!view || view.kind !== desiredKind) {
				if (view && !isFirstRun && desiredKind === 'chat') {
					animateGraduation = true;
					composerInputRect = view.element.querySelector('.interactive-input-part')?.getBoundingClientRect();
				}
				view = desiredKind === 'chat'
					? this.chatViewFactory.createChatView(this._scopedInstantiationService)
					: this.chatViewFactory.createNewChatView(desiredKind === 'newChatInSession', options, this._scopedInstantiationService);
				this._contentContainer.replaceChildren(view.element);
				this._currentView.value = view;
				view.setActive(this._isActive);
			}
			isFirstRun = false;

			if (session && activeChat) {
				if (!this._chatResourceOverride || !view.setChatResource(this._chatResourceOverride, session.sessionId)) {
					view.setChat(activeChat, session.sessionId);
				}
			}

			this._header.setSession(session);
			this._compositeBar.setSession(session);
			this._floatingToolbar.setSession(session);
			this._layoutChildren();

			if (animateGraduation) {
				this._animateSessionGraduation(composerInputRect);
			}
		}));
	}

	/** Loads a child chat in this session's existing grid slot. */
	openChatResource(resource: URI, context?: IChatResourceViewContext): boolean {
		const activeChatResource = this._currentSession?.activeChat.get().resource;
		const currentResource = this._chatResourceOverride ?? activeChatResource;
		if (context) {
			this._chatResourceContexts.set(resource.toString(), context);
		}
		const opened = this._currentView.value?.setChatResource(resource, this._currentSession?.sessionId) ?? false;
		if (opened) {
			// Session status changes re-run the host autorun. Remember the child so
			// those refreshes do not immediately replace it with the parent chat.
			this._chatResourceHistory.recordOpen(currentResource, resource);
			this._chatResourceOverride = resource;
			this._updateChatNavigation();
		}
		return opened;
	}

	/** Returns from the displayed subagent chat to the resource that opened it. */
	navigateBack(): boolean {
		const previous = this._chatResourceHistory.previous;
		const view = this._currentView.value;
		const activeChat = this._currentSession?.activeChat.get();
		if (!previous || !view || !activeChat) {
			return false;
		}

		if (isEqual(previous, activeChat.resource)) {
			view.setChat(activeChat, this._currentSession?.sessionId);
			this._chatResourceOverride = undefined;
		} else if (view.setChatResource(previous, this._currentSession?.sessionId)) {
			this._chatResourceOverride = previous;
		} else {
			return false;
		}

		this._chatResourceHistory.commitBack();
		this._updateChatNavigation();
		return true;
	}

	/** Returns directly to the root chat, even from a nested subagent. */
	navigateToMainThread(): boolean {
		const root = this._chatResourceHistory.root;
		const view = this._currentView.value;
		const activeChat = this._currentSession?.activeChat.get();
		if (!root || !view || !activeChat) {
			return false;
		}
		if (isEqual(root, activeChat.resource)) {
			view.setChat(activeChat, this._currentSession?.sessionId);
			this._chatResourceOverride = undefined;
		} else if (view.setChatResource(root, this._currentSession?.sessionId)) {
			this._chatResourceOverride = root;
		} else {
			return false;
		}
		this._chatResourceHistory.reset();
		this._chatResourceContexts.clear();
		this._updateChatNavigation();
		return true;
	}

	get canNavigateBack(): boolean {
		return this._chatResourceHistory.canGoBack;
	}

	private _updateChatNavigation(): void {
		const canNavigateBack = this._chatResourceHistory.canGoBack;
		const didChange = this._chatNavigationElement.hidden === canNavigateBack;
		this._chatNavigationElement.hidden = !canNavigateBack;
		if (canNavigateBack) {
			const context = this._chatResourceOverride ? this._chatResourceContexts.get(this._chatResourceOverride.toString()) : undefined;
			const title = context?.title.trim() || localize('sessions.subagentChat', 'Subagent chat');
			const meta = [context?.agentName?.trim(), context?.status?.trim()].filter((value): value is string => !!value).join(' · ');
			this._chatNavigationTitle.textContent = title;
			this._chatNavigationTitle.title = title;
			this._chatNavigationMeta.textContent = meta || localize('sessions.subagent', 'Subagent');
			this._chatNavigationElement.ariaLabel = localize('sessions.openSubagentContext', 'Main thread, subagent: {0}', title);
		}
		if (didChange) {
			this._onDidChangeCanNavigateBack.fire(canNavigateBack);
		}
		this._layoutChildren();
	}

	/**
	 * Animates the freshly mounted chat view's components into place after a
	 * new-session composer graduates into a real chat (the user sent the first
	 * prompt): the input glides from where the composer sat down to its docked
	 * position, the transcript fades in drifting up into the vacated space,
	 * and the header/tabs slide in from the top edge. Runs after layout so all
	 * measurements are against final positions; animations end at the elements'
	 * natural styles, so an interrupted or skipped run leaves no residue.
	 *
	 * @param composerInputRect The outgoing composer input's rect, measured
	 * before the view swap; when missing, the input glide is skipped and only
	 * the fades run.
	 */
	private _animateSessionGraduation(composerInputRect: DOMRect | undefined): void {
		if (this.accessibilityService.isMotionReduced()) {
			return;
		}
		const view = this._currentView.value;
		if (!view) {
			return;
		}

		const easing = 'cubic-bezier(0.2, 0, 0, 1)';

		// The input is the one component both views share: glide it from the
		// composer's centered position to its docked spot. Centers are aligned
		// rather than top edges because the two inputs differ in height, and
		// center-to-center reads as one element moving instead of snapping.
		const inputPart = view.element.querySelector<HTMLElement>('.interactive-input-part');
		if (inputPart && composerInputRect && composerInputRect.height > 0) {
			const inputRect = inputPart.getBoundingClientRect();
			const deltaX = (composerInputRect.left + composerInputRect.width / 2) - (inputRect.left + inputRect.width / 2);
			const deltaY = (composerInputRect.top + composerInputRect.height / 2) - (inputRect.top + inputRect.height / 2);
			if (inputRect.height > 0 && (Math.abs(deltaX) >= 1 || Math.abs(deltaY) >= 1)) {
				inputPart.animate([
					{ transform: `translate(${deltaX}px, ${deltaY}px)` },
					{ transform: 'none' },
				], { duration: 420, easing });
			}
		}

		// The transcript (leading with the just-sent prompt) settles upward
		// into the space the composer vacated, opposite to the input's
		// downward glide, so the two read as the view opening apart.
		view.element.querySelector<HTMLElement>('.interactive-list')?.animate([
			{ opacity: 0, transform: 'translateY(24px)' },
			{ opacity: 1, transform: 'none' },
		], { duration: 420, easing });

		// The header and tabs were hidden while the composer was up; slide
		// them in from the top edge once the input is already on its way.
		this._centeredContentContainer.animate([
			{ opacity: 0, transform: 'translateY(-10px)' },
			{ opacity: 1, transform: 'none' },
		], { duration: 320, delay: 100, easing, fill: 'backwards' });
	}

	private _handleContextKeys(session: IActiveSession | undefined): IDisposable {
		if (!session) {
			this._sessionIsCreatedKey.set(false);
			this._sessionIsStickyKey.set(false);
			this._sessionSupportsMultipleChatsKey.set(false);
			this._sessionIsReadKey.set(true);
			this._sessionIsArchivedKey.set(false);
			this._chatSessionProviderIdKey.set('');
			this._chatSessionTypeKey.set('');
			this._sessionHasChangesKey.set(false);
			return Disposable.None;
		}

		const disposables = new DisposableStore();
		disposables.add(autorun(reader => {
			this._sessionIsCreatedKey.set(session.isCreated.read(reader));
		}));

		disposables.add(autorun(reader => {
			this._sessionIsStickyKey.set(session.sticky.read(reader));
		}));

		disposables.add(autorun(reader => {
			this._sessionIsReadKey.set(session.isRead.read(reader));
		}));

		disposables.add(autorun(reader => {
			this._sessionIsArchivedKey.set(session.isArchived.read(reader));
		}));

		// Drives the visibility of the diff-stats menu item contributed by the
		// changes view into the session header meta row.
		disposables.add(autorun(reader => {
			const changes = session.changes.read(reader);
			let insertions = 0;
			let deletions = 0;
			for (const change of changes) {
				insertions += change.insertions;
				deletions += change.deletions;
			}
			this._sessionHasChangesKey.set(insertions > 0 || deletions > 0);
		}));

		this._sessionSupportsMultipleChatsKey.set(session.capabilities.supportsMultipleChats);
		this._chatSessionProviderIdKey.set(session.providerId);
		this._chatSessionTypeKey.set(session.sessionType);

		return disposables;
	}

	layout(width: number, height: number, top: number, left: number): void {
		size(this.element, width, height);
		this._lastLayout = { width, height, top, left };
		this._layoutChildren();
	}

	private _layoutChildren(): void {
		if (!this._lastLayout) {
			return;
		}
		const { width, height, top, left } = this._lastLayout;

		// Apply the centered band's width first so the header and tabs wrap to
		// their final layout before we measure their combined height. Measuring
		// before the width is applied could read a stale (pre-cap) height and
		// cause a transient overlap until a later layout pass corrects it.
		const centeredWidth = Math.min(width, SessionView.CENTERED_CONTENT_MAX_WIDTH);
		this._centeredContentContainer.style.width = `${centeredWidth}px`;

		// When the header is relocated into the window header row it no longer
		// occupies the centered band, so the transcript reclaims that height.
		const headerHeight = (this._header.visible && !this._headerInPanel) ? this._header.height : 0;
		const tabsHeight = this._compositeBar.visible ? this._compositeBar.height : 0;
		const chatNavigationHeight = this._chatResourceHistory.canGoBack ? SessionView.CHAT_NAVIGATION_HEIGHT : 0;
		const barHeight = headerHeight + tabsHeight + chatNavigationHeight;

		// Cap the band's height to the header + tabs (it is horizontally centered
		// via CSS `margin: 0 auto`) so the full-width chat content sits below it.
		size(this._centeredContentContainer, centeredWidth, barHeight);

		// Lay out the chat content at full width so its scrollbar reaches the
		// right edge; the chat rows and input center themselves via CSS.
		this._currentView.value?.layout(width, height - barHeight, top + barHeight, left);
	}

	/**
	 * Relocates this view's session header (title/workspace) and action toolbar
	 * into the shared window header row (panel header slots) so they sit inline
	 * with the mode dropdown and scale with the session region as panels open and
	 * close. The elements keep their per-view scoped instantiation (and context
	 * keys); only their DOM parent changes. Idempotent.
	 */
	mountHeaderIntoPanel(titleSlot: HTMLElement, toolbarSlot: HTMLElement): void {
		if (this._header.element.parentElement !== titleSlot) {
			titleSlot.appendChild(this._header.element);
		}
		if (this._floatingToolbar.element.parentElement !== toolbarSlot) {
			toolbarSlot.appendChild(this._floatingToolbar.element);
		}
		if (!this._headerInPanel) {
			this._headerInPanel = true;
			this._layoutChildren();
		}
	}

	/**
	 * Returns the header and toolbar to their in-view positions (used when this
	 * view is not the one that owns the shared header slots, e.g. a multi-session
	 * grid). Idempotent.
	 */
	restoreHeaderToView(): void {
		if (this._header.element.parentElement !== this._centeredContentContainer) {
			this._centeredContentContainer.insertBefore(this._header.element, this._compositeBar.element);
		}
		if (this._floatingToolbar.element.parentElement !== this.element) {
			this.element.appendChild(this._floatingToolbar.element);
		}
		if (this._headerInPanel) {
			this._headerInPanel = false;
			this._layoutChildren();
		}
	}

	toJSON(): object {
		return { type: SessionView.TYPE };
	}

	focus(): void {
		this._currentView.value?.focus();
	}

	startTitleEditing(): void {
		this._header.startTitleEditing();
	}

	selectWorkspace(folderUri: URI, providerId?: string): void {
		this._currentView.value?.selectWorkspace(folderUri, providerId);
	}

	prefillInput(text: string): void {
		this._currentView.value?.prefillInput(text);
	}

	sendQuery(text: string): void {
		this._currentView.value?.sendQuery(text);
	}

	/**
	 * Attaches the given resources as context to the hosted chat view's input.
	 */
	attach(uris: URI[]): void {
		this._currentView.value?.attach(uris);
	}

	/**
	 * Updates the view's maximized context key so toolbars hosted within can react.
	 * Called by the owning {@link SessionsPart} when the grid's maximized view changes.
	 */
	setMaximized(maximized: boolean): void {
		this._sessionIsMaximizedKey.set(maximized);
	}

	/**
	 * Updates whether this view currently hosts the active session in the grid.
	 * Forwarded to the inner chat view so it can adjust its visual styling
	 * (e.g. dim the list background for inactive sessions).
	 */
	setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		this._applyActiveSessionStyles();
		this._currentView.value?.setActive(active);
	}

	private _applyActiveSessionStyles(): void {
		const background = this._isActive ? SessionView.ACTIVE_BACKGROUND : SessionView.INACTIVE_BACKGROUND;
		const foreground = this._isActive ? SessionView.ACTIVE_FOREGROUND : SessionView.INACTIVE_FOREGROUND;
		this.element.style.setProperty('--session-view-background', background);
		this.element.style.setProperty('--session-view-foreground', foreground);
		this.element.style.setProperty('--part-background', background);
		this.element.style.setProperty('--part-foreground', foreground);
	}

	private _isBackboardAuthRequired(): boolean {
		return this._backboardAuthEnabledKey.get() === true && this._backboardSignedInKey.get() !== true && this._backboardAlternativeAuthKey.get() !== true;
	}

	private _createBackboardAuthGate(): void {
		if (this._backboardAuthGateOverlay) {
			return;
		}

		const overlay = $('.backboard-auth-gate-overlay.backboard-auth-gate-session-view');
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-label', localize('backboard.auth.sessionView.aria', "Connect Your AI"));

		const card = $('.backboard-auth-gate-card');
		overlay.appendChild(card);

		const logo = $('span.backboard-auth-gate-logo.codicon.codicon-backboard-logo');
		logo.setAttribute('aria-hidden', 'true');
		card.appendChild(logo);

		const title = $('h3.backboard-auth-gate-title');
		title.textContent = localize('backboard.auth.sessionView.title', "Connect Your AI");
		card.appendChild(title);

		const description = $('p.backboard-auth-gate-description');
		description.textContent = localize('backboard.auth.sessionView.description', "Use Backboard, an API key, or a subscription.");
		card.appendChild(description);

		this._register(renderBackboardAuthSetup(card, this.commandService, () => this._refreshBackboardAuthGateFromConfig()));

		this.element.appendChild(overlay);
		this._backboardAuthGateOverlay = overlay;
	}

	private _updateBackboardAuthGate(): void {
		const gated = this._isBackboardAuthRequired();
		this.element.classList.toggle('backboard-auth-gate-active', gated);
		if (this._backboardAuthGateOverlay) {
			this._backboardAuthGateOverlay.style.display = gated ? '' : 'none';
		}
	}

	private async _refreshBackboardAuthGateFromConfig(): Promise<void> {
		if (!isBackboardProduct()) {
			this._backboardAuthEnabledKey.set(false);
			this._backboardSignedInKey.set(true);
			this._updateBackboardAuthGate();
			return;
		}

		this._backboardAuthEnabledKey.set(true);
		this._backboardSignedInKey.set(await hasBackboardCredentials(this.fileService, await backboardConfigResource(this.pathService)));
		this._backboardAlternativeAuthKey.set(await hasAlternativeBackboardCredentials(this.commandService));
		this._updateBackboardAuthGate();
	}
	}

const backboardAuthGateContextKeys = new Set(['backboard.authGateEnabled', 'backboard.signedIn', 'backboard.alternativeConfigured']);

interface BackboardConfigJson {
	readonly [key: string]: unknown;
	readonly env?: string;
	readonly api_key?: string;
	readonly env_keys?: Record<string, string>;
}

function isBackboardProduct(): boolean {
	return product.defaultChatAgent?.provider?.default?.id === 'backboard';
}

async function backboardConfigResource(pathService: IPathService): Promise<URI> {
	return URI.joinPath(await pathService.userHome({ preferLocal: true }), '.backboard_ide', 'config.json');
}

async function hasBackboardCredentials(fileService: IFileService, configResource: URI): Promise<boolean> {
	const config = await readBackboardConfigJson(fileService, configResource);
	return Boolean(backboardConfigApiKey(config) || backboardConfigAccessToken(config));
}

async function readBackboardConfigJson(fileService: IFileService, configResource: URI): Promise<BackboardConfigJson> {
	try {
		const parsed: unknown = JSON.parse((await fileService.readFile(configResource)).value.toString());
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

function backboardConfigApiKey(config: BackboardConfigJson): string | undefined {
	const apiKey = stringValueFromRecord(config.api_key);
	if (apiKey) {
		return apiKey;
	}
	const env = normalizeBackboardEnv(config.env);
	return stringValueFromRecord(backboardConfigEnvKeys(config)[env]);
}

function backboardConfigAccessToken(config: BackboardConfigJson): string | undefined {
	const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
	return stringValueFromRecord(oauth?.access_token);
}

function backboardConfigEnvKeys(config: BackboardConfigJson): Record<string, string> {
	const envKeys = config.env_keys;
	if (!isObjectRecord(envKeys)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [env, apiKey] of Object.entries(envKeys)) {
		if (typeof apiKey === 'string') {
			result[normalizeBackboardEnv(env)] = apiKey;
		}
	}
	return result;
}

function normalizeBackboardEnv(env: string | undefined): string {
	switch ((env || 'prod').trim().toLowerCase()) {
		case '':
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (env || 'prod').trim().toLowerCase();
	}
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
