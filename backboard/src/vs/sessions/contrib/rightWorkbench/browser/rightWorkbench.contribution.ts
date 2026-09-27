/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { Sequencer, timeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual } from '../../../../base/common/resources.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, WindowEnablement } from '../../../../workbench/common/views.js';
import { ExtensionsViewletViewsContribution, ExtensionsViewPaneContainer } from '../../../../workbench/contrib/extensions/browser/extensionsViewlet.js';
import { VIEWLET_ID as EXTENSIONS_VIEWLET_ID } from '../../../../workbench/contrib/extensions/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID, OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID, SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID, RightWorkbenchCommandId, type RightWorkbenchMode, type IRightWorkbenchModeRequest, onDidRequestModeEmitter, setPendingModeRequest } from './rightWorkbench.js';
import { RightWorkbenchViewPane } from './rightWorkbenchViewPane.js';
import { openRightWorkbenchSplitPanelMode, RightWorkbenchSplitPanel } from './rightWorkbenchSplitPanel.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsGridChangeEvent, ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import './canvasOverlay.js';

const rightWorkbenchIcon = registerIcon('sessions-right-workbench-icon', Codicon.layoutPanelRight, localize2('sessionsRightWorkbenchIcon', 'View icon of the right workbench in the sessions window.').value);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

// Sessions and Optimus intentionally omit the full Editor workbench manifest,
// so its Extensions container is not registered even though the extension
// management services are available. Register the same native container and
// view descriptors here so the right-panel Extensions tool is the Editor
// surface, not a parallel custom implementation.
if (!viewContainerRegistry.get(EXTENSIONS_VIEWLET_ID)) {
	viewContainerRegistry.registerViewContainer({
		id: EXTENSIONS_VIEWLET_ID,
		title: localize2('extensions', "Extensions"),
		icon: Codicon.extensions,
		order: 4,
		ctorDescriptor: new SyncDescriptor(ExtensionsViewPaneContainer),
		rejectAddedViews: true,
		alwaysUseContainerInfo: true,
		windowEnablement: WindowEnablement.Both,
	}, ViewContainerLocation.Sidebar);
	registerWorkbenchContribution2('workbench.contrib.sessions.extensionsViewletViews', ExtensionsViewletViewsContribution, WorkbenchPhase.AfterRestored);
}

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

// Advanced uses the same right-workbench surface as Simple, but view
// registrations are window-kind scoped. Keep a distinct Optimus registration
// and let the shared commands below select the appropriate ids at runtime.
const optimusRightWorkbenchContainer = viewContainerRegistry.registerViewContainer({
	id: OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID,
	title: localize2('optimusRightWorkbench', "Right Workbench"),
	icon: rightWorkbenchIcon,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Optimus,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID,
	name: localize2('optimusRightWorkbench.launcher', "Right Workbench"),
	containerIcon: rightWorkbenchIcon,
	ctorDescriptor: new SyncDescriptor(RightWorkbenchViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	windowEnablement: WindowEnablement.Optimus,
}], optimusRightWorkbenchContainer);

// Serialize mode requests: two rapid requests (e.g. a completion-popup click
// racing an automatic OpenBrowser) share the single pending-request slot, and
// interleaving lets the first request's cleanup null out the second's before a
// cold-constructing pane consumes it.
const modeRequestSequencer = new Sequencer();

function openRightWorkbenchMode(accessor: ServicesAccessor, request: RightWorkbenchMode | IRightWorkbenchModeRequest): Promise<void> {
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const viewsService = accessor.get(IViewsService);
	const isOptimusWindow = accessor.get(IWorkbenchEnvironmentService).isOptimusWindow;
	const containerId = isOptimusWindow ? OPTIMUS_RIGHT_WORKBENCH_CONTAINER_ID : SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID;
	const viewId = isOptimusWindow ? OPTIMUS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID : SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID;
	const sessionsPartService = accessor.get(ISessionsPartService);
	if (sessionsPartService.isSplit) {
		// A split grid gives every column its own panel: open the request in
		// the active column's panel instead of the window's auxiliary bar.
		const instantiationService = accessor.get(IInstantiationService);
		const sessionId = accessor.get(ISessionsService).activeSession.get()?.sessionId;
		const modeRequest = typeof request === 'string' ? { mode: request } : request;
		return modeRequestSequencer.queue(() => openRightWorkbenchSplitPanelMode(sessionsPartService, instantiationService, sessionId, modeRequest));
	}
	return modeRequestSequencer.queue(async () => {
		const modeRequest = typeof request === 'string' ? { mode: request } : request;
		setPendingModeRequest(modeRequest);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		layoutService.setPartHidden(true, Parts.EDITOR_PART);
		await viewsService.openViewContainer(containerId, true);
		await viewsService.openView(viewId, true);
		onDidRequestModeEmitter.fire(modeRequest);
		setPendingModeRequest(undefined);
	});
}

