/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/rightWorkbenchLauncher.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions, IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane, IViewPaneOptions, ViewPaneShowActions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IEditorPane, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { MODAL_GROUP, PreferredGroup } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { CHANGES_VIEW_ID } from '../../changes/common/changes.js';
import { ChangesViewPane } from '../../changes/browser/changesView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerEmptyView, SessionsExplorerView } from '../../files/browser/filesView.js';
import { RightWorkbenchCommandId, SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID } from './rightWorkbench.js';

const rightWorkbenchIcon = registerIcon('sessions-right-workbench-icon', Codicon.layoutPanelRight, localize2('sessionsRightWorkbenchIcon', 'View icon of the right workbench in the sessions window.').value);

type RightWorkbenchMode = 'launcher' | 'review' | 'browser' | 'files' | 'terminal';

const orderedTabModes: readonly RightWorkbenchMode[] = ['review', 'browser', 'files', 'terminal'];

interface IRightWorkbenchModeRequest {
	readonly mode: RightWorkbenchMode;
	readonly browserUrl?: string;
}

interface IRightWorkbenchModeEntry {
	readonly mode: RightWorkbenchMode;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly shortcut: string;
}

const onDidRequestModeEmitter = new Emitter<IRightWorkbenchModeRequest>();
let pendingModeRequest: IRightWorkbenchModeRequest | undefined;

class RightWorkbenchViewPane extends ViewPane {

