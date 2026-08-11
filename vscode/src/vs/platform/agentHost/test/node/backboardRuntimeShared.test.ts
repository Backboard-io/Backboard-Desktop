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
		assert.strictEqual(resolved.values.showReasoning, true);
	});

	test('migrates legacy intensity names and keeps trace visibility', () => {
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
			assert.strictEqual(settings.showReasoning, false);
		}
	});
});
