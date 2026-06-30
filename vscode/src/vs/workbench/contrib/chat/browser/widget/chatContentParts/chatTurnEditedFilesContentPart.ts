/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatTurnEditedFiles.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { FileKind } from '../../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { getIconClasses } from '../../../../../../editor/common/services/getIconClasses.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IChatTurnEditedFilesSummaryPart, IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { IChatContentPart } from './chatContentParts.js';

const $ = dom.$;

/** Command ID is inlined as a string to avoid importing from vs/sessions into vs/workbench. */
const OPEN_REVIEW_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openReview';

export class ChatTurnEditedFilesContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private _isExpanded = false;

	constructor(
		private readonly content: IChatTurnEditedFilesSummaryPart,
		@ICommandService private readonly commandService: ICommandService,
		@ILabelService private readonly labelService: ILabelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();

		this.domNode = this._buildDom();
	}

	private _buildDom(): HTMLElement {
		const { editedUris } = this.content;
		const container = $('.chat-turn-edited-files');

		const labelRow = dom.append(container, $('.chat-turn-edited-files-label'));

		// Edit icon
		const editIcon = dom.append(labelRow, $('span.codicon'));
		editIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));

		// Summary text + optional expand toggle
		const summaryText = dom.append(labelRow, $('span.chat-turn-edited-files-summary-text'));

		if (editedUris.length === 1) {
			summaryText.textContent = localize(
				'chatTurnEditedFiles.oneFile',
				'Edited {0}',
				this.labelService.getUriBasenameLabel(editedUris[0])
			);
		} else {
			summaryText.textContent = localize(
				'chatTurnEditedFiles.manyFiles',
				'Edited {0} files',
				editedUris.length
			);

			// Toggle chevron for multi-file expand/collapse
			const toggle = dom.append(labelRow, $('span.codicon.chat-turn-edited-files-toggle'));
			toggle.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));

			// File list (hidden until expanded)
			const list = dom.append(container, $('.chat-turn-edited-files-list'));
			for (const uri of editedUris) {
				const item = dom.append(list, $('.chat-turn-edited-files-list-item'));
				const fileIcon = dom.append(item, $('span.file-icon'));
				const iconClasses = getIconClasses(this.modelService, this.languageService, uri, FileKind.FILE);
				fileIcon.classList.add(...iconClasses, 'show-file-icons');
				dom.append(item, $('span', {}, this.labelService.getUriBasenameLabel(uri)));
			}

			this._register(dom.addDisposableListener(labelRow, dom.EventType.CLICK, () => {
				this._isExpanded = !this._isExpanded;
				container.classList.toggle('expanded', this._isExpanded);
			}));
		}

		// "Review Changes" button
		const actions = dom.append(container, $('.chat-turn-edited-files-actions'));
		const reviewBtn = dom.append(actions, $('button.chat-turn-edited-files-review-btn')) as HTMLButtonElement;
		reviewBtn.type = 'button';

		const reviewIcon = dom.append(reviewBtn, $('span.codicon'));
		reviewIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffMultiple));

		dom.append(reviewBtn, $('span', {}, localize('chatTurnEditedFiles.reviewChanges', 'Review Changes')));

		this._register(dom.addDisposableListener(reviewBtn, dom.EventType.CLICK, async (e) => {
			dom.EventHelper.stop(e, true);
			await this.commandService.executeCommand(OPEN_REVIEW_COMMAND_ID);
		}));

		return container;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'turnEditedFilesSummary') {
			return false;
		}
		if (other.editedUris.length !== this.content.editedUris.length) {
			return false;
		}
		return other.editedUris.every((uri, i) => uri.toString() === this.content.editedUris[i].toString());
	}
}
