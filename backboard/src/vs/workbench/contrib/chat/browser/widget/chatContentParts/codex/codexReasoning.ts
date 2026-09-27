/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode } from '../../../../../../../base/browser/dom.js';
import { IRenderedMarkdown } from '../../../../../../../base/browser/markdownRenderer.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { StreamingTextReveal } from '../chatIncrementalRendering/animations/textReveal.js';
import { animateCodexBody, applyCodexRoot, CodexCadencedShimmer, codexNestedScroll, codexRowChevron, collapseCodexBodyInstantly, cxEl, setCodexChevronOpen } from './codexDom.js';

/** A first render longer than this is text the reader already saw stream (the item was re-created). */
const INSTANT_FIRST_RENDER_CHARS = 240;

/**
 * A section that finishes within this long of opening was never really read
 * open (a turn rebuilt in one pass opens and finishes every section at once),
 * so it closes without the collapse animation.
 */
const ANIMATED_CLOSE_MIN_OPEN_MS = 150;

/** Renders reasoning markdown, reusing `target` when the new text extends the previous render. */
export type CodexMarkdownRenderer = (markdown: string, target: HTMLElement | undefined) => IRenderedMarkdown;

/** Codex's elapsed formatter (SPEC §0.3): `45s`, `11m 36s`, `1h 2m 5s`; under a second is not shown. */
export function formatCodexElapsed(ms: number): string | undefined {
	const total = Math.floor(ms / 1000);
	if (total < 1) {
		return undefined;
	}
	const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
	return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Drops the leading `**Heading**` line Codex strips from a reasoning summary. */
export function stripCodexReasoningTitle(text: string): string {
	return text.replace(/^\s*\*\*[^*\n]+\*\*[ \t]*(\r?\n|$)/, '').trim();
}

/**
 * Codex's visible reasoning item (`Rx`, SPEC §2.9): `Thinking` in the cadenced
 * shimmer while it streams with the text open beneath it (bounded, tail
 * following), then — the moment the section ends — `Thought for 12s` with the
 * text folded away (SPEC §345: "auto-open while streaming, collapsed after").
 * A manual open or close is respected. Rebuilt from history it reads
 * `Thought` and starts collapsed.
 */
export class CodexReasoningItem extends Disposable {
	readonly element: HTMLElement;

	private text = '';
	private streaming: boolean;
	private expanded: boolean;
	/** Once the user opens or closes the item, automatic opening and closing leave it alone. */
	private userToggled = false;
	/** When the body last opened automatically; decides whether the close animates. */
	private openedAt = 0;
	private finishedAt: number | undefined;
	private readonly startedAt = Date.now();
	private renderedText: string | undefined;
	private followTail = true;

	private readonly toggle: HTMLButtonElement;
	private readonly label: HTMLElement;
	private readonly chevron: SVGSVGElement;
	private readonly body: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly markdownHost: HTMLElement;
	private readonly markdown = this._register(new MutableDisposable<IRenderedMarkdown>());
	/** The answer's word-level reveal clock, so reasoning types in as smoothly as the reply. */
	private readonly reveal: StreamingTextReveal;
	private readonly shimmer = this._register(new MutableDisposable<CodexCadencedShimmer>());
	private readonly bodyAnimation = this._register(new MutableDisposable<IDisposable>());

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	constructor(private readonly renderMarkdown: CodexMarkdownRenderer, live: boolean) {
		super();
		this.streaming = live;
		this.expanded = false;
		this.element = applyCodexRoot(cxEl('div', 'min-w-0 text-size-chat relative overflow-visible py-0 cx-reasoning'));
		const column = cxEl('div', 'flex min-w-0 flex-col relative overflow-clip');
		const header = cxEl('div', 'group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1 self-start');
		this.toggle = cxEl('button', 'absolute inset-0 cursor-interaction rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset');
		this.toggle.type = 'button';
		this.toggle.setAttribute('aria-expanded', 'false');
		const line = cxEl('span', 'inline-flex min-w-0 gap-1.5 items-center pointer-events-none relative shrink truncate text-size-chat');
		this.label = cxEl('span', 'text-text/30 text-size-chat truncate group-hover/activity-header:text-default');
		line.appendChild(this.label);
		const chevronSlot = cxEl('span', 'pointer-events-none relative flex');
		this.chevron = codexRowChevron();
		chevronSlot.appendChild(this.chevron);
		header.append(this.toggle, line, chevronSlot);

		this.body = cxEl('div', 'overflow-hidden');
		collapseCodexBodyInstantly(this.body, false);
		const inner = cxEl('div', 'pt-1 pb-1');
		this.scroller = cxEl('div', 'max-h-[8.75rem] overflow-y-auto vertical-scroll-fade-mask [--edge-fade-distance:1rem] cx-reasoning-scroll');
		this.markdownHost = cxEl('div', 'text-text/60 [&_*]:text-text/50 break-words text-size-chat cx-reasoning-markdown');
		this.scroller.appendChild(this.markdownHost);
		this.reveal = new StreamingTextReveal(this.markdownHost);
		inner.appendChild(this.scroller);
		this.body.appendChild(inner);
		column.append(header, this.body);
		this.element.appendChild(column);

		this._register(codexNestedScroll(this.scroller));
		this.scroller.addEventListener('scroll', () => {
			this.followTail = this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop <= 8;
		});
		this.toggle.addEventListener('click', () => {
			this.userToggled = true;
			this.setExpanded(!this.expanded, true);
		});
		this.renderLabel();
		this.syncVisibility();
	}

	get isEmpty(): boolean {
		return !stripCodexReasoningTitle(this.text);
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	update(text: string): void {
		if (text === this.text) {
			return;
		}
		const wasEmpty = this.isEmpty;
		this.text = text;
		this.syncVisibility();
		// Auto-open while streaming once there is something to read.
		if (this.streaming && wasEmpty && !this.isEmpty && !this.userToggled) {
			this.openedAt = Date.now();
			this.setExpanded(true, false);
		} else if (this.expanded) {
			this.renderBody();
		}
		this._onDidChangeHeight.fire();
	}

	/**
	 * The section stopped streaming (the next tool row, commentary, reasoning
	 * section or the end of the turn arrived): its label settles to
	 * `Thought for 12s` and the body folds away with the Codex expand motion,
	 * unless the user opened or closed it by hand. The fold fires
	 * `onDidChangeHeight` so the list relayouts; the row's ResizeObserver
	 * follows the animation itself.
	 */
	finish(): void {
		if (!this.streaming) {
			return;
		}
		this.streaming = false;
		this.finishedAt = Date.now();
		this.renderLabel();
		this.syncVisibility();
		if (this.expanded && !this.userToggled) {
			const readOpen = this.element.isConnected && this.finishedAt - this.openedAt >= ANIMATED_CLOSE_MIN_OPEN_MS;
			this.setExpanded(false, readOpen);
		}
	}

	private syncVisibility(): void {
		this.element.hidden = this.isEmpty;
		this.element.toggleAttribute('data-live', this.streaming && !this.isEmpty);
	}

	private renderLabel(): void {
		clearNode(this.label);
		let text: string;
		if (this.streaming) {
			text = localize('codex.reasoning.thinking', "Thinking");
			const shimmer = new CodexCadencedShimmer(text, 'min-w-0 truncate');
			this.shimmer.value = shimmer;
			this.label.appendChild(shimmer.element);
		} else {
			this.shimmer.clear();
			// History never has a client-measured duration; Codex shows plain `Thought` there.
			const elapsed = this.finishedAt !== undefined ? formatCodexElapsed(this.finishedAt - this.startedAt) : undefined;
			text = elapsed
				? localize('codex.reasoning.thoughtFor', "Thought for {0}", elapsed)
				: localize('codex.reasoning.thought', "Thought");
			this.label.textContent = text;
		}
		this.toggle.setAttribute('aria-label', text);
	}

	private setExpanded(expanded: boolean, animate: boolean): void {
		if (expanded) {
			this.renderBody();
		}
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.toggle.setAttribute('aria-expanded', String(expanded));
		setCodexChevronOpen(this.chevron, expanded);
		if (animate) {
			this.bodyAnimation.value = animateCodexBody(this.body, expanded);
		} else {
			collapseCodexBodyInstantly(this.body, expanded);
		}
		this._onDidChangeHeight.fire();
	}

	private renderBody(): void {
		const text = stripCodexReasoningTitle(this.text);
		if (text === this.renderedText) {
			return;
		}
		const firstRender = this.renderedText === undefined;
		const canReuse = !!this.markdown.value && !firstRender && text.startsWith(this.renderedText!);
		const target = canReuse ? this.markdown.value!.element : undefined;
		this.markdown.value = this.renderMarkdown(text, target);
		if (!target) {
			clearNode(this.markdownHost);
			this.markdownHost.appendChild(this.markdown.value.element);
		}
		// Only new text types in: finished reasoning, and text already streamed
		// before this item was (re)created, appear at once.
		if (this.streaming && !(firstRender && text.length > INSTANT_FIRST_RENDER_CHARS)) {
			this.reveal.onDidRender();
		} else {
			this.reveal.markAllRevealed();
		}
		this.renderedText = text;
		if (this.streaming && this.followTail) {
			this.scroller.scrollTop = this.scroller.scrollHeight;
		}
	}
}
