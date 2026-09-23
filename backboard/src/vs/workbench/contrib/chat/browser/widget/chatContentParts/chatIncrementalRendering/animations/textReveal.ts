/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Class applied to each freshly revealed word (or widget) while it fades in. */
export const STREAM_WORD_CLASS_NAME = 'chat-stream-word';

/**
 * The reveal clock's three tuning values.
 *
 * STREAM_WORD_FADE_MS: how long each word takes to settle in. Must match
 * `chatStreamWordIn` in CSS.
 *
 * TARGET_LAG_MS: how far the visible frontier trails the committed text in
 * steady state. This buffer absorbs network jitter: pauses between deltas
 * shorter than it never stall the typing.
 *
 * RATE_GAIN: how strongly the typing speed corrects toward TARGET_LAG_MS.
 * The frontier types at the measured input rate, sped up while it trails by
 * more than the target and slowed down while it is closer, so speed changes
 * are proportional and gradual rather than jumping with each burst.
 */
export const STREAM_WORD_FADE_MS = 320;
const TARGET_LAG_MS = 600;
const RATE_GAIN = 0.5;

/** Bounds on the correction factor applied to the input rate. */
const MIN_RATE_FACTOR = 0.35;
const MAX_RATE_FACTOR = 2.5;

/** Hard bound on the frontier's lag; beyond it the typing compresses to catch up. */
const MAX_LAG_MS = 1200;

/** Floor for the reveal rate in characters per millisecond (~60 chars/s). */
const MIN_RATE = 0.06;

/** Window over which the input rate is measured. */
const INPUT_RATE_WINDOW_MS = 1000;
/** Smallest time span the input rate is measured over, so the first commit is not read as a burst. */
const MIN_INPUT_RATE_SPAN_MS = 120;

/**
 * Subtrees whose text is never split into word spans: structured widgets
 * (code blocks, math, inline anchors) own their DOM, and the long-response
 * plaintext node is appended to in place and must stay a single text node.
 */
const SKIP_SELECTOR = [
	'pre',
	'svg',
	'.monaco-editor',
	'.interactive-result-code-block',
	'.chat-codeblock-pill-widget',
	'.chat-inline-anchor-widget',
	'.chat-markdown-streaming-plaintext',
	'.katex',
	'.katex-display',
].join(',');

/**
 * Skipped widgets that fade in as a unit when the frontier reaches them, so a
 * code block or file pill never appears ahead of the sentence before it.
 */
const FADE_AS_UNIT_SELECTOR = [
	'pre',
	'.interactive-result-code-block',
	'.chat-codeblock-pill-widget',
	'.chat-inline-anchor-widget',
	'.katex',
	'.katex-display',
].join(',');

interface IRevealRange {
	readonly start: number;
	readonly end: number;
	readonly time: number;
	readonly spread: number;
}

interface ITextNodeSpan {
	readonly node: Text;
	readonly start: number;
}

interface IUnitSpan {
	readonly element: HTMLElement;
	readonly start: number;
}

function collectRevealTargets(root: HTMLElement): { nodes: ITextNodeSpan[]; units: IUnitSpan[]; length: number } {
	const doc = root.ownerDocument;
	const nodes: ITextNodeSpan[] = [];
	const units: IUnitSpan[] = [];
	let length = 0;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const element = node as HTMLElement;
				if (!element.matches(SKIP_SELECTOR)) {
					return NodeFilter.FILTER_SKIP;
				}
				if (element.matches(FADE_AS_UNIT_SELECTOR)) {
					units.push({ element, start: length });
				}
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		}
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text;
		if (text.data.length === 0) {
			continue;
		}
		nodes.push({ node: text, start: length });
		length += text.data.length;
	}
	return { nodes, units, length };
}

/**
 * Word-level "typing" reveal for streamed markdown.
 *
 * The incremental renderer rebuilds the markdown DOM on every commit. After
 * each render this wraps the text that is still settling in per-word spans,
 * each with a fade whose start time comes from a reveal clock: the frontier
 * advances at a smoothed characters-per-second rate that follows the stream
 * while holding a small lag, so neither commit cadence nor network jitter
 * shows up as lurching or stalling.
 *
 * Reveal times are keyed on text offsets rather than DOM nodes, so when the
 * next commit rebuilds the DOM, words that are mid-fade are re-wrapped with a
 * negative delay and continue their animation; words not yet due get a
 * positive delay and stay hidden until the frontier reaches them.
 */
export class StreamingTextReveal {

	private _ranges: IRevealRange[] = [];
	private _revealedLength = 0;
	/** Time at which the last scheduled character becomes visible. */
	private _scheduledEnd = 0;
	/** Recent (time, committed length) samples for measuring the input rate. */
	private _inputSamples: { readonly time: number; readonly length: number }[] = [];

	constructor(private readonly _domNode: HTMLElement) { }

	/**
	 * Treat everything currently in the DOM as already visible.
	 */
	markAllRevealed(): void {
		this._ranges = [];
		this._revealedLength = collectRevealTargets(this._domNode).length;
		this._scheduledEnd = 0;
		this._inputSamples = [];
	}

