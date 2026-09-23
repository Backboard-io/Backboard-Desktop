/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventHelper, getWindow } from '../../../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { CodexIconName, CodexIcons, ICodexIcon } from './codexIcons.js';

/**
 * DOM builders for the Codex transcript presentation. Every element carries the
 * Codex desktop app's own class names (Tailwind + CSS modules), styled by the
 * scoped Codex stylesheet under `.cx-pf`. Markup mirrors the captured app
 * (see the Codex capture's `fragments/` and `SPEC-components.md`).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an element with a raw class list (Tailwind names are not valid `$()` selectors). */
export function cxEl<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
	const element = mainWindow.document.createElement(tag);
	if (className) {
		element.className = className;
	}
	return element;
}


/** Codex motion constants (SPEC §0.2). */
export const CodexMotion = {
	/** Activity row / group expand: .3s [.19,1,.22,1]. */
	expand: { duration: 300, easing: 'cubic-bezier(.19,1,.22,1)' },
	/** Fold body enter: .22s [.33,1,.68,1]. */
	foldEnter: { duration: 220, easing: 'cubic-bezier(.33,1,.68,1)' },
	/** Fold body exit: .15s [.23,1,.32,1]. */
	foldExit: { duration: 150, easing: 'cubic-bezier(.23,1,.32,1)' },
} as const;

