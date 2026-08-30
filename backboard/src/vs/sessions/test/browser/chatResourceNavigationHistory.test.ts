/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ChatResourceNavigationHistory } from '../../browser/parts/chatResourceNavigationHistory.js';
import { SessionView } from '../../browser/parts/sessionView.js';
import { IChat } from '../../services/sessions/common/session.js';

suite('Sessions - Chat Resource Navigation History', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns from a subagent to its parent chat', () => {
		const history = new ChatResourceNavigationHistory();
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');

		history.recordOpen(parent, child);

		assert.strictEqual(history.canGoBack, true);
		assert.strictEqual(history.previous?.toString(), parent.toString());
		assert.strictEqual(history.commitBack()?.toString(), parent.toString());
		assert.strictEqual(history.canGoBack, false);
	});

	test('unwinds nested subagents one chat at a time', () => {
		const history = new ChatResourceNavigationHistory();
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');
		const grandchild = URI.parse('chat-session://test/parent/subagent/child/subagent/grandchild');

		history.recordOpen(parent, child);
		history.recordOpen(child, grandchild);

		assert.strictEqual(history.root?.toString(), parent.toString());
		assert.strictEqual(history.commitBack()?.toString(), child.toString());
		assert.strictEqual(history.commitBack()?.toString(), parent.toString());
		assert.strictEqual(history.commitBack(), undefined);
	});

	test('does not add duplicate or no-op entries', () => {
		const history = new ChatResourceNavigationHistory();
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');

		history.recordOpen(parent, parent);
		history.recordOpen(parent, child);
		history.recordOpen(parent, child);

		assert.strictEqual(history.commitBack()?.toString(), parent.toString());
		assert.strictEqual(history.canGoBack, false);
	});

	test('session view restores the top-level parent model', () => {
		const history = new ChatResourceNavigationHistory();
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');
		history.recordOpen(parent, child);
		const parentChat = { resource: parent } as IChat;
		let restoredResource: URI | undefined;
		const target = {
			_chatResourceHistory: history,
			_chatResourceOverride: child,
			_currentSession: { sessionId: 'session-1', activeChat: { get: () => parentChat } },
			_currentView: {
				value: {
					setChat: (chat: IChat) => { restoredResource = chat.resource; },
					setChatResource: () => false,
				},
			},
			_updateChatNavigation: () => { },
		};

		assert.strictEqual(SessionView.prototype.navigateBack.call(target as unknown as SessionView), true);
		assert.strictEqual(restoredResource?.toString(), parent.toString());
		assert.strictEqual(target._chatResourceOverride, undefined);
		assert.strictEqual(history.canGoBack, false);
	});

	test('session view restores the immediate parent of a nested subagent', () => {
		const history = new ChatResourceNavigationHistory();
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');
		const grandchild = URI.parse('chat-session://test/parent/subagent/child/subagent/grandchild');
		history.recordOpen(parent, child);
		history.recordOpen(child, grandchild);
		const parentChat = { resource: parent } as IChat;
		let restoredResource: URI | undefined;
		const target = {
			_chatResourceHistory: history,
			_chatResourceOverride: grandchild,
			_currentSession: { sessionId: 'session-1', activeChat: { get: () => parentChat } },
			_currentView: {
				value: {
					setChat: () => { },
					setChatResource: (resource: URI) => {
						restoredResource = resource;
						return true;
					},
				},
			},
			_updateChatNavigation: () => { },
		};

		assert.strictEqual(SessionView.prototype.navigateBack.call(target as unknown as SessionView), true);
		assert.strictEqual(restoredResource?.toString(), child.toString());
		assert.strictEqual(target._chatResourceOverride.toString(), child.toString());
		assert.strictEqual(history.previous?.toString(), parent.toString());
	});

	test('main-thread control skips directly over nested subagents', () => {
		const parent = URI.parse('chat-session://test/parent');
		const child = URI.parse('chat-session://test/parent/subagent/child');
		const grandchild = URI.parse('chat-session://test/parent/subagent/child/subagent/grandchild');
		const history = new ChatResourceNavigationHistory();
		history.recordOpen(parent, child);
		history.recordOpen(child, grandchild);
		const loaded: string[] = [];
		const target = {
			_chatResourceHistory: history,
			_chatResourceOverride: grandchild,
			_currentSession: {
				sessionId: 'session-1',
				activeChat: { get: () => ({ resource: parent }) },
			},
			_currentView: {
				value: {
					setChat: () => loaded.push(parent.toString()),
					setChatResource: (resource: URI) => {
						loaded.push(resource.toString());
						return true;
					},
				},
			},
			_updateChatNavigation: () => { },
		};

		assert.strictEqual(SessionView.prototype.navigateToMainThread.call(target as unknown as SessionView), true);
		assert.deepStrictEqual(loaded, [parent.toString()]);
		assert.strictEqual(history.canGoBack, false);
	});
});