	/**
	 * Called right after the markdown DOM was (re)built.
	 */
	onDidRender(now = performance.now()): void {
		const { nodes, units, length } = collectRevealTargets(this._domNode);

		if (length < this._revealedLength) {
			// Incomplete-token fill-in can briefly render trailing markers
			// that later collapse. Clamp to what is actually there.
			this._ranges = this._ranges
				.filter(range => range.start < length)
				.map(range => range.end > length ? { ...range, end: length } : range);
		} else if (length > this._revealedLength) {
			this._schedule(this._revealedLength, length, now);
		}
		this._revealedLength = length;

		this._ranges = this._ranges.filter(range => range.time + range.spread + STREAM_WORD_FADE_MS > now);
		if (this._ranges.length === 0) {
			return;
		}

		this._wrapText(nodes, now);
		this._fadeUnits(units, now);
	}

	/**
	 * Schedules newly committed characters on the reveal clock, continuing
	 * from wherever previously scheduled text ends.
	 */
	private _schedule(start: number, end: number, now: number): void {
		const count = end - start;
		const inputRate = this._measureInputRate(end, now);
		const startTime = Math.max(now, this._scheduledEnd);
		const lag = startTime - now;
		const factor = Math.min(Math.max(1 + RATE_GAIN * (lag - TARGET_LAG_MS) / TARGET_LAG_MS, MIN_RATE_FACTOR), MAX_RATE_FACTOR);
		let duration = count / Math.max(inputRate * factor, MIN_RATE);
		if (startTime + duration - now > MAX_LAG_MS) {
			duration = Math.max(now + MAX_LAG_MS - startTime, 0);
		}
		this._ranges.push({ start, end, time: startTime, spread: duration });
		this._scheduledEnd = startTime + duration;
	}

	private _measureInputRate(length: number, now: number): number {
		this._inputSamples.push({ time: now, length });
		while (this._inputSamples.length > 2 && now - this._inputSamples[1].time >= INPUT_RATE_WINDOW_MS) {
			this._inputSamples.shift();
		}
		const oldest = this._inputSamples[0];
		const previousLength = this._inputSamples.length > 1 ? oldest.length : this._revealedLength;
		const span = Math.max(now - oldest.time, MIN_INPUT_RATE_SPAN_MS);
		return (length - previousLength) / span;
	}

	private _revealTimeAt(offset: number): number | undefined {
		for (let i = 0; i < this._ranges.length; i++) {
			const range = this._ranges[i];
			const isLast = i === this._ranges.length - 1;
			if (offset >= range.start && (offset < range.end || isLast && offset === range.end)) {
				const fraction = range.end > range.start ? (offset - range.start) / (range.end - range.start) : 0;
				return range.time + fraction * range.spread;
			}
		}
		return undefined;
	}

	private _delayAt(offset: number, now: number): number | undefined {
		const revealTime = this._revealTimeAt(offset);
		if (revealTime === undefined || revealTime - now <= -STREAM_WORD_FADE_MS) {
			return undefined;
		}
		return revealTime - now;
	}

	private _wrapText(nodes: readonly ITextNodeSpan[], now: number): void {
		const firstOffset = this._ranges[0].start;
		const doc = this._domNode.ownerDocument;

		for (const { node, start } of nodes) {
			const text = node.data;
			if (start + text.length <= firstOffset) {
				continue;
			}

			const localFrom = Math.max(0, firstOffset - start);
			let fragment: DocumentFragment | undefined;
			let plain = text.slice(0, localFrom);

			// Each token is a word plus its trailing whitespace, so spaces fade
			// with the word they follow and never leave a gap mid-line.
			const tokenPattern = /\s*\S+\s*|\s+/g;
			tokenPattern.lastIndex = localFrom;
			for (let match = tokenPattern.exec(text); match; match = tokenPattern.exec(text)) {
				const delay = this._delayAt(start + match.index, now);
				if (delay === undefined) {
					plain += match[0];
					continue;
				}
				fragment ??= doc.createDocumentFragment();
				if (plain) {
					fragment.appendChild(doc.createTextNode(plain));
					plain = '';
				}
				const span = doc.createElement('span');
				span.className = STREAM_WORD_CLASS_NAME;
				span.style.animationDelay = `${Math.round(delay)}ms`;
				span.textContent = match[0];
				fragment.appendChild(span);
			}

			if (!fragment) {
				continue;
			}
			if (plain) {
				fragment.appendChild(doc.createTextNode(plain));
			}
			node.replaceWith(fragment);
		}
	}

	private _fadeUnits(units: readonly IUnitSpan[], now: number): void {
		for (const { element, start } of units) {
			const delay = this._delayAt(start, now);
			if (delay === undefined) {
				continue;
			}
			element.classList.add(STREAM_WORD_CLASS_NAME);
			element.style.animationDelay = `${Math.round(delay)}ms`;
		}
	}
}
