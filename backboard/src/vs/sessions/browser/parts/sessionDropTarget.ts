/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionDropTarget.css';
import { $, addDisposableListener, DragAndDropObserver, EventHelper, EventType, getWindow } from '../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { assertReturnsAllDefined, assertReturnsDefined } from '../../../base/common/types.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { LocalSelectionTransfer } from '../../../platform/dnd/browser/dnd.js';
import { activeContrastBorder } from '../../../platform/theme/common/colorRegistry.js';
import { IThemeService, Themable } from '../../../platform/theme/common/themeService.js';
import { DraggedSessionIdentifier } from '../dnd.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { localize } from '../../../nls.js';

/** Edge of a target view where a dragged session can be dropped. */
type DropSide = 'left' | 'right' | 'up' | 'down';

/** Where a dropped session goes: next to the view of another session. */
export interface ISessionPlacement {
	readonly sessionId: string;
	/** `undefined` for the new-session placeholder view. */
	readonly targetSessionId: string | undefined;
	readonly direction: Direction;
}

/**
 * Resolves an HTML element under the part's content area to the session view
 * it belongs to (if any). Returns the session id (`undefined` for the
 * new-session placeholder view) and the view's root element.
 */
export interface ISessionDropTargetDelegate {
	findTargetView(child: HTMLElement): { readonly sessionId: string | undefined; readonly element: HTMLElement } | undefined;
	/**
	 * Tells the grid where the dropped session's cell goes. Set right before
	 * the session is inserted into the visibility model and cleared right
	 * after, so it only applies to the reconciliation the drop triggers.
	 */
	setPendingPlacement(placement: ISessionPlacement | undefined): void;
}

class SessionDropOverlay extends Themable {

	private static readonly OVERLAY_ID = 'monaco-workbench-session-drop-overlay';
	private static readonly INDICATOR_INSET = 6;

	private _container: HTMLElement | undefined;
	private _overlay: HTMLElement | undefined;
	private _label: HTMLElement | undefined;

	private _currentSide: DropSide | undefined;

	private _disposed = false;
	get disposed(): boolean { return this._disposed; }

	private readonly _cleanupOverlayScheduler: RunOnceScheduler;

	private readonly _sessionTransfer = LocalSelectionTransfer.getInstance<DraggedSessionIdentifier>();

	constructor(
		readonly targetSessionId: string | undefined,
		private readonly _targetElement: HTMLElement,
		private readonly _delegate: ISessionDropTargetDelegate,
		@IThemeService themeService: IThemeService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		super(themeService);

		this._cleanupOverlayScheduler = this._register(new RunOnceScheduler(() => this.dispose(), 300));

		this._create();
	}

	private _create(): void {
		const container = this._container = $('div', { id: SessionDropOverlay.OVERLAY_ID });

		this._targetElement.appendChild(container);
		this._targetElement.classList.add('dragged-over');
		this._register(toDisposable(() => {
			container.remove();
			this._targetElement.classList.remove('dragged-over');
		}));

		this._overlay = $('.session-drop-overlay-indicator');
		this._label = $('span.session-drop-overlay-label');
		this._overlay.appendChild(this._label);
		container.appendChild(this._overlay);

		this._registerListeners(container);
		this.updateStyles();
	}

	override updateStyles(): void {
		// Fill and border come from sessionDropTarget.css (accent-tinted so the
		// target reads clearly over wallpapers); high contrast adds a dashed outline.
		const overlay = assertReturnsDefined(this._overlay);

		const activeContrastBorderColor = this.getColor(activeContrastBorder);
		overlay.style.outlineColor = activeContrastBorderColor || '';
		overlay.style.outlineOffset = activeContrastBorderColor ? '-2px' : '';
		overlay.style.outlineStyle = activeContrastBorderColor ? 'dashed' : '';
		overlay.style.outlineWidth = activeContrastBorderColor ? '2px' : '';
	}

