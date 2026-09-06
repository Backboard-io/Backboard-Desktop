/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, EventHelper, EventType, addDisposableListener } from '../../../base/browser/dom.js';
import { IntervalTimer, Limiter, RunOnceScheduler } from '../../../base/common/async.js';
import { fromNow } from '../../../base/common/date.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { basename, isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { LRUCache } from '../../../base/common/map.js';
import { IChatModel, IChatResponseModel, IChatProgressResponseContent } from '../../../workbench/contrib/chat/common/model/chatModel.js';
import { localize } from '../../../nls.js';
import { IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { ChatAgentLocation } from '../../../workbench/contrib/chat/common/constants.js';
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
		case SessionStatus.InProgress: return localize('optimus.card.running', "Live");
		case SessionStatus.NeedsInput: return localize('optimus.card.needsInput', "Needs Input");
		case SessionStatus.Completed: return localize('optimus.card.done', "Done");
		case SessionStatus.Error: return localize('optimus.card.error', "Error");
		default: return localize('optimus.card.idle', "Idle");
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
 * Codicon per status — the workbench's quiet status language (spinner while
 * running, plain check when done) instead of colored badge pills.
 */
function statusIconClass(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.InProgress: return 'codicon-loading codicon-modifier-spin';
		case SessionStatus.NeedsInput: return 'codicon-bell-dot';
		case SessionStatus.Completed: return 'codicon-check';
		case SessionStatus.Error: return 'codicon-error';
		default: return 'codicon-circle-outline';
	}
}

/**
 * One compact task-slot card in the Optimus grid. Renders the bound session's
 * status, title, bounded plain-text activity from already-running chats,
 * last-activity
 * timestamp. An unbound card renders a "start a task" placeholder.
 */
export class OptimusCard extends Disposable {

	readonly element: HTMLElement;

	private readonly statusDot: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly feedEl: HTMLElement;
	private readonly folderEl: HTMLElement;
	private readonly folderLabelEl: HTMLElement;
	private readonly timeEl: HTMLElement;
	private readonly placeholderEl: HTMLElement;
	private readonly contentEl: HTMLElement;
	private readonly deleteButton: HTMLButtonElement;

	/** Bounded text only: never retain chat models or full render trees. */
	private static readonly historyQueue = new Limiter<void>(2);
	private static readonly activityCache = new LRUCache<string, string>(200);
	private readonly bindStore = this._register(new DisposableStore());
	private readonly previewStore = this._register(new DisposableStore());
	private readonly responseListener = this._register(new MutableDisposable());
	private readonly previewScheduler = this._register(new RunOnceScheduler(() => this.updatePreview(), 250));
	private previewModel: IChatModel | undefined;
	private previewResponse: IChatResponseModel | undefined;
	private followTail = true;
	private previewLoading = false;
	private previewFailed = false;

	private _session: IOptimusCardSessionModel | undefined;
	get session(): IOptimusCardSessionModel | undefined { return this._session; }

	private lastUpdatedAt: Date | undefined;

	private _status: SessionStatus | undefined;
	/** Latest bound session status, for grouping cards (e.g. kanban columns). */
	get status(): SessionStatus | undefined { return this._status; }

	private readonly _onDidAction = this._register(new Emitter<OptimusCardAction>());
	readonly onDidAction: Event<OptimusCardAction> = this._onDidAction.event;

	constructor(
		container: HTMLElement,
		@IChatService private readonly chatService: IChatService,
	) {
		super();

		this.element = append(container, $('.optimus-card'));
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'button');

		this.contentEl = append(this.element, $('.optimus-card-content'));

		const header = append(this.contentEl, $('.optimus-card-header'));
		this.statusDot = append(header, $('.optimus-card-status-icon.codicon'));
		this.titleEl = append(header, $('.optimus-card-title'));
		this.statusText = append(header, $('.optimus-card-status-label'));
		this.deleteButton = append(header, $('button.optimus-card-delete.codicon.codicon-close'));
		this.deleteButton.type = 'button';
		this.deleteButton.title = localize('optimus.card.close', "Close chat");
		this.deleteButton.setAttribute('aria-label', this.deleteButton.title);

		this.feedEl = append(this.contentEl, $('.optimus-card-feed'));
		this._register(addDisposableListener(this.feedEl, EventType.SCROLL, () => {
			this.followTail = this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < 16;
		}));

		const footer = append(this.contentEl, $('.optimus-card-footer'));
		this.folderEl = append(footer, $('.optimus-card-folder'));
		append(this.folderEl, $('span.codicon.codicon-folder'));
		this.folderLabelEl = append(this.folderEl, $('span.optimus-card-folder-label'));

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

