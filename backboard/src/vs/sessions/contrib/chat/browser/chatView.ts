/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWidget.css';
import { $, append } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { IAgentCliSetupService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentCliSetup.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { createBackboardSessionTypePickerDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/backboardSessionTypePickerDelegate.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { getChatSessionType } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { IChatSessionsService, localChatSessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { AbstractChatView, ChatViewKind, IChatViewOptions } from '../../../browser/parts/chatView.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { NewChatWidget } from './newChatWidget.js';
import { NewChatInSessionWidget } from './newChatInSessionWidget.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground, inactiveSessionViewBackground, inactiveSessionViewForeground } from '../../../common/theme.js';
import { isEqual } from '../../../../base/common/resources.js';
import { RightWorkbenchCommandId } from '../../rightWorkbench/browser/rightWorkbench.js';

/**
 * A session view that hosts a {@link NewChatWidget} — the "new session" UI
 * shown before a session has been created. This is the default view that
 * the `SessionsPart` grid is seeded with.
 */
export class NewChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.newSession';

	override readonly kind: ChatViewKind;

	private readonly _widget: NewChatWidget | NewChatInSessionWidget;

	constructor(
		isNewChatInSession: boolean,
		options: IChatViewOptions,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.element.classList.add('chat-view-new');
		this.kind = isNewChatInSession ? 'newChatInSession' : 'newSession';
		this._widget = this._register(isNewChatInSession
			? instantiationService.createInstance(NewChatInSessionWidget, options)
			: instantiationService.createInstance(NewChatWidget, options));
		this._widget.render(this.element);
	}

	override toJSON(): object {
		return { type: NewChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(height, width);
	}

	override focus(): void {
		this._widget.focusInput();
	}

	override selectWorkspace(folderUri: URI, providerId?: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.selectWorkspace(folderUri, providerId);
		}
	}

	override prefillInput(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.prefillInput(text);
		}
	}

	override sendQuery(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.sendQuery(text);
		}
	}

	override attach(uris: URI[]): void {
		this._widget.attach(uris);
	}

	override setChat(chat: IChat, _historyKey?: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.setChat(chat);
		} else if (this._widget instanceof NewChatInSessionWidget) {
			this._widget.setChat(chat);
		}
	}
}

/**
 * A session view that hosts the standard chat {@link ChatWidget} — used to
 * render an active chat session inside the `SessionsPart` grid.
 */
