/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import {
	escapeMarkdownSyntaxTokens,
	MarkdownString
} from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { createBrowserPageLink, errorResult, getSessionId, playwrightInvoke } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';

export const TypeBrowserToolData: IToolData = {
	id: 'type_in_page',
	toolReferenceName: BrowserChatToolReferenceName.TypeInPage,
	displayName: localize('typeBrowserTool.displayName', 'Type in Page'),
	userDescription: localize('typeBrowserTool.userDescription', 'Type text or press keys in a browser page'),
	modelDescription: 'Type text or press keys in a browser page.',
	icon: Codicon.symbolText,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: `The browser page ID, acquired from context or the open tool.`
			},
			text: {
				type: 'string',
				description: 'The text to type. One of "text" or "key" must be provided.'
			},
			submit: {
				type: 'boolean',
				description: 'Whether to press Enter after typing text. Ignored when "key" is provided. Default is false.'
			},
			key: {
				type: 'string',
				description: 'A key or key combination to press (e.g., "Enter", "Tab", "ArrowLeft", "w", "Control+c"). One of "text" or "key" must be provided.'
			},
			holdMs: {
				type: 'number',
				description: 'Hold the key down for this many milliseconds before releasing (max 10000). Use for game controls that respond to held keys, e.g. holding ArrowRight to move.'
			},
			keyAction: {
				type: 'string',
				enum: ['press', 'down', 'up'],
				description: 'For "key": "down" presses without releasing and "up" releases a held key, letting you hold one key across calls while pressing others. Default is "press" (down+up).'
			},
			ref: {
				type: 'string',
				description: 'Element reference to focus and type into. If omitted, types into the focused element.'
			},
			selector: {
				type: 'string',
				description: 'Playwright selector of element to focus and type into. Use if "ref" is not available. If omitted, types into the focused element.'
			},
			element: {
				type: 'string',
				description: 'Human-readable description of the element to type into (e.g., "search box", "comment field"). Required when "ref" or "selector" is specified.'
			},
		},
		required: ['pageId']
	},
};

interface ITypeBrowserToolParams {
	pageId: string;
	text?: string;
	submit?: boolean;
	key?: string;
	holdMs?: number;
	keyAction?: 'press' | 'down' | 'up';
	ref?: string;
	selector?: string;
	element?: string;
}

const MAX_KEY_HOLD_MS = 10_000;

export class TypeBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ITypeBrowserToolParams;
		const link = createBrowserPageLink(params.pageId);
		const hasTarget = params.ref || params.selector;

		if (params.key) {
			const key = escapeMarkdownSyntaxTokens(params.key);
			if (params.keyAction === 'down') {
				return {
					invocationMessage: new MarkdownString(localize('browser.holdKey.invocation', "Holding key `{0}` down in {1}", key, link)),
					pastTenseMessage: new MarkdownString(localize('browser.holdKey.past', "Held key `{0}` down in {1}", key, link)),
				};
			}
			if (params.keyAction === 'up') {
				return {
					invocationMessage: new MarkdownString(localize('browser.releaseKey.invocation', "Releasing key `{0}` in {1}", key, link)),
					pastTenseMessage: new MarkdownString(localize('browser.releaseKey.past', "Released key `{0}` in {1}", key, link)),
				};
			}
			if (params.holdMs && params.holdMs > 0) {
				return {
					invocationMessage: new MarkdownString(localize('browser.holdKeyFor.invocation', "Holding key `{0}` for {1}ms in {2}", key, params.holdMs, link)),
					pastTenseMessage: new MarkdownString(localize('browser.holdKeyFor.past', "Held key `{0}` for {1}ms in {2}", key, params.holdMs, link)),
				};
			}
			if (hasTarget && params.element) {
				const element = escapeMarkdownSyntaxTokens(params.element);
				return {
					invocationMessage: new MarkdownString(localize('browser.pressKey.invocation.element', "Pressing key `{0}` in {1} in {2}", key, element, link)),
					pastTenseMessage: new MarkdownString(localize('browser.pressKey.past.element', "Pressed key `{0}` in {1} in {2}", key, element, link)),
				};
			}
			return {
				invocationMessage: new MarkdownString(localize('browser.pressKey.invocation', "Pressing key `{0}` in {1}", key, link)),
				pastTenseMessage: new MarkdownString(localize('browser.pressKey.past', "Pressed key `{0}` in {1}", key, link)),
			};
		}

		if (hasTarget && params.element) {
			const element = escapeMarkdownSyntaxTokens(params.element);
			return {
				invocationMessage: params.submit
					? new MarkdownString(localize('browser.typeAndSubmit.invocation.element', "Typing text in {0} in {1} and pressing Enter", element, link))
					: new MarkdownString(localize('browser.type.invocation.element', "Typing text in {0} in {1}", element, link)),
				pastTenseMessage: params.submit
					? new MarkdownString(localize('browser.typeAndSubmit.past.element', "Typed text in {0} in {1} and pressed Enter", element, link))
					: new MarkdownString(localize('browser.type.past.element', "Typed text in {0} in {1}", element, link)),
			};
		}
		return {
			invocationMessage: params.submit
				? new MarkdownString(localize('browser.typeAndSubmit.invocation', "Typing text in {0} and pressing Enter", link))
				: new MarkdownString(localize('browser.type.invocation', "Typing text in {0}", link)),
			pastTenseMessage: params.submit
				? new MarkdownString(localize('browser.typeAndSubmit.past', "Typed text in {0} and pressed Enter", link))
				: new MarkdownString(localize('browser.type.past', "Typed text in {0}", link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ITypeBrowserToolParams;
		const sessionId = getSessionId(invocation);

		if (!params.pageId) {
			return errorResult(`No page ID provided. Use '${OpenPageToolId}' first.`);
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!params.text && !params.key) {
			return errorResult('Either a "text" or "key" parameter is required.');
		}

		// Press key
		if (params.key) {
			const keyAction = params.keyAction ?? 'press';
			// Held keys and split down/up presses target the focused element
			// (games listen on the document), so they intentionally ignore
			// element targeting.
			if (keyAction === 'down') {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, key) => page.keyboard.down(key), params.key);
			}
			if (keyAction === 'up') {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, key) => page.keyboard.up(key), params.key);
			}
			const holdMs = Math.min(Math.max(params.holdMs ?? 0, 0), MAX_KEY_HOLD_MS);
			if (holdMs > 0) {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, async (page, key, hold) => {
					await page.keyboard.down(key);
					await page.waitForTimeout(hold);
					await page.keyboard.up(key);
				}, params.key, holdMs);
			}
			if (selector) {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, sel, key) => page.locator(sel).press(key), selector, params.key);
			}
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, key) => page.keyboard.press(key), params.key);
		}

		// Type text
		if (selector) {
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, async (page, sel, text, submit) => {
				const locator = page.locator(sel);
				await locator.fill(text);
				if (submit) {
					await locator.press('Enter');
				}
			}, selector, params.text!, params.submit ?? false);
		}
		return playwrightInvoke(this.playwrightService, sessionId, params.pageId, async (page, text, submit) => {
			await page.keyboard.type(text);
			if (submit) {
				await page.keyboard.press('Enter');
			}
		}, params.text!, params.submit ?? false);
	}
}
