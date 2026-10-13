import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GitWorktreeManager,
	runGitCommand,
} from "../src/core/workspaces/GitWorktreeManager.ts";
import { WorkerWorkspaceManager } from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import {
	WorkerWorkspaceStore,
	type WorkerWorkspaceStoreWriteOptions,
} from "../src/core/workspaces/WorkerWorkspaceStore.ts";
import {
	workerProgress,
	type WorkerWorkspaceRecord,
} from "../src/core/workspaces/WorkerWorkspaceTypes.ts";

const roots: string[] = [];
const managers: WorkerWorkspaceManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.waitForIdle()));
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "worker-lifecycle-")),
	);
	roots.push(root);
	return {
		root,
		storePath: join(root, "session", "workers.json"),
		cwd: join(root, "project"),
		worktreeRoot: join(root, "worktrees"),
	};
}
function record(): WorkerWorkspaceRecord {
	return {
		workerId: "worker",
		parentSessionId: "parent",
		sequence: 0,
		taskPrompt: "fixture",
		readOnly: false,
		coordinatorCwd: "/fixture",
		changedFiles: [],
		startedAt: "2026-09-05T00:00:00.000Z",
		executionStatus: "running",
		integrationStatus: "pending",
	};
}
async function git(cwd: string, args: string[]) {
	return (await runGitCommand(cwd, args)).stdout.trim();
}
async function repository() {
	const f = await fixture();
	await mkdir(f.cwd);
	await git(f.cwd, ["init", "-b", "main"]);
	await git(f.cwd, ["config", "user.name", "Fixture"]);
	await git(f.cwd, ["config", "user.email", "fixture@example.invalid"]);
	await writeFile(
		join(f.cwd, "shared.txt"),
		Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n",
	);
	await git(f.cwd, ["add", "shared.txt"]);
	await git(f.cwd, ["commit", "--no-gpg-sign", "-m", "fixture"]);
	return f;
}
function params(workerId: string, cwd: string) {
	return {
		workerId,
		parentSessionId: "parent",
		taskPrompt: "fixture",
		readOnly: false,
		coordinatorCwd: cwd,
		signal: new AbortController().signal,
	};
}

