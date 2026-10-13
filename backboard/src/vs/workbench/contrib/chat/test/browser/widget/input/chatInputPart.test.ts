/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import '../../../../browser/widget/media/chat.css';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { getChatContextUsageWidgetPlacement } from '../../../../browser/widget/input/chatInputPart.js';

suite('ChatInputPart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('inactive composer covers controls without a dark prompt rectangle', () => {
		const host = document.createElement('div');
		host.className = 'interactive-session';
		host.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:120px;z-index:10000';
		host.innerHTML = '<div class="interactive-input-part chat-input-inactive" style="height:120px"><button style="position:relative;z-index:102;margin-top:60px">Send</button><div class="chat-input-overlay disabled"></div></div>';
		document.body.appendChild(host);
		try {
			const overlay = host.querySelector('.chat-input-overlay')!;
			const button = host.querySelector('button')!;
			const rect = button.getBoundingClientRect();
			assert.strictEqual(getComputedStyle(overlay).backgroundColor, 'rgba(0, 0, 0, 0)');
			assert.strictEqual(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2), overlay);
		} finally {
			host.remove();
		}
	});

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
