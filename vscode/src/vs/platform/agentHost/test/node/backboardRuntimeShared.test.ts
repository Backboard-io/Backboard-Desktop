/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createBackboardTurnSettings, resolveBackboardSessionConfig } from '../../node/cliTs/backboardRuntimeShared.js';

suite('Backboard runtime configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('advertises the documented thinking states', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const intensity = resolved.schema.properties?.intensity;

		assert.deepStrictEqual(intensity?.enum, ['dynamic', 'off', 'default', 'low', 'medium', 'high', 'max']);
		assert.strictEqual(intensity?.default, 'dynamic');
		assert.strictEqual(resolved.values.intensity, 'dynamic');
		assert.strictEqual(resolved.schema.properties?.showReasoning, undefined);
		assert.strictEqual(resolved.values.showReasoning, undefined);
	});

	test('migrates legacy intensity names and ignores retired trace visibility', () => {
		const expected = new Map([
			['adaptive', 'dynamic'],
			['fast', 'low'],
			['balanced', 'medium'],
			['deep', 'high'],
			['off', 'off'],
			['max', 'max'],
		]);

		for (const [intensity, normalized] of expected) {
			const settings = createBackboardTurnSettings(
				{ intensity, showReasoning: false },
				undefined,
				{ id: 'openrouter/anthropic/claude-sonnet-5' },
			);
			assert.strictEqual(settings.intensity, normalized);
			assert.strictEqual('showReasoning' in settings, false);
		}
	});

	test('advertises image generation as a one-click toggle', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const images = resolved.schema.properties?.imageGeneration;

		assert.strictEqual(images?.type, 'boolean');
		assert.strictEqual(images?.default, false);
		assert.strictEqual(resolved.values.imageGeneration, false);
	});

	test('keeps the image toggle independent from the conversation model', () => {
		const settings = createBackboardTurnSettings(
			{ imageGeneration: true },
			undefined,
			{ id: 'openrouter/moonshotai/kimi-k3' },
		);
		assert.strictEqual(settings.provider, 'openrouter');
		assert.strictEqual(settings.model, 'moonshotai/kimi-k3');
		assert.strictEqual(settings.imageGeneration, true);

		const migrated = createBackboardTurnSettings(
			{ imageGeneration: 'openrouter/google/gemini-3.1-flash-image' },
			undefined,
			{ id: 'openai/gpt-5.5' },
		);
		assert.strictEqual(migrated.imageGeneration, true);
	});
});
