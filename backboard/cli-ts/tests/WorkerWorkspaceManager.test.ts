import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	GitWorktreeManager,
	runGitCommand,
	workerBranchName,
} from "../src/core/workspaces/GitWorktreeManager.ts";
import {
	WorkerWorkspaceManager,
	workerWorktreePath,
} from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import { WorkerWorkspaceStore } from "../src/core/workspaces/WorkerWorkspaceStore.ts";
import type { WorkerWorkspaceRecord } from "../src/core/workspaces/WorkerWorkspaceTypes.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("WorkerWorkspaceManager", () => {
	it("uses readable, collision-safe Git branch and worktree names", async () => {
		const fixture = await createRepository();
		const slashBranch = workerBranchName("session", "worker/a");
		const spaceBranch = workerBranchName("session", "worker a");
		const plainBranch = workerBranchName("session", "worker-a");

		expect(plainBranch).toBe("agent/session/worker/worker-a");
		expect(slashBranch).not.toBe(spaceBranch);
		await git(fixture.repository, [
			"check-ref-format",
			`refs/heads/${slashBranch}`,
		]);
		await git(fixture.repository, [
			"check-ref-format",
			`refs/heads/${spaceBranch}`,
		]);
		expect(
			workerWorktreePath(fixture.repository, "session", "worker/a"),
		).not.toBe(workerWorktreePath(fixture.repository, "session", "worker a"));
	});

	it("runs isolated workers concurrently and integrates non-conflicting commits", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "parallel");
		await manager.initialize();
		let active = 0;
		let maxActive = 0;
		const cwdValues: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = (name: string, file: string) =>
			manager.runWorker(
				workerParams(name, fixture.repository),
				async (workspace) => {
					cwdValues.push(workspace.cwd);
					active++;
					maxActive = Math.max(maxActive, active);
					await gate;
					await writeFile(join(workspace.cwd, file), name, "utf8");
					active--;
					return { status: "completed" };
				},
			);

		const first = run("worker-a", "a.txt");
		const second = run("worker-b", "b.txt");
		await waitFor(() => active === 2);
		release();
		const outcomes = await Promise.all([first, second]);

		expect(maxActive).toBe(2);
		expect(new Set(cwdValues).size).toBe(2);
		expect(
			new Set(outcomes.map((outcome) => outcome.workspace.branch)).size,
		).toBe(2);
		expect(
			outcomes.map((outcome) => outcome.workspace.integrationStatus),
		).toEqual(["integrated", "integrated"]);
		expect(await readFile(join(fixture.repository, "a.txt"), "utf8")).toBe(
			"worker-a",
		);
		expect(await readFile(join(fixture.repository, "b.txt"), "utf8")).toBe(
			"worker-b",
		);
	});

	it("integrates captured results in completion order without waiting for an earlier worker", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "completion-order");
		await manager.initialize();
		const integrationOrder: string[] = [];
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const progress = (record: WorkerWorkspaceRecord) => {
			if (record.integrationStatus === "integrating") {
				integrationOrder.push(record.workerId);
			}
		};

		const first = manager.runWorker(
			{
				...workerParams("worker-a", fixture.repository, "completion-order"),
				onProgress: progress,
			},
			async (workspace) => {
				markFirstStarted();
				await firstGate;
				await writeFile(join(workspace.cwd, "a.txt"), "worker-a", "utf8");
				return { status: "completed" };
			},
		);
		await firstStarted;
		const second = manager.runWorker(
			{
				...workerParams("worker-b", fixture.repository, "completion-order"),
				onProgress: progress,
			},
			async (workspace) => {
				await writeFile(join(workspace.cwd, "b.txt"), "worker-b", "utf8");
				return { status: "completed" };
			},
		);

		let secondIntegratedBeforeRelease = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			secondIntegratedBeforeRelease = await Promise.race([
				second.then(() => true),
				new Promise<boolean>((resolve) => {
					timeout = setTimeout(() => resolve(false), 5_000);
				}),
			]);
			if (secondIntegratedBeforeRelease) {
				expect(await readFile(join(fixture.repository, "b.txt"), "utf8")).toBe(
					"worker-b",
				);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
			releaseFirst();
		}

		const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
		expect(secondIntegratedBeforeRelease).toBe(true);
		expect(firstOutcome.workspace.sequence).toBe(0);
		expect(secondOutcome.workspace.sequence).toBe(1);
		expect(integrationOrder).toEqual(["worker-b", "worker-a"]);
		expect(firstOutcome.workspace.integrationStatus).toBe("integrated");
		expect(secondOutcome.workspace.integrationStatus).toBe("integrated");
	}, 10_000);

	it("keeps a captured result completed and integration-eligible after cancellation", async () => {
		const fixture = await createRepository();
		let markCaptured!: () => void;
		const captured = new Promise<void>((resolve) => {
			markCaptured = resolve;
		});
		let releaseCapture!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const gitManager = new (class extends GitWorktreeManager {
			override async captureResultCommit(
				input: Parameters<GitWorktreeManager["captureResultCommit"]>[0],
			) {
				const result = await super.captureResultCommit(input);
				markCaptured();
				await captureGate;
				return result;
			}
		})();
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "cancel-after-capture",
			store: new WorkerWorkspaceStore(fixture.storePath),
			git: gitManager,
		});
		const controller = new AbortController();
		const operation = manager.runWorker(
			{
				...workerParams("worker-a", fixture.repository, "cancel-after-capture"),
				signal: controller.signal,
			},
			async (workspace) => {
				await writeFile(
					join(workspace.cwd, "captured.txt"),
					"durable result",
					"utf8",
				);
				return { status: "completed" };
			},
		);

		await captured;
		controller.abort();
		releaseCapture();
		const outcome = await operation;

		expect(controller.signal.aborted).toBe(true);
		expect(outcome.workspace.executionStatus).toBe("completed");
		expect(outcome.workspace.integrationStatus).toBe("integrated");
		expect(outcome.workspace.resultCommit).toBeDefined();
		expect(outcome.workspace.error).toBeUndefined();
		expect(
			await readFile(join(fixture.repository, "captured.txt"), "utf8"),
		).toBe("durable result");
	});

	it("captures staged, unstaged tracked, and untracked worker changes without a model commit", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "capture-all");
		await manager.initialize();
		const outcome = await manager.runWorker(
			workerParams("worker-a", fixture.repository, "capture-all"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "base.txt"), "modified\n", "utf8");
				await writeFile(join(workspace.cwd, "staged.txt"), "staged\n", "utf8");
				await git(workspace.cwd, ["add", "staged.txt"]);
				await writeFile(
					join(workspace.cwd, "untracked.txt"),
					"untracked\n",
					"utf8",
				);
				return { status: "completed" };
			},
		);

		expect(outcome.workspace.changedFiles).toEqual([
			"base.txt",
			"staged.txt",
			"untracked.txt",
		]);
		expect(outcome.workspace.resultCommit).not.toBe(
			outcome.workspace.startingCommit,
		);
		expect(
			await git(outcome.workspace.worktreePath ?? "", [
				"status",
				"--porcelain=v1",
			]),
		).toBe("");
		expect(await readFile(join(fixture.repository, "base.txt"), "utf8")).toBe(
			"modified\n",
		);
		expect(await readFile(join(fixture.repository, "staged.txt"), "utf8")).toBe(
			"staged\n",
		);
		expect(
			await readFile(join(fixture.repository, "untracked.txt"), "utf8"),
		).toBe("untracked\n");
	});

	it("enforces the configured concurrent worker limit", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "limited", 2);
		await manager.initialize();
		let active = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = (workerId: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "limited"),
				async () => {
					active++;
					await gate;
					active--;
					return { status: "completed" };
				},
			);

		const first = run("worker-a");
		const second = run("worker-b");
		await waitFor(() => active === 2);
		await expect(run("worker-c")).rejects.toThrow(
			"Parallel worker limit reached (2)",
		);
		release();
		await Promise.all([first, second]);
	});

	it("automatically initializes a non-Git folder before isolated writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "backboard-auto-git-test-"));
		roots.push(root);
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "existing.txt"), "baseline\n", "utf8");
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "auto-git",
			store: new WorkerWorkspaceStore(join(root, "state", "workers.json")),
		});
		const outcome = await manager.runWorker(
			workerParams("worker-a", project, "auto-git"),
			async (workspace) => {
				expect(workspace.cwd).not.toBe(project);
				expect(
					await readFile(join(workspace.cwd, "existing.txt"), "utf8"),
				).toBe("baseline\n");
				await writeFile(
					join(workspace.cwd, "worker.txt"),
					"isolated\n",
					"utf8",
				);
				return { status: "completed" };
			},
		);

		expect(outcome.workspace).toMatchObject({
			repositoryInitializedByBackboard: true,
			executionStatus: "completed",
			integrationStatus: "integrated",
		});
		expect(await git(project, ["status", "--porcelain=v1"])).toBe("");
		expect(await readFile(join(project, "worker.txt"), "utf8")).toBe(
			"isolated\n",
		);
		expect(await git(project, ["show", "HEAD~1:existing.txt"])).toBe(
			"baseline\n",
		);
	});

	it("initializes once while first-time non-Git workers execute concurrently", async () => {
		const root = await mkdtemp(join(tmpdir(), "backboard-auto-git-race-test-"));
		roots.push(root);
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "baseline.txt"), "baseline\n", "utf8");
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "auto-git-race",
			store: new WorkerWorkspaceStore(join(root, "state", "workers.json")),
		});
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launch = (workerId: string) =>
			manager.runWorker(
				workerParams(workerId, project, "auto-git-race"),
				async (workspace) => {
					active++;
					maxActive = Math.max(maxActive, active);
					await gate;
					await writeFile(
						join(workspace.cwd, `${workerId}.txt`),
						workerId,
						"utf8",
					);
					active--;
					return { status: "completed" };
				},
			);

		const first = launch("worker-a");
		const second = launch("worker-b");
		await waitFor(() => active === 2);
		release();
		const outcomes = await Promise.all([first, second]);

		expect(maxActive).toBe(2);
		expect(
			outcomes.filter(
				(outcome) => outcome.workspace.repositoryInitializedByBackboard,
			),
		).toHaveLength(1);
		expect(
			(await git(project, ["log", "--all", "--format=%s"]))
				.split("\n")
				.filter(
					(subject) => subject === "Initialize Backboard parallel workspace",
				),
		).toHaveLength(1);
		expect(await readFile(join(project, "worker-a.txt"), "utf8")).toBe(
			"worker-a",
		);
		expect(await readFile(join(project, "worker-b.txt"), "utf8")).toBe(
			"worker-b",
		);
	});

	it("still rejects non-Git writes when automatic initialization is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "backboard-non-git-test-"));
		roots.push(root);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "non-git",
			store: new WorkerWorkspaceStore(join(root, "state", "workers.json")),
			autoInitializeGit: false,
		});
		let ran = false;

		await expect(
			manager.runWorker(workerParams("worker-a", root, "non-git"), async () => {
				ran = true;
				return { status: "completed" };
			}),
		).rejects.toThrow("Git is required for isolated parallel writes");
		expect(ran).toBe(false);
	});

	it("keeps same-path edits isolated, preserves conflicts, and restores integrated history", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "acceptance");
		await manager.initialize();
		const windows = new Map<string, { start: number; finish: number }>();
		let active = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launch = (workerId: string, content: string) =>
			manager.runWorker(
				workerParams(workerId, fixture.repository, "acceptance"),
				async (workspace) => {
					const window = { start: Date.now(), finish: 0 };
					windows.set(workerId, window);
					active++;
					await gate;
					await writeFile(join(workspace.cwd, "result.txt"), content, "utf8");
					window.finish = Date.now();
					active--;
					return { status: "completed" };
				},
			);

		const first = launch("worker-a", "result from A\n");
		const second = launch("worker-b", "result from B\n");
		await waitFor(() => active === 2);
		release();
		const [a, b] = await Promise.all([first, second]);
		const windowA = windows.get("worker-a");
		const windowB = windows.get("worker-b");

		expect(
			windowA &&
				windowB &&
				windowA.start <= windowB.finish &&
				windowB.start <= windowA.finish,
		).toBe(true);
		expect(a.workspace.worktreePath).not.toBe(b.workspace.worktreePath);
		expect(a.workspace.branch).not.toBe(b.workspace.branch);
		expect(
			await readFile(
				join(a.workspace.worktreePath ?? "", "result.txt"),
				"utf8",
			),
		).toBe("result from A\n");
		expect(
			await readFile(
				join(b.workspace.worktreePath ?? "", "result.txt"),
				"utf8",
			),
		).toBe("result from B\n");
		const integrated = [a, b].filter(
			(outcome) => outcome.workspace.integrationStatus === "integrated",
		);
		const conflicted = [a, b].filter(
			(outcome) => outcome.workspace.integrationStatus === "conflict",
		);
		expect(integrated).toHaveLength(1);
		expect(conflicted).toHaveLength(1);
		expect(conflicted[0]?.workspace.conflictingFiles).toEqual(["result.txt"]);

		await git(fixture.repository, ["rm", "-f", "result.txt"]);
		await writeFile(
			join(fixture.repository, "worker-a-result.txt"),
			await readFile(
				join(a.workspace.worktreePath ?? "", "result.txt"),
				"utf8",
			),
		);
		await writeFile(
			join(fixture.repository, "worker-b-result.txt"),
			await readFile(
				join(b.workspace.worktreePath ?? "", "result.txt"),
				"utf8",
			),
		);
		await git(fixture.repository, ["add", "-A"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"Resolve worker result names",
		]);

		const restarted = createManager(fixture, "acceptance");
		await restarted.initialize();
		const restored = restarted.list();
		expect(
			restored.map((record) => ({
				workerId: record.workerId,
				status: record.integrationStatus,
				branch: record.branch,
				worktree: record.worktreePath,
			})),
		).toEqual([
			{
				workerId: "worker-a",
				status: "integrated",
				branch: "agent/acceptance/worker/worker-a",
				worktree: a.workspace.worktreePath,
			},
			{
				workerId: "worker-b",
				status: "integrated",
				branch: "agent/acceptance/worker/worker-b",
				worktree: b.workspace.worktreePath,
			},
		]);
		expect(
			await readFile(join(fixture.repository, "worker-a-result.txt"), "utf8"),
		).toBe("result from A\n");
		expect(
			await readFile(join(fixture.repository, "worker-b-result.txt"), "utf8"),
		).toBe("result from B\n");
	});

	it("does not integrate failed or cancelled workers and preserves their dirty worktrees", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "safety");
		await manager.initialize();
		const failed = await manager.runWorker(
			workerParams("failed", fixture.repository, "safety"),
			async (workspace) => {
				await writeFile(
					join(workspace.cwd, "failed.txt"),
					"preserve me",
					"utf8",
				);
				return { status: "failed" };
			},
		);
		const abort = new AbortController();
		let cancelledStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			cancelledStarted = resolve;
		});
		const cancelledPromise = manager.runWorker(
			{
				...workerParams("cancelled", fixture.repository, "safety"),
				signal: abort.signal,
			},
			async (workspace) => {
				cancelledStarted();
				await new Promise((resolve) => setTimeout(resolve, 20));
				await writeFile(join(workspace.cwd, "late.txt"), "late", "utf8");
				return { status: "completed" };
			},
		);
		await started;
		abort.abort();
		const cancelled = await cancelledPromise;

		expect(failed.workspace.integrationStatus).toBe("skipped");
		expect(failed.workspace.changedFiles).toEqual(["failed.txt"]);
		expect(cancelled.workspace.executionStatus).toBe("cancelled");
		expect(cancelled.workspace.integrationStatus).toBe("skipped");
		expect(cancelled.workspace.changedFiles).toEqual(["late.txt"]);
		await expect(
			readFile(join(fixture.repository, "failed.txt"), "utf8"),
		).rejects.toThrow();
		await expect(
			readFile(join(fixture.repository, "late.txt"), "utf8"),
		).rejects.toThrow();
		const preserved = await manager.archive();
		expect(preserved.sort()).toEqual(
			[failed.workspace.worktreePath, cancelled.workspace.worktreePath]
				.filter((path): path is string => path !== undefined)
				.sort(),
		);
	});

	it("eagerly removes clean failed and cancelled workers and never recreates them", async () => {
		const fixture = await createRepository();
		const parentSessionId = "clean-terminal";
		const manager = createManager(fixture, parentSessionId);
		await manager.initialize();

		const failed = await manager.runWorker(
			workerParams("failed", fixture.repository, parentSessionId),
			async () => ({ status: "failed" }),
		);
		const cancelled = await manager.runWorker(
			workerParams("cancelled", fixture.repository, parentSessionId),
			async () => ({ status: "cancelled" }),
		);

		for (const outcome of [failed, cancelled]) {
			expect(outcome.workspace.changedFiles).toEqual([]);
			expect(outcome.workspace.resultCommit).toBeUndefined();
			expect(outcome.workspace.worktreeDisposition).toBe(
				"removed_clean_terminal",
			);
			expect(outcome.workspace.worktreeCleanedAt).toBeDefined();
			expect(await pathExists(outcome.workspace.worktreePath ?? "")).toBe(
				false,
			);
		}
		expect(await manager.archive()).toEqual([]);
		expect(await manager.delete()).toEqual([]);

		const stored = await new WorkerWorkspaceStore(fixture.storePath).load();
		expect(stored.map((record) => record.worktreeDisposition)).toEqual([
			"removed_clean_terminal",
			"removed_clean_terminal",
		]);

		const restarted = createManager(fixture, parentSessionId);
		await restarted.initialize();
		await restarted.unarchive();
		for (const record of restarted.list()) {
			expect(record.worktreeDisposition).toBe("removed_clean_terminal");
			expect(await pathExists(record.worktreePath ?? "")).toBe(false);
		}
	});

	it("preserves a clean failed worker when its branch contains committed work", async () => {
		const fixture = await createRepository();
		const parentSessionId = "committed-terminal";
		const manager = createManager(fixture, parentSessionId);
		await manager.initialize();

		const outcome = await manager.runWorker(
			workerParams("committed", fixture.repository, parentSessionId),
			async (workspace) => {
				await writeFile(
					join(workspace.cwd, "committed.txt"),
					"recover me\n",
					"utf8",
				);
				await git(workspace.cwd, ["add", "committed.txt"]);
				await git(workspace.cwd, [
					"commit",
					"--no-gpg-sign",
					"-m",
					"worker recovery commit",
				]);
				return { status: "failed" };
			},
		);

		const committedWorktreePath = outcome.workspace.worktreePath;
		if (!committedWorktreePath)
			throw new Error("Expected worker worktree path");
		expect(outcome.workspace.changedFiles).toEqual([]);
		expect(outcome.workspace.resultCommit).toBeUndefined();
		expect(outcome.workspace.worktreeDisposition).toBe("present");
		expect(await pathExists(committedWorktreePath)).toBe(true);
		expect(
			(await git(committedWorktreePath, ["rev-parse", "HEAD"])).trim(),
		).not.toBe(outcome.workspace.startingCommit);
		expect(await manager.archive()).toEqual([committedWorktreePath]);
		expect(await manager.delete()).toEqual([committedWorktreePath]);
	});

	it("rolls back a staged merge when cancellation arrives during integration", async () => {
		const fixture = await createRepository();
		const headBefore = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "-b", "cancelled-worker"]);
		await writeFile(
			join(fixture.repository, "cancelled-integration.txt"),
			"worker result",
			"utf8",
		);
		await git(fixture.repository, ["add", "cancelled-integration.txt"]);
		await git(fixture.repository, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"cancelled result",
		]);
		const resultCommit = (
			await git(fixture.repository, ["rev-parse", "HEAD"])
		).trim();
		await git(fixture.repository, ["checkout", "main"]);
		const controller = new AbortController();
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			const result = await runGitCommand(cwd, args, {
				...options,
				// The test triggers cancellation after Git has staged the merge,
				// allowing the rollback path to run deterministically.
				signal: undefined,
			});
			if (args[0] === "merge" && args.includes("--no-commit")) {
				controller.abort();
			}
			return result;
		});

		await expect(
			manager.integrate({
				coordinatorCwd: fixture.repository,
				startingCommit: headBefore,
				resultCommit,
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled before commit");
		expect((await git(fixture.repository, ["rev-parse", "HEAD"])).trim()).toBe(
			headBefore,
		);
		expect(await manager.mergeInProgress(fixture.repository)).toBe(false);
		await expect(
			readFile(join(fixture.repository, "cancelled-integration.txt"), "utf8"),
		).rejects.toThrow();
		expect(await branchExists(fixture.repository, "cancelled-worker")).toBe(
			true,
		);
	});

	it("recovers partial creation from a preserved branch without inventing missing branches", async () => {
		const fixture = await createRepository();
		const store = new WorkerWorkspaceStore(fixture.storePath);
		const head = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
		const partialBranch = "agent/recovery/worker/partial";
		await git(fixture.repository, ["branch", partialBranch, head]);
		const partialPath = workerWorktreePath(
			fixture.repository,
			"recovery",
			"partial",
		);
		const missingPath = workerWorktreePath(
			fixture.repository,
			"recovery",
			"missing",
		);
		await store.replace([
			record({
				workerId: "partial",
				branch: partialBranch,
				worktreePath: partialPath,
				repositoryRoot: fixture.repository,
				coordinatorCwd: fixture.repository,
				startingCommit: head,
			}),
			record({
				workerId: "missing",
				sequence: 1,
				branch: "agent/recovery/worker/missing",
				worktreePath: missingPath,
				repositoryRoot: fixture.repository,
				coordinatorCwd: fixture.repository,
				startingCommit: head,
			}),
		]);

		const manager = new WorkerWorkspaceManager({
			parentSessionId: "recovery",
			store,
			git: new GitWorktreeManager(),
		});
		await manager.initialize();
		const restored = manager.list();

		expect(await git(partialPath, ["branch", "--show-current"])).toBe(
			`${partialBranch}\n`,
		);
		expect(restored[0]?.executionStatus).toBe("failed");
		expect(restored[1]?.error).toContain("branch is missing");
		expect(
			await branchExists(fixture.repository, "agent/recovery/worker/missing"),
		).toBe(false);
	});

	it("removes checkpoint refs before clean integrated worktrees and never targets the primary repository", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "cleanup");
		await manager.initialize();
		const outcome = await manager.runWorker(
			workerParams("clean-worker", fixture.repository, "cleanup"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "clean.txt"), "clean", "utf8");
				return { status: "completed" };
			},
		);
		const checkpointRef =
			"refs/agents/cleanup/workers/clean-worker/checkpoints/turn/0";
		await git(fixture.repository, [
			"update-ref",
			checkpointRef,
			outcome.workspace.resultCommit ?? "HEAD",
		]);
		expect(
			await git(outcome.workspace.worktreePath ?? "", [
				"status",
				"--porcelain=v1",
			]),
		).toBe("");

		const preserved = await manager.archive();
		expect(preserved).toEqual([]);
		expect(await pathExists(outcome.workspace.worktreePath ?? "")).toBe(false);
		await expect(
			git(fixture.repository, ["rev-parse", "--verify", checkpointRef]),
		).rejects.toThrow();
		await expect(
			new GitWorktreeManager().removeWorktreeIfClean({
				repositoryRoot: fixture.repository,
				coordinatorCwd: fixture.repository,
				worktreePath: fixture.repository,
			}),
		).rejects.toThrow("Refusing to remove");
	});

	it("recreates an archived clean worker from its preserved branch", async () => {
		const fixture = await createRepository();
		const manager = createManager(fixture, "unarchive");
		await manager.initialize();
		const outcome = await manager.runWorker(
			workerParams("worker-a", fixture.repository, "unarchive"),
			async (workspace) => {
				await writeFile(join(workspace.cwd, "worker.txt"), "result", "utf8");
				return { status: "completed" };
			},
		);
		const worktreePath = outcome.workspace.worktreePath ?? "";

		expect(await manager.archive()).toEqual([]);
		expect(await pathExists(worktreePath)).toBe(false);
		const restored = await manager.unarchive();
		expect(await pathExists(worktreePath)).toBe(true);
		expect(await git(worktreePath, ["branch", "--show-current"])).toBe(
			"agent/unarchive/worker/worker-a\n",
		);
		expect(restored[0]?.integrationStatus).toBe("integrated");
	});

	it("preserves unowned paths from tampered persisted metadata", async () => {
		const fixture = await createRepository();
		const head = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
		const branch = "agent/tampered/worker/worker-a";
		await git(fixture.repository, ["branch", branch, head]);
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId: "worker-a",
				parentSessionId: "tampered",
				coordinatorCwd: fixture.repository,
				repositoryRoot: fixture.repository,
				branch,
				worktreePath: fixture.repository,
				startingCommit: head,
				resultCommit: head,
				executionStatus: "completed",
				integrationStatus: "integrated",
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "tampered",
			store,
		});

		await manager.initialize();
		expect(manager.list()[0]?.error).toContain("preserved without touching");
		expect(await manager.delete()).toEqual([fixture.repository]);
		expect(
			await git(fixture.repository, ["rev-parse", "--is-inside-work-tree"]),
		).toBe("true\n");
	});

	it("preserves a dirty partially registered worker path during recovery and deletion", async () => {
		const fixture = await createRepository();
		const head = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
		const branch = "agent/dirty-recovery/worker/worker-a";
		const worktreePath = workerWorktreePath(
			fixture.repository,
			"dirty-recovery",
			"worker-a",
		);
		await git(fixture.repository, ["branch", branch, head]);
		await mkdir(worktreePath, { recursive: true });
		await writeFile(join(worktreePath, "preserved.txt"), "dirty", "utf8");
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await store.replace([
			record({
				workerId: "worker-a",
				parentSessionId: "dirty-recovery",
				coordinatorCwd: fixture.repository,
				repositoryRoot: fixture.repository,
				branch,
				worktreePath,
				startingCommit: head,
				resultCommit: head,
				executionStatus: "completed",
				integrationStatus: "integrated",
			}),
		]);
		const manager = new WorkerWorkspaceManager({
			parentSessionId: "dirty-recovery",
			store,
		});

		await manager.initialize();
		expect(manager.list()[0]?.error).toContain("preserved path");
		expect(await manager.delete()).toEqual([worktreePath]);
		expect(await readFile(join(worktreePath, "preserved.txt"), "utf8")).toBe(
			"dirty",
		);
	});

	it("serializes concurrent worker metadata writes", async () => {
		const fixture = await createRepository();
		const store = new WorkerWorkspaceStore(fixture.storePath);
		await Promise.all(
			Array.from({ length: 40 }, (_, index) =>
				store.upsert(record({ workerId: `worker-${index}`, sequence: index })),
			),
		);
		await store.flush();
		const raw = JSON.parse(await readFile(fixture.storePath, "utf8")) as {
			workers: WorkerWorkspaceRecord[];
		};
		expect(raw.workers).toHaveLength(40);
		expect(new Set(raw.workers.map((worker) => worker.workerId)).size).toBe(40);
	});
});

