/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatIncrementalRendering.css';
import { getWindow } from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import { IIncrementalRenderingBuffer } from './buffers/buffer.js';
import { WordBuffer } from './buffers/wordBuffer.js';
import { BUFFER_MODES, BufferModeName } from './buffers/bufferRegistry.js';
import { IIncrementalRenderingAnimation } from './animations/animation.js';
import { ANIMATION_STYLES, AnimationStyleName } from './animations/animationRegistry.js';
import { ANIMATION_DURATION_MS } from './animations/blockAnimations.js';
import { StreamingTextReveal } from './animations/textReveal.js';

/**
 * Markdown at or beyond this length streams through the lightweight plaintext
 * presentation, which the word reveal does not decorate, so pacing falls back
 * to the word buffer's own rate. Matches the threshold in the markdown part.
 */
const TEXT_REVEAL_MAX_LENGTH = 15_000;

/**
 * Incremental markdown streaming renderer — rAF-batched, append-only.
 *
 * Orchestrates two independent concerns:
 * - **Buffering** (when to render): controlled by an {@link IIncrementalRenderingBuffer}.
 * - **Animation** (how it appears): controlled by an {@link IIncrementalRenderingAnimation}.
 *
 * The renderer works *with* the existing markdown rendering pipeline.
 * Each update re-renders through the standard `doRenderMarkdown()` path,
 * so code blocks, tables, KaTeX, and all markdown features render correctly.
 *
 * If the new markdown is NOT a pure append, `tryMorph()` returns `false`
 * and the caller falls back to a full re-render.
 */
export class IncrementalDOMMorpher extends Disposable {

	private _lastMarkdown: string = '';

	/**
	 * The markdown that was last rendered to the DOM. May lag behind
	 * `_lastMarkdown` while content is being buffered.
	 */
	private _renderedMarkdown: string = '';

	/**
	 * High-water mark: the number of top-level children that have been
	 * fully revealed. Children at indices >= this value are "new"
	 * and get animated on each render.
	 */
	private _revealedChildCount: number = 0;

	/**
	 * Timestamp when children at indices >= `_revealedChildCount`
	 * first appeared. 0 means no animation is in progress.
	 */
	private _animationStartTime: number = 0;

	/**
	 * The total child count at the end of the most recent render in
	 * the current animation batch.
	 */
	private _batchChildCount: number = 0;

	private _rafScheduled: boolean = false;
	private _pendingMarkdown: string | undefined;
	private _rafHandle: number | undefined;
	private _renderTimerHandle: number | undefined;
	private _renderCallback: ((newMarkdown: string) => void) | undefined;
	private _didFinalize = false;
	private _suppressNextAnimation = false;

	/** Word-level typing reveal; undefined when the animation style is `none`. */
	private _textReveal: StreamingTextReveal | undefined;

	private _buffer: IIncrementalRenderingBuffer;
	private _animation: IIncrementalRenderingAnimation;

