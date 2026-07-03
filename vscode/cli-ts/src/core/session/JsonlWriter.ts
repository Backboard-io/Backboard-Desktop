import { appendLine } from "../../utils/fs.ts";

/**
 * Append-only JSONL writer with serialized, ordered writes. Callers enqueue
 * synchronously (from sync contexts like EventBus.emit) and the writer chains
 * the underlying async appends so on-disk order matches enqueue order. Call
 * `flush()` before exit to guarantee durability.
 */
export class JsonlWriter {
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	write(record: object): void {
		const line = JSON.stringify(record);
		this.tail = this.tail.then(
			() => appendLine(this.filePath, line),
			() => appendLine(this.filePath, line),
		);
	}

	async flush(): Promise<void> {
		await this.tail;
	}
}
