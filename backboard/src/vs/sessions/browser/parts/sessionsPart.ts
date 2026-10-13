/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionsPart.css';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../common/theme.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority, Orientation } from '../../../base/browser/ui/splitview/splitview.js';
import { Direction, GridNode, isGridBranchNode, SerializableGrid, Sizing } from '../../../base/browser/ui/grid/grid.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActiveSessionsContext, CanGoBackFromSubagentContext, MultipleSessionsVisibleContext, SessionsFocusContext } from '../../common/contextkeys.js';
import { $, addDisposableGenericMouseDownListener, addDisposableListener, append, EventType, isAncestor, isHTMLElement, trackFocus } from '../../../base/browser/dom.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionSidePanel, SessionView } from './sessionView.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Color } from '../../../base/common/color.js';
import { contrastBorder } from '../../../platform/theme/common/colorRegistry.js';
import { SessionDropTarget, ISessionDropTargetDelegate, ISessionPlacement } from './sessionDropTarget.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { AbstractProgressScope, ScopedProgressIndicator } from '../../../workbench/services/progress/browser/progressIndicator.js';
import { observableValue } from '../../../base/common/observable.js';
import { IWorkbenchAssignmentService } from '../../../workbench/services/assignment/common/assignmentService.js';
import { Menus } from '../menus.js';
import { SessionsPanelHeader } from './panelHeader.js';
import { ISessionsGridChangeEvent, SessionsGridLayout } from '../../services/sessions/browser/sessionsPartService.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';
import { isPhoneLayout } from './mobile/mobileLayout.js';

/**
 * ExP treatment that, when enabled, moves the session type ("harness") picker
 * from its default spot next to the workspace picker down into the bottom input
 * controls (and drops the "with" connector label). Resolved once via the
 * {@link IWorkbenchAssignmentService} and surfaced to new-chat views through
 * the new-chat view options.
 */
const HARNESS_PICKER_IN_CONTROLS_TREATMENT = 'agentSessionsHarnessPickerInControls';

interface ISessionsPartMemento {
	/** Shape of the last split grid; only the structure is kept (cells restore at equal sizes). */
	gridLayout?: SessionsGridLayout;
}

/** How to build a grid shape: the session keeping the anchor cell, then each other cell relative to a placed one. */
interface IGridLayoutPlan {
	readonly first: string;
	readonly steps: readonly { readonly sessionId: string; readonly reference: string; readonly direction: Direction }[];
}

interface IGridSlot {
	readonly view: SessionView;
	readonly disposables: DisposableStore;
	/** Session currently bound to this slot, or `undefined` for the new-session placeholder. */
	boundSessionId: string | undefined;
	/** This cell's own right panel while the grid is split. */
	sidePanel?: { readonly panel: ISessionSidePanel; visible: boolean };
}


/**
 * Appends `child` to `parent` unless it is already there. Re-appending moves the
 * node even in place, and a node moved between a pointer's down and up gets no
 * click: the borrowed window chrome (sidebar toggle, mode switch) is re-placed
 * whenever the active chat changes, which pressing it in a split cell does.
 */
function moveInto(parent: HTMLElement, child: HTMLElement): void {
	if (child.parentElement !== parent) {
		parent.appendChild(child);
	}
}

export class SessionsPart extends Part<ISessionsPartMemento> {

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	get snap(): boolean { return false; }

	/** Agent sessions parts are flush; layout only subtracts borders. */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_LEFT = 0;
	static readonly MARGIN_RIGHT = 0;
	static readonly MARGIN_BOTTOM = 0;

	/** Border width on the card (1px each side) */
	static readonly BORDER_WIDTH = 1;

	/**
	 * Gap between the Simple window's chat card and each window edge it
	 * touches (bottom; right when the right panel is closed; left when the
	 * sidebar is hidden), so the card floats on the window chrome like the
	 * Codex desktop app's main surface. `sessionsShell.css` mirrors it as
	 * margins on the part content.
	 */
	static readonly CARD_INSET = 4;

	/**
	 * Width of the Simple window's icon rail. The rail is docked to the
	 * window's left edge (sessionsView.ts), so with the sidebar hidden the
	 * card starts beside it instead of CARD_INSET from the edge.
	 * `sessionsShell.css` mirrors it as `--sessions-shell-rail`.
	 */
	static readonly RAIL_WIDTH = 52;

	/** Internal grid that hosts the part's session views. */
	protected _gridWidget: SerializableGrid<SessionView> | undefined;

	/** Header strip absorbed from the former integrated chrome bar. */
	private _panelHeader: SessionsPanelHeader | undefined;
	/** Simple window: right edge of the docked mode switch and sidebar toggle (see {@link _createWindowControlsDock}). */
	private _windowControlsRight = 0;
	/** Leading space in the header's left section, as wide as the dock overlaps it. */
	private _windowControlsReserve: HTMLElement | undefined;
	/** Header-row host for the new-chat session-type picker (see {@link IChatViewOptions.headerTypePickerSlot}). */
	private _headerTypePickerSlot: HTMLElement | undefined;
	/** Header-row hosts for the active session's relocated title/workspace and action toolbar. */
	private _headerSessionTitleSlot: HTMLElement | undefined;
	private _headerSessionToolbarSlot: HTMLElement | undefined;
	/** Header-row host for the new-chat action toolbar (see {@link IChatViewOptions.headerToolbarSlot}). */
	private _headerNewSessionToolbarSlot: HTMLElement | undefined;

	/** Lazily-created progress bar shown at the top of the content area. */
	private _progressBar: ProgressBar | undefined;
	private _progressIndicator: IProgressIndicator | undefined;

	/**
	 * Session views mounted in the grid, in visible-list order (their cells may
	 * sit anywhere in the nested grid). A slot follows its session across
	 * reconciliations, see {@link updateVisibleSessions}. There is always at
	 * least one slot — a new-session placeholder (`boundSessionId ===
	 * undefined`) when no sessions are visible.
	 */
	private readonly _slots: IGridSlot[] = [];

