/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normalizeRightWorkbenchUrl, RightWorkbenchBrowserSuggestions } from '../../browser/rightWorkbenchBrowserSuggestions.js';

suite('RightWorkbenchBrowserSuggestions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('distinguishes addresses and local ports from search text', () => {
		assert.deepStrictEqual([
			'', ' https://example.com/a?q=hello ', 'example.com/docs', 'localhost:3000',
			'127.0.0.1:8080/a', '[::1]:3000', ':5173/path', 'fireflies ai',
			'what is localhost', 'file:///tmp/example.html', 'about:blank', 'javascript:alert(1)',
		].map(normalizeRightWorkbenchUrl), [
			undefined, 'https://example.com/a?q=hello', 'https://example.com/docs', 'http://localhost:3000',
			'http://127.0.0.1:8080/a', 'http://[::1]:3000', 'http://localhost:5173/path', 'https://www.google.com/search?q=fireflies%20ai',
			'https://www.google.com/search?q=what%20is%20localhost', 'file:///tmp/example.html', 'about:blank', 'https://www.google.com/search?q=javascript%3Aalert(1)',
		]);
	});

	test('commits typed input once and ignores Enter during IME composition', () => {
		const anchor = mainWindow.document.createElement('div');
		const input = mainWindow.document.createElement('input');
		anchor.appendChild(input);
		const navigations: string[] = [];
		store.add(new RightWorkbenchBrowserSuggestions(anchor, input, () => [], value => navigations.push(value)));
		input.value = 'localhost:3000';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		assert.deepStrictEqual({ navigations, expanded: input.getAttribute('aria-expanded'), role: input.role }, {
			navigations: ['localhost:3000'], expanded: 'false', role: 'combobox',
		});
	});

	test('disposing the address bar removes listeners and its popup', () => {
		const anchor = mainWindow.document.createElement('div');
		const input = mainWindow.document.createElement('input');
		anchor.appendChild(input);
		const navigations: string[] = [];
		const suggestions = store.add(new RightWorkbenchBrowserSuggestions(anchor, input, () => [], value => navigations.push(value)));
		suggestions.dispose();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		assert.deepStrictEqual({ navigations, children: anchor.childElementCount }, { navigations: [], children: 1 });
	});
});