describe("worker workspace revisions and coordinator deltas", () => {
	it("loads legacy revision zero, persists monotonic boundaries, and refuses stale lifecycle overwrite", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "session"));
		await writeFile(
			f.storePath,
			JSON.stringify({ version: 1, workers: [record()] }),
		);
		const store = new WorkerWorkspaceStore(f.storePath);
		const loaded = (await store.load())[0]!;
		expect(loaded.revision).toBe(0);
		await store.upsert(loaded);
		const stale = structuredClone(loaded);
		loaded.executionStatus = "completed";
		await store.upsert(loaded);
		await expect(
			store.upsert({ ...stale, executionStatus: "running" }),
		).rejects.toThrow("Stale worker workspace revision");
		const restored = (await new WorkerWorkspaceStore(f.storePath).load())[0]!;
		expect(workerProgress(restored)).toMatchObject({
			revision: 2,
			executionStatus: "completed",
			integrationStatus: "pending",
			status: "Completed",
		});
		restored.integrationStatus = "integrated";
		await new WorkerWorkspaceStore(f.storePath).upsert(restored);
		expect(restored.revision).toBe(3);
	});

	it("persists exact empty-file presence and mode changes while coalescing identical blob writes", async () => {
		const f = await fixture();
		const store = new WorkerWorkspaceStore(f.storePath);
		const content = Buffer.from("é\r\n");
		const captures = await Promise.all(
			Array.from({ length: 4 }, () =>
				store.captureIntegrationChanges([
					{
						filePath: join(f.cwd, "empty"),
						after: { content: Buffer.alloc(0), mode: 0o100644 },
					},
					{
						filePath: join(f.cwd, "mode"),
						before: { content, mode: 0o100644 },
						after: { content, mode: 0o100755 },
					},
				]),
			),
		);
		expect(
			captures.every(
				(capture) => JSON.stringify(capture) === JSON.stringify(captures[0]),
			),
		).toBe(true);
		const [created, mode] = captures[0]!;
		expect(created?.before).toBeUndefined();
		expect(created?.after?.byteLength).toBe(0);
		expect(mode?.before?.contentPath).toBe(mode?.after?.contentPath);
		expect(await readFile(mode!.after!.contentPath)).toEqual(content);
		expect([mode?.before?.mode, mode?.after?.mode]).toEqual([
			0o100644, 0o100755,
		]);
	});

	it("records actual same-file coordinator merge content including an earlier peer's edit", async () => {
		const f = await repository();
		await git(f.cwd, ["config", "core.autocrlf", "true"]);
		await git(f.cwd, ["checkout-index", "--force", "--all"]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "parent",
			store: new WorkerWorkspaceStore(f.storePath),
			worktreeRoot: f.worktreeRoot,
		});
		managers.push(manager);
		let startSecond!: () => void;
		const secondStarted = new Promise<void>((resolve) => {
			startSecond = resolve;
		});
		let finishFirst!: () => void;
		const firstIntegrated = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const revisions: number[] = [];
		const first = manager.runWorker(
			{
				...params("first", f.cwd),
				onProgress: (progress) => {
					if (progress.integrationStatus === "integrated") finishFirst();
				},
			},
			async (workspace) => {
				await secondStarted;
				const path = join(workspace.cwd, "shared.txt");
				await writeFile(
					path,
					(await readFile(path, "utf8")).replace("line 0", "first peer"),
				);
				return { status: "completed" };
			},
		);
		const second = manager.runWorker(
			{
				...params("second", f.cwd),
				onProgress: (progress) => {
					revisions.push(progress.revision!);
				},
			},
			async (workspace) => {
				startSecond();
				await firstIntegrated;
				const path = join(workspace.cwd, "shared.txt");
				await writeFile(
					path,
					(await readFile(path, "utf8")).replace("line 19", "second peer"),
				);
				return { status: "completed" };
			},
		);
		const outcomes = await Promise.all([first, second]);
		await manager.waitForIdle();
		expect(
			outcomes.map((outcome) => outcome.workspace.integrationStatus),
		).toEqual(["integrated", "integrated"]);
		const change = outcomes[1]!.workspace.integrationChanges![0]!;
		const before = await readFile(change.before!.contentPath, "utf8");
		const after = await readFile(change.after!.contentPath, "utf8");
		expect({
			filePath: change.filePath,
			beforeHasFirst: before.includes("first peer"),
			beforeHasSecond: before.includes("second peer"),
			afterHasFirst: after.includes("first peer"),
			afterHasSecond: after.includes("second peer"),
		}).toEqual({
			filePath: join(f.cwd, "shared.txt"),
			beforeHasFirst: true,
			beforeHasSecond: false,
			afterHasFirst: true,
			afterHasSecond: true,
		});
		expect(after).toBe(await readFile(join(f.cwd, "shared.txt"), "utf8"));
		expect(before).toContain("\r\n");
		expect(after).toContain("\r\n");
		expect(
			revisions.every(
				(revision, index) => index === 0 || revision > revisions[index - 1]!,
			),
		).toBe(true);
		const restored = (await new WorkerWorkspaceStore(f.storePath).load()).find(
			(worker) => worker.workerId === "second",
		)!;
		expect(restored.integrationChanges).toEqual(
			outcomes[1]!.workspace.integrationChanges,
		);
	});

	it("recovers exact prepared integration snapshots after commit acknowledgement loss and a newer user commit", async () => {
		const f = await repository();
		const store = new (class extends WorkerWorkspaceStore {
			override async upsertMany(
				records: readonly WorkerWorkspaceRecord[],
				options?: WorkerWorkspaceStoreWriteOptions,
			) {
				if (records.some((entry) => entry.integrationStatus === "integrated"))
					throw new Error("lost completion acknowledgement");
				return super.upsertMany(records, options);
			}
		})(f.storePath);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "parent",
			store,
			worktreeRoot: f.worktreeRoot,
		});
		managers.push(manager);
		await expect(
			manager.runWorker(params("recover", f.cwd), async (workspace) => {
				await writeFile(join(workspace.cwd, "added.txt"), "worker bytes\n");
				return { status: "completed" };
			}),
		).rejects.toThrow("lost completion acknowledgement");
		const committed = await git(f.cwd, ["rev-parse", "HEAD"]);
		const saved = (await new WorkerWorkspaceStore(f.storePath).load())[0]!;
		expect(saved.integrationStatus).toBe("integrating");
		expect(saved.integrationChanges).toBeUndefined();
		expect(saved.integrationPlan?.changes).toHaveLength(1);
		await writeFile(join(f.cwd, "user.txt"), "later user edit");
		await git(f.cwd, ["add", "user.txt"]);
		await git(f.cwd, ["commit", "--no-gpg-sign", "-m", "later user edit"]);
		const recovered = new WorkerWorkspaceManager({
			parentSessionId: "parent",
			store: new WorkerWorkspaceStore(f.storePath),
			git: new GitWorktreeManager(),
			worktreeRoot: f.worktreeRoot,
		});
		managers.push(recovered);
		await recovered.initialize();
		await recovered.waitForIdle();
		const actual = recovered.list()[0]!;
		expect({
			status: actual.integrationStatus,
			commit: actual.integrationCommit,
			count: actual.integrationChanges?.length,
			before: actual.integrationChanges?.[0]?.before,
		}).toEqual({
			status: "integrated",
			commit: committed,
			count: 1,
			before: undefined,
		});
		expect(
			await readFile(actual.integrationChanges![0]!.after!.contentPath, "utf8"),
		).toBe("worker bytes\n");
		expect(actual.revision!).toBeGreaterThan(saved.revision!);
	});
});