		// The entire read-only preview opens the existing focused session.
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
			if (!(event.target as HTMLElement).closest('.optimus-card-delete') && (event.key === 'Enter' || event.key === ' ')) {
				EventHelper.stop(event, true);
				firePrimaryAction();
			}
		}, true));
		this._register(addDisposableListener(this.deleteButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			if (this._session) {
				this._onDidAction.fire({ kind: 'close-session', card: this._session });
			}
		}));


		this.bind(undefined, false);
	}

	/**
	 * Bind this card to a session (or to the placeholder when `undefined`)
	 * and update the active highlight.
	 */
	bind(session: IOptimusCardSessionModel | undefined, isActive: boolean): void {
		// Rebinding to the same session (the sessions service refreshes its
		// list frequently, and visible-session wrappers are recreated per
		// emit) must not reset the activity subscription. Preserve it when the
		// session and chat are unchanged; update just the wrapper and highlight.
		if (session && this._session
			&& this._session.session === session.session
			&& isEqual(this._session.chatResource, session.chatResource)) {
			this._session = session;
			this.element.classList.toggle('active', isActive);
			return;
		}

		this._session = session;
		this._status = undefined;
		this.lastUpdatedAt = undefined;
		this.bindStore.clear();
		this.previewStore.clear();
		this.responseListener.clear();
		this.previewScheduler.cancel();
		this.previewModel = undefined;
		this.previewResponse = undefined;
		this.followTail = true;
		this.previewLoading = false;
		this.previewFailed = false;
		this.feedEl.style.display = '';

		this.element.classList.toggle('active', isActive && !!session);
		this.element.classList.toggle('empty', !session);
		this.element.classList.remove('running', 'needs-input', 'done', 'error', 'idle');
		this.contentEl.style.display = session ? '' : 'none';
		this.placeholderEl.style.display = session ? 'none' : '';
		this.deleteButton.style.display = session ? '' : 'none';

		if (!session) {
			this.element.setAttribute('aria-label', localize('optimus.card.start', "Start a Task"));
			return;
		}

		const sessionModel = session.session;

		// Static + reactive card chrome from the session's observables.
		this.bindStore.add(autorun(reader => {
			const title = sessionModel.title.read(reader);
			const status = sessionModel.status.read(reader);

			this._status = status;
			this.titleEl.textContent = title || localize('optimus.card.untitled', "Untitled");
			this.titleEl.title = this.titleEl.textContent;
			this.statusText.textContent = statusLabel(status);
			this.statusText.className = `optimus-card-status-label ${statusClass(status)}`;
			this.statusDot.className = `optimus-card-status-icon codicon ${statusIconClass(status)} ${statusClass(status)}`;
			this.element.classList.remove('running', 'needs-input', 'done', 'error', 'idle');
			this.element.classList.add(statusClass(status));

			this.element.setAttribute('aria-label', localize('optimus.card.open', "{0}, {1}. Open Session", this.titleEl.textContent, statusLabel(status)));
		}));

		this.bindStore.add(autorun(reader => {
			// Workspace and provider metadata do not depend on streamed output.
			const workspace = sessionModel.workspace.read(reader);
			const folderUri = workspace?.folders[0]?.workingDirectory;
			this.folderLabelEl.textContent = workspace?.label || (folderUri ? basename(folderUri) : localize('optimus.card.noFolder', "No Workspace"));
			this.folderEl.classList.toggle('no-folder', !workspace);
			this.folderEl.title = folderUri?.fsPath ?? '';


		}));

		this.bindStore.add(autorun(reader => {
			this.lastUpdatedAt = sessionModel.updatedAt.read(reader);
			this.updateRelativeTime();
		}));

		// Relative timestamps drift; refresh them on a slow tick.
		const timeTicker = this.bindStore.add(new IntervalTimer());
		timeTicker.cancelAndSet(() => this.updateRelativeTime(), 30_000);

		// Watching an existing model is read-only. Opening the dashboard must
		// avoid owning a full chat renderer or keeping inactive models alive.
		this.bindStore.add(autorun(reader => {
			sessionModel.description.read(reader);
			sessionModel.status.read(reader);
			this.schedulePreview();
		}));
		this.bindStore.add(this.chatService.onDidCreateModel(model => {
			if (isEqual(model.sessionResource, session.chatResource)) {
				this.attachPreview(model);
			}
		}));
		const model = this.chatService.getSession(session.chatResource);
		if (model) {
			this.attachPreview(model);
		}
		this.updatePreview();
		if (!model && !OptimusCard.activityCache.has(session.chatResource.toString())) {
			this.previewLoading = true;
			this.updatePreview();
			const cancellation = new CancellationTokenSource();
			this.bindStore.add(toDisposable(() => cancellation.dispose(true)));
			// Read historical previews two at a time, only for the visible page.
			// Release the loaded history immediately after extracting bounded text.
			void OptimusCard.historyQueue.queue(async () => {
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				try {
					const ref = await this.chatService.acquireOrLoadSession(session.chatResource, ChatAgentLocation.Chat, cancellation.token, 'OptimusCard#preview');
					try {
						if (ref && !cancellation.token.isCancellationRequested) {
							this.attachPreview(ref.object);
							this.updatePreview();
						}
					} finally {
						ref?.dispose();
					}
				} catch {
					if (!cancellation.token.isCancellationRequested && !this.previewResponse) {
						this.previewFailed = true;
					}
				} finally {
					if (!cancellation.token.isCancellationRequested) {
						this.previewLoading = false;
						this.updatePreview();
					}
				}
			});
		}
	}

	private schedulePreview(): void {
		if (!this.previewScheduler.isScheduled()) {
			this.previewScheduler.schedule();
		}
	}

	private attachPreview(model: IChatModel): void {
		if (this.previewModel === model) {
			return;
		}
		this.previewStore.clear();
		this.responseListener.clear();
		this.previewModel = model;
		this.previewResponse = undefined;
		const watchResponse = (): void => {
			const response = model.lastRequest?.response;
			if (response !== this.previewResponse) {
				this.previewResponse = response;
				this.responseListener.value = response?.onDidChange(() => this.schedulePreview());
			}
			this.schedulePreview();
		};
		this.previewStore.add(model.onDidChange(watchResponse));
		this.previewStore.add(model.onDidDispose(() => {
			this.previewStore.clear();
			this.responseListener.clear();
			this.previewModel = undefined;
			this.previewResponse = undefined;
		}));
		watchResponse();
	}

	private updatePreview(): void {
		const session = this._session;
		if (!session) {
			return;
		}
		const key = session.chatResource.toString();
		const activity = getOptimusActivityPreview(this.previewResponse?.response.value ?? []);
		if (activity) {
			OptimusCard.activityCache.set(key, activity);
		}
		const description = session.session.description.get()?.value;
		const text = activity || OptimusCard.activityCache.get(key) || description?.slice(-1600)
			|| (session.session.status.get() === SessionStatus.InProgress
				? localize('optimus.card.working', "Working…")
				: this.previewLoading ? localize('optimus.card.loadingPreview', "Loading transcript…")
				: this.previewFailed ? localize('optimus.card.previewUnavailable', "Transcript unavailable")
				: localize('optimus.card.emptyPreview', "No transcript yet"));
		if (this.feedEl.textContent !== text) {
			const follow = this.followTail;
			this.feedEl.textContent = text;
			if (follow) {
				this.feedEl.scrollTop = this.feedEl.scrollHeight;
			}
		}
	}

	private updateRelativeTime(): void {
		if (!this.lastUpdatedAt) {
			this.timeEl.textContent = '';
			return;
		}
		this.timeEl.textContent = fromNow(this.lastUpdatedAt, true);
		this.timeEl.title = this.lastUpdatedAt.toLocaleString();
	}


	focus(): void {
		this.element.focus();
	}
}

/** Extract recent activity without markdown rendering or walking the full history. */
export function getOptimusActivityPreview(parts: readonly IChatProgressResponseContent[]): string {
	const snippets: string[] = [];
	let remaining = 1600;
	for (let index = parts.length - 1; index >= Math.max(0, parts.length - 16) && remaining > 0; index--) {
		const part = parts[index];
		let text = '';
		switch (part.kind) {
			case 'markdownContent':
			case 'progressMessage':
				text = part.content.value;
				break;
			case 'thinking':
				text = part.generatedTitle || (Array.isArray(part.value) ? part.value.slice(-2).map(value => value.slice(-800)).join('\n') : part.value) || '';
				break;
			case 'toolInvocation':
			case 'toolInvocationSerialized': {
				const message = part.invocationMessage;
				text = localize('optimus.card.toolActivity', "Tool: {0}", typeof message === 'string' ? message : message.value);
				break;
			}
		}
		text = text.slice(-remaining).trim();
		if (text) {
			snippets.unshift(text);
			remaining -= text.length + 2;
		}
	}
	return snippets.join('\n\n');
}
