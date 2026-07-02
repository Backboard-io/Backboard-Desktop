/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatTurnEditedFiles.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Iterable } from '../../../../../../base/common/iterator.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { FileKind } from '../../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { getIconClasses } from '../../../../../../editor/common/services/getIconClasses.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { IEditSessionEntryDiff } from '../../../common/editing/chatEditingService.js';
import { IChatTurnEditedFilesSummaryPart, IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { IChatContentPart } from './chatContentParts.js';

const $ = dom.$;

/** Command ID is inlined as a string to avoid importing from vs/sessions into vs/workbench. */
const OPEN_REVIEW_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openReview';

export class ChatTurnEditedFilesContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private _isExpanded = false;
	private readonly fileDiffsObservable: IObservable<readonly IEditSessionEntryDiff[]>;
	private readonly summaryText: HTMLElement;
	private readonly diffText: HTMLElement;
	private readonly actions: HTMLElement;
	private readonly reviewBtn: HTMLButtonElement;
	private readonly list: HTMLElement;
	private readonly toggle: HTMLElement;
	private readonly labelRow: HTMLElement;

	constructor(
		private readonly content: IChatTurnEditedFilesSummaryPart,
		@ICommandService private readonly commandService: ICommandService,
		@IChatService private readonly chatService: IChatService,
		@ILabelService private readonly labelService: ILabelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();

		this.fileDiffsObservable = this.chatService.chatModels
			.map(models => Iterable.find(models, m => isEqual(m.sessionResource, content.sessionResource)))
			.map(model => model?.editingSession?.getDiffsForFilesInRequest(content.requestId))
			.map((diffs, reader) => diffs?.read(reader) ?? []);

		this.domNode = this._buildDom();
	}

	private _buildDom(): HTMLElement {
		const container = $('.chat-turn-edited-files');
		container.style.display = 'none';

		this.labelRow = dom.append(container, $('.chat-turn-edited-files-label'));

		// Edit icon
		const editIcon = dom.append(this.labelRow, $('span.codicon'));
		editIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));

		// Summary text + optional expand toggle
		this.summaryText = dom.append(this.labelRow, $('span.chat-turn-edited-files-summary-text'));
		this.toggle = dom.append(this.labelRow, $('span.codicon.chat-turn-edited-files-toggle'));
		this.toggle.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		this.diffText = dom.append(this.labelRow, $('span.chat-turn-edited-files-diff'));

		// File list (hidden until expanded)
		this.list = dom.append(container, $('.chat-turn-edited-files-list'));

		this._register(dom.addDisposableListener(this.labelRow, dom.EventType.CLICK, () => {
			if (this.toggle.style.display === 'none') {
				return;
			}

			this._isExpanded = !this._isExpanded;
			container.classList.toggle('expanded', this._isExpanded);
		}));

		// "Review Changes" button
		this.actions = dom.append(container, $('.chat-turn-edited-files-actions'));
		this.reviewBtn = dom.append(this.actions, $('button.chat-turn-edited-files-review-btn')) as HTMLButtonElement;
		this.reviewBtn.type = 'button';

		const reviewIcon = dom.append(this.reviewBtn, $('span.codicon'));
		reviewIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffMultiple));

		dom.append(this.reviewBtn, $('span', {}, localize('chatTurnEditedFiles.reviewChanges', 'Review Changes')));

		this._register(dom.addDisposableListener(this.reviewBtn, dom.EventType.CLICK, async (e) => {
			dom.EventHelper.stop(e, true);
			await this.commandService.executeCommand(OPEN_REVIEW_COMMAND_ID);
		}));

		this._register(autorun(reader => {
			this._renderDiffs(container, this.fileDiffsObservable.read(reader));
		}));

		return container;
	}

	private _renderDiffs(container: HTMLElement, requestDiffs: readonly IEditSessionEntryDiff[]): void {
		const seen = new Set<string>();
		const uniqueUris: URI[] = [];
		let added = 0;
		let removed = 0;

		for (const diff of requestDiffs) {
			added += diff.added;
			removed += diff.removed;

			const key = diff.modifiedURI.toString();
			if (!seen.has(key)) {
				seen.add(key);
				uniqueUris.push(diff.modifiedURI);
			}
		}

		if (uniqueUris.length === 0) {
			this._isExpanded = false;
			container.classList.remove('expanded');
			container.style.display = 'none';
			return;
		}

		container.style.display = '';

		if (uniqueUris.length === 1) {
			this.summaryText.textContent = localize(
				'chatTurnEditedFiles.oneFile',
				'Edited {0}',
				this.labelService.getUriBasenameLabel(uniqueUris[0])
			);
		} else {
			this.summaryText.textContent = localize(
				'chatTurnEditedFiles.manyFiles',
				'Edited {0} files',
				uniqueUris.length
			);
		}

		this.toggle.style.display = uniqueUris.length > 1 ? '' : 'none';
		this.labelRow.classList.toggle('chat-turn-edited-files-label-clickable', uniqueUris.length > 1);

		dom.clearNode(this.diffText);
		dom.append(this.diffText, $('span.chat-turn-edited-files-added', {}, `+${added}`));
		dom.append(this.diffText, $('span.chat-turn-edited-files-removed', {}, `-${removed}`));

		dom.clearNode(this.list);
		for (const uri of uniqueUris) {
			const item = dom.append(this.list, $('.chat-turn-edited-files-list-item'));
			const fileIcon = dom.append(item, $('span.file-icon'));
			const iconClasses = getIconClasses(this.modelService, this.languageService, uri, FileKind.FILE);
			fileIcon.classList.add(...iconClasses, 'show-file-icons');
			dom.append(item, $('span', {}, this.labelService.getUriBasenameLabel(uri)));
		}

		if (uniqueUris.length <= 1 && this._isExpanded) {
			this._isExpanded = false;
			container.classList.remove('expanded');
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'turnEditedFilesSummary') {
			return false;
		}
		return other.requestId === this.content.requestId && isEqual(other.sessionResource, this.content.sessionResource);
	}
}
