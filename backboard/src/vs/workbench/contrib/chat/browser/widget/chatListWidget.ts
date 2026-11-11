/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import * as dom from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ITreeContextMenuEvent, ITreeElement, ITreeFilter } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../../base/common/map.js';
import { ScrollbarVisibility, ScrollEvent } from '../../../../../base/common/scrollable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asCssVariable, buttonSecondaryBackground, buttonSecondaryForeground, buttonSecondaryHoverBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { katexContainerClassName } from '../../../markdown/common/markedKatexExtension.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatRequestQueueKind, IChatFollowup, IChatSendRequestOptions, IChatService } from '../../common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { isChatPerfLoggingEnabled, logChatPerf } from '../../common/chatPerf.js';
import { IChatRequestModeInfo } from '../../common/model/chatModel.js';
import { IChatRequestViewModel, IChatResponseViewModel, IChatViewModel, isPendingDividerVM, isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';
import { ChatTreeItem, IChatAccessibilityService, IChatCodeBlockInfo, IChatFileTreeInfo, IChatListItemRendererOptions } from '../chat.js';
import { CodeBlockPart } from './chatContentParts/codeBlockPart.js';
import { ChatListDelegate, ChatListItemRenderer, IChatListItemTemplate, IChatRendererDelegate } from './chatListRenderer.js';
import { ChatEditorOptions } from './chatOptions.js';
import { ChatPendingDragController } from './chatPendingDragAndDrop.js';
import { ChatPromptDotRail, IChatPromptDot } from './chatPromptDotRail.js';

interface IChatHistoryAnchor {
	id: string;
	requestId: string;
	isResponse: boolean;
	offset: number;
}

export interface IChatListWidgetStyles {
	listForeground?: string;
	listBackground?: string;
}

export interface IChatListWidgetOptions {
	/**
	 * Options for the list item renderer.
	 */
	readonly rendererOptions?: IChatListItemRendererOptions;

	/**
	 * Default height for list elements.
	 */
	readonly defaultElementHeight?: number;

	/**
	 * DOM node for overflow widgets (e.g., code editors).
	 */
	readonly overflowWidgetsDomNode?: HTMLElement;

	/**
	 * Optional style overrides for the list.
	 */
	readonly styles?: IChatListWidgetStyles;

	/**
	 * Callback to get the current chat mode.
	 */
	readonly currentChatMode?: () => ChatModeKind;

	/**
	 * View ID for editor options (used in ChatWidget context).
	 */
	readonly viewId?: string;

	/**
	 * Input editor background color key.
	 */
	readonly inputEditorBackground?: string;

	/**
	 * Result editor background color key.
	 */
	readonly resultEditorBackground?: string;

	/**
	 * Optional filter for the tree.
	 */
	readonly filter?: ITreeFilter<ChatTreeItem, FuzzyScore>;

	/**
	 * Initial view model.
	 */
	readonly viewModel?: IChatViewModel;

	/**
	 * Optional pre-created editor options.
	 * If provided, these will be used instead of creating new ones.
	 */
	readonly editorOptions?: ChatEditorOptions;

	/**
	 * The chat location (for rerun requests).
	 */
	readonly location?: ChatAgentLocation;

	/**
	 * Callback to get current language model ID (for rerun requests).
	 */
	readonly getCurrentLanguageModelId?: () => string | undefined;

	/**
	 * Callback to get current mode info (for rerun requests).
	 */
	readonly getCurrentModeInfo?: () => IChatRequestModeInfo | undefined;

	/**
	 * The render style for the chat widget. Affects minimum height behavior.
	 */
	readonly renderStyle?: 'compact' | 'minimal';
}

/**
 * A reusable widget that encapsulates chat list/tree rendering.
 * This can be used in various contexts such as the main chat widget,
 * hover previews, etc.
 */
export class ChatListWidget extends Disposable {

	//#region Events

	private readonly _onDidScroll = this._register(new Emitter<ScrollEvent>());
	readonly onDidScroll: Event<ScrollEvent> = this._onDidScroll.event;

	private readonly _onDidChangeContentHeight = this._register(new Emitter<void>());
	readonly onDidChangeContentHeight: Event<void> = this._onDidChangeContentHeight.event;

	private readonly _onDidClickFollowup = this._register(new Emitter<IChatFollowup>());
	readonly onDidClickFollowup: Event<IChatFollowup> = this._onDidClickFollowup.event;

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus: Event<void> = this._onDidFocus.event;

	private readonly _onDidChangeItemHeight = this._register(new Emitter<{ element: ChatTreeItem; height: number }>());
	/** Event fired when an item's height changes. Used for dynamic layout mode. */
	readonly onDidChangeItemHeight: Event<{ element: ChatTreeItem; height: number }> = this._onDidChangeItemHeight.event;

	/**
	 * Event fired when a request item is clicked.
	 */
	get onDidClickRequest(): Event<IChatListItemTemplate> {
		return this._renderer.onDidClickRequest;
	}

	/**
	 * Event fired when an item is re-rendered.
	 */
	get onDidRerender(): Event<IChatListItemTemplate> {
		return this._renderer.onDidRerender;
	}

	/**
	 * Event fired when a template is disposed.
	 */
	get onDidDispose(): Event<IChatListItemTemplate> {
		return this._renderer.onDidDispose;
	}

	/**
	 * Event fired when focus moves outside the editing area.
	 */
	get onDidFocusOutside(): Event<void> {
		return this._renderer.onDidFocusOutside;
	}

	//#endregion

	//#region Private fields

	private readonly _tree: WorkbenchObjectTree<ChatTreeItem, FuzzyScore>;
	private readonly _renderer: ChatListItemRenderer;
	private readonly _accessibilityProvider: ChatAccessibilityProvider;

	private _viewModel: IChatViewModel | undefined;
	private _visible = true;
	private _renderingSuspended = false;
	private _suspendedScrollTop: number | undefined;
	private _lastItem: ChatTreeItem | undefined;
	private _latestConversationItem: ChatTreeItem | undefined;
	private _mostRecentlyFocusedItemIndex: number = -1;
	private _scrollLock: boolean = true;
	private _suppressAutoScroll: boolean = false;
	private _settingChangeCounter: number = 0;
	private _visibleChangeCount: number = 0;
	private readonly _promptDotRail: ChatPromptDotRail | undefined;
	private _promptDotRailUpdateScheduled = false;
	private _promptDotRailItems: readonly ChatTreeItem[] | undefined;
	private readonly _historyListeners = this._register(new DisposableStore());
	private readonly _historyAnchorRestore = this._register(new MutableDisposable());
	private readonly _historyViewStates = new LRUCache<string, IChatHistoryAnchor>(100);
	private _pendingHistoryRestore: IChatHistoryAnchor | undefined;
	private _hiddenHistoryAnchor: IChatHistoryAnchor | undefined;
	private _historyScrollSuppressed = false;
	private _scrollingToEnd = false;
	private _historyAnchor: IChatHistoryAnchor | undefined;
	private readonly _historyRetry: HTMLButtonElement;
	private _promptDotRailPrompts: IChatRequestViewModel[] = [];
	private readonly _promptDotRailItemIndices = new Map<string, number>();
	private _promptDotRailIndices: number[] = [];
	private _promptDotRailDots: IChatPromptDot[] = [];
	private _promptDotRailJumpIndex: number | undefined;

	private readonly _container: HTMLElement;
	private readonly _scrollDownButton: Button;
	private readonly _lastItemIdContextKey: IContextKey<string[]>;

	private readonly _location: ChatAgentLocation | undefined;
	private readonly _getCurrentLanguageModelId: (() => string | undefined) | undefined;
	private readonly _getCurrentModeInfo: (() => IChatRequestModeInfo | undefined) | undefined;
	private readonly _renderStyle: 'compact' | 'minimal' | undefined;

	/**
	 * ChatWidget can be constructed before its view-pane host is attached to the
	 * workbench. Re-evaluate the stable ancestors after attachment so the visual
	 * hook always lands on the scrollable list itself, never on its composer or
	 * surrounding view chrome.
	 */
	private updateBackboardTranscriptHostClasses(): void {
		const isAuxiliaryBarChat = this._container.closest('.part.auxiliarybar') !== null;
		const isBackboardCodeEditorTranscript = this._container.closest('.backboard-clean-chat') !== null;
		this._container.classList.toggle('right-panel-chat-scroll', isAuxiliaryBarChat);
		// The editor panel is the reference transcript. Every Backboard ChatWidget
		// host opts into the same rendering path so reasoning, tools, edits and
		// completed-work folding do not change when the user switches layouts.
		this._container.classList.toggle('backboard-cursor-transcript', isBackboardCodeEditorTranscript);
	}

	//#endregion

	//#region Properties

	get domNode(): HTMLElement {
		return this._container;
	}

	get scrollTop(): number {
		return this._tree.scrollTop;
	}

	set scrollTop(value: number) {
		this._tree.scrollTop = value;
	}

	get scrollHeight(): number {
		return this._tree.scrollHeight;
	}

	get renderHeight(): number {
		return this._tree.renderHeight;
	}

	get contentHeight(): number {
		return this._tree.contentHeight;
	}

	/**
	 * Whether the list is scrolled to the bottom.
	 */
	get isScrolledToBottom(): boolean {
		return this._tree.scrollTop + this._tree.renderHeight >= this._tree.scrollHeight - 2;
	}

	/**
	 * The last item in the list.
	 */
	get lastItem(): ChatTreeItem | undefined {
		return this._lastItem;
	}

	/**
	 * The latest sent request/response, excluding queue-only rows.
	 */
	get latestConversationItem(): ChatTreeItem | undefined {
		return this._latestConversationItem;
	}



	//#endregion

	constructor(
		container: HTMLElement,
		options: IChatListWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatAccessibilityService private readonly chatAccessibilityService: IChatAccessibilityService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();

		this._viewModel = options.viewModel;
		this._location = options.location;
		this._getCurrentLanguageModelId = options.getCurrentLanguageModelId;
		this._getCurrentModeInfo = options.getCurrentModeInfo;
		this._lastItemIdContextKey = ChatContextKeys.lastItemId.bindTo(this.contextKeyService);
		this._container = container;
		const isAuxiliaryBarChat = !!container.closest('.part.auxiliarybar');
		// Renderers can mount while WorkbenchObjectTree initializes, so expose the
		// semantic host state before construction and restore it afterwards.
		this.updateBackboardTranscriptHostClasses();

		// Toggle link-style for inline reference widgets based on configuration (single listener for all widgets)
		const updateInlineReferencesStyle = () => {
			const style = this.configurationService.getValue<string>(ChatConfiguration.InlineReferencesStyle);
			this._container.classList.toggle('chat-inline-references-link-style', style === 'link');
		};
		updateInlineReferencesStyle();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.InlineReferencesStyle)) {
				updateInlineReferencesStyle();
			}
		}));

		const scopedInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, this.contextKeyService])
		));
		this._renderStyle = options.renderStyle;

		// Create overflow widgets container
		const overflowWidgetsContainer = options.overflowWidgetsDomNode ?? document.createElement('div');
		if (!options.overflowWidgetsDomNode) {
			overflowWidgetsContainer.classList.add('chat-overflow-widget-container', 'monaco-editor');
			this._container.append(overflowWidgetsContainer);
			this._register(toDisposable(() => overflowWidgetsContainer.remove()));
		}

		// Create editor options (use provided or create new)
		const editorOptions = options.editorOptions ?? this._register(scopedInstantiationService.createInstance(
			ChatEditorOptions,
			options.viewId,
			'foreground',
			options.inputEditorBackground ?? 'chat.requestEditor.background',
			options.resultEditorBackground ?? 'chat.responseEditor.background'
		));

		// Create delegate
		const delegate = scopedInstantiationService.createInstance(
			ChatListDelegate,
			options.defaultElementHeight ?? 200
		);
		this._accessibilityProvider = scopedInstantiationService.createInstance(ChatAccessibilityProvider);

		// Create renderer delegate
		const rendererDelegate: IChatRendererDelegate = {
			getListLength: () => this._tree.getNode(null).visibleChildrenCount,
			onDidScroll: this.onDidScroll,
			container: this._container,
			currentChatMode: options.currentChatMode ?? (() => ChatModeKind.Ask),
		};

		// Create renderer
		this._renderer = this._register(scopedInstantiationService.createInstance(
			ChatListItemRenderer,
			editorOptions,
			options.rendererOptions ?? {},
			rendererDelegate,
			overflowWidgetsContainer,
			this._viewModel,
		));

		// Wire up renderer events
		this._register(this._renderer.onDidClickFollowup(item => {
			this._onDidClickFollowup.fire(item);
		}));

		this._register(this._renderer.onDidChangeItemHeight(e => {
			this._updateElementHeight(e.element, e.height);

			// If the second-to-last item's height changed, update the last item's min height
			const secondToLastItem = this._viewModel?.getItems().at(-2);
			if (e.element.id === secondToLastItem?.id) {
				this.updateLastItemMinHeight();
			}

			this._onDidChangeItemHeight.fire(e);
		}));

		this._register(this._renderer.onDidRequestRerender(element => {
			if (this._tree.hasElement(element)) {
				this._tree.rerender(element);
				this.updateLastItemMinHeight();
			}
		}));

		// Handle rerun with agent or command detection internally
		this._register(this._renderer.onDidClickRerunWithAgentOrCommandDetection(e => {
			const request = this.chatService.getSession(e.sessionResource)?.getRequests().find(candidate => candidate.id === e.requestId);
			if (request) {
				const sendOptions: IChatSendRequestOptions = {
					noCommandDetection: true,
					attempt: request.attempt + 1,
					location: this._location,
					userSelectedModelId: this._getCurrentLanguageModelId?.(),
					modeInfo: this._getCurrentModeInfo?.(),
				};
				this.chatAccessibilityService.acceptRequest(e.sessionResource);
				this.chatService.resendRequest(request, sendOptions).catch(e => this.logService.error('FAILED to rerun request', e));
			}
		}));

		// Create drag-and-drop controller for reordering pending requests
		this._renderer.pendingDragController = this._register(
			scopedInstantiationService.createInstance(ChatPendingDragController, this._container, () => this._viewModel)
		);

		// Create tree
		const styles = options.styles ?? {};
		this._tree = this._register(scopedInstantiationService.createInstance(
			WorkbenchObjectTree<ChatTreeItem, FuzzyScore>,
			'ChatList',
			this._container,
			delegate,
			[this._renderer],
			{
				identityProvider: { getId: (e: ChatTreeItem) => e.id },
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				// The editor's right-panel chat is narrow enough that an auto-hiding
				// scrollbar is easy to miss. Keep a slim rail present there and make
				// wheel movement feel continuous across chat hosts.
				verticalScrollMode: isAuxiliaryBarChat ? ScrollbarVisibility.Visible : ScrollbarVisibility.Auto,
				smoothScrolling: !this.accessibilityService.isMotionReduced(),
				scrollableElementChangeOptions: isAuxiliaryBarChat ? { verticalScrollbarSize: 8 } : undefined,
				supportDynamicHeights: true,
				hideTwistiesOfChildlessElements: true,
				accessibilityProvider: this._accessibilityProvider,
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (e: ChatTreeItem) =>
						isRequestVM(e) ? e.message : isResponseVM(e) ? e.response.value : ''
				},
				setRowLineHeight: false,
				scrollToActiveElement: true,
				filter: options.filter,
				overrideStyles: {
					listFocusBackground: styles.listBackground,
					listInactiveFocusBackground: styles.listBackground,
					listActiveSelectionBackground: styles.listBackground,
					listFocusAndSelectionBackground: styles.listBackground,
					listInactiveSelectionBackground: styles.listBackground,
					listHoverBackground: styles.listBackground,
					listBackground: styles.listBackground,
					listFocusForeground: styles.listForeground,
					listHoverForeground: styles.listForeground,
					listInactiveFocusForeground: styles.listForeground,
					listInactiveSelectionForeground: styles.listForeground,
					listActiveSelectionForeground: styles.listForeground,
					listFocusAndSelectionForeground: styles.listForeground,
					listActiveSelectionIconForeground: undefined,
					listInactiveSelectionIconForeground: undefined,
				}
			}
		));
		this._register(this.accessibilityService.onDidChangeReducedMotion(() => {
			this._tree.updateOptions({ smoothScrolling: !this.accessibilityService.isMotionReduced() });
		}));
		// WorkbenchObjectTree initializes the host class list, so restore the
		// transcript markers after the tree has mounted.
		this.updateBackboardTranscriptHostClasses();
		this._register(dom.scheduleAtNextAnimationFrame(dom.getWindow(this._container), () => {
			this.updateBackboardTranscriptHostClasses();
		}));

		// Create scroll-down button
		this._scrollDownButton = this._register(new Button(this._container, {
			buttonBackground: asCssVariable(buttonSecondaryBackground),
			buttonForeground: asCssVariable(buttonSecondaryForeground),
			buttonHoverBackground: asCssVariable(buttonSecondaryHoverBackground),
			buttonSecondaryBackground: undefined,
			buttonSecondaryForeground: undefined,
			buttonSecondaryHoverBackground: undefined,
			buttonSeparator: undefined,
			supportIcons: true,
		}));
		this._scrollDownButton.element.classList.add('chat-scroll-down');
		this._scrollDownButton.label = `$(${Codicon.chevronDown.id})`;
		const jumpToLatest = localize('chat.history.latest', "Jump to latest");
		this._scrollDownButton.element.title = jumpToLatest;
		this._scrollDownButton.element.setAttribute('aria-label', jumpToLatest);
		this._scrollDownButton.element.style.display = 'none'; // Hidden by default

		this._register(this._scrollDownButton.onDidClick(() => {
			this.setScrollLock(true);
			this.scrollToEnd();
		}));
		this._historyRetry = dom.append(container, dom.$('button.chat-history-retry'));
		this._historyRetry.textContent = localize('chat.history.retry', "Couldn't load history. Retry");
		this._historyRetry.hidden = true;
		this._register(dom.addDisposableListener(this._historyRetry, 'click', () => { void this._viewModel?.historyWindow?.retry(); }));
		this._register(toDisposable(() => this._historyRetry.remove()));

		// Prompt dot rail: one dot per user prompt on the left edge. Clicking a
		// dot jumps to the start of that prompt, and scrolling over the rail scrolls
		// the transcript so the window can be walked through the whole conversation.
		if (!container.closest('.quick-input-widget')) {
			this._promptDotRail = this._register(new ChatPromptDotRail(container));
			this._register(this._promptDotRail.onDidClickPrompt(index => this.jumpToPrompt(index)));
			this._register(this._promptDotRail.onDidScroll(deltaY => this.scrollByRail(deltaY)));
			this._register(this.onDidScroll(() => this.schedulePromptDotRailUpdate()));
			this._register(this.onDidChangeContentHeight(() => this.schedulePromptDotRailUpdate()));
		}

		// Wire up tree events

		// Handle content height changes (fires high-level event, internal scroll handling)
		this._register(this._tree.onDidChangeContentHeight(() => {
			this._onDidChangeContentHeight.fire();
		}));

		this._register(this._tree.onDidFocus(() => {
			this._onDidFocus.fire();
		}));

		// Handle focus changes internally (update mostRecentlyFocusedItemIndex)
		this._register(this._tree.onDidChangeFocus(() => {
			const focused = this.getFocus();
			if (focused && focused.length > 0) {
				const focusedItem = focused[0];
				const items = this.getItems();
				const idx = items.findIndex(i => i === focusedItem);
				if (idx !== -1) {
					this._mostRecentlyFocusedItemIndex = idx;
				}
			}
		}));

		// Handle scroll events (fire public event and manage scroll-down button)
		this._register(this._tree.onDidScroll((e) => {
			// Scroll lock follows a streaming response only until the user moves the
			// viewport away from the bottom. An upward move is always user intent,
			// even when it lands in the same event as a streaming height update. Other
			// standalone scrollTop changes cover touch, keyboard, and scrollbar input.
			if (this._scrollLock
				&& !this._scrollingToEnd
				&& !this._historyScrollSuppressed
				&& e.scrollTopChanged
				&& (e.scrollTop < e.oldScrollTop || (!e.heightChanged && !e.scrollHeightChanged))
				&& !this.isScrolledToBottom) {
				this._scrollLock = false;
			}
			const history = this._viewModel?.historyWindow;
			if (history && e.scrollTopChanged && !this._scrollingToEnd && !this._suppressAutoScroll && !this._historyScrollSuppressed) {
				history.followLive = this.isScrolledToBottom || this._scrollLock;
			}
			this._onDidScroll.fire(e);
			this.updateScrollDownButtonVisibility();
			if (e.scrollTopChanged) { this.pageHistoryAtBoundary(e.scrollTop - e.oldScrollTop); }
		}));

		this._register(dom.addDisposableListener(container, 'wheel', event => this.pageHistoryAtBoundary(event.deltaY), { passive: true }));

		// Set initial at-bottom state (scrollLock defaults to true)
		this.updateScrollDownButtonVisibility();

		// Handle context menu internally
		this._register(this._tree.onContextMenu(e => {
			this.handleContextMenu(e);
		}));

		this._register(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(ChatConfiguration.EditRequests) || e.affectsConfiguration(ChatConfiguration.CheckpointsEnabled)) {
				this._settingChangeCounter++;
				this.refresh();
			}
		}));
	}

	//#region Internal event handlers

	/**
	 * Update scroll-down button visibility based on scroll position and scroll lock.
	 */
	private updateScrollDownButtonVisibility(): void {
		const atBottom = !this._viewModel?.historyWindow?.hasNewer && (this.isScrolledToBottom || this._scrollLock);
		this._scrollDownButton.element.style.display = atBottom ? 'none' : 'flex';
		this._container.classList.toggle('chat-list-at-bottom', atBottom);
	}

	private schedulePromptDotRailUpdate(): void {
		if (!this._visible || !this._promptDotRail || this._promptDotRailUpdateScheduled) {
			return;
		}
		this._promptDotRailUpdateScheduled = true;
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this._container), () => {
			this._promptDotRailUpdateScheduled = false;
			this.updatePromptDotRail();
		});
	}

	private cachePromptDotRail(items: readonly ChatTreeItem[]): void {
		if (this._promptDotRailItems === items) { return; }
		this._promptDotRailItems = items;
		this._promptDotRailPrompts = [];
		this._promptDotRailIndices = [];
		this._promptDotRailItemIndices.clear();
		items.forEach((item, index) => {
			this._promptDotRailItemIndices.set(item.id, index);
			if (isRequestVM(item) && !item.pendingKind) {
				this._promptDotRailPrompts.push(item);
				this._promptDotRailIndices.push(index);
			}
		});
		this._promptDotRailDots = this._promptDotRailPrompts.map(prompt => ({ id: prompt.id, label: prompt.messageText.slice(0, 100) }));
	}

	private updatePromptDotRail(): void {
		if (!this._visible || !this._promptDotRail) { return; }
		// The tree exposes its visible row; no transcript scan or layout read is
		// needed on scroll. Prompt metadata changes only at structural refresh.
		const first = this._tree.firstVisibleElement;
		const firstIndex = first ? this._promptDotRailItemIndices.get(first.id) ?? 0 : 0;
		let low = 0, high = this._promptDotRailIndices.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this._promptDotRailIndices[middle] <= firstIndex) { low = middle + 1; } else { high = middle; }
		}
		this._promptDotRail.update(this._promptDotRailDots, Math.max(0, low - 1));
		if (this._promptDotRailJumpIndex !== undefined) {
			const pending = this._promptDotRailJumpIndex;
			this._promptDotRailJumpIndex = undefined;
			this.scrollToPromptRow(pending);
		}
	}

	private get maxScrollTop(): number {
		return Math.max(0, this._tree.scrollHeight - this._tree.renderHeight);
	}

	/**
	 * Jump to a prompt picked on the dot rail: scroll it to the top of the
	 * viewport, then correct the position once the row has been measured.
	 */
	private jumpToPrompt(index: number): void {
		this.setScrollLock(false);
		this._promptDotRailJumpIndex = index;
		this.scrollToPromptRow(index);
		this.updateScrollDownButtonVisibility();
	}

	/**
	 * Scroll a prompt's row to the top of the viewport. The tree reveals virtual
	 * rows using its cached heights; the next frame corrects the position after
	 * measuring the newly rendered row.
	 */
	private scrollToPromptRow(index: number): void {
		const prompt = this._promptDotRailPrompts[index];
		if (prompt && this._tree.hasElement(prompt)) {
			this._tree.reveal(prompt, 0);
		}
	}

	/**
	 * Scroll the transcript from a wheel gesture over the dot rail, so the dot
	 * window can be walked through prompts the viewport has scrolled past.
	 */
	private scrollByRail(deltaY: number): void {
		if (!Number.isFinite(deltaY) || deltaY === 0) {
			return;
		}
		this.setScrollLock(false);
		this._tree.scrollTop = Math.min(Math.max(this._tree.scrollTop + deltaY, 0), this.maxScrollTop);
		this.updateScrollDownButtonVisibility();
		this.pageHistoryAtBoundary(deltaY);
	}

	/**
	 * Handle context menu events.
	 */
	private handleContextMenu(e: ITreeContextMenuEvent<ChatTreeItem | null>): void {
		e.browserEvent.preventDefault();
		e.browserEvent.stopPropagation();

		const selected = e.element;

		// Check if the context menu was opened on a KaTeX element
		const target = e.browserEvent.target as HTMLElement;
		const isKatexElement = target.closest(`.${katexContainerClassName}`) !== null;

		const scopedContextKeyService = this.contextKeyService.createOverlay([
			[ChatContextKeys.isResponse.key, isResponseVM(selected)],
			[ChatContextKeys.responseIsFiltered.key, isResponseVM(selected) && !!selected.errorDetails?.responseIsFiltered],
			[ChatContextKeys.isKatexMathElement.key, isKatexElement]
		]);
		this.contextMenuService.showContextMenu({
			menuId: MenuId.ChatContext,
			menuActionOptions: { shouldForwardArgs: true },
			contextKeyService: scopedContextKeyService,
			getAnchor: () => e.anchor,
			getActionsContext: () => selected,
		});
	}

	//#endregion

	//#region ViewModel methods

	/** Save only a stable reading bookmark, never the old page's models. */
	saveHistoryViewState(): void {
		const view = this._viewModel;
		if (!view?.historyWindow) { return; }
		const anchor = this._pendingHistoryRestore ?? (!view.historyWindow.followLive ? this.captureHistoryAnchor() : undefined);
		if (anchor) {
			this._historyViewStates.set(view.sessionResource.toString(), anchor);
		} else {
			this._historyViewStates.delete(view.sessionResource.toString());
		}
	}

	/** Set the view model for the list to render. */
	setViewModel(viewModel: IChatViewModel | undefined): void {
		if (this._viewModel === viewModel) { return; }
		this.saveHistoryViewState();
		this._accessibilityProvider.clearCache();
		this._historyListeners.clear();
		this._historyAnchorRestore.clear();
		this._historyAnchor = undefined;
		this._pendingHistoryRestore = undefined;
		this._hiddenHistoryAnchor = undefined;
		this._historyScrollSuppressed = false;
		this._viewModel = viewModel;
		this._renderer.updateViewModel(viewModel);
		const history = viewModel?.historyWindow;
		this._historyRetry.hidden = !history?.error;
		if (history) {
			history.canEvict = (ids, preserveAnchor) => this.canEvictHistory(ids, preserveAnchor);
			this._historyListeners.add(toDisposable(() => { history.canEvict = () => true; }));
			this._historyListeners.add(history.onWillChange(({ direction, target }) => {
				this._historyAnchorRestore.clear();
				this._historyAnchor = target && target === this._pendingHistoryRestore?.requestId
					? this._pendingHistoryRestore : direction === 'latest' || target || (direction === 'newer' && history.followLive) ? undefined : this.captureHistoryAnchor();
				if (this._pendingHistoryRestore && this._historyAnchor === this._pendingHistoryRestore) {
					this._scrollLock = false;
					history.followLive = false;
				}
				this._pendingHistoryRestore = undefined;
				this._historyScrollSuppressed = !!this._historyAnchor;
			}));
			this._historyListeners.add(history.onDidChange(() => {
				this._historyRetry.hidden = !history.error;
				if (!this._visible) { this.suspendRendering(); }
				this.updateScrollDownButtonVisibility();
			}));
			const anchor = this._historyViewStates.get(viewModel.sessionResource.toString());
			if (anchor && history.history.source.getTurnIds().includes(anchor.requestId)) {
				this._scrollLock = false;
				history.followLive = false;
				this._pendingHistoryRestore = anchor;
				void history.load('latest', false, anchor.requestId);
			}
		}
	}

	private pageHistoryAtBoundary(delta: number): void {
		const history = this._viewModel?.historyWindow;
		if (!this._visible || !history || history.loading || history.error || this._scrollingToEnd || this._suppressAutoScroll || this._historyScrollSuppressed) { return; }
		if (delta < 0 && history.hasOlder && this._tree.scrollTop < 200) {
			void history.load('older');
		} else if (delta > 0 && history.hasNewer && this.maxScrollTop - this._tree.scrollTop < 200) {
			void history.load('newer');
		}
	}

	private canEvictHistory(ids: readonly string[], preserveAnchor: boolean): boolean {
		const evicted = new Set(ids);
		if (this._viewModel?.editing && evicted.has(this._viewModel.editing.id)) { return false; }
		const items = this.getItems();
		if (preserveAnchor) {
			const anchor = this.captureHistoryAnchor();
			if (anchor && evicted.has(anchor.requestId)) { return false; }
		}
		const protectedNode = (node: Node | null) => {
			const row = node && [...this.renderedHistoryRows()].find(row => row.contains(node));
			const item = row && items[Number(row.dataset.index)];
			return !!item && (preserveAnchor || evicted.has(isResponseVM(item) ? item.requestId : item.id));
		};
		const selection = dom.getWindow(this._container).getSelection();
		if (selection && !selection.isCollapsed) {
			// A selection may span multiple pages; keep it intact until it is cleared.
			if (this._container.contains(selection.anchorNode) || this._container.contains(selection.focusNode) || selection.containsNode(this._tree.getHTMLElement(), true)) { return false; }
		}
		return !protectedNode(this._container.ownerDocument.activeElement)
			&& !(this._tree.isDOMFocused() && this.getFocus().some(item => evicted.has(isResponseVM(item) ? item.requestId : item.id)));
	}

	private renderedHistoryRows(): NodeListOf<HTMLElement> {
		// The virtual tree owns these rows and exposes no persistent element references.
		// eslint-disable-next-line no-restricted-syntax
		return this._tree.getHTMLElement().querySelectorAll<HTMLElement>(':scope > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row[data-index]');
	}

	private captureHistoryAnchor(): IChatHistoryAnchor | undefined {
		if (!this._visible) { return this._hiddenHistoryAnchor; }
		const top = this._container.getBoundingClientRect().top;
		const items = this.getItems();
		const rows = [...this.renderedHistoryRows()];
		const row = rows.filter(row => row.getBoundingClientRect().bottom > top).sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))[0];
		const item = row && items[Number(row.dataset.index)];
		return item ? { id: item.id, requestId: isResponseVM(item) ? item.requestId : item.id, isResponse: isResponseVM(item), offset: row.getBoundingClientRect().top - top } : undefined;
	}

	private restoreHistoryAnchor(): void {
		const anchor = this._historyAnchor;
		if (!anchor) { return; }
		const viewModel = this._viewModel;
		const restore = () => {
			if (viewModel !== this._viewModel) { return; }
			const items = this.getItems();
			// Rehydrated responses get new UI IDs; the durable request ID and row
			// kind identify the same message after switching chats.
			const index = items.findIndex(item => item.id === anchor.id || (isResponseVM(item) === anchor.isResponse && (isResponseVM(item) ? item.requestId : item.id) === anchor.requestId));
			if (index < 0) { return; }
			this._tree.reveal(items[index], 0);
			const row = [...this.renderedHistoryRows()].find(row => Number(row.dataset.index) === index);
			if (row) { this._tree.scrollTop += row.getBoundingClientRect().top - this._container.getBoundingClientRect().top - anchor.offset; }
		};
		restore();
		this._historyAnchor = undefined;
		this._historyAnchorRestore.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(this._container), () => {
			this._historyAnchorRestore.clear();
			restore();
			this._historyScrollSuppressed = false;
		});
	}

	/**
	 * Refresh the list from the current view model.
	 * Uses internal state for diff identity calculation.
	 */
	refresh(): void {
		const perfEnabled = isChatPerfLoggingEnabled(this.logService);
		const startedAt = perfEnabled ? performance.now() : 0;
		if (!this._viewModel) {
			this._tree.setChildren(null, []);
			this.cachePromptDotRail([]);
			this._lastItem = undefined;
			this._latestConversationItem = undefined;
			this._lastItemIdContextKey.set([]);
			this._renderer.setVisibleItemRoles(undefined, undefined, undefined);
			this._container.style.removeProperty('--chat-current-response-min-height');
			this._previousLastItemMinHeight = null;
			if (perfEnabled) {
				logChatPerf(this.logService, 'list.refresh', { items: 0, model: false }, performance.now() - startedAt);
			}
			return;
		}

		const items = this._viewModel.getItems();
		this.cachePromptDotRail(items);
		this._lastItem = items.at(-1);
		this._latestConversationItem = items.findLast(item => !isPendingDividerVM(item) && !(isRequestVM(item) && !!item.pendingKind));
		this._lastItemIdContextKey.set(this._latestConversationItem ? [this._latestConversationItem.id] : []);

		const treeItems: ITreeElement<ChatTreeItem>[] = items.map(item => ({
			element: item,
			collapsed: false,
			collapsible: false,
		}));
		const lastPhysicalItemId = this._lastItem?.id;
		const liveRequest = this._viewModel.historyWindow ? this._viewModel.model.lastRequest : undefined;
		const mostRecentResponseId = liveRequest?.response?.id ?? items.findLast(isResponseVM)?.id;
		const currentTurnResponseId = liveRequest?.response?.id ?? (isResponseVM(this._latestConversationItem) ? this._latestConversationItem.id : undefined);
		const latestTurnRequestId = liveRequest?.id ?? (isRequestVM(this._latestConversationItem)
			? this._latestConversationItem.id
			: isResponseVM(this._latestConversationItem) ? this._latestConversationItem.requestId : undefined);
		const sessionIdentity = this._viewModel.model.sessionResource.toString();
		const pendingPositions = new Map<string, { position: number; total: number }>();
		for (const kind of [ChatRequestQueueKind.Steering, ChatRequestQueueKind.Queued]) {
			// System-generated rows are intentionally fixed and have no reorder handle.
			// The smart tree identity must track the position among actionable rows so
			// every shifted spinbutton is recreated with fresh aria-value metadata.
			const actionable = items.filter(item => isRequestVM(item) && item.pendingKind === kind && !item.isSystemInitiated);
			for (let index = 0; index < actionable.length; index++) {
				pendingPositions.set(actionable[index].id, { position: index + 1, total: actionable.length });
			}
		}
		const expandedHistoricalResponses = this._renderer.setVisibleItemRoles(mostRecentResponseId, currentTurnResponseId, latestTurnRequestId);

		const editing = this._viewModel.editing;

		this._withPersistedAutoScroll(() => {
			this._tree.setChildren(null, treeItems, {
				diffIdentityProvider: {
					getId: (element) => {
						// Pending types only have 'id', request/response have 'dataId'
						const baseId = (isRequestVM(element) || isResponseVM(element)) ? element.dataId : element.id;
						const disablement = (isRequestVM(element) || isResponseVM(element)) ? element.shouldBeRemovedOnSend : undefined;
						// Per-element editing state: only re-render items whose editing role changed
						const isEditTarget = isRequestVM(element) && editing?.id === element.id;
						const isBlocked = (isRequestVM(element) || isResponseVM(element)) ? element.shouldBeBlocked.get() : false;
						const queueRole = isPendingDividerVM(element)
							? `${element.dividerKind}-${element.pendingCount}-${element.isSystemInitiated ? 'system' : 'user'}`
							: isRequestVM(element) && element.pendingKind
								? element.isSystemInitiated
									? `${element.pendingKind}-system`
									: `${element.pendingKind}-user-${pendingPositions.get(element.id)?.position ?? 0}-${pendingPositions.get(element.id)?.total ?? 0}`
								: 'conversation';
						const queueIdentity = queueRole === 'conversation' ? '' : `_session${sessionIdentity}_queue${queueRole}`;
						return baseId +
							// Divider ids are intentionally stable within a session. Include
							// session and group shape so counts, reorder handles, and recycled
							// divider templates update when the queue changes or the model swaps.
							queueIdentity +
							// If a response is in the process of progressive rendering, we need to ensure that it will
							// be re-rendered so progressive rendering is restarted, even if the model wasn't updated.
							`${isResponseVM(element) && element.renderData ? `_${this._visibleChangeCount}` : ''}` +
							// Re-render once content references are loaded
							(isResponseVM(element) ? `_${element.contentReferences.length}` : '') +
							// Re-render if element becomes hidden due to undo/redo
							`_${disablement ? `${disablement.afterUndoStop || '1'}` : '0'}` +
							// Re-render the request being edited and requests whose blocked state changed
							`_${isEditTarget ? 'edit' : ''}` +
							`_${isBlocked ? 'blocked' : ''}` +
							// Re-render requests when editing starts/stops (for hover button visibility, click handlers)
							(isRequestVM(element) ? `_${editing ? '1' : '0'}` : '') +
							// Re-render all if invoked by setting change
							`_setting${this._settingChangeCounter}` +
							// Rerender request if we got new content references in the response
							// since this may change how we render the corresponding attachments in the request
							(isRequestVM(element) && element.contentReferences ? `_${element.contentReferences?.length}` : '') +
							// The renderer owns last-row-only geometry (minimum response height and
							// checkpoint restore placement). Queueing can change the last item without
							// changing the previous response model, so include this layout role in the
							// diff identity and clear stale last-row styling deterministically.
							`_${element.id === lastPhysicalItemId ? 'last' : 'not-last'}` +
							// Footer/action emphasis follows the latest response even when a queue
							// divider and pending prompts appear after it.
							`_${element.id === mostRecentResponseId ? 'latest-response' : 'not-latest-response'}` +
							// A newly submitted request turns the previous response into cold
							// history, even before that request has received its response. Keep the
							// historical identity stable so later prompts do not churn every old row.
							`_${isResponseVM(element) && element.id !== currentTurnResponseId ? 'historical-response' : 'current-turn-item'}`;
					},
				}
			});
		});
		for (const response of expandedHistoricalResponses) {
			if (this._tree.hasElement(response)) {
				this._tree.rerender(response);
			}
		}
		this._renderer.releaseHistoryItems(new Set(items.map(item => item.id)));
		this.updateLastItemMinHeight();
		this.restoreHistoryAnchor();
		this.schedulePromptDotRailUpdate();
		if (perfEnabled) {
			logChatPerf(this.logService, 'list.refresh', {
				session: this._viewModel.sessionResource.toString(),
				items: items.length,
				model: true,
			}, performance.now() - startedAt);
		}
	}

	/**
	 * Set scroll lock state.
	 */
	setScrollLock(value: boolean): void {
		this._scrollLock = value;
		const viewModel = this._viewModel;
		const history = viewModel?.historyWindow;
		if (history) {
			history.followLive = value;
			if (value && history.hasNewer) {
				void history.load('latest').then(loaded => {
					if (loaded && viewModel === this._viewModel && this._scrollLock) { this.scrollToEnd(); }
				});
			}
		}
		this.updateScrollDownButtonVisibility();
	}

	/**
	 * Get scroll lock state.
	 */
	get scrollLock(): boolean {
		return this._scrollLock;
	}

	/**
	 * Set the visible change count (for diff identity).
	 */
	setVisibleChangeCount(value: number): void {
		this._visibleChangeCount = value;
	}

	/**
	 * Scroll to reveal an element if editing.
	 */
	scrollToCurrentItem(currentElement: IChatRequestViewModel): void {
		if (!this._viewModel?.editing || !currentElement) {
			return;
		}
		if (!this._tree.hasElement(currentElement)) {
			return;
		}
		const relativeTop = this._tree.getRelativeTop(currentElement);
		if (relativeTop === null || relativeTop < 0 || relativeTop > 1) {
			this._tree.reveal(currentElement, 0);
		}
	}

	//#endregion

	//#region Tree methods

	/**
	 * Rerender the tree.
	 */
	rerender(): void {
		this._tree.rerender();
	}

	rerenderItems(items: readonly ChatTreeItem[]): void {
		const perfEnabled = isChatPerfLoggingEnabled(this.logService);
		const startedAt = perfEnabled ? performance.now() : 0;
		let mountedItems = 0;
		this._withPersistedAutoScroll(() => {
			for (const item of items) {
				if (this._tree.hasElement(item)) {
					mountedItems++;
					this._tree.rerender(item);
				}
			}
			this.updateLastItemMinHeight();
		});
		if (perfEnabled) {
			logChatPerf(this.logService, 'list.rerenderItems', {
				session: this._viewModel?.sessionResource.toString(),
				requestedItems: items.length,
				mountedItems,
			}, performance.now() - startedAt);
		}
	}

	private getItems(): ChatTreeItem[] {
		const items: ChatTreeItem[] = [];
		const root = this._tree.getNode(null);
		for (const child of root.children) {
			if (child.element) {
				items.push(child.element);
			}
		}
		return items;
	}


	/**
	 * Delegate scroll events from a mouse wheel event to the tree.
	 */
	delegateScrollFromMouseWheelEvent(event: IMouseWheelEvent): void {
		this._tree.delegateScrollFromMouseWheelEvent(event);
	}

	/**
	 * Whether the tree has a specific element.
	 */
	hasElement(element: ChatTreeItem): boolean {
		return this._tree.hasElement(element);
	}

	/**
	 * Update the height of an element.
	 */
	private _updateElementHeight(element: ChatTreeItem, height?: number): void {
		if (this._tree.hasElement(element) && this._visible) {
			this._withPersistedAutoScroll(() => {
				this._tree.updateElementHeight(element, height);
			});
		}
	}

	/**
	 * Scroll to reveal an element.
	 */
	reveal(element: ChatTreeItem, relativeTop?: number): void {
		this._tree.reveal(element, relativeTop);
	}

	/**
	 * Get the focused elements.
	 */
	getFocus(): ChatTreeItem[] {
		return this._tree.getFocus().filter((e): e is ChatTreeItem => e !== null);
	}

	/**
	 * Set the focused elements.
	 */
	setFocus(elements: ChatTreeItem[]): void {
		this._tree.setFocus(elements);
	}

	focusItem(item: ChatTreeItem): void {
		if (!this.hasElement(item)) {
			return;
		}
		this._tree.setFocus([item]);
		this._tree.domFocus();
	}

	/**
	 * Focus the last item in the list. Returns the index of the focused item.
	 * @param useMostRecentlyFocusedIndex If true, use the mostRecentlyFocusedIndex if valid
	 */
	focusLastItem(useMostRecentlyFocusedIndex?: boolean): number {
		const items = this.getItems();
		if (items.length === 0) {
			return -1;
		}

		let focusIndex: number;
		if (useMostRecentlyFocusedIndex && this._mostRecentlyFocusedItemIndex >= 0 && this._mostRecentlyFocusedItemIndex < items.length) {
			focusIndex = this._mostRecentlyFocusedItemIndex;
		} else {
			focusIndex = items.length - 1;
		}

		this._tree.setFocus([items[focusIndex]]);
		this._tree.domFocus();
		return focusIndex;
	}

	/**
	 * Scroll the list to reveal the last item.
	 */
	scrollToEnd(): void {
		if (this._lastItem && this._tree.hasElement(this._lastItem) && !this._scrollingToEnd) {
			// Animated intermediate positions look like user scrolling and can
			// stop following before unmeasured historical rows settle. Keep this
			// programmatic move immediate; ordinary wheel scrolling stays smooth.
			this._scrollingToEnd = true;
			this._tree.updateOptions({ smoothScrolling: false });
			try {
				this._tree.reveal(this._lastItem, 1);
				if (this._bottomInset > 0) {
					// reveal() aligns the row to the viewport bottom, which sits under a
					// floating composer; include the reserved inset.
					this._tree.scrollTop = this.maxScrollTop;
				}
			} finally {
				this._tree.updateOptions({ smoothScrolling: !this.accessibilityService.isMotionReduced() });
				this._scrollingToEnd = false;
			}
		}
	}

	/**
	 * Suppress auto-scroll behavior temporarily. While suppressed,
	 * _withPersistedAutoScroll will not scroll to bottom after operations.
	 */
	set suppressAutoScroll(value: boolean) {
		this._suppressAutoScroll = value;
	}

	private _withPersistedAutoScroll(fn: () => void): void {
		if (this._suppressAutoScroll || this._historyScrollSuppressed) {
			fn();
			return;
		}
		// Agent/tool workflows opt into scroll lock. A newly rendered tool card can
		// increase the row height before its measured-height event arrives, making
		// the list appear no longer at the bottom. Keep following until a user scroll
		// event releases the lock; returning to the bottom naturally resumes follow.
		const wasScrolledToBottom = this.isScrolledToBottom || this._scrollLock;
		fn();
		if (wasScrolledToBottom) {
			this.scrollToEnd();
		}
	}

	/**
	 * Focus the list.
	 */
	focus(): void {
		this._tree.domFocus();
	}

	/**
	 * Get the DOM focus state.
	 */
	isDOMFocused(): boolean {
		return this._tree.isDOMFocused();
	}

	//#endregion

	//#region Renderer methods

	/**
	 * Get code block info for a response.
	 */
	getCodeBlockInfosForResponse(response: IChatResponseViewModel): IChatCodeBlockInfo[] {
		return this._renderer.getCodeBlockInfosForResponse(response);
	}

	/**
	 * Get code block info by URI.
	 */
	getCodeBlockInfoForEditor(uri: URI): IChatCodeBlockInfo | undefined {
		return this._renderer.getCodeBlockInfoForEditor(uri);
	}

	/**
	 * Get file tree info for a response.
	 */
	getFileTreeInfosForResponse(response: IChatResponseViewModel): IChatFileTreeInfo[] {
		return this._renderer.getFileTreeInfosForResponse(response);
	}

	/**
	 * Get the last focused file tree for a response.
	 */
	getLastFocusedFileTreeForResponse(response: IChatResponseViewModel): IChatFileTreeInfo | undefined {
		return this._renderer.getLastFocusedFileTreeForResponse(response);
	}

	/**
	 * Get editors currently in use.
	 */
	editorsInUse(): Iterable<CodeBlockPart> {
		return this._renderer.editorsInUse();
	}



	/**
	 * Get template data for a request ID.
	 */
	getTemplateDataForRequestId(requestId: string | undefined): IChatListItemTemplate | undefined {
		if (!requestId) {
			return undefined;
		}
		return this._renderer.getTemplateDataForRequestId(requestId);
	}

	/**
	 * Update renderer options.
	 */
	updateRendererOptions(options: IChatListItemRendererOptions): void {
		this._renderer.updateOptions(options);
	}

	/**
	 * Update the list/tree color overrides. Re-applies the same fan-out from
	 * `listBackground`/`listForeground` to all interaction states that was
	 * originally configured at construction time.
	 */
	setStyles(styles: IChatListWidgetStyles): void {
		this._tree.updateOptions({
			overrideStyles: {
				listFocusBackground: styles.listBackground,
				listInactiveFocusBackground: styles.listBackground,
				listActiveSelectionBackground: styles.listBackground,
				listFocusAndSelectionBackground: styles.listBackground,
				listInactiveSelectionBackground: styles.listBackground,
				listHoverBackground: styles.listBackground,
				listBackground: styles.listBackground,
				listFocusForeground: styles.listForeground,
				listHoverForeground: styles.listForeground,
				listInactiveFocusForeground: styles.listForeground,
				listInactiveSelectionForeground: styles.listForeground,
				listActiveSelectionForeground: styles.listForeground,
				listFocusAndSelectionForeground: styles.listForeground,
				listActiveSelectionIconForeground: undefined,
				listInactiveSelectionIconForeground: undefined,
			}
		});
	}

	/**
	 * Set the visibility of the list.
	 */
	setVisible(visible: boolean): boolean {
		this.updateBackboardTranscriptHostClasses();
		if (!visible && this._visible) { this._hiddenHistoryAnchor = this.captureHistoryAnchor(); }
		this._visible = visible;
		if (visible) { this.schedulePromptDotRailUpdate(); }
		this._renderer.setVisible(visible);
		if (visible && this._renderingSuspended) {
			const perfEnabled = isChatPerfLoggingEnabled(this.logService);
			const startedAt = perfEnabled ? performance.now() : 0;
			this._renderingSuspended = false;
			const scrollTop = this._historyAnchor ? undefined : this._suspendedScrollTop;
			this._suspendedScrollTop = undefined;
			this.refresh();
			if (scrollTop !== undefined) {
				this._tree.scrollTop = scrollTop;
			}
			if (perfEnabled) {
				logChatPerf(this.logService, 'list.resume', {
					session: this._viewModel?.sessionResource.toString(),
					items: this._viewModel?.getItems().length ?? 0,
					restoredScrollTop: scrollTop !== undefined,
				}, performance.now() - startedAt, 0);
			}
			return true;
		}
		return false;
	}

	/** Release mounted message parts while preserving the logical chat model. */
	suspendRendering(): void {
		if (this._renderingSuspended || this._visible) {
			return;
		}
		this._renderingSuspended = true;
		const perfEnabled = isChatPerfLoggingEnabled(this.logService);
		const startedAt = perfEnabled ? performance.now() : 0;
		this._suspendedScrollTop = this._tree.scrollTop;
		this._renderer.suspendRendering();
		this._tree.setChildren(null, []);
		this.cachePromptDotRail([]);
		this._lastItem = undefined;
		this._latestConversationItem = undefined;
		if (perfEnabled) {
			logChatPerf(this.logService, 'list.suspend', {
				session: this._viewModel?.sessionResource.toString(),
				items: this._viewModel?.getItems().length ?? 0,
				scrollTop: Math.round(this._suspendedScrollTop),
			}, performance.now() - startedAt, 0);
		}
	}

	/**
	 * Layout the list.
	 */
	private _bottomInset = 0;

	/**
	 * Reserves scrollable space below the last row for a composer that floats
	 * over the list, so the conversation can scroll clear of it.
	 */
	setBottomInset(inset: number): void {
		inset = Math.max(0, Math.round(inset));
		if (inset === this._bottomInset) {
			return;
		}
		this._bottomInset = inset;
		this._container.style.setProperty('--chat-list-bottom-inset', `${inset}px`);
		this._tree.updateOptions({ paddingBottom: inset });
		this.updateLastItemMinHeight();
	}

	layout(height: number, width: number): void {
		this.updateBackboardTranscriptHostClasses();
		this._bodyDimension = new dom.Dimension(width ?? this._container.clientWidth, height);
		this.updateLastItemMinHeight();
		this._tree.layout(height, width);
		this._renderer.layout(width ?? this._container.clientWidth);
	}

	private _bodyDimension: dom.Dimension | null = null;
	private _previousLastItemMinHeight: number | null = null;

	private updateLastItemMinHeight(): void {
		if (!this._bodyDimension) {
			return;
		}

		// Only the part of the viewport above a floating composer is usable.
		const contentHeight = Math.max(0, this._bodyDimension.height - this._bottomInset);
		if (this._renderStyle === 'compact' || this._renderStyle === 'minimal') {
			this._container.style.removeProperty('--chat-current-response-min-height');
			this._previousLastItemMinHeight = null;
		} else {
			const items = this._viewModel?.getItems() ?? [];
			const lastResponse = items.at(-1);
			if (!isResponseVM(lastResponse) || (this._viewModel?.historyWindow && lastResponse.requestId !== this._viewModel.model.lastRequest?.id)) {
				this._container.style.removeProperty('--chat-current-response-min-height');
				this._previousLastItemMinHeight = null;
				return;
			}

			const secondToLastItem = items.at(-2);
			const maxRequestShownHeight = 200;
			const secondToLastItemHeight = Math.min(
				(isRequestVM(secondToLastItem) || isResponseVM(secondToLastItem)) ?
					secondToLastItem.currentRenderedHeight ?? 150 : 150,
				maxRequestShownHeight);
			const lastItemMinHeight = Math.max(contentHeight - (secondToLastItemHeight + 10), 0);
			if (lastItemMinHeight !== this._previousLastItemMinHeight) {
				this._previousLastItemMinHeight = lastItemMinHeight;
				this._container.style.setProperty('--chat-current-response-min-height', lastItemMinHeight + 'px');
				if (this._visible && this._tree.hasElement(lastResponse)) {
					this._updateElementHeight(lastResponse, undefined);
				}
			}
		}
	}

	//#endregion

}
