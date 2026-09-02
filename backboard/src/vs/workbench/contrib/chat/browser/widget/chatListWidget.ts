/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ITreeContextMenuEvent, ITreeElement, ITreeFilter } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility, ScrollEvent } from '../../../../../base/common/scrollable.js';
import { URI } from '../../../../../base/common/uri.js';
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
				// wheel/trackpad movement feel continuous without changing other chats.
				verticalScrollMode: isAuxiliaryBarChat ? ScrollbarVisibility.Visible : ScrollbarVisibility.Auto,
				smoothScrolling: isAuxiliaryBarChat,
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
		this._scrollDownButton.element.style.display = 'none'; // Hidden by default

		this._register(this._scrollDownButton.onDidClick(() => {
			this.setScrollLock(true);
			this.scrollToEnd();
		}));

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
				&& e.scrollTopChanged
				&& (e.scrollTop < e.oldScrollTop || (!e.heightChanged && !e.scrollHeightChanged))
				&& !this.isScrolledToBottom) {
				this._scrollLock = false;
			}
			this._onDidScroll.fire(e);
			this.updateScrollDownButtonVisibility();
		}));

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
		const atBottom = this.isScrolledToBottom || this._scrollLock;
		this._scrollDownButton.element.style.display = atBottom ? 'none' : '';
		this._container.classList.toggle('chat-list-at-bottom', atBottom);
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

	/**
	 * Set the view model for the list to render.
	 */
	setViewModel(viewModel: IChatViewModel | undefined): void {
		if (this._viewModel !== viewModel) {
			this._accessibilityProvider.clearCache();
		}
		this._viewModel = viewModel;
		this._renderer.updateViewModel(viewModel);
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
		this._lastItem = items.at(-1);
		this._latestConversationItem = items.findLast(item => !isPendingDividerVM(item) && !(isRequestVM(item) && !!item.pendingKind));
		this._lastItemIdContextKey.set(this._latestConversationItem ? [this._latestConversationItem.id] : []);

		const treeItems: ITreeElement<ChatTreeItem>[] = items.map(item => ({
			element: item,
			collapsed: false,
			collapsible: false,
		}));
		const lastPhysicalItemId = this._lastItem?.id;
		const mostRecentResponseId = items.findLast(isResponseVM)?.id;
		const currentTurnResponseId = isResponseVM(this._latestConversationItem) ? this._latestConversationItem.id : undefined;
		const latestTurnRequestId = isRequestVM(this._latestConversationItem)
			? this._latestConversationItem.id
			: isResponseVM(this._latestConversationItem) ? this._latestConversationItem.requestId : undefined;
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
		this.updateLastItemMinHeight();
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
		if (this._lastItem) {
			const offset = Math.max(this._lastItem.currentRenderedHeight ?? 0, 1e6);
			if (this._tree.hasElement(this._lastItem)) {
				this._tree.reveal(this._lastItem, offset);
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
		if (this._suppressAutoScroll) {
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
		this._visible = visible;
		this._renderer.setVisible(visible);
		if (visible && this._renderingSuspended) {
			const perfEnabled = isChatPerfLoggingEnabled(this.logService);
			const startedAt = perfEnabled ? performance.now() : 0;
			this._renderingSuspended = false;
			const scrollTop = this._suspendedScrollTop;
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

		const contentHeight = this._bodyDimension.height;
		if (this._renderStyle === 'compact' || this._renderStyle === 'minimal') {
			this._container.style.removeProperty('--chat-current-response-min-height');
			this._previousLastItemMinHeight = null;
		} else {
			const items = this._viewModel?.getItems() ?? [];
			const lastResponse = items.at(-1);
			if (!isResponseVM(lastResponse)) {
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
