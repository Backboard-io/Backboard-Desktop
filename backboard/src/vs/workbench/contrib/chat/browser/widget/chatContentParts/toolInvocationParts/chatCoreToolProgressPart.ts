/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { localize } from '../../../../../../../nls.js';
import { IChatCoreToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import '../media/chatCoreToolProgressPart.css';

const MAX_ITEMS = 50;
const MAX_PREVIEW_LENGTH = 32_000;
let coreToolCardIdPool = 0;

export interface ICoreToolCardMetric {
	readonly label: string;
	readonly value: string;
	readonly compactValue?: string;
	readonly isCount?: boolean;
}

export interface ICoreToolCardItem {
	readonly title: string;
	readonly detail?: string;
	readonly href?: string;
	readonly state?: 'pending' | 'active' | 'complete' | 'error' | 'skipped';
}

export interface ICoreToolCardPreview {
	readonly label: string;
	readonly text: string;
}

/**
 * Provider-neutral rendering model for Backboard's built-in tools. Keeping the
 * input normalization here pure makes malformed and restored payloads safe to
 * test without constructing the service-heavy chat renderer.
 */
export interface ICoreToolCardViewModel {
	readonly toolKind: IChatCoreToolInvocationData['toolKind'];
	readonly title: string;
	readonly summary?: string;
	readonly icon: ThemeIcon;
	readonly metrics?: readonly ICoreToolCardMetric[];
	readonly items?: readonly ICoreToolCardItem[];
	readonly preview?: ICoreToolCardPreview;
	readonly emptyMessage?: string;
	readonly useCompletionMessage?: boolean;
	readonly hasOutput: boolean;
	readonly uiTruncated: boolean;
	readonly failed: boolean;
	readonly errorMessage?: string;
}

/** Build the dedicated presentation for one core tool, tolerating old or partial payloads. */
export function createCoreToolCardViewModel(data: IChatCoreToolInvocationData): ICoreToolCardViewModel {
	const input = asRecord(data.input);
	const output = unwrapDataRecord(data.output);
	const common = {
		toolKind: data.toolKind,
		hasOutput: data.output !== undefined,
		uiTruncated: data.uiTruncated === true
			|| input.uiTruncated === true
			|| output.uiTruncated === true
			|| output.previewTruncated === true
			|| output.resultsTruncated === true,
		...outputFailure(output),
	};

	switch (data.toolKind) {
		case 'read': {
			const filePath = firstString(output, ['filePath', 'path']) ?? firstString(input, ['file_path', 'path']);
			const content = firstString(output, ['content', 'text']);
			const totalLines = firstNumber(output, ['totalLines', 'lineCount']);
			const offset = firstNumber(input, ['offset']);
			const limit = firstNumber(input, ['limit']);
			const mimeType = firstString(output, ['mimeType', 'imageMediaType']);
			const isImage = output.contentType === 'image' || mimeType?.startsWith('image/');
			const sizeBytes = firstNumber(output, ['sizeBytes']);
			return {
				...common,
				title: localize('chat.coreTool.read.title', "Read file"),
				summary: filePath,
				icon: Codicon.file,
				metrics: compactMetrics([
					totalLines !== undefined ? {
						label: localize('chat.coreTool.lines', "Lines"),
						value: String(totalLines),
						compactValue: totalLines === 1
							? localize('chat.coreTool.lines.one', "1 line")
							: localize('chat.coreTool.lines.other', "{0} lines", totalLines),
						isCount: true,
					} : undefined,
					isImage && mimeType ? { label: localize('chat.coreTool.imageType', "Type"), value: imageTypeLabel(mimeType) } : undefined,
					isImage && sizeBytes !== undefined ? { label: localize('chat.coreTool.size', "Size"), value: formatBytes(sizeBytes) } : undefined,
					offset !== undefined ? { label: localize('chat.coreTool.startLine', "Starts at"), value: String(offset) } : undefined,
					limit !== undefined ? { label: localize('chat.coreTool.limit', "Limit"), value: String(limit) } : undefined,
				]),
				preview: content ? textPreview(localize('chat.coreTool.read.preview', "File preview"), content) : undefined,
				emptyMessage: !content && !isImage ? localize('chat.coreTool.read.empty', "The file was read successfully.") : undefined,
				uiTruncated: common.uiTruncated || output.truncated === true || (content?.length ?? 0) > MAX_PREVIEW_LENGTH,
			};
		}
		case 'grep': {
			const pattern = firstString(input, ['pattern', 'query']);
			const path = firstString(input, ['path']);
			const glob = firstString(input, ['glob']);
			const matches = firstString(output, ['matches', 'text']);
			const matchCount = firstNumber(output, ['matchCount', 'count']);
			return {
				...common,
				title: localize('chat.coreTool.grep.title', "Search file contents"),
				summary: pattern,
				icon: Codicon.search,
				metrics: compactMetrics([
					matchCount !== undefined ? {
						label: localize('chat.coreTool.matches', "Matches"),
						value: String(matchCount),
						compactValue: matchCount === 1
							? localize('chat.coreTool.matches.one', "1 match")
							: localize('chat.coreTool.matches.other', "{0} matches", matchCount),
						isCount: true,
					} : undefined,
					path ? { label: localize('chat.coreTool.scope', "Scope"), value: path } : undefined,
					glob ? { label: localize('chat.coreTool.filter', "Filter"), value: glob } : undefined,
				]),
				preview: matches ? textPreview(localize('chat.coreTool.grep.results', "Matching lines"), matches) : undefined,
				emptyMessage: !matches ? localize('chat.coreTool.grep.empty', "No matching lines were returned.") : undefined,
			};
		}
		case 'glob': {
			const patterns = stringArray(input.patterns);
			const legacyPattern = firstString(input, ['pattern']);
			if (legacyPattern) {
				patterns.unshift(legacyPattern);
			}
			const files = stringArray(output.files);
			const count = firstNumber(output, ['count']) ?? files.length;
			return {
				...common,
				title: localize('chat.coreTool.glob.title', "Find files"),
				summary: patterns.join(', ') || undefined,
				icon: Codicon.files,
				metrics: compactMetrics([
					{
						label: localize('chat.coreTool.files', "Files"),
						value: String(count),
						compactValue: count === 1
							? localize('chat.coreTool.files.one', "1 file")
							: localize('chat.coreTool.files.other', "{0} files", count),
						isCount: true,
					},
					firstString(input, ['path']) ? { label: localize('chat.coreTool.scope', "Scope"), value: firstString(input, ['path'])! } : undefined,
				]),
				items: files.slice(0, MAX_ITEMS).map(file => ({ title: file })),
				emptyMessage: files.length === 0 ? localize('chat.coreTool.glob.empty', "No files matched these patterns.") : undefined,
				uiTruncated: common.uiTruncated || files.length > MAX_ITEMS,
			};
		}
		case 'fetchUrl': {
			const url = firstString(output, ['url']) ?? firstString(input, ['url']);
			const status = firstNumber(output, ['status', 'statusCode']);
			const text = firstString(output, ['text', 'content']);
			return {
				...common,
				title: localize('chat.coreTool.fetchUrl.title', "Fetch URL"),
				summary: displayUrl(url),
				icon: Codicon.globe,
				metrics: status !== undefined ? [{
					label: localize('chat.coreTool.httpStatus', "HTTP status"),
					value: String(status),
					compactValue: localize('chat.coreTool.httpStatus.compact', "HTTP {0}", status),
					isCount: true,
				}] : undefined,
				items: url ? [{ title: url, href: safeHttpUrl(url) }] : undefined,
				preview: text ? textPreview(localize('chat.coreTool.fetchUrl.preview', "Response preview"), text) : undefined,
				emptyMessage: !text ? localize('chat.coreTool.fetchUrl.empty', "The request completed without a text response.") : undefined,
			};
		}
		case 'webSearch': {
			const query = firstString(output, ['query']) ?? firstString(input, ['query']);
			const results = recordArray(output.results);
			return {
				...common,
				title: localize('chat.coreTool.webSearch.title', "Search the web"),
				summary: query,
				icon: Codicon.globe,
				metrics: [{
					label: localize('chat.coreTool.results', "Results"),
					value: String(results.length),
					compactValue: results.length === 1
						? localize('chat.coreTool.results.one', "1 result")
						: localize('chat.coreTool.results.other', "{0} results", results.length),
					isCount: true,
				}],
				items: results.slice(0, MAX_ITEMS).map(result => ({
					title: firstString(result, ['title']) ?? firstString(result, ['url']) ?? localize('chat.coreTool.webSearch.resultFallback', "Search result"),
					detail: firstString(result, ['snippet', 'description']) ?? displayUrl(firstString(result, ['url'])),
					href: safeHttpUrl(firstString(result, ['url'])),
				})),
				emptyMessage: results.length === 0 ? localize('chat.coreTool.webSearch.empty', "No web results were returned.") : undefined,
				uiTruncated: common.uiTruncated || results.length > MAX_ITEMS,
			};
		}
		case 'todo': {
			const reconciledTodos = recordArray(output.todos);
			const todos = reconciledTodos.length ? reconciledTodos : recordArray(input.todos);
			const items = todos.slice(0, MAX_ITEMS).map((todo, index): ICoreToolCardItem => {
				const rawState = firstString(todo, ['status']);
				return {
					title: firstString(todo, ['content', 'title']) ?? localize('chat.coreTool.todo.itemFallback', "Task {0}", index + 1),
					state: todoState(rawState),
				};
			});
			const completeCount = items.filter(item => item.state === 'complete').length;
			return {
				...common,
				title: localize('chat.coreTool.todo.title', "Task progress"),
				summary: items.length ? localize('chat.coreTool.todo.summary', "{0} of {1} complete", completeCount, items.length) : undefined,
				icon: Codicon.checklist,
				metrics: items.length ? [{ label: localize('chat.coreTool.tasks', "Tasks"), value: String(items.length) }] : undefined,
				items,
				emptyMessage: items.length === 0 ? localize('chat.coreTool.todo.empty', "The task list is empty.") : undefined,
				uiTruncated: common.uiTruncated || todos.length > MAX_ITEMS,
			};
		}
		case 'computer':
			return automationViewModel('computer', input, output, common);
		case 'browser':
			return automationViewModel('browser', input, output, common);
		case 'findSkill': {
			const activated = firstString(output, ['activated', 'downloaded']);
			const candidates = recordArray(output.candidates);
			return {
				...common,
				title: localize('chat.coreTool.findSkill.title', "Find a skill"),
				summary: activated
					? localize('chat.coreTool.findSkill.activated', "Activated {0}", activated)
					: firstString(input, ['skill', 'task']),
				icon: Codicon.book,
				metrics: firstString(output, ['source']) ? [{ label: localize('chat.coreTool.source', "Source"), value: firstString(output, ['source'])! }] : undefined,
				items: candidates.slice(0, MAX_ITEMS).map(candidate => ({
					title: firstString(candidate, ['name']) ?? localize('chat.coreTool.findSkill.candidateFallback', "Skill candidate"),
					detail: firstString(candidate, ['description']),
					state: firstString(candidate, ['name']) === activated ? 'complete' : undefined,
				})),
				emptyMessage: !activated && candidates.length === 0 ? localize('chat.coreTool.findSkill.empty', "No matching skill was found.") : undefined,
				useCompletionMessage: !activated,
				uiTruncated: common.uiTruncated || candidates.length > MAX_ITEMS,
			};
		}
		case 'findMcp': {
			const added = firstString(output, ['added']);
			const candidates = recordArray(output.candidates);
			const toolNames = stringArray(output.toolNames);
			return {
				...common,
				title: localize('chat.coreTool.findMcp.title', "Find an MCP server"),
				summary: added
					? localize('chat.coreTool.findMcp.connected', "Connected {0}", added)
					: firstString(input, ['server', 'task']),
				icon: Codicon.plug,
				metrics: toolNames.length ? [{
					label: localize('chat.coreTool.tools', "Tools"),
					value: String(toolNames.length),
					compactValue: toolNames.length === 1
						? localize('chat.coreTool.tools.one', "1 tool")
						: localize('chat.coreTool.tools.other', "{0} tools", toolNames.length),
					isCount: true,
				}] : undefined,
				items: candidates.slice(0, MAX_ITEMS).map(candidate => {
					const requiredEnv = stringArray(candidate.requiredEnv);
					const description = firstString(candidate, ['description']);
					return {
						title: firstString(candidate, ['title', 'id']) ?? localize('chat.coreTool.findMcp.candidateFallback', "MCP server"),
						detail: [description, requiredEnv.length ? localize('chat.coreTool.findMcp.env', "Requires {0}", requiredEnv.join(', ')) : undefined].filter(Boolean).join(' · ') || undefined,
						state: firstString(candidate, ['title']) === added ? 'complete' : undefined,
					};
				}),
				preview: toolNames.length ? textPreview(localize('chat.coreTool.findMcp.availableTools', "Available tools"), toolNames.join(', ')) : undefined,
				emptyMessage: !added && candidates.length === 0 ? localize('chat.coreTool.findMcp.empty', "No matching MCP server was found.") : undefined,
				useCompletionMessage: !added,
				uiTruncated: common.uiTruncated || candidates.length > MAX_ITEMS,
			};
		}
	}
}

type CommonViewModelFields = Pick<ICoreToolCardViewModel, 'toolKind' | 'hasOutput' | 'uiTruncated' | 'failed' | 'errorMessage'>;

function automationViewModel(
	toolKind: 'computer' | 'browser',
	input: Record<string, unknown>,
	output: Record<string, unknown>,
	common: CommonViewModelFields,
): ICoreToolCardViewModel {
	const inputActions = recordArray(input.actions);
	const results = recordArray(output.results);
	const rowCount = Math.max(inputActions.length, results.length);
	const items: ICoreToolCardItem[] = [];
	for (let index = 0; index < Math.min(rowCount, MAX_ITEMS); index++) {
		const action = inputActions[index] ?? results[index] ?? {};
		const result = results[index];
		const actionName = firstString(action, ['action', 'type']) ?? firstString(result, ['action']) ?? localize('chat.coreTool.automation.actionFallback', "Action {0}", index + 1);
		const succeeded = result?.success;
		items.push({
			title: automationActionLabel(actionName),
			detail: automationItemDetail(action, result),
			state: succeeded === false
				? 'error'
				: succeeded === true
					? 'complete'
					: common.hasOutput
						? 'skipped'
						: 'pending',
		});
	}
	const navigatedUrls = toolKind === 'browser'
		? inputActions.map(action => firstString(action, ['url'])).filter((value): value is string => !!value)
		: [];
	const navigatedUrl = navigatedUrls[navigatedUrls.length - 1];
	return {
		...common,
		failed: common.failed || output.success === false,
		title: toolKind === 'browser'
			? localize('chat.coreTool.browser.title', "Browser actions")
			: localize('chat.coreTool.computer.title', "Computer actions"),
		summary: navigatedUrl ? displayUrl(navigatedUrl) : rowCount
			? rowCount === 1
				? localize('chat.coreTool.automation.summary.one', "1 action")
				: localize('chat.coreTool.automation.summary.other', "{0} actions", rowCount)
			: undefined,
		icon: toolKind === 'browser' ? Codicon.browser : Codicon.deviceDesktop,
		metrics: rowCount ? [{ label: localize('chat.coreTool.actions', "Actions"), value: String(rowCount) }] : undefined,
		items,
		emptyMessage: rowCount === 0 ? localize('chat.coreTool.automation.empty', "No action details were returned.") : undefined,
		uiTruncated: common.uiTruncated || rowCount > MAX_ITEMS,
	};
}

export class ChatCoreToolProgressPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;
	public override readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		data: IChatCoreToolInvocationData,
	) {
		super(toolInvocation);
		const rendered = renderCoreToolCard(createCoreToolCardViewModel(data), invocationOutcome(toolInvocation));
		this.domNode = rendered.domNode;
		if (rendered.disclosureButton && rendered.details) {
			this._register(addDisposableListener(rendered.disclosureButton, 'click', () => {
				const expanded = rendered.disclosureButton!.ariaExpanded !== 'true';
				rendered.disclosureButton!.ariaExpanded = String(expanded);
				rendered.details!.hidden = !expanded;
				rendered.domNode.classList.toggle('chat-core-tool-card-expanded', expanded);
			}));
		}
	}
}

