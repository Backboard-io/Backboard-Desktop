import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "../../providers/backboard/streamRetry.ts";
import type { ProviderEvent } from "../../providers/backboard/types.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { Session } from "../session/Session.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";

export interface PendingAction {
	runId: string | null;
	calls: ToolCallRef[];
}

class ProviderStreamFailure extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "ProviderStreamFailure";
	}
}

export class ProviderStreamConsumer {
	constructor(
		private readonly bus: EventBus,
		private readonly session: Session,
	) {}

	async consumeWithRetry(
		createStream: () => AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		signal: AbortSignal,
	): Promise<PendingAction | null> {
		const maxRetries = streamServerErrorRetries();
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.consume(createStream(), assistant);
			} catch (err) {
				if (err instanceof AbortError || signal.aborted) throw err;
				if (!isRetryableProviderStreamFailure(err) || attempt >= maxRetries) {
					throw err;
				}
				assistant.discardPartial();
				this.bus.emit({
					type: "system:warning",
					message: `Provider connection interrupted. Retrying (${attempt + 1}/${maxRetries})…`,
				});
				await waitForRetry(streamRetryDelayMs(attempt + 1), signal);
			}
		}
	}

	private async consume(
		stream: AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
	): Promise<PendingAction | null> {
		for await (const event of stream) {
			switch (event.kind) {
				case "thread":
					// Re-announce the session once the backend assigns the thread
					// so the host can persist it and resume the conversation in a
					// future serve process. The startup `session:created` fires
					// before any turn and carries `threadId: null`, so without
					// this the host never learns the real thread id. Guarded:
					// `thread` arrives on every stream frame.
					if (this.session.threadId !== event.threadId) {
						this.session.threadId = event.threadId;
						this.bus.emit({
							type: "session:created",
							sessionId: this.session.sessionId,
							threadId: event.threadId,
						});
					}
					break;
				case "status":
					// Pre-content pipeline phase — lets the host show a truthful
					// live status ("Preparing…"/"Working…") during the silent
					// send→first-token gap. Purely informational; never affects
					// the pending action or turn outcome.
					this.bus.emit({ type: "turn:status", phase: event.phase });
					break;
				case "assistant_delta":
					if (event.text) assistant.appendDelta(event.text);
					break;
				case "reasoning_delta":
					if (event.text) assistant.appendReasoning(event.text);
					break;
				case "voice":
					this.bus.emit({ type: "assistant:voice", records: event.records });
					break;
				case "usage":
					this.session.addUsage(event.usage);
					this.bus.emit({ type: "usage", usage: event.usage });
					break;
				case "requires_action": {
					const calls = event.calls.map((call) => ({
						id: call.id,
						name: call.name,
						input: call.input,
					}));
					assistant.finalize(calls);
					return { runId: event.runId, calls };
				}
				case "failed":
					throw new ProviderStreamFailure(
						event.error,
						event.retryable === true,
					);
				case "completed":
					assistant.finalize([], event.finalText);
					return null;
			}
		}
		assistant.finalize();
		return null;
	}
}

function isRetryableProviderStreamFailure(error: unknown): boolean {
	if (error instanceof ProviderStreamFailure) {
		return error.retryable || isRetryableStreamServerError(error);
	}
	return isRetryableStreamServerError(error);
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new AbortError());
			},
			{ once: true },
		);
	});
}