function prefersReducedMotion(element: HTMLElement): boolean {
	return !!element.closest('.monaco-reduce-motion') || getWindow(element).matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Marks an element as the root of a Codex-styled subtree: the scoped Codex CSS
 * (resets, tokens, utilities) applies only inside `.cx-pf` roots.
 */
export function applyCodexRoot(element: HTMLElement): HTMLElement {
	element.classList.add('cx-pf');
	const workbench = mainWindow.document.querySelector('.monaco-workbench');
	const light = !!workbench && (workbench.classList.contains('vs') || workbench.classList.contains('hc-light'));
	element.dataset.theme = light ? 'light' : 'dark';
	element.setAttribute('data-codex-window-type', 'electron');
	return element;
}

export function codexIcon(name: CodexIconName, className = 'shrink-0 text-text/60', size?: number): SVGSVGElement {
	const icon: ICodexIcon = CodexIcons[name];
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	const [, , width, height] = icon.viewBox.split(' ');
	svg.setAttribute('viewBox', icon.viewBox);
	svg.setAttribute('width', String(size ?? width));
	svg.setAttribute('height', String(size ?? height));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('class', className);
	for (const p of icon.paths) {
		const path = mainWindow.document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', p.d);
		path.setAttribute('fill', 'currentColor');
		if (p.evenodd) {
			path.setAttribute('fill-rule', 'evenodd');
			path.setAttribute('clip-rule', 'evenodd');
		}
		svg.appendChild(path);
	}
	return svg;
}

/** The disclosure chevron (`kMi`): hidden at rest, fades in on row hover, rotates 90° when open. */
export function codexRowChevron(): SVGSVGElement {
	return codexIcon('rowChevron', 'icon-2xs shrink-0 text-text/60 opacity-0 group-focus-visible/activity-header:opacity-100 group-focus-visible/activity-header:text-default group-has-[:focus-visible]/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:text-default transition-transform duration-relaxed [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:opacity-100');
}

export function setCodexChevronOpen(chevron: SVGSVGElement, open: boolean): void {
	chevron.classList.toggle('rotate-90', open);
	chevron.classList.toggle('opacity-100', open);
}

/** 16px vertical spacer (`JMi`); `grouped` gives the 4px in-group pitch. */
export function codexGap(grouped = false): HTMLElement {
	const gap = cxEl('div', 'w-full');
	gap.setAttribute('aria-hidden', 'true');
	gap.style.height = grouped ? 'var(--conversation-grouped-item-gap, 4px)' : 'var(--conversation-item-gap, 16px)';
	return gap;
}

/**
 * Codex's cadenced shimmer (SPEC §0.2): dim text with a highlight band that
 * sweeps once after 600ms and then once every 4s, each sweep lasting 1s.
 */
export class CodexCadencedShimmer extends Disposable {
	readonly element: HTMLElement;
	private readonly text: Text;
	private readonly highlightText: Text;
	private sweepTimer: number | undefined;

	constructor(text: string, className = '') {
		super();
		this.element = cxEl('span', 'relative inline-block align-top _cadencedShimmer_py5xu_2');
		if (className) {
			this.element.className += ` ${className}`;
		}
		this.text = mainWindow.document.createTextNode(text);
		this.highlightText = mainWindow.document.createTextNode(text);
		const sweep = cxEl('span', '_cadencedShimmerSweep_py5xu_35');
		sweep.setAttribute('aria-hidden', 'true');
		const highlight = cxEl('span', '_cadencedShimmerHighlight_py5xu_30');
		highlight.appendChild(this.highlightText);
		sweep.appendChild(highlight);
		this.element.append(this.text, sweep);

		const win = mainWindow;
		const sweepOnce = () => {
			this.element.classList.add('_cadencedShimmerActive_py5xu_71');
			this.sweepTimer = win.setTimeout(() => this.element.classList.remove('_cadencedShimmerActive_py5xu_71'), 1000);
		};
		const first = win.setTimeout(sweepOnce, 600);
		const cadence = win.setInterval(sweepOnce, 4000);
		this._register(toDisposable(() => {
			win.clearTimeout(first);
			win.clearInterval(cadence);
			if (this.sweepTimer !== undefined) {
				win.clearTimeout(this.sweepTimer);
			}
		}));
	}

	setText(text: string): void {
		this.text.data = text;
		this.highlightText.data = text;
	}
}

/**
 * Animates a Codex collapsible body between `height: 0; opacity: 0` and its
 * natural height, then leaves it at `auto` (overflow visible) when open.
 */
export function animateCodexBody(body: HTMLElement, open: boolean, motion: { duration: number; easing: string } = CodexMotion.expand, translate = false): IDisposable {
	const reduced = prefersReducedMotion(body);
	body.getAnimations().forEach(a => a.cancel());
	body.style.pointerEvents = open ? 'auto' : 'none';
	if (reduced) {
		body.style.height = open ? 'auto' : '0px';
		body.style.opacity = open ? '1' : '0';
		body.style.overflow = open ? 'visible' : 'hidden';
		return { dispose: () => { } };
	}
	body.style.overflow = 'hidden';
	const from = body.getBoundingClientRect().height;
	body.style.height = 'auto';
	const to = open ? body.scrollHeight : 0;
	body.style.height = `${from}px`;
	const frames: Keyframe[] = [
		{ height: `${from}px`, opacity: open ? 0 : 1, transform: translate ? (open ? 'translateY(-8px)' : 'translateY(0)') : 'none' },
		{ height: `${to}px`, opacity: open ? 1 : 0, transform: translate ? (open ? 'translateY(0)' : 'translateY(-8px)') : 'none' },
	];
	const animation = body.animate(frames, { duration: motion.duration, easing: motion.easing, fill: 'forwards' });
	animation.onfinish = () => {
		animation.cancel();
		body.style.height = open ? 'auto' : '0px';
		body.style.opacity = open ? '1' : '0';
		body.style.overflow = open ? 'visible' : 'hidden';
	};
	// Plain object, not `toDisposable`: fire-and-forget animations must not be
	// reported as leaked disposables.
	return { dispose: () => animation.cancel() };
}

/**
 * Lets a bounded Codex scroller (group body, shell output) scroll inside the
 * chat list, whose scrollable element otherwise takes every wheel event. Once
 * the scroller reaches an edge the gesture continues to the transcript. With
 * `scrollerSelector` the scroller is the matching ancestor of the wheel target
 * inside `container` (for native bodies that mount their scroller lazily).
 */
export function codexNestedScroll(container: HTMLElement, scrollerSelector?: string): IDisposable {
	return addDisposableListener(container, 'wheel', (event: WheelEvent) => {
		const scroller = scrollerSelector ? (event.target as Element | null)?.closest<HTMLElement>(scrollerSelector) : container;
		if (!scroller || !container.contains(scroller) || event.deltaY === 0) {
			return;
		}
		const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
			? 20
			: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? scroller.clientHeight
				: 1;
		const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		// `flex-col-reverse` scrollers (bottom-pinned output) run scrollTop from 0 down to -max.
		const reversed = getWindow(scroller).getComputedStyle(scroller).flexDirection === 'column-reverse';
		const min = reversed ? -maxScrollTop : 0;
		const max = reversed ? 0 : maxScrollTop;
		const next = Math.min(max, Math.max(min, scroller.scrollTop + event.deltaY * deltaScale));
		if (next === scroller.scrollTop) {
			return;
		}
		EventHelper.stop(event, true);
		scroller.scrollTop = next;
	}, { passive: false });
}

/** Initial collapsed style for a Codex collapsible body. */
export function collapseCodexBodyInstantly(body: HTMLElement, open: boolean): void {
	body.style.height = open ? 'auto' : '0px';
	body.style.opacity = open ? '1' : '0';
	body.style.overflow = open ? 'visible' : 'hidden';
	body.style.pointerEvents = open ? 'auto' : 'none';
}

export interface ICodexRowLabel {
	/** Leading verb (Read, Searched, Ran …), rendered inside the label. */
	readonly verb?: string;
	/** Plain text after the verb. */
	readonly text?: string;
	/** A file name rendered as Codex's dotted-underline file link. */
	readonly file?: { readonly label: string; readonly title?: string; readonly onClick?: () => void };
	/** Text after the file link. */
	readonly suffix?: string;
}

/**
 * How Codex styles a row label: `read` dims the file link (read, search, list
 * rows), `edit` is the edited-file row's verb + link, `plain` is everything else.
 */
export type CodexRowLabelVariant = 'read' | 'edit' | 'plain';

const HOVER_DEFAULT = '[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:text-default';

/**
 * The label span content of a finished activity row, e.g. `Read <link>`,
 * `Ran git status`, `Edited <link>`.
 */
export function renderCodexRowLabel(label: ICodexRowLabel, variant: CodexRowLabelVariant): HTMLElement {
	let outer: HTMLElement;
	let inner: HTMLElement;
	if (variant === 'read') {
		outer = cxEl('span', `inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-text/40 ${HOVER_DEFAULT} [&_*]:text-text/30 [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[&_*]:text-default`);
		inner = cxEl('span', 'min-w-0 truncate');
		outer.appendChild(inner);
	} else if (variant === 'edit') {
		outer = inner = cxEl('span', 'contents');
	} else {
		outer = inner = cxEl('span', 'min-w-0 truncate text-text/40 group-hover/activity-header:text-default');
	}
	if (label.verb) {
		const verb = cxEl('span', variant === 'edit' ? `text-codex-description/80 select-text ${HOVER_DEFAULT}` : 'text-text-tertiary/90');
		verb.textContent = label.verb;
		inner.append(verb, ' ');
	}
	if (label.text) {
		inner.append(label.text);
	}
	if (label.file) {
		if (label.text) {
			inner.append(' ');
		}
		const link = cxEl('button', 'no-drag cursor-interaction items-center select-none border gap-1 whitespace-nowrap flex rounded-md text-tertiary not-disabled:not-aria-disabled:hover:text-default border-transparent border-0 p-0 pointer-events-auto relative inline-flex max-w-full truncate align-bottom underline decoration-dotted decoration-[0.5px] underline-offset-2');
		link.setAttribute('type', 'button');
		link.setAttribute('data-agent-activity-file-link', 'true');
		link.setAttribute('role', 'link');
		link.textContent = label.file.label;
		if (label.file.title) {
			link.title = label.file.title;
		}
		const onClick = label.file.onClick;
		if (onClick) {
			link.addEventListener('click', e => { e.stopPropagation(); onClick(); });
		}
		const linkSlot = cxEl('span', 'contents');
		linkSlot.appendChild(link);
		inner.appendChild(linkSlot);
	}
	if (label.suffix) {
		inner.append(label.suffix);
	}
	return outer;
}

/** `+N -M` accessory (colored only on row hover). */
export function renderCodexDiffStats(added: number, removed: number, colored = false): HTMLElement {
	const stats = cxEl('span', 'inline-flex items-center gap-1 leading-none disambiguated-digits tabular-nums tracking-tight text-size-chat-sm');
	stats.setAttribute('data-thread-find-skip', 'true');
	const add = cxEl('span', colored ? 'flex shrink-0 items-center text-codex-git-added' : 'flex shrink-0 items-center [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:text-codex-git-added');
	add.textContent = `+${added}`;
	const del = cxEl('span', colored ? 'flex shrink-0 items-center text-codex-git-deleted' : 'flex shrink-0 items-center [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:text-codex-git-deleted');
	del.textContent = `-${removed}`;
	stats.append(add, del);
	return stats;
}