type InvocationOutcome = 'running' | 'complete' | 'error' | 'cancelled';

interface IInvocationPresentation {
	readonly kind: InvocationOutcome;
	readonly error?: string;
	readonly completionMessage?: string;
}

function invocationOutcome(invocation: IChatToolInvocation | IChatToolInvocationSerialized): IInvocationPresentation {
	const resultDetails = IChatToolInvocation.resultDetails(invocation);
	const resultError = !Array.isArray(resultDetails) && asRecord(resultDetails).isError === true;
	if (resultError) {
		return { kind: 'error', error: outputTextFromResultDetails(resultDetails) };
	}
	const confirmation = IChatToolInvocation.executionConfirmedOrDenied(invocation);
	if (confirmation?.type === ToolConfirmKind.Denied || confirmation?.type === ToolConfirmKind.Skipped) {
		if (invocation.kind === 'toolInvocation') {
			const state = invocation.state.get();
			if (state.type === IChatToolInvocation.StateKind.Cancelled) {
				return { kind: 'cancelled', error: markdownText(state.reasonMessage) };
			}
		}
		return { kind: 'cancelled' };
	}
	return IChatToolInvocation.isComplete(invocation)
		? { kind: 'complete', completionMessage: markdownText(invocation.pastTenseMessage) }
		: { kind: 'running' };
}

