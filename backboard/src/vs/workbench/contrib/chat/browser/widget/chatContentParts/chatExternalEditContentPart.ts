/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, clearNode, EventHelper } from '../../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../../base/common/async.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { DetailedLineRangeMapping } from '../../../../../../editor/common/diff/rangeMapping.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { IEditorWorkerService } from '../../../../../../editor/common/services/editorWorker.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { openChatEdit } from '../chatEditNavigation.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { IOpenEditorOptions } from '../../../../../../platform/editor/browser/editor.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IChatExternalEdit } from '../../../common/chatService/chatService.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { ChatEditPillElement } from './chatEditPillElement.js';
import { IChatContentPart } from './chatContentParts.js';
import './media/chatExternalEditCard.css';

export interface IChatExternalEditRenderSeed {
	readonly beforeContent: string;
	readonly afterContent: string;
	/** Exact mappings already computed off the UI thread. */
	readonly changes?: readonly DetailedLineRangeMapping[];
	/** In-flight exact mappings shared with a text-edit completion. */
	readonly changesPromise?: Promise<readonly DetailedLineRangeMapping[] | undefined>;
}

const externalEditRenderSeeds = new WeakMap<IChatExternalEdit, IChatExternalEditRenderSeed>();

interface IBoundedDiffPreviewRow {
	readonly kind: 'added' | 'removed' | 'context';
	readonly lineNumber: number;
	readonly text: string;
}

interface IBoundedDiffPreview {
	readonly rows: readonly IBoundedDiffPreviewRow[];
	readonly truncated: boolean;
}

function getLineCount(text: string): number {
	if (!text) {
		return 0;
	}
	let count = 1;
	let offset = 0;
	while ((offset = text.indexOf('\n', offset)) !== -1) {
		count++;
		offset++;
	}
	return count;
}

function lineRangesEqual(first: string, firstStart: number, firstEnd: number, second: string, secondStart: number, secondEnd: number): boolean {
	const length = firstEnd - firstStart;
	if (length !== secondEnd - secondStart) {
		return false;
	}
	for (let index = 0; index < length; index++) {
		if (first.charCodeAt(firstStart + index) !== second.charCodeAt(secondStart + index)) {
			return false;
		}
	}
	return true;
}

/**
 * Computes a compact unified preview without splitting either full file into
 * line arrays. Common lines are compared in-place and only the bounded set of
 * strings that will become DOM rows is materialized.
 *
 * @internal Exported for focused allocation/performance regression tests.
 */
