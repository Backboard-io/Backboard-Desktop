import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathsInsideCwd } from "../permissions/pathsInside.ts";
import type { WorkerWorkspaceRecord } from "../workspaces/WorkerWorkspaceTypes.ts";
import {
	recordPostImageBatch,
	recordPreImageBatch,
	type CheckpointRecorder,
} from "./CheckpointStore.ts";

/** The backend holds path locks and validates the immutable delta before calling. */
export function createWorkerSnapshotMutation(checkpoints: CheckpointRecorder) {
	return async (
		record: WorkerWorkspaceRecord,
		paths: readonly string[],
		apply: () => Promise<void>,
	): Promise<void> => {
		if (!checkpoints.finishCapture)
			throw new Error(
				"Snapshot integration requires a finalizable checkpoint recorder.",
			);
		const root = resolve(record.coordinatorCwd);
		if (
			paths.some((path) => !isAbsolute(path) || resolve(path) === root) ||
			!pathsInsideCwd([...paths], root)
		) {
			throw new Error(
				"Snapshot integration cannot write outside its coordinator workspace.",
			);
		}
		const ctx = {
			turnId: `worker-integration:${record.workerId}`,
			toolCallId: record.workerId,
		};
		const requests = await Promise.all(
			paths.map(async (absPath) => ({
				absPath,
				opts: {
					tool: "Agent",
					requireRevertible: true,
					createdDirs: await missingDirectories(dirname(absPath), root),
				},
			})),
		);
		await recordPreImageBatch(checkpoints, requests, ctx);
		// On failure, preserve partial work and its durable backend journal. Blind
		// rollback could overwrite a newer external edit. Recovery retries the same
		// immutable result only where bytes still match the baseline or that result.
		await apply();
		await recordPostImageBatch(
			checkpoints,
			paths.map((absPath) => ({ absPath })),
			ctx,
		);
		await checkpoints.finishCapture(ctx.turnId);
	};
}

async function missingDirectories(
	path: string,
	root: string,
): Promise<string[]> {
	const missing: string[] = [];
	for (
		let current = path;
		current !== root && current !== dirname(current);
		current = dirname(current)
	) {
		try {
			const stats = await lstat(current);
			if (!stats.isDirectory())
				throw new Error(`Snapshot parent is not a directory: ${current}`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missing.push(current);
		}
	}
	return missing;
}