	private _registerListeners(container: HTMLElement): void {
		this._register(new DragAndDropObserver(container, {
			onDragOver: e => {
				if (!this._sessionTransfer.hasData(DraggedSessionIdentifier.prototype)) {
					this._hideOverlay();
					return;
				}

				this._positionOverlay(e.offsetX, e.offsetY);

				if (this._cleanupOverlayScheduler.isScheduled()) {
					this._cleanupOverlayScheduler.cancel();
				}
			},

			onDragLeave: () => this.dispose(),
			onDragEnd: () => this.dispose(),

			onDrop: e => {
				EventHelper.stop(e, true);

				const side = this._currentSide;
				this.dispose();

				if (side) {
					this._handleDrop(side);
				}
			}
		}));

		this._register(addDisposableListener(container, EventType.MOUSE_OVER, () => {
			// Mirror the editor overlay's mouse-over safety net: if the overlay
			// is somehow not cleaned up by drag events, the next mouse-over
			// schedules disposal to free the underlying view.
			if (!this._cleanupOverlayScheduler.isScheduled()) {
				this._cleanupOverlayScheduler.schedule();
			}
		}));
	}

	private _handleDrop(side: DropSide): void {
		const data = this._sessionTransfer.getData(DraggedSessionIdentifier.prototype);
		this._sessionTransfer.clearData(DraggedSessionIdentifier.prototype);

		if (!Array.isArray(data) || data.length === 0) {
			return;
		}

		const dragged = data[0];
		if (dragged.sessionId === this.targetSessionId) {
			return; // dropping a session next to itself is a no-op
		}

		const session = this._sessionsManagementService.getSession(dragged.resource);
		if (!session) {
			return;
		}

		// The visibility model is a flat list: above/below map to before/after,
		// while the grid learns the actual direction through the placement.
		const direction = side === 'left' ? Direction.Left : side === 'right' ? Direction.Right : side === 'up' ? Direction.Up : Direction.Down;
		this._delegate.setPendingPlacement({ sessionId: session.sessionId, targetSessionId: this.targetSessionId, direction });
		try {
			this._sessionsService.insertAt(session, this.targetSessionId, side === 'left' || side === 'up' ? 'left' : 'right');
		} finally {
			this._delegate.setPendingPlacement(undefined);
		}
	}

	private _positionOverlay(mousePosX: number, mousePosY: number): void {
		// Split towards the nearest edge, so a view can be split side by side or
		// stacked (and any mix of both, e.g. quadrants).
		const x = mousePosX / Math.max(1, this._targetElement.clientWidth);
		const y = mousePosY / Math.max(1, this._targetElement.clientHeight);
		const distances: [DropSide, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
		const side = distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];

		switch (side) {
			case 'left': this._doPositionOverlay({ top: '0%', left: '0%', width: '50%', height: '100%' }); break;
			case 'right': this._doPositionOverlay({ top: '0%', left: '50%', width: '50%', height: '100%' }); break;
			case 'up': this._doPositionOverlay({ top: '0%', left: '0%', width: '100%', height: '50%' }); break;
			case 'down': this._doPositionOverlay({ top: '50%', left: '0%', width: '100%', height: '50%' }); break;
		}
		if (side !== this._currentSide) {
			const label = assertReturnsDefined(this._label);
			label.textContent = side === 'left' ? localize('sessionDrop.splitLeft', "Split Left")
				: side === 'right' ? localize('sessionDrop.splitRight', "Split Right")
					: side === 'up' ? localize('sessionDrop.splitUp', "Split Up")
						: localize('sessionDrop.splitDown', "Split Down");
		}

		const overlay = assertReturnsDefined(this._overlay);
		overlay.style.opacity = '1';

		// Enable transition after a timeout to prevent initial animation.
		setTimeout(() => overlay.classList.add('overlay-move-transition'), 0);

		this._currentSide = side;
	}

	private _doPositionOverlay(options: { top: string; left: string; width: string; height: string }): void {
		const [container, overlay] = assertReturnsAllDefined(this._container, this._overlay);
		// Inset the indicator so its rounded frame reads as a drop zone inside
		// the pane rather than a flat tint across it.
		const inset = SessionDropOverlay.INDICATOR_INSET;
		container.style.height = '100%';
		overlay.style.top = `calc(${options.top} + ${inset}px)`;
		overlay.style.height = `calc(${options.height} - ${2 * inset}px)`;
		overlay.style.left = `calc(${options.left} + ${inset}px)`;
		overlay.style.width = `calc(${options.width} - ${2 * inset}px)`;
	}