export function createBoundedDiffPreview(beforeContent: string, afterContent: string, maxRows: number, contextLines: number): IBoundedDiffPreview {
	const originalLineCount = getLineCount(beforeContent);
	const modifiedLineCount = getLineCount(afterContent);
	const sharedLineCount = Math.min(originalLineCount, modifiedLineCount);
	const leadingStarts: number[] = [];
	const leadingEnds: number[] = [];
	let originalOffset = 0;
	let modifiedOffset = 0;
	let prefixLength = 0;

	while (prefixLength < sharedLineCount) {
		const originalNewline = beforeContent.indexOf('\n', originalOffset);
		const modifiedNewline = afterContent.indexOf('\n', modifiedOffset);
		const originalEnd = originalNewline === -1 ? beforeContent.length : originalNewline;
		const modifiedEnd = modifiedNewline === -1 ? afterContent.length : modifiedNewline;
		if (!lineRangesEqual(beforeContent, originalOffset, originalEnd, afterContent, modifiedOffset, modifiedEnd)) {
			break;
		}

		prefixLength++;
		if (contextLines > 0) {
			if (leadingStarts.length === contextLines) {
				leadingStarts.shift();
				leadingEnds.shift();
			}
			leadingStarts.push(modifiedOffset);
			leadingEnds.push(modifiedEnd);
		}
		originalOffset = originalEnd + 1;
		modifiedOffset = modifiedEnd + 1;
	}

	let originalEnd = beforeContent.length;
	let modifiedEnd = afterContent.length;
	let modifiedSuffixStart = modifiedEnd;
	let suffixLength = 0;
	while (suffixLength < sharedLineCount - prefixLength) {
		const originalStart = beforeContent.lastIndexOf('\n', originalEnd - 1) + 1;
		const modifiedStart = afterContent.lastIndexOf('\n', modifiedEnd - 1) + 1;
		if (!lineRangesEqual(beforeContent, originalStart, originalEnd, afterContent, modifiedStart, modifiedEnd)) {
			break;
		}

		suffixLength++;
		modifiedSuffixStart = modifiedStart;
		originalEnd = Math.max(0, originalStart - 1);
		modifiedEnd = Math.max(0, modifiedStart - 1);
	}

	const originalChangedEnd = originalLineCount - suffixLength;
	const modifiedChangedEnd = modifiedLineCount - suffixLength;
	const removedCount = originalChangedEnd - prefixLength;
	const addedCount = modifiedChangedEnd - prefixLength;
	const leadingCount = Math.min(prefixLength, contextLines);
	const trailingCount = Math.min(suffixLength, contextLines);
	const changedBudget = Math.max(0, maxRows - leadingCount - trailingCount);
	let removedBudget = removedCount > 0 && addedCount > 0
		? Math.min(removedCount, Math.ceil(changedBudget / 2))
		: Math.min(removedCount, changedBudget);
	let addedBudget = Math.min(addedCount, changedBudget - removedBudget);
	let unclaimedBudget = changedBudget - removedBudget - addedBudget;
	if (unclaimedBudget > 0) {
		const extraAdded = Math.min(unclaimedBudget, addedCount - addedBudget);
		addedBudget += extraAdded;
		unclaimedBudget -= extraAdded;
		removedBudget += Math.min(unclaimedBudget, removedCount - removedBudget);
	}

	const rows: IBoundedDiffPreviewRow[] = [];
	for (let index = leadingStarts.length - leadingCount; index < leadingStarts.length; index++) {
		rows.push({
			kind: 'context',
			lineNumber: prefixLength - leadingCount + index - (leadingStarts.length - leadingCount) + 1,
			text: afterContent.slice(leadingStarts[index], leadingEnds[index]),
		});
	}

	const appendChangedRows = (content: string, startOffset: number, count: number, kind: 'added' | 'removed' | 'context', firstLineNumber: number): void => {
		let offset = startOffset;
		for (let index = 0; index < count; index++) {
			const newline = content.indexOf('\n', offset);
			const end = newline === -1 ? content.length : newline;
			rows.push({ kind, lineNumber: firstLineNumber + index, text: content.slice(offset, end) });
			offset = end + 1;
		}
	};
	appendChangedRows(beforeContent, originalOffset, removedBudget, 'removed', prefixLength + 1);
	appendChangedRows(afterContent, modifiedOffset, addedBudget, 'added', prefixLength + 1);
	appendChangedRows(afterContent, modifiedSuffixStart, trailingCount, 'context', modifiedChangedEnd + 1);

	const totalCandidateRows = leadingCount + removedCount + addedCount + trailingCount;
	return { rows, truncated: totalCandidateRows > maxRows };
}

/**
 * Supplies content already resolved by another renderer. The WeakMap avoids
 * widening the serialized external-edit protocol with UI-only state.
 */
export function seedChatExternalEditRender(edit: IChatExternalEdit, seed: IChatExternalEditRenderSeed): void {
	externalEditRenderSeeds.set(edit, seed);
}

/**
 * Renders an {@link IChatExternalEdit} progress part as a static "edit pill".
 *
 * Unlike {@link CollapsedCodeBlock}, this part receives all of its data
 * (URI, edit kind, diff stats, before/after content URIs) up-front from the
 * producer (the agent host) and never reads from an
 * {@link IChatEditingSession}. It exists because agent hosts already know
 * the diff metadata for a completed tool call and there's no value in
 * re-deriving it through the chat editing pipeline.
 *
 * Activation (click / Enter) opens the side-by-side diff editor when both
 * `beforeContentUri` and `afterContentUri` are present, falling back to
 * opening the resulting file otherwise.
 */
export class ChatExternalEditContentPart extends ChatEditPillElement implements IChatContentPart {

	private readonly _onDidChangeDiff = this._register(new Emitter<IEditSessionDiffStats>());
	/**
	 * Fires once with the static diff stats from the part data. Wired up by
	 * the list renderer so {@link ChatThinkingContentPart} can aggregate
	 * per-file stats into the thinking title.
	 *
	 * The fire is deferred to the next microtask so that consumers
	 * subscribing immediately after construction (e.g. via
	 * `ChatThinkingContentPart.appendItem`) still receive the initial value.
	 */
	readonly onDidChangeDiff: Event<IEditSessionDiffStats> = this._onDidChangeDiff.event;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	get domNode(): HTMLElement { return this.element; }

