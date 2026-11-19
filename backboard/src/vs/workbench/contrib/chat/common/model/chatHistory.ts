/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IChatSessionHistoryController, IChatSessionHistoryItem } from '../chatSessionsService.js';
import { ChatRequestModel } from './chatModel.js';

export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_WINDOW_SIZE = 150;

/** Shared model ownership; views retain only the requests in their own window.
 * The live model separately owns its current request. Eviction is not removal. */
export class ChatHistory extends Disposable {

	private readonly entries = new Map<string, { request: ChatRequestModel; references: number }>();

	constructor(
		readonly source: IChatSessionHistoryController,
		initial: readonly ChatRequestModel[],
		private readonly hydrate: (history: readonly IChatSessionHistoryItem[]) => ChatRequestModel[],
		private readonly live: () => readonly ChatRequestModel[],
	) {
		super();
		for (const request of initial) { this.adopt(request); }
	}

	adopt(request: ChatRequestModel): void {
		this.entries.set(request.id, { request, references: this.entries.get(request.id)?.references ?? 0 });
	}

	get requests(): ChatRequestModel[] {
		return [...this.entries.values()].map(entry => entry.request);
	}

	private orderIds: readonly string[] | undefined;
	private order = new Map<string, number>();
	orderedRequests(): ChatRequestModel[] {
		const ids = this.source.getTurnIds();
		if (ids !== this.orderIds) {
			this.orderIds = ids;
			this.order = new Map(ids.map((id, index) => [id, index]));
		}
		return this.requests.sort((a, b) => (this.order.get(a.id) ?? Infinity) - (this.order.get(b.id) ?? Infinity));
	}

	acquireLoaded(ids: readonly string[]): IReference<readonly ChatRequestModel[]> | undefined {
		if (ids.some(id => !this.entries.has(id))) { return undefined; }
		const entries = ids.map(id => this.entries.get(id)!);
		for (const entry of entries) { entry.references++; }
		return Object.assign(toDisposable(() => {
			for (const entry of entries) { entry.references--; }
			this.collect();
		}), { object: entries.map(entry => entry.request) });
	}

	async acquire(ids: readonly string[], token: CancellationToken): Promise<IReference<readonly ChatRequestModel[]>> {
		const loaded = this.acquireLoaded(ids);
		if (loaded) { return loaded; }
		// Pin existing rows across the awaits: another view may release them.
		const pins = [this.acquireLoaded(ids.filter(id => this.entries.has(id)))!];
		try {
			for (let offset = 0; offset < ids.length; offset += CHAT_HISTORY_PAGE_SIZE) {
				const batch = ids.slice(offset, offset + CHAT_HISTORY_PAGE_SIZE);
				if (batch.every(id => this.entries.has(id))) { continue; }
				const allIds = this.source.getTurnIds();
				const end = allIds.indexOf(batch[batch.length - 1]);
				if (end < 0 || token.isCancellationRequested) { throw new CancellationError(); }
				const messages = await this.source.fetchTurns({ before: allIds[end + 1], limit: batch.length }, token);
				if (token.isCancellationRequested || this._store.isDisposed) { throw new CancellationError(); }
				for (const request of this.hydrate(messages)) {
					if (this.entries.has(request.id)) {
						request.response?.dispose();
					} else {
						this.adopt(request);
					}
				}
				pins.push(this.acquireLoaded(batch.filter(id => this.entries.has(id)))!);
			}
			const currentIds = new Set(this.source.getTurnIds());
			if (ids.some(id => !currentIds.has(id)) || token.isCancellationRequested) { throw new CancellationError(); }
			const result = this.acquireLoaded(ids);
			if (!result) { throw new Error('History changed while loading'); }
			return result;
		} finally {
			for (const pin of pins) { pin.dispose(); }
		}
	}

	collect(): void {
		const live = new Set(this.live());
		for (const [id, entry] of this.entries) {
			if (!entry.references && !live.has(entry.request)) {
				this.entries.delete(id);
				entry.request.response?.dispose();
			}
		}
	}

	/** Complete-history operations retain one page at a time, independently of views. */
	async forEachPage(visit: (requests: readonly ChatRequestModel[]) => void): Promise<void> {
		const ids = [...this.source.getTurnIds()];
		const live = this.acquireLoaded(this.live().filter(request => !ids.includes(request.id)).map(request => request.id))!;
		try {
			for (let index = 0; index < ids.length; index += CHAT_HISTORY_PAGE_SIZE) {
				const page = await this.acquire(ids.slice(index, index + CHAT_HISTORY_PAGE_SIZE), CancellationToken.None);
				try { visit(page.object); } finally { page.dispose(); }
			}
			const current = this.source.getTurnIds();
			if (ids.some((id, index) => current[index] !== id)) { throw new Error('History changed; retry the operation'); }
			visit(live.object);
		} finally { live.dispose(); }
	}

	override dispose(): void {
		for (const entry of this.entries.values()) { entry.request.response?.dispose(); }
		this.entries.clear();
		super.dispose();
	}
}

export type ChatHistoryDirection = 'older' | 'newer' | 'latest';

/** One independent reading window per ChatViewModel. No storage mutation API. */
export class ChatHistoryWindow extends Disposable {

