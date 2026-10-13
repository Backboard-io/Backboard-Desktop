/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createRightWorkbenchReviewContextKey, RightWorkbenchReviewContext } from '../../browser/rightWorkbenchReviewContext.js';

suite('RightWorkbenchReviewContext', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('invalidates deferred work when the visible chat changes', () => {
		const context = new RightWorkbenchReviewContext();

		const chatAKey = createRightWorkbenchReviewContextKey('session-a', 'chat-a');
		const chatBKey = createRightWorkbenchReviewContextKey('session-a', 'chat-b');
		const nextSessionChatAKey = createRightWorkbenchReviewContextKey('session-b', 'chat-a');
		assert.notStrictEqual(chatAKey, chatBKey);
		assert.notStrictEqual(chatAKey, nextSessionChatAKey);

		assert.strictEqual(context.transition(chatAKey), true);
		const chatAGeneration = context.captureGeneration();
		assert.strictEqual(context.transition(chatAKey), false);
		assert.strictEqual(context.isCurrent(chatAGeneration), true);

		assert.strictEqual(context.transition(chatBKey), true);
		assert.strictEqual(context.isCurrent(chatAGeneration), false);
		const chatBGeneration = context.captureGeneration();
		assert.strictEqual(context.transition(nextSessionChatAKey), true);
		assert.strictEqual(context.isCurrent(chatBGeneration), false);
		const nextSessionGeneration = context.captureGeneration();

		const resourceKey = context.resourceKey;
		context.invalidate();
		assert.strictEqual(context.resourceKey, resourceKey);
		assert.strictEqual(context.isCurrent(nextSessionGeneration), false);
		assert.strictEqual(context.transition(undefined), true);
	});
});
