/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IChatModelReference, IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { SessionStatus } from '../../../sessions/services/sessions/common/session.js';

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
 * One compact task-slot card in the Optimus 3x2 grid. Renders the bound
 * session's status, title, a live terminal-style feed of the streaming
 * response, changed-file stats and last-activity timestamp. An unbound card
 * renders a "start a task" placeholder.
 */
export class OptimusCard extends Disposable {

	readonly element: HTMLElement;

	private readonly statusDot: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly feedEl: HTMLElement;
	private readonly changesEl: HTMLElement;
	private readonly timeEl: HTMLElement;
	private readonly placeholderEl: HTMLElement;
	private readonly contentEl: HTMLElement;

	/** Disposables tied to the currently bound session; cleared on rebind. */
	private readonly bindStore = this._register(new DisposableStore());
	/** Disposables tied to the currently attached chat-model feed. */
	private readonly feedStore = this._register(new DisposableStore());
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());

	private _session: IActiveSession | undefined;
	get session(): IActiveSession | undefined { return this._session; }

	private readonly _onDidClick = this._register(new Emitter<IActiveSession | undefined>());
	/** Fires with the bound session (or `undefined` for the placeholder) when the card is clicked. */
	readonly onDidClick: Event<IActiveSession | undefined> = this._onDidClick.event;

	constructor(
		container: HTMLElement,
		@IChatService private readonly chatService: IChatService,
	) {
		super();

		this.element = append(container, $('.optimus-card'));
		this.element.tabIndex = 0;

		this.contentEl = append(this.element, $('.optimus-card-content'));

		const header = append(this.contentEl, $('.optimus-card-header'));
		this.statusDot = append(header, $('.optimus-card-status-dot'));
		this.titleEl = append(header, $('.optimus-card-title'));
		this.statusText = append(header, $('.optimus-card-status-label'));

		this.feedEl = append(this.contentEl, $('.optimus-card-feed'));

		const footer = append(this.contentEl, $('.optimus-card-footer'));
		this.changesEl = append(footer, $('.optimus-card-changes'));
		this.timeEl = append(footer, $('.optimus-card-time'));

		this.placeholderEl = append(this.element, $('.optimus-card-placeholder'));
		const placeholderIcon = append(this.placeholderEl, $('.optimus-card-placeholder-icon'));
		placeholderIcon.textContent = '+';
		const placeholderLabel = append(this.placeholderEl, $('.optimus-card-placeholder-label'));
		placeholderLabel.textContent = localize('optimus.card.placeholder', "Start a task");

		this._register(Event.any<unknown>(
			Event.fromDOMEventEmitter(this.element, 'click'),
		)(() => this._onDidClick.fire(this._session)));

		this.bind(undefined, false);
	}

	/**
	 * Bind this card to a session (or to the placeholder when `undefined`)
	 * and update the active highlight.
	 */
	bind(session: IActiveSession | undefined, isActive: boolean): void {
		this._session = session;
		this.bindStore.clear();
		this.modelRef.clear();

		this.element.classList.toggle('active', isActive && !!session);
		this.element.classList.toggle('empty', !session);
		this.contentEl.style.display = session ? '' : 'none';
		this.placeholderEl.style.display = session ? 'none' : '';

		if (!session) {
			return;
		}

		// Static + reactive card chrome from the session's observables.
		this.bindStore.add(autorun(reader => {
			const title = session.title.read(reader);
			const status = session.status.read(reader);
			const updatedAt = session.updatedAt.read(reader);
			const changes = session.changesSummary?.read(reader);

			this.titleEl.textContent = title || localize('optimus.card.untitled', "Untitled");
			this.titleEl.title = this.titleEl.textContent;
			this.statusText.textContent = statusLabel(status);
			this.statusDot.className = `optimus-card-status-dot ${statusClass(status)}`;
			this.changesEl.textContent = changes && changes.files > 0
				? localize('optimus.card.changes', "{0} changed files (+{1} −{2})", changes.files, changes.additions, changes.deletions)
				: localize('optimus.card.noChanges', "No changed files");
			this.timeEl.textContent = updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		}));

		// Live terminal-style feed: follow the active chat's last request and
		// stream its response text as it grows. The chat model may not be
		// loaded in this window yet (the right panel loads it lazily), so if
		// acquisition fails the card shows the session's status description
		// and retries when a matching model is created.
		this.bindStore.add(autorun(reader => {
			const chat = session.activeChat.read(reader);
			reader.store.add(toDisposable(() => {
				this.feedStore.clear();
				this.modelRef.clear();
			}));
			if (!this.tryAttachFeed(chat.resource)) {
				const description = session.description.read(reader);
				this.renderFeedText(description?.value ?? '');
				// One-time retry: the chat model for this session may not be loaded
				// yet (the right panel loads it lazily). Stop listening once it
				// attaches so later, unrelated model re-creations don't churn the feed.
				const retry = this.chatService.onDidCreateModel(model => {
					if (isEqual(model.sessionResource, chat.resource) && this.tryAttachFeed(chat.resource)) {
						retry.dispose();
					}
				});
				reader.store.add(retry);
			}
		}));
	}

	private tryAttachFeed(chatResource: URI): boolean {
		const ref = this.chatService.acquireExistingSession(chatResource, 'OptimusCard');
		if (!ref) {
			return false;
		}
		this.feedStore.clear();
		this.modelRef.value = ref;
		const model = ref.object;
		this.feedStore.add(autorun(reader => {
			const lastRequest = model.lastRequestObs.read(reader);
			const response = lastRequest?.response;
			if (!response) {
				this.renderFeedText('');
				return;
			}
			const renderResponse = () => this.renderFeedText(response.response.toString());
			reader.store.add(response.onDidChange(() => renderResponse()));
			renderResponse();
		}));
		return true;
	}

	private renderFeedText(text: string): void {
		clearNode(this.feedEl);
		if (!text) {
			return;
		}
		// Keep the feed bounded: only the tail of a long transcript matters.
		const MAX = 4000;
		this.feedEl.textContent = text.length > MAX ? text.slice(text.length - MAX) : text;
		this.feedEl.scrollTop = this.feedEl.scrollHeight;
	}

	focus(): void {
		this.element.focus();
	}
}
