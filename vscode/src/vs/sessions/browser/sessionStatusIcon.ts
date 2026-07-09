/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../base/browser/dom.js';
import { disposableTimeout } from '../../base/common/async.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { createPixelSpinner } from '../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { asCssVariable } from '../../platform/theme/common/colorUtils.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';
import { SessionStatus } from '../services/sessions/common/session.js';
import { ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';

const $ = DOM.$;

// Duration of the cross-fade when the icon swaps to a different glyph/variant.
const ICON_SWAP_FADE_MS = 180;

// Marker dataset key on the outgoing element during a cross-fade swap. Lets a
// follow-up swap (before the previous fade finishes) skip re-processing it.
const ICON_FADING_OUT_ATTR = 'iconFadingOut';

// Sentinel cache key used when the icon container holds an animated pixel
// spinner (vs. a codicon). Same-variant re-renders only update color and avoid
// restarting the CSS animation.
const PIXEL_SPINNER_RING_KEY = '__pixel_spinner_ring__';

interface ISessionStatusInputs {
	readonly status: SessionStatus;
	readonly isRead: boolean;
	readonly isArchived: boolean;
	readonly pullRequestIcon: ThemeIcon | undefined;
}

/**
 * Renders a session's status indicator into a host-provided container and keeps it
 * up to date. In-progress sessions get the standard spinning loading wheel when
 * motion is allowed; needs-input sessions get the animated pixel ring; other
 * states render the codicon from {@link ISessionsListModelService.getStatusIcon}.
 *
 * The widget owns all rendering concerns so every surface (sessions list, session
 * header, …) stays in sync by simply hosting it:
 * - caches the current glyph/variant so re-renders only rebuild the DOM when it
 *   changes (keeping the spinner animation from restarting),
 * - cross-fades between glyphs/variants,
 * - re-renders automatically when the reduced-motion preference changes.
 *
 * Call {@link setStatus} on every status/read/archive change, and {@link reset}
 * to snap (no cross-fade) the next render — e.g. when the host is rebound to a
 * different session.
 */
export class SessionStatusIcon extends Disposable {

	private _currentCacheKey: string | undefined;
	private _lastInputs: ISessionStatusInputs | undefined;

	/** Owns the removal timers for outgoing icons mid cross-fade. */
	private readonly _swapStore = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@ISessionsListModelService private readonly _sessionsListModelService: ISessionsListModelService,
	) {
		super();

		this._register(this._accessibilityService.onDidChangeReducedMotion(() => {
			if (this._lastInputs) {
				this._render(this._lastInputs);
			}
		}));
	}

	/**
	 * Updates the rendered status. Cross-fades when the glyph/variant changes
	 * (after the first render); identical re-renders only refresh the color.
	 */
	setStatus(status: SessionStatus, isRead: boolean, isArchived: boolean, pullRequestIcon?: ThemeIcon): void {
		const inputs: ISessionStatusInputs = { status, isRead, isArchived, pullRequestIcon };
		this._lastInputs = inputs;
		this._render(inputs);
	}

	/**
	 * Clears the cached glyph so the next {@link setStatus} renders without a
	 * cross-fade. Use when the host is rebound to a different session.
	 */
	reset(): void {
		this._currentCacheKey = undefined;
		this._lastInputs = undefined;
		this._swapStore.clear();
		DOM.clearNode(this._container);
	}

	private _render(inputs: ISessionStatusInputs): void {
		const { status, isRead, isArchived, pullRequestIcon } = inputs;
		const isMotionReduced = this._accessibilityService.isMotionReduced();
		const isNeedsInputSpinner = status === SessionStatus.NeedsInput && !isMotionReduced;

		let cacheKey: string;
		let color: string;
		let createIcon: () => HTMLElement;
		if (status === SessionStatus.InProgress) {
			const icon = isMotionReduced ? this._sessionsListModelService.getStatusIcon(status, isRead, isArchived, pullRequestIcon) : ThemeIcon.modify(Codicon.loading, 'spin');
			cacheKey = ThemeIcon.asCSSSelector(icon);
			color = '#FFFFFF';
			createIcon = () => $(`span${cacheKey}`);
		} else if (status === SessionStatus.Completed) {
			const icon = Codicon.circleFilled;
			cacheKey = ThemeIcon.asCSSSelector(icon);
			// Blue calls attention to completed sessions the user has not opened
			// yet; once read the dot settles to a muted grey.
			color = isRead ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-charts-blue, #2F81F7)';
			createIcon = () => $(`span${cacheKey}`);
		} else if (isNeedsInputSpinner) {
			cacheKey = PIXEL_SPINNER_RING_KEY;
			color = asCssVariable('list.warningForeground');
			createIcon = () => createPixelSpinner(undefined, { variant: 'ring' });
		} else {
			const icon = this._sessionsListModelService.getStatusIcon(status, isRead, isArchived, pullRequestIcon);
			cacheKey = ThemeIcon.asCSSSelector(icon);
			color = icon.color ? asCssVariable(icon.color.id) : '';
			createIcon = () => $(`span${cacheKey}`);
		}

		this._container.classList.toggle('session-icon-in-progress', status === SessionStatus.InProgress);
		this._container.classList.toggle('session-icon-completed', status === SessionStatus.Completed);
		this._container.classList.toggle('session-icon-read', isRead);
		this._container.classList.toggle('session-icon-needs-input', status === SessionStatus.NeedsInput);
		this._container.classList.toggle('session-icon-error', status === SessionStatus.Error);
		// Reduced-motion fallback for needs-input pulses the codicon; harmless when a spinner is shown.
		this._container.classList.toggle('session-icon-pulse', status === SessionStatus.NeedsInput);

		if (this._currentCacheKey === cacheKey) {
			this._recolorActiveIcon(color);
			return;
		}

		const animate = this._currentCacheKey !== undefined;
		this._currentCacheKey = cacheKey;
		const iconEl = createIcon();
		iconEl.style.color = color;
		this._swapIcon(iconEl, animate);
	}

	/** Updates the color of the current (non fading-out) icon without rebuilding it. */
	private _recolorActiveIcon(color: string): void {
		for (const child of Array.from(this._container.children) as HTMLElement[]) {
			if (child.dataset[ICON_FADING_OUT_ATTR] !== '1') {
				child.style.color = color;
				break;
			}
		}
	}

	/**
	 * Swaps the container contents to `newChild` with a brief opacity cross-fade.
	 * Outgoing children are taken out of normal flow (`position: absolute`) so the
	 * new child can settle into its slot during the fade. Safe to call repeatedly:
	 * each outgoing element is marked so a follow-up swap never re-processes it.
	 */
	private _swapIcon(newChild: HTMLElement, animate: boolean): void {
		if (!animate) {
			DOM.clearNode(this._container);
			this._container.appendChild(newChild);
			return;
		}
		// Anchor for outgoing icons during the cross-fade: only force a position
		// when the container is not already positioned by its host's CSS (e.g. the
		// sessions list seats this icon with `position: absolute` inside the row —
		// an unconditional inline `relative` would override that and unseat it).
		if (DOM.getWindow(this._container).getComputedStyle(this._container).position === 'static') {
			this._container.style.position = 'relative';
		}
		for (const existing of Array.from(this._container.children) as HTMLElement[]) {
			if (existing.dataset[ICON_FADING_OUT_ATTR] === '1') {
				continue;
			}
			existing.dataset[ICON_FADING_OUT_ATTR] = '1';
			existing.style.position = 'absolute';
			existing.style.top = '0';
			existing.style.left = '0';
			existing.style.transition = `opacity ${ICON_SWAP_FADE_MS}ms ease`;
			DOM.scheduleAtNextAnimationFrame(DOM.getWindow(existing), () => { existing.style.opacity = '0'; });
			disposableTimeout(() => existing.remove(), ICON_SWAP_FADE_MS + 40, this._swapStore);
		}
		newChild.style.opacity = '0';
		newChild.style.transition = `opacity ${ICON_SWAP_FADE_MS}ms ease`;
		this._container.appendChild(newChild);
		DOM.scheduleAtNextAnimationFrame(DOM.getWindow(newChild), () => { newChild.style.opacity = '1'; });
	}
}
