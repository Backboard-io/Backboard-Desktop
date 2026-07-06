/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/spotlightTour.css';

import { $, addDisposableListener, append, clearNode, EventType, getDomNodePagePosition, getTotalHeight, getTotalWidth, IDomNodePagePosition } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

/** Which side of the target the tour card is placed on. */
export const enum TourPlacement {
	Top = 'top',
	Bottom = 'bottom',
	Left = 'left',
	Right = 'right',
}

export interface ISpotlightTourStep {
	/** Element to spotlight (a whole panel or a single button) and point the card at. */
	readonly anchor: HTMLElement;
	readonly title: string;
	readonly body: string;
	/** Preferred side to place the card on; the tour falls back automatically when it does not fit. */
	readonly preferredPlacement?: TourPlacement;
	/** Extra breathing room (px) around the anchor inside the spotlight cutout. */
	readonly padding?: number;
}

/** A centered consent card shown before the walkthrough, asking whether to start it. */
export interface ISpotlightTourIntro {
	readonly title: string;
	readonly body: string;
	/** Small caption under the body, e.g. "3 quick stops". */
	readonly caption?: string;
	readonly confirmLabel: string;
	readonly dismissLabel: string;
}

export interface ISpotlightTourOptions {
	/** Container the overlay is appended to (e.g. the layout service active container). */
	readonly container: HTMLElement;
	/** Window the tour renders in. */
	readonly window: Window;
	/** Fires when the surrounding layout changes so the spotlight can be re-measured. */
	readonly onLayoutChange?: Event<unknown>;
	/** Optional consent card shown first; when omitted the walkthrough starts immediately. */
	readonly intro?: ISpotlightTourIntro;
	/** The walkthrough steps. */
	readonly steps: readonly ISpotlightTourStep[];
	/** Invoked once when the tour ends. `completed` is true only if the user reached the last step. */
	readonly onFinish?: (completed: boolean) => void;
}

const CARD_WIDTH = 340;
const CARD_GAP = 16;
const VIEWPORT_MARGIN = 16;
const DEFAULT_PADDING = 6;
/** Keep the arrow this far from the card corners so it never points into a rounded edge. */
const ARROW_EDGE_MARGIN = 20;

const PLACEMENT_FALLBACK_ORDER: readonly TourPlacement[] = [TourPlacement.Right, TourPlacement.Bottom, TourPlacement.Left, TourPlacement.Top];

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * A lightweight, spotlight-style product tour: it dims the workbench, rings the
 * target panel or button, and floats a card next to it with an arrow pointing
 * at the target. The card auto-places on whichever side has room. An optional
 * centered consent card is shown first. Callers resolve their own anchors
 * (workbench parts, DOM selectors, ...) and hand the resolved steps in.
 */
export class SpotlightTour extends Disposable {

	private readonly lifecycle = this._register(new DisposableStore());
	private readonly stepDisposables = this._register(new DisposableStore());

	private overlay: HTMLElement | undefined;
	private spotlight: HTMLElement | undefined;
	private card: HTMLElement | undefined;
	private arrow: HTMLElement | undefined;

	private stepIndex = 0;
	private inIntro = false;
	private previouslyFocusedElement: HTMLElement | undefined;

	constructor(private readonly options: ISpotlightTourOptions) {
		super();
	}

	start(): void {
		if (!this.options.steps.length || this.overlay) {
			return;
		}

		const { container, window } = this.options;
		this.previouslyFocusedElement = window.document.activeElement as HTMLElement | undefined;

		const overlay = this.overlay = append(container, $('.spotlight-tour-overlay'));
		this.lifecycle.add(toDisposable(() => overlay.remove()));

		this.spotlight = append(overlay, $('.spotlight-tour-cutout'));

		const card = this.card = append(overlay, $('.spotlight-tour-card'));
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		card.tabIndex = -1;

		const reposition = () => this.inIntro ? this._centerCard() : this._position();
		if (this.options.onLayoutChange) {
			this.lifecycle.add(this.options.onLayoutChange(reposition));
		}
		this.lifecycle.add(addDisposableListener(window, EventType.RESIZE, reposition));
		this.lifecycle.add(addDisposableListener(overlay, EventType.KEY_DOWN, (e: KeyboardEvent) => this._onKeyDown(e)));

		if (this.options.intro) {
			this._renderIntro(this.options.intro);
		} else {
			this.stepIndex = 0;
			this._renderStep();
		}
	}