	private readonly _onDidFocusSession = this._register(new Emitter<string | undefined>());
	/**
	 * Fired when a session view in the grid receives keyboard focus. Fires with
	 * `undefined` for the new-session placeholder, but only while the grid is
	 * split (a lone placeholder is already the active slot).
	 */
	readonly onDidFocusSession: Event<string | undefined> = this._onDidFocusSession.event;

	private readonly _onDidUpdateGrid = this._register(new Emitter<ISessionsGridChangeEvent>());
	/** Fired at the end of a reconciliation that leaves, enters or changes a split grid. */
	readonly onDidUpdateGrid: Event<ISessionsGridChangeEvent> = this._onDidUpdateGrid.event;

	private _isSplit = false;
	private _pendingPlacement: ISessionPlacement | undefined;
	private _pendingLayout: SessionsGridLayout | undefined;
	/** Shared header sections, remembered so split mode can borrow their contents. */
	private _sharedHeaderLeft: HTMLElement | undefined;
	private _sharedHeaderRight: HTMLElement | undefined;

	protected _lastLayout: { readonly width: number; readonly height: number; readonly top: number; readonly left: number } | undefined;

	private readonly _multipleSessionsVisibleKey: IContextKey<boolean>;
	private readonly _sessionsFocusKey: IContextKey<boolean>;
	private readonly _canGoBackFromSubagentKey: IContextKey<boolean>;
	private _activeSessionId: string | undefined;
	private _lastVisible: readonly (IActiveSession | undefined)[] = [];

	/**
	 * Whether the session type ("harness") picker should be rendered below the
	 * input (in the controls) instead of next to the workspace picker. Backed
	 * by the {@link HARNESS_PICKER_IN_CONTROLS_TREATMENT} A/B experiment, which
	 * is resolved asynchronously and updates this observable once it is known.
	 * Passed down to new-chat views, which snapshot it at creation time.
	 */
	private readonly _renderSessionTypePickerInControls = observableValue<boolean>(this, false);

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	readonly priority = LayoutPriority.Normal;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchAssignmentService private readonly assignmentService: IWorkbenchAssignmentService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super(
			Parts.SESSIONS_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);

