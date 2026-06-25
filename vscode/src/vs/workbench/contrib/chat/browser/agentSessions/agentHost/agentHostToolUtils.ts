/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import type { IToolData } from '../../../common/tools/languageModelToolsService.js';

/**
 * Converts an internal {@link IToolData} to a protocol {@link ToolDefinition}.
 */
export function toolDataToDefinition(tool: IToolData): ToolDefinition {
	const sourceMeta = tool.source.type === 'mcp'
		? {
			source: 'mcp',
			mcpLabel: tool.source.label,
			mcpServerLabel: tool.source.serverLabel,
			mcpCollectionId: tool.source.collectionId,
			mcpDefinitionId: tool.source.definitionId,
		}
		: { source: tool.source.type };
	return {
		name: tool.toolReferenceName ?? tool.id,
		title: tool.displayName,
		description: tool.modelDescription,
		inputSchema: tool.inputSchema?.type === 'object'
			? tool.inputSchema as ToolDefinition['inputSchema']
			: undefined,
		_meta: sourceMeta,
	};
}
