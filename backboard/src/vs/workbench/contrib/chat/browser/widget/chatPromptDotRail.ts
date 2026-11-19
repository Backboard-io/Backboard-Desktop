/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, $, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';

export interface IChatPromptDot {
	readonly id: string;
	readonly label: string;
}

interface IChatPromptDotConstants {
	readonly visibleDots: number;
	readonly spacing: number;
	readonly fadeZone: number;
}

/**
 * First prompt of the sliding dot window. Keeps the active dot centred once the
 * transcript is long enough and clamps the window to both ends of the list.
 */
export function promptWindowStart(count: number, activeIndex: number, visibleDots: number): number {
	const clampedActive = Math.min(Math.max(activeIndex, 0), Math.max(count - 1, 0));
	const visibleCount = Math.min(visibleDots, count);
	return Math.min(Math.max(clampedActive - Math.floor(visibleCount / 2), 0), Math.max(0, count - visibleCount));
}

/**
 * A vertical rail of dots on the left edge of the chat transcript, one dot per
 * user prompt. Shows a sliding window of ~15 dots at a time; the dots sliding
 * out at the top/bottom of the window fade away. Clicking a dot jumps to that
 * prompt, and scrolling over the rail scrolls the transcript so the window can
 * be walked through the whole conversation.
 */
export class ChatPromptDotRail extends Disposable {

	private readonly _onDidClickPrompt = this._register(new Emitter<number>());
	readonly onDidClickPrompt: Event<number> = this._onDidClickPrompt.event;

	/** Fires the scroll delta (positive scrolls the transcript down) for a wheel gesture over the rail. */
	private readonly _onDidScroll = this._register(new Emitter<number>());
	readonly onDidScroll: Event<number> = this._onDidScroll.event;

	private readonly _rail: HTMLElement;
	private readonly _viewport: HTMLElement;
	private readonly _track: HTMLElement;
	private _dots: HTMLElement[] = [];

	private readonly _constants: IChatPromptDotConstants = {
		visibleDots: 15,
		spacing: 12,
		fadeZone: 30,
	};

	constructor(container: HTMLElement) {
		super();

		this._rail = $('.chat-prompt-dot-rail');
		this._rail.setAttribute('role', 'navigation');
		this._rail.setAttribute('aria-label', 'Prompts');
		this._viewport = $('.chat-prompt-dot-viewport');
		this._track = $('.chat-prompt-dot-track');
		this._viewport.appendChild(this._track);
		this._rail.appendChild(this._viewport);
		container.appendChild(this._rail);
		this._register(toDisposable(() => this._rail.remove()));

		this._register(addDisposableListener(this._rail, 'click', e => {
			const target = (e.target as HTMLElement).closest('.chat-prompt-dot');
			if (isHTMLElement(target)) {
				const index = Number(target.dataset.index);
				if (Number.isInteger(index)) {
					this._onDidClickPrompt.fire(index);
				}
			}
		}));

		// The rail owns the wheel gesture: it covers a strip of the transcript, so
		// the transcript's own scroller never sees these events.
		this._register(addDisposableListener(this._rail, 'wheel', e => {
			e.preventDefault();
			e.stopPropagation();
			this._onDidScroll.fire(this.wheelDelta(e));
		}, { passive: false }));
	}

	/**
	 * Update the rail contents and window position.
	 * @param prompts All prompts in the transcript, in order.
	 * @param activeIndex Index of the prompt currently at the top of the viewport.
	 */
	update(prompts: readonly IChatPromptDot[], activeIndex: number): void {
		if (prompts.length < 2) {
			this._rail.classList.add('hidden');
			this._track.replaceChildren();
			this._dots = [];
			return;
		}
		this._rail.classList.remove('hidden');

		const { visibleDots, spacing, fadeZone } = this._constants;
		const visibleCount = Math.min(visibleDots, prompts.length);
		const clampedActive = Math.min(Math.max(activeIndex, 0), prompts.length - 1);
		const windowStart = promptWindowStart(prompts.length, clampedActive, visibleDots);

		this._viewport.style.height = `${visibleCount * spacing}px`;
		this._track.style.transform = `translateY(${-windowStart * spacing}px)`;

		// Dots sliding out of the window sit in the fade zones and fade away; the
		// outermost visible dots are dimmed so the edges look feathered.
		const viewportHeight = visibleCount * spacing;
		const first = Math.max(0, windowStart - 2);
		const end = Math.min(prompts.length, windowStart + visibleCount + 2);
		while (this._dots.length > end - first) {
			this._dots.pop()!.remove();
		}
		for (let i = first; i < end; i++) {
			let dot = this._dots[i - first];
			if (!dot) {
				dot = $('.chat-prompt-dot');
				dot.setAttribute('role', 'button');
				dot.setAttribute('tabindex', '-1');
				this._track.appendChild(dot);
				this._dots.push(dot);
			}
			const prompt = prompts[i];
			dot.style.top = `${i * spacing}px`;
			dot.dataset.index = String(i);
			dot.setAttribute('aria-label', `Go to prompt ${i + 1}: ${prompt.label}`);
			dot.title = prompt.label;
			const center = (i - windowStart) * spacing + spacing / 2;
			const distanceToEdge = Math.min(center, viewportHeight - center);
			const t = Math.min(Math.max(distanceToEdge / fadeZone, 0), 1);
			if (t <= 0.05) {
				dot.style.visibility = 'hidden';
				dot.style.pointerEvents = 'none';
			} else {
				dot.style.visibility = '';
				dot.style.pointerEvents = '';
				dot.style.opacity = String(0.25 + 0.75 * t);
			}
			dot.classList.toggle('active', i === clampedActive);
		}
	}

	private wheelDelta(e: WheelEvent): number {
		switch (e.deltaMode) {
			case WheelEvent.DOM_DELTA_LINE:
				return e.deltaY * this._constants.spacing;
			case WheelEvent.DOM_DELTA_PAGE:
				return e.deltaY * this._viewport.clientHeight;
			default:
				return e.deltaY;
		}
	}

}
