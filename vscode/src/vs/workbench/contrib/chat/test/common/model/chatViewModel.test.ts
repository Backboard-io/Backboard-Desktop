/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IChatExternalEdit } from '../../../common/chatService/chatService.js';
import { IChatModel, IChatProgressResponseContent, IChatRequestModel, IChatResponseModel, IResponse } from '../../../common/model/chatModel.js';
import { getLatestTurnEditedFiles } from '../../../common/model/chatViewModel.js';

suite('getLatestTurnEditedFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createEdit(path: string, editKind: IChatExternalEdit['editKind'], added: number, removed: number): IChatExternalEdit {
		return {
			kind: 'externalEdit',
			uri: URI.file(path),
			editKind,
			diff: { added, removed },
		};
	}

	function createModel(isComplete: boolean, parts: IChatProgressResponseContent[]): IChatModel {
		const response: Partial<IChatResponseModel> = {
			isComplete,
			entireResponse: { value: parts } as unknown as IResponse,
		};
		const request: Partial<IChatRequestModel> = {
			response: response as IChatResponseModel,
		};
		return {
			getRequests: () => [request as IChatRequestModel],
		} as IChatModel;
	}

	test('returns undefined when there are no requests', () => {
		const model = { getRequests: () => [] } as unknown as IChatModel;
		assert.strictEqual(getLatestTurnEditedFiles(model), undefined);
	});

	test('returns undefined while the latest response is still streaming', () => {
		const model = createModel(false, [createEdit('/project/a.ts', 'edit', 3, 1)]);
		assert.strictEqual(getLatestTurnEditedFiles(model), undefined);
	});

	test('returns undefined when the latest response made no edits', () => {
		const model = createModel(true, []);
		assert.strictEqual(getLatestTurnEditedFiles(model), undefined);
	});

	test('aggregates one entry per file, summing diff counts', () => {
		const model = createModel(true, [
			createEdit('/project/a.ts', 'edit', 3, 1),
			createEdit('/project/a.ts', 'edit', 2, 0),
			createEdit('/project/b.ts', 'create', 10, 0),
		]);
		const edited = getLatestTurnEditedFiles(model);
		assert.deepStrictEqual(
			edited?.map(e => ({ path: e.uri.path, editKind: e.editKind, diff: e.diff })),
			[
				{ path: '/project/a.ts', editKind: 'edit', diff: { added: 5, removed: 1 } },
				{ path: '/project/b.ts', editKind: 'create', diff: { added: 10, removed: 0 } },
			]
		);
	});

	test('a file created earlier in the turn stays "created" even if later edited', () => {
		const model = createModel(true, [
			createEdit('/project/a.ts', 'create', 5, 0),
			createEdit('/project/a.ts', 'edit', 2, 1),
		]);
		const edited = getLatestTurnEditedFiles(model);
		assert.deepStrictEqual(edited?.map(e => e.editKind), ['create']);
	});
});
