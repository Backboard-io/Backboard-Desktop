/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/rightWorkbenchLauncher.css';
import './media/rightWorkbenchSimple.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Color } from '../../../../base/common/color.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../base/common/observable.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IDiffEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../nls.js';
import { BrowserViewCommandId, BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions, IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SortBy } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane, IViewPaneOptions, ViewPaneShowActions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, IEditorPane, IResourceDiffEditorInput, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { WebviewEditor } from '../../../../workbench/contrib/webviewPanel/browser/webviewEditor.js';
import { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { ExtensionState, IExtension, IExtensionsWorkbenchService } from '../../../../workbench/contrib/extensions/common/extensions.js';
import { ExtensionsViewPaneContainer } from '../../../../workbench/contrib/extensions/browser/extensionsViewlet.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { MODAL_GROUP, PreferredGroup } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, IModalEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../../workbench/browser/labels.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../../../workbench/contrib/scm/common/scm.js';
import { GitChange, GitDiffChange, IGitRepository, IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService, IXtermColorProvider } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentHostCustomizationService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostCustomizationService.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY } from '../../../../workbench/contrib/chat/common/constants.js';
import { agentsBackground, agentsPanelBackground } from '../../../common/theme.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionFileChange } from '../../../services/sessions/common/session.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerEmptyView, SessionsExplorerView } from '../../files/browser/filesView.js';
import { createFileIconThemableTreeContainerScope } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { WorkbenchCompressibleObjectTree } from '../../../../platform/list/browser/listService.js';
import { OptimusChatViewPane } from '../../../../optimus/contrib/chat/browser/optimusChatViewPane.js';
import { buildReviewTreeChildren, IReviewResource, isReviewResource, ReviewTreeDelegate, ReviewTreeElement, ReviewTreeRenderer, ReviewTreeSorter } from './reviewTree.js';
import { onDidRequestModeEmitter, pendingModeRequest, setPendingModeRequest, type RightWorkbenchMode, type IRightWorkbenchModeRequest, type IRightWorkbenchModeEntry } from './rightWorkbench.js';
import { createRightWorkbenchReviewContextKey, RightWorkbenchReviewContext } from './rightWorkbenchReviewContext.js';
import { RightWorkbenchBrowserSuggestions, normalizeRightWorkbenchUrl } from './rightWorkbenchBrowserSuggestions.js';

const enum RightWorkbenchBrowserCommandId {
	ZoomIn = 'workbench.action.browser.zoomIn',
	ZoomOut = 'workbench.action.browser.zoomOut',
	ResetZoom = 'workbench.action.browser.resetZoom',
	ToggleDeviceEmulation = 'workbench.action.browser.toggleDeviceEmulation',
	PickDevicePreset = 'workbench.action.browser.pickDevicePreset',
	SetUserAgent = 'workbench.action.browser.setUserAgent',
	ToggleMobileEmulation = 'workbench.action.browser.toggleMobileEmulation',
	ResetEmulation = 'workbench.action.browser.resetEmulation',
}

const REVIEW_DIFF_SIDE_BY_SIDE_MIN_WIDTH = 1040;
const ADVANCED_RIGHT_PANEL_FOLDER_STORAGE_KEY = 'backboard.advanced.rightPanelFolder';

/**
 * State for a single tab instance in the right workbench. Multiple tabs of the
 * same mode may exist at once (e.g. two terminals); each carries its own
 * mode-specific state so switching tabs restores the right content.
 */
interface IRightWorkbenchTabState {
	readonly id: string;
	readonly mode: Exclude<RightWorkbenchMode, 'launcher'>;
	terminalInstance?: ITerminalInstance;
	browserUrl?: string;
	browserViewId?: string;
	browserInput?: BrowserEditorInput;
	selectedFile?: URI;
	fileViewSource?: boolean;
	selectedReviewResourceKey?: string;
	selectedReviewSourceUri?: URI;
	selectedExtension?: IExtension;
}

export class RightWorkbenchViewPane extends ViewPane {

	private readonly tabOpenSequencer = new Sequencer();
	private readonly domStore = this._register(new DisposableStore());
	private readonly modePickerStore = this._register(new DisposableStore());
	private root: HTMLElement | undefined;
	private embeddedEditorHost: HTMLElement | undefined;
	private embeddedEditorPart: IModalEditorPart | undefined;
	private readonly embeddedEditorPartStore = this._register(new DisposableStore());
	private filesExplorer: ViewPane | undefined;
	private filesExplorerContainer: HTMLElement | undefined;
	private extensionsViewPane: ExtensionsViewPaneContainer | undefined;
	private extensionsViewPaneContainer: HTMLElement | undefined;
	private optimusChatViewPane: OptimusChatViewPane | undefined;
	private optimusChatViewPaneContainer: HTMLElement | undefined;
	private reviewEmptyElement: HTMLElement | undefined;
	private filePathElement: HTMLElement | undefined;
	private fileEmptyElement: HTMLElement | undefined;
	private fileSourceButton: HTMLButtonElement | undefined;
	private fileOpenButton: HTMLButtonElement | undefined;
	private readonly tabs: IRightWorkbenchTabState[] = [];
	private activeTabId: string | undefined;
	private readonly tabStores = this._register(new DisposableMap<string, DisposableStore>());
	private readonly tabLabelElements = new Map<string, HTMLElement>();
	private isFilesTreeVisible = true;
	private browserEditorPane: BrowserEditor | undefined;
	private browserUrlInput: HTMLInputElement | undefined;
	private browserBackButton: HTMLButtonElement | undefined;
	private browserForwardButton: HTMLButtonElement | undefined;
	private browserRefreshButton: HTMLButtonElement | undefined;
	private embeddedEditorLayoutFrame = 0;
	private readonly terminalColorProvider: IXtermColorProvider = {
		getBackgroundColor: theme => this.getTerminalBackgroundColor(theme),
	};
	private readonly pendingGitReviewRefreshKeys = new Set<string>();
	private initialGitProbeSettled = false;
	private isSessionChangesLoading = false;
	private reviewEmptyIsLoading = false;
	private lastProbedSessionKey: string | undefined;
	private readonly pendingGitReviewStatsKeys = new Set<string>();
	private readonly loadedGitReviewStatsKeys = new Set<string>();
	private readonly gitReviewStats = new Map<string, { additions: number; deletions: number }>();
	private reviewTree: WorkbenchCompressibleObjectTree<ReviewTreeElement> | undefined;
	private reviewTreeCountElement: HTMLElement | undefined;
	private reviewStatsElement: HTMLElement | undefined;
	private reviewFileTitleElement: HTMLElement | undefined;
	private reviewResources: readonly IReviewResource[] = [];
	private reviewFilterValue = '';
	private isReviewRailVisible = true;
	private reviewWordWrap = false;
	private reviewLoadFullFiles = true;
	private reviewRichPreview = false;
	private reviewWordDiffs = false;
	private reviewHideWhitespace = false;
	private reviewContainer: HTMLElement | undefined;
	private reviewBodyElement: HTMLElement | undefined;
	private reviewScmRailElement: HTMLElement | undefined;
	private reviewListContainer: HTMLElement | undefined;
	private openedReviewResourceKey: string | undefined;
	private openedReviewResourceGeneration: number | undefined;
	private openedReviewResourceAttempt = 0;
	private pendingReviewOpenResource: IReviewResource | undefined;
	private reviewOpenTimeout: ReturnType<typeof setTimeout> | undefined;
	private readonly reviewContext = new RightWorkbenchReviewContext();
	private readonly reviewOpenSequencer = new Sequencer();
	private reviewSessionKey: string | undefined;
	private readonly scmReviewRefreshScheduler = this._register(new RunOnceScheduler(() => this.refreshReviewRail(undefined), 100));
	private modePicker: HTMLElement | undefined;
	private modePickerHiddenEditorPane: WebviewEditor | undefined;
	private isRightWorkbenchVisible = false;
	private editorSidebarEnabled = false;
	private editorSidebarFolderUri: URI | undefined;
	private compactPanelPreviousWidth: number | undefined;

	private get activeTab(): IRightWorkbenchTabState | undefined {
		return this.tabs.find(tab => tab.id === this.activeTabId);
	}

	private get activeMode(): RightWorkbenchMode {
		return this.activeTab?.mode ?? 'launcher';
	}

	private get useEditorSidebar(): boolean {
		return this.environmentService.isOptimusWindow && this.editorSidebarEnabled;
	}

