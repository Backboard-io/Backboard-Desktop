/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { CopyCodeBlockAction } from '../../../browser/actions/chatCodeblockActions.js';
import { createCodeBlockActionContext, ICodeBlockData } from '../../../browser/widget/chatContentParts/codeBlockPart.js';
import { IChatRequestViewModel } from '../../../common/model/chatViewModel.js';

suite('Chat code block actions', () => {
	const store = new DisposableStore();

	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('copy awaits the complete raw command clipboard write', async () => {
		const rawCommand = [
			'env API_TOKEN="$TOKEN" node ./scripts/run.js --message="a command that is much wider than the code block" \\',
			'  --include="src/**/*.ts" --output="./tmp/full result.json"',
		].join('\n');
		const data: ICodeBlockData = {
			codeBlockIndex: 3,
			element: {} as IChatRequestViewModel,
			text: rawCommand,
			languageId: 'shellscript',
			chatSessionResource: URI.parse('test://chat/session'),
		};
		const context = createCodeBlockActionContext(data, 'shellscript');
		const clipboardWrite = new DeferredPromise<void>();
		let writtenText: string | undefined;
		const clipboardService = new class extends mock<IClipboardService>() {
			override writeText(text: string): Promise<void> {
				writtenText = text;
				return clipboardWrite.p;
			}
		};
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.set(IClipboardService, clipboardService);

		let actionSettled = false;
		const actionPromise = new CopyCodeBlockAction().run(instantiationService, context).finally(() => {
			actionSettled = true;
		});
		await Promise.resolve();

		assert.strictEqual(writtenText, rawCommand);
		assert.strictEqual(context.code, rawCommand);
		assert.strictEqual(actionSettled, false, 'copy feedback must wait for the clipboard write');

		clipboardWrite.complete();
		await actionPromise;
		assert.strictEqual(actionSettled, true);
	});
});
