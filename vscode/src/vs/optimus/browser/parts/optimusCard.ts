/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, EventHelper, EventType, addDisposableListener, getWindow, scheduleAtNextAnimationFrame } from '../../../base/browser/dom.js';
import { disposableTimeout } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { ChatListWidget } from '../../../workbench/contrib/chat/browser/widget/chatListWidget.js';
import { ChatViewModel } from '../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ChatAgentLocation } from '../../../workbench/contrib/chat/common/constants.js';
import { IChatModelReference, IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../../sessions/services/sessions/common/session.js';

export interface IOptimusCardSessionModel {
	readonly session: ISession;
	readonly chatResource: URI;
	readonly isVisible: boolean;
	readonly activeSession?: IActiveSession;
}

export type OptimusCardAction =
	| { readonly kind: 'focus-session'; readonly card: IOptimusCardSessionModel }
	| { readonly kind: 'create-session' }
	| { readonly kind: 'close-session'; readonly card: IOptimusCardSessionModel };

function statusLabel(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.InProgress: return localize('optimus.card.running', "Running");
		case SessionStatus.NeedsInput: return localize('optimus.card.needsInput', "Needs Input");
		case SessionStatus.Completed: return localize('optimus.card.done', "Done");
		case SessionStatus.Error: return localize('optimus.card.error', "Error");
		default: return localize('optimus.card.new', "New");
	}
}

function statusClass(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.InProgress: return 'running';
		case SessionStatus.NeedsInput: return 'needs-input';
		case SessionStatus.Completed: return 'done';
		case SessionStatus.Error: return 'error';
		default: return 'idle';
	}
}

/**
 * One compact task-slot card in the Optimus grid. Renders the bound session's
 * status, title, a read-only embedded chat transcript (the same ChatWidget
 * rendering the Simple window uses), changed-file stats and last-activity
 * timestamp. An unbound card renders a "start a task" placeholder.
 */
export class OptimusCard extends Disposable {

	readonly element: HTMLElement;

	private readonly statusDot: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly feedEl: HTMLElement;
	private readonly chatEl: HTMLElement;
	private readonly changesEl: HTMLElement;
	private readonly timeEl: HTMLElement;
	private readonly placeholderEl: HTMLElement;
	private readonly contentEl: HTMLElement;
	private readonly deleteButton: HTMLButtonElement;

	/** Lazily created read-only transcript list, reused across rebinds. */
	private chatList: ChatListWidget | undefined;

