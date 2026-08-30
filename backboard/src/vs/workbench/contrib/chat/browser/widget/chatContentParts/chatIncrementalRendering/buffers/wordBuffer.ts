/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IncrementalWordCounter } from '../../../../../common/model/chatWordCounter.js';
import { IIncrementalRenderingBuffer } from './buffer.js';

/**
 * Minimum reveal rate in words/sec. Ensures content always progresses
 * even when the estimated rate is very low or unknown.
 */
const MIN_RATE = 40;

/**
 * Maximum reveal rate in words/sec. Caps the rate to prevent
 * dumping too much content at once.
 */
const MAX_RATE = 2000;

/**
 * Minimum rate used after the response is complete, to drain
 * buffered content quickly.
 */
const MIN_RATE_AFTER_COMPLETE = 80;

/**
 * Fallback rate when no estimate is available yet.
 */
const DEFAULT_RATE = 8;

const SHORT_RESPONSE_COMMIT_INTERVAL = 50;
const MEDIUM_RESPONSE_COMMIT_INTERVAL = 150;
const LONG_RESPONSE_COMMIT_INTERVAL = 400;

/**
 * Word buffer: drip-feeds words at a rate matching the model's
 * token production speed, similar to the original 50ms progressive
 * render but driven by rAF for smoother output.
 *
 * The reveal rate is set externally via {@link setRate} from the
 * model's `impliedWordLoadRate` estimate. Words are revealed based
 * on elapsed time since the last render, so the output speed
 * naturally matches the model's generation speed.
 */
export class WordBuffer implements IIncrementalRenderingBuffer {
	readonly handlesFlush = true;

	/** The full markdown received so far. */
	private _fullMarkdown: string = '';

	/** Number of words currently revealed to the DOM. */
	private _revealedWordCount: number = 0;

	/** The markdown string last committed to the DOM. */
	private _lastCommittedMarkdown: string = '';

	/** Whether there are still unrevealed words to show. */
	private _needsNextFrame: boolean = false;
	private _nextRenderDelay: number = 0;

	/** Timestamp of the last successful commit. */
	private _lastCommitTime: number = 0;

	/** Estimated word production rate (words/sec). */
	private _rate: number = DEFAULT_RATE;
	private _isComplete: boolean = false;
	private readonly _wordCounter = new IncrementalWordCounter();

	get needsNextFrame(): boolean {
		return this._needsNextFrame;
	}

	get nextRenderDelay(): number {
		return this._nextRenderDelay;
	}

	seed(markdown: string): void {
		this._fullMarkdown = markdown;
		this._wordCounter.update(markdown, false, true);
		this._revealedWordCount = this._wordCounter.getNWords(Number.MAX_SAFE_INTEGER).totalWordCount;
		this._lastCommittedMarkdown = markdown;
		this._lastCommitTime = markdown.length > 0 ? Date.now() : 0;
		this._needsNextFrame = false;
		this._nextRenderDelay = 0;
		this._isComplete = false;
	}

	/**
	 * Set the estimated word production rate from the model's
	 * `impliedWordLoadRate`. Called by the orchestrator.
	 */
	setRate(rate: number | undefined, isComplete: boolean): void {
		this._isComplete = isComplete;
		if (isComplete) {
			this._rate = typeof rate === 'number'
				? Math.max(rate, MIN_RATE_AFTER_COMPLETE)
				: MIN_RATE_AFTER_COMPLETE;
		} else {
			this._rate = typeof rate === 'number'
				? Math.min(Math.max(rate, MIN_RATE), MAX_RATE)
				: DEFAULT_RATE;
		}
	}

	getRenderable(fullMarkdown: string, _lastRendered: string): string {
		this._fullMarkdown = fullMarkdown;
		return fullMarkdown;
	}

	filterFlush(markdown: string): string | undefined {
		this._fullMarkdown = markdown;
		this._wordCounter.update(markdown, !this._isComplete, this._isComplete);

		if (this._isComplete) {
			this._needsNextFrame = false;
			this._nextRenderDelay = 0;
			this._lastCommittedMarkdown = markdown;
			this._revealedWordCount = this._wordCounter.getNWords(Number.MAX_SAFE_INTEGER).totalWordCount;
			return markdown;
		}

		const now = Date.now();
		if (this._lastCommitTime === 0) {
			// First frame — reveal 1 word to get started.
			this._lastCommitTime = now;
			this._revealedWordCount = 1;
		} else {
			// Compute how many words to reveal based on elapsed time
			// and the estimated rate, matching the original approach.
			const elapsed = now - this._lastCommitTime;
			const commitInterval = markdown.length >= 50_000
				? LONG_RESPONSE_COMMIT_INTERVAL
				: markdown.length >= 15_000 ? MEDIUM_RESPONSE_COMMIT_INTERVAL : SHORT_RESPONSE_COMMIT_INTERVAL;
			if (elapsed < commitInterval) {
				this._needsNextFrame = true;
				this._nextRenderDelay = commitInterval - elapsed;
				return undefined;
			}
			const newWords = Math.floor(elapsed / 1000 * this._rate);
			if (newWords > 0) {
				this._revealedWordCount += newWords;
				this._lastCommitTime = now;
			}
		}

		const result = this._wordCounter.getNWords(this._revealedWordCount);

		if (result.isFullString) {
			this._needsNextFrame = false;
			this._nextRenderDelay = 0;
			// Reset to the actual word count so that when new tokens
			// arrive, drip-feeding resumes from the correct position
			// instead of instantly dumping everything.
			this._revealedWordCount = result.returnedWordCount;
			this._lastCommittedMarkdown = this._fullMarkdown;
			return this._fullMarkdown;
		}

		this._needsNextFrame = true;
		const commitInterval = markdown.length >= 50_000
			? LONG_RESPONSE_COMMIT_INTERVAL
			: markdown.length >= 15_000 ? MEDIUM_RESPONSE_COMMIT_INTERVAL : SHORT_RESPONSE_COMMIT_INTERVAL;
		this._nextRenderDelay = Math.max(commitInterval, Math.ceil(1000 / Math.max(this._rate, 1)));

		if (result.value.length <= this._lastCommittedMarkdown.length) {
			return undefined;
		}

		this._lastCommittedMarkdown = result.value;
		return result.value;
	}
}
