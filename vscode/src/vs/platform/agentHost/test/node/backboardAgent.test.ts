/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createBackboardTurnSettings, type BackboardTurnSettings } from '../../node/backboard/backboardAgent.js';

function comparableSettings(settings: BackboardTurnSettings): Omit<BackboardTurnSettings, 'config'> {
	const { config: _config, ...rest } = settings;
	return rest;
}

suite('BackboardAgent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses side-panel-compatible defaults for bridge turn settings', () => {
		assert.deepStrictEqual(comparableSettings(createBackboardTurnSettings(undefined, undefined, undefined)), {
			provider: 'aws-bedrock',
			model: 'anthropic.claude-sonnet-4-6',
			mode: 'free',
			intensity: 'fast',
			memoryMode: 'Auto',
			webSearch: 'off',
			imageGeneration: 'off',
			mcpCalls: undefined,
		});
	});

	test('applies live session config to bridge settings', () => {
		const initialConfig = {
			mode: 'manual',
			intensity: 'balanced',
			memoryMode: 'off',
			webSearch: 'off',
			imageGeneration: 'off',
			mcpCalls: 'figma',
		};
		const liveConfig = {
			mode: 'free',
			intensity: 'deep',
			memoryMode: 'ProReadonly',
			webSearch: 'Auto',
			imageGeneration: 'auto',
			mcpCalls: 'figma,google',
		};

		assert.deepStrictEqual(comparableSettings(createBackboardTurnSettings(liveConfig, initialConfig, { id: 'openrouter/openai/gpt-5-chat' })), {
			provider: 'openrouter',
			model: 'openai/gpt-5-chat',
			mode: 'free',
			intensity: 'deep',
			memoryMode: 'ProReadonly',
			webSearch: 'Auto',
			imageGeneration: 'auto',
			mcpCalls: ['figma', 'google'],
		});
	});

	test('maps MCP dropdown values to bridge capability arrays', () => {
		assert.deepStrictEqual(createBackboardTurnSettings({ mcpCalls: 'all' }, undefined, undefined).mcpCalls, ['figma', 'notion', 'google']);
		assert.deepStrictEqual(createBackboardTurnSettings({ mcpCalls: 'notion,google' }, undefined, undefined).mcpCalls, ['notion', 'google']);
		assert.strictEqual(createBackboardTurnSettings({ mcpCalls: 'off' }, undefined, undefined).mcpCalls, undefined);
	});

	test('normalizes older config values before sending bridge settings', () => {
		assert.deepStrictEqual(comparableSettings(createBackboardTurnSettings({
			mode: 'interactive',
			memoryMode: 'Off',
			webSearch: 'on',
			imageGeneration: 'nope',
			mcpCalls: 'bogus',
		}, undefined, { id: 'gpt-5' })), {
			provider: 'aws-bedrock',
			model: 'gpt-5',
			mode: 'agent',
			intensity: 'fast',
			memoryMode: 'off',
			webSearch: 'Auto',
			imageGeneration: 'off',
			mcpCalls: undefined,
		});
	});
});
