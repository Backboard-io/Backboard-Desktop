/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Event } from '../../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatTurnEditedFilesContentPart } from '../../../../browser/widget/chatContentParts/chatTurnEditedFilesContentPart.js';
import { DiffEditorPool, EditorPool } from '../../../../browser/widget/chatContentParts/chatContentCodePools.js';
import { IChatContentPartRenderContext, InlineTextModelCollection } from '../../../../browser/widget/chatContentParts/chatContentParts.js';
import { IChatExternalEdit } from '../../../../common/chatService/chatService.js';
import { IChatResponseViewModel } from '../../../../common/model/chatViewModel.js';

suite('ChatTurnEditedFilesContentPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;

	function createMockRenderContext(): IChatContentPartRenderContext {
		const mockElement: Partial<IChatResponseViewModel> = {
			isComplete: true,
			id: 'test-response-id',
			sessionResource: URI.parse('chat-session://test/session1'),
			get model() { return {} as IChatResponseViewModel['model']; }
		};
		return {
			element: mockElement as IChatResponseViewModel,
			inlineTextModels: {} as InlineTextModelCollection,
			elementIndex: 0,
			container: mainWindow.document.createElement('div'),
			content: [],
			contentIndex: 0,
			editorPool: {} as EditorPool,
			codeBlockStartIndex: 0,
			treeStartIndex: 0,
			diffEditorPool: {} as DiffEditorPool,
			currentWidth: observableValue('currentWidth', 500),
			onDidChangeVisibility: Event.None
		};
	}

	function createEdit(path: string, added: number, removed: number): IChatExternalEdit {
		return {
			kind: 'externalEdit',
			uri: URI.file(path),
			editKind: 'edit',
			diff: { added, removed },
			beforeContentUri: URI.parse(`chat-edit://before${path}`),
			afterContentUri: URI.parse(`chat-edit://after${path}`),
		};
	}

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiationService = workbenchInstantiationService(undefined, store);
	});

	teardown(() => {
		disposables.dispose();
	});

	test('renders one recap row per file, each with its own icon/name/diff', () => {
		const part = store.add(instantiationService.createInstance(
			ChatTurnEditedFilesContentPart,
			{ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 3, 1), createEdit('/project/b.ts', 10, 0)] },
			createMockRenderContext()
		));
		mainWindow.document.body.appendChild(part.domNode);
		disposables.add(toDisposable(() => part.domNode.remove()));

		assert.deepStrictEqual({
			headerText: part.domNode.querySelector('.chat-turn-edited-files-summary-text')?.textContent,
			hasReviewButton: !!part.domNode.querySelector('.chat-turn-edited-files-review-btn'),
			rowCount: part.domNode.querySelectorAll('.chat-turn-edited-files-list > .chat-codeblock-pill-container').length,
			addedCounts: Array.from(part.domNode.querySelectorAll('.label-added')).map(el => el.textContent),
			removedCounts: Array.from(part.domNode.querySelectorAll('.label-removed')).map(el => el.textContent),
		}, {
			headerText: 'Edited 2 files',
			hasReviewButton: true,
			rowCount: 2,
			addedCounts: ['+3', '+10'],
			removedCounts: ['-1', '-0'],
		});
	});

	test('single file uses singular header text', () => {
		const part = store.add(instantiationService.createInstance(
			ChatTurnEditedFilesContentPart,
			{ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 1, 0)] },
			createMockRenderContext()
		));
		mainWindow.document.body.appendChild(part.domNode);
		disposables.add(toDisposable(() => part.domNode.remove()));

		assert.strictEqual(part.domNode.querySelector('.chat-turn-edited-files-summary-text')?.textContent, 'Edited 1 file');
	});

	test('hasSameContent compares file list and diff counts', () => {
		const part = store.add(instantiationService.createInstance(
			ChatTurnEditedFilesContentPart,
			{ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 3, 1)] },
			createMockRenderContext()
		));
		mainWindow.document.body.appendChild(part.domNode);
		disposables.add(toDisposable(() => part.domNode.remove()));

		assert.deepStrictEqual({
			sameFileSameDiff: part.hasSameContent({ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 3, 1)] }, [], {} as never),
			sameFileDifferentDiff: part.hasSameContent({ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 4, 1)] }, [], {} as never),
			differentFileCount: part.hasSameContent({ kind: 'turnEditedFilesSummary', editedFiles: [createEdit('/project/a.ts', 3, 1), createEdit('/project/b.ts', 1, 1)] }, [], {} as never),
			otherKind: part.hasSameContent({ kind: 'changesSummary', requestId: 'r', sessionResource: URI.parse('chat-session://test/session1') }, [], {} as never),
		}, {
			sameFileSameDiff: true,
			sameFileDifferentDiff: false,
			differentFileCount: false,
			otherKind: false,
		});
	});
});