	private readonly domStore = this._register(new DisposableStore());
	private readonly modePickerStore = this._register(new DisposableStore());
	private root: HTMLElement | undefined;
	private embeddedEditorHost: HTMLElement | undefined;
	private filesExplorer: ViewPane | undefined;
	private filesExplorerContainer: HTMLElement | undefined;
	private reviewPane: ChangesViewPane | undefined;
	private reviewPaneContainer: HTMLElement | undefined;
	private reviewEmptyElement: HTMLElement | undefined;
	private filePathElement: HTMLElement | undefined;
	private fileEmptyElement: HTMLElement | undefined;
	private activeMode: RightWorkbenchMode = 'launcher';
	private readonly openTabs = new Set<RightWorkbenchMode>();
	private selectedFile: URI | undefined;
	private browserUrl: string | undefined;
	private browserInput: BrowserEditorInput | undefined;
	private browserUrlInput: HTMLInputElement | undefined;
	private browserBackButton: HTMLButtonElement | undefined;
	private browserForwardButton: HTMLButtonElement | undefined;
	private browserRefreshButton: HTMLButtonElement | undefined;
	private readonly browserInputStore = this._register(new DisposableStore());
	private terminalInstance: ITerminalInstance | undefined;
	private modePicker: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(onDidRequestModeEmitter.event(request => { void this.openMode(request); }));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.sessions-right-workbench-shell'));
		this.activateSingleSurface();
		if (pendingModeRequest) {
			this.applyModeRequest(pendingModeRequest);
			pendingModeRequest = undefined;
		}
		this.renderShell();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) {
			this.activateSingleSurface();
		}
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
		this.layoutReviewPane();
		this.layoutEmbeddedEditorPart();
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
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
	}

	private async openMode(request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
		const modeRequest = typeof request === 'string' ? { mode: request } : request;
		const previousMode = this.activeMode;
		this.activateSingleSurface();
		if (this.activeMode !== modeRequest.mode) {
			const closed = await this.closeEmbeddedEditorPart();
			if (!closed) {
				return;
			}
		}
		if (previousMode === 'launcher' && modeRequest.mode === 'browser' && !modeRequest.browserUrl) {
			this.browserUrl = undefined;
		}
		this.applyModeRequest(modeRequest);
		this.renderShell();
	}

	private applyModeRequest(request: IRightWorkbenchModeRequest): void {
		this.activeMode = request.mode;
		if (request.mode !== 'launcher') {
			this.openTabs.add(request.mode);
		}
		if (request.browserUrl) {
			this.browserUrl = this.normalizeBrowserUrl(request.browserUrl);
		}
	}

	private renderShell(): void {
		if (!this.root) {
			return;
		}

		this.closeModePicker();
		this.domStore.clear();
		clearNode(this.root);
		this.embeddedEditorHost = undefined;
		this.filesExplorer = undefined;
		this.filesExplorerContainer = undefined;
		this.reviewPane = undefined;
		this.reviewPaneContainer = undefined;
		this.reviewEmptyElement = undefined;
		this.filePathElement = undefined;
		this.fileEmptyElement = undefined;
		this.browserUrlInput = undefined;
		this.browserBackButton = undefined;
		this.browserForwardButton = undefined;
		this.browserRefreshButton = undefined;
		this.root.className = `sessions-right-workbench-shell sessions-right-workbench-mode-${this.activeMode}`;
		this.root.classList.toggle('sessions-right-workbench-has-file', this.activeMode === 'files' && !!this.selectedFile);

		if (this.activeMode === 'launcher') {
			this.renderLauncher(this.root);
			return;
		}

		this.renderModeHeader(this.root);
		const body = append(this.root, $('.sessions-right-workbench-body'));
		switch (this.activeMode) {
			case 'review':
				this.renderReview(body);
				break;
			case 'browser':
				this.renderBrowser(body);
				break;
			case 'files':
				this.renderFiles(body);
				break;
			case 'terminal':
				this.renderTerminal(body);
				break;
		}
	}

	private renderModeHeader(container: HTMLElement): void {
		const header = append(container, $('.sessions-right-workbench-header'));
		const tabs = append(header, $('.sessions-right-workbench-tabs'));
		for (const mode of orderedTabModes) {
			if (this.openTabs.has(mode)) {
				this.renderTab(tabs, mode, this.getModeIcon(mode), this.getTabLabel(mode));
			}
		}
		const add = append(tabs, $('button.sessions-right-workbench-tab-add')) as HTMLButtonElement;
		add.type = 'button';
		add.ariaLabel = localize('rightWorkbench.openModePicker', "Open Mode Picker");
		add.setAttribute('aria-haspopup', 'menu');
		add.setAttribute('aria-expanded', 'false');
		add.appendChild(renderIcon(Codicon.add));
		this.domStore.add(addDisposableListener(add, EventType.CLICK, () => this.toggleModePicker(add)));
	}

	private renderTab(container: HTMLElement, mode: RightWorkbenchMode, icon: ThemeIcon, label: string): void {
		const tab = append(container, $('button.sessions-right-workbench-tab')) as HTMLButtonElement;
		tab.type = 'button';
		tab.classList.toggle('active', this.activeMode === mode);
		tab.appendChild(renderIcon(icon));
		append(tab, $('span.sessions-right-workbench-tab-label', {}, label));
		const close = append(tab, $('span.sessions-right-workbench-tab-close')) as HTMLElement;
		close.title = localize('rightWorkbench.closeTab', "Close");
		close.ariaLabel = localize('rightWorkbench.closeTab', "Close");
		close.appendChild(renderIcon(Codicon.close));
		this.domStore.add(addDisposableListener(close, EventType.CLICK, event => {
			event.stopPropagation();
			void this.closeTab(mode);
		}));
		this.domStore.add(addDisposableListener(tab, EventType.CLICK, () => { void this.openMode(mode); }));
	}

	private renderIconButton(container: HTMLElement, icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = append(container, $('button.sessions-right-workbench-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.ariaLabel = label;
		button.title = label;
		button.appendChild(renderIcon(icon));
		return button;
	}

	private renderLauncher(container: HTMLElement): void {
		const center = append(container, $('.sessions-right-workbench-launcher-center'));
		const rows = append(center, $('.sessions-right-workbench-launcher-rows'));
		for (const entry of this.getModeEntries()) {
			this.renderLauncherRow(rows, entry);
		}
	}

	private renderLauncherRow(container: HTMLElement, entry: IRightWorkbenchModeEntry): void {
		const button = append(container, $('button.sessions-right-workbench-launcher-row')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(entry.icon));
		append(button, $('.sessions-right-workbench-launcher-label', {}, entry.label));
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

		const picker = append(root, $('.sessions-right-workbench-mode-picker'));
		picker.setAttribute('role', 'menu');
		const rootRect = root.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const pickerWidth = 220;
		const left = Math.max(8, Math.min(anchorRect.left - rootRect.left - 2, rootRect.width - pickerWidth - 8));
		picker.style.left = `${left}px`;
		picker.style.top = `${anchorRect.bottom - rootRect.top + 6}px`;

		for (const entry of this.getModeEntries()) {
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
			void this.openMode(entry.mode);
		}));
	}

	private closeModePicker(): void {
		this.modePicker?.remove();
		this.modePicker = undefined;
		this.modePickerStore.clear();
	}

	private getModeEntries(): readonly IRightWorkbenchModeEntry[] {
		return [
			{ mode: 'review', icon: Codicon.diffMultiple, label: localize('rightWorkbench.review', "Review"), shortcut: '' },
			{ mode: 'terminal', icon: Codicon.terminal, label: localize('rightWorkbench.terminal', "Terminal"), shortcut: '' },
			{ mode: 'browser', icon: Codicon.globe, label: localize('rightWorkbench.browser', "Browser"), shortcut: '' },
			{ mode: 'files', icon: Codicon.files, label: localize('rightWorkbench.files', "Files"), shortcut: '' },
		];
	}

	private getModeIcon(mode: RightWorkbenchMode): ThemeIcon {
		switch (mode) {
			case 'review':
				return Codicon.diffMultiple;
			case 'browser':
				return Codicon.globe;
			case 'files':
				return Codicon.file;
			case 'terminal':
				return Codicon.terminal;
			case 'launcher':
				return Codicon.layoutPanelRight;
		}
	}

	private getTabLabel(mode: RightWorkbenchMode): string {
		switch (mode) {
			case 'review':
				return localize('rightWorkbench.review', "Review");
			case 'browser':
				return localize('rightWorkbench.newTab', "New tab");
			case 'files':
				return localize('rightWorkbench.openFile', "Open file");
			case 'terminal':
				return localize('rightWorkbench.terminal', "Terminal");
			case 'launcher':
				return localize('rightWorkbench.launcher', "Launcher");
		}
	}

	private async closeTab(mode: RightWorkbenchMode): Promise<void> {
		if (!this.openTabs.has(mode)) {
			return;
		}

		this.openTabs.delete(mode);
		if (mode === 'terminal') {
			this.terminalInstance = undefined;
		}
		if (this.activeMode === mode) {
			const closed = await this.closeEmbeddedEditorPart();
			if (!closed) {
				this.openTabs.add(mode);
				return;
			}
			this.activeMode = this.getNextActiveMode(mode);
		}
		this.renderShell();
	}

	private getNextActiveMode(closedMode: RightWorkbenchMode): RightWorkbenchMode {
		for (const mode of orderedTabModes) {
			if (mode !== closedMode && this.openTabs.has(mode)) {
				return mode;
			}
		}
		return 'launcher';
	}

	private renderBrowser(container: HTMLElement): void {
		const chrome = append(container, $('.sessions-right-workbench-browser-chrome'));
		const nav = append(chrome, $('.sessions-right-workbench-browser-nav'));
		this.browserBackButton = this.renderIconButton(nav, Codicon.arrowLeft, localize('rightWorkbench.browserBack', "Back"));
		this.browserForwardButton = this.renderIconButton(nav, Codicon.arrowRight, localize('rightWorkbench.browserForward', "Forward"));
		this.browserRefreshButton = this.renderIconButton(nav, Codicon.refresh, localize('rightWorkbench.browserRefresh', "Refresh"));
		const url = append(nav, $('input.sessions-right-workbench-browser-url')) as HTMLInputElement;
		this.browserUrlInput = url;
		url.placeholder = localize('rightWorkbench.browserUrlPlaceholder', "Enter a URL");
		url.type = 'text';
		url.spellcheck = false;
		url.value = this.browserInput?.url ?? this.browserUrl ?? '';
		this.domStore.add(addDisposableListener(this.browserBackButton, EventType.CLICK, () => { void this.browserInput?.model?.goBack(); }));
		this.domStore.add(addDisposableListener(this.browserForwardButton, EventType.CLICK, () => { void this.browserInput?.model?.goForward(); }));
		this.domStore.add(addDisposableListener(this.browserRefreshButton, EventType.CLICK, () => { void this.browserInput?.model?.reload(); }));
		this.domStore.add(addDisposableListener(url, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				void this.setBrowserUrl(url.value);
			}
		}));
		this.renderIconButton(nav, Codicon.kebabVertical, localize('rightWorkbench.browserMore', "More Actions"));

		const content = append(container, $('.sessions-right-workbench-browser-content'));
		this.embeddedEditorHost = append(content, $('.sessions-right-workbench-embedded-editor-host'));
		const currentUrl = this.browserInput?.url ?? this.browserUrl;
		if (currentUrl) {
			this.browserUrl = currentUrl;
			url.value = currentUrl;
			void this.openBrowserEditor(currentUrl);
		} else {
			const empty = append(content, $('.sessions-right-workbench-browser-empty'));
			empty.appendChild(renderIcon(Codicon.globe));
			append(empty, $('h2', {}, localize('rightWorkbench.startBrowsing', "Start browsing")));
			append(empty, $('p', {}, localize('rightWorkbench.enterUrlToOpenPage', "Enter a URL to open a page")));
		}
		this.refreshBrowserControls();
	}

	private renderReview(container: HTMLElement): void {
		const review = append(container, $('.sessions-right-workbench-review'));
		const editor = append(review, $('.sessions-right-workbench-review-main'));
		const reviewBody = append(editor, $('.sessions-right-workbench-review-editor'));
		this.embeddedEditorHost = append(reviewBody, $('.sessions-right-workbench-embedded-editor-host'));

		const rail = append(review, $('.sessions-right-workbench-review-rail'));
		this.renderReviewPane(rail);

		this.domStore.add(autorun(reader => {
			if (this.activeMode !== 'review') {
				return;
			}
			const activeSession = this.sessionsService.activeSession.read(reader);
			const changesets = activeSession?.changesets.read(reader) ?? [];
			const selectedChangeset = changesets.find(changeset => changeset.isDefault.read(reader) && changeset.isEnabled.read(reader))
				?? changesets.find(changeset => changeset.isEnabled.read(reader));
			const changes = selectedChangeset?.changes.read(reader) ?? activeSession?.changes.read(reader) ?? [];
			if (!activeSession || changes.length === 0) {
				this.showReviewEmptyState(reviewBody);
				return;
			}
			this.reviewEmptyElement?.remove();
			this.reviewEmptyElement = undefined;
		}));
	}

	private renderFiles(container: HTMLElement): void {
		const files = append(container, $('.sessions-right-workbench-files'));
		const editor = append(files, $('.sessions-right-workbench-file-editor'));
		this.filePathElement = append(editor, $('.sessions-right-workbench-file-path', {}, this.selectedFile ? basename(this.selectedFile) : '/'));
		const editorBody = append(editor, $('.sessions-right-workbench-file-editor-body'));
		this.embeddedEditorHost = append(editorBody, $('.sessions-right-workbench-embedded-editor-host'));
		if (!this.selectedFile) {
			const empty = append(editorBody, $('.sessions-right-workbench-file-empty'));
			this.fileEmptyElement = empty;
			empty.appendChild(renderIcon(Codicon.folderOpened));
			append(empty, $('h2', {}, localize('rightWorkbench.openFile', "Open file")));
			append(empty, $('p', {}, localize('rightWorkbench.selectFileFromTree', "Select a file from the workspace tree")));
		} else {
			void this.openSelectedFile(this.selectedFile);
		}

		const tree = append(files, $('.sessions-right-workbench-file-tree'));
		const filter = append(tree, $('.sessions-right-workbench-file-filter'));
		filter.appendChild(renderIcon(Codicon.search));
		const input = append(filter, $('input')) as HTMLInputElement;
		input.placeholder = localize('rightWorkbench.filterFiles', "Filter files...");
		input.type = 'text';
		const explorerHost = append(tree, $('.sessions-right-workbench-file-explorer-host'));
		this.renderFilesExplorer(explorerHost);
	}

	private renderTerminal(container: HTMLElement): void {
		const terminal = append(container, $('.sessions-right-workbench-terminal'));
		this.embeddedEditorHost = append(terminal, $('.sessions-right-workbench-embedded-editor-host'));
		void this.ensureTerminalEditor();
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

	private renderReviewPane(container: HTMLElement): void {
		this.reviewPaneContainer = container;
		const store = this.domStore.add(new DisposableStore());
		const scopedInstantiationService = this.instantiationService.createChild(
			new ServiceCollection([IEditorService, this.createEmbeddedEditorService()]),
			store
		);
		const reviewPane = store.add(scopedInstantiationService.createInstance(ChangesViewPane, {
			id: CHANGES_VIEW_ID,
			title: localize('rightWorkbench.review', "Review"),
			minimumBodySize: 0,
			maximumBodySize: Number.POSITIVE_INFINITY,
			showActions: ViewPaneShowActions.Always,
		}));
		reviewPane.headerVisible = false;
		reviewPane.render();
		container.appendChild(reviewPane.element);
		reviewPane.setVisible(true);
		this.reviewPane = reviewPane;
		this.layoutReviewPane();
		this.observeElementResize(container, () => this.layoutReviewPane());
	}

	private showReviewEmptyState(container: HTMLElement): void {
		if (this.reviewEmptyElement) {
			return;
		}
		const empty = append(container, $('.sessions-right-workbench-review-empty'));
		this.reviewEmptyElement = empty;
		empty.appendChild(renderIcon(Codicon.diffMultiple));
		append(empty, $('h2', {}, localize('rightWorkbench.review', "Review")));
		append(empty, $('p', {}, localize('rightWorkbench.noChanges', "No changes to review.")));
	}

	private createEmbeddedEditorService(): IEditorService {
		return new Proxy(this.editorService, {
			get: (target, property, receiver) => {
				if (property === 'openEditor') {
					return (editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, group?: PreferredGroup) => {
						if (editor instanceof EditorInput) {
							return this.openEditorInEmbeddedHost(editor, this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined, group);
						}
						return this.openEditorInEmbeddedHost(editor, optionsOrGroup as PreferredGroup | undefined);
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
		await this.openEditorInRightWorkbench({ resource, options: { pinned: true } });
	}

	private async openEditorInEmbeddedHost(editor: IUntypedEditorInput, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInEmbeddedHost(editor: EditorInput, options?: IEditorOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInEmbeddedHost(editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, _group?: PreferredGroup): Promise<IEditorPane | undefined> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return undefined;
		}

		await this.ensureEmbeddedEditorPart();
		if (editor instanceof EditorInput) {
			const options = this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined;
			return this.editorService.openEditor(editor, {
				...options,
				modal: {
					...options?.modal,
					embeddedHost,
					maximized: true
				}
			}, MODAL_GROUP);
		}

		return this.editorService.openEditor({
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

	private async openEditorInRightWorkbench(editor: IUntypedEditorInput, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInRightWorkbench(editor: EditorInput, options?: IEditorOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
	private async openEditorInRightWorkbench(editor: IUntypedEditorInput | EditorInput, optionsOrGroup?: IEditorOptions | PreferredGroup, _group?: PreferredGroup): Promise<IEditorPane | undefined> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return undefined;
		}

		const resource = this.getEditorResource(editor);
		if (resource) {
			this.selectedFile = resource;
			this.root?.classList.toggle('sessions-right-workbench-has-file', this.activeMode === 'files');
			if (this.filePathElement) {
				this.filePathElement.textContent = basename(resource);
			}
			this.fileEmptyElement?.remove();
			this.fileEmptyElement = undefined;
		}

		await this.ensureEmbeddedEditorPart();
		if (editor instanceof EditorInput) {
			const options = this.isEditorOptions(optionsOrGroup) ? optionsOrGroup : undefined;
			return this.editorService.openEditor(editor, {
				...options,
				modal: { ...options?.modal, embeddedHost, maximized: true }
			}, MODAL_GROUP);
		}

		return this.editorService.openEditor({
			...editor,
			options: {
				...editor.options,
				pinned: editor.options?.pinned ?? true,
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

	private layoutReviewPane(): void {
		const reviewPane = this.reviewPane;
		const container = this.reviewPaneContainer;
		if (!reviewPane || !container) {
			return;
		}
		reviewPane.orthogonalSize = container.clientWidth;
		reviewPane.layout(container.clientHeight);
	}

	private layoutEmbeddedEditorPart(): void {
		const embeddedHost = this.embeddedEditorHost;
		const activeModalPart = this.editorGroupsService.activeModalEditorPart;
		if (!embeddedHost || !activeModalPart) {
			return;
		}
		const modalElement = activeModalPart.modalElement as HTMLElement;
		if (!modalElement.classList.contains('embedded')) {
			return;
		}
		activeModalPart.updateOptions({ embeddedHost, maximized: true });
	}

	private observeElementResize(element: HTMLElement, callback: () => void): void {
		const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
		if (!ResizeObserverCtor) {
			return;
		}
		const observer = new ResizeObserverCtor(callback);
		observer.observe(element);
		this.domStore.add({ dispose: () => observer.disconnect() });
	}

	private async setBrowserUrl(value: string): Promise<void> {
		const url = this.normalizeBrowserUrl(value);
		if (!url) {
			return;
		}
		this.browserUrl = url;
		if (!this.browserInput) {
			this.renderShell();
			return;
		}
		await this.openBrowserEditor(url);
	}

	private async openBrowserEditor(url: string): Promise<void> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return;
		}
		await this.ensureEmbeddedEditorPart();
		if (!this.browserInput) {
			this.browserInput = this.browserViewWorkbenchService.getOrCreateLazy(generateUuid(), { url });
			this.bindBrowserInput(this.browserInput);
		} else if (this.browserInput.url !== url) {
			this.browserInput.navigate(url, { source: 'urlInput' });
		}
		await this.editorService.openEditor(this.browserInput, {
			pinned: true,
			modal: { embeddedHost, maximized: true }
		}, MODAL_GROUP);
		this.refreshBrowserControls();
	}

	private normalizeBrowserUrl(value: string): string | undefined {
		const trimmed = value.trim();
		if (!trimmed) {
			return undefined;
		}
		const explicitUrlMatch = /[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^\s"'<>]+/.exec(trimmed);
		if (explicitUrlMatch) {
			return explicitUrlMatch[0];
		}
		const localhostMatch = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>]*)?/i.exec(trimmed);
		if (localhostMatch) {
			return `http://${localhostMatch[0]}`;
		}
		const portMatch = /(?:^|\s):?(?<port>\d{2,5})(?<path>\/[^\s"'<>]*)?(?:\s|$)/.exec(trimmed);
		if (portMatch?.groups) {
			return `http://localhost:${portMatch.groups.port}${portMatch.groups.path ?? ''}`;
		}
		return `https://${trimmed.replace(/^[<("'`]+|[>)"'`,.]+$/g, '')}`;
	}

	private async ensureEmbeddedEditorPart(): Promise<void> {
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return;
		}

		const activeModalPart = this.editorGroupsService.activeModalEditorPart;
		if (activeModalPart) {
			const modalElement = activeModalPart.modalElement as HTMLElement;
			modalElement.classList.add('embedded');
			if (modalElement.parentElement !== embeddedHost) {
				embeddedHost.appendChild(modalElement);
			}
			activeModalPart.updateOptions({ embeddedHost, maximized: true });
			return;
		}

		await this.editorGroupsService.createModalEditorPart({
			embeddedHost,
			maximized: true
		});
	}

	private async closeEmbeddedEditorPart(): Promise<boolean> {
		const activeModalPart = this.editorGroupsService.activeModalEditorPart;
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
		const embeddedHost = this.embeddedEditorHost;
		if (!embeddedHost) {
			return;
		}
		await this.ensureEmbeddedEditorPart();
		if (this.terminalInstance) {
			await this.terminalEditorService.openEditor(this.terminalInstance, {
			viewColumn: MODAL_GROUP,
				modal: { embeddedHost, maximized: true }
			});
			return;
		}
		this.terminalInstance = await this.terminalService.createTerminal({
			location: {
				viewColumn: MODAL_GROUP,
				modal: { embeddedHost }
			},
		});
		await this.terminalEditorService.openEditor(this.terminalInstance, {
			viewColumn: MODAL_GROUP,
			modal: { embeddedHost, maximized: true }
		});
	}

	private bindBrowserInput(input: BrowserEditorInput): void {
		this.browserInputStore.clear();
		this.browserInputStore.add(input.onWillDispose(() => {
			if (this.browserInput === input) {
				this.browserInput = undefined;
			}
			this.browserInputStore.clear();
			this.refreshBrowserControls();
		}));
		this.browserInputStore.add(input.onceModelResolves(model => this.bindBrowserModel(model)));
	}

	private bindBrowserModel(model: IBrowserViewModel): void {
		this.browserInputStore.add(model.onDidNavigate(() => {
			this.browserUrl = model.url;
			this.refreshBrowserControls();
		}));
		this.browserInputStore.add(model.onDidChangeLoadingState(() => this.refreshBrowserControls()));
		this.browserInputStore.add(model.onDidChangeFocus(() => this.refreshBrowserControls()));
		this.refreshBrowserControls();
	}

	private refreshBrowserControls(): void {
		const model = this.browserInput?.model;
		const url = model?.url ?? this.browserInput?.url ?? this.browserUrl ?? '';
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
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const rightWorkbenchContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID,
	title: localize2('rightWorkbench', "Right Workbench"),
	icon: rightWorkbenchIcon,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID,
	name: localize2('rightWorkbench.launcher', "Right Workbench"),
	containerIcon: rightWorkbenchIcon,
	ctorDescriptor: new SyncDescriptor(RightWorkbenchViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	windowEnablement: WindowEnablement.Sessions,
}], rightWorkbenchContainer);

async function openRightWorkbenchMode(accessor: ServicesAccessor, request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
	const modeRequest = typeof request === 'string' ? { mode: request } : request;
	pendingModeRequest = modeRequest;
	const layoutService = accessor.get(IWorkbenchLayoutService);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	layoutService.setPartHidden(true, Parts.EDITOR_PART);
	layoutService.setPartHidden(true, Parts.PANEL_PART);
	await accessor.get(IViewsService).openViewContainer(SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, true);
	onDidRequestModeEmitter.fire(modeRequest);
	pendingModeRequest = undefined;
}

registerAction2(class OpenRightWorkbenchLauncherModeAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenLauncherMode,
			title: localize2('rightWorkbench.openLauncherMode', "Open Right Workbench Launcher"),
			icon: Codicon.layoutPanelRight,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'launcher');
	}
});

registerAction2(class OpenRightWorkbenchReviewAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenReview,
			title: localize2('rightWorkbench.openReview', "Open Review in Right Workbench"),
			icon: Codicon.diffMultiple,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'review');
	}
});

registerAction2(class OpenRightWorkbenchFilesAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenFiles,
			title: localize2('rightWorkbench.openFiles', "Open Files in Right Workbench"),
			icon: Codicon.files,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'files');
	}
});

registerAction2(class OpenRightWorkbenchBrowserAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenBrowser,
			title: localize2('rightWorkbench.openBrowser', "Open Browser in Right Workbench"),
			icon: Codicon.globe,
		});
	}

	override async run(accessor: ServicesAccessor, urlOrOptions?: string | { url?: string }): Promise<void> {
		const browserUrl = typeof urlOrOptions === 'string' ? urlOrOptions : urlOrOptions?.url;
		await openRightWorkbenchMode(accessor, { mode: 'browser', browserUrl });
	}
});

registerAction2(class OpenRightWorkbenchTerminalAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenTerminal,
			title: localize2('rightWorkbench.openTerminal', "Open Terminal in Right Workbench"),
			icon: Codicon.terminal,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'terminal');
	}
});
