/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { getChatContextUsageWidgetPlacement } from '../../../../browser/widget/input/chatInputPart.js';

suite('ChatInputPart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses input placement only for explicit Backboard composer hosts', () => {
		const backboardHost = document.createElement('div');
		backboardHost.classList.add('backboard-composer');
		const backboardInput = backboardHost.appendChild(document.createElement('div'));
		const sessionsInput = document.createElement('div');
		const compactInput = document.createElement('div');
		const defaultInput = document.createElement('div');

		assert.deepStrictEqual({
			backboard: getChatContextUsageWidgetPlacement(backboardInput, undefined, true),
			sessions: getChatContextUsageWidgetPlacement(sessionsInput, undefined, true),
			compact: getChatContextUsageWidgetPlacement(compactInput, 'compact', false),
			default: getChatContextUsageWidgetPlacement(defaultInput, undefined, false),
		}, {
			backboard: 'input',
			sessions: 'toolbar',
			compact: 'toolbar',
			default: 'secondary',
		});
	});
});