interface IRenderedCoreToolCard {
	readonly domNode: HTMLElement;
	readonly disclosureButton?: HTMLButtonElement;
	readonly details?: HTMLElement;
}

function renderCoreToolCard(view: ICoreToolCardViewModel, invocation: IInvocationPresentation): IRenderedCoreToolCard {
	const outcome: InvocationOutcome = invocation.kind === 'complete' && view.failed ? 'error' : invocation.kind;
	const errorMessage = invocation.error ?? view.errorMessage;
	const hasDetails = !!view.items?.length || !!view.preview || view.uiTruncated;
	const showResultState = outcome === 'complete' && view.hasOutput;
	const cardId = `chat-core-tool-card-${++coreToolCardIdPool}`;
	const titleId = `${cardId}-title`;
	const detailsId = `${cardId}-details`;
	const metricPresentation = coreToolMetricPresentation(view);
	const compactReadError = outcome === 'error' && view.toolKind === 'read'
		? compactReadErrorLabel(errorMessage)
		: undefined;
	const card = document.createElement('section');
	card.classList.add('chat-core-tool-card', `chat-core-tool-card-${view.toolKind}`, `chat-core-tool-card-${outcome}`);

	const header = document.createElement(hasDetails ? 'button' : 'div');
	header.classList.add('chat-core-tool-card-header');
	if (hasDetails) {
		const button = header as HTMLButtonElement;
		button.type = 'button';
		button.id = `${cardId}-header`;
		button.ariaExpanded = 'false';
		button.setAttribute('aria-controls', detailsId);
	}
	const icon = document.createElement('span');
	icon.classList.add('chat-core-tool-card-icon', ...ThemeIcon.asClassNameArray(view.icon));
	icon.setAttribute('aria-hidden', 'true');
	const heading = document.createElement('div');
	heading.classList.add('chat-core-tool-card-heading');
	const titleLine = document.createElement('div');
	titleLine.classList.add('chat-core-tool-card-title-line');
	const title = document.createElement('span');
	title.classList.add('chat-core-tool-card-title');
	title.id = titleId;
	title.textContent = view.title;
	titleLine.appendChild(title);
	if (view.summary) {
		const summary = document.createElement('span');
		summary.classList.add('chat-core-tool-card-summary');
		summary.textContent = view.summary;
		titleLine.appendChild(summary);
	}
	heading.appendChild(titleLine);
	const subtitleText = compactReadError
		?? metricPresentation.subtitle
		?? (outcome === 'complete' && view.useCompletionMessage ? invocation.completionMessage : undefined)
		?? (showResultState ? view.emptyMessage : undefined);
	if (subtitleText) {
		const subtitle = document.createElement('span');
		subtitle.classList.add('chat-core-tool-card-subtitle');
		if (compactReadError) {
			subtitle.classList.add('chat-core-tool-card-subtitle-error');
		}
		subtitle.textContent = subtitleText;
		heading.appendChild(subtitle);
	}
	header.append(icon, heading);
	if (showResultState && metricPresentation.count) {
		const count = document.createElement('span');
		count.classList.add('chat-core-tool-card-count');
		count.textContent = metricPresentation.count.compactValue ?? metricPresentation.count.value;
		count.title = metricPresentation.count.label;
		count.setAttribute('aria-label', localize('chat.coreTool.metricAriaLabel', "{0}: {1}", metricPresentation.count.label, metricPresentation.count.value));
		header.appendChild(count);
	}
	const status = document.createElement('span');
	status.classList.add('chat-core-tool-card-status', `chat-core-tool-card-status-${outcome}`);
	status.setAttribute('aria-hidden', 'true');
	status.title = outcome === 'error' && errorMessage ? errorMessage : outcomeLabel(outcome);
	const statusIcon = document.createElement('span');
	statusIcon.classList.add(...ThemeIcon.asClassNameArray(outcomeIcon(outcome)));
	status.appendChild(statusIcon);
	header.appendChild(status);
	if (hasDetails) {
		const disclosure = document.createElement('span');
		disclosure.classList.add('chat-core-tool-card-disclosure', ...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		disclosure.setAttribute('aria-hidden', 'true');
		header.appendChild(disclosure);
	}
	if (hasDetails) {
		(header as HTMLButtonElement).setAttribute('aria-label', coreToolHeaderAriaLabel(
			view,
			subtitleText,
			showResultState ? metricPresentation.count : undefined,
			outcome,
		));
	}
	card.appendChild(header);
	const lifecycleStatus = document.createElement('span');
	lifecycleStatus.classList.add('chat-core-tool-card-visually-hidden');
	lifecycleStatus.setAttribute('role', 'status');
	lifecycleStatus.setAttribute('aria-live', 'polite');
	lifecycleStatus.textContent = localize('chat.coreTool.lifecycleStatus', "{0}: {1}", view.title, outcomeLabel(outcome));
	card.appendChild(lifecycleStatus);

	if (outcome === 'error' && errorMessage) {
		const error = document.createElement('div');
		error.classList.add('chat-core-tool-card-error-message');
		if (compactReadError) {
			error.classList.add('chat-core-tool-card-visually-hidden');
		}
		error.setAttribute('role', 'alert');
		error.textContent = errorMessage;
		card.appendChild(error);
	}

	let details: HTMLElement | undefined;
	if (hasDetails) {
		details = document.createElement('div');
		details.classList.add('chat-core-tool-card-details');
		details.id = detailsId;
		details.hidden = true;
		details.setAttribute('role', 'region');
		details.setAttribute('aria-labelledby', titleId);
	}

	if (details && view.items?.length) {
		const list = document.createElement('ul');
		list.classList.add('chat-core-tool-card-items');
		for (const item of view.items) {
			const row = document.createElement('li');
			row.classList.add('chat-core-tool-card-item');
			if (item.state) {
				row.classList.add(`chat-core-tool-card-item-${item.state}`);
				const marker = document.createElement('span');
				marker.classList.add('chat-core-tool-card-item-marker', ...ThemeIcon.asClassNameArray(itemStateIcon(item.state)));
				marker.setAttribute('aria-hidden', 'true');
				row.appendChild(marker);
				const stateText = document.createElement('span');
				stateText.classList.add('chat-core-tool-card-visually-hidden');
				stateText.textContent = itemStateLabel(item.state);
				row.appendChild(stateText);
			}
			const content = document.createElement('div');
			content.classList.add('chat-core-tool-card-item-content');
			const label = item.href ? document.createElement('a') : document.createElement('span');
			label.classList.add('chat-core-tool-card-item-title');
			label.textContent = item.title;
			if (item.href) {
				const link = label as HTMLAnchorElement;
				link.href = item.href;
				link.target = '_blank';
				link.rel = 'noopener noreferrer';
			}
			content.appendChild(label);
			if (item.detail) {
				const detail = document.createElement('span');
				detail.classList.add('chat-core-tool-card-item-detail');
				detail.textContent = item.detail;
				content.appendChild(detail);
			}
			row.appendChild(content);
			list.appendChild(row);
		}
		details.appendChild(list);
	}

	if (details && view.preview) {
		const preview = document.createElement('div');
		preview.classList.add('chat-core-tool-card-preview');
		const label = document.createElement('span');
		label.classList.add('chat-core-tool-card-section-label');
		label.textContent = view.preview.label;
		const pre = document.createElement('pre');
		pre.tabIndex = 0;
		pre.setAttribute('aria-label', view.preview.label);
		pre.textContent = view.preview.text;
		preview.append(label, pre);
		details.appendChild(preview);
	}

	if (details && view.uiTruncated) {
		const truncated = document.createElement('div');
		truncated.classList.add('chat-core-tool-card-truncated');
		truncated.textContent = localize('chat.coreTool.truncated', "Showing a shortened preview");
		details.appendChild(truncated);
	}

	if (details) {
		card.appendChild(details);
	}

	return {
		domNode: card,
		...(hasDetails ? { disclosureButton: header as HTMLButtonElement, details } : {}),
	};
}

function coreToolMetricPresentation(view: ICoreToolCardViewModel): { count?: ICoreToolCardMetric; subtitle?: string } {
	const metrics = view.metrics ?? [];
	if (view.toolKind === 'todo' || view.toolKind === 'computer' || view.toolKind === 'browser') {
		return {};
	}
	const countIndex = metrics.findIndex(metric => metric.isCount === true);
	const count = countIndex >= 0 ? metrics[countIndex] : undefined;
	const remaining = metrics.filter((_, index) => index !== countIndex);
	const subtitle = remaining.length
		? remaining.map(metric => localize('chat.coreTool.metric', "{0}: {1}", metric.label, metric.value)).join(' · ')
		: undefined;
	return { count, subtitle };
}

function coreToolHeaderAriaLabel(view: ICoreToolCardViewModel, subtitle: string | undefined, count: ICoreToolCardMetric | undefined, outcome: InvocationOutcome): string {
	const subject = view.summary
		? localize('chat.coreTool.headerAriaLabel.withSummary', "{0}: {1}", view.title, view.summary)
		: view.title;
	const countText = count ? localize('chat.coreTool.metricAriaLabel', "{0}: {1}", count.label, count.value) : undefined;
	return [subject, subtitle, countText, outcomeLabel(outcome)].filter((value): value is string => !!value).join('. ');
}

function outputFailure(output: Record<string, unknown>): Pick<ICoreToolCardViewModel, 'failed' | 'errorMessage'> {
	const results = recordArray(output.results);
	const failedResult = results.find(result => result.success === false || !!firstString(result, ['error']));
	const errorMessage = firstString(output, ['error', 'message']) ?? (failedResult ? firstString(failedResult, ['error', 'summary']) : undefined);
	return { failed: output.success === false || !!failedResult || !!errorMessage, errorMessage };
}

function outputTextFromResultDetails(details: unknown): string | undefined {
	const output = asRecord(details).output;
	if (!Array.isArray(output)) {
		return undefined;
	}
	for (const item of output) {
		const text = firstString(asRecord(item), ['value']);
		if (text) {
			return text;
		}
	}
	return undefined;
}

function markdownText(value: string | IMarkdownString | undefined): string | undefined {
	return typeof value === 'string' ? value : value?.value;
}

function outcomeIcon(outcome: InvocationOutcome): ThemeIcon {
	switch (outcome) {
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'complete': return Codicon.check;
		case 'error': return Codicon.error;
		case 'cancelled': return Codicon.circleSlash;
	}
}

function outcomeLabel(outcome: InvocationOutcome): string {
	switch (outcome) {
		case 'running': return localize('chat.coreTool.status.running', "Running");
		case 'complete': return localize('chat.coreTool.status.complete', "Done");
		case 'error': return localize('chat.coreTool.status.error', "Failed");
		case 'cancelled': return localize('chat.coreTool.status.cancelled', "Cancelled");
	}
}

function compactReadErrorLabel(errorMessage: string | undefined): string {
	if (/ENOENT|no such file or directory/i.test(errorMessage ?? '')) {
		return localize('chat.coreTool.read.error.notFound', "File not found");
	}
	if (/EACCES|EPERM|permission denied/i.test(errorMessage ?? '')) {
		return localize('chat.coreTool.read.error.permissionDenied', "Permission denied");
	}
	if (/EISDIR|is a directory/i.test(errorMessage ?? '')) {
		return localize('chat.coreTool.read.error.directory', "Path is a directory");
	}
	return localize('chat.coreTool.read.error.generic', "Read failed");
}

function itemStateIcon(state: NonNullable<ICoreToolCardItem['state']>): ThemeIcon {
	switch (state) {
		case 'pending': return Codicon.circleOutline;
		case 'active': return Codicon.arrowRight;
		case 'complete': return Codicon.check;
		case 'error': return Codicon.error;
		case 'skipped': return Codicon.circleSlash;
	}
}

function itemStateLabel(state: NonNullable<ICoreToolCardItem['state']>): string {
	switch (state) {
		case 'pending': return localize('chat.coreTool.itemState.pending', "Pending");
		case 'active': return localize('chat.coreTool.itemState.active', "In progress");
		case 'complete': return localize('chat.coreTool.itemState.complete', "Completed");
		case 'error': return localize('chat.coreTool.itemState.error', "Failed");
		case 'skipped': return localize('chat.coreTool.itemState.skipped', "Skipped");
	}
}

function todoState(value: string | undefined): ICoreToolCardItem['state'] {
	if (value === 'completed' || value === 'complete' || value === 'done') {
		return 'complete';
	}
	if (value === 'in_progress' || value === 'in-progress' || value === 'active') {
		return 'active';
	}
	return 'pending';
}

function automationActionLabel(value: string): string {
	switch (value) {
		case 'screenshot': return localize('chat.coreTool.action.screenshot', "Capture screenshot");
		case 'navigate': return localize('chat.coreTool.action.navigate', "Navigate");
		case 'click': return localize('chat.coreTool.action.click', "Click");
		case 'type': return localize('chat.coreTool.action.type', "Type text");
		case 'key': return localize('chat.coreTool.action.key', "Press key");
		case 'scroll': return localize('chat.coreTool.action.scroll', "Scroll");
		case 'drag': return localize('chat.coreTool.action.drag', "Drag");
		case 'wait': return localize('chat.coreTool.action.wait', "Wait");
		case 'openApp': return localize('chat.coreTool.action.openApp', "Open application");
		default: return value;
	}
}

function automationItemDetail(action: Record<string, unknown>, result: Record<string, unknown> | undefined): string | undefined {
	const observation = asRecord(result?.observation);
	return joinUniqueDetails([
		result ? firstString(result, ['error', 'summary']) : undefined,
		automationActionDetail(action),
		result ? automationVerificationDetail(result) : undefined,
		result ? automationObservationDetail(result) : undefined,
		Object.keys(observation).length ? automationObservationDetail(observation) : undefined,
	]);
}

function automationActionDetail(action: Record<string, unknown>): string | undefined {
	const duration = firstNumber(action, ['durationMs', 'ms']);
	const textLength = firstNumber(action, ['textLength']);
	const deltaX = firstNumber(action, ['deltaX']);
	const deltaY = firstNumber(action, ['deltaY']);
	const target = automationTargetDetail(asRecord(action.target));
	const from = automationTargetDetail(asRecord(action.from));
	const to = automationTargetDetail(asRecord(action.to));
	const key = automationKeyDetail(action);
	return joinUniqueDetails([
		firstString(action, ['url', 'appName']),
		target,
		firstString(action, ['button']),
		textLength !== undefined
			? textLength === 1
				? localize('chat.coreTool.action.characters.one', "1 character")
				: localize('chat.coreTool.action.characters.other', "{0} characters", textLength)
			: undefined,
		firstString(action, ['mode']),
		key,
		firstString(action, ['phase']),
		deltaX !== undefined || deltaY !== undefined
			? localize('chat.coreTool.action.scrollDelta', "Delta {0}, {1}", deltaX ?? 0, deltaY ?? 0)
			: undefined,
		from && to ? localize('chat.coreTool.action.dragEndpoints', "{0} to {1}", from, to) : undefined,
		duration !== undefined ? localize('chat.coreTool.action.duration', "{0} ms", duration) : undefined,
	]);
}

function automationKeyDetail(action: Record<string, unknown>): string | undefined {
	const keyValue = action.key;
	const keyRecord = asRecord(keyValue);
	const key = typeof keyValue === 'string' ? keyValue : firstString(keyRecord, ['key']);
	const modifiers = stringArray(Object.keys(keyRecord).length ? keyRecord.modifiers : action.modifiers);
	return key ? [...modifiers, key].join('+') : undefined;
}

function automationTargetDetail(target: Record<string, unknown>): string | undefined {
	const elementId = firstString(target, ['elementId']);
	if (elementId) {
		return localize('chat.coreTool.action.elementTarget', "Element {0}", elementId);
	}
	const x = firstNumber(target, ['x']);
	const y = firstNumber(target, ['y']);
	return x !== undefined && y !== undefined
		? localize('chat.coreTool.action.coordinateTarget', "({0}, {1})", x, y)
		: undefined;
}

function automationVerificationDetail(result: Record<string, unknown>): string | undefined {
	switch (firstString(result, ['verification'])) {
		case 'passed': return localize('chat.coreTool.action.verificationPassed', "Verified");
		case 'failed': return localize('chat.coreTool.action.verificationFailed', "Verification failed");
		case 'unknown': return localize('chat.coreTool.action.verificationUnknown', "Verification unknown");
		default: return undefined;
	}
}

function automationObservationDetail(observation: Record<string, unknown>): string | undefined {
	const imageSize = sizeDetail(asRecord(observation.imageSize)) ?? sizeDetail(asRecord(observation.screenSize));
	const elementCount = firstNumber(observation, ['elementCount']);
	const imageMediaType = firstString(observation, ['imageMediaType', 'mimeType']);
	return joinUniqueDetails([
		firstString(observation, ['appName']),
		firstString(observation, ['windowTitle']),
		imageSize,
		elementCount !== undefined
			? elementCount === 1
				? localize('chat.coreTool.action.elements.one', "1 element")
				: localize('chat.coreTool.action.elements.other', "{0} elements", elementCount)
			: undefined,
		imageMediaType ? imageTypeLabel(imageMediaType) : undefined,
		firstString(observation, ['screenshotPath']),
	]);
}

function sizeDetail(size: Record<string, unknown>): string | undefined {
	const width = firstNumber(size, ['width']);
	const height = firstNumber(size, ['height']);
	return width !== undefined && height !== undefined
		? localize('chat.coreTool.imageDimensions', "{0}×{1}", width, height)
		: undefined;
}

function joinUniqueDetails(values: readonly (string | undefined)[]): string | undefined {
	const result = [...new Set(values.filter((value): value is string => !!value))];
	return result.length ? result.join(' · ') : undefined;
}

function imageTypeLabel(mimeType: string): string {
	const subtype = mimeType.startsWith('image/') ? mimeType.slice('image/'.length).toLocaleUpperCase() : mimeType;
	return localize('chat.coreTool.imageTypeValue', "{0} image", subtype);
}

function formatBytes(value: number): string {
	if (value < 1_024) {
		return localize('chat.coreTool.bytes', "{0} B", value);
	}
	if (value < 1_048_576) {
		return localize('chat.coreTool.kilobytes', "{0} KB", Math.round(value / 1_024));
	}
	return localize('chat.coreTool.megabytes', "{0} MB", Math.round(value / 1_048_576 * 10) / 10);
}

function textPreview(label: string, value: string): ICoreToolCardPreview {
	return { label, text: value.length > MAX_PREVIEW_LENGTH ? `${value.slice(0, MAX_PREVIEW_LENGTH)}\n…` : value };
}

function compactMetrics(values: readonly (ICoreToolCardMetric | undefined)[]): ICoreToolCardMetric[] | undefined {
	const result = values.filter((value): value is ICoreToolCardMetric => !!value);
	return result.length ? result : undefined;
}

function unwrapDataRecord(value: unknown): Record<string, unknown> {
	const record = asRecord(value);
	const nested = asRecord(record.data);
	return Object.keys(nested).length > 0 && Object.keys(record).length === 1 ? nested : record;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(asRecord).filter(record => Object.keys(record).length > 0).slice(0, MAX_ITEMS + 1) : [];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_ITEMS + 1) : [];
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

function safeHttpUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function displayUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
	} catch {
		return value;
	}
}
