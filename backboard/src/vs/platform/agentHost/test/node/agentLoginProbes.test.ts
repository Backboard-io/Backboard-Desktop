/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isClaudeSubscriptionAuthStatus } from '../../node/shared/agentLoginProbes.js';

suite('Agent login probes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only first-party Claude.ai subscription status', () => {
		assert.strictEqual(isClaudeSubscriptionAuthStatus({
			loggedIn: true,
			authMethod: 'claude.ai',
			apiProvider: 'firstParty',
		}), true);
		assert.strictEqual(isClaudeSubscriptionAuthStatus({
			loggedIn: true,
			authMethod: 'apiKey',
			apiProvider: 'firstParty',
		}), false);
		assert.strictEqual(isClaudeSubscriptionAuthStatus({
			loggedIn: true,
			authMethod: 'claude.ai',
			apiProvider: 'bedrock',
		}), false);
		assert.strictEqual(isClaudeSubscriptionAuthStatus({ loggedIn: false }), false);
	});
});