	/** Disposables tied to the currently bound session; cleared on rebind. */
	private readonly bindStore = this._register(new DisposableStore());
	/** Disposables tied to the currently attached chat view model. */
	private readonly viewModelStore = this._register(new DisposableStore());
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());

	private _session: IOptimusCardSessionModel | undefined;
	get session(): IOptimusCardSessionModel | undefined { return this._session; }

	private readonly _onDidAction = this._register(new Emitter<OptimusCardAction>());
	readonly onDidAction: Event<OptimusCardAction> = this._onDidAction.event;

	constructor(
		container: HTMLElement,
		@IChatService private readonly chatService: IChatService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.element = append(container, $('.optimus-card'));
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'button');

		this.contentEl = append(this.element, $('.optimus-card-content'));

		const header = append(this.contentEl, $('.optimus-card-header'));
		this.statusDot = append(header, $('.optimus-card-status-dot'));
		this.titleEl = append(header, $('.optimus-card-title'));
		this.statusText = append(header, $('.optimus-card-status-label'));
		this.deleteButton = append(header, $('button.optimus-card-delete'));
		this.deleteButton.type = 'button';
		this.deleteButton.title = localize('optimus.card.close', "Close chat");
		this.deleteButton.setAttribute('aria-label', this.deleteButton.title);
		this.deleteButton.textContent = '×';

		this.feedEl = append(this.contentEl, $('.optimus-card-feed'));
		this.chatEl = append(this.contentEl, $('.optimus-card-chat'));
		this.chatEl.style.display = 'none';

		const footer = append(this.contentEl, $('.optimus-card-footer'));
		this.changesEl = append(footer, $('.optimus-card-changes'));
		this.timeEl = append(footer, $('.optimus-card-time'));

		this.placeholderEl = append(this.element, $('.optimus-card-placeholder'));
		const placeholderIcon = append(this.placeholderEl, $('.optimus-card-placeholder-icon'));
		placeholderIcon.textContent = '+';
		const placeholderLabel = append(this.placeholderEl, $('.optimus-card-placeholder-label'));
		placeholderLabel.textContent = localize('optimus.card.placeholder', "Start a task");

		const firePrimaryAction = (): void => {
			if (this._session) {
				this._onDidAction.fire({ kind: 'focus-session', card: this._session });
			} else {
				this._onDidAction.fire({ kind: 'create-session' });
			}
		};

		// The embedded transcript is read-only: any click on the card opens
		// its chat in the right panel. Listen in the capture phase so the
		// widget's own interactive elements cannot swallow the click, but let
		// drags through (scrollbar handling) and keep the delete button live.
		let mouseDownPosition: { x: number; y: number } | undefined;
		this._register(addDisposableListener(this.element, EventType.MOUSE_DOWN, event => {
			mouseDownPosition = { x: event.clientX, y: event.clientY };
		}, true));
		this._register(addDisposableListener(this.element, EventType.CLICK, event => {
			if ((event.target as HTMLElement).closest('.optimus-card-delete')) {
				return;
			}
			if (mouseDownPosition && (Math.abs(event.clientX - mouseDownPosition.x) > 4 || Math.abs(event.clientY - mouseDownPosition.y) > 4)) {
				return;
			}
			EventHelper.stop(event, true);
			firePrimaryAction();
		}, true));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				EventHelper.stop(event, true);
				firePrimaryAction();
			}
		}));
		this._register(addDisposableListener(this.deleteButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			if (this._session) {
				this._onDidAction.fire({ kind: 'close-session', card: this._session });
			}
		}));

		// Grid tracks resize as cards come and go and the transcript often
		// attaches before the part's first layout pass, so keep the embedded
		// list sized from the card's actual dimensions.
		const ResizeObserverCtor = getWindow(this.element).ResizeObserver;
		if (ResizeObserverCtor) {
			const resizeObserver = new ResizeObserverCtor(() => this.layout());
			resizeObserver.observe(this.element);
			this._register(toDisposable(() => resizeObserver.disconnect()));
		}

		this.bind(undefined, false);
	}

	/**
	 * Bind this card to a session (or to the placeholder when `undefined`)
	 * and update the active highlight.
	 */
	bind(session: IOptimusCardSessionModel | undefined, isActive: boolean): void {
		// Rebinding to the same session (the sessions service refreshes its
		// list frequently, and visible-session wrappers are recreated per
		// emit) must not tear down the attached transcript or cancel an
		// in-flight chat load. Compare by stable keys — object identity is
		// NOT stable across refreshes — and only update the model reference
		// and highlight.
		if (session && this._session
			&& this._session.session.sessionId === session.session.sessionId
			&& isEqual(this._session.chatResource, session.chatResource)) {
			this._session = session;
			this.element.classList.toggle('active', isActive);
			return;
		}

		this._session = session;
		this.bindStore.clear();
		this.viewModelStore.clear();
		this.modelRef.clear();
		this.chatList?.refresh();
		this.chatEl.style.display = 'none';
		this.feedEl.style.display = '';

		this.element.classList.toggle('active', isActive && !!session);
		this.element.classList.toggle('empty', !session);
		this.contentEl.style.display = session ? '' : 'none';
		this.placeholderEl.style.display = session ? 'none' : '';
		this.deleteButton.style.display = session ? '' : 'none';

		if (!session) {
			return;
		}

		const sessionModel = session.session;

		// Static + reactive card chrome from the session's observables.
		this.bindStore.add(autorun(reader => {
			const title = sessionModel.title.read(reader);
			const status = sessionModel.status.read(reader);
			const updatedAt = sessionModel.updatedAt.read(reader);

			this.titleEl.textContent = title || localize('optimus.card.untitled', "Untitled");
			this.titleEl.title = this.titleEl.textContent;
			this.statusText.textContent = statusLabel(status);
			this.statusDot.className = `optimus-card-status-dot ${statusClass(status)}`;

			// Diff stats sourced the same way as the Simple window's sessions
			// list: prefer the provider's changes summary, fall back to summing
			// the per-file changes of the live changeset.
			const changesSummary = sessionModel.changesSummary?.read(reader);
			const changes = sessionModel.changes.read(reader);
			let additions = 0, deletions = 0;
			if (changesSummary) {
				additions = changesSummary.additions;
				deletions = changesSummary.deletions;
			} else {
				for (const change of changes) {
					additions += change.insertions;
					deletions += change.deletions;
				}
			}
			const files = changesSummary?.files || changes.length;
			if (additions > 0 || deletions > 0 || files > 0) {
				this.changesEl.textContent = files > 0
					? localize('optimus.card.changes', "{0} files +{1} −{2}", files, additions, deletions)
					: localize('optimus.card.changesNoFiles', "+{0} −{1}", additions, deletions);
			} else {
				this.changesEl.textContent = localize('optimus.card.noChanges', "No changed files");
			}

			this.timeEl.textContent = updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		}));

		// Read-only transcript: every card in the grid is an OPEN chat, so it
		// loads its transcript eagerly (same path as the right panel) and
		// mirrors it live. Closed chats never reach the grid — the grid part
		// filters them out via its persisted closed set.
		if (this.tryAttachChat(session.chatResource)) {
			this.logService.info(`[OptimusDiag] card attached existing model for ${session.chatResource.toString()}`);
		} else {
			this.logService.info(`[OptimusDiag] card loading ${session.chatResource.toString()} (status=${sessionModel.status.get()})`);

			// Status-description fallback, shown only until a model attaches.
			this.bindStore.add(autorun(reader => {
				const description = sessionModel.description.read(reader);
				if (!this.modelRef.value) {
					this.feedEl.textContent = description?.value ?? '';
				}
			}));

			const cts = new CancellationTokenSource();
			this.bindStore.add(toDisposable(() => cts.dispose(true)));
			this.chatService.acquireOrLoadSession(session.chatResource, ChatAgentLocation.Chat, cts.token, 'OptimusCard').then(ref => {
				if (!ref) {
					this.logService.info(`[OptimusDiag] card load returned NO MODEL for ${session.chatResource.toString()}`);
					return;
				}
				if (cts.token.isCancellationRequested || !isEqual(this._session?.chatResource, session.chatResource) || this.modelRef.value) {
					// Cancelled, rebound elsewhere, or already attached via
					// the model-creation listener — drop the extra reference.
					ref.dispose();
					return;
				}
				this.logService.info(`[OptimusDiag] card load OK requests=${ref.object.getRequests().length} for ${session.chatResource.toString()}`);
				this.attachChat(ref);
			}, err => {
				this.logService.error(`[OptimusDiag] card load FAILED for ${session.chatResource.toString()}`, err);
			});

			// Also attach whenever a model for this chat is (re)created. Keep
			// listening for the whole bind so the card always re-attaches to
			// the latest model. IMPORTANT: defer the acquire by a tick —
			// onDidCreateModel fires from inside the model store's acquire()
			// BEFORE it records the creating reference; acquiring
			// synchronously here re-enters acquire(), the outer call then
			// overwrites our reference entry, and the model gets disposed
			// under the card as soon as the creator releases its reference.
			this.bindStore.add(this.chatService.onDidCreateModel(model => {
				if (!isEqual(model.sessionResource, session.chatResource)) {
					return;
				}
				this.bindStore.add(disposableTimeout(() => {
					if (!this.modelRef.value && this.tryAttachChat(session.chatResource)) {
						this.logService.info(`[OptimusDiag] card attached on model creation for ${session.chatResource.toString()}`);
					}
				}, 0));
			}));
		}
	}

	private tryAttachChat(chatResource: URI): boolean {
		const ref = this.chatService.acquireExistingSession(chatResource, 'OptimusCard');
		if (!ref) {
			return false;
		}
		this.attachChat(ref);
		return true;
	}

	private attachChat(ref: IChatModelReference): void {
		this.viewModelStore.clear();
		this.modelRef.value = ref;
		const list = this.ensureChatList();

		const viewModel = this.viewModelStore.add(this.instantiationService.createInstance(ChatViewModel, ref.object, undefined));
		list.setViewModel(viewModel);
		this.viewModelStore.add(toDisposable(() => {
			list.setViewModel(undefined);
			list.refresh();
		}));

		// Refresh the transcript on every (microtask-accumulated) model change
		// and keep it pinned to the newest turn — the list's own scroll lock
		// releases when the user scrolls up.
		this.viewModelStore.add(Event.runAndSubscribe(Event.accumulate(viewModel.onDidChange, 0), () => {
			list.refresh();
		}));
		this.viewModelStore.add(viewModel.onDidDisposeModel(() => {
			this.logService.info(`[OptimusDiag] card model DISPOSED for ${ref.object.sessionResource.toString()}`);
			this.viewModelStore.clear();
		}));

		this.feedEl.style.display = 'none';
		this.chatEl.style.display = '';
		// Lay out now and once more after the browser has applied the display
		// change, so the tree gets real dimensions even when attaching during
		// startup before the first grid layout pass.
		this.layout();
		this.viewModelStore.add(scheduleAtNextAnimationFrame(getWindow(this.element), () => {
			this.layout();
			this.chatList?.scrollToEnd();
		}));
		list.scrollToEnd();

		// Diagnostic: dump what actually rendered a moment after attach.
		const resourceKey = ref.object.sessionResource.toString();
		this.viewModelStore.add(disposableTimeout(() => {
			const rows = this.chatEl.querySelectorAll('.interactive-item-container').length;
			const textLength = (this.chatEl.textContent ?? '').length;
			this.logService.info(`[OptimusDiag] card DOM ${resourceKey}: chatEl=${this.chatEl.clientWidth}x${this.chatEl.clientHeight} contentHeight=${this.chatList?.contentHeight} renderHeight=${this.chatList?.renderHeight} scrollTop=${this.chatList?.scrollTop} rows=${rows} textLen=${textLength} text="${(this.chatEl.textContent ?? '').slice(0, 120).replace(/\s+/g, ' ')}"`);
		}, 2000));
	}

	/**
	 * Create the embedded read-only transcript list on first use. This is the
	 * same renderer the real chat uses (markdown, tool calls, code blocks)
	 * but without the composer, toolbars, or chat-widget-service
	 * registration, so cards stay cheap and don't hijack window-level chat
	 * state. A scoped context key service keeps its context keys local.
	 */
	private ensureChatList(): ChatListWidget {
		if (this.chatList) {
			return this.chatList;
		}

		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.chatEl));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, scopedContextKeyService])
		));

		this.chatList = this._register(scopedInstantiationService.createInstance(
			ChatListWidget,
			this.chatEl,
			{
				location: ChatAgentLocation.Chat,
				renderStyle: 'minimal' as const,
				rendererOptions: {
					renderTextEditsAsSummary: () => true,
					referencesExpandedWhenEmptyResponse: false,
					// Cards are compact read-only mirrors: no per-message
					// footer toolbars (copy/vote), they only add noise.
					noFooter: true,
				},
			}
		));
		return this.chatList;
	}

	/** Re-layout the embedded transcript list to the card's current size. */
	layout(): void {
		if (!this.chatList || this.chatEl.style.display === 'none') {
			return;
		}
		const height = this.chatEl.clientHeight;
		const width = this.chatEl.clientWidth;
		if (height > 0 && width > 0) {
			this.chatList.layout(height, width);
		}
	}

	focus(): void {
		this.element.focus();
	}
}