	private _hideOverlay(): void {
		const overlay = assertReturnsDefined(this._overlay);

		this._doPositionOverlay({ top: '0%', left: '0%', width: '100%', height: '100%' });
		overlay.style.opacity = '0';
		overlay.classList.remove('overlay-move-transition');

		this._currentSide = undefined;
	}

	contains(element: HTMLElement): boolean {
		return element === this._container || element === this._overlay;
	}

	override dispose(): void {
		super.dispose();

		this._disposed = true;
	}
}

/**
 * Drop target for the sessions grid. Listens for drag events over the part's
 * content area, displays a half-pane overlay on whichever session view is
 * being hovered, and calls into {@link ISessionsManagementService} to insert
 * or move the dragged session next to the target.
 *
 * Drops split the hovered view towards its nearest edge (left, right, up or
 * down); "into" drops are not supported.
 */
export class SessionDropTarget extends Themable {

	private _overlay?: SessionDropOverlay;

	private _counter = 0;

	private readonly _sessionTransfer = LocalSelectionTransfer.getInstance<DraggedSessionIdentifier>();

	constructor(
		private readonly _container: HTMLElement,
		private readonly _delegate: ISessionDropTargetDelegate,
		@IThemeService themeService: IThemeService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(themeService);

		this._registerListeners();
	}

	private get overlay(): SessionDropOverlay | undefined {
		if (this._overlay && !this._overlay.disposed) {
			return this._overlay;
		}
		return undefined;
	}

	private _registerListeners(): void {
		this._register(addDisposableListener(this._container, EventType.DRAG_ENTER, e => this._onDragEnter(e)));
		this._register(addDisposableListener(this._container, EventType.DRAG_LEAVE, () => this._onDragLeave()));
		const targetWindow = getWindow(this._container);
		for (const target of [this._container, targetWindow]) {
			this._register(addDisposableListener(target, EventType.DRAG_END, () => this._onDragEnd()));
		}

		// Pane headers stand in for the title bar and are window-drag regions,
		// which swallow drag events (a drop there would never land). While a
		// session is being dragged, turn them into ordinary drop targets. The
		// drag sources set their payload in their own dragstart handlers, which
		// run before this window-level (bubbling) listener.
		this._register(addDisposableListener(targetWindow, EventType.DRAG_START, () => {
			if (this._sessionTransfer.hasData(DraggedSessionIdentifier.prototype)) {
				this._container.classList.add('session-drag-in-progress');
			}
		}));
		for (const type of [EventType.DRAG_END, EventType.DROP]) {
			this._register(addDisposableListener(targetWindow, type, () => this._container.classList.remove('session-drag-in-progress'), true));
		}
	}

	private _onDragEnter(event: DragEvent): void {
		this._counter++;

		// Only handle drags that carry a session payload.
		if (!this._sessionTransfer.hasData(DraggedSessionIdentifier.prototype)) {
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'none';
			}
			return;
		}

		this._updateContainer(true);

		const target = event.target as HTMLElement;
		if (!target) {
			return;
		}

		// If the mouse jumped out of the current overlay, dispose it.
		if (this.overlay && !this.overlay.contains(target)) {
			this._disposeOverlay();
		}

		if (this.overlay) {
			return;
		}

		const targetView = this._delegate.findTargetView(target);
		if (!targetView) {
			return;
		}

		this._overlay = this._instantiationService.createInstance(
			SessionDropOverlay,
			targetView.sessionId,
			targetView.element,
			this._delegate,
		);
	}

	private _onDragLeave(): void {
		this._counter--;

		if (this._counter === 0) {
			this._updateContainer(false);
		}
	}

	private _onDragEnd(): void {
		this._counter = 0;

		this._updateContainer(false);
		this._disposeOverlay();
	}

	private _updateContainer(isDraggedOver: boolean): void {
		this._container.classList.toggle('dragged-over', isDraggedOver);
	}

	override dispose(): void {
		super.dispose();
		this._disposeOverlay();
	}

	private _disposeOverlay(): void {
		if (this._overlay) {
			this._overlay.dispose();
			this._overlay = undefined;
		}
	}
}
