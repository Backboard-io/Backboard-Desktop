/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/sessionsViewPane.css';
import { SimpleMcpPage } from '../simpleMcpPage.js';
import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isWeb, isWindows } from '../../../../../base/common/platform.js';
import { basename } from '../../../../../base/common/resources.js';
import { Separator, toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IViewPaneOptions, IViewPaneLocationColors, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { localize } from '../../../../../nls.js';
import { SessionsList, SessionsGrouping, SessionsSorting } from './sessionsList.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { AgentHostShortcutsWidget } from '../agentHostShortcutsWidget.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { agentsBackground } from '../../../../common/theme.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { logSessionsInteraction } from '../../../../common/sessionsTelemetry.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { MobileSessionFilterChips } from '../../../../browser/parts/mobile/mobileSessionFilterChips.js';
import { IMobileSortGroupSheetItem, showMobileSortGroupSheet } from '../../../../browser/parts/mobile/mobileSortGroupSheet.js';
import { isPhoneLayout } from '../../../../browser/parts/mobile/mobileLayout.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { SkillsLibraryController } from '../../../../../workbench/contrib/chat/browser/widget/input/skillsLibrary.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { resolveBackboardUserInfo } from '../../../../../workbench/contrib/chat/browser/backboardUserInfo.js';
import { isBackboardProduct } from '../../../../../workbench/contrib/chat/common/backboardAuth.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { isRecentFolder, IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { BackboardUsageView } from '../backboardUsage.js';
import { SimpleModeBackgroundPicker } from '../../../chat/browser/simpleModeBackgroundPicker.js';

const $ = DOM.$;
export const SessionsViewId = 'sessions.workbench.view.sessionsView';
const OPTIMUS_NEW_SESSION_COMMAND_ID = 'optimus.newSession';
const GROUPING_STORAGE_KEY = 'sessionsViewPane.grouping.v3';
const SORTING_STORAGE_KEY = 'sessionsViewPane.sorting.v2';
const SIMPLE_COMPACT_STORAGE_KEY = 'sessionsViewPane.simpleCompact';
const SIMPLE_LEGACY_RECENT_ONLY_STORAGE_KEY = 'sessionsViewPane.simpleRecentOnly';

/**
 * Place the given session in the sessions grid to the right of the last
 * currently-visible session (as a non-sticky entry) and make it active. If
 * the session is already the last visible one, this is a no-op aside from
 * activation.
 */
export async function openSessionToTheSide(sessionsService: ISessionsService, session: ISession, options?: { preserveFocus?: boolean }): Promise<void> {
	const visible = sessionsService.visibleSessions.get();
	const lastVisible = visible[visible.length - 1];
	if (lastVisible && lastVisible.sessionId !== session.sessionId) {
		sessionsService.insertAt(session, lastVisible.sessionId, 'right');
	}
	await sessionsService.openSession(session.resource, options);
}

/**
 * Two-letter avatar initials from a display name: first letter of the first and
 * last whitespace-separated parts (e.g. "Erin Tomorri" → "ET"), or the first two
 * letters when there is only one part.
 */
function initialsFromName(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return '?';
	}
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const SessionsViewFilterSubMenu = new MenuId('SessionsViewPaneFilterSubMenu');
export const SessionsViewFilterOptionsSubMenu = new MenuId('SessionsViewPaneFilterOptionsSubMenu');
export const SessionsViewGroupingContext = new RawContextKey<string>('sessionsViewPane.grouping', SessionsGrouping.Workspace);
export const SessionsViewSortingContext = new RawContextKey<string>('sessionsViewPane.sorting', SessionsSorting.Updated);
export const IsWorkspaceGroupCappedContext = new RawContextKey<boolean>('sessionsViewPane.workspaceGroupCapped', true);

export class SessionsView extends ViewPane {

	private mcpPage: SimpleMcpPage | undefined;

	private viewPaneContainer: HTMLElement | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private findWidgetContainer: HTMLElement | undefined;
	private headerRow: HTMLElement | undefined;
	private headerLabel: HTMLElement | undefined;
	private headerActions: HTMLElement | undefined;
	private searchButton: HTMLButtonElement | undefined;
	private primaryActions: HTMLElement | undefined;
	private workspacesHeader: HTMLElement | undefined;
	private filterButton: HTMLButtonElement | undefined;
	private projectFilterButton: HTMLButtonElement | undefined;
	private projectFilterLabel: HTMLElement | undefined;
	private filterPopover: HTMLElement | undefined;
	private selectedWorkspaceFolderUri: string | undefined;
	private selectedWorkspaceFolderLabel: string | undefined;
	private recentWorkspaceFolders: readonly { uri: string; label: string }[] = [];
	private simpleCompact = false;
	private isFindWidgetOpen = false;
	sessionsControl: SessionsList | undefined;
	private currentGrouping: SessionsGrouping = SessionsGrouping.Workspace;
	private currentSorting: SessionsSorting = SessionsSorting.Updated;
	private groupingContextKey: IContextKey | undefined;
	private sortingContextKey: IContextKey | undefined;
	private workspaceGroupCappedContextKey: IContextKey<boolean> | undefined;
	private usageView: BackboardUsageView | undefined;
	private readonly filterContextKeys = new Map<string, { key: IContextKey<boolean>; getDefault: () => boolean }>();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ICommandService private readonly commandService: ICommandService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.simpleCompact = this.storageService.getBoolean(SIMPLE_COMPACT_STORAGE_KEY, StorageScope.PROFILE)
			?? this.storageService.getBoolean(SIMPLE_LEGACY_RECENT_ONLY_STORAGE_KEY, StorageScope.PROFILE)
			?? false;

		// Restore persisted grouping
		const storedGrouping = this.storageService.get(GROUPING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedGrouping && Object.values(SessionsGrouping).includes(storedGrouping as SessionsGrouping)) {
			this.currentGrouping = storedGrouping as SessionsGrouping;
		}

		// Restore persisted sorting
		const storedSorting = this.storageService.get(SORTING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedSorting && Object.values(SessionsSorting).includes(storedSorting as SessionsSorting)) {
			this.currentSorting = storedSorting as SessionsSorting;
		}

		// Ensure context keys reflect restored state immediately
		this.groupingContextKey = SessionsViewGroupingContext.bindTo(contextKeyService);
		this.groupingContextKey.set(this.currentGrouping);
		this.sortingContextKey = SessionsViewSortingContext.bindTo(contextKeyService);
		this.sortingContextKey.set(this.currentSorting);

		// Bind workspace group capped context key (will be synced with persisted state in renderBody)
		this.workspaceGroupCappedContextKey = IsWorkspaceGroupCappedContext.bindTo(contextKeyService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	protected override getLocationBasedColors(): IViewPaneLocationColors {
		const colors = super.getLocationBasedColors();
		return {
			...colors,
			background: undefined!,
			listOverrideStyles: {
				...colors.listOverrideStyles,
				listBackground: undefined!,
				treeStickyScrollBackground: agentsBackground,
			}
		};
	}

	/**
	 * Start a new chat from the sidebar. Shared by every sidebar chrome so the
	 * window-specific routing lives in one place: the Optimus window sends new
	 * sessions through its own command, which hosts the new chat as a card in
	 * the grid instead of navigating the window away from the dashboard.
	 */
	private startNewChat(): void {
		this.mcpPage?.hide();
		logSessionsInteraction(this.telemetryService, 'newSession');
		if (this.environmentService.isOptimusWindow) {
			void this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
			return;
		}
		this.sessionsService.openNewSession({ forceNew: true });
	}

	private createControls(parent: HTMLElement): void {
		const phoneLayout = isPhoneLayout(this.layoutService);
		// Advanced (Optimus) shares Simple's sidebar chrome: the compact search
		// row, the folder/thread-card toggle, the project filter and the footer
		// navigation (Marketplace / Usage / Settings).
		const simpleMode = !phoneLayout;
		const sessionsContainer = DOM.append(parent, $('.agent-sessions-container'));

		// Sessions section (top, fills available space)
		const sessionsSection = DOM.append(sessionsContainer, $('.agent-sessions-section'));

		// Pinned (non-scrolling) top block: header/find row, search and New chat
		// stay put while the rest of the sidebar content scrolls below.
		const pinnedHeader = DOM.append(sessionsSection, $('.agent-sessions-pinned'));

		// Sessions content container (owns the scroll)
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		// Header row: brand label (left) + compact collapse button (right)
		const headerRow = this.headerRow = DOM.append(pinnedHeader, $('.agent-sessions-header-row'));
		headerRow.classList.add('agent-sessions-header-hidden');
		const headerLabel = this.headerLabel = DOM.append(headerRow, $('.agent-sessions-header-label'));

		const headerActions = this.headerActions = DOM.append(headerRow, $('.agent-sessions-header-actions'));

		// On phone, the desktop header content (label + new button + filter/find toolbar)
		// is hidden in favor of the mobile filter chip row + the (+) button in the
		// MobileTitlebarPart. We still create the row container because the find
		// widget mounts inside it.
		if (!phoneLayout && simpleMode) {
			const primaryActions = this.primaryActions = DOM.append(pinnedHeader, $('.agent-sessions-primary-actions.agent-sessions-simple-actions'));
			const searchRow = DOM.append(primaryActions, $('.agent-sessions-simple-search-row'));

			this.searchButton = DOM.append(searchRow, $('button.agent-sessions-sidebar-action.agent-sessions-search-button')) as HTMLButtonElement;
			this.searchButton.type = 'button';
			const searchLabel = localize('searchThreads', "Search threads");
			this.searchButton.title = searchLabel;
			this.searchButton.setAttribute('aria-label', searchLabel);
			DOM.append(this.searchButton, $('span.agent-sessions-sidebar-action-icon')).appendChild(renderIcon(Codicon.search));
			DOM.append(this.searchButton, $('span.agent-sessions-sidebar-action-label', undefined, localize('search', "Search")));
			this._register(DOM.addDisposableListener(this.searchButton, DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.openFind();
			}));

			const compactToggleButton = DOM.append(searchRow, $('button.agent-sessions-simple-icon-button.agent-sessions-simple-compact-toggle')) as HTMLButtonElement;
			compactToggleButton.type = 'button';
			compactToggleButton.setAttribute('aria-pressed', 'false');
			compactToggleButton.appendChild(renderIcon(Codicon.filter));
			const updateCompactToggleButton = () => {
				const label = this.simpleCompact
					? localize('showThreadCards', "Show recent thread cards")
					: localize('showFolderView', "Show folders");
				compactToggleButton.title = label;
				compactToggleButton.setAttribute('aria-label', label);
				compactToggleButton.setAttribute('aria-pressed', String(this.simpleCompact));
			};
			updateCompactToggleButton();
			this._register(DOM.addDisposableListener(compactToggleButton, DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.simpleCompact = !this.simpleCompact;
				this.storageService.store(SIMPLE_COMPACT_STORAGE_KEY, this.simpleCompact, StorageScope.PROFILE, StorageTarget.USER);
				updateCompactToggleButton();
				this.sessionsControl?.setSimpleCompact(this.simpleCompact);
			}));

			this.createSidebarAction(primaryActions, Codicon.edit, localize('newChat', "New chat"), () => this.startNewChat());
			const mcpPage = this.mcpPage = this._register(this.instantiationService.createInstance(SimpleMcpPage));
			this.createSidebarAction(primaryActions, Codicon.extensions, localize('simpleMcps', "MCPs"), anchor => mcpPage.show(anchor));
			const mcpButton = primaryActions.lastElementChild;
			this._register(mcpPage.onDidChangeVisibility(selected => {
				mcpButton?.classList.toggle('active', selected);
				if (selected) {
					mcpButton?.setAttribute('aria-current', 'page');
				} else {
					mcpButton?.removeAttribute('aria-current');
				}
			}));
			this.createProjectFilterRow(primaryActions);
		} else if (!phoneLayout) {
			headerLabel.textContent = '';

			const collapseButton = DOM.append(headerActions, $('button.agent-sessions-collapse-button')) as HTMLButtonElement;
			collapseButton.type = 'button';
			const collapseLabel = localize('collapseSidebar', "Collapse sidebar");
			collapseButton.title = collapseLabel;
			collapseButton.setAttribute('aria-label', collapseLabel);
			collapseButton.appendChild(renderIcon(Codicon.layoutSidebarLeftOff));
			this._register(DOM.addDisposableListener(collapseButton, DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			}));

			// New chat, Search and Marketplace are all pinned flat action rows that
			// stay static above the scrolling projects list.
			const primaryActions = this.primaryActions = DOM.append(pinnedHeader, $('.agent-sessions-primary-actions'));
			this.createSidebarAction(primaryActions, Codicon.edit, localize('newChat', "New chat"), () => this.startNewChat());

			// Search opens the inline find widget, which replaces the pinned block's
			// rows while active.
			this.searchButton = DOM.append(primaryActions, $('button.agent-sessions-sidebar-action.agent-sessions-search-button')) as HTMLButtonElement;
			this.searchButton.type = 'button';
			const searchLabel = localize('searchProjects', "Search projects");
			this.searchButton.title = searchLabel;
			this.searchButton.setAttribute('aria-label', searchLabel);
			DOM.append(this.searchButton, $('span.agent-sessions-sidebar-action-icon')).appendChild(renderIcon(Codicon.search));
			DOM.append(this.searchButton, $('span.agent-sessions-sidebar-action-label', undefined, localize('search', "Search")));
			this._register(DOM.addDisposableListener(this.searchButton, DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.openFind();
			}));

			this.createSidebarAction(primaryActions, Codicon.extensions, localize('marketplace', "Marketplace"), anchor => {
				this.instantiationService.createInstance(SkillsLibraryController).showMarketplace(anchor);
			});

			const workspacesHeader = this.workspacesHeader = DOM.append(sessionsContent, $('.agent-sessions-workspaces-header'));
			DOM.append(workspacesHeader, $('span.agent-sessions-workspaces-title', undefined, localize('projectsHeader', "Projects")));
			this.createWorkspaceFilterButton(workspacesHeader);
		} else {
			headerRow.classList.add('phone-layout-empty');
		}

		// Container for the tree's find widget (toggled by the toolbar's Find action)
		const findWidgetContainer = this.findWidgetContainer = DOM.append(headerRow, $('.agent-sessions-find-widget-container'));
		findWidgetContainer.style.display = 'none';

		// Reserve DOM slot for mobile filter chips (phone layout only).
		// The actual widget is created after sessionsControl is available.
		const filterChipsContainer = isPhoneLayout(this.layoutService)
			? DOM.append(sessionsContent, $('.mobile-session-filter-chips-slot'))
			: undefined;

		// Sessions List Control
		this.sessionsControlContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(SessionsList, this.sessionsControlContainer, {
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			grouping: () => this.currentGrouping,
			sorting: () => this.currentSorting,
			simpleMode,
			workspaceFolderFilter: () => this.selectedWorkspaceFolderUri,
			knownWorkspaceFolders: () => this.recentWorkspaceFolders,
			simpleCompact: () => this.simpleCompact,
			findWidgetContainer,
			onSessionOpen: (resource, preserveFocus, sideBySide) => {
				this.mcpPage?.hide();
				const onOpened = () => {
					if (isWeb && isPhoneLayout(this.layoutService)) {
						this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
					}
				};
				if (sideBySide) {
					// Alt-click: open the session to the right of the last visible session in the grid.
					const session = this.sessionsManagementService.getSession(resource);
					if (session) {
						openSessionToTheSide(this.sessionsService, session, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
						return;
					}
				}
				this.sessionsService.openSession(resource, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
			},
		}));
		void this.refreshRecentWorkspaceFolders();
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));

		// Bottom-pinned footer: update button (above) + signed-in user identity.
		this.createFooter(sessionsSection, simpleMode);

		// Footer/profile and header changes can resize the flex viewport without
		// a workbench layout event. Keep the virtual tree inside its visible bounds
		// so the last folder and session rows remain fully scrollable.
		const listContainer = this.sessionsControlContainer;
		const listResizeObserver = this._register(new DOM.DisposableResizeObserver('SessionsView.listViewport', () => {
			sessionsControl.layout(listContainer.clientHeight, listContainer.clientWidth);
		}, DOM.getWindow(listContainer)));
		this._register(listResizeObserver.observe(listContainer));

		// Toggle header label/actions visibility when find widget opens/closes
		this._register(sessionsControl.onDidChangeFindOpenState(open => {
			this.isFindWidgetOpen = open;
			findWidgetContainer.style.display = open ? '' : 'none';
			this.updateHeaderLayout();
		}));

		// Close find widget on Escape
		this._register(DOM.addDisposableListener(findWidgetContainer, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				sessionsControl.closeFind();
				e.stopPropagation();
			}
		}));

		// Sync workspace group capped context key with persisted state
		this.workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());

		// Register session type filter actions (re-register when session types change)
		this.registerSessionTypeFilters(sessionsControl);
		this._register(this.sessionsManagementService.onDidChangeSessionTypes(() => {
			this.registerSessionTypeFilters(sessionsControl);
		}));

		// Register status filter actions (static set, registered once)
		this.registerStatusFilters(sessionsControl);

		// Refresh sessions when window gets focus to compensate for missing events
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				sessionsControl.refresh();
				void this.refreshRecentWorkspaceFolders();
			}
		}));

		// Listen to list updates and restore selection if nothing is selected
		this._register(sessionsControl.onDidUpdate(() => {
			if (!sessionsControl.hasFocusOrSelection()) {
				this.restoreLastSelectedSession();
			}
		}));

		// When the active session changes, select it in the list
		this._register(autorun(reader => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			if (activeSession) {
				if (!sessionsControl.reveal(activeSession.resource)) {
					sessionsControl.clearFocus();
				}
			} else {
				sessionsControl.clearFocus();
			}
		}));

		// Mobile filter chips (phone layout only) — created after sessionsControl
		// so we can wire it as the filter host.
		if (filterChipsContainer) {
			const chips = this._register(new MobileSessionFilterChips(filterChipsContainer, sessionsControl));
			this._register(chips.onDidRequestSortGroup(() => {
				this.openSortGroupSheet();
			}));
			this._register(chips.onDidRequestFind(() => {
				this.openFind();
			}));
		}

		// Agent Host toolbar (bottom, below customizations). Only rendered
		// in the sessions window on web desktop layouts: electron has no
		// host picker today (gated out at the menu level), phone layout
		// uses the mobile titlebar pill instead, and auxiliary windows do
		// not contribute any host actions — without this gate they would
		// show an empty toolbar shell.
		if (isWeb && this.scopedContextKeyService.contextMatchesRules(ContextKeyExpr.and(
			IsSessionsWindowContext,
			IsAuxiliaryWindowContext.toNegated(),
			IsPhoneLayoutContext.negate(),
		))) {
			this._register(this.instantiationService.createInstance(AgentHostShortcutsWidget, sessionsContainer, {
				onDidChangeLayout: () => {
					if (this.viewPaneContainer) {
						const { offsetHeight, offsetWidth } = this.viewPaneContainer;
						this.layoutBody(offsetHeight, offsetWidth);
					}
				},
			}));
		}
	}

	/**
	 * Bottom-pinned footer for the sidebar: an "Update available" button (shown
	 * only while the Backboard update context key is set) sitting directly above
	 * the signed-in user's identity card (avatar + name + plan/email). Both are
	 * Backboard-only, so the whole footer is skipped for non-Backboard builds and
	 * on phone layouts (which use their own chrome).
	 */
	private createFooter(container: HTMLElement, simpleMode: boolean): void {
		if (!isBackboardProduct() || isPhoneLayout(this.layoutService)) {
			return;
		}

		const footer = DOM.append(container, $('.agent-sessions-footer'));
		if (simpleMode) {
			const navigation = DOM.append(footer, $('.agent-sessions-footer-navigation'));
			const backgroundPicker = this._register(this.instantiationService.createInstance(SimpleModeBackgroundPicker));
			this.createSidebarAction(navigation, Codicon.fileMedia, localize('background', "Background"), anchor => {
				backgroundPicker.toggle(anchor);
			}, true);

			this.createSidebarAction(navigation, Codicon.graphLine, localize('usage', "Usage"), () => {
				// Simple mode can run without an extension host, so open the built-in
				// usage view instead of dispatching the extension-owned command.
				this.logService.info('[Backboard] Opening the Simple mode usage view.');
				this.usageView ??= this._register(this.instantiationService.createInstance(BackboardUsageView));
				this.usageView.show();
			});
			this.createSidebarAction(navigation, Codicon.settingsGear, localize('settings', "Settings"), () => {
				void this.commandService.executeCommand('workbench.action.openSettings');
			});
		}

		// Signed-in user identity card.
		const user = DOM.append(footer, $('.agent-sessions-user.visible'));
		const avatar = DOM.append(user, $('span.agent-sessions-user-avatar'));
		const text = DOM.append(user, $('.agent-sessions-user-text'));
		const nameEl = DOM.append(text, $('span.agent-sessions-user-name'));
		const subtitleEl = DOM.append(text, $('span.agent-sessions-user-subtitle'));
		nameEl.textContent = localize('backboardProfilePlaceholder', "Backboard Studio");
		avatar.classList.add('agent-sessions-user-logo');
		avatar.setAttribute('aria-hidden', 'true');
		avatar.appendChild(renderIcon(ThemeIcon.fromId('backboard-logo')));

		// Keep the update control independent of the optional account identity.
		const updateButton = DOM.append(footer, $('button.agent-sessions-update-pill')) as HTMLButtonElement;
		updateButton.type = 'button';
		this._register(DOM.addDisposableListener(updateButton, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			const command = this.scopedContextKeyService.getContextKeyValue<boolean>('backboard.updateCancellable')
				? 'backboard.cancelUpdate' : 'backboard.installAvailableUpdate';
			this.commandService.executeCommand(command).catch(onUnexpectedError);
		}));

		// Windows has no application menu — macOS hosts About, Settings and
		// Themes under the "Backboard Studio" app menu — so surface those
		// entries behind a cog button beside the identity card.
		if (isWindows) {
			// Keep the app menu beside the account identity.
			const appMenuButton = DOM.append(footer, $('button.agent-sessions-app-menu-icon')) as HTMLButtonElement;
			appMenuButton.type = 'button';
			const appMenuLabel = localize('backboardAppMenu', "Settings and More");
			appMenuButton.title = appMenuLabel;
			appMenuButton.setAttribute('aria-label', appMenuLabel);
			appMenuButton.setAttribute('aria-haspopup', 'menu');
			appMenuButton.appendChild(renderIcon(Codicon.settingsGear));
			this._register(DOM.addDisposableListener(appMenuButton, DOM.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.contextMenuService.showContextMenu({
					getAnchor: () => appMenuButton,
					getActions: () => [
						toAction({ id: 'workbench.action.showAboutDialog', label: localize('backboardAbout', "About {0}", this.productService.nameShort), run: () => this.commandService.executeCommand('workbench.action.showAboutDialog') }),
						new Separator(),
						toAction({ id: 'workbench.action.openSettings', label: localize('backboardSettings', "Settings"), run: () => this.commandService.executeCommand('workbench.action.openSettings') }),
						toAction({ id: 'workbench.action.openGlobalKeybindings', label: localize('backboardKeyboardShortcuts', "Keyboard Shortcuts"), run: () => this.commandService.executeCommand('workbench.action.openGlobalKeybindings') }),
						new Separator(),
						toAction({ id: 'workbench.action.selectTheme', label: localize('backboardColorTheme', "Color Theme"), run: () => this.commandService.executeCommand('workbench.action.selectTheme') }),
					],
				});
			}));
		}

		const UPDATE_CONTEXT_KEY = 'backboard.updateAvailable';
		const UPDATE_CANCELLABLE_CONTEXT_KEY = 'backboard.updateCancellable';
		const syncUpdateButton = () => {
			const cancellable = this.scopedContextKeyService.getContextKeyValue<boolean>(UPDATE_CANCELLABLE_CONTEXT_KEY) === true;
			const label = cancellable ? localize('stopBackboardUpdate', "Stop") : localize('updateBackboard', "Update");
			updateButton.textContent = label;
			updateButton.title = label;
			updateButton.setAttribute('aria-label', label);
			const available = this.scopedContextKeyService.getContextKeyValue<boolean>(UPDATE_CONTEXT_KEY) === true;
			footer.classList.toggle('has-update', available || cancellable);
		};
		syncUpdateButton();
		this._register(this.scopedContextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([UPDATE_CONTEXT_KEY, UPDATE_CANCELLABLE_CONTEXT_KEY]))) {
				syncUpdateButton();
			}
		}));
		resolveBackboardUserInfo(this.fileService, this.pathService, this.requestService, this.logService).then(info => {
			if (!info.name || !user.isConnected) {
				return;
			}
			nameEl.textContent = info.name;
			avatar.classList.remove('agent-sessions-user-logo');
			avatar.textContent = initialsFromName(info.name);
			const subtitle = info.plan ?? info.email;
			if (subtitle) {
				subtitleEl.textContent = subtitle;
			} else {
				subtitleEl.remove();
			}
			user.classList.add('visible');
		}).catch(error => {
			this.logService.warn(`[Backboard] Failed to resolve user info for the sidebar footer: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private createSidebarAction(container: HTMLElement, icon: ThemeIcon, label: string, run: (anchor: HTMLElement) => void, hasPopup = false): void {
		const button = DOM.append(container, $('button.agent-sessions-sidebar-action')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		if (hasPopup) {
			button.setAttribute('aria-haspopup', 'menu');
		}
		const iconElement = DOM.append(button, $('span.agent-sessions-sidebar-action-icon'));
		iconElement.appendChild(renderIcon(icon));
		DOM.append(button, $('span.agent-sessions-sidebar-action-label', undefined, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
			e.preventDefault();
			run(button);
		}));
	}

	private createWorkspaceFilterButton(container: HTMLElement): void {
		const button = this.filterButton = DOM.append(container, $('button.agent-sessions-filter-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		button.appendChild(renderIcon(Codicon.filter));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
			e.preventDefault();
			this.toggleFilterPopover();
		}));
		this._register(DOM.addDisposableListener(button.ownerDocument, DOM.EventType.POINTER_DOWN, e => {
			const target = e.target as Node | null;
			if (!target || !this.filterPopover || this.filterPopover.contains(target) || button.contains(target)) {
				return;
			}
			this.closeFilterPopover();
		}, true));
		this.updateGroupingToggleState();
	}

	private createProjectFilterRow(container: HTMLElement): void {
		const row = DOM.append(container, $('.agent-sessions-simple-project-row'));
		const button = this.projectFilterButton = DOM.append(row, $('button.agent-sessions-project-filter-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		DOM.append(button, $('span.agent-sessions-sidebar-action-icon')).appendChild(renderIcon(Codicon.folder));
		this.projectFilterLabel = DOM.append(button, $('span.agent-sessions-project-filter-label'));
		DOM.append(button, $('span.agent-sessions-project-filter-chevron')).appendChild(renderIcon(Codicon.chevronDown));
		this.updateProjectFilterLabel();
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
			e.preventDefault();
			void this.toggleProjectFilterPopover(row);
		}));
		this._register(DOM.addDisposableListener(button.ownerDocument, DOM.EventType.POINTER_DOWN, e => {
			const target = e.target as Node | null;
			if (!target || !this.filterPopover || this.filterPopover.contains(target) || button.contains(target)) {
				return;
			}
			this.closeFilterPopover();
		}, true));

		const newProjectButton = DOM.append(row, $('button.agent-sessions-simple-icon-button')) as HTMLButtonElement;
		newProjectButton.type = 'button';
		const newProjectLabel = localize('newProject', "Add project");
		newProjectButton.title = newProjectLabel;
		newProjectButton.setAttribute('aria-label', newProjectLabel);
		newProjectButton.appendChild(renderIcon(Codicon.newFolder));
		this._register(DOM.addDisposableListener(newProjectButton, DOM.EventType.CLICK, e => {
			e.preventDefault();
			void this.commandService.executeCommand('workbench.action.addRootFolder');
		}));
	}

	private updateProjectFilterLabel(): void {
		const label = this.selectedWorkspaceFolderLabel ?? localize('allFolders', "All folders");
		this.projectFilterLabel && (this.projectFilterLabel.textContent = label);
		this.projectFilterButton?.setAttribute('title', label);
		this.projectFilterButton?.setAttribute('aria-label', localize('filterThreadsByFolder', "Filter threads by folder: {0}", label));
	}

	private async refreshRecentWorkspaceFolders(): Promise<void> {
		try {
			const recentlyOpened = await this.workspacesService.getRecentlyOpened();
			const folders = new Map<string, { uri: string; label: string }>();
			for (const recent of recentlyOpened.workspaces) {
				if (!isRecentFolder(recent)) {
					continue;
				}
				const uri = recent.folderUri.toString();
				if (!folders.has(uri)) {
					folders.set(uri, { uri, label: recent.label || basename(recent.folderUri) });
				}
			}
			this.recentWorkspaceFolders = [...folders.values()];
			this.sessionsControl?.refresh();
		} catch (error) {
			this.logService.warn('[SessionsView] Unable to load recent folders for the folder view', error);
		}
	}

	private async toggleProjectFilterPopover(container: HTMLElement): Promise<void> {
		if (this.filterPopover) {
			this.closeFilterPopover();
			return;
		}
		if (!this.projectFilterButton) {
			return;
		}

		const popover = this.filterPopover = DOM.append(container, $('.agent-sessions-filter-popover.agent-sessions-project-filter-popover'));
		popover.setAttribute('role', 'menu');
		this.projectFilterButton.setAttribute('aria-expanded', 'true');

		const folders = new Map<string, { label: string; description?: string }>();
		for (const session of this.sessionsManagementService.getSessions()) {
			for (const folder of session.workspace.get()?.folders ?? []) {
				const uri = folder.root.toString();
				if (!folders.has(uri)) {
					folders.set(uri, { label: folder.name || basename(folder.root), description: folder.description });
				}
			}
		}

		// Include recently opened folders even when they do not have a thread yet.
		// Session workspace labels are not unique, so folder URIs remain the stable
		// identity used for both deduplication and filtering.
		try {
			const recentlyOpened = await this.workspacesService.getRecentlyOpened();
			for (const recent of recentlyOpened.workspaces) {
				if (!isRecentFolder(recent)) {
					continue;
				}
				const uri = recent.folderUri.toString();
				if (!folders.has(uri)) {
					folders.set(uri, { label: recent.label || basename(recent.folderUri) });
				}
			}
		} catch (error) {
			this.logService.warn('[SessionsView] Unable to load recent folders for the folder filter', error);
		}

		if (this.filterPopover !== popover) {
			return;
		}

		const options: readonly { label: string; uri: string | undefined; description?: string }[] = [
			{ label: localize('allFolders', "All folders"), uri: undefined },
			...[...folders.entries()]
				.map(([uri, folder]) => ({ ...folder, uri }))
				.sort((a, b) => a.label.localeCompare(b.label) || a.uri.localeCompare(b.uri)),
		];

		for (const option of options) {
			const selected = option.uri === this.selectedWorkspaceFolderUri;
			const optionButton = DOM.append(popover, $('button.agent-sessions-project-filter-option')) as HTMLButtonElement;
			optionButton.type = 'button';
			optionButton.setAttribute('role', 'menuitemradio');
			optionButton.setAttribute('aria-checked', String(selected));
			optionButton.title = option.description ? `${option.label} — ${option.description}` : option.label;
			DOM.append(optionButton, $('span.agent-sessions-project-filter-check')).appendChild(renderIcon(selected ? Codicon.check : Codicon.blank));
			DOM.append(optionButton, $('span.agent-sessions-project-filter-option-icon')).appendChild(renderIcon(Codicon.folder));
			const content = DOM.append(optionButton, $('span.agent-sessions-project-filter-option-content'));
			DOM.append(content, $('span.agent-sessions-project-filter-option-label', undefined, option.label));
			if (option.description) {
				DOM.append(content, $('span.agent-sessions-project-filter-option-description', undefined, option.description));
			}
			optionButton.addEventListener(DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.selectedWorkspaceFolderUri = option.uri;
				this.selectedWorkspaceFolderLabel = option.uri ? option.label : undefined;
				this.updateProjectFilterLabel();
				this.closeFilterPopover();
				this.sessionsControl?.refresh();
			});
		}
	}

	private updateGroupingToggleState(): void {
		if (!this.filterButton) {
			return;
		}

		const groupedByTime = this.currentGrouping === SessionsGrouping.Date;
		const label = groupedByTime
			? localize('groupedByTime', "Group by Time")
			: localize('groupedByProject', "Group by Project");
		this.filterButton.setAttribute('title', label);
		this.filterButton.setAttribute('aria-label', label);
	}

	private toggleFilterPopover(): void {
		if (this.filterPopover) {
			this.closeFilterPopover();
			return;
		}

		if (!this.workspacesHeader || !this.filterButton) {
			return;
		}

		const popover = this.filterPopover = DOM.append(this.workspacesHeader, $('.agent-sessions-filter-popover'));
		popover.setAttribute('role', 'menu');
		this.filterButton.setAttribute('aria-expanded', 'true');

		this.createFilterPopoverDropdown(
			popover,
			localize('groupBy', "Group by"),
			this.currentGrouping === SessionsGrouping.Workspace ? localize('project', "Project") : localize('time', "Time"),
			[
				{
					label: localize('project', "Project"),
					selected: this.currentGrouping === SessionsGrouping.Workspace,
					run: () => this.setGrouping(SessionsGrouping.Workspace),
				},
				{
					label: localize('time', "Time"),
					selected: this.currentGrouping === SessionsGrouping.Date,
					run: () => this.setGrouping(SessionsGrouping.Date),
				},
			]
		);
		this.createFilterPopoverDropdown(
			popover,
			localize('sortBy', "Sort by"),
			this.currentSorting === SessionsSorting.Updated ? localize('updated', "Updated") : localize('created', "Created"),
			[
				{
					label: localize('updated', "Updated"),
					selected: this.currentSorting === SessionsSorting.Updated,
					run: () => this.setSorting(SessionsSorting.Updated),
				},
				{
					label: localize('created', "Created"),
					selected: this.currentSorting === SessionsSorting.Created,
					run: () => this.setSorting(SessionsSorting.Created),
				},
			]
		);
	}

	private createFilterPopoverDropdown(container: HTMLElement, label: string, value: string, options: readonly { label: string; selected: boolean; run: () => void }[]): void {
		const section = DOM.append(container, $('.agent-sessions-filter-popover-section'));
		const header = DOM.append(section, $('button.agent-sessions-filter-popover-header')) as HTMLButtonElement;
		const optionsContainer = DOM.append(section, $('.agent-sessions-filter-popover-options'));
		header.type = 'button';
		header.setAttribute('aria-expanded', 'true');
		DOM.append(header, $('span.agent-sessions-filter-popover-label', undefined, label));
		DOM.append(header, $('span.agent-sessions-filter-popover-value', undefined, value));
		DOM.append(header, $('span.agent-sessions-filter-popover-chevron')).appendChild(renderIcon(Codicon.chevronDown));
		header.addEventListener(DOM.EventType.CLICK, e => {
			e.preventDefault();
			const expanded = header.getAttribute('aria-expanded') !== 'false';
			header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
			section.classList.toggle('collapsed', expanded);
		});
		for (const option of options) {
			const row = DOM.append(optionsContainer, $('button.agent-sessions-filter-popover-option')) as HTMLButtonElement;
			row.type = 'button';
			row.setAttribute('role', 'menuitemradio');
			row.setAttribute('aria-checked', String(option.selected));
			DOM.append(row, $('span.agent-sessions-filter-popover-check')).appendChild(renderIcon(option.selected ? Codicon.check : Codicon.blank));
			DOM.append(row, $('span.agent-sessions-filter-popover-option-label', undefined, option.label));
			row.addEventListener(DOM.EventType.CLICK, e => {
				e.preventDefault();
				option.run();
				this.closeFilterPopover();
			});
		}
	}

	private closeFilterPopover(): void {
		this.filterPopover?.remove();
		this.filterPopover = undefined;
		this.filterButton?.setAttribute('aria-expanded', 'false');
		this.projectFilterButton?.setAttribute('aria-expanded', 'false');
	}

	focusCustomizations(): void {
	}

	private restoreLastSelectedSession(): void {
		const activeSession = this.sessionsService.activeSession.get();
		if (activeSession && this.sessionsControl) {
			this.sessionsControl.reveal(activeSession.resource);
		}
	}

	private readonly registeredFilterTypeIds = new Set<string>();

	private registerSessionTypeFilters(sessionsControl: SessionsList): void {
		const sessionTypes = this.sessionsManagementService.getAllSessionTypes();
		for (let i = 0; i < sessionTypes.length; i++) {
			const type = sessionTypes[i];

			// Skip if already registered (action IDs are global and can't be re-registered)
			if (this.registeredFilterTypeIds.has(type.id)) {
				continue;
			}
			this.registeredFilterTypeIds.add(type.id);

			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterType.${type.id}`, !sessionsControl.isSessionTypeExcluded(type.id));
			const contextKeyInstance = contextKey.bindTo(this.scopedContextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterType.${type.id}`,
						title: type.label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '1_types',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isSessionTypeExcluded(type.id);
					sessionsControl.setSessionTypeExcluded(type.id, !isExcluded);
					contextKeyInstance.set(isExcluded); // was excluded, now included (toggle)
				}
			}));
		}
	}

	private registerStatusFilters(sessionsControl: SessionsList): void {
		const statusFilters: { status: SessionStatus; label: string }[] = [
			{ status: SessionStatus.Completed, label: localize('statusCompleted', "Completed") },
			{ status: SessionStatus.InProgress, label: localize('statusInProgress', "In Progress") },
			{ status: SessionStatus.NeedsInput, label: localize('statusNeedsInput', "Input Needed") },
			{ status: SessionStatus.Error, label: localize('statusFailed', "Failed") },
		];
		for (let i = 0; i < statusFilters.length; i++) {
			const { status, label } = statusFilters[i];
			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterStatus.${status}`, !sessionsControl.isStatusExcluded(status));
			const contextKeyInstance = contextKey.bindTo(this.scopedContextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterStatus.${status}`,
						title: label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '2_status',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isStatusExcluded(status);
					sessionsControl.setStatusExcluded(status, !isExcluded);
					contextKeyInstance.set(isExcluded);
				}
			}));
		}

		// Archived toggle
		const archivedContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showArchived', !sessionsControl.isExcludeArchived());
		const archivedContextKeyInstance = archivedContextKey.bindTo(this.scopedContextKeyService);
		this.filterContextKeys.set(archivedContextKey.key, { key: archivedContextKeyInstance, getDefault: () => false });

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.filterArchived',
					title: localize('filterArchived', "Done"),
					toggled: ContextKeyExpr.equals(archivedContextKey.key, true),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '3_props',
						order: 0,
					}]
				});
			}
			override run() {
				const excluding = sessionsControl.isExcludeArchived();
				sessionsControl.setExcludeArchived(!excluding);
				archivedContextKeyInstance.set(excluding); // was excluding → now showing
			}
		}));

		// Read toggle
		const readContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showRead', !sessionsControl.isExcludeRead());
		const readContextKeyInstance = readContextKey.bindTo(this.scopedContextKeyService);
		this.filterContextKeys.set(readContextKey.key, { key: readContextKeyInstance, getDefault: () => true });

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.filterRead',
					title: localize('filterRead', "Read"),
					toggled: ContextKeyExpr.equals(readContextKey.key, true),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '3_props',
						order: 1,
					}]
				});
			}
			override run() {
				const excluding = sessionsControl.isExcludeRead();
				sessionsControl.setExcludeRead(!excluding);
				readContextKeyInstance.set(excluding);
			}
		}));

		// Reset filter action
		const filterContextKeys = this.filterContextKeys;
		const workspaceGroupCappedContextKey = this.workspaceGroupCappedContextKey;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.resetFilters',
					title: localize('resetFilters', "Reset"),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '4_reset',
						order: 0,
					}]
				});
			}
			override run() {
				sessionsControl.resetFilters();
				for (const { key, getDefault } of filterContextKeys.values()) {
					key.set(getDefault());
				}
				workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.updateHeaderLayout();

		if (!this.sessionsControl || !this.sessionsControlContainer) {
			return;
		}

		this.sessionsControl.layout(this.sessionsControlContainer.offsetHeight, this.sessionsControlContainer.offsetWidth || width);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	openFind(): void {
		this.isFindWidgetOpen = true;
		if (this.findWidgetContainer) {
			// Show container before opening find so the widget can be focused
			this.findWidgetContainer.style.display = '';
		}
		this.updateHeaderLayout();
		this.sessionsControl?.openFind();
	}

	private updateHeaderLayout(): void {
		if (!this.headerRow || !this.headerLabel || !this.headerActions) {
			return;
		}

		// On phone the desktop header content is hidden; the row is only
		// visible when the find widget is open (so the user can search).
		if (isPhoneLayout(this.layoutService)) {
			this.headerRow.classList.toggle('phone-layout-empty', !this.isFindWidgetOpen);
			return;
		}

		if (this.isFindWidgetOpen) {
			this.headerRow.classList.remove('agent-sessions-header-hidden');
			this.headerLabel.style.display = 'none';
			this.headerActions.style.display = 'none';
			// The search row lives inside the primary actions block, so hiding the
			// block hides New chat / Search / Marketplace together while find is open.
			if (this.primaryActions) {
				this.primaryActions.style.display = 'none';
			}
			return;
		}

		this.headerRow.classList.add('agent-sessions-header-hidden');
		this.headerLabel.style.display = 'none';
		this.headerActions.style.display = 'none';
		if (this.primaryActions) {
			this.primaryActions.style.display = '';
		}
	}

	/**
	 * Phone-only: present a bottom sheet with the four sort/group toggles.
	 * Filtering on phone is performed via the status filter chips, so the
	 * sheet intentionally omits "Filter", "Show Recent/All Sessions", and
	 * "Collapse All Groups" actions found in the desktop submenu.
	 */
	private openSortGroupSheet(): void {
		const sortTitle = localize('sortGroupSheet.sort', "Sort");
		const groupTitle = localize('sortGroupSheet.group', "Group");

		const items: IMobileSortGroupSheetItem[] = [
			{
				id: SessionsSorting.Created,
				label: localize('sortByCreated', "Sort by Created"),
				checked: this.currentSorting === SessionsSorting.Created,
				group: 'sort',
				groupTitle: sortTitle,
			},
			{
				id: SessionsSorting.Updated,
				label: localize('sortByUpdated', "Sort by Updated"),
				checked: this.currentSorting === SessionsSorting.Updated,
				group: 'sort',
			},
			{
				id: SessionsGrouping.Workspace,
				label: localize('groupByProject', "Group by Project"),
				checked: this.currentGrouping === SessionsGrouping.Workspace,
				group: 'group',
				groupTitle: groupTitle,
			},
			{
				id: SessionsGrouping.Date,
				label: localize('groupByTime', "Group by Time"),
				checked: this.currentGrouping === SessionsGrouping.Date,
				group: 'group',
			},
		];

		showMobileSortGroupSheet(this.layoutService.mainContainer, localize('sortGroupSheet.title', "Sort"), items).then(selectedId => {
			if (!selectedId) {
				return;
			}
			if (selectedId === SessionsSorting.Created || selectedId === SessionsSorting.Updated) {
				this.setSorting(selectedId);
			} else if (selectedId === SessionsGrouping.Workspace || selectedId === SessionsGrouping.Date) {
				this.setGrouping(selectedId);
			}
		});
	}

	setGrouping(grouping: SessionsGrouping): void {
		if (this.currentGrouping === grouping) {
			return;
		}

		this.currentGrouping = grouping;
		this.storageService.store(GROUPING_STORAGE_KEY, this.currentGrouping, StorageScope.PROFILE, StorageTarget.USER);
		this.groupingContextKey?.set(this.currentGrouping);
		this.updateGroupingToggleState();
		this.sessionsControl?.resetSectionCollapseState();
		this.sessionsControl?.update(true);
	}

	setSorting(sorting: SessionsSorting): void {
		if (this.currentSorting === sorting) {
			return;
		}

		this.currentSorting = sorting;
		this.storageService.store(SORTING_STORAGE_KEY, this.currentSorting, StorageScope.PROFILE, StorageTarget.USER);
		this.sortingContextKey?.set(this.currentSorting);
		this.sessionsControl?.update();
	}
}
