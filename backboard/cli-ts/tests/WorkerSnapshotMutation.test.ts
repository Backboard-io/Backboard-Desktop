import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CheckpointStore } from "../src/core/checkpoints/CheckpointStore.ts";
import { createWorkerSnapshotMutation } from "../src/core/checkpoints/WorkerSnapshotMutation.ts";
import { sessionPathsForRoot } from "../src/core/session/SessionStore.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";

let root: string;
let cwd: string;
let store: CheckpointStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "worker-snapshot-undo-"));
	cwd = join(root, "workspace");
	await mkdir(cwd);
	store = new CheckpointStore(
		sessionPathsForRoot(join(root, "session")),
		new EventBus(),
	);
});
afterEach(async () => {
	await store.flush();
	store.dispose();
	await rm(root, { recursive: true, force: true });
});
function worker(): WorkerWorkspaceRecord {
	return {
		workerId: "worker-1",
		sequence: 0,
		parentSessionId: "session",
		taskPrompt: "write fixture",
		readOnly: false,
		coordinatorCwd: cwd,
		changedFiles: [],
		startedAt: new Date().toISOString(),
		executionStatus: "completed",
		integrationStatus: "pending",
	};
}
async function undo() {
	const target = store.undoTarget();
	if (!target) throw new Error("Missing worker undo checkpoint");
	await store.restore(await store.planRestore(target), { skipDiverged: false });
}

describe("worker snapshot checkpoint transaction", () => {
	it("finalizes a background worker independently and restores original bytes and created directories", async () => {
		const first = join(cwd, "original.bin");
		const second = join(cwd, "nested", "new.txt");
		const original = Buffer.from([0, 255, 13, 10]);
		await writeFile(first, original);
		await createWorkerSnapshotMutation(store)(
			worker(),
			[first, second],
			async () => {
				await writeFile(first, "replacement");
				await mkdir(join(cwd, "nested"));
				await writeFile(second, "new");
			},
		);
		expect(store.listCheckpoints().map((checkpoint) => checkpoint.id)).toEqual([
			"worker-integration:worker-1",
		]);
		await undo();
		expect(await readFile(first)).toEqual(original);
		await expect(access(join(cwd, "nested"))).rejects.toThrow();
	});

	it("keeps original preimages when a journaled partial application is recovered after restart", async () => {
		const first = join(cwd, "a");
		const second = join(cwd, "b");
		await writeFile(first, "original a");
		await writeFile(second, "original b");
		const apply = createWorkerSnapshotMutation(store);
		await expect(
			apply(worker(), [first, second], async () => {
				await writeFile(first, "worker a");
				throw new Error("interrupted application");
			}),
		).rejects.toThrow("interrupted application");
		expect(store.listCheckpoints()).toEqual([]);
		await store.flush();
		store.dispose();
		store = new CheckpointStore(
			sessionPathsForRoot(join(root, "session")),
			new EventBus(),
		);
		await createWorkerSnapshotMutation(store)(
			worker(),
			[first, second],
			async () => {
				await writeFile(second, "worker b");
			},
		);
		await undo();
		expect(
			await Promise.all([first, second].map((path) => readFile(path, "utf8"))),
		).toEqual(["original a", "original b"]);
	});

	it("refuses coordinator escape including symlink aliases before any write", async () => {
		const outside = join(root, "outside");
		await mkdir(outside);
		await symlink(outside, join(cwd, "link"));
		let applied = false;
		for (const path of [join(outside, "x"), join(cwd, "link", "x"), cwd]) {
			await expect(
				createWorkerSnapshotMutation(store)(worker(), [path], async () => {
					applied = true;
				}),
			).rejects.toThrow("outside");
		}
		expect(applied).toBe(false);
	});
});
