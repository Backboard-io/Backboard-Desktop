/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import '../../../browser/widget/media/chat.css';
import { ModifierKeyEmitter } from '../../../../../../base/browser/dom.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { ChatCopyActionViewItem } from '../../../browser/actions/chatCopyActions.js';

suite('Chat copy button', () => {
	// The workbench-wide modifier listener outlives individual action view items.
	suiteSetup(() => ModifierKeyEmitter.getInstance());
	const store = new DisposableStore();
	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('copy remains reachable above the message-edit overlay', () => {
		const host = document.createElement('div');
		host.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:100px;z-index:10000';
		host.innerHTML = '<div class="chat-row-disabled-overlay disabled"></div><div class="interactive-item-container interactive-response"><div class="chat-footer-toolbar"><div class="menu-entry chat-copy-action" style="width:24px;height:24px"><button style="width:24px;height:24px">Copy</button></div></div></div>';
		document.body.appendChild(host);
		try {
			const button = host.querySelector('button')!;
			const rect = button.getBoundingClientRect();
			assert.strictEqual(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2), button);
		} finally {
			host.remove();
		}
	});

	test('exposes a button and forwards its message context before reporting success', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const pendingWrite = new DeferredPromise<void>();
		const message = { id: 'response-1' };
		let copiedContext: unknown;
		instantiationService.stub(ICommandService, {
			executeCommand: async (_id: string, context: unknown) => {
				copiedContext = context;
				await pendingWrite.p;
			},
		});
		const action = instantiationService.createInstance(MenuItemAction,
			{ id: 'workbench.action.chat.copyItem', title: 'Copy', icon: Codicon.copy },
			undefined, { shouldForwardArgs: true }, undefined, undefined);
		const viewItem = store.add(instantiationService.createInstance(ChatCopyActionViewItem, action, {}));
		const container = document.createElement('div');
		viewItem.render(container);
		viewItem.setActionContext(message);
		const button = container.querySelector('[role="button"]')!;
		assert.strictEqual(button.getAttribute('aria-hidden'), null);
		assert.strictEqual(button.getAttribute('aria-label'), 'Copy');

		const click = viewItem.onClick(new MouseEvent('click'));
		assert.strictEqual(copiedContext, message);
		assert.strictEqual(container.classList.contains('copied'), false);
		await pendingWrite.complete();
		await click;
		assert.strictEqual(container.classList.contains('copied'), true);
		assert.strictEqual(button.getAttribute('aria-label'), 'Copied');
	});
});
