import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import { assistantMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";

interface AssistantSegment {
	id: string;
	text: string;
	finalized: boolean;
	/**
	 * True when this segment might turn out to be a final answer that the
	 * final-verification nudge will immediately supersede. Buffered segments
	 * stream silently (no assistant:delta) so nothing is shown/printed until
	 * we know at finalize time whether to reveal or discard them.
	 */
	buffered: boolean;
	/**
	 * True when this segment belongs to a hidden exchange (e.g. the todo
	 * reconciliation reminder): it streams silently and is discarded at
	 * finalize even if tool calls follow, though still persisted to the
	 * session so the model keeps its own words in context.
	 */
	hidden: boolean;
}

export interface AssistantAccumulatorDeps {
	/**
	 * Called when a new segment starts. Returning true marks the segment
	 * "buffered": if it finalizes with tool calls pending (i.e. it was just
	 * commentary ahead of another tool round) it is still shown in full; if
	 * it finalizes as a true final answer (no tool calls), it is discarded
	 * instead of shown, because the verification nudge is about to replace it.
	 */
	suppressFinalMessage?: () => boolean;
	/**
	 * Called when a new segment starts. Returning true marks the segment
	 * "hidden": it is never shown, regardless of tool calls - the whole
	 * exchange is bookkeeping (e.g. a todo reconciliation reply).
	 */
	suppressAllMessages?: () => boolean;
	/** Maximum visible reasoning update rate. Defaults to 10 updates/second. */
	reasoningFlushIntervalMs?: number;
	/** Maximum visible answer update rate. Defaults to ~30 updates/second. */
	answerFlushIntervalMs?: number;
}

/**
 * Coalescing window for visible answer text, matching the window the sub-agent
 * relay uses for child streams. A provider that delivers tokens faster than
 * this would otherwise drive one Ink repaint per token, which reads as flicker
 * and dropped frames rather than as text being written.
 */
const ANSWER_FLUSH_INTERVAL_MS = 32;

/**
 * A backlog of pending answer text larger than one frame drains within
 * roughly this long. The reveal rate is backlog-proportional, so a fast
 * stream never falls arbitrarily far behind the provider: the deeper the
 * backlog, the faster it drains, bounding visible lag to about this window.
 */
const ANSWER_DRAIN_WINDOW_MS = 250;

/**
 * Backlogs at or below this size are revealed whole, at the provider's own
 * rhythm. Splitting a single short provider token into two events costs more
 * (an extra full repaint) than it buys in evenness.
 */
const ATOMIC_REVEAL_CHARS = 24;

/**
 * Backlogs up to this size are revealed whole, at the provider's own rhythm —
 * about one terminal line. Only deeper backlogs are paced out, at a steady
 * rate so frame sizes stay constant within a burst.
 */
const WHOLE_REVEAL_CHARS = 96;

export class AssistantAccumulator {
	private current: AssistantSegment | null = null;
	private nextIndex = 0;
	private pendingReasoning = "";
	private reasoningFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private lastReasoningFlushAt: number | undefined;
	/**
	 * Answer text waiting for the next visible update. Always belongs to
	 * `current`: every boundary that ends a segment flushes it first.
	 */
	private pendingAnswer = "";
	private answerFlushTimer: ReturnType<typeof setTimeout> | undefined;
	/** When answer text was last published; drives the pacing allowance. */
	private lastAnswerFlushAt: number | undefined;
	/**
	 * Largest backlog seen in the current burst. The reveal rate is derived
	 * from this rather than the shrinking remainder so the backlog drains
	 * linearly within ANSWER_DRAIN_WINDOW_MS instead of decaying exponentially.
	 */
	private answerBacklogPeak = 0;

	constructor(
		private readonly turnId: string,
		private readonly bus: EventBus,
		private readonly session: Session,
		private readonly deps: AssistantAccumulatorDeps = {},
	) {}

	appendDelta(text: string): void {
		// Keep the visible think -> answer ordering deterministic when reasoning
		// chunks were coalesced to protect the renderer from provider token floods.
		this.flushReasoning();
		const segment = this.ensureSegment();
		segment.text += text;
		if (segment.buffered || segment.hidden) return;
		const now = performance.now();
		const interval =
			this.deps.answerFlushIntervalMs ?? ANSWER_FLUSH_INTERVAL_MS;
		const quiet =
			this.pendingAnswer.length === 0 &&
			this.answerFlushTimer === undefined &&
			(this.lastAnswerFlushAt === undefined ||
				now - this.lastAnswerFlushAt >= interval);
		this.pendingAnswer += text;
		this.answerBacklogPeak = Math.max(
			this.answerBacklogPeak,
			this.pendingAnswer.length,
		);
		if (quiet) {
			// Reveal a first bite now so the time to first token is not padded by
			// the pacing window; any remainder drains across the next frames.
			this.flushAnswerWindow(now);
			return;
		}
		this.armAnswerFlushTimer();
	}

	/**
	 * Publishes all buffered answer text. Called at every boundary where the
	 * ordering of the transcript depends on it (reasoning, finalize, discard,
	 * tool rounds) — pacing never applies at a boundary.
	 */
	flushAnswer(): void {
		if (this.answerFlushTimer) {
			clearTimeout(this.answerFlushTimer);
			this.answerFlushTimer = undefined;
		}
		const text = this.pendingAnswer;
		if (!text) return;
		this.pendingAnswer = "";
		this.answerBacklogPeak = 0;
		this.lastAnswerFlushAt = performance.now();
		const segment = this.current;
		if (!segment) return;
		this.bus.emit({
			type: "assistant:delta",
			turnId: this.turnId,
			messageId: segment.id,
			text,
		});
	}

	private armAnswerFlushTimer(): void {
		if (this.answerFlushTimer) return;
		this.answerFlushTimer = setTimeout(
			() => this.flushAnswerWindow(),
			this.deps.answerFlushIntervalMs ?? ANSWER_FLUSH_INTERVAL_MS,
		);
		this.answerFlushTimer.unref?.();
	}

	/**
	 * Paced reveal: publishes as much buffered text as one smooth frame allows,
	 * then keeps the timer alive while a backlog remains. Small backlogs are
	 * revealed whole; the rate for deeper backlogs scales with their size, so a
	 * flood still drains within ANSWER_DRAIN_WINDOW_MS.
	 */
	private flushAnswerWindow(now: number = performance.now()): void {
		this.answerFlushTimer = undefined;
		const pending = this.pendingAnswer.length;
		if (pending === 0) {
			this.answerBacklogPeak = 0;
			return;
		}
		const elapsed =
			this.lastAnswerFlushAt === undefined
				? ANSWER_FLUSH_INTERVAL_MS
				: Math.max(1, now - this.lastAnswerFlushAt);
		this.lastAnswerFlushAt = now;
		if (pending <= WHOLE_REVEAL_CHARS) {
			// Within one frame's cap: the provider's own rhythm is already smooth,
			// so publish whole rather than slicing tokens into slivers.
			this.publishAnswer(this.pendingAnswer);
			this.pendingAnswer = "";
			this.answerBacklogPeak = 0;
			return;
		}
		// Reveal at a steady rate derived from the deepest backlog seen in this
		// burst, so frame sizes stay near-constant even though the provider
		// delivers tokens in bursts. Deeper backlogs drain proportionally
		// faster, bounding visible lag to ANSWER_DRAIN_WINDOW_MS; the ATOMIC
		// floor keeps a near-drained backlog from being shaved into
		// repaint-eating slivers.
		const rate = this.answerBacklogPeak / ANSWER_DRAIN_WINDOW_MS;
		const allowance = Math.min(
			pending,
			Math.max(ATOMIC_REVEAL_CHARS, Math.round(rate * elapsed)),
		);
		this.publishAnswer(this.pendingAnswer.slice(0, allowance));
		this.pendingAnswer = this.pendingAnswer.slice(allowance);
		if (this.pendingAnswer.length > 0) {
			this.armAnswerFlushTimer();
		} else {
			this.answerBacklogPeak = 0;
		}
	}

	private publishAnswer(text: string): void {
		if (!text) return;
		const segment = this.current;
		if (!segment) return;
		this.bus.emit({
			type: "assistant:delta",
			turnId: this.turnId,
			messageId: segment.id,
			text,
		});
	}

	/**
	 * Streams a provider reasoning-trace chunk. Reasoning is display-only: it
	 * is not part of any assistant segment (never persisted, never finalized),
	 * so it bypasses the segment buffering above.
	 */
	appendReasoning(text: string): void {
		if (!text) return;
		// Answer text that arrived before this chunk must stay visible before it,
		// so the coalesced answer is published ahead of the reasoning update.
		this.flushAnswer();
		const interval = Math.max(0, this.deps.reasoningFlushIntervalMs ?? 100);
		const now = performance.now();
		if (
			this.pendingReasoning.length === 0 &&
			(this.lastReasoningFlushAt === undefined ||
				now - this.lastReasoningFlushAt >= interval)
		) {
			this.emitReasoning(text, now);
			return;
		}

		this.pendingReasoning += text;
		if (this.reasoningFlushTimer) return;
		const elapsed =
			this.lastReasoningFlushAt === undefined
				? interval
				: now - this.lastReasoningFlushAt;
		this.reasoningFlushTimer = setTimeout(
			() => this.flushReasoning(),
			Math.max(0, interval - elapsed),
		);
	}

	/** Flushes buffered reasoning before a tool, answer, retry, or turn boundary. */
	flushReasoning(): void {
		if (this.reasoningFlushTimer) {
			clearTimeout(this.reasoningFlushTimer);
			this.reasoningFlushTimer = undefined;
		}
		if (!this.pendingReasoning) return;
		const text = this.pendingReasoning;
		this.pendingReasoning = "";
		this.emitReasoning(text, performance.now());
	}

	finalize(toolCalls: ToolCallRef[] = [], finalText?: string): void {
		this.flushAnswer();
		this.flushReasoning();
		if (!this.current && !finalText) return;
		const segment = this.ensureSegment();
		if (segment.finalized) return;
		const text = finalText ?? segment.text;
		segment.finalized = true;
		if (!text) {
			this.current = null;
			return;
		}

		segment.text = text;
		if (segment.hidden || (segment.buffered && toolCalls.length === 0)) {
			this.bus.emit({
				type: "assistant:message:discard",
				turnId: this.turnId,
				messageId: segment.id,
			});
		} else {
			this.bus.emit({
				type: "assistant:message",
				turnId: this.turnId,
				messageId: segment.id,
				text,
			});
		}
		this.session.addMessage(assistantMessage(text, toolCalls));
		this.current = null;
	}

	discardPartial(): void {
		this.flushReasoning();
		// The pending answer belongs to the segment being discarded, so drop it
		// rather than publishing text that is about to be withdrawn.
		if (this.answerFlushTimer) {
			clearTimeout(this.answerFlushTimer);
			this.answerFlushTimer = undefined;
		}
		this.pendingAnswer = "";
		this.answerBacklogPeak = 0;
		this.lastAnswerFlushAt = undefined;
		if (this.current?.finalized === false) {
			this.bus.emit({
				type: "assistant:message:discard",
				turnId: this.turnId,
				messageId: this.current.id,
			});
			this.current = null;
		}
	}

	private ensureSegment(): AssistantSegment {
		if (this.current) return this.current;
		const segment = {
			id: `${this.turnId}:assistant:${this.nextIndex}`,
			text: "",
			finalized: false,
			buffered: this.deps.suppressFinalMessage?.() ?? false,
			hidden: this.deps.suppressAllMessages?.() ?? false,
		};
		this.nextIndex++;
		this.current = segment;
		return segment;
	}

	private emitReasoning(text: string, now: number): void {
		this.lastReasoningFlushAt = now;
		this.bus.emit({
			type: "assistant:reasoning",
			turnId: this.turnId,
			text,
		});
	}
}
