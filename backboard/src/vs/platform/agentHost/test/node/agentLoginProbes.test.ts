/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSubscriptionProbeEnv, ensureClaudeCodeReady, isClaudeCodeOutdated, isClaudeLoggedInRecently, isClaudeSubscriptionAuthStatus } from '../../node/shared/agentLoginProbes.js';

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

	test('offers a Claude Code update only when the install is older than stable', () => {
		assert.deepStrictEqual([
			isClaudeCodeOutdated('2.1.172 (Claude Code)', '2.1.285'),
			isClaudeCodeOutdated('2.1.285', '2.1.285'),
			isClaudeCodeOutdated('2.1.287', '2.1.285'),
			isClaudeCodeOutdated('2.2.0', '2.1.285'),
			isClaudeCodeOutdated('1.9.999', '2.0.0'),
			isClaudeCodeOutdated('unknown', '2.1.285'),
		], [true, false, false, false, true, false]);
	});

	suite('ensureClaudeCodeReady', () => {
		function fakeClaude(initial: { binary?: string; version?: string }, opts: { updateFails?: boolean; updateKeepsOld?: boolean } = {}) {
			const state = { ...initial, calls: [] as string[] };
			const latest = '2.1.285';
			return {
				state,
				ops: {
					resolve: async () => state.binary,
					supportsAuth: async () => !!state.version && !isClaudeCodeOutdated(state.version, '2.1.30'),
					versionStatus: async () => state.version ? { installed: state.version, latest, updateAvailable: isClaudeCodeOutdated(state.version, latest) } : undefined,
					install: async () => { state.calls.push('install'); state.binary = '/home/.local/bin/claude'; state.version = latest; },
					update: async () => {
						state.calls.push('update');
						if (opts.updateFails) {
							throw new Error('EACCES');
						}
						if (!opts.updateKeepsOld) {
							state.version = latest;
						}
					},
				},
			};
		}

		test('installs Claude Code when it is missing', async () => {
			const { state, ops } = fakeClaude({});
			assert.deepStrictEqual({ ready: await ensureClaudeCodeReady(ops), calls: state.calls }, { ready: { executable: '/home/.local/bin/claude', installed: true, updated: false }, calls: ['install'] });
		});

		test('updates an install too old for `claude auth login`', async () => {
			const { state, ops } = fakeClaude({ binary: '/usr/local/bin/claude', version: '2.0.30' });
			assert.deepStrictEqual({ ready: await ensureClaudeCodeReady(ops), calls: state.calls }, { ready: { executable: '/usr/local/bin/claude', installed: false, updated: true }, calls: ['update'] });
		});

		test('falls back to a native install when the old copy cannot be updated', async () => {
			const { state, ops } = fakeClaude({ binary: '/usr/local/bin/claude', version: '2.0.30' }, { updateFails: true });
			assert.deepStrictEqual({ ready: await ensureClaudeCodeReady(ops), calls: state.calls }, { ready: { executable: '/home/.local/bin/claude', installed: true, updated: false }, calls: ['update', 'install'] });
		});

		test('updates an outdated install that can already sign in, and tolerates a failed update', async () => {
			const updated = fakeClaude({ binary: '/b/claude', version: '2.1.200' });
			const failed = fakeClaude({ binary: '/b/claude', version: '2.1.200' }, { updateFails: true });
			assert.deepStrictEqual([
				(await ensureClaudeCodeReady(updated.ops)).updated,
				(await ensureClaudeCodeReady(failed.ops)).updated,
				failed.state.calls,
			], [true, false, ['update']]);
		});

		test('leaves a current install alone', async () => {
			const { state, ops } = fakeClaude({ binary: '/b/claude', version: '2.1.285' });
			assert.deepStrictEqual({ ready: await ensureClaudeCodeReady(ops), calls: state.calls }, { ready: { executable: '/b/claude', installed: false, updated: false }, calls: [] });
		});
	});
});
