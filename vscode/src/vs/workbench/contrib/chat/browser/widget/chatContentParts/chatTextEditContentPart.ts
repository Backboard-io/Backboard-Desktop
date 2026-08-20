/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, IReference, RefCountedDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { assertType } from '../../../../../../base/common/types.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { ISingleEditOperation } from '../../../../../../editor/common/core/editOperation.js';
import { linesDiffComputers } from '../../../../../../editor/common/diff/linesDiffComputers.js';
import { TextEdit } from '../../../../../../editor/common/languages.js';
import { createTextBufferFactoryFromSnapshot } from '../../../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { DefaultModelSHA1Computer } from '../../../../../../editor/common/services/modelService.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatProgressRenderableResponseContent, IChatTextEditGroup } from '../../../common/model/chatModel.js';
import { IChatExternalEdit, IChatService } from '../../../common/chatService/chatService.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatResponseViewModel, isResponseVM } from '../../../common/model/chatViewModel.js';
import { IChatListItemRendererOptions } from '../../chat.js';
import { CodeCompareBlockPart, ICodeCompareBlockData, ICodeCompareBlockDiffData } from './codeBlockPart.js';
import { IDisposableReference } from './chatCollections.js';
import { DiffEditorPool } from './chatContentCodePools.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatExternalEditContentPart } from './chatExternalEditContentPart.js';

const $ = dom.$;

export const ICodeCompareModelService = createDecorator<ICodeCompareModelService>('ICodeCompareModelService');

export interface ICodeCompareModelService {
	_serviceBrand: undefined;
	createModel(response: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): Promise<IReference<{ originalSha1: string; original: IResolvedTextEditorModel; modified: IResolvedTextEditorModel }>>;
}

export class ChatTextEditContentPart extends Disposable implements IChatContentPart {
	private _domNode: HTMLElement;
	get domNode(): HTMLElement { return this._domNode; }
	private comparePart: IDisposableReference<CodeCompareBlockPart> | undefined;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;
	private readonly _onDidChangeDiff = this._register(new Emitter<IEditSessionDiffStats>());
	readonly onDidChangeDiff = this._onDidChangeDiff.event;
	private readonly renderedUri: URI;
	private readonly renderedEditCount: number;
	private readonly renderedDone: boolean | undefined;

	constructor(
		chatTextEdit: IChatTextEditGroup,
		context: IChatContentPartRenderContext,
		rendererOptions: IChatListItemRendererOptions,
		diffEditorPool: DiffEditorPool,
		currentWidth: number,
		@ICodeCompareModelService private readonly codeCompareModelService: ICodeCompareModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.renderedUri = chatTextEdit.uri;
		this.renderedEditCount = chatTextEdit.edits.reduce((count, group) => count + group.length, 0);
		this.renderedDone = chatTextEdit.done;
		const element = context.element;

		assertType(isResponseVM(element));
		if (context.container.closest('.backboard-cursor-transcript')) {
			this._domNode = $('.chat-text-edit-compact-loading', undefined, localize('chat.textEdit.loadingCompactDiff', "Loading file diff…"));
			void this.renderCompactDiff(element, chatTextEdit);
			return;
		}

		// TODO@jrieken move this into the CompareCodeBlock and properly say what kind of changes happen
		if (rendererOptions.renderTextEditsAsSummary?.(chatTextEdit.uri)) {
			if (element.response.value.every(item => item.kind === 'textEditGroup')) {
				this._domNode = $('.interactive-edits-summary', undefined, !element.isComplete
					? ''
					: element.isCanceled
						? localize('edits0', "Making changes was aborted.")
						: localize('editsSummary', "Made changes."));
			} else {
				this._domNode = $('div');
			}

			// TODO@roblourens this case is now handled outside this Part in ChatListRenderer, but can it be cleaned up?
			// return;
		} else {


			const cts = new CancellationTokenSource();

			let isDisposed = false;
			this._register(toDisposable(() => {
				isDisposed = true;
				cts.dispose(true);
			}));

			this.comparePart = this._register(diffEditorPool.get());

			const data: ICodeCompareBlockData = {
				element,
				edit: chatTextEdit,
				diffData: (async () => {

					const ref = await this.codeCompareModelService.createModel(element, chatTextEdit);

					if (isDisposed) {
						ref.dispose();
						return;
					}

					this._register(ref);

					return {
						modified: ref.object.modified.textEditorModel,
						original: ref.object.original.textEditorModel,
						originalSha1: ref.object.originalSha1
					} satisfies ICodeCompareBlockDiffData;
				})()
			};
			this.comparePart.object.render(data, currentWidth, cts.token);

			this._domNode = this.comparePart.object.element;
		}
	}