export class ChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.session';

	/** How many recently shown chats stay loaded for instant switching. */
	private static readonly RECENT_MODEL_LIMIT = 4;

	override readonly kind: ChatViewKind = 'chat';

	private readonly _widget: ChatWidget;

	/** Reference to the loaded chat model; disposing releases the model. */
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());

	/** Cancels any in-flight model load when a new session is set or the view disposes. */
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());

	/** Tracks the currently loaded chat resource to avoid redundant reloads. */
	private _currentChatResource: URI | undefined;
	private _historyKey: string | undefined;

	/** Whether this view currently represents the active session. */
	private _isActive = true;

	/**
	 * Models of the chats this view showed most recently, newest last. Holding
	 * the reference keeps the model alive, so switching back to one of them
	 * renders at once instead of restoring it from the agent host again.
	 */
	private readonly _recentModels = new Map<string, IChatModelReference>();

	/** The skeleton transcript shown while a chat loads, and its show/hide timers. */
	private readonly _loadingSkeleton = this._register(new MutableDisposable());

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@ICommandService commandService: ICommandService,
		@IAgentCliSetupService agentCliSetupService: IAgentCliSetupService,
	) {
		super();

		this.element.classList.add('chat-view-chat', 'backboard-clean-chat', 'backboard-composer');

		const scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		const scopedInstantiationService = this._register(instantiationService.createChild(
			new ServiceCollection([IContextKeyService, scopedContextKeyService])
		));

		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			undefined,
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				rendererOptions: {
					renderTextEditsAsSummary: () => true,
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				// Keep the live/sent Simple composer on the exact same contract as
				// the code editor's sent-chat composer: one combined provider/model
				// picker, no duplicate mode/folder controls, and the same two-line
				// resting editor height.
				isSessionsWindow: true,
				// Show a changed file's diff in the right panel's Review when it is one
				// of the chat's changes; the strip falls back to a modal diff otherwise.
				openChangedFile: async resource => !!await commandService.executeCommand<boolean>(RightWorkbenchCommandId.OpenReview, { resource }),
				sessionTypePickerDelegate: createBackboardSessionTypePickerDelegate(
					() => this._widget?.viewModel?.model.sessionResource,
					commandService,
					this.chatSessionsService,
					agentCliSetupService,
					() => (this._widget?.viewModel?.model.getRequests().length ?? 0) === 0,
				),
				supportsChangingModes: false,
				inputEditorMinLines: 2,
				dndContainer: this.element,
			},
			this._buildStyles(this._isActive)
		));
		this._widget.render(this.element);
		this._widget.setVisible(true);

		// Session grids can retain several chat leaves while only one or two are
		// actually inside the horizontally clipped viewport. A visible ChatWidget
		// subscribes to every streaming/model change and keeps rendering even when
		// its leaf cannot be seen. Suspend those widgets at the leaf boundary; when
		// they re-enter, ChatWidget performs one current-state refresh instead of
		// replaying all of the off-screen updates.
		const targetWindow = this.element.ownerDocument.defaultView;
		if (targetWindow && typeof targetWindow.IntersectionObserver === 'function') {
			const visibilityObserver = new targetWindow.IntersectionObserver(entries => {
				// A batch can hold several entries for the element (a restore reports
				// the transient zero-width frame, then the final one); only the latest
				// reflects where the element is now.
				const entry = entries.findLast(candidate => candidate.target === this.element);
				if (entry) {
					this._widget.setVisible(entry.isIntersecting && entry.intersectionRatio > 0);
				}
			}, {
				// A leaf laid out at zero width (e.g. while the right panel restores
				// from maximized) is "intersecting" at ratio 0. With only the default
				// 0 threshold, growing back to full size crosses nothing, so the widget
				// would stay hidden and show an empty chat. The second threshold makes
				// the ratio leaving 0 fire.
				threshold: [0, 0.0001],
			});
			visibilityObserver.observe(this.element);
			this._register({ dispose: () => visibilityObserver.disconnect() });
		}

		this._register(toDisposable(() => {
			for (const ref of this._recentModels.values()) {
				ref.dispose();
			}
			this._recentModels.clear();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING)) {
				this._applyHistoryKey();
			}
		}));
	}

	private _buildStyles(active: boolean) {
		return {
			listForeground: active ? activeSessionViewForeground : inactiveSessionViewForeground,
			listBackground: active ? activeSessionViewBackground : inactiveSessionViewBackground,
			overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
			inputEditorBackground: inactiveSessionViewBackground,
			resultEditorBackground: agentsPanelBackground,
		};
	}

	/** The underlying chat widget. */
	get widget(): ChatWidget {
		return this._widget;
	}

	override setChat(chat: IChat, historyKey?: string): void {
		this.setChatResource(chat.resource, historyKey);
	}

	override setChatResource(resource: URI, historyKey?: string): boolean {
		this._historyKey = historyKey;
		this._applyHistoryKey();

		// Skip loading if we're already showing this chat
		if (isEqual(this._currentChatResource, resource)) {
			return true;
		}

		this._currentChatResource = resource;
		this._keepRecentModel(this._modelRef.clearAndLeak());

		// A chat shown recently is still loaded: show it without a round trip.
		const recent = this._takeRecentModel(resource);
		this._loadCts.value?.cancel();
		if (recent) {
			this._loadCts.clear();
			this._loadingSkeleton.clear();
			this._modelRef.value = recent;
			this._updateWidgetLockState(getChatSessionType(recent.object.sessionResource));
			this._widget.setModel(recent.object);
			this.element.setAttribute('aria-busy', 'false');
			return true;
		}

		this._widget.setModel(undefined);
		this.element.setAttribute('aria-busy', 'true');

		// Cancel any in-flight load for the previous chat and start a fresh one.
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const token = cts.token;

		this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'ChatView').then(ref => {
			if (token.isCancellationRequested || !ref) {
				ref?.dispose();
				if (!token.isCancellationRequested && isEqual(resource, this._currentChatResource)) {
					this._currentChatResource = undefined;
					this.element.setAttribute('aria-busy', 'false');
					this._hideLoadingSkeleton(false);
				}
				return;
			}
			this._modelRef.value = ref;
			this._updateWidgetLockState(getChatSessionType(ref.object.sessionResource));
			this._widget.setModel(ref.object);
			this.element.setAttribute('aria-busy', 'false');
			this._hideLoadingSkeleton(true);
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[ChatView] Failed to load chat model for chat', err);
			}
			if (this._currentChatResource && isEqual(resource, this._currentChatResource)) { // might have changed while we were waiting, only reset if it is still the same
				this._currentChatResource = undefined;
				this.element.setAttribute('aria-busy', 'false');
				this._hideLoadingSkeleton(false);
			}
		});
		this._showLoadingSkeleton();
		return true;
	}

	/**
	 * Shows a placeholder transcript (a sent message and an answer, shimmering)
	 * in place of the empty chat while its model loads. It appears after a
	 * short delay so cached loads never flash it.
	 */
	private _showLoadingSkeleton(): void {
		const skeleton = $('.chat-view-loading-skeleton', { 'aria-hidden': 'true' });
		const column = append(skeleton, $('.chat-view-loading-column'));
		const request = append(column, $('.chat-view-loading-request'));
		append(request, $('.chat-view-loading-line.width-full'));
		append(request, $('.chat-view-loading-line.width-short'));
		const response = append(column, $('.chat-view-loading-response'));
		const status = append(response, $('.chat-view-loading-status'));
		append(status, $('.chat-view-loading-dot'));
		append(status, $('.chat-view-loading-line.width-label'));
		for (const width of ['width-full', 'width-long', 'width-full', 'width-mid']) {
			append(response, $(`.chat-view-loading-line.${width}`));
		}
		append(response, $('.chat-view-loading-media'));

		const showTimer = disposableTimeout(() => {
			// Keep the skeleton above the composer so it never covers it or spills
			// into the next grid cell.
			const input = this.element.querySelector<HTMLElement>('.interactive-input-part');
			skeleton.style.bottom = `${input?.offsetHeight ?? 0}px`;
			this.element.appendChild(skeleton);
			// Next frame so the entrance transition runs.
			skeleton.ownerDocument.defaultView?.requestAnimationFrame(() => skeleton.classList.add('visible'));
		}, 90);
		this._loadingSkeleton.value = toDisposable(() => {
			showTimer.dispose();
			skeleton.remove();
		});
	}

	/** Fades the skeleton out and, after a load, fades the transcript in. */
	private _hideLoadingSkeleton(loaded: boolean): void {
		const skeleton = this.element.querySelector<HTMLElement>(':scope > .chat-view-loading-skeleton:not(.leaving)');
		if (!skeleton) {
			this._loadingSkeleton.clear();
			return;
		}
		// The skeleton is on screen, so its show timer is spent; remove it below
		// once the fade-out finishes.
		this._loadingSkeleton.clearAndLeak();
		skeleton.classList.remove('visible');
		skeleton.classList.add('leaving');
		if (loaded) {
			this.element.classList.add('chat-view-revealing');
		}
		const targetWindow = this.element.ownerDocument.defaultView;
		targetWindow?.setTimeout(() => {
			skeleton.remove();
			this.element.classList.remove('chat-view-revealing');
		}, 320);
	}

	private _keepRecentModel(ref: IChatModelReference | undefined): void {
		if (!ref) {
			return;
		}
		const key = ref.object.sessionResource.toString();
		this._recentModels.get(key)?.dispose();
		this._recentModels.delete(key);
		this._recentModels.set(key, ref);
		while (this._recentModels.size > ChatView.RECENT_MODEL_LIMIT) {
			const [oldestKey, oldest] = this._recentModels.entries().next().value!;
			this._recentModels.delete(oldestKey);
			oldest.dispose();
		}
	}

	private _takeRecentModel(resource: URI): IChatModelReference | undefined {
		for (const [key, ref] of this._recentModels) {
			if (isEqual(ref.object.sessionResource, resource)) {
				this._recentModels.delete(key);
				return ref;
			}
		}
		return undefined;
	}

	private _applyHistoryKey(): void {
		const scopedHistory = this.configurationService.getValue<boolean>(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING) !== false;
		this._widget.inputPart.setHistoryKey(scopedHistory ? this._historyKey : undefined);
	}

	private _updateWidgetLockState(sessionType: string): void {
		if (sessionType === localChatSessionType) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this._widget.lockToCodingAgent(contribution.name, contribution.displayName, sessionType, contribution.agentHostProviderId);
		} else {
			this._widget.unlockFromCodingAgent();
		}
	}

	override toJSON(): object {
		return { type: ChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(height, width);
	}

	override focus(): void {
		this._widget.focusInput();
	}

	override attach(uris: URI[]): void {
		for (const uri of uris) {
			this._widget.attachmentModel.addFile(uri).catch(err => this.logService.error('[ChatView] Failed to attach file as context', err));
		}
	}

	override setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		this._widget.setStyles(this._buildStyles(active));
	}
}

/**
 * Default {@link IChatViewFactory} implementation. Lives in the contrib
 * layer where the concrete views are defined and is registered as an eager
 * singleton via the entry point.
 */
export class ChatViewFactory implements IChatViewFactory {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	createNewChatView(isNewChatInSession: boolean, options: IChatViewOptions, instantiationService?: IInstantiationService): AbstractChatView {
		return (instantiationService ?? this.instantiationService).createInstance(NewChatView, isNewChatInSession, options);
	}

	createChatView(instantiationService?: IInstantiationService): AbstractChatView {
		return (instantiationService ?? this.instantiationService).createInstance(ChatView);
	}
}
