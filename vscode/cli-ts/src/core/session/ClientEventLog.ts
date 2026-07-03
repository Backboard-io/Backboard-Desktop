import type { EventBus } from "../bus/EventBus.ts";
import type { AgentEvent } from "../bus/events.ts";
import { JsonlWriter } from "./JsonlWriter.ts";

export interface ClientLogRecord {
	timestamp: string;
	session_id: string;
	sequence: number;
	source: "client";
	type: AgentEvent["type"];
	payload: AgentEvent;
}

/**
 * Subscribes to every bus event and appends a timestamped JSONL record. This is
 * the complete local-side trace of a run: UI events, user input, agent loop
 * state, scheduler decisions, tool lifecycle, cancellations, errors, usage, and
 * todos. Subscribe immediately after the bus is created so nothing is missed.
 */
export class ClientEventLog {
	private readonly writer: JsonlWriter;
	private sequence = 0;
	private unsubscribe: (() => void) | null = null;

	constructor(
		private readonly sessionId: string,
		filePath: string,
	) {
		this.writer = new JsonlWriter(filePath);
	}

	attach(bus: EventBus): void {
		if (this.unsubscribe) return;
		this.unsubscribe = bus.onAny((event) => this.record(event));
	}

	private record(event: AgentEvent): void {
		const record: ClientLogRecord = {
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			sequence: this.sequence++,
			source: "client",
			type: event.type,
			payload: event,
		};
		this.writer.write(record);
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	async flush(): Promise<void> {
		await this.writer.flush();
	}
}