function workerParams(
	workerId: string,
	coordinatorCwd: string,
	parentSessionId = "parallel",
) {
	return {
		workerId,
		parentSessionId,
		parentToolCallId: workerId,
		taskPrompt: `Task for ${workerId}`,
		readOnly: false,
		coordinatorCwd,
		signal: new AbortController().signal,
	};
}

function record(
	overrides: Partial<WorkerWorkspaceRecord>,
): WorkerWorkspaceRecord {
	return {
		workerId: "worker",
		sequence: 0,
		parentSessionId: "recovery",
		taskPrompt: "recover",
		readOnly: false,
		coordinatorCwd: "",
		changedFiles: [],
		startedAt: new Date(0).toISOString(),
		executionStatus: "creating",
		integrationStatus: "pending",
		...overrides,
	};
}

function createManager(
	fixture: RepositoryFixture,
	parentSessionId: string,
	maxWorkers = 4,
): WorkerWorkspaceManager {
	return new WorkerWorkspaceManager({
		parentSessionId,
		store: new WorkerWorkspaceStore(fixture.storePath),
		git: new GitWorktreeManager(),
		maxWorkers,
	});
}

interface RepositoryFixture {
	root: string;
	repository: string;
	storePath: string;
}

async function createRepository(): Promise<RepositoryFixture> {
	const root = await mkdtemp(join(tmpdir(), "backboard-worker-test-"));
	roots.push(root);
	const repository = join(root, "repo");
	await git(root, ["init", "-b", "main", repository]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "base.txt"), "base\n", "utf8");
	await git(repository, ["add", "base.txt"]);
	await git(repository, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repository, storePath: join(root, "state", "workers.json") };
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return result.stdout;
}

async function branchExists(
	repository: string,
	branch: string,
): Promise<boolean> {
	try {
		await git(repository, [
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		]);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await readFile(join(path, ".git"), "utf8");
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for workers");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
