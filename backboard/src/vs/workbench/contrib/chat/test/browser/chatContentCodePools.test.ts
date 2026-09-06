/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorPool, DiffEditorPool } from '../../browser/widget/chatContentParts/chatContentCodePools.js';
import { ChatEditorOptions } from '../../browser/widget/chatOptions.js';
import { IChatRendererDelegate } from '../../browser/widget/chatListRenderer.js';

suite('Chat content code pools', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const kind of ['code', 'diff'] as const) {
		test(`${kind} references can be released after the chat renderer is disposed`, () => {
			let disposed = false;
			let resets = 0;
			let disposals = 0;
			const editor = {
				reset: () => {
					assert.strictEqual(disposed, false, 'must not reset an already disposed editor');
					resets++;
				},
				dispose: () => { disposed = true; disposals++; },
			};
			const instantiationService = { createInstance: () => editor } as unknown as IInstantiationService;
			const options = {} as ChatEditorOptions;
			const delegate = {} as IChatRendererDelegate;
			const pool = store.add(kind === 'code'
				? new EditorPool(options, delegate, undefined, false, instantiationService)
				: new DiffEditorPool(options, delegate, undefined, false, instantiationService));
			const first = pool.get('block');
			first.dispose();
			first.dispose();
			const active = pool.get('block');
			assert.strictEqual(active.object, first.object, 'live editors should still be reused');
			pool.dispose();
			assert.strictEqual(active.isStale(), true);
			assert.doesNotThrow(() => active.dispose());
			active.dispose();
			assert.deepStrictEqual({ resets, disposals }, { resets: 1, disposals: 1 });
		});
	}
});
