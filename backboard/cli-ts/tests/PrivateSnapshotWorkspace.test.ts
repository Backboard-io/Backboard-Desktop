import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
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
import { runGitCommand } from "../src/core/workspaces/GitWorktreeManager.ts";
import { PrivateSnapshotWorkspace } from "../src/core/workspaces/PrivateSnapshotWorkspace.ts";
import { WorkerWorkspaceManager } from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import { WorkerWorkspaceStore } from "../src/core/workspaces/WorkerWorkspaceStore.ts";

let root: string;
let cwd: string;
let checkpoints: CheckpointStore;
let manager: WorkerWorkspaceManager;
beforeEach(async () => {
	root = await realpath(
		await mkdtemp(join(tmpdir(), "private-worker-snapshot-")),
	);
	cwd = join(root, "project");
	await mkdir(cwd);
	checkpoints = new CheckpointStore(
		sessionPathsForRoot(join(root, "session")),
		new EventBus(),
	);
	manager = new WorkerWorkspaceManager({
		parentSessionId: "snapshot",
		store: new WorkerWorkspaceStore(join(root, "workers.json")),
		worktreeRoot: join(root, "worktrees"),
		snapshotMutation: createWorkerSnapshotMutation(checkpoints),
	});
});
afterEach(async () => {
	await manager.waitForIdle();
	await checkpoints.flush();
	checkpoints.dispose();
	await rm(root, { recursive: true, force: true });
});
function params(workerId: string) {
	return {
		workerId,
		parentSessionId: "snapshot",
		taskPrompt: "write files",
		readOnly: false,
		coordinatorCwd: cwd,
		signal: new AbortController().signal,
	};
}
async function git(args: string[]) {
	return (await runGitCommand(cwd, args)).stdout.trim();
}