	private _onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		if (event.keyCode === KeyCode.Escape) {
			e.preventDefault();
			this._finish(false);
			return;
		}
		// Trap focus inside the card while the tour is modal.
		if (event.keyCode === KeyCode.Tab && this.card) {
			const focusable = Array.from(this.card.querySelectorAll<HTMLButtonElement>('button'))
				.filter(button => button.style.visibility !== 'hidden');
			if (!focusable.length) {
				return;
			}
			const current = focusable.indexOf(this.options.window.document.activeElement as HTMLButtonElement);
			const delta = event.shiftKey ? -1 : 1;
			const nextIndex = (current + delta + focusable.length) % focusable.length;
			e.preventDefault();
			focusable[nextIndex].focus();
		}
	}

	private _renderIntro(intro: ISpotlightTourIntro): void {
		if (!this.card || !this.overlay || !this.spotlight) {
			return;
		}
		this.inIntro = true;
		this.stepDisposables.clear();
		clearNode(this.card);

		// The intro has no target: dim the whole window and center the card.
		this.overlay.classList.add('spotlight-tour-dimmed');
		this.spotlight.style.display = 'none';
		this.arrow = undefined;

		this.card.setAttribute('aria-label', intro.title);

		const body = append(this.card, $('.spotlight-tour-body'));
		append(body, $('h3.spotlight-tour-title')).textContent = intro.title;
		append(body, $('p.spotlight-tour-text')).textContent = intro.body;
		if (intro.caption) {
			append(body, $('p.spotlight-tour-caption')).textContent = intro.caption;
		}

		const footer = append(this.card, $('.spotlight-tour-footer.spotlight-tour-footer-intro'));
		const dismissButton = append(footer, $<HTMLButtonElement>('button.spotlight-tour-btn.spotlight-tour-btn-secondary'));
		dismissButton.type = 'button';
		dismissButton.textContent = intro.dismissLabel;
		const confirmButton = append(footer, $<HTMLButtonElement>('button.spotlight-tour-btn.spotlight-tour-btn-primary'));
		confirmButton.type = 'button';
		confirmButton.textContent = intro.confirmLabel;

		this.stepDisposables.add(addDisposableListener(dismissButton, EventType.CLICK, () => this._finish(false)));
		this.stepDisposables.add(addDisposableListener(confirmButton, EventType.CLICK, () => {
			this.inIntro = false;
			this.stepIndex = 0;
			this._renderStep();
		}));

		this._centerCard();
		this.options.window.requestAnimationFrame(() => {
			this.overlay?.classList.add('spotlight-tour-visible');
			confirmButton.focus();
		});
	}

	private _renderStep(): void {
		if (!this.card || !this.overlay || !this.spotlight) {
			return;
		}
		this.stepDisposables.clear();
		clearNode(this.card);

		// Restore the spotlight after a (dimmed, target-less) intro card.
		this.overlay.classList.remove('spotlight-tour-dimmed');
		this.spotlight.style.display = '';

		const step = this.options.steps[this.stepIndex];
		const isFirst = this.stepIndex === 0;
		const isLast = this.stepIndex === this.options.steps.length - 1;

		this.card.setAttribute('aria-label', step.title);

		this.arrow = append(this.card, $('.spotlight-tour-arrow'));

		const body = append(this.card, $('.spotlight-tour-body'));
		append(body, $('h3.spotlight-tour-title')).textContent = step.title;
		append(body, $('p.spotlight-tour-text')).textContent = step.body;

		const footer = append(this.card, $('.spotlight-tour-footer'));

		const skipButton = append(footer, $<HTMLButtonElement>('button.spotlight-tour-skip'));
		skipButton.type = 'button';
		skipButton.textContent = localize('spotlightTour.skip', "Skip");

		const progress = append(footer, $('.spotlight-tour-progress'));
		for (let i = 0; i < this.options.steps.length; i++) {
			const dot = append(progress, $('span.spotlight-tour-dot'));
			if (i === this.stepIndex) {
				dot.classList.add('spotlight-tour-dot-active');
			}
		}

		const footerRight = append(footer, $('.spotlight-tour-footer-right'));

		const backButton = append(footerRight, $<HTMLButtonElement>('button.spotlight-tour-btn.spotlight-tour-btn-secondary'));
		backButton.type = 'button';
		backButton.textContent = localize('spotlightTour.back', "Back");
		backButton.style.visibility = isFirst ? 'hidden' : '';

		const nextButton = append(footerRight, $<HTMLButtonElement>('button.spotlight-tour-btn.spotlight-tour-btn-primary'));
		nextButton.type = 'button';
		nextButton.textContent = isLast ? localize('spotlightTour.done', "Done") : localize('spotlightTour.continue', "Continue");

		this.stepDisposables.add(addDisposableListener(skipButton, EventType.CLICK, () => this._finish(false)));
		this.stepDisposables.add(addDisposableListener(backButton, EventType.CLICK, () => this._go(-1)));
		this.stepDisposables.add(addDisposableListener(nextButton, EventType.CLICK, () => isLast ? this._finish(true) : this._go(1)));

		this._position();

		this.options.window.requestAnimationFrame(() => {
			this.overlay?.classList.add('spotlight-tour-visible');
			this.card?.focus();
		});
	}

	private _go(delta: number): void {
		const next = this.stepIndex + delta;
		if (next < 0 || next >= this.options.steps.length) {
			return;
		}
		this.stepIndex = next;
		this._renderStep();
	}

	private _centerCard(): void {
		if (!this.card) {
			return;
		}
		const win = this.options.window;
		const cardWidth = getTotalWidth(this.card) || CARD_WIDTH;
		const cardHeight = getTotalHeight(this.card);
		this.card.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN, (win.innerWidth - cardWidth) / 2))}px`;
		this.card.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN, (win.innerHeight - cardHeight) / 2))}px`;
	}

	private _position(): void {
		if (!this.card || !this.spotlight || !this.arrow) {
			return;
		}

		const step = this.options.steps[this.stepIndex];
		const win = this.options.window;
		const anchor = getDomNodePagePosition(step.anchor);
		const padding = step.padding ?? DEFAULT_PADDING;

		// Spotlight cutout hugging the target.
		this.spotlight.style.left = `${anchor.left - padding}px`;
		this.spotlight.style.top = `${anchor.top - padding}px`;
		this.spotlight.style.width = `${anchor.width + padding * 2}px`;
		this.spotlight.style.height = `${anchor.height + padding * 2}px`;

		const cardWidth = getTotalWidth(this.card) || CARD_WIDTH;
		const cardHeight = getTotalHeight(this.card);
		const placement = this._choosePlacement(anchor, cardWidth, cardHeight, win, step.preferredPlacement);

		const anchorCenterX = anchor.left + anchor.width / 2;
		const anchorCenterY = anchor.top + anchor.height / 2;

		let left: number;
		let top: number;
		switch (placement) {
			case TourPlacement.Right:
				left = anchor.left + anchor.width + padding + CARD_GAP;
				top = anchorCenterY - cardHeight / 2;
				break;
			case TourPlacement.Left:
				left = anchor.left - padding - CARD_GAP - cardWidth;
				top = anchorCenterY - cardHeight / 2;
				break;
			case TourPlacement.Bottom:
				left = anchorCenterX - cardWidth / 2;
				top = anchor.top + anchor.height + padding + CARD_GAP;
				break;
			case TourPlacement.Top:
			default:
				left = anchorCenterX - cardWidth / 2;
				top = anchor.top - padding - CARD_GAP - cardHeight;
				break;
		}

		left = clamp(left, VIEWPORT_MARGIN, win.innerWidth - cardWidth - VIEWPORT_MARGIN);
		top = clamp(top, VIEWPORT_MARGIN, win.innerHeight - cardHeight - VIEWPORT_MARGIN);
		this.card.style.left = `${left}px`;
		this.card.style.top = `${top}px`;

		this._positionArrow(placement, left, top, cardWidth, cardHeight, anchorCenterX, anchorCenterY);
	}

	private _choosePlacement(anchor: IDomNodePagePosition, cardWidth: number, cardHeight: number, win: Window, preferred?: TourPlacement): TourPlacement {
		const fits = (placement: TourPlacement): boolean => {
			switch (placement) {
				case TourPlacement.Right:
					return win.innerWidth - (anchor.left + anchor.width) >= cardWidth + CARD_GAP + VIEWPORT_MARGIN;
				case TourPlacement.Left:
					return anchor.left >= cardWidth + CARD_GAP + VIEWPORT_MARGIN;
				case TourPlacement.Bottom:
					return win.innerHeight - (anchor.top + anchor.height) >= cardHeight + CARD_GAP + VIEWPORT_MARGIN;
				case TourPlacement.Top:
					return anchor.top >= cardHeight + CARD_GAP + VIEWPORT_MARGIN;
			}
		};

		const candidates = preferred ? [preferred, ...PLACEMENT_FALLBACK_ORDER] : PLACEMENT_FALLBACK_ORDER;
		for (const candidate of candidates) {
			if (fits(candidate)) {
				return candidate;
			}
		}
		return preferred ?? TourPlacement.Bottom;
	}

	private _positionArrow(placement: TourPlacement, cardLeft: number, cardTop: number, cardWidth: number, cardHeight: number, anchorCenterX: number, anchorCenterY: number): void {
		if (!this.arrow) {
			return;
		}
		this.arrow.className = `spotlight-tour-arrow spotlight-tour-arrow-${placement}`;

		if (placement === TourPlacement.Left || placement === TourPlacement.Right) {
			this.arrow.style.left = '';
			this.arrow.style.top = `${clamp(anchorCenterY - cardTop, ARROW_EDGE_MARGIN, cardHeight - ARROW_EDGE_MARGIN)}px`;
		} else {
			this.arrow.style.top = '';
			this.arrow.style.left = `${clamp(anchorCenterX - cardLeft, ARROW_EDGE_MARGIN, cardWidth - ARROW_EDGE_MARGIN)}px`;
		}
	}

	private _finish(completed: boolean): void {
		this.stepDisposables.clear();
		this.lifecycle.clear();
		this.overlay = this.spotlight = this.card = this.arrow = undefined;
		this.previouslyFocusedElement?.focus();
		this.options.onFinish?.(completed);
	}
}
