/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, clearNode, DisposableResizeObserver, disposableWindowInterval, getWindow, hide, scheduleAtNextAnimationFrame } from '../../../../../../base/browser/dom.js';
import { alert } from '../../../../../../base/browser/ui/aria/aria.js';
import { HoverStyle } from '../../../../../../base/browser/ui/hover/hover.js';
import { DomScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../../base/common/scrollable.js';
import { IChatExternalEdit, IChatMarkdownContent, IChatTerminalToolInvocationData, IChatThinkingPart, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../common/chatService/chatService.js';
import { migrateLegacyTerminalToolSpecificData } from '../../../common/chat.js';
import { IChatContentPartRenderContext, IChatContentPart } from './chatContentParts.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatConfiguration, ThinkingDisplayMode } from '../../../common/constants.js';
import { ChatTreeItem } from '../../chat.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { AccessibilityWorkbenchSettingId } from '../../../../accessibility/browser/accessibilityConfiguration.js';
import { IMarkdownString, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IRenderedMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { extractCodeblockUrisFromText } from '../../../common/widget/annotations.js';
import { basename } from '../../../../../../base/common/resources.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { renderFileWidgets } from './chatInlineAnchorWidget.js';
import { localize } from '../../../../../../nls.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Lazy } from '../../../../../../base/common/lazy.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { disposableTimeout } from '../../../../../../base/common/async.js';
import { DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../../../base/common/observable.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { ChatMessageRole, ILanguageModelsService } from '../../../common/languageModels.js';
import './media/chatThinkingContent.css';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { extractImagesFromToolInvocationOutputDetails } from '../../../common/chatImageExtraction.js';
import { IChatCollapsibleIODataPart } from './chatToolInputOutputContentPart.js';
import { ChatThinkingExternalResourceWidget } from './chatThinkingExternalResourcesWidget.js';
import { LocalChatSessionUri, chatSessionResourceToId } from '../../../common/model/chatUri.js';
import { IEditSessionDiffStats } from '../../../common/editing/chatEditingService.js';
import { IChatTextEditGroup } from '../../../common/model/chatModel.js';


// Context key id mirrored from `vs/sessions/common/contextkeys` (`IsPhoneLayoutContext`).
// Inlined as a string because `vs/workbench` must not import from `vs/sessions`.
const SESSIONS_IS_PHONE_LAYOUT_KEY = 'sessionsIsPhoneLayout';

/**
 * Resolves the effective thinking display mode. On phone layout we always force
 * {@link ThinkingDisplayMode.CollapsedPreview} so streaming reasoning takes less
 * room and auto-collapses on completion regardless of the user's setting.
 */
export function getEffectiveThinkingDisplayMode(configurationService: IConfigurationService, contextKeyService: IContextKeyService): ThinkingDisplayMode {
	if (contextKeyService.getContextKeyValue<boolean>(SESSIONS_IS_PHONE_LAYOUT_KEY) === true) {
		return ThinkingDisplayMode.CollapsedPreview;
	}
	return configurationService.getValue<ThinkingDisplayMode>('chat.agent.thinkingStyle') ?? ThinkingDisplayMode.CollapsedPreview;
}

function extractTextFromPart(content: IChatThinkingPart): string {
	const raw = Array.isArray(content.value) ? content.value.join('') : (content.value || '');
	return raw.trim();
}

function isEditToolId(toolId: string): boolean {
	const lowerToolId = toolId.toLowerCase();
	return lowerToolId.includes('edit') ||
		lowerToolId.includes('create') ||
		lowerToolId.includes('replace') ||
		lowerToolId.includes('patch');
}

/**
 * Returns true for edit tools whose generic display name should be replaced
 * with "Editing files" while streaming (e.g. replace, multi-replace, patch, insertEdit).
 * Excludes create and notebook tools which already have good labels.
 */
function isGenericEditToolId(toolId: string): boolean {
	const lowerToolId = toolId.toLowerCase();
	if (lowerToolId.includes('create') || lowerToolId.includes('notebook')) {
		return false;
	}
	return lowerToolId.includes('replace') ||
		lowerToolId.includes('patch') ||
		lowerToolId.includes('insertedit') ||
		lowerToolId.includes('insert_edit') ||
		lowerToolId.includes('editfile');
}

export function getToolInvocationIcon(toolId: string, registeredIcon?: ThemeIcon): ThemeIcon {
	if (registeredIcon) {
		return registeredIcon;
	}

	const lowerToolId = toolId.toLowerCase();

	if (
		lowerToolId.includes('search') ||
		lowerToolId.includes('grep') ||
		lowerToolId.includes('find') ||
		lowerToolId.includes('list') ||
		lowerToolId.includes('semantic') ||
		lowerToolId.includes('changes') ||
		lowerToolId.includes('codebase') ||
		lowerToolId.includes('checked')
	) {
		return Codicon.search;
	}

	if (
		lowerToolId.includes('read') ||
		lowerToolId.includes('get_file') ||
		lowerToolId.includes('problems')
	) {
		return Codicon.book;
	}

	if (isEditToolId(toolId)) {
		return Codicon.pencil;
	}

	if (
		lowerToolId.includes('terminal')
	) {
		return Codicon.terminal;
	}

	// default to generic tool icon
	return Codicon.tools;
}

export function createThinkingIcon(icon: ThemeIcon): HTMLElement {
	const iconElement = $('span.chat-thinking-icon');
	iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
	return iconElement;
}

/**
 * Sub-kind of a tool invocation used to group consecutive activity rows into
 * a single Codex-style summary pill ("Read 3 files", "Ran 2 commands").
 */
type ToolActivitySubkind = 'read' | 'search' | 'edit' | 'terminal' | 'other';

type T3WorkEntryIconName = 'bot' | 'eye' | 'globe' | 'hammer' | 'square-pen' | 'terminal' | 'wrench';

interface IT3WorkEntryPresentation {
	readonly heading: string;
	readonly preview?: string;
	readonly details?: string;
	readonly kind?: 'plan';
	readonly planItems?: readonly IT3PlanItem[];
	readonly icon: T3WorkEntryIconName;
	readonly failed: boolean;
}

type T3PlanItemStatus = 'completed' | 'in-progress' | 'pending';

interface IT3PlanItem {
	readonly title: string;
	readonly status: T3PlanItemStatus;
}

function normalizeT3PlanStatus(value: unknown): T3PlanItemStatus | undefined {
	if (value === 'completed') {
		return 'completed';
	}
	if (value === 'in_progress' || value === 'in-progress') {
		return 'in-progress';
	}
	if (value === 'pending' || value === 'not-started') {
		return 'pending';
	}
	return undefined;
}

function t3PlanItemsFromValue(value: unknown): IT3PlanItem[] {
	const candidate = Array.isArray(value)
		? value
		: value && typeof value === 'object'
			? ((value as Record<string, unknown>).todos ?? (value as Record<string, unknown>).todoList)
			: undefined;
	if (!Array.isArray(candidate)) {
		return [];
	}
	return candidate.flatMap(item => {
		if (!item || typeof item !== 'object') {
			return [];
		}
		const record = item as Record<string, unknown>;
		const title = typeof record.title === 'string' ? record.title.trim() : typeof record.content === 'string' ? record.content.trim() : '';
		const status = normalizeT3PlanStatus(record.status);
		return title && status ? [{ title, status }] : [];
	});
}

function t3PlanItemsFromText(value: string | undefined): IT3PlanItem[] {
	if (!value) {
		return [];
	}
	const result: IT3PlanItem[] = [];
	const pattern = /\[(completed|in_progress|in-progress|pending|not-started)\]\s*(.*?)(?=,\s*\[(?:completed|in_progress|in-progress|pending|not-started)\]\s*|$)/gi;
	for (const match of value.matchAll(pattern)) {
		const status = normalizeT3PlanStatus(match[1].toLocaleLowerCase());
		const title = match[2].trim();
		if (status && title) {
			result.push({ title, status });
		}
	}
	return result;
}

function t3PlanItemsFromTexts(values: readonly (string | undefined)[]): IT3PlanItem[] {
	for (const value of values) {
		const items = t3PlanItemsFromText(value);
		if (items.length) {
			return items;
		}
	}
	return [];
}

function textFromMarkdown(value: string | IMarkdownString | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return (typeof value === 'string' ? value : value.value).replace(/\s+/g, ' ').trim() || undefined;
}

function stringifyToolValue(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function firstToolString(value: unknown, keys: readonly string[]): string | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		const candidate = record[key];
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate.trim();
		}
	}
	return undefined;
}

function compactWorkPreview(value: string | undefined, maxLength = 120): string | undefined {
	const compact = value?.replace(/\s+/g, ' ').trim();
	if (!compact) {
		return undefined;
	}
	return middleTruncate(compact, maxLength);
}

function toolInvocationParameters(invocation: IChatToolInvocation | IChatToolInvocationSerialized): unknown {
	if (invocation.toolSpecificData?.kind === 'input') {
		return invocation.toolSpecificData.rawInput;
	}
	if (invocation.kind === 'toolInvocationSerialized') {
		return undefined;
	}
	const state = invocation.state.get();
	return state.type === IChatToolInvocation.StateKind.Streaming ? state.partialInput.get() : state.parameters;
}

function toolInvocationResultPath(invocation: IChatToolInvocation | IChatToolInvocationSerialized): string | undefined {
	const resultDetails: unknown = IChatToolInvocation.resultDetails(invocation);
	if (!Array.isArray(resultDetails) || resultDetails.length === 0) {
		return undefined;
	}
	const first = resultDetails[0];
	if (!first || typeof first !== 'object') {
		return undefined;
	}
	const firstRecord = first as Record<string, unknown>;
	const candidate = firstRecord.uri && typeof firstRecord.uri === 'object'
		? firstRecord.uri as Record<string, unknown>
		: firstRecord;
	const rawPath = typeof candidate.path === 'string'
		? candidate.path
		: typeof candidate.fsPath === 'string'
			? candidate.fsPath
			: undefined;
	if (!rawPath) {
		return undefined;
	}
	const segments = rawPath.split('/').filter(Boolean);
	return segments.length > 1 ? segments.slice(-2).join('/') : rawPath;
}

function t3ToolInvocationFailed(invocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
	const terminalData = invocation.toolSpecificData?.kind === 'terminal'
		? migrateLegacyTerminalToolSpecificData(invocation.toolSpecificData)
		: undefined;
	if (terminalData?.terminalCommandState?.exitCode !== undefined) {
		return terminalData.terminalCommandState.exitCode !== 0;
	}
	return invocation.kind === 'toolInvocation'
		&& invocation.state.get().type === IChatToolInvocation.StateKind.Cancelled;
}

function t3WorkEntryPresentation(
	metadata: ChatThinkingItemMetadata | undefined,
	toolInvocationId: string | undefined,
	fallbackLabel: string | undefined,
	nativeText: string | undefined,
): IT3WorkEntryPresentation {
	if (metadata?.kind === 'externalEdit') {
		const verb = metadata.editKind === 'create' ? 'Created' : metadata.editKind === 'delete' ? 'Deleted' : metadata.editKind === 'rename' ? 'Renamed' : 'Edited';
		return {
			heading: 'File change',
			preview: `${verb} ${basename(metadata.uri)}`,
			details: metadata.uri.path,
			icon: 'square-pen',
			failed: false,
		};
	}
	if (metadata?.kind === 'markdownContent') {
		const uri = extractCodeblockUrisFromText(metadata.content.value)?.uri;
		return {
			heading: 'File change',
			preview: uri ? basename(uri) : compactWorkPreview(fallbackLabel),
			details: uri?.path,
			icon: 'square-pen',
			failed: false,
		};
	}

	const invocation = metadata && (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized') ? metadata : undefined;
	const toolId = (toolInvocationId ?? invocation?.toolId ?? '').toLowerCase();
	const label = textFromMarkdown(invocation?.invocationMessage) ?? compactWorkPreview(fallbackLabel) ?? localize('chat.thinking.toolCall', 'Tool call');
	const originLabel = textFromMarkdown(invocation?.originMessage);
	const completedLabel = textFromMarkdown(invocation?.pastTenseMessage);
	const toolData = invocation?.toolSpecificData;
	const terminalData = toolData?.kind === 'terminal' ? migrateLegacyTerminalToolSpecificData(toolData) : undefined;
	const parameters = invocation ? toolInvocationParameters(invocation) : undefined;
	const modifiedFilePath = toolData?.kind === 'modifiedFilesConfirmation'
		? toolData.modifiedFiles[0]?.title ?? toolData.modifiedFiles[0]?.uri.path
		: undefined;
	const filePath = firstToolString(parameters, ['filePath', 'file_path', 'path', 'targetFile', 'target_file', 'notebookPath', 'notebook_path', 'uri'])
		?? modifiedFilePath
		?? (invocation ? toolInvocationResultPath(invocation) : undefined);
	const query = firstToolString(parameters, ['query', 'pattern', 'searchTerm', 'search_term', 'glob', 'url']);
	const command = terminalData
		? terminalData.presentationOverrides?.commandLine ?? terminalData.commandLine?.forDisplay ?? terminalData.commandLine?.userEdited ?? terminalData.commandLine?.original
		: firstToolString(parameters, ['command', 'cmd', 'script']);
	const subagentPreview = toolData?.kind === 'subagent'
		? [toolData.agentName, toolData.modelName, toolData.description].filter(Boolean).join(' · ')
		: undefined;
	const semanticText = `${toolId} ${label}`.toLocaleLowerCase();
	const isTerminal = toolData?.kind === 'terminal' || semanticText.includes('terminal') || semanticText.includes('bash') || semanticText.includes('shell') || semanticText.includes('exec_command') || semanticText.includes('run command');
	const isEdit = toolData?.kind === 'modifiedFilesConfirmation' || isEditToolId(semanticText) || semanticText.includes('write') || semanticText.includes('delete file') || semanticText.includes('move file');
	const isSearch = toolData?.kind === 'search' || semanticText.includes('search') || semanticText.includes('grep') || semanticText.includes('find') || semanticText.includes('glob') || semanticText.includes('list files') || semanticText.includes('codebase');
	const isRead = semanticText.includes('read') || semanticText.includes('get file') || semanticText.includes('view file') || semanticText.includes('problems');
	const isWeb = semanticText.includes('web') || semanticText.includes('fetch') || semanticText.includes('browser') || semanticText.includes('url');
	const isSubagent = toolData?.kind === 'subagent' || semanticText.includes('agent') || semanticText.includes('subtask');
	const isTodo = toolData?.kind === 'todoList' || semanticText.includes('todo') || semanticText.includes('plan');
	const isMcp = invocation?.source?.type === 'mcp';
	const structuredPlanItems = isTodo ? t3PlanItemsFromValue(toolData?.kind === 'todoList' ? toolData.todoList : parameters) : [];
	const planItems = structuredPlanItems.length
		? structuredPlanItems
		: isTodo ? t3PlanItemsFromTexts([completedLabel, nativeText, fallbackLabel]) : [];

	let heading = label;
	let icon: T3WorkEntryIconName = isMcp ? 'wrench' : 'hammer';
	let preview = compactWorkPreview(filePath ?? query ?? (originLabel !== label ? originLabel : undefined) ?? (completedLabel !== label ? completedLabel : undefined));
	if (isTerminal) {
		heading = 'Terminal';
		icon = 'terminal';
		preview = compactWorkPreview(command);
	} else if (isTodo) {
		heading = localize('chat.thinking.taskProgress', 'Task progress');
		icon = 'bot';
		if (planItems.length) {
			const complete = planItems.filter(item => item.status === 'completed').length;
			preview = localize('chat.thinking.taskProgressCount', '{0} of {1} done', complete, planItems.length);
		} else {
			const todoCount = /(?:updated|created)\s+(\d+)\s+todos?/i.exec(preview ?? label)?.[1];
			const completedCount = (preview ?? label).match(/\[completed\]/gi)?.length;
			if (todoCount && completedCount !== undefined) {
				preview = localize('chat.thinking.taskProgressCount', '{0} of {1} done', completedCount, todoCount);
			}
		}
	} else if (isEdit) {
		heading = 'File change';
		icon = 'square-pen';
	} else if (isRead) {
		heading = 'Read';
		icon = 'eye';
	} else if (isSearch) {
		heading = 'Search';
		icon = 'eye';
	} else if (isWeb) {
		heading = 'Web search';
		icon = 'globe';
	} else if (isSubagent) {
		heading = 'Agent';
		icon = 'bot';
		preview = compactWorkPreview(subagentPreview ?? query ?? filePath);
	} else if (isMcp) {
		heading = label;
		icon = 'wrench';
	}
	if (!preview && nativeText) {
		const compactNative = nativeText.replace(/\s+/g, ' ').trim();
		const withoutLabel = compactNative.toLocaleLowerCase().startsWith(label.toLocaleLowerCase())
			? compactNative.slice(label.length).replace(/^[\s:—–-]+/, '')
			: compactNative;
		preview = compactWorkPreview(withoutLabel, 90);
	}
	if (preview?.toLocaleLowerCase().startsWith(heading.toLocaleLowerCase())) {
		preview = preview.slice(heading.length).replace(/^[\s:—–-]+/, '') || undefined;
	}

	if (preview?.toLocaleLowerCase() === heading.toLocaleLowerCase()) {
		preview = undefined;
	}

	const detailBlocks: string[] = [];
	const parameterText = stringifyToolValue(parameters);
	if (parameterText && !isTodo) {
		detailBlocks.push(parameterText);
	}
	if (toolData?.kind === 'simpleToolInvocation') {
		if (toolData.input.trim()) {
			detailBlocks.push(toolData.input.trim());
		}
		if (toolData.output.trim()) {
			detailBlocks.push(toolData.output.trim());
		}
	}
	if (toolData?.kind === 'subagent') {
		if (toolData.prompt?.trim()) {
			detailBlocks.push(toolData.prompt.trim());
		}
		if (toolData.result?.trim()) {
			detailBlocks.push(toolData.result.trim());
		}
	}
	if (terminalData?.terminalCommandOutput?.text.trim()) {
		detailBlocks.push(terminalData.terminalCommandOutput.text.trim());
	}
	if (detailBlocks.length === 0 && !isTodo) {
		const cleanNativeText = nativeText?.replace(/\s+/g, ' ').trim();
		if (cleanNativeText && cleanNativeText.toLocaleLowerCase() !== label.toLocaleLowerCase()) {
			detailBlocks.push(cleanNativeText);
		}
	}

	const failed = invocation ? t3ToolInvocationFailed(invocation) : false;
	return {
		heading,
		preview,
		details: detailBlocks.join('\n\n') || undefined,
		kind: isTodo ? 'plan' : undefined,
		planItems: planItems.length ? planItems : undefined,
		icon,
		failed,
	};
}

function createT3WorkEntryIcon(document: Document, icon: T3WorkEntryIconName | 'check' | 'chevron' | 'x'): HTMLElement {
	const codicon = icon === 'bot' ? Codicon.robot
		: icon === 'eye' ? Codicon.eye
			: icon === 'globe' ? Codicon.globe
				: icon === 'square-pen' ? Codicon.edit
					: icon === 'terminal' ? Codicon.terminal
						: icon === 'wrench' ? Codicon.wrench
							: icon === 'hammer' ? Codicon.tools
								: icon === 'check' ? Codicon.check
									: icon === 'x' ? Codicon.close
										: Codicon.chevronDown;
	const element = document.createElement('span');
	element.classList.add('chat-thinking-work-row-svg', ...ThemeIcon.asClassNameArray(codicon));
	element.setAttribute('aria-hidden', 'true');
	return element;
}

/**
 * Grouping category. Reads and searches share a group so mixed exploration
 * summarizes as "Read a file and searched code".
 */
const enum ToolActivityCategory {
	Explore = 'explore',
	Edit = 'edit',
	Terminal = 'terminal',
	Other = 'other',
}

export function getToolActivitySubkind(toolInvocationId: string | undefined, metadata: ChatThinkingItemMetadata | undefined): ToolActivitySubkind {
	if (metadata?.kind === 'markdownContent' || metadata?.kind === 'externalEdit' || metadata?.kind === 'textEditGroup') {
		return 'edit';
	}
	const isToolInvocation = metadata && (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized');
	if (isToolInvocation && metadata.toolSpecificData?.kind === 'terminal') {
		return 'terminal';
	}
	if (isToolInvocation && metadata.toolSpecificData?.kind === 'search') {
		return 'search';
	}
	const semanticToolText = [
		toolInvocationId,
		isToolInvocation ? metadata.toolId : undefined,
		isToolInvocation ? textFromMarkdown(metadata.invocationMessage) : undefined,
		isToolInvocation ? textFromMarkdown(metadata.pastTenseMessage) : undefined,
		isToolInvocation ? textFromMarkdown(metadata.originMessage) : undefined,
	].filter(Boolean).join(' ').toLocaleLowerCase();
	if (isEditToolId(semanticToolText)) {
		return 'edit';
	}
	if (
		semanticToolText.includes('terminal') ||
		semanticToolText.includes('bash') ||
		semanticToolText.includes('run_in') ||
		semanticToolText.includes('exec_command') ||
		/(?:^|\s)(?:execute|exec|shell|run_command)(?:\s|$)/.test(semanticToolText)
	) {
		return 'terminal';
	}
	if (
		semanticToolText.includes('search') ||
		semanticToolText.includes('grep') ||
		semanticToolText.includes('find') ||
		semanticToolText.includes('list') ||
		semanticToolText.includes('semantic') ||
		semanticToolText.includes('codebase') ||
		semanticToolText.includes('glob')
	) {
		return 'search';
	}
	if (semanticToolText.includes('read') || semanticToolText.includes('get_file') || semanticToolText.includes('fetch') || semanticToolText.includes('problems')) {
		return 'read';
	}
	return 'other';
}

function toolActivityCategoryOf(subkind: ToolActivitySubkind): ToolActivityCategory {
	switch (subkind) {
		case 'read':
		case 'search':
			return ToolActivityCategory.Explore;
		case 'edit':
			return ToolActivityCategory.Edit;
		case 'terminal':
			return ToolActivityCategory.Terminal;
		default:
			return ToolActivityCategory.Other;
	}
}

function toolActivityCategoryIcon(category: ToolActivityCategory): ThemeIcon {
	switch (category) {
		case ToolActivityCategory.Explore:
			return Codicon.search;
		case ToolActivityCategory.Edit:
			return Codicon.pencil;
		case ToolActivityCategory.Terminal:
			return Codicon.terminal;
		default:
			return Codicon.tools;
	}
}

/** Middle-truncates so both the head and tail of long labels stay readable. */
export function middleTruncate(value: string, maxLength = 64): string {
	if (value.length <= maxLength) {
		return value;
	}
	const headLength = Math.ceil((maxLength - 1) * 0.6);
	const tailLength = (maxLength - 1) - headLength;
	return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

/** Formats a duration for the working header / completed pill, e.g. "8s", "1m 12s". */
export function formatThinkingElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return localize('chat.thinking.elapsed.seconds', "{0}s", totalSeconds);
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (seconds === 0) {
		return localize('chat.thinking.elapsed.minutes', "{0}m", minutes);
	}
	return localize('chat.thinking.elapsed.minutesSeconds', "{0}m {1}s", minutes, seconds);
}

/**
 * One Codex-style activity group: consecutive same-category tool rows wrapped
 * under a summary header. Clean chat hosts expose that header as a live status
 * while the tool runs; completed groups become ordinary collapsible summaries.
 */
interface IToolActivityGroup {
	readonly category: ToolActivityCategory;
	readonly startedAt: number;
	readonly container: HTMLElement;
	readonly header: HTMLElement;
	readonly iconElement: HTMLElement;
	readonly headerLabel: HTMLElement;
	readonly chevron: HTMLElement;
	readonly body: HTMLElement;
	readonly items: { toolCallId?: string; subkind: ToolActivitySubkind; fallbackLabel?: string }[];
	readonly hover: MutableDisposable<IDisposable>;
	expanded: boolean;
}

function extractTitleFromThinkingContent(content: string): string | undefined {
	const headerMatch = content.match(/^\*\*([^*]+)\*\*/);
	return headerMatch ? headerMatch[1] : undefined;
}

/** Last non-empty line of the streaming reasoning, stripped of list/heading markers. */
function lastNonEmptyThinkingLine(content: string): string | undefined {
	const lines = content.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].replace(/^[\s#*>-]+/, '').replace(/\*\*/g, '').trim();
		if (line.length > 0) {
			return line;
		}
	}
	return undefined;
}

/**
 * Metadata passed to {@link ChatThinkingContentPart.appendItem} to drive
 * title / icon extraction. The `kind` discriminates which payload is
 * available; the thinking part inspects it to compute a label like
 * "Edited foo.ts" without rendering the actual content itself (the
 * factory provides the DOM).
 */
export type ChatThinkingItemMetadata =
	| IChatToolInvocation
	| IChatToolInvocationSerialized
	| IChatMarkdownContent
	| IChatExternalEdit
	| IChatTextEditGroup;

function isBackboardCursorTranscript(container: HTMLElement): boolean {
	return container.closest('.backboard-cursor-transcript') !== null
		|| (container.closest('.part.auxiliarybar') !== null && container.closest('.backboard-chat-controls') !== null);
}

interface ILazyToolItem {
	kind: 'tool';
	lazy: Lazy<{ domNode: HTMLElement; disposable?: IDisposable }>;
	toolInvocationId?: string;
	toolInvocationOrMarkdown?: ChatThinkingItemMetadata;
	originalParent?: HTMLElement;
	isHook?: boolean;
}

interface ILazyThinkingItem {
	kind: 'thinking';
	textContainer: HTMLElement;
	content: IChatThinkingPart;
}

type ILazyItem = ILazyToolItem | ILazyThinkingItem;
const THINKING_SCROLL_MAX_HEIGHT = 200;

const TITLE_CACHE_STORAGE_KEY = 'chat.thinkingTitleCache';
const TITLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TITLE_CACHE_MAX_ENTRIES = 1000;

const enum WorkingMessageCategory {
	Thinking = 'thinking',
	Terminal = 'terminal',
	Tool = 'tool'
}

export const defaultThinkingMessages = [
	localize('chat.thinking.thinking.1', 'Thinking it through'),
	localize('chat.thinking.thinking.2', 'Reasoning'),
	localize('chat.thinking.thinking.3', 'Connecting the dots'),
	localize('chat.thinking.thinking.4', 'Mapping the approach'),
	localize('chat.thinking.thinking.5', 'Weighing the options'),
	localize('chat.thinking.thinking.6', 'Working it out'),
];

const terminalMessages = [
	localize('chat.thinking.terminal.1', 'Running the command'),
	localize('chat.thinking.terminal.2', 'Watching the output'),
	localize('chat.thinking.terminal.3', 'Waiting on the terminal'),
];

const toolMessages = [
	localize('chat.thinking.tool.1', 'Gathering context'),
	localize('chat.thinking.tool.2', 'Lining things up'),
	localize('chat.thinking.tool.3', 'Pulling the pieces together'),
	localize('chat.thinking.tool.4', 'Checking the details'),
	localize('chat.thinking.tool.5', 'Sizing up the task'),
];

/** Easter-egg loading messages, used ~1 in {@link FUN_WORKING_MESSAGE_RATE} picks. */
const funWorkingMessages = [
	// Generic
	localize('chat.working.fun.1', "Bribing the hamster"),
	localize('chat.working.fun.2', "Reticulating splines"),
	localize('chat.working.fun.3', "Untangling the spaghetti"),
	localize('chat.working.fun.4', "Communing with the codebase"),

	// Minecraft
	localize('chat.working.fun.minecraft.1', "Mining diamonds"),

	// Microsoft
	localize('chat.working.fun.ms.1', "Summoning Clippy"),
];

const FUN_WORKING_MESSAGE_RATE = 50;

type ThinkingPhrasesConfiguration = { mode?: 'replace' | 'append'; phrases?: string[] };

function getCustomThinkingPhrases(configurationService: IConfigurationService): { customPhrases: string[]; replaceDefaults: boolean } {
	const config = configurationService.getValue<ThinkingPhrasesConfiguration>(ChatConfiguration.ThinkingPhrases);
	const customPhrases = Array.isArray(config?.phrases)
		? config.phrases
			.filter((phrase): phrase is string => typeof phrase === 'string')
			.map(phrase => phrase.trim())
			.filter(phrase => phrase.length > 0)
		: [];

	return {
		customPhrases,
		replaceDefaults: config?.mode === 'replace' && customPhrases.length > 0,
	};
}

/** Returns an easter-egg message ~1 in {@link FUN_WORKING_MESSAGE_RATE}, else `undefined`. */
export function maybePickFunWorkingMessage(configurationService: IConfigurationService, random = Math.random): string | undefined {
	if (getCustomThinkingPhrases(configurationService).replaceDefaults) {
		return undefined;
	}

	if (Math.floor(random() * FUN_WORKING_MESSAGE_RATE) === 0) {
		return funWorkingMessages[Math.floor(random() * funWorkingMessages.length)];
	}
	return undefined;
}

/**
 * Builds a phrase pool from defaults and user-configured custom phrases.
 * In 'replace' mode, only custom phrases are used; in 'append' mode (default),
 * custom phrases are added to the defaults.
 */
export function buildPhrasePool(defaults: string[], configurationService: IConfigurationService): string[] {
	const { customPhrases, replaceDefaults } = getCustomThinkingPhrases(configurationService);

	if (customPhrases.length > 0) {
		return replaceDefaults ? [...customPhrases] : [...defaults, ...customPhrases];
	}
	return [...defaults];
}

export class ChatThinkingContentPart extends ChatCollapsibleContentPart implements IChatContentPart {

	private static _codeBlockRendererSync(_languageId: string, text: string, _raw?: string): HTMLElement {
		const codeElement = $('code');
		codeElement.textContent = text;
		return codeElement;
	}

	public readonly codeblocks: undefined;
	public readonly codeblocksPartId: undefined;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	private readonly _asyncRenderCallback = () => this._onDidChangeHeight.fire();

	private id: string | undefined;
	private content: IChatThinkingPart;
	private currentThinkingValue: string;
	private currentTitle: string;
	private defaultTitle = localize('chat.thinking.header', 'Thinking');
	private readonly workingTitle = localize('chat.thinking.header.working', 'Working');
	private textContainer!: HTMLElement;
	private readonly _markdownResult = this._register(new MutableDisposable<IRenderedMarkdown>());
	private wrapper!: HTMLElement;
	private fixedScrollingMode: boolean = false;
	private streamThenCollapseMode: boolean = false;
	private readonly wasStreamingLive: boolean;
	private readonly useCursorPanelPresentation: boolean;
	private readonly useCursorTranscriptPresentation: boolean;
	private readonly _collapseAnimation = this._register(new MutableDisposable<DisposableStore>());
	private readonly startTimeMs: number;
	private elapsedAtCompletionMs: number | undefined;
	private readonly _elapsedTimer = this._register(new MutableDisposable<IDisposable>());
	private titleElapsedSpan: HTMLElement | undefined;
	private readonly activityGroups: IToolActivityGroup[] = [];
	private activeActivityGroup: IToolActivityGroup | undefined;
	private autoScrollEnabled: boolean = true;
	private scrollableElement: DomScrollableElement | undefined;
	private lastExtractedTitle: string | undefined;
	private extractedTitles: string[] = [];
	private toolInvocationCount: number = 0;
	private appendedItemCount: number = 0;
	private isActive: boolean = true;
	private toolInvocations: (IChatToolInvocation | IChatToolInvocationSerialized)[] = [];
	private allThinkingParts: IChatThinkingPart[] = [];
	private hookCount: number = 0;
	private singleItemInfo: { element: HTMLElement; originalParent: HTMLElement; originalNextSibling: Node | null; toolInvocation?: IChatToolInvocation | IChatToolInvocationSerialized } | undefined;
	private lazyItems: ILazyItem[] = [];
	private hasExpandedOnce: boolean = false;
	private workingSpinnerElement: HTMLElement | undefined;
	private workingSpinnerLabel: HTMLElement | undefined;
	private readonly cursorReasoningDisclosures = new Map<HTMLElement, {
		readonly label: HTMLElement;
		readonly labelText: HTMLElement;
		readonly chevron: HTMLElement;
		expanded: boolean;
	}>();
	private liveReasoningTail: string | undefined;
	/** The spinner phrase / active-tool label without the live elapsed suffix. */
	private workingSpinnerBaseText: string | undefined;
	private availableMessagesByCategory = new Map<WorkingMessageCategory, string[]>();
	private readonly toolWrappersByCallId = new Map<string, HTMLElement>();
	private readonly toolIconsByCallId = new Map<string, HTMLElement>();
	private readonly toolLabelsByCallId = new Map<string, string>();
	private readonly toolDisposables = this._register(new DisposableMap<string, DisposableStore>());
	private readonly ownedToolParts = new Map<string, IDisposable>();
	private pendingRemovals: { toolCallId: string; toolLabel: string }[] = [];
	private pendingRemovalFlushDisposable: IDisposable | undefined;
	private pendingScrollDisposable: IDisposable | undefined;
	private wrapperResizeObserverDisposable: IDisposable | undefined;
	private childResizeObserver: DisposableResizeObserver | undefined;
	private isUpdatingDimensions: boolean = false;
	private lastKnownContentHeight: number = 0;
	private lastKnownScrollTop: number = 0;
	private readonly showProgressDetails: boolean;
	private titleShimmerSpan: HTMLElement | undefined;
	private titleDetailContainer: HTMLElement | undefined;
	private readonly _externalResourceWidget: ChatThinkingExternalResourceWidget;
	private readonly _pendingExternalResources = new Map<string, IChatToolInvocation | IChatToolInvocationSerialized>();
	private readonly _titleDetailRendered = this._register(new MutableDisposable<IRenderedMarkdown>());
	private readonly _pendingAppendRefresh = this._register(new MutableDisposable<IDisposable>());
	private readonly diffStatsByPartId = new Map<string, IEditSessionDiffStats>();
	private _aggregatedDiff: IEditSessionDiffStats = { added: 0, removed: 0 };

	get aggregatedDiff(): IEditSessionDiffStats { return this._aggregatedDiff; }

	private getRandomWorkingMessage(category: WorkingMessageCategory = WorkingMessageCategory.Tool): string {
		const fun = maybePickFunWorkingMessage(this.configurationService);
		if (fun) {
			return fun;
		}

		let pool = this.availableMessagesByCategory.get(category);
		if (!pool || pool.length === 0) {
			let defaults: string[];
			switch (category) {
				case WorkingMessageCategory.Thinking:
					defaults = defaultThinkingMessages;
					break;
				case WorkingMessageCategory.Terminal:
					defaults = terminalMessages;
					break;
				case WorkingMessageCategory.Tool:
				default:
					defaults = toolMessages;
					break;
			}

			pool = buildPhrasePool(defaults, this.configurationService);

			this.availableMessagesByCategory.set(category, pool);
		}
		const index = Math.floor(Math.random() * pool.length);
		return pool.splice(index, 1)[0];
	}

	constructor(
		content: IChatThinkingPart,
		context: IChatContentPartRenderContext,
		private readonly chatContentMarkdownRenderer: IMarkdownRenderer,
		private streamingCompleted: boolean,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IHoverService hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		const initialText = extractTextFromPart(content);
		const extractedTitle = extractTitleFromThinkingContent(initialText)
			?? localize('chat.thinking.header.initial', 'Thinking');

		super(extractedTitle, context, undefined, hoverService, configurationService);
		this.useCursorTranscriptPresentation = isBackboardCursorTranscript(context.container);
		this.useCursorPanelPresentation = context.container.closest('.backboard-clean-chat, .part.auxiliarybar') !== null
			|| context.container.ownerDocument.querySelector('.agent-sessions-workbench') !== null;

		this.id = content.id;
		this.content = content;
		this.allThinkingParts.push(content);
		this.showProgressDetails = this.configurationService.getValue<boolean>(ChatConfiguration.ChatPersistentProgressEnabled) !== false
			&& (this.configurationService.getValue<boolean>(ChatConfiguration.ProgressBorder) !== true || accessibilityService.isMotionReduced());
		const configuredMode = getEffectiveThinkingDisplayMode(this.configurationService, contextKeyService);

		// The Backboard middle panel follows T3's document-flow timeline. VS
		// Code's fixed-height reasoning viewport clips and scrolls the whole work
		// log as one unit, while T3 keeps every work row in ordinary page flow.
		this.fixedScrollingMode = !this.useCursorPanelPresentation && configuredMode === ThinkingDisplayMode.FixedScrolling;
		this.streamThenCollapseMode = configuredMode === ThinkingDisplayMode.StreamThenCollapse;
		this.wasStreamingLive = !this.streamingCompleted && !this.element.isComplete;
		this.startTimeMs = Date.now();

		this.currentTitle = extractedTitle;
		if (extractedTitle !== this.defaultTitle) {
			this.lastExtractedTitle = extractedTitle;
			this.extractedTitles.push(extractedTitle);
		}
		this.currentThinkingValue = initialText;

		if (initialText.trim()) {
			this.appendedItemCount++;
		}

		// Alert screen reader users that thinking has started
		if (this.configurationService.getValue(AccessibilityWorkbenchSettingId.VerboseChatProgressUpdates)) {
			alert(localize('chat.thinking.started', 'Thinking'));
		}

		if (configuredMode === ThinkingDisplayMode.Collapsed) {
			this.setExpanded(false);
		} else if (configuredMode === ThinkingDisplayMode.CollapsedPreview || configuredMode === ThinkingDisplayMode.StreamThenCollapse) {
			// Start expanded if still in progress.
			// streamingCompleted is true when look-ahead finds subsequent non-pinnable
			// parts, meaning this thinking part won't receive more content.
			this.setExpanded(!this.streamingCompleted && !this.element.isComplete);
		} else {
			this.setExpanded(false);
		}

		const node = this.domNode;
		node.classList.add('chat-thinking-box');

		// Tick a subtle elapsed indicator in the header while streaming live.
		if (this.wasStreamingLive) {
			this._elapsedTimer.value = disposableWindowInterval(getWindow(node), () => {
				if (this.streamingCompleted || this.element.isComplete) {
					this._elapsedTimer.clear();
					return;
				}
				this.updateElapsedIndicator();
				this.applyLiveReasoningTail();
				// Keep the in-thinking spinner ticking too, so it never looks
				// frozen on a static phrase while the model reasons silently.
				this.renderWorkingSpinnerLabel();
				if (this.activeActivityGroup) {
					this.updateActivityGroupHeader(this.activeActivityGroup);
				}
			}, 1000);
		}

		this._externalResourceWidget = this._register(this.instantiationService.createInstance(ChatThinkingExternalResourceWidget));
		this._register(this._externalResourceWidget.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
		node.appendChild(this._externalResourceWidget.domNode);

		if (!this.streamingCompleted && !this.element.isComplete) {
			if (!this.fixedScrollingMode) {
				node.classList.add('chat-thinking-active');
			}
		}

		if (!this.fixedScrollingMode && !this.streamingCompleted && !this.element.isComplete && this._collapseButton) {
			const labelElement = this._collapseButton.labelElement;
			labelElement.textContent = '';
			this.titleShimmerSpan = $('span.chat-thinking-title-shimmer');
			this.titleShimmerSpan.textContent = extractedTitle;
			labelElement.appendChild(this.titleShimmerSpan);
		}

		if (this.fixedScrollingMode) {
			node.classList.add('chat-thinking-fixed-mode');
			if (!this.streamingCompleted && !this.element.isComplete && this.showProgressDetails) {
				node.classList.add('chat-thinking-persistent-streaming');
			}
			this.currentTitle = this.defaultTitle;
		}

		this._register(toDisposable(() => {
			for (const d of this.ownedToolParts.values()) {
				d.dispose();
			}
			this.ownedToolParts.clear();
		}));

		// override for codicon chevron in the collapsible part
		this._register(autorun(r => {
			const isExpanded = this.expanded.read(r);
			if (this._collapseButton) {
				if (this.streamingCompleted || this.element.isComplete) {
					this._collapseButton.icon = this.isCanceledResponse() ? Codicon.circleSlash : Codicon.check;
				} else if (!this.fixedScrollingMode) {
					if (isExpanded) {
						this._collapseButton.icon = Codicon.chevronDown;
					} else {
						this._collapseButton.icon = Codicon.circleFilled;
					}
				}
			}
		}));

		this._register(autorun(r => {
			const isExpanded = this._isExpanded.read(r);
			// Materialize lazy items when first expanded
			if (isExpanded && !this.hasExpandedOnce) {
				this.hasExpandedOnce = true;
				if (this.lazyItems.length > 0) {
					// Flush pending removals so that completed hidden tools are removed from lazyItems before materialization
					this.processPendingRemovals();
					for (const item of this.lazyItems) {
						this.materializeLazyItem(item);
					}
				}
			}

			// If expanded but content matches title and there's nothing else to show, revert immediately.
			// Skip this check while still streaming — more content will arrive.
			if (isExpanded && !this.shouldAllowExpansion() && (this.streamingCompleted || this.element.isComplete)) {
				this.setExpanded(false);
				return;
			}

			this._externalResourceWidget.setCollapsed(!isExpanded);

			// Lazy materialization can update the title while a restored completed
			// fold opens. T3 keeps the lifecycle label stable in both states.
			if (this.useCursorPanelPresentation && (this.streamingCompleted || this.element.isComplete)) {
				this.setFinalizedTitle(this.defaultTitle);
			}

			// Fire when expanded/collapsed
			this._onDidChangeHeight.fire();
		}));

		const label = this.lastExtractedTitle ?? '';
		if (!this.fixedScrollingMode && (!this._isExpanded.get() || this.streamThenCollapseMode)) {
			this.setTitle(label);
		}

		if (this._collapseButton) {
			this._register(this._collapseButton.onDidClick(() => {
				if (this.streamingCompleted || this.fixedScrollingMode) {
					return;
				}

				const expanded = this.isExpanded();
				if (expanded) {
					// Just expanded: show plain 'Working' with no detail
					this.setTitle(this.defaultTitle, true);
					this.currentTitle = this.defaultTitle;
				} else {
					// Just collapsed: show latest tool/thinking title with 'Working:' prefix
					if (this.lastExtractedTitle) {
						this.setTitle(this.lastExtractedTitle);
					} else {
						this.setTitle(this.defaultTitle, true);
						this.currentTitle = this.defaultTitle;
					}
				}
			}));
		}

		// Restored completed turns do not pass through finalizeTitleIfDefault(),
		// so give Backboard's clean transcript the same quiet completed label on
		// first render that a live turn receives when it finishes.
		if (this.useCursorPanelPresentation && (this.streamingCompleted || this.element.isComplete)) {
			this.setFinalizedTitle(this.defaultTitle);
		}
	}

	protected override shouldInitEarly(): boolean {
		// T3's timeline always mounts its work entries; only their individual
		// details are disclosed on demand. The native chat renderer normally
		// delays the entire thinking body until VS Code's outer fold is opened,
		// which leaves restored Backboard threads with styled but unmounted rows.
		return this.useCursorPanelPresentation || (this.fixedScrollingMode && !this.streamingCompleted);
	}

	// @TODO: @justschen Convert to template for each setting?
	protected override initContent(): HTMLElement {
		this.wrapper = $('.chat-used-context-list.chat-thinking-collapsible');
		if (!this.streamingCompleted) {
			this.wrapper.classList.add('chat-thinking-streaming');
		}

		// Only create textContainer here if there's no pending lazy thinking item.
		// If there's a lazy thinking item, it will be rendered via materializeLazyItem
		// with the latest streaming content.
		const hasLazyThinkingItems = this.lazyItems.some(item => item.kind === 'thinking');
		if ((this.currentThinkingValue || this.useCursorTranscriptPresentation) && !hasLazyThinkingItems) {
			this.textContainer = $('.chat-thinking-item.markdown-content');
			const hasReasoning = !!this.currentThinkingValue.trim();
			this.textContainer.hidden = this.useCursorTranscriptPresentation && !hasReasoning;
			this.appendCursorReasoningContainer(this.textContainer, hasReasoning);
			if (this.currentThinkingValue) {
				this.renderMarkdown(this.currentThinkingValue);
			}
		}

		// Show the in-thinking spinner while streaming. When collapsed, the CSS
		// clipping hides it (the title shimmer is the visible indicator). When
		// expanded, the title shimmer is less prominent so this spinner at the
		// bottom of the section serves as the active indicator. In fixed-scrolling
		// mode with progress details enabled, the working-progress row owns the
		// active indicator instead, so skip creating the in-thinking spinner.
		if (!this.streamingCompleted && !this.element.isComplete && !(this.fixedScrollingMode && this.showProgressDetails)) {
			this.workingSpinnerElement = $('.chat-thinking-item.chat-thinking-spinner-item');
			const spinnerIcon = createThinkingIcon(this.useCursorPanelPresentation
				? ThemeIcon.modify(Codicon.loading, 'spin')
				: Codicon.circleFilled);
			this.workingSpinnerElement.appendChild(spinnerIcon);
			this.workingSpinnerLabel = $('span.chat-thinking-spinner-label');
			this.setWorkingSpinnerBase(this.getWorkingFallbackMessage(WorkingMessageCategory.Thinking));
			this.workingSpinnerElement.appendChild(this.workingSpinnerLabel);
			this.wrapper.appendChild(this.workingSpinnerElement);
			this.updateWorkingSpinnerVisibility();
		}

		// wrap content in scrollable element for fixed scrolling mode
		if (this.fixedScrollingMode) {
			this.scrollableElement = this._register(new DomScrollableElement(this.wrapper, {
				vertical: ScrollbarVisibility.Auto,
				horizontal: ScrollbarVisibility.Hidden,
				handleMouseWheel: true,
				alwaysConsumeMouseWheel: false
			}));
			this._register(this.scrollableElement.onScroll(e => this.handleScroll(e.scrollTop)));

			let pendingMutationRefresh: IDisposable | undefined;
			const mutationObserver = new MutationObserver(() => {
				if (pendingMutationRefresh) {
					return;
				}
				pendingMutationRefresh = scheduleAtNextAnimationFrame(getWindow(this.wrapper), () => {
					pendingMutationRefresh = undefined;
					if (this.streamingCompleted || !this.domNode.classList.contains('chat-used-context-collapsed')) {
						return;
					}
					this.refreshContentHeight();
					this.updateScrollDimensionsFromCache();
				});
			});
			mutationObserver.observe(this.wrapper, { childList: true, subtree: true });
			this._register({
				dispose: () => {
					mutationObserver.disconnect();
					pendingMutationRefresh?.dispose();
				}
			});

			// Observe child elements for resizes (e.g. terminal output growing)
			// so we can update scroll dimensions when the wrapper box is pinned at max-height.
			this.childResizeObserver = this._register(new DisposableResizeObserver('ChatThinkingContentPart.child', () => {
				if (this.streamingCompleted || !this.domNode.classList.contains('chat-used-context-collapsed')) {
					return;
				}

				this.syncDimensionsAndScheduleScroll();
			}));
			if (this.textContainer) {
				this._register(this.childResizeObserver.observe(this.textContainer));
			}
			if (this.workingSpinnerElement) {
				this._register(this.childResizeObserver.observe(this.workingSpinnerElement));
			}

			// Cache wrapper scrollHeight post-layout via ResizeObserver to avoid forced reflows.
			const wrapperResizeObserver = this._register(new DisposableResizeObserver('ChatThinkingContentPart.wrapper', (entries) => {
				if (entries[0]) {
					this.lastKnownContentHeight = this.wrapper.scrollHeight;
					if (!this.streamingCompleted && this.domNode.classList.contains('chat-used-context-collapsed')) {
						this.updateScrollDimensionsFromCache();
					}
				}
			}));
			this.wrapperResizeObserverDisposable = this._register(wrapperResizeObserver.observe(this.wrapper));

			// Once content exceeds max-height, the wrapper box size stops changing
			// so ResizeObserver won't fire. Fall back to scrollHeight reads here.
			this._register(this._onDidChangeHeight.event(() => {
				if (!this.streamingCompleted && this.wrapperResizeObserverDisposable) {
					this.refreshContentHeight();
					this.updateScrollDimensionsFromCache();
					return;
				}
				this.syncDimensionsAndScheduleScroll();
			}));

			this.syncDimensionsAndScheduleScroll();

			this.updateDropdownClickability();
			return this.scrollableElement.getDomNode();
		}

		this.updateDropdownClickability();
		return this.wrapper;
	}

	private handleScroll(scrollTop: number): void {
		if (!this.scrollableElement || this.isUpdatingDimensions) {
			return;
		}

		this.lastKnownScrollTop = scrollTop;
		const contentHeight = this.lastKnownContentHeight;
		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);
		const maxScrollTop = contentHeight - viewportHeight;
		this.autoScrollEnabled = maxScrollTop <= 0 || scrollTop >= maxScrollTop - 10;

		this.updateFadeClasses(scrollTop, contentHeight, viewportHeight);
	}

	private updateFadeClasses(scrollTop?: number, contentHeight?: number, viewportHeight?: number): void {
		if (!this.fixedScrollingMode || this.streamingCompleted) {
			this.domNode.classList.remove('chat-thinking-fade-top', 'chat-thinking-fade-bottom');
			return;
		}

		const currentScrollTop = scrollTop ?? this.lastKnownScrollTop;
		const currentContentHeight = contentHeight ?? this.lastKnownContentHeight;
		const currentViewportHeight = viewportHeight ?? Math.min(currentContentHeight, THINKING_SCROLL_MAX_HEIGHT);
		const maxScrollTop = currentContentHeight - currentViewportHeight;

		this.domNode.classList.toggle('chat-thinking-fade-top', currentScrollTop > 5);
		this.domNode.classList.toggle('chat-thinking-fade-bottom', maxScrollTop > 0 && currentScrollTop < maxScrollTop - 5);
	}

	// Fallback for non-ResizeObserver updates (onDidChangeHeight, initial setup).
	private syncDimensionsAndScheduleScroll(): void {
		if (this.pendingScrollDisposable) {
			return;
		}
		this.pendingScrollDisposable = scheduleAtNextAnimationFrame(getWindow(this.domNode), () => {
			this.pendingScrollDisposable = undefined;
			if (this._store.isDisposed) {
				return;
			}
			this.refreshContentHeight();
			this.updateScrollDimensionsFromCache();
		});
	}

	/**
	 * Re-read scrollHeight from the DOM and update cached height if changed.
	 */
	private refreshContentHeight(): void {
		if (!this.wrapper || !this.scrollableElement) {
			return;
		}
		const newHeight = this.wrapper.scrollHeight;
		if (newHeight && newHeight !== this.lastKnownContentHeight) {
			this.lastKnownContentHeight = newHeight;
		}
	}

	private updateScrollDimensionsFromCache(): void {
		if (!this.scrollableElement || this._store.isDisposed) {
			return;
		}

		const isCollapsed = this.domNode.classList.contains('chat-used-context-collapsed');
		if (!isCollapsed) {
			return;
		}

		const contentHeight = this.lastKnownContentHeight;
		if (!contentHeight) {
			return;
		}

		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);

		this.isUpdatingDimensions = true;
		try {
			const viewportWidth = this.scrollableElement.getDomNode().clientWidth;
			this.scrollableElement.setScrollDimensions({
				width: viewportWidth,
				scrollWidth: viewportWidth,
				height: viewportHeight,
				scrollHeight: contentHeight
			});

			if (this.autoScrollEnabled) {
				this.scrollToBottom(contentHeight);
			}
		} finally {
			this.isUpdatingDimensions = false;
		}

		this.updateFadeClasses(this.lastKnownScrollTop, this.lastKnownContentHeight);
		this.updateDropdownClickability(contentHeight);
	}

	private scrollToBottom(contentHeight: number): void {
		if (!this.scrollableElement) {
			return;
		}

		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);

		if (contentHeight > viewportHeight) {
			const newScrollTop = contentHeight - viewportHeight;
			this.lastKnownScrollTop = newScrollTop;
			this.scrollableElement.setScrollPosition({ scrollTop: newScrollTop });
		}
	}

	/**
	 * updates scroll dimensions when streaming is complete.
	 */
	private updateScrollDimensionsForCompletion(): void {
		if (!this.scrollableElement || !this.fixedScrollingMode) {
			return;
		}

		const contentHeight = this.wrapper.scrollHeight;
		this.lastKnownContentHeight = contentHeight;
		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);

		const viewportWidth = this.scrollableElement.getDomNode().clientWidth;
		this.scrollableElement.setScrollDimensions({
			width: viewportWidth,
			scrollWidth: viewportWidth,
			height: viewportHeight,
			scrollHeight: contentHeight
		});

		if (contentHeight <= THINKING_SCROLL_MAX_HEIGHT) {
			this.scrollableElement.setScrollPosition({ scrollTop: 0 });
		}
	}

	private renderMarkdown(content: string, reuseExisting?: boolean): void {
		// Guard against rendering after disposal to avoid leaking disposables
		if (this._store.isDisposed) {
			return;
		}
		const cleanedContent = content.trim();
		if (!cleanedContent) {
			this._markdownResult.clear();
			if (this.textContainer) {
				clearNode(this.textContainer);
			}
			return;
		}
		this.ensureCursorReasoningLabel();

		// If the entire content is bolded, strip the bold markers for rendering
		let contentToRender = cleanedContent;
		if (cleanedContent.startsWith('**') && cleanedContent.endsWith('**')) {
			contentToRender = cleanedContent.slice(2, -2);
		}

		const target = reuseExisting ? this._markdownResult.value?.element : undefined;

		const rendered = this.chatContentMarkdownRenderer.render(new MarkdownString(contentToRender), {
			fillInIncompleteTokens: true,
			asyncRenderCallback: this._asyncRenderCallback,
			codeBlockRendererSync: ChatThinkingContentPart._codeBlockRendererSync,
		}, target);
		this._markdownResult.value = rendered;
		if (!target) {
			if (this.textContainer) {
				clearNode(this.textContainer);
				this.textContainer.appendChild(createThinkingIcon(Codicon.circleFilled));
				this.textContainer.appendChild(rendered.element);
			}
		}
	}

	private setFinalizedTitle(title: string): void {
		if (!this._collapseButton) {
			return;
		}

		this.removeElapsedIndicator();

		const labelElement = this._collapseButton.labelElement;
		labelElement.textContent = '';

		// Cursor keeps the completed turn fold deliberately quiet in the editor's
		// right panel: "Worked for 39s". Generated summaries, step counts, and
		// aggregate diff stats remain useful in the larger chat surfaces, but make
		// this narrow transcript header feel busier than the reference UI.
		if (this.useCursorPanelPresentation && !this.isCanceledResponse()) {
			const panelTitle = this.wasStreamingLive
				? localize('chat.thinking.workedFor', "Worked for {0}", formatThinkingElapsed(this.getElapsedMs()))
				: localize('chat.thinking.finished', 'Worked');
			labelElement.textContent = panelTitle;
			this._collapseButton.element.ariaLabel = panelTitle;
			return;
		}

		const firstSpaceIndex = title.indexOf(' ');
		if (firstSpaceIndex === -1) {
			// Single word title, no need to split
			labelElement.textContent = title;
		} else {
			const verb = title.substring(0, firstSpaceIndex);
			const rest = title.substring(firstSpaceIndex);

			const verbSpan = $('span');
			verbSpan.textContent = verb;
			labelElement.appendChild(verbSpan);

			const restSpan = $('span.chat-thinking-title-detail-text');
			restSpan.textContent = rest;
			labelElement.appendChild(restSpan);
		}

		let ariaLabel = title;

		// Summarize the work: elapsed time (live runs only) and step count.
		// Skipped for cancelled runs whose title already carries the duration.
		const metaFragments: string[] = [];
		if (this.wasStreamingLive && !this.isCanceledResponse()) {
			metaFragments.push(formatThinkingElapsed(this.getElapsedMs()));
		}
		if (this.appendedItemCount > 1) {
			metaFragments.push(localize('chat.thinking.steps', "{0} steps", this.appendedItemCount));
		}
		if (metaFragments.length > 0) {
			const metaSpan = $('span.chat-thinking-title-meta');
			metaSpan.textContent = metaFragments.map(fragment => ` · ${fragment}`).join('');
			labelElement.appendChild(metaSpan);
			ariaLabel = `${title}, ${metaFragments.join(', ')}`;
		}

		// Show aggregated diff stats from edit pills (only when there are actual changes)
		if (this.diffStatsByPartId.size > 0) {
			const { added, removed } = this._aggregatedDiff;
			if (added > 0 || removed > 0) {
				const diffContainer = $('span.chat-thinking-title-diff');
				diffContainer.appendChild($('span.label-added', {}, `+${added}`));
				diffContainer.appendChild($('span.label-removed', {}, `-${removed}`));
				labelElement.appendChild(diffContainer);

				const insertionsFragment = added === 1 ? localize('chat.thinking.insertions.one', "1 insertion") : localize('chat.thinking.insertions', "{0} insertions", added);
				const deletionsFragment = removed === 1 ? localize('chat.thinking.deletions.one', "1 deletion") : localize('chat.thinking.deletions', "{0} deletions", removed);
				this._collapseButton.element.ariaLabel = localize('chat.thinking.titleWithDiff', "{0}, {1}, {2}", ariaLabel, insertionsFragment, deletionsFragment);
			} else {
				this._collapseButton.element.ariaLabel = ariaLabel;
			}
		} else {
			this._collapseButton.element.ariaLabel = ariaLabel;
		}
	}

	/** Whether the owning response was cancelled by the user. */
	private isCanceledResponse(): boolean {
		return 'isCanceled' in this.element && this.element.isCanceled === true;
	}

	private setDropdownClickable(clickable: boolean): void {
		if (this._collapseButton) {
			this._collapseButton.element.style.pointerEvents = clickable ? 'auto' : 'none';
		}

		if (!clickable && this.streamingCompleted) {
			this.setFinalizedTitle(this.lastExtractedTitle ?? this.currentTitle);
		}
	}

	private shouldAllowExpansion(): boolean {
		// Multiple tool invocations or lazy items mean there's content to show
		if (this.toolInvocationCount > 0 || this.lazyItems.length > 0) {
			return true;
		}

		// Count meaningful children in the wrapper (exclude the working spinner)
		if (this.wrapper) {
			const meaningfulChildren = Array.from(this.wrapper.children).filter(child => child !== this.workingSpinnerElement).length;
			if (meaningfulChildren > 1) {
				return true;
			}
		}

		const contentWithoutTitle = this.currentThinkingValue.trim();
		const titleToCompare = this.lastExtractedTitle ?? this.currentTitle;

		const stripMarkdown = (text: string) => {
			return text
				.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1').trim();
		};

		const strippedContent = stripMarkdown(contentWithoutTitle);
		// If content is empty or matches the title exactly, nothing to expand
		return !(!strippedContent || strippedContent === titleToCompare);
	}

	private updateDropdownClickability(knownContentHeight?: number): void {
		let allowExpansion = this.shouldAllowExpansion();

		// don't allow feedback on fixed scrolling before reaching max height.
		if (allowExpansion && this.fixedScrollingMode && !this.streamingCompleted && !this.element.isComplete && this.wrapper) {
			// Use only the cached height — never read scrollHeight here to avoid forced reflows.
			// If the cache is empty, conservatively disallow expansion; the ResizeObserver
			// will populate lastKnownContentHeight and trigger another call once layout settles.
			const contentHeight = knownContentHeight ?? this.lastKnownContentHeight;
			if (!contentHeight || contentHeight <= THINKING_SCROLL_MAX_HEIGHT) {
				allowExpansion = false;
			}
		}

		if (!allowExpansion && this.isExpanded() && (this.streamingCompleted || this.element.isComplete)) {
			this.setExpanded(false);
		}
		this.setDropdownClickable(allowExpansion);
	}

	private appendToWrapper(element: HTMLElement): void {
		if (!this.wrapper) {
			return;
		}
		if (this.workingSpinnerElement && this.workingSpinnerElement.parentNode === this.wrapper) {
			this.wrapper.insertBefore(element, this.workingSpinnerElement);
		} else {
			this.wrapper.appendChild(element);
		}
	}

	private updateWorkingSpinnerVisibility(reader?: IReader): void {
		if (!this.wrapper || !this.workingSpinnerElement) {
			return;
		}

		const hasRunningTerminalTool = this.toolInvocations.some(toolInvocation => {
			const terminalData = toolInvocation.toolSpecificData as IChatTerminalToolInvocationData | undefined;
			if (terminalData?.kind !== 'terminal' || terminalData.terminalCommandState?.exitCode !== undefined) {
				return false;
			}

			return !IChatToolInvocation.isComplete(toolInvocation, reader);
		});

		const isAttached = this.workingSpinnerElement.parentNode === this.wrapper;
		if (hasRunningTerminalTool && isAttached) {
			this.workingSpinnerElement.remove();
			this._onDidChangeHeight.fire();
		} else if (!hasRunningTerminalTool && !isAttached && !this.streamingCompleted && !this.element.isComplete) {
			this.wrapper.appendChild(this.workingSpinnerElement);
			this._onDidChangeHeight.fire();
		}
	}

	public resetId(): void {
		this.id = undefined;
	}

	public collapseContent(): void {
		this.setExpanded(false);
	}

	/**
	 * Collapses the part with a smooth height/opacity transition. Used by
	 * {@link ThinkingDisplayMode.StreamThenCollapse} when a live stream completes.
	 * Falls back to an instant collapse when the part was not streamed live in
	 * this render (e.g. history re-renders), when reduced motion is preferred,
	 * or when there is nothing to animate.
	 */
	public collapseContentAnimated(): void {
		if (this._store.isDisposed || this._collapseAnimation.value) {
			return;
		}
		if (!this.isExpanded()) {
			return;
		}
		const wrapper = this.wrapper;
		if (!wrapper || !this.wasStreamingLive || this.accessibilityService.isMotionReduced()) {
			this.setExpanded(false);
			return;
		}
		const startHeight = wrapper.scrollHeight;
		if (startHeight <= 0) {
			this.setExpanded(false);
			return;
		}

		const store = new DisposableStore();
		this._collapseAnimation.value = store;

		const finish = () => {
			if (!this._collapseAnimation.value) {
				return;
			}
			this._collapseAnimation.clear(); // store cleanup resets styles and removes the class
			this.setExpanded(false);
			this._onDidChangeHeight.fire();
		};

		// Freeze the current height, then transition to 0 via the
		// `chat-thinking-collapsing` class (see chatThinkingContent.css).
		wrapper.style.maxHeight = `${startHeight}px`;
		wrapper.getBoundingClientRect(); // force layout so the transition starts from the frozen height
		this.domNode.classList.add('chat-thinking-collapsing');
		wrapper.style.maxHeight = '0px';
		wrapper.style.opacity = '0';

		store.add(addDisposableListener(wrapper, 'transitionend', e => {
			if (e.target === wrapper && e.propertyName === 'max-height') {
				finish();
			}
		}));
		// Fallback in case the transition never fires (e.g. detached node).
		disposableTimeout(finish, 400, store);
		store.add(toDisposable(() => {
			wrapper.style.maxHeight = '';
			wrapper.style.opacity = '';
			this.domNode.classList.remove('chat-thinking-collapsing');
			this.domNode.classList.add('chat-thinking-just-collapsed');
		}));
	}

	/** Elapsed time to display: frozen at completion, live otherwise. */
	private getElapsedMs(): number {
		return this.elapsedAtCompletionMs ?? (Date.now() - this.startTimeMs);
	}

	/**
	 * Mounts one disclosure immediately before each reasoning block. Reasoning can
	 * resume after a diff or tool call, so a single label pinned to the top of the
	 * wrapper loses the model's actual think → act → think chronology.
	 */
	private ensureCursorReasoningLabel(textContainer = this.textContainer): HTMLElement | undefined {
		if (!this.useCursorTranscriptPresentation || !this.wrapper || !textContainer) {
			return undefined;
		}
		const existing = this.cursorReasoningDisclosures.get(textContainer);
		if (existing) {
			if (textContainer.parentElement === this.wrapper && existing.label.nextElementSibling !== textContainer) {
				this.wrapper.insertBefore(existing.label, textContainer);
			}
			return existing.label;
		}

		const label = $('button.chat-thinking-cursor-reasoning-label', {
			type: 'button',
			role: 'button',
			'aria-expanded': 'true',
		});
		const labelText = $('span.chat-thinking-cursor-reasoning-label-text');
		const chevron = $('span.codicon.codicon-chevron-down.chat-thinking-cursor-reasoning-chevron', { 'aria-hidden': 'true' });
		label.append(labelText, chevron);
		const disclosure = { label, labelText, chevron, expanded: true };
		this.cursorReasoningDisclosures.set(textContainer, disclosure);
		if (textContainer.parentElement === this.wrapper) {
			this.wrapper.insertBefore(label, textContainer);
		}
		this._register(addDisposableListener(label, 'click', () => {
			this.setCursorReasoningExpanded(textContainer, !disclosure.expanded);
		}));
		this.setCursorReasoningExpanded(textContainer, true, false);
		this.updateCursorReasoningLabel();
		return label;
	}

	private appendCursorReasoningContainer(textContainer: HTMLElement, showDisclosure = true): void {
		if (this.useCursorTranscriptPresentation && showDisclosure) {
			const label = this.ensureCursorReasoningLabel(textContainer);
			if (label) {
				this.appendToWrapper(label);
			}
		}
		this.appendToWrapper(textContainer);
	}

	private setCursorReasoningExpanded(textContainer: HTMLElement, expanded: boolean, fireHeightChange = true): void {
		const disclosure = this.cursorReasoningDisclosures.get(textContainer);
		if (!disclosure) {
			return;
		}
		disclosure.expanded = expanded;
		disclosure.label.ariaExpanded = String(expanded);
		disclosure.chevron.classList.toggle('codicon-chevron-down', expanded);
		disclosure.chevron.classList.toggle('codicon-chevron-right', !expanded);
		textContainer.hidden = !expanded;
		if (fireHeightChange) {
			this._onDidChangeHeight.fire();
		}
	}

	/** Keeps each reasoning section legible inside the outer turn-level work fold. */
	private updateCursorReasoningLabel(forceComplete = false): void {
		if (this.cursorReasoningDisclosures.size === 0) {
			return;
		}
		const complete = forceComplete || this.streamingCompleted || this.element.isComplete;
		const elapsedMs = this.elapsedAtCompletionMs ?? (this.wasStreamingLive ? Date.now() - this.startTimeMs : 0);
		const label = complete
			? elapsedMs < 1500
			? localize('chat.thinking.cursorReasoningBrief', "Thought briefly")
			: localize('chat.thinking.cursorReasoningElapsed', "Thought {0}", formatThinkingElapsed(elapsedMs))
			: localize('chat.thinking.cursorReasoningLive', "Thinking");
		for (const disclosure of this.cursorReasoningDisclosures.values()) {
			disclosure.label.classList.toggle('chat-thinking-cursor-reasoning-live', !complete);
			disclosure.labelText.textContent = label;
		}
	}

	/**
	 * Keeps a subtle "· 8s" indicator at the end of the header label while
	 * streaming. The label element is rewritten by title updates, so this
	 * re-appends the span whenever it got detached.
	 */
	private updateElapsedIndicator(): void {
		if (!this._collapseButton || this.streamingCompleted || !this.wasStreamingLive) {
			return;
		}
		if (!this.titleElapsedSpan) {
			this.titleElapsedSpan = $('span.chat-thinking-title-elapsed');
		}
		const labelElement = this._collapseButton.labelElement;
		if (this.titleElapsedSpan.parentElement !== labelElement) {
			labelElement.appendChild(this.titleElapsedSpan);
		}
		this.titleElapsedSpan.textContent = ` · ${formatThinkingElapsed(this.getElapsedMs())}`;
	}

	private removeElapsedIndicator(): void {
		this._elapsedTimer.clear();
		this.titleElapsedSpan?.remove();
		this.titleElapsedSpan = undefined;
	}

	/** Label of the most recent tool invocation that is still running, if any. */
	private getActiveToolLabel(): string | undefined {
		for (let i = this.toolInvocations.length - 1; i >= 0; i--) {
			const toolInvocation = this.toolInvocations[i];
			if (toolInvocation.kind === 'toolInvocation' && !IChatToolInvocation.isComplete(toolInvocation)) {
				const label = this.toolLabelsByCallId.get(toolInvocation.toolCallId);
				if (label) {
					return label;
				}
			}
		}
		return undefined;
	}

	/**
	 * Sets the working spinner label, preferring the running tool's own label
	 * ("Reading package.json") over a random phrase from the pool.
	 */
	private setWorkingSpinnerMessage(category: WorkingMessageCategory): void {
		if (!this.workingSpinnerLabel) {
			return;
		}
		this.setWorkingSpinnerBase(this.getActiveToolLabel() ?? this.getWorkingFallbackMessage(category));
	}

	/** Clean hosts keep the no-tool fallback explicit and stable. */
	private getWorkingFallbackMessage(category: WorkingMessageCategory): string {
		return this.useCursorPanelPresentation
			? localize('chat.thinking.reasoning', 'Reasoning')
			: this.getRandomWorkingMessage(category);
	}

	/** Records the current spinner phrase (or active-tool label) and repaints it with the live elapsed. */
	private setWorkingSpinnerBase(text: string): void {
		this.workingSpinnerBaseText = text;
		this.renderWorkingSpinnerLabel();
	}

	/**
	 * Paints the tail of the live reasoning stream into the spinner row and,
	 * while collapsed without an extracted title, into the header — so neither
	 * sits frozen on a canned phrase while reasoning streams. Runs on the 1s
	 * elapsed tick rather than per delta to keep DOM churn bounded.
	 */
	private applyLiveReasoningTail(): void {
		const tail = this.liveReasoningTail;
		if (!tail || this.streamingCompleted || this.element.isComplete) {
			return;
		}
		if (!this.useCursorPanelPresentation && !this.getActiveToolLabel()) {
			this.setWorkingSpinnerBase(middleTruncate(tail, 80));
		}
		if (!this.fixedScrollingMode && !this._isExpanded.get() && !this.lastExtractedTitle) {
			this.setTitle(middleTruncate(tail, 64));
		}
	}

	/**
	 * Repaints the working spinner as "<phrase> · <elapsed>" while the run is
	 * live, so the row always shows the ticking elapsed time — it never sits
	 * frozen on a static phrase when the model is reasoning silently with
	 * nothing to stream. The phrase (a running tool's label, e.g. "Reading
	 * package.json", or a category phrase) is preserved; only the trailing
	 * elapsed is refreshed on each 1s timer tick. Once complete, the suffix is
	 * dropped so finalized rows read cleanly.
	 */
	private renderWorkingSpinnerLabel(): void {
		if (!this.workingSpinnerLabel) {
			return;
		}
		const base = this.workingSpinnerBaseText ?? '';
		if (this.wasStreamingLive && !this.streamingCompleted && !this.element.isComplete) {
			const elapsed = formatThinkingElapsed(this.getElapsedMs());
			this.workingSpinnerLabel.textContent = base
				? localize('chat.thinking.spinnerElapsed', "{0} · {1}", base, elapsed)
				: elapsed;
		} else {
			this.workingSpinnerLabel.textContent = base;
		}
	}

	// --- Codex-style activity groups -------------------------------------------------

	/**
	 * Gives Backboard's clean transcript the same compact anatomy as a T3 work
	 * row. The native VS Code tool part remains mounted for its output and
	 * lifecycle, but it is revealed only when this individual row is opened.
	 */
	private prepareWorkRow(
		itemWrapper: HTMLElement,
		toolCallId: string | undefined,
		fallbackLabel: string | undefined,
		metadata: ChatThinkingItemMetadata | undefined,
		subkind: ToolActivitySubkind,
	): void {
		const nativeContent = itemWrapper.lastElementChild as HTMLElement | null;
		if (!nativeContent) {
			return;
		}

			const nativeText = nativeContent.textContent?.trim();
			const presentation = t3WorkEntryPresentation(metadata, toolCallId, fallbackLabel, nativeText);
			const isPlanRow = presentation.kind === 'plan';
			itemWrapper.classList.toggle('chat-thinking-cursor-plan-row', isPlanRow);
		const invocation = metadata && (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized') ? metadata : undefined;
		const isLiveInvocation = metadata?.kind === 'toolInvocation' && !IChatToolInvocation.isComplete(metadata);
		const isSyntheticLiveEntry = !metadata && !this.element.isComplete;
		const isPendingCursorEdit = this.useCursorTranscriptPresentation
			&& subkind === 'edit'
			&& (isLiveInvocation || isSyntheticLiveEntry);
		itemWrapper.classList.toggle('chat-thinking-cursor-edit-pending', isPendingCursorEdit);
		const passiveSemanticText = [
			toolCallId,
			invocation?.toolId,
			textFromMarkdown(invocation?.invocationMessage),
			textFromMarkdown(invocation?.pastTenseMessage),
		].filter(Boolean).join(' ').toLocaleLowerCase();
		const isPassiveCursorRow = this.useCursorTranscriptPresentation
			&& !presentation.failed
			&& (subkind === 'read' || subkind === 'search' || passiveSemanticText.includes('skill'));
		const summary = $('.chat-thinking-work-row-summary');
		itemWrapper.querySelector<HTMLElement>(':scope > .chat-thinking-icon')?.remove();
		const icon = $('span.chat-thinking-work-row-icon');
		icon.appendChild(createT3WorkEntryIcon(itemWrapper.ownerDocument, presentation.icon));
		summary.appendChild(icon);
		const label = $('.chat-thinking-work-row-label');
		const heading = $('span.chat-thinking-work-row-heading');
		heading.textContent = presentation.heading;
		label.appendChild(heading);
		if (presentation.preview) {
			const preview = $('span.chat-thinking-work-row-preview');
			preview.textContent = presentation.preview;
			label.appendChild(preview);
		}
		nativeContent.classList.add('chat-thinking-work-native-content');

			let details: HTMLElement | undefined;
			const preferNativeDisclosure = subkind === 'terminal' && nativeContent.childElementCount > 0;
			if (presentation.planItems?.length) {
				details = $('.chat-thinking-work-row-details.chat-thinking-plan-details');
				const list = $('ul.chat-thinking-plan-list');
				for (const item of presentation.planItems) {
					const row = $(`li.chat-thinking-plan-item.chat-thinking-plan-item-${item.status}`);
					const marker = $('span.chat-thinking-plan-item-marker', { 'aria-hidden': 'true' });
					marker.textContent = item.status === 'completed' ? '✓' : item.status === 'in-progress' ? '→' : '○';
					const title = $('span.chat-thinking-plan-item-title');
					title.textContent = item.title;
					row.append(marker, title);
					list.appendChild(row);
				}
				details.appendChild(list);
			} else if (presentation.details && !isPassiveCursorRow && !preferNativeDisclosure && !isPendingCursorEdit) {
				details = $('.chat-thinking-work-row-details');
				const pre = $('pre.chat-thinking-work-row-details-content');
				pre.textContent = presentation.details;
				details.appendChild(pre);
			}
		// Some restored/provider-native tool parts do not expose enough metadata
		// to synthesize a details block. Keep their real subtree available as the
		// disclosure body instead of leaving a row that can never be inspected.
			const hasNativeDisclosure = this.useCursorTranscriptPresentation && !isPlanRow && !isPassiveCursorRow && !isPendingCursorEdit && !details && nativeContent.childElementCount > 0;
		const hasDisclosure = !!details || hasNativeDisclosure;
		const disclosure = $('span.chat-thinking-work-row-disclosure', { 'aria-hidden': 'true' });
		if (hasDisclosure) {
			disclosure.appendChild(createT3WorkEntryIcon(itemWrapper.ownerDocument, 'chevron'));
		}
			const status = $('span.chat-thinking-work-row-status', { 'aria-hidden': 'true' });
			summary.append(label, disclosure, status);
			if (isPlanRow) {
				summary.title = localize('chat.thinking.taskProgressDescription', "Tracks the steps the agent is working through. It does not run commands.");
			}
		itemWrapper.insertBefore(summary, nativeContent);
		if (details) {
			itemWrapper.insertBefore(details, nativeContent);
		}
		itemWrapper.ariaLabel = presentation.preview ? `${presentation.heading} - ${presentation.preview}` : presentation.heading;
		this.setWorkRowStatusElement(status, presentation.failed ? 'cancelled' : (isLiveInvocation || isSyntheticLiveEntry) ? 'working' : 'complete');

		if (!hasDisclosure) {
			return;
		}

		itemWrapper.classList.add('chat-thinking-work-row-expandable');
		itemWrapper.classList.toggle('chat-thinking-work-row-native-expandable', hasNativeDisclosure);
		itemWrapper.tabIndex = 0;
		itemWrapper.role = 'button';
		itemWrapper.ariaExpanded = 'false';
		const toggle = () => {
			const expanded = itemWrapper.classList.toggle('chat-thinking-work-row-expanded');
			itemWrapper.ariaExpanded = String(expanded);
			this._onDidChangeHeight.fire();
		};
		this._register(addDisposableListener(itemWrapper, 'click', event => {
			const target = event.target as HTMLElement | null;
			if (!target?.closest('.chat-thinking-work-native-content')) {
				toggle();
			}
		}));
		this._register(addDisposableListener(itemWrapper, 'keydown', event => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('.chat-thinking-work-native-content')) {
				return;
			}
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		}));
	}

	private setWorkRowStatusElement(statusElement: HTMLElement, status: 'working' | 'complete' | 'cancelled'): void {
		statusElement.className = 'chat-thinking-work-row-status';
		clearNode(statusElement);
		if (status === 'working') {
			statusElement.classList.add('chat-thinking-work-row-status-working');
		} else if (status === 'cancelled') {
			statusElement.classList.add('chat-thinking-work-row-status-cancelled');
			statusElement.appendChild(createT3WorkEntryIcon(statusElement.ownerDocument, 'x'));
		} else {
			statusElement.classList.add('chat-thinking-work-row-status-complete');
		}
	}

	private updateWorkRowStatus(toolCallId: string, status: 'working' | 'complete' | 'cancelled'): void {
		const wrapper = this.toolWrappersByCallId.get(toolCallId);
		const statusElement = wrapper?.querySelector<HTMLElement>('.chat-thinking-work-row-status');
		if (!statusElement) {
			return;
		}
		this.setWorkRowStatusElement(statusElement, status);
		if (this.useCursorTranscriptPresentation && wrapper?.classList.contains('chat-thinking-cursor-edit-row')) {
			wrapper.classList.toggle('chat-thinking-cursor-edit-pending', status === 'working');
		}
		if (status === 'cancelled' && this.useCursorTranscriptPresentation && wrapper) {
			wrapper.classList.add('chat-thinking-cursor-actionable-row');
			wrapper.querySelector<HTMLElement>(':scope > .chat-thinking-work-native-content')?.classList.remove('chat-thinking-work-native-content');
			wrapper.querySelector<HTMLElement>(':scope > .chat-thinking-work-row-summary')?.remove();
			wrapper.querySelector<HTMLElement>(':scope > .chat-thinking-work-row-details')?.remove();
			wrapper.classList.remove('chat-thinking-work-row-expandable', 'chat-thinking-work-row-expanded');
			wrapper.removeAttribute('role');
			wrapper.removeAttribute('aria-expanded');
			wrapper.tabIndex = -1;
		}
	}

	/**
	 * Routes a rendered tool row into the current activity group, starting a
	 * new group when the category changes. Disabled in fixed-scrolling mode,
	 * which has its own pinned-viewport presentation.
	 */
	private appendToActivityGroup(
		itemWrapper: HTMLElement,
		subkind: ToolActivitySubkind,
		toolCallId: string | undefined,
		fallbackLabel: string | undefined,
		metadata: ChatThinkingItemMetadata | undefined,
	): void {
		if (this.fixedScrollingMode) {
			this.appendToWrapper(itemWrapper);
			return;
		}
		const preserveNativeTool = this.useCursorTranscriptPresentation
			&& !!metadata
			&& (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized')
			&& ((metadata.kind === 'toolInvocation' && !!IChatToolInvocation.getConfirmationMessages(metadata)) || t3ToolInvocationFailed(metadata));
		const hasNativeTerminalContent = itemWrapper.getElementsByClassName('chat-terminal-thinking-collapsible').length > 0
			|| itemWrapper.getElementsByClassName('chat-terminal-content-part').length > 0;
		const preserveNativeTerminal = this.useCursorTranscriptPresentation
			&& (
				subkind === 'terminal'
				|| hasNativeTerminalContent
				|| (!!metadata
					&& (metadata.kind === 'toolInvocation' || metadata.kind === 'toolInvocationSerialized')
					&& metadata.toolSpecificData?.kind === 'terminal')
			);
		if (preserveNativeTool) {
			itemWrapper.classList.add('chat-thinking-cursor-actionable-row');
		}
		if (this.useCursorPanelPresentation && !preserveNativeTool && !preserveNativeTerminal) {
			this.prepareWorkRow(itemWrapper, toolCallId, fallbackLabel, metadata, subkind);
		}
		// A shell card already owns a complete disclosure hierarchy: one command
		// header and, when opened, its native command/output body. Grouping it
		// behind a second "Ran N commands" disclosure produces three competing
		// headers and obscures the actual shell action.
		if (preserveNativeTerminal) {
			// Restored provider calls can have opaque tool ids and no terminal
			// metadata even though their rendered subtree is the native terminal.
			// Normalize from the rendered semantic component before applying row
			// chrome so those calls cannot receive a second synthetic disclosure.
			itemWrapper.classList.remove(
				'chat-thinking-cursor-read-row',
				'chat-thinking-cursor-search-row',
				'chat-thinking-cursor-edit-row',
				'chat-thinking-cursor-other-row',
			);
			itemWrapper.classList.add('chat-thinking-cursor-terminal-row');
			this.finishActiveActivityGroup();
			this.appendToWrapper(itemWrapper);
			return;
		}
		const category = toolActivityCategoryOf(subkind);
		let group = this.activeActivityGroup;
		// T3 treats every uninterrupted run of work entries as one group,
		// regardless of whether the individual calls read, edit, search, or run a
		// command. A commentary/reasoning row ends the run. Keep the existing
		// category summaries for other VS Code chat surfaces, but use Cursor's
		// provider-neutral work-log grouping in Backboard's right transcript.
		if (!group || (!this.useCursorTranscriptPresentation && group.category !== category) || group.container.parentElement !== this.wrapper) {
			this.finishActiveActivityGroup();
			group = this.createActivityGroup(category);
			this.activeActivityGroup = group;
			this.activityGroups.push(group);
			this.appendToWrapper(group.container);
		}
		group.items.push({ toolCallId, subkind, fallbackLabel });
		group.body.appendChild(itemWrapper);
		if (this.useCursorTranscriptPresentation && group.items.length === 2) {
			// The header first becomes visible with the second row, so open it for
			// that initial reveal. After that, preserve the user's disclosure choice
			// while later streamed tool calls join the same group.
			group.expanded = true;
		}
		this.updateActivityGroupHeader(group);
	}

	private createActivityGroup(category: ToolActivityCategory): IToolActivityGroup {
		const container = this.useCursorTranscriptPresentation
			? $('.chat-thinking-group.chat-thinking-work-group.chat-thinking-work-summary-collapsed')
			: this.useCursorPanelPresentation
			? $('.chat-thinking-group.chat-thinking-work-group.chat-thinking-work-overflow-collapsed')
			: $('.chat-thinking-group.chat-thinking-group-live');
		if (this.useCursorTranscriptPresentation) {
			container.dataset.workCategory = category;
		}
		const header = $('.chat-thinking-group-header');
		header.tabIndex = 0;
		header.role = 'button';
		const iconElement = createThinkingIcon(toolActivityCategoryIcon(category));
		const headerLabel = $('span.chat-thinking-group-label');
		const chevron = this.useCursorTranscriptPresentation
			? $('span.codicon.codicon-chevron-down.chat-thinking-group-chevron.chat-thinking-group-chevron-cursor', { 'aria-hidden': 'true' })
			: this.useCursorPanelPresentation
			? $('span.chat-thinking-group-chevron.chat-thinking-group-chevron-t3', { 'aria-hidden': 'true' })
			: $('span.codicon.codicon-chevron-right.chat-thinking-group-chevron', { 'aria-hidden': 'true' });
		if (this.useCursorPanelPresentation) {
			if (this.useCursorTranscriptPresentation) {
				header.append(iconElement, headerLabel, chevron);
			} else {
				chevron.appendChild(createT3WorkEntryIcon(container.ownerDocument, 'chevron'));
				header.append(chevron, headerLabel);
			}
		} else {
			header.append(iconElement, headerLabel, chevron);
		}
		const body = $('.chat-thinking-group-body');
		if (this.useCursorTranscriptPresentation) {
			container.append(header, body);
		} else if (this.useCursorPanelPresentation) {
			// T3 places the overflow disclosure after the visible work row.
			container.append(body, header);
		} else {
			container.append(header, body);
		}

		const toggle = () => {
			if (this.useCursorTranscriptPresentation || this.useCursorPanelPresentation) {
				group.expanded = !group.expanded;
				this.updateActivityGroupHeader(group);
				this._onDidChangeHeight.fire();
				return;
			}
			const collapsed = container.classList.toggle('chat-thinking-group-collapsed');
			chevron.classList.toggle('codicon-chevron-right', collapsed);
			chevron.classList.toggle('codicon-chevron-down', !collapsed);
			header.ariaExpanded = String(!collapsed);
			this._onDidChangeHeight.fire();
		};
		this._register(addDisposableListener(header, 'click', toggle));
		this._register(addDisposableListener(header, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		}));

		const hover = new MutableDisposable<IDisposable>();
		this._register(hover);
		const group: IToolActivityGroup = { category, startedAt: Date.now(), container, header, iconElement, headerLabel, chevron, body, items: [], hover, expanded: false };
		this.updateActivityGroupHeader(group);
		return group;
	}

	/**
	 * Marks the active group as finished: reveals the summary header and
	 * collapses the raw rows behind it.
	 */
	private finishActiveActivityGroup(): void {
		const group = this.activeActivityGroup;
		this.activeActivityGroup = undefined;
		if (!group) {
			return;
		}
		if (group.items.length === 0 || group.body.childElementCount === 0) {
			this.removeActivityGroup(group);
			return;
		}
		this.updateActivityGroupHeader(group);
		if (this.useCursorTranscriptPresentation) {
			group.expanded = false;
			this.updateActivityGroupHeader(group);
		} else if (this.useCursorPanelPresentation) {
			group.expanded = false;
			group.container.classList.add('chat-thinking-work-overflow-collapsed');
			this.updateActivityGroupHeader(group);
		} else {
			group.container.classList.remove('chat-thinking-group-live');
			group.container.classList.add('chat-thinking-group-collapsed');
			group.chevron.classList.add('codicon-chevron-right');
			group.chevron.classList.remove('codicon-chevron-down');
			group.header.ariaExpanded = 'false';
		}
		this._onDidChangeHeight.fire();
	}

	/** Folds every activity group into its summary pill (run finished/cancelled). */
	private collapseAllActivityGroups(): void {
		this.finishActiveActivityGroup();
		for (const group of this.activityGroups) {
			if (this.useCursorTranscriptPresentation) {
				group.expanded = false;
				this.updateActivityGroupHeader(group);
			} else if (this.useCursorPanelPresentation) {
				group.expanded = false;
				group.container.classList.add('chat-thinking-work-overflow-collapsed');
				this.updateActivityGroupHeader(group);
			} else if (!group.container.classList.contains('chat-thinking-group-live')) {
				this.updateActivityGroupHeader(group);
			}
		}
	}

	private updateActivityGroupHeader(group: IToolActivityGroup): void {
		if (this.useCursorTranscriptPresentation) {
			const showSummary = group.items.length > 1;
			group.header.classList.toggle('hidden', !showSummary);
			group.header.style.display = showSummary ? '' : 'none';
			const expanded = !showSummary || group.expanded;
			group.container.classList.toggle('chat-thinking-work-summary-collapsed', !expanded);
			group.chevron.classList.toggle('chat-thinking-group-chevron-expanded', expanded);
			group.chevron.classList.toggle('codicon-chevron-right', !expanded);
			group.chevron.classList.toggle('codicon-chevron-down', expanded);
			const label = this.buildActivityGroupLabel(group);
			group.headerLabel.textContent = label;
			group.header.ariaExpanded = String(expanded);
			group.header.ariaLabel = label;
			return;
		}
		if (this.useCursorPanelPresentation) {
			const showSummary = group.items.length > 1;
			group.header.classList.toggle('hidden', !showSummary);
			group.header.style.display = showSummary ? '' : 'none';
			group.container.classList.toggle('chat-thinking-work-overflow-collapsed', !group.expanded);
			group.chevron.classList.toggle('chat-thinking-group-chevron-expanded', group.expanded);
			group.headerLabel.textContent = this.buildActivityGroupLabel(group);
			group.header.ariaExpanded = String(group.expanded);
			group.header.ariaLabel = group.headerLabel.textContent;
			return;
		}
		const label = this.buildActivityGroupLabel(group);
		const liveLabel = this.useCursorPanelPresentation && group === this.activeActivityGroup && group.container.classList.contains('chat-thinking-group-live')
			? localize('chat.thinking.group.liveElapsed', "{0} · {1}", label, formatThinkingElapsed(Date.now() - group.startedAt))
			: label;
		const truncated = middleTruncate(liveLabel);
		group.headerLabel.textContent = truncated;
		group.header.ariaLabel = liveLabel;
		if (truncated !== liveLabel) {
			group.hover.value = this.hoverService.setupDelayedHover(group.headerLabel, { content: liveLabel, style: HoverStyle.Pointer });
		} else {
			group.hover.clear();
		}
	}

	private buildActivityGroupLabel(group: IToolActivityGroup): string {
		if (group.items.length === 1) {
			const item = group.items[0];
			const itemLabel = (item.toolCallId ? this.toolLabelsByCallId.get(item.toolCallId) : undefined) ?? item.fallbackLabel;
			if (itemLabel) {
				return itemLabel;
			}
		}
		const total = group.items.length;
		if (this.useCursorPanelPresentation && !this.useCursorTranscriptPresentation) {
			const labels: string[] = [];
			const add = (label: string) => {
				if (!labels.includes(label)) {
					labels.push(label);
				}
			};
			for (const item of group.items) {
				switch (item.subkind) {
					case 'read': add(localize('chat.thinking.group.readFile', "read a file")); break;
					case 'search': add(localize('chat.thinking.group.searchedCode', "searched code")); break;
					case 'edit': add(localize('chat.thinking.group.editedFile', "edited a file")); break;
					case 'terminal': add(localize('chat.thinking.group.ranCommand', "ran a command")); break;
					case 'other': add(localize('chat.thinking.group.usedTool', "used a tool")); break;
				}
			}
			const summary = labels.join(', ');
			return summary ? summary.charAt(0).toLocaleUpperCase() + summary.slice(1) : localize('chat.thinking.group.worked', "Worked");
		}
		const reads = group.items.filter(item => item.subkind === 'read').length;
		const searches = group.items.filter(item => item.subkind === 'search').length;
		if (group.category === ToolActivityCategory.Explore || (this.useCursorTranscriptPresentation && reads + searches > 0)) {
			if (reads > 0 && searches > 0) {
				if (reads === 1 && searches === 1) {
					return localize('chat.thinking.group.explored.oneFileOneSearch', "Explored 1 file, 1 search");
				}
				if (reads === 1) {
					return localize('chat.thinking.group.explored.oneFile', "Explored 1 file, {0} searches", searches);
				}
				if (searches === 1) {
					return localize('chat.thinking.group.explored.oneSearch', "Explored {0} files, 1 search", reads);
				}
				return localize('chat.thinking.group.explored', "Explored {0} files, {1} searches", reads, searches);
			}
			if (searches > 0) {
				return searches === 1
					? localize('chat.thinking.group.searched.one', "Explored 1 search")
					: localize('chat.thinking.group.searched', "Explored {0} searches", searches);
			}
			return reads === 1
				? localize('chat.thinking.group.read.one', "Explored 1 file")
				: localize('chat.thinking.group.read', "Explored {0} files", reads);
		}
		switch (group.category) {
			case ToolActivityCategory.Edit:
				return total === 1
					? localize('chat.thinking.group.edited.one', "Edited a file")
					: localize('chat.thinking.group.edited', "Edited {0} files", total);
			case ToolActivityCategory.Terminal:
				return total === 1
					? localize('chat.thinking.group.ran.one', "Ran a command")
					: localize('chat.thinking.group.ran', "Ran {0} commands", total);
			default:
				return total === 1
					? localize('chat.thinking.group.tool.one', "Ran a tool")
					: localize('chat.thinking.group.tool', "Ran {0} tools", total);
		}
	}

	/** Refreshes the group header that owns the given tool (labels stream in late). */
	private refreshActivityGroupForTool(toolCallId: string): void {
		const label = this.toolLabelsByCallId.get(toolCallId);
		const wrapper = this.toolWrappersByCallId.get(toolCallId);
		const invocation = this.toolInvocations.find(candidate => candidate.toolCallId === toolCallId);
		if (wrapper && invocation) {
			const nativeContent = wrapper.querySelector<HTMLElement>(':scope > .chat-thinking-work-native-content');
			const presentation = t3WorkEntryPresentation(invocation, toolCallId, label, nativeContent?.textContent?.trim());
			const rowHeading = wrapper.querySelector<HTMLElement>('.chat-thinking-work-row-heading');
			const rowLabel = wrapper.querySelector<HTMLElement>('.chat-thinking-work-row-label');
			const rowIcon = wrapper.querySelector<HTMLElement>('.chat-thinking-work-row-icon');
			if (rowHeading) {
				rowHeading.textContent = presentation.heading;
			}
			if (rowLabel) {
				let preview = rowLabel.querySelector<HTMLElement>(':scope > .chat-thinking-work-row-preview');
				if (presentation.preview) {
					preview ??= rowLabel.appendChild($('span.chat-thinking-work-row-preview'));
					preview.textContent = presentation.preview;
				} else {
					preview?.remove();
				}
			}
			if (rowIcon) {
				clearNode(rowIcon);
				rowIcon.appendChild(createT3WorkEntryIcon(wrapper.ownerDocument, presentation.icon));
			}
			const details = wrapper.querySelector<HTMLElement>('.chat-thinking-work-row-details-content');
			if (details && presentation.details) {
				details.textContent = presentation.details;
			}
			wrapper.ariaLabel = presentation.preview
				? `${presentation.heading} - ${presentation.preview}`
				: presentation.heading;
			if (presentation.failed) {
				const status = wrapper.querySelector<HTMLElement>('.chat-thinking-work-row-status');
				if (status) {
					this.setWorkRowStatusElement(status, 'cancelled');
				}
			}
		}
		for (const group of this.activityGroups) {
			if (group.items.some(item => item.toolCallId === toolCallId)) {
				this.updateActivityGroupHeader(group);
				return;
			}
		}
	}

	/** Drops a removed tool from its group, pruning the group when it empties. */
	private removeFromActivityGroups(toolCallId: string): void {
		for (const group of this.activityGroups) {
			const index = group.items.findIndex(item => item.toolCallId === toolCallId);
			if (index === -1) {
				continue;
			}
			group.items.splice(index, 1);
			if (group.items.length === 0 || group.body.childElementCount === 0) {
				this.removeActivityGroup(group);
			} else {
				this.updateActivityGroupHeader(group);
			}
			return;
		}
	}

	private removeActivityGroup(group: IToolActivityGroup): void {
		group.hover.clear();
		group.container.remove();
		const index = this.activityGroups.indexOf(group);
		if (index !== -1) {
			this.activityGroups.splice(index, 1);
		}
		if (this.activeActivityGroup === group) {
			this.activeActivityGroup = undefined;
		}
	}

	public updateThinking(content: IChatThinkingPart): void {
		// If disposed, ignore late updates coming from renderer diffing
		if (this._store.isDisposed) {
			return;
		}
		this.content = content;

		// Update any pending lazy thinking item with matching ID so that
		// when materialized, it will have the latest streaming content
		for (const lazyItem of this.lazyItems) {
			if (lazyItem.kind === 'thinking' && lazyItem.content.id === content.id) {
				lazyItem.content = content;
				break;
			}
		}

		const raw = extractTextFromPart(content);
		const next = raw;
		if (next === this.currentThinkingValue) {
			return;
		}
		const previousValue = this.currentThinkingValue;
		const reuseExisting = !!(this._markdownResult.value && next.startsWith(previousValue) && next.length > previousValue.length);
		this.currentThinkingValue = next;
		this.renderMarkdown(next, reuseExisting);

		if (this.fixedScrollingMode && this.scrollableElement) {
			this.refreshContentHeight();
			this.updateScrollDimensionsFromCache();
		}

		if (this.wasStreamingLive && !this.streamingCompleted) {
			this.liveReasoningTail = lastNonEmptyThinkingLine(raw);
		}

		const extractedTitle = extractTitleFromThinkingContent(raw);
		if (extractedTitle && extractedTitle !== this.currentTitle) {
			if (!this.extractedTitles.includes(extractedTitle)) {
				this.extractedTitles.push(extractedTitle);
			}
			this.lastExtractedTitle = extractedTitle;
		}

		if (!extractedTitle || extractedTitle === this.currentTitle) {
			return;
		}

		const label = this.lastExtractedTitle ?? '';
		if (!this.fixedScrollingMode && (!this._isExpanded.get() || this.streamThenCollapseMode)) {
			this.setTitle(label);
		}

		this.updateDropdownClickability();
	}

	public getIsActive(): boolean {
		return this.isActive;
	}

	public get isFixedScrollingMode(): boolean {
		return this.fixedScrollingMode;
	}

	/**
	 * Returns true when this thinking part has no meaningful content to display:
	 * no tool invocations, no lazy items, no hooks, and no thinking text.
	 * This happens when a tool is removed from thinking (e.g. due to confirmation)
	 * and the thinking part was only created to hold that tool.
	 */
	public isEffectivelyEmpty(): boolean {
		this.processPendingRemovals();
		if (this.toolInvocationCount > 0 || this.lazyItems.length > 0 || this.hookCount > 0) {
			return false;
		}
		if (this.currentThinkingValue.trim().length > 0) {
			return false;
		}
		return true;
	}

	public markAsInactive(): void {
		this.isActive = false;
		this.elapsedAtCompletionMs ??= Date.now() - this.startTimeMs;
		this.updateCursorReasoningLabel(true);
		this.domNode.classList.remove('chat-thinking-active');
		this.domNode.classList.remove('chat-thinking-fade-top', 'chat-thinking-fade-bottom');
		this.processPendingRemovals();
		this.collapseAllActivityGroups();
		this.removeElapsedIndicator();
		if (this.workingSpinnerElement) {
			this.workingSpinnerElement.remove();
			this.workingSpinnerElement = undefined;
			this.workingSpinnerLabel = undefined;
		}

		// Clear the attached-to-thinking flag on all tool invocations
		for (const toolInvocation of this.toolInvocations) {
			toolInvocation.isAttachedToThinking = false;
		}
	}

	public finalizeTitleIfDefault(): void {
		this.processPendingRemovals();

		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			this.wrapper.classList.remove('chat-thinking-streaming');
		}
		this.domNode.classList.remove('chat-thinking-active');
		this.domNode.classList.remove('chat-thinking-persistent-streaming');
		this.domNode.classList.remove('chat-thinking-fade-top', 'chat-thinking-fade-bottom');
		this.streamingCompleted = true;
		this.elapsedAtCompletionMs ??= Date.now() - this.startTimeMs;
		this.updateCursorReasoningLabel(true);
		this.removeElapsedIndicator();
		this.collapseAllActivityGroups();

		// Now that streaming is complete, render any aggregated images that were
		// deferred while scrolling was pinned in fixed scrolling mode.
		this.flushPendingExternalResources();

		if (this.wrapperResizeObserverDisposable) {
			this.wrapperResizeObserverDisposable.dispose();
			this.wrapperResizeObserverDisposable = undefined;
		}

		if (this.workingSpinnerElement) {
			this.workingSpinnerElement.remove();
			this.workingSpinnerElement = undefined;
			this.workingSpinnerLabel = undefined;
		}

		if (this._collapseButton) {
			this._collapseButton.icon = this.isCanceledResponse() ? Codicon.circleSlash : Codicon.check;
		}

		// Update scroll dimensions now that streaming is complete
		// This removes unnecessary scrollbar when content fits
		this.updateScrollDimensionsForCompletion();

		this.updateDropdownClickability();

		if (this.content.generatedTitle) {
			this.currentTitle = this.content.generatedTitle;
			this.setGeneratedTitleOnAllParts(this.content.generatedTitle);
			this.setFinalizedTitle(this.content.generatedTitle);
			return;
		}

		// Reuse any existing generated title from tool invocations or thinking parts.
		const existingTitle = this.toolInvocations.find(t => t.generatedTitle)?.generatedTitle
			?? this.allThinkingParts.find(t => t.generatedTitle)?.generatedTitle;
		if (existingTitle) {
			this.currentTitle = existingTitle;
			this.content.generatedTitle = existingTitle;
			this.setGeneratedTitleOnAllParts(existingTitle);
			this.setFinalizedTitle(existingTitle);
			return;
		}

		// Cancelled runs get a static "Stopped after Ns" title — no LLM call.
		if (this.isCanceledResponse()) {
			const title = this.wasStreamingLive
				? localize('chat.thinking.stoppedAfter', "Stopped after {0}", formatThinkingElapsed(this.getElapsedMs()))
				: localize('chat.thinking.stopped', "Stopped");
			this.currentTitle = title;
			this.setFinalizedTitle(title);
			return;
		}

		// Only check the persisted cache when re-rendering
		// (all tool invocations are serialized), not during live streaming.
		const allSerialized = this.toolInvocations.length > 0
			&& this.toolInvocations.every(t => t.kind === 'toolInvocationSerialized');
		if (allSerialized) {
			// Fallback: check the persisted title cache using the last tool call (non-local sessions only)
			if (!LocalChatSessionUri.isLocalSession(this.element.sessionResource)) {
				const lastToolInvocation = this.toolInvocations[this.toolInvocations.length - 1];
				if (lastToolInvocation) {
					const cachedTitle = this.getCachedTitle(lastToolInvocation.toolCallId);
					if (cachedTitle) {
						this.currentTitle = cachedTitle;
						this.content.generatedTitle = cachedTitle;
						this.setGeneratedTitleOnAllParts(cachedTitle);
						this.setFinalizedTitle(cachedTitle);
						return;
					}
				}
			}
		}

		// case where we only have one item (tool or edit) in the thinking container and no thinking parts, we want to move it back to its original position
		if (this.toolInvocationCount === 1 && this.hookCount === 0 && this.currentThinkingValue.trim() === '') {
			// If singleItemInfo wasn't set (item was lazy/deferred), materialize it now
			if (!this.singleItemInfo) {
				const lazyItem = this.lazyItems.find(item => item.kind === 'tool' && item.originalParent);
				if (lazyItem && lazyItem.kind === 'tool') {
					const toolInvocation = lazyItem.toolInvocationOrMarkdown && (lazyItem.toolInvocationOrMarkdown.kind === 'toolInvocation' || lazyItem.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') ? lazyItem.toolInvocationOrMarkdown : undefined;
					const result = lazyItem.lazy.value;
					this.singleItemInfo = {
						element: result.domNode,
						originalParent: lazyItem.originalParent!,
						originalNextSibling: this.domNode,
						toolInvocation
					};
					if (result.disposable) {
						const toolCallId = toolInvocation?.toolCallId;
						if (toolCallId) {
							this.ownedToolParts.set(toolCallId, result.disposable);
						} else {
							this._register(result.disposable);
						}
					}
				}
			}
			// Only restore if the tool is complete so the progress spinner is resolved
			const toolIsComplete = !this.singleItemInfo?.toolInvocation || IChatToolInvocation.isComplete(this.singleItemInfo.toolInvocation);
			if (toolIsComplete && this.singleItemInfo && this.restoreSingleItemToOriginalPosition()) {
				return;
			}
		}

		// if exactly one actual extracted title and no tool invocations, use that as the final title.
		if (this.extractedTitles.length === 1 && this.toolInvocationCount === 0) {
			const title = this.extractedTitles[0];
			this.currentTitle = title;
			this.content.generatedTitle = title;
			this.setGeneratedTitleOnAllParts(title);
			this.setFinalizedTitle(title);
			return;
		}

		const generateTitles = this.configurationService.getValue<boolean>(ChatConfiguration.ThinkingGenerateTitles) ?? true;
		if (!generateTitles) {
			this.setFallbackTitle();
			return;
		}

		this.generateTitleViaLLM();
	}

	private setGeneratedTitleOnAllParts(title: string): void {
		for (const toolInvocation of this.toolInvocations) {
			toolInvocation.generatedTitle = title;
		}
		for (const thinkingPart of this.allThinkingParts) {
			thinkingPart.generatedTitle = title;
		}
	}

	private loadTitleCache(): Record<string, { title: string; storedAt: number }> {
		return this.storageService.getObject<Record<string, { title: string; storedAt: number }>>(TITLE_CACHE_STORAGE_KEY, StorageScope.PROFILE) ?? {};
	}

	private saveTitleCache(cache: Record<string, { title: string; storedAt: number }>): void {
		if (Object.keys(cache).length === 0) {
			this.storageService.remove(TITLE_CACHE_STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(TITLE_CACHE_STORAGE_KEY, JSON.stringify(cache), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	private getTitleCacheKey(toolCallId: string): string {
		return `${chatSessionResourceToId(this.element.sessionResource)}:${toolCallId}`;
	}

	private getCachedTitle(toolCallId: string): string | undefined {
		const entry = this.loadTitleCache()[this.getTitleCacheKey(toolCallId)];
		if (!entry || (Date.now() - entry.storedAt) > TITLE_CACHE_TTL_MS) {
			return undefined;
		}
		return entry.title;
	}

	private setCachedTitle(toolCallId: string, title: string): void {
		const cache = this.loadTitleCache();
		const now = Date.now();

		// Evict expired entries on write
		for (const key of Object.keys(cache)) {
			if ((now - cache[key].storedAt) > TITLE_CACHE_TTL_MS) {
				delete cache[key];
			}
		}

		cache[this.getTitleCacheKey(toolCallId)] = { title, storedAt: now };

		// Cap size by dropping oldest entries
		const keys = Object.keys(cache);
		if (keys.length > TITLE_CACHE_MAX_ENTRIES) {
			const sorted = keys.sort((a, b) => cache[a].storedAt - cache[b].storedAt);
			for (let i = 0; i < sorted.length - TITLE_CACHE_MAX_ENTRIES; i++) {
				delete cache[sorted[i]];
			}
		}

		this.saveTitleCache(cache);
	}

	private async generateTitleViaLLM(): Promise<void> {
		const cts = new CancellationTokenSource();
		const timeout = setTimeout(() => cts.cancel(), 5000);

		try {
			const models = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', id: 'copilot-utility-small' });
			if (!models.length) {
				this.setFallbackTitle();
				return;
			}

			if (cts.token.isCancellationRequested) {
				this.setFallbackTitle();
				return;
			}

			let context: string;
			if (this.extractedTitles.length > 0) {
				context = this.extractedTitles.join(', ');
			} else {
				context = this.currentThinkingValue.substring(0, 1000);
			}

			const prompt = `Summarize the following content in a SINGLE sentence (under 10 words) using past tense. Follow these rules strictly:

			OUTPUT FORMAT:
			- MUST be a single sentence
			- MUST be under 10 words
			- The FIRST word MUST be a past tense verb (e.g. "Updated", "Reviewed", "Created", "Searched", "Analyzed")
			- No quotes, no trailing punctuation

			GENERAL:
			- The content may include tool invocations (file edits, reads, searches, terminal commands), reasoning headers, or raw thinking text
			- For reasoning headers or thinking text (no tool calls), summarize WHAT was considered/analyzed, NOT that thinking occurred
			- For thinking-only summaries, use phrases like: "Considered...", "Planned...", "Analyzed...", "Reviewed..."

			TOOL NAME FILTERING:
			- NEVER include tool names like "Replace String in File", "Multi Replace String in File", "Create File", "Read File", etc. in the output
			- If an action says "Edited X and used Replace String in File", output ONLY the action on X
			- Tool names describe HOW something was done, not WHAT was done - always omit them

			VOCABULARY - Use varied synonyms for natural-sounding summaries:
			- For edits: "Updated", "Modified", "Changed", "Refactored", "Fixed", "Adjusted"
			- For reads: "Reviewed", "Examined", "Checked", "Inspected", "Analyzed", "Explored"
			- For creates: "Created", "Added", "Generated"
			- For searches: "Searched for", "Looked up", "Investigated"
			- For terminal: "Ran command", "Executed"
			- For reasoning/thinking: "Considered", "Planned", "Analyzed", "Reviewed", "Evaluated"
			- Choose the synonym that best fits the context

${this.hookCount > 0 ? `BLOCKED/DENIED CONTENT (hooks detected):
			- Only mention "blocked" if the content explicitly includes hook results that blocked or warned about a tool (e.g. "Blocked terminal" or "Warning for read_file")
			- If blocked items are present alongside normal tool calls, briefly note the block but do NOT let it dominate the summary: e.g. "Updated file.ts, blocked terminal"

			` : `IMPORTANT: Do NOT use words like "blocked", "denied", or "tried" in the summary - there are no hooks or blocked items in this content. Just summarize normally.

			`}RULES FOR TOOL CALLS:
			1. If the SAME file was both edited AND read: Use a combined phrase like "Reviewed and updated <filename>"
			2. If exactly ONE file was edited: Start with an edit synonym + "<filename>" (include actual filename)
			3. If exactly ONE file was read: Start with a read synonym + "<filename>" (include actual filename)
			4. If MULTIPLE files were edited: Start with an edit synonym + "X files"
			5. If MULTIPLE files were read: Start with a read synonym + "X files"
			6. If BOTH edits AND reads occurred on DIFFERENT files: Combine them naturally
			7. For searches: Say "searched for <term>" or "looked up <term>" with the actual search term, NOT "searched for files"
			8. After the file info, you may add a brief summary of other actions if space permits
			9. NEVER say "1 file" - always use the actual filename when there's only one file

			RULES FOR REASONING HEADERS (no tool calls):
			1. If the input contains reasoning/analysis headers without actual tool invocations, summarize the main topic and what was considered
			2. Use past tense verbs that indicate thinking, not doing: "Considered", "Planned", "Analyzed", "Evaluated"
			3. Focus on WHAT was being thought about, not that thinking occurred

			RULES FOR RAW THINKING TEXT:
			1. Extract the main topic or question being considered from the text
			2. Identify any specific files, functions, or concepts mentioned
			3. Summarize as "Analyzed <topic>" or "Considered <specific thing>"
			4. If discussing code structure: "Reviewed <component/architecture>"
			5. If discussing a problem: "Analyzed <problem description>"
			6. If discussing implementation: "Planned <feature/change>"

			EXAMPLES WITH TOOLS:
			- "Read HomePage.tsx, Edited HomePage.tsx" → "Reviewed and updated HomePage.tsx"
			- "Edited HomePage.tsx" → "Updated HomePage.tsx"
			- "Edited config.css and used Replace String in File" → "Modified config.css"
			- "Edited App.tsx, used Multi Replace String in File" → "Refactored App.tsx"
			- "Read config.json, Read package.json" → "Reviewed 2 files"
			- "Edited App.tsx, Read utils.ts" → "Updated App.tsx and checked utils.ts"
			- "Edited App.tsx, Read utils.ts, Read types.ts" → "Updated App.tsx and reviewed 2 files"
			- "Edited index.ts, Edited styles.css, Ran terminal command" → "Modified 2 files and ran command"
			- "Read README.md, Searched for AuthService" → "Checked README.md and searched for AuthService"
			- "Searched for login, Searched for authentication" → "Searched for login and authentication"
			- "Edited api.ts, Edited models.ts, Read schema.json" → "Updated 2 files and reviewed schema.json"
			- "Edited Button.tsx, Edited Button.css, Edited index.ts" → "Modified 3 files"
			- "Searched codebase for error handling" → "Looked up error handling"

${this.hookCount > 0 ? `EXAMPLES WITH BLOCKED CONTENT (from hooks):
			- "Blocked terminal, Edited config.ts" → "Edited config.ts, terminal was blocked"
			- "Blocked terminal, Blocked read_file" → "Two tools were blocked by hooks"
			- "Warning for read_file, Edited utils.ts" → "Edited utils.ts with a hook warning"

			` : ''}EXAMPLES WITH REASONING HEADERS (no tools):
			- "Analyzing component architecture" → "Considered component architecture"
			- "Planning refactor strategy" → "Planned refactor strategy"
			- "Reviewing error handling approach, Considering edge cases" → "Analyzed error handling approach"
			- "Understanding the codebase structure" → "Reviewed codebase structure"
			- "Thinking about implementation options" → "Considered implementation options"

			EXAMPLES WITH RAW THINKING TEXT:
			- "I need to understand how the authentication flow works in this app..." → "Analyzed authentication flow"
			- "Let me think about how to refactor this component to be more maintainable..." → "Planned component refactoring"
			- "The error seems to be coming from the database connection..." → "Investigated database connection issue"
			- "Looking at the UserService class, I see it handles..." → "Reviewed UserService implementation"

			Content: ${context}`;

			const response = await this.languageModelsService.sendChatRequest(
				models[0],
				undefined,
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt }] }],
				{},
				cts.token
			);

			let generatedTitle = '';
			for await (const part of response.stream) {
				if (cts.token.isCancellationRequested) {
					break;
				}
				if (Array.isArray(part)) {
					for (const p of part) {
						if (p.type === 'text') {
							generatedTitle += p.value;
						}
					}
				} else if (part.type === 'text') {
					generatedTitle += part.value;
				}
			}

			if (cts.token.isCancellationRequested) {
				this.setFallbackTitle();
				return;
			}

			await response.result;
			generatedTitle = generatedTitle.trim();

			if (generatedTitle.includes('can\'t assist with that')) {
				this.setFallbackTitle();
				return;
			}

			if (generatedTitle && !this._store.isDisposed) {
				this.currentTitle = generatedTitle;
				this.setFinalizedTitle(generatedTitle);
				this.content.generatedTitle = generatedTitle;
				this.setGeneratedTitleOnAllParts(generatedTitle);

				// Persist to storage for non-local sessions only
				if (!LocalChatSessionUri.isLocalSession(this.element.sessionResource)) {
					const lastTool = this.toolInvocations[this.toolInvocations.length - 1];
					if (lastTool) {
						this.setCachedTitle(lastTool.toolCallId, generatedTitle);
					}
				}

				return;
			}
		} catch (error) {
			// fall through to default title
		} finally {
			clearTimeout(timeout);
			cts.dispose();
		}

		this.setFallbackTitle();
	}

	private restoreSingleItemToOriginalPosition(): boolean {
		if (!this.singleItemInfo) {
			return false;
		}

		const { element, originalParent, originalNextSibling, toolInvocation } = this.singleItemInfo;

		// don't restore it to original position - it contains multiple rendered elements
		if (element.childElementCount > 1) {
			this.singleItemInfo = undefined;
			return false;
		}

		if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
			originalParent.insertBefore(element, originalNextSibling);
		} else {
			originalParent.appendChild(element);
		}

		if (toolInvocation) {
			toolInvocation.isAttachedToThinking = false;
		}

		hide(this.domNode);
		this.singleItemInfo = undefined;
		return true;
	}

	private updateAggregatedDiff(): void {
		let totalAdded = 0;
		let totalRemoved = 0;
		for (const stats of this.diffStatsByPartId.values()) {
			totalAdded += stats.added;
			totalRemoved += stats.removed;
		}
		this._aggregatedDiff = { added: totalAdded, removed: totalRemoved };

		// Re-render the finalized title if streaming is already complete,
		// since diff events from edit pills may arrive after the title was set.
		if (this.streamingCompleted || this.element.isComplete) {
			this.setFinalizedTitle(this.currentTitle);
		}
	}

	private setFallbackTitle(): void {
		this.elapsedAtCompletionMs ??= Date.now() - this.startTimeMs;

		// The step count is shown in the title meta ("· 12s · 6 steps"), so the
		// fallback label stays plain to avoid repeating it. "Worked" mirrors
		// T3 Code's turn fold ("Worked for 12s") with the duration in the meta.
		const finalLabel = localize('chat.thinking.finished', 'Worked');

		this.currentTitle = finalLabel;
		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			this.wrapper.classList.remove('chat-thinking-streaming');
		}
		this.domNode.classList.remove('chat-thinking-active');
		this.domNode.classList.remove('chat-thinking-persistent-streaming');
		this.streamingCompleted = true;
		this.elapsedAtCompletionMs ??= Date.now() - this.startTimeMs;
		this.updateCursorReasoningLabel(true);
		this.removeElapsedIndicator();
		this.collapseAllActivityGroups();

		// Render any aggregated images that were deferred during fixed scrolling streaming.
		this.flushPendingExternalResources();

		if (this._collapseButton) {
			this._collapseButton.icon = this.isCanceledResponse() ? Codicon.circleSlash : Codicon.check;
			this.setFinalizedTitle(finalLabel);
		}

		this.updateDropdownClickability();
	}

	/**
	 * Appends a tool invocation or content item to the thinking group.
	 * The factory is called lazily - only when the thinking section is expanded.
	 * If already expanded, the factory is called immediately.
	 *
	 * When the caller has already created the content part eagerly (for example, a
	 * pre-built `ChatMarkdownContentPart` wrapped in a factory), the caller MUST pass
	 * that part as `eagerDisposable` so it is registered on this thinking part
	 * immediately. Otherwise, if the thinking section is collapsed and the lazy item
	 * is never materialized (because the user never expands it), the eagerly-created
	 * part would leak: its disposable is only referenced from inside the factory's
	 * closure, which nothing ever calls.
	 */
	public appendItem(
		factory: () => { domNode: HTMLElement; disposable?: IDisposable },
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: ChatThinkingItemMetadata,
		originalParent?: HTMLElement,
		onDidChangeDiff?: Event<IEditSessionDiffStats>,
		eagerDisposable?: IDisposable,
	): void {
		this.processPendingRemovals();

		// Track tool invocation metadata immediately (for title generation)
		this.trackToolMetadata(toolInvocationId, toolInvocationOrMarkdown);
		this.updateWorkingSpinnerVisibility();
		this.appendedItemCount++;

		// Listen for diff changes from edit pills
		if (onDidChangeDiff && toolInvocationId) {
			this._register(onDidChangeDiff(stats => {
				this.diffStatsByPartId.set(toolInvocationId, stats);
				this.updateAggregatedDiff();
			}));
		}

		// Register any caller-owned disposable up-front so it is always cleaned up
		// with this thinking part, even if the lazy item is never materialized.
		if (eagerDisposable) {
			this._register(eagerDisposable);
		}

		// Prefer the running tool's own label; fall back to a themed random message.
		if (this.workingSpinnerLabel) {
			const isTerminalTool = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') && toolInvocationOrMarkdown.toolSpecificData?.kind === 'terminal';
			this.setWorkingSpinnerMessage(isTerminalTool ? WorkingMessageCategory.Terminal : WorkingMessageCategory.Tool);
		}

		// T3 renders work entries directly in the timeline instead of deferring
		// them behind VS Code's outer "Worked" disclosure. Keep the native tool
		// part mounted for lifecycle/output, but materialize it immediately in
		// Backboard's clean middle panel.
		const isCleanTimelineTool = this.useCursorPanelPresentation && toolInvocationOrMarkdown
			&& (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized');
		const isCursorTranscriptArtifact = this.useCursorTranscriptPresentation && toolInvocationOrMarkdown
			&& (toolInvocationOrMarkdown.kind === 'markdownContent' || toolInvocationOrMarkdown.kind === 'externalEdit' || toolInvocationOrMarkdown.kind === 'textEditGroup');
		if (this.isExpanded() || this.hasExpandedOnce || isCleanTimelineTool || isCursorTranscriptArtifact || (this.fixedScrollingMode && !this.streamingCompleted)) {
			const result = factory();
			this.appendItemToDOM(result.domNode, toolInvocationId, toolInvocationOrMarkdown, originalParent);
			if (result.disposable) {
				const toolCallId = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') ? toolInvocationOrMarkdown.toolCallId : undefined;
				if (toolCallId) {
					this.ownedToolParts.set(toolCallId, result.disposable);
				} else {
					this._register(result.disposable);
				}
			}
		} else {
			// Defer rendering until expanded
			const item: ILazyToolItem = {
				kind: 'tool',
				lazy: new Lazy(factory),
				toolInvocationId,
				toolInvocationOrMarkdown,
				originalParent,
				isHook: !toolInvocationOrMarkdown && !!toolInvocationId,
			};
			this.lazyItems.push(item);
		}

		this.updateDropdownClickability();
	}

	public removeMaterializedItem(toolCallId: string): void {
		this.toolDisposables.deleteAndDispose(toolCallId);
		this.ownedToolParts.delete(toolCallId);

		const wrapper = this.toolWrappersByCallId.get(toolCallId);
		if (wrapper) {
			this.toolWrappersByCallId.delete(toolCallId);
			this.toolIconsByCallId.delete(toolCallId);
		}
		this.removeFromActivityGroups(toolCallId);

		this.appendedItemCount = Math.max(0, this.appendedItemCount - 1);
		this.toolInvocationCount = Math.max(0, this.toolInvocationCount - 1);

		const toolInvocationsIndex = this.toolInvocations.findIndex(t =>
			(t.kind === 'toolInvocation' || t.kind === 'toolInvocationSerialized') && t.toolCallId === toolCallId
		);
		if (toolInvocationsIndex !== -1) {
			// Use the tracked displayed label (which may differ from invocationMessage
			// for streaming edit tools that show "Editing files")
			const label = this.toolLabelsByCallId.get(toolCallId);
			if (label) {
				const titleIndex = this.extractedTitles.indexOf(label);
				if (titleIndex !== -1) {
					this.extractedTitles.splice(titleIndex, 1);
				}
			}
			this.toolInvocations.splice(toolInvocationsIndex, 1);
		}
		this.toolLabelsByCallId.delete(toolCallId);

		this._pendingExternalResources.delete(toolCallId);
		this._externalResourceWidget.removeToolInvocation(toolCallId);

		this.updateWorkingSpinnerVisibility();
		this.updateDropdownClickability();
		this._onDidChangeHeight.fire();
	}

	/**
	 * Removes a markdown edit pill child by its part ID (codeblocksPartId).
	 */
	public removeEditPillByPartId(partId: string): void {
		let removed = false;

		const lazyIndex = this.lazyItems.findIndex(item => item.kind === 'tool' && item.toolInvocationId === partId);
		if (lazyIndex !== -1) {
			this.lazyItems.splice(lazyIndex, 1);
			removed = true;
		}

		if (this.diffStatsByPartId.delete(partId)) {
			this.updateAggregatedDiff();
			removed = true;
		}

		if (removed) {
			this.appendedItemCount = Math.max(0, this.appendedItemCount - 1);
			this.updateDropdownClickability();
			this._onDidChangeHeight.fire();
		}
	}

	/**
	 * removes/re-establishes a lazy item from the thinking container
	 * this is needed so we can check if there are confirmations still needed
	 */
	public removeLazyItem(toolInvocationId: string): boolean {
		const index = this.lazyItems.findIndex(item => item.kind === 'tool' && item.toolInvocationId === toolInvocationId);
		if (index === -1) {
			return false;
		}

		const removedItem = this.lazyItems[index];
		this.lazyItems.splice(index, 1);
		this.appendedItemCount--;
		if (removedItem.kind === 'tool' && removedItem.isHook) {
			this.hookCount = Math.max(0, this.hookCount - 1);
		} else {
			this.toolInvocationCount--;
		}

		// Clear the attached-to-thinking flag on the removed tool invocation
		if (removedItem.kind === 'tool' && removedItem.toolInvocationOrMarkdown && (removedItem.toolInvocationOrMarkdown.kind === 'toolInvocation' || removedItem.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized')) {
			removedItem.toolInvocationOrMarkdown.isAttachedToThinking = false;

			// Keep extractedTitles in sync when a lazy tool leaves the thinking container.
			// Use the tracked displayed label (which may differ from invocationMessage
			// for streaming edit tools that show "Editing files")
			const toolCallId = removedItem.toolInvocationOrMarkdown.toolCallId;
			this._pendingExternalResources.delete(toolCallId);
			this._externalResourceWidget.removeToolInvocation(toolCallId);
			const label = this.toolLabelsByCallId.get(toolCallId);
			if (label) {
				const titleIndex = this.extractedTitles.indexOf(label);
				if (titleIndex !== -1) {
					this.extractedTitles.splice(titleIndex, 1);
				}
			}
			this.toolLabelsByCallId.delete(toolCallId);
		}

		const toolInvocationsIndex = this.toolInvocations.findIndex(t =>
			(t.kind === 'toolInvocation' || t.kind === 'toolInvocationSerialized') && t.toolId === toolInvocationId
		);
		if (toolInvocationsIndex !== -1) {
			this.toolInvocations.splice(toolInvocationsIndex, 1);
		}

		this.updateDropdownClickability();
		this.updateWorkingSpinnerVisibility();
		return true;
	}

	private processPendingRemovals(): void {
		this.pendingRemovalFlushDisposable?.dispose();
		this.pendingRemovalFlushDisposable = undefined;

		if (this.pendingRemovals.length === 0) {
			return;
		}

		const pendingRemovals = this.pendingRemovals;
		this.pendingRemovals = [];

		for (const pending of pendingRemovals) {
			this.removeStreamingToolEntry(pending.toolCallId, pending.toolLabel);
		}
	}

	private schedulePendingRemovalsFlush(): void {
		if (this.pendingRemovalFlushDisposable) {
			return;
		}

		this.pendingRemovalFlushDisposable = scheduleAtNextAnimationFrame(getWindow(this.domNode), () => {
			this.pendingRemovalFlushDisposable = undefined;
			if (this._store.isDisposed) {
				return;
			}

			this.processPendingRemovals();
		});
	}

	// removes the tool entry that was previously streaming and now is not. removes item from dom and internal tracking.
	private removeStreamingToolEntry(toolCallId: string, toolLabel: string): void {
		this.toolDisposables.deleteAndDispose(toolCallId);
		this.ownedToolParts.get(toolCallId)?.dispose();
		this.ownedToolParts.delete(toolCallId);

		const wrapper = this.toolWrappersByCallId.get(toolCallId);
		if (wrapper) {
			wrapper.remove();
			this.toolWrappersByCallId.delete(toolCallId);
			this.toolIconsByCallId.delete(toolCallId);
		}
		this.removeFromActivityGroups(toolCallId);

		// make sure to remove any lazy item as well
		const lazyIndex = this.lazyItems.findIndex(item =>
			item.kind === 'tool' &&
			item.toolInvocationOrMarkdown &&
			(item.toolInvocationOrMarkdown.kind === 'toolInvocation' || item.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') &&
			item.toolInvocationOrMarkdown.toolCallId === toolCallId
		);
		if (lazyIndex !== -1) {
			const removedLazyItem = this.lazyItems[lazyIndex];
			if (removedLazyItem.kind === 'tool' && removedLazyItem.toolInvocationOrMarkdown && (removedLazyItem.toolInvocationOrMarkdown.kind === 'toolInvocation' || removedLazyItem.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized')) {
				removedLazyItem.toolInvocationOrMarkdown.isAttachedToThinking = false;
			}
			this.lazyItems.splice(lazyIndex, 1);
		}

		this.appendedItemCount = Math.max(0, this.appendedItemCount - 1);
		this.toolInvocationCount = Math.max(0, this.toolInvocationCount - 1);
		const toolInvocationsIndex = this.toolInvocations.findIndex(t =>
			(t.kind === 'toolInvocation' || t.kind === 'toolInvocationSerialized') && t.toolCallId === toolCallId
		);
		if (toolInvocationsIndex !== -1) {
			this.toolInvocations.splice(toolInvocationsIndex, 1);
		}

		const titleIndex = this.extractedTitles.indexOf(toolLabel);
		if (titleIndex !== -1) {
			this.extractedTitles.splice(titleIndex, 1);
		}
		this.toolLabelsByCallId.delete(toolCallId);
		this._pendingExternalResources.delete(toolCallId);
		this._externalResourceWidget.removeToolInvocation(toolCallId);
		this.updateWorkingSpinnerVisibility();
		this.updateDropdownClickability();
		this._onDidChangeHeight.fire();
	}

	private trackToolMetadata(
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: ChatThinkingItemMetadata
	): void {
		const isToolInvocation = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized');
		if (isToolInvocation && this.useCursorPanelPresentation) {
			// Some providers restore a complete tool record without the legacy
			// invocation id. T3 keys its row from the record itself, so make the
			// clean timeline visible before the VS-specific id guard below.
			this.domNode.classList.add('chat-thinking-has-work-items');
		}
		if (!toolInvocationId) {
			return;
		}

		// Track hooks separately: if toolInvocationOrMarkdown is undefined, it's a hook item
		const isHook = !toolInvocationOrMarkdown;
		if (isHook) {
			this.hookCount++;
		} else {
			this.toolInvocationCount++;
		}

		// Shift default title from 'Thinking' to 'Working' once we have tool calls
		if (this.toolInvocationCount === 1) {
			this.defaultTitle = this.workingTitle;
		}

		let toolCallLabel: string;

		if (isToolInvocation && toolInvocationOrMarkdown.invocationMessage) {
			const message = typeof toolInvocationOrMarkdown.invocationMessage === 'string' ? toolInvocationOrMarkdown.invocationMessage : toolInvocationOrMarkdown.invocationMessage.value;

			// For edit-type tools that are still streaming, use a friendlier label
			// instead of the generic tool display name (e.g. "Replace String in File")
			const isStreamingEditTool = toolInvocationOrMarkdown.kind === 'toolInvocation' && IChatToolInvocation.isStreaming(toolInvocationOrMarkdown) && isGenericEditToolId(toolInvocationOrMarkdown.toolId);
			if (isStreamingEditTool) {
				toolCallLabel = localize('chat.thinking.editingFiles', 'Editing files');
			} else {
				toolCallLabel = message;
			}

			this.toolInvocations.push(toolInvocationOrMarkdown);

			// Track the displayed label for consistent cleanup
			const toolCallId = toolInvocationOrMarkdown.toolCallId;
			this.toolLabelsByCallId.set(toolCallId, toolCallLabel);

			// Render external image pills for serialized (already-completed) tool invocations
			if (toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') {
				this.updateExternalResourceParts(toolInvocationOrMarkdown);

				// Queue hidden serialized tools for removal immediately.
				if (IChatToolInvocation.isEffectivelyHidden(toolInvocationOrMarkdown)) {
					this.pendingRemovals.push({ toolCallId: toolInvocationOrMarkdown.toolCallId, toolLabel: toolCallLabel });
					this.schedulePendingRemovalsFlush();
				}
			}

			// track state for live/still streaming tools, excluding serialized tools
			if (toolInvocationOrMarkdown.kind === 'toolInvocation') {
				let currentToolLabel = toolCallLabel;
				let isComplete = false;
				let isStreaming = IChatToolInvocation.isStreaming(toolInvocationOrMarkdown);

				const toolStore = new DisposableStore();
				this.toolDisposables.set(toolInvocationOrMarkdown.toolCallId, toolStore);

				const updateTitle = (updatedMessage: string) => {
					if (updatedMessage && updatedMessage !== currentToolLabel) {
						// replace old title if exists, otherwise add new
						const oldIndex = this.extractedTitles.indexOf(currentToolLabel);
						const updatedIndex = this.extractedTitles.indexOf(updatedMessage);

						if (oldIndex !== -1) {
							if (updatedIndex !== -1 && updatedIndex !== oldIndex) {
								this.extractedTitles.splice(oldIndex, 1);
							} else {
								this.extractedTitles[oldIndex] = updatedMessage;
							}
						} else if (updatedIndex === -1) {
							this.extractedTitles.push(updatedMessage);
						}
						currentToolLabel = updatedMessage;
						this.toolLabelsByCallId.set(toolCallId, updatedMessage);
						this.lastExtractedTitle = updatedMessage;

						// Keep the spinner row and any single-item group header in
						// sync with the tool's streaming label.
						if (this.workingSpinnerLabel) {
							const activeLabel = this.getActiveToolLabel();
							if (activeLabel) {
								this.setWorkingSpinnerBase(activeLabel);
							}
						}
						this.refreshActivityGroupForTool(toolCallId);

						// make sure not to set title if expanded (except in stream-then-collapse
						// mode, where the header keeps updating while streaming expanded)
						if (!this.fixedScrollingMode && (!this._isExpanded.read(undefined) || this.streamThenCollapseMode)) {
							this.setTitle(updatedMessage);
						}
					}
				};

				const autorunDisposable = autorun(reader => {
					if (isComplete) {
						return;
					}

					const currentState = toolInvocationOrMarkdown.state.read(reader);
					this.updateWorkingSpinnerVisibility(reader);

					// queue item to be removed if it was streaming and presentation is hidden
					if (isStreaming && currentState.type !== IChatToolInvocation.StateKind.Streaming) {
						isStreaming = false;

						// Update terminal tool icon based on sandbox wrapping state
						const termData = toolInvocationOrMarkdown.toolSpecificData as IChatTerminalToolInvocationData | undefined;
						if (termData?.kind === 'terminal') {
							const iconEl = this.toolIconsByCallId.get(toolCallId);
							if (iconEl) {
								const newIcon = termData.commandLine?.isSandboxWrapped ? Codicon.terminalSecure : Codicon.terminal;
								iconEl.className = 'chat-thinking-icon';
								iconEl.classList.add(...ThemeIcon.asClassNameArray(newIcon));
							}
						}

						if (toolInvocationOrMarkdown.presentation === 'hidden') {
							this.pendingRemovals.push({ toolCallId: toolInvocationOrMarkdown.toolCallId, toolLabel: currentToolLabel });
							this.schedulePendingRemovalsFlush();
							isComplete = true;
							return;
						}
					}

					if (currentState.type === IChatToolInvocation.StateKind.Completed ||
						currentState.type === IChatToolInvocation.StateKind.Cancelled) {
						this.refreshActivityGroupForTool(toolCallId);
						this.updateWorkRowStatus(toolCallId, t3ToolInvocationFailed(toolInvocationOrMarkdown) ? 'cancelled' : 'complete');
						// Remove tools that should be hidden now or after completion.
						if (toolInvocationOrMarkdown.presentation === 'hidden' || toolInvocationOrMarkdown.presentation === 'hiddenAfterComplete') {
							this.pendingRemovals.push({ toolCallId: toolInvocationOrMarkdown.toolCallId, toolLabel: currentToolLabel });
							this.schedulePendingRemovalsFlush();
						}

						// Render image pills outside the collapsible area for completed tools
						if (currentState.type === IChatToolInvocation.StateKind.Completed) {
							this.updateExternalResourceParts(toolInvocationOrMarkdown);
						}

						// A completed live group must stop advertising itself as active even
						// when the model emits no follow-up reasoning chunk. This is the gap
						// that previously left clean chat looking frozen after a file write.
						if (this.activeActivityGroup?.items.some(item => item.toolCallId === toolCallId)) {
							const groupStillRunning = this.activeActivityGroup.items.some(item => {
								const invocation = this.toolInvocations.find(candidate => candidate.toolCallId === item.toolCallId);
								return invocation?.kind === 'toolInvocation' && !IChatToolInvocation.isComplete(invocation, reader);
							});
							// Cursor keeps a completed exploration run open until a real
							// reasoning/edit/category boundary arrives. Sequential reads and
							// searches otherwise finalize one-by-one and can never form the
							// useful "Explored N files, M searches" summary.
							if (!groupStillRunning && !this.useCursorTranscriptPresentation) {
								this.finishActiveActivityGroup();
							}
						}
						this.setWorkingSpinnerMessage(WorkingMessageCategory.Thinking);

						isComplete = true;
						return;
					}

					// streaming
					if (currentState.type === IChatToolInvocation.StateKind.Streaming) {
						isStreaming = true;
						const streamingMessage = currentState.streamingMessage.read(reader);
						if (streamingMessage) {
							const updatedMessage = typeof streamingMessage === 'string' ? streamingMessage : streamingMessage.value;
							updateTitle(updatedMessage);
						}
						return;
					}

					// executing (something like `Replacing 67 lines.....`)
					if (currentState.type === IChatToolInvocation.StateKind.Executing) {
						const progressData = currentState.progress.read(reader);
						if (progressData.message) {
							const updatedMessage = typeof progressData.message === 'string' ? progressData.message : progressData.message.value;
							updateTitle(updatedMessage);
						} else {
							const invocationMsg = toolInvocationOrMarkdown.invocationMessage;
							if (invocationMsg) {
								const updatedMessage = typeof invocationMsg === 'string' ? invocationMsg : invocationMsg.value;
								updateTitle(updatedMessage);
							}
						}
						return;
					}

					// confirmations, failures, completed, other, etc
					const invocationMsg = toolInvocationOrMarkdown.invocationMessage;
					if (invocationMsg) {
						const updatedMessage = typeof invocationMsg === 'string' ? invocationMsg : invocationMsg.value;
						updateTitle(updatedMessage);
					}
				});
				toolStore.add(autorunDisposable);
			}
		} else if (toolInvocationOrMarkdown?.kind === 'markdownContent') {
			const codeblockInfo = extractCodeblockUrisFromText(toolInvocationOrMarkdown.content.value);
			if (codeblockInfo?.uri) {
				const filename = basename(codeblockInfo.uri);
				toolCallLabel = localize('chat.thinking.editedFile', 'Edited {0}', filename);
			} else {
				toolCallLabel = localize('chat.thinking.editingFile', 'Edited file');
			}
		} else if (toolInvocationOrMarkdown?.kind === 'externalEdit') {
			const filename = basename(toolInvocationOrMarkdown.uri);
			switch (toolInvocationOrMarkdown.editKind) {
				case 'create':
					toolCallLabel = localize('chat.thinking.createdFile', 'Created {0}', filename);
					break;
				case 'delete':
					toolCallLabel = localize('chat.thinking.deletedFile', 'Deleted {0}', filename);
					break;
				case 'rename':
					toolCallLabel = localize('chat.thinking.renamedFile', 'Renamed {0}', filename);
					break;
				case 'edit':
					toolCallLabel = localize('chat.thinking.editedFile', 'Edited {0}', filename);
					break;
			}
		} else {
			toolCallLabel = toolInvocationId;
		}

		// Add tool call to extracted titles for LLM title generation
		if (!this.extractedTitles.includes(toolCallLabel)) {
			this.extractedTitles.push(toolCallLabel);
		}

		this.lastExtractedTitle = toolCallLabel;

		if (!this.fixedScrollingMode && (!this._isExpanded.get() || this.streamThenCollapseMode)) {
			this.setTitle(toolCallLabel);
		}
	}

	private updateExternalResourceParts(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): void {
		// In fixed scrolling mode, defer rendering aggregated images at the bottom while
		// the response is still streaming. The images would otherwise overlap the pinned
		// scrolling viewport. They are flushed once streaming completes.
		if (this.fixedScrollingMode && !this.streamingCompleted && !this.element.isComplete) {
			this._pendingExternalResources.set(toolInvocation.toolCallId, toolInvocation);
			return;
		}

		const extractedImages = extractImagesFromToolInvocationOutputDetails(toolInvocation, this.element.sessionResource);
		if (extractedImages.length === 0) {
			return;
		}

		const parts: IChatCollapsibleIODataPart[] = extractedImages.map(image => ({
			kind: 'data',
			value: image.data.buffer,
			mimeType: image.mimeType,
			uri: image.uri,
		}));

		this._externalResourceWidget.setToolInvocationParts(toolInvocation.toolCallId, parts);
	}

	private flushPendingExternalResources(): void {
		if (this._pendingExternalResources.size === 0) {
			return;
		}
		const pending = Array.from(this._pendingExternalResources.values());
		this._pendingExternalResources.clear();
		for (const toolInvocation of pending) {
			this.updateExternalResourceParts(toolInvocation);
		}
	}

	private appendItemToDOM(
		content: HTMLElement,
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: ChatThinkingItemMetadata,
		originalParent?: HTMLElement
	): void {
		if (!content.hasChildNodes() || content.textContent?.trim() === '') {
			return;
		}

		// Save the first item info for potential restoration later
		if (this.toolInvocationCount === 1 && this.hookCount === 0 && originalParent) {
			const toolInvocation = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') ? toolInvocationOrMarkdown : undefined;
			this.singleItemInfo = {
				element: content,
				originalParent,
				originalNextSibling: this.domNode,
				toolInvocation
			};
		} else {
			this.singleItemInfo = undefined;
		}

		const itemWrapper = $('.chat-thinking-tool-wrapper');
		const isMarkdownEdit = toolInvocationOrMarkdown?.kind === 'markdownContent';
		const isExternalEdit = toolInvocationOrMarkdown?.kind === 'externalEdit';
		const isTextEdit = toolInvocationOrMarkdown?.kind === 'textEditGroup';
		const isTerminalTool = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') && toolInvocationOrMarkdown.toolSpecificData?.kind === 'terminal';
		const isSearchTool = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') && toolInvocationOrMarkdown.toolSpecificData?.kind === 'search';
		const toolInvocationIcon = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') ? toolInvocationOrMarkdown.icon : undefined;

		let icon: ThemeIcon;
		if (isMarkdownEdit || isExternalEdit || isTextEdit) {
			icon = Codicon.pencil;
		} else if (isSearchTool) {
			icon = Codicon.search;
		} else if (isTerminalTool) {
			const terminalData = (toolInvocationOrMarkdown as IChatToolInvocation | IChatToolInvocationSerialized).toolSpecificData as { kind: 'terminal'; terminalCommandState?: { exitCode?: number }; commandLine?: { isSandboxWrapped?: boolean } };
			const exitCode = terminalData?.terminalCommandState?.exitCode;
			const isSandboxWrapped = terminalData?.commandLine?.isSandboxWrapped;
			if (exitCode !== undefined && exitCode !== 0) {
				icon = Codicon.error;
			} else if (isSandboxWrapped) {
				icon = Codicon.terminalSecure;
			} else {
				icon = toolInvocationIcon ?? Codicon.terminal;
			}
		} else if (content.classList.contains('chat-hook-outcome-blocked')) {
			icon = Codicon.error;
		} else if (content.classList.contains('chat-hook-outcome-warning')) {
			icon = Codicon.warning;
		} else {
			icon = toolInvocationId ? getToolInvocationIcon(toolInvocationId, toolInvocationIcon) : Codicon.tools;
		}

		const iconElement = createThinkingIcon(icon);
		itemWrapper.appendChild(iconElement);
		itemWrapper.appendChild(content);

		const isToolInvocation = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized');
		if (isToolInvocation && toolInvocationOrMarkdown.toolCallId) {
			this.toolWrappersByCallId.set(toolInvocationOrMarkdown.toolCallId, itemWrapper);
			this.toolIconsByCallId.set(toolInvocationOrMarkdown.toolCallId, iconElement);
		}

		// Cursor keeps file diffs as full transcript cards and uses the native
		// terminal disclosure so live output and tool actions remain available.
		if (this.useCursorTranscriptPresentation && (isMarkdownEdit || isExternalEdit || isTextEdit)) {
			this.finishActiveActivityGroup();
			itemWrapper.classList.add('chat-thinking-cursor-edit-row');
			this.appendToWrapper(itemWrapper);
			return;
		}

		const isCleanSyntheticTool = this.useCursorPanelPresentation && !!toolInvocationId;
		if ((toolInvocationOrMarkdown || isCleanSyntheticTool) && (this.useCursorPanelPresentation || (!isMarkdownEdit && !isExternalEdit))) {
			const subkind = getToolActivitySubkind(toolInvocationId, toolInvocationOrMarkdown);
			if (this.useCursorTranscriptPresentation) {
				itemWrapper.classList.add(`chat-thinking-cursor-${subkind}-row`);
			}
			const toolCallId = isToolInvocation ? toolInvocationOrMarkdown.toolCallId : undefined;
			const fallbackLabel = toolCallId ? undefined : content.textContent?.trim() || undefined;
			this.appendToActivityGroup(itemWrapper, subkind, toolCallId, fallbackLabel, toolInvocationOrMarkdown);
			if (isToolInvocation && toolCallId && this.useCursorPanelPresentation) {
				const complete = toolInvocationOrMarkdown.kind === 'toolInvocationSerialized' || IChatToolInvocation.isComplete(toolInvocationOrMarkdown);
				this.updateWorkRowStatus(toolCallId, t3ToolInvocationFailed(toolInvocationOrMarkdown) ? 'cancelled' : complete ? 'complete' : 'working');
			}
		} else {
			this.finishActiveActivityGroup();
			this.appendToWrapper(itemWrapper);
		}

		if (this.fixedScrollingMode && this.scrollableElement) {
			// Observe the child wrapper for resizes (e.g. terminal expanding)
			if (this.childResizeObserver && !this.streamingCompleted) {
				const observeDisposable = this.childResizeObserver.observe(itemWrapper);
				const toolCallId = isToolInvocation ? toolInvocationOrMarkdown.toolCallId : undefined;
				if (toolCallId) {
					let store = this.toolDisposables.get(toolCallId);
					if (!store) {
						store = new DisposableStore();
						this.toolDisposables.set(toolCallId, store);
					}
					store.add(observeDisposable);
				} else {
					this._register(observeDisposable);
				}
			}

			// Coalesce reads of scrollHeight to avoid forced reflows when many items
			// are appended in the same tick (e.g. when restoring a session).
			this.scheduleAppendRefresh();
		}
	}

	private scheduleAppendRefresh(): void {
		if (this._pendingAppendRefresh.value) {
			return;
		}
		this._pendingAppendRefresh.value = scheduleAtNextAnimationFrame(getWindow(this.wrapper), () => {
			this._pendingAppendRefresh.clear();
			if (this._store.isDisposed) {
				return;
			}
			this.refreshContentHeight();
			this.updateScrollDimensionsFromCache();
		});
	}

	private materializeLazyItem(item: ILazyItem): void {
		if (item.kind === 'thinking') {
			// Materialize thinking container
			const hasReasoning = !!extractTextFromPart(item.content).trim();
			item.textContainer.hidden = this.useCursorTranscriptPresentation && !hasReasoning;
			this.appendCursorReasoningContainer(item.textContainer, hasReasoning);
			// Store reference to textContainer for updateThinking calls
			this.textContainer = item.textContainer;
			this.id = item.content.id;
			// Use item.content which is kept up-to-date during streaming via updateThinking
			this.updateThinking(item.content);
			return;
		}

		if (this.workingSpinnerLabel) {
			const isTerminalTool = item.toolInvocationOrMarkdown && (item.toolInvocationOrMarkdown.kind === 'toolInvocation' || item.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') && item.toolInvocationOrMarkdown.toolSpecificData?.kind === 'terminal';
			this.setWorkingSpinnerMessage(isTerminalTool ? WorkingMessageCategory.Terminal : WorkingMessageCategory.Tool);
		}

		// Handle tool items
		if (item.lazy.hasValue) {
			// Already evaluated — but may not have been placed in the DOM yet
			// (e.g. finalizeTitleIfDefault materialized it before the wrapper existed).
			const result = item.lazy.value;
			if (!result.domNode.parentElement) {
				this.appendItemToDOM(result.domNode, item.toolInvocationId, item.toolInvocationOrMarkdown, item.originalParent);
			}
			return;
		}

		const result = item.lazy.value;
		this.appendItemToDOM(result.domNode, item.toolInvocationId, item.toolInvocationOrMarkdown, item.originalParent);

		if (result.disposable) {
			const toolCallId = item.toolInvocationOrMarkdown && (item.toolInvocationOrMarkdown.kind === 'toolInvocation' || item.toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') ? item.toolInvocationOrMarkdown.toolCallId : undefined;
			if (toolCallId) {
				this.ownedToolParts.set(toolCallId, result.disposable);
			} else {
				this._register(result.disposable);
			}
		}
	}

	// makes a new text container. when we update, we now update this container.
	public setupThinkingContainer(content: IChatThinkingPart) {
		// Avoid creating new containers after disposal
		if (this._store.isDisposed) {
			return;
		}
		this.appendedItemCount++;
		this.allThinkingParts.push(content);
		// A new reasoning section breaks the current activity group so later
		// tools don't get appended above this text.
		this.finishActiveActivityGroup();
		this.textContainer = $('.chat-thinking-item.markdown-content');
		const hasReasoning = !!extractTextFromPart(content).trim();
		this.textContainer.hidden = this.useCursorTranscriptPresentation && !hasReasoning;
		// Observe the new textContainer for child resizes in fixed scrolling mode
		if (this.childResizeObserver && this.fixedScrollingMode && !this.streamingCompleted) {
			this._register(this.childResizeObserver.observe(this.textContainer));
		}
		// Reserve the response part's DOM position even before its first streamed
		// token. A tool can render in the same frame; mounting only on non-empty
		// text would otherwise put this earlier reasoning section below that tool.
		if (this.useCursorTranscriptPresentation && !hasReasoning) {
			this.appendCursorReasoningContainer(this.textContainer, false);
			this.content = content;
			this.id = content.id;
		}
		if (hasReasoning) {
			// Use lazy rendering when collapsed to preserve order with tool items
			if (this.useCursorTranscriptPresentation || this.isExpanded() || this.hasExpandedOnce || (this.fixedScrollingMode && !this.streamingCompleted)) {
				// Render immediately when expanded
				this.appendCursorReasoningContainer(this.textContainer);
				this.id = content.id;
				this.updateThinking(content);
			} else {
				// Update this.content and this.id so that subsequent updateThinking calls
				// or materializeLazyItem will use the correct content for this section
				this.content = content;
				this.id = content.id;
				// Defer rendering until expanded to preserve order
				const lazyThinking: ILazyThinkingItem = {
					kind: 'thinking',
					textContainer: this.textContainer,
					content
				};
				this.lazyItems.push(lazyThinking);
			}

			if (this.workingSpinnerLabel) {
				this.setWorkingSpinnerMessage(WorkingMessageCategory.Thinking);
			}
		}
		this.updateDropdownClickability();
	}

	protected override setTitle(title: string, omitPrefix?: boolean): void {
		if (!title || this.element.isComplete) {
			return;
		}

		if (omitPrefix) {
			if (this._collapseButton) {
				const labelElement = this._collapseButton.labelElement;
				labelElement.textContent = '';
				const plainSpan = $('span');
				plainSpan.textContent = title;
				labelElement.appendChild(plainSpan);
				this._collapseButton.element.ariaLabel = title;
			}
			this.titleShimmerSpan = undefined;
			this.titleDetailContainer = undefined;
			this._titleDetailRendered.clear();
			this._titleFileWidgetStore.clear();
			this.currentTitle = title;
			this.updateElapsedIndicator();
			return;
		}

		this.lastExtractedTitle = title;
		const thinkingLabel = localize('chat.thinking.label', "{0}: {1}", this.defaultTitle, title);
		this.currentTitle = thinkingLabel;

		if (!this._collapseButton) {
			return;
		}

		const labelElement = this._collapseButton.labelElement;

		// Ensure the persistent shimmer span exists
		if (!this.titleShimmerSpan || !this.titleShimmerSpan.parentElement) {
			labelElement.textContent = '';
			this.titleShimmerSpan = $('span.chat-thinking-title-shimmer');
			labelElement.appendChild(this.titleShimmerSpan);
		}
		this.titleShimmerSpan.textContent = localize('chat.thinking.shimmer', "{0}: ", this.defaultTitle);

		// Dispose previous detail rendering
		this._titleDetailRendered.clear();
		this._titleFileWidgetStore.clear();

		// Long details (e.g. full terminal commands) are middle-truncated so
		// the header stays a single readable line; CSS ellipsizes any rest.
		const result = this.chatContentMarkdownRenderer.render(new MarkdownString(middleTruncate(title, 96)));
		result.element.classList.add('collapsible-title-content', 'chat-thinking-title-detail');
		renderFileWidgets(result.element, this.instantiationService, this.chatMarkdownAnchorService, this._titleFileWidgetStore);
		this._titleDetailRendered.value = result;

		if (this.titleDetailContainer) {
			// Replace old detail in-place
			this.titleDetailContainer.replaceWith(result.element);
		} else {
			labelElement.appendChild(result.element);
		}
		this.titleDetailContainer = result.element;

		this._collapseButton.element.ariaLabel = thinkingLabel;
		this._collapseButton.element.ariaExpanded = String(this.isExpanded());

		// Title updates rebuild the label; keep the elapsed tick at the end.
		this.updateElapsedIndicator();
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {

		if (_element.isComplete) {
			return true;
		}

		if (other.kind === 'toolInvocation' || other.kind === 'toolInvocationSerialized' || other.kind === 'markdownContent' || other.kind === 'hook') {
			return true;
		}

		if (other.kind !== 'thinking') {
			return false;
		}

		return other?.id !== this.id;
	}

	override dispose(): void {
		this.isActive = false;
		if (this.workingSpinnerElement) {
			this.workingSpinnerElement.remove();
			this.workingSpinnerElement = undefined;
			this.workingSpinnerLabel = undefined;
		}
		this.pendingRemovalFlushDisposable?.dispose();
		this.pendingRemovalFlushDisposable = undefined;
		this.pendingScrollDisposable?.dispose();
		super.dispose();
	}
}