	private static readonly previewRowLimit = 8;
	private static readonly fullDiffRowLimit = 400;
	private static readonly retainedContentLimit = 256 * 1024;
	private diffBody: HTMLElement | undefined;
	private diffBodyState: 'none' | 'loading' | 'ready' | 'error' = 'none';
	private diffBodyMode: 'none' | 'preview' | 'full' = 'none';
	private diffBodyRenderGeneration = 0;
	private expandChevron: HTMLElement | undefined;
	private expanded = false;
	private beforeContentCache: string | undefined;
	private afterContentCache: string | undefined;
	private contentHydrationPromise: Promise<readonly [string, string]> | undefined;
	private fullDiffChanges: readonly DetailedLineRangeMapping[] | undefined;
	private fullDiffComputed = false;
	private seededDiffChangesPromise: Promise<readonly DetailedLineRangeMapping[] | undefined> | undefined;
	private fullDiffHydrationPromise: Promise<{ readonly beforeContent: string; readonly afterContent: string; readonly changes: readonly DetailedLineRangeMapping[] | undefined }> | undefined;
	private readonly _previewVisibilityObserver = this._register(new MutableDisposable<IDisposable>());
	private readonly _copyFeedback = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly edit: IChatExternalEdit,
		@ILabelService labelService: ILabelService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IEditorWorkerService private readonly editorWorkerService: IEditorWorkerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(labelService, modelService, languageService, hoverService);
		const renderSeed = externalEditRenderSeeds.get(edit);
		if (renderSeed) {
			externalEditRenderSeeds.delete(edit);
			this.beforeContentCache = renderSeed.beforeContent;
			this.afterContentCache = renderSeed.afterContent;
			if (renderSeed.changes) {
				this.fullDiffChanges = this.retainRenderableChanges(renderSeed.changes);
				this.fullDiffComputed = true;
			}
			this.seededDiffChangesPromise = renderSeed.changesPromise;
		}

		this.render(edit);
		this._register(this.onDidClick(opts => this.openEdit(opts)));

