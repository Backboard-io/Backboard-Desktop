/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentCliSetupService, CHATGPT_SUBSCRIPTION_SETUP_ID, CLAUDE_SUBSCRIPTION_SETUP_ID } from '../../../browser/agentSessions/agentCliSetup.js';

suite('Agent CLI setup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): AgentCliSetupService {
		// Any attempted dialog, terminal or authentication call fails this test.
		return new AgentCliSetupService({} as never, {} as never, {} as never, {} as never, {} as never,
			{} as never, {} as never, {} as never, {} as never, {} as never);
	}

	test('does not offer subscription setup or native agent installers', () => {
		assert.deepStrictEqual(createService().getSetupCandidates(new Set(['backboard'])), []);
	});

	for (const id of [CHATGPT_SUBSCRIPTION_SETUP_ID, CLAUDE_SUBSCRIPTION_SETUP_ID]) {
		test(`rejects stale setup actions for ${id} before accessing credentials or opening OAuth`, async () => {
			await assert.rejects(createService().beginSetup(id), /Subscriptions are currently unavailable/);
		});
	}
});