	private readonly changing = this._register(new Emitter<{ direction: ChatHistoryDirection; target?: string }>());
	readonly onWillChange = this.changing.event;
	followingLatest = true;
	followLive = true;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private page: IReference<readonly ChatRequestModel[]> | undefined;
	private request: CancellationTokenSource | undefined;
	private revision = 0;
	private retryQuery: { direction: ChatHistoryDirection; reset: boolean; target?: string } = { direction: 'latest', reset: false };
	private knownIds: readonly string[];
	loading = false;
	error: unknown;
	canEvict: (ids: readonly string[], preserveAnchor: boolean) => boolean = () => true;

	constructor(readonly history: ChatHistory) {
		super();
		this.knownIds = history.source.getTurnIds();
		this.page = history.acquireLoaded(this.knownIds.slice(-CHAT_HISTORY_PAGE_SIZE));
		this._register(history.source.onDidChange(() => {
			const ids = history.source.getTurnIds();
			const reset = this.knownIds.length > ids.length || (this.knownIds.length > 0 && ids[this.knownIds.length - 1] !== this.knownIds[this.knownIds.length - 1]);
			this.knownIds = ids;
			if (reset) {
				this.revision++;
				this.request?.cancel();
				void this.load('latest', true);
			} else {
				if (this.followingLatest) { void this.load('newer'); }
				this.changed.fire();
			}
		}));
	}

	get requests(): readonly ChatRequestModel[] { return this.page?.object ?? []; }
	get hasOlder(): boolean { return this.requests.length > 0 && this.history.source.getTurnIds()[0] !== this.requests[0].id; }
	get hasNewer(): boolean { return this.requests.length > 0 && this.history.source.getTurnIds().at(-1) !== this.requests.at(-1)!.id; }

	cancelLoading(): void {
		this.revision++;
		this.request?.dispose(true);
		this.request = undefined;
		this.loading = false;
		this.error = undefined;
	}

	retry(): Promise<boolean> {
		const { direction, reset, target } = this.retryQuery;
		return this.load(direction, reset, target);
	}

	async load(direction: ChatHistoryDirection, reset = false, target?: string): Promise<boolean> {
		if (this.loading && !reset && target === undefined && direction !== 'latest') { return false; }
		const ids = this.history.source.getTurnIds();
		const first = this.requests[0]?.id;
		const last = this.requests.at(-1)?.id;
		let start: number, end: number;
		if (target !== undefined) {
			const index = ids.indexOf(target);
			if (index < 0) { return false; }
			start = Math.max(0, index - Math.floor(CHAT_HISTORY_PAGE_SIZE / 2));
			end = Math.min(ids.length, start + CHAT_HISTORY_PAGE_SIZE);
		} else if (direction === 'latest' || !first || !last) {
			end = ids.length; start = Math.max(0, end - CHAT_HISTORY_PAGE_SIZE);
		} else if (direction === 'older') {
			start = Math.max(0, ids.indexOf(first) - CHAT_HISTORY_PAGE_SIZE);
			end = Math.min(ids.indexOf(last) + 1, start + CHAT_HISTORY_WINDOW_SIZE);
		} else {
			end = Math.min(ids.length, ids.indexOf(last) + 1 + CHAT_HISTORY_PAGE_SIZE);
			start = Math.max(ids.indexOf(first), end - CHAT_HISTORY_WINDOW_SIZE);
		}
		const wanted = ids.slice(start, end);
		const evicted = this.requests.filter(request => !wanted.includes(request.id)).map(request => request.id);
		const preserveAnchor = direction !== 'latest' && target === undefined;
		if (!reset && !this.canEvict(evicted, preserveAnchor)) {
			if (this.hasNewer) { this.followingLatest = false; this.changed.fire(); }
			return false;
		}
		this.retryQuery = { direction, reset, target };
		this.request?.dispose(true);
		const cancellation = this.request = new CancellationTokenSource();
		const revision = ++this.revision;
		const catchUp = direction !== 'older' && target === undefined && this.followLive && end === ids.length;
		let committed = false;
		this.loading = true;
		this.error = undefined;
		this.changed.fire();
		try {
			const page = await this.history.acquire(wanted, cancellation.token);
			if (revision !== this.revision || this._store.isDisposed || (!reset && !this.canEvict(evicted, preserveAnchor))) {
				page.dispose(); return false;
			}
			const old = this.page;
			this.changing.fire({ direction, target });
			this.followingLatest = wanted.at(-1) === this.history.source.getTurnIds().at(-1);
			this.page = page;
			committed = true;
			this.changed.fire(); // Unmount row view models before releasing their models.
			old?.dispose();
			return true;
		} catch (error) {
			if (!cancellation.token.isCancellationRequested) { this.error = error; }
			return false;
		} finally {
			if (revision === this.revision) {
				this.loading = false;
				this.changed.fire();
				if (committed && catchUp && this.hasNewer && !this._store.isDisposed) { void this.load('newer'); }
			}
			cancellation.dispose();
		}
	}

	override dispose(): void {
		this.cancelLoading();
		this.page?.dispose();
		this.page = undefined;
		this.knownIds = [];
		this.canEvict = () => true;
		super.dispose();
	}
}
