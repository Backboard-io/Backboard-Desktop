/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const assert = require('node:assert/strict');
const test = require('node:test');
const { CHAT_SURFACES, getChatSurface, normalizeChatSurface, openChatSurface } = require('./chat-surface');

test('defaults to the panel surface', () => {
	assert.equal(getChatSurface(), CHAT_SURFACES.panel);
	assert.equal(getChatSurface().rootSelector, 'div[id="workbench.panel.chat"]');
});

test('defines native editor selectors independently of the panel', () => {
	const editor = getChatSurface('editor');
	assert.equal(editor.rootSelector, '.editor-instance .interactive-session');
	assert.match(editor.inputEditorSelector, /^\.editor-instance \.interactive-session /);
	assert.match(editor.responseSelector, /^\.editor-instance \.interactive-session /);
	assert.equal(editor.openCommandId, 'workbench.action.chat.openInEditor');
	assert.equal(editor.resetCommandId, 'workbench.action.chat.newChat');
	assert.doesNotMatch(editor.inputEditorSelector, /workbench\.panel\.chat/);
});

test('normalizes configured values and rejects unknown surfaces', () => {
	assert.equal(normalizeChatSurface(' EDITOR '), 'editor');
	assert.throws(() => normalizeChatSurface('sidebar'), /Expected "panel" or "editor"/);
});

test('opens editor mode through an exact workbench command ID', async () => {
	/** @type {string[]} */
	const events = [];
	const page = /** @type {any} */ ({
		keyboard: {
			press: async (/** @type {string} */ key) => events.push(`press:${key}`),
		},
		fill: async (/** @type {string} */ selector, /** @type {string} */ value) => events.push(`fill:${selector}:${value}`),
		waitForSelector: async (/** @type {string} */ selector) => events.push(`wait:${selector}`),
		waitForFunction: async () => events.push('wait:input-visible'),
	});

	await openChatSurface(page, getChatSurface('editor'));

	assert.deepEqual(events, [
		'press:F1',
		'wait:.quick-input-widget .quick-input-box input',
		'fill:.quick-input-widget .quick-input-box input:>workbench.action.chat.openInEditor',
		'wait:.quick-input-widget .quick-input-list .monaco-list-row',
		'press:Enter',
		'wait:.editor-instance .interactive-session',
		'wait:input-visible',
	]);
});
