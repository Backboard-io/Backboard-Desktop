/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('CodeBlockPart CSS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const css = readFileSync(join(process.cwd(), 'src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/codeBlockPart.css'), 'utf8');

	function ruleBody(selector: string): string {
		const index = css.indexOf(selector);
		assert.ok(index >= 0, `Missing selector ${selector}`);
		const start = css.indexOf('{', index);
		assert.ok(start >= 0, `Missing body for selector ${selector}`);
		const end = css.indexOf('}', start);
		assert.ok(end >= 0, `Unclosed body for selector ${selector}`);
		return css.slice(start + 1, end);
	}

	test('Backboard reserves a header rail and leaves long lines to the editor scroller', () => {
		const root = '.monaco-workbench .backboard-clean-chat .interactive-result-code-block:not(.compare)';
		const block = ruleBody(`${root}:has(> .interactive-result-code-block-toolbar)`);
		const editor = ruleBody(`${root} > .interactive-result-editor`);
		const toolbar = ruleBody(`${root} > .interactive-result-code-block-toolbar`);
		const actions = ruleBody(`${root} > .interactive-result-code-block-toolbar > .monaco-action-bar,`);

		assert.match(block, /display:\s*flex/);
		assert.match(block, /overflow:\s*hidden/);
		assert.match(editor, /min-width:\s*0/);
		assert.match(toolbar, /position:\s*static\s*!important/);
		assert.match(toolbar, /order:\s*-1/);
		assert.match(toolbar, /min-height:\s*28px/);
		assert.match(actions, /position:\s*static\s*!important/);
		assert.match(actions, /max-width:\s*none/);
		assert.doesNotMatch(actions, /position:\s*absolute/);
	});
});
