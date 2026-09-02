/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { readAgentModelPricingMeta } from '../../../../../../platform/agentHost/common/agentModelPricing.js';
import { ConfigSchema, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelConfigurationSchema } from '../../../common/languageModels.js';

/**
 * Returns whether an agent host provider exposes a synthetic "Auto" model to
 * fall back to.
 *
 * Today only the Copilot CLI harness exposes an Auto selection and can run
 * without an explicit model, so it shows "Auto" rather than a "No models
 * available" state when no models are listed. Claude runs on the Claude
 * Agent SDK's default model when none is selected — required for
 * subscription-billed sessions, whose CAPI-sourced model list can be empty
 * (e.g. when signed out of Backboard). Codex requires an explicit model.
 *
 * `provider` is the underlying agent provider id (e.g. `'copilotcli'`,
 * `'claude'`, `'codex'`), not the `agent-host-<provider>` session type.
 *
 * TODO: hoist this capability onto the agent host protocol (e.g. a
 * `supportsAutoModel?: boolean` on `IAgentDescriptor` / `AgentInfo`) so each
 * agent declares its own value instead of this allow-list living in core.
 */
export function agentHostProviderSupportsAutoModel(provider: string): boolean {
	return provider === 'copilotcli' || provider === 'claude';
}

/**
 * Exposes models available from the agent host process as selectable
 * language models in the chat model picker. Models are provided from
 * root state (via {@link AgentInfo.models}) rather than via RPC.
 */
export class AgentHostLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _models: readonly SessionModelInfo[] = [];

	constructor(
		private readonly _sessionType: string,
		private readonly _vendor: string,
	) {
		super();
	}

	/**
	 * Called by {@link AgentHostContribution} when models change in root state.
	 */
	updateModels(models: readonly SessionModelInfo[]): void {
		this._models = models;
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const defaultModelId = this._models[0]?.id;
		return this._models
			.filter(m => m.policyState !== 'disabled')
			.map(m => {
				const pricing = readAgentModelPricingMeta(m._meta);
				const multiplierNumeric = pricing.multiplierNumeric;
				const rawPricing = typeof m._meta?.pricing === 'string' && m._meta.pricing.trim() !== '' ? m._meta.pricing : undefined;
				const upstreamProviderLabel = typeof m._meta?.upstreamProviderLabel === 'string' && m._meta.upstreamProviderLabel.trim() !== '' ? m._meta.upstreamProviderLabel : undefined;
				const isChatGptSubscription = m._meta?.upstreamProvider === 'openai-subscription';
				const chatGptSubscriptionConnected = m._meta?.chatGptSubscriptionConnected === true;
				const isClaudeSubscription = m._meta?.upstreamProvider === 'anthropic-subscription';
				const claudeSubscriptionConnected = m._meta?.claudeSubscriptionConnected === true;
				const modelDescription = typeof m._meta?.modelDescription === 'string' && m._meta.modelDescription.trim() !== '' ? m._meta.modelDescription : undefined;
				const openRouterProviders = Array.isArray(m._meta?.openRouterProviders)
					? m._meta.openRouterProviders.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
					: [];
				const detail = openRouterProviders.length === 1
					? localize('agentHostLanguageModelProvider.openRouterSingleProvider', "OpenRouter · {0}", openRouterProviders[0])
					: openRouterProviders.length > 1
						? localize('agentHostLanguageModelProvider.openRouterProviderCount', "OpenRouter · {0} providers", openRouterProviders.length)
						: upstreamProviderLabel;
				return {
					identifier: `${this._vendor}:${m.id}`,
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: m.name,
						tooltip: modelDescription,
						id: m.id,
						vendor: this._vendor,
						version: '1.0',
						detail,
							auth: isChatGptSubscription
							? {
								providerLabel: 'ChatGPT',
								...(chatGptSubscriptionConnected ? { accountLabel: localize('agentHostLanguageModelProvider.connected', "Connected") } : {}),
							}
							: isClaudeSubscription
								? {
									providerLabel: 'Claude',
									...(claudeSubscriptionConnected ? { accountLabel: localize('agentHostLanguageModelProvider.connected', "Connected") } : {}),
								}
								: undefined,
						family: m.id,
						maxInputTokens: m.maxContextWindow ?? 0,
						maxOutputTokens: 0,
						isDefaultForLocation: { [ChatAgentLocation.Chat]: m.id === defaultModelId },
						isUserSelectable: true,
						pricing: multiplierNumeric !== undefined ? `${multiplierNumeric}x` : rawPricing,
						multiplierNumeric,
						inputCost: pricing.inputCost,
						cacheCost: pricing.cacheCost,
						cacheWriteCost: pricing.cacheWriteCost,
						outputCost: pricing.outputCost,
						longContextInputCost: pricing.longContextInputCost,
						longContextCacheCost: pricing.longContextCacheCost,
						longContextCacheWriteCost: pricing.longContextCacheWriteCost,
						longContextOutputCost: pricing.longContextOutputCost,
						priceCategory: pricing.priceCategory,
						targetChatSessionType: this._sessionType,
						capabilities: {
							vision: m.supportsVision ?? false,
							toolCalling: true,
							agentMode: true,
						},
						configurationSchema: this._toLanguageModelConfigurationSchema(m.configSchema),
					},
				};
			});
	}

	private _toLanguageModelConfigurationSchema(schema: ConfigSchema | undefined): ILanguageModelConfigurationSchema | undefined {
		if (!schema) {
			return undefined;
		}

		return {
			type: schema.type,
			required: schema.required,
			properties: Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, {
				type: property.type,
				title: property.title,
				description: property.description,
				default: property.default,
				enum: property.enum,
				enumItemLabels: property.enumLabels,
				enumDescriptions: property.enumDescriptions,
				readOnly: property.readOnly,
				group: AgentHostLanguageModelProvider._groupForConfigKey(key),
			}])),
		};
	}

	private static _groupForConfigKey(key: string): string | undefined {
		switch (key) {
			case 'thinkingLevel': return 'navigation';
			case 'intensity': return 'navigation';
			case 'contextTier': return 'tokens';
			case 'openRouterProvider': return 'routing';
			default: return undefined;
		}
	}

	async sendChatRequest(): Promise<never> {
		throw new Error('Agent-host models do not support direct chat requests');
	}

	async provideTokenCount(): Promise<number> {
		return 0;
	}
}