registerAction2(class OpenRightWorkbenchLauncherModeAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenLauncherMode,
			title: localize2('rightWorkbench.openLauncherMode', "Open Right Workbench Launcher"),
			icon: Codicon.layoutPanelRight,
		});
	}

	override async run(accessor: ServicesAccessor, options?: { preserveActiveTab?: boolean }): Promise<void> {
		await openRightWorkbenchMode(accessor, { mode: 'launcher', preserveActiveTab: options?.preserveActiveTab });
	}
});

registerAction2(class OpenRightWorkbenchEditorAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenEditor,
			title: localize2('rightWorkbench.openEditor', "Open Editor Chat in Right Workbench"),
			icon: Codicon.commentDiscussionSparkle,
		});
	}

	override async run(accessor: ServicesAccessor, options?: { newChat?: boolean }): Promise<void> {
		const isOptimusWindow = accessor.get(IWorkbenchEnvironmentService).isOptimusWindow;
		await openRightWorkbenchMode(accessor, { mode: 'editor', editorSidebar: isOptimusWindow ? true : undefined, newChat: options?.newChat });
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

	/**
	 * With a `resource`, selects that file's diff and resolves `false` (opening
	 * nothing) when it is not one of the active chat's changes, which is all
	 * Review lists; the caller then shows the diff itself.
	 */
	override async run(accessor: ServicesAccessor, options?: { resource?: URI }): Promise<boolean> {
		const resource = URI.isUri(options?.resource) ? options.resource : undefined;
		if (resource) {
			const changes = accessor.get(ISessionsService).activeSession.get()?.activeChat.get()?.changes.get() ?? [];
			if (!changes.some(change => isEqual(isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri, resource))) {
				return false;
			}
		}
		await openRightWorkbenchMode(accessor, { mode: 'review', reviewResource: resource });
		return true;
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

	override async run(accessor: ServicesAccessor, options?: { editorSidebar?: boolean }): Promise<void> {
		await openRightWorkbenchMode(accessor, { mode: 'files', editorSidebar: options?.editorSidebar });
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

	override async run(accessor: ServicesAccessor, urlOrOptions?: string | { url?: string; browserUrl?: string; browserViewId?: string; viewId?: string }): Promise<void> {
		const browserUrl = typeof urlOrOptions === 'string' ? urlOrOptions : urlOrOptions?.url ?? urlOrOptions?.browserUrl;
		const browserViewId = typeof urlOrOptions === 'string' ? undefined : urlOrOptions?.browserViewId ?? urlOrOptions?.viewId;
		await openRightWorkbenchMode(accessor, { mode: 'browser', browserUrl, browserViewId });
	}
});

registerAction2(class OpenRightWorkbenchTerminalAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenTerminal,
			title: localize2('rightWorkbench.openTerminal', "Open Terminal in Bottom Panel"),
			icon: Codicon.terminal,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('workbench.action.terminal.new', { location: TerminalLocation.Panel });
	}
});

registerAction2(class OpenRightWorkbenchSearchAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenSearch,
			title: localize2('rightWorkbench.openSearch', "Open Search in Right Workbench"),
			icon: Codicon.search,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'search');
	}
});

registerAction2(class OpenRightWorkbenchExtensionsAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenExtensions,
			title: localize2('rightWorkbench.openExtensions', "Open Extensions in Right Workbench"),
			icon: Codicon.extensions,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'extensions');
	}
});

