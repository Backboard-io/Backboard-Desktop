/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { $, AnimationFrameScheduler, DisposableResizeObserver } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { toErrorMessage } from '../../../../../../base/common/errorMessage.js';
import { Lazy } from '../../../../../../base/common/lazy.js';
import { IRenderedMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { rcut } from '../../../../../../base/common/strings.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { buildSubagentSessionUri, parseSubagentSessionUri } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IChatHookPart, IChatMarkdownContent, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../common/chatService/chatService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { IRunSubagentToolInputParams } from '../../../common/tools/builtinTools/runSubagentTool.js';
import { openChatResource } from '../../agentSessions/agentSessionsOpener.js';
import { ChatTreeItem, ChatViewPaneTarget, IChatWidgetService } from '../../chat.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { ChatCollapsibleMarkdownContentPart } from './chatCollapsibleMarkdownContentPart.js';
import { EditorPool } from './chatContentCodePools.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { renderFileWidgets } from './chatInlineAnchorWidget.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { CollapsibleListPool } from './chatReferencesContentPart.js';
import { buildPhrasePool, createThinkingIcon, getToolInvocationIcon } from './chatThinkingContentPart.js';
import { ChatToolInvocationPart } from './toolInvocationParts/chatToolInvocationPart.js';
import './media/chatSubagentContent.css';

const MAX_TITLE_LENGTH = 100;

const subagentWorkingMessages = [
	localize('chat.subagent.working.1', 'Processing'),
	localize('chat.subagent.working.2', 'Preparing'),
	localize('chat.subagent.working.3', 'Loading'),
	localize('chat.subagent.working.4', 'Analyzing'),
	localize('chat.subagent.working.5', 'Evaluating'),
];

function localizedWorkerStatus(status: 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled' | 'Integrating' | 'Integrated' | 'Conflict'): string {
	switch (status) {
		case 'Queued': return localize('chat.subagent.statusQueued', 'Queued');
		case 'Running': return localize('chat.subagent.statusRunning', 'Running');
		case 'Completed': return localize('chat.subagent.statusCompleted', 'Completed');
		case 'Failed': return localize('chat.subagent.statusFailed', 'Failed');
		case 'Cancelled': return localize('chat.subagent.statusCancelled', 'Cancelled');
		case 'Integrating': return localize('chat.subagent.statusIntegrating', 'Integrating');
		case 'Integrated': return localize('chat.subagent.statusIntegrated', 'Integrated');
		case 'Conflict': return localize('chat.subagent.statusConflict', 'Conflict');
	}
}

/**
 * Represents a lazy tool item that will be created when the subagent section is expanded.
 */
interface ILazyToolItem {
	kind: 'tool';
	lazy: Lazy<ChatToolInvocationPart>;
	toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized;
	codeBlockStartIndex: number;
}

/**
 * Represents a lazy markdown item (e.g., edit pill) that will be rendered when expanded.
 */
interface ILazyMarkdownItem {
	kind: 'markdown';
	lazy: Lazy<{ domNode: HTMLElement; disposable?: IDisposable }>;
	/**
	 * True when the caller passed an eagerDisposable that has already been registered on this
	 * subagent part. In that case, materializeLazyItem must not register the factory's returned
	 * disposable again.
	 */
	eagerlyRegistered?: boolean;
}

/**
 * Represents a lazy hook item (blocked/warning) that will be rendered when expanded.
 */
interface ILazyHookItem {
	kind: 'hook';
	lazy: Lazy<{ domNode: HTMLElement; disposable?: IDisposable }>;
	hookPart: IChatHookPart;
}

type ILazyItem = ILazyToolItem | ILazyMarkdownItem | ILazyHookItem;

/**
 * This is generally copied from ChatThinkingContentPart. We are still experimenting with both UIs so I'm not
 * trying to refactor to share code. Both could probably be simplified when stable.
 */
export class ChatSubagentContentPart extends ChatCollapsibleContentPart implements IChatContentPart {
	private wrapper!: HTMLElement;
	private isActive: boolean = true;
	private hasToolItems: boolean = false;
	private readonly isInitiallyComplete: boolean;
	private promptContainer: HTMLElement | undefined;
	private resultContainer: HTMLElement | undefined;
	private lastItemWrapper: HTMLElement | undefined;
	private readonly layoutScheduler: AnimationFrameScheduler;
	private description: string;
	private agentName: string | undefined;
	private prompt: string | undefined;

	// Lazy rendering support
	private readonly lazyItems: ILazyItem[] = [];
	private hasExpandedOnce: boolean = false;
	private pendingPromptRender: boolean = false;
	private pendingResultText: string | undefined;

	// Current tool message for collapsed title (persists even after tool completes)
	private currentRunningToolMessage: string | undefined;

	// Model name used by this subagent for hover tooltip
	private modelName: string | undefined;
	private _isDefaultDescription: boolean;
	private readonly _hoverDisposable = this._register(new MutableDisposable());
	private openButton: HTMLButtonElement | undefined;
	private openButtonLabel: HTMLElement | undefined;
	private isOpeningChat: boolean = false;
	private collapseButtonAriaLabel: string | undefined;
	private workerMetadataContainer: HTMLElement | undefined;

	// Confirmation auto-expand tracking
	private toolsWaitingForConfirmation: number = 0;
	private userManuallyExpanded: boolean = false;
	private autoExpandedForConfirmation: boolean = false;

	// Carousel confirmation placeholder
	private _navigateToCarousel: ((subAgentInvocationId: string) => void) | undefined;
	private _addToolToCarousel: ((tool: IChatToolInvocation) => void) | undefined;
	private _shouldUseCarouselForTool: ((tool: IChatToolInvocation, state: IChatToolInvocation.State) => boolean) | undefined;
	private _confirmationPlaceholder: HTMLElement | undefined;
	private _confirmationPlaceholderLabel: HTMLElement | undefined;
	private readonly _confirmationPlaceholderDisposable = this._register(new MutableDisposable());
	private _useCarouselForConfirmations: boolean = false;
	private toolsWaitingForCarouselConfirmation: number = 0;

	// Working spinner elements for expanded state
	private workingSpinnerElement: HTMLElement | undefined;
	private workingSpinnerLabel: HTMLElement | undefined;
	private availableMessages: string[] | undefined;

	private readonly _titleDetailRendered = this._register(new MutableDisposable<IRenderedMarkdown>());

	/**
	 * Check if a tool invocation is the parent subagent tool (the tool that spawns a subagent).
	 * A parent subagent tool has subagent toolSpecificData but no subAgentInvocationId.
	 */
	private static isParentSubagentTool(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): boolean {
		return toolInvocation.toolSpecificData?.kind === 'subagent' && !toolInvocation.subAgentInvocationId;
	}

	/**
	 * Extracts subagent info (description, agentName, prompt) from a tool invocation.
	 */
	private static extractSubagentInfo(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): { description: string; isDefaultDescription: boolean; agentName: string | undefined; prompt: string | undefined; modelName: string | undefined } {
		const defaultDescription = localize('chat.subagent.defaultDescription', 'Running subagent');

		// Only parent subagent tools contain the full subagent info
		if (!ChatSubagentContentPart.isParentSubagentTool(toolInvocation)) {
			return { description: defaultDescription, isDefaultDescription: true, agentName: undefined, prompt: undefined, modelName: undefined };
		}

		// Check toolSpecificData first (works for both live and serialized)
		if (toolInvocation.toolSpecificData?.kind === 'subagent') {
			const hasDescription = !!toolInvocation.toolSpecificData.description;
			return {
				description: toolInvocation.toolSpecificData.description ?? defaultDescription,
				isDefaultDescription: !hasDescription,
				agentName: toolInvocation.toolSpecificData.agentName,
				prompt: toolInvocation.toolSpecificData.prompt,
				modelName: toolInvocation.toolSpecificData.modelName,
			};
		}

		// Fallback to parameters for live invocations
		if (toolInvocation.kind === 'toolInvocation') {
			const state = toolInvocation.state.get();
			const params = state.type !== IChatToolInvocation.StateKind.Streaming ?
				state.parameters as IRunSubagentToolInputParams | undefined
				: undefined;
			const hasDescription = !!params?.description;
			return {
				description: params?.description ?? defaultDescription,
				isDefaultDescription: !hasDescription,
				agentName: params?.agentName,
				prompt: params?.prompt,
				modelName: undefined,
			};
		}

		return { description: defaultDescription, isDefaultDescription: true, agentName: undefined, prompt: undefined, modelName: undefined };
	}

	constructor(
		public readonly subAgentInvocationId: string,
		private readonly toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		private readonly context: IChatContentPartRenderContext,
		private readonly chatContentMarkdownRenderer: IMarkdownRenderer,
		private readonly listPool: CollapsibleListPool,
		private readonly editorPool: EditorPool,
		private readonly currentWidthDelegate: () => number,
		private readonly announcedToolProgressKeys: Set<string>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		// Extract description, agentName, and prompt from toolInvocation
		const { description, isDefaultDescription, agentName, prompt, modelName } = ChatSubagentContentPart.extractSubagentInfo(toolInvocation);

		// T3 presents a subagent as an anchored workflow row instead of another
		// thinking fold. Keep Backboard's expandable details, while using the same
		// lifecycle lead and keeping both agent and model visible in the row.
		const rawPrefix = agentName || localize('chat.subagent.prefix', 'Subagent');
		const prefix = rawPrefix.charAt(0).toUpperCase() + rawPrefix.slice(1);
		const initialLead = context.element.isComplete
			? localize('chat.subagent.statusCompleted', 'Completed')
			: localize('chat.subagent.statusRunning', 'Running');
		const initialTitle = `${initialLead} · ${prefix}: ${description}`;
		super(initialTitle, context, undefined, hoverService, configurationService);

		this.description = rcut(description, MAX_TITLE_LENGTH);
		this._isDefaultDescription = isDefaultDescription;
		this.agentName = agentName;
		this.prompt = prompt;
		this.modelName = modelName;
		this.isInitiallyComplete = this.element.isComplete;

		const node = this.domNode;
		node.classList.add('chat-thinking-box', 'chat-thinking-fixed-mode', 'chat-subagent-part');

		if (!this.element.isComplete) {
			node.classList.add('chat-thinking-active');
		}
		this.installOpenButton();
		this.renderWorkerMetadata();

		// Replace the base label with the stable worker-row anatomy immediately.
		// The disclosure owns task/status/details; the adjacent action only opens
		// the child chat, so the two interactions remain distinct.
		this.updateTitle();

		// Note: wrapper is created lazily in initContent(), so we can't set its style here

		if (this._collapseButton && !this.element.isComplete) {
			this._collapseButton.icon = Codicon.circleFilled;
		}

		this._register(autorun(r => {
			this.expanded.read(r);
			if (this._collapseButton) {
				if (!this.element.isComplete && this.isActive) {
					this._collapseButton.icon = Codicon.circleFilled;
				} else {
					this._collapseButton.icon = Codicon.check;
				}
				// The base collapsible restores its constructor-time label whenever
				// expansion changes. Re-apply the live worker label so a completed or
				// late-renamed worker is not announced with stale status/task text.
				this.updateCollapseButtonAria();
			}
		}));

		// Materialize lazy items when first expanded
		this._register(autorun(r => {
			if (this._isExpanded.read(r) && !this.hasExpandedOnce) {
				this.hasExpandedOnce = true;
				this.materializePendingContent();
			}
		}));

		// Start collapsed - fixed scrolling mode shows limited height when collapsed
		this.setExpanded(false);

		// Track user manual expansion
		// If the user expands (not via auto-expand for confirmation), mark it as manual
		// Only clear autoExpandedForConfirmation when user collapses, so re-expand is detected as manual
		this._register(autorun(r => {
			const expanded = this._isExpanded.read(r);
			if (expanded) {
				if (!this.autoExpandedForConfirmation) {
					this.userManuallyExpanded = true;
				}
			} else {
				// User collapsed - reset flags so next confirmation cycle can auto-collapse again
				if (this.autoExpandedForConfirmation) {
					this.autoExpandedForConfirmation = false;
				}
				// Reset manual expansion flag when user collapses, so future confirmation cycles can auto-collapse
				if (this.userManuallyExpanded) {
					this.userManuallyExpanded = false;
				}
			}
		}));

		// Scheduler for coalescing layout operations
		this.layoutScheduler = this._register(new AnimationFrameScheduler(this.domNode, () => this.performLayout()));

		// Set up hover tooltip with model name if available
		this.updateHover();

		// Render the prompt section at the start if available (must be after wrapper is initialized)
		this.renderPromptSection();

		// Watch for completion and render result
		this.watchToolCompletion(toolInvocation);
	}

	private installOpenButton(): void {
		const header = this._collapseButton?.element.parentElement;
		if (!header) {
			return;
		}
		const label = localize('chat.subagent.openChat', 'Open chat');
		const button = $('button.chat-subagent-open') as HTMLButtonElement;
		button.setAttribute('type', 'button');
		this.openButton = button;
		this.openButtonLabel = $('span.chat-subagent-open-label');
		this.openButtonLabel.textContent = label;
		const arrow = $('span.chat-subagent-open-arrow.codicon.codicon-arrow-right', { 'aria-hidden': 'true' });
		button.append(this.openButtonLabel, arrow);
		this.updateOpenButton();
		header.appendChild(button);

		// In the compact transcript the worker itself is the navigation pill.
		// Capture before the base disclosure listener; confirmations can still
		// reveal their content programmatically when they need attention.
		this._register(dom.addDisposableListener(this._collapseButton!.element, 'click', event => {
			if (!this.domNode.closest('.backboard-clean-chat')) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.openSubagentChat();
		}, true));

		this._register(dom.addDisposableListener(this._collapseButton!.element, 'keydown', event => {
			if (this.domNode.closest('.backboard-clean-chat') && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				event.stopImmediatePropagation();
				void this.openSubagentChat();
			}
		}, true));

		this._register(dom.addDisposableListener(button, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			void this.openSubagentChat();
		}));
	}

	/** Opens this worker's own chat (Codex's inline sentence names are the entry point). */
	public open(): void {
		void this.openSubagentChat();
	}

	private async openSubagentChat(): Promise<void> {
		if (this.isOpeningChat) {
			return;
		}
		this.isOpeningChat = true;
		this.updateOpenButton();

		try {
			const toolSpecificData = this.toolInvocation.toolSpecificData?.kind === 'subagent' ? this.toolInvocation.toolSpecificData : undefined;
			const backendResource = toolSpecificData?.resource ? URI.parse(toolSpecificData.resource) : undefined;
			const backendChild = backendResource ? parseSubagentSessionUri(backendResource) : undefined;
			const toolCallId = backendChild?.toolCallId ?? this.subAgentInvocationId;
			// UI and backend session ids can differ, so keep the UI resource as the
			// source of truth. Unwind an opened child to its UI root before attaching
			// the backend-provided tool id; otherwise a subagent launched from a child
			// follow-up would be nested beneath the currently-open child by mistake.
			let uiParentResource = this.context.element.sessionResource;
			let parsedUiParent: ReturnType<typeof parseSubagentSessionUri>;
			while ((parsedUiParent = parseSubagentSessionUri(uiParentResource))) {
				uiParentResource = parsedUiParent.parentSession;
			}
			const childResource = URI.parse(buildSubagentSessionUri(uiParentResource, toolCallId));

			await this.chatSessionsService.activateChatSessionItemProvider(childResource.scheme);
			const handled = await this.instantiationService.invokeFunction(accessor => openChatResource(
				accessor,
				this.context.element.sessionResource,
				childResource,
				{
					editorOptions: { preserveFocus: false },
					chatResourceContext: {
						title: this.description,
						agentName: toolSpecificData?.agentName,
						status: this.getWorkerStatusPresentation().label,
					},
				},
			));
			if (handled) {
				return;
			}
			const widget = await this.chatWidgetService.openSession(childResource, ChatViewPaneTarget, {
				revealIfOpened: true,
				title: { preferred: this.description },
			});
			if (!widget) {
				throw new Error(localize('chat.subagent.openUnavailable', 'No chat view is available for this subagent.'));
			}
		} catch (error) {
			this.notificationService.error(localize('chat.subagent.openFailed', 'Failed to open subagent chat: {0}', toErrorMessage(error)));
		} finally {
			this.isOpeningChat = false;
			this.updateOpenButton();
		}
	}

	private updateOpenButton(): void {
		if (!this.openButton || !this.openButtonLabel) {
			return;
		}
		this.openButton.disabled = this.isOpeningChat;
		this.openButton.ariaBusy = String(this.isOpeningChat);
		this.openButtonLabel.textContent = this.isOpeningChat
			? localize('chat.subagent.openingChat', 'Opening…')
			: localize('chat.subagent.openChat', 'Open chat');
		this.openButton.ariaLabel = this.isOpeningChat
			? localize('chat.subagent.openingAriaLabel', 'Opening subagent chat: {0}', this.description)
			: this.isActive
				? localize('chat.subagent.openWorkingAriaLabel', 'Open working subagent chat: {0}', this.description)
				: localize('chat.subagent.openFinishedAriaLabel', 'Open finished subagent chat: {0}', this.description);
	}

	private renderWorkerMetadata(): void {
		const data = this.toolInvocation.toolSpecificData?.kind === 'subagent'
			? this.toolInvocation.toolSpecificData
			: undefined;
		if (!data?.workerId) {
			this.workerMetadataContainer?.remove();
			this.workerMetadataContainer = undefined;
			this.refreshVisibleWorkerStatus();
			return;
		}
		const container = this.workerMetadataContainer ?? $('.chat-subagent-worker-metadata');
		container.textContent = '';
		container.classList.toggle('chat-subagent-worker-conflict', data.workerStatus === 'Conflict');
		container.classList.toggle('chat-subagent-worker-failed', data.workerStatus === 'Failed' || data.workerStatus === 'Cancelled');

		const items: Array<{ label: string; title?: string; className?: string }> = [];
		if (data.workerStatus) {
			items.push({ label: localizedWorkerStatus(data.workerStatus), className: 'chat-subagent-worker-status' });
		}
		// Branches, worktree paths, and integration commit ids are implementation
		// details. Keeping them out of the transcript prevents an isolated worker
		// checkout from looking like a project the user should open or manage.
		if (data.changedFileCount !== undefined) {
			items.push({
				label: data.changedFileCount === 1
					? localize('chat.subagent.workerChangedFile', '1 changed file')
					: localize('chat.subagent.workerChangedFiles', '{0} changed files', data.changedFileCount),
			});
		}
		if (data.conflictingFiles?.length) {
			items.push({
				label: localize('chat.subagent.workerConflicts', 'Conflicts: {0}', data.conflictingFiles.join(', ')),
				title: data.conflictingFiles.join('\n'),
				className: 'chat-subagent-worker-conflicts',
			});
		}
		for (const item of items) {
			const element = $('span.chat-subagent-worker-metadata-item');
			if (item.className) {
				element.classList.add(item.className);
			}
			element.textContent = item.label;
			if (item.title) {
				element.title = item.title;
			}
			container.appendChild(element);
		}
		if (!this.workerMetadataContainer) {
			this.workerMetadataContainer = container;
			this.domNode.insertBefore(container, this.domNode.children[1] ?? null);
		}
		this.refreshVisibleWorkerStatus();
	}

	private getRandomWorkingMessage(): string {
		if (!this.availableMessages || this.availableMessages.length === 0) {
			this.availableMessages = buildPhrasePool(subagentWorkingMessages, this.configurationService);
		}
		const index = Math.floor(Math.random() * this.availableMessages.length);
		return this.availableMessages.splice(index, 1)[0];
	}

	private createWorkingSpinner(): void {
		if (this.workingSpinnerElement || !this.wrapper) {
			return;
		}
		this.workingSpinnerElement = $('.chat-thinking-item.chat-thinking-spinner-item');
		const spinnerIcon = createThinkingIcon(Codicon.circleFilled);
		this.workingSpinnerElement.appendChild(spinnerIcon);
		this.workingSpinnerLabel = $('span.chat-thinking-spinner-label');
		this.workingSpinnerLabel.textContent = this.getRandomWorkingMessage();
		this.workingSpinnerElement.appendChild(this.workingSpinnerLabel);
		this.wrapper.appendChild(this.workingSpinnerElement);
	}

	private removeWorkingSpinner(): void {
		if (this.workingSpinnerElement) {
			this.workingSpinnerElement.remove();
			this.workingSpinnerElement = undefined;
			this.workingSpinnerLabel = undefined;
		}
	}

	private showWorkingSpinner(): void {
		if (this.workingSpinnerElement) {
			this.workingSpinnerElement.style.display = '';
		} else {
			this.createWorkingSpinner();
		}
	}

	protected override initContent(): HTMLElement {
		this.wrapper = $('.chat-used-context-list.chat-thinking-collapsible');

		// Hide initially until there are tool calls
		if (!this.hasToolItems) {
			this.wrapper.style.display = 'none';
		}

		// Materialize any deferred content now that wrapper exists
		// This handles the case where the subclass autorun ran before this base class autorun
		this.materializePendingContent();
		if (this.isActive && !this.isInitiallyComplete && !this.hasToolsWaitingForConfirmation) {
			this.showWorkingSpinner();
		}

		// Use ResizeObserver to trigger layout when wrapper content changes
		const resizeObserver = this._register(new DisposableResizeObserver('ChatSubagentContentPart.layout', () => this.layoutScheduler.schedule()));
		this._register(resizeObserver.observe(this.wrapper));

		return this.wrapper;
	}

	/**
	 * Renders the prompt as a collapsible section at the start of the content.
	 * If the wrapper doesn't exist yet (lazy init) or subagent is initially complete,
	 * this is deferred until expanded.
	 */
	private renderPromptSection(): void {
		if (!this.prompt || this.promptContainer) {
			return;
		}

		// Defer rendering when wrapper doesn't exist yet (lazy init) or for old completed subagents until expanded
		if (!this.wrapper || (this.isInitiallyComplete && !this.isExpanded() && !this.hasExpandedOnce)) {
			this.pendingPromptRender = true;
			return;
		}

		this.pendingPromptRender = false;
		this.doRenderPromptSection();
	}

	private doRenderPromptSection(): void {
		if (!this.prompt || this.promptContainer) {
			return;
		}

		// Split into first line and rest
		const lines = this.prompt.split('\n');
		const rawFirstLine = lines[0] || localize('chat.subagent.prompt', 'Prompt');
		const restOfLines = lines.slice(1).join('\n').trim();

		// Limit first line length, moving overflow to content
		const titleContent = rcut(rawFirstLine, MAX_TITLE_LENGTH);
		const wasTruncated = rawFirstLine.length > MAX_TITLE_LENGTH;
		const title = wasTruncated ? titleContent + '…' : titleContent;
		const titleRemainder = rawFirstLine.length > titleContent.length ? rawFirstLine.slice(titleContent.length).trim() : '';
		const content = titleRemainder
			? (titleRemainder + (restOfLines ? '\n' + restOfLines : ''))
			: (restOfLines || this.prompt);

		// Create collapsible prompt part
		const collapsiblePart = this._register(this.instantiationService.createInstance(
			ChatCollapsibleMarkdownContentPart,
			title,
			content,
			this.context,
			this.chatContentMarkdownRenderer
		));

		// Wrap in a container for chain of thought line styling
		this.promptContainer = $('.chat-thinking-tool-wrapper.chat-subagent-section');
		const promptIcon = createThinkingIcon(Codicon.comment);
		this.promptContainer.appendChild(promptIcon);
		this.promptContainer.appendChild(collapsiblePart.domNode);

		// Insert at the beginning of the wrapper
		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			if (this.wrapper.firstChild) {
				this.wrapper.insertBefore(this.promptContainer, this.wrapper.firstChild);
			} else {
				dom.append(this.wrapper, this.promptContainer);
			}

			// Show the container if it was hidden (no tool items yet)
			if (this.wrapper.style.display === 'none') {
				this.wrapper.style.display = '';
			}
		}
	}

	public getIsActive(): boolean {
		return this.isActive;
	}

	/**
	 * A detached launcher completing only means its durable handle was returned;
	 * the child remains live until worker lifecycle metadata reaches a terminal
	 * state. Parent-turn finalization must not turn that handle acknowledgement
	 * into a false "Completed" worker row.
	 */
	public shouldRemainActiveAfterParentTurn(): boolean {
		const data = this.toolInvocation.toolSpecificData?.kind === 'subagent'
			? this.toolInvocation.toolSpecificData
			: undefined;
		return data?.detached === true
			&& (!data.workerStatus || data.workerStatus === 'Queued' || data.workerStatus === 'Running' || data.workerStatus === 'Integrating');
	}

	/** Compact lifecycle value consumed by the aggregate worker disclosure. */
	public getWorkerStatusKind(): string {
		return this.getWorkerStatusPresentation().kind;
	}

	public get hasToolsWaitingForConfirmation(): boolean {
		return this.toolsWaitingForConfirmation > 0;
	}

	/** Routes this subagent's initial confirmations to the input carousel. */
	public enableCarouselMode(
		navigateToCarousel: (subAgentInvocationId: string) => void,
		addToolToCarousel: (tool: IChatToolInvocation) => void,
		shouldUseCarouselForTool: (tool: IChatToolInvocation, state: IChatToolInvocation.State) => boolean,
	): void {
		this._useCarouselForConfirmations = true;
		this._navigateToCarousel = navigateToCarousel;
		this._addToolToCarousel = addToolToCarousel;
		this._shouldUseCarouselForTool = shouldUseCarouselForTool;
	}

	public getAgentLabel(): string {
		if (this.agentName) {
			return this.agentName;
		}
		if (!this._isDefaultDescription && this.description) {
			return this.description;
		}
		return localize('chat.subagent.prefix', 'Subagent');
	}

	/** Prefer an explicit display name; do not turn a long delegated prompt into a title. */
	public getSummaryLabel(): string | undefined {
		const name = this.agentName?.trim();
		if (name && !/^(worker|subagent|agent|rlm)$/i.test(name)) {
			return rcut(name, 80);
		}
		const description = this.description.trim();
		if (!this._isDefaultDescription && description.length <= 60 && !/[\r\n]/.test(description)) {
			return description;
		}
		return undefined;
	}

	public markAsInactive(): void {
		if (this.shouldRemainActiveAfterParentTurn()) {
			return;
		}
		this.isActive = false;
		this.domNode.classList.remove('chat-thinking-active');
		if (this._collapseButton) {
			this._collapseButton.icon = Codicon.check;
		}

		this.removeWorkingSpinner();
		this.hideConfirmationPlaceholder();

		if (this._isDefaultDescription) {
			this.description = localize('chat.subagent.completedDefaultDescription', 'Ran subagent');
		}
		this.updateOpenButton();
		this.finalizeTitle();
		// Collapse when done
		this.setExpanded(false);
	}

	public finalizeTitle(): void {
		this.updateTitle();
		if (this._collapseButton) {
			this._collapseButton.icon = Codicon.check;
		}
	}

	private updateTitle(): void {
		this.updateOpenButton();
		const rawName = this.agentName || localize('chat.subagent.prefix', 'Subagent');
		const prefix = rawName.charAt(0).toUpperCase() + rawName.slice(1);
		const status = this.getWorkerStatusPresentation();
		const taskText = `${prefix}: ${this.description}`;
		const toolCallText = this.currentRunningToolMessage && this.isActive ? ` \u2014 ${this.currentRunningToolMessage}` : ``;

		if (!this._collapseButton) {
			return;
		}

		const labelElement = this._collapseButton.labelElement;
		this._titleDetailRendered.clear();
		this._titleFileWidgetStore.clear();
		labelElement.textContent = '';

		const avatar = $('span.chat-subagent-avatar', { 'aria-hidden': 'true' });
		avatar.classList.add('codicon', this.isActive ? 'chat-subagent-avatar-running' : 'codicon-sparkle');
		labelElement.appendChild(avatar);

		const statusSpan = $('span.chat-subagent-row-status');
		statusSpan.classList.add(`chat-subagent-row-status-${status.kind}`);
		statusSpan.dataset.statusKind = status.kind;
		statusSpan.textContent = status.label;
		labelElement.appendChild(statusSpan);

		const taskSpan = this.isActive
			? $('span.chat-thinking-title-shimmer.chat-subagent-task')
			: $('span.chat-thinking-title-detail-text.chat-subagent-task');
		const nameSpan = $('span.chat-subagent-name');
		nameSpan.textContent = prefix;
		const descriptionSpan = $('span.chat-subagent-description');
		descriptionSpan.textContent = `: ${this.description}`;
		taskSpan.append(nameSpan, descriptionSpan);
		labelElement.appendChild(taskSpan);

		if (toolCallText) {
			const result = this.chatContentMarkdownRenderer.render(new MarkdownString(toolCallText));
			result.element.classList.add('collapsible-title-content', 'chat-thinking-title-detail');
			renderFileWidgets(result.element, this.instantiationService, this.chatMarkdownAnchorService, this._titleFileWidgetStore);
			this._titleDetailRendered.value = result;
			labelElement.appendChild(result.element);
		}
		this.appendVisibleModelLabel(labelElement);

		const fullLabel = `${status.label} · ${taskText}${toolCallText}`;
		this.collapseButtonAriaLabel = fullLabel;
		this.updateCollapseButtonAria();
	}

	private updateCollapseButtonAria(): void {
		if (!this._collapseButton || !this.collapseButtonAriaLabel) {
			return;
		}
		this._collapseButton.element.ariaLabel = this.collapseButtonAriaLabel;
		if (this.domNode.closest('.backboard-clean-chat')) {
			this._collapseButton.element.removeAttribute('aria-expanded');
		} else {
			this._collapseButton.element.ariaExpanded = String(this.isExpanded());
		}
	}

	private getWorkerStatusPresentation(): { label: string; kind: string } {
		const data = this.toolInvocation.toolSpecificData?.kind === 'subagent'
			? this.toolInvocation.toolSpecificData
			: undefined;
		const reportedStatus = data?.workerStatus;
		const status = reportedStatus ?? (this.isActive ? 'Running' : 'Completed');
		return { label: localizedWorkerStatus(status), kind: status.toLowerCase() };
	}

	private refreshVisibleWorkerStatus(): void {
		const statusSpan = this._collapseButton?.labelElement.querySelector<HTMLElement>('.chat-subagent-row-status');
		if (!statusSpan) {
			return;
		}
		const status = this.getWorkerStatusPresentation();
		if (statusSpan.dataset.statusKind !== status.kind || statusSpan.textContent !== status.label) {
			this.updateTitle();
		}
	}

	private appendVisibleModelLabel(labelElement: HTMLElement): void {
		labelElement.querySelector('.chat-subagent-model')?.remove();
		if (!this.modelName) {
			return;
		}
		const model = $('span.chat-subagent-model');
		model.textContent = `· ${this.modelName}`;
		labelElement.appendChild(model);
	}

	private updateHover(): void {
		if (!this.modelName || !this._collapseButton) {
			return;
		}

		this._hoverDisposable.value = this.hoverService.setupDelayedHover(this._collapseButton.element, {
			content: localize('chat.subagent.modelTooltip', 'Model: {0}', this.modelName),
		});
	}

	/**
	 * Tracks a tool invocation's state for:
	 * 1. Updating the title with the current tool message (persists even after completion)
	 * 2. Auto-expanding when a tool is waiting for confirmation
	 * 3. Auto-collapsing when the confirmation is addressed
	 * This method is public to support testing.
	 */
	public trackToolState(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): void {
		// Only track live tool invocations
		if (toolInvocation.kind !== 'toolInvocation') {
			return;
		}

		// Set the title immediately when tool is added - like thinking part does
		const message = toolInvocation.invocationMessage;
		const messageText = typeof message === 'string' ? message : message.value;
		this.currentRunningToolMessage = messageText;
		this.updateTitle();
		const addToolToCarousel = this._addToolToCarousel;
		const shouldUseCarouselForTool = this._shouldUseCarouselForTool;

		let wasWaitingForConfirmation = false;
		let wasWaitingForCarouselConfirmation = false;
		this._register(autorun(r => {
			const state = toolInvocation.state.read(r);

			const isWaitingForConfirmation = state.type === IChatToolInvocation.StateKind.WaitingForConfirmation ||
				state.type === IChatToolInvocation.StateKind.WaitingForPostApproval;
			const isWaitingForCarouselConfirmation = !!addToolToCarousel && shouldUseCarouselForTool?.(toolInvocation, state) === true;

			if (isWaitingForConfirmation && !wasWaitingForConfirmation) {
				this.toolsWaitingForConfirmation++;
				if (!this.isExpanded()) {
					this.autoExpandedForConfirmation = true;
					this.setExpanded(true);
				}
				// Remove the working spinner while confirmation is shown
				this.removeWorkingSpinner();
			} else if (!isWaitingForConfirmation && wasWaitingForConfirmation) {
				this.toolsWaitingForConfirmation--;
				if (this.toolsWaitingForConfirmation === 0 && this.autoExpandedForConfirmation && !this.userManuallyExpanded) {
					// Auto-collapse only if we auto-expanded and user didn't manually expand
					this.autoExpandedForConfirmation = false;
					this.setExpanded(false);
				}
				// Show the working spinner again if still active and no more confirmations
				if (this.toolsWaitingForConfirmation === 0 && this.isActive) {
					this.showWorkingSpinner();
				}
			}

			if (isWaitingForCarouselConfirmation && !wasWaitingForCarouselConfirmation) {
				this.toolsWaitingForCarouselConfirmation++;
				addToolToCarousel(toolInvocation);
				this.showConfirmationPlaceholder();
			} else if (!isWaitingForCarouselConfirmation && wasWaitingForCarouselConfirmation) {
				this.toolsWaitingForCarouselConfirmation--;
				if (this.toolsWaitingForCarouselConfirmation === 0) {
					this.hideConfirmationPlaceholder();
				} else {
					this.updateConfirmationPlaceholderLabel();
				}
			}

			wasWaitingForConfirmation = isWaitingForConfirmation;
			wasWaitingForCarouselConfirmation = isWaitingForCarouselConfirmation;
		}));
	}

	private getConfirmationPlaceholderText(): string {
		const count = this.toolsWaitingForCarouselConfirmation;
		return count === 1
			? localize('chat.subagent.pendingConfirmation', '1 pending confirmation')
			: localize('chat.subagent.pendingConfirmations', '{0} pending confirmations', count);
	}

	private updateConfirmationPlaceholderLabel(): void {
		if (this._confirmationPlaceholderLabel) {
			this._confirmationPlaceholderLabel.textContent = this.getConfirmationPlaceholderText();
		}
	}

	/** Shows a placeholder that jumps back to the carousel. */
	private showConfirmationPlaceholder(): void {
		if (this._confirmationPlaceholder) {
			this.updateConfirmationPlaceholderLabel();
			return;
		}

		const placeholder = $('button.chat-subagent-confirmation-placeholder');
		const label = $('span.chat-subagent-placeholder-label');
		label.textContent = this.getConfirmationPlaceholderText();
		placeholder.appendChild(label);

		this._confirmationPlaceholder = placeholder;
		this._confirmationPlaceholderLabel = label;

		const placeholderDisposables = new DisposableStore();
		placeholderDisposables.add(dom.addDisposableListener(placeholder, 'click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._navigateToCarousel?.(this.subAgentInvocationId);
		}));
		this._confirmationPlaceholderDisposable.value = placeholderDisposables;

		if (!this.hasToolItems) {
			this.hasToolItems = true;
			if (this.wrapper) {
				this.wrapper.style.display = '';
			}
		}

		if (!this.isExpanded()) {
			this.autoExpandedForConfirmation = true;
			this.setExpanded(true);
		}

		if (this.wrapper) {
			this.wrapper.appendChild(placeholder);
		}
		this.layoutScheduler.schedule();
	}

	private hideConfirmationPlaceholder(): void {
		if (this._confirmationPlaceholder) {
			this._confirmationPlaceholder.remove();
			this._confirmationPlaceholder = undefined;
			this._confirmationPlaceholderLabel = undefined;
			this._confirmationPlaceholderDisposable.clear();
			this.layoutScheduler.schedule();
		}
	}

	/** Keeps the carousel placeholder after visible tool output. */
	private ensurePlaceholderAtBottom(): void {
		if (this._confirmationPlaceholder?.parentElement === this.wrapper) {
			this.wrapper.appendChild(this._confirmationPlaceholder);
		}
	}

	/**
	 * Watches the tool invocation for completion and renders the result.
	 * Handles both live and serialized invocations.
	 */
	private watchToolCompletion(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): void {
		// Only watch parent subagent tools for completion
		if (!ChatSubagentContentPart.isParentSubagentTool(toolInvocation)) {
			return;
		}

		if (toolInvocation.kind === 'toolInvocation') {
			// Watch for completion and render the result
			let wasStreaming = toolInvocation.state.get().type === IChatToolInvocation.StateKind.Streaming;
			this._register(autorun(r => {
				const state = toolInvocation.state.read(r);
				if (state.type === IChatToolInvocation.StateKind.Completed) {
					wasStreaming = false;
					// Extract text from result
					const textParts = (state.contentForModel || [])
						.filter((part): part is { kind: 'text'; value: string } => part.kind === 'text')
						.map(part => part.value);

					if (textParts.length > 0 && !this.shouldRemainActiveAfterParentTurn()) {
						this.renderResultText(textParts.join('\n'));
					}

					// Update description and model name from toolSpecificData (set during invoke())
					if (toolInvocation.toolSpecificData?.kind === 'subagent') {
						if (toolInvocation.toolSpecificData.agentName) {
							this.agentName = toolInvocation.toolSpecificData.agentName;
						}
						if (toolInvocation.toolSpecificData.description) {
							this.description = toolInvocation.toolSpecificData.description;
							this._isDefaultDescription = false;
						}
						if (toolInvocation.toolSpecificData.modelName) {
							this.modelName = toolInvocation.toolSpecificData.modelName;
							this.updateHover();
						}
					}
					this.renderWorkerMetadata();

					// AgentSpawn returns a handle immediately. Its parent invocation is
					// complete, but only child lifecycle status can finish the worker.
					if (!this.shouldRemainActiveAfterParentTurn()) {
						this.markAsInactive();
					} else {
						this.isActive = true;
						this.domNode.classList.add('chat-thinking-active');
						this.updateTitle();
					}
				} else if (wasStreaming && state.type !== IChatToolInvocation.StateKind.Streaming) {
					wasStreaming = false;
					// Update things that change when tool is done streaming
					const { description, isDefaultDescription, agentName, prompt, modelName } = ChatSubagentContentPart.extractSubagentInfo(toolInvocation);
					this.description = description;
					this._isDefaultDescription = isDefaultDescription;
					this.agentName = agentName;
					this.prompt = prompt;
					if (modelName) {
						this.modelName = modelName;
						this.updateHover();
					}
					this.renderPromptSection();
					this.updateTitle();
					this.renderWorkerMetadata();
				} else if (toolInvocation.toolSpecificData?.kind === 'subagent') {
					// toolSpecificData was updated after initial render (e.g.
					// subagent content arrived via ChatToolCallContentChanged
					// after the part was first constructed in PendingConfirmation).
					// Re-read metadata and update the title if real values are
					// now available that we didn't have before.
					const { description, isDefaultDescription, agentName } = ChatSubagentContentPart.extractSubagentInfo(toolInvocation);
					const descriptionChanged = this._isDefaultDescription && !isDefaultDescription;
					const agentNameChanged = !!agentName && agentName !== this.agentName;
					if (descriptionChanged || agentNameChanged) {
						if (descriptionChanged) {
							this.description = description;
							this._isDefaultDescription = isDefaultDescription;
						}
						if (agentNameChanged) {
							this.agentName = agentName;
						}
						this.updateTitle();
					}
					this.renderWorkerMetadata();
				}
			}));
		} else if (toolInvocation.toolSpecificData?.kind === 'subagent') {
			// Render the persisted result for serialized invocations. Detached
			// handle acknowledgements stay hidden while the child is still live.
			if (!this.shouldRemainActiveAfterParentTurn()) {
				if (toolInvocation.toolSpecificData.result) {
					this.renderResultText(toolInvocation.toolSpecificData.result);
				}
				// Already complete, mark as inactive
				this.markAsInactive();
			}
		}
	}

	/**
	 * Renders the result text as a collapsible section.
	 * If the wrapper doesn't exist yet (lazy init) or subagent is initially complete,
	 * this is deferred until expanded.
	 */
	public renderResultText(resultText: string): void {
		if (this.resultContainer || !resultText) {
			return; // Already rendered or no content
		}

		// Defer rendering when wrapper doesn't exist yet (lazy init) or for old completed subagents until expanded
		if (!this.wrapper || (this.isInitiallyComplete && !this.isExpanded() && !this.hasExpandedOnce)) {
			this.pendingResultText = resultText;
			return;
		}

		this.pendingResultText = undefined;
		this.doRenderResultText(resultText);
	}

	private doRenderResultText(resultText: string): void {
		if (this.resultContainer || !resultText) {
			return;
		}

		// Split into first line and rest
		const lines = resultText.split('\n');
		const rawFirstLine = lines[0] || '';
		const restOfLines = lines.slice(1).join('\n').trim();

		// Limit first line length, moving overflow to content
		const titleContent = rcut(rawFirstLine, MAX_TITLE_LENGTH);
		const wasTruncated = rawFirstLine.length > MAX_TITLE_LENGTH;
		const title = wasTruncated ? titleContent + '…' : titleContent;
		const titleRemainder = rawFirstLine.length > titleContent.length ? rawFirstLine.slice(titleContent.length).trim() : '';
		const content = titleRemainder
			? (titleRemainder + (restOfLines ? '\n' + restOfLines : ''))
			: restOfLines;

		// Create collapsible result part
		const collapsiblePart = this._register(this.instantiationService.createInstance(
			ChatCollapsibleMarkdownContentPart,
			title,
			content,
			this.context,
			this.chatContentMarkdownRenderer
		));

		// Wrap in a container for chain of thought line styling
		this.resultContainer = $('.chat-thinking-tool-wrapper.chat-subagent-section');
		const resultIcon = createThinkingIcon(Codicon.check);
		this.resultContainer.appendChild(resultIcon);
		this.resultContainer.appendChild(collapsiblePart.domNode);

		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			dom.append(this.wrapper, this.resultContainer);

			// Show the container if it was hidden
			if (this.wrapper.style.display === 'none') {
				this.wrapper.style.display = '';
			}
		}
	}

	/**
	 * Appends a tool invocation to the subagent group.
	 * The tool part is created lazily - only when the subagent section is expanded,
	 * unless it's actively streaming (not initially complete), in which case render immediately.
	 */
	public appendToolInvocation(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized, codeBlockStartIndex: number): void {
		// Show the container when first tool item is added
		if (!this.hasToolItems) {
			this.hasToolItems = true;
			// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
			if (this.wrapper) {
				this.wrapper.style.display = '';
			}
		}

		// Track tool state for title updates and auto-expand/collapse on confirmation
		this.trackToolState(toolInvocation);

		// Render immediately only if already expanded or has been expanded before
		if (this.isExpanded() || this.hasExpandedOnce) {
			const part = this.createToolPart(toolInvocation, codeBlockStartIndex);
			this.appendToolPartToDOM(part, toolInvocation);
		} else {
			// Defer rendering until expanded
			const item: ILazyToolItem = {
				kind: 'tool',
				lazy: new Lazy(() => this.createToolPart(toolInvocation, codeBlockStartIndex)),
				toolInvocation,
				codeBlockStartIndex,
			};
			this.lazyItems.push(item);
		}
	}

	/**
	 * Appends a markdown item (e.g., an edit pill) to the subagent content part.
	 * This is used to route codeblockUri parts with subAgentInvocationId to this subagent's container.
	 *
	 * When the caller has already created the content part eagerly (for example, a
	 * pre-built `ChatMarkdownContentPart` wrapped in a factory), the caller MUST pass
	 * that part as `eagerDisposable` so it is registered on this subagent part
	 * immediately. Otherwise, if the subagent section is collapsed and the lazy item
	 * is never materialized, the eagerly-created part would leak.
	 */
	public appendMarkdownItem(
		factory: () => { domNode: HTMLElement; disposable?: IDisposable },
		_codeblocksPartId: string | undefined,
		_markdown: IChatMarkdownContent,
		_originalParent?: HTMLElement,
		eagerDisposable?: IDisposable,
	): void {
		// Register any caller-owned disposable up-front so it is always cleaned up
		// with this subagent part, even if the lazy item is never materialized.
		if (eagerDisposable) {
			this._register(eagerDisposable);
		}

		// If expanded or has been expanded once, render immediately
		if (this.isExpanded() || this.hasExpandedOnce) {
			const result = factory();
			this.appendMarkdownItemToDOM(result.domNode);
			if (result.disposable && result.disposable !== eagerDisposable) {
				this._register(result.disposable);
			}
		} else {
			// Defer rendering until expanded
			const item: ILazyMarkdownItem = {
				kind: 'markdown',
				lazy: new Lazy(factory),
				eagerlyRegistered: !!eagerDisposable,
			};
			this.lazyItems.push(item);
		}
	}

	/**
	 * Appends a hook item (blocked/warning) to the subagent content part.
	 */
	public appendHookItem(
		factory: () => { domNode: HTMLElement; disposable?: IDisposable },
		hookPart: IChatHookPart
	): void {
		// update title with hook message
		const hookMessage = hookPart.stopReason
			? (hookPart.toolDisplayName
				? localize('hook.subagent.blocked', 'Blocked {0}', hookPart.toolDisplayName)
				: localize('hook.subagent.blockedGeneric', 'Blocked by hook'))
			: (hookPart.toolDisplayName
				? localize('hook.subagent.warning', 'Warning for {0}', hookPart.toolDisplayName)
				: localize('hook.subagent.warningGeneric', 'Hook warning'));
		this.currentRunningToolMessage = hookMessage;
		this.updateTitle();

		if (this.isExpanded() || this.hasExpandedOnce) {
			const result = factory();
			this.appendHookItemToDOM(result.domNode, hookPart);
			if (result.disposable) {
				this._register(result.disposable);
			}
		} else {
			const item: ILazyHookItem = {
				kind: 'hook',
				lazy: new Lazy(factory),
				hookPart,
			};
			this.lazyItems.push(item);
		}
	}

	/**
	 * Appends a hook item's DOM node to the wrapper.
	 */
	private appendHookItemToDOM(domNode: HTMLElement, hookPart: IChatHookPart): void {
		const itemWrapper = $('.chat-thinking-tool-wrapper');
		const icon = hookPart.stopReason ? Codicon.error : Codicon.warning;
		const iconElement = createThinkingIcon(icon);
		itemWrapper.appendChild(iconElement);
		itemWrapper.appendChild(domNode);

		// Treat hook items as tool items for visibility purposes
		if (!this.hasToolItems) {
			this.hasToolItems = true;
			if (this.wrapper) {
				this.wrapper.style.display = '';
			}
		}

		if (this.wrapper) {
			if (this.resultContainer) {
				this.wrapper.insertBefore(itemWrapper, this.resultContainer);
			} else {
				this.wrapper.appendChild(itemWrapper);
			}
		}
		this.lastItemWrapper = itemWrapper;
		this.layoutScheduler.schedule();
	}

	/**
	 * Appends a markdown item's DOM node to the wrapper.
	 */
	private appendMarkdownItemToDOM(domNode: HTMLElement): void {
		if (!domNode.hasChildNodes() || domNode.textContent?.trim() === '') {
			return;
		}

		// Wrap with icon like other items
		const itemWrapper = $('.chat-thinking-tool-wrapper');
		const iconElement = createThinkingIcon(Codicon.edit);
		itemWrapper.appendChild(domNode);
		itemWrapper.insertBefore(iconElement, itemWrapper.firstChild);

		// Insert before result container if it exists, otherwise append
		if (this.wrapper) {
			if (this.resultContainer) {
				this.wrapper.insertBefore(itemWrapper, this.resultContainer);
			} else {
				this.wrapper.appendChild(itemWrapper);
			}
		}
		this.lastItemWrapper = itemWrapper;

		// Schedule layout to measure last item and scroll
		this.layoutScheduler.schedule();
	}

	protected override shouldInitEarly(): boolean {
		// Never init early - subagent is collapsed while running, content only shown on expand
		return false;
	}

	/**
	 * Creates a ChatToolInvocationPart for the given tool invocation.
	 */
	private createToolPart(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized, codeBlockStartIndex: number): ChatToolInvocationPart {
		const part = this.instantiationService.createInstance(
			ChatToolInvocationPart,
			toolInvocation,
			this.context,
			this.chatContentMarkdownRenderer,
			this.listPool,
			this.editorPool,
			this.currentWidthDelegate,
			this.announcedToolProgressKeys,
			codeBlockStartIndex
		);

		this._register(part);
		return part;
	}

	/**
	 * Appends a tool part's DOM node to the wrapper with appropriate icon wrapper.
	 */
	private appendToolPartToDOM(part: ChatToolInvocationPart, toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized): void {
		const content = part.domNode;
		if (!content.hasChildNodes() || content.textContent?.trim() === '') {
			return;
		}

		// Wrap with icon like thinking parts do
		const itemWrapper = $('.chat-thinking-tool-wrapper');
		const icon = getToolInvocationIcon(toolInvocation.toolId, toolInvocation.icon);
		const iconElement = createThinkingIcon(icon);
		itemWrapper.appendChild(content);

		// Dynamically add/remove icon based on confirmation state
		if (toolInvocation.kind === 'toolInvocation') {
			const shouldUseCarouselForTool = this._shouldUseCarouselForTool;
			this._register(autorun(r => {
				const state = toolInvocation.state.read(r);
				const hasConfirmation = state.type === IChatToolInvocation.StateKind.WaitingForConfirmation ||
					state.type === IChatToolInvocation.StateKind.WaitingForPostApproval;
				const shouldHideInline = shouldUseCarouselForTool?.(toolInvocation, state) === true;
				if (hasConfirmation) {
					iconElement.remove();
					if (shouldHideInline) {
						itemWrapper.style.display = 'none';
					} else {
						itemWrapper.style.display = '';
					}
				} else {
					if (!iconElement.parentElement) {
						itemWrapper.insertBefore(iconElement, itemWrapper.firstChild);
					}
					if (this._useCarouselForConfirmations) {
						itemWrapper.style.display = '';
						// Re-position the confirmation placeholder to stay at the bottom
						this.ensurePlaceholderAtBottom();
					}
				}
			}));
		} else {
			// For serialized invocations, always show icon (already completed)
			itemWrapper.insertBefore(iconElement, itemWrapper.firstChild);
		}

		// Keep newly-visible tool results above the placeholder/spinner.
		if (this.wrapper) {
			const anchor = this._confirmationPlaceholder ?? this.workingSpinnerElement ?? this.resultContainer;
			if (anchor) {
				this.wrapper.insertBefore(itemWrapper, anchor);
			} else {
				this.wrapper.appendChild(itemWrapper);
			}
		}
		this.lastItemWrapper = itemWrapper;

		// Schedule layout to measure last item and scroll
		this.layoutScheduler.schedule();
	}

	/**
	 * Materializes a lazy item by creating the content and adding it to the DOM.
	 */
	private materializeLazyItem(item: ILazyItem): void {
		if (item.lazy.hasValue) {
			return; // Already materialized
		}

		if (item.kind === 'tool') {
			const part = item.lazy.value;
			this.appendToolPartToDOM(part, item.toolInvocation);
		} else if (item.kind === 'markdown') {
			const result = item.lazy.value;
			this.appendMarkdownItemToDOM(result.domNode);
			if (result.disposable && !item.eagerlyRegistered) {
				this._register(result.disposable);
			}
		} else if (item.kind === 'hook') {
			const result = item.lazy.value;
			this.appendHookItemToDOM(result.domNode, item.hookPart);
			if (result.disposable) {
				this._register(result.disposable);
			}
		}
	}

	/**
	 * Materializes all pending lazy content (prompt, tool items, result) when the section is expanded.
	 * This is called when first expanded, but the wrapper must exist (created by base class initContent).
	 */
	private materializePendingContent(): void {
		// Wrapper may not be created yet if this autorun runs before the base class autorun
		// that calls initContent(). In that case, initContent() will call this logic.
		if (!this.wrapper) {
			return;
		}

		// Render pending prompt section
		if (this.pendingPromptRender) {
			this.pendingPromptRender = false;
			this.doRenderPromptSection();
		}

		// Materialize lazy tool items
		for (const item of this.lazyItems) {
			this.materializeLazyItem(item);
		}

		// Render pending result text
		if (this.pendingResultText) {
			const resultText = this.pendingResultText;
			this.pendingResultText = undefined;
			this.doRenderResultText(resultText);
		}
	}

	private performLayout(): void {
		// Measure last item height once after layout, set CSS variable for collapsed max-height
		if (this.lastItemWrapper && this.wrapper) {
			const height = this.lastItemWrapper.offsetHeight;
			if (height > 0) {
				this.wrapper.style.setProperty('--chat-subagent-last-item-height', `${height}px`);
			}
		}

		// Auto-scroll to bottom only when actively streaming (not for completed responses)
		if (this.isActive && !this.isInitiallyComplete && this.wrapper) {
			const scrollHeight = this.wrapper.scrollHeight;
			this.wrapper.scrollTop = scrollHeight;
		}
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind === 'markdownContent') {
			return true;
		}

		// Match hook parts with the same subAgentInvocationId to keep them grouped in the subagent dropdown
		if (other.kind === 'hook' && other.subAgentInvocationId) {
			return this.subAgentInvocationId === other.subAgentInvocationId;
		}

		// Match subagent tool invocations with the same subAgentInvocationId to keep them grouped
		if ((other.kind === 'toolInvocation' || other.kind === 'toolInvocationSerialized') && (other.subAgentInvocationId || ChatSubagentContentPart.isParentSubagentTool(other))) {
			// For parent subagent tool, use toolCallId as the effective ID
			const otherEffectiveId = other.subAgentInvocationId ?? other.toolCallId;
			// If both have IDs, they must match
			if (this.subAgentInvocationId && otherEffectiveId) {
				return this.subAgentInvocationId === otherEffectiveId;
			}
			// Fallback for tools without IDs - group if this part has no ID and tool has no ID
			return !this.subAgentInvocationId && !otherEffectiveId;
		}
		return false;
	}
}
