/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { Extensions as WorkbenchExtensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { IPathService } from '../../../services/path/common/pathService.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

const backboardEnableDefault = {
	'*': true,
	plaintext: false,
	markdown: false,
	scminput: false,
};

const defaultBackboardModelSetting = 'openrouter::deepseek/deepseek-v4-flash';

interface BackboardMetadataModel {
	readonly provider: string;
	readonly name: string;
	readonly displayName?: string;
}

interface BackboardMetadataFile {
	readonly models?: readonly BackboardMetadataModel[];
}

function createBackboardModelProperty(models?: readonly BackboardMetadataModel[]): IConfigurationNode['properties'][string] {
	const property: IConfigurationNode['properties'][string] = {
		type: 'string',
		default: defaultBackboardModelSetting,
		description: nls.localize('backboard.defaultModel', "Default Backboard model used for new chats."),
	};

	if (!models?.length) {
		return property;
	}

	const values: string[] = [];
	const labels: string[] = [];
	const descriptions: string[] = [];
	for (const model of models) {
		if (!model.provider?.trim() || !model.name?.trim()) {
			continue;
		}
		values.push(serializeBackboardModelSetting(model.provider, model.name));
		labels.push(model.displayName?.trim() || model.name.trim());
		descriptions.push(`${backboardProviderDisplayName(model.provider)} • ${model.name.trim()}`);
	}

	if (!values.length) {
		return property;
	}

	if (!values.includes(defaultBackboardModelSetting)) {
		values.unshift(defaultBackboardModelSetting);
		labels.unshift('DeepSeek V4 Flash');
		descriptions.unshift('OpenRouter • deepseek/deepseek-v4-flash');
	}

	property.enum = values;
	property.enumItemLabels = labels;
	property.enumDescriptions = descriptions;
	return property;
}

function createBackboardRootNode(modelProperty: IConfigurationNode['properties'][string]): IConfigurationNode {
	return {
		id: 'backboard',
		order: 2,
		title: nls.localize('backboard.settings.root', "Backboard"),
		type: 'object',
		properties: {
			'backboard.apiKey': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.apiKey', "Personal Backboard API key. Use this only if you want Backboard to authenticate directly with a key instead of using SSO."),
			},
			'backboard.defaultModel': modelProperty,
			'backboard.workspaceRoot': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.workspaceRoot', "Path to use as the Backboard workspace root. Supports ${workspaceFolder} and ${userHome}. Leave empty to use the open workspace folder."),
			},
		},
	};
}

const staticBackboardConfigurationNodes: IConfigurationNode[] = [
	{
		id: 'backboardSimple',
		order: 3,
		title: nls.localize('backboard.settings.simple', "Backboard Simple"),
		type: 'object',
		properties: {
			'backboard.mode': {
				type: 'string',
				enum: ['agent', 'ask', 'manual', 'free'],
				default: 'free',
				description: nls.localize('backboard.mode', "Controls the Backboard turn mode used by the Simple workspace."),
			},
			'backboard.intensity': {
				type: 'string',
				enum: ['fast', 'balanced', 'deep'],
				default: 'fast',
				description: nls.localize('backboard.intensity', "Controls reasoning intensity for Backboard turns."),
			},
			'backboard.webSearch': {
				type: 'string',
				enum: ['off', 'Auto'],
				default: 'off',
				description: nls.localize('backboard.webSearch', "Controls whether Backboard can use web search during a turn."),
			},
			'backboard.imageGeneration': {
				type: 'string',
				enum: ['off', 'auto'],
				default: 'off',
				description: nls.localize('backboard.imageGeneration', "Controls whether Backboard can generate images during a turn."),
			},
			'backboard.voiceMode': {
				type: 'string',
				enum: ['off', 'tts', 'stt', 'conversation'],
				default: 'off',
				description: nls.localize('backboard.voiceMode', "Controls the voice mode for Backboard turns."),
			},
		},
	},
	{
		id: 'backboardEditor',
		order: 4,
		title: nls.localize('backboard.settings.editor', "Backboard Editor"),
		type: 'object',
		properties: {
			'backboard.enable': {
				type: 'object',
				default: backboardEnableDefault,
				additionalProperties: {
					type: 'boolean',
				},
				markdownDescription: nls.localize('backboard.enable', "Controls ghost text completions for Backboard by language. Use `*` for the default and language ids like `typescript` for overrides."),
			},
			'backboard.nextEditSuggestions.enabled': {
				type: 'boolean',
				default: true,
				markdownDescription: nls.localize('backboard.nextEditSuggestions.enabled', "Controls whether Backboard shows next edit suggestions when ghost text suggestions are enabled."),
			},
		},
	},
	{
		id: 'backboardAdvanced',
		order: 5,
		title: nls.localize('backboard.settings.advanced', "Backboard Advanced"),
		type: 'object',
		properties: {
			'backboard.advanced': {
				type: 'object',
				default: {},
				properties: {
					authProvider: {
						type: 'string',
						description: nls.localize('backboard.advanced.authProvider', "Authentication provider override used for Backboard enterprise setup flows."),
					},
				},
				additionalProperties: true,
				tags: ['advanced'],
			},
			'backboard.mcpFigma': {
				type: 'boolean',
				default: true,
				description: nls.localize('backboard.mcpFigma', "Enable the Backboard-hosted Figma MCP integration."),
			},
			'backboard.mcpNotion': {
				type: 'boolean',
				default: false,
				description: nls.localize('backboard.mcpNotion', "Enable the Backboard-hosted Notion MCP integration."),
			},
			'backboard.mcpGoogle': {
				type: 'boolean',
				default: false,
				description: nls.localize('backboard.mcpGoogle', "Enable the Backboard-hosted Google MCP integration."),
			},
			'backboard.env': {
				type: 'string',
				enum: ['prod', 'dev', 'local'],
				default: 'prod',
				description: nls.localize('backboard.env', "Backboard API environment."),
				tags: ['advanced'],
			},
			'backboard.apiUrl': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.apiUrl', "Custom Backboard API base URL. Overrides the environment when set."),
				tags: ['advanced'],
			},
			'backboard.oauthRedirectUri': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.oauthRedirectUri', "OAuth redirect URI for Backboard sign in. Leave empty to use the built-in local callback."),
				tags: ['advanced'],
			},
			'backboard.bridgePath': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.bridgePath', "Path to the local backboard-bridge binary. Leave empty to use the built-in lookup."),
				tags: ['advanced'],
			},
			'backboard.updates.enabled': {
				type: 'boolean',
				default: true,
				description: nls.localize('backboard.updates.enabled', "Check the Backboard Studio update manifest after Backboard activates."),
				tags: ['advanced'],
			},
			'backboard.updates.manifestBaseUrl': {
				type: 'string',
				default: 'https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases',
				description: nls.localize('backboard.updates.manifestBaseUrl', "Base URL for Backboard Studio update manifests."),
				tags: ['advanced'],
			},
			'backboard.updates.channel': {
				type: 'string',
				enum: ['', 'stable', 'sandbox'],
				default: '',
				description: nls.localize('backboard.updates.channel', "Backboard Studio update channel. Leave empty to select the default for the current build."),
				tags: ['advanced'],
			},
			'backboard.updates.manifestUrl': {
				type: 'string',
				default: '',
				description: nls.localize('backboard.updates.manifestUrl', "Full Backboard Studio update manifest URL override."),
				tags: ['advanced'],
			},
			'backboard.updates.checkIntervalMinutes': {
				type: 'number',
				default: 360,
				minimum: 15,
				description: nls.localize('backboard.updates.checkIntervalMinutes', "How often Backboard Studio checks for updates while the IDE is open."),
				tags: ['advanced'],
			},
		},
	},
];

