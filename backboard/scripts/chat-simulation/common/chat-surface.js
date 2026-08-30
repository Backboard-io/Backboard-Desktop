/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/** @typedef {'panel' | 'editor'} ChatSurfaceId */

/**
 * @typedef ChatSurface
 * @property {ChatSurfaceId} id
 * @property {string} rootSelector
 * @property {string} inputEditorSelector
 * @property {string} responseSelector
 * @property {string | undefined} openCommandId
 * @property {string | undefined} resetCommandId
 */

const PANEL_ROOT = 'div[id="workbench.panel.chat"]';
const EDITOR_ROOT = '.editor-instance .interactive-session';

/** @type {Readonly<Record<ChatSurfaceId, Readonly<ChatSurface>>>} */
const CHAT_SURFACES = Object.freeze({
	panel: Object.freeze({
		id: 'panel',
		rootSelector: PANEL_ROOT,
		inputEditorSelector: `${PANEL_ROOT} .interactive-input-part .monaco-editor[role="code"]`,
		responseSelector: `${PANEL_ROOT} .interactive-item-container.interactive-response`,
		openCommandId: undefined,
		resetCommandId: undefined,
	}),
	editor: Object.freeze({
		id: 'editor',
		rootSelector: EDITOR_ROOT,
		inputEditorSelector: `${EDITOR_ROOT} .interactive-input-part .monaco-editor[role="code"]`,
		responseSelector: `${EDITOR_ROOT} .interactive-item-container.interactive-response`,
		openCommandId: 'workbench.action.chat.openInEditor',
		resetCommandId: 'workbench.action.chat.newChat',
	}),
});

/**
 * Validate and normalize a configured chat surface.
 * @param {unknown} value
 * @returns {ChatSurfaceId}
 */
function normalizeChatSurface(value) {
	const surface = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (surface === 'panel' || surface === 'editor') {
		return surface;
	}
	throw new Error(`Unknown chat surface "${String(value)}". Expected "panel" or "editor".`);
}

/**
 * @param {unknown} value
 * @returns {Readonly<ChatSurface>}
 */
function getChatSurface(value = 'panel') {
	return CHAT_SURFACES[normalizeChatSurface(value)];
}

/**
 * Wait for a chat surface and its input editor to be visible.
 * @param {import('playwright').Page} page
 * @param {Readonly<ChatSurface>} surface
 * @param {number} [timeoutMs]
 */
async function waitForChatSurface(page, surface, timeoutMs = 15_000) {
	await page.waitForSelector(surface.rootSelector, { timeout: timeoutMs });
	await page.waitForFunction(
		(selector) => Array.from(document.querySelectorAll(selector)).some(el => {
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}),
		surface.inputEditorSelector,
		{ timeout: timeoutMs },
	);
}

/**
 * Execute an exact workbench command ID through the command palette. Exact
 * command IDs are language-independent and avoid coupling the harness to an
 * action's displayed label.
 * @param {import('playwright').Page} page
 * @param {string} commandId
 */
async function executeWorkbenchCommand(page, commandId) {
	await page.keyboard.press('F1');
	const inputSelector = '.quick-input-widget .quick-input-box input';
	await page.waitForSelector(inputSelector, { state: 'visible', timeout: 15_000 });
	await page.fill(inputSelector, `>${commandId}`);
	await page.waitForSelector('.quick-input-widget .quick-input-list .monaco-list-row', { state: 'visible', timeout: 15_000 });
	// Let the quick-access provider replace its initial suggestions with the exact-ID result.
	await new Promise(resolve => setTimeout(resolve, 100));
	await page.keyboard.press('Enter');
}

/**
 * Open the requested chat surface and wait until it is ready for input.
 * @param {import('playwright').Page} page
 * @param {Readonly<ChatSurface>} surface
 */
async function openChatSurface(page, surface) {
	if (surface.openCommandId) {
		await executeWorkbenchCommand(page, surface.openCommandId);
	} else {
		const chatShortcut = process.platform === 'darwin' ? 'Control+Meta+KeyI' : 'Control+Alt+KeyI';
		await page.keyboard.press(chatShortcut);
	}
	await waitForChatSurface(page, surface);
}

/**
 * Clear the focused chat while keeping it on the selected surface.
 * @param {import('playwright').Page} page
 * @param {Readonly<ChatSurface>} surface
 */
async function resetChatSurface(page, surface) {
	if (surface.resetCommandId) {
		await executeWorkbenchCommand(page, surface.resetCommandId);
	} else {
		// Keep the panel runner's existing shortcut for backwards-compatible measurements.
		const newChatShortcut = process.platform === 'darwin' ? 'Meta+KeyL' : 'Control+KeyL';
		await page.keyboard.press(newChatShortcut);
	}
	await new Promise(resolve => setTimeout(resolve, 1000));
	await waitForChatSurface(page, surface);
	await new Promise(resolve => setTimeout(resolve, 500));
}

module.exports = {
	CHAT_SURFACES,
	normalizeChatSurface,
	getChatSurface,
	waitForChatSurface,
	openChatSurface,
	resetChatSurface,
};
