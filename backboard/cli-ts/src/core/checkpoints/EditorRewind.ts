import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	renameOverPreservingDestination,
	isErrnoException,
} from "../../utils/fs.ts";
import type { CheckpointManager } from "./CheckpointManager.ts";
import type { RestorePlan } from "./journalTypes.ts";

/** Unsaved editor text is backed up separately from the bytes on disk. */
export interface RewindBuffer {
	path: string;
	content: string;
	encoding?: string;
}

export interface EditorRewindTransaction {
	id: string;
	revision: number;
	status: "prepared" | "applying" | "committed" | "recovering" | "recovered";
	plan: RestorePlan;
	backupId?: string;
	baseCheckpointId?: string;
	headBackupId?: string;
	buffers: RewindBuffer[];
}

interface EditorRewindState {
	version: 1;
	revision: number;
	transactions: Record<string, EditorRewindTransaction>;
}

/** Durable, all-or-recover wrapper around the CLI's per-file checkpoint engine. */
export class EditorRewind {
	private state: EditorRewindState = {
		version: 1,
		revision: 0,
		transactions: {},
	};
	private readonly file: string;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly checkpoints: CheckpointManager) {
		this.file = join(checkpoints.paths.checkpoints, "editor-rewinds.json");
	}

	async initialize(): Promise<void> {
		try {
			this.state = JSON.parse(
				await readFile(this.file, "utf8"),
			) as EditorRewindState;
			if (this.state.version !== 1 || !this.state.transactions)
				throw new Error("Unsupported Editor rewind journal");
		} catch (error) {
			if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
		}
		for (const tx of Object.values(this.state.transactions)) {
			if (tx.status === "applying" || tx.status === "recovering")
				await this.recoverTransaction(tx);
		}
	}

	/** Serialize even control operations arriving concurrently on stdin. */
	private run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	prepare(
		id: string,
		turnIds: readonly string[],
		baseCheckpointId?: string,
	): Promise<EditorRewindTransaction> {
		return this.run(async () => {
			if (this.state.transactions[id]) return this.state.transactions[id];
			this.assertReady();
			const target = await this.checkpoints.planRestoreTurns(turnIds);
			if (baseCheckpointId) {
				const base = await this.checkpoints.planRestore(baseCheckpointId);
				const entries = new Map(
					base.entries.map((entry) => [entry.path, entry]),
				);
				for (const entry of target.entries) entries.set(entry.path, entry);
				target.entries = [...entries.values()];
			}
			await this.checkpoints.validateRestorePlan(target);
			const tx: EditorRewindTransaction = {
				id,
				revision: this.state.revision,
				status: "prepared",
				plan: target,
				baseCheckpointId,
				buffers: [],
			};
			this.state.transactions[id] = tx;
			await this.persist();
			return tx;
		});
	}

	commit(
		id: string,
		buffers: RewindBuffer[],
	): Promise<EditorRewindTransaction> {
		return this.run(async () => {
			const tx = this.get(id);
			if (tx.status === "committed") return tx;
			if (tx.status !== "prepared" || tx.revision !== this.state.revision)
				throw new Error("Rewind changed; prepare it again");
			this.assertReady();
			const paths = new Set(tx.plan.entries.map((entry) => entry.path));
			if (buffers.some((buffer) => !paths.has(buffer.path)))
				throw new Error("Buffer is outside the rewind plan");
			await this.checkpoints.validateRestorePlan(tx.plan);
			tx.backupId = await this.checkpoints.captureRestoreBackup(tx.plan);
			tx.headBackupId = tx.baseCheckpointId
				? await this.checkpoints.mergeRestoreBackups(
						tx.baseCheckpointId,
						tx.backupId,
					)
				: tx.backupId;
			tx.buffers = buffers;
			const backupDirectory = join(
				this.checkpoints.paths.checkpoints,
				"editor-rewind-backups",
				tx.id,
			);
			await this.checkpoints.exportRestoreBackup(
				tx.backupId,
				join(backupDirectory, "disk"),
			);
			await mkdir(join(backupDirectory, "buffers"), {
				recursive: true,
				mode: 0o700,
			});
			for (const [index, buffer] of buffers.entries()) {
				await writeFile(
					join(backupDirectory, "buffers", `${index}-${basename(buffer.path)}`),
					buffer.content,
					{ mode: 0o600 },
				);
			}
			await writeFile(
				join(backupDirectory, "buffers", "manifest.json"),
				JSON.stringify(
					buffers.map((buffer, index) => ({
						path: buffer.path,
						encoding: buffer.encoding,
						file: `${index}-${basename(buffer.path)}`,
						storedEncoding: "utf8",
					})),
					null,
					2,
				),
				{ mode: 0o600 },
			);
			tx.status = "applying";
			await this.persist();
			try {
				const result = await this.checkpoints.restore(tx.plan, {
					skipDiverged: false,
				});
				if (result.skipped.length)
					throw new Error(
						result.skipped
							.map((entry) => `${entry.path}: ${entry.reason}`)
							.join("\n"),
					);
				tx.status = "committed";
				this.state.revision++;
				await this.persist();
				return tx;
			} catch (error) {
				await this.recoverTransaction(tx);
				throw error;
			}
		});
	}

	recover(id: string): Promise<EditorRewindTransaction> {
		return this.run(async () => {
			const tx = this.get(id);
			if (tx.status !== "recovered") await this.recoverTransaction(tx);
			return tx;
		});
	}

	/** A failed rollback must prevent new model/tool work from hiding the problem. */
	assertReady(): void {
		if (
			Object.values(this.state.transactions).some(
				(tx) => tx.status === "applying" || tx.status === "recovering",
			)
		) {
			throw new Error(
				"File recovery is required before continuing this conversation",
			);
		}
	}

	private get(id: string): EditorRewindTransaction {
		const tx = this.state.transactions[id];
		if (!tx) throw new Error("Unknown rewind transaction");
		return tx;
	}

	private async recoverTransaction(tx: EditorRewindTransaction): Promise<void> {
		tx.status = "recovering";
		await this.persist();
		if (tx.backupId) {
			const plan = await this.checkpoints.planRestore(tx.backupId);
			const result = await this.checkpoints.restore(plan, {
				skipDiverged: false,
			});
			if (result.skipped.length)
				throw new Error(
					`File recovery required: ${result.skipped.map((entry) => `${entry.path}: ${entry.reason}`).join("; ")}`,
				);
		}
		tx.status = "recovered";
		this.state.revision++;
		await this.persist();
	}

	private async persist(): Promise<void> {
		await mkdir(this.checkpoints.paths.checkpoints, {
			recursive: true,
			mode: 0o700,
		});
		const temp = `${this.file}.tmp`;
		await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
		await renameOverPreservingDestination(temp, this.file);
	}
}
