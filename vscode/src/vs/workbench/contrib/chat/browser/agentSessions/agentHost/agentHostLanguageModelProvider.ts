/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { ConfigSchema, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelConfigurationSchema } from '../../../common/languageModels.js';

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
		return this._models
			.filter(m => m.policyState !== 'disabled')
			.map(m => {
				const upstreamProvider = typeof m._meta?.upstreamProvider === 'string' ? m._meta.upstreamProvider : undefined;
				const upstreamProviderLabel = typeof m._meta?.upstreamProviderLabel === 'string' ? m._meta.upstreamProviderLabel : undefined;
				const inputCost = typeof m._meta?.inputCost === 'number' ? m._meta.inputCost : undefined;
				const outputCost = typeof m._meta?.outputCost === 'number' ? m._meta.outputCost : undefined;
				return {
					identifier: `${this._vendor}:${m.id}`,
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: m.name,
						id: m.id,
						vendor: this._vendor,
						version: '1.0',
						detail: upstreamProviderLabel,
						family: upstreamProvider ?? m.id,
						maxInputTokens: m.maxContextWindow ?? 0,
						maxOutputTokens: 0,
						isDefaultForLocation: {},
						isUserSelectable: true,
						inputCost,
						outputCost,
						statusIcon: getAgentHostModelIcon(upstreamProvider),
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
				group: key === 'thinkingLevel' ? 'navigation' : undefined,
			}])),
		};
	}

	async sendChatRequest(): Promise<never> {
		throw new Error('Agent-host models do not support direct chat requests');
	}

	async provideTokenCount(): Promise<number> {
		return 0;
	}
}

function getAgentHostModelIcon(provider: string | undefined): ThemeIcon {
	switch (provider) {
		case 'anthropic':
		case 'aws-bedrock':
			return Codicon.claude;
		case 'openai':
		case 'openai-compatible':
			return Codicon.openai;
		case 'google':
		case 'google-ai':
			return Codicon.sparkle;
		case 'mistral':
		case 'deepseek':
		case 'x-ai':
		case 'xai':
		case 'cohere':
		case 'cerebras':
		case 'openrouter':
			return Codicon.robot;
		case 'lmstudio':
		case 'lm-studio':
		case 'ollama':
			return Codicon.server;
		default:
			return Codicon.sparkle;
	}
}
