/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

suite('BackboardWorkspace CSS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const css = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/electron-browser/backboardWorkspace/media/backboardWorkspace.css'), 'utf8');

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

	test('uses a top header and flexible body instead of a bottom toolbar', () => {
		const editor = ruleBody('.monaco-workbench .backboard-workspace-editor');
		assert.match(editor, /display:\s*flex/);
		assert.match(editor, /flex-direction:\s*column/);

		const header = ruleBody('.monaco-workbench .backboard-workspace-header');
		assert.match(header, /flex:\s*none/);
		assert.match(header, /display:\s*grid/);
		assert.match(header, /grid-template-columns:\s*minmax\(150px,\s*1fr\)\s*auto\s*minmax\(220px,\s*1fr\)/);
		assert.match(header, /min-height:\s*44px/);
		assert.doesNotMatch(header, /(^|[;\n]\s*)bottom\s*:/);
		assert.doesNotMatch(header, /position:\s*(absolute|fixed|sticky)/);

		const page = ruleBody('.monaco-workbench .backboard-workspace-page');
		assert.match(page, /flex:\s*1/);
		assert.match(page, /min-height:\s*0/);
	});

	test('keeps cards below the header in their own scrollable grid', () => {
		const cards = ruleBody('.monaco-workbench .backboard-workspace-cards');
		assert.match(cards, /flex:\s*1/);
		assert.match(cards, /min-height:\s*0/);
		assert.match(cards, /overflow-y:\s*auto/);
		assert.match(cards, /padding:\s*16px/);
		assert.match(cards, /gap:\s*16px/);
		assert.match(cards, /grid-auto-rows:\s*minmax\(320px,\s*calc\(\(100% - 16px\) \/ 2\)\)/);
	});

	test('uses a 420px detail panel and adaptive card columns', () => {
		const page = ruleBody('.monaco-workbench .backboard-workspace-page');
		assert.match(page, /var\(--detail-width,\s*420px\)/);

		const cards = ruleBody('.monaco-workbench .backboard-workspace-cards');
		assert.match(cards, /repeat\(auto-fit,\s*minmax\(430px,\s*1fr\)\)/);
		assert.doesNotMatch(cards, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/);

		const mobileCards = ruleBody('.monaco-workbench .backboard-workspace-cards { grid-template-columns: minmax(0, 1fr); }');
		assert.ok(mobileCards !== undefined);
	});

	test('reserves titlebar space without making header controls unclickable', () => {
		const header = ruleBody('.monaco-workbench .backboard-workspace-header');
		assert.match(header, /-webkit-app-region:\s*drag/);
		assert.ok(css.includes('.monaco-workbench.backboard-workspace-visible > .part.titlebar > .titlebar-container > .titlebar-center > .center-adjacent-toolbar-container'), 'Advanced header must suppress center-adjacent titlebar controls');

		const headerLeft = ruleBody('.monaco-workbench .backboard-workspace-header-left');
		const switcher = ruleBody('.monaco-workbench .backboard-workspace-switcher');
		const titleRow = ruleBody('.monaco-workbench .backboard-workspace-title-row');
		const headerRight = ruleBody('.monaco-workbench .backboard-workspace-header-right');
		assert.match(headerLeft, /display:\s*contents/);
		assert.match(switcher, /-webkit-app-region:\s*no-drag/);
		assert.match(titleRow, /-webkit-app-region:\s*no-drag/);
		assert.match(headerRight, /-webkit-app-region:\s*no-drag/);

		const macHeader = ruleBody('.monaco-workbench.mac:not(.fullscreen) .backboard-workspace-header');
		assert.match(macHeader, /padding-left:\s*218px/);
	});

	test('uses compact styled header buttons and a plain selected card border', () => {
		const iconButtons = ruleBody('.monaco-workbench .backboard-workspace-icon-button,\n.monaco-workbench .backboard-workspace-detail-toggle,\n.monaco-workbench .backboard-workspace-detail-expand');
		assert.match(iconButtons, /width:\s*30px/);
		assert.match(iconButtons, /height:\s*30px/);
		assert.match(iconButtons, /-webkit-app-region:\s*no-drag/);

		const selectedCard = ruleBody('.monaco-workbench .backboard-workspace-card.selected');
		assert.match(selectedCard, /border-color:\s*var\(--backboard-workspace-active\)/);
		assert.match(selectedCard, /box-shadow:\s*none/);
	});

	test('scopes chat composer chrome to the workspace detail panel', () => {
		const session = ruleBody('.monaco-workbench .backboard-workspace-detail-chat .interactive-session');
		assert.match(session, /height:\s*100%/);
		assert.match(session, /background:\s*var\(--backboard-workspace-bg\)/);

		const inputPart = ruleBody('.monaco-workbench .backboard-workspace-detail-chat .interactive-input-part');
		assert.match(inputPart, /padding:\s*0 16px 16px/);
		assert.match(inputPart, /background:\s*transparent/);

		const input = ruleBody('.monaco-workbench .backboard-workspace-detail-chat .chat-input-container');
		assert.match(input, /border-radius:\s*8px/);
		assert.match(input, /background-color:\s*var\(--backboard-workspace-card-bg\)/);
	});
});