		if (this.canRenderInlineDiff()) {
			this.renderCardControls();
		}
	}

	private canRenderInlineDiff(): boolean {
		// Creates have no before snapshot and deletes have no after snapshot.
		// Either side is enough to render the operation against an empty file.
		return !!this.edit.beforeContentUri || !!this.edit.afterContentUri;
	}

	/**
	 * Mounts the compact inline preview without opening the full disclosure.
	 * The Cursor-style transcript uses this so a completed edit is immediately
	 * legible while the chevron still controls the taller, scrollable diff.
	 */
	showDiffPreview(deferUntilNearViewport = false): void {
		if (!this.canRenderInlineDiff()) {
			return;
		}
		this.element.classList.add('chat-external-edit-preview');
		if (this.diffBodyState === 'none') {
			if (deferUntilNearViewport && this.observePreviewVisibility()) {
				return;
			}
			void this.buildDiffBody('preview');
		}
	}

	private observePreviewVisibility(): boolean {
		if (this._previewVisibilityObserver.value) {
			return true;
		}
		const targetWindow = this.element.ownerDocument.defaultView;
		if (!targetWindow?.IntersectionObserver) {
			return false;
		}
		const observer = new targetWindow.IntersectionObserver(entries => {
			if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) {
				return;
			}
			this._previewVisibilityObserver.clear();
			if (this.diffBodyState === 'none') {
				void this.buildDiffBody('preview');
			}
		}, { rootMargin: '200px 0px' });
		observer.observe(this.element);
		this._previewVisibilityObserver.value = toDisposable(() => observer.disconnect());
		return true;
	}

	/** Adds the Codex-style chevron + copy controls turning the pill into a card header. */
	private renderCardControls(): void {
		this.element.classList.add('chat-external-edit-card');

		const chevron = $('span.codicon.codicon-chevron-right.chat-external-edit-expand', {
			role: 'button',
			tabindex: '0',
			'aria-expanded': 'false',
			'aria-label': localize('chat.externalEdit.showDiff', "Show Diff"),
		});
		this.expandChevron = chevron;

		this.element.appendChild(chevron);

		const toggle = () => this.toggleDiffBody();
		this._register(addDisposableListener(chevron, 'click', toggle));
		this._register(addDisposableListener(chevron, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		}));

		if (this.edit.afterContentUri) {
			const copyButton = $('span.codicon.codicon-copy.chat-external-edit-copy', {
				role: 'button',
				tabindex: '0',
				'aria-label': localize('chat.externalEdit.copyContents', "Copy File Contents"),
			});
			this.element.appendChild(copyButton);
			const copy = () => this.copyAfterContent(copyButton);
			this._register(addDisposableListener(copyButton, 'click', copy));
			this._register(addDisposableListener(copyButton, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					copy();
				}
			}));
		}
	}

	/**
	 * Programmatically expands the inline diff body. No-op when already
	 * expanded or when before/after content is unavailable.
	 */
	expandDiffBody(): void {
		if (!this.expanded && this.canRenderInlineDiff()) {
			this.toggleDiffBody();
		}
	}

	private toggleDiffBody(): void {
		this.expanded = !this.expanded;
		if (this.expanded) {
			this._previewVisibilityObserver.clear();
		}
		this.element.classList.toggle('chat-external-edit-expanded', this.expanded);
		if (this.diffBody) {
			this.diffBody.tabIndex = this.expanded ? 0 : -1;
		}
		if (this.expandChevron) {
			this.expandChevron.classList.toggle('codicon-chevron-right', !this.expanded);
			this.expandChevron.classList.toggle('codicon-chevron-down', this.expanded);
			this.expandChevron.ariaExpanded = String(this.expanded);
		}
		if (this.expanded && (this.diffBodyMode !== 'full' || this.diffBodyState === 'error')) {
			// The collapsed card intentionally owns only a tiny preview. Hydrate
			// exact line mappings only after explicit interaction.
			void this.buildDiffBody('full');
		} else if (!this.expanded && this.diffBodyMode === 'full') {
			// Release the hundreds of detailed DOM rows immediately. Resolved
			// strings and worker mappings stay cached so reopening does no I/O or
			// diff computation.
			void this.buildDiffBody('preview');
		}
		this._onDidChangeHeight.fire();
	}

	private async buildDiffBody(mode: 'preview' | 'full'): Promise<void> {
		const preservePreviewWhileHydrating = mode === 'full'
			&& this.diffBodyMode === 'preview'
			&& this.diffBodyState === 'ready';
		const generation = ++this.diffBodyRenderGeneration;
		this.diffBodyMode = mode;
		this.diffBodyState = 'loading';
		let body = this.diffBody;
		if (!body) {
			body = $('.chat-external-edit-diff-body', {
				role: 'region',
				tabindex: this.expanded ? '0' : '-1',
				'aria-label': localize('chat.externalEdit.diffRegion', "File Diff"),
			});
			this._register(addDisposableListener(body, 'wheel', (event: WheelEvent) => this.scrollDiffBody(body!, event), { passive: false }));
			this.diffBody = body;
			this.element.appendChild(body);
		} else {
			body.tabIndex = this.expanded ? 0 : -1;
			if (!preservePreviewWhileHydrating) {
				clearNode(body);
			}
		}
		if (!preservePreviewWhileHydrating) {
			body.dataset.renderMode = `${mode}-loading`;
			body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.loadingDiff', "Loading diff…")));
		}
		this._onDidChangeHeight.fire();

		try {
			const hydration = mode === 'full' && this.edit.beforeContentUri && this.edit.afterContentUri
				? await this.resolveFullDiffOnce()
				: undefined;
			const [beforeContent, afterContent] = hydration
				? [hydration.beforeContent, hydration.afterContent]
				: await this.resolveContentsOnce();
			if (this._store.isDisposed || this.diffBody !== body || generation !== this.diffBodyRenderGeneration) {
				return;
			}

			const exactChanges = hydration?.changes ?? (this.fullDiffComputed ? this.fullDiffChanges : undefined);

			clearNode(body);
			const content = $('.chat-external-edit-diff-content');
			body.appendChild(content);
			const maxRows = mode === 'preview' ? ChatExternalEditContentPart.previewRowLimit : ChatExternalEditContentPart.fullDiffRowLimit;
			if (!this.edit.beforeContentUri) {
				if (mode === 'preview') {
					this.renderOneSidedPreviewRows(content, 'added', afterContent, maxRows);
				} else {
					this.renderOneSidedDiffRows(content, 'added', afterContent ? afterContent.split('\n') : [], maxRows, true);
				}
			} else if (!this.edit.afterContentUri) {
				if (mode === 'preview') {
					this.renderOneSidedPreviewRows(content, 'removed', beforeContent, maxRows);
				} else {
					this.renderOneSidedDiffRows(content, 'removed', beforeContent ? beforeContent.split('\n') : [], maxRows, true);
				}
			} else if (exactChanges?.length === 0 || beforeContent === afterContent) {
				content.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.noChanges', "No line changes")));
			} else if (mode === 'full' && exactChanges) {
				const originalLines = beforeContent ? beforeContent.split('\n') : [];
				const modifiedLines = afterContent ? afterContent.split('\n') : [];
				this.renderDiffRows(content, originalLines, modifiedLines, exactChanges, maxRows, 2, true);
			} else {
				// Completion previews never run the advanced line-diff algorithm on
				// the UI thread. A linear prefix/suffix window supplies the same
				// compact red/green UX with work bounded by eight rendered rows.
				this.renderBoundedPreviewRows(content, beforeContent, afterContent, maxRows, mode === 'preview' ? 1 : 2, mode === 'full');
			}
			const renderedRowCount = Array.from(content.children).filter(child => child.classList.contains('chat-external-edit-diff-row')).length;
			body.classList.toggle('chat-external-edit-diff-overflow', renderedRowCount > 4);
			body.dataset.renderMode = mode;
			this.diffBodyState = 'ready';
			if (mode === 'preview') {
				this.releaseLargeContentCaches();
			}
			this._onDidChangeHeight.fire();
		} catch {
			if (this._store.isDisposed || this.diffBody !== body || generation !== this.diffBodyRenderGeneration) {
				return;
			}
			if (preservePreviewWhileHydrating) {
				// A transient full-hydration failure must not erase the already useful
				// compact preview. Leave it mounted and allow the next expansion to
				// retry the detailed view.
				this.diffBodyMode = 'preview';
				this.diffBodyState = 'ready';
				body.dataset.renderMode = 'preview';
				this._onDidChangeHeight.fire();
				return;
			}
			clearNode(body);
			body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffUnavailable', "Diff unavailable")));
			this.diffBodyState = 'error';
			this._onDidChangeHeight.fire();
		}
	}

	private releaseLargeContentCaches(): void {
		const retainedSize = (this.beforeContentCache?.length ?? 0) + (this.afterContentCache?.length ?? 0);
		if (retainedSize <= ChatExternalEditContentPart.retainedContentLimit) {
			return;
		}
		this.beforeContentCache = undefined;
		this.afterContentCache = undefined;
		this.contentHydrationPromise = undefined;
	}

	private resolveContentsOnce(): Promise<readonly [string, string]> {
		if ((!this.edit.beforeContentUri || this.beforeContentCache !== undefined)
			&& (!this.edit.afterContentUri || this.afterContentCache !== undefined)) {
			return Promise.resolve([this.beforeContentCache ?? '', this.afterContentCache ?? '']);
		}
		if (!this.contentHydrationPromise) {
			const hydration = Promise.all([
				this.edit.beforeContentUri ? this.resolveContent(this.edit.beforeContentUri) : Promise.resolve(''),
				this.edit.afterContentUri ? this.resolveContent(this.edit.afterContentUri) : Promise.resolve(''),
			] as const).then(([beforeContent, afterContent]) => {
				this.beforeContentCache = beforeContent;
				this.afterContentCache = afterContent;
				return [beforeContent, afterContent] as const;
			});
			const promise = hydration.finally(() => {
				if (this.contentHydrationPromise === promise) {
					this.contentHydrationPromise = undefined;
				}
			});
			this.contentHydrationPromise = promise;
		}
		return this.contentHydrationPromise;
	}

	private resolveFullDiffOnce(): Promise<{ readonly beforeContent: string; readonly afterContent: string; readonly changes: readonly DetailedLineRangeMapping[] | undefined }> {
		if (this.fullDiffComputed && this.beforeContentCache !== undefined && this.afterContentCache !== undefined) {
			return Promise.resolve({ beforeContent: this.beforeContentCache, afterContent: this.afterContentCache, changes: this.fullDiffChanges });
		}
		if (!this.fullDiffHydrationPromise) {
			const hydration = this.seededDiffChangesPromise
				? this.resolveSeededFullDiff()
				: this.computeFullDiffInWorker();
			const promise = hydration.finally(() => {
				if (this.fullDiffHydrationPromise === promise) {
					this.fullDiffHydrationPromise = undefined;
				}
			});
			this.fullDiffHydrationPromise = promise;
		}
		return this.fullDiffHydrationPromise;
	}

	private async resolveSeededFullDiff(): Promise<{ readonly beforeContent: string; readonly afterContent: string; readonly changes: readonly DetailedLineRangeMapping[] | undefined }> {
		const promise = this.seededDiffChangesPromise;
		this.seededDiffChangesPromise = undefined;
		const changes = await promise;
		if (changes === undefined) {
			// A timed-out completion diff remains unresolved. Explicit expansion is
			// the only path allowed to retry the worker.
			return this.computeFullDiffInWorker();
		}
		this.fullDiffChanges = this.retainRenderableChanges(changes);
		this.fullDiffComputed = true;
		const [beforeContent, afterContent] = await this.resolveContentsOnce();
		return {
			beforeContent,
			afterContent,
			changes: this.fullDiffChanges,
		};
	}

	private async computeFullDiffInWorker(): Promise<{ readonly beforeContent: string; readonly afterContent: string; readonly changes: readonly DetailedLineRangeMapping[] | undefined }> {
		if (!this.edit.beforeContentUri || !this.edit.afterContentUri) {
			return { beforeContent: this.beforeContentCache ?? '', afterContent: this.afterContentCache ?? '', changes: undefined };
		}
		let original: Awaited<ReturnType<ITextModelService['createModelReference']>> | undefined;
		let modified: Awaited<ReturnType<ITextModelService['createModelReference']>> | undefined;
		try {
			await Promise.all([
				this.textModelService.createModelReference(this.edit.beforeContentUri).then(reference => original = reference),
				this.textModelService.createModelReference(this.edit.afterContentUri).then(reference => modified = reference),
			]);
			if (!original || !modified) {
				return { beforeContent: this.beforeContentCache ?? '', afterContent: this.afterContentCache ?? '', changes: undefined };
			}
			const beforeContent = this.beforeContentCache ?? original.object.textEditorModel.getValue();
			const afterContent = this.afterContentCache ?? modified.object.textEditorModel.getValue();
			const computedChanges = this.fullDiffComputed
				? this.fullDiffChanges
				: (await this.editorWorkerService.computeDiff(
					original.object.textEditorModel.uri,
					modified.object.textEditorModel.uri,
					{ ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 1000 },
					'advanced',
				))?.changes;
			this.beforeContentCache = beforeContent;
			this.afterContentCache = afterContent;
			if (computedChanges !== undefined) {
				this.fullDiffChanges = this.retainRenderableChanges(computedChanges);
				this.fullDiffComputed = true;
			}
			return { beforeContent, afterContent, changes: this.fullDiffChanges };
		} finally {
			original?.dispose();
			modified?.dispose();
		}
	}

	private scrollDiffBody(body: HTMLElement, event: WheelEvent): void {
		if (!this.expanded || event.deltaY === 0) {
			return;
		}
		const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
			? 20
			: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? body.clientHeight
				: 1;
		const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
		const nextScrollTop = Math.min(maxScrollTop, Math.max(0, body.scrollTop + event.deltaY * deltaScale));
		if (nextScrollTop === body.scrollTop) {
			return;
		}
		EventHelper.stop(event, true);
		body.scrollTop = nextScrollTop;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}

	private async resolveContent(uri: URI): Promise<string> {
		const reference = await this.textModelService.createModelReference(uri);
		try {
			return reference.object.textEditorModel.getValue();
		} finally {
			reference.dispose();
		}
	}

	private appendDiffRow(body: HTMLElement, kind: 'added' | 'removed' | 'context', lineNumber: number, text: string): void {
		const row = $(`.chat-external-edit-diff-row.${kind}`);
		row.appendChild($('span.chat-external-edit-diff-gutter', {}, String(lineNumber)));
		row.appendChild($('span.chat-external-edit-diff-marker', { 'aria-hidden': 'true' }, kind === 'added' ? '+' : kind === 'removed' ? '-' : ''));
		const textElement = $('span.chat-external-edit-diff-text');
		// Row-level add/remove styling carries the important visual signal. Keep
		// code as plain text so expanding a large file never tokenizes its entire
		// contents merely to show at most 400 lines.
		textElement.textContent = text;
		row.appendChild(textElement);
		body.appendChild(row);
	}

	private renderOneSidedDiffRows(body: HTMLElement, kind: 'added' | 'removed', lines: readonly string[], maxRows: number, showTruncationNote: boolean): void {
		for (let index = 0; index < Math.min(lines.length, maxRows); index++) {
			this.appendDiffRow(body, kind, index + 1, lines[index]);
		}
		if (showTruncationNote && lines.length > maxRows) {
			body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffTruncated', "Diff truncated — open the file to see everything")));
		}
	}

	private renderOneSidedPreviewRows(body: HTMLElement, kind: 'added' | 'removed', content: string, maxRows: number): void {
		if (!content) {
			return;
		}
		let offset = 0;
		for (let index = 0; index < maxRows; index++) {
			const newline = content.indexOf('\n', offset);
			const end = newline === -1 ? content.length : newline;
			this.appendDiffRow(body, kind, index + 1, content.slice(offset, end));
			if (newline === -1) {
				break;
			}
			offset = newline + 1;
			if (offset === content.length && index + 1 < maxRows) {
				this.appendDiffRow(body, kind, index + 2, '');
				break;
			}
		}
	}

	/**
	 * Renders unified-diff rows: red deleted lines (original numbering), green
	 * added lines (modified numbering), ±2 context lines, and gap dividers
	 * between non-contiguous hunks — no fake context fill.
	 */
	private renderDiffRows(body: HTMLElement, originalLines: string[], modifiedLines: string[], changes: readonly DetailedLineRangeMapping[], maxRows: number, contextLines: number, showTruncationNote: boolean): void {
		let renderedRows = 0;
		let lastRenderedModifiedLine = 0;
		const stopAtLimit = (): void => {
			if (showTruncationNote) {
				body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffTruncated', "Diff truncated — open the file to see everything")));
			}
		};

		const appendRow = (kind: 'added' | 'removed' | 'context', lineNumber: number, text: string): boolean => {
			if (renderedRows >= maxRows) {
				return false;
			}
			renderedRows++;
			this.appendDiffRow(body, kind, lineNumber, text);
			return true;
		};

		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];
			const next: DetailedLineRangeMapping | undefined = changes[i + 1];

			// Leading context, clamped to what was already rendered.
			const leadStart = Math.max(change.modified.startLineNumber - contextLines, lastRenderedModifiedLine + 1);
			if (lastRenderedModifiedLine > 0 && leadStart > lastRenderedModifiedLine + 1) {
				body.appendChild($('.chat-external-edit-diff-gap'));
			}
			for (let m = leadStart; m < change.modified.startLineNumber; m++) {
				if (!appendRow('context', m, modifiedLines[m - 1] ?? '')) {
					stopAtLimit();
					return;
				}
			}

			for (let o = change.original.startLineNumber; o < change.original.endLineNumberExclusive; o++) {
				if (!appendRow('removed', o, originalLines[o - 1] ?? '')) {
					stopAtLimit();
					return;
				}
			}
			for (let m = change.modified.startLineNumber; m < change.modified.endLineNumberExclusive; m++) {
				if (!appendRow('added', m, modifiedLines[m - 1] ?? '')) {
					stopAtLimit();
					return;
				}
			}

			// Trailing context, clamped to the file end and the next hunk.
			let trailEnd = Math.min(change.modified.endLineNumberExclusive + contextLines - 1, modifiedLines.length);
			if (next) {
				trailEnd = Math.min(trailEnd, next.modified.startLineNumber - 1);
			}
			for (let m = change.modified.endLineNumberExclusive; m <= trailEnd; m++) {
				if (!appendRow('context', m, modifiedLines[m - 1] ?? '')) {
					stopAtLimit();
					return;
				}
			}
			lastRenderedModifiedLine = Math.max(lastRenderedModifiedLine, trailEnd, change.modified.endLineNumberExclusive - 1);
		}
	}

	/**
	 * Linear compact preview used before the exact worker diff is requested.
	 * Only common prefix/suffix lines are inspected; changed rows stop at the
	 * requested DOM limit. This keeps a 100k-line completion off the quadratic
	 * advanced-diff path while preserving the familiar unified red/green card.
	 */
	private renderBoundedPreviewRows(body: HTMLElement, beforeContent: string, afterContent: string, maxRows: number, contextLines: number, showTruncationNote: boolean): void {
		const preview = createBoundedDiffPreview(beforeContent, afterContent, maxRows, contextLines);
		for (const row of preview.rows) {
			this.appendDiffRow(body, row.kind, row.lineNumber, row.text);
		}
		if (showTruncationNote && preview.truncated) {
			body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffTruncated', "Diff truncated — open the file to see everything")));
		}
	}

	private async copyAfterContent(copyButton: HTMLElement): Promise<void> {
		try {
			const content = this.afterContentCache ?? await this.resolveContent(this.edit.afterContentUri ?? this.edit.uri);
			if (this._store.isDisposed) {
				return;
			}
			this.afterContentCache = content;
			await this.clipboardService.writeText(content);
			// Brief success feedback on the button icon.
			copyButton.classList.remove('codicon-copy');
			copyButton.classList.add('codicon-check');
			this._copyFeedback.value = disposableTimeout(() => {
				copyButton.classList.remove('codicon-check');
				copyButton.classList.add('codicon-copy');
			}, 1000);
		} catch {
			// Clipboard/copy failures are non-fatal; leave the button as-is.
		}
	}

	/** Applies worker-computed mappings and counters without replacing the card DOM. */
	applyResolvedDiff(changes: readonly DetailedLineRangeMapping[], diff: IEditSessionDiffStats): void {
		if (this._store.isDisposed) {
			return;
		}
		this.seededDiffChangesPromise = undefined;
		this.fullDiffChanges = this.retainRenderableChanges(changes);
		this.fullDiffComputed = true;
		this.renderDiffStats(diff);
		this._onDidChangeDiff.fire(diff);
		this._onDidChangeHeight.fire();
	}

	/**
	 * The inline full view can display at most 400 rows and never consumes
	 * character-level mappings. Retain only enough lightweight line ranges to
	 * reproduce that view so large historical edits do not pin the worker's
	 * potentially huge inner-change graph for the lifetime of the thread.
	 */
	private retainRenderableChanges(changes: readonly DetailedLineRangeMapping[]): readonly DetailedLineRangeMapping[] {
		const retained: DetailedLineRangeMapping[] = [];
		let estimatedRows = 0;
		for (const change of changes) {
			retained.push(new DetailedLineRangeMapping(change.original, change.modified, undefined));
			estimatedRows += Math.max(1, change.original.length + change.modified.length) + 4;
			if (estimatedRows >= ChatExternalEditContentPart.fullDiffRowLimit) {
				break;
			}
		}
		return retained;
	}

	private renderDiffStats(diff: IEditSessionDiffStats): void {
		this.setDiff(diff, false);
		const fileName = this.labelService.getUriBasenameLabel(this.edit.uri);
		const insertionsFragment = diff.added === 1
			? localize('chat.codeblock.insertions.one', "1 insertion")
			: localize('chat.codeblock.insertions', "{0} insertions", diff.added);
		const deletionsFragment = diff.removed === 1
			? localize('chat.codeblock.deletions.one', "1 deletion")
			: localize('chat.codeblock.deletions', "{0} deletions", diff.removed);
		this.setAriaLabel(localize('summary', 'Edited {0}, {1}, {2}', fileName, insertionsFragment, deletionsFragment));
	}

	private render(edit: IChatExternalEdit): void {
		this.setUri(edit.uri);

		const { icon, label } = describeEdit(edit);
		this.setStatus(icon, label);
		this.setProgressFill(undefined);
		this.setLabelDetail('');

		if (edit.diff && (edit.diff.added > 0 || edit.diff.removed > 0)) {
			// External edits are already complete when they enter the transcript.
			// Render their totals immediately instead of replaying a progress
			// animation every time a restored conversation is opened.
			this.renderDiffStats(edit.diff);
			// Fire the aggregated stats event on the next microtask so
			// listeners attached immediately after construction (the
			// `ChatThinkingContentPart.appendItem` path subscribes after
			// `createInstance` returns) still observe the value. The
			// `Emitter` is not replayable on subscribe, so a synchronous
			// fire would drop the initial stats on the floor.
			const diff = edit.diff;
			queueMicrotask(() => {
				if (this._store.isDisposed) {
					return;
				}
				this._onDidChangeDiff.fire({ added: diff.added, removed: diff.removed });
			});
		} else {
			this.setDiff(undefined);
			this.setAriaLabel(`${label} ${this.labelService.getUriBasenameLabel(edit.uri)}`);
		}
	}

	private openEdit(options: IOpenEditorOptions): void {
		void openChatEdit(this.editorService, this.commandService, this.edit.uri,
			this.edit.beforeContentUri, this.edit.afterContentUri,
			this.edit.editKind === 'delete', options).catch(onUnexpectedError);
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'externalEdit') {
			return false;
		}
		return (
			isEqual(other.uri, this.edit.uri) &&
			other.editKind === this.edit.editKind &&
			other.originalUri?.toString() === this.edit.originalUri?.toString() &&
			other.beforeContentUri?.toString() === this.edit.beforeContentUri?.toString() &&
			other.afterContentUri?.toString() === this.edit.afterContentUri?.toString() &&
			other.undoStopId === this.edit.undoStopId &&
			other.mutationBatchId === this.edit.mutationBatchId &&
			other.mutationBatchFileCount === this.edit.mutationBatchFileCount &&
			(other.diff?.added ?? 0) === (this.edit.diff?.added ?? 0) &&
			(other.diff?.removed ?? 0) === (this.edit.diff?.removed ?? 0)
		);
	}
}

function describeEdit(edit: IChatExternalEdit): { icon: ThemeIcon; label: string } {
	switch (edit.editKind) {
		case 'create':
			return { icon: Codicon.check, label: localize('chat.externalEdit.created', 'Created') };
		case 'delete':
			return { icon: Codicon.check, label: localize('chat.externalEdit.deleted', 'Deleted') };
		case 'rename':
			return { icon: Codicon.check, label: localize('chat.externalEdit.renamed', 'Renamed') };
		case 'edit':
			return { icon: Codicon.check, label: localize('chat.codeblock.edited', 'Edited') };
	}
}
