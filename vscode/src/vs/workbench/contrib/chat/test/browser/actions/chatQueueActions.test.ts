/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { OS } from '../../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingsRegistry } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver } from '../../../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { isIMenuItem, isISubmenuItem, MenuId, MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { ChatQueueMessageAction, ChatSteerWithMessageAction, registerChatQueueActions } from '../../../browser/actions/chatQueueActions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

// Register actions once so the keybindings appear in KeybindingsRegistry.
registerChatQueueActions();

suite('Queue/Steer keybinding resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function buildResolverForCommands(commandIds: string[]): KeybindingResolver {
		const items: ResolvedKeybindingItem[] = [];
		for (const item of KeybindingsRegistry.getDefaultKeybindingsForOS(OS)) {
			if (!item.command || !commandIds.includes(item.command) || !item.keybinding) {
				continue;
			}
			const resolved = USLayoutResolvedKeybinding.resolveKeybinding(item.keybinding, OS)[0];
			items.push(new ResolvedKeybindingItem(resolved, item.command, item.commandArgs, item.when ?? undefined, true, null, false));
		}
		return new KeybindingResolver(items, [], () => { });
	}

	function lookupQueueKeybinding() {
		const config = new TestConfigurationService();
		const ctxService = new ContextKeyService(config);
		// Simulate the chat input being focused with a request in progress, like the picker does.
		const overlay = ctxService.createOverlay([
			[ChatContextKeys.inputHasText.key, true],
			[ChatContextKeys.inputHasSendableContent.key, true],
			[ChatContextKeys.inChatInput.key, true],
			[ChatContextKeys.requestInProgress.key, true],
		]);
		const resolver = buildResolverForCommands([ChatQueueMessageAction.ID, ChatSteerWithMessageAction.ID]);
		return {
			result: {
				queue: resolver.lookupPrimaryKeybinding(ChatQueueMessageAction.ID, overlay, true)?.resolvedKeybinding?.getDispatchChords()[0] ?? null,
				steer: resolver.lookupPrimaryKeybinding(ChatSteerWithMessageAction.ID, overlay, true)?.resolvedKeybinding?.getDispatchChords()[0] ?? null,
			},
			dispose: () => ctxService.dispose(),
		};
	}

	test('Enter queues while a request is in progress', () => {
		const { result, dispose } = lookupQueueKeybinding();
		try {
			// The product now exposes queue as the sole in-progress submit mode.
			// Keep the legacy steer command registered for compatibility, but do
			// not let it compete for the primary input keybinding.
			assert.deepStrictEqual(result, { queue: 'Enter', steer: null });
		} finally {
			dispose();
		}
	});

	test('keeps the send arrow and removes the stop-and-send split menu', () => {
		const executeItems = MenuRegistry.getMenuItems(MenuId.ChatExecute);
		const queueSubmit = executeItems.find(item => isIMenuItem(item) && item.command.id === ChatQueueMessageAction.ID);
		assert.ok(queueSubmit && isIMenuItem(queueSubmit), 'queued submit is registered directly in the execute toolbar');
		assert.ok(ThemeIcon.isThemeIcon(queueSubmit.command.icon));
		assert.strictEqual(queueSubmit.command.icon.id, Codicon.arrowUp.id);
		assert.ok(!executeItems.some(item => isISubmenuItem(item) && item.submenu === MenuId.ChatExecuteQueue), 'no queue split-button submenu is registered');
	});
});
