/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BACKBOARD_ACCESS_DEFAULT, BACKBOARD_ACCESS_FULL, BACKBOARD_MODE_MULTITASK, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS, backboardAccessSystemContext, backboardModelInfos, backboardMultitaskSystemContext, createBackboardTurnSettings, resolveBackboardSessionConfig } from '../../node/cliTs/backboardRuntimeShared.js';

suite('Backboard runtime configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks only exact-$0, non-router OpenRouter models as free, like the server', () => {
		const models = backboardModelInfos([
			{ provider: 'openrouter', name: 'cohere/north-mini-code:free', model_type: 'llm', source: 'backboard', input_cost_per_1m_tokens: 0, output_cost_per_1m_tokens: 0, cached_input_cost_per_1m_tokens: null },
			{ provider: 'openrouter', name: 'openrouter/free', model_type: 'llm', source: 'backboard', input_cost_per_1m_tokens: 0, output_cost_per_1m_tokens: 0 },
			{ provider: 'openrouter', name: 'x/cached-costs', model_type: 'llm', source: 'backboard', input_cost_per_1m_tokens: '0', output_cost_per_1m_tokens: 0, cached_input_cost_per_1m_tokens: 0.01 },
			{ provider: 'openrouter', name: 'deepseek/deepseek-v4-flash', model_type: 'llm', source: 'backboard', input_cost_per_1m_tokens: 0.0785, output_cost_per_1m_tokens: 0.157 },
			{ provider: 'openai', name: 'gpt-free', model_type: 'llm', source: 'backboard', input_cost_per_1m_tokens: 0, output_cost_per_1m_tokens: 0 },
		]);
		assert.deepStrictEqual(models.filter(model => model._meta?.priceCategory === 'free').map(model => model.id), ['openrouter/cohere/north-mini-code:free']);
	});

	test('advertises explicit reasoning levels with a balanced default', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const intensity = resolved.schema.properties?.intensity;

		assert.deepStrictEqual(intensity?.enum, ['off', 'low', 'medium', 'high', 'max']);
		assert.strictEqual(intensity?.default, 'medium');
		assert.strictEqual(resolved.values.intensity, 'medium');
		assert.strictEqual(resolved.schema.properties?.showReasoning, undefined);
		assert.strictEqual(resolved.values.showReasoning, undefined);
	});

	test('starts new chats with Computer Use off and keeps an explicit choice', () => {
		const resolved = resolveBackboardSessionConfig(undefined);

		assert.strictEqual(resolved.schema.properties?.computerUse?.default, false);
		assert.strictEqual(resolved.values.computerUse, false);
		assert.strictEqual(createBackboardTurnSettings(undefined, undefined, undefined).computerUse, false);
		assert.strictEqual(resolveBackboardSessionConfig({ computerUse: true }).values.computerUse, true);
		assert.strictEqual(createBackboardTurnSettings({ computerUse: true }, undefined, undefined).computerUse, true);
	});

	test('derives the billing route from the selected model id', () => {
		const keyBilled = createBackboardTurnSettings(undefined, undefined, { id: 'openai-key/gpt-5.5' });
		const backboard = createBackboardTurnSettings(undefined, undefined, { id: 'openai/gpt-5.5' });
		const subscription = createBackboardTurnSettings(undefined, undefined, { id: 'anthropic-subscription/opus[1m]' });

		assert.deepStrictEqual(
			[
				{ provider: keyBilled.provider, model: keyBilled.model, source: keyBilled.source },
				{ provider: backboard.provider, model: backboard.model, source: backboard.source },
				{ provider: subscription.provider, model: subscription.model, source: subscription.source, intensity: subscription.intensity },
			],
			[
				{ provider: 'openai', model: 'gpt-5.5', source: 'byok' },
				{ provider: 'openai', model: 'gpt-5.5', source: 'backboard' },
				{ provider: 'anthropic-subscription', model: 'opus[1m]', source: 'subscription', intensity: 'high' },
			],
		);
	});

	test('keeps a Backboard media selection off key and subscription turns', () => {
		const media = { imageModel: 'google/gemini-3.1-flash-image', videoModel: 'openrouter/google/veo-3.1-lite' };
		const turns = ['openai/gpt-5.5', 'openai-key/gpt-5.5', 'openai-subscription/gpt-5.5', 'anthropic-subscription/opus[1m]']
			.map(id => createBackboardTurnSettings(media, undefined, { id }));

		assert.deepStrictEqual(turns.map(turn => [turn.imageGeneration, turn.imageModel, turn.videoGeneration, turn.videoModel]), [
			[true, { provider: 'google', name: 'gemini-3.1-flash-image' }, true, { provider: 'openrouter', name: 'google/veo-3.1-lite' }],
			[false, undefined, false, undefined],
			[false, undefined, false, undefined],
			[false, undefined, false, undefined],
		]);
	});

	test('lists key-billed models beside the Backboard rows under their own provider label', () => {
		const models = backboardModelInfos([
			{ provider: 'openai-key', name: 'gpt-5.5', model_type: 'llm' },
			{ provider: 'openai', name: 'gpt-5.5', model_type: 'llm' },
			{ provider: 'anthropic-key', name: 'claude-opus-5', model_type: 'llm' },
		]);

		assert.deepStrictEqual(models.map(model => [model.id, model._meta?.upstreamProvider, model._meta?.upstreamProviderLabel]), [
			['anthropic-key/claude-opus-5', 'anthropic-key', 'Anthropic API Key'],
			['openai/gpt-5.5', 'openai', 'OpenAI'],
			['openai-key/gpt-5.5', 'openai-key', 'OpenAI API Key'],
			['openrouter/openai/gpt-5-chat', 'openrouter', 'OpenRouter'],
		]);
	});

	test('bundles ChatGPT subscription models as distinct Backboard harness routes', () => {
		const models = backboardModelInfos(BUNDLED_CHATGPT_SUBSCRIPTION_MODELS);
		const subscriptionModels = models.filter(model => model.id.startsWith('openai-subscription/'));

		assert.deepStrictEqual(subscriptionModels.map(model => model.id), [
			'openai-subscription/gpt-5.4',
			'openai-subscription/gpt-5.4-mini',
			'openai-subscription/gpt-5.5',
			'openai-subscription/gpt-5.6-luna',
			'openai-subscription/gpt-5.6-sol',
			'openai-subscription/gpt-5.6-terra',
		]);
		for (const model of subscriptionModels) {
			assert.strictEqual(model.provider, 'backboard');
			assert.strictEqual(model.supportsVision, true);
			assert.strictEqual(model._meta?.upstreamProvider, 'openai-subscription');
			assert.strictEqual(model._meta?.upstreamProviderLabel, 'OpenAI (ChatGPT Subscription)');
		}
	});

	test('bundles the current Claude Code subscription fallback routes', () => {
		const models = backboardModelInfos(BUNDLED_CLAUDE_SUBSCRIPTION_MODELS);
		const subscriptionModels = models.filter(model => model.id.startsWith('anthropic-subscription/'));

		assert.deepStrictEqual(subscriptionModels.map(model => model.id), [
			'anthropic-subscription/claude-fable-5-1',
			'anthropic-subscription/claude-haiku-4-5-20251001',
			'anthropic-subscription/claude-opus-5-5',
			'anthropic-subscription/claude-sonnet-5-5',
		]);
		for (const model of subscriptionModels) {
			assert.strictEqual(model.provider, 'backboard');
			assert.strictEqual(model.supportsVision, true);
			assert.strictEqual(model._meta?.upstreamProvider, 'anthropic-subscription');
			assert.strictEqual(model._meta?.upstreamProviderLabel, 'Claude Subscription');
		}
		assert.deepStrictEqual(subscriptionModels.find(model => model.id === 'anthropic-subscription/claude-opus-5-5')?.configSchema?.properties.intensity.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
		assert.strictEqual(subscriptionModels.find(model => model.id === 'anthropic-subscription/claude-opus-5-5')?.configSchema?.properties.intensity.default, 'high');
		assert.strictEqual(subscriptionModels.find(model => model.id === 'anthropic-subscription/claude-haiku-4-5-20251001')?.configSchema, undefined);
		assert.strictEqual(subscriptionModels.find(model => model.id === 'anthropic-subscription/claude-opus-5-5')?.maxContextWindow, 200_000);
	});

	test('uses Claude Code live model names and does not add unavailable bundled aliases', () => {
		const models = backboardModelInfos([
			{
				provider: 'anthropic-subscription',
				name: 'default',
				display_name: 'Claude Default (Opus 5)',
				description: 'Opus 5 with 1M context',
				resolved_model: 'claude-opus-5[1m]',
				context_limit: 1_000_000,
				model_type: 'llm',
				supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
			},
			{
				provider: 'anthropic-subscription',
				name: 'haiku',
				display_name: 'Claude Haiku 4.5',
				model_type: 'llm',
				supported_effort_levels: [],
			},
		], BUNDLED_CLAUDE_SUBSCRIPTION_MODELS)
			.filter(model => model.id.startsWith('anthropic-subscription/'));

		assert.deepStrictEqual(models.map(model => model.id), [
			'anthropic-subscription/default',
			'anthropic-subscription/haiku',
		]);
		assert.strictEqual(models[0]?.name, 'Claude Default (Opus 5)');
		assert.strictEqual(models[0]?._meta?.modelDescription, 'Opus 5 with 1M context');
		assert.strictEqual(models[1]?.configSchema, undefined);
		// Claude subscription routes are vision-capable even though the live
		// catalog (and older persisted caches) omit the capability flag.
		assert.deepStrictEqual(models.map(model => model.supportsVision), [true, true]);
	});

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

	test('advertises image and video generation as pickers that default to the best models', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const images = resolved.schema.properties?.imageModel;
		const video = resolved.schema.properties?.videoModel;
		assert.deepStrictEqual(
			[images?.type, images?.default, images?.enumDynamic, images?.enum, resolved.values.imageModel, video?.type, video?.default, video?.enumDynamic, video?.enum, resolved.values.videoModel],
			['string', 'openrouter/openai/gpt-5.4-image-2', true, ['openrouter/openai/gpt-5.4-image-2'], 'openrouter/openai/gpt-5.4-image-2', 'string', 'openrouter/bytedance/seedance-2.5', true, ['openrouter/bytedance/seedance-2.5'], 'openrouter/bytedance/seedance-2.5'],
		);
	});

	test('keeps image and video generation on for Backboard models, even for stored off values', () => {
		const settings = (config: Record<string, unknown> | undefined, id = 'openai/gpt-5.5') => {
			const turn = createBackboardTurnSettings(config, undefined, { id });
			return [turn.imageGeneration, turn.imageModel, turn.videoGeneration, turn.videoModel];
		};
		const defaults = [true, { provider: 'openrouter', name: 'openai/gpt-5.4-image-2' }, true, { provider: 'openrouter', name: 'bytedance/seedance-2.5' }];
		assert.deepStrictEqual([
			settings(undefined),
			settings({ imageModel: 'off', videoModel: 'off' }),
			settings({ imageGeneration: false, videoGeneration: false }),
		], [defaults, defaults, defaults]);
	});

	test('asks before generating by default, only where Backboard media runs', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const schema = resolved.schema.properties?.askBeforeGenerating;
		assert.deepStrictEqual(
			[schema?.type, schema?.title, schema?.default, schema?.sessionMutable, resolved.values.askBeforeGenerating, resolveBackboardSessionConfig({ askBeforeGenerating: false }).values.askBeforeGenerating],
			['boolean', 'Ask Before Generating', true, true, true, false],
		);
		// Listed right after the media pickers so the + menu shows it beside them.
		const keys = Object.keys(resolved.schema.properties ?? {});
		assert.strictEqual(keys.indexOf('askBeforeGenerating'), keys.indexOf('videoModel') + 1);

		const turnAsks = (config: Record<string, unknown> | undefined, id = 'openai/gpt-5.5') => createBackboardTurnSettings(config, undefined, { id }).askBeforeGenerating;
		assert.deepStrictEqual(
			[turnAsks(undefined), turnAsks({ askBeforeGenerating: false }), turnAsks({ askBeforeGenerating: true }), turnAsks(undefined, 'openai-key/gpt-5.5'), turnAsks(undefined, 'anthropic-subscription/opus[1m]')],
			[true, false, true, false, false],
		);
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

	test('keeps the image and video pickers independent from the conversation model', () => {
		const settings = createBackboardTurnSettings(
			{ imageModel: 'google/gemini-3.1-flash-image' },
			undefined,
			{ id: 'openrouter/moonshotai/kimi-k3' },
		);
		assert.strictEqual(settings.provider, 'openrouter');
		assert.strictEqual(settings.model, 'moonshotai/kimi-k3');
		assert.strictEqual(settings.imageGeneration, true);
		assert.deepStrictEqual(settings.imageModel, { provider: 'google', name: 'gemini-3.1-flash-image' });
		assert.deepStrictEqual(settings.videoModel, { provider: 'openrouter', name: 'bytedance/seedance-2.5' });

		const video = createBackboardTurnSettings(
			{ videoModel: 'openrouter/google/veo-3.1' },
			undefined,
			{ id: 'openai/gpt-5.5' },
		);
		assert.strictEqual(video.videoGeneration, true);
		assert.deepStrictEqual(video.videoModel, { provider: 'openrouter', name: 'google/veo-3.1' });
		assert.deepStrictEqual(video.imageModel, { provider: 'openrouter', name: 'openai/gpt-5.4-image-2' });
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

	test('new sessions default to Full Access and tell the model approvals are off', () => {
		const resolved = resolveBackboardSessionConfig(undefined);
		const settings = createBackboardTurnSettings(undefined, undefined, { id: 'openai/gpt-5.5' });
		const approveForMe = createBackboardTurnSettings({ mode: BACKBOARD_ACCESS_DEFAULT }, undefined, { id: 'openai/gpt-5.5' });

		assert.deepStrictEqual(
			{
				schemaDefault: resolved.schema.properties?.mode?.default,
				value: resolved.values.mode,
				accessMode: settings.accessMode,
				explicitChoiceKept: approveForMe.accessMode,
				approveForMeContext: backboardAccessSystemContext(approveForMe.accessMode),
			},
			{
				schemaDefault: BACKBOARD_ACCESS_FULL,
				value: BACKBOARD_ACCESS_FULL,
				accessMode: BACKBOARD_ACCESS_FULL,
				explicitChoiceKept: BACKBOARD_ACCESS_DEFAULT,
				approveForMeContext: undefined,
			},
		);
		assert.match(backboardAccessSystemContext(settings.accessMode) ?? '', /Do not ask the user for permission to use a tool/);
	});
});