		// Bind context keys for compatibility with existing when-clauses
		ActiveSessionsContext.bindTo(contextKeyService);
		this._sessionsFocusKey = SessionsFocusContext.bindTo(contextKeyService);
		this._multipleSessionsVisibleKey = MultipleSessionsVisibleContext.bindTo(contextKeyService);
		this._canGoBackFromSubagentKey = CanGoBackFromSubagentContext.bindTo(contextKeyService);
	}

	/**
	 * Resolve the harness-picker placement treatment now and whenever the
	 * assignment service refetches. New-chat views snapshot the value when they
	 * are created, so views mounted before the treatment resolves keep the
	 * default placement until they are recreated.
	 */
	private _trackOptions(): IDisposable {
		const store = new DisposableStore();

		// Harness picker placement
		const updateHarnessPickerPlacement = async () => {
			const value = await this.assignmentService.getTreatment<boolean>(HARNESS_PICKER_IN_CONTROLS_TREATMENT);
			this._renderSessionTypePickerInControls.set(value === true, undefined);
		};
		store.add(this.assignmentService.onDidRefetchAssignments(() => updateHarnessPickerPlacement()));
		updateHarnessPickerPlacement();

		return store;
	}

	override create(parent: HTMLElement): void {
		this.element = parent;
		parent.classList.add('sessionspart');

		// Resolve treatments here rather than in the constructor: touching the
		// assignment service forces it (and its eagerly-constructed filter
		// providers) to instantiate. Doing that during the part's construction —
		// which runs while the workbench layout is being initialized — has been
		// observed to trigger re-entrancy issues in entitlement-dependent filter
		// providers. `create()` runs later, once layout init has settled.
		this._register(this._trackOptions());

		super.create(parent);

		// The Simple window keeps the mode switch and sidebar toggle in a dock
		// at the window's top-left, so they never move or swap copies while the
		// sidebar opens and closes. The Advanced window mounts its own chrome.
		const dockWindowControls = !this.environmentService.isOptimusWindow;
		if (dockWindowControls) {
			this._createWindowControlsDock();
		}

		// Header strip with the center actions plus fallback controls for the
		// window edges: the right-edge toolbars show here when the auxiliary bar
		// is hidden, and (Advanced window only) the sidebar toggle and
		// traffic-light spacer show here when the sidebar is hidden. Fallback
		// visibility is CSS-driven via the workbench-level
		// `nosidebar`/`noauxiliarybar` classes (`panelHeader.css`).
		this._panelHeader = this._register(this.instantiationService.createInstance(SessionsPanelHeader, parent, {
			classes: ['sessions-part-header'],
			left: [
				...(dockWindowControls ? [] : [
					{ menuId: Menus.TitleBarLeftLayout, telemetrySource: 'sessionsPanelHeader.left', containerClasses: ['panel-header-fallback-left'] },
					{ menuId: Menus.TitleBarCenterLeft, telemetrySource: 'sessionsPanelHeader.centerLeft', containerClasses: ['panel-header-fallback-left'] },
				]),
				{ menuId: Menus.TitleBarSessionNavigation, telemetrySource: 'sessionsPanelHeader.navigation', containerClasses: ['sessions-header-navigation'] },
			],
			center: [
				{ menuId: Menus.TitleBarCenterRight, telemetrySource: 'sessionsPanelHeader.center' },
			],
			right: [
				{ menuId: Menus.TitleBarSessionMenu, telemetrySource: 'sessionsPanelHeader.sessionActions', containerClasses: ['panel-header-fallback-right'], hideOnWelcome: true },
				{ menuId: Menus.TitleBarRightLayout, telemetrySource: 'sessionsPanelHeader.rightLayout', containerClasses: ['panel-header-fallback-right'], hideOnWelcome: true },
				{ menuId: Menus.TitleBarRightPanel, telemetrySource: 'sessionsPanelHeader.rightPanel', containerClasses: ['panel-header-fallback-right'] },
			],
			windowControls: { left: !dockWindowControls, right: true },
		}));

		// Host for the new-chat session-type (agent host) picker, so it renders
		// in the same header row as the layout toggles instead of inside the page.
		this._headerTypePickerSlot = this._panelHeader.createLeftSlot('sessions-header-type-picker-slot');

		// Hosts for the active session's relocated header: the title/workspace sit
		// in the center of the header row and the action toolbar at its right end,
		// so they share the row with the mode dropdown and scale with the session
		// region (e.g. as the right panel opens/closes).
		this._headerSessionTitleSlot = this._panelHeader.createCenterSlot('sessions-header-session-title-slot');
		this._headerSessionToolbarSlot = this._panelHeader.createRightSlot('sessions-header-session-toolbar-slot');

		// Host for the new-chat view's action toolbar, at the same end of the row
		// as the session toolbar above so the controls keep their position once a
		// chat is sent. Only one of the two is ever populated at a time.
		this._headerNewSessionToolbarSlot = this._panelHeader.createRightSlot('sessions-header-new-session-toolbar-slot');
		this._sharedHeaderLeft = this._headerTypePickerSlot.parentElement ?? undefined;
		this._sharedHeaderRight = this._headerNewSessionToolbarSlot.parentElement ?? undefined;

		// Leads the left section (and moves with it into a split grid's top-left
		// cell) to keep the header's own controls clear of the dock.
		if (dockWindowControls) {
			this._windowControlsReserve = $('.sessions-window-controls-reserve');
			this._sharedHeaderLeft?.prepend(this._windowControlsReserve);
		}

		// `createContentArea()` seeds the grid with an empty slot before the
		// sessions service has necessarily emitted its first reconciliation. Bind
		// that slot now so switching into Simple mode paints the composer
		// synchronously instead of leaving a blank canvas while providers load.
		const placeholder = this._slots[0];
		if (placeholder?.boundSessionId === undefined) {
			placeholder.view.openSession(undefined, this._newSessionViewOptions());
			placeholder.view.element.classList.add('is-active');
			placeholder.view.setActive(true);
		}
	}

	/**
	 * Renders the mode switch and sidebar toggle once, in a dock fixed to the
	 * window's top-left over the header row. The sidebar header and this part's
	 * header both pass under it, so opening or closing the sidebar never moves
	 * the controls; this part's header keeps clear of whatever the dock covers
	 * ({@link _updateWindowControlsReserve}).
	 */
	private _createWindowControlsDock(): void {
		const dock = append(this.layoutService.mainContainer, $('.sessions-window-controls-dock'));
		this._register(toDisposable(() => dock.remove()));
		const header = this._register(this.instantiationService.createInstance(SessionsPanelHeader, dock, {
			classes: ['sessions-window-controls'],
			left: [
				{ menuId: Menus.TitleBarLeftLayout, telemetrySource: 'windowControlsDock.left' },
				{ menuId: Menus.TitleBarCenterLeft, telemetrySource: 'windowControlsDock.centerLeft' },
			],
			windowControls: { left: true },
		}));

		// The controls change width with the welcome view, fullscreen and zoom.
		const controls = header.element.querySelector<HTMLElement>('.sessions-panel-header-left');
		if (controls) {
			const observer = new ResizeObserver(() => {
				this._windowControlsRight = controls.getBoundingClientRect().right - this.layoutService.mainContainer.getBoundingClientRect().left;
				this._updateWindowControlsReserve();
			});
			observer.observe(controls);
			this._register(toDisposable(() => observer.disconnect()));
		}
	}

	/**
	 * Sizes the header's reserve to the part of the dock that overlaps it at its
	 * laid-out position: nothing beside an open sidebar, nearly the dock's width
	 * when the header starts at the window edge. While the sidebar animates the
	 * reserve transitions alongside the part (`sessionsShell.css`), so the
	 * header's own controls glide with the card instead of jumping.
	 */
	private _updateWindowControlsReserve(): void {
		const reserve = this._windowControlsReserve;
		if (!reserve || !this._lastLayout) {
			return;
		}
		let width = 0;
		if (this._lastLayout.left < this._windowControlsRight) {
			// Both move together while the part animates, so the difference is
			// the reserve's resting offset within the part.
			const offset = reserve.getBoundingClientRect().left - this.element.getBoundingClientRect().left;
			width = Math.max(0, Math.ceil(this._windowControlsRight - this._lastLayout.left - offset));
		}
		reserve.style.width = `${width}px`;
	}

	private _newSessionViewOptions() {
		return {
			renderSessionTypePickerInControls: this._renderSessionTypePickerInControls,
			headerTypePickerSlot: this._headerTypePickerSlot,
			headerToolbarSlot: this._headerNewSessionToolbarSlot,
		};
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = $('.content');
		parent.appendChild(contentArea);

		// Track keyboard focus within the sessions content so the `sessionsFocus`
		// context key reflects whether a session (its chat view) currently has focus.
		const focusTracker = this._register(trackFocus(contentArea));
		this._register(focusTracker.onDidFocus(() => this._sessionsFocusKey.set(true)));
		this._register(focusTracker.onDidBlur(() => this._sessionsFocusKey.set(false)));

		// Progress bar pinned to the top of the content area (see sessionsPart.css
		// rule `.part.sessionspart > .content > .monaco-progress-container`).
		this._progressBar = this._register(new ProgressBar(contentArea, defaultProgressBarStyles));
		this._progressBar.hide();

		// Seed the grid with a placeholder slot so SerializableGrid always has
		// at least one leaf. Rebound to a session when visible sessions appear.
		const placeholder = this._createSlot();
		this._gridWidget = this._register(new SerializableGrid(placeholder.view, { styles: { separatorBorder: this._gridSeparatorBorder } }));
		this._slots.push(placeholder);
		contentArea.appendChild(this._gridWidget.element);

		// Propagate the grid's maximized-view state to each session view so the
		// per-view toolbars can render the maximize action in its toggled state.
		this._register(this._gridWidget.onDidChangeViewMaximized(() => this._updateMaximizedState()));

		// Drop target for receiving sessions dragged from the sessions list.
		const dropDelegate: ISessionDropTargetDelegate = {
			findTargetView: (child: HTMLElement) => this._findTargetView(child),
			setPendingPlacement: placement => this.setPendingPlacement(placement),
		};
		this._register(this.instantiationService.createInstance(SessionDropTarget, contentArea, dropDelegate));

		return contentArea;
	}

	private _findTargetView(child: HTMLElement): { readonly sessionId: string | undefined; readonly element: HTMLElement } | undefined {
		// The new-session placeholder is a valid target too: dropping a chat onto
		// a blank "New thread" splits it next to the placeholder.
		for (const slot of this._slots) {
			if (isAncestor(child, slot.view.element)) {
				return { sessionId: slot.boundSessionId, element: slot.view.element };
			}
		}
		return undefined;
	}

	/**
	 * Reconcile the grid with the desired set of visible sessions. Each grid
	 * cell ({@link SessionView} slot) follows its session: sessions that stay
	 * visible keep their cell wherever it sits in the (possibly nested) grid,
	 * a session replacing another in place (same position in the visible list)
	 * takes over the freed cell, and new sessions get a new cell next to the
	 * drop target ({@link setPendingPlacement}) or next to their neighbour in
	 * list order. Cells nobody needs anymore are removed.
	 */
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		const gridWidget = this._gridWidget;
		if (!gridWidget) {
			return;
		}

		// Grid mutations below lay each view out several times; let every view
		// lay its chat out once, at the end.
		const suspended = new Set(this._slots.map(slot => slot.view));
		for (const view of suspended) {
			view.suspendLayout();
		}
		try {
			this._doUpdateVisibleSessions(gridWidget, visible, active, view => {
				if (!suspended.has(view)) {
					suspended.add(view);
					view.suspendLayout();
				}
			});
		} finally {
			for (const view of suspended) {
				if (this._slots.some(slot => slot.view === view)) {
					view.resumeLayout();
				}
			}
		}
	}

	private _doUpdateVisibleSessions(gridWidget: SerializableGrid<SessionView>, visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined, onDidCreateView: (view: SessionView) => void): void {
		const previousIds = this._slots.map(slot => slot.boundSessionId);
		// Always keep at least one slot (a placeholder when no sessions are visible).
		const desired: readonly (IActiveSession | undefined)[] = visible.length ? visible : [undefined];
		const desiredIds = desired.map(session => session?.sessionId);
		const placement = this._pendingPlacement;
		this._pendingPlacement = undefined;
		const isPlaced = (id: string | undefined) => !!placement && placement.sessionId === id;

		const assigned: (IGridSlot | undefined)[] = desiredIds.map(id => this._slots.find(slot => slot.boundSessionId === id));
		const freeSlots = this._slots.filter(slot => !desiredIds.includes(slot.boundSessionId));
		// An explicit layout (e.g. the chat grid) or, when a restore lays these
		// sessions out from a single cell, their persisted shape.
		const pendingLayout = this._pendingLayout;
		this._pendingLayout = undefined;
		const layout = placement || desiredIds.length < 2 ? undefined : pendingLayout ?? (this._slots.length === 1 ? this.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).gridLayout : undefined);
		const layoutPlan = layout ? SessionsPart._planLayout(layout, desiredIds) : undefined;
		if (layoutPlan) {
			this._rebuildGrid(gridWidget, layoutPlan, desiredIds, assigned, onDidCreateView);
			freeSlots.length = 0;
		}
		const takeFreeSlot = (predicate: (slot: IGridSlot) => boolean) => {
			const index = freeSlots.findIndex(predicate);
			return index >= 0 ? freeSlots.splice(index, 1)[0] : undefined;
		};
		// A session opened in place of another (same list position) keeps its
		// cell, and with it the cell's size, side panel and navigation history.
		for (let i = 0; i < desiredIds.length; i++) {
			if (!assigned[i] && !isPlaced(desiredIds[i])) {
				assigned[i] = takeFreeSlot(slot => slot.boundSessionId === previousIds[i]);
			}
		}
		for (let i = 0; i < desiredIds.length; i++) {
			if (!assigned[i] && !isPlaced(desiredIds[i])) {
				assigned[i] = takeFreeSlot(() => true);
			}
		}
		// New cells: next to the drop target in the dropped direction, else to
		// the right of the previous session in list order (left of the next).
		for (let i = 0; i < desiredIds.length; i++) {
			if (assigned[i]) {
				continue;
			}
			const slot = this._createSlot();
			onDidCreateView(slot.view);
			const target = placement && isPlaced(desiredIds[i]) ? assigned[desiredIds.indexOf(placement.targetSessionId)] : undefined;
			const previous = assigned.slice(0, i).reverse().find(candidate => !!candidate);
			const next = assigned.slice(i + 1).find(candidate => !!candidate);
			if (target && placement) {
				gridWidget.addView(slot.view, Sizing.Distribute, target.view, placement.direction);
			} else if (previous) {
				gridWidget.addView(slot.view, Sizing.Distribute, previous.view, Direction.Right);
			} else if (next) {
				gridWidget.addView(slot.view, Sizing.Distribute, next.view, Direction.Left);
			} else {
				gridWidget.addView(slot.view, Sizing.Distribute, (freeSlots[0] ?? this._slots[0]).view, Direction.Right);
			}
			assigned[i] = slot;
		}
		// A session already on screen that was dropped next to another one moves
		// its cell there.
		if (placement) {
			const moving = assigned[desiredIds.indexOf(placement.sessionId)];
			const target = assigned[desiredIds.indexOf(placement.targetSessionId)];
			if (moving && target && moving !== target && previousIds.includes(placement.sessionId)) {
				gridWidget.moveView(moving.view, Sizing.Distribute, target.view, placement.direction);
			}
		}
		// Remove unused cells last so the grid never runs out of views.
		for (const slot of freeSlots) {
			gridWidget.removeView(slot.view, Sizing.Distribute);
			this._disposeSlot(slot);
		}
		this._slots.splice(0, this._slots.length, ...assigned.filter((slot): slot is IGridSlot => !!slot));

		this._lastVisible = desired;

		// Rebind each slot to its session (or to the undefined placeholder).
		for (let i = 0; i < this._slots.length; i++) {
			const slot = this._slots[i];
			slot.boundSessionId = desiredIds[i];
			slot.view.openSession(desired[i], this._newSessionViewOptions());
		}

		// Mark the active session's element for styling/focus indication.
		const activeId = active?.sessionId;
		this._activeSessionId = activeId;
		for (const slot of this._slots) {
			const isActive = (slot.boundSessionId !== undefined && slot.boundSessionId === activeId) || this._slots.length === 1;
			slot.view.element.classList.toggle('is-active', isActive);
			slot.view.setActive(isActive);
		}

		// Relocate the header (title/workspace + action toolbar) into the shared
		// window header row for the single visible session, so it sits inline with
		// the mode dropdown and scales with the session region. With more than one
		// session visible the shared row is hidden and every view shows its own
		// header row instead, so the headers split along with the grid.
		const isSplit = this._slots.length > 1;
		const relocateSlot = !isSplit && this._slots[0].boundSessionId !== undefined ? this._slots[0] : undefined;
		for (const slot of this._slots) {
			if (slot === relocateSlot && this._headerSessionTitleSlot && this._headerSessionToolbarSlot) {
				slot.view.mountHeaderIntoPanel(this._headerSessionTitleSlot, this._headerSessionToolbarSlot);
			} else if (isSplit) {
				slot.view.mountHeaderIntoSplitHeader();
			} else {
				slot.view.restoreHeaderToView();
			}
			slot.view.setSplitHeaderVisible(isSplit);
		}
		this._updateSplitHeaderChrome(isSplit);
		if (!relocateSlot) {
			// A New thread view owns the new-chat header slots, not the relocated
			// session header slots. Clear any previous session title/toolbar that
			// survived a view transition so it cannot overlap the draft breadcrumb.
			this._headerSessionTitleSlot?.replaceChildren();
			this._headerSessionToolbarSlot?.replaceChildren();
		}

		// Exit the grid's maximized state when the active session lands in a
		// different slot than the maximized one. Opening a session into the
		// currently-maximized slot preserves the maximized state.
		if (gridWidget.hasMaximizedView()) {
			const maximizedSlot = this._slots.find(s => gridWidget.isViewMaximized(s.view));
			if (maximizedSlot && maximizedSlot.boundSessionId !== activeId) {
				gridWidget.exitMaximizedView();
			}
		}

		this._updateContextKeys(visible);
		this._updateSubagentNavigationContext();

		const wasSplit = this._isSplit;
		this._isSplit = isSplit;
		const collapsingSidePanel = wasSplit && !isSplit ? this._getVisibleSidePanel(this._slots[0]) : undefined;
		this._syncSidePanels();
		if (wasSplit !== isSplit && this._lastLayout) {
			// The shared header row was shown or hidden: give its height back to
			// (or take it from) the grid.
			const { width, height, top, left } = this._lastLayout;
			this.layout(width, height, top, left);
		}
		if (isSplit) {
			this._storeGridLayout();
		}
		if (wasSplit || isSplit) {
			this._onDidUpdateGrid.fire({
				wasSplit,
				isSplit,
				addedSessionIds: desiredIds.filter(id => !previousIds.includes(id)),
				collapsingSidePanel,
			});
		}
		if (!isSplit) {
			// Side panels only exist while split. The listener above had its chance
			// to carry the collapsing cell's panel state over to the auxiliary bar.
			for (const slot of this._slots) {
				this._disposeSidePanel(slot);
			}
		}
	}

	/**
	 * Remembers the split grid's shape so a restore of the same sessions can
	 * rebuild it (see {@link _planLayout}). The empty placeholder and
	 * unsent drafts are left out, as restore never brings them back.
	 */
	private _storeGridLayout(): void {
		const gridWidget = this._gridWidget;
		if (!gridWidget) {
			return;
		}
		const toCell = (node: GridNode<SessionView>, orientation: Orientation): SessionsGridLayout | undefined => {
			if (!isGridBranchNode(node)) {
				const index = this._slots.findIndex(slot => slot.view === node.view);
				return this._lastVisible[index]?.isCreated.get() ? this._slots[index].boundSessionId : undefined;
			}
			const childOrientation = orientation === Orientation.HORIZONTAL ? Orientation.VERTICAL : Orientation.HORIZONTAL;
			const cells = node.children.map(child => toCell(child, childOrientation)).filter((cell): cell is SessionsGridLayout => cell !== undefined);
			return cells.length > 1 ? { split: orientation === Orientation.HORIZONTAL ? 'h' : 'v', cells } : cells[0];
		};
		const layout = toCell(gridWidget.getViews(), gridWidget.orientation);
		if (typeof layout === 'object') {
			this.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).gridLayout = layout;
		}
	}

	/**
	 * Arranges the next reconciliation's grid in `layout` when it shows exactly
	 * the sessions the layout names (see {@link _planLayout}).
	 */
	setPendingLayout(layout: SessionsGridLayout): void {
		this._pendingLayout = layout;
	}

	/**
	 * Rebuilds the grid in the plan's shape. Cells of sessions that stay are
	 * detached and re-added in their new place (keeping their chat, side panel
	 * and history); the anchor cell never leaves, so the grid is never empty.
	 * Cells nobody needs anymore are disposed.
	 */
	private _rebuildGrid(gridWidget: SerializableGrid<SessionView>, plan: IGridLayoutPlan, desiredIds: readonly (string | undefined)[], assigned: (IGridSlot | undefined)[], onDidCreateView: (view: SessionView) => void): void {
		const kept = new Map<string | undefined, IGridSlot>();
		desiredIds.forEach((id, index) => {
			const slot = assigned[index];
			if (slot) {
				kept.set(id, slot);
			}
		});
		const anchor = kept.get(plan.first) ?? this._slots.find(slot => ![...kept.values()].includes(slot)) ?? this._slots[0];
		for (const [id, slot] of kept) {
			if (slot === anchor && id !== plan.first) {
				kept.delete(id); // the anchor was borrowed from another session; it gets a new cell
			}
		}
		for (const slot of this._slots) {
			if (slot !== anchor) {
				gridWidget.removeView(slot.view, Sizing.Distribute);
			}
		}
		assigned.fill(undefined);
		assigned[desiredIds.indexOf(plan.first)] = anchor;
		for (const step of plan.steps) {
			let slot = kept.get(step.sessionId);
			if (!slot || slot === anchor) {
				slot = this._createSlot();
				onDidCreateView(slot.view);
			}
			gridWidget.addView(slot.view, Sizing.Distribute, assigned[desiredIds.indexOf(step.reference)]!.view, step.direction);
			assigned[desiredIds.indexOf(step.sessionId)] = slot;
		}
		for (const slot of this._slots) {
			if (!assigned.includes(slot)) {
				this._disposeSlot(slot); // already detached above
			}
		}
	}

	/**
	 * Returns how to build `layout` for exactly `desiredIds` (the layout is
	 * pruned to them first), or `undefined` when it does not cover them all:
	 * the session that keeps the anchor cell, then each other session's cell
	 * relative to an already placed one. Siblings are placed before descending
	 * into them, so every step either extends its parent split or splits a
	 * lone cell.
	 */
	private static _planLayout(layout: SessionsGridLayout, desiredIds: readonly (string | undefined)[]): IGridLayoutPlan | undefined {
		if (desiredIds.length < 2 || desiredIds.some(id => id === undefined)) {
			return undefined;
		}
		const keep = new Set(desiredIds as readonly string[]);
		const prune = (cell: SessionsGridLayout): SessionsGridLayout | undefined => {
			if (typeof cell === 'string') {
				return keep.has(cell) ? cell : undefined;
			}
			const cells = cell.cells.map(prune).filter((child): child is SessionsGridLayout => child !== undefined);
			return cells.length > 1 ? { split: cell.split, cells } : cells[0];
		};
		const plan = (cell: SessionsGridLayout): { first: string; steps: { sessionId: string; reference: string; direction: Direction }[]; leaves: string[] } => {
			if (typeof cell === 'string') {
				return { first: cell, steps: [], leaves: [cell] };
			}
			const children = cell.cells.map(plan);
			const direction = cell.split === 'h' ? Direction.Right : Direction.Down;
			const steps = children.slice(1).map((child, index) => ({ sessionId: child.first, reference: children[index].first, direction }));
			return { first: children[0].first, steps: [...steps, ...children.flatMap(child => child.steps)], leaves: children.flatMap(child => child.leaves) };
		};
		const pruned = prune(layout);
		const result = pruned ? plan(pruned) : undefined;
		return result && result.leaves.length === keep.size ? result : undefined;
	}

	/**
	 * Where the next reconciliation places `sessionId`: next to the cell
	 * showing `targetSessionId`, in `direction`. Consumed by the next
	 * {@link updateVisibleSessions} call only (the drop target sets it right
	 * before inserting the session and clears it right after).
	 */
	setPendingPlacement(placement: ISessionPlacement | undefined): void {
		this._pendingPlacement = placement;
	}

	/**
	 * While split, the window's shared header row is hidden and its contents
	 * borrowed by the cell headers: the window chrome (traffic-light spacer,
	 * sidebar fallback) moves into the top-left cell, and the new-chat
	 * breadcrumb/toolbar into the placeholder cell. Everything moves back when
	 * the grid collapses to a single session.
	 */
	private _updateSplitHeaderChrome(isSplit: boolean): void {
		const sharedHeader = this._panelHeader?.element;
		const sharedLeft = this._sharedHeaderLeft;
		const sharedRight = this._sharedHeaderRight;
		const typePickerSlot = this._headerTypePickerSlot;
		const newSessionToolbarSlot = this._headerNewSessionToolbarSlot;
		const gridWidget = this._gridWidget;
		if (!sharedHeader || !sharedLeft || !sharedRight || !typePickerSlot || !newSessionToolbarSlot || !gridWidget) {
			return;
		}

		// The cell showing the new-chat view: the empty slot, or a draft that
		// has not been sent yet (both render into the shared new-chat slots).
		const placeholderIndex = isSplit ? this._lastVisible.findIndex(session => !session || !session.isCreated.get()) : -1;
		const placeholder = placeholderIndex >= 0 ? this._slots[placeholderIndex] : undefined;
		if (placeholder) {
			const slots = placeholder.view.splitHeaderSlots;
			moveInto(slots.leading, typePickerSlot);
			moveInto(slots.trailing, newSessionToolbarSlot);
		} else {
			// Both were created last in their sections, so appending restores order.
			moveInto(sharedLeft, typePickerSlot);
			moveInto(sharedRight, newSessionToolbarSlot);
		}

		// Only cells along the window's top edge replace the title bar: they
		// move the window, and the top-left one hosts the window chrome.
		for (const slot of this._slots) {
			slot.view.element.classList.toggle('is-grid-top', !isSplit || gridWidget.getNeighborViews(slot.view, Direction.Up).length === 0);
		}
		if (isSplit) {
			const topLeft = this._slots.find(slot => gridWidget.getNeighborViews(slot.view, Direction.Up).length === 0 && gridWidget.getNeighborViews(slot.view, Direction.Left).length === 0) ?? this._slots[0];
			moveInto(topLeft.view.splitHeaderSlots.chrome, sharedLeft);
			sharedHeader.style.display = 'none';
		} else {
			if (sharedLeft.parentElement !== sharedHeader) {
				sharedHeader.insertBefore(sharedLeft, sharedHeader.querySelector(':scope > .sessions-panel-header-center'));
			}
			sharedHeader.style.display = '';
		}
		this.element.classList.toggle('sessions-grid-split', isSplit);
		// Split panes render the composer tip on one line (sessionView.css).
		this.element.classList.toggle('chat-input-single-line-placeholder', isSplit);
		this._updateWindowControlsReserve();
	}

	/** Attaches every cell's visible side panel to it (split grid only). */
	private _syncSidePanels(): void {
		this._slots.forEach((slot, index) => {
			slot.sidePanel?.panel.setSession(this._lastVisible[index]);
			slot.view.setSidePanel(this._isSplit ? this._getVisibleSidePanel(slot) : undefined);
		});
	}

	private _getVisibleSidePanel(slot: IGridSlot | undefined): ISessionSidePanel | undefined {
		return slot?.sidePanel?.visible ? slot.sidePanel.panel : undefined;
	}

	private _disposeSidePanel(slot: IGridSlot): void {
		if (slot.sidePanel) {
			if (slot.view.sidePanel === slot.sidePanel.panel) {
				slot.view.setSidePanel(undefined);
			}
			slot.sidePanel.panel.dispose();
			slot.sidePanel = undefined;
		}
	}

	private _disposeSlot(slot: IGridSlot): void {
		this._disposeSidePanel(slot);
		slot.disposables.dispose();
	}

	/** Whether more than one session is visible side by side. */
	get isSplit(): boolean {
		return this._isSplit;
	}

	getSidePanel(sessionId: string | undefined): ISessionSidePanel | undefined {
		return this._slots.find(slot => slot.boundSessionId === sessionId)?.sidePanel?.panel;
	}

	/**
	 * Makes `panel` the side panel of the cell showing `sessionId` and shows
	 * it. The part owns the panel from now on and disposes it when its cell
	 * goes away or the grid collapses. No-op (the panel is disposed) when the
	 * grid is not split or no cell shows the session.
	 */
	setSidePanel(sessionId: string | undefined, panel: ISessionSidePanel): void {
		const slot = this._isSplit ? this._slots.find(candidate => candidate.boundSessionId === sessionId) : undefined;
		if (!slot) {
			panel.dispose();
			return;
		}
		if (slot.sidePanel?.panel !== panel) {
			this._disposeSidePanel(slot);
		}
		slot.sidePanel = { panel, visible: true };
		this._syncSidePanels();
	}

	setSidePanelVisible(panel: ISessionSidePanel, visible: boolean): void {
		const entry = this._slots.find(slot => slot.sidePanel?.panel === panel)?.sidePanel;
		if (!entry || entry.visible === visible) {
			return;
		}
		entry.visible = visible;
		this._syncSidePanels();
	}

	isSidePanelVisible(panel: ISessionSidePanel): boolean {
		return this._slots.some(slot => slot.sidePanel?.panel === panel && slot.sidePanel.visible);
	}

	private _updateContextKeys(visible: readonly (IActiveSession | undefined)[]): void {
		this._multipleSessionsVisibleKey.set(visible.length > 1);
	}

	private _updateSubagentNavigationContext(): void {
		const activeView = this._slots.find(slot => slot.boundSessionId === this._activeSessionId)?.view;
		this._canGoBackFromSubagentKey.set(activeView?.canNavigateBack === true);
	}

	/**
	 * Pushes the grid's current maximized state into each {@link SessionView} so
	 * its scoped `sessionIsMaximized` context key (used by toolbar actions) is
	 * accurate. Called whenever the grid emits a maximize change.
	 */
	private _updateMaximizedState(): void {
		if (!this._gridWidget) {
			return;
		}
		for (const slot of this._slots) {
			slot.view.setMaximized(this._gridWidget.isViewMaximized(slot.view));
		}
	}

	/**
	 * Toggles the maximized state of the session view hosting the given session.
	 * If the view is already maximized, exits maximized state. Otherwise maximizes
	 * it (no-op if fewer than two non-placeholder views are present).
	 *
	 * Returns the view's maximized state after the toggle, or `undefined` when
	 * the call was a no-op.
	 */
	toggleMaximizeSession(sessionId: string | undefined): boolean | undefined {
		if (!this._gridWidget) {
			return undefined;
		}
		const slot = this._slots.find(s => s.boundSessionId === sessionId);
		if (!slot) {
			return undefined;
		}
		if (this._gridWidget.isViewMaximized(slot.view)) {
			this._gridWidget.exitMaximizedView();
			return false;
		} else if (this._slots.filter(s => s.boundSessionId !== undefined).length >= 2) {
			this._gridWidget.maximizeView(slot.view);
			slot.view.focus();
			return true;
		}
		return undefined;
	}

	/**
	 * Returns the {@link SessionView} currently hosting the given session id, or
	 * the placeholder (new-session) view when `sessionId` is `undefined`. Returns
	 * `undefined` if no matching slot exists in the grid.
	 */
	getSessionView(sessionId: string | undefined): SessionView | undefined {
		return this._slots.find(s => s.boundSessionId === sessionId)?.view;
	}

	/**
	 * Moves keyboard focus into the session view hosting the given session id (or
	 * the placeholder view when `sessionId` is `undefined`), first revealing it in
	 * the grid when it is only partially visible. No-op if no matching slot exists.
	 */
	focusSession(sessionId: string | undefined): void {
		const slot = this._slots.find(s => s.boundSessionId === sessionId);
		if (!slot) {
			return;
		}
		this._revealView(slot.view);
		slot.view.focus();
	}

	/**
	 * Ensures the given view is fully visible within the grid. The grid clips its
	 * leaves (`overflow: hidden`) and lays them out side by side; when there are
	 * more sessions than fit, the grid's split view overflows horizontally and
	 * becomes scrollable, leaving views near the edges partially hidden. When the
	 * target view is not fully visible, scroll it into view.
	 */
	private _revealView(view: SessionView): void {
		if (!this._gridWidget) {
			return;
		}
		const containerRect = this._gridWidget.element.getBoundingClientRect();
		const viewRect = view.element.getBoundingClientRect();
		const isFullyVisible = viewRect.left >= containerRect.left - 1 && viewRect.right <= containerRect.right + 1;
		if (!isFullyVisible) {
			view.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	/**
	 * Returns the progress indicator for the part. Drives the progress bar shown
	 * at the top of the content area. Indicator state is scoped to the part's
	 * visibility, mirroring how view panes manage their own progress indicators.
	 */
	getProgressIndicator(): IProgressIndicator {
		if (!this._progressIndicator) {
			const progressBar = assertReturnsDefined(this._progressBar);
			const scopeId = Parts.SESSIONS_PART;
			const isVisible = this.layoutService.isVisible(scopeId);
			const onDidVisibilityChange = this.onDidVisibilityChange;
			const scope = this._register(new class extends AbstractProgressScope {
				constructor() {
					super(scopeId, isVisible);
					this._register(onDidVisibilityChange(visible => visible ? this.onScopeOpened(scopeId) : this.onScopeClosed(scopeId)));
				}
			}());
			this._progressIndicator = this._register(new ScopedProgressIndicator(progressBar, scope));
		}
		return this._progressIndicator;
	}

	private _createSlot(): IGridSlot {
		const disposables = new DisposableStore();
		const view = disposables.add(this.instantiationService.createInstance(SessionView));
		const slot: IGridSlot = { view, disposables, boundSessionId: undefined };
		disposables.add(view.onDidChangeCanNavigateBack(() => this._updateSubagentNavigationContext()));
		// Promote a visible session to the active session when its view receives
		// focus or is clicked. Pointer-down covers clicks on non-focusable chrome
		// (e.g. the new chat widget's workspace picker area) where focus would
		// not otherwise move into the view. A lone placeholder slot (no bound
		// session) is already active; in a split grid it is promoted too, so its
		// own header actions (e.g. the right panel toggle) target it.
		const fireFocus = (event: UIEvent) => {
			// The window chrome the top-left cell borrows (sidebar toggle, mode switch) acts on the
			// window, not this cell's chat: using it must not switch chats (that also closes Canvas).
			if (isHTMLElement(event.target) && event.target.closest('.session-view-split-header-chrome')) {
				return;
			}
			if (slot.boundSessionId !== undefined || this._isSplit) {
				this._onDidFocusSession.fire(slot.boundSessionId);
			}
		};
		disposables.add(addDisposableListener(view.element, EventType.FOCUS_IN, fireFocus, true));
		disposables.add(addDisposableGenericMouseDownListener(view.element, fireFocus, true));
		return slot;
	}

	private get _gridSeparatorBorder(): Color {
		return this.theme.getColor(agentsPanelBorder) || this.theme.getColor(contrastBorder) || Color.transparent;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';

		this._gridWidget?.style({ separatorBorder: this._gridSeparatorBorder });
	}

	override layout(width: number, height: number, top: number, left: number): void {
		// The grid is the source of truth for whether this view needs layout. On
		// an in-place Editor -> Simple reload it can allocate the sessions part
		// before the layout service's visibility state catches up. Skipping that
		// allocation leaves the new-chat widget at its 104px construction fallback
		// until the next window resize, which may never come.
		this._lastLayout = { width, height, top, left };

		// Compute content dimensions accounting for the border and the header.
		// The Simple card draws no border, so it gives that space to the content.
		const cardInset = this.environmentService.isOptimusWindow || isPhoneLayout(this.layoutService) ? 0 : SessionsPart.CARD_INSET;
		const borderTotal = cardInset ? 0 : SessionsPart.BORDER_WIDTH * 2;
		const marginLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? 0 : SessionsPart.MARGIN_LEFT;
		const marginBottom = this.layoutService.isVisible(Parts.PANEL_PART) ? SessionsPart.MARGIN_BOTTOM : 0;
		const marginRight = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? SessionsPart.MARGIN_RIGHT : 0;
		const headerHeight = this._panelHeader?.height ?? 0;
		// An open right panel continues the card to the window edge, and an
		// open terminal panel continues it below the chat.
		const cardInsetLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? 0 : cardInset && SessionsPart.RAIL_WIDTH;
		const cardInsetRight = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? 0 : cardInset;
		const cardInsetBottom = this.layoutService.isVisible(Parts.PANEL_PART) ? 0 : cardInset;

		// Size the content area with the reduced dimensions.
		const { contentSize } = this.layoutContents(
			width - marginLeft - marginRight - borderTotal - cardInsetLeft - cardInsetRight,
			height - headerHeight - SessionsPart.MARGIN_TOP - marginBottom - borderTotal - cardInsetBottom
		);

		// The wallpaper underlay spans the window; publish the card's origin so
		// CSS can clip it to the card.
		if (cardInset) {
			const container = this.layoutService.mainContainer;
			// While split the shared header is hidden (height 0), but the top
			// cells' own headers take its place in the chrome row, so the card
			// still starts one header height down.
			const cardTop = this.element.classList.contains('sessions-grid-split') ? SessionsPanelHeader.HEIGHT : headerHeight;
			container.style.setProperty('--sessions-card-top', `${top + cardTop}px`);
			container.style.setProperty('--sessions-card-left', `${left + cardInsetLeft}px`);
		}

		// Layout the internal grid widget within the content area.
		this._gridWidget?.layout(contentSize.width, contentSize.height, top, left);

		// Store the full grid-allocated dimensions so that Part.relayout() works correctly.
		super.layout(width, height, top, left);

		this._updateWindowControlsReserve();
	}

	override dispose(): void {
		for (const slot of this._slots) {
			this._disposeSlot(slot);
		}
		this._slots.length = 0;
		super.dispose();
	}

	toJSON(): object {
		return {
			type: Parts.SESSIONS_PART
		};
	}
}