describe("private snapshot workers", () => {
	it("captures a dirty repository with more than 10,000 files and integrates a small edit", async () => {
		await git(["init", "-b", "main"]);
		await git(["config", "user.name", "Test"]);
		await git(["config", "user.email", "test@example.com"]);
		for (let batch = 0; batch < 100; batch++) {
			await Promise.all(
				Array.from({ length: 100 }, (_, index) =>
					writeFile(join(cwd, `source-${batch * 100 + index}.txt`), "source"),
				),
			);
		}
		await git(["add", "."]);
		await git(["commit", "--no-gpg-sign", "-qm", "base"]);
		await writeFile(join(cwd, "untracked.txt"), "current");
		const head = await git(["rev-parse", "HEAD"]);
		const outcome = await manager.runWorker(
			params("large-repo"),
			async (workspace) => {
				const files = (
					await runGitCommand(workspace.cwd, ["ls-files", "-z"])
				).stdout
					.split("\0")
					.filter(Boolean);
				expect(files).toHaveLength(10_001);
				expect(
					await readFile(join(workspace.cwd, "untracked.txt"), "utf8"),
				).toBe("current");
				await writeFile(join(workspace.cwd, "source-9999.txt"), "changed");
				return { status: "completed" };
			},
		);
		expect(outcome.workspace.backend).toBe("snapshot");
		expect(outcome.workspace.integrationStatus).toBe("integrated");
		expect(await readFile(join(cwd, "source-9999.txt"), "utf8")).toBe(
			"changed",
		);
		expect(await git(["rev-parse", "HEAD"])).toBe(head);
	}, 60_000);

	it("captures exact coordinator presence and bytes for edits, empty creates, and deletes", async () => {
		const original = Buffer.from("\uFEFForiginal\r\n");
		await writeFile(join(cwd, "existing.txt"), original);
		await writeFile(join(cwd, "deleted.txt"), Buffer.alloc(0));
		const outcome = await manager.runWorker(
			params("exact-delta"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "existing.txt"), "changed\r\n");
				await writeFile(join(workspace.cwd, "created.txt"), Buffer.alloc(0));
				await rm(join(workspace.cwd, "deleted.txt"));
				return { status: "completed" };
			},
		);
		const changes = outcome.workspace.integrationChanges!;
		expect(outcome.workspace.integrationStatus).toBe("integrated");
		expect(changes).toHaveLength(3);
		const edited = changes.find(
			(entry) => entry.filePath === join(cwd, "existing.txt"),
		)!;
		const created = changes.find(
			(entry) => entry.filePath === join(cwd, "created.txt"),
		)!;
		const deleted = changes.find(
			(entry) => entry.filePath === join(cwd, "deleted.txt"),
		)!;
		expect(await readFile(edited.before!.contentPath)).toEqual(original);
		expect(await readFile(edited.after!.contentPath, "utf8")).toBe(
			"changed\r\n",
		);
		expect({
			createdBefore: created.before,
			createdSize: created.after?.byteLength,
			deletedBeforeSize: deleted.before?.byteLength,
			deletedAfter: deleted.after,
		}).toEqual({
			createdBefore: undefined,
			createdSize: 0,
			deletedBeforeSize: 0,
			deletedAfter: undefined,
		});
	});

	it("runs three independent writers in a plain folder and durably integrates without creating .git", async () => {
		let active = 0;
		let maxActive = 0;
		const outcomes = await Promise.all(
			[0, 1, 2].map((index) =>
				manager.runWorker(params(`worker-${index}`), async (workspace) => {
					active++;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(100);
					await writeFile(
						join(workspace.cwd, `result-${index}.txt`),
						`result ${index}`,
					);
					active--;
					return { status: "completed" };
				}),
			),
		);
		expect(maxActive).toBeGreaterThan(1);
		expect(
			outcomes.every(
				(outcome) => outcome.workspace.integrationStatus === "integrated",
			),
		).toBe(true);
		expect(
			await Promise.all(
				[0, 1, 2].map((index) =>
					readFile(join(cwd, `result-${index}.txt`), "utf8"),
				),
			),
		).toEqual(["result 0", "result 1", "result 2"]);
		await expect(access(join(cwd, ".git"))).rejects.toThrow();
		expect(checkpoints.listCheckpoints()).toHaveLength(3);
	});

	it("preserves dirty Git HEAD/index and binary bytes, then undo restores the original file", async () => {
		await git(["init", "-b", "main"]);
		await git(["config", "user.name", "Test"]);
		await git(["config", "user.email", "test@example.com"]);
		await writeFile(join(cwd, "data.bin"), Buffer.from([0, 255, 13, 10]));
		await git(["add", "data.bin"]);
		await git(["commit", "--no-gpg-sign", "-qm", "base"]);
		await writeFile(join(cwd, "data.bin"), Buffer.from([1, 254, 13, 10]));
		await git(["add", "data.bin"]);
		const indexBefore = await readFile(join(cwd, ".git", "index"));
		const head = await git(["rev-parse", "HEAD"]);
		const outcome = await manager.runWorker(
			params("binary"),
			async (workspace) => {
				expect(await readFile(join(workspace.cwd, "data.bin"))).toEqual(
					Buffer.from([1, 254, 13, 10]),
				);
				await writeFile(
					join(workspace.cwd, "data.bin"),
					Buffer.from([2, 253, 13, 10]),
				);
				return { status: "completed" };
			},
		);
		expect(outcome.workspace.integrationStatus).toBe("integrated");
		expect(await git(["rev-parse", "HEAD"])).toBe(head);
		expect(await readFile(join(cwd, ".git", "index"))).toEqual(indexBefore);
		expect(await readFile(join(cwd, "data.bin"))).toEqual(
			Buffer.from([2, 253, 13, 10]),
		);
		const target = checkpoints.undoTarget();
		expect(target).toBeDefined();
		await checkpoints.restore(await checkpoints.planRestore(target!), {
			skipDiverged: false,
		});
		expect(await readFile(join(cwd, "data.bin"))).toEqual(
			Buffer.from([1, 254, 13, 10]),
		);
	});

	it("preserves an external edit and leaves its conflicting worker result recoverable", async () => {
		await writeFile(join(cwd, "shared.txt"), "original");
		const outcome = await manager.runWorker(
			params("conflict"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "shared.txt"), "worker");
				await writeFile(join(cwd, "shared.txt"), "user");
				return { status: "completed" };
			},
		);
		expect(outcome.workspace.integrationStatus).toBe("conflict");
		expect(await readFile(join(cwd, "shared.txt"), "utf8")).toBe("user");
		expect(checkpoints.listCheckpoints()).toEqual([]);
		await access(outcome.workspace.worktreePath!);
	});

	it("honors ignore rules and excludes dependency folders while copying current source", async () => {
		await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
		await writeFile(join(cwd, "ignored.txt"), "ignored");
		await mkdir(join(cwd, "node_modules"));
		await writeFile(join(cwd, "node_modules", "dependency.js"), "dep");
		await writeFile(join(cwd, "source.ts"), "source");
		const result = await manager.runWorker(
			params("inventory"),
			async (workspace) => {
				await expect(
					access(join(workspace.cwd, "ignored.txt")),
				).rejects.toThrow();
				await expect(
					access(join(workspace.cwd, "node_modules")),
				).rejects.toThrow();
				expect(await readFile(join(workspace.cwd, "source.ts"), "utf8")).toBe(
					"source",
				);
				return { status: "completed" };
			},
		);
		expect(result.workspace.snapshotNotice).toContain("excluded");
	});

	it("rejects symlinks but snapshots oversized files before invoking a worker", async () => {
		await symlink(join(root, "outside"), join(cwd, "link"));
		await expect(
			manager.runWorker(params("symlink"), async () => {
				throw new Error("worker should not run");
			}),
		).rejects.toThrow("symbolic links");
		await rm(join(cwd, "link"));
		await writeFile(join(cwd, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
		let ran = false;
		await manager.runWorker(params("large"), async () => {
			ran = true;
			return { status: "completed" };
		});
		expect(ran).toBe(true);
		await expect(access(join(cwd, ".git"))).rejects.toThrow();
	});

	it("preserves executable mode and newline paths and rejects worker-created escaping symlinks", async () => {
		await writeFile(join(cwd, "run\nme"), "before");
		await chmod(join(cwd, "run\nme"), 0o755);
		const good = await manager.runWorker(
			params("executable"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "run\nme"), "after");
				return { status: "completed" };
			},
		);
		expect(good.workspace.integrationStatus).toBe("integrated");
		expect((await lstat(join(cwd, "run\nme"))).mode & 0o111).toBe(0o111);
		const bad = await manager.runWorker(
			params("new-link"),
			async (workspace) => {
				await symlink(join(root, "outside"), join(workspace.cwd, "escape"));
				return { status: "completed" };
			},
		);
		expect(bad.workspace.integrationStatus).toBe("pending");
		expect(bad.workspace.error).toContain("regular files only");
		await expect(access(join(cwd, "escape"))).rejects.toThrow();
	});

	it("retries a durable result idempotently after checkpoint finalization interruption", async () => {
		const interrupted = new WorkerWorkspaceManager({
			parentSessionId: "snapshot",
			store: new WorkerWorkspaceStore(join(root, "interrupted.json")),
			worktreeRoot: join(root, "worktrees"),
			snapshotMutation: async (record, paths, apply) => {
				await createWorkerSnapshotMutation(checkpoints)(record, paths, apply);
				throw new Error("lost completion acknowledgement");
			},
		});
		const result = await interrupted.runWorker(
			params("retry"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "result.txt"), "durable");
				return { status: "completed" };
			},
		);
		expect(result.workspace.integrationStatus).toBe("pending");
		expect(result.workspace.integrationChanges).toBeUndefined();
		expect(result.workspace.integrationPlan?.changes).toHaveLength(1);
		const backend = new PrivateSnapshotWorkspace(
			join(root, "worktrees"),
			createWorkerSnapshotMutation(checkpoints),
		);
		expect((await backend.integrate(result.workspace)).status).toBe(
			"integrated",
		);
		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("durable");
		await interrupted.waitForIdle();
		const recovered = new WorkerWorkspaceManager({
			parentSessionId: "snapshot",
			store: new WorkerWorkspaceStore(join(root, "interrupted.json")),
			worktreeRoot: join(root, "worktrees"),
			snapshotMutation: createWorkerSnapshotMutation(checkpoints),
		});
		await recovered.initialize();
		await recovered.waitForIdle();
		const record = recovered.list()[0]!;
		expect(record.integrationStatus).toBe("integrated");
		expect(record.integrationChanges?.[0]?.before).toBeUndefined();
		expect(
			await readFile(record.integrationChanges![0]!.after!.contentPath, "utf8"),
		).toBe("durable");
	});
});