registerAction2(class OpenRightWorkbenchMarketplaceAction extends Action2 {
	constructor() {
		super({
			id: RightWorkbenchCommandId.OpenMarketplace,
			title: localize2('rightWorkbench.openMarketplace', "Open Marketplace in Right Workbench"),
			icon: Codicon.vm,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRightWorkbenchMode(accessor, 'marketplace');
	}
});

/**
 * Moves the right panel between the auxiliary bar and the split grid's
 * per-column panels. Splitting while the auxiliary bar is open gives every
 * column its own panel (the original column keeps the mode it showed); a
 * grid collapsing to one session hands a visible column panel back to the
 * auxiliary bar. While split, anything revealing the auxiliary bar (e.g. a
 * keyboard shortcut) opens the active column's panel instead.
 */
class RightWorkbenchSplitPanelsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.rightWorkbenchSplitPanels';

	/** Modes a fresh panel can reproduce from the mode alone; others open the launcher. */
	private static readonly CARRIED_MODES: ReadonlySet<RightWorkbenchMode> = new Set<RightWorkbenchMode>(['review', 'files', 'search', 'extensions', 'marketplace']);

	constructor(
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._register(this.sessionsPartService.onDidUpdateGrid(e => this.onDidUpdateGrid(e)));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART && e.visible && this.sessionsPartService.isSplit) {
				// Leave the layout pass that revealed the bar before undoing it.
				queueMicrotask(() => {
					if (this.sessionsPartService.isSplit && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
						this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
						void this.openColumnPanel(this.sessionsService.activeSession.get()?.sessionId, { mode: 'launcher', preserveActiveTab: true });
					}
				});
			}
		}));
	}

	private onDidUpdateGrid(e: ISessionsGridChangeEvent): void {
		if (!e.isSplit) {
			const panel = e.collapsingSidePanel;
			if (panel instanceof RightWorkbenchSplitPanel) {
				const mode = RightWorkbenchSplitPanelsContribution.CARRIED_MODES.has(panel.mode) ? panel.mode : undefined;
				void this.commandService.executeCommand(mode ? this.getModeCommand(mode) : RightWorkbenchCommandId.OpenLauncherMode, mode ? undefined : { preserveActiveTab: true });
			}
			return;
		}

		const columnIds = this.sessionsService.visibleSessions.get().map(session => session?.sessionId);
		let carriedMode: RightWorkbenchMode | undefined;
		let panelsInUse = columnIds.some(id => {
			const panel = this.sessionsPartService.getSidePanel(id);
			return !!panel && this.sessionsPartService.isSidePanelVisible(panel);
		});
		if (!e.wasSplit && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			const auxiliaryPane = this.viewsService.getActiveViewWithId<RightWorkbenchViewPane>(SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID);
			carriedMode = auxiliaryPane?.currentMode ?? 'launcher';
			panelsInUse = true;
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
		if (!panelsInUse) {
			return;
		}
		for (const id of columnIds) {
			if (this.sessionsPartService.getSidePanel(id)) {
				continue;
			}
			const isNewColumn = e.addedSessionIds.includes(id);
			const mode = !isNewColumn && carriedMode && RightWorkbenchSplitPanelsContribution.CARRIED_MODES.has(carriedMode) ? carriedMode : 'launcher';
			if (isNewColumn || carriedMode) {
				void this.openColumnPanel(id, { mode });
			}
		}
	}

	private openColumnPanel(sessionId: string | undefined, request: IRightWorkbenchModeRequest): Promise<void> {
		return modeRequestSequencer.queue(() => openRightWorkbenchSplitPanelMode(this.sessionsPartService, this.instantiationService, sessionId, request));
	}

	private getModeCommand(mode: RightWorkbenchMode): string {
		switch (mode) {
			case 'review': return RightWorkbenchCommandId.OpenReview;
			case 'files': return RightWorkbenchCommandId.OpenFiles;
			case 'search': return RightWorkbenchCommandId.OpenSearch;
			case 'extensions': return RightWorkbenchCommandId.OpenExtensions;
			case 'marketplace': return RightWorkbenchCommandId.OpenMarketplace;
			default: return RightWorkbenchCommandId.OpenLauncherMode;
		}
	}
}

registerWorkbenchContribution2(RightWorkbenchSplitPanelsContribution.ID, RightWorkbenchSplitPanelsContribution, WorkbenchPhase.AfterRestored);

/**
 * Guarantees that a native browser page appears only on a right panel's
 * Browser tab in this window. Native WebContentsViews paint above every
 * workbench surface at their last bounds, so any other path (an agent tool
 * creating a page before the panel adopts it, a panel that moved to another
 * tab or closed, a browser editor opened into the regular editor area, a
 * split pane going away) would leave a page floating over the chat.
 *
 * Layers, strongest first:
 * 1. Source gate: a visibility policy on the browser service makes every
 *    model refuse to show a view no visible Browser tab owns, so a stray page
 *    never reaches the screen, not even for a frame.
 * 2. Redirect: a browser editor that opens anywhere but a right panel is
 *    moved onto the panel's Browser tab (the one legal surface) and closed
 *    where it was, instead of flickering hidden/shown there.
 * 3. Backstop: any view that nevertheless turns visible without an owner
 *    (e.g. main-process paths that bypass the model) is hidden, and every
 *    view is re-checked when panels change tab, mode or visibility, and when
 *    this window comes back on screen.
 */
