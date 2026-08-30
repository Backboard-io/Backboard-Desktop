/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { filterAndRankModels } from '../../../../browser/widget/input/modelSearch.js';

interface TestModel {
	identifier: string;
	metadata: {
		id: string;
		name: string;
		family?: string;
		detail?: string;
	};
}

function model(id: string, name: string, detail?: string): TestModel {
	return { identifier: `backboard:${id}`, metadata: { id, name, detail } };
}

suite('ModelSearch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const models = [
		model('anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5', 'Anthropic'),
		model('openai/gpt-5.6-sol', 'openai/gpt-5.6-sol', 'OpenAI'),
		model('cerebras/z-ai/glm-4.7', 'cerebras/z-ai/glm-4.7', 'Cerebras'),
	];

	test('matches separators and compact queries', () => {
		assert.deepStrictEqual(filterAndRankModels(models, 'gpt 5.6').map(entry => entry.metadata.id), ['openai/gpt-5.6-sol']);
		assert.deepStrictEqual(filterAndRankModels(models, 'glm47').map(entry => entry.metadata.id), ['cerebras/z-ai/glm-4.7']);
	});

	test('matches adjacent typos', () => {
		assert.deepStrictEqual(filterAndRankModels(models, 'cluade sonnet').map(entry => entry.metadata.id), ['anthropic/claude-sonnet-5']);
	});

	test('ranks exact and prefix matches before weaker fuzzy matches', () => {
		const ranked = filterAndRankModels([
			model('vendor/x-gpt-5.6', 'vendor/x-gpt-5.6'),
			model('openai/gpt-5.6-sol', 'gpt-5.6-sol'),
		], 'gpt 5.6');
		assert.strictEqual(ranked[0].metadata.id, 'openai/gpt-5.6-sol');
	});
});
