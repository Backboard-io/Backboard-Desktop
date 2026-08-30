/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_MULTITASK, backboardMultitaskSystemContext, createBackboardTurnSettings, resolveBackboardSessionConfig } from '../../node/cliTs/backboardRuntimeShared.js';

suite('Backboard runtime configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('advertises explicit reasoning levels with a balanced default', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const intensity = resolved.schema.properties?.intensity;

		assert.deepStrictEqual(intensity?.enum, ['off', 'low', 'medium', 'high', 'max']);
		assert.strictEqual(intensity?.default, 'medium');
		assert.strictEqual(resolved.values.intensity, 'medium');
		assert.strictEqual(resolved.schema.properties?.showReasoning, undefined);
		assert.strictEqual(resolved.values.showReasoning, undefined);
	});

	test('migrates legacy intensity names and ignores retired trace visibility', () => {
		const expected = new Map([
			['adaptive', 'medium'],
			['dynamic', 'medium'],
			['default', 'medium'],
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

	test('keeps web search automatic and out of composer configuration', () => {
		const resolved = resolveBackboardSessionConfig({ webSearch: false });
		assert.strictEqual(resolved.schema.properties?.webSearch, undefined);
		assert.strictEqual(resolved.values.webSearch, true);

		const settings = createBackboardTurnSettings(
			{ webSearch: false },
			undefined,
			{ id: 'openai/gpt-5.5' },
		);
		assert.strictEqual(settings.webSearch, true);
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

	test('offers isolated worktrees for Git repositories and folder mode elsewhere', () => {
		const nonGit = resolveBackboardSessionConfig(undefined);
		assert.deepStrictEqual(nonGit.schema.properties?.isolation?.enum, ['folder']);
		assert.strictEqual(nonGit.schema.properties?.isolation?.readOnly, true);
		assert.strictEqual(nonGit.values.isolation, 'folder');
		assert.strictEqual(nonGit.schema.properties?.branch, undefined);

		const repository = { currentBranch: 'feature/current', defaultBranch: 'origin/main' };
		const isolated = resolveBackboardSessionConfig(undefined, repository);
		assert.deepStrictEqual(isolated.schema.properties?.isolation?.enum, ['folder', 'worktree']);
		assert.strictEqual(isolated.values.isolation, 'worktree');
		assert.strictEqual(isolated.values.branch, 'origin/main');
		assert.strictEqual(isolated.schema.properties?.branch?.enumDynamic, true);
		assert.strictEqual(isolated.schema.properties?.branch?.readOnly, false);

		const folder = resolveBackboardSessionConfig({ isolation: 'folder', branch: 'stale-branch' }, repository);
		assert.strictEqual(folder.values.isolation, 'folder');
		assert.strictEqual(folder.values.branch, 'feature/current');
		assert.strictEqual(folder.schema.properties?.branch?.enumDynamic, false);
		assert.strictEqual(folder.schema.properties?.branch?.readOnly, true);
	});

	test('Multitask mode enables coordinator guidance without changing approval safety', () => {
		const resolved = resolveBackboardSessionConfig({ mode: BACKBOARD_MODE_MULTITASK });
		assert.ok(resolved.schema.properties?.mode?.enum?.includes(BACKBOARD_MODE_MULTITASK));
		assert.strictEqual(resolved.values.mode, BACKBOARD_MODE_MULTITASK);

		const settings = createBackboardTurnSettings(
			{ mode: BACKBOARD_MODE_MULTITASK },
			undefined,
			{ id: 'openai/gpt-5.5' },
		);
		assert.strictEqual(settings.rawMode, BACKBOARD_MODE_MULTITASK);
		assert.strictEqual(settings.accessMode, BACKBOARD_ACCESS_DEFAULT);
		assert.match(backboardMultitaskSystemContext(settings.rawMode) ?? '', /same assistant message/);
		assert.match(backboardMultitaskSystemContext(settings.rawMode) ?? '', /non-overlapping set of files/);
		assert.match(backboardMultitaskSystemContext(settings.rawMode) ?? '', /smallest number of workers/);
		assert.match(backboardMultitaskSystemContext(settings.rawMode) ?? '', /never create several workers for trivial checks/);
		assert.match(backboardMultitaskSystemContext(settings.rawMode) ?? '', /short action-oriented purpose line/);
		assert.strictEqual(backboardMultitaskSystemContext(BACKBOARD_ACCESS_DEFAULT), undefined);
	});
});
