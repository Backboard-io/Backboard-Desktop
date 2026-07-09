/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { logBrowserOpen } from '../../../../../platform/browserView/common/browserViewTelemetry.js';
import { BrowserViewUri } from '../../../../../platform/browserView/common/browserViewUri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOpenBrowserToolParams, OpenBrowserToolData } from './openBrowserTool.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { createBrowserPageLink, findExistingPagesByHost, getExistingPagesResult } from './browserToolHelpers.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

// Mirrors RightWorkbenchCommandId.OpenBrowser (vs/sessions/contrib/rightWorkbench);
// referenced by id because workbench code must not import from vs/sessions.
const OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openBrowser';

export const OpenBrowserToolNonAgenticData: IToolData = {
	...OpenBrowserToolData,
	modelDescription: 'Open a new browser page in the integrated browser at the given URL.',
	inputSchema: {
		...OpenBrowserToolData.inputSchema,
		required: ['url'],
		$comment: undefined
	}
};

export class OpenBrowserToolNonAgentic implements IToolImpl {
	constructor(
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IOpenBrowserToolParams;

		if (!params.url) {
			throw new Error('The "url" parameter is required.');
		}
		const parsed = URL.parse(params.url);
		if (!parsed) {
			throw new Error('You must provide a complete, valid URL.');
		}

		return {
			invocationMessage: localize('browser.open.nonAgentic.invocation', "Opening browser page at {0}", parsed.href),
			pastTenseMessage: localize('browser.open.nonAgentic.past', "Opened browser page at {0}", parsed.href),
			confirmationMessages: {
				title: localize('browser.open.nonAgentic.confirmTitle', 'Open Browser Page?'),
				message: localize('browser.open.nonAgentic.confirmMessage', 'This will open {0} in the integrated browser. The agent will not be able to read its contents.', parsed.href),
				allowAutoConfirm: true,
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IOpenBrowserToolParams;

		if (!params.forceNew) {
			const existingPages = findExistingPagesByHost(this.browserViewService, params.url!, { activeSessionId: invocation.context?.sessionResource.toString() });
			const existingResult = await getExistingPagesResult(this.editorService, existingPages, { excludeIds: true });
			if (existingResult) {
				return existingResult;
			}
		}

		logBrowserOpen(this.telemetryService, 'chatTool');

		const browserUri = BrowserViewUri.forId(generateUuid());
		await this.commandService.executeCommand(OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID, {
			url: params.url,
			browserViewId: BrowserViewUri.getId(browserUri),
		});

		return {
			content: [{
				kind: 'text',
				value: `Page opened successfully. Note that you do not have access to the page contents unless the user enables agentic tools via the \`workbench.browser.enableChatTools\` setting.`,
			}],
			toolResultMessage: new MarkdownString(localize('browser.open.nonAgentic.result', "Opened {0}", createBrowserPageLink(browserUri)))
		};
	}
}
