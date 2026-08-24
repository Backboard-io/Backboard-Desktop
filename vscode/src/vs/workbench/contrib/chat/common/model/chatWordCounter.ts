/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as markedKatexExtension from '../../../markdown/common/markedKatexExtension.js';

export interface IWordCountResult {
	value: string;
	returnedWordCount: number;
	totalWordCount: number;
	isFullString: boolean;
}

const r = String.raw;

/**
 * Matches `[text](link title?)` or `[text](<link> title?)`
 *
 * Taken from vscode-markdown-languageservice
 */
const linkPattern =
	r`(?<!\\)` + // Must not start with escape

	// text
	r`(!?\[` + // open prefix match -->
	/**/r`(?:` +
	/*****/r`[^\[\]\\]|` + // Non-bracket chars, or...
	/*****/r`\\.|` + // Escaped char, or...
	/*****/r`\[[^\[\]]*\]` + // Matched bracket pair
	/**/r`)*` +
	r`\])` + // <-- close prefix match

	// Destination
	r`(\(\s*)` + // Pre href
	/**/r`(` +
	/*****/r`[^\s\(\)<](?:[^\s\(\)]|\([^\s\(\)]*?\))*|` + // Link without whitespace, or...
	/*****/r`<(?:\\[<>]|[^<>])+>` + // In angle brackets
	/**/r`)` +

	// Title
	/**/r`\s*(?:"[^"]*"|'[^']*'|\([^\(\)]*\))?\s*` +
	r`\)`;

const wordPattern = '(?:' + linkPattern + ')|(?:' + markedKatexExtension.mathInlineRegExp.source + r`)|\p{sc=Han}|=+|\++|-+|[^\s\|\p{sc=Han}|=|\+|\-|${'`'}]+`;

function createWordRegExp(): RegExp {
	return new RegExp(wordPattern, 'gu');
}

export function getNWords(str: string, numWordsToCount: number): IWordCountResult {
	// This regex matches each word and skips over whitespace and separators. A word is:
	// A markdown link
	// Inline math
	// One chinese character
	// One or more + - =, handled so that code like "a=1+2-3" is broken up better
	// One or more characters that aren't whitepace or any of the above
	const wordRegExp = createWordRegExp();
	let totalWordCount = 0;
	let targetEndIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = wordRegExp.exec(str))) {
		totalWordCount++;
		if (totalWordCount <= numWordsToCount) {
			targetEndIndex = match.index + match[0].length;
		}
	}

	const returnedWordCount = Math.min(numWordsToCount, totalWordCount);
	const endIndex = numWordsToCount >= totalWordCount
		? str.length // Reached end of string
		: targetEndIndex;

	const value = str.substring(0, endIndex);
	return {
		value,
		returnedWordCount: returnedWordCount === 0 ? (value.length ? 1 : 0) : returnedWordCount,
		isFullString: endIndex >= str.length,
		totalWordCount
	};
}

/**
 * Append-optimized word index for the streaming renderer. The final match is
 * rescanned on each append because an incomplete markdown link or math span
 * can grow into a single word as more text arrives.
 */
export class IncrementalWordCounter {
	private _value = '';
	private readonly _wordStarts: number[] = [];
	private readonly _wordEnds: number[] = [];

	update(value: string, appendOnly = false, forceRescan = false): void {
		if (value === this._value && !forceRescan) {
			return;
		}

		let scanStart = 0;
		const isAppend = !forceRescan && (appendOnly
			? value.length >= this._value.length
			: value.startsWith(this._value));
		if (isAppend) {
			scanStart = this._wordStarts.at(-1) ?? this._value.length;
			scanStart = Math.min(scanStart, this._unfinishedConstructStart());
			while (this._wordStarts.length > 0 && this._wordStarts.at(-1)! >= scanStart) {
				this._wordStarts.pop();
				this._wordEnds.pop();
			}
		} else {
			this._wordStarts.length = 0;
			this._wordEnds.length = 0;
		}

		this._value = value;
		const wordRegExp = createWordRegExp();
		wordRegExp.lastIndex = scanStart;
		let match: RegExpExecArray | null;
		while ((match = wordRegExp.exec(value))) {
			this._wordStarts.push(match.index);
			this._wordEnds.push(match.index + match[0].length);
		}
	}

	private _unfinishedConstructStart(): number {
		const tailStart = Math.max(0, this._value.length - 8_192);
		const tail = this._value.slice(tailStart);
		let candidate = this._value.length;

		const openBracket = tail.lastIndexOf('[');
		if (openBracket >= 0 && (openBracket === 0 || tail[openBracket - 1] !== '\\')) {
			const closeBracket = tail.indexOf(']', openBracket + 1);
			if (closeBracket < 0 || (tail[closeBracket + 1] === '(' && tail.indexOf(')', closeBracket + 2) < 0)) {
				candidate = tailStart + openBracket;
			}
		}

		let unmatchedMath = -1;
		for (let index = 0; index < tail.length; index++) {
			if (tail[index] === '$' && (index === 0 || tail[index - 1] !== '\\')) {
				unmatchedMath = unmatchedMath < 0 ? index : -1;
			}
		}
		if (unmatchedMath >= 0) {
			candidate = Math.min(candidate, tailStart + unmatchedMath);
		}

		return candidate;
	}

	getNWords(numWordsToCount: number): IWordCountResult {
		const totalWordCount = this._wordEnds.length;
		const returnedWordCount = Math.min(numWordsToCount, totalWordCount);
		const endIndex = numWordsToCount >= totalWordCount
			? this._value.length
			: returnedWordCount > 0 ? this._wordEnds[returnedWordCount - 1] : 0;
		const value = this._value.substring(0, endIndex);
		return {
			value,
			returnedWordCount: returnedWordCount === 0 ? (value.length ? 1 : 0) : returnedWordCount,
			totalWordCount,
			isFullString: endIndex >= this._value.length,
		};
	}
}

export function countWords(str: string): number {
	const result = getNWords(str, Number.MAX_SAFE_INTEGER);
	return result.returnedWordCount;
}
