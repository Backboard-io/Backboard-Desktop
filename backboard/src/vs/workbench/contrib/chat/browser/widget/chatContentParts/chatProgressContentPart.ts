/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, disposableWindowInterval, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { IRenderedMarkdown, renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { alert } from '../../../../../../base/browser/ui/aria/aria.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { MarkdownString, type IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { stripIcons } from '../../../../../../base/common/iconLabels.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../../nls.js';
import { IChatProgressMessage, IChatTask, IChatTaskSerialized, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../common/chatService/chatService.js';
import { IChatRendererContent, IChatResponseViewModel, IChatWorkingProgress, IChatWorkingProgressState, isResponseVM } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { renderFileWidgets } from './chatInlineAnchorWidget.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { getToolApprovalMessage, isAskQuestionsToolInvocation } from './toolInvocationParts/chatToolPartUtilities.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AccessibilityWorkbenchSettingId } from '../../../../accessibility/browser/accessibilityConfiguration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { HoverStyle } from '../../../../../../base/browser/ui/hover/hover.js';
import { ILanguageModelToolsService } from '../../../common/tools/languageModelToolsService.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { buildPhrasePool, defaultThinkingMessages, maybePickFunWorkingMessage } from './chatThinkingContentPart.js';

function isBackboardCursorTranscript(container: HTMLElement): boolean {
	return container.closest('.backboard-cursor-transcript') !== null
		|| (container.closest('.part.auxiliarybar') !== null && container.closest('.backboard-chat-controls') !== null);
}

export class ChatProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private readonly showSpinner: boolean;
	private readonly isHidden: boolean;
	private readonly renderedMessage = this._register(new MutableDisposable<IRenderedMarkdown>());
	private readonly _fileWidgetStore = this._register(new DisposableStore());
	private readonly liveElapsedTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly liveElapsedStartedAt = Date.now();
	private readonly showLiveElapsed: boolean;
	private liveElapsedElement: HTMLElement | undefined;
	private currentContent: IMarkdownString;

	constructor(
		progress: IChatProgressMessage | IChatTask | IChatTaskSerialized | { content: IMarkdownString },
		private readonly chatContentMarkdownRenderer: IMarkdownRenderer,
		context: IChatContentPartRenderContext,
		forceShowSpinner: boolean | undefined,
		forceShowMessage: boolean | undefined,
		icon: ThemeIcon | undefined,
		private readonly toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized | undefined,
		shimmer: boolean | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		this.currentContent = progress.content;

		const followingContentStart = context.contentIndex + 1;
		this.showSpinner = toolInvocation
			? !IChatToolInvocation.isComplete(toolInvocation)
			: forceShowSpinner ?? shouldShowSpinner(context.content, context.element, followingContentStart);
		// Progress rows never show elapsed time; the label alone carries the state.
		this.showLiveElapsed = false;
		this.isHidden = forceShowMessage !== true && hasNonProgressContent(context.content, followingContentStart);
		if (this.isHidden) {
			// Placeholder, don't show the progress message
			this.domNode = $('');
			return;
		}

		if (this.showSpinner && this.configurationService.getValue(AccessibilityWorkbenchSettingId.VerboseChatProgressUpdates)) {
			// this step is in progress, communicate it to SR users
			alert(stripIcons(renderAsPlaintext(progress.content)));
		}
		const isLoadingIcon = icon && ThemeIcon.isEqual(icon, ThemeIcon.modify(Codicon.loading, 'spin'));
		const useCompactCursorIndicator = this.showSpinner && isBackboardCursorTranscript(context.container);
		// Tool activity follows the tool lifecycle, never the enclosing response.
		// Use the same ring in both Backboard presentations, without a second animation on the label.
		const useShimmer = !toolInvocation && !context.container.closest('.backboard-clean-chat') &&
			(shimmer ?? (!icon || isLoadingIcon)) && this.showSpinner && !useCompactCursorIndicator;
		const codicon = this.showSpinner
			? (useShimmer ? Codicon.check : ThemeIcon.modify(Codicon.loading, 'spin'))
			: (isLoadingIcon ? Codicon.check : icon ?? Codicon.check);
		const result = this.chatContentMarkdownRenderer.render(progress.content);
		result.element.classList.add('progress-step');
		renderFileWidgets(result.element, this.instantiationService, this.chatMarkdownAnchorService, this._fileWidgetStore);
		if (useShimmer) {
			this.applyPartialShimmer(result.element);
		}
		this.attachLiveElapsed(result.element);

		const tooltip: IMarkdownString | undefined = this.createApprovalMessage();
		const progressPart = this._register(instantiationService.createInstance(ChatProgressSubPart, result.element, codicon, tooltip));
		this.domNode = progressPart.domNode;
		if (useCompactCursorIndicator) {
			this.domNode.classList.add('chat-cursor-progress-row');
			this.domNode.setAttribute('role', 'status');
			this.domNode.setAttribute('aria-live', 'polite');
			this.domNode.setAttribute('aria-atomic', 'true');
			const indicator = this.domNode.firstElementChild;
			indicator?.setAttribute('aria-hidden', 'true');
		}
		if (useShimmer) {
			this.domNode.classList.add('shimmer-progress');
		}
		this.renderedMessage.value = result;
		if (this.showLiveElapsed) {
			const tick = () => {
				if (this.liveElapsedElement) {
					this.liveElapsedElement.textContent = `· ${formatWorkingElapsed(Date.now() - this.liveElapsedStartedAt)}`;
				}
			};
			tick();
			this.liveElapsedTimer.value = disposableWindowInterval(getWindow(this.domNode), tick, 1000);
		}
	}

	/** Keeps provider/status progress visibly alive even when no stream event arrives. */
	private attachLiveElapsed(element: HTMLElement): void {
		this.liveElapsedElement = undefined;
		if (!this.showLiveElapsed) {
			return;
		}
		element.classList.add('chat-progress-with-elapsed');
		this.liveElapsedElement = $('span.chat-progress-elapsed');
		element.appendChild(this.liveElapsedElement);
	}

	private applyPartialShimmer(element: HTMLElement): void {
		if (!this.toolInvocation || !isAskQuestionsToolInvocation(this.toolInvocation)) {
			return;
		}

		const firstChild = element.firstElementChild;
		const messageElement = isHTMLElement(firstChild) && firstChild.tagName === 'P' ? firstChild : element;
		const message = messageElement.textContent;
		const suffixOffset = message?.indexOf(' (') ?? -1;
		if (suffixOffset <= 0) {
			return;
		}

		element.classList.add('chat-progress-partial-shimmer');
		this.wrapLeadingText(messageElement, suffixOffset);
	}

	private wrapLeadingText(element: HTMLElement, length: number): void {
		let remaining = length;
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		while (remaining > 0) {
			const node = walker.nextNode();
			if (!node) {
				return;
			}

			const text = node.nodeValue ?? '';
			if (!text) {
				continue;
			}

			const shimmerText = text.slice(0, remaining);
			const suffixText = text.slice(remaining);
			const span = element.ownerDocument.createElement('span');
			span.classList.add('chat-progress-shimmer-text');
			span.textContent = shimmerText;
			node.parentNode?.insertBefore(span, node);
			if (suffixText) {
				node.nodeValue = suffixText;
			} else {
				node.parentNode?.removeChild(node);
			}
			remaining -= shimmerText.length;
		}
	}

	updateMessage(content: IMarkdownString): void {
		if (this.isHidden) {
			return;
		}
		this.currentContent = content;

		// Render the new message
		const result = this._register(this.chatContentMarkdownRenderer.render(content));
		result.element.classList.add('progress-step');
		this.attachLiveElapsed(result.element);
		this._fileWidgetStore.clear();
		renderFileWidgets(result.element, this.instantiationService, this.chatMarkdownAnchorService, this._fileWidgetStore);

		// Replace the old message container with the new one
		if (this.renderedMessage.value) {
			this.renderedMessage.value.element.replaceWith(result.element);
		} else {
			this.domNode.appendChild(result.element);
		}

		this.renderedMessage.value = result;
	}

	hasSameContent(other: IChatRendererContent, content: IChatRendererContent[], element: ChatTreeItem, followingContentStart = 0): boolean {
		// Progress parts render render until some other content shows up, then they hide.
		// When some other content shows up, need to signal to be rerendered as hidden.
		if (hasNonProgressContent(content, followingContentStart) && !this.isHidden) {
			return false;
		}

		// Needs rerender when spinner state changes
		const showSpinner = shouldShowSpinner(content, element, followingContentStart);

		// Needs rerender when content changes
		if (other.kind === 'progressMessage' && other.content.value !== this.currentContent.value) {
			return false;
		}

		return other.kind === 'progressMessage' && this.showSpinner === showSpinner;
	}

	private createApprovalMessage(): IMarkdownString | undefined {
		return this.toolInvocation && getToolApprovalMessage(this.toolInvocation);
	}
}

