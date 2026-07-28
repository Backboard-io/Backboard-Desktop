/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, EventType } from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IJarvisRect } from '../../common/jarvisCanvasTypes.js';

/** Height of the card header strip, kept in sync with `jarvisCanvas.css`. */
const CARD_HEADER_HEIGHT = 32;

/** Card frame border width (1px each side), kept in sync with `jarvisCanvas.css`. */
const CARD_BORDER_WIDTH = 1;

/**
 * A floating card on the Jarvis canvas. Owns its own DOM frame — a header with
 * a title and a close button, a scrollable content area, and a resize-handle
 * anchor in the bottom-right corner — and exposes its world-space geometry so
 * the {@link JarvisCanvasPart} can position it.
 *
 * Concrete cards (chat, terminal, ...) extend this and fill in
 * {@link contentElement} through {@link layoutContent}. The canvas interaction
 * layer owns drag and resize behaviour through stable DOM anchors while the
 * base class wires close and focus reporting.
 */
export abstract class JarvisCard extends Disposable {

	/** Smallest card the canvas will allow, in world units. */
	static readonly MIN_WIDTH = 200;
	static readonly MIN_HEIGHT = 200;

	readonly id: string;

	private readonly _element: HTMLElement;
	private readonly _contentElement: HTMLElement;
	private readonly _headerElement: HTMLElement;
	private readonly _titleElement: HTMLElement;

	/** Bottom-right resize anchor used by the canvas interaction controller. */
	protected readonly resizeHandle: HTMLElement;

	private _geometry: IJarvisRect;

	private readonly _onDidChangeGeometry = this._register(new Emitter<IJarvisRect>());
	readonly onDidChangeGeometry: Event<IJarvisRect> = this._onDidChangeGeometry.event;

	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus: Event<void> = this._onDidFocus.event;

	private readonly _onDidRequestClose = this._register(new Emitter<void>());
	readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;

	constructor(id: string, title: string) {
		super();

		this.id = id;
		this._geometry = { x: 0, y: 0, width: JarvisCard.MIN_WIDTH, height: JarvisCard.MIN_HEIGHT };

		this._element = $('.jarvis-card');
		this._element.tabIndex = 0;
		this._element.setAttribute('role', 'group');
		this._element.setAttribute('aria-label', title);

		this._headerElement = append(this._element, $('.jarvis-card-header'));
		this._titleElement = append(this._headerElement, $('span.jarvis-card-title'));
		this._titleElement.textContent = title;
		const closeButton = append(this._headerElement, $('button.jarvis-card-close.codicon.codicon-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.title = localize('jarvis.card.close', "Close Card");
		closeButton.setAttribute('aria-label', closeButton.title);

		this._contentElement = append(this._element, $('.jarvis-card-content'));

		this.resizeHandle = append(this._element, $('.jarvis-card-resize-handle'));

		this._register(addDisposableListener(closeButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this._onDidRequestClose.fire();
		}));
		this._register(addDisposableListener(this._element, EventType.FOCUS_IN, () => this._onDidFocus.fire()));

		this.applyGeometry();
	}

	/** The card frame element. Owned by the card; parented by the canvas part. */
	get element(): HTMLElement {
		return this._element;
	}

	/** The card's scrollable content area, filled in by concrete cards. */
	get contentElement(): HTMLElement {
		return this._contentElement;
	}

	/** Header drag target used by the canvas interaction controller. */
	get headerElement(): HTMLElement {
		return this._headerElement;
	}

	/** Bottom-right resize target used by the canvas interaction controller. */
	get resizeHandleElement(): HTMLElement {
		return this.resizeHandle;
	}

	setTitle(title: string): void {
		this._titleElement.textContent = title;
		this._element.setAttribute('aria-label', title);
	}

	getGeometry(): IJarvisRect {
		return this._geometry;
	}

	setGeometry(rect: IJarvisRect): void {
		const width = Math.max(JarvisCard.MIN_WIDTH, rect.width);
		const height = Math.max(JarvisCard.MIN_HEIGHT, rect.height);
		this._geometry = { x: rect.x, y: rect.y, width, height };
		this.applyGeometry();
		this._onDidChangeGeometry.fire(this._geometry);
	}

	focus(): void {
		this._element.focus();
	}

	setZIndex(z: number): void {
		this._element.style.zIndex = String(z);
	}

	/** Recomputes embedded widget bounds without changing world geometry. */
	relayout(): void {
		this.applyGeometry();
	}

	private applyGeometry(): void {
		const { x, y, width, height } = this._geometry;
		this._element.style.left = `${x}px`;
		this._element.style.top = `${y}px`;
		this._element.style.width = `${width}px`;
		this._element.style.height = `${height}px`;

		const contentWidth = Math.max(0, width - CARD_BORDER_WIDTH * 2);
		const contentHeight = Math.max(0, height - CARD_HEADER_HEIGHT - CARD_BORDER_WIDTH * 2);
		this.layoutContent(contentWidth, contentHeight);
	}

	/**
	 * Lays the card's content out to the given inner content-box dimensions.
	 * Called whenever the card geometry changes. Concrete cards resize their
	 * embedded widget (chat list, terminal, ...) here.
	 */
	protected abstract layoutContent(width: number, height: number): void;
}
