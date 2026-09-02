import { appendFile, open } from "node:fs/promises";
import { appendLine } from "../../utils/fs.ts";

/**
 * Append-only JSONL writer with serialized, ordered writes. Callers enqueue
 * synchronously (from sync contexts like EventBus.emit) and the writer chains
 * the underlying async appends so on-disk order matches enqueue order. Call
 * `flush()` before exit to guarantee durability.
 */
export class JsonlWriter {
	private tail: Promise<void>;
	private failed = false;
	private firstError: unknown;

	constructor(private readonly filePath: string) {
		// Keep the serialization queue usable after an I/O error so later records
		// remain ordered and observable, while retaining the first failure as a
		// sticky durability error that every writeBatch()/flush() reports.
		this.tail = ensureAppendBoundary(filePath).catch((error) => {
			this.rememberFailure(error);
		});
	}

	write(record: object): void {
		void this.writeBatch([record]).catch(() => undefined);
	}

	/** Appends a JSONL group with one ordered filesystem append operation. */
	writeBatch(records: readonly object[]): Promise<void> {
		if (records.length === 0) return this.waitForDurability();
		const lines = records.map((record) => JSON.stringify(record)).join("\n");
		this.tail = this.tail.then(async () => {
			try {
				await appendLine(this.filePath, lines);
			} catch (error) {
				this.rememberFailure(error);
			}
		});
		return this.waitForDurability();
	}

	async flush(): Promise<void> {
		await this.waitForDurability();
	}

	private async waitForDurability(): Promise<void> {
		await this.tail;
		if (this.failed) throw this.firstError;
	}

	private rememberFailure(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.firstError = error;
	}
}

async function ensureAppendBoundary(filePath: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	}
	try {
		const size = (await handle.stat()).size;
		if (size === 0) return;
		const lastByte = Buffer.alloc(1);
		const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1);
		if (bytesRead === 1 && lastByte[0] !== 10) {
			await appendFile(filePath, "\n", "utf8");
		}
	} finally {
		await handle.close();
	}
}
