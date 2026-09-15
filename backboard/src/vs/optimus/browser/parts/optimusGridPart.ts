/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/optimusGridPart.css';
import { renderBackboardAuthGate } from '../../../workbench/contrib/chat/browser/backboardAuthSetup.js';
import { IBackboardAuthService } from '../../../workbench/contrib/chat/common/backboardAuth.js';
import { $, addDisposableListener, append, DragAndDropObserver, EventHelper, EventType } from '../../../base/browser/dom.js';
import { localize } from '../../../nls.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../base/common/observable.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { AbstractProgressScope, ScopedProgressIndicator } from '../../../workbench/services/progress/browser/progressIndicator.js';
import { LocalSelectionTransfer } from '../../../platform/dnd/browser/dnd.js';
import { DraggedSessionIdentifier } from '../../../sessions/browser/dnd.js';
import { SessionView } from '../../../sessions/browser/parts/sessionView.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../../sessions/common/theme.js';
import { ISessionsManagementService, IActiveSession } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../../sessions/services/sessions/common/session.js';
import { filterAndSortOptimusSessions, getOptimusDashboardBucket, IOptimusDashboardFilters, IOptimusSessionSummary, OptimusDashboardArchiveFilter, OptimusDashboardBucket, OptimusDashboardSort, OptimusDashboardTimeRange } from '../../common/optimusSessions.js';
import { OptimusCard, IOptimusCardSessionModel } from './optimusCard.js';

export const OPTIMUS_NEW_SESSION_COMMAND_ID = 'optimus.newSession';
export const OPTIMUS_FOCUS_SESSION_COMMAND_ID = 'optimus.focusSession';
export const OPTIMUS_DELETE_SESSION_COMMAND_ID = 'optimus.deleteSession';
export const OPTIMUS_CLOSE_SESSION_COMMAND_ID = 'optimus.closeSession';
export const OPTIMUS_SHOW_DASHBOARD_COMMAND_ID = 'optimus.showDashboard';
export const OPTIMUS_SHOW_FOCUSED_SESSION_CONTENT_COMMAND_ID = 'optimus.showFocusedSessionContent';
export const OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID = 'optimus.showDashboardContent';
export const OPTIMUS_TOGGLE_VIEW_MODE_COMMAND_ID = 'optimus.toggleViewMode';
export const OPTIMUS_SET_VIEW_MODE_COMMAND_ID = 'optimus.setViewMode';

export type OptimusViewMode = 'board' | 'kanban';

/** Current dashboard presentation, exposed for keyboard commands and chrome. */
export const OPTIMUS_VIEW_MODE_CONTEXT_KEY = new RawContextKey<OptimusViewMode>('optimusViewMode', 'board');

const VIEW_MODE_STORAGE_KEY = 'optimus.viewMode';
const DASHBOARD_DISPLAY_STORAGE_KEY = 'optimus.dashboardDisplay';

const BOARD_BUCKETS: readonly { readonly key: OptimusDashboardBucket; readonly label: string; readonly icon: string }[] = [
	{ key: 'running', label: localize('optimus.board.running', "Running"), icon: 'codicon-loading.codicon-modifier-spin' },
	{ key: 'blocked', label: localize('optimus.board.blocked', "Blocked"), icon: 'codicon-error' },
	{ key: 'ready', label: localize('optimus.board.ready', "Ready"), icon: 'codicon-check' },
];

interface IBoardColumn {
	readonly element: HTMLElement;
	readonly listEl: HTMLElement;
	readonly countEl: HTMLElement;
}

type OptimusDashboardGroup = 'none' | 'workspace';

interface IOptimusDashboardDisplayState {
	readonly sort: OptimusDashboardSort;
	readonly group: OptimusDashboardGroup;
	readonly unreadFirst: boolean;
}

/**
 * Sessions open on the board. Only chats the user opened (sidebar click,
 * drop, new task) get a card, and the set persists across relaunches so the
 * board comes back exactly as it was left.
 */
const OPEN_SESSIONS_STORAGE_KEY = 'optimus.openSessions';

interface ICardEntry {
	readonly card: OptimusCard;
	readonly store: DisposableStore;
}

/**
 * Main content part of the Optimus window: a grid of compact task cards plus
 * a start-a-task placeholder. A passive renderer in the same sense as the
 * Simple window's SessionsPart — the sessions service drives it via
 * {@link updateVisibleSessions}, and card focus/clicks are reported back via
 * {@link onDidFocusSession}.
 *
 * Cards are keyed by session, NOT by grid slot: closing or adding a session
 * must never rebind the remaining cards to different sessions, or their
 * attached live transcripts would be torn down.
 */
export class OptimusGridPart extends Part {

	override readonly minimumWidth: number = 220;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	/** Kanban shows up to ten agents in each of its three status lanes. */
	private static readonly KANBAN_ROWS_PER_PAGE = 10;
	/** Board is a three-column, ten-row card wall. */
	private static readonly GRID_PAGE_SIZE = 9;

