/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ForkConversationAction } from '../../browser/actions/chatForkActions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveAgentHostForkIndex } from '../../browser/agentSessions/agentHost/agentHostFork.js';

suite('Agent host fork checkpoints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const turns = [{ id: 'first' }, { id: 'second' }];

	test('fork is enabled for agent-host and fork-capable sessions without the default participant', () => {
		const action = new ForkConversationAction();
		const enabled = (values: Record<string, boolean>) => action.desc.precondition?.evaluate({ getValue: <T>(key: string) => values[key] as T });
		assert.deepStrictEqual([
			enabled({ [ChatContextKeys.enabled.key]: false, [ChatContextKeys.chatIsAgentHostSession.key]: true }),
			enabled({ [ChatContextKeys.enabled.key]: false, [ChatContextKeys.chatSessionSupportsFork.key]: true }),
			enabled({ [ChatContextKeys.enabled.key]: true }),
			enabled({}),
		], [true, true, true, false]);
	});

	test('forks before a completed or active message, or all completed history', () => {
		assert.deepStrictEqual([
			resolveAgentHostForkIndex(turns, 'active', 'second'),
			resolveAgentHostForkIndex(turns, 'active', 'active'),
			resolveAgentHostForkIndex(turns, 'active', undefined),
		], [0, 1, 1]);
	});

	test('never substitutes full history for an unavailable checkpoint', () => {
		assert.throws(() => resolveAgentHostForkIndex(turns, 'active', 'missing'));
		assert.throws(() => resolveAgentHostForkIndex(turns, 'active', 'first'));
		assert.throws(() => resolveAgentHostForkIndex([], 'active', 'active'));
	});
});