class RightWorkbenchBrowserVisibilityGuard extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.rightWorkbenchBrowserVisibilityGuard';

	private readonly watched = this._register(new DisposableMap<string, DisposableStore>());
	private readonly models = new Map<string, IBrowserViewModel>();
	private readonly redirecting = new Set<string>();

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(browserViewWorkbenchService.registerVisibilityPolicy({
			canShow: viewId => RightWorkbenchViewPane.showsBrowserView(viewId),
			onDidChange: RightWorkbenchViewPane.onDidChangeBrowserOwnership,
		}));

		this._register(browserViewWorkbenchService.onDidChangeBrowserViews(() => this.watchViews()));
		this._register(RightWorkbenchViewPane.onDidChangeBrowserOwnership(() => this.enforceAll()));
		this._register(addDisposableListener(mainWindow.document, 'visibilitychange', () => this.enforceAll()));
		this._register(editorService.onDidVisibleEditorsChange(() => this.redirectStrayEditors()));
		this.watchViews();
		this.redirectStrayEditors();
	}

	private watchViews(): void {
		const known = this.browserViewWorkbenchService.getKnownBrowserViews();
		for (const id of [...this.watched.keys()]) {
			if (!known.has(id)) {
				this.watched.deleteAndDispose(id);
				this.models.delete(id);
			}
		}
		for (const [id, input] of known) {
			if (this.watched.has(id)) {
				continue;
			}
			const store = new DisposableStore();
			this.watched.set(id, store);
			const watch = (model: IBrowserViewModel) => {
				this.models.set(id, model);
				store.add(model.onDidChangeVisibility(() => this.enforce(id, model)));
				this.enforce(id, model);
			};
			if (input.model) {
				watch(input.model);
			} else {
				store.add(input.onceModelResolves(watch));
			}
		}
	}

	private enforceAll(): void {
		for (const [id, model] of this.models) {
			this.enforce(id, model);
		}
	}

	private enforce(id: string, model: IBrowserViewModel): void {
		// Modes can share one native window: while this window is off screen a
		// visible view belongs to whichever mode is showing, not to us.
		if (mainWindow.document.visibilityState !== 'visible') {
			return;
		}
		if (model.visible && !RightWorkbenchViewPane.showsBrowserView(id)) {
			void model.setVisible(false);
		}
	}

	private redirectStrayEditors(): void {
		if (this.lifecycleService.willShutdown) {
			return;
		}
		for (const pane of this.editorService.visibleEditorPanes) {
			const input = pane.input;
			const group = pane.group;
			if (input instanceof BrowserEditorInput && group && !RightWorkbenchViewPane.ownsEditorGroup(group)) {
				void this.redirect(input, group);
			}
		}
	}

	/** Moves a browser editor opened outside the right panel onto its Browser tab. */
	private async redirect(input: BrowserEditorInput, group: IEditorGroup): Promise<void> {
		if (this.redirecting.has(input.id)) {
			return;
		}
		this.redirecting.add(input.id);
		try {
			void input.model?.setVisible(false);
			await this.commandService.executeCommand(RightWorkbenchCommandId.OpenBrowser, { browserViewId: input.id });
			// Close the stray editor only once a right panel's embedded editor
			// holds the same input, so closing it never disposes the page. The
			// panel opens its editor asynchronously; give it a moment.
			for (let attempt = 0; attempt < 30 && !RightWorkbenchViewPane.holdsBrowserInput(input); attempt++) {
				await timeout(100);
			}
			if (!RightWorkbenchViewPane.holdsBrowserInput(input)) {
				this.logService.warn('[RightWorkbench] A browser page could not be moved onto the Browser tab; it stays hidden.');
				return;
			}
			if (group.contains(input)) {
				await group.closeEditor(input, { preserveFocus: true });
			}
		} catch (error) {
			this.logService.warn('[RightWorkbench] Could not move a browser page onto the Browser tab; it stays hidden.', error);
		} finally {
			this.redirecting.delete(input.id);
		}
	}
}

registerWorkbenchContribution2(RightWorkbenchBrowserVisibilityGuard.ID, RightWorkbenchBrowserVisibilityGuard, WorkbenchPhase.BlockRestore);

