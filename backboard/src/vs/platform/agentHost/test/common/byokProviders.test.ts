/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { byokProviderDefinition, isByokProviderId, keyBilledProviderId, parseBillingRoute, routeProviderFamily, vendorOfProvider } from '../../common/byokProviders.js';

suite('byokProviders', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses billing routes from IDE model ids', () => {
		assert.deepStrictEqual(
			[
				parseBillingRoute('openai-key/gpt-5.5'),
				parseBillingRoute('anthropic/claude-opus-5'),
				parseBillingRoute('openai-subscription/gpt-5.5'),
				parseBillingRoute('openrouter/openai/gpt-5-chat'),
				parseBillingRoute('gpt-5.5'),
				parseBillingRoute(undefined),
			],
			[
				{ source: 'byok', provider: 'openai', model: 'gpt-5.5' },
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
				unsupported: isByokProviderId('google'),
			},
			{
				families: ['byok', 'byok', 'openai', 'openai-subscription'],
				keyBilled: 'openai-key',
				vendor: 'openai',
				unsupported: false,
			},
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
