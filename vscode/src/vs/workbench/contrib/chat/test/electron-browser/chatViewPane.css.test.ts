/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ChatViewPane CSS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const css = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewPane.css'), 'utf8');
	const sessionsCss = readFileSync(join(process.cwd(), 'src/vs/sessions/browser/media/style.css'), 'utf8');

	function ruleBody(selector: string): string {
		const index = css.indexOf(selector);
		assert.ok(index >= 0, `Missing selector ${selector}`);
		const start = css.indexOf('{', index);
		assert.ok(start >= 0, `Missing body for selector ${selector}`);
		let depth = 0;
		for (let i = start; i < css.length; i++) {
			if (css[i] === '{') {
				depth++;
			} else if (css[i] === '}') {
				depth--;
				if (depth === 0) {
					return css.slice(start + 1, i);
				}
			}
		}
		assert.fail(`Unclosed body for selector ${selector}`);
	}

	test('matches Backboard side chat background to the sessions sidebar surface', () => {
		const sideChat = ruleBody('.chat-viewpane.has-sessions-control .agent-sessions-container.backboard-side-chat-sessions');

		assert.match(sessionsCss, /--sessions-sidebar-region-background:\s*var\(--vscode-sideBar-background,\s*var\(--vscode-editor-background\)\)/);
		assert.match(sessionsCss, /--sessions-integrated-sidebar-background:\s*var\(--sessions-sidebar-region-background\)/);
		assert.match(sideChat, /--backboard-side-chat-bg:\s*var\(--sessions-integrated-sidebar-background\)/);
		assert.match(sideChat, /background:\s*var\(--backboard-side-chat-bg\)/);
	});
});
