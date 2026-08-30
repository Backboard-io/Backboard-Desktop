/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, IReference, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../../base/common/map.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { basename, isEqual } from '../../../../../../base/common/resources.js';
import { assertType } from '../../../../../../base/common/types.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { TextEdit } from '../../../../../../editor/common/languages.js';
import { createTextBufferFactoryFromSnapshot } from '../../../../../../editor/common/model/textModel.js';
import { IEditorWorkerService } from '../../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { DefaultModelSHA1Computer } from '../../../../../../editor/common/services/modelService.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatModel, IChatResponseModel, IChatTextEditGroup } from '../../../common/model/chatModel.js';
import { IChatExternalEdit, IChatService } from '../../../common/chatService/chatService.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatRendererContent, IChatResponseViewModel, isResponseVM } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem, IChatListItemRendererOptions } from '../../chat.js';
import { CodeCompareBlockPart, ICodeCompareBlockData, ICodeCompareBlockDiffData } from './codeBlockPart.js';
import { IDisposableReference } from './chatCollections.js';
import { DiffEditorPool } from './chatContentCodePools.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatExternalEditContentPart, seedChatExternalEditRender } from './chatExternalEditContentPart.js';

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
	private readonly renderedAsFinal: boolean;
	private readonly renderedInBackboardTranscript: boolean;
	private readonly _compactDiffVisibilityObserver = this._register(new MutableDisposable<IDisposable>());
	private compactDiffStarted = false;

	constructor(
		chatTextEdit: IChatTextEditGroup,
		context: IChatContentPartRenderContext,
		rendererOptions: IChatListItemRendererOptions,
		diffEditorPool: DiffEditorPool,
		currentWidth: number,
		@ICodeCompareModelService private readonly codeCompareModelService: ICodeCompareModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorWorkerService private readonly editorWorkerService: IEditorWorkerService,
	) {
		super();
		this.renderedUri = chatTextEdit.uri;
		this.renderedEditCount = chatTextEdit.edits.reduce((count, group) => count + group.length, 0);
		this.renderedDone = chatTextEdit.done;
		const element = context.element;

		assertType(isResponseVM(element));
		this.renderedAsFinal = chatTextEdit.done === true || element.isComplete || element.isCanceled;
		this.renderedInBackboardTranscript = !!context.container.closest('.backboard-cursor-transcript');
		if (this.renderedInBackboardTranscript) {
			this._domNode = $('.chat-text-edit-compact-loading', undefined, this.renderedAsFinal
				? localize('chat.textEdit.loadingCompactDiff', "Loading file diff…")
				: localize('chat.textEdit.streamingCompactDiff', "Editing {0}…", basename(chatTextEdit.uri)));
			// Text edit groups are mutated for every streamed batch. Building the
			// preview here used to resolve both models, recompute and tokenize the
			// whole diff, and recreate its rows for every batch. Keep one lightweight
			// card while streaming, then render the full diff exactly once when the
			// edit (or response) is final.
			if (this.renderedAsFinal) {
				this.renderCompactDiffWhenNearViewport(element, chatTextEdit);
			}
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

	private renderCompactDiffWhenNearViewport(element: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): void {
		const targetWindow = this._domNode.ownerDocument.defaultView;
		if (!targetWindow?.IntersectionObserver) {
			this.startCompactDiffRender(element, chatTextEdit);
			return;
		}
		const observer = new targetWindow.IntersectionObserver(entries => {
			if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) {
				return;
			}
			this._compactDiffVisibilityObserver.clear();
			this.startCompactDiffRender(element, chatTextEdit);
		}, { rootMargin: '600px 0px' });
		observer.observe(this._domNode);
		this._compactDiffVisibilityObserver.value = toDisposable(() => observer.disconnect());
	}

	private startCompactDiffRender(element: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): void {
		if (this.compactDiffStarted || this._store.isDisposed) {
			return;
		}
		this.compactDiffStarted = true;
		void this.renderCompactDiff(element, chatTextEdit);
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
			const originalContent = originalModel.getValue();
			const modifiedContent = modifiedModel.getValue();
			// Mount the bounded preview before asking the editor worker for exact
			// mappings. The worker promise is shared with an early expansion, so a
			// completed edit performs at most one exact computation and never swaps
			// the card DOM when the counters arrive.
			const diffPromise = Promise.resolve().then(() => this.editorWorkerService.computeDiff(
				originalModel.uri,
				modifiedModel.uri,
				{ ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 1000 },
				'advanced',
			)).catch(() => null);
			const compactEdit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: chatTextEdit.uri,
				editKind: 'edit',
				beforeContentUri: originalModel.uri,
				afterContentUri: modifiedModel.uri,
			};
			seedChatExternalEditRender(compactEdit, {
				beforeContent: originalContent,
				afterContent: modifiedContent,
				changesPromise: diffPromise.then(diff => diff?.changes),
			});
			const compactPart = this._register(this.instantiationService.createInstance(ChatExternalEditContentPart, compactEdit));
			// The outer shell was just proven near the viewport. Mount the bounded
			// seeded preview directly instead of allocating a second observer and
			// waiting another frame for the replacement card.
			compactPart.showDiffPreview(false);
			this._register(compactPart.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
			this._domNode.replaceWith(compactPart.domNode);
			this._domNode = compactPart.domNode;
			this._onDidChangeHeight.fire();

			const diff = await diffPromise;
			if (this._store.isDisposed || !diff) {
				return;
			}
			const stats = diff.changes.reduce((result, change) => ({
				added: result.added + change.modified.length,
				removed: result.removed + change.original.length,
			}), { added: 0, removed: 0 });
			compactPart.applyResolvedDiff(diff.changes, stats);
			this._onDidChangeDiff.fire(stats);
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

	hasSameContent(other: IChatRendererContent, _content: IChatRendererContent[], element: ChatTreeItem): boolean {
		if (other.kind !== 'textEditGroup' || !isEqual(other.uri, this.renderedUri)) {
			return false;
		}

		if (!this.renderedInBackboardTranscript) {
			return other.edits.reduce((count, group) => count + group.length, 0) === this.renderedEditCount
				&& other.done === this.renderedDone;
		}

		const shouldRenderAsFinal = other.done === true || (isResponseVM(element) && (element.isComplete || element.isCanceled));
		if (shouldRenderAsFinal !== this.renderedAsFinal) {
			return false;
		}

		// While streaming, the shell is intentionally stable across edit batches.
		// Once final, compare the captured shape so unrelated response updates do
		// not rebuild the completed diff UI.
		return !shouldRenderAsFinal
			|| other.edits.reduce((count, group) => count + group.length, 0) === this.renderedEditCount;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}

interface IFinalizedTextEditGroupIndex {
	readonly groupsByUri: ResourceMap<readonly IChatTextEditGroup[]>;
	readonly invalidation: IDisposable;
}

/**
 * Indexes the edit groups visible at a finalized response once, instead of
 * walking the entire request history independently for every file card.
 * Cached entries retain the live group objects so applied-state mutations are
 * observed at lookup time; any target-response change invalidates membership.
 *
 * @internal Exported for focused traversal/invalidation regression tests.
 */
export class TextEditGroupHistoryIndex {
	private readonly finalized = new WeakMap<IChatResponseModel, IFinalizedTextEditGroupIndex>();

	getUnappliedGroups(chatModel: IChatModel, targetResponse: IChatResponseModel, uri: URI, cacheFinalized: boolean): readonly IChatTextEditGroup[] {
		let groupsByUri: ResourceMap<readonly IChatTextEditGroup[]>;
		if (cacheFinalized) {
			const cached = this.finalized.get(targetResponse);
			if (cached) {
				groupsByUri = cached.groupsByUri;
			} else {
				groupsByUri = this.buildIndex(chatModel, targetResponse);
				const invalidation = targetResponse.onDidChange(() => {
					const current = this.finalized.get(targetResponse);
					if (current) {
						this.finalized.delete(targetResponse);
						current.invalidation.dispose();
					}
				});
				const entry = { groupsByUri, invalidation };
				this.finalized.set(targetResponse, entry);
			}
		} else {
			groupsByUri = this.buildIndex(chatModel, targetResponse);
		}

		const groups = groupsByUri.get(uri) ?? [];
		return groups.filter(group => !group.state?.applied);
	}

	private buildIndex(chatModel: IChatModel, targetResponse: IChatResponseModel): ResourceMap<readonly IChatTextEditGroup[]> {
		const mutableGroupsByUri = new ResourceMap<IChatTextEditGroup[]>();
		for (const request of chatModel.getRequests()) {
			if (!request.response) {
				continue;
			}
			for (const item of request.response.response.value) {
				if (item.kind !== 'textEditGroup') {
					continue;
				}
				let groups = mutableGroupsByUri.get(item.uri);
				if (!groups) {
					groups = [];
					mutableGroupsByUri.set(item.uri, groups);
				}
				groups.push(item);
			}
			if (request.response === targetResponse) {
				break;
			}
		}
		return mutableGroupsByUri;
	}
}

class CodeCompareModelService implements ICodeCompareModelService {
	private readonly editGroupHistory = new TextEditGroupHistoryIndex();

	declare readonly _serviceBrand: undefined;

	constructor(
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@IChatService private readonly chatService: IChatService,
	) { }

	async createModel(element: IChatResponseViewModel, chatTextEdit: IChatTextEditGroup): Promise<IReference<{ originalSha1: string; original: IResolvedTextEditorModel; modified: IResolvedTextEditorModel }>> {

		const original = await this.textModelService.createModelReference(chatTextEdit.uri);
		let modifiedModel: ReturnType<IModelService['createModel']> | undefined;
		let modified: IReference<IResolvedTextEditorModel> | undefined;
		try {
			modifiedModel = this.modelService.createModel(
				createTextBufferFactoryFromSnapshot(original.object.textEditorModel.createSnapshot()),
				{ languageId: original.object.textEditorModel.getLanguageId(), onDidChange: Event.None },
				URI.from({ scheme: Schemas.vscodeChatCodeBlock, path: chatTextEdit.uri.path, query: generateUuid() }),
				false
			);
			modified = await this.textModelService.createModelReference(modifiedModel.uri);

			const d = toDisposable(() => {
				original.dispose();
				modified!.dispose();
			});

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
			const editGroups = this.editGroupHistory.getUnappliedGroups(
				chatModel,
				element.model,
				chatTextEdit.uri,
				element.isComplete || element.isCanceled,
			);
			for (const item of editGroups) {
				for (const group of item.edits) {
					modified.object.textEditorModel.pushEditOperations(null, group.map(TextEdit.asEditOperation), () => null);
				}
			}

			return {
				object: {
					originalSha1,
					original: original.object,
					modified: modified.object
				},
				dispose() {
					d.dispose();
				},
			};
		} catch (error) {
			original.dispose();
			if (modified) {
				modified.dispose();
			} else if (modifiedModel && !modifiedModel.isDisposed()) {
				modifiedModel.dispose();
			}
			throw error;
		}
	}
}

registerSingleton(ICodeCompareModelService, CodeCompareModelService, InstantiationType.Delayed);
