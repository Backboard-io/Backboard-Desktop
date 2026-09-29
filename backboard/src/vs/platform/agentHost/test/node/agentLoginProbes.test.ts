/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSubscriptionProbeEnv, isClaudeLoggedInRecently, isClaudeSubscriptionAuthStatus } from '../../node/shared/agentLoginProbes.js';

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

	test('probes Claude once while a verified login is trusted, and again after it lapses or fails', async () => {
		const homeDir = await fs.promises.mkdtemp(join(tmpdir(), 'claude-login-probe-'));
		try {
			let probes = 0;
			let loggedIn = true;
			const probe = async () => { probes++; return loggedIn; };
			const start = 1_000_000;
			const results = [
				await isClaudeLoggedInRecently(probe, homeDir, start),
				await isClaudeLoggedInRecently(probe, homeDir, start + 60_000),
			];
			const whileTrusted = probes;
			loggedIn = false;
			results.push(await isClaudeLoggedInRecently(probe, homeDir, start + 6 * 60_000));
			// A failed probe leaves nothing to trust.
			results.push(await isClaudeLoggedInRecently(probe, homeDir, start + 6 * 60_000 + 1));
			assert.deepStrictEqual({ results, whileTrusted, probes }, { results: [true, true, false, false], whileTrusted: 1, probes: 3 });
		} finally {
			await fs.promises.rm(homeDir, { recursive: true, force: true });
		}
	});
});