function hasNonProgressContent(content: ReadonlyArray<IChatRendererContent>, start: number): boolean {
	for (let index = start; index < content.length; index++) {
		if (content[index].kind !== 'progressMessage') {
			return true;
		}
	}
	return false;
}

function shouldShowSpinner(content: ReadonlyArray<IChatRendererContent>, element: ChatTreeItem, followingContentStart = 0): boolean {
	return isResponseVM(element) && !element.isComplete && content.length <= followingContentStart;
}


export class ChatProgressSubPart extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(
		messageElement: HTMLElement,
		icon: ThemeIcon,
		tooltip: IMarkdownString | string | undefined,
		@IHoverService hoverService: IHoverService,
	) {
		super();

		this.domNode = $('.progress-container');
		const iconElement = $('div');
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		if (tooltip) {
			this._register(hoverService.setupDelayedHover(iconElement, {
				content: tooltip,
				style: HoverStyle.Pointer,
			}));
			this._register(hoverService.setupDelayedHover(messageElement, {
				content: tooltip,
				style: HoverStyle.Pointer,
			}));
		}
		append(this.domNode, iconElement);

		messageElement.classList.add('progress-step');
		append(this.domNode, messageElement);
	}
}

/**
 * Picks a working-progress label, debounced per response so rapid
 * re-instantiations during streaming reuse the previous label instead of
 * flickering. Each response gets its own dwell window keyed by
 * `element.id`; stale entries are pruned opportunistically on each call.
 */