	/**
	 * The transcript does not need a second embedded editor. Reuse the same
	 * compact, unified card as agent-host edits while keeping the pooled Monaco
	 * compare editor for every other ChatWidget host.
	 */
	private async renderCompactDiff(element: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): Promise<void> {
		try {
			const ref = await this.codeCompareModelService.createModel(element, chatTextEdit);
			if (this._store.isDisposed) {
				ref.dispose();
				return;
			}
			this._register(ref);
			const originalModel = ref.object.original.textEditorModel;
			const modifiedModel = ref.object.modified.textEditorModel;
			const originalLines = originalModel.getValue().split('\n');
			const modifiedLines = modifiedModel.getValue().split('\n');
			const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
				ignoreTrimWhitespace: false,
				computeMoves: false,
				maxComputationTimeMs: 1000,
			});
			const stats = diff.changes.reduce((result, change) => ({
				added: result.added + change.modified.length,
				removed: result.removed + change.original.length,
			}), { added: 0, removed: 0 });
			const compactEdit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: chatTextEdit.uri,
				editKind: 'edit',
				beforeContentUri: originalModel.uri,
				afterContentUri: modifiedModel.uri,
				diff: stats,
			};
			const compactPart = this._register(this.instantiationService.createInstance(ChatExternalEditContentPart, compactEdit));
			compactPart.showDiffPreview();
			this._register(compactPart.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
			this._domNode.replaceWith(compactPart.domNode);
			this._domNode = compactPart.domNode;
			this._onDidChangeDiff.fire(stats);
			this._onDidChangeHeight.fire();
		} catch {
			if (!this._store.isDisposed) {
				this._domNode.textContent = localize('chat.textEdit.compactDiffUnavailable', "File diff unavailable");
				this._onDidChangeHeight.fire();
			}
		}
	}

	layout(width: number): void {
		this.comparePart?.object.layout(width);
	}

	hasSameContent(other: IChatProgressRenderableResponseContent): boolean {
		return other.kind === 'textEditGroup'
			&& isEqual(other.uri, this.renderedUri)
			&& other.edits.reduce((count, group) => count + group.length, 0) === this.renderedEditCount
			&& other.done === this.renderedDone;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}

class CodeCompareModelService implements ICodeCompareModelService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@IChatService private readonly chatService: IChatService,
	) { }

	async createModel(element: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): Promise<IReference<{ originalSha1: string; original: IResolvedTextEditorModel; modified: IResolvedTextEditorModel }>> {

		const original = await this.textModelService.createModelReference(chatTextEdit.uri);

		const modified = await this.textModelService.createModelReference((this.modelService.createModel(
			createTextBufferFactoryFromSnapshot(original.object.textEditorModel.createSnapshot()),
			{ languageId: original.object.textEditorModel.getLanguageId(), onDidChange: Event.None },
			URI.from({ scheme: Schemas.vscodeChatCodeBlock, path: chatTextEdit.uri.path, query: generateUuid() }),
			false
		)).uri);

		const d = new RefCountedDisposable(toDisposable(() => {
			original.dispose();
			modified.dispose();
		}));

		// compute the sha1 of the original model
		let originalSha1: string = '';
		if (chatTextEdit.state) {
			originalSha1 = chatTextEdit.state.sha1;
		} else {
			const sha1 = new DefaultModelSHA1Computer();
			if (sha1.canComputeSHA1(original.object.textEditorModel)) {
				originalSha1 = sha1.computeSHA1(original.object.textEditorModel);
				chatTextEdit.state = { sha1: originalSha1, applied: 0 };
			}
		}

		// apply edits to the "modified" model
		const chatModel = this.chatService.getSession(element.sessionResource)!;
		const editGroups: ISingleEditOperation[][] = [];
		for (const request of chatModel.getRequests()) {
			if (!request.response) {
				continue;
			}
			for (const item of request.response.response.value) {
				if (item.kind !== 'textEditGroup' || item.state?.applied || !isEqual(item.uri, chatTextEdit.uri)) {
					continue;
				}
				for (const group of item.edits) {
					const edits = group.map(TextEdit.asEditOperation);
					editGroups.push(edits);
				}
			}
			if (request.response === element.model) {
				break;
			}
		}
		for (const edits of editGroups) {
			modified.object.textEditorModel.pushEditOperations(null, edits, () => null);
		}

		// self-acquire a reference to diff models for a short while
		// because streaming usually means we will be using the original-model
		// repeatedly and thereby also should reuse the modified-model and just
		// update it with more edits
		d.acquire();
		setTimeout(() => d.release(), 5000);

		return {
			object: {
				originalSha1,
				original: original.object,
				modified: modified.object
			},
			dispose() {
				d.release();
			},
		};
	}
}

registerSingleton(ICodeCompareModelService, CodeCompareModelService, InstantiationType.Delayed);