	constructor(
		private readonly _domNode: HTMLElement,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
		this._buffer = this._createBuffer();
		this._animation = this._createAnimation();
		this._textReveal = this._createTextReveal();

		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.IncrementalRenderingStyle)) {
				this._animation = this._createAnimation();
				this._textReveal = this._createTextReveal();
				this._textReveal?.markAllRevealed();
			}
			if (e.affectsConfiguration(ChatConfiguration.IncrementalRenderingBuffering)) {
				this._buffer.dispose?.();
				this._buffer = this._createBuffer();
				this._buffer.seed?.(this._renderedMarkdown);
			}
		}));
	}

	// ---- strategy factories ----

	private _createBuffer(): IIncrementalRenderingBuffer {
		const raw = this._configService.getValue<string>(ChatConfiguration.IncrementalRenderingBuffering);
		const factory = Object.prototype.hasOwnProperty.call(BUFFER_MODES, raw)
			? BUFFER_MODES[raw as BufferModeName]
			: BUFFER_MODES.paragraph;
		return factory(this._domNode);
	}

	private _createAnimation(): IIncrementalRenderingAnimation {
		const raw = this._configService.getValue<string>(ChatConfiguration.IncrementalRenderingStyle);
		const factory = Object.prototype.hasOwnProperty.call(ANIMATION_STYLES, raw)
			? ANIMATION_STYLES[raw as AnimationStyleName]
			: ANIMATION_STYLES.fade;
		return factory();
	}

	private _createTextReveal(): StreamingTextReveal | undefined {
		const raw = this._configService.getValue<string>(ChatConfiguration.IncrementalRenderingStyle);
		return raw === 'words' ? new StreamingTextReveal(this._domNode) : undefined;
	}

	// ---- public API ----

	/**
	 * Register the callback that performs the actual markdown re-render.
	 */
	setRenderCallback(cb: (newMarkdown: string) => void): void {
		this._renderCallback = cb;
	}

	/**
	 * Forward the stream's word-rate estimate to the active buffer
	 * (word buffer or line buffer). When the stream completes,
	 * also flushes any remaining buffered content for buffers
	 * that don't handle their own flushing (e.g. ParagraphBuffer).
	 */
	updateStreamRate(rate: number, isComplete: boolean, forceFinalRender = false): void {
		if (this._buffer instanceof WordBuffer) {
			// While the word reveal paces the visible frontier, the buffer only
			// throttles DOM commits: holding text back here would starve the
			// reveal clock of the lead it needs to ride out network jitter.
			const revealPaces = !!this._textReveal && this._lastMarkdown.length < TEXT_REVEAL_MAX_LENGTH;
			this._buffer.setRate(revealPaces ? Number.MAX_SAFE_INTEGER : rate, isComplete);
		}

		// For buffers that don't handle their own flushing (e.g.
		// ParagraphBuffer), force-render any remaining buffered
		// content when the stream completes. Without this, content
		// after the last \n\n boundary is never rendered.
		if (isComplete && this._didFinalize) {
			return;
		}
		if (isComplete) {
			this._didFinalize = true;
		}

		if (isComplete && !this._buffer.handlesFlush && this._lastMarkdown.length > this._renderedMarkdown.length) {
			this._suppressNextAnimation = true;
			this._pendingMarkdown = this._lastMarkdown;
			this._scheduleRender(0, true);
		} else if (isComplete && this._buffer.handlesFlush && forceFinalRender) {
			// Word-buffered streams may already have committed the complete textual
			// prefix using the lightweight long-response presentation. Force one
			// completion render only for that transient view. Rich DOM that is already
			// caught up stays mounted, avoiding a redundant whole-answer rebuild.
			this._suppressNextAnimation = true;
			this._pendingMarkdown = this._lastMarkdown;
			this._scheduleRender(0, true);
		} else if (isComplete && this._buffer.handlesFlush && this._lastMarkdown.length > this._renderedMarkdown.length) {
			// The drip-feed is still behind the finished stream. Let the buffer
			// drain the tail at its accelerated completion rate instead of
			// dumping the remainder into the DOM in a single frame.
			this._pendingMarkdown = this._lastMarkdown;
			this._scheduleRender(0, true);
		}
	}

	/**
	 * Seeds the renderer with the initial markdown string.
	 *
	 * @param animateInitial When `true`, the children already in the
	 *   DOM receive the entrance animation.
	 */
	seed(markdown: string, animateInitial?: boolean): void {
		this._lastMarkdown = markdown;
		this._didFinalize = false;
		this._animationStartTime = 0;
		this._suppressNextAnimation = false;
		this._buffer.seed?.(markdown);

		this._renderedMarkdown = markdown;
		this._revealedChildCount = animateInitial ? 0 : this._domNode.children.length;
		if (animateInitial) {
			this._animateNewChildren();
		}
		this._textReveal?.markAllRevealed();
	}

	/**
	 * Attempts an incremental DOM update via rAF-batched re-render.
	 *
	 * @returns `true` if absorbed, `false` if a full re-render is needed.
	 */
	tryMorph(newMarkdown: string): boolean {
		if (!newMarkdown.startsWith(this._lastMarkdown)) {
			return false;
		}

		const appended = newMarkdown.slice(this._lastMarkdown.length);
		if (appended.length === 0) {
			return true;
		}

		this._lastMarkdown = newMarkdown;

		// Buffers that handle flushing themselves (e.g. line buffer)
		// don't update _renderedMarkdown here — _flushRender decides.
		if (this._buffer.handlesFlush) {
			this._pendingMarkdown = newMarkdown;
			this._scheduleRender();
			return true;
		}

		const renderable = this._buffer.getRenderable(newMarkdown, this._renderedMarkdown, appended);

		if (renderable.length > this._renderedMarkdown.length) {
			this._renderedMarkdown = renderable;
			this._pendingMarkdown = renderable;
			this._scheduleRender();
		}

		return true;
	}

	// ---- rAF batching ----

	private _scheduleRender(delay = 0, forceImmediate = false): void {
		if (this._rafScheduled) {
			return;
		}
		const win = getWindow(this._domNode);
		if (this._renderTimerHandle !== undefined) {
			if (!forceImmediate) {
				return;
			}
			win.clearTimeout(this._renderTimerHandle);
			this._renderTimerHandle = undefined;
		}
		const scheduleFrame = () => {
			this._renderTimerHandle = undefined;
			this._rafScheduled = true;
			this._rafHandle = win.requestAnimationFrame(() => {
				this._rafScheduled = false;
				this._rafHandle = undefined;
				this._flushRender();
			});
		};
		if (delay > 0) {
			this._renderTimerHandle = win.setTimeout(scheduleFrame, delay);
		} else {
			scheduleFrame();
		}
	}

	private _flushRender(): void {
		let markdown = this._pendingMarkdown;
		this._pendingMarkdown = undefined;

		if (markdown === undefined || !this._renderCallback) {
			return;
		}

		// Let the buffer filter the flush (e.g. line buffer may skip).
		if (this._buffer.filterFlush) {
			const filtered = this._buffer.filterFlush(markdown);
			if (filtered === undefined) {
				// Buffer says skip — but if it needs another frame
				// (e.g. typewriter still revealing words), re-schedule
				// with the same pending content.
				if (this._buffer.needsNextFrame) {
					this._pendingMarkdown = markdown;
					this._scheduleRender(this._buffer.nextRenderDelay ?? 0);
				}
				return;
			}
			markdown = filtered;
		}

		this._renderedMarkdown = markdown;
		this._renderCallback(markdown);
		if (this._suppressNextAnimation) {
			// Completion may replace the lightweight streaming node with rich
			// markdown. Treat the hydrated DOM as already visible so the whole
			// answer does not appear to replay from the beginning.
			this._suppressNextAnimation = false;
			this._revealedChildCount = this._domNode.children.length;
			this._animationStartTime = 0;
			this._batchChildCount = 0;
			this._textReveal?.markAllRevealed();
		} else {
			this._animateNewChildren();
			this._textReveal?.onDidRender();
		}

		// If the buffer has more content to reveal, keep the rAF
		// loop running even though no new tokens arrived.
		if (this._buffer.needsNextFrame) {
			this._pendingMarkdown = this._lastMarkdown;
			this._scheduleRender(this._buffer.nextRenderDelay ?? 0);
		}
	}

	// ---- animation ----

	private _animateNewChildren(): void {
		const children = this._domNode.children;
		const currentCount = children.length;

		if (currentCount <= this._revealedChildCount) {
			return;
		}

		const now = Date.now();

		if (this._animationStartTime !== 0 && (now - this._animationStartTime) >= ANIMATION_DURATION_MS) {
			this._revealedChildCount = this._batchChildCount;
			this._animationStartTime = 0;
			this._batchChildCount = 0;
		}

		if (currentCount <= this._revealedChildCount) {
			return;
		}

		if (this._animationStartTime === 0) {
			this._animationStartTime = now;
		}

		this._batchChildCount = currentCount;
		const elapsed = now - this._animationStartTime;

		this._animation.animate(children, this._revealedChildCount, currentCount, elapsed);
	}

	// ---- lifecycle ----

	override dispose(): void {
		if (this._rafHandle !== undefined) {
			getWindow(this._domNode).cancelAnimationFrame(this._rafHandle);
			this._rafHandle = undefined;
		}
		if (this._renderTimerHandle !== undefined) {
			getWindow(this._domNode).clearTimeout(this._renderTimerHandle);
			this._renderTimerHandle = undefined;
		}
		this._rafScheduled = false;
		this._pendingMarkdown = undefined;
		this._suppressNextAnimation = false;
		this._renderCallback = undefined;
		this._buffer.dispose?.();
		super.dispose();
	}
}
