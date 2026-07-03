/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatTurnEditedFiles.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IChatTurnEditedFilesSummaryPart, IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatExternalEditContentPart } from './chatExternalEditContentPart.js';

const $ = dom.$;

/** Command ID is inlined as a string to avoid importing from vs/sessions into vs/workbench. */
const OPEN_REVIEW_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openReview';

/**
 * End-of-turn recap of every file the turn touched. Reuses
 * {@link ChatExternalEditContentPart} per file so the recap is a literal
 * repeat of the same pill + diff card shown inline during the turn — not a
 * separate, plainer "file name" list.
 */
export class ChatTurnEditedFilesContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private readonly _editParts = this._register(new DisposableStore());

	constructor(
		private readonly content: IChatTurnEditedFilesSummaryPart,
		context: IChatContentPartRenderContext,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.domNode = this._buildDom(context);
	}

	private _buildDom(context: IChatContentPartRenderContext): HTMLElement {
		const { editedFiles } = this.content;
		const container = $('.chat-turn-edited-files');

		const header = dom.append(container, $('.chat-turn-edited-files-header'));

		const editIcon = dom.append(header, $('span.codicon'));
		editIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));

		const summaryText = dom.append(header, $('span.chat-turn-edited-files-summary-text'));
		summaryText.textContent = editedFiles.length === 1
			? localize('chatTurnEditedFiles.oneFile', 'Edited 1 file')
			: localize('chatTurnEditedFiles.manyFiles', 'Edited {0} files', editedFiles.length);

		const reviewBtn = dom.append(header, $('button.chat-turn-edited-files-review-btn')) as HTMLButtonElement;
		reviewBtn.type = 'button';
		const reviewIcon = dom.append(reviewBtn, $('span.codicon'));
		reviewIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffMultiple));
		dom.append(reviewBtn, $('span', {}, localize('chatTurnEditedFiles.reviewChanges', 'Review Changes')));
		this._register(dom.addDisposableListener(reviewBtn, dom.EventType.CLICK, async e => {
			dom.EventHelper.stop(e, true);
			await this.commandService.executeCommand(OPEN_REVIEW_COMMAND_ID);
		}));

		// One recap row per file, each the exact same pill + expandable diff
		// card rendered inline during the turn (file icon, filename,
		// +added/-removed, and a chevron that opens the unified diff).
		const list = dom.append(container, $('.chat-turn-edited-files-list'));
		for (const edit of editedFiles) {
			const part = this.instantiationService.createInstance(ChatExternalEditContentPart, edit, context);
			this._editParts.add(part);
			list.appendChild(part.domNode);
		}

		return container;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'turnEditedFilesSummary') {
			return false;
		}
		if (other.editedFiles.length !== this.content.editedFiles.length) {
			return false;
		}
		return other.editedFiles.every((edit, i) => {
			const mine = this.content.editedFiles[i];
			return edit.uri.toString() === mine.uri.toString()
				&& (edit.diff?.added ?? 0) === (mine.diff?.added ?? 0)
				&& (edit.diff?.removed ?? 0) === (mine.diff?.removed ?? 0);
		});
	}
}
