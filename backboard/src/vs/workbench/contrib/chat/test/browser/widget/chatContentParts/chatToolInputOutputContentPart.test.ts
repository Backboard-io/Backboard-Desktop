/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatCollapsibleInputOutputContentPart } from '../../../../browser/widget/chatContentParts/chatToolInputOutputContentPart.js';
import { IChatContentPartRenderContext } from '../../../../browser/widget/chatContentParts/chatContentParts.js';

suite('ChatCollapsibleInputOutputContentPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	for (const title of ['MCP backboard.search_docs', 'Ran Playwright code', 'Running Playwright code...', 'Waited for Playwright code']) {
		test(`editor-panel ${title} stays static even when the stored disclosure was open`, () => {
			const instantiationService = workbenchInstantiationService(undefined, store);
			const container = document.createElement('div');
			container.className = 'part auxiliarybar backboard-cursor-transcript';
			const part = store.add(instantiationService.createInstance(ChatCollapsibleInputOutputContentPart,
				title, undefined, undefined, { ...({} as IChatContentPartRenderContext), container },
				{ kind: 'code', data: 'threads', languageId: 'plaintext', options: {}, codeBlockIndex: 0, ownerMarkdownPartId: 'test' },
				{ parts: [] }, false, true, false));
			container.appendChild(part.domNode);
			assert.strictEqual(part.expanded, false);
			assert.strictEqual(part.domNode.querySelector('.chat-collapsible-hover-chevron'), null);
			assert.strictEqual(part.domNode.querySelector('[aria-expanded]'), null);
			const label = part.domNode.querySelector<HTMLElement>('.chat-confirmation-widget-title')!;
			assert.strictEqual(label.getAttribute('role'), null);
			assert.strictEqual(label.tabIndex, -1);
			label.click();
			assert.strictEqual(part.expanded, false);
			assert.strictEqual(part.domNode.querySelector('.chat-tool-io-details'), null);
			assert.ok(part.domNode.textContent?.includes(title));
		});
	}
});