	private get useSimpleRightWorkbench(): boolean {
		return !this.environmentService.isOptimusWindow;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ISCMService private readonly scmService: ISCMService,
		@IGitService private readonly gitService: IGitService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentHostCustomizationService private readonly agentHostCustomizationService: IAgentHostCustomizationService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.editorSidebarFolderUri = this.readStoredEditorSidebarFolder();
		this.reviewLoadFullFiles = !this.useSimpleRightWorkbench;
		this.reviewWordDiffs = this.useSimpleRightWorkbench;
		this._register(onDidRequestModeEmitter.event(request => { void this.openMode(request); }));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.EDITOR_PART && e.visible) {
				this.enforceSingleSurfaceLayout();
			}
		}));
		// Kick off git repository discovery as soon as a session is active (not
		// only when the Review tab is opened) so the review rail is populated
		// instantly when the user gets there. Also re-probe when the session's
		// edited files change — they pinpoint repositories nested below the
		// session root.
		this._register(autorun(reader => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			const activeChat = this.useSimpleRightWorkbench ? activeSession?.activeChat.read(reader) : undefined;
			activeChat?.changes.read(reader);
			const sessionKey = activeSession?.resource.toString();
			const reviewContextKey = createRightWorkbenchReviewContextKey(sessionKey, activeChat?.resource.toString());
			const reviewContextChanged = this.reviewContext.transition(reviewContextKey);
			if (reviewContextChanged) {
				const sessionChanged = this.reviewSessionKey !== sessionKey;
				this.reviewSessionKey = sessionKey;
				this.resetReviewContext(sessionChanged);
			}
			if (!activeSession) {
				return;
			}
			if (!this.useSimpleRightWorkbench) {
				activeSession.changes.read(reader);
			}
			if (this.lastProbedSessionKey !== sessionKey) {
				this.lastProbedSessionKey = sessionKey;
				this.initialGitProbeSettled = false;
			}
			if (!this.useSimpleRightWorkbench) {
				this.requestGitReviewRefresh(activeSession);
			}
			if (reviewContextChanged && this.activeMode === 'review') {
				this.refreshReviewRail(undefined);
			}
		}));
		// The session's working directory may resolve after activation — probe
		// again when customizations change so late-arriving directories are
		// still discovered.
		this._register(this.agentHostCustomizationService.onDidChangeCustomizations(() => {
			if (!this.useSimpleRightWorkbench) {
				this.requestGitReviewRefresh(this.sessionsService.activeSession.read(undefined));
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.sessions-right-workbench-shell'));
		this.activateSingleSurface();
		if (pendingModeRequest) {
			const initialRequest = pendingModeRequest;
			this.applyModeRequest(initialRequest);
			setPendingModeRequest(undefined);
			this.renderShell();
			if (initialRequest.newChat) {
				void this.optimusChatViewPane?.showNewChat();
			}
			return;
		}
		this.renderShell();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.isRightWorkbenchVisible = visible;
		if (visible) {
			this.activateSingleSurface();
			if (this.activeMode === 'review') {
				this.refreshReviewRail(undefined);
			}
			// Restore the active tab's native browser view. The browser editor
			// lives in the embedded modal editor part, which is not part of the
			// view-pane visibility chain — it never re-shows the view on its own.
			const activeInput = this.activeTab?.browserInput;
			if (this.activeTab?.mode === 'browser' && activeInput?.model) {
				void activeInput.model.setVisible(true);
			}
		} else {
			if (this.activeMode === 'review') {
				this.invalidateReviewSurface();
				this.queueReviewEditorClose();
			}
			// The native WebContentsView paints above all workbench DOM. Hide
			// every view when the pane goes away (e.g. the New Chat page), or
			// it keeps floating over whatever replaced us.
			for (const input of this.browserViewWorkbenchService.getKnownBrowserViews().values()) {
				void input.model?.setVisible(false);
			}
		}
	}

	override dispose(): void {
		this.invalidateReviewSurface();
		void this.closeEmbeddedEditorPart();
		for (const tab of this.tabs) {
			this.disposeTabResources(tab);
		}
		super.dispose();
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.root) {
			const auxiliaryContent = this.getAuxiliaryContentElement();
			const targetHeight = auxiliaryContent?.clientHeight || height;
			const targetWidth = auxiliaryContent?.clientWidth || width;
			this.expandHiddenPaneWrappers(targetHeight);
			this.root.style.height = `${targetHeight}px`;
			this.root.style.width = `${targetWidth}px`;
		}
		this.layoutFilesExplorer();
		this.layoutExtensionsViewPane();
		this.layoutOptimusChatViewPane();
		this.layoutEmbeddedEditorPart();
		this.layoutReviewTree();
	}

	private getAuxiliaryContentElement(): HTMLElement | undefined {
		const auxiliaryBar = this.root?.closest('.part.auxiliarybar');
		const content = auxiliaryBar?.querySelector(':scope > .content');
		return content instanceof HTMLElement ? content : undefined;
	}

	private expandHiddenPaneWrappers(height: number): void {
		let ancestor = this.root?.parentElement;
		const auxiliaryContent = this.getAuxiliaryContentElement();
		while (ancestor && ancestor !== auxiliaryContent) {
			if (ancestor.classList.contains('pane-body') || ancestor.classList.contains('pane') || ancestor.classList.contains('split-view-view')) {
				ancestor.style.height = `${height}px`;
				if (ancestor.classList.contains('split-view-view')) {
					ancestor.style.top = '0px';
				}
			}
			ancestor = ancestor.parentElement;
		}
	}

	private activateSingleSurface(): void {
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.EDITOR_PART);
	}

	private enforceSingleSurfaceLayout(): void {
		if (!this.root || !this.isRightWorkbenchVisible || !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}
		this.activateSingleSurface();
	}

	private openMode(request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
		return this.tabOpenSequencer.queue(() => this.doOpenMode(request));
	}

	private async doOpenMode(request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
		const modeRequest = typeof request === 'string' ? { mode: request } : request;
		this.activateSingleSurface();
		const existing = modeRequest.mode === 'launcher' ? undefined : this.findTabForRequest(modeRequest);
		const willChangeTab = modeRequest.mode === 'launcher'
			? this.activeTabId !== undefined
			: existing?.id !== this.activeTabId;
		// Re-requesting the already-active surface with no new content is a
		// no-op: tearing down and rebuilding the shell would recreate trees and
		// editors for nothing.
		if (!willChangeTab && !modeRequest.browserUrl && !modeRequest.browserViewId && !modeRequest.newChat && (modeRequest.mode === 'launcher' || existing !== undefined)) {
			return;
		}
		if (willChangeTab) {
			const leavingReview = this.activeMode === 'review';
			if (leavingReview) {
				this.invalidateReviewSurface();
			}
			const closed = leavingReview
				? await this.reviewOpenSequencer.queue(() => this.closeEmbeddedEditorPart())
				: await this.closeEmbeddedEditorPart();
			if (!closed) {
				return;
			}
		}
		this.applyModeRequest(modeRequest);
		this.renderShell();
		if (modeRequest.newChat) {
			await this.optimusChatViewPane?.showNewChat();
		}
	}

	private openNewTab(mode: Exclude<RightWorkbenchMode, 'launcher'>): Promise<void> {
		return this.tabOpenSequencer.queue(() => this.doOpenNewTab(mode));
	}

	private async doOpenNewTab(mode: Exclude<RightWorkbenchMode, 'launcher'>): Promise<void> {
		this.activateSingleSurface();
		const leavingReview = this.activeMode === 'review';
		if (leavingReview) {
			this.invalidateReviewSurface();
		}
		const closed = leavingReview
			? await this.reviewOpenSequencer.queue(() => this.closeEmbeddedEditorPart())
			: await this.closeEmbeddedEditorPart();
		if (!closed) {
			return;
		}
		const tab = this.createTab(mode);
		this.activeTabId = tab.id;
		this.renderShell();
	}

	private openTab(tabId: string): Promise<void> {
		return this.tabOpenSequencer.queue(() => this.doOpenTab(tabId));
	}

	private async doOpenTab(tabId: string): Promise<void> {
		if (tabId === this.activeTabId || !this.tabs.some(tab => tab.id === tabId)) {
			return;
		}
		this.activateSingleSurface();
		const leavingReview = this.activeMode === 'review';
		if (leavingReview) {
			this.invalidateReviewSurface();
		}
		const closed = leavingReview
			? await this.reviewOpenSequencer.queue(() => this.closeEmbeddedEditorPart())
			: await this.closeEmbeddedEditorPart();
		if (!closed) {
			return;
		}
		this.activeTabId = tabId;
		this.renderShell();
	}

	private applyModeRequest(request: IRightWorkbenchModeRequest): void {
		if (this.environmentService.isOptimusWindow && request.editorSidebar !== undefined) {
			this.editorSidebarEnabled = request.editorSidebar;
		}
		if (request.mode === 'launcher') {
			this.editorSidebarEnabled = false;
			this.activeTabId = undefined;
			return;
		}
		const tab = this.findTabForRequest(request) ?? this.createTab(request.mode);
		if (request.browserUrl) {
			tab.browserUrl = this.normalizeBrowserUrl(request.browserUrl);
		}
		if (request.browserViewId && tab.browserViewId !== request.browserViewId) {
			tab.browserViewId = request.browserViewId;
			if (tab.browserInput?.id !== request.browserViewId) {
				tab.browserInput = undefined;
				this.browserEditorPane = undefined;
				this.tabStores.get(tab.id)?.clear();
			}
		}
		this.activeTabId = tab.id;
	}

	/**
	 * Resolves which existing tab should handle an external mode request:
	 * a browser tab already showing the requested view wins, then the active
	 * tab if it has the right mode, then the first tab of that mode.
	 */
	private findTabForRequest(request: IRightWorkbenchModeRequest): IRightWorkbenchTabState | undefined {
		if (request.mode === 'launcher') {
			return undefined;
		}
		if (request.browserViewId) {
			const byViewId = this.tabs.find(tab => tab.mode === 'browser' && (tab.browserViewId === request.browserViewId || tab.browserInput?.id === request.browserViewId));
			if (byViewId) {
				return byViewId;
			}
		}
		const activeTab = this.activeTab;
		if (activeTab?.mode === request.mode) {
			return activeTab;
		}
		return this.tabs.find(tab => tab.mode === request.mode);
	}

	private createTab(mode: Exclude<RightWorkbenchMode, 'launcher'>): IRightWorkbenchTabState {
		const tab: IRightWorkbenchTabState = { id: generateUuid(), mode };
		this.tabs.push(tab);
		this.tabStores.set(tab.id, new DisposableStore());
		return tab;
	}

	private renderShell(): void {
		if (!this.root) {
			return;
		}
		if (this.reviewContainer && this.activeMode === 'review') {
			// Invalidate pending Review opens before rebuilding its surrounding UI.
			this.invalidateReviewSurface();
			this.queueReviewEditorClose();
		}

		this.closeModePicker();
		this.domStore.clear();
		clearNode(this.root);
		this.tabLabelElements.clear();
		this.filesExplorer = undefined;
		this.filesExplorerContainer = undefined;
		this.extensionsViewPane = undefined;
		this.extensionsViewPaneContainer = undefined;
		this.optimusChatViewPane = undefined;
		this.optimusChatViewPaneContainer = undefined;
		this.reviewEmptyElement = undefined;
		this.reviewContainer = undefined;
		this.reviewBodyElement = undefined;
		this.reviewScmRailElement = undefined;
		this.reviewListContainer = undefined;
		this.reviewTree = undefined;
		this.reviewTreeCountElement = undefined;
		this.reviewStatsElement = undefined;
		this.reviewFileTitleElement = undefined;
		this.filePathElement = undefined;
		this.fileEmptyElement = undefined;
		this.fileSourceButton = undefined;
		this.fileOpenButton = undefined;
		this.browserUrlInput = undefined;
		this.browserBackButton = undefined;
		this.browserForwardButton = undefined;
		this.browserRefreshButton = undefined;
		this.root.className = `sessions-right-workbench-shell sessions-right-workbench-mode-${this.activeMode}`;
		this.root.classList.toggle('sessions-right-workbench-simple', this.useSimpleRightWorkbench);
		this.root.classList.toggle('sessions-right-workbench-has-file', !this.useEditorSidebar && this.activeMode === 'files' && !!this.activeTab?.selectedFile);
		this.root.classList.toggle('sessions-right-workbench-files-tree-hidden', this.activeMode === 'files' && !this.isFilesTreeVisible);

		if (!this.useEditorSidebar && this.activeMode === 'launcher') {
			this.renderLauncher(this.root);
			return;
		}

		if (this.useEditorSidebar) {
			this.renderEditorActivityBar(this.root);
			// The native chat surface owns its New Agent/session strip. Avoid a
			// redundant "Editor" section row above it; the activity icon already
			// identifies the active tool.
			if (this.activeMode !== 'editor') {
				this.renderEditorSectionHeader(this.root);
			}
		} else {
			this.renderModeHeader(this.root);
		}
		const body = append(this.root, $('.sessions-right-workbench-body'));
		this.renderModeBody(body);
	}

	private renderModeBody(body: HTMLElement): void {
		if (this.useEditorSidebar && this.activeMode === 'marketplace' && this.activeTab?.selectedExtension) {
			this.renderEditorExtensionPreview(body, this.activeTab.selectedExtension);
			return;
		}
		switch (this.activeMode) {
			case 'editor':
				this.renderEditorChat(body);
				break;
			case 'review':
				this.renderReview(body);
				break;
			case 'browser':
				this.renderBrowser(body);
				break;
			case 'files':
				if (this.useEditorSidebar) {
					if (this.activeTab?.selectedFile) {
						this.renderEditorFilePreview(body, this.activeTab.selectedFile);
					} else {
						this.renderEditorExplorer(body, false);
					}
				} else {
					this.renderFiles(body);
				}
				break;
			case 'terminal':
				this.renderTerminal(body);
				break;
			case 'search':
				this.renderEditorExplorer(body, true);
				break;
			case 'extensions':
				this.renderNativeExtensions(body);
				break;
			case 'marketplace':
				this.renderExtensionsSection(body, true);
				break;
			case 'launcher':
				this.renderLauncher(body);
				break;
		}
	}

	private renderEditorActivityBar(container: HTMLElement): void {
		const activityBar = append(container, $('.sessions-right-workbench-editor-activity'));
		const entries = this.getEditorModeEntries();
		const primaryModes = new Set<RightWorkbenchMode>(['editor', 'files', 'review', 'terminal']);
		for (const entry of entries.filter(entry => primaryModes.has(entry.mode))) {
			const button = append(activityBar, $('button.sessions-right-workbench-editor-activity-button')) as HTMLButtonElement;
			button.type = 'button';
			button.title = entry.label;
			button.ariaLabel = entry.label;
			button.classList.toggle('active', this.activeMode === entry.mode);
			button.appendChild(renderIcon(entry.icon));
			this.domStore.add(addDisposableListener(button, EventType.CLICK, () => { void this.openMode(entry.mode); }));
		}
		const more = append(activityBar, $('button.sessions-right-workbench-editor-activity-button')) as HTMLButtonElement;
		more.type = 'button';
		more.title = localize('rightWorkbench.moreTools', "More tools");
		more.ariaLabel = more.title;
		more.setAttribute('aria-haspopup', 'menu');
		more.classList.toggle('active', !primaryModes.has(this.activeMode));
		more.appendChild(renderIcon(Codicon.ellipsis));
		this.domStore.add(addDisposableListener(more, EventType.CLICK, () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => more,
				getActions: () => entries.filter(entry => !primaryModes.has(entry.mode)).map(entry => toAction({
					id: `rightWorkbench.more.${entry.mode}`,
					label: entry.label,
					checked: this.activeMode === entry.mode,
					run: () => this.openMode(entry.mode),
				})),
			});
		}));
	}

	private renderEditorSectionHeader(container: HTMLElement): void {
		const header = append(container, $('.sessions-right-workbench-editor-section-header'));
		append(header, $('span.sessions-right-workbench-editor-section-title', {}, this.getEditorModeLabel(this.activeMode)));
		const folderUri = this.getEditorSidebarFolderUri();
		const folderLabel = folderUri ? basename(folderUri) : localize('rightWorkbench.chooseFolder', "Choose Folder");
		const folder = append(header, $('button.sessions-right-workbench-editor-folder')) as HTMLButtonElement;
		folder.type = 'button';
		folder.title = folderUri?.fsPath ?? localize('rightWorkbench.chooseFolder', "Choose Folder");
		folder.ariaLabel = folderUri
			? localize('rightWorkbench.currentFolder', "Current folder: {0}", folderLabel)
			: localize('rightWorkbench.chooseFolder', "Choose Folder");
		folder.appendChild(renderIcon(folderUri ? Codicon.folderOpened : Codicon.folder));
		append(folder, $('span.sessions-right-workbench-editor-folder-label', {}, folderLabel));
		folder.appendChild(renderIcon(Codicon.chevronDown));
		this.domStore.add(addDisposableListener(folder, EventType.CLICK, () => this.showEditorFolderMenu(folder)));
	}

	private readStoredEditorSidebarFolder(): URI | undefined {
		const stored = this.storageService.get(ADVANCED_RIGHT_PANEL_FOLDER_STORAGE_KEY, StorageScope.APPLICATION)
			?? this.storageService.get(BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY, StorageScope.APPLICATION);
		if (!stored) {
			return undefined;
		}
		try {
			return URI.parse(stored);
		} catch {
			return undefined;
		}
	}

	private getEditorFolderCandidates(): readonly URI[] {
		const candidates = new Map<string, URI>();
		const add = (resource: URI | undefined) => {
			if (resource) {
				candidates.set(resource.toString(), resource);
			}
		};
		add(this.editorSidebarFolderUri);
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			add(folder.uri);
		}
		const activeWorkspace = this.sessionsService.activeSession.get()?.workspace.get();
		for (const folder of activeWorkspace?.folders ?? []) {
			add(folder.workingDirectory ?? folder.root);
		}
		const remembered = this.storageService.get(BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY, StorageScope.APPLICATION);
		if (remembered) {
			try {
				add(URI.parse(remembered));
			} catch {
				// Ignore a stale value; the remaining candidates still work.
			}
		}
		for (const session of this.sessionsService.getRecentlyOpenedSessions().recent) {
			for (const folder of session.workspace.get()?.folders ?? []) {
				add(folder.workingDirectory ?? folder.root);
			}
		}
		return [...candidates.values()];
	}

	private getEditorSidebarFolderUri(): URI | undefined {
		return this.editorSidebarFolderUri ?? this.getEditorFolderCandidates()[0];
	}

	private showEditorFolderMenu(anchor: HTMLElement): void {
		const active = this.getEditorSidebarFolderUri()?.toString();
		const actions = this.getEditorFolderCandidates().map(resource => toAction({
			id: `rightWorkbench.folder.${resource.toString()}`,
			label: basename(resource),
			checked: resource.toString() === active,
			run: () => this.selectEditorSidebarFolder(resource),
		}));
		if (actions.length > 0) {
			actions.push(new Separator());
		}
		actions.push(toAction({
			id: 'rightWorkbench.chooseFolder',
			label: localize('rightWorkbench.chooseFolderEllipsis', "Choose Folder…"),
			run: () => this.chooseEditorSidebarFolder(),
		}));
		const folderUri = this.getEditorSidebarFolderUri();
		if (folderUri) {
			actions.push(toAction({
				id: 'rightWorkbench.revealFolder',
				label: localize('rightWorkbench.revealFolder', "Reveal Folder in Finder"),
				run: () => this.commandService.executeCommand('revealFileInOS', folderUri),
			}));
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	private async chooseEditorSidebarFolder(): Promise<void> {
		const selected = await this.fileDialogService.showOpenDialog({
			title: localize('rightWorkbench.chooseFolder', "Choose Folder"),
			defaultUri: this.getEditorSidebarFolderUri(),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: localize('rightWorkbench.useFolder', "Use Folder"),
		});
		if (selected?.[0]) {
			await this.selectEditorSidebarFolder(selected[0]);
		}
	}

	private async selectEditorSidebarFolder(resource: URI): Promise<void> {
		if (resource.toString() === this.editorSidebarFolderUri?.toString()) {
			return;
		}
		if (!await this.closeEmbeddedEditorPart()) {
			return;
		}
		this.editorSidebarFolderUri = resource;
		this.storageService.store(ADVANCED_RIGHT_PANEL_FOLDER_STORAGE_KEY, resource.toString(), StorageScope.APPLICATION, StorageTarget.MACHINE);
		for (const tab of this.tabs) {
			tab.selectedFile = undefined;
			tab.selectedReviewResourceKey = undefined;
			tab.selectedReviewSourceUri = undefined;
			if (tab.terminalInstance) {
				tab.terminalInstance.dispose();
				tab.terminalInstance = undefined;
			}
		}
		this.loadedGitReviewStatsKeys.clear();
		this.gitReviewStats.clear();
		this.renderShell();
	}

	private renderModeHeader(container: HTMLElement): void {
		const header = append(container, $('.sessions-right-workbench-header'));
		const tabs = append(header, $('.sessions-right-workbench-tabs'));
		tabs.setAttribute('role', 'tablist');
		tabs.ariaLabel = localize('rightWorkbench.tabs', "Panel tabs");
		this.tabLabelElements.clear();
		for (let index = 0; index < this.tabs.length; index++) {
			if (index > 0) {
				append(tabs, $('span.sessions-right-workbench-tab-separator'));
			}
			const tab = this.tabs[index];
			this.renderTab(tabs, tab);
		}
		const add = append(header, $('button.sessions-right-workbench-tab-add')) as HTMLButtonElement;
		add.type = 'button';
		add.ariaLabel = localize('rightWorkbench.openModePicker', "Open Mode Picker");
		add.setAttribute('aria-haspopup', 'menu');
		add.setAttribute('aria-expanded', 'false');
		add.appendChild(renderIcon(Codicon.add));
		this.domStore.add(addDisposableListener(add, EventType.CLICK, () => this.toggleModePicker(add)));

		// With many tabs the strip scrolls horizontally — keep the active tab
		// in view so it never hides behind the overflow edge.
		const activeTabElement = tabs.querySelector(':scope > .sessions-right-workbench-tab.active');
		activeTabElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

		const controls = append(header, $('.sessions-right-workbench-frame-controls'));
		if (this.useSimpleRightWorkbench) {
			const maximize = this.renderIconButton(controls, Codicon.screenFull, localize('rightWorkbench.expand', "Expand panel"));
			const updateMaximize = () => {
				const expanded = this.layoutService.isAuxiliaryBarMaximized();
				clearNode(maximize);
				maximize.appendChild(renderIcon(expanded ? Codicon.screenNormal : Codicon.screenFull));
				maximize.ariaLabel = maximize.title = expanded ? localize('rightWorkbench.restore', "Restore panel") : localize('rightWorkbench.expand', "Expand panel");
				maximize.setAttribute('aria-pressed', String(expanded));
			};
			updateMaximize();
			this.domStore.add(this.layoutService.onDidChangeAuxiliaryBarMaximized(updateMaximize));
			this.domStore.add(addDisposableListener(maximize, EventType.CLICK, () => this.layoutService.toggleMaximizedAuxiliaryBar()));
			const compact = this.renderIconButton(controls, Codicon.layoutPanel, localize('rightWorkbench.compactPanel', "Toggle compact panel"));
			compact.setAttribute('aria-pressed', String(this.compactPanelPreviousWidth !== undefined));
			this.domStore.add(addDisposableListener(compact, EventType.CLICK, () => {
				this.layoutService.setAuxiliaryBarMaximized(false);
				const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
				const width = this.compactPanelPreviousWidth ?? 400;
				this.compactPanelPreviousWidth = this.compactPanelPreviousWidth === undefined ? size.width : undefined;
				this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { ...size, width });
				compact.setAttribute('aria-pressed', String(this.compactPanelPreviousWidth !== undefined));
			}));
		}
		this.renderPanelCloseButton(controls);
		if (this.activeMode === 'files' && !this.useSimpleRightWorkbench) {
			const filesToggleLabel = this.isFilesTreeVisible
				? localize('rightWorkbench.closeFiles', "Close Files")
				: localize('rightWorkbench.openFiles', "Open Files");
			const filesToggle = this.renderIconButton(controls, Codicon.folderOpened, filesToggleLabel);
			filesToggle.classList.toggle('active', this.isFilesTreeVisible);
			this.domStore.add(addDisposableListener(filesToggle, EventType.CLICK, () => {
				this.isFilesTreeVisible = !this.isFilesTreeVisible;
				this.renderShell();
			}));
		}
	}

	private renderTab(container: HTMLElement, tab: IRightWorkbenchTabState): void {
		const element = append(container, $('.sessions-right-workbench-tab'));
		element.setAttribute('role', 'tab');
		element.setAttribute('aria-selected', String(this.activeTabId === tab.id));
		element.tabIndex = this.activeTabId === tab.id ? 0 : -1;
		element.dataset.tabId = tab.id;
		element.title = this.getTabInstanceLabel(tab);
		element.classList.toggle('active', this.activeTabId === tab.id);
		element.appendChild(renderIcon(this.getModeIcon(tab.mode)));
		const label = append(element, $('span.sessions-right-workbench-tab-label', {}, this.getTabInstanceLabel(tab)));
		this.tabLabelElements.set(tab.id, label);
		const close = append(element, $('button.sessions-right-workbench-tab-close')) as HTMLButtonElement;
		close.type = 'button';
		close.tabIndex = -1;
		close.title = localize('rightWorkbench.closeTab', "Close");
		close.ariaLabel = localize('rightWorkbench.closeTab', "Close");
		close.appendChild(renderIcon(Codicon.close));
		this.domStore.add(addDisposableListener(close, EventType.CLICK, event => {
			event.stopPropagation();
			void this.closeTab(tab.id);
		}));
		this.domStore.add(addDisposableListener(element, EventType.CLICK, () => { void this.openTab(tab.id); }));
		this.domStore.add(addDisposableListener(element, EventType.AUXCLICK, event => {
			if (event.button === 1) {
				event.preventDefault();
				void this.closeTab(tab.id);
			}
		}));
		this.domStore.add(addDisposableListener(element, EventType.KEY_DOWN, event => {
			const index = this.tabs.indexOf(tab);
			const next = event.key === 'ArrowRight' ? this.tabs[(index + 1) % this.tabs.length]
				: event.key === 'ArrowLeft' ? this.tabs[(index + this.tabs.length - 1) % this.tabs.length]
					: event.key === 'Home' ? this.tabs[0] : event.key === 'End' ? this.tabs.at(-1) : undefined;
			if (next) {
				event.preventDefault();
				void this.openTab(next.id).then(() => this.root?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus());
			} else if (event.key === 'Delete' || event.key === 'Backspace') {
				event.preventDefault();
				void this.closeTab(tab.id).then(() => this.root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
			} else if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void this.openTab(tab.id);
			}
		}));
	}

	private refreshTabLabels(): void {
		for (const tab of this.tabs) {
			const label = this.tabLabelElements.get(tab.id);
			if (label) {
				label.textContent = this.getTabInstanceLabel(tab);
				label.parentElement!.title = tab.selectedFile?.fsPath ?? this.getTabInstanceLabel(tab);
			}
		}
	}

	private getTabInstanceLabel(tab: IRightWorkbenchTabState): string {
		const detail = this.getTabDetailLabel(tab);
		if (detail) {
			return detail;
		}
		const base = this.getTabLabel(tab.mode);
		const sameModeTabs = this.tabs.filter(other => other.mode === tab.mode);
		if (sameModeTabs.length > 1) {
			return `${base} ${sameModeTabs.indexOf(tab) + 1}`;
		}
		return base;
	}

	private getTabDetailLabel(tab: IRightWorkbenchTabState): string | undefined {
		switch (tab.mode) {
			case 'browser':
				return tab.browserInput?.getName() || undefined;
			case 'terminal':
				return this.workspaceContextService.getWorkspace().folders[0]?.name ?? this.getTabLabel(tab.mode);
			case 'files':
				return tab.selectedFile ? basename(tab.selectedFile) : undefined;
			default:
				return undefined;
		}
	}

	private renderIconButton(container: HTMLElement, icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = append(container, $('button.sessions-right-workbench-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.ariaLabel = label;
		button.title = label;
		button.appendChild(renderIcon(icon));
		return button;
	}

	private renderPanelCloseButton(container: HTMLElement): void {
		const close = this.renderIconButton(container, Codicon.layoutSidebarRight, localize('rightWorkbench.hidePanel', "Hide Right Panel"));
		this.domStore.add(addDisposableListener(close, EventType.CLICK, () => {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			this.layoutService.focusPart(Parts.SESSIONS_PART);
		}));
	}

	private renderLauncher(container: HTMLElement): void {
		if (this.useSimpleRightWorkbench) {
			const header = append(container, $('.sessions-right-workbench-header'));
			append(header, $('.sessions-right-workbench-tabs'));
			this.renderPanelCloseButton(append(header, $('.sessions-right-workbench-frame-controls')));
		}
		const center = append(container, $('.sessions-right-workbench-launcher-center'));
		if (this.useSimpleRightWorkbench) {
			center.tabIndex = 0;
			center.ariaLabel = localize('rightWorkbench.openSurface', "Open a surface");
			append(center, $('h3.sessions-right-workbench-launcher-title', {}, localize('rightWorkbench.openSurface', "Open a surface")));
			append(center, $('p.sessions-right-workbench-launcher-description', {}, localize('rightWorkbench.chooseSurface', "Choose what to show in the right panel.")));
		}
		const rows = append(center, $('.sessions-right-workbench-launcher-rows'));
		const entries = this.getModeEntries();
		for (const entry of entries) {
			this.renderLauncherRow(rows, entry);
		}
		if (this.useSimpleRightWorkbench) {
			this.domStore.add(addDisposableListener(center, EventType.KEY_DOWN, event => {
				const keyboardEvent = event as KeyboardEvent;
				if (keyboardEvent.metaKey || keyboardEvent.ctrlKey || keyboardEvent.altKey || keyboardEvent.isComposing) {
					return;
				}
				const entry = entries.find(candidate => candidate.shortcut.toLowerCase() === keyboardEvent.key.toLowerCase());
				if (!entry) {
					return;
				}
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				void this.openMode(entry.mode);
			}));
			center.focus();
		}
	}

	private renderLauncherRow(container: HTMLElement, entry: IRightWorkbenchModeEntry): void {
		const button = append(container, $('button.sessions-right-workbench-launcher-row')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(entry.icon));
		append(button, $('.sessions-right-workbench-launcher-label', {}, entry.label));
		if (this.useSimpleRightWorkbench) {
			append(button, $('.sessions-right-workbench-launcher-card-description', {}, this.getLauncherDescription(entry.mode)));
		}
		if (entry.shortcut) {
			append(button, $('.sessions-right-workbench-launcher-shortcut', {}, entry.shortcut));
		}
		this.domStore.add(addDisposableListener(button, EventType.CLICK, () => { void this.openMode(entry.mode); }));
	}

	private toggleModePicker(anchor: HTMLElement): void {
		if (this.modePicker) {
			this.closeModePicker();
			return;
		}
		this.renderModePicker(anchor);
	}

	private renderModePicker(anchor: HTMLElement): void {
		const root = this.root;
		if (!root) {
			return;
		}

		this.closeModePicker();
		anchor.setAttribute('aria-expanded', 'true');

		// Webview editors (for example Markdown previews) render in an overlay
		// outside this DOM subtree. Temporarily release that overlay so it cannot
		// paint through the mode picker, then restore it when the picker closes.
		const activeEditorPane = this.embeddedEditorPart?.activeGroup.activeEditorPane;
		if (activeEditorPane instanceof WebviewEditor) {
			activeEditorPane.setVisible(false);
			this.modePickerHiddenEditorPane = activeEditorPane;
		}

		// The class name is registered with the browser view overlay manager
		// (browserView/electron-browser/overlayManager.ts) so the native
		// WebContentsView hides while the picker is open — without that the
		// browser paints over the popup. Keep the names in sync.
		const picker = append(root, $('.sessions-right-workbench-mode-picker'));
		picker.setAttribute('role', 'menu');
		const rootRect = root.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const pickerWidth = 280;
		const left = Math.max(8, Math.min(anchorRect.left - rootRect.left - 2, rootRect.width - pickerWidth - 8));
		picker.style.left = `${left}px`;
		picker.style.top = `${anchorRect.bottom - rootRect.top + 6}px`;

		for (const entry of this.getModePickerEntries()) {
			this.renderModePickerRow(picker, entry);
		}

		this.modePicker = picker;
		const ownerDocument = root.ownerDocument;
		this.modePickerStore.add(addDisposableListener(ownerDocument, EventType.MOUSE_DOWN, event => {
			const target = event.target as Node | null;
			if (target && !picker.contains(target) && !anchor.contains(target)) {
				this.closeModePicker();
			}
		}, true));
		this.modePickerStore.add(addDisposableListener(ownerDocument, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				this.closeModePicker();
			}
		}));
		this.modePickerStore.add({ dispose: () => anchor.setAttribute('aria-expanded', 'false') });
	}

	private renderModePickerRow(container: HTMLElement, entry: IRightWorkbenchModeEntry): void {
		const button = append(container, $('button.sessions-right-workbench-mode-picker-row')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'menuitem');
		button.classList.toggle('active', this.activeMode === entry.mode);
		button.appendChild(renderIcon(entry.icon));
		append(button, $('.sessions-right-workbench-mode-picker-label', {}, entry.label));
		if (entry.shortcut) {
			append(button, $('.sessions-right-workbench-mode-picker-shortcut', {}, entry.shortcut));
		}
		this.modePickerStore.add(addDisposableListener(button, EventType.CLICK, () => {
			this.closeModePicker();
			if (entry.mode !== 'launcher') {
				void this.openNewTab(entry.mode);
			}
		}));
	}

	private closeModePicker(): void {
		this.modePicker?.remove();
		this.modePicker = undefined;
		this.modePickerStore.clear();
		this.modePickerHiddenEditorPane?.setVisible(true);
		this.modePickerHiddenEditorPane = undefined;
	}

	private getModeEntries(): readonly IRightWorkbenchModeEntry[] {
		if (!this.useSimpleRightWorkbench) {
			return [
				{ mode: 'review', icon: Codicon.diffMultiple, label: localize('rightWorkbench.review', "Review"), shortcut: '⌃⇧G' },
				{ mode: 'terminal', icon: Codicon.terminal, label: localize('rightWorkbench.terminal', "Terminal"), shortcut: '' },
				{ mode: 'browser', icon: Codicon.globe, label: localize('rightWorkbench.browser', "Browser"), shortcut: '⌘T' },
				{ mode: 'files', icon: Codicon.folder, label: localize('rightWorkbench.files', "Files"), shortcut: '⌘P' },
			];
		}
		return [
			{ mode: 'review', icon: Codicon.diffMultiple, label: localize('rightWorkbench.review', "Review"), shortcut: 'D' },
			{ mode: 'terminal', icon: Codicon.terminal, label: localize('rightWorkbench.terminal', "Terminal"), shortcut: 'T' },
			{ mode: 'files', icon: Codicon.folder, label: localize('rightWorkbench.files', "Files"), shortcut: 'F' },
			{ mode: 'browser', icon: Codicon.globe, label: localize('rightWorkbench.browser', "Browser"), shortcut: 'B' },
		];
	}

	private getLauncherDescription(mode: RightWorkbenchMode): string {
		switch (mode) {
			case 'browser':
				return localize('rightWorkbench.browserDescription', "Open a local app or URL.");
			case 'terminal':
				return localize('rightWorkbench.terminalDescription', "Start a shell in this workspace.");
			case 'files':
				return localize('rightWorkbench.filesDescription', "Browse and read workspace files.");
			case 'review':
				return localize('rightWorkbench.diffDescription', "Review changes in this thread.");
			default:
				return '';
		}
	}

	private getEditorModeEntries(): readonly IRightWorkbenchModeEntry[] {
		return [
			{ mode: 'editor', icon: Codicon.commentDiscussionSparkle, label: localize('rightWorkbench.editor', "Editor"), shortcut: '' },
			{ mode: 'files', icon: Codicon.files, label: localize('rightWorkbench.explorer', "Explorer"), shortcut: '' },
			{ mode: 'search', icon: Codicon.search, label: localize('rightWorkbench.search', "Search"), shortcut: '' },
			{ mode: 'review', icon: Codicon.sourceControl, label: localize('rightWorkbench.sourceControl', "Source Control"), shortcut: '' },
			{ mode: 'marketplace', icon: Codicon.vm, label: localize('rightWorkbench.marketplace', "Marketplace"), shortcut: '' },
			{ mode: 'browser', icon: Codicon.globe, label: localize('rightWorkbench.browser', "Browser"), shortcut: '' },
			{ mode: 'terminal', icon: Codicon.terminal, label: localize('rightWorkbench.terminal', "Terminal"), shortcut: '' },
		];
	}

	private getEditorModeLabel(mode: RightWorkbenchMode): string {
		switch (mode) {
			case 'editor':
				return localize('rightWorkbench.editor', "Editor");
			case 'files':
				return localize('rightWorkbench.explorer', "Explorer");
			case 'search':
				return localize('rightWorkbench.search', "Search");
			case 'review':
				return localize('rightWorkbench.sourceControl', "Source Control");
			case 'extensions':
				return localize('rightWorkbench.extensions', "Extensions");
			case 'marketplace':
				return localize('rightWorkbench.marketplace', "Marketplace");
			case 'browser':
				return localize('rightWorkbench.browser', "Browser");
			case 'terminal':
				return localize('rightWorkbench.terminal', "Terminal");
			case 'launcher':
				return localize('rightWorkbench.editorTools', "Editor Tools");
		}
	}

	private getModePickerEntries(): readonly IRightWorkbenchModeEntry[] {
		const entries = this.getModeEntries();
		return entries.filter(entry => entry.mode !== 'review' || !this.tabs.some(tab => tab.mode === entry.mode));
	}

	private getModeIcon(mode: RightWorkbenchMode): ThemeIcon {
		switch (mode) {
			case 'editor':
				return Codicon.commentDiscussionSparkle;
			case 'review':
				return Codicon.diffMultiple;
			case 'browser':
				return Codicon.globe;
			case 'files':
				return Codicon.file;
			case 'terminal':
				return Codicon.terminal;
			case 'search':
				return Codicon.search;
			case 'extensions':
				return Codicon.extensions;
			case 'marketplace':
				return Codicon.vm;
			case 'launcher':
				return Codicon.layoutPanelRight;
		}
	}

	private getTabLabel(mode: RightWorkbenchMode): string {
		switch (mode) {
			case 'editor':
				return localize('rightWorkbench.editor', "Editor");
			case 'review':
				return localize('rightWorkbench.review', "Review");
			case 'browser':
				return localize('rightWorkbench.newTab', "New tab");
			case 'files':
				return localize('rightWorkbench.openFile', "Open file");
			case 'terminal':
				return localize('rightWorkbench.terminal', "Terminal");
			case 'search':
				return localize('rightWorkbench.search', "Search");
			case 'extensions':
				return localize('rightWorkbench.extensions', "Extensions");
			case 'marketplace':
				return localize('rightWorkbench.marketplace', "Marketplace");
			case 'launcher':
				return localize('rightWorkbench.launcher', "Launcher");
		}
	}

	private closeTab(tabId: string): Promise<void> {
		return this.tabOpenSequencer.queue(() => this.doCloseTab(tabId));
	}

	private async doCloseTab(tabId: string): Promise<void> {
		const index = this.tabs.findIndex(tab => tab.id === tabId);
		if (index === -1) {
			return;
		}
		if (this.activeTabId === tabId) {
			const leavingReview = this.activeMode === 'review';
			if (leavingReview) {
				this.invalidateReviewSurface();
			}
			const closed = leavingReview
				? await this.reviewOpenSequencer.queue(() => this.closeEmbeddedEditorPart())
				: await this.closeEmbeddedEditorPart();
			if (!closed) {
				return;
			}
		}
		const [tab] = this.tabs.splice(index, 1);
		this.disposeTabResources(tab);
		if (this.activeTabId === tabId) {
			const nextTab = this.tabs[index] ?? this.tabs[index - 1];
			this.activeTabId = nextTab?.id;
		}
		this.renderShell();
	}

	private disposeTabResources(tab: IRightWorkbenchTabState): void {
		this.tabStores.deleteAndDispose(tab.id);
		this.tabLabelElements.delete(tab.id);
		tab.terminalInstance?.dispose();
		tab.terminalInstance = undefined;
		tab.browserInput?.dispose();
		tab.browserInput = undefined;
	}

	private renderBrowser(container: HTMLElement): void {
		const tab = this.activeTab;
		if (!tab || tab.mode !== 'browser') {
			return;
		}
		const chrome = append(container, $('.sessions-right-workbench-browser-chrome'));
		const nav = append(chrome, $('.sessions-right-workbench-browser-nav'));
		this.browserBackButton = this.renderIconButton(nav, Codicon.arrowLeft, localize('rightWorkbench.browserBack', "Back"));
		this.browserForwardButton = this.renderIconButton(nav, Codicon.arrowRight, localize('rightWorkbench.browserForward', "Forward"));
		this.browserRefreshButton = this.renderIconButton(nav, Codicon.refresh, localize('rightWorkbench.browserRefresh', "Refresh"));
		const address = append(nav, $('.sessions-right-workbench-browser-address'));
		const url = append(address, $('input.sessions-right-workbench-browser-url')) as HTMLInputElement;
		this.browserUrlInput = url;
		url.placeholder = localize('rightWorkbench.browserSearchPlaceholder', "Search or enter a URL");
		url.ariaLabel = url.placeholder;
		url.type = 'text';
		url.spellcheck = false;
		url.value = tab.browserInput?.url ?? tab.browserUrl ?? '';
		this.domStore.add(addDisposableListener(this.browserBackButton, EventType.CLICK, () => { void tab.browserInput?.model?.goBack(); }));
		this.domStore.add(addDisposableListener(this.browserForwardButton, EventType.CLICK, () => { void tab.browserInput?.model?.goForward(); }));
		this.domStore.add(addDisposableListener(this.browserRefreshButton, EventType.CLICK, () => { void tab.browserInput?.model?.reload(); }));
		this.domStore.add(new RightWorkbenchBrowserSuggestions(address, url, () => [...this.browserViewWorkbenchService.getKnownBrowserViews().values()], value => { void this.setBrowserUrl(tab, value); }));
		const go = this.renderIconButton(address, Codicon.arrowRight, localize('rightWorkbench.browserGo', "Open URL"));
		this.domStore.add(addDisposableListener(go, EventType.CLICK, () => { void this.setBrowserUrl(tab, url.value); }));
		const browserMoreButton = this.renderIconButton(nav, Codicon.kebabVertical, localize('rightWorkbench.browserMore', "More Actions"));
		this.domStore.add(addDisposableListener(browserMoreButton, EventType.CLICK, () => this.showBrowserActionsMenu(browserMoreButton)));

		const content = append(container, $('.sessions-right-workbench-browser-content'));
		this.embeddedEditorHost = this.attachEmbeddedEditorHost(content);
		this.observeElementResize(this.embeddedEditorHost, () => this.layoutEmbeddedEditorPart());
		const currentUrl = tab.browserUrl ?? tab.browserInput?.url;
		if (!currentUrl && tab.browserViewId && !tab.browserInput) {
			// Resolve the existing view (if any) first so a URL that lives on
			// the model can be recovered before deciding between the browser
			// surface and the empty state.
			tab.browserInput = this.browserViewWorkbenchService.getOrCreateLazy(tab.browserViewId);
			this.bindBrowserInput(tab, tab.browserInput);
		}
		const resolvedUrl = currentUrl ?? tab.browserInput?.url;
		if (resolvedUrl) {
			tab.browserUrl = resolvedUrl;
			void this.openBrowserEditor(tab, resolvedUrl);
		} else {
			const empty = append(content, $('.sessions-right-workbench-browser-empty'));
			empty.appendChild(renderIcon(Codicon.globe));
			append(empty, $('h2', {}, localize('rightWorkbench.startBrowsing', "Start browsing")));
			append(empty, $('p', {}, localize('rightWorkbench.enterUrlToOpenPage', "Enter a URL to open a page")));
			url.focus();
			// A view opened by id may resolve its URL asynchronously — swap
			// the empty state for the page as soon as it arrives instead of
			// leaving a blank surface behind.
			if (tab.browserInput) {
				const input = tab.browserInput;
				const rerender = () => {
					if (this.activeTab === tab && this.activeMode === 'browser' && tab.browserInput === input) {
						this.renderShell();
					}
				};
				this.domStore.add(input.onceModelResolves(model => {
					if (model.url) {
						rerender();
					} else {
						this.domStore.add(Event.once(model.onDidNavigate)(rerender));
					}
				}));
			}
		}
		this.refreshBrowserControls();
	}

	private renderReview(container: HTMLElement): void {
		const review = append(container, $('.sessions-right-workbench-review'));
		this.renderReviewToolbar(review);
		const workspace = append(review, $('.sessions-right-workbench-review-workspace'));
		workspace.classList.toggle('rail-hidden', !this.isReviewRailVisible);
		const editor = append(workspace, $('.sessions-right-workbench-review-main'));
		const editorHeader = append(editor, $('.sessions-right-workbench-review-file-header'));
		this.reviewFileTitleElement = append(editorHeader, $('span.sessions-right-workbench-review-file-title', {}, localize('rightWorkbench.reviewFile', "Changed file")));
		const reviewBody = append(editor, $('.sessions-right-workbench-review-editor'));
		this.embeddedEditorHost = this.attachEmbeddedEditorHost(reviewBody);
		this.embeddedEditorHost.classList.add('review-context-hidden');
		this.observeElementResize(this.embeddedEditorHost, () => this.layoutEmbeddedEditorPart());
		this.openedReviewResourceKey = undefined;
		this.openedReviewResourceGeneration = undefined;

		const rail = append(workspace, $('.sessions-right-workbench-review-rail'));
		const scmRail = append(rail, $('.sessions-right-workbench-review-scm-rail'));
		this.domStore.add(createFileIconThemableTreeContainerScope(scmRail, this.themeService));
		this.setupReviewTree(scmRail);

		this.reviewContainer = review;
		this.reviewBodyElement = reviewBody;
		this.reviewScmRailElement = scmRail;

		this.registerScmReviewRefresh();
		this.domStore.add(autorun(reader => this.refreshReviewRail(reader)));
	}

	private renderReviewToolbar(container: HTMLElement): void {
		// Simple Review is scoped to the selected chat, not the workspace's Git
		// repository. Repository actions here can otherwise keep pointing at the
		// chat/session we just left and make the panel behave like a workbench.
		const activeSession = this.useSimpleRightWorkbench ? undefined : this.sessionsService.activeSession.read(undefined);
		const repository = activeSession ? this.getGitReviewRepositories(activeSession)[0] : undefined;
		const state = repository?.state.read(undefined);
		const branchName = state?.HEAD?.name;
		const upstream = state?.HEAD?.upstream;

		const toolbar = append(container, $('.sessions-right-workbench-review-toolbar'));
		const primary = append(toolbar, $('.sessions-right-workbench-review-toolbar-row.primary'));
		if (this.useSimpleRightWorkbench) {
			append(primary, $('span.sessions-right-workbench-review-scope', {}, localize('rightWorkbench.thisThread', "This thread")));
		}
		if (!this.useSimpleRightWorkbench) {
			const branch = append(primary, $('button.sessions-right-workbench-review-branch')) as HTMLButtonElement;
			branch.type = 'button';
			append(branch, $('span', {}, localize('rightWorkbench.branch', "Branch")));
			branch.appendChild(renderIcon(Codicon.chevronDown));
			branch.disabled = !repository;
			this.domStore.add(addDisposableListener(branch, EventType.CLICK, () => {
				if (repository) {
					void this.commandService.executeCommand('git.checkout', repository.rootUri);
				}
			}));
		}
		this.reviewStatsElement = append(primary, $('span.sessions-right-workbench-review-total-stats'));

		const actions = append(primary, $('.sessions-right-workbench-review-actions'));
		const more = this.renderIconButton(actions, Codicon.ellipsis, localize('rightWorkbench.reviewOptions', "Review options"));
		this.domStore.add(addDisposableListener(more, EventType.CLICK, () => this.showReviewOptionsMenu(more)));
		const refresh = this.renderIconButton(actions, Codicon.refresh, localize('rightWorkbench.refreshReview', "Refresh"));
		this.domStore.add(addDisposableListener(refresh, EventType.CLICK, () => {
			if (repository) {
				void this.commandService.executeCommand('git.refresh', repository.rootUri);
			}
			this.refreshReviewRail(undefined);
		}));
		const search = this.renderIconButton(actions, Codicon.search, localize('rightWorkbench.openChangedFile', "Find Changed File"));
		this.domStore.add(addDisposableListener(search, EventType.CLICK, () => {
			if (!this.isReviewRailVisible) {
				this.isReviewRailVisible = true;
				this.renderShell();
			}
			this.reviewContainer?.querySelector<HTMLInputElement>('.sessions-right-workbench-review-filter input')?.focus();
		}));
		const railToggle = this.renderIconButton(actions, Codicon.layoutSidebarRight, localize('rightWorkbench.toggleChangedFiles', "Toggle changed files"));
		railToggle.classList.toggle('active', this.isReviewRailVisible);
		this.domStore.add(addDisposableListener(railToggle, EventType.CLICK, () => {
			this.isReviewRailVisible = !this.isReviewRailVisible;
			this.renderShell();
		}));
		if (this.useSimpleRightWorkbench) {
			const commit = append(actions, $('button.sessions-right-workbench-review-commit')) as HTMLButtonElement;
			commit.type = 'button';
			commit.appendChild(renderIcon(Codicon.gitCommit));
			append(commit, $('span', {}, localize('rightWorkbench.commitOrPush', "Commit or push")));
			commit.appendChild(renderIcon(Codicon.chevronDown));
			commit.setAttribute('aria-haspopup', 'menu');
			const getRoot = () => {
				const folder = this.sessionsService.activeSession.get()?.workspace.get()?.folders[0];
				return folder?.gitRepository ? folder.workingDirectory : undefined;
			};
			commit.disabled = !getRoot();
			this.domStore.add(addDisposableListener(commit, EventType.CLICK, () => {
				const root = getRoot();
				if (!root) {
					return;
				}
				this.contextMenuService.showContextMenu({
					getAnchor: () => commit,
					getActions: () => [
						toAction({ id: 'rightWorkbench.commit', label: localize('rightWorkbench.commitChanges', "Commit…"), run: () => this.commandService.executeCommand('git.commit', root) }),
						toAction({ id: 'rightWorkbench.push', label: localize('rightWorkbench.pushChanges', "Push"), run: () => this.commandService.executeCommand('git.push', root) }),
					]
				});
			}));
		}
		if (!this.useSimpleRightWorkbench) {
			const commit = append(actions, $('button.sessions-right-workbench-review-commit')) as HTMLButtonElement;
			commit.type = 'button';
			commit.appendChild(renderIcon(Codicon.circleOutline));
			append(commit, $('span', {}, localize('rightWorkbench.commitOrPush', "Commit or push")));
			commit.appendChild(renderIcon(Codicon.chevronDown));
			commit.disabled = !repository;
			this.domStore.add(addDisposableListener(commit, EventType.CLICK, () => {
				if (repository) {
					void this.commandService.executeCommand('git.commitAll', repository.rootUri);
				}
			}));

			const secondary = append(toolbar, $('.sessions-right-workbench-review-toolbar-row.secondary'));
			append(secondary, $('span.sessions-right-workbench-review-branch-name', {}, branchName ?? localize('rightWorkbench.noBranch', "No branch")));
			if (upstream) {
				secondary.appendChild(renderIcon(Codicon.arrowRight));
				append(secondary, $('span.sessions-right-workbench-review-upstream', {}, `${upstream.remote}/${upstream.name}`));
				secondary.appendChild(renderIcon(Codicon.chevronDown));
			}
		}
	}

	private showReviewOptionsMenu(anchor: HTMLElement): void {
		const toggle = (key: 'reviewWordWrap' | 'reviewLoadFullFiles' | 'reviewRichPreview' | 'reviewWordDiffs' | 'reviewHideWhitespace') => {
			this[key] = !this[key];
			this.applyReviewDiffEditorOptions();
		};
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({
					id: 'sessions.rightWorkbench.review.refresh',
					label: localize('rightWorkbench.reviewRefresh', "Refresh"),
					run: () => this.refreshReviewRail(undefined),
				}),
				toAction({
					id: 'sessions.rightWorkbench.review.wordWrap',
					label: this.reviewWordWrap ? localize('rightWorkbench.disableWordWrap', "Disable word wrap") : localize('rightWorkbench.enableWordWrap', "Enable word wrap"),
					run: () => toggle('reviewWordWrap'),
				}),
				new Separator(),
				toAction({
					id: 'sessions.rightWorkbench.review.loadFullFiles',
					label: this.reviewLoadFullFiles ? localize('rightWorkbench.dontLoadFullFiles', "Don't load full files") : localize('rightWorkbench.loadFullFiles', "Load full files"),
					run: () => toggle('reviewLoadFullFiles'),
				}),
				toAction({
					id: 'sessions.rightWorkbench.review.richPreview',
					label: this.reviewRichPreview ? localize('rightWorkbench.disableRichPreview', "Disable rich preview") : localize('rightWorkbench.enableRichPreview', "Enable rich preview"),
					run: () => toggle('reviewRichPreview'),
				}),
				toAction({
					id: 'sessions.rightWorkbench.review.wordDiffs',
					label: this.reviewWordDiffs ? localize('rightWorkbench.hideChangeIndicators', "Hide change indicators") : localize('rightWorkbench.showChangeIndicators', "Show change indicators"),
					run: () => toggle('reviewWordDiffs'),
				}),
				toAction({
					id: 'sessions.rightWorkbench.review.whiteSpace',
					label: this.reviewHideWhitespace ? localize('rightWorkbench.showWhiteSpace', "Show white space") : localize('rightWorkbench.hideWhiteSpace', "Hide white space"),
					run: () => toggle('reviewHideWhitespace'),
				}),
				toAction({
					id: 'sessions.rightWorkbench.review.copyGitApply',
					label: localize('rightWorkbench.copyGitApply', "Copy git apply command"),
					run: () => anchor.ownerDocument.defaultView?.navigator.clipboard.writeText('git diff | git apply'),
				}),
			].filter(action => !this.useSimpleRightWorkbench || (action.id !== 'sessions.rightWorkbench.review.richPreview' && action.id !== 'sessions.rightWorkbench.review.copyGitApply')),
			getMenuClassName: () => 'sessions-right-workbench-review-options-menu',
		});
	}

	private setupReviewTree(container: HTMLElement): void {
		const filter = append(container, $('.sessions-right-workbench-file-filter.sessions-right-workbench-review-filter'));
		filter.appendChild(renderIcon(Codicon.search));
		const filterInput = append(filter, $('input')) as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.setAttribute('aria-label', localize('rightWorkbench.filterChangedFiles', "Filter Changed Files"));
		filterInput.placeholder = localize('rightWorkbench.filterFiles', "Filter files...");
		filterInput.value = this.reviewFilterValue;
		this.domStore.add(addDisposableListener(filterInput, EventType.INPUT, () => {
			this.reviewFilterValue = filterInput.value.trim().toLocaleLowerCase();
			const filtered = this.getFilteredReviewResources();
			const selected = this.reviewResources.length ? this.getSelectedReviewResource(this.reviewResources) : undefined;
			this.updateReviewTree(filtered, selected?.key ?? '');
		}));
		const header = append(container, $('.sessions-right-workbench-review-scm-header'));
		const headerLabel = append(header, $('span.sessions-right-workbench-review-scm-header-label'));
		headerLabel.appendChild(renderIcon(Codicon.diffMultiple));
		append(headerLabel, $('span', {}, localize('rightWorkbench.changedFiles', "Changed Files")));
		this.reviewTreeCountElement = append(header, $('span.sessions-right-workbench-review-scm-count'));

		const listContainer = append(container, $('.sessions-right-workbench-review-scm-list'));
		this.reviewListContainer = listContainer;
		this.observeElementResize(listContainer, () => this.layoutReviewTree());
		const store = this.domStore.add(new DisposableStore());
		const resourceLabels = store.add(this.instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		this.reviewTree = store.add(this.instantiationService.createInstance(
			WorkbenchCompressibleObjectTree<ReviewTreeElement>,
			'RightWorkbenchReviewTree',
			listContainer,
			new ReviewTreeDelegate(),
			[this.instantiationService.createInstance(ReviewTreeRenderer, resourceLabels)],
			{
				accessibilityProvider: {
					getAriaLabel: (element: ReviewTreeElement) => isReviewResource(element) ? basename(element.sourceUri) : element.name,
					getWidgetAriaLabel: () => localize('rightWorkbench.reviewTree', "Review Changes"),
				},
				identityProvider: {
					getId: (element: ReviewTreeElement) => isReviewResource(element) ? element.key : element.uri.toString(),
				},
				indent: this.useSimpleRightWorkbench ? 4 : 8,
				compressionEnabled: !this.useSimpleRightWorkbench,
				sorter: new ReviewTreeSorter(),
			}
		));

		this.domStore.add(this.reviewTree.onDidOpen(e => {
			if (!e.element || !isReviewResource(e.element)) {
				return;
			}
			const activeTab = this.activeTab;
			if (activeTab?.mode === 'review') {
				activeTab.selectedReviewResourceKey = e.element.key;
				activeTab.selectedReviewSourceUri = e.element.sourceUri;
			}
			this.openedReviewResourceKey = undefined;
			this.openedReviewResourceGeneration = undefined;
			this.openSelectedReviewResource(e.element);
		}));
	}

	/**
	 * Sizes the review rail tree to its container. The tree only renders rows
	 * inside the viewport set by its last layout() call, so without this the
	 * viewport stays at whatever the DOM measured during construction and rows
	 * beyond it never render.
	 */
	private layoutReviewTree(): void {
		const tree = this.reviewTree;
		const container = this.reviewListContainer;
		if (!tree || !container) {
			return;
		}
		const height = container.clientHeight;
		const width = container.clientWidth;
		if (height > 0 && width > 0) {
			tree.layout(height, width);
		}
	}

	private updateReviewTree(resources: readonly IReviewResource[], selectedKey: string): void {
		if (!this.reviewTree || !this.reviewTreeCountElement) {
			return;
		}
		this.reviewTreeCountElement.textContent = String(resources.length);
		this.reviewTree.setChildren(null, buildReviewTreeChildren(resources));
		this.layoutReviewTree();
		const selected = resources.find(resource => resource.key === selectedKey);
		if (selected) {
			this.reviewTree.setSelection([selected]);
			this.reviewTree.setFocus([selected]);
		}
	}

	private getFilteredReviewResources(): readonly IReviewResource[] {
		if (!this.reviewFilterValue) {
			return this.reviewResources;
		}
		return this.reviewResources.filter(resource => resource.sourceUri.fsPath.toLocaleLowerCase().includes(this.reviewFilterValue));
	}

	private clearReviewTree(): void {
		if (!this.reviewTree || !this.reviewTreeCountElement) {
			return;
		}
		this.reviewTreeCountElement.textContent = '0';
		this.reviewTree.setChildren(null, []);
	}

	private resetReviewContext(sessionChanged: boolean): void {
		this.cancelPendingReviewOpen();
		this.openedReviewResourceKey = undefined;
		this.openedReviewResourceGeneration = undefined;
		this.reviewResources = [];
		this.isSessionChangesLoading = false;
		this.reviewEmptyIsLoading = false;
		this.reviewEmptyElement?.remove();
		this.reviewEmptyElement = undefined;
		this.embeddedEditorHost?.classList.add('review-context-hidden');
		this.clearReviewTree();

		for (const tab of this.tabs) {
			if (tab.mode === 'review') {
				tab.selectedReviewResourceKey = undefined;
				tab.selectedReviewSourceUri = undefined;
			}
		}

		if (sessionChanged) {
			this.loadedGitReviewStatsKeys.clear();
			this.gitReviewStats.clear();
		}

		if (this.activeMode === 'review') {
			this.queueReviewEditorClose();
		}
	}

	private cancelPendingReviewOpen(): void {
		if (this.reviewOpenTimeout !== undefined) {
			clearTimeout(this.reviewOpenTimeout);
			this.reviewOpenTimeout = undefined;
		}
		this.pendingReviewOpenResource = undefined;
	}

	private invalidateReviewSurface(): void {
		this.reviewContext.invalidate();
		this.cancelPendingReviewOpen();
		this.openedReviewResourceKey = undefined;
		this.openedReviewResourceGeneration = undefined;
		this.embeddedEditorHost?.classList.add('review-context-hidden');
	}

	private queueReviewEditorClose(): void {
		void this.reviewOpenSequencer.queue(async () => {
			try {
				await this.closeEmbeddedEditorPart();
			} catch {
				// The modal may already be closing as its owning chat disappears.
			}
		});
	}

	/**
	 * Returns the active session's changed files, preferring the enabled
	 * default changeset (as the changes view does) and falling back to the
	 * session-level change list.
	 */
	private getSessionReviewChanges(activeSession: IActiveSession | undefined, reader: IReader | undefined): readonly ISessionFileChange[] {
		if (this.useSimpleRightWorkbench) {
			this.isSessionChangesLoading = false;
			return activeSession?.activeChat.read(reader).changes.read(reader) ?? [];
		}

		const changesets = activeSession?.changesets.read(reader) ?? [];
		const selectedChangeset = changesets.find(changeset => changeset.isDefault.read(reader) && changeset.isEnabled.read(reader))
			?? changesets.find(changeset => changeset.isEnabled.read(reader));
		this.isSessionChangesLoading = selectedChangeset?.isLoadingChanges.read(reader) ?? false;
		return selectedChangeset?.changes.read(reader) ?? activeSession?.changes.read(reader) ?? [];
	}

	/**
	 * Re-derives the review rail's resources and re-renders just the rail
	 * elements. Called reactively from the autorun in {@link renderReview} (with a
	 * real `reader`) and imperatively from SCM/git change listeners (with `undefined`,
	 * which makes `IObservable#read` behave like a plain `get()`) so those listeners
	 * don't need to tear down and rebuild the whole panel shell.
	 */
	private refreshReviewRail(reader: IReader | undefined): void {
		const review = this.reviewContainer;
		const reviewBody = this.reviewBodyElement;
		const scmRail = this.reviewScmRailElement;
		if (!review || !reviewBody || !scmRail || this.activeMode !== 'review') {
			return;
		}

		const activeSession = this.sessionsService.activeSession.read(reader);
		const changes = this.getSessionReviewChanges(activeSession, reader);
		const generation = this.reviewContext.captureGeneration();
		if (!this.isRightWorkbenchVisible) {
			return;
		}
		// One tree, three data sources in priority order: SCM resources (richest
		// decorations), raw git state, then the session's own changesets (works
		// even when no repository is reachable from this window).
		let reviewResources: IReviewResource[];
		if (this.useSimpleRightWorkbench) {
			// Simple's Diff surface belongs to the selected chat. Workspace-wide SCM
			// state can still describe the chat we just left while folders are being
			// switched, so it must not replace the chat's own change list here.
			reviewResources = this.toSessionReviewResources(changes, generation);
		} else {
			const scmResources = this.getScmReviewResources(activeSession);
			reviewResources = scmResources.length > 0
				? this.toScmReviewResources(scmResources, generation)
				: this.getGitReviewResources(activeSession, reader, generation);
			if (reviewResources.length === 0) {
				this.requestGitReviewRefresh(activeSession);
				reviewResources = this.toSessionReviewResources(changes, generation);
			}
		}
		this.updateReviewSummary(reviewResources);
		if (reviewResources.length === 0) {
			// Invalidate an editor open that was already resolving when this chat's
			// last change disappeared. Hiding the host below prevents even a single
			// stale paint before the serialized close runs.
			this.reviewContext.invalidate();
			this.reviewResources = [];
			this.cancelPendingReviewOpen();
			this.openedReviewResourceKey = undefined;
			this.openedReviewResourceGeneration = undefined;
			this.embeddedEditorHost?.classList.add('review-context-hidden');
			this.queueReviewEditorClose();
			review.classList.add('sessions-right-workbench-review-empty-state');
			this.clearReviewTree();
			this.showReviewEmptyState(reviewBody);
			return;
		}
		review.classList.remove('sessions-right-workbench-review-empty-state');
		this.reviewEmptyElement?.remove();
		this.reviewEmptyElement = undefined;
		// A stacked review must reopen when its file set changes, even when the
		// selected file stays the same.
		if (this.useSimpleRightWorkbench && (this.reviewResources.length !== reviewResources.length || this.reviewResources.some((resource, index) => resource.key !== reviewResources[index].key))) {
			this.openedReviewResourceKey = undefined;
		}
		this.reviewResources = reviewResources;
		const selectedReviewResource = this.getSelectedReviewResource(reviewResources);
		const filteredResources = this.getFilteredReviewResources();
		this.updateReviewTree(filteredResources, selectedReviewResource.key);
		if (this.reviewFileTitleElement) {
			this.reviewFileTitleElement.textContent = basename(selectedReviewResource.sourceUri);
		}

		if (!this.useSimpleRightWorkbench) {
			for (const repository of this.getGitReviewRepositories(activeSession)) {
				this.requestGitReviewStats(repository);
			}
		}
		this.scheduleReviewResourceOpen(selectedReviewResource, generation);
	}

	private updateReviewSummary(resources: readonly IReviewResource[]): void {
		if (!this.reviewStatsElement) {
			return;
		}
		const additions = resources.reduce((sum, resource) => sum + (resource.additions ?? 0), 0);
		const deletions = resources.reduce((sum, resource) => sum + (resource.deletions ?? 0), 0);
		clearNode(this.reviewStatsElement);
		append(this.reviewStatsElement, $('span.files', {}, resources.length === 1
			? localize('rightWorkbench.oneChangedFile', "1 file changed")
			: localize('rightWorkbench.changedFileCount', "{0} files changed", resources.length.toLocaleString())));
		append(this.reviewStatsElement, $('span.additions', {}, `+${additions.toLocaleString()}`));
		append(this.reviewStatsElement, $('span.deletions', {}, `-${deletions.toLocaleString()}`));
	}

	/**
	 * Defers opening the selected review resource to the next macrotask so the
	 * rail paints first: opening a diff editor resolves both text models and
	 * builds the embedded editor part, which would otherwise block the panel's
	 * first render and make Review feel much slower than its sibling tabs.
	 */
	private scheduleReviewResourceOpen(resource: IReviewResource, generation = this.reviewContext.captureGeneration()): void {
		if (!this.isRightWorkbenchVisible) {
			return;
		}
		this.pendingReviewOpenResource = resource;
		if (this.reviewOpenTimeout !== undefined) {
			return;
		}
		this.reviewOpenTimeout = setTimeout(() => {
			this.reviewOpenTimeout = undefined;
			const pending = this.pendingReviewOpenResource;
			this.pendingReviewOpenResource = undefined;
			if (
				pending &&
				this.isRightWorkbenchVisible &&
				this.activeMode === 'review' &&
				this.reviewContext.isCurrent(generation) &&
				this.hasCurrentReviewResource(pending)
			) {
				this.openSelectedReviewResource(pending, generation);
			}
		}, 0);
	}

	private toSessionReviewResources(changes: readonly ISessionFileChange[], generation: number): IReviewResource[] {
		const resources = new Map<string, IReviewResource>();
		const multiDiffResources = changes.map(change => ({
			original: { resource: change.originalUri },
			modified: { resource: isIChatSessionFileChange2(change) ? change.modifiedUri ?? change.uri : change.modifiedUri },
			goToFileResource: isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri,
		}));
		const multiDiffSource = URI.from({ scheme: 'right-workbench-review', path: `/${generation}`, query: JSON.stringify(multiDiffResources) });
		for (const change of changes) {
			const uri = isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri;
			resources.set(uri.toString(), {
				key: `session:${uri.toString()}:${change.originalUri?.toString() ?? ''}`,
				sourceUri: uri,
				status: localize('rightWorkbench.sessionChange', "Edited"),
				additions: change.insertions,
				deletions: change.deletions,
				open: async () => {
					const modifiedUri = isIChatSessionFileChange2(change) ? change.modifiedUri ?? change.uri : change.modifiedUri;
					if (this.useSimpleRightWorkbench) {
						return !!await this.openReviewEditorInEmbeddedHost({
							multiDiffSource,
							resources: multiDiffResources,
							label: localize('rightWorkbench.threadChanges', "Thread changes"),
							isTransient: true,
							options: { pinned: true, viewState: { revealData: { resource: { original: change.originalUri, modified: modifiedUri } } } },
						}, generation);
					}
					if (change.originalUri && modifiedUri) {
						const input: IResourceDiffEditorInput = {
							original: { resource: change.originalUri },
							modified: { resource: modifiedUri },
							label: basename(uri),
							options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
						};
						return !!await this.openReviewEditorInEmbeddedHost(input, generation);
					}
					const pane = await this.openReviewEditorInEmbeddedHost({
						resource: modifiedUri ?? change.originalUri ?? uri,
						options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
					}, generation);
					return !!pane;
				},
			});
		}
		return Array.from(resources.values()).sort((a, b) => a.sourceUri.fsPath.localeCompare(b.sourceUri.fsPath));
	}

	private registerScmReviewRefresh(): void {
		// Debounce through the scheduler: repositories fire resource events in
		// bursts (per group, per refresh), and each full refresh re-runs git
		// stats and rebuilds the tree. Invalidate only the repository that
		// changed so unrelated repositories keep their cached +/- counts.
		const refresh = (repository?: ISCMRepository) => {
			const rootUri = repository?.provider.rootUri?.toString();
			if (rootUri) {
				this.loadedGitReviewStatsKeys.delete(rootUri);
			} else {
				this.loadedGitReviewStatsKeys.clear();
				this.gitReviewStats.clear();
			}
			this.scmReviewRefreshScheduler.schedule();
		};
		const repositoryListeners = this.domStore.add(new DisposableMap<ISCMRepository>());
		const wireRepository = (repository: ISCMRepository) => {
			const store = new DisposableStore();
			const groupListeners = store.add(new DisposableStore());
			const wireGroups = () => {
				groupListeners.clear();
				for (const group of repository.provider.groups) {
					groupListeners.add(group.onDidChangeResources(() => refresh(repository)));
				}
			};
			store.add(repository.provider.onDidChangeResources(() => refresh(repository)));
			store.add(repository.provider.onDidChangeResourceGroups(() => {
				wireGroups();
				refresh(repository);
			}));
			wireGroups();
			repositoryListeners.set(repository, store);
		};
		this.domStore.add(this.scmService.onDidAddRepository(repository => {
			wireRepository(repository);
			refresh(repository);
		}));
		this.domStore.add(this.scmService.onDidRemoveRepository(repository => {
			repositoryListeners.deleteAndDispose(repository);
			refresh();
		}));
		for (const repository of this.scmService.repositories) {
			wireRepository(repository);
		}
	}

	private renderFiles(container: HTMLElement): void {
		const selectedFile = this.activeTab?.selectedFile;
		const files = append(container, $('.sessions-right-workbench-files'));
		const editor = append(files, $('.sessions-right-workbench-file-editor'));
		const fileHeader = append(this.useSimpleRightWorkbench ? files : editor, $('.sessions-right-workbench-file-path'));
		const folderName = this.workspaceContextService.getWorkspace().folders[0]?.name;
		if (folderName) {
			append(fileHeader, $('span.sessions-right-workbench-file-workspace', {}, folderName));
			fileHeader.appendChild(renderIcon(Codicon.chevronRight));
		}
		this.filePathElement = append(fileHeader, $('span.sessions-right-workbench-file-name', {}, selectedFile ? basename(selectedFile) : '/'));
		const fileActions = append(fileHeader, $('.sessions-right-workbench-file-actions'));
		const source = append(fileActions, $('button.sessions-right-workbench-file-action')) as HTMLButtonElement;
		this.fileSourceButton = source;
		source.type = 'button';
		source.textContent = localize('rightWorkbench.viewSource', "View source");
		this.domStore.add(addDisposableListener(source, EventType.CLICK, () => {
			const tab = this.activeTab;
			if (tab?.mode !== 'files' || !tab.selectedFile) {
				return;
			}
			tab.fileViewSource = !tab.fileViewSource;
			void this.openSelectedFile(tab.selectedFile);
		}));
		const folder = this.renderIconButton(fileActions, Codicon.folderOpened, localize('rightWorkbench.toggleFiles', "Toggle files"));
		folder.classList.toggle('active', this.isFilesTreeVisible);
		this.domStore.add(addDisposableListener(folder, EventType.CLICK, () => {
			this.isFilesTreeVisible = !this.isFilesTreeVisible;
			this.renderShell();
		}));
		const open = append(fileActions, $('button.sessions-right-workbench-file-open')) as HTMLButtonElement;
		this.fileOpenButton = open;
		open.type = 'button';
		open.appendChild(renderIcon(Codicon.package));
		append(open, $('span', {}, localize('rightWorkbench.open', "Open")));
		open.appendChild(renderIcon(Codicon.chevronDown));
		this.domStore.add(addDisposableListener(open, EventType.CLICK, () => {
			const resource = this.activeTab?.mode === 'files' ? this.activeTab.selectedFile : undefined;
			if (resource) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => open,
					getActions: () => [toAction({
						id: 'rightWorkbench.revealFile',
						label: localize('rightWorkbench.revealFile', "Reveal File in Finder"),
						run: () => this.commandService.executeCommand('revealFileInOS', resource)
					})]
				});
			}
		}));
		this.updateFileActions();
		const editorBody = append(editor, $('.sessions-right-workbench-file-editor-body'));
		this.embeddedEditorHost = this.attachEmbeddedEditorHost(editorBody);
		this.observeElementResize(this.embeddedEditorHost, () => this.layoutEmbeddedEditorPart());
		if (!selectedFile) {
			const empty = append(editorBody, $('.sessions-right-workbench-file-empty'));
			this.fileEmptyElement = empty;
			empty.appendChild(renderIcon(Codicon.folderOpened));
			append(empty, $('h2', {}, localize('rightWorkbench.openFile', "Open file")));
			append(empty, $('p', {}, localize('rightWorkbench.selectFileFromTree', "Select a file from the workspace tree")));
		} else {
			void this.openSelectedFile(selectedFile);
		}

		if (!this.isFilesTreeVisible) {
			return;
		}

		const tree = append(files, $('.sessions-right-workbench-file-tree'));
		const filter = append(tree, $('.sessions-right-workbench-file-filter'));
		filter.appendChild(renderIcon(Codicon.search));
		const input = append(filter, $('input')) as HTMLInputElement;
		input.placeholder = localize('rightWorkbench.filterFiles', "Filter files...");
		input.ariaLabel = input.placeholder;
		input.type = 'text';
		const explorerHost = append(tree, $('.sessions-right-workbench-file-explorer-host'));
		this.renderFilesExplorer(explorerHost);
		this.domStore.add(addDisposableListener(input, EventType.INPUT, () => {
			const explorer = this.filesExplorer;
			if (explorer instanceof SessionsExplorerView) {
				explorer.setFindPattern(input.value.trim());
				input.focus();
			}
		}));
	}

	private renderEditorExplorer(container: HTMLElement, searchMode: boolean): void {
		const explorer = append(container, $('.sessions-right-workbench-editor-explorer'));
		let input: HTMLInputElement | undefined;
		if (searchMode) {
			const search = append(explorer, $('.sessions-right-workbench-editor-search'));
			search.appendChild(renderIcon(Codicon.search));
			input = append(search, $('input')) as HTMLInputElement;
			input.type = 'search';
			input.placeholder = localize('rightWorkbench.searchFiles', "Search Files...");
			input.ariaLabel = localize('rightWorkbench.searchFiles', "Search Files...");
		}

		const explorerHost = append(explorer, $('.sessions-right-workbench-editor-explorer-host'));
		const renderTree = () => this.renderWorkspaceDirectory(explorerHost, input?.value.trim() ?? '');
		renderTree();
		if (input) {
			this.domStore.add(addDisposableListener(input, EventType.INPUT, () => {
				renderTree();
			}));
			input.focus();
		}
	}

	private renderWorkspaceDirectory(container: HTMLElement, filter: string): void {
		clearNode(container);
		const tree = append(container, $('.sessions-right-workbench-workspace-tree'));
		tree.setAttribute('role', 'tree');
		const folder = this.getEditorSidebarFolderUri();
		if (!folder) {
			const empty = append(tree, $('.sessions-right-workbench-workspace-empty'));
			empty.appendChild(renderIcon(Codicon.folderOpened));
			const copy = append(empty, $('.sessions-right-workbench-workspace-empty-copy'));
			append(copy, $('span', {}, localize('rightWorkbench.noFolderOpen', "No folder open")));
			const choose = append(copy, $('button.sessions-right-workbench-workspace-choose', {}, localize('rightWorkbench.chooseFolderEllipsis', "Choose Folder…"))) as HTMLButtonElement;
			choose.type = 'button';
			this.domStore.add(addDisposableListener(choose, EventType.CLICK, () => { void this.chooseEditorSidebarFolder(); }));
			return;
		}

		void this.renderWorkspaceFolderSection(tree, folder, filter.toLocaleLowerCase());
		if (!filter) {
			this.renderEditorExplorerAuxiliarySections(container);
		}
	}

	private async renderWorkspaceFolderSection(container: HTMLElement, folder: URI, filter: string): Promise<void> {
		const section = append(container, $('.sessions-right-workbench-workspace-section'));
		const header = append(section, $('button.sessions-right-workbench-workspace-section-header')) as HTMLButtonElement;
		header.type = 'button';
		header.setAttribute('aria-expanded', 'true');
		const twistie = append(header, $('span.sessions-right-workbench-workspace-section-twistie'));
		twistie.appendChild(renderIcon(Codicon.chevronDown));
		append(header, $('span.sessions-right-workbench-workspace-section-label', {}, basename(folder).toLocaleUpperCase()));
		const childrenHost = append(section, $('.sessions-right-workbench-workspace-section-children'));
		let expanded = true;
		this.domStore.add(addDisposableListener(header, EventType.CLICK, () => {
			expanded = !expanded;
			header.setAttribute('aria-expanded', String(expanded));
			twistie.replaceChildren(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
			childrenHost.hidden = !expanded;
		}));

		try {
			const resolved = await this.fileService.resolve(folder);
			if (!childrenHost.isConnected) {
				return;
			}
			const children = [...(resolved.children ?? [])]
				.filter(child => !filter || child.isDirectory || child.name.toLocaleLowerCase().includes(filter))
				.sort((first, second) => Number(second.isDirectory) - Number(first.isDirectory) || first.name.localeCompare(second.name));
			if (children.length === 0) {
				append(childrenHost, $('.sessions-right-workbench-workspace-empty-row', {}, filter
					? localize('rightWorkbench.noMatchingFiles', "No matching files")
					: localize('rightWorkbench.emptyFolder', "Empty folder")));
			}
			for (const child of children) {
				const childHost = append(childrenHost, $('.sessions-right-workbench-workspace-entry'));
				void this.renderWorkspaceEntry(childHost, child, 0, !!filter, filter);
			}
		} catch {
			if (childrenHost.isConnected) {
				append(childrenHost, $('.sessions-right-workbench-workspace-empty-row', {}, localize('rightWorkbench.folderUnavailable', "Folder unavailable")));
			}
		}
	}

	private renderEditorExplorerAuxiliarySections(container: HTMLElement): void {
		const auxiliary = append(container, $('.sessions-right-workbench-workspace-auxiliary'));
		for (const section of [
			{ icon: Codicon.symbolClass, label: localize('rightWorkbench.outline', "Outline") },
			{ icon: Codicon.history, label: localize('rightWorkbench.timeline', "Timeline") },
		]) {
			const row = append(auxiliary, $('button.sessions-right-workbench-workspace-auxiliary-row')) as HTMLButtonElement;
			row.type = 'button';
			row.appendChild(renderIcon(Codicon.chevronRight));
			row.appendChild(renderIcon(section.icon));
			append(row, $('span', {}, section.label.toLocaleUpperCase()));
			this.domStore.add(addDisposableListener(row, EventType.CLICK, () => {
				row.classList.toggle('expanded');
				row.firstElementChild?.replaceWith(renderIcon(row.classList.contains('expanded') ? Codicon.chevronDown : Codicon.chevronRight));
			}));
		}
	}

	private async renderWorkspaceEntry(container: HTMLElement, stat: IFileStat, depth: number, initiallyExpanded: boolean, filter: string): Promise<void> {
		if (!container.isConnected) {
			return;
		}

		const row = append(container, $('button.sessions-right-workbench-workspace-row')) as HTMLButtonElement;
		row.type = 'button';
		row.style.setProperty('--workspace-tree-indent', `${8 + depth * 12}px`);
		row.setAttribute('role', 'treeitem');
		row.setAttribute('aria-label', stat.name);
		const twistie = append(row, $('span.sessions-right-workbench-workspace-twistie'));
		const icon = append(row, $('span.sessions-right-workbench-workspace-icon'));
		append(row, $('span.sessions-right-workbench-workspace-label', {}, stat.name));
		const childrenHost = append(container, $('.sessions-right-workbench-workspace-children'));
		childrenHost.setAttribute('role', 'group');

		if (!stat.isDirectory) {
			twistie.classList.add('leaf');
			icon.appendChild(renderIcon(Codicon.file));
			childrenHost.remove();
			if (filter && !stat.name.toLocaleLowerCase().includes(filter)) {
				row.hidden = true;
			}
			this.domStore.add(addDisposableListener(row, EventType.CLICK, () => {
				for (const selected of container.closest('.sessions-right-workbench-workspace-tree')?.querySelectorAll('.sessions-right-workbench-workspace-row.selected') ?? []) {
					selected.classList.remove('selected');
				}
				row.classList.add('selected');
				void this.openEditorResource(stat.resource);
			}));
			return;
		}

		icon.appendChild(renderIcon(Codicon.folder));
		let expanded = false;
		let loaded = false;
		const setExpanded = async (next: boolean): Promise<void> => {
			expanded = next;
			row.setAttribute('aria-expanded', String(expanded));
			twistie.replaceChildren(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight));
			icon.replaceChildren(renderIcon(expanded ? Codicon.folderOpened : Codicon.folder));
			childrenHost.hidden = !expanded;
			if (!expanded || loaded) {
				return;
			}
			loaded = true;
			try {
				const resolved = await this.fileService.resolve(stat.resource);
				if (!childrenHost.isConnected) {
					return;
				}
				const children = [...(resolved.children ?? [])]
					.filter(child => !filter || child.isDirectory || child.name.toLocaleLowerCase().includes(filter))
					.sort((first, second) => Number(second.isDirectory) - Number(first.isDirectory) || first.name.localeCompare(second.name));
				if (children.length === 0) {
					append(childrenHost, $('.sessions-right-workbench-workspace-empty-row', {}, filter
						? localize('rightWorkbench.noMatchingFiles', "No matching files")
						: localize('rightWorkbench.emptyFolder', "Empty folder")));
				}
				for (const child of children) {
					const childHost = append(childrenHost, $('.sessions-right-workbench-workspace-entry'));
					void this.renderWorkspaceEntry(childHost, child, depth + 1, false, filter);
				}
			} catch {
				if (childrenHost.isConnected) {
					append(childrenHost, $('.sessions-right-workbench-workspace-empty-row', {}, localize('rightWorkbench.folderUnavailable', "Folder unavailable")));
				}
			}
		};

		this.domStore.add(addDisposableListener(row, EventType.CLICK, () => { void setExpanded(!expanded); }));
		void setExpanded(initiallyExpanded || !!filter);
	}

	private renderEditorChat(container: HTMLElement): void {
		const host = append(container, $('.sessions-right-workbench-editor-chat'));
		this.optimusChatViewPaneContainer = host;
		const pane = this.domStore.add(this.instantiationService.createInstance(OptimusChatViewPane, {
			id: this.id,
			title: localize('rightWorkbench.editor', "Editor"),
			minimumBodySize: 0,
			maximumBodySize: Number.POSITIVE_INFINITY,
			expanded: true,
			showActions: ViewPaneShowActions.Always,
		}));
		pane.headerVisible = false;
		pane.render();
		host.appendChild(pane.element);
		pane.setVisible(true);
		this.optimusChatViewPane = pane;
		this.layoutOptimusChatViewPane();
		this.observeElementResize(host, () => this.layoutOptimusChatViewPane());
	}

	private layoutOptimusChatViewPane(): void {
		const pane = this.optimusChatViewPane;
		const host = this.optimusChatViewPaneContainer;
		if (!pane || !host) {
			return;
		}
		const width = host.clientWidth;
		const height = host.clientHeight;
		if (width > 0 && height > 0) {
			pane.orthogonalSize = width;
			pane.layout(height);
		}
	}

	private renderEditorFilePreview(container: HTMLElement, resource: URI): void {
		const preview = append(container, $('.sessions-right-workbench-editor-preview'));
		const toolbar = append(preview, $('.sessions-right-workbench-editor-preview-toolbar'));
		const back = this.renderIconButton(toolbar, Codicon.arrowLeft, localize('rightWorkbench.backToExplorer', "Back to Explorer"));
		append(toolbar, $('span.sessions-right-workbench-editor-preview-name', {}, basename(resource)));
		const reveal = this.renderIconButton(toolbar, Codicon.folderOpened, localize('rightWorkbench.revealFile', "Reveal File in Finder"));
		this.domStore.add(addDisposableListener(back, EventType.CLICK, () => { void this.closeEditorSidebarPreview(); }));
		this.domStore.add(addDisposableListener(reveal, EventType.CLICK, () => {
			void this.commandService.executeCommand('revealFileInOS', resource);
		}));
		this.embeddedEditorHost = this.attachEmbeddedEditorHost(preview);
		this.observeElementResize(this.embeddedEditorHost, () => this.layoutEmbeddedEditorPart());
		void this.openSelectedFile(resource);
	}

	private async openEditorResource(resource: URI): Promise<void> {
		if (!await this.closeEmbeddedEditorPart()) {
			return;
		}
		const filesTab = this.tabs.find(tab => tab.mode === 'files') ?? this.createTab('files');
		filesTab.selectedFile = resource;
		this.activeTabId = filesTab.id;
		this.renderShell();
	}

	private async closeEditorSidebarPreview(): Promise<void> {
		if (!await this.closeEmbeddedEditorPart()) {
			return;
		}
		const tab = this.activeTab;
		if (tab) {
			tab.selectedFile = undefined;
			tab.selectedExtension = undefined;
		}
		this.renderShell();
	}

	private renderNativeExtensions(container: HTMLElement): void {
		const host = append(container, $('.sessions-right-workbench-native-extensions'));
		this.extensionsViewPaneContainer = host;
		const pane = this.domStore.add(this.instantiationService.createInstance(ExtensionsViewPaneContainer));
		this.extensionsViewPane = pane;
		pane.create(host);
		pane.setVisible(true);
		this.observeElementResize(host, () => this.layoutExtensionsViewPane());
		this.layoutExtensionsViewPane();
	}

	private layoutExtensionsViewPane(): void {
		const pane = this.extensionsViewPane;
		const host = this.extensionsViewPaneContainer;
		if (!pane || !host) {
			return;
		}
		const width = host.clientWidth;
		const height = host.clientHeight;
		if (width > 0 && height > 0) {
			pane.layout(new Dimension(width, height));
		}
	}

	private renderExtensionsSection(container: HTMLElement, marketplace: boolean): void {
		const section = append(container, $('.sessions-right-workbench-extensions'));
		const search = append(section, $('.sessions-right-workbench-editor-search'));
		search.appendChild(renderIcon(marketplace ? Codicon.vm : Codicon.search));
		const input = append(search, $('input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = marketplace
			? localize('rightWorkbench.searchMarketplace', "Search Marketplace...")
			: localize('rightWorkbench.searchInstalledExtensions', "Search Installed Extensions...");
		input.ariaLabel = input.placeholder;

		const status = append(section, $('.sessions-right-workbench-extension-status'));
		status.setAttribute('aria-live', 'polite');
		const list = append(section, $('.sessions-right-workbench-extension-list'));
		let requestSequence = 0;

		const renderResults = (extensions: readonly IExtension[]): void => {
			clearNode(list);
			status.textContent = extensions.length === 1
				? localize('rightWorkbench.oneExtension', "1 extension")
				: localize('rightWorkbench.extensionCount', "{0} extensions", extensions.length);
			if (extensions.length === 0) {
				append(list, $('.sessions-right-workbench-extension-empty', {}, marketplace
					? localize('rightWorkbench.noMarketplaceExtensions', "No Marketplace extensions found")
					: localize('rightWorkbench.noInstalledExtensions', "No installed extensions found")));
				return;
			}
			for (const extension of extensions) {
				const row = append(list, $('button.sessions-right-workbench-extension-row')) as HTMLButtonElement;
				row.type = 'button';
				row.appendChild(renderIcon(Codicon.extensions));
				const copy = append(row, $('.sessions-right-workbench-extension-copy'));
				append(copy, $('.sessions-right-workbench-extension-name', {}, extension.displayName || extension.name));
				append(copy, $('.sessions-right-workbench-extension-description', {}, extension.description));
				const meta = append(copy, $('.sessions-right-workbench-extension-meta'));
				append(meta, $('span', {}, extension.publisherDisplayName || extension.publisher));
				append(meta, $('span', {}, extension.version));
				if (extension.isBuiltin) {
					append(meta, $('span.sessions-right-workbench-extension-badge', {}, localize('rightWorkbench.builtIn', "Built-in")));
				}
				this.domStore.add(addDisposableListener(row, EventType.CLICK, () => {
					const tab = this.activeTab;
					if (tab && (tab.mode === 'extensions' || tab.mode === 'marketplace')) {
						tab.selectedExtension = extension;
						this.renderShell();
					}
				}));
			}
		};

		const loadInstalled = async (): Promise<void> => {
			const sequence = ++requestSequence;
			status.textContent = localize('rightWorkbench.loadingExtensions', "Loading extensions...");
			const extensions = await this.extensionsWorkbenchService.queryLocal();
			if (sequence !== requestSequence || !list.isConnected || this.activeMode !== 'extensions') {
				return;
			}
			const filter = input.value.trim().toLocaleLowerCase();
			const filtered = extensions
				.filter(extension => !filter || extension.displayName.toLocaleLowerCase().includes(filter) || extension.identifier.id.toLocaleLowerCase().includes(filter))
				.sort((first, second) => (first.displayName || first.name).localeCompare(second.displayName || second.name));
			renderResults(filtered);
		};

		const loadMarketplace = async (): Promise<void> => {
			const sequence = ++requestSequence;
			status.textContent = localize('rightWorkbench.searchingMarketplace', "Searching Marketplace...");
			try {
				const query = input.value.trim();
				const result = await this.extensionsWorkbenchService.queryGallery({
					text: query || undefined,
					pageSize: 40,
					sortBy: query ? SortBy.NoneOrRelevance : SortBy.InstallCount,
				}, CancellationToken.None);
				if (sequence !== requestSequence || !list.isConnected || this.activeMode !== 'marketplace') {
					return;
				}
				renderResults(result.firstPage);
			} catch {
				if (sequence === requestSequence && list.isConnected) {
					status.textContent = localize('rightWorkbench.marketplaceUnavailable', "Marketplace is unavailable");
					clearNode(list);
				}
			}
		};

		const scheduler = this.domStore.add(new RunOnceScheduler(() => {
			void (marketplace ? loadMarketplace() : loadInstalled());
		}, 220));
		this.domStore.add(addDisposableListener(input, EventType.INPUT, () => scheduler.schedule()));
		if (!marketplace) {
			this.domStore.add(this.extensionsWorkbenchService.onChange(() => scheduler.schedule()));
		}
		void (marketplace ? loadMarketplace() : loadInstalled());
	}

	private renderEditorExtensionPreview(container: HTMLElement, extension: IExtension): void {
		const preview = append(container, $('.sessions-right-workbench-editor-preview.sessions-right-workbench-extension-detail'));
		const toolbar = append(preview, $('.sessions-right-workbench-editor-preview-toolbar'));
		const back = this.renderIconButton(toolbar, Codicon.arrowLeft, localize('rightWorkbench.backToExtensions', "Back to extensions"));
		append(toolbar, $('span.sessions-right-workbench-editor-preview-name', {}, extension.displayName || extension.name));
		this.domStore.add(addDisposableListener(back, EventType.CLICK, () => {
			void this.closeEditorSidebarPreview();
		}));

		const detail = append(preview, $('.sessions-right-workbench-extension-detail-body'));
		const hero = append(detail, $('.sessions-right-workbench-extension-detail-hero'));
		hero.appendChild(renderIcon(Codicon.extensions));
		const identity = append(hero, $('.sessions-right-workbench-extension-detail-identity'));
		append(identity, $('h2', {}, extension.displayName || extension.name));
		append(identity, $('p', {}, `${extension.publisherDisplayName || extension.publisher} · ${extension.version}`));
		append(detail, $('p.sessions-right-workbench-extension-detail-description', {}, extension.description || localize('rightWorkbench.noExtensionDescription', "No description provided.")));

		const badges = append(detail, $('.sessions-right-workbench-extension-detail-badges'));
		if (extension.isBuiltin) {
			append(badges, $('span', {}, localize('rightWorkbench.builtIn', "Built-in")));
		}
		for (const category of extension.categories.slice(0, 4)) {
			append(badges, $('span', {}, category));
		}

		const actions = append(detail, $('.sessions-right-workbench-extension-detail-actions'));
		if (extension.state === ExtensionState.Uninstalled) {
			const install = append(actions, $('button.sessions-right-workbench-extension-detail-primary', {}, localize('rightWorkbench.installExtension', "Install"))) as HTMLButtonElement;
			install.type = 'button';
			this.domStore.add(addDisposableListener(install, EventType.CLICK, () => {
				install.disabled = true;
				install.textContent = localize('rightWorkbench.installingExtension', "Installing…");
				void this.extensionsWorkbenchService.install(extension).then(installed => {
					const tab = this.activeTab;
					if (tab && (tab.mode === 'extensions' || tab.mode === 'marketplace')) {
						tab.selectedExtension = installed;
						this.renderShell();
					}
				}, () => {
					if (install.isConnected) {
						install.disabled = false;
						install.textContent = localize('rightWorkbench.installExtension', "Install");
					}
				});
			}));
		} else {
			append(actions, $('span.sessions-right-workbench-extension-detail-installed', {}, extension.isBuiltin
				? localize('rightWorkbench.builtInExtension', "Included with Backboard")
				: localize('rightWorkbench.installedExtension', "Installed")));
		}
		const link = extension.repository || extension.url || extension.supportUrl;
		if (link) {
			const openLink = append(actions, $('button.sessions-right-workbench-extension-detail-secondary', {}, localize('rightWorkbench.extensionWebsite', "Extension Website"))) as HTMLButtonElement;
			openLink.type = 'button';
			this.domStore.add(addDisposableListener(openLink, EventType.CLICK, () => {
				void this.openerService.open(link, { openExternal: true });
			}));
		}
	}

	private renderTerminal(container: HTMLElement): void {
		const terminal = append(container, $('.sessions-right-workbench-terminal'));
		this.embeddedEditorHost = this.attachEmbeddedEditorHost(terminal);
		this.observeElementResize(this.embeddedEditorHost, () => this.layoutEmbeddedEditorPart());
		void this.ensureTerminalEditor();
	}

	private getTerminalBackgroundColor(theme = this.themeService.getColorTheme()): Color | undefined {
		// Walk up from the embedded host to the first ancestor with an opaque
		// background so the xterm canvas matches the surrounding panel exactly
		// (the host itself is usually transparent).
		let element: HTMLElement | null = this.embeddedEditorHost ?? null;
		while (element) {
			const parsed = Color.Format.CSS.parse(getComputedStyle(element).backgroundColor);
			if (parsed && !parsed.isTransparent()) {
				return parsed;
			}
			element = element.parentElement;
		}
		// Fallback must match the CSS chain that paints the DOM around the
		// terminal (--rwb-bg -> agents.background), not the sidebar-tinted
		// panel token, or the xterm canvas shows as a mismatched rectangle.
		return theme.getColor(agentsBackground) ?? theme.getColor(agentsPanelBackground);
	}

	private renderFilesExplorer(container: HTMLElement): void {
		this.filesExplorerContainer = container;
		const store = this.domStore.add(new DisposableStore());
		const scopedInstantiationService = this.instantiationService.createChild(
			new ServiceCollection([IEditorService, this.createFilesEditorService()]),
			store
		);
		const hasWorkspaceFolder = this.workspaceContextService.getWorkspace().folders.length > 0;
		const explorer = hasWorkspaceFolder
			? store.add(scopedInstantiationService.createInstance(SessionsExplorerView, {
				id: SESSIONS_FILES_VIEW_ID,
				title: localize('rightWorkbench.files', "Files"),
				minimumBodySize: 0,
				maximumBodySize: Number.POSITIVE_INFINITY,
				showActions: ViewPaneShowActions.Always,
				delegate: {
					willOpenElement: () => undefined,
					didOpenElement: () => undefined
				}
			}))
			: store.add(scopedInstantiationService.createInstance(SessionsExplorerEmptyView, {
				id: SESSIONS_FILES_EMPTY_VIEW_ID,
				title: localize('rightWorkbench.files', "Files"),
				minimumBodySize: 0,
				maximumBodySize: Number.POSITIVE_INFINITY,
				showActions: ViewPaneShowActions.Always,
			}));
		explorer.headerVisible = false;
		explorer.render();
		container.appendChild(explorer.element);
		explorer.setVisible(true);
		this.filesExplorer = explorer;
		this.layoutFilesExplorer();
		this.observeElementResize(container, () => this.layoutFilesExplorer());
	}

	private getReviewCandidateDirectories(activeSession: IActiveSession | undefined): URI[] {
		const editorSidebarFolder = this.useEditorSidebar ? this.getEditorSidebarFolderUri() : undefined;
		const workspaceFolder = activeSession?.workspace.get()?.folders[0];
		const providerWorkingDirectory = activeSession
			? this.agentHostCustomizationService.getWorkingDirectory(activeSession.resource)
			: undefined;
		const providerWorkingDirectoryUri = providerWorkingDirectory ? URI.file(providerWorkingDirectory) : undefined;
		// The session's edited files pinpoint the repository even when it is
		// nested below the session root (opening a repository walks up from
		// any path inside it).
		const changeDirectories: URI[] = [];
		for (const change of this.getSessionReviewChanges(activeSession, undefined).slice(0, 3)) {
			const uri = isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri;
			if (uri?.scheme === Schemas.file) {
				changeDirectories.push(dirname(uri));
			}
		}
		return [
			editorSidebarFolder,
			providerWorkingDirectoryUri,
			...changeDirectories,
			workspaceFolder?.workingDirectory,
			workspaceFolder?.root,
			...this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri),
		].filter((uri): uri is URI => !!uri);
	}

	private getScmReviewResources(activeSession: IActiveSession | undefined): ISCMResource[] {
		const candidates = this.getReviewCandidateDirectories(activeSession);

		const repositories = Array.from(this.scmService.repositories);
		const matchedRepositories = repositories.filter(repository => {
			const rootUri = repository.provider.rootUri;
			if (!rootUri) {
				return false;
			}
			return candidates.length === 0 || candidates.some(candidate =>
				this.workspaceContextService.getWorkspaceFolder(candidate)?.uri.toString() === rootUri.toString() ||
				candidate.toString() === rootUri.toString() ||
				this.isEqualOrParentPath(candidate.fsPath, rootUri.fsPath) ||
				this.isEqualOrParentPath(rootUri.fsPath, candidate.fsPath)
			);
		});

		const reviewRepositories = matchedRepositories.length > 0 ? matchedRepositories : repositories;
		const resources = new Map<string, ISCMResource>();
		for (const repository of reviewRepositories) {
			// A never-committed repository (e.g. a freshly scaffolded project)
			// reports its entire file tree as untracked "changes" and floods
			// the rail with files the user reads as unchanged — skip it. The
			// definitive signal is an unborn HEAD in the git state; the git
			// service may need the nested repository opened first.
			if (this.isUnbornScmRepository(repository)) {
				continue;
			}
			// Same idea per group: untracked files only show alongside real
			// tracked changes; session-created files come via changesets.
			const hasTrackedChanges = repository.provider.groups.some(group => group.id !== 'untracked' && group.resources.length > 0);
			for (const group of repository.provider.groups) {
				if (group.id === 'untracked' && !hasTrackedChanges) {
					continue;
				}
				for (const resource of group.resources) {
					resources.set(resource.sourceUri.toString(), resource);
				}
			}
		}
		return Array.from(resources.values()).sort((a, b) => a.sourceUri.fsPath.localeCompare(b.sourceUri.fsPath));
	}

	/**
	 * Whether the SCM repository is backed by a git repository that has no
	 * commits yet (unborn HEAD). When the git service does not know the
	 * repository yet, it is opened in the background and the rail refreshes
	 * once the state is available; until then the repository is not treated
	 * as unborn.
	 */
	private isUnbornScmRepository(repository: ISCMRepository): boolean {
		const rootUri = repository.provider.rootUri;
		if (!rootUri) {
			return false;
		}
		const gitRepository = Array.from(this.gitService.repositories).find(candidate => candidate.rootUri.toString() === rootUri.toString());
		if (!gitRepository) {
			this.ensureGitRepositoryKnown(rootUri);
			return false;
		}
		return !gitRepository.state.get().HEAD?.commit;
	}

	/**
	 * Asks the git service to open a repository discovered through SCM so its
	 * state (HEAD, changes) becomes available to the review rail.
	 */
	private ensureGitRepositoryKnown(rootUri: URI): void {
		const key = rootUri.toString();
		if (this.pendingGitReviewRefreshKeys.has(key)) {
			return;
		}
		this.pendingGitReviewRefreshKeys.add(key);
		void this.gitService.openRepository(rootUri).then(repository => {
			this.pendingGitReviewRefreshKeys.delete(key);
			this.settleGitProbeIfIdle();
			if (repository) {
				this.refreshReviewRail(undefined);
			}
		}, () => {
			this.pendingGitReviewRefreshKeys.delete(key);
			this.settleGitProbeIfIdle();
		});
	}

	private getGitReviewResources(activeSession: IActiveSession | undefined, reader: IReader | undefined, generation: number): IReviewResource[] {
		const repositories = this.getGitReviewRepositories(activeSession);
		const resources = new Map<string, IReviewResource>();
		for (const repository of repositories) {
			// Read through the autorun's reader so git state changes (modified,
			// staged, untracked files) re-trigger the review rail refresh.
			// Deduplicate by URI (a file can be both staged and modified) so the
			// resource tree gets one node per file; later groups win.
			const state = repository.state.read(reader);
			// A never-committed repository (unborn HEAD) reports its entire
			// file tree as untracked changes — skip it entirely; those read as
			// "files with no changes". Session-created files surface via the
			// changeset tier instead.
			if (!state.HEAD?.commit) {
				continue;
			}
			for (const change of state.mergeChanges) {
				resources.set(change.uri.toString(), this.toGitReviewResource(change, 'merge', localize('rightWorkbench.gitMergeChange', "Merge"), generation));
			}
			for (const change of state.indexChanges) {
				resources.set(change.uri.toString(), this.toGitReviewResource(change, 'staged', localize('rightWorkbench.gitStagedChange', "Staged"), generation));
			}
			for (const change of state.workingTreeChanges) {
				resources.set(change.uri.toString(), this.toGitReviewResource(change, 'modified', localize('rightWorkbench.gitModifiedChange', "Modified"), generation));
			}
			// Untracked-only repositories (never-committed scaffolds) would list
			// their whole file tree as "changes" — mirror the SCM tier and only
			// show untracked files alongside real tracked changes.
			const hasTrackedChanges = state.mergeChanges.length + state.indexChanges.length + state.workingTreeChanges.length > 0;
			if (hasTrackedChanges) {
				for (const change of state.untrackedChanges) {
					resources.set(change.uri.toString(), this.toGitReviewResource(change, 'untracked', localize('rightWorkbench.gitUntrackedChange', "Untracked"), generation));
				}
			}
		}
		return Array.from(resources.values()).sort((a, b) => a.sourceUri.fsPath.localeCompare(b.sourceUri.fsPath));
	}

	private getGitReviewRepositories(activeSession: IActiveSession | undefined): IGitRepository[] {
		const candidates = this.getReviewCandidateDirectories(activeSession);
		const repositories = Array.from(this.gitService.repositories);
		const matchedRepositories = repositories.filter(repository => {
			return candidates.length === 0 || candidates.some(candidate =>
				this.isEqualOrParentPath(candidate.fsPath, repository.rootUri.fsPath) ||
				this.isEqualOrParentPath(repository.rootUri.fsPath, candidate.fsPath)
			);
		});
		return matchedRepositories.length > 0 ? matchedRepositories : repositories;
	}

	private requestGitReviewRefresh(activeSession: IActiveSession | undefined): void {
		const candidates = this.getReviewCandidateDirectories(activeSession);
		if (candidates.length === 0) {
			this.settleGitProbeIfIdle();
			return;
		}
		for (const directory of candidates) {
			const key = directory.toString();
			if (this.pendingGitReviewRefreshKeys.has(key)) {
				continue;
			}
			this.pendingGitReviewRefreshKeys.add(key);
			void this.gitService.openRepository(directory).then(repository => {
				this.pendingGitReviewRefreshKeys.delete(key);
				this.settleGitProbeIfIdle();
				if (repository) {
					this.refreshReviewRail(undefined);
				}
			}, () => {
				this.pendingGitReviewRefreshKeys.delete(key);
				this.settleGitProbeIfIdle();
			});
		}
		this.settleGitProbeIfIdle();
	}

	/**
	 * Marks the initial git repository probe as settled once no candidate
	 * lookups are in flight, and re-renders the rail so the loading empty
	 * state can flip to the definitive "no changes" one.
	 */
	private settleGitProbeIfIdle(): void {
		if (this.initialGitProbeSettled || this.pendingGitReviewRefreshKeys.size > 0) {
			return;
		}
		this.initialGitProbeSettled = true;
		this.refreshReviewRail(undefined);
	}

	private toScmReviewResources(resources: readonly ISCMResource[], generation: number): IReviewResource[] {
		return resources.map(resource => ({
			key: this.getScmReviewResourceKey(resource),
			sourceUri: resource.sourceUri,
			status: resource.decorations.tooltip ?? resource.resourceGroup.label,
			additions: this.gitReviewStats.get(resource.sourceUri.toString())?.additions,
			deletions: this.gitReviewStats.get(resource.sourceUri.toString())?.deletions,
			open: () => this.openScmReviewResource(resource, generation),
		}));
	}

	private toGitReviewResource(change: GitChange, group: string, status: string, generation: number): IReviewResource {
		const stats = this.gitReviewStats.get(change.uri.toString());
		return {
			key: this.getGitReviewResourceKey(change, group),
			sourceUri: change.uri,
			status,
			additions: stats?.additions,
			deletions: stats?.deletions,
			open: () => this.openGitReviewResource(change, generation),
		};
	}

	private getSelectedReviewResource(resources: readonly IReviewResource[]): IReviewResource {
		const activeTab = this.activeTab;
		const selectedKey = activeTab?.mode === 'review' ? activeTab.selectedReviewResourceKey : undefined;
		// Keys encode the data source (session/scm/git), which flips as richer
		// data arrives during startup — fall back to the source URI so the
		// user's selection survives those flips instead of jumping to the first
		// file.
		const selectedSourceUri = activeTab?.mode === 'review' ? activeTab.selectedReviewSourceUri?.toString() : undefined;
		const selectedReviewResource = resources.find(resource => resource.key === selectedKey)
			?? (selectedSourceUri ? resources.find(resource => resource.sourceUri.toString() === selectedSourceUri) : undefined)
			?? resources[0];
		if (activeTab?.mode === 'review') {
			activeTab.selectedReviewResourceKey = selectedReviewResource.key;
			activeTab.selectedReviewSourceUri = selectedReviewResource.sourceUri;
		}
		return selectedReviewResource;
	}

	private openSelectedReviewResource(resource: IReviewResource, generation = this.reviewContext.captureGeneration()): void {
		if (!this.isRightWorkbenchVisible || !this.reviewContext.isCurrent(generation) || !this.hasCurrentReviewResource(resource)) {
			return;
		}
		if (this.openedReviewResourceKey === resource.key && this.openedReviewResourceGeneration === generation) {
			return;
		}
		// Latch the key optimistically so concurrent refreshes don't re-open,
		// but release it when the open fails or shows nothing (e.g. the git
		// content provider was not ready yet) so the next refresh retries.
		this.openedReviewResourceKey = resource.key;
		this.openedReviewResourceGeneration = generation;
		const attempt = ++this.openedReviewResourceAttempt;
		const releaseOnFailure = (opened: boolean) => {
			if (
				!opened &&
				this.openedReviewResourceAttempt === attempt &&
				this.openedReviewResourceKey === resource.key &&
				this.openedReviewResourceGeneration === generation
			) {
				this.openedReviewResourceKey = undefined;
				this.openedReviewResourceGeneration = undefined;
			}
		};
		void this.reviewOpenSequencer.queue(async () => {
			if (!this.isRightWorkbenchVisible || !this.reviewContext.isCurrent(generation) || !this.hasCurrentReviewResource(resource) || this.activeMode !== 'review') {
				releaseOnFailure(false);
				return;
			}
			try {
				const opened = await resource.open();
				if (!this.reviewContext.isCurrent(generation)) {
					await this.closeEmbeddedEditorPart();
					return;
				}
				releaseOnFailure(opened);
			} catch {
				releaseOnFailure(false);
			}
		});
	}

	private hasCurrentReviewResource(resource: IReviewResource): boolean {
		return this.reviewResources.some(candidate => candidate.key === resource.key);
	}

	private async openScmReviewResource(resource: ISCMResource, generation: number): Promise<boolean> {
		if (resource.multiDiffEditorOriginalUri && resource.multiDiffEditorModifiedUri) {
			const input: IResourceDiffEditorInput = {
				original: { resource: resource.multiDiffEditorOriginalUri },
				modified: { resource: resource.multiDiffEditorModifiedUri },
				label: basename(resource.sourceUri),
				options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
			};
			return !!await this.openReviewEditorInEmbeddedHost(input, generation);
		}
		// Additions have no original, deletions have no modified side: show
		// whichever side exists instead of a URI that no longer resolves.
		const pane = await this.openReviewEditorInEmbeddedHost({
			resource: resource.multiDiffEditorModifiedUri ?? resource.multiDiffEditorOriginalUri ?? resource.sourceUri,
			options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
		}, generation);
		return !!pane;
	}

	private async openGitReviewResource(change: GitChange, generation: number): Promise<boolean> {
		if (change.originalUri && change.modifiedUri) {
			const input: IResourceDiffEditorInput = {
				original: { resource: change.originalUri },
				modified: { resource: change.modifiedUri },
				label: basename(change.uri),
				options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
			};
			return !!await this.openReviewEditorInEmbeddedHost(input, generation);
		}
		const pane = await this.openReviewEditorInEmbeddedHost({
			resource: change.modifiedUri ?? change.originalUri ?? change.uri,
			options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id }
		}, generation);
		return !!pane;
	}

	private getGitReviewResourceKey(change: GitChange, group: string): string {
		return `${group}:${change.uri.toString()}:${change.originalUri?.toString() ?? ''}:${change.modifiedUri?.toString() ?? ''}`;
	}

	private getScmReviewResourceKey(resource: ISCMResource): string {
		return `${resource.resourceGroup.provider.id}:${resource.resourceGroup.id}:${resource.sourceUri.toString()}:${resource.multiDiffEditorOriginalUri?.toString() ?? ''}:${resource.multiDiffEditorModifiedUri?.toString() ?? ''}`;
	}

	private requestGitReviewStats(repository: IGitRepository): void {
		const key = repository.rootUri.toString();
		if (this.pendingGitReviewStatsKeys.has(key) || this.loadedGitReviewStatsKeys.has(key)) {
			return;
		}
		this.pendingGitReviewStatsKeys.add(key);
		void repository.diffBetweenWithStats2('HEAD').then(changes => {
			this.pendingGitReviewStatsKeys.delete(key);
			this.loadedGitReviewStatsKeys.add(key);
			for (const change of changes) {
				this.gitReviewStats.set(change.uri.toString(), this.toReviewStats(change));
			}
			this.refreshReviewRail(undefined);
		}, () => {
			this.pendingGitReviewStatsKeys.delete(key);
		});
	}

	private toReviewStats(change: GitDiffChange): { additions: number; deletions: number } {
		return { additions: change.insertions, deletions: change.deletions };
	}

	private isEqualOrParentPath(childPath: string, parentPath: string): boolean {
		if (!childPath || !parentPath) {
			return false;
		}
		if (childPath === parentPath) {
			return true;
		}
		const normalizedParent = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
		return childPath.startsWith(normalizedParent);
	}

	private showReviewEmptyState(container: HTMLElement): void {
		const isLoading = this.isSessionChangesLoading || (!this.useSimpleRightWorkbench && !this.initialGitProbeSettled);
		if (this.reviewEmptyElement && this.reviewEmptyIsLoading === isLoading) {
			return;
		}
		this.reviewEmptyElement?.remove();
		this.reviewEmptyIsLoading = isLoading;
		const empty = append(container, $('.sessions-right-workbench-review-empty'));
		this.reviewEmptyElement = empty;
		empty.appendChild(renderIcon(isLoading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.diffMultiple));
		append(empty, $('h2', {}, isLoading ? localize('rightWorkbench.loadingReview', "Loading Changes") : localize('rightWorkbench.noChangesTitle', "No Changes Yet")));
		append(empty, $('p', {}, isLoading
			? localize('rightWorkbench.loadingChanges', "Looking for changes...")
			: this.useSimpleRightWorkbench
				? localize('rightWorkbench.noThreadChanges', "Files edited in this thread will appear here for review.")
				: localize('rightWorkbench.noChanges', "No changes to review.")));
	}

	private createFilesEditorService(): IEditorService {
		return new Proxy(this.editorService, {
			get: (target, property, receiver) => {
				if (property === 'openEditor') {
					return (editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, group?: PreferredGroup) => {
						if (editor instanceof EditorInput) {
							return this.openEditorInRightWorkbench(editor, this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined, group);
						}
						return this.openEditorInRightWorkbench(editor, optionsOrGroup as PreferredGroup | undefined);
					};
				}
				const value = Reflect.get(target, property, receiver);
				if (typeof value === 'function') {
					return value.bind(target);
				}
				return value;
			}
		});
	}

	private async openSelectedFile(resource: URI): Promise<void> {
		const previewMarkdown = this.activeTab?.mode === 'files' && !this.activeTab.fileViewSource && resource.path.toLocaleLowerCase().endsWith('.md');
		await this.openEditorInRightWorkbench({
			resource,
			options: {
				pinned: true,
				override: previewMarkdown ? 'vscode.markdown.preview.editor' : DEFAULT_EDITOR_ASSOCIATION.id
			}
		});
	}

	private updateFileActions(): void {
		const tab = this.activeTab;
		if (this.fileSourceButton) {
			this.fileSourceButton.hidden = !tab?.selectedFile?.path.toLowerCase().endsWith('.md');
			this.fileSourceButton.textContent = tab?.fileViewSource
				? localize('rightWorkbench.viewPreview', "View preview")
				: localize('rightWorkbench.viewSource', "View source");
		}
		if (this.fileOpenButton) {
			this.fileOpenButton.hidden = !tab?.selectedFile;
		}
	}

	private async openReviewEditorInEmbeddedHost(editor: IUntypedEditorInput, generation: number): Promise<IEditorPane | undefined> {
		return this.doOpenEditorInEmbeddedHost(editor, undefined, generation);
	}

	private async doOpenEditorInEmbeddedHost(editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, reviewGeneration?: number): Promise<IEditorPane | undefined> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost || !this.isReviewEditorOpenCurrent(reviewGeneration, embeddedHost)) {
			return undefined;
		}

		await this.ensureEmbeddedEditorPart();
		if (!this.isReviewEditorOpenCurrent(reviewGeneration, embeddedHost)) {
			embeddedHost.classList.add('review-context-hidden');
			await this.closeEmbeddedEditorPart();
			return undefined;
		}

		let editorPane: IEditorPane | undefined;
		if (editor instanceof EditorInput) {
			const options = this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined;
			editorPane = await this.editorService.openEditor(editor, {
				...options,
				modal: {
					...options?.modal,
					embeddedHost,
					maximized: true
				}
			}, MODAL_GROUP);
		} else {
			editorPane = await this.editorService.openEditor({
				...editor,
				options: {
					...editor.options,
					pinned: editor.options?.pinned ?? true,
					modal: {
						...editor.options?.modal,
						embeddedHost,
						maximized: true
					}
				}
			}, MODAL_GROUP);
		}

		if (!this.isReviewEditorOpenCurrent(reviewGeneration, embeddedHost)) {
			embeddedHost.classList.add('review-context-hidden');
			await this.closeEmbeddedEditorPart();
			return undefined;
		}

		if (reviewGeneration !== undefined) {
			embeddedHost.classList.remove('review-context-hidden');
		}
		this.applyReviewDiffEditorOptions();
		this.scheduleEmbeddedEditorPartLayout();
		return editorPane;
	}

	private isReviewEditorOpenCurrent(generation: number | undefined, embeddedHost: HTMLElement): boolean {
		return generation === undefined || (
			this.isRightWorkbenchVisible &&
			this.reviewContext.isCurrent(generation) &&
			this.activeMode === 'review' &&
			this.embeddedEditorHost === embeddedHost
		);
	}

	private async openEditorInRightWorkbench(editor: IUntypedEditorInput, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInRightWorkbench(editor: EditorInput, options?: IEditorOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInRightWorkbench(editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, _group?: PreferredGroup): Promise<IEditorPane | undefined> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return undefined;
		}

		const resource = this.getEditorResource(editor);
		if (resource) {
			const activeTab = this.activeTab;
			if (activeTab?.mode === 'files' || activeTab?.mode === 'editor') {
				if (activeTab.mode === 'files' && activeTab.selectedFile?.toString() !== resource.toString()) {
					activeTab.fileViewSource = false;
				}
				activeTab.selectedFile = resource;
				this.refreshTabLabels();
			}
			this.root?.classList.toggle('sessions-right-workbench-has-file', this.activeMode === 'files');
			if (this.filePathElement) {
				const folder = this.workspaceContextService.getWorkspaceFolder(resource)?.uri
					?? this.sessionsService.activeSession.get()?.workspace.get()?.folders[0]?.workingDirectory;
				this.filePathElement.textContent = folder && resource.path.startsWith(`${folder.path}/`)
					? resource.path.slice(folder.path.length + 1).replaceAll('/', ' › ')
					: basename(resource);
				this.filePathElement.title = resource.fsPath;
			}
			this.fileEmptyElement?.remove();
			this.fileEmptyElement = undefined;
			this.updateFileActions();
		}

		await this.ensureEmbeddedEditorPart();
		if (editor instanceof EditorInput) {
			const options = this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined;
			return this.editorService.openEditor(editor, {
				...options,
				modal: { ...options?.modal, embeddedHost, maximized: true }
			}, MODAL_GROUP);
		}

		const fileOverride = this.activeTab?.mode === 'files' && resource?.path.toLocaleLowerCase().endsWith('.md') && !this.activeTab.fileViewSource
			? 'vscode.markdown.preview.editor'
			: undefined;
		return this.editorService.openEditor({
			...editor,
			options: {
				...editor.options,
				pinned: editor.options?.pinned ?? true,
				override: fileOverride ?? editor.options?.override ?? DEFAULT_EDITOR_ASSOCIATION.id,
				modal: { ...editor.options?.modal, embeddedHost, maximized: true }
			}
		}, MODAL_GROUP);
	}

	private getEditorResource(editor: IUntypedEditorInput | EditorInput): URI | undefined {
		if (editor instanceof EditorInput) {
			return undefined;
		}
		const candidate = editor as Partial<IResourceEditorInput>;
		return URI.isUri(candidate.resource) ? candidate.resource : undefined;
	}

	private isEditorOptions(candidate: IEditorOptions | PreferredGroup | undefined): candidate is IEditorOptions {
		return typeof candidate === 'object' && candidate !== null;
	}

	private layoutFilesExplorer(): void {
		const explorer = this.filesExplorer;
		const container = this.filesExplorerContainer;
		if (!explorer || !container) {
			return;
		}
		explorer.orthogonalSize = container.clientWidth;
		explorer.layout(container.clientHeight);
	}

	private layoutEmbeddedEditorPart(): void {
		const embeddedHost = this.embeddedEditorHost;
		const activeModalPart = this.embeddedEditorPart;
		if (!embeddedHost || !activeModalPart) {
			return;
		}
		if (this.activeMode === 'browser') {
			this.hideOtherBrowserViews();
		}
		const modalElement = activeModalPart.modalElement as HTMLElement;
		if (!modalElement.classList.contains('embedded')) {
			return;
		}
		activeModalPart.updateOptions({ embeddedHost, maximized: true });
		const width = embeddedHost.clientWidth;
		const height = embeddedHost.clientHeight;
		if (width > 0 && height > 0) {
			const layoutableModalPart = activeModalPart as unknown as { layout(width: number, height: number, top: number, left: number): void };
			layoutableModalPart.layout(width, height, 0, 0);
			this.applyReviewDiffEditorOptions();
		}
	}

	private scheduleEmbeddedEditorPartLayout(): void {
		const targetWindow = this.embeddedEditorHost?.ownerDocument.defaultView;
		if (!targetWindow) {
			this.layoutEmbeddedEditorPart();
			return;
		}
		if (this.embeddedEditorLayoutFrame) {
			targetWindow.cancelAnimationFrame(this.embeddedEditorLayoutFrame);
		}
		this.embeddedEditorLayoutFrame = targetWindow.requestAnimationFrame(() => {
			this.embeddedEditorLayoutFrame = 0;
			this.layoutEmbeddedEditorPart();
			targetWindow.requestAnimationFrame(() => this.layoutEmbeddedEditorPart());
		});
	}

	private applyReviewDiffEditorOptions(): void {
		if (this.activeMode !== 'review') {
			return;
		}
		const embeddedHost = this.embeddedEditorHost;
		const pane = this.embeddedEditorPart?.activeGroup.activeEditorPane;
		const control = pane?.getControl();
		if (!embeddedHost || (!isDiffEditor(control) && !(pane instanceof MultiDiffEditor))) {
			return;
		}
		const renderSideBySide = !this.useSimpleRightWorkbench && embeddedHost.clientWidth >= REVIEW_DIFF_SIDE_BY_SIDE_MIN_WIDTH;
		const options: IDiffEditorOptions = {
			renderSideBySide,
			useInlineViewWhenSpaceIsLimited: true,
			renderSideBySideInlineBreakpoint: REVIEW_DIFF_SIDE_BY_SIDE_MIN_WIDTH,
			compactMode: false,
			enableSplitViewResizing: renderSideBySide,
			fontSize: 13,
			lineHeight: 22,
			lineNumbersMinChars: 3,
			lineDecorationsWidth: 6,
			scrollBeyondLastLine: false,
			renderOverviewRuler: false,
			overviewRulerLanes: 0,
			minimap: { enabled: false },
			glyphMargin: false,
			folding: false,
			renderLineHighlight: 'none',
			roundedSelection: false,
			padding: { top: 4, bottom: 4 },
			diffWordWrap: this.reviewWordWrap ? 'on' : 'off',
			ignoreTrimWhitespace: this.reviewHideWhitespace,
			renderIndicators: this.reviewWordDiffs,
			hideUnchangedRegions: {
				enabled: !this.reviewLoadFullFiles,
				revealLineCount: 3,
				minimumLineCount: 8,
				contextLineCount: 3
			},
			experimental: {
				showMoves: false,
				useTrueInlineView: false
			}
		};
		if (pane instanceof MultiDiffEditor) {
			pane.viewModel?.editorOptions.set(options, undefined);
		} else if (isDiffEditor(control)) {
			control.updateOptions(options);
		}
	}

	private observeElementResize(element: HTMLElement, callback: () => void): void {
		const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
		if (!ResizeObserverCtor) {
			return;
		}
		let animationFrame = 0;
		const targetWindow = element.ownerDocument.defaultView;
		const scheduleCallback = () => {
			if (!targetWindow) {
				callback();
				return;
			}
			if (animationFrame) {
				targetWindow.cancelAnimationFrame(animationFrame);
			}
			animationFrame = targetWindow.requestAnimationFrame(() => {
				animationFrame = 0;
				callback();
			});
		};
		const observer = new ResizeObserverCtor(scheduleCallback);
		observer.observe(element);
		this.domStore.add({
			dispose: () => {
				if (animationFrame && targetWindow) {
					targetWindow.cancelAnimationFrame(animationFrame);
				}
				observer.disconnect();
			}
		});
	}

	private async setBrowserUrl(tab: IRightWorkbenchTabState, value: string): Promise<void> {
		const url = this.normalizeBrowserUrl(value);
		if (!url) {
			return;
		}
		tab.browserUrl = url;
		if (!tab.browserInput) {
			this.renderShell();
			return;
		}
		await this.openBrowserEditor(tab, url);
	}

	private async openBrowserEditor(tab: IRightWorkbenchTabState, url: string | undefined): Promise<void> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return;
		}
		await this.ensureEmbeddedEditorPart();
		if (!tab.browserInput) {
			tab.browserViewId = tab.browserViewId ?? generateUuid();
			tab.browserInput = this.browserViewWorkbenchService.getOrCreateLazy(tab.browserViewId, url ? { url } : undefined);
			this.bindBrowserInput(tab, tab.browserInput);
		} else if (url && tab.browserInput.url !== url) {
			tab.browserInput.navigate(url, { source: 'urlInput' });
		}
		this.hideOtherBrowserViews();
		const pane = await this.editorService.openEditor(tab.browserInput, {
			pinned: true,
			modal: { embeddedHost, maximized: true }
		}, MODAL_GROUP);
		this.browserEditorPane = pane instanceof BrowserEditor ? pane : undefined;
		this.hideOtherBrowserViews();
		this.refreshBrowserControls();
	}

	private hideOtherBrowserViews(): void {
		const activeBrowserInput = this.activeTab?.browserInput;
		for (const input of this.browserViewWorkbenchService.getKnownBrowserViews().values()) {
			if (input !== activeBrowserInput) {
				void input.model?.setVisible(false);
			}
		}
	}

	private normalizeBrowserUrl(value: string): string | undefined {
		return normalizeRightWorkbenchUrl(value);
	}

	private attachEmbeddedEditorHost(container: HTMLElement): HTMLElement {
		// Keep the owning host stable across toolbar/tree rebuilds so the editor
		// part retains its identity and any unsaved content.
		this.embeddedEditorHost ??= $('.sessions-right-workbench-embedded-editor-host');
		this.embeddedEditorHost.classList.toggle('review-context-hidden', this.activeMode === 'review');
		return append(container, this.embeddedEditorHost);
	}

	private async ensureEmbeddedEditorPart(): Promise<void> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return;
		}

		const part = await this.editorGroupsService.createModalEditorPart({
			embeddedHost,
			maximized: true
		});
		if (this.embeddedEditorPart !== part) {
			this.embeddedEditorPartStore.clear();
			this.embeddedEditorPart = part;
			this.embeddedEditorPartStore.add(Event.once(part.onWillClose)(() => {
				if (this.embeddedEditorPart === part) {
					this.embeddedEditorPart = undefined;
				}
			}));
		}
	}

	private async closeEmbeddedEditorPart(): Promise<boolean> {
		// The tab owns its running shell. Closing the temporary editor host
		// must detach the terminal rather than terminate that shell.
		const terminal = this.activeTab?.terminalInstance;
		if (terminal && !terminal.isDisposed) {
			this.terminalEditorService.detachInstance(terminal);
		}
		if (this.activeTab?.browserInput?.model) {
			void this.activeTab.browserInput.model.setVisible(false);
		}
		const activeModalPart = this.embeddedEditorPart;
		if (!activeModalPart) {
			return true;
		}
		const modalElement = activeModalPart?.modalElement as HTMLElement | undefined;
		if (!modalElement?.classList.contains('embedded')) {
			return true;
		}
		return activeModalPart.close();
	}

	private async ensureTerminalEditor(): Promise<void> {
		const tab = this.activeTab;
		const embeddedHost = this.embeddedEditorHost;
		if (!tab || tab.mode !== 'terminal' || !embeddedHost) {
			return;
		}
		await this.ensureEmbeddedEditorPart();
		if (!tab.terminalInstance || tab.terminalInstance.isDisposed) {
			const terminalInstance = await this.terminalService.createTerminal({
				cwd: this.useEditorSidebar ? this.getEditorSidebarFolderUri() : this.sessionsService.activeSession.get()?.workspace.get()?.folders[0]?.workingDirectory,
				location: {
					viewColumn: MODAL_GROUP,
					modal: { embeddedHost }
				},
				colorProvider: this.terminalColorProvider,
			});
			tab.terminalInstance = terminalInstance;
			const store = this.tabStores.get(tab.id);
			store?.add(terminalInstance.onDisposed(() => {
				if (tab.terminalInstance === terminalInstance) {
					tab.terminalInstance = undefined;
				}
				this.refreshTabLabels();
			}));
			store?.add(terminalInstance.onTitleChanged(() => this.refreshTabLabels()));
			this.refreshTabLabels();
		}
		await this.terminalEditorService.openEditor(tab.terminalInstance, {
			viewColumn: MODAL_GROUP,
			modal: { embeddedHost, maximized: true }
		});
		this.layoutEmbeddedEditorPart();
		tab.terminalInstance.setVisible(true);
		await tab.terminalInstance.focusWhenReady(true);
	}

	private bindBrowserInput(tab: IRightWorkbenchTabState, input: BrowserEditorInput): void {
		const store = this.tabStores.get(tab.id);
		if (!store) {
			return;
		}
		store.clear();
		// Browser tabs outlive the modal editor used to display them.
		store.add(input.onBeforeDispose(event => {
			if (this.tabs.includes(tab)) {
				event.veto();
			}
		}));
		store.add(input.onWillDispose(() => {
			if (tab.browserInput === input) {
				tab.browserInput = undefined;
			}
			this.tabStores.get(tab.id)?.clear();
			this.refreshBrowserControls();
		}));
		store.add(input.onceModelResolves(model => this.bindBrowserModel(tab, model)));
	}

	private bindBrowserModel(tab: IRightWorkbenchTabState, model: IBrowserViewModel): void {
		const store = this.tabStores.get(tab.id);
		if (!store) {
			return;
		}
		if (model.device) {
			void model.setDevice(undefined);
		}
		store.add(model.onDidNavigate(() => {
			tab.browserUrl = model.url;
			this.refreshBrowserControls();
		}));
		store.add(model.onDidChangeLoadingState(() => this.refreshBrowserControls()));
		store.add(model.onDidChangeFocus(() => this.refreshBrowserControls()));
		this.refreshBrowserControls();
	}

	private refreshBrowserControls(): void {
		const tab = this.activeTab;
		const browserInput = tab?.mode === 'browser' ? tab.browserInput : undefined;
		const model = browserInput?.model;
		const url = model?.url ?? browserInput?.url ?? (tab?.mode === 'browser' ? tab.browserUrl : undefined) ?? '';
		if (this.browserUrlInput && this.browserUrlInput.ownerDocument.activeElement !== this.browserUrlInput) {
			this.browserUrlInput.value = url;
		}
		if (this.browserBackButton) {
			this.browserBackButton.disabled = !model?.canGoBack;
		}
		if (this.browserForwardButton) {
			this.browserForwardButton.disabled = !model?.canGoForward;
		}
		if (this.browserRefreshButton) {
			this.browserRefreshButton.disabled = !model && !url;
		}
		this.refreshTabLabels();
	}

	private showBrowserActionsMenu(anchor: HTMLElement): void {
		const activeTab = this.activeTab;
		const browserInput = activeTab?.mode === 'browser' ? activeTab.browserInput : undefined;
		const hasBrowser = !!this.browserEditorPane;
		const model = browserInput?.model;
		const hasUrl = !!(model?.url ?? browserInput?.url ?? (activeTab?.mode === 'browser' ? activeTab.browserUrl : undefined));
		const storageScope = model?.storageScope;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({
					id: BrowserViewCommandId.ShowFind,
					label: localize('rightWorkbench.browserFindInPage', "Find in Page"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ShowFind)
				}),
				toAction({
					id: BrowserViewCommandId.AddElementToChat,
					label: localize('rightWorkbench.browserAddElementToChat', "Add Element to Chat"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.AddElementToChat)
				}),
				toAction({
					id: BrowserViewCommandId.AddConsoleLogsToChat,
					label: localize('rightWorkbench.browserAddConsoleLogsToChat', "Add Console Logs to Chat"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.AddConsoleLogsToChat)
				}),
				toAction({
					id: BrowserViewCommandId.AddAreaScreenshotToChat,
					label: localize('rightWorkbench.browserAddAreaScreenshotToChat', "Add Area Screenshot to Chat"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.AddAreaScreenshotToChat)
				}),
				toAction({
					id: BrowserViewCommandId.AddScreenshotToChat,
					label: localize('rightWorkbench.browserAddScreenshotToChat', "Add Screenshot to Chat"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.AddScreenshotToChat)
				}),
				toAction({
					id: BrowserViewCommandId.AddFullPageScreenshotToChat,
					label: localize('rightWorkbench.browserAddFullPageScreenshotToChat', "Add Full Page Screenshot to Chat"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.AddFullPageScreenshotToChat)
				}),
				new Separator(),
				toAction({
					id: RightWorkbenchBrowserCommandId.ToggleDeviceEmulation,
					label: localize('rightWorkbench.browserDeviceEmulation', "Device Emulation"),
					enabled: hasBrowser,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ToggleDeviceEmulation)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.PickDevicePreset,
					label: localize('rightWorkbench.browserPickDevicePreset', "Emulate Device..."),
					enabled: hasBrowser,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.PickDevicePreset)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.SetUserAgent,
					label: localize('rightWorkbench.browserSetUserAgent', "Emulate User Agent..."),
					enabled: hasBrowser,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.SetUserAgent)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.ToggleMobileEmulation,
					label: localize('rightWorkbench.browserToggleMobileEmulation', "Toggle Mobile Emulation"),
					enabled: hasBrowser,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ToggleMobileEmulation)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.ResetEmulation,
					label: localize('rightWorkbench.browserResetEmulation', "Reset Emulation"),
					enabled: hasBrowser,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ResetEmulation)
				}),
				new Separator(),
				toAction({
					id: BrowserViewCommandId.HardReload,
					label: localize('rightWorkbench.browserHardReload', "Hard Reload"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.HardReload)
				}),
				toAction({
					id: BrowserViewCommandId.ToggleDevTools,
					label: localize('rightWorkbench.browserDeveloperTools', "Developer Tools"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ToggleDevTools)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.ZoomIn,
					label: localize('rightWorkbench.browserZoomIn', "Zoom In"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ZoomIn)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.ZoomOut,
					label: localize('rightWorkbench.browserZoomOut', "Zoom Out"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ZoomOut)
				}),
				toAction({
					id: RightWorkbenchBrowserCommandId.ResetZoom,
					label: localize('rightWorkbench.browserResetZoom', "Reset Zoom"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(RightWorkbenchBrowserCommandId.ResetZoom)
				}),
				new Separator(),
				toAction({
					id: BrowserViewCommandId.ShowHistory,
					label: localize('rightWorkbench.browserHistory', "History"),
					enabled: hasBrowser && hasUrl && storageScope !== BrowserViewStorageScope.Ephemeral,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ShowHistory)
				}),
				toAction({
					id: BrowserViewCommandId.ToggleFavorite,
					label: localize('rightWorkbench.browserToggleFavorite', "Add to Favorites"),
					enabled: hasBrowser && hasUrl && storageScope !== BrowserViewStorageScope.Ephemeral,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ToggleFavorite)
				}),
				toAction({
					id: BrowserViewCommandId.OpenExternal,
					label: localize('rightWorkbench.browserOpenExternal', "Open in External Browser"),
					enabled: hasBrowser && hasUrl,
					run: () => this.runBrowserCommand(BrowserViewCommandId.OpenExternal)
				}),
				toAction({
					id: BrowserViewCommandId.OpenSettings,
					label: localize('rightWorkbench.browserSettings', "Browser Settings"),
					enabled: true,
					run: () => this.runBrowserCommand(BrowserViewCommandId.OpenSettings)
				}),
				toAction({
					id: BrowserViewCommandId.ClearEphemeralStorage,
					label: localize('rightWorkbench.browserClearEphemeralStorage', "Clear Ephemeral Browser Data"),
					enabled: hasBrowser && storageScope === BrowserViewStorageScope.Ephemeral,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ClearEphemeralStorage)
				}),
				toAction({
					id: BrowserViewCommandId.ClearWorkspaceStorage,
					label: localize('rightWorkbench.browserClearWorkspaceStorage', "Clear Workspace Browser Data"),
					enabled: hasBrowser && storageScope === BrowserViewStorageScope.Workspace,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ClearWorkspaceStorage)
				}),
				toAction({
					id: BrowserViewCommandId.ClearGlobalStorage,
					label: localize('rightWorkbench.browserClearGlobalStorage', "Clear Global Browser Data"),
					enabled: hasBrowser && storageScope === BrowserViewStorageScope.Global,
					run: () => this.runBrowserCommand(BrowserViewCommandId.ClearGlobalStorage)
				}),
			],
			getMenuClassName: () => 'sessions-right-workbench-browser-actions-menu',
		});
	}

	private runBrowserCommand(commandId: string): void {
		const browserEditor = this.browserEditorPane ?? this.editorService.activeEditorPane;
		void this.commandService.executeCommand(commandId, browserEditor);
	}
}
