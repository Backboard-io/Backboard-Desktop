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
}

export class AssistantAccumulator {
	private current: AssistantSegment | null = null;
	private nextIndex = 0;
	private pendingReasoning = "";
	private reasoningFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private lastReasoningFlushAt: number | undefined;

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
		if (this.current?.finalized === false) {
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