	private readonly cardEntries = new Map<string, ICardEntry>();
	private contentAreaEl: HTMLElement | undefined;
	private boardContainer: HTMLElement | undefined;
	private gridContainer: HTMLElement | undefined;
	private placeholderCard: OptimusCard | undefined;
	private pagerElement: HTMLElement | undefined;
	private pagerLabel: HTMLElement | undefined;
	private pagerPrevious: HTMLButtonElement | undefined;
	private pagerNext: HTMLButtonElement | undefined;
	private pageIndex = 0;
	private focusedSessionHost: HTMLElement | undefined;
	private focusedSessionBody: HTMLElement | undefined;
	private focusedHeaderTypePickerSlot: HTMLElement | undefined;
	private focusedHeaderTitleSlot: HTMLElement | undefined;
	private focusedHeaderToolbarSlot: HTMLElement | undefined;
	private readonly focusedSessionView = this._register(new MutableDisposable<SessionView>());
	private focusedMode = false;
	private readonly renderSessionTypePickerInControls = observableValue<boolean>(this, false);
	private readonly boardColumns = new Map<OptimusDashboardBucket, IBoardColumn>();
	private readonly viewSwitcherButtons = new Map<OptimusViewMode, HTMLButtonElement>();
	private viewMode: OptimusViewMode = 'board';
	private readonly viewModeContextKey;
	/** Watches bound sessions' dashboard fields so filtering and sorting stay live. */
	private readonly sessionWatches = new Map<string, { readonly session: ISession; readonly store: DisposableStore }>();
	private readonly filterChipStore = this._register(new DisposableStore());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.refreshCards(), 250));
	private progressBar: ProgressBar | undefined;
	private progressIndicator: IProgressIndicator | undefined;
	private displayButton: HTMLButtonElement | undefined;
	private filterButton: HTMLButtonElement | undefined;
	private resetButton: HTMLButtonElement | undefined;
	private controlsState = '';
	private filterCountElement: HTMLElement | undefined;
	private filterChipsElement: HTMLElement | undefined;
	private resultsElement: HTMLElement | undefined;
	private lastModels: readonly IOptimusCardSessionModel[] = [];
	private visibleSessions: readonly (IActiveSession | undefined)[] = [];
	private activeSession: IActiveSession | undefined;
	private readonly filteredBuckets = new Set<OptimusDashboardBucket>();
	private timeRange: OptimusDashboardTimeRange = 'all';
	private archiveFilter: OptimusDashboardArchiveFilter = 'exclude';
	private readonly filteredProviders = new Set<string>();
	private readonly filteredWorkspaces = new Set<string>();
	private sortMode: OptimusDashboardSort = 'updated-desc';
	private groupMode: OptimusDashboardGroup = 'none';
	private unreadFirst = false;

	private readonly _onDidFocusSession = this._register(new Emitter<string>());
	readonly onDidFocusSession: Event<string> = this._onDidFocusSession.event;

	private readonly openSessions = new Set<string>();
	/** Session keys already seen in the service, to spot newly created chats. */
	private knownSessionKeys: Set<string> | undefined;
	private readonly windowStartTime = Date.now();
	private readonly sessionTransfer = LocalSelectionTransfer.getInstance<DraggedSessionIdentifier>();

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IBackboardAuthService private readonly authService: IBackboardAuthService,
	) {
		super(
			Parts.SESSIONS_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);

		try {
			const raw = this.storageService.get(OPEN_SESSIONS_STORAGE_KEY, StorageScope.PROFILE);
			if (raw) {
				for (const key of JSON.parse(raw) as string[]) {
					this.openSessions.add(key);
				}
			}
		} catch {
			// Malformed storage: start with an empty board.
		}

		const storedViewMode = this.storageService.get(VIEW_MODE_STORAGE_KEY, StorageScope.PROFILE);
		this.viewMode = storedViewMode === 'kanban' || storedViewMode === 'list' ? 'kanban' : 'board';
		try {
			const displayState = JSON.parse(this.storageService.get(DASHBOARD_DISPLAY_STORAGE_KEY, StorageScope.PROFILE, '{}')) as Partial<IOptimusDashboardDisplayState>;
			if (displayState.sort && ['updated-desc', 'updated-asc', 'created-desc', 'created-asc', 'title-asc', 'title-desc'].includes(displayState.sort)) {
				this.sortMode = displayState.sort;
			}
			if (displayState.group === 'workspace') {
				this.groupMode = 'workspace';
			}
			this.unreadFirst = displayState.unreadFirst === true;
		} catch {
			// Malformed display preferences: retain dashboard defaults.
		}
		this.viewModeContextKey = OPTIMUS_VIEW_MODE_CONTEXT_KEY.bindTo(contextKeyService);
		this.viewModeContextKey.set(this.viewMode);
		this._register(CommandsRegistry.registerCommand(OPTIMUS_TOGGLE_VIEW_MODE_COMMAND_ID, () => this.toggleViewMode()));
		this._register(CommandsRegistry.registerCommand(OPTIMUS_SET_VIEW_MODE_COMMAND_ID, (_accessor, mode: unknown) => this.setViewMode(mode === 'kanban' || mode === 'list' ? 'kanban' : 'board')));
		this._register(CommandsRegistry.registerCommand(OPTIMUS_SHOW_FOCUSED_SESSION_CONTENT_COMMAND_ID, (_accessor, session: IActiveSession | undefined) => this.showFocusedSession(session)));
		this._register(CommandsRegistry.registerCommand(OPTIMUS_SHOW_DASHBOARD_CONTENT_COMMAND_ID, () => this.showDashboardContent()));

		this._register(this.sessionsManagementService.onDidChangeSessions(() => this.scheduleRefresh()));
	}

	private toggleViewMode(): void {
		this.setViewMode(this.viewMode === 'board' ? 'kanban' : 'board');
	}

	private setViewMode(mode: OptimusViewMode): void {
		if (this.viewMode === mode) {
			return;
		}
		this.viewMode = mode;
		this.storageService.store(VIEW_MODE_STORAGE_KEY, this.viewMode, StorageScope.PROFILE, StorageTarget.USER);
		this.viewModeContextKey.set(this.viewMode);
		this.contentAreaEl?.classList.toggle('view-board', this.viewMode === 'board');
		this.resetPage();
	}

	private showFocusedSession(session: IActiveSession | undefined): void {
		// Advanced keeps the board as its empty state. New task creation is routed
		// to the canonical Simple composer rather than a duplicate side chat.
		if (!session) {
			this.showDashboardContent();
			return;
		}
		const host = this.focusedSessionBody;
		if (!host) {
			return;
		}
		this.focusedMode = true;
		this.contentAreaEl?.classList.add('focused-session');
		this.refreshScheduler.cancel();
		this.disposeDashboardCards();
		this.clearSessionWatches();
		if (!this.focusedSessionView.value) {
			this.focusedSessionView.value = this.instantiationService.createInstance(SessionView);
			host.appendChild(this.focusedSessionView.value.element);
		}
		this.focusedSessionView.value.element.classList.add('is-active');
		this.focusedSessionView.value.setActive(true);
		this.focusedSessionView.value.openSession(session, {
			renderSessionTypePickerInControls: this.renderSessionTypePickerInControls,
			headerTypePickerSlot: this.focusedHeaderTypePickerSlot,
			headerToolbarSlot: this.focusedHeaderToolbarSlot,
		});
		if (session && this.focusedHeaderTitleSlot && this.focusedHeaderToolbarSlot) {
			this.focusedSessionView.value.mountHeaderIntoPanel(this.focusedHeaderTitleSlot, this.focusedHeaderToolbarSlot);
		} else {
			this.focusedSessionView.value.restoreHeaderToView();
		}
		this.layoutFocusedSession();
		this.focusedSessionView.value.focus();
	}

	private showDashboardContent(): void {
		this.focusedMode = false;
		this.contentAreaEl?.classList.remove('focused-session');
		this.focusedSessionView.value?.setActive(false);
		this.focusedSessionView.value?.element.remove();
		this.focusedSessionView.clear();
		this.refreshCards();
	}

	private persistDisplayState(): void {
		const state: IOptimusDashboardDisplayState = { sort: this.sortMode, group: this.groupMode, unreadFirst: this.unreadFirst };
		this.storageService.store(DASHBOARD_DISPLAY_STORAGE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
	}

	private persistOpenSessions(): void {
		this.storageService.store(OPEN_SESSIONS_STORAGE_KEY, JSON.stringify([...this.openSessions]), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private closeSession(key: string): void {
		if (this.openSessions.delete(key)) {
			this.persistOpenSessions();
		}
		this.refreshCards();
	}

	/** Sessions opened through the service (sidebar click, drop, new chat) join the board. */
	private openSession(key: string): void {
		if (this.openSessions.has(key)) {
			return;
		}
		this.openSessions.add(key);
		this.persistOpenSessions();
	}

	override create(parent: HTMLElement): void {
		// The workbench grid reads `part.element`; the Part base does not set it.
		this.element = parent;
		super.create(parent);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = append(parent, $('.content.optimus-grid-content'));
		this.contentAreaEl = contentArea;
		contentArea.classList.toggle('view-board', this.viewMode === 'board');

		this.progressBar = this._register(new ProgressBar(contentArea, defaultProgressBarStyles));
		this.progressBar.hide();

		this.createDashboardToolbar(contentArea);

		// Kanban: three live status lanes. The alternative Board presentation uses
		// the same card instances in the flat 3×10 grid below.
		this.boardContainer = append(contentArea, $('.optimus-kanban.optimus-board'));
		for (const bucket of BOARD_BUCKETS) {
			const element = append(this.boardContainer, $(`.optimus-kanban-column.${bucket.key}`));
			const header = append(element, $('.optimus-kanban-column-header'));
			append(header, $(`span.codicon.${bucket.icon}.optimus-kanban-column-icon`));
			append(header, $('span.optimus-kanban-column-label')).textContent = bucket.label;
			const countEl = append(header, $('span.optimus-kanban-column-count'));
			const listEl = append(element, $('.optimus-kanban-column-list'));
			listEl.setAttribute('role', 'group');
			listEl.setAttribute('aria-label', bucket.label);
			const empty = append(element, $('.optimus-kanban-empty'));
			empty.textContent = localize('optimus.lane.empty', "No Agents on This Page");
			this.boardColumns.set(bucket.key, { element, listEl, countEl });
		}

		// Board keeps the same rich cards in a flat, paginated 3×10 grid.
		this.gridContainer = append(contentArea, $('.optimus-grid'));
		this.gridContainer.setAttribute('role', 'group');
		this.gridContainer.setAttribute('aria-label', localize('optimus.list.ariaLabel', "Sessions"));

		// First-run hero shown instead of a lone dashed placeholder card.
		const emptyState = append(contentArea, $('.optimus-empty-state'));
		const hero = append(emptyState, $('button.optimus-empty-hero')) as HTMLButtonElement;
		hero.type = 'button';
		append(hero, $('.optimus-empty-logo'));
		append(hero, $('.optimus-empty-title')).textContent = localize('optimus.empty.title', "What should we build?");
		append(hero, $('.optimus-empty-subtitle')).textContent = localize('optimus.empty.subtitle', "Start or drag a chat into the agent workspace.");
		const cta = append(hero, $('.optimus-empty-cta'));
		append(cta, $('span.codicon.codicon-add'));
		append(cta, $('span')).textContent = localize('optimus.empty.cta', "Start a Task");
		this._register(addDisposableListener(hero, EventType.CLICK, () => {
			this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
		}));

		const noResults = append(contentArea, $('.optimus-no-results'));
		append(noResults, $('.codicon.codicon-search'));
		append(noResults, $('.optimus-no-results-title')).textContent = localize('optimus.noResults.title', "No Sessions Match These Filters");
		const clearFilters = append(noResults, $('button.optimus-no-results-action')) as HTMLButtonElement;
		clearFilters.type = 'button';
		clearFilters.textContent = localize('optimus.noResults.clear', "Reset Filters");
		this._register(addDisposableListener(clearFilters, EventType.CLICK, () => this.resetFilters()));

		const placeholder = this._register(this.instantiationService.createInstance(OptimusCard, this.gridContainer));
		this._register(placeholder.onDidAction(action => {
			if (action.kind === 'create-session') {
				this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
			}
		}));
		this.placeholderCard = placeholder;

		this.pagerElement = append(contentArea.querySelector<HTMLElement>('.optimus-dashboard-controls')!, $('.optimus-grid-pager'));
		this.pagerPrevious = append(this.pagerElement, $('button.codicon.codicon-chevron-left')) as HTMLButtonElement;
		this.pagerPrevious.type = 'button';
		this.pagerPrevious.title = localize('optimus.pager.previous', "Previous Page");
		this.pagerPrevious.setAttribute('aria-label', this.pagerPrevious.title);
		this.pagerLabel = append(this.pagerElement, $('span.optimus-grid-pager-label'));
		this.pagerNext = append(this.pagerElement, $('button.codicon.codicon-chevron-right')) as HTMLButtonElement;
		this.pagerNext.type = 'button';
		this.pagerNext.title = localize('optimus.pager.next', "Next Page");
		this.pagerNext.setAttribute('aria-label', this.pagerNext.title);
		this.pagerLabel.setAttribute('aria-live', 'polite');
		this._register(addDisposableListener(this.pagerPrevious, EventType.CLICK, () => {
			this.pageIndex = Math.max(0, this.pageIndex - 1);
			this.refreshCards();
			this.resetPageScroll();
		}));
		this._register(addDisposableListener(this.pagerNext, EventType.CLICK, () => {
			this.pageIndex++;
			this.refreshCards();
			this.resetPageScroll();
		}));

		this.focusedSessionHost = append(contentArea, $('.optimus-focused-session'));
		const focusedHeader = append(this.focusedSessionHost, $('.sessions-panel-header.sessions-part-header.optimus-focused-session-header'));
		append(focusedHeader, $('.titlebar-drag-region'));
		const focusedHeaderLeft = append(focusedHeader, $('.sessions-panel-header-left'));
		const dashboardButton = append(focusedHeaderLeft, $('button.optimus-focused-dashboard-button')) as HTMLButtonElement;
		dashboardButton.type = 'button';
		dashboardButton.title = localize('optimus.focused.backToAgents', "Back to Agents");
		dashboardButton.setAttribute('aria-label', dashboardButton.title);
		append(dashboardButton, $('.codicon.codicon-arrow-left'));
		append(dashboardButton, $('span')).textContent = dashboardButton.title;
		this._register(addDisposableListener(dashboardButton, EventType.CLICK, () => {
			this.commandService.executeCommand(OPTIMUS_SHOW_DASHBOARD_COMMAND_ID);
		}));
		this.focusedHeaderTypePickerSlot = append(focusedHeaderLeft, $('.sessions-header-type-picker-slot'));
		const focusedHeaderCenter = append(focusedHeader, $('.sessions-panel-header-center'));
		this.focusedHeaderTitleSlot = append(focusedHeaderCenter, $('.sessions-header-session-title-slot'));
		const focusedHeaderRight = append(focusedHeader, $('.sessions-panel-header-right'));
		this.focusedHeaderToolbarSlot = append(focusedHeaderRight, $('.sessions-header-session-toolbar-slot.sessions-header-new-session-toolbar-slot'));
		this.focusedSessionBody = append(this.focusedSessionHost, $('.optimus-focused-session-body'));

		// Sessions dragged out of the sidebar list drop here and open as cards.
		// The list tracks the dragged session via LocalSelectionTransfer (an
		// in-process channel), which is the reliable way to read it — the tree's
		// own DnD controller owns the native DataTransfer. DragAndDropObserver
		// also guarantees the drop-target highlight clears on dragend, so a
		// drop that lands outside can't leave the board stuck highlighted.
		this._register(new DragAndDropObserver(contentArea, {
			onDragOver: e => {
				if (!this.sessionTransfer.hasData(DraggedSessionIdentifier.prototype)) {
					return;
				}
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
				contentArea.classList.add('drop-target');
			},
			onDragLeave: () => contentArea.classList.remove('drop-target'),
			onDragEnd: () => contentArea.classList.remove('drop-target'),
			onDrop: e => {
				contentArea.classList.remove('drop-target');
				const data = this.sessionTransfer.getData(DraggedSessionIdentifier.prototype);
				if (!Array.isArray(data) || data.length === 0) {
					return;
				}
				EventHelper.stop(e, true);
				for (const dragged of data) {
					this.openSession(dragged.resource.toString());
				}
				// Dropping adds the card to the board and leaves it there, in
				// whichever status bucket it belongs to — it does NOT navigate
				// into the session. Focusing is the job of a click on the card,
				// so a drag can bring several sessions onto the board without
				// each one yanking the window into the focused view.
				this.refreshCards();
			},
		}));

		this.refreshCards();

		this._register(renderBackboardAuthGate(contentArea, this.commandService, this.contextKeyService, this.authService));
		return contentArea;
	}

	private createDashboardToolbar(parent: HTMLElement): void {
		// One toolbar row: view switcher and filters on the left, the icon
		// controls pushed to the right. Splitting these across two rows cost a
		// whole band of vertical space for six controls that fit on one line.
		const dashboardHeader = append(parent, $('.optimus-dashboard-header'));
		const primaryRow = append(dashboardHeader, $('.optimus-dashboard-primary'));
		const switcher = append(primaryRow, $('.optimus-view-switcher'));
		switcher.setAttribute('role', 'group');
		switcher.setAttribute('aria-label', localize('optimus.dashboard.view', "Session View"));
		const addViewButton = (mode: OptimusViewMode, label: string): void => {
			const button = append(switcher, $('button.optimus-view-switcher-segment')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setViewMode(mode)));
			this.viewSwitcherButtons.set(mode, button);
		};
		addViewButton('board', localize('optimus.dashboard.board', "Board"));
		addViewButton('kanban', localize('optimus.dashboard.kanban', "Kanban"));

		const filterControls = append(primaryRow, $('.optimus-dashboard-filter-controls'));
		this.filterButton = append(filterControls, $('button.optimus-dashboard-button.optimus-dashboard-filter-button')) as HTMLButtonElement;
		this.filterButton.type = 'button';
		this.filterButton.setAttribute('aria-haspopup', 'menu');
		append(this.filterButton, $('.codicon.codicon-add'));
		append(this.filterButton, $('span')).textContent = localize('optimus.dashboard.addFilters', "Add filters");
		this.filterCountElement = append(this.filterButton, $('.optimus-dashboard-filter-count'));
		this._register(addDisposableListener(this.filterButton, EventType.CLICK, () => this.showFilterMenu()));
		this.filterChipsElement = append(filterControls, $('.optimus-dashboard-filter-chips'));
		this.resultsElement = append(filterControls, $('.optimus-dashboard-results'));

		const controls = append(primaryRow, $('.optimus-dashboard-controls'));

		this.displayButton = append(controls, $('button.optimus-dashboard-button.optimus-dashboard-icon-button')) as HTMLButtonElement;
		this.displayButton.type = 'button';
		this.displayButton.setAttribute('aria-haspopup', 'menu');
		const displayLabel = localize('optimus.dashboard.display', "Display");
		this.displayButton.title = displayLabel;
		this.displayButton.setAttribute('aria-label', displayLabel);
		append(this.displayButton, $('.codicon.codicon-settings'));
		append(this.displayButton, $('.codicon.codicon-chevron-down'));
		this._register(addDisposableListener(this.displayButton, EventType.CLICK, () => this.showDisplayMenu()));

		const resetButton = this.resetButton = append(controls, $('button.optimus-dashboard-reset.optimus-dashboard-icon-button')) as HTMLButtonElement;
		resetButton.type = 'button';
		const resetLabel = localize('optimus.dashboard.resetFilters', "Reset filters");
		resetButton.title = resetLabel;
		resetButton.setAttribute('aria-label', resetLabel);
		append(resetButton, $('.codicon.codicon-clear-all'));
		this._register(addDisposableListener(resetButton, EventType.CLICK, () => this.resetFilters()));
	}

	private showDisplayMenu(): void {
		const anchor = this.displayButton;
		if (!anchor) {
			return;
		}
		const setSort = (sort: OptimusDashboardSort): void => {
			this.sortMode = sort;
			this.persistDisplayState();
			this.resetPage();
		};
		const sortAction = (id: string, label: string, sort: OptimusDashboardSort): IAction => toAction({
			id,
			label,
			checked: this.sortMode === sort,
			run: () => setSort(sort),
		});
		const groupAction = (id: string, label: string, group: OptimusDashboardGroup): IAction => toAction({
			id,
			label,
			checked: this.groupMode === group,
			run: () => {
				this.groupMode = group;
				this.persistDisplayState();
				this.resetPage();
			},
		});

		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({
					id: 'optimus.dashboard.unreadFirst',
					label: localize('optimus.dashboard.unreadFirst', "Unread First"),
					checked: this.unreadFirst,
					run: () => {
						this.unreadFirst = !this.unreadFirst;
						this.persistDisplayState();
						this.resetPage();
					},
				}),
				new Separator(),
				new SubmenuAction('optimus.dashboard.sort', localize('optimus.dashboard.sort', "Sort"), [
					sortAction('optimus.dashboard.sort.updatedDesc', localize('optimus.dashboard.sort.updatedDesc', "Last Updated"), 'updated-desc'),
					sortAction('optimus.dashboard.sort.updatedAsc', localize('optimus.dashboard.sort.updatedAsc', "First Updated"), 'updated-asc'),
					sortAction('optimus.dashboard.sort.createdDesc', localize('optimus.dashboard.sort.createdDesc', "Last Created"), 'created-desc'),
					sortAction('optimus.dashboard.sort.createdAsc', localize('optimus.dashboard.sort.createdAsc', "First Created"), 'created-asc'),
					sortAction('optimus.dashboard.sort.titleAsc', localize('optimus.dashboard.sort.titleAsc', "Title A–Z"), 'title-asc'),
					sortAction('optimus.dashboard.sort.titleDesc', localize('optimus.dashboard.sort.titleDesc', "Title Z–A"), 'title-desc'),
				]),
				new SubmenuAction('optimus.dashboard.group', localize('optimus.dashboard.group', "Group"), [
					groupAction('optimus.dashboard.group.none', localize('optimus.dashboard.group.none', "None"), 'none'),
					groupAction('optimus.dashboard.group.repository', localize('optimus.dashboard.group.repository', "Repository"), 'workspace'),
				]),
			],
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
	}

	private showFilterMenu(): void {
		const anchor = this.filterButton;
		if (!anchor) {
			return;
		}
		const toggleBucket = (bucket: OptimusDashboardBucket): void => {
			if (this.filteredBuckets.has(bucket)) {
				this.filteredBuckets.delete(bucket);
			} else {
				this.filteredBuckets.add(bucket);
			}
			this.resetPage();
		};
		const timeAction = (id: string, label: string, range: OptimusDashboardTimeRange): IAction => toAction({
			id,
			label,
			checked: this.timeRange === range,
			run: () => {
				this.timeRange = range;
				this.resetPage();
			},
		});
		const archiveAction = (id: string, label: string, filter: OptimusDashboardArchiveFilter): IAction => toAction({
			id,
			label,
			checked: this.archiveFilter === filter,
			run: () => {
				this.archiveFilter = filter;
				this.resetPage();
			},
		});
		const providers = [...new Set(this.lastModels.map(model => model.session.providerId))].sort((a, b) => a.localeCompare(b));
		const workspaces = [...new Set(this.lastModels.map(model => model.session.workspace.get()?.label ?? ''))].sort((a, b) => a.localeCompare(b));
		const toggleValue = (values: Set<string>, value: string): void => {
			if (values.has(value)) {
				values.delete(value);
			} else {
				values.add(value);
			}
			this.resetPage();
		};
		const providerActions = providers.map(provider => toAction({
			id: `optimus.dashboard.provider.${provider}`,
			label: provider,
			checked: this.filteredProviders.has(provider),
			run: () => toggleValue(this.filteredProviders, provider),
		}));
		const workspaceActions = workspaces.map(workspace => toAction({
			id: `optimus.dashboard.workspace.${workspace}`,
			label: workspace || localize('optimus.dashboard.noRepository', "No Repository"),
			checked: this.filteredWorkspaces.has(workspace),
			run: () => toggleValue(this.filteredWorkspaces, workspace),
		}));

		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new SubmenuAction('optimus.dashboard.filter.status', localize('optimus.dashboard.filter.status', "Status"), BOARD_BUCKETS.map(bucket => toAction({
					id: `optimus.dashboard.status.${bucket.key}`,
					label: bucket.label,
					checked: this.filteredBuckets.has(bucket.key),
					run: () => toggleBucket(bucket.key),
				}))),
				new SubmenuAction('optimus.dashboard.filter.time', localize('optimus.dashboard.filter.time', "Time"), [
					timeAction('optimus.dashboard.time.all', localize('optimus.dashboard.time.all', "Any Time"), 'all'),
					timeAction('optimus.dashboard.time.hour', localize('optimus.dashboard.time.hour', "Past Hour"), 'hour'),
					timeAction('optimus.dashboard.time.day', localize('optimus.dashboard.time.day', "Past 24 Hours"), 'day'),
					timeAction('optimus.dashboard.time.week', localize('optimus.dashboard.time.week', "Past 7 Days"), 'week'),
					timeAction('optimus.dashboard.time.month', localize('optimus.dashboard.time.month', "Past 30 Days"), 'month'),
				]),
				new SubmenuAction('optimus.dashboard.filter.archived', localize('optimus.dashboard.filter.archived', "Archived"), [
					archiveAction('optimus.dashboard.archive.exclude', localize('optimus.dashboard.archive.exclude', "Exclude Archived"), 'exclude'),
					archiveAction('optimus.dashboard.archive.include', localize('optimus.dashboard.archive.include', "Include Archived"), 'include'),
					archiveAction('optimus.dashboard.archive.only', localize('optimus.dashboard.archive.only', "Only Archived"), 'only'),
				]),
				new SubmenuAction('optimus.dashboard.filter.agent', localize('optimus.dashboard.filter.agent', "Agent"), providerActions.length > 0 ? providerActions : [toAction({
					id: 'optimus.dashboard.provider.empty',
					label: localize('optimus.dashboard.provider.empty', "No Agents"),
					enabled: false,
					run: () => undefined,
				})]),
				new SubmenuAction('optimus.dashboard.filter.repository', localize('optimus.dashboard.filter.repository', "Repository"), workspaceActions.length > 0 ? workspaceActions : [toAction({
					id: 'optimus.dashboard.workspace.empty',
					label: localize('optimus.dashboard.workspace.empty', "No Repositories"),
					enabled: false,
					run: () => undefined,
				})]),
				new Separator(),
				toAction({
					id: 'optimus.dashboard.filters.reset',
					label: localize('optimus.dashboard.filters.reset', "Reset Filters"),
					run: () => this.resetFilters(),
				}),
			],
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
	}

	private resetFilters(): void {
		this.filteredBuckets.clear();
		this.timeRange = 'all';
		this.archiveFilter = 'exclude';
		this.filteredProviders.clear();
		this.filteredWorkspaces.clear();
		this.resetPage();
	}

	private getDashboardFilters(): IOptimusDashboardFilters {
		return {
			query: '',
			buckets: [...this.filteredBuckets],
			timeRange: this.timeRange,
			archive: this.archiveFilter,
			providers: [...this.filteredProviders],
			workspaces: [...this.filteredWorkspaces],
		};
	}

	private toSessionSummary(model: IOptimusCardSessionModel): IOptimusSessionSummary {
		const session = model.session;
		return {
			key: session.resource.toString(),
			title: session.title.get(),
			providerId: session.providerId,
			workspaceLabel: session.workspace.get()?.label ?? '',
			status: session.status.get(),
			createdAt: session.createdAt.getTime(),
			updatedAt: session.updatedAt.get().getTime(),
			isArchived: session.isArchived.get(),
			isRead: session.isRead.get(),
		};
	}

	private filterAndSortModels(models: readonly IOptimusCardSessionModel[]): IOptimusCardSessionModel[] {
		const modelByKey = new Map(models.map(model => [model.session.resource.toString(), model]));
		const sorted = filterAndSortOptimusSessions(models.map(model => this.toSessionSummary(model)), this.getDashboardFilters(), this.sortMode, this.unreadFirst)
			.map(summary => assertReturnsDefined(modelByKey.get(summary.key)));
		return this.groupMode === 'workspace'
			? sorted.sort((a, b) => (a.session.workspace.get()?.label ?? '').localeCompare(b.session.workspace.get()?.label ?? ''))
			: sorted;
	}

	private getFilterCount(): number {
		return this.filteredBuckets.size
			+ (this.timeRange === 'all' ? 0 : 1)
			+ (this.archiveFilter === 'exclude' ? 0 : 1)
			+ this.filteredProviders.size
			+ this.filteredWorkspaces.size;
	}

	private updateDashboardControls(total: number, filtered: number): void {
		const state = JSON.stringify([this.viewMode, total, filtered, this.getDashboardFilters()]);
		if (state === this.controlsState) {
			return;
		}
		this.controlsState = state;
		for (const [mode, button] of this.viewSwitcherButtons) {
			button.classList.toggle('active', this.viewMode === mode);
			button.setAttribute('aria-pressed', String(this.viewMode === mode));
		}
		const filterCount = this.getFilterCount();
		if (this.resetButton) {
			this.resetButton.hidden = filterCount === 0;
		}
		if (this.filterCountElement) {
			this.filterCountElement.textContent = filterCount > 0 ? String(filterCount) : '';
			this.filterCountElement.classList.toggle('empty', filterCount === 0);
		}
		if (this.resultsElement) {
			this.resultsElement.textContent = total === filtered
				? localize('optimus.dashboard.results.total', "{0} agents", total)
				: localize('optimus.dashboard.results.filtered', "{0} of {1} agents", filtered, total);
		}
		this.renderFilterChips();
	}

	private renderFilterChips(): void {
		const container = this.filterChipsElement;
		if (!container) {
			return;
		}
		this.filterChipStore.clear();
		container.textContent = '';
		const appendChip = (label: string, remove: () => void): void => {
			const chip = append(container, $('button.optimus-dashboard-filter-chip')) as HTMLButtonElement;
			chip.type = 'button';
			append(chip, $('span')).textContent = label;
			append(chip, $('.codicon.codicon-close'));
			chip.setAttribute('aria-label', localize('optimus.dashboard.removeFilter', "Remove Filter: {0}", label));
			this.filterChipStore.add(addDisposableListener(chip, EventType.CLICK, () => {
				remove();
				this.resetPage();
			}));
		};
		for (const bucket of BOARD_BUCKETS) {
			if (this.filteredBuckets.has(bucket.key)) {
				appendChip(bucket.label, () => this.filteredBuckets.delete(bucket.key));
			}
		}
		const timeLabels: Record<Exclude<OptimusDashboardTimeRange, 'all'>, string> = {
			hour: localize('optimus.dashboard.chip.hour', "Past Hour"),
			day: localize('optimus.dashboard.chip.day', "Past 24 Hours"),
			week: localize('optimus.dashboard.chip.week', "Past 7 Days"),
			month: localize('optimus.dashboard.chip.month', "Past 30 Days"),
		};
		if (this.timeRange !== 'all') {
			appendChip(timeLabels[this.timeRange], () => this.timeRange = 'all');
		}
		if (this.archiveFilter !== 'exclude') {
			appendChip(this.archiveFilter === 'include'
				? localize('optimus.dashboard.chip.includeArchived', "Include Archived")
				: localize('optimus.dashboard.chip.onlyArchived', "Only Archived"), () => this.archiveFilter = 'exclude');
		}
		for (const provider of this.filteredProviders) {
			appendChip(provider, () => this.filteredProviders.delete(provider));
		}
		for (const workspace of this.filteredWorkspaces) {
			appendChip(workspace || localize('optimus.dashboard.noRepository', "No Repository"), () => this.filteredWorkspaces.delete(workspace));
		}
		container.classList.toggle('empty', container.childElementCount === 0);
	}

	/** Reconcile dashboard sessions against the sessions service. */
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		const activeChanged = !!active && active.sessionId !== this.activeSession?.sessionId;
		this.visibleSessions = visible;
		this.activeSession = active;

		// The session the user is actively chatting with belongs on the board,
		// whatever path opened it — a brand-new chat (composer-first drafts
		// never pass through the visible-sessions filter until committed) must
		// not require a manual drag to get its card.
		if (active) {
			this.openSession(active.resource.toString());
		}
		if (this.focusedMode) {
			this.showFocusedSession(active);
		}

		this.refreshCards();

		if (activeChanged && !this.focusedMode) {
			for (const entry of this.cardEntries.values()) {
				if (entry.card.session?.session.sessionId === active.sessionId) {
					entry.card.element.scrollIntoView({ block: 'nearest' });
					break;
				}
			}
		}
	}

	focusSession(session: IActiveSession | undefined): void {
		if (this.focusedMode) {
			this.focusedSessionView.value?.focus();
			return;
		}
		if (!session) {
			this.placeholderCard?.focus();
			return;
		}
		for (const entry of this.cardEntries.values()) {
			if (entry.card.session?.session.sessionId === session.sessionId) {
				entry.card.focus();
				return;
			}
		}
	}

	private createCardEntry(key: string): ICardEntry {
		const initialContainer = assertReturnsDefined(this.gridContainer ?? this.boardContainer);
		const store = new DisposableStore();
		const card = store.add(this.instantiationService.createInstance(OptimusCard, initialContainer));
		store.add(card.onDidAction(action => {
			switch (action.kind) {
				case 'create-session':
					this.commandService.executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
					break;
				case 'close-session':
					// Close at the service level first (via command — the
					// sessions service cannot be constructor-injected here,
					// it depends on this part): a session that is open there
					// (e.g. the active one in the right panel) stays in the
					// visible set otherwise, and the visible-means-open rule
					// would instantly un-close it, making the active card
					// impossible to close. The session itself lives on in
					// the sidebar list.
					this.commandService.executeCommand(OPTIMUS_CLOSE_SESSION_COMMAND_ID, action.card.session.resource);
					this.closeSession(action.card.session.resource.toString());
					break;
				case 'focus-session':
					if (action.card.isVisible && action.card.activeSession) {
						this._onDidFocusSession.fire(action.card.activeSession.sessionId);
					}
					// Always route through the focus command: even an already-active
					// card must transition from the dashboard to the focused workspace.
					this.commandService.executeCommand(OPTIMUS_FOCUS_SESSION_COMMAND_ID, action.card.session.resource);
					break;
			}
		}));
		const entry: ICardEntry = { card, store };
		this.cardEntries.set(key, entry);
		return entry;
	}

	private disposeCardEntry(key: string, entry: ICardEntry): void {
		this.cardEntries.delete(key);
		entry.card.element.remove();
		entry.store.dispose();
	}

	/**
	 * Keep transcript widgets scoped to the current page. Session metadata stays
	 * cheap and fully filterable, while navigating between pages releases chat
	 * models, observers, and render trees from the page that just left view.
	 */
	private disposeCardsOutsidePage(visibleKeys: ReadonlySet<string>): void {
		for (const [key, entry] of [...this.cardEntries]) {
			if (!visibleKeys.has(key)) {
				this.disposeCardEntry(key, entry);
			}
		}
	}

	private disposeDashboardCards(): void {
		this.disposeCardsOutsidePage(new Set());
	}

	/** Coalesce metadata changes without letting a busy stream postpone refresh forever. */
	private scheduleRefresh(): void {
		if (!this.focusedMode && !this.refreshScheduler.isScheduled()) {
			this.refreshScheduler.schedule();
		}
	}

	private resetPage(): void {
		this.pageIndex = 0;
		this.refreshCards();
		this.resetPageScroll();
	}

	private resetPageScroll(): void {
		if (this.gridContainer) {
			this.gridContainer.scrollTop = 0;
		}
		for (const column of this.boardColumns.values()) {
			column.listEl.scrollTop = 0;
		}
	}

	private clearSessionWatches(): void {
		for (const watch of this.sessionWatches.values()) {
			watch.store.dispose();
		}
		this.sessionWatches.clear();
	}

	/** Keep only lightweight, keyed metadata subscriptions for off-page sessions. */
	private reconcileSessionWatches(models: readonly IOptimusCardSessionModel[]): void {
		const byKey = new Map(models.map(model => [model.session.resource.toString(), model]));
		for (const [key, watch] of this.sessionWatches) {
			if (byKey.get(key)?.session !== watch.session) {
				watch.store.dispose();
				this.sessionWatches.delete(key);
			}
		}
		for (const [key, model] of byKey) {
			if (this.sessionWatches.has(key)) {
				continue;
			}
			const store = new DisposableStore();
			this.sessionWatches.set(key, { session: model.session, store });
			let initialRun = true;
			store.add(autorun(reader => {
				const session = model.session;
				const status = session.status.read(reader);
				session.title.read(reader);
				session.workspace.read(reader);
				session.isArchived.read(reader);
				session.isRead.read(reader);
				session.mainChat.read(reader);
				model.activeSession?.activeChat.read(reader);
				// A live card updates its own timestamp. Re-sorting the wall on every
				// streamed token churns pages; refresh its order when the turn ends.
				if (status !== SessionStatus.InProgress) {
					session.updatedAt.read(reader);
				}
				if (!initialRun) {
					this.scheduleRefresh();
				}
				initialRun = false;
			}));
		}
	}

	private refreshCards(): void {
		if (this.focusedMode || !this.boardContainer || !this.gridContainer) {
			return;
		}

		const allModels = this.buildCardModels();
		this.lastModels = allModels;
		const filteredModels = this.filterAndSortModels(allModels);
		this.contentAreaEl?.classList.toggle('empty', allModels.length === 0);
		this.contentAreaEl?.classList.toggle('no-results', allModels.length > 0 && filteredModels.length === 0);
		this.updateDashboardControls(allModels.length, filteredModels.length);

		const allModelKeys = new Set(allModels.map(model => model.session.resource.toString()));
		for (const [key, entry] of [...this.cardEntries]) {
			if (!allModelKeys.has(key)) {
				this.disposeCardEntry(key, entry);
			}
		}

		this.reconcileSessionWatches(allModels);

		if (this.viewMode === 'kanban') {
			this.refreshKanban(filteredModels);
			return;
		}

		this.refreshGrid(filteredModels);
	}

	private refreshKanban(models: readonly IOptimusCardSessionModel[]): void {
		const buckets = new Map<OptimusDashboardBucket, IOptimusCardSessionModel[]>(BOARD_BUCKETS.map(bucket => [bucket.key, []]));
		for (const model of models) {
			buckets.get(getOptimusDashboardBucket(model.session.status.get()))!.push(model);
		}
		const totalPages = Math.max(1, ...[...buckets.values()].map(bucketModels => Math.ceil(bucketModels.length / OptimusGridPart.KANBAN_ROWS_PER_PAGE)));
		this.pageIndex = Math.min(Math.max(0, this.pageIndex), totalPages - 1);
		const pageStart = this.pageIndex * OptimusGridPart.KANBAN_ROWS_PER_PAGE;
		const pageBuckets = new Map<OptimusDashboardBucket, readonly IOptimusCardSessionModel[]>();
		const visibleKeys = new Set<string>();
		for (const [bucketKey, bucketModels] of buckets) {
			const pageModels = bucketModels.slice(pageStart, pageStart + OptimusGridPart.KANBAN_ROWS_PER_PAGE);
			pageBuckets.set(bucketKey, pageModels);
			for (const model of pageModels) {
				visibleKeys.add(model.session.resource.toString());
			}
		}
		this.disposeCardsOutsidePage(visibleKeys);

		for (const [bucketKey, bucketModels] of buckets) {
			const column = assertReturnsDefined(this.boardColumns.get(bucketKey));
			const pageModels = assertReturnsDefined(pageBuckets.get(bucketKey));
			column.countEl.textContent = String(bucketModels.length);
			column.element.classList.toggle('empty', pageModels.length === 0);

			let previousElement: HTMLElement | undefined;
			for (const model of pageModels) {
				const key = model.session.resource.toString();
				const entry = this.cardEntries.get(key) ?? this.createCardEntry(key);
				entry.card.element.style.display = '';
				entry.card.bind(model, model.session.sessionId === this.activeSession?.sessionId);

				const element = entry.card.element;
				const expectedPrevious = previousElement ?? null;
				if (element.parentElement !== column.listEl || element.previousElementSibling !== expectedPrevious) {
					column.listEl.insertBefore(element, expectedPrevious ? expectedPrevious.nextElementSibling : column.listEl.firstElementChild);
				}
				previousElement = element;
			}
		}
		if (this.placeholderCard) {
			this.placeholderCard.element.style.display = 'none';
		}
		this.updatePager(totalPages, models.length);
	}

	private refreshGrid(allModels: readonly IOptimusCardSessionModel[]): void {
		const gridContainer = assertReturnsDefined(this.gridContainer);
		const totalPages = Math.max(1, Math.ceil(allModels.length / OptimusGridPart.GRID_PAGE_SIZE));
		this.pageIndex = Math.min(Math.max(0, this.pageIndex), totalPages - 1);
		const pageStart = this.pageIndex * OptimusGridPart.GRID_PAGE_SIZE;
		const models = allModels.slice(pageStart, pageStart + OptimusGridPart.GRID_PAGE_SIZE);
		const placeholderOnThisPage = allModels.length > 0 && this.pageIndex === totalPages - 1 && models.length < OptimusGridPart.GRID_PAGE_SIZE;
		const visibleKeys = new Set(models.map(model => model.session.resource.toString()));
		this.disposeCardsOutsidePage(visibleKeys);

		let previousElement: HTMLElement | undefined;
		for (const model of models) {
			const key = model.session.resource.toString();
			const entry = this.cardEntries.get(key) ?? this.createCardEntry(key);
			entry.card.element.style.display = '';
			entry.card.bind(model, model.session.sessionId === this.activeSession?.sessionId);
			const element = entry.card.element;
			const expectedPrevious = previousElement ?? null;
			if (element.parentElement !== gridContainer || element.previousElementSibling !== expectedPrevious) {
				gridContainer.insertBefore(element, expectedPrevious ? expectedPrevious.nextElementSibling : gridContainer.firstElementChild);
			}
			previousElement = element;
		}

		if (this.placeholderCard) {
			this.placeholderCard.element.style.display = placeholderOnThisPage ? '' : 'none';
			if (placeholderOnThisPage) {
				gridContainer.appendChild(this.placeholderCard.element);
			}
		}
		this.updatePager(totalPages, allModels.length);
	}

	private updatePager(totalPages: number, totalAgents: number): void {
		if (!this.pagerElement || !this.pagerLabel || !this.pagerPrevious || !this.pagerNext) {
			return;
		}
		this.pagerElement.style.display = totalAgents > 0 ? 'flex' : 'none';
		this.pagerLabel.textContent = localize('optimus.pager.label', "Page {0} of {1} · {2} agents", this.pageIndex + 1, totalPages, totalAgents);
		this.pagerPrevious.disabled = this.pageIndex === 0;
		this.pagerNext.disabled = this.pageIndex >= totalPages - 1;
	}

	private layoutFocusedSession(): void {
		if (!this.focusedMode || !this.focusedSessionBody || !this.focusedSessionView.value) {
			return;
		}
		this.focusedSessionView.value.layout(this.focusedSessionBody.clientWidth, this.focusedSessionBody.clientHeight, 0, 0);
	}

	getSessionView(sessionId: string | undefined): SessionView | undefined {
		if (!this.focusedMode) {
			return undefined;
		}
		if (sessionId === undefined || this.activeSession?.sessionId === sessionId) {
			return this.focusedSessionView.value;
		}
		return undefined;
	}

	private buildCardModels(): IOptimusCardSessionModel[] {
		// All session types can be cards. Claude/Codex chats mirror through
		// their per-session CLI processes, which is affordable now that only
		// explicitly opened sessions get cards (the board no longer auto-opens
		// every chat).
		const isCommittedSession = (session: ISession): boolean => session.status.get() !== SessionStatus.Untitled;

		// Chats created while this window is open join the board on their own:
		// the right panel's chat does not pass through the visible/active
		// session plumbing here, so a session that newly appears in the service
		// with fresh activity is the reliable "user just started this" signal.
		const sessions = this.sessionsManagementService.getSessions();
		if (!this.knownSessionKeys && sessions.length > 0) {
			this.knownSessionKeys = new Set(sessions.map(session => session.resource.toString()));
		} else if (this.knownSessionKeys) {
			for (const session of sessions) {
				const key = session.resource.toString();
				if (this.knownSessionKeys.has(key)) {
					continue;
				}
				this.knownSessionKeys.add(key);
				if (session.updatedAt.get().getTime() >= this.windowStartTime) {
					this.openSession(key);
				}
			}
		}

		const visibleByKey = new Map<string, IActiveSession>();
		for (const session of this.visibleSessions) {
			if (session && isCommittedSession(session)) {
				// A session open through the service (sidebar click, new chat)
				// is open by definition — record it so it persists as open.
				this.openSession(session.resource.toString());
				visibleByKey.set(session.resource.toString(), session);
			}
		}

		// Keep the model order stable across refreshes (service list order,
		// visibility enriched in place): cards are keyed by session, but a
		// stable order avoids reparenting card DOM, which would disturb the
		// live transcripts.
		const models: IOptimusCardSessionModel[] = [];
		const seen = new Set<string>();
		for (const session of this.sessionsManagementService.getSessions()) {
			if (!isCommittedSession(session)) {
				continue;
			}

			const key = session.resource.toString();
			if (seen.has(key) || !this.openSessions.has(key)) {
				continue;
			}
			seen.add(key);

			const active = visibleByKey.get(key);
			models.push(active
				? { session: active, chatResource: active.activeChat.get().resource, isVisible: true, activeSession: active }
				: { session, chatResource: session.mainChat.get().resource, isVisible: false });
		}

		// Visible sessions the service list doesn't know yet (e.g. a brand-new
		// chat before its first list refresh) still get a card, at the end.
		for (const [key, active] of visibleByKey) {
			if (!seen.has(key)) {
				seen.add(key);
				models.push({ session: active, chatResource: active.activeChat.get().resource, isVisible: true, activeSession: active });
			}
		}

		return models;
	}

	getProgressIndicator(): IProgressIndicator {
		if (!this.progressIndicator) {
			const progressBar = assertReturnsDefined(this.progressBar);
			const scopeId = Parts.SESSIONS_PART;
			const isVisible = this.layoutService.isVisible(scopeId);
			const onDidVisibilityChange = this.onDidVisibilityChange;
			const scope = this._register(new class extends AbstractProgressScope {
				constructor() {
					super(scopeId, isVisible);
					this._register(onDidVisibilityChange(visible => visible ? this.onScopeOpened(scopeId) : this.onScopeClosed(scopeId)));
				}
			}());
			this.progressIndicator = this._register(new ScopedProgressIndicator(progressBar, scope));
		}
		return this.progressIndicator;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);
		this.layoutFocusedSession();
	}

	toJSON(): object {
		return {
			type: Parts.SESSIONS_PART
		};
	}

	override dispose(): void {
		this.clearSessionWatches();
		for (const [key, entry] of [...this.cardEntries]) {
			this.disposeCardEntry(key, entry);
		}
		super.dispose();
	}
}
