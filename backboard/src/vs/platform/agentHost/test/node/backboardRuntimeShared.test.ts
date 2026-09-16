/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BACKBOARD_ACCESS_DEFAULT, BACKBOARD_MODE_MULTITASK, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS, backboardModelInfos, backboardModelInfosForPlatform, backboardMultitaskSystemContext, createBackboardTurnSettings, resolveBackboardSessionConfig } from '../../node/cliTs/backboardRuntimeShared.js';

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

	for (const windows of [true, false]) {
		test(`filters bundled, cached and live subscription routes for Windows=${windows}`, () => {
			const models = backboardModelInfosForPlatform(windows, [
				{ provider: 'openai-subscription', name: 'account-model' },
				{ provider: 'anthropic-subscription', name: 'default' },
				{ provider: 'openai', name: 'gpt-5.5' },
				{ provider: 'anthropic', name: 'claude-sonnet-5' },
			], BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS);
			assert.strictEqual(models.some(model => model.id.startsWith('openai-subscription/')), false);
			assert.strictEqual(models.some(model => model.id.startsWith('anthropic-subscription/')), false);
			assert.ok(models.some(model => model.id === 'openai/gpt-5.5'));
			assert.ok(models.some(model => model.id === 'anthropic/claude-sonnet-5'));
			const bundled = backboardModelInfosForPlatform(windows, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS);
			assert.strictEqual(bundled.some(model => model.id.includes('-subscription/')), false);
		});
	}

	test('reports the runtime billing route on catalog metadata', () => {
		const models = backboardModelInfos([
			{ provider: 'openai', name: 'gpt-5.5', modelType: 'llm', source: 'byok' },
			{ provider: 'anthropic', name: 'claude-opus-5', modelType: 'llm', source: 'Backboard' },
			{ provider: 'google', name: 'gemini-3-pro', modelType: 'llm' },
			{ provider: 'xai', name: 'grok-4.5', modelType: 'llm', source: 'mystery' },
		]);
		const billing = new Map(models.map(model => [model.id, model._meta?.billingSource]));

		assert.strictEqual(billing.get('openai/gpt-5.5'), 'byok');
		assert.strictEqual(billing.get('anthropic/claude-opus-5'), 'backboard');
		assert.strictEqual(billing.get('google/gemini-3-pro'), undefined);
		assert.strictEqual(billing.get('xai/grok-4.5'), undefined);
	});

	test('builds OpenRouter serving-provider choices from live catalog metadata', () => {
		const [model] = backboardModelInfos([{
			provider: 'openrouter',
			name: 'deepseek/deepseek-chat-v3.1',
			modelType: 'llm',
			openrouter_providers: [
				{ upstream_provider: 'Novita', input_cost_per_1m_tokens: 0.27, output_cost_per_1m_tokens: 1, uptime_30m: 99.91 },
				{ upstream_provider: 'DeepInfra', input_cost_per_1m_tokens: 0.25, output_cost_per_1m_tokens: 0.95, uptime_30m: 99.99 },
			],
		}]);
		const routing = model.configSchema?.properties.openRouterProvider;

		assert.deepStrictEqual(routing?.enum, ['auto', 'DeepInfra', 'Novita']);
		assert.deepStrictEqual(routing?.enumLabels, ['Auto', 'DeepInfra', 'Novita']);
		assert.strictEqual(model._meta?.openRouterProviderCount, 2);
	});

	test('reads a pinned OpenRouter provider from model configuration only', () => {
		const pinned = createBackboardTurnSettings(undefined, undefined, {
			id: 'openrouter/deepseek/deepseek-chat-v3.1',
			config: { openRouterProvider: 'DeepInfra' },
		});
		assert.strictEqual(pinned.openRouterProvider, 'DeepInfra');

		const automatic = createBackboardTurnSettings(undefined, undefined, {
			id: 'openrouter/deepseek/deepseek-chat-v3.1',
			config: { openRouterProvider: 'auto' },
		});
		assert.strictEqual(automatic.openRouterProvider, undefined);

		const nonOpenRouter = createBackboardTurnSettings(undefined, undefined, {
			id: 'openai/gpt-5.5',
			config: { openRouterProvider: 'DeepInfra' },
		});
		assert.strictEqual(nonOpenRouter.openRouterProvider, undefined);
	});

	test('uses model-specific Claude effort and defers Haiku to Claude Code', () => {
		const opus = createBackboardTurnSettings(
			{ intensity: 'low' },
			undefined,
			{ id: 'anthropic-subscription/opus[1m]', config: { intensity: 'xhigh' } },
		);
		assert.strictEqual(opus.intensity, 'xhigh');

		const defaultOpus = createBackboardTurnSettings(undefined, undefined, {
			id: 'anthropic-subscription/default',
		});
		assert.strictEqual(defaultOpus.intensity, 'high');

		const haiku = createBackboardTurnSettings(
			{ intensity: 'max' },
			undefined,
			{ id: 'anthropic-subscription/haiku' },
		);
		assert.strictEqual(haiku.intensity, 'default');
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

	test('defaults to the fast direct folder path while keeping explicit worktree isolation available', () => {
		const nonGit = resolveBackboardSessionConfig(undefined);
		assert.deepStrictEqual(nonGit.schema.properties?.isolation?.enum, ['folder']);
		assert.strictEqual(nonGit.schema.properties?.isolation?.readOnly, true);
		assert.strictEqual(nonGit.values.isolation, 'folder');
		assert.strictEqual(nonGit.schema.properties?.branch, undefined);

		const repository = { currentBranch: 'feature/current', defaultBranch: 'origin/main' };
		const folder = resolveBackboardSessionConfig(undefined, repository);
		assert.deepStrictEqual(folder.schema.properties?.isolation?.enum, ['folder', 'worktree']);
		assert.strictEqual(folder.values.isolation, 'folder');
		assert.strictEqual(folder.values.branch, 'feature/current');
		assert.strictEqual(folder.schema.properties?.branch?.enumDynamic, false);
		assert.strictEqual(folder.schema.properties?.branch?.readOnly, true);

		const isolated = resolveBackboardSessionConfig({ isolation: 'worktree' }, repository);
		assert.strictEqual(isolated.values.isolation, 'worktree');
		assert.strictEqual(isolated.values.branch, 'origin/main');
		assert.strictEqual(isolated.schema.properties?.branch?.enumDynamic, true);
		assert.strictEqual(isolated.schema.properties?.branch?.readOnly, false);
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
