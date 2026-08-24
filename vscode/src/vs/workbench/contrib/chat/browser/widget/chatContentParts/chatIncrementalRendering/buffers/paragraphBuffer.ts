/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIncrementalRenderingBuffer } from './buffer.js';

/**
 * Maximum number of characters that may accumulate beyond the last
 * paragraph boundary before a render is forced.
 */
const MAX_BUFFERED_CHARS = 4000;

/**
 * Finds the last `\n\n` block boundary that is NOT inside an open
 * fenced code block. This prevents splitting a render in the middle
 * of a code fence, which would cause the code block element to update
 * in place (same DOM index) without triggering a new-child animation.
 *
 * The scan counts backtick-fence openings/closings from the start of
 * the string. A `\n\n` is only a valid boundary when the fence depth
 * is 0 (i.e. outside any code block).
 *
 * @internal Exported for testing.
 */
export function lastBlockBoundary(text: string): number {
	const scanner = new IncrementalBlockBoundaryScanner();
	scanner.reset(text);
	return scanner.lastBoundary;
}

/**
 * Stateful scanner for paragraph boundaries outside fenced code blocks.
 *
 * Fence markers can be split across stream updates (for example, a seed ending
 * in `` ` `` followed by an append beginning with `` `` ``). Keeping the short
 * line-start candidate in the state lets each append inspect only its new
 * suffix without rescanning the accumulated response.
 */
class IncrementalBlockBoundaryScanner {
	private _activeFenceChar: '`' | '~' | undefined;
	private _activeFenceLength = 0;
	private _atLineStart = true;
	private _pendingFenceChar: '`' | '~' | undefined;
	private _pendingFenceCount = 0;
	private _previousCharWasNewline = false;
	private _lastBoundary = -1;
	private _length = 0;
	private _scannedCharacterCount = 0;

	get lastBoundary(): number { return this._lastBoundary; }
	get length(): number { return this._length; }
	get scannedCharacterCount(): number { return this._scannedCharacterCount; }

	reset(text: string): void {
		this._activeFenceChar = undefined;
		this._activeFenceLength = 0;
		this._atLineStart = true;
		this._pendingFenceChar = undefined;
		this._pendingFenceCount = 0;
		this._previousCharWasNewline = false;
		this._lastBoundary = -1;
		this._length = 0;
		this.append(text);
	}

	append(text: string): void {
		const baseOffset = this._length;
		for (let index = 0; index < text.length; index++) {
			this.acceptCharacter(text[index], baseOffset + index);
		}
		this._length += text.length;
		this._scannedCharacterCount += text.length;
	}

	private acceptCharacter(character: string, absoluteIndex: number): void {
		if (this._atLineStart && (this._pendingFenceChar || character === '`' || character === '~')) {
			if (!this._pendingFenceChar) {
				this._pendingFenceChar = character as '`' | '~';
				this._pendingFenceCount = 1;
				this._previousCharWasNewline = false;
				return;
			}

			if (character === this._pendingFenceChar) {
				this._pendingFenceCount++;
				this._previousCharWasNewline = false;
				return;
			}

			this.finishPendingFenceRun();
			// A fence run contains no newline, so the current character is no
			// longer at line start and can be processed normally below.
			this._atLineStart = false;
		}

		if (character === '\n') {
			if (!this._activeFenceChar && this._previousCharWasNewline) {
				this._lastBoundary = absoluteIndex - 1;
			}
			this._previousCharWasNewline = true;
			this._atLineStart = true;
		} else {
			this._previousCharWasNewline = false;
			this._atLineStart = false;
		}
	}

	private finishPendingFenceRun(): void {
		const marker = this._pendingFenceChar;
		const length = this._pendingFenceCount;
		this._pendingFenceChar = undefined;
		this._pendingFenceCount = 0;
		if (!marker || length < 3) {
			return;
		}
		if (!this._activeFenceChar) {
			this._activeFenceChar = marker;
			this._activeFenceLength = length;
		} else if (marker === this._activeFenceChar && length >= this._activeFenceLength) {
			this._activeFenceChar = undefined;
			this._activeFenceLength = 0;
		}
	}
}

/**
 * Buffers content at paragraph boundaries (`\n\n` outside code fences).
 * This avoids rendering partially formed blocks — text mid-paragraph,
 * incomplete list groups, or half a code fence.
 */
export class ParagraphBuffer implements IIncrementalRenderingBuffer {
	readonly handlesFlush = false;
	private readonly _scanner = new IncrementalBlockBoundaryScanner();
	private _lastMarkdown = '';

	/** @internal Exposes lexical work for focused performance regression tests. */
	get scannedCharacterCount(): number { return this._scanner.scannedCharacterCount; }

	seed(markdown: string): void {
		this._lastMarkdown = markdown;
		this._scanner.reset(markdown);
	}

	getRenderable(fullMarkdown: string, _lastRendered: string, appendedMarkdown?: string): string {
		const isKnownAppend = appendedMarkdown !== undefined
			&& this._scanner.length + appendedMarkdown.length === fullMarkdown.length;
		if (isKnownAppend) {
			this._scanner.append(appendedMarkdown);
		} else if (fullMarkdown !== this._lastMarkdown) {
			// Standalone callers and rare strategy switches may not supply the
			// append suffix. Reset restores correctness for rewrites without adding
			// prefix validation to the normal streaming hot path.
			this._scanner.reset(fullMarkdown);
		}
		this._lastMarkdown = fullMarkdown;

		const lastBlock = this._scanner.lastBoundary;
		let renderable = lastBlock === -1
			? fullMarkdown   // no paragraph breaks — single block, render as-is
			: fullMarkdown.slice(0, lastBlock + 2);

		// Escape hatch: if too much content has accumulated beyond the
		// last block boundary, render what we have.
		if (fullMarkdown.length - renderable.length > MAX_BUFFERED_CHARS) {
			renderable = fullMarkdown;
		}

		return renderable;
	}
}
