/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AriaRole } from '../../../../../base/browser/ui/aria/aria.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { marked } from '../../../../../base/common/marked/marked.js';
import { isDefined } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { AccessibilityVerbositySettingId } from '../../../accessibility/browser/accessibilityConfiguration.js';
import { migrateLegacyTerminalToolSpecificData } from '../../common/chat.js';
import { getExplicitFileOrImageAttachmentSummary, isExplicitFileOrImageVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IChatToolInvocation } from '../../common/chatService/chatService.js';
import { IChatProgressResponseContent } from '../../common/model/chatModel.js';
import { IChatResponseViewModel, isPendingDividerVM, isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { isToolResultInputOutputDetails, isToolResultOutputDetails, toolContentToA11yString } from '../../common/tools/languageModelToolsService.js';
import { CancelChatActionId } from '../actions/chatExecuteActions.js';
import { AcceptToolConfirmationActionId } from '../actions/chatToolActions.js';
import { ChatTreeItem } from '../chat.js';

export const getToolConfirmationAlert = (accessor: ServicesAccessor, toolInvocation: IChatToolInvocation[]) => {
	const keybindingService = accessor.get(IKeybindingService);
	const contextKeyService = accessor.get(IContextKeyService);

	const acceptKb = keybindingService.lookupKeybinding(AcceptToolConfirmationActionId, contextKeyService)?.getAriaLabel();
	const cancelKb = keybindingService.lookupKeybinding(CancelChatActionId, contextKeyService)?.getAriaLabel();
	const text = toolInvocation.map(v => {
		const state = v.state.get();
		if (state.type === IChatToolInvocation.StateKind.WaitingForPostApproval) {
			const detail = isToolResultInputOutputDetails(state.resultDetails)
				? state.resultDetails.input
				: isToolResultOutputDetails(state.resultDetails)
					? undefined
					: toolContentToA11yString(state.contentForModel);
			return {
				title: localize('toolPostApprovalTitle', "Approve results of tool"),
				detail: detail,
			};
		}

		if (!(state.type === IChatToolInvocation.StateKind.WaitingForConfirmation && state.confirmationMessages?.message)) {
			return;
		}

		let input = '';
		if (v.toolSpecificData) {
			if (v.toolSpecificData.kind === 'terminal') {
				const terminalData = migrateLegacyTerminalToolSpecificData(v.toolSpecificData);
				input = terminalData.commandLine.toolEdited ?? terminalData.commandLine.original;
			} else if (v.toolSpecificData.kind === 'extensions') {
				input = JSON.stringify(v.toolSpecificData.extensions);
			} else if (v.toolSpecificData.kind === 'input') {
				input = JSON.stringify(v.toolSpecificData.rawInput);
			} else if (v.toolSpecificData.kind === 'modifiedFilesConfirmation') {
				input = localize('modifiedFilesConfirmationInput', '{0} files', v.toolSpecificData.modifiedFiles.length);
			}
		}
		const titleObj = state.confirmationMessages?.title;
		const title = typeof titleObj === 'string' ? titleObj : titleObj?.value || '';
		return {
			title: (title + (input ? ': ' + input : '')).trim(),
			detail: undefined,
		};
	}).filter(isDefined);

	let message = acceptKb && cancelKb
		? localize('toolInvocationsHintKb', "Chat confirmation required: {0}. Press {1} to accept or {2} to cancel.", text.map(t => t.title).join(', '), acceptKb, cancelKb)
		: localize('toolInvocationsHint', "Chat confirmation required: {0}", text.map(t => t.title).join(', '));

	if (text.some(t => t.detail)) {
		message += ' ' + localize('toolInvocationsHintDetails', "Details: {0}", text.map(t => t.detail ? t.detail : '').join(' '));
	}

	return message;
};

/**
 * Updating the list item's aria-label on every streamed token is both noisy for
 * assistive technology and expensive: producing the label stringifies and
 * lexes the entire response. Keep the label reasonably fresh without putting
 * that cumulative work on the token hot path.
 */
const streamingResponseLabelUpdateInterval = 500;
const maxCachedResponseLabels = 24;
const markdownSnapshotPrefixLength = 64;

interface IResponsePartAriaSnapshot {
	readonly kind: IChatProgressResponseContent['kind'];
	readonly identity?: IChatProgressResponseContent;
	readonly markdownLength?: number;
	readonly markdownPrefix?: string;
	readonly toolState?: unknown;
	readonly taskProgressLength?: number;
}

interface IResponseAriaLabelCacheEntry {
	dataId: string;
	label: string;
	generatedAt: number;
	accessibleViewHint: string | null | undefined;
	parts: readonly IResponsePartAriaSnapshot[];
	codeCitationCount: number;
}

function snapshotResponseParts(parts: readonly IChatProgressResponseContent[]): IResponsePartAriaSnapshot[] {
	return parts.map(part => {
		if (part.kind === 'markdownContent') {
			return {
				kind: part.kind,
				markdownLength: part.content.value.length,
				markdownPrefix: part.content.value.slice(0, markdownSnapshotPrefixLength),
			};
		}

		return {
			kind: part.kind,
			identity: part,
			toolState: part.kind === 'toolInvocation' ? part.state.get() : undefined,
			taskProgressLength: part.kind === 'progressTask' ? part.progress.length : undefined,
		};
	});
}

function snapshotsEqual(previous: readonly IResponsePartAriaSnapshot[], current: readonly IResponsePartAriaSnapshot[]): boolean {
	if (previous.length !== current.length) {
		return false;
	}

	return previous.every((part, index) => {
		const currentPart = current[index];
		return part.kind === currentPart.kind
			&& part.identity === currentPart.identity
			&& part.markdownLength === currentPart.markdownLength
			&& part.markdownPrefix === currentPart.markdownPrefix
			&& part.toolState === currentPart.toolState
			&& part.taskProgressLength === currentPart.taskProgressLength;
	});
}

function isOnlyMarkdownAppend(previous: readonly IResponsePartAriaSnapshot[], current: readonly IResponsePartAriaSnapshot[]): boolean {
	if (previous.length !== current.length) {
		return false;
	}

	let foundAppend = false;
	for (let index = 0; index < previous.length; index++) {
		const previousPart = previous[index];
		const currentPart = current[index];
		if (previousPart.kind !== currentPart.kind) {
			return false;
		}

		if (previousPart.kind === 'markdownContent') {
			if (previousPart.markdownLength === currentPart.markdownLength && previousPart.markdownPrefix === currentPart.markdownPrefix) {
				continue;
			}
			if (foundAppend
				|| currentPart.markdownLength === undefined
				|| previousPart.markdownLength === undefined
				|| currentPart.markdownLength <= previousPart.markdownLength
				|| !currentPart.markdownPrefix?.startsWith(previousPart.markdownPrefix ?? '')) {
				return false;
			}
			foundAppend = true;
			continue;
		}

		if (previousPart.identity !== currentPart.identity
			|| previousPart.toolState !== currentPart.toolState
			|| previousPart.taskProgressLength !== currentPart.taskProgressLength) {
			return false;
		}
	}

	return foundAppend;
}

export class ChatAccessibilityProvider implements IListAccessibilityProvider<ChatTreeItem> {
	private readonly _responseLabelCache = new Map<string, IResponseAriaLabelCacheEntry>();

	constructor(
		@IAccessibleViewService private readonly _accessibleViewService: IAccessibleViewService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
	}

	clearCache(): void {
		this._responseLabelCache.clear();
	}

	getWidgetRole(): AriaRole {
		return 'list';
	}

	getRole(element: ChatTreeItem): AriaRole | undefined {
		return 'listitem';
	}

	getWidgetAriaLabel(): string {
		return localize('chat', "Chat");
	}

	getAriaLabel(element: ChatTreeItem): string {
		if (isRequestVM(element)) {
			const message = element.messageText.trim();
			const attachmentSummary = getExplicitFileOrImageAttachmentSummary(element.variables);
			if (element.isSystemInitiated) {
				// System steering rows intentionally replace the provider-facing prompt
				// with a compact status label in the transcript. Announce that same
				// visible label rather than describing the row as a user-owned queue item.
				return element.systemInitiatedLabel?.trim() || message || localize('systemNotificationRequestAriaLabel', "System notification");
			}
			if (element.pendingKind) {
				const contextVariableCount = element.variables.filter(variable => !isExplicitFileOrImageVariableEntry(variable)).length;
				const contextSummary = contextVariableCount === 0
					? undefined
					: contextVariableCount === 1
						? localize('queuedContextAriaSummary.one', "1 context item")
						: localize('queuedContextAriaSummary.many', "{0} context items", contextVariableCount);
				const queuedContent = [message, attachmentSummary, contextSummary].filter((value): value is string => !!value).join('. ');
				return localize('queuedRequestAriaLabel', "Queued: {0}", queuedContent);
			}
			return message || attachmentSummary || '';
		}

		if (isResponseVM(element)) {
			return this._getLabelWithInfo(element);
		}

		if (isPendingDividerVM(element)) {
			return element.isSystemInitiated
				? localize('systemNotificationDividerAriaLabel', "System notification")
				: localize('queuedDividerAriaLabel', "Queued messages: {0}", element.pendingCount);
		}

		return '';
	}

	private _getLabelWithInfo(element: IChatResponseViewModel): string {
		const accessibleViewHint = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
		const cached = this._responseLabelCache.get(element.id);
		if (cached?.dataId === element.dataId && cached.accessibleViewHint === accessibleViewHint) {
			this._touchResponseLabelCache(element.id, cached);
			return cached.label;
		}

		const now = Date.now();
		const partsSnapshot = snapshotResponseParts(element.response.value);
		const codeCitationCount = element.codeCitations.length;
		if (cached
			&& !element.isComplete
			&& cached.accessibleViewHint === accessibleViewHint
			&& cached.codeCitationCount === codeCitationCount
			&& (snapshotsEqual(cached.parts, partsSnapshot)
				|| (now - cached.generatedAt < streamingResponseLabelUpdateInterval && isOnlyMarkdownAppend(cached.parts, partsSnapshot)))) {
			cached.dataId = element.dataId;
			cached.parts = partsSnapshot;
			this._touchResponseLabelCache(element.id, cached);
			return cached.label;
		}

		const responseText = element.response.toString();
		let label: string = '';

		const toolInvocation: IChatToolInvocation[] = [];
		let hasToolWaitingForConfirmation = false;
		let fileTreeCount = 0;
		let elicitationHint = '';
		for (const part of element.response.value) {
			if (part.kind === 'toolInvocation') {
				toolInvocation.push(part);
				const state = part.state.get().type;
				hasToolWaitingForConfirmation ||= state === IChatToolInvocation.StateKind.WaitingForConfirmation || state === IChatToolInvocation.StateKind.WaitingForPostApproval;
			} else if (part.kind === 'treeData') {
				fileTreeCount++;
			} else if (part.kind === 'elicitation2' || part.kind === 'elicitationSerialized') {
				const title = typeof part.title === 'string' ? part.title : part.title.value;
				const message = typeof part.message === 'string' ? part.message : part.message.value;
				elicitationHint += title + ' ' + message;
			}
		}

		let toolInvocationHint = '';
		if (hasToolWaitingForConfirmation) {
			toolInvocationHint = this._instantiationService.invokeFunction(getToolConfirmationAlert, toolInvocation);
		}

		let tableCount = 0;
		let codeBlockCount = 0;
		for (const token of marked.lexer(responseText)) {
			if (token.type === 'table') {
				tableCount++;
			} else if (token.type === 'code') {
				codeBlockCount++;
			}
		}

		let tableCountHint = '';
		switch (tableCount) {
			case 0:
				break;
			case 1:
				tableCountHint = localize('singleTableHint', "1 table ");
				break;
			default:
				tableCountHint = localize('multiTableHint', "{0} tables ", tableCount);
				break;
		}

		let fileTreeCountHint = '';
		switch (fileTreeCount) {
			case 0:
				break;
			case 1:
				fileTreeCountHint = localize('singleFileTreeHint', "1 file tree ");
				break;
			default:
				fileTreeCountHint = localize('multiFileTreeHint', "{0} file trees ", fileTreeCount);
				break;
		}

		switch (codeBlockCount) {
			case 0:
				label = accessibleViewHint
					? localize('noCodeBlocksHint', "{0}{1}{2}{3}{4} {5}", toolInvocationHint, fileTreeCountHint, elicitationHint, tableCountHint, responseText, accessibleViewHint)
					: localize('noCodeBlocks', "{0}{1}{2} {3}", fileTreeCountHint, elicitationHint, tableCountHint, responseText);
				break;
			case 1:
				label = accessibleViewHint
					? localize('singleCodeBlockHint', "{0}{1}{2}1 code block: {3} {4}{5}", toolInvocationHint, fileTreeCountHint, elicitationHint, tableCountHint, responseText, accessibleViewHint)
					: localize('singleCodeBlock', "{0}{1}1 code block: {2} {3}", fileTreeCountHint, elicitationHint, tableCountHint, responseText);
				break;
			default:
				label = accessibleViewHint
					? localize('multiCodeBlockHint', "{0}{1}{2}{3} code blocks: {4}{5} {6}", toolInvocationHint, fileTreeCountHint, elicitationHint, tableCountHint, codeBlockCount, responseText, accessibleViewHint)
					: localize('multiCodeBlock', "{0}{1}{2} code blocks: {3} {4}", fileTreeCountHint, elicitationHint, codeBlockCount, tableCountHint, responseText);
				break;
		}

		this._touchResponseLabelCache(element.id, {
			dataId: element.dataId,
			label,
			generatedAt: now,
			accessibleViewHint,
			parts: partsSnapshot,
			codeCitationCount,
		});
		return label;
	}

	private _touchResponseLabelCache(responseId: string, entry: IResponseAriaLabelCacheEntry): void {
		this._responseLabelCache.delete(responseId);
		this._responseLabelCache.set(responseId, entry);
		if (this._responseLabelCache.size > maxCachedResponseLabels) {
			const oldestResponseId = this._responseLabelCache.keys().next().value;
			if (oldestResponseId !== undefined) {
				this._responseLabelCache.delete(oldestResponseId);
			}
		}
	}
}
