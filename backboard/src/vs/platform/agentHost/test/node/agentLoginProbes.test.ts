/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSubscriptionProbeEnv, isClaudeSubscriptionAuthStatus } from '../../node/shared/agentLoginProbes.js';

suite('Agent login probes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('probes the saved subscription without inherited API or cloud credentials', () => {
		const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/custom/claude', ANTHROPIC_API_KEY: 'key', ANTHROPIC_BASE_URL: 'https://proxy.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'token', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'profile' };
		assert.deepStrictEqual(claudeSubscriptionProbeEnv(env), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/custom/claude' });
		assert.strictEqual(env.ANTHROPIC_API_KEY, 'key');
	});

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
