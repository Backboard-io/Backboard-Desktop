/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/spotlightTour.css';

import { $, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getWindow, IDomNodePagePosition } from '../../../../base/browser/dom.js';
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
	readonly title: string;
	readonly body: string;
	/** Preferred side to place the card on; the tour falls back automatically when it does not fit. */
	readonly preferredPlacement?: TourPlacement;
	/** Extra breathing room (px) around the anchor inside the spotlight cutout. */
	readonly padding?: number;
	/**
	 * Optional async work run before the step is shown, e.g. opening a panel so
	 * the step can spotlight it. The previous card stays visible until it settles.
	 */
	readonly setup?: () => Promise<void> | void;
	/**
	 * Resolves the element to spotlight, called after {@link setup} and a layout
	 * frame. Returning `undefined` (or an off-screen element) shows the card
	 * centered with no spotlight instead of dropping the step.
	 */
	readonly anchor: () => HTMLElement | undefined;
	/**
	 * Overrides the primary button label for this step (normally "Continue", or
	 * "Done" on the last step), e.g. when finishing the tour triggers an action.
	 */
	readonly nextLabel?: string;
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
/** Frames to wait after a step's setup before measuring, so opened panels can lay out. */
const SETTLE_FRAMES = 2;

const PLACEMENT_FALLBACK_ORDER: readonly TourPlacement[] = [TourPlacement.Right, TourPlacement.Bottom, TourPlacement.Left, TourPlacement.Top];

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * A lightweight, spotlight-style product tour: it dims the workbench, rings the
 * target panel or button, and floats a card next to it with an arrow pointing
 * at the target. Steps may run async setup first (e.g. open a panel) and
 * resolve their anchor lazily, so the tour can actively drive the UI. An
 * optional centered consent card is shown first.
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
	private transitioning = false;
	/** Bumped on every navigation so stale async renders (slow setup) abort. */
	private renderSeq = 0;
	/** The most recent step setup, so finishing can wait for it before restoring. */
	private pendingSetup: Promise<void> | undefined;
	private currentStep: ISpotlightTourStep | undefined;
	private currentAnchor: HTMLElement | undefined;
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

		const reposition = () => this._reposition();
		const observer = this.lifecycle.add(new DisposableResizeObserver('spotlightTour', reposition, getWindow(card)));
		this.lifecycle.add(observer.observe(card));
		this.lifecycle.add(observer.observe(overlay));
		if (this.options.onLayoutChange) {
			this.lifecycle.add(this.options.onLayoutChange(reposition));
		}
		this.lifecycle.add(addDisposableListener(window, EventType.RESIZE, reposition));
		this.lifecycle.add(addDisposableListener(window, EventType.SCROLL, reposition, true));
		this.lifecycle.add(addDisposableListener(overlay, EventType.KEY_DOWN, (e: KeyboardEvent) => this._onKeyDown(e)));

		if (this.options.intro) {
			this._renderIntro(this.options.intro);
		} else {
			this.stepIndex = 0;
			void this._renderStep();
		}
	}

	private _onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		if (event.keyCode === KeyCode.Escape) {
			e.preventDefault();
			void this._finish(false);
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
		this.renderSeq++;
		this.stepDisposables.clear();
		clearNode(this.card);

		// The intro has no target: dim the whole window and center the card.
		this.overlay.classList.add('spotlight-tour-dimmed');
		this.spotlight.style.display = 'none';
		this.arrow = undefined;
		this.currentAnchor = undefined;

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

		this.stepDisposables.add(addDisposableListener(dismissButton, EventType.CLICK, () => void this._finish(false)));
		this.stepDisposables.add(addDisposableListener(confirmButton, EventType.CLICK, () => {
			this.inIntro = false;
			this.stepIndex = 0;
			void this._renderStep();
		}));

		this._centerCard();
		this.options.window.requestAnimationFrame(() => {
			this.overlay?.classList.add('spotlight-tour-visible');
			confirmButton.focus();
		});
	}

	private async _renderStep(): Promise<void> {
		if (!this.card || !this.overlay || !this.spotlight) {
			return;
		}
		const seq = ++this.renderSeq;
		this.transitioning = true;

		const step = this.options.steps[this.stepIndex];

		// Run optional setup (e.g. open a panel). The previous card stays up.
		// Tracked so _finish can await it before the caller restores layout.
		if (step.setup) {
			const pending = Promise.resolve().then(() => step.setup!()).catch(() => { /* best effort */ });
			this.pendingSetup = pending;
			await pending;
			if (this.pendingSetup === pending) {
				this.pendingSetup = undefined;
			}
		}
		if (seq !== this.renderSeq || !this.card || !this.overlay || !this.spotlight) {
			return;
		}

		// Let a just-opened panel lay out before we measure it.
		await this._afterFrames(SETTLE_FRAMES);
		if (seq !== this.renderSeq || !this.card || !this.overlay || !this.spotlight) {
			return;
		}

		let anchor: HTMLElement | undefined;
		try {
			const resolved = step.anchor();
			anchor = resolved;
		} catch {
			// A buggy resolver must not freeze the tour — fall back to a centered card.
			anchor = undefined;
		}
		this.currentStep = step;
		this.currentAnchor = anchor;

		const isFirst = this.stepIndex === 0;
		const isLast = this.stepIndex === this.options.steps.length - 1;

		this.stepDisposables.clear();
		clearNode(this.card);
		this.card.setAttribute('aria-label', step.title);

		if (anchor) {
			this.overlay.classList.remove('spotlight-tour-dimmed');
			this.spotlight.style.display = '';
			this.arrow = append(this.card, $('.spotlight-tour-arrow'));
		} else {
			this.overlay.classList.add('spotlight-tour-dimmed');
			this.spotlight.style.display = 'none';
			this.arrow = undefined;
		}

		if (anchor) {
			const observer = this.stepDisposables.add(new DisposableResizeObserver('spotlightTourAnchor', () => this._reposition(), getWindow(anchor)));
			this.stepDisposables.add(observer.observe(anchor));
		}

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
		nextButton.textContent = step.nextLabel ?? (isLast ? localize('spotlightTour.done', "Done") : localize('spotlightTour.continue', "Continue"));

		this.stepDisposables.add(addDisposableListener(skipButton, EventType.CLICK, () => void this._finish(false)));
		this.stepDisposables.add(addDisposableListener(backButton, EventType.CLICK, () => this._go(-1)));
		this.stepDisposables.add(addDisposableListener(nextButton, EventType.CLICK, () => isLast ? void this._finish(true) : this._go(1)));

		this._reposition();

		this.transitioning = false;
		this.options.window.requestAnimationFrame(() => {
			this.overlay?.classList.add('spotlight-tour-visible');
			this.card?.focus();
		});
	}

	private _go(delta: number): void {
		if (this.transitioning) {
			return;
		}
		const next = this.stepIndex + delta;
		if (next < 0 || next >= this.options.steps.length) {
			return;
		}
		this.stepIndex = next;
		void this._renderStep();
	}

	private _afterFrames(frames: number): Promise<void> {
		return new Promise<void>(resolve => {
			const win = this.options.window;
			let remaining = Math.max(1, frames);
			const tick = () => {
				remaining--;
				if (remaining <= 0) {
					resolve();
				} else {
					win.requestAnimationFrame(tick);
				}
			};
			win.requestAnimationFrame(tick);
		});
	}

	private _reposition(): void {
		if (this.inIntro || !this.currentAnchor || !this._isElementVisible(this.currentAnchor)) {
			this.overlay?.classList.add('spotlight-tour-dimmed');
			if (this.spotlight) {
				this.spotlight.style.display = 'none';
			}
			if (this.arrow) {
				this.arrow.style.display = 'none';
			}
			this._centerCard();
			return;
		}
		this.overlay?.classList.remove('spotlight-tour-dimmed');
		if (this.spotlight) {
			this.spotlight.style.display = '';
		}
		this._position();
	}

	private _centerCard(): void {
		if (!this.card || !this.overlay) {
			return;
		}
		this.card.style.left = `${Math.max(VIEWPORT_MARGIN, (this.overlay.clientWidth - this.card.offsetWidth) / 2)}px`;
		this.card.style.top = `${Math.max(VIEWPORT_MARGIN, (this.overlay.clientHeight - this.card.offsetHeight) / 2)}px`;
	}

	/** Measure in overlay coordinates, including CSS zoom and transformed containers. */
	private _anchorBounds(element: HTMLElement): IDomNodePagePosition {
		const bounds = element.getBoundingClientRect();
		const overlay = this.overlay!;
		const origin = overlay.getBoundingClientRect();
		const scaleX = origin.width / overlay.clientWidth || 1;
		const scaleY = origin.height / overlay.clientHeight || 1;
		const left = clamp((bounds.left - origin.left) / scaleX, 0, overlay.clientWidth);
		const top = clamp((bounds.top - origin.top) / scaleY, 0, overlay.clientHeight);
		const right = clamp((bounds.right - origin.left) / scaleX, 0, overlay.clientWidth);
		const bottom = clamp((bounds.bottom - origin.top) / scaleY, 0, overlay.clientHeight);
		return { left, top, width: right - left, height: bottom - top };
	}

	private _position(): void {
		if (!this.overlay || !this.card || !this.spotlight || !this.arrow || !this.currentAnchor || !this.currentStep) {
			return;
		}

		const step = this.currentStep;
		const viewport = { innerWidth: this.overlay.clientWidth, innerHeight: this.overlay.clientHeight };
		const target = this._anchorBounds(this.currentAnchor);
		const padding = step.padding ?? DEFAULT_PADDING;

		// Clamp the padded highlight to the visible viewport.
		const leftEdge = Math.max(2, target.left - padding);
		const topEdge = Math.max(2, target.top - padding);
		const anchor = {
			left: leftEdge,
			top: topEdge,
			width: Math.max(0, Math.min(viewport.innerWidth - 2, target.left + target.width + padding) - leftEdge),
			height: Math.max(0, Math.min(viewport.innerHeight - 2, target.top + target.height + padding) - topEdge),
		};
		this.spotlight.style.left = `${anchor.left}px`;
		this.spotlight.style.top = `${anchor.top}px`;
		this.spotlight.style.width = `${anchor.width}px`;
		this.spotlight.style.height = `${anchor.height}px`;

		const cardWidth = this.card.offsetWidth || CARD_WIDTH;
		const cardHeight = this.card.offsetHeight;
		const placement = this._choosePlacement(anchor, cardWidth, cardHeight, viewport, step.preferredPlacement);
		this.arrow.style.display = placement ? '' : 'none';
		if (!placement) {
			this._centerCard();
			return;
		}

		const anchorCenterX = anchor.left + anchor.width / 2;
		const anchorCenterY = anchor.top + anchor.height / 2;

		let left: number;
		let top: number;
		switch (placement) {
			case TourPlacement.Right:
				left = anchor.left + anchor.width + CARD_GAP;
				top = anchorCenterY - cardHeight / 2;
				break;
			case TourPlacement.Left:
				left = anchor.left - CARD_GAP - cardWidth;
				top = anchorCenterY - cardHeight / 2;
				break;
			case TourPlacement.Bottom:
				left = anchorCenterX - cardWidth / 2;
				top = anchor.top + anchor.height + CARD_GAP;
				break;
			case TourPlacement.Top:
			default:
				left = anchorCenterX - cardWidth / 2;
				top = anchor.top - CARD_GAP - cardHeight;
				break;
		}

		left = clamp(left, VIEWPORT_MARGIN, viewport.innerWidth - cardWidth - VIEWPORT_MARGIN);
		top = clamp(top, VIEWPORT_MARGIN, viewport.innerHeight - cardHeight - VIEWPORT_MARGIN);
		this.card.style.left = `${left}px`;
		this.card.style.top = `${top}px`;

		this._positionArrow(placement, left, top, cardWidth, cardHeight, anchorCenterX, anchorCenterY);
	}

	private _choosePlacement(anchor: IDomNodePagePosition, cardWidth: number, cardHeight: number, win: Pick<Window, 'innerWidth' | 'innerHeight'>, preferred?: TourPlacement): TourPlacement | undefined {
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
		return undefined;
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

	private _isElementVisible(element: HTMLElement): boolean {
		const position = this._anchorBounds(element);
		return position.width > 0 && position.height > 0;
	}

	private async _finish(completed: boolean): Promise<void> {
		// Invalidate any in-flight async render before tearing down.
		this.renderSeq++;
		this.transitioning = false;
		this.stepDisposables.clear();
		this.lifecycle.clear();
		this.overlay = this.spotlight = this.card = this.arrow = undefined;
		this.currentStep = this.currentAnchor = undefined;
		this.previouslyFocusedElement?.focus();

		// A panel-opening setup may still be in flight (e.g. the user skipped
		// mid-step); let it settle before onFinish runs, so a caller that
		// restores the layout does not race the command it opened.
		const pending = this.pendingSetup;
		this.pendingSetup = undefined;
		if (pending) {
			await pending;
		}
		this.options.onFinish?.(completed);
	}
}
