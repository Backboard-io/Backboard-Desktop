/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import './media/auxiliaryBarPart.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../base/browser/dom.js';
import { RunOnceScheduler, timeout } from '../../../base/common/async.js';
import { basename, extUri, joinPath } from '../../../base/common/resources.js';
import { localize } from '../../../nls.js';
import { Codicon } from '../../../base/common/codicons.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { BrowserViewUri } from '../../../platform/browserView/common/browserViewUri.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IFileService, IFileStat } from '../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ActiveAuxiliaryContext, AuxiliaryBarFocusContext } from '../../../workbench/common/contextkeys.js';
import { ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground, agentsBadgeBackground, agentsBadgeForeground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IEditorService, SIDE_GROUP } from '../../../workbench/services/editor/common/editorService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../base/common/actions.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation, IActionViewItem } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService, IMenu, MenuId, MenuItemAction } from '../../../platform/actions/common/actions.js';
import { Menus } from '../menus.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { DropdownWithPrimaryActionViewItem } from '../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { getFlatContextMenuActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { mainWindow } from '../../../base/browser/window.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { linesDiffComputers } from '../../../editor/common/diff/linesDiffComputers.js';
import { ICompositeTitleLabel } from '../../../workbench/browser/parts/compositePart.js';
import { CHANGES_VIEW_CONTAINER_ID } from '../../contrib/changes/common/changes.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../contrib/files/browser/filesView.js';
import { ISandboxPreviewService, SESSIONS_PREVIEW_CONTAINER_ID } from '../../contrib/preview/common/preview.js';
import { ISandboxWorkspaceChange, ISandboxWorkspaceChangesService, SandboxWorkspaceChangeType } from '../../contrib/sandboxChanges/common/sandboxChanges.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../services/sessions/common/session.js';

interface ISandboxDiffLine {
	readonly type: 'context' | 'added' | 'removed';
	readonly oldLineNumber: number | undefined;
	readonly newLineNumber: number | undefined;
	readonly text: string;
}

interface ISandboxDiffHunk {
	readonly header: string;
	readonly lines: readonly ISandboxDiffLine[];
}

/**
 * Auxiliary bar part specifically for agent sessions workbench.
 * This is a simplified version of the AuxiliaryBarPart for agent session contexts.
 */
export class AuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.agentsession.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.agentsession.auxiliarybar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.agentsession.auxiliarybar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.auxiliarybar.viewContainersWorkspaceState';

	/** Visual margin values for the card-like appearance */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 8;
	static readonly MARGIN_LEFT = 8;

	// Action ID for run script - defined here to avoid layering issues
	private static readonly RUN_SCRIPT_ACTION_ID = 'workbench.action.agentSessions.runScript';
	private static readonly RUN_SCRIPT_DROPDOWN_MENU_ID = MenuId.for('AgentSessionsRunScriptDropdown');
	private static readonly DEFAULT_MINIMUM_WIDTH = 320;

	// Run script dropdown management
	private readonly _runScriptDropdown = this._register(new MutableDisposable<DropdownWithPrimaryActionViewItem>());
	private readonly _runScriptMenu = this._register(new MutableDisposable<IMenu>());
	private readonly _runScriptMenuListener = this._register(new MutableDisposable<IDisposable>());
	private readonly _sandboxOutputButtons = new Map<string, HTMLButtonElement>();
	private readonly _sandboxExpandedResources = new Set<string>();
	private readonly _sandboxExpandedChanges = new Set<string>();
	private readonly _sandboxTouchedChanges = new Set<string>();
	private readonly _sandboxOutputRefreshScheduler = this._register(new RunOnceScheduler(() => void this._renderActiveSandboxOutput(), 100));
	private _sandboxOutputContent: HTMLElement | undefined;
	private _activeSandboxOutputId = SESSIONS_FILES_CONTAINER_ID;
	private _sandboxOutputGeneration = 0;

	// Sessions-specific auxiliary bar dimensions (intentionally not tied to the sessions SidebarPart values)
	override get minimumWidth(): number {
		return AuxiliaryBarPart.DEFAULT_MINIMUM_WIDTH;
	}
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean {
		return this.hasAttachedEditorRequiringSidebarSpace() ? false : super.snap;
	}

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();

		if (!activeComposite) {
			return undefined;
		}

		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 340);
	}

	readonly priority = LayoutPriority.Low;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ISandboxWorkspaceChangesService private readonly _sandboxWorkspaceChangesService: ISandboxWorkspaceChangesService,
	) {
		super(
			Parts.AUXILIARYBAR_PART,
			{
				hasTitle: true,
				trailingSeparator: false,
				borderWidth: () => 0,
			},
			AuxiliaryBarPart.activeViewSettingsKey,
			ActiveAuxiliaryContext.bindTo(contextKeyService),
			AuxiliaryBarFocusContext.bindTo(contextKeyService),
			'auxiliarybar',
			'auxiliarybar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.AuxiliaryBar,
			Extensions.Auxiliary,
			Menus.AuxiliaryBarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._sandboxOutputRefreshScheduler.schedule();
		}));
		this._register(this._fileService.onDidFilesChange(() => this._sandboxOutputRefreshScheduler.schedule()));
		this._register(this._sandboxWorkspaceChangesService.onDidChange(() => this._sandboxOutputRefreshScheduler.schedule()));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART || e.partId === Parts.EDITOR_PART) {
				this._onDidChange.fire(undefined);
			}

			// The card's inner area dimensions depend on editor visibility
			// (see layout()). Re-run layout with the cached grid dimensions
			// so the inner area is sized correctly without waiting for the
			// next grid layout pass.
			if (e.partId === Parts.EDITOR_PART && this.dimension && this.contentPosition) {
				this.layout(this.dimension.width, this.dimension.height, this.contentPosition.top, this.contentPosition.left);
			}
		}));
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement | undefined {
		const titleArea = super.createTitleArea(parent);
		if (!titleArea) {
			return undefined;
		}

		titleArea.classList.add('sandbox-output-title');
		const tabs = $('.sandbox-output-tabs');
		titleArea.insertBefore(tabs, titleArea.firstChild);

		this._appendSandboxOutputButton(tabs, SESSIONS_FILES_CONTAINER_ID, localize('sandboxOutput.files', "Files"), Codicon.files, () => this._openFiles(true));
		this._appendSandboxOutputButton(tabs, CHANGES_VIEW_CONTAINER_ID, localize('sandboxOutput.changes', "Changes"), Codicon.gitCompare, () => this._openChanges(true));
		this._appendSandboxOutputButton(tabs, SESSIONS_PREVIEW_CONTAINER_ID, localize('sandboxOutput.preview', "Preview"), Codicon.preview, () => this._openPreview(true));

		queueMicrotask(() => this._setActiveSandboxOutputButton(this._activeSandboxOutputId));

		return titleArea;
	}

	protected override createTitleLabel(parent: HTMLElement): ICompositeTitleLabel {
		const titleLabel = super.createTitleLabel(parent);
		if (this.titleLabelElement) {
			this.titleLabelElement.draggable = false;
		}
		return titleLabel;
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = super.createContentArea(parent);
		contentArea.classList.add('sandbox-output-host');
		this._sandboxOutputContent = append(contentArea, $('.sandbox-output-content'));
		queueMicrotask(() => {
			void this._sandboxWorkspaceChangesService.ensureBaseline(this._getActiveSession());
			void this._renderActiveSandboxOutput();
		});
		return contentArea;
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.setAttribute('role', 'complementary');
		parent.setAttribute('aria-label', localize('auxiliaryBarAriaLabel', "Sandbox Output"));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';

		// Clear borders - the card appearance uses border-radius instead
		container.style.borderLeftColor = '';
		container.style.borderRightColor = '';
		container.style.borderLeftStyle = '';
		container.style.borderRightStyle = '';
		container.style.borderLeftWidth = '';
		container.style.borderRightWidth = '';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		const $this = this;
		return {
			partContainerClass: 'auxiliarybar',
			pinnedViewContainersKey: AuxiliaryBarPart.pinnedViewsKey,
			placeholderViewContainersKey: AuxiliaryBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: AuxiliaryBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			get overflowActionSize() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? 40 : 30; },
			colors: theme => ({
				activeBackgroundColor: theme.getColor(agentsPanelBackground),
				inactiveBackgroundColor: theme.getColor(agentsPanelBackground),
				get activeBorderBottomColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER); },
				get activeForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND); },
				get inactiveForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND); },
				badgeBackground: theme.getColor(agentsBadgeBackground),
				badgeForeground: theme.getColor(agentsBadgeForeground),
				get dragAndDropBorder() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_DRAG_AND_DROP_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER); }
			}),
			compact: true
		};
	}

	protected override actionViewItemProvider(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		// Create a DropdownWithPrimaryActionViewItem for the run script action
		if (action.id === AuxiliaryBarPart.RUN_SCRIPT_ACTION_ID && action instanceof MenuItemAction) {
			// Create and store the menu so we can listen for changes
			if (!this._runScriptMenu.value) {
				this._runScriptMenu.value = this.menuService.createMenu(AuxiliaryBarPart.RUN_SCRIPT_DROPDOWN_MENU_ID, this.contextKeyService);
				this._runScriptMenuListener.value = this._runScriptMenu.value.onDidChange(() => this._updateRunScriptDropdown());
			}

			const dropdownActions = this._getRunScriptDropdownActions();

			const dropdownAction: IAction = {
				id: 'runScriptDropdown',
				label: '',
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { }
			};

			this._runScriptDropdown.value = this.instantiationService.createInstance(
				DropdownWithPrimaryActionViewItem,
				action,
				dropdownAction,
				dropdownActions,
				'',
				{
					hoverDelegate: options.hoverDelegate,
					getKeyBinding: (action: IAction) => this.keybindingService.lookupKeybinding(action.id, this.contextKeyService)
				}
			);

			return this._runScriptDropdown.value;
		}

		return super.actionViewItemProvider(action, options);
	}

	private _getRunScriptDropdownActions(): IAction[] {
		if (!this._runScriptMenu.value) {
			return [];
		}
		return getFlatContextMenuActions(this._runScriptMenu.value.getActions({ shouldForwardArgs: true }));
	}

	private _updateRunScriptDropdown(): void {
		if (this._runScriptDropdown.value) {
			const dropdownActions = this._getRunScriptDropdownActions();
			const dropdownAction: IAction = {
				id: 'runScriptDropdown',
				label: '',
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { }
			};
			this._runScriptDropdown.value.update(dropdownAction, dropdownActions);
		}
	}

	private hasAttachedEditorRequiringSidebarSpace(): boolean {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			&& this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow);
	}

	private fillExtraContextMenuActions(_actions: IAction[]): void { }

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}

		const borderTotal = 2; // 1px border on each side

		// The right gutter is provided by the workbench grid (see Workbench.layout).
		// The bottom margin is present when the panel is visible (paired with the panel's
		// top margin to center the sash) and 0 when the panel is hidden (so the card
		// fills its cell; the workbench grid's 10px bottom gutter provides the visible gap).
		// When the editor is visible, padding-left keeps the inner content position
		// invariant (matching the editor-hidden state where margin-left applies instead).
		const editorVisible = this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow);
		const marginLeft = editorVisible ? 0 : AuxiliaryBarPart.MARGIN_LEFT;
		const paddingLeft = editorVisible ? AuxiliaryBarPart.MARGIN_LEFT : 0;
		const marginBottom = this.layoutService.isVisible(Parts.PANEL_PART)
			? AuxiliaryBarPart.MARGIN_BOTTOM
			: 0;

		super.layout(
			width - marginLeft - borderTotal - paddingLeft,
			height - AuxiliaryBarPart.MARGIN_TOP - marginBottom - borderTotal,
			top, left
		);

		// Restore the full grid-allocated dimensions so that Part.relayout() works correctly.
		// Part.layout() only stores _dimension and _contentPosition - no other side effects.
		Part.prototype.layout.call(this, width, height, top, left);
	}

	override toJSON(): object {
		return {
			type: Parts.AUXILIARYBAR_PART
		};
	}

	private _appendSandboxOutputButton(container: HTMLElement, id: string, label: string, icon: ThemeIcon, onClick: () => void): void {
		const button = $('.sandbox-output-tab') as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		const iconElement = $('span.codicon');
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.appendChild(iconElement);
		const labelElement = $('span.sandbox-output-tab-label');
		labelElement.textContent = label;
		button.appendChild(labelElement);
		container.appendChild(button);
		this._sandboxOutputButtons.set(id, button);
		this._register(addDisposableListener(button, EventType.CLICK, () => onClick()));
	}

	private _setActiveSandboxOutputButton(activeId: string | undefined): void {
		for (const [id, button] of this._sandboxOutputButtons) {
			const checked = id === activeId;
			button.classList.toggle('checked', checked);
			button.setAttribute('aria-pressed', String(checked));
		}
	}

	private _openFiles(focus: boolean): void {
		this._activeSandboxOutputId = SESSIONS_FILES_CONTAINER_ID;
		this._setActiveSandboxOutputButton(this._activeSandboxOutputId);
		void this._renderActiveSandboxOutput();
		if (focus) {
			this._sandboxOutputContent?.focus();
		}
	}

	private _openChanges(focus: boolean): void {
		this._activeSandboxOutputId = CHANGES_VIEW_CONTAINER_ID;
		this._setActiveSandboxOutputButton(this._activeSandboxOutputId);
		void this._renderActiveSandboxOutput();
		if (focus) {
			this._sandboxOutputContent?.focus();
		}
	}

	private _openPreview(focus: boolean): void {
		this._activeSandboxOutputId = SESSIONS_PREVIEW_CONTAINER_ID;
		this._setActiveSandboxOutputButton(this._activeSandboxOutputId);
		void this._renderActiveSandboxOutput();
		void this._openPreviewEditor();
		if (focus) {
			this._sandboxOutputContent?.focus();
		}
	}

	private async _renderActiveSandboxOutput(): Promise<void> {
		const content = this._sandboxOutputContent;
		if (!content) {
			return;
		}

		const generation = ++this._sandboxOutputGeneration;
		clearNode(content);
		content.tabIndex = -1;
		content.classList.toggle('files', this._activeSandboxOutputId === SESSIONS_FILES_CONTAINER_ID);
		content.classList.toggle('changes', this._activeSandboxOutputId === CHANGES_VIEW_CONTAINER_ID);
		content.classList.toggle('preview', this._activeSandboxOutputId === SESSIONS_PREVIEW_CONTAINER_ID);

		if (this._activeSandboxOutputId === SESSIONS_FILES_CONTAINER_ID) {
			await this._renderFiles(content, generation);
			return;
		}

		if (this._activeSandboxOutputId === CHANGES_VIEW_CONTAINER_ID) {
			await this._renderChanges(content, generation);
			return;
		}

		await this._renderPreview(content, generation);
	}

	private async _renderFiles(container: HTMLElement, generation: number): Promise<void> {
		const body = append(container, $('.sandbox-output-list'));
		const activeSession = this._getActiveSession();
		const folders = this._getSandboxWorkspaceRoots(activeSession);
		void this._sandboxWorkspaceChangesService.ensureBaseline(activeSession);
		if (!folders.length) {
			this._renderEmpty(body, Codicon.files, localize('sandboxOutput.noFiles', "Folders and files will appear here."));
			return;
		}

		for (const folder of folders) {
			this._sandboxExpandedResources.add(folder.toString());
			await this._renderFileResource(body, folder, 0, true, generation);
			if (generation !== this._sandboxOutputGeneration) {
				return;
			}
		}
	}

	private async _renderFileResource(container: HTMLElement, resource: URI, depth: number, isRoot: boolean, generation: number): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this._fileService.resolve(resource);
		} catch {
			this._appendFileRow(container, resource, depth, false, false, isRoot);
			return;
		}

		if (generation !== this._sandboxOutputGeneration) {
			return;
		}

		const expanded = this._sandboxExpandedResources.has(stat.resource.toString());
		this._appendFileRow(container, stat.resource, depth, stat.isDirectory, expanded, isRoot);
		if (!stat.isDirectory || !expanded) {
			return;
		}

		const children = [...(stat.children ?? [])]
			.filter(child => !this._shouldHideResource(child.resource))
			.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || this._label(a.resource).localeCompare(this._label(b.resource)));

		for (const child of children) {
			await this._renderFileResource(container, child.resource, depth + 1, false, generation);
			if (generation !== this._sandboxOutputGeneration) {
				return;
			}
		}
	}

	private _appendFileRow(container: HTMLElement, resource: URI, depth: number, isDirectory: boolean, expanded: boolean, isRoot: boolean): void {
		const row = append(container, $('button.sandbox-output-row')) as HTMLButtonElement;
		row.type = 'button';
		row.style.paddingLeft = `${10 + depth * 14}px`;
		row.title = resource.fsPath || resource.toString();

		const twistie = append(row, $('span.codicon.sandbox-output-twistie'));
		if (isDirectory) {
			twistie.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		}

		const icon = append(row, $('span.codicon.sandbox-output-row-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(isDirectory ? Codicon.folder : Codicon.file));

		const label = append(row, $('span.sandbox-output-row-label'));
		label.textContent = isRoot ? this._rootLabel(resource) : this._label(resource);

		row.onclick = () => {
			if (isDirectory) {
				const key = resource.toString();
				if (this._sandboxExpandedResources.has(key)) {
					this._sandboxExpandedResources.delete(key);
				} else {
					this._sandboxExpandedResources.add(key);
				}
				this._sandboxOutputRefreshScheduler.schedule(0);
				return;
			}
			void this._openerService.open(resource);
		};
	}

	private async _renderChanges(container: HTMLElement, generation: number): Promise<void> {
		const activeSession = this._getActiveSession();
		const changes = await this._sandboxWorkspaceChangesService.getChanges(activeSession);
		if (generation !== this._sandboxOutputGeneration) {
			return;
		}
		if (!changes.length) {
			this._renderEmpty(container, Codicon.gitCompare, localize('sandboxOutput.noChanges', "No changes yet."));
			return;
		}

		const body = append(container, $('.sandbox-output-list'));
		for (const change of changes) {
			const key = change.uri.toString();
			if (!this._sandboxTouchedChanges.has(key)) {
				this._sandboxExpandedChanges.add(key);
			}
			const expanded = this._sandboxExpandedChanges.has(key);
			const row = append(body, $('button.sandbox-output-row.sandbox-output-change-row')) as HTMLButtonElement;
			row.type = 'button';
			row.title = change.uri.fsPath || change.uri.toString();
			row.classList.toggle('expanded', expanded);

			const twistie = append(row, $('span.codicon.sandbox-output-twistie'));
			twistie.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));

			const icon = append(row, $('span.codicon.sandbox-output-row-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));

			const label = append(row, $('span.sandbox-output-row-label'));
			label.textContent = this._label(change.uri);

			const meta = append(row, $('span.sandbox-output-change-meta'));
			meta.textContent = this._changeMetaLabel(change.type);

			row.onclick = () => {
				this._sandboxTouchedChanges.add(key);
				if (this._sandboxExpandedChanges.has(key)) {
					this._sandboxExpandedChanges.delete(key);
				} else {
					this._sandboxExpandedChanges.add(key);
				}
				this._sandboxOutputRefreshScheduler.schedule(0);
			};

			if (expanded) {
				await this._renderChangeDiff(body, activeSession, change, generation);
				if (generation !== this._sandboxOutputGeneration) {
					return;
				}
			}
		}
	}

	private async _renderChangeDiff(container: HTMLElement, activeSession: ISession | undefined, change: ISandboxWorkspaceChange, generation: number): Promise<void> {
		const details = await this._sandboxWorkspaceChangesService.getChangeDetails(activeSession, change.uri);
		if (generation !== this._sandboxOutputGeneration) {
			return;
		}

		const diff = append(container, $('.sandbox-output-diff'));
		const header = append(diff, $('.sandbox-output-diff-file'));
		const icon = append(header, $('span.codicon.sandbox-output-diff-file-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diff));
		const label = append(header, $('span.sandbox-output-diff-file-label'));
		label.textContent = this._label(change.uri);
		const openButton = append(header, $('button.sandbox-output-diff-open.codicon')) as HTMLButtonElement;
		openButton.type = 'button';
		openButton.title = localize('sandboxOutput.openChangedFile', "Open file");
		openButton.setAttribute('aria-label', openButton.title);
		openButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.goToFile));
		openButton.onclick = event => {
			event.stopPropagation();
			void this._openerService.open(change.uri);
		};

		if (!details?.hasBeforeContent || !details.hasAfterContent) {
			this._appendDiffMessage(diff, localize('sandboxOutput.diffUnavailable', "No text baseline is available for this file yet."));
			return;
		}

		const before = details.beforeContent ?? '';
		const after = details.afterContent ?? '';
		const beforeLineCount = this._lineCount(before);
		const afterLineCount = this._lineCount(after);
		if (beforeLineCount + afterLineCount > 2400) {
			this._appendDiffMessage(diff, localize('sandboxOutput.diffTooLarge', "Diff is too large to show inline."));
			return;
		}

		const hunks = this._computeSandboxDiff(before, after);
		if (!hunks.length) {
			this._appendDiffMessage(diff, localize('sandboxOutput.noTextDiff', "No text changes to show."));
			return;
		}

		const body = append(diff, $('.sandbox-output-diff-body'));
		for (const hunk of hunks) {
			const hunkHeader = append(body, $('div.sandbox-output-diff-hunk'));
			hunkHeader.textContent = hunk.header;
			for (const line of hunk.lines) {
				this._appendDiffLine(body, line);
			}
		}
	}

	private _appendDiffMessage(container: HTMLElement, message: string): void {
		const messageElement = append(container, $('.sandbox-output-diff-message'));
		messageElement.textContent = message;
	}

	private _appendDiffLine(container: HTMLElement, line: ISandboxDiffLine): void {
		const row = append(container, $('div.sandbox-output-diff-row'));
		row.classList.add(line.type);

		const oldLine = append(row, $('span.sandbox-output-diff-line-number'));
		oldLine.textContent = line.oldLineNumber === undefined ? '' : String(line.oldLineNumber);

		const newLine = append(row, $('span.sandbox-output-diff-line-number'));
		newLine.textContent = line.newLineNumber === undefined ? '' : String(line.newLineNumber);

		const marker = append(row, $('span.sandbox-output-diff-marker'));
		marker.textContent = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

		const code = append(row, $('code.sandbox-output-diff-code'));
		code.textContent = line.text || ' ';
	}

	private _computeSandboxDiff(original: string, modified: string): ISandboxDiffHunk[] {
		const originalLines = original.split(/\r?\n/);
		const modifiedLines = modified.split(/\r?\n/);
		const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
			ignoreTrimWhitespace: false,
			maxComputationTimeMs: 1000,
			computeMoves: false,
		});
		if (!diff.changes.length) {
			return [];
		}

		type ChangeRange = {
			readonly originalStart: number;
			readonly originalEnd: number;
			readonly modifiedStart: number;
			readonly modifiedEnd: number;
		};
		const contextLines = 3;
		const groups: ChangeRange[][] = [];
		for (const change of diff.changes) {
			const range: ChangeRange = {
				originalStart: change.original.startLineNumber,
				originalEnd: change.original.endLineNumberExclusive,
				modifiedStart: change.modified.startLineNumber,
				modifiedEnd: change.modified.endLineNumberExclusive,
			};
			const lastGroup = groups[groups.length - 1];
			const lastRange = lastGroup?.[lastGroup.length - 1];
			if (lastGroup && lastRange && range.originalStart - lastRange.originalEnd <= contextLines * 2) {
				lastGroup.push(range);
			} else {
				groups.push([range]);
			}
		}

		const hunks: ISandboxDiffHunk[] = [];
		for (const group of groups) {
			const first = group[0];
			const last = group[group.length - 1];
			const originalLeading = Math.max(1, first.originalStart - contextLines);
			const modifiedLeading = Math.max(1, first.modifiedStart - contextLines);
			const originalTrailing = Math.min(originalLines.length + 1, last.originalEnd + contextLines);
			const modifiedTrailing = Math.min(modifiedLines.length + 1, last.modifiedEnd + contextLines);
			const lines: ISandboxDiffLine[] = [];
			let originalCursor = originalLeading;
			let modifiedCursor = modifiedLeading;

			const appendContextUntil = (originalEnd: number, modifiedEnd: number) => {
				while (originalCursor < originalEnd && modifiedCursor < modifiedEnd) {
					lines.push({
						type: 'context',
						oldLineNumber: originalCursor,
						newLineNumber: modifiedCursor,
						text: originalLines[originalCursor - 1] ?? '',
					});
					originalCursor++;
					modifiedCursor++;
				}
			};

			for (const range of group) {
				appendContextUntil(range.originalStart, range.modifiedStart);

				while (originalCursor < range.originalEnd) {
					lines.push({
						type: 'removed',
						oldLineNumber: originalCursor,
						newLineNumber: undefined,
						text: originalLines[originalCursor - 1] ?? '',
					});
					originalCursor++;
				}

				while (modifiedCursor < range.modifiedEnd) {
					lines.push({
						type: 'added',
						oldLineNumber: undefined,
						newLineNumber: modifiedCursor,
						text: modifiedLines[modifiedCursor - 1] ?? '',
					});
					modifiedCursor++;
				}
			}

			appendContextUntil(originalTrailing, modifiedTrailing);

			hunks.push({
				header: `@@ -${originalLeading},${originalTrailing - originalLeading} +${modifiedLeading},${modifiedTrailing - modifiedLeading} @@`,
				lines,
			});
		}

		return hunks;
	}

	private _lineCount(value: string): number {
		return value.length ? value.split(/\r?\n/).length : 0;
	}

	private async _renderPreview(container: HTMLElement, generation: number): Promise<void> {
		this._renderPreviewStatus(container, Codicon.loading, localize('sandboxOutput.previewPreparing', "Preparing preview..."), true);

		const preview = await this._resolvePreviewUrl();
		if (generation !== this._sandboxOutputGeneration) {
			return;
		}

		clearNode(container);
		if (!preview?.url) {
			this._renderEmpty(container, Codicon.preview, localize('sandboxOutput.noPreview', "No web preview detected yet."));
			return;
		}

		const toolbar = append(container, $('.sandbox-output-preview-toolbar'));
		const title = append(toolbar, $('span.sandbox-output-preview-title'));
		title.textContent = preview.title;
		const refreshButton = append(toolbar, $('button.sandbox-output-preview-refresh.codicon')) as HTMLButtonElement;
		refreshButton.type = 'button';
		refreshButton.title = localize('sandboxOutput.refreshPreview', "Refresh preview");
		refreshButton.setAttribute('aria-label', refreshButton.title);
		refreshButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.refresh));
		const openButton = append(toolbar, $('button.sandbox-output-preview-open')) as HTMLButtonElement;
		openButton.type = 'button';
		openButton.textContent = localize('sandboxOutput.openPreview', "Open");
		openButton.onclick = () => void this._openPreviewEditor();
		const frame = append(container, $('iframe.sandbox-output-preview-frame')) as HTMLIFrameElement;
		frame.title = preview.title;
		frame.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts');
		frame.src = this._withPreviewCacheBust(preview.url);
		refreshButton.onclick = () => {
			frame.src = this._withPreviewCacheBust(preview.url);
		};
	}

	private _withPreviewCacheBust(url: string): string {
		const separator = url.includes('?') ? '&' : '?';
		return `${url}${separator}backboardPreview=${Date.now()}`;
	}

	private async _resolvePreviewUrl(): Promise<{ title: string; url: string; resource?: URI } | undefined> {
		const activeSession = this._getActiveSession();
		if (activeSession) {
			try {
				const state = await this.instantiationService.invokeFunction(async accessor => {
					const previewService = accessor.get(ISandboxPreviewService);
					await previewService.prepare(activeSession);
					return previewService.getState(activeSession.resource).get();
				});
				const url = state.url ?? state.candidate?.url ?? state.candidate?.entry?.toString();
				if (url) {
					return {
						title: state.candidate?.title ?? localize('sandboxOutput.preview', "Preview"),
						url,
						resource: url === state.candidate?.entry?.toString() ? state.candidate?.entry : undefined,
					};
				}
			} catch {
				// Fall back to a static workspace preview below.
			}
		}

		const staticEntry = await this._findStaticHtmlEntry();
		if (!staticEntry) {
			return undefined;
		}
		return { title: this._label(staticEntry), url: staticEntry.toString(), resource: staticEntry };
	}

	private async _openPreviewEditor(): Promise<void> {
		const preview = await this._resolvePreviewUrl();
		if (!preview?.url) {
			return;
		}
		await this._openBrowserEditor(preview.url);
	}

	private async _openBrowserEditor(url: string): Promise<void> {
		await this.layoutService.whenRestored;
		let lastLayoutError: Error | undefined;
		for (let attempt = 0; attempt < 8; attempt++) {
			await timeout(attempt === 0 ? 0 : 250);
			try {
				await this.instantiationService.invokeFunction(async accessor => {
					const editorService = accessor.get(IEditorService);
					const resource = BrowserViewUri.forId(generateUuid());
					await editorService.openEditor({ resource, options: { viewState: { url } } }, SIDE_GROUP);
				});
				return;
			} catch (error) {
				if (!(error instanceof Error && error.message.includes('before first layout'))) {
					throw error;
				}
				lastLayoutError = error;
			}
		}
		throw lastLayoutError ?? new Error('Unable to open preview.');
	}

	private _renderPreviewStatus(container: HTMLElement, icon: ThemeIcon, message: string, spin = false): void {
		const status = append(container, $('.sandbox-output-preview-status'));
		const statusIcon = append(status, $('span.codicon'));
		statusIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
		if (spin) {
			statusIcon.classList.add('codicon-modifier-spin');
		}
		append(status, $('span')).textContent = message;
	}

	private async _findStaticHtmlEntry(): Promise<URI | undefined> {
		const candidateDirs = ['.', 'frontend', 'web', 'app', 'client', 'site'];
		for (const folder of this._getSandboxWorkspaceRoots()) {
			for (const candidateDir of candidateDirs) {
				const dir = candidateDir === '.' ? folder : joinPath(folder, candidateDir);
				const index = joinPath(dir, 'index.html');
				try {
					if (await this._fileService.exists(index)) {
						return index;
					}
				} catch {
					// Try the next candidate.
				}
			}
		}
		return undefined;
	}

	private _renderEmpty(container: HTMLElement, icon: ThemeIcon, message: string): void {
		const empty = append(container, $('.sandbox-output-empty'));
		const emptyIcon = append(empty, $('span.codicon.sandbox-output-empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
		const label = append(empty, $('span.sandbox-output-empty-message'));
		label.textContent = message;
	}

	private _getActiveSession(): ISession | undefined {
		return this.instantiationService.invokeFunction(accessor => accessor.get(ISessionsManagementService).activeSession.get());
	}

	private _changeMetaLabel(type: SandboxWorkspaceChangeType): string {
		switch (type) {
			case 'added':
				return localize('sandboxOutput.workspaceChangeAdded', "added");
			case 'deleted':
				return localize('sandboxOutput.workspaceChangeDeleted', "deleted");
			case 'modified':
				return localize('sandboxOutput.workspaceChangeModified', "modified");
		}
	}

	private _label(resource: URI): string {
		return basename(resource) || resource.authority || resource.toString();
	}

	private _rootLabel(resource: URI): string {
		const sessionFolder = this._getActiveSession()?.workspace.get()?.folders.find(folder =>
			extUri.isEqual(folder.workingDirectory, resource) || extUri.isEqual(folder.root, resource)
		);
		if (sessionFolder) {
			return sessionFolder.name || this._label(resource);
		}

		const folder = this._workspaceContextService.getWorkspace().folders.find(folder => extUri.isEqual(folder.uri, resource));
		return folder?.name || this._label(resource);
	}

	private _getSandboxWorkspaceRoots(activeSession = this._getActiveSession()): URI[] {
		const sessionFolders = activeSession?.workspace.get()?.folders;
		if (sessionFolders?.length) {
			return this._dedupeUris(sessionFolders.map(folder => folder.workingDirectory));
		}
		return this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
	}

	private _dedupeUris(resources: readonly URI[]): URI[] {
		const result: URI[] = [];
		for (const resource of resources) {
			if (!result.some(existing => extUri.isEqual(existing, resource))) {
				result.push(resource);
			}
		}
		return result;
	}

	private _shouldHideResource(resource: URI): boolean {
		switch (this._label(resource)) {
			case '.git':
			case 'node_modules':
			case '.next':
			case 'out':
			case 'dist':
				return true;
			default:
				return false;
		}
	}
}
