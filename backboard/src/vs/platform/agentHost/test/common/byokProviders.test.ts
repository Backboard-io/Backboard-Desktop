/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { byokProviderDefinition, isByokProviderId, isConfigPropertyAvailableForModel, keyBilledProviderId, parseBillingRoute, routeProviderFamily, subscriptionPlanOfAgentType, subscriptionPlanOfModelId, vendorOfProvider } from '../../common/byokProviders.js';

suite('byokProviders', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses billing routes from IDE model ids', () => {
		assert.deepStrictEqual(
			[
				parseBillingRoute('openai-key/gpt-5.5'),
				parseBillingRoute('openrouter-key/anthropic/claude-sonnet-4.6'),
				parseBillingRoute('google-key/gemini-2.5-flash'),
				parseBillingRoute('xai-key/grok-4.6'),
				parseBillingRoute('anthropic/claude-opus-5'),
				parseBillingRoute('openai-subscription/gpt-5.5'),
				parseBillingRoute('openrouter/openai/gpt-5-chat'),
				parseBillingRoute('gpt-5.5'),
				parseBillingRoute(undefined),
			],
			[
				{ source: 'byok', provider: 'openai', model: 'gpt-5.5' },
				{ source: 'byok', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
				{ source: 'byok', provider: 'google', model: 'gemini-2.5-flash' },
				{ source: 'byok', provider: 'xai', model: 'grok-4.6' },
				{ source: 'backboard', provider: 'anthropic', model: 'claude-opus-5' },
				{ source: 'subscription', provider: 'openai-subscription', model: 'gpt-5.5' },
				{ source: 'backboard', provider: 'openrouter', model: 'openai/gpt-5-chat' },
				undefined,
				undefined,
			],
		);
	});

	test('groups every key-billed vendor into one handoff family', () => {
		assert.deepStrictEqual(
			{
				families: ['openai-key', 'Anthropic-Key', 'openai', 'openai-subscription'].map(routeProviderFamily),
				keyBilled: keyBilledProviderId('openai'),
				vendor: vendorOfProvider('openai-key'),
				unsupported: isByokProviderId('unsupported'),
			},
			{
				families: ['byok', 'byok', 'openai', 'openai-subscription'],
				keyBilled: 'openai-key',
				vendor: 'openai',
				unsupported: false,
			},
		);
	});

	test('hides Backboard media for key and subscription models, and memory only for keys', () => {
		const models = ['anthropic/claude-opus-5', 'openai-key/gpt-5.5', 'backboard:openai-subscription/gpt-5.5', 'anthropic-subscription/opus[1m]', undefined];
		assert.deepStrictEqual(
			['imageModel', 'videoModel', 'imageGeneration', 'askBeforeGenerating', 'memory', 'webSearch'].map(property => models.map(model => isConfigPropertyAvailableForModel(property, model))),
			[
				[true, false, false, false, true],
				[true, false, false, false, true],
				[true, false, false, false, true],
				[true, false, false, false, true],
				[true, false, true, true, true],
				[true, true, true, true, true],
			],
		);
	});

	test('names the subscription a model bills to', () => {
		assert.deepStrictEqual(
			['anthropic-subscription/opus', 'agent-host-backboard:openai-subscription/gpt-5.5', 'anthropic/claude-opus-5', 'openai-key/gpt-5.5', 'opus', undefined].map(subscriptionPlanOfModelId),
			['claude', 'chatgpt', undefined, undefined, undefined, undefined],
		);
		assert.deepStrictEqual(
			['claude-code', 'agent-host-codex', 'openai-codex', 'agent-host-backboard', 'local', undefined].map(subscriptionPlanOfAgentType),
			['claude', 'chatgpt', 'chatgpt', undefined, undefined, undefined],
		);
	});

	test('checks key shapes locally before any network call', () => {
		const openai = byokProviderDefinition('openai');
		const anthropic = byokProviderDefinition('anthropic');
		assert.deepStrictEqual(
			[
				openai.looksLikeKey(`sk-${'a'.repeat(32)}`),
				openai.looksLikeKey('not a key'),
				anthropic.looksLikeKey(`sk-ant-${'b'.repeat(32)}`),
				anthropic.looksLikeKey(`sk-${'a'.repeat(32)}`),
			],
			[true, false, true, false],
		);
	});
});
