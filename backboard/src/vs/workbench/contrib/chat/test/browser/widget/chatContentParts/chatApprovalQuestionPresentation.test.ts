/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction } from '../../../../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatCustomConfirmationWidget } from '../../../../browser/widget/chatContentParts/chatConfirmationWidget.js';
import { IChatContentPartRenderContext } from '../../../../browser/widget/chatContentParts/chatContentParts.js';
import '../../../../browser/widget/chatContentParts/media/chatToolConfirmationCarousel.css';
import '../../../../browser/widget/media/chat.css';
import '../../../../browser/widget/media/chatPanelCursorLook.css';

suite('Editor-panel approval question presentation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps approval scopes, skip, and code intact in lettered question rows', async () => {
		const host = document.createElement('div');
		host.className = 'monaco-workbench vs-dark';
		host.style.width = '360px';
		host.innerHTML = '<div class="part auxiliarybar"><div class="chat-viewpane"><div class="backboard-composer"><div class="interactive-session"><div class="interactive-input-part"><div class="chat-input-container"><div class="chat-tool-confirmation-carousel-container"><div class="chat-tool-confirmation-carousel"><div class="chat-tool-carousel-content"></div></div></div></div></div></div></div></div></div>';
		document.body.append(host);
		const composer = host.querySelector<HTMLElement>('.chat-input-container')!;
		composer.before(host.querySelector('.chat-tool-confirmation-carousel-container')!);
		assert.strictEqual(composer.querySelector('.chat-tool-confirmation-carousel'), null);
		store.add({ dispose: () => host.remove() });
		const code = document.createElement('pre');
		code.textContent = 'await page.waitForTimeout(500);';
		const instantiationService = workbenchInstantiationService(undefined, store);
		let menuActions: readonly IAction[] = [];
		instantiationService.stub(IContextMenuService, { showContextMenu: delegate => { menuActions = delegate.getActions?.() ?? []; } } as IContextMenuService);
		const widget = store.add(instantiationService.createInstance(ChatCustomConfirmationWidget<string>, {} as IChatContentPartRenderContext, {
			title: 'Run Playwright Code?', message: code,
			buttons: [
				{ label: 'Allow in this Session', data: 'session', moreActions: [{ label: 'Allow Once', data: 'once' }] },
				{ label: 'Skip', data: 'skip', isSecondary: true },
			],
		}));
		host.querySelector('.chat-tool-carousel-content')!.append(widget.domNode);
		let result: string | undefined;
		store.add(widget.onDidClick(e => result = e.button.data));
		const choices = widget.domNode.querySelectorAll<HTMLElement>('.chat-buttons .monaco-button:not(.monaco-dropdown-button)');
		assert.strictEqual(choices.length, 2);
		assert.strictEqual(getComputedStyle(choices[0]).backgroundColor, 'rgba(0, 0, 0, 0)');
		assert.strictEqual(getComputedStyle(choices[0]).fontSize, '13px');
		assert.ok(getComputedStyle(choices[0], '::before').content.includes('approval-choice'));
		assert.strictEqual(getComputedStyle(widget.domNode.querySelector('.chat-buttons')!).flexDirection, 'column');
		assert.ok(widget.domNode.querySelector('.monaco-dropdown-button'));
		assert.strictEqual(code.textContent, 'await page.waitForTimeout(500);');
		choices[0].click();
		assert.strictEqual(result, 'session');
		choices[1].click();
		assert.strictEqual(result, 'skip');
		widget.domNode.querySelector<HTMLElement>('.monaco-dropdown-button')!.click();
		assert.strictEqual(menuActions[0].label, 'Allow Once');
		await menuActions[0].run();
		assert.strictEqual(result, 'once');
	});
});