const WORKING_LABEL_MIN_DWELL_MS = 1200;
const lastPickedWorkingLabelByElement = new Map<string, { label: string; pickedAt: number }>();

function pickWorkingLabel(elementId: string, configurationService: IConfigurationService): string {
	const now = Date.now();

	// Prune entries older than the dwell window. The map only holds entries
	// for actively-streaming responses, so this stays small.
	for (const [id, entry] of lastPickedWorkingLabelByElement) {
		if (now - entry.pickedAt >= WORKING_LABEL_MIN_DWELL_MS) {
			lastPickedWorkingLabelByElement.delete(id);
		}
	}

	const existing = lastPickedWorkingLabelByElement.get(elementId);
	if (existing && now - existing.pickedAt < WORKING_LABEL_MIN_DWELL_MS) {
		existing.pickedAt = now;
		return existing.label;
	}

	const fun = maybePickFunWorkingMessage(configurationService);
	const label = fun ?? (() => {
		const pool = buildPhrasePool(defaultThinkingMessages, configurationService);
		return pool[Math.floor(Math.random() * pool.length)];
	})();
	lastPickedWorkingLabelByElement.set(elementId, { label, pickedAt: now });
	return label;
}

/**
 * Schedule for the live working label. While no response tokens have arrived
 * yet, the label walks through connection-flavored startup stages (matching
 * Zed's "Connecting to model" treatment); after that it rotates through the
 * thinking phrase pool so the row never sits still. Labels are derived
 * deterministically from elapsed time and the element id, so re-renders during
 * streaming land on the same label instead of flickering.
 */
const WORKING_CONNECT_STAGE_MS = 2000;
const WORKING_FIRST_TOKEN_STAGE_MS = 6000;
const WORKING_ROTATE_INTERVAL_MS = 4000;

const workingStartupStages = [
	localize('chat.working.connecting', "Connecting to model"),
	localize('chat.working.firstToken', "Waiting for first token"),
];

