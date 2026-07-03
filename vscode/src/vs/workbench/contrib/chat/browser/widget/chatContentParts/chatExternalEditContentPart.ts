/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, clearNode } from '../../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../../base/common/async.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { linesDiffComputers } from '../../../../../../editor/common/diff/linesDiffComputers.js';
import { DetailedLineRangeMapping } from '../../../../../../editor/common/diff/rangeMapping.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { IOpenEditorOptions } from '../../../../../../platform/editor/browser/editor.js';
import { IEditorService, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { IChatExternalEdit } from '../../../common/chatService/chatService.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { ChatEditPillElement } from './chatEditPillElement.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import './media/chatExternalEditCard.css';

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

	get domNode(): HTMLElement { return this.element; }

	private diffBody: HTMLElement | undefined;
	private diffBodyState: 'none' | 'loading' | 'ready' | 'error' = 'none';
	private expandChevron: HTMLElement | undefined;
	private expanded = false;
	private afterContentCache: string | undefined;
	private readonly _copyFeedback = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly edit: IChatExternalEdit,
		_context: IChatContentPartRenderContext,
		@ILabelService labelService: ILabelService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(labelService, modelService, languageService, hoverService);

		this.render(edit);
		this._register(this.onDidClick(opts => this.openEdit(opts)));

		if (this.canRenderInlineDiff()) {
			this.renderCardControls();
		}
	}

	private canRenderInlineDiff(): boolean {
		return !!this.edit.beforeContentUri && !!this.edit.afterContentUri;
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

		const copyButton = $('span.codicon.codicon-copy.chat-external-edit-copy', {
			role: 'button',
			tabindex: '0',
			'aria-label': localize('chat.externalEdit.copyContents', "Copy File Contents"),
		});

		this.element.append(chevron, copyButton);

		const toggle = () => this.toggleDiffBody();
		this._register(addDisposableListener(chevron, 'click', toggle));
		this._register(addDisposableListener(chevron, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		}));

		const copy = () => this.copyAfterContent(copyButton);
		this._register(addDisposableListener(copyButton, 'click', copy));
		this._register(addDisposableListener(copyButton, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				copy();
			}
		}));
	}

	private toggleDiffBody(): void {
		this.expanded = !this.expanded;
		this.element.classList.toggle('chat-external-edit-expanded', this.expanded);
		if (this.expandChevron) {
			this.expandChevron.classList.toggle('codicon-chevron-right', !this.expanded);
			this.expandChevron.classList.toggle('codicon-chevron-down', this.expanded);
			this.expandChevron.ariaExpanded = String(this.expanded);
		}
		if (this.expanded && this.diffBodyState === 'none') {
			this.buildDiffBody();
		}
	}

	private async buildDiffBody(): Promise<void> {
		this.diffBodyState = 'loading';
		const body = $('.chat-external-edit-diff-body', { role: 'region', 'aria-label': localize('chat.externalEdit.diffRegion', "File Diff") });
		body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.loadingDiff', "Loading diff…")));
		this.diffBody = body;
		this.element.appendChild(body);

		try {
			const [beforeContent, afterContent] = await Promise.all([
				this.resolveContent(this.edit.beforeContentUri!),
				this.resolveContent(this.edit.afterContentUri!),
			]);
			if (this._store.isDisposed || this.diffBody !== body) {
				return;
			}
			this.afterContentCache = afterContent;

			const originalLines = beforeContent.split('\n');
			const modifiedLines = afterContent.split('\n');
			const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
				ignoreTrimWhitespace: false,
				computeMoves: false,
				maxComputationTimeMs: 1000,
			});

			clearNode(body);
			if (diff.changes.length === 0) {
				body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.noChanges', "No line changes")));
			} else {
				this.renderDiffRows(body, originalLines, modifiedLines, diff.changes);
			}
			this.diffBodyState = 'ready';
		} catch {
			if (this._store.isDisposed || this.diffBody !== body) {
				return;
			}
			clearNode(body);
			body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffUnavailable', "Diff unavailable")));
			this.diffBodyState = 'error';
		}
	}

	private async resolveContent(uri: URI): Promise<string> {
		const reference = await this.textModelService.createModelReference(uri);
		try {
			return reference.object.textEditorModel.getValue();
		} finally {
			reference.dispose();
		}
	}

	/**
	 * Renders unified-diff rows: red deleted lines (original numbering), green
	 * added lines (modified numbering), ±2 context lines, and gap dividers
	 * between non-contiguous hunks — no fake context fill.
	 */
	private renderDiffRows(body: HTMLElement, originalLines: string[], modifiedLines: string[], changes: readonly DetailedLineRangeMapping[]): void {
		const CONTEXT_LINES = 2;
		const MAX_ROWS = 400;
		let renderedRows = 0;
		let lastRenderedModifiedLine = 0;

		const appendRow = (kind: 'added' | 'removed' | 'context', lineNumber: number, text: string): boolean => {
			if (renderedRows >= MAX_ROWS) {
				return false;
			}
			renderedRows++;
			const row = $(`.chat-external-edit-diff-row.${kind}`);
			row.appendChild($('span.chat-external-edit-diff-gutter', {}, String(lineNumber)));
			row.appendChild($('span.chat-external-edit-diff-text', {}, text));
			body.appendChild(row);
			return true;
		};

		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];
			const next: DetailedLineRangeMapping | undefined = changes[i + 1];

			// Leading context, clamped to what was already rendered.
			const leadStart = Math.max(change.modified.startLineNumber - CONTEXT_LINES, lastRenderedModifiedLine + 1);
			if (lastRenderedModifiedLine > 0 && leadStart > lastRenderedModifiedLine + 1) {
				body.appendChild($('.chat-external-edit-diff-gap'));
			}
			for (let m = leadStart; m < change.modified.startLineNumber; m++) {
				appendRow('context', m, modifiedLines[m - 1] ?? '');
			}

			for (let o = change.original.startLineNumber; o < change.original.endLineNumberExclusive; o++) {
				appendRow('removed', o, originalLines[o - 1] ?? '');
			}
			for (let m = change.modified.startLineNumber; m < change.modified.endLineNumberExclusive; m++) {
				appendRow('added', m, modifiedLines[m - 1] ?? '');
			}

			// Trailing context, clamped to the file end and the next hunk.
			let trailEnd = Math.min(change.modified.endLineNumberExclusive + CONTEXT_LINES - 1, modifiedLines.length);
			if (next) {
				trailEnd = Math.min(trailEnd, next.modified.startLineNumber - 1);
			}
			for (let m = change.modified.endLineNumberExclusive; m <= trailEnd; m++) {
				appendRow('context', m, modifiedLines[m - 1] ?? '');
			}
			lastRenderedModifiedLine = Math.max(lastRenderedModifiedLine, trailEnd, change.modified.endLineNumberExclusive - 1);

			if (renderedRows >= MAX_ROWS) {
				body.appendChild($('.chat-external-edit-diff-note', {}, localize('chat.externalEdit.diffTruncated', "Diff truncated — open the file to see everything")));
				return;
			}
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

	private render(edit: IChatExternalEdit): void {
		this.setUri(edit.uri);

		const { icon, label } = describeEdit(edit);
		this.setStatus(icon, label);
		this.setProgressFill(undefined);
		this.setLabelDetail('');

		if (edit.diff && (edit.diff.added > 0 || edit.diff.removed > 0)) {
			this.setDiff(edit.diff);
			const fileName = this.labelService.getUriBasenameLabel(edit.uri);
			const insertionsFragment = edit.diff.added === 1
				? localize('chat.codeblock.insertions.one', "1 insertion")
				: localize('chat.codeblock.insertions', "{0} insertions", edit.diff.added);
			const deletionsFragment = edit.diff.removed === 1
				? localize('chat.codeblock.deletions.one', "1 deletion")
				: localize('chat.codeblock.deletions', "{0} deletions", edit.diff.removed);
			this.setAriaLabel(localize('summary', 'Edited {0}, {1}, {2}', fileName, insertionsFragment, deletionsFragment));
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

	private openEdit({ editorOptions: options, openToSide }: IOpenEditorOptions): void {
		const group = openToSide ? SIDE_GROUP : undefined;
		if (this.edit.beforeContentUri && this.edit.afterContentUri) {
			this.editorService.openEditor({
				original: { resource: this.edit.beforeContentUri },
				modified: { resource: this.edit.afterContentUri },
				options,
			}, group);
		} else if (this.edit.editKind === 'delete' && this.edit.beforeContentUri) {
			// The file no longer exists on disk; show the pre-deletion
			// content from the snapshot instead of opening the missing URI.
			this.editorService.openEditor({ resource: this.edit.beforeContentUri, options }, group);
		} else if (this.edit.editKind !== 'delete') {
			this.editorService.openEditor({ resource: this.edit.uri, options }, group);
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'externalEdit') {
			return false;
		}
		return (
			isEqual(other.uri, this.edit.uri) &&
			other.editKind === this.edit.editKind &&
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