let backboardRootConfigurationNode = createBackboardRootNode(createBackboardModelProperty());
configurationRegistry.registerConfiguration(backboardRootConfigurationNode);
for (const configurationNode of staticBackboardConfigurationNodes) {
	configurationRegistry.registerConfiguration(configurationNode);
}

class BackboardSettingsModelOptionsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardSettingsModelOptions';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		try {
			const models = await readBackboardModels(this.fileService, this.pathService);
			if (!models.length) {
				return;
			}
			const nextNode = createBackboardRootNode(createBackboardModelProperty(models));
			configurationRegistry.updateConfigurations({ remove: [backboardRootConfigurationNode], add: [nextNode] });
			backboardRootConfigurationNode = nextNode;
		} catch (error) {
			this.logService.warn(`[Backboard Settings] Failed to load model metadata: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

registerWorkbenchContribution2(BackboardSettingsModelOptionsContribution.ID, BackboardSettingsModelOptionsContribution, WorkbenchPhase.BlockRestore);

Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration).registerConfigurationMigrations([
	{
		key: 'github.copilot.enable',
		migrateFn: (value) => [
			['backboard.enable', { value }],
		],
	},
	{
		key: 'github.copilot.nextEditSuggestions.enabled',
		migrateFn: (value) => [
			['backboard.nextEditSuggestions.enabled', { value }],
		],
	},
	{
		key: 'github.copilot.selectedCompletionModel',
		migrateFn: (value) => [
			['backboard.defaultModel', { value }],
		],
	},
	{
		key: 'github.copilot.advanced',
		migrateFn: (value) => [
			['backboard.advanced', { value }],
		],
	},
]);

async function readBackboardModels(fileService: IFileService, pathService: IPathService): Promise<readonly BackboardMetadataModel[]> {
	const resource = URI.joinPath(await pathService.userHome({ preferLocal: true }), '.backboard_ide', 'optimus-metadata.json');
	try {
		const parsed: unknown = JSON.parse((await fileService.readFile(resource)).value.toString());
		const metadata = isObjectRecord(parsed) ? parsed as BackboardMetadataFile : undefined;
		return (metadata?.models ?? []).filter(isBackboardMetadataModel);
	} catch (error) {
		if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND || error instanceof SyntaxError) {
			return [];
		}
		throw error;
	}
}

function isBackboardMetadataModel(value: unknown): value is BackboardMetadataModel {
	return isObjectRecord(value)
		&& typeof value.provider === 'string'
		&& typeof value.name === 'string';
}

function serializeBackboardModelSetting(provider: string, model: string): string {
	return `${provider.trim()}::${model.trim()}`;
}

function backboardProviderDisplayName(provider: string): string {
	switch (provider.trim().toLowerCase().replace(/[\s_]+/g, '-')) {
		case 'anthropic':
			return 'Anthropic';
		case 'aws-bedrock':
		case 'bedrock':
			return 'AWS Bedrock';
		case 'deepseek':
			return 'DeepSeek';
		case 'gemini':
		case 'google':
		case 'google-ai':
			return 'Google';
		case 'lm-studio':
			return 'LM Studio';
		case 'mistral':
			return 'Mistral';
		case 'ollama':
			return 'Ollama';
		case 'openai':
			return 'OpenAI';
		case 'openai-compatible':
			return 'OpenAI Compatible';
		case 'openrouter':
			return 'OpenRouter';
		case 'vercel':
			return 'Vercel';
		case 'xai':
			return 'xAI';
		default:
			return provider;
	}
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