function hashWorkingSeed(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

/** Small deterministic LCG so fun-message picks are stable per rotation step. */
function workingRandomFromSeed(seed: number): () => number {
	let state = seed || 1;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

function pickRotatingWorkingLabel(elementId: string, rotationStep: number, configurationService: IConfigurationService): string {
	const fun = maybePickFunWorkingMessage(configurationService, workingRandomFromSeed(hashWorkingSeed(`${elementId}:${rotationStep}`)));
	if (fun) {
		return fun;
	}
	const pool = buildPhrasePool(defaultThinkingMessages, configurationService);
	return pool[(hashWorkingSeed(elementId) + rotationStep) % pool.length];
}

export function computeLiveWorkingLabel(elementId: string, hasResponseContent: boolean, elapsedMs: number, configurationService: IConfigurationService): string {
	// Startup stages only apply while nothing has streamed back yet; a working
	// indicator shown mid-turn (between tool calls) goes straight to the rotation.
	if (!hasResponseContent) {
		if (elapsedMs < WORKING_CONNECT_STAGE_MS) {
			return workingStartupStages[0];
		}
		if (elapsedMs < WORKING_FIRST_TOKEN_STAGE_MS) {
			return workingStartupStages[1];
		}
	}
	return pickRotatingWorkingLabel(elementId, Math.floor(elapsedMs / WORKING_ROTATE_INTERVAL_MS), configurationService);
}

/**
 * Formats an elapsed duration for the live working label, matching T3 Code's
 * ticker: seconds under a minute (`42s`), minutes and seconds up to an hour
 * (`3m 20s`), then hours and minutes (`1h 5m`). The unit letters are numeric
 * suffixes rather than translatable words, so they are left un-externalized.
 */
function formatWorkingElapsed(elapsedMs: number): string {
	const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}

	const hours = Math.floor(elapsedSeconds / 3600);
	const minutes = Math.floor((elapsedSeconds % 3600) / 60);
	const seconds = elapsedSeconds % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}

	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export class ChatWorkingProgressContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;
	private readonly labelElement: HTMLElement;
	private readonly statsElement: HTMLElement;
	private explicitContent: IMarkdownString | undefined;
	private readonly label: string;
	private readonly hasState: boolean;
	private readonly isCompleteState: boolean;
	private readonly elementId: string;
	private readonly responseElement: IChatResponseViewModel | undefined;
	private readonly useBackboardTimelinePresentation: boolean;
	private readonly useCursorTranscriptPresentation: boolean;
	/** Ticks the live working label and elapsed time once per second while the turn runs. */
	private readonly workingTimer = this._register(new MutableDisposable<IDisposable>());

	constructor(
		workingProgress: IChatWorkingProgress,
		chatContentMarkdownRenderer: IMarkdownRenderer,
		context: IChatContentPartRenderContext,
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatMarkdownAnchorService chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
	) {
		super();
		this.explicitContent = workingProgress.content;
		this.elementId = context.element.id;
		this.responseElement = isResponseVM(context.element) ? context.element : undefined;
		this.useCursorTranscriptPresentation = isBackboardCursorTranscript(context.container);
		this.useBackboardTimelinePresentation = context.container.closest('.backboard-clean-chat') !== null && !this.useCursorTranscriptPresentation;
		this.label = this.useCursorTranscriptPresentation
			? localize('chat.cursorPlanningNextMoves', "Planning next moves")
			: pickWorkingLabel(context.element.id, configurationService);

		// Build the DOM
		this.domNode = $('.progress-container');
		this.domNode.classList.toggle('chat-cursor-working-row', this.useCursorTranscriptPresentation);
		const iconElement = $('div');
		const state = workingProgress.state;
		this.hasState = !!state;
		const isComplete = state?.isComplete ?? false;
		this.isCompleteState = isComplete;
		this.domNode.classList.toggle('chat-cursor-working-complete', this.useCursorTranscriptPresentation && isComplete);

		iconElement.classList.add(...ThemeIcon.asClassNameArray(isComplete ? Codicon.check : ThemeIcon.modify(Codicon.loading, 'spin')));
		iconElement.setAttribute('aria-hidden', 'true');
		append(this.domNode, iconElement);
		this.domNode.classList.toggle('chat-backboard-working-row', this.useBackboardTimelinePresentation);
		if (!isComplete) {
			this.domNode.setAttribute('role', 'status');
			this.domNode.setAttribute('aria-live', 'polite');
			this.domNode.setAttribute('aria-atomic', 'true');
		}

		// Structure: .progress-container > .rendered-markdown.progress-step.chat-working-progress-step > p (shimmered label) + span (stats, no shimmer)
		const messageContainer = $('div.rendered-markdown.progress-step.chat-working-progress-step');
		this.labelElement = $('p');
		this.statsElement = $('span');
		append(messageContainer, this.labelElement);
		append(messageContainer, this.statsElement);
		append(this.domNode, messageContainer);

		if (!isComplete && !this.useBackboardTimelinePresentation && !this.useCursorTranscriptPresentation) {
			this.domNode.classList.add('shimmer-progress');
		}

		if (state) {
			this.initializeWithState(state);
		} else {
			// No state provided - show explicit content or label
			this.labelElement.textContent = this.explicitContent
				? renderAsPlaintext(this.explicitContent)
				: this.label;
		}

		this._register(languageModelToolsService.onDidPrepareToolCallBecomeUnresponsive(e => {
			if (isEqual(context.element.sessionResource, e.sessionResource)) {
				this.updateWorkingContent(new MarkdownString(localize('toolCallUnresponsive', "Waiting for tool '{0}' to respond...", e.toolData.displayName)));
			}
		}));
	}

	private initializeWithState(state: IChatWorkingProgressState): void {
		if (state.isComplete) {
			// Past tense: show final elapsed time and tokens
			this.renderCompletedProgress(state);
		} else {
			// Active: start timer and observe tokens
			this.startLiveProgress(state);
		}
	}

	private renderCompletedProgress(state: IChatWorkingProgressState): void {
		// Stats are intentionally hidden in the minimal shipping version.
	}

	private startLiveProgress(state: IChatWorkingProgressState): void {
		// If explicit content was set (e.g., tool unresponsive), show that and let it
		// stand — the elapsed-time label is only meaningful for the plain working state.
		if (this.explicitContent) {
			return;
		}

		// Live status ticker. The start timestamp is confirmation-adjusted and can
		// move, so it is re-read each tick rather than captured once. The label
		// steps through startup stages and then rotates through the phrase pool;
		// the elapsed time ticks alongside in the secondary stats span.
		const tick = () => {
			const elapsedMs = Math.max(0, Date.now() - state.confirmationAdjustedTimestamp.get());
			if (this.useCursorTranscriptPresentation) {
				this.setWorkingLabel(localize('chat.cursorPlanningNextMoves', "Planning next moves"));
				this.statsElement.textContent = '';
				return;
			}
			this.setWorkingLabel(this.useBackboardTimelinePresentation
				? localize('chat.backboardWorking', "Working")
				: this.computeLiveLabel(elapsedMs));
			this.statsElement.textContent = '';
		};
		tick();
		this.workingTimer.value = disposableWindowInterval(getWindow(this.domNode), tick, 1000);
	}

	private computeLiveLabel(elapsedMs: number): string {
		const hasResponseContent = this.responseElement ? this.responseElement.response.value.length > 0 : true;
		return computeLiveWorkingLabel(this.elementId, hasResponseContent, elapsedMs, this.configurationService);
	}

	private setWorkingLabel(label: string): void {
		if (this.labelElement.textContent === label) {
			return;
		}
		this.labelElement.textContent = label;
		if (!getWindow(this.domNode).matchMedia('(prefers-reduced-motion: reduce)').matches) {
			this.labelElement.animate?.(
				[{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }],
				{ duration: 220, easing: 'ease-out' }
			);
		}
	}

	updateWorkingContent(content: IMarkdownString): void {
		// An explicit message (e.g. a tool going unresponsive) supersedes the timer.
		this.workingTimer.clear();
		this.explicitContent = content;
		this.labelElement.textContent = renderAsPlaintext(content);
		this.statsElement.textContent = '';
	}

	hasSameContent(other: IChatRendererContent, followingContent: IChatRendererContent[], element: ChatTreeItem): boolean {
		if (other.kind !== 'working') {
			return false;
		}
		if (!!other.state !== this.hasState) {
			return false;
		}
		// Re-render when completion state changes (in-progress to complete)
		if ((other.state?.isComplete ?? false) !== this.isCompleteState) {
			return false;
		}
		return other.content?.value === this.explicitContent?.value;
	}
}
