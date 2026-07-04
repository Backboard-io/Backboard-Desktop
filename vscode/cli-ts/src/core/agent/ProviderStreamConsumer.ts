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
					this.session.threadId = event.threadId;
					break;
				case "assistant_delta":
					if (event.text) assistant.appendDelta(event.text);
					break;
				case "reasoning_delta":
					if (event.text) assistant.appendReasoning(event.text);
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
