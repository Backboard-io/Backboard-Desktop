/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatExternalEdit, IChatService } from '../../common/chatService/chatService.js';
import { getLatestTurnEditedFiles } from '../../common/model/chatViewModel.js';
import { ChatExternalEditContentPart } from './chatContentParts/chatExternalEditContentPart.js';

const $ = dom.$;

/** Command ID is inlined as a string to avoid importing from vs/sessions into vs/workbench. */
const OPEN_REVIEW_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openReview';

function editedFilesKey(editedFiles: readonly IChatExternalEdit[]): string {
	return editedFiles.map(edit => `${edit.uri.toString()}:${edit.editKind}:${edit.diff?.added ?? 0}:${edit.diff?.removed ?? 0}`).join('|');
}

/**
 * Review bar for the latest completed turn's edits, pinned above the composer
 * (rather than scrolling away inline with the transcript). Renders as a
 * single collapsed summary row — "N files changed +X −Y · Review" — that
 * expands to the per-file pills with inline diffs. Reuses
 * {@link ChatExternalEditContentPart} per file so the expanded rows are the
 * same pill + diff card shown inline while the turn streamed.
 */
export class ChatEditedFilesWidget extends Disposable {
	public readonly domNode: HTMLElement;

	private readonly _editParts = this._register(new DisposableStore());
	private _fileParts: ChatExternalEditContentPart[] = [];
	private _lastKey: string | undefined;
	/** Collapsed by default; the user's choice sticks across re-renders. */
	private _collapsed = true;
	private _chevron: HTMLElement | undefined;
	private _header: HTMLElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();
		this.domNode = $('.chat-edited-files-widget');
		this.domNode.style.display = 'none';
	}

	/**
	 * Recomputes and re-renders from the given session's latest completed
	 * turn. Cheap to call on every list refresh: skips rebuilding the DOM
	 * when the edited-file set hasn't changed since the last render.
	 */
	render(sessionResource: URI | undefined): void {
		const editedFiles = sessionResource ? this._getLatestTurnEditedFiles(sessionResource) : undefined;
		const key = editedFiles ? editedFilesKey(editedFiles) : undefined;
		if (key === this._lastKey) {
			return;
		}
		this._lastKey = key;

		this._editParts.clear();
		this._fileParts = [];
		dom.clearNode(this.domNode);

		if (!editedFiles || editedFiles.length === 0) {
			this.domNode.style.display = 'none';
			return;
		}

		this.domNode.style.display = '';

		const header = dom.append(this.domNode, $('.chat-edited-files-header'));
		this._header = header;

		const chevron = dom.append(header, $('span.codicon.chat-edited-files-chevron'));
		this._chevron = chevron;

		const summaryText = dom.append(header, $('span.chat-edited-files-summary-text'));
		summaryText.textContent = editedFiles.length === 1
			? localize('chatEditedFiles.oneFileChanged', '1 file changed')
			: localize('chatEditedFiles.manyFilesChanged', '{0} files changed', editedFiles.length);

		let added = 0, removed = 0;
		for (const edit of editedFiles) {
			added += edit.diff?.added ?? 0;
			removed += edit.diff?.removed ?? 0;
		}
		const counts = dom.append(header, $('span.chat-edited-files-counts'));
		if (added > 0) {
			dom.append(counts, $('span.chat-edited-files-added', {}, `+${added}`));
		}
		if (removed > 0) {
			dom.append(counts, $('span.chat-edited-files-removed', {}, `-${removed}`));
		}

		const reviewBtn = dom.append(header, $('button.chat-edited-files-review-btn')) as HTMLButtonElement;
		reviewBtn.type = 'button';
		dom.append(reviewBtn, $('span', {}, localize('chatEditedFiles.review', 'Review')));
		this._editParts.add(dom.addDisposableListener(reviewBtn, dom.EventType.CLICK, async e => {
			dom.EventHelper.stop(e, true);
			await this._openReview(editedFiles);
		}));

		const list = dom.append(this.domNode, $('.chat-edited-files-list'));
		for (const edit of editedFiles) {
			const part = this._editParts.add(this.instantiationService.createInstance(ChatExternalEditContentPart, edit));
			this._fileParts.push(part);
			list.appendChild(part.domNode);
		}

		// The whole header toggles the file list; buttons inside keep their
		// own behavior.
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		header.setAttribute('aria-label', localize('chatEditedFiles.toggle', 'Toggle changed files'));
		this._editParts.add(dom.addDisposableListener(header, dom.EventType.CLICK, e => {
			if ((e.target as HTMLElement).closest('button')) {
				return;
			}
			this._setCollapsed(!this._collapsed);
		}));
		this._editParts.add(dom.addDisposableListener(header, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._setCollapsed(!this._collapsed);
			}
		}));

		this._applyCollapsed();
	}

	private _setCollapsed(collapsed: boolean): void {
		this._collapsed = collapsed;
		this._applyCollapsed();
	}

	private _applyCollapsed(): void {
		this.domNode.classList.toggle('collapsed', this._collapsed);
		this._chevron?.classList.toggle('codicon-chevron-right', this._collapsed);
		this._chevron?.classList.toggle('codicon-chevron-down', !this._collapsed);
		this._header?.setAttribute('aria-expanded', String(!this._collapsed));
		if (!this._collapsed && this._fileParts.length === 1) {
			// A single-file change expands straight to its diff — the file
			// row alone would just repeat the summary line.
			this._fileParts[0].expandDiffBody();
		}
	}

	/**
	 * Opens the review surface: the right-workbench review in the sessions
	 * window, or the standard multi-diff editor over the same files when that
	 * command isn't available (regular workbench window).
	 */
	private async _openReview(editedFiles: readonly IChatExternalEdit[]): Promise<void> {
		if (CommandsRegistry.getCommand(OPEN_REVIEW_COMMAND_ID)) {
			await this.commandService.executeCommand(OPEN_REVIEW_COMMAND_ID);
			return;
		}
		await this.commandService.executeCommand('_workbench.openMultiDiffEditor', {
			title: localize('chatEditedFiles.reviewTitle', 'Review Changes'),
			resources: editedFiles.map(edit => ({
				originalUri: edit.beforeContentUri,
				modifiedUri: edit.afterContentUri ?? (edit.editKind !== 'delete' ? edit.uri : undefined),
			})).filter(r => r.originalUri || r.modifiedUri),
		});
	}

	/** Hides the widget, e.g. when a new turn starts or the session changes. */
	clear(): void {
		this.render(undefined);
	}

	private _getLatestTurnEditedFiles(sessionResource: URI): readonly IChatExternalEdit[] | undefined {
		for (const model of this.chatService.chatModels.get()) {
			if (isEqual(model.sessionResource, sessionResource)) {
				return getLatestTurnEditedFiles(model);
			}
		}
		return undefined;
	}
}
